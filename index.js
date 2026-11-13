/**
 * dsh-token-attribution Host entry (M1a).
 *
 * Registers, as effects on the plugin fiber:
 * 1. the `system-prompt/assemble` observer (named-section snapshots in memory),
 * 2. the `llm/stream` collector (usage capture + attribution + ledger append),
 * 3. the `tools/result` web API observer (web_search/web_fetch call counters),
 * 4. the optional Connection RPC channel (only when `connection` is provided),
 * 5. the store's flush timer and a final flush on unload.
 *
 * `apply` never throws for invalid Config: values are normalized with
 * diagnostics and the plugin continues on defaults. Attribution and
 * filesystem failures are contained and reported as diagnostics so a model call
 * is never affected.
 *
 * @module dsh-token-attribution
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createAssembleCache, installAssembleObserver } from './src/host/assemble.mjs'
import { installCollector } from './src/host/collect.mjs'
import {
  DEFAULT_CONFIG,
  RESTART_REQUIRED_FIELDS,
  cloneDefaultConfig,
  describeConfig,
  normalizeConfig,
} from './src/host/config.mjs'
import { installRpc } from './src/host/rpc.mjs'
import { createStore } from './src/host/store.mjs'
import { installWebApiObserver } from './src/host/webapi.mjs'

/** Maximum diagnostics log size before it is rotated once. */
const DIAGNOSTICS_MAX_BYTES = 256 * 1024

/**
 * Append one diagnostic line to the profile's diagnostics log (best-effort).
 * The log holds plugin lifecycle/registration messages only; it never includes
 * prompt, tool, or system-prompt text.
 * @param {string} message - diagnostic text.
 * @returns {void}
 */
function appendDiagnosticLog(message) {
  try {
    const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
      ? process.env.DSH_HOME
      : path.join(os.homedir(), '.dsh')
    const dir = path.join(home, 'token-attribution')
    const file = path.join(dir, 'diagnostics.log')
    fs.mkdirSync(dir, { recursive: true })
    try {
      if (fs.statSync(file).size > DIAGNOSTICS_MAX_BYTES) fs.renameSync(file, `${file}.1`)
    } catch {
      // A missing or unreadable log just means there is nothing to rotate.
    }
    fs.appendFileSync(file, `${new Date().toISOString()} [token-attribution] ${message}\n`, 'utf8')
  } catch {
    // Diagnostics must never break plugin activation.
  }
}

/**
 * Normalize a message-like error value.
 * @param {unknown} error - thrown value.
 * @returns {string} message text.
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Create a diagnostic sink that also logs through the host logger.
 * @param {object} ctx - Cordis context.
 * @returns {(message: string) => void} diagnostic sink.
 */
function createDiagnosticLogger(ctx) {
  const logger = (() => {
    try {
      const value = ctx?.logger
      return typeof value === 'function' ? value('token-attribution') : value
    } catch {
      return undefined
    }
  })()
  return (message) => {
    appendDiagnosticLog(message)
    try {
      logger?.warn?.(`[token-attribution] ${message}`)
    } catch {
      // Logging must never break plugin activation.
    }
  }
}

/**
 * Resolve the host profile context, when the running profile exposes one.
 *
 * The Host process is not started with `DSH_HOME`/`DSH_PROFILE` in its own
 * environment, so an env-only fallback would write every profile's ledger to
 * `.../data/default`. The live profile context carries the launched profile's
 * `name` and DSH `home`; use it when present and let the store fall back to the
 * environment only when it is not.
 *
 * @param {object} ctx - Cordis context.
 * @returns {{homeDir?: string, profile?: string}} store path overrides.
 */
function resolveProfileSource(ctx) {
  let profileCtx
  try {
    profileCtx = typeof ctx?.get === 'function' ? ctx.get('profileContext') : undefined
  } catch {
    profileCtx = undefined
  }
  const homeDir = typeof profileCtx?.home === 'string' && profileCtx.home.length > 0
    ? profileCtx.home
    : undefined
  const profile = typeof profileCtx?.name === 'string' && profileCtx.name.length > 0
    ? profileCtx.name
    : undefined
  return { homeDir, profile, profileSource: profile !== undefined ? 'profileContext' : 'env-fallback' }
}

/**
 * DSH plugin entry.
 * @param {object} ctx - Cordis context.
 * @param {unknown} rawConfig - profile row Config (may be undefined or invalid).
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  const { config, diagnostics } = normalizeConfig(rawConfig)
  const log = createDiagnosticLogger(ctx)
  for (const message of diagnostics) log(message)

  /** @type {string[]} */
  const collectedDiagnostics = [...diagnostics]
  const diag = (message) => {
    if (collectedDiagnostics.length < 200) collectedDiagnostics.push(message)
    log(message)
  }

  /**
   * Register one effect when the context supports effects; diagnostics replace
   * activation failures.
   * @param {string} label - effect label for Cordis diagnostics.
   * @param {() => (() => unknown)} factory - effect body returning a disposer.
   * @returns {void}
   */
  const registerEffect = (label, factory) => {
    try {
      if (typeof ctx?.effect !== 'function') {
        diag(`context does not support ctx.effect; skipped "${label}"`)
        return
      }
      ctx.effect(factory, label)
    } catch (error) {
      diag(`${label} registration failed: ${errorMessage(error)}`)
    }
  }

  let store
  try {
    store = createStore({ ctx, config, diag, ...resolveProfileSource(ctx) })
  } catch (error) {
    diag(`ledger store initialization failed: ${errorMessage(error)}`)
    return
  }

  const assembler = createAssembleCache({ diag })
  const configModule = {
    DEFAULT_CONFIG,
    cloneDefaultConfig,
    describeConfig,
    normalizeConfig,
    RESTART_REQUIRED_FIELDS,
  }
  const configState = { config, diagnostics: collectedDiagnostics }

  // Cordis runs effect disposers in reverse registration order: registering the
  // final flush first makes it run last on unload, after the collector stopped,
  // so in-flight records still reach the ledger before the lock is released.
  registerEffect('token-attribution-final-flush', () => () => {
    try {
      assembler.clear()
    } catch (error) {
      diag(`assemble cache cleanup failed: ${errorMessage(error)}`)
    }
    try {
      store.dispose()
    } catch (error) {
      diag(`ledger dispose failed: ${errorMessage(error)}`)
    }
  })

  registerEffect(
    'token-attribution-assemble-observer',
    () => installAssembleObserver(ctx, { cache: assembler, diag }),
  )
  registerEffect(
    'token-attribution-collector',
    () => installCollector(ctx, { config, store, assembler, diag }),
  )
  // Web API outcomes are observed separately: the host exposes no billing or
  // usage for web tools, so only the tool-call outcome can be counted.
  registerEffect(
    'token-attribution-webapi-observer',
    () => installWebApiObserver(ctx, { store, diag }),
  )

  try {
    installRpc(ctx, { store, configModule, configState, diag })
  } catch (error) {
    diag(`rpc registration failed: ${errorMessage(error)}`)
  }
}
