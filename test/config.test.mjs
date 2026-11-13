import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import {
  DEFAULT_CONFIG,
  DEFAULT_PRICE_VERSION,
  DEFAULT_PRICING,
  DEFAULT_PRICING_OFF_PEAK_DAYS,
  DEFAULT_TOOL_GROUPS,
  DEFAULT_WEB_API_PRICING,
  MAX_TOOL_GROUP_ENTRIES,
  RESTART_REQUIRED_FIELDS,
  cloneDefaultConfig,
  cloneDefaultPricing,
  cloneDefaultToolGroups,
  describeConfig,
  normalizeConfig,
  normalizeToolGroupName,
  normalizeWebApiPricing,
} from '../src/host/config.mjs'
import { isValidDayKey } from '../src/host/util.mjs'

const FIELDS = [
  'dataDir',
  'retainRequestDays',
  'retainDailyDays',
  'flushIntervalMs',
  'pricing',
  'pricingOffPeakDays',
  'webApiPricing',
  'toolGroups',
  'maxDetailRowsPerDay',
  'enableAutoRefresh',
  'rememberLastTab',
  'autoRefreshIntervalMs',
  'rpcChannel',
]

/**
 * The M2.8 default taxonomy, written out independently of the implementation
 * so both the entries and their matching order are pinned exactly.
 */
const EXPECTED_DEFAULT_TOOL_GROUPS = {
  memory: ['mnemon_'],
  skill: ['skill'],
  agentTeams: ['spawn_teammate', 'send_message', 'wait_agent', 'team_task_', 'list_agents', 'interrupt_agent'],
  files: ['read', 'write', 'edit', 'glob', 'grep', 'read_image', 'load_workspace_dependencies'],
  shell: ['pwsh', 'bash', 'terminal_'],
  web: ['web_search', 'web_fetch'],
  session: ['session_'],
  goals: ['create_goal', 'update_goal', 'get_goal'],
  schedule: ['schedule_'],
  subagents: ['subagent', 'list_subagent_models'],
  plugins: ['plugin_manager', 'plugin_market', 'cordis_'],
  browser: ['ego_'],
  workflow: ['workflow'],
}

/**
 * The official 2026-2027 State Council statutory holiday dates, written out
 * independently of the implementation so the default list is pinned exactly.
 */
const EXPECTED_HOLIDAYS = [
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
  '2026-10-06', '2026-10-07',
  '2027-01-01', '2027-01-02', '2027-01-03',
  '2027-02-05', '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-09',
  '2027-02-10', '2027-02-11', '2027-02-12', '2027-02-13',
  '2027-04-03', '2027-04-04', '2027-04-05',
  '2027-05-01', '2027-05-02', '2027-05-03', '2027-05-04', '2027-05-05',
  '2027-06-09',
  '2027-09-15',
  '2027-10-01', '2027-10-02', '2027-10-03', '2027-10-04', '2027-10-05',
  '2027-10-06', '2027-10-07',
]

test('normalizeConfig returns defaults for missing or non-object config', () => {
  for (const raw of [undefined, null]) {
    const { config, diagnostics } = normalizeConfig(raw)
    assert.deepEqual(config, cloneDefaultConfig())
    assert.deepEqual(diagnostics, [])
  }
  for (const raw of [42, 'nope', []]) {
    const { config, diagnostics } = normalizeConfig(raw)
    assert.deepEqual(config, cloneDefaultConfig())
    assert.equal(diagnostics.length, 1)
    assert.match(diagnostics[0], /expected an object/)
  }
})

test('normalizeConfig accepts a fully valid config without diagnostics', () => {
  const raw = {
    dataDir: '  D:/tmp/token-data  ',
    retainRequestDays: 90,
    retainDailyDays: 900,
    flushIntervalMs: 1000,
    pricing: [{
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      currency: 'CNY',
      inputPerMillion: 2,
      cacheReadPerMillion: 0.5,
      cacheWritePerMillion: 4,
      outputPerMillion: 8,
      offPeak: { inputPerMillion: 1, outputPerMillion: 4 },
      priceVersion: 'test-2026-11',
    }],
    pricingOffPeakDays: ['2026-11-03', '2026-12-25'],
    toolGroups: {
      memory: ['mem_'],
      skill: ['skill-x'],
      agentTeams: ['spawn_teammate'],
      'my-tools': ['custom_'],
    },
    maxDetailRowsPerDay: 1000,
    enableAutoRefresh: true,
    rememberLastTab: true,
    autoRefreshIntervalMs: 60000,
    rpcChannel: '/tokens',
  }
  const { config, diagnostics } = normalizeConfig(raw)
  assert.deepEqual(diagnostics, [])
  assert.equal(config.dataDir, 'D:/tmp/token-data')
  assert.equal(config.retainRequestDays, 90)
  assert.equal(config.retainDailyDays, 900)
  assert.equal(config.flushIntervalMs, 1000)
  assert.equal(config.maxDetailRowsPerDay, 1000)
  assert.equal(config.enableAutoRefresh, true)
  assert.equal(config.rememberLastTab, true)
  assert.equal(config.autoRefreshIntervalMs, 60000)
  assert.equal(config.rpcChannel, '/tokens')
  assert.deepEqual(config.toolGroups.memory, ['mem_'])
  assert.deepEqual(config.toolGroups.skill, ['skill-x'])
  assert.deepEqual(config.toolGroups.agentTeams, ['spawn_teammate'])
  assert.deepEqual(config.toolGroups['my-tools'], ['custom_'])
  assert.deepEqual(config.toolGroups.files, EXPECTED_DEFAULT_TOOL_GROUPS.files)
  assert.equal(config.pricing.length, 1)
  assert.equal(config.pricing[0].priceVersion, 'test-2026-11')
  assert.deepEqual(config.pricing[0].offPeak, { inputPerMillion: 1, outputPerMillion: 4 })
  assert.deepEqual(config.pricingOffPeakDays, ['2026-11-03', '2026-12-25'])
})

test('the default price table holds the two CNY tiered DeepSeek routes', () => {
  assert.equal(DEFAULT_CONFIG.pricing.length, 2)
  assert.equal(DEFAULT_PRICING.length, 2)
  assert.equal(DEFAULT_PRICE_VERSION, 'deepseek-2026-11')
  assert.deepEqual(DEFAULT_CONFIG.pricing.map(entry => entry.model), ['deepseek-flash', 'deepseek-v4-pro'])
  for (const entry of DEFAULT_CONFIG.pricing) {
    assert.equal(entry.provider, 'deepseek-official')
    assert.equal(entry.currency, 'CNY')
    assert.equal(entry.priceVersion, DEFAULT_PRICE_VERSION)
    assert.equal(entry.cacheWritePerMillion, 0)
    assert.ok(entry.inputPerMillion > 0)
    assert.ok(entry.outputPerMillion > entry.inputPerMillion)
  }
  const flash = DEFAULT_CONFIG.pricing[0]
  assert.deepEqual(flash, {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    currency: 'CNY',
    priceVersion: 'deepseek-2026-11',
    inputPerMillion: 2,
    cacheReadPerMillion: 0.04,
    cacheWritePerMillion: 0,
    outputPerMillion: 8,
    offPeak: {
      inputPerMillion: 1,
      cacheReadPerMillion: 0.02,
      cacheWritePerMillion: 0,
      outputPerMillion: 4,
    },
  })
  const pro = DEFAULT_CONFIG.pricing[1]
  assert.deepEqual({
    input: pro.inputPerMillion,
    cacheRead: pro.cacheReadPerMillion,
    cacheWrite: pro.cacheWritePerMillion,
    output: pro.outputPerMillion,
  }, { input: 9, cacheRead: 0.3, cacheWrite: 0, output: 27 })
  assert.deepEqual(pro.offPeak, {
    inputPerMillion: 4.5,
    cacheReadPerMillion: 0.15,
    cacheWritePerMillion: 0,
    outputPerMillion: 13.5,
  })
  // Official off-peak pricing is exactly half of the peak price on both routes.
  for (const entry of DEFAULT_CONFIG.pricing) {
    for (const key of ['inputPerMillion', 'cacheReadPerMillion', 'cacheWritePerMillion', 'outputPerMillion']) {
      assert.equal(entry.offPeak[key], entry[key] / 2, `${entry.model} ${key} off-peak is half of peak`)
    }
  }
  assert.deepEqual(DEFAULT_CONFIG.pricingOffPeakDays, EXPECTED_HOLIDAYS)
  assert.equal(DEFAULT_CONFIG.pricingOffPeakDays.length, 62)
  // A config that omits pricing keeps the default table.
  assert.deepEqual(normalizeConfig({}).config.pricing, cloneDefaultPricing())
  assert.deepEqual(normalizeConfig({}).config.pricing, DEFAULT_CONFIG.pricing)
})

test('an explicit empty pricing array still disables pricing', () => {
  const { config, diagnostics } = normalizeConfig({ pricing: [] })
  assert.deepEqual(config.pricing, [])
  assert.deepEqual(diagnostics, [])
  assert.notDeepEqual(config.pricing, DEFAULT_CONFIG.pricing)
})

test('pricing normalization returns detached copies of the default rows', () => {
  const first = normalizeConfig({}).config.pricing
  const second = normalizeConfig({ pricing: 'nope' }).config.pricing
  assert.deepEqual(second, first)
  assert.notEqual(first, DEFAULT_PRICING)
  assert.notEqual(first[0], DEFAULT_PRICING[0])
  first[0].inputPerMillion = 999
  assert.equal(DEFAULT_PRICING[0].inputPerMillion, 2)
  assert.equal(second[0].inputPerMillion, 2)
})

test('invalid field values fall back to defaults with one diagnostic each', () => {
  const { config, diagnostics } = normalizeConfig({
    dataDir: 5,
    retainRequestDays: 0,
    retainDailyDays: 4000,
    flushIntervalMs: 'soon',
    pricing: 'cheap',
    pricingOffPeakDays: 'holidays',
    webApiPricing: 'cheap',
    toolGroups: [],
    maxDetailRowsPerDay: -1,
    enableAutoRefresh: 'yes',
    rememberLastTab: 'yes',
    autoRefreshIntervalMs: 10,
    rpcChannel: 'api',
  })
  assert.deepEqual(config, cloneDefaultConfig())
  for (const field of FIELDS) {
    assert.ok(diagnostics.some(message => message.startsWith(`${field}:`)), `missing diagnostic for ${field}`)
  }
})

test('unknown config keys are reported and dropped', () => {
  const { config, diagnostics } = normalizeConfig({ mystery: true })
  assert.equal(Object.hasOwn(config, 'mystery'), false)
  assert.equal(diagnostics.length, 1)
  assert.match(diagnostics[0], /unknown key "mystery"/)
})

test('pricing drops malformed entries but keeps valid ones', () => {
  const { config, diagnostics } = normalizeConfig({
    pricing: [
      { provider: 'p', model: 'm', inputPerMillion: 1, outputPerMillion: 2 },
      { model: 'missing-provider' },
      { provider: 'p', inputPerMillion: -1 },
      'not-an-object',
    ],
  })
  assert.equal(config.pricing.length, 1)
  assert.deepEqual(config.pricing[0], {
    provider: 'p',
    model: 'm',
    currency: 'CNY',
    inputPerMillion: 1,
    cacheReadPerMillion: 0,
    cacheWritePerMillion: 0,
    outputPerMillion: 2,
  })
  assert.ok(diagnostics.length >= 3)
})

test('the default tool groups are the frozen M2.8 taxonomy in matching order', () => {
  assert.deepEqual(DEFAULT_TOOL_GROUPS, EXPECTED_DEFAULT_TOOL_GROUPS)
  assert.deepEqual(Object.keys(DEFAULT_TOOL_GROUPS), Object.keys(EXPECTED_DEFAULT_TOOL_GROUPS))
  assert.deepEqual(DEFAULT_CONFIG.toolGroups, EXPECTED_DEFAULT_TOOL_GROUPS)
  assert.equal(Object.isFrozen(DEFAULT_CONFIG), true)
  assert.equal(Object.isFrozen(DEFAULT_TOOL_GROUPS), true)
  for (const [group, list] of Object.entries(EXPECTED_DEFAULT_TOOL_GROUPS)) {
    assert.equal(Object.isFrozen(DEFAULT_TOOL_GROUPS[group]), true, `${group} list is frozen`)
    assert.equal(new Set(list).size, list.length, `${group} has no duplicate entries`)
    for (const entry of list) {
      assert.equal(typeof entry, 'string')
      assert.ok(entry.length > 0)
    }
  }
  // The historical camel-case key survives even though its output group is
  // `agent-teams`; no `agent-teams` config key is shipped.
  assert.ok(Object.hasOwn(DEFAULT_TOOL_GROUPS, 'agentTeams'))
  assert.equal(Object.hasOwn(DEFAULT_TOOL_GROUPS, 'agent-teams'), false)
})

test('cloneDefaultToolGroups and cloneDefaultConfig detach every group', () => {
  const clone = cloneDefaultToolGroups()
  const configClone = cloneDefaultConfig().toolGroups
  assert.deepEqual(clone, EXPECTED_DEFAULT_TOOL_GROUPS)
  assert.notEqual(clone, DEFAULT_TOOL_GROUPS)
  assert.notEqual(configClone, DEFAULT_TOOL_GROUPS)
  for (const group of Object.keys(EXPECTED_DEFAULT_TOOL_GROUPS)) {
    assert.notEqual(clone[group], DEFAULT_TOOL_GROUPS[group], `${group} list is detached`)
    clone[group].push('mutated_')
    configClone[group].push('mutated_')
    assert.deepEqual(DEFAULT_TOOL_GROUPS[group], EXPECTED_DEFAULT_TOOL_GROUPS[group], `${group} default is unchanged`)
    assert.deepEqual(DEFAULT_CONFIG.toolGroups[group], EXPECTED_DEFAULT_TOOL_GROUPS[group])
  }
  assert.equal(clone.workflow.length, EXPECTED_DEFAULT_TOOL_GROUPS.workflow.length + 1)
  assert.equal(cloneDefaultToolGroups().workflow.length, EXPECTED_DEFAULT_TOOL_GROUPS.workflow.length)
  assert.deepEqual(cloneDefaultToolGroups(), EXPECTED_DEFAULT_TOOL_GROUPS)
})

test('toolGroups keeps defaults for absent groups and accepts arbitrary groups', () => {
  const { config, diagnostics } = normalizeConfig({
    toolGroups: { memory: ['mem_'], 'my-tools': ['custom_'] },
  })
  assert.deepEqual(diagnostics, [])
  assert.deepEqual(config.toolGroups.memory, ['mem_'])
  assert.deepEqual(config.toolGroups['my-tools'], ['custom_'])
  for (const [group, list] of Object.entries(EXPECTED_DEFAULT_TOOL_GROUPS)) {
    if (group === 'memory') continue
    assert.deepEqual(config.toolGroups[group], list, `${group} keeps its default`)
  }
  // A new group is appended after the built-in groups, preserving default order.
  assert.deepEqual(Object.keys(config.toolGroups), [...Object.keys(EXPECTED_DEFAULT_TOOL_GROUPS), 'my-tools'])
})

test('toolGroups rejects invalid group names and case-insensitive duplicates', () => {
  const thirtyThree = 'b'.repeat(33)
  const { config, diagnostics } = normalizeConfig({
    toolGroups: {
      '': ['x'],
      Bad: ['x'],
      'has space': ['x'],
      other: ['x'],
      '123': ['x'],
      [thirtyThree]: ['x'],
      agentteams: ['x'],
    },
  })
  assert.deepEqual(config.toolGroups, cloneDefaultConfig().toolGroups)
  assert.equal(diagnostics.length, 7)
  for (const key of ['', 'Bad', 'has space', 'other', '123', thirtyThree]) {
    assert.ok(
      diagnostics.some(message => message.startsWith(`toolGroups.${key}:`) && /invalid group name/.test(message)),
      `missing invalid-name diagnostic for ${JSON.stringify(key)}`,
    )
  }
  assert.ok(diagnostics.some(message => message.startsWith('toolGroups.agentteams:') && /duplicate/.test(message)))
})

test('toolGroups falls back or skips malformed values and enforces the entry cap', () => {
  const many = Array.from({ length: MAX_TOOL_GROUP_ENTRIES }, (_, index) => `tool_${index}`)
  const tooMany = [...many, 'one_more']

  // A malformed value for a built-in group keeps its default, independently.
  const defaults = normalizeConfig({
    toolGroups: { files: 'not-an-array', shell: [42], web: [''], session: tooMany },
  })
  assert.deepEqual(defaults.config.toolGroups, cloneDefaultConfig().toolGroups)
  assert.equal(defaults.diagnostics.length, 4)
  for (const group of ['files', 'shell', 'web', 'session']) {
    assert.ok(defaults.diagnostics.some(message => message.startsWith(`toolGroups.${group}:`) && /using default/.test(message)))
  }

  // A malformed value for a user-defined group skips the whole group.
  const custom = normalizeConfig({
    toolGroups: {
      'bad-new': 'nope',
      'also-bad': [1],
      'blank-entry': ['  '],
      'too-many': tooMany,
      'at-cap': many,
    },
  })
  assert.deepEqual(custom.diagnostics.length, 4)
  assert.equal(Object.hasOwn(custom.config.toolGroups, 'bad-new'), false)
  assert.equal(Object.hasOwn(custom.config.toolGroups, 'also-bad'), false)
  assert.equal(Object.hasOwn(custom.config.toolGroups, 'blank-entry'), false)
  assert.equal(Object.hasOwn(custom.config.toolGroups, 'too-many'), false)
  assert.deepEqual(custom.config.toolGroups['at-cap'], many)
  assert.ok(custom.diagnostics.some(message => message.startsWith('toolGroups.too-many:') && /group ignored/.test(message)))
  assert.equal(custom.config.toolGroups.files.length, EXPECTED_DEFAULT_TOOL_GROUPS.files.length)
})

test('invalid toolGroups groups fall back independently', () => {
  const { config, diagnostics } = normalizeConfig({
    toolGroups: { memory: 'mnemon_', skill: 42, agentTeams: [1] },
  })
  assert.deepEqual(config.toolGroups, cloneDefaultConfig().toolGroups)
  assert.equal(diagnostics.length, 3)
})

test('an empty toolGroups list disables that group without a diagnostic', () => {
  const { config, diagnostics } = normalizeConfig({ toolGroups: { skill: [], 'my-tools': [] } })
  assert.deepEqual(config.toolGroups.skill, [])
  assert.deepEqual(config.toolGroups['my-tools'], [])
  assert.deepEqual(config.toolGroups.memory, cloneDefaultConfig().toolGroups.memory)
  assert.deepEqual(diagnostics, [])
})

test('normalizeToolGroupName validates the key shape and keeps the historical key', () => {
  for (const valid of ['memory', 'files', 'a', 'a1-b2', 'agent-teams', 'x'.repeat(32), 'agentTeams']) {
    assert.equal(normalizeToolGroupName(valid), valid, valid)
  }
  for (const invalid of ['', 'other', 'Other', 'foo_bar', 'foo bar', 'Foo', 'x'.repeat(33), 42, null, undefined, ['memory']]) {
    assert.equal(normalizeToolGroupName(invalid), null, JSON.stringify(invalid))
  }
  // Group values are trimmed by normalizeConfig; the name helper only validates
  // keys and never mutates the input.
  const { config, diagnostics } = normalizeConfig({ toolGroups: { 'my-tools': ['  custom_  '] } })
  assert.deepEqual(diagnostics, [])
  assert.deepEqual(config.toolGroups['my-tools'], ['custom_'])
})

test('rpcChannel enforces a single safe segment and rejects /api', () => {
  assert.equal(normalizeConfig({ rpcChannel: '/token-attribution' }).config.rpcChannel, '/token-attribution')
  for (const bad of ['api', '/a/b', '/api', '/bad channel', '', 42]) {
    const { config, diagnostics } = normalizeConfig({ rpcChannel: bad })
    assert.equal(config.rpcChannel, '/token-attribution')
    assert.ok(diagnostics.some(message => message.startsWith('rpcChannel:')))
  }
})

test('describeConfig exposes stable field metadata', () => {
  const fields = describeConfig()
  assert.deepEqual(Object.keys(fields), FIELDS)
  assert.equal(fields.dataDir.restartRequired, true)
  assert.equal(fields.dataDir.editable, true)
  assert.equal(fields.rpcChannel.restartRequired, true)
  assert.equal(fields.retainRequestDays.default, 30)
  assert.equal(fields.enableAutoRefresh.type, 'boolean')
  assert.equal(fields.rememberLastTab.type, 'boolean')
  assert.equal(fields.rememberLastTab.default, false)
  assert.equal(fields.rememberLastTab.editable, true)
  assert.equal(fields.rememberLastTab.restartRequired, false)
  assert.match(fields.rememberLastTab.description, /last opened/)
  assert.match(fields.rememberLastTab.description, /Overview/)
  // The descriptor order and the default object order must stay in sync, and
  // `config.get` therefore reports 13 fields.
  assert.deepEqual(Object.keys(DEFAULT_CONFIG), FIELDS)
  assert.equal(FIELDS.length, 13)
  assert.equal(fields.pricing.default.length, 2)
  assert.deepEqual(fields.pricing.default, cloneDefaultPricing())
  assert.match(fields.pricing.description, /peak-hour/)
  assert.match(fields.pricing.description, /Asia\/Shanghai/)
  assert.match(fields.pricing.description, /offPeak/)
  assert.equal(fields.pricingOffPeakDays.type, 'array')
  assert.deepEqual(fields.pricingOffPeakDays.default, EXPECTED_HOLIDAYS)
  assert.equal(fields.pricingOffPeakDays.editable, true)
  assert.match(fields.pricingOffPeakDays.description, /Asia\/Shanghai/)
  assert.match(fields.pricingOffPeakDays.description, /2026-2027/)
  assert.equal(fields.webApiPricing.type, 'object')
  assert.deepEqual(fields.webApiPricing.default, DEFAULT_WEB_API_PRICING)
  assert.equal(fields.webApiPricing.editable, true)
  assert.equal(fields.webApiPricing.restartRequired, false)
  assert.match(fields.webApiPricing.description, /1000/)
  assert.match(fields.webApiPricing.description, /estimate/)
  assert.equal(fields.toolGroups.type, 'object')
  assert.deepEqual(fields.toolGroups.default, EXPECTED_DEFAULT_TOOL_GROUPS)
  assert.notEqual(fields.toolGroups.default, DEFAULT_TOOL_GROUPS)
  for (const group of Object.keys(EXPECTED_DEFAULT_TOOL_GROUPS)) {
    assert.notEqual(fields.toolGroups.default[group], DEFAULT_TOOL_GROUPS[group], `${group} describe default is detached`)
  }
  assert.match(fields.toolGroups.description, /first match wins/)
  assert.match(fields.toolGroups.description, /agentTeams/)
  assert.match(fields.toolGroups.description, /agent-teams/)
  assert.ok(RESTART_REQUIRED_FIELDS.includes('dataDir'))
  assert.ok(RESTART_REQUIRED_FIELDS.includes('rpcChannel'))
  assert.equal(RESTART_REQUIRED_FIELDS.length, 2)
})

test('rememberLastTab accepts only real booleans and defaults to off', () => {
  assert.equal(DEFAULT_CONFIG.rememberLastTab, false)
  assert.equal(Object.isFrozen(DEFAULT_CONFIG), true, 'the default config object is frozen')
  assert.equal(normalizeConfig({}).config.rememberLastTab, false)

  const enabled = normalizeConfig({ rememberLastTab: true })
  assert.equal(enabled.config.rememberLastTab, true)
  assert.deepEqual(enabled.diagnostics, [])
  assert.equal(normalizeConfig({ rememberLastTab: false }).config.rememberLastTab, false)

  // Every non-boolean (including truthy lookalikes) falls back with one diagnostic.
  for (const bad of [0, 1, 'true', 'false', null, [], {}]) {
    const { config, diagnostics } = normalizeConfig({ rememberLastTab: bad })
    assert.equal(config.rememberLastTab, false, String(bad))
    assert.deepEqual(diagnostics, [
      'rememberLastTab: expected a boolean; using default false',
    ])
  }

  // A live client-panel preference: changing it never requires a reload.
  assert.equal(RESTART_REQUIRED_FIELDS.includes('rememberLastTab'), false)
  assert.equal(describeConfig().rememberLastTab.restartRequired, false)

  // The default is a primitive, so a mutated clone can never leak into it.
  const clone = cloneDefaultConfig()
  clone.rememberLastTab = true
  assert.equal(DEFAULT_CONFIG.rememberLastTab, false)
  assert.equal(cloneDefaultConfig().rememberLastTab, false)
})

test('dataDir rejects relative paths and accepts absolute or empty', () => {
  assert.equal(normalizeConfig({ dataDir: '' }).config.dataDir, '')
  const absolute = path.resolve('token-attribution-test-data')
  assert.equal(normalizeConfig({ dataDir: absolute }).config.dataDir, absolute)
  for (const bad of ['relative/dir', '.\\data', '~\\data']) {
    const { config, diagnostics } = normalizeConfig({ dataDir: bad })
    assert.equal(config.dataDir, '')
    assert.ok(diagnostics.some(message => message.startsWith('dataDir:')), `expected dataDir diagnostic for ${bad}`)
  }
})

test('cloneDefaultConfig detaches nested defaults', () => {
  const clone = cloneDefaultConfig()
  clone.toolGroups.memory.push('added_')
  clone.pricing.push({ provider: 'x' })
  clone.pricing[0].inputPerMillion = 999
  clone.pricing[0].offPeak.inputPerMillion = 999
  clone.pricingOffPeakDays.push('2030-01-01')
  clone.webApiPricing.searchPerThousand = 999
  assert.equal(DEFAULT_CONFIG.rememberLastTab, false)
  assert.equal(clone.rememberLastTab, false)
  assert.equal(Object.isFrozen(DEFAULT_CONFIG), true)
  assert.deepEqual(DEFAULT_CONFIG.toolGroups.memory, ['mnemon_'])
  assert.equal(DEFAULT_CONFIG.pricing.length, 2)
  assert.equal(DEFAULT_CONFIG.pricing[0].inputPerMillion, 2)
  assert.equal(DEFAULT_CONFIG.pricing[0].offPeak.inputPerMillion, 1)
  assert.deepEqual(DEFAULT_CONFIG.pricingOffPeakDays, EXPECTED_HOLIDAYS)
  assert.equal(DEFAULT_CONFIG.webApiPricing.searchPerThousand, 5)
  assert.equal(clone.pricing.length, 3)
  assert.equal(clone.pricingOffPeakDays.length, EXPECTED_HOLIDAYS.length + 1)
  assert.equal(clone.pricingOffPeakDays.at(-1), '2030-01-01')
  assert.equal(clone.webApiPricing.searchPerThousand, 999)
  assert.notDeepEqual(clone.toolGroups.memory, DEFAULT_CONFIG.toolGroups.memory)
  assert.notEqual(clone.pricing[0], DEFAULT_CONFIG.pricing[0])
  assert.notEqual(clone.pricing[0].offPeak, DEFAULT_CONFIG.pricing[0].offPeak)
  assert.notEqual(clone.pricingOffPeakDays, DEFAULT_CONFIG.pricingOffPeakDays)
  assert.notEqual(clone.webApiPricing, DEFAULT_CONFIG.webApiPricing)
  // The default rows and their container are frozen so shared defaults cannot
  // be mutated by a consumer that forgets to clone.
  assert.equal(Object.isFrozen(DEFAULT_CONFIG.pricing), true)
  assert.equal(Object.isFrozen(DEFAULT_CONFIG.pricing[0]), true)
  assert.equal(Object.isFrozen(DEFAULT_CONFIG.pricing[0].offPeak), true)
  assert.equal(Object.isFrozen(DEFAULT_CONFIG.pricingOffPeakDays), true)
  assert.equal(Object.isFrozen(DEFAULT_CONFIG.webApiPricing), true)
})

test('pricing offPeak overrides validate per field and fall back to peak when absent', () => {
  const { config, diagnostics } = normalizeConfig({
    pricing: [
      {
        provider: 'p',
        model: 'partial',
        inputPerMillion: 10,
        cacheReadPerMillion: 2,
        cacheWritePerMillion: 4,
        outputPerMillion: 20,
        offPeak: { inputPerMillion: 5, cacheWritePerMillion: 0 },
      },
      { provider: 'p', model: 'empty', inputPerMillion: 2, offPeak: {} },
      { provider: 'p', model: 'not-object', inputPerMillion: 2, offPeak: 'half' },
      { provider: 'p', model: 'bad-field', inputPerMillion: 2, offPeak: { inputPerMillion: -1, mystery: 1 } },
      { provider: 'p', model: 'null', inputPerMillion: 2, offPeak: null },
    ],
  })
  assert.equal(config.pricing.length, 5, 'a bad offPeak override never discards the peak row')
  // Only the supplied override fields are kept, so later peak edits propagate
  // to every field the user did not override.
  assert.deepEqual(config.pricing[0].offPeak, { inputPerMillion: 5, cacheWritePerMillion: 0 })
  assert.equal(config.pricing[0].inputPerMillion, 10)
  assert.equal(Object.hasOwn(config.pricing[1], 'offPeak'), false, 'an empty offPeak means peak prices')
  assert.equal(Object.hasOwn(config.pricing[2], 'offPeak'), false)
  assert.equal(Object.hasOwn(config.pricing[3], 'offPeak'), false)
  assert.equal(Object.hasOwn(config.pricing[4], 'offPeak'), false)
  assert.ok(diagnostics.some(message => message.startsWith('pricing[2].offPeak:')))
  assert.ok(diagnostics.some(message => message.startsWith('pricing[3].offPeak.inputPerMillion:')))
  assert.ok(diagnostics.some(message => message.startsWith('pricing[3].offPeak.mystery:')))
  assert.deepEqual(diagnostics.filter(message => message.startsWith('pricing[1]') || message.startsWith('pricing[4]')), [])
})

test('the default off-peak day list is the exact 2026-2027 statutory holiday set', () => {
  assert.equal(DEFAULT_PRICING_OFF_PEAK_DAYS.length, 62)
  assert.deepEqual([...DEFAULT_PRICING_OFF_PEAK_DAYS], EXPECTED_HOLIDAYS)
  assert.deepEqual(DEFAULT_CONFIG.pricingOffPeakDays, EXPECTED_HOLIDAYS)
  assert.equal(new Set(EXPECTED_HOLIDAYS).size, 62, 'no duplicate holiday date')
  assert.deepEqual([...EXPECTED_HOLIDAYS].sort(), EXPECTED_HOLIDAYS, 'dates are listed ascending')
  for (const day of EXPECTED_HOLIDAYS) {
    assert.equal(isValidDayKey(day), true, `invalid day key ${day}`)
    assert.match(day, /^(2026|2027)-/)
  }
  assert.equal(EXPECTED_HOLIDAYS.filter(day => day.startsWith('2026')).length, 33)
  assert.equal(EXPECTED_HOLIDAYS.filter(day => day.startsWith('2027')).length, 29)
  // Spot-check each notice block's first/last day.
  for (const day of ['2026-01-01', '2026-02-15', '2026-02-23', '2026-04-06', '2026-05-01', '2026-06-21', '2026-09-25', '2026-10-07',
    '2027-01-03', '2027-02-05', '2027-02-13', '2027-04-03', '2027-05-05', '2027-06-09', '2027-09-15', '2027-10-01']) {
    assert.ok(EXPECTED_HOLIDAYS.includes(day), `missing holiday ${day}`)
  }
  assert.equal(Object.isFrozen(DEFAULT_PRICING_OFF_PEAK_DAYS), true)
  assert.equal(Object.isFrozen(DEFAULT_CONFIG.pricingOffPeakDays), true)
})

test('pricingOffPeakDays validates day keys, dedupes, and defaults to the holiday list', () => {
  assert.deepEqual(normalizeConfig({}).config.pricingOffPeakDays, EXPECTED_HOLIDAYS)
  // An explicit empty list disables holiday pricing rather than restoring defaults.
  assert.deepEqual(normalizeConfig({ pricingOffPeakDays: [] }).config.pricingOffPeakDays, [])
  assert.deepEqual(normalizeConfig({ pricingOffPeakDays: undefined }).config.pricingOffPeakDays, EXPECTED_HOLIDAYS)

  const { config, diagnostics } = normalizeConfig({
    pricingOffPeakDays: ['2026-11-03', 'holiday', '2026-11-03', '2026-02-30', '2026-12-25', 42],
  })
  assert.deepEqual(config.pricingOffPeakDays, ['2026-11-03', '2026-12-25'])
  assert.deepEqual(diagnostics, [
    'pricingOffPeakDays[1]: expected a valid YYYY-MM-DD date; entry ignored',
    'pricingOffPeakDays[3]: expected a valid YYYY-MM-DD date; entry ignored',
    'pricingOffPeakDays[5]: expected a valid YYYY-MM-DD date; entry ignored',
  ])

  const bad = normalizeConfig({ pricingOffPeakDays: '2026-11-03' })
  assert.deepEqual(bad.config.pricingOffPeakDays, EXPECTED_HOLIDAYS)
  assert.ok(bad.diagnostics.some(message => message.startsWith('pricingOffPeakDays:')))

  // The normalized list is a detached copy, never the default or raw array.
  const raw = ['2026-11-03']
  const normalized = normalizeConfig({ pricingOffPeakDays: raw }).config.pricingOffPeakDays
  assert.notEqual(normalized, raw)
  normalized.push('2026-12-25')
  assert.deepEqual(raw, ['2026-11-03'])
  assert.deepEqual(DEFAULT_CONFIG.pricingOffPeakDays, EXPECTED_HOLIDAYS)
})

test('webApiPricing defaults, normalizes, and detaches', () => {
  assert.deepEqual(DEFAULT_WEB_API_PRICING, { searchPerThousand: 5, fetchPerThousand: 5, currency: 'CNY' })
  assert.equal(Object.isFrozen(DEFAULT_WEB_API_PRICING), true)
  assert.deepEqual(DEFAULT_CONFIG.webApiPricing, DEFAULT_WEB_API_PRICING)
  assert.deepEqual(normalizeConfig({}).config.webApiPricing, DEFAULT_WEB_API_PRICING)

  // A valid custom block is accepted without diagnostics.
  const custom = normalizeConfig({ webApiPricing: { searchPerThousand: 12.5, fetchPerThousand: 0, currency: 'USD' } })
  assert.deepEqual(custom.diagnostics, [])
  assert.deepEqual(custom.config.webApiPricing, { searchPerThousand: 12.5, fetchPerThousand: 0, currency: 'USD' })

  // Absent fields keep their defaults; zero is a valid price.
  const partial = normalizeConfig({ webApiPricing: { fetchPerThousand: 0 } })
  assert.deepEqual(partial.diagnostics, [])
  assert.deepEqual(partial.config.webApiPricing, { searchPerThousand: 5, fetchPerThousand: 0, currency: 'CNY' })

  // Each malformed field falls back on its own, with one diagnostic each.
  const invalid = normalizeConfig({
    webApiPricing: { searchPerThousand: -1, fetchPerThousand: 'cheap', currency: '  ', mystery: 1 },
  })
  assert.deepEqual(invalid.config.webApiPricing, DEFAULT_WEB_API_PRICING)
  assert.deepEqual(invalid.diagnostics, [
    'webApiPricing.searchPerThousand: expected a non-negative number; using default 5',
    'webApiPricing.fetchPerThousand: expected a non-negative number; using default 5',
    'webApiPricing.currency: expected a non-empty string; using default CNY',
    'webApiPricing.mystery: unknown key ignored',
  ])

  // A non-object value falls back to the whole default block.
  for (const value of ['cheap', null, [], 42]) {
    const bad = normalizeConfig({ webApiPricing: value })
    assert.deepEqual(bad.config.webApiPricing, DEFAULT_WEB_API_PRICING, JSON.stringify(value))
    assert.deepEqual(bad.diagnostics, ['webApiPricing: expected an object; using defaults'])
  }

  // normalizeWebApiPricing(undefined) preserves the defaults without diagnostics.
  const diagnostics = []
  assert.deepEqual(normalizeWebApiPricing(undefined, diagnostics), DEFAULT_WEB_API_PRICING)
  assert.deepEqual(diagnostics, [])

  // Normalized blocks are detached copies of the frozen default.
  const first = normalizeConfig({}).config.webApiPricing
  const second = normalizeConfig({}).config.webApiPricing
  assert.notEqual(first, DEFAULT_WEB_API_PRICING)
  first.searchPerThousand = 99
  assert.equal(second.searchPerThousand, 5)
  assert.equal(DEFAULT_WEB_API_PRICING.searchPerThousand, 5)
})

test('legacy M2.1 peak-only default rows gain the official off-peak tier', () => {
  const legacyRows = [
    { provider: 'deepseek-official', model: 'deepseek-flash', currency: 'CNY', priceVersion: 'deepseek-2026-11-peak', inputPerMillion: 2, cacheReadPerMillion: 0.04, cacheWritePerMillion: 0, outputPerMillion: 8 },
    { provider: 'deepseek-official', model: 'deepseek-v4-pro', currency: 'CNY', priceVersion: 'deepseek-2026-11-peak', inputPerMillion: 9, cacheReadPerMillion: 0.3, cacheWritePerMillion: 0, outputPerMillion: 27 },
    { provider: 'deepseek-official', model: 'deepseek-flash', currency: 'CNY', priceVersion: 'deepseek-2026-11-peak', inputPerMillion: 3, outputPerMillion: 9 },
    { provider: 'custom', model: 'm', currency: 'CNY', priceVersion: 'deepseek-2026-11-peak', inputPerMillion: 2, cacheReadPerMillion: 0.04, outputPerMillion: 8 },
  ]
  const { config } = normalizeConfig({ pricing: legacyRows })
  assert.deepEqual(config.pricing[0].offPeak, {
    inputPerMillion: 1, cacheReadPerMillion: 0.02, cacheWritePerMillion: 0, outputPerMillion: 4,
  })
  assert.deepEqual(config.pricing[1].offPeak, {
    inputPerMillion: 4.5, cacheReadPerMillion: 0.15, cacheWritePerMillion: 0, outputPerMillion: 13.5,
  })
  assert.equal(config.pricing[2].offPeak, undefined, 'a custom peak is never rewritten')
  assert.equal(config.pricing[3].offPeak, undefined, 'a custom provider is never rewritten')
})
