# Accounting and estimation

The ledger has one authoritative layer and two estimate layers:

- **Measured usage** from the provider (`TokenUsage`) anchors every token total.
- **Content-source splits** are character-weight estimates normalized to that measured prompt.
- **Costs** are computed from the configured price table, and **Web API counts** are host-observed tool-call counters priced at configured rates.

None of the cost numbers is a provider bill.

## Usage anchors

`TokenUsage` carries four disjoint buckets: `inputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `outputTokens`. `reasoningTokens` is a subset of output and is never added on top.

- `promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens`
- `outputTokens = outputTokens`
- `totalTokens = promptTokens + outputTokens`

A record is **measured** when the stream produced a usage chunk with at least one non-zero bucket. When the stream ends without usage, or reports all four buckets as zero, the record stores `usage:null`, `usageEstimated:true`, an estimate-filled `promptTokens`, and `outputTokens:0`. `max-tokens` finishes count as successful attempts; `error`/`aborted`/`unknown` are marked on the attempt.

Each record keeps `estimatedPromptTokens`, `estimateScale`, and `estimatorVersion:'char-v1'` so estimator error is auditable. Records have no provider request id; the id is `sha1(sessionId|ts|counter|purpose)`.

## Content-source estimation

The `char-v1` estimator mirrors the host token meter's structure:

- ASCII text: **0.275 tokens/char**; non-ASCII text: **0.9 tokens/char**;
- **+4** structural overhead per content block; **+4** role overhead per non-system message;
- system text is priced by text density plus one role overhead (no per-block overhead);
- tool declarations are priced as one serialized JSON array plus one block overhead;
- image blocks use `ctx.llm.imageRequestPricing` when the route provides it (visual tokens plus the model-visible placeholder text); otherwise a structural JSON estimate is used. Files use `ctx.llm.fileRequestText` when available, otherwise the structural estimate.

Raw category estimates are then normalized per call so the integer categories sum **exactly** to the measured `promptTokens`: each category is scaled and rounded, and the rounding residual is applied to the largest category. An extreme rounding case can fall back into the `unknown` category (labelled *Unattributed* in the UI), but the invariant check still holds.

### Categories and groups

Raw categories name the model-visible source: `user`, `assistant-text`, `assistant-other`, `reasoning-replay`, `tool-call-args`, `tool-result:<tool>`, `tools:<group>`, `injected:*`, `system:<section>`, `developer-message`, `unknown`, and so on. `summary.byCategory` keeps every raw key.

`summary.byCategoryGroup` folds them into `user`, `assistant`, `developer`, `reasoning`, `tool-call`, `tool-result`, `tool-decl`, `memory`, `skill`, `agent-teams`, `history`, `injected`, `auto-review`, `system`, `other`. Memory/skill absorb their tool declarations (`tools:memory`, `tools:skill`), their tool results, and their injected context (`injected:memory*`, `injected:skill*`); `system:mnemon*` also joins memory. Since M2.10, `injected:auto-review` maps to its own `auto-review` group and never folds into `user`. Every group with tokens is shown — there is no top-N fold.

Auto-review re-sends the synthetic user-role transcript on every review call. Counting that repeated transcript as `user` made the group describe model-generated review input rather than the human's turn; the raw category is now `injected:auto-review` and the group is **自动审查 / Auto review**. The category detail table labels it **自动审查输入 / Auto-review input**, and other `injected:*` keys keep the raw-key fallback. Only the category key and the normalized token count are stored — never the transcript text. The Host migrates records whose request detail is still retained (`retainRequestDays`, default 30 days), so those older ranges report the same split instead of leaving the tokens under `user`; daily-only days beyond the detail window keep their historical `user` attribution. In the M2.10 live sample auto-review accounted for ~96% of the old user-category tokens (211M of 220M).

`summary.byToolGroup` aggregates prompt tokens by tool group and **has existed since M1a**; the Sources tab renders it rather than deriving it from categories.

### Tool declarations

Declarations are attributed using the `projectToolUpdates` semantics, not a naive `options.tools + additions` sum:

- `history.tools + updates[].additions`, with `deferLoading` applied;
- for `addition-only`, filter by the active tool names from `options.tools`;
- when the request prefix omits developer updates, fall back to `options.tools`;
- when the route's `toolUpdate` mode cannot be resolved synchronously, fall back to `options.tools`.

Developer messages are attributed only when that projection keeps them in the request; routes that strip developer messages in mid-conversation updates do not count them.

### Purposes

Purpose comes from `GenerateOptions.purpose`: unset means main chat (`chat`); declared values are `auto-review`, `compaction`, and `session-title`. Purpose is read from the request, never guessed from text. Auto-review calls are captured because the Host observes `llm/stream` directly, including calls that never reach a session log. Each auto-review call re-sends the transcript; M2.10 attributes that synthetic input to `injected:auto-review` (group `auto-review`) rather than `user`.

## Cost

Cost is computed per request from the configured `pricing` table:

```
amount = Σ tokens(bucket) × price(bucket, tier) / 1,000,000
```

`tier` comes from the request timestamp in Asia/Shanghai: peak on weekdays `[09:00,12:00)` and `[14:00,18:00)`, off-peak otherwise (nights, lunch, weekends, listed holiday dates). Off-peak uses the `offPeak` override for each field, falling back to peak when absent. The record stores `{amount, priced, currency, priceVersion, tier}`.

- No matching price entry, or `usage:null`, means `priced:false` and `amount:0`.
- Estimate-filled records (`usageEstimated:true`) are never priced.
- Amounts are rounded to six decimals.
- Config changes to `pricing` or `pricingOffPeakDays` trigger one reprice of retained detail rows on the next Host start; days without detail keep the previously recorded cost. An empty table stops pricing new calls but does not erase recorded amounts.
- When the configured table spans currencies, totals are **not summed across currencies**: `cost.currency` becomes `mixed`, `cost.amount` is `0`, and the amounts live in `totals.costByCurrency` and each `byDay[].costByCurrency`. The UI marks this as `Mixed` / `混币`.

All amounts remain configured-price estimates, not a provider bill.

## Web API counts and estimates

The Host observes the outcome of every `web_search` and `web_fetch` dispatch through the global `tools/result` hook and records it in a separate per-day file, `webapi/<YYYY-MM-DD>.json`, using the host-local day bucket (the same one as `requests/` and `daily/`). These counters are deliberately outside the request JSONL and daily aggregates, so detail rebuilds and cost repricing never touch them; `retainDailyDays` prunes them.

Only successful calls are billable:

```
amount = search.ok / 1000 × searchPerThousand + fetch.ok / 1000 × fetchPerThousand
```

The currency comes from `webApiPricing.currency`. `cost.priced` is true only when at least one successful call exists and the rates can be applied; a range with only failures (or no calls) reports `0` and `priced:false`. Failed calls are counted but never billed.

The Web API amount is **recomputed at read time** from the current `webApiPricing`, unlike token cost, which is stored per request. Editing the rates therefore restates the estimate for every historical range too.

### Known limits

- Counts are **tool-call level**, not provider billing. One `web_search` tool call can issue one provider search per query; it is counted once here, so multi-query calls undercount provider requests.
- A provider may bundle search into a model turn; the Host cannot see those searches at all.
- A tool-level success cannot distinguish a useful result from an empty result or timeout that a provider might not bill.
- Free quotas, rounding, and price changes are unknown to the Host.
- Treat the card as an observability estimate and reconcile against the provider console when it matters.

### Per-session attribution

Since M2.5 the observer records the agent session attached to each counted call (`exec.agent`, preferring `agent.id` then `agent.session.id`). A call whose session cannot be resolved goes to the reserved `unknown` bucket.

- Each day file holds at most **500 session buckets**: 499 named sessions plus `unknown`. A new session beyond the cap is folded into `unknown` (one diagnostic per day), so day totals always equal the sum of the buckets.
- `summary.webApi.bySession` returns at most the **top 100** sessions per range, sorted by calls, then search count, then session id. The table folds to 10 rows and can expand to those 100.
- A session whose calls all failed still appears, with an em-dash cost (only successes are billable).
- Malformed day files and malformed buckets are tolerated per day; missing counters default to zero.

### Session drill-down

The Sessions tab calls the Host's `sessionDetail` RPC with `{range, sessionId, includeDescendants}`. The Host resolves the session plus descendants from the full-range `bySession` rows, then rebuilds the scoped summary from retained request detail: totals, purpose, models, content sources, tool groups, daily rows, cache, and cost are all filtered to that session set. The response also carries the selected session row, its direct children, `sessionIds`, a session-scoped Web API block, and `detailAvailable` / `detailPartial` / `detailReason`.

- Detail aggregation uses the request-detail retention window (default 30 days), which covers the panel's `today` / `7d` / `30d` ranges. There is no per-session 365-day aggregate.
- If detail rows are missing, the cards are synthesized from the aggregated `bySession` row and breakdowns are empty with `detailAvailable:false`; partial detail is reported rather than silently presented as complete.
- Session-scoped search/fetch counters are read directly from the Web API session buckets, not from the range's capped `bySession` list, so a session beyond the 100-row display cap still reports its calls.
- The embedded request table calls `requests` with `sessionIds` (1–500 ids) in subtree mode, or `sessionId` in single-session mode; totals are computed before pagination.
- There is no per-session dedicated export or URL route in v1; the global range export and Details filters are unchanged.

### Unattributed rows (pre-M2.5 history)

M2.4 day files carried only daily totals and no `sessions` map. Those calls cannot be attributed to a conversation, so the Host exposes `summary.webApi.unattributed`: the exact remainder

```
totals − Σ(per-session buckets)
```

with the same `search`/`fetch`/`calls` counters and cost shape as a session row. It is computed from the complete session map **before** the 100-row cap, so a row dropped by the cap never inflates it. Overflowed sessions are already in `unknown` and therefore count as attributed, not unattributed. The remainder is zero on a range whose session map covers every counted call.

On the panel, the **搜索 / 抓取会话 / Search & fetch sessions** tables render this remainder as a synthetic **unattributed** reconciliation row (not a session and never linked to one) when it is non-zero. On the Overview Top 5 it is appended to the hint as an extra count instead of a row (the compact summary is only rendered when at least one session row exists). This explains why the Web API card can exceed the sum of visible per-session rows after upgrading, and the history ages out with the daily retention.

## Privacy and what is stored

The ledger stores only:

- token counts, cost numbers, category/group names, counts, timestamps;
- `sessionId` / `parentSessionId`, delegation depth, origin, preset, purpose, provider, model, reasoning effort;
- hashes (record id, pricing fingerprint, system-section match hashes);
- `attribution_error: {name}` — never the exception message, which could embed prompt text.

It stores **no** prompt text, system-prompt text, tool arguments, tool results, or session titles. System-prompt section text from `system-prompt/assemble` is kept in memory only (a bounded per-session ring buffer) to hash-match rendered system messages.

Attribution follows the same privacy rule for auto-review: its synthetic user-role transcript is counted under raw category `injected:auto-review` and the **自动审查 / Auto review** group, never under 用户 / User. Only the category key and the normalized token count are persisted; the transcript itself is never written to the ledger or sent over RPC. The Host migrates records whose request detail is still retained (default 30 days); daily-only older days keep their historical `user` bucket.

Session titles are resolved at render time from the live client `useSessions` store (`displayTitle`, then `title`, then the short id). They are never written to the ledger, sent over RPC, or included in an export.

RPC data endpoints are read-only; `config.set` writes only this plugin's own Config through the host `configEditor`. To delete the data: stop DSH, delete `<DSH_HOME>/token-attribution/` (or the configured `dataDir`), then uninstall the bundle.
