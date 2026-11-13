import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BLOCK_OVERHEAD,
  ESTIMATOR_VERSION,
  ROLE_OVERHEAD,
  distributeTotal,
  estimateBlock,
  estimateMessage,
  estimateMessages,
  estimateStructuralBlock,
  estimateSystemSections,
  estimateSystemText,
  estimateTextTokens,
  estimateToolSchemas,
  normalizeToTotal,
  systemTextOf,
} from '../src/host/estimate.mjs'
import { estimateChars, safeStringify } from '../src/host/util.mjs'

const approx = (actual, expected, tolerance = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} !~ ${expected}`)
}

test('char-v1 weights ASCII at 0.275 and non-ASCII at 0.9 tokens per character', () => {
  approx(estimateChars('a'.repeat(100)), 27.5)
  approx(estimateChars('你'.repeat(10)), 9)
  approx(estimateChars('a你'), 0.275 + 0.9)
  assert.equal(estimateTextTokens('a'.repeat(100)), 28)
  assert.equal(estimateTextTokens(''), 0)
  assert.equal(ESTIMATOR_VERSION, 'char-v1')
  assert.equal(BLOCK_OVERHEAD, 4)
  assert.equal(ROLE_OVERHEAD, 4)
})

test('text and reasoning blocks price text density plus block overhead', () => {
  const text = 'a'.repeat(100)
  assert.equal(estimateBlock({ type: 'text', text }), 28 + BLOCK_OVERHEAD)
  assert.equal(estimateBlock({ type: 'reasoning', text }), 28 + BLOCK_OVERHEAD)
  assert.equal(estimateBlock(null), 0)
})

test('tool-call blocks price name and arguments separately', () => {
  const block = { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"x":1}' }
  assert.equal(estimateBlock(block), 2 + 2 + BLOCK_OVERHEAD)
})

test('image blocks use the structural reference price when unpriced', () => {
  const block = {
    type: 'image',
    attachment: { id: 'att-1', name: 'x.png', bytes: 10, width: 1, height: 1, mimeType: 'image/png' },
    offloaded: true,
  }
  const reference = { type: 'image', attachment: block.attachment }
  assert.equal(estimateBlock(block), BLOCK_OVERHEAD + Math.ceil(estimateChars(safeStringify(reference))))
  assert.equal(estimateStructuralBlock(block), estimateBlock(block))
})

test('image blocks use route pricing plus placeholder text when available', () => {
  const block = {
    type: 'image',
    attachment: { id: 'att-1', name: 'x.png', bytes: 10, width: 1, height: 1, mimeType: 'image/png' },
  }
  const priced = estimateBlock(block, {
    imagePrice: () => ({ visualTokens: 50, text: 'abc' }),
  })
  assert.equal(priced, 50 + 1 + BLOCK_OVERHEAD)
  const fallback = estimateBlock(block, {
    imagePrice: () => ({ visualTokens: Number.NaN, text: 'abc' }),
  })
  assert.equal(fallback, estimateStructuralBlock(block))
})

test('file blocks use the model-visible handle text when available', () => {
  const block = { type: 'file', attachment: { id: 'f1', name: 'a.txt', bytes: 2, mimeType: 'text/plain' } }
  const text = 'X'.repeat(20)
  assert.equal(estimateBlock(block, { fileText: () => text }), 6 + BLOCK_OVERHEAD)
  assert.equal(estimateBlock(block), estimateStructuralBlock(block))
})

test('messages add role overhead; system messages do not add block overhead', () => {
  assert.equal(estimateMessage({ role: 'system', content: [{ type: 'text', text: 'abc' }] }), 5)
  assert.equal(estimateMessage({ role: 'user', content: [{ type: 'text', text: 'abc' }] }), 5 + ROLE_OVERHEAD)
  assert.equal(estimateMessages([
    { role: 'system', content: [{ type: 'text', text: 'abc' }] },
    { role: 'user', content: [{ type: 'text', text: 'abc' }] },
  ]), 10 + ROLE_OVERHEAD)
  assert.equal(estimateMessages(undefined), 0)
  assert.equal(systemTextOf({ content: [{ type: 'image', attachment: {} }, { type: 'text', text: 'x' }] }).length > 0, true)
})

test('tool schemas price the serialized declaration array with one block overhead', () => {
  const tools = [
    { name: 'alpha', description: 'a', parameters: {} },
    { name: 'beta', description: 'b', parameters: { type: 'object' } },
  ]
  const expected = Math.ceil(estimateChars(JSON.stringify(tools))) + BLOCK_OVERHEAD
  assert.equal(estimateToolSchemas(tools), expected)
  assert.equal(estimateToolSchemas([]), 0)
  assert.equal(estimateToolSchemas(undefined), 0)
})

test('system sections return per-section char counts and a weighted total', () => {
  const { sections, total } = estimateSystemSections([
    { name: 'harness:identity', text: 'A'.repeat(10) },
    { name: 'mnemon:memory', text: '你好' },
    { name: 'empty', text: '' },
  ])
  assert.equal(sections.length, 2)
  assert.deepEqual(sections[0], { name: 'harness:identity', ascii: 10, nonAscii: 0, est: 3 })
  assert.deepEqual(sections[1], { name: 'mnemon:memory', ascii: 0, nonAscii: 2, est: 2 })
  assert.equal(total, 5)
  assert.equal(estimateSystemText('A'.repeat(10)), 3 + ROLE_OVERHEAD)
  assert.equal(estimateSystemText(''), 0)
})

test('normalizeToTotal keeps the invariant and fixes rounding residual', () => {
  const exact = normalizeToTotal({ a: 3, b: 1 }, 100)
  assert.deepEqual(exact.categories, { a: 75, b: 25 })
  assert.equal(exact.scale, 25)
  assert.equal(Object.values(exact.categories).reduce((sum, value) => sum + value, 0), 100)

  const rounding = normalizeToTotal({ a: 1, b: 1, c: 1 }, 2)
  assert.equal(Object.values(rounding.categories).reduce((sum, value) => sum + value, 0), 2)
  assert.ok(Object.values(rounding.categories).every(value => Number.isInteger(value) && value > 0))

  const tiny = normalizeToTotal({ a: 0.4, b: 0.4 }, 1)
  assert.equal(Object.values(tiny.categories).reduce((sum, value) => sum + value, 0), 1)

  const empty = normalizeToTotal({}, 10)
  assert.deepEqual(empty.categories, {})
  assert.equal(empty.scale, 0)
  assert.equal(empty.rawSum, 0)

  const zero = normalizeToTotal({ a: 5 }, 0)
  assert.deepEqual(zero.categories, {})
  assert.equal(zero.scale, 0)
})

test('distributeTotal splits whole tokens and keeps the total', () => {
  const split = distributeTotal([{ name: 'a', weight: 3 }, { name: 'b', weight: 1 }], 100)
  assert.deepEqual(split, { a: 75, b: 25 })
  const tiny = distributeTotal([{ name: 'a', weight: 0.01 }, { name: 'b', weight: 0.01 }], 1)
  assert.equal(Object.values(tiny).reduce((sum, value) => sum + value, 0), 1)
  const half = distributeTotal([{ name: 'a', weight: 1 }, { name: 'b', weight: 1 }], 1)
  assert.equal(Object.values(half).reduce((sum, value) => sum + value, 0), 1)
  assert.deepEqual(distributeTotal([], 5), {})
  assert.deepEqual(distributeTotal([{ name: 'a', weight: 0 }], 5), {})
})
