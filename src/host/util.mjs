/**
 * Shared primitives for the token-attribution host: hashing, local day keys,
 * the `char-v1` character weighting, and crash-safe JSON file helpers.
 *
 * @module dsh-token-attribution/host/util
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** ASCII characters priced at this many estimated tokens per character. */
export const ASCII_TOKENS_PER_CHAR = 0.275
/** Non-ASCII characters (CJK and friends) priced at this many estimated tokens per character. */
export const NON_ASCII_TOKENS_PER_CHAR = 0.9

/**
 * Hash arbitrary text with SHA-1 (hex). Hashes are considered safe to persist;
 * they never reveal the hashed content.
 * @param {unknown} text - value to stringify and hash.
 * @returns {string} lowercase hex digest.
 */
export function sha1(text) {
  return createHash('sha1').update(String(text ?? ''), 'utf8').digest('hex')
}

/** Current wall-clock time in epoch milliseconds.
 * @returns {number} epoch milliseconds.
 */
export function nowMs() {
  return Date.now()
}

/**
 * Local-calendar day key (`YYYY-MM-DD`) for an epoch-milliseconds instant.
 * @param {number} ms - epoch milliseconds.
 * @returns {string} local day key.
 */
export function dayKey(ms) {
  const date = new Date(Number.isFinite(ms) ? ms : Date.now())
  if (Number.isNaN(date.getTime())) return '1970-01-01'
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Split text into ASCII and non-ASCII character counts (UTF-16 code units,
 * matching `String.prototype.length`).
 * @param {unknown} text - text to inspect.
 * @returns {{ascii: number, nonAscii: number}} character counts.
 */
export function splitChars(text) {
  const value = String(text ?? '')
  let ascii = 0
  let nonAscii = 0
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) < 128) ascii += 1
    else nonAscii += 1
  }
  return { ascii, nonAscii }
}

/**
 * Character-weighted estimated token count (unrounded): `ascii*0.275 +
 * nonAscii*0.9`. This is the raw density input every estimator in this plugin
 * builds on; it is not a provider token count.
 * @param {unknown} text - text to price.
 * @returns {number} estimated tokens, unrounded.
 */
export function estimateChars(text) {
  const { ascii, nonAscii } = splitChars(text)
  return ascii * ASCII_TOKENS_PER_CHAR + nonAscii * NON_ASCII_TOKENS_PER_CHAR
}

/**
 * Round to a fixed number of decimal places.
 * @param {number} value - value to round.
 * @param {number} [digits] - decimal places (default 0).
 * @returns {number} rounded value.
 */
export function round(value, digits = 0) {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/**
 * Ensure a directory exists (recursive).
 * @param {string} dir - absolute directory path.
 * @returns {void}
 */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

/**
 * Write a UTF-8 file through a same-directory temp file and rename, so a crash
 * never leaves a half-written ledger file.
 * @param {string} file - destination path.
 * @param {string} data - complete file contents.
 * @returns {void}
 */
export function atomicWriteFileSync(file, data) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`
  try {
    fs.writeFileSync(tmp, data, 'utf8')
    fs.renameSync(tmp, file)
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      // The temp file is best-effort cleanup after the real failure.
    }
    throw error
  }
}

/**
 * Read and parse a JSON file, returning the fallback for a missing or corrupt
 * file instead of throwing.
 * @param {string} file - file path.
 * @param {unknown} [fallback] - value returned on any read/parse failure.
 * @returns {unknown} parsed JSON or the fallback.
 */
export function readJsonFile(file, fallback = null) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    if (text.trim().length === 0) return fallback
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/**
 * Escape a literal string for use inside a regular expression.
 * @param {unknown} text - literal text.
 * @returns {string} escaped text.
 */
export function escapeRegExp(text) {
  return String(text ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Increment a Map counter and return the map for chaining.
 * @param {Map<string, number>} map - counter map.
 * @param {string} key - counter key.
 * @param {number} [amount] - increment (default 1).
 * @returns {Map<string, number>} the same map.
 */
export function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount)
  return map
}

/**
 * JSON.stringify that never throws and always returns a string.
 * @param {unknown} value - value to serialize.
 * @param {string} [fallback] - value for unserializable input.
 * @returns {string} JSON text or the fallback.
 */
export function safeStringify(value, fallback = '') {
  try {
    const text = JSON.stringify(value)
    return typeof text === 'string' ? text : fallback
  } catch {
    return fallback
  }
}

/**
 * Whether a value is a valid local `YYYY-MM-DD` day key (calendar-checked).
 * @param {unknown} value - candidate value.
 * @returns {boolean} true for a valid day key.
 */
export function isValidDayKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(year, month - 1, day, 12, 0, 0, 0)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
}

/**
 * Shift a local day key by a number of days (local calendar, DST-safe).
 * @param {string} day - base day key.
 * @param {number} delta - signed day count.
 * @returns {string} shifted day key.
 */
export function shiftDays(day, delta) {
  if (!isValidDayKey(day) || !Number.isInteger(delta)) return dayKey(nowMs())
  const [year, month, date] = day.split('-').map(Number)
  const shifted = new Date(year, month - 1, date + delta, 12, 0, 0, 0)
  return dayKey(shifted.getTime())
}

/**
 * Enumerate day keys between two bounds, ascending and inclusive.
 * @param {string} from - first day key.
 * @param {string} to - last day key.
 * @param {number} [max] - safety cap on the number of days (default 4000, the
 *   ten-year maximum retention window).
 * @returns {string[]} day keys; empty when either bound is invalid or `from > to`.
 */
export function dayKeysBetween(from, to, max = 4000) {
  if (!isValidDayKey(from) || !isValidDayKey(to) || from > to) return []
  const days = []
  let cursor = from
  while (cursor <= to && days.length < max) {
    days.push(cursor)
    cursor = shiftDays(cursor, 1)
  }
  return days
}

/**
 * Read a service without declaring a static injection. Uses the documented
 * strict `ctx.get` first and falls back to the property proxy for test doubles.
 * @param {object} ctx - Cordis context or a compatible test double.
 * @param {string} name - service name.
 * @returns {unknown} the service value, or undefined when unavailable.
 */
export function getService(ctx, name) {
  if (ctx === null || typeof ctx !== 'object') return undefined
  try {
    if (typeof ctx.get === 'function') {
      const value = ctx.get(name)
      if (value !== undefined) return value
    }
  } catch {
    // A missing/withheld service must never break attribution.
  }
  try {
    return ctx[name]
  } catch {
    return undefined
  }
}
