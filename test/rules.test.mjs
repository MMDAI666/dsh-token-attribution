import assert from 'node:assert/strict'
import test from 'node:test'

import { cloneDefaultConfig } from '../src/host/config.mjs'
import {
  categoryGroup,
  categoryToolGroup,
  sourceCategory,
  systemSectionCategory,
  toolGroup,
} from '../src/host/rules.mjs'

const config = cloneDefaultConfig()

test('toolGroup matches the default M2.8 taxonomy and keeps unknown tool names', () => {
  const matches = [
    ['mnemon_recall', 'memory'],
    ['mnemon_status', 'memory'],
    ['skill', 'skill'],
    ['skill-catalog', 'skill'],
    ['spawn_teammate', 'agent-teams'],
    ['send_message', 'agent-teams'],
    ['team_task_create', 'agent-teams'],
    ['list_agents', 'agent-teams'],
    ['interrupt_agent', 'agent-teams'],
    ['read', 'files'],
    ['read_image', 'files'],
    ['write', 'files'],
    ['edit', 'files'],
    ['glob', 'files'],
    ['grep', 'files'],
    ['load_workspace_dependencies', 'files'],
    ['pwsh', 'shell'],
    ['bash', 'shell'],
    ['terminal_open', 'shell'],
    ['terminal_list', 'shell'],
    ['web_search', 'web'],
    ['web_fetch', 'web'],
    ['session_search', 'session'],
    ['session_list', 'session'],
    ['create_goal', 'goals'],
    ['update_goal', 'goals'],
    ['get_goal', 'goals'],
    ['schedule_create', 'schedule'],
    ['schedule_list', 'schedule'],
    ['subagent', 'subagents'],
    ['subagent_fork', 'subagents'],
    ['list_subagent_models', 'subagents'],
    ['plugin_manager', 'plugins'],
    ['plugin_market', 'plugins'],
    ['cordis_inspect_list', 'plugins'],
    ['ego_click', 'browser'],
    ['workflow', 'workflow'],
    ['read_more', 'files'],
    ['unknown', 'other:unknown'],
    ['', 'other:unknown'],
  ]
  for (const [name, group] of matches) assert.equal(toolGroup(name, config), group, name)
  assert.equal(toolGroup(undefined, config), 'other:unknown')
  // `session_` is a prefix entry, so a bare `session` stays unattributed.
  assert.equal(toolGroup('session', config), 'other:session')
  // A missing config falls back to the frozen built-in groups.
  assert.equal(toolGroup('read'), 'files')
  assert.equal(toolGroup('read', {}), 'files')
  assert.equal(toolGroup('read', { toolGroups: null }), 'files')
  // agentTeams is the one historical key with a different output group name.
  assert.equal(toolGroup('send_message', config), 'agent-teams')
  assert.notEqual(toolGroup('send_message', config), 'agentTeams')
})

test('toolGroup honors configured group order and the first match wins', () => {
  const ordered = cloneDefaultConfig()
  // A tool listed in two built-in groups goes to the earlier one.
  ordered.toolGroups.memory = ['grep']
  assert.equal(toolGroup('grep', ordered), 'memory')
  assert.equal(toolGroup('read', ordered), 'files')

  // Custom groups append after the built-ins, so an earlier default match wins.
  ordered.toolGroups['custom-tools'] = ['read', 'web_']
  assert.equal(toolGroup('read', ordered), 'files')
  assert.equal(toolGroup('web_search', ordered), 'web')

  // Disabling the earlier built-in group exposes the later custom match.
  ordered.toolGroups.files = []
  ordered.toolGroups.web = []
  assert.equal(toolGroup('read', ordered), 'custom-tools')
  assert.equal(toolGroup('web_search', ordered), 'custom-tools')
  assert.equal(toolGroup('web_fetch', ordered), 'custom-tools')

  // An explicitly ordered group object overrides the default order.
  const browserFirst = { toolGroups: { browser: ['ego_'], 'custom-tools': ['ego_'] } }
  assert.equal(toolGroup('ego_click', browserFirst), 'browser')
  const customFirst = { toolGroups: { 'custom-tools': ['ego_'], browser: ['ego_'] } }
  assert.equal(toolGroup('ego_click', customFirst), 'custom-tools')
})

test('custom tool groups report their key verbatim and empty groups are disabled', () => {
  const custom = cloneDefaultConfig()
  custom.toolGroups['my-tools'] = ['my_']
  assert.equal(toolGroup('my_tool', custom), 'my-tools')
  assert.equal(toolGroup('mnemon_recall', custom), 'memory')

  const disabled = cloneDefaultConfig()
  disabled.toolGroups.files = []
  assert.equal(toolGroup('read', disabled), 'other:read')
  assert.equal(toolGroup('read_image', disabled), 'other:read_image')
  assert.equal(toolGroup('grep', disabled), 'other:grep')
  assert.equal(toolGroup('mnemon_recall', disabled), 'memory')

  assert.equal(toolGroup('mnemon_recall', { toolGroups: { memory: [], skill: [], agentTeams: [] } }), 'other:mnemon_recall')
  assert.equal(toolGroup('memory_search', { toolGroups: { memory: ['mem_'], skill: [], agentTeams: [] } }), 'other:memory_search')
})

test('sourceCategory maps real producer kinds and falls through unknown ones', () => {
  assert.equal(sourceCategory(undefined), 'user')
  assert.equal(sourceCategory({}), 'user')
  assert.equal(sourceCategory({ kind: 'user' }), 'user')
  assert.equal(sourceCategory({ kind: 'direct-human' }), 'user')
  assert.equal(sourceCategory({ kind: 'dsh-mnemon', form: 'snapshot' }), 'injected:memory-snapshot')
  assert.equal(sourceCategory({ kind: 'dsh-mnemon', form: 'recall' }), 'injected:memory-recall')
  assert.equal(sourceCategory({ kind: 'dsh-mnemon', form: 'instructions' }), 'injected:memory-instructions')
  assert.equal(sourceCategory({ kind: 'dsh-mnemon' }), 'injected:memory')
  assert.equal(sourceCategory({ kind: 'mnemon-recall' }), 'injected:memory')
  assert.equal(sourceCategory({ kind: 'memory-recall' }), 'injected:memory-recall')
  assert.equal(sourceCategory({ kind: 'skill-catalog' }), 'injected:skill-catalog')
  assert.equal(sourceCategory({ kind: 'skill-invocation' }), 'injected:skill-invocation')
  assert.equal(sourceCategory({ kind: 'agent-instructions' }), 'injected:agent-instructions')
  assert.equal(sourceCategory({ kind: 'runtime-context' }), 'injected:runtime-context')
  assert.equal(sourceCategory({ kind: 'time-context' }), 'injected:time-context')
  assert.equal(sourceCategory({ kind: 'working-directory' }), 'injected:working-directory')
  assert.equal(sourceCategory({ kind: 'tmux-context' }), 'injected:runtime-context')
  assert.equal(sourceCategory({ kind: 'compact-checkpoint' }), 'injected:compact-checkpoint')
  for (const kind of [
    'subagent-settled',
    'tool-jobs',
    'agent-message',
    'session-reference',
    'user-approval',
    'repeat-tool-reminder',
    'team-message',
  ]) {
    assert.equal(sourceCategory({ kind }), 'injected:notices', kind)
  }
  assert.equal(sourceCategory({ kind: 'custom-kind' }), 'injected:custom-kind')
})

test('systemSectionCategory keeps stable system: names', () => {
  assert.equal(systemSectionCategory('harness:identity'), 'system:harness:identity')
  assert.equal(systemSectionCategory('mnemon-memory'), 'system:mnemon-memory')
  assert.equal(systemSectionCategory('  base  '), 'system:base')
  assert.equal(systemSectionCategory('system:already'), 'system:already')
  assert.equal(systemSectionCategory(''), 'system:unknown')
})

test('categoryToolGroup extracts tool groups from categories', () => {
  assert.equal(categoryToolGroup('tools:memory'), 'memory')
  assert.equal(categoryToolGroup('tools:files'), 'files')
  assert.equal(categoryToolGroup('tools:subagents'), 'subagents')
  assert.equal(categoryToolGroup('tools:my-tools'), 'my-tools')
  assert.equal(categoryToolGroup('tool-result:other:read'), 'other:read')
  assert.equal(categoryToolGroup('tool-result:shell'), 'shell')
  assert.equal(categoryToolGroup('tools:history'), 'history')
  assert.equal(categoryToolGroup('user'), null)
  assert.equal(categoryToolGroup(undefined), null)
})

test('categoryGroup maps every category family to exactly one stable group', () => {
  const expected = {
    'reasoning-replay': 'reasoning',
    user: 'user',
    'assistant-text': 'assistant',
    'assistant-other': 'other',
    'developer-message': 'developer',
    'tool-call-args': 'tool-call',
    'tool-result:other:read': 'tool-result',
    'tool-result:files': 'tool-result',
    'tool-result:memory': 'tool-result',
    'tool-result:unknown': 'tool-result',
    'tools:memory': 'memory',
    'tools:skill': 'skill',
    'tools:agent-teams': 'agent-teams',
    'tools:history': 'history',
    'tools:files': 'tool-decl',
    'tools:shell': 'tool-decl',
    'tools:web': 'tool-decl',
    'tools:session': 'tool-decl',
    'tools:goals': 'tool-decl',
    'tools:schedule': 'tool-decl',
    'tools:subagents': 'tool-decl',
    'tools:plugins': 'tool-decl',
    'tools:browser': 'tool-decl',
    'tools:workflow': 'tool-decl',
    'tools:my-tools': 'tool-decl',
    'tools:other:read': 'tool-decl',
    'tools:other:alpha': 'tool-decl',
    'injected:memory-snapshot': 'memory',
    'injected:memory-recall': 'memory',
    'injected:memory': 'memory',
    'injected:skill-catalog': 'skill',
    'injected:skill-invocation': 'skill',
    'injected:auto-review': 'auto-review',
    'injected:runtime-context': 'injected',
    'injected:image': 'injected',
    'injected:notices': 'injected',
    'injected:role-user': 'injected',
    'system:mnemon-memory': 'memory',
    'system:mnemon:memory': 'memory',
    'system:harness:identity': 'system',
    'system:superseded': 'system',
    'system:unknown': 'system',
    'system:auto-review': 'system',
    unknown: 'other',
    '': 'other',
  }
  for (const [category, group] of Object.entries(expected)) {
    assert.equal(categoryGroup(category), group, category)
  }
  assert.equal(categoryGroup(undefined), 'other')
  assert.equal(categoryGroup(null), 'other')
  assert.equal(categoryGroup(42), 'other')
  // One category never maps to two groups, and unknown keys never inherit a
  // tool group accidentally.
  assert.notEqual(categoryGroup('tools:other:read'), 'tool-result')
  assert.notEqual(categoryGroup('injected:memory-snapshot'), 'injected')
  // The auto-review transcript group is its own bucket, not generic injected,
  // and it never claims a tool group.
  assert.equal(categoryGroup('injected:auto-review'), 'auto-review')
  assert.equal(categoryToolGroup('injected:auto-review'), null)
})
