import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createAssembleCache } from '../src/host/assemble.mjs'
import {
  createAttemptTracker,
  installCollector,
  readSessionHeader,
} from '../src/host/collect.mjs'
import { cloneDefaultConfig } from '../src/host/config.mjs'
import { createStore } from '../src/host/store.mjs'

const createFakeCtx = (services = {}) => {
  const listeners = new Map()
  const effects = []
  return {
    listeners,
    effects,
    on(name, listener, options) {
      listeners.set(name, { listener, options })
      return () => listeners.delete(name)
    },
    effect(factory, label) {
      const disposer = factory()
      effects.push({ label, disposer })
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    get(name) {
      return services[name]
    },
  }
}

async function* upstream(chunks) {
  for (const chunk of chunks) yield chunk
}

const drain = async (iterable) => {
  const seen = []
  for await (const chunk of iterable) seen.push(chunk)
  return seen
}

const streamChunks = (outputTokens = 7) => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'hello' },
  { type: 'usage', usage: { inputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 5, outputTokens } },
  { type: 'finish', reason: { kind: 'stop' } },
]

const request = (overrides = {}) => ({
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  sessionId: 's1',
  messages: [
    { role: 'system', id: 'sys', content: [{ type: 'text', text: 'System prompt text' }], source: { kind: 'system-prompt' } },
    { role: 'user', id: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } },
  ],
  ...overrides,
})

const fakeStore = () => ({
  records: [],
  append(record) {
    this.records.push(record)
  },
})

test('collector yields every chunk unchanged and records the finished call', async () => {
  const store = fakeStore()
  const assembler = createAssembleCache()
  assembler.record({
    key: 's1',
    sections: [{ name: 'harness:identity', text: 'System prompt text' }],
    contexts: [],
    variables: {},
  })
  const ctx = createFakeCtx()
  const diagnostics = []
  installCollector(ctx, {
    config: cloneDefaultConfig(),
    store,
    assembler,
    diag: message => diagnostics.push(message),
  })
  const entry = ctx.listeners.get('llm/stream')
  assert.deepEqual(entry.options, { global: true, prepend: true })

  const chunks = streamChunks()
  const seen = await drain(entry.listener(request(), () => upstream(chunks)))
  assert.deepEqual(seen, chunks)
  assert.equal(store.records.length, 1)
  const record = store.records[0]
  assert.equal(record.promptTokens, 125)
  assert.equal(record.outputTokens, 7)
  assert.equal(record.finish, 'stop')
  assert.equal(record.purpose, 'chat')
  assert.equal(record.systemNodes[0].match, 'active')
  assert.ok(record.categories['system:harness:identity'] > 0)
  assert.deepEqual(diagnostics, [])
})

test('collector counts consecutive failed attempts per session and purpose', async () => {
  const store = fakeStore()
  const ctx = createFakeCtx()
  installCollector(ctx, { config: cloneDefaultConfig(), store, assembler: createAssembleCache() })
  const entry = ctx.listeners.get('llm/stream')
  const failureChunks = [
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT' } } },
  ]
  await drain(entry.listener(request({ sessionId: 'retry' }), () => upstream(failureChunks)))
  await drain(entry.listener(request({ sessionId: 'retry' }), () => upstream(failureChunks)))
  await drain(entry.listener(request({ sessionId: 'retry' }), () => upstream(streamChunks())))
  assert.equal(store.records.length, 3)
  assert.deepEqual(store.records.map(record => record.attempt.index), [1, 2, 1])
  assert.deepEqual(store.records.map(record => record.attempt.error), [true, true, false])

  const tracker = createAttemptTracker()
  assert.equal(tracker.next('a', 'chat', { reason: { kind: 'error' } }), 1)
  assert.equal(tracker.next('a', 'chat', { reason: { kind: 'error' } }), 2)
  assert.equal(tracker.next('a', 'chat', { reason: { kind: 'stop' } }), 1)
  assert.equal(tracker.next('b', 'chat', { reason: { kind: 'error' } }), 1)
  assert.equal(tracker.size(), 1)
})

test('consumer cancellation still records the partial call in finally', async () => {
  const store = fakeStore()
  const ctx = createFakeCtx()
  installCollector(ctx, { config: cloneDefaultConfig(), store, assembler: createAssembleCache() })
  const entry = ctx.listeners.get('llm/stream')
  const iterator = entry.listener(request({ sessionId: 'aborted' }), () => upstream(streamChunks()))[Symbol.asyncIterator]()
  await iterator.next()
  await iterator.return()
  assert.equal(store.records.length, 1)
  const record = store.records[0]
  assert.equal(record.usageEstimated, true)
  assert.equal(record.usage, null)
  assert.equal(record.finish, 'unknown')
})

test('attribution errors are isolated into a minimal record', async () => {
  const store = fakeStore()
  const ctx = createFakeCtx()
  const diagnostics = []
  installCollector(ctx, {
    config: cloneDefaultConfig(),
    store,
    assembler: createAssembleCache(),
    diag: message => diagnostics.push(message),
  })
  const entry = ctx.listeners.get('llm/stream')
  const brokenRequest = request({
    sessionId: 'broken',
    messages: [{
      role: 'user',
      id: 'u',
      source: { kind: 'user' },
      content: [{
        get type() {
          throw new Error('boom block')
        },
      }],
    }],
  })
  await drain(entry.listener(brokenRequest, () => upstream(streamChunks())))
  assert.equal(store.records.length, 1)
  const record = store.records[0]
  assert.deepEqual(record.attribution_error, { name: 'Error' })
  assert.ok(!JSON.stringify(record).includes('boom block'))
  assert.ok(!diagnostics.join('\n').includes('boom block'))
  assert.equal(record.v, 1)
  assert.equal(record.purpose, 'chat')
  assert.equal(record.sessionId, 'broken')
  assert.equal(record.usage.inputTokens, 100)
  assert.ok(diagnostics.some(message => message.includes('attribution failed')))
})

test('max-tokens is a successful terminal outcome for attempt tracking', async () => {
  const store = fakeStore()
  const ctx = createFakeCtx()
  installCollector(ctx, { config: cloneDefaultConfig(), store, assembler: createAssembleCache() })
  const entry = ctx.listeners.get('llm/stream')
  const chunks = [
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]
  await drain(entry.listener(request(), () => upstream(chunks)))
  assert.equal(store.records.length, 1)
  assert.equal(store.records[0].finish, 'max-tokens')
  assert.equal(store.records[0].attempt.index, 1)
  assert.equal(store.records[0].attempt.error, false)
  assert.equal(store.records[0].error, null)
})

test('no prompt/system/tool text reaches the ledger (privacy closed loop)', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dta-privacy-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const sentinel = 'SENTINEL_PRIVACY_0123456789'
  const store = createStore({
    ctx: createFakeCtx(),
    config: cloneDefaultConfig(),
    diag: () => {},
    homeDir: home,
    profile: 'privacy',
    profileSource: 'test',
  })
  t.after(() => store.dispose())
  const ctx = createFakeCtx()
  installCollector(ctx, { config: cloneDefaultConfig(), store, assembler: createAssembleCache() })
  const entry = ctx.listeners.get('llm/stream')
  const sentinelRequest = {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    sessionId: 'privacy-session',
    system: sentinel,
    messages: [
      { role: 'system', id: 'sys', content: [{ type: 'text', text: sentinel }], source: { kind: 'system-prompt' } },
      { role: 'user', id: 'u', content: [{ type: 'text', text: sentinel }], source: { kind: 'user' } },
      {
        role: 'assistant',
        id: 'a',
        source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
        content: [
          { type: 'reasoning', text: sentinel },
          { type: 'text', text: sentinel },
          { type: 'tool-call', id: 'call-1', name: 'read', arguments: sentinel },
        ],
      },
      {
        role: 'tool',
        id: 't',
        toolCallId: 'call-1',
        source: { kind: 'tool', callId: 'call-1' },
        content: [{ type: 'text', text: sentinel }],
      },
    ],
  }
  await drain(entry.listener(sentinelRequest, () => upstream(streamChunks())))
  store.flushNow()
  const files = []
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(full)
      else files.push(full)
    }
  }
  walk(path.join(home, 'token-attribution'))
  assert.ok(files.length >= 2)
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8')
    assert.ok(!text.includes(sentinel), `ledger file ${file} leaked prompt text`)
  }
})

test('ledger append failures never break the model stream', async () => {
  const store = {
    append() {
      throw new Error('disk full')
    },
  }
  const ctx = createFakeCtx()
  const diagnostics = []
  installCollector(ctx, {
    config: cloneDefaultConfig(),
    store,
    assembler: createAssembleCache(),
    diag: message => diagnostics.push(message),
  })
  const entry = ctx.listeners.get('llm/stream')
  const chunks = streamChunks()
  const seen = await drain(entry.listener(request(), () => upstream(chunks)))
  assert.deepEqual(seen, chunks)
  assert.ok(diagnostics.some(message => message.includes('ledger append failed')))
})

test('readSessionHeader is guarded and feeds lineage fields into records', async () => {
  const header = { id: 's1', parentSession: 'parent-1', delegationDepth: 1, agentPreset: 'auto' }
  assert.deepEqual(readSessionHeader(createFakeCtx({ sessions: { get: () => ({ header }) } }), 's1'), header)
  assert.equal(readSessionHeader(createFakeCtx(), 's1'), null)
  assert.equal(readSessionHeader(createFakeCtx({ sessions: { get: () => { throw new Error('closed') } } }), 's1'), null)
  assert.equal(readSessionHeader(createFakeCtx({ sessions: { get: () => ({ header }) } }), ''), null)

  const store = fakeStore()
  const ctx = createFakeCtx({ sessions: { get: () => ({ header }) } })
  installCollector(ctx, { config: cloneDefaultConfig(), store, assembler: createAssembleCache() })
  const entry = ctx.listeners.get('llm/stream')
  await drain(entry.listener(request(), () => upstream(streamChunks())))
  const record = store.records[0]
  assert.equal(record.parentSessionId, 'parent-1')
  assert.equal(record.delegationDepth, 1)
  assert.equal(record.preset, 'auto')
})

test('collector resolves and caches the route toolUpdate mode without blocking the stream', async () => {
  const store = fakeStore()
  const resolved = []
  const llm = {
    async resolveModelInfo(provider, model) {
      resolved.push(`${provider}/${model}`)
      return { toolUpdate: 'addition-only' }
    },
  }
  const ctx = createFakeCtx({ llm })
  installCollector(ctx, { config: cloneDefaultConfig(), store, assembler: createAssembleCache() })
  const entry = ctx.listeners.get('llm/stream')
  await drain(entry.listener(request(), () => upstream(streamChunks())))
  await Promise.resolve()
  await Promise.resolve()
  await drain(entry.listener(request(), () => upstream(streamChunks())))
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(resolved, ['deepseek-official/deepseek-flash'])
  assert.equal(store.records.length, 2)
  assert.ok(store.records.every(record => record.categories.user > 0))
})
