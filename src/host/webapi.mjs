/**
 * `tools/result` observation for web API calls.
 *
 * The host exposes no provider billing or usage data for web tools, so the only
 * available signal is the observed tool-call outcome: `web_search` and
 * `web_fetch` successes/failures. This observer counts those outcomes into the
 * ledger's separate `webapi/<day>.json` files, both as day totals and under the
 * calling agent's session id (`exec.agent.session.id`) when the execution
 * exposes one. The resulting cost is an estimate from the configured
 * per-thousand prices, never a provider bill.
 *
 * `tools/result` is an observe-only emit event dispatched with the execution's
 * agent scope, so the listener is registered with `{ global: true }` to observe
 * every scope (the emit path may ignore the option, which is harmless). The
 * handler is fully contained: a ledger or diagnostic failure can never affect
 * the tool pipeline or the plugin fiber.
 *
 * @module dsh-token-attribution/host/webapi
 */

/** Observed tool names mapped to their counter kind. */
export const WEB_API_TOOL_KINDS = Object.freeze({
  web_search: 'search',
  web_fetch: 'fetch',
})

/**
 * A disposer that does nothing.
 * @returns {() => void} no-op disposer.
 */
function noop() {}

/**
 * Extract the calling agent's session id from a tool execution.
 *
 * `ToolExecution.agent` is optional and live objects can expose throwing
 * getters, so every access is guarded and anything that is not a non-empty
 * string yields `undefined` (the store then counts it as `unknown`).
 * @param {unknown} exec - tool execution passed to `tools/result`.
 * @returns {string | undefined} session id, or undefined when unavailable.
 */
function sessionIdOf(exec) {
  try {
    // The public Agent contract exposes `id` (equal to the session id today);
    // fall back to the runtime `session.id` for older/leaner shapes.
    const value = exec?.agent?.id ?? exec?.agent?.session?.id
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * Install the `tools/result` web API observer.
 *
 * @param {object} ctx - Cordis context (only `ctx.on` is required).
 * @param {object} options - install inputs.
 * @param {{recordWebApiCall?: (call: {ts: number, tool: 'search'|'fetch', ok: boolean, sessionId?: string}) => unknown}} options.store - ledger store.
 * @param {(message: string) => void} [options.diag] - diagnostic sink.
 * @returns {() => void} listener disposer (idempotent, never throws).
 */
export function installWebApiObserver(ctx, { store, diag } = {}) {
  const report = (message) => {
    try {
      diag?.(message)
    } catch {
      // Diagnostics must never break the observer or the host event dispatch.
    }
  }

  if (ctx === null || typeof ctx !== 'object' || typeof ctx.on !== 'function') {
    report('webapi: context does not support ctx.on; observer not registered')
    return noop
  }

  let disposed = false

  /**
   * Count one web API tool outcome. Other tools are ignored.
   * @param {{name?: unknown}|null|undefined} exec - tool execution.
   * @param {{isError?: unknown}|null|undefined} result - final tool result.
   * @returns {void}
   */
  function onToolResult(exec, result) {
    if (disposed) return
    try {
      const name = exec?.name
      const tool = typeof name === 'string' ? WEB_API_TOOL_KINDS[name] : undefined
      // Guard against prototype keys (`constructor`, `__proto__`, ...) ending up
      // truthy from the lookup object.
      if (tool !== 'search' && tool !== 'fetch') return
      if (store === null || typeof store !== 'object' || typeof store.recordWebApiCall !== 'function') return
      // The event carries no usage/billing data; only the documented failure
      // flag decides success, so a missing result counts as a success exactly
      // like the host's own outcome model (`isError !== true`).
      store.recordWebApiCall({
        ts: Date.now(),
        tool,
        ok: result?.isError !== true,
        // Attribute the counter to the conversation that made the call; the
        // store maps a missing id to its `unknown` bucket.
        sessionId: sessionIdOf(exec),
      })
    } catch (error) {
      report(`webapi: failed to count a tool result (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  let listenerDisposer = noop
  try {
    const returned = ctx.on('tools/result', onToolResult, { global: true })
    if (typeof returned === 'function') listenerDisposer = returned
  } catch (error) {
    report(`webapi: listener registration failed (${error instanceof Error ? error.message : String(error)})`)
    return noop
  }

  return () => {
    if (disposed) return
    disposed = true
    try {
      listenerDisposer()
    } catch (error) {
      report(`webapi: listener disposal failed (${error instanceof Error ? error.message : String(error)})`)
    }
  }
}
