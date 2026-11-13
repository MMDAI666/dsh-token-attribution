/**
 * Connection RPC surface for the token-attribution ledger.
 *
 * The handler is registered on `config.rpcChannel` through
 * `ctx.inject(['connection'], ...)`, so profiles without Connection keep
 * collecting to disk without an RPC surface. Every endpoint validates its
 * payload and every failure is returned as `{ok:false, error:{code,message,details}}`;
 * the handler never throws.
 *
 * @module dsh-token-attribution/host/rpc
 */

import { getService, isValidDayKey, nowMs, dayKey, shiftDays } from './util.mjs'

/** Allowed relative ranges and how many days back they reach. */
const RANGE_DAYS = Object.freeze({ today: 0, '7d': 6, '30d': 29 })

/** Maximum pages size accepted by `requests`. */
const MAX_REQUEST_LIMIT = 200

/** Export content cap in UTF-8 bytes (2 MiB). */
export const EXPORT_MAX_BYTES = 2 * 1024 * 1024

/** Media type per accepted export format. */
const EXPORT_MEDIA_TYPES = Object.freeze({ json: 'application/json', csv: 'text/csv' })

/** RFC4180 CSV header for the per-day trend export. */
const EXPORT_CSV_HEADER = 'day,requests,promptTokens,outputTokens,estimatedRequests,costAmount,currency,priced,unpricedRequests'

/** Sections omitted from a compact JSON export when the full report is too large. */
const EXPORT_COMPACT_OMIT = Object.freeze(['byDay', 'byPurpose', 'byModel', 'bySession'])

/**
 * Build a structured failure result.
 * @param {string} code - machine-readable error code.
 * @param {string} message - human-readable message.
 * @param {object} [details] - structured details.
 * @returns {{ok: false, error: {code: string, message: string, details: object}}} failure result.
 */
function failure(code, message, details = {}) {
  return { ok: false, error: { code, message, details } }
}

/**
 * Build a structured success result.
 * @param {unknown} value - endpoint value.
 * @returns {{ok: true, value: unknown}} success result.
 */
function success(value) {
  return { ok: true, value }
}

/**
 * Throw a payload-validation failure that the handler maps to `bad-request`.
 * @param {string} message - validation message.
 * @param {object} [details] - structured details.
 * @returns {never} always throws.
 */
function badRequest(message, details = {}) {
  const error = new Error(message)
  error.code = 'bad-request'
  error.details = details
  throw error
}

/**
 * Require a plain object payload (or undefined/null for payload-free endpoints).
 * @param {unknown} payload - raw payload.
 * @param {string} endpoint - endpoint name for the message.
 * @returns {object} payload object.
 */
function objectPayload(payload, endpoint) {
  if (payload === undefined || payload === null) return {}
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    badRequest(`${endpoint} payload must be an object`, { endpoint })
  }
  return payload
}

/**
 * Require a `YYYY-MM-DD` day key.
 * @param {unknown} value - candidate.
 * @param {string} field - field name for the message.
 * @returns {string} validated day key.
 */
function requireDay(value, field) {
  if (!isValidDayKey(value)) {
    badRequest(`${field} must be a YYYY-MM-DD day`, { field, value })
  }
  return value
}

/**
 * Resolve an inclusive day range from `range`/`from`/`to`.
 * @param {object} payload - endpoint payload.
 * @param {string} endpoint - endpoint name for messages.
 * @returns {{from: string, to: string}} inclusive day range.
 */
function resolveRange(payload, endpoint) {
  const body = objectPayload(payload, endpoint)
  const range = body.range === undefined ? 'today' : body.range
  if (typeof range !== 'string' || !Object.hasOwn(RANGE_DAYS, range)) {
    badRequest('range must be "today", "7d", or "30d"', { range })
  }
  const to = body.to === undefined ? dayKey(nowMs()) : requireDay(body.to, 'to')
  const from = body.from === undefined ? shiftDays(to, -RANGE_DAYS[range]) : requireDay(body.from, 'from')
  if (from > to) badRequest('from must not be after to', { from, to })
  return { from, to }
}

/**
 * Coerce a value to a finite non-negative number for export rows.
 * @param {unknown} value - candidate.
 * @returns {number} safe number.
 */
function numberValue(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Escape one RFC4180 CSV field (quote when it contains a comma, quote, CR, or LF).
 * @param {unknown} value - field value.
 * @returns {string} escaped field.
 */
function csvField(value) {
  const text = String(value ?? '')
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * Build the JSON export report from a summary. `summary.data` is deliberately
 * excluded: it carries local filesystem paths and diagnostics, not usage data.
 * The ledger stores no prompt, tool, or session-title text, so none can appear
 * in an export.
 * @param {object} summary - `store.readSummary` value.
 * @param {string} profile - profile name.
 * @param {{from: string, to: string}} range - exported day range.
 * @returns {object} export report.
 */
function exportReport(summary, profile, range) {
  const value = summary !== null && typeof summary === 'object' ? summary : {}
  return {
    generatedAt: Number.isFinite(value.generatedAt) ? value.generatedAt : nowMs(),
    profile,
    range,
    totals: value.totals !== null && typeof value.totals === 'object' ? value.totals : {},
    cost: value.cost !== null && typeof value.cost === 'object' ? value.cost : {},
    // Web API tool-call counters plus their configured-price estimate. They are
    // deliberately not in `EXPORT_COMPACT_OMIT`, so the compact fallback keeps
    // them (the ledger holds no raw tool arguments or results).
    webApi: value.webApi !== null && typeof value.webApi === 'object' ? value.webApi : {},
    byDay: Array.isArray(value.byDay) ? value.byDay : [],
    byPurpose: value.byPurpose !== null && typeof value.byPurpose === 'object' ? value.byPurpose : {},
    byCategory: value.byCategory !== null && typeof value.byCategory === 'object' ? value.byCategory : {},
    byCategoryGroup: value.byCategoryGroup !== null && typeof value.byCategoryGroup === 'object' ? value.byCategoryGroup : {},
    byToolGroup: value.byToolGroup !== null && typeof value.byToolGroup === 'object' ? value.byToolGroup : {},
    byModel: Array.isArray(value.byModel) ? value.byModel : [],
    bySession: Array.isArray(value.bySession) ? value.bySession : [],
  }
}

/**
 * Render an export report as JSON or RFC4180 CSV under a byte cap.
 *
 * CSV is emitted incrementally and stops at the last complete row; JSON is
 * never cut mid-document: when the pretty report exceeds the cap, a compact
 * report omits the per-day/per-entity sections and carries `truncated:true`
 * plus a `note`. `bytes` is the UTF-8 byte length of the returned content.
 *
 * @param {object} report - export report (`generatedAt`, `profile`, `range`, `totals`, ...).
 * @param {'json'|'csv'} format - export format.
 * @param {{maxBytes?: number}} [options] - optional byte cap (defaults to 2 MiB).
 * @returns {{content: string, bytes: number, truncated: boolean, mediaType: string}} rendered export.
 */
export function renderExport(report, format, options = {}) {
  const value = report !== null && typeof report === 'object' ? report : {}
  const maxBytes = Number.isFinite(options?.maxBytes) && options.maxBytes > 0
    ? Math.floor(options.maxBytes)
    : EXPORT_MAX_BYTES
  if (format === 'csv') {
    let content = `${EXPORT_CSV_HEADER}\r\n`
    let bytes = Buffer.byteLength(content, 'utf8')
    let truncated = false
    for (const row of Array.isArray(value.byDay) ? value.byDay : []) {
      const cost = row?.cost !== null && typeof row?.cost === 'object' ? row.cost : {}
      const line = [
        typeof row?.day === 'string' ? row.day : '',
        numberValue(row?.requests),
        numberValue(row?.promptTokens),
        numberValue(row?.outputTokens),
        numberValue(row?.estimatedRequests),
        numberValue(cost.amount),
        typeof cost.currency === 'string' && cost.currency.length > 0 ? cost.currency : 'CNY',
        cost.priced === true ? 'true' : 'false',
        numberValue(cost.unpricedRequests),
      ].map(csvField).join(',') + '\r\n'
      const lineBytes = Buffer.byteLength(line, 'utf8')
      if (bytes + lineBytes > maxBytes) {
        truncated = true
        break
      }
      content += line
      bytes += lineBytes
    }
    return { content, bytes, truncated, mediaType: EXPORT_MEDIA_TYPES.csv }
  }
  if (format !== 'json') {
    throw new TypeError(`unsupported export format: ${String(format)}`)
  }
  const mediaType = EXPORT_MEDIA_TYPES.json
  const pretty = JSON.stringify(value, null, 2)
  let bytes = Buffer.byteLength(pretty, 'utf8')
  if (bytes <= maxBytes) return { content: pretty, bytes, truncated: false, mediaType }
  const compact = { ...value }
  for (const key of EXPORT_COMPACT_OMIT) delete compact[key]
  compact.truncated = true
  compact.note = 'report exceeded the export size cap; per-day token rows and per-purpose/model/session token detail were omitted, while totals, cost, category totals, and the web API counters (including per-session rows and the unattributed remainder) are kept'
  let content = JSON.stringify(compact)
  bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > maxBytes) {
    delete compact.byCategory
    delete compact.byToolGroup
    compact.note = 'report exceeded the export size cap; only totals, cost, category totals, and the web API counters (including the unattributed remainder) are included'
    content = JSON.stringify(compact)
    bytes = Buffer.byteLength(content, 'utf8')
  }
  if (bytes > maxBytes) {
    // Last resort for an artificially tiny cap: keep valid JSON rather than
    // cutting the document. At the real 2 MiB cap this branch is unreachable.
    content = JSON.stringify({
      generatedAt: value.generatedAt ?? null,
      profile: value.profile ?? null,
      range: value.range ?? null,
      truncated: true,
      note: 'report exceeded the export size cap; only range metadata is included',
    })
    bytes = Buffer.byteLength(content, 'utf8')
  }
  return { content, bytes, truncated: true, mediaType }
}

/**
 * Create the RPC handler.
 *
 * @param {object} options - handler dependencies.
 * @param {object} options.store - ledger store.
 * @param {{normalizeConfig: Function, describeConfig: Function, cloneDefaultConfig: Function, RESTART_REQUIRED_FIELDS: readonly string[]}} options.configModule - config helpers.
 * @param {{config: object, diagnostics?: string[]}} options.configState - mutable current-config state.
 * @param {object} options.ctx - Cordis context used for `configEditor`/`fiber.entry`.
 * @param {(message: string) => void} [options.diag] - diagnostic sink.
 * @returns {(endpoint: string, payload: unknown) => Promise<object>} RPC handler.
 */
export function createRpcHandler({ store, configModule, configState, ctx, diag }) {
  const report = (message) => {
    try {
      diag?.(message)
    } catch {
      // Diagnostics must never escape the handler.
    }
  }

  /**
   * `config.get` value.
   * @returns {object} current config, defaults, editability, and field metadata.
   */
  function configGetValue() {
    const editor = getService(ctx, 'configEditor')
    return {
      values: configState.config,
      defaults: configModule.cloneDefaultConfig(),
      editable: editor !== undefined && editor !== null && typeof editor.edit === 'function',
      restartRequiredFields: [...configModule.RESTART_REQUIRED_FIELDS],
      fields: configModule.describeConfig(),
      diagnostics: Array.isArray(configState.diagnostics) ? [...configState.diagnostics] : [],
    }
  }

  /**
   * `config.set` implementation: validate, persist through the host config
   * editor, and report the fields that require a plugin reload.
   * @param {unknown} payload - `{patch}`.
   * @returns {Promise<object>} RPC result.
   */
  async function configSet(payload) {
    const body = objectPayload(payload, 'config.set')
    const patch = body.patch
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      badRequest('patch must be an object', { field: 'patch' })
    }
    const { config: next, diagnostics } = configModule.normalizeConfig({ ...configState.config, ...patch })
    if (diagnostics.length > 0) {
      return failure('config-invalid', 'configuration was rejected', { diagnostics })
    }
    const editor = getService(ctx, 'configEditor')
    const entry = ctx?.fiber?.entry
    if (editor === undefined || editor === null || typeof editor.edit !== 'function' || entry === undefined) {
      return failure('config-readonly', 'no configuration editor is available in this profile', {
        editable: false,
      })
    }
    const previous = configState.config
    const restartRequired = configModule.RESTART_REQUIRED_FIELDS.filter(
      field => JSON.stringify(previous?.[field]) !== JSON.stringify(next?.[field]),
    )
    try {
      await editor.edit(entry, current => ({ ...current, ...next }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      report(`config.set failed: ${message}`)
      return failure('config-write-failed', message, {})
    }
    configState.config = next
    configState.diagnostics = []
    return success({ applied: true, values: next, restartRequired })
  }

  return async function handleRpc(endpoint, payload) {
    try {
      switch (endpoint) {
        case 'summary': {
          const { from, to } = resolveRange(payload, 'summary')
          return success(store.readSummary({ from, to }))
        }
        case 'requests': {
          const body = objectPayload(payload, 'requests')
          if (body.date !== undefined) requireDay(body.date, 'date')
          if (body.from !== undefined) requireDay(body.from, 'from')
          if (body.to !== undefined) requireDay(body.to, 'to')
          const limit = body.limit === undefined ? 50 : body.limit
          if (!Number.isInteger(limit) || limit < 1 || limit > MAX_REQUEST_LIMIT) {
            badRequest(`limit must be an integer in 1..${MAX_REQUEST_LIMIT}`, { limit })
          }
          const offset = body.offset === undefined ? 0 : body.offset
          if (!Number.isInteger(offset) || offset < 0) badRequest('offset must be a non-negative integer', { offset })
          if (body.purpose !== undefined && (typeof body.purpose !== 'string' || body.purpose.length === 0)) {
            badRequest('purpose must be a non-empty string', { purpose: body.purpose })
          }
          if (body.sessionId !== undefined && (typeof body.sessionId !== 'string' || body.sessionId.length === 0)) {
            badRequest('sessionId must be a non-empty string', { field: 'sessionId' })
          }
          return success(store.readRequests({
            date: body.date,
            from: body.from,
            to: body.to,
            limit,
            offset,
            purpose: body.purpose,
            sessionId: body.sessionId,
          }))
        }
        case 'meta':
          return success(store.readMeta())
        case 'export': {
          const body = objectPayload(payload, 'export')
          const { from, to } = resolveRange(payload, 'export')
          const format = body.format
          if (format !== 'json' && format !== 'csv') {
            badRequest('format must be "json" or "csv"', { format })
          }
          const summary = store.readSummary({ from, to })
          let profile = 'unknown'
          try {
            const meta = typeof store.readMeta === 'function' ? store.readMeta() : null
            if (meta !== null && typeof meta === 'object' && typeof meta.profile === 'string') {
              profile = meta.profile
            }
          } catch {
            // Profile metadata is cosmetic for an export; never fail on it.
          }
          const rendered = renderExport(exportReport(summary, profile, { from, to }), format)
          return success({
            filename: `token-attribution-${from}_${to}.${format}`,
            mediaType: rendered.mediaType,
            content: rendered.content,
            bytes: rendered.bytes,
            truncated: rendered.truncated,
            range: { from, to },
          })
        }
        case 'config.get':
          return success(configGetValue())
        case 'config.set':
          return await configSet(payload)
        case 'migration.status':
          return success(store.migrationStatus())
        default:
          return failure('unknown-endpoint', `unknown endpoint "${String(endpoint)}"`, { endpoint })
      }
    } catch (error) {
      if (error?.code === 'bad-request') {
        return failure('bad-request', error.message, error.details ?? {})
      }
      const message = error instanceof Error ? error.message : String(error)
      report(`rpc "${String(endpoint)}" failed: ${message}`)
      return failure('internal', message, { endpoint })
    }
  }
}

/**
 * Register the RPC channel when the profile provides Connection.
 *
 * @param {object} ctx - Cordis context.
 * @param {object} options - registration inputs.
 * @param {object} options.store - ledger store.
 * @param {object} options.configModule - config helpers.
 * @param {{config: object, diagnostics?: string[]}} options.configState - mutable current-config state.
 * @param {(message: string) => void} [options.diag] - diagnostic sink.
 * @returns {void}
 */
export function installRpc(ctx, { store, configModule, configState, diag }) {
  const note = (message) => {
    try {
      diag?.(message)
    } catch {
      // Diagnostics never escape registration.
    }
  }
  if (ctx === null || typeof ctx !== 'object' || typeof ctx.inject !== 'function') {
    note('rpc: context has no ctx.inject; RPC not registered')
    return
  }
  note(`rpc: registering channel "${configState.config.rpcChannel}"`)
  let fiber
  try {
    // Connection mounts an RPC channel through its owner's `webServer`; the
    // context that reads the connection service must therefore inject both.
    fiber = ctx.inject(['connection', 'webServer'], (scope) => {
      note('rpc: connection+webServer dependencies satisfied')
      try {
        // Connection's `rpc` getter registers against the Context that reads the
        // service; that context must see `webServer`. Reading through a child
        // context that carries an explicit `webServer` property reproduces the
        // pattern the shipped dsh-mnemon plugin uses (its `extend({ webServer })`
        // step). A raw `ctx.get()` instance resolves the channel against the
        // connection plugin's own context, where `webServer` is not injected.
        const readScope = typeof scope?.extend === 'function' && typeof scope?.get === 'function'
          ? scope.extend({ webServer: scope.get('webServer') })
          : scope
        let connection
        try {
          connection = readScope?.connection
        } catch {
          connection = undefined
        }
        if (connection === undefined) connection = getService(scope, 'connection')
        const rpc = connection?.rpc
        if (rpc === null || typeof rpc !== 'object' || typeof rpc.handle !== 'function') {
          note('rpc: connection.rpc.handle is unavailable; RPC not registered')
          return () => {}
        }
        const dispose = rpc.handle(
          configState.config.rpcChannel,
          createRpcHandler({ store, configModule, configState, ctx, diag }),
        )
        note(`rpc: channel "${configState.config.rpcChannel}" registered`)
        return dispose
      } catch (error) {
        note(`rpc: channel registration failed: ${error instanceof Error ? error.message : String(error)}`)
        return () => {}
      }
    })
  } catch (error) {
    note(`rpc: inject failed: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  if (fiber !== null && typeof fiber === 'object' && typeof fiber.then === 'function') {
    fiber.then(() => {}, (error) => {
      note(`rpc: inject fiber failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
}
