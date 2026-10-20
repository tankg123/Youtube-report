import { useId, useMemo, useState } from "react";
import { RefreshCw, RotateCcw, Unlock, X, Zap } from "lucide-react";
import { useI18n } from "../../context/I18nContext";
import { tk } from "../../i18n/index.js";
import { Button, Field, InlineMessage, Modal, ProgressBar, TextArea } from "../assetDelivery/shared";
import { cx, truncate } from "../assetDelivery/utils";
import {
  ACTIVATE_CONFIRMATION_TEXT,
  DEFAULT_LIMITS,
  MAX_NOTE_LENGTH,
  RELEASE_CONFIRMATION_TEXT,
  RELEASE_OUTCOMES,
  RELEASE_OUTCOME_META,
  RELEASE_PREVIEW_ROWS,
  TONE_CLASSES
} from "./constants";
import { useWriteRun } from "./hooks";
import { ClaimStatusBadge, MonoId, OutcomeBadge, ReleaseButton } from "./shared";
import { activateActionOf, claimKey, countByStatus, orderedStatuses, releaseSummaryText, statusLabel, summarizeRelease, videoTitle } from "./utils";

/**
 * Copy per write action. "release" sets the claims inactive; "activate" is the frontend umbrella for
 * confirm (potential → active) and reinstate (inactive → active), which useWriteRun sends as separate
 * batches to their own endpoints. `runKinds` prefixes the progress bar per run kind (see `execute`).
 * Canonical English (tk) rendered with t(); `button` / `unsent` hold the singular and plural sentences.
 */
const COPY = {
  release: {
    titles: { confirm: tk("Release claims"), running: tk("Releasing claims…"), done: tk("Release finished") },
    runKinds: { run: tk("Releasing"), retry: tk("Retrying"), unsent: tk("Sending the unsent claims") },
    button: { one: tk("Release {count} claim"), many: tk("Release {count} claims") },
    tooMany: tk("At most {max} claims can be released in one run. Reduce the selection."),
    unsent: {
      one: tk("{count} claim was not sent and stays selected in the table. Fix the problem, then send it from here or release it again from the table."),
      many: tk("{count} claims were not sent and stay selected in the table. Fix the problem, then send them from here or release them again from the table.")
    },
    tone: "red",
    confirmation: RELEASE_CONFIRMATION_TEXT,
    box: "border-red-200 bg-red-50",
    accent: "accent-red-600",
    text: "text-red-700",
    placeholder: tk("Reason for the release, ticket number, requester…")
  },
  activate: {
    titles: { confirm: tk("Activate claims"), running: tk("Activating claims…"), done: tk("Activation finished") },
    runKinds: { run: tk("Activating"), retry: tk("Retrying"), unsent: tk("Sending the unsent claims") },
    button: { one: tk("Activate {count} claim"), many: tk("Activate {count} claims") },
    tooMany: tk("At most {max} claims can be activated in one run. Reduce the selection."),
    unsent: {
      one: tk("{count} claim was not sent and stays selected in the table. Fix the problem, then send it from here or activate it again from the table."),
      many: tk("{count} claims were not sent and stay selected in the table. Fix the problem, then send them from here or activate them again from the table.")
    },
    tone: "indigo",
    confirmation: ACTIVATE_CONFIRMATION_TEXT,
    box: "border-indigo-200 bg-indigo-50",
    accent: "accent-indigo-600",
    text: "text-indigo-700",
    placeholder: tk("Reason for the activation, ticket number, requester…")
  }
};

/** The action's primary button: solid red for a release, solid indigo for an activation. */
function WriteButton({ action, ...props }) {
  if (action === "activate") return <Button variant="indigo" icon={Zap} {...props} />;
  return <ReleaseButton icon={Unlock} {...props} />;
}

function PreviewRow({ claim }) {
  const { tm } = useI18n();
  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2">
      <MonoId value={claim.claim_id} copy={false} />
      <span className="min-w-0 flex-1 truncate text-xs font-bold text-slate-600" title={tm(videoTitle(claim))}>
        {tm(videoTitle(claim))}
      </span>
      <span className="text-[11px] text-slate-400">{claim.network_name}</span>
      <ClaimStatusBadge status={claim.status} />
    </li>
  );
}

function ResultRow({ result, claim, busy, onRetry, onRecheck }) {
  const { t, tm } = useI18n();
  const title = claim ? tm(videoTitle(claim)) : "";
  let action = null;
  if (result.outcome === "failed" && result.retryable) {
    action = (
      <Button size="sm" variant="secondary" icon={RotateCcw} loading={busy} onClick={() => onRetry([result.key])}>
        {t("Retry")}
      </Button>
    );
  } else if (result.outcome === "unknown") {
    action = (
      <Button size="sm" variant="secondary" icon={RefreshCw} loading={busy} onClick={() => onRecheck([result.key])}>
        {t("Re-check")}
      </Button>
    );
  }
  return (
    <li className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 md:flex-row md:items-center md:justify-between">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <MonoId value={result.claim_id} />
          {title && (
            <span className="max-w-[320px] truncate text-xs font-bold text-slate-600" title={title}>
              {title}
            </span>
          )}
          {claim?.network_name && <span className="text-[11px] text-slate-400">{claim.network_name}</span>}
          {result.status && <ClaimStatusBadge status={result.status} />}
        </div>
        {result.message && (
          <p className="mt-1 text-xs text-slate-500">
            {truncate(tm(result.message), 240)}
            {result.retry_after ? ` ${t("Retry after {seconds} s.", { seconds: result.retry_after })}` : ""}
          </p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </li>
  );
}

function OutcomeGroup({ outcome, results, claimsByKey, busyKeys, running, onRetry, onRecheck }) {
  const { t } = useI18n();
  if (!results.length) return null;
  const meta = RELEASE_OUTCOME_META[outcome];
  const retryableKeys = outcome === "failed" ? results.filter((result) => result.retryable).map((result) => result.key) : [];
  const unknownKeys = outcome === "unknown" ? results.map((result) => result.key) : [];
  const groupBusy = results.some((result) => busyKeys.has(result.key));
  return (
    <section className={cx("rounded-2xl border p-3", outcome === "failed" ? "border-red-200 bg-red-50/60" : outcome === "unknown" ? "border-amber-200 bg-amber-50/60" : "border-slate-200 bg-slate-50")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <OutcomeBadge outcome={outcome} />
          <span className="text-sm font-black text-slate-800">{results.length}</span>
          <span className="text-xs text-slate-500">{t(meta.description)}</span>
        </div>
        {retryableKeys.length > 1 && (
          <Button size="sm" variant="secondary" icon={RotateCcw} loading={groupBusy} disabled={running} onClick={() => onRetry(retryableKeys)}>
            {t("Retry {count} retryable", { count: retryableKeys.length })}
          </Button>
        )}
        {unknownKeys.length > 1 && (
          <Button size="sm" variant="secondary" icon={RefreshCw} loading={groupBusy} disabled={running} onClick={() => onRecheck(unknownKeys)}>
            {t("Re-check all ({count})", { count: unknownKeys.length })}
          </Button>
        )}
      </div>
      <ul className="mt-2 space-y-1.5">
        {results.map((result) => (
          <ResultRow key={result.key} result={result} claim={claimsByKey.get(result.key)} busy={busyKeys.has(result.key) || running} onRetry={onRetry} onRecheck={onRecheck} />
        ))}
      </ul>
    </section>
  );
}

/**
 * Confirmation + runner of a bulk status write: `action` "release" (→ inactive) or "activate"
 * (potential → active by confirm, inactive → active by reinstate). Mount it with a fresh `key` per
 * session: the dialog keeps its own note / confirmation / run state and reports every batch outcome
 * through `onResults` (table update) and re-checks through `onRecheckResults`.
 */
export default function ReleaseDialog({ action = "release", claims, limits, onClose, onResults, onRecheckResults, showToast }) {
  const { t, tm } = useI18n();
  const copy = COPY[action] || COPY.release;
  const activate = action === "activate";
  const noteId = useId();
  const [note, setNote] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const { run, busyKeys, running, batchSize, start, retry, retryUnsent, recheck, cancel } = useWriteRun({ action, claims, limits, note: note.trim(), onResults, onRecheckResults });

  const claimsByKey = useMemo(() => new Map(claims.map((claim) => [claimKey(claim), claim])), [claims]);
  const networkCount = useMemo(() => new Set(claims.map((claim) => claim.network_id)).size, [claims]);
  const statusCounts = useMemo(() => countByStatus(claims), [claims]);
  // Activation plan: how many claims go to each endpoint (confirm for potential rows, reinstate for inactive rows).
  const activatePlan = useMemo(() => {
    if (!activate) return "";
    let toConfirm = 0;
    let toReinstate = 0;
    claims.forEach((claim) => {
      const write = activateActionOf(claim);
      if (write === "confirm") toConfirm += 1;
      else if (write === "reinstate") toReinstate += 1;
    });
    if (toConfirm && toReinstate) return t("{confirm} to confirm · {reinstate} to reinstate", { confirm: toConfirm, reinstate: toReinstate });
    if (toConfirm) return t("{confirm} to confirm", { confirm: toConfirm });
    if (toReinstate) return t("{reinstate} to reinstate", { reinstate: toReinstate });
    return "";
  }, [activate, claims, t]);
  const results = useMemo(() => (Array.isArray(run?.results) ? run.results : []), [run]);
  const grouped = useMemo(() => {
    const map = Object.fromEntries(RELEASE_OUTCOMES.map((outcome) => [outcome, []]));
    results.forEach((result) => (map[result.outcome] || map.unknown).push(result));
    return map;
  }, [results]);
  const summary = summarizeRelease(results);
  const maxItems = Number(limits?.max_release_items) || DEFAULT_LIMITS.max_release_items;
  const tooMany = claims.length > maxItems;
  const phase = !run ? "confirm" : run.phase;
  const preview = claims.slice(0, RELEASE_PREVIEW_ROWS);
  const unsentCount = run?.unsent?.length || 0;
  // Progress of the run in flight (initial, retry or unsent): its own claims, not the whole dialog's.
  const progress = run?.total ? (run.sent / run.total) * 100 : 0;

  function announce(outcome) {
    if (!outcome) return;
    const runSummary = summarizeRelease(outcome.outcomes);
    const tone = runSummary.failed || runSummary.unknown || outcome.unsent.length ? "warning" : "success";
    const title = t(copy.titles.done);
    const summary = releaseSummaryText(runSummary);
    showToast(
      outcome.unsent.length ? t("{title}: {summary} · {count} not sent", { title, summary, count: outcome.unsent.length }) : t("{title}: {summary}", { title, summary }),
      tone,
      6000
    );
  }

  async function handleStart() {
    if (!confirmed || tooMany) return;
    announce(await start());
  }

  async function handleRetryUnsent() {
    announce(await retryUnsent());
  }

  let footer;
  if (phase === "confirm") {
    footer = (
      <>
        <Button variant="secondary" onClick={onClose}>
          {t("Cancel")}
        </Button>
        <WriteButton action={action} disabled={!confirmed || tooMany} onClick={handleStart}>
          {t(claims.length === 1 ? copy.button.one : copy.button.many, { count: claims.length })}
        </WriteButton>
      </>
    );
  } else if (phase === "running") {
    footer = (
      <Button variant="secondary" icon={X} onClick={cancel}>
        {t("Cancel run")}
      </Button>
    );
  } else {
    footer = (
      <>
        {grouped.unknown.length > 0 && (
          <Button variant="secondary" icon={RefreshCw} loading={grouped.unknown.some((result) => busyKeys.has(result.key))} onClick={() => recheck(grouped.unknown.map((result) => result.key))}>
            {grouped.unknown.length === 1 ? t("Re-check {count} claim", { count: grouped.unknown.length }) : t("Re-check {count} claims", { count: grouped.unknown.length })}
          </Button>
        )}
        <Button onClick={onClose}>{t("Done")}</Button>
      </>
    );
  }

  return (
    <Modal
      open
      size="lg"
      title={t(copy.titles[phase] || copy.titles.confirm)}
      subtitle={
        claims.length === 1
          ? t("{count} claim across {networks} CMS", { count: claims.length, networks: networkCount })
          : t("{count} claims across {networks} CMS", { count: claims.length, networks: networkCount })
      }
      onClose={running ? undefined : onClose}
      closeHint={t("Use Cancel run to stop the run")}
      closeOnBackdrop={!running}
      footer={footer}
    >
      {phase === "confirm" && (
        <div className="space-y-4">
          {activate ? (
            <InlineMessage tone="info" title={t("Activating takes effect immediately")}>
              {t(
                "Potential claims are confirmed and released (inactive) claims are reinstated: each claim is set to active in YouTube CMS right away, the video is claimed again and the asset's policy applies to it. A claim can be released again afterwards."
              )}{" "}
              {note.trim() ? t("Every confirm and reinstate is logged with your name and note.") : t("Every confirm and reinstate is logged with your name.")}
            </InlineMessage>
          ) : (
            <InlineMessage tone="warning" title={t("Releasing takes effect immediately")}>
              {t(
                "Each selected claim is set to inactive in YouTube CMS right away and stops applying its policy; other claims on the same video are not affected. An inactive claim can be reinstated from this tool afterwards (Reinstate on the row or in Release history), but the time in between is not recovered."
              )}{" "}
              {note.trim() ? t("Every release is logged with your name and note.") : t("Every release is logged with your name.")}
            </InlineMessage>
          )}
          {tooMany && <InlineMessage tone="error">{t(copy.tooMany, { max: maxItems })}</InlineMessage>}

          <div className="flex flex-wrap items-center gap-2">
            {orderedStatuses(statusCounts).map((status) => (
              <span key={status} className={cx("rounded-full px-2.5 py-1 text-[11px] font-black uppercase tracking-wide", TONE_CLASSES.slate)}>
                {t("{count} {status}", { count: statusCounts[status], status: t(statusLabel(status)).toLowerCase() })}
              </span>
            ))}
            {activatePlan && <span className={cx("rounded-full px-2.5 py-1 text-[11px] font-black uppercase tracking-wide", TONE_CLASSES.indigo)}>{activatePlan}</span>}
            <span className="text-xs text-slate-400">
              {activate
                ? t("Sent in batches of {size}, one after another; potential and released claims go in separate batches.", { size: batchSize })
                : t("Sent in batches of {size}, one after another.", { size: batchSize })}
            </span>
          </div>

          <ul className="divide-y divide-slate-100 rounded-2xl border border-slate-200">
            {preview.map((claim) => (
              <PreviewRow key={claimKey(claim)} claim={claim} />
            ))}
            {claims.length > preview.length && <li className="px-3 py-2 text-xs font-bold text-slate-500">{t("+{count} more", { count: claims.length - preview.length })}</li>}
          </ul>

          <Field label={t("Note (optional, saved in the release log)")} htmlFor={noteId} hint={`${note.length}/${MAX_NOTE_LENGTH}`}>
            <TextArea id={noteId} rows={2} maxLength={MAX_NOTE_LENGTH} value={note} placeholder={t(copy.placeholder)} onChange={(event) => setNote(event.target.value.slice(0, MAX_NOTE_LENGTH))} />
          </Field>

          <label className={cx("flex cursor-pointer items-start gap-3 rounded-2xl border p-3", copy.box)}>
            <input type="checkbox" className={cx("mt-0.5 h-4 w-4", copy.accent)} checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            <span className={cx("text-sm font-bold", copy.text)}>{t(copy.confirmation)}</span>
          </label>
        </div>
      )}

      {phase !== "confirm" && (
        <div className="space-y-4">
          {phase === "running" && (
            <div className="space-y-2">
              <ProgressBar
                value={progress}
                tone={copy.tone}
                label={t("{kind} · batch {batch} of {batches} · {sent}/{total} claims answered", {
                  kind: t(copy.runKinds[run.kind] || copy.runKinds.run),
                  batch: run.batch,
                  batches: run.batches,
                  sent: run.sent,
                  total: run.total
                })}
              />
              <InlineMessage tone="info">
                {t(
                  "Batches of {size} are sent one after another. Keep this window open. Cancel run stops sending new claims; the calls already in flight finish on the server and show as \"Check status\" until re-checked.",
                  { size: batchSize }
                )}
              </InlineMessage>
            </div>
          )}

          {phase === "done" && (
            <div className="flex flex-wrap items-center gap-2">
              {RELEASE_OUTCOMES.filter((outcome) => summary[outcome] > 0).map((outcome) => (
                <span key={outcome} className="inline-flex items-center gap-1.5">
                  <OutcomeBadge outcome={outcome} />
                  <span className="text-sm font-black text-slate-800">{summary[outcome]}</span>
                </span>
              ))}
              <span className="text-xs text-slate-400">{t("{answered}/{total} answered", { answered: summary.total, total: claims.length })}</span>
            </div>
          )}

          {run.error && <InlineMessage tone="error" title={t("The run stopped")}>{tm(run.error)}</InlineMessage>}
          {run.recheckError && <InlineMessage tone="error" title={t("Re-check failed")}>{tm(run.recheckError)}</InlineMessage>}
          {unsentCount > 0 && (
            <InlineMessage
              tone="warning"
              actions={
                phase === "done" ? (
                  <WriteButton action={action} size="sm" onClick={handleRetryUnsent}>
                    {unsentCount === 1 ? t("Send the {count} unsent claim", { count: unsentCount }) : t("Send the {count} unsent claims", { count: unsentCount })}
                  </WriteButton>
                ) : null
              }
            >
              {t(unsentCount === 1 ? copy.unsent.one : copy.unsent.many, { count: unsentCount })}
            </InlineMessage>
          )}

          {RELEASE_OUTCOMES.map((outcome) => (
            <OutcomeGroup key={outcome} outcome={outcome} results={grouped[outcome]} claimsByKey={claimsByKey} busyKeys={busyKeys} running={running} onRetry={retry} onRecheck={recheck} />
          ))}
        </div>
      )}
    </Modal>
  );
}
