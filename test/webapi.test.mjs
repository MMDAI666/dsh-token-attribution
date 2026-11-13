import assert from 'node:assert/strict'
import test from 'node:test'

import { installWebApiObserver } from '../src/host/webapi.mjs'

/**
 * Build a minimal fake Cordis context that records `ctx.on` registrations.
 * @returns {{ctx: object, registrations: Array<{name: string, listener: Function, options: object, disposed: number}>}} fake context.
 */
const createFakeContext = () => {
  const registrations = []
  return {
    registrations,
    ctx: {
      on(name, listener, options) {
        const registration = { name, listener, options, disposed: 0 }
        registrations.push(registration)
        return () => {
          registration.disposed += 1
        }
      },
    },
  }
}

test('installWebApiObserver registers tools/result globally and returns its disposer', () => {
  const { ctx, registrations } = createFakeContext()
  const calls = []
  const dispose = installWebApiObserver(ctx, { store: { recordWebApiCall: call => calls.push(call) } })

  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].name, 'tools/result')
  // The emit event is scope-filtered by `exec.agent`; the global option must be
  // forwarded so every execution is observed.
  assert.deepEqual(registrations[0].options, { global: true })
  assert.equal(typeof registrations[0].listener, 'function')
  assert.equal(typeof dispose, 'function')
  assert.deepEqual(calls, [])

  registrations[0].listener({ name: 'web_search' }, { isError: false })
  assert.equal(calls.length, 1)
  dispose()
  assert.equal(registrations[0].disposed, 1)
})

test('the observer maps only web_search/web_fetch outcomes and defaults to success', () => {
  const { ctx, registrations } = createFakeContext()
  const calls = []
  installWebApiObserver(ctx, { store: { recordWebApiCall: call => calls.push(call) } })
  const listener = registrations[0].listener
  const before = Date.now()

  listener({ name: 'web_search' }, { isError: false })
  listener({ name: 'web_fetch' }, { isError: true })
  // A missing result is not an error, exactly like `isError !== true` on the host.
  listener({ name: 'web_search' })
  listener({ name: 'web_search' }, { isError: 'yes' })
  // Every other tool is ignored, including malformed executions.
  listener({ name: 'read' }, { isError: true })
  listener({ name: 'web_search_extra' }, { isError: true })
  listener({ name: 'constructor' }, { isError: true })
  listener({ name: '__proto__' }, { isError: true })
  listener({ name: 'toString' }, { isError: true })
  listener(undefined, undefined)
  listener(null, null)
  listener({}, {})
  listener({ name: 42 }, { isError: true })
  listener({ name: '' }, { isError: true })

  assert.equal(calls.length, 4)
  assert.deepEqual(calls.map(call => [call.tool, call.ok]), [
    ['search', true],
    ['fetch', false],
    ['search', true],
    ['search', true],
  ])
  for (const call of calls) {
    assert.equal(typeof call.ts, 'number')
    assert.ok(call.ts >= before && call.ts <= Date.now(), 'timestamp is recorded at observation time')
  }
})

test('the observer forwards the calling agent session id and degrades missing ids to undefined', () => {
  const { ctx, registrations } = createFakeContext()
  const calls = []
  installWebApiObserver(ctx, { store: { recordWebApiCall: call => calls.push(call) } })
  const listener = registrations[0].listener

  listener({ name: 'web_search', agent: { session: { id: 'sess-1' } } }, {})
  listener({ name: 'web_fetch', agent: { session: { id: '' } } }, {})
  listener({ name: 'web_search', agent: {} }, {})
  listener({ name: 'web_search', agent: { session: {} } }, {})
  listener({ name: 'web_search', agent: { session: { id: 42 } } }, {})
  listener({ name: 'web_search', agent: { session: null } }, {})
  listener({ name: 'web_search', agent: null }, {})
  listener({ name: 'web_search' }, {})

  assert.deepEqual(calls.map(call => call.sessionId), [
    'sess-1',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ])
  for (const call of calls) {
    assert.equal(Object.hasOwn(call, 'sessionId'), true, 'the observer always passes the field')
  }

  // A throwing getter on the execution (or on agent/session) must never escape.
  const explodingAgent = { name: 'web_search' }
  Object.defineProperty(explodingAgent, 'agent', {
    get() {
      throw new Error('agent exploded')
    },
  })
  assert.doesNotThrow(() => listener(explodingAgent, {}))
  assert.equal(calls.length, 9)
  assert.equal(calls[8].sessionId, undefined)

  const explodingSession = { name: 'web_search' }
  Object.defineProperty(explodingSession, 'agent', {
    get() {
      return {
        get session() {
          throw new Error('session exploded')
        },
      }
    },
  })
  assert.doesNotThrow(() => listener(explodingSession, {}))
  assert.equal(calls.length, 10)
  assert.equal(calls[9].sessionId, undefined)
})

test('a store failure is contained and reported through diag', () => {
  const { ctx, registrations } = createFakeContext()
  const diagnostics = []
  let failing = true
  const recorded = []
  const store = {
    recordWebApiCall(call) {
      if (failing) throw new Error('disk full')
      recorded.push(call)
    },
  }
  installWebApiObserver(ctx, { store, diag: message => diagnostics.push(message) })
  const listener = registrations[0].listener

  assert.doesNotThrow(() => listener({ name: 'web_search' }, { isError: false }))
  assert.equal(recorded.length, 0)
  assert.equal(diagnostics.length, 1)
  assert.match(diagnostics[0], /webapi: failed to count a tool result/)
  assert.match(diagnostics[0], /disk full/)

  // A failure never disables later observations.
  failing = false
  listener({ name: 'web_fetch' }, { isError: false })
  assert.deepEqual(recorded.map(call => [call.tool, call.ok]), [['fetch', true]])
  // A throwing diagnostics sink is also contained.
  const throwingDiag = () => {
    throw new Error('logger exploded')
  }
  const second = createFakeContext()
  installWebApiObserver(second.ctx, {
    store: { recordWebApiCall: () => { throw new Error('store exploded') } },
    diag: throwingDiag,
  })
  assert.doesNotThrow(() => second.registrations[0].listener({ name: 'web_search' }, {}))
})

test('the disposer is idempotent and contains underlying disposal failures', () => {
  let disposed = 0
  const ctx = {
    on() {
      return () => {
        disposed += 1
      }
    },
  }
  const dispose = installWebApiObserver(ctx, { store: { recordWebApiCall: () => {} } })
  dispose()
  assert.equal(disposed, 1)
  dispose()
  assert.equal(disposed, 1, 'second disposal is a no-op')

  const diagnostics = []
  const failing = installWebApiObserver({
    on() {
      return () => {
        throw new Error('dispose exploded')
      }
    },
  }, { diag: message => diagnostics.push(message) })
  assert.doesNotThrow(() => failing())
  assert.equal(diagnostics.length, 1)
  assert.match(diagnostics[0], /listener disposal failed/)
  assert.match(diagnostics[0], /dispose exploded/)
})

test('a listener that is somehow still invoked after disposal records nothing', () => {
  const { ctx, registrations } = createFakeContext()
  const calls = []
  const dispose = installWebApiObserver(ctx, { store: { recordWebApiCall: call => calls.push(call) } })
  const listener = registrations[0].listener
  listener({ name: 'web_search' }, {})
  assert.equal(calls.length, 1)
  dispose()
  listener({ name: 'web_search' }, {})
  assert.equal(calls.length, 1, 'no record after disposal')
})

test('missing or throwing ctx.on yields a no-op disposer and never throws', () => {
  for (const ctx of [undefined, null, {}, { on: 42 }, { on: null }]) {
    const disposer = installWebApiObserver(ctx, {})
    assert.equal(typeof disposer, 'function')
    assert.doesNotThrow(() => disposer())
  }

  const diagnostics = []
  const disposer = installWebApiObserver(undefined, { diag: message => diagnostics.push(message) })
  assert.equal(typeof disposer, 'function')
  assert.equal(diagnostics.length, 1)
  assert.match(diagnostics[0], /does not support ctx\.on/)

  const failedDiagnostics = []
  const failedDisposer = installWebApiObserver({
    on() {
      throw new Error('registration exploded')
    },
  }, { diag: message => failedDiagnostics.push(message) })
  assert.equal(typeof failedDisposer, 'function')
  assert.match(failedDiagnostics[0], /listener registration failed/)
  assert.match(failedDiagnostics[0], /registration exploded/)
  assert.doesNotThrow(() => failedDisposer())
})

test('a missing store method is tolerated', () => {
  const { ctx, registrations } = createFakeContext()
  installWebApiObserver(ctx, {})
  assert.doesNotThrow(() => registrations[0].listener({ name: 'web_search' }, {}))
  assert.doesNotThrow(() => registrations[0].listener({ name: 'web_fetch' }, { isError: true }))

  const second = createFakeContext()
  installWebApiObserver(second.ctx, { store: {} })
  assert.doesNotThrow(() => second.registrations[0].listener({ name: 'web_search' }, {}))
})
