import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { DEFAULT_PRICING_OFF_PEAK_DAYS, cloneDefaultConfig } from '../src/host/config.mjs'
import {
  AUTO_REVIEW_CATEGORY_VERSION,
  MAX_SUMMARY_SESSIONS,
  MAX_WEB_API_SESSIONS,
  MAX_WEB_API_SESSION_ROWS,
  addRecordToAggregate,
  createDayAggregate,
  createStore,
  pricingFingerprint,
} from '../src/host/store.mjs'
import { atomicWriteFileSync, dayKey, dayKeysBetween, ensureDir, shiftDays } from '../src/host/util.mjs'

const tempHome = (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dta-store-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  return home
}

const makeConfig = (overrides = {}) => ({
  ...cloneDefaultConfig(),
  flushIntervalMs: 60000,
  ...overrides,
})

/**
 * Epoch milliseconds for a wall-clock time in Beijing (UTC+8). Tests use it to
 * select peak/off-peak deterministically regardless of the host timezone.
 * @param {string} day - `YYYY-MM-DD` Beijing day key.
 * @param {string} [time] - `HH:MM` Beijing wall-clock time.
 * @returns {number} epoch milliseconds.
 */
const beijingTs = (day, time = '09:30') => Date.parse(`${day}T${time}:00+08:00`)

/**
 * Day key of the most recent Monday-Friday strictly before today, so a seeded
 * record can be priced at peak (09:30 Beijing on a weekday) while staying well
 * inside the 30-day detail-retention window. Default statutory holidays are
 * skipped because they are priced off-peak.
 * @returns {string} `YYYY-MM-DD` day key.
 */
const recentWeekdayDay = () => {
  let day = shiftDays(dayKey(Date.now()), -1)
  for (let attempt = 0; attempt < 24; attempt += 1) {
    // Beijing noon on that calendar day maps to 04:00 UTC the same date, so
    // the UTC weekday is the Beijing weekday.
    const weekday = new Date(`${day}T12:00:00+08:00`).getUTCDay()
    if (weekday >= 1 && weekday <= 5 && !DEFAULT_PRICING_OFF_PEAK_DAYS.includes(day)) return day
    day = shiftDays(day, -1)
  }
  return day
}

/**
 * Write a `meta.json` whose pricing fingerprint already matches `config`, so a
 * store opened by a test that seeds detail rows does not reprice them.
 * @param {string} home - temporary DSH home.
 * @param {object} config - store config.
 * @param {object} [fields] - extra meta fields.
 * @returns {string} absolute data root.
 */
const writeMetaFor = (home, config, fields = {}) => {
  const dataRoot = path.join(home, 'token-attribution', 'data', 'test')
  ensureDir(dataRoot)
  atomicWriteFileSync(path.join(dataRoot, 'meta.json'), JSON.stringify({
    v: 1,
    schemaVersion: 1,
    createdAt: Date.now(),
    installedVersion: '0.1.0',
    estimatorVersion: 'char-v1',
    lastFlush: null,
    profile: 'test',
    profileSource: 'fallback',
    pricingFingerprint: pricingFingerprint(config.pricing, config.pricingOffPeakDays),
    ...fields,
  }))
  return dataRoot
}

const makeRecord = (overrides = {}) => {
  const ts = overrides.ts ?? Date.now()
  return {
    v: 1,
    ts,
    id: overrides.id ?? `id-${ts}`,
    sessionId: 's1',
    parentSessionId: null,
    delegationDepth: 0,
    origin: null,
    preset: null,
    purpose: 'chat',
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    reasoningEffort: null,
    attempt: { index: 1, retryId: null, error: false },
    usage: { input: 90, cacheRead: 10, cacheWrite: 0, output: 10, reasoning: 5 },
    usageEstimated: false,
    promptTokens: 100,
    outputTokens: 10,
    estimatedPromptTokens: 95,
    estimateScale: 1.05,
    estimatorVersion: 'char-v1',
    systemNodes: [],
    categories: { user: 50, 'system:base': 20, 'tool-result:other:read': 30 },
    images: { count: 0, visualTokens: 0, textTokens: 0 },
    files: 0,
    cost: { amount: 0.01, priced: true, currency: 'CNY', priceVersion: 'test' },
    finish: 'stop',
    durationMs: 100,
    error: null,
    ...overrides,
  }
}

const totalsOf = summary => JSON.parse(JSON.stringify({
  totals: summary.totals,
  byCategory: summary.byCategory,
  byToolGroup: summary.byToolGroup,
  bySession: summary.bySession,
  cache: summary.cache,
}))

test('dayKeysBetween spans the full ten-year retention window', () => {
  // Fixed dates: 2024 is a leap year, so 2024-01-01..2025-12-31 is 731 days.
  const days = dayKeysBetween('2024-01-01', '2025-12-31')
  assert.equal(days.length, 731)
  assert.equal(days[0], '2024-01-01')
  assert.equal(days[days.length - 1], '2025-12-31')
  assert.equal(new Set(days).size, days.length, 'no day is repeated')
  assert.equal(days.filter(day => day === '2024-02-29').length, 1, 'leap day is included')

  const longRange = dayKeysBetween('2016-01-01', '2025-12-31')
  assert.ok(longRange.length > 500, 'a 500+ day range is not truncated by the default cap')
  assert.equal(new Set(longRange).size, longRange.length)
  assert.equal(dayKeysBetween('2024-01-01', '2025-12-31', 10).length, 10, 'an explicit cap still applies')
})

test('append/flush writes detail, daily, meta, pointer, and lock files', (t) => {
  const home = tempHome(t)
  const config = makeConfig()
  const store = createStore({ config, homeDir: home, profile: 'test' })
  const now = Date.now()
  const first = makeRecord({ id: 'r1', ts: now - 1000 })
  const second = makeRecord({
    id: 'r2',
    ts: now,
    sessionId: 's2',
    purpose: 'auto-review',
    promptTokens: 50,
    outputTokens: 5,
    categories: { 'injected:memory-snapshot': 50 },
    usage: { input: 40, cacheRead: 10, cacheWrite: 0, output: 5 },
    usageEstimated: false,
    cost: { amount: 0, priced: false, currency: 'CNY', priceVersion: 'none' },
  })
  assert.equal(store.append(first), true)
  assert.equal(store.append(second), true)
  store.flushNow()
  assert.equal(store.getState().pending, 0)

  const state = store.getState()
  const day = dayKey(first.ts)
  assert.ok(fs.existsSync(path.join(home, 'token-attribution', 'state', 'test', 'pointer.json')))
  assert.ok(fs.existsSync(path.join(home, 'token-attribution', 'state', 'test', 'lock')))
  assert.ok(fs.existsSync(path.join(state.dataRoot, 'meta.json')))
  const detailFile = path.join(state.dataRoot, 'requests', `${day}.jsonl`)
  const dailyFile = path.join(state.dataRoot, 'daily', `${day}.json`)
  assert.ok(fs.existsSync(detailFile))
  assert.ok(fs.existsSync(dailyFile))
  const lines = fs.readFileSync(detailFile, 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
  for (const line of lines) assert.equal(JSON.parse(line).v, 1)

  const summary = store.readSummary({ from: day, to: day })
  assert.equal(summary.totals.requests, 2)
  assert.equal(summary.totals.promptTokens, 150)
  assert.equal(summary.totals.outputTokens, 15)
  assert.equal(summary.totals.totalTokens, 165)
  assert.equal(summary.totals.measuredRequests, 2)
  assert.equal(summary.totals.estimatedRequests, 0)
  assert.equal(summary.totals.estimatedShare, 0)
  assert.equal(summary.byPurpose.chat.requests, 1)
  assert.equal(summary.byPurpose['auto-review'].requests, 1)
  assert.equal(summary.byCategory.user, 50)
  assert.equal(summary.byCategory['tool-result:other:read'], 30)
  assert.equal(summary.byToolGroup['other:read'], 30)
  assert.equal(summary.cache.read, 20)
  assert.equal(summary.cache.input, 130)
  assert.equal(summary.cache.hitRate, Math.round(20 / (130 + 20 + 0) * 10000) / 10000)
  assert.equal(summary.cost.priced, true)
  assert.equal(summary.cost.amount, 0.01)
  assert.equal(summary.cost.unpricedRequests, 1)
  assert.equal(summary.bySession.length, 2)
  assert.equal(summary.bySession[0].sessionId, 's1')
  assert.equal(summary.bySession[0].tokens, 110)
  assert.equal(summary.bySession[0].requests, 1)
  assert.equal(summary.byModel.length, 1)
  assert.equal(summary.byModel[0].requests, 2)
  assert.equal(summary.data.readOnly, false)
  assert.equal(summary.data.dataRoot, path.resolve(state.dataRoot))
  assert.equal(summary.data.retention.requestDays, 30)
  assert.equal(summary.data.retention.dailyDays, 365)
  assert.ok(summary.byHour[String(new Date(first.ts).getHours())].requests >= 1)

  const page = store.readRequests({ date: day })
  assert.equal(page.total, 2)
  assert.equal(page.items.length, 2)
  assert.equal(page.items[0].id, 'r2')
  assert.deepEqual(JSON.parse(JSON.stringify(page.items[0])), JSON.parse(JSON.stringify(second)))
  const secondPage = store.readRequests({ date: day, limit: 1, offset: 1 })
  assert.equal(secondPage.total, 2)
  assert.equal(secondPage.items.length, 1)
  assert.equal(secondPage.items[0].id, 'r1')
  assert.equal(store.readRequests({ date: day, purpose: 'auto-review' }).total, 1)
  assert.equal(store.readRequests({ date: day, purpose: 'compaction' }).total, 0)
  assert.equal(store.readRequests({ date: day, limit: 500 }).items.length, 2)

  const meta = store.readMeta()
  assert.equal(meta.version, '0.1.0')
  assert.equal(meta.schemaVersion, 1)
  assert.equal(meta.estimatorVersion, 'char-v1')
  assert.equal(meta.dataRoot, path.resolve(state.dataRoot))
  assert.equal(meta.readOnly, false)
  assert.equal(meta.pointerStatus, 'ok')
  assert.equal(meta.retention.requestDays, 30)
  assert.equal(meta.migration.status, 'ok')
  assert.equal(meta.since, day)
  assert.equal(meta.droppedRecords, 0)

  store.dispose()
  assert.equal(fs.existsSync(path.join(home, 'token-attribution', 'state', 'test', 'lock')), false)
})

test('readRequests filters by sessionId alone and combined with purpose and date', (t) => {
  const home = tempHome(t)
  const config = makeConfig()
  const today = dayKey(Date.now())
  const earlier = shiftDays(today, -1)
  const dataRoot = writeMetaFor(home, config)
  ensureDir(path.join(dataRoot, 'requests'))
  const noSessionRecord = makeRecord({ id: 'n2', ts: new Date(`${today}T09:03:00`).getTime(), purpose: 'chat' })
  delete noSessionRecord.sessionId
  const rows = [
    makeRecord({ id: 'a1', ts: new Date(`${earlier}T09:00:00`).getTime(), sessionId: 'alpha', purpose: 'chat' }),
    makeRecord({ id: 'a2', ts: new Date(`${earlier}T09:01:00`).getTime(), sessionId: 'alpha', purpose: 'auto-review' }),
    makeRecord({ id: 'b1', ts: new Date(`${today}T09:00:00`).getTime(), sessionId: 'beta', purpose: 'chat' }),
    makeRecord({ id: 'b2', ts: new Date(`${today}T09:01:00`).getTime(), sessionId: 'beta', purpose: 'auto-review' }),
    makeRecord({ id: 'n1', ts: new Date(`${today}T09:02:00`).getTime(), sessionId: 'unknown-session', purpose: 'chat' }),
    noSessionRecord,
  ]
  for (const day of [earlier, today]) {
    const dayRows = rows.filter(record => dayKey(record.ts) === day)
    atomicWriteFileSync(path.join(dataRoot, 'requests', `${day}.jsonl`), `${dayRows.map(record => JSON.stringify(record)).join('\n')}\n`)
  }
  const store = createStore({ config, homeDir: home, profile: 'test' })

  // A session filter alone spans the whole from/to range (newest row first).
  const alpha = store.readRequests({ from: earlier, to: today, sessionId: 'alpha' })
  assert.equal(alpha.total, 2)
  assert.deepEqual(alpha.items.map(item => item.id), ['a2', 'a1'])

  // Combined with purpose.
  const alphaReview = store.readRequests({ from: earlier, to: today, sessionId: 'alpha', purpose: 'auto-review' })
  assert.equal(alphaReview.total, 1)
  assert.deepEqual(alphaReview.items.map(item => item.id), ['a2'])

  // Combined with a single date.
  const betaToday = store.readRequests({ date: today, sessionId: 'beta' })
  assert.equal(betaToday.total, 2)
  assert.deepEqual(betaToday.items.map(item => item.id), ['b2', 'b1'])

  // An unknown session matches nothing rather than failing.
  assert.equal(store.readRequests({ from: earlier, to: today, sessionId: 'missing' }).total, 0)

  // Without a sessionId the existing behavior is unchanged; a record without a
  // session id is only excluded by a concrete session filter.
  assert.equal(store.readRequests({ from: earlier, to: today }).total, 6)
  assert.equal(store.readRequests({ from: earlier, to: today, purpose: 'chat' }).total, 4)
  assert.equal(store.readRequests({ from: earlier, to: today, sessionId: 'alpha' }).total, 2)

  // `total` counts every filtered row while pagination only slices the page.
  const page = store.readRequests({ from: earlier, to: today, sessionId: 'beta', limit: 1, offset: 1 })
  assert.equal(page.total, 2)
  assert.equal(page.items.length, 1)
  assert.equal(page.items[0].id, 'b1')

  // The store ignores an empty filter defensively; the RPC endpoint rejects it.
  assert.equal(store.readRequests({ from: earlier, to: today, sessionId: '' }).total, 6)
  store.dispose()
})

test('a fresh store rebuilds today from detail JSONL when the daily file is missing', (t) => {
  const home = tempHome(t)
  const config = makeConfig()
  const store = createStore({ config, homeDir: home, profile: 'test' })
  const now = Date.now()
  store.append(makeRecord({ id: 'a', ts: now - 2000, promptTokens: 100 }))
  store.append(makeRecord({ id: 'b', ts: now - 1000, promptTokens: 40, outputTokens: 4, sessionId: 's2', categories: { user: 40 } }))
  store.flushNow()
  const day = dayKey(now)
  const before = store.readSummary({ from: day, to: day })
  const dataRoot = store.getState().dataRoot
  store.dispose()

  fs.rmSync(path.join(dataRoot, 'daily', `${day}.json`), { force: true })
  const reloaded = createStore({ config, homeDir: home, profile: 'test' })
  const after = reloaded.readSummary({ from: day, to: day })
  assert.deepEqual(totalsOf(after), totalsOf(before))
  assert.equal(after.totals.requests, 2)
  assert.equal(after.totals.promptTokens, 140)
  assert.equal(after.bySession.length, 2)
  // A JSONL rebuild must reproduce the M2 per-entity and per-day cost fields.
  assert.equal(after.byPurpose.chat.cost.amount, 0.02)
  assert.equal(after.byModel[0].cost.amount, 0.02)
  assert.equal(after.byDay.length, 1)
  assert.equal(after.byDay[0].cost.amount, 0.02)
  assert.equal(after.totals.costByCurrency.CNY.amount, 0.02)
  reloaded.dispose()
})

test('retention pruning removes old detail and daily files at startup', (t) => {
  const home = tempHome(t)
  const config = makeConfig()
  const stateRoot = path.join(home, 'token-attribution', 'state', 'test')
  const dataRoot = path.join(home, 'token-attribution', 'data', 'test')
  ensureDir(stateRoot)
  ensureDir(path.join(dataRoot, 'requests'))
  ensureDir(path.join(dataRoot, 'daily'))
  const today = dayKey(Date.now())
  const oldRequestDay = shiftDays(today, -40)
  const boundaryRequestDay = shiftDays(today, -30)
  const keptDay = shiftDays(today, -29)
  const oldDailyDay = shiftDays(today, -400)
  const boundaryDailyDay = shiftDays(today, -365)
  atomicWriteFileSync(path.join(dataRoot, 'requests', `${oldRequestDay}.jsonl`), '{"v":1}\n')
  atomicWriteFileSync(path.join(dataRoot, 'requests', `${boundaryRequestDay}.jsonl`), '{"v":1}\n')
  atomicWriteFileSync(path.join(dataRoot, 'requests', `${keptDay}.jsonl`), '{"v":1}\n')
  atomicWriteFileSync(path.join(dataRoot, 'daily', `${oldDailyDay}.json`), '{"v":1}\n')
  atomicWriteFileSync(path.join(dataRoot, 'daily', `${boundaryDailyDay}.json`), '{"v":1}\n')
  atomicWriteFileSync(path.join(dataRoot, 'daily', `${keptDay}.json`), '{"v":1}\n')

  const store = createStore({ config, homeDir: home, profile: 'test' })
  assert.equal(fs.existsSync(path.join(dataRoot, 'requests', `${oldRequestDay}.jsonl`)), false)
  assert.equal(fs.existsSync(path.join(dataRoot, 'requests', `${boundaryRequestDay}.jsonl`)), false)
  assert.equal(fs.existsSync(path.join(dataRoot, 'requests', `${keptDay}.jsonl`)), true)
  assert.equal(fs.existsSync(path.join(dataRoot, 'daily', `${oldDailyDay}.json`)), false)
  assert.equal(fs.existsSync(path.join(dataRoot, 'daily', `${boundaryDailyDay}.json`)), false)
  assert.equal(fs.existsSync(path.join(dataRoot, 'daily', `${keptDay}.json`)), true)
  assert.ok(store.readMeta().since <= keptDay)
  store.dispose()
})

test('a pointer/dataDir mismatch migrates into the empty configured directory', (t) => {
  const home = tempHome(t)
  const pointerRoot = path.join(home, 'data-a')
  const configuredRoot = path.join(home, 'data-b')
  const stateRoot = path.join(home, 'token-attribution', 'state', 'test')
  ensureDir(stateRoot)
  ensureDir(pointerRoot)
  atomicWriteFileSync(path.join(stateRoot, 'pointer.json'), JSON.stringify({
    v: 1,
    dataRoot: pointerRoot,
    schemaVersion: 1,
    updatedAt: 0,
  }))

  const config = makeConfig({ dataDir: configuredRoot })
  const store = createStore({ config, homeDir: home, profile: 'test' })
  assert.equal(store.getState().dataRoot, path.resolve(configuredRoot))
  const migration = store.migrationStatus()
  assert.equal(migration.status, 'ok')
  assert.equal(migration.currentDataDir, path.resolve(configuredRoot))
  assert.equal(migration.configuredDataDir, path.resolve(configuredRoot))
  assert.match(migration.note, /matches the configuration/)
  assert.equal(store.getState().migrationStatus, 'ok')

  const now = Date.now()
  assert.equal(store.append(makeRecord({ id: 'p1', ts: now })), true)
  store.flushNow()
  const day = dayKey(now)
  assert.ok(fs.existsSync(path.join(configuredRoot, 'requests', `${day}.jsonl`)))
  assert.equal(fs.existsSync(pointerRoot), false)
  const backups = fs.readdirSync(home).filter(name => name.startsWith('data-a.migrated-'))
  assert.equal(backups.length, 1)
  const pointer = JSON.parse(fs.readFileSync(path.join(stateRoot, 'pointer.json'), 'utf8'))
  assert.equal(pointer.dataRoot, path.resolve(configuredRoot))
  assert.equal(store.readMeta().pointerStatus, 'ok')
  assert.equal(store.readMeta().migrationStatus, 'ok')
  store.dispose()
})

test('an active foreign lock switches the store to read-only and leaves the lock alone', (t) => {
  const home = tempHome(t)
  const stateRoot = path.join(home, 'token-attribution', 'state', 'test')
  ensureDir(stateRoot)
  const lockPath = path.join(stateRoot, 'lock')
  atomicWriteFileSync(lockPath, JSON.stringify({ pid: process.ppid, startedAt: Date.now() }))
  const config = makeConfig()
  const store = createStore({ config, homeDir: home, profile: 'test' })
  assert.equal(store.getState().readOnly, true)
  assert.equal(store.append(makeRecord()), false)
  store.flushNow()
  assert.equal(store.getState().pending, 0)
  const summary = store.readSummary()
  assert.equal(summary.data.readOnly, true)
  assert.equal(summary.totals.requests, 0)
  store.dispose()
  assert.equal(fs.existsSync(lockPath), true)
})

test('a stale lock is replaced and released on dispose', (t) => {
  const home = tempHome(t)
  const stateRoot = path.join(home, 'token-attribution', 'state', 'test')
  ensureDir(stateRoot)
  const lockPath = path.join(stateRoot, 'lock')
  atomicWriteFileSync(lockPath, JSON.stringify({ pid: 2147483647, startedAt: 0 }))
  const store = createStore({ config: makeConfig(), homeDir: home, profile: 'test' })
  assert.equal(store.getState().readOnly, false)
  const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
  assert.equal(current.pid, process.pid)
  store.dispose()
  assert.equal(fs.existsSync(lockPath), false)
})

test('readSummary includes queued records before a flush without double counting', (t) => {
  const home = tempHome(t)
  const config = makeConfig()
  const store = createStore({ config, homeDir: home, profile: 'test' })
  const now = Date.now()
  const day = dayKey(now)
  assert.equal(store.append(makeRecord({
    id: 'queued',
    ts: now,
    promptTokens: 30,
    outputTokens: 3,
    categories: { user: 30 },
  })), true)
  const before = store.readSummary({ from: day, to: day })
  assert.equal(before.totals.requests, 1)
  assert.equal(before.totals.promptTokens, 30)
  assert.equal(before.totals.outputTokens, 3)
  store.flushNow()
  const after = store.readSummary({ from: day, to: day })
  assert.equal(after.totals.requests, 1)
  assert.equal(after.totals.promptTokens, 30)
  store.dispose()
})

test('a stale daily aggregate is rebuilt from newer detail on startup', (t) => {
  const home = tempHome(t)
  const config = makeConfig()
  const now = Date.now()
  const day = dayKey(now)
  const dataRoot = path.join(home, 'token-attribution', 'data', 'test')
  ensureDir(path.join(dataRoot, 'requests'))
  ensureDir(path.join(dataRoot, 'daily'))
  const record = makeRecord({ id: 'detail-newer', ts: now, promptTokens: 40, outputTokens: 4 })
  atomicWriteFileSync(path.join(dataRoot, 'requests', `${day}.jsonl`), `${JSON.stringify(record)}\n`)
  const stale = createDayAggregate(day)
  atomicWriteFileSync(path.join(dataRoot, 'daily', `${day}.json`), JSON.stringify(stale))
  const future = new Date(Date.now() + 60000)
  fs.utimesSync(path.join(dataRoot, 'requests', `${day}.jsonl`), future, future)
  writeMetaFor(home, config)
  const store = createStore({ config, homeDir: home, profile: 'test' })
  const summary = store.readSummary({ from: day, to: day })
  assert.equal(summary.totals.requests, 1)
  assert.equal(summary.totals.promptTokens, 40)
  store.dispose()
})

test('a stale past-day aggregate is rebuilt from newer detail during a summary read', (t) => {
  const home = tempHome(t)
  const config = makeConfig()
  const day = shiftDays(dayKey(Date.now()), -2)
  const dataRoot = path.join(home, 'token-attribution', 'data', 'test')
  ensureDir(path.join(dataRoot, 'requests'))
  ensureDir(path.join(dataRoot, 'daily'))
  const ts = new Date(`${day}T10:00:00`).getTime()
  const record = makeRecord({ id: 'past-detail', ts, promptTokens: 40, outputTokens: 4 })
  atomicWriteFileSync(path.join(dataRoot, 'requests', `${day}.jsonl`), `${JSON.stringify(record)}\n`)
  atomicWriteFileSync(path.join(dataRoot, 'daily', `${day}.json`), JSON.stringify(createDayAggregate(day)))
  const future = new Date(Date.now() + 60000)
  fs.utimesSync(path.join(dataRoot, 'requests', `${day}.jsonl`), future, future)
  writeMetaFor(home, config)
  const store = createStore({ config, homeDir: home, profile: 'test' })
  const summary = store.readSummary({ from: day, to: day })
  assert.equal(summary.totals.requests, 1)
  assert.equal(summary.totals.promptTokens, 40)
  store.dispose()
})

test('flushing a late record for a past day repairs a stale daily file exactly once', (t) => {
  const home = tempHome(t)
  const day = shiftDays(dayKey(Date.now()), -3)
  const dataRoot = path.join(home, 'token-attribution', 'data', 'test')
  ensureDir(path.join(dataRoot, 'requests'))
  ensureDir(path.join(dataRoot, 'daily'))
  const ts = new Date(`${day}T10:00:00`).getTime()
  const early = [
    makeRecord({ id: 'late-a', ts, promptTokens: 100, outputTokens: 10 }),
    makeRecord({ id: 'late-b', ts: ts + 1000, promptTokens: 50, outputTokens: 5, categories: { user: 50 } }),
  ]
  const detailFile = path.join(dataRoot, 'requests', `${day}.jsonl`)
  const dailyFile = path.join(dataRoot, 'daily', `${day}.json`)
  atomicWriteFileSync(detailFile, `${early.map(record => JSON.stringify(record)).join('\n')}\n`)
  // A stale daily aggregate that predates both detail rows (for example a crash
  // left it empty). The detail file is newer, so the flush must replay it.
  atomicWriteFileSync(dailyFile, JSON.stringify(createDayAggregate(day)))
  const future = new Date(Date.now() + 60000)
  fs.utimesSync(detailFile, future, future)

  const config = makeConfig()
  writeMetaFor(home, config)
  const store = createStore({ config, homeDir: home, profile: 'test' })
  assert.equal(store.append(makeRecord({
    id: 'late-c',
    ts: ts + 2000,
    promptTokens: 25,
    outputTokens: 2,
    cost: { amount: 0, priced: false, currency: 'CNY' },
  })), true)
  store.flushNow()

  const detailRecords = fs.readFileSync(detailFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(detailRecords.map(record => record.id), ['late-a', 'late-b', 'late-c'], 'the late record is appended exactly once')
  assert.equal(detailRecords.length, 3, 'no detail row is duplicated by the flush')

  // The written daily aggregate must equal a fresh replay of the detail rows.
  const replay = createDayAggregate(day)
  for (const record of detailRecords) addRecordToAggregate(replay, record)
  const daily = JSON.parse(fs.readFileSync(dailyFile, 'utf8'))
  assert.equal(daily.totals.requests, replay.totals.requests)
  assert.equal(daily.totals.requests, 3)
  assert.equal(daily.totals.promptTokens, replay.totals.promptTokens)
  assert.equal(daily.totals.promptTokens, 175)
  assert.equal(daily.totals.outputTokens, 17)
  assert.equal(daily.cost.unpricedRequests, 1)
  assert.deepEqual(daily.byCategory, replay.byCategory)

  const summary = store.readSummary({ from: day, to: day })
  assert.equal(summary.totals.requests, 3)
  assert.equal(summary.totals.promptTokens, 175)
  assert.equal(summary.byDay[0].requests, 3)
  assert.equal(summary.byDay[0].promptTokens, 175)
  // Make the repaired daily file the newest artifact before reopening so this
  // also covers the persisted path, not another detail replay.
  const past = new Date(Date.now() - 60000)
  fs.utimesSync(detailFile, past, past)
  store.dispose()

  const reloaded = createStore({ config, homeDir: home, profile: 'test' })
  const persisted = reloaded.readSummary({ from: day, to: day })
  assert.equal(persisted.totals.requests, 3)
  assert.equal(persisted.totals.promptTokens, 175)
  assert.equal(persisted.byDay[0].cost.amount, 0.02)
  reloaded.dispose()
})

test('daily aggregate helpers track totals, estimates, tool groups, and cost', () => {
  const aggregate = createDayAggregate('2026-11-11')
  addRecordToAggregate(aggregate, makeRecord({ promptTokens: 100, outputTokens: 10 }))
  addRecordToAggregate(aggregate, makeRecord({
    promptTokens: 50,
    outputTokens: 5,
    usageEstimated: true,
    categories: { 'tools:memory': 30, user: 20 },
    cost: { amount: 0, priced: false, currency: 'CNY', priceVersion: 'none' },
  }))
  assert.equal(aggregate.totals.requests, 2)
  assert.equal(aggregate.totals.promptTokens, 150)
  assert.equal(aggregate.totals.outputTokens, 15)
  assert.equal(aggregate.totals.totalTokens, 165)
  assert.equal(aggregate.totals.estimatedRequests, 1)
  assert.equal(aggregate.totals.measuredRequests, 1)
  assert.equal(aggregate.totals.measuredPromptTokens, 100)
  assert.equal(aggregate.totals.measuredOutputTokens, 10)
  assert.equal(aggregate.totals.estimatedPromptTokens, 50)
  assert.equal(aggregate.totals.estimatedOutputTokens, 5)
  assert.equal(aggregate.byToolGroup['other:read'], 30)
  assert.equal(aggregate.byToolGroup.memory, 30)
  assert.equal(aggregate.cost.amount, 0.01)
  assert.equal(aggregate.cost.priced, true)
  assert.equal(aggregate.cost.unpricedRequests, 1)
  assert.equal(aggregate.requestCount, 2)
  assert.equal(aggregate.attemptCount, 2)
  // M2: cost is also accumulated per purpose/session/model and per currency.
  assert.deepEqual(JSON.parse(JSON.stringify(aggregate.byPurpose.chat.cost)), {
    amount: 0.01,
    currency: 'CNY',
    priced: true,
    unpricedRequests: 1,
  })
  assert.equal(aggregate.bySession.s1.cost.amount, 0.01)
  assert.equal(aggregate.bySession.s1.cost.unpricedRequests, 1)
  assert.equal(aggregate.byModel['deepseek-official/deepseek-flash'].cost.amount, 0.01)
  assert.equal(aggregate.byModel['deepseek-official/deepseek-flash'].cost.unpricedRequests, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(aggregate.costByCurrency.CNY)), {
    amount: 0.01,
    priced: true,
    unpricedRequests: 1,
  })
})

test('a corrupt pointer.json forces read-only instead of re-rooting the ledger', (t) => {
  const home = tempHome(t)
  const stateRoot = path.join(home, 'token-attribution', 'state', 'test')
  ensureDir(stateRoot)
  const pointerPath = path.join(stateRoot, 'pointer.json')
  atomicWriteFileSync(pointerPath, '{broken json')
  const diagnostics = []
  const store = createStore({
    config: makeConfig(),
    homeDir: home,
    profile: 'test',
    diag: message => diagnostics.push(message),
  })
  assert.equal(store.getState().readOnly, true)
  assert.equal(fs.readFileSync(pointerPath, 'utf8'), '{broken json')
  assert.ok(diagnostics.some(message => message.includes('pointer.json') && message.includes('cannot be parsed')))
  store.dispose()
  assert.equal(fs.readFileSync(pointerPath, 'utf8'), '{broken json')
})

test('meta records the resolved profile and its source', (t) => {
  const home = tempHome(t)
  const store = createStore({
    config: makeConfig(),
    homeDir: home,
    profile: 'test',
    profileSource: 'profileContext',
  })
  const meta = store.readMeta()
  assert.equal(meta.profile, 'test')
  assert.equal(meta.profileSource, 'profileContext')
  store.dispose()
})

test('a case-only dataDir difference is the same directory, not a migration', (t) => {
  const home = tempHome(t)
  const first = createStore({ config: makeConfig(), homeDir: home, profile: 'CaseTest' })
  first.append(makeRecord({ id: 'case-1' }))
  first.flushNow()
  first.dispose()

  const pointerPath = path.join(home, 'token-attribution', 'state', 'CaseTest', 'pointer.json')
  const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8'))
  const variant = pointer.dataRoot.replace(/CaseTest$/, 'casetest')
  assert.notEqual(variant, pointer.dataRoot)

  const second = createStore({
    config: makeConfig({ dataDir: variant }),
    homeDir: home,
    profile: 'CaseTest',
  })
  assert.equal(second.readMeta().pointerStatus, 'ok')
  assert.equal(second.readSummary().data.migrationStatus, 'ok')
  const migrationPath = path.join(home, 'token-attribution', 'state', 'CaseTest', 'migration.json')
  assert.equal(fs.existsSync(migrationPath), false)
  second.dispose()
})

test('readSummary byDay is oldest-first, per-day, and includes queued records', (t) => {
  const home = tempHome(t)
  const store = createStore({ config: makeConfig(), homeDir: home, profile: 'test' })
  const today = dayKey(Date.now())
  const day1 = shiftDays(today, -4)
  const day2 = shiftDays(today, -3)
  const day4 = shiftDays(today, -1)
  const before = shiftDays(today, -5)
  const at = day => new Date(`${day}T10:00:00`).getTime()
  const records = [
    makeRecord({ id: 'b1', ts: at(day1), promptTokens: 100, outputTokens: 10, cost: { amount: 0.01, priced: true, currency: 'CNY' } }),
    makeRecord({
      id: 'b2',
      ts: at(day1) + 1000,
      promptTokens: 50,
      outputTokens: 5,
      usageEstimated: true,
      cost: { amount: 0, priced: false, currency: 'CNY' },
    }),
    makeRecord({ id: 'b3', ts: at(day2), promptTokens: 30, outputTokens: 3, cost: { amount: 0.02, priced: true, currency: 'CNY' } }),
    makeRecord({ id: 'b4', ts: at(day4), promptTokens: 20, outputTokens: 2, cost: { amount: 0, priced: false, currency: 'CNY' } }),
  ]
  const outside = makeRecord({ id: 'out', ts: at(before), promptTokens: 999, outputTokens: 99 })
  for (const record of records) assert.equal(store.append(record), true)
  assert.equal(store.append(outside), true)

  const expected = [
    {
      day: day1,
      requests: 2,
      promptTokens: 150,
      outputTokens: 15,
      estimatedRequests: 1,
      cache: { input: 180, read: 20, write: 0 },
      cost: { amount: 0.01, currency: 'CNY', priced: true, unpricedRequests: 1 },
      costByCurrency: { CNY: { amount: 0.01, priced: true, unpricedRequests: 1 } },
    },
    {
      day: day2,
      requests: 1,
      promptTokens: 30,
      outputTokens: 3,
      estimatedRequests: 0,
      cache: { input: 90, read: 10, write: 0 },
      cost: { amount: 0.02, currency: 'CNY', priced: true, unpricedRequests: 0 },
      costByCurrency: { CNY: { amount: 0.02, priced: true, unpricedRequests: 0 } },
    },
    {
      day: day4,
      requests: 1,
      promptTokens: 20,
      outputTokens: 2,
      estimatedRequests: 0,
      cache: { input: 90, read: 10, write: 0 },
      cost: { amount: 0, currency: 'CNY', priced: false, unpricedRequests: 1 },
      costByCurrency: { CNY: { amount: 0, priced: false, unpricedRequests: 1 } },
    },
  ]
  const queued = store.readSummary({ from: day1, to: day4 })
  assert.deepEqual(queued.byDay, expected)
  assert.equal(queued.totals.requests, 4)

  store.flushNow()
  const flushed = store.readSummary({ from: day1, to: day4 })
  assert.deepEqual(flushed.byDay, expected)
  assert.equal(flushed.totals.costByCurrency.CNY.amount, 0.03)
  store.dispose()

  const reloaded = createStore({ config: makeConfig(), homeDir: home, profile: 'test' })
  assert.deepEqual(reloaded.readSummary({ from: day1, to: day4 }).byDay, expected)
  reloaded.dispose()
})

test('summary accumulates cost per purpose, model, and session with unpriced counts', (t) => {
  const home = tempHome(t)
  const store = createStore({ config: makeConfig(), homeDir: home, profile: 'test' })
  const day = dayKey(Date.now())
  const ts = new Date(`${day}T10:00:00`).getTime()
  store.append(makeRecord({
    id: 'c1',
    ts,
    sessionId: 's1',
    parentSessionId: 'root',
    delegationDepth: 2,
    purpose: 'chat',
    promptTokens: 100,
    outputTokens: 10,
    cost: { amount: 0.01, priced: true, currency: 'CNY' },
  }))
  store.append(makeRecord({
    id: 'c2',
    ts: ts + 1000,
    sessionId: 's2',
    purpose: 'auto-review',
    promptTokens: 50,
    outputTokens: 5,
    cost: { amount: 0.02, priced: true, currency: 'CNY' },
  }))
  store.append(makeRecord({
    id: 'c3',
    ts: ts + 2000,
    sessionId: 's1',
    parentSessionId: 'root',
    delegationDepth: 2,
    purpose: 'chat',
    model: 'deepseek-pro',
    promptTokens: 30,
    outputTokens: 3,
    cost: { amount: 0, priced: false, currency: 'CNY' },
  }))
  store.flushNow()

  const summary = store.readSummary({ from: day, to: day })
  assert.deepEqual(JSON.parse(JSON.stringify(summary.byPurpose.chat.cost)), {
    amount: 0.01,
    currency: 'CNY',
    priced: true,
    unpricedRequests: 1,
  })
  assert.deepEqual(JSON.parse(JSON.stringify(summary.byPurpose['auto-review'].cost)), {
    amount: 0.02,
    currency: 'CNY',
    priced: true,
    unpricedRequests: 0,
  })
  const flash = summary.byModel.find(entry => entry.model === 'deepseek-flash')
  const pro = summary.byModel.find(entry => entry.model === 'deepseek-pro')
  assert.deepEqual(JSON.parse(JSON.stringify(flash.cost)), {
    amount: 0.03,
    currency: 'CNY',
    priced: true,
    unpricedRequests: 0,
  })
  assert.deepEqual(JSON.parse(JSON.stringify(pro.cost)), {
    amount: 0,
    currency: 'CNY',
    priced: false,
    unpricedRequests: 1,
  })
  const s1 = summary.bySession.find(entry => entry.sessionId === 's1')
  assert.equal(s1.parentSessionId, 'root')
  assert.equal(s1.depth, 2)
  assert.equal(s1.requests, 2)
  assert.deepEqual(JSON.parse(JSON.stringify(s1.cost)), {
    amount: 0.01,
    currency: 'CNY',
    priced: true,
    unpricedRequests: 1,
  })
  const s2 = summary.bySession.find(entry => entry.sessionId === 's2')
  assert.equal(s2.cost.amount, 0.02)
  assert.deepEqual(JSON.parse(JSON.stringify(summary.cost)), {
    amount: 0.03,
    currency: 'CNY',
    priced: true,
    unpricedRequests: 1,
  })
  assert.deepEqual(JSON.parse(JSON.stringify(summary.totals.costByCurrency)), {
    CNY: { amount: 0.03, priced: true, unpricedRequests: 1 },
  })
  store.dispose()
})

test('mixed currencies report currency "mixed" without adding amounts', (t) => {
  const home = tempHome(t)
  const store = createStore({ config: makeConfig(), homeDir: home, profile: 'test' })
  const today = dayKey(Date.now())
  const previous = shiftDays(today, -1)
  const at = day => new Date(`${day}T10:00:00`).getTime()
  store.append(makeRecord({
    id: 'm1',
    ts: at(previous),
    promptTokens: 40,
    outputTokens: 4,
    cost: { amount: 0.03, priced: true, currency: 'CNY' },
  }))
  store.append(makeRecord({
    id: 'm2',
    ts: at(today),
    promptTokens: 10,
    outputTokens: 1,
    cost: { amount: 0.01, priced: true, currency: 'CNY' },
  }))
  store.append(makeRecord({
    id: 'm3',
    ts: at(today) + 1000,
    promptTokens: 20,
    outputTokens: 2,
    cost: { amount: 0.02, priced: true, currency: 'USD' },
  }))
  store.append(makeRecord({
    id: 'm4',
    ts: at(today) + 2000,
    promptTokens: 30,
    outputTokens: 3,
    cost: { amount: 0, priced: false, currency: 'CNY' },
  }))
  store.flushNow()

  const mixed = store.readSummary({ from: previous, to: today })
  assert.deepEqual(JSON.parse(JSON.stringify(mixed.cost)), {
    amount: 0,
    currency: 'mixed',
    priced: true,
    unpricedRequests: 1,
  })
  assert.deepEqual(JSON.parse(JSON.stringify(mixed.totals.costByCurrency)), {
    CNY: { amount: 0.04, priced: true, unpricedRequests: 1 },
    USD: { amount: 0.02, priced: true, unpricedRequests: 0 },
  })
  assert.equal(mixed.byPurpose.chat.cost.currency, 'mixed')
  assert.equal(mixed.byPurpose.chat.cost.amount, 0)
  assert.equal(mixed.bySession[0].cost.currency, 'mixed')
  const previousDay = mixed.byDay.find(row => row.day === previous)
  const todayRow = mixed.byDay.find(row => row.day === today)
  assert.deepEqual(previousDay.cost, { amount: 0.03, currency: 'CNY', priced: true, unpricedRequests: 0 })
  assert.deepEqual(todayRow.cost, { amount: 0, currency: 'mixed', priced: true, unpricedRequests: 1 })
  // Each byDay row carries the same per-currency shape as totals.costByCurrency.
  assert.deepEqual(previousDay.costByCurrency, {
    CNY: { amount: 0.03, priced: true, unpricedRequests: 0 },
  })
  assert.deepEqual(todayRow.costByCurrency, {
    CNY: { amount: 0.01, priced: true, unpricedRequests: 1 },
    USD: { amount: 0.02, priced: true, unpricedRequests: 0 },
  })

  const single = store.readSummary({ from: previous, to: previous })
  assert.deepEqual(JSON.parse(JSON.stringify(single.cost)), {
    amount: 0.03,
    currency: 'CNY',
    priced: true,
    unpricedRequests: 0,
  })
  assert.deepEqual(Object.keys(single.totals.costByCurrency), ['CNY'])
  store.dispose()

  const reloaded = createStore({ config: makeConfig(), homeDir: home, profile: 'test' })
  const persisted = reloaded.readSummary({ from: previous, to: today })
  assert.deepEqual(JSON.parse(JSON.stringify(persisted.totals.costByCurrency)), {
    CNY: { amount: 0.04, priced: true, unpricedRequests: 1 },
    USD: { amount: 0.02, priced: true, unpricedRequests: 0 },
  })
  assert.equal(persisted.cost.currency, 'mixed')
  reloaded.dispose()
})

test('daily files without M2 per-entry cost fields normalize and still accumulate', (t) => {
  const home = tempHome(t)
  const day = shiftDays(dayKey(Date.now()), -1)
  const dataRoot = path.join(home, 'token-attribution', 'data', 'test')
  ensureDir(path.join(dataRoot, 'requests'))
  ensureDir(path.join(dataRoot, 'daily'))
  const legacy = {
    v: 1,
    day,
    schemaVersion: 1,
    totals: {
      promptTokens: 10,
      outputTokens: 1,
      totalTokens: 11,
      requests: 1,
      attempts: 1,
      measuredRequests: 1,
      measuredPromptTokens: 10,
      measuredOutputTokens: 1,
    },
    byPurpose: { chat: { requests: 1, promptTokens: 10, outputTokens: 1 } },
    byCategory: { user: 10 },
    byToolGroup: {},
    bySession: { s1: { sessionId: 's1', parentSessionId: null, depth: 0, promptTokens: 10, outputTokens: 1, requests: 1 } },
    byModel: { 'p/m': { provider: 'p', model: 'm', requests: 1, promptTokens: 10, outputTokens: 1 } },
    byHour: { 10: { requests: 1, promptTokens: 10, outputTokens: 1 } },
    cache: { input: 10, read: 0, write: 0 },
    cost: { amount: 0.5, priced: true, unpricedRequests: 2, currency: 'CNY' },
    requestCount: 1,
    attemptCount: 1,
  }
  atomicWriteFileSync(path.join(dataRoot, 'daily', `${day}.json`), JSON.stringify(legacy))

  const store = createStore({ config: makeConfig(), homeDir: home, profile: 'test' })
  const summary = store.readSummary({ from: day, to: day })
  assert.equal(summary.cost.amount, 0.5)
  assert.equal(summary.cost.priced, true)
  assert.equal(summary.cost.unpricedRequests, 2)
  assert.deepEqual(JSON.parse(JSON.stringify(summary.totals.costByCurrency)), {
    CNY: { amount: 0.5, priced: true, unpricedRequests: 2 },
  })
  assert.equal(summary.byPurpose.chat.cost.amount, 0)
  assert.equal(summary.byPurpose.chat.cost.unpricedRequests, 0)
  assert.equal(summary.byModel[0].cost.amount, 0)
  assert.equal(summary.bySession[0].cost.amount, 0)
  assert.equal(summary.data.costDetailIncomplete, true)

  const ts = new Date(`${day}T11:00:00`).getTime()
  store.append(makeRecord({
    id: 'legacy-new',
    ts,
    promptTokens: 10,
    outputTokens: 1,
    cost: { amount: 0.1, priced: true, currency: 'CNY' },
  }))
  store.flushNow()
  const after = store.readSummary({ from: day, to: day })
  assert.equal(after.cost.amount, 0.6)
  assert.equal(after.cost.unpricedRequests, 2)
  assert.equal(after.byPurpose.chat.cost.amount, 0.1)
  assert.equal(after.totals.costByCurrency.CNY.amount, 0.6)
  store.dispose()
})

test('pre-M2 daily aggregates are replayed from detail rows so per-entity cost is complete', (t) => {
  const home = tempHome(t)
  const day = shiftDays(dayKey(Date.now()), -1)
  const dataRoot = path.join(home, 'token-attribution', 'data', 'test')
  ensureDir(path.join(dataRoot, 'requests'))
  ensureDir(path.join(dataRoot, 'daily'))
  const ts = new Date(`${day}T10:00:00`).getTime()
  const detailRecords = [
    makeRecord({ id: 'up-1', ts, cost: { amount: 0.2, priced: true, currency: 'CNY' } }),
    makeRecord({ id: 'up-2', ts: ts + 1, cost: { amount: 0, priced: false, currency: 'CNY' } }),
  ]
  atomicWriteFileSync(
    path.join(dataRoot, 'requests', `${day}.jsonl`),
    `${detailRecords.map(record => JSON.stringify(record)).join('\n')}\n`,
  )
  // A pre-M2 daily file without per-entity cost fields, newer than the detail.
  atomicWriteFileSync(path.join(dataRoot, 'daily', `${day}.json`), JSON.stringify({
    v: 1,
    day,
    schemaVersion: 1,
    totals: { promptTokens: 200, outputTokens: 20, totalTokens: 220, requests: 2, attempts: 2 },
    byPurpose: { chat: { requests: 2, promptTokens: 200, outputTokens: 20 } },
    bySession: { s1: { sessionId: 's1', parentSessionId: null, depth: 0, promptTokens: 200, outputTokens: 20, requests: 2 } },
    byModel: { 'deepseek-official/deepseek-flash': { provider: 'deepseek-official', model: 'deepseek-flash', requests: 2, promptTokens: 200, outputTokens: 20 } },
    cost: { amount: 0.2, priced: true, unpricedRequests: 1, currency: 'CNY' },
  }))

  const config = makeConfig()
  writeMetaFor(home, config)
  const store = createStore({ config, homeDir: home, profile: 'test' })
  const summary = store.readSummary({ from: day, to: day })
  assert.equal(summary.data.costDetailIncomplete, false)
  assert.equal(summary.byPurpose.chat.cost.amount, 0.2)
  assert.equal(summary.byPurpose.chat.cost.unpricedRequests, 1)
  assert.equal(summary.byModel[0].cost.amount, 0.2)
  assert.equal(summary.byModel[0].cost.unpricedRequests, 1)
  assert.equal(summary.bySession[0].cost.amount, 0.2)
  assert.equal(summary.bySession[0].cost.unpricedRequests, 1)
  store.dispose()
})

test('a pricing fingerprint change reprices retained detail and rebuilds daily aggregates', (t) => {
  const home = tempHome(t)
  const config = makeConfig()
  // A weekday 09:30 Beijing instant is always peak, so the expected amounts do
  // not depend on the day the suite runs or the host timezone.
  const day = recentWeekdayDay()
  const ts = beijingTs(day)
  const dataRoot = path.join(home, 'token-attribution', 'data', 'test')
  ensureDir(path.join(dataRoot, 'requests'))
  ensureDir(path.join(dataRoot, 'daily'))
  const measured = makeRecord({
    id: 'old-measured',
    ts,
    cost: { amount: 0, priced: false, currency: 'CNY', priceVersion: 'none' },
  })
  const estimated = makeRecord({
    id: 'old-estimated',
    ts: ts + 1000,
    usage: null,
    usageEstimated: true,
    promptTokens: 20,
    outputTokens: 0,
    estimatedPromptTokens: 20,
    categories: { user: 20 },
    cost: { amount: 0, priced: false, currency: 'CNY', priceVersion: 'none' },
  })
  const detailFile = path.join(dataRoot, 'requests', `${day}.jsonl`)
  const dailyFile = path.join(dataRoot, 'daily', `${day}.json`)
  atomicWriteFileSync(detailFile, `${[measured, estimated].map(record => JSON.stringify(record)).join('\n')}\n`)

  const store = createStore({ config, homeDir: home, profile: 'test' })
  const repriced = fs.readFileSync(detailFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(repriced.length, 2, 'repricing never duplicates detail rows')
  assert.deepEqual(repriced.map(record => record.id), ['old-measured', 'old-estimated'])
  assert.equal(repriced[0].cost.priced, true)
  assert.equal(repriced[0].cost.amount, 0.00026)
  assert.equal(repriced[0].cost.currency, 'CNY')
  assert.equal(repriced[0].cost.priceVersion, 'deepseek-2026-11')
  assert.equal(repriced[0].cost.tier, 'peak')
  assert.equal(repriced[1].cost.priced, false, 'estimated usage stays unpriced')
  assert.equal(repriced[1].cost.amount, 0)
  assert.equal(repriced[1].cost.priceVersion, 'none')
  assert.equal(repriced[1].cost.tier, 'peak', 'the audit tier is recorded even when unpriced')

  const daily = JSON.parse(fs.readFileSync(dailyFile, 'utf8'))
  assert.equal(daily.totals.requests, 2)
  assert.equal(daily.cost.amount, 0.00026)
  assert.equal(daily.cost.priced, true)
  assert.equal(daily.cost.unpricedRequests, 1)
  assert.deepEqual(daily.bySession.s1.cache, { input: 90, read: 10, write: 0 })
  assert.equal(daily.byCategoryGroup.user, 70)

  const summary = store.readSummary({ from: day, to: day })
  assert.equal(summary.totals.promptTokens, 120)
  assert.equal(summary.cost.amount, 0.00026)
  assert.equal(summary.cost.priced, true)
  assert.equal(summary.cost.unpricedRequests, 1)
  assert.equal(summary.bySession[0].cache.read, 10)
  const metaPath = path.join(dataRoot, 'meta.json')
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
  assert.equal(meta.pricingFingerprint, pricingFingerprint(config.pricing, config.pricingOffPeakDays))
  store.dispose()

  // A matching fingerprint means the next start must not rewrite the files.
  const detailMtime = fs.statSync(detailFile).mtimeMs
  const dailyMtime = fs.statSync(dailyFile).mtimeMs
  const second = createStore({ config, homeDir: home, profile: 'test' })
  assert.equal(fs.statSync(detailFile).mtimeMs, detailMtime)
  assert.equal(fs.statSync(dailyFile).mtimeMs, dailyMtime)
  assert.equal(second.readSummary({ from: day, to: day }).cost.amount, 0.00026)
  second.dispose()

  // Changing the table changes the fingerprint and triggers another pass.
  const changedConfig = makeConfig({
    pricing: [{
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      currency: 'CNY',
      priceVersion: 'changed-test',
      inputPerMillion: 10,
      cacheReadPerMillion: 1,
      cacheWritePerMillion: 0,
      outputPerMillion: 20,
    }],
  })
  const third = createStore({ config: changedConfig, homeDir: home, profile: 'test' })
  const changed = fs.readFileSync(detailFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(changed[0].cost.amount, 0.00111)
  assert.equal(changed[0].cost.priceVersion, 'changed-test')
  assert.equal(changed[0].cost.tier, 'peak')
  assert.equal(changed[1].cost.priced, false)
  const changedSummary = third.readSummary({ from: day, to: day })
  assert.equal(changedSummary.cost.amount, 0.00111)
  assert.deepEqual(changedSummary.bySession[0].cache, { input: 90, read: 10, write: 0 })
  const changedMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
  assert.equal(changedMeta.pricingFingerprint, pricingFingerprint(changedConfig.pricing, changedConfig.pricingOffPeakDays))
  assert.notEqual(changedMeta.pricingFingerprint, meta.pricingFingerprint)
  third.dispose()
})

test('reprice prices each record by its own timestamp tier', (t) => {
  const home = tempHome(t)
  const day = recentWeekdayDay()
  const dataRoot = path.join(home, 'token-attribution', 'data', 'test')
  ensureDir(path.join(dataRoot, 'requests'))
  ensureDir(path.join(dataRoot, 'daily'))
  const peakRecord = makeRecord({
    id: 'peak-morning',
    ts: beijingTs(day, '09:30'),
    cost: { amount: 0, priced: false, currency: 'CNY', priceVersion: 'none' },
  })
  const offPeakRecord = makeRecord({
    id: 'off-peak-evening',
    ts: beijingTs(day, '20:00'),
    cost: { amount: 0, priced: false, currency: 'CNY', priceVersion: 'none' },
  })
  atomicWriteFileSync(
    path.join(dataRoot, 'requests', `${day}.jsonl`),
    `${[peakRecord, offPeakRecord].map(record => JSON.stringify(record)).join('\n')}\n`,
  )

  const store = createStore({ config: makeConfig(), homeDir: home, profile: 'test' })
  const priced = fs.readFileSync(path.join(dataRoot, 'requests', `${day}.jsonl`), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(priced.map(record => record.id), ['peak-morning', 'off-peak-evening'])
  assert.deepEqual(priced.map(record => record.cost.tier), ['peak', 'off-peak'])
  assert.equal(priced[0].cost.amount, 0.00026, 'a weekday morning instant uses peak prices')
  assert.equal(priced[1].cost.amount, 0.00013, 'the same usage in the evening uses half-price off-peak values')
  assert.equal(priced[1].cost.amount, priced[0].cost.amount / 2)
  assert.equal(priced[0].cost.priceVersion, 'deepseek-2026-11')
  assert.equal(priced[1].cost.priceVersion, 'deepseek-2026-11')

  const daily = JSON.parse(fs.readFileSync(path.join(dataRoot, 'daily', `${day}.json`), 'utf8'))
  assert.equal(daily.cost.amount, 0.00039)
  const summary = store.readSummary({ from: day, to: day })
  assert.equal(summary.cost.amount, 0.00039)
  store.dispose()
})

test('pricingOffPeakDays changes the fingerprint and reprices that date as off-peak', (t) => {
  const home = tempHome(t)
  const day = recentWeekdayDay()
  const ts = beijingTs(day, '10:00')
  const dataRoot = path.join(home, 'token-attribution', 'data', 'test')
  ensureDir(path.join(dataRoot, 'requests'))
  ensureDir(path.join(dataRoot, 'daily'))
  const record = makeRecord({
    id: 'weekday-peak-window',
    ts,
    cost: { amount: 0, priced: false, currency: 'CNY', priceVersion: 'none' },
  })
  const detailFile = path.join(dataRoot, 'requests', `${day}.jsonl`)
  atomicWriteFileSync(detailFile, `${JSON.stringify(record)}\n`)
  const metaPath = path.join(dataRoot, 'meta.json')

  const config = makeConfig()
  // The second argument defaults to [], so one-argument callers still work.
  assert.equal(pricingFingerprint(config.pricing), pricingFingerprint(config.pricing, []))
  assert.notEqual(
    pricingFingerprint(config.pricing, config.pricingOffPeakDays),
    pricingFingerprint(config.pricing, [...config.pricingOffPeakDays, day]),
  )

  const first = createStore({ config, homeDir: home, profile: 'test' })
  const peakPriced = JSON.parse(fs.readFileSync(detailFile, 'utf8').trim())
  assert.equal(peakPriced.cost.tier, 'peak')
  assert.equal(peakPriced.cost.amount, 0.00026)
  assert.equal(
    JSON.parse(fs.readFileSync(metaPath, 'utf8')).pricingFingerprint,
    pricingFingerprint(config.pricing, config.pricingOffPeakDays),
  )
  first.dispose()

  // Listing the date as an all-day off-peak holiday changes the fingerprint and
  // reprices the same record with off-peak prices.
  const holidayConfig = makeConfig({ pricingOffPeakDays: [day] })
  const second = createStore({ config: holidayConfig, homeDir: home, profile: 'test' })
  const offPeakPriced = JSON.parse(fs.readFileSync(detailFile, 'utf8').trim())
  assert.equal(offPeakPriced.cost.tier, 'off-peak')
  assert.equal(offPeakPriced.cost.amount, 0.00013)
  assert.equal(
    JSON.parse(fs.readFileSync(metaPath, 'utf8')).pricingFingerprint,
    pricingFingerprint(holidayConfig.pricing, holidayConfig.pricingOffPeakDays),
  )
  second.dispose()
})

test('an empty price table keeps retained costs and only affects new records', (t) => {
  const home = tempHome(t)
  const day = shiftDays(dayKey(Date.now()), -1)
  const ts = new Date(`${day}T10:00:00`).getTime()
  const dataRoot = writeMetaFor(home, makeConfig(), { pricingFingerprint: 'stale-fingerprint' })
  ensureDir(path.join(dataRoot, 'requests'))
  ensureDir(path.join(dataRoot, 'daily'))
  const record = makeRecord({
    id: 'priced-before-disable',
    ts,
    cost: { amount: 0.00026, priced: true, currency: 'CNY', priceVersion: 'deepseek-2026-11' },
  })
  atomicWriteFileSync(path.join(dataRoot, 'requests', `${day}.jsonl`), `${JSON.stringify(record)}\n`)
  const aggregate = addRecordToAggregate(createDayAggregate(day), record)
  atomicWriteFileSync(path.join(dataRoot, 'daily', `${day}.json`), JSON.stringify(aggregate))

  const config = makeConfig({ pricing: [] })
  const store = createStore({ config, homeDir: home, profile: 'test' })
  const summary = store.readSummary({ from: day, to: day })
  assert.equal(summary.cost.priced, true)
  assert.equal(summary.cost.amount, 0.00026)
  const persisted = JSON.parse(fs.readFileSync(path.join(dataRoot, 'requests', `${day}.jsonl`), 'utf8').trim())
  assert.deepEqual(persisted.cost, record.cost, 'disabling pricing must not erase recorded amounts')
  const meta = JSON.parse(fs.readFileSync(path.join(dataRoot, 'meta.json'), 'utf8'))
  assert.equal(meta.pricingFingerprint, pricingFingerprint([], config.pricingOffPeakDays))
  store.dispose()
})

test('reprice keeps a daily aggregate holding more requests than its partial detail', (t) => {
  const home = tempHome(t)
  const day = shiftDays(dayKey(Date.now()), -1)
  const ts = new Date(`${day}T11:00:00`).getTime()
  const dataRoot = path.join(home, 'token-attribution', 'data', 'test')
  ensureDir(path.join(dataRoot, 'requests'))
  ensureDir(path.join(dataRoot, 'daily'))
  const record = makeRecord({
    id: 'partial-detail-record',
    ts,
    cost: { amount: 0, priced: false, currency: 'CNY', priceVersion: 'none' },
  })
  // Detail is written first, then a daily aggregate that pretends to summarize
  // five requests (e.g. a restored/truncated JSONL): it is newer, so the store
  // reads it, and the completeness guard must keep it instead of replacing it
  // with the one-record replay.
  atomicWriteFileSync(path.join(dataRoot, 'requests', `${day}.jsonl`), `${JSON.stringify(record)}\n`)
  const daily = addRecordToAggregate(createDayAggregate(day), record)
  daily.totals.requests = 5
  daily.requestCount = 5
  atomicWriteFileSync(path.join(dataRoot, 'daily', `${day}.json`), JSON.stringify(daily))

  const store = createStore({ config: makeConfig(), homeDir: home, profile: 'test' })
  const persistedDaily = JSON.parse(fs.readFileSync(path.join(dataRoot, 'daily', `${day}.json`), 'utf8'))
  assert.equal(persistedDaily.totals.requests, 5, 'partial detail must not overwrite a larger daily aggregate')
  const repriced = JSON.parse(fs.readFileSync(path.join(dataRoot, 'requests', `${day}.jsonl`), 'utf8').trim())
  assert.equal(repriced.cost.priced, true, 'the detail rows are still repriced')
  const summary = store.readSummary({ from: day, to: day })
  assert.equal(summary.totals.requests, 5)
  store.dispose()
})

test('a read-only store skips repricing and keeps the persisted cost', (t) => {
  const home = tempHome(t)
  const day = shiftDays(dayKey(Date.now()), -1)
  const ts = new Date(`${day}T10:00:00`).getTime()
  const dataRoot = path.join(home, 'token-attribution', 'data', 'test')
  ensureDir(path.join(dataRoot, 'requests'))
  ensureDir(path.join(dataRoot, 'daily'))
  const record = makeRecord({
    id: 'read-only-unpriced',
    ts,
    cost: { amount: 0, priced: false, currency: 'CNY', priceVersion: 'none' },
  })
  const detailFile = path.join(dataRoot, 'requests', `${day}.jsonl`)
  atomicWriteFileSync(detailFile, `${JSON.stringify(record)}\n`)
  const aggregate = createDayAggregate(day)
  addRecordToAggregate(aggregate, record)
  atomicWriteFileSync(path.join(dataRoot, 'daily', `${day}.json`), JSON.stringify(aggregate))
  const stateRoot = path.join(home, 'token-attribution', 'state', 'test')
  ensureDir(stateRoot)
  const lockPath = path.join(stateRoot, 'lock')
  atomicWriteFileSync(lockPath, JSON.stringify({ pid: process.ppid, startedAt: Date.now() }))

  const store = createStore({ config: makeConfig(), homeDir: home, profile: 'test' })
  assert.equal(store.getState().readOnly, true)
  const saved = JSON.parse(fs.readFileSync(detailFile, 'utf8').trim())
  assert.equal(saved.cost.priced, false, 'read-only repricing must not rewrite detail')
  assert.equal(saved.cost.amount, 0)
  assert.equal(fs.existsSync(path.join(dataRoot, 'meta.json')), false, 'read-only stores write no meta')
  const summary = store.readSummary({ from: day, to: day })
  assert.equal(summary.cost.priced, false)
  assert.equal(summary.cost.amount, 0)
  store.dispose()
  assert.equal(fs.existsSync(lockPath), true)
})

test('startup migrates legacy auto-review user tokens and rebuilds the daily aggregate', (t) => {
  const home = tempHome(t)
  const config = makeConfig()
  const day = shiftDays(dayKey(Date.now()), -1)
  const ts = new Date(`${day}T10:00:00`).getTime()
  const dataRoot = writeMetaFor(home, config)
  ensureDir(path.join(dataRoot, 'requests'))
  const review = makeRecord({
    id: 'legacy-auto-review',
    ts,
    purpose: 'auto-review',
    categories: { user: 70, 'system:auto-review': 30 },
  })
  const chat = makeRecord({
    id: 'chat-user',
    ts: ts + 1000,
    categories: { user: 90, 'system:base': 10 },
  })
  const detailFile = path.join(dataRoot, 'requests', `${day}.jsonl`)
  const dailyFile = path.join(dataRoot, 'daily', `${day}.json`)
  atomicWriteFileSync(detailFile, `${JSON.stringify(review)}\n${JSON.stringify(chat)}\n`)
  const diagnostics = []
  const store = createStore({
    config,
    homeDir: home,
    profile: 'test',
    diag: message => diagnostics.push(message),
  })

  const migrated = fs.readFileSync(detailFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const reviewRow = migrated.find(record => record.id === 'legacy-auto-review')
  const chatRow = migrated.find(record => record.id === 'chat-user')
  assert.deepEqual(reviewRow.categories, { 'system:auto-review': 30, 'injected:auto-review': 70 })
  assert.deepEqual(chatRow.categories, { user: 90, 'system:base': 10 }, 'chat user rows are never rewritten')

  const daily = JSON.parse(fs.readFileSync(dailyFile, 'utf8'))
  assert.equal(daily.byCategory['injected:auto-review'], 70)
  assert.equal(daily.byCategory.user, 90)
  assert.equal(daily.byCategoryGroup['auto-review'], 70)
  assert.equal(daily.byCategoryGroup.user, 90)
  // The rebuilt aggregate must never look older than the rewritten detail, or a
  // read would replay the detail instead of trusting the daily file.
  assert.ok(fs.statSync(dailyFile).mtimeMs >= fs.statSync(detailFile).mtimeMs)

  const summary = store.readSummary({ from: day, to: day })
  assert.equal(summary.totals.requests, 2)
  assert.equal(summary.totals.promptTokens, 200)
  assert.equal(summary.byCategory['injected:auto-review'], 70)
  assert.equal(summary.byCategoryGroup['auto-review'], 70)
  assert.equal(summary.byCategoryGroup.user, 90)
  assert.ok(diagnostics.includes('migrated 1 auto-review record(s) across 1 day(s)'))
  const meta = JSON.parse(fs.readFileSync(path.join(dataRoot, 'meta.json'), 'utf8'))
  assert.equal(meta.autoReviewCategoryVersion, AUTO_REVIEW_CATEGORY_VERSION)
  assert.equal(store.readMeta().autoReviewCategoryVersion, AUTO_REVIEW_CATEGORY_VERSION)
  store.dispose()

  // The marker makes the next start a no-op: no rewrite and no summary.
  const detailMtime = fs.statSync(detailFile).mtimeMs
  const dailyMtime = fs.statSync(dailyFile).mtimeMs
  const diagnosticsAfter = []
  const second = createStore({
    config,
    homeDir: home,
    profile: 'test',
    diag: message => diagnosticsAfter.push(message),
  })
  assert.equal(fs.statSync(detailFile).mtimeMs, detailMtime)
  assert.equal(fs.statSync(dailyFile).mtimeMs, dailyMtime)
  assert.equal(diagnosticsAfter.some(message => message.startsWith('migrated ')), false)
  assert.equal(second.readSummary({ from: day, to: day }).byCategoryGroup['auto-review'], 70)
  second.dispose()
})

test('a read-only store leaves legacy auto-review categories untouched', (t) => {
  const home = tempHome(t)
  const config = makeConfig()
  const day = shiftDays(dayKey(Date.now()), -1)
  const ts = new Date(`${day}T10:00:00`).getTime()
  const dataRoot = writeMetaFor(home, config)
  ensureDir(path.join(dataRoot, 'requests'))
  const review = makeRecord({ id: 'read-only-review', ts, purpose: 'auto-review' })
  const detailFile = path.join(dataRoot, 'requests', `${day}.jsonl`)
  const before = `${JSON.stringify(review)}\n`
  atomicWriteFileSync(detailFile, before)
  const stateRoot = path.join(home, 'token-attribution', 'state', 'test')
  ensureDir(stateRoot)
  atomicWriteFileSync(path.join(stateRoot, 'lock'), JSON.stringify({ pid: process.ppid, startedAt: Date.now() }))

  const diagnostics = []
  const store = createStore({
    config,
    homeDir: home,
    profile: 'test',
    diag: message => diagnostics.push(message),
  })
  assert.equal(store.getState().readOnly, true)
  assert.equal(fs.readFileSync(detailFile, 'utf8'), before, 'read-only stores rewrite no detail')
  assert.equal(fs.existsSync(path.join(dataRoot, 'daily', `${day}.json`)), false)
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dataRoot, 'meta.json'), 'utf8')).autoReviewCategoryVersion,
    undefined,
    'read-only stores write no migration marker',
  )
  assert.equal(store.readSummary({ from: day, to: day }).byCategory.user, 50)
  assert.equal(store.readMeta().autoReviewCategoryVersion, 0)
  assert.equal(diagnostics.some(message => message.startsWith('migrated ')), false)
  store.dispose()
})

test('auto-review migration keeps a richer daily aggregate over partial detail', (t) => {
  const home = tempHome(t)
  const config = makeConfig()
  const day = shiftDays(dayKey(Date.now()), -1)
  const ts = new Date(`${day}T10:00:00`).getTime()
  const dataRoot = writeMetaFor(home, config)
  ensureDir(path.join(dataRoot, 'requests'))
  ensureDir(path.join(dataRoot, 'daily'))
  const review = makeRecord({ id: 'partial-review', ts, purpose: 'auto-review' })
  const detailFile = path.join(dataRoot, 'requests', `${day}.jsonl`)
  const dailyFile = path.join(dataRoot, 'daily', `${day}.json`)
  atomicWriteFileSync(detailFile, `${JSON.stringify(review)}\n`)
  // The persisted aggregate pretends to summarize five requests (restored or
  // truncated detail); a replay of the one retained row must not replace it.
  const richer = addRecordToAggregate(createDayAggregate(day), review)
  richer.totals.requests = 5
  richer.requestCount = 5
  atomicWriteFileSync(dailyFile, JSON.stringify(richer))

  const diagnostics = []
  const store = createStore({
    config,
    homeDir: home,
    profile: 'test',
    diag: message => diagnostics.push(message),
  })
  const persistedDetail = JSON.parse(fs.readFileSync(detailFile, 'utf8').trim())
  assert.equal(persistedDetail.categories.user, 50, 'partial detail stays legacy')
  assert.equal(persistedDetail.categories['injected:auto-review'], undefined)
  const persistedDaily = JSON.parse(fs.readFileSync(dailyFile, 'utf8'))
  assert.equal(persistedDaily.totals.requests, 5)
  assert.equal(persistedDaily.byCategory.user, 50)
  assert.ok(diagnostics.some(message => message.includes(`skipped ${day}`)))
  assert.equal(store.readSummary({ from: day, to: day }).totals.requests, 5)
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dataRoot, 'meta.json'), 'utf8')).autoReviewCategoryVersion,
    0,
    'a skipped partial-detail day keeps the marker unset so the next start retries',
  )
  assert.ok(diagnostics.some(message => message.includes('keeping the previous marker so the next start retries')))
  store.dispose()
})

test('auto-review migration repairs a stale daily aggregate after an interrupted run', (t) => {
  const home = tempHome(t)
  const config = makeConfig()
  const day = shiftDays(dayKey(Date.now()), -1)
  const ts = new Date(`${day}T10:00:00`).getTime()
  const dataRoot = writeMetaFor(home, config)
  ensureDir(path.join(dataRoot, 'requests'))
  ensureDir(path.join(dataRoot, 'daily'))
  const detailFile = path.join(dataRoot, 'requests', `${day}.jsonl`)
  const dailyFile = path.join(dataRoot, 'daily', `${day}.json`)
  // The previous run rewrote the detail but crashed before the daily aggregate:
  // detail holds the migrated category, daily still holds the legacy user bucket.
  const review = makeRecord({
    id: 'interrupted-review',
    ts,
    purpose: 'auto-review',
    categories: { 'injected:auto-review': 50 },
  })
  atomicWriteFileSync(detailFile, `${JSON.stringify(review)}\n`)
  const legacy = makeRecord({ id: 'interrupted-review', ts, purpose: 'auto-review', categories: { user: 50 } })
  atomicWriteFileSync(dailyFile, JSON.stringify(addRecordToAggregate(createDayAggregate(day), legacy)))
  fs.utimesSync(dailyFile, new Date(0), new Date(0))

  const diagnostics = []
  const store = createStore({
    config,
    homeDir: home,
    profile: 'test',
    diag: message => diagnostics.push(message),
  })
  const daily = JSON.parse(fs.readFileSync(dailyFile, 'utf8'))
  assert.equal(daily.byCategoryGroup['auto-review'], 50)
  assert.equal(daily.byCategoryGroup.user, undefined)
  assert.ok(fs.statSync(dailyFile).mtimeMs >= fs.statSync(detailFile).mtimeMs)
  assert.ok(diagnostics.some(message => message.includes('repaired daily aggregate')))
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dataRoot, 'meta.json'), 'utf8')).autoReviewCategoryVersion,
    AUTO_REVIEW_CATEGORY_VERSION,
  )
  store.dispose()
})

test('auto-review migration tolerates malformed rows and a corrupt daily file', (t) => {
  const home = tempHome(t)
  const config = makeConfig()
  const day = shiftDays(dayKey(Date.now()), -1)
  const ts = new Date(`${day}T10:00:00`).getTime()
  const dataRoot = writeMetaFor(home, config)
  ensureDir(path.join(dataRoot, 'requests'))
  ensureDir(path.join(dataRoot, 'daily'))
  const review = makeRecord({ id: 'malformed-neighbor', ts, purpose: 'auto-review' })
  const detailFile = path.join(dataRoot, 'requests', `${day}.jsonl`)
  const dailyFile = path.join(dataRoot, 'daily', `${day}.json`)
  atomicWriteFileSync(detailFile, `{not json}\n${JSON.stringify(review)}\n`)
  atomicWriteFileSync(dailyFile, '{broken')

  const diagnostics = []
  const store = createStore({
    config,
    homeDir: home,
    profile: 'test',
    diag: message => diagnostics.push(message),
  })
  const text = fs.readFileSync(detailFile, 'utf8')
  assert.ok(text.startsWith('{not json}\n'), 'the malformed row is preserved verbatim')
  const parsed = text.split('\n').flatMap((line) => {
    try {
      return [JSON.parse(line)]
    } catch {
      return []
    }
  })
  const migrated = parsed.find(record => record.id === 'malformed-neighbor')
  assert.deepEqual(migrated.categories, {
    'system:base': 20,
    'tool-result:other:read': 30,
    'injected:auto-review': 50,
  })
  const daily = JSON.parse(fs.readFileSync(dailyFile, 'utf8'))
  assert.equal(daily.totals.requests, 1)
  assert.equal(daily.byCategoryGroup['auto-review'], 50)
  assert.ok(diagnostics.includes('migrated 1 auto-review record(s) across 1 day(s)'))
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dataRoot, 'meta.json'), 'utf8')).autoReviewCategoryVersion,
    AUTO_REVIEW_CATEGORY_VERSION,
  )
  store.dispose()
})

test('a hard migration failure leaves the marker unset and the next start retries', (t) => {
  const home = tempHome(t)
  const config = makeConfig()
  const failingDay = shiftDays(dayKey(Date.now()), -2)
  const legacyDay = shiftDays(dayKey(Date.now()), -1)
  const dataRoot = writeMetaFor(home, config)
  const requestsDir = path.join(dataRoot, 'requests')
  ensureDir(requestsDir)
  // A directory named like a detail file makes the read fail (EISDIR/EACCES).
  fs.mkdirSync(path.join(requestsDir, `${failingDay}.jsonl`))
  const review = makeRecord({
    id: 'retry-review',
    ts: new Date(`${legacyDay}T10:00:00`).getTime(),
    purpose: 'auto-review',
  })
  const legacyFile = path.join(requestsDir, `${legacyDay}.jsonl`)
  atomicWriteFileSync(legacyFile, `${JSON.stringify(review)}\n`)
  const metaPath = path.join(dataRoot, 'meta.json')

  const diagnostics = []
  const first = createStore({
    config,
    homeDir: home,
    profile: 'test',
    diag: message => diagnostics.push(message),
  })
  assert.ok(diagnostics.some(message => message.includes('auto-review category migration incomplete')))
  assert.equal(JSON.parse(fs.readFileSync(metaPath, 'utf8')).autoReviewCategoryVersion, 0)
  assert.equal(
    JSON.parse(fs.readFileSync(legacyFile, 'utf8').trim()).categories['injected:auto-review'],
    50,
    'readable days still migrate when another day fails',
  )
  first.dispose()

  // Repair the unreadable day; the retry migrates it and stamps the marker.
  fs.rmSync(path.join(requestsDir, `${failingDay}.jsonl`), { recursive: true, force: true })
  const retryReview = makeRecord({
    id: 'retry-review-2',
    ts: new Date(`${failingDay}T10:00:00`).getTime(),
    purpose: 'auto-review',
  })
  atomicWriteFileSync(path.join(requestsDir, `${failingDay}.jsonl`), `${JSON.stringify(retryReview)}\n`)
  const retryDiagnostics = []
  const second = createStore({
    config,
    homeDir: home,
    profile: 'test',
    diag: message => retryDiagnostics.push(message),
  })
  assert.ok(retryDiagnostics.includes('migrated 1 auto-review record(s) across 1 day(s)'))
  assert.equal(
    JSON.parse(fs.readFileSync(metaPath, 'utf8')).autoReviewCategoryVersion,
    AUTO_REVIEW_CATEGORY_VERSION,
  )
  second.dispose()
})

test('session cache counters and category groups accumulate from records', () => {
  const aggregate = createDayAggregate('2026-11-11')
  addRecordToAggregate(aggregate, makeRecord({
    categories: {
      user: 10,
      'system:mnemon-memory': 20,
      'system:base': 5,
      'tools:memory': 3,
      'tools:skill': 4,
      'tools:other:read': 2,
      'tool-result:other:read': 7,
      'reasoning-replay': 6,
      'injected:memory-snapshot': 8,
      'injected:runtime-context': 9,
      unknown: 1,
    },
    usage: { input: 90, cacheRead: 10, cacheWrite: 5, output: 10, reasoning: 5 },
  }))
  assert.deepEqual(aggregate.bySession.s1.cache, { input: 90, read: 10, write: 5 })
  assert.equal(aggregate.cache.input, 90)
  assert.equal(aggregate.cache.read, 10)
  assert.equal(aggregate.cache.write, 5)
  assert.deepEqual(aggregate.byCategoryGroup, {
    user: 10,
    memory: 31,
    system: 5,
    skill: 4,
    'tool-decl': 2,
    'tool-result': 7,
    reasoning: 6,
    injected: 9,
    other: 1,
  })
})

test('summary derives category groups from old daily files and zeroes missing session cache', (t) => {
  const home = tempHome(t)
  const day = shiftDays(dayKey(Date.now()), -1)
  const dataRoot = path.join(home, 'token-attribution', 'data', 'test')
  ensureDir(path.join(dataRoot, 'daily'))
  const legacy = {
    v: 1,
    day,
    schemaVersion: 1,
    totals: {
      promptTokens: 45,
      outputTokens: 4,
      totalTokens: 49,
      requests: 1,
      attempts: 1,
      measuredRequests: 1,
      measuredPromptTokens: 45,
      measuredOutputTokens: 4,
    },
    byPurpose: { chat: { requests: 1, promptTokens: 45, outputTokens: 4 } },
    byCategory: { user: 10, 'system:mnemon-memory': 30, 'tool-result:other:read': 5 },
    byToolGroup: { 'other:read': 5 },
    bySession: { s1: { sessionId: 's1', parentSessionId: null, depth: 0, promptTokens: 45, outputTokens: 4, requests: 1 } },
    byModel: { 'p/deepseek-flash': { provider: 'p', model: 'deepseek-flash', requests: 1, promptTokens: 45, outputTokens: 4 } },
    byHour: { 10: { requests: 1, promptTokens: 45, outputTokens: 4 } },
    cost: { amount: 0.5, priced: true, unpricedRequests: 0, currency: 'CNY' },
  }
  atomicWriteFileSync(path.join(dataRoot, 'daily', `${day}.json`), JSON.stringify(legacy))

  const store = createStore({ config: makeConfig(), homeDir: home, profile: 'test' })
  const summary = store.readSummary({ from: day, to: day })
  assert.deepEqual(summary.byCategoryGroup, { user: 10, memory: 30, 'tool-result': 5 })
  assert.deepEqual(summary.bySession[0].cache, { input: 0, read: 0, write: 0 })
  store.dispose()
})

test('replaying retained detail fills session cache counters and category groups', (t) => {
  const home = tempHome(t)
  const config = makeConfig()
  const day = shiftDays(dayKey(Date.now()), -1)
  const ts = new Date(`${day}T10:00:00`).getTime()
  const dataRoot = path.join(home, 'token-attribution', 'data', 'test')
  ensureDir(path.join(dataRoot, 'requests'))
  ensureDir(path.join(dataRoot, 'daily'))
  const record = makeRecord({
    id: 'detail-cache',
    ts,
    usage: { input: 30, cacheRead: 20, cacheWrite: 5, output: 10 },
    promptTokens: 55,
    outputTokens: 10,
    categories: { user: 15, 'injected:memory-snapshot': 40 },
    cost: { amount: 0, priced: false, currency: 'CNY', priceVersion: 'none' },
  })
  atomicWriteFileSync(path.join(dataRoot, 'requests', `${day}.jsonl`), `${JSON.stringify(record)}\n`)
  // A pre-M2 daily file written after (but without) the detail: it has no
  // session cache counters, no category groups, and no cost schema marker.
  atomicWriteFileSync(path.join(dataRoot, 'daily', `${day}.json`), JSON.stringify({
    v: 1,
    day,
    schemaVersion: 1,
    totals: {
      promptTokens: 55,
      outputTokens: 10,
      totalTokens: 65,
      requests: 1,
      attempts: 1,
      measuredRequests: 1,
      measuredPromptTokens: 55,
      measuredOutputTokens: 10,
    },
    byPurpose: { chat: { requests: 1, promptTokens: 55, outputTokens: 10 } },
    byCategory: { user: 15, 'injected:memory-snapshot': 40 },
    byToolGroup: {},
    bySession: { s1: { sessionId: 's1', parentSessionId: null, depth: 0, promptTokens: 55, outputTokens: 10, requests: 1 } },
    byModel: { 'deepseek-official/deepseek-flash': { provider: 'deepseek-official', model: 'deepseek-flash', requests: 1, promptTokens: 55, outputTokens: 10 } },
    byHour: { 10: { requests: 1, promptTokens: 55, outputTokens: 10 } },
    cache: { input: 30, read: 20, write: 5 },
    cost: { amount: 0, priced: false, unpricedRequests: 1, currency: 'CNY' },
  }))
  writeMetaFor(home, config)

  const store = createStore({ config, homeDir: home, profile: 'test' })
  const summary = store.readSummary({ from: day, to: day })
  assert.equal(summary.data.costDetailIncomplete, false)
  assert.deepEqual(summary.bySession[0].cache, { input: 30, read: 20, write: 5 })
  assert.deepEqual(summary.byCategoryGroup, { user: 15, memory: 40 })
  store.dispose()
})

test('summary returns up to 500 sessions sorted by tokens for a tree UI', (t) => {
  const home = tempHome(t)
  const config = makeConfig()
  const day = shiftDays(dayKey(Date.now()), -1)
  const ts = new Date(`${day}T10:00:00`).getTime()
  const dataRoot = writeMetaFor(home, config)
  ensureDir(path.join(dataRoot, 'requests'))
  ensureDir(path.join(dataRoot, 'daily'))
  const aggregate = createDayAggregate(day)
  for (let index = 0; index < 501; index += 1) {
    addRecordToAggregate(aggregate, makeRecord({
      id: `cap-${index}`,
      ts,
      sessionId: `s${index}`,
      promptTokens: index + 1,
      outputTokens: 0,
      usage: null,
      usageEstimated: true,
      categories: { user: index + 1 },
      cost: { amount: 0, priced: false, currency: 'CNY' },
    }))
  }
  atomicWriteFileSync(path.join(dataRoot, 'daily', `${day}.json`), JSON.stringify(aggregate))

  const store = createStore({ config, homeDir: home, profile: 'test' })
  const summary = store.readSummary({ from: day, to: day })
  assert.equal(MAX_SUMMARY_SESSIONS, 500)
  assert.equal(summary.bySession.length, 500)
  assert.equal(summary.bySession[0].sessionId, 's500')
  assert.equal(summary.bySession[0].promptTokens, 501)
  assert.equal(summary.bySession[0].outputTokens, 0)
  assert.equal(summary.bySession[0].tokens, 501)
  assert.equal(summary.bySession[499].sessionId, 's1')
  assert.equal(summary.bySession.some(row => row.sessionId === 's0'), false)
  for (const row of summary.bySession) {
    assert.deepEqual(Object.keys(row).sort(), ['cache', 'cost', 'depth', 'outputTokens', 'parentSessionId', 'promptTokens', 'requests', 'sessionId', 'tokens'])
    assert.deepEqual(row.cache, { input: 0, read: 0, write: 0 })
  }
  store.dispose()
})

/**
 * Write one web API counter file directly (test fixture).
 * @param {string} dataRoot - ledger data root.
 * @param {string} day - `YYYY-MM-DD` day key.
 * @param {{search?: object, fetch?: object, sessions?: object}} counters - partial counters; omit `sessions` to write a pre-M2.5 file.
 * @returns {void}
 */
const writeWebApiFile = (dataRoot, day, counters = {}) => {
  ensureDir(path.join(dataRoot, 'webapi'))
  atomicWriteFileSync(path.join(dataRoot, 'webapi', `${day}.json`), JSON.stringify({
    v: 1,
    day,
    search: { ok: 0, failed: 0, ...counters.search },
    fetch: { ok: 0, failed: 0, ...counters.fetch },
    ...(counters.sessions === undefined ? {} : { sessions: counters.sessions }),
  }))
}

test('recordWebApiCall persists per-day counters outside request and daily files', (t) => {
  const home = tempHome(t)
  const store = createStore({ config: makeConfig(), homeDir: home, profile: 'test' })
  const dataRoot = store.getState().dataRoot
  const firstDay = shiftDays(dayKey(Date.now()), -1)
  const secondDay = dayKey(Date.now())
  const firstTs = new Date(`${firstDay}T10:00:00`).getTime()

  assert.equal(store.recordWebApiCall({ ts: firstTs, tool: 'search', ok: true }), true)
  assert.equal(store.recordWebApiCall({ ts: firstTs + 1000, tool: 'search', ok: false }), true)
  assert.equal(store.recordWebApiCall({ ts: firstTs + 2000, tool: 'fetch', ok: true }), true)
  assert.equal(store.recordWebApiCall({ ts: Date.now(), tool: 'fetch', ok: false }), true)

  const first = JSON.parse(fs.readFileSync(path.join(dataRoot, 'webapi', `${firstDay}.json`), 'utf8'))
  assert.deepEqual(first, {
    v: 1,
    day: firstDay,
    search: { ok: 1, failed: 1 },
    fetch: { ok: 1, failed: 0 },
    // Calls without a calling session count into the `unknown` bucket.
    sessions: { unknown: { search: { ok: 1, failed: 1 }, fetch: { ok: 1, failed: 0 } } },
  })
  const second = JSON.parse(fs.readFileSync(path.join(dataRoot, 'webapi', `${secondDay}.json`), 'utf8'))
  assert.deepEqual(second.fetch, { ok: 0, failed: 1 })

  // Unknown tools and invalid timestamps are rejected without writing a file.
  assert.equal(store.recordWebApiCall({ ts: firstTs, tool: 'other', ok: true }), false)
  assert.equal(store.recordWebApiCall({ ts: 'nope', tool: 'search', ok: true }), true, 'a missing timestamp falls back to now')
  assert.equal(store.recordWebApiCall({ tool: 'search' }), true)

  // Web API counters never create or alter request detail or daily aggregates.
  const today = dayKey(Date.now())
  assert.equal(fs.existsSync(path.join(dataRoot, 'requests', `${today}.jsonl`)), false)
  assert.equal(fs.existsSync(path.join(dataRoot, 'daily', `${today}.json`)), false)
  assert.equal(store.readSummary({ from: today, to: today }).totals.requests, 0)
  store.dispose()
})

test('readWebApi aggregates an inclusive range and treats absent days as zero', (t) => {
  const home = tempHome(t)
  const store = createStore({ config: makeConfig(), homeDir: home, profile: 'test' })
  const dataRoot = store.getState().dataRoot
  const today = dayKey(Date.now())
  const day0 = shiftDays(today, -2)
  const day1 = shiftDays(today, -1)
  writeWebApiFile(dataRoot, day0, { search: { ok: 2 }, fetch: { failed: 1 } })
  writeWebApiFile(dataRoot, day1, { search: { ok: 1 }, fetch: { ok: 1 } })
  writeWebApiFile(dataRoot, shiftDays(today, 1), { search: { ok: 9 } })

  assert.deepEqual(store.readWebApi({ from: day0, to: day1 }), {
    search: { ok: 3, failed: 0, total: 3 },
    fetch: { ok: 1, failed: 1, total: 2 },
    calls: { ok: 4, failed: 1, total: 5 },
    // The fixture files predate the per-session map, so nothing is attributed.
    bySession: [],
    unattributed: {
      search: { ok: 3, failed: 0, total: 3 },
      fetch: { ok: 1, failed: 1, total: 2 },
      calls: { ok: 4, failed: 1, total: 5 },
      cost: { amount: 0.02, currency: 'CNY', priced: true },
    },
  })
  assert.deepEqual(store.readWebApi({ from: day1, to: day1 }).calls, { ok: 2, failed: 0, total: 2 })
  // A reversed or empty range yields zeros, not an error.
  assert.deepEqual(store.readWebApi({ from: day1, to: day0 }), {
    search: { ok: 0, failed: 0, total: 0 },
    fetch: { ok: 0, failed: 0, total: 0 },
    calls: { ok: 0, failed: 0, total: 0 },
    bySession: [],
    unattributed: {
      search: { ok: 0, failed: 0, total: 0 },
      fetch: { ok: 0, failed: 0, total: 0 },
      calls: { ok: 0, failed: 0, total: 0 },
      cost: { amount: 0, currency: 'CNY', priced: false },
    },
  })
  // No explicit range defaults to the request-retention window ending today.
  const defaulted = store.readWebApi()
  assert.equal(defaulted.calls.ok, 4)
  assert.equal(defaulted.calls.failed, 1)
  assert.equal(defaulted.calls.total, 5)
  store.dispose()
})

test('webapi files follow daily retention and survive reprice/daily rebuild', (t) => {
  const home = tempHome(t)
  const config = makeConfig({ retainDailyDays: 2, retainRequestDays: 30 })
  const today = dayKey(Date.now())
  const oldDay = shiftDays(today, -5)
  const keptDay = shiftDays(today, -1)
  const dataRoot = writeMetaFor(home, config)
  writeWebApiFile(dataRoot, oldDay, { search: { ok: 7 } })
  writeWebApiFile(dataRoot, keptDay, { search: { ok: 2 } })

  const first = createStore({ config, homeDir: home, profile: 'test' })
  assert.equal(fs.existsSync(path.join(dataRoot, 'webapi', `${oldDay}.json`)), false, 'old counters pruned')
  assert.equal(fs.existsSync(path.join(dataRoot, 'webapi', `${keptDay}.json`)), true, 'retained counters kept')
  assert.equal(first.recordWebApiCall({ ts: new Date(`${keptDay}T10:00:00`).getTime(), tool: 'fetch', ok: true }), true)
  const beforeText = fs.readFileSync(path.join(dataRoot, 'webapi', `${keptDay}.json`), 'utf8')
  assert.deepEqual(first.readWebApi({ from: keptDay, to: keptDay }).calls, { ok: 3, failed: 0, total: 3 })
  first.dispose()

  // A price-table change triggers a reprice pass over request detail; the web
  // API files are outside that pipeline and stay byte-identical.
  const changed = makeConfig({
    retainDailyDays: 2,
    retainRequestDays: 30,
    pricingOffPeakDays: [],
    webApiPricing: { searchPerThousand: 50, fetchPerThousand: 5, currency: 'CNY' },
  })
  const second = createStore({ config: changed, homeDir: home, profile: 'test' })
  assert.equal(fs.readFileSync(path.join(dataRoot, 'webapi', `${keptDay}.json`), 'utf8'), beforeText)
  assert.equal(second.readWebApi({ from: keptDay, to: keptDay }).search.ok, 2)
  const summary = second.readSummary({ from: keptDay, to: keptDay })
  assert.equal(summary.webApi.search.ok, 2)
  assert.equal(summary.webApi.fetch.ok, 1)
  assert.equal(summary.webApi.cost.amount, 0.105, 'custom search and fetch prices are applied')
  second.dispose()
})

test('a read-only store skips webapi writes but still reads existing counters', (t) => {
  const home = tempHome(t)
  const config = makeConfig()
  const today = dayKey(Date.now())
  const dataRoot = path.join(home, 'token-attribution', 'data', 'test')
  writeWebApiFile(dataRoot, today, { search: { ok: 4 } })
  const stateRoot = path.join(home, 'token-attribution', 'state', 'test')
  ensureDir(stateRoot)
  const lockPath = path.join(stateRoot, 'lock')
  atomicWriteFileSync(lockPath, JSON.stringify({ pid: process.ppid, startedAt: Date.now() }))

  const store = createStore({ config, homeDir: home, profile: 'test' })
  assert.equal(store.getState().readOnly, true)
  const before = fs.readFileSync(path.join(dataRoot, 'webapi', `${today}.json`), 'utf8')
  assert.equal(store.recordWebApiCall({ ts: Date.now(), tool: 'search', ok: true, sessionId: 'sess-ro' }), false)
  assert.equal(fs.readFileSync(path.join(dataRoot, 'webapi', `${today}.json`), 'utf8'), before)
  assert.deepEqual(store.readWebApi({ from: today, to: today }).search, { ok: 4, failed: 0, total: 4 })
  assert.deepEqual(store.readWebApi({ from: today, to: today }).bySession, [], 'a skipped write adds no session bucket')
  assert.equal(store.readSummary({ from: today, to: today }).webApi.search.ok, 4)
  store.dispose()
  assert.equal(fs.existsSync(lockPath), true)
})

test('malformed webapi day files are skipped with a diagnostic', (t) => {
  const home = tempHome(t)
  const dataRoot = path.join(home, 'token-attribution', 'data', 'test')
  const today = dayKey(Date.now())
  const badDay = shiftDays(today, -1)
  const shapeDay = shiftDays(today, -2)
  ensureDir(path.join(dataRoot, 'webapi'))
  atomicWriteFileSync(path.join(dataRoot, 'webapi', `${badDay}.json`), 'not json')
  atomicWriteFileSync(path.join(dataRoot, 'webapi', `${shapeDay}.json`), JSON.stringify({ v: 2, search: { ok: 100 } }))
  writeWebApiFile(dataRoot, today, { search: { ok: 3, failed: 1 } })
  const diagnostics = []
  const store = createStore({ config: makeConfig(), homeDir: home, profile: 'test', diag: message => diagnostics.push(message) })
  const counts = store.readWebApi({ from: shapeDay, to: today })
  assert.deepEqual(counts.search, { ok: 3, failed: 1, total: 4 })
  assert.ok(diagnostics.some(message => message.includes(`${badDay}.json is not valid JSON`)))
  assert.ok(diagnostics.some(message => message.includes(`${shapeDay}.json has an unexpected shape`)))
  store.dispose()
})

test('summary.webApi adds counters and a configured-price cost estimate', (t) => {
  const home = tempHome(t)
  const config = makeConfig()
  const store = createStore({ config, homeDir: home, profile: 'test' })
  const today = dayKey(Date.now())
  const ts = new Date(`${today}T10:00:00`).getTime()

  // Without any observed call the block is present with zeros.
  const empty = store.readSummary({ from: today, to: today })
  assert.deepEqual(empty.webApi, {
    search: { ok: 0, failed: 0, total: 0 },
    fetch: { ok: 0, failed: 0, total: 0 },
    calls: { ok: 0, failed: 0, total: 0 },
    bySession: [],
    unattributed: {
      search: { ok: 0, failed: 0, total: 0 },
      fetch: { ok: 0, failed: 0, total: 0 },
      calls: { ok: 0, failed: 0, total: 0 },
      cost: { amount: 0, currency: 'CNY', priced: false },
    },
    cost: { amount: 0, currency: 'CNY', priced: false },
  })
  assert.equal(empty.totals.requests, 0)

  for (let index = 0; index < 3; index += 1) {
    assert.equal(store.recordWebApiCall({ ts, tool: 'search', ok: true }), true)
  }
  assert.equal(store.recordWebApiCall({ ts, tool: 'search', ok: false }), true)
  assert.equal(store.recordWebApiCall({ ts, tool: 'fetch', ok: true }), true)

  const summary = store.readSummary({ from: today, to: today })
  assert.deepEqual(summary.webApi.search, { ok: 3, failed: 1, total: 4 })
  assert.deepEqual(summary.webApi.fetch, { ok: 1, failed: 0, total: 1 })
  assert.deepEqual(summary.webApi.calls, { ok: 4, failed: 1, total: 5 })
  assert.deepEqual(summary.webApi.cost, { amount: 0.02, currency: 'CNY', priced: true })
  // Web API calls are not token requests and never enter the token totals.
  assert.equal(summary.totals.requests, 0)
  assert.equal(summary.totals.totalTokens, 0)
  store.dispose()

  // A custom price table and currency price the same observed counters.
  const customHome = tempHome(t)
  const custom = createStore({
    config: makeConfig({ webApiPricing: { searchPerThousand: 10, fetchPerThousand: 2.5, currency: 'USD' } }),
    homeDir: customHome,
    profile: 'test',
  })
  custom.recordWebApiCall({ ts, tool: 'search', ok: true })
  custom.recordWebApiCall({ ts, tool: 'search', ok: true })
  custom.recordWebApiCall({ ts, tool: 'search', ok: true })
  custom.recordWebApiCall({ ts, tool: 'fetch', ok: true })
  const priced = custom.readSummary({ from: today, to: today })
  assert.deepEqual(priced.webApi.cost, { amount: 0.0325, currency: 'USD', priced: true })
  custom.dispose()

  // Only successful calls are billable: failures alone stay unpriced at zero.
  const failedHome = tempHome(t)
  const failed = createStore({ config: makeConfig(), homeDir: failedHome, profile: 'test' })
  failed.recordWebApiCall({ ts, tool: 'search', ok: false })
  const failedSummary = failed.readSummary({ from: today, to: today })
  assert.deepEqual(failedSummary.webApi.cost, { amount: 0, currency: 'CNY', priced: false })
  assert.equal(failedSummary.webApi.search.failed, 1)
  failed.dispose()
})

test('webapi call counts are attributed per session across days and ranges', (t) => {
  const home = tempHome(t)
  const store = createStore({ config: makeConfig(), homeDir: home, profile: 'test' })
  const dataRoot = store.getState().dataRoot
  const today = dayKey(Date.now())
  const day0 = shiftDays(today, -1)
  const ts0 = new Date(`${day0}T10:00:00`).getTime()
  const ts1 = new Date(`${today}T10:00:00`).getTime()
  const record = (ts, tool, ok, sessionId) => {
    assert.equal(store.recordWebApiCall({ ts, tool, ok, sessionId }), true)
  }

  // Session A: a search on each day and a failed fetch; the second id is padded
  // to prove the store trims it into the same bucket.
  record(ts0, 'search', true, 'sess-a')
  record(ts1, 'search', true, '  sess-a  ')
  record(ts1, 'fetch', false, 'sess-a')
  // Session B: a failed search and three successful fetches.
  record(ts0, 'search', false, 'sess-b')
  record(ts1, 'fetch', true, 'sess-b')
  record(ts1, 'fetch', true, 'sess-b')
  record(ts1, 'fetch', true, 'sess-b')
  // A call without a session id falls into the `unknown` bucket.
  record(ts1, 'search', true, undefined)

  const dayFile = JSON.parse(fs.readFileSync(path.join(dataRoot, 'webapi', `${today}.json`), 'utf8'))
  assert.deepEqual(dayFile.sessions['sess-a'], { search: { ok: 1, failed: 0 }, fetch: { ok: 0, failed: 1 } })
  assert.deepEqual(dayFile.sessions['sess-b'], { search: { ok: 0, failed: 0 }, fetch: { ok: 3, failed: 0 } })
  assert.deepEqual(dayFile.sessions.unknown, { search: { ok: 1, failed: 0 }, fetch: { ok: 0, failed: 0 } })
  const day0File = JSON.parse(fs.readFileSync(path.join(dataRoot, 'webapi', `${day0}.json`), 'utf8'))
  assert.deepEqual(Object.keys(day0File.sessions).sort(), ['sess-a', 'sess-b'])

  // Range totals are unchanged by the session breakdown, and the session rows
  // sum exactly to those totals.
  const counts = store.readWebApi({ from: day0, to: today })
  assert.deepEqual(counts.search, { ok: 3, failed: 1, total: 4 })
  assert.deepEqual(counts.fetch, { ok: 3, failed: 1, total: 4 })
  assert.deepEqual(counts.calls, { ok: 6, failed: 2, total: 8 })
  assert.deepEqual(counts.bySession, [
    {
      sessionId: 'sess-b',
      search: { ok: 0, failed: 1, total: 1 },
      fetch: { ok: 3, failed: 0, total: 3 },
      calls: { ok: 3, failed: 1, total: 4 },
      cost: { amount: 0.015, currency: 'CNY', priced: true },
    },
    {
      sessionId: 'sess-a',
      search: { ok: 2, failed: 0, total: 2 },
      fetch: { ok: 0, failed: 1, total: 1 },
      calls: { ok: 2, failed: 1, total: 3 },
      cost: { amount: 0.01, currency: 'CNY', priced: true },
    },
    {
      sessionId: 'unknown',
      search: { ok: 1, failed: 0, total: 1 },
      fetch: { ok: 0, failed: 0, total: 0 },
      calls: { ok: 1, failed: 0, total: 1 },
      cost: { amount: 0.005, currency: 'CNY', priced: true },
    },
  ])
  const sessionSearch = counts.bySession.reduce((sum, row) => sum + row.search.ok + row.search.failed, 0)
  const sessionFetch = counts.bySession.reduce((sum, row) => sum + row.fetch.ok + row.fetch.failed, 0)
  assert.equal(sessionSearch + sessionFetch, counts.calls.total)

  // A single-day range only sums that day's buckets. Both rows tie on call and
  // search counts, so the session id breaks the tie ascending.
  const firstDay = store.readWebApi({ from: day0, to: day0 })
  assert.deepEqual(firstDay.calls, { ok: 1, failed: 1, total: 2 })
  assert.deepEqual(firstDay.bySession.map(row => row.sessionId), ['sess-a', 'sess-b'])
  assert.deepEqual(firstDay.bySession.map(row => row.cost), [
    { amount: 0.005, currency: 'CNY', priced: true },
    { amount: 0, currency: 'CNY', priced: false },
  ])

  // The summary carries the same per-session rows next to the unchanged totals.
  const summary = store.readSummary({ from: day0, to: today })
  assert.deepEqual(summary.webApi.bySession, counts.bySession)
  assert.deepEqual(summary.webApi.calls, counts.calls)
  assert.deepEqual(summary.webApi.cost, { amount: 0.03, currency: 'CNY', priced: true })
  store.dispose()
})

test('pre-M2.5 webapi files load unchanged and gain session buckets only for new calls', (t) => {
  const home = tempHome(t)
  const dataRoot = path.join(home, 'token-attribution', 'data', 'test')
  const today = dayKey(Date.now())
  writeWebApiFile(dataRoot, today, { search: { ok: 2, failed: 1 }, fetch: { ok: 1 } })
  const store = createStore({ config: makeConfig(), homeDir: home, profile: 'test' })

  const legacy = store.readWebApi({ from: today, to: today })
  assert.deepEqual(legacy.search, { ok: 2, failed: 1, total: 3 })
  assert.deepEqual(legacy.fetch, { ok: 1, failed: 0, total: 1 })
  assert.deepEqual(legacy.bySession, [], 'legacy day totals carry no session attribution')
  assert.deepEqual(store.readSummary({ from: today, to: today }).webApi.bySession, [])

  assert.equal(store.recordWebApiCall({
    ts: new Date(`${today}T10:00:00`).getTime(),
    tool: 'search',
    ok: true,
    sessionId: 'sess-new',
  }), true)
  const after = store.readWebApi({ from: today, to: today })
  assert.deepEqual(after.search, { ok: 3, failed: 1, total: 4 }, 'the legacy totals are preserved')
  assert.deepEqual(after.bySession, [{
    sessionId: 'sess-new',
    search: { ok: 1, failed: 0, total: 1 },
    fetch: { ok: 0, failed: 0, total: 0 },
    calls: { ok: 1, failed: 0, total: 1 },
    cost: { amount: 0.005, currency: 'CNY', priced: true },
  }])
  // The upgrade scenario: legacy totals stay visible as the exact remainder
  // while the new session-attributed call is subtracted from them.
  assert.deepEqual(after.unattributed, {
    search: { ok: 2, failed: 1, total: 3 },
    fetch: { ok: 1, failed: 0, total: 1 },
    calls: { ok: 3, failed: 1, total: 4 },
    cost: { amount: 0.015, currency: 'CNY', priced: true },
  })
  // The rewritten file keeps the old totals and adds the session map.
  const file = JSON.parse(fs.readFileSync(path.join(dataRoot, 'webapi', `${today}.json`), 'utf8'))
  assert.deepEqual(file.search, { ok: 3, failed: 1 })
  assert.deepEqual(file.fetch, { ok: 1, failed: 0 })
  assert.deepEqual(Object.keys(file.sessions), ['sess-new'])
  store.dispose()
})

test('a day keeps at most 500 session buckets and overflows new sessions into unknown', (t) => {
  const home = tempHome(t)
  const diagnostics = []
  const store = createStore({
    config: makeConfig(),
    homeDir: home,
    profile: 'test',
    diag: message => diagnostics.push(message),
  })
  const dataRoot = store.getState().dataRoot
  const today = dayKey(Date.now())
  const ts = new Date(`${today}T10:00:00`).getTime()

  const total = MAX_WEB_API_SESSIONS + 100
  for (let index = 0; index < total; index += 1) {
    assert.equal(store.recordWebApiCall({
      ts,
      tool: index % 2 === 0 ? 'search' : 'fetch',
      ok: true,
      sessionId: `sess-${index}`,
    }), true)
  }

  const file = JSON.parse(fs.readFileSync(path.join(dataRoot, 'webapi', `${today}.json`), 'utf8'))
  const keys = Object.keys(file.sessions)
  assert.equal(keys.length, MAX_WEB_API_SESSIONS)
  assert.equal(keys.filter(key => key !== 'unknown').length, MAX_WEB_API_SESSIONS - 1)
  // 101 overflowing calls (600 - 499 named buckets) land in `unknown`; the
  // even/odd split alternates search/fetch.
  assert.deepEqual(file.sessions.unknown, { search: { ok: 50, failed: 0 }, fetch: { ok: 51, failed: 0 } })
  // The cap never changes the authoritative day totals.
  assert.deepEqual(file.search, { ok: 300, failed: 0 })
  assert.deepEqual(file.fetch, { ok: 300, failed: 0 })
  assert.equal(diagnostics.filter(message => message.includes('session buckets')).length, 1, 'one diagnostic per day')

  const counts = store.readWebApi({ from: today, to: today })
  assert.deepEqual(counts.calls, { ok: 600, failed: 0, total: 600 })
  assert.equal(counts.bySession.length, MAX_WEB_API_SESSION_ROWS)
  assert.equal(counts.bySession[0].sessionId, 'unknown')
  assert.equal(counts.bySession[0].calls.total, 101)
  store.dispose()
})

test('malformed webapi session entries are normalized without diagnostics', (t) => {
  const home = tempHome(t)
  const dataRoot = path.join(home, 'token-attribution', 'data', 'test')
  const today = dayKey(Date.now())
  writeWebApiFile(dataRoot, today, {
    search: { ok: 2 },
    sessions: {
      good: { search: { ok: 1, failed: 2 }, fetch: { ok: 3, failed: 0 } },
      nullish: null,
      scalar: 7,
      array: [1, 2],
      badcounts: { search: { ok: 'many', failed: -3 }, fetch: 'nope' },
    },
  })
  const diagnostics = []
  const store = createStore({
    config: makeConfig(),
    homeDir: home,
    profile: 'test',
    diag: message => diagnostics.push(message),
  })
  const counts = store.readWebApi({ from: today, to: today })
  assert.deepEqual(counts.search, { ok: 2, failed: 0, total: 2 })
  assert.equal(counts.bySession.length, 5)
  const byId = new Map(counts.bySession.map(row => [row.sessionId, row]))
  assert.deepEqual(byId.get('good'), {
    sessionId: 'good',
    search: { ok: 1, failed: 2, total: 3 },
    fetch: { ok: 3, failed: 0, total: 3 },
    calls: { ok: 4, failed: 2, total: 6 },
    cost: { amount: 0.02, currency: 'CNY', priced: true },
  })
  for (const id of ['nullish', 'scalar', 'array', 'badcounts']) {
    assert.deepEqual(byId.get(id).calls, { ok: 0, failed: 0, total: 0 }, id)
    assert.deepEqual(byId.get(id).cost, { amount: 0, currency: 'CNY', priced: false }, id)
  }
  assert.deepEqual(diagnostics, [], 'malformed session buckets never report diagnostics')
  store.dispose()
})

test('readWebApi reports the exact unattributed remainder and summary carries it', (t) => {
  const home = tempHome(t)
  const dataRoot = path.join(home, 'token-attribution', 'data', 'test')
  const today = dayKey(Date.now())
  const legacyDay = shiftDays(today, -2)
  const sessionDay = shiftDays(today, -1)
  // Pre-M2.5 day: totals only, so every one of its calls is unattributed.
  writeWebApiFile(dataRoot, legacyDay, { search: { ok: 5, failed: 2 }, fetch: { ok: 1, failed: 1 } })
  // M2.5 day: every call carries a session bucket, including one that
  // overflowed into `unknown`; those are attributed, not unattributed.
  writeWebApiFile(dataRoot, sessionDay, {
    search: { ok: 4, failed: 1 },
    fetch: { ok: 2, failed: 0 },
    sessions: {
      'sess-a': { search: { ok: 2, failed: 0 }, fetch: { ok: 1, failed: 0 } },
      'sess-b': { search: { ok: 1, failed: 1 }, fetch: { ok: 1, failed: 0 } },
      unknown: { search: { ok: 1, failed: 0 }, fetch: { ok: 0, failed: 0 } },
    },
  })
  const store = createStore({ config: makeConfig(), homeDir: home, profile: 'test' })

  const mixed = store.readWebApi({ from: legacyDay, to: sessionDay })
  assert.deepEqual(mixed.search, { ok: 9, failed: 3, total: 12 })
  assert.deepEqual(mixed.fetch, { ok: 3, failed: 1, total: 4 })
  assert.deepEqual(mixed.calls, { ok: 12, failed: 4, total: 16 })
  // Only the legacy day's totals are left over; the `unknown` bucket is a
  // session bucket like any other.
  assert.deepEqual(mixed.unattributed, {
    search: { ok: 5, failed: 2, total: 7 },
    fetch: { ok: 1, failed: 1, total: 2 },
    calls: { ok: 6, failed: 3, total: 9 },
    cost: { amount: 0.03, currency: 'CNY', priced: true },
  })

  // totals === sum(session buckets) + unattributed, field by field.
  const attributed = { search: { ok: 0, failed: 0 }, fetch: { ok: 0, failed: 0 } }
  for (const row of mixed.bySession) {
    for (const tool of ['search', 'fetch']) {
      attributed[tool].ok += row[tool].ok
      attributed[tool].failed += row[tool].failed
    }
  }
  for (const tool of ['search', 'fetch']) {
    assert.equal(mixed[tool].ok, attributed[tool].ok + mixed.unattributed[tool].ok, `${tool}.ok`)
    assert.equal(mixed[tool].failed, attributed[tool].failed + mixed.unattributed[tool].failed, `${tool}.failed`)
    assert.equal(
      mixed[tool].total,
      attributed[tool].ok + attributed[tool].failed + mixed.unattributed[tool].total,
      `${tool}.total`,
    )
  }
  const attributedCalls = attributed.search.ok + attributed.search.failed
    + attributed.fetch.ok + attributed.fetch.failed
  assert.equal(mixed.calls.ok, mixed.unattributed.calls.ok + attributed.search.ok + attributed.fetch.ok)
  assert.equal(mixed.calls.failed, mixed.unattributed.calls.failed + attributed.search.failed + attributed.fetch.failed)
  assert.equal(mixed.calls.total, attributedCalls + mixed.unattributed.calls.total)

  // A range made only of M2.5 days has nothing left over.
  const sessionOnly = store.readWebApi({ from: sessionDay, to: sessionDay })
  assert.deepEqual(sessionOnly.calls, { ok: 6, failed: 1, total: 7 })
  assert.deepEqual(sessionOnly.unattributed, {
    search: { ok: 0, failed: 0, total: 0 },
    fetch: { ok: 0, failed: 0, total: 0 },
    calls: { ok: 0, failed: 0, total: 0 },
    cost: { amount: 0, currency: 'CNY', priced: false },
  })

  // A range with no web API files at all stays zeroed and unpriced.
  const emptyRange = store.readWebApi({ from: today, to: today })
  assert.deepEqual(emptyRange.unattributed, {
    search: { ok: 0, failed: 0, total: 0 },
    fetch: { ok: 0, failed: 0, total: 0 },
    calls: { ok: 0, failed: 0, total: 0 },
    cost: { amount: 0, currency: 'CNY', priced: false },
  })

  // `summary.webApi` spreads the same remainder next to the unchanged totals.
  const summary = store.readSummary({ from: legacyDay, to: sessionDay })
  assert.deepEqual(summary.webApi.unattributed, mixed.unattributed)
  assert.deepEqual(summary.webApi.calls, mixed.calls)
  assert.deepEqual(summary.webApi.cost, { amount: 0.06, currency: 'CNY', priced: true })
  store.dispose()
})

test('unattributed uses the full session map before the bySession row cap and skips bad files', (t) => {
  const home = tempHome(t)
  const dataRoot = path.join(home, 'token-attribution', 'data', 'test')
  const today = dayKey(Date.now())
  const manyDay = shiftDays(today, -1)
  const badJsonDay = shiftDays(today, -4)
  const badShapeDay = shiftDays(today, -3)
  const emptyDay = shiftDays(today, -2)
  const sessionCount = MAX_WEB_API_SESSION_ROWS + 50
  const sessions = {}
  for (let index = 0; index < sessionCount; index += 1) {
    // More buckets than the public row cap, each holding exactly one call.
    sessions[`sess-${String(index).padStart(3, '0')}`] = {
      search: { ok: 1, failed: 0 },
      fetch: { ok: 0, failed: 0 },
    }
  }
  writeWebApiFile(dataRoot, manyDay, { search: { ok: sessionCount }, sessions })
  atomicWriteFileSync(path.join(dataRoot, 'webapi', `${badJsonDay}.json`), 'not json')
  atomicWriteFileSync(path.join(dataRoot, 'webapi', `${emptyDay}.json`), '')
  atomicWriteFileSync(path.join(dataRoot, 'webapi', `${badShapeDay}.json`), JSON.stringify({ v: 2, search: { ok: 500 } }))
  const diagnostics = []
  const store = createStore({
    config: makeConfig(),
    homeDir: home,
    profile: 'test',
    diag: message => diagnostics.push(message),
  })

  const counts = store.readWebApi({ from: badJsonDay, to: manyDay })
  assert.deepEqual(counts.search, { ok: sessionCount, failed: 0, total: sessionCount })
  assert.deepEqual(counts.calls, { ok: sessionCount, failed: 0, total: sessionCount })
  // Rows beyond the cap are still attributed: computed from the full map, the
  // remainder is zero even though only 100 rows are published.
  assert.equal(counts.bySession.length, MAX_WEB_API_SESSION_ROWS)
  assert.deepEqual(counts.unattributed, {
    search: { ok: 0, failed: 0, total: 0 },
    fetch: { ok: 0, failed: 0, total: 0 },
    calls: { ok: 0, failed: 0, total: 0 },
    cost: { amount: 0, currency: 'CNY', priced: false },
  })
  assert.ok(diagnostics.some(message => message.includes(`${badJsonDay}.json is not valid JSON`)))
  assert.ok(diagnostics.some(message => message.includes(`${emptyDay}.json is not valid JSON`)))
  assert.ok(diagnostics.some(message => message.includes(`${badShapeDay}.json has an unexpected shape`)))
  store.dispose()
})
test('unattributed failed calls stay unbilled and use the configured currency', (t) => {
  const home = tempHome(t)
  const config = makeConfig({ webApiPricing: { searchPerThousand: 7.5, fetchPerThousand: 2, currency: 'USD' } })
  const store = createStore({ config, homeDir: home, profile: 'test' })
  const day = dayKey(Date.now())
  const dataRoot = store.getState().dataRoot
  ensureDir(path.join(dataRoot, 'webapi'))
  atomicWriteFileSync(path.join(dataRoot, 'webapi', `${day}.json`), JSON.stringify({
    v: 1,
    day,
    search: { ok: 0, failed: 2 },
    fetch: { ok: 0, failed: 1 },
  }))

  const legacy = store.readWebApi({ from: day, to: day })
  assert.deepEqual(legacy.unattributed.search, { ok: 0, failed: 2, total: 2 })
  assert.deepEqual(legacy.unattributed.fetch, { ok: 0, failed: 1, total: 1 })
  assert.equal(legacy.unattributed.cost.amount, 0)
  assert.equal(legacy.unattributed.cost.currency, 'USD')
  assert.equal(legacy.unattributed.cost.priced, false)

  store.recordWebApiCall({ ts: Date.now(), tool: 'search', ok: true, sessionId: 's1' })
  const mixed = store.readWebApi({ from: day, to: day })
  assert.deepEqual(mixed.search, { ok: 1, failed: 2, total: 3 })
  assert.deepEqual(mixed.unattributed.search, { ok: 0, failed: 2, total: 2 })
  assert.equal(mixed.unattributed.cost.amount, 0)
  assert.equal(mixed.unattributed.cost.priced, false)
  assert.equal(mixed.unattributed.cost.currency, 'USD')
  assert.equal(store.readSummary({ from: day, to: day }).webApi.cost.currency, 'USD')
  store.dispose()
})

test('readSessionDetail scopes a full dashboard to one session and its subtree', (t) => {
  const home = tempHome(t)
  const store = createStore({ config: makeConfig(), homeDir: home, profile: 'test' })
  const today = dayKey(Date.now())
  const day1 = shiftDays(today, -2)
  const day2 = shiftDays(today, -1)
  const at = (day, time) => new Date(`${day}T${time}:00`).getTime()
  const records = [
    makeRecord({
      id: 'p1',
      ts: at(day1, '10:00'),
      sessionId: 'parent',
      purpose: 'chat',
      promptTokens: 100,
      outputTokens: 10,
      categories: { user: 70, 'system:base': 30 },
      usage: { input: 90, cacheRead: 10, cacheWrite: 0, output: 10 },
      cost: { amount: 0.01, priced: true, currency: 'CNY' },
    }),
    makeRecord({
      id: 'c1',
      ts: at(day1, '11:00'),
      sessionId: 'child',
      parentSessionId: 'parent',
      delegationDepth: 1,
      purpose: 'auto-review',
      model: 'deepseek-pro',
      promptTokens: 50,
      outputTokens: 5,
      categories: { 'injected:memory-snapshot': 50 },
      usage: { input: 40, cacheRead: 10, cacheWrite: 0, output: 5 },
      cost: { amount: 0.02, priced: true, currency: 'CNY' },
    }),
    makeRecord({
      id: 'g1',
      ts: at(day2, '10:00'),
      sessionId: 'grand',
      parentSessionId: 'child',
      delegationDepth: 2,
      purpose: 'compaction',
      promptTokens: 30,
      outputTokens: 3,
      categories: { 'tool-result:other:read': 30 },
      usage: { input: 20, cacheRead: 10, cacheWrite: 0, output: 3 },
      cost: { amount: 0, priced: false, currency: 'CNY' },
    }),
    makeRecord({
      id: 'c2',
      ts: at(day2, '11:00'),
      sessionId: 'child2',
      parentSessionId: 'parent',
      delegationDepth: 1,
      purpose: 'chat',
      model: 'deepseek-pro',
      promptTokens: 20,
      outputTokens: 2,
      categories: { 'injected:skill': 20 },
      usage: { input: 20, cacheRead: 0, cacheWrite: 0, output: 2 },
      cost: { amount: 0.005, priced: true, currency: 'CNY' },
    }),
    makeRecord({
      id: 'o1',
      ts: at(day1, '12:00'),
      sessionId: 'other',
      purpose: 'chat',
      model: 'other-model',
      promptTokens: 999,
      outputTokens: 99,
      categories: { user: 999 },
      cost: { amount: 9, priced: true, currency: 'CNY' },
    }),
  ]
  for (const record of records) assert.equal(store.append(record), true)
  store.flushNow()

  // Attributed Web API calls for the selected tree plus an unrelated session.
  store.recordWebApiCall({ ts: at(day1, '10:30'), tool: 'search', ok: true, sessionId: 'parent' })
  store.recordWebApiCall({ ts: at(day1, '11:30'), tool: 'fetch', ok: false, sessionId: 'child' })
  store.recordWebApiCall({ ts: at(day2, '09:00'), tool: 'search', ok: true, sessionId: 'other' })
  store.recordWebApiCall({ ts: at(day2, '09:30'), tool: 'fetch', ok: true, sessionId: 'grand' })

  const fullSummary = store.readSummary({ from: day1, to: day2 })
  assert.ok(fullSummary.bySession.some(row => row.sessionId === 'other'))

  const detail = store.readSessionDetail({ from: day1, to: day2, sessionId: 'parent', includeDescendants: true })
  assert.equal(detail.sessionId, 'parent')
  assert.equal(detail.includeDescendants, true)
  assert.deepEqual(detail.range, { from: day1, to: day2 })
  assert.equal(detail.detailAvailable, true)
  assert.equal(detail.detailPartial, false)
  assert.equal(detail.detailReason, null)
  assert.deepEqual(Object.keys(detail.summary).sort(), Object.keys(fullSummary).sort(),
    'the drill-down summary keeps the readSummary shape')
  assert.equal(detail.session.sessionId, 'parent')
  assert.equal(detail.session.requests, 1)
  assert.equal(detail.session.tokens, 110)
  // Direct children only; the grandchild is included through the descendant
  // walk but is not listed as a direct child.
  assert.deepEqual(detail.children.map(row => row.sessionId), ['child', 'child2'])
  assert.deepEqual(detail.sessionIds, ['parent', 'child', 'child2', 'grand'])

  const summary = detail.summary
  assert.equal(summary.totals.requests, 4)
  assert.equal(summary.totals.promptTokens, 200)
  assert.equal(summary.totals.outputTokens, 20)
  assert.equal(summary.totals.totalTokens, 220)
  assert.equal(summary.totals.measuredRequests, 4)
  assert.equal(summary.totals.estimatedRequests, 0)
  assert.deepEqual([...summary.bySession].map(row => row.sessionId).sort(), ['child', 'child2', 'grand', 'parent'])
  assert.equal(summary.bySession.reduce((sum, row) => sum + row.requests, 0), summary.totals.requests)
  assert.equal(summary.bySession.reduce((sum, row) => sum + row.tokens, 0), summary.totals.totalTokens)
  assert.deepEqual(summary.byPurpose, {
    chat: { requests: 2, promptTokens: 120, outputTokens: 12, cost: { amount: 0.015, currency: 'CNY', priced: true, unpricedRequests: 0 } },
    'auto-review': { requests: 1, promptTokens: 50, outputTokens: 5, cost: { amount: 0.02, currency: 'CNY', priced: true, unpricedRequests: 0 } },
    compaction: { requests: 1, promptTokens: 30, outputTokens: 3, cost: { amount: 0, currency: 'CNY', priced: false, unpricedRequests: 1 } },
  })
  assert.deepEqual(summary.byCategory, {
    user: 70,
    'system:base': 30,
    'injected:memory-snapshot': 50,
    'tool-result:other:read': 30,
    'injected:skill': 20,
  })
  assert.deepEqual(summary.byCategoryGroup, {
    user: 70,
    system: 30,
    memory: 50,
    'tool-result': 30,
    skill: 20,
  })
  assert.deepEqual(summary.byToolGroup, { 'other:read': 30 })
  assert.equal(summary.byModel.length, 2)
  const flash = summary.byModel.find(row => row.model === 'deepseek-flash')
  const pro = summary.byModel.find(row => row.model === 'deepseek-pro')
  assert.equal(flash.requests, 2)
  assert.equal(flash.promptTokens, 130)
  assert.equal(pro.requests, 2)
  assert.equal(pro.promptTokens, 70)
  assert.equal(summary.byModel.some(row => row.model === 'other-model'), false)
  assert.deepEqual(summary.byDay, [
    {
      day: day1,
      requests: 2,
      promptTokens: 150,
      outputTokens: 15,
      estimatedRequests: 0,
      cache: { input: 130, read: 20, write: 0 },
      cost: { amount: 0.03, currency: 'CNY', priced: true, unpricedRequests: 0 },
      costByCurrency: { CNY: { amount: 0.03, priced: true, unpricedRequests: 0 } },
    },
    {
      day: day2,
      requests: 2,
      promptTokens: 50,
      outputTokens: 5,
      estimatedRequests: 0,
      cache: { input: 40, read: 10, write: 0 },
      cost: { amount: 0.005, currency: 'CNY', priced: true, unpricedRequests: 1 },
      costByCurrency: { CNY: { amount: 0.005, priced: true, unpricedRequests: 1 } },
    },
  ])
  assert.deepEqual(summary.cache, { input: 170, read: 30, write: 0, hitRate: 0.15 })
  assert.deepEqual(summary.cost, { amount: 0.035, currency: 'CNY', priced: true, unpricedRequests: 1 })
  assert.deepEqual(summary.totals.costByCurrency, {
    CNY: { amount: 0.035, priced: true, unpricedRequests: 1 },
  })
  assert.equal(summary.data.readOnly, false)

  // Web API rows are filtered to the selected sessions; the range remainder
  // belongs to no session and never appears in a drill-down.
  assert.deepEqual(detail.webApi.search, { ok: 1, failed: 0, total: 1 })
  assert.deepEqual(detail.webApi.fetch, { ok: 1, failed: 1, total: 2 })
  assert.deepEqual(detail.webApi.calls, { ok: 2, failed: 1, total: 3 })
  assert.deepEqual(detail.webApi.cost, { amount: 0.01, currency: 'CNY', priced: true })
  assert.deepEqual(detail.webApi.bySession.map(row => row.sessionId).sort(), ['child', 'grand', 'parent'])
  assert.equal(Object.hasOwn(detail.webApi, 'unattributed'), false)
  assert.deepEqual(summary.webApi.search, detail.webApi.search)
  assert.deepEqual(summary.webApi.unattributed.calls, { ok: 0, failed: 0, total: 0 })

  // `includeDescendants:false` keeps direct children visible but scopes the
  // summary to the selected session alone.
  const single = store.readSessionDetail({ from: day1, to: day2, sessionId: 'parent', includeDescendants: false })
  assert.equal(single.includeDescendants, false)
  assert.deepEqual(single.sessionIds, ['parent'])
  assert.deepEqual(single.children.map(row => row.sessionId), ['child', 'child2'])
  assert.equal(single.summary.totals.requests, 1)
  assert.deepEqual(single.summary.bySession.map(row => row.sessionId), ['parent'])
  assert.deepEqual(single.summary.byPurpose, {
    chat: { requests: 1, promptTokens: 100, outputTokens: 10, cost: { amount: 0.01, currency: 'CNY', priced: true, unpricedRequests: 0 } },
  })
  assert.deepEqual(single.webApi.bySession.map(row => row.sessionId), ['parent'])
  assert.deepEqual(single.webApi.search, { ok: 1, failed: 0, total: 1 })
  assert.deepEqual(single.webApi.fetch, { ok: 0, failed: 0, total: 0 })
  assert.equal(single.webApi.cost.amount, 0.005)

  // The feature defaults to including descendants when the flag is omitted.
  const defaulted = store.readSessionDetail({ from: day1, to: day2, sessionId: 'parent' })
  assert.equal(defaulted.includeDescendants, true)
  assert.deepEqual(defaulted.sessionIds, ['parent', 'child', 'child2', 'grand'])
  store.dispose()
})

test('readSessionDetail synthesizes cards from bySession when detail is gone', (t) => {
  const home = tempHome(t)
  const store = createStore({ config: makeConfig(), homeDir: home, profile: 'test' })
  const day = shiftDays(dayKey(Date.now()), -1)
  const at = new Date(`${day}T10:00:00`).getTime()
  store.append(makeRecord({
    id: 'p1',
    ts: at,
    sessionId: 'parent',
    purpose: 'chat',
    promptTokens: 100,
    outputTokens: 10,
    categories: { user: 100 },
    usage: { input: 80, cacheRead: 20, cacheWrite: 0, output: 10 },
    cost: { amount: 0.01, priced: true, currency: 'CNY' },
  }))
  store.append(makeRecord({
    id: 'c1',
    ts: at + 1000,
    sessionId: 'child',
    parentSessionId: 'parent',
    delegationDepth: 1,
    purpose: 'auto-review',
    promptTokens: 50,
    outputTokens: 5,
    categories: { 'injected:skill': 50 },
    usage: { input: 40, cacheRead: 10, cacheWrite: 0, output: 5 },
    cost: { amount: 0.02, priced: true, currency: 'CNY' },
  }))
  store.flushNow()
  // Keep the daily aggregates but remove every detail row: this is the
  // "detail retention is shorter than aggregate retention" fallback.
  fs.rmSync(path.join(store.getState().dataRoot, 'requests'), { recursive: true, force: true })

  const detail = store.readSessionDetail({ from: day, to: day, sessionId: 'parent', includeDescendants: false })
  assert.equal(detail.detailAvailable, false)
  assert.equal(detail.detailPartial, false)
  assert.equal(detail.detailReason, 'no-detail')
  assert.equal(detail.session.sessionId, 'parent')
  assert.equal(detail.summary.totals.requests, 1)
  assert.equal(detail.summary.totals.promptTokens, 100)
  assert.equal(detail.summary.totals.outputTokens, 10)
  assert.equal(detail.summary.totals.totalTokens, 110)
  assert.equal(detail.summary.totals.measuredRequests, 1)
  assert.equal(detail.summary.totals.estimatedRequests, 0)
  assert.deepEqual(detail.summary.bySession, [detail.session])
  assert.deepEqual(detail.summary.cost, detail.session.cost)
  assert.deepEqual(detail.summary.cache, {
    input: 80,
    read: 20,
    write: 0,
    hitRate: Math.round(20 / 100 * 10000) / 10000,
  })
  assert.deepEqual(detail.summary.byPurpose, {})
  assert.deepEqual(detail.summary.byCategory, {})
  assert.deepEqual(detail.summary.byCategoryGroup, {})
  assert.deepEqual(detail.summary.byToolGroup, {})
  assert.deepEqual(detail.summary.byModel, [])
  assert.deepEqual(detail.summary.byDay, [])
  assert.deepEqual(detail.summary.totals.costByCurrency, {
    CNY: { amount: 0.01, priced: true, unpricedRequests: 0 },
  })
  assert.deepEqual(detail.webApi.bySession, [])
  assert.deepEqual(detail.webApi.cost, { amount: 0, currency: 'CNY', priced: false })

  // The descendant cards are synthesized from every selected row.
  const subtree = store.readSessionDetail({ from: day, to: day, sessionId: 'parent', includeDescendants: true })
  assert.equal(subtree.detailAvailable, false)
  assert.equal(subtree.detailReason, 'no-detail')
  assert.equal(subtree.summary.totals.requests, 2)
  assert.equal(subtree.summary.totals.promptTokens, 150)
  assert.equal(subtree.summary.totals.totalTokens, 165)
  assert.equal(subtree.summary.bySession.length, 2)
  assert.deepEqual(subtree.summary.cache, { input: 120, read: 30, write: 0, hitRate: 0.2 })
  assert.deepEqual(subtree.summary.cost, { amount: 0.03, currency: 'CNY', priced: true, unpricedRequests: 0 })
  store.dispose()
})

test('readSessionDetail flags partial detail and counts only retained rows', (t) => {
  const home = tempHome(t)
  const store = createStore({ config: makeConfig(), homeDir: home, profile: 'test' })
  const today = dayKey(Date.now())
  const day1 = shiftDays(today, -2)
  const day2 = shiftDays(today, -1)
  const at = day => new Date(`${day}T10:00:00`).getTime()
  store.append(makeRecord({ id: 's1a', ts: at(day1), sessionId: 's1', promptTokens: 100, outputTokens: 10, cost: { amount: 0.01, priced: true, currency: 'CNY' } }))
  store.append(makeRecord({ id: 's1b', ts: at(day2), sessionId: 's1', promptTokens: 50, outputTokens: 5, cost: { amount: 0.02, priced: true, currency: 'CNY' } }))
  store.flushNow()
  // Lose the newest day's detail while its daily aggregate remains.
  fs.rmSync(path.join(store.getState().dataRoot, 'requests', `${day2}.jsonl`), { force: true })

  assert.equal(store.readSummary({ from: day1, to: day2 }).bySession[0].requests, 2)
  const detail = store.readSessionDetail({ from: day1, to: day2, sessionId: 's1', includeDescendants: false })
  assert.equal(detail.detailAvailable, true)
  assert.equal(detail.detailPartial, true)
  assert.equal(detail.detailReason, 'partial-detail')
  assert.equal(detail.summary.totals.requests, 1)
  assert.equal(detail.summary.totals.promptTokens, 100)
  assert.deepEqual(detail.summary.byDay.map(row => row.day), [day1])
  assert.deepEqual(detail.summary.bySession.map(row => row.requests), [1])
  store.dispose()
})

test('readSessionDetail includes queued records so the drill-down stays live', (t) => {
  const home = tempHome(t)
  const store = createStore({ config: makeConfig(), homeDir: home, profile: 'test' })
  const day = dayKey(Date.now())
  const now = Date.now()
  store.append(makeRecord({
    id: 'saved',
    ts: now - 1000,
    sessionId: 'parent',
    promptTokens: 100,
    outputTokens: 10,
    cost: { amount: 0.01, priced: true, currency: 'CNY' },
  }))
  store.flushNow()
  store.append(makeRecord({
    id: 'queued',
    ts: now,
    sessionId: 'child',
    parentSessionId: 'parent',
    delegationDepth: 1,
    promptTokens: 40,
    outputTokens: 4,
    cost: { amount: 0.02, priced: true, currency: 'CNY' },
  }))
  assert.equal(store.getState().pending, 1)

  const detail = store.readSessionDetail({ from: day, to: day, sessionId: 'parent', includeDescendants: true })
  assert.equal(detail.detailAvailable, true)
  assert.equal(detail.detailPartial, false)
  assert.equal(detail.detailReason, null)
  assert.equal(detail.summary.totals.requests, 2)
  assert.equal(detail.summary.totals.promptTokens, 140)
  assert.ok(detail.summary.bySession.some(row => row.sessionId === 'child'))
  assert.equal(detail.summary.byDay[0].requests, 2)
  assert.equal(detail.summary.cost.amount, 0.03)
  store.dispose()
})

test('readSessionDetail returns zeroed cards for an unknown session', (t) => {
  const home = tempHome(t)
  const store = createStore({ config: makeConfig(), homeDir: home, profile: 'test' })
  const day = dayKey(Date.now())
  store.append(makeRecord({ id: 'r1', ts: Date.now(), sessionId: 'known' }))
  store.flushNow()

  const detail = store.readSessionDetail({ from: day, to: day, sessionId: 'ghost' })
  assert.equal(detail.sessionId, 'ghost')
  assert.equal(detail.includeDescendants, true)
  assert.equal(detail.detailAvailable, false)
  assert.equal(detail.detailPartial, false)
  assert.equal(detail.detailReason, 'session-not-found')
  assert.equal(detail.session, null)
  assert.deepEqual(detail.children, [])
  assert.deepEqual(detail.sessionIds, ['ghost'])
  assert.equal(detail.summary.totals.requests, 0)
  assert.deepEqual(detail.summary.bySession, [])
  assert.deepEqual(detail.summary.byPurpose, {})
  assert.deepEqual(detail.summary.byModel, [])
  assert.deepEqual(detail.summary.byDay, [])
  assert.deepEqual(detail.summary.cost, { amount: 0, currency: 'CNY', priced: false, unpricedRequests: 0 })
  assert.deepEqual(detail.webApi.calls, { ok: 0, failed: 0, total: 0 })
  assert.deepEqual(detail.webApi.bySession, [])
  assert.deepEqual(detail.webApi.cost, { amount: 0, currency: 'CNY', priced: false })
  store.dispose()
})

test('readSessionDetail survives a parent/child cycle and a self-parent row', (t) => {
  const home = tempHome(t)
  const store = createStore({ config: makeConfig(), homeDir: home, profile: 'test' })
  const day = dayKey(Date.now())
  const at = Date.now()
  const row = (id, sessionId, parentSessionId) => makeRecord({ id, ts: at, sessionId, parentSessionId })
  // A <-> B is a cycle; D hangs off A; C points at itself.
  store.append(row('a', 'A', 'B'))
  store.append(row('b', 'B', 'A'))
  store.append(row('d', 'D', 'A'))
  store.append(row('c', 'C', 'C'))
  store.flushNow()

  const cycle = store.readSessionDetail({ from: day, to: day, sessionId: 'A', includeDescendants: true })
  assert.equal(cycle.detailAvailable, true)
  assert.deepEqual([...cycle.sessionIds].sort(), ['A', 'B', 'D'])
  assert.deepEqual(cycle.children.map(child => child.sessionId), ['B', 'D'])

  const selfParent = store.readSessionDetail({ from: day, to: day, sessionId: 'C', includeDescendants: true })
  assert.deepEqual(selfParent.sessionIds, ['C'])
  assert.deepEqual(selfParent.children, [])
  store.dispose()
})

test('readRequests filters by a sessionIds set without changing sessionId semantics', (t) => {
  const home = tempHome(t)
  const store = createStore({ config: makeConfig(), homeDir: home, profile: 'test' })
  const today = dayKey(Date.now())
  const earlier = shiftDays(today, -1)
  const at = (day, minute) => new Date(`${day}T09:${String(minute).padStart(2, '0')}:00`).getTime()
  const records = [
    makeRecord({ id: 'a1', ts: at(earlier, 0), sessionId: 'alpha', purpose: 'chat' }),
    makeRecord({ id: 'a2', ts: at(earlier, 1), sessionId: 'alpha', purpose: 'auto-review' }),
    makeRecord({ id: 'b1', ts: at(today, 0), sessionId: 'beta', purpose: 'chat' }),
    makeRecord({ id: 'g1', ts: at(today, 1), sessionId: 'gamma', purpose: 'chat' }),
  ]
  const noSession = makeRecord({ id: 'n1', ts: at(today, 2), sessionId: 'removed' })
  delete noSession.sessionId
  for (const record of [...records, noSession]) assert.equal(store.append(record), true)
  store.flushNow()

  const set = store.readRequests({ from: earlier, to: today, sessionIds: ['alpha', 'beta'] })
  assert.equal(set.total, 3)
  assert.deepEqual(set.items.map(item => item.id).sort(), ['a1', 'a2', 'b1'])

  const combined = store.readRequests({ from: earlier, to: today, sessionIds: ['alpha', 'beta'], purpose: 'chat' })
  assert.equal(combined.total, 2)
  assert.deepEqual(combined.items.map(item => item.id).sort(), ['a1', 'b1'])

  const paged = store.readRequests({ from: earlier, to: today, sessionIds: ['alpha', 'beta'], limit: 1, offset: 1 })
  assert.equal(paged.total, 3)
  assert.equal(paged.items.length, 1)

  // `sessionId` and `sessionIds` intersect; disjoint filters match nothing.
  assert.equal(store.readRequests({ from: earlier, to: today, sessionId: 'alpha', sessionIds: ['beta'] }).total, 0)
  assert.equal(store.readRequests({ from: earlier, to: today, sessionId: 'alpha', sessionIds: ['alpha'] }).total, 2)
  assert.equal(store.readRequests({ from: earlier, to: today, sessionIds: ['missing'] }).total, 0)

  // The store defensively ignores an empty/non-array set filter; the RPC
  // endpoint rejects both before they reach the store.
  assert.equal(store.readRequests({ from: earlier, to: today, sessionIds: [] }).total, 5)
  assert.equal(store.readRequests({ from: earlier, to: today, sessionIds: 'alpha' }).total, 5)
  assert.equal(store.readRequests({ from: earlier, to: today, sessionIds: [''] }).total, 5)
  store.dispose()
})
test('readSessionDetail reads web API counters beyond the 100-row session cap', (t) => {
  const home = tempHome(t)
  const config = makeConfig()
  const day = dayKey(Date.now())
  const ts = Date.now()
  const store = createStore({ config, homeDir: home, profile: 'test' })
  const sessions = {}
  for (let index = 0; index < 101; index += 1) {
    const sessionId = `s${String(index).padStart(3, '0')}`
    sessions[sessionId] = { search: { ok: 1, failed: 0 }, fetch: { ok: 0, failed: 0 } }
    store.append(makeRecord({ id: `call-${sessionId}`, ts, sessionId, categories: { user: 1 } }))
  }
  writeWebApiFile(store.getState().dataRoot, day, { search: { ok: 101 }, sessions })

  const detail = store.readSessionDetail({ from: day, to: day, sessionId: 's100', includeDescendants: false })
  assert.deepEqual(detail.webApi.search, { ok: 1, failed: 0, total: 1 })
  assert.deepEqual(detail.webApi.calls, { ok: 1, failed: 0, total: 1 })
  assert.deepEqual(detail.webApi.bySession.map(row => row.sessionId), ['s100'])
  store.dispose()
})
test('summary exposes unpriced reasons and requests can filter unpriced rows', (t) => {
  const home = tempHome(t)
  const store = createStore({ config: makeConfig(), homeDir: home, profile: 'test' })
  const day = dayKey(Date.now())
  const ts = Date.now()
  const unpriced = { amount: 0, priced: false, currency: 'CNY', priceVersion: 'none' }
  store.append(makeRecord({ id: 'aborted', ts, cost: unpriced, usage: null, usageEstimated: true, error: { code: 'ABORTED' } }))
  store.append(makeRecord({ id: 'transport', ts: ts + 1, cost: unpriced, usage: null, usageEstimated: true, error: { code: 'TRANSPORT' } }))
  store.append(makeRecord({ id: 'no-usage', ts: ts + 2, cost: unpriced, usage: null, usageEstimated: true, error: null }))
  store.append(makeRecord({ id: 'no-price', ts: ts + 3, cost: unpriced }))
  store.append(makeRecord({ id: 'priced', ts: ts + 4 }))
  store.flush()

  const summary = store.readSummary({ from: day, to: day })
  assert.equal(summary.cost.unpricedRequests, 4)
  assert.deepEqual(summary.unpricedReasons, {
    aborted: 1,
    transport: 1,
    'no-usage': 1,
    'no-price': 1,
  })

  const page = store.readRequests({ from: day, to: day, unpricedOnly: true, limit: 20 })
  assert.equal(page.total, 4)
  assert.deepEqual(page.items.map(row => row.id).sort(), ['aborted', 'no-price', 'no-usage', 'transport'])
  assert.equal(store.readRequests({ from: day, to: day, unpricedOnly: false }).total, 5)
  store.dispose()
})
test('summary exposes per-model cache buckets for the three-way token columns', (t) => {
  const home = tempHome(t)
  const store = createStore({ config: makeConfig(), homeDir: home, profile: 'test' })
  const day = dayKey(Date.now())
  store.append(makeRecord({ id: 'mc1', ts: Date.now(), promptTokens: 850, usage: { input: 100, cacheRead: 700, cacheWrite: 50, output: 20 } }))
  store.flush()
  const summary = store.readSummary({ from: day, to: day })
  assert.equal(summary.byModel.length, 1)
  assert.deepEqual(summary.byModel[0].cache, { input: 100, read: 700, write: 50 })
  assert.equal(summary.byModel[0].promptTokens, 850)
  store.dispose()
})
