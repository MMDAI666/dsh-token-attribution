/**
 * Request attribution: turn one observed model call into a persisted
 * `RequestRecord`.
 *
 * The provider `usage` is authoritative; category splits are `char-v1`
 * estimates normalized so their integer sum equals `promptTokens`. Records
 * contain no prompt, tool, result, or system-prompt text — only numbers,
 * category names, hashes, and identity fields.
 *
 * @module dsh-token-attribution/host/attribute
 */

import {
  BLOCK_OVERHEAD,
  ESTIMATOR_VERSION,
  ROLE_OVERHEAD,
  distributeTotal,
  estimateBlock,
  estimateStructuralBlock,
  estimateSystemText,
  estimateTextTokens,
  estimateToolSchemas,
  normalizeToTotal,
  systemTextOf,
} from './estimate.mjs'
import { sourceCategory, systemSectionCategory, toolGroup } from './rules.mjs'
import { getService, nowMs, round, safeStringify, sha1 } from './util.mjs'

/** Category used when no component estimate exists but the provider reported tokens. */
const FALLBACK_CATEGORY = 'unknown'

/**
 * Normalize a declared purpose; an absent purpose is the ordinary conversation.
 * @param {unknown} purpose - `GenerateOptions.purpose`.
 * @returns {string} `chat` or the declared purpose.
 */
export function normalizePurpose(purpose) {
  return typeof purpose === 'string' && purpose.length > 0 ? purpose : 'chat'
}

/**
 * Coerce one provider token count to a non-negative integer.
 * @param {unknown} value - raw token count.
 * @returns {number} safe token count.
 */
function tokenCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

/**
 * Project the provider's tool declarations from `options.tools` and
 * `options.toolHistory` following `projectToolUpdates` semantics:
 * `history.tools` plus `updates[].additions` with `deferLoading: true`; then
 * `in-history` keeps the full series, `addition-only` filters by the active
 * names in `options.tools`, and an unknown mode declares `options.tools`
 * without deferred-loading marks.
 *
 * The mode is normally resolved once per provider/model from
 * `ctx.llm.resolveModelInfo(...).toolUpdate` and cached by the collector. When
 * it is unavailable (first call, resolve failure, or a fake/test context) the
 * estimator falls back to `options.tools`: that list never under-declares the
 * current request, at the cost of omitting historical declarations.
 *
 * @param {object} options - `GenerateOptions` of the observed call.
 * @param {'in-history'|'addition-only'|undefined|null} [toolUpdate] - resolved route mode.
 * @returns {{tools: object[], mode: 'in-history'|'addition-only'|'direct'}} projected declarations.
 */
export function resolveToolDeclarations(options, toolUpdate) {
  const tools = Array.isArray(options?.tools) ? options.tools : []
  if (toolUpdate !== 'in-history' && toolUpdate !== 'addition-only') {
    const immediate = tools.some(tool => tool?.deferLoading === true)
    return {
      tools: immediate ? tools.map(({ deferLoading: _deferLoading, ...tool }) => tool) : tools,
      mode: 'direct',
    }
  }
  const history = options?.toolHistory
  if (history === undefined || history === null || !Array.isArray(history.tools)) {
    return { tools, mode: 'direct' }
  }
  const messages = Array.isArray(options?.messages) ? options.messages : []
  const developerIds = new Set(messages.filter(message => message?.role === 'developer').map(message => message.id))
  const updates = Array.isArray(history.updates) ? history.updates : []
  if (updates.some(update => !developerIds.has(update?.messageId))) {
    // An auxiliary prefix may omit developer updates needed to activate
    // historical declarations; projectToolUpdates falls back to current tools.
    return { tools, mode: 'direct' }
  }
  const declarations = new Map(history.tools.map(tool => [tool.name, tool]))
  for (const update of updates) {
    for (const tool of Array.isArray(update?.additions) ? update.additions : []) {
      if (!declarations.has(tool.name)) declarations.set(tool.name, { ...tool, deferLoading: true })
    }
  }
  if (toolUpdate === 'addition-only') {
    const activeNames = new Set(tools.map(tool => tool.name))
    for (const name of [...declarations.keys()]) {
      if (!activeNames.has(name)) declarations.delete(name)
    }
  }
  return { tools: [...declarations.values()], mode: toolUpdate }
}

/**
 * Resolve the configured price entry for one provider/model route.
 * Exact model ids win, then a `prefix*` model entry, then the `*` wildcard.
 * @param {object[]} pricing - normalized price table.
 * @param {string} provider - provider route.
 * @param {string} model - model id.
 * @returns {object | undefined} matching entry.
 */
export function lookupPrice(pricing, provider, model) {
  if (!Array.isArray(pricing)) return undefined
  let best
  let bestScore = -1
  for (const entry of pricing) {
    if (entry === null || typeof entry !== 'object') continue
    if (entry.provider !== provider) continue
    const declared = typeof entry.model === 'string' && entry.model.length > 0 ? entry.model : '*'
    let score = -1
    if (declared === model) score = 3
    else if (declared === '*') score = 1
    else if (declared.endsWith('*') && model.startsWith(declared.slice(0, -1))) score = 2
    if (score < 0) continue
    if (score >= bestScore) {
      best = entry
      bestScore = score
    }
  }
  return best
}

/** Fixed UTC+8 offset of Asia/Shanghai (Beijing time has no DST). */
const BEIJING_OFFSET_MS = 8 * 3600_000

/**
 * Peak windows as Beijing minutes-of-day, half-open `[start, end)`: 09:00-12:00
 * and 14:00-18:00 on weekdays.
 */
const PEAK_WINDOWS_MINUTES = Object.freeze([[9 * 60, 12 * 60], [14 * 60, 18 * 60]])

/**
 * Beijing-local calendar day key for a date already shifted by +8h and read
 * with UTC getters.
 * @param {Date} shifted - `new Date(ts + BEIJING_OFFSET_MS)`.
 * @returns {string} `YYYY-MM-DD` Beijing day key.
 */
function beijingDayKey(shifted) {
  const year = String(shifted.getUTCFullYear()).padStart(4, '0')
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Time-of-day price tier for one instant under the DeepSeek official rule.
 *
 * Peak is Beijing time (Asia/Shanghai, fixed UTC+8 without DST), Monday-Friday,
 * inside `[09:00, 12:00)` or `[14:00, 18:00)`. All other instants are off-peak:
 * nights, weekends, and any date present in `offPeakDays` (Chinese statutory
 * holidays etc.). An invalid or non-finite timestamp is priced as peak, the
 * conservative choice, so a corrupt record can never under-report cost.
 * @param {unknown} ts - record epoch milliseconds.
 * @param {unknown} offPeakDays - extra all-day off-peak `YYYY-MM-DD` dates (Asia/Shanghai).
 * @returns {'peak'|'off-peak'} price tier.
 */
export function pricingTier(ts, offPeakDays) {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return 'peak'
  const shifted = new Date(ts + BEIJING_OFFSET_MS)
  if (Number.isNaN(shifted.getTime())) return 'peak'
  if (Array.isArray(offPeakDays) && offPeakDays.includes(beijingDayKey(shifted))) return 'off-peak'
  const weekday = shifted.getUTCDay()
  if (weekday === 0 || weekday === 6) return 'off-peak'
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
  for (const [start, end] of PEAK_WINDOWS_MINUTES) {
    if (minutes >= start && minutes < end) return 'peak'
  }
  return 'off-peak'
}

/**
 * Resolve one token price for the selected tier.
 *
 * Peak uses the entry's top-level price. Off-peak uses the matching `offPeak`
 * override when it is a finite non-negative number, otherwise it falls back to
 * the peak value (so a partial `offPeak` object only overrides what it names).
 * @param {object} entry - price entry.
 * @param {'inputPerMillion'|'cacheReadPerMillion'|'cacheWritePerMillion'|'outputPerMillion'} key - price field.
 * @param {'peak'|'off-peak'} tier - selected tier.
 * @returns {unknown} price per 1M tokens.
 */
function tierPrice(entry, key, tier) {
  const peak = entry[key]
  if (tier !== 'off-peak') return peak
  const offPeak = entry.offPeak
  if (offPeak === null || typeof offPeak !== 'object' || Array.isArray(offPeak)) return peak
  const value = offPeak[key]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : peak
}

/**
 * Compute the record cost from the configured price table.
 * @param {{pricing: object[], provider: string, model: string, usage: {input: number, cacheRead: number, cacheWrite: number, output: number} | null, ts?: number, offPeakDays?: string[]}} input - pricing inputs.
 * @returns {{amount: number, priced: boolean, currency: string, priceVersion: string, tier: 'peak'|'off-peak'}} cost block.
 */
export function computeCost({ pricing, provider, model, usage, ts, offPeakDays }) {
  const tier = pricingTier(ts, offPeakDays)
  const entry = lookupPrice(pricing, provider, model)
  const currency = typeof entry?.currency === 'string' && entry.currency.length > 0 ? entry.currency : 'CNY'
  if (entry === undefined || usage === null || usage === undefined) {
    return { amount: 0, priced: false, currency, priceVersion: 'none', tier }
  }
  const cost = (tokens, price) => (typeof price === 'number' && Number.isFinite(price) ? tokens * price / 1_000_000 : 0)
  const amount = cost(usage.input, tierPrice(entry, 'inputPerMillion', tier))
    + cost(usage.cacheRead, tierPrice(entry, 'cacheReadPerMillion', tier))
    + cost(usage.cacheWrite, tierPrice(entry, 'cacheWritePerMillion', tier))
    + cost(usage.output, tierPrice(entry, 'outputPerMillion', tier))
  return {
    amount: round(amount, 6),
    priced: true,
    currency,
    priceVersion: typeof entry.priceVersion === 'string' ? entry.priceVersion : 'configured',
    tier,
  }
}

/**
 * Extract the finish kind from a terminal `finish` chunk.
 * @param {object | null} finish - finish chunk.
 * @returns {string} finish kind (`unknown` when absent).
 */
export function finishKind(finish) {
  const reason = finish?.reason
  if (reason !== null && typeof reason === 'object' && typeof reason.kind === 'string') return reason.kind
  if (typeof finish?.kind === 'string') return finish.kind
  return 'unknown'
}

/**
 * Resolve the route's image pricing lazily; missing or throwing pricing keeps
 * the structural fallback.
 * @param {object} ctx - Cordis context (may be a test double).
 * @param {string} provider - provider route.
 * @param {string} model - model id.
 * @returns {{priceImages: (images: object[]) => object[]} | undefined} route pricing.
 */
function resolveImagePricing(ctx, provider, model) {
  try {
    const llm = getService(ctx, 'llm')
    if (llm === null || typeof llm !== 'object' || typeof llm.imageRequestPricing !== 'function') return undefined
    const pricing = llm.imageRequestPricing(provider, model)
    return pricing !== null && typeof pricing === 'object' && typeof pricing.priceImages === 'function'
      ? pricing
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Build a system-node match function from an assembler cache or a single
 * pre-matched snapshot.
 * @param {object | undefined} assembleSnapshot - cache (`matchSystemText`) or one snapshot.
 * @param {string} [assembleKey] - session key for the cache.
 * @returns {((text: string) => {snapshot: object, match: string} | undefined) | undefined} matcher.
 */
function resolveAssembleMatcher(assembleSnapshot, assembleKey) {
  if (assembleSnapshot !== null && typeof assembleSnapshot === 'object'
    && typeof assembleSnapshot.matchSystemText === 'function') {
    return (text) => {
      try {
        return assembleSnapshot.matchSystemText(assembleKey, text)
      } catch {
        return undefined
      }
    }
  }
  if (assembleSnapshot !== null && typeof assembleSnapshot === 'object' && Array.isArray(assembleSnapshot.sections)) {
    return () => ({ snapshot: assembleSnapshot, match: 'provided' })
  }
  return undefined
}

/**
 * Attribute all system-role messages of one request.
 *
 * The newest hash-matched system node is `active` and contributes named section
 * categories; every other system node is `superseded` (older) or `unknown`
 * (unmatched). A matched node's section estimates are integer-normalized to the
 * message's own estimate so sections and node totals agree.
 *
 * @param {object[]} messages - system-role messages in request order.
 * @param {((text: string) => {snapshot: object, match: string} | undefined) | undefined} matcher - snapshot matcher.
 * @param {(category: string, tokens: number) => void} add - category accumulator.
 * @returns {object[]} `systemNodes` entries.
 */
function attributeSystemNodes(messages, matcher, add) {
  const entries = messages.map((message) => {
    const text = systemTextOf(message)
    if (text.length === 0) return { text, hash: sha1(''), match: undefined }
    let match
    if (matcher !== undefined) {
      try {
        match = matcher(text)
      } catch {
        match = undefined
      }
    }
    return { text, hash: sha1(text), match }
  })
  let activeIndex = -1
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].match !== undefined && entries[index].text.length > 0) {
      activeIndex = index
      break
    }
  }
  const nodes = []
  entries.forEach((entry, index) => {
    if (entry.text.length === 0) {
      nodes.push({ hash: entry.hash, match: 'unknown', sections: {} })
      return
    }
    const estimate = estimateSystemText(entry.text)
    if (index === activeIndex) {
      const sectionList = Array.isArray(entry.match?.snapshot?.sections) ? entry.match.snapshot.sections : []
      const weighted = sectionList
        .filter(section => Number.isFinite(section?.est) && section.est > 0)
        .map(section => ({ name: String(section.name ?? 'unknown'), weight: section.est }))
      const distributed = distributeTotal(weighted, estimate)
      const sections = {}
      for (const [name, tokens] of Object.entries(distributed)) {
        if (tokens <= 0) continue
        sections[name] = tokens
        add(systemSectionCategory(name), tokens)
      }
      if (Object.keys(sections).length === 0) {
        add('system:unknown', estimate)
        nodes.push({ hash: entry.hash, match: 'unknown', sections: {} })
        return
      }
      nodes.push({ hash: entry.hash, match: 'active', sections })
      return
    }
    const older = activeIndex >= 0 ? index < activeIndex : index < entries.length - 1
    if (older) {
      add('system:superseded', estimate)
      nodes.push({ hash: entry.hash, match: 'superseded', sections: {} })
    } else {
      add('system:unknown', estimate)
      nodes.push({ hash: entry.hash, match: 'unknown', sections: {} })
    }
  })
  return nodes
}

/**
 * Build one `RequestRecord` for an observed model call.
 *
 * @param {object} input - observation inputs.
 * @param {object} input.options - frozen `GenerateOptions` of the call.
 * @param {object | null} input.usage - provider `TokenUsage`, or null when the stream emitted none.
 * @param {object | null} input.finish - terminal `finish` chunk.
 * @param {number} input.startedAt - stream start epoch milliseconds.
 * @param {number} input.endedAt - stream end epoch milliseconds.
 * @param {object} [input.assembleSnapshot] - assembler cache (with `matchSystemText`) or one snapshot.
 * @param {string} [input.assembleKey] - session key used with the assembler cache.
 * @param {object | null} [input.sessionHeader] - live session header snapshot.
 * @param {object} input.config - normalized plugin config.
 * @param {object} input.ctx - Cordis context (for image/file pricing services).
 * @param {number} input.counter - process-local monotonic request sequence.
 * @param {number} [input.attemptIndex] - attempt number within a retry run (default 1).
 * @param {'in-history'|'addition-only'|undefined|null} [input.toolUpdate] - resolved route tool-update mode.
 * @returns {object} v1 request record.
 */
export function buildRecord({
  options,
  usage,
  finish,
  startedAt,
  endedAt,
  assembleSnapshot,
  assembleKey,
  sessionHeader,
  config,
  ctx,
  counter,
  attemptIndex = 1,
  toolUpdate,
}) {
  const request = options !== null && typeof options === 'object' ? options : {}
  const ended = Number.isFinite(endedAt) ? endedAt : nowMs()
  const started = Number.isFinite(startedAt) ? startedAt : ended
  const purpose = normalizePurpose(request.purpose)
  const sessionId = typeof request.sessionId === 'string' && request.sessionId.length > 0
    ? request.sessionId
    : (typeof sessionHeader?.id === 'string' ? sessionHeader.id : null)
  const provider = typeof request.provider === 'string' && request.provider.length > 0 ? request.provider : 'unknown'
  const model = typeof request.model === 'string' && request.model.length > 0 ? request.model : 'unknown'
  const messages = Array.isArray(request.messages) ? request.messages : []

  const buckets = usage !== null && typeof usage === 'object'
    ? {
      input: tokenCount(usage.inputTokens),
      cacheRead: tokenCount(usage.cacheReadTokens),
      cacheWrite: tokenCount(usage.cacheWriteTokens),
      output: tokenCount(usage.outputTokens),
      reasoning: tokenCount(usage.reasoningTokens),
    }
    : null
  // PLAN 6.2 treats an empty usage report like a missing one: a terminal chunk
  // whose four disjoint buckets are all zero carries no measured tokens (aborted
  // or otherwise empty call), so the estimate-filled path applies.
  const hasMeasuredTokens = buckets !== null
    && buckets.input + buckets.cacheRead + buckets.cacheWrite + buckets.output > 0
  const measured = hasMeasuredTokens ? buckets : null

  /** @type {Map<string, number>} */
  const categoryMap = new Map()
  const add = (category, tokens) => {
    if (!Number.isFinite(tokens) || tokens <= 0) return
    categoryMap.set(category, (categoryMap.get(category) ?? 0) + tokens)
  }

  const images = { count: 0, visualTokens: 0, textTokens: 0 }
  let files = 0
  const imagePricing = resolveImagePricing(ctx, provider, model)
  const llm = getService(ctx, 'llm')
  const fileRequestText = llm !== null && typeof llm === 'object' && typeof llm.fileRequestText === 'function'
    ? llm.fileRequestText.bind(llm)
    : undefined

  /**
   * Price one image occurrence, counting it even when route pricing fails.
   * @param {object} block - image block.
   * @returns {number} estimated tokens for the occurrence.
   */
  const priceImageBlock = (block) => {
    images.count += 1
    if (imagePricing !== undefined) {
      try {
        const answer = imagePricing.priceImages([block])
        const first = Array.isArray(answer) ? answer[0] : undefined
        if (first !== null && typeof first === 'object' && Number.isFinite(first.visualTokens)) {
          const textTokens = estimateTextTokens(first.text ?? '')
          images.visualTokens += Math.max(0, first.visualTokens)
          images.textTokens += textTokens
          return Math.max(0, first.visualTokens) + textTokens + BLOCK_OVERHEAD
        }
      } catch {
        // Route pricing failures keep the structural fallback.
      }
    }
    return estimateStructuralBlock(block)
  }

  /**
   * Price one file occurrence, counting it even when the handle text is unavailable.
   * @param {object} block - file block.
   * @returns {number} estimated tokens for the occurrence.
   */
  const priceFileBlock = (block) => {
    files += 1
    if (fileRequestText !== undefined) {
      try {
        const text = fileRequestText(block.attachment)
        if (typeof text === 'string') return estimateTextTokens(text) + BLOCK_OVERHEAD
      } catch {
        // Missing route support keeps the structural fallback.
      }
    }
    return estimateStructuralBlock(block)
  }

  const systemMessages = messages.filter(message => message?.role === 'system')
  const nonSystemMessages = messages.filter(message => message?.role !== 'system')

  // The route projection decides whether developer messages reach the provider:
  // `projectToolUpdates` strips every developer message for routes without a
  // mid-conversation tool-update mode. Attribution mirrors that projection so
  // stripped developer content is never counted as model-visible tokens.
  const declarations = resolveToolDeclarations(request, toolUpdate)
  const developerMessagesVisible = declarations.mode !== 'direct'

  // Tool-call ids let tool-role messages resolve their tool group without the log.
  const toolNamesByCallId = new Map()
  for (const message of nonSystemMessages) {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block?.type === 'tool-call' && typeof block.id === 'string' && typeof block.name === 'string') {
        toolNamesByCallId.set(block.id, block.name)
      }
    }
  }

  // Hand-built calls (auto-review, session-title, translation) use options.system.
  if (typeof request.system === 'string' && request.system.length > 0) {
    add(`system:${purpose}`, estimateSystemText(request.system))
  }

  const matcher = resolveAssembleMatcher(assembleSnapshot, assembleKey)
  const systemNodes = attributeSystemNodes(systemMessages, matcher, add)

  for (const message of nonSystemMessages) {
    const role = message?.role
    const content = Array.isArray(message.content) ? message.content : []
    if (role === 'assistant') {
      let firstCategory = 'assistant-text'
      let assigned = false
      for (const block of content) {
        if (block === null || typeof block !== 'object') continue
        let category
        let tokens
        if (block.type === 'text') {
          category = 'assistant-text'
          tokens = estimateBlock(block)
        } else if (block.type === 'reasoning') {
          category = 'reasoning-replay'
          tokens = estimateBlock(block)
        } else if (block.type === 'tool-call') {
          category = 'tool-call-args'
          tokens = estimateBlock(block)
        } else if (block.type === 'image') {
          category = 'injected:image'
          tokens = priceImageBlock(block)
        } else if (block.type === 'file') {
          category = 'injected:file'
          tokens = priceFileBlock(block)
        } else {
          category = 'assistant-other'
          tokens = estimateStructuralBlock(block)
        }
        add(category, tokens)
        if (!assigned) {
          firstCategory = category
          assigned = true
        }
      }
      add(firstCategory, ROLE_OVERHEAD)
      continue
    }
    if (role === 'tool') {
      const callId = message.source?.callId ?? message.toolCallId
      const toolName = callId === undefined ? undefined : toolNamesByCallId.get(String(callId))
      const category = `tool-result:${toolName === undefined ? 'unknown' : toolGroup(toolName, config)}`
      let tokens = ROLE_OVERHEAD
      for (const block of content) {
        if (block?.type === 'image') add('injected:image', priceImageBlock(block))
        else if (block?.type === 'file') add('injected:file', priceFileBlock(block))
        else tokens += estimateBlock(block)
      }
      add(category, tokens)
      continue
    }
    if (role === 'developer') {
      if (!developerMessagesVisible) continue
      let tokens = ROLE_OVERHEAD
      for (const block of content) {
        if (block?.type === 'tool-addition' || block?.type === 'tool-removal') {
          add('tools:history', estimateStructuralBlock(block))
        } else if (block?.type === 'image') {
          add('injected:image', priceImageBlock(block))
        } else if (block?.type === 'file') {
          add('injected:file', priceFileBlock(block))
        } else {
          tokens += estimateBlock(block)
        }
      }
      add('developer-message', tokens)
      continue
    }
    if (role === 'user') {
      const declaredCategory = sourceCategory(message.source)
      // Auto-review hands the whole conversation to the reviewer model as one
      // synthetic user-role message with no human/injected source. Counting it
      // as real `user` input made a tool transcript dominate that category:
      // live data put 211M of 220M user-category tokens there, and 98.55% of
      // each auto-review prompt was this transcript. Its own source group keeps
      // human chat distinguishable from the auto-review replay.
      const category = purpose === 'auto-review' && declaredCategory === 'user'
        ? 'injected:auto-review'
        : declaredCategory
      let tokens = ROLE_OVERHEAD
      for (const block of content) {
        if (block?.type === 'image') add('injected:image', priceImageBlock(block))
        else if (block?.type === 'file') add('injected:file', priceFileBlock(block))
        else tokens += estimateBlock(block)
      }
      add(category, tokens)
      continue
    }
    // Unknown merge-extended role: keep its estimate attributable, never dropped.
    add(`injected:role-${String(role ?? 'unknown')}`, estimateBlock({ type: 'text', text: safeStringify(message) }))
  }

  if (declarations.tools.length > 0) {
    const declarationTotal = estimateToolSchemas(declarations.tools)
    const byGroup = new Map()
    for (const tool of declarations.tools) {
      const group = toolGroup(tool.name, config)
      const weight = Math.max(1, estimateStructuralBlock(tool))
      byGroup.set(group, (byGroup.get(group) ?? 0) + weight)
    }
    const distributed = distributeTotal(
      [...byGroup].map(([group, weight]) => ({ name: `tools:${group}`, weight })),
      declarationTotal,
    )
    for (const [category, tokens] of Object.entries(distributed)) add(category, tokens)
  }

  const rawCategories = Object.fromEntries(categoryMap)
  const rawSum = Object.values(rawCategories).reduce((sum, value) => sum + value, 0)
  const promptTokens = measured === null
    ? Math.round(rawSum)
    : measured.input + measured.cacheRead + measured.cacheWrite
  const outputTokens = measured === null ? 0 : measured.output

  const normalized = normalizeToTotal(rawCategories, promptTokens)
  const categories = normalized.categories
  let categorySum = Object.values(categories).reduce((sum, value) => sum + value, 0)
  if (categorySum !== promptTokens) {
    // Repair an extreme rounding case so the invariant below always holds.
    if (promptTokens > 0) {
      categories[FALLBACK_CATEGORY] = (categories[FALLBACK_CATEGORY] ?? 0) + (promptTokens - categorySum)
    } else {
      for (const key of Object.keys(categories)) delete categories[key]
    }
    for (const key of Object.keys(categories)) {
      if (categories[key] <= 0) delete categories[key]
    }
    categorySum = Object.values(categories).reduce((sum, value) => sum + value, 0)
  }
  if (categorySum !== promptTokens) {
    throw new Error(`category normalization invariant violated: ${categorySum} !== ${promptTokens}`)
  }

  const kind = finishKind(finish)
  const failure = finish?.reason?.failure
  const error = kind === 'error' || kind === 'aborted'
    ? {
      code: typeof failure?.code === 'string' ? failure.code : 'unknown',
      ...typeof failure?.status === 'number' ? { status: failure.status } : {},
    }
    : null

  const attemptError = kind === 'error' || kind === 'aborted' || kind === 'unknown'
  const cost = computeCost({
    pricing: config?.pricing,
    provider,
    model,
    usage: measured,
    ts: ended,
    offPeakDays: config?.pricingOffPeakDays,
  })

  return {
    v: 1,
    ts: ended,
    id: sha1([sessionId ?? '-', ended, counter ?? 0, purpose].join('|')),
    sessionId,
    parentSessionId: typeof sessionHeader?.parentSession === 'string' ? sessionHeader.parentSession : null,
    delegationDepth: Number.isInteger(sessionHeader?.delegationDepth) ? sessionHeader.delegationDepth : 0,
    origin: typeof sessionHeader?.origin === 'string' ? sessionHeader.origin : null,
    preset: typeof sessionHeader?.agentPreset === 'string' ? sessionHeader.agentPreset : null,
    purpose,
    provider,
    model,
    reasoningEffort: typeof request.reasoningEffort === 'string' ? request.reasoningEffort : null,
    attempt: { index: Number.isInteger(attemptIndex) && attemptIndex > 0 ? attemptIndex : 1, retryId: null, error: attemptError },
    usage: measured,
    usageEstimated: measured === null,
    promptTokens,
    outputTokens,
    estimatedPromptTokens: Math.round(rawSum),
    estimateScale: round(normalized.scale, 4),
    estimatorVersion: ESTIMATOR_VERSION,
    systemNodes,
    categories,
    images,
    files,
    cost,
    finish: kind,
    durationMs: Math.max(0, ended - started),
    error,
  }
}
