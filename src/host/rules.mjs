/**
 * Attribution classification rules: tool groups, injected-context sources, and
 * system-prompt section categories.
 *
 * Rules are pure functions over request metadata. They never read message text
 * to decide a category (only declared `source.kind`/`source.form` and names), so
 * no prompt content can leak into a persisted category key.
 *
 * @module dsh-token-attribution/host/rules
 */

import { DEFAULT_TOOL_GROUPS } from './config.mjs'

/** Source kinds that represent real human input. */
const USER_KINDS = new Set(['user', 'direct-human', 'user-question-reply'])

/** Source kinds that are one-off notices rather than durable instructions. */
const NOTICE_KINDS = new Set([
  'subagent-settled',
  'tool-jobs',
  'agent-message',
  'team-message',
  'session-reference',
  'user-approval',
  'repeat-tool-reminder',
  'goal',
  'goal-round',
  'background',
])

/** Direct `kind` → injected category mappings for known context producers. */
const INJECTED_KINDS = new Map([
  ['skill-catalog', 'injected:skill-catalog'],
  ['skill-invocation', 'injected:skill-invocation'],
  ['agent-instructions', 'injected:agent-instructions'],
  ['runtime-context', 'injected:runtime-context'],
  ['time-context', 'injected:time-context'],
  ['tmux-context', 'injected:runtime-context'],
  ['host-context', 'injected:runtime-context'],
  ['working-directory', 'injected:working-directory'],
  ['compact-checkpoint', 'injected:compact-checkpoint'],
  ['plan-mode', 'injected:plan-mode'],
  ['plan-review', 'injected:plan-mode'],
  ['dsh-session-title-llm', 'injected:session-title'],
  ['model-selection', 'injected:runtime-context'],
])

/** Historical config keys whose output group name differs from the key. */
const TOOL_GROUP_OUTPUT_NAMES = new Map([['agentTeams', 'agent-teams']])

/**
 * Whether one configured group list matches a tool name.
 * @param {unknown} list - configured name/prefix list.
 * @param {string} toolName - non-empty tool name.
 * @returns {boolean} true on an exact or prefix match.
 */
function matchesToolGroup(list, toolName) {
  return Array.isArray(list) && list.some((declared) => {
    const entry = typeof declared === 'string' ? declared : ''
    return entry.length > 0 && (toolName === entry || toolName.startsWith(entry))
  })
}

/**
 * Classify a tool name into an attribution group.
 *
 * An entry matches when it equals the tool name or is a prefix of it, so
 * `mnemon_` groups `mnemon_recall` while an exact name such as `list_agents`
 * groups only itself. Configured groups are tried in object order and the first
 * match wins; the historical `agentTeams` key reports as `agent-teams`, and a
 * user-defined key reports verbatim. Unknown tools keep their name
 * (`other:<toolName>`) so long-tail tool results stay attributable.
 * @param {unknown} name - tool name.
 * @param {{toolGroups?: Record<string, string[]>}} [config] - normalized plugin config.
 * @returns {string} configured group key (or `agent-teams`), or `other:<toolName>`.
 */
export function toolGroup(name, config) {
  const toolName = typeof name === 'string' ? name : ''
  if (toolName.length === 0) return 'other:unknown'
  const groups = config?.toolGroups ?? DEFAULT_TOOL_GROUPS
  if (groups === null || typeof groups !== 'object') return `other:${toolName}`
  for (const [key, list] of Object.entries(groups)) {
    if (!matchesToolGroup(list, toolName)) continue
    return TOOL_GROUP_OUTPUT_NAMES.get(key) ?? key
  }
  return `other:${toolName}`
}

/**
 * Map a Mnemon-style source to an injected category using its declared form
 * when the kind is generic.
 * @param {object} source - message source.
 * @returns {string} injected category.
 */
function mnemonCategory(source) {
  const form = typeof source?.form === 'string' ? source.form : ''
  switch (form) {
    case 'snapshot': return 'injected:memory-snapshot'
    case 'recall': return 'injected:memory-recall'
    case 'instructions': return 'injected:memory-instructions'
    case 'catalog': return 'injected:memory-catalog'
    case 'notice': return 'injected:notices'
    default: break
  }
  const kind = typeof source?.kind === 'string' ? source.kind : ''
  switch (kind) {
    case 'memory-snapshot': return 'injected:memory-snapshot'
    case 'memory-recall': return 'injected:memory-recall'
    case 'memory-instructions': return 'injected:memory-instructions'
    default: return 'injected:memory'
  }
}

/**
 * Classify a user-role message by its declared source.
 *
 * Unknown producer kinds fall through to `injected:<kind>` so no content is
 * silently attributed to the human user.
 * @param {object | undefined} source - `MessageSource` of a user-role message.
 * @returns {string} category key.
 */
export function sourceCategory(source) {
  const kind = typeof source?.kind === 'string' ? source.kind : ''
  if (kind.length === 0) return 'user'
  if (USER_KINDS.has(kind)) return 'user'
  if (INJECTED_KINDS.has(kind)) return INJECTED_KINDS.get(kind)
  if (NOTICE_KINDS.has(kind)) return 'injected:notices'
  if (kind.startsWith('dsh-mnemon') || kind.startsWith('mnemon') || kind.startsWith('memory-')) {
    return mnemonCategory(source)
  }
  return `injected:${kind}`
}

/**
 * Category key for one named system-prompt section.
 * @param {unknown} name - section name from `system-prompt/assemble`.
 * @returns {string} `system:<name>` (never empty).
 */
export function systemSectionCategory(name) {
  const value = typeof name === 'string' ? name.trim() : ''
  if (value.length === 0) return 'system:unknown'
  return value.startsWith('system:') ? value : `system:${value}`
}

/**
 * Stable display group for one attribution category.
 *
 * Mapping (exactly one group per category):
 * - `reasoning-replay` → `reasoning`
 * - `user` → `user`; `assistant-text` → `assistant`; `developer-message` → `developer`
 * - `tool-call-args` → `tool-call`
 * - `tool-result:*` → `tool-result`
 * - `tools:memory` → `memory`; `tools:skill` → `skill`;
 *   `tools:agent-teams` → `agent-teams`; `tools:history` → `history`;
 *   every other `tools:*` (tool declarations, including the built-in
 *   `files`, `shell`, `web`, `session`, `goals`, `schedule`, `subagents`,
 *   `plugins`, `browser`, and `workflow` groups and any user-defined group)
 *   → `tool-decl`
 * - `injected:memory*` → `memory`; `injected:skill*` → `skill`;
 *   `injected:auto-review` → `auto-review`; every other `injected:*` →
 *   `injected`
 * - `system:mnemon*` → `memory`; every other `system:*` → `system`
 * - anything else (including `unknown` and assistant long-tail) → `other`
 *
 * The mapping is deliberately exhaustive and pure so daily aggregates can
 * rebuild `byCategoryGroup` from `byCategory` for files written before it
 * existed.
 * @param {unknown} category - attribution category key.
 * @returns {'reasoning'|'user'|'assistant'|'developer'|'tool-call'|'tool-result'|'memory'|'skill'|'agent-teams'|'history'|'tool-decl'|'auto-review'|'injected'|'system'|'other'} group key.
 */
export function categoryGroup(category) {
  const value = typeof category === 'string' ? category : ''
  if (value === 'reasoning-replay') return 'reasoning'
  if (value === 'user') return 'user'
  if (value === 'assistant-text') return 'assistant'
  if (value === 'developer-message') return 'developer'
  if (value === 'tool-call-args') return 'tool-call'
  if (value.startsWith('tool-result:')) return 'tool-result'
  if (value.startsWith('tools:')) {
    const toolGroupName = value.slice('tools:'.length)
    if (toolGroupName === 'memory') return 'memory'
    if (toolGroupName === 'skill') return 'skill'
    if (toolGroupName === 'agent-teams') return 'agent-teams'
    if (toolGroupName === 'history') return 'history'
    return 'tool-decl'
  }
  if (value.startsWith('injected:')) {
    const source = value.slice('injected:'.length)
    if (source.startsWith('memory')) return 'memory'
    if (source.startsWith('skill')) return 'skill'
    if (source === 'auto-review') return 'auto-review'
    return 'injected'
  }
  if (value.startsWith('system:')) {
    const section = value.slice('system:'.length)
    if (section.startsWith('mnemon')) return 'memory'
    return 'system'
  }
  return 'other'
}

/**
 * Tool group implied by an attribution category key, for `byToolGroup`
 * aggregation.
 * @param {unknown} category - category key.
 * @returns {string | null} tool group, or null when the category is not tool-related.
 */
export function categoryToolGroup(category) {
  const value = typeof category === 'string' ? category : ''
  for (const prefix of ['tool-result:', 'tools:']) {
    if (value.startsWith(prefix) && value.length > prefix.length) return value.slice(prefix.length)
  }
  return null
}
