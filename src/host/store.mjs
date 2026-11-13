/**
 * Local JSON ledger: pointer/lock state, per-request JSONL detail, daily
 * aggregates, write-behind flush, retention pruning, and summary/request reads.
 *
 * Storage layout under `<DSH_HOME>/token-attribution/`:
 * - `state/<profile>/pointer.json` — current data root (stable across dataDir changes)
 * - `state/<profile>/lock` — pid/startedAt of the writing process
 * - `data/<profile>/meta.json` — schema/estimator/version metadata
 * - `data/<profile>/requests/YYYY-MM-DD.jsonl` — detail rows
 * - `data/<profile>/daily/YYYY-MM-DD.json` — daily aggregates
 * - `data/<profile>/webapi/YYYY-MM-DD.json` — observed web API call counters
 *   (day totals plus a bounded per-session breakdown)
 *
 * All writes are best-effort: filesystem failures produce diagnostics and are
 * retried on the next flush, while in-memory aggregates stay consistent.
 *
 * @module dsh-token-attribution/host/store
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { computeCost } from './attribute.mjs'
import { DEFAULT_WEB_API_PRICING } from './config.mjs'
import { ESTIMATOR_VERSION } from './estimate.mjs'
import {
  MIGRATION_BACKUP_DAYS,
  MIGRATION_MAX_BYTES,
  pruneMigrationBackups,
  readMigrationState,
  runMigration,
  samePath,
} from './migration.mjs'
import { categoryGroup, categoryToolGroup } from './rules.mjs'
import {
  atomicWriteFileSync,
  dayKey,
  dayKeysBetween,
  ensureDir,
  isValidDayKey,
  nowMs,
  readJsonFile,
  round,
  sha1,
  shiftDays,
} from './util.mjs'

/** Ledger schema revision written into pointer, meta, aggregates. */
export const SCHEMA_VERSION = 1

/** Daily-aggregate revision that includes per-entity cost breakdowns. */
export const COST_SCHEMA_VERSION = 2

/** Maximum session rows returned by `readSummary` (the client builds a tree). */
export const MAX_SUMMARY_SESSIONS = 500

/** Installed plugin version recorded in `meta.json`. */
export const INSTALLED_VERSION = '0.1.0'

/**
 * Version of the one-time auto-review category migration recorded in
 * `meta.autoReviewCategoryVersion`. Version 1 moves legacy auto-review
 * transcript tokens from `categories.user` to `categories['injected:auto-review']`
 * in retained detail rows and rebuilds their daily aggregates.
 */
export const AUTO_REVIEW_CATEGORY_VERSION = 1

/** Queue length that forces an immediate flush. */
const FLUSH_THRESHOLD = 50

/** Hard queue bound; the oldest records are dropped beyond it. */
const MAX_QUEUE = 10000

/**
 * Upper bound on detail rows inspected by one reprice pass. The default
 * retention budget (30 days x 200k rows) stays below this, so a normal upgrade
 * always completes; the cap only guards a pathological ledger and keeps
 * startup bounded. A deferred pass keeps the old fingerprint and retries on the
 * next start (the pass is idempotent).
 */
const MAX_REPRICE_ROWS = 10_000_000

/**
 * Tier-policy literal folded into the pricing fingerprint. Bump it whenever the
 * peak/off-peak rule itself changes, so retained rows are repriced once even if
 * the price table and the off-peak day list are unchanged.
 */
const PRICING_TIER_POLICY = 'tier-v1'

/**
 * Fingerprint the effective pricing policy: the price table, the extra
 * all-day off-peak dates, and the tier-policy version.
 *
 * The exact JSON text (array order included) is hashed, so any change to an
 * entry, its order, an added/removed row, or the off-peak day list triggers one
 * reprice pass over the retained detail rows. `meta.pricingFingerprint` stores
 * this value. The second argument defaults to `[]`, so callers that only pass a
 * price table still work (their fingerprint intentionally differs from the
 * pre-tier value, which makes the first upgrade reprice old rows once).
 * @param {unknown} pricing - normalized `config.pricing`.
 * @param {unknown} [offPeakDays] - normalized `config.pricingOffPeakDays`.
 * @returns {string} SHA-1 hex fingerprint of the hashed policy input.
 */
export function pricingFingerprint(pricing, offPeakDays = []) {
  let serialized
  try {
    const text = JSON.stringify([
      Array.isArray(pricing) ? pricing : [],
      Array.isArray(offPeakDays) ? offPeakDays : [],
      PRICING_TIER_POLICY,
    ])
    if (typeof text === 'string') serialized = text
  } catch {
    // Circular or otherwise unserializable input: fall back to an empty policy.
  }
  return sha1(serialized ?? `[[],[],"${PRICING_TIER_POLICY}"]`)
}

/**
 * Create an empty daily aggregate.
 * @param {string} day - `YYYY-MM-DD` day key.
 * @returns {object} empty aggregate.
 */
export function createDayAggregate(day) {
  return {
    v: 1,
    day,
    schemaVersion: SCHEMA_VERSION,
    costSchemaVersion: COST_SCHEMA_VERSION,
    totals: {
      promptTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      measuredPromptTokens: 0,
      measuredOutputTokens: 0,
      estimatedPromptTokens: 0,
      estimatedOutputTokens: 0,
      requests: 0,
      attempts: 0,
      estimatedRequests: 0,
      measuredRequests: 0,
    },
    byPurpose: {},
    byCategory: {},
    // Stable coarse groups derived from `byCategory` (memory, skill, system,
    // tool-result, reasoning, ...) so the panel can show one bar per concept.
    byCategoryGroup: {},
    byToolGroup: {},
    bySession: {},
    byModel: {},
    byHour: {},
    cache: { input: 0, read: 0, write: 0 },
    cost: { amount: 0, priced: false, unpricedRequests: 0, currency: 'CNY' },
    // Per-currency breakdown introduced in M2. A null prototype keeps a
    // configured currency named like an Object built-in from polluting it.
    costByCurrency: Object.create(null),
    requestCount: 0,
    attemptCount: 0,
  }
}

/**
 * Web API tool kinds whose observed outcomes are counted in `webapi/` files.
 * `web_search` maps to `search`, `web_fetch` to `fetch`.
 */
export const WEB_API_TOOLS = Object.freeze(['search', 'fetch'])

/** Maximum distinct session buckets kept in one day's web API file. */
export const MAX_WEB_API_SESSIONS = 500

/** Maximum per-session rows returned by `readWebApi` and `summary.webApi`. */
export const MAX_WEB_API_SESSION_ROWS = 100

/**
 * Session bucket used when the calling session is unknown, or when the day's
 * bounded session map is full.
 */
const UNKNOWN_WEB_API_SESSION = 'unknown'

/**
 * Create empty per-session web API counters for the persisted day file.
 * @returns {{search: {ok: number, failed: number}, fetch: {ok: number, failed: number}}} empty session counters.
 */
function createWebApiSession() {
  return {
    search: { ok: 0, failed: 0 },
    fetch: { ok: 0, failed: 0 },
  }
}

/**
 * Create an empty per-day web API counter file value.
 *
 * `sessions` is optional when reading (M2.4 files do not carry it). The map
 * keeps a bounded per-session breakdown and uses a null prototype so a session
 * id such as `__proto__` can never mutate it.
 * @param {string} day - `YYYY-MM-DD` day key.
 * @returns {{v: number, day: string, search: {ok: number, failed: number}, fetch: {ok: number, failed: number}, sessions: Record<string, {search: {ok: number, failed: number}, fetch: {ok: number, failed: number}}>}} empty counters.
 */
export function createWebApiDay(day) {
  return {
    v: 1,
    day,
    search: { ok: 0, failed: 0 },
    fetch: { ok: 0, failed: 0 },
    sessions: Object.create(null),
  }
}

/**
 * Derive the safe session bucket key for one observed call.
 * @param {unknown} value - raw `sessionId` supplied by the observer.
 * @returns {string} trimmed non-empty session id, or `unknown`.
 */
function webApiSessionKey(value) {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed.length > 0 ? trimmed : UNKNOWN_WEB_API_SESSION
}

/**
 * Resolve (and when needed create) the session bucket for a call.
 *
 * The day map keeps at most `MAX_WEB_API_SESSIONS` keys. One slot is reserved
 * for the `unknown` overflow bucket, so a day stores at most
 * `MAX_WEB_API_SESSIONS - 1` distinct named sessions and redirecting an
 * overflowing new session can never create a 501st key.
 * @param {Record<string, object>} sessions - day session map (mutated).
 * @param {string} requested - derived session key.
 * @returns {{key: string, overflowed: boolean}} target bucket key.
 */
function resolveWebApiSessionBucket(sessions, requested) {
  if (sessions[requested] !== undefined) return { key: requested, overflowed: false }
  const limit = requested === UNKNOWN_WEB_API_SESSION ? MAX_WEB_API_SESSIONS : MAX_WEB_API_SESSIONS - 1
  const overflowed = Object.keys(sessions).length >= limit
  const key = overflowed ? UNKNOWN_WEB_API_SESSION : requested
  if (sessions[key] === undefined) sessions[key] = createWebApiSession()
  return { key, overflowed }
}

/**
 * Create empty public web API counters.
 * @returns {{search: {ok: number, failed: number, total: number}, fetch: {ok: number, failed: number, total: number}, calls: {ok: number, failed: number, total: number}}} empty counters.
 */
function emptyWebApiCounters() {
  return {
    search: { ok: 0, failed: 0, total: 0 },
    fetch: { ok: 0, failed: 0, total: 0 },
    calls: { ok: 0, failed: 0, total: 0 },
  }
}

/**
 * Create an empty public web API summary block.
 * @param {string} currency - configured currency label.
 * @returns {{search: {ok: number, failed: number, total: number}, fetch: {ok: number, failed: number, total: number}, calls: {ok: number, failed: number, total: number}, bySession: object[], unattributed: {search: {ok: number, failed: number, total: number}, fetch: {ok: number, failed: number, total: number}, calls: {ok: number, failed: number, total: number}, cost: {amount: number, currency: string, priced: boolean}}, cost: {amount: number, currency: string, priced: boolean}}} empty block.
 */
function emptyWebApiSummary(currency) {
  return {
    ...emptyWebApiCounters(),
    bySession: [],
    unattributed: {
      ...emptyWebApiCounters(),
      cost: { amount: 0, currency, priced: false },
    },
    cost: { amount: 0, currency, priced: false },
  }
}

/**
 * Coerce a value to a finite non-negative number.
 * @param {unknown} value - candidate.
 * @returns {number} safe number.
 */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** Currency assumed when a record or aggregate does not carry one. */
const DEFAULT_CURRENCY = 'CNY'

/**
 * Coerce a currency label to a safe non-empty key.
 * @param {unknown} value - candidate currency.
 * @returns {string} accepted currency, or `CNY` when absent.
 */
function currencyKey(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 32 ? value : DEFAULT_CURRENCY
}

/**
 * List the own entries of an object map; empty for any other value.
 * @param {unknown} value - candidate map.
 * @returns {Array<[string, unknown]>} own entries.
 */
function mapEntries(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.entries(value)
}

/**
 * Create an empty per-currency cost tally.
 * @returns {{byCurrency: Record<string, {amount: number, priced: boolean, unpricedRequests: number}>}} tally.
 */
function createCostTally() {
  return { byCurrency: Object.create(null) }
}

/**
 * Add one request's cost block to a per-currency tally. Only priced requests
 * contribute an amount; every unpriced request is counted against its currency.
 * @param {{byCurrency: Record<string, object>}} tally - target tally.
 * @param {{amount?: number, priced?: boolean, currency?: string}|null} cost - record cost block.
 * @returns {{byCurrency: Record<string, object>}} the same tally.
 */
function addRecordCostToTally(tally, cost) {
  const currency = currencyKey(cost?.currency)
  const target = tally.byCurrency[currency] ??= { amount: 0, priced: false, unpricedRequests: 0 }
  if (cost?.priced === true) {
    target.amount += num(cost.amount)
    target.priced = true
  } else {
    target.unpricedRequests += 1
  }
  return tally
}

/**
 * Merge a flat aggregate cost block into a per-currency tally. Empty blocks are
 * ignored so an untouched entity does not invent a currency entry.
 * @param {{byCurrency: Record<string, object>}} tally - target tally.
 * @param {unknown} cost - flat `{amount, priced, unpricedRequests, currency}` block.
 * @returns {{byCurrency: Record<string, object>}} the same tally.
 */
function mergeFlatCostToTally(tally, cost) {
  if (cost === null || typeof cost !== 'object') return tally
  const amount = num(cost.amount)
  const unpricedRequests = num(cost.unpricedRequests)
  if (!(amount > 0 || cost.priced === true || unpricedRequests > 0)) return tally
  const currency = currencyKey(cost.currency)
  const target = tally.byCurrency[currency] ??= { amount: 0, priced: false, unpricedRequests: 0 }
  target.amount += amount
  target.priced = target.priced || cost.priced === true
  target.unpricedRequests += unpricedRequests
  return tally
}

/**
 * Merge a persisted per-currency map into a tally, falling back to the flat
 * cost block for daily files written before M2.
 * @param {{byCurrency: Record<string, object>}} tally - target tally.
 * @param {unknown} byCurrency - persisted per-currency map.
 * @param {unknown} cost - flat fallback cost block.
 * @returns {{byCurrency: Record<string, object>}} the same tally.
 */
function mergeAggregateCostToTally(tally, byCurrency, cost) {
  let merged = false
  for (const [currency, entry] of mapEntries(byCurrency)) {
    if (entry === null || typeof entry !== 'object') continue
    const target = tally.byCurrency[currencyKey(currency)] ??= { amount: 0, priced: false, unpricedRequests: 0 }
    target.amount += num(entry.amount)
    target.priced = target.priced || entry.priced === true
    target.unpricedRequests += num(entry.unpricedRequests)
    merged = true
  }
  if (!merged) mergeFlatCostToTally(tally, cost)
  return tally
}

/**
 * Finalize a tally into the public cost block.
 *
 * A single currency sums normally. With more than one currency the amount is
 * deliberately reported as 0 and `currency` as `'mixed'`: adding CNY and USD
 * numbers would be meaningless. The per-currency breakdown remains available
 * on `summary.totals.costByCurrency`.
 * @param {{byCurrency: Record<string, object>}} tally - cost tally.
 * @returns {{amount: number, currency: string, priced: boolean, unpricedRequests: number}} cost block.
 */
function finalizeCost(tally) {
  const currencies = Object.keys(tally.byCurrency).sort()
  let amount = 0
  let priced = false
  let unpricedRequests = 0
  for (const currency of currencies) {
    const entry = tally.byCurrency[currency]
    amount += num(entry.amount)
    priced = priced || entry.priced === true
    unpricedRequests += num(entry.unpricedRequests)
  }
  if (currencies.length === 1) {
    return { amount: round(amount, 6), currency: currencies[0], priced, unpricedRequests }
  }
  if (currencies.length === 0) {
    return { amount: 0, currency: DEFAULT_CURRENCY, priced, unpricedRequests }
  }
  return { amount: 0, currency: 'mixed', priced, unpricedRequests }
}

/**
 * Render a tally as the public `costByCurrency` map, sorted by currency.
 * @param {{byCurrency: Record<string, object>}} tally - cost tally.
 * @returns {Record<string, {amount: number, priced: boolean, unpricedRequests: number}>} plain map.
 */
function costByCurrencyValue(tally) {
  return Object.fromEntries(Object.keys(tally.byCurrency).sort().map(currency => {
    const entry = tally.byCurrency[currency]
    return [currency, {
      amount: round(num(entry.amount), 6),
      priced: entry.priced === true,
      unpricedRequests: num(entry.unpricedRequests),
    }]
  }))
}

/**
 * Get the per-currency tally stored inside an aggregate entity entry. Older
 * daily files have no tally; seed it once from their flat cost block.
 * @param {object} entry - byPurpose/bySession/byModel entry.
 * @returns {{byCurrency: Record<string, object>}} entry tally.
 */
function entryCostTally(entry) {
  if (entry.costByCurrency === null
    || typeof entry.costByCurrency !== 'object'
    || Object.getPrototypeOf(entry.costByCurrency) !== null) {
    const tally = createCostTally()
    mergeAggregateCostToTally(tally, entry.costByCurrency, entry.cost)
    entry.costByCurrency = tally.byCurrency
  }
  return { byCurrency: entry.costByCurrency }
}

/**
 * Get the per-currency tally of a daily aggregate, rebuilding it from the flat
 * cost block when a caller supplied an unnormalized aggregate.
 * @param {object} aggregate - daily aggregate.
 * @returns {{byCurrency: Record<string, object>}} aggregate tally.
 */
function aggregateCostTally(aggregate) {
  if (aggregate.costByCurrency === null
    || typeof aggregate.costByCurrency !== 'object'
    || Object.getPrototypeOf(aggregate.costByCurrency) !== null) {
    const tally = createCostTally()
    mergeAggregateCostToTally(tally, aggregate.costByCurrency, aggregate.cost)
    aggregate.costByCurrency = tally.byCurrency
  }
  return { byCurrency: aggregate.costByCurrency }
}

/**
 * Merge one aggregate entity's cost into a summary tally.
 * @param {{byCurrency: Record<string, object>}} tally - target tally.
 * @param {object} entry - aggregate entity entry.
 * @returns {{byCurrency: Record<string, object>}} the same tally.
 */
function mergeEntityCostToTally(tally, entry) {
  return mergeAggregateCostToTally(tally, entry?.costByCurrency, entry?.cost)
}

/**
 * Add one request record to a daily aggregate (in place, in memory).
 * @param {object} aggregate - aggregate to update.
 * @param {object} record - v1 request record.
 * @returns {object} the same aggregate.
 */
export function addRecordToAggregate(aggregate, record) {
  if (aggregate === null || typeof aggregate !== 'object' || record === null || typeof record !== 'object') {
    return aggregate
  }
  const promptTokens = num(record.promptTokens)
  const outputTokens = num(record.outputTokens)
  const estimated = record.usageEstimated === true
  aggregate.totals.promptTokens += promptTokens
  aggregate.totals.outputTokens += outputTokens
  aggregate.totals.totalTokens += promptTokens + outputTokens
  if (estimated) {
    aggregate.totals.estimatedPromptTokens += promptTokens
    aggregate.totals.estimatedOutputTokens += outputTokens
    aggregate.totals.estimatedRequests += 1
  } else {
    aggregate.totals.measuredPromptTokens += promptTokens
    aggregate.totals.measuredOutputTokens += outputTokens
    aggregate.totals.measuredRequests += 1
  }
  aggregate.totals.requests += 1
  aggregate.totals.attempts += 1
  aggregate.requestCount += 1
  aggregate.attemptCount += 1

  const purpose = typeof record.purpose === 'string' && record.purpose.length > 0 ? record.purpose : 'chat'
  const purposeEntry = aggregate.byPurpose[purpose] ??= { requests: 0, promptTokens: 0, outputTokens: 0 }
  purposeEntry.requests += 1
  purposeEntry.promptTokens += promptTokens
  purposeEntry.outputTokens += outputTokens

  const categories = record.categories !== null && typeof record.categories === 'object' ? record.categories : {}
  const categoryGroups = aggregate.byCategoryGroup ??= {}
  for (const [category, tokens] of Object.entries(categories)) {
    if (!Number.isFinite(tokens) || tokens <= 0) continue
    aggregate.byCategory[category] = (aggregate.byCategory[category] ?? 0) + tokens
    const group = categoryToolGroup(category)
    if (group !== null) aggregate.byToolGroup[group] = (aggregate.byToolGroup[group] ?? 0) + tokens
    const categoryGroupKey = categoryGroup(category)
    categoryGroups[categoryGroupKey] = (categoryGroups[categoryGroupKey] ?? 0) + tokens
  }

  const usage = record.usage !== null && typeof record.usage === 'object' ? record.usage : null
  const sessionId = typeof record.sessionId === 'string' && record.sessionId.length > 0 ? record.sessionId : 'unknown'
  const sessionEntry = aggregate.bySession[sessionId] ??= {
    sessionId,
    parentSessionId: typeof record.parentSessionId === 'string' ? record.parentSessionId : null,
    depth: Number.isInteger(record.delegationDepth) ? record.delegationDepth : 0,
    promptTokens: 0,
    outputTokens: 0,
    requests: 0,
    // Absolute measured cache buckets: `prompt = input + read + write`.
    // Estimated records carry no measured usage and stay at 0.
    cache: { input: 0, read: 0, write: 0 },
  }
  sessionEntry.promptTokens += promptTokens
  sessionEntry.outputTokens += outputTokens
  sessionEntry.requests += 1
  if (usage !== null) {
    const sessionCache = sessionEntry.cache ??= { input: 0, read: 0, write: 0 }
    sessionCache.input += num(usage.input)
    sessionCache.read += num(usage.cacheRead)
    sessionCache.write += num(usage.cacheWrite)
    aggregate.cache.input += num(usage.input)
    aggregate.cache.read += num(usage.cacheRead)
    aggregate.cache.write += num(usage.cacheWrite)
  }

  const provider = typeof record.provider === 'string' ? record.provider : 'unknown'
  const model = typeof record.model === 'string' ? record.model : 'unknown'
  const modelKey = `${provider}/${model}`
  const modelEntry = aggregate.byModel[modelKey] ??= { provider, model, requests: 0, promptTokens: 0, outputTokens: 0 }
  modelEntry.requests += 1
  modelEntry.promptTokens += promptTokens
  modelEntry.outputTokens += outputTokens

  const ts = typeof record.ts === 'number' && Number.isFinite(record.ts) ? record.ts : nowMs()
  const hour = String(new Date(ts).getHours())
  const hourEntry = aggregate.byHour[hour] ??= { requests: 0, promptTokens: 0, outputTokens: 0 }
  hourEntry.requests += 1
  hourEntry.promptTokens += promptTokens
  hourEntry.outputTokens += outputTokens

  // Cost is accumulated per purpose/session/model and at the aggregate level.
  // Only `priced:true` entries contribute money; every unpriced request is
  // counted so the panel can say how many calls have no configured price.
  const cost = record.cost !== null && typeof record.cost === 'object'
    ? record.cost
    : { amount: 0, priced: false, currency: DEFAULT_CURRENCY }
  for (const entry of [purposeEntry, sessionEntry, modelEntry]) {
    const tally = entryCostTally(entry)
    addRecordCostToTally(tally, cost)
    entry.cost = finalizeCost(tally)
  }
  const aggregateTally = aggregateCostTally(aggregate)
  addRecordCostToTally(aggregateTally, cost)
  aggregate.cost = finalizeCost(aggregateTally)
  // Every aggregate that has seen an M2 record carries the per-entity cost
  // schema from now on, so a later daily write upgrades the persisted file.
  aggregate.costSchemaVersion = COST_SCHEMA_VERSION
  return aggregate
}

/**
 * Normalize one aggregate entity entry, filling the cost fields added in M2.
 * @param {unknown} value - persisted entry.
 * @param {'purpose'|'session'|'model'} kind - entry kind.
 * @returns {object} normalized entry.
 */
function normalizeEntityEntry(value, kind) {
  const source = value !== null && typeof value === 'object' ? value : {}
  const tally = createCostTally()
  mergeAggregateCostToTally(tally, source.costByCurrency, source.cost)
  const entry = {
    ...source,
    cost: finalizeCost(tally),
    costByCurrency: tally.byCurrency,
  }
  if (kind === 'purpose') {
    entry.requests = num(source.requests)
    entry.promptTokens = num(source.promptTokens)
    entry.outputTokens = num(source.outputTokens)
  } else if (kind === 'session') {
    entry.sessionId = typeof source.sessionId === 'string' ? source.sessionId : ''
    entry.parentSessionId = typeof source.parentSessionId === 'string' ? source.parentSessionId : null
    entry.depth = Number.isInteger(source.depth) ? source.depth : 0
    entry.promptTokens = num(source.promptTokens)
    entry.outputTokens = num(source.outputTokens)
    entry.requests = num(source.requests)
    // Daily files written before the session-cache counters existed normalize
    // to zero; a detail replay fills them again when the rows are still retained.
    const cache = source.cache !== null && typeof source.cache === 'object' ? source.cache : {}
    entry.cache = { input: num(cache.input), read: num(cache.read), write: num(cache.write) }
  } else {
    entry.provider = typeof source.provider === 'string' ? source.provider : 'unknown'
    entry.model = typeof source.model === 'string' ? source.model : 'unknown'
    entry.requests = num(source.requests)
    entry.promptTokens = num(source.promptTokens)
    entry.outputTokens = num(source.outputTokens)
  }
  return entry
}

/**
 * Fill missing aggregate fields from an older or partial daily file.
 * @param {object | null} value - parsed daily file.
 * @param {string} day - day key.
 * @returns {object} complete aggregate.
 */
function normalizeAggregate(value, day) {
  const aggregate = createDayAggregate(day)
  if (value === null || typeof value !== 'object') return aggregate
  const totals = value.totals !== null && typeof value.totals === 'object' ? value.totals : {}
  for (const key of Object.keys(aggregate.totals)) aggregate.totals[key] = num(totals[key])
  for (const [purpose, entry] of mapEntries(value.byPurpose)) {
    aggregate.byPurpose[purpose] = normalizeEntityEntry(entry, 'purpose')
  }
  for (const [sessionId, entry] of mapEntries(value.bySession)) {
    const normalized = normalizeEntityEntry(entry, 'session')
    if (normalized.sessionId.length === 0) normalized.sessionId = sessionId
    aggregate.bySession[sessionId] = normalized
  }
  for (const [modelKey, entry] of mapEntries(value.byModel)) {
    aggregate.byModel[modelKey] = normalizeEntityEntry(entry, 'model')
  }
  for (const key of ['byCategory', 'byToolGroup', 'byHour']) {
    if (value[key] !== null && typeof value[key] === 'object' && !Array.isArray(value[key])) {
      aggregate[key] = { ...value[key] }
    }
  }
  // `byCategory` is authoritative: rebuild the coarse groups from it so daily
  // files written before `byCategoryGroup` existed (or with an older mapping)
  // read correctly without a schema bump. A persisted copy is not trusted.
  aggregate.byCategoryGroup = {}
  for (const [category, tokens] of mapEntries(aggregate.byCategory)) {
    const value = num(tokens)
    if (value <= 0) continue
    const group = categoryGroup(category)
    aggregate.byCategoryGroup[group] = (aggregate.byCategoryGroup[group] ?? 0) + value
  }
  const cache = value.cache !== null && typeof value.cache === 'object' ? value.cache : {}
  aggregate.cache = { input: num(cache.input), read: num(cache.read), write: num(cache.write) }
  // Daily files written before M2 only carry the flat `cost` block; seed the
  // per-currency tally from it so old and new files read the same way.
  const tally = createCostTally()
  mergeAggregateCostToTally(tally, value.costByCurrency, value.cost)
  aggregate.costByCurrency = tally.byCurrency
  aggregate.cost = finalizeCost(tally)
  aggregate.costSchemaVersion = Number.isInteger(value.costSchemaVersion) ? value.costSchemaVersion : 0
  aggregate.requestCount = num(value.requestCount)
  aggregate.attemptCount = num(value.attemptCount)
  return aggregate
}

/**
 * Whether a pid is currently alive.
 * @param {number} pid - process id.
 * @returns {boolean} true when the process exists (or cannot be probed for permissions).
 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * List directory entries without throwing.
 * @param {string} dir - directory path.
 * @returns {string[]} entry names.
 */
function readdirSafe(dir) {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * Sleep synchronously for a few milliseconds without a timer.
 * @param {number} ms - milliseconds to wait.
 * @returns {void}
 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    // A platform that forbids Atomics.wait simply skips the retry delay.
  }
}

/**
 * Stat a file without throwing.
 * @param {string} file - file path.
 * @returns {fs.Stats | null} stats, or null when unavailable.
 */
function statSafe(file) {
  try {
    return fs.statSync(file)
  } catch {
    return null
  }
}

/**
 * Create the ledger store.
 *
 * Resolution order for the home directory is explicit `homeDir`, then
 * `DSH_HOME`, then `~/.dsh`; for the profile, explicit `profile`, then
 * `DSH_PROFILE`, then `default`. Tests pass both explicitly so they never touch
 * a real profile.
 *
 * @param {object} options - store inputs.
 * @param {object} [options.ctx] - Cordis context (registers the flush timer effect).
 * @param {object} options.config - normalized plugin config.
 * @param {(message: string) => void} [options.diag] - diagnostic sink.
 * @param {object} [options.logger] - host logger (unused; diagnostics route through `diag`).
 * @param {string} [options.homeDir] - override for `DSH_HOME`.
 * @param {string} [options.profile] - override for `DSH_PROFILE`.
 * @returns {object} store API (`append`, `flushNow`, `dispose`, `readSummary`, `readRequests`, `readMeta`, `recordWebApiCall`, `readWebApi`, `migrationStatus`, `getState`).
 */
export function createStore({ ctx, config, diag, logger: _logger, homeDir, profile, profileSource }) {
  const report = (message) => {
    try {
      diag?.(message)
    } catch {
      // Diagnostics must never break collection.
    }
  }
  const dshHome = typeof homeDir === 'string' && homeDir.length > 0
    ? homeDir
    : (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
      ? process.env.DSH_HOME
      : path.join(os.homedir(), '.dsh'))
  const profileName = typeof profile === 'string' && profile.length > 0
    ? profile
    : (typeof process.env.DSH_PROFILE === 'string' && process.env.DSH_PROFILE.length > 0
      ? process.env.DSH_PROFILE
      : 'default')

  // A store is created before any Config guarantee is re-checked; keep every
  // tunable inside its accepted range so a hand-built store never prunes
  // everything or busy-loops its timer.
  const retentionDays = (value, fallback) => (Number.isInteger(value) && value > 0 ? value : fallback)
  const requestRetention = retentionDays(config?.retainRequestDays, 30)
  const dailyRetention = retentionDays(config?.retainDailyDays, 365)
  const flushInterval = Number.isInteger(config?.flushIntervalMs)
    ? Math.min(60000, Math.max(500, config.flushIntervalMs))
    : 5000
  /** Effective price table (missing/invalid config means "pricing disabled"). */
  const pricing = Array.isArray(config?.pricing) ? config.pricing : []
  /** Extra all-day off-peak dates applied to every reprice pass. */
  const offPeakDays = Array.isArray(config?.pricingOffPeakDays) ? config.pricingOffPeakDays : []
  /** Effective web API price estimate; a hand-built config still keeps valid numbers. */
  const webApiPrice = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : fallback)
  const webApiPricing = {
    searchPerThousand: webApiPrice(config?.webApiPricing?.searchPerThousand, DEFAULT_WEB_API_PRICING.searchPerThousand),
    fetchPerThousand: webApiPrice(config?.webApiPricing?.fetchPerThousand, DEFAULT_WEB_API_PRICING.fetchPerThousand),
    currency: typeof config?.webApiPricing?.currency === 'string' && config.webApiPricing.currency.length > 0
      ? config.webApiPricing.currency
      : DEFAULT_WEB_API_PRICING.currency,
  }

  const stateRoot = path.join(dshHome, 'token-attribution', 'state', profileName)
  const defaultDataRoot = path.join(dshHome, 'token-attribution', 'data', profileName)
  const configuredDataRoot = typeof config?.dataDir === 'string' && config.dataDir.length > 0
    ? path.resolve(config.dataDir)
    : path.resolve(defaultDataRoot)
  const pointerPath = path.join(stateRoot, 'pointer.json')
  const lockPath = path.join(stateRoot, 'lock')

  ensureDir(stateRoot)
  const pointerExists = fs.existsSync(pointerPath)
  const pointer = readJsonFile(pointerPath)
  const pointerCorrupt = pointerExists && pointer === null
  const pointerDataRoot = pointer !== null && typeof pointer === 'object' && typeof pointer.dataRoot === 'string'
    ? path.resolve(pointer.dataRoot)
    : null
  // Windows path comparison: only-case differences are the same directory.
  const pointerDiffers = pointerDataRoot !== null && !samePath(pointerDataRoot, configuredDataRoot)

  /**
   * Acquire the per-profile state lock with an exclusive create, so two
   * simultaneous starters cannot both claim it. A stale (dead pid) or own-pid
   * lock is replaced; a live foreign lock is left in place.
   * @returns {boolean} true when this process owns the lock.
   */
  function acquireStateLock() {
    const payload = JSON.stringify({ pid: process.pid, startedAt: nowMs() })
    try {
      const fd = fs.openSync(lockPath, 'wx')
      try {
        fs.writeFileSync(fd, payload, 'utf8')
      } finally {
        fs.closeSync(fd)
      }
      return true
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = readJsonFile(lockPath)
      if (current !== null && typeof current === 'object' && Number.isInteger(current.pid)) {
        if (current.pid === process.pid || !isProcessAlive(current.pid)) {
          atomicWriteFileSync(lockPath, payload)
          return true
        }
        return false
      }
      sleepSync(20)
    }
    // Unparsable lock content is residue from a crashed writer; replace it.
    try {
      fs.rmSync(lockPath, { force: true })
    } catch {
      // Best-effort cleanup before retrying the exclusive create.
    }
    atomicWriteFileSync(lockPath, payload)
    return true
  }

  let readOnly = false
  let ownsLock = false
  try {
    ownsLock = acquireStateLock()
    if (!ownsLock) {
      readOnly = true
      report(`ledger lock held by a live process; running read-only for "${stateRoot}"`)
    }
  } catch (error) {
    readOnly = true
    report(`cannot write ledger lock (${error instanceof Error ? error.message : String(error)}); running read-only`)
  }
  if (pointerCorrupt) readOnly = true
  if (pointerCorrupt) {
    report(`pointer.json exists but cannot be parsed; refusing to overwrite it and running read-only for "${stateRoot}"`)
  }

  // Resolve the effective root after the lock is held: migration must be the
  // only writer and must finish before the collector exists. Any failure keeps
  // the pointer root authoritative and collection continues there.
  let migrationState = readMigrationState(stateRoot)
  let migrationAttempted = false
  let migrationAttemptStatus = null
  let adopted = false
  let dataRoot = pointerDataRoot ?? configuredDataRoot
  let pointerStatus = pointerCorrupt ? 'corrupt' : 'ok'
  let pointerWritten = false

  if (!readOnly) {
    try {
      const migration = runMigration({
        dshHome,
        stateRoot,
        pointerPath,
        configuredDataRoot,
        profile: profileName,
        report,
        now: nowMs,
      })
      migrationAttempted = migration.attempted === true
      adopted = migration.adopted === true
      pointerWritten = migration.pointerWritten === true
      if (migration.state !== null) migrationState = migration.state
      if (typeof migration.dataRoot === 'string' && migration.dataRoot.length > 0) dataRoot = migration.dataRoot
      if (migrationAttempted) {
        migrationAttemptStatus = migration.status
        if (migration.status === 'failed') {
          pointerStatus = 'requires-migration'
          report(`data directory migration failed; continuing with "${dataRoot}" (see migration.json)`)
        }
      } else if (pointerDiffers) {
        // Defensive: runMigration normally attempts every pointer mismatch.
        pointerStatus = 'requires-migration'
        report(`data directory differs from the pointer; continuing with "${dataRoot}"`)
      }
    } catch (error) {
      report(`data directory migration crashed (${error instanceof Error ? error.message : String(error)}); continuing with "${dataRoot}"`)
    }
  } else if (pointerDiffers) {
    pointerStatus = 'requires-migration'
    report(`data directory migration deferred: the ledger lock is held by another process; using "${dataRoot}"`)
  }

  /**
   * Effective migration status for RPC/meta/summary surfaces.
   *
   * A status recorded by this startup's attempt wins; otherwise the persisted
   * state file describes the last attempt. A failed attempt aimed at the current
   * configuration stays visible; a failure whose target is no longer configured
   * is stale and reports `ok`.
   * @returns {'ok'|'adopted'|'migrating'|'failed'|'requires-migration'} status.
   */
  function effectiveMigrationStatus() {
    if (migrationAttempted) return migrationAttemptStatus ?? 'failed'
    if (pointerCorrupt) return 'failed'
    const currentRoot = pointerDataRoot ?? dataRoot
    const consistent = samePath(currentRoot, configuredDataRoot)
    if (migrationState !== null) {
      switch (migrationState.status) {
        case 'adopted':
          return 'adopted'
        case 'failed':
          return migrationState.to !== null && samePath(migrationState.to, configuredDataRoot) ? 'failed' : 'ok'
        case 'migrating':
          // A crash left a `migrating` marker; the pointer was never switched, so
          // retrying through the normal mismatch path is the next step.
          return consistent ? 'ok' : 'requires-migration'
        case 'ok':
          return consistent ? 'ok' : 'requires-migration'
        default:
          break
      }
    }
    return consistent ? 'ok' : 'requires-migration'
  }

  /**
   * Human-readable migration note for the status payload.
   * @param {string} status - effective status.
   * @returns {string} note.
   */
  function migrationNote(status) {
    const state = migrationState
    switch (status) {
      case 'adopted':
        return state?.from
          ? `adopted the legacy default-profile ledger from "${state.from}"; the default directories are kept as a backup`
          : 'adopted the legacy default-profile ledger'
      case 'failed':
        return state?.error
          ? `migration failed: ${state.error}; continuing with "${dataRoot}"`
          : `data directory migration failed; continuing with "${dataRoot}"`
      case 'requires-migration':
        return `data directory migration is pending; using "${dataRoot}"`
      default:
        return 'data directory matches the configuration'
    }
  }

  /**
   * Migration status for `migration.status`, `meta`, and `summary.data`.
   * @returns {{currentDataDir: string, configuredDataDir: string, status: string, note: string, migration: object|null, from: string|null, to: string|null, startedAt: number|null, finishedAt: number|null, error: string|null, backup: string|null, backupDays: number, maxBytes: number}} status payload.
   */
  function migrationStatus() {
    const status = effectiveMigrationStatus()
    const state = migrationState
    return {
      currentDataDir: dataRoot,
      configuredDataDir: configuredDataRoot,
      status,
      note: migrationNote(status),
      migration: state,
      from: state?.from ?? null,
      to: state?.to ?? null,
      startedAt: state?.startedAt ?? null,
      finishedAt: state?.finishedAt ?? null,
      error: state?.error ?? null,
      backup: state?.backup ?? null,
      backupDays: MIGRATION_BACKUP_DAYS,
      maxBytes: MIGRATION_MAX_BYTES,
    }
  }

  const requestsDir = path.join(dataRoot, 'requests')
  const dailyDir = path.join(dataRoot, 'daily')
  // Web API call counters live in their own per-day files, outside the request
  // JSONL and the daily aggregates, so a daily rebuild/reprice never touches
  // them. They follow the daily-aggregate retention window.
  const webApiDir = path.join(dataRoot, 'webapi')
  const metaPath = path.join(dataRoot, 'meta.json')
  if (!readOnly) {
    ensureDir(requestsDir)
    ensureDir(dailyDir)
    ensureDir(webApiDir)
  }

  const requestsPath = day => path.join(requestsDir, `${day}.jsonl`)
  const dailyPath = day => path.join(dailyDir, `${day}.json`)
  const webApiPath = day => path.join(webApiDir, `${day}.json`)

  /**
   * Build a day aggregate from already-parsed records, deduplicating ids.
   * @param {string} day - day key.
   * @param {object[]} records - parsed v1 records.
   * @returns {object} aggregate.
   */
  function aggregateFromRecords(day, records) {
    const aggregate = createDayAggregate(day)
    const seen = new Set()
    for (const record of records) {
      if (record === null || typeof record !== 'object' || record.v !== 1) continue
      const id = typeof record.id === 'string' ? record.id : null
      if (id !== null) {
        if (seen.has(id)) continue
        seen.add(id)
      }
      addRecordToAggregate(aggregate, record)
    }
    return aggregate
  }

  /**
   * Recompute one detail record's cost under the current price table and its
   * own timestamp's peak/off-peak tier.
   *
   * Only a measured usage is priced; a `usageEstimated:true` record stays
   * unpriced (`priceVersion: 'none'`), exactly like a freshly built record.
   * A record without a usable `ts` is priced as peak (the conservative tier).
   * @param {object} record - detail record.
   * @returns {{amount: number, priced: boolean, currency: string, priceVersion: string, tier: 'peak'|'off-peak'}} cost block.
   */
  function repriceRecordCost(record) {
    const measuredUsage = record.usageEstimated !== true
      && record.usage !== null
      && typeof record.usage === 'object'
      && !Array.isArray(record.usage)
    return computeCost({
      pricing,
      provider: typeof record.provider === 'string' && record.provider.length > 0 ? record.provider : 'unknown',
      model: typeof record.model === 'string' && record.model.length > 0 ? record.model : 'unknown',
      usage: measuredUsage
        ? {
          input: num(record.usage.input),
          cacheRead: num(record.usage.cacheRead),
          cacheWrite: num(record.usage.cacheWrite),
          output: num(record.usage.output),
        }
        : null,
      ts: record.ts,
      offPeakDays,
    })
  }

  /**
   * Reprice retained detail days after the pricing fingerprint changed.
   *
   * For every detail file inside the request-retention window: recompute each
   * measured record's `cost` from its own timestamp tier (peak vs off-peak,
   * including `config.pricingOffPeakDays`), atomically rewrite the JSONL only
   * when at least one line changed, then rebuild and (when different) rewrite
   * that day's aggregate so cost, per-session cache counters, and coarse
   * category groups reflect the detail. Days without a detail file are skipped;
   * unparseable lines and estimated records are preserved. A crash or failed
   * write leaves the old fingerprint in meta, so the next start repeats this
   * idempotently. Read-only stores never call this function.
   * @returns {{ok: boolean, scannedDays: number, rewrittenDays: number, changedRecords: number, failures: number}} result.
   */
  function repriceRetainedDays() {
    const today = dayKey(nowMs())
    const cutoff = shiftDays(today, -(requestRetention - 1))
    let scannedDays = 0
    let rewrittenDays = 0
    let changedRecords = 0
    let skippedDays = 0
    let scannedRecords = 0
    let deferred = false
    let failures = 0
    for (const name of readdirSafe(requestsDir)) {
      if (!name.endsWith('.jsonl')) continue
      const day = name.slice(0, 10)
      if (!isValidDayKey(day) || day < cutoff) continue
      const detailFile = path.join(requestsDir, name)
      let text
      try {
        text = fs.readFileSync(detailFile, 'utf8')
      } catch (error) {
        failures += 1
        report(`cannot read ${name} for repricing: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      const lines = text.split('\n')
      if (text.endsWith('\n')) lines.pop()
      if (scannedRecords + lines.length > MAX_REPRICE_ROWS) {
        deferred = true
        report(`pricing reprice hit the ${MAX_REPRICE_ROWS}-row budget; keeping the previous fingerprint so the next start retries`)
        break
      }
      const records = []
      let fileChanged = false
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]
        if (line.length === 0) continue
        let record
        try {
          record = JSON.parse(line)
        } catch {
          continue
        }
        if (record === null || typeof record !== 'object' || Array.isArray(record) || record.v !== 1) continue
        scannedRecords += 1
        records.push(record)
        const nextCost = repriceRecordCost(record)
        if (JSON.stringify(record.cost) === JSON.stringify(nextCost)) continue
        record.cost = nextCost
        lines[index] = JSON.stringify(record)
        fileChanged = true
        changedRecords += 1
      }
      scannedDays += 1
      if (records.length === 0) continue
      if (fileChanged) {
        try {
          // Always terminate rewritten JSONL with a newline so a later append
          // can never concatenate onto a partial line.
          atomicWriteFileSync(detailFile, `${lines.join('\n')}\n`)
          rewrittenDays += 1
        } catch (error) {
          failures += 1
          report(`cannot rewrite ${name} after repricing: ${error instanceof Error ? error.message : String(error)}`)
          continue
        }
      }
      try {
        const aggregate = aggregateFromRecords(day, records)
        const previous = readJsonFile(dailyPath(day))
        const previousRequests = previous !== null && typeof previous === 'object'
          ? num(previous.totals?.requests ?? previous.requestCount)
          : 0
        // Detail thinning is not implemented yet, so a daily aggregate should
        // never hold more requests than its detail replay. If it does, the
        // detail file is partial or damaged; keep the persisted aggregate
        // instead of silently dropping tokens/cost.
        if (previousRequests > num(aggregate.totals.requests)) {
          skippedDays += 1
          report(`daily/${day}.json holds more requests than its detail replay; keeping the persisted aggregate`)
          continue
        }
        const nextText = JSON.stringify(aggregate)
        if (previous === null || JSON.stringify(previous) !== nextText) {
          atomicWriteFileSync(dailyPath(day), nextText)
        }
      } catch (error) {
        failures += 1
        report(`cannot rebuild daily/${day}.json after repricing: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { ok: failures === 0 && !deferred, scannedDays, rewrittenDays, changedRecords, skippedDays, deferred, failures }
  }

  /**
   * One-time migration of legacy auto-review transcript tokens.
   *
   * Before this version an auto-review call replayed the whole conversation as
   * a synthetic user-role message, so the estimator filed it under
   * `categories.user` and the panel showed a tool transcript as human chat.
   * For every retained detail row with `purpose === 'auto-review'` and a
   * positive numeric `categories.user`, this pass moves exactly that amount to
   * `categories['injected:auto-review']` and drops `categories.user`; the token
   * sum, every other category, and every chat/user row stay untouched. A day
   * with a change gets its JSONL rewritten atomically and then its daily
   * aggregate rebuilt from the same records, so the persisted aggregate (newer
   * than the detail, as `loadAggregateFromDisk` expects) matches the detail and
   * `byCategoryGroup` gains the `auto-review` group.
   *
   * The pass is idempotent and gated by `meta.autoReviewCategoryVersion`. A day
   * whose persisted aggregate holds more requests than its parsed detail is
   * skipped, because replaying the partial detail over it would lose tokens the
   * aggregate still counts; skipped days keep the marker unset so a later start
   * retries. A previous run that rewrote detail but crashed before its daily
   * aggregate is repaired from the detail/newer-daily mtime signal. A missing
   * detail file is the normal "no detail retained" case. Unreadable files and
   * write failures are reported and leave the marker unset so the next start
   * retries (per-line malformed rows are preserved verbatim). Daily files older
   * than the request-retention window have no retained detail left to rewrite,
   * so their historical `user` attribution cannot be migrated; they stay as
   * written.
   *
   * @returns {{ok: boolean, scannedDays: number, changedDays: number, changedRecords: number, skippedDays: number, failures: number}} result.
   */
  function migrateAutoReviewCategories() {
    const today = dayKey(nowMs())
    const days = dayKeysBetween(shiftDays(today, -(requestRetention - 1)), today)
    let scannedDays = 0
    let changedDays = 0
    let changedRecords = 0
    let skippedDays = 0
    let failures = 0
    for (const day of days) {
      if (!fs.existsSync(requestsPath(day))) continue
      let text
      try {
        text = fs.readFileSync(requestsPath(day), 'utf8')
      } catch (error) {
        failures += 1
        report(`cannot read ${day}.jsonl for auto-review category migration: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      const lines = text.split('\n')
      if (text.endsWith('\n')) lines.pop()
      const records = []
      let fileChanged = false
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]
        if (line.length === 0) continue
        let record
        try {
          record = JSON.parse(line)
        } catch {
          // Keep the malformed row verbatim; it is not a migratable record.
          continue
        }
        if (record === null || typeof record !== 'object' || Array.isArray(record) || record.v !== 1) continue
        records.push(record)
        if (record.purpose !== 'auto-review') continue
        const categories = record.categories
        if (categories === null || typeof categories !== 'object' || Array.isArray(categories)) continue
        const userTokens = categories.user
        if (typeof userTokens !== 'number' || !Number.isFinite(userTokens) || userTokens <= 0) continue
        const existing = categories['injected:auto-review']
        categories['injected:auto-review'] = (typeof existing === 'number' && Number.isFinite(existing) ? existing : 0) + userTokens
        delete categories.user
        lines[index] = JSON.stringify(record)
        fileChanged = true
        changedRecords += 1
      }
      scannedDays += 1
      const rebuilt = aggregateFromRecords(day, records)
      // A previous run may have rewritten the detail and then crashed before its
      // daily aggregate; detail mtime newer than daily is the repair signal.
      const hasMigrated = records.some(record => record?.purpose === 'auto-review'
        && typeof record.categories?.['injected:auto-review'] === 'number'
        && record.categories['injected:auto-review'] > 0)
      const detailStat = statSafe(requestsPath(day))
      const dailyStat = statSafe(dailyPath(day))
      const dailyStale = dailyStat === null
        || (detailStat !== null && dailyStat.mtimeMs < detailStat.mtimeMs)
      const dailyNeedsRebuild = fileChanged || (hasMigrated && dailyStale)
      if (!dailyNeedsRebuild) continue
      // Partial-detail guard: the persisted aggregate may summarize requests
      // that are no longer in the JSONL (restored/truncated detail). Rebuilding
      // it from the partial replay would drop tokens it already counts.
      const previous = readJsonFile(dailyPath(day))
      const previousRequests = previous !== null && typeof previous === 'object'
        ? num(previous.totals?.requests ?? previous.requestCount)
        : 0
      if (previousRequests > num(rebuilt.totals.requests)) {
        skippedDays += 1
        report(`auto-review category migration skipped ${day}: its daily aggregate holds more requests than the partial detail`)
        continue
      }
      if (fileChanged) {
        try {
          // One record per line plus a trailing newline, exactly like a flush, so
          // a later append can never concatenate onto a partial line.
          atomicWriteFileSync(requestsPath(day), `${lines.join('\n')}\n`)
        } catch (error) {
          failures += 1
          report(`cannot rewrite ${day}.jsonl for auto-review category migration: ${error instanceof Error ? error.message : String(error)}`)
          continue
        }
      }
      try {
        atomicWriteFileSync(dailyPath(day), JSON.stringify(rebuilt))
        changedDays += 1
      } catch (error) {
        failures += 1
        report(`cannot rebuild daily/${day}.json after auto-review category migration: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { ok: failures === 0, scannedDays, changedDays, changedRecords, skippedDays, failures }
  }

  const effectiveProfileSource = adopted
    ? 'adopted-legacy-default'
    : (typeof profileSource === 'string' ? profileSource : 'fallback')
  const existingMeta = readJsonFile(metaPath)
  const existingMetaValid = existingMeta !== null && typeof existingMeta === 'object' && existingMeta.v === 1
  const previousMetaText = existingMetaValid ? JSON.stringify(existingMeta) : null
  let meta
  if (!existingMetaValid) {
    meta = {
      v: 1,
      schemaVersion: SCHEMA_VERSION,
      createdAt: nowMs(),
      installedVersion: INSTALLED_VERSION,
      estimatorVersion: ESTIMATOR_VERSION,
      lastFlush: null,
      profile: profileName,
      profileSource: effectiveProfileSource,
      // Null means "never repriced"; a first run with a non-empty default table
      // therefore reprices any pre-existing unpriced detail rows once.
      pricingFingerprint: null,
      // 0 means the auto-review category migration has not run yet; version 1
      // is stamped once the retained-detail pass succeeds.
      autoReviewCategoryVersion: 0,
    }
  } else {
    meta = {
      v: 1,
      schemaVersion: Number.isInteger(existingMeta.schemaVersion) ? existingMeta.schemaVersion : SCHEMA_VERSION,
      createdAt: Number.isFinite(existingMeta.createdAt) ? existingMeta.createdAt : nowMs(),
      installedVersion: typeof existingMeta.installedVersion === 'string' ? existingMeta.installedVersion : INSTALLED_VERSION,
      estimatorVersion: typeof existingMeta.estimatorVersion === 'string' ? existingMeta.estimatorVersion : ESTIMATOR_VERSION,
      lastFlush: Number.isFinite(existingMeta.lastFlush) ? existingMeta.lastFlush : null,
      profile: adopted ? profileName : (typeof existingMeta.profile === 'string' ? existingMeta.profile : profileName),
      profileSource: adopted
        ? 'adopted-legacy-default'
        : (typeof existingMeta.profileSource === 'string' ? existingMeta.profileSource : effectiveProfileSource),
      pricingFingerprint: typeof existingMeta.pricingFingerprint === 'string' ? existingMeta.pricingFingerprint : null,
      autoReviewCategoryVersion: Number.isInteger(existingMeta.autoReviewCategoryVersion)
        ? existingMeta.autoReviewCategoryVersion
        : 0,
    }
  }

  // Reprice before any read or write path can serve the retained range. A
  // fingerprint mismatch covers the first run with the default table (old rows
  // carry `priced:false`), every price-table edit, every off-peak-day change,
  // and the M2.2 tier policy upgrade (old rows were peak-priced). Read-only
  // stores skip this entirely and keep serving the persisted cost.
  const currentPricingFingerprint = pricingFingerprint(pricing, offPeakDays)
  if (!readOnly && meta.pricingFingerprint !== currentPricingFingerprint) {
    if (!Array.isArray(pricing) || pricing.length === 0) {
      // An empty table means "stop pricing new calls". Rewriting retained rows
      // would erase already-recorded amounts, so keep them and only remember
      // that this table has been applied.
      meta.pricingFingerprint = currentPricingFingerprint
      report('price table is empty; keeping previously recorded costs (new records will be unpriced)')
    } else {
      const repriced = repriceRetainedDays()
      if (repriced.ok) {
        meta.pricingFingerprint = currentPricingFingerprint
        if (repriced.changedRecords > 0) {
          report(`repriced ${repriced.changedRecords} record(s) across ${repriced.rewrittenDays} detail day(s) after a price-table change`)
        }
        if (repriced.skippedDays > 0) {
          report(`kept ${repriced.skippedDays} daily aggregate(s) that hold more requests than their detail file`)
        }
      } else if (repriced.deferred) {
        report('pricing reprice was deferred by the row budget; keeping the previous fingerprint so the next start retries')
      } else {
        report(`pricing reprice incomplete (${repriced.failures} failure(s)); keeping the previous fingerprint so the next start retries`)
      }
    }
  }

  // One-time category fix for auto-review transcript tokens. It runs after the
  // reprice pass (so these rows already carry their current cost) and before
  // `metaText` is written, so a successful pass stamps the marker in the same
  // startup. A read-only store never mutates anything and leaves the marker as
  // persisted. Old daily files outside the detail-retention window have no
  // retained rows to migrate and keep their historical `user` attribution.
  if (!readOnly && (meta.autoReviewCategoryVersion ?? 0) < AUTO_REVIEW_CATEGORY_VERSION) {
    try {
      const migrated = migrateAutoReviewCategories()
      if (migrated.ok && migrated.skippedDays === 0) {
        meta.autoReviewCategoryVersion = AUTO_REVIEW_CATEGORY_VERSION
        if (migrated.changedRecords > 0) {
          report(`migrated ${migrated.changedRecords} auto-review record(s) across ${migrated.changedDays} day(s)`)
        } else if (migrated.changedDays > 0) {
          report(`repaired daily aggregate(s) for ${migrated.changedDays} auto-review day(s) after an interrupted migration`)
        }
      } else if (migrated.ok) {
        report(`auto-review category migration skipped ${migrated.skippedDays} partial-detail day(s); keeping the previous marker so the next start retries`)
      } else {
        report(`auto-review category migration incomplete (${migrated.failures} failure(s)); keeping the previous marker so the next start retries`)
      }
    } catch (error) {
      report(`auto-review category migration crashed (${error instanceof Error ? error.message : String(error)}); keeping the previous marker so the next start retries`)
    }
  }

  const metaMigration = migrationStatus()
  meta.migrationStatus = metaMigration.status
  meta.migration = {
    status: metaMigration.status,
    from: metaMigration.from,
    to: metaMigration.to,
    finishedAt: metaMigration.finishedAt,
    backup: metaMigration.backup,
  }
  const metaText = JSON.stringify(meta)
  if (!readOnly && previousMetaText !== metaText) {
    try {
      atomicWriteFileSync(metaPath, metaText)
    } catch (error) {
      report(`cannot write meta.json: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (pointerDataRoot === null && !readOnly && !pointerCorrupt && !pointerWritten) {
    try {
      atomicWriteFileSync(pointerPath, JSON.stringify({
        v: 1,
        dataRoot,
        schemaVersion: SCHEMA_VERSION,
        updatedAt: nowMs(),
      }))
    } catch (error) {
      report(`cannot write pointer.json: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** @type {Map<string, object>} */
  const aggregates = new Map()

  /**
   * Load a persisted daily aggregate.
   * @param {string} day - day key.
   * @returns {object | null} aggregate or null when missing.
   */
  function loadDaily(day) {
    const value = readJsonFile(dailyPath(day))
    if (value === null || typeof value !== 'object' || value.v !== 1) return null
    return normalizeAggregate(value, day)
  }

  /**
   * Rebuild one day's aggregate by replaying its detail JSONL.
   * @param {string} day - day key.
   * @returns {object | null} aggregate, or null when the detail file is absent.
   */
  function rebuildFromRequests(day) {
    let text
    try {
      text = fs.readFileSync(requestsPath(day), 'utf8')
    } catch {
      return null
    }
    const records = []
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      let record
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      if (record === null || typeof record !== 'object' || record.v !== 1) continue
      records.push(record)
    }
    return aggregateFromRecords(day, records)
  }

  /**
   * Delete detail/daily files older than the configured retention.
   * @returns {number} removed file count.
   */
  function pruneOldFiles() {
    if (readOnly) return 0
    const today = dayKey(nowMs())
    // Keep today plus the previous `retention - 1` days.
    const requestCut = shiftDays(today, -(requestRetention - 1))
    const dailyCut = shiftDays(today, -(dailyRetention - 1))
    let removed = 0
    for (const name of readdirSafe(requestsDir)) {
      if (!name.endsWith('.jsonl')) continue
      const day = name.slice(0, 10)
      if (!isValidDayKey(day) || day >= requestCut) continue
      try {
        fs.rmSync(path.join(requestsDir, name), { force: true })
        removed += 1
      } catch (error) {
        report(`cannot prune ${name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    for (const name of readdirSafe(dailyDir)) {
      if (!name.endsWith('.json')) continue
      const day = name.slice(0, 10)
      if (!isValidDayKey(day) || day >= dailyCut) continue
      try {
        fs.rmSync(path.join(dailyDir, name), { force: true })
        removed += 1
      } catch (error) {
        report(`cannot prune ${name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    // Web API counters follow the daily-aggregate retention window; they are
    // not request detail, so the shorter request window does not apply.
    for (const name of readdirSafe(webApiDir)) {
      if (!name.endsWith('.json')) continue
      const day = name.slice(0, 10)
      if (!isValidDayKey(day) || day >= dailyCut) continue
      try {
        fs.rmSync(path.join(webApiDir, name), { force: true })
        removed += 1
      } catch (error) {
        report(`cannot prune webapi/${name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    // Migration backups live next to the roots, never inside requests/daily, so
    // retention cleanup can never delete one early; they get their own 7-day
    // window here.
    pruneMigrationBackups({
      dataRoots: [dataRoot, configuredDataRoot, defaultDataRoot, pointerDataRoot].filter(
        value => typeof value === 'string' && value.length > 0,
      ),
      now: nowMs(),
      backupDays: MIGRATION_BACKUP_DAYS,
      report,
    })
    return removed
  }

  pruneOldFiles()

  const today = dayKey(nowMs())
  /**
   * Load one day's aggregate, preferring a daily file only while it is at least
   * as new as the detail JSONL it summarizes; otherwise replay the JSONL. This
   * repairs a crash between detail append and daily rewrite for any day, not
   * only today.
   * @param {string} day - day key.
   * @returns {object | null} aggregate, or null when the day has no data files.
   */
  function loadAggregateFromDisk(day) {
    const persisted = loadDaily(day)
    const detailStat = statSafe(requestsPath(day))
    const dailyStat = statSafe(dailyPath(day))
    const detailIsNewer = detailStat !== null
      && (dailyStat === null || dailyStat.mtimeMs < detailStat.mtimeMs)
    let aggregate
    if (persisted !== null && detailIsNewer) {
      const rebuilt = rebuildFromRequests(day)
      // A detail file that holds fewer requests than the persisted aggregate is
      // partial (quiet corruption, manual restore, future thinning). Keep the
      // richer aggregate rather than dropping tokens it already counted.
      aggregate = rebuilt !== null && num(persisted.totals.requests) > num(rebuilt.totals.requests)
        ? persisted
        : (rebuilt ?? persisted)
    } else {
      aggregate = persisted ?? rebuildFromRequests(day)
    }
    if (aggregate === null) return null
    // Pre-M2 daily files carry only a flat cost block, so per-purpose/session/
    // model cost would read as zero. Detail rows (when still inside the
    // request-retention window) carry each request's cost, so replay them once.
    if (aggregate.costSchemaVersion !== COST_SCHEMA_VERSION) {
      if (detailStat !== null) {
        const rebuilt = rebuildFromRequests(day)
        if (rebuilt !== null && num(rebuilt.totals.requests) >= num(aggregate.totals.requests)) {
          return rebuilt
        }
      }
      aggregate.costDetailIncomplete = true
    }
    return aggregate
  }
  aggregates.set(today, loadAggregateFromDisk(today) ?? createDayAggregate(today))

  /** Earliest day for which any data file exists. @type {string | null} */
  let since = null
  for (const dir of [requestsDir, dailyDir]) {
    for (const name of readdirSafe(dir)) {
      const day = name.slice(0, 10)
      if (!isValidDayKey(day)) continue
      if (since === null || day < since) since = day
    }
  }

  /** @type {object[]} */
  const queue = []
  let flushing = false
  let disposed = false
  let dropped = 0
  let flushTimer = null
  let flushCount = 0

  /**
   * Append queued records to detail JSONL files, update daily aggregates, and
   * atomically rewrite touched daily files plus meta. Filesystem failures are
   * reported and the unsaved tail is requeued.
   * @returns {number} number of records persisted by this flush.
   */
  function flush() {
    if (readOnly || flushing || queue.length === 0) return 0
    flushing = true
    const pending = queue.splice(0, queue.length)
    let saved = 0
    try {
      /** @type {Map<string, object[]>} */
      const byDay = new Map()
      for (const record of pending) {
        const day = dayKey(typeof record?.ts === 'number' ? record.ts : nowMs())
        const list = byDay.get(day)
        if (list === undefined) byDay.set(day, [record])
        else list.push(record)
      }
      const groups = [...byDay]
      for (let index = 0; index < groups.length; index += 1) {
        const [day, records] = groups[index]
        // Resolve (or rebuild) the day aggregate BEFORE appending this group:
        // replaying the detail JSONL after the append would already include
        // these records and they would be counted a second time below.
        // `loadAggregateFromDisk` also repairs a daily file that is older than
        // its detail JSONL (a crash between the append and the daily rewrite),
        // so a late record for a past day starts from the detail replay rather
        // than a stale aggregate.
        const aggregate = aggregates.get(day) ?? loadAggregateFromDisk(day) ?? createDayAggregate(day)
        let payload
        try {
          payload = records.map(record => JSON.stringify(record)).join('\n') + '\n'
        } catch (error) {
          report(`cannot serialize ledger records: ${error instanceof Error ? error.message : String(error)}`)
          continue
        }
        try {
          ensureDir(requestsDir)
          fs.appendFileSync(requestsPath(day), payload, 'utf8')
        } catch (error) {
          report(`cannot append ${day}.jsonl: ${error instanceof Error ? error.message : String(error)}`)
          const unsaved = groups.slice(index).flatMap(([, list]) => list)
          queue.unshift(...unsaved)
          if (queue.length > MAX_QUEUE) {
            dropped += queue.length - MAX_QUEUE
            queue.splice(0, queue.length - MAX_QUEUE)
          }
          break
        }
        saved += records.length
        aggregates.set(day, aggregate)
        for (const record of records) addRecordToAggregate(aggregate, record)
        try {
          atomicWriteFileSync(dailyPath(day), JSON.stringify(aggregate))
        } catch (error) {
          report(`cannot write daily/${day}.json: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (since === null || day < since) since = day
      }
      if (saved > 0) {
        meta.lastFlush = nowMs()
        flushCount += 1
        try {
          atomicWriteFileSync(metaPath, JSON.stringify(meta))
        } catch (error) {
          report(`cannot write meta.json: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    } finally {
      flushing = false
    }
    return saved
  }

  /**
   * Queue one record for persistence.
   * @param {object} record - v1 request record.
   * @returns {boolean} true when the record was accepted.
   */
  function append(record) {
    if (disposed || readOnly) return false
    if (record === null || typeof record !== 'object') return false
    queue.push(record)
    if (queue.length > MAX_QUEUE) {
      const overflow = queue.length - MAX_QUEUE
      dropped += overflow
      queue.splice(0, overflow)
    }
    if (queue.length >= FLUSH_THRESHOLD) flush()
    return true
  }

  /**
   * Load one day's web API counters.
   *
   * A missing file yields null silently; an unreadable or malformed file is
   * skipped with a diagnostic so one bad day never breaks the whole summary.
   * Missing counters inside a valid v1 file read as zero, and a file written
   * before the per-session map existed loads with an empty session map so its
   * totals keep working.
   * @param {string} day - `YYYY-MM-DD` day key.
   * @returns {object | null} counters, or null when the day is absent/unusable.
   */
  function loadWebApiDay(day) {
    let text
    try {
      text = fs.readFileSync(webApiPath(day), 'utf8')
    } catch (error) {
      // A missing file is the normal "no calls that day" case; any other read
      // failure is reported and skipped so one locked file cannot break a range.
      if (error?.code !== 'ENOENT') {
        report(`cannot read webapi/${day}.json (${error instanceof Error ? error.message : String(error)}); ignoring this day`)
      }
      return null
    }
    let value
    try {
      value = JSON.parse(text)
    } catch {
      report(`webapi/${day}.json is not valid JSON; ignoring this day`)
      return null
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value) || value.v !== 1) {
      report(`webapi/${day}.json has an unexpected shape; ignoring this day`)
      return null
    }
    const entry = createWebApiDay(day)
    for (const tool of WEB_API_TOOLS) {
      const source = value[tool] !== null && typeof value[tool] === 'object' ? value[tool] : {}
      entry[tool].ok = num(source.ok)
      entry[tool].failed = num(source.failed)
    }
    // Session entries are auxiliary: one malformed bucket is normalized to
    // zeros rather than dropping the whole day (whose totals are authoritative).
    for (const [sessionId, source] of mapEntries(value.sessions)) {
      const session = createWebApiSession()
      const counters = source !== null && typeof source === 'object' && !Array.isArray(source) ? source : {}
      for (const tool of WEB_API_TOOLS) {
        const toolCounters = counters[tool] !== null && typeof counters[tool] === 'object' && !Array.isArray(counters[tool])
          ? counters[tool]
          : {}
        session[tool].ok = num(toolCounters.ok)
        session[tool].failed = num(toolCounters.failed)
      }
      entry.sessions[sessionId] = session
    }
    return entry
  }

  /**
   * Days whose session-map overflow has already been reported once, so a full
   * day does not turn every later call into a diagnostic.
   * @type {Set<string>}
   */
  const webApiSessionOverflowReported = new Set()

  /**
   * Record one observed web API tool outcome into its per-day file.
   *
   * The file is read, incremented, and atomically rewritten on every call. The
   * day totals always increment; the same outcome also increments the bucket of
   * the calling session (`sessionId`, trimmed, or `unknown`). A day keeps at
   * most `MAX_WEB_API_SESSIONS` session buckets; a new session beyond the cap is
   * counted into the `unknown` bucket instead (reported once per day).
   *
   * A read-only store (foreign lock, corrupt pointer) skips the write entirely.
   * Failures are contained and reported; they never reach the tool pipeline.
   * @param {{ts?: number, tool: 'search'|'fetch', ok?: boolean, sessionId?: unknown}} call - observed call.
   * @returns {boolean} true when the counter was persisted.
   */
  function recordWebApiCall(call) {
    if (readOnly || disposed) return false
    try {
      const tool = call?.tool
      if (tool !== 'search' && tool !== 'fetch') return false
      const ts = typeof call?.ts === 'number' && Number.isFinite(call.ts) ? call.ts : nowMs()
      const day = dayKey(ts)
      if (!isValidDayKey(day)) return false
      const entry = loadWebApiDay(day) ?? createWebApiDay(day)
      const outcome = call?.ok === true ? 'ok' : 'failed'
      entry[tool][outcome] += 1
      const bucket = resolveWebApiSessionBucket(entry.sessions, webApiSessionKey(call?.sessionId))
      if (bucket.overflowed && !webApiSessionOverflowReported.has(day)) {
        webApiSessionOverflowReported.add(day)
        report(`webapi/${day}.json holds ${MAX_WEB_API_SESSIONS} session buckets; further sessions are counted as "${UNKNOWN_WEB_API_SESSION}"`)
      }
      entry.sessions[bucket.key][tool][outcome] += 1
      atomicWriteFileSync(webApiPath(day), JSON.stringify(entry))
      return true
    } catch (error) {
      report(`cannot record web API call: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /**
   * Aggregate web API counters over an inclusive local-day range.
   *
   * Totals come from the per-day counters. `bySession` aggregates the optional
   * per-day session maps and is therefore empty for days written before the
   * session breakdown existed; each row is priced with the same configured
   * per-thousand estimate as the totals. Rows are capped at
   * `MAX_WEB_API_SESSION_ROWS`, ordered by call count descending, then search
   * count descending, then session id ascending.
   *
   * `unattributed` is the exact remainder `totals - sum(session buckets)` over
   * the whole range, with the same counters and price estimate. It is computed
   * from the complete session map before the `bySession` row cap, so a capped
   * row never counts as unattributed. Legacy days written before `sessions`
   * existed contribute their whole totals (nothing is attributed); an
   * overflowed session is already in the `unknown` bucket and is therefore
   * attributed. Every recorded call increments the day totals and one session
   * bucket in the same atomic write, so for ledger-written files the remainder
   * is non-negative. The remainder is zero on a range whose session map covers
   * every counted call, and is priced only when it holds at least one
   * successful call.
   * @param {{from?: string, to?: string}} [range] - inclusive day keys (defaults to the request-retention window ending today).
   * @returns {{search: {ok: number, failed: number, total: number}, fetch: {ok: number, failed: number, total: number}, calls: {ok: number, failed: number, total: number}, bySession: object[], unattributed: {search: {ok: number, failed: number, total: number}, fetch: {ok: number, failed: number, total: number}, calls: {ok: number, failed: number, total: number}, cost: {amount: number, currency: string, priced: boolean}}}} counters.
   */
  function readWebApi(range = {}) {
    const end = isValidDayKey(range?.to) ? range.to : dayKey(nowMs())
    const start = isValidDayKey(range?.from) ? range.from : shiftDays(end, -(requestRetention - 1))
    const result = { ...emptyWebApiCounters(), bySession: [] }
    /** @type {Map<string, object>} */
    const sessionTotals = new Map()
    for (const day of dayKeysBetween(start, end)) {
      const entry = loadWebApiDay(day)
      if (entry === null) continue
      for (const tool of WEB_API_TOOLS) {
        result[tool].ok += entry[tool].ok
        result[tool].failed += entry[tool].failed
      }
      for (const [sessionId, counters] of mapEntries(entry.sessions)) {
        let target = sessionTotals.get(sessionId)
        if (target === undefined) {
          target = { sessionId, ...emptyWebApiCounters() }
          sessionTotals.set(sessionId, target)
        }
        for (const tool of WEB_API_TOOLS) {
          target[tool].ok += num(counters?.[tool]?.ok)
          target[tool].failed += num(counters?.[tool]?.failed)
        }
      }
    }
    for (const tool of WEB_API_TOOLS) {
      result[tool].total = result[tool].ok + result[tool].failed
      result.calls.ok += result[tool].ok
      result.calls.failed += result[tool].failed
    }
    result.calls.total = result.calls.ok + result.calls.failed
    // Attribute exactly the calls the complete session map accounts for. This
    // runs before `bySession` is capped so rows dropped by the cap stay
    // attributed and never inflate the unattributed remainder.
    const attributed = { search: { ok: 0, failed: 0 }, fetch: { ok: 0, failed: 0 } }
    for (const entry of sessionTotals.values()) {
      for (const tool of WEB_API_TOOLS) {
        attributed[tool].ok += entry[tool].ok
        attributed[tool].failed += entry[tool].failed
      }
    }
    const unattributed = emptyWebApiCounters()
    for (const tool of WEB_API_TOOLS) {
      unattributed[tool].ok = result[tool].ok - attributed[tool].ok
      unattributed[tool].failed = result[tool].failed - attributed[tool].failed
      unattributed[tool].total = unattributed[tool].ok + unattributed[tool].failed
      unattributed.calls.ok += unattributed[tool].ok
      unattributed.calls.failed += unattributed[tool].failed
    }
    unattributed.calls.total = unattributed.calls.ok + unattributed.calls.failed
    const sessions = [...sessionTotals.values()].map(entry => {
      for (const tool of WEB_API_TOOLS) entry[tool].total = entry[tool].ok + entry[tool].failed
      entry.calls.ok = entry.search.ok + entry.fetch.ok
      entry.calls.failed = entry.search.failed + entry.fetch.failed
      entry.calls.total = entry.calls.ok + entry.calls.failed
      return {
        sessionId: entry.sessionId,
        search: entry.search,
        fetch: entry.fetch,
        calls: entry.calls,
        cost: webApiCost(entry),
      }
    })
    sessions.sort((left, right) => (right.calls.total - left.calls.total)
      || (right.search.total - left.search.total)
      || (left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0))
    result.bySession = sessions.slice(0, MAX_WEB_API_SESSION_ROWS)
    result.unattributed = { ...unattributed, cost: webApiCost(unattributed) }
    return result
  }

  /**
   * Price web API counters at the configured per-thousand rates.
   *
   * Only successful calls are billable; failed ones are counted for visibility.
   * The amount is an estimate (rounded to 6 decimals), not a provider bill.
   * @param {{search: {ok: number}, fetch: {ok: number}}} counts - observed counters.
   * @returns {{amount: number, currency: string, priced: boolean}} estimate.
   */
  function webApiCost(counts) {
    const search = round(num(counts?.search?.ok) * webApiPricing.searchPerThousand / 1000, 6)
    const fetch = round(num(counts?.fetch?.ok) * webApiPricing.fetchPerThousand / 1000, 6)
    return {
      amount: round(search + fetch, 6),
      currency: webApiPricing.currency,
      priced: num(counts?.search?.ok) + num(counts?.fetch?.ok) > 0,
    }
  }

  /**
   * Read or build the aggregate for one day during a summary query.
   * @param {string} day - day key.
   * @returns {object | null} aggregate.
   */
  function aggregateForRead(day) {
    const inMemory = aggregates.get(day)
    if (inMemory !== undefined) return inMemory
    const loaded = loadAggregateFromDisk(day)
    if (loaded !== null) aggregates.set(day, loaded)
    return loaded
  }

  /**
   * Merge one daily aggregate into a summary shell.
   * @param {object} summary - summary shell (with temporary maps).
   * @param {object} aggregate - daily aggregate.
   * @returns {void}
   */
  function mergeIntoSummary(summary, aggregate) {
    for (const key of Object.keys(summary.totals)) {
      if (key === 'estimatedShare') continue
      summary.totals[key] += num(aggregate.totals[key])
    }
    for (const [purpose, entry] of mapEntries(aggregate.byPurpose)) {
      const target = summary.byPurpose[purpose] ??= { requests: 0, promptTokens: 0, outputTokens: 0 }
      target.requests += num(entry?.requests)
      target.promptTokens += num(entry?.promptTokens)
      target.outputTokens += num(entry?.outputTokens)
      const tally = summary.purposeCostMap.get(purpose) ?? createCostTally()
      mergeEntityCostToTally(tally, entry)
      summary.purposeCostMap.set(purpose, tally)
    }
    for (const [category, tokens] of mapEntries(aggregate.byCategory)) {
      summary.byCategory[category] = (summary.byCategory[category] ?? 0) + num(tokens)
    }
    for (const [group, tokens] of mapEntries(aggregate.byCategoryGroup)) {
      summary.byCategoryGroup[group] = (summary.byCategoryGroup[group] ?? 0) + num(tokens)
    }
    for (const [group, tokens] of mapEntries(aggregate.byToolGroup)) {
      summary.byToolGroup[group] = (summary.byToolGroup[group] ?? 0) + num(tokens)
    }
    for (const [hour, entry] of mapEntries(aggregate.byHour)) {
      const target = summary.byHour[hour] ??= { requests: 0, promptTokens: 0, outputTokens: 0 }
      target.requests += num(entry?.requests)
      target.promptTokens += num(entry?.promptTokens)
      target.outputTokens += num(entry?.outputTokens)
    }
    for (const [sessionId, entry] of mapEntries(aggregate.bySession)) {
      const target = summary.sessionMap.get(sessionId) ?? {
        sessionId,
        parentSessionId: typeof entry?.parentSessionId === 'string' ? entry.parentSessionId : null,
        depth: Number.isInteger(entry?.depth) ? entry.depth : 0,
        promptTokens: 0,
        outputTokens: 0,
        requests: 0,
        cache: { input: 0, read: 0, write: 0 },
        costTally: createCostTally(),
      }
      target.promptTokens += num(entry?.promptTokens)
      target.outputTokens += num(entry?.outputTokens)
      target.requests += num(entry?.requests)
      target.cache.input += num(entry?.cache?.input)
      target.cache.read += num(entry?.cache?.read)
      target.cache.write += num(entry?.cache?.write)
      mergeEntityCostToTally(target.costTally, entry)
      summary.sessionMap.set(sessionId, target)
    }
    for (const [modelKey, entry] of mapEntries(aggregate.byModel)) {
      const target = summary.modelMap.get(modelKey) ?? {
        provider: typeof entry?.provider === 'string' ? entry.provider : 'unknown',
        model: typeof entry?.model === 'string' ? entry.model : 'unknown',
        requests: 0,
        promptTokens: 0,
        outputTokens: 0,
        costTally: createCostTally(),
      }
      target.requests += num(entry?.requests)
      target.promptTokens += num(entry?.promptTokens)
      target.outputTokens += num(entry?.outputTokens)
      mergeEntityCostToTally(target.costTally, entry)
      summary.modelMap.set(modelKey, target)
    }
    summary.cache.input += num(aggregate.cache?.input)
    summary.cache.read += num(aggregate.cache?.read)
    summary.cache.write += num(aggregate.cache?.write)
    mergeAggregateCostToTally(summary.costTally, aggregate.costByCurrency, aggregate.cost)
  }

  /**
   * Read the aggregated summary for a local-day range.
   * @param {{from?: string, to?: string}} [range] - inclusive day keys (defaults to the detail retention window ending today).
   * @returns {object} summary payload.
   */
  function readSummary(range = {}) {
    const end = isValidDayKey(range?.to) ? range.to : dayKey(nowMs())
    const defaultFrom = shiftDays(end, -(requestRetention - 1))
    const start = isValidDayKey(range?.from) ? range.from : defaultFrom
    const days = dayKeysBetween(start, end)
    /** Queued records not yet flushed, grouped per in-range day (read-only view). @type {Map<string, object>} */
    const pendingAggregateByDay = new Map()
    if (queue.length > 0) {
      const inRange = new Set(days)
      for (const record of queue) {
        const day = dayKey(typeof record?.ts === 'number' ? record.ts : nowMs())
        if (!inRange.has(day)) continue
        const aggregate = pendingAggregateByDay.get(day) ?? createDayAggregate(day)
        addRecordToAggregate(aggregate, record)
        pendingAggregateByDay.set(day, aggregate)
      }
    }
    const summary = {
      generatedAt: nowMs(),
      range: { from: days[0] ?? start, to: days[days.length - 1] ?? end },
      totals: {
        promptTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        measuredPromptTokens: 0,
        measuredOutputTokens: 0,
        estimatedPromptTokens: 0,
        estimatedOutputTokens: 0,
        requests: 0,
        attempts: 0,
        estimatedRequests: 0,
        measuredRequests: 0,
        estimatedShare: 0,
      },
      byPurpose: {},
      byCategory: {},
      byCategoryGroup: {},
      byToolGroup: {},
      byHour: {},
      bySession: [],
      byModel: [],
      // Oldest-first daily rows; days with no data at all are omitted so a
      // 30-day query on a young ledger stays small. Queued (unflushed) records
      // are folded into their day below, exactly like the totals.
      byDay: [],
      cache: { input: 0, read: 0, write: 0, hitRate: 0 },
      cost: { amount: 0, priced: false, unpricedRequests: 0, currency: 'CNY' },
      data: {
        since,
        retention: { requestDays: requestRetention, dailyDays: dailyRetention },
        dataRoot,
        readOnly,
        pointerStatus,
        migrationStatus: effectiveMigrationStatus(),
        costDetailIncomplete: false,
      },
      costTally: createCostTally(),
      purposeCostMap: new Map(),
      sessionMap: new Map(),
      modelMap: new Map(),
    }
    for (const day of days) {
      const dayTally = createCostTally()
      let dayRequests = 0
      let dayPromptTokens = 0
      let dayOutputTokens = 0
      let dayEstimatedRequests = 0
      const parts = [aggregateForRead(day), pendingAggregateByDay.get(day)]
      for (const part of parts) {
        if (part === null || part === undefined) continue
        if (part.costDetailIncomplete === true) summary.data.costDetailIncomplete = true
        mergeIntoSummary(summary, part)
        dayRequests += num(part.totals.requests)
        dayPromptTokens += num(part.totals.promptTokens)
        dayOutputTokens += num(part.totals.outputTokens)
        dayEstimatedRequests += num(part.totals.estimatedRequests)
        mergeAggregateCostToTally(dayTally, part.costByCurrency, part.cost)
      }
      if (dayRequests > 0) {
        summary.byDay.push({
          day,
          requests: dayRequests,
          promptTokens: dayPromptTokens,
          outputTokens: dayOutputTokens,
          estimatedRequests: dayEstimatedRequests,
          cost: finalizeCost(dayTally),
          // Same shape as `summary.totals.costByCurrency`; amounts are never
          // summed across currencies, so a mixed day keeps one entry each.
          costByCurrency: costByCurrencyValue(dayTally),
        })
      }
    }
    const sessions = [...summary.sessionMap.values()].map(entry => ({
      sessionId: entry.sessionId,
      parentSessionId: entry.parentSessionId,
      depth: entry.depth,
      // The client's tree shows the input/output split per row (subtree sums).
      promptTokens: entry.promptTokens,
      outputTokens: entry.outputTokens,
      tokens: entry.promptTokens + entry.outputTokens,
      requests: entry.requests,
      // Absolute measured cache buckets, so the client can compute the hit
      // rate per session; zero for sessions whose rows predate these counters.
      cache: { input: entry.cache.input, read: entry.cache.read, write: entry.cache.write },
      cost: finalizeCost(entry.costTally),
    }))
    sessions.sort((left, right) => right.tokens - left.tokens)
    const models = [...summary.modelMap.values()].map(entry => ({
      provider: entry.provider,
      model: entry.model,
      requests: entry.requests,
      promptTokens: entry.promptTokens,
      outputTokens: entry.outputTokens,
      tokens: entry.promptTokens + entry.outputTokens,
      cost: finalizeCost(entry.costTally),
    }))
    models.sort((left, right) => right.tokens - left.tokens)
    // The client builds a session tree, so return the complete retained set
    // (capped) instead of a top-20 list; rows are tokens-descending.
    summary.bySession = sessions.slice(0, MAX_SUMMARY_SESSIONS)
    summary.byModel = models.slice(0, 20)
    for (const [purpose, tally] of summary.purposeCostMap) {
      const entry = summary.byPurpose[purpose]
      if (entry !== undefined) entry.cost = finalizeCost(tally)
    }
    summary.cache.hitRate = summary.cache.input + summary.cache.read + summary.cache.write > 0
      ? round(summary.cache.read / (summary.cache.input + summary.cache.read + summary.cache.write), 4)
      : 0
    summary.totals.totalTokens = summary.totals.promptTokens + summary.totals.outputTokens
    summary.totals.estimatedShare = summary.totals.requests > 0
      ? round(summary.totals.estimatedRequests / summary.totals.requests, 4)
      : 0
    summary.totals.costByCurrency = costByCurrencyValue(summary.costTally)
    summary.cost = finalizeCost(summary.costTally)
    // Web API call counters live in their own per-day files and are priced as a
    // separate estimate. `readWebApi` also carries the exact unattributed
    // remainder; the spread below keeps it next to the unchanged totals. A
    // failure here must never break the token summary.
    try {
      const webApi = readWebApi({ from: summary.range.from, to: summary.range.to })
      summary.webApi = { ...webApi, cost: webApiCost(webApi) }
    } catch (error) {
      report(`web API summary failed: ${error instanceof Error ? error.message : String(error)}`)
      summary.webApi = emptyWebApiSummary(webApiPricing.currency)
    }
    delete summary.costTally
    delete summary.purposeCostMap
    delete summary.sessionMap
    delete summary.modelMap
    return summary
  }

  /**
   * Read per-request detail rows, newest first.
   *
   * Filters compose: `purpose` and `sessionId` are exact matches, and either
   * applies to the selected `date` or `from`/`to` day range. `total` counts the
   * filtered rows before pagination, so it stays correct for any combination.
   * @param {{date?: string, from?: string, to?: string, limit?: number, offset?: number, purpose?: string, sessionId?: string}} [query] - detail query.
   * @returns {{items: object[], total: number}} page plus the filtered total.
   */
  function readRequests(query = {}) {
    const limit = Math.min(200, Math.max(1, Number.isInteger(query?.limit) ? query.limit : 50))
    const offset = Number.isInteger(query?.offset) && query.offset > 0 ? query.offset : 0
    const purposeFilter = typeof query?.purpose === 'string' && query.purpose.length > 0 ? query.purpose : null
    const sessionIdFilter = typeof query?.sessionId === 'string' && query.sessionId.length > 0 ? query.sessionId : null
    let days
    if (isValidDayKey(query?.date)) {
      days = [query.date]
    } else {
      const end = isValidDayKey(query?.to) ? query.to : dayKey(nowMs())
      const start = isValidDayKey(query?.from) ? query.from : end
      days = dayKeysBetween(start, end)
    }
    const items = []
    for (const day of days) {
      let text
      try {
        text = fs.readFileSync(requestsPath(day), 'utf8')
      } catch {
        continue
      }
      for (const line of text.split('\n')) {
        if (line.length === 0) continue
        let record
        try {
          record = JSON.parse(line)
        } catch {
          continue
        }
        if (record === null || typeof record !== 'object') continue
        if (purposeFilter !== null && record.purpose !== purposeFilter) continue
        // Exact match on the stored session id; a record without one never
        // matches a non-empty filter.
        if (sessionIdFilter !== null && record.sessionId !== sessionIdFilter) continue
        items.push(record)
      }
    }
    items.sort((left, right) => (num(right.ts) - num(left.ts)) || String(right.id ?? '').localeCompare(String(left.id ?? '')))
    return { items: items.slice(offset, offset + limit), total: items.length }
  }

  /**
   * Read ledger metadata plus the current migration status.
   * @returns {object} meta payload.
   */
  function readMeta() {
    const pricing = Array.isArray(config.pricing) ? config.pricing : []
    const migration = migrationStatus()
    return {
      version: INSTALLED_VERSION,
      schemaVersion: SCHEMA_VERSION,
      estimatorVersion: meta.estimatorVersion,
      createdAt: meta.createdAt,
      lastFlush: meta.lastFlush,
      dataRoot,
      stateRoot,
      profile: profileName,
      profileSource: typeof meta.profileSource === 'string' ? meta.profileSource : 'unknown',
      autoReviewCategoryVersion: Number.isInteger(meta.autoReviewCategoryVersion)
        ? meta.autoReviewCategoryVersion
        : 0,
      readOnly,
      pointerStatus,
      since,
      retention: { requestDays: requestRetention, dailyDays: dailyRetention },
      pricing: {
        entries: pricing.length,
        providers: [...new Set(pricing.map(entry => entry.provider).filter(provider => typeof provider === 'string'))],
        currencies: [...new Set(pricing.map(entry => entry.currency).filter(currency => typeof currency === 'string'))],
      },
      droppedRecords: dropped,
      flushes: flushCount,
      migrationStatus: migration.status,
      migration,
    }
  }

  /**
   * Stop the flush timer, persist the queue, and release the lock.
   * @returns {void}
   */
  function dispose() {
    if (disposed) return
    if (flushTimer !== null) {
      clearInterval(flushTimer)
      flushTimer = null
    }
    try {
      flush()
    } catch (error) {
      report(`final flush failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    disposed = true
    if (ownsLock && !readOnly) {
      try {
        const current = readJsonFile(lockPath)
        if (current !== null && typeof current === 'object' && current.pid === process.pid) {
          fs.rmSync(lockPath, { force: true })
        }
      } catch (error) {
        report(`cannot release ledger lock: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  if (ctx !== null && typeof ctx === 'object' && typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => {
        flushTimer = setInterval(() => {
          try {
            flush()
          } catch (error) {
            report(`scheduled flush failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }, flushInterval)
        if (typeof flushTimer?.unref === 'function') flushTimer.unref()
        return () => {
          if (flushTimer !== null) {
            clearInterval(flushTimer)
            flushTimer = null
          }
          try {
            flush()
          } catch (error) {
            report(`flush on unload failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }, 'token-attribution-flush-timer')
    } catch (error) {
      report(`cannot register flush timer: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    append,
    flush,
    flushNow: flush,
    dispose,
    readSummary,
    readRequests,
    readMeta,
    recordWebApiCall,
    readWebApi,
    migrationStatus,
    getState: () => ({
      dataRoot,
      stateRoot,
      configuredDataRoot,
      readOnly,
      pointerStatus,
      migrationStatus: effectiveMigrationStatus(),
      migration: migrationStatus(),
      since,
      pending: queue.length,
      dropped,
    }),
  }
}
