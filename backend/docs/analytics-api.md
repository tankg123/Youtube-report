# Analytics API (`/api/analytics`)

The Analytics module answers every read from its own SQLite database (`backend/data/analytics.sqlite`, `ANALYTICS_DB_PATH`): the daily warehouse (`analyticsWarehouse.js`), the range snapshots and the job/schedule tables. Reads never call Google. Writes (sync jobs, schedules, Explorer queries) go through `analyticsService.js` and the sync engine; this document covers the HTTP contract of the router (`src/routes/analyticsRoutes.js`), the read service (`src/services/analyticsReadService.js`), the validation allow-lists (`src/services/analyticsValidate.js`), the request shapes the sync engine sends to Google, and every user-facing message string the read side can return.

Companion documents: `analytics-warehouse.md` (schema, write semantics, aggregation rules) and `analytics-schedule.md` (operator guide for the 09:00 daily sync).

## Roles and access

| Role | Reads | Monetary data | Writes (POST / PUT) |
| --- | --- | --- | --- |
| admin, super admin | every route | yes | yes, incl. `mode:'overwrite'` and schedules |
| Report Manager | every route | yes | yes, incl. overwrite and schedules |
| Content ID | every route | **no** — monetary metric keys, monetary reports, `adType` breakdowns and revenue exports are removed or refused (403) | yes, but never monetary syncs, overwrites or monetary schedules |
| + Read Only (combined with one of the above) | every route | as the base role | **no** — every POST/PUT answers 403 before any write |
| other roles (Partner, …) | 403 | — | — |

The router computes `access = { userId, canMonetary, canSync, canOverwrite, canManageSchedules }`: `canMonetary` = admin or Report Manager; `canSync` = not Read Only; `canOverwrite` = `canMonetary && canSync`; `canManageSchedules` = `canSync`. **Any Analytics role can read every configured Content Owner**: owners are not scoped per user, the role only decides monetary visibility and the right to write. Owner isolation is enforced by `owner_id` on every query, so one owner's facts, channels, ledger, jobs and snapshots never appear in another owner's answer.

Credentials never leave the credential bridge: owner rows are reduced to `{ id, ownerId, name, authStatus, authError, hasAnalyticsScope, hasMonetaryScope }`, user rows to `{ id, name }`, and the analytics database stores no token (the HTTP test scans every response and the database bytes for the fixture secrets).

## Response envelope

Every answer carries `Cache-Control: no-store`. JSON answers are `{ success:true, ...data }` or `{ success:false, message, error:{ reason, status, retryable }, plan? }`:

| Status | When |
| --- | --- |
| 400 | validation (allow-lists below); an over-cap sync carries `plan` |
| 401 / 403 | not signed in / role refused, Read Only on a write, monetary data for a non-monetary role |
| 404 | unknown Content Owner, channel outside the owner's inventory, unknown job or catalog report |
| 409 | `cmsNotConnected`, `tooManyJobs` (writes only; reads work while the CMS is disconnected) |
| 413 | `/facts` or an export above the row caps (`reason: tooManyRows`) |
| 4xx / 5xx from Google | passed through `safeError` (messages redacted) |
| 500 | any error without a status: the body is the generic `Internal error`, details are only logged on the server |

A failure after the response headers were sent (a streaming export) destroys the socket instead of writing JSON into the file.

## Routes

Common query parameters: `ownerId` (network code or numeric id, required), `startDate` / `endDate` (`YYYY-MM-DD`, see limits), `scope` (`claimed` default, `self`, `thirdParty`), `channelIds` (comma-separated, ≤ 200, regex `^UC[\w-]{22}$`, de-duplicated; IDs outside the owner's inventory are dropped and echoed in `unknownChannelIds` by the JSON routes — an export whose `channelIds` are *all* unknown answers 400 instead of widening to the owner), `channelId` (single channel), `compare` (`true` default, `false`), `lang` (`en` default, `vi`; exports only). Repeating a query key (Express 5 hands the route an array) answers 400 for every parameter.

An **entity** is what a selection resolves to: no channel → `owner` (`owner:<scope>`), one known channel → `channel`, several → `channels` (their facts are summed per day; breakdowns and range reports are unsupported).

### GET `/bootstrap`

`{ owners:[{ id, ownerId, name, authStatus, authError, hasAnalyticsScope, hasMonetaryScope, coverage:{ firstDay, lastDay, days, lastSyncedAt }, dailyRun }], permissions:{ canMonetary, canSync, canOverwrite, canManageSchedules }, defaults:{ scheduleTimes, timezone:"Asia/Bangkok", lagDays:3, lookbackDays:7, settleDays:7, channelBatch }, latestAllowedDay, catalog:{ metrics:[registry entries], breakdownDimensions:[{ key, perDay, monetary }], reportCatalog:[{ id, category, dimensions, metrics, monetary, requiresVideo, limit, default }] }, limits:{ maxDays, maxChannelIds, maxRequestsPerJob, maxExportRows, maxWorkbookRows, interactiveRows, topVideos }, database:{ name, isolated, facts, coverageRows, sizeBytes }, docs }`

- `coverage` is the owner-level fact coverage (`owner:*` keys); `latestAllowedDay` is the last completed Pacific-time day (PT today − 1).
- `catalog.metrics` lists the warehouse `METRIC_REGISTRY`; monetary entries are omitted for non-monetary roles. `reportCatalog` carries no labels (the UI owns them); monetary reports are omitted for non-monetary roles.
- `defaults.channelBatch` and `limits.maxRequestsPerJob` are the sync engine's own parsed values (`engine.effectiveLimits()`), so the plan the UI shows and the cap the engine enforces never disagree.
- `dailyRun` (also `/overview.dailyRun` and `/schedules[].lastRun` — one implementation, `analyticsService.dailyRunStatus(ownerId, access)`) = `{ status:'completed'|'partial'|'failed'|'running'|'queued'|'not-run'|'interrupted'|'cancelled', late, consecutiveFailures, streakStart, scheduledFor, nextRunAt, enabled, jobId, enqueuedAt, startedAt, finishedAt, firstError, counts, days:{ addedCount, driftedCount }|null }` for the latest 09:00 slot (`analytic_schedule_runs ⋈ analytic_jobs`, run rows walked newest first). A slot that passed without a run row (backend down) reads as `not-run`; slots older than the newest of the v3 schedule migration and the schedule's `updated_at` are never synthesised. **`late`** (exactly as implemented, `LATE_AFTER_MS = 15 min`) = the schedule is enabled **and** a slot exists **and** either the slot's job has a `started_at` more than 15 minutes after `scheduled_for`, or no job has started yet and `now − scheduled_for > 15 min` (a queued job waiting behind a long backfill is therefore late; a disabled schedule is never late). `consecutiveFailures` walks the run rows newest first and counts consecutive `failed` / `interrupted` / `cancelled` / `not-run` slots until the first `completed` or `partial` run; the current slot is skipped while its job is `queued`/`running`, while enqueue retries remain (`retry_at` in the future) or during the 15-minute grace; a synthesised `not-run` slot counts only once it is late. `firstError` is sanitised per role: null when the failing step is monetary and the caller cannot access revenue; without a job it is the slot's enqueue error. An owner without a schedule row gets the same shape with `enabled:false`, `status:'not-run'`, `late:false` (never null).

### GET `/overview`

Params: `ownerId, startDate, endDate, scope?, channelIds?, compare?`.

`{ selection:{ ownerId, startDate, endDate, scope, channelIds, entity, currency?:'USD', unknownChannelIds }, coverage, summary, series, previousSeries, breakdowns, topVideos, videoRevenue?, demographics, videos, dailyRun, latestJob, notes }`

- `selection.currency`, `summary.monetaryCoverage` and `summary.partialRevenue` (and `totalsMeta.monetaryCoverage` / `totalsMeta.partialRevenue` on `/channels`) are revenue bookkeeping: they are present for monetary roles only and absent from every non-monetary answer.

- `coverage`: warehouse coverage for the entity (`days[]`, `covered`, `missing[]`, `pending[]`, `firstDay`, `lastDay`, `lastSyncedAt`, `driftDays`) plus `staleDays` (= `latestAllowedDay − lagDays − lastDay`, 0 minimum, null without data), `status:'complete'|'partial'|'empty'` (`complete` = no missing day; pending days do not count), `lagDays`, `latestAllowedDay`. Several channels count a day as covered when any of them is.
- `summary`: `{ current, previous, changes, previousRange, coverage:{ covered, total }, previousCoverage, monetaryCoverage?:{ rows, monetaryRows, days, monetaryDays }, partialRevenue?, approx }` — `current`/`previous` are `summarize().totals` of the two series (recomputed from sums, never passed through), `changes` = percent change per key or null; `previous`/`changes`/`previousSeries` are null with `compare=false`.
- `series` / `previousSeries`: `[{ day, metrics|null, covered, rows, monetaryRows, monetaryViews, approx }]` (`metrics` null = not synced; a covered day without rows is zeros).
- `breakdowns`: `{ <dimension>: { rows:[{ value, metrics }], coveredDays, totalDays, status } }` for every breakdown dimension (`adType` only for monetary roles). Owner entity → warehouse facts (`status` `ready|partial|missing`); one channel → the channel's pinned range snapshots (`countries, trafficSources, devices, operatingSystems, subscribedStatus, contentTypes, playbackLocations, youtubeProducts`) with `source:'snapshot'` and the snapshot status mapping below (`liveOrOnDemand`, `sharingService`, `adType` → `unsupported`); several channels → every dimension `unsupported`.
- `topVideos`, `videoRevenue` (monetary roles only), `demographics`: range snapshots for exactly this range and scope (channel: the pinned selection `{ scope:'self', channelId, currency:'USD', includeHistoricalChannelData:false }`), mapped as below; `videos` = metadata `{ videoId, channelId, title, thumbnail, duration, publishedAt }` for the videos in those reports.
- `latestJob`: the owner's newest job sanitised per role (`getJob(id, access)`), or null.
- `notes`: static English sentences (listed below) the UI translates.

Snapshot status mapping (overview, channel detail, `/snapshots`): stored `ready|empty` → `status:'ready'` (`empty:true` for an empty table), `stale` → `status:'ready', stale:true, attemptedAt, error`, `error|missing` → `status:'missing', error`.

### GET `/channels/inventory`

Params: `ownerId`. `{ ownerId, channels:[{ channelId, title, thumbnail, country, publishedAt, removedAt }], updatedAt }` — cheap; channels that disappeared from the CMS listing stay with `removedAt` set.

### GET `/channels`

Params: `ownerId, startDate, endDate, channelIds?, search?, sort?, direction?, page?, pageSize?, country?, status?`.

`{ selection, rows:[…], totals, totalsMeta, coverage:{ inventoryCount, activeCount, withData, inventoryUpdatedAt }, total, page, pageSize, sort:{ key, direction }, unknownChannelIds, latestJob, notes }`

- Row: `{ channelId, title, thumbnail, country, publishedAt, removedAt, subscribersTotal, lifetimeViews, videoCount, metrics|null, coveredDays, daysWithRows, totalDays, monetaryDays, firstDay, lastDay, status, monetaryStatus }`. `status` = `ready` (every day of the range covered), `partial`, `missing` (no covered day); `monetaryStatus` = `hidden` for non-monetary roles, else the same scale over the days covered by a monetary request. `metrics` is null when the channel has no stored row in the range (YouTube omits channels without activity).
- `search` (≤ 200 characters) matches title and channel ID after Unicode folding (`Kênh Đẹp` matches `kenh dep`); `country` is a two-letter code; `status` ∈ `ready|partial|missing`.
- `sort`: one of `title, country, publishedAt, subscribersTotal, lifetimeViews, videoCount, coveredDays, daysWithRows, firstDay, lastDay, views, engagedViews, estimatedMinutesWatched, watchHours, averageViewDuration, likes, comments, shares, subscribersGained, subscribersLost, netSubscribers, estimatedRevenue, estimatedAdRevenue, grossRevenue, monetizedPlaybacks, adImpressions, cpm, playbackBasedCpm, rpm`; `-views` or `direction=desc` sorts descending (default: text columns ascending, metrics descending); monetary keys answer 403 for non-monetary roles; rows without a value sort last; ties fall back to the title.
- `page` ≥ 1, `pageSize` 1–200 (default 50). `totals` = `summarize()` of the series summed over the filtered rows (+ `rpmChannelCount` for monetary roles: channels with revenue and views); `totalsMeta` = its `coverage`, `approx` and, for monetary roles, `monetaryCoverage`, `partialRevenue`.

### GET `/channels/:channelId`

Params: `ownerId, startDate, endDate, compare?`. 400 for a malformed ID, 404 when the channel is not in the owner's inventory.

`{ selection, channel:{ …metadata, subscribersTotal, lifetimeViews, videoCount, metrics, coveredDays, daysWithRows, totalDays, monetaryDays, firstDay, lastDay, status, monetaryStatus }, coverage, summary, series, previousSeries, breakdowns, topVideos, videoRevenue?, demographics, videos, latestJob, notes }` — the same blocks as the overview for the `channel` entity (breakdowns from the pinned channel snapshots, `adType` unsupported).

### GET `/coverage`

Params: `ownerId, startDate, endDate, scope?, channelId?`. `{ ownerId, entityKey, startDate, endDate, days:[{ day, facts, monetary, breakdowns:[dimension], drift, pending }], covered, missing, pending, firstDay, lastDay, lastSyncedAt, driftDays, staleDays, status, lagDays, latestAllowedDay, summaryByMonth:[{ month, covered, total, drift, missing, pending }] }`.

### GET `/history`

Params: `ownerId, entityKey?, day?, startDate?, endDate? (day bounds, either side optional, start ≤ end, bound in SQL before the limit), limit? (1–1000, default 100), before? (ledger id)`. `{ ownerId, entries:[{ id, entityKey, day, dimension, dimensionValue, action:'overwrite'|'drift', previous, next, changedKeys:[{ key, before, after, value? }], jobId, requestedBy, createdBy:{ id, name }|null, kind, mode, recordedAt }], total, nextBefore }` newest first. Rows a non-monetary role would see nothing of (`monetary_only = 1`: only monetary keys changed, or `dimension = 'adType'`) are filtered in SQL for such roles, so `limit`, `total` and `nextBefore` are exact for every role; monetary keys are then stripped from `previous` / `next` / `changedKeys`. `nextBefore` is the ledger id to send as `before` for the next page, `null` when the page was not full. Breakdown overwrite entries carry `previous` = the stored row set, `next` = the row set after the write and `changedKeys` = one `{ key, value, before, after }` per changed (value, key) (`before`/`after` null for a value or key present on one side only). `requestedBy`, `kind`, `mode` come from the job row, `createdBy.name` from the credential database's users table (name only, never the email).

### GET `/facts`

Params: `ownerId, startDate, endDate, scope?, channelIds?`. `{ selection, rows:[{ entityKey, channelId|null, title|null, day, metrics, monetary, revision, source, firstSyncedAt, lastSyncedAt }], total }` — raw fact rows with provenance; 413 above `limits.maxExportRows` (100,000).

### GET `/snapshots`

Params: `ownerId, startDate, endDate, scope?, channelId?, videoId?, country?, currency?, reportId?`. `{ selection, reports:{ [id]: { id, status, empty, stale, rows, columnHeaders, updatedAt, error, errorDetails, attemptedAt, coverage, query } } }` for every public catalog report (monetary reports omitted for non-monetary roles; a monetary `reportId` answers 403, an unknown one 404). This is the Explorer's stored-result source and replaces the former `/dashboard`. Channel-detail snapshots live under the pinned selection (`scope=self` + `channelId`).

### GET `/export`

Params: `ownerId, startDate, endDate, type, format? (csv default | xlsx), lang? (en | vi), scope?, channelIds?, channelId?, dimension?` plus the `/channels` filters for `type=channels`, and `entityKey?`/`day?` for `type=history`.

| `type` | Content | csv | xlsx |
| --- | --- | --- | --- |
| `overview` | Summary, Daily, Channels, one sheet per breakdown of the entity | — (400) | ✓ |
| `daily` | one row per day of the range: day, status (stored / missing / not yet published), metrics, provenance | ✓ | ✓ |
| `channels` | the channels table (filters applied, no paging): metadata, public counts, statuses, coverage, metrics | ✓ | ✓ |
| `channel-days` | fact rows of the selected channels (`channelId`, `channelIds`, or every managed channel): channel, day, metrics, provenance | ✓ | ✓ |
| `breakdown` (`dimension` required) | owner breakdown of the scope, or the pinned snapshot of the single channel: value label, code, metrics, share of the sort metric | ✓ | ✓ |
| `top-videos` / `video-revenue` (monetary) | the range snapshot (owner scope or the single channel) with video metadata | ✓ | ✓ |
| `demographics` | age group, gender, viewer percentage (owner scope or the single channel) | ✓ | ✓ |
| `revenue` (monetary) | Summary, Daily revenue, By channel, By country, By content type, By ad type | — (400) | ✓ |
| `coverage` | one row per day of the owner scope or the single channel: stored, revenue included (monetary roles), breakdowns, drift, not yet published | ✓ | ✓ |
| `history` | the newest 1,000 ledger entries whose day falls in the range (the range is bound in SQL before the cap; optionally `entityKey` / `day`); when the cap still cut rows the Summary notes say so | ✓ | ✓ |

- **Single-channel rule** (`breakdown`, `top-videos`, `video-revenue`, `demographics`, `coverage`): the channel is `channelId`, or the one channel of `channelIds` when exactly one is selected; two or more selected channels answer 400 `Select one channel or none for this export.` (`daily`, `channels`, `channel-days`, `overview`, `revenue` honour several channels as the JSON routes do).
- A `channelIds` filter made only of IDs outside the owner's inventory answers 400 `Unknown channel IDs: …` for every export type instead of silently exporting the owner totals or every channel.

- Provenance columns: `Day (Pacific time), First synced (GMT+7), Last synced (GMT+7), Revision, Source`; instants are rendered in GMT+7 as `YYYY-MM-DD HH:mm`.
- Labels, statuses, dimension values (ICU region names, age groups, brand names) and sheet names come from `analyticsLabels.js` in the requested language.
- CSV: UTF-8 BOM, CRLF, every cell quoted, formula-leading strings get an apostrophe (`'=HYPERLINK(...)`), streamed with back-pressure; the row source is capped at 100,000 rows (413). XLSX: a `Summary` sheet (title, Content Owner, range, generated at, language, notes), frozen bold headers, typed cells (`#,##0`, `#,##0.00`, `"$"#,##0.00`, `0.0%`), strings never become formulas; 50,000 rows maximum (413). A covered day without a revenue row exports blank revenue cells, not zeros.
- Monetary columns, `video-revenue`, `revenue` and `breakdown&dimension=adType` are refused (403) for non-monetary roles.
- Filename: `analytics-<type>[-<dimension>]-<ownerId>-<startDate>-<endDate>.<csv|xlsx>` built from validated tokens only; `Content-Disposition: attachment`.
- Legacy: `GET /export?reportId=<catalog id | custom:…>&ownerId&startDate&endDate&scope…` keeps serving the stored snapshot / Explorer query as CSV (`analytic-<reportId>-<start>-<end>.csv`).

### Jobs, sync, queries, schedules

| Method & path | Body / params | Answer |
| --- | --- | --- |
| GET `/jobs?ownerId&limit` | `limit` 1–100 (default 20) | `{ jobs }` sanitised per role (`listJobs(ownerId, access, limit)`) |
| GET `/jobs/:id` | — | `{ job }` (`getJob(id, access)`) |
| POST `/sync` | v2 bodies (`kind: daily | full | channelDetail`, `dryRun:true` → plan only) or the legacy snapshot body | `{ job, deduplicated }` or `{ plan }`; 400 with `plan` when over `maxRequestsPerJob` |
| POST `/jobs/:id/cancel` | — | `{ job }`; 403 for a non-monetary role on a monetary job |
| POST `/query` | Explorer catalog report or custom query | `{ report }` |
| GET `/queries?ownerId` | — | `{ queries }` (monetary ones hidden from non-monetary roles) |
| GET `/schedules` · PUT `/schedules` | schedule fields | `{ schedules }` (`getSchedules(access)`: each `lastRun` is the role-sanitised `dailyRun` above) / `{ schedule }` (PUT needs `canManageSchedules`; an **enabled** `monetary:true` schedule needs the owner's CMS token to carry `yt-analytics-monetary.readonly`, else 400 `monetaryScopeMissing`; a disabled monetary schedule can still be saved) |

POST and PUT run through `requireSync`: a Read Only account receives 403 before the service is called.

## Allow-lists and limits

| Parameter | Accepted |
| --- | --- |
| `scope` | `claimed`, `self`, `thirdParty` |
| `startDate`, `endDate`, `day` | `YYYY-MM-DD`, a real calendar day, ≥ 2009-01-01, ≤ today (UTC), start ≤ end, ≤ 366 days |
| `channelIds` | csv of `^UC[\w-]{22}$`, ≤ 200, unknown IDs echoed in `unknownChannelIds` (exports: 400 when every ID is unknown; single-entity exports: 400 for more than one channel) |
| `channelId`, `entityKey` | `^UC[\w-]{22}$` / `^(owner:(claimed\|self\|thirdParty)\|channel:UC[\w-]{22})$` |
| `dimension` | `insightTrafficSourceType, insightPlaybackLocationType, deviceType, operatingSystem, subscribedStatus, liveOrOnDemand, youtubeProduct, creatorContentType, adType (monetary), country, sharingService` |
| `type` | `overview, daily, channels, channel-days, breakdown, top-videos, video-revenue, demographics, revenue, coverage, history` |
| `format` / `lang` | `csv, xlsx` / `en, vi` |
| `sort`, `direction`, `status` | the `/channels` lists above; `asc, desc`; `ready, partial, missing` |
| `page`, `pageSize`, `limit`, `before` | integers; `pageSize` ≤ 200, `/history` `limit` ≤ 1000, `/jobs` `limit` ≤ 100 |
| `search` | ≤ 200 characters, matched in JavaScript |
| `compare` | `true`, `false`, `1`, `0` |

Limits (also in `bootstrap.limits`): `maxDays 366`, `maxChannelIds 200`, `maxRequestsPerJob` (`ANALYTICS_MAX_REQUESTS_PER_JOB`, default 5000, 1–1,000,000), `maxExportRows 100000`, `maxWorkbookRows 50000`, `interactiveRows 100000` (Explorer), `topVideos 200`; `channelBatch` (`ANALYTICS_CHANNEL_BATCH`, default 200, 1–500). The two env-driven values are parsed once by the sync engine (`effectiveLimits()`, out-of-range values fall back to the default) and the read service reuses them. SQL uses bound parameters only; dimension names are never interpolated (every dimension comes from the list above and the warehouse binds it).

## Requests sent to Google (sync engine)

Reads send nothing. The sync engine (`analyticsSyncEngine.js`) and the Explorer query YouTube with the Content Owner's OAuth token (`Authorization: Bearer …`, 35 s timeout, no redirects, 401 → exactly one token refresh per call (not counted as an attempt), 429/5xx/timeouts → 3 attempts in all with `retry-after` honoured up to 5 s; a 429 that survives the retries fails the job whatever the body says; a `channels.list` quota/403/429/5xx failure is only a step warning that reuses the stored inventory, a refused credential fails the job; a MONEY request answered 403 `insufficientPermissions` skips revenue for the rest of the job; ≤ 4 requests per second, `ANALYTICS_PACE_MS`):

- **Inventory** — Data API v3 `GET https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,contentDetails&managedByMe=true&onBehalfOfContentOwner=<ownerId>&maxResults=50[&pageToken]` (1 unit per page). Video metadata: `GET /youtube/v3/videos?part=snippet,contentDetails,statistics&id=<≤ 50 ids>&onBehalfOfContentOwner=<ownerId>`.
- **Owner facts** — Analytics API v2 `GET https://youtubeanalytics.googleapis.com/v2/reports?ids=contentOwner==<ownerId>&startDate&endDate&dimensions=day&filters=<scope>&metrics=<BASIC>&sort=day&maxResults=200&startIndex=…` per contiguous run ≤ 366 days, then the same with the MONEY metrics when the job is monetary. Scope filters: `claimedStatus==claimed` (claimed), `uploaderType==self` (self), `claimedStatus==claimed;uploaderType==thirdParty` (thirdParty); the three overlap and are never summed.
- **Channel facts** — per day `D`: `dimensions=channel&filters=channel==<≤ channelBatch ids>&startDate=D&endDate=D&metrics=<BASIC|MONEY>&maxResults=<ids>`; channels without activity are absent from the answer and stored as covered zeros.
- **Breakdowns** — `dimensions=<dimension>,day&filters=<scope>&sort=day&maxResults=200` per ≤ 90-day chunk for `insightTrafficSourceType, insightPlaybackLocationType, deviceType, operatingSystem` (metrics `views,engagedViews,estimatedMinutesWatched`), `subscribedStatus, liveOrOnDemand, youtubeProduct` (playback metrics), `creatorContentType` (BASIC + MONEY), `adType` (`grossRevenue,adImpressions,cpm`, monetary, owner level only). Per-day shapes (`day` is not a valid companion): `dimensions=country` and `dimensions=sharingService` (`metrics=shares`) with `startDate=endDate=D`.
- **Range snapshots** — the catalog reports in `analyticsCatalog.js` (`videos`, `videoRevenue`, `demographics`, the channel-detail set) with `metrics`, `dimensions`, `filters`, `sort`, `maxResults` (200 for top-video reports, 25 for detail reports), `currency=USD`, `includeHistoricalChannelData=false`; the Explorer sends its validated custom query the same way.

`day` rows are Pacific-time days; the API only returns days for which every requested metric is final. The daily sync *requests* the window ending `lagDays` (3 by default) before the run (Bangkok date − lagDays) and stores **every day YouTube has published** inside it — normally up to 4 days back, because at 09:00 GMT+7 the day `T − 3` is only ~43 h past its Pacific midnight while YouTube needs 48–72 h; the last 1–2 days of the window are usually still *not yet published* (`pending`) and are requested again the next morning. `lagDays` is a request bound, not a promise of which day gets stored.

## User-facing messages

The frontend dictionary `src/i18n/vi/analyticsServer.js` is filled from this list; English is the key. Placeholders in braces are substituted by the server before sending.

Validation (`analyticsValidate.js`, HTTP 400 unless noted):

- `{name} must be a single value.`
- `{name} must be one of: {values}.` (`scope`, `type`, `format`, `lang`, `status`, `direction`)
- `{field} must use YYYY-MM-DD.`
- `{field} is not a valid date.`
- `Dates must be between 2009-01-01 and today.`
- `startDate must not be after endDate.` (also for the optional `/history` bounds)
- `Date range must contain between 1 and 366 days.`
- `channelId must be a single value.`
- `Invalid YouTube channel ID.`
- `Invalid YouTube video ID.`
- `Select at most 200 channels.`
- `dimension must be one of: {dimensions}.`
- `type must be one of: {types}.`
- `sort must be one of: {keys}.`
- `{name} must be an integer between {min} and {max}.`
- `search must be at most 200 characters.`
- `country must use a two-letter ISO country code.`
- `Invalid entity key.`
- `{name} must be true or false.`
- `Unknown catalog report.` (404)
- `Your role cannot access Analytics revenue.` (403)

Read service (`analyticsReadService.js`):

- `Channel is not in this Content Owner's managed inventory. Refresh the channel inventory first.` (404)
- `This export is available as xlsx only.` (400)
- `The export is too large for Excel (more than 50,000 rows). Export CSV or shorten the range.` (413)
- `Select one channel or none for this export.` (400)
- `Unknown channel IDs: {ids}. Refresh the channel inventory or clear the channel filter.` (400; `{ids}` is the comma-separated list)
- History export note (server-translated, inside the workbook Summary sheet, not a dictionary key): `The ledger holds {total} entries in this range; only the newest {count} are exported. Shorten the range for the rest.` / vi `Nhật ký thay đổi có {total} mục trong khoảng này; chỉ {count} mục mới nhất được xuất. Hãy thu hẹp khoảng ngày để lấy phần còn lại.`

Notes (`overview.notes`, `channels.notes`, `channelDetail.notes`):

- `Missing days have not been synced yet; they are not zero.`
- `The most recent days are not published by YouTube yet.`
- `YouTube now reports different numbers for some stored days; see the change ledger.`
- `Revenue is stored for only part of this range.`
- `Average view duration is approximated from minutes watched and engaged views.`
- `Breakdowns are stored per Content Owner; select one channel or none.`
- `Range reports (top videos, age and gender) exist only for ranges that were synced as a whole.`
- `Channel breakdowns come from the channel's range reports; sync the channel reports for this range.`
- `This channel is no longer managed by the Content Owner.`
- `Subscribers, lifetime views and video counts are current public numbers from the YouTube Data API, not changes within the range.`
- `A channel without stored rows shows no metrics: YouTube omits channels without activity.`
- `Totals include only channels with stored rows in the range.`

Router (`analyticsRoutes.js`):

- `This account is read only. Business data actions are disabled.` (403, also sent by the auth middleware)
- `Internal error` (500)

Warehouse messages that can reach a response through the read routes (`analyticsWarehouse.js`):

- `The selection contains {n} rows; the limit is {limit}. Shorten the range or select fewer channels.` (413)
- `Invalid entity key.` · `startDate must not be after endDate.` · `{field} must use YYYY-MM-DD.` (400)

Owner resolution and legacy selection messages from `analyticsService.js` that the read routes pass through:

- `Content Owner is required.` · `Invalid Content Owner identifier.` (400) · `Content Owner is not configured.` (404)
- `CMS OAuth is not connected for this Content Owner.` · `CMS credentials are missing.` (409, writes only)
- `/snapshots` and the legacy export: `scope must be claimed, self, or thirdParty.` · `Choose either a channel filter or a video filter.` · `currency must be a three-letter currency code.` · `Unknown report.` (404) · `No stored snapshot is available for this report and selection.` (404)
- Jobs: `Sync job not found.` (404) · `Your role cannot cancel an Analytics revenue sync.` (403)

Sync engine, schedules and recovery (`analyticsService.js`, `analyticsSyncEngine.js`; the full list, including the stage-2 strings, is `analytics-schedule.md` §10 — every entry belongs in the same dictionary). Added by the post-review fixes:

- `Revenue cannot be scheduled: the CMS token has no revenue scope.` (400 `monetaryScopeMissing`, PUT `/schedules` with an enabled monetary schedule)
- `Revenue was not requested: the CMS token has no revenue scope.` (`notes[]` of a `daily` job whose schedule wants revenue the token cannot read)
- `Revenue was skipped: the CMS token has no revenue scope.` (`result.notes[]` / `steps[].note` after a 403 `insufficientPermissions` on a revenue request; the `adType` step is `skipped` with the same note)
- `Server restarted before this sync finished. It was interrupted {n} times and was not queued again; start a new sync.` (`errors[]`, reason `serverRestart`, after the third interruption of one recovery chain; dynamic → regex rule)

Console-only lines (never sent to a client, not translated): `[analytics] another backend (pid {pid}) holds the analytics worker lease; …`, `[analytics] worker startup failed (will retry on the next tick): {message}`, `[analytics] worker lease unavailable (will retry on the next tick): {message}`, `[analytics] worker start failed: {message}`, `[analytics] ANALYTICS_ALERT_EMAILS is set but SMTP_HOST/SMTP_USER/SMTP_PASS are missing; daily-sync alert emails cannot be sent`, `[analytics] job={id} ended {status} but its row was no longer running; left untouched`.

Frontend-only sentences introduced by the same fixes (rendered with `t()`, keys live in `vi/analyticsSync.js`, `vi/analyticsKit.js`, `vi/analyticsShared.js`, `vi/analyticsOverview.js`, not in the server dictionary): `This range stops before {date}: {count} newer days are not included.`, `Overwrite {count} days` (= `plan.days.storedFacts` of the dry-run plan — the days that already hold facts for the first entity —, falling back to `requested − missingFacts`, and to the range length while it loads), `Change ledger of {entity} (CSV)` / `Change ledger of {entity} on {date} (CSV)` (the ledger panel export sends `entityKey` / `day` through `/export?type=history`; panel export menus are otherwise client-side only, server files live in the top-bar menu), `Newer data is stored up to {date} — this range ends earlier.`, `Use latest data`, `The link's date range was invalid — showing the last 28 days`, the three OAuth reason sentences of the disconnected banner, `{inserted} rows added · {drift} rows drifted`, and the two schedule sentences about unsettled days. The Sync-all dialog defaults its range to end at `latestAllowedDay − lagDays` (extended from the filters, never shortened, clamped to 366 days by moving the start).
