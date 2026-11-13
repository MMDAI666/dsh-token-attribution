/**
 * `char-v1` token estimation.
 *
 * Mirrors the host token-meter's structural overheads (per-block 4, per-role 4)
 * but prices text by character class instead of a fixed 4 chars/token:
 * ASCII 0.275 tok/char, non-ASCII 0.9 tok/char. Every number here is an
 * estimate used to split an authoritative `usage` total, never a token count
 * claimed as measured.
 *
 * @module dsh-token-attribution/host/estimate
 */

import {
  ASCII_TOKENS_PER_CHAR,
  NON_ASCII_TOKENS_PER_CHAR,
  estimateChars,
  safeStringify,
  splitChars,
} from './util.mjs'

/** Estimator revision stamped into every record so mixed estimates stay auditable. */
export const ESTIMATOR_VERSION = 'char-v1'

/** Per-block structural overhead for JSON framing and type tags (token-meter parity). */
export const BLOCK_OVERHEAD = 4

/** Role-field framing overhead added to every non-system message (token-meter parity). */
export const ROLE_OVERHEAD = 4

/**
 * Ceiling of the character-weighted estimate.
 * @param {unknown} text - text to price.
 * @returns {number} whole estimated tokens.
 */
export function estimateTextTokens(text) {
  return Math.ceil(estimateChars(text))
}

/**
 * Strip the `offloaded` display mark so image reference pricing matches the
 * token meter's structural fallback.
 * @param {object} block - image block.
 * @returns {object} reference-only block.
 */
function imageReference(block) {
  const { offloaded: _offloaded, ...reference } = block
  return reference
}

/**
 * Structural JSON price of one block: block overhead plus the character-weighted
 * price of its JSON reference. Used for images without route pricing, files
 * without handle text, and unknown merge-extended blocks.
 * @param {object} block - content block.
 * @returns {number} estimated tokens.
 */
export function estimateStructuralBlock(block) {
  const reference = block !== null && typeof block === 'object' && block.type === 'image'
    ? imageReference(block)
    : block
  return BLOCK_OVERHEAD + Math.ceil(estimateChars(safeStringify(reference)))
}

/**
 * Price one model-visible content block.
 *
 * `opts.imagePrice` must return the route's `{visualTokens, text}` for an image
 * block (or undefined to keep the structural fallback); `opts.fileText` must
 * return the exact model-visible file handle text.
 * @param {object} block - content block to price.
 * @param {{imagePrice?: (block: object) => {visualTokens: number, text?: string} | undefined, fileText?: (block: object) => string | undefined}} [opts] - route pricing hooks.
 * @returns {number} estimated tokens.
 */
export function estimateBlock(block, opts = {}) {
  if (block === null || typeof block !== 'object') return 0
  switch (block.type) {
    case 'text':
    case 'reasoning':
      return estimateTextTokens(block.text) + BLOCK_OVERHEAD
    case 'tool-call':
      return estimateTextTokens(block.name) + estimateTextTokens(block.arguments) + BLOCK_OVERHEAD
    case 'image': {
      if (typeof opts.imagePrice === 'function') {
        const price = opts.imagePrice(block)
        if (price !== undefined && Number.isFinite(price.visualTokens)) {
          return price.visualTokens + estimateTextTokens(price.text ?? '') + BLOCK_OVERHEAD
        }
      }
      return estimateStructuralBlock(block)
    }
    case 'file': {
      if (typeof opts.fileText === 'function') {
        const text = opts.fileText(block)
        if (typeof text === 'string') return estimateTextTokens(text) + BLOCK_OVERHEAD
      }
      return estimateStructuralBlock(block)
    }
    default:
      return estimateStructuralBlock(block)
  }
}

/**
 * Concatenate the text blocks of a system-role message (adapters serialize the
 * system prompt as text, not typed JSON).
 * @param {object} message - message to inspect.
 * @returns {string} system text.
 */
export function systemTextOf(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  let text = ''
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text
    else if (block !== null && typeof block === 'object') text += safeStringify(block)
  }
  return text
}

/**
 * Price a rendered system prompt: text density plus role framing, with no
 * per-block overhead (token-meter parity for system messages).
 * @param {unknown} text - rendered system text.
 * @returns {number} estimated tokens; 0 for empty text.
 */
export function estimateSystemText(text) {
  const value = String(text ?? '')
  if (value.length === 0) return 0
  return estimateTextTokens(value) + ROLE_OVERHEAD
}

/**
 * Price one message (system messages use {@link estimateSystemText}).
 * @param {object} message - message to price.
 * @param {object} [opts] - route pricing hooks forwarded to {@link estimateBlock}.
 * @returns {number} estimated tokens.
 */
export function estimateMessage(message, opts = {}) {
  if (message === null || typeof message !== 'object') return 0
  if (message.role === 'system') return estimateSystemText(systemTextOf(message))
  const content = Array.isArray(message.content) ? message.content : []
  let total = ROLE_OVERHEAD
  for (const block of content) total += estimateBlock(block, opts)
  return total
}

/**
 * Price a complete message list.
 * @param {object[]} messages - request messages.
 * @param {object} [opts] - route pricing hooks forwarded to {@link estimateBlock}.
 * @returns {number} estimated tokens.
 */
export function estimateMessages(messages, opts = {}) {
  if (!Array.isArray(messages)) return 0
  let total = 0
  for (const message of messages) total += estimateMessage(message, opts)
  return total
}

/**
 * Price the tool-declaration envelope as adapters serialize it (one JSON array),
 * plus one structural block overhead.
 * @param {object[] | undefined} tools - projected declarations.
 * @returns {number} estimated tokens; 0 when absent or empty.
 */
export function estimateToolSchemas(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return 0
  return Math.ceil(estimateChars(safeStringify(tools))) + BLOCK_OVERHEAD
}

/**
 * Price named system-prompt sections (interpolated text, as the model sees it).
 * @param {{name: string, text: string}[]} sections - sections in render order.
 * @returns {{sections: {name: string, ascii: number, nonAscii: number, est: number}[], total: number}} per-section prices and their sum.
 */
export function estimateSystemSections(sections) {
  const priced = []
  let total = 0
  for (const section of Array.isArray(sections) ? sections : []) {
    const text = String(section?.text ?? '')
    if (text.length === 0) continue
    const { ascii, nonAscii } = splitChars(text)
    const est = Math.ceil(ascii * ASCII_TOKENS_PER_CHAR + nonAscii * NON_ASCII_TOKENS_PER_CHAR)
    priced.push({ name: String(section?.name ?? 'unknown'), ascii, nonAscii, est })
    total += est
  }
  return { sections: priced, total }
}

/**
 * Normalize raw category estimates to an authoritative total.
 *
 * The returned integer categories always sum exactly to `total` when `total`
 * is a non-negative integer: each category is scaled and rounded, then the
 * rounding residual is applied to the largest category.
 *
 * @param {Record<string, number>} categories - raw category → estimated tokens.
 * @param {number} total - authoritative total (normally `promptTokens`).
 * @returns {{categories: Record<string, number>, scale: number, rawSum: number, residual: number}} normalized categories, the applied scale, and diagnostics.
 */
export function normalizeToTotal(categories, total) {
  const keys = []
  const rawSource = categories !== null && typeof categories === 'object' ? categories : {}
  for (const key of Object.keys(rawSource)) {
    const value = rawSource[key]
    if (Number.isFinite(value) && value > 0) keys.push(key)
  }
  const rawSum = keys.reduce((sum, key) => sum + rawSource[key], 0)
  const target = Number.isFinite(total) && total > 0 ? Math.round(total) : 0
  const scale = target > 0 && rawSum > 0 ? target / rawSum : 0
  const normalized = {}
  let sum = 0
  for (const key of keys) {
    const value = Math.max(0, Math.round(rawSource[key] * scale))
    if (value <= 0) continue
    normalized[key] = value
    sum += value
  }
  let residual = target - sum
  let guard = 0
  while (residual !== 0 && guard < 4096) {
    guard += 1
    const ordered = Object.keys(normalized).sort((left, right) => normalized[right] - normalized[left])
    const largest = ordered[0]
    if (residual > 0) {
      if (largest === undefined) {
        // Every weight rounded to zero; keep the residual reported rather than inventing a category.
        break
      }
      normalized[largest] += residual
      residual = 0
    } else {
      if (largest === undefined) break
      const take = Math.min(normalized[largest], -residual)
      normalized[largest] -= take
      residual += take
      if (normalized[largest] === 0) delete normalized[largest]
    }
  }
  return { categories: normalized, scale, rawSum, residual }
}

/**
 * Distribute a whole token total across named weights using integer rounding,
 * fixing the residual into the largest weight so the parts sum exactly.
 * @param {{name: string, weight: number}[]} parts - named weights.
 * @param {number} total - authoritative total.
 * @returns {Record<string, number>} name → whole estimated tokens.
 */
export function distributeTotal(parts, total) {
  const target = Number.isFinite(total) && total > 0 ? Math.round(total) : 0
  const entries = parts.filter(part => Number.isFinite(part.weight) && part.weight > 0)
  const weightSum = entries.reduce((sum, part) => sum + part.weight, 0)
  if (entries.length === 0 || target === 0) return {}
  const result = {}
  let assigned = 0
  for (const part of entries) {
    const value = Math.max(0, Math.round(part.weight / weightSum * target))
    if (value <= 0) continue
    result[part.name] = (result[part.name] ?? 0) + value
    assigned += value
  }
  const residual = target - assigned
  if (residual !== 0) {
    const largest = Object.keys(result).sort((left, right) => result[right] - result[left])[0]
    // Tiny totals can round every part to zero; keep the total by charging the
    // first declared part instead of dropping tokens.
    if (largest !== undefined) result[largest] = Math.max(0, result[largest] + residual)
    else result[entries[0].name] = target
  }
  return result
}
