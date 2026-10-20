import { CheckCircle2, CloudUpload, ExternalLink, Info, Square } from "lucide-react";
import { useI18n } from "../../context/I18nContext";
import { tk } from "../../i18n/index.js";
import { Button, Card, InlineMessage, ProgressBar } from "./shared";
import { cx } from "./utils";

// Shared by the music product form and the video batch form: the panel that shows one delivery
// run (save → server job). The run state shape lives in runState.js.

export function IndeterminateBar() {
  return (
    <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
      <div className="h-full w-2/3 animate-pulse rounded-full bg-blue-600" />
    </div>
  );
}

export function SummaryTile({ label, value, tone }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <p className="text-xs font-black uppercase tracking-wide text-slate-400">{label}</p>
      <p className={cx("mt-1 text-2xl font-black", tone === "red" ? "text-red-600" : tone === "emerald" ? "text-emerald-700" : tone === "amber" ? "text-amber-700" : tone === "blue" ? "text-blue-700" : "text-slate-900")}>
        {value}
      </p>
    </div>
  );
}

export function DefinitionList({ items }) {
  return (
    <dl className="grid gap-2 text-sm">
      {items.map((item) => (
        <div key={item.label} className="flex items-start justify-between gap-4 rounded-xl bg-slate-50 px-3 py-2">
          <dt className="shrink-0 text-xs font-black uppercase tracking-wide text-slate-400">{item.label}</dt>
          <dd className={cx("min-w-0 text-right font-bold text-slate-800", item.mono && "font-mono text-xs")}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

const DEFAULT_WORDS = {
  item: tk("track"),
  items: tk("tracks"),
  media: tk("audio"),
  entity: tk("product"),
  stepsHint: tk("Sound Recording asset · ownership · match policy · labels · audio reference"),
  stepsHintNoReference: tk("Sound Recording asset · ownership · match policy · labels (references off)")
};

// First letter of a translated sentence in upper case ("audio uploaded" → "Audio uploaded").
function capitalize(text) {
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : text;
}

/**
 * Progress + final summary of a delivery run. `words` adapts the copy to the page
 * (music: track/audio/product; video: video/video file/batch).
 */
export function RunPanel({ run, counts, job, includeReference, onStop, onOpen, onDismiss, onDeliverNow, words = {} }) {
  const { t, tm } = useI18n();
  const w = { ...DEFAULT_WORDS, ...words };
  // The page's words in the current language: they fill the {entity} / {item} / {items} / {media} placeholders.
  const entity = t(w.entity);
  const item = t(w.item);
  const items = t(w.items);
  const media = t(w.media);
  const order = ["uploading", "creating", "delivering", "done"];
  const phaseIndex = order.indexOf(run.phase);
  const stateOf = (position) => (phaseIndex > position ? "done" : phaseIndex === position ? "active" : "todo");
  const uploadsFinished = run.uploads.done + run.uploads.failed + run.uploads.skipped;
  const uploadsHint = run.uploads.total
    ? t("{finished}/{total} file(s) uploaded before saving the {entity}", { finished: uploadsFinished, total: run.uploads.total, entity })
    : t("No reference {media} selected", { media });
  const jobHint = run.job_started && job.total
    ? job.busy
      ? t("{finished}/{total} {item}(s) finished · {busy} in progress", { finished: job.finished, total: job.total, item, busy: job.busy })
      : t("{finished}/{total} {item}(s) finished", { finished: job.finished, total: job.total, item })
    : includeReference
      ? t(w.stepsHint)
      : t(w.stepsHintNoReference);
  const steps = [
    { key: "upload", label: capitalize(t("{media} uploaded", { media })), hint: uploadsHint },
    { key: "create", label: t("Save {entity}", { entity }), hint: run.product_id ? t("Stored as {entity} #{id}", { entity, id: run.product_id }) : t("Storing the {entity} and its {items} in the database", { entity, items }) },
    { key: "deliver", label: t("Deliver on CMS"), hint: jobHint }
  ];
  const finishedWithErrors = run.failed || counts.errors > 0 || run.uploads.failed > 0;
  const title =
    run.phase === "done"
      ? run.interrupted
        ? t("Delivery was interrupted on the server")
        : run.timed_out || run.poll_error
        ? t("Delivery is still running on the server")
        : run.stopped && !run.job_started
          ? t("Delivery stopped")
          : finishedWithErrors
            ? t("Delivery finished with errors")
            : t("Delivery finished")
      : run.phase === "delivering"
        ? t("Delivering on the server…")
        : run.phase === "uploading"
          ? t("Uploading {media} to the server…", { media })
          : t("Saving the {entity}…", { entity });

  if (run.phase === "failed") {
    return (
      <InlineMessage
        tone="error"
        title={t("The {entity} could not be saved", { entity })}
        actions={
          <Button size="sm" variant="secondary" onClick={onDismiss}>
            {t("Dismiss")}
          </Button>
        }
      >
        {run.message ? tm(run.message) : t("Check the highlighted fields and try again.")}
      </InlineMessage>
    );
  }

  return (
    <Card eyebrow={t("Delivery run")} icon={CloudUpload} title={title} tone="blue">
      <ol className="grid gap-3 md:grid-cols-3">
        {steps.map((step, position) => {
          const state = stateOf(position);
          return (
            <li key={step.key} className={cx("rounded-2xl border p-4", state === "active" ? "border-blue-200 bg-blue-50" : state === "done" ? "border-emerald-100 bg-emerald-50" : "border-slate-200 bg-white")}>
              <div className="flex items-center gap-2">
                <span
                  className={cx(
                    "flex h-7 w-7 items-center justify-center rounded-full text-xs font-black",
                    state === "done" ? "bg-emerald-600 text-white" : state === "active" ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-500"
                  )}
                >
                  {state === "done" ? <CheckCircle2 size={14} /> : position + 1}
                </span>
                <p className="text-sm font-black text-slate-900">{step.label}</p>
              </div>
              <p className="mt-2 text-xs font-bold text-slate-500">{step.hint}</p>
              {state === "active" && position === 1 && (
                <div className="mt-3">
                  <IndeterminateBar />
                  <p className="mt-1 text-[11px] font-bold text-blue-700">{t("Saving…")}</p>
                </div>
              )}
              {state === "active" && position === 0 && (
                <div className="mt-3">
                  <ProgressBar value={run.uploads.total ? (uploadsFinished / run.uploads.total) * 100 : 0} tone="indigo" size="sm" showValue />
                </div>
              )}
              {state === "active" && position === 2 && (
                <div className="mt-3">
                  {job.total ? <ProgressBar value={(job.finished / job.total) * 100} tone="blue" size="sm" showValue /> : <IndeterminateBar />}
                  <p className="mt-1 text-[11px] font-bold text-blue-700">{t("Progress is refreshed every 2 seconds.")}</p>
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {run.phase === "uploading" && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs font-bold text-slate-500">{t("Keep this tab open while the files are uploaded. Stopping keeps the {entity} as a draft with the files already stored.", { entity })}</p>
          <Button variant="danger" size="sm" icon={Square} loading={run.stopping} onClick={onStop}>
            {t("Stop")}
          </Button>
        </div>
      )}

      {run.phase === "delivering" && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="inline-flex items-start gap-2 text-xs font-bold text-slate-500">
            <Info size={14} className="mt-0.5 shrink-0 text-blue-600" />
            {t("The server keeps delivering; you can leave this page and follow progress on the {entity} page.", { entity })}
          </p>
          <Button variant="secondary" size="sm" icon={ExternalLink} onClick={onOpen}>
            {t("Open {entity} page", { entity })}
          </Button>
        </div>
      )}

      {run.phase === "done" && (
        <div className="mt-5 space-y-4">
          {run.interrupted && (
            <InlineMessage tone="warning" title={t("Interrupted on the server")}>
              {t("The server stopped delivering before every {item} finished (it may have been restarted). Open the {entity} page, use «Sync from CMS» to reconcile the {items}, then deliver the remaining ones again.", { item, entity, items })}
            </InlineMessage>
          )}
          {(run.timed_out || run.poll_error) && (
            <InlineMessage tone="warning" title={t("Still running on the server")}>
              {run.poll_error
                ? t("Progress could not be refreshed ({error}). The delivery continues on the server — open the {entity} page to follow it.", { error: tm(run.poll_error), entity })
                : t("This page stopped refreshing after 30 minutes. The delivery continues on the server — open the {entity} page to follow it.", { entity })}
            </InlineMessage>
          )}
          {run.message && <InlineMessage tone={run.failed ? "error" : "warning"}>{tm(run.message)}</InlineMessage>}
          {run.stopped && !run.job_started && (
            <InlineMessage
              tone="warning"
              title={t("Uploads were stopped")}
              actions={
                onDeliverNow ? (
                  <Button size="sm" variant="primary" icon={CloudUpload} onClick={onDeliverNow}>
                    {t("Deliver now")}
                  </Button>
                ) : null
              }
            >
              {t("The {entity} is stored as a draft with the files uploaded so far. Deliver it now with what is stored, or open the {entity} page to upload the remaining files first.", { entity })}
            </InlineMessage>
          )}
          {run.stopped && run.job_started && <InlineMessage tone="warning">{t("Some uploads were stopped — those {items} were created without a reference. Upload the {media} from the {entity} page.", { items, media, entity })}</InlineMessage>}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <SummaryTile label={t("Assets created")} value={counts.created} tone="blue" />
            <SummaryTile label={t("References delivered")} value={counts.completed} tone="emerald" />
            <SummaryTile label={t("Duplicates")} value={counts.duplicates} tone="amber" />
            <SummaryTile label={t("Errors")} value={counts.errors} tone={counts.errors ? "red" : "slate"} />
            <SummaryTile label={capitalize(t("{media} kept on server", { media }))} value={counts.storedAudio} tone="slate" />
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="primary" icon={ExternalLink} onClick={onOpen}>
              {t("Open {entity}", { entity })}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
