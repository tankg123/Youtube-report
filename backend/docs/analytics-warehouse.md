# Analytics warehouse (`backend/src/services/analyticsWarehouse.js`)

The warehouse stores YouTube Analytics numbers **per Content Owner, entity and Pacific-time day**. It replaces range snapshots as the source of truth for every time series: the dashboard reads any date range from stored days, the 09:00 daily sync appends newly published days without touching stored values, and every change of a stored number is recorded in an append-only ledger. Snapshots remain for range-only reports (top videos, demographics, retention, Explorer queries).

The module is pure SQLite (better-sqlite3, synchronous transactions). It makes no Google calls and does not require `analyticsService` (CommonJS cycle). `analyticsDatabase.js` calls `ensureWarehouseSchema(db)` at startup, right after the base tables; the function is idempotent and works on `new Database(':memory:')`, which is how the tests run.

## Entities

| `entity_key` | Meaning | YouTube filter |
| --- | --- | --- |
| `owner:claimed` | all claimed content of the owner | `claimedStatus==claimed` |
| `owner:self` | content uploaded by the owner's channels (claimed or not) | `uploaderType==self` |
| `owner:thirdParty` | claimed third-party uploads | `claimedStatus==claimed;uploaderType==thirdParty` |
| `channel:UC…` | one managed channel | `channel==UC…` |

The three owner scopes overlap and are never summed. `entityKey({ scope, channelId })`, `parseEntityKey(key)` and `isOwnerKey(key)` build, validate and classify keys (`channel:` keys must match `^UC[\w-]{22}$`). A series may contain **one** owner key or **any number of channel keys**, never both (`readSeries` throws HTTP 400).

## Schema

All timestamps written by the warehouse are ISO `YYYY-MM-DDTHH:MM:SS.sssZ` (`new Date().toISOString()`); no `CURRENT_TIMESTAMP` defaults. Days are `YYYY-MM-DD` Pacific-time days as reported by the API.

| Table | Key | Purpose |
| --- | --- | --- |
| `analytic_meta` | `key` | small key/value store (`migration:snapshots-to-facts`, future flags) |
| `analytic_daily_facts` | `(owner_id, entity_key, day)` | one metric object per entity-day: `metrics_json` (sorted keys, finite numbers only; absent key = never fetched), `monetary` (1 when any monetary key is stored), `currency` (always `USD`), `revision` (+1 per overwriting job that changed a value; the basic and monetary passes of one job count once), `source` (`daily`, `full`, `channelDetail`, `migration`), `job_id`, `first_synced_at`, `last_synced_at`, `last_changed_at` |
| `analytic_daily_breakdowns` | `(owner_id, entity_key, day, dimension, dimension_value)` | additive per-day breakdown rows (owner entities only): `insightTrafficSourceType`, `insightPlaybackLocationType`, `deviceType`, `operatingSystem`, `subscribedStatus`, `liveOrOnDemand`, `youtubeProduct`, `creatorContentType`, `adType`, `country`, `sharingService` |
| `analytic_day_coverage` | `(owner_id, entity_key, day, kind)` | which days a successful request covered, **even when it returned zero rows**. `kind` is `facts` or `breakdown:<dimension>`; `monetary` says whether a monetary request covered the day |
| `analytic_daily_history` | `id` | append-only ledger: `action` `overwrite` / `drift`, `previous_json`, `new_json`, `dimension` (`''` for facts), `job_id`, `recorded_at`, `monetary_only` (1 when a non-monetary reader would see nothing of the row: only monetary keys changed, or `dimension = 'adType'`) |

`ensureWarehouseSchema` also adds `analytic_jobs.kind`, `analytic_jobs.mode` and `analytic_channels.removed_at` when those tables exist and lack the columns, and adds `analytic_daily_history.monetary_only` to a ledger created before the column existed (backfilled once from the stored diffs, in one transaction). It never touches `analytic_schedules`.

Coverage is separate from facts on purpose: a channel with no activity on a day is omitted from Google's grouped response. The coverage row proves the day was requested, so readers treat "covered but no row" as a true zero, while a day without coverage is "not synced yet" (`metrics: null`).

## Metric registry

`METRIC_REGISTRY` lists `{ key, kind, additive, monetary, derived, approx? }` for every metric the warehouse understands (`kind` ∈ `count | minutes | seconds | percent | money | cpm | ratio`):

- additive counts and minutes: `views`, `engagedViews`, `redViews`, `estimatedMinutesWatched`, `estimatedRedMinutesWatched`, `likes`, `dislikes`, `comments`, `shares`, `subscribersGained`, `subscribersLost`, `videosAddedToPlaylists`, `videosRemovedFromPlaylists`;
- non-additive: `averageViewDuration` (seconds, `approx` when aggregated), `averageViewPercentage` (percent), `viewerPercentage` (percent), `cpm`, `playbackBasedCpm`;
- monetary (additive unless noted): `estimatedRevenue`, `estimatedAdRevenue`, `estimatedRedPartnerRevenue`, `grossRevenue`, `monetizedPlaybacks`, `adImpressions`, `cpm` (non-additive), `playbackBasedCpm` (non-additive);
- derived (never stored, always recomputed): `watchHours` (kind `ratio`), `netSubscribers`, `rpm` (monetary).

`MONETARY_KEYS` is a `Set` of every monetary key **including** `rpm`. `stripMonetary(object, canMonetary)` removes them unless `canMonetary`; every read path (`readSeries`, `readBreakdown`, `readChannelTotals`, `readFactRows`, `history`) applies it, so a Content ID role never receives a monetary key. `normalizeMetrics(object)` returns a new object with sorted keys and finite numbers only; numeric strings are accepted, `null`, `undefined`, `NaN`, `Infinity`, booleans and strings such as `day` are dropped.

## Write semantics

`writeFacts(db, { ownerId, entityKey, rows:[{ day, metrics }], mode:'append'|'overwrite', source, jobId, monetary, now })` runs in one transaction and returns `{ inserted, updated, enriched, unchanged, drift, skipped }`.

| mode | row exists | situation | write? | counter | ledger | revision | last_changed_at | last_synced_at |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| any | no | — | insert | `inserted` | — | 1 | now | now |
| append | yes | every incoming key equals the stored value | no | `unchanged` | — | — | — | now |
| append | yes | incoming has keys absent from the stored object (e.g. monetary enrichment) and no differing key | merge the new keys only (`source`/`job_id` updated) | `enriched` | — | — | — | now |
| append | yes | some stored key differs | stored values untouched (new keys still merged) | `drift` | `drift`: `previous_json = { key: before }`, `new_json = { key: [before, after] }` for the differing keys only; skipped when one of the four latest drift rows of the same (entity, day, dimension) has an identical `new_json` (a run's basic and monetary passes write separate rows) | — | — | now |
| overwrite | yes | some incoming key differs | key-wise merge: only incoming keys are replaced, stored keys absent from the incoming row are kept | `updated` | `overwrite`: `previous_json` = whole stored object, `new_json` = changed keys with their new values | +1 (once per `job_id`) | now | now |
| overwrite | yes | nothing differs (enrichment only) | merge | `enriched` / `unchanged` | — | — | — | now |

Rules:

- Finite numbers are compared with exact equality. `null`, `undefined` and non-finite incoming values are dropped before the comparison (treated as absent); a row whose incoming object becomes empty counts as `skipped`.
- A job with `monetary:false` **never writes, modifies or removes monetary keys** in either mode: monetary keys are stripped from its incoming rows and the merge keeps the stored monetary keys. Its ledger rows therefore never mention a monetary key.
- `monetary` column = 1 when any monetary key is stored after the write; `currency` must be `USD` (anything else throws).
- `source` and `job_id` are updated on insert, overwrite and enrichment, not on drift or unchanged rows.

`writeBreakdowns(db, { ownerId, entityKey, dimension, rows:[{ day, value, metrics }], mode, source, jobId, monetary, now, coveredDays, metricKeys? })` works per (entity, day, dimension). `metricKeys` (array or comma-separated string) names the metrics the Google request asked for; the sync engine passes its basic or monetary metric list per pass. A row whose metric object is empty after normalisation (a non-monetary job that received only monetary keys) counts `skipped`.

- **append** — when nothing is stored for the day and no `breakdown:<dimension>` coverage exists, the incoming rows are inserted. Otherwise the stored row set is compared with the incoming one: keys absent from a stored row are merged (monetary enrichment, counter `enriched`; `source`/`job_id` move only on rows that gained a key, other rows get `last_synced_at` only), existing values are never replaced, and any difference records one `drift` ledger row (`dimension` set, `dimension_value = ''`, `previous_json = [stored rows]`, `new_json = { added:[values], changed:{ value:{ key:[before, after] } }, missing:[values] }`, values and keys in sorted order so the dedupe is independent of Google's row order), de-duplicated like fact drift. Identical sets count `unchanged`.
- **overwrite** — key-wise per value, never a delete-insert: for every incoming value the stored object becomes `{ ...stored, ...incoming }` (incoming keys win, every other stored key survives, so the basic and monetary passes of one job never erase each other); a stored value absent from the incoming set loses **only** `metricKeys` (without `metricKeys`: the union of the incoming keys) and is deleted when nothing is left; new values are inserted. `revision` +1 and `last_changed_at` only on values whose own numbers changed or lost keys, once per `job_id`. One `overwrite` ledger row per (day, dimension) when anything changed (`previous_json = [stored rows]`, `new_json = [row set after the write]`, counter `updated`); additions only (new keys on existing values) are an enrichment (`enriched`, stored, no ledger row, no revision bump); identical sets count `unchanged`. A non-monetary job never removes or replaces a monetary key (monetary names in its `metricKeys` are ignored).
- `coveredDays`, when given, marks `breakdown:<dimension>` coverage for those days in the same transaction (after the comparison, so the first write of a day is an insert).

`markCoverage(db, { ownerId, entityKey, days, kind, monetary, jobId, now })` upserts with `monetary = MAX(existing, new)`: a later non-monetary job never lowers the flag. `missingDays(db, { ownerId, entityKey, startDate, endDate, kind, monetary })` returns the sorted days without a coverage row, or, when `monetary` is requested, with `monetary = 0`; this is how the sync engine re-fetches revenue for days that were first stored by a non-monetary run.

## Aggregation rules

`readSeries(db, { ownerId, entityKeys, startDate, endDate, canMonetary })` → `[{ day, metrics|null, covered, rows, monetaryRows, monetaryViews, approx }]`:

- The coverage table is the single source of truth: a day without a `facts` coverage row for any requested entity → `metrics: null, covered: false`, even when a fact row is stored (an interrupted job, or a migrated day beyond the snapshot's `availableEndDate`); such a day is listed by `coverage()`/`missingDays()` as missing and the next job re-requests it.
- Additive metrics are summed over entities; metric keys outside the registry (custom-query metrics) are treated as additive. Absent-but-covered channel days count as 0 for every additive key seen anywhere in the series.
- Non-additive metrics: one entity-day → the stored value; several rows → `averageViewDuration = estimatedMinutesWatched × 60 / engagedViews` (null when `engagedViews` is 0 or absent; listed in `approx`), `cpm = grossRevenue × 1000 / adImpressions`, `playbackBasedCpm = grossRevenue × 1000 / monetizedPlaybacks`, `averageViewPercentage = null`.
- Derived: `watchHours = estimatedMinutesWatched / 60`, `netSubscribers = subscribersGained − subscribersLost`, `rpm = estimatedRevenue × 1000 / views` where the denominator is the views of the rows that carry monetary keys (a channel without revenue data does not dilute RPM).
- Monetary keys are stripped unless `canMonetary`.

`summarize(series)` → `{ totals, coverage:{ covered, total }, monetaryCoverage:{ rows, monetaryRows, days, monetaryDays }, partialRevenue, approx }`. Totals are **recomputed from the per-day sums with the same formulas**, never averaged or passed through, so a 90-day `averageViewDuration` is `Σ minutes × 60 / Σ engagedViews` (`approx`), `cpm` is `Σ grossRevenue × 1000 / Σ adImpressions` and `rpm` uses only monetary rows' views. Exactly one covered day keeps its stored non-additive values. `partialRevenue` is true when some rows carry no monetary keys (`monetaryRows < rows`). `compareSummaries(current, previous)` → `{ [key]: percentChange | null }` (null when the previous value is 0 or absent); it accepts summaries or flat metric objects. `previousRange({ startDate, endDate })` is the immediately preceding range of the same length.

`readBreakdown(db, { ownerId, entityKey, dimension, startDate, endDate, canMonetary, limit })` → `{ rows:[{ value, metrics }], coveredDays, totalDays, status }`, aggregated per value with the rules above, sorted by `views` (`shares` for `sharingService`, `grossRevenue` for `adType`), `status` `ready` (every day covered), `partial`, `missing` (no covered day) or `unsupported` (`adType` without monetary access).

`readChannelTotals(db, { ownerId, channelIds|null, startDate, endDate, canMonetary })` → `Map(channelId → { metrics|null, coveredDays, daysWithRows, monetaryDays, firstDay, lastDay })`; `metrics` is null when `daysWithRows = 0`, and the UI shows "—" instead of 0 for such channels. `readFactRows` returns raw provenance rows (`entityKey, channelId, day, metrics, monetary, revision, source, firstSyncedAt, lastSyncedAt`) and throws HTTP 413 above `limit`.

`coverage(db, { ownerId, entityKey, startDate, endDate, canMonetary, lagDays, latestAllowedDay })` → `{ days:[{ day, facts, monetary, breakdowns, drift, pending }], covered, missing, pending, firstDay, lastDay, lastSyncedAt, driftDays }`. `pending` = not covered **and** `day > latestAllowedDay − lagDays` (YouTube has not published it yet); `missing` lists uncovered days that are old enough to exist. `firstDay`, `lastDay` and `lastSyncedAt` describe the entity's whole fact coverage, not only the range, so "data stops at {lastDay}" is global. `latestCoveredDay(db, ownerId, prefix)` returns the newest covered day for keys starting with `prefix` (`owner:` or `channel:`).

`history(db, { ownerId, entityKey, day, startDate, endDate, limit, before, canMonetary })` → `{ entries:[{ id, ownerId, entityKey, day, dimension, dimensionValue, action, previous, next, changedKeys:[{ key, before, after, value? }], jobId, recordedAt }], total, nextBefore }` newest first. `startDate`/`endDate` bound `day` (each optional; `startDate > endDate` throws 400) and are applied before `limit`, so a range export never loses in-range rows to the cap. Non-monetary readers are filtered in SQL (`monetary_only = 0 AND dimension <> 'adType'`), so `limit`, `total` and `nextBefore` are exact for every role; monetary keys are then stripped from `previous`/`next`/`changedKeys`. `nextBefore` is the id to pass as `before` for the next page, `null` when the page was not full. `changedKeys`: fact rows → one entry per differing key; breakdown drift → one per (value, key) from `next.changed`; breakdown overwrite → the row sets are diffed per value and key (`{ key, value, before, after }`, `before`/`after` null for a value or key present on one side only), so the ledger view and the history export show numbers for every entry. `pruneHistory(db, { before | now })` deletes `drift` rows older than 180 days (or `before`) and `overwrite` rows older than `ANALYTICS_HISTORY_OVERWRITE_DAYS` days (default 365; the value is read on every call) and returns the number of rows removed.

## Snapshot migration

`migrateSnapshotsToFacts(db, { now })` turns the legacy `daily` / `monetaryDaily` range snapshots into facts once:

0. Skip everything when `ANALYTICS_SKIP_SNAPSHOT_MIGRATION=1` (returns `{ skipped:true, reason:'ANALYTICS_SKIP_SNAPSHOT_MIGRATION=1' }`, nothing read or written, no meta row). This is the opt-out an operator sets after rolling the migrated facts back; without it the next start migrates again.
1. Skip when `analytic_meta['migration:snapshots-to-facts']` exists, unless `ANALYTICS_RERUN_SNAPSHOT_MIGRATION=1` (the result then carries `skipped: true`).
2. Select `analytic_snapshots` with `report_id IN ('daily','monetaryDaily')` whose selection has no `videoId`, no `country` and `includeHistoricalChannelData` false. Owner selections map to `owner:<scope>`, channel selections (`selection.channelId`) to `channel:<id>`.
3. Normalise `updated_at` (`YYYY-MM-DD HH:MM:SS` → `YYYY-MM-DDTHH:MM:SSZ`; the legacy table mixes both formats and a raw string sort would rank `…T…` above `… …` of the same day) and iterate **newest first**: a metric key already collected for a day wins, older snapshots only fill gaps. `daily` and `monetaryDaily` rows merge into one object per day.
4. Insert rows with `source = 'migration'`, `job_id = NULL`, `first_synced_at` = oldest contributing snapshot, `last_synced_at`/`last_changed_at` = newest. An existing fact row is never changed; only keys it lacks are filled.
5. Write `facts` coverage for days present in `rows_json` and ≤ `coverage_json.availableEndDate`, `monetary = 1` only when a `monetaryDaily` snapshot contributed, `synced_at` = newest contributing snapshot.
6. Store `{ done:true, at, facts, coverage }` under the meta key — all inside one transaction. No ledger rows are written.

Rollback (backend stopped; the same block as `analytics-schedule.md` §9): `DELETE FROM analytic_daily_facts WHERE source='migration'; DELETE FROM analytic_day_coverage WHERE job_id IS NULL AND kind='facts'; DELETE FROM analytic_meta WHERE key='migration:snapshots-to-facts';`. The SQL only resets the migration: the next backend start re-creates the same rows from the still-present snapshots unless `ANALYTICS_SKIP_SNAPSHOT_MIGRATION=1` is set in the environment (or the `daily`/`monetaryDaily` snapshots are deleted: `DELETE FROM analytic_snapshots WHERE report_id IN ('daily','monetaryDaily')`). Keep the flag set for as long as the rollback should hold. Delete only that meta key — `migration:schedule-v3` is the horizon of the daily-run status. Take a backup first with better-sqlite3's online `db.backup()` into the durable folder `backend/data/backups/` (command in `analytics-schedule.md` §9); a full restore is "stop the backend, copy the backup over `analytics.sqlite`, delete `-wal`/`-shm`".

## Exports

- `csvCell(value)`: numbers are emitted as numbers (`"-7"` is never neutralised), `null`/`undefined`/objects become `""`, strings matching `/^[\s﻿]*[=+\-@]|^[\t\r\n]/` get a leading apostrophe, every cell is double-quoted with `"` doubled.
- `buildCsv({ columns:[{ key, label }], rows })`: UTF-8 BOM, header row from labels, CRLF line ends.
- `buildWorkbook({ sheets:[{ name, columns:[{ key, label, type, width }], rows, totals? }], meta })` returns an ExcelJS workbook: a `Summary` sheet first when `meta` is given (title, Content Owner, range, generated at, language, notes), one sheet per entry with a frozen bold header row, number formats `#,##0` (`int`), `#,##0.00` (`float`), `"$"#,##0.00` (`money`), `0.0%` (`percent`, values are divided by 100 because the API reports percentages as `18.59`), text columns `numFmt '@'`. Every cell is a primitive: strings stay strings (a title `=HYPERLINK(...)` is a string cell without apostrophe, never a formula, hyperlink or rich-text object), numeric columns hold numbers or empty cells, dates are ISO strings. Sheet names drop `\ / * ? : [ ]`, are cut to 31 characters and de-duplicated with ` (2)`. Labels come from `analyticsLabels.js` in the requested language.

## Glossary (EN / VI)

| English | Vietnamese |
| --- | --- |
| Content Owner | Content Owner |
| channel | kênh |
| views | lượt xem |
| engaged views | lượt xem có tương tác |
| watch hours | giờ xem |
| estimated revenue | doanh thu ước tính |
| sync | đồng bộ |
| daily sync | đồng bộ hằng ngày |
| overwrite | ghi đè |
| only add missing | chỉ thêm số mới |
| drift | số liệu lệch |
| ledger | nhật ký thay đổi |
| coverage | độ phủ dữ liệu |
| schedule | lịch tự động |
| snapshot / range report | báo cáo theo kỳ |
| breakdown | phân tích theo |
| range | khoảng ngày |
| Pacific time | giờ Thái Bình Dương |
| pending | chưa công bố |
| provisional / unsettled | chưa chốt |
