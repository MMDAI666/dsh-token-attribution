import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_CONFIG,
  RESTART_REQUIRED_FIELDS,
  cloneDefaultConfig,
  describeConfig,
  normalizeConfig,
} from '../src/host/config.mjs'
import { createRpcHandler, installRpc, renderExport } from '../src/host/rpc.mjs'
import { dayKey, shiftDays } from '../src/host/util.mjs'

const configModule = {
  DEFAULT_CONFIG,
  cloneDefaultConfig,
  describeConfig,
  normalizeConfig,
  RESTART_REQUIRED_FIELDS,
}

const createFakeStore = () => {
  const calls = []
  return {
    calls,
    readSummary(range) {
      calls.push(['summary', range])
      return { generatedAt: 1, range, totals: { requests: 0 }, readOnly: false }
    },
    readRequests(query) {
      calls.push(['requests', query])
      return { items: [], total: 0 }
    },
    readMeta() {
      calls.push(['meta'])
      return { version: '0.1.0', readOnly: false }
    },
    migrationStatus() {
      calls.push(['migration'])
      return { status: 'ok', currentDataDir: '/data', configuredDataDir: '/data' }
    },
  }
}

const createConfigState = () => ({
  config: cloneDefaultConfig(),
  diagnostics: [],
})

const createContext = ({ editor, entry, extraGet } = {}) => ({
  fiber: entry === undefined ? undefined : { entry },
  get(name) {
    if (name === 'configEditor') return editor
    if (typeof extraGet === 'function') return extraGet(name)
    return undefined
  },
})

const EXPORT_CSV_HEADER = 'day,requests,promptTokens,outputTokens,estimatedRequests,costAmount,currency,priced,unpricedRequests'

const makeExportCost = (amount, priced, unpricedRequests = 0) => ({
  amount,
  currency: 'CNY',
  priced,
  unpricedRequests,
})

const makeExportSummary = () => ({
  generatedAt: 1762900000000,
  range: { from: '2026-11-01', to: '2026-11-03' },
  totals: {
    promptTokens: 300,
    outputTokens: 30,
    totalTokens: 330,
    requests: 3,
    estimatedRequests: 1,
    costByCurrency: { CNY: { amount: 0.03, priced: true, unpricedRequests: 1 } },
  },
  cost: makeExportCost(0.03, true, 1),
  webApi: {
    search: { ok: 4, failed: 1, total: 5 },
    fetch: { ok: 1, failed: 0, total: 1 },
    calls: { ok: 5, failed: 1, total: 6 },
    // The exact remainder between the totals and the session buckets; the
    // export spreads `summary.webApi`, so it must survive unchanged.
    unattributed: {
      search: { ok: 1, failed: 0, total: 1 },
      fetch: { ok: 0, failed: 0, total: 0 },
      calls: { ok: 1, failed: 0, total: 1 },
      cost: { amount: 0.005, currency: 'CNY', priced: true },
    },
    cost: { amount: 0.025, currency: 'CNY', priced: true },
  },
  byDay: [
    { day: '2026-11-01', requests: 1, promptTokens: 100, outputTokens: 10, estimatedRequests: 0, cost: makeExportCost(0.01, true) },
    { day: '2026-11-02', requests: 1, promptTokens: 100, outputTokens: 10, estimatedRequests: 1, cost: makeExportCost(0, false, 1) },
    { day: '2026-11-03', requests: 1, promptTokens: 100, outputTokens: 10, estimatedRequests: 0, cost: makeExportCost(0.02, true) },
  ],
  byPurpose: { chat: { requests: 3, promptTokens: 300, outputTokens: 30, cost: makeExportCost(0.03, true, 1) } },
  byCategory: { user: 150, 'system:base': 150 },
  byToolGroup: { other: 0 },
  byModel: [{
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    requests: 3,
    promptTokens: 300,
    outputTokens: 30,
    tokens: 330,
    cost: makeExportCost(0.03, true, 1),
  }],
  bySession: [{
    sessionId: 's1',
    parentSessionId: null,
    depth: 0,
    tokens: 330,
    requests: 3,
    cost: makeExportCost(0.03, true, 1),
  }],
})

const createExportStore = (summary, profile = 'test-profile') => {
  const calls = []
  return {
    calls,
    readSummary(range) {
      calls.push(['summary', range])
      return { ...summary, range }
    },
    readMeta() {
      calls.push(['meta'])
      return { profile }
    },
  }
}

test('summary resolves relative ranges and validates payloads', async () => {
  const store = createFakeStore()
  const handler = createRpcHandler({ store, configModule, configState: createConfigState(), ctx: createContext() })
  const today = dayKey(Date.now())

  const ok = await handler('summary', { range: '7d' })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.value.range, { from: shiftDays(today, -6), to: today })

  const explicit = await handler('summary', { from: '2026-11-01', to: '2026-11-05' })
  assert.equal(explicit.ok, true)
  assert.deepEqual(explicit.value.range, { from: '2026-11-01', to: '2026-11-05' })

  for (const payload of [{ range: 'year' }, { from: '2026-02-30' }, { to: 'nope' }, { from: '2026-11-05', to: '2026-11-01' }, 42]) {
    const result = await handler('summary', payload)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'bad-request')
  }
})

test('requests validates limit, offset, dates, and purpose', async () => {
  const store = createFakeStore()
  const handler = createRpcHandler({ store, configModule, configState: createConfigState(), ctx: createContext() })
  const valid = await handler('requests', {
    date: '2026-11-11',
    limit: 20,
    offset: 5,
    purpose: 'chat',
  })
  assert.equal(valid.ok, true)
  assert.deepEqual(store.calls.at(-1), ['requests', {
    date: '2026-11-11',
    from: undefined,
    to: undefined,
    limit: 20,
    offset: 5,
    purpose: 'chat',
    sessionId: undefined,
  }])

  for (const payload of [
    { limit: 0 },
    { limit: 201 },
    { limit: 1.5 },
    { offset: -1 },
    { offset: 'x' },
    { date: '2026-13-01' },
    { purpose: '' },
    { purpose: 42 },
  ]) {
    const result = await handler('requests', payload)
    assert.equal(result.ok, false, JSON.stringify(payload))
    assert.equal(result.error.code, 'bad-request')
  }
})

test('requests passes sessionId through and rejects an invalid one', async () => {
  const store = createFakeStore()
  const handler = createRpcHandler({ store, configModule, configState: createConfigState(), ctx: createContext() })

  const scoped = await handler('requests', {
    from: '2026-11-01',
    to: '2026-11-12',
    sessionId: 'session-1',
    purpose: 'chat',
  })
  assert.equal(scoped.ok, true)
  assert.deepEqual(store.calls.at(-1), ['requests', {
    date: undefined,
    from: '2026-11-01',
    to: '2026-11-12',
    limit: 50,
    offset: 0,
    purpose: 'chat',
    sessionId: 'session-1',
  }])

  // An unknown session id is a valid filter; the store decides it matches nothing.
  const unknown = await handler('requests', { date: '2026-11-12', sessionId: 'no-such-session' })
  assert.equal(unknown.ok, true)
  assert.equal(store.calls.at(-1)[1].sessionId, 'no-such-session')

  // Only a non-empty string is accepted, and the failure carries the field name.
  for (const sessionId of ['', 42, null, true, ['s'], {}]) {
    const result = await handler('requests', { sessionId })
    assert.equal(result.ok, false, JSON.stringify(sessionId))
    assert.equal(result.error.code, 'bad-request')
    assert.deepEqual(result.error.details, { field: 'sessionId' })
  }
})

test('meta, migration.status, and unknown endpoints are structured', async () => {
  const store = createFakeStore()
  const handler = createRpcHandler({ store, configModule, configState: createConfigState(), ctx: createContext() })
  assert.deepEqual(await handler('meta', {}), { ok: true, value: { version: '0.1.0', readOnly: false } })
  const migration = await handler('migration.status', {})
  assert.equal(migration.ok, true)
  assert.equal(migration.value.status, 'ok')
  const unknown = await handler('nope', {})
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'unknown-endpoint')
})

test('config.get reports editability, defaults, and field metadata', async () => {
  const store = createFakeStore()
  const readOnlyContext = createContext()
  const readOnlyHandler = createRpcHandler({ store, configModule, configState: createConfigState(), ctx: readOnlyContext })
  const readOnly = await readOnlyHandler('config.get', {})
  assert.equal(readOnly.ok, true)
  assert.equal(readOnly.value.editable, false)
  assert.deepEqual(readOnly.value.restartRequiredFields, [...RESTART_REQUIRED_FIELDS])
  assert.equal(Object.keys(readOnly.value.fields).length, 13)
  assert.ok(Object.hasOwn(readOnly.value.fields, 'pricingOffPeakDays'))
  assert.ok(Object.hasOwn(readOnly.value.fields, 'webApiPricing'))
  assert.equal(readOnly.value.fields.rememberLastTab.type, 'boolean')
  assert.equal(readOnly.value.fields.rememberLastTab.default, false)
  assert.equal(readOnly.value.fields.rememberLastTab.restartRequired, false)
  assert.equal(readOnly.value.defaults.rememberLastTab, false)
  assert.ok(!readOnly.value.restartRequiredFields.includes('rememberLastTab'))
  assert.deepEqual(readOnly.value.defaults, cloneDefaultConfig())
  assert.equal(readOnly.value.values.retainRequestDays, 30)

  const editor = { edit: async () => {} }
  const editableHandler = createRpcHandler({
    store,
    configModule,
    configState: createConfigState(),
    ctx: createContext({ editor }),
  })
  const editable = await editableHandler('config.get', {})
  assert.equal(editable.value.editable, true)
})

test('config.set rejects invalid patches with diagnostics', async () => {
  const store = createFakeStore()
  const handler = createRpcHandler({ store, configModule, configState: createConfigState(), ctx: createContext() })
  for (const payload of [{ patch: null }, { patch: [] }, {}, { patch: { retainRequestDays: 0 } }, { patch: { rpcChannel: 'api' } }]) {
    const result = await handler('config.set', payload)
    assert.equal(result.ok, false, JSON.stringify(payload))
    assert.ok(['bad-request', 'config-invalid'].includes(result.error.code))
  }
  const invalidRange = await handler('config.set', { patch: { retainRequestDays: 0 } })
  assert.equal(invalidRange.error.code, 'config-invalid')
  assert.ok(Array.isArray(invalidRange.error.details.diagnostics))
  assert.ok(invalidRange.error.details.diagnostics.length > 0)
})

test('config.set reports config-readonly without an editor', async () => {
  const store = createFakeStore()
  const handler = createRpcHandler({ store, configModule, configState: createConfigState(), ctx: createContext() })
  const result = await handler('config.set', { patch: { retainRequestDays: 60 } })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'config-readonly')
})

test('config.set persists through the config editor and reports restart fields', async () => {
  const store = createFakeStore()
  const configState = createConfigState()
  const captured = {}
  const editor = {
    async edit(entry, change) {
      captured.entry = entry
      captured.next = change({ dataDir: '', retainRequestDays: 30, profileOnly: 'kept' })
    },
  }
  const handler = createRpcHandler({
    store,
    configModule,
    configState,
    ctx: createContext({ editor, entry: { id: 'token-attribution' } }),
  })
  const result = await handler('config.set', { patch: { retainRequestDays: 60 } })
  assert.equal(result.ok, true)
  assert.equal(result.value.applied, true)
  assert.deepEqual(result.value.restartRequired, [])
  assert.equal(captured.entry.id, 'token-attribution')
  assert.equal(captured.next.retainRequestDays, 60)
  assert.equal(captured.next.dataDir, '')
  assert.equal(captured.next.profileOnly, 'kept')
  assert.equal(configState.config.retainRequestDays, 60)

  const moved = await handler('config.set', { patch: { dataDir: 'D:/tmp/ledger', rpcChannel: '/ledger' } })
  assert.equal(moved.ok, true)
  assert.deepEqual(moved.value.restartRequired, ['dataDir', 'rpcChannel'])
  assert.equal(configState.config.dataDir, 'D:/tmp/ledger')
})

test('config.set wraps editor failures without throwing', async () => {
  const store = createFakeStore()
  const editor = {
    async edit() {
      throw new Error('overridden by home patch')
    },
  }
  const handler = createRpcHandler({
    store,
    configModule,
    configState: createConfigState(),
    ctx: createContext({ editor, entry: { id: 'token-attribution' } }),
  })
  const result = await handler('config.set', { patch: { retainRequestDays: 60 } })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'config-write-failed')
  assert.match(result.error.message, /overridden/)
})

test('store failures are converted to internal errors', async () => {
  const store = {
    readSummary() {
      throw new Error('ledger exploded')
    },
  }
  const handler = createRpcHandler({ store, configModule, configState: createConfigState(), ctx: createContext() })
  const result = await handler('summary', { range: 'today' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'internal')
  assert.match(result.error.message, /ledger exploded/)
})

test('installRpc registers the configured channel and disposes it', () => {
  const store = createFakeStore()
  const configState = createConfigState()
  let injected
  const ctx = {
    inject(deps, callback) {
      injected = { deps, callback }
    },
    get() {
      return undefined
    },
  }
  installRpc(ctx, { store, configModule, configState, diag: () => {} })
  assert.deepEqual(injected.deps, ['connection', 'webServer'])

  const handled = []
  let effectDisposed = false
  const scope = {
    effect(factory) {
      const disposer = factory()
      return () => {
        effectDisposed = true
        if (typeof disposer === 'function') disposer()
      }
    },
    get(name) {
      if (name !== 'connection') return undefined
      return {
        rpc: {
          handle(channel, handler) {
            handled.push({ channel, handler })
            return () => {}
          },
        },
      }
    },
  }
  injected.callback(scope)
  assert.equal(handled.length, 1)
  assert.equal(handled[0].channel, '/token-attribution')
  assert.equal(typeof handled[0].handler, 'function')
  assert.equal(effectDisposed, false)
})

test('installRpc is a no-op without ctx.inject and reports registration failures', () => {
  assert.doesNotThrow(() => installRpc({}, { store: createFakeStore(), configModule, configState: createConfigState() }))
  const diagnostics = []
  installRpc({
    inject() {
      throw new Error('no connection service')
    },
  }, { store: createFakeStore(), configModule, configState: createConfigState(), diag: message => diagnostics.push(message) })
  assert.ok(diagnostics.some(message => message.includes('no connection service')))
})

test('export json returns the documented report, filename, and bytes', async () => {
  const store = createExportStore(makeExportSummary())
  const handler = createRpcHandler({ store, configModule, configState: createConfigState(), ctx: createContext() })
  const result = await handler('export', { format: 'json', from: '2026-11-01', to: '2026-11-03' })
  assert.equal(result.ok, true)
  assert.equal(result.value.filename, 'token-attribution-2026-11-01_2026-11-03.json')
  assert.equal(result.value.mediaType, 'application/json')
  assert.equal(result.value.truncated, false)
  assert.equal(result.value.bytes, Buffer.byteLength(result.value.content, 'utf8'))
  assert.deepEqual(result.value.range, { from: '2026-11-01', to: '2026-11-03' })
  assert.deepEqual(store.calls, [['summary', { from: '2026-11-01', to: '2026-11-03' }], ['meta']])

  const parsed = JSON.parse(result.value.content)
  assert.deepEqual(
    Object.keys(parsed).sort(),
    ['byCategory', 'byCategoryGroup', 'byDay', 'byModel', 'byPurpose', 'bySession', 'byToolGroup', 'cost', 'generatedAt', 'profile', 'range', 'totals', 'webApi'],
  )
  assert.equal(parsed.profile, 'test-profile')
  assert.deepEqual(parsed.range, { from: '2026-11-01', to: '2026-11-03' })
  assert.equal(parsed.byDay.length, 3)
  assert.equal(parsed.byDay[1].cost.unpricedRequests, 1)
  assert.deepEqual(parsed.webApi, {
    search: { ok: 4, failed: 1, total: 5 },
    fetch: { ok: 1, failed: 0, total: 1 },
    calls: { ok: 5, failed: 1, total: 6 },
    unattributed: {
      search: { ok: 1, failed: 0, total: 1 },
      fetch: { ok: 0, failed: 0, total: 0 },
      calls: { ok: 1, failed: 0, total: 1 },
      cost: { amount: 0.005, currency: 'CNY', priced: true },
    },
    cost: { amount: 0.025, currency: 'CNY', priced: true },
  })
  assert.equal(parsed.totals.costByCurrency.CNY.amount, 0.03)
  assert.equal(parsed.data, undefined)
})

test('export json keeps the web API per-session rows', async () => {
  const summary = makeExportSummary()
  summary.webApi.bySession = [{
    sessionId: 's1',
    search: { ok: 2, failed: 0, total: 2 },
    fetch: { ok: 0, failed: 1, total: 1 },
    calls: { ok: 2, failed: 1, total: 3 },
    cost: { amount: 0.01, currency: 'CNY', priced: true },
  }]
  const store = createExportStore(summary)
  const handler = createRpcHandler({ store, configModule, configState: createConfigState(), ctx: createContext() })
  const result = await handler('export', { format: 'json', from: '2026-11-01', to: '2026-11-03' })
  assert.equal(result.ok, true)
  const parsed = JSON.parse(result.value.content)
  // `exportReport` spreads `summary.webApi`, so the new rows need no extra wiring.
  assert.deepEqual(parsed.webApi.bySession, summary.webApi.bySession)
  assert.deepEqual(parsed.webApi.calls, summary.webApi.calls)
  assert.deepEqual(parsed.webApi.unattributed, summary.webApi.unattributed)
})

test('export csv writes RFC4180 rows and defaults to today', async () => {
  const store = createExportStore(makeExportSummary())
  const handler = createRpcHandler({ store, configModule, configState: createConfigState(), ctx: createContext() })
  const result = await handler('export', { format: 'csv', from: '2026-11-01', to: '2026-11-03' })
  assert.equal(result.ok, true)
  assert.equal(result.value.filename, 'token-attribution-2026-11-01_2026-11-03.csv')
  assert.equal(result.value.mediaType, 'text/csv')
  assert.equal(result.value.truncated, false)
  assert.equal(result.value.bytes, Buffer.byteLength(result.value.content, 'utf8'))
  const lines = result.value.content.split('\r\n')
  assert.equal(lines[0], EXPORT_CSV_HEADER)
  assert.equal(lines.at(-1), '')
  assert.equal(lines.length, 5)
  assert.deepEqual(lines[1].split(','), ['2026-11-01', '1', '100', '10', '0', '0.01', 'CNY', 'true', '0'])
  assert.deepEqual(lines[2].split(','), ['2026-11-02', '1', '100', '10', '1', '0', 'CNY', 'false', '1'])
  assert.deepEqual(lines[3].split(','), ['2026-11-03', '1', '100', '10', '0', '0.02', 'CNY', 'true', '0'])

  const today = dayKey(Date.now())
  const defaulted = await handler('export', { format: 'csv' })
  assert.equal(defaulted.ok, true)
  assert.deepEqual(defaulted.value.range, { from: today, to: today })
  assert.equal(defaulted.value.filename, `token-attribution-${today}_${today}.csv`)

  const quoted = renderExport({
    byDay: [{
      day: '2026-11-01',
      requests: 1,
      promptTokens: 1,
      outputTokens: 0,
      estimatedRequests: 0,
      cost: { amount: 0.01, currency: 'CN,Y', priced: true, unpricedRequests: 0 },
    }],
  }, 'csv')
  assert.ok(quoted.content.includes('"CN,Y"'))
})

test('renderExport truncates CSV at a complete row and compacts oversized JSON', () => {
  const byDay = Array.from({ length: 30 }, (_, index) => ({
    day: shiftDays('2026-11-01', index),
    requests: 1,
    promptTokens: 100,
    outputTokens: 10,
    estimatedRequests: index % 2,
    cost: makeExportCost(0.01, true),
  }))
  const report = {
    generatedAt: 1762900000000,
    profile: 'test-profile',
    range: { from: '2026-11-01', to: '2026-11-30' },
    totals: { requests: 30, costByCurrency: { CNY: { amount: 0.3, priced: true, unpricedRequests: 0 } } },
    cost: makeExportCost(0.3, true),
    webApi: {
      search: { ok: 30, failed: 2, total: 32 },
      fetch: { ok: 10, failed: 0, total: 10 },
      calls: { ok: 40, failed: 2, total: 42 },
      cost: { amount: 0.2, currency: 'CNY', priced: true },
      unattributed: {
        search: { ok: 2, failed: 1, total: 3 },
        fetch: { ok: 0, failed: 1, total: 1 },
        calls: { ok: 2, failed: 2, total: 4 },
        cost: { amount: 0.01, currency: 'CNY', priced: true },
      },
    },
    byDay,
    byPurpose: { chat: { requests: 30, promptTokens: 3000, outputTokens: 300, cost: makeExportCost(0.3, true) } },
    byCategory: { user: 150 },
    byToolGroup: { other: 10 },
    byModel: [{ provider: 'p', model: 'm', requests: 30, promptTokens: 3000, outputTokens: 300, tokens: 3300, cost: makeExportCost(0.3, true) }],
    bySession: [{ sessionId: 's1', parentSessionId: null, depth: 0, tokens: 3300, requests: 30, cost: makeExportCost(0.3, true) }],
  }

  const fullCsv = renderExport(report, 'csv')
  assert.equal(fullCsv.truncated, false)
  const fullLines = fullCsv.content.split('\r\n').filter(Boolean)
  assert.equal(fullLines.length, 31)
  const fits = renderExport(report, 'csv', { maxBytes: fullCsv.bytes })
  assert.equal(fits.truncated, false)
  assert.equal(fits.bytes, fullCsv.bytes)
  const cut = renderExport(report, 'csv', { maxBytes: fullCsv.bytes - 1 })
  assert.equal(cut.truncated, true)
  assert.ok(cut.bytes <= fullCsv.bytes - 1)
  assert.equal(cut.content.split('\r\n').filter(Boolean).length, 30)
  assert.ok(cut.content.endsWith('\r\n'))
  const threeLineCap = Buffer.byteLength(`${fullLines[0]}\r\n${fullLines[1]}\r\n${fullLines[2]}\r\n`, 'utf8')
  const partial = renderExport(report, 'csv', { maxBytes: threeLineCap })
  assert.equal(partial.truncated, true)
  assert.ok(partial.bytes <= threeLineCap)
  assert.equal(partial.content.split('\r\n').filter(Boolean).length, 3)

  const fullJson = renderExport(report, 'json')
  assert.equal(fullJson.truncated, false)
  assert.ok(fullJson.bytes > 2000)
  const compact = renderExport(report, 'json', { maxBytes: 2000 })
  assert.equal(compact.truncated, true)
  assert.ok(compact.bytes <= 2000)
  const parsed = JSON.parse(compact.content)
  assert.equal(parsed.truncated, true)
  assert.equal(typeof parsed.note, 'string')
  assert.ok(parsed.note.includes('unattributed'), 'the compact note mentions the kept unattributed remainder')
  assert.deepEqual(parsed.range, report.range)
  assert.deepEqual(parsed.webApi, report.webApi, 'the compact fallback keeps the web API counters')
  for (const key of ['byDay', 'byPurpose', 'byModel', 'bySession']) {
    assert.equal(Object.hasOwn(parsed, key), false, key)
  }
  assert.throws(() => renderExport(report, 'xml'), TypeError)
})

test('export rejects unknown formats and invalid ranges as bad-request', async () => {
  const store = createExportStore(makeExportSummary())
  const handler = createRpcHandler({ store, configModule, configState: createConfigState(), ctx: createContext() })
  for (const payload of [
    {},
    { format: 'xml' },
    { format: 'JSON' },
    { format: 'json', range: 'year' },
    { format: 'json', from: '2026-02-30' },
    { format: 'json', to: 'nope' },
    { format: 'json', from: '2026-11-05', to: '2026-11-01' },
  ]) {
    const result = await handler('export', payload)
    assert.equal(result.ok, false, JSON.stringify(payload))
    assert.equal(result.error.code, 'bad-request')
  }
  assert.equal(store.calls.length, 0)
})
