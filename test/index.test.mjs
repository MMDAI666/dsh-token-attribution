import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'
import { dayKey } from '../src/host/util.mjs'

async function* upstream(chunks) {
  for (const chunk of chunks) yield chunk
}

test('apply resolves profile name and DSH home from the live profileContext', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dta-apply-profile-'))
  try {
    const effects = []
    const ctx = {
      fiber: { entry: { id: 'token-attribution' } },
      logger: { warn: () => {} },
      on: () => () => {},
      effect(factory) {
        const disposer = factory()
        effects.push(disposer)
        return () => {
          if (typeof disposer === 'function') disposer()
        }
      },
      get(name) {
        if (name === 'profileContext') return { name: 'desktop', home }
        if (name === 'sessions') return { get: () => undefined }
        return undefined
      },
      inject() {},
    }
    apply(ctx, {})
    const stateDir = path.join(home, 'token-attribution', 'state', 'desktop')
    const dataDir = path.join(home, 'token-attribution', 'data', 'desktop')
    assert.equal(fs.existsSync(path.join(stateDir, 'pointer.json')), true)
    const meta = JSON.parse(fs.readFileSync(path.join(dataDir, 'meta.json'), 'utf8'))
    assert.equal(meta.profile, 'desktop')
    assert.equal(meta.profileSource, 'profileContext')
    for (const disposer of effects.slice().reverse()) {
      if (typeof disposer === 'function') disposer()
    }
    assert.equal(fs.existsSync(path.join(stateDir, 'lock')), false)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('apply wires assemble, collector, RPC, and final flush without throwing on invalid config', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dta-apply-'))
  const previousHome = process.env.DSH_HOME
  const previousProfile = process.env.DSH_PROFILE
  process.env.DSH_HOME = home
  process.env.DSH_PROFILE = 'plugin-test'
  try {
    const effects = []
    const listeners = new Map()
    const warnings = []
    let injected
    const ctx = {
      fiber: { entry: { id: 'token-attribution' } },
      logger: { warn: message => warnings.push(message) },
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
        if (name === 'sessions') return { get: () => ({ header: { id: 'ix-session', agentPreset: 'auto' } }) }
        return undefined
      },
      inject(deps, callback) {
        injected = { deps, callback }
      },
    }

    // Invalid values must fall back with diagnostics, never throw out of apply.
    apply(ctx, { retainRequestDays: 0, rpcChannel: 'api' })
    assert.ok(warnings.some(message => message.includes('retainRequestDays')))
    assert.ok(warnings.some(message => message.includes('rpcChannel')))
    assert.ok(listeners.has('llm/stream'))
    assert.ok(listeners.has('system-prompt/assemble'))
    assert.ok(listeners.has('tools/result'))
    assert.deepEqual(listeners.get('tools/result').options, { global: true })
    const webApiListener = listeners.get('tools/result').listener
    webApiListener({ name: 'web_search', callId: 'web-ok', agent: { session: { id: 'ix-web-a' } } }, { isError: false })
    // A result without a calling agent is still counted, under `unknown`.
    webApiListener({ name: 'web_search', callId: 'web-fail' }, { isError: true })
    webApiListener({ name: 'web_fetch', callId: 'fetch-ok', agent: { session: { id: 'ix-web-b' } } }, { isError: false })
    webApiListener({ name: 'read', callId: 'ignored', agent: { session: { id: 'ix-web-a' } } }, { isError: false })
    const webApiFile = path.join(home, 'token-attribution', 'data', 'plugin-test', 'webapi', `${dayKey(Date.now())}.json`)
    const webApiDay = JSON.parse(fs.readFileSync(webApiFile, 'utf8'))
    assert.deepEqual(webApiDay.search, { ok: 1, failed: 1 })
    assert.deepEqual(webApiDay.fetch, { ok: 1, failed: 0 })
    // Both observed sessions are attributed, and the agent-less call lands in
    // the `unknown` bucket; the ignored non-web tool adds nothing.
    assert.deepEqual(Object.keys(webApiDay.sessions).sort(), ['ix-web-a', 'ix-web-b', 'unknown'])
    assert.deepEqual(webApiDay.sessions['ix-web-a'], { search: { ok: 1, failed: 0 }, fetch: { ok: 0, failed: 0 } })
    assert.deepEqual(webApiDay.sessions['ix-web-b'], { search: { ok: 0, failed: 0 }, fetch: { ok: 1, failed: 0 } })
    assert.deepEqual(webApiDay.sessions.unknown, { search: { ok: 0, failed: 1 }, fetch: { ok: 0, failed: 0 } })
    assert.deepEqual(injected.deps, ['connection', 'webServer'])

    const assembleEntry = listeners.get('system-prompt/assemble')
    const final = {
      sections: [{ name: 'harness:identity', text: 'Integration system prompt' }],
      contexts: [],
      variables: {},
    }
    const returned = await assembleEntry.listener(
      { sections: [] },
      { agent: { session: { id: 'ix-session' } } },
      async () => final,
    )
    assert.equal(returned, final)

    const handled = []
    const scope = {
      effect(factory) {
        const disposer = factory()
        return () => {
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

    const streamEntry = listeners.get('llm/stream')
    const chunks = [
      { type: 'text-delta', index: 0, text: 'hello' },
      { type: 'usage', usage: { inputTokens: 100, cacheReadTokens: 10, cacheWriteTokens: 0, outputTokens: 5 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const request = {
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      sessionId: 'ix-session',
      messages: [
        { role: 'system', id: 's', content: [{ type: 'text', text: 'Integration system prompt' }], source: { kind: 'system-prompt' } },
        { role: 'user', id: 'u', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } },
      ],
    }
    const seen = []
    for await (const chunk of streamEntry.listener(request, () => upstream(chunks))) seen.push(chunk)
    assert.deepEqual(seen, chunks)

    // Unload in reverse registration order, as a Cordis fiber would; the final
    // flush effect persists the queued record and releases the lock.
    for (const effect of effects.slice().reverse()) {
      if (typeof effect.disposer === 'function') effect.disposer()
    }
    const stateLock = path.join(home, 'token-attribution', 'state', 'plugin-test', 'lock')
    assert.equal(fs.existsSync(stateLock), false)

    const summary = await handled[0].handler('summary', { range: 'today' })
    assert.equal(summary.ok, true)
    assert.equal(summary.value.totals.requests, 1)
    assert.equal(summary.value.totals.promptTokens, 110)
    assert.equal(summary.value.totals.outputTokens, 5)

    // The summary exposes the per-session web API rows consumed by the panel.
    const webApiBySession = summary.value.webApi.bySession
    assert.deepEqual(summary.value.webApi.calls, { ok: 2, failed: 1, total: 3 })
    assert.deepEqual(webApiBySession.map(row => row.sessionId), ['ix-web-a', 'unknown', 'ix-web-b'])
    assert.deepEqual(webApiBySession[0], {
      sessionId: 'ix-web-a',
      search: { ok: 1, failed: 0, total: 1 },
      fetch: { ok: 0, failed: 0, total: 0 },
      calls: { ok: 1, failed: 0, total: 1 },
      cost: { amount: 0.005, currency: 'CNY', priced: true },
    })
    assert.deepEqual(webApiBySession[1], {
      sessionId: 'unknown',
      search: { ok: 0, failed: 1, total: 1 },
      fetch: { ok: 0, failed: 0, total: 0 },
      calls: { ok: 0, failed: 1, total: 1 },
      cost: { amount: 0, currency: 'CNY', priced: false },
    })
    assert.equal(webApiBySession[2].sessionId, 'ix-web-b')

    const dataRoot = path.join(home, 'token-attribution', 'data', 'plugin-test')
    const day = dayKey(Date.now())
    const lines = fs.readFileSync(path.join(dataRoot, 'requests', `${day}.jsonl`), 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    const record = JSON.parse(lines[0])
    assert.equal(record.promptTokens, 110)
    assert.equal(record.systemNodes[0].match, 'active')
    assert.equal(record.preset, 'auto')
    assert.equal(JSON.stringify(record).includes('Integration system prompt'), false)
    assert.ok(fs.existsSync(path.join(dataRoot, 'daily', `${day}.json`)))

    const meta = JSON.parse(fs.readFileSync(path.join(dataRoot, 'meta.json'), 'utf8'))
    assert.equal(meta.estimatorVersion, 'char-v1')
    assert.equal(meta.installedVersion, '0.1.0')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousProfile === undefined) delete process.env.DSH_PROFILE
    else process.env.DSH_PROFILE = previousProfile
    fs.rmSync(home, { recursive: true, force: true })
  }
})
