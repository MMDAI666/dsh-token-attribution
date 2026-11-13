#!/usr/bin/env node
/**
 * Offline reconciliation for dsh-token-attribution (M1a acceptance A2/A4).
 *
 * Compares the plugin's own request ledger (`requests/YYYY-MM-DD.jsonl`) with
 * usage derived independently from DSH session logs
 * (`<sessions-root>/<workspace>/<session>/session.v4.jsonl.zstd`).
 *
 * Equal-by-construction sources:
 *   ledger  purpose absent/'chat' + sessionId + real usage
 *           purpose 'compaction' + real usage
 *   session `assistant/message.data.usage`
 *           `compaction/summary.data.usage`
 *
 * Live-only sources (no session-log counterpart, reported but never failed):
 *   purpose 'auto-review' / 'session-title'.
 *
 * Zero external dependencies; Node.js >= 24 (uses `zlib.zstdDecompressSync`).
 * Session logs are a concatenation of independent zstd frames, so frame
 * boundaries are walked from the frame header/block headers instead of asking
 * zlib to decompress the whole concatenation at once.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { pathToFileURL } from 'node:url'

/** Little-endian zstd frame magic (`28 B5 2F FD`). */
export const ZSTD_MAGIC = 0xFD2FB528

/** Hard caps so a bad path or a month of sessions cannot hang the tool. */
export const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 200,
  maxEvents: 2_000_000,
  maxLedgerDays: 400,
  maxWarnings: 50,
  perSessionLimit: 10,
})

/** A user-facing failure: printed without a stack trace and mapped to exit code 2. */
export class ReconcileError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ReconcileError'
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function firstFinite(...values) {
  for (const value of values) {
    const num = finiteNumber(value)
    if (num !== null) return num
  }
  return null
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

/** Number with thousands separators; stable across locales. */
function formatInteger(value) {
  const num = Math.trunc(Number(value) || 0)
  const sign = num < 0 ? '-' : ''
  return sign + String(Math.abs(num)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function formatDelta(value) {
  return value === 0 ? '0' : (value > 0 ? '+' : '') + formatInteger(value)
}

/** Local `YYYY-MM-DD` day key for an epoch-ms instant. */
export function localDayKey(ts) {
  const date = new Date(ts)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** Epoch ms of local midnight for the local day containing `ts`. */
export function startOfLocalDay(ts) {
  const date = new Date(ts)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** Local ISO-8601 with numeric UTC offset (for human output and evidence). */
export function localIso(ts) {
  const date = new Date(ts)
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
    + `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
    + `.${String(date.getMilliseconds()).padStart(3, '0')}${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
}

/** Local day keys touched by the inclusive [from, to] window. */
export function localDayKeys(from, to) {
  const start = new Date(from)
  start.setHours(0, 0, 0, 0)
  const end = new Date(to)
  end.setHours(0, 0, 0, 0)
  const keys = []
  const cursor = new Date(start.getTime())
  while (cursor.getTime() <= end.getTime()) {
    keys.push(localDayKey(cursor.getTime()))
    if (keys.length > DEFAULT_LIMITS.maxLedgerDays) {
      throw new ReconcileError(`window spans more than ${DEFAULT_LIMITS.maxLedgerDays} local days; narrow --from/--to`)
    }
    cursor.setDate(cursor.getDate() + 1)
  }
  return keys
}

/** Parse one CLI window bound: epoch milliseconds, a numeric string, or ISO-8601. */
export function parseInstant(value, label = 'timestamp') {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ReconcileError(`invalid ${label}: ${String(value)}`)
    return Math.trunc(value)
  }
  if (typeof value !== 'string') throw new ReconcileError(`invalid ${label}: expected ISO 8601 or epoch milliseconds`)
  const text = value.trim()
  if (text === '') throw new ReconcileError(`invalid ${label}: empty value`)
  if (/^-?\d+$/.test(text)) {
    const numeric = Number(text)
    if (!Number.isSafeInteger(numeric)) throw new ReconcileError(`invalid ${label} epoch milliseconds: ${value}`)
    return numeric
  }
  const parsed = Date.parse(text)
  if (Number.isNaN(parsed)) {
    throw new ReconcileError(`invalid ${label}: ${value} (expected ISO 8601 or epoch milliseconds)`)
  }
  return parsed
}

/**
 * Resolve the reconcile window.
 * Defaults: today local 00:00 (inclusive) .. now (inclusive).
 * @returns {{from:number,to:number,fromIso:string,toIso:string,localFrom:string,localTo:string}}
 */
export function parseWindow(options = {}) {
  const now = finiteNumber(options.now) ?? Date.now()
  const hasFrom = options.from !== undefined && options.from !== null && options.from !== ''
  const hasTo = options.to !== undefined && options.to !== null && options.to !== ''
  const from = hasFrom ? parseInstant(options.from, 'window start') : startOfLocalDay(now)
  const to = hasTo ? parseInstant(options.to, 'window end') : now
  if (from > to) {
    throw new ReconcileError(`window start (${new Date(from).toISOString()}) is after window end (${new Date(to).toISOString()})`)
  }
  return {
    from,
    to,
    fromIso: new Date(from).toISOString(),
    toIso: new Date(to).toISOString(),
    localFrom: localIso(from),
    localTo: localIso(to),
  }
}

/** Caps collected warnings while keeping a count of what was suppressed. */
function createWarningSink(limit = DEFAULT_LIMITS.maxWarnings) {
  const items = []
  let suppressed = 0
  return {
    push(message) {
      const text = String(message)
      if (items.length < limit) items.push(text)
      else suppressed += 1
    },
    finish() {
      if (suppressed > 0) {
        const note = `... ${suppressed} more warning(s) suppressed`
        items.push(note)
        suppressed = 0
      }
      return items
    },
    get total() {
      return items.length + suppressed
    },
  }
}

// ---------------------------------------------------------------------------
// Zstandard multi-frame walking
// ---------------------------------------------------------------------------

/**
 * Length of one complete zstd frame at `offset`.
 * @returns {number|null} byte length, or null when the buffer ends mid-frame.
 * @throws {ReconcileError} on a structurally invalid frame header/block.
 */
function zstdFrameLength(buffer, offset) {
  if (offset + 4 > buffer.length) return null
  const magic = buffer.readUInt32LE(offset)
  if (magic !== ZSTD_MAGIC) {
    throw new ReconcileError(`invalid zstd magic 0x${magic.toString(16)} at byte ${offset}`)
  }
  let cursor = offset + 4
  if (cursor >= buffer.length) return null
  const descriptor = buffer[cursor]
  cursor += 1
  // bit 4 is unused and bit 3 is reserved; either set means the walker is lost.
  if ((descriptor & 0x18) !== 0) {
    throw new ReconcileError(`reserved zstd frame-header bits set at byte ${cursor - 1}`)
  }
  const contentSizeFlag = descriptor >>> 6
  const singleSegment = (descriptor >>> 5) & 1
  const hasChecksum = (descriptor >>> 2) & 1
  const dictionaryFlag = descriptor & 3

  if (singleSegment === 0) cursor += 1 // Window_Descriptor
  cursor += [0, 1, 2, 4][dictionaryFlag]
  cursor += [singleSegment === 1 ? 1 : 0, 2, 4, 8][contentSizeFlag]
  if (cursor > buffer.length) return null

  for (;;) {
    if (cursor + 3 > buffer.length) return null
    const header = buffer[cursor] | (buffer[cursor + 1] << 8) | (buffer[cursor + 2] << 16)
    cursor += 3
    const lastBlock = header & 1
    const blockType = (header >>> 1) & 3
    const blockSize = header >>> 3
    if (blockType === 3) {
      throw new ReconcileError(`reserved zstd block type at byte ${cursor - 3}`)
    }
    // RLE blocks carry exactly one payload byte; raw/compressed carry blockSize.
    cursor += blockType === 1 ? 1 : blockSize
    if (cursor > buffer.length) return null
    if (lastBlock === 1) break
  }
  if (hasChecksum === 1) cursor += 4
  if (cursor > buffer.length) return null
  return cursor - offset
}

/**
 * Walk the independent zstd frames concatenated in one session-log buffer.
 * Truncated tails (a log mid-write) stop the walk with a warning instead of throwing.
 * @param {Buffer} buffer raw log bytes.
 * @returns {{frames:{offset:number,length:number}[],warnings:string[]}}
 */
export function walkZstdFrames(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new ReconcileError('walkZstdFrames expects a Buffer')
  const frames = []
  const warnings = []
  let offset = 0
  while (offset < buffer.length) {
    let length
    try {
      length = zstdFrameLength(buffer, offset)
    } catch (error) {
      warnings.push(error.message)
      break
    }
    if (length === null) {
      warnings.push(`truncated zstd frame at byte ${offset} (${buffer.length - offset} trailing byte(s) not decodable)`)
      break
    }
    if (length <= 0) {
      warnings.push(`zero-length zstd frame at byte ${offset}`)
      break
    }
    frames.push({ offset, length })
    offset += length
  }
  return { frames, warnings }
}

/**
 * Decompress a concatenated-frame session log.
 * @param {Buffer|string} input raw bytes or a file path.
 * @returns {{text:string,lines:string[],frameCount:number,frameInfos:{offset:number,length:number}[],warnings:string[]}}
 */
export function decompressSessionLog(input) {
  const buffer = Buffer.isBuffer(input) ? input : fs.readFileSync(input)
  const walked = walkZstdFrames(buffer)
  const warnings = [...walked.warnings]
  const chunks = []
  for (const frame of walked.frames) {
    try {
      chunks.push(zlib.zstdDecompressSync(buffer.subarray(frame.offset, frame.offset + frame.length)))
    } catch (error) {
      warnings.push(`zstd frame at byte ${frame.offset} failed to decompress: ${error.message}`)
    }
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.length > 0 && !text.endsWith('\n')) {
    warnings.push('decoded session log does not end with a newline (torn tail or missing final frame)')
  }
  const lines = text.split('\n').filter(line => line.trim() !== '')
  return { text, lines, frameCount: walked.frames.length, frameInfos: walked.frames, warnings }
}

// ---------------------------------------------------------------------------
// Session-log usage extraction
// ---------------------------------------------------------------------------

function createUsageTotals() {
  return {
    count: 0,
    promptTokens: 0,
    outputTokens: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  }
}

function addUsageRecord(target, usage) {
  target.count += 1
  target.inputTokens += usage.input
  target.cacheReadTokens += usage.cacheRead
  target.cacheWriteTokens += usage.cacheWrite
  target.outputTokens += usage.output
  target.reasoningTokens += usage.reasoning
  target.promptTokens += usage.input + usage.cacheRead + usage.cacheWrite
}

/** Normalize a session-log `TokenUsage` (four non-overlapping buckets). */
function readSessionUsage(usage) {
  if (!isPlainObject(usage)) return null
  const input = firstFinite(usage.inputTokens, usage.input)
  const cacheRead = firstFinite(usage.cacheReadTokens, usage.cacheRead)
  const cacheWrite = firstFinite(usage.cacheWriteTokens, usage.cacheWrite)
  const output = firstFinite(usage.outputTokens, usage.output)
  if (input === null && cacheRead === null && cacheWrite === null && output === null) return null
  return {
    input: input ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheWrite: cacheWrite ?? 0,
    output: output ?? 0,
    reasoning: firstFinite(usage.reasoningTokens, usage.reasoning) ?? 0,
  }
}

function normalizeLineItems(input) {
  if (Array.isArray(input)) return input
  if (typeof input === 'string') return input.split(/\r?\n/)
  if (isPlainObject(input) && Array.isArray(input.lines)) return input.lines
  if (isPlainObject(input) && Array.isArray(input.events)) return input.events
  return []
}

/**
 * Extract assistant/compaction usage from decoded session-log lines.
 *
 * Only `assistant/message.data.usage` and `compaction/summary.data.usage` are
 * counted. Events are filtered by their own `time` field (epoch ms, inclusive
 * bounds). Events belonging to a seeded fork's inherited prefix are dropped
 * when the log carries the tagged `session/end-seed` cut (the last one wins).
 *
 * @param {string[]|string|{lines:string[]}|object[]} input decoded lines or parsed events.
 * @param {{from?:number,to?:number,maxEvents?:number,dropInherited?:boolean}} options
 */
export function extractUsageEvents(input, options = {}) {
  const from = finiteNumber(options.from) ?? Number.NEGATIVE_INFINITY
  const to = finiteNumber(options.to) ?? Number.POSITIVE_INFINITY
  const maxEvents = finiteNumber(options.maxEvents) ?? Number.POSITIVE_INFINITY
  const dropInherited = options.dropInherited !== false

  const assistant = createUsageTotals()
  const compaction = createUsageTotals()
  const warnings = []
  let header = null
  let malformed = 0
  let truncated = false
  let skippedOutsideWindow = 0
  let skippedInherited = 0
  let skippedMissingTime = 0
  let skippedMissingSeq = 0
  let assistantWithoutUsage = 0
  let inWindow = 0

  const records = []
  for (const item of normalizeLineItems(input)) {
    let record
    if (typeof item === 'string') {
      const line = item.trim()
      if (line === '') continue
      try {
        record = JSON.parse(line)
      } catch {
        malformed += 1
        continue
      }
    } else {
      record = item
    }
    if (!isPlainObject(record)) {
      malformed += 1
      continue
    }
    if (record.type === 'session') {
      if (header === null) header = record
      continue
    }
    records.push(record)
    if (records.length >= maxEvents) {
      truncated = true
      break
    }
  }

  // Fork cut: the last tagged `session/end-seed` event marks inherited prefix end.
  let seedCutSeq = null
  if (header !== null && header.isSeeded === true && dropInherited) {
    for (const record of records) {
      if (record.type !== 'session/end-seed') continue
      if (!isPlainObject(record.data) || record.data.inherited !== true) continue
      const seq = finiteNumber(record.seq)
      if (seq === null) continue
      seedCutSeq = seedCutSeq === null ? seq : Math.max(seedCutSeq, seq)
    }
    if (seedCutSeq === null) {
      warnings.push('seeded session has no tagged session/end-seed marker; inherited events could not be excluded')
    }
  }

  for (const record of records) {
    const time = finiteNumber(record.time)
    if (time === null) {
      skippedMissingTime += 1
      continue
    }
    if (time < from || time > to) {
      skippedOutsideWindow += 1
      continue
    }
    inWindow += 1
    if (seedCutSeq !== null) {
      const seq = finiteNumber(record.seq)
      if (seq === null) {
        skippedMissingSeq += 1
      } else if (seq <= seedCutSeq) {
        skippedInherited += 1
        continue
      }
    }
    if (record.type === 'assistant/message') {
      const usage = readSessionUsage(isPlainObject(record.data) ? record.data.usage : undefined)
      if (usage === null) {
        assistantWithoutUsage += 1
        continue
      }
      addUsageRecord(assistant, usage)
    } else if (record.type === 'compaction/summary') {
      const usage = readSessionUsage(isPlainObject(record.data) ? record.data.usage : undefined)
      if (usage === null) continue
      addUsageRecord(compaction, usage)
    }
  }

  return {
    header,
    assistant,
    compaction,
    events: { total: records.length, inWindow, malformed, truncated },
    assistantWithoutUsage,
    skippedInherited,
    skippedOutsideWindow,
    skippedMissingTime,
    skippedMissingSeq,
    seedCutSeq,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Ledger reading and aggregation
// ---------------------------------------------------------------------------

/** Normalize a ledger record usage object (PLAN 6.3: input/cacheRead/cacheWrite/output). */
function readLedgerUsage(usage) {
  if (!isPlainObject(usage)) return null
  const input = firstFinite(usage.input, usage.inputTokens)
  const cacheRead = firstFinite(usage.cacheRead, usage.cacheReadTokens)
  const cacheWrite = firstFinite(usage.cacheWrite, usage.cacheWriteTokens)
  const output = firstFinite(usage.output, usage.outputTokens)
  if (input === null && cacheRead === null && cacheWrite === null && output === null) return null
  return {
    input: input ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheWrite: cacheWrite ?? 0,
    output: output ?? 0,
    reasoning: firstFinite(usage.reasoning, usage.reasoningTokens) ?? 0,
  }
}

function readLedgerTotals(record) {
  const usage = readLedgerUsage(record.usage)
  const estimated = record.usageEstimated === true || record.estimatedUsage === true
  const promptFromUsage = usage === null ? null : usage.input + usage.cacheRead + usage.cacheWrite
  const promptTokens = firstFinite(record.promptTokens) ?? promptFromUsage
  const outputTokens = firstFinite(record.outputTokens) ?? (usage === null ? null : usage.output)
  return {
    usage,
    estimated,
    promptTokens: promptTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    actual: usage !== null && !estimated,
  }
}

function createBucket() {
  return { count: 0, promptTokens: 0, outputTokens: 0, records: 0, estimatedCount: 0 }
}

function addToBucket(bucket, totals) {
  bucket.count += 1
  bucket.promptTokens += totals.promptTokens
  bucket.outputTokens += totals.outputTokens
}

/**
 * Aggregate ledger records in the window.
 *
 * `persisted` needs all three of: purpose absent/'chat', a sessionId, and a
 * real (non-estimated) usage object. Estimated records never enter equality
 * sums; they are reported through `estimatedUsage`.
 *
 * @param {object[]} records parsed JSONL records.
 * @param {{from?:number,to?:number,files?:number,corruptLines?:number,missingDirectory?:boolean}} options
 */
export function aggregateLedger(records, options = {}) {
  const from = finiteNumber(options.from) ?? Number.NEGATIVE_INFINITY
  const to = finiteNumber(options.to) ?? Number.POSITIVE_INFINITY
  const persisted = createBucket()
  const compaction = createBucket()
  const autoReview = createBucket()
  const sessionTitle = createBucket()
  const other = createBucket()
  const otherByPurpose = Object.create(null)
  const bySession = Object.create(null)
  const estimatedByPurpose = Object.create(null)
  const skipped = {
    missingTimestamp: 0,
    invalidTimestamp: 0,
    invalidRecord: 0,
    missingSessionId: 0,
    missingActualUsage: 0,
  }
  let recordsInWindow = 0
  let estimatedCount = 0

  for (const record of Array.isArray(records) ? records : []) {
    if (!isPlainObject(record)) {
      skipped.invalidRecord += 1
      continue
    }
    if (!Object.hasOwn(record, 'ts')) {
      skipped.missingTimestamp += 1
      continue
    }
    const ts = finiteNumber(record.ts)
    if (ts === null) {
      skipped.invalidTimestamp += 1
      continue
    }
    if (ts < from || ts > to) continue
    recordsInWindow += 1

    const purpose = typeof record.purpose === 'string' && record.purpose !== '' ? record.purpose : 'chat'
    const sessionId = typeof record.sessionId === 'string' && record.sessionId !== '' ? record.sessionId : null
    const totals = readLedgerTotals(record)
    if (totals.estimated) {
      estimatedCount += 1
      estimatedByPurpose[purpose] = (estimatedByPurpose[purpose] ?? 0) + 1
    }

    if (purpose === 'chat') {
      persisted.records += 1
      if (sessionId === null) {
        skipped.missingSessionId += 1
        continue
      }
      if (!totals.actual) {
        skipped.missingActualUsage += 1
        continue
      }
      addToBucket(persisted, totals)
      const session = bySession[sessionId] ?? (bySession[sessionId] = { count: 0, promptTokens: 0, outputTokens: 0 })
      addToBucket(session, totals)
    } else if (purpose === 'compaction') {
      compaction.records += 1
      if (totals.actual) addToBucket(compaction, totals)
      else skipped.missingActualUsage += 1
    } else if (purpose === 'auto-review') {
      autoReview.records += 1
      if (totals.actual) addToBucket(autoReview, totals)
      else skipped.missingActualUsage += 1
    } else if (purpose === 'session-title') {
      sessionTitle.records += 1
      if (totals.actual) addToBucket(sessionTitle, totals)
      else skipped.missingActualUsage += 1
    } else {
      other.records += 1
      const bucket = otherByPurpose[purpose] ?? (otherByPurpose[purpose] = createBucket())
      bucket.records += 1
      if (totals.actual) {
        addToBucket(other, totals)
        addToBucket(bucket, totals)
      } else {
        skipped.missingActualUsage += 1
      }
    }
  }

  for (const [purpose, count] of Object.entries(estimatedByPurpose)) {
    if (purpose === 'chat') persisted.estimatedCount += count
    else if (purpose === 'compaction') compaction.estimatedCount += count
    else if (purpose === 'auto-review') autoReview.estimatedCount += count
    else if (purpose === 'session-title') sessionTitle.estimatedCount += count
    else {
      other.estimatedCount += count
      if (otherByPurpose[purpose]) otherByPurpose[purpose].estimatedCount += count
    }
  }

  return {
    files: finiteNumber(options.files) ?? 0,
    records: Array.isArray(records) ? records.length : 0,
    recordsInWindow,
    corruptLines: finiteNumber(options.corruptLines) ?? 0,
    missingDirectory: options.missingDirectory === true,
    capped: options.capped === true,
    warnings: [],
    persisted,
    compaction,
    autoReview,
    sessionTitle,
    other,
    otherByPurpose,
    bySession,
    estimatedUsage: { count: estimatedCount, byPurpose: estimatedByPurpose },
    skipped,
  }
}

/**
 * Read `requests/YYYY-MM-DD.jsonl` files for the local days in the window.
 * Missing directory/files are reported (not fatal) so the CLI can still say
 * INCONCLUSIVE; unreadable files become warnings.
 * @param {string} dataRoot plugin data directory (its `requests/` child is read).
 * @param {{from?:number,to?:number,maxRecords?:number}} options
 */
export function readLedgerRecords(dataRoot, options = {}) {
  const now = finiteNumber(options.now) ?? Date.now()
  const from = finiteNumber(options.from) ?? startOfLocalDay(now)
  const to = finiteNumber(options.to) ?? now
  const maxRecords = finiteNumber(options.maxRecords) ?? DEFAULT_LIMITS.maxEvents
  const result = {
    records: [],
    files: 0,
    corruptLines: 0,
    missingDates: [],
    missingDirectory: false,
    capped: false,
    warnings: [],
  }
  const requestsDir = path.join(dataRoot, 'requests')
  let stat
  try {
    stat = fs.statSync(requestsDir)
  } catch {
    result.missingDirectory = true
    result.warnings.push(`no request ledger directory at ${requestsDir}`)
    return result
  }
  if (!stat.isDirectory()) {
    throw new ReconcileError(`request ledger path is not a directory: ${requestsDir}`)
  }

  for (const day of localDayKeys(from, to)) {
    const file = path.join(requestsDir, `${day}.jsonl`)
    if (!fs.existsSync(file)) {
      result.missingDates.push(day)
      continue
    }
    result.files += 1
    let text
    try {
      text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    } catch (error) {
      result.warnings.push(`cannot read ledger file ${file}: ${error.message}`)
      continue
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        result.records.push(JSON.parse(trimmed))
      } catch {
        result.corruptLines += 1
      }
      if (result.records.length >= maxRecords) {
        result.capped = true
        result.warnings.push(`ledger record cap (${maxRecords}) reached; remaining records were skipped`)
        return result
      }
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Session-log discovery and aggregation
// ---------------------------------------------------------------------------

const SESSION_LOG_NAMES = new Set(['session.v4.jsonl.zstd'])

/**
 * Find v4 session logs below a DSH sessions root.
 * Layout: `<root>/<workspace>/<session>/session.v4.jsonl.zstd`.
 * @param {string} sessionsRoot
 * @param {{workspace?:string|null,maxFiles?:number}} options
 */
export function discoverSessionLogs(sessionsRoot, options = {}) {
  const workspace = typeof options.workspace === 'string' && options.workspace !== '' ? options.workspace : null
  const maxFiles = finiteNumber(options.maxFiles) ?? DEFAULT_LIMITS.maxFiles
  const root = path.resolve(sessionsRoot)
  const candidates = []
  const warnings = []

  const walk = (directory, depth) => {
    let entries
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch (error) {
      warnings.push(`cannot read directory ${directory}: ${error.message}`)
      return
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (depth === 0 && workspace !== null && entry.name !== workspace) continue
        walk(full, depth + 1)
      } else if (entry.isFile() && SESSION_LOG_NAMES.has(entry.name)) {
        let mtimeMs = 0
        try {
          mtimeMs = fs.statSync(full).mtimeMs
        } catch {
          // A vanished file is skipped by discovery; the read would fail later anyway.
        }
        candidates.push({ file: full, mtimeMs })
      }
    }
  }

  walk(root, 0)
  // Most recently written logs first: the controlled window's active sessions
  // must survive the cap even when the sessions tree holds many old logs.
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || left.file.localeCompare(right.file))
  const files = candidates.slice(0, maxFiles).map(candidate => candidate.file)
  if (candidates.length > maxFiles) {
    warnings.push(`session log cap (${maxFiles}) reached; ${candidates.length - maxFiles} older log(s) were skipped`)
  }
  return { files, warnings, capped: candidates.length > maxFiles }
}

function createSessionAggregate() {
  return {
    files: 0,
    filesRead: 0,
    filesWithUsage: 0,
    events: 0,
    eventsInWindow: 0,
    malformedLines: 0,
    assistantWithoutUsage: 0,
    skippedInherited: 0,
    skippedOutsideWindow: 0,
    skippedMissingTime: 0,
    seededSessionsWithoutCut: 0,
    assistant: createUsageTotals(),
    compaction: createUsageTotals(),
    bySession: Object.create(null),
    capped: false,
    warnings: [],
  }
}

function addUsageTotals(target, source) {
  target.count += source.count
  target.promptTokens += source.promptTokens
  target.outputTokens += source.outputTokens
  target.inputTokens += source.inputTokens
  target.cacheReadTokens += source.cacheReadTokens
  target.cacheWriteTokens += source.cacheWriteTokens
  target.reasoningTokens += source.reasoningTokens
}

function mergeExtractedSession(sessions, extracted, fallbackSessionId) {
  sessions.events += extracted.events.total
  sessions.eventsInWindow += extracted.events.inWindow
  sessions.malformedLines += extracted.events.malformed
  sessions.assistantWithoutUsage += extracted.assistantWithoutUsage
  sessions.skippedInherited += extracted.skippedInherited
  sessions.skippedOutsideWindow += extracted.skippedOutsideWindow
  sessions.skippedMissingTime += extracted.skippedMissingTime
  addUsageTotals(sessions.assistant, extracted.assistant)
  addUsageTotals(sessions.compaction, extracted.compaction)
  if (extracted.assistant.count > 0 || extracted.compaction.count > 0) sessions.filesWithUsage += 1

  if (extracted.header !== null && extracted.header.isSeeded === true && extracted.seedCutSeq === null) {
    sessions.seededSessionsWithoutCut += 1
  }
  if (extracted.assistant.count === 0) return
  const headerId = extracted.header !== null && typeof extracted.header.id === 'string' && extracted.header.id !== ''
    ? extracted.header.id
    : fallbackSessionId
  const entry = sessions.bySession[headerId] ?? (sessions.bySession[headerId] = {
    count: 0,
    promptTokens: 0,
    outputTokens: 0,
  })
  addUsageTotals(entry, extracted.assistant)
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/**
 * Compare ledger totals with session-log totals.
 *
 * Counts are compared too (the A2 wording is "exact equal, zero records
 * different"), because equal token sums with different record counts would
 * still mean the capture is not faithful.
 *
 * @param {object} ledger result of {@link aggregateLedger}.
 * @param {object} sessions aggregated session-log result.
 * @returns {{diffs:object,perSession:object[],perSessionTotal:number,verdict:'PASS'|'FAIL'|'INCONCLUSIVE'}}
 */
export function compare(ledger, sessions, options = {}) {
  const ledgerPersisted = isPlainObject(ledger?.persisted) ? ledger.persisted : {}
  const ledgerCompaction = isPlainObject(ledger?.compaction) ? ledger.compaction : {}
  const sessionAssistant = isPlainObject(sessions?.assistant) ? sessions.assistant : {}
  const sessionCompaction = isPlainObject(sessions?.compaction) ? sessions.compaction : {}
  const number = value => finiteNumber(value) ?? 0

  const diffs = {
    persistedPrompt: number(ledgerPersisted.promptTokens) - number(sessionAssistant.promptTokens),
    persistedOutput: number(ledgerPersisted.outputTokens) - number(sessionAssistant.outputTokens),
    persistedCount: number(ledgerPersisted.count) - number(sessionAssistant.count),
    compactionPrompt: number(ledgerCompaction.promptTokens) - number(sessionCompaction.promptTokens),
    compactionOutput: number(ledgerCompaction.outputTokens) - number(sessionCompaction.outputTokens),
    compactionCount: number(ledgerCompaction.count) - number(sessionCompaction.count),
  }

  const ledgerBySession = isPlainObject(ledger?.bySession) ? ledger.bySession : {}
  const sessionBySession = isPlainObject(sessions?.bySession) ? sessions.bySession : {}
  const sessionIds = new Set([...Object.keys(ledgerBySession), ...Object.keys(sessionBySession)])
  const perSession = []
  for (const sessionId of sessionIds) {
    const left = isPlainObject(ledgerBySession[sessionId]) ? ledgerBySession[sessionId] : {}
    const right = isPlainObject(sessionBySession[sessionId]) ? sessionBySession[sessionId] : {}
    const promptDelta = number(left.promptTokens) - number(right.promptTokens)
    const outputDelta = number(left.outputTokens) - number(right.outputTokens)
    if (promptDelta === 0 && outputDelta === 0) continue
    perSession.push({
      sessionId,
      ledgerPrompt: number(left.promptTokens),
      ledgerOutput: number(left.outputTokens),
      ledgerCount: number(left.count),
      sessionPrompt: number(right.promptTokens),
      sessionOutput: number(right.outputTokens),
      sessionCount: number(right.count),
      promptDelta,
      outputDelta,
    })
  }
  perSession.sort((left, right) => Math.max(Math.abs(right.promptDelta), Math.abs(right.outputDelta))
    - Math.max(Math.abs(left.promptDelta), Math.abs(left.outputDelta)))
  const limit = finiteNumber(options.perSessionLimit) ?? DEFAULT_LIMITS.perSessionLimit

  const ledgerHasEvidence = number(ledgerPersisted.count) > 0 || number(ledgerCompaction.count) > 0
  const sessionsHaveEvidence = number(sessionAssistant.count) > 0 || number(sessionCompaction.count) > 0
  const equal = Object.values(diffs).every(delta => delta === 0)
  const verdict = equal
    ? (ledgerHasEvidence || sessionsHaveEvidence ? 'PASS' : 'INCONCLUSIVE')
    : 'FAIL'

  return { diffs, perSession: perSession.slice(0, limit), perSessionTotal: perSession.length, verdict }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function assertDirectory(directory, label) {
  let stat
  try {
    stat = fs.statSync(directory)
  } catch {
    throw new ReconcileError(`${label} not found: ${directory}`)
  }
  if (!stat.isDirectory()) throw new ReconcileError(`${label} is not a directory: ${directory}`)
}

function relativeLabel(root, file) {
  const relative = path.relative(root, file)
  return relative === '' ? path.basename(file) : relative
}

/**
 * Run one reconciliation pass.
 * @param {{dataRoot:string,sessionsRoot:string,window?:object,profile?:string,workspace?:string|null,limits?:object,now?:number}} options
 * @returns {object} JSON-serializable result (also rendered by {@link renderHuman}).
 */
export function reconcile(options) {
  const dataRoot = path.resolve(options.dataRoot)
  const sessionsRoot = path.resolve(options.sessionsRoot)
  const limits = { ...DEFAULT_LIMITS, ...(isPlainObject(options.limits) ? options.limits : {}) }
  const windowInput = isPlainObject(options.window)
    ? options.window
    : parseWindow({ from: options.from, to: options.to, now: options.now })
  if (!Number.isFinite(windowInput.from) || !Number.isFinite(windowInput.to)) {
    throw new ReconcileError('reconcile window requires finite from/to epoch-millisecond bounds')
  }
  if (windowInput.from > windowInput.to) {
    throw new ReconcileError('reconcile window start is after its end')
  }
  const window = {
    from: windowInput.from,
    to: windowInput.to,
    fromIso: typeof windowInput.fromIso === 'string' ? windowInput.fromIso : new Date(windowInput.from).toISOString(),
    toIso: typeof windowInput.toIso === 'string' ? windowInput.toIso : new Date(windowInput.to).toISOString(),
    localFrom: typeof windowInput.localFrom === 'string' ? windowInput.localFrom : localIso(windowInput.from),
    localTo: typeof windowInput.localTo === 'string' ? windowInput.localTo : localIso(windowInput.to),
  }
  const profile = typeof options.profile === 'string' && options.profile !== '' ? options.profile : 'default'
  const workspace = typeof options.workspace === 'string' && options.workspace !== '' ? options.workspace : null

  assertDirectory(dataRoot, 'data root')
  assertDirectory(sessionsRoot, 'sessions root')

  const ledgerRead = readLedgerRecords(dataRoot, {
    from: window.from,
    to: window.to,
    maxRecords: limits.maxEvents,
    now: options.now,
  })
  const ledger = aggregateLedger(ledgerRead.records, {
    from: window.from,
    to: window.to,
    files: ledgerRead.files,
    corruptLines: ledgerRead.corruptLines,
    missingDirectory: ledgerRead.missingDirectory,
    capped: ledgerRead.capped,
  })
  ledger.warnings = [...ledgerRead.warnings]
  if (ledgerRead.capped) ledger.warnings.push('processing was capped; reconciliation may be incomplete')

  const sessionSink = createWarningSink(limits.maxWarnings)
  const discovery = discoverSessionLogs(sessionsRoot, { workspace, maxFiles: limits.maxFiles })
  for (const warning of discovery.warnings) sessionSink.push(warning)

  const sessions = createSessionAggregate()
  sessions.files = discovery.files.length
  let eventBudget = limits.maxEvents
  for (const file of discovery.files) {
    if (eventBudget <= 0) {
      sessions.capped = true
      sessionSink.push(`event cap (${limits.maxEvents}) reached; remaining logs were skipped`)
      break
    }
    const label = relativeLabel(sessionsRoot, file)
    try {
      const decompressed = decompressSessionLog(file)
      for (const warning of decompressed.warnings) sessionSink.push(`${label}: ${warning}`)
      if (decompressed.frameCount === 0) {
        sessionSink.push(`${label}: no zstd frames found; file skipped`)
        continue
      }
      const extracted = extractUsageEvents(decompressed.lines, {
        from: window.from,
        to: window.to,
        maxEvents: eventBudget,
        dropInherited: true,
      })
      sessions.filesRead += 1
      eventBudget -= extracted.events.total
      if (extracted.events.truncated) {
        sessions.capped = true
        sessionSink.push(`${label}: event cap reached while parsing this log`)
      }
      for (const warning of extracted.warnings) sessionSink.push(`${label}: ${warning}`)
      mergeExtractedSession(sessions, extracted, path.basename(path.dirname(file)))
    } catch (error) {
      sessionSink.push(`${label}: failed to read/decompress: ${error.message}`)
    }
  }
  sessions.warnings = sessionSink.finish()

  const comparison = compare(ledger, sessions, { perSessionLimit: limits.perSessionLimit })

  const notes = []
  notes.push(`profile scope: ledger read from ${dataRoot} (profile "${profile}"); only this profile's data is reconciled`)
  notes.push('clock skew tolerance: 0 ms — both sources are filtered by the same exact, inclusive window bounds')
  notes.push('activation boundary: calls already in flight when the collector activated appear only in session logs; start the window after a quiet boundary (or accept a leading negative diff)')
  notes.push('ledger daily files are assumed to be named by LOCAL calendar date (YYYY-MM-DD); UTC-named files would not be found')
  notes.push('auto-review and session-title usage is live-only: DSH session logs carry no usage for those requests, so they are reported but never compared')
  notes.push('seeded forks: inherited events are dropped only when the header has isSeeded=true AND the log holds a tagged session/end-seed marker')
  notes.push('failed/retried attempts: session logs record assistant/attempt without usage; usage streamed by a failed attempt exists only in the ledger and appears as a positive ledger-vs-log diff')
  if (ledger.estimatedUsage.count > 0) {
    notes.push(`estimated usage excluded from equality sums: ${ledger.estimatedUsage.count} ledger record(s)`)
  }
  if (ledger.other.count > 0 || ledger.other.records > 0) {
    notes.push(`ledger records with other purposes were excluded from equality: ${ledger.other.count} with real usage, ${ledger.other.records} in window`)
  }
  if (ledger.skipped.missingSessionId > 0) {
    notes.push(`ledger chat records without a sessionId were excluded from "persisted": ${ledger.skipped.missingSessionId}`)
  }
  if (ledger.skipped.missingActualUsage > 0) {
    notes.push(`ledger records without real (non-estimated) usage were excluded from sums: ${ledger.skipped.missingActualUsage}`)
  }
  if (ledger.skipped.missingTimestamp > 0 || ledger.skipped.invalidTimestamp > 0) {
    notes.push(`ledger records with missing/invalid ts were skipped: ${ledger.skipped.missingTimestamp} missing, ${ledger.skipped.invalidTimestamp} invalid`)
  }
  if (ledger.missingDirectory) {
    notes.push('no request ledger directory exists yet (plugin may not have written data, or --data-root is wrong)')
  }
  if (ledgerRead.missingDates.length > 0) {
    const shown = ledgerRead.missingDates.slice(0, 5).join(', ')
    const more = ledgerRead.missingDates.length > 5 ? ` (+${ledgerRead.missingDates.length - 5} more)` : ''
    notes.push(`no ledger file for local day(s): ${shown}${more}`)
  }
  if (sessions.seededSessionsWithoutCut > 0) {
    notes.push(`seeded session(s) without a tagged end-seed cut were counted in full: ${sessions.seededSessionsWithoutCut}`)
  }
  if (sessions.skippedInherited > 0) {
    notes.push(`inherited fork events dropped from session-log totals: ${sessions.skippedInherited}`)
  }
  if (sessions.capped || ledger.capped) {
    notes.push('a processing cap was reached; treat the verdict as partial evidence')
  }
  if (comparison.verdict === 'INCONCLUSIVE') {
    notes.push('no persisted or compaction usage was found on either side for this window; nothing to reconcile')
  }
  for (const warning of ledger.warnings) notes.push(`warning: ledger: ${warning}`)
  for (const warning of sessions.warnings) notes.push(`warning: ${warning}`)
  if (ledgerRead.corruptLines > 0) notes.push(`warning: ignored ${ledgerRead.corruptLines} corrupt ledger JSONL line(s)`)
  if (sessions.malformedLines > 0) notes.push(`warning: ignored ${sessions.malformedLines} malformed session JSONL line(s)`)

  const generatedAt = new Date(finiteNumber(options.now) ?? Date.now()).toISOString()
  return {
    generatedAt,
    window: {
      from: window.from,
      to: window.to,
      fromIso: window.fromIso,
      toIso: window.toIso,
      localFrom: window.localFrom,
      localTo: window.localTo,
    },
    profile,
    dataRoot,
    sessionsRoot,
    workspace,
    ledger,
    sessions,
    diffs: {
      persistedPrompt: comparison.diffs.persistedPrompt,
      persistedOutput: comparison.diffs.persistedOutput,
      persistedCount: comparison.diffs.persistedCount,
      compactionPrompt: comparison.diffs.compactionPrompt,
      compactionOutput: comparison.diffs.compactionOutput,
      compactionCount: comparison.diffs.compactionCount,
      perSession: comparison.perSession,
      perSessionTotal: comparison.perSessionTotal,
    },
    verdict: comparison.verdict,
    notes,
  }
}

// ---------------------------------------------------------------------------
// Human-readable output
// ---------------------------------------------------------------------------

function formatTable(header, rows) {
  const widths = header.map((cell, index) => Math.max(
    String(cell).length,
    ...rows.map(row => String(row[index] ?? '').length),
  ))
  const render = cells => cells
    .map((cell, index) => (index === 0
      ? String(cell).padEnd(widths[index])
      : String(cell).padStart(widths[index])))
    .join('  ')
    .replace(/\s+$/, '')
  return [
    render(header),
    render(widths.map(width => '-'.repeat(width))),
    ...rows.map(render),
  ]
}

/** Render the structured reconcile result as a human-readable report. */
export function renderHuman(result) {
  const lines = []
  lines.push(`dsh-token-attribution reconcile — ${result.generatedAt}`)
  lines.push(`window      ${result.window.localFrom} .. ${result.window.localTo}`)
  lines.push(`data root   ${result.dataRoot}`)
  lines.push(`sessions    ${result.sessionsRoot}`)
  if (result.workspace) lines.push(`workspace   ${result.workspace}`)
  lines.push('')

  const ledger = result.ledger
  const sessions = result.sessions
  lines.push(`ledger: ${ledger.files} file(s), ${ledger.recordsInWindow} record(s) in window, ${ledger.corruptLines} corrupt line(s)`)
  lines.push(`sessions: ${sessions.files} file(s), ${sessions.filesWithUsage} with usage, ${sessions.eventsInWindow} event(s) in window, ${sessions.malformedLines} malformed line(s)`)
  lines.push('')

  const rows = [
    ['ledger persisted (chat)', ledger.persisted.count, formatInteger(ledger.persisted.promptTokens), formatInteger(ledger.persisted.outputTokens)],
    ['session assistant/message', sessions.assistant.count, formatInteger(sessions.assistant.promptTokens), formatInteger(sessions.assistant.outputTokens)],
    ['ledger compaction', ledger.compaction.count, formatInteger(ledger.compaction.promptTokens), formatInteger(ledger.compaction.outputTokens)],
    ['session compaction/summary', sessions.compaction.count, formatInteger(sessions.compaction.promptTokens), formatInteger(sessions.compaction.outputTokens)],
    ['ledger auto-review (live-only)', ledger.autoReview.count, formatInteger(ledger.autoReview.promptTokens), formatInteger(ledger.autoReview.outputTokens)],
    ['ledger session-title (live-only)', ledger.sessionTitle.count, formatInteger(ledger.sessionTitle.promptTokens), formatInteger(ledger.sessionTitle.outputTokens)],
  ]
  lines.push(...formatTable(['source', 'requests', 'prompt tokens', 'output tokens'], rows))
  lines.push('')

  const diffs = result.diffs
  lines.push(`persisted  Δprompt ${formatDelta(diffs.persistedPrompt)}  Δoutput ${formatDelta(diffs.persistedOutput)}  Δcount ${formatDelta(diffs.persistedCount)}`)
  lines.push(`compaction Δprompt ${formatDelta(diffs.compactionPrompt)}  Δoutput ${formatDelta(diffs.compactionOutput)}  Δcount ${formatDelta(diffs.compactionCount)}`)
  if (diffs.perSession.length > 0) {
    lines.push('')
    lines.push(`per-session diffs (top ${diffs.perSession.length} of ${diffs.perSessionTotal}):`)
    const perSessionRows = diffs.perSession.map(entry => [
      entry.sessionId,
      formatInteger(entry.ledgerCount),
      formatInteger(entry.ledgerPrompt),
      formatInteger(entry.ledgerOutput),
      formatInteger(entry.sessionCount),
      formatInteger(entry.sessionPrompt),
      formatInteger(entry.sessionOutput),
      formatDelta(entry.promptDelta),
      formatDelta(entry.outputDelta),
    ])
    lines.push(...formatTable(
      ['sessionId', 'l.count', 'l.prompt', 'l.output', 's.count', 's.prompt', 's.output', 'Δprompt', 'Δoutput'],
      perSessionRows,
    ))
  }
  if (ledger.estimatedUsage.count > 0) {
    lines.push('')
    lines.push(`estimated usage (excluded from equality): ${ledger.estimatedUsage.count} record(s)`)
  }
  if (ledger.autoReview.count > 0 || ledger.sessionTitle.count > 0) {
    lines.push(`live-only requests: auto-review ${ledger.autoReview.count}, session-title ${ledger.sessionTitle.count}`)
  }
  lines.push('')
  lines.push(`VERDICT: ${result.verdict}`)
  if (result.notes.length > 0) {
    lines.push('')
    lines.push('notes:')
    for (const note of result.notes) lines.push(`- ${note}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: node scripts/reconcile.mjs [options]

Compares the dsh-token-attribution ledger against DSH session logs for one
controlled window (M1a acceptance A2/A4).

Options:
  --data-root <dir>      Plugin data directory
                         (default: %DSH_HOME%/token-attribution/data/<profile>)
  --sessions-root <dir>  DSH sessions directory (default: %DSH_HOME%/sessions)
  --workspace <slug>     Only scan this workspace slug under the sessions root
  --from <ISO|epoch-ms>  Window start, inclusive (default: today local 00:00)
  --to <ISO|epoch-ms>    Window end, inclusive (default: now)
  --profile <name>       Profile name for the default data root
                         (default: DSH_PROFILE, else "default")
  --max-files <n>        Session-log candidate cap, newest files first
                         (default: 200)
  --max-events <n>       Parsed session-event cap (default: 2000000)
  --json                 Print the structured result as JSON
  -h, --help             Show this help

Exit codes: 0 = PASS or INCONCLUSIVE, 1 = FAIL, 2 = usage/environment error.`

const VALUE_FLAGS = new Map([
  ['--data-root', 'dataRoot'],
  ['--sessions-root', 'sessionsRoot'],
  ['--workspace', 'workspace'],
  ['--from', 'from'],
  ['--to', 'to'],
  ['--profile', 'profile'],
  ['--max-files', 'maxFiles'],
  ['--max-events', 'maxEvents'],
])

/** Parse CLI arguments; throws {@link ReconcileError} for unknown/malformed flags. */
export function parseArgs(argv) {
  const args = { json: false, help: false }
  const seen = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]
    let flag = raw
    let inline
    if (raw.startsWith('--')) {
      const equals = raw.indexOf('=')
      if (equals !== -1) {
        flag = raw.slice(0, equals)
        inline = raw.slice(equals + 1)
      }
    }
    if (flag === '--help' || flag === '-h') {
      args.help = true
      continue
    }
    if (flag === '--json') {
      if (inline !== undefined) throw new ReconcileError('--json does not take a value')
      args.json = true
      continue
    }
    const key = VALUE_FLAGS.get(flag)
    if (key === undefined) throw new ReconcileError(`unknown argument: ${raw}`)
    let value = inline
    if (value === undefined) {
      value = argv[index + 1]
      index += 1
      if (value === undefined) throw new ReconcileError(`${flag} requires a value`)
    }
    if (value === '') throw new ReconcileError(`${flag} requires a non-empty value`)
    if (seen.has(key)) throw new ReconcileError(`${flag} was specified more than once`)
    seen.add(key)
    args[key] = value
  }
  return args
}

/** Resolve `%DSH_HOME%`, profile, and default roots from the environment. */
export function resolveDefaults(env = process.env, home = os.homedir()) {
  const expand = value => {
    if (value === '~') return home
    if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(home, value.slice(2))
    return value
  }
  const dshHome = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== ''
    ? path.resolve(expand(env.DSH_HOME.trim()))
    : path.join(home, '.dsh')
  const profile = typeof env.DSH_PROFILE === 'string' && env.DSH_PROFILE.trim() !== ''
    ? env.DSH_PROFILE.trim()
    : 'default'
  return {
    dshHome,
    profile,
    dataRoot: path.join(dshHome, 'token-attribution', 'data', profile),
    sessionsRoot: path.join(dshHome, 'sessions'),
  }
}

/**
 * Run the CLI without exiting the process (the module guard maps the result
 * to a process exit code). Exported for tests and embedding.
 * @returns {{code:number,output:string,result?:object}}
 */
export function runCli(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv)
  if (args.help) return { code: 0, output: USAGE }
  const defaults = resolveDefaults(env)
  const profile = args.profile ?? defaults.profile
  const dataRoot = path.resolve(args.dataRoot ?? path.join(defaults.dshHome, 'token-attribution', 'data', profile))
  const sessionsRoot = path.resolve(args.sessionsRoot ?? defaults.sessionsRoot)
  const window = parseWindow({ from: args.from, to: args.to })
  const limits = {}
  for (const [flag, key] of [['--max-files', 'maxFiles'], ['--max-events', 'maxEvents']]) {
    const raw = args[key]
    if (raw === undefined) continue
    const value = Number(raw)
    if (!Number.isInteger(value) || value < 1) throw new ReconcileError(`${flag} must be a positive integer`)
    limits[key] = value
  }
  const result = reconcile({
    dataRoot,
    sessionsRoot,
    window,
    profile,
    workspace: args.workspace ?? null,
    limits,
  })
  const output = args.json ? JSON.stringify(result, null, 2) : renderHuman(result)
  return { code: result.verdict === 'FAIL' ? 1 : 0, output, result }
}

const invokedHref = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null
if (invokedHref !== null && import.meta.url === invokedHref) {
  try {
    const { code, output } = runCli(process.argv.slice(2))
    if (output !== '') process.stdout.write(`${output}\n`)
    process.exitCode = code
  } catch (error) {
    if (error instanceof ReconcileError) {
      process.stderr.write(`reconcile: ${error.message}\n`)
    } else if (process.env.DSH_RECONCILE_DEBUG) {
      process.stderr.write(`${error?.stack ?? error}\n`)
    } else {
      process.stderr.write(`reconcile: unexpected error: ${error?.message ?? String(error)}\n`)
    }
    process.exitCode = 2
  }
}
