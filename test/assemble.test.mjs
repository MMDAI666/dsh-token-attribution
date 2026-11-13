import assert from 'node:assert/strict'
import test from 'node:test'

import {
  commonPrefixLength,
  createAssembleCache,
  installAssembleObserver,
  interpolateText,
} from '../src/host/assemble.mjs'

const section = (name, text) => ({ name, text })

test('interpolateText resolves known {{variables}} and keeps unknown references', () => {
  assert.equal(interpolateText('Hi {{name}}', { name: 'World' }), 'Hi World')
  assert.equal(interpolateText('Hi {{ name }}', { name: 'World' }), 'Hi World')
  assert.equal(interpolateText('Hi {{missing}}', {}), 'Hi {{missing}}')
  assert.equal(interpolateText('no refs', undefined), 'no refs')
  assert.equal(interpolateText('literal {{', {}), 'literal {{')
})

test('commonPrefixLength counts matching leading code units', () => {
  assert.equal(commonPrefixLength('abcXYZ', 'abc123'), 3)
  assert.equal(commonPrefixLength('abc', 'abcdef'), 3)
  assert.equal(commonPrefixLength('', 'abc'), 0)
})

test('assemble cache records sections and matches the exact rendered hash', () => {
  const cache = createAssembleCache()
  const snapshot = cache.record({
    key: 's1',
    sections: [
      section('harness:identity', 'You are a harness.'),
      section('mnemon:memory', 'Memory {{count}}'),
      section('empty', ''),
    ],
    contexts: [section('time', 'Today is {{now}}')],
    variables: { count: '10', now: '2026-11-11' },
  })
  assert.ok(snapshot)
  assert.deepEqual(snapshot.hashes.length, 2)
  assert.equal(snapshot.renderedInterpolatedPrefix, 'You are a harness.\n\nMemory 10')
  assert.equal(snapshot.renderedRawPrefix, 'You are a harness.\n\nMemory {{count}}')
  assert.deepEqual(snapshot.renderedLengths, {
    raw: 'You are a harness.\n\nMemory {{count}}'.length,
    interpolated: 'You are a harness.\n\nMemory 10'.length,
  })
  assert.deepEqual(snapshot.sections.map(s => s.name), ['harness:identity', 'mnemon:memory'])
  assert.equal(snapshot.contexts.length, 1)
  assert.equal(cache.snapshotFor('s1').id, snapshot.id)
  assert.equal(cache.snapshotFor('missing'), undefined)

  const exact = cache.matchSystemText('s1', 'You are a harness.\n\nMemory 10')
  assert.equal(exact.match, 'hash')
  const raw = cache.matchSystemText('s1', 'You are a harness.\n\nMemory {{count}}')
  assert.equal(raw.match, 'hash')
})

test('assemble cache falls back to length plus prefix and rejects a different prompt', () => {
  const cache = createAssembleCache()
  cache.record({
    key: 's2',
    sections: [section('a', 'A'.repeat(200)), section('b', 'B'.repeat(200))],
    contexts: [],
    variables: {},
  })
  const rendered = `${'A'.repeat(200)}\n\n${'B'.repeat(200)}`
  const heuristic = cache.matchSystemText('s2', `${rendered.slice(0, -6)}CHANGED`)
  assert.equal(heuristic.match, 'prefix')
  assert.equal(cache.matchSystemText('s2', 'C'.repeat(rendered.length)), undefined)
  assert.equal(cache.matchSystemText('s2', ''), undefined)
  assert.equal(cache.matchSystemText('unknown-key', rendered), undefined)
})

test('assemble cache keeps a bounded ring buffer per key', () => {
  const cache = createAssembleCache({ maxPerKey: 20, maxKeys: 2 })
  for (let index = 0; index < 25; index += 1) {
    cache.record({
      key: 'ring',
      sections: [section('s', `prompt-${index}-${'X'.repeat(100 + index)}`)],
      contexts: [],
      variables: {},
    })
  }
  assert.equal(cache.stats().snapshots, 20)
  const latest = cache.matchSystemText('ring', `prompt-24-${'X'.repeat(124)}`)
  assert.equal(latest.match, 'hash')
  assert.equal(cache.matchSystemText('ring', `prompt-0-${'X'.repeat(100)}`), undefined)

  cache.record({ key: 'other1', sections: [section('s', 'one')], contexts: [], variables: {} })
  cache.record({ key: 'other2', sections: [section('s', 'two')], contexts: [], variables: {} })
  assert.ok(cache.stats().keys <= 2)
  cache.clear()
  assert.equal(cache.stats().snapshots, 0)
})

test('assemble cache derives keys from agent sessions, scopes, and global', () => {
  const cache = createAssembleCache()
  assert.equal(cache.keyFor({ agent: { session: { id: 'agent-session' } } }), 'agent-session')
  const scope = { session: { id: 'scoped-session' } }
  assert.equal(cache.keyFor({ scope }), 'scoped-session')
  const anonymous = {}
  const first = cache.keyFor({ scope: anonymous })
  const second = cache.keyFor({ scope: anonymous })
  assert.match(first, /^scope:\d+$/)
  assert.equal(first, second)
  assert.notEqual(cache.keyFor({ scope: {} }), first)
  assert.equal(cache.keyFor({}), 'global')
})

test('installAssembleObserver registers the waterfall and returns next() unchanged', async () => {
  const listeners = new Map()
  const ctx = {
    on(name, listener, options) {
      listeners.set(name, { listener, options })
      return () => listeners.delete(name)
    },
  }
  const cache = createAssembleCache()
  const diagnostics = []
  const dispose = installAssembleObserver(ctx, { cache, diag: message => diagnostics.push(message) })
  const entry = listeners.get('system-prompt/assemble')
  assert.deepEqual(entry.options, { global: true, prepend: true })

  const final = { sections: [section('harness:identity', 'hello')], contexts: [], variables: {} }
  const returned = await entry.listener({ sections: [] }, { agent: { session: { id: 's9' } } }, async () => final)
  assert.equal(returned, final)
  assert.equal(cache.matchSystemText('s9', 'hello').match, 'hash')

  // A broken final presentation is contained: the listener still returns it.
  const broken = {
    get sections() {
      throw new Error('boom')
    },
    contexts: [],
    variables: {},
  }
  const second = await entry.listener({}, { agent: { session: { id: 's10' } } }, async () => broken)
  assert.equal(second, broken)
  assert.ok(diagnostics.some(message => message.includes('boom')))
  dispose()
  assert.equal(listeners.has('system-prompt/assemble'), false)
})
