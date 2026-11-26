import { Fragment } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, BadgeCheck, ChevronLeft, ChevronRight, Eye, RefreshCw, ShieldAlert, ShieldCheck, Undo2, Unlock, Upload } from "lucide-react";
import { useI18n } from "../../context/I18nContext";
import { tk } from "../../i18n/index.js";
import { Button, IconButton } from "../assetDelivery/shared";
import { cx, formatDateTime, truncate } from "../assetDelivery/utils";
import { RELEASABLE_STATUSES, RELEASE_UNKNOWN_STATUS } from "./constants";
import { AssetSummary, BlockedHint, ClaimStatusBadge, MonoId, ReleaseButton, ToneBadge, VideoSummary } from "./shared";
import {
  claimKey,
  confirmBlockReason,
  contentTypeLabel,
  isConfirmable,
  isReinstatable,
  isReleasable,
  isSelectable,
  normalizeStatus,
  originLabel,
  outcomeLabel,
  reinstateBlockReason,
  releaseBlockReason
} from "./utils";

const COLUMNS = [
  { key: "select", label: "", className: "w-10" },
  { key: "video", label: tk("Video"), sortKey: "video", flatOnly: true },
  { key: "claim", label: tk("Claim"), sortKey: "claim" },
  { key: "cms", label: tk("CMS") },
  { key: "asset", label: tk("Asset") },
  { key: "status", label: tk("Status"), sortKey: "status" },
  { key: "type", label: tk("Type") },
  { key: "origin", label: tk("Origin") },
  { key: "created", label: tk("Created"), sortKey: "created" },
  { key: "modified", label: tk("Modified"), sortKey: "modified" },
  { key: "actions", label: tk("Actions"), className: "text-right" }
];

// Outcomes that changed the claim's status in this session (green line under the status badge).
const SUCCESS_OUTCOMES = ["released", "reinstated", "confirmed"];
// Prefix of a failed outcome's message, per write; a plain release failure needs none.
const FAILED_PREFIXES = { reinstate: tk("Reinstate failed: "), confirm: tk("Confirm failed: ") };

function HeaderCell({ column, sort, onSort }) {
  const { t } = useI18n();
  if (!column.sortKey) {
    return (
      <th scope="col" className={cx("px-3 py-3", column.className)}>
        {t(column.label)}
      </th>
    );
  }
  const active = sort?.key === column.sortKey;
  const Icon = active ? (sort.dir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <th scope="col" aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"} className={cx("px-3 py-3", column.className)}>
      <button
        type="button"
        onClick={() => onSort(column.sortKey)}
        title={t("Sort by {column}", { column: t(column.label).toLowerCase() })}
        className={cx(
          "inline-flex items-center gap-1 rounded-md uppercase tracking-wide transition hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-200",
          active && "text-blue-700"
        )}
      >
        {t(column.label)}
        <Icon size={12} />
      </button>
    </th>
  );
}

function ThirdPartyUploadsButton({ video, onOpen, disabled }) {
  const { t } = useI18n();
  if (!video.video_id || !onOpen) return null;
  return (
    <Button size="sm" variant="secondary" icon={Upload} disabled={disabled} onClick={() => onOpen(video)}>
      {t("Third-party uploads")}
    </Button>
  );
}

function ClaimRow({ claim, grouped, selected, busy, rechecking, activating, onToggle, onOpenDetail, onOpenThirdPartyUploads, onRelease, onRecheck, onReinstate, onConfirm }) {
  const { t, tm } = useI18n();
  const releasable = isReleasable(claim);
  const reason = releaseBlockReason(claim);
  const result = claim.release_result;
  const status = normalizeStatus(claim.status);
  const permissionBlocked = !releasable && reason && RELEASABLE_STATUSES.includes(status);
  const needsRecheck = status === RELEASE_UNKNOWN_STATUS;
  // An inactive (released) claim offers Reinstate instead of a disabled Release button.
  const inactive = status === "inactive";
  const reinstatable = isReinstatable(claim);
  const reinstateReason = reinstateBlockReason(claim);
  // The lock hint explains a permission block on an inactive row too (the server's reason, not the status rule).
  const reinstateBlocked = inactive && !reinstatable && Boolean(claim.reinstate_block_reason);
  // A potential claim (a match awaiting confirmation) offers Confirm next to Release.
  const potential = status === "potential";
  const confirmable = isConfirmable(claim);
  const confirmReason = confirmBlockReason(claim);
  // Same lock for a potential row the server does not let this user confirm; a single icon when the
  // release hint already shows that text (both blocks come from the asset labels).
  const confirmBlocked = potential && !confirmable && Boolean(claim.confirm_block_reason) && !(permissionBlocked && confirmReason === reason);
  // The checkbox follows the two bulk buttons: a row goes in when Release or Activate can take it. The
  // tooltip of a row neither can take names the block that matters (reinstate for an inactive row).
  const selectable = isSelectable(claim);
  const selectTitle = selectable ? undefined : (inactive ? reinstateReason : reason) || undefined;
  const succeeded = SUCCESS_OUTCOMES.includes(result?.outcome);
  return (
    <tr data-claim-key={claimKey(claim)} className={cx("align-top transition hover:bg-slate-50", selected && "bg-blue-50/50")}>
      <td className="px-3 py-3">
        <span title={tm(selectTitle)} className="inline-flex">
          <input
            type="checkbox"
            className="h-4 w-4 cursor-pointer accent-blue-600 disabled:cursor-not-allowed"
            checked={selected}
            disabled={!selectable || busy}
            aria-label={selected ? t("Deselect claim {id}", { id: claim.claim_id }) : t("Select claim {id}", { id: claim.claim_id })}
            onChange={() => onToggle(claim)}
          />
        </span>
      </td>
      {!grouped && (
        <td className="px-3 py-3">
          <VideoSummary claim={claim} />
          <div className="mt-2">
            <ThirdPartyUploadsButton video={claim} onOpen={onOpenThirdPartyUploads} disabled={busy} />
          </div>
        </td>
      )}
      <td className="px-3 py-3">
        <MonoId value={claim.claim_id} onClick={onOpenDetail && (() => onOpenDetail(claim))} title={onOpenDetail && t("Open claim details")} />
        {(claim.third_party || claim.is_partner_uploaded) && (
          <span className="mt-1 flex flex-wrap gap-1">
            {claim.third_party && <ToneBadge tone="amber">{t("3rd party")}</ToneBadge>}
            {claim.is_partner_uploaded && <ToneBadge tone="slate">{t("Partner upload")}</ToneBadge>}
          </span>
        )}
      </td>
      <td className="px-3 py-3">
        <span className="block max-w-[160px] truncate text-sm font-bold text-slate-800" title={claim.network_name || ""}>
          {claim.network_name || `CMS ${claim.network_id}`}
        </span>
        {claim.content_owner_id && <span className="block font-mono text-[11px] text-slate-400">{claim.content_owner_id}</span>}
      </td>
      <td className="px-3 py-3">
        <AssetSummary claim={claim} />
      </td>
      <td className="px-3 py-3">
        <span className="inline-flex items-center gap-1.5">
          <ClaimStatusBadge status={claim.status} />
          {permissionBlocked && <BlockedHint reason={tm(reason)} />}
          {reinstateBlocked && <BlockedHint reason={tm(reinstateReason)} />}
          {confirmBlocked && <BlockedHint reason={tm(confirmReason)} />}
        </span>
        {succeeded && (
          <span className="mt-1 block max-w-[220px] text-[11px] font-bold leading-snug text-emerald-700" title={tm(result.message) || undefined}>
            {t("{outcome} in this session", { outcome: t(outcomeLabel(result.outcome)) })}
          </span>
        )}
        {result?.outcome === "failed" && result.message && (
          <span className="mt-1 block max-w-[220px] text-[11px] font-bold leading-snug text-red-600" title={tm(result.message)}>
            {t(FAILED_PREFIXES[result.action] || "")}
            {truncate(tm(result.message), 90)}
          </span>
        )}
        {result?.outcome === "unknown" && <span className="mt-1 block max-w-[220px] text-[11px] font-bold leading-snug text-amber-700">{t("Re-check before retrying")}</span>}
      </td>
      <td className="whitespace-nowrap px-3 py-3 text-xs font-bold text-slate-600">{t(contentTypeLabel(claim.content_type)) || "-"}</td>
      <td className="whitespace-nowrap px-3 py-3 text-xs font-bold text-slate-600">{t(originLabel(claim.origin)) || "-"}</td>
      <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-500">{formatDateTime(claim.time_created) || "-"}</td>
      <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-500">{formatDateTime(claim.time_status_last_modified) || "-"}</td>
      <td className="px-3 py-3">
        <div className="flex justify-end gap-1.5">
          {onOpenDetail && <Button size="sm" variant="secondary" icon={Eye} onClick={() => onOpenDetail(claim)}>
            {t("Details")}
          </Button>}
          {needsRecheck ? (
            <Button size="sm" variant="secondary" icon={RefreshCw} loading={rechecking} disabled={busy} title={t("Ask Google for the current status")} onClick={() => onRecheck?.(claim)}>
              {t("Re-check")}
            </Button>
          ) : inactive ? (
            <span title={reinstatable ? t("Set this released claim back to active") : tm(reinstateReason) || undefined} className="inline-flex">
              <Button size="sm" variant="secondary" icon={Undo2} loading={activating} disabled={!reinstatable || busy} onClick={() => onReinstate?.(claim)}>
                {t("Reinstate")}
              </Button>
            </span>
          ) : (
            <>
              {potential && (
                <span title={confirmable ? t("Confirm this potential claim: set it active") : tm(confirmReason) || undefined} className="inline-flex">
                  <Button size="sm" variant="indigo" icon={BadgeCheck} loading={activating} disabled={!confirmable || busy} onClick={() => onConfirm?.(claim)}>
                    {t("Confirm")}
                  </Button>
                </span>
              )}
              <span title={tm(reason) || undefined} className="inline-flex">
                <ReleaseButton size="sm" icon={Unlock} disabled={!releasable || busy} onClick={() => onRelease(claim)}>
                  {t("Release")}
                </ReleaseButton>
              </span>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

function GroupHeaderRow({ group, columnCount, selection, busy, onToggleKeys, onOpenThirdPartyUploads }) {
  const { t, tm } = useI18n();
  // The rows the two bulk buttons can take (Release: active / pending / potential; Activate: potential / inactive).
  const selectableKeys = group.claims.filter(isSelectable).map((claim) => claimKey(claim));
  const allSelected = selectableKeys.length > 0 && selectableKeys.every((key) => selection.selected.has(key));
  return (
    <tr className="bg-slate-50/80">
      <td className="px-3 py-3">
        <input
          type="checkbox"
          className="h-4 w-4 cursor-pointer accent-blue-600 disabled:cursor-not-allowed"
          checked={allSelected}
          disabled={!selectableKeys.length || busy}
          aria-label={t("Select all releasable or activatable claims of video {id}", { id: group.video_id })}
          title={selectableKeys.length ? t("Select all releasable or activatable claims of this video") : t("No releasable or activatable claim on this video")}
          onChange={(event) => onToggleKeys(selectableKeys, event.target.checked)}
        />
      </td>
      <td colSpan={columnCount - 1} className="px-3 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <VideoSummary group={group} size="md" />
          <div className="flex flex-wrap items-center gap-2">
            <ThirdPartyUploadsButton video={group} onOpen={onOpenThirdPartyUploads} disabled={busy} />
            {group.claim_count ? (
              <ToneBadge tone="emerald" icon={ShieldCheck}>
                {group.claim_count === 1 ? t("{count} claim", { count: group.claim_count }) : t("{count} claims", { count: group.claim_count })}
              </ToneBadge>
            ) : (
              <ToneBadge tone="slate" icon={ShieldAlert}>
                {t("No owned claim")}
              </ToneBadge>
            )}
            {group.claim_count > 0 && <ToneBadge tone="blue">{t("{count} releasable", { count: group.releasable_count })}</ToneBadge>}
            {group.activatable_count > 0 && <ToneBadge tone="indigo">{t("{count} activatable", { count: group.activatable_count })}</ToneBadge>}
          </div>
        </div>
        {group.errors.length > 0 && (
          <ul className="mt-2 space-y-0.5 rounded-xl bg-red-50 px-3 py-2 text-xs font-bold text-red-600">
            {group.errors.map((item, index) => (
              <li key={`${item.network_id}-${index}`}>
                {item.network_name || `CMS ${item.network_id}`}: {tm(item.message)}
              </li>
            ))}
          </ul>
        )}
      </td>
    </tr>
  );
}

function Pager({ pagination, onPageChange }) {
  const { t } = useI18n();
  if (!pagination) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-4 py-3">
      <span className="text-xs font-bold text-slate-500">{pagination.summary}</span>
      {pagination.pageCount > 1 && (
        <div className="flex items-center gap-2">
          <IconButton icon={ChevronLeft} label={t("Previous page")} size="sm" disabled={pagination.page <= 1} onClick={() => onPageChange(pagination.page - 1)} />
          <span className="text-xs font-black text-slate-600">
            {t("Page {page} / {pageCount}", { page: pagination.page, pageCount: pagination.pageCount })}
          </span>
          <IconButton icon={ChevronRight} label={t("Next page")} size="sm" disabled={pagination.page >= pagination.pageCount} onClick={() => onPageChange(pagination.page + 1)} />
        </div>
      )}
    </div>
  );
}

/**
 * Claims table. Flat view: one row per claim. Grouped view: a header row per video
 * (preview, counts, per-video errors, "select all releasable or activatable") followed by its claims.
 * Sticky header, horizontal scroll, sortable Video / Claim / Status / Created / Modified.
 * Row checkbox: any row Release or Activate can take (isSelectable). Row actions: Details, then
 * Release (releasable statuses), Confirm + Release (potential), Reinstate (inactive) or Re-check
 * ("Check status" rows); `recheckingKeys` / `activatingKeys` show the running row as loading.
 */
export default function ClaimsTable({
  rows = [],
  groups = null,
  grouped = false,
  selection,
  onToggleRow,
  onToggleKeys,
  sort,
  onSort,
  busy = false,
  dimmed = false,
  onOpenDetail,
  onOpenThirdPartyUploads,
  onRelease,
  onRecheck,
  onReinstate,
  onConfirm,
  recheckingKeys,
  activatingKeys,
  pagination,
  onPageChange
}) {
  const columns = COLUMNS.filter((column) => !(grouped && column.flatOnly));
  const isRechecking = (claim) => Boolean(recheckingKeys?.has(claimKey(claim)));
  // One set for both single-row writes (Reinstate on an inactive row, Confirm on a potential row).
  const isActivating = (claim) => Boolean(activatingKeys?.has(claimKey(claim)));
  return (
    <div>
      <div className="max-h-[72vh] overflow-auto">
        <table className={cx("w-full text-left text-sm", grouped ? "min-w-[1180px]" : "min-w-[1400px]")}>
          <thead className="sticky top-0 z-10 bg-slate-50 text-xs font-black uppercase tracking-wide text-slate-500 shadow-[0_1px_0_0_#e2e8f0]">
            <tr>
              {columns.map((column) => (
                <HeaderCell key={column.key} column={column} sort={sort} onSort={onSort} />
              ))}
            </tr>
          </thead>
          <tbody className={cx("divide-y divide-slate-100", dimmed && "opacity-60")} aria-busy={dimmed || undefined}>
            {grouped
              ? (groups || []).map((group) => (
                  <Fragment key={group.video_id || "unknown-video"}>
                    <GroupHeaderRow group={group} columnCount={columns.length} selection={selection} busy={busy} onToggleKeys={onToggleKeys} onOpenThirdPartyUploads={onOpenThirdPartyUploads} />
                    {group.claims.map((claim) => (
                      <ClaimRow
                        key={claimKey(claim)}
                        claim={claim}
                        grouped
                        selected={selection.selected.has(claimKey(claim))}
                        busy={busy}
                        rechecking={isRechecking(claim)}
                        activating={isActivating(claim)}
                        onToggle={onToggleRow}
                        onOpenDetail={onOpenDetail}
                        onRelease={onRelease}
                        onRecheck={onRecheck}
                        onReinstate={onReinstate}
                        onConfirm={onConfirm}
                      />
                    ))}
                  </Fragment>
                ))
              : rows.map((claim) => (
                  <ClaimRow
                    key={claimKey(claim)}
                    claim={claim}
                    grouped={false}
                    selected={selection.selected.has(claimKey(claim))}
                    busy={busy}
                    rechecking={isRechecking(claim)}
                    activating={isActivating(claim)}
                    onToggle={onToggleRow}
                    onOpenDetail={onOpenDetail}
                    onOpenThirdPartyUploads={onOpenThirdPartyUploads}
                    onRelease={onRelease}
                    onRecheck={onRecheck}
                    onReinstate={onReinstate}
                    onConfirm={onConfirm}
                  />
                ))}
          </tbody>
        </table>
      </div>
      <Pager pagination={pagination} onPageChange={onPageChange} />
    </div>
  );
}
