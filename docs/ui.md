# Web panel guide

The Web half adds one sidebar entry, **用量 / Token usage** (order 40), which opens a full-width panel. The Host still owns collection and persistence; the panel reads everything through the authenticated Connection RPC channel. The plugin has no separate settings page.

## Shared header

Every tab shares the sticky header:

- panel title/subtitle and the range control: **今日 / Today**, **近 7 天 / Last 7 days**, **近 30 天 / Last 30 days**;
- **导出 JSON / Export JSON** and **导出 CSV / Export CSV**;
- **刷新 / Refresh**;
- the gear, which switches to the Settings tab (it no longer opens an overlay);
- a status line with the last update time, auto-refresh state, a read-only badge, export status, and refresh errors.

Exports follow the selected range and are aggregate exports (JSON report or per-day CSV); there is no per-tab export. Auto refresh is driven by `enableAutoRefresh` and `autoRefreshIntervalMs`; manual refresh is always available.

The panel opens on **Overview** unless `rememberLastTab` is enabled and a valid remembered tab exists.

## Tabs

| tab | content |
|---|---|
| 概览 / Overview | Seven overview cards (total tokens with cache, prompt, output, cache hit rate, requests, estimated cost, search & fetch). Then, when there are session rows: the by-call-purpose bar; compact by-content-source bar; daily trend; session Top 5; search/fetch sessions Top 5; model Top 5; and the accounting footnote. No full session tree, full model table, or request rows. |
| 会话 / Sessions | The full expandable session tree and the full search/fetch sessions table. |
| 模型 / Models | The full provider/model table: provider, model, requests, input, output, cost. This is the Host's top 20 model rows. |
| 来源 / Sources | The full content-source bar (including **自动审查 / Auto review** since M2.10), the raw category detail table, and the tool-group breakdown table. |
| 搜索 / Search | The search & fetch summary card, the full search/fetch sessions table, and the search/fetch accounting note. Formerly labelled **Web**; M2.7 renamed the tab to **Search**. |
| 明细 / Details | Paginated request rows for the selected range with purpose and session filters. |
| 设置 / Settings | The inline Config editor for all 13 fields; no overlay. |

### Overview

The overview cards show compact token units (K/M/B) with the full grouped number in a tooltip; request counts stay as plain grouped integers. The cost card is the configured-price estimate and marks unpriced requests or a mixed-currency total. The search & fetch card shows grouped call counts, the search/fetch split, failures, and the estimated amount (or "no billable calls"); when the pre-M2.5 remainder is non-zero it adds a `未归因 N / Unattributed N` sub-line.

The content-source bar lists every group with tokens, including **自动审查 / Auto review** since M2.10. That group is the synthetic user-role transcript auto-review re-sends on each review call; it sits between injected context and the system prompt and is not 用户 / User. Ranges whose request detail is still retained show the same group because the Host migrates those records; daily-only older days keep their historical `user` attribution.

The overview Top 5 tables are read-only summaries: no expand chevrons on the session summary and no fold action on the search/fetch Top 5. The full tables live on their own tabs.

### Sessions

The session tree starts with root sessions only. Every row shows **subtree totals** (the session plus all descendants) for requests, **输入（未缓存）/ 输出 / 输入（缓存）**, cost, and cache rate. The three token columns use distinct theme colors; cached input is cache read + cache write, and uncached input is the remainder of the prompt total. A chevron with a direct-child count expands one level; nested expand/collapse works recursively. A non-root row keeps the `子代理 / Subagent` badge when its parent is expanded. Cache rate is `cacheRead / (input + cacheRead + cacheWrite)` of the row's subtree; a zero denominator renders `—`.

Session titles resolve at render time from the live `useSessions` store (`displayTitle`, then `title`, then the compact id). Titles are never persisted or sent over RPC. Up to 500 sessions are returned; the tree shows all roots in the range.

The daily trend chart stacks the same three token kinds per day: uncached input (blue), output (green), and cached input (amber). Each bar's tooltip shows all three; the legend totals reconcile to the range totals. Days without cache buckets show their prompt total as uncached and zero cached.

Since M3, clicking a session title opens an in-place **session drill-down** (the chevron still only expands the tree). It defaults to the session plus its descendant subtree and has a `含子代理 / 仅本会话` switch that refetches the scoped data. The detail header has a back action and ancestor breadcrumb; direct child sessions are listed with their subtree totals and can be opened for further drilling. The mini dashboard contains session cards, purpose, models, content sources, tool groups, search/fetch calls, daily trend, and paginated request rows for the selected session set. Drill state survives switching main tabs; a range change refetches it.

Session drill-down data comes from the Host's on-demand `sessionDetail` aggregation over retained request detail (the same 30-day window as the panel ranges). When detail is unavailable, cards fall back to the aggregated `bySession` row and the breakdown sections are replaced by a localized retention note; partial detail is marked separately. The range-level Web API `unattributed` remainder is never attributed to a session. There is no URL deep link and no per-session export in v1.

The full search/fetch sessions table follows the tree.

### Sources

The content-source bar shows every group with tokens — there is no top-6 fold — so memory, skill, agent-teams, and (since M2.10) **自动审查 / Auto review** stay visible. The auto-review group is the synthetic user-role transcript that auto-review re-sends on every review call; it is not 用户 / User. In the M2.10 live 30-day sample the genuine chat user share is small (about 0.5% of the chat prompt; auto-review had accounted for ~96% of the old user-category tokens, 211M of 220M). The raw category table underneath lists every `byCategory` key with friendly labels for the common memory/skill/agent-teams/system entries, `injected:auto-review` → **自动审查输入 / Auto-review input**, and the raw key as the fallback.

The tool-group table uses the Host's `summary.byToolGroup` map, which **has been aggregated since M1a**. Since M2.8 the default groups are `memory`, `skill`, `agent-teams`, `files`, `shell`, `web`, `session`, `goals`, `schedule`, `subagents`, `plugins`, `browser`, and `workflow`; user-defined group keys render as their raw key. Rows are sorted by tokens descending and show the group label, compact tokens, and share of `totals.promptTokens`; `other:<tool>` becomes `其他·<tool> / Other · <tool>`, and an unknown future group is shown raw. A summary without tool-attributed tokens renders the table's empty state.

Daily records written before M2.8 keep the group keys that existed when they were aggregated (for example `other:pwsh`), so historical ranges still show those legacy rows rather than being reclassified. Only new records use the expanded defaults. Long group labels and custom keys are ellipsized in the cell with the full text in a tooltip, so the token and share columns stay aligned.

### Search & fetch sessions and the unattributed reconciliation

The table is titled **搜索 / 抓取会话 / Search & fetch sessions** (M2.7; previously "Web API sessions"). Its columns are **会话 / Session**, **搜索 / Search**, **抓取 / Fetch**, and **费用 / Cost**. Each row comes from Host-observed `web_search` / `web_fetch` outcomes, attributed to the agent session that made the call. `unknown` renders as **未知会话 / Unknown session**; a session without a title keeps the short id with the full id in the tooltip.

Since M2.7, the full Sessions/Search tables append one synthetic, muted, non-clickable **未归因（升级前仅总量） / Unattributed (pre-M2.5 totals)** row when `summary.webApi.unattributed` is non-zero. It reconciles the search & fetch card total with the per-session rows for days recorded before M2.5, when only daily totals existed. It is a layout row, not a session, and carries no session id. A muted footer line repeats the same reconciliation rule under the table. On the Overview Top 5, when that summary is shown, the same count appears as a hint suffix (`另有未归因 N 次 / N more unattributed call(s)`) instead of an extra row.

A session whose calls all failed still appears, with an em-dash cost (only successes are billable). Counts are tool-call level estimates, not provider bills; see [accounting.md](accounting.md#web-api-counts-and-estimates).

### Details

The Details tab is the only place that calls the `requests` endpoint. It sends the visible summary bounds plus a 20-row window:

```json
{ "from": "2026-11-01", "to": "2026-11-07", "limit": 20, "offset": 0, "purpose": "chat", "sessionId": "session-…", "unpricedOnly": true }
```

- The purpose filter is all / chat / auto-review / compaction / session-title; the session filter is all plus up to 100 sessions from `summary.bySession`, labelled with the resolved title and a short id. The **只看未定价 / Unpriced only** checkbox keeps rows whose cost is not priced.
- `purpose` and `sessionId` are omitted when the filter is `all`; `sessionId` is only sent for a concrete selection; `unpricedOnly` is sent only when checked.
- Changing the range, purpose, session, or unpriced filter resets pagination to offset 0. **加载更多 / Load more** appends the next 20 rows until the Host's filtered `total`.
- The table columns are time, session (resolved title, full id in the tooltip), purpose, **输入（未缓存）**, output, **输入（缓存）**, cost, and the unpriced reason (中断 / 传输失败 / 无 usage / 未配置价格 / 未知; empty for priced rows). The three token columns use the same input/output/cached colors as the session and model tables.
- A range change that resolves new `from`/`to` (for example across midnight) resets the pane to page 1, so pages from two windows are never mixed. A mid-list RPC failure keeps already-loaded rows visible; retry re-requests the current window.
- Against a pre-M2.6 Host that does not accept `sessionId`, picking a concrete session returns `bad-request` and the pane shows the error with retry. With no session selected the old payload shape is used.

### Settings

Settings is an inline tab, not the M1b/M2 slide-over: there is no backdrop or close button, and the gear simply selects the tab. It edits every Config field: data directory and migration status, retention/flush/detail cap, auto refresh, `rememberLastTab`, the price table (peak and optional off-peak fields), `pricingOffPeakDays`, `webApiPricing`, `toolGroups` JSON, `rpcChannel`, and Host diagnostics/`ConfigMeta`.

- **Save** calls `config.set({patch})`; the Host re-validates and persists through `configEditor`. Restart-required fields (`dataDir`, `rpcChannel`) are surfaced after a successful save.
- **Reload** discards edits and re-reads the Host. **Cancel** discards edits in place; closing the panel also loses unsaved edits.
- If the profile has no `configEditor`, the form is disabled and explains that the profile configuration file must be edited instead.
- After the first visit the Settings panel stays mounted (hidden) while another tab is active, so unsaved edits survive tab switches.
- A pre-M2.6 Host advertises only 12 fields; the client hides the `rememberLastTab` switch and omits the key from the patch, so saving still persists the other fields instead of failing with `config-invalid`.

## Tab bar and keyboard

The tab bar uses `role="tablist"` / `role="tab"` / `aria-selected`, with horizontal overflow on narrow widths. Roving tabindex keeps only the active tab in the Tab order. `ArrowLeft` / `ArrowRight` wrap around the seven tabs; `Home` / `End` jump to the first/last. The active tab renders inside a `role="tabpanel"` labelled by its tab.

## `rememberLastTab`

- Default `false`: the panel always starts on Overview and browser storage is not read.
- `true`: the last valid tab is written to the plugin-namespaced localStorage key `dsh-token-attribution.activeTab` on each change and restored once after the mount-time `config.get` settles. A malformed value falls back to Overview; a user click before the read settles is never overridden.
- Turning the switch off does not clear the stored value, so re-enabling it can restore the old tab.

## Naming and limits

- Sidebar and panel title: **用量** (zh) / **Token usage** (en). M2.7 renamed the Web tab to **搜索 / Search**; its table is **搜索 / 抓取会话 / Search & fetch sessions**, with **搜索 / Search** and **抓取 / Fetch** columns. Older docs or screenshots may still show the M2.6 name **Web**.
- Purpose labels: 主对话 / Main chat, 自动审查 / Auto review, 压缩 / Compaction, 会话标题 / Session title. Content-source groups add 自动审查 / Auto review (M2.10); the raw category is 自动审查输入 / Auto-review input.
- The Models tab remains the Host's top 20. The Details endpoint is paginated; the session and search/fetch tables have their own Host caps (500 sessions in the tree, 100 search/fetch session rows).
- Older Hosts are tolerated: missing `byDay`, per-row cost, `export`, `requests`, `webApi`, `bySession`, `unattributed`, `byToolGroup`, or the M2.10 `auto-review` group degrade to the affected section's empty/hidden state instead of breaking the panel; a pre-M2.10 Host's old `user` category keeps rendering as 用户 / User.
- Host changes need a bundle reinstall (and a DSH restart when reported); client-only edits can arrive through client-hmr. The panel imports only `react`, uses no build step, and inherits light/dark themes from `--dsw-alias-*` tokens.
