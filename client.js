/**
 * dsh-token-attribution Web client (M1b; tabbed in M2.6).
 *
 * Loaded by the Harness Client module loader as a single self-contained dynamic
 * module. It registers:
 * - the `token-attribution` locale namespace (zh + en dictionaries),
 * - the keyed `main` panel `token-attribution`,
 * - the matching `sidebar.panellist` entry (icon + localized label).
 *
 * The panel is a full-width dashboard over the Host's Connection RPC channel.
 * M2.6 keeps one sidebar entry and splits the page into seven internal tabs
 * (Overview / Sessions / Models / Sources / Search / Details / Settings); the
 * gear switches to the inline Settings tab, which edits every Config field
 * through `config.set`. M3 adds an in-place single-session drill-down on the
 * Sessions tab only (no extra tab or URL routing): clicking a session title
 * swaps the tree for `SessionDetailView`, and Back restores it. React is the
 * only module import; every style comes from the `--dsw-alias-*` theme tokens
 * (SVG artwork uses `currentColor`).
 */

window.__ModuleLoader__.load({
  id: 'dsh-token-attribution',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'token-attribution'
    const NAMESPACE = 'token-attribution'
    const DEFAULT_CHANNEL = '/token-attribution'
    const CHANNEL_STORAGE_KEY = 'dsh-token-attribution.rpcChannel'
    // M2.6: persist the active tab only when Config.rememberLastTab is on.
    const TAB_STORAGE_KEY = 'dsh-token-attribution.activeTab'
    const PANEL_ORDER = 40
    const RANGES = Object.freeze(['today', '7d', '30d'])
    const MAX_TABLE_ROWS = 20
    // M2.5: the Web API sessions table folds to 10 rows in its full form and
    // never renders more than the Host contract's 100-row cap.
    const WEB_API_SESSION_FOLD = 10
    const WEB_API_SESSION_LIMIT = 100
    // M2.7: the synthetic reconciliation row for calls recorded before M2.5
    // attributed counts per session. It is a layout-only row, never a session.
    const WEB_API_UNATTRIBUTED_ROW = 'unattributed'
    // M2.6 page-internal tabs. The order fixes the tab bar and the sidebar
    // entry still opens the panel on the first tab by default.
    const TAB_IDS = Object.freeze([
      'overview',
      'sessions',
      'models',
      'sources',
      'web',
      'details',
      'settings',
    ])
    const DEFAULT_TAB = 'overview'
    const SETTINGS_TAB = 'settings'
    // M2.6: the overview renders compact Top-5 read-only summaries; the detail
    // tab pages through the Host `requests` endpoint 20 rows at a time.
    const OVERVIEW_TOP_N = 5
    const DETAILS_PAGE_SIZE = 20
    const SESSION_FILTER_LIMIT = 100
    const DETAILS_FILTER_ALL = 'all'
    const UNPRICED_REASON_KEYS = Object.freeze(['aborted', 'transport', 'no-usage', 'no-price', 'other', 'unknown'])
    const DETAILS_PURPOSES = Object.freeze(['chat', 'auto-review', 'compaction', 'session-title'])

    const CONFIG_FIELD_ORDER = Object.freeze([
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
      'rememberLastTab',
      'autoRefreshIntervalMs',
      'rpcChannel',
    ])

    const NUMERIC_RULES = Object.freeze({
      retainRequestDays: { min: 1, max: 3650 },
      retainDailyDays: { min: 1, max: 3650 },
      flushIntervalMs: { min: 500, max: 60000 },
      maxDetailRowsPerDay: { min: 1, max: Number.MAX_SAFE_INTEGER },
      autoRefreshIntervalMs: { min: 1000, max: 3600000 },
    })

    const DEFAULT_TOOL_GROUPS = Object.freeze({
      memory: ['mnemon_'],
      skill: ['skill'],
      agentTeams: [
        'spawn_teammate',
        'send_message',
        'wait_agent',
        'team_task_',
        'list_agents',
        'interrupt_agent',
      ],
      files: ['read', 'write', 'edit', 'glob', 'grep', 'read_image', 'load_workspace_dependencies'],
      shell: ['pwsh', 'bash', 'terminal_'],
      web: ['web_search', 'web_fetch'],
      session: ['session_'],
      goals: ['create_goal', 'update_goal', 'get_goal'],
      schedule: ['schedule_'],
      subagents: ['subagent', 'list_subagent_models'],
      plugins: ['plugin_manager', 'plugin_market', 'cordis_'],
      browser: ['ego_'],
      workflow: ['workflow'],
    })

    // M2.8 default Host groups. The map only drives display: custom group keys
    // fall through to their raw key so user data is never hidden.
    const TOOL_GROUP_LABEL_KEYS = Object.freeze({
      memory: 'toolGroup.memory',
      skill: 'toolGroup.skill',
      'agent-teams': 'toolGroup.agent-teams',
      agentTeams: 'toolGroup.agent-teams',
      files: 'toolGroup.files',
      shell: 'toolGroup.shell',
      web: 'toolGroup.web',
      session: 'toolGroup.session',
      goals: 'toolGroup.goals',
      schedule: 'toolGroup.schedule',
      subagents: 'toolGroup.subagents',
      plugins: 'toolGroup.plugins',
      browser: 'toolGroup.browser',
      workflow: 'toolGroup.workflow',
      history: 'toolGroup.history',
    })

    // Custom group keys are 1–32 lowercase letters/digits/hyphens; `other` is
    // reserved for unmatched tools and `agentTeams` is the legacy camelCase
    // Config key that stays accepted. Mirrors `normalizeToolGroupName` in the
    // Host config normalizer.
    const TOOL_GROUP_KEY_PATTERN = /^(?!\d+$)[a-z0-9-]{1,32}$/u
    const TOOL_GROUP_RESERVED_KEYS = Object.freeze(['other'])
    const TOOL_GROUP_LEGACY_KEYS = Object.freeze(['agentTeams'])
    const TOOL_GROUP_MAX_ENTRIES = 200

    // M2.4 Web API estimate rates: the official DeepSeek Search/Fetch price is
    // 5 CNY per 1,000 successful requests. DSH only sees tool-call outcomes, so
    // the resulting amount is an estimate, never a provider bill.
    const DEFAULT_WEB_API_PRICING = Object.freeze({
      searchPerThousand: 5,
      fetchPerThousand: 5,
      currency: 'CNY',
    })

    // M2.2 off-peak price override: each form field carries the optional
    // off-peak value for one peak-price field. An empty input means "same as
    // peak", so only the fields the user actually filled survive into the
    // Config entry.
    const OFF_PEAK_PRICE_FIELDS = Object.freeze([
      ['offPeakInputPerMillion', 'inputPerMillion'],
      ['offPeakCacheReadPerMillion', 'cacheReadPerMillion'],
      ['offPeakCacheWritePerMillion', 'cacheWritePerMillion'],
      ['offPeakOutputPerMillion', 'outputPerMillion'],
    ])

    const OFF_PEAK_DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u

    // Canonical M2.1 content-source groups, mirroring the Host `byCategoryGroup`
    // mapping. The order fixes legend colors and makes the panel stable while
    // the Host is free to send the map in any order. `auto-review` (M2.10) sits
    // between injected context and the system prompt because its synthetic
    // user-role transcript is re-sent context, not a chat user turn.
    const CATEGORY_GROUPS = Object.freeze([
      'user',
      'assistant',
      'developer',
      'reasoning',
      'tool-call',
      'tool-result',
      'tool-decl',
      'memory',
      'skill',
      'agent-teams',
      'history',
      'injected',
      'auto-review',
      'system',
      'other',
    ])

    const RESTART_FALLBACK_FIELDS = Object.freeze(['dataDir', 'rpcChannel'])
    const RPC_CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/u
    const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/u
    const DANGEROUS_KEYS = Object.freeze(['__proto__', 'prototype', 'constructor'])

    /**
     * Resolve one `{name}` placeholder.
     * @param {string} text - template text.
     * @param {object} [params] - placeholder values.
     * @returns {string} interpolated text.
     */
    function interpolate(text, params) {
      if (typeof text !== 'string' || params === undefined || params === null) return text
      return text.replace(/\{(\w+)\}/g, (match, name) => (
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
      ))
    }

    /**
     * Resolve the language our inline dictionary should use.
     * @param {unknown} language - active locale id.
     * @returns {'zh'|'en'} dictionary language.
     */
    function resolveLanguage(language) {
      return typeof language === 'string' && language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
    }

    /**
     * Build a translator over the Client locale service with an inline fallback.
     *
     * The fallback keeps the panel readable if the locale service returns the
     * bare key (for example before our namespace is registered).
     * @param {object} localeService - `ctx.locale`.
     * @param {unknown} [language] - active language id, if known.
     * @returns {(key: string, params?: object) => string} translator.
     */
    function createTranslator(localeService, language) {
      let bound
      if (localeService !== null && typeof localeService === 'object' && typeof localeService.bind === 'function') {
        try {
          bound = localeService.bind(NAMESPACE)
        } catch {
          bound = undefined
        }
      }
      const own = localeServiceLanguage(localeService, language)
      return function translate(key, params) {
        let value
        if (typeof bound === 'function') {
          try {
            value = bound(key, params)
          } catch {
            value = undefined
          }
        }
        if (typeof value !== 'string' || value === key) {
          const dictionary = LOCALE[own]
          const english = LOCALE.en
          value = Object.prototype.hasOwnProperty.call(dictionary, key)
            ? dictionary[key]
            : Object.prototype.hasOwnProperty.call(english, key)
              ? english[key]
              : key
        }
        return interpolate(value, params)
      }
    }

    /**
     * Read the active language from the locale runtime without assuming a shape.
     * @param {object} localeService - `ctx.locale`.
     * @param {unknown} hint - language supplied by the caller.
     * @returns {'zh'|'en'} dictionary language.
     */
    function localeServiceLanguage(localeService, hint) {
      if (typeof hint === 'string' && hint.length > 0) return resolveLanguage(hint)
      try {
        if (localeService !== null && typeof localeService === 'object' && typeof localeService.getSnapshot === 'function') {
          const snapshot = localeService.getSnapshot()
          if (snapshot !== null && typeof snapshot === 'object' && typeof snapshot.active === 'string') {
            return resolveLanguage(snapshot.active)
          }
        }
      } catch {
        // A locale service that cannot report a snapshot still has a usable bind().
      }
      try {
        if (typeof navigator !== 'undefined' && typeof navigator.language === 'string') {
          return resolveLanguage(navigator.language)
        }
      } catch {
        // No navigator (tests) — fall through to the English default.
      }
      return 'en'
    }

    /**
     * Subscribe a component to locale changes without requiring a specific hook.
     * @param {object} localeService - `ctx.locale`.
     * @returns {object|null} active locale snapshot.
     */
    function useLocaleSnapshot(localeService) {
      const [snapshot, setSnapshot] = React.useState(() => {
        try {
          return typeof localeService?.getSnapshot === 'function' ? localeService.getSnapshot() : null
        } catch {
          return null
        }
      })
      React.useEffect(() => {
        if (typeof localeService?.subscribe !== 'function') return undefined
        const update = () => {
          try {
            setSnapshot(localeService.getSnapshot())
          } catch {
            // Keep the previous snapshot.
          }
        }
        try {
          return localeService.subscribe(update)
        } catch {
          return undefined
        }
      }, [localeService])
      return snapshot
    }

    /**
     * Safe `Object.hasOwn`.
     * @param {unknown} target - candidate object.
     * @param {string} key - key.
     * @returns {boolean} whether target owns key.
     */
    function hasOwn(target, key) {
      return target !== null && typeof target === 'object' && Object.prototype.hasOwnProperty.call(target, key)
    }

    /**
     * Whether a value is a plain object.
     * @param {unknown} value - candidate.
     * @returns {boolean} plain-object test.
     */
    function isPlainObject(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    }

    /**
     * Compare two directory strings as the same path on case-insensitive
     * filesystems (Windows): strip trailing separators and compare folded.
     * @param {string} left - first directory.
     * @param {string} right - second directory.
     * @returns {boolean} whether both name the same directory.
     */
    function sameDirectoryText(left, right) {
      const normalize = value => typeof value === 'string'
        ? value.trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
        : ''
      const a = normalize(left)
      const b = normalize(right)
      return a.length > 0 && a === b
    }

    /**
     * Normalize an error/message value to text.
     * @param {unknown} error - thrown value.
     * @returns {string} message text.
     */
    function errorMessage(error) {
      if (error instanceof Error) return error.message
      return typeof error === 'string' ? error : String(error)
    }

    /**
     * Coerce to a finite number or return a fallback.
     * @param {unknown} value - candidate.
     * @param {number} fallback - fallback value.
     * @returns {number} finite number.
     */
    function numberOr(value, fallback) {
      const number = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(number) ? number : fallback
    }

    /**
     * Coerce a token count to a non-negative number.
     * @param {unknown} value - candidate.
     * @returns {number} non-negative token count.
     */
    function tokenNumber(value) {
      return Math.max(0, numberOr(value, 0))
    }

    /**
     * Coerce a request count to a non-negative integer.
     * @param {unknown} value - candidate.
     * @returns {number} non-negative integer.
     */
    function countNumber(value) {
      return Math.max(0, Math.trunc(numberOr(value, 0)))
    }

    /**
     * Format a token count with grouped digits.
     * @param {unknown} value - token count.
     * @returns {string} grouped count or an em dash.
     */
    function formatTokens(value) {
      const number = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(number)) return '—'
      const rounded = Math.round(number)
      const sign = rounded < 0 ? '-' : ''
      const digits = String(Math.abs(rounded))
      return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    /**
     * Strip a fixed-decimal suffix (`1.00` → `1`, `1.50` → `1.5`).
     * @param {string} text - fixed-point text.
     * @returns {string} text without trailing fraction zeros.
     */
    function stripTrailingZeros(text) {
      return text.includes('.') ? text.replace(/0+$/u, '').replace(/\.$/u, '') : text
    }

    /**
     * Format a token count in a compact human unit.
     *
     * Boundaries: `<1000` stays an integer, then `K` with one decimal, and
     * `M`/`B` with two decimals; trailing zeros are stripped. A value that
     * rounds up to the next unit is promoted (`999,999` → `1M`) instead of
     * producing `1000K`. The output is locale-independent and never grouped.
     * Request counts keep using `formatTokens` (plain grouped integers); the
     * full grouped number belongs in a `title` tooltip where a cell has one.
     * @param {unknown} value - token count.
     * @returns {string} compact count or an em dash.
     */
    function formatCompactTokens(value) {
      const number = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(number)) return '—'
      const rounded = Math.round(number)
      const sign = rounded < 0 ? '-' : ''
      const magnitude = Math.abs(rounded)
      if (magnitude < 1000) return sign + String(magnitude)
      const units = [
        { size: 1e9, suffix: 'B', digits: 2 },
        { size: 1e6, suffix: 'M', digits: 2 },
        { size: 1e3, suffix: 'K', digits: 1 },
      ]
      for (let index = 0; index < units.length; index += 1) {
        const unit = units[index]
        if (magnitude < unit.size) continue
        const fixed = (magnitude / unit.size).toFixed(unit.digits)
        const roundedScaled = Number(fixed)
        if (roundedScaled >= 1000 && index > 0) {
          const next = units[index - 1]
          return sign + stripTrailingZeros((magnitude / next.size).toFixed(next.digits)) + next.suffix
        }
        return sign + stripTrailingZeros(fixed) + unit.suffix
      }
      return sign + String(magnitude)
    }

    /**
     * Render a compact token count whose `title` keeps the full grouped number.
     *
     * Returns a bare string when both forms are identical, so a table cell is
     * not wrapped needlessly for small counts.
     * @param {unknown} value - token count.
     * @returns {string|object} text or a titled span.
     */
    function tokenCell(value) {
      const compact = formatCompactTokens(value)
      const full = formatTokens(value)
      if (compact === full) return compact
      return h('span', { title: full }, compact)
    }

    /**
     * Format a ratio as a percentage.
     * @param {unknown} ratio - ratio in 0..1 (values outside are not clamped).
     * @param {number} [digits] - fixed fraction digits.
     * @returns {string} percentage or an em dash.
     */
    function formatPercent(ratio, digits = 1) {
      const number = typeof ratio === 'number' ? ratio : Number(ratio)
      if (!Number.isFinite(number)) return '—'
      return `${(number * 100).toFixed(digits)}%`
    }

    /**
     * Format a money amount with its configured currency code.
     * @param {unknown} amount - amount.
     * @param {unknown} currency - currency code.
     * @returns {string} formatted amount or an em dash.
     */
    function formatCurrency(amount, currency) {
      const number = typeof amount === 'number' ? amount : Number(amount)
      if (!Number.isFinite(number)) return '—'
      const code = typeof currency === 'string' && currency.trim().length > 0 ? currency.trim() : 'CNY'
      const absolute = Math.abs(number)
      const digits = absolute >= 0.01 || number === 0 ? 2 : 6
      return `${code} ${number.toFixed(digits)}`
    }

    // Fallback mixed-currency marker; the panel always passes its localized
    // label so the visible UI comes from the locale dictionaries.
    const DEFAULT_MIXED_COST = '混币'

    /**
     * Format a money amount compactly for a per-row table cell.
     * @param {number} amount - amount.
     * @returns {string} amount text.
     */
    function formatCostAmount(amount) {
      const absolute = Math.abs(amount)
      const digits = absolute >= 100 ? 0 : absolute >= 1 ? 2 : 3
      return amount.toFixed(digits)
    }

    /**
     * Currency symbol for a table cell (code plus a space when unknown).
     * @param {unknown} currency - currency code.
     * @returns {string} symbol prefix.
     */
    function currencySymbol(currency) {
      const code = typeof currency === 'string' && currency.trim().length > 0 ? currency.trim().toUpperCase() : ''
      const symbols = {
        CNY: '¥',
        RMB: '¥',
        CNH: '¥',
        JPY: '¥',
        USD: '$',
        EUR: '€',
        GBP: '£',
        HKD: 'HK$',
        TWD: 'NT$',
        KRW: '₩',
      }
      if (hasOwn(symbols, code)) return symbols[code]
      return code === '' ? '' : `${code} `
    }

    /**
     * Format one per-row cost cell: `¥0.123` for a priced row, `—` while the
     * row has no configured price, and the mixed-currency marker when the row
     * spans currencies. It never throws and never claims a provider bill.
     * @param {unknown} cost - `{amount,currency,priced,unpricedRequests}` or an amount.
     * @param {unknown} [currency] - fallback currency code.
     * @param {{mixed?: string, unpriced?: string}} [labels] - localized text.
     * @returns {string} cell text.
     */
    function formatCostCell(cost, currency, labels) {
      const mixedLabel = typeof labels?.mixed === 'string' && labels.mixed.length > 0 ? labels.mixed : DEFAULT_MIXED_COST
      const unpricedLabel = typeof labels?.unpriced === 'string' && labels.unpriced.length > 0 ? labels.unpriced : '—'
      let source
      if (typeof cost === 'number') source = { amount: cost, currency, priced: true }
      else if (isPlainObject(cost)) source = cost
      else return unpricedLabel
      const code = typeof source.currency === 'string' && source.currency.length > 0
        ? source.currency
        : typeof currency === 'string' ? currency : ''
      if (code.toLowerCase() === 'mixed') return mixedLabel
      const amount = typeof source.amount === 'number' ? source.amount : Number(source.amount)
      const priced = source.priced === true ? true : source.priced === false ? false : Number.isFinite(amount)
      if (!Number.isFinite(amount) || !priced) return unpricedLabel
      return `${currencySymbol(code)}${formatCostAmount(amount)}`
    }

    /**
     * Format the per-currency cost breakdown for the footnote.
     *
     * The Host never sums amounts across currencies, so each currency is shown
     * on its own as `CNY 0.123 (unpriced 12)`, joined with ` · `. A currency
     * whose requests are all unpriced renders an em dash for the amount instead
     * of a misleading zero.
     * @param {unknown} costByCurrency - `{currency: {amount, priced, unpricedRequests}}`.
     * @param {(key: string, params?: object) => string} t - translator.
     * @returns {string} breakdown text; empty when there is no currency entry.
     */
    function formatCurrencyBreakdown(costByCurrency, t) {
      const map = isPlainObject(costByCurrency) ? costByCurrency : {}
      const parts = []
      for (const currency of Object.keys(map).sort()) {
        const entry = isPlainObject(map[currency]) ? map[currency] : {}
        const amount = numberOr(entry.amount, 0)
        const priced = entry.priced === true || (entry.priced !== false && amount > 0)
        parts.push(t('footnote.costCurrencyItem', {
          currency,
          amount: priced ? formatCostAmount(amount) : t('card.valueUnavailable'),
          count: formatTokens(countNumber(entry.unpricedRequests)),
        }))
      }
      return parts.join(' · ')
    }

    /**
     * Shorten an opaque id for a table cell.
     * @param {unknown} value - id.
     * @param {number} [max] - maximum visible characters.
     * @returns {string} shortened id.
     */
    function shortId(value, max = 10) {
      const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
      if (text.length <= max) return text
      return `${text.slice(0, Math.max(0, max - 1))}…`
    }

    /**
     * Resolve a session row's human-readable label at render time.
     *
     * The ledger never stores titles; the main slot's `useSessions` prop is the
     * only source. `displayTitle` already folds the durable title and the
     * workspace basename, with `title` as a fallback for older/replayed
     * snapshots. Anything unusable falls back to the caller's short-id label.
     * @param {unknown} sessionId - ledger session id.
     * @param {unknown} sessionsById - `state.byId` selector result, or null.
     * @param {string} [fallbackLabel] - label to use when no title is present.
     * @returns {string} display name (never null/undefined).
     */
    function sessionDisplayName(sessionId, sessionsById, fallbackLabel) {
      const fallback = typeof fallbackLabel === 'string' ? fallbackLabel : ''
      if (typeof sessionId !== 'string' || sessionId.length === 0) return fallback
      if (!isPlainObject(sessionsById)) return fallback
      const row = sessionsById[sessionId]
      if (!isPlainObject(row)) return fallback
      for (const field of ['displayTitle', 'title']) {
        const value = row[field]
        if (typeof value === 'string' && value.trim().length > 0) return value.trim()
      }
      return fallback
    }

    /**
     * Whether a value names one of the M2.6 page-internal tabs.
     * @param {unknown} value - candidate tab id.
     * @returns {boolean} validity.
     */
    function isValidTab(value) {
      return typeof value === 'string' && TAB_IDS.includes(value)
    }

    /**
     * Resolve the tab the panel should mount on.
     *
     * The panel always opens on Overview unless Config.rememberLastTab is on
     * *and* browser storage holds a still-valid tab. A missing/failed Config
     * read (undefined/false) therefore reproduces the pre-M2.6 default.
     * @param {unknown} rememberLastTab - Config value.
     * @param {unknown} storedTab - value read from browser storage.
     * @returns {string} a valid tab id.
     */
    function resolveInitialTab(rememberLastTab, storedTab) {
      if (rememberLastTab !== true) return DEFAULT_TAB
      return isValidTab(storedTab) ? storedTab : DEFAULT_TAB
    }

    /**
     * Read the remembered tab; storage failures and unusable values are ignored.
     * @returns {string} a valid tab id, or an empty string when none is stored.
     */
    function readStoredTab() {
      try {
        if (typeof localStorage === 'undefined') return ''
        const value = localStorage.getItem(TAB_STORAGE_KEY)
        return isValidTab(value) ? value : ''
      } catch {
        return ''
      }
    }

    /**
     * Remember the active tab across page reloads; storage failures are ignored.
     * @param {unknown} tab - candidate tab id.
     * @returns {boolean} whether a valid tab was written.
     */
    function writeStoredTab(tab) {
      if (!isValidTab(tab)) return false
      try {
        if (typeof localStorage === 'undefined') return false
        localStorage.setItem(TAB_STORAGE_KEY, tab)
        return true
      } catch {
        return false
      }
    }

    /**
     * Localize a tab id, keeping an unknown Host value as data.
     * @param {(key: string, params?: object) => string} t - translator.
     * @param {unknown} tab - tab id.
     * @returns {string} label.
     */
    function tabLabel(t, tab) {
      const value = isValidTab(tab) ? tab : DEFAULT_TAB
      const key = `tab.${value}`
      const label = t(key)
      return label === key ? value : label
    }

    /**
     * Resolve the tab a roving-tabindex key should focus and activate.
     *
     * ArrowLeft/ArrowRight wrap around the ends; Home/End jump to the first/
     * last tab. Any other key returns null so the browser keeps its default.
     * @param {unknown} current - active tab id.
     * @param {unknown} key - KeyboardEvent.key.
     * @param {unknown} [tabs] - ordered tab ids (defaults to TAB_IDS).
     * @returns {string|null} target tab id, or null when the key is not handled.
     */
    function nextTabId(current, key, tabs = TAB_IDS) {
      const list = Array.isArray(tabs)
        ? tabs.filter(tab => typeof tab === 'string' && tab.length > 0)
        : TAB_IDS
      if (list.length === 0) return null
      const index = list.indexOf(typeof current === 'string' ? current : '')
      if (key === 'Home') return list[0]
      if (key === 'End') return list[list.length - 1]
      if (key === 'ArrowRight') return list[index < 0 ? 0 : (index + 1) % list.length]
      if (key === 'ArrowLeft') return list[index < 0 ? list.length - 1 : (index - 1 + list.length) % list.length]
      return null
    }

    /**
     * Format an epoch millisecond time as a wall-clock time.
     * @param {unknown} value - epoch milliseconds or date string.
     * @returns {string} time text or an em dash.
     */
    function formatTime(value) {
      if (value === null || value === undefined || value === '') return '—'
      const number = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(number) || number <= 0) return '—'
      try {
        return new Date(number).toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      } catch {
        return '—'
      }
    }

    /**
     * Format a date-ish value as `YYYY-MM-DD`.
     * @param {unknown} value - date string or epoch milliseconds.
     * @returns {string} day key or an em dash.
     */
    function formatDate(value) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        if (value <= 0) return '—'
        try {
          return new Date(value).toISOString().slice(0, 10)
        } catch {
          return '—'
        }
      }
      if (typeof value === 'string' && value.length > 0) return value.slice(0, 10)
      return '—'
    }

    /**
     * Format a day key as a compact `MM-DD` axis label.
     * @param {unknown} value - `YYYY-MM-DD`, ISO text, or epoch milliseconds.
     * @returns {string} compact label, or an empty string.
     */
    function formatDayLabel(value) {
      if (typeof value === 'number') {
        if (!Number.isFinite(value) || value <= 0) return ''
        const day = formatDate(value)
        return day === '—' ? '' : day.slice(5)
      }
      if (typeof value !== 'string') return ''
      const text = value.trim()
      if (text === '') return ''
      if (/^\d{4}-\d{2}-\d{2}/u.test(text)) return text.slice(5, 10)
      return text.length > 10 ? text.slice(0, 10) : text
    }

    /**
     * Two-digit zero padding without depending on locale APIs.
     * @param {number} value - number.
     * @returns {string} padded text.
     */
    function pad2(value) {
      return String(value).padStart(2, '0')
    }

    /**
     * Resolve the end day of the visible range (`YYYY-MM-DD`).
     *
     * M2.6 no longer uses it for a per-day drill-down, but it stays a small,
     * testable date helper for range-based callers.
     * @param {unknown} rangeValue - normalized or raw summary range.
     * @returns {string} `YYYY-MM-DD` day, or an empty string.
     */
    function rangeEndDay(rangeValue) {
      const range = normalizeRange(rangeValue)
      if (/^\d{4}-\d{2}-\d{2}/u.test(range.to)) return range.to.slice(0, 10)
      try {
        const now = new Date()
        return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
      } catch {
        return ''
      }
    }

    /**
     * Clamp a number.
     * @param {number} value - value.
     * @param {number} min - minimum.
     * @param {number} max - maximum.
     * @returns {number} clamped value.
     */
    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value))
    }

    /**
     * Whether a path is absolute on either Windows or POSIX (the browser cannot
     * tell the Host platform; the Host re-checks with its own rule).
     * @param {string} value - path text.
     * @returns {boolean} absolute-path test.
     */
    function isAbsolutePath(value) {
      if (typeof value !== 'string' || value.length === 0) return false
      return value.startsWith('/') || WINDOWS_DRIVE.test(value) || value.startsWith('\\\\')
    }

    /**
     * Read the last successful non-default RPC channel from browser storage.
     * @returns {string} channel path or an empty string.
     */
    function readStoredChannel() {
      try {
        if (typeof localStorage === 'undefined') return ''
        const value = localStorage.getItem(CHANNEL_STORAGE_KEY)
        return typeof value === 'string' && RPC_CHANNEL_PATTERN.test(value) && value !== '/api' ? value : ''
      } catch {
        return ''
      }
    }

    /**
     * Remember an RPC channel across page reloads; storage failures are ignored.
     * @param {string} channel - channel path.
     * @returns {void}
     */
    function writeStoredChannel(channel) {
      try {
        if (typeof localStorage === 'undefined') return
        if (typeof channel === 'string' && RPC_CHANNEL_PATTERN.test(channel) && channel !== '/api') {
          localStorage.setItem(CHANNEL_STORAGE_KEY, channel)
        }
      } catch {
        // Storage is optional; the in-memory channel still works.
      }
    }

    /**
     * Unwrap a Connection RPC envelope without throwing.
     *
     * Accepts `{ok:true,value}` and `{ok:false,error:{code,message,details}}`.
     * A malformed envelope becomes a structured `invalid-response` failure so
     * component state never receives `undefined`.
     * @param {unknown} response - raw RPC response.
     * @returns {{ok: true, value: unknown} | {ok: false, error: {code: string, message: string, details: object}}} result.
     */
    function unwrapRpc(response) {
      if (isPlainObject(response) && response.ok === true) {
        if (hasOwn(response, 'value')) return { ok: true, value: response.value }
        return {
          ok: false,
          error: { code: 'invalid-response', message: 'RPC response is missing its value', details: {} },
        }
      }
      if (isPlainObject(response) && response.ok === false && isPlainObject(response.error)) {
        const error = response.error
        return {
          ok: false,
          error: {
            code: typeof error.code === 'string' && error.code.length > 0 ? error.code : 'unknown',
            message: typeof error.message === 'string' ? error.message : '',
            details: isPlainObject(error.details) ? error.details : {},
          },
        }
      }
      return {
        ok: false,
        error: { code: 'invalid-response', message: 'RPC response is not a result envelope', details: {} },
      }
    }

    /**
     * Create the RPC facade used by the panel.
     *
     * `config.get` can report a customized `rpcChannel`; the last successful
     * channel is remembered in browser storage so a reload after a Host restart
     * reconnects without guessing. A transport failure on a customized channel
     * falls back to the default once, which covers a saved-but-not-restarted Host.
     * @param {object|undefined} connection - `ctx.connection`.
     * @returns {object} `{call, getChannel, setChannel}` facade.
     */
    function createRpc(connection) {
      let channel = readStoredChannel() || DEFAULT_CHANNEL

      /**
       * Invoke one channel and unwrap the envelope.
       * @param {string} targetChannel - channel path.
       * @param {string} endpoint - endpoint name.
       * @param {unknown} payload - payload object.
       * @returns {Promise<object>} structured result.
       */
      async function invoke(targetChannel, endpoint, payload) {
        try {
          const response = await connection.rpc.call(targetChannel, endpoint, payload)
          return unwrapRpc(response)
        } catch (error) {
          return {
            ok: false,
            error: { code: 'transport', message: errorMessage(error), details: {} },
          }
        }
      }

      return {
        /**
         * Call one endpoint through the active channel.
         * @param {string} endpoint - endpoint name.
         * @param {object} [payload] - payload object.
         * @returns {Promise<object>} structured result.
         */
        async call(endpoint, payload) {
          if (!isPlainObject(connection) || !isPlainObject(connection.rpc) || typeof connection.rpc.call !== 'function') {
            return {
              ok: false,
              error: { code: 'no-connection', message: 'Connection RPC is unavailable', details: {} },
            }
          }
          let result = await invoke(channel, endpoint, payload ?? {})
          if (!result.ok && result.error.code === 'transport' && channel !== DEFAULT_CHANNEL) {
            const fallback = await invoke(DEFAULT_CHANNEL, endpoint, payload ?? {})
            if (fallback.ok) {
              // Use the default for this session but keep the stored custom
              // channel: it may be the post-restart channel the Host will bind.
              channel = DEFAULT_CHANNEL
            }
            result = fallback
          }
          return result
        },
        /**
         * Read the active channel path.
         * @returns {string} channel path.
         */
        getChannel() {
          return channel
        },
        /**
         * Switch the active channel; valid paths are remembered for reloads.
         * @param {unknown} next - candidate channel path.
         * @param {boolean} [remember] - whether to persist.
         * @returns {boolean} whether the channel changed.
         */
        setChannel(next, remember = true) {
          if (typeof next !== 'string' || !RPC_CHANNEL_PATTERN.test(next) || next === '/api') return false
          channel = next
          if (remember) writeStoredChannel(next)
          return true
        },
      }
    }

    const EXPORT_FORMATS = Object.freeze(['json', 'csv'])

    const DOWNLOAD_ERROR_KEYS = Object.freeze({
      'no-document': 'export.download.noDocument',
      'no-blob': 'export.download.noDocument',
      'no-url': 'export.download.noDocument',
      'empty-content': 'export.download.emptyContent',
      'save-failed': 'export.download.saveFailed',
    })

    /**
     * Normalize an export format.
     * @param {unknown} format - candidate format.
     * @returns {'json'|'csv'} supported format.
     */
    function normalizeExportFormat(format) {
      const value = typeof format === 'string' ? format.trim().toLowerCase() : ''
      return EXPORT_FORMATS.includes(value) ? value : 'json'
    }

    /**
     * Build the `export` RPC payload for the selected range.
     *
     * The Host accepts either a named `range` or explicit `from`/`to`; the
     * panel sends the named range it already displayed and forwards explicit
     * bounds when a caller supplies them.
     * @param {string|{range?: string, from?: string, to?: string, format?: string}} range - selected range.
     * @param {'json'|'csv'} [format] - export format.
     * @returns {{format: string, range: string} | {format: string, from: string, to: string}} payload.
     */
    function exportRequestPayload(range, format) {
      const source = isPlainObject(range) ? range : { range }
      const resolvedFormat = normalizeExportFormat(format ?? source.format)
      const from = typeof source.from === 'string' ? source.from.trim() : ''
      const to = typeof source.to === 'string' ? source.to.trim() : ''
      if (from !== '' && to !== '') return { format: resolvedFormat, from, to }
      const selected = typeof source.range === 'string' && RANGES.includes(source.range) ? source.range : 'today'
      return { format: resolvedFormat, range: selected }
    }

    /**
     * Resolve a safe download filename for an export value.
     * @param {unknown} value - Host export value.
     * @returns {string} filename.
     */
    function exportFilename(value) {
      const source = isPlainObject(value) ? value : {}
      const provided = typeof source.filename === 'string' ? source.filename.trim() : ''
      if (provided !== '') {
        const cleaned = provided.replace(/[\\/:*?"<>|\u0000-\u001f]+/gu, '_')
        if (cleaned !== '' && cleaned !== '.' && cleaned !== '..') return cleaned
      }
      const mediaType = typeof source.mediaType === 'string' ? source.mediaType.toLowerCase() : ''
      const extension = mediaType.includes('csv') ? 'csv' : mediaType.includes('json') ? 'json' : 'txt'
      return `token-attribution-export.${extension}`
    }

    /**
     * Save one Host export value through a temporary anchor element.
     *
     * The document is injectable for tests. Every DOM/Blob/URL access is
     * guarded: a missing capability returns a structured failure instead of
     * throwing, so the panel can render an inline error.
     * @param {unknown} value - `{filename,mediaType,content,bytes,truncated}`.
     * @param {object} [documentRef] - document to use (defaults to globalThis.document).
     * @returns {object} `{ok:true,...}` or `{ok:false, code, message?}`.
     */
    function saveExportFile(value, documentRef) {
      const source = isPlainObject(value) ? value : {}
      const content = typeof source.content === 'string' ? source.content : ''
      const mediaType = typeof source.mediaType === 'string' && source.mediaType.trim().length > 0
        ? source.mediaType.trim()
        : 'application/octet-stream'
      const filename = exportFilename(source)
      if (content.length === 0) return { ok: false, code: 'empty-content' }
      const doc = documentRef !== undefined && documentRef !== null
        ? documentRef
        : (typeof globalThis !== 'undefined' ? globalThis.document : undefined)
      if (doc === null || doc === undefined || typeof doc !== 'object' || typeof doc.createElement !== 'function') {
        return { ok: false, code: 'no-document' }
      }
      try {
        const view = doc.defaultView !== null && typeof doc.defaultView === 'object'
          ? doc.defaultView
          : (typeof globalThis !== 'undefined' ? globalThis : undefined)
        const BlobCtor = view !== undefined && typeof view.Blob === 'function'
          ? view.Blob
          : (typeof globalThis !== 'undefined' && typeof globalThis.Blob === 'function' ? globalThis.Blob : undefined)
        const urlApi = view !== undefined && view.URL !== null && typeof view.URL === 'object'
          ? view.URL
          : (typeof globalThis !== 'undefined' ? globalThis.URL : undefined)
        if (typeof BlobCtor !== 'function') return { ok: false, code: 'no-blob' }
        if (urlApi === null || urlApi === undefined || typeof urlApi.createObjectURL !== 'function') {
          return { ok: false, code: 'no-url' }
        }
        const blob = new BlobCtor([content], { type: mediaType })
        const url = urlApi.createObjectURL(blob)
        const anchor = doc.createElement('a')
        if (anchor === null || typeof anchor !== 'object') return { ok: false, code: 'save-failed' }
        anchor.href = url
        anchor.download = filename
        anchor.rel = 'noopener'
        if (anchor.style !== null && typeof anchor.style === 'object') anchor.style.display = 'none'
        const body = doc.body
        if (body !== null && typeof body === 'object' && typeof body.appendChild === 'function') {
          body.appendChild(anchor)
        }
        const cleanup = () => {
          if (typeof urlApi.revokeObjectURL === 'function') {
            try {
              urlApi.revokeObjectURL(url)
            } catch {
              // Revocation is best effort; the click already happened.
            }
          }
          if (body !== null && typeof body === 'object' && typeof body.removeChild === 'function') {
            try {
              body.removeChild(anchor)
            } catch {
              // The node may already be detached.
            }
          }
        }
        if (typeof anchor.click !== 'function') {
          cleanup()
          return { ok: false, code: 'save-failed' }
        }
        try {
          anchor.click()
        } finally {
          cleanup()
        }
        return {
          ok: true,
          filename,
          mediaType,
          bytes: typeof source.bytes === 'number' && Number.isFinite(source.bytes) ? source.bytes : content.length,
          blobSize: typeof blob.size === 'number' ? blob.size : content.length,
          truncated: source.truncated === true,
        }
      } catch (error) {
        return { ok: false, code: 'save-failed', message: errorMessage(error) }
      }
    }

    /**
     * Localized inline text for an export status.
     * @param {(key: string, params?: object) => string} t - translator.
     * @param {unknown} status - export status value.
     * @returns {string} text (empty when there is nothing to show).
     */
    function exportStatusText(t, status) {
      if (!isPlainObject(status)) return ''
      if (status.kind === 'error') {
        const downloadCode = typeof status.downloadCode === 'string' ? status.downloadCode : ''
        if (downloadCode !== '') {
          const key = DOWNLOAD_ERROR_KEYS[downloadCode]
          return key === undefined ? t('export.download.saveFailed') : t(key)
        }
        return t('export.failed', { message: rpcErrorMessage(t, status.error) })
      }
      if (status.kind === 'saved' || status.kind === 'truncated') {
        const params = {
          filename: String(status.filename ?? ''),
          bytes: formatTokens(status.bytes),
        }
        return status.kind === 'truncated' ? t('export.truncated', params) : t('export.saved', params)
      }
      return ''
    }

    /**
     * Normalize a raw range value (`{from,to}` from the Host, or a label).
     * @param {unknown} raw - raw range.
     * @returns {{from: string, to: string, label: string}} normalized range.
     */
    function normalizeRange(raw) {
      if (isPlainObject(raw)) {
        const from = typeof raw.from === 'string' ? raw.from : ''
        const to = typeof raw.to === 'string' ? raw.to : ''
        return { from, to, label: from !== '' || to !== '' ? `${from || '…'} – ${to || '…'}` : '' }
      }
      if (typeof raw === 'string') return { from: '', to: '', label: raw }
      return { from: '', to: '', label: '' }
    }

    /**
     * List key/entry pairs from an object map or an array of named entries.
     * @param {unknown} raw - map or array.
     * @returns {Array<[string, object]>} entries.
     */
    function mapEntries(raw) {
      if (Array.isArray(raw)) {
        return raw.map((entry, index) => {
          if (!isPlainObject(entry)) return [String(index), {}]
          const key = typeof entry.key === 'string'
            ? entry.key
            : typeof entry.purpose === 'string'
              ? entry.purpose
              : typeof entry.category === 'string'
                ? entry.category
                : typeof entry.name === 'string'
                  ? entry.name
                  : String(index)
          return [key, entry]
        })
      }
      if (isPlainObject(raw)) return Object.entries(raw)
      return []
    }

    /**
     * Normalize one cost value.
     * @param {unknown} raw - cost object or bare amount.
     * @param {unknown} [fallbackCurrency] - currency code used when absent.
     * @returns {object|null} normalized cost, or null when the Host sent none.
     */
    function normalizeCost(raw, fallbackCurrency) {
      const fallback = typeof fallbackCurrency === 'string' && fallbackCurrency.trim().length > 0
        ? fallbackCurrency.trim()
        : 'CNY'
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        return { amount: raw, currency: fallback, priced: true, unpricedRequests: 0 }
      }
      if (!isPlainObject(raw)) return null
      const rawCurrency = typeof raw.currency === 'string' && raw.currency.trim().length > 0
        ? raw.currency.trim()
        : fallback
      const currency = rawCurrency.toLowerCase() === 'mixed' ? 'mixed' : rawCurrency
      const amountValue = Number(raw.amount)
      const amount = Number.isFinite(amountValue) ? amountValue : 0
      const unpricedRequests = countNumber(raw.unpricedRequests)
      const priced = raw.priced === true
        ? true
        : raw.priced === false
          ? false
          : amount > 0 || unpricedRequests === 0
      return { amount, currency, priced, unpricedRequests }
    }

    /**
     * Normalize the Host's unpriced-reason counter map.
     * @param {unknown} raw - `{reason: count}` map.
     * @returns {Record<string, number>} normalized counts.
     */
    function normalizeUnpricedReasons(raw) {
      const result = {}
      if (!isPlainObject(raw)) return result
      for (const reason of UNPRICED_REASON_KEYS) {
        const count = countNumber(raw[reason])
        if (count > 0) result[reason] = count
      }
      return result
    }

    /**
     * Render the unpriced reason breakdown, e.g. `中断 9 · 传输失败 4`.
     * @param {(key: string, params?: object) => string} t - translator.
     * @param {unknown} raw - unpriced reason counts.
     * @returns {string} joined reason text, or '' when no counts.
     */
    function unpricedReasonsText(t, raw) {
      const reasons = normalizeUnpricedReasons(raw)
      return UNPRICED_REASON_KEYS
        .filter(reason => (reasons[reason] ?? 0) > 0)
        .map(reason => t('unpriced.reasonItem', {
          label: t(`unpriced.${reason}`),
          count: formatTokens(reasons[reason]),
        }))
        .join(' · ')
    }

    /**
     * Normalize `totals.costByCurrency` into a currency-keyed map.
     * @param {unknown} raw - map or array of cost values.
     * @returns {Record<string, object>} normalized map.
     */
    function normalizeCostMap(raw) {
      const result = {}
      for (const [key, entry] of mapEntries(raw)) {
        if (key === '' || DANGEROUS_KEYS.includes(key)) continue
        const normalized = normalizeCost(entry, key)
        if (normalized !== null) result[key] = normalized
      }
      return result
    }

    /**
     * Normalize `byPurpose` into a keyed map.
     * @param {unknown} raw - raw `byPurpose`.
     * @returns {Record<string, {requests: number, promptTokens: number, outputTokens: number, tokens: number}>} normalized map.
     */
    function normalizePurposeMap(raw) {
      const result = {}
      for (const [key, entry] of mapEntries(raw)) {
        if (key === '' || DANGEROUS_KEYS.includes(key)) continue
        const record = isPlainObject(entry) ? entry : {}
        const promptTokens = tokenNumber(record.promptTokens)
        const outputTokens = tokenNumber(record.outputTokens)
        result[key] = {
          requests: countNumber(record.requests),
          promptTokens,
          outputTokens,
          tokens: tokenNumber(record.tokens) || promptTokens + outputTokens,
          cost: normalizeCost(record.cost, record.currency),
        }
      }
      return result
    }

    /**
     * Normalize `byCategory` into a keyed token map.
     * @param {unknown} raw - raw `byCategory`.
     * @returns {Record<string, number>} normalized map.
     */
    function normalizeCategoryMap(raw) {
      const result = {}
      for (const [key, value] of mapEntries(raw)) {
        if (key === '' || DANGEROUS_KEYS.includes(key)) continue
        const number = isPlainObject(value)
          ? tokenNumber(value.tokens ?? value.value ?? value.promptTokens)
          : tokenNumber(value)
        result[key] = number
      }
      return result
    }

    /**
     * Map one raw attribution category key to its M2.1 content-source group.
     *
     * This mirrors the Host `categoryGroup` mapping exactly (see
     * `src/host/rules.mjs`) so an older Host that only sends `byCategory`
     * derives the same groups the Host would aggregate:
     * - `reasoning-replay` → reasoning; `user`/`assistant-text`/`developer-message`;
     * - `tool-call-args` → tool-call; every `tool-result:*` stays tool-result;
     * - `tools:memory|skill|agent-teams|history` keep their group, every other
     *   `tools:*` is a tool declaration;
     * - `injected:memory*`/`injected:skill*` join memory/skill,
     *   `injected:auto-review` is its own auto-review group (M2.10), and other
     *   injected keys stay injected; `system:mnemon*` joins memory, other
     *   system keys stay system; anything else (including `assistant-other`
     *   and unknown long-tail) is other.
     * @param {unknown} key - raw category key (e.g. `tools:memory`).
     * @returns {string} one of `CATEGORY_GROUPS`.
     */
    function categoryGroup(key) {
      const value = typeof key === 'string' ? key : ''
      if (value === 'reasoning-replay') return 'reasoning'
      if (value === 'user') return 'user'
      if (value === 'assistant-text') return 'assistant'
      if (value === 'developer-message') return 'developer'
      if (value === 'tool-call-args') return 'tool-call'
      if (value.startsWith('tool-result:')) return 'tool-result'
      if (value.startsWith('tools:')) {
        const name = value.slice('tools:'.length)
        if (name === 'memory') return 'memory'
        if (name === 'skill') return 'skill'
        if (name === 'agent-teams') return 'agent-teams'
        if (name === 'history') return 'history'
        return 'tool-decl'
      }
      if (value.startsWith('injected:')) {
        const name = value.slice('injected:'.length)
        if (name.startsWith('memory')) return 'memory'
        if (name.startsWith('skill')) return 'skill'
        if (name === 'auto-review') return 'auto-review'
        return 'injected'
      }
      if (value.startsWith('system:')) {
        const name = value.slice('system:'.length)
        if (name.startsWith('mnemon')) return 'memory'
        return 'system'
      }
      return 'other'
    }

    /**
     * Sum a raw category map into content-source groups.
     * @param {unknown} byCategory - raw or normalized category token map.
     * @returns {Record<string, number>} group token map.
     */
    function groupCategoryTokens(byCategory) {
      const groups = {}
      for (const [key, value] of Object.entries(isPlainObject(byCategory) ? byCategory : {})) {
        if (key === '' || DANGEROUS_KEYS.includes(key)) continue
        const tokens = isPlainObject(value)
          ? tokenNumber(value.tokens ?? value.value ?? value.promptTokens)
          : tokenNumber(value)
        if (tokens <= 0) continue
        const group = categoryGroup(key)
        groups[group] = (groups[group] ?? 0) + tokens
      }
      return groups
    }

    /**
     * Normalize `summary.byCategoryGroup`, deriving it from `byCategory` when
     * the Host does not send the grouped map (pre-M2.1 Host).
     * @param {unknown} raw - raw `byCategoryGroup` (map or `[{group,tokens}]`).
     * @param {unknown} byCategory - normalized raw category map.
     * @returns {Record<string, number>} normalized group token map.
     */
    function normalizeCategoryGroups(raw, byCategory) {
      const groups = {}
      const pairs = isPlainObject(raw)
        ? Object.entries(raw)
        : Array.isArray(raw)
          ? raw.map((entry, index) => {
            if (!isPlainObject(entry)) return ['', entry]
            const key = typeof entry.group === 'string'
              ? entry.group
              : typeof entry.key === 'string' ? entry.key : String(index)
            return [key, entry]
          })
          : []
      let hasRaw = false
      for (const [group, value] of pairs) {
        if (typeof group !== 'string' || group === '' || DANGEROUS_KEYS.includes(group)) continue
        const tokens = isPlainObject(value)
          ? tokenNumber(value.tokens ?? value.value ?? value.promptTokens)
          : tokenNumber(value)
        groups[group] = tokens
        hasRaw = true
      }
      return hasRaw ? groups : groupCategoryTokens(byCategory)
    }

    /**
     * Localize a content-source group, keeping unknown Host groups as data.
     * @param {(key: string, params?: object) => string} t - translator.
     * @param {unknown} group - group key.
     * @returns {string} label.
     */
    function categoryGroupLabel(t, group) {
      const value = typeof group === 'string' ? group : ''
      if (value === '') return t('categoryGroup.other')
      const key = `categoryGroup.${value}`
      const label = t(key)
      return label === key ? value : label
    }

    /**
     * Build stacked-bar entries for every group that has tokens, in canonical
     * order (then any forward-compatible unknown groups). Unlike the old top-6
     * grouping, this keeps memory, skill and Agent Teams visible.
     * @param {unknown} byCategoryGroup - normalized group token map.
     * @param {(key: string, params?: object) => string} t - translator.
     * @returns {Array<{key: string, label: string, value: number}>} entries.
     */
    function categoryGroupEntries(byCategoryGroup, t) {
      const map = isPlainObject(byCategoryGroup) ? byCategoryGroup : {}
      const entries = []
      const known = new Set(CATEGORY_GROUPS)
      for (const group of CATEGORY_GROUPS) {
        const tokens = tokenNumber(map[group])
        if (tokens > 0) entries.push({ key: group, label: categoryGroupLabel(t, group), value: tokens })
      }
      for (const [group, value] of Object.entries(map)) {
        if (known.has(group)) continue
        const tokens = tokenNumber(value)
        if (tokens > 0) entries.push({ key: group, label: categoryGroupLabel(t, group), value: tokens })
      }
      return entries
    }

    /**
     * Normalize `summary.byToolGroup` into a keyed token map.
     *
     * The Host sends a map (tool group → prompt tokens); object-shaped values
     * are accepted for forward compatibility and a pre-M2.6 Host that omits the
     * field yields an empty map so the Sources tab renders its empty state.
     * @param {unknown} raw - raw `byToolGroup` value.
     * @returns {Record<string, number>} normalized map.
     */
    function normalizeToolGroupMap(raw) {
      const result = {}
      for (const [key, value] of mapEntries(raw)) {
        if (key === '' || DANGEROUS_KEYS.includes(key)) continue
        const tokens = isPlainObject(value)
          ? tokenNumber(value.tokens ?? value.value ?? value.promptTokens)
          : tokenNumber(value)
        result[key] = tokens
      }
      return result
    }

    /**
     * Localize a tool group key.
     *
     * The M2.8 Host groups tool declarations/results into the built-in groups
     * (`memory`, `skill`, `agent-teams`/`agentTeams`, `files`, `shell`, `web`,
     * `session`, `goals`, `schedule`, `subagents`, `plugins`, `browser`,
     * `workflow`, plus `history` for legacy records), arbitrary user-defined
     * groups, or `other:<toolName>`. A custom or unknown future group stays
     * visible as its raw key so data is never hidden.
     * @param {(key: string, params?: object) => string} t - translator.
     * @param {unknown} key - tool group key.
     * @returns {string} label.
     */
    function toolGroupLabel(t, key) {
      const value = typeof key === 'string' ? key : ''
      if (hasOwn(TOOL_GROUP_LABEL_KEYS, value)) {
        const localeKey = TOOL_GROUP_LABEL_KEYS[value]
        const label = t(localeKey)
        return label === localeKey ? value : label
      }
      if (value.startsWith('other:') && value.length > 'other:'.length) {
        return t('toolGroup.other', { name: value.slice('other:'.length) })
      }
      if (value === 'unknown') return t('toolGroup.unknown')
      return value === '' ? t('toolGroup.unknown') : value
    }

    /**
     * Build the tool-group breakdown rows for the Sources tab.
     *
     * `share` is the fraction of the measured prompt (0 when the range has no
     * prompt tokens); rows sort by tokens descending with a deterministic key
     * tie-break. Values render compactly through the shared formatter.
     * @param {unknown} byToolGroup - normalized tool-group token map.
     * @param {unknown} totalPromptTokens - denominator (`totals.promptTokens`).
     * @param {(key: string, params?: object) => string} t - translator.
     * @returns {Array<{key: string, label: string, tokens: number, share: number}>} rows.
     */
    function toolGroupRows(byToolGroup, totalPromptTokens, t) {
      const map = isPlainObject(byToolGroup) ? byToolGroup : {}
      const total = tokenNumber(totalPromptTokens)
      const rows = []
      for (const [key, value] of Object.entries(map)) {
        if (key === '' || DANGEROUS_KEYS.includes(key)) continue
        const tokens = tokenNumber(value)
        rows.push({
          key,
          label: toolGroupLabel(t, key),
          tokens,
          share: total > 0 ? tokens / total : 0,
        })
      }
      rows.sort((left, right) => (right.tokens - left.tokens) || left.key.localeCompare(right.key))
      return rows
    }

    /**
     * Normalize the Host's session rows, accepting both the real Host shape
     * (`tokens`) and the documented split shape (`promptTokens`/`outputTokens`).
     *
     * M2.1 keeps every row (up to the Host's 500-session cap) so the client can
     * rebuild the parent/child tree; the tree table does the top-level sorting.
     * @param {unknown} raw - raw `bySession`.
     * @returns {Array<object>} session rows sorted by own tokens.
     */
    function normalizeSessions(raw) {
      if (!Array.isArray(raw)) return []
      const sessions = []
      for (const entry of raw) {
        const row = normalizeSessionRow(entry)
        if (row !== null) sessions.push(row)
      }
      sessions.sort((left, right) => right.tokens - left.tokens)
      return sessions
    }

    /**
     * Normalize one Host `bySession` row (or the M3 `sessionDetail.session`
     * echo). The same shape feeds the tree, the drill-down header, and the
     * direct-child list, so every field is coerced once here.
     * @param {unknown} entry - raw session row.
     * @returns {object|null} normalized row, or null for a malformed/empty row.
     */
    function normalizeSessionRow(entry) {
      if (!isPlainObject(entry)) return null
      const hasSplit = typeof entry.promptTokens === 'number' || typeof entry.outputTokens === 'number'
      const promptTokens = hasSplit ? tokenNumber(entry.promptTokens) : null
      const outputTokens = hasSplit ? tokenNumber(entry.outputTokens) : null
      const tokens = tokenNumber(entry.tokens) || (hasSplit ? promptTokens + outputTokens : 0)
      if (tokens === 0 && countNumber(entry.requests) === 0) return null
      const rawCache = isPlainObject(entry.cache) ? entry.cache : {}
      return {
        sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : '',
        parentSessionId: typeof entry.parentSessionId === 'string' && entry.parentSessionId.length > 0
          ? entry.parentSessionId
          : null,
        depth: countNumber(entry.depth),
        requests: countNumber(entry.requests),
        promptTokens,
        outputTokens,
        tokens,
        cache: {
          input: tokenNumber(rawCache.input),
          read: tokenNumber(rawCache.read),
          write: tokenNumber(rawCache.write),
        },
        cost: normalizeCost(entry.cost, entry.currency),
      }
    }

    /**
     * Cache hit rate for one session aggregate.
     * @param {unknown} cache - `{input, read, write}` token counts.
     * @returns {number|null} `read / (input + read + write)`, or null when the denominator is zero.
     */
    function sessionCacheRate(cache) {
      const value = isPlainObject(cache) ? cache : {}
      const input = tokenNumber(value.input)
      const read = tokenNumber(value.read)
      const write = tokenNumber(value.write)
      const total = input + read + write
      return total > 0 ? read / total : null
    }

    /**
     * Combine two per-session cost values without summing across currencies.
     * @param {object|null} current - accumulated cost.
     * @param {object|null} incoming - child cost.
     * @returns {object|null} merged cost (`currency: 'mixed'` for mixed rows).
     */
    function mergeSubtreeCost(current, incoming) {
      if (incoming === null || incoming === undefined) return current
      if (current === null || current === undefined) return { ...incoming }
      const unpricedRequests = countNumber(current.unpricedRequests) + countNumber(incoming.unpricedRequests)
      if (current.currency !== incoming.currency) {
        return { amount: 0, currency: 'mixed', priced: true, unpricedRequests }
      }
      const amount = numberOr(current.amount, 0) + numberOr(incoming.amount, 0)
      return {
        amount,
        currency: current.currency,
        priced: amount > 0 || current.priced === true || incoming.priced === true,
        unpricedRequests,
      }
    }

    /**
     * Empty subtree aggregate.
     * @returns {object} zeroed stats.
     */
    function emptySubtreeStats() {
      return {
        promptTokens: 0,
        outputTokens: 0,
        splitAvailable: false,
        tokens: 0,
        requests: 0,
        cost: null,
        cache: { input: 0, read: 0, write: 0 },
        cacheRate: null,
        descendants: 0,
      }
    }

    /**
     * Aggregate one session node and every descendant: tokens, requests, cost,
     * cache buckets and cache rate. Pure: the input node is never mutated.
     * @param {unknown} node - tree node (or a plain `{tokens,requests,...}` row).
     * @returns {object} subtree stats.
     */
    function subtreeStats(node) {
      const stats = emptySubtreeStats()
      if (!isPlainObject(node)) return stats
      const splitAvailable = (node.promptTokens !== undefined && node.promptTokens !== null)
        || (node.outputTokens !== undefined && node.outputTokens !== null)
      const promptTokens = splitAvailable ? tokenNumber(node.promptTokens) : 0
      const outputTokens = splitAvailable ? tokenNumber(node.outputTokens) : 0
      stats.promptTokens = promptTokens
      stats.outputTokens = outputTokens
      stats.splitAvailable = splitAvailable
      stats.tokens = tokenNumber(node.tokens) || promptTokens + outputTokens
      stats.requests = countNumber(node.requests)
      const cache = isPlainObject(node.cache) ? node.cache : {}
      stats.cache = {
        input: tokenNumber(cache.input),
        read: tokenNumber(cache.read),
        write: tokenNumber(cache.write),
      }
      stats.cost = normalizeCost(node.cost, node.currency)
      for (const child of Array.isArray(node.children) ? node.children : []) {
        const childStats = subtreeStats(child)
        if (childStats.splitAvailable) stats.splitAvailable = true
        stats.promptTokens += childStats.promptTokens
        stats.outputTokens += childStats.outputTokens
        stats.tokens += childStats.tokens
        stats.requests += childStats.requests
        stats.descendants += 1 + childStats.descendants
        stats.cache.input += childStats.cache.input
        stats.cache.read += childStats.cache.read
        stats.cache.write += childStats.cache.write
        stats.cost = mergeSubtreeCost(stats.cost, childStats.cost)
      }
      stats.cacheRate = sessionCacheRate(stats.cache)
      return stats
    }

    /**
     * Rebuild the parent/child session tree from `summary.bySession`.
     *
     * Roots are rows whose parent is absent, null, self-referential, or inside a
     * parent cycle; a cycle is broken by detaching its first visited node, so
     * every row stays in the tree exactly once and no row is dropped. Siblings
     * (and roots) are sorted by subtree tokens descending, with the node key as
     * a deterministic tie-break. `node.subtree` holds the aggregated stats used
     * by the table, and `node.level` is the visual indentation depth.
     * @param {unknown} bySession - raw or normalized `bySession` rows.
     * @returns {{roots: Array<object>, nodes: Array<object>}} tree.
     */
    function buildSessionTree(bySession) {
      const rows = normalizeSessions(bySession)
      const nodes = []
      const byId = new Map()
      rows.forEach((row, index) => {
        let key
        let firstForId = false
        if (row.sessionId === '') {
          key = `__session-${index}`
        } else if (!byId.has(row.sessionId)) {
          key = row.sessionId
          firstForId = true
        } else {
          key = `${row.sessionId}#${index}`
        }
        const node = { ...row, key, parentKey: null, children: [], level: 0, subtree: null }
        nodes.push(node)
        if (firstForId) byId.set(row.sessionId, node)
      })
      const byKey = new Map(nodes.map(node => [node.key, node]))
      const roots = []
      for (const node of nodes) {
        const parentId = node.parentSessionId
        const parent = typeof parentId === 'string' && parentId.length > 0 && parentId !== node.sessionId
          ? byId.get(parentId)
          : undefined
        if (parent !== undefined && parent !== node) {
          node.parentKey = parent.key
          parent.children.push(node)
        } else {
          roots.push(node)
        }
      }
      // Break parent cycles: following parentKey must terminate; when it loops,
      // detach the visited node so the loop becomes a normal root→child chain.
      for (const node of nodes) {
        const seen = new Set()
        let cursor = node
        while (cursor !== null && !seen.has(cursor.key)) {
          seen.add(cursor.key)
          cursor = cursor.parentKey === null ? null : byKey.get(cursor.parentKey) ?? null
        }
        if (cursor !== null && node.parentKey !== null) {
          const parent = byKey.get(node.parentKey)
          if (parent !== undefined) parent.children = parent.children.filter(child => child !== node)
          node.parentKey = null
          roots.push(node)
        }
      }
      const assignLevel = (node, level, seen) => {
        if (seen.has(node.key)) return
        seen.add(node.key)
        node.level = level
        for (const child of node.children) assignLevel(child, level + 1, seen)
      }
      for (const root of roots) assignLevel(root, 0, new Set())
      const finalize = node => {
        for (const child of node.children) finalize(child)
        node.subtree = subtreeStats(node)
      }
      for (const root of roots) finalize(root)
      const sortSiblings = list => {
        for (const node of list) sortSiblings(node.children)
        list.sort((left, right) => (right.subtree.tokens - left.subtree.tokens)
          || left.key.localeCompare(right.key))
      }
      sortSiblings(roots)
      return { roots, nodes }
    }

    /**
     * Flatten the visible part of a session tree: every root, plus the direct
     * children of each expanded node (recursively). Collapsed children are
     * hidden with their own descendants, matching the chevron behavior.
     * @param {object|Array<object>} tree - result of `buildSessionTree` (or a root array).
     * @param {unknown} expanded - map of expanded node keys.
     * @returns {Array<object>} visible nodes.
     */
    function sessionTreeRows(tree, expanded) {
      const roots = Array.isArray(tree) ? tree : Array.isArray(tree?.roots) ? tree.roots : []
      const open = isPlainObject(expanded) ? expanded : {}
      const rows = []
      const walk = list => {
        for (const node of list) {
          rows.push(node)
          if (node.children.length > 0 && open[node.key] === true) walk(node.children)
        }
      }
      walk(roots)
      return rows
    }

    /**
     * Normalize model rows.
     * @param {unknown} raw - raw `byModel`.
     * @returns {Array<object>} model rows sorted by tokens.
     */
    function normalizeModels(raw) {
      if (!Array.isArray(raw)) return []
      const models = []
      for (const entry of raw) {
        if (!isPlainObject(entry)) continue
        const promptTokens = tokenNumber(entry.promptTokens)
        const outputTokens = tokenNumber(entry.outputTokens)
        const tokens = tokenNumber(entry.tokens) || promptTokens + outputTokens
        if (tokens === 0 && countNumber(entry.requests) === 0) continue
        models.push({
          provider: typeof entry.provider === 'string' ? entry.provider : '',
          model: typeof entry.model === 'string' ? entry.model : '',
          requests: countNumber(entry.requests),
          promptTokens,
          outputTokens,
          tokens,
          cost: normalizeCost(entry.cost, entry.currency),
        })
      }
      models.sort((left, right) => right.tokens - left.tokens)
      return models.slice(0, MAX_TABLE_ROWS)
    }

    /**
     * Normalize `byDay` rows, oldest first.
     * @param {unknown} raw - raw `byDay` array.
     * @returns {Array<object>} day rows.
     */
    function normalizeDays(raw) {
      if (!Array.isArray(raw)) return []
      const days = []
      for (const entry of raw) {
        if (!isPlainObject(entry)) continue
        const day = formatDate(entry.day ?? entry.date)
        if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) continue
        const promptTokens = tokenNumber(entry.promptTokens)
        const outputTokens = tokenNumber(entry.outputTokens)
        const tokens = tokenNumber(entry.tokens) || promptTokens + outputTokens
        days.push({
          day,
          requests: countNumber(entry.requests),
          promptTokens,
          outputTokens,
          tokens,
          estimatedRequests: countNumber(entry.estimatedRequests),
          cost: normalizeCost(entry.cost, entry.currency),
        })
      }
      days.sort((left, right) => (left.day < right.day ? -1 : left.day > right.day ? 1 : 0))
      return days
    }

    /**
     * Classify an unpriced request for display.
     *
     * Mirrors the Host's reason keys: aborted/transport/no-usage/no-price.
     * A priced row returns an empty key.
     * @param {object} entry - raw or normalized request row.
     * @returns {string} reason key or ''.
     */
    function requestUnpricedReason(entry) {
      if (entry?.cost?.priced === true) return ''
      const code = String(entry?.error?.code ?? entry?.error ?? '').toUpperCase()
      if (code === 'ABORTED') return 'aborted'
      if (code === 'TRANSPORT' || code === 'TIMEOUT' || code === 'NETWORK'
        || code === 'ECONNRESET' || code === 'ETIMEDOUT') return 'transport'
      if (entry?.usage == null || entry?.usageEstimated === true) return 'no-usage'
      return 'no-price'
    }

    /**
     * Normalize the Host's `requests` page.
     *
     * Detail rows carry numbers and category names only; the ledger never
     * stores prompt or result text. M2.6 adds the optional `sessionId` so the
     * Details tab can resolve a render-time title; `startIndex` shifts the
     * generated row key so appended pages never collide.
     * @param {unknown} raw - `{items,total}` or a bare row array.
     * @param {number} [startIndex] - number of rows already rendered before this page.
     * @returns {{items: Array<object>, total: number}} page.
     */
    function normalizeRequests(raw, startIndex = 0) {
      const value = isPlainObject(raw) ? raw : {}
      const rows = Array.isArray(value.items) ? value.items : Array.isArray(raw) ? raw : []
      const offset = Number.isInteger(startIndex) && startIndex > 0 ? startIndex : 0
      const items = []
      for (const entry of rows) {
        if (!isPlainObject(entry)) continue
        const ts = numberOr(entry.ts ?? entry.time ?? entry.at ?? entry.timestamp ?? entry.createdAt, 0)
        const purpose = typeof entry.purpose === 'string' && entry.purpose.length > 0 ? entry.purpose : 'chat'
        items.push({
          key: `${offset + items.length}-${ts}`,
          ts,
          purpose,
          sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : '',
          promptTokens: tokenNumber(entry.promptTokens ?? entry.prompt),
          outputTokens: tokenNumber(entry.outputTokens ?? entry.output),
          cacheReadTokens: tokenNumber(entry.cacheReadTokens ?? entry.cacheRead ?? entry.usage?.cacheRead),
          cost: normalizeCost(entry.cost, entry.currency),
          unpricedReason: requestUnpricedReason(entry),
        })
      }
      items.sort((left, right) => right.ts - left.ts)
      const total = countNumber(value.total) || items.length
      return { items: items.slice(0, MAX_TABLE_ROWS), total }
    }

    /**
     * Build the `requests` RPC payload for the Details tab.
     *
     * Always forwards the visible summary range and paging window; the optional
     * purpose/session filters are omitted for `all` (and for empty values) so a
     * pre-M2.6 Host receives exactly the old shape when no filter is active.
     * `sessionId` is only sent for a concrete selection, never for `all`.
     * @param {unknown} range - normalized `summary.range`.
     * @param {{limit?: number, offset?: number, purpose?: unknown, sessionId?: unknown}} [options] - paging and filters.
     * @returns {{from: string, to: string, limit: number, offset: number, purpose?: string, sessionId?: string}} payload.
     */
    function detailsRequestPayload(range, options) {
      const source = isPlainObject(range) ? range : {}
      const opts = isPlainObject(options) ? options : {}
      const from = typeof source.from === 'string' ? source.from : ''
      const to = typeof source.to === 'string' ? source.to : ''
      const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : DETAILS_PAGE_SIZE
      const offset = Number.isInteger(opts.offset) && opts.offset > 0 ? opts.offset : 0
      const payload = { from, to, limit, offset }
      const purpose = typeof opts.purpose === 'string' ? opts.purpose.trim() : ''
      if (purpose !== '' && purpose !== DETAILS_FILTER_ALL) payload.purpose = purpose
      const sessionId = typeof opts.sessionId === 'string' ? opts.sessionId.trim() : ''
      if (sessionId !== '' && sessionId !== DETAILS_FILTER_ALL) payload.sessionId = sessionId
      if (opts.unpricedOnly === true) payload.unpricedOnly = true
      return payload
    }

    /**
     * Session filter options for the Details tab.
     *
     * Rows come from the same `summary.bySession` array as the tree (already
     * sorted by tokens) and are capped to keep a misbehaving Host from growing
     * the DOM. Labels are the render-time title plus a short id; a session with
     * no title keeps the short id alone.
     * @param {unknown} bySession - normalized session rows.
     * @param {unknown} sessionTitles - `state.byId` map.
     * @param {number} [limit] - maximum options.
     * @returns {Array<{value: string, label: string, title: string}>} options.
     */
    function sessionFilterOptions(bySession, sessionTitles, limit = SESSION_FILTER_LIMIT) {
      const rows = Array.isArray(bySession) ? bySession : []
      const max = Number.isInteger(limit) && limit > 0 ? limit : SESSION_FILTER_LIMIT
      const options = []
      const seen = new Set()
      for (const row of rows) {
        if (!isPlainObject(row)) continue
        const sessionId = typeof row.sessionId === 'string' ? row.sessionId : ''
        if (sessionId === '' || seen.has(sessionId)) continue
        seen.add(sessionId)
        const title = sessionDisplayName(sessionId, sessionTitles, '')
        const hasTitle = title !== '' && title !== sessionId
        const short = shortId(sessionId, 12)
        options.push({
          value: sessionId,
          title,
          label: hasTitle ? `${title} · ${shortId(sessionId, 8)}` : short,
        })
        if (options.length >= max) break
      }
      return options
    }

    /**
     * Stable identity for one Host-resolved range (`from|to`).
     *
     * Named ranges (`today`, `7d`, `30d`) resolve to concrete bounds on the
     * Host, so an auto-refresh that crosses midnight can return a new `from`/
     * `to` for the same selected range. The Details pane keys its pagination on
     * this value to reset instead of appending page 2 of the new window to
     * page N of the old one.
     * @param {unknown} rangeValue - normalized or raw summary range.
     * @returns {string} stable range key.
     */
    function detailsRangeKeyFromRange(rangeValue) {
      if (!isPlainObject(rangeValue)) return ''
      const range = normalizeRange(rangeValue)
      return `${range.from}|${range.to}`
    }

    /**
     * Whether the Details pane must reset for a newly derived range key.
     * @param {unknown} state - details state.
     * @param {unknown} rangeKey - derived range key.
     * @returns {boolean} whether a 'range' reset is required.
     */
    function detailsRangeChanged(state, rangeKey) {
      const current = isPlainObject(state) ? state : createDetailsState()
      return current.rangeKey !== (typeof rangeKey === 'string' ? rangeKey : '')
    }

    /**
     * Initial state for the Details tab.
     * @param {string} [rangeKey] - Host-resolved range key.
     * @returns {object} details state.
     */
    function createDetailsState(rangeKey = '') {
      return {
        status: 'idle',
        items: [],
        total: 0,
        error: null,
        offset: 0,
        purpose: DETAILS_FILTER_ALL,
        sessionId: DETAILS_FILTER_ALL,
        unpricedOnly: false,
        rangeKey: typeof rangeKey === 'string' ? rangeKey : '',
      }
    }

    /**
     * Pure state transitions for the Details tab.
     *
     * `filters` and `range` reset pagination; `more` requests the next page from
     * the current row count; `loaded` appends when the requested offset matches
     * the rows already rendered (and replaces on the first page or after a
     * summary refresh); `error` keeps already-rendered rows so a mid-session
     * failure does not blank the pane. `range` carries the Host-resolved range
     * key so a later refresh can detect a changed window (for example across
     * midnight) and reset instead of appending a different range's page.
     * @param {unknown} state - current details state.
     * @param {object} action - transition action.
     * @returns {object} next details state.
     */
    function detailsReducer(state, action) {
      const current = isPlainObject(state) ? state : createDetailsState()
      const type = typeof action?.type === 'string' ? action.type : ''
      if (type === 'filters') {
        return {
          ...current,
          purpose: typeof action.purpose === 'string' ? action.purpose : current.purpose,
          sessionId: typeof action.sessionId === 'string' ? action.sessionId : current.sessionId,
          unpricedOnly: typeof action.unpricedOnly === 'boolean' ? action.unpricedOnly : current.unpricedOnly === true,
          status: 'loading',
          items: [],
          total: 0,
          error: null,
          offset: 0,
        }
      }
      if (type === 'range') {
        return {
          ...current,
          status: 'loading',
          items: [],
          total: 0,
          error: null,
          offset: 0,
          rangeKey: typeof action.rangeKey === 'string' ? action.rangeKey : current.rangeKey,
        }
      }
      if (type === 'load') {
        return { ...current, status: current.offset > 0 ? 'loading-more' : 'loading', error: null }
      }
      if (type === 'more') {
        return { ...current, offset: current.items.length }
      }
      if (type === 'loaded') {
        const pageItems = Array.isArray(action.items) ? action.items : []
        const append = current.offset > 0 && current.offset === current.items.length
        const items = append ? current.items.concat(pageItems) : pageItems
        const total = countNumber(action.total) || items.length
        return {
          ...current,
          status: items.length === 0 ? 'empty' : 'ready',
          items,
          total,
          error: null,
        }
      }
      if (type === 'error') {
        return {
          ...current,
          status: 'error',
          items: current.offset > 0 ? current.items : [],
          error: isPlainObject(action.error) ? action.error : { code: 'unknown', message: '', details: {} },
        }
      }
      if (type === 'reset') return createDetailsState()
      return current
    }


    /**
     * Normalize one Web API counter (`{ok,failed,total}`).
     *
     * `total` falls back to `ok + failed` so a Host that only reports subsets
     * still produces a consistent card.
     * @param {unknown} raw - counter value.
     * @returns {{ok: number, failed: number, total: number}} counter.
     */
    function normalizeWebApiCount(raw) {
      const value = isPlainObject(raw) ? raw : {}
      const ok = countNumber(value.ok)
      const failed = countNumber(value.failed)
      const total = countNumber(value.total) || ok + failed
      return { ok, failed, total }
    }

    /**
     * Normalize one `summary.webApi.bySession` row (M2.5).
     *
     * `sessionId` comes from the observed tool call's agent session and may be
     * the literal `'unknown'` when the Host could not attribute it. Counters
     * tolerate missing fields (they default to zero); `calls` is derived from
     * search + fetch when the Host omits it, and the row cost goes through the
     * shared cost normalizer so the cell renders like every other cost cell.
     * A row without a usable session id is malformed and gets dropped.
     * @param {unknown} raw - candidate row.
     * @returns {{sessionId: string, search: object, fetch: object, calls: object, cost: object|null}|null} normalized row, or null when malformed.
     */
    function normalizeWebApiSession(raw) {
      if (!isPlainObject(raw)) return null
      const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId.trim() : ''
      if (sessionId === '') return null
      const search = normalizeWebApiCount(raw.search)
      const fetch = normalizeWebApiCount(raw.fetch)
      const calls = isPlainObject(raw.calls)
        ? normalizeWebApiCount(raw.calls)
        : {
          ok: search.ok + fetch.ok,
          failed: search.failed + fetch.failed,
          total: search.total + fetch.total,
        }
      return {
        sessionId,
        search,
        fetch,
        calls,
        cost: normalizeCost(raw.cost, raw.currency),
      }
    }

    /**
     * Normalize `summary.webApi.bySession` (M2.5).
     *
     * A pre-M2.5 Host omits the field entirely, in which case the dashboard
     * hides the section instead of dropping the slot. Rows are sorted by
     * `calls.total` descending, then search total, then session id (the Host
     * contract) and capped at 100 so a misbehaving Host cannot grow the DOM
     * without bound.
     * @param {unknown} raw - raw `bySession` value.
     * @returns {Array<object>} normalized rows, sorted by calls desc.
     */
    function normalizeWebApiSessions(raw) {
      if (!Array.isArray(raw)) return []
      const rows = []
      for (const entry of raw) {
        const row = normalizeWebApiSession(entry)
        if (row !== null) rows.push(row)
      }
      rows.sort((left, right) => right.calls.total - left.calls.total
        || right.search.total - left.search.total
        || (left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0))
      return rows.slice(0, WEB_API_SESSION_LIMIT)
    }

    /**
     * Normalize `summary.webApi.unattributed` (M2.7).
     *
     * The Host reports the totals its per-session buckets cannot explain: calls
     * persisted by a pre-M2.5 Host kept a daily total only. A Host without the
     * field yields zeros, which hides the reconciliation row again. The shape
     * mirrors the top-level counters so the row can reuse the same primitive
     * renderers, and it never carries a session id — the row is not a session.
     * @param {unknown} raw - raw `unattributed` value.
     * @returns {{search: object, fetch: object, calls: object, cost: {amount: number, currency: string, priced: boolean}}} counters.
     */
    function normalizeWebApiUnattributed(raw) {
      const value = isPlainObject(raw) ? raw : {}
      const search = normalizeWebApiCount(value.search)
      const fetch = normalizeWebApiCount(value.fetch)
      const calls = isPlainObject(value.calls)
        ? normalizeWebApiCount(value.calls)
        : {
          ok: search.ok + fetch.ok,
          failed: search.failed + fetch.failed,
          total: search.total + fetch.total,
        }
      const cost = isPlainObject(value.cost) ? value.cost : {}
      const currency = typeof cost.currency === 'string' && cost.currency.trim().length > 0
        ? cost.currency.trim()
        : DEFAULT_WEB_API_PRICING.currency
      return {
        search,
        fetch,
        calls,
        cost: {
          amount: Math.max(0, numberOr(cost.amount, 0)),
          currency,
          priced: cost.priced === true,
        },
      }
    }

    /**
     * Normalize `summary.webApi` (M2.4).
     *
     * A pre-M2.4 Host omits the field entirely; the panel then renders a
     * zeroed card instead of dropping the slot or throwing. `calls` is derived
     * from the search/fetch counters when the Host does not send it, and the
     * cost amount is only flagged priced when the Host says so (failed calls
     * are counted but never billable). M2.5 adds the optional `bySession`
     * array, normalized independently; M2.7 adds the optional `unattributed`
     * totals, which stay outside `bySession` so they can never inflate it.
     * @param {unknown} raw - raw `webApi` value.
     * @returns {{search: object, fetch: object, calls: object, cost: {amount: number, currency: string, priced: boolean}, bySession: Array<object>, unattributed: object}} counters.
     */
    function normalizeWebApi(raw) {
      const value = isPlainObject(raw) ? raw : {}
      const search = normalizeWebApiCount(value.search)
      const fetch = normalizeWebApiCount(value.fetch)
      const calls = isPlainObject(value.calls)
        ? normalizeWebApiCount(value.calls)
        : {
          ok: search.ok + fetch.ok,
          failed: search.failed + fetch.failed,
          total: search.total + fetch.total,
        }
      const cost = isPlainObject(value.cost) ? value.cost : {}
      const currency = typeof cost.currency === 'string' && cost.currency.trim().length > 0
        ? cost.currency.trim()
        : DEFAULT_WEB_API_PRICING.currency
      return {
        search,
        fetch,
        calls,
        cost: {
          amount: Math.max(0, numberOr(cost.amount, 0)),
          currency,
          priced: cost.priced === true,
        },
        bySession: normalizeWebApiSessions(value.bySession),
        unattributed: normalizeWebApiUnattributed(value.unattributed),
      }
    }

    /**
     * Normalize a `summary` value into the shape the panel renders.
     *
     * The Host's live shape is authoritative; missing documented fields get
     * derived defaults so an older/newer Host cannot make a component throw.
     * @param {unknown} raw - raw summary value.
     * @returns {object} normalized summary.
     */
    function normalizeSummary(raw) {
      const value = isPlainObject(raw) ? raw : {}
      const rawTotals = isPlainObject(value.totals) ? value.totals : {}
      const promptTokens = tokenNumber(rawTotals.promptTokens)
      const outputTokens = tokenNumber(rawTotals.outputTokens)
      const totalTokens = tokenNumber(rawTotals.totalTokens) || promptTokens + outputTokens
      const requests = countNumber(rawTotals.requests)
      const estimatedRequests = countNumber(rawTotals.estimatedRequests)
      const measuredRequests = countNumber(rawTotals.measuredRequests)
      const measuredPromptTokens = tokenNumber(rawTotals.measuredPromptTokens)
      const estimatedPromptTokens = tokenNumber(rawTotals.estimatedPromptTokens)
      const estimatedOutputTokens = tokenNumber(rawTotals.estimatedOutputTokens)
      const estimatedShare = Number.isFinite(Number(rawTotals.estimatedShare))
        ? clamp(Number(rawTotals.estimatedShare), 0, 1)
        : requests > 0
          ? estimatedRequests / requests
          : 0

      const rawCache = isPlainObject(value.cache) ? value.cache : {}
      const cacheInput = tokenNumber(rawCache.input)
      const cacheRead = tokenNumber(rawCache.read)
      const cacheWrite = tokenNumber(rawCache.write)
      const cacheTotal = cacheInput + cacheRead + cacheWrite
      const hitRate = Number.isFinite(Number(rawCache.hitRate))
        ? clamp(Number(rawCache.hitRate), 0, 1)
        : cacheTotal > 0
          ? cacheRead / cacheTotal
          : 0

      const rawCost = isPlainObject(value.cost)
        ? value.cost
        : isPlainObject(rawTotals.cost)
          ? rawTotals.cost
          : {}
      const costCurrency = typeof rawCost.currency === 'string' && rawCost.currency.length > 0
        ? (rawCost.currency.toLowerCase() === 'mixed' ? 'mixed' : rawCost.currency)
        : 'CNY'
      const rawData = isPlainObject(value.data) ? value.data : {}
      const rawRetention = isPlainObject(rawData.retention) ? rawData.retention : null
      const byPurpose = normalizePurposeMap(value.byPurpose)
      const byCategory = normalizeCategoryMap(value.byCategory)
      const byCategoryGroup = normalizeCategoryGroups(value.byCategoryGroup, byCategory)
      const byToolGroup = normalizeToolGroupMap(value.byToolGroup)
      const bySession = normalizeSessions(value.bySession)
      const byModel = normalizeModels(value.byModel)
      const byDay = normalizeDays(value.byDay)

      return {
        generatedAt: numberOr(value.generatedAt, 0),
        range: normalizeRange(value.range),
        totals: {
          promptTokens,
          outputTokens,
          totalTokens,
          requests,
          attempts: countNumber(rawTotals.attempts),
          estimatedRequests,
          measuredRequests,
          measuredPromptTokens,
          estimatedPromptTokens,
          estimatedOutputTokens,
          estimatedShare,
        },
        byPurpose,
        byPurposeEntries: Object.entries(byPurpose)
          .map(([key, entry]) => ({ key, ...entry }))
          .sort((left, right) => right.tokens - left.tokens),
        byCategory,
        byCategoryGroup,
        byToolGroup,
        bySession,
        byModel,
        byDay,
        webApi: normalizeWebApi(value.webApi),
        cache: {
          input: cacheInput,
          read: cacheRead,
          write: cacheWrite,
          total: cacheTotal,
          hitRate,
        },
        cost: {
          amount: numberOr(rawCost.amount, 0),
          priced: rawCost.priced === true,
          unpricedRequests: countNumber(rawCost.unpricedRequests),
          currency: costCurrency,
          byCurrency: normalizeCostMap(rawTotals.costByCurrency ?? value.costByCurrency),
        },
        unpricedReasons: normalizeUnpricedReasons(value.unpricedReasons),
        data: {
          since: typeof rawData.since === 'string' ? rawData.since : null,
          retention: rawRetention === null ? null : {
            requestDays: countNumber(rawRetention.requestDays),
            dailyDays: countNumber(rawRetention.dailyDays),
          },
          dataRoot: typeof rawData.dataRoot === 'string' ? rawData.dataRoot : '',
          readOnly: rawData.readOnly === true,
          pointerStatus: rawData.pointerStatus,
          migration: isPlainObject(rawData.migration) ? rawData.migration : null,
          migrationStatus: typeof rawData.migrationStatus === 'string' ? rawData.migrationStatus : null,
          // Set by the Host when an old day has only a daily aggregate left:
          // per-source cost for those days cannot be rebuilt from detail rows.
          costDetailIncomplete: rawData.costDetailIncomplete === true,
        },
      }
    }

    // ---------------------------------------------------------------------
    // M3 — single-session drill-down (normalizers, payloads, drill state)
    // ---------------------------------------------------------------------

    /**
     * Normalize a list of session ids: drop non-strings, trim, dedupe, keep
     * order. The Host caps `summary.bySession` at 500 rows; the same cap keeps
     * a malformed `sessionIds` echo from growing an RPC payload without bound.
     * @param {unknown} raw - candidate list.
     * @param {number} [limit] - maximum ids kept.
     * @returns {Array<string>} normalized ids.
     */
    function normalizeSessionIdList(raw, limit = 1000) {
      if (!Array.isArray(raw)) return []
      const max = Number.isInteger(limit) && limit > 0 ? limit : 1000
      const seen = new Set()
      const ids = []
      for (const entry of raw) {
        if (typeof entry !== 'string') continue
        const id = entry.trim()
        if (id === '' || seen.has(id)) continue
        seen.add(id)
        ids.push(id)
        if (ids.length >= max) break
      }
      return ids
    }

    /**
     * Derive a `summary.webApi`-shaped block restricted to one session set.
     *
     * `summary.webApi` is range-wide, so a drill-down must never copy its
     * totals: they would claim calls from sessions the user did not select.
     * The per-session rows are filtered and re-summed here instead; the
     * synthetic `unattributed` remainder is always zero (it is a range-level
     * reconciliation row, not a session's data).
     * @param {unknown} raw - range-wide `summary.webApi`.
     * @param {Array<string>} sessionIds - selected session ids (including subtree).
     * @returns {object} normalized Web API block for the session set.
     */
    function webApiForSessions(raw, sessionIds) {
      const normalized = normalizeWebApi(raw)
      const ids = normalizeSessionIdList(sessionIds)
      const selected = new Set(ids)
      const rows = selected.size > 0
        ? normalized.bySession.filter(row => selected.has(row.sessionId))
        : normalized.bySession
      const search = { ok: 0, failed: 0, total: 0 }
      const fetch = { ok: 0, failed: 0, total: 0 }
      const calls = { ok: 0, failed: 0, total: 0 }
      let cost = null
      for (const row of rows) {
        search.ok += row.search.ok
        search.failed += row.search.failed
        search.total += row.search.total
        fetch.ok += row.fetch.ok
        fetch.failed += row.fetch.failed
        fetch.total += row.fetch.total
        calls.ok += row.calls.ok
        calls.failed += row.calls.failed
        calls.total += row.calls.total
        if (row.cost !== null) cost = mergeSubtreeCost(cost, row.cost)
      }
      return {
        search,
        fetch,
        calls,
        cost: cost === null
          ? { amount: 0, currency: DEFAULT_WEB_API_PRICING.currency, priced: false }
          : { amount: cost.amount, currency: cost.currency, priced: cost.priced === true },
        bySession: rows,
        unattributed: normalizeWebApiUnattributed(null),
      }
    }

    /**
     * Build a minimal normalized summary from one session row, used only when
     * the Host echoes a `session` row without a `summary` block.
     * @param {object} session - normalized session row.
     * @returns {object} normalized summary.
     */
    function summaryFromSessionRow(session) {
      return normalizeSummary({
        totals: {
          promptTokens: session.promptTokens ?? 0,
          outputTokens: session.outputTokens ?? 0,
          totalTokens: session.tokens,
          requests: session.requests,
        },
        cache: session.cache,
        cost: session.cost ?? undefined,
        bySession: [session],
      })
    }

    /**
     * Normalize the M3 `sessionDetail` payload.
     *
     * The Host filters `summary`, `children`, `sessionIds` and `webApi` to the
     * selected session set (subtree included when requested). Defensive rules:
     * - `detailAvailable` defaults to true; only an explicit `false` selects the
     *   retained-aggregate fallback (the pre-M3 Host never sends the field).
     * - a missing `summary` is synthesized from the `session` row so the cards
     *   still render.
     * - a missing `webApi` block is derived from `summary.webApi.bySession`
     *   filtered to the session set, never from range-wide totals.
     * @param {unknown} raw - raw `sessionDetail` RPC value.
     * @returns {object} normalized session detail.
     */
    function normalizeSessionDetail(raw) {
      const value = isPlainObject(raw) ? raw : {}
      const session = normalizeSessionRow(value.session)
      const children = normalizeSessions(value.children)
      const requestedId = typeof value.sessionId === 'string' ? value.sessionId.trim() : ''
      const sessionId = requestedId !== ''
        ? requestedId
        : session !== null && session.sessionId !== '' ? session.sessionId : ''
      const hostSessionIds = normalizeSessionIdList(value.sessionIds)
      let sessionIds = hostSessionIds.slice()
      if (sessionIds.length === 0) {
        const derived = []
        if (sessionId !== '') derived.push(sessionId)
        if (session !== null) derived.push(session.sessionId)
        for (const child of children) derived.push(child.sessionId)
        sessionIds = normalizeSessionIdList(derived)
      }
      const hasSummary = isPlainObject(value.summary)
      const summary = hasSummary
        ? normalizeSummary(value.summary)
        : session !== null ? summaryFromSessionRow(session) : normalizeSummary(null)
      const summaryWebApi = hasSummary && isPlainObject(value.summary.webApi) ? value.summary.webApi : null
      let webApi
      if (isPlainObject(value.webApi)) {
        webApi = normalizeWebApi(value.webApi)
        // Only filter against the Host-echoed list; a derived list may miss
        // deeper descendants and would otherwise hide their Web API rows.
        if (hostSessionIds.length > 0) {
          const selected = new Set(hostSessionIds)
          webApi.bySession = webApi.bySession.filter(row => selected.has(row.sessionId))
        }
      } else if (summaryWebApi !== null) {
        webApi = webApiForSessions(summaryWebApi, sessionIds)
      } else {
        webApi = normalizeWebApi(null)
      }
      // The Host-level unattributed remainder is range-level reconciliation and
      // must never show up in a single-session drill-down.
      webApi.unattributed = normalizeWebApiUnattributed(null)
      // Prefer the detail range; fall back to the echoed summary range when a
      // Host sends only the named label here.
      const range = normalizeRange(value.range)
      if (range.from === '' && range.to === '') {
        range.from = summary.range.from
        range.to = summary.range.to
        range.label = summary.range.label || range.label
      }
      return {
        generatedAt: numberOr(value.generatedAt, 0),
        range,
        sessionId,
        includeDescendants: value.includeDescendants !== false,
        detailAvailable: value.detailAvailable !== false,
        detailPartial: value.detailPartial === true,
        detailReason: typeof value.detailReason === 'string' && value.detailReason.trim().length > 0
          ? value.detailReason.trim()
          : null,
        session,
        children,
        sessionIds,
        summary,
        webApi,
      }
    }

    /**
     * Whether a normalized session detail names a session that no longer has
     * any rows in the selected range.
     * @param {object|null} detail - normalized session detail.
     * @returns {boolean} true when the selection vanished.
     */
    function sessionDetailEmpty(detail) {
      if (!isPlainObject(detail)) return true
      // A vanished session can still have surviving child rows (for example a
      // narrowed range drops the parent). The parent itself is gone, so show
      // the missing state and let the children stay navigable; do not paint
      // zeroed parent cards or the 30-day fallback note.
      return detail.session === null || detail.detailReason === 'session-not-found'
    }

    /**
     * Initial state for the single-session drill-down (Sessions tab only).
     * @param {string} [rangeKey] - Host-resolved range key (`from|to`).
     * @returns {object} drill state.
     */
    function createDrillState(rangeKey = '') {
      return {
        sessionId: null,
        includeDescendants: true,
        status: 'idle',
        data: null,
        error: null,
        rangeKey: typeof rangeKey === 'string' ? rangeKey : '',
        lastSessionId: '',
      }
    }

    /**
     * Pure transitions for the drill-down state.
     *
     * `open` selects a session (defaults to subtree mode) and shows the loading
     * state; `toggle` flips the subtree scope and refetches; `loaded` records
     * the response and detects a vanished session; `range` clears stale data
     * before the refetch for a new range; `error` clears the selection (the
     * panel returns to the tree and keeps `lastSessionId` so the warning can
     * retry); `close` is the Back action.
     * @param {unknown} state - current drill state.
     * @param {object} action - transition action.
     * @returns {object} next drill state.
     */
    function drillReducer(state, action) {
      const current = isPlainObject(state) ? state : createDrillState()
      const type = typeof action?.type === 'string' ? action.type : ''
      if (type === 'open') {
        const sessionId = typeof action.sessionId === 'string' ? action.sessionId.trim() : ''
        if (sessionId === '') return current
        return {
          ...createDrillState(current.rangeKey),
          sessionId,
          includeDescendants: action.includeDescendants !== false,
          status: 'loading',
          lastSessionId: sessionId,
        }
      }
      if (type === 'toggle') {
        if (current.sessionId === null) return current
        return {
          ...current,
          includeDescendants: action.includeDescendants === true,
          status: 'loading',
          data: null,
          error: null,
        }
      }
      if (type === 'refresh') {
        if (current.sessionId === null) return current
        const status = current.data === null
          ? 'loading'
          : current.status === 'empty' ? 'empty' : 'ready'
        return { ...current, status, error: null }
      }
      if (type === 'loaded') {
        const raw = isPlainObject(action.data) ? action.data : null
        const data = raw === null
          ? null
          : isPlainObject(raw.summary) && Array.isArray(raw.summary.byPurposeEntries)
            ? raw
            : normalizeSessionDetail(raw)
        if (current.sessionId === null || data === null) return current
        const rangeKey = isPlainObject(data.range) && (data.range.from !== '' || data.range.to !== '')
          ? detailsRangeKeyFromRange(data.range)
          : current.rangeKey
        return {
          ...current,
          status: sessionDetailEmpty(data) ? 'empty' : 'ready',
          data,
          error: null,
          rangeKey,
        }
      }
      if (type === 'range') {
        const rangeKey = typeof action.rangeKey === 'string' ? action.rangeKey : current.rangeKey
        if (current.sessionId === null) {
          return { ...current, rangeKey, error: null }
        }
        return { ...current, rangeKey, status: 'loading', data: null, error: null }
      }
      if (type === 'error') {
        return {
          ...createDrillState(current.rangeKey),
          status: 'idle',
          error: isPlainObject(action.error) ? action.error : { code: 'unknown', message: '', details: {} },
          lastSessionId: current.sessionId ?? current.lastSessionId,
        }
      }
      if (type === 'close') return createDrillState(current.rangeKey)
      return current
    }

    /**
     * Hydrate a drill state from the headless-test `initialDrill` prop (the
     * same escape hatch as `initialTab`): `{sessionId, includeDescendants, data}`
     * where `data` is a raw `sessionDetail` payload.
     * @param {unknown} raw - candidate initial drill.
     * @returns {object} drill state.
     */
    function initialDrillState(raw) {
      if (!isPlainObject(raw)) return createDrillState()
      const data = isPlainObject(raw.data) ? normalizeSessionDetail(raw.data) : null
      const requested = typeof raw.sessionId === 'string' ? raw.sessionId.trim() : ''
      const sessionId = requested !== ''
        ? requested
        : data !== null && data.sessionId !== '' ? data.sessionId : data?.session?.sessionId ?? ''
      if (typeof sessionId !== 'string' || sessionId === '') return createDrillState()
      const status = data === null ? 'loading' : sessionDetailEmpty(data) ? 'empty' : 'ready'
      return {
        ...createDrillState(data === null ? '' : detailsRangeKeyFromRange(data.range)),
        sessionId,
        includeDescendants: raw.includeDescendants !== false,
        status,
        data,
        lastSessionId: sessionId,
      }
    }

    /**
     * Build the M3 `sessionDetail` RPC payload.
     * @param {unknown} rangeValue - named range (`today`/`7d`/`30d`).
     * @param {{sessionId?: unknown, includeDescendants?: unknown}} [options] - selection.
     * @returns {{range: string, sessionId: string, includeDescendants: boolean}} payload.
     */
    function sessionDetailPayload(rangeValue, options) {
      const opts = isPlainObject(options) ? options : {}
      const candidate = typeof rangeValue === 'string'
        ? rangeValue
        : isPlainObject(rangeValue) && typeof rangeValue.label === 'string' ? rangeValue.label : ''
      const range = RANGES.includes(candidate) ? candidate : 'today'
      return {
        range,
        sessionId: typeof opts.sessionId === 'string' ? opts.sessionId.trim() : '',
        includeDescendants: opts.includeDescendants !== false,
      }
    }

    /**
     * Build the `requests` RPC payload for a session detail view.
     *
     * In subtree mode the Host `requests` endpoint accepts the full
     * `sessionIds` list (combined rows for the selected session set); in
     * single-session mode (or when the Host-echoed list is missing) the legacy
     * `sessionId` filter is used instead. `sessionIds` is never sent empty, so
     * a Host without M3 support still sees the pre-M3 payload shape.
     * @param {unknown} rangeValue - Host range (`{from,to}`).
     * @param {object} [options] - paging and session selection.
     * @returns {{from: string, to: string, limit: number, offset: number, sessionIds?: Array<string>, sessionId?: string}} payload.
     */
    function sessionRequestsPayload(rangeValue, options) {
      const range = normalizeRange(rangeValue)
      const opts = isPlainObject(options) ? options : {}
      const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : DETAILS_PAGE_SIZE
      const offset = Number.isInteger(opts.offset) && opts.offset > 0 ? opts.offset : 0
      const payload = { from: range.from, to: range.to, limit, offset }
      const sessionIds = normalizeSessionIdList(opts.sessionIds)
      const sessionId = typeof opts.sessionId === 'string' ? opts.sessionId.trim() : ''
      if (opts.includeDescendants === true && sessionIds.length > 0) payload.sessionIds = sessionIds
      else if (sessionId !== '') payload.sessionId = sessionId
      return payload
    }

    /**
     * Build the ancestor path (root → selected) for the drill-down breadcrumb.
     *
     * The rows come from the range-wide `summary.bySession`, which contains the
     * parent links; a missing parent or a parent cycle simply ends the walk, so
     * a stale selection still yields a usable one-item path.
     * @param {unknown} bySession - normalized (or raw) session rows.
     * @param {unknown} sessionId - selected session id.
     * @param {number} [maxDepth] - safety cap for malformed parent chains.
     * @returns {Array<{sessionId: string, parentSessionId: string|null}>} path.
     */
    function sessionBreadcrumb(bySession, sessionId, maxDepth = 32) {
      const rows = Array.isArray(bySession) ? bySession : []
      const depthCap = Number.isInteger(maxDepth) && maxDepth > 0 ? maxDepth : 32
      const byId = new Map()
      for (const row of rows) {
        if (!isPlainObject(row) || typeof row.sessionId !== 'string' || row.sessionId === '') continue
        if (!byId.has(row.sessionId)) byId.set(row.sessionId, row)
      }
      const path = []
      const seen = new Set()
      let cursor = typeof sessionId === 'string' ? sessionId : ''
      while (cursor !== '' && !seen.has(cursor) && path.length < depthCap) {
        seen.add(cursor)
        const row = byId.get(cursor)
        path.push({
          sessionId: cursor,
          parentSessionId: row !== undefined && typeof row.parentSessionId === 'string' && row.parentSessionId !== ''
            ? row.parentSessionId
            : null,
        })
        cursor = path[path.length - 1].parentSessionId ?? ''
      }
      path.reverse()
      return path
    }

    /**
     * Normalize one Config field descriptor.
     * @param {unknown} entry - descriptor.
     * @param {string} name - field name.
     * @returns {object|null} normalized descriptor.
     */
    function normalizeFieldDescriptor(entry, name) {
      if (!isPlainObject(entry)) return null
      return {
        name,
        type: typeof entry.type === 'string' ? entry.type : 'unknown',
        default: entry.default,
        editable: entry.editable !== false,
        restartRequired: entry.restartRequired === true,
        description: typeof entry.description === 'string' ? entry.description : '',
      }
    }

    /**
     * Normalize `config.get.fields`, accepting an array or a name-keyed map.
     * @param {unknown} raw - raw fields.
     * @returns {Array<object>} descriptors.
     */
    function normalizeFieldDescriptors(raw) {
      if (Array.isArray(raw)) {
        const descriptors = []
        for (const entry of raw) {
          if (!isPlainObject(entry) || typeof entry.name !== 'string' || entry.name.length === 0) continue
          const descriptor = normalizeFieldDescriptor(entry, entry.name)
          if (descriptor !== null) descriptors.push(descriptor)
        }
        return descriptors
      }
      if (isPlainObject(raw)) {
        const descriptors = []
        for (const [name, entry] of Object.entries(raw)) {
          const descriptor = normalizeFieldDescriptor(entry, name)
          if (descriptor !== null) descriptors.push(descriptor)
        }
        return descriptors
      }
      return []
    }

    /**
     * Normalize a `config.get` value.
     * @param {unknown} raw - raw `config.get` value.
     * @returns {object} normalized config info.
     */
    function normalizeConfigInfo(raw) {
      const value = isPlainObject(raw) ? raw : {}
      const values = isPlainObject(value.values) ? { ...value.values } : {}
      const defaults = isPlainObject(value.defaults) ? { ...value.defaults } : {}
      const fields = normalizeFieldDescriptors(value.fields)
      const restartRequiredFields = Array.isArray(value.restartRequiredFields)
        ? value.restartRequiredFields.filter(field => typeof field === 'string')
        : RESTART_FALLBACK_FIELDS.slice()
      return {
        values,
        defaults,
        editable: value.editable === true,
        restartRequiredFields,
        fields,
        diagnostics: Array.isArray(value.diagnostics)
          ? value.diagnostics.filter(diagnostic => typeof diagnostic === 'string')
          : [],
      }
    }

    /**
     * Descriptor lookup with a default for hosts that return no field list.
     * @param {object|null} configInfo - normalized config info.
     * @param {string} name - field name.
     * @returns {object} descriptor.
     */
    function fieldDescriptor(configInfo, name) {
      const found = Array.isArray(configInfo?.fields)
        ? configInfo.fields.find(field => field.name === name)
        : undefined
      return found ?? {
        name,
        type: 'unknown',
        editable: true,
        restartRequired: RESTART_FALLBACK_FIELDS.includes(name),
        description: '',
      }
    }

    /**
     * Whether `config.get` published a descriptor for one Config field.
     *
     * M2.6 added `rememberLastTab`; an older Host advertises only its 12
     * original fields and rejects any unknown key in `config.set` with
     * `config-invalid`. The client therefore gates that key (and its switch)
     * on the Host's own descriptor list instead of the build-time field order.
     * @param {object|null} configInfo - normalized config info.
     * @param {string} name - field name.
     * @returns {boolean} whether the descriptor exists.
     */
    function configFieldSupported(configInfo, name) {
      return Array.isArray(configInfo?.fields)
        && configInfo.fields.some(field => isPlainObject(field) && field.name === name)
    }

    /**
     * Convert Config values into editable form state (all scalar inputs are
     * strings so a user can type partial values without React coercing them).
     * @param {unknown} values - Config values.
     * @returns {object} form state.
     */
    function formFromConfig(values) {
      const value = isPlainObject(values) ? values : {}
      const pricing = Array.isArray(value.pricing)
        ? value.pricing.filter(row => isPlainObject(row)).map(row => {
          const offPeak = isPlainObject(row.offPeak) ? row.offPeak : {}
          return {
            provider: asText(row.provider),
            model: asText(row.model === undefined ? '*' : row.model),
            currency: asText(row.currency === undefined ? 'CNY' : row.currency),
            inputPerMillion: asText(row.inputPerMillion === undefined ? 0 : row.inputPerMillion),
            cacheReadPerMillion: asText(row.cacheReadPerMillion === undefined ? 0 : row.cacheReadPerMillion),
            cacheWritePerMillion: asText(row.cacheWritePerMillion === undefined ? 0 : row.cacheWritePerMillion),
            outputPerMillion: asText(row.outputPerMillion === undefined ? 0 : row.outputPerMillion),
            offPeakInputPerMillion: asText(offPeak.inputPerMillion),
            offPeakCacheReadPerMillion: asText(offPeak.cacheReadPerMillion),
            offPeakCacheWritePerMillion: asText(offPeak.cacheWritePerMillion),
            offPeakOutputPerMillion: asText(offPeak.outputPerMillion),
            priceVersion: asText(row.priceVersion === undefined ? '' : row.priceVersion),
          }
        })
        : []
      const offPeakDays = Array.isArray(value.pricingOffPeakDays)
        ? value.pricingOffPeakDays
          .filter(day => typeof day === 'string' && day.trim().length > 0)
          .map(day => day.trim())
          .join('\n')
        : ''
      const toolGroups = isPlainObject(value.toolGroups) ? value.toolGroups : DEFAULT_TOOL_GROUPS
      const webApiPricing = isPlainObject(value.webApiPricing) ? value.webApiPricing : {}
      return {
        dataDir: asText(value.dataDir),
        retainRequestDays: asText(value.retainRequestDays === undefined ? 30 : value.retainRequestDays),
        retainDailyDays: asText(value.retainDailyDays === undefined ? 365 : value.retainDailyDays),
        flushIntervalMs: asText(value.flushIntervalMs === undefined ? 5000 : value.flushIntervalMs),
        pricing,
        pricingOffPeakDays: offPeakDays,
        webApiSearchPerThousand: asText(webApiPricing.searchPerThousand === undefined
          ? DEFAULT_WEB_API_PRICING.searchPerThousand
          : webApiPricing.searchPerThousand),
        webApiFetchPerThousand: asText(webApiPricing.fetchPerThousand === undefined
          ? DEFAULT_WEB_API_PRICING.fetchPerThousand
          : webApiPricing.fetchPerThousand),
        webApiCurrency: asText(webApiPricing.currency === undefined
          ? DEFAULT_WEB_API_PRICING.currency
          : webApiPricing.currency),
        toolGroupsText: safeJson(toolGroups),
        maxDetailRowsPerDay: asText(value.maxDetailRowsPerDay === undefined ? 200000 : value.maxDetailRowsPerDay),
        enableAutoRefresh: value.enableAutoRefresh === true,
        rememberLastTab: value.rememberLastTab === true,
        autoRefreshIntervalMs: asText(value.autoRefreshIntervalMs === undefined ? 30000 : value.autoRefreshIntervalMs),
        rpcChannel: asText(value.rpcChannel === undefined ? DEFAULT_CHANNEL : value.rpcChannel),
      }
    }

    /**
     * Turn a scalar into form text.
     * @param {unknown} value - scalar.
     * @returns {string} text.
     */
    function asText(value) {
      if (typeof value === 'string') return value
      if (typeof value === 'number' && Number.isFinite(value)) return String(value)
      if (typeof value === 'boolean') return value ? 'true' : 'false'
      return ''
    }

    /**
     * JSON stringify that never throws.
     * @param {unknown} value - value.
     * @returns {string} JSON text.
     */
    function safeJson(value) {
      try {
        return JSON.stringify(value, null, 2)
      } catch {
        return '{}'
      }
    }

    /**
     * Parse an advanced JSON object field.
     * @param {unknown} text - textarea text.
     * @returns {{ok: true, value: object} | {ok: false, error: string}} result with a stable error code.
     */
    function validateAdvancedJson(text) {
      if (typeof text !== 'string' || text.trim().length === 0) {
        return { ok: false, error: 'json-empty' }
      }
      let value
      try {
        value = JSON.parse(text)
      } catch {
        return { ok: false, error: 'json-invalid' }
      }
      if (!isPlainObject(value)) return { ok: false, error: 'json-not-object' }
      return { ok: true, value }
    }

    /**
     * Validate a tool-groups object against the Host's Config rules for group
     * names and values: `agentTeams` or 1–32 lowercase letters, digits and
     * hyphens (`other` is reserved) mapped to arrays of up to 200 non-empty
     * tool names or prefixes.
     * @param {unknown} value - parsed object.
     * @returns {{ok: boolean, errors: Array<{field: string, code: string}>, value: object}} result.
     */
    function validateToolGroups(value) {
      const errors = []
      if (!isPlainObject(value)) {
        return { ok: false, errors: [{ field: 'toolGroups', code: 'json-not-object' }], value: {} }
      }
      const keys = Object.keys(value)
      if (keys.length === 0) errors.push({ field: 'toolGroups', code: 'json-empty' })
      for (const key of keys) {
        const legacy = TOOL_GROUP_LEGACY_KEYS.includes(key)
        if (!legacy && (!TOOL_GROUP_KEY_PATTERN.test(key) || TOOL_GROUP_RESERVED_KEYS.includes(key))) {
          errors.push({ field: `toolGroups.${key}`, code: 'toolGroups-key' })
          continue
        }
        const list = value[key]
        if (!Array.isArray(list)
          || list.length > TOOL_GROUP_MAX_ENTRIES
          || list.some(entry => typeof entry !== 'string' || entry.trim().length === 0)) {
          errors.push({ field: `toolGroups.${key}`, code: 'toolGroups-list' })
        }
      }
      return { ok: errors.length === 0, errors, value }
    }

    /**
     * Parse one required integer form field.
     * @param {object} form - form state.
     * @param {string} name - field name.
     * @param {Array<object>} errors - error sink.
     * @returns {number|null} parsed integer or null when invalid.
     */
    function parseIntegerField(form, name, errors) {
      const raw = form[name]
      const text = typeof raw === 'string' ? raw.trim() : String(raw ?? '')
      if (text === '') {
        errors.push({ field: name, code: 'required' })
        return null
      }
      const number = Number(text)
      if (!Number.isInteger(number)) {
        errors.push({ field: name, code: 'integer' })
        return null
      }
      const rule = NUMERIC_RULES[name]
      if (rule !== undefined && (number < rule.min || number > rule.max)) {
        errors.push({ field: name, code: 'range' })
        return null
      }
      return number
    }

    /**
     * Parse one required non-negative price field; an empty string means 0.
     * @param {unknown} raw - form value.
     * @param {string} field - error field path.
     * @param {Array<object>} errors - error sink.
     * @returns {number|null} parsed price or null when invalid.
     */
    function parsePriceField(raw, field, errors) {
      const text = typeof raw === 'string' ? raw.trim() : String(raw ?? '')
      if (text === '') return 0
      const number = Number(text)
      if (!Number.isFinite(number) || number < 0) {
        errors.push({ field, code: 'price-number' })
        return null
      }
      return number
    }

    /**
     * Parse one optional off-peak price field.
     *
     * An empty field means "fall back to the peak price" and is not an error.
     * @param {unknown} raw - form value.
     * @param {string} field - error field path.
     * @param {Array<object>} errors - error sink.
     * @returns {{provided: boolean, value: number|null|undefined}} parsed value; `value` is
     *   `undefined` when empty and `null` when invalid.
     */
    function parseOptionalPriceField(raw, field, errors) {
      const text = typeof raw === 'string' ? raw.trim() : String(raw ?? '').trim()
      if (text === '') return { provided: false, value: undefined }
      const number = Number(text)
      if (!Number.isFinite(number) || number < 0) {
        errors.push({ field, code: 'price-number' })
        return { provided: true, value: null }
      }
      return { provided: true, value: number }
    }

    /**
     * Parse one Web API per-thousand rate.
     *
     * Rates are required and must be finite and non-negative; an empty field is
     * reported instead of silently becoming a free tier.
     * @param {unknown} raw - form value.
     * @param {string} field - error field path (e.g. `webApiPricing.searchPerThousand`).
     * @param {Array<object>} errors - error sink.
     * @returns {number|null} parsed rate or null when invalid.
     */
    function parseWebApiRate(raw, field, errors) {
      const text = typeof raw === 'string' ? raw.trim() : raw === undefined || raw === null ? '' : String(raw).trim()
      if (text === '') {
        errors.push({ field, code: 'webApi-number' })
        return null
      }
      const number = Number(text)
      if (!Number.isFinite(number) || number < 0) {
        errors.push({ field, code: 'webApi-number' })
        return null
      }
      return number
    }

    /**
     * Whether a text is a valid local `YYYY-MM-DD` day key.
     *
     * Mirrors the Host's `isValidDayKey` (calendar check at noon) so the panel
     * never submits a date the Host would reject.
     * @param {unknown} value - candidate.
     * @returns {boolean} validity.
     */
    function isOffPeakDay(value) {
      if (typeof value !== 'string') return false
      const match = OFF_PEAK_DAY_PATTERN.exec(value)
      if (match === null) return false
      const year = Number(match[1])
      const month = Number(match[2])
      const day = Number(match[3])
      const date = new Date(year, month - 1, day, 12, 0, 0, 0)
      return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    }

    /**
     * Normalize the off-peak-day textarea into a clean `YYYY-MM-DD` array.
     *
     * Trims each line, drops empty lines, dedupes (first occurrence wins) and
     * preserves the user's order. Any malformed/inexistent date is reported on
     * the `pricingOffPeakDays` field.
     * @param {unknown} text - textarea text (one date per line).
     * @returns {{ok: true, days: string[], errors: []} | {ok: false, days: [], errors: Array<{field: string, code: string}>}} result.
     */
    function normalizeOffPeakDays(text) {
      const source = typeof text === 'string' ? text : ''
      const days = []
      const seen = new Set()
      let invalid = false
      for (const line of source.split(/\r?\n/u)) {
        const day = line.trim()
        if (day === '') continue
        if (!isOffPeakDay(day)) {
          invalid = true
          continue
        }
        if (seen.has(day)) continue
        seen.add(day)
        days.push(day)
      }
      if (invalid) {
        return { ok: false, days: [], errors: [{ field: 'pricingOffPeakDays', code: 'price-date' }] }
      }
      return { ok: true, days, errors: [] }
    }

    /**
     * Build a `config.set` patch from the editable form state.
     *
     * Mirrors the Host's own validation ranges and price-entry rules so the
     * panel can report errors before an RPC round trip; the Host remains the
     * authority and re-validates the patch.
     *
     * `configInfo` is the Host's descriptor list. A pre-M2.6 Host has no
     * `rememberLastTab` descriptor and would reject the whole patch as
     * `config-invalid`, so that key is only included when the Host advertises
     * it. Omitting `configInfo` keeps the previous always-include behavior for
     * callers that only validate a form.
     * @param {object} form - form state from `formFromConfig`.
     * @param {object|null} [configInfo] - normalized `config.get` value.
     * @returns {{ok: true, patch: object, errors: []} | {ok: false, patch: null, errors: Array<{field: string, code: string}>}} result.
     */
    function configPatchFromForm(form, configInfo) {
      const source = isPlainObject(form) ? form : {}
      const errors = []
      const patch = {}
      const rememberLastTabSupported = configInfo === undefined || configInfo === null
        || configFieldSupported(configInfo, 'rememberLastTab')

      const dataDir = asText(source.dataDir).trim()
      if (dataDir !== '' && !isAbsolutePath(dataDir)) {
        errors.push({ field: 'dataDir', code: 'dataDirAbsolute' })
      } else {
        patch.dataDir = dataDir
      }

      for (const name of Object.keys(NUMERIC_RULES)) {
        const parsed = parseIntegerField(source, name, errors)
        if (parsed !== null) patch[name] = parsed
      }

      patch.enableAutoRefresh = source.enableAutoRefresh === true
      // M2.6 guard: a pre-M2.6 Host has no rememberLastTab descriptor and
      // rejects the whole patch when the key is present.
      if (rememberLastTabSupported) patch.rememberLastTab = source.rememberLastTab === true

      const pricing = []
      let pricingInvalid = false
      if (Array.isArray(source.pricing)) {
        source.pricing.forEach((row, index) => {
          if (!isPlainObject(row)) {
            errors.push({ field: `pricing.${index}`, code: 'pricing-row' })
            pricingInvalid = true
            return
          }
          const provider = asText(row.provider).trim()
          const model = asText(row.model).trim()
          const currency = asText(row.currency).trim()
          if (provider === '') errors.push({ field: `pricing.${index}.provider`, code: 'price-provider' })
          if (currency === '') errors.push({ field: `pricing.${index}.currency`, code: 'price-currency' })
          const entry = {
            provider,
            currency,
            inputPerMillion: parsePriceField(row.inputPerMillion, `pricing.${index}.inputPerMillion`, errors),
            cacheReadPerMillion: parsePriceField(row.cacheReadPerMillion, `pricing.${index}.cacheReadPerMillion`, errors),
            cacheWritePerMillion: parsePriceField(row.cacheWritePerMillion, `pricing.${index}.cacheWritePerMillion`, errors),
            outputPerMillion: parsePriceField(row.outputPerMillion, `pricing.${index}.outputPerMillion`, errors),
          }
          const offPeak = {}
          for (const [formField, priceField] of OFF_PEAK_PRICE_FIELDS) {
            const parsed = parseOptionalPriceField(row[formField], `pricing.${index}.${formField}`, errors)
            if (parsed.value === null) {
              pricingInvalid = true
            } else if (parsed.value !== undefined) {
              offPeak[priceField] = parsed.value
            }
          }
          if (Object.keys(offPeak).length > 0) entry.offPeak = offPeak
          if (model !== '') entry.model = model
          const priceVersion = asText(row.priceVersion).trim()
          if (priceVersion !== '') entry.priceVersion = priceVersion
          pricing.push(entry)
        })
      }
      if (pricingInvalid || pricing.some(entry => entry.inputPerMillion === null || entry.cacheReadPerMillion === null
        || entry.cacheWritePerMillion === null || entry.outputPerMillion === null)) {
        // A null above already pushed a structured error; keep the patch null below.
      } else {
        patch.pricing = pricing
      }

      const offPeakDays = normalizeOffPeakDays(source.pricingOffPeakDays)
      if (!offPeakDays.ok) errors.push(...offPeakDays.errors)
      else patch.pricingOffPeakDays = offPeakDays.days

      const searchRate = parseWebApiRate(source.webApiSearchPerThousand, 'webApiPricing.searchPerThousand', errors)
      const fetchRate = parseWebApiRate(source.webApiFetchPerThousand, 'webApiPricing.fetchPerThousand', errors)
      const webApiCurrency = asText(source.webApiCurrency).trim()
      if (webApiCurrency === '') errors.push({ field: 'webApiPricing.currency', code: 'webApi-currency' })
      if (searchRate !== null && fetchRate !== null && webApiCurrency !== '') {
        patch.webApiPricing = {
          searchPerThousand: searchRate,
          fetchPerThousand: fetchRate,
          currency: webApiCurrency,
        }
      }

      const toolGroupsResult = validateAdvancedJson(source.toolGroupsText)
      if (!toolGroupsResult.ok) {
        errors.push({ field: 'toolGroups', code: toolGroupsResult.error })
      } else {
        const groupsResult = validateToolGroups(toolGroupsResult.value)
        if (!groupsResult.ok) errors.push(...groupsResult.errors)
        else patch.toolGroups = toolGroupsResult.value
      }

      const rpcChannel = asText(source.rpcChannel).trim()
      if (!RPC_CHANNEL_PATTERN.test(rpcChannel) || rpcChannel === '/api') {
        errors.push({ field: 'rpcChannel', code: 'rpcChannel' })
      } else {
        patch.rpcChannel = rpcChannel
      }

      if (errors.length > 0) return { ok: false, patch: null, errors }
      return { ok: true, patch, errors: [] }
    }

    /**
     * Group a token map into top-N rows plus an "other" remainder.
     * @param {unknown} values - keyed token map, or array of `{key,value}` rows.
     * @param {number} [topN] - number of named rows.
     * @returns {{items: Array<{key: string, value: number}>, other: number, total: number}} grouping.
     */
    function groupTop(values, topN = 6) {
      const entries = []
      if (isPlainObject(values)) {
        for (const [key, value] of Object.entries(values)) {
          if (DANGEROUS_KEYS.includes(key)) continue
          const number = Number(value)
          if (Number.isFinite(number) && number > 0) entries.push({ key, value: number })
        }
      } else if (Array.isArray(values)) {
        for (const entry of values) {
          if (!isPlainObject(entry)) continue
          const key = typeof entry.key === 'string' ? entry.key : ''
          const number = Number(entry.value ?? entry.tokens)
          if (key !== '' && Number.isFinite(number) && number > 0) entries.push({ key, value: number })
        }
      }
      entries.sort((left, right) => right.value - left.value)
      const limit = Number.isInteger(topN) && topN > 0 ? topN : 6
      const items = entries.slice(0, limit)
      const other = entries.slice(limit).reduce((sum, entry) => sum + entry.value, 0)
      const total = entries.reduce((sum, entry) => sum + entry.value, 0)
      return { items, other, total }
    }

    /**
     * Build integer-width stacked segments whose widths add up to exactly 100.
     *
     * Zero/negative/non-finite values are dropped; the last segment absorbs the
     * floating-point remainder.
     * @param {Array<{key?: string, label?: string, value: unknown}>} entries - series.
     * @returns {Array<object>} segments with `startPercent` and `widthPercent`.
     */
    function buildStackedSegments(entries) {
      if (!Array.isArray(entries)) return []
      const positive = []
      for (const entry of entries) {
        if (!isPlainObject(entry)) continue
        const value = Number(entry.value)
        if (!Number.isFinite(value) || value <= 0) continue
        positive.push({ ...entry, value })
      }
      const total = positive.reduce((sum, entry) => sum + entry.value, 0)
      if (total <= 0) return []
      let cursor = 0
      return positive.map((entry, index) => {
        const start = cursor
        const fraction = entry.value / total
        cursor = index === positive.length - 1 ? 1 : cursor + fraction
        const end = index === positive.length - 1 ? 1 : cursor
        return {
          ...entry,
          fraction: end - start,
          startPercent: start * 100,
          widthPercent: (end - start) * 100,
        }
      })
    }

    /**
     * Lay out the daily trend chart.
     *
     * Pure geometry helper: no DOM, no React. Each day becomes one stacked bar
     * (prompt at the baseline, output above it). Coordinates are in the given
     * viewBox; zero/negative or non-finite dimensions produce an empty layout,
     * and days are always returned oldest first.
     * @param {unknown} byDay - raw or normalized `byDay` rows.
     * @param {number} width - viewBox width.
     * @param {number} height - viewBox height.
     * @returns {{width: number, height: number, count: number, maxTotal: number, totals: object, points: Array<object>}} layout.
     */
    function buildTrendPoints(byDay, width, height) {
      const days = normalizeDays(byDay)
      const safeWidth = Number.isFinite(Number(width)) && Number(width) > 0 ? Number(width) : 0
      const safeHeight = Number.isFinite(Number(height)) && Number(height) > 0 ? Number(height) : 0
      const layout = {
        width: safeWidth,
        height: safeHeight,
        count: 0,
        maxTotal: 0,
        totals: { promptTokens: 0, outputTokens: 0, tokens: 0, requests: 0 },
        points: [],
      }
      if (safeWidth === 0 || safeHeight === 0 || days.length === 0) return layout
      let maxTotal = 1
      for (const day of days) {
        layout.totals.promptTokens += day.promptTokens
        layout.totals.outputTokens += day.outputTokens
        layout.totals.tokens += day.tokens
        layout.totals.requests += day.requests
        if (day.tokens > maxTotal) maxTotal = day.tokens
      }
      const count = days.length
      const gap = count > 1 ? Math.min(2, safeWidth / (count * 4)) : 0
      const slotWidth = Math.max(0, (safeWidth - gap * (count - 1)) / count)
      // Keep a single day (or a few) from becoming a full-width block; center
      // the capped bar inside its slot so the spacing stays even.
      const barWidth = Math.min(slotWidth, 28)
      layout.count = count
      layout.maxTotal = maxTotal
      layout.points = days.map((day, index) => {
        const promptHeight = (day.promptTokens / maxTotal) * safeHeight
        const outputHeight = (day.outputTokens / maxTotal) * safeHeight
        const promptY = safeHeight - promptHeight
        const outputY = promptY - outputHeight
        return {
          key: day.day,
          index,
          day: day.day,
          label: formatDayLabel(day.day),
          x: index * (slotWidth + gap) + (slotWidth - barWidth) / 2,
          barWidth,
          promptTokens: day.promptTokens,
          outputTokens: day.outputTokens,
          tokens: day.tokens,
          requests: day.requests,
          cost: day.cost,
          promptHeight,
          outputHeight,
          promptY,
          outputY,
          top: outputY,
        }
      })
      return layout
    }

    /**
     * Theme-token series colors; no literal palette is used.
     * @param {number} index - series index.
     * @returns {string} CSS color value built from theme tokens.
     */
    function seriesColor(index) {
      const tokens = [
        'var(--dsw-alias-brand-primary)',
        'var(--dsw-alias-state-success-primary)',
        'var(--dsw-alias-state-warn-primary)',
        'var(--dsw-alias-state-error-primary)',
        'var(--dsw-alias-state-business-primary)',
        'var(--dsw-alias-state-idle-primary)',
      ]
      const safeIndex = Number.isInteger(index) && index >= 0 ? index : 0
      const token = tokens[safeIndex % tokens.length]
      const weight = 82 - (Math.floor(safeIndex / tokens.length) % 3) * 16
      return `color-mix(in srgb, ${token} ${weight}%, var(--dsw-alias-bg-layer-1))`
    }

    /**
     * Localize a purpose key, keeping unknown Host purposes as data.
     * @param {(key: string, params?: object) => string} t - translator.
     * @param {unknown} key - purpose key.
     * @returns {string} label.
     */
    function purposeLabel(t, key) {
      const value = typeof key === 'string' && key.length > 0 ? key : 'chat'
      if (value === 'chat' || value === 'auto-review' || value === 'compaction' || value === 'session-title') {
        return t(`purpose.${value}`)
      }
      return value
    }

    /**
     * Localize a category key. Named system sections and tool groups keep their
     * data name after a localized prefix; the M2.1 common keys get friendly
     * labels instead (`tools:memory` → 记忆工具声明).
     * @param {(key: string, params?: object) => string} t - translator.
     * @param {unknown} key - category key.
     * @returns {string} label.
     */
    function categoryLabel(t, key) {
      const value = typeof key === 'string' ? key : ''
      if (value === '') return t('category.unknown')
      const exact = {
        user: 'category.user',
        'assistant-text': 'category.assistant-text',
        'assistant-other': 'category.assistant-other',
        'reasoning-replay': 'category.reasoning-replay',
        'tool-call-args': 'category.tool-call-args',
        'injected:image': 'category.injected-image',
        'injected:file': 'category.injected-file',
        [FALLBACK_CATEGORY]: 'category.fallback',
        'tool-result:unknown': 'category.tool-result-unknown',
        'system:unknown': 'category.system-unknown',
        'system:superseded': 'category.system-superseded',
        'developer-message': 'category.developer-message',
        'tools:memory': 'category.tools-memory',
        'tools:skill': 'category.tools-skill',
        'tools:agent-teams': 'category.tools-agent-teams',
        'tools:history': 'category.tools-history',
        'tool-result:memory': 'category.tool-result-memory',
        'tool-result:skill': 'category.tool-result-skill',
        'injected:skill-catalog': 'category.injected-skill-catalog',
        'injected:skill-invocation': 'category.injected-skill-invocation',
        'injected:auto-review': 'category.injected-auto-review',
      }
      if (hasOwn(exact, value)) return t(exact[value])
      if (value.startsWith('system:')) {
        const name = value.slice('system:'.length)
        if (name.startsWith('mnemon')) return t('category.system-mnemon')
        return t('category.system-section', { name })
      }
      if (value.startsWith('injected:')) {
        const name = value.slice('injected:'.length)
        if (name.startsWith('memory')) return t('category.injected-memory')
        return t('category.injected', { name })
      }
      if (value.startsWith('tool-result:')) {
        return t('category.tool-result', { name: value.slice('tool-result:'.length) })
      }
      if (value.startsWith('tools:')) {
        return t('category.tools', { name: value.slice('tools:'.length) })
      }
      return value
    }

    /**
     * Build the full content-source drill-down rows.
     *
     * Every `byCategory` entry is included, sorted by tokens descending; `share`
     * is the fraction of the measured prompt (0 when the range has no prompt
     * tokens). Entries sent as `{tokens}` objects are accepted for forward
     * compatibility.
     * @param {unknown} byCategory - normalized category token map.
     * @param {unknown} totalPromptTokens - denominator (`totals.promptTokens`).
     * @param {(key: string, params?: object) => string} t - translator.
     * @returns {Array<{key: string, label: string, tokens: number, share: number}>} rows.
     */
    function categoryTableRows(byCategory, totalPromptTokens, t) {
      const total = tokenNumber(totalPromptTokens)
      const rows = []
      for (const [key, value] of Object.entries(isPlainObject(byCategory) ? byCategory : {})) {
        if (key === '' || DANGEROUS_KEYS.includes(key)) continue
        const tokens = isPlainObject(value)
          ? tokenNumber(value.tokens ?? value.value ?? value.promptTokens)
          : tokenNumber(value)
        rows.push({
          key,
          label: categoryLabel(t, key),
          tokens,
          share: total > 0 ? tokens / total : 0,
        })
      }
      rows.sort((left, right) => (right.tokens - left.tokens) || left.key.localeCompare(right.key))
      return rows
    }

    /**
     * Localize a migration status value.
     * @param {(key: string, params?: object) => string} t - translator.
     * @param {unknown} status - status value.
     * @returns {string} localized status or the raw value.
     */
    function migrationStatusLabel(t, status) {
      const value = typeof status === 'string' ? status : ''
      const known = {
        ok: 'config.migration.ok',
        adopted: 'config.migration.adopted',
        migrating: 'config.migration.migrating',
        failed: 'config.migration.failed',
        'requires-migration': 'config.migration.required',
      }
      if (hasOwn(known, value)) return t(known[value])
      return value === '' ? t('config.migration.unknown') : value
    }

    /**
     * Localize a Config field name.
     * @param {(key: string, params?: object) => string} t - translator.
     * @param {string} name - field name.
     * @returns {string} label.
     */
    function configFieldLabel(t, name) {
      const label = t(`config.field.${name}`)
      return label === `config.field.${name}` ? name : label
    }

    /**
     * Localize a Config field hint.
     * @param {(key: string, params?: object) => string} t - translator.
     * @param {string} name - field name.
     * @returns {string} hint text.
     */
    function configFieldHint(t, name) {
      const key = `config.field.${name}Hint`
      const hint = t(key)
      return hint === key ? '' : hint
    }

    /**
     * Map a structured validation error code to localized copy.
     * @param {(key: string, params?: object) => string} t - translator.
     * @param {object|null} error - error.
     * @returns {string} message.
     */
    function validationMessage(t, error) {
      if (!isPlainObject(error)) return ''
      const key = `config.error.${error.code}`
      const text = t(key)
      if (text !== key) return text
      if (typeof error.message === 'string' && error.message.length > 0) return error.message
      return t('config.error.generic')
    }

    /**
     * Map an RPC error code to localized copy.
     * @param {(key: string, params?: object) => string} t - translator.
     * @param {object|null} error - error.
     * @returns {string} message.
     */
    function rpcErrorMessage(t, error) {
      const code = typeof error?.code === 'string' ? error.code : 'unknown'
      const key = `error.code.${code}`
      const text = t(key)
      return text === key ? t('error.code.unknown') : text
    }

    /**
     * Find the first form error for a field prefix.
     * @param {Array<object>} errors - form errors.
     * @param {string} name - field name.
     * @returns {object|null} error.
     */
    function findFieldError(errors, name) {
      if (!Array.isArray(errors)) return null
      return errors.find(error => error.field === name
        || (typeof error.field === 'string' && error.field.startsWith(`${name}.`))) ?? null
    }

    // ---------------------------------------------------------------------
    // Locale dictionaries
    // ---------------------------------------------------------------------

    const LOCALE = {
      en: {
        'panel.title': 'Token usage',
        'panel.subtitle': 'Token attribution for model calls in this profile',
        'panel.refresh': 'Refresh',
        'panel.refreshing': 'Refreshing…',
        'panel.updatedAt': 'Updated {time}',
        'panel.neverUpdated': 'Not updated yet',
        'panel.settings': 'Usage settings',
        'panel.autoRefreshOn': 'Auto-refresh on',
        'panel.autoRefreshOff': 'Auto-refresh off',
        'panel.readOnly': 'Read-only data',
        'panel.rangeLabel': 'Time range',
        'panel.rangeAria': 'Choose the usage time range',

        'tab.overview': 'Overview',
        'tab.sessions': 'Sessions',
        'tab.models': 'Models',
        'tab.sources': 'Sources',
        'tab.web': 'Search',
        'tab.details': 'Details',
        'tab.settings': 'Settings',

        'range.today': 'Today',
        'range.7d': 'Last 7 days',
        'range.30d': 'Last 30 days',

        'card.total': 'Total tokens (with cache)',
        'card.totalHint': 'Measured prompt + output',
        'card.prompt': 'Prompt tokens',
        'card.promptHint': 'Includes cache reads and writes',
        'card.output': 'Output tokens',
        'card.outputHint': 'Reasoning is included in output',
        'card.cacheHit': 'Cache hit rate',
        'card.cacheHint': 'Read {read} · Write {write}',
        'card.requests': 'Requests',
        'card.requestsHint': 'Measured {measured} · Estimated {estimated}',
        'card.cost': 'Estimated cost',
        'card.costHint': 'Based on the configured prices',
        'card.costUnpriced': 'Unpriced requests: {count}',
        'card.costUnpricedReasons': 'Unpriced requests: {count} ({reasons})',
        'card.costPriced': 'Price table applied',
        'card.webApi': 'Search & fetch',
        'card.webApiValue': '{calls} {unit}',
        'card.webApiUnit': 'calls',
        'card.webApiTotalTitle': 'Observed web_search + web_fetch tool calls: {count}',
        'card.webApiCounts': 'Search {search} · Fetch {fetch}',
        'card.webApiFailed': 'Failed {count}',
        'card.webApiUnattributed': 'Unattributed {count}',
        'card.webApiCost': 'Estimated {amount} {currency}',
        'card.webApiNoBillable': 'No billable calls',
        'card.estimatedShare': '{percent} estimated',
        'card.valueUnavailable': '—',

        'chart.purpose.title': 'By call purpose',
        'chart.purpose.hint': 'Every recorded call, split by purpose',
        'chart.category.title': 'By content source',
        'chart.category.hint': 'Prompt tokens grouped by estimated content source; every group with tokens is shown. The raw category detail follows below.',
        'chart.category.hintOverview': 'Prompt tokens grouped by estimated content source',
        'chart.category.detailTitle': 'Content-source detail',
        'chart.category.detailHint': 'Every raw attribution category behind the groups above',
        'chart.category.expand': 'Show detail',
        'chart.category.collapse': 'Hide detail',
        'chart.category.detailCategory': 'Category',
        'chart.category.detailTokens': 'Tokens',
        'chart.category.detailShare': 'Share of prompt',
        'chart.category.detailEmpty': 'No category detail in this range',
        'chart.other': 'Other',
        'chart.empty': 'No data in this range',
        'chart.total': 'Total {tokens}',
        'chart.value': '{tokens} · {percent}',
        'chart.barAria': '{title} stacked bar',
        'chart.legendAria': '{title} legend',

        'trend.title': 'By day',
        'trend.hint': 'Prompt and output tokens per day, oldest to newest',
        'trend.prompt': 'Prompt',
        'trend.output': 'Output',
        'trend.barTitle': '{day} · prompt {prompt} · output {output}',
        'trend.empty': 'No daily data in this range',

        'purpose.chat': 'Main chat',
        'purpose.auto-review': 'Auto review',
        'purpose.compaction': 'Compaction',
        'purpose.session-title': 'Session title',
        'purpose.other': 'Other',
        'purpose.unknown': 'Unknown purpose',

        'category.user': 'User',
        'category.assistant-text': 'Assistant text',
        'category.assistant-other': 'Assistant other',
        'category.reasoning-replay': 'Replayed reasoning',
        'category.tool-call-args': 'Tool call arguments',
        'category.injected-image': 'Image input',
        'category.injected-file': 'File input',
        'category.injected': 'Injected · {name}',
        'category.system-section': 'System prompt · {name}',
        'category.system-unknown': 'System prompt · unknown section',
        'category.system-superseded': 'System prompt · superseded',
        'category.developer-message': 'Developer message',
        'category.tools': 'Tool declarations · {name}',
        'category.tool-result': 'Tool result · {name}',
        'category.tool-result-unknown': 'Tool result · unknown',
        'category.fallback': 'Unattributed',
        'category.unknown': 'Unknown source',
        'category.other': 'Other',
        'category.tools-memory': 'Memory tool declarations',
        'category.tools-skill': 'Skill tool declarations',
        'category.tools-agent-teams': 'Agent Teams tool declarations',
        'category.tools-history': 'History tool declarations',
        'category.tool-result-memory': 'Memory tool results',
        'category.tool-result-skill': 'Skill tool results',
        'category.injected-skill-catalog': 'Skill catalog',
        'category.injected-skill-invocation': 'Skill invocation',
        'category.injected-memory': 'Memory injection',
        'category.injected-auto-review': 'Auto-review input',
        'category.system-mnemon': 'Mnemon system section',

        'categoryGroup.user': 'User',
        'categoryGroup.assistant': 'Assistant',
        'categoryGroup.developer': 'Developer',
        'categoryGroup.reasoning': 'Replayed reasoning',
        'categoryGroup.tool-call': 'Tool call arguments',
        'categoryGroup.tool-result': 'Tool results',
        'categoryGroup.tool-decl': 'Tool declarations',
        'categoryGroup.memory': 'Memory',
        'categoryGroup.skill': 'Skill',
        'categoryGroup.agent-teams': 'Agent Teams',
        'categoryGroup.history': 'History',
        'categoryGroup.injected': 'Injected context',
        'categoryGroup.auto-review': 'Auto review',
        'categoryGroup.system': 'System prompt',
        'categoryGroup.other': 'Other',

        'table.sessions.title': 'Top sessions',
        'table.sessions.hint': 'By measured tokens in this range',
        'table.sessions.session': 'Session',
        'table.sessions.requests': 'Requests',
        'table.sessions.tokens': 'Tokens',
        'table.sessions.promptTokens': 'Input',
        'table.sessions.outputTokens': 'Output',
        'table.sessions.cacheRate': 'Cache rate',
        'table.sessions.expand': 'Expand child sessions',
        'table.sessions.collapse': 'Collapse child sessions',
        'table.sessions.children': '{count} child sessions',
        'table.sessions.rootsOnlyHint': 'Root sessions only by default; row totals include all child sessions, and expanding shows subagent sessions',
        'table.sessions.empty': 'No sessions in this range',
        'table.sessions.unknown': 'Unknown session',
        'table.sessions.subagent': 'Subagent',
        'table.sessions.topTitle': 'Sessions · Top {count}',
        'table.sessions.topHint': 'Top {count} sessions by measured tokens in this range; totals include child sessions',
        'table.webApiSessions.title': 'Search & fetch sessions',
        'table.webApiSessions.topTitle': 'Search & fetch sessions · Top {count}',
        'table.webApiSessions.hint': 'Sorted by observed search/fetch calls in this range; data comes from Host-observed web_search / web_fetch tool calls',
        'table.webApiSessions.search': 'Search',
        'table.webApiSessions.fetch': 'Fetch',
        'table.webApiSessions.unattributed': 'Unattributed (pre-M2.5 totals)',
        'table.webApiSessions.topUnattributed': '{count} more unattributed call(s)',
        'table.webApiSessions.unattributedHint': 'Rows with a session come from the tool-call events the Host records since M2.5; the unattributed row reconciles the card total with those per-session rows (older days kept totals only).',
        'table.webApiSessions.expand': 'Show all ({count})',
        'table.webApiSessions.collapse': 'Show less',
        'table.models.title': 'Models',
        'table.models.hint': 'Measured prompt and output by provider/model',
        'table.models.provider': 'Provider',
        'table.models.model': 'Model',
        'table.models.requests': 'Requests',
        'table.models.tokens': 'Tokens',
        'table.models.promptTokens': 'Input',
        'table.models.outputTokens': 'Output',
        'table.models.empty': 'No model calls in this range',
        'table.models.unknown': 'Unknown',
        'table.models.topTitle': 'Models · Top {count}',
        'table.tokensTotal': 'Total',
        'table.share': 'Share',
        'table.cost': 'Cost',
        'table.costMixed': 'Mixed',
        'unpriced.aborted': 'Aborted',
        'unpriced.transport': 'Transport failed',
        'unpriced.no-usage': 'No usage',
        'unpriced.no-price': 'No price',
        'unpriced.other': 'Other',
        'unpriced.unknown': 'Unknown',
        'unpriced.reasonItem': '{label} {count}',
        'table.toolGroups.title': 'Tool groups',
        'table.toolGroups.hint': 'Prompt tokens by tool group (tool declarations and tool results)',
        'table.toolGroups.group': 'Tool group',
        'table.toolGroups.tokens': 'Tokens',
        'table.toolGroups.share': 'Share of prompt',
        'table.toolGroups.empty': 'No tool-group data in this range',
        'toolGroup.memory': 'Memory',
        'toolGroup.skill': 'Skill',
        'toolGroup.agent-teams': 'Agent Teams',
        'toolGroup.files': 'Files & workspace',
        'toolGroup.shell': 'Shell & terminal',
        'toolGroup.web': 'Search & fetch',
        'toolGroup.session': 'Session & history',
        'toolGroup.goals': 'Goals',
        'toolGroup.schedule': 'Schedule',
        'toolGroup.subagents': 'Subagents',
        'toolGroup.plugins': 'Plugins & system',
        'toolGroup.browser': 'Browser',
        'toolGroup.workflow': 'Workflow',
        'toolGroup.history': 'History',
        'toolGroup.other': 'Other · {name}',
        'toolGroup.unknown': 'Unknown tool',

        'details.title': 'Request details',
        'details.hint': 'Every request in the selected range, {limit} rows per page',
        'details.purposeFilter': 'Purpose',
        'details.sessionFilter': 'Session',
        'details.unpricedOnly': 'Unpriced only',
        'details.unpricedReason': 'Unpriced reason',
        'details.filterAll': 'All',
        'details.session': 'Session',
        'details.loadMore': 'Load more',
        'details.loading': 'Loading request details…',
        'details.loadingMore': 'Loading more…',
        'details.empty': 'No request details in this range',
        'details.failed': 'Could not load request details.',
        'details.progress': 'Showing {shown} of {total}',
        'details.loadedAll': 'All {total} rows loaded',

        'table.sessions.open': 'Open session detail: {name}',
        'sessionDetail.back': 'Back to sessions',
        'sessionDetail.breadcrumb': 'Session path',
        'sessionDetail.includeDescendants': 'Include subagents',
        'sessionDetail.onlySession': 'This session only',
        'sessionDetail.toggleHint': 'Totals include this session and all its descendant sessions.',
        'sessionDetail.toggleSingleHint': 'Totals cover this session only.',
        'sessionDetail.subtreeNote': 'Showing subtree totals',
        'sessionDetail.singleNote': 'Showing this session only',
        'sessionDetail.loading': 'Loading session detail…',
        'sessionDetail.loadFailed': 'Could not load this session detail.',
        'sessionDetail.unavailable': 'Request detail is only kept for 30 days, so attribution cannot be expanded.',
        'sessionDetail.partial': 'Part of this range has no request detail; breakdowns cover only the retained days.',
        'sessionDetail.missing': 'This session no longer appears in the selected range.',
        'sessionDetail.missingHint': 'Go back to the session list and pick another session.',
        'sessionDetail.summaryTitle': 'Session summary',
        'sessionDetail.cardsHint': 'Totals for the selected session at the current range',
        'sessionDetail.childrenTitle': 'Direct child sessions',
        'sessionDetail.childrenHint': 'Subtree totals include every child; click a child to drill down.',
        'sessionDetail.childrenHintSingle': 'Only this session is counted; children are listed separately and can be opened.',
        'sessionDetail.childrenEmpty': 'No direct child sessions in this range',
        'sessionDetail.child': 'Open child session: {name}',
        'sessionDetail.crumb': 'Open ancestor session: {name}',
        'sessionDetail.requestsTitle': 'Session requests',
        'sessionDetail.requestsHint': 'Requests for the selected session set, {limit} per page',
        'sessionDetail.requestsEmpty': 'No request details for this session set',
        'sessionDetail.requestsFailed': 'Could not load the session request details.',
        'sessionDetail.webHint': 'Search and fetch calls attributed to the selected session set.',

        'requests.title': 'Recent requests',
        'requests.hint': 'Range end day {date} · up to {limit} rows',
        'requests.expand': 'Show',
        'requests.collapse': 'Hide',
        'requests.loading': 'Loading recent requests…',
        'requests.empty': 'No request detail in this range',
        'requests.failed': 'Could not load request detail.',
        'requests.time': 'Time',
        'requests.purpose': 'purpose',
        'requests.prompt': 'prompt',
        'requests.output': 'output',
        'requests.cacheRead': 'cacheRead',

        'export.json': 'Export JSON',
        'export.csv': 'Export CSV',
        'export.busy': 'Exporting {format}…',
        'export.saved': 'Saved {filename} ({bytes} bytes)',
        'export.truncated': 'Saved {filename} ({bytes} bytes); the Host truncated the content.',
        'export.failed': 'Export failed: {message}',
        'export.download.noDocument': 'This browser cannot save files: the download API is unavailable.',
        'export.download.emptyContent': 'The Host returned an empty export.',
        'export.download.saveFailed': 'The browser could not save the export file.',

        'footnote.title': 'How to read this page',
        'footnote.usage': 'Totals, prompt/output and cache figures come from the provider usage returned with each call. Content-source splits are character-weight estimates normalized per request, so their sum equals the measured prompt.',
        'footnote.estimated': '{estimated} estimated request(s) and {measured} measured request(s) are included; estimated records are marked in the ledger.',
        'footnote.estimatedTokens': 'Estimated prompt tokens: {tokens} of {total} ({percent}).',
        'footnote.cost': 'Cost is calculated from the configured price table; it is not a provider bill.',
        'footnote.costTiers': 'Cost uses the peak or off-peak price for each request\'s time (Asia/Shanghai): weekdays 09:00–12:00 and 14:00–18:00 are peak; other times and weekends are off-peak. Statutory holidays count as off-peak only when listed under the whole-day off-peak dates.',
        'footnote.costMixed': 'Totals span more than one currency, so per-currency amounts stay separate and are not summed.',
        'footnote.costBreakdown': 'By currency: {breakdown}; amounts are shown per currency and never summed.',
        'footnote.costCurrencyItem': '{currency} {amount} (unpriced {count})',
        'footnote.costDetailIncomplete': 'Some historical days keep only daily totals because their detail rows aged out, so per-source, per-session, and per-model cost is incomplete.',
        'footnote.webApi': 'Search & fetch counts come from the observed web_search and web_fetch tool calls in this range; a successful call is billable under the provider\'s per-request pricing, while failed calls are counted but not billed. Amounts are estimates at the configured per-1,000 rates and provider-side billing may differ (for example a provider may bundle search into model turns; one tool call can issue several queries and is counted once here).',
        'footnote.retention': 'Data since {since}. Request detail is kept for {requestDays} days; daily aggregates for {dailyDays} days.',
        'footnote.retentionUnknown': 'Retention settings are not available yet.',
        'footnote.readOnly': 'The data directory is read-only; live calls are still observed but new records cannot be written.',
        'footnote.dataRoot': 'Data directory: {path}',
        'footnote.pointer': 'Ledger pointer status: {status}',
        'footnote.migration': 'A data-directory migration is required. Save the configuration in the settings panel to start it.',
        'footnote.migrationStatus': 'Data directory migration: {status}.',
        'footnote.generated': 'Summary generated at {time}.',
        'footnote.privacy': 'Privacy: the ledger stores numbers, category names, session ids, hashes, provider and model only — never prompt text.',
        'footnote.source': 'Host RPC channel: {channel}',

        'state.loading': 'Loading usage…',
        'state.loadingHint': 'Reading the local ledger through the Host RPC channel.',
        'state.empty.title': 'No calls recorded yet',
        'state.empty.hint': 'Start a conversation or a tool call in this profile; usage will appear here.',
        'state.empty.retry': 'Refresh now',
        'state.error.title': 'Could not load usage',
        'state.error.hint': 'The Host RPC call failed. Check that the plugin is installed and the Host is running, then retry.',
        'state.error.refreshFailed': 'Refresh failed: {message}',
        'state.error.detail': 'Technical detail',
        'state.error.retry': 'Retry',
        'state.error.noConnection': 'The Client Connection service is unavailable in this profile.',
        'state.error.unknown': 'Unknown error',

        'error.code.bad-request': 'The Host rejected the request parameters.',
        'error.code.unknown-endpoint': 'The Host does not expose this endpoint.',
        'error.code.internal': 'The Host failed while serving the request.',
        'error.code.config-invalid': 'The configuration was rejected by the Host validator.',
        'error.code.config-readonly': 'This profile has no configuration editor; edit the profile configuration file instead.',
        'error.code.config-write-failed': 'The Host could not persist the configuration.',
        'error.code.transport': 'The RPC transport failed. The Host may be restarting.',
        'error.code.no-connection': 'The Client Connection service is unavailable.',
        'error.code.invalid-response': 'The Host returned an unexpected RPC response.',
        'error.code.unknown': 'The Host reported an unknown error.',

        'config.title': 'Usage settings',
        'config.subtitle': 'All fields of the token-attribution plugin configuration',
        'config.close': 'Close settings',
        'config.section.general': 'General',
        'config.section.retention': 'Retention and limits',
        'config.section.pricing': 'Price table',
        'config.section.webApi': 'Search & fetch estimate',
        'config.section.advanced': 'Advanced',
        'config.section.status': 'Configuration status',
        'config.readOnly': 'Read-only configuration',
        'config.readOnlyHint': 'This profile provides no configEditor. The fields below show the active values; edit the profile configuration file to change them.',
        'config.loading': 'Loading configuration…',
        'config.loadError': 'Could not load the configuration.',
        'config.reload': 'Reload',
        'config.reloadHint': 'Discard unsaved edits and read the values again from the Host.',
        'config.save': 'Save',
        'config.saving': 'Saving…',
        'config.cancel': 'Cancel',
        'config.saved': 'Configuration saved.',
        'config.savedRestart': 'Restart the plugin to apply: {fields}.',
        'config.saveFailed': 'Configuration was not saved.',
        'config.restartBadge': 'Restart required',
        'config.restartTitle': 'Restart required',
        'config.restartHint': 'Changing this field restarts the plugin or needs a DSH restart before it takes effect.',
        'config.diagnostics': 'Host diagnostics',
        'config.noDiagnostics': 'No diagnostics from the Host.',
        'config.field.dataDir': 'Data directory',
        'config.field.dataDirHint': 'Absolute directory for the ledger; empty uses the profile default. Changing it starts a migration (copy, verify, switch pointer; failure falls back to the old directory).',
        'config.field.dataDirPlaceholder': 'Leave empty to use the profile default directory',
        'config.field.retainRequestDays': 'Request detail retention (days)',
        'config.field.retainRequestDaysHint': '1–3650 days of per-request records.',
        'config.field.retainDailyDays': 'Daily aggregate retention (days)',
        'config.field.retainDailyDaysHint': '1–3650 days of daily aggregates.',
        'config.field.flushIntervalMs': 'Flush interval (ms)',
        'config.field.flushIntervalMsHint': 'How often queued records are written to disk (500–60000 ms).',
        'config.field.maxDetailRowsPerDay': 'Max detail rows per day',
        'config.field.maxDetailRowsPerDayHint': 'Reserved in M1b: the value is validated and stored, but per-day detail thinning is not applied yet.',
        'config.field.enableAutoRefresh': 'Auto-refresh',
        'config.field.enableAutoRefreshHint': 'Refresh the dashboard periodically while this panel is open.',
        'config.field.rememberLastTab': 'Remember last tab',
        'config.field.rememberLastTabHint': 'Restore the last active tab when the panel opens; when off the panel always starts on Overview.',
        'config.field.autoRefreshIntervalMs': 'Auto-refresh interval (ms)',
        'config.field.autoRefreshIntervalMsHint': '1000–3600000 ms between automatic refreshes.',
        'config.field.rpcChannel': 'RPC channel',
        'config.field.rpcChannelHint': 'Connection RPC path, a single segment beginning with "/". Changing it requires a plugin restart.',
        'config.field.toolGroups': 'Tool groups (JSON)',
        'config.field.toolGroupsHint': 'Tool names or prefixes per group; custom group names are allowed (1–32 lowercase letters, digits or hyphens, excluding "other"; the legacy agentTeams key also works). Groups are matched in order and the first match wins; each group holds up to 200 entries and invalid entries are reported.',
        'config.field.pricing': 'Price entries',
        'config.field.pricingHint': 'Input, cache read, cache write and output prices are per one million tokens. Unmatched calls stay unpriced.',
        'config.field.pricingOffPeakDays': 'Whole-day off-peak dates',
        'config.field.pricingOffPeakDaysHint': 'Asia/Shanghai time. Peak = weekdays 09:00–12:00 / 14:00–18:00; every other time is off-peak at half price. Add statutory holidays here, one YYYY-MM-DD per line.',
        'config.defaultValue': 'Default: {value}',
        'config.dataDir.current': 'Current directory',
        'config.dataDir.target': 'Configured directory',
        'config.migration.status': 'Migration status',
        'config.migration.ok': 'Ready',
        'config.migration.required': 'Migration required',
        'config.migration.adopted': 'Legacy ledger adopted',
        'config.migration.migrating': 'Migrating',
        'config.migration.failed': 'Migration failed',
        'config.migration.unknown': 'Unknown',
        'config.migration.warning': 'The configured data directory differs from the active one. On save the Host migrates by copying, verifying and switching the pointer; if that fails it keeps using the old directory and reports diagnostics.',
        'config.migration.failedHint': 'The last migration did not finish; the ledger is still using the current directory. Review the Host diagnostics, then fix the target directory and save again.',
        'config.migration.inProgress': 'A migration is running. Keep DSH open until it finishes; the ledger stays readable from the current directory.',
        'config.migration.adoptedHint': 'The legacy default-profile ledger was adopted. The old directories are kept as a backup and cleaned up by the Host retention policy.',
        'config.migration.pendingSave': 'Saving migrates the ledger to {path} after the plugin reloads.',
        'config.migration.note': 'The old directory is retained as a backup after a successful switch and is cleaned up by the Host retention policy.',
        'config.migration.readOnly': 'The ledger is read-only, so a migration cannot start now.',
        'config.pricing.empty': 'No price entries. Every call is recorded as unpriced.',
        'config.pricing.add': 'Add price entry',
        'config.pricing.remove': 'Remove price entry {index}',
        'config.pricing.rowLabel': 'Price entry {index}',
        'config.pricing.provider': 'Provider',
        'config.pricing.model': 'Model (exact, prefix* or *)',
        'config.pricing.currency': 'Currency',
        'config.pricing.inputPerMillion': 'Input / million',
        'config.pricing.cacheReadPerMillion': 'Cache read / million',
        'config.pricing.cacheWritePerMillion': 'Cache write / million',
        'config.pricing.outputPerMillion': 'Output / million',
        'config.pricing.offPeakLabel': 'Off-peak prices (optional)',
        'config.pricing.offPeakHint': 'Leave empty to use the peak price',
        'config.pricing.offPeakInputPerMillion': 'Off-peak input / million',
        'config.pricing.offPeakCacheReadPerMillion': 'Off-peak cache read / million',
        'config.pricing.offPeakCacheWritePerMillion': 'Off-peak cache write / million',
        'config.pricing.offPeakOutputPerMillion': 'Off-peak output / million',
        'config.pricing.offPeakDaysPlaceholder': `2026-10-01
2026-12-25`,
        'config.pricing.priceVersion': 'Price version (optional)',
        'config.webApiPricing.hint': 'Official default: 5 CNY per 1,000 successful requests. Amounts are estimates from observed tool calls, not a provider bill.',
        'config.webApiPricing.searchPerThousand': 'Search price / 1,000 calls',
        'config.webApiPricing.fetchPerThousand': 'Fetch price / 1,000 calls',
        'config.webApiPricing.currency': 'Currency',
        'config.webApiPricing.currencyHint': 'Currency code shown with the estimate (for example CNY).',
        'config.advanced.toolGroups': 'Tool groups JSON',
        'config.advanced.diagnostics': 'Diagnostics',
        'config.unknownField': 'Unknown configuration field',
        'config.meta.version': 'Version',
        'config.meta.dataRoot': 'Data root',
        'config.meta.profile': 'Profile',
        'config.meta.pointer': 'Pointer',
        'config.meta.readOnly': 'Read-only',
        'config.meta.since': 'Data since',
        'config.meta.flush': 'Last flush',
        'config.value.default': 'default',
        'config.value.unknown': 'unknown',
        'config.value.yes': 'Yes',
        'config.value.no': 'No',

        'config.error.dataDirAbsolute': 'Use an absolute path (for example D:\\token-data or /srv/token-data).',
        'config.error.required': 'This field is required.',
        'config.error.integer': 'Enter a whole number.',
        'config.error.range': 'The value is outside the allowed range.',
        'config.error.number': 'Enter a number.',
        'config.error.nonNegative': 'Enter a number that is zero or greater.',
        'config.error.rpcChannel': 'Use a single-segment path beginning with "/" (not "/api").',
        'config.error.json-empty': 'Enter a JSON object.',
        'config.error.json-invalid': 'This is not valid JSON.',
        'config.error.json-not-object': 'The JSON value must be an object.',
        'config.error.toolGroups-shape': 'Tool groups must be an object of string arrays.',
        'config.error.toolGroups-list': 'Each group must be an array of at most 200 non-empty strings.',
        'config.error.toolGroups-key': 'Group names must be 1–32 lowercase letters, digits or hyphens (not all digits; "other" is reserved; agentTeams is also accepted).',
        'config.error.price-provider': 'A provider is required for each price entry.',
        'config.error.price-currency': 'A currency is required for each price entry.',
        'config.error.price-number': 'Prices must be zero or greater numbers.',
        'config.error.price-date': 'Use a valid YYYY-MM-DD date.',
        'config.error.webApi-number': 'Search & fetch rates must be zero or greater numbers per 1,000 calls.',
        'config.error.webApi-currency': 'A currency is required for the search & fetch estimate.',
        'config.error.pricing-row': 'This price entry is not an object.',
        'config.error.generic': 'This value is not valid.',
        'config.error.saveDiagnostics': 'The Host rejected the configuration. See the diagnostics below.',

        'button.close': 'Close',
        'button.retry': 'Retry',
        'button.refresh': 'Refresh',
        'button.save': 'Save',
        'button.cancel': 'Cancel',
        'button.reload': 'Reload',
        'button.add': 'Add',
        'button.remove': 'Remove',

        'aria.settings': 'Switch to usage settings',
        'aria.close': 'Close usage settings',
        'aria.refresh': 'Refresh usage data',
        'aria.range': 'Time range',
        'aria.tabs': 'Usage views',
        'aria.tabPanel': '{label} view',
        'aria.panel': 'Token usage dashboard',
        'aria.chart': '{title} chart',
        'aria.loading': 'Loading usage data',
        'aria.error': 'Usage data error',
        'aria.readOnly': 'Read-only configuration',
      },
      zh: {
        'panel.title': '用量',
        'panel.subtitle': '本 profile 内模型调用的 token 归因',
        'panel.refresh': '刷新',
        'panel.refreshing': '正在刷新…',
        'panel.updatedAt': '更新于 {time}',
        'panel.neverUpdated': '尚未更新',
        'panel.settings': '用量设置',
        'panel.autoRefreshOn': '自动刷新已开启',
        'panel.autoRefreshOff': '自动刷新已关闭',
        'panel.readOnly': '只读数据',
        'panel.rangeLabel': '时间范围',
        'panel.rangeAria': '选择用量统计的时间范围',

        'tab.overview': '概览',
        'tab.sessions': '会话',
        'tab.models': '模型',
        'tab.sources': '来源',
        'tab.web': '搜索',
        'tab.details': '明细',
        'tab.settings': '设置',

        'range.today': '今日',
        'range.7d': '近 7 天',
        'range.30d': '近 30 天',

        'card.total': '总 tokens（含缓存）',
        'card.totalHint': '实测 prompt + output',
        'card.prompt': 'Prompt tokens',
        'card.promptHint': '包含缓存读写',
        'card.output': 'Output tokens',
        'card.outputHint': '推理已包含在 output 内',
        'card.cacheHit': '缓存命中率',
        'card.cacheHint': '读 {read} · 写 {write}',
        'card.requests': '请求数',
        'card.requestsHint': '实测 {measured} · 估算 {estimated}',
        'card.cost': '预估费用',
        'card.costHint': '按配置单价估算',
        'card.costUnpriced': '未定价请求：{count}',
        'card.costUnpricedReasons': '未定价请求：{count}（{reasons}）',
        'card.costPriced': '已应用价目表',
        'card.webApi': '搜索 / 抓取',
        'card.webApiValue': '{calls} {unit}',
        'card.webApiUnit': '次',
        'card.webApiTotalTitle': '观测到的 web_search + web_fetch 工具调用：{count}',
        'card.webApiCounts': '搜索 {search} · 抓取 {fetch}',
        'card.webApiFailed': '失败 {count}',
        'card.webApiUnattributed': '未归因 {count}',
        'card.webApiCost': '估算 {amount} {currency}',
        'card.webApiNoBillable': '未产生成功调用',
        'card.estimatedShare': '其中 {percent} 为估算',
        'card.valueUnavailable': '—',

        'chart.purpose.title': '按调用目的',
        'chart.purpose.hint': '所有已记录调用按目的拆分',
        'chart.category.title': '按内容来源',
        'chart.category.hint': 'Prompt tokens 按估算的内容来源分组，展示所有有 token 的分组；原始分类明细见下方。',
        'chart.category.hintOverview': 'Prompt tokens 按估算的内容来源分组',
        'chart.category.detailTitle': '来源明细',
        'chart.category.detailHint': '上方分组背后的全部原始归因分类',
        'chart.category.expand': '展开明细',
        'chart.category.collapse': '收起明细',
        'chart.category.detailCategory': '类别',
        'chart.category.detailTokens': 'Tokens',
        'chart.category.detailShare': '占 prompt',
        'chart.category.detailEmpty': '该范围内暂无分类明细',
        'chart.other': '其他',
        'chart.empty': '该范围内暂无数据',
        'chart.total': '合计 {tokens}',
        'chart.value': '{tokens} · {percent}',
        'chart.barAria': '{title}堆叠条',
        'chart.legendAria': '{title}图例',

        'trend.title': '按天趋势',
        'trend.hint': '按天拆分 prompt 与 output tokens，由旧到新',
        'trend.prompt': 'Prompt',
        'trend.output': 'Output',
        'trend.barTitle': '{day} · prompt {prompt} · output {output}',
        'trend.empty': '该范围内暂无按天数据',

        'purpose.chat': '主对话',
        'purpose.auto-review': '自动审查',
        'purpose.compaction': '压缩',
        'purpose.session-title': '会话标题',
        'purpose.other': '其他',
        'purpose.unknown': '未知目的',

        'category.user': '用户',
        'category.assistant-text': '助手正文',
        'category.assistant-other': '助手其他',
        'category.reasoning-replay': '推理回放',
        'category.tool-call-args': '工具调用参数',
        'category.injected-image': '图片输入',
        'category.injected-file': '文件输入',
        'category.injected': '注入 · {name}',
        'category.system-section': '系统提示 · {name}',
        'category.system-unknown': '系统提示 · 未知段',
        'category.system-superseded': '系统提示 · 旧版本',
        'category.developer-message': '开发者消息',
        'category.tools': '工具声明 · {name}',
        'category.tool-result': '工具结果 · {name}',
        'category.tool-result-unknown': '工具结果 · 未知',
        'category.fallback': '未归因',
        'category.unknown': '未知来源',
        'category.other': '其他',
        'category.tools-memory': '记忆工具声明',
        'category.tools-skill': '技能工具声明',
        'category.tools-agent-teams': 'Agent Teams 工具声明',
        'category.tools-history': '历史工具声明',
        'category.tool-result-memory': '记忆工具结果',
        'category.tool-result-skill': '技能工具结果',
        'category.injected-skill-catalog': '技能目录',
        'category.injected-skill-invocation': '技能调用',
        'category.injected-memory': '记忆注入',
        'category.injected-auto-review': '自动审查输入',
        'category.system-mnemon': 'Mnemon 系统段',

        'categoryGroup.user': '用户',
        'categoryGroup.assistant': '助手',
        'categoryGroup.developer': '开发者',
        'categoryGroup.reasoning': '推理重放',
        'categoryGroup.tool-call': '工具调用参数',
        'categoryGroup.tool-result': '工具结果',
        'categoryGroup.tool-decl': '工具声明',
        'categoryGroup.memory': '记忆',
        'categoryGroup.skill': '技能',
        'categoryGroup.agent-teams': 'Agent Teams',
        'categoryGroup.history': '历史',
        'categoryGroup.injected': '注入上下文',
        'categoryGroup.auto-review': '自动审查',
        'categoryGroup.system': '系统提示',
        'categoryGroup.other': '其他',

        'table.sessions.title': '会话 Top',
        'table.sessions.hint': '按该范围内的实测 tokens 排序',
        'table.sessions.session': '会话',
        'table.sessions.requests': '请求数',
        'table.sessions.tokens': 'Tokens',
        'table.sessions.promptTokens': '输入',
        'table.sessions.outputTokens': '输出',
        'table.sessions.cacheRate': '缓存率',
        'table.sessions.expand': '展开子会话',
        'table.sessions.collapse': '收起子会话',
        'table.sessions.children': '{count} 个子会话',
        'table.sessions.rootsOnlyHint': '默认仅显示根会话；行内数值含全部子会话，展开可查看子代理',
        'table.sessions.empty': '该范围内暂无会话',
        'table.sessions.unknown': '未知会话',
        'table.sessions.subagent': '子代理',
        'table.sessions.topTitle': '会话 Top {count}',
        'table.sessions.topHint': '该范围内实测 tokens 前 {count} 的会话；行内数值含全部子会话',
        'table.webApiSessions.title': '搜索 / 抓取会话',
        'table.webApiSessions.topTitle': '搜索 / 抓取会话 · Top {count}',
        'table.webApiSessions.hint': '按该范围内的搜索/抓取调用排序；数据来自 Host 观测的 web_search / web_fetch 工具调用',
        'table.webApiSessions.search': '搜索',
        'table.webApiSessions.fetch': '抓取',
        'table.webApiSessions.unattributed': '未归因（升级前仅总量）',
        'table.webApiSessions.topUnattributed': '另有未归因 {count} 次',
        'table.webApiSessions.unattributedHint': '带会话的行来自 M2.5 起 Host 记录的工具调用事件；未归因行用于把卡片总量与这些逐会话行核对一致（更早的日期只保留了总量）。',
        'table.webApiSessions.expand': '展开全部（{count}）',
        'table.webApiSessions.collapse': '收起',
        'table.models.title': '模型',
        'table.models.hint': '按 provider/model 汇总实测 prompt 与 output',
        'table.models.provider': 'Provider',
        'table.models.model': '模型',
        'table.models.requests': '请求数',
        'table.models.tokens': 'Tokens',
        'table.models.promptTokens': '输入',
        'table.models.outputTokens': '输出',
        'table.models.empty': '该范围内暂无模型调用',
        'table.models.unknown': '未知',
        'table.models.topTitle': '模型 Top {count}',
        'table.tokensTotal': '合计',
        'table.share': '占比',
        'table.cost': '费用',
        'table.costMixed': '混币',
        'unpriced.aborted': '中断',
        'unpriced.transport': '传输失败',
        'unpriced.no-usage': '无 usage',
        'unpriced.no-price': '未配置价格',
        'unpriced.other': '其他',
        'unpriced.unknown': '未知',
        'unpriced.reasonItem': '{label} {count}',
        'table.toolGroups.title': '工具分组',
        'table.toolGroups.hint': '按工具分组汇总的 prompt tokens（含工具声明与工具结果）',
        'table.toolGroups.group': '工具分组',
        'table.toolGroups.tokens': 'Tokens',
        'table.toolGroups.share': '占 prompt',
        'table.toolGroups.empty': '该范围内暂无工具分组数据',
        'toolGroup.memory': '记忆',
        'toolGroup.skill': '技能',
        'toolGroup.agent-teams': 'Agent Teams',
        'toolGroup.files': '文件/工作区',
        'toolGroup.shell': '命令/终端',
        'toolGroup.web': '搜索/抓取',
        'toolGroup.session': '会话/历史',
        'toolGroup.goals': '目标',
        'toolGroup.schedule': '调度',
        'toolGroup.subagents': '子代理',
        'toolGroup.plugins': '插件/系统',
        'toolGroup.browser': '浏览器',
        'toolGroup.workflow': '工作流',
        'toolGroup.history': '历史',
        'toolGroup.other': '其他·{name}',
        'toolGroup.unknown': '未知工具',

        'details.title': '请求明细',
        'details.hint': '所选范围内的逐条请求，每页 {limit} 条',
        'details.purposeFilter': '调用目的',
        'details.sessionFilter': '会话',
        'details.unpricedOnly': '只看未定价',
        'details.unpricedReason': '未定价原因',
        'details.filterAll': '全部',
        'details.session': '会话',
        'details.loadMore': '加载更多',
        'details.loading': '正在加载请求明细…',
        'details.loadingMore': '正在加载更多…',
        'details.empty': '该范围内暂无请求明细',
        'details.failed': '请求明细加载失败。',
        'details.progress': '已显示 {shown} / {total} 条',
        'details.loadedAll': '已加载全部 {total} 条',

        'table.sessions.open': '打开会话明细：{name}',
        'sessionDetail.back': '返回会话列表',
        'sessionDetail.breadcrumb': '会话路径',
        'sessionDetail.includeDescendants': '含子代理',
        'sessionDetail.onlySession': '仅本会话',
        'sessionDetail.toggleHint': '汇总本会话及其全部子会话。',
        'sessionDetail.toggleSingleHint': '仅统计本会话，不含子会话。',
        'sessionDetail.subtreeNote': '当前为子树汇总',
        'sessionDetail.singleNote': '当前仅统计本会话',
        'sessionDetail.loading': '正在加载会话明细…',
        'sessionDetail.loadFailed': '会话明细加载失败。',
        'sessionDetail.unavailable': '明细仅保留 30 天，无法展开归因',
        'sessionDetail.partial': '该范围部分日期没有明细，归因仅覆盖仍保留明细的日期。',
        'sessionDetail.missing': '该会话已不在所选范围内。',
        'sessionDetail.missingHint': '返回会话列表并选择其他会话。',
        'sessionDetail.summaryTitle': '本会话摘要',
        'sessionDetail.cardsHint': '当前范围下所选会话的汇总',
        'sessionDetail.childrenTitle': '直接子会话',
        'sessionDetail.childrenHint': '子树汇总含全部子会话；点击子会话可继续下钻。',
        'sessionDetail.childrenHintSingle': '仅统计本会话；子会话单独列出，可点击继续下钻。',
        'sessionDetail.childrenEmpty': '该范围内没有直接子会话',
        'sessionDetail.child': '打开子会话：{name}',
        'sessionDetail.crumb': '打开上级会话：{name}',
        'sessionDetail.requestsTitle': '本会话请求明细',
        'sessionDetail.requestsHint': '所选会话集合的逐条请求，每页 {limit} 条',
        'sessionDetail.requestsEmpty': '所选会话集合暂无请求明细',
        'sessionDetail.requestsFailed': '本会话请求明细加载失败。',
        'sessionDetail.webHint': '所选会话集合的搜索 / 抓取调用。',

        'requests.title': '最近请求',
        'requests.hint': '范围结束日 {date} · 最多 {limit} 条',
        'requests.expand': '展开',
        'requests.collapse': '收起',
        'requests.loading': '正在加载最近请求…',
        'requests.empty': '该范围内暂无请求明细',
        'requests.failed': '最近请求加载失败。',
        'requests.time': '时间',
        'requests.purpose': 'purpose',
        'requests.prompt': 'prompt',
        'requests.output': 'output',
        'requests.cacheRead': 'cacheRead',

        'export.json': '导出 JSON',
        'export.csv': '导出 CSV',
        'export.busy': '正在导出 {format}…',
        'export.saved': '已保存 {filename}（{bytes} 字节）',
        'export.truncated': '已保存 {filename}（{bytes} 字节）；内容在 Host 侧被截断。',
        'export.failed': '导出失败：{message}',
        'export.download.noDocument': '当前浏览器无法保存文件：下载能力不可用。',
        'export.download.emptyContent': 'Host 返回了空的导出内容。',
        'export.download.saveFailed': '浏览器保存导出文件失败。',

        'footnote.title': '口径说明',
        'footnote.usage': '总量、prompt/output 与缓存数字来自每次调用返回的真实 usage；内容来源拆分是字符权重估算并按请求归一化，因此各分类之和等于实测 prompt。',
        'footnote.estimated': '其中 {estimated} 条请求为估算、{measured} 条为实测；估算记录在账本中有标记。',
        'footnote.estimatedTokens': '估算 prompt tokens：{tokens} / {total}（{percent}）。',
        'footnote.cost': '费用按配置的价目表估算，不代表 provider 账单。',
        'footnote.costTiers': '费用按请求发生时间选择高峰或空闲单价（时区 Asia/Shanghai）：工作日 09:00–12:00、14:00–18:00 为高峰，其余时段与周末为空闲；法定节假日仅在“全天空闲日期”中列出时按空闲计。',
        'footnote.costMixed': '费用涉及多种币种，按币种分别展示、不做合并。',
        'footnote.costBreakdown': '按币种：{breakdown}；金额分币种展示、不做合并。',
        'footnote.costCurrencyItem': '{currency} {amount}（未定价 {count}）',
        'footnote.costDetailIncomplete': '部分历史日期只剩日聚合总量、明细已过保留期，因此按来源/会话/模型的费用不完整。',
        'footnote.webApi': '搜索 / 抓取次数来自该范围内观测到的 web_search / web_fetch 工具调用；成功调用按 provider 的按次定价计费，失败调用只计数、不计费。金额是按配置的每千次单价估算的，provider 侧实际账单可能不同（例如 provider 把搜索打包进模型调用；一次工具调用可能包含多个查询，这里按一次计）。',
        'footnote.retention': '数据自 {since} 起。明细保留 {requestDays} 天，日聚合保留 {dailyDays} 天。',
        'footnote.retentionUnknown': '保留期信息暂不可用。',
        'footnote.readOnly': '数据目录处于只读状态；宿主仍会观察调用，但新记录无法写入。',
        'footnote.dataRoot': '数据目录：{path}',
        'footnote.pointer': '账本指针状态：{status}',
        'footnote.migration': '检测到数据目录变更，需要迁移。请在设置面板中保存配置以启动迁移。',
        'footnote.migrationStatus': '数据目录迁移状态：{status}。',
        'footnote.generated': '汇总生成于 {time}。',
        'footnote.privacy': '隐私：账本仅保存数字、分类名、sessionId、哈希、provider 与 model，不保存提示词原文。',
        'footnote.source': 'Host RPC 通道：{channel}',

        'state.loading': '正在加载用量…',
        'state.loadingHint': '通过 Host RPC 通道读取本地账本。',
        'state.empty.title': '暂无调用记录',
        'state.empty.hint': '在本 profile 中发起一次对话或工具调用后，用量会显示在这里。',
        'state.empty.retry': '立即刷新',
        'state.error.title': '无法加载用量',
        'state.error.hint': 'Host RPC 调用失败。请确认插件已安装且 Host 正在运行，然后重试。',
        'state.error.refreshFailed': '刷新失败：{message}',
        'state.error.detail': '技术细节',
        'state.error.retry': '重试',
        'state.error.noConnection': '当前 profile 未提供 Client Connection 服务。',
        'state.error.unknown': '未知错误',

        'error.code.bad-request': 'Host 拒绝了请求参数。',
        'error.code.unknown-endpoint': 'Host 未提供该 RPC endpoint。',
        'error.code.internal': 'Host 在处理请求时失败。',
        'error.code.config-invalid': '配置未通过 Host 校验。',
        'error.code.config-readonly': '当前 profile 没有配置编辑器，请直接修改 profile 配置文件。',
        'error.code.config-write-failed': 'Host 无法持久化配置。',
        'error.code.transport': 'RPC 传输失败，Host 可能正在重启。',
        'error.code.no-connection': 'Client Connection 服务不可用。',
        'error.code.invalid-response': 'Host 返回了无法识别的 RPC 响应。',
        'error.code.unknown': 'Host 报告了未知错误。',

        'config.title': '用量设置',
        'config.subtitle': 'token-attribution 插件的全部配置项',
        'config.close': '关闭设置',
        'config.section.general': '常规',
        'config.section.retention': '保留期与上限',
        'config.section.pricing': '价目表',
        'config.section.webApi': '搜索 / 抓取估算',
        'config.section.advanced': '高级',
        'config.section.status': '配置状态',
        'config.readOnly': '只读配置',
        'config.readOnlyHint': '当前 profile 未提供 configEditor。下方显示当前生效值；如需修改，请编辑 profile 配置文件。',
        'config.loading': '正在加载配置…',
        'config.loadError': '无法加载配置。',
        'config.reload': '重新加载',
        'config.reloadHint': '放弃未保存的修改，重新从 Host 读取配置。',
        'config.save': '保存',
        'config.saving': '正在保存…',
        'config.cancel': '取消',
        'config.saved': '配置已保存。',
        'config.savedRestart': '需要重启插件后生效：{fields}。',
        'config.saveFailed': '配置未保存。',
        'config.restartBadge': '需重启',
        'config.restartTitle': '需要重启',
        'config.restartHint': '修改该字段会重启插件，或需要重启 DSH 后才能生效。',
        'config.diagnostics': 'Host 诊断',
        'config.noDiagnostics': 'Host 未提供诊断。',
        'config.field.dataDir': '数据目录',
        'config.field.dataDirHint': '账本存储的绝对路径；留空使用 profile 默认目录。修改后自动迁移（拷贝→校验→切换指针；失败回退旧目录）。',
        'config.field.dataDirPlaceholder': '留空使用 profile 默认目录',
        'config.field.retainRequestDays': '明细保留期（天）',
        'config.field.retainRequestDaysHint': '保留逐请求明细 1–3650 天。',
        'config.field.retainDailyDays': '日聚合保留期（天）',
        'config.field.retainDailyDaysHint': '保留日聚合 1–3650 天。',
        'config.field.flushIntervalMs': '落盘间隔（毫秒）',
        'config.field.flushIntervalMsHint': '排队记录写入磁盘的间隔（500–60000 毫秒）。',
        'config.field.maxDetailRowsPerDay': '每日明细上限',
        'config.field.maxDetailRowsPerDayHint': 'M1b 预留：仅校验与保存，暂不执行按日明细抽稀。',
        'config.field.enableAutoRefresh': '自动刷新',
        'config.field.enableAutoRefreshHint': '面板打开时周期性刷新看板。',
        'config.field.rememberLastTab': '记住上次标签页',
        'config.field.rememberLastTabHint': '打开面板时回到上次停留的标签页；关闭时总是从概览开始。',
        'config.field.autoRefreshIntervalMs': '自动刷新间隔（毫秒）',
        'config.field.autoRefreshIntervalMsHint': '两次自动刷新之间的毫秒数（1000–3600000）。',
        'config.field.rpcChannel': 'RPC 通道',
        'config.field.rpcChannelHint': 'Connection RPC 路径：以“/”开头的单段标识。修改后需要重启插件。',
        'config.field.toolGroups': '工具分组（JSON）',
        'config.field.toolGroupsHint': '按工具名或前缀数组分组；可自定义分组名（1–32 个小写字母、数字或连字符，不能使用“other”，兼容旧键 agentTeams），按分组顺序匹配，命中第一个即归属该组；每个分组最多 200 个条目，非法条目会报错。',
        'config.field.pricing': '价目条目',
        'config.field.pricingHint': '输入、缓存读、缓存写、输出均为每百万 token 的价格；未命中条目的调用记为未定价。',
        'config.field.pricingOffPeakDays': '全天空闲日期',
        'config.field.pricingOffPeakDaysHint': '北京时间；高峰=工作日 09:00–12:00 / 14:00–18:00，其余为空闲半价；这里可补法定节假日日期（每行 YYYY-MM-DD）',
        'config.defaultValue': '默认值：{value}',
        'config.dataDir.current': '当前目录',
        'config.dataDir.target': '配置目录',
        'config.migration.status': '迁移状态',
        'config.migration.ok': '正常',
        'config.migration.required': '需要迁移',
        'config.migration.adopted': '已接管旧账本',
        'config.migration.migrating': '迁移中',
        'config.migration.failed': '迁移失败',
        'config.migration.unknown': '未知',
        'config.migration.warning': '配置的数据目录与当前生效目录不一致。保存后 Host 会执行“拷贝→校验→切换指针”；失败则继续使用旧目录并输出诊断。',
        'config.migration.failedHint': '上次迁移未完成，账本仍在使用当前目录。请查看 Host 诊断，修正目标目录后重新保存。',
        'config.migration.inProgress': '迁移正在进行。完成前请保持 DSH 打开；当前目录仍可读取。',
        'config.migration.adoptedHint': '已接管旧版默认 profile 的账本；旧目录会保留为备份，并由 Host 的保留策略清理。',
        'config.migration.pendingSave': '保存后插件重载时将把账本迁移到 {path}。',
        'config.migration.note': '切换成功后旧目录会保留为备份，并由 Host 的保留策略清理。',
        'config.migration.readOnly': '账本当前为只读状态，无法启动迁移。',
        'config.pricing.empty': '暂无价目条目；所有调用都会记为未定价。',
        'config.pricing.add': '添加价目条目',
        'config.pricing.remove': '删除价目条目 {index}',
        'config.pricing.rowLabel': '价目条目 {index}',
        'config.pricing.provider': 'Provider',
        'config.pricing.model': '模型（精确、前缀* 或 *）',
        'config.pricing.currency': '币种',
        'config.pricing.inputPerMillion': '输入 / 百万',
        'config.pricing.cacheReadPerMillion': '缓存读 / 百万',
        'config.pricing.cacheWritePerMillion': '缓存写 / 百万',
        'config.pricing.outputPerMillion': '输出 / 百万',
        'config.pricing.offPeakLabel': '空闲价（可选）',
        'config.pricing.offPeakHint': '留空 = 与高峰价相同',
        'config.pricing.offPeakInputPerMillion': '空闲输入 / 百万',
        'config.pricing.offPeakCacheReadPerMillion': '空闲缓存读 / 百万',
        'config.pricing.offPeakCacheWritePerMillion': '空闲缓存写 / 百万',
        'config.pricing.offPeakOutputPerMillion': '空闲输出 / 百万',
        'config.pricing.offPeakDaysPlaceholder': `2026-10-01
2026-12-25`,
        'config.pricing.priceVersion': '价格版本（可选）',
        'config.webApiPricing.hint': '官方默认 5 元 / 1000 次成功请求；金额按观测到的工具调用估算，不代表 provider 账单。',
        'config.webApiPricing.searchPerThousand': '搜索单价 / 千次',
        'config.webApiPricing.fetchPerThousand': '抓取单价 / 千次',
        'config.webApiPricing.currency': '币种',
        'config.webApiPricing.currencyHint': '估算金额旁的币种代码（如 CNY）。',
        'config.advanced.toolGroups': '工具分组 JSON',
        'config.advanced.diagnostics': '诊断',
        'config.unknownField': '未知配置项',
        'config.meta.version': '版本',
        'config.meta.dataRoot': '数据根目录',
        'config.meta.profile': 'Profile',
        'config.meta.pointer': '指针',
        'config.meta.readOnly': '只读',
        'config.meta.since': '数据起点',
        'config.meta.flush': '最后落盘',
        'config.value.default': '默认',
        'config.value.unknown': '未知',
        'config.value.yes': '是',
        'config.value.no': '否',

        'config.error.dataDirAbsolute': '请使用绝对路径（如 D:\\token-data 或 /srv/token-data）。',
        'config.error.required': '该字段必填。',
        'config.error.integer': '请输入整数。',
        'config.error.range': '数值超出允许范围。',
        'config.error.number': '请输入数字。',
        'config.error.nonNegative': '请输入大于等于 0 的数字。',
        'config.error.rpcChannel': '请使用以“/”开头的单段路径（不能是“/api”）。',
        'config.error.json-empty': '请输入 JSON 对象。',
        'config.error.json-invalid': 'JSON 格式不合法。',
        'config.error.json-not-object': 'JSON 值必须是对象。',
        'config.error.toolGroups-shape': '工具分组必须是“字符串数组”的对象。',
        'config.error.toolGroups-list': '每个分组必须是至多 200 个非空字符串的数组。',
        'config.error.toolGroups-key': '分组名需为 1–32 个小写字母、数字或连字符；“other”为保留名（另兼容 agentTeams）。',
        'config.error.price-provider': '每个价目条目必须填写 provider。',
        'config.error.price-currency': '每个价目条目必须填写币种。',
        'config.error.price-number': '价格必须为大于等于 0 的数字。',
        'config.error.webApi-number': '搜索 / 抓取单价必须为每千次大于等于 0 的数字。',
        'config.error.webApi-currency': '搜索 / 抓取估算需要填写币种。',
        'config.error.price-date': '日期格式应为 YYYY-MM-DD（且为有效日期）。',
        'config.error.pricing-row': '该价目条目不是对象。',
        'config.error.generic': '该值不合法。',
        'config.error.saveDiagnostics': 'Host 拒绝了该配置，请查看下方诊断。',

        'button.close': '关闭',
        'button.retry': '重试',
        'button.refresh': '刷新',
        'button.save': '保存',
        'button.cancel': '取消',
        'button.reload': '重新加载',
        'button.add': '添加',
        'button.remove': '删除',

        'aria.settings': '切换到用量设置',
        'aria.close': '关闭用量设置',
        'aria.refresh': '刷新用量数据',
        'aria.range': '时间范围',
        'aria.tabs': '用量视图',
        'aria.tabPanel': '{label}视图',
        'aria.panel': 'Token 用量看板',
        'aria.chart': '{title}图表',
        'aria.loading': '正在加载用量数据',
        'aria.error': '用量数据错误',
        'aria.readOnly': '只读配置',
      },
    }

    // The Host normalizer uses this key for prompt content it could not classify.
    // Declared after LOCALE so the literal above can reference it safely at call
    // time (the function is only invoked while rendering).
    const FALLBACK_CATEGORY = 'fallback'

    // ---------------------------------------------------------------------
    // Styles
    // ---------------------------------------------------------------------

    const COLORS = Object.freeze({
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      surface: 'var(--dsw-alias-bg-layer-1)',
      surfaceAlt: 'var(--dsw-alias-bg-layer-2)',
      base: 'var(--dsw-alias-bg-base)',
      overlay: 'var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-base))',
      brand: 'var(--dsw-alias-brand-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warning: 'var(--dsw-alias-state-warn-primary)',
      danger: 'var(--dsw-alias-state-error-primary)',
    })

    const FONT_STACK = 'var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif)'
    const MONO_STACK = 'var(--dsw-font-family-code, ui-monospace, SFMono-Regular, Consolas, monospace)'

    /**
     * Base surface style.
     * @param {object} [extra] - overrides.
     * @returns {object} style.
     */
    function surfaceStyle(extra) {
      return {
        background: COLORS.surface,
        border: `0.5px solid ${COLORS.border}`,
        borderRadius: 'var(--dsw-radius-md, 10px)',
        boxSizing: 'border-box',
        minWidth: 0,
        ...extra,
      }
    }

    /**
     * Button style by kind.
     * @param {'default'|'primary'|'ghost'|'danger'} [kind] - kind.
     * @returns {object} style.
     */
    function buttonStyle(kind = 'default') {
      const base = {
        font: 'inherit',
        fontSize: 12,
        lineHeight: '18px',
        color: COLORS.text,
        background: COLORS.surface,
        border: `0.5px solid ${COLORS.border}`,
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        padding: '5px 10px',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        whiteSpace: 'nowrap',
      }
      if (kind === 'primary') {
        return {
          ...base,
          background: `color-mix(in srgb, ${COLORS.brand} 16%, ${COLORS.surface})`,
          borderColor: `color-mix(in srgb, ${COLORS.brand} 45%, ${COLORS.border})`,
          color: COLORS.text,
          fontWeight: 500,
        }
      }
      if (kind === 'ghost') {
        return { ...base, background: 'none', borderColor: 'transparent', color: COLORS.muted }
      }
      if (kind === 'danger') {
        return { ...base, color: COLORS.danger, borderColor: `color-mix(in srgb, ${COLORS.danger} 40%, ${COLORS.border})` }
      }
      return base
    }

    const INPUT_STYLE = Object.freeze({
      font: 'inherit',
      fontSize: 12,
      lineHeight: '18px',
      color: COLORS.text,
      background: COLORS.base,
      border: `0.5px solid ${COLORS.border}`,
      borderRadius: 'var(--dsw-radius-sm, 6px)',
      padding: '5px 8px',
      width: '100%',
      boxSizing: 'border-box',
      minWidth: 0,
    })

    const HINT_STYLE = Object.freeze({
      margin: '4px 0 0',
      color: COLORS.muted,
      fontSize: 12,
      lineHeight: '18px',
    })

    const ERROR_TEXT_STYLE = Object.freeze({
      margin: '6px 0 0',
      color: COLORS.danger,
      fontSize: 12,
      lineHeight: '18px',
    })

    /**
     * Icon artwork (bar chart + token/coin) using `currentColor` only.
     * @param {{size?: number, active?: boolean}} props - owner props.
     * @returns {object} React element.
     */
    function UsageIcon(props) {
      const size = Number.isFinite(props?.size) && props.size > 0 ? props.size : 20
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
        'data-token-attribution-icon': props?.active === true ? 'active' : 'inactive',
        style: { display: 'block', flex: 'none' },
      }, [
        h('rect', { key: 'bar-1', x: 3, y: 14, width: 3, height: 6, rx: 1, fill: 'currentColor', opacity: 0.55 }),
        h('rect', { key: 'bar-2', x: 8, y: 10, width: 3, height: 10, rx: 1, fill: 'currentColor', opacity: 0.75 }),
        h('rect', { key: 'bar-3', x: 13, y: 6, width: 3, height: 14, rx: 1, fill: 'currentColor' }),
        h('circle', { key: 'coin', cx: 19, cy: 6.5, r: 3.2, stroke: 'currentColor', strokeWidth: 1.2, fill: 'none' }),
        h('path', { key: 'coin-mark', d: 'M17.4 6.5h3.2M19 5v3', stroke: 'currentColor', strokeWidth: 1.1, strokeLinecap: 'round' }),
      ])
    }

    /**
     * Gear artwork for the settings button.
     * @param {{size?: number}} props - size.
     * @returns {object} React element.
     */
    function GearIcon(props) {
      const size = Number.isFinite(props?.size) && props.size > 0 ? props.size : 16
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block', flex: 'none' },
      }, [
        h('circle', { key: 'center', cx: 12, cy: 12, r: 3.2, stroke: 'currentColor', strokeWidth: 1.5 }),
        h('path', {
          key: 'teeth',
          d: 'M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        }),
      ])
    }

    /**
     * Refresh artwork.
     * @param {{size?: number}} props - size.
     * @returns {object} React element.
     */
    function RefreshIcon(props) {
      const size = Number.isFinite(props?.size) && props.size > 0 ? props.size : 16
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block', flex: 'none' },
      }, [
        h('path', {
          key: 'arc',
          d: 'M19 8a8 8 0 1 0 1 7',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
        h('path', {
          key: 'arrow',
          d: 'M19 3.5V8h-4.5',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      ])
    }

    /**
     * Section heading with optional hint.
     * @param {object} props - `{title, hint, action}`.
     * @returns {object} React element.
     */
    function SectionHeading(props) {
      return h('div', {
        style: {
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 12,
          minWidth: 0,
        },
      }, [
        h('div', { key: 'copy', style: { minWidth: 0 } }, [
          h('h2', {
            key: 'title',
            style: { margin: 0, fontSize: 14, lineHeight: '20px', fontWeight: 500, color: COLORS.text },
          }, props.title),
          props.hint
            ? h('p', { key: 'hint', style: { ...HINT_STYLE, margin: '2px 0 0' } }, props.hint)
            : null,
        ]),
        props.action ? h('div', { key: 'action', style: { flex: 'none' } }, props.action) : null,
      ])
    }

    /**
     * One overview card.
     * @param {object} props - `{label, value, valueTitle, hint, lines, tone}`.
     * @returns {object} React element.
     */
    function MetricCard(props) {
      const toneColor = props.tone === 'accent'
        ? COLORS.brand
        : props.tone === 'warning'
          ? COLORS.warning
          : COLORS.text
      const lines = Array.isArray(props.lines) ? props.lines : []
      return h('div', {
        style: surfaceStyle({ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 4 }),
      }, [
        h('div', {
          key: 'label',
          style: { fontSize: 12, lineHeight: '18px', color: COLORS.muted },
        }, props.label),
        h('div', {
          key: 'value',
          title: props.valueTitle,
          style: {
            fontSize: 20,
            lineHeight: '28px',
            fontWeight: 600,
            color: toneColor,
            fontVariantNumeric: 'tabular-nums',
            wordBreak: 'break-word',
          },
        }, props.value),
        props.hint
          ? h('div', { key: 'hint', style: { fontSize: 11, lineHeight: '16px', color: COLORS.muted } }, props.hint)
          : null,
        ...lines.map((line, index) => h('div', {
          key: `line-${index}`,
          style: { fontSize: 11, lineHeight: '16px', color: COLORS.muted },
        }, line)),
      ])
    }

    /**
     * Stacked horizontal bar with a legend.
     * @param {object} props - `{title, hint, entries, extra, t}`.
     * @returns {object} React element.
     */
    function StackedBar(props) {
      const t = props.t
      let segments = []
      try {
        segments = buildStackedSegments(Array.isArray(props.entries) ? props.entries : [])
      } catch {
        segments = []
      }
      const total = segments.reduce((sum, segment) => sum + segment.value, 0)
      return h('section', {
        style: surfaceStyle({ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }),
      }, [
        h(SectionHeading, { key: 'head', title: props.title, hint: props.hint }),
        segments.length === 0
          ? h('p', { key: 'empty', style: { ...HINT_STYLE, margin: 0 } }, t('chart.empty'))
          : h('div', {
            key: 'bar',
            role: 'img',
            'aria-label': t('chart.barAria', { title: props.title }),
            style: {
              display: 'flex',
              width: '100%',
              height: 14,
              borderRadius: 999,
              overflow: 'hidden',
              background: COLORS.surfaceAlt,
              border: `0.5px solid ${COLORS.border}`,
            },
          }, segments.map((segment, index) => h('div', {
            key: segment.key ?? `segment-${index}`,
            title: `${segment.label ?? segment.key}: ${formatCompactTokens(segment.value)} (${formatPercent(total > 0 ? segment.value / total : 0)})`,
            style: {
              width: `${segment.widthPercent}%`,
              background: seriesColor(index),
              flex: '0 0 auto',
            },
          }))),
        segments.length === 0
          ? null
          : h('div', {
            key: 'legend',
            role: 'list',
            'aria-label': t('chart.legendAria', { title: props.title }),
            style: { display: 'flex', flexWrap: 'wrap', gap: '6px 14px', minWidth: 0 },
          }, segments.map((segment, index) => h('div', {
            key: segment.key ?? `legend-${index}`,
            role: 'listitem',
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              minWidth: 0,
              fontSize: 12,
              lineHeight: '18px',
              color: COLORS.muted,
            },
          }, [
            h('span', {
              key: 'dot',
              'aria-hidden': 'true',
              style: {
                width: 8,
                height: 8,
                borderRadius: 999,
                flex: 'none',
                background: seriesColor(index),
              },
            }),
            h('span', {
              key: 'label',
              style: { color: COLORS.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            }, segment.label ?? segment.key),
            h('span', {
              key: 'value',
              style: { fontVariantNumeric: 'tabular-nums', flex: 'none' },
            }, t('chart.value', {
              tokens: formatCompactTokens(segment.value),
              percent: formatPercent(total > 0 ? segment.value / total : 0),
            })),
          ]))),
        segments.length > 0
          ? h('p', { key: 'total', style: { ...HINT_STYLE, margin: 0 } }, t('chart.total', { tokens: formatCompactTokens(total) }))
          : null,
        props.extra ?? null,
      ])
    }

    /**
     * Expanded content-source table: every `byCategory` entry with its token
     * count and share of the measured prompt. No fetch is involved; the rows
     * come from the summary the panel already holds.
     * @param {object} props - `{byCategory, totalPromptTokens, t}`.
     * @returns {object} React element.
     */
    function CategoryDetailTable(props) {
      const t = props.t
      const rows = categoryTableRows(props.byCategory, props.totalPromptTokens, t)
      if (rows.length === 0) {
        return h('p', { key: 'empty', style: { ...HINT_STYLE, margin: 0 } }, t('chart.category.detailEmpty'))
      }
      const padding = '4px 6px'
      const headStyle = {
        padding,
        color: COLORS.muted,
        fontWeight: 500,
        borderBottom: `0.5px solid ${COLORS.borderStrong}`,
        whiteSpace: 'nowrap',
      }
      const cellStyle = {
        padding,
        color: COLORS.text,
        borderBottom: `0.5px solid ${COLORS.border}`,
        whiteSpace: 'nowrap',
      }
      return h('div', {
        key: 'category-detail',
        style: { width: '100%', overflowX: 'auto', minWidth: 0 },
      }, h('table', {
        style: { width: '100%', borderCollapse: 'collapse', fontSize: 11, lineHeight: '18px' },
      }, [
        h('thead', { key: 'thead' }, h('tr', null, [
          h('th', { key: 'category', scope: 'col', style: { ...headStyle, textAlign: 'left' } }, t('chart.category.detailCategory')),
          h('th', { key: 'tokens', scope: 'col', style: { ...headStyle, textAlign: 'right' } }, t('chart.category.detailTokens')),
          h('th', { key: 'share', scope: 'col', style: { ...headStyle, textAlign: 'right' } }, t('chart.category.detailShare')),
        ])),
        h('tbody', { key: 'tbody' }, rows.map(row => h('tr', { key: row.key }, [
          h('td', { key: 'category', style: { ...cellStyle, textAlign: 'left' } }, row.label),
          h('td', {
            key: 'tokens',
            style: { ...cellStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
          }, tokenCell(row.tokens)),
          h('td', {
            key: 'share',
            style: { ...cellStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
          }, formatPercent(row.share)),
        ]))),
      ]))
    }

    const TREND_VIEW_WIDTH = 600
    const TREND_VIEW_HEIGHT = 96

    /**
     * Stacked per-day trend chart (prompt at the baseline, output above it).
     *
     * Rendered as inline SVG with a fixed viewBox and `preserveAspectRatio:
     * "none"`, so the bars fill any narrow panel width without a chart library;
     * date labels and the legend stay as regular HTML.
     * @param {object} props - `{byDay, t}`.
     * @returns {object} React element.
     */
    function TrendChart(props) {
      const t = props.t
      const layout = buildTrendPoints(props.byDay, TREND_VIEW_WIDTH, TREND_VIEW_HEIGHT)
      const points = layout.points
      const total = layout.totals.tokens
      const ticks = []
      if (points.length > 0) {
        const last = points.length - 1
        const candidates = points.length <= 5
          ? points.map((_point, index) => index)
          : [0, Math.round(last / 4), Math.round(last / 2), Math.round((last * 3) / 4), last]
        for (const index of candidates) {
          if (!ticks.includes(index)) ticks.push(index)
        }
      }
      const legend = [
        { key: 'prompt', label: t('trend.prompt'), value: layout.totals.promptTokens },
        { key: 'output', label: t('trend.output'), value: layout.totals.outputTokens },
      ]
      return h('section', {
        style: surfaceStyle({ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }),
      }, [
        h(SectionHeading, { key: 'head', title: t('trend.title'), hint: t('trend.hint') }),
        points.length === 0
          ? h('p', { key: 'empty', style: { ...HINT_STYLE, margin: 0 } }, t('trend.empty'))
          : h('div', {
            key: 'chart',
            style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
          }, [
            h('svg', {
              key: 'svg',
              viewBox: `0 0 ${TREND_VIEW_WIDTH} ${TREND_VIEW_HEIGHT}`,
              preserveAspectRatio: 'none',
              width: '100%',
              height: TREND_VIEW_HEIGHT,
              role: 'img',
              'aria-label': t('aria.chart', { title: t('trend.title') }),
              'data-dsh-part': 'trend-chart',
              style: { display: 'block', width: '100%', height: TREND_VIEW_HEIGHT, minWidth: 0 },
            }, points.map(point => h('g', { key: `day-${point.key}` }, [
              h('title', { key: 'title' }, t('trend.barTitle', {
                day: point.label || point.day,
                prompt: formatCompactTokens(point.promptTokens),
                output: formatCompactTokens(point.outputTokens),
              })),
              point.promptHeight > 0
                ? h('rect', {
                  key: 'prompt',
                  x: point.x,
                  y: point.promptY,
                  width: point.barWidth,
                  height: point.promptHeight,
                  fill: seriesColor(0),
                })
                : null,
              point.outputHeight > 0
                ? h('rect', {
                  key: 'output',
                  x: point.x,
                  y: point.outputY,
                  width: point.barWidth,
                  height: point.outputHeight,
                  fill: seriesColor(1),
                })
                : null,
            ]))),
            h('div', {
              key: 'labels',
              style: {
                position: 'relative',
                height: 14,
                fontSize: 10,
                lineHeight: '14px',
                color: COLORS.muted,
                fontVariantNumeric: 'tabular-nums',
                minWidth: 0,
              },
            }, ticks.map(index => {
              const ratio = (index + 0.5) / points.length
              return h('span', {
                key: `tick-${index}`,
                style: {
                  position: 'absolute',
                  left: `${ratio * 100}%`,
                  transform: ratio < 0.06
                    ? 'none'
                    : ratio > 0.94 ? 'translateX(-100%)' : 'translateX(-50%)',
                  whiteSpace: 'nowrap',
                },
              }, points[index].label || points[index].day)
            })),
          ]),
        points.length === 0
          ? null
          : h('div', {
            key: 'legend',
            role: 'list',
            'aria-label': t('chart.legendAria', { title: t('trend.title') }),
            style: { display: 'flex', flexWrap: 'wrap', gap: '6px 14px', minWidth: 0 },
          }, legend.map((item, index) => h('div', {
            key: item.key,
            role: 'listitem',
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              minWidth: 0,
              fontSize: 12,
              lineHeight: '18px',
              color: COLORS.muted,
            },
          }, [
            h('span', {
              key: 'dot',
              'aria-hidden': 'true',
              style: {
                width: 8,
                height: 8,
                borderRadius: 999,
                flex: 'none',
                background: seriesColor(index),
              },
            }),
            h('span', {
              key: 'label',
              style: { color: COLORS.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            }, item.label),
            h('span', {
              key: 'value',
              style: { fontVariantNumeric: 'tabular-nums', flex: 'none' },
            }, t('chart.value', {
              tokens: formatCompactTokens(item.value),
              percent: formatPercent(total > 0 ? item.value / total : 0),
            })),
          ]))),
      ])
    }

    /**
     * A simple data table.
     *
     * `body` replaces the default table/empty block (used by the collapsed
     * recent-request pane); `action` renders in the section heading; `compact`
     * shrinks cells for the drill-down; `footer` adds a muted explanatory line
     * below the table (used by the M2.7 reconciliation hint).
     * @param {object} props - `{title, hint, action, columns, rows, emptyText, body, footer, compact}`.
     * @returns {object} React element.
     */
    function DataTable(props) {
      const columns = Array.isArray(props.columns) ? props.columns : []
      const rows = Array.isArray(props.rows) ? props.rows : []
      const compact = props.compact === true
      const cellPadding = compact ? '4px 6px' : '6px 8px'
      const headerFontSize = compact ? 11 : 12
      let body
      if (props.body !== undefined) {
        body = props.body
      } else if (rows.length === 0) {
        body = h('p', { key: 'empty', style: { ...HINT_STYLE, margin: 0 } }, props.emptyText)
      } else {
        body = h('div', {
          key: 'scroll',
          style: { width: '100%', overflowX: 'auto', minWidth: 0 },
        }, h('table', {
          style: { width: '100%', borderCollapse: 'collapse', fontSize: headerFontSize, lineHeight: '18px' },
        }, [
          h('thead', { key: 'thead' }, h('tr', null, columns.map(column => h('th', {
            key: column.key,
            scope: 'col',
            style: {
              textAlign: column.align === 'right' ? 'right' : 'left',
              padding: cellPadding,
              color: COLORS.muted,
              fontWeight: 500,
              borderBottom: `0.5px solid ${COLORS.borderStrong}`,
              whiteSpace: 'nowrap',
            },
          }, column.label)))),
          h('tbody', { key: 'tbody' }, rows.map((row, rowIndex) => h('tr', { key: row.key ?? rowIndex }, columns.map(column => h('td', {
            key: column.key,
            style: {
              textAlign: column.align === 'right' ? 'right' : 'left',
              padding: cellPadding,
              borderBottom: `0.5px solid ${COLORS.border}`,
              color: COLORS.text,
              fontVariantNumeric: column.align === 'right' ? 'tabular-nums' : undefined,
              verticalAlign: 'top',
              maxWidth: column.maxWidth,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: column.nowrap === false ? 'normal' : 'nowrap',
            },
          }, typeof column.render === 'function' ? column.render(row, rowIndex) : row[column.key]))))),
        ]))
      }
      return h('section', {
        style: surfaceStyle({ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }),
      }, [
        h(SectionHeading, { key: 'head', title: props.title, hint: props.hint, action: props.action }),
        body,
        props.footer
          ? h('p', { key: 'footer', style: { ...HINT_STYLE, margin: 0 } }, props.footer)
          : null,
      ])
    }

    /**
     * Expandable session tree table.
     *
     * Every visible row shows the aggregate of the session **and all of its
     * descendants** (tokens, requests, cost, cache rate). Roots are visible by
     * default; a chevron plus the direct-child count expands one level, and
     * nested expansion works recursively. Orphans and cycles are treated as
     * roots by `buildSessionTree`, so no row is ever dropped.
     * @param {object} props - `{bySession, currency, expanded, onToggle, t, sessionTitles}`.
     * @returns {object} React element.
     */
    function SessionTreeTable(props) {
      const t = props.t
      const tree = buildSessionTree(props.bySession)
      const sessionTitles = isPlainObject(props.sessionTitles) ? props.sessionTitles : null
      const expanded = isPlainObject(props.expanded) ? props.expanded : {}
      const limit = Number.isInteger(props.limit) && props.limit > 0 ? props.limit : 0
      const allRows = sessionTreeRows(tree, expanded)
      const rows = limit > 0 ? allRows.slice(0, limit) : allRows
      const compactTop = limit > 0
      const toggle = typeof props.onToggle === 'function' ? props.onToggle : () => {}
      // M3: only the Sessions tab wires `onOpen`; Overview's Top-N table stays
      // read-only, and without the prop the title cell keeps its pre-M3 markup.
      const openSession = typeof props.onOpen === 'function' ? props.onOpen : null
      const costLabels = { mixed: t('table.costMixed'), unpriced: t('card.valueUnavailable') }
      const padding = '6px 8px'
      const headStyle = {
        padding,
        color: COLORS.muted,
        fontWeight: 500,
        borderBottom: `0.5px solid ${COLORS.borderStrong}`,
        whiteSpace: 'nowrap',
      }
      const cellStyle = {
        padding,
        color: COLORS.text,
        borderBottom: `0.5px solid ${COLORS.border}`,
        whiteSpace: 'nowrap',
      }
      const rightCell = { ...cellStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
      const badgeStyle = {
        fontSize: 10,
        lineHeight: '14px',
        color: COLORS.muted,
        border: `0.5px solid ${COLORS.border}`,
        borderRadius: 999,
        padding: '0 5px',
        whiteSpace: 'nowrap',
        flex: 'none',
      }
      const toggleStyle = {
        font: 'inherit',
        fontSize: 10,
        lineHeight: '14px',
        color: COLORS.muted,
        background: 'none',
        border: 'none',
        padding: '0 1px',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        flex: 'none',
      }
      const openButtonStyle = {
        font: 'inherit',
        fontSize: 12,
        lineHeight: '18px',
        color: COLORS.text,
        background: 'none',
        border: 'none',
        padding: 0,
        margin: 0,
        cursor: 'pointer',
        textAlign: 'left',
        display: 'inline-flex',
        alignItems: 'center',
        minWidth: 0,
        maxWidth: 320,
        overflow: 'hidden',
      }
      const titleStyle = {
        fontSize: 12,
        color: COLORS.text,
        minWidth: 0,
        maxWidth: 320,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }
      let body
      if (rows.length === 0) {
        body = h('p', { key: 'empty', style: { ...HINT_STYLE, margin: 0 } }, t('table.sessions.empty'))
      } else {
        body = h('div', {
          key: 'scroll',
          style: { width: '100%', overflowX: 'auto', minWidth: 0 },
        }, h('table', {
          'data-dsh-part': 'session-tree',
          style: { width: '100%', borderCollapse: 'collapse', fontSize: 12, lineHeight: '18px' },
        }, [
          h('thead', { key: 'thead' }, h('tr', null, [
            h('th', { key: 'session', scope: 'col', style: { ...headStyle, textAlign: 'left' } }, t('table.sessions.session')),
            h('th', { key: 'requests', scope: 'col', style: { ...headStyle, textAlign: 'right' } }, t('table.sessions.requests')),
            h('th', { key: 'promptTokens', scope: 'col', style: { ...headStyle, textAlign: 'right' } }, t('table.sessions.promptTokens')),
            h('th', { key: 'outputTokens', scope: 'col', style: { ...headStyle, textAlign: 'right' } }, t('table.sessions.outputTokens')),
            h('th', { key: 'cacheRate', scope: 'col', style: { ...headStyle, textAlign: 'right' } }, t('table.sessions.cacheRate')),
            h('th', { key: 'cost', scope: 'col', style: { ...headStyle, textAlign: 'right' } }, t('table.cost')),
          ])),
          h('tbody', { key: 'tbody' }, rows.map(node => {
            const stats = node.subtree ?? subtreeStats(node)
            const hasChildren = node.children.length > 0
            const open = expanded[node.key] === true
            const toggleLabel = open ? t('table.sessions.collapse') : t('table.sessions.expand')
            const shortSessionId = node.sessionId.length > 0 ? shortId(node.sessionId, 12) : ''
            const resolvedTitle = sessionDisplayName(node.sessionId, sessionTitles, '')
            // `displayTitle` falls back to the raw session id when no durable
            // title exists, so an id-equal value still means "no title": keep
            // the previous compact short-id cell and its full-id tooltip.
            const hasTitle = resolvedTitle !== '' && resolvedTitle !== node.sessionId
            const sessionLabel = hasTitle
              ? resolvedTitle
              : shortSessionId !== '' ? shortSessionId : t('table.sessions.unknown')
            const sessionTooltip = hasTitle ? `${node.sessionId} · ${resolvedTitle}` : node.sessionId
            const sessionCell = h('div', {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                minWidth: 0,
                paddingLeft: Math.max(0, node.level) * 14,
              },
            }, [
              hasChildren && !compactTop
                ? h('button', {
                  key: 'toggle',
                  type: 'button',
                  'aria-expanded': open,
                  'aria-label': toggleLabel,
                  title: t('table.sessions.children', { count: node.children.length }),
                  'data-dsh-part': 'session-toggle',
                  'data-session-key': node.key,
                  onClick: () => toggle(node.key),
                  style: toggleStyle,
                }, [
                  h('span', { key: 'chevron', 'aria-hidden': 'true' }, open ? '▾' : '▸'),
                  h('span', { key: 'count', style: { fontVariantNumeric: 'tabular-nums' } }, String(node.children.length)),
                ])
                : h('span', { key: 'spacer', 'aria-hidden': 'true', style: { display: 'inline-block', width: 18, flex: 'none' } }),
              openSession !== null && node.sessionId !== ''
                ? h('button', {
                  key: 'open',
                  type: 'button',
                  'data-dsh-part': 'session-open',
                  'data-session-id': node.sessionId,
                  'data-session-key': node.key,
                  'aria-label': t('table.sessions.open', { name: sessionLabel }),
                  title: sessionTooltip,
                  onClick: () => openSession(node.sessionId),
                  style: openButtonStyle,
                }, hasTitle
                  ? h('span', {
                    key: 'title',
                    title: sessionTooltip,
                    'data-dsh-part': 'session-title',
                    style: titleStyle,
                  }, sessionLabel)
                  : h('code', {
                    key: 'id',
                    title: sessionTooltip,
                    style: { fontFamily: MONO_STACK, fontSize: 11, color: COLORS.text },
                  }, sessionLabel))
                : hasTitle
                  ? h('span', {
                    key: 'title',
                    title: sessionTooltip,
                    'data-dsh-part': 'session-title',
                    style: titleStyle,
                  }, sessionLabel)
                  : h('code', {
                    key: 'id',
                    title: sessionTooltip,
                    style: { fontFamily: MONO_STACK, fontSize: 11, color: COLORS.text },
                  }, sessionLabel),
              node.depth > 0 ? h('span', { key: 'depth', style: badgeStyle }, t('table.sessions.subagent')) : null,
            ])
            return h('tr', { key: node.key, 'data-session-row': node.key }, [
              h('td', { key: 'session', style: { ...cellStyle, textAlign: 'left' } }, sessionCell),
              h('td', { key: 'requests', style: { ...rightCell } }, formatTokens(stats.requests)),
              h('td', { key: 'promptTokens', style: { ...rightCell } }, stats.splitAvailable
                ? tokenCell(stats.promptTokens)
                : t('card.valueUnavailable')),
              h('td', { key: 'outputTokens', style: { ...rightCell } }, stats.splitAvailable
                ? tokenCell(stats.outputTokens)
                : t('card.valueUnavailable')),
              h('td', { key: 'cacheRate', style: { ...rightCell } }, stats.cacheRate === null
                ? t('card.valueUnavailable')
                : formatPercent(stats.cacheRate)),
              h('td', { key: 'cost', style: { ...rightCell } }, formatCostCell(stats.cost, props.currency, costLabels)),
            ])
          })),
        ]))
      }
      return h(DataTable, {
        title: typeof props.title === 'string' && props.title.length > 0 ? props.title : t('table.sessions.title'),
        hint: compactTop
          ? t('table.sessions.topHint', { count: limit })
          : `${t('table.sessions.hint')} · ${t('table.sessions.rootsOnlyHint')}`,
        columns: [],
        rows: [],
        emptyText: t('table.sessions.empty'),
        body,
      })
    }

    /**
     * Per-session Web API attribution table (M2.5; reconciled in M2.7).
     *
     * Rows are the Host-observed `web_search` / `web_fetch` totals per agent
     * session, already sorted by total calls and capped by the normalizer.
     * Only sessions with at least one call are rendered (a row of zeroes means
     * "no Web API use here", so the whole section stays hidden); the heading
     * action expands the initial 10-row fold up to the Host's 100-row cap.
     *
     * M2.7 appends one synthetic, muted, non-clickable "unattributed" row
     * holding `summary.webApi.unattributed`: the calls persisted before M2.5
     * kept a daily total only, so they reconcile the card total with the
     * per-session rows. It is a layout-only row — never merged into a session
     * row and never given a fabricated session id. The compact form (Overview
     * Top-N) keeps the session rows untouched and reports the same count as a
     * hint suffix instead of a row.
     *
     * Titles resolve at render time through the same `useSessions`-derived map
     * as the session tree and are never stored.
     * @param {object} props - `{rows, currency, sessionTitles, open, onToggle, t, limit, title, hint, unattributed, unattributedCompact}`.
     * @returns {object|null} React element, or null when there is nothing to show.
     */
    function WebApiSessionTable(props) {
      const t = props.t
      const sessionTitles = isPlainObject(props.sessionTitles) ? props.sessionTitles : null
      const rows = (Array.isArray(props.rows) ? props.rows : []).filter(row => isPlainObject(row)
        && typeof row.sessionId === 'string'
        && row.sessionId.length > 0
        && isPlainObject(row.search)
        && isPlainObject(row.fetch)
        && isPlainObject(row.calls)
        && row.calls.total > 0)
      const unattributed = normalizeWebApiUnattributed(props.unattributed)
      const hasUnattributed = unattributed.calls.total > 0
      const compactUnattributed = props.unattributedCompact === true
      const showUnattributedRow = hasUnattributed && !compactUnattributed
      if (rows.length === 0 && !showUnattributedRow) return null
      const open = props.open === true
      const limit = Number.isInteger(props.limit) && props.limit > 0 ? props.limit : 0
      const capped = limit > 0 ? rows.slice(0, limit) : rows
      const foldable = limit === 0 && rows.length > WEB_API_SESSION_FOLD
      const visible = foldable && !open ? capped.slice(0, WEB_API_SESSION_FOLD) : capped
      const costLabels = { mixed: t('table.costMixed'), unpriced: t('card.valueUnavailable') }
      const mutedCell = (row, text) => (row.unattributed === true
        ? h('span', { style: { color: COLORS.muted } }, text)
        : text)
      const titleStyle = {
        fontSize: 12,
        color: COLORS.text,
        minWidth: 0,
        maxWidth: 320,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }
      const idStyle = { fontFamily: MONO_STACK, fontSize: 11, color: COLORS.text }
      const columns = [
        {
          key: 'session',
          label: t('table.sessions.session'),
          maxWidth: 340,
          render: row => {
            if (row.unattributed === true) {
              // A plain span with no handler and no session id: this row is a
              // reconciliation line, not a session.
              return h('span', {
                'data-dsh-part': 'webapi-unattributed',
                style: { ...titleStyle, color: COLORS.muted, fontStyle: 'italic' },
              }, t('table.webApiSessions.unattributed'))
            }
            if (row.sessionId === 'unknown') {
              return h('span', {
                'data-dsh-part': 'webapi-session',
                'data-session-id': row.sessionId,
                style: titleStyle,
              }, t('table.sessions.unknown'))
            }
            const resolved = sessionDisplayName(row.sessionId, sessionTitles, '')
            // `displayTitle` may fall back to the raw session id; treat that
            // as "no title" and keep the compact short-id cell, exactly like
            // the session tree.
            if (resolved !== '' && resolved !== row.sessionId) {
              return h('span', {
                title: `${row.sessionId} · ${resolved}`,
                'data-dsh-part': 'webapi-session',
                'data-session-id': row.sessionId,
                style: titleStyle,
              }, resolved)
            }
            return h('code', {
              title: row.sessionId,
              'data-dsh-part': 'webapi-session',
              'data-session-id': row.sessionId,
              style: idStyle,
            }, shortId(row.sessionId, 12))
          },
        },
        {
          key: 'search',
          label: t('table.webApiSessions.search'),
          align: 'right',
          render: row => mutedCell(row, formatTokens(row.search.total)),
        },
        {
          key: 'fetch',
          label: t('table.webApiSessions.fetch'),
          align: 'right',
          render: row => mutedCell(row, formatTokens(row.fetch.total)),
        },
        {
          key: 'cost',
          label: t('table.cost'),
          align: 'right',
          render: row => mutedCell(row, formatCostCell(row.cost, props.currency, costLabels)),
        },
      ]
      const baseHint = typeof props.hint === 'string' && props.hint.length > 0
        ? props.hint
        : t('table.webApiSessions.hint')
      const hint = hasUnattributed && compactUnattributed
        ? `${baseHint} · ${t('table.webApiSessions.topUnattributed', { count: formatTokens(unattributed.calls.total) })}`
        : baseHint
      const dataRows = showUnattributedRow
        ? visible.concat([{
          key: WEB_API_UNATTRIBUTED_ROW,
          unattributed: true,
          search: unattributed.search,
          fetch: unattributed.fetch,
          calls: unattributed.calls,
          cost: unattributed.cost,
        }])
        : visible
      return h(DataTable, {
        title: typeof props.title === 'string' && props.title.length > 0 ? props.title : t('table.webApiSessions.title'),
        hint,
        footer: showUnattributedRow ? t('table.webApiSessions.unattributedHint') : undefined,
        action: foldable
          ? h('button', {
            key: 'toggle',
            type: 'button',
            'aria-expanded': open,
            'data-dsh-part': 'webapi-sessions-toggle',
            onClick: typeof props.onToggle === 'function' ? props.onToggle : () => {},
            style: buttonStyle(),
          }, open
            ? t('table.webApiSessions.collapse')
            : t('table.webApiSessions.expand', { count: formatTokens(rows.length) }))
          : null,
        columns,
        rows: dataRows,
      })
    }

    /**
     * Render one Details-tab session cell: resolved title (with the full id in
     * the tooltip), or the compact id / unknown fallback when no title exists.
     * @param {object} row - normalized request row.
     * @param {object|null} sessionTitles - render-time title map.
     * @param {(key: string, params?: object) => string} t - translator.
     * @returns {object} React element.
     */
    function requestSessionCell(row, sessionTitles, t) {
      const sessionId = typeof row?.sessionId === 'string' ? row.sessionId : ''
      const titleStyle = {
        fontSize: 12,
        color: COLORS.text,
        maxWidth: 240,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }
      if (sessionId === '' || sessionId === 'unknown') {
        return h('span', {
          'data-dsh-part': 'request-session',
          'data-session-id': sessionId,
          style: titleStyle,
        }, t('table.sessions.unknown'))
      }
      const title = sessionDisplayName(sessionId, sessionTitles, '')
      if (title !== '' && title !== sessionId) {
        return h('span', {
          title: sessionId,
          'data-dsh-part': 'request-session',
          'data-session-id': sessionId,
          style: titleStyle,
        }, title)
      }
      return h('code', {
        title: sessionId,
        'data-dsh-part': 'request-session',
        'data-session-id': sessionId,
        style: { fontFamily: MONO_STACK, fontSize: 11, color: COLORS.text },
      }, shortId(sessionId, 12))
    }

    /**
     * One page of request rows (shared by the Details tab and the M3 session
     * drill-down). Pure render; the caller owns fetching and paging state.
     * @param {object} props - `{items, sessionTitles, t, part}`.
     * @returns {object} React element.
     */
    function RequestRows(props) {
      const t = props.t
      const items = Array.isArray(props.items) ? props.items : []
      const sessionTitles = isPlainObject(props.sessionTitles) ? props.sessionTitles : null
      const padding = '6px 8px'
      const headStyle = {
        padding,
        color: COLORS.muted,
        fontWeight: 500,
        borderBottom: `0.5px solid ${COLORS.borderStrong}`,
        whiteSpace: 'nowrap',
      }
      const cellStyle = {
        padding,
        color: COLORS.text,
        borderBottom: `0.5px solid ${COLORS.border}`,
        whiteSpace: 'nowrap',
        verticalAlign: 'top',
      }
      const rightCell = { ...cellStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
      return h('div', {
        key: 'table',
        style: { width: '100%', overflowX: 'auto', minWidth: 0 },
      }, h('table', {
        'data-dsh-part': typeof props.part === 'string' && props.part.length > 0 ? props.part : 'details-table',
        style: { width: '100%', borderCollapse: 'collapse', fontSize: 11, lineHeight: '18px' },
      }, [
        h('thead', { key: 'thead' }, h('tr', null, [
          h('th', { key: 'time', scope: 'col', style: { ...headStyle, textAlign: 'left' } }, t('requests.time')),
          h('th', { key: 'session', scope: 'col', style: { ...headStyle, textAlign: 'left' } }, t('details.session')),
          h('th', { key: 'purpose', scope: 'col', style: { ...headStyle, textAlign: 'left' } }, t('requests.purpose')),
          h('th', { key: 'prompt', scope: 'col', style: { ...headStyle, textAlign: 'right' } }, t('requests.prompt')),
          h('th', { key: 'output', scope: 'col', style: { ...headStyle, textAlign: 'right' } }, t('requests.output')),
          h('th', { key: 'cacheRead', scope: 'col', style: { ...headStyle, textAlign: 'right' } }, t('requests.cacheRead')),
          h('th', { key: 'cost', scope: 'col', style: { ...headStyle, textAlign: 'right' } }, t('table.cost')),
          h('th', { key: 'unpricedReason', scope: 'col', style: { ...headStyle, textAlign: 'left' } }, t('details.unpricedReason')),
        ])),
        h('tbody', { key: 'tbody' }, items.map(row => h('tr', { key: row.key }, [
          h('td', { key: 'time', style: { ...cellStyle, textAlign: 'left', fontVariantNumeric: 'tabular-nums' } }, formatTime(row.ts)),
          h('td', { key: 'session', style: { ...cellStyle, textAlign: 'left' } }, requestSessionCell(row, sessionTitles, t)),
          h('td', { key: 'purpose', style: { ...cellStyle, textAlign: 'left' } }, purposeLabel(t, row.purpose)),
          h('td', { key: 'prompt', style: rightCell }, tokenCell(row.promptTokens)),
          h('td', { key: 'output', style: rightCell }, tokenCell(row.outputTokens)),
          h('td', { key: 'cacheRead', style: rightCell }, tokenCell(row.cacheReadTokens)),
          h('td', { key: 'cost', style: rightCell }, formatCostCell(row.cost, undefined, { mixed: t('table.costMixed') })),
          h('td', {
            key: 'unpricedReason',
            style: { ...cellStyle, textAlign: 'left', color: row.unpricedReason ? COLORS.warning : COLORS.muted },
          }, row.unpricedReason ? t(`unpriced.${row.unpricedReason}`) : ''),
        ]))),
      ]))
    }

    /**
     * Details tab: paginated request rows over the selected range.
     *
     * Filters are purpose and session (both "all" by default); the page size is
     * 20 and "load more" appends from the current row count until the Host's
     * filtered `total`. Loading/empty/error states are local to the section and
     * a mid-list failure keeps the rows already shown.
     * @param {object} props - `{t, state, sessions, sessionTitles, onPurposeChange, onSessionChange, onLoadMore, onRetry, limit}`.
     * @returns {object} React element.
     */
    function DetailsTab(props) {
      const t = props.t
      const state = isPlainObject(props.state) ? props.state : createDetailsState()
      const sessionTitles = isPlainObject(props.sessionTitles) ? props.sessionTitles : null
      const limit = Number.isInteger(props.limit) && props.limit > 0 ? props.limit : DETAILS_PAGE_SIZE
      const purpose = typeof state.purpose === 'string' ? state.purpose : DETAILS_FILTER_ALL
      const sessionId = typeof state.sessionId === 'string' ? state.sessionId : DETAILS_FILTER_ALL
      const unpricedOnly = state.unpricedOnly === true
      const items = Array.isArray(state.items) ? state.items : []
      const total = countNumber(state.total)
      const options = sessionFilterOptions(props.sessions, sessionTitles)
      if (sessionId !== DETAILS_FILTER_ALL && !options.some(option => option.value === sessionId)) {
        options.unshift({ value: sessionId, label: shortId(sessionId, 12), title: '' })
      }
      const purposeOptions = [DETAILS_FILTER_ALL, ...DETAILS_PURPOSES]
      const selectStyle = { ...INPUT_STYLE, width: 'auto', minWidth: 120, maxWidth: 320 }
      const filterRow = h('div', {
        key: 'filters',
        'data-dsh-part': 'details-filters',
        style: { display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap', minWidth: 0 },
      }, [
        h('label', {
          key: 'purpose',
          style: { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11, color: COLORS.muted },
        }, [
          t('details.purposeFilter'),
          h('select', {
            value: purpose,
            'data-dsh-part': 'details-purpose',
            onChange: event => {
              if (typeof props.onPurposeChange === 'function') props.onPurposeChange(event.target.value)
            },
            style: selectStyle,
          }, purposeOptions.map(value => h('option', { key: value, value }, value === DETAILS_FILTER_ALL
            ? t('details.filterAll')
            : purposeLabel(t, value)))),
        ]),
        h('label', {
          key: 'session',
          style: { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11, color: COLORS.muted },
        }, [
          t('details.sessionFilter'),
          h('select', {
            value: sessionId,
            'data-dsh-part': 'details-session',
            onChange: event => {
              if (typeof props.onSessionChange === 'function') props.onSessionChange(event.target.value)
            },
            style: selectStyle,
          }, [h('option', { key: DETAILS_FILTER_ALL, value: DETAILS_FILTER_ALL }, t('details.filterAll')),
            ...options.map(option => h('option', { key: option.value, value: option.value }, option.label))]),
        ]),
        h('label', {
          key: 'unpriced',
          style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: COLORS.muted, paddingBottom: 4 },
        }, [
          h('input', {
            type: 'checkbox',
            checked: unpricedOnly,
            'data-dsh-part': 'details-unpriced',
            onChange: event => {
              if (typeof props.onUnpricedChange === 'function') props.onUnpricedChange(event.target.checked)
            },
            style: { margin: 0 },
          }),
          t('details.unpricedOnly'),
        ]),
        h('p', {
          key: 'progress',
          style: { ...HINT_STYLE, margin: '0 0 4px auto', whiteSpace: 'nowrap' },
        }, total > 0
          ? items.length >= total
            ? t('details.loadedAll', { total: formatTokens(total) })
            : t('details.progress', { shown: formatTokens(items.length), total: formatTokens(total) })
          : ''),
      ])
      let notice = null
      if (state.status === 'loading' || state.status === 'idle') {
        notice = h('p', { key: 'loading', role: 'status', style: { ...HINT_STYLE, margin: 0 } }, t('details.loading'))
      } else if (state.status === 'error') {
        notice = h('div', {
          key: 'error',
          role: 'alert',
          'data-dsh-part': 'details-error',
          style: { display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' },
        }, [
          h('p', { key: 'message', style: { ...ERROR_TEXT_STYLE, margin: 0 } }, rpcErrorMessage(t, state.error)),
          h('p', { key: 'hint', style: { ...HINT_STYLE, margin: 0 } }, t('details.failed')),
          h('button', {
            key: 'retry',
            type: 'button',
            'data-dsh-part': 'details-retry',
            onClick: typeof props.onRetry === 'function' ? props.onRetry : () => {},
            style: buttonStyle('primary'),
          }, t('button.retry')),
        ])
      }
      let table = null
      if (items.length === 0) {
        if (notice === null) {
          notice = h('p', { key: 'empty', style: { ...HINT_STYLE, margin: 0 } }, t('details.empty'))
        }
      } else {
        table = h(RequestRows, { key: 'table', items, sessionTitles, t })
      }
      const body = h('div', {
        key: 'body',
        style: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 },
      }, [notice, table].filter(item => item !== null))
      const canLoadMore = state.status === 'ready' && items.length > 0 && items.length < total
      const footer = canLoadMore || state.status === 'loading-more'
        ? h('div', {
          key: 'footer',
          'data-dsh-part': 'details-footer',
          style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
        }, [
          state.status === 'loading-more'
            ? h('span', { key: 'loading', role: 'status', style: { ...HINT_STYLE, margin: 0 } }, t('details.loadingMore'))
            : h('button', {
              key: 'more',
              type: 'button',
              'data-dsh-part': 'details-load-more',
              disabled: state.status !== 'ready',
              onClick: typeof props.onLoadMore === 'function' ? props.onLoadMore : () => {},
              style: buttonStyle('primary'),
            }, t('details.loadMore')),
        ])
        : null
      return h('section', {
        style: surfaceStyle({ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }),
      }, [
        h(SectionHeading, {
          key: 'head',
          title: t('details.title'),
          hint: t('details.hint', { limit }),
        }),
        filterRow,
        body,
        footer,
      ])
    }

    /**
     * Pure presentation for the drill-down request pane (M3). The fetching
     * wrapper `SessionRequestTable` owns the RPC; separating the render keeps
     * loading/empty/error and pagination states unit-testable without a DOM.
     * @param {object} props - `{state, t, sessionTitles, limit, onLoadMore, onRetry}`.
     * @returns {object} React element.
     */
    function SessionRequestsSection(props) {
      const t = props.t
      const state = isPlainObject(props.state) ? props.state : createDetailsState()
      const sessionTitles = isPlainObject(props.sessionTitles) ? props.sessionTitles : null
      const limit = Number.isInteger(props.limit) && props.limit > 0 ? props.limit : DETAILS_PAGE_SIZE
      const items = Array.isArray(state.items) ? state.items : []
      const total = countNumber(state.total)
      const progress = total > 0
        ? items.length >= total
          ? t('details.loadedAll', { total: formatTokens(total) })
          : t('details.progress', { shown: formatTokens(items.length), total: formatTokens(total) })
        : ''
      let notice = null
      if (state.status === 'loading' || state.status === 'idle') {
        notice = h('p', { key: 'loading', role: 'status', style: { ...HINT_STYLE, margin: 0 } }, t('details.loading'))
      } else if (state.status === 'error') {
        notice = h('div', {
          key: 'error',
          role: 'alert',
          'data-dsh-part': 'session-requests-error',
          style: { display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' },
        }, [
          h('p', { key: 'message', style: { ...ERROR_TEXT_STYLE, margin: 0 } }, rpcErrorMessage(t, state.error)),
          h('p', { key: 'hint', style: { ...HINT_STYLE, margin: 0 } }, t('sessionDetail.requestsFailed')),
          h('button', {
            key: 'retry',
            type: 'button',
            'data-dsh-part': 'session-requests-retry',
            onClick: typeof props.onRetry === 'function' ? props.onRetry : () => {},
            style: buttonStyle('primary'),
          }, t('button.retry')),
        ])
      }
      let table = null
      if (items.length === 0) {
        if (notice === null) {
          notice = h('p', { key: 'empty', style: { ...HINT_STYLE, margin: 0 } }, t('sessionDetail.requestsEmpty'))
        }
      } else {
        table = h(RequestRows, {
          key: 'table',
          items,
          sessionTitles,
          t,
          part: 'session-requests-table',
        })
      }
      const canLoadMore = state.status === 'ready' && items.length > 0 && items.length < total
      const footer = canLoadMore || state.status === 'loading-more'
        ? h('div', {
          key: 'footer',
          'data-dsh-part': 'session-requests-footer',
          style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
        }, [
          state.status === 'loading-more'
            ? h('span', { key: 'loading', role: 'status', style: { ...HINT_STYLE, margin: 0 } }, t('details.loadingMore'))
            : h('button', {
              key: 'more',
              type: 'button',
              'data-dsh-part': 'session-requests-load-more',
              disabled: state.status !== 'ready',
              onClick: typeof props.onLoadMore === 'function' ? props.onLoadMore : () => {},
              style: buttonStyle('primary'),
            }, t('details.loadMore')),
        ])
        : null
      return h('section', {
        'data-dsh-part': 'session-requests',
        style: surfaceStyle({ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }),
      }, [
        h(SectionHeading, {
          key: 'head',
          title: t('sessionDetail.requestsTitle'),
          hint: t('sessionDetail.requestsHint', { limit }),
          action: progress !== '' ? h('span', { style: { ...HINT_STYLE, margin: 0 } }, progress) : null,
        }),
        notice,
        table,
        footer,
      ])
    }

    /**
     * Fetching wrapper for the drill-down request pane.
     *
     * Calls the Host `requests` endpoint with `{from,to,limit:20,offset}` plus
     * the combined `sessionIds` list in subtree mode (or the legacy
     * `sessionId` filter in single-session mode) and pages 20 rows at a time.
     * A changed range/session/toggle resets to page 1; a mid-list failure keeps
     * the rows already rendered.
     * @param {object} props - `{t, rpc, range, fallbackRange, sessionId, includeDescendants, sessionIds, sessionTitles, limit}`.
     * @returns {object} React element.
     */
    function SessionRequestTable(props) {
      const range = normalizeRange(props.range)
      const fallback = normalizeRange(props.fallbackRange)
      const from = range.from !== '' || range.to !== '' ? range.from : fallback.from
      const to = range.from !== '' || range.to !== '' ? range.to : fallback.to
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const includeDescendants = props.includeDescendants === true
      const sessionIds = normalizeSessionIdList(props.sessionIds)
      const limit = Number.isInteger(props.limit) && props.limit > 0 ? props.limit : DETAILS_PAGE_SIZE
      const scopeKey = [
        from,
        to,
        sessionId,
        includeDescendants ? 'subtree' : 'single',
        includeDescendants ? sessionIds.join('|') : '',
      ].join('~')
      const [state, setState] = React.useState(() => createDetailsState(scopeKey))
      const [nonce, setNonce] = React.useState(0)
      const requestRef = React.useRef(0)
      React.useEffect(() => {
        const rpc = props.rpc
        if (rpc === null || typeof rpc !== 'object' || typeof rpc.call !== 'function') return undefined
        if (detailsRangeChanged(state, scopeKey)) {
          setState(current => detailsReducer(current, { type: 'range', rangeKey: scopeKey }))
          return undefined
        }
        const requestId = requestRef.current + 1
        requestRef.current = requestId
        const offset = state.offset
        setState(current => detailsReducer(current, { type: 'load' }))
        let cancelled = false
        const load = async () => {
          let result
          try {
            result = await rpc.call('requests', sessionRequestsPayload({ from, to }, {
              limit,
              offset,
              sessionId,
              includeDescendants,
              sessionIds,
            }))
          } catch (caught) {
            result = { ok: false, error: { code: 'transport', message: errorMessage(caught), details: {} } }
          }
          if (cancelled || requestRef.current !== requestId) return
          if (!isPlainObject(result) || result.ok !== true) {
            const failure = isPlainObject(result) && isPlainObject(result.error)
              ? result.error
              : { code: 'invalid-response', message: '', details: {} }
            setState(current => detailsReducer(current, { type: 'error', error: failure }))
            return
          }
          const page = normalizeRequests(result.value, offset)
          setState(current => detailsReducer(current, { type: 'loaded', items: page.items, total: page.total }))
        }
        load()
        return () => {
          cancelled = true
        }
      }, [props.rpc, scopeKey, state.rangeKey, state.offset, nonce])
      return h(SessionRequestsSection, {
        state,
        t: props.t,
        sessionTitles: props.sessionTitles,
        limit,
        onLoadMore: () => setState(current => detailsReducer(current, { type: 'more' })),
        onRetry: () => setNonce(value => value + 1),
      })
    }

    /**
     * Tool-group table shared by the Sources tab and the M3 session drill-down.
     * @param {object} props - `{byToolGroup, totalPromptTokens, t}`.
     * @returns {object} React element.
     */
    function ToolGroupTable(props) {
      const t = props.t
      return h(DataTable, {
        title: t('table.toolGroups.title'),
        hint: t('table.toolGroups.hint'),
        columns: [
          {
            key: 'group',
            label: t('table.toolGroups.group'),
            maxWidth: 260,
            // M2.8 group labels include longer names and custom keys; keep the
            // three columns aligned by ellipsizing with the full label in the
            // native tooltip instead of widening the table.
            render: row => h('span', {
              title: row.label,
              style: {
                display: 'inline-block',
                maxWidth: 260,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                verticalAlign: 'bottom',
              },
            }, row.label),
          },
          {
            key: 'tokens',
            label: t('table.toolGroups.tokens'),
            align: 'right',
            render: row => tokenCell(row.tokens),
          },
          {
            key: 'share',
            label: t('table.toolGroups.share'),
            align: 'right',
            render: row => formatPercent(row.share),
          },
        ],
        rows: toolGroupRows(props.byToolGroup, props.totalPromptTokens, t),
        emptyText: t('table.toolGroups.empty'),
      })
    }

    /**
     * M3 single-session drill-down view (Sessions tab only).
     *
     * Header: breadcrumb built from the range-wide `summary.bySession` parent
     * links, Back, resolved title + short id, and the subtree toggle
     * (`includeDescendants`, default on). Below the shared summary cards the
     * view renders the full mini dashboard for the selected session set: call
     * purpose, models, content sources, tool groups, search/fetch, daily
     * trend, direct children (clickable to drill further) and paginated
     * requests. When the Host reports `detailAvailable === false` (request
     * detail aged out) only the cards plus a localized note remain.
     * @param {object} props - `{state, t, rpc, range, sessionTitles, breadcrumb, onBack, onNavigate, onToggleDescendants, onRetry}`.
     * @returns {object} React element.
     */
    function SessionDetailView(props) {
      const t = props.t
      const state = isPlainObject(props.state) ? props.state : createDrillState()
      const [webApiOpen, setWebApiOpen] = React.useState(false)
      // The reducer stores a normalized detail; re-normalize defensively when a
      // caller hands the exported component a raw Host payload.
      let detail = null
      if (isPlainObject(state.data)) {
        detail = isPlainObject(state.data.summary) && Array.isArray(state.data.summary.byPurposeEntries)
          ? state.data
          : normalizeSessionDetail(state.data)
      }
      const sessionTitles = isPlainObject(props.sessionTitles) ? props.sessionTitles : null
      const sessionId = typeof state.sessionId === 'string' ? state.sessionId : ''
      const includeDescendants = state.includeDescendants === true
      const onBack = typeof props.onBack === 'function' ? props.onBack : () => {}
      const onNavigate = typeof props.onNavigate === 'function' ? props.onNavigate : () => {}
      const onToggleDescendants = typeof props.onToggleDescendants === 'function' ? props.onToggleDescendants : () => {}
      const resolvedTitle = sessionDisplayName(sessionId, sessionTitles, '')
      const displayName = resolvedTitle !== '' && resolvedTitle !== sessionId
        ? resolvedTitle
        : sessionId !== '' ? shortId(sessionId, 12) : t('table.sessions.unknown')
      const crumbRows = Array.isArray(props.breadcrumb) && props.breadcrumb.length > 0
        ? props.breadcrumb
        : sessionId !== '' ? [{ sessionId, parentSessionId: null }] : []
      const crumbStyle = {
        font: 'inherit',
        fontSize: 12,
        lineHeight: '18px',
        color: COLORS.brand,
        background: 'none',
        border: 'none',
        padding: '1px 2px',
        cursor: 'pointer',
        maxWidth: 220,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }
      const crumbs = []
      crumbRows.forEach((row, index) => {
        const id = typeof row?.sessionId === 'string' ? row.sessionId : ''
        const name = sessionDisplayName(id, sessionTitles, '')
        const label = name !== '' && name !== id ? name : shortId(id, 12)
        if (index > 0) {
          crumbs.push(h('span', {
            key: `crumb-sep-${index}`,
            'aria-hidden': 'true',
            style: { color: COLORS.muted, fontSize: 11, flex: 'none' },
          }, '›'))
        }
        if (index === crumbRows.length - 1) {
          crumbs.push(h('span', {
            key: `crumb-${id}`,
            'data-dsh-part': 'session-crumb-current',
            'aria-current': 'page',
            title: id,
            style: { ...crumbStyle, color: COLORS.text, cursor: 'default', fontWeight: 500 },
          }, label))
        } else {
          crumbs.push(h('button', {
            key: `crumb-${id}`,
            type: 'button',
            'data-dsh-part': 'session-crumb',
            'data-session-id': id,
            'aria-label': t('sessionDetail.crumb', { name: label }),
            title: id,
            onClick: () => onNavigate(id),
            style: crumbStyle,
          }, label))
        }
      })
      const modeBadgeStyle = {
        fontSize: 10,
        lineHeight: '14px',
        color: COLORS.muted,
        border: `0.5px solid ${COLORS.border}`,
        borderRadius: 999,
        padding: '0 6px',
        whiteSpace: 'nowrap',
        flex: 'none',
      }
      const header = h('section', {
        key: 'header',
        'data-dsh-part': 'session-detail-header',
        style: surfaceStyle({ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }),
      }, [
        h('div', {
          key: 'nav',
          style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 },
        }, [
          h('button', {
            key: 'back',
            type: 'button',
            'data-dsh-part': 'session-detail-back',
            'aria-label': t('sessionDetail.back'),
            title: t('sessionDetail.back'),
            onClick: onBack,
            style: { ...buttonStyle(), flex: 'none' },
          }, [
            h('span', { key: 'arrow', 'aria-hidden': 'true' }, '←'),
            h('span', { key: 'label' }, t('sessionDetail.back')),
          ]),
          h('nav', {
            key: 'crumbs',
            'aria-label': t('sessionDetail.breadcrumb'),
            style: { display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', minWidth: 0 },
          }, crumbs),
        ]),
        h('div', {
          key: 'title',
          style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', minWidth: 0 },
        }, [
          h('h2', {
            key: 'name',
            'data-dsh-part': 'session-detail-title',
            title: sessionId,
            style: {
              margin: 0,
              fontSize: 16,
              lineHeight: '24px',
              fontWeight: 600,
              color: COLORS.text,
              minWidth: 0,
              maxWidth: 520,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          }, displayName),
          sessionId !== ''
            ? h('code', {
              key: 'id',
              'data-dsh-part': 'session-detail-id',
              title: sessionId,
              style: { fontFamily: MONO_STACK, fontSize: 11, color: COLORS.muted },
            }, shortId(sessionId, 12))
            : null,
          h('span', { key: 'mode', style: modeBadgeStyle }, includeDescendants
            ? t('sessionDetail.subtreeNote')
            : t('sessionDetail.singleNote')),
        ]),
        h('div', {
          key: 'toggle',
          'data-dsh-part': 'session-detail-toggle',
          style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 },
        }, [
          h(Switch, {
            checked: includeDescendants,
            onChange: next => onToggleDescendants(next === true),
            label: t('sessionDetail.includeDescendants'),
          }),
          h('span', {
            key: 'label',
            style: { fontSize: 12, lineHeight: '18px', fontWeight: 500, color: COLORS.text },
          }, includeDescendants ? t('sessionDetail.includeDescendants') : t('sessionDetail.onlySession')),
          h('span', {
            key: 'hint',
            style: { ...HINT_STYLE, margin: 0 },
          }, includeDescendants ? t('sessionDetail.toggleHint') : t('sessionDetail.toggleSingleHint')),
        ]),
      ])
      const children = [header]
      const summary = detail !== null ? detail.summary : null
      if (state.status === 'error') {
        children.push(h('section', {
          key: 'error',
          role: 'alert',
          'data-dsh-part': 'session-detail-error',
          style: surfaceStyle({ padding: '18px 16px', display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }),
        }, [
          h('p', { key: 'message', style: { margin: 0, fontSize: 13, lineHeight: '20px', color: COLORS.danger } }, rpcErrorMessage(t, state.error)),
          h('p', { key: 'hint', style: { ...HINT_STYLE, margin: 0 } }, t('sessionDetail.loadFailed')),
          typeof props.onRetry === 'function'
            ? h('button', {
              key: 'retry',
              type: 'button',
              'data-dsh-part': 'session-detail-retry',
              onClick: props.onRetry,
              style: buttonStyle('primary'),
            }, t('button.retry'))
            : null,
        ]))
        return h('div', {
          'data-dsh-part': 'session-detail',
          style: { display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 },
        }, children)
      }
      if (detail === null) {
        children.push(h('p', {
          key: 'loading',
          role: 'status',
          'data-dsh-part': 'session-detail-loading',
          style: { ...HINT_STYLE, margin: 0 },
        }, t('sessionDetail.loading')))
        return h('div', {
          'data-dsh-part': 'session-detail',
          style: { display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 },
        }, children)
      }
      if (state.status === 'empty') {
        children.push(h('section', {
          key: 'missing',
          role: 'status',
          'data-dsh-part': 'session-detail-missing',
          style: surfaceStyle({ padding: '28px 20px', display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }),
        }, [
          h('p', { key: 'text', style: { margin: 0, fontSize: 14, lineHeight: '20px', color: COLORS.text } }, t('sessionDetail.missing')),
          h('p', { key: 'hint', style: { ...HINT_STYLE, margin: 0 } }, t('sessionDetail.missingHint')),
          h('button', {
            key: 'back',
            type: 'button',
            'data-dsh-part': 'session-detail-missing-back',
            onClick: onBack,
            style: { ...buttonStyle('primary'), alignSelf: 'flex-start' },
          }, t('sessionDetail.back')),
        ]))
        // Keep surviving direct children navigable when the parent itself has
        // aged out of the selected range.
        if (detail.children.length > 0) {
          const missingChildStyle = {
            fontSize: 12,
            color: COLORS.brand,
            background: 'none',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            maxWidth: 320,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }
          children.push(h('section', {
            key: 'missing-children',
            'data-dsh-part': 'session-detail-missing-children',
            style: surfaceStyle({ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }),
          }, [
            h(SectionHeading, { key: 'head', title: t('sessionDetail.childrenTitle'), hint: t('sessionDetail.childrenHint') }),
            ...detail.children.map(child => {
              const childId = typeof child.sessionId === 'string' ? child.sessionId : ''
              const name = sessionDisplayName(childId, sessionTitles, '')
              const label = name !== '' && name !== childId ? name : shortId(childId, 12)
              const stats = subtreeStats(child)
              return h('button', {
                key: childId,
                type: 'button',
                'data-dsh-part': 'session-detail-missing-child',
                'data-session-id': childId,
                'aria-label': t('sessionDetail.child', { name: label }),
                title: childId,
                onClick: () => onNavigate(childId),
                style: { ...missingChildStyle, alignSelf: 'flex-start' },
              }, `${label} · ${formatTokens(stats.requests)} req · ${formatCompactTokens(stats.tokens)} tok`)
            }),
          ]))
        }
        return h('div', {
          'data-dsh-part': 'session-detail',
          style: { display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 },
        }, children)
      }
      if (state.status === 'loading') {
        children.push(h('p', {
          key: 'refreshing',
          role: 'status',
          style: { ...HINT_STYLE, margin: 0 },
        }, t('panel.refreshing')))
      }
      const cards = summaryCardModels(t, summary)
      children.push(h('section', {
        key: 'summary',
        'data-dsh-part': 'session-detail-summary',
        style: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 },
      }, [
        h(SectionHeading, { key: 'head', title: t('sessionDetail.summaryTitle'), hint: t('sessionDetail.cardsHint') }),
        h('div', {
          key: 'grid',
          style: {
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
            gap: 10,
          },
        }, cards.map(card => h(MetricCard, {
          key: card.key,
          label: card.label,
          value: card.value,
          valueTitle: card.valueTitle,
          hint: card.hint,
          lines: card.lines,
          tone: card.tone,
        }))),
      ]))
      if (detail.detailAvailable === false) {
        children.push(h('p', {
          key: 'unavailable',
          role: 'status',
          'data-dsh-part': 'session-detail-unavailable',
          title: detail.detailReason ?? undefined,
          style: surfaceStyle({
            margin: 0,
            padding: '10px 12px',
            background: `color-mix(in srgb, ${COLORS.warning} 8%, ${COLORS.surface})`,
            borderColor: `color-mix(in srgb, ${COLORS.warning} 35%, ${COLORS.border})`,
            fontSize: 12,
            lineHeight: '18px',
            color: COLORS.text,
          }),
        }, t('sessionDetail.unavailable')))
        return h('div', {
          'data-dsh-part': 'session-detail',
          style: { display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 },
        }, children)
      }
      if (detail.detailPartial) {
        children.push(h('p', {
          key: 'partial',
          role: 'status',
          'data-dsh-part': 'session-detail-partial',
          style: { ...HINT_STYLE, margin: 0 },
        }, t('sessionDetail.partial')))
      }
      const purposeEntries = summary.byPurposeEntries.map(entry => ({
        key: entry.key,
        label: purposeLabel(t, entry.key),
        value: entry.tokens,
      }))
      children.push(h('div', {
        key: 'purpose',
        'data-dsh-part': 'session-detail-purpose',
        style: { display: 'flex', flexDirection: 'column', minWidth: 0 },
      }, h(StackedBar, {
        title: t('chart.purpose.title'),
        hint: t('chart.purpose.hint'),
        entries: purposeEntries,
        t,
      })))
      children.push(h('div', {
        key: 'models',
        'data-dsh-part': 'session-detail-models',
        style: { display: 'flex', flexDirection: 'column', minWidth: 0 },
      }, h(ModelsTable, {
        rows: summary.byModel,
        currency: summary.cost.currency,
        t,
      })))
      children.push(h(StackedBar, {
        key: 'category',
        title: t('chart.category.title'),
        hint: t('chart.category.hint'),
        entries: categoryGroupEntries(summary.byCategoryGroup, t),
        t,
      }))
      children.push(h('section', {
        key: 'categoryDetail',
        'data-dsh-part': 'session-detail-category-detail',
        style: surfaceStyle({ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }),
      }, [
        h(SectionHeading, {
          key: 'head',
          title: t('chart.category.detailTitle'),
          hint: t('chart.category.detailHint'),
        }),
        h(CategoryDetailTable, {
          key: 'detail',
          byCategory: summary.byCategory,
          totalPromptTokens: summary.totals.promptTokens,
          t,
        }),
      ]))
      children.push(h('div', {
        key: 'tools',
        'data-dsh-part': 'session-detail-tools',
        style: { display: 'flex', flexDirection: 'column', minWidth: 0 },
      }, h(ToolGroupTable, {
        byToolGroup: summary.byToolGroup,
        totalPromptTokens: summary.totals.promptTokens,
        t,
      })))
      const webApi = detail.webApi
      children.push(h('section', {
        key: 'web',
        'data-dsh-part': 'session-detail-web',
        style: { display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 },
      }, [
        h('div', {
          key: 'card',
          style: {
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 10,
          },
        }, h(WebApiSummaryCard, { t, webApi })),
        h(WebApiSessionTable, {
          key: 'rows',
          rows: webApi.bySession,
          currency: summary.cost.currency,
          sessionTitles,
          hint: t('sessionDetail.webHint'),
          open: webApiOpen,
          onToggle: () => setWebApiOpen(open => !open),
          t,
        }),
      ]))
      children.push(h('div', {
        key: 'trend',
        'data-dsh-part': 'session-detail-trend',
        style: { display: 'flex', flexDirection: 'column', minWidth: 0 },
      }, h(TrendChart, { byDay: summary.byDay, t })))
      // Direct-child rows show the child's subtree totals when the Host sent
      // the descendant closure in `summary.bySession`; in single-session mode
      // the rows fall back to the child's own aggregate.
      const detailTree = buildSessionTree(summary.bySession)
      const treeNodes = new Map(detailTree.nodes.map(node => [node.key, node]))
      const childRows = detail.children.map(child => {
        const node = treeNodes.get(child.sessionId)
        const stats = node !== undefined && node.subtree !== null ? node.subtree : subtreeStats(child)
        return {
          key: child.sessionId,
          sessionId: child.sessionId,
          tokens: stats.tokens,
          requests: stats.requests,
          promptTokens: stats.splitAvailable ? stats.promptTokens : null,
          outputTokens: stats.splitAvailable ? stats.outputTokens : null,
          cost: stats.cost,
        }
      }).sort((left, right) => (right.tokens - left.tokens) || left.sessionId.localeCompare(right.sessionId))
      const childTitleStyle = {
        fontSize: 12,
        color: COLORS.brand,
        background: 'none',
        border: 'none',
        padding: 0,
        cursor: 'pointer',
        maxWidth: 320,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }
      children.push(h('div', {
        key: 'children',
        'data-dsh-part': 'session-detail-children',
        style: { display: 'flex', flexDirection: 'column', minWidth: 0 },
      }, h(DataTable, {
        title: t('sessionDetail.childrenTitle'),
        hint: includeDescendants ? t('sessionDetail.childrenHint') : t('sessionDetail.childrenHintSingle'),
        columns: [
          {
            key: 'session',
            label: t('table.sessions.session'),
            maxWidth: 340,
            render: row => {
              const childId = typeof row.sessionId === 'string' ? row.sessionId : ''
              const name = sessionDisplayName(childId, sessionTitles, '')
              const label = name !== '' && name !== childId ? name : shortId(childId, 12)
              return h('button', {
                type: 'button',
                'data-dsh-part': 'session-detail-child',
                'data-session-id': childId,
                'aria-label': t('sessionDetail.child', { name: label }),
                title: childId,
                onClick: () => onNavigate(childId),
                style: childTitleStyle,
              }, label)
            },
          },
          {
            key: 'requests',
            label: t('table.sessions.requests'),
            align: 'right',
            render: row => formatTokens(row.requests),
          },
          {
            key: 'promptTokens',
            label: t('table.sessions.promptTokens'),
            align: 'right',
            render: row => (row.promptTokens !== null ? tokenCell(row.promptTokens) : t('card.valueUnavailable')),
          },
          {
            key: 'outputTokens',
            label: t('table.sessions.outputTokens'),
            align: 'right',
            render: row => (row.outputTokens !== null ? tokenCell(row.outputTokens) : t('card.valueUnavailable')),
          },
          {
            key: 'cost',
            label: t('table.cost'),
            align: 'right',
            render: row => formatCostCell(row.cost, summary.cost.currency, {
              mixed: t('table.costMixed'),
              unpriced: t('card.valueUnavailable'),
            }),
          },
        ],
        rows: childRows,
        emptyText: t('sessionDetail.childrenEmpty'),
      })))
      children.push(h(SessionRequestTable, {
        key: 'requests',
        t,
        rpc: props.rpc,
        range: detail.range,
        fallbackRange: props.range,
        sessionId,
        includeDescendants,
        sessionIds: detail.sessionIds,
        sessionTitles,
        limit: DETAILS_PAGE_SIZE,
      }))
      return h('div', {
        'data-dsh-part': 'session-detail',
        style: { display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 },
      }, children)
    }

    /**
     * Build the footnote items from a normalized summary and optional metadata.
     * @param {object} summary - normalized summary.
     * @param {object|null} meta - raw `meta` value.
     * @param {object} t - translator.
     * @returns {Array<{key: string, text: string}>} items.
     */
    function footnoteItems(summary, meta, t) {
      const items = [{ key: 'usage', text: t('footnote.usage') }]
      const estimated = summary?.totals?.estimatedRequests ?? 0
      const measured = summary?.totals?.measuredRequests ?? 0
      if (estimated > 0 || measured > 0) {
        items.push({
          key: 'estimated',
          text: t('footnote.estimated', {
            estimated: formatTokens(estimated),
            measured: formatTokens(measured),
          }),
        })
      }
      const estimatedPromptTokens = summary?.totals?.estimatedPromptTokens ?? 0
      if (estimatedPromptTokens > 0) {
        items.push({
          key: 'estimatedTokens',
          text: t('footnote.estimatedTokens', {
            tokens: formatCompactTokens(estimatedPromptTokens),
            total: formatCompactTokens(summary?.totals?.promptTokens ?? 0),
            percent: formatPercent((summary?.totals?.promptTokens ?? 0) > 0
              ? estimatedPromptTokens / summary.totals.promptTokens
              : 0),
          }),
        })
      }
      items.push({ key: 'cost', text: t('footnote.cost') })
      items.push({ key: 'costTiers', text: t('footnote.costTiers') })
      const byCurrency = isPlainObject(summary?.cost?.byCurrency) ? summary.cost.byCurrency : {}
      const currencies = Object.keys(byCurrency)
      if (summary?.cost?.currency === 'mixed' || currencies.length > 1) {
        const breakdown = formatCurrencyBreakdown(byCurrency, t)
        items.push({
          key: 'costMixed',
          text: breakdown === ''
            ? t('footnote.costMixed')
            : t('footnote.costBreakdown', { breakdown }),
        })
      }
      if (summary?.data?.costDetailIncomplete === true) {
        items.push({ key: 'costDetailIncomplete', text: t('footnote.costDetailIncomplete') })
      }
      items.push({ key: 'webApi', text: t('footnote.webApi') })
      const since = meta?.since ?? summary?.data?.since
      const retention = summary?.data?.retention ?? meta?.retention
      if (retention !== undefined && retention !== null) {
        items.push({
          key: 'retention',
          text: t('footnote.retention', {
            since: formatDate(since),
            requestDays: formatTokens(retention.requestDays ?? 0),
            dailyDays: formatTokens(retention.dailyDays ?? 0),
          }),
        })
      } else {
        items.push({ key: 'retention', text: t('footnote.retentionUnknown') })
      }
      const readOnly = summary?.data?.readOnly === true || meta?.readOnly === true
      if (readOnly) items.push({ key: 'readOnly', text: t('footnote.readOnly') })
      const dataRoot = meta?.dataRoot ?? summary?.data?.dataRoot
      if (typeof dataRoot === 'string' && dataRoot.length > 0) {
        items.push({ key: 'dataRoot', text: t('footnote.dataRoot', { path: dataRoot }) })
      }
      const pointer = meta?.pointerStatus ?? summary?.data?.pointerStatus
      if (typeof pointer === 'string' && pointer.length > 0 && pointer !== 'ok') {
        items.push({ key: 'pointer', text: t('footnote.pointer', { status: pointer }) })
      }
      const migration = meta?.migration ?? summary?.data?.migration
      const migrationStatus = typeof migration?.status === 'string'
        ? migration.status
        : typeof meta?.migrationStatus === 'string'
          ? meta.migrationStatus
          : typeof summary?.data?.migrationStatus === 'string'
            ? summary.data.migrationStatus
            : ''
      if (migrationStatus !== '' && migrationStatus !== 'ok') {
        items.push({
          key: 'migration',
          text: t('footnote.migrationStatus', { status: migrationStatusLabel(t, migrationStatus) }),
        })
      }
      items.push({ key: 'privacy', text: t('footnote.privacy') })
      items.push({ key: 'generated', text: t('footnote.generated', { time: formatTime(summary?.generatedAt) }) })
      return items
    }

    /**
     * Footnote section.
     * @param {object} props - `{summary, meta, t, channel}`.
     * @returns {object} React element.
     */
    function Footnote(props) {
      const items = footnoteItems(props.summary, props.meta, props.t)
      if (typeof props.channel === 'string' && props.channel.length > 0) {
        items.push({ key: 'channel', text: props.t('footnote.source', { channel: props.channel }) })
      }
      return h('section', {
        style: surfaceStyle({ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 6 }),
      }, [
        h('h2', {
          key: 'title',
          style: { margin: 0, fontSize: 13, lineHeight: '20px', fontWeight: 500, color: COLORS.text },
        }, props.t('footnote.title')),
        h('ul', {
          key: 'list',
          style: { margin: 0, paddingLeft: 18, color: COLORS.muted, fontSize: 12, lineHeight: '18px' },
        }, items.map(item => h('li', { key: item.key, style: { margin: '2px 0' } }, item.text))),
      ])
    }

    /**
     * Loading state.
     * @param {object} props - `{t}`.
     * @returns {object} React element.
     */
    function LoadingState(props) {
      return h('div', {
        role: 'status',
        'aria-live': 'polite',
        style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '72px 16px' },
      }, [
        h('p', { key: 'title', style: { margin: 0, fontSize: 14, lineHeight: '20px', color: COLORS.text } }, props.t('state.loading')),
        h('p', { key: 'hint', style: { ...HINT_STYLE, margin: 0 } }, props.t('state.loadingHint')),
      ])
    }

    /**
     * Empty state.
     * @param {object} props - `{t, onRetry}`.
     * @returns {object} React element.
     */
    function EmptyState(props) {
      return h('div', {
        style: surfaceStyle({
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 8,
          padding: '56px 16px',
          textAlign: 'center',
        }),
      }, [
        h(UsageIcon, { key: 'icon', size: 40 }),
        h('h2', { key: 'title', style: { margin: 0, fontSize: 16, lineHeight: '24px', fontWeight: 500, color: COLORS.text } }, props.t('state.empty.title')),
        h('p', { key: 'hint', style: { ...HINT_STYLE, margin: 0, maxWidth: '52ch' } }, props.t('state.empty.hint')),
        h('button', {
          key: 'retry',
          type: 'button',
          onClick: props.onRetry,
          style: buttonStyle('primary'),
        }, props.t('state.empty.retry')),
      ])
    }

    /**
     * Fatal error state.
     * @param {object} props - `{t, error, onRetry}`.
     * @returns {object} React element.
     */
    function ErrorState(props) {
      const error = props.error ?? {}
      return h('div', {
        role: 'alert',
        'aria-label': props.t('aria.error'),
        style: surfaceStyle({
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          gap: 8,
          padding: '28px 20px',
          borderColor: `color-mix(in srgb, ${COLORS.danger} 35%, ${COLORS.border})`,
        }),
      }, [
        h('h2', { key: 'title', style: { margin: 0, fontSize: 16, lineHeight: '24px', fontWeight: 500, color: COLORS.text } }, props.t('state.error.title')),
        h('p', { key: 'message', style: { margin: 0, fontSize: 13, lineHeight: '20px', color: COLORS.danger } }, rpcErrorMessage(props.t, error)),
        h('p', { key: 'hint', style: { ...HINT_STYLE, margin: 0 } }, props.t('state.error.hint')),
        error.message
          ? h('div', { key: 'detail', style: { minWidth: 0, width: '100%' } }, [
            h('div', { key: 'label', style: { fontSize: 11, color: COLORS.muted, marginBottom: 2 } }, props.t('state.error.detail')),
            h('code', {
              key: 'code',
              style: {
                display: 'block',
                fontFamily: MONO_STACK,
                fontSize: 11,
                lineHeight: '16px',
                color: COLORS.muted,
                wordBreak: 'break-word',
                background: COLORS.base,
                border: `0.5px solid ${COLORS.border}`,
                borderRadius: 'var(--dsw-radius-sm, 6px)',
                padding: '6px 8px',
              },
            }, String(error.message)),
          ])
          : null,
        h('button', {
          key: 'retry',
          type: 'button',
          onClick: props.onRetry,
          style: buttonStyle('primary'),
        }, props.t('state.error.retry')),
      ])
    }

    /**
     * Non-fatal refresh warning.
     * @param {object} props - `{t, error, onRetry}`.
     * @returns {object} React element.
     */
    function RefreshWarning(props) {
      return h('div', {
        role: 'status',
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          padding: '6px 10px',
          borderRadius: 'var(--dsw-radius-sm, 6px)',
          background: `color-mix(in srgb, ${COLORS.warning} 10%, ${COLORS.surface})`,
          border: `0.5px solid color-mix(in srgb, ${COLORS.warning} 35%, ${COLORS.border})`,
          color: COLORS.text,
          fontSize: 12,
          lineHeight: '18px',
        },
      }, [
        h('span', { key: 'text' }, props.t('state.error.refreshFailed', {
          message: rpcErrorMessage(props.t, props.error),
        })),
        h('button', {
          key: 'retry',
          type: 'button',
          onClick: props.onRetry,
          style: buttonStyle('ghost'),
        }, props.t('button.retry')),
      ])
    }

    /**
     * Build the Web API overview-card model shared by the Overview and Web tabs.
     *
     * M2.7 adds a `未归因 N` sub-line only when the Host reports unattributed
     * calls (pre-M2.5 totals), so a modern Host renders exactly the pre-M2.7
     * card.
     * @param {(key: string, params?: object) => string} t - translator.
     * @param {object} webApi - normalized `summary.webApi`.
     * @returns {object} MetricCard props.
     */
    function webApiSummaryCardModel(t, webApi) {
      const failed = webApi.calls.failed
      const unattributed = isPlainObject(webApi.unattributed) ? webApi.unattributed : null
      const unattributedCalls = isPlainObject(unattributed?.calls)
        ? countNumber(unattributed.calls.total)
        : 0
      const lines = [
        t('card.webApiCounts', {
          search: formatTokens(webApi.search.total),
          fetch: formatTokens(webApi.fetch.total),
        }),
      ]
      if (failed > 0) lines.push(t('card.webApiFailed', { count: formatTokens(failed) }))
      if (unattributedCalls > 0) {
        lines.push(t('card.webApiUnattributed', { count: formatTokens(unattributedCalls) }))
      }
      lines.push(webApi.cost.priced
        ? t('card.webApiCost', {
          amount: formatCostAmount(webApi.cost.amount),
          currency: webApi.cost.currency,
        })
        : t('card.webApiNoBillable'))
      return {
        key: 'webApi',
        label: t('card.webApi'),
        value: t('card.webApiValue', {
          calls: formatTokens(webApi.calls.total),
          unit: t('card.webApiUnit'),
        }),
        valueTitle: t('card.webApiTotalTitle', { count: formatTokens(webApi.calls.total) }),
        lines,
        tone: failed > 0 ? 'warning' : 'default',
      }
    }

    /**
     * Standalone Web API summary card (Web tab).
     * @param {object} props - `{t, webApi}`.
     * @returns {object} React element.
     */
    function WebApiSummaryCard(props) {
      return h(MetricCard, webApiSummaryCardModel(props.t, props.webApi))
    }

    /**
     * Column definitions shared by the full models table and its Top-5 summary.
     * @param {(key: string, params?: object) => string} t - translator.
     * @param {unknown} currency - display fallback currency.
     * @returns {Array<object>} DataTable columns.
     */
    function modelColumns(t, currency) {
      const costLabels = { mixed: t('table.costMixed'), unpriced: '—' }
      return [
        {
          key: 'provider',
          label: t('table.models.provider'),
          render: row => row.provider || t('table.models.unknown'),
        },
        {
          key: 'model',
          label: t('table.models.model'),
          render: row => row.model || t('table.models.unknown'),
        },
        {
          key: 'requests',
          label: t('table.models.requests'),
          align: 'right',
          render: row => formatTokens(row.requests),
        },
        {
          key: 'promptTokens',
          label: t('table.models.promptTokens'),
          align: 'right',
          render: row => tokenCell(row.promptTokens),
        },
        {
          key: 'outputTokens',
          label: t('table.models.outputTokens'),
          align: 'right',
          render: row => tokenCell(row.outputTokens),
        },
        {
          key: 'cost',
          label: t('table.cost'),
          align: 'right',
          render: row => formatCostCell(row.cost, currency, costLabels),
        },
      ]
    }

    /**
     * Models table with an optional Top-N read-only cap.
     * @param {object} props - `{rows, currency, t, limit}`.
     * @returns {object} React element.
     */
    function ModelsTable(props) {
      const t = props.t
      const limit = Number.isInteger(props.limit) && props.limit > 0 ? props.limit : 0
      const rows = (Array.isArray(props.rows) ? props.rows : []).slice(0, limit > 0 ? limit : undefined)
      return h(DataTable, {
        title: typeof props.title === 'string' && props.title.length > 0 ? props.title : t('table.models.title'),
        hint: t('table.models.hint'),
        columns: modelColumns(t, props.currency),
        rows,
        emptyText: t('table.models.empty'),
      })
    }

    /**
     * Build the summary card models shared by the Overview tab and the M3
     * session drill-down. The Web API card is appended by the caller because
     * the drill-down keeps its filtered search/fetch section separate.
     * @param {(key: string, params?: object) => string} t - translator.
     * @param {object} summary - normalized summary.
     * @returns {Array<object>} MetricCard props.
     */
    function summaryCardModels(t, summary) {
      const totals = summary.totals
      const unpriced = summary.cost.unpricedRequests
      const unpricedReasonText = unpriced > 0 ? unpricedReasonsText(t, summary.unpricedReasons) : ''
      const costMixed = summary.cost.currency === 'mixed'
      return [
        {
          key: 'total',
          label: t('card.total'),
          value: formatCompactTokens(totals.totalTokens),
          valueTitle: formatTokens(totals.totalTokens),
          hint: t('card.totalHint'),
          tone: 'accent',
        },
        {
          key: 'prompt',
          label: t('card.prompt'),
          value: formatCompactTokens(totals.promptTokens),
          valueTitle: formatTokens(totals.promptTokens),
          hint: t('card.promptHint'),
        },
        {
          key: 'output',
          label: t('card.output'),
          value: formatCompactTokens(totals.outputTokens),
          valueTitle: formatTokens(totals.outputTokens),
          hint: t('card.outputHint'),
        },
        {
          key: 'cache',
          label: t('card.cacheHit'),
          value: formatPercent(summary.cache.hitRate),
          hint: t('card.cacheHint', {
            read: formatCompactTokens(summary.cache.read),
            write: formatCompactTokens(summary.cache.write),
          }),
        },
        {
          key: 'requests',
          label: t('card.requests'),
          value: formatTokens(totals.requests),
          hint: t('card.requestsHint', {
            measured: formatTokens(totals.measuredRequests),
            estimated: formatTokens(totals.estimatedRequests),
          }),
        },
        {
          key: 'cost',
          label: t('card.cost'),
          value: costMixed
            ? t('table.costMixed')
            : formatCurrency(summary.cost.amount, summary.cost.currency),
          hint: unpriced > 0
            ? unpricedReasonText !== ''
              ? t('card.costUnpricedReasons', { count: formatTokens(unpriced), reasons: unpricedReasonText })
              : t('card.costUnpriced', { count: formatTokens(unpriced) })
            : t('card.costHint'),
          tone: unpriced > 0 ? 'warning' : 'default',
        },
      ]
    }

    /**
     * Overview tab: cards, Web API sessions Top-5, purpose/content-source bars,
     * the daily trend, and compact Top-5 session/model summaries plus the
     * accounting footnote. Full tables live on their own tabs.
     * @param {object} props - `{summary, meta, t, channel, sessionTitles}`.
     * @returns {object} React element.
     */
    function OverviewTab(props) {
      const summary = props.summary
      const t = props.t
      const purposeEntries = summary.byPurposeEntries.map(entry => ({
        key: entry.key,
        label: purposeLabel(t, entry.key),
        value: entry.tokens,
      }))
      const categoryEntries = categoryGroupEntries(summary.byCategoryGroup, t)
      const webApi = summary.webApi
      const webApiSessionRows = webApi.bySession.filter(row => row.calls.total > 0)
      const cards = [...summaryCardModels(t, summary), webApiSummaryCardModel(t, webApi)]

      return h('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 },
      }, [
        h('div', {
          key: 'cards',
          style: {
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
            gap: 10,
          },
        }, cards.map(card => h(MetricCard, {
          key: card.key,
          label: card.label,
          value: card.value,
          valueTitle: card.valueTitle,
          hint: card.hint,
          lines: card.lines,
          tone: card.tone,
        }))),
        h(StackedBar, {
          key: 'purpose',
          title: t('chart.purpose.title'),
          hint: t('chart.purpose.hint'),
          entries: purposeEntries,
          t,
        }),
        h(StackedBar, {
          key: 'category',
          title: t('chart.category.title'),
          hint: t('chart.category.hintOverview'),
          entries: categoryEntries,
          t,
        }),
        h(TrendChart, {
          key: 'trend',
          byDay: summary.byDay,
          t,
        }),
        h(SessionTreeTable, {
          key: 'sessions',
          bySession: summary.bySession,
          currency: summary.cost.currency,
          sessionTitles: props.sessionTitles ?? null,
          limit: OVERVIEW_TOP_N,
          title: t('table.sessions.topTitle', { count: OVERVIEW_TOP_N }),
          t,
        }),
        webApiSessionRows.length > 0
          ? h(WebApiSessionTable, {
            key: 'webApiSessions',
            rows: webApi.bySession,
            currency: summary.cost.currency,
            sessionTitles: props.sessionTitles ?? null,
            limit: OVERVIEW_TOP_N,
            title: t('table.webApiSessions.topTitle', { count: OVERVIEW_TOP_N }),
            // The compact form keeps the Top-5 session rows untouched and
            // reports the unattributed count as a one-line hint suffix.
            unattributed: webApi.unattributed,
            unattributedCompact: true,
            t,
          })
          : null,
        h(ModelsTable, {
          key: 'models',
          rows: summary.byModel,
          currency: summary.cost.currency,
          limit: OVERVIEW_TOP_N,
          title: t('table.models.topTitle', { count: OVERVIEW_TOP_N }),
          t,
        }),
        h(Footnote, {
          key: 'footnote',
          summary,
          meta: props.meta,
          t,
          channel: props.channel,
        }),
      ])
    }

    /**
     * Sessions tab: the full expandable session tree plus the full Web API
     * sessions table (its normal 10-row fold and 100-row Host cap apply).
     * M3 wires `onOpen` to the in-place drill-down and shows the drill failure
     * warning (after an error the panel clears the selection and returns here).
     * @param {object} props - `{summary, t, sessionTitles, session, webApiSessions, onOpen, drillError, onRetryDrill}`.
     * @returns {object} React element.
     */
    function SessionsTab(props) {
      const summary = props.summary
      const t = props.t
      return h('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 },
      }, [
        props.drillError !== null && props.drillError !== undefined
          ? h(RefreshWarning, {
            key: 'drill-error',
            t,
            error: props.drillError,
            onRetry: typeof props.onRetryDrill === 'function' ? props.onRetryDrill : () => {},
          })
          : null,
        h(SessionTreeTable, {
          key: 'sessions',
          bySession: summary.bySession,
          currency: summary.cost.currency,
          expanded: props.session?.expanded ?? null,
          onToggle: props.session?.onToggle,
          onOpen: typeof props.onOpen === 'function' ? props.onOpen : null,
          sessionTitles: props.sessionTitles ?? null,
          t,
        }),
        h(WebApiSessionTable, {
          key: 'webApiSessions',
          rows: summary.webApi.bySession,
          currency: summary.cost.currency,
          sessionTitles: props.sessionTitles ?? null,
          unattributed: summary.webApi.unattributed,
          open: props.webApiSessions?.open === true,
          onToggle: props.webApiSessions?.onToggle,
          t,
        }),
      ])
    }

    /**
     * Models tab: the full provider/model table.
     * @param {object} props - `{summary, t}`.
     * @returns {object} React element.
     */
    function ModelsTab(props) {
      return h(ModelsTable, {
        rows: props.summary.byModel,
        currency: props.summary.cost.currency,
        t: props.t,
      })
    }

    /**
     * Sources tab: the full grouped content-source bar, the raw category detail
     * table, and the Host `byToolGroup` breakdown.
     * @param {object} props - `{summary, t}`.
     * @returns {object} React element.
     */
    function SourcesTab(props) {
      const summary = props.summary
      const t = props.t
      const categoryEntries = categoryGroupEntries(summary.byCategoryGroup, t)
      return h('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 },
      }, [
        h(StackedBar, {
          key: 'category',
          title: t('chart.category.title'),
          hint: t('chart.category.hint'),
          entries: categoryEntries,
          t,
        }),
        h('section', {
          key: 'categoryDetail',
          'data-dsh-part': 'category-details',
          style: surfaceStyle({ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }),
        }, [
          h(SectionHeading, {
            key: 'head',
            title: t('chart.category.detailTitle'),
            hint: t('chart.category.detailHint'),
          }),
          h(CategoryDetailTable, {
            key: 'detail',
            byCategory: summary.byCategory,
            totalPromptTokens: summary.totals.promptTokens,
            t,
          }),
        ]),
        h(ToolGroupTable, {
          key: 'toolGroups',
          byToolGroup: summary.byToolGroup,
          totalPromptTokens: summary.totals.promptTokens,
          t,
        }),
      ])
    }

    /**
     * Search tab (internally still the `web` tab id): the standalone
     * search/fetch summary card, the full per-session table, and the existing
     * search/fetch accounting footnote.
     * @param {object} props - `{summary, t, sessionTitles, webApiSessions}`.
     * @returns {object} React element.
     */
    function WebTab(props) {
      const summary = props.summary
      const t = props.t
      return h('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 },
      }, [
        h('div', {
          key: 'card',
          style: {
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 10,
          },
        }, h(WebApiSummaryCard, { t, webApi: summary.webApi })),
        h(WebApiSessionTable, {
          key: 'webApiSessions',
          rows: summary.webApi.bySession,
          currency: summary.cost.currency,
          sessionTitles: props.sessionTitles ?? null,
          unattributed: summary.webApi.unattributed,
          open: props.webApiSessions?.open === true,
          onToggle: props.webApiSessions?.onToggle,
          t,
        }),
        h('section', {
          key: 'webApiNote',
          style: surfaceStyle({ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }),
        }, [
          h('h2', {
            key: 'title',
            style: { margin: 0, fontSize: 13, lineHeight: '20px', fontWeight: 500, color: COLORS.text },
          }, t('footnote.title')),
          h('p', {
            key: 'text',
            style: { ...HINT_STYLE, margin: 0 },
          }, t('footnote.webApi')),
        ]),
      ])
    }

    /**
     * Page-internal tab bar.
     *
     * The buttons use `role="tab"` / `aria-selected` and the container scrolls
     * horizontally on narrow widths instead of wrapping or clipping labels.
     * Roving tabindex: ArrowLeft/ArrowRight (wrapping), Home and End move focus
     * and activate the target tab; other keys keep their browser default.
     * @param {object} props - `{t, activeTab, onChange}`.
     * @returns {object} React element.
     */
    function TabBar(props) {
      const t = props.t
      const activeTab = isValidTab(props.activeTab) ? props.activeTab : DEFAULT_TAB
      const onChange = typeof props.onChange === 'function' ? props.onChange : () => {}
      const handleKeyDown = event => {
        if (event === null || typeof event !== 'object') return
        const next = nextTabId(activeTab, event.key, TAB_IDS)
        if (next === null) return
        if (typeof event.preventDefault === 'function') event.preventDefault()
        if (next !== activeTab) onChange(next)
        // Focus the target even before the parent re-renders (the panel is
        // controlled, so this only moves focus; `onChange` owns activation).
        try {
          const owner = event.currentTarget?.ownerDocument
          const target = owner !== null && owner !== undefined && typeof owner.getElementById === 'function'
            ? owner.getElementById(`${NAMESPACE}-tab-${next}`)
            : typeof document !== 'undefined' && document !== null && typeof document.getElementById === 'function'
              ? document.getElementById(`${NAMESPACE}-tab-${next}`)
              : null
          if (target !== null && target !== undefined && typeof target.focus === 'function') target.focus()
        } catch {
          // Focus is best effort; activation already went through onChange.
        }
      }
      return h('div', {
        role: 'tablist',
        'aria-label': t('aria.tabs'),
        'data-dsh-part': 'tab-bar',
        style: {
          display: 'flex',
          alignItems: 'stretch',
          gap: 2,
          minWidth: 0,
          overflowX: 'auto',
          overflowY: 'hidden',
          borderBottom: `0.5px solid ${COLORS.border}`,
          scrollbarWidth: 'thin',
        },
      }, TAB_IDS.map(id => {
        const selected = id === activeTab
        return h('button', {
          key: id,
          type: 'button',
          role: 'tab',
          id: `${NAMESPACE}-tab-${id}`,
          'aria-selected': selected,
          'aria-controls': `${NAMESPACE}-tabpanel-${id}`,
          tabIndex: selected ? 0 : -1,
          'data-dsh-part': 'tab',
          'data-tab': id,
          onClick: () => onChange(id),
          onKeyDown: handleKeyDown,
          style: {
            font: 'inherit',
            fontSize: 13,
            lineHeight: '20px',
            fontWeight: selected ? 600 : 400,
            color: selected ? COLORS.text : COLORS.muted,
            background: 'none',
            border: 'none',
            borderBottom: `2px solid ${selected ? COLORS.brand : 'transparent'}`,
            padding: '8px 12px',
            marginBottom: -1,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            flex: '0 0 auto',
          },
        }, tabLabel(t, id))
      }))
    }

    /**
     * Active tab panel wrapper (`role="tabpanel"` + `aria-labelledby`).
     *
     * Normally an inactive panel unmounts. `keepMounted` keeps it in the tree
     * (hidden + `aria-hidden`) so its local state survives tab switches; the
     * Settings tab uses this after its first visit to preserve unsaved edits.
     * @param {object} props - `{id, activeTab, keepMounted, children}`.
     * @returns {object|null} React element, or null when the tab is not active
     *   and not kept mounted.
     */
    function TabPanel(props) {
      const activeTab = isValidTab(props.activeTab) ? props.activeTab : DEFAULT_TAB
      const active = props.id === activeTab
      const mounted = active || props.keepMounted === true
      if (!mounted) return null
      const hidden = !active
      return h('div', {
        role: 'tabpanel',
        id: `${NAMESPACE}-tabpanel-${props.id}`,
        'aria-labelledby': `${NAMESPACE}-tab-${props.id}`,
        'data-dsh-part': 'tab-panel',
        'data-tab': props.id,
        hidden,
        'aria-hidden': hidden ? 'true' : undefined,
        style: {
          display: hidden ? 'none' : 'flex',
          flexDirection: 'column',
          gap: 16,
          minWidth: 0,
          flex: '1 1 auto',
          minHeight: 0,
        },
      }, props.children)
    }

    /**
     * Range segmented control.
     * @param {object} props - `{range, onChange, t}`.
     * @returns {object} React element.
     */
    function RangeControl(props) {
      return h('div', {
        role: 'group',
        'aria-label': props.t('aria.range'),
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 2,
          padding: 2,
          borderRadius: 'var(--dsw-radius-md, 8px)',
          background: COLORS.surface,
          border: `0.5px solid ${COLORS.border}`,
        },
      }, RANGES.map(range => {
        const active = props.range === range
        return h('button', {
          key: range,
          type: 'button',
          'aria-pressed': active,
          onClick: () => props.onChange(range),
          style: {
            font: 'inherit',
            fontSize: 12,
            lineHeight: '18px',
            color: active ? COLORS.text : COLORS.muted,
            background: active ? COLORS.base : 'none',
            border: active ? `0.5px solid ${COLORS.border}` : '0.5px solid transparent',
            borderRadius: 'var(--dsw-radius-sm, 6px)',
            padding: '4px 9px',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          },
        }, props.t(`range.${range}`))
      }))
    }

    /**
     * Toggle switch.
     * @param {object} props - `{checked, onChange, disabled, label}`.
     * @returns {object} React element.
     */
    function Switch(props) {
      const checked = props.checked === true
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked,
        'aria-label': props.label,
        disabled: props.disabled === true,
        onClick: () => props.onChange(!checked),
        style: {
          position: 'relative',
          width: 36,
          height: 20,
          flex: 'none',
          padding: 0,
          borderRadius: 999,
          border: `0.5px solid ${checked ? COLORS.brand : COLORS.border}`,
          background: checked ? COLORS.brand : COLORS.surfaceAlt,
          cursor: props.disabled === true ? 'not-allowed' : 'pointer',
          opacity: props.disabled === true ? 0.5 : 1,
        },
      }, h('span', {
        'aria-hidden': 'true',
        style: {
          position: 'absolute',
          top: 2,
          left: checked ? 18 : 2,
          width: 14,
          height: 14,
          borderRadius: 999,
          background: COLORS.base,
          transition: 'left 120ms ease',
        },
      }))
    }

    /**
     * Label + restart badge + hint wrapper.
     * @param {object} props - `{t, name, restart, htmlFor, children}`.
     * @returns {object} React element.
     */
    function FieldShell(props) {
      return h('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
      }, [
        h('div', {
          key: 'label-row',
          style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
        }, [
          h('label', {
            key: 'label',
            htmlFor: props.htmlFor,
            style: { fontSize: 12, lineHeight: '18px', fontWeight: 500, color: COLORS.text },
          }, props.label),
          props.restart
            ? h('span', {
              key: 'restart',
              title: props.t('config.restartHint'),
              style: {
                fontSize: 10,
                lineHeight: '14px',
                color: COLORS.warning,
                border: `0.5px solid color-mix(in srgb, ${COLORS.warning} 40%, ${COLORS.border})`,
                borderRadius: 999,
                padding: '0 5px',
                whiteSpace: 'nowrap',
              },
            }, props.t('config.restartBadge'))
            : null,
        ]),
        props.children,
        props.hint
          ? h('p', { key: 'hint', style: { ...HINT_STYLE, margin: 0 } }, props.hint)
          : null,
        props.error
          ? h('p', { key: 'error', role: 'alert', style: { ...ERROR_TEXT_STYLE, margin: 0 } }, props.error)
          : null,
      ])
    }

    /**
     * Number input field.
     * @param {object} props - field props.
     * @returns {object} React element.
     */
    function ConfigNumberField(props) {
      const id = `${NAMESPACE}-${props.name}`
      const rule = NUMERIC_RULES[props.name]
      return h(FieldShell, {
        t: props.t,
        label: configFieldLabel(props.t, props.name),
        hint: configFieldHint(props.t, props.name),
        restart: props.restart,
        error: props.error,
        htmlFor: id,
      }, h('input', {
        id,
        type: 'number',
        min: rule?.min,
        max: rule?.max,
        step: 1,
        value: props.value,
        disabled: props.disabled,
        onChange: event => props.onChange(event.target.value),
        style: INPUT_STYLE,
      }))
    }

    /**
     * Text input field.
     * @param {object} props - field props.
     * @returns {object} React element.
     */
    function ConfigTextField(props) {
      const id = `${NAMESPACE}-${props.name}`
      return h(FieldShell, {
        t: props.t,
        label: configFieldLabel(props.t, props.name),
        hint: configFieldHint(props.t, props.name),
        restart: props.restart,
        error: props.error,
        htmlFor: id,
      }, h('input', {
        id,
        type: 'text',
        value: props.value,
        placeholder: props.placeholder,
        disabled: props.disabled,
        spellCheck: false,
        onChange: event => props.onChange(event.target.value),
        style: INPUT_STYLE,
      }))
    }

    /**
     * One price entry editor.
     * @param {object} props - `{row,index,disabled,t,onChange,onRemove}`.
     * @returns {object} React element.
     */
    function PriceRowEditor(props) {
      const row = props.row
      const index = props.index
      const priceFields = [
        ['inputPerMillion', 'config.pricing.inputPerMillion'],
        ['cacheReadPerMillion', 'config.pricing.cacheReadPerMillion'],
        ['cacheWritePerMillion', 'config.pricing.cacheWritePerMillion'],
        ['outputPerMillion', 'config.pricing.outputPerMillion'],
      ]
      return h('div', {
        style: surfaceStyle({
          padding: '10px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          background: COLORS.base,
        }),
      }, [
        h('div', {
          key: 'head',
          style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
        }, [
          h('span', { key: 'label', style: { fontSize: 12, fontWeight: 500, color: COLORS.text } }, props.t('config.pricing.rowLabel', { index: index + 1 })),
          h('button', {
            key: 'remove',
            type: 'button',
            'aria-label': props.t('config.pricing.remove', { index: index + 1 }),
            disabled: props.disabled,
            onClick: () => props.onRemove(index),
            style: buttonStyle('danger'),
          }, props.t('button.remove')),
        ]),
        h('div', {
          key: 'identity',
          style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1.2fr) minmax(0, 0.7fr)', gap: 8 },
        }, [
          h('label', { key: 'provider', style: { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11, color: COLORS.muted } }, [
            props.t('config.pricing.provider'),
            h('input', {
              type: 'text',
              value: row.provider,
              disabled: props.disabled,
              spellCheck: false,
              onChange: event => props.onChange(index, 'provider', event.target.value),
              style: INPUT_STYLE,
            }),
          ]),
          h('label', { key: 'model', style: { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11, color: COLORS.muted } }, [
            props.t('config.pricing.model'),
            h('input', {
              type: 'text',
              value: row.model,
              disabled: props.disabled,
              spellCheck: false,
              onChange: event => props.onChange(index, 'model', event.target.value),
              style: INPUT_STYLE,
            }),
          ]),
          h('label', { key: 'currency', style: { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11, color: COLORS.muted } }, [
            props.t('config.pricing.currency'),
            h('input', {
              type: 'text',
              value: row.currency,
              disabled: props.disabled,
              spellCheck: false,
              onChange: event => props.onChange(index, 'currency', event.target.value),
              style: INPUT_STYLE,
            }),
          ]),
        ]),
        h('div', {
          key: 'prices',
          style: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 },
        }, [
          ...priceFields.map(([key, labelKey]) => h('label', {
            key,
            style: { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11, color: COLORS.muted },
          }, [
            props.t(labelKey),
            h('input', {
              type: 'text',
              inputMode: 'decimal',
              value: row[key],
              disabled: props.disabled,
              spellCheck: false,
              onChange: event => props.onChange(index, key, event.target.value),
              style: INPUT_STYLE,
            }),
          ])),
          h('label', { key: 'priceVersion', style: { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11, color: COLORS.muted } }, [
            props.t('config.pricing.priceVersion'),
            h('input', {
              type: 'text',
              value: row.priceVersion,
              disabled: props.disabled,
              spellCheck: false,
              onChange: event => props.onChange(index, 'priceVersion', event.target.value),
              style: INPUT_STYLE,
            }),
          ]),
        ]),
        h('div', {
          key: 'offPeak',
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            paddingTop: 8,
            borderTop: `0.5px dashed ${COLORS.border}`,
          },
        }, [
          h('div', {
            key: 'head',
            style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
          }, [
            h('span', { key: 'label', style: { fontSize: 11, fontWeight: 500, color: COLORS.muted } }, props.t('config.pricing.offPeakLabel')),
            h('span', { key: 'hint', style: { ...HINT_STYLE, margin: 0, fontSize: 11 } }, props.t('config.pricing.offPeakHint')),
          ]),
          h('div', {
            key: 'grid',
            style: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 },
          }, OFF_PEAK_PRICE_FIELDS.map(([key]) => h('label', {
            key,
            style: { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11, color: COLORS.muted },
          }, [
            props.t(`config.pricing.${key}`),
            h('input', {
              type: 'text',
              inputMode: 'decimal',
              value: row[key],
              disabled: props.disabled,
              spellCheck: false,
              'data-dsh-part': 'off-peak-price',
              onChange: event => props.onChange(index, key, event.target.value),
              style: INPUT_STYLE,
            }),
          ]))),
        ]),
      ])
    }

    /**
     * Inline configuration tab.
     *
     * M2.6 removed the former right-side slide-over: the same form now renders
     * inside the Settings tab with no overlay/backdrop and no close button.
     * `Cancel` discards unsaved edits in place; `Reload` re-reads the Host.
     * @param {object} props - panel props.
     * @returns {object} React element.
     */
    function ConfigPanel(props) {
      const t = props.t
      const configInfo = props.configInfo
      const [form, setForm] = React.useState(() => formFromConfig(configInfo?.values))
      const [errors, setErrors] = React.useState([])
      const [saving, setSaving] = React.useState(false)
      const [saveError, setSaveError] = React.useState(null)
      const [saved, setSaved] = React.useState(null)
      const [localReadOnly, setLocalReadOnly] = React.useState(false)
      const mountedRef = React.useRef(true)

      React.useEffect(() => () => {
        mountedRef.current = false
      }, [])

      React.useEffect(() => {
        setForm(formFromConfig(configInfo?.values))
        setErrors([])
        if (configInfo?.editable === true) setLocalReadOnly(false)
      }, [configInfo])

      const serverEditable = configInfo?.editable === true
      const editable = serverEditable && !localReadOnly && props.configStatus === 'ready'
      const readOnly = !serverEditable || localReadOnly
      // The Host's descriptor list is authoritative. A pre-M2.6 Host has no
      // rememberLastTab field: hide its switch and never submit the key.
      const rememberLastTabSupported = configFieldSupported(configInfo, 'rememberLastTab')

      /**
       * Update one scalar form field and clear its error.
       * @param {string} name - field name.
       * @param {unknown} value - new value.
       * @returns {void}
       */
      const updateField = (name, value) => {
        const related = name === 'toolGroupsText' ? [name, 'toolGroups'] : [name]
        setForm(current => ({ ...current, [name]: value }))
        setErrors(current => current.filter(error => !related.some(prefix => (
          error.field === prefix || String(error.field).startsWith(`${prefix}.`)
        ))))
        setSaved(null)
      }

      /**
       * Update one price row field.
       * @param {number} index - row index.
       * @param {string} key - row key.
       * @param {unknown} value - new value.
       * @returns {void}
       */
      const updatePrice = (index, key, value) => {
        setForm(current => ({
          ...current,
          pricing: current.pricing.map((row, rowIndex) => (rowIndex === index ? { ...row, [key]: value } : row)),
        }))
        setErrors(current => current.filter(error => !String(error.field).startsWith(`pricing.${index}`)))
        setSaved(null)
      }
      /**
       * Update one Web API pricing form field and clear its structured error.
       * @param {string} name - form field name.
       * @param {string} errorField - Config error path (e.g. `webApiPricing.searchPerThousand`).
       * @param {unknown} value - new value.
       * @returns {void}
       */
      const updateWebApi = (name, errorField, value) => {
        setForm(current => ({ ...current, [name]: value }))
        setErrors(current => current.filter(error => error.field !== errorField))
        setSaved(null)
      }

      /**
       * Append a price row.
       * @returns {void}
       */
      const addPrice = () => {
        setForm(current => ({
          ...current,
          pricing: [...current.pricing, {
            provider: '',
            model: '*',
            currency: current.pricing[0]?.currency || 'CNY',
            inputPerMillion: '0',
            cacheReadPerMillion: '0',
            cacheWritePerMillion: '0',
            outputPerMillion: '0',
            offPeakInputPerMillion: '',
            offPeakCacheReadPerMillion: '',
            offPeakCacheWritePerMillion: '',
            offPeakOutputPerMillion: '',
            priceVersion: '',
          }],
        }))
        setErrors(current => current.filter(error => !String(error.field).startsWith('pricing')))
        setSaved(null)
      }

      /**
       * Remove a price row.
       * @param {number} index - row index.
       * @returns {void}
       */
      const removePrice = index => {
        setForm(current => ({ ...current, pricing: current.pricing.filter((_row, rowIndex) => rowIndex !== index) }))
        setErrors(current => current.filter(error => !String(error.field).startsWith('pricing')))
        setSaved(null)
      }

      /**
       * Save the form through `config.set`.
       * @returns {Promise<void>} completion.
       */
      const save = async () => {
        const built = configPatchFromForm(form, configInfo)
        if (!built.ok) {
          setErrors(built.errors)
          setSaved(null)
          return
        }
        setErrors([])
        setSaving(true)
        setSaveError(null)
        setSaved(null)
        let result
        try {
          result = await props.rpc.call('config.set', { patch: built.patch })
        } catch (error) {
          result = { ok: false, error: { code: 'transport', message: errorMessage(error), details: {} } }
        }
        if (!mountedRef.current) return
        setSaving(false)
        if (!isPlainObject(result)) {
          result = { ok: false, error: { code: 'invalid-response', message: 'config.set returned no envelope', details: {} } }
        }
        if (!result.ok) {
          setSaveError(result.error)
          if (result.error.code === 'config-readonly') setLocalReadOnly(true)
          return
        }
        const value = isPlainObject(result.value) ? result.value : {}
        const restartRequired = Array.isArray(value.restartRequired)
          ? value.restartRequired.filter(field => typeof field === 'string')
          : RESTART_FALLBACK_FIELDS.filter(field => {
            const before = configInfo?.values?.[field]
            const after = built.patch[field]
            return JSON.stringify(before) !== JSON.stringify(after)
          })
        setSaved({ restartRequired })
        if (typeof props.onSaved === 'function') {
          try {
            props.onSaved({ value, patch: built.patch, restartRequired })
          } catch {
            // The save itself succeeded; a parent refresh failure must not mask it.
          }
        }
      }

      const handleReload = async () => {
        setErrors([])
        setSaved(null)
        setSaveError(null)
        if (typeof props.onReload === 'function') {
          try {
            await props.onReload()
          } catch {
            // The parent reports the load failure through configStatus.
          }
        }
      }

      /**
       * Discard unsaved edits (the inline tab's Cancel action).
       * @returns {void}
       */
      const resetForm = () => {
        setForm(formFromConfig(configInfo?.values))
        setErrors([])
        setSaved(null)
        setSaveError(null)
        if (typeof props.onCancel === 'function') {
          try {
            props.onCancel()
          } catch {
            // Cancel is local; a parent hook failure must not mask the reset.
          }
        }
      }

      const restartFor = name => fieldDescriptor(configInfo, name).restartRequired
        || (configInfo?.restartRequiredFields ?? []).includes(name)

      const renderGeneral = () => h('section', {
        key: 'general',
        style: { display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 },
      }, [
        h('h3', { key: 'heading', style: { margin: 0, fontSize: 13, lineHeight: '20px', fontWeight: 600, color: COLORS.text } }, t('config.section.general')),
        h(ConfigTextField, {
          key: 'dataDir',
          name: 'dataDir',
          value: form.dataDir,
          placeholder: t('config.field.dataDirPlaceholder'),
          disabled: !editable,
          restart: restartFor('dataDir'),
          error: findFieldError(errors, 'dataDir') ? validationMessage(t, findFieldError(errors, 'dataDir')) : '',
          t,
          onChange: value => updateField('dataDir', value),
        }),
        h(MigrationStatus, {
          key: 'migration',
          t,
          configInfo,
          meta: props.meta,
          migration: props.migration,
          dataInfo: props.dataInfo,
          dataDir: form.dataDir,
          readOnly: props.dataInfo?.readOnly === true || props.meta?.readOnly === true,
        }),
        h(ConfigTextField, {
          key: 'rpcChannel',
          name: 'rpcChannel',
          value: form.rpcChannel,
          disabled: !editable,
          restart: restartFor('rpcChannel'),
          error: findFieldError(errors, 'rpcChannel') ? validationMessage(t, findFieldError(errors, 'rpcChannel')) : '',
          t,
          onChange: value => updateField('rpcChannel', value),
        }),
        h('div', {
          key: 'autoRefreshRow',
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '10px 12px',
            borderRadius: 'var(--dsw-radius-sm, 8px)',
            border: `0.5px solid ${COLORS.border}`,
            background: COLORS.base,
          },
        }, [
          h('div', { key: 'copy', style: { minWidth: 0 } }, [
            h('div', { key: 'label', style: { fontSize: 12, fontWeight: 500, color: COLORS.text } }, configFieldLabel(t, 'enableAutoRefresh')),
            h('div', { key: 'hint', style: { marginTop: 2, fontSize: 12, lineHeight: '18px', color: COLORS.muted } }, configFieldHint(t, 'enableAutoRefresh')),
          ]),
          h(Switch, {
            key: 'switch',
            checked: form.enableAutoRefresh,
            disabled: !editable,
            label: configFieldLabel(t, 'enableAutoRefresh'),
            onChange: value => updateField('enableAutoRefresh', value),
          }),
        ]),
        rememberLastTabSupported ? h('div', {
          key: 'rememberLastTabRow',
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '10px 12px',
            borderRadius: 'var(--dsw-radius-sm, 8px)',
            border: `0.5px solid ${COLORS.border}`,
            background: COLORS.base,
          },
        }, [
          h('div', { key: 'copy', style: { minWidth: 0 } }, [
            h('div', { key: 'label', style: { fontSize: 12, fontWeight: 500, color: COLORS.text } }, configFieldLabel(t, 'rememberLastTab')),
            h('div', { key: 'hint', style: { marginTop: 2, fontSize: 12, lineHeight: '18px', color: COLORS.muted } }, configFieldHint(t, 'rememberLastTab')),
          ]),
          h(Switch, {
            key: 'switch',
            checked: form.rememberLastTab === true,
            disabled: !editable,
            label: configFieldLabel(t, 'rememberLastTab'),
            onChange: value => updateField('rememberLastTab', value),
          }),
        ]) : null,
        h(ConfigNumberField, {
          key: 'autoRefreshIntervalMs',
          name: 'autoRefreshIntervalMs',
          value: form.autoRefreshIntervalMs,
          disabled: !editable,
          restart: restartFor('autoRefreshIntervalMs'),
          error: findFieldError(errors, 'autoRefreshIntervalMs') ? validationMessage(t, findFieldError(errors, 'autoRefreshIntervalMs')) : '',
          t,
          onChange: value => updateField('autoRefreshIntervalMs', value),
        }),
      ])

      const renderRetention = () => h('section', {
        key: 'retention',
        style: { display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 },
      }, [
        h('h3', { key: 'heading', style: { margin: 0, fontSize: 13, lineHeight: '20px', fontWeight: 600, color: COLORS.text } }, t('config.section.retention')),
        ...['retainRequestDays', 'retainDailyDays', 'flushIntervalMs', 'maxDetailRowsPerDay'].map(name => h(ConfigNumberField, {
          key: name,
          name,
          value: form[name],
          disabled: !editable,
          restart: restartFor(name),
          error: findFieldError(errors, name) ? validationMessage(t, findFieldError(errors, name)) : '',
          t,
          onChange: value => updateField(name, value),
        })),
      ])

      const pricingError = findFieldError(errors, 'pricing')
      const renderPricing = () => h('section', {
        key: 'pricing',
        style: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 },
      }, [
        h(SectionHeading, {
          key: 'heading',
          title: t('config.section.pricing'),
          hint: configFieldHint(t, 'pricing'),
          action: h('button', {
            type: 'button',
            disabled: !editable,
            onClick: addPrice,
            style: buttonStyle('primary'),
          }, t('config.pricing.add')),
        }),
        pricingError
          ? h('p', { key: 'error', role: 'alert', style: { ...ERROR_TEXT_STYLE, margin: 0 } }, validationMessage(t, pricingError))
          : null,
        form.pricing.length === 0
          ? h('p', { key: 'empty', style: { ...HINT_STYLE, margin: 0 } }, t('config.pricing.empty'))
          : h('div', {
            key: 'rows',
            style: { display: 'flex', flexDirection: 'column', gap: 10 },
          }, form.pricing.map((row, index) => h(PriceRowEditor, {
            key: `price-${index}`,
            row,
            index,
            disabled: !editable,
            t,
            onChange: updatePrice,
            onRemove: removePrice,
          }))),
        form.pricing.map((row, index) => {
          const rowErrors = errors.filter(error => String(error.field).startsWith(`pricing.${index}.`))
          if (rowErrors.length === 0) return null
          return h('div', {
            key: `price-errors-${index}`,
            role: 'alert',
            style: { display: 'flex', flexDirection: 'column', gap: 2 },
          }, rowErrors.map(error => h('p', {
            key: error.field,
            style: { ...ERROR_TEXT_STYLE, margin: 0 },
          }, `${t('config.pricing.rowLabel', { index: index + 1 })}: ${validationMessage(t, error)}`)))
        }),
        h(FieldShell, {
          key: 'pricingOffPeakDays',
          t,
          label: configFieldLabel(t, 'pricingOffPeakDays'),
          hint: configFieldHint(t, 'pricingOffPeakDays'),
          error: findFieldError(errors, 'pricingOffPeakDays')
            ? validationMessage(t, findFieldError(errors, 'pricingOffPeakDays'))
            : '',
        }, h('textarea', {
          value: form.pricingOffPeakDays,
          disabled: !editable,
          spellCheck: false,
          rows: 4,
          placeholder: t('config.pricing.offPeakDaysPlaceholder'),
          'data-dsh-part': 'off-peak-days',
          onChange: event => updateField('pricingOffPeakDays', event.target.value),
          style: {
            ...INPUT_STYLE,
            fontFamily: MONO_STACK,
            fontSize: 11,
            lineHeight: '16px',
            resize: 'vertical',
            minHeight: 72,
          },
        })),
      ])

      const webApiSearchError = findFieldError(errors, 'webApiPricing.searchPerThousand')
      const webApiFetchError = findFieldError(errors, 'webApiPricing.fetchPerThousand')
      const webApiCurrencyError = findFieldError(errors, 'webApiPricing.currency')
      const renderWebApi = () => h('section', {
        key: 'webApiPricing',
        style: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 },
      }, [
        h(SectionHeading, {
          key: 'heading',
          title: t('config.section.webApi'),
          hint: t('config.webApiPricing.hint'),
        }),
        h('div', {
          key: 'rates',
          style: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 },
        }, [
          h(FieldShell, {
            key: 'searchPerThousand',
            t,
            label: t('config.webApiPricing.searchPerThousand'),
            htmlFor: `${NAMESPACE}-webApiSearchPerThousand`,
            error: webApiSearchError ? validationMessage(t, webApiSearchError) : '',
          }, h('input', {
            id: `${NAMESPACE}-webApiSearchPerThousand`,
            type: 'number',
            min: 0,
            step: 'any',
            inputMode: 'decimal',
            value: form.webApiSearchPerThousand,
            disabled: !editable,
            onChange: event => updateWebApi('webApiSearchPerThousand', 'webApiPricing.searchPerThousand', event.target.value),
            style: INPUT_STYLE,
          })),
          h(FieldShell, {
            key: 'fetchPerThousand',
            t,
            label: t('config.webApiPricing.fetchPerThousand'),
            htmlFor: `${NAMESPACE}-webApiFetchPerThousand`,
            error: webApiFetchError ? validationMessage(t, webApiFetchError) : '',
          }, h('input', {
            id: `${NAMESPACE}-webApiFetchPerThousand`,
            type: 'number',
            min: 0,
            step: 'any',
            inputMode: 'decimal',
            value: form.webApiFetchPerThousand,
            disabled: !editable,
            onChange: event => updateWebApi('webApiFetchPerThousand', 'webApiPricing.fetchPerThousand', event.target.value),
            style: INPUT_STYLE,
          })),
        ]),
        h(FieldShell, {
          key: 'currency',
          t,
          label: t('config.webApiPricing.currency'),
          hint: t('config.webApiPricing.currencyHint'),
          htmlFor: `${NAMESPACE}-webApiCurrency`,
          error: webApiCurrencyError ? validationMessage(t, webApiCurrencyError) : '',
        }, h('input', {
          id: `${NAMESPACE}-webApiCurrency`,
          type: 'text',
          value: form.webApiCurrency,
          disabled: !editable,
          spellCheck: false,
          onChange: event => updateWebApi('webApiCurrency', 'webApiPricing.currency', event.target.value),
          style: INPUT_STYLE,
        })),
      ])

      const toolGroupsError = findFieldError(errors, 'toolGroups')
      const renderAdvanced = () => h('section', {
        key: 'advanced',
        style: { display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 },
      }, [
        h('h3', { key: 'heading', style: { margin: 0, fontSize: 13, lineHeight: '20px', fontWeight: 600, color: COLORS.text } }, t('config.section.advanced')),
        h(FieldShell, {
          key: 'toolGroups',
          t,
          label: configFieldLabel(t, 'toolGroups'),
          hint: configFieldHint(t, 'toolGroups'),
          restart: restartFor('toolGroups'),
          error: toolGroupsError ? validationMessage(t, toolGroupsError) : '',
        }, h('textarea', {
          value: form.toolGroupsText,
          disabled: !editable,
          spellCheck: false,
          rows: 10,
          onChange: event => updateField('toolGroupsText', event.target.value),
          style: {
            ...INPUT_STYLE,
            fontFamily: MONO_STACK,
            fontSize: 11,
            lineHeight: '16px',
            resize: 'vertical',
            minHeight: 120,
          },
        })),
      ])

      const diagnostics = Array.isArray(configInfo?.diagnostics) ? configInfo.diagnostics : []
      const renderStatus = () => h('section', {
        key: 'status',
        style: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 },
      }, [
        h('h3', { key: 'heading', style: { margin: 0, fontSize: 13, lineHeight: '20px', fontWeight: 600, color: COLORS.text } }, t('config.section.status')),
        h(ConfigMeta, { key: 'meta', t, meta: props.meta, configInfo }),
        h('div', {
          key: 'diagnostics',
          style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
        }, [
          h('div', { key: 'title', style: { fontSize: 12, fontWeight: 500, color: COLORS.text } }, t('config.diagnostics')),
          diagnostics.length === 0
            ? h('p', { key: 'empty', style: { ...HINT_STYLE, margin: 0 } }, t('config.noDiagnostics'))
            : h('ul', {
              key: 'list',
              style: { margin: 0, paddingLeft: 18, color: COLORS.muted, fontSize: 11, lineHeight: '16px' },
            }, diagnostics.map((diagnostic, index) => h('li', {
              key: `diagnostic-${index}`,
              style: { wordBreak: 'break-word' },
            }, diagnostic))),
        ]),
      ])

      const renderBody = () => {
        if (props.configStatus === 'loading' || (props.configStatus === 'idle' && configInfo === null)) {
          return h('p', { key: 'loading', style: { ...HINT_STYLE, padding: '24px 0' } }, t('config.loading'))
        }
        if (props.configStatus === 'error') {
          return h('div', { key: 'error', style: { display: 'flex', flexDirection: 'column', gap: 8 } }, [
            h('p', { key: 'message', style: { ...ERROR_TEXT_STYLE, margin: 0 } }, rpcErrorMessage(t, props.configError)),
            h('p', { key: 'hint', style: { ...HINT_STYLE, margin: 0 } }, t('config.loadError')),
            h('button', { key: 'retry', type: 'button', onClick: handleReload, style: buttonStyle('primary') }, t('config.reload')),
          ])
        }
        return h('div', { key: 'fields', style: { display: 'flex', flexDirection: 'column', gap: 22, minWidth: 0 } }, [
          readOnly
            ? h('div', {
              key: 'readonly',
              role: 'status',
              style: {
                padding: '10px 12px',
                borderRadius: 'var(--dsw-radius-sm, 8px)',
                border: `0.5px solid color-mix(in srgb, ${COLORS.warning} 35%, ${COLORS.border})`,
                background: `color-mix(in srgb, ${COLORS.warning} 8%, ${COLORS.surface})`,
                display: 'flex',
                flexDirection: 'column',
                gap: 3,
              },
            }, [
              h('div', { key: 'title', style: { fontSize: 12, fontWeight: 600, color: COLORS.text } }, t('config.readOnly')),
              h('div', { key: 'hint', style: { fontSize: 12, lineHeight: '18px', color: COLORS.muted } }, t('config.readOnlyHint')),
            ])
            : null,
          renderGeneral(),
          renderRetention(),
          renderPricing(),
          renderWebApi(),
          renderAdvanced(),
          renderStatus(),
        ])
      }

      return h('div', {
        'data-dsh-plugin': 'dsh-token-attribution',
        'data-dsh-part': 'config-panel',
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          width: '100%',
          maxWidth: 920,
          minWidth: 0,
        },
      }, [
        h('header', {
          key: 'header',
          style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
        }, [
          h('h2', { key: 'title', style: { margin: 0, fontSize: 16, lineHeight: '24px', fontWeight: 600, color: COLORS.text } }, t('config.title')),
          h('p', { key: 'subtitle', style: { ...HINT_STYLE, margin: '2px 0 0' } }, t('config.subtitle')),
        ]),
        saveError
          ? h('div', {
            key: 'save-error',
            role: 'alert',
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              padding: '8px 10px',
              borderRadius: 'var(--dsw-radius-sm, 8px)',
              border: `0.5px solid color-mix(in srgb, ${COLORS.danger} 35%, ${COLORS.border})`,
              background: `color-mix(in srgb, ${COLORS.danger} 7%, ${COLORS.surface})`,
            },
          }, [
            h('div', { key: 'title', style: { fontSize: 12, fontWeight: 600, color: COLORS.danger } }, t('config.saveFailed')),
            h('div', { key: 'code', style: { fontSize: 12, lineHeight: '18px', color: COLORS.text } }, rpcErrorMessage(t, saveError)),
            saveError.message
              ? h('code', {
                key: 'message',
                style: { fontFamily: MONO_STACK, fontSize: 11, lineHeight: '16px', color: COLORS.muted, wordBreak: 'break-word' },
              }, String(saveError.message))
              : null,
            Array.isArray(saveError.details?.diagnostics) && saveError.details.diagnostics.length > 0
              ? h('ul', {
                key: 'diagnostics',
                style: { margin: '2px 0 0', paddingLeft: 18, color: COLORS.muted, fontSize: 11, lineHeight: '16px' },
              }, saveError.details.diagnostics.map((diagnostic, index) => h('li', {
                key: `save-diagnostic-${index}`,
              }, typeof diagnostic === 'string' ? diagnostic : JSON.stringify(diagnostic))))
              : null,
          ])
          : null,
        saved
          ? h('div', {
            key: 'saved',
            role: 'status',
            style: {
              padding: '8px 10px',
              borderRadius: 'var(--dsw-radius-sm, 8px)',
              border: `0.5px solid color-mix(in srgb, ${COLORS.success} 35%, ${COLORS.border})`,
              background: `color-mix(in srgb, ${COLORS.success} 8%, ${COLORS.surface})`,
              fontSize: 12,
              lineHeight: '18px',
              color: COLORS.text,
            },
          }, [
            h('div', { key: 'title' }, t('config.saved')),
            saved.restartRequired.length > 0
              ? h('div', {
                key: 'restart',
                style: { marginTop: 2, color: COLORS.warning },
              }, t('config.savedRestart', {
                fields: saved.restartRequired.map(name => configFieldLabel(t, name)).join(', '),
              }))
              : null,
          ])
          : null,
        renderBody(),
        h('footer', {
          key: 'footer',
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 8,
            flexWrap: 'wrap',
            paddingTop: 12,
            borderTop: `0.5px solid ${COLORS.border}`,
          },
        }, [
          h('div', { key: 'spacer', style: { flex: '1 1 auto' } }),
          h('button', {
            key: 'reload',
            type: 'button',
            onClick: handleReload,
            title: t('config.reloadHint'),
            disabled: saving,
            style: buttonStyle('ghost'),
          }, t('config.reload')),
          h('button', {
            key: 'cancel',
            type: 'button',
            onClick: resetForm,
            disabled: saving,
            style: buttonStyle(),
          }, t('config.cancel')),
          h('button', {
            key: 'save',
            type: 'button',
            onClick: save,
            disabled: !editable || saving,
            style: buttonStyle('primary'),
          }, saving ? t('config.saving') : t('config.save')),
        ]),
      ])
    }

    /**
     * Current/target data-directory and migration status.
     * @param {object} props - `{t, meta, migration, dataInfo, dataDir, readOnly, configInfo}`.
     * @returns {object} React element.
     */
    function MigrationStatus(props) {
      const metaMigration = isPlainObject(props.meta?.migration) ? props.meta.migration : null
      const migration = isPlainObject(props.migration) ? props.migration : metaMigration
      const currentRoot = typeof migration?.currentDataDir === 'string'
        ? migration.currentDataDir
        : typeof props.meta?.dataRoot === 'string'
          ? props.meta.dataRoot
          : typeof props.dataInfo?.dataRoot === 'string'
            ? props.dataInfo.dataRoot
            : ''
      const persistedConfigured = typeof migration?.configuredDataDir === 'string'
        ? migration.configuredDataDir
        : ''
      const formDataDir = typeof props.dataDir === 'string' ? props.dataDir.trim() : ''
      // The form is the user's next intent: show it as the target as soon as it
      // differs from the Host's persisted configuration.
      const configuredRoot = formDataDir.length > 0 && !sameDirectoryText(formDataDir, persistedConfigured)
        ? formDataDir
        : persistedConfigured.length > 0
          ? persistedConfigured
          : formDataDir.length > 0
            ? formDataDir
            : currentRoot
      const status = typeof migration?.status === 'string'
        ? migration.status
        : typeof props.meta?.migrationStatus === 'string'
          ? props.meta.migrationStatus
          : typeof props.dataInfo?.migrationStatus === 'string'
            ? props.dataInfo.migrationStatus
            : ''
      const pathsDiffer = currentRoot.length > 0 && configuredRoot.length > 0 && !sameDirectoryText(currentRoot, configuredRoot)
      const pendingSave = formDataDir.length > 0
        && !sameDirectoryText(formDataDir, persistedConfigured)
        && !sameDirectoryText(formDataDir, currentRoot)
      const requires = status === 'requires-migration' || (status === '' && pathsDiffer)
      const failed = status === 'failed'
      const migrating = status === 'migrating'
      const adopted = status === 'adopted'
      const warning = requires || failed || migrating
      const readOnly = props.readOnly === true || props.dataInfo?.readOnly === true || props.meta?.readOnly === true
      const statusText = migrationStatusLabel(props.t, status)
      const error = typeof migration?.error === 'string' ? migration.error : ''
      const tone = warning
        ? `color-mix(in srgb, ${COLORS.warning} 35%, ${COLORS.border})`
        : adopted
          ? `color-mix(in srgb, ${COLORS.success} 35%, ${COLORS.border})`
          : COLORS.border
      const background = warning
        ? `color-mix(in srgb, ${COLORS.warning} 7%, ${COLORS.surface})`
        : adopted
          ? `color-mix(in srgb, ${COLORS.success} 7%, ${COLORS.surface})`
          : COLORS.base
      const messageKey = requires
        ? 'config.migration.warning'
        : failed
          ? 'config.migration.failedHint'
          : migrating
            ? 'config.migration.inProgress'
            : adopted
              ? 'config.migration.adoptedHint'
              : pendingSave
                ? 'config.migration.pendingSave'
                : ''
      return h('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 5,
          padding: '8px 10px',
          borderRadius: 'var(--dsw-radius-sm, 8px)',
          border: `0.5px solid ${tone}`,
          background,
          minWidth: 0,
        },
      }, [
        h('div', { key: 'status', style: { display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 11, lineHeight: '16px', color: COLORS.muted } }, [
          h('span', { key: 'label' }, `${props.t('config.migration.status')}:`),
          h('span', {
            key: 'value',
            style: { color: warning ? COLORS.warning : adopted ? COLORS.success : COLORS.text },
          }, statusText),
        ]),
        h('PathLine', { key: 'current', t: props.t, label: props.t('config.dataDir.current'), value: currentRoot }),
        h('PathLine', { key: 'target', t: props.t, label: props.t('config.dataDir.target'), value: configuredRoot }),
        messageKey !== ''
          ? h('div', { key: 'message', style: { display: 'flex', flexDirection: 'column', gap: 3 } }, [
            h('p', {
              key: 'text',
              style: { ...HINT_STYLE, margin: '2px 0 0', color: warning ? COLORS.warning : COLORS.text },
            }, messageKey === 'config.migration.pendingSave'
              ? props.t(messageKey, { path: configuredRoot })
              : props.t(messageKey)),
            failed && error !== ''
              ? h('code', {
                key: 'error',
                style: {
                  fontFamily: MONO_STACK,
                  fontSize: 11,
                  lineHeight: '16px',
                  color: COLORS.muted,
                  wordBreak: 'break-word',
                },
              }, error)
              : null,
          ])
          : null,
        status === 'ok' || requires
          ? h('p', { key: 'note', style: { ...HINT_STYLE, margin: 0 } }, props.t('config.migration.note'))
          : null,
        readOnly
          ? h('p', { key: 'readonly', style: { ...HINT_STYLE, margin: 0, color: COLORS.warning } }, props.t('config.migration.readOnly'))
          : null,
      ])
    }

    /**
     * One label/value path line.
     * @param {object} props - `{t,label,value}`.
     * @returns {object} React element.
     */
    function PathLine(props) {
      return h('div', {
        style: { display: 'flex', gap: 8, minWidth: 0, fontSize: 11, lineHeight: '16px' },
      }, [
        h('span', { key: 'label', style: { flex: 'none', color: COLORS.muted } }, `${props.label}:`),
        h('code', {
          key: 'value',
          style: {
            fontFamily: MONO_STACK,
            color: COLORS.text,
            wordBreak: 'break-all',
            minWidth: 0,
          },
        }, props.value || '—'),
      ])
    }

    /**
     * Small config/meta summary.
     * @param {object} props - `{t, meta, configInfo}`.
     * @returns {object} React element.
     */
    function ConfigMeta(props) {
      const meta = isPlainObject(props.meta) ? props.meta : {}
      const values = isPlainObject(props.configInfo?.values) ? props.configInfo.values : {}
      const rows = [
        ['version', meta.version ?? '—'],
        ['dataRoot', meta.dataRoot ?? '—'],
        ['profile', meta.profile ?? '—'],
        ['pointer', meta.pointerStatus ?? '—'],
        ['readOnly', meta.readOnly === true ? props.t('config.value.yes') : props.t('config.value.no')],
        ['since', formatDate(meta.since ?? values.since)],
        ['flush', formatTime(meta.lastFlush)],
      ]
      return h('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
          gap: '4px 12px',
          fontSize: 11,
          lineHeight: '16px',
          color: COLORS.muted,
        },
      }, rows.map(([key, value]) => h('div', {
        key,
        style: { display: 'flex', gap: 6, minWidth: 0 },
      }, [
        h('span', { key: 'label', style: { flex: 'none' } }, `${props.t(`config.meta.${key}`)}:`),
        h('span', {
          key: 'value',
          style: {
            color: COLORS.text,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          },
          title: String(value),
        }, String(value)),
      ])))
    }

    /** Stand-in `useSessions` for test renders that omit the standard prop. */
    const NOOP_USE_SESSIONS = selector => selector(null)

    /**
     * The full-width usage panel.
     *
     * M2.6 turns the former single page into one sidebar entry with seven
     * page-internal tabs. The range/refresh/export controls and the tab bar are
     * shared; each tab renders only its own data views. The gear switches to
     * the inline Settings tab. Config is read once on mount (it also decides
     * whether the active tab may be restored from browser storage). Settings
     * stays mounted after its first visit so unsaved edits survive tab switches.
     *
     * M3 adds the in-place session drill-down: only the Sessions tab renders
     * `SessionDetailView` (replacing the tree) while `drill.sessionId` is set;
     * the selection lives outside the tab state, so switching tabs keeps it.
     * @param {object} props - slot props plus injected services; headless tests
     *   may pass `initialTab`, `initialSettingsVisited`, `initialSummary` and
     *   `initialDrill` to seed state without running effects.
     * @returns {object} React element.
     */
    function UsagePanel(props) {
      const localeRuntime = props.localeRuntime
      const rpc = props.rpc
      // Standard root-scope framework prop: a selector hook over the session
      // list. It feeds render-time titles only — never the ledger or an RPC
      // payload. Call it unconditionally so the hook order is stable; the
      // mounted main slot always supplies it, and the no-op covers unit renders.
      const useSessions = typeof props.useSessions === 'function' ? props.useSessions : NOOP_USE_SESSIONS
      const sessionsById = useSessions(state => state && state.byId)
      const localeSnapshot = useLocaleSnapshot(localeRuntime)
      const t = React.useMemo(
        () => createTranslator(localeRuntime, localeSnapshot?.active),
        [localeRuntime, localeSnapshot?.active],
      )
      const [range, setRange] = React.useState('today')
      const [activeTab, setActiveTab] = React.useState(() => (isValidTab(props.initialTab) ? props.initialTab : DEFAULT_TAB))
      // Settings keeps its form mounted after the first visit so unsaved edits
      // survive switching to another tab. `initialSettingsVisited` lets a
      // headless render start from the post-first-visit state.
      const [settingsVisited, setSettingsVisited] = React.useState(() => (
        props.initialSettingsVisited === true
        || (isValidTab(props.initialTab) && props.initialTab === SETTINGS_TAB)
      ))
      // Headless tests can seed the panel with a summary/drill so the render
      // tree is observable without running effects (same escape hatch as
      // `initialTab` / `initialSettingsVisited`).
      const initialSummary = React.useMemo(
        () => (isPlainObject(props.initialSummary) ? normalizeSummary(props.initialSummary) : null),
        [props.initialSummary],
      )
      const [summary, setSummary] = React.useState(initialSummary)
      const [status, setStatus] = React.useState(() => (
        initialSummary === null ? 'loading' : initialSummary.totals.requests > 0 ? 'ready' : 'empty'
      ))
      const [error, setError] = React.useState(null)
      const [refreshError, setRefreshError] = React.useState(null)
      const [refreshing, setRefreshing] = React.useState(false)
      const [updatedAt, setUpdatedAt] = React.useState(0)
      const [configInfo, setConfigInfo] = React.useState(null)
      const [configStatus, setConfigStatus] = React.useState('idle')
      const [configError, setConfigError] = React.useState(null)
      const [meta, setMeta] = React.useState(null)
      const [migration, setMigration] = React.useState(null)
      const [runtimeConfig, setRuntimeConfig] = React.useState(null)
      const [exporting, setExporting] = React.useState(null)
      const [exportStatus, setExportStatus] = React.useState(null)
      const [webApiSessionsOpen, setWebApiSessionsOpen] = React.useState(false)
      const [sessionExpanded, setSessionExpanded] = React.useState({})
      const [details, setDetails] = React.useState(createDetailsState)
      const [detailsNonce, setDetailsNonce] = React.useState(0)
      // M3 in-place drill-down. It is deliberately independent of `activeTab`,
      // so switching to another main tab and back preserves the selection.
      const [drill, setDrill] = React.useState(() => initialDrillState(props.initialDrill))
      const mountedRef = React.useRef(true)
      const requestRef = React.useRef(0)
      const detailsRef = React.useRef(0)
      const drillRef = React.useRef(0)
      const hasDataRef = React.useRef(initialSummary !== null)
      const tabPolicyRef = React.useRef({ resolved: false })
      const tabTouchedRef = React.useRef(false)

      React.useEffect(() => () => {
        mountedRef.current = false
      }, [])

      const refresh = React.useCallback(async (nextRange = 'today', quiet = false) => {
        if (!mountedRef.current) return
        const requestId = requestRef.current + 1
        requestRef.current = requestId
        if (!quiet) setRefreshing(true)
        let result
        try {
          result = await rpc.call('summary', { range: nextRange })
        } catch (caught) {
          result = { ok: false, error: { code: 'transport', message: errorMessage(caught), details: {} } }
        }
        if (!mountedRef.current) return
        if (requestRef.current !== requestId) {
          if (!quiet) setRefreshing(false)
          return
        }
        if (!result.ok) {
          if (hasDataRef.current) {
            setRefreshError(result.error)
          } else {
            setError(result.error)
            setStatus('error')
          }
          if (!quiet) setRefreshing(false)
          return
        }
        let normalized
        try {
          normalized = normalizeSummary(result.value)
        } catch {
          normalized = normalizeSummary(null)
        }
        hasDataRef.current = true
        setSummary(normalized)
        setError(null)
        setRefreshError(null)
        setUpdatedAt(Date.now())
        setStatus(normalized.totals.requests > 0 ? 'ready' : 'empty')
        if (!quiet) setRefreshing(false)
      }, [rpc])

      /**
       * Fetch one session drill-down through the M3 `sessionDetail` endpoint.
       *
       * The named range (not `from|to`) is sent, so a range change can refetch
       * immediately without waiting for the summary to resolve. A request-id
       * ref drops stale responses; a Host error clears the selection (the pane
       * returns to the tree and keeps `lastSessionId` for the retry warning).
       * @param {string} sessionId - selected session id.
       * @param {boolean} includeDescendants - subtree toggle state.
       * @param {string} rangeValue - named range.
       * @returns {Promise<void>} completion.
       */
      const fetchSessionDetail = React.useCallback(async (sessionId, includeDescendants, rangeValue) => {
        if (!mountedRef.current || typeof sessionId !== 'string' || sessionId === '') return
        const requestId = drillRef.current + 1
        drillRef.current = requestId
        setDrill(current => drillReducer(current, { type: 'refresh' }))
        let result
        try {
          result = await rpc.call('sessionDetail', sessionDetailPayload(rangeValue, {
            sessionId,
            includeDescendants,
          }))
        } catch (caught) {
          result = { ok: false, error: { code: 'transport', message: errorMessage(caught), details: {} } }
        }
        if (!mountedRef.current || drillRef.current !== requestId) return
        if (!isPlainObject(result) || result.ok !== true) {
          const failure = isPlainObject(result) && isPlainObject(result.error)
            ? result.error
            : { code: 'invalid-response', message: '', details: {} }
          setDrill(current => drillReducer(current, { type: 'error', error: failure }))
          return
        }
        let normalized
        try {
          normalized = normalizeSessionDetail(result.value)
        } catch {
          normalized = normalizeSessionDetail(null)
        }
        if (normalized.sessionId === '') normalized = { ...normalized, sessionId }
        setDrill(current => drillReducer(current, { type: 'loaded', data: normalized }))
      }, [rpc])

      /**
       * Open (or navigate to) a session detail. From the tree the default is
       * subtree mode; navigating inside the drill keeps the user's toggle.
       * @param {string} sessionId - session to show.
       * @returns {void}
       */
      const openSessionDetail = React.useCallback(sessionId => {
        if (typeof sessionId !== 'string' || sessionId === '') return
        const includeDescendants = drill.sessionId !== null ? drill.includeDescendants : true
        setDrill(current => drillReducer(current, { type: 'open', sessionId, includeDescendants }))
        fetchSessionDetail(sessionId, includeDescendants, range).catch(() => {})
      }, [drill.sessionId, drill.includeDescendants, range, fetchSessionDetail])

      /**
       * Back: clear the selection (and any pending response) and show the tree.
       * @returns {void}
       */
      const closeSessionDetail = React.useCallback(() => {
        drillRef.current += 1
        setDrill(current => drillReducer(current, { type: 'close' }))
      }, [])

      /**
       * Flip the subtree scope and refetch with the new `includeDescendants`.
       * @param {boolean} includeDescendants - next toggle state.
       * @returns {void}
       */
      const toggleSessionDescendants = React.useCallback(includeDescendants => {
        if (drill.sessionId === null) return
        const next = includeDescendants === true
        setDrill(current => drillReducer(current, { type: 'toggle', includeDescendants: next }))
        fetchSessionDetail(drill.sessionId, next, range).catch(() => {})
      }, [drill.sessionId, range, fetchSessionDetail])

      const loadConfig = React.useCallback(async (options = {}) => {
        const quiet = options.quiet === true
        if (!quiet) setConfigStatus('loading')
        try {
          const [configResult, metaResult, migrationResult] = await Promise.all([
            rpc.call('config.get', {}),
            rpc.call('meta', {}),
            rpc.call('migration.status', {}),
          ])
          if (!mountedRef.current) return
          if (configResult.ok) {
            const info = normalizeConfigInfo(configResult.value)
            setConfigInfo(info)
            setRuntimeConfig(info.values)
            setConfigStatus('ready')
            setConfigError(null)
            if (typeof info.values.rpcChannel === 'string'
              && typeof rpc?.getChannel === 'function'
              && rpc.getChannel() !== info.values.rpcChannel) {
              // The Host may still be serving the old channel until a restart;
              // remember the configured one so the next page load can reach it.
              writeStoredChannel(info.values.rpcChannel)
            }
          } else {
            setConfigError(configResult.error)
            setConfigStatus('error')
          }
          if (metaResult.ok) setMeta(isPlainObject(metaResult.value) ? metaResult.value : null)
          if (migrationResult.ok) setMigration(isPlainObject(migrationResult.value) ? migrationResult.value : null)
        } catch (caught) {
          if (!mountedRef.current) return
          setConfigError({ code: 'transport', message: errorMessage(caught), details: {} })
          setConfigStatus('error')
        }
      }, [rpc])

      React.useEffect(() => {
        loadConfig({ quiet: true }).catch(() => {})
      }, [loadConfig])

      React.useEffect(() => {
        refresh(range).catch(() => {})
      }, [range, refresh])

      // Resolve the remembered tab exactly once, when the Config read settles.
      // A failed/unavailable Config read therefore leaves the default Overview.
      React.useEffect(() => {
        if (tabPolicyRef.current.resolved) return
        if (configStatus !== 'ready' && configStatus !== 'error') return
        tabPolicyRef.current.resolved = true
        if (tabTouchedRef.current) return
        const remember = configInfo?.values?.rememberLastTab === true
        // Read browser storage only when the Config flag is on.
        const stored = remember ? readStoredTab() : ''
        const resolvedTab = resolveInitialTab(remember, stored)
        if (resolvedTab === SETTINGS_TAB) setSettingsVisited(true)
        setActiveTab(resolvedTab)
      }, [configStatus, configInfo])

      const drillSessionId = drill.sessionId
      const drillIncludeDescendants = drill.includeDescendants
      React.useEffect(() => {
        if (!mountedRef.current) return
        if (runtimeConfig === null || runtimeConfig.enableAutoRefresh !== true) return undefined
        const interval = clamp(Math.trunc(numberOr(runtimeConfig.autoRefreshIntervalMs, 30000)), 1000, 3600000)
        const timer = setInterval(() => {
          refresh(range, true).catch(() => {})
          // Keep an open drill-down in sync with the same auto-refresh tick.
          if (drillSessionId !== null) {
            fetchSessionDetail(drillSessionId, drillIncludeDescendants, range).catch(() => {})
          }
        }, interval)
        return () => clearInterval(timer)
      }, [runtimeConfig, range, refresh, drillSessionId, drillIncludeDescendants, fetchSessionDetail])

      // Details pagination. The Host resolves named ranges to concrete bounds,
      // so `from|to` is the page's window identity: a same-key auto-refresh
      // keeps a partially-loaded page, while a changed key (for example an
      // auto-refresh crossing midnight) resets it before the next load. The
      // reset effect runs first, and the loader refuses to fire while a
      // range-key mismatch is still pending, so page 2 of the new window can
      // never be appended to page N of the old one.
      const detailsRangeKey = summary === null ? '' : detailsRangeKeyFromRange(summary.range)
      React.useEffect(() => {
        if (activeTab !== 'details' || summary === null) return
        setDetails(current => (
          detailsRangeChanged(current, detailsRangeKey)
            ? detailsReducer(current, { type: 'range', rangeKey: detailsRangeKey })
            : current
        ))
      }, [activeTab, detailsRangeKey, summary])
      React.useEffect(() => {
        if (activeTab !== 'details') return undefined
        if (summary === null) return undefined
        if (detailsRangeChanged(details, detailsRangeKey)) return undefined
        const requestId = detailsRef.current + 1
        detailsRef.current = requestId
        const offset = details.offset
        setDetails(current => detailsReducer(current, { type: 'load' }))
        let cancelled = false
        const load = async () => {
          let result
          try {
            result = await rpc.call('requests', detailsRequestPayload(summary.range, {
              limit: DETAILS_PAGE_SIZE,
              offset,
              purpose: details.purpose,
              sessionId: details.sessionId,
              unpricedOnly: details.unpricedOnly,
            }))
          } catch (caught) {
            result = { ok: false, error: { code: 'transport', message: errorMessage(caught), details: {} } }
          }
          if (cancelled || !mountedRef.current || detailsRef.current !== requestId) return
          if (!result.ok) {
            setDetails(current => detailsReducer(current, { type: 'error', error: result.error }))
            return
          }
          const page = normalizeRequests(result.value, offset)
          setDetails(current => detailsReducer(current, { type: 'loaded', items: page.items, total: page.total }))
        }
        load()
        return () => {
          cancelled = true
        }
      }, [activeTab, detailsRangeKey, details.rangeKey, details.purpose, details.sessionId, details.unpricedOnly, details.offset, detailsNonce, rpc])

      const switchTab = React.useCallback(next => {
        if (!isValidTab(next) || next === activeTab) return
        tabTouchedRef.current = true
        if (activeTab === 'details' && next !== 'details') {
          // Re-entering Details starts from the first page again.
          setDetails(current => detailsReducer(current, { type: 'range' }))
        }
        if (next === SETTINGS_TAB) setSettingsVisited(true)
        setActiveTab(next)
        if (configInfo?.values?.rememberLastTab === true) writeStoredTab(next)
        if (next === SETTINGS_TAB && configStatus === 'error') {
          loadConfig({ quiet: false }).catch(() => {})
        }
      }, [activeTab, configInfo, configStatus, loadConfig])

      const selectRange = nextRange => {
        if (nextRange === range) return
        // An open drill-down follows the range change immediately: the
        // `sessionDetail` payload carries the named range, so no summary round
        // trip is needed before refetching.
        const activeSessionId = drill.sessionId
        const activeIncludeDescendants = drill.includeDescendants
        setRange(nextRange)
        setSummary(null)
        setStatus('loading')
        setError(null)
        setRefreshError(null)
        setUpdatedAt(0)
        setExportStatus(null)
        setDetails(current => detailsReducer(current, { type: 'range' }))
        setSessionExpanded({})
        hasDataRef.current = false
        if (activeSessionId !== null) {
          setDrill(current => drillReducer(current, { type: 'range', rangeKey: '' }))
          fetchSessionDetail(activeSessionId, activeIncludeDescendants, nextRange).catch(() => {})
        } else if (drill.error !== null) {
          // A stale drill-failure banner does not survive a range switch.
          setDrill(current => drillReducer(current, { type: 'close' }))
        }
      }

      /**
       * Explicit refresh: keep the Details pane on its first page so the user
       * sees the new rows instead of a stale later page. The nonce is needed
       * even when the offset is already 0, otherwise the page would stay in its
       * loading state because no dependency changed.
       * @returns {void}
       */
      const refreshNow = () => {
        if (activeTab === 'details') {
          setDetails(current => detailsReducer(current, { type: 'range' }))
          setDetailsNonce(nonce => nonce + 1)
        }
        refresh(range).catch(() => {})
        if (drill.sessionId !== null) {
          fetchSessionDetail(drill.sessionId, drill.includeDescendants, range).catch(() => {})
        }
      }

      const handleConfigSaved = payload => {
        const value = isPlainObject(payload?.value) ? payload.value : {}
        const values = isPlainObject(value.values) ? value.values : null
        if (values !== null) {
          const info = normalizeConfigInfo({ ...(configInfo ?? {}), values, diagnostics: [] })
          setConfigInfo(info)
          setRuntimeConfig(info.values)
          if (info.values.rememberLastTab === true) writeStoredTab(activeTab)
        }
        if (isPlainObject(payload?.patch) && typeof payload.patch.rpcChannel === 'string'
          && typeof rpc?.setChannel === 'function') {
          rpc.setChannel(payload.patch.rpcChannel)
        }
        // Saving reconfigures the Host entry (the plugin reloads), so the meta /
        // migration / summary reads may briefly lag. Refresh once the reload has
        // settled instead of asking the user to press Reload manually.
        globalThis.setTimeout(() => {
          if (!mountedRef.current) return
          loadConfig({ quiet: true }).catch(() => {})
          refresh(range, true).catch(() => {})
        }, 1200)
      }

      /**
       * Export the current range through the Host and save it in the browser.
       * @param {'json'|'csv'} format - export format.
       * @returns {Promise<void>} completion; failures are reported inline.
       */
      const runExport = async format => {
        const resolved = normalizeExportFormat(format)
        setExporting(resolved)
        setExportStatus(null)
        let result
        try {
          result = await rpc.call('export', exportRequestPayload(range, resolved))
        } catch (error) {
          result = { ok: false, error: { code: 'transport', message: errorMessage(error), details: {} } }
        }
        if (!mountedRef.current) return
        setExporting(null)
        if (!isPlainObject(result) || result.ok !== true) {
          const failure = isPlainObject(result) && isPlainObject(result.error)
            ? result.error
            : { code: 'invalid-response', message: '', details: {} }
          setExportStatus({ kind: 'error', error: failure })
          return
        }
        const saved = saveExportFile(result.value)
        if (!saved.ok) {
          setExportStatus({ kind: 'error', downloadCode: saved.code })
          return
        }
        setExportStatus({
          kind: saved.truncated ? 'truncated' : 'saved',
          filename: saved.filename,
          bytes: saved.bytes,
        })
      }

      const readOnly = summary?.data?.readOnly === true || meta?.readOnly === true
      const channel = typeof rpc?.getChannel === 'function' ? rpc.getChannel() : DEFAULT_CHANNEL
      const activeConfig = runtimeConfig ?? configInfo?.values ?? null
      const autoRefresh = activeConfig?.enableAutoRefresh === true
      const exportText = exportStatusText(t, exportStatus)
      // Settings renders in its own wrapper below so it stays mounted after
      // the first visit (unsaved edits survive tab switches). The element is
      // created here so the active/hidden wrappers share one child identity.
      const settingsContent = h(ConfigPanel, {
        key: 'settings',
        t,
        rpc,
        configInfo,
        configStatus,
        configError,
        meta,
        migration,
        dataInfo: summary?.data ?? null,
        onReload: () => loadConfig({ quiet: false }),
        onSaved: handleConfigSaved,
      })
      const settingsMounted = settingsVisited || activeTab === SETTINGS_TAB

      let content = null
      if (activeTab === SETTINGS_TAB) {
        // Rendered by the always-keyed Settings wrapper next to the active
        // tab panel; moving it between wrappers would remount ConfigPanel.
        content = null
      } else if (status === 'loading' && summary === null) {
        content = h(LoadingState, { key: 'loading', t })
      } else if (status === 'error' && summary === null) {
        content = h(ErrorState, {
          key: 'error',
          t,
          error: error ?? { code: 'unknown', message: '' },
          onRetry: () => refresh(range),
        })
      } else if (status === 'empty' && summary !== null) {
        content = h('div', { key: 'empty', style: { display: 'flex', flexDirection: 'column', gap: 16 } }, [
          h(EmptyState, { key: 'empty', t, onRetry: () => refresh(range) }),
          activeTab === 'overview' ? h(Footnote, { key: 'footnote', summary, meta, t, channel }) : null,
        ])
      } else if (summary !== null) {
        const sessionTitles = sessionsById ?? null
        if (activeTab === 'sessions') {
          if (drill.sessionId !== null) {
            // In-place drill-down: replaces the tree instead of opening a new
            // tab/route. Back (or a failed fetch) returns to the tree.
            content = h(SessionDetailView, {
              key: 'session-detail',
              state: drill,
              t,
              rpc,
              range: summary.range,
              sessionTitles,
              breadcrumb: sessionBreadcrumb(summary.bySession, drill.sessionId),
              onBack: closeSessionDetail,
              onNavigate: openSessionDetail,
              onToggleDescendants: toggleSessionDescendants,
              onRetry: () => {
                if (drill.lastSessionId !== '') openSessionDetail(drill.lastSessionId)
              },
            })
          } else {
            content = h(SessionsTab, {
              key: 'sessions',
              summary,
              t,
              sessionTitles,
              onOpen: openSessionDetail,
              drillError: drill.error,
              onRetryDrill: () => {
                if (drill.lastSessionId !== '') openSessionDetail(drill.lastSessionId)
              },
              session: {
                expanded: sessionExpanded,
                onToggle: key => setSessionExpanded(current => {
                  const next = { ...current }
                  if (next[key] === true) delete next[key]
                  else next[key] = true
                  return next
                }),
              },
              webApiSessions: {
                open: webApiSessionsOpen,
                onToggle: () => setWebApiSessionsOpen(open => !open),
              },
            })
          }
        } else if (activeTab === 'models') {
          content = h(ModelsTab, { key: 'models', summary, t })
        } else if (activeTab === 'sources') {
          content = h(SourcesTab, { key: 'sources', summary, t })
        } else if (activeTab === 'web') {
          content = h(WebTab, {
            key: 'web',
            summary,
            t,
            sessionTitles,
            webApiSessions: {
              open: webApiSessionsOpen,
              onToggle: () => setWebApiSessionsOpen(open => !open),
            },
          })
        } else if (activeTab === 'details') {
          content = h(DetailsTab, {
            key: 'details',
            t,
            state: details,
            sessions: summary.bySession,
            sessionTitles,
            limit: DETAILS_PAGE_SIZE,
            onPurposeChange: value => setDetails(current => detailsReducer(current, { type: 'filters', purpose: value })),
            onSessionChange: value => setDetails(current => detailsReducer(current, { type: 'filters', sessionId: value })),
          onUnpricedChange: value => setDetails(current => detailsReducer(current, { type: 'filters', unpricedOnly: value === true })),
            onLoadMore: () => setDetails(current => detailsReducer(current, { type: 'more' })),
            onRetry: () => setDetailsNonce(nonce => nonce + 1),
          })
        } else {
          content = h(OverviewTab, {
            key: 'overview',
            summary,
            meta,
            t,
            channel,
            sessionTitles,
          })
        }
      } else {
        content = h(LoadingState, { key: 'loading-fallback', t })
      }

      return h('div', {
        'data-dsh-plugin': 'dsh-token-attribution',
        'data-dsh-part': 'usage-panel',
        role: 'region',
        'aria-label': t('aria.panel'),
        style: {
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          height: '100%',
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          background: COLORS.base,
          color: COLORS.text,
          fontFamily: FONT_STACK,
          boxSizing: 'border-box',
        },
      }, [
        h('div', {
          key: 'drag-band',
          'data-window-drag': true,
          'aria-hidden': 'true',
          style: { height: 'var(--dsh-frame-top-clearance, 0px)', flex: '0 0 auto' },
        }),
        h('header', {
          key: 'header',
          style: {
            position: 'sticky',
            top: 0,
            zIndex: 3,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            padding: '14px 24px 0',
            background: COLORS.base,
            borderBottom: `0.5px solid ${COLORS.border}`,
            boxSizing: 'border-box',
          },
        }, [
          h('div', {
            key: 'top',
            style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
          }, [
            h('div', { key: 'title', style: { minWidth: 0 } }, [
              h('h1', {
                style: { margin: 0, fontSize: 20, lineHeight: '28px', fontWeight: 600, color: COLORS.text },
              }, t('panel.title')),
              h('p', { style: { margin: '2px 0 0', fontSize: 12, lineHeight: '18px', color: COLORS.muted } }, t('panel.subtitle')),
            ]),
            h('div', {
              key: 'actions',
              style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 },
            }, [
              h(RangeControl, { key: 'range', range, onChange: selectRange, t }),
              h('button', {
                key: 'export-json',
                type: 'button',
                title: t('export.json'),
                'aria-label': t('export.json'),
                'data-dsh-part': 'export-json',
                disabled: exporting !== null,
                onClick: () => runExport('json'),
                style: buttonStyle(),
              }, exporting === 'json' ? t('export.busy', { format: 'JSON' }) : t('export.json')),
              h('button', {
                key: 'export-csv',
                type: 'button',
                title: t('export.csv'),
                'aria-label': t('export.csv'),
                'data-dsh-part': 'export-csv',
                disabled: exporting !== null,
                onClick: () => runExport('csv'),
                style: buttonStyle(),
              }, exporting === 'csv' ? t('export.busy', { format: 'CSV' }) : t('export.csv')),
              h('button', {
                key: 'refresh',
                type: 'button',
                'aria-label': t('aria.refresh'),
                'data-dsh-part': 'refresh-button',
                onClick: refreshNow,
                disabled: refreshing,
                style: buttonStyle(),
              }, [
                h(RefreshIcon, { key: 'icon', size: 14 }),
                h('span', { key: 'label' }, refreshing ? t('panel.refreshing') : t('panel.refresh')),
              ]),
              h('button', {
                key: 'settings',
                type: 'button',
                'aria-label': t('aria.settings'),
                title: t('panel.settings'),
                'data-dsh-part': 'settings-button',
                'data-tab-target': SETTINGS_TAB,
                'aria-pressed': activeTab === SETTINGS_TAB,
                onClick: () => switchTab(SETTINGS_TAB),
                style: activeTab === SETTINGS_TAB ? buttonStyle('primary') : buttonStyle(),
              }, [
                h(GearIcon, { key: 'icon', size: 15 }),
                h('span', { key: 'label' }, t('panel.settings')),
              ]),
            ]),
          ]),
          h(TabBar, {
            key: 'tabs',
            t,
            activeTab,
            onChange: switchTab,
          }),
          h('div', {
            key: 'status-line',
            style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', minHeight: 18, paddingBottom: 10 },
          }, [
            h('span', { key: 'updated', style: { fontSize: 11, lineHeight: '16px', color: COLORS.muted } }, updatedAt > 0
              ? t('panel.updatedAt', { time: formatTime(updatedAt) })
              : t('panel.neverUpdated')),
            h('span', { key: 'auto', style: { fontSize: 11, lineHeight: '16px', color: COLORS.muted } }, autoRefresh
              ? t('panel.autoRefreshOn')
              : t('panel.autoRefreshOff')),
            readOnly
              ? h('span', {
                key: 'readonly',
                style: {
                  fontSize: 11,
                  lineHeight: '16px',
                  color: COLORS.warning,
                  border: `0.5px solid color-mix(in srgb, ${COLORS.warning} 35%, ${COLORS.border})`,
                  borderRadius: 999,
                  padding: '0 6px',
                },
              }, t('panel.readOnly'))
              : null,
            exportText !== ''
              ? h('span', {
                key: 'export-status',
                role: 'status',
                'data-dsh-part': 'export-status',
                style: {
                  fontSize: 11,
                  lineHeight: '16px',
                  color: exportStatus?.kind === 'error'
                    ? COLORS.danger
                    : exportStatus?.kind === 'truncated' ? COLORS.warning : COLORS.success,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                },
              }, exportText)
              : null,
            refreshError
              ? h(RefreshWarning, {
                key: 'refresh-error',
                t,
                error: refreshError,
                onRetry: refreshNow,
              })
              : null,
          ]),
        ]),
        h('div', {
          key: 'content',
          style: {
            flex: '1 1 auto',
            minHeight: 0,
            padding: '20px 24px 40px',
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          },
        }, [
          activeTab === SETTINGS_TAB
            ? null
            : h(TabPanel, { key: 'active', id: activeTab, activeTab, t }, content),
          settingsMounted
            ? h(TabPanel, {
              key: 'settings',
              id: SETTINGS_TAB,
              activeTab,
              t,
              keepMounted: true,
            }, settingsContent)
            : null,
        ].filter(child => child !== null)),
      ])
    }

    /**
     * Client plugin entry.
     * @param {object} ctx - Cordis client context.
     * @returns {void}
     */
    function apply(ctx) {
      if (ctx === null || typeof ctx !== 'object') return
      const connection = ctx.connection
      const rpc = createRpc(connection)
      const localeRuntime = ctx.locale

      // Register the namespace before any slot label uses it. The effect owns
      // the dictionary so unloading the plugin removes it with the slots.
      const registerLocale = () => {
        if (localeRuntime !== null && typeof localeRuntime === 'object' && typeof localeRuntime.register === 'function') {
          return localeRuntime.register(NAMESPACE, LOCALE)
        }
        return undefined
      }
      try {
        if (typeof ctx.effect === 'function') {
          ctx.effect(registerLocale, 'dsh-token-attribution: locale dictionary')
        } else {
          registerLocale()
        }
      } catch {
        // A locale registration failure must not keep the panel from mounting.
      }

      const slotLabel = () => {
        try {
          return createTranslator(localeRuntime)('panel.title')
        } catch {
          return LOCALE.en['panel.title']
        }
      }

      const disposeSlots = ctx.slots.inject('main', () => ctx.slots.inject('sidebar.panellist', () => {        let stopMain
        let stopIcon
        try {
          stopMain = ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
            inject: () => ({
              rpc,
              localeRuntime,
              panelId: PANEL_ID,
            }),
          }, UsagePanel)
          stopIcon = ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: PANEL_ORDER,
            label: slotLabel,
            locale: NAMESPACE,
          }, UsageIcon)
        } catch (error) {
          safeDispose(stopIcon)
          safeDispose(stopMain)
          throw error
        }
        return () => {
          safeDispose(stopIcon)
          safeDispose(stopMain)
        }
      }))
      return disposeSlots
    }

    /**
     * Dispose one registration without letting its failure mask another.
     * @param {unknown} dispose - disposer.
     * @returns {void}
     */
    function safeDispose(dispose) {
      if (typeof dispose !== 'function') return
      try {
        dispose()
      } catch {
        // A stale registration is already gone.
      }
    }

    return {
      inject: ['slots', 'connection', 'locale'],
      apply,
      __test: {
        PANEL_ID,
        NAMESPACE,
        DEFAULT_CHANNEL,
        PANEL_ORDER,
        tabIds: TAB_IDS,
        defaultTab: DEFAULT_TAB,
        tabStorageKey: TAB_STORAGE_KEY,
        detailsPageSize: DETAILS_PAGE_SIZE,
        locales: LOCALE,
        configFieldOrder: CONFIG_FIELD_ORDER,
        defaultWebApiPricing: DEFAULT_WEB_API_PRICING,
        numericRules: NUMERIC_RULES,
        isValidTab,
        readStoredTab,
        writeStoredTab,
        resolveInitialTab,
        tabLabel,
        nextTabId,
        formatTokens,
        formatCompactTokens,
        formatPercent,
        formatCurrency,
        formatTime,
        formatDate,
        formatDayLabel,
        formatCostCell,
        formatCurrencyBreakdown,
        shortId,
        sessionDisplayName,
        interpolate,
        buildStackedSegments,
        buildTrendPoints,
        buildSessionTree,
        sessionTreeRows,
        subtreeStats,
        sessionCacheRate,
        categoryGroup,
        categoryGroupEntries,
        categoryGroupLabel,
        groupCategoryTokens,
        normalizeToolGroupMap,
        toolGroupLabel,
        toolGroupRows,
        tokenCell,
        exportRequestPayload,
        exportFilename,
        saveExportFile,
        exportStatusText,
        normalizeRequests,
        detailsRequestPayload,
        sessionFilterOptions,
        createDetailsState,
        detailsReducer,
        detailsRangeKeyFromRange,
        detailsRangeChanged,
        normalizeSessionRow,
        normalizeSessionIdList,
        normalizeSessionDetail,
        webApiForSessions,
        sessionDetailEmpty,
        createDrillState,
        drillReducer,
        initialDrillState,
        sessionDetailPayload,
        sessionRequestsPayload,
        sessionBreadcrumb,
        summaryCardModels,
        normalizeDays,
        normalizeWebApi,
        normalizeWebApiSessions,
        normalizeWebApiUnattributed,
        rangeEndDay,
        groupTop,
        seriesColor,
        purposeLabel,
        categoryLabel,
        categoryTableRows,
        migrationStatusLabel,
        sameDirectoryText,
        configFieldLabel,
        validateAdvancedJson,
        validateToolGroups,
        isAbsolutePath,
        configFieldSupported,
        configPatchFromForm,
        formFromConfig,
        normalizeOffPeakDays,
        normalizeSummary,
        normalizeConfigInfo,
        normalizeFieldDescriptors,
        unwrapRpc,
        createRpc,
        createTranslator,
        components: {
          UsagePanel,
          ConfigPanel,
          TabBar,
          TabPanel,
          OverviewTab,
          SessionsTab,
          ModelsTab,
          SourcesTab,
          WebTab,
          DetailsTab,
          SessionDetailView,
          SessionRequestTable,
          SessionRequestsSection,
          ModelsTable,
          WebApiSummaryCard,
          StackedBar,
          CategoryDetailTable,
          SessionTreeTable,
          WebApiSessionTable,
          ToolGroupTable,
          TrendChart,
          DataTable,
          Footnote,
          MigrationStatus,
        },
      },
    }
  },
})
