/**
 * Unit tests for the M1b Web client (`client.js`).
 *
 * The Client module is a plain dynamic module, not an importable library: the
 * test stubs `window.__ModuleLoader__`, imports the file for its side effect,
 * then drives the captured factory with a minimal fake React and fake context.
 * No DOM, profile, network, or external dependency is involved.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

let captured = null

globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      captured = spec
    },
  },
}

const fakeReact = {
  createElement(type, props, ...children) {
    const merged = { ...(props ?? {}) }
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    return { type, props: merged, children }
  },
  useState(value) {
    return [typeof value === 'function' ? value() : value, () => {}]
  },
  useEffect() {},
  useMemo(factory) {
    return factory()
  },
  useCallback(factory) {
    return factory
  },
  useRef(value) {
    return { current: value }
  },
}

const requestedModules = []
function fakeRequire(name) {
  requestedModules.push(name)
  if (name === 'react') return fakeReact
  throw new Error(`unexpected require: ${name}`)
}

await import(new URL('../client.js', import.meta.url).href)

test('module loader id and plugin shape', () => {
  assert.ok(captured, 'window.__ModuleLoader__.load was called')
  assert.equal(captured.id, 'dsh-token-attribution')
  assert.equal(typeof captured.factory, 'function')

  const plugin = captured.factory(fakeRequire)
  assert.deepEqual(plugin.inject, ['slots', 'connection', 'locale'])
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(typeof plugin.__test, 'object')
  for (const helper of [
    'formatTokens',
    'formatCompactTokens',
    'formatPercent',
    'formatCurrency',
    'formatCurrencyBreakdown',
    'buildStackedSegments',
    'groupTop',
    'categoryTableRows',
    'buildSessionTree',
    'subtreeStats',
    'sessionCacheRate',
    'categoryGroup',
    'categoryGroupEntries',
    'validateAdvancedJson',
    'configPatchFromForm',
    'sessionDisplayName',
    'normalizeOffPeakDays',
    'normalizeWebApi',
    'unwrapRpc',
    'detailsRequestPayload',
    'detailsReducer',
    'sessionFilterOptions',
    'toolGroupRows',
    'toolGroupLabel',
    'resolveInitialTab',
    'isValidTab',
    'normalizeToolGroupMap',
    'nextTabId',
    'detailsRangeKeyFromRange',
    'detailsRangeChanged',
    'configFieldSupported',
  ]) {
    assert.equal(typeof plugin.__test[helper], 'function', `${helper} is exported for tests`)
  }
  assert.equal(plugin.__test.configFieldOrder.length, 13, 'the M2.6 Config has 13 fields')
})

test('client source requires only react', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const requires = [...source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1])
  assert.deepEqual([...new Set(requires)], ['react'])
  assert.deepEqual([...new Set(requestedModules)], ['react'])
})

test('locale dictionaries have identical keys and placeholders', () => {
  const plugin = captured.factory(fakeRequire)
  const { locales } = plugin.__test
  const en = Object.keys(locales.en).sort()
  const zh = Object.keys(locales.zh).sort()
  assert.ok(en.length > 100, 'English dictionary is populated')
  assert.deepEqual(zh, en, 'zh and en expose the same keys')

  const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()
  for (const key of en) {
    assert.equal(typeof locales.en[key], 'string', `en.${key} is text`)
    assert.equal(typeof locales.zh[key], 'string', `zh.${key} is text`)
    assert.ok(locales.en[key].length > 0, `en.${key} is not empty`)
    assert.ok(locales.zh[key].length > 0, `zh.${key} is not empty`)
    assert.deepEqual(placeholders(locales.zh[key]), placeholders(locales.en[key]), `placeholders of ${key}`)
  }
  for (const key of ['panel.title', 'range.today', 'range.7d', 'range.30d', 'card.total', 'chart.purpose.title', 'table.sessions.title', 'config.title', 'config.field.dataDir', 'button.save', 'state.loading', 'footnote.usage']) {
    assert.ok(Object.hasOwn(locales.en, key), `en.${key} exists`)
    assert.ok(Object.hasOwn(locales.zh, key), `zh.${key} exists`)
  }
})

test('formatTokens groups digits and handles boundaries', () => {
  const { formatTokens } = captured.factory(fakeRequire).__test
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(1000), '1,000')
  assert.equal(formatTokens(1234567), '1,234,567')
  assert.equal(formatTokens(-1000), '-1,000')
  assert.equal(formatTokens(1000.4), '1,000')
  assert.equal(formatTokens(Number.NaN), '—')
  assert.equal(formatTokens(undefined), '—')
})

test('formatPercent and formatCurrency follow fixed conventions', () => {
  const { formatPercent, formatCurrency } = captured.factory(fakeRequire).__test
  assert.equal(formatPercent(0), '0.0%')
  assert.equal(formatPercent(0.1234), '12.3%')
  assert.equal(formatPercent(1), '100.0%')
  assert.equal(formatPercent(1 / 3, 2), '33.33%')
  assert.equal(formatPercent(Number.NaN), '—')

  assert.equal(formatCurrency(0, 'CNY'), 'CNY 0.00')
  assert.equal(formatCurrency(1.5, 'CNY'), 'CNY 1.50')
  assert.equal(formatCurrency(0.5, 'USD'), 'USD 0.50')
  assert.equal(formatCurrency(0.000123, 'CNY'), 'CNY 0.000123')
  assert.equal(formatCurrency(Number.NaN, 'CNY'), '—')
})

test('buildStackedSegments widths sum to one hundred and drop non-positive values', () => {
  const { buildStackedSegments } = captured.factory(fakeRequire).__test
  const segments = buildStackedSegments([
    { key: 'a', value: 1 },
    { key: 'b', value: 0 },
    { key: 'c', value: 1 },
    { key: 'd', value: -3 },
    { key: 'e', value: 2 },
  ])
  assert.deepEqual(segments.map(segment => segment.key), ['a', 'c', 'e'])
  const sum = segments.reduce((total, segment) => total + segment.widthPercent, 0)
  assert.ok(Math.abs(sum - 100) < 1e-9, `widths sum to 100 (got ${sum})`)
  assert.equal(segments[0].startPercent, 0)
  assert.equal(segments[segments.length - 1].widthPercent, 50)
  assert.deepEqual(buildStackedSegments([]), [])
  assert.deepEqual(buildStackedSegments([{ key: 'zero', value: 0 }]), [])
  assert.deepEqual(buildStackedSegments(null), [])
})

test('groupTop keeps the largest rows and folds the rest into other', () => {
  const { groupTop } = captured.factory(fakeRequire).__test
  const grouped = groupTop({ a: 10, b: 20, c: 30, d: 40 }, 2)
  assert.deepEqual(grouped.items, [{ key: 'd', value: 40 }, { key: 'c', value: 30 }])
  assert.equal(grouped.other, 30)
  assert.equal(grouped.total, 100)
  const noOther = groupTop({ a: 1 }, 6)
  assert.equal(noOther.other, 0)
  assert.equal(noOther.total, 1)
  const arrayInput = groupTop([{ key: 'x', value: 5 }, { key: 'y', value: 2 }], 1)
  assert.deepEqual(arrayInput.items, [{ key: 'x', value: 5 }])
  assert.equal(arrayInput.other, 2)
})

test('validateAdvancedJson and validateToolGroups report stable codes', () => {
  const { validateAdvancedJson, validateToolGroups } = captured.factory(fakeRequire).__test
  assert.equal(validateAdvancedJson('').error, 'json-empty')
  assert.equal(validateAdvancedJson('nope').error, 'json-invalid')
  assert.equal(validateAdvancedJson('[]').error, 'json-not-object')
  assert.equal(validateAdvancedJson('null').error, 'json-not-object')
  const parsed = validateAdvancedJson('{"memory":["mnemon_"]}')
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.value, { memory: ['mnemon_'] })

  assert.equal(validateToolGroups({ memory: ['mnemon_'] }).ok, true)
  assert.equal(validateToolGroups({}).ok, false)
  assert.ok(validateToolGroups({ memory: 'mnemon_' }).errors.some(error => error.code === 'toolGroups-list'))
  assert.ok(validateToolGroups({ 'Bad_Key': ['x'] }).errors.some(error => error.code === 'toolGroups-key'))
  assert.ok(validateToolGroups({ '123': ['x'] }).errors.some(error => error.code === 'toolGroups-key'))
  assert.ok(validateToolGroups({ memory: ['  '] }).errors.length > 0)
  assert.equal(validateToolGroups([]).ok, false)
})

test('sameDirectoryText folds Windows case and trailing separators', () => {
  const { sameDirectoryText } = captured.factory(fakeRequire).__test
  assert.equal(sameDirectoryText('D:\\Projects\\Data\\', 'd:/projects/data'), true)
  assert.equal(sameDirectoryText('D:\\Projects\\Data', 'D:\\Projects\\Data2'), false)
  assert.equal(sameDirectoryText('', ''), false)
  assert.equal(sameDirectoryText('D:\\A\\\\', 'D:/a'), true)
})

test('formFromConfig and configPatchFromForm round-trip all fields', () => {
  const { formFromConfig, configPatchFromForm } = captured.factory(fakeRequire).__test
  const values = {
    dataDir: 'D:\\token-data',
    retainRequestDays: 60,
    retainDailyDays: 400,
    flushIntervalMs: 2000,
    pricing: [{
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      currency: 'CNY',
      inputPerMillion: 2,
      cacheReadPerMillion: 0.5,
      cacheWritePerMillion: 4,
      outputPerMillion: 8,
      offPeak: { inputPerMillion: 1, cacheWritePerMillion: 2, outputPerMillion: 4 },
      priceVersion: 'v1',
    }],
    pricingOffPeakDays: ['2026-12-25', '2026-10-01'],
    toolGroups: { memory: ['mnemon_'], skill: ['skill'], agentTeams: ['spawn_teammate'] },
    maxDetailRowsPerDay: 1000,
    enableAutoRefresh: true,
    rememberLastTab: true,
    autoRefreshIntervalMs: 60000,
    rpcChannel: '/token-attribution',
  }
  const form = formFromConfig(values)
  for (const key of ['dataDir', 'retainRequestDays', 'retainDailyDays', 'flushIntervalMs', 'maxDetailRowsPerDay', 'autoRefreshIntervalMs', 'rpcChannel']) {
    assert.equal(typeof form[key], 'string', `${key} is edited as text`)
  }
  assert.equal(form.enableAutoRefresh, true)
  assert.equal(form.rememberLastTab, true)
  assert.equal(form.pricing.length, 1)
  assert.equal(form.pricing[0].inputPerMillion, '2')
  assert.equal(form.pricing[0].offPeakInputPerMillion, '1')
  assert.equal(form.pricing[0].offPeakCacheReadPerMillion, '')
  assert.equal(form.pricing[0].offPeakCacheWritePerMillion, '2')
  assert.equal(form.pricing[0].offPeakOutputPerMillion, '4')
  assert.equal(form.pricingOffPeakDays, ['2026-12-25', '2026-10-01'].join('\n'))

  const built = configPatchFromForm(form)
  assert.equal(built.ok, true)
  assert.equal(built.patch.dataDir, 'D:\\token-data')
  assert.equal(built.patch.retainRequestDays, 60)
  assert.equal(built.patch.retainDailyDays, 400)
  assert.equal(built.patch.flushIntervalMs, 2000)
  assert.equal(built.patch.maxDetailRowsPerDay, 1000)
  assert.equal(built.patch.enableAutoRefresh, true)
  assert.equal(built.patch.rememberLastTab, true)
  assert.equal(built.patch.autoRefreshIntervalMs, 60000)
  assert.equal(built.patch.rpcChannel, '/token-attribution')
  assert.deepEqual(built.patch.toolGroups, values.toolGroups)
  assert.equal(built.patch.pricing[0].inputPerMillion, 2)
  assert.equal(built.patch.pricing[0].cacheReadPerMillion, 0.5)
  assert.equal(built.patch.pricing[0].cacheWritePerMillion, 4)
  assert.equal(built.patch.pricing[0].outputPerMillion, 8)
  assert.equal(built.patch.pricing[0].priceVersion, 'v1')
  assert.deepEqual(built.patch.pricing[0].offPeak, { inputPerMillion: 1, cacheWritePerMillion: 2, outputPerMillion: 4 })
  assert.deepEqual(built.patch.pricingOffPeakDays, ['2026-12-25', '2026-10-01'])
})

test('configPatchFromForm rejects invalid values with field paths', () => {
  const { formFromConfig, configPatchFromForm } = captured.factory(fakeRequire).__test
  const form = formFromConfig({})
  form.dataDir = 'relative/path'
  form.retainRequestDays = '0'
  form.autoRefreshIntervalMs = '10'
  form.rpcChannel = '/api'
  form.toolGroupsText = '[]'
  form.pricing = [{
    provider: '',
    model: '*',
    currency: '',
    inputPerMillion: 'x',
    cacheReadPerMillion: '0',
    cacheWritePerMillion: '0',
    outputPerMillion: '0',
    priceVersion: '',
  }]
  const built = configPatchFromForm(form)
  assert.equal(built.ok, false)
  assert.equal(built.patch, null)
  const codes = built.errors.map(error => `${error.field}:${error.code}`)
  assert.ok(codes.includes('dataDir:dataDirAbsolute'), codes.join(', '))
  assert.ok(codes.includes('retainRequestDays:range'), codes.join(', '))
  assert.ok(codes.includes('autoRefreshIntervalMs:range'), codes.join(', '))
  assert.ok(codes.includes('rpcChannel:rpcChannel'), codes.join(', '))
  assert.ok(codes.includes('toolGroups:json-not-object'), codes.join(', '))
  assert.ok(codes.includes('pricing.0.provider:price-provider'), codes.join(', '))
  assert.ok(codes.includes('pricing.0.currency:price-currency'), codes.join(', '))
  assert.ok(codes.includes('pricing.0.inputPerMillion:price-number'), codes.join(', '))
})

test('off-peak price fields serialize partially and fall back to peak when empty', () => {
  const { formFromConfig, configPatchFromForm } = captured.factory(fakeRequire).__test
  const form = formFromConfig({
    pricing: [{
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      currency: 'CNY',
      inputPerMillion: 2,
      cacheReadPerMillion: 0.04,
      cacheWritePerMillion: 0,
      outputPerMillion: 8,
      offPeak: { inputPerMillion: 1, cacheWritePerMillion: 2 },
    }, {
      provider: 'other',
      model: '*',
      currency: 'CNY',
      inputPerMillion: 1,
      cacheReadPerMillion: 1,
      cacheWritePerMillion: 1,
      outputPerMillion: 1,
    }],
    pricingOffPeakDays: ['2026-10-01', '2026-12-25'],
  })
  assert.equal(form.pricing[0].offPeakInputPerMillion, '1')
  assert.equal(form.pricing[0].offPeakCacheReadPerMillion, '')
  assert.equal(form.pricing[0].offPeakCacheWritePerMillion, '2')
  assert.equal(form.pricing[0].offPeakOutputPerMillion, '')
  assert.equal(form.pricing[1].offPeakInputPerMillion, '')
  assert.equal(form.pricingOffPeakDays, ['2026-10-01', '2026-12-25'].join('\n'))

  // A zero off-peak value is a real override (free), not "empty".
  form.pricing[0].offPeakCacheReadPerMillion = '0'
  form.pricing[0].offPeakOutputPerMillion = '4.5'
  form.pricingOffPeakDays = '\n2026-10-01\n\n2026-10-01\n2026-12-25\n'
  const built = configPatchFromForm(form)
  assert.equal(built.ok, true, built.errors?.map(error => `${error.field}:${error.code}`).join(', '))
  assert.deepEqual(built.patch.pricing[0].offPeak, {
    inputPerMillion: 1,
    cacheReadPerMillion: 0,
    cacheWritePerMillion: 2,
    outputPerMillion: 4.5,
  })
  assert.deepEqual(built.patch.pricingOffPeakDays, ['2026-10-01', '2026-12-25'], 'trimmed, deduped, order preserved')
  assert.ok(!Object.hasOwn(built.patch.pricing[1], 'offPeak'), 'all-empty off-peak fields omit the object')

  form.pricing[0].offPeakInputPerMillion = ''
  form.pricing[0].offPeakCacheReadPerMillion = ''
  form.pricing[0].offPeakCacheWritePerMillion = '  '
  form.pricing[0].offPeakOutputPerMillion = ''
  form.pricingOffPeakDays = ''
  const empty = configPatchFromForm(form)
  assert.equal(empty.ok, true)
  assert.ok(!Object.hasOwn(empty.patch.pricing[0], 'offPeak'), 'empty overrides fall back to peak')
  assert.deepEqual(empty.patch.pricingOffPeakDays, [])
})

test('off-peak prices and whole-day dates reject invalid input with field paths', () => {
  const { formFromConfig, configPatchFromForm, normalizeOffPeakDays } = captured.factory(fakeRequire).__test
  const form = formFromConfig({
    pricing: [{ provider: 'deepseek-official', model: '*', currency: 'CNY', inputPerMillion: 1, cacheReadPerMillion: 1, cacheWritePerMillion: 1, outputPerMillion: 1 }],
  })
  form.pricing[0].offPeakInputPerMillion = 'x'
  form.pricing[0].offPeakOutputPerMillion = '-1'
  form.pricingOffPeakDays = '2026-02-30'
  const built = configPatchFromForm(form)
  assert.equal(built.ok, false)
  assert.equal(built.patch, null)
  const codes = built.errors.map(error => `${error.field}:${error.code}`)
  assert.ok(codes.includes('pricing.0.offPeakInputPerMillion:price-number'), codes.join(', '))
  assert.ok(codes.includes('pricing.0.offPeakOutputPerMillion:price-number'), codes.join(', '))
  assert.ok(codes.includes('pricingOffPeakDays:price-date'), codes.join(', '))

  assert.equal(normalizeOffPeakDays('2026-02-28\n2028-02-29\n2027-02-29').ok, false, 'non-leap day is invalid')
  assert.deepEqual(normalizeOffPeakDays('2026-02-28\n2028-02-29').days, ['2026-02-28', '2028-02-29'])
  for (const bad of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-01-32', '26-01-01', '2026/01/01', '2026-1-1', 'not-a-date']) {
    const result = normalizeOffPeakDays(bad)
    assert.equal(result.ok, false, `${bad} is rejected`)
    assert.deepEqual(result.days, [])
    assert.deepEqual(result.errors, [{ field: 'pricingOffPeakDays', code: 'price-date' }])
  }
  assert.equal(normalizeOffPeakDays('').ok, true)
  assert.deepEqual(normalizeOffPeakDays('').days, [])
  assert.deepEqual(normalizeOffPeakDays(null).days, [])
  assert.deepEqual(normalizeOffPeakDays(undefined).days, [])
})

test('sessionDisplayName resolves displayTitle/title at render time with short-id fallback', () => {
  const { sessionDisplayName } = captured.factory(fakeRequire).__test
  const byId = {
    titled: { displayTitle: '重构鉴权中间件', title: '旧标题' },
    titleOnly: { displayTitle: '   ', title: '标题回退' },
    blank: { displayTitle: '  ', title: '\t' },
    numbered: { displayTitle: 42, title: '数字标题' },
    stringRow: 'not-a-row',
    padded: { displayTitle: '  两端空白  ' },
  }
  assert.equal(sessionDisplayName('titled', byId, 'short'), '重构鉴权中间件')
  assert.equal(sessionDisplayName('titleOnly', byId, 'short'), '标题回退')
  assert.equal(sessionDisplayName('blank', byId, 'short'), 'short')
  assert.equal(sessionDisplayName('numbered', byId, 'short'), '数字标题')
  assert.equal(sessionDisplayName('stringRow', byId, 'short'), 'short')
  assert.equal(sessionDisplayName('padded', byId, 'short'), '两端空白')
  assert.equal(sessionDisplayName('missing', byId, 'short'), 'short')
  assert.equal(sessionDisplayName('titled', null, 'short'), 'short')
  assert.equal(sessionDisplayName('titled', undefined, 'short'), 'short')
  assert.equal(sessionDisplayName('titled', { titled: null }, 'short'), 'short')
  assert.equal(sessionDisplayName('', { '': { displayTitle: 'empty-id' } }, 'short'), 'short')
  assert.equal(sessionDisplayName(null, byId, 'short'), 'short')
  assert.equal(sessionDisplayName('titled', byId), '重构鉴权中间件', 'fallback label is optional')
  assert.equal(sessionDisplayName('missing', byId), '')
  assert.equal(sessionDisplayName('titled', byId, '短 id'), '重构鉴权中间件')
})

test('M2.2 session titles render from the useSessions prop and fall back to the short id', () => {
  const plugin = captured.factory(fakeRequire)
  const { normalizeSummary, createTranslator, components } = plugin.__test
  const textOf = node => {
    if (node === null || node === undefined || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(textOf).join(' ')
    if (typeof node === 'function') return textOf(node({}))
    if (typeof node === 'object') {
      if (typeof node.type === 'function') return textOf(node.type(node.props))
      return textOf(node.children)
    }
    return ''
  }
  const flatten = node => {
    const out = []
    const visit = value => {
      if (value === null || value === undefined || typeof value !== 'object') return
      if (Array.isArray(value)) {
        for (const item of value) visit(item)
        return
      }
      out.push(value)
      if (typeof value.type === 'function') visit(value.type(value.props))
      else visit(value.children)
    }
    visit(node)
    return out
  }
  const locale = {
    bind: () => key => key,
    getSnapshot: () => ({ active: 'zh', locales: [{ id: 'zh', fallback: 'en' }, { id: 'en' }] }),
    subscribe: () => () => {},
  }
  const t = createTranslator(locale, 'zh')
  const summary = normalizeSummary({
    totals: { promptTokens: 120, outputTokens: 30, requests: 2 },
    byPurpose: { chat: { requests: 2, promptTokens: 120, outputTokens: 30 } },
    bySession: [
      { sessionId: 'session-abcdefghij', parentSessionId: null, depth: 0, tokens: 120, requests: 2 },
    ],
  })

  // Exactly how the panel derives the title map from the standard prop.
  const useSessions = selector => selector({
    byId: {
      'session-abcdefghij': { displayTitle: '重构鉴权中间件', title: '旧标题' },
    },
  })
  const sessionTitles = useSessions(state => state && state.byId)
  const dashboard = components.OverviewTab({ summary, meta: null, t, channel: '', sessionTitles })
  const dashboardText = textOf(dashboard)
  assert.ok(dashboardText.includes('重构鉴权中间件'), 'the resolved title appears in the session tree')
  assert.ok(!dashboardText.includes('session-abc'), 'the title replaces the short id')
  const titleNode = flatten(dashboard).find(node => node.props?.['data-dsh-part'] === 'session-title')
  assert.ok(titleNode, 'the title cell is marked for inspection')
  assert.equal(titleNode.props.title, 'session-abcdefghij · 重构鉴权中间件')
  assert.equal(titleNode.props.children, '重构鉴权中间件')

  // The mounted panel reads the standard prop once and hands the map down.
  let hookCalls = 0
  const panel = components.UsagePanel({
    localeRuntime: locale,
    rpc: {
      async call() {
        return { ok: true, value: {} }
      },
      getChannel() {
        return '/token-attribution'
      },
      setChannel() {},
    },
    useSessions(selector) {
      hookCalls += 1
      return selector({ byId: { 'session-abcdefghij': { displayTitle: '重构鉴权中间件' } } })
    },
  })
  assert.equal(panel.type, 'div')
  assert.equal(hookCalls, 1, 'UsagePanel calls the useSessions selector hook')

  // Without the prop (or with a blank title) the previous short-id display stays.
  const noTitle = components.SessionTreeTable({ bySession: summary.bySession, currency: 'CNY', t, sessionTitles: null })
  const noTitleText = textOf(noTitle)
  assert.ok(noTitleText.includes('session-abc…'), `short id fallback: ${noTitleText}`)
  const fallbackNode = flatten(noTitle).find(node => node.type === 'code' && node.props.title === 'session-abcdefghij')
  assert.ok(fallbackNode, 'the tooltip still exposes the full session id')
  assert.equal(fallbackNode.props.children, 'session-abc…')

  const blankTitles = components.SessionTreeTable({
    bySession: [{ sessionId: 'blank-sess', parentSessionId: null, tokens: 5, requests: 1 }],
    currency: 'CNY',
    t,
    sessionTitles: { 'blank-sess': { displayTitle: '   ', title: '  ' } },
  })
  assert.ok(textOf(blankTitles).includes('blank-sess'), 'blank titles fall back to the short id')

  // The cost footnote states the peak/off-peak rule.
  const footnote = textOf(components.Footnote({ summary, meta: null, t, channel: '' }))
  assert.ok(footnote.includes('费用按请求发生时间选择高峰或空闲单价'), footnote)
  assert.ok(footnote.includes('法定节假日仅在'), 'the footnote explains the holiday rule')
})

test('M2.2 locale keys exist in both dictionaries', () => {
  const { locales } = captured.factory(fakeRequire).__test
  const keys = [
    'config.field.pricingOffPeakDays',
    'config.field.pricingOffPeakDaysHint',
    'config.pricing.offPeakLabel',
    'config.pricing.offPeakHint',
    'config.pricing.offPeakInputPerMillion',
    'config.pricing.offPeakCacheReadPerMillion',
    'config.pricing.offPeakCacheWritePerMillion',
    'config.pricing.offPeakOutputPerMillion',
    'config.pricing.offPeakDaysPlaceholder',
    'config.error.price-date',
    'footnote.costTiers',
  ]
  for (const key of keys) {
    assert.ok(Object.hasOwn(locales.en, key), `en.${key} exists`)
    assert.ok(Object.hasOwn(locales.zh, key), `zh.${key} exists`)
    assert.equal(typeof locales.en[key], 'string')
    assert.equal(typeof locales.zh[key], 'string')
    assert.ok(locales.en[key].length > 0)
    assert.ok(locales.zh[key].length > 0)
  }
  assert.equal(locales.zh['config.pricing.offPeakHint'], '留空 = 与高峰价相同')
  assert.equal(locales.zh['config.pricing.offPeakInputPerMillion'], '空闲输入 / 百万')
  assert.equal(locales.zh['config.pricing.offPeakCacheReadPerMillion'], '空闲缓存读 / 百万')
  assert.equal(
    locales.zh['config.field.pricingOffPeakDaysHint'],
    '北京时间；高峰=工作日 09:00–12:00 / 14:00–18:00，其余为空闲半价；这里可补法定节假日日期（每行 YYYY-MM-DD）',
  )
  assert.ok(locales.en['footnote.costTiers'].includes('Asia/Shanghai'))
})

test('unwrapRpc and createRpc unwrap envelopes and retry the default channel', async () => {
  const plugin = captured.factory(fakeRequire)
  const { unwrapRpc, createRpc } = plugin.__test
  assert.deepEqual(unwrapRpc({ ok: true, value: 7 }), { ok: true, value: 7 })
  const failure = unwrapRpc({ ok: false, error: { code: 'bad-request', message: 'nope', details: { field: 'x' } } })
  assert.equal(failure.ok, false)
  assert.equal(failure.error.code, 'bad-request')
  assert.deepEqual(failure.error.details, { field: 'x' })
  assert.equal(unwrapRpc({ ok: true }).error.code, 'invalid-response')
  assert.equal(unwrapRpc(null).error.code, 'invalid-response')

  const calls = []
  const connection = {
    rpc: {
      async call(channel, endpoint, payload) {
        calls.push({ channel, endpoint, payload })
        if (channel !== '/token-attribution') throw new Error('unknown channel')
        return { ok: true, value: { called: endpoint } }
      },
    },
  }
  const storage = new Map([['dsh-token-attribution.rpcChannel', '/custom-channel']])
  globalThis.localStorage = {
    getItem(key) {
      return storage.get(key) ?? null
    },
    setItem(key, value) {
      storage.set(key, value)
    },
  }
  try {
    const rpc = createRpc(connection)
    assert.equal(rpc.getChannel(), '/custom-channel')
    const result = await rpc.call('summary', { range: 'today' })
    assert.equal(result.ok, true)
    assert.equal(rpc.getChannel(), '/token-attribution')
    assert.equal(storage.get('dsh-token-attribution.rpcChannel'), '/custom-channel')
    assert.deepEqual(calls.map((call) => call.channel), ['/custom-channel', '/token-attribution'])
    assert.equal(calls[1].endpoint, 'summary')
  } finally {
    delete globalThis.localStorage
  }
})

test('normalizeSummary accepts both the live Host shape and the documented shape', () => {
  const { normalizeSummary, normalizeConfigInfo, normalizeFieldDescriptors } = captured.factory(fakeRequire).__test
  const live = normalizeSummary({
    generatedAt: 123,
    range: { from: '2026-11-05', to: '2026-11-11' },
    totals: {
      promptTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      requests: 2,
      attempts: 2,
      estimatedRequests: 1,
      measuredRequests: 1,
    },
    byPurpose: { chat: { requests: 2, promptTokens: 100, outputTokens: 50 } },
    byCategory: { user: 60, 'system:memories': 40 },
    bySession: [{ sessionId: 'abcdefghijkl', parentSessionId: null, depth: 0, tokens: 150, requests: 2 }],
    byModel: [{ provider: 'deepseek-official', model: 'deepseek-flash', requests: 2, promptTokens: 100, outputTokens: 50, tokens: 150 }],
    cache: { input: 10, read: 80, write: 10, hitRate: 0.8 },
    cost: { amount: 0.5, priced: true, unpricedRequests: 0, currency: 'CNY' },
    data: {
      since: '2026-11-01',
      retention: { requestDays: 30, dailyDays: 365 },
      dataRoot: 'D:/token-data',
      readOnly: false,
    },
  })
  assert.equal(live.range.from, '2026-11-05')
  assert.equal(live.range.to, '2026-11-11')
  assert.equal(live.totals.totalTokens, 150)
  assert.equal(live.byPurpose.chat.tokens, 150)
  assert.deepEqual(live.byPurposeEntries.map(entry => entry.key), ['chat'])
  assert.equal(live.byCategory.user, 60)
  assert.equal(live.bySession[0].tokens, 150)
  assert.equal(live.byModel[0].tokens, 150)
  assert.equal(live.cache.hitRate, 0.8)
  assert.equal(live.data.since, '2026-11-01')
  assert.equal(live.data.readOnly, false)

  const documented = normalizeSummary({
    range: 'today',
    totals: {
      promptTokens: 10,
      outputTokens: 5,
      measuredPromptTokens: 10,
      estimatedPromptTokens: 0,
      estimatedOutputTokens: 0,
    },
    bySession: [{ sessionId: 'abcdef', promptTokens: 10, outputTokens: 5, requests: 1 }],
    data: { readOnly: true },
  })
  assert.equal(documented.range.label, 'today')
  assert.equal(documented.totals.totalTokens, 15)
  assert.equal(documented.bySession[0].tokens, 15)
  assert.equal(documented.data.readOnly, true)

  const descriptors = normalizeFieldDescriptors({
    dataDir: { type: 'string', default: '', editable: true, restartRequired: true },
    pricing: { type: 'array', default: [], editable: true, restartRequired: false },
  })
  assert.deepEqual(descriptors.map(field => field.name), ['dataDir', 'pricing'])
  assert.equal(descriptors[0].restartRequired, true)
  const legacyArray = normalizeFieldDescriptors([{ name: 'flushIntervalMs', type: 'integer', restartRequired: false }])
  assert.equal(legacyArray[0].name, 'flushIntervalMs')

  const info = normalizeConfigInfo({
    values: { retainRequestDays: 60 },
    defaults: { retainRequestDays: 30 },
    editable: true,
    restartRequiredFields: ['dataDir'],
    fields: { retainRequestDays: { type: 'integer' } },
    diagnostics: ['one diagnostic', 42],
  })
  assert.equal(info.values.retainRequestDays, 60)
  assert.equal(info.editable, true)
  assert.deepEqual(info.restartRequiredFields, ['dataDir'])
  assert.equal(info.fields[0].name, 'retainRequestDays')
  assert.deepEqual(info.diagnostics, ['one diagnostic'])
})

test('panel components render with a minimal hook runtime without throwing', () => {
  const plugin = captured.factory(fakeRequire)
  const { normalizeSummary, normalizeConfigInfo, createTranslator, components } = plugin.__test
  const textOf = node => {
    if (node === null || node === undefined || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(textOf).join(' ')
    if (typeof node === 'function') return textOf(node({}))
    if (typeof node === 'object') {
      if (typeof node.type === 'function') return textOf(node.type(node.props))
      return textOf(node.children)
    }
    return ''
  }
  const locale = {
    bind: () => key => key,
    getSnapshot: () => ({ active: 'zh', locales: [{ id: 'zh', fallback: 'en' }, { id: 'en' }] }),
    subscribe: () => () => {},
  }
  const t = createTranslator(locale, 'zh')
  const summary = normalizeSummary({
    generatedAt: 1700000000000,
    range: { from: '2026-11-05', to: '2026-11-11' },
    totals: { promptTokens: 1000, outputTokens: 500, totalTokens: 1500, requests: 3, attempts: 3, estimatedRequests: 1, measuredRequests: 2 },
    byPurpose: { chat: { requests: 2, promptTokens: 800, outputTokens: 400 }, 'auto-review': { requests: 1, promptTokens: 200, outputTokens: 100 } },
    byCategory: { user: 600, 'system:memories': 200, 'tool-result:memory': 100, 'assistant-text': 100 },
    bySession: [{ sessionId: 'abcdefghijklmnop', parentSessionId: null, depth: 0, tokens: 1500, requests: 3 }],
    byModel: [{ provider: 'deepseek-official', model: 'deepseek-flash', requests: 3, promptTokens: 1000, outputTokens: 500, tokens: 1500 }],
    cache: { input: 100, read: 800, write: 100, hitRate: 0.8 },
    cost: { amount: 1.25, priced: true, unpricedRequests: 1, currency: 'CNY' },
    data: { since: '2026-11-01', retention: { requestDays: 30, dailyDays: 365 }, dataRoot: 'D:/token-data', readOnly: true },
  })
  const meta = {
    since: '2026-11-01',
    dataRoot: 'D:/token-data',
    readOnly: true,
    pointerStatus: 'ok',
    migration: { status: 'ok', currentDataDir: 'D:/token-data', configuredDataDir: 'D:/token-data' },
  }
  const rpc = {
    async call() {
      return { ok: true, value: {} }
    },
    getChannel() {
      return '/token-attribution'
    },
    setChannel() {},
  }

  const dashboard = components.OverviewTab({ summary, meta, t, channel: '/token-attribution' })
  assert.equal(dashboard.type, 'div')
  const dashboardText = textOf(dashboard)
  for (const expected of ['总 tokens（含缓存）', '按调用目的', '按内容来源', '会话 Top', '模型', '口径说明', '未定价请求', '输入', '输出']) {
    assert.ok(dashboardText.includes(expected), `dashboard renders ${expected}`)
  }
  const panel = components.UsagePanel({ localeRuntime: locale, rpc })
  assert.equal(panel.type, 'div')
  assert.equal(panel.props['data-dsh-plugin'], 'dsh-token-attribution')
  assert.ok(textOf(panel).includes('正在加载用量…'), 'loading state is the first render')

  const configInfo = normalizeConfigInfo({
    values: {
      dataDir: 'D:/token-data',
      retainRequestDays: 30,
      retainDailyDays: 365,
      flushIntervalMs: 5000,
      pricing: [{ provider: 'deepseek-official', model: '*', currency: 'CNY', inputPerMillion: 2, cacheReadPerMillion: 0.5, cacheWritePerMillion: 4, outputPerMillion: 8 }],
      toolGroups: { memory: ['mnemon_'], skill: ['skill'], agentTeams: [] },
      maxDetailRowsPerDay: 200000,
      enableAutoRefresh: true,
      autoRefreshIntervalMs: 30000,
      rpcChannel: '/token-attribution',
    },
    defaults: {},
    editable: true,
    restartRequiredFields: ['dataDir', 'rpcChannel'],
    fields: {
      dataDir: { type: 'string', restartRequired: true },
      retainRequestDays: { type: 'integer', restartRequired: false },
    },
    diagnostics: ['pricing: example diagnostic'],
  })
  const configPanel = components.ConfigPanel({
    t,
    rpc,
    configInfo,
    configStatus: 'ready',
    configError: null,
    meta,
    migration: { status: 'ok', currentDataDir: 'D:/token-data', configuredDataDir: 'D:/token-data' },
    dataInfo: summary.data,
    onClose() {},
    onReload() {},
    onSaved() {},
  })
  assert.equal(configPanel.type, 'div')
  const configText = textOf(configPanel)
  for (const expected of ['用量设置', '数据目录', '价目表', '工具分组（JSON）', '保存', '取消', '重新加载', '需重启', 'Host 诊断', '空闲价（可选）', '空闲输入 / 百万', '全天空闲日期']) {
    assert.ok(configText.includes(expected), `config panel renders ${expected}`)
  }

  const readOnlyPanel = components.ConfigPanel({
    t,
    rpc,
    configInfo: { ...configInfo, editable: false },
    configStatus: 'ready',
    configError: null,
    meta,
    migration: null,
    dataInfo: summary.data,
    onClose() {},
    onReload() {},
    onSaved() {},
  })
  assert.equal(readOnlyPanel.type, 'div')
  assert.ok(textOf(readOnlyPanel).includes('只读配置'), 'read-only notice is rendered')

  const loadingPanel = components.ConfigPanel({
    t,
    rpc,
    configInfo: null,
    configStatus: 'loading',
    configError: null,
    meta: null,
    migration: null,
    dataInfo: null,
    onClose() {},
    onReload() {},
    onSaved() {},
  })
  assert.equal(loadingPanel.type, 'div')
  assert.ok(textOf(loadingPanel).includes('正在加载配置…'), 'config loading state is rendered')

  const normalized = normalizeSummary({
    data: { migrationStatus: 'failed', readOnly: false },
  })
  assert.equal(normalized.data.migrationStatus, 'failed')
  assert.equal(normalized.data.retention, null)

  const migrationStatus = plugin.__test.migrationStatusLabel(t, 'requires-migration')
  assert.equal(migrationStatus, '需要迁移')
  for (const status of ['ok', 'adopted', 'migrating', 'failed', 'requires-migration', '']) {
    const notice = components.MigrationStatus({
      t,
      meta: { dataRoot: 'D:/token-data', migrationStatus: status, migration: { status, currentDataDir: 'D:/token-data', configuredDataDir: 'D:/other' } },
      migration: null,
      dataInfo: summary.data,
      dataDir: 'D:/other',
      readOnly: false,
    })
    assert.equal(notice.type, 'div')
    assert.ok(textOf(notice).includes('迁移状态'), `migration notice renders for ${status || 'empty'}`)
  }

  const stacked = components.StackedBar({
    title: t('chart.purpose.title'),
    hint: t('chart.purpose.hint'),
    entries: [
      { key: 'chat', label: t('purpose.chat'), value: 10 },
      { key: 'auto-review', label: t('purpose.auto-review'), value: 5 },
    ],
    t,
  })
  assert.equal(stacked.type, 'section')
})

test('apply registers main and sidebar.panellist with cleanup order', () => {  const plugin = captured.factory(fakeRequire)
  const events = []
  const effects = []
  const ctx = {
    slots: {
      inject(name, callback) {
        events.push({ type: 'inject', name })
        const result = callback()
        events.push({ type: 'inject-result', name, result })
        return result
      },
      register(options, component) {
        events.push({ type: 'register', options, component })
        return () => events.push({ type: 'dispose', name: options.name, id: options.key ?? options.id })
      },
    },
    effect(factory, label) {
      events.push({ type: 'effect', label })
      const dispose = factory()
      effects.push(dispose)
      return dispose
    },
    locale: {
      register(namespace, dictionaries) {
        events.push({ type: 'locale.register', namespace, dictionaries })
        return () => events.push({ type: 'locale.dispose' })
      },
      bind(namespace) {
        events.push({ type: 'locale.bind', namespace })
        return key => key
      },
      getSnapshot() {
        return { active: 'zh', locales: [{ id: 'zh', fallback: 'en' }, { id: 'en' }] }
      },
      subscribe() {
        return () => {}
      },
    },
    connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
  }

  const dispose = plugin.apply(ctx)
  assert.equal(typeof dispose, 'function')

  const effectsRegistered = events.filter(event => event.type === 'effect')
  assert.equal(effectsRegistered.length, 1)
  assert.equal(effectsRegistered[0].label, 'dsh-token-attribution: locale dictionary')
  const locale = events.find(event => event.type === 'locale.register')
  assert.ok(locale, 'locale namespace registered')
  assert.equal(locale.namespace, 'token-attribution')
  assert.equal(typeof locale.dictionaries.zh, 'object')
  assert.equal(typeof locale.dictionaries.en, 'object')

  const injects = events.filter(event => event.type === 'inject')
  assert.deepEqual(injects.map(event => event.name), ['main', 'sidebar.panellist'])

  const registers = events.filter(event => event.type === 'register')
  assert.equal(registers.length, 2)
  const main = registers[0].options
  assert.equal(main.name, 'main')
  assert.equal(main.key, 'token-attribution')
  const services = main.inject()
  assert.equal(services.panelId, 'token-attribution')
  assert.equal(typeof services.rpc.call, 'function')
  assert.equal(services.localeRuntime, ctx.locale)
  assert.equal(typeof registers[0].component, 'function')

  const icon = registers[1].options
  assert.equal(icon.name, 'sidebar.panellist')
  assert.equal(icon.id, 'token-attribution')
  assert.equal(icon.order, 40)
  assert.equal(icon.locale, 'token-attribution')
  assert.equal(icon.label(), '用量', 'sidebar label uses the zh dictionary through the fake locale service')
  assert.equal(typeof registers[1].component, 'function')

  dispose()
  const disposals = events.filter(event => event.type === 'dispose')
  assert.deepEqual(disposals.map(event => `${event.name}:${event.id}`), [
    'sidebar.panellist:token-attribution',
    'main:token-attribution',
  ])
  for (const effect of effects) {
    if (typeof effect === 'function') effect()
  }
  assert.ok(events.some(event => event.type === 'locale.dispose'))
})

test('formatDayLabel and buildTrendPoints keep oldest-first geometry inside the viewBox', () => {
  const { formatDayLabel, buildTrendPoints } = captured.factory(fakeRequire).__test
  assert.equal(formatDayLabel('2026-11-11'), '11-11')
  assert.equal(formatDayLabel('2026-11-11T00:00:00Z'), '11-11')
  assert.equal(formatDayLabel(1700000000000), '11-14')
  assert.equal(formatDayLabel(''), '')
  assert.equal(formatDayLabel(null), '')
  assert.equal(formatDayLabel(0), '')

  const layout = buildTrendPoints([
    { day: '2026-11-11', promptTokens: 100, outputTokens: 50, requests: 2 },
    { day: '2026-11-09', promptTokens: 10, outputTokens: 5, requests: 1 },
    { day: '2026-11-10', promptTokens: 0, outputTokens: 0 },
    { day: 'not-a-day', promptTokens: 7 },
    { day: '2026-11-12', promptTokens: -5, outputTokens: 'x' },
  ], 600, 96)
  assert.equal(layout.count, 4)
  assert.deepEqual(layout.points.map(point => point.day), ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12'])
  assert.deepEqual(layout.points.map(point => point.label), ['11-09', '11-10', '11-11', '11-12'])
  assert.equal(layout.totals.promptTokens, 110)
  assert.equal(layout.totals.outputTokens, 55)
  assert.equal(layout.totals.tokens, 165)
  assert.equal(layout.maxTotal, 150)
  for (const point of layout.points) {
    assert.ok(point.x >= 0, `x is non-negative for ${point.day}`)
    assert.ok(point.x + point.barWidth <= 600 + 1e-9, `bars stay inside the viewBox for ${point.day}`)
    assert.ok(point.promptHeight >= 0 && point.promptY >= -1e-9, `prompt geometry for ${point.day}`)
    assert.ok(point.outputHeight >= 0 && point.outputY >= -1e-9, `output geometry for ${point.day}`)
    assert.ok(point.promptY + point.promptHeight <= 96 + 1e-9, `prompt stays inside the height for ${point.day}`)
    assert.ok(point.outputY + point.outputHeight <= 96 + 1e-9, `output stays inside the height for ${point.day}`)
  }
  const last = layout.points[layout.points.length - 1]
  assert.ok(last.x + last.barWidth <= 600 + 1e-9, 'the last bar stays inside the viewBox')
  assert.ok(last.x > 0, 'the last bar is centered inside its slot')
  for (const point of layout.points) {
    assert.ok(point.barWidth > 0 && point.barWidth <= 28, 'bars stay compact')
  }
  const single = buildTrendPoints([{ day: '2026-11-11', promptTokens: 10, outputTokens: 5 }], 600, 96)
  assert.equal(single.points.length, 1)
  assert.equal(single.points[0].barWidth, 28)
  assert.ok(single.points[0].x > 0 && single.points[0].x + single.points[0].barWidth <= 600)
  const emptyDay = layout.points[1]
  assert.equal(emptyDay.promptHeight, 0)
  assert.equal(emptyDay.outputHeight, 0)
  assert.equal(emptyDay.promptY, 96)

  assert.deepEqual(buildTrendPoints(null, 600, 96).points, [])
  assert.deepEqual(buildTrendPoints([], 600, 96).points, [])
  assert.deepEqual(buildTrendPoints([{ day: '2026-11-11', promptTokens: 1 }], 0, 96).points, [])
  assert.deepEqual(buildTrendPoints([{ day: '2026-11-11', promptTokens: 1 }], 600, 0).points, [])
  assert.deepEqual(buildTrendPoints([{ day: '2026-11-11', promptTokens: 1 }], -10, Number.NaN).points, [])
})

test('normalizeSummary carries byDay rows and per-row costs', () => {
  const { normalizeSummary } = captured.factory(fakeRequire).__test
  const summary = normalizeSummary({
    totals: {
      promptTokens: 100,
      outputTokens: 50,
      requests: 2,
      costByCurrency: {
        CNY: { amount: 0.1, currency: 'CNY', priced: true, unpricedRequests: 0 },
        USD: { amount: 0.2, currency: 'USD', priced: true, unpricedRequests: 1 },
      },
    },
    cost: { amount: 0.3, currency: 'MIXED', priced: true, unpricedRequests: 1 },
    byDay: [
      { day: '2026-11-11', requests: 2, promptTokens: 100, outputTokens: 50, estimatedRequests: 0, cost: { amount: 0.3, currency: 'CNY', priced: true } },
      { day: '2026-11-09', requests: 0, promptTokens: 0, outputTokens: 0 },
      { day: '2026-11-10', requests: 1, promptTokens: 5, outputTokens: 0 },
    ],
    bySession: [{
      sessionId: 'child-session',
      parentSessionId: 'parent-session',
      depth: 1,
      requests: 2,
      tokens: 150,
      cost: { amount: 0.3, currency: 'CNY', priced: true, unpricedRequests: 0 },
    }],
    byModel: [{
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      requests: 2,
      tokens: 150,
      cost: { amount: 0.3, currency: 'CNY', priced: true, unpricedRequests: 0 },
    }],
    byPurpose: {
      chat: { requests: 2, promptTokens: 100, outputTokens: 50, cost: { amount: 0.3, currency: 'CNY', priced: true } },
    },
  })
  assert.deepEqual(summary.byDay.map(day => day.day), ['2026-11-09', '2026-11-10', '2026-11-11'])
  assert.equal(summary.byDay[2].tokens, 150)
  assert.equal(summary.byDay[2].cost.amount, 0.3)
  assert.equal(summary.cost.currency, 'mixed')
  assert.equal(summary.cost.amount, 0.3)
  assert.equal(summary.cost.byCurrency.CNY.amount, 0.1)
  assert.equal(summary.cost.byCurrency.USD.unpricedRequests, 1)
  assert.equal(summary.bySession[0].parentSessionId, 'parent-session')
  assert.equal(summary.bySession[0].depth, 1)
  assert.equal(summary.bySession[0].cost.currency, 'CNY')
  assert.equal(summary.byModel[0].cost.amount, 0.3)
  assert.equal(summary.byPurpose.chat.cost.priced, true)
})

test('formatCostCell formats priced, unpriced and mixed rows', () => {
  const { formatCostCell } = captured.factory(fakeRequire).__test
  assert.equal(formatCostCell({ amount: 0.123, currency: 'CNY', priced: true }, 'CNY'), '¥0.123')
  assert.equal(formatCostCell({ amount: 0.0009, currency: 'CNY', priced: true }), '¥0.001')
  assert.equal(formatCostCell({ amount: 1.5, currency: 'USD', priced: true }), '$1.50')
  assert.equal(formatCostCell({ amount: 123.456, currency: 'CNY', priced: true }), '¥123')
  assert.equal(formatCostCell({ amount: 2, currency: 'XXX', priced: true }), 'XXX 2.00')
  assert.equal(formatCostCell(1.5, 'CNY'), '¥1.50')
  assert.equal(formatCostCell({ amount: 0, currency: 'CNY', priced: false, unpricedRequests: 3 }, 'CNY'), '—')
  assert.equal(formatCostCell(null), '—')
  assert.equal(formatCostCell(undefined, 'CNY'), '—')
  assert.equal(formatCostCell({ amount: 'nope', currency: 'CNY', priced: true }), '—')
  assert.equal(formatCostCell({ amount: 1, currency: 'mixed', priced: true }, 'CNY', { mixed: '混币' }), '混币')
  assert.equal(formatCostCell({ amount: 1 }, 'mixed'), '混币')
  assert.equal(formatCostCell({ amount: 1, currency: 'MIXED', priced: true }, 'CNY', { mixed: 'Mixed' }), 'Mixed')
})

test('formatCurrencyBreakdown lists every currency without summing', () => {
  const plugin = captured.factory(fakeRequire)
  const { formatCurrencyBreakdown, createTranslator } = plugin.__test
  const locale = {
    bind: () => key => key,
    getSnapshot: () => ({ active: 'zh', locales: [{ id: 'zh', fallback: 'en' }, { id: 'en' }] }),
    subscribe: () => () => {},
  }
  const t = createTranslator(locale, 'zh')
  assert.equal(formatCurrencyBreakdown({
    USD: { amount: 0.045, priced: true, unpricedRequests: 3 },
    CNY: { amount: 0.123, priced: true, unpricedRequests: 12 },
  }, t), 'CNY 0.123（未定价 12） · USD 0.045（未定价 3）')
  assert.equal(formatCurrencyBreakdown({}, t), '')
  assert.equal(formatCurrencyBreakdown(null, t), '')
  assert.equal(formatCurrencyBreakdown(undefined, t), '')
  // An all-unpriced currency shows an em dash, never a misleading zero amount.
  assert.equal(formatCurrencyBreakdown({ CNY: { amount: 0, priced: false, unpricedRequests: 4 } }, t), 'CNY —（未定价 4）')
})

test('categoryTableRows includes every category sorted by tokens with prompt shares', () => {
  const plugin = captured.factory(fakeRequire)
  const { categoryTableRows, createTranslator } = plugin.__test
  const locale = {
    bind: () => key => key,
    getSnapshot: () => ({ active: 'zh', locales: [{ id: 'zh', fallback: 'en' }, { id: 'en' }] }),
    subscribe: () => () => {},
  }
  const t = createTranslator(locale, 'zh')
  const rows = categoryTableRows({
    user: 40,
    'system:skills': 60,
    'tool-result:other:read': 200,
    'injected:memory-snapshot': 100,
  }, 400, t)
  assert.deepEqual(rows.map(row => row.key), [
    'tool-result:other:read',
    'injected:memory-snapshot',
    'system:skills',
    'user',
  ])
  assert.deepEqual(rows.map(row => row.tokens), [200, 100, 60, 40])
  assert.deepEqual(rows.map(row => row.share), [0.5, 0.25, 0.15, 0.1])
  assert.equal(rows[0].label, '工具结果 · other:read')
  assert.equal(rows[1].label, '记忆注入')
  assert.equal(rows[2].label, '系统提示 · skills')
  assert.equal(rows[3].label, '用户')
  // Object-shaped values are accepted and a zero denominator yields zero shares.
  const objectRows = categoryTableRows({ user: { tokens: 10 } }, 20, t)
  assert.equal(objectRows[0].tokens, 10)
  assert.equal(objectRows[0].share, 0.5)
  assert.equal(categoryTableRows({ user: 5 }, 0, t)[0].share, 0)
  assert.deepEqual(categoryTableRows({}, 100, t), [])
  assert.deepEqual(categoryTableRows(null, 100, t), [])
})

test('normalizeRequests keeps only numeric detail rows, newest first and capped', () => {
  const { normalizeRequests } = captured.factory(fakeRequire).__test
  const page = normalizeRequests({
    total: 3,
    items: [
      { ts: 1000, purpose: 'chat', sessionId: 'sess-a', promptTokens: 10, outputTokens: 5, cacheReadTokens: 2, cost: { amount: 0.01, currency: 'CNY', priced: true } },
      { ts: 3000, purpose: 'auto-review', prompt: 1, output: 2, cacheRead: 0 },
      { ts: 2000, purpose: 'compaction', promptTokens: 3, outputTokens: 4, usage: { cacheRead: 7 } },
      'not-a-row',
    ],
  })
  assert.equal(page.total, 3)
  assert.deepEqual(page.items.map(item => item.ts), [3000, 2000, 1000])
  assert.equal(page.items[0].purpose, 'auto-review')
  assert.equal(page.items[0].promptTokens, 1)
  assert.equal(page.items[0].outputTokens, 2)
  assert.equal(page.items[2].cacheReadTokens, 2)
  assert.equal(page.items[2].sessionId, 'sess-a', 'the detail row carries its session id for the title column')
  assert.equal(page.items[0].sessionId, '', 'a row without a session id stays empty')
  assert.equal(page.items[1].cacheReadTokens, 7)
  assert.equal(page.items[2].cost.amount, 0.01)
  assert.equal(page.items[1].cost, null)
  assert.deepEqual(normalizeRequests(null), { items: [], total: 0 })
  const many = { items: Array.from({ length: 30 }, (_value, index) => ({ ts: index + 1 })) }
  assert.equal(normalizeRequests(many).items.length, 20)
  assert.equal(normalizeRequests(many).items[0].ts, 30)
})

test('exportRequestPayload and exportFilename build Host export requests', () => {
  const { exportRequestPayload, exportFilename } = captured.factory(fakeRequire).__test
  assert.deepEqual(exportRequestPayload('7d'), { format: 'json', range: '7d' })
  assert.deepEqual(exportRequestPayload('30d', 'CSV'), { format: 'csv', range: '30d' })
  assert.deepEqual(exportRequestPayload('year', 'xml'), { format: 'json', range: 'today' })
  assert.deepEqual(exportRequestPayload({ range: 'today', format: 'csv' }), { format: 'csv', range: 'today' })
  assert.deepEqual(exportRequestPayload({ from: '2026-11-01', to: '2026-11-11', format: 'csv' }), {
    format: 'csv',
    from: '2026-11-01',
    to: '2026-11-11',
  })
  assert.deepEqual(exportRequestPayload({ from: '2026-11-01' }), { format: 'json', range: 'today' })

  assert.equal(exportFilename({ filename: 'usage-2026-11-11.json' }), 'usage-2026-11-11.json')
  assert.equal(exportFilename({ filename: 'a/b:c.json' }), 'a_b_c.json')
  assert.equal(exportFilename({ filename: '  ' }), 'token-attribution-export.txt')
  assert.equal(exportFilename({ mediaType: 'text/csv; charset=utf-8' }), 'token-attribution-export.csv')
  assert.equal(exportFilename({ mediaType: 'application/json' }), 'token-attribution-export.json')
  assert.equal(exportFilename({}), 'token-attribution-export.txt')
})

test('saveExportFile drives a temporary anchor through an injectable document', () => {
  const { saveExportFile } = captured.factory(fakeRequire).__test
  const created = []
  const clicks = []
  const appended = []
  const removed = []
  const revoked = []
  class FakeBlob {
    constructor(parts, options) {
      this.parts = parts
      this.type = options?.type
      this.size = parts.join('').length
    }
  }
  const urlApi = {
    createObjectURL(blob) {
      created.push(blob)
      return 'blob:fake-1'
    },
    revokeObjectURL(url) {
      revoked.push(url)
    },
  }
  const anchor = {
    href: '',
    download: '',
    rel: '',
    style: {},
    click() {
      clicks.push({ href: this.href, download: this.download })
    },
  }
  const doc = {
    defaultView: { Blob: FakeBlob, URL: urlApi },
    createElement(tag) {
      assert.equal(tag, 'a')
      return anchor
    },
    body: {
      appendChild(node) {
        appended.push(node)
      },
      removeChild(node) {
        removed.push(node)
      },
    },
  }
  const result = saveExportFile({
    filename: 'usage-2026-11-11.json',
    mediaType: 'application/json',
    content: '{"ok":true}',
    bytes: 11,
    truncated: false,
  }, doc)
  assert.equal(result.ok, true)
  assert.equal(result.filename, 'usage-2026-11-11.json')
  assert.equal(result.mediaType, 'application/json')
  assert.equal(result.bytes, 11)
  assert.equal(result.blobSize, 11)
  assert.equal(result.truncated, false)
  assert.equal(created.length, 1)
  assert.deepEqual(created[0].parts, ['{"ok":true}'])
  assert.equal(created[0].type, 'application/json')
  assert.equal(anchor.href, 'blob:fake-1')
  assert.equal(anchor.download, 'usage-2026-11-11.json')
  assert.deepEqual(clicks, [{ href: 'blob:fake-1', download: 'usage-2026-11-11.json' }])
  assert.deepEqual(appended, [anchor])
  assert.deepEqual(removed, [anchor])
  assert.deepEqual(revoked, ['blob:fake-1'])

  const truncated = saveExportFile({ content: 'x', mediaType: 'text/csv', filename: 'x.csv', truncated: true }, doc)
  assert.equal(truncated.ok, true)
  assert.equal(truncated.truncated, true)
  assert.equal(truncated.filename, 'x.csv')

  assert.equal(saveExportFile({ content: '' }, doc).code, 'empty-content')
  assert.equal(saveExportFile({ content: 'x' }, {}).code, 'no-document')
  assert.equal(saveExportFile({ content: 'x' }, { createElement() { throw new Error('nope') } }).code, 'save-failed')

  const derived = saveExportFile({ content: '[]', mediaType: 'application/json' }, doc)
  assert.equal(derived.ok, true)
  assert.equal(derived.filename, 'token-attribution-export.json')
})

test('exportStatusText maps export RPC and download failures', () => {
  const plugin = captured.factory(fakeRequire)
  const { exportStatusText, createTranslator } = plugin.__test
  const locale = {
    bind: () => key => key,
    getSnapshot: () => ({ active: 'zh', locales: [{ id: 'zh', fallback: 'en' }, { id: 'en' }] }),
    subscribe: () => () => {},
  }
  const t = createTranslator(locale, 'zh')
  const rpcFailure = exportStatusText(t, { kind: 'error', error: { code: 'bad-request', message: '', details: {} } })
  assert.ok(rpcFailure.includes('导出失败'), rpcFailure)
  assert.ok(rpcFailure.includes('Host 拒绝了请求参数'), rpcFailure)
  assert.ok(exportStatusText(t, { kind: 'error', downloadCode: 'no-document' }).includes('下载能力不可用'))
  assert.equal(exportStatusText(t, { kind: 'saved', filename: 'a.json', bytes: 1000 }), '已保存 a.json（1,000 字节）')
  assert.ok(exportStatusText(t, { kind: 'truncated', filename: 'a.csv', bytes: 10 }).includes('截断'))
  assert.equal(exportStatusText(t, null), '')
  assert.equal(exportStatusText(t, {}), '')
})

test('new M2 locale keys exist in both dictionaries', () => {
  const { locales } = captured.factory(fakeRequire).__test
  for (const key of [
    'trend.title',
    'trend.hint',
    'trend.prompt',
    'trend.output',
    'trend.barTitle',
    'trend.empty',
    'table.cost',
    'table.costMixed',
    'chart.category.expand',
    'chart.category.collapse',
    'chart.category.detailCategory',
    'chart.category.detailTokens',
    'chart.category.detailShare',
    'chart.category.detailEmpty',
    'requests.title',
    'requests.hint',
    'requests.expand',
    'requests.collapse',
    'requests.loading',
    'requests.empty',
    'requests.failed',
    'requests.time',
    'requests.cacheRead',
    'export.json',
    'export.csv',
    'export.busy',
    'export.saved',
    'export.truncated',
    'export.failed',
    'export.download.noDocument',
    'export.download.emptyContent',
    'export.download.saveFailed',
    'footnote.costMixed',
    'footnote.costBreakdown',
    'footnote.costCurrencyItem',
    'footnote.costDetailIncomplete',
  ]) {
    assert.ok(Object.hasOwn(locales.en, key), `en.${key} exists`)
    assert.ok(Object.hasOwn(locales.zh, key), `zh.${key} exists`)
  }
  assert.equal(locales.zh['export.json'], '导出 JSON')
  assert.equal(locales.zh['export.csv'], '导出 CSV')
  assert.equal(locales.zh['table.cost'], '费用')
  assert.equal(locales.zh['table.costMixed'], '混币')
  assert.equal(locales.zh['chart.category.expand'], '展开明细')
  assert.equal(locales.zh['chart.category.collapse'], '收起明细')
  assert.equal(locales.zh['chart.category.detailShare'], '占 prompt')
  assert.equal(locales.zh['footnote.costCurrencyItem'], '{currency} {amount}（未定价 {count}）')
})

test('M2 sections render inside the overview tab and the details pane', () => {
  const plugin = captured.factory(fakeRequire)
  const { normalizeSummary, createTranslator, components } = plugin.__test
  const textOf = node => {
    if (node === null || node === undefined || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(textOf).join(' ')
    if (typeof node === 'function') return textOf(node({}))
    if (typeof node === 'object') {
      if (typeof node.type === 'function') return textOf(node.type(node.props))
      return textOf(node.children)
    }
    return ''
  }
  const locale = {
    bind: () => key => key,
    getSnapshot: () => ({ active: 'zh', locales: [{ id: 'zh', fallback: 'en' }, { id: 'en' }] }),
    subscribe: () => () => {},
  }
  const t = createTranslator(locale, 'zh')
  const summary = normalizeSummary({
    totals: { promptTokens: 150, outputTokens: 55, requests: 3 },
    byPurpose: { chat: { requests: 3, promptTokens: 150, outputTokens: 55 } },
    byCategory: { user: 150 },
    byDay: [
      { day: '2026-11-09', promptTokens: 10, outputTokens: 5, requests: 1 },
      { day: '2026-11-11', promptTokens: 140, outputTokens: 50, requests: 2 },
    ],
    bySession: [{ sessionId: 'sess-1', tokens: 205, requests: 3, cost: { amount: 0.123, currency: 'CNY', priced: true } }],
    byModel: [{ provider: 'deepseek-official', model: 'deepseek-flash', tokens: 205, requests: 3, cost: { amount: 0.123, currency: 'CNY', priced: true } }],
    cost: { amount: 0.123, currency: 'CNY', priced: true, unpricedRequests: 0 },
  })
  const overview = components.OverviewTab({ summary, meta: null, t, channel: '/token-attribution' })
  const overviewText = textOf(overview)
  for (const expected of ['按天趋势', '11-09', '11-11', '费用', '口径说明']) {
    assert.ok(overviewText.includes(expected), `overview renders ${expected}`)
  }
  assert.ok(!overviewText.includes('最近请求'), 'the request detail pane lives on the Details tab')

  const trend = components.TrendChart({ byDay: summary.byDay, t })
  assert.equal(trend.type, 'section')
  const trendText = textOf(trend)
  assert.ok(trendText.includes('按天趋势'))
  assert.ok(trendText.includes('11-09 · prompt 10 · output 5'), trendText)
  assert.ok(trendText.includes('Prompt') && trendText.includes('Output'), 'trend legend labels are rendered')
  assert.ok(textOf(components.TrendChart({ byDay: [], t })).includes('该范围内暂无按天数据'))

  const ready = components.DetailsTab({
    t,
    state: {
      status: 'ready',
      total: 2,
      offset: 0,
      purpose: 'all',
      sessionId: 'all',
      items: [
        { key: 'a', ts: 1700000000000, sessionId: 'sess-1', purpose: 'chat', promptTokens: 100, outputTokens: 20, cacheReadTokens: 5, cost: { amount: 0.0123, currency: 'CNY', priced: true } },
        { key: 'b', ts: 1700000001000, sessionId: '', purpose: 'auto-review', promptTokens: 10, outputTokens: 2, cacheReadTokens: 0, cost: null },
      ],
    },
    sessions: summary.bySession,
    sessionTitles: null,
    onPurposeChange() {},
    onSessionChange() {},
    onLoadMore() {},
    onRetry() {},
  })
  const readyText = textOf(ready)
  for (const expected of ['请求明细', '主对话', '自动审查', '¥0.012', '—']) {
    assert.ok(readyText.includes(expected), `details pane renders ${expected}`)
  }
  assert.ok(readyText.includes('已加载全部 2 条'), 'a complete page says all rows are loaded')

  const failed = components.DetailsTab({
    t,
    state: { status: 'error', total: 0, offset: 0, purpose: 'all', sessionId: 'all', items: [], error: { code: 'bad-request', message: '', details: {} } },
    sessions: [],
    sessionTitles: null,
    onPurposeChange() {},
    onSessionChange() {},
    onLoadMore() {},
    onRetry() {},
  })
  assert.ok(textOf(failed).includes('重试'), 'failed pane offers a retry')
  assert.ok(textOf(failed).includes('Host 拒绝了请求参数'), 'failed pane shows the RPC error')

  const mixedSummary = normalizeSummary({
    totals: { requests: 1 },
    cost: { amount: 1, currency: 'mixed', priced: true },
  })
  const mixedDashboard = textOf(components.OverviewTab({ summary: mixedSummary, meta: null, t, channel: '' }))
  assert.ok(mixedDashboard.includes('混币'), 'mixed-currency total renders its marker')

  const panel = components.UsagePanel({
    localeRuntime: locale,
    rpc: {
      async call() {
        return { ok: true, value: {} }
      },
      getChannel() {
        return '/token-attribution'
      },
      setChannel() {},
    },
  })
  const panelText = textOf(panel)
  assert.ok(panelText.includes('导出 JSON'), 'header shows the JSON export button')
  assert.ok(panelText.includes('导出 CSV'), 'header shows the CSV export button')
})

test('footnote lists mixed-currency amounts and warns when cost detail is incomplete', () => {
  const plugin = captured.factory(fakeRequire)
  const { normalizeSummary, createTranslator, components } = plugin.__test
  const locale = {
    bind: () => key => key,
    getSnapshot: () => ({ active: 'zh', locales: [{ id: 'zh', fallback: 'en' }, { id: 'en' }] }),
    subscribe: () => () => {},
  }
  const t = createTranslator(locale, 'zh')
  const textOf = node => {
    if (node === null || node === undefined || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(textOf).join(' ')
    if (typeof node === 'function') return textOf(node({}))
    if (typeof node === 'object') {
      if (typeof node.type === 'function') return textOf(node.type(node.props))
      return textOf(node.children)
    }
    return ''
  }

  const mixed = normalizeSummary({
    totals: {
      promptTokens: 300,
      requests: 4,
      costByCurrency: {
        CNY: { amount: 0.123, priced: true, unpricedRequests: 12 },
        USD: { amount: 0.045, priced: true, unpricedRequests: 3 },
      },
    },
    cost: { amount: 0, currency: 'mixed', priced: true, unpricedRequests: 15 },
  })
  const mixedText = textOf(components.Footnote({ summary: mixed, meta: null, t, channel: '/token-attribution' }))
  assert.ok(mixedText.includes('按币种：CNY 0.123（未定价 12） · USD 0.045（未定价 3）；金额分币种展示、不做合并。'), mixedText)
  assert.ok(!mixedText.includes('费用涉及多种币种'), 'the per-currency line replaces the generic mixed note')

  const single = normalizeSummary({
    totals: {
      requests: 1,
      costByCurrency: { CNY: { amount: 0.5, priced: true, unpricedRequests: 0 } },
    },
    cost: { amount: 0.5, currency: 'CNY', priced: true, unpricedRequests: 0 },
  })
  const singleText = textOf(components.Footnote({ summary: single, meta: null, t, channel: '' }))
  assert.ok(!singleText.includes('按币种：'), 'single-currency footnote keeps the existing behavior')
  assert.equal(single.data.costDetailIncomplete, false)

  const incomplete = normalizeSummary({
    totals: { promptTokens: 10, requests: 1 },
    data: { costDetailIncomplete: true },
  })
  assert.equal(incomplete.data.costDetailIncomplete, true)
  const warningText = textOf(components.Footnote({ summary: incomplete, meta: null, t, channel: '' }))
  assert.ok(warningText.includes('部分历史日期只剩日聚合总量、明细已过保留期'), warningText)
  assert.ok(warningText.includes('按来源/会话/模型的费用不完整'), warningText)
})

test('category detail expands every source with tokens and prompt share', () => {
  const plugin = captured.factory(fakeRequire)
  const { normalizeSummary, createTranslator, components } = plugin.__test
  const locale = {
    bind: () => key => key,
    getSnapshot: () => ({ active: 'zh', locales: [{ id: 'zh', fallback: 'en' }, { id: 'en' }] }),
    subscribe: () => () => {},
  }
  const t = createTranslator(locale, 'zh')
  const textOf = node => {
    if (node === null || node === undefined || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(textOf).join(' ')
    if (typeof node === 'function') return textOf(node({}))
    if (typeof node === 'object') {
      if (typeof node.type === 'function') return textOf(node.type(node.props))
      return textOf(node.children)
    }
    return ''
  }
  const byCategory = {
    'tool-result:other:read': 500,
    'injected:memory-snapshot': 200,
    'system:skills': 100,
    'reasoning-replay': 80,
    'tools:memory': 60,
    'assistant-text': 40,
    user: 10,
    'injected:notices': 10,
  }
  const summary = normalizeSummary({
    totals: { promptTokens: 1000, outputTokens: 100, totalTokens: 1100, requests: 8 },
    byPurpose: { chat: { requests: 8, promptTokens: 1000, outputTokens: 100 } },
    byCategory,
  })

  const overview = textOf(components.OverviewTab({ summary, meta: null, t, channel: '' }))
  assert.ok(!overview.includes('占 prompt'), 'the overview keeps the compact content-source bar')
  assert.ok(!overview.includes('展开明细'), 'the overview no longer carries the drill-down toggle')

  const expanded = textOf(components.SourcesTab({ summary, t }))
  for (const label of [
    '工具结果 · other:read',
    '记忆注入',
    '系统提示 · skills',
    '推理回放',
    '记忆工具声明',
    '助手正文',
    '用户',
    '注入 · notices',
  ]) {
    assert.ok(expanded.includes(label), `sources detail lists ${label}`)
  }
  assert.ok(expanded.includes('占 prompt'), 'sources detail renders the prompt-share column')
  assert.ok(expanded.includes('50.0%'), 'the largest category shows its prompt share')
  assert.ok(expanded.includes('20.0%'), 'the second category shows its prompt share')
  assert.ok(expanded.includes('合计 1K'), 'sources keeps the compact total in the stacked bar')

  const empty = textOf(components.CategoryDetailTable({ byCategory: {}, totalPromptTokens: 0, t }))
  assert.ok(empty.includes('该范围内暂无分类明细'))
})

test('M2.1 formatCompactTokens uses K/M/B units without grouping separators', () => {
  const { formatCompactTokens, formatTokens } = captured.factory(fakeRequire).__test
  const cases = [
    [0, '0'],
    [999, '999'],
    [1000, '1K'],
    [1234, '1.2K'],
    [12_300, '12.3K'],
    [614_997, '615K'],
    [999_999, '1M'],
    [1_000_000, '1M'],
    [1_850_000, '1.85M'],
    [614_997_661, '615M'],
    [999_999_999, '1B'],
    [1_234_567_890, '1.23B'],
    [2_000_000_000, '2B'],
    [-1234, '-1.2K'],
    [1000.4, '1K'],
  ]
  for (const [value, expected] of cases) {
    assert.equal(formatCompactTokens(value), expected, `formatCompactTokens(${value})`)
  }
  assert.equal(formatCompactTokens(Number.NaN), '—')
  assert.equal(formatCompactTokens(undefined), '—')
  assert.equal(formatCompactTokens(null), '0')
  // Locale-independent output: ASCII digits plus at most one fraction and a
  // K/M/B suffix, and never a thousands separator.
  for (const value of [1_234, 614_997_661, 1_234_567_890]) {
    const text = formatCompactTokens(value)
    assert.match(text, /^-?\d+(?:\.\d{1,2})?[KMB]$/u)
    assert.ok(!text.includes(','), `compact output has no separator: ${text}`)
  }
  // The full grouped form stays available for tooltips and request counts.
  assert.equal(formatTokens(614_997_661), '614,997,661')
  assert.equal(formatTokens(1_234_567_890), '1,234,567,890')
})

test('buildSessionTree tolerates orphans/cycles, sorts by subtree tokens and aggregates stats', () => {
  const { buildSessionTree, sessionTreeRows, subtreeStats } = captured.factory(fakeRequire).__test
  const tree = buildSessionTree([
    { sessionId: 'root', parentSessionId: null, depth: 0, promptTokens: 70, outputTokens: 30, tokens: 100, requests: 1, cache: { input: 10, read: 80, write: 10 } },
    { sessionId: 'child-a', parentSessionId: 'root', depth: 1, promptTokens: 30, outputTokens: 20, tokens: 50, requests: 2 },
    { sessionId: 'child-b', parentSessionId: 'root', depth: 1, promptTokens: 40, outputTokens: 30, tokens: 70, requests: 3 },
    { sessionId: 'grand', parentSessionId: 'child-b', depth: 2, promptTokens: 200, outputTokens: 100, tokens: 300, requests: 4 },
    { sessionId: 'orphan', parentSessionId: 'missing', depth: 0, promptTokens: 5, outputTokens: 0, tokens: 5, requests: 1 },
    { sessionId: 'cycle-a', parentSessionId: 'cycle-b', depth: 1, promptTokens: 7, outputTokens: 3, tokens: 10, requests: 1 },
    { sessionId: 'cycle-b', parentSessionId: 'cycle-a', depth: 1, promptTokens: 14, outputTokens: 6, tokens: 20, requests: 1 },
    { sessionId: 'empty', parentSessionId: '', tokens: 0, requests: 0 },
  ])
  assert.equal(tree.nodes.length, 7, 'rows with no tokens and no requests are dropped by the normalizer')
  assert.deepEqual(tree.roots.map(node => node.key), ['root', 'cycle-b', 'orphan'], 'roots sort by subtree tokens')
  const root = tree.roots[0]
  assert.deepEqual(root.children.map(node => node.key), ['child-b', 'child-a'], 'siblings sort by subtree tokens')
  assert.deepEqual(root.children[0].children.map(node => node.key), ['grand'])
  assert.equal(root.level, 0)
  assert.equal(root.children[0].level, 1)
  assert.equal(root.children[0].children[0].level, 2)
  assert.equal(root.subtree.tokens, 520)
  assert.equal(root.subtree.promptTokens, 340)
  assert.equal(root.subtree.outputTokens, 180)
  assert.equal(root.subtree.requests, 10)
  assert.equal(root.subtree.descendants, 3)
  assert.equal(root.subtree.cache.input, 10)
  assert.equal(root.subtree.cache.read, 80)
  assert.equal(root.subtree.cache.write, 10)
  assert.equal(root.subtree.cacheRate, 0.8, 'the cache rate comes from the subtree aggregate')
  const cycleRoot = tree.roots.find(node => node.key === 'cycle-b')
  assert.equal(cycleRoot.subtree.tokens, 30)
  assert.deepEqual(cycleRoot.children.map(node => node.key), ['cycle-a'], 'the cycle is broken, not dropped')
  assert.deepEqual(tree.roots.map(node => node.key).sort(), ['cycle-b', 'orphan', 'root'])

  assert.equal(subtreeStats({ tokens: 10, requests: 2 }).tokens, 10)
  assert.equal(subtreeStats(null).tokens, 0)
  assert.deepEqual(subtreeStats(null).cacheRate, null)

  assert.deepEqual(sessionTreeRows(tree, {}).map(node => node.key), ['root', 'cycle-b', 'orphan'])
  assert.deepEqual(sessionTreeRows(tree, { root: true }).map(node => node.key), [
    'root',
    'child-b',
    'child-a',
    'cycle-b',
    'orphan',
  ])
  assert.deepEqual(sessionTreeRows(tree, { root: true, 'child-b': true }).map(node => node.key), [
    'root',
    'child-b',
    'grand',
    'child-a',
    'cycle-b',
    'orphan',
  ])
  const reachable = []
  const collect = nodes => {
    for (const node of nodes) {
      reachable.push(node.key)
      collect(node.children)
    }
  }
  collect(tree.roots)
  assert.equal(reachable.length, tree.nodes.length, 'every node is reachable exactly once')
  assert.equal(new Set(reachable).size, tree.nodes.length)
})

test('sessionCacheRate divides cacheRead by all prompt buckets', () => {
  const { sessionCacheRate } = captured.factory(fakeRequire).__test
  assert.equal(sessionCacheRate({ input: 10, read: 80, write: 10 }), 0.8)
  assert.equal(sessionCacheRate({ input: 10, read: 90, write: 0 }), 0.9)
  assert.equal(sessionCacheRate({ input: 0, read: 90, write: 0 }), 1)
  assert.equal(sessionCacheRate({}), null)
  assert.equal(sessionCacheRate(null), null)
  assert.equal(sessionCacheRate(undefined), null)
  assert.equal(sessionCacheRate({ input: 0, read: 0, write: 0 }), null)
  assert.equal(sessionCacheRate({ input: -10, read: 'nope', write: 5 }), 0)
})

test('M2.1 category groups derive from raw categories and prefer the Host map', () => {
  const plugin = captured.factory(fakeRequire)
  const { normalizeSummary, categoryGroup, categoryGroupEntries, categoryGroupLabel, categoryLabel, createTranslator } = plugin.__test
  const locale = {
    bind: () => key => key,
    getSnapshot: () => ({ active: 'zh', locales: [{ id: 'zh', fallback: 'en' }, { id: 'en' }] }),
    subscribe: () => () => {},
  }
  const t = createTranslator(locale, 'zh')

  assert.equal(categoryGroup('user'), 'user')
  assert.equal(categoryGroup('assistant-text'), 'assistant')
  assert.equal(categoryGroup('assistant-other'), 'other')
  assert.equal(categoryGroup('developer-message'), 'developer')
  assert.equal(categoryGroup('reasoning-replay'), 'reasoning')
  assert.equal(categoryGroup('tool-call-args'), 'tool-call')
  assert.equal(categoryGroup('tool-result:other:read'), 'tool-result')
  assert.equal(categoryGroup('tool-result:unknown'), 'tool-result')
  assert.equal(categoryGroup('tool-result:memory'), 'tool-result')
  assert.equal(categoryGroup('tool-result:skill'), 'tool-result')
  assert.equal(categoryGroup('tools:other:exec'), 'tool-decl')
  assert.equal(categoryGroup('tools:memory'), 'memory')
  assert.equal(categoryGroup('injected:memory-snapshot'), 'memory')
  assert.equal(categoryGroup('tools:skill'), 'skill')
  assert.equal(categoryGroup('injected:skill-catalog'), 'skill')
  assert.equal(categoryGroup('tools:agent-teams'), 'agent-teams')
  assert.equal(categoryGroup('tools:history'), 'history')
  assert.equal(categoryGroup('injected:runtime-context'), 'injected')
  assert.equal(categoryGroup('injected:image'), 'injected')
  assert.equal(categoryGroup('injected:auto-review'), 'auto-review')
  assert.equal(categoryGroup('system:base'), 'system')
  assert.equal(categoryGroup('system:mnemon:memory'), 'memory')
  assert.equal(categoryGroup('fallback'), 'other')
  assert.equal(categoryGroup('something-new'), 'other')
  assert.equal(categoryGroup(''), 'other')

  const summary = normalizeSummary({
    totals: { promptTokens: 300, requests: 4 },
    byCategory: {
      user: 10,
      'assistant-text': 20,
      'developer-message': 5,
      'reasoning-replay': 15,
      'tool-call-args': 10,
      'tool-result:other:read': 40,
      'tools:other:exec': 30,
      'tools:memory': 12,
      'tool-result:memory': 8,
      'injected:memory-snapshot': 20,
      'tools:skill': 6,
      'tool-result:skill': 4,
      'injected:skill-catalog': 5,
      'tools:agent-teams': 3,
      'tools:history': 2,
      'injected:runtime-context': 7,
      'injected:auto-review': 25,
      'system:base': 50,
      fallback: 1,
    },
  })
  assert.deepEqual(summary.byCategoryGroup, {
    user: 10,
    assistant: 20,
    developer: 5,
    reasoning: 15,
    'tool-call': 10,
    'tool-result': 52,
    'tool-decl': 30,
    memory: 32,
    skill: 11,
    'agent-teams': 3,
    history: 2,
    injected: 7,
    'auto-review': 25,
    system: 50,
    other: 1,
  })
  const fromHost = normalizeSummary({
    byCategory: { user: 1000 },
    byCategoryGroup: { memory: 600, skill: 400 },
  })
  assert.deepEqual(fromHost.byCategoryGroup, { memory: 600, skill: 400 }, 'the Host group map wins over the fallback')

  const entries = categoryGroupEntries({ system: 5, memory: 10, user: 20, skill: 7, injected: 3, 'auto-review': 4 }, t)
  assert.deepEqual(entries.map(entry => entry.key), ['user', 'memory', 'skill', 'injected', 'auto-review', 'system'])
  assert.deepEqual(entries.map(entry => entry.label), ['用户', '记忆', '技能', '注入上下文', '自动审查', '系统提示'])
  assert.equal(entries.findIndex(entry => entry.key === 'auto-review'), 4, 'auto-review sits after injected and before system')
  assert.deepEqual(categoryGroupEntries({ injected: 0 }, t), [], 'zero-token groups stay hidden')
  assert.deepEqual(categoryGroupEntries({ unknownGroup: 4 }, t).map(entry => entry.key), ['unknownGroup'])
  assert.deepEqual(categoryGroupEntries(null, t), [])

  assert.equal(categoryLabel(t, 'tools:memory'), '记忆工具声明')
  assert.equal(categoryLabel(t, 'tools:skill'), '技能工具声明')
  assert.equal(categoryLabel(t, 'tools:agent-teams'), 'Agent Teams 工具声明')
  assert.equal(categoryLabel(t, 'tools:history'), '历史工具声明')
  assert.equal(categoryLabel(t, 'tool-result:memory'), '记忆工具结果')
  assert.equal(categoryLabel(t, 'tool-result:skill'), '技能工具结果')
  assert.equal(categoryLabel(t, 'injected:skill-catalog'), '技能目录')
  assert.equal(categoryLabel(t, 'injected:skill-invocation'), '技能调用')
  assert.equal(categoryLabel(t, 'injected:memory-recall'), '记忆注入')
  assert.equal(categoryLabel(t, 'injected:auto-review'), '自动审查输入')
  assert.equal(categoryLabel(t, 'injected:auto-review-extra'), '注入 · auto-review-extra', 'only the exact raw category gets the friendly label')
  assert.equal(categoryLabel(t, 'system:mnemon:memory'), 'Mnemon 系统段')
  assert.equal(categoryLabel(t, 'system:skills'), '系统提示 · skills')
  assert.equal(categoryLabel(t, 'tools:other:exec'), '工具声明 · other:exec')
  assert.equal(categoryLabel(t, 'injected:notices'), '注入 · notices')
  assert.equal(categoryLabel(t, 'something-new'), 'something-new')
  for (const group of [
    'user', 'assistant', 'developer', 'reasoning', 'tool-call', 'tool-result', 'tool-decl',
    'memory', 'skill', 'agent-teams', 'history', 'injected', 'auto-review', 'system', 'other',
  ]) {
    assert.notEqual(categoryGroupLabel(t, group), `categoryGroup.${group}`, `group label ${group}`)
  }
  assert.equal(categoryGroupLabel(t, 'auto-review'), '自动审查')
  const enLocale = {
    bind: () => key => key,
    getSnapshot: () => ({ active: 'en' }),
    subscribe: () => () => {},
  }
  assert.equal(categoryGroupLabel(createTranslator(enLocale, 'en'), 'auto-review'), 'Auto review')
})

test('M2.1 session tree and grouped stacked bar render in the dashboard', () => {
  const plugin = captured.factory(fakeRequire)
  const { normalizeSummary, createTranslator, components } = plugin.__test
  const textOf = node => {
    if (node === null || node === undefined || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(textOf).join(' ')
    if (typeof node === 'function') return textOf(node({}))
    if (typeof node === 'object') {
      if (typeof node.type === 'function') return textOf(node.type(node.props))
      return textOf(node.children)
    }
    return ''
  }
  const locale = {
    bind: () => key => key,
    getSnapshot: () => ({ active: 'zh', locales: [{ id: 'zh', fallback: 'en' }, { id: 'en' }] }),
    subscribe: () => () => {},
  }
  const t = createTranslator(locale, 'zh')
  const summary = normalizeSummary({
    totals: { promptTokens: 2000, outputTokens: 500, totalTokens: 2500, requests: 4 },
    byPurpose: { chat: { requests: 4, promptTokens: 2000, outputTokens: 500 } },
    byCategory: { 'tools:memory': 1200, 'tool-result:skill': 800 },
    bySession: [
      { sessionId: 'root-session', parentSessionId: null, depth: 0, promptTokens: 800, outputTokens: 200, tokens: 1000, requests: 2, cache: { input: 100, read: 800, write: 100 }, cost: { amount: 0.12, currency: 'CNY', priced: true } },
      { sessionId: 'child-only', parentSessionId: 'root-session', depth: 1, promptTokens: 500, outputTokens: 200, tokens: 700, requests: 1, cache: { input: 50, read: 450, write: 0 }, cost: { amount: 0.03, currency: 'CNY', priced: true } },
      { sessionId: 'grand-child', parentSessionId: 'child-only', depth: 2, promptTokens: 200, outputTokens: 100, tokens: 300, requests: 1 },
    ],
  })
  const collapsed = textOf(components.SessionsTab({ summary, t, sessionTitles: null }))
  for (const expected of ['会话 Top', '缓存率', '默认仅显示根会话', 'root-session', '输入', '输出', '1.5K', '83.3%', '¥0.150']) {
    assert.ok(collapsed.includes(expected), `collapsed tree renders ${expected}`)
  }
  assert.ok(!collapsed.includes('child-only'), 'children stay hidden while collapsed')
  assert.ok(!collapsed.includes('grand-child'), 'descendants stay hidden while collapsed')
  assert.ok(collapsed.includes('▸'), 'a collapsed parent shows the chevron')

  const expandedElement = components.SessionsTab({
    summary,
    t,
    sessionTitles: null,
    session: { expanded: { 'root-session': true }, onToggle() {} },
  })
  const expanded = textOf(expandedElement)
  assert.ok(expanded.includes('child-only'), 'expanding a root shows its direct child')
  assert.ok(expanded.includes('▾'), 'an expanded parent shows the open chevron')
  assert.ok(expanded.includes('子代理'), 'child rows keep the subagent badge')
  assert.ok(!expanded.includes('grand-child'), 'nested children stay hidden until their parent expands')
  const findRow = (node, key) => {
    let found = null
    const walk = current => {
      if (current === null || typeof current !== 'object' || found !== null) return
      if (Array.isArray(current)) {
        for (const item of current) walk(item)
        return
      }
      if (typeof current.type === 'function') {
        walk(current.type(current.props))
        return
      }
      if (current.props !== undefined && current.props['data-session-row'] === key) {
        found = current
        return
      }
      const children = Array.isArray(current.children)
        ? current.children
        : current.props !== undefined && Array.isArray(current.props.children) ? current.props.children : []
      for (const child of children) walk(child)
    }
    walk(node)
    return found
  }
  const childRow = findRow(expandedElement, 'child-only')
  assert.ok(childRow !== null, 'the expanded child row is rendered')
  const childCells = (childRow.props !== undefined && Array.isArray(childRow.props.children)
    ? childRow.props.children
    : Array.isArray(childRow.children) ? childRow.children : []).map(cell => textOf(cell))
  assert.deepEqual(childCells, ['▸ 1 child-only 子代理', '2', '700', '300', '90.0%', '¥0.030'], 'child row shows split subtree input/output cells')

  const nested = textOf(components.SessionsTab({
    summary,
    t,
    sessionTitles: null,
    session: { expanded: { 'root-session': true, 'child-only': true }, onToggle() {} },
  }))
  assert.ok(nested.includes('grand-child'), 'nested expansion shows grandchildren')

  const grouped = normalizeSummary({
    totals: { promptTokens: 1000, requests: 1 },
    byCategoryGroup: {
      user: 10,
      assistant: 20,
      developer: 5,
      reasoning: 15,
      'tool-call': 10,
      'tool-result': 40,
      'tool-decl': 30,
      memory: 100,
      skill: 80,
      'agent-teams': 7,
      history: 5,
      injected: 25,
      'auto-review': 12,
      system: 50,
      other: 3,
    },
  })
  const groupedText = textOf(components.OverviewTab({ summary: grouped, meta: null, t, channel: '' }))
  for (const label of [
    '用户', '助手', '开发者', '推理重放', '工具调用参数', '工具结果', '工具声明',
    '记忆', '技能', 'Agent Teams', '历史', '注入上下文', '自动审查', '系统提示', '其他',
  ]) {
    assert.ok(groupedText.includes(label), `grouped stacked bar renders ${label}`)
  }

  const preferred = normalizeSummary({
    totals: { promptTokens: 1000, requests: 1 },
    byCategory: { user: 1000 },
    byCategoryGroup: { memory: 1000 },
  })
  const preferredText = textOf(components.OverviewTab({ summary: preferred, meta: null, t, channel: '' }))
  assert.ok(preferredText.includes('记忆'), 'the Host byCategoryGroup map drives the bar')
  assert.ok(!preferredText.includes('用户'), 'the raw category is not re-grouped when the Host map exists')

  const derived = normalizeSummary({
    totals: { promptTokens: 1000, requests: 1 },
    byCategory: { 'tools:memory': 600, 'injected:memory-snapshot': 400 },
  })
  const derivedText = textOf(components.OverviewTab({ summary: derived, meta: null, t, channel: '' }))
  assert.ok(derivedText.includes('记忆'), 'a pre-M2.1 Host still renders the derived memory group')
  assert.ok(derivedText.includes('1K'), 'the derived memory group keeps its compact total')
})

test('M2.1 locale keys exist in both dictionaries', () => {
  const { locales } = captured.factory(fakeRequire).__test
  const keys = [
    'table.sessions.cacheRate',
    'table.sessions.expand',
    'table.sessions.collapse',
    'table.sessions.children',
    'table.sessions.rootsOnlyHint',
    'category.tools-memory',
    'category.tools-skill',
    'category.tools-agent-teams',
    'category.tools-history',
    'category.tool-result-memory',
    'category.tool-result-skill',
    'category.injected-skill-catalog',
    'category.injected-skill-invocation',
    'category.injected-memory',
    'category.injected-auto-review',
    'category.system-mnemon',
    'categoryGroup.user',
    'categoryGroup.assistant',
    'categoryGroup.developer',
    'categoryGroup.reasoning',
    'categoryGroup.tool-call',
    'categoryGroup.tool-result',
    'categoryGroup.tool-decl',
    'categoryGroup.memory',
    'categoryGroup.skill',
    'categoryGroup.agent-teams',
    'categoryGroup.history',
    'categoryGroup.injected',
    'categoryGroup.auto-review',
    'categoryGroup.system',
    'categoryGroup.other',
  ]
  for (const key of keys) {
    assert.ok(Object.hasOwn(locales.en, key), `en.${key} exists`)
    assert.ok(Object.hasOwn(locales.zh, key), `zh.${key} exists`)
    assert.equal(typeof locales.en[key], 'string')
    assert.equal(typeof locales.zh[key], 'string')
  }
  assert.equal(locales.zh['table.sessions.cacheRate'], '缓存率')
  assert.equal(locales.zh['categoryGroup.memory'], '记忆')
  assert.equal(locales.zh['categoryGroup.skill'], '技能')
  assert.equal(locales.zh['category.tools-memory'], '记忆工具声明')
  assert.equal(locales.zh['category.injected-memory'], '记忆注入')
  assert.equal(locales.zh['category.injected-auto-review'], '自动审查输入')
  assert.equal(locales.en['category.injected-auto-review'], 'Auto-review input')
  assert.equal(locales.zh['categoryGroup.auto-review'], '自动审查')
  assert.equal(locales.en['categoryGroup.auto-review'], 'Auto review')
  assert.equal(locales.en['categoryGroup.agent-teams'], 'Agent Teams')
})

test('models table splits input/output and legacy sessions render unavailable splits', () => {
  const plugin = captured.factory(fakeRequire)
  const { normalizeSummary, createTranslator, components, buildSessionTree } = plugin.__test
  const textOf = node => {
    if (node === null || node === undefined || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(textOf).join(' ')
    if (typeof node === 'function') return textOf(node({}))
    if (typeof node === 'object') {
      if (typeof node.type === 'function') return textOf(node.type(node.props))
      return textOf(node.children)
    }
    return ''
  }
  const locale = {
    bind: () => key => key,
    getSnapshot: () => ({ active: 'zh', locales: [{ id: 'zh', fallback: 'en' }, { id: 'en' }] }),
    subscribe: () => () => {},
  }
  const t = createTranslator(locale, 'zh')
  const summary = normalizeSummary({
    totals: { promptTokens: 1500, outputTokens: 500, totalTokens: 2000, requests: 2 },
    byModel: [{
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      requests: 2,
      promptTokens: 1000,
      outputTokens: 400,
      tokens: 1400,
      cost: { amount: 0.1, currency: 'CNY', priced: true },
    }],
    bySession: [{ sessionId: 'legacy-session', tokens: 1234, requests: 2 }],
  })
  const dashboard = components.OverviewTab({ summary, meta: null, t, channel: '' })
  assert.ok(textOf(dashboard).includes('—'), 'a legacy session row renders unavailable split cells')
  const tree = buildSessionTree(summary.bySession)
  assert.equal(tree.roots[0].subtree.splitAvailable, false)
  assert.equal(tree.roots[0].subtree.tokens, 1234)

  const collect = (node, type, found) => {
    if (node === null || typeof node !== 'object') return found
    if (Array.isArray(node)) {
      for (const item of node) collect(item, type, found)
      return found
    }
    if (typeof node.type === 'function') {
      collect(node.type(node.props), type, found)
      return found
    }
    if (node.type === type) found.push(node)
    const children = Array.isArray(node.children)
      ? node.children
      : node.props !== undefined && Array.isArray(node.props.children) ? node.props.children : []
    for (const child of children) collect(child, type, found)
    return found
  }
  const tables = collect(dashboard, 'table', [])
  const modelTable = tables.find(table => textOf(table).includes('Provider'))
  assert.ok(modelTable !== undefined, 'the models table is rendered')
  const headers = collect(modelTable, 'th', []).map(cell => textOf(cell))
  assert.deepEqual(headers, ['Provider', '模型', '请求数', '输入', '输出', '费用'])
  const cells = collect(modelTable, 'td', []).map(cell => textOf(cell))
  assert.deepEqual(cells, ['deepseek-official', 'deepseek-flash', '2', '1K', '400', '¥0.100'])
})

test('M2.4 Web API card shows observed tool calls and the estimated cost', () => {
  const plugin = captured.factory(fakeRequire)
  const { normalizeSummary, normalizeWebApi, createTranslator, components } = plugin.__test
  const textOf = node => {
    if (node === null || node === undefined || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(textOf).join(' ')
    if (typeof node === 'function') return textOf(node({}))
    if (typeof node === 'object') {
      if (typeof node.type === 'function') return textOf(node.type(node.props))
      return textOf(node.children)
    }
    return ''
  }
  const localeZh = {
    bind: () => key => key,
    getSnapshot: () => ({ active: 'zh' }),
    subscribe: () => () => {},
  }
  const localeEn = {
    bind: () => key => key,
    getSnapshot: () => ({ active: 'en' }),
    subscribe: () => () => {},
  }
  const tZh = createTranslator(localeZh, 'zh')
  const tEn = createTranslator(localeEn, 'en')
  const summary = normalizeSummary({
    totals: { requests: 3 },
    webApi: {
      search: { ok: 3, failed: 1, total: 4 },
      fetch: { ok: 2, failed: 0, total: 2 },
      calls: { ok: 5, failed: 1, total: 6 },
      cost: { amount: 0.025, currency: 'CNY', priced: true },
    },
  })
  const zhText = textOf(components.OverviewTab({ summary, meta: null, t: tZh, channel: '' }))
  for (const expected of ['搜索 / 抓取', '6 次', '搜索 4 · 抓取 2', '失败 1', '估算 0.025 CNY']) {
    assert.ok(zhText.includes(expected), `zh card renders ${expected}: ${zhText.slice(0, 400)}`)
  }
  const enText = textOf(components.OverviewTab({ summary, meta: null, t: tEn, channel: '' }))
  for (const expected of ['Search & fetch', '6 calls', 'Search 4 · Fetch 2', 'Failed 1', 'Estimated 0.025 CNY']) {
    assert.ok(enText.includes(expected), `en card renders ${expected}`)
  }

  // Failed calls alone are counted but not billable.
  const failedOnly = normalizeSummary({
    webApi: {
      search: { ok: 0, failed: 2, total: 2 },
      fetch: { ok: 0, failed: 0, total: 0 },
      cost: { amount: 0, currency: 'CNY', priced: false },
    },
  })
  const failedText = textOf(components.OverviewTab({ summary: failedOnly, meta: null, t: tZh, channel: '' }))
  assert.ok(failedText.includes('未产生成功调用'), failedText.slice(0, 400))
  assert.ok(failedText.includes('失败 2'))
  assert.ok(!failedText.includes('失败 0'), 'a zero failure count is not shown')

  // A pre-M2.4 Host omits summary.webApi entirely: the card renders zeroed.
  const missing = normalizeSummary({ totals: { requests: 1 } })
  const missingText = textOf(components.OverviewTab({ summary: missing, meta: null, t: tZh, channel: '' }))
  for (const expected of ['搜索 / 抓取', '0 次', '搜索 0 · 抓取 0', '未产生成功调用']) {
    assert.ok(missingText.includes(expected), `missing webApi still renders ${expected}`)
  }
  assert.ok(!missingText.includes('失败 0'))

  // `calls` is derived from search/fetch when the Host omits it.
  assert.deepEqual(normalizeWebApi({
    search: { ok: 2, failed: 1, total: 3 },
    fetch: { ok: 1, failed: 0, total: 1 },
  }).calls, { ok: 3, failed: 1, total: 4 })
  assert.deepEqual(normalizeWebApi(null).cost, { amount: 0, currency: 'CNY', priced: false })
})

test('M2.4 footnote explains observed Web API calls and estimate limits', () => {
  const { normalizeSummary, createTranslator, components } = captured.factory(fakeRequire).__test
  const textOf = node => {
    if (node === null || node === undefined || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(textOf).join(' ')
    if (typeof node === 'function') return textOf(node({}))
    if (typeof node === 'object') {
      if (typeof node.type === 'function') return textOf(node.type(node.props))
      return textOf(node.children)
    }
    return ''
  }
  const makeT = language => createTranslator({
    bind: () => key => key,
    getSnapshot: () => ({ active: language }),
    subscribe: () => () => {},
  }, language)
  const summary = normalizeSummary({ totals: { requests: 1 } })
  const zhFootnote = textOf(components.Footnote({ summary, meta: null, t: makeT('zh'), channel: '' }))
  for (const expected of ['web_search', 'web_fetch', '成功调用按 provider 的按次定价计费', '每千次单价估算', '实际账单可能不同']) {
    assert.ok(zhFootnote.includes(expected), `zh footnote states ${expected}`)
  }
  const enFootnote = textOf(components.Footnote({ summary, meta: null, t: makeT('en'), channel: '' }))
  for (const expected of ['web_search', 'web_fetch', 'per-request pricing', 'per-1,000 rates', 'provider-side billing may differ']) {
    assert.ok(enFootnote.includes(expected), `en footnote states ${expected}`)
  }
})

test('M2.4 webApiPricing normalizes, serializes and validates with field paths', () => {
  const { formFromConfig, configPatchFromForm, defaultWebApiPricing } = captured.factory(fakeRequire).__test
  assert.deepEqual({ ...defaultWebApiPricing }, { searchPerThousand: 5, fetchPerThousand: 5, currency: 'CNY' })

  const defaults = formFromConfig({})
  assert.equal(defaults.webApiSearchPerThousand, '5')
  assert.equal(defaults.webApiFetchPerThousand, '5')
  assert.equal(defaults.webApiCurrency, 'CNY')
  const defaultPatch = configPatchFromForm(defaults)
  assert.equal(defaultPatch.ok, true, defaultPatch.errors?.map(error => `${error.field}:${error.code}`).join(', '))
  assert.deepEqual(defaultPatch.patch.webApiPricing, { searchPerThousand: 5, fetchPerThousand: 5, currency: 'CNY' })

  const form = formFromConfig({
    webApiPricing: { searchPerThousand: 2.5, fetchPerThousand: 0, currency: 'USD' },
  })
  assert.equal(form.webApiSearchPerThousand, '2.5')
  assert.equal(form.webApiFetchPerThousand, '0')
  assert.equal(form.webApiCurrency, 'USD')
  form.webApiCurrency = '  usd  '
  const built = configPatchFromForm(form)
  assert.equal(built.ok, true)
  assert.deepEqual(built.patch.webApiPricing, { searchPerThousand: 2.5, fetchPerThousand: 0, currency: 'usd' })
  assert.equal(built.patch.retainRequestDays, 30, 'the rest of the patch is unchanged')

  const broken = formFromConfig({})
  broken.webApiSearchPerThousand = ''
  broken.webApiFetchPerThousand = '-1'
  broken.webApiCurrency = '   '
  const failed = configPatchFromForm(broken)
  assert.equal(failed.ok, false)
  assert.equal(failed.patch, null)
  const codes = failed.errors.map(error => `${error.field}:${error.code}`)
  assert.ok(codes.includes('webApiPricing.searchPerThousand:webApi-number'), codes.join(', '))
  assert.ok(codes.includes('webApiPricing.fetchPerThousand:webApi-number'), codes.join(', '))
  assert.ok(codes.includes('webApiPricing.currency:webApi-currency'), codes.join(', '))

  for (const bad of ['abc', 'Infinity', '-0.5', '  ']) {
    const candidate = formFromConfig({})
    candidate.webApiSearchPerThousand = bad
    assert.equal(configPatchFromForm(candidate).ok, false, `${JSON.stringify(bad)} is rejected`)
  }
})

test('M2.4 config panel renders the Web API pricing group', () => {
  const plugin = captured.factory(fakeRequire)
  const { normalizeConfigInfo, createTranslator, components } = plugin.__test
  const textOf = node => {
    if (node === null || node === undefined || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(textOf).join(' ')
    if (typeof node === 'function') return textOf(node({}))
    if (typeof node === 'object') {
      if (typeof node.type === 'function') return textOf(node.type(node.props))
      return textOf(node.children)
    }
    return ''
  }
  const flatten = node => {
    const out = []
    const visit = value => {
      if (value === null || value === undefined || typeof value !== 'object') return
      if (Array.isArray(value)) {
        for (const item of value) visit(item)
        return
      }
      out.push(value)
      if (typeof value.type === 'function') visit(value.type(value.props))
      else visit(value.children)
    }
    visit(node)
    return out
  }
  const locale = {
    bind: () => key => key,
    getSnapshot: () => ({ active: 'zh' }),
    subscribe: () => () => {},
  }
  const t = createTranslator(locale, 'zh')
  const configInfo = normalizeConfigInfo({
    values: {
      webApiPricing: { searchPerThousand: 2.5, fetchPerThousand: 0, currency: 'USD' },
      rpcChannel: '/token-attribution',
    },
    editable: true,
    fields: { webApiPricing: { type: 'object' } },
  })
  const panel = components.ConfigPanel({
    t,
    rpc: { async call() { return { ok: true, value: {} } }, getChannel: () => '/token-attribution', setChannel() {} },
    configInfo,
    configStatus: 'ready',
    configError: null,
    meta: null,
    migration: null,
    dataInfo: null,
    onClose() {},
    onReload() {},
    onSaved() {},
  })
  const text = textOf(panel)
  for (const expected of [
    '搜索 / 抓取估算',
    '搜索单价 / 千次',
    '抓取单价 / 千次',
    '官方默认 5 元 / 1000 次成功请求',
    '币种',
    '估算金额旁的币种代码',
  ]) {
    assert.ok(text.includes(expected), `config panel renders ${expected}`)
  }
  const inputs = flatten(panel).filter(node => node.type === 'input')
  assert.ok(inputs.some(node => node.props.value === '2.5'), 'search rate is normalized into the form')
  assert.ok(inputs.some(node => node.props.value === '0'), 'a zero fetch rate stays editable')
  assert.ok(inputs.some(node => node.props.value === 'USD'), 'currency is normalized into the form')
})

test('M2.4 locale keys exist in both dictionaries', () => {
  const { locales } = captured.factory(fakeRequire).__test
  const keys = [
    'card.webApi',
    'card.webApiValue',
    'card.webApiUnit',
    'card.webApiTotalTitle',
    'card.webApiCounts',
    'card.webApiFailed',
    'card.webApiCost',
    'card.webApiNoBillable',
    'footnote.webApi',
    'config.section.webApi',
    'config.webApiPricing.hint',
    'config.webApiPricing.searchPerThousand',
    'config.webApiPricing.fetchPerThousand',
    'config.webApiPricing.currency',
    'config.webApiPricing.currencyHint',
    'config.error.webApi-number',
    'config.error.webApi-currency',
  ]
  for (const key of keys) {
    assert.ok(Object.hasOwn(locales.en, key), `en.${key} exists`)
    assert.ok(Object.hasOwn(locales.zh, key), `zh.${key} exists`)
    assert.equal(typeof locales.en[key], 'string')
    assert.equal(typeof locales.zh[key], 'string')
    assert.ok(locales.en[key].length > 0)
    assert.ok(locales.zh[key].length > 0)
  }
  assert.equal(locales.zh['card.webApi'], '搜索 / 抓取')
  assert.equal(locales.zh['card.webApiUnit'], '次')
  assert.equal(locales.zh['card.webApiNoBillable'], '未产生成功调用')
  assert.equal(locales.zh['config.section.webApi'], '搜索 / 抓取估算')
  assert.ok(locales.zh['config.webApiPricing.hint'].includes('官方默认 5 元 / 1000 次成功请求'))
  assert.ok(locales.en['config.webApiPricing.hint'].includes('not a provider bill'))
})

test('M2.5 normalizeWebApi normalizes per-session rows and drops malformed ones', () => {
  const { normalizeWebApi, normalizeSummary } = captured.factory(fakeRequire).__test
  // Pre-M2.5 Hosts omit the array entirely; guard every unusable shape.
  assert.deepEqual(normalizeWebApi(null).bySession, [])
  assert.deepEqual(normalizeWebApi({}).bySession, [])
  assert.deepEqual(normalizeWebApi({ bySession: 'nope' }).bySession, [])
  assert.deepEqual(normalizeWebApi({ bySession: { 0: { sessionId: 'x' } } }).bySession, [])

  // Malformed rows (non-objects, missing/blank/numeric ids) are dropped; a
  // row with a usable id survives even when every counter is absent.
  const normalized = normalizeWebApi({
    bySession: [
      null,
      'row',
      42,
      {},
      { sessionId: '' },
      { sessionId: '   ' },
      { sessionId: 7 },
      { sessionId: '  sess-a  ', search: { ok: 2, failed: 1 }, fetch: { ok: 1 } },
      { sessionId: 'sess-zero' },
      {
        sessionId: 'sess-b',
        search: { ok: 1, failed: 0, total: 1 },
        fetch: { ok: 0, failed: 2, total: 2 },
        calls: { ok: 1, failed: 2, total: 3 },
        cost: { amount: 0.02, currency: 'USD', priced: true, unpricedRequests: 1 },
      },
      { sessionId: 'unknown', search: { ok: 4, total: 4 } },
    ],
  }).bySession
  assert.equal(normalized.length, 4, JSON.stringify(normalized))
  assert.deepEqual(normalized.map(row => row.sessionId), ['unknown', 'sess-a', 'sess-b', 'sess-zero'])

  const partial = normalized.find(row => row.sessionId === 'sess-a')
  assert.deepEqual(partial.search, { ok: 2, failed: 1, total: 3 })
  assert.deepEqual(partial.fetch, { ok: 1, failed: 0, total: 1 })
  assert.deepEqual(partial.calls, { ok: 3, failed: 1, total: 4 })
  assert.equal(partial.cost, null, 'an absent row cost stays unpriced')

  const full = normalized.find(row => row.sessionId === 'sess-b')
  assert.deepEqual(full.search, { ok: 1, failed: 0, total: 1 })
  assert.deepEqual(full.fetch, { ok: 0, failed: 2, total: 2 })
  assert.deepEqual(full.calls, { ok: 1, failed: 2, total: 3 }, 'an explicit calls counter wins over derivation')
  assert.deepEqual(full.cost, { amount: 0.02, currency: 'USD', priced: true, unpricedRequests: 1 })

  const zero = normalized.find(row => row.sessionId === 'sess-zero')
  assert.deepEqual(zero.calls, { ok: 0, failed: 0, total: 0 }, 'zero counters are valid, not malformed')

  // A bare number cost uses the shared cost normalizer and the row currency.
  const bareCost = normalizeWebApi({ bySession: [{ sessionId: 'bare', cost: 0.5, currency: 'EUR' }] }).bySession[0].cost
  assert.deepEqual(bareCost, { amount: 0.5, currency: 'EUR', priced: true, unpricedRequests: 0 })

  // Sorted by calls desc, then search desc, then id, and capped at the
  // 100-row contract (the Host uses the same order).
  const many = Array.from({ length: 105 }, (_, index) => ({
    sessionId: `many-${String(index).padStart(3, '0')}`,
    search: { ok: index + 1, total: index + 1 },
  }))
  const capped = normalizeWebApi({ bySession: many }).bySession
  assert.equal(capped.length, 100)
  assert.equal(capped[0].sessionId, 'many-104')
  assert.equal(capped[0].calls.total, 105)
  assert.equal(capped[99].sessionId, 'many-005')

  // normalizeSummary carries the per-session rows through to the dashboard.
  const summary = normalizeSummary({
    webApi: { bySession: [{ sessionId: 'sess-a', search: { ok: 2, total: 2 }, cost: { amount: 0.01, currency: 'CNY', priced: true } }] },
  })
  assert.equal(summary.webApi.bySession.length, 1)
  assert.equal(summary.webApi.bySession[0].sessionId, 'sess-a')
  assert.deepEqual(normalizeSummary({}).webApi.bySession, [], 'a pre-M2.5 summary defaults to no rows')
})

test('M2.5 Web API sessions section resolves titles and the unknown fallback', () => {
  const plugin = captured.factory(fakeRequire)
  const { normalizeSummary, createTranslator, components } = plugin.__test
  const textOf = node => {
    if (node === null || node === undefined || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(textOf).join(' ')
    if (typeof node === 'function') return textOf(node({}))
    if (typeof node === 'object') {
      if (typeof node.type === 'function') return textOf(node.type(node.props))
      return textOf(node.children)
    }
    return ''
  }
  const flatten = node => {
    const out = []
    const visit = value => {
      if (value === null || value === undefined || typeof value !== 'object') return
      if (Array.isArray(value)) {
        for (const item of value) visit(item)
        return
      }
      out.push(value)
      if (typeof value.type === 'function') visit(value.type(value.props))
      else visit(value.children)
    }
    visit(node)
    return out
  }
  const makeT = language => createTranslator({
    bind: () => key => key,
    getSnapshot: () => ({ active: language, locales: [{ id: language, fallback: 'en' }] }),
    subscribe: () => () => {},
  }, language)
  const tZh = makeT('zh')
  const tEn = makeT('en')
  const summary = normalizeSummary({
    totals: { requests: 2 },
    webApi: {
      search: { ok: 6, failed: 1, total: 7 },
      fetch: { ok: 2, failed: 1, total: 3 },
      calls: { ok: 8, failed: 2, total: 10 },
      cost: { amount: 0.05, currency: 'CNY', priced: true },
      bySession: [
        {
          sessionId: 'sess-titled-0123456789',
          search: { ok: 4, failed: 1, total: 5 },
          fetch: { ok: 1, failed: 1, total: 2 },
          calls: { ok: 5, failed: 2, total: 7 },
          cost: { amount: 0.012, currency: 'CNY', priced: true },
        },
        {
          sessionId: 'sess-untitled',
          search: { ok: 1, total: 1 },
          calls: { ok: 1, failed: 0, total: 1 },
          cost: { amount: 0.005, currency: 'CNY', priced: true },
        },
        {
          sessionId: 'unknown',
          search: { ok: 2, total: 2 },
          calls: { ok: 2, failed: 0, total: 2 },
          cost: { amount: 0.01, currency: 'CNY', priced: true },
        },
      ],
    },
  })
  const sessionTitles = { 'sess-titled-0123456789': { displayTitle: '重构鉴权中间件', title: '旧标题' } }
  const dashboard = components.OverviewTab({ summary, meta: null, t: tZh, channel: '', sessionTitles })
  const text = textOf(dashboard)
  for (const expected of ['搜索 / 抓取会话', '会话', '搜索', '抓取', '费用', '按该范围内的搜索/抓取调用排序']) {
    assert.ok(text.includes(expected), `zh section renders ${expected}`)
  }
  assert.ok(text.indexOf('搜索 / 抓取会话') > text.indexOf('会话 Top'), 'the section sits after the session Top 5')
  assert.ok(text.indexOf('搜索 / 抓取会话') < text.indexOf('模型 Top'), 'the section sits before the model Top 5')

  const nodes = flatten(dashboard)
  const titledNode = nodes.find(node => node.props?.['data-session-id'] === 'sess-titled-0123456789')
  assert.ok(titledNode, 'the titled session cell is rendered')
  assert.equal(titledNode.type, 'span')
  assert.equal(titledNode.props['data-dsh-part'], 'webapi-session')
  assert.equal(titledNode.props.children, '重构鉴权中间件')
  assert.equal(titledNode.props.title, 'sess-titled-0123456789 · 重构鉴权中间件')

  const untitledNode = nodes.find(node => node.props?.['data-session-id'] === 'sess-untitled')
  assert.ok(untitledNode, 'a session without a title keeps a short-id cell')
  assert.equal(untitledNode.type, 'code')
  assert.equal(untitledNode.props.children, 'sess-untitl…')
  assert.equal(untitledNode.props.title, 'sess-untitled')

  const unknownNode = nodes.find(node => node.props?.['data-session-id'] === 'unknown')
  assert.ok(unknownNode, 'the unknown session id gets the dedicated fallback label')
  assert.equal(unknownNode.props.children, '未知会话')

  const rowText = title => {
    const row = nodes.filter(node => node.type === 'tr').find(node => textOf(node).includes(title))
    assert.ok(row, `row for ${title} exists`)
    return textOf(row)
  }
  assert.equal(rowText('重构鉴权中间件'), '重构鉴权中间件 5 2 ¥0.012', 'columns show session, search, fetch and cost')
  assert.equal(rowText('未知会话'), '未知会话 2 0 ¥0.010')
  assert.equal(rowText('sess-untitl…'), 'sess-untitl… 1 0 ¥0.005')

  const enText = textOf(components.OverviewTab({ summary, meta: null, t: tEn, channel: '', sessionTitles }))
  for (const expected of ['Search & fetch sessions', 'Session', 'Search', 'Fetch', 'Cost', 'Unknown session', '重构鉴权中间件']) {
    assert.ok(enText.includes(expected), `en section renders ${expected}`)
  }
})

test('M2.5 Web API sessions section hides when empty or all zero', () => {
  const { normalizeSummary, createTranslator, components } = captured.factory(fakeRequire).__test
  const textOf = node => {
    if (node === null || node === undefined || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(textOf).join(' ')
    if (typeof node === 'function') return textOf(node({}))
    if (typeof node === 'object') {
      if (typeof node.type === 'function') return textOf(node.type(node.props))
      return textOf(node.children)
    }
    return ''
  }
  const t = createTranslator({
    bind: () => key => key,
    getSnapshot: () => ({ active: 'zh', locales: [{ id: 'zh', fallback: 'en' }, { id: 'en' }] }),
    subscribe: () => () => {},
  }, 'zh')
  const render = summary => textOf(components.OverviewTab({ summary, meta: null, t, channel: '' }))

  assert.ok(!render(normalizeSummary({ totals: { requests: 1 } })).includes('搜索 / 抓取会话'), 'a pre-M2.5 Host stays hidden')
  assert.ok(!render(normalizeSummary({ webApi: {} })).includes('搜索 / 抓取会话'), 'an empty bySession array stays hidden')
  const zeroRows = normalizeSummary({
    webApi: {
      bySession: [
        { sessionId: 'sess-zero', search: { ok: 0, failed: 0, total: 0 } },
        { sessionId: 'unknown', fetch: { total: 0 } },
      ],
    },
  })
  assert.ok(!render(zeroRows).includes('搜索 / 抓取会话'), 'rows without any call do not open an empty section')

  const failedOnly = normalizeSummary({
    webApi: {
      bySession: [{
        sessionId: 'sess-failed',
        search: { ok: 0, failed: 2, total: 2 },
        cost: { amount: 0, currency: 'CNY', priced: false },
      }],
    },
  })
  const failedText = render(failedOnly)
  assert.ok(failedText.includes('搜索 / 抓取会话'), 'a failed call still counts as search/fetch activity')
  assert.ok(failedText.includes('sess-failed 2 0 —'), 'a failure-only session is not billable and renders an em dash')
})

test('M2.5 Web API sessions fold to ten rows and expand to all', () => {
  const { normalizeSummary, createTranslator, components } = captured.factory(fakeRequire).__test
  const textOf = node => {
    if (node === null || node === undefined || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(textOf).join(' ')
    if (typeof node === 'function') return textOf(node({}))
    if (typeof node === 'object') {
      if (typeof node.type === 'function') return textOf(node.type(node.props))
      return textOf(node.children)
    }
    return ''
  }
  const flatten = node => {
    const out = []
    const visit = value => {
      if (value === null || value === undefined || typeof value !== 'object') return
      if (Array.isArray(value)) {
        for (const item of value) visit(item)
        return
      }
      out.push(value)
      if (typeof value.type === 'function') visit(value.type(value.props))
      else visit(value.children)
    }
    visit(node)
    return out
  }
  const makeT = language => createTranslator({
    bind: () => key => key,
    getSnapshot: () => ({ active: language, locales: [{ id: language, fallback: 'en' }] }),
    subscribe: () => () => {},
  }, language)
  const tZh = makeT('zh')
  const rows = Array.from({ length: 12 }, (_, index) => {
    const calls = 12 - index
    return {
      sessionId: `wa-${String(index).padStart(2, '0')}`,
      search: { ok: calls, failed: 0, total: calls },
      calls: { ok: calls, failed: 0, total: calls },
      cost: { amount: calls / 1000, currency: 'CNY', priced: true },
    }
  })
  const summary = normalizeSummary({
    totals: { requests: 1 },
    webApi: { calls: { ok: 78, failed: 0, total: 78 }, bySession: rows },
  })
  const collapsedElement = components.WebTab({ summary, t: tZh })
  const collapsed = textOf(collapsedElement)
  assert.ok(collapsed.includes('展开全部（12）'), `fold label with the row count: ${collapsed.slice(0, 300)}`)
  for (let index = 0; index < 10; index += 1) {
    assert.ok(collapsed.includes(`wa-${String(index).padStart(2, '0')}`), `row ${index} is in the first fold`)
  }
  assert.ok(!collapsed.includes('wa-10'), 'the eleventh row stays folded')
  assert.ok(!collapsed.includes('wa-11'), 'the twelfth row stays folded')

  const collapsedToggle = flatten(collapsedElement).find(node => node.props?.['data-dsh-part'] === 'webapi-sessions-toggle')
  assert.ok(collapsedToggle, 'the fold action is rendered when rows exceed ten')
  assert.equal(collapsedToggle.type, 'button')
  assert.equal(collapsedToggle.props['aria-expanded'], false)
  assert.equal(collapsedToggle.props.children, '展开全部（12）')

  let toggles = 0
  const openElement = components.WebTab({
    summary,
    t: tZh,
    webApiSessions: { open: true, onToggle: () => { toggles += 1 } },
  })
  const open = textOf(openElement)
  assert.ok(open.includes('收起'), 'an expanded table offers a collapse action')
  assert.ok(!open.includes('展开全部'), 'the expand label is replaced while open')
  for (let index = 0; index < 12; index += 1) {
    assert.ok(open.includes(`wa-${String(index).padStart(2, '0')}`), `row ${index} is visible after expansion`)
  }
  const openToggle = flatten(openElement).find(node => node.props?.['data-dsh-part'] === 'webapi-sessions-toggle')
  assert.equal(openToggle.props['aria-expanded'], true)
  openToggle.props.onClick()
  assert.equal(toggles, 1, 'the toggle calls the panel callback')

  const ten = normalizeSummary({
    totals: { requests: 1 },
    webApi: { calls: { ok: 65, failed: 0, total: 65 }, bySession: rows.slice(0, 10) },
  })
  const tenElement = components.WebTab({ summary: ten, t: tZh })
  const tenText = textOf(tenElement)
  assert.ok(!tenText.includes('展开全部'), 'exactly ten rows need no fold action')
  assert.ok(!flatten(tenElement).some(node => node.props?.['data-dsh-part'] === 'webapi-sessions-toggle'))
  assert.ok(tenText.includes('wa-09'))

  const enText = textOf(components.WebTab({ summary, t: makeT('en') }))
  assert.ok(enText.includes('Show all (12)'), `en fold label: ${enText.slice(0, 300)}`)
})

test('M2.5 locale keys exist in both dictionaries', () => {
  const { locales } = captured.factory(fakeRequire).__test
  const keys = [
    'table.webApiSessions.title',
    'table.webApiSessions.hint',
    'table.webApiSessions.search',
    'table.webApiSessions.fetch',
    'table.webApiSessions.expand',
    'table.webApiSessions.collapse',
  ]
  for (const key of keys) {
    assert.ok(Object.hasOwn(locales.en, key), `en.${key} exists`)
    assert.ok(Object.hasOwn(locales.zh, key), `zh.${key} exists`)
    assert.equal(typeof locales.en[key], 'string')
    assert.equal(typeof locales.zh[key], 'string')
    assert.ok(locales.en[key].length > 0)
    assert.ok(locales.zh[key].length > 0)
  }
  assert.equal(locales.zh['table.webApiSessions.title'], '搜索 / 抓取会话')
  assert.equal(locales.en['table.webApiSessions.title'], 'Search & fetch sessions')
  assert.equal(locales.zh['table.webApiSessions.search'], '搜索')
  assert.equal(locales.zh['table.webApiSessions.fetch'], '抓取')
  assert.equal(locales.zh['table.webApiSessions.expand'], '展开全部（{count}）')
  assert.equal(locales.en['table.webApiSessions.expand'], 'Show all ({count})')
  assert.ok(locales.zh['table.webApiSessions.hint'].includes('web_search'))
  assert.ok(locales.en['table.webApiSessions.hint'].includes('web_fetch'))
})

// ---------------------------------------------------------------------------
// M2.6 — page-internal tabs
// ---------------------------------------------------------------------------

const textOfM26 = node => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOfM26).join(' ')
  if (typeof node === 'function') return textOfM26(node({}))
  if (typeof node === 'object') {
    if (typeof node.type === 'function') return textOfM26(node.type(node.props))
    return textOfM26(node.children)
  }
  return ''
}

const flattenM26 = node => {
  const out = []
  const visit = value => {
    if (value === null || value === undefined || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    out.push(value)
    if (typeof value.type === 'function') visit(value.type(value.props))
    else visit(value.children)
  }
  visit(node)
  return out
}

const makeT26 = (language = 'zh') => captured.factory(fakeRequire).__test.createTranslator({
  bind: () => key => key,
  getSnapshot: () => ({ active: language, locales: [{ id: language, fallback: 'en' }] }),
  subscribe: () => () => {},
}, language)

const makeRpc26 = () => ({
  async call() {
    return { ok: true, value: {} }
  },
  getChannel() {
    return '/token-attribution'
  },
  setChannel() {},
})

const tabButtons = node => flattenM26(node).filter(candidate => candidate.props?.role === 'tab')

const summaryM26 = () => {
  const bySession = Array.from({ length: 7 }, (_, index) => ({
    sessionId: `sess-top-${index}`,
    parentSessionId: null,
    depth: 0,
    promptTokens: 700 - index * 100,
    outputTokens: 70 - index * 10,
    tokens: 770 - index * 110,
    requests: 1,
  }))
  const byModel = Array.from({ length: 7 }, (_, index) => ({
    provider: 'deepseek-official',
    model: `m-${index}`,
    requests: 1,
    promptTokens: 700 - index * 100,
    outputTokens: 70 - index * 10,
    tokens: 770 - index * 110,
  }))
  const webApiRows = Array.from({ length: 12 }, (_, index) => ({
    sessionId: `wa-${index}`,
    search: { ok: 12 - index, failed: 0, total: 12 - index },
    calls: { ok: 12 - index, failed: 0, total: 12 - index },
    cost: { amount: (12 - index) / 1000, currency: 'CNY', priced: true },
  }))
  return captured.factory(fakeRequire).__test.normalizeSummary({
    totals: { promptTokens: 1000, outputTokens: 100, requests: 7 },
    byPurpose: { chat: { requests: 7, promptTokens: 1000, outputTokens: 100 } },
    byCategory: { user: 500, 'tool-result:other:read': 300, 'injected:memory-snapshot': 200 },
    byCategoryGroup: { user: 500, 'tool-result': 300, memory: 200 },
    byToolGroup: { memory: 600, skill: 200, 'other:web_search': 100, 'agent-teams': 50, history: 50 },
    byDay: [{ day: '2026-11-10', promptTokens: 1000, outputTokens: 100, requests: 7 }],
    bySession,
    byModel,
    webApi: {
      search: { ok: 78, failed: 0, total: 78 },
      calls: { ok: 78, failed: 0, total: 78 },
      cost: { amount: 0.39, currency: 'CNY', priced: true },
      bySession: webApiRows,
    },
    cost: { amount: 0.5, currency: 'CNY', priced: true, unpricedRequests: 0 },
  })
}

test('M2.6 tab shell exposes seven ARIA tabs and defaults to Overview', () => {
  const plugin = captured.factory(fakeRequire)
  const { createTranslator, components, tabIds, defaultTab, isValidTab, tabLabel } = plugin.__test
  const t = makeT26('zh')
  assert.deepEqual([...tabIds], ['overview', 'sessions', 'models', 'sources', 'web', 'details', 'settings'])
  assert.equal(defaultTab, 'overview')
  assert.equal(tabLabel(t, 'overview'), '概览')
  assert.equal(tabLabel(t, 'settings'), '设置')
  assert.equal(tabLabel(makeT26('en'), 'sources'), 'Sources')

  let changed = []
  const bar = components.TabBar({ t, activeTab: 'overview', onChange: value => { changed = [...changed, value] } })
  assert.equal(bar.type, 'div')
  assert.equal(bar.props.role, 'tablist')
  assert.equal(bar.props['aria-label'], '用量视图')
  assert.equal(bar.props.style.overflowX, 'auto', 'the tab bar scrolls horizontally on narrow widths')
  const buttons = tabButtons(bar)
  assert.equal(buttons.length, 7, 'seven tab buttons render')
  assert.deepEqual(buttons.map(button => button.props['data-tab']), [...tabIds])
  for (const button of buttons) {
    assert.equal(button.type, 'button')
    assert.equal(button.props.role, 'tab')
    assert.equal(button.props.tabIndex, button.props['aria-selected'] === true ? 0 : -1)
    assert.ok(String(button.props['aria-controls']).startsWith('token-attribution-tabpanel-'))
    assert.equal(button.props['aria-selected'], button.props['data-tab'] === 'overview')
    assert.equal(typeof button.props.onKeyDown, 'function', 'each tab handles roving-tabindex keys')
  }
  const selected = buttons.filter(button => button.props['aria-selected'] === true)
  assert.equal(selected.length, 1, 'exactly one tab is selected')
  assert.equal(selected[0].props['data-tab'], 'overview', 'Overview is the default tab')
  const barText = textOfM26(bar)
  for (const label of ['概览', '会话', '模型', '来源', '搜索', '明细', '设置']) {
    assert.ok(barText.includes(label), `tab bar renders ${label}`)
  }
  buttons.find(button => button.props['data-tab'] === 'settings').props.onClick()
  assert.deepEqual(changed, ['settings'], 'a tab click reports its id')
  assert.equal(isValidTab('details'), true)
  assert.equal(isValidTab('nope'), false)

  const activePanel = components.TabPanel({ id: 'overview', activeTab: 'overview', t, children: '概览内容' })
  assert.equal(activePanel.type, 'div')
  assert.equal(activePanel.props.role, 'tabpanel')
  assert.equal(activePanel.props.id, 'token-attribution-tabpanel-overview')
  assert.equal(activePanel.props['aria-labelledby'], 'token-attribution-tab-overview')
  assert.equal(components.TabPanel({ id: 'sessions', activeTab: 'overview', t, children: 'x' }), null)

  const panel = components.UsagePanel({ localeRuntime: {
    bind: () => key => key,
    getSnapshot: () => ({ active: 'zh' }),
    subscribe: () => () => {},
  }, rpc: makeRpc26() })
  const panelButtons = tabButtons(panel)
  assert.equal(panelButtons.length, 7)
  assert.equal(panelButtons.filter(button => button.props['aria-selected'] === true).length, 1)
  assert.equal(panelButtons.find(button => button.props['aria-selected'] === true).props['data-tab'], 'overview')
  const gear = flattenM26(panel).find(node => node.props?.['data-dsh-part'] === 'settings-button')
  assert.ok(gear, 'the gear remains in the shared header')
  assert.equal(gear.props['data-tab-target'], 'settings')
  assert.equal(gear.props['aria-pressed'], false)
  assert.equal(typeof gear.props.onClick, 'function')
  gear.props.onClick()
})

test('M2.6 tab bar keyboard navigation wraps and keeps a roving tabindex', () => {
  const plugin = captured.factory(fakeRequire)
  const { components, nextTabId, tabIds } = plugin.__test
  const t = makeT26('zh')
  assert.equal(nextTabId('overview', 'ArrowRight', tabIds), 'sessions')
  assert.equal(nextTabId('details', 'ArrowRight', tabIds), 'settings')
  assert.equal(nextTabId('settings', 'ArrowRight', tabIds), 'overview', 'ArrowRight wraps')
  assert.equal(nextTabId('overview', 'ArrowLeft', tabIds), 'settings', 'ArrowLeft wraps')
  assert.equal(nextTabId('sources', 'ArrowLeft', tabIds), 'models')
  assert.equal(nextTabId('details', 'Home', tabIds), 'overview')
  assert.equal(nextTabId('details', 'End', tabIds), 'settings')
  assert.equal(nextTabId('overview', 'Enter', tabIds), null, 'unhandled keys keep their browser default')
  assert.equal(nextTabId('nope', 'ArrowRight', tabIds), 'overview', 'an unknown current tab starts at the first tab')
  assert.equal(nextTabId('overview', 'ArrowRight', []), null, 'an empty tab list handles no keys')

  const activated = []
  const bar = components.TabBar({ t, activeTab: 'overview', onChange: value => activated.push(value) })
  assert.equal(bar.props.role, 'tablist')
  const buttons = tabButtons(bar)
  assert.equal(buttons.length, 7)
  assert.ok(buttons.every(button => button.props.role === 'tab' && typeof button.props['aria-selected'] === 'boolean'))
  const first = buttons[0]
  let prevented = 0
  first.props.onKeyDown({ key: 'ArrowRight', preventDefault: () => { prevented += 1 } })
  assert.deepEqual(activated, ['sessions'], 'ArrowRight focuses and activates the next tab')
  assert.equal(prevented, 1, 'a handled key prevents the browser default')
  first.props.onKeyDown({ key: 'ArrowLeft', preventDefault: () => { prevented += 1 } })
  assert.deepEqual(activated, ['sessions', 'settings'], 'ArrowLeft wraps to the last tab')
  first.props.onKeyDown({ key: 'End', preventDefault: () => { prevented += 1 } })
  assert.deepEqual(activated, ['sessions', 'settings', 'settings'], 'End activates the last tab')
  prevented = 0
  first.props.onKeyDown({ key: 'Enter', preventDefault: () => { prevented += 1 } })
  assert.equal(prevented, 0, 'unhandled keys are not prevented')
  assert.equal(activated.length, 3, 'unhandled keys do not activate a tab')

  const detailBar = components.TabBar({ t, activeTab: 'details', onChange: value => activated.push(value) })
  tabButtons(detailBar)[4].props.onKeyDown({ key: 'Home', preventDefault() {} })
  assert.equal(activated.at(-1), 'overview', 'Home activates the first tab')
  assert.equal(tabButtons(detailBar).filter(button => button.props.tabIndex === 0).length, 1, 'exactly one tab is in the roving tab order')
})

test('M2.6 Overview renders Top-5 session/model/Web API summaries without the full tables', () => {
  const plugin = captured.factory(fakeRequire)
  const { components } = plugin.__test
  const t = makeT26('zh')
  const summary = summaryM26()
  const sessionTitles = { 'sess-top-0': { displayTitle: '标题零' } }
  const overview = components.OverviewTab({ summary, meta: null, t, channel: '', sessionTitles })
  const text = textOfM26(overview)
  for (const expected of ['会话 Top 5', '模型 Top 5', '搜索 / 抓取会话 · Top 5', '标题零', '前 5', '按天趋势', '口径说明']) {
    assert.ok(text.includes(expected), `overview renders ${expected}`)
  }
  for (let index = 0; index < 5; index += 1) {
    assert.ok(text.includes(index === 0 ? '标题零' : `sess-top-${index}`), `session ${index} is in the Top 5`)
    assert.ok(text.includes(`m-${index}`), `model ${index} is in the Top 5`)
    assert.ok(text.includes(`wa-${index}`), `Web API session ${index} is in the Top 5`)
  }
  assert.ok(!text.includes('sess-top-5'), 'the sixth session stays off the overview')
  assert.ok(!text.includes('sess-top-6'), 'the seventh session stays off the overview')
  assert.ok(!text.includes('m-5'), 'the sixth model stays off the overview')
  assert.ok(!text.includes('wa-5'), 'the sixth Web API session stays off the overview')
  const sessionRows = flattenM26(overview).filter(node => node.props?.['data-session-row'] !== undefined)
  assert.equal(sessionRows.length, 5, 'the overview session summary is capped at five rows')
  assert.equal(flattenM26(overview).filter(node => node.props?.['data-dsh-part'] === 'session-toggle').length, 0, 'the Top-5 session summary is read-only')
  assert.ok(!text.includes('请求明细'), 'the details pane does not leak onto the overview')
  assert.ok(!text.includes('展开全部'), 'the Web API Top-5 has no fold action')
  assert.ok(!text.includes('加载更多'))
})

test('M2.6 Sessions, Models, Sources and Web tabs render their full tables', () => {
  const plugin = captured.factory(fakeRequire)
  const { components, toolGroupLabel, toolGroupRows, normalizeSummary } = plugin.__test
  const t = makeT26('zh')
  const summary = summaryM26()

  const sessionsText = textOfM26(components.SessionsTab({ summary, t, sessionTitles: null }))
  for (let index = 0; index < 7; index += 1) {
    assert.ok(sessionsText.includes(`sess-top-${index}`), `sessions tab shows session ${index}`)
  }
  for (let index = 0; index < 10; index += 1) {
    assert.ok(sessionsText.includes(`wa-${index}`), `sessions tab shows the first Web API fold row ${index}`)
  }
  assert.ok(!sessionsText.includes('wa-10'), 'the full Web API table keeps its ten-row fold')
  assert.ok(sessionsText.includes('展开全部（12）'), 'the full table offers its fold action')

  const modelsText = textOfM26(components.ModelsTab({ summary, t }))
  for (let index = 0; index < 7; index += 1) {
    assert.ok(modelsText.includes(`m-${index}`), `models tab shows model ${index}`)
  }

  const webText = textOfM26(components.WebTab({
    summary,
    t,
    sessionTitles: null,
    webApiSessions: { open: true, onToggle() {} },
  }))
  for (const expected of ['搜索 / 抓取', '搜索 / 抓取会话', 'web_search', 'web_fetch', '工具', '搜索', '抓取']) {
    assert.ok(webText.includes(expected), `web tab renders ${expected}`)
  }
  for (let index = 0; index < 12; index += 1) {
    assert.ok(webText.includes(`wa-${index}`), `web tab shows Web API session ${index}`)
  }

  const sourcesText = textOfM26(components.SourcesTab({ summary, t }))
  for (const expected of ['按内容来源', '来源明细', '占 prompt', '工具分组', '记忆', '技能', '其他·web_search', 'Agent Teams', '历史', '60.0%', '600']) {
    assert.ok(sourcesText.includes(expected), `sources tab renders ${expected}`)
  }
  assert.ok(sourcesText.includes('30.0%'), 'tool-result share is derived from the prompt total')
  const emptySources = textOfM26(components.SourcesTab({ summary: normalizeSummary({ totals: { promptTokens: 10 } }), t }))
  assert.ok(emptySources.includes('该范围内暂无工具分组数据'), 'a pre-M2.6 Host shows the tool-group empty state')

  assert.equal(toolGroupLabel(t, 'memory'), '记忆')
  assert.equal(toolGroupLabel(t, 'skill'), '技能')
  assert.equal(toolGroupLabel(t, 'agent-teams'), 'Agent Teams')
  assert.equal(toolGroupLabel(t, 'history'), '历史')
  assert.equal(toolGroupLabel(t, 'other:web_search'), '其他·web_search')
  assert.equal(toolGroupLabel(t, 'other:'), 'other:')
  assert.equal(toolGroupLabel(t, 'future-group'), 'future-group')
  const rows = toolGroupRows({ memory: 600, skill: 200, 'other:x': 200 }, 1000, t)
  assert.deepEqual(rows.map(row => row.key), ['memory', 'other:x', 'skill'], 'ties sort by key')
  assert.deepEqual(rows.map(row => row.share), [0.6, 0.2, 0.2])
  assert.deepEqual(toolGroupRows({}, 1000, t), [])

  const carried = normalizeSummary({ totals: { promptTokens: 10 }, byToolGroup: { memory: 4, 'other:x': 2 } })
  assert.deepEqual(carried.byToolGroup, { memory: 4, 'other:x': 2 })
  assert.deepEqual(normalizeSummary({}).byToolGroup, {}, 'a pre-M2.6 Host defaults byToolGroup to an empty map')
})

test('M2.6 Details pagination payload, filters, load-more and error states', () => {
  const plugin = captured.factory(fakeRequire)
  const {
    components,
    createDetailsState,
    detailsReducer,
    detailsRequestPayload,
    sessionFilterOptions,
  } = plugin.__test
  const t = makeT26('zh')

  assert.deepEqual(detailsRequestPayload({ from: '2026-11-01', to: '2026-11-07' }, {
    limit: 20,
    offset: 40,
    purpose: 'chat',
    sessionId: 'sess-1',
  }), { from: '2026-11-01', to: '2026-11-07', limit: 20, offset: 40, purpose: 'chat', sessionId: 'sess-1' })
  assert.deepEqual(detailsRequestPayload({ from: '2026-11-01', to: '2026-11-07' }, {
    limit: 20,
    offset: 0,
    purpose: 'all',
    sessionId: 'all',
  }), { from: '2026-11-01', to: '2026-11-07', limit: 20, offset: 0 }, 'all filters are omitted')
  assert.deepEqual(detailsRequestPayload(null), { from: '', to: '', limit: 20, offset: 0 }, 'defaults are safe')
  assert.ok(!Object.hasOwn(detailsRequestPayload(null, { purpose: '', sessionId: '  ' }), 'purpose'))

  let state = createDetailsState()
  assert.equal(state.status, 'idle')
  assert.equal(state.offset, 0)
  state = detailsReducer(state, { type: 'filters', purpose: 'chat' })
  assert.equal(state.status, 'loading')
  assert.equal(state.purpose, 'chat')
  assert.equal(state.sessionId, 'all')
  assert.equal(state.offset, 0)
  assert.deepEqual(state.items, [])
  state = detailsReducer(state, { type: 'loaded', items: Array.from({ length: 20 }, (_, i) => ({ key: `p1-${i}` })), total: 40 })
  assert.equal(state.status, 'ready')
  assert.equal(state.items.length, 20)
  assert.equal(state.total, 40)
  assert.equal(state.offset, 0, 'the requested offset is kept until Load more')
  state = detailsReducer(state, { type: 'more' })
  assert.equal(state.offset, 20)
  state = detailsReducer(state, { type: 'loaded', items: Array.from({ length: 20 }, (_, i) => ({ key: `p2-${i}` })), total: 40 })
  assert.equal(state.items.length, 40, 'the second page appends')
  assert.equal(state.items[20].key, 'p2-0')
  state = detailsReducer(state, { type: 'more' })
  state = detailsReducer(state, { type: 'loaded', items: [{ key: 'p3-0' }], total: 41 })
  assert.equal(state.items.length, 41)
  const mismatch = detailsReducer({ ...createDetailsState(), offset: 20, items: [{ key: 'old' }] }, {
    type: 'loaded',
    items: [{ key: 'fresh' }],
    total: 1,
  })
  assert.deepEqual(mismatch.items.map(item => item.key), ['fresh'], 'a mismatched offset replaces instead of duplicating')
  const failed = detailsReducer({ ...state, status: 'loading-more' }, { type: 'error', error: { code: 'bad-request', message: '', details: {} } })
  assert.equal(failed.status, 'error')
  assert.ok(failed.items.length > 0, 'a mid-list failure keeps rendered rows')
  const firstFailure = detailsReducer(createDetailsState(), { type: 'error', error: { code: 'transport', message: '', details: {} } })
  assert.deepEqual(firstFailure.items, [])
  const reset = detailsReducer({ ...state, offset: 20 }, { type: 'range' })
  assert.equal(reset.offset, 0)
  assert.deepEqual(reset.items, [])
  assert.equal(reset.status, 'loading')

  const options = sessionFilterOptions([
    { sessionId: 'sess-titled-0123456789', tokens: 10 },
    { sessionId: 'sess-untitled', tokens: 9 },
    { sessionId: 'sess-titled-0123456789', tokens: 8 },
  ], { 'sess-titled-0123456789': { displayTitle: '重构鉴权中间件' } })
  assert.equal(options.length, 2, 'duplicate session ids are folded')
  assert.equal(options[0].value, 'sess-titled-0123456789')
  assert.ok(options[0].label.startsWith('重构鉴权中间件 · '))
  assert.equal(options[1].label, 'sess-untitl…', 'an untitled session keeps the short id')
  const capped = sessionFilterOptions(Array.from({ length: 105 }, (_, index) => ({ sessionId: `s-${index}` })), {}, 100)
  assert.equal(capped.length, 100)

  const pageItems = Array.from({ length: 20 }, (_, index) => ({
    key: `row-${index}`,
    ts: 1700000000000 + index,
    sessionId: index === 0 ? 'sess-titled-0123456789' : `sess-${index}`,
    purpose: index === 1 ? 'auto-review' : 'chat',
    promptTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 5,
    cost: { amount: 0.01, currency: 'CNY', priced: true },
  }))
  let moreCalls = 0
  const ready = components.DetailsTab({
    t,
    state: {
      status: 'ready',
      items: pageItems,
      total: 40,
      offset: 0,
      purpose: 'all',
      sessionId: 'all',
      error: null,
    },
    sessions: [{ sessionId: 'sess-titled-0123456789', tokens: 10 }, { sessionId: 'sess-1', tokens: 9 }],
    sessionTitles: { 'sess-titled-0123456789': { displayTitle: '重构鉴权中间件' } },
    limit: 20,
    onPurposeChange() {},
    onSessionChange() {},
    onLoadMore: () => { moreCalls += 1 },
    onRetry() {},
  })
  const readyText = textOfM26(ready)
  for (const expected of ['请求明细', '已显示 20 / 40 条', '加载更多', '重构鉴权中间件', '主对话', '自动审查']) {
    assert.ok(readyText.includes(expected), `details page renders ${expected}`)
  }
  const optionNodes = flattenM26(ready).filter(node => node.type === 'option')
  assert.ok(optionNodes.some(node => node.props.value === 'chat'), 'purpose options include chat')
  assert.ok(optionNodes.some(node => node.props.value === 'auto-review'))
  assert.ok(optionNodes.some(node => node.props.value === 'sess-titled-0123456789'), 'session options include the concrete id')
  const purposeSelect = flattenM26(ready).find(node => node.props?.['data-dsh-part'] === 'details-purpose')
  assert.equal(purposeSelect.props.value, 'all')
  assert.equal(purposeSelect.props.children[0].props.value, 'all')
  let purposePicked = ''
  let sessionPicked = ''
  const readyWithHandler = components.DetailsTab({
    t,
    state: { status: 'ready', items: pageItems, total: 40, offset: 0, purpose: 'all', sessionId: 'all', error: null },
    sessions: [],
    sessionTitles: null,
    limit: 20,
    onPurposeChange: value => { purposePicked = value },
    onSessionChange: value => { sessionPicked = value },
    onLoadMore() {},
    onRetry() {},
  })
  const purposeSelect2 = flattenM26(readyWithHandler).find(node => node.props?.['data-dsh-part'] === 'details-purpose')
  purposeSelect2.props.onChange({ target: { value: 'chat' } })
  assert.equal(purposePicked, 'chat')
  const sessionSelect = flattenM26(readyWithHandler).find(node => node.props?.['data-dsh-part'] === 'details-session')
  sessionSelect.props.onChange({ target: { value: 'sess-1' } })
  assert.equal(sessionPicked, 'sess-1')
  const sessionOptions = sessionSelect.props.children.map(option => option.props.value)
  assert.deepEqual(sessionOptions, ['all'], 'no concrete sessions are listed when none are supplied')
  const loadMore = flattenM26(ready).find(node => node.props?.['data-dsh-part'] === 'details-load-more')
  assert.ok(loadMore, 'the load-more action renders while rows remain')
  loadMore.props.onClick()
  assert.equal(moreCalls, 1)

  const titledCell = flattenM26(ready).find(node => node.props?.['data-dsh-part'] === 'request-session' && node.props['data-session-id'] === 'sess-titled-0123456789')
  assert.ok(titledCell, 'the session column cell is marked for inspection')
  assert.equal(titledCell.type, 'span')
  assert.equal(titledCell.props.children, '重构鉴权中间件')
  assert.equal(titledCell.props.title, 'sess-titled-0123456789', 'the tooltip keeps the full session id')

  let retries = 0
  const errorPane = components.DetailsTab({
    t,
    state: {
      status: 'error',
      items: pageItems.slice(0, 3),
      total: 40,
      offset: 20,
      purpose: 'all',
      sessionId: 'all',
      error: { code: 'bad-request', message: '', details: {} },
    },
    sessions: [],
    sessionTitles: null,
    limit: 20,
    onPurposeChange() {},
    onSessionChange() {},
    onLoadMore() {},
    onRetry: () => { retries += 1 },
  })
  const errorText = textOfM26(errorPane)
  assert.ok(errorText.includes('Host 拒绝了请求参数'), 'the RPC error is shown in the pane')
  assert.ok(errorText.includes('请求明细加载失败'), 'the pane explains the failure')
  assert.ok(errorText.includes('sess-1'), 'already-loaded rows stay visible after a failure')
  flattenM26(errorPane).find(node => node.props?.['data-dsh-part'] === 'details-retry').props.onClick()
  assert.equal(retries, 1)

  const loading = components.DetailsTab({
    t,
    state: { ...createDetailsState(), status: 'loading' },
    sessions: [],
    sessionTitles: null,
    onPurposeChange() {},
    onSessionChange() {},
    onLoadMore() {},
    onRetry() {},
  })
  assert.ok(textOfM26(loading).includes('正在加载请求明细'), 'the initial load state renders')
  const empty = components.DetailsTab({
    t,
    state: { ...createDetailsState(), status: 'empty', total: 0 },
    sessions: [],
    sessionTitles: null,
    onPurposeChange() {},
    onSessionChange() {},
    onLoadMore() {},
    onRetry() {},
  })
  assert.ok(textOfM26(empty).includes('该范围内暂无请求明细'))
})

test('M2.6 Details pagination resets when the resolved range key changes', () => {
  const plugin = captured.factory(fakeRequire)
  const {
    createDetailsState,
    detailsReducer,
    detailsRangeKeyFromRange,
    detailsRangeChanged,
  } = plugin.__test
  const key1 = detailsRangeKeyFromRange({ from: '2026-11-01', to: '2026-11-07' })
  const key2 = detailsRangeKeyFromRange({ from: '2026-11-02', to: '2026-11-08' })
  assert.equal(key1, '2026-11-01|2026-11-07')
  assert.equal(detailsRangeKeyFromRange(null), '')
  assert.notEqual(key1, key2, 'an auto-refresh across midnight derives a new range key')
  const rows = (start, count) => Array.from({ length: count }, (_, index) => ({ key: `r-${start + index}` }))
  const simulateRangeRefresh = (state, key) => (
    detailsRangeChanged(state, key) ? detailsReducer(state, { type: 'range', rangeKey: key }) : state
  )

  let state = createDetailsState(key1)
  assert.equal(state.rangeKey, key1, 'the initial state records the Host range')
  state = detailsReducer(state, { type: 'loaded', items: rows(0, 20), total: 40 })
  state = detailsReducer(state, { type: 'more' })
  state = detailsReducer(state, { type: 'loaded', items: rows(20, 20), total: 40 })
  assert.equal(state.items.length, 40)
  assert.equal(state.offset, 20)
  assert.equal(detailsRangeChanged(state, key1), false)
  assert.equal(simulateRangeRefresh(state, key1), state, 'a same-key auto-refresh keeps the loaded pages')

  // Pre-fix behavior: a page-2 load against the new window replaces the rows,
  // then Load more requests offset 20 again and duplicates the same keys.
  const replaced = detailsReducer(state, { type: 'loaded', items: rows(20, 20), total: 40 })
  const naiveMore = detailsReducer(replaced, { type: 'more' })
  const duplicated = detailsReducer(naiveMore, { type: 'loaded', items: rows(20, 20), total: 40 })
  const duplicatedKeys = duplicated.items.map(item => item.key)
  assert.ok(new Set(duplicatedKeys).size < duplicatedKeys.length, 'the unguarded path demonstrates the duplicate-key bug')

  // The effect-level guard resets offset/items/total and records the new key.
  state = simulateRangeRefresh(state, key2)
  assert.equal(state.rangeKey, key2)
  assert.equal(state.offset, 0)
  assert.deepEqual(state.items, [])
  assert.equal(state.total, 0)
  assert.equal(state.status, 'loading', 'a reset waits for page 1 of the new window')

  const filtered = detailsReducer({ ...state, purpose: 'chat' }, { type: 'range', rangeKey: key2 })
  assert.equal(filtered.purpose, 'chat', 'the range reset preserves the user filters')
  assert.equal(filtered.rangeKey, key2)
  assert.equal(filtered.offset, 0)
  assert.deepEqual(filtered.items, [])

  state = detailsReducer(state, { type: 'loaded', items: rows(0, 20), total: 40 })
  state = detailsReducer(state, { type: 'more' })
  state = detailsReducer(state, { type: 'loaded', items: rows(20, 20), total: 40 })
  assert.equal(state.items.length, 40, 'the new window paginates from page 1 again')
  const keys = state.items.map(item => item.key)
  assert.equal(new Set(keys).size, keys.length, 'the reset pagination has no duplicate row keys')
  assert.equal(keys[0], 'r-0')
  assert.equal(keys[39], 'r-39')

  const resetSameKey = detailsReducer(state, { type: 'range', rangeKey: key2 })
  assert.equal(resetSameKey.rangeKey, key2, 'a same-key reset keeps the recorded range')
  assert.equal(resetSameKey.offset, 0)
  assert.deepEqual(resetSameKey.items, [])
})

test('M2.6 Settings is an inline tab and the gear targets it', () => {
  const plugin = captured.factory(fakeRequire)
  const {
    components,
    normalizeConfigInfo,
    formFromConfig,
    configPatchFromForm,
    configFieldOrder,
    isValidTab,
    numericRules,
  } = plugin.__test
  const t = makeT26('zh')
  const values = {
    dataDir: 'D:/token-data',
    retainRequestDays: 30,
    retainDailyDays: 365,
    flushIntervalMs: 5000,
    pricing: [{
      provider: 'deepseek-official',
      model: '*',
      currency: 'CNY',
      inputPerMillion: 2,
      cacheReadPerMillion: 0.5,
      cacheWritePerMillion: 4,
      outputPerMillion: 8,
      offPeak: { inputPerMillion: 1, outputPerMillion: 4 },
      priceVersion: 'v1',
    }],
    pricingOffPeakDays: ['2026-10-01'],
    webApiPricing: { searchPerThousand: 5, fetchPerThousand: 5, currency: 'CNY' },
    toolGroups: { memory: ['mnemon_'], skill: ['skill'], agentTeams: [] },
    maxDetailRowsPerDay: 200000,
    enableAutoRefresh: true,
    rememberLastTab: true,
    autoRefreshIntervalMs: 30000,
    rpcChannel: '/token-attribution',
  }
  assert.equal(configFieldOrder.length, 13, 'the Config now has 13 fields')
  assert.equal(configFieldOrder.indexOf('rememberLastTab'), 10)
  assert.deepEqual(configFieldOrder, [
    'dataDir', 'retainRequestDays', 'retainDailyDays', 'flushIntervalMs', 'pricing',
    'pricingOffPeakDays', 'webApiPricing', 'toolGroups', 'maxDetailRowsPerDay',
    'enableAutoRefresh', 'rememberLastTab', 'autoRefreshIntervalMs', 'rpcChannel',
  ])
  assert.deepEqual(Object.keys(numericRules), ['retainRequestDays', 'retainDailyDays', 'flushIntervalMs', 'maxDetailRowsPerDay', 'autoRefreshIntervalMs'])
  const form = formFromConfig(values)
  assert.equal(form.rememberLastTab, true)
  const saved = configPatchFromForm(form)
  assert.equal(saved.ok, true)
  assert.equal(saved.patch.rememberLastTab, true)
  const off = configPatchFromForm(formFromConfig({}))
  assert.equal(off.ok, true)
  assert.equal(off.patch.rememberLastTab, false)

  const configInfo = normalizeConfigInfo({
    values,
    defaults: {},
    editable: true,
    restartRequiredFields: ['dataDir', 'rpcChannel'],
    fields: {
      dataDir: { type: 'string', restartRequired: true },
      rememberLastTab: { type: 'boolean' },
    },
    diagnostics: ['pricing: example diagnostic'],
  })
  const settings = components.ConfigPanel({
    t,
    rpc: makeRpc26(),
    configInfo,
    configStatus: 'ready',
    configError: null,
    meta: { dataRoot: 'D:/token-data', readOnly: false },
    migration: { status: 'ok', currentDataDir: 'D:/token-data', configuredDataDir: 'D:/token-data' },
    dataInfo: null,
    onReload() {},
    onSaved() {},
  })
  assert.equal(settings.type, 'div')
  assert.equal(settings.props['data-dsh-part'], 'config-panel')
  assert.notEqual(settings.props.style?.position, 'fixed', 'the settings tab is inline, not an overlay')
  assert.notEqual(settings.props.role, 'dialog')
  assert.equal(flattenM26(settings).some(node => node.props?.['data-dsh-part'] === 'config-overlay'), false, 'no overlay wrapper remains')
  const settingsText = textOfM26(settings)
  for (const expected of [
    '用量设置', 'token-attribution 插件的全部配置项',
    '数据目录', '价目表', '全天空闲日期', '搜索 / 抓取估算', '工具分组（JSON）',
    'Host 诊断', '保存', '取消', '重新加载', '记住上次标签页',
    '打开面板时回到上次停留的标签页',
  ]) {
    assert.ok(settingsText.includes(expected), `settings tab renders ${expected}`)
  }
  const rememberSwitch = flattenM26(settings).find(node => node.props?.role === 'switch' && node.props?.['aria-label'] === '记住上次标签页')
  assert.ok(rememberSwitch, 'the rememberLastTab checkbox/switch renders')
  assert.equal(rememberSwitch.props['aria-checked'], true)

  const panel = components.UsagePanel({
    localeRuntime: { bind: () => key => key, getSnapshot: () => ({ active: 'zh' }), subscribe: () => () => {} },
    rpc: makeRpc26(),
    initialTab: 'settings',
  })
  const settingsTab = tabButtons(panel).find(button => button.props['data-tab'] === 'settings')
  assert.equal(settingsTab.props['aria-selected'], true, 'the gear/tab target selects Settings')
  assert.equal(isValidTab(settingsTab.props['data-tab']), true)
  const gear = flattenM26(panel).find(node => node.props?.['data-dsh-part'] === 'settings-button')
  assert.equal(gear.props['data-tab-target'], 'settings')
  assert.ok(textOfM26(panel).includes('正在加载配置'), 'the inline settings tab renders its loading state')
  assert.equal(flattenM26(panel).some(node => node.props?.['data-dsh-part'] === 'config-overlay'), false)
})

test('M2.6 Settings stays mounted after its first visit so unsaved edits survive tab switches', () => {
  const { components } = captured.factory(fakeRequire).__test
  const t = makeT26('zh')
  const hidden = components.TabPanel({ id: 'settings', activeTab: 'overview', t, keepMounted: true, children: '未保存的编辑' })
  assert.ok(hidden, 'a kept-mounted inactive panel still renders')
  assert.equal(hidden.props.hidden, true, 'the inactive Settings wrapper is hidden')
  assert.equal(hidden.props['aria-hidden'], 'true')
  assert.equal(hidden.props.style.display, 'none')
  assert.equal(textOfM26(hidden), '未保存的编辑', 'its children (the form) stay in the tree')
  assert.equal(components.TabPanel({ id: 'settings', activeTab: 'overview', t, children: 'x' }), null, 'unvisited tabs still unmount')
  const active = components.TabPanel({ id: 'settings', activeTab: 'settings', t, keepMounted: true, children: 'x' })
  assert.equal(active.props.hidden, false)
  assert.equal(active.props['aria-hidden'], undefined)
  assert.equal(active.props.style.display, 'flex')

  const localeRuntime = { bind: () => key => key, getSnapshot: () => ({ active: 'zh' }), subscribe: () => () => {} }
  const visited = components.UsagePanel({
    localeRuntime,
    rpc: makeRpc26(),
    initialTab: 'overview',
    initialSettingsVisited: true,
  })
  const settingsPanel = flattenM26(visited).find(node => node.props?.['data-dsh-part'] === 'tab-panel' && node.props['data-tab'] === 'settings')
  assert.ok(settingsPanel, 'the visited Settings subtree remains in the element tree after switching away')
  assert.equal(settingsPanel.props.hidden, true, 'it is hidden while Overview is active')
  assert.ok(flattenM26(settingsPanel).some(node => node.props?.['data-dsh-part'] === 'config-panel'), 'ConfigPanel and its local form state stay mounted')
  assert.equal(
    flattenM26(visited).filter(node => node.props?.['data-dsh-part'] === 'tab-panel' && node.props['data-tab'] === 'overview').length,
    1,
    'the active tab still renders its own panel',
  )

  const neverVisited = components.UsagePanel({ localeRuntime, rpc: makeRpc26(), initialTab: 'overview' })
  assert.equal(
    flattenM26(neverVisited).some(node => node.props?.['data-dsh-part'] === 'config-panel'),
    false,
    'Settings is not mounted before its first visit',
  )
  const initiallySettings = components.UsagePanel({ localeRuntime, rpc: makeRpc26(), initialTab: 'settings' })
  const initialPanel = flattenM26(initiallySettings).find(node => node.props?.['data-dsh-part'] === 'tab-panel' && node.props['data-tab'] === 'settings')
  assert.ok(initialPanel, 'opening directly on Settings mounts it')
  assert.equal(initialPanel.props.hidden, false, 'the active Settings panel is visible')
})

test('M2.6 pre-M2.6 Host hides rememberLastTab and saves every other field', async () => {
  const plugin = captured.factory(fakeRequire)
  const {
    components,
    normalizeConfigInfo,
    formFromConfig,
    configPatchFromForm,
    configFieldSupported,
    configFieldOrder,
  } = plugin.__test
  const t = makeT26('zh')
  const values = {
    dataDir: 'D:/token-data',
    retainRequestDays: 30,
    retainDailyDays: 365,
    flushIntervalMs: 5000,
    pricing: [],
    pricingOffPeakDays: [],
    webApiPricing: { searchPerThousand: 5, fetchPerThousand: 5, currency: 'CNY' },
    toolGroups: { memory: ['mnemon_'], skill: ['skill'], agentTeams: [] },
    maxDetailRowsPerDay: 200000,
    enableAutoRefresh: false,
    autoRefreshIntervalMs: 30000,
    rpcChannel: '/token-attribution',
  }
  const oldFieldNames = configFieldOrder.filter(name => name !== 'rememberLastTab')
  const oldFields = Object.fromEntries(oldFieldNames.map(name => [name, { type: 'string' }]))
  const oldInfo = normalizeConfigInfo({ values, editable: true, restartRequiredFields: [], fields: oldFields })
  assert.equal(oldFieldNames.length, 12, 'the pre-M2.6 Host advertises its original 12 fields')
  assert.equal(configFieldSupported(oldInfo, 'rememberLastTab'), false)
  assert.equal(configFieldSupported(oldInfo, 'dataDir'), true)
  const form = formFromConfig(oldInfo.values)
  const helperPatch = configPatchFromForm(form, oldInfo)
  assert.equal(helperPatch.ok, true)
  assert.ok(!Object.hasOwn(helperPatch.patch, 'rememberLastTab'), 'the helper omits the unsupported key')
  assert.equal(helperPatch.patch.enableAutoRefresh, false, 'every other boolean is still validated and sent')
  assert.equal(helperPatch.patch.rpcChannel, '/token-attribution')

  const calls = []
  const rpc = {
    async call(endpoint, payload) {
      calls.push({ endpoint, payload })
      return { ok: true, value: { values: oldInfo.values, restartRequired: [] } }
    },
    getChannel() {
      return '/token-attribution'
    },
    setChannel() {},
  }
  const panelProps = info => ({
    t,
    rpc,
    configInfo: info,
    configStatus: 'ready',
    configError: null,
    meta: null,
    migration: null,
    dataInfo: null,
    onReload() {},
    onSaved() {},
  })
  const oldPanel = components.ConfigPanel(panelProps(oldInfo))
  const oldSwitches = flattenM26(oldPanel).filter(node => node.props?.role === 'switch')
  assert.equal(oldSwitches.some(node => node.props['aria-label'] === '记住上次标签页'), false, 'the unsupported switch is hidden')
  assert.equal(oldSwitches.some(node => node.props['aria-label'] === '自动刷新'), true, 'the supported auto-refresh switch still renders')
  const saveButton = flattenM26(oldPanel).find(node => node.type === 'button' && node.props.children === '保存')
  assert.ok(saveButton, 'Save remains available')
  await saveButton.props.onClick()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].endpoint, 'config.set')
  assert.ok(!Object.hasOwn(calls[0].payload.patch, 'rememberLastTab'), 'the actual config.set patch omits the key')
  assert.equal(calls[0].payload.patch.enableAutoRefresh, false)
  assert.equal(calls[0].payload.patch.rpcChannel, '/token-attribution')

  const newInfo = normalizeConfigInfo({
    values: { ...values, rememberLastTab: true },
    editable: true,
    restartRequiredFields: [],
    fields: { ...oldFields, rememberLastTab: { type: 'boolean' } },
  })
  assert.equal(configFieldSupported(newInfo, 'rememberLastTab'), true)
  const newPatch = configPatchFromForm(formFromConfig(newInfo.values), newInfo)
  assert.equal(newPatch.patch.rememberLastTab, true, 'a new Host still receives the flag')
  const newPanel = components.ConfigPanel(panelProps(newInfo))
  assert.ok(
    flattenM26(newPanel).some(node => node.props?.role === 'switch' && node.props?.['aria-label'] === '记住上次标签页'),
    'a new Host still renders the rememberLastTab switch',
  )
  assert.equal('rememberLastTab' in configPatchFromForm(form).patch, true, 'omitting configInfo keeps the legacy validation behavior')
})

test('M2.6 tolerates a pre-M2.6 Host shape without throwing', () => {
  const plugin = captured.factory(fakeRequire)
  const { components, normalizeConfigInfo, normalizeSummary, formFromConfig } = plugin.__test
  const t = makeT26('zh')
  // A pre-M2.6 Host omits byToolGroup, webApi.bySession, and rememberLastTab;
  // its summary can also be entirely empty.
  const summary = normalizeSummary({
    totals: { promptTokens: 10, requests: 1 },
    byCategory: { user: 10 },
    bySession: [{ sessionId: 'legacy-session', tokens: 10, requests: 1 }],
  })
  assert.deepEqual(summary.byToolGroup, {})
  assert.deepEqual(summary.webApi.bySession, [])
  assert.deepEqual(summary.byModel, [])
  const shells = [
    components.OverviewTab({ summary, meta: null, t, channel: '' }),
    components.SessionsTab({ summary, t, sessionTitles: null }),
    components.ModelsTab({ summary, t }),
    components.SourcesTab({ summary, t }),
    components.WebTab({ summary, t, sessionTitles: null }),
    components.DetailsTab({
      t,
      state: { status: 'empty', items: [], total: 0, offset: 0, purpose: 'all', sessionId: 'all', error: null },
      sessions: summary.bySession,
      sessionTitles: null,
      onPurposeChange() {},
      onSessionChange() {},
      onLoadMore() {},
      onRetry() {},
    }),
  ]
  for (const shell of shells) {
    assert.equal(typeof shell, 'object')
    assert.equal(typeof textOfM26(shell), 'string')
  }
  assert.ok(textOfM26(shells[3]).includes('该范围内暂无工具分组数据'))
  assert.ok(!textOfM26(shells[4]).includes('搜索 / 抓取会话'), 'a pre-M2.5 summary hides the search/fetch sessions section')

  const legacyValues = {
    dataDir: '',
    retainRequestDays: 30,
    retainDailyDays: 365,
    flushIntervalMs: 5000,
    pricing: [],
    pricingOffPeakDays: [],
    webApiPricing: { searchPerThousand: 5, fetchPerThousand: 5, currency: 'CNY' },
    toolGroups: { memory: ['mnemon_'], skill: ['skill'], agentTeams: [] },
    maxDetailRowsPerDay: 200000,
    enableAutoRefresh: false,
    autoRefreshIntervalMs: 30000,
    rpcChannel: '/token-attribution',
  }
  const legacyForm = formFromConfig(legacyValues)
  assert.equal(legacyForm.rememberLastTab, false, 'a missing rememberLastTab reads as false')
  const legacyInfo = normalizeConfigInfo({ values: legacyValues, editable: false, fields: {} })
  const legacySettings = components.ConfigPanel({
    t,
    rpc: makeRpc26(),
    configInfo: legacyInfo,
    configStatus: 'ready',
    configError: null,
    meta: null,
    migration: null,
    dataInfo: null,
    onReload() {},
    onSaved() {},
  })
  assert.equal(legacySettings.type, 'div')
  const legacyText = textOfM26(legacySettings)
  for (const expected of ['只读配置', '保存', '取消']) {
    assert.ok(legacyText.includes(expected), `a pre-M2.6 config renders ${expected}`)
  }
  assert.ok(!legacyText.includes('记住上次标签页'), 'a pre-M2.6 Host hides the unsupported switch instead of submitting an unknown key')
  const rememberSwitch = flattenM26(legacySettings).find(node => node.props?.role === 'switch' && node.props?.['aria-label'] === '记住上次标签页')
  assert.equal(rememberSwitch, undefined, 'no rememberLastTab switch renders for an old Host')
  const legacyPatch = plugin.__test.configPatchFromForm(legacyForm, legacyInfo)
  assert.equal(legacyPatch.ok, true)
  assert.ok(!Object.hasOwn(legacyPatch.patch, 'rememberLastTab'), 'an old Host never receives the unknown rememberLastTab key')
  assert.equal(plugin.__test.detailsRequestPayload({ from: '2026-11-01', to: '2026-11-01' }, {
    purpose: 'all',
    sessionId: 'all',
  }).sessionId, undefined, 'no sessionId is sent for "all" (pre-M2.6 Hosts stay compatible)')
})

test('M2.6 rememberLastTab restores only when enabled and falls back to Overview', () => {
  const plugin = captured.factory(fakeRequire)
  const { resolveInitialTab, readStoredTab, writeStoredTab, isValidTab, tabStorageKey } = plugin.__test
  assert.equal(tabStorageKey, 'dsh-token-attribution.activeTab')
  assert.ok(tabStorageKey.startsWith('dsh-token-attribution.'), 'the storage key stays plugin-namespaced')
  assert.equal(resolveInitialTab(false, 'sessions'), 'overview', 'rememberLastTab off always starts on Overview')
  assert.equal(resolveInitialTab(undefined, 'sessions'), 'overview', 'a missing Config value falls back to Overview')
  assert.equal(resolveInitialTab(true, 'sessions'), 'sessions')
  assert.equal(resolveInitialTab(true, 'details'), 'details')
  assert.equal(resolveInitialTab(true, 'settings'), 'settings')
  assert.equal(resolveInitialTab(true, 'bogus'), 'overview')
  assert.equal(resolveInitialTab(true, null), 'overview')
  assert.equal(resolveInitialTab(true, ''), 'overview')
  assert.equal(isValidTab('overview'), true)
  assert.equal(isValidTab('nope'), false)
  assert.equal(isValidTab(''), false)
  assert.equal(isValidTab(null), false)

  const storage = new Map()
  globalThis.localStorage = {
    getItem(key) {
      return storage.get(key) ?? null
    },
    setItem(key, value) {
      storage.set(key, value)
    },
  }
  try {
    assert.equal(readStoredTab(), '', 'nothing stored yet')
    assert.equal(writeStoredTab('details'), true)
    assert.equal(storage.get(tabStorageKey), 'details')
    assert.equal(readStoredTab(), 'details')
    assert.equal(readStoredTab(), 'details')
    assert.equal(writeStoredTab('bogus'), false)
    assert.equal(storage.get(tabStorageKey), 'details', 'invalid tabs are never written')
    storage.set(tabStorageKey, 'not-a-tab')
    assert.equal(readStoredTab(), '', 'invalid stored values are ignored')
    storage.set(tabStorageKey, 'sessions')
    assert.equal(resolveInitialTab(true, readStoredTab()), 'sessions')
    assert.equal(resolveInitialTab(false, readStoredTab()), 'overview', 'stored value is ignored while the flag is off')
  } finally {
    delete globalThis.localStorage
  }
  const throwingStorage = {
    getItem() {
      throw new Error('blocked')
    },
    setItem() {
      throw new Error('blocked')
    },
  }
  globalThis.localStorage = throwingStorage
  try {
    assert.equal(readStoredTab(), '', 'storage failures fall back to no stored tab')
    assert.equal(writeStoredTab('web'), false)
    assert.equal(resolveInitialTab(undefined, readStoredTab()), 'overview', 'a failed Config read falls back to Overview')
  } finally {
    delete globalThis.localStorage
  }
})

test('M2.6 locale keys exist in both dictionaries', () => {
  const { locales, tabIds } = captured.factory(fakeRequire).__test
  const keys = [
    'aria.tabs',
    'aria.tabPanel',
    'chart.category.hintOverview',
    'chart.category.detailTitle',
    'chart.category.detailHint',
    'table.sessions.topHint',
    'table.sessions.topTitle',
    'table.models.topTitle',
    'table.webApiSessions.topTitle',
    'table.toolGroups.title',
    'table.toolGroups.hint',
    'table.toolGroups.group',
    'table.toolGroups.tokens',
    'table.toolGroups.share',
    'table.toolGroups.empty',
    'toolGroup.memory',
    'toolGroup.skill',
    'toolGroup.agent-teams',
    'toolGroup.history',
    'toolGroup.other',
    'toolGroup.unknown',
    'details.title',
    'details.hint',
    'details.purposeFilter',
    'details.sessionFilter',
    'details.filterAll',
    'details.session',
    'details.loadMore',
    'details.loading',
    'details.loadingMore',
    'details.empty',
    'details.failed',
    'details.progress',
    'details.loadedAll',
    'config.field.rememberLastTab',
    'config.field.rememberLastTabHint',
  ]
  for (const id of tabIds) {
    keys.push(`tab.${id}`)
  }
  for (const key of keys) {
    assert.ok(Object.hasOwn(locales.en, key), `en.${key} exists`)
    assert.ok(Object.hasOwn(locales.zh, key), `zh.${key} exists`)
    assert.equal(typeof locales.en[key], 'string')
    assert.equal(typeof locales.zh[key], 'string')
    assert.ok(locales.en[key].length > 0)
    assert.ok(locales.zh[key].length > 0)
  }
  assert.deepEqual(tabIds.map(id => locales.zh[`tab.${id}`]), ['概览', '会话', '模型', '来源', '搜索', '明细', '设置'])
  assert.deepEqual(tabIds.map(id => locales.en[`tab.${id}`]), ['Overview', 'Sessions', 'Models', 'Sources', 'Search', 'Details', 'Settings'])
  assert.equal(locales.zh['details.loadMore'], '加载更多')
  assert.equal(locales.zh['toolGroup.other'], '其他·{name}')
  assert.equal(locales.zh['config.field.rememberLastTab'], '记住上次标签页')
  assert.equal(locales.zh['table.webApiSessions.topTitle'], '搜索 / 抓取会话 · Top {count}')
  assert.equal(locales.en['table.webApiSessions.topTitle'], 'Search & fetch sessions · Top {count}')
  assert.equal(locales.zh['aria.tabs'], '用量视图')
  assert.equal(locales.zh['details.session'], '会话')
})

// ---------------------------------------------------------------------------
// M2.7 — unattributed reconciliation and the Search / fetch rename
// ---------------------------------------------------------------------------

test('M2.7 normalizeWebApi normalizes the unattributed totals defensively', () => {
  const { normalizeWebApi, normalizeWebApiUnattributed, normalizeSummary } = captured.factory(fakeRequire).__test
  const zeros = {
    search: { ok: 0, failed: 0, total: 0 },
    fetch: { ok: 0, failed: 0, total: 0 },
    calls: { ok: 0, failed: 0, total: 0 },
    cost: { amount: 0, currency: 'CNY', priced: false },
  }
  // A pre-M2.7 Host omits the field entirely: zeros, never undefined.
  assert.deepEqual(normalizeWebApi(null).unattributed, zeros)
  assert.deepEqual(normalizeWebApi({}).unattributed, zeros)
  assert.deepEqual(normalizeWebApi({ unattributed: 'nope' }).unattributed, zeros)
  assert.deepEqual(normalizeWebApiUnattributed(undefined), zeros)
  assert.deepEqual(normalizeSummary({}).webApi.unattributed, zeros, 'the zeroed shape survives normalization')
  assert.deepEqual(normalizeSummary({ webApi: {} }).webApi.bySession, [], 'unattributed never leaks into bySession')

  // Partial counters derive `calls`; an explicit calls counter wins.
  const partial = normalizeWebApi({
    unattributed: {
      search: { ok: 2, failed: 1 },
      fetch: { ok: 1 },
      cost: { amount: 0.03, currency: 'USD', priced: true },
    },
  }).unattributed
  assert.deepEqual(partial.search, { ok: 2, failed: 1, total: 3 })
  assert.deepEqual(partial.fetch, { ok: 1, failed: 0, total: 1 })
  assert.deepEqual(partial.calls, { ok: 3, failed: 1, total: 4 })
  assert.deepEqual(partial.cost, { amount: 0.03, currency: 'USD', priced: true })
  assert.equal('sessionId' in partial, false, 'the unattributed bucket has no session id')

  const explicit = normalizeWebApi({
    unattributed: { search: { ok: 1, total: 1 }, calls: { ok: 9, failed: 2, total: 11 } },
  }).unattributed
  assert.deepEqual(explicit.calls, { ok: 9, failed: 2, total: 11 })

  // Unusable numbers clamp to zero and the currency falls back to the default.
  const dirty = normalizeWebApi({
    unattributed: { search: { ok: -3, failed: Number.NaN }, cost: { amount: -1, currency: '   ', priced: 'yes' } },
  }).unattributed
  assert.deepEqual(dirty.search, { ok: 0, failed: 0, total: 0 })
  assert.deepEqual(dirty.cost, { amount: 0, currency: 'CNY', priced: false })
})

test('M2.7 Web API sessions table appends the unattributed reconciliation row', () => {
  const { normalizeSummary, components } = captured.factory(fakeRequire).__test
  const tZh = makeT26('zh')
  const tEn = makeT26('en')
  const summary = normalizeSummary({
    totals: { requests: 2 },
    webApi: {
      calls: { ok: 10, failed: 0, total: 10 },
      unattributed: {
        search: { ok: 2, failed: 0, total: 2 },
        fetch: { ok: 1, failed: 0, total: 1 },
        calls: { ok: 3, failed: 0, total: 3 },
        cost: { amount: 0.015, currency: 'CNY', priced: true },
      },
      bySession: [{
        sessionId: 'sess-a',
        search: { ok: 6, total: 6 },
        fetch: { ok: 1, total: 1 },
        calls: { ok: 7, total: 7 },
        cost: { amount: 0.035, currency: 'CNY', priced: true },
      }],
    },
  })
  const webElement = components.WebTab({ summary, t: tZh, sessionTitles: null })
  const text = textOfM26(webElement)
  assert.ok(text.includes('搜索 / 抓取会话'), 'the section title uses the search/fetch wording')
  assert.ok(text.includes('未归因（升级前仅总量）'), 'the unattributed row label renders')
  assert.ok(text.includes('带会话的行来自 M2.5 起'), 'the reconciliation hint renders below the table')

  const flat = flattenM26(webElement)
  const tableRows = flat.filter(node => node.type === 'tr')
  assert.equal(textOfM26(tableRows.at(-2)), 'sess-a 6 1 ¥0.035', 'the session row keeps its own values')
  assert.equal(textOfM26(tableRows.at(-1)), '未归因（升级前仅总量） 2 1 ¥0.015', 'the unattributed row is last and shows search/fetch/cost')

  const label = flat.find(node => node.props?.['data-dsh-part'] === 'webapi-unattributed')
  assert.ok(label, 'the unattributed cell carries its own marker')
  assert.equal(label.type, 'span')
  assert.equal(label.props.children, '未归因（升级前仅总量）')
  assert.equal(label.props.onClick, undefined, 'the unattributed label is never clickable')
  assert.equal(label.props['data-session-id'], undefined, 'no session id is fabricated')
  assert.equal(typeof label.props.style.color, 'string', 'the label uses the muted text token')
  assert.equal(label.props.style.fontStyle, 'italic')

  const enText = textOfM26(components.WebTab({ summary, t: tEn, sessionTitles: null }))
  assert.ok(enText.includes('Unattributed (pre-M2.5 totals)'))
  assert.ok(enText.includes('2 1 ¥0.015'))
  assert.ok(enText.includes('reconciles the card total'))
  assert.ok(enText.includes('Search & fetch sessions'))

  // The same row renders on the Sessions tab and when no session row exists.
  assert.ok(textOfM26(components.SessionsTab({ summary, t: tZh, sessionTitles: null })).includes('未归因（升级前仅总量）'))
  const onlyUnattributed = normalizeSummary({
    webApi: {
      calls: { ok: 2, failed: 0, total: 2 },
      unattributed: {
        search: { ok: 2, total: 2 },
        calls: { ok: 2, failed: 0, total: 2 },
        cost: { amount: 0.01, currency: 'CNY', priced: true },
      },
    },
  })
  const onlyText = textOfM26(components.WebTab({ summary: onlyUnattributed, t: tZh }))
  assert.ok(onlyText.includes('搜索 / 抓取会话'), 'the section opens for unattributed-only data')
  assert.ok(onlyText.includes('未归因（升级前仅总量） 2 0 ¥0.010'))

  // Failed-only unattributed calls are counted but never billable.
  const failureOnly = normalizeSummary({
    webApi: { unattributed: { calls: { ok: 0, failed: 2, total: 2 }, cost: { priced: false } } },
  })
  assert.ok(
    textOfM26(components.WebTab({ summary: failureOnly, t: tZh })).includes('未归因（升级前仅总量） 0 0 —'),
    'failed calls still count as unattributed activity',
  )
})

test('M2.7 unattributed row stays visible with the folded table and is excluded from the fold count', () => {
  const { normalizeSummary, components } = captured.factory(fakeRequire).__test
  const tZh = makeT26('zh')
  const rows = Array.from({ length: 12 }, (_, index) => ({
    sessionId: `fold-${String(index).padStart(2, '0')}`,
    search: { ok: 12 - index, failed: 0, total: 12 - index },
    calls: { ok: 12 - index, failed: 0, total: 12 - index },
    cost: { amount: (12 - index) / 1000, currency: 'CNY', priced: true },
  }))
  const summary = normalizeSummary({
    webApi: {
      calls: { ok: 78, failed: 0, total: 78 },
      bySession: rows,
      unattributed: { calls: { ok: 3, failed: 0, total: 3 }, search: { ok: 3, total: 3 } },
    },
  })
  const collapsed = textOfM26(components.WebTab({ summary, t: tZh }))
  assert.ok(collapsed.includes('展开全部（12）'), 'the fold count keeps counting session rows only')
  assert.ok(collapsed.includes('未归因（升级前仅总量）'), 'the reconciliation row is not folded away')
  assert.ok(collapsed.includes('fold-09'))
  assert.ok(!collapsed.includes('fold-10'), 'the eleven-row fold still applies')

  const opened = textOfM26(components.WebTab({ summary, t: tZh, webApiSessions: { open: true, onToggle() {} } }))
  assert.ok(opened.includes('fold-11'))
  assert.ok(opened.includes('未归因（升级前仅总量）'))
})

test('M2.7 card adds the unattributed sub-line only when there are unattributed calls', () => {
  const { normalizeSummary, components } = captured.factory(fakeRequire).__test
  const tZh = makeT26('zh')
  const tEn = makeT26('en')
  const withUnattributed = normalizeSummary({
    totals: { requests: 2 },
    webApi: {
      search: { ok: 5, failed: 0, total: 5 },
      calls: { ok: 5, failed: 0, total: 5 },
      cost: { amount: 0.025, currency: 'CNY', priced: true },
      unattributed: { search: { ok: 3, total: 3 }, calls: { ok: 3, failed: 0, total: 3 } },
    },
  })
  const zhText = textOfM26(components.OverviewTab({ summary: withUnattributed, meta: null, t: tZh, channel: '' }))
  assert.ok(zhText.includes('未归因 3'), 'the card carries the unattributed sub-line')
  assert.ok(zhText.includes('搜索 / 抓取 5 次'), 'the card label and total still render')
  const enText = textOfM26(components.OverviewTab({ summary: withUnattributed, meta: null, t: tEn, channel: '' }))
  assert.ok(enText.includes('Unattributed 3'))

  // A zero or missing unattributed bucket adds nothing to the card.
  for (const summary of [
    normalizeSummary({ webApi: { calls: { ok: 2, failed: 0, total: 2 } } }),
    normalizeSummary({ webApi: { calls: { ok: 2, failed: 0, total: 2 }, unattributed: { calls: { ok: 0, total: 0 } } } }),
  ]) {
    const zh = textOfM26(components.OverviewTab({ summary, meta: null, t: tZh, channel: '' }))
    const en = textOfM26(components.OverviewTab({ summary, meta: null, t: tEn, channel: '' }))
    assert.ok(!zh.includes('未归因'), 'no unattributed sub-line without unattributed calls')
    assert.ok(!en.includes('Unattributed'), 'no en unattributed sub-line without unattributed calls')
  }
})

test('M2.7 Overview keeps five session rows and adds the compact unattributed hint', () => {
  const { normalizeWebApiUnattributed, components } = captured.factory(fakeRequire).__test
  const tZh = makeT26('zh')
  const tEn = makeT26('en')
  const summary = summaryM26()
  summary.webApi.unattributed = normalizeWebApiUnattributed({
    search: { ok: 4, failed: 0, total: 4 },
    calls: { ok: 4, failed: 0, total: 4 },
    cost: { amount: 0.02, currency: 'CNY', priced: true },
  })
  const overview = components.OverviewTab({ summary, meta: null, t: tZh, channel: '', sessionTitles: null })
  const text = textOfM26(overview)
  assert.ok(text.includes('另有未归因 4 次'), 'the compact one-line variant is used on the overview')
  assert.ok(!text.includes('未归因（升级前仅总量）'), 'the overview adds no reconciliation table row')
  for (let index = 0; index < 5; index += 1) {
    assert.ok(text.includes(`wa-${index}`), `the top-5 session row ${index} is unaffected`)
  }
  assert.ok(!text.includes('wa-5'), 'the sixth session row stays off the overview')
  const enText = textOfM26(components.OverviewTab({ summary, meta: null, t: tEn, channel: '', sessionTitles: null }))
  assert.ok(enText.includes('4 more unattributed call(s)'))

  const clean = summaryM26()
  assert.ok(!textOfM26(components.OverviewTab({ summary: clean, meta: null, t: tZh, channel: '', sessionTitles: null })).includes('另有未归因'))
})

test('M2.7 renames the Web tab to Search across labels, copy and config', () => {
  const { locales, tabLabel, components, normalizeSummary } = captured.factory(fakeRequire).__test
  // zh/en parity for the new keys, including placeholders.
  const newKeys = [
    'card.webApiUnattributed',
    'table.webApiSessions.unattributed',
    'table.webApiSessions.topUnattributed',
    'table.webApiSessions.unattributedHint',
  ]
  for (const key of newKeys) {
    assert.ok(Object.hasOwn(locales.en, key), `en.${key} exists`)
    assert.ok(Object.hasOwn(locales.zh, key), `zh.${key} exists`)
    assert.equal(typeof locales.en[key], 'string')
    assert.equal(typeof locales.zh[key], 'string')
    assert.ok(locales.en[key].length > 0)
    assert.ok(locales.zh[key].length > 0)
    const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()
    assert.deepEqual(placeholders(locales.zh[key]), placeholders(locales.en[key]), `placeholders of ${key}`)
  }

  assert.equal(locales.zh['tab.web'], '搜索')
  assert.equal(locales.en['tab.web'], 'Search')
  assert.equal(tabLabel(makeT26('zh'), 'web'), '搜索', 'only the display label changes; the tab id stays web')
  assert.equal(tabLabel(makeT26('en'), 'web'), 'Search')
  assert.equal(locales.zh['card.webApi'], '搜索 / 抓取')
  assert.equal(locales.en['card.webApi'], 'Search & fetch')
  assert.equal(locales.zh['table.webApiSessions.title'], '搜索 / 抓取会话')
  assert.equal(locales.en['table.webApiSessions.title'], 'Search & fetch sessions')
  assert.equal(locales.zh['table.webApiSessions.topTitle'], '搜索 / 抓取会话 · Top {count}')
  assert.equal(locales.en['table.webApiSessions.topTitle'], 'Search & fetch sessions · Top {count}')
  assert.equal(locales.zh['table.webApiSessions.unattributed'], '未归因（升级前仅总量）')
  assert.equal(locales.en['table.webApiSessions.unattributed'], 'Unattributed (pre-M2.5 totals)')
  assert.equal(locales.zh['config.section.webApi'], '搜索 / 抓取估算')
  assert.equal(locales.en['config.section.webApi'], 'Search & fetch estimate')
  assert.equal(locales.zh['config.error.webApi-number'], '搜索 / 抓取单价必须为每千次大于等于 0 的数字。')
  assert.equal(locales.en['config.error.webApi-currency'], 'A currency is required for the search & fetch estimate.')

  // The footnote keeps its accounting copy; only the leading phrase changes.
  assert.ok(locales.zh['footnote.webApi'].startsWith('搜索 / 抓取次数来自'))
  assert.ok(locales.en['footnote.webApi'].startsWith('Search & fetch counts come from'))
  for (const footnote of [locales.zh['footnote.webApi'], locales.en['footnote.webApi']]) {
    assert.ok(footnote.includes('web_search'))
    assert.ok(footnote.includes('web_fetch'))
  }
  assert.ok(locales.zh['footnote.webApi'].includes('每千次单价估算'))
  assert.ok(locales.en['footnote.webApi'].includes('per-1,000 rates'))

  // No user-visible dictionary value keeps the old "Web API" name.
  for (const [key, value] of Object.entries(locales.zh)) {
    assert.ok(!value.includes('Web API'), `zh.${key} still says Web API`)
  }
  for (const [key, value] of Object.entries(locales.en)) {
    assert.ok(!/\bWeb API\b/u.test(value), `en.${key} still says Web API`)
  }

  // Render checks: the tab bar, the Search tab and the overview card.
  const summary = normalizeSummary({ webApi: { calls: { ok: 1, failed: 0, total: 1 }, search: { ok: 1, total: 1 } } })
  const zhWeb = textOfM26(components.WebTab({ summary, t: makeT26('zh'), sessionTitles: null }))
  assert.ok(zhWeb.includes('搜索 / 抓取'))
  assert.ok(zhWeb.includes('web_search'))
  assert.ok(!zhWeb.includes('Web API'))
  const enWeb = textOfM26(components.WebTab({ summary, t: makeT26('en'), sessionTitles: null }))
  assert.ok(enWeb.includes('Search & fetch'))
  assert.ok(!enWeb.includes('Web API'))
  const zhOverview = textOfM26(components.OverviewTab({ summary, meta: null, t: makeT26('zh'), channel: '' }))
  assert.ok(zhOverview.includes('搜索 / 抓取'))
  const zhBar = textOfM26(components.TabBar({ t: makeT26('zh'), activeTab: 'web', onChange() {} }))
  assert.ok(zhBar.includes('搜索'))
  assert.ok(!zhBar.includes('Web'), 'the tab bar no longer shows a Web label')
})

// ---------------------------------------------------------------------------
// M2.8 — richer default tool groups and custom group keys
// ---------------------------------------------------------------------------

const M28_TOOL_GROUPS = [
  ['files', '文件/工作区', 'Files & workspace'],
  ['shell', '命令/终端', 'Shell & terminal'],
  ['web', '搜索/抓取', 'Search & fetch'],
  ['session', '会话/历史', 'Session & history'],
  ['goals', '目标', 'Goals'],
  ['schedule', '调度', 'Schedule'],
  ['subagents', '子代理', 'Subagents'],
  ['plugins', '插件/系统', 'Plugins & system'],
  ['browser', '浏览器', 'Browser'],
  ['workflow', '工作流', 'Workflow'],
]

test('M2.8 tool-group labels cover the expanded defaults with en/zh parity', () => {
  const { locales, toolGroupLabel } = captured.factory(fakeRequire).__test
  const tZh = makeT26('zh')
  const tEn = makeT26('en')
  for (const [key, zhLabel, enLabel] of M28_TOOL_GROUPS) {
    assert.equal(locales.zh[`toolGroup.${key}`], zhLabel, `zh label for ${key}`)
    assert.equal(locales.en[`toolGroup.${key}`], enLabel, `en label for ${key}`)
    assert.equal(toolGroupLabel(tZh, key), zhLabel)
    assert.equal(toolGroupLabel(tEn, key), enLabel)
  }

  // The retained labels keep working, and the legacy default Config key
  // `agentTeams` displays as the historical `agent-teams` group.
  const retained = [
    ['memory', '记忆', 'Memory'],
    ['skill', '技能', 'Skill'],
    ['agent-teams', 'Agent Teams', 'Agent Teams'],
    ['agentTeams', 'Agent Teams', 'Agent Teams'],
    ['history', '历史', 'History'],
  ]
  for (const [key, zhLabel, enLabel] of retained) {
    assert.equal(toolGroupLabel(tZh, key), zhLabel, `zh label for ${key}`)
    assert.equal(toolGroupLabel(tEn, key), enLabel, `en label for ${key}`)
  }

  // Custom groups and unknown future keys stay raw so data is never hidden;
  // the historical `other:<tool>` fallback is preserved.
  for (const raw of ['my-tools', 'futureGroup', 'other:']) {
    assert.equal(toolGroupLabel(tZh, raw), raw)
    assert.equal(toolGroupLabel(tEn, raw), raw)
  }
  assert.equal(toolGroupLabel(tZh, 'other:pwsh'), '其他·pwsh')
  assert.equal(toolGroupLabel(tEn, 'other:pwsh'), 'Other · pwsh')
  assert.equal(toolGroupLabel(tZh, 'unknown'), '未知工具')
  assert.equal(toolGroupLabel(tEn, 'unknown'), 'Unknown tool')
  assert.equal(toolGroupLabel(tZh, ''), '未知工具')

  // The Settings hint documents arbitrary groups and the error copy documents
  // the key rules; both locales stay in sync.
  for (const hint of [locales.en['config.field.toolGroupsHint'], locales.zh['config.field.toolGroupsHint']]) {
    assert.equal(typeof hint, 'string')
    assert.ok(hint.length > 0)
  }
  assert.ok(locales.en['config.field.toolGroupsHint'].includes('custom group names'))
  assert.ok(locales.en['config.field.toolGroupsHint'].includes('first match wins'))
  assert.ok(locales.zh['config.field.toolGroupsHint'].includes('可自定义'))
  assert.ok(locales.zh['config.field.toolGroupsHint'].includes('命中第一个'))
  assert.ok(locales.en['config.error.toolGroups-key'].includes('lowercase'))
  assert.ok(locales.zh['config.error.toolGroups-key'].includes('小写字母'))
})

test('M2.8 Sources tool-group table renders expanded defaults, custom groups and legacy rows', () => {
  const { components, normalizeSummary, toolGroupRows } = captured.factory(fakeRequire).__test
  const longLabel = 'a-very-long-custom-group-name-for-ellipsis'
  const byToolGroup = {
    memory: 100,
    skill: 90,
    'agent-teams': 80,
    files: 70,
    shell: 60,
    web: 50,
    session: 40,
    goals: 30,
    schedule: 20,
    subagents: 15,
    plugins: 10,
    browser: 5,
    workflow: 1,
    'my-tools': 4,
    'other:pwsh': 3,
    [longLabel]: 2,
  }
  const summary = normalizeSummary({ totals: { promptTokens: 1000 }, byToolGroup })
  const tZh = makeT26('zh')
  const tEn = makeT26('en')

  const zhText = textOfM26(components.SourcesTab({ summary, t: tZh }))
  for (const [, zhLabel] of M28_TOOL_GROUPS) {
    assert.ok(zhText.includes(zhLabel), `Sources renders ${zhLabel}`)
  }
  for (const expected of ['记忆', '技能', 'Agent Teams', '其他·pwsh', 'my-tools', longLabel, '10.0%', '9.0%']) {
    assert.ok(zhText.includes(expected), `Sources renders ${expected}`)
  }

  const enText = textOfM26(components.SourcesTab({ summary, t: tEn }))
  for (const [, , enLabel] of M28_TOOL_GROUPS) {
    assert.ok(enText.includes(enLabel), `Sources renders ${enLabel}`)
  }
  assert.ok(enText.includes('Other · pwsh'))
  assert.ok(enText.includes('Memory'))

  const rows = toolGroupRows(byToolGroup, 1000, tZh)
  assert.equal(rows.length, Object.keys(byToolGroup).length, 'every group key keeps a row')
  assert.deepEqual([rows[0].key, rows[0].label, rows[0].share], ['memory', '记忆', 0.1])
  assert.equal(rows.find(row => row.key === 'my-tools').label, 'my-tools', 'custom labels stay raw')
  assert.equal(rows.find(row => row.key === 'other:pwsh').label, '其他·pwsh')

  // Long labels/custom keys ellipsize with the full label in a tooltip so the
  // token and share columns stay aligned.
  const titled = flattenM26(components.SourcesTab({ summary, t: tZh }))
    .filter(node => node.props?.title === longLabel)
  assert.equal(titled.length, 1, 'the long group label has a title-carrying cell')
  assert.equal(titled[0].props.style.textOverflow, 'ellipsis')
  assert.equal(titled[0].props.style.whiteSpace, 'nowrap')
  assert.equal(titled[0].props.style.overflow, 'hidden')
  assert.equal(titled[0].props.style.maxWidth, 260, 'the label is capped before it can widen the table')
})

test('M2.8 toolGroups validation accepts custom keys and the textarea passes them through', () => {
  const { validateToolGroups, formFromConfig, configPatchFromForm } = captured.factory(fakeRequire).__test
  assert.equal(validateToolGroups({ memory: [], 'my-tools': ['foo_', 'exact'] }).ok, true)
  assert.equal(validateToolGroups({ agentTeams: ['spawn_teammate'] }).ok, true)
  assert.equal(validateToolGroups({ files: ['read'] }).ok, true)
  assert.equal(validateToolGroups({ 'my-tools': [] }).ok, true, 'an empty array disables the group')
  assert.equal(validateToolGroups({ 'a1-b2': ['y'] }).ok, true, 'digits and hyphens are allowed in non-numeric keys')
  assert.ok(validateToolGroups({ '123': ['x'] }).errors.some(error => error.code === 'toolGroups-key'), 'all-digit keys are rejected (JS reorders integer-like keys)')
  assert.equal(validateToolGroups({ ['a'.repeat(32)]: ['x'] }).ok, true, '32-character keys are accepted')

  const invalid = validateToolGroups({ 'Bad Key': ['x'], 'ok-group': ['y'] })
  assert.equal(invalid.ok, false)
  assert.ok(invalid.errors.some(error => error.field === 'toolGroups.Bad Key' && error.code === 'toolGroups-key'))
  assert.ok(!invalid.errors.some(error => error.field === 'toolGroups.ok-group'), 'valid groups are still checked independently')
  assert.ok(validateToolGroups({ other: ['x'] }).errors.some(error => error.code === 'toolGroups-key'), '"other" is reserved')
  assert.ok(validateToolGroups({ ['a'.repeat(33)]: ['x'] }).errors.some(error => error.code === 'toolGroups-key'))
  assert.ok(validateToolGroups({ 'my-tools': [''] }).errors.some(error => error.code === 'toolGroups-list'))
  assert.ok(validateToolGroups({ 'my-tools': Array.from({ length: 201 }, (_, index) => `t${index}`) })
    .errors.some(error => error.code === 'toolGroups-list'), 'the Host caps one group at 200 entries')
  assert.equal(validateToolGroups({ 'my-tools': Array.from({ length: 200 }, (_, index) => `t${index}`) }).ok, true)

  const values = { memory: ['mnemon_'], 'my-tools': ['foo_'] }
  const built = configPatchFromForm(formFromConfig({ toolGroups: values }))
  assert.equal(built.ok, true)
  assert.deepEqual(built.patch.toolGroups, values, 'the JSON textarea round-trips custom groups unchanged')
})

// ---------------------------------------------------------------------------
// M2.10 — auto-review is its own content source, not the chat user
// ---------------------------------------------------------------------------

test('M2.10 the auto-review group renders beside user on Overview and Sources', () => {
  const { normalizeSummary, components } = captured.factory(fakeRequire).__test
  const tZh = makeT26('zh')
  const tEn = makeT26('en')
  const summary = normalizeSummary({
    totals: { promptTokens: 1000, outputTokens: 200, totalTokens: 1200, requests: 3 },
    byCategory: { user: 5, 'injected:auto-review': 990, 'tools:memory': 5 },
    byCategoryGroup: { user: 5, 'auto-review': 990, memory: 5 },
  })

  // The split is presentational: measured totals and the sum invariant are
  // unchanged, and both groups survive normalization.
  assert.equal(summary.totals.promptTokens, 1000, 'the group split never changes measured totals')
  assert.equal(summary.totals.totalTokens, 1200)
  assert.deepEqual(summary.byCategoryGroup, { user: 5, 'auto-review': 990, memory: 5 })
  const groupSum = Object.values(summary.byCategoryGroup).reduce((sum, value) => sum + value, 0)
  assert.equal(groupSum, 1000, 'groups still cover the full measured prompt')

  const overviewZh = textOfM26(components.OverviewTab({ summary, meta: null, t: tZh, channel: '' }))
  assert.ok(overviewZh.includes('用户'), 'Overview still renders the chat user group')
  assert.ok(overviewZh.includes('自动审查'), 'Overview renders the auto-review group')
  assert.ok(overviewZh.includes('990'), 'the auto-review segment keeps its tokens')
  assert.ok(overviewZh.indexOf('用户') < overviewZh.indexOf('自动审查'), 'the legend follows the canonical order')

  const overviewEn = textOfM26(components.OverviewTab({ summary, meta: null, t: tEn, channel: '' }))
  assert.ok(overviewEn.includes('User'))
  assert.ok(overviewEn.includes('Auto review'))
  assert.ok(overviewEn.includes('990'))

  const sourcesZh = textOfM26(components.SourcesTab({ summary, t: tZh }))
  assert.ok(sourcesZh.includes('自动审查'), 'Sources renders the auto-review group')
  assert.ok(sourcesZh.includes('自动审查输入'), 'the raw category detail uses the friendly label')
  assert.ok(!sourcesZh.includes('注入 · auto-review'), 'the raw category key is not used for the friendly label')

  const sourcesEn = textOfM26(components.SourcesTab({ summary, t: tEn }))
  assert.ok(sourcesEn.includes('Auto review'))
  assert.ok(sourcesEn.includes('Auto-review input'))
})

test('M2.10 the legend colors follow the canonical group order after the insertion', () => {
  const { categoryGroupEntries, components, seriesColor } = captured.factory(fakeRequire).__test
  const tZh = makeT26('zh')
  const allGroups = {
    user: 1,
    assistant: 1,
    developer: 1,
    reasoning: 1,
    'tool-call': 1,
    'tool-result': 1,
    'tool-decl': 1,
    memory: 1,
    skill: 1,
    'agent-teams': 1,
    history: 1,
    injected: 1,
    'auto-review': 1,
    system: 1,
    other: 1,
  }
  const entries = categoryGroupEntries(allGroups, tZh)
  assert.deepEqual(entries.map(entry => entry.key), Object.keys(allGroups))
  assert.equal(entries.findIndex(entry => entry.key === 'auto-review'), 12, 'auto-review occupies canonical index 12')
  assert.equal(entries.findIndex(entry => entry.key === 'system'), 13, 'system shifts one slot')
  assert.equal(entries.findIndex(entry => entry.key === 'other'), 14, 'other shifts one slot')

  const flat = flattenM26(components.StackedBar({ title: '来源', entries, t: tZh }))
  const segment = label => flat.find(node => (
    typeof node.props?.title === 'string' && node.props.title.startsWith(`${label}:`)
  ))
  // Colors are assigned by the rendered position, so every later group moves
  // one legend color after the insertion and no two neighbors share one.
  assert.equal(segment('自动审查').props.style.background, seriesColor(12))
  assert.equal(segment('系统提示').props.style.background, seriesColor(13))
  assert.equal(segment('其他').props.style.background, seriesColor(14))
  assert.notEqual(seriesColor(11), seriesColor(12), 'injected and auto-review keep different colors')
  assert.notEqual(seriesColor(12), seriesColor(13), 'auto-review and system keep different colors')
  assert.notEqual(seriesColor(13), seriesColor(14), 'system and other keep different colors')

  const dots = flat.filter(node => (
    node.type === 'span'
    && node.props?.style?.borderRadius === 999
    && typeof node.props.style.background === 'string'
  ))
  assert.deepEqual(dots.map(dot => dot.props.style.background), entries.map((entry, index) => seriesColor(index)))
})

test('M2.10 older Hosts without the group and unknown groups keep working', () => {
  const { normalizeSummary, categoryGroup, categoryGroupEntries, components } = captured.factory(fakeRequire).__test
  const tZh = makeT26('zh')

  // A pre-M2.10 Host classifies the synthetic auto-review user turn as `user`
  // and sends no auto-review group; the panel still renders it as before.
  const oldHost = normalizeSummary({
    totals: { promptTokens: 500, requests: 1 },
    byCategory: { user: 400, 'system:base': 100 },
  })
  assert.deepEqual(oldHost.byCategoryGroup, { user: 400, system: 100 })
  const oldText = textOfM26(components.SourcesTab({ summary: oldHost, t: tZh }))
  assert.ok(oldText.includes('用户'))
  assert.ok(oldText.includes('系统提示'))
  assert.ok(!oldText.includes('自动审查'), 'an old Host never invents the new group')
  assert.equal(categoryGroup('user'), 'user', 'plain user stays the chat user group')

  // The group map is accepted as a map or the forward-compatible array form.
  const arrayForm = normalizeSummary({
    byCategoryGroup: [{ group: 'auto-review', tokens: 30 }, { group: 'user', tokens: 7 }],
  })
  assert.deepEqual(arrayForm.byCategoryGroup, { 'auto-review': 30, user: 7 })

  // Unknown future groups are still appended after the canonical order.
  const future = normalizeSummary({ byCategoryGroup: { 'auto-review': 60, 'future-source': 10 } })
  const entries = categoryGroupEntries(future.byCategoryGroup, tZh)
  assert.deepEqual(entries.map(entry => entry.key), ['auto-review', 'future-source'])
  assert.equal(entries[1].label, 'future-source', 'an unknown group key stays raw')
})


