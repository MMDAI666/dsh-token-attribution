# dsh-token-attribution

中文 · [English](README.md#english)

本文为完整中文镜像；`README.md` 为中文优先的双语版（插件主页默认显示中文）。

一个 DSH 插件：实时记录当前 profile 内**每一次**模型调用（包括 `auto-review` 这类不落会话日志的调用），并以 provider 返回的真实 `usage` 为锚，把 token 归因到系统提示段、工具声明、工具结果、重放推理、注入上下文等内容来源。Host 端在宿主进程内静默采集与持久化；Web 端提供侧边栏 **用量 / Token usage** 面板。

## 功能

- **全量调用捕获**：观察 `llm/stream`，覆盖主对话、子代理、`auto-review`、`compaction`、`session-title` 与重试 attempt，总量锚定 provider 真实 usage。
- **归因与费用**：按调用目的、内容来源分组（含记忆/技能）、会话树、模型拆分；按北京时间自动选择高峰/空闲价，价目表可配，可补法定节假日日期。
- **搜索/抓取监控**：统计 Host 观察到的 `web_search` / `web_fetch` 次数并估算费用，可归因到具体对话；升级前（M2.5 之前）的调用以「未归因」余量显式呈现。
- **七标签页面板**：概览 / 会话 / 模型 / 来源 / 搜索 / 明细 / 设置；共享时间范围、刷新与 JSON/CSV 导出；请求明细分页；会话标题渲染时解析；会话 Tab 支持进入单会话详情（含子代理子树切换）；token 表拆分为输入（未缓存）/ 输出 / 输入（缓存）并用不同颜色区分；可选记住上次标签页。

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

- **M5** — 会话 / 模型 / 明细表与按天趋势图把 token 拆成「输入（未缓存） / 输出 / 输入（缓存）」三类，使用不同颜色；补齐中文界面标签（Output、Provider 等）。
- **M4** — 未定价请求不再只显示总数：费用卡按原因拆分（中断 / 传输失败 / 无 usage / 未配置价格 / 未知），明细 Tab 增加「只看未定价」筛选并显示每条请求的原因。
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
| [README.md](README.md) | 中文优先的双语版（中文部分与本文相同） |

## 隐私

账本只写非内容元数据：数字与 token 计数、分类名、hash、sessionId、provider/model、时间戳、purpose 与推理强度、origin/preset 标签、委派深度、费用档位/版本，以及稳定的归因错误名。**不落盘任何 prompt 文本、系统提示文本、工具参数、工具结果或会话标题**；会话标题仅在渲染时从客户端会话 store 解析。详见 [docs/accounting.md#privacy-and-what-is-stored](docs/accounting.md#privacy-and-what-is-stored)。

## 开发

```sh
node --check index.js
node --test --test-isolation=none "test/*.test.mjs"
```

当前单测为 **288 个**（2026-11-16 实测；M5 收尾期间数量可能继续变化，按近似值看待）。测试使用 `node:test`、合成 fixture 与临时 `DSH_HOME`，不会读写真实 profile。在 DSH Windows 沙箱内请使用上面的 in-process runner（`--test-isolation=none`）：默认 runner 以管道 stdio 启动子进程，会报 `spawn EPERM`。

要求 Node.js 24+，DSH 引擎范围为 `>=0.2.1-rc.1 <0.3.0`；零运行时依赖、无构建步骤。

## 状态与许可证

M1a 至 M2.10 已实现；M2.6–M2.10 已安装到 desktop profile（M2.10 历史迁移已 live 执行：3 天共 2,649 条记录）。MIT 许可证，见 [LICENSE](LICENSE)。验收证据在 [`evidence/`](evidence/)。
