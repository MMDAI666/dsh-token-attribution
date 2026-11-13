/**
 * Manual Config validation for the token-attribution plugin.
 *
 * The plugin deliberately declares no schemastery `Config`: `apply` must never
 * fail on a bad profile row. Every field is validated here, invalid values fall
 * back to their defaults, and each fallback produces a diagnostic string.
 *
 * @module dsh-token-attribution/host/config
 */

import path from 'node:path'

import { isValidDayKey } from './util.mjs'

/**
 * Default tool groups, in matching order.
 *
 * Each group maps a display group key to a list of tool names or prefixes: an
 * entry matches a tool when it equals the tool name or is a prefix of it (so
 * `mnemon_` groups `mnemon_recall`, while `list_agents` groups only itself).
 * Groups are evaluated in object order and the first matching group wins, so a
 * tool listed in two groups is attributed to the earlier one.
 *
 * `agentTeams` deliberately keeps its historical camel-case config key; it
 * reports as the hyphenated output group `agent-teams`. Every other key is
 * reported verbatim. Users may add arbitrary group keys to Config.
 */
export const DEFAULT_TOOL_GROUPS = Object.freeze({
  memory: Object.freeze(['mnemon_']),
  skill: Object.freeze(['skill']),
  agentTeams: Object.freeze([
    'spawn_teammate',
    'send_message',
    'wait_agent',
    'team_task_',
    'list_agents',
    'interrupt_agent',
  ]),
  files: Object.freeze([
    'read',
    'write',
    'edit',
    'glob',
    'grep',
    'read_image',
    'load_workspace_dependencies',
  ]),
  shell: Object.freeze(['pwsh', 'bash', 'terminal_']),
  web: Object.freeze(['web_search', 'web_fetch']),
  session: Object.freeze(['session_']),
  goals: Object.freeze(['create_goal', 'update_goal', 'get_goal']),
  schedule: Object.freeze(['schedule_']),
  subagents: Object.freeze(['subagent', 'list_subagent_models']),
  plugins: Object.freeze(['plugin_manager', 'plugin_market', 'cordis_']),
  browser: Object.freeze(['ego_']),
  workflow: Object.freeze(['workflow']),
})

/** Maximum number of tool-name entries accepted in one configured group. */
export const MAX_TOOL_GROUP_ENTRIES = 200

/** Historical config key kept verbatim for compatibility with saved profiles. */
const HISTORICAL_TOOL_GROUP_NAME = 'agentTeams'

/** Shape of a user-defined tool-group key: lowercase letters, digits, hyphens. */
const TOOL_GROUP_NAME_PATTERN = /^[a-z0-9-]{1,32}$/

/** Group names that would collide with the unmatched-tool fallback. */
const RESERVED_TOOL_GROUP_NAMES = Object.freeze(['other'])

/**
 * Clone the built-in tool groups into a detached, mutable object.
 * @returns {Record<string, string[]>} cloned groups preserving default order.
 */
export function cloneDefaultToolGroups() {
  return Object.fromEntries(
    Object.entries(DEFAULT_TOOL_GROUPS).map(([name, list]) => [name, [...list]]),
  )
}

/**
 * Normalize one configured tool-group key.
 *
 * A valid key is `agentTeams` (the historical key, kept verbatim) or 1-32
 * lowercase letters, digits, and hyphens. `other` is reserved for tools that
 * match no group. This validates shape only: case-insensitive duplicates are
 * detected by `normalizeConfig` against the whole group object.
 * @param {unknown} name - raw group key.
 * @returns {string | null} canonical key, or null when invalid.
 */
export function normalizeToolGroupName(name) {
  if (typeof name !== 'string') return null
  if (name === HISTORICAL_TOOL_GROUP_NAME) return HISTORICAL_TOOL_GROUP_NAME
  if (!TOOL_GROUP_NAME_PATTERN.test(name)) return null
  // Integer-like keys are reordered by the JavaScript engine, so a group named
  // "123" could silently outrank the documented built-in order.
  if (/^\d+$/.test(name)) return null
  if (RESERVED_TOOL_GROUP_NAMES.includes(name)) return null
  return name
}

/** Version tag shared by the built-in DeepSeek tiered price rows. */
export const DEFAULT_PRICE_VERSION = 'deepseek-2026-11'

/** Token prices accepted in one price entry (peak and off-peak alike). */
const PRICE_FIELDS = Object.freeze([
  'inputPerMillion',
  'cacheReadPerMillion',
  'cacheWritePerMillion',
  'outputPerMillion',
])

/**
 * Built-in DeepSeek tiered reference prices, CNY per 1M tokens.
 *
 * The top-level fields are the **peak-hour** prices copied from the official
 * DeepSeek pricing page (fetched 2026-11-11): peak hours are Mon-Fri
 * 09:00-12:00 and 14:00-18:00 Asia/Shanghai. `offPeak` holds the official
 * half-price off-peak values, used at all other times, on weekends, and on the
 * dates listed in `Config.pricingOffPeakDays`; a missing `offPeak` field falls
 * back to its peak value. They are only a local estimate, never a provider
 * bill, and the settings panel can replace them.
 *
 * `lookupPrice` matches an exact model id, `*`, or a `prefix*`; it has no alias
 * indirection. Model ids such as `deepseek-v4-flash` (a flash-priced alias)
 * therefore stay unpriced unless the user adds their own row, rather than
 * silently borrowing another model's price.
 */
export const DEFAULT_PRICING = Object.freeze([
  Object.freeze({
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    currency: 'CNY',
    priceVersion: DEFAULT_PRICE_VERSION,
    inputPerMillion: 2,
    cacheReadPerMillion: 0.04,
    cacheWritePerMillion: 0,
    outputPerMillion: 8,
    offPeak: Object.freeze({
      inputPerMillion: 1,
      cacheReadPerMillion: 0.02,
      cacheWritePerMillion: 0,
      outputPerMillion: 4,
    }),
  }),
  Object.freeze({
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    currency: 'CNY',
    priceVersion: DEFAULT_PRICE_VERSION,
    inputPerMillion: 9,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 0,
    outputPerMillion: 27,
    offPeak: Object.freeze({
      inputPerMillion: 4.5,
      cacheReadPerMillion: 0.15,
      cacheWritePerMillion: 0,
      outputPerMillion: 13.5,
    }),
  }),
])

/**
 * Clone the built-in price rows into a detached, mutable array.
 * @returns {object[]} cloned price entries with detached `offPeak` overrides.
 */
export function cloneDefaultPricing() {
  return DEFAULT_PRICING.map(entry => ({
    ...entry,
    ...entry.offPeak === undefined ? {} : { offPeak: { ...entry.offPeak } },
  }))
}

/**
 * Default all-day off-peak dates: official Chinese statutory holidays in
 * Asia/Shanghai for 2026 and 2027, taken from the State Council notices
 * (fetched 2026-11-12).
 *
 * The list covers 62 days: 33 in 2026 and 29 in 2027. It is only a local
 * pricing hint (DeepSeek bills holidays at its official off-peak tier), and it
 * must be refreshed when a new State Council notice is published; the settings
 * panel can also replace or clear it. An explicit empty array in Config
 * disables holiday pricing without falling back to this list.
 */
export const DEFAULT_PRICING_OFF_PEAK_DAYS = Object.freeze([
  // 2026: New Year (3), Spring Festival (9), Qingming (3), Labour Day (5),
  // Dragon Boat (3), Mid-Autumn (3), National Day (7).
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
  '2026-10-06', '2026-10-07',
  // 2027: New Year (3), Spring Festival (9), Qingming (3), Labour Day (5),
  // Dragon Boat (1), Mid-Autumn (1), National Day (7).
  '2027-01-01', '2027-01-02', '2027-01-03',
  '2027-02-05', '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-09',
  '2027-02-10', '2027-02-11', '2027-02-12', '2027-02-13',
  '2027-04-03', '2027-04-04', '2027-04-05',
  '2027-05-01', '2027-05-02', '2027-05-03', '2027-05-04', '2027-05-05',
  '2027-06-09',
  '2027-09-15',
  '2027-10-01', '2027-10-02', '2027-10-03', '2027-10-04', '2027-10-05',
  '2027-10-06', '2027-10-07',
])

/**
 * Default web API price estimate, CNY per 1000 successful calls.
 *
 * DeepSeek's official Search and Fetch list price is 5 CNY per 1000 successful
 * requests. This table only prices observed tool-call successes; it is an
 * estimate, never a provider bill (the host exposes no web-tool billing data).
 */
export const DEFAULT_WEB_API_PRICING = Object.freeze({
  searchPerThousand: 5,
  fetchPerThousand: 5,
  currency: 'CNY',
})

/**
 * Complete default configuration. Callers must clone before mutating.
 *
 * `pricingOffPeakDays` defaults to the 2026-2027 official Chinese statutory
 * holidays; set it to an explicit empty list to disable holiday pricing.
 */
export const DEFAULT_CONFIG = Object.freeze({
  dataDir: '',
  retainRequestDays: 30,
  retainDailyDays: 365,
  flushIntervalMs: 5000,
  pricing: DEFAULT_PRICING,
  pricingOffPeakDays: DEFAULT_PRICING_OFF_PEAK_DAYS,
  webApiPricing: DEFAULT_WEB_API_PRICING,
  toolGroups: DEFAULT_TOOL_GROUPS,
  maxDetailRowsPerDay: 200000,
  enableAutoRefresh: false,
  rememberLastTab: false,
  autoRefreshIntervalMs: 30000,
  rpcChannel: '/token-attribution',
})

/** Fields whose change cannot be applied in place; the plugin must reload. */
export const RESTART_REQUIRED_FIELDS = Object.freeze(['dataDir', 'rpcChannel'])

/** Field order used by `describeConfig` and config surfaces. */
const FIELD_ORDER = Object.freeze([
  'dataDir',
  'retainRequestDays',
  'retainDailyDays',
  'flushIntervalMs',
  'pricing',
  'pricingOffPeakDays',
  'webApiPricing',
  'toolGroups',
  'maxDetailRowsPerDay',
  'enableAutoRefresh',
  // Inserted next to the other client-panel display flags. `rememberLastTab`
  // is a plain boolean, so it needs no special cloning in `cloneDefaultConfig`.
  'rememberLastTab',
  'autoRefreshIntervalMs',
  'rpcChannel',
])

/** Per-field metadata returned by `describeConfig`. */
const FIELD_DESCRIPTORS = Object.freeze({
  dataDir: {
    type: 'string',
    default: '',
    editable: true,
    restartRequired: true,
    description: 'Data root override; empty uses the profile default directory.',
  },
  retainRequestDays: {
    type: 'integer',
    default: 30,
    editable: true,
    restartRequired: false,
    description: 'Days of per-request detail to keep (1-3650).',
  },
  retainDailyDays: {
    type: 'integer',
    default: 365,
    editable: true,
    restartRequired: false,
    description: 'Days of daily aggregates to keep (1-3650).',
  },
  flushIntervalMs: {
    type: 'integer',
    default: 5000,
    editable: true,
    restartRequired: false,
    description: 'Write-behind flush interval in milliseconds (500-60000).',
  },
  pricing: {
    type: 'array',
    default: DEFAULT_PRICING,
    editable: true,
    restartRequired: false,
    description: 'Price entries per 1M tokens. The listed values are peak-hour CNY prices (Mon-Fri 09:00-12:00 and 14:00-18:00 Asia/Shanghai); optional `offPeak` overrides apply at all other times, on weekends, and on `pricingOffPeakDays` (official off-peak is half price). Editable here; unmatched calls are recorded as unpriced.',
  },
  pricingOffPeakDays: {
    type: 'array',
    default: DEFAULT_PRICING_OFF_PEAK_DAYS,
    editable: true,
    restartRequired: false,
    description: 'All-day off-peak dates (YYYY-MM-DD, Asia/Shanghai), for example Chinese statutory holidays. Defaults to the official 2026-2027 State Council holiday dates (62 days); refresh it when a new notice is published. Still editable; an explicit empty list disables holiday pricing.',
  },
  webApiPricing: {
    type: 'object',
    default: DEFAULT_WEB_API_PRICING,
    editable: true,
    restartRequired: false,
    description: 'Estimated CNY price per 1000 successful Web API calls: `searchPerThousand` (web_search) and `fetchPerThousand` (web_fetch), plus `currency`. The official DeepSeek Search/Fetch list price is 5 per 1000. Counts are host-observed tool-call successes and are an estimate, never a provider bill.',
  },
  toolGroups: {
    type: 'object',
    default: DEFAULT_TOOL_GROUPS,
    editable: true,
    restartRequired: false,
    description: 'Tool-name groups for attribution: `{ group: [exact name or prefix, ...] }`. A group matches a tool when an entry equals the tool name or is a prefix of it; groups are tried in object order and the first match wins, and unmatched tools fall back to `other:<tool>`. `agentTeams` keeps its historical key and reports as `agent-teams`; any other lowercase/digit/hyphen key (1-32 characters, not `other`) adds a custom group, and an explicit empty array disables a built-in group.',
  },
  maxDetailRowsPerDay: {
    type: 'integer',
    default: 200000,
    editable: true,
    restartRequired: false,
    description: 'Maximum per-request detail rows per day.',
  },
  enableAutoRefresh: {
    type: 'boolean',
    default: false,
    editable: true,
    restartRequired: false,
    description: 'Client panel auto-refresh flag.',
  },
  rememberLastTab: {
    type: 'boolean',
    default: false,
    editable: true,
    restartRequired: false,
    description: 'Remember the last opened usage-panel tab; when off the panel always opens on Overview.',
  },
  autoRefreshIntervalMs: {
    type: 'integer',
    default: 30000,
    editable: true,
    restartRequired: false,
    description: 'Client panel auto-refresh interval (1000-3600000).',
  },
  rpcChannel: {
    type: 'string',
    default: '/token-attribution',
    editable: true,
    restartRequired: true,
    description: 'Connection RPC channel path.',
  },
})

/** RPC channel path rule enforced by the host Connection service. */
const RPC_CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/

/** Price keys accepted in one `pricing` entry. */
const PRICE_KEYS = Object.freeze([
  'provider',
  'model',
  'currency',
  ...PRICE_FIELDS,
  'offPeak',
  'priceVersion',
])

/**
 * Deep-clone the default configuration so callers can mutate their copy.
 * @returns {object} detached default configuration.
 */
export function cloneDefaultConfig() {
  return {
    ...DEFAULT_CONFIG,
    pricing: cloneDefaultPricing(),
    pricingOffPeakDays: [...DEFAULT_CONFIG.pricingOffPeakDays],
    webApiPricing: { ...DEFAULT_WEB_API_PRICING },
    toolGroups: cloneDefaultToolGroups(),
  }
}

/**
 * Describe every Config field for RPC/UI surfaces.
 * @returns {Record<string, {type: string, default: unknown, editable: boolean, restartRequired: boolean, description: string}>} field descriptors keyed by field name.
 */
export function describeConfig() {
  const descriptors = {}
  for (const field of FIELD_ORDER) {
    const source = FIELD_DESCRIPTORS[field]
    descriptors[field] = {
      ...source,
      default: field === 'toolGroups'
        ? cloneDefaultToolGroups()
        : field === 'pricing'
          ? cloneDefaultPricing()
          : field === 'pricingOffPeakDays'
            ? [...DEFAULT_CONFIG.pricingOffPeakDays]
            : field === 'webApiPricing'
              ? { ...DEFAULT_WEB_API_PRICING }
              : source.default,
    }
  }
  return descriptors
}

/**
 * Validate one integer field.
 * @param {object} raw - raw config.
 * @param {object} config - config being built.
 * @param {string[]} diagnostics - diagnostic sink.
 * @param {string} field - field name.
 * @param {number} min - inclusive minimum.
 * @param {number} max - inclusive maximum.
 * @returns {void}
 */
function applyInteger(raw, config, diagnostics, field, min, max) {
  if (!Object.hasOwn(raw, field)) return
  const value = raw[field]
  if (Number.isInteger(value) && value >= min && value <= max) {
    config[field] = value
    return
  }
  diagnostics.push(`${field}: expected an integer in ${min}..${max}; using default ${DEFAULT_CONFIG[field]}`)
}

/**
 * Validate a boolean field.
 * @param {object} raw - raw config.
 * @param {object} config - config being built.
 * @param {string[]} diagnostics - diagnostic sink.
 * @param {string} field - field name.
 * @returns {void}
 */
function applyBoolean(raw, config, diagnostics, field) {
  if (!Object.hasOwn(raw, field)) return
  const value = raw[field]
  if (typeof value === 'boolean') {
    config[field] = value
    return
  }
  diagnostics.push(`${field}: expected a boolean; using default ${DEFAULT_CONFIG[field]}`)
}

/**
 * Validate one optional `offPeak` override object.
 *
 * Only the fields the user supplied are kept, so a missing field keeps falling
 * back to the (possibly later edited) peak value. An absent or empty override
 * is dropped entirely: absent `offPeak` means "off-peak equals peak".
 * @param {unknown} value - raw `offPeak` value.
 * @param {string} at - entry path for diagnostics.
 * @param {string[]} diagnostics - diagnostic sink.
 * @returns {object | undefined} partial off-peak prices, or undefined when absent.
 */
function normalizeOffPeak(value, at, diagnostics) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    diagnostics.push(`${at}.offPeak: expected an object; falling back to the peak prices`)
    return undefined
  }
  const prices = {}
  for (const key of PRICE_FIELDS) {
    const price = value[key]
    if (price === undefined) continue
    if (typeof price === 'number' && Number.isFinite(price) && price >= 0) {
      prices[key] = price
    } else {
      diagnostics.push(`${at}.offPeak.${key}: expected a non-negative number; falling back to the peak price`)
    }
  }
  for (const key of Object.keys(value)) {
    if (!PRICE_FIELDS.includes(key)) diagnostics.push(`${at}.offPeak.${key}: unknown key ignored`)
  }
  return Object.keys(prices).length > 0 ? prices : undefined
}

/**
 * Legacy `priceVersion` written by the M2.1 default table. Rows that exactly
 * match that shipped default gain the official off-peak tier on upgrade, so a
 * profile that saved the old defaults does not stay peak-only. Custom rows and
 * custom peaks are never rewritten.
 */
const LEGACY_M2_1_PRICE_VERSION = 'deepseek-2026-11-peak'

/** Official peak/off-peak values of the legacy default rows. */
const LEGACY_DEFAULT_ROWS = Object.freeze({
  'deepseek-flash': Object.freeze({
    peak: Object.freeze({ inputPerMillion: 2, cacheReadPerMillion: 0.04, cacheWritePerMillion: 0, outputPerMillion: 8 }),
    offPeak: Object.freeze({ inputPerMillion: 1, cacheReadPerMillion: 0.02, cacheWritePerMillion: 0, outputPerMillion: 4 }),
  }),
  'deepseek-v4-pro': Object.freeze({
    peak: Object.freeze({ inputPerMillion: 9, cacheReadPerMillion: 0.3, cacheWritePerMillion: 0, outputPerMillion: 27 }),
    offPeak: Object.freeze({ inputPerMillion: 4.5, cacheReadPerMillion: 0.15, cacheWritePerMillion: 0, outputPerMillion: 13.5 }),
  }),
})

/**
 * Give a saved M2.1 default row its official off-peak tier.
 * @param {{provider: string, model: string, currency: string, priceVersion?: unknown}} row - normalized row identity.
 * @param {{inputPerMillion: number, cacheReadPerMillion: number, cacheWritePerMillion: number, outputPerMillion: number}} prices - peak prices.
 * @returns {{inputPerMillion: number, cacheReadPerMillion: number, cacheWritePerMillion: number, outputPerMillion: number} | undefined} off-peak block or undefined.
 */
function legacyDefaultOffPeak(row, prices) {
  if (row.provider !== 'deepseek-official' || row.currency !== 'CNY') return undefined
  if (row.priceVersion !== LEGACY_M2_1_PRICE_VERSION) return undefined
  const expected = LEGACY_DEFAULT_ROWS[row.model]
  if (expected === undefined) return undefined
  for (const key of PRICE_FIELDS) {
    if (prices[key] !== expected.peak[key]) return undefined
  }
  return { ...expected.offPeak }
}

/**
 * Validate the price table. Invalid entries are dropped with a diagnostic so
 * one malformed row cannot discard the whole table. A non-array value falls
 * back to the built-in default table (like every other invalid field), while an
 * explicit empty array still disables pricing.
 *
 * Per-entry fields are the **peak** prices. An optional `offPeak` object holds
 * the off-peak overrides; its malformed fields are dropped individually (with a
 * diagnostic) so they fall back to peak instead of discarding a valid row.
 * @param {unknown} value - raw `pricing` value.
 * @param {string[]} diagnostics - diagnostic sink.
 * @returns {object[]} normalized price entries.
 */
export function normalizePricing(value, diagnostics) {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    diagnostics.push('pricing: expected an array; using the default price table')
    return cloneDefaultPricing()
  }
  const entries = []
  value.forEach((entry, index) => {
    const at = `pricing[${index}]`
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      diagnostics.push(`${at}: expected an object; entry ignored`)
      return
    }
    if (typeof entry.provider !== 'string' || entry.provider.length === 0) {
      diagnostics.push(`${at}.provider: expected a non-empty string; entry ignored`)
      return
    }
    const model = entry.model === undefined ? '*' : entry.model
    if (typeof model !== 'string' || model.length === 0) {
      diagnostics.push(`${at}.model: expected a non-empty string; entry ignored`)
      return
    }
    const currency = entry.currency === undefined ? 'CNY' : entry.currency
    if (typeof currency !== 'string' || currency.length === 0) {
      diagnostics.push(`${at}.currency: expected a non-empty string; entry ignored`)
      return
    }
    const prices = {}
    let valid = true
    for (const key of PRICE_FIELDS) {
      const price = entry[key]
      if (price === undefined) {
        prices[key] = 0
      } else if (typeof price === 'number' && Number.isFinite(price) && price >= 0) {
        prices[key] = price
      } else {
        diagnostics.push(`${at}.${key}: expected a non-negative number; entry ignored`)
        valid = false
        break
      }
    }
    if (!valid) return
    const offPeak = normalizeOffPeak(entry.offPeak, at, diagnostics)
      ?? legacyDefaultOffPeak({ provider: entry.provider, model, currency, priceVersion: entry.priceVersion }, prices)
    for (const key of Object.keys(entry)) {
      if (!PRICE_KEYS.includes(key)) diagnostics.push(`${at}.${key}: unknown key ignored`)
    }
    entries.push({
      provider: entry.provider,
      model,
      currency,
      inputPerMillion: prices.inputPerMillion,
      cacheReadPerMillion: prices.cacheReadPerMillion,
      cacheWritePerMillion: prices.cacheWritePerMillion,
      outputPerMillion: prices.outputPerMillion,
      ...offPeak === undefined ? {} : { offPeak },
      ...entry.priceVersion === undefined ? {} : { priceVersion: String(entry.priceVersion) },
    })
  })
  return entries
}

/**
 * Validate `pricingOffPeakDays`: an array of Asia/Shanghai `YYYY-MM-DD` day
 * keys. Invalid entries are dropped with a diagnostic (one per entry), duplicate
 * dates are folded into one, an explicit empty array disables holiday pricing,
 * and a missing or non-array value falls back to the default holiday list.
 * @param {unknown} value - raw `pricingOffPeakDays` value.
 * @param {string[]} diagnostics - diagnostic sink.
 * @returns {string[]} normalized off-peak day keys.
 */
export function normalizeOffPeakDays(value, diagnostics) {
  if (value === undefined) return [...DEFAULT_CONFIG.pricingOffPeakDays]
  if (!Array.isArray(value)) {
    diagnostics.push('pricingOffPeakDays: expected an array of YYYY-MM-DD dates; using the default holiday list')
    return [...DEFAULT_CONFIG.pricingOffPeakDays]
  }
  const days = []
  const seen = new Set()
  value.forEach((day, index) => {
    if (typeof day !== 'string' || !isValidDayKey(day)) {
      diagnostics.push(`pricingOffPeakDays[${index}]: expected a valid YYYY-MM-DD date; entry ignored`)
      return
    }
    if (seen.has(day)) return
    seen.add(day)
    days.push(day)
  })
  return days
}

/**
 * Validate the web API price estimate.
 *
 * Both per-thousand prices must be non-negative finite numbers and `currency`
 * must be a non-empty string. A malformed field falls back to its default with
 * one diagnostic (so a valid sibling price is kept), unknown keys are reported,
 * and a non-object value falls back to the whole default block.
 * @param {unknown} value - raw `webApiPricing` value.
 * @param {string[]} diagnostics - diagnostic sink.
 * @returns {{searchPerThousand: number, fetchPerThousand: number, currency: string}} normalized pricing.
 */
export function normalizeWebApiPricing(value, diagnostics) {
  const pricing = { ...DEFAULT_WEB_API_PRICING }
  if (value === undefined) return pricing
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    diagnostics.push('webApiPricing: expected an object; using defaults')
    return pricing
  }
  for (const key of ['searchPerThousand', 'fetchPerThousand']) {
    if (!Object.hasOwn(value, key)) continue
    const price = value[key]
    if (typeof price === 'number' && Number.isFinite(price) && price >= 0) {
      pricing[key] = price
    } else {
      diagnostics.push(`webApiPricing.${key}: expected a non-negative number; using default ${DEFAULT_WEB_API_PRICING[key]}`)
    }
  }
  if (Object.hasOwn(value, 'currency')) {
    if (typeof value.currency === 'string' && value.currency.trim().length > 0) {
      pricing.currency = value.currency.trim()
    } else {
      diagnostics.push(`webApiPricing.currency: expected a non-empty string; using default ${DEFAULT_WEB_API_PRICING.currency}`)
    }
  }
  for (const key of Object.keys(value)) {
    if (!['searchPerThousand', 'fetchPerThousand', 'currency'].includes(key)) {
      diagnostics.push(`webApiPricing.${key}: unknown key ignored`)
    }
  }
  return pricing
}

/**
 * Validate one configured tool-group value.
 *
 * A valid group value is an array of up to `MAX_TOOL_GROUP_ENTRIES` non-empty
 * strings; entries are trimmed. An explicitly empty array is valid and disables
 * the group, while any malformed value falls back to the group's default (or
 * drops a user-defined group).
 * @param {unknown} value - raw group value.
 * @returns {string[] | null} normalized entries, or null when invalid.
 */
function normalizeToolGroupList(value) {
  if (!Array.isArray(value) || value.length > MAX_TOOL_GROUP_ENTRIES) return null
  const list = []
  for (const entry of value) {
    if (typeof entry !== 'string') return null
    const name = entry.trim()
    if (name.length === 0) return null
    list.push(name)
  }
  return list
}

/**
 * Validate `toolGroups` against the defaults.
 *
 * Missing groups keep their defaults. Valid built-in keys are overridden in
 * place; newly supplied custom groups are appended after the built-in groups,
 * so the built-in matching order is preserved and only the relative order among
 * custom groups is user-controlled. Invalid keys, case-insensitive duplicates,
 * and malformed values are reported and skipped, and an explicit empty array
 * disables that group.
 * @param {unknown} value - raw `toolGroups` value.
 * @param {Record<string, string[]>} target - config being built (already cloned defaults).
 * @param {string[]} diagnostics - diagnostic sink.
 * @returns {void}
 */
function applyToolGroups(value, target, diagnostics) {
  if (value === undefined) return
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    diagnostics.push('toolGroups: expected an object; using defaults')
    return
  }
  const seen = new Set(Object.keys(target).map(name => name.toLowerCase()))
  for (const rawName of Object.keys(value)) {
    const name = normalizeToolGroupName(rawName)
    if (name === null) {
      diagnostics.push(`toolGroups.${rawName}: invalid group name; expected lowercase letters, digits, and hyphens (1-32 characters, not all digits, not "other"); group ignored`)
      continue
    }
    const keepsDefault = Object.hasOwn(target, name)
    if (!keepsDefault && seen.has(name.toLowerCase())) {
      diagnostics.push(`toolGroups.${rawName}: duplicate group name (case-insensitive); group ignored`)
      continue
    }
    const list = normalizeToolGroupList(value[rawName])
    if (list === null) {
      diagnostics.push(`toolGroups.${rawName}: expected an array of at most ${MAX_TOOL_GROUP_ENTRIES} non-empty strings; ${keepsDefault ? 'using default' : 'group ignored'}`)
      continue
    }
    target[name] = list
    seen.add(name.toLowerCase())
  }
}

/**
 * Validate and normalize a raw plugin Config.
 *
 * Never throws and never returns a partially invalid config: every field either
 * holds a valid value or its default, with a matching diagnostic string.
 * @param {unknown} raw - raw Config from the profile row (may be undefined).
 * @returns {{config: object, diagnostics: string[]}} normalized config plus diagnostics.
 */
export function normalizeConfig(raw) {
  const config = cloneDefaultConfig()
  const diagnostics = []
  if (raw === undefined || raw === null) return { config, diagnostics }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    diagnostics.push('config: expected an object; using defaults')
    return { config, diagnostics }
  }

  for (const key of Object.keys(raw)) {
    if (!FIELD_ORDER.includes(key)) diagnostics.push(`config: unknown key "${key}" ignored`)
  }

  if (Object.hasOwn(raw, 'dataDir')) {
    if (typeof raw.dataDir === 'string') {
      const value = raw.dataDir.trim()
      if (value === '' || path.isAbsolute(value)) {
        config.dataDir = value
      } else {
        diagnostics.push('dataDir: expected an absolute path or ""; using default ""')
      }
    } else {
      diagnostics.push('dataDir: expected a string; using default ""')
    }
  }

  applyInteger(raw, config, diagnostics, 'retainRequestDays', 1, 3650)
  applyInteger(raw, config, diagnostics, 'retainDailyDays', 1, 3650)
  applyInteger(raw, config, diagnostics, 'flushIntervalMs', 500, 60000)
  applyInteger(raw, config, diagnostics, 'maxDetailRowsPerDay', 1, Number.MAX_SAFE_INTEGER)
  applyInteger(raw, config, diagnostics, 'autoRefreshIntervalMs', 1000, 3600000)
  applyBoolean(raw, config, diagnostics, 'enableAutoRefresh')
  applyBoolean(raw, config, diagnostics, 'rememberLastTab')

  if (Object.hasOwn(raw, 'pricing')) config.pricing = normalizePricing(raw.pricing, diagnostics)
  if (Object.hasOwn(raw, 'pricingOffPeakDays')) {
    config.pricingOffPeakDays = normalizeOffPeakDays(raw.pricingOffPeakDays, diagnostics)
  }
  if (Object.hasOwn(raw, 'webApiPricing')) {
    config.webApiPricing = normalizeWebApiPricing(raw.webApiPricing, diagnostics)
  }
  if (Object.hasOwn(raw, 'toolGroups')) applyToolGroups(raw.toolGroups, config.toolGroups, diagnostics)

  if (Object.hasOwn(raw, 'rpcChannel')) {
    const channel = raw.rpcChannel
    if (typeof channel === 'string' && RPC_CHANNEL_PATTERN.test(channel) && channel !== '/api') {
      config.rpcChannel = channel
    } else {
      diagnostics.push(`rpcChannel: expected a single-segment channel path (for example "/token-attribution"); using default ${DEFAULT_CONFIG.rpcChannel}`)
    }
  }

  return { config, diagnostics }
}
