# Configuration reference

The plugin declares no schemastery `Config`. `apply(ctx, rawConfig)` validates the profile row with a hand-written normalizer in `src/host/config.mjs`: an invalid value falls back to its default and appends a diagnostic instead of failing plugin activation. `config.set` over the authenticated Connection RPC channel runs the same normalizer, so the Settings tab and the profile configuration file behave identically.

## Fields

There are 13 fields. "Restart" marks fields the Host reports as restart-required after a save.

| field | type | default | restart | meaning |
|---|---|---|---|---|
| `dataDir` | string | `''` | yes | Data-root override. Empty uses `<DSH_HOME>/token-attribution/data/<profile>`. Must be absolute or empty. Changing it starts a migration (below). |
| `retainRequestDays` | integer 1–3650 | `30` | no | Days of per-request detail (`requests/*.jsonl`) to keep. |
| `retainDailyDays` | integer 1–3650 | `365` | no | Days of daily aggregates (`daily/*.json`) to keep; also prunes `webapi/*.json`. |
| `flushIntervalMs` | integer 500–60000 | `5000` | no | Write-behind flush interval. The queue also flushes immediately at 50 records. |
| `pricing` | array | two CNY tiered rows (below) | no | Price entries per 1M tokens. Top-level prices are peak; optional `offPeak` overrides. `model` accepts an exact id, `*`, or a `prefix*`. Unmatched calls are stored as `priced:false`. `[]` stops pricing new calls but keeps recorded costs. |
| `pricingOffPeakDays` | string[] | 62 official 2026–2027 Chinese statutory holidays | no | All-day off-peak dates (`YYYY-MM-DD`, Asia/Shanghai). An explicit list replaces the shipped default; `[]` disables holiday pricing. |
| `webApiPricing` | object | `{searchPerThousand:5, fetchPerThousand:5, currency:'CNY'}` | no | Estimated rate per 1,000 successful `web_search` / `web_fetch` calls. Estimates only, never a provider bill. |
| `toolGroups` | object | `memory`, `skill`, `agentTeams`, `files`, `shell`, `web`, `session`, `goals`, `schedule`, `subagents`, `plugins`, `browser`, `workflow` | no | Tool-name prefixes or exact names per attribution group, as arrays of up to 200 non-empty strings. Default groups are checked in the order listed; user-defined groups are appended after them and the **first matching group wins**. An additional key must be 1–32 lowercase letters, digits, or hyphens but not all digits; `other` is reserved and `agentTeams` is the legacy camelCase key. Missing groups keep their defaults, `[]` disables a group, and invalid keys/values are reported while the other groups are kept. Unmatched tools stay `other:<tool>`. |
| `maxDetailRowsPerDay` | integer ≥ 1 | `200000` | no | Per-day detail cap. Validated and stored; detail thinning is not applied yet. |
| `enableAutoRefresh` | boolean | `false` | no | Client-side auto refresh while the panel is open. The Host does not act on it. |
| `rememberLastTab` | boolean | `false` | no | Client-side tab persistence. When off, the panel always opens on Overview and browser storage is not read. |
| `autoRefreshIntervalMs` | integer 1000–3600000 | `30000` | no | Client polling interval used when `enableAutoRefresh` is on. |
| `rpcChannel` | string | `/token-attribution` | yes | Connection RPC channel path: one segment beginning with `/`, not `/api`. Changing it requires a plugin (and page) reload. |

Unknown Config keys are ignored with a diagnostic. Invalid per-entry values inside `pricing`, `pricingOffPeakDays`, `webApiPricing`, and `toolGroups` are dropped or defaulted individually, so one malformed row does not discard a whole table. `dataDir` is trimmed; relative paths fall back to `''`.

## Pricing defaults

CNY per 1M tokens, copied from the official DeepSeek price page (fetched 2026-11-11). The top-level values are the peak prices; `offPeak` holds the official half price.

| provider / model | input | cache read | cache write | output |
|---|---:|---:|---:|---:|
| `deepseek-official/deepseek-flash` peak | 2 | 0.04 | 0 | 8 |
| `deepseek-official/deepseek-flash` off-peak | 1 | 0.02 | 0 | 4 |
| `deepseek-official/deepseek-v4-pro` peak | 9 | 0.30 | 0 | 27 |
| `deepseek-official/deepseek-v4-pro` off-peak | 4.5 | 0.15 | 0 | 13.5 |

An entry without `offPeak` prices both tiers the same; a partial `offPeak` overrides only the fields it lists, and a zero is a real free-tier override. Model matching has no alias indirection, so an alias such as `deepseek-v4-flash` stays unpriced until you add a row for it.

Changing the table, an `offPeak` value, or `pricingOffPeakDays` triggers one Host-start reprice of retained detail rows. Days whose detail has already aged out keep the cost recorded under the old table. Only records with measured usage are priced; estimate-filled records (`usageEstimated:true`) stay unpriced.

## Peak and off-peak rule

- Tier selection uses each request's timestamp in **Asia/Shanghai (fixed UTC+8, no DST)**.
- **Peak** = Monday–Friday, `[09:00, 12:00)` and `[14:00, 18:00)`.
- **Off-peak** = nights, the lunch break, weekends, and every date in `pricingOffPeakDays`. Off-peak uses the `offPeak` prices (half price by default).
- Each record stores `cost.tier: 'peak' | 'off-peak'`. A record with an unusable timestamp is priced as peak, the conservative choice.

### Default holiday calendar

`pricingOffPeakDays` ships the official State Council holidays for 2026 and 2027: 62 dates in total (33 in 2026, 29 in 2027), including the Spring Festival and National Day blocks. Statutory holidays are not inferred from the calendar; only listed dates become all-day off-peak. Refresh the list when a new notice is published.

Editing the list **replaces** the shipped default (`[]` disables holiday pricing). Because the Settings form saves the whole Config, the first save after upgrading pins the current list in the profile; a later shipped-list update will not reach that profile automatically.

## Data directory and migration

Storage layout under `<DSH_HOME>/token-attribution/`:

- `state/<profile>/` — `pointer.json` (authoritative data root), `lock`, `migration.json`;
- `data/<profile>/` — `requests/YYYY-MM-DD.jsonl`, `daily/YYYY-MM-DD.json`, `webapi/YYYY-MM-DD.json`, `meta.json`;
- `diagnostics.log` — lifecycle/registration/error messages only (rotated once at 256 KiB); never prompt or tool text.

`<profile>` resolves from the live `profileContext` service (`name`/`home`), with `DSH_PROFILE`/`DSH_HOME` as fallback. Data collected by an older build under `default` can be adopted into the real profile root on first start (`migration: adopted`); the legacy directories are kept as a backup.

Changing `dataDir` is a migration, not an immediate re-root:

1. The Host copies the ledger into a sibling staging directory (`<target>.staging-<pid>-<stamp>`), bounded to 512 MiB, refusing symbolic links.
2. It verifies the copy exactly: request-file names, record count, summed `promptTokens`/`outputTokens`, daily-file names, and `meta.json` presence.
3. It renames the staging directory into place, then atomically switches `pointer.json`.
4. The old root becomes `<old>.migrated-<stamp>` and is pruned by the Host after 7 days. Legacy `default` adoption leaves the old directories in place.

Any failure — a non-empty or non-directory target, a nesting (source in target or vice versa), a copy/verification error, or a pointer write error — keeps the old root and records `failed` with diagnostics; the panel shows the failure and the migration can be retried after fixing the target.

`migration.status` (RPC) values:

| status | meaning |
|---|---|
| `ok` | Pointer and configured root agree (shown as **Ready**). |
| `requires-migration` | They differ; a migration is pending (also reported when a crash left a `migrating` marker). |
| `failed` | The last attempt failed; the old root is still in use. |
| `adopted` | A legacy `default` ledger was adopted; the old directories are kept. |

The `migration.json` state file can additionally hold `migrating` while a copy is running; if DSH stops mid-copy, the pointer was never switched and the next start reports `requires-migration`.

The migration runs synchronously at startup, before the collector opens the ledger and before any writer exists. A read-only store (lock held by another process, unparseable `pointer.json`) skips migration and keeps serving existing data.

## `rpcChannel` and restart-required fields

`dataDir` and `rpcChannel` are the only restart-required fields. `rpcChannel` must match `^/[A-Za-z0-9._~-]+$` and cannot be `/api`. After changing it, reload the plugin and the page; a non-default channel is not discovered automatically, so a wrong value can leave the panel unable to reach the Host while collection continues.

## `rememberLastTab`

- `false` (default): the panel always opens on **Overview**; browser storage is not read.
- `true`: the client writes the active tab to the namespaced localStorage key `dsh-token-attribution.activeTab` on each tab change and restores a valid value once after the mount-time `config.get` settles. A malformed value falls back to Overview. A user click before the Config read settles is never overridden.
- Turning the switch off does not clear the stored value, so re-enabling it can restore the old tab.

## Settings tab and older Hosts

The Settings tab edits all 13 fields through `config.get` / `config.set`: data directory and migration status, retention/flush/detail cap, auto refresh, `rememberLastTab`, the price table (peak plus optional off-peak fields), `pricingOffPeakDays`, `webApiPricing`, `toolGroups` JSON, `rpcChannel`, and Host diagnostics. **Save** submits a patch; **Reload** discards edits and re-reads the Host; **Cancel** discards edits in place. Fields marked **Restart required** are reported after a successful save. If the profile provides no `configEditor` (`editable:false`), the form is disabled and the profile file must be edited instead.

A pre-M2.6 Host returns only the original 12 fields and rejects an unknown `rememberLastTab` key as `config-invalid`. The client detects that descriptor list, hides the switch, and omits the key from the patch, so saving against an older Host still persists every other field.
