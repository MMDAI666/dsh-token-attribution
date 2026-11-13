# dsh-token-attribution

中文 · [English](#english)

一个 DSH 插件：实时记录当前 profile 内**每一次**模型调用（包括 `auto-review` 这类不落会话日志的调用），并以 provider 返回的真实 `usage` 为锚，把 token 归因到系统提示段、工具声明、工具结果、重放推理、注入上下文等内容来源。Host 端在宿主进程内静默采集与持久化；Web 端提供侧边栏 **用量 / Token usage** 面板。

## 功能

- **全量调用捕获**：观察 `llm/stream`，覆盖主对话、子代理、`auto-review`、`compaction`、`session-title` 与重试 attempt，总量锚定 provider 真实 usage。
- **归因与费用**：按调用目的、内容来源分组（含记忆/技能）、会话树、模型拆分；按北京时间自动选择高峰/空闲价，价目表可配，可补法定节假日日期。
- **搜索/抓取监控**：统计 Host 观察到的 `web_search` / `web_fetch` 次数并估算费用，可归因到具体对话；升级前（M2.5 之前）的调用以「未归因」余量显式呈现。
- **七标签页面板**：概览 / 会话 / 模型 / 来源 / 搜索 / 明细 / 设置；共享时间范围、刷新与 JSON/CSV 导出；请求明细分页；会话标题渲染时解析；会话 Tab 支持进入单会话详情（含子代理子树切换）；可选记住上次标签页。

## 快速开始

1. 打开 DSH 插件管理器，选择**从本地目录安装**。
2. 填入本包目录的绝对路径（开发机上为 `D:\Projects\dsh-token-attribution`）。
3. 如果管理器提示 `restart-required`，重启 DSH 后再查看数据。
4. 点击侧边栏的 **用量 / Token usage**（order 40）。

首次使用：

- **概览**展示 token/费用/搜索抓取卡片、按调用目的与内容来源的堆叠图、按天趋势、会话与模型 Top 5。
- 右上角切换 **今日 / 近 7 天 / 近 30 天**；刷新按钮重新读取账本。
- **导出 JSON / 导出 CSV** 导出当前区间（JSON 为聚合报告，CSV 按天一行）。
- **会话**展开会话树；**来源**查看原始分类与工具分组明细；**搜索**查看逐会话的搜索/抓取行。
- **明细**按每页 20 条翻页，支持 purpose/会话筛选。
- **设置**内联编辑全部 13 个 Config 字段（齿轮直接切到该标签页）；开启**记住上次标签页**后重新打开面板会回到上次位置。

卸载使用插件管理器的 **remove bundle**；卸载不会删除账本数据。

## 最近更新

- **M3** — 「会话」Tab 可点击进入单会话详情：默认含子代理子树、可切换仅本会话；迷你看板含会话卡、purpose、模型、内容来源、工具分组、搜索/抓取、趋势、子会话与请求明细；父/子会话可导航，切换 Tab 保留选中，范围变化重算。
- **M2.10** — 自动审查（auto-review）每次重发的合成 user 角色转录从**用户**中拆出，单列为**自动审查**内容来源分组（保留明细已迁移；更早只有日聚合的日期不变；真正的聊天用户文本仅占聊天 prompt 约 0.5%）。
- **M2.8** — 默认工具分组更丰富（`files`、`shell`、`web`、`session`、`goals`、`schedule`、`subagents`、`plugins`、`browser`、`workflow`），并支持任意自定义分组键。
- **M2.7** — **Web** 标签页更名为 **搜索**；搜索/抓取会话表增加「未归因（升级前仅总量）」行，使卡片总数与会话行可对账。
- **M2.6** — 七标签页面板、内联设置、「明细」分页与筛选、`rememberLastTab`。
- **M2.5** — 搜索/抓取次数按会话归因（每日 500 个桶、最多返回 100 行）。
- **M2.4** — 监控 `web_search` / `web_fetch`，并默认填入 2026–2027 年国务院法定节假日表。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/configuration.md](docs/configuration.md) | 13 个 Config 字段、价格/分时/节假日/Web API 默认值、`dataDir` 迁移、需重启字段、`rememberLastTab`、旧 Host 保存守卫。 |
| [docs/accounting.md](docs/accounting.md) | token 口径与 `char-v1` 估算、高峰/空闲计价、Web API 计数口径与限制、M2.5 之前的未归因行、隐私。 |
| [docs/ui.md](docs/ui.md) | 七个标签页、共享范围/刷新/导出、会话下钻、明细分页与筛选、设置行为、会话标题、命名。 |
| [README.zh.md](README.zh.md) | 完整中文镜像（与本文中文部分相同）。 |

## 隐私

账本只写非内容元数据：数字与 token 计数、分类名、hash、sessionId、provider/model、时间戳、purpose 与推理强度、origin/preset 标签、委派深度、费用档位/版本，以及稳定的归因错误名。**不落盘任何 prompt 文本、系统提示文本、工具参数、工具结果或会话标题**；会话标题仅在渲染时从客户端会话 store 解析。详见 [docs/accounting.md#privacy-and-what-is-stored](docs/accounting.md#privacy-and-what-is-stored)。

## 开发

```sh
node --check index.js
node --test --test-isolation=none "test/*.test.mjs"
```

当前单测为 **285 个**（2026-11-13 实测；M3 收尾期间数量可能继续变化，按近似值看待）。测试使用 `node:test`、合成 fixture 与临时 `DSH_HOME`，不会读写真实 profile。在 DSH Windows 沙箱内请使用上面的 in-process runner（`--test-isolation=none`）：默认 runner 以管道 stdio 启动子进程，会报 `spawn EPERM`。

要求 Node.js 24+，DSH 引擎范围为 `>=0.2.1-rc.1 <0.3.0`；零运行时依赖、无构建步骤。

## 状态与许可证

M1a 至 M2.10 已实现；M2.6–M2.10 已安装到 desktop profile（M2.10 历史迁移已 live 执行：3 天共 2,649 条记录）。MIT 许可证，见 [LICENSE](LICENSE)。验收证据在 [`evidence/`](evidence/)。

---

## English

[中文](README.md) · English

A DSH plugin that records every model call in the running profile — including calls that never reach a session log, such as `auto-review` — and attributes the provider's real `usage` to system-prompt sections, tool declarations, tool results, replayed reasoning, injected context, and other content sources. The Host half collects and persists headless; the Web half adds the **用量 / Token usage** sidebar panel.

### Features

- **Full call capture.** An observer on `llm/stream` sees main chat, subagents, `auto-review`, `compaction`, `session-title`, and retry attempts, all anchored to measured provider usage.
- **Attribution and cost.** Purpose, content-source groups (including memory/skill), session tree, per-model split; tiered peak/off-peak pricing in Asia/Shanghai, configurable price table, and optional holiday dates.
- **Search & fetch tracking.** Host-observed `web_search` / `web_fetch` counts and estimated cost, attributed per conversation, with an explicit unattributed remainder for pre-M2.5 history.
- **Seven-tab panel.** Overview / Sessions / Models / Sources / Search / Details / Settings, with a shared range, refresh, and JSON/CSV export, paginated request details, render-time session titles, a single-session drill-down on the Sessions tab (with subtree toggle), and optional last-tab memory.

### Quick start

1. Open the DSH plugin manager and choose **install from local directory**.
2. Pass the absolute path to this package directory (`D:\Projects\dsh-token-attribution` on the development machine).
3. If the manager reports `restart-required`, restart DSH before expecting data.
4. Click **用量 / Token usage** in the sidebar (order 40).

First use:

- **Overview** shows the token/cost/search & fetch cards, purpose and content-source bars, daily trend, and Top 5 sessions/models.
- Switch the range between **今日 / Today**, **近 7 天 / Last 7 days**, and **近 30 天 / Last 30 days**; the header refresh re-reads the ledger.
- **导出 JSON / Export JSON** and **导出 CSV / Export CSV** export the selected range (aggregate report / per-day CSV).
- **Sessions** expands the session tree; **Sources** shows raw category and tool-group detail; **Search** shows per-session search/fetch rows.
- **Details** pages through request rows (20 per page) with purpose/session filters.
- **Settings** edits all 13 Config fields inline; the gear switches to it. Enable **rememberLastTab** to reopen on the last tab.

Uninstall with the plugin manager's **remove bundle** action. Removal does not delete the ledger.

### What's new

- **M3** — the Sessions tab opens a single-session drill-down (subtree by default, switchable to this session only): overview cards, purpose, models, content sources, tool groups, search/fetch, trend, child sessions, and paginated requests; parent/child navigation, selection survives tab switches, and a range change refetches.
- **M2.10** — auto-review's synthetic user-role transcript is split out of **用户 / User** into its own **自动审查 / Auto review** content-source group (retained detail migrated; daily-only older days unchanged; genuine chat user text is ~0.5% of the chat prompt).
- **M2.8** — richer default tool groups (`files`, `shell`, `web`, `session`, `goals`, `schedule`, `subagents`, `plugins`, `browser`, `workflow`) plus arbitrary custom group keys.
- **M2.7** — the **Web** tab is renamed **Search**, and the search/fetch sessions table gains an explicit pre-M2.5 unattributed row so the card total reconciles with attributed rows.
- **M2.6** — seven-tab panel, inline Settings, paginated Details with filters, `rememberLastTab`.
- **M2.5** — search/fetch counts attributed per conversation (500 buckets/day, top 100 rows).
- **M2.4** — Web API monitoring for `web_search` / `web_fetch`, plus the default 2026–2027 Chinese statutory holiday calendar.

### Documentation

| document | covers |
|---|---|
| [docs/configuration.md](docs/configuration.md) | All 13 Config fields, pricing/off-peak/holiday/Web API defaults, `dataDir` migration, restart-required fields, `rememberLastTab`, older-Host save guard. |
| [docs/accounting.md](docs/accounting.md) | Token accounting and `char-v1` estimates, peak/off-peak pricing, Web API counts and their limits, unattributed pre-M2.5 rows, privacy. |
| [docs/ui.md](docs/ui.md) | The seven tabs, shared range/refresh/export, session drill-down, Details pagination and filters, Settings behavior, session titles, naming. |
| [README.zh.md](README.zh.md) | Full Chinese mirror (same as the Chinese half of this file). |

### Privacy

The ledger stores only non-content metadata: numbers and token counts, category names, hashes, session ids, provider/model, timestamps, purpose and reasoning effort, origin/preset labels, delegation depth, cost tier/version, and a stable attribution-error name. **No prompt text, system-prompt text, tool arguments, tool results, or session titles are written to disk**; titles are resolved from the live client session store at render time. See [docs/accounting.md#privacy-and-what-is-stored](docs/accounting.md#privacy-and-what-is-stored).

### Development

```sh
node --check index.js
node --test --test-isolation=none "test/*.test.mjs"
```

The suite currently reports **285 tests** (observed 2026-11-13; the count is approximate while M3 settles). Tests use `node:test`, synthetic fixtures, and temporary `DSH_HOME` directories — they never read or write a real profile. In the DSH Windows sandbox use the in-process runner (`--test-isolation=none`) as shown; the default runner spawns child processes with piped stdio and fails with `spawn EPERM`.

Requires Node.js 24 or newer and the DSH `>=0.2.1-rc.1 <0.3.0` engine range. No runtime dependencies and no build step.

### Status and license

M1a through M2.10 are implemented; M2.6–M2.10 are installed on the desktop profile (M2.10 historical migration ran live: 2,649 records across 3 days). MIT licensed — see [LICENSE](LICENSE). Acceptance evidence is in [`evidence/`](evidence/).
