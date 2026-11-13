import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildRecord,
  computeCost,
  normalizePurpose,
  pricingTier,
  resolveToolDeclarations,
} from '../src/host/attribute.mjs'
import { cloneDefaultConfig } from '../src/host/config.mjs'

const config = cloneDefaultConfig()

// Explicit UTC+8 offsets keep the tier tests independent of the host timezone.
// 2026-11-02 is a Monday, 2026-11-07 a Saturday, 2026-11-08 a Sunday.
const MONDAY = '2026-11-02'
const beijing = (time, day = MONDAY) => Date.parse(`${day}T${time}:00+08:00`)

const systemMessage = text => ({
  role: 'system',
  id: `sys-${text.length}`,
  content: [{ type: 'text', text }],
  source: { kind: 'system-prompt' },
})

const userMessage = (text, source) => ({
  role: 'user',
  id: `user-${text.length}`,
  content: [{ type: 'text', text }],
  ...source === undefined ? {} : { source },
})

const textBlock = text => ({ type: 'text', text })

const sumCategories = record => Object.values(record.categories).reduce((sum, value) => sum + value, 0)

const usage = (overrides = {}) => ({
  inputTokens: 100,
  outputTokens: 10,
  ...overrides,
})

const finish = (kind = 'stop') => ({ type: 'finish', reason: { kind } })

const base = (overrides = {}) => ({
  options: {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    sessionId: 'sess-1',
    messages: [],
    ...overrides.options,
  },
  usage: overrides.usage === undefined ? usage() : overrides.usage,
  finish: overrides.finish === undefined ? finish() : overrides.finish,
  startedAt: overrides.startedAt ?? 1000,
  endedAt: overrides.endedAt ?? 1500,
  assembleSnapshot: overrides.assembleSnapshot,
  assembleKey: 'sess-1',
  sessionHeader: overrides.sessionHeader ?? null,
  config: overrides.config ?? config,
  ctx: overrides.ctx ?? {},
  counter: overrides.counter ?? 1,
  attemptIndex: overrides.attemptIndex,
  toolUpdate: overrides.toolUpdate,
})

test('buildRecord normalizes identity and prompt/output buckets', () => {
  const record = buildRecord(base({}))
  assert.equal(record.v, 1)
  assert.equal(record.sessionId, 'sess-1')
  assert.equal(record.purpose, 'chat')
  assert.equal(record.provider, 'deepseek-official')
  assert.equal(record.model, 'deepseek-flash')
  assert.equal(record.promptTokens, 100)
  assert.equal(record.outputTokens, 10)
  assert.equal(record.usageEstimated, false)
  assert.deepEqual(record.attempt, { index: 1, retryId: null, error: false })
  assert.equal(record.finish, 'stop')
  assert.equal(record.error, null)
  assert.equal(record.durationMs, 500)
  assert.equal(record.estimatorVersion, 'char-v1')
  assert.deepEqual(record.images, { count: 0, visualTokens: 0, textTokens: 0 })
  assert.equal(record.files, 0)
  assert.equal(typeof record.id, 'string')
  assert.equal(record.id.length, 40)
})

test('session headers contribute lineage fields without content', () => {
  const record = buildRecord(base({
    sessionHeader: {
      id: 'sess-1',
      parentSession: 'parent-1',
      delegationDepth: 2,
      origin: 'subagent',
      agentPreset: 'auto',
    },
  }))
  assert.equal(record.parentSessionId, 'parent-1')
  assert.equal(record.delegationDepth, 2)
  assert.equal(record.origin, 'subagent')
  assert.equal(record.preset, 'auto')
})

test('a single matched system node splits into named section categories', () => {
  const systemText = 'You are DSH. Memory: hello'
  const snapshot = {
    id: 1,
    sections: [
      { name: 'harness:identity', est: 12, text: 'You are DSH.' },
      { name: 'mnemon:memory', est: 6, text: 'Memory: hello' },
    ],
  }
  const record = buildRecord(base({
    options: {
      messages: [systemMessage(systemText)],
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      sessionId: 'sess-1',
    },
    usage: usage({ inputTokens: 100, cacheReadTokens: 20 }),
    assembleSnapshot: { matchSystemText: () => ({ snapshot, match: 'hash' }) },
  }))
  assert.equal(record.promptTokens, 120)
  assert.equal(record.systemNodes.length, 1)
  assert.equal(record.systemNodes[0].match, 'active')
  assert.deepEqual(Object.keys(record.systemNodes[0].sections).sort(), ['harness:identity', 'mnemon:memory'])
  assert.ok(Object.values(record.systemNodes[0].sections).every(value => Number.isInteger(value) && value > 0))
  assert.equal(record.categories['system:harness:identity'] + record.categories['system:mnemon:memory'], 120)
  assert.equal(sumCategories(record), 120)
})

test('in-history system nodes mark older matched nodes superseded', () => {
  const older = 'Old prompt body with text'
  const active = 'New prompt body with text'
  const snapshot = { id: 2, sections: [{ name: 'base', est: 10, text: active }] }
  const record = buildRecord(base({
    options: {
      messages: [systemMessage(older), systemMessage(active)],
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      sessionId: 'sess-1',
    },
    usage: usage({ inputTokens: 100 }),
    assembleSnapshot: {
      matchSystemText: (_key, text) => (text === active ? { snapshot, match: 'hash' } : undefined),
    },
  }))
  assert.equal(record.systemNodes.length, 2)
  assert.equal(record.systemNodes[0].match, 'superseded')
  assert.equal(record.systemNodes[1].match, 'active')
  assert.ok(record.systemNodes[1].sections.base > 0)
  assert.ok(record.categories['system:base'] >= record.systemNodes[1].sections.base)
  assert.ok(record.categories['system:superseded'] > 0)
  assert.equal(sumCategories(record), 100)
})

test('unmatched system nodes become unknown plus superseded without dropping tokens', () => {
  const record = buildRecord(base({
    options: {
      messages: [systemMessage('First unmatched prompt'), systemMessage('Second unmatched prompt')],
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      sessionId: 'sess-1',
    },
    usage: usage({ inputTokens: 50 }),
  }))
  assert.equal(record.systemNodes[0].match, 'superseded')
  assert.equal(record.systemNodes[1].match, 'unknown')
  assert.ok(record.categories['system:superseded'] > 0)
  assert.ok(record.categories['system:unknown'] > 0)
  assert.equal(sumCategories(record), 50)
})

test('assistant blocks, tool-result name mapping, and injected user sources classify', () => {
  const record = buildRecord(base({
    options: {
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      sessionId: 'sess-1',
      messages: [
        {
          role: 'assistant',
          id: 'a1',
          source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
          content: [
            { type: 'text', text: 'I will read the file' },
            { type: 'reasoning', text: 'thinking about the request' },
            { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"file_path":"a.txt"}' },
          ],
        },
        {
          role: 'tool',
          id: 't1',
          source: { kind: 'tool', callId: 'call-1' },
          toolCallId: 'call-1',
          content: [textBlock('file contents here')],
        },
        {
          role: 'tool',
          id: 't2',
          source: { kind: 'tool', callId: 'unknown-call' },
          toolCallId: 'unknown-call',
          content: [textBlock('dangling result')],
        },
        userMessage('remember this', { kind: 'dsh-mnemon', form: 'snapshot' }),
        userMessage('plain user input'),
      ],
    },
    usage: usage({ inputTokens: 1000 }),
  }))
  assert.ok(record.categories['assistant-text'] > 0)
  assert.ok(record.categories['reasoning-replay'] > 0)
  assert.ok(record.categories['tool-call-args'] > 0)
  assert.ok(record.categories['tool-result:files'] > 0)
  assert.ok(record.categories['tool-result:unknown'] > 0)
  assert.ok(record.categories['injected:memory-snapshot'] > 0)
  assert.ok(record.categories.user > 0)
  assert.equal(sumCategories(record), 1000)
})

test('developer messages split tool-history blocks from developer-message text', () => {
  const record = buildRecord(base({
    options: {
      provider: 'p',
      model: 'm',
      messages: [{
        role: 'developer',
        id: 'd1',
        source: { kind: 'model', provider: 'p', model: 'm' },
        content: [
          { type: 'tool-addition', toolName: 'mnemon_recall' },
          { type: 'tool-removal', toolName: 'read' },
          textBlock('Additional developer instruction'),
        ],
      }],
      tools: [],
      toolHistory: { tools: [], updates: [{ messageId: 'd1', additions: [] }] },
    },
    toolUpdate: 'in-history',
  }))
  assert.ok(record.categories['tools:history'] > 0)
  assert.ok(record.categories['developer-message'] > 0)
  assert.equal(sumCategories(record), 100)
})

test('developer messages are excluded when the route strips them', () => {
  const record = buildRecord(base({
    options: {
      provider: 'p',
      model: 'm',
      messages: [{
        role: 'developer',
        id: 'd1',
        source: { kind: 'model', provider: 'p', model: 'm' },
        content: [{ type: 'tool-addition', toolName: 'read' }, textBlock('stripped developer text')],
      }, userMessage('visible user text')],
      tools: [],
    },
    toolUpdate: undefined,
  }))
  assert.equal(record.categories['tools:history'], undefined)
  assert.equal(record.categories['developer-message'], undefined)
  assert.ok(record.categories.user > 0)
  assert.equal(sumCategories(record), 100)
})

test('tool declarations are projected from history according to toolUpdate mode', () => {
  const alpha = { name: 'alpha', description: 'a', parameters: {} }
  const beta = { name: 'beta', description: 'b', parameters: {} }
  const declareOptions = overrides => ({
    provider: 'p',
    model: 'm',
    messages: [{ role: 'developer', id: 'msg-1', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'tool-addition', toolName: 'beta' }] }],
    tools: [beta],
    toolHistory: { tools: [alpha], updates: [{ messageId: 'msg-1', additions: [beta] }] },
    ...overrides,
  })

  const inHistory = buildRecord(base({ options: declareOptions({}), toolUpdate: 'in-history' }))
  assert.ok(inHistory.categories['tools:other:alpha'] > 0)
  assert.ok(inHistory.categories['tools:other:beta'] > 0)

  const additionOnly = buildRecord(base({ options: declareOptions({}), toolUpdate: 'addition-only' }))
  assert.equal(additionOnly.categories['tools:other:alpha'], undefined)
  assert.ok(additionOnly.categories['tools:other:beta'] > 0)

  const fallback = buildRecord(base({ options: declareOptions({}), toolUpdate: undefined }))
  assert.equal(fallback.categories['tools:other:alpha'], undefined)
  assert.ok(fallback.categories['tools:other:beta'] > 0)
})

test('resolveToolDeclarations documents the direct fallback', () => {
  const alpha = { name: 'alpha', description: 'a', parameters: {}, deferLoading: true }
  const direct = resolveToolDeclarations({ tools: [alpha] }, undefined)
  assert.equal(direct.mode, 'direct')
  assert.equal(direct.tools[0].deferLoading, undefined)
  const noHistory = resolveToolDeclarations({ tools: [alpha], toolHistory: undefined }, 'in-history')
  assert.equal(noHistory.mode, 'direct')
  assert.deepEqual(noHistory.tools, [alpha])
  const projected = resolveToolDeclarations({
    tools: [],
    messages: [{ role: 'developer', id: 'm', content: [] }],
    toolHistory: { tools: [alpha], updates: [{ messageId: 'm', additions: [{ name: 'beta', description: 'b', parameters: {} }] }] },
  }, 'in-history')
  assert.equal(projected.mode, 'in-history')
  assert.deepEqual(projected.tools.map(tool => tool.name).sort(), ['alpha', 'beta'])
  assert.equal(projected.tools.find(tool => tool.name === 'beta').deferLoading, true)

  const missingPrefix = resolveToolDeclarations({
    tools: [],
    messages: [],
    toolHistory: { tools: [alpha], updates: [{ messageId: 'm', additions: [{ name: 'beta', description: 'b', parameters: {} }] }] },
  }, 'in-history')
  assert.equal(missingPrefix.mode, 'direct')
  assert.deepEqual(missingPrefix.tools, [])
})

test('tool group configuration drives tools: and tool-result: categories', () => {
  const custom = cloneDefaultConfig()
  custom.toolGroups.memory = ['mem_']
  const record = buildRecord(base({
    options: {
      provider: 'p',
      model: 'm',
      messages: [
        {
          role: 'assistant',
          id: 'a1',
          source: { kind: 'model', provider: 'p', model: 'm' },
          content: [{ type: 'tool-call', id: 'c1', name: 'mem_search', arguments: '{}' }],
        },
        {
          role: 'tool',
          id: 't1',
          source: { kind: 'tool', callId: 'c1' },
          toolCallId: 'c1',
          content: [textBlock('result')],
        },
      ],
      tools: [
        { name: 'mem_search', description: 'd', parameters: {} },
        { name: 'skill', description: 'd', parameters: {} },
        { name: 'spawn_teammate', description: 'd', parameters: {} },
      ],
    },
    config: custom,
  }))
  assert.ok(record.categories['tools:memory'] > 0)
  assert.ok(record.categories['tools:skill'] > 0)
  assert.ok(record.categories['tools:agent-teams'] > 0)
  assert.ok(record.categories['tool-result:memory'] > 0)
  assert.equal(sumCategories(record), 100)
})

test('image blocks count and fall back structurally without route pricing', () => {
  const image = {
    type: 'image',
    attachment: { id: 'img-1', name: 'x.png', bytes: 100, width: 10, height: 10, mimeType: 'image/png' },
  }
  const record = buildRecord(base({
    options: {
      provider: 'p',
      model: 'm',
      messages: [{ role: 'user', id: 'u1', content: [image], source: { kind: 'user' } }],
    },
  }))
  assert.equal(record.images.count, 1)
  assert.equal(record.images.visualTokens, 0)
  assert.ok(record.categories['injected:image'] > 0)
  assert.equal(sumCategories(record), 100)
})

test('image route pricing and file handle text are used when available', () => {
  const image = {
    type: 'image',
    attachment: { id: 'img-1', name: 'x.png', bytes: 100, width: 10, height: 10, mimeType: 'image/png' },
  }
  const file = { type: 'file', attachment: { id: 'file-1', name: 'a.txt', bytes: 5, mimeType: 'text/plain' } }
  const llm = {
    imageRequestPricing: () => ({ priceImages: () => [{ visualTokens: 100, text: '[image placeholder]' }] }),
    fileRequestText: () => 'path/to/a.txt',
  }
  const record = buildRecord(base({
    options: {
      provider: 'p',
      model: 'm',
      messages: [{ role: 'user', id: 'u1', content: [image, file], source: { kind: 'user' } }],
    },
    ctx: { get: name => (name === 'llm' ? llm : undefined) },
  }))
  assert.equal(record.images.count, 1)
  assert.equal(record.images.visualTokens, 100)
  assert.ok(record.images.textTokens > 0)
  assert.equal(record.files, 1)
  assert.ok(record.categories['injected:image'] > 0)
  assert.ok(record.categories['injected:file'] > 0)
  assert.ok(record.categories['injected:image'] > record.categories['injected:file'])
  assert.equal(sumCategories(record), 100)
})

test('throwing image pricing falls back without failing attribution', () => {
  const image = {
    type: 'image',
    attachment: { id: 'img-2', name: 'y.png', bytes: 10, width: 1, height: 1, mimeType: 'image/png' },
  }
  const llm = { imageRequestPricing: () => ({ priceImages: () => { throw new Error('pricing exploded') } }) }
  const record = buildRecord(base({
    options: {
      provider: 'p',
      model: 'm',
      messages: [{ role: 'user', id: 'u1', content: [image], source: { kind: 'user' } }],
    },
    ctx: { get: name => (name === 'llm' ? llm : undefined) },
  }))
  assert.equal(record.images.count, 1)
  assert.equal(record.images.visualTokens, 0)
  assert.ok(record.categories['injected:image'] > 0)
})

test('missing usage fills estimates and marks the record usageEstimated', () => {
  const record = buildRecord(base({
    options: {
      provider: 'p',
      model: 'm',
      sessionId: 'sess-1',
      messages: [systemMessage('A system prompt'), userMessage('some user text')],
    },
    usage: null,
  }))
  assert.equal(record.usage, null)
  assert.equal(record.usageEstimated, true)
  assert.equal(record.outputTokens, 0)
  assert.equal(record.promptTokens, record.estimatedPromptTokens)
  assert.ok(record.promptTokens > 0)
  assert.ok(record.estimateScale > 0.9)
  assert.equal(sumCategories(record), record.promptTokens)
})

test('usage-missing with no estimable content still satisfies the invariant', () => {
  const record = buildRecord(base({ options: { provider: 'p', model: 'm', messages: [] }, usage: null }))
  assert.equal(record.promptTokens, 0)
  assert.equal(record.estimatedPromptTokens, 0)
  assert.deepEqual(record.categories, {})
  assert.equal(sumCategories(record), 0)
})

test('an all-zero usage report is treated as missing usage', () => {
  const record = buildRecord(base({
    options: {
      provider: 'p',
      model: 'm',
      messages: [userMessage('some user text')],
    },
    usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
  }))
  assert.equal(record.usage, null)
  assert.equal(record.usageEstimated, true)
  assert.equal(record.outputTokens, 0)
  assert.ok(record.promptTokens > 0)
  assert.equal(record.promptTokens, record.estimatedPromptTokens)
  assert.equal(sumCategories(record), record.promptTokens)
  assert.equal(record.cost.priced, false)
})

test('category rounding always sums to promptTokens', () => {
  for (const input of [7, 13, 101]) {
    const record = buildRecord(base({
      options: {
        provider: 'p',
        model: 'm',
        messages: [
          userMessage('a'),
          userMessage('bb'),
          userMessage('ccc'),
          systemMessage('dddd'),
        ],
      },
      usage: usage({ inputTokens: input }),
    }))
    assert.equal(sumCategories(record), input)
  }
})

test('cost uses configured exact, prefix, and wildcard price entries', () => {
  const pricedConfig = cloneDefaultConfig()
  pricedConfig.pricing = [
    {
      provider: 'deepseek-official',
      model: 'deepseek-*',
      currency: 'CNY',
      inputPerMillion: 2,
      cacheReadPerMillion: 0.5,
      cacheWritePerMillion: 4,
      outputPerMillion: 8,
      priceVersion: 'test-2026-11',
    },
  ]
  const record = buildRecord(base({
    usage: usage({
      inputTokens: 1_000_000,
      cacheReadTokens: 2_000_000,
      cacheWriteTokens: 500_000,
      outputTokens: 3_000_000,
    }),
    config: pricedConfig,
  }))
  assert.equal(record.cost.priced, true)
  assert.equal(record.cost.currency, 'CNY')
  assert.equal(record.cost.amount, 29)
  assert.equal(record.cost.priceVersion, 'test-2026-11')

  const wildcard = cloneDefaultConfig()
  wildcard.pricing = [{
    provider: 'deepseek-official',
    model: '*',
    currency: 'USD',
    inputPerMillion: 1,
    outputPerMillion: 1,
  }]
  const wildcardRecord = buildRecord(base({ config: wildcard, usage: usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }) }))
  assert.equal(wildcardRecord.cost.priced, true)
  assert.equal(wildcardRecord.cost.amount, 2)
  assert.equal(wildcardRecord.cost.currency, 'USD')

  const unpricedConfig = cloneDefaultConfig()
  unpricedConfig.pricing = []
  const unpriced = buildRecord(base({ config: unpricedConfig, usage: usage() }))
  assert.equal(unpriced.cost.priced, false)
  assert.equal(unpriced.cost.amount, 0)
  assert.equal(unpriced.cost.priceVersion, 'none')
})

test('the default price table prices the two DeepSeek routes by peak/off-peak tier and nothing else', () => {
  const usageInput = usage({
    inputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 0,
    outputTokens: 1_000_000,
  })
  const flash = buildRecord(base({ endedAt: beijing('10:00'), usage: usageInput }))
  assert.equal(flash.cost.priced, true)
  assert.equal(flash.cost.currency, 'CNY')
  assert.equal(flash.cost.priceVersion, 'deepseek-2026-11')
  assert.equal(flash.cost.tier, 'peak')
  assert.equal(flash.cost.amount, 2 + 0.04 + 8)

  const flashNight = buildRecord(base({ endedAt: beijing('20:00'), usage: usageInput }))
  assert.equal(flashNight.cost.tier, 'off-peak')
  assert.equal(flashNight.cost.amount, (2 + 0.04 + 8) / 2)
  assert.equal(flashNight.cost.priceVersion, 'deepseek-2026-11')

  const flashWeekend = buildRecord(base({ endedAt: beijing('10:00', '2026-11-07'), usage: usageInput }))
  assert.equal(flashWeekend.cost.tier, 'off-peak')
  assert.equal(flashWeekend.cost.amount, (2 + 0.04 + 8) / 2)

  const pro = buildRecord(base({
    endedAt: beijing('10:00'),
    options: {
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      sessionId: 'sess-1',
      messages: [],
    },
    usage: usage({ inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 }),
  }))
  assert.equal(pro.cost.priced, true)
  assert.equal(pro.cost.tier, 'peak')
  assert.equal(pro.cost.amount, 9 + 0.3 + 27)

  const proOffPeak = buildRecord(base({
    endedAt: beijing('12:30'),
    options: {
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      sessionId: 'sess-1',
      messages: [],
    },
    usage: usage({ inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 }),
  }))
  assert.equal(proOffPeak.cost.tier, 'off-peak')
  assert.equal(proOffPeak.cost.amount, (9 + 0.3 + 27) / 2)

  const other = buildRecord(base({
    options: {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      sessionId: 'sess-1',
      messages: [],
    },
  }))
  assert.equal(other.cost.priced, false)
  assert.equal(other.cost.amount, 0)
})

test('pricingTier follows the Beijing peak windows, weekends, holidays, and invalid input', () => {
  const cases = [
    ['08:59', 'off-peak'],
    ['09:00', 'peak'],
    ['11:59', 'peak'],
    ['12:00', 'off-peak'],
    ['13:59', 'off-peak'],
    ['14:00', 'peak'],
    ['17:59', 'peak'],
    ['18:00', 'off-peak'],
    ['23:59', 'off-peak'],
  ]
  for (const [time, expected] of cases) {
    assert.equal(pricingTier(beijing(time), []), expected, `Monday ${time} Beijing should be ${expected}`)
  }
  // Seconds inside a window never flip the boundary.
  assert.equal(pricingTier(beijing('11:59') + 59_999, []), 'peak')
  assert.equal(pricingTier(beijing('12:00') - 1, []), 'peak')
  assert.equal(pricingTier(beijing('12:00'), []), 'off-peak')

  assert.equal(pricingTier(beijing('10:00', '2026-11-07'), []), 'off-peak', 'Saturday is off-peak')
  assert.equal(pricingTier(beijing('15:00', '2026-11-08'), []), 'off-peak', 'Sunday is off-peak')

  // A listed date is off-peak for the whole day, including peak windows.
  assert.equal(pricingTier(beijing('10:00'), ['2026-11-02']), 'off-peak')
  assert.equal(pricingTier(beijing('10:00'), ['2026-11-03']), 'peak', 'other dates keep the normal rule')
  assert.equal(pricingTier(beijing('10:00'), ['2026-11-02', '2026-12-25']), 'off-peak')

  // Non-finite or non-numeric timestamps conservatively price as peak.
  for (const bad of [undefined, null, NaN, Infinity, -Infinity, '2026-11-02T10:00:00+08:00', {}, []]) {
    assert.equal(pricingTier(bad, []), 'peak')
  }
  // An out-of-range finite timestamp produces an Invalid Date; still peak.
  assert.equal(pricingTier(8.64e15 + 1, []), 'peak')
})

test('computeCost applies the off-peak overrides, falls back per field, and reports the tier', () => {
  const pricing = [{
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    currency: 'CNY',
    priceVersion: 'tier-test',
    inputPerMillion: 2,
    cacheReadPerMillion: 0.04,
    cacheWritePerMillion: 0,
    outputPerMillion: 8,
  }]
  const usageInput = { input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, output: 1_000_000 }
  // No offPeak object: off-peak equals peak (unchanged explicit user tables).
  const peak = computeCost({ pricing, provider: 'deepseek-official', model: 'deepseek-flash', usage: usageInput, ts: beijing('10:00') })
  assert.deepEqual(peak, {
    amount: 10.04,
    priced: true,
    currency: 'CNY',
    priceVersion: 'tier-test',
    tier: 'peak',
  })
  const sameOffPeak = computeCost({ pricing, provider: 'deepseek-official', model: 'deepseek-flash', usage: usageInput, ts: beijing('20:00') })
  assert.equal(sameOffPeak.tier, 'off-peak')
  assert.equal(sameOffPeak.amount, 10.04)
  // A holiday listed in offPeakDays overrides an in-window instant.
  const holiday = computeCost({
    pricing,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    usage: usageInput,
    ts: beijing('10:00'),
    offPeakDays: ['2026-11-02'],
  })
  assert.equal(holiday.tier, 'off-peak')

  // Partial overrides only replace the named fields; the rest stay at peak.
  const partial = [{
    provider: 'p',
    model: 'm',
    currency: 'CNY',
    inputPerMillion: 10,
    cacheReadPerMillion: 2,
    cacheWritePerMillion: 4,
    outputPerMillion: 20,
    offPeak: { inputPerMillion: 5 },
  }]
  const partialUsage = { input: 2_000_000, cacheRead: 1_000_000, cacheWrite: 500_000, output: 1_000_000 }
  assert.equal(computeCost({ pricing: partial, provider: 'p', model: 'm', usage: partialUsage, ts: beijing('10:00') }).amount, 44)
  const off = computeCost({ pricing: partial, provider: 'p', model: 'm', usage: partialUsage, ts: beijing('20:00') })
  assert.equal(off.tier, 'off-peak')
  assert.equal(off.amount, 2 * 5 + 1 * 2 + 0.5 * 4 + 1 * 20)

  // Invalid off-peak fields fall back to peak instead of producing NaN/0.
  const broken = [{ ...partial[0], offPeak: { inputPerMillion: Number.NaN, outputPerMillion: -1 } }]
  assert.equal(computeCost({ pricing: broken, provider: 'p', model: 'm', usage: partialUsage, ts: beijing('20:00') }).amount, 44)

  // An unpriced usage still reports the tier used for the audit.
  const unpriced = computeCost({ pricing: [], provider: 'p', model: 'm', usage: null, ts: beijing('20:00') })
  assert.deepEqual(unpriced, { amount: 0, priced: false, currency: 'CNY', priceVersion: 'none', tier: 'off-peak' })
})

test('buildRecord prices with the record timestamp and configured off-peak days', () => {
  const priced = cloneDefaultConfig()
  priced.pricingOffPeakDays = ['2026-11-03']
  const monday = buildRecord(base({
    endedAt: beijing('10:00'),
    config: priced,
    usage: usage({ inputTokens: 1_000_000, outputTokens: 0 }),
  }))
  assert.equal(monday.ts, beijing('10:00'))
  assert.equal(monday.cost.tier, 'peak')
  assert.equal(monday.cost.amount, 2)

  const holiday = buildRecord(base({
    endedAt: beijing('10:00', '2026-11-03'),
    config: priced,
    usage: usage({ inputTokens: 1_000_000, outputTokens: 0 }),
  }))
  assert.equal(holiday.cost.tier, 'off-peak')
  assert.equal(holiday.cost.amount, 1)

  const sunday = buildRecord(base({
    endedAt: beijing('10:00', '2026-11-08'),
    config: priced,
    usage: usage({ inputTokens: 1_000_000, outputTokens: 0 }),
  }))
  assert.equal(sunday.cost.tier, 'off-peak')
  assert.equal(sunday.cost.amount, 1)
})

test('computeCost ignores unknown providers and missing usage', () => {
  const pricing = [{ provider: 'p', model: '*', currency: 'CNY', inputPerMillion: 1 }]
  assert.equal(computeCost({ pricing, provider: 'q', model: 'm', usage: { input: 100 } }).priced, false)
  assert.equal(computeCost({ pricing, provider: 'p', model: 'm', usage: null }).priced, false)
  assert.equal(computeCost({ pricing, provider: 'p', model: 'm', usage: { input: 1_000_000 } }).amount, 1)
})

test('error finishes carry a code and mark the attempt as errored', () => {
  const record = buildRecord(base({
    finish: {
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'rate limited', code: 'RATE_LIMIT', status: 429 } },
    },
    attemptIndex: 3,
  }))
  assert.equal(record.finish, 'error')
  assert.deepEqual(record.error, { code: 'RATE_LIMIT', status: 429 })
  assert.deepEqual(record.attempt, { index: 3, retryId: null, error: true })
})

test('records never contain prompt, system, or tool text', () => {
  const record = buildRecord(base({
    options: {
      provider: 'p',
      model: 'm',
      sessionId: 'sess-1',
      messages: [
        systemMessage('SECRET_SYSTEM_TEXT'),
        userMessage('SECRET_USER_TEXT'),
        {
          role: 'assistant',
          id: 'a1',
          source: { kind: 'model', provider: 'p', model: 'm' },
          content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: 'SECRET_TOOL_ARGS' }],
        },
        {
          role: 'tool',
          id: 't1',
          source: { kind: 'tool', callId: 'c1' },
          content: [textBlock('SECRET_TOOL_RESULT')],
        },
      ],
      system: 'SECRET_OPTIONS_SYSTEM',
    },
  }))
  const serialized = JSON.stringify(record)
  for (const secret of ['SECRET_SYSTEM_TEXT', 'SECRET_USER_TEXT', 'SECRET_TOOL_ARGS', 'SECRET_TOOL_RESULT', 'SECRET_OPTIONS_SYSTEM']) {
    assert.equal(serialized.includes(secret), false, `record leaked ${secret}`)
  }
})

test('normalizePurpose defaults to chat and keeps declared purposes', () => {
  assert.equal(normalizePurpose(undefined), 'chat')
  assert.equal(normalizePurpose(''), 'chat')
  assert.equal(normalizePurpose('auto-review'), 'auto-review')
  assert.equal(normalizePurpose('compaction'), 'compaction')
  const record = buildRecord(base({
    options: {
      provider: 'p',
      model: 'm',
      purpose: 'auto-review',
      system: 'REVIEW_POLICY text',
      messages: [userMessage('pending tool call')],
    },
  }))
  assert.equal(record.purpose, 'auto-review')
  assert.ok(record.categories['system:auto-review'] > 0)
  // The transcript message has no human source, so it is the auto-review
  // group, not real user input.
  assert.ok(record.categories['injected:auto-review'] > 0)
  assert.equal(record.categories.user, undefined)
  assert.equal(sumCategories(record), 100)
})

test('auto-review synthetic and explicit user messages use injected:auto-review', () => {
  const synthetic = buildRecord(base({
    options: {
      provider: 'p',
      model: 'm',
      purpose: 'auto-review',
      messages: [userMessage('whole conversation transcript')],
    },
  }))
  assert.ok(synthetic.categories['injected:auto-review'] > 0)
  assert.equal(synthetic.categories.user, undefined)
  assert.equal(sumCategories(synthetic), 100)

  // An explicit human source still resolves to `user`, so the same rule moves
  // it: the contract keys off the resolved category, not the missing source.
  const explicit = buildRecord(base({
    options: {
      provider: 'p',
      model: 'm',
      purpose: 'auto-review',
      messages: [userMessage('pending tool call', { kind: 'user' })],
    },
  }))
  assert.ok(explicit.categories['injected:auto-review'] > 0)
  assert.equal(explicit.categories.user, undefined)
  assert.equal(sumCategories(explicit), 100)
})

test('auto-review preserves non-user sources and chat user attribution', () => {
  const injected = buildRecord(base({
    options: {
      provider: 'p',
      model: 'm',
      purpose: 'auto-review',
      messages: [userMessage('memory snapshot', { kind: 'dsh-mnemon', form: 'snapshot' })],
    },
  }))
  assert.ok(injected.categories['injected:memory-snapshot'] > 0)
  assert.equal(injected.categories['injected:auto-review'], undefined)
  assert.equal(sumCategories(injected), 100)

  const chat = buildRecord(base({
    options: {
      provider: 'p',
      model: 'm',
      purpose: 'chat',
      messages: [userMessage('plain user input')],
    },
  }))
  assert.ok(chat.categories.user > 0)
  assert.equal(chat.categories['injected:auto-review'], undefined)
  assert.equal(sumCategories(chat), 100)
})

test('auto-review image and file blocks keep their injected block categories', () => {
  const image = { type: 'image', mediaType: 'image/png', data: 'aGk=' }
  const file = { type: 'file', attachment: { id: 'f1', name: 'note.txt' } }
  const record = buildRecord(base({
    options: {
      provider: 'p',
      model: 'm',
      purpose: 'auto-review',
      messages: [{
        role: 'user',
        id: 'u1',
        content: [textBlock('conversation transcript'), image, file],
      }],
    },
  }))
  assert.ok(record.categories['injected:auto-review'] > 0)
  assert.ok(record.categories['injected:image'] > 0)
  assert.ok(record.categories['injected:file'] > 0)
  assert.equal(record.categories.user, undefined)
  assert.equal(record.images.count, 1)
  assert.equal(record.files, 1)
  assert.equal(sumCategories(record), 100)
})

test('pricingTier shifts UTC instants into the Beijing wall clock', () => {
  // 2026-11-02 is a Monday. 01:00Z = 09:00 Beijing, 04:00Z = 12:00 Beijing.
  assert.equal(pricingTier(Date.UTC(2026, 10, 2, 1, 0), []), 'peak')
  assert.equal(pricingTier(Date.UTC(2026, 10, 2, 3, 59), []), 'peak')
  assert.equal(pricingTier(Date.UTC(2026, 10, 2, 4, 0), []), 'off-peak')
  assert.equal(pricingTier(Date.UTC(2026, 10, 2, 6, 0), []), 'peak')
  assert.equal(pricingTier(Date.UTC(2026, 10, 2, 10, 0), []), 'off-peak')
  assert.equal(pricingTier(Date.UTC(2026, 10, 1, 2, 0), []), 'off-peak', 'Sunday is off-peak')
  assert.equal(pricingTier(Date.UTC(2026, 10, 2, 2, 0), ['2026-11-02']), 'off-peak', 'listed holiday date')
})
