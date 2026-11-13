/**
 * `llm/stream` observation.
 *
 * The wrapper yields every chunk unchanged and records the terminal `usage`
 * and `finish` chunks. Attribution runs once, after the stream ends (success,
 * error, or consumer cancellation), inside `try/catch`, and never delays a
 * chunk. A failed attribution still persists a minimal record carrying the
 * provider usage and a stable error name (never the exception message, which
 * may embed prompt text).
 *
 * @module dsh-token-attribution/host/collect
 */

import { buildRecord, finishKind, normalizePurpose } from './attribute.mjs'
import { getService, nowMs, sha1 } from './util.mjs'

/** Upper bound on tracked session+purpose attempt keys before the map resets. */
const MAX_PENDING_ATTEMPT_KEYS = 1024

/**
 * Read the live session header without failing when the session store is
 * absent or the session is not (or no longer) live.
 * @param {object} ctx - Cordis context.
 * @param {string | null} sessionId - session id of the call.
 * @returns {object | null} header snapshot, or null.
 */
export function readSessionHeader(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null
  try {
    const sessions = getService(ctx, 'sessions')
    if (sessions === null || typeof sessions !== 'object' || typeof sessions.get !== 'function') return null
    const session = sessions.get(sessionId)
    const header = session?.header
    return header !== null && typeof header === 'object' ? header : null
  } catch {
    return null
  }
}

/**
 * Create the retry-attempt tracker used by the collector.
 *
 * M1a has no `llm/retry` correlation: an attempt index is the count of
 * consecutive failed calls for the same `sessionId`+`purpose`, reset by the
 * first successful call.
 * @returns {{next: (sessionId: string | null, purpose: string, finish: object | null) => number, size: () => number}} tracker.
 */
export function createAttemptTracker() {
  /** @type {Map<string, number>} */
  const consecutiveErrors = new Map()
  return {
    next(sessionId, purpose, finish) {
      const key = `${sessionId ?? '-'}|${purpose}`
      const kind = finishKind(finish)
      // `max-tokens` is a successful terminal outcome, unlike error/aborted/
      // unknown (absent finish, e.g. consumer cancellation).
      const failed = kind === 'error' || kind === 'aborted' || kind === 'unknown'
      if (!failed) {
        consecutiveErrors.delete(key)
        return 1
      }
      const index = (consecutiveErrors.get(key) ?? 0) + 1
      consecutiveErrors.set(key, index)
      if (consecutiveErrors.size > MAX_PENDING_ATTEMPT_KEYS) consecutiveErrors.clear()
      return index
    },
    size() {
      return consecutiveErrors.size
    },
  }
}

/**
 * Install the `llm/stream` collector.
 * @param {object} ctx - Cordis context.
 * @param {object} options - install inputs.
 * @param {object} options.config - normalized plugin config.
 * @param {{append: (record: object) => unknown}} options.store - ledger store.
 * @param {object} options.assembler - assemble cache with `matchSystemText`.
 * @param {(message: string) => void} [options.diag] - diagnostic sink.
 * @param {object} [options.logger] - host logger (unused directly; diagnostics route through `diag`).
 * @returns {() => boolean} listener disposer from `ctx.on`.
 */
export function installCollector(ctx, { config, store, assembler, diag, logger: _logger }) {
  const attempts = createAttemptTracker()
  /** @type {Map<string, 'in-history'|'addition-only'|null>} */
  const toolUpdateModes = new Map()
  /** @type {Set<string>} */
  const toolUpdatePending = new Set()
  let sequence = 0

  const report = (message) => {
    try {
      diag?.(message)
    } catch {
      // Diagnostics must never break a model call.
    }
  }

  /**
   * Resolve and cache the route's mid-conversation tool-update mode. The
   * lookup is async, so it only affects later calls; the first call uses the
   * documented `options.tools` fallback.
   * @param {object} request - `GenerateOptions`.
   * @returns {void}
   */
  function prefetchToolUpdate(request) {
    const provider = request?.provider
    const model = request?.model
    if (typeof provider !== 'string' || typeof model !== 'string') return
    const key = `${provider}|${model}`
    if (toolUpdateModes.has(key) || toolUpdatePending.has(key)) return
    const llm = getService(ctx, 'llm')
    if (llm === null || typeof llm !== 'object' || typeof llm.resolveModelInfo !== 'function') return
    toolUpdatePending.add(key)
    try {
      Promise.resolve(llm.resolveModelInfo(provider, model)).then((info) => {
        const mode = info?.toolUpdate
        toolUpdateModes.set(key, mode === 'in-history' || mode === 'addition-only' ? mode : null)
      }, () => {
        toolUpdateModes.set(key, null)
      }).catch(() => {
        // The cache entry stays absent; the caller keeps the fallback path.
      }).finally(() => {
        toolUpdatePending.delete(key)
      }).catch(() => {
        // A failed cache cleanup must not become an unhandled rejection.
      })
    } catch {
      toolUpdatePending.delete(key)
    }
  }

  /**
   * Resolved tool-update mode for a request, when cached.
   * @param {object} request - `GenerateOptions`.
   * @returns {'in-history'|'addition-only'|undefined} mode.
   */
  function toolUpdateMode(request) {
    const provider = request?.provider
    const model = request?.model
    if (typeof provider !== 'string' || typeof model !== 'string') return undefined
    const cached = toolUpdateModes.get(`${provider}|${model}`)
    return cached === null ? undefined : cached
  }

  /**
   * Attribute and queue one finished call. Never throws.
   * @param {{request: object, usage: object|null, finish: object|null, startedAt: number, endedAt: number}} observed - stream outcome.
   * @returns {void}
   */
  function finalize({ request, usage, finish, startedAt, endedAt }) {
    const purpose = normalizePurpose(request?.purpose)
    const sessionId = typeof request?.sessionId === 'string' && request.sessionId.length > 0 ? request.sessionId : null
    const attemptIndex = attempts.next(sessionId, purpose, finish)
    sequence += 1
    let record
    try {
      record = buildRecord({
        options: request,
        usage,
        finish,
        startedAt,
        endedAt,
        assembleSnapshot: assembler,
        assembleKey: sessionId ?? 'global',
        sessionHeader: readSessionHeader(ctx, sessionId),
        config,
        ctx,
        counter: sequence,
        attemptIndex,
        toolUpdate: toolUpdateMode(request),
      })
    } catch (error) {
      // Privacy: a thrown message may embed prompt/tool text. Persist and log
      // only the stable error name; the fields that matter (usage/purpose/
      // sessionId) are already plain numbers and identifiers.
      const errorName = error instanceof Error && typeof error.name === 'string' && error.name.length > 0
        ? error.name
        : 'Error'
      report(`attribution failed (${errorName})`)
      record = {
        v: 1,
        ts: endedAt,
        id: sha1([sessionId ?? '-', endedAt, sequence, purpose, 'attribution-error'].join('|')),
        attribution_error: { name: errorName },
        usage: usage ?? null,
        purpose,
        sessionId,
      }
    }
    try {
      store.append(record)
    } catch (error) {
      report(`ledger append failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Wrap one `llm/stream` call.
   * @param {object} request - `GenerateOptions`.
   * @param {() => AsyncIterable<object>} next - next waterfall stage.
   * @returns {AsyncIterable<object>} the unchanged chunk stream.
   */
  function wrapStream(request, next) {
    // Call the next stage at dispatch time, exactly like an unwrapped listener,
    // so downstream observers start in the same order and synchronous failures
    // keep propagating through the host waterfall.
    const stream = next()
    return (async function* observed() {
      const startedAt = nowMs()
      let usage = null
      let finish = null
      prefetchToolUpdate(request)
      try {
        for await (const chunk of stream) {
          if (chunk !== null && typeof chunk === 'object') {
            if (chunk.type === 'usage' && chunk.usage !== null && chunk.usage !== undefined) usage = chunk.usage
            else if (chunk.type === 'finish') finish = chunk
          }
          yield chunk
        }
      } finally {
        finalize({ request, usage, finish, startedAt, endedAt: nowMs() })
      }
    })()
  }

  return ctx.on('llm/stream', (request, next) => wrapStream(request, next), { global: true, prepend: true })
}
