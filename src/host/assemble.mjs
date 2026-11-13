/**
 * `system-prompt/assemble` observation and rendered-text matching.
 *
 * The observer runs the waterfall with `{global: true, prepend: true}`, awaits
 * `next()`, and caches the final presentation's named sections per session. The
 * rendered candidate (raw join and `{{variable}}`-interpolated join) is hashed
 * with SHA-1; only hashes, lengths, and section estimates are ever meant to
 * leave memory. Section text stays inside a bounded in-memory ring buffer so the
 * collector can hash-match the request's system messages.
 *
 * A registered `complete` section is restored after this waterfall, so the
 * cached render is a candidate, not proof: matching always falls back to a
 * length+prefix heuristic and then to `undefined`.
 *
 * @module dsh-token-attribution/host/assemble
 */

import { estimateSystemSections } from './estimate.mjs'
import { nowMs, sha1 } from './util.mjs'

/** Default snapshots retained per session key. */
const DEFAULT_MAX_PER_KEY = 20

/** Default session keys tracked at once. */
const DEFAULT_MAX_KEYS = 64

/** Rendered-prefix characters retained for the heuristic (the requirement needs at most 64). */
const RENDER_PREFIX_CHARS = 128

/** Minimum common-prefix length for the heuristic match on very short prompts. */
const MIN_PREFIX_CHARS = 16

/** Upper bound for the heuristic common-prefix requirement. */
const MAX_PREFIX_CHARS = 64

/**
 * Interpolate strict `{{variable}}` references with the assembly's variables,
 * leaving unknown references literal so matching stays best-effort.
 * @param {string} text - section or context text.
 * @param {Record<string, string | undefined>} variables - assembly variables.
 * @returns {string} interpolated text.
 */
export function interpolateText(text, variables) {
  const value = String(text ?? '')
  if (value.indexOf('{{') < 0 || variables === null || typeof variables !== 'object') return value
  return value.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (match, name) => {
    const replacement = variables[name]
    return typeof replacement === 'string' ? replacement : match
  })
}

/**
 * Length of the common prefix of two strings.
 * @param {string} left - first string.
 * @param {string} right - second string.
 * @returns {number} common prefix length in code units.
 */
export function commonPrefixLength(left, right) {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1
  return index
}

/**
 * Create a bounded per-key cache of prompt-assembly snapshots.
 * @param {{maxPerKey?: number, maxKeys?: number, diag?: (message: string) => void}} [options] - bounds and diagnostic sink.
 * @returns {{
 *   keyFor: (context: object) => string,
 *   record: (input: object) => object | undefined,
 *   snapshotFor: (key: unknown) => object | undefined,
 *   matchSystemText: (key: unknown, text: unknown) => ({snapshot: object, match: 'hash'|'prefix', hash?: string} | undefined),
 *   stats: () => {keys: number, snapshots: number},
 *   clear: () => void,
 * }} assembler cache.
 */
export function createAssembleCache({ maxPerKey = DEFAULT_MAX_PER_KEY, maxKeys = DEFAULT_MAX_KEYS, diag } = {}) {
  /** @type {Map<string, object[]>} */
  const buffers = new Map()
  const scopeIds = new WeakMap()
  let scopeCounter = 0
  let snapshotCounter = 0

  /**
   * Stable key for one assembly context: the session id when available, else a
   * per-scope object identity for the process lifetime.
   * @param {object} [context] - `AssembleContext` extended by the agent loop.
   * @returns {string} cache key.
   */
  function keyFor(context) {
    const agent = context?.agent
    const agentSessionId = agent?.session?.id
    if (typeof agentSessionId === 'string' && agentSessionId.length > 0) return agentSessionId
    const scope = context?.scope
    if (scope !== null && typeof scope === 'object') {
      const scopeSessionId = scope.session?.id
      if (typeof scopeSessionId === 'string' && scopeSessionId.length > 0) return scopeSessionId
      let id = scopeIds.get(scope)
      if (id === undefined) {
        scopeCounter += 1
        id = `scope:${scopeCounter}`
        scopeIds.set(scope, id)
      }
      return id
    }
    return 'global'
  }

  /**
   * Record one final assembly presentation under its session key.
   * @param {{key: string, sections?: object[], contexts?: object[], variables?: object}} input - observed presentation.
   * @returns {object | undefined} the stored snapshot, or undefined when it has no usable text.
   */
  function record({ key, sections, contexts, variables }) {
    const assemblyKey = String(key ?? 'global')
    const rawSections = (Array.isArray(sections) ? sections : [])
      .filter(section => section !== null && typeof section === 'object')
      .map(section => ({
        name: String(section.name ?? 'unknown'),
        text: String(section.text ?? ''),
        interpolate: section.interpolate !== false,
      }))
    const interpolatedSections = rawSections.map(section => ({
      name: section.name,
      text: section.interpolate ? interpolateText(section.text, variables) : section.text,
    }))
    const renderedRaw = rawSections.map(section => section.text).filter(text => text.length > 0).join('\n\n')
    const renderedInterpolated = interpolatedSections.map(section => section.text)
      .filter(text => text.length > 0)
      .join('\n\n')
    if (renderedRaw.length === 0 && renderedInterpolated.length === 0) return undefined

    const pricedSections = estimateSystemSections(interpolatedSections.map(section => ({
      name: section.name,
      text: section.text,
    })))
    const pricedContexts = (Array.isArray(contexts) ? contexts : [])
      .filter(context => context !== null && typeof context === 'object')
      .map(context => ({
        name: String(context.name ?? 'unknown'),
        text: context.interpolate === false ? String(context.text ?? '') : interpolateText(context.text, variables),
      }))
      .filter(context => context.text.length > 0)
    const contextEstimates = estimateSystemSections(pricedContexts)

    snapshotCounter += 1
    const snapshot = {
      id: snapshotCounter,
      ts: nowMs(),
      sections: pricedSections.sections.map(section => ({
        name: section.name,
        text: interpolatedSections.find(entry => entry.name === section.name)?.text
          ?? rawSections.find(entry => entry.name === section.name)?.text
          ?? '',
        ascii: section.ascii,
        nonAscii: section.nonAscii,
        est: section.est,
      })),
      contexts: contextEstimates.sections.map(section => ({
        name: section.name,
        ascii: section.ascii,
        nonAscii: section.nonAscii,
        est: section.est,
      })),
      hashes: [sha1(renderedRaw), sha1(renderedInterpolated)],
      renderedLengths: { raw: renderedRaw.length, interpolated: renderedInterpolated.length },
      // Only a bounded prefix is retained: the full render is a second copy of
      // the section text, and the heuristic never compares more than 64 chars.
      renderedRawPrefix: renderedRaw.slice(0, RENDER_PREFIX_CHARS),
      renderedInterpolatedPrefix: renderedInterpolated.slice(0, RENDER_PREFIX_CHARS),
    }

    const buffer = buffers.get(assemblyKey)
    if (buffer === undefined) {
      buffers.set(assemblyKey, [snapshot])
    } else {
      buffer.push(snapshot)
      while (buffer.length > maxPerKey) buffer.shift()
    }
    while (buffers.size > maxKeys) {
      const oldestKey = buffers.keys().next().value
      if (oldestKey === undefined) break
      buffers.delete(oldestKey)
    }
    return snapshot
  }

  /**
   * Latest snapshot for one session key.
   * @param {unknown} key - session id or scope key.
   * @returns {object | undefined} latest snapshot.
   */
  function snapshotFor(key) {
    const buffer = buffers.get(String(key ?? 'global'))
    return buffer === undefined ? undefined : buffer[buffer.length - 1]
  }

  /**
   * Match one rendered system message against the key's snapshots: exact hash
   * first (newest first), then a length+prefix heuristic, else undefined.
   * @param {unknown} key - session id or scope key.
   * @param {unknown} text - rendered system message text.
   * @returns {{snapshot: object, match: 'hash'|'prefix', hash?: string} | undefined} match.
   */
  function matchSystemText(key, text) {
    const value = typeof text === 'string' ? text : ''
    if (value.length === 0) return undefined
    const buffer = buffers.get(String(key ?? 'global'))
    if (buffer === undefined || buffer.length === 0) return undefined
    const hash = sha1(value)
    for (let index = buffer.length - 1; index >= 0; index -= 1) {
      const snapshot = buffer[index]
      if (snapshot.hashes.includes(hash)) return { snapshot, match: 'hash', hash }
    }
    for (let index = buffer.length - 1; index >= 0; index -= 1) {
      const snapshot = buffer[index]
      for (const candidate of [
        { prefix: snapshot.renderedInterpolatedPrefix, renderedLength: snapshot.renderedLengths.interpolated },
        { prefix: snapshot.renderedRawPrefix, renderedLength: snapshot.renderedLengths.raw },
      ]) {
        if (candidate.prefix.length === 0) continue
        const shortest = Math.min(candidate.renderedLength, value.length)
        const tolerance = Math.max(8, Math.floor(shortest * 0.02))
        if (Math.abs(candidate.renderedLength - value.length) > tolerance) continue
        const needed = Math.min(MAX_PREFIX_CHARS, Math.max(MIN_PREFIX_CHARS, Math.floor(shortest * 0.1)))
        if (commonPrefixLength(candidate.prefix, value) >= needed) {
          return { snapshot, match: 'prefix', hash }
        }
      }
    }
    return undefined
  }

  /**
   * Cache occupancy for diagnostics.
   * @returns {{keys: number, snapshots: number}} counts.
   */
  function stats() {
    let snapshots = 0
    for (const buffer of buffers.values()) snapshots += buffer.length
    return { keys: buffers.size, snapshots }
  }

  /** Drop every cached snapshot (memory hygiene on plugin unload). */
  function clear() {
    buffers.clear()
  }

  return { keyFor, record, snapshotFor, matchSystemText, stats, clear }
}

/**
 * Register the `system-prompt/assemble` observer.
 *
 * The listener awaits `next()`, records the final presentation, and always
 * returns the presentation unchanged. Recording failures are contained so the
 * host's prompt assembly is never affected.
 *
 * @param {object} ctx - Cordis context.
 * @param {{cache: ReturnType<typeof createAssembleCache>, diag?: (message: string) => void}} options - cache and diagnostic sink.
 * @returns {() => boolean} listener disposer from `ctx.on`.
 */
export function installAssembleObserver(ctx, { cache, diag }) {
  return ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const final = await next()
    try {
      cache.record({
        key: cache.keyFor(context),
        sections: final?.sections,
        contexts: final?.contexts,
        variables: final?.variables,
      })
    } catch (error) {
      try {
        diag?.(`assemble observe failed: ${error instanceof Error ? error.message : String(error)}`)
      } catch {
        // Diagnostics must never break prompt assembly.
      }
    }
    return final
  }, { global: true, prepend: true })
}
