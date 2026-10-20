import { useEffect, useMemo, useState } from "react";
import { BadgeCheck, Braces, Clock, FileText, History, Layers, RefreshCw, ScrollText, ShieldCheck, Undo2, Unlock, Video, Waves } from "lucide-react";
import { getClaimDetail } from "../../api/contentIdClaimsApi";
import { useI18n } from "../../context/I18nContext";
import { Button, CopyButton, InlineMessage, JsonViewer, Modal, Spinner } from "../assetDelivery/shared";
import { cx, formatDateTime, formatNumber } from "../assetDelivery/utils";
import {
  GOOGLE_HISTORY_DETAIL_LABELS,
  GOOGLE_HISTORY_SOURCE_LABELS,
  GOOGLE_HISTORY_TYPE_META,
  HISTORY_ACTION_LABELS,
  SEARCH_ERROR_SCOPE_LABELS,
  TONE_CLASSES
} from "./constants";
import { ClaimStatusBadge, KeyValueList, LabelBadges, LinkButton, MonoId, OutcomeBadge, ReleaseButton, Section, ToneBadge, VideoSummary } from "./shared";
import {
  confirmBlockReason,
  contentTypeLabel,
  formatSeconds,
  isCanceled,
  isConfirmable,
  isReinstatable,
  isReleasable,
  mergeServerClaim,
  normalizeStatus,
  originLabel,
  reinstateBlockReason,
  releaseBlockReason,
  requestMessage,
  videoUrl
} from "./utils";

const DOT_CLASSES = {
  slate: "bg-slate-400",
  blue: "bg-blue-500",
  emerald: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
  indigo: "bg-indigo-500",
  violet: "bg-violet-500"
};

function yesNo(value, t) {
  if (value === true) return t("Yes");
  if (value === false) return t("No");
  return "";
}

function timeOf(value) {
  const time = new Date(value || "").getTime();
  return Number.isFinite(time) ? time : 0;
}

/**
 * Placeholder of a detail section: "Loading…" while the detail request runs, "Not loaded" when it
 * failed (the search row has no policy / match / history data), the `children` sentence only when
 * the loaded detail is genuinely empty.
 */
function SectionNote({ loading, error, children }) {
  const { t, tm } = useI18n();
  if (loading) return <p className="text-sm text-slate-400">{t("Loading…")}</p>;
  if (error) return <p className="text-sm text-slate-400">{t("Not loaded: {error}", { error: tm(error) })}</p>;
  return <p className="text-sm text-slate-400">{children}</p>;
}

function PolicyBlock({ label, policy }) {
  const { t } = useI18n();
  if (!policy) return null;
  return (
    <div className="rounded-xl bg-slate-50 px-3 py-2">
      <p className="text-[11px] font-black uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-0.5 text-sm font-black text-slate-900">{policy.name || policy.id || t("Policy")}</p>
      {policy.summary && <p className="text-xs font-bold text-slate-500">{policy.summary}</p>}
      {policy.id && <p className="font-mono text-[11px] text-slate-400">{policy.id}</p>}
    </div>
  );
}

function MatchInfo({ matchInfo, loading, error }) {
  const { t } = useI18n();
  if (!matchInfo) {
    return (
      <SectionNote loading={loading} error={error}>
        {t("No match information (claim-search results do not carry it; it is loaded with the claim detail).")}
      </SectionNote>
    );
  }
  const longest = matchInfo.longest_match || null;
  const total = matchInfo.total_match || null;
  const segments = Array.isArray(matchInfo.segments) ? matchInfo.segments : [];
  return (
    <div className="space-y-3">
      <KeyValueList
        columns={2}
        items={[
          { label: t("Reference"), value: matchInfo.reference_id, mono: true },
          {
            label: t("Longest match"),
            value: longest
              ? t("{duration} (video {videoOffset} · reference {referenceOffset})", {
                  duration: formatSeconds(longest.duration_secs),
                  videoOffset: formatSeconds(longest.user_video_offset),
                  referenceOffset: formatSeconds(longest.reference_offset)
                })
              : ""
          },
          {
            label: t("Total matched"),
            value: total
              ? t("video {videoDuration} · reference {referenceDuration}", {
                  videoDuration: formatSeconds(total.user_video_duration_secs),
                  referenceDuration: formatSeconds(total.reference_duration_secs)
                })
              : ""
          }
        ]}
      />
      {segments.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 font-black uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">{t("Channel")}</th>
                <th className="px-3 py-2">{t("Video offset")}</th>
                <th className="px-3 py-2">{t("Video duration")}</th>
                <th className="px-3 py-2">{t("Reference offset")}</th>
                <th className="px-3 py-2">{t("Reference duration")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-mono text-slate-700">
              {segments.map((segment, index) => (
                <tr key={index}>
                  <td className="px-3 py-2 font-sans font-bold">{segment.channel || "-"}</td>
                  <td className="px-3 py-2">{formatSeconds(segment.video_start) || "-"}</td>
                  <td className="px-3 py-2">{formatSeconds(segment.video_duration) || "-"}</td>
                  <td className="px-3 py-2">{formatSeconds(segment.reference_start) || "-"}</td>
                  <td className="px-3 py-2">{formatSeconds(segment.reference_duration) || "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** `error` is Google's claimHistory read error (detail loaded), `fetchError` the failure of the detail request itself. */
function GoogleHistory({ history, error, loading, fetchError }) {
  const { t, tm } = useI18n();
  const events = useMemo(() => [...(Array.isArray(history) ? history : [])].sort((left, right) => timeOf(right.time) - timeOf(left.time)), [history]);
  if (loading) {
    return (
      <p className="inline-flex items-center gap-2 text-sm font-bold text-slate-500">
        <Spinner size={15} /> {t("Loading the claim history from Google…")}
      </p>
    );
  }
  if (fetchError && !events.length) return <SectionNote error={fetchError} />;
  return (
    <div className="space-y-3">
      {error && <InlineMessage tone="warning">{t("Google claim history could not be read: {error}", { error: tm(error) })}</InlineMessage>}
      {!events.length && !error && <p className="text-sm text-slate-400">{t("Google returned no history event for this claim.")}</p>}
      {events.length > 0 && (
        <ol className="relative space-y-3 border-l border-slate-200 pl-4">
          {events.map((event, index) => {
            const meta = GOOGLE_HISTORY_TYPE_META[event.type] || { label: String(event.type || "event").replace(/_/g, " "), tone: "slate" };
            const source = event.source || {};
            const sourceLabel = [t(GOOGLE_HISTORY_SOURCE_LABELS[source.type] || source.type), source.user_email, source.content_owner_id ? t("owner {id}", { id: source.content_owner_id }) : ""].filter(Boolean).join(" · ");
            const details = Object.entries(event.details || {}).filter(([, value]) => value !== undefined && value !== null && value !== "");
            return (
              <li key={`${event.type}-${event.time}-${index}`} className="relative">
                <span className={cx("absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-white", DOT_CLASSES[meta.tone] || DOT_CLASSES.slate)} />
                <div className="flex flex-wrap items-center gap-2">
                  <ToneBadge tone={meta.tone}>{t(meta.label)}</ToneBadge>
                  <time className="inline-flex items-center gap-1 text-xs text-slate-500" title={event.time}>
                    <Clock size={11} /> {formatDateTime(event.time) || event.time || t("unknown time")}
                  </time>
                  {event.reason && <span className="text-xs font-bold text-slate-500">{t("reason: {reason}", { reason: String(event.reason).replace(/_/g, " ") })}</span>}
                </div>
                {sourceLabel && <p className="mt-1 text-xs font-bold text-slate-600">{sourceLabel}</p>}
                {details.length > 0 && (
                  <dl className="mt-1 space-y-0.5 text-xs text-slate-600">
                    {details.map(([key, value]) => (
                      <div key={key} className="flex gap-2">
                        <dt className="shrink-0 font-black text-slate-400">{t(GOOGLE_HISTORY_DETAIL_LABELS[key] || key.replace(/_/g, " "))}:</dt>
                        <dd className="break-words">{typeof value === "object" ? JSON.stringify(value) : String(value)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function LocalLog({ events, loading, error }) {
  const { t, tm } = useI18n();
  const list = Array.isArray(events) ? events : [];
  if (loading || error || !list.length) {
    return (
      <SectionNote loading={loading} error={error}>
        {t("No release, reinstate or confirm recorded by this tool for this claim.")}
      </SectionNote>
    );
  }
  return (
    <ul className="space-y-2">
      {list.map((event) => (
        <li key={event.id} className="rounded-xl border border-slate-200 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <OutcomeBadge outcome={event.result} />
            <span className="text-xs font-black text-slate-600">{t(HISTORY_ACTION_LABELS[event.action] || event.action)}</span>
            <time className="text-xs text-slate-500" title={event.created_at}>
              {formatDateTime(event.created_at)}
            </time>
            {(event.created_by_name || event.created_by_email) && <span className="text-xs font-bold text-slate-500">{t("by {name}", { name: event.created_by_name || event.created_by_email })}</span>}
            {event.previous_status && (
              <span className="inline-flex items-center gap-1 text-[11px] text-slate-400">
                <ClaimStatusBadge status={event.previous_status} /> → {event.result_status ? <ClaimStatusBadge status={event.result_status} /> : "?"}
              </span>
            )}
          </div>
          {event.message && <p className="mt-1 text-xs text-slate-600">{tm(event.message)}</p>}
          {event.note && <p className="mt-1 text-xs italic text-slate-500">{t("Note: {note}", { note: event.note })}</p>}
          {event.operation_id && <p className="mt-1 font-mono text-[11px] text-slate-400">{t("operation {id}", { id: event.operation_id })}</p>}
        </li>
      ))}
    </ul>
  );
}

/**
 * Full claim view: data from the table row, refreshed with GET /claims/:network/:claim
 * (policy, match info, Google claim history, local release log). Esc / backdrop close it.
 * The page mounts it with a fresh `key` per open, so every open starts with a loading state
 * instead of the data of a previous open (e.g. the status before a release). The footer actions
 * are Release for releasable statuses, Confirm (`onConfirm`) + Release for a potential claim and
 * Reinstate (`onReinstate`) for an inactive claim.
 */
export default function ClaimDetailModal({ claim, onClose, onRelease, onReinstate, onConfirm }) {
  const { t, tm, tk } = useI18n();
  const [reloadTick, setReloadTick] = useState(0);
  const requestKey = claim ? `${claim.network_id}|${claim.claim_id}|${reloadTick}` : "";
  const [state, setState] = useState({ key: "", data: null, error: "" });

  useEffect(() => {
    if (!requestKey) return undefined;
    const [networkId, claimId] = requestKey.split("|");
    const controller = new AbortController();
    getClaimDetail(networkId, claimId, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        setState({ key: requestKey, data, error: "" });
      })
      .catch((error) => {
        if (controller.signal.aborted || isCanceled(error)) return;
        setState({ key: requestKey, data: null, error: requestMessage(error) });
      });
    return () => controller.abort();
  }, [requestKey]);

  const current = state.key === requestKey ? state : null;
  const loading = Boolean(requestKey) && !current;
  const data = current?.data || null;
  const error = current?.error || "";
  // The fresh claim is authoritative for status / can_release but never carries the video preview
  // or the view counts of the row, and some of its fields may be null: merge, do not overwrite.
  const full = useMemo(() => mergeServerClaim(claim, data?.claim), [claim, data]);
  // Metadata reads that failed server side (asset / video); the claim itself was still read.
  const detailErrors = useMemo(() => (Array.isArray(data?.errors) ? data.errors.filter((item) => item && item.message) : []), [data]);
  const json = useMemo(() => JSON.stringify({ claim: full, history: data?.history || [], local_events: data?.local_events || [] }, null, 2), [full, data]);

  if (!claim) return null;

  const releasable = isReleasable(full);
  const reason = releaseBlockReason(full);
  const inactive = normalizeStatus(full.status) === "inactive";
  const reinstatable = isReinstatable(full);
  const reinstateReason = reinstateBlockReason(full);
  // A potential claim (a match awaiting confirmation) can be confirmed (set active) as well as released.
  const potential = normalizeStatus(full.status) === "potential";
  const confirmable = isConfirmable(full);
  const confirmReason = confirmBlockReason(full);
  // Amber badges for the blocked footer actions; one badge when release and confirm are blocked for
  // the same reason (both come from the asset labels).
  const blocks = [];
  if (inactive) {
    if (!reinstatable && reinstateReason) blocks.push({ label: t("Not reinstatable"), reason: reinstateReason });
  } else {
    const confirmBlocked = potential && !confirmable && Boolean(confirmReason);
    const sameReason = confirmBlocked && !releasable && confirmReason === reason;
    if (!releasable && reason) blocks.push({ label: sameReason ? t("Not releasable or confirmable") : t("Not releasable"), reason });
    if (confirmBlocked && !sameReason) blocks.push({ label: t("Not confirmable"), reason: confirmReason });
  }
  const asset = full.asset || null;
  const url = full.video_url || videoUrl(full.video_id);
  // Empty-list text of the key/value sections: never "Nothing to show." while the detail is still coming or failed.
  const emptyNote = loading ? t("Loading…") : error ? t("Not loaded: {error}", { error: tm(error) }) : undefined;

  return (
    <Modal
      open
      size="xl"
      title={t("Claim {id}", { id: full.claim_id })}
      subtitle={`${full.network_name || t("CMS {id}", { id: full.network_id })}${full.content_owner_id ? ` · ${full.content_owner_id}` : ""}`}
      onClose={onClose}
      bodyClassName="bg-slate-50"
      footer={
        <>
          <LinkButton href={url}>{t("Open on YouTube")}</LinkButton>
          <CopyButton text={full.claim_id} label={t("Copy claim ID")} variant="secondary" size="md" />
          <CopyButton text={json} label={t("Copy JSON")} variant="secondary" size="md" />
          {inactive ? (
            <span title={reinstatable ? t("Set this released claim back to active") : tm(reinstateReason) || undefined} className="inline-flex">
              <Button variant="indigo" icon={Undo2} disabled={!reinstatable || loading} onClick={() => onReinstate?.(full)}>
                {t("Reinstate this claim")}
              </Button>
            </span>
          ) : (
            <>
              {potential && (
                <span title={confirmable ? t("Confirm this potential claim: set it active") : tm(confirmReason) || undefined} className="inline-flex">
                  <Button variant="indigo" icon={BadgeCheck} disabled={!confirmable || loading} onClick={() => onConfirm?.(full)}>
                    {t("Confirm this claim")}
                  </Button>
                </span>
              )}
              <span title={tm(reason) || undefined} className="inline-flex">
                <ReleaseButton icon={Unlock} disabled={!releasable || loading} onClick={() => onRelease(full)}>
                  {t("Release this claim")}
                </ReleaseButton>
              </span>
            </>
          )}
        </>
      }
    >
      {error && (
        <InlineMessage
          tone="error"
          className="mb-4"
          actions={
            <Button size="sm" variant="secondary" icon={RefreshCw} onClick={() => setReloadTick((tick) => tick + 1)}>
              {t("Retry")}
            </Button>
          }
        >
          {t("Claim detail could not be loaded: {error}. Showing the data from the search results.", { error: tm(error) })}
        </InlineMessage>
      )}
      {detailErrors.length > 0 && (
        <InlineMessage tone="warning" className="mb-4" title={t("Some details could not be loaded")}>
          <ul className="space-y-0.5">
            {detailErrors.map((item, index) => (
              <li key={`${item.scope}-${index}`}>
                {t(SEARCH_ERROR_SCOPE_LABELS[item.scope] || item.scope || tk("Metadata"))}: {tm(item.message)}
              </li>
            ))}
          </ul>
        </InlineMessage>
      )}
      {loading && (
        <p className="mb-4 inline-flex items-center gap-2 text-xs font-bold text-slate-500" role="status">
          <Spinner size={14} /> {t("Loading policy, match info and history…")}
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Section title={t("Claim")} icon={ShieldCheck}>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <ClaimStatusBadge status={full.status} />
            {full.third_party && <ToneBadge tone="amber">{t("3rd party")}</ToneBadge>}
            {full.is_partner_uploaded && <ToneBadge tone="slate">{t("Partner upload")}</ToneBadge>}
            {full.block_outside_ownership && <ToneBadge tone="red">{t("Blocks outside ownership")}</ToneBadge>}
            {blocks.map((block) => (
              <span key={block.label} className={cx("rounded-full px-2.5 py-1 text-[11px] font-bold", TONE_CLASSES.amber)} title={tm(block.reason)}>
                {block.label}: {tm(block.reason)}
              </span>
            ))}
          </div>
          <KeyValueList
            items={[
              { label: t("Claim ID"), value: <MonoId value={full.claim_id} /> },
              { label: t("Content type"), value: t(contentTypeLabel(full.content_type)) },
              { label: t("Origin"), value: t(originLabel(full.origin)) },
              { label: t("UGC type"), value: full.ugc_type },
              { label: t("Created"), value: formatDateTime(full.time_created) },
              { label: t("Status modified"), value: formatDateTime(full.time_status_last_modified) },
              { label: t("Video views"), value: full.video_views === null || full.video_views === undefined ? "" : formatNumber(full.video_views) },
              { label: t("Engaged views"), value: full.engaged_views === null || full.engaged_views === undefined ? "" : formatNumber(full.engaged_views) },
              { label: t("Partner uploaded"), value: yesNo(full.is_partner_uploaded, t) },
              { label: t("Studio"), value: full.studio_url ? <LinkButton href={full.studio_url} size="sm">{t("Open in Studio")}</LinkButton> : "" }
            ]}
          />
        </Section>

        <Section title={t("Policy")} icon={FileText}>
          {full.policy || full.applied_policy ? (
            <div className="space-y-2">
              <PolicyBlock label={t("Match policy")} policy={full.policy} />
              <PolicyBlock label={t("Applied policy")} policy={full.applied_policy} />
            </div>
          ) : (
            <SectionNote loading={loading} error={error}>
              {t("No policy information returned for this claim.")}
            </SectionNote>
          )}
        </Section>

        <Section title={t("Match info")} icon={Waves}>
          <MatchInfo matchInfo={full.match_info} loading={loading} error={error} />
        </Section>

        <Section title={t("Asset")} icon={Layers}>
          <KeyValueList
            items={[
              { label: t("Asset ID"), value: <MonoId value={full.asset_id || asset?.id} /> },
              { label: t("Title"), value: asset?.title },
              // Google's asset type enum ("sound_recording" → "sound recording"); tm() gives the known types a Vietnamese name.
              { label: t("Type"), value: asset?.type ? tm(String(asset.type).replace(/_/g, " ")) : "" },
              { label: t("Custom ID"), value: asset?.custom_id, mono: true },
              { label: t("ISRC"), value: asset?.isrc, mono: true },
              { label: t("UPC"), value: asset?.upc, mono: true },
              { label: t("Labels"), value: asset?.labels?.length ? <LabelBadges labels={asset.labels} max={10} /> : "" }
            ]}
          />
        </Section>

        <Section title={t("Video")} icon={Video} className="md:col-span-2">
          <VideoSummary claim={full} size="md" />
          <KeyValueList
            className="mt-3"
            empty={emptyNote}
            items={[
              { label: t("Published"), value: formatDateTime(full.video?.published_at) },
              { label: t("Duration"), value: full.video?.duration_text },
              { label: t("Channel ID"), value: full.video?.channel_id, mono: true }
            ]}
          />
        </Section>

        <Section title={t("Google claim history")} icon={History} className="md:col-span-2">
          <GoogleHistory history={data?.history} error={data?.history_error} loading={loading} fetchError={error} />
        </Section>

        <Section title={t("Release log (this tool)")} icon={ScrollText} className="md:col-span-2">
          <LocalLog events={data?.local_events} loading={loading} error={error} />
        </Section>

        <details className="md:col-span-2 rounded-2xl border border-slate-200 bg-white p-4">
          <summary className="inline-flex cursor-pointer items-center gap-2 text-sm font-black text-slate-700">
            <Braces size={15} className="text-slate-400" /> {t("Raw JSON")}
          </summary>
          <JsonViewer value={json} className="mt-3" maxHeight={360} />
        </details>
      </div>
    </Modal>
  );
}
