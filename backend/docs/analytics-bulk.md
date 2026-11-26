# Analytic: Content Owner bulk archive

The Analytic module uses `backend/data/analytics.sqlite`, separate from Report persistence. Bulk Reporting data lives exclusively in `analytic_bulk_*` tables. The existing `networks` rows provide the CMS Content Owner ID and OAuth credentials; refreshing an existing OAuth token uses the shared credential bridge. Bulk never reads Report channel, revenue, expense, partner or report tables.

## APIs and permissions

Bulk routes are mounted at `/api/analytics/bulk`. They require the existing login JWT and the existing API key middleware. Because Google system-managed reports include financial data, all bulk routes require `admin`, a super-admin role, or `Report Manager`. `Read Only` combined with an authorized role permits GET requests and denies POST requests, including cancellation.

The authenticated Google account must be linked to the selected Content Owner. The Google Cloud project must enable YouTube Reporting API. Existing OAuth grants need `yt-analytics.readonly` or `yt-analytics-monetary.readonly`, with the monetary scope required for financial report types. API availability depends on the CMS account and its Google permissions.

Successful JSON responses use `{ "success": true, "data": ... }`. Failures use `{ "success": false, "message": "..." }`. No route returns CMS access tokens, refresh tokens, client secrets or download URLs.

| Method and path | Parameters/body | Result |
| --- | --- | --- |
| `GET /catalog` | `ownerId`, optional `cached=true` | `{ownerId, reportTypes, jobs, storage, maxReportBytes, cached}`; cached mode reads local archive only |
| `POST /jobs` | `{ownerId, reportTypeIds:[...]}` or `{ownerId, all:true}` | HTTP 202; durable `create_jobs` run |
| `GET /reports` | `ownerId`, `jobId` | Available and previously archived report metadata, imported flags, row/byte counts, columns and superseded flags |
| `POST /sync` | `{ownerId, jobIds?:[...]}` | HTTP 202; durable `sync` run; omitted/empty job list processes all existing jobs |
| `GET /runs` | `ownerId` | Last 30 runs for that Content Owner |
| `GET /runs/:id` | run ID | Current progress and report/job errors |
| `POST /runs/:id/cancel` | no body required | Cancellation status; stops downloads and discards incomplete staged rows |
| `GET /data` | `ownerId`, `reportTypeId`, optional `reportId`, `page`, `pageSize` | `{columns, rows, total, page, pageSize, reports}`; at most 200 rows per page |
| `GET /export` | `ownerId`, `reportId` | Excel-compatible UTF-8 CSV attachment with spreadsheet formulas neutralized |

`ownerId` is the actual CMS Content Owner ID from bootstrap; the existing numeric network ID also resolves to the same owner. Invalid/unknown owners are rejected. Raw cells remain strings to preserve long Google IDs, precision, empty dimensions and the exact data returned by Google.

Stored data, CSV exports and run history remain available if CMS OAuth is disconnected. Remote discovery, downloads, syncs and job creation still require a connected CMS credential.

Data rows include `_periodStart`, `_periodEnd`, `_reportCreatedAt`, and `_reportId` provenance columns, because monthly financial summary CSVs may contain no date fields. If an original CSV column conflicts, all provenance names gain another underscore until the prefix is collision-free. `sourceColumns` contains the original Google schema and `provenanceColumns` maps the four metadata names to their actual response keys. Original CSV values and raw exports stay intact.

Runs have `id`, `ownerId`, `kind`, `status`, `createdAt`, `updatedAt`, `finishedAt`, `totalJobs`, `completedJobs`, `createdJobs`, `existingJobs`, `totalReports`, `importedReports`, `skippedReports`, `failedReports`, `rowsImported`, `currentJob`, `currentReport`, `errors`, and optional `error`. Statuses are `queued`, `running`, `cancelling`, `completed`, `partial`, `failed`, `cancelled`, or `interrupted`. The errors list retains the most recent 200 errors. Only one active bulk run per Content Owner is allowed; attempts to start another return HTTP 409 and the active `runId`.

## Ingestion behavior

Discovery reads every page from `reportTypes.list` and `jobs.list` with `includeSystemManaged=true`. The report type catalog is dynamic, including system-managed financial, ownership, metadata, asset or reference reports when Google exposes them. Creating jobs is an explicit POST action and never runs during discovery. System-managed jobs already exist and cannot be created. User-managed jobs are created with at most three concurrent calls; existing unexpired jobs are reused. Failed/lost POST replies are not automatically retried because a remote job may already exist.

Sync reads every report page for each selected existing job. It downloads all available unimported reports, retaining all CSV columns without hard-coded schemas. Downloads use authenticated HTTPS GETs to the exact Google Reporting hosts and media paths; redirects are disabled to prevent forwarding OAuth credentials. Download URLs come only from Google's authenticated report listing.

The default limit is **64 MiB per decompressed CSV**. Set `ANALYTICS_BULK_MAX_BYTES` to change it, up to 512 MiB. Downloads are streamed and counted as they arrive. A report above the limit fails with a visible report error; other reports continue. Increase the limit deliberately for larger CMS reports and retry. JSON/HTML error responses and malformed CSV are rejected.

The parser supports UTF-8 BOM, quoted commas, escaped quotes, CRLF, multiline fields, empty cells and header-only empty reports. It rejects mismatched row lengths, duplicate/empty column names, more than 1,024 columns and cells over 4 MiB. A malformed report never replaces a previous successful import.

CSV rows stage in batches of 1,000 with event-loop yields. A final SQLite transaction commits the raw CSV, SHA-256, schema, row count and the active row generation. Until then, readers continue to see the previous complete report. Cancellation or an import failure discards the staged generation. Report ID plus Google creation timestamp makes repeated syncs idempotent.

Backfill reports have new report IDs for an existing interval. For the same owner/job/start/end interval, the newest successfully imported creation timestamp supersedes older reports. System-managed reports with a start time and no end time use an empty end time consistently. Default data browsing and storage totals exclude superseded reports, preventing double counting. Original raw CSV files remain available by individual report ID for auditing.

At server startup, call `analyticsBulkRoutes.initialize()`. It marks unfinished runs `interrupted` and removes orphaned staged rows while keeping committed data. Interrupted runs are not silently restarted. A subsequent sync safely skips committed reports and retries unfinished ones. Deploy one Node process per SQLite data directory; live run cancellation controllers are local to that process.

## Google availability limits

The archive can fetch all report types and report files **that Google currently exposes for the connected Content Owner**. It cannot recover files that Google no longer makes available. New user-managed jobs generally need up to 24 hours for their first report; Google may also generate approximately 30 days of historical data. Standard generated reports are available for 60 days; historical reports for newly scheduled jobs are available for 30 days. Financial system-managed reports have their own availability and permissions. Bulk retention in this application's database continues until an administrator manages that database.

Dashboard totals use the separate targeted Analytics API queries. Bulk reports contain different dimensions and overlapping report types, so summing arbitrary rows across types would duplicate metrics. The archive exposes detailed rows per report type and original source files instead.

Official references:

- [Reporting API workflow, data characteristics and backfills](https://developers.google.com/youtube/reporting/v1/reports)
- [Available report types and system-managed discovery](https://developers.google.com/youtube/reporting/v1/reference/rest/v1/reportTypes/list)
- [Existing reporting jobs](https://developers.google.com/youtube/reporting/v1/reference/rest/v1/jobs/list)
- [Explicit job creation](https://developers.google.com/youtube/reporting/v1/reference/rest/v1/jobs/create)
- [Report list and pagination](https://developers.google.com/youtube/reporting/v1/reference/rest/v1/jobs.reports/list)

## Validation

Run `node --test test/analyticsBulk.test.js test/analyticsBulkHttp.test.js` from `backend`. Tests cover quoted/multiline CSV, long IDs, host validation, OAuth redirect prevention, byte limits, all-page discovery, loop detection, atomic replacement, new-ID backfills, missing end times, isolation by owner, formula-safe exports, idempotent sync, cancellation, restart recovery, bounded job creation and real Express/JWT role boundaries.

Live verification should list the catalog and existing jobs, then sync one deliberately selected small existing job. It does not need to create remote reporting jobs.
