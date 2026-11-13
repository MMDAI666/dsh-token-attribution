import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { cloneDefaultConfig } from '../src/host/config.mjs'
import {
  MIGRATION_BACKUP_DAYS,
  copyDataRootSync,
  inspectDataRoot,
  readMigrationState,
  runMigration,
  verifyCopiedDataRoot,
} from '../src/host/migration.mjs'
import { createRpcHandler } from '../src/host/rpc.mjs'
import { addRecordToAggregate, createDayAggregate, createStore } from '../src/host/store.mjs'
import { atomicWriteFileSync, dayKey, ensureDir } from '../src/host/util.mjs'

const tempHome = (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dta-migration-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  return home
}

const makeConfig = (overrides = {}) => ({
  ...cloneDefaultConfig(),
  flushIntervalMs: 60000,
  ...overrides,
})

const makeRecord = (id, ts, promptTokens, outputTokens) => ({
  v: 1,
  ts,
  id,
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
  usage: { input: promptTokens, cacheRead: 0, cacheWrite: 0, output: outputTokens, reasoning: 0 },
  usageEstimated: false,
  promptTokens,
  outputTokens,
  estimatedPromptTokens: promptTokens,
  estimateScale: 1,
  estimatorVersion: 'char-v1',
  systemNodes: [],
  categories: { user: promptTokens },
  images: { count: 0, visualTokens: 0, textTokens: 0 },
  files: 0,
  cost: { amount: 0, priced: false, currency: 'CNY', priceVersion: 'none' },
  finish: 'stop',
  durationMs: 1,
  error: null,
})

/**
 * Write a tiny consistent ledger (detail JSONL + matching daily aggregate + meta).
 * @param {string} dataRoot - root to populate.
 * @param {object[]} records - records for one local day.
 * @param {{profile?: string, profileSource?: string}} [metaFields] - meta identity.
 * @returns {{day: string, promptTokens: number, outputTokens: number}} fixture totals.
 */
const writeLedgerRoot = (dataRoot, records, metaFields = {}) => {
  const day = dayKey(records[0].ts)
  ensureDir(path.join(dataRoot, 'requests'))
  ensureDir(path.join(dataRoot, 'daily'))
  fs.writeFileSync(
    path.join(dataRoot, 'requests', `${day}.jsonl`),
    `${records.map(record => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  )
  const aggregate = createDayAggregate(day)
  for (const record of records) addRecordToAggregate(aggregate, record)
  fs.writeFileSync(path.join(dataRoot, 'daily', `${day}.json`), JSON.stringify(aggregate), 'utf8')
  fs.writeFileSync(path.join(dataRoot, 'meta.json'), JSON.stringify({
    v: 1,
    schemaVersion: 1,
    createdAt: records[0].ts,
    installedVersion: '0.1.0',
    estimatorVersion: 'char-v1',
    lastFlush: null,
    profile: metaFields.profile ?? 'desktop',
    profileSource: metaFields.profileSource ?? 'profileContext',
  }), 'utf8')
  return {
    day,
    promptTokens: records.reduce((sum, record) => sum + record.promptTokens, 0),
    outputTokens: records.reduce((sum, record) => sum + record.outputTokens, 0),
  }
}

const writePointer = (stateRoot, dataRoot) => {
  ensureDir(stateRoot)
  atomicWriteFileSync(path.join(stateRoot, 'pointer.json'), JSON.stringify({
    v: 1,
    dataRoot,
    schemaVersion: 1,
    updatedAt: 0,
  }))
}

const migrationStateOf = (stateRoot) => readMigrationState(stateRoot)

const assertNoStaging = (targetRoot) => {
  const parent = path.dirname(targetRoot)
  const base = path.basename(targetRoot)
  const staging = fs.readdirSync(parent).filter(name => name.startsWith(`${base}.staging-`))
  assert.deepEqual(staging, [])
}

test('migration copies a populated root, verifies it, switches the pointer, and backs up the old root', (t) => {
  const home = tempHome(t)
  const oldRoot = path.join(home, 'data-old')
  const newRoot = path.join(home, 'data-new')
  const stateRoot = path.join(home, 'token-attribution', 'state', 'desktop')
  ensureDir(stateRoot)
  const now = Date.now()
  const records = [
    makeRecord('r1', now - 2000, 100, 10),
    makeRecord('r2', now - 1000, 50, 5),
  ]
  const totals = writeLedgerRoot(oldRoot, records)
  writePointer(stateRoot, oldRoot)

  const store = createStore({
    config: makeConfig({ dataDir: newRoot }),
    homeDir: home,
    profile: 'desktop',
  })
  const state = store.getState()
  assert.equal(state.dataRoot, path.resolve(newRoot))
  assert.equal(state.readOnly, false)
  assert.equal(state.migrationStatus, 'ok')

  // Old root was renamed to a backup, not deleted.
  assert.equal(fs.existsSync(oldRoot), false)
  const backups = fs.readdirSync(home).filter(name => name.startsWith('data-old.migrated-'))
  assert.equal(backups.length, 1)
  const backupRoot = path.join(home, backups[0])
  assert.ok(fs.existsSync(path.join(backupRoot, 'requests', `${totals.day}.jsonl`)))

  // New root holds an exact copy.
  const copiedText = fs.readFileSync(path.join(newRoot, 'requests', `${totals.day}.jsonl`), 'utf8')
  const copied = copiedText.trim().split('\n').map(line => JSON.parse(line))
  assert.equal(copied.length, records.length)
  assert.equal(copied.reduce((sum, record) => sum + record.promptTokens, 0), totals.promptTokens)
  assert.equal(copied.reduce((sum, record) => sum + record.outputTokens, 0), totals.outputTokens)
  assert.ok(fs.existsSync(path.join(newRoot, 'daily', `${totals.day}.json`)))
  assert.ok(fs.existsSync(path.join(newRoot, 'meta.json')))
  assertNoStaging(newRoot)

  // Pointer, migration state, and store status agree.
  const pointer = JSON.parse(fs.readFileSync(path.join(stateRoot, 'pointer.json'), 'utf8'))
  assert.equal(pointer.dataRoot, path.resolve(newRoot))
  const migrationState = migrationStateOf(stateRoot)
  assert.equal(migrationState.status, 'ok')
  assert.equal(migrationState.from, path.resolve(oldRoot))
  assert.equal(migrationState.to, path.resolve(newRoot))
  assert.equal(migrationState.error, null)
  assert.equal(migrationState.backup, backupRoot)
  assert.ok(Number.isFinite(migrationState.finishedAt))
  const migration = store.migrationStatus()
  assert.equal(migration.status, 'ok')
  assert.equal(migration.currentDataDir, path.resolve(newRoot))
  assert.equal(migration.configuredDataDir, path.resolve(newRoot))
  assert.equal(migration.backup, backupRoot)

  const summary = store.readSummary({ from: totals.day, to: totals.day })
  assert.equal(summary.totals.requests, 2)
  assert.equal(summary.totals.promptTokens, totals.promptTokens)
  assert.equal(summary.totals.outputTokens, totals.outputTokens)
  assert.equal(summary.data.migrationStatus, 'ok')
  const meta = JSON.parse(fs.readFileSync(path.join(newRoot, 'meta.json'), 'utf8'))
  assert.equal(meta.profile, 'desktop')
  assert.equal(meta.migrationStatus, 'ok')
  assert.equal(meta.migration.status, 'ok')
  assert.equal(meta.migration.from, path.resolve(oldRoot))
  assert.equal(store.readMeta().migrationStatus, 'ok')
  assert.equal(store.readMeta().pointerStatus, 'ok')
  store.dispose()

  // A second startup sees a consistent pointer and must not migrate again.
  const reloaded = createStore({
    config: makeConfig({ dataDir: newRoot }),
    homeDir: home,
    profile: 'desktop',
  })
  assert.equal(reloaded.getState().dataRoot, path.resolve(newRoot))
  assert.equal(reloaded.migrationStatus().status, 'ok')
  assert.equal(reloaded.readSummary({ from: totals.day, to: totals.day }).totals.requests, 2)
  assert.equal(fs.readdirSync(home).filter(name => name.startsWith('data-old.migrated-')).length, 1)
  reloaded.dispose()
})

test('a non-empty target aborts migration, keeps the old root, and leaves the pointer untouched', (t) => {
  const home = tempHome(t)
  const oldRoot = path.join(home, 'data-old')
  const targetRoot = path.join(home, 'data-target')
  const stateRoot = path.join(home, 'token-attribution', 'state', 'desktop')
  ensureDir(stateRoot)
  const now = Date.now()
  const records = [makeRecord('a', now - 1000, 100, 10)]
  writeLedgerRoot(oldRoot, records)
  ensureDir(targetRoot)
  atomicWriteFileSync(path.join(targetRoot, 'keep.txt'), 'do not touch')
  writePointer(stateRoot, oldRoot)
  const pointerPath = path.join(stateRoot, 'pointer.json')
  const pointerBefore = fs.readFileSync(pointerPath, 'utf8')
  const diagnostics = []

  const store = createStore({
    config: makeConfig({ dataDir: targetRoot }),
    homeDir: home,
    profile: 'desktop',
    diag: message => diagnostics.push(message),
  })
  const state = store.getState()
  assert.equal(state.dataRoot, path.resolve(oldRoot))
  assert.equal(state.readOnly, false)
  assert.equal(state.migrationStatus, 'failed')
  assert.equal(fs.readFileSync(pointerPath, 'utf8'), pointerBefore)
  assert.equal(fs.readFileSync(path.join(targetRoot, 'keep.txt'), 'utf8'), 'do not touch')
  assert.equal(fs.existsSync(path.join(targetRoot, 'requests')), false)
  assert.ok(fs.existsSync(path.join(oldRoot, 'requests', `${dayKey(now)}.jsonl`)))
  assert.ok(diagnostics.some(message => message.includes('not empty')))
  const migrationState = migrationStateOf(stateRoot)
  assert.equal(migrationState.status, 'failed')
  assert.equal(migrationState.from, path.resolve(oldRoot))
  assert.equal(migrationState.to, path.resolve(targetRoot))
  assert.match(migrationState.error, /not empty/)
  assert.equal(migrationState.backup, null)
  assert.equal(store.migrationStatus().status, 'failed')
  assert.match(store.migrationStatus().note, /not empty/)

  // Collection continues into the old (pointer) root.
  const day = dayKey(now)
  assert.equal(store.append(makeRecord('after-failure', now, 7, 1)), true)
  store.flushNow()
  assert.ok(fs.existsSync(path.join(oldRoot, 'requests', `${day}.jsonl`)))
  const summary = store.readSummary({ from: day, to: day })
  assert.equal(summary.data.migrationStatus, 'failed')
  assert.equal(summary.totals.requests, 2)
  store.dispose()
})

test('copy/verification failure deletes staging and keeps the old root and pointer', (t) => {
  const home = tempHome(t)
  const oldRoot = path.join(home, 'data-old')
  const targetRoot = path.join(home, 'data-target')
  const stateRoot = path.join(home, 'token-attribution', 'state', 'desktop')
  ensureDir(stateRoot)
  const now = Date.now()
  writeLedgerRoot(oldRoot, [
    makeRecord('a', now - 2000, 100, 10),
    makeRecord('b', now - 1000, 50, 5),
  ])
  writePointer(stateRoot, oldRoot)
  const pointerPath = path.join(stateRoot, 'pointer.json')
  const pointerBefore = fs.readFileSync(pointerPath, 'utf8')
  const diagnostics = []

  // Simulate an incomplete copy: the staging root gets only one of the two records.
  const lossyCopy = (sourceRoot, stagingRoot, options) => {
    const copied = copyDataRootSync(sourceRoot, stagingRoot, options)
    const requestsRoot = path.join(stagingRoot, 'requests')
    const name = fs.readdirSync(requestsRoot).find(entry => entry.endsWith('.jsonl'))
    const lines = fs.readFileSync(path.join(requestsRoot, name), 'utf8').trim().split('\n')
    fs.writeFileSync(path.join(requestsRoot, name), `${lines.slice(0, 1).join('\n')}\n`, 'utf8')
    return copied
  }

  const result = runMigration({
    dshHome: home,
    stateRoot,
    pointerPath,
    configuredDataRoot: targetRoot,
    profile: 'desktop',
    report: message => diagnostics.push(message),
    copy: lossyCopy,
  })
  assert.equal(result.attempted, true)
  assert.equal(result.status, 'failed')
  assert.equal(result.adopted, false)
  assert.equal(result.pointerWritten, false)
  assert.equal(result.dataRoot, path.resolve(oldRoot))
  assert.equal(fs.readFileSync(pointerPath, 'utf8'), pointerBefore)
  assert.equal(fs.existsSync(targetRoot), false)
  assertNoStaging(targetRoot)
  assert.ok(diagnostics.some(message => message.includes('verification failed')))
  const migrationState = migrationStateOf(stateRoot)
  assert.equal(migrationState.status, 'failed')
  assert.match(migrationState.error, /verification failed/)
  // The source is untouched.
  assert.equal(fs.readFileSync(path.join(oldRoot, 'requests', `${dayKey(now)}.jsonl`), 'utf8').trim().split('\n').length, 2)
})

test('copy failure deletes staging and reports a failed migration state', (t) => {
  const home = tempHome(t)
  const oldRoot = path.join(home, 'data-old')
  const targetRoot = path.join(home, 'data-target')
  const stateRoot = path.join(home, 'token-attribution', 'state', 'desktop')
  ensureDir(stateRoot)
  const now = Date.now()
  writeLedgerRoot(oldRoot, [makeRecord('a', now - 1000, 100, 10)])
  writePointer(stateRoot, oldRoot)
  const pointerPath = path.join(stateRoot, 'pointer.json')
  const pointerBefore = fs.readFileSync(pointerPath, 'utf8')
  const diagnostics = []

  const result = runMigration({
    dshHome: home,
    stateRoot,
    pointerPath,
    configuredDataRoot: targetRoot,
    profile: 'desktop',
    report: message => diagnostics.push(message),
    copy(sourceRoot, stagingRoot) {
      copyDataRootSync(sourceRoot, stagingRoot)
      throw new Error('disk exploded')
    },
  })
  assert.equal(result.status, 'failed')
  assert.equal(result.dataRoot, path.resolve(oldRoot))
  assert.equal(fs.readFileSync(pointerPath, 'utf8'), pointerBefore)
  assert.equal(fs.existsSync(targetRoot), false)
  assertNoStaging(targetRoot)
  assert.ok(diagnostics.some(message => message.includes('disk exploded')))
  const migrationState = migrationStateOf(stateRoot)
  assert.equal(migrationState.status, 'failed')
  assert.match(migrationState.error, /disk exploded/)
})

test('a byte-cap abort keeps the old root and reports the limit', (t) => {
  const home = tempHome(t)
  const oldRoot = path.join(home, 'data-old')
  const targetRoot = path.join(home, 'data-target')
  const stateRoot = path.join(home, 'token-attribution', 'state', 'desktop')
  ensureDir(stateRoot)
  writeLedgerRoot(oldRoot, [makeRecord('a', Date.now() - 1000, 100, 10)])
  writePointer(stateRoot, oldRoot)
  const pointerPath = path.join(stateRoot, 'pointer.json')
  const pointerBefore = fs.readFileSync(pointerPath, 'utf8')
  const diagnostics = []

  const result = runMigration({
    dshHome: home,
    stateRoot,
    pointerPath,
    configuredDataRoot: targetRoot,
    profile: 'desktop',
    report: message => diagnostics.push(message),
    maxBytes: 10,
  })
  assert.equal(result.status, 'failed')
  assert.equal(result.dataRoot, path.resolve(oldRoot))
  assert.equal(fs.readFileSync(pointerPath, 'utf8'), pointerBefore)
  assert.equal(fs.existsSync(targetRoot), false)
  assert.ok(diagnostics.some(message => message.includes('cap')))
  assert.match(migrationStateOf(stateRoot).error, /cap/)
})

test('legacy default-profile data is adopted into the current profile root', (t) => {
  const home = tempHome(t)
  const legacyStateRoot = path.join(home, 'token-attribution', 'state', 'default')
  const legacyDataRoot = path.join(home, 'token-attribution', 'data', 'default')
  const desktopStateRoot = path.join(home, 'token-attribution', 'state', 'desktop')
  const desktopDataRoot = path.join(home, 'token-attribution', 'data', 'desktop')
  const now = Date.now()
  const totals = writeLedgerRoot(legacyDataRoot, [
    makeRecord('legacy-1', now - 2000, 200, 20),
    makeRecord('legacy-2', now - 1000, 100, 10),
  ], { profile: 'default', profileSource: 'env-fallback' })
  writePointer(legacyStateRoot, legacyDataRoot)

  const store = createStore({
    config: makeConfig(),
    homeDir: home,
    profile: 'desktop',
    profileSource: 'profileContext',
  })
  const state = store.getState()
  assert.equal(state.dataRoot, path.resolve(desktopDataRoot))
  assert.equal(state.readOnly, false)
  assert.equal(state.migrationStatus, 'adopted')
  assert.equal(store.migrationStatus().status, 'adopted')
  assert.equal(store.migrationStatus().from, path.resolve(legacyDataRoot))

  // Desktop state/data now exist, and the default profile dirs are kept.
  const desktopPointer = JSON.parse(fs.readFileSync(path.join(desktopStateRoot, 'pointer.json'), 'utf8'))
  assert.equal(desktopPointer.dataRoot, path.resolve(desktopDataRoot))
  assert.ok(fs.existsSync(path.join(legacyStateRoot, 'pointer.json')))
  assert.ok(fs.existsSync(path.join(legacyDataRoot, 'requests', `${totals.day}.jsonl`)))
  assert.ok(fs.existsSync(path.join(legacyDataRoot, 'meta.json')))

  const migrationState = migrationStateOf(desktopStateRoot)
  assert.equal(migrationState.status, 'adopted')
  assert.equal(migrationState.from, path.resolve(legacyDataRoot))
  assert.equal(migrationState.to, path.resolve(desktopDataRoot))
  assert.equal(migrationState.backup, path.resolve(legacyDataRoot))
  assert.ok(Number.isFinite(migrationState.finishedAt))

  const meta = JSON.parse(fs.readFileSync(path.join(desktopDataRoot, 'meta.json'), 'utf8'))
  assert.equal(meta.profile, 'desktop')
  assert.equal(meta.profileSource, 'adopted-legacy-default')
  assert.equal(meta.migrationStatus, 'adopted')
  assert.equal(meta.migration.from, path.resolve(legacyDataRoot))
  assert.equal(store.readMeta().profileSource, 'adopted-legacy-default')
  assert.equal(store.readMeta().migrationStatus, 'adopted')

  const summary = store.readSummary({ from: totals.day, to: totals.day })
  assert.equal(summary.totals.requests, 2)
  assert.equal(summary.totals.promptTokens, totals.promptTokens)
  assert.equal(summary.totals.outputTokens, totals.outputTokens)
  assert.equal(summary.data.migrationStatus, 'adopted')
  store.dispose()

  // Adoption is recorded in migration.json, so a later startup reports it and
  // does not copy the legacy ledger again.
  const reloaded = createStore({
    config: makeConfig(),
    homeDir: home,
    profile: 'desktop',
    profileSource: 'profileContext',
  })
  assert.equal(reloaded.getState().dataRoot, path.resolve(desktopDataRoot))
  assert.equal(reloaded.migrationStatus().status, 'adopted')
  assert.equal(reloaded.readMeta().profileSource, 'adopted-legacy-default')
  assert.equal(reloaded.readSummary({ from: totals.day, to: totals.day }).totals.requests, 2)
  reloaded.dispose()
})

test('the default profile does not adopt its own legacy data', (t) => {
  const home = tempHome(t)
  const legacyStateRoot = path.join(home, 'token-attribution', 'state', 'default')
  const legacyDataRoot = path.join(home, 'token-attribution', 'data', 'default')
  const now = Date.now()
  // A default-profile store already owns data/default and has no pointer; the
  // adoption branch must stay disabled because profile === 'default'.
  writeLedgerRoot(legacyDataRoot, [makeRecord('b', now - 900, 20, 2)])
  ensureDir(legacyStateRoot)

  const result = runMigration({
    dshHome: home,
    stateRoot: legacyStateRoot,
    pointerPath: path.join(legacyStateRoot, 'pointer.json'),
    configuredDataRoot: legacyDataRoot,
    profile: 'default',
  })
  assert.equal(result.status, 'ok')
  assert.equal(result.attempted, false)
  assert.equal(result.dataRoot, path.resolve(legacyDataRoot))
  assert.equal(fs.readdirSync(legacyStateRoot).includes('migration.json'), false)
})

test('startup prunes .migrated-* backups older than seven days and keeps recent ones', (t) => {
  const home = tempHome(t)
  const dataRoot = path.join(home, 'token-attribution', 'data', 'test')
  const oldBackup = `${dataRoot}.migrated-20260101T000000000`
  const recentBackup = `${dataRoot}.migrated-20261101T000000000`
  ensureDir(oldBackup)
  ensureDir(recentBackup)
  const oldTime = new Date(Date.now() - (MIGRATION_BACKUP_DAYS + 1) * 24 * 60 * 60 * 1000)
  const recentTime = new Date(Date.now() - 24 * 60 * 60 * 1000)
  fs.utimesSync(oldBackup, oldTime, oldTime)
  fs.utimesSync(recentBackup, recentTime, recentTime)

  const store = createStore({ config: makeConfig(), homeDir: home, profile: 'test' })
  assert.equal(fs.existsSync(oldBackup), false)
  assert.equal(fs.existsSync(recentBackup), true)
  store.dispose()
})

test('migration.status RPC keeps the existing fields and adds migration details', async (t) => {
  const home = tempHome(t)
  const oldRoot = path.join(home, 'data-old')
  const targetRoot = path.join(home, 'data-target')
  const stateRoot = path.join(home, 'token-attribution', 'state', 'desktop')
  ensureDir(stateRoot)
  const now = Date.now()
  writeLedgerRoot(oldRoot, [makeRecord('a', now - 1000, 10, 1)])
  writePointer(stateRoot, oldRoot)

  const store = createStore({
    config: makeConfig({ dataDir: targetRoot }),
    homeDir: home,
    profile: 'desktop',
  })
  const handler = createRpcHandler({
    store,
    configModule: {},
    configState: { config: {}, diagnostics: [] },
    ctx: {},
  })
  const result = await handler('migration.status', {})
  assert.equal(result.ok, true)
  assert.equal(result.value.currentDataDir, path.resolve(targetRoot))
  assert.equal(result.value.configuredDataDir, path.resolve(targetRoot))
  assert.equal(result.value.status, 'ok')
  assert.equal(typeof result.value.note, 'string')
  assert.equal(result.value.migration.status, 'ok')
  assert.equal(result.value.from, path.resolve(oldRoot))
  assert.equal(result.value.to, path.resolve(targetRoot))
  assert.ok(Number.isFinite(result.value.startedAt))
  assert.ok(Number.isFinite(result.value.finishedAt))
  assert.equal(result.value.backupDays, MIGRATION_BACKUP_DAYS)
  store.dispose()
})

test('data-root inspection and verification ignore corrupt JSONL lines but report them', (t) => {
  const home = tempHome(t)
  const sourceRoot = path.join(home, 'source')
  const targetRoot = path.join(home, 'target')
  const day = dayKey(Date.now())
  ensureDir(path.join(sourceRoot, 'requests'))
  ensureDir(path.join(sourceRoot, 'daily'))
  const records = [
    makeRecord('a', Date.now() - 1000, 30, 3),
    makeRecord('b', Date.now() - 500, 20, 2),
  ]
  fs.writeFileSync(
    path.join(sourceRoot, 'requests', `${day}.jsonl`),
    `${JSON.stringify(records[0])}\n{broken json\n${JSON.stringify(records[1])}\n`,
    'utf8',
  )
  fs.writeFileSync(path.join(sourceRoot, 'daily', `${day}.json`), JSON.stringify(createDayAggregate(day)), 'utf8')
  fs.writeFileSync(path.join(sourceRoot, 'meta.json'), '{"v":1}', 'utf8')

  const copied = copyDataRootSync(sourceRoot, targetRoot)
  assert.equal(copied.files, 3)
  const verification = verifyCopiedDataRoot(sourceRoot, targetRoot)
  assert.equal(verification.ok, true)
  assert.ok(verification.corruptLines >= 1)
  assert.equal(verification.source.requests.records, 2)
  assert.equal(verification.source.requests.promptTokens, 50)
  assert.equal(verification.source.requests.outputTokens, 5)
  assert.deepEqual(inspectDataRoot(targetRoot).daily.files, [`${day}.json`])
})
