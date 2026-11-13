import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

import {
  aggregateLedger,
  compare,
  decompressSessionLog,
  discoverSessionLogs,
  extractUsageEvents,
  localDayKey,
  parseWindow,
  readLedgerRecords,
  reconcile,
  walkZstdFrames,
} from '../scripts/reconcile.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, '..', 'scripts', 'reconcile.mjs')

/** Create a temp directory removed when the test finishes. */
function makeTempDir(t, prefix = 'dsh-reconcile-') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

/** One local wall-clock instant, independent of the machine timezone. */
function localEpoch(year, monthIndex, day, hour = 12, minute = 0, second = 0, millisecond = 0) {
  return new Date(year, monthIndex, day, hour, minute, second, millisecond).getTime()
}

/** Concatenate independently compressed zstd frames, one per line. */
function encodeZstdFrames(lines) {
  return Buffer.concat(lines.map(line => zlib.zstdCompressSync(Buffer.from(`${line}\n`))))
}

function writeSessionLog(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, encodeZstdFrames(records.map(record => JSON.stringify(record))))
}

let cliRunCounter = 0

/**
 * Spawn the CLI with stdout/stderr backed by regular files instead of pipes.
 * Piped stdio is blocked in some confined environments; file handles are not.
 */
function runCliProcess(args) {
  cliRunCounter += 1
  const outFile = path.join(os.tmpdir(), `dsh-reconcile-cli-${process.pid}-${cliRunCounter}.out.log`)
  const errFile = path.join(os.tmpdir(), `dsh-reconcile-cli-${process.pid}-${cliRunCounter}.err.log`)
  const outFd = fs.openSync(outFile, 'w')
  const errFd = fs.openSync(errFile, 'w')
  try {
    const spawned = spawnSync(process.execPath, args, {
      stdio: ['ignore', outFd, errFd],
      timeout: 30_000,
      windowsHide: true,
    })
    return {
      status: spawned.status,
      stdout: fs.readFileSync(outFile, 'utf8'),
      stderr: fs.readFileSync(errFile, 'utf8'),
      error: spawned.error,
    }
  } finally {
    fs.closeSync(outFd)
    fs.closeSync(errFd)
    fs.rmSync(outFile, { force: true })
    fs.rmSync(errFile, { force: true })
  }
}

test('zstd walker splits independent frames and decompression rebuilds JSONL', t => {
  const directory = makeTempDir(t)
  const file = path.join(directory, 'session.v4.jsonl.zstd')
  const lines = ['{"event":1}', '{"event":2}', '{"event":3}']
  fs.writeFileSync(file, encodeZstdFrames(lines))

  const raw = fs.readFileSync(file)
  const walked = walkZstdFrames(raw)
  assert.equal(walked.frames.length, 3)
  assert.deepEqual(walked.warnings, [])
  const total = walked.frames.reduce((sum, frame) => sum + frame.length, 0)
  assert.equal(total, raw.length)

  const decoded = decompressSessionLog(file)
  assert.equal(decoded.frameCount, 3)
  assert.deepEqual(decoded.lines, lines)
  assert.deepEqual(decoded.warnings, [])
  assert.ok(decoded.text.endsWith('\n'))
})

test('zstd walker reports a torn tail as a warning, not a crash', t => {
  const directory = makeTempDir(t)
  const file = path.join(directory, 'torn.v4.jsonl.zstd')
  const valid = encodeZstdFrames(['{"event":1}'])
  fs.writeFileSync(file, Buffer.concat([valid, Buffer.from([0x28, 0xb5, 0x2f])]))

  const decoded = decompressSessionLog(file)
  assert.equal(decoded.frameCount, 1)
  assert.deepEqual(decoded.lines, ['{"event":1}'])
  assert.equal(decoded.warnings.length, 1)
  assert.match(decoded.warnings[0], /truncated zstd frame/)
})

test('extractUsageEvents counts assistant + compaction usage inside the window only', () => {
  const ts = localEpoch(2026, 10, 11)
  const from = ts - 3_600_000
  const to = ts + 3_600_000
  const records = [
    { type: 'session', version: 4, id: 'sess-a', createdAt: ts, isSeeded: false, delegationDepth: 0 },
    {
      type: 'assistant/message',
      seq: 1,
      time: ts,
      data: { usage: { inputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 5, outputTokens: 7, reasoningTokens: 3 } },
    },
    {
      type: 'assistant/message',
      seq: 2,
      time: ts + 10_000_000,
      data: { usage: { inputTokens: 999, outputTokens: 999 } },
    },
    { type: 'assistant/message', seq: 3, time: ts, data: {} },
    { type: 'compaction/summary', seq: 4, time: ts, data: { usage: { inputTokens: 40, outputTokens: 5 } } },
  ]
  const lines = [JSON.stringify(records[0]), JSON.stringify(records[1]), '{not json', ...records.slice(2).map(record => JSON.stringify(record))]

  const extracted = extractUsageEvents(lines, { from, to })
  assert.equal(extracted.header.id, 'sess-a')
  assert.equal(extracted.events.total, 4)
  assert.equal(extracted.events.inWindow, 3)
  assert.equal(extracted.events.malformed, 1)
  assert.equal(extracted.events.truncated, false)
  assert.equal(extracted.skippedOutsideWindow, 1)

  assert.equal(extracted.assistant.count, 1)
  assert.equal(extracted.assistant.promptTokens, 125)
  assert.equal(extracted.assistant.outputTokens, 7)
  assert.equal(extracted.assistant.inputTokens, 100)
  assert.equal(extracted.assistant.cacheReadTokens, 20)
  assert.equal(extracted.assistant.cacheWriteTokens, 5)
  assert.equal(extracted.assistant.reasoningTokens, 3)
  assert.equal(extracted.assistantWithoutUsage, 1)

  assert.equal(extracted.compaction.count, 1)
  assert.equal(extracted.compaction.promptTokens, 40)
  assert.equal(extracted.compaction.outputTokens, 5)
  assert.equal(extracted.seedCutSeq, null)
  assert.deepEqual(extracted.warnings, [])
})

test('extractUsageEvents drops the inherited prefix of a seeded fork', () => {
  const ts = localEpoch(2026, 10, 11)
  const from = ts - 3_600_000
  const to = ts + 3_600_000
  const lines = [
    { type: 'session', version: 4, id: 'fork-1', createdAt: ts, isSeeded: true, delegationDepth: 1, parentSession: 'sess-a' },
    { type: 'assistant/message', seq: 1, time: ts, data: { usage: { inputTokens: 1000, outputTokens: 100 } } },
    { type: 'session/end-seed', seq: 2, time: ts, data: { inherited: true } },
    { type: 'assistant/message', seq: 3, time: ts, data: { usage: { inputTokens: 5, outputTokens: 1 } } },
    // A later untagged end-seed is an ordinary restore marker and must not extend the cut.
    { type: 'session/end-seed', seq: 4, time: ts, data: {} },
    { type: 'assistant/message', seq: 5, time: ts, data: { usage: { inputTokens: 7, outputTokens: 2 } } },
  ].map(record => JSON.stringify(record))

  const extracted = extractUsageEvents(lines, { from, to })
  assert.equal(extracted.seedCutSeq, 2)
  assert.equal(extracted.assistant.count, 2)
  assert.equal(extracted.assistant.promptTokens, 12)
  assert.equal(extracted.assistant.outputTokens, 3)
  assert.equal(extracted.skippedInherited, 2)
  assert.deepEqual(extracted.warnings, [])
})

test('extractUsageEvents warns when a seeded session has no tagged cut', () => {
  const ts = localEpoch(2026, 10, 11)
  const lines = [
    { type: 'session', version: 4, id: 'fork-2', createdAt: ts, isSeeded: true, delegationDepth: 1 },
    { type: 'assistant/message', seq: 1, time: ts, data: { usage: { inputTokens: 9, outputTokens: 3 } } },
  ].map(record => JSON.stringify(record))

  const extracted = extractUsageEvents(lines, { from: ts - 1000, to: ts + 1000 })
  assert.equal(extracted.seedCutSeq, null)
  assert.equal(extracted.assistant.count, 1)
  assert.equal(extracted.assistant.promptTokens, 9)
  assert.equal(extracted.warnings.length, 1)
  assert.match(extracted.warnings[0], /no tagged session\/end-seed marker/)
})

test('aggregateLedger sums by purpose with window filtering and corrupt-line counting', t => {
  const directory = makeTempDir(t)
  const dataRoot = path.join(directory, 'data')
  const requestsDir = path.join(dataRoot, 'requests')
  fs.mkdirSync(requestsDir, { recursive: true })

  const dayOne = localEpoch(2026, 10, 10)
  const dayTwo = localEpoch(2026, 10, 11)
  const from = localEpoch(2026, 10, 10, 0, 0, 0, 0)
  const to = localEpoch(2026, 10, 11, 23, 59, 59, 999)
  const dayOneRecords = [
    { v: 1, ts: dayOne, id: 'r1', sessionId: 's1', purpose: 'chat', usage: { input: 10, cacheRead: 5, cacheWrite: 0, output: 2 }, promptTokens: 15 },
    // Stray record in the day-one file whose ts is before the window: must be filtered.
    { v: 1, ts: from - 1, id: 'r0', sessionId: 's1', purpose: 'chat', usage: { input: 999, output: 999 } },
  ]
  const dayTwoRecords = [
    { v: 1, ts: dayTwo + 1, id: 'r2', sessionId: 's1', purpose: 'chat', usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 }, promptTokens: 1 },
    { v: 1, ts: dayTwo + 2, id: 'r3', sessionId: 's1', usage: { input: 2, output: 3 } },
    { v: 1, ts: dayTwo + 3, id: 'r4', purpose: 'chat', usage: { input: 9, output: 9 } },
    { v: 1, ts: dayTwo + 4, id: 'r5', sessionId: 's2', purpose: 'chat', usage: { input: 7, output: 1 }, usageEstimated: true },
    { v: 1, ts: dayTwo + 5, id: 'r6', sessionId: 's1', purpose: 'compaction', usage: { input: 40, output: 5 } },
    { v: 1, ts: dayTwo + 6, id: 'r7', sessionId: 's1', purpose: 'auto-review', usage: { input: 50, output: 6 } },
    { v: 1, ts: dayTwo + 7, id: 'r8', sessionId: 's1', purpose: 'session-title', usage: { input: 30, output: 4 } },
    { v: 1, ts: dayTwo + 8, id: 'r9', sessionId: 's1', purpose: 'translation', usage: { input: 20, output: 2 } },
  ]
  fs.writeFileSync(path.join(requestsDir, `${localDayKey(dayOne)}.jsonl`), `${dayOneRecords.map(record => JSON.stringify(record)).join('\n')}\n`)
  fs.writeFileSync(path.join(requestsDir, `${localDayKey(dayTwo)}.jsonl`), `${dayTwoRecords.map(record => JSON.stringify(record)).join('\n')}\n{corrupt\n`)

  const read = readLedgerRecords(dataRoot, { from, to })
  assert.equal(read.files, 2)
  assert.equal(read.missingDirectory, false)
  assert.equal(read.corruptLines, 1)
  assert.deepEqual(read.missingDates, [])

  const ledger = aggregateLedger(read.records, { from, to, files: read.files, corruptLines: read.corruptLines })
  assert.equal(ledger.recordsInWindow, 9)
  assert.equal(ledger.records, 10)
  assert.equal(ledger.corruptLines, 1)

  assert.equal(ledger.persisted.count, 3)
  assert.equal(ledger.persisted.promptTokens, 18)
  assert.equal(ledger.persisted.outputTokens, 6)
  assert.equal(ledger.persisted.records, 5)
  assert.deepEqual(ledger.bySession.s1, { count: 3, promptTokens: 18, outputTokens: 6 })

  assert.equal(ledger.compaction.count, 1)
  assert.equal(ledger.compaction.promptTokens, 40)
  assert.equal(ledger.compaction.outputTokens, 5)
  assert.equal(ledger.autoReview.count, 1)
  assert.equal(ledger.autoReview.promptTokens, 50)
  assert.equal(ledger.sessionTitle.count, 1)
  assert.equal(ledger.sessionTitle.promptTokens, 30)
  assert.equal(ledger.other.count, 1)
  assert.equal(ledger.other.promptTokens, 20)
  assert.equal(ledger.otherByPurpose.translation.promptTokens, 20)

  assert.equal(ledger.estimatedUsage.count, 1)
  assert.equal(ledger.estimatedUsage.byPurpose.chat, 1)
  assert.equal(ledger.persisted.estimatedCount, 1)
  assert.equal(ledger.skipped.missingSessionId, 1)
  assert.equal(ledger.skipped.missingActualUsage, 1)
})

test('readLedgerRecords reports a missing requests directory without throwing', t => {
  const directory = makeTempDir(t)
  const dataRoot = path.join(directory, 'data')
  fs.mkdirSync(dataRoot, { recursive: true })
  const read = readLedgerRecords(dataRoot, { from: 0, to: 1 })
  assert.equal(read.missingDirectory, true)
  assert.equal(read.files, 0)
  assert.deepEqual(read.records, [])
  assert.equal(read.warnings.length, 1)
  assert.match(read.warnings[0], /no request ledger directory/)
})

test('compare returns PASS on exact equality and FAIL with per-session diffs', () => {
  const ledger = {
    persisted: { count: 1, promptTokens: 15, outputTokens: 2 },
    compaction: { count: 1, promptTokens: 40, outputTokens: 5 },
    bySession: { s1: { count: 1, promptTokens: 15, outputTokens: 2 } },
  }
  const sessions = {
    assistant: { count: 1, promptTokens: 15, outputTokens: 2 },
    compaction: { count: 1, promptTokens: 40, outputTokens: 5 },
    bySession: { s1: { count: 1, promptTokens: 15, outputTokens: 2 } },
  }

  const pass = compare(ledger, sessions)
  assert.equal(pass.verdict, 'PASS')
  assert.deepEqual(pass.diffs, {
    persistedPrompt: 0,
    persistedOutput: 0,
    persistedCount: 0,
    compactionPrompt: 0,
    compactionOutput: 0,
    compactionCount: 0,
  })
  assert.deepEqual(pass.perSession, [])

  const shiftedSessions = {
    ...sessions,
    assistant: { count: 1, promptTokens: 15, outputTokens: 3 },
    bySession: { s1: { count: 1, promptTokens: 15, outputTokens: 3 } },
  }
  const fail = compare(ledger, shiftedSessions)
  assert.equal(fail.verdict, 'FAIL')
  assert.equal(fail.diffs.persistedOutput, -1)
  assert.equal(fail.diffs.persistedPrompt, 0)
  assert.equal(fail.perSession.length, 1)
  assert.equal(fail.perSession[0].sessionId, 's1')
  assert.equal(fail.perSession[0].outputDelta, -1)
  assert.equal(fail.perSession[0].ledgerOutput, 2)
  assert.equal(fail.perSession[0].sessionOutput, 3)

  const empty = compare({ persisted: { count: 0, promptTokens: 0, outputTokens: 0 } }, { assistant: { count: 0, promptTokens: 0, outputTokens: 0 } })
  assert.equal(empty.verdict, 'INCONCLUSIVE')
})

test('parseWindow defaults to local midnight..now and validates bounds', () => {
  const now = localEpoch(2026, 10, 11, 15, 30)
  const window = parseWindow({ now })
  assert.equal(window.from, localEpoch(2026, 10, 11, 0, 0, 0, 0))
  assert.equal(window.to, now)
  assert.match(window.localFrom, /^2026-11-11T00:00:00\.000[+-]\d{2}:\d{2}$/)

  const explicit = parseWindow({ from: String(now - 1000), to: new Date(now).toISOString(), now })
  assert.equal(explicit.from, now - 1000)
  assert.equal(explicit.to, now)

  assert.throws(() => parseWindow({ from: now, to: now - 1, now }), /is after window end/)
  assert.throws(() => parseWindow({ from: 'not-a-date' }), /invalid window start/)
  assert.throws(() => parseWindow({ from: undefined, to: 'x' }), /invalid window end/)
})

test('reconcile() matches a ledger against a session log end to end', t => {
  const directory = makeTempDir(t)
  const dataRoot = path.join(directory, 'data')
  const sessionsRoot = path.join(directory, 'sessions')
  const ts = localEpoch(2026, 10, 11)
  const ledgerFile = path.join(dataRoot, 'requests', `${localDayKey(ts)}.jsonl`)
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true })
  const ledgerRecord = {
    v: 1,
    ts,
    id: 'req-1',
    sessionId: 'sess-e2e',
    purpose: 'chat',
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    usage: { input: 100, cacheRead: 20, cacheWrite: 5, output: 7, reasoning: 3 },
    usageEstimated: false,
    promptTokens: 125,
  }
  fs.writeFileSync(ledgerFile, `${JSON.stringify(ledgerRecord)}\n`)
  writeSessionLog(path.join(sessionsRoot, 'default-workspace', 'sess-e2e', 'session.v4.jsonl.zstd'), [
    { type: 'session', version: 4, id: 'sess-e2e', createdAt: ts, isSeeded: false, delegationDepth: 0 },
    { type: 'assistant/message', seq: 1, time: ts, data: { usage: { inputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 5, outputTokens: 7, reasoningTokens: 3 } } },
  ])

  const result = reconcile({
    dataRoot,
    sessionsRoot,
    window: parseWindow({ from: ts - 60_000, to: ts + 60_000 }),
  })
  assert.equal(result.verdict, 'PASS')
  assert.equal(result.ledger.persisted.count, 1)
  assert.equal(result.ledger.persisted.promptTokens, 125)
  assert.equal(result.ledger.persisted.outputTokens, 7)
  assert.equal(result.sessions.assistant.count, 1)
  assert.equal(result.sessions.assistant.promptTokens, 125)
  assert.equal(result.sessions.assistant.outputTokens, 7)
  assert.equal(result.diffs.persistedPrompt, 0)
  assert.equal(result.diffs.persistedOutput, 0)
  assert.equal(result.diffs.persistedCount, 0)
  assert.deepEqual(result.diffs.perSession, [])
  assert.ok(result.notes.some(note => note.includes('clock skew tolerance: 0 ms')))
  assert.ok(result.notes.some(note => note.includes('activation boundary')))
})

test('discoverSessionLogs caps newest logs first, not the lexicographic prefix', t => {
  const directory = makeTempDir(t)
  const sessionsRoot = path.join(directory, 'sessions')
  const makeLog = (name, mtime) => {
    const file = path.join(sessionsRoot, 'workspace', name, 'session.v4.jsonl.zstd')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, encodeZstdFrames(['{}']))
    fs.utimesSync(file, new Date(mtime), new Date(mtime))
    return file
  }
  const oldest = makeLog('aaa-oldest', 1_000)
  const newest = makeLog('mmm-newest', 3_000)
  const middle = makeLog('zzz-middle', 2_000)

  const capped = discoverSessionLogs(sessionsRoot, { maxFiles: 2 })
  assert.equal(capped.files.length, 2)
  assert.equal(capped.capped, true)
  assert.ok(capped.files.includes(newest))
  assert.ok(capped.files.includes(middle))
  assert.ok(!capped.files.includes(oldest))
  assert.ok(capped.warnings.some(warning => warning.includes('session log cap')))
})

test('per-session session-log counts aggregate every assistant event', t => {
  const directory = makeTempDir(t)
  const dataRoot = path.join(directory, 'data')
  const sessionsRoot = path.join(directory, 'sessions')
  const ts = localEpoch(2026, 10, 11)
  const ledgerFile = path.join(dataRoot, 'requests', `${localDayKey(ts)}.jsonl`)
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true })
  const usage = { input: 10, cacheRead: 5, cacheWrite: 0, output: 2 }
  const records = [1, 2].map(n => ({
    v: 1,
    ts: ts + n,
    id: `req-${n}`,
    sessionId: 'sess-multi',
    purpose: 'chat',
    usage,
    usageEstimated: false,
    promptTokens: 15,
    outputTokens: 2,
  }))
  fs.writeFileSync(ledgerFile, `${records.map(record => JSON.stringify(record)).join('\n')}\n`)
  writeSessionLog(path.join(sessionsRoot, 'workspace', 'sess-multi', 'session.v4.jsonl.zstd'), [
    { type: 'session', version: 4, id: 'sess-multi', createdAt: ts, isSeeded: false, delegationDepth: 0 },
    { type: 'assistant/message', seq: 1, time: ts + 1, data: { usage: { inputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 0, outputTokens: 2 } } },
    { type: 'assistant/message', seq: 2, time: ts + 2, data: { usage: { inputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 0, outputTokens: 2 } } },
  ])

  const result = reconcile({ dataRoot, sessionsRoot, window: parseWindow({ from: ts - 60_000, to: ts + 60_000 }) })
  assert.equal(result.verdict, 'PASS')
  assert.equal(result.sessions.bySession['sess-multi'].count, 2)
  assert.equal(result.sessions.bySession['sess-multi'].promptTokens, 30)
  assert.equal(result.sessions.bySession['sess-multi'].outputTokens, 4)
})

test('CLI --json exits 0 on PASS, 1 on FAIL, 2 on a missing data root', t => {
  const directory = makeTempDir(t)
  const dataRoot = path.join(directory, 'data')
  const sessionsRoot = path.join(directory, 'sessions')
  const ts = localEpoch(2026, 10, 11)
  const day = localDayKey(ts)
  const requestsDir = path.join(dataRoot, 'requests')
  fs.mkdirSync(requestsDir, { recursive: true })
  const ledgerFile = path.join(requestsDir, `${day}.jsonl`)
  const ledgerRecord = {
    v: 1,
    ts,
    sessionId: 'sess-cli',
    purpose: 'chat',
    usage: { input: 100, cacheRead: 20, cacheWrite: 5, output: 7 },
    promptTokens: 125,
  }
  fs.writeFileSync(ledgerFile, `${JSON.stringify(ledgerRecord)}\n`)
  const sessionFile = path.join(sessionsRoot, 'default-workspace', 'sess-cli', 'session.v4.jsonl.zstd')
  writeSessionLog(sessionFile, [
    { type: 'session', version: 4, id: 'sess-cli', createdAt: ts, isSeeded: false, delegationDepth: 0 },
    { type: 'assistant/message', seq: 1, time: ts, data: { usage: { inputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 5, outputTokens: 7 } } },
  ])

  const baseArgs = [
    SCRIPT,
    '--data-root', dataRoot,
    '--sessions-root', sessionsRoot,
    '--from', String(ts - 60_000),
    '--to', String(ts + 60_000),
    '--json',
  ]
  const pass = runCliProcess(baseArgs)
  assert.equal(pass.error, undefined, String(pass.error))
  assert.equal(pass.status, 0, pass.stderr)
  const passResult = JSON.parse(pass.stdout)
  assert.equal(passResult.verdict, 'PASS')
  assert.equal(passResult.ledger.persisted.count, 1)
  assert.equal(passResult.ledger.persisted.promptTokens, 125)
  assert.equal(passResult.sessions.assistant.promptTokens, 125)
  assert.equal(passResult.diffs.persistedPrompt, 0)
  assert.equal(passResult.diffs.persistedOutput, 0)
  assert.equal(passResult.window.from, ts - 60_000)
  assert.equal(passResult.window.to, ts + 60_000)
  assert.equal(passResult.dataRoot, path.resolve(dataRoot))
  assert.equal(passResult.sessionsRoot, path.resolve(sessionsRoot))
  assert.ok(Array.isArray(passResult.notes))

  // One output token more on the ledger side must flip the verdict to FAIL.
  fs.writeFileSync(ledgerFile, `${JSON.stringify({ ...ledgerRecord, outputTokens: 8 })}\n`)
  const fail = runCliProcess(baseArgs)
  assert.equal(fail.error, undefined, String(fail.error))
  assert.equal(fail.status, 1, fail.stderr)
  const failResult = JSON.parse(fail.stdout)
  assert.equal(failResult.verdict, 'FAIL')
  assert.equal(failResult.diffs.persistedOutput, 1)
  assert.equal(failResult.diffs.perSession.length, 1)
  assert.equal(failResult.diffs.perSession[0].sessionId, 'sess-cli')

  // --workspace restricts the session scan; a wrong slug yields no session data.
  const wrongWorkspace = runCliProcess([...baseArgs, '--workspace', 'other-workspace'])
  assert.equal(wrongWorkspace.error, undefined, String(wrongWorkspace.error))
  assert.equal(wrongWorkspace.status, 1, wrongWorkspace.stderr)
  const wrongWorkspaceResult = JSON.parse(wrongWorkspace.stdout)
  assert.equal(wrongWorkspaceResult.sessions.files, 0)
  assert.equal(wrongWorkspaceResult.verdict, 'FAIL')

  const missingRoot = runCliProcess([
    SCRIPT,
    '--data-root', path.join(directory, 'does-not-exist'),
    '--sessions-root', sessionsRoot,
    '--from', String(ts - 60_000),
    '--to', String(ts + 60_000),
  ])
  assert.equal(missingRoot.error, undefined, String(missingRoot.error))
  assert.equal(missingRoot.status, 2)
  assert.match(missingRoot.stderr, /data root not found/)
  assert.doesNotMatch(missingRoot.stderr, /\n\s+at /)

  // No data on either side is INCONCLUSIVE and exits 0, not 1.
  const emptyDataRoot = path.join(directory, 'empty-data')
  const emptySessionsRoot = path.join(directory, 'empty-sessions')
  fs.mkdirSync(emptyDataRoot, { recursive: true })
  fs.mkdirSync(emptySessionsRoot, { recursive: true })
  const inconclusive = runCliProcess([
    SCRIPT,
    '--data-root', emptyDataRoot,
    '--sessions-root', emptySessionsRoot,
    '--from', String(ts - 60_000),
    '--to', String(ts + 60_000),
    '--json',
  ])
  assert.equal(inconclusive.error, undefined, String(inconclusive.error))
  assert.equal(inconclusive.status, 0, inconclusive.stderr)
  assert.equal(JSON.parse(inconclusive.stdout).verdict, 'INCONCLUSIVE')
})
