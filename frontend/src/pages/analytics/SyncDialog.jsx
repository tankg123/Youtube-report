import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, LoaderCircle, RefreshCw } from "lucide-react";
import { Button, InlineMessage, Modal } from "../assetDelivery/shared";
import { cx } from "../assetDelivery/utils";
import { useI18n } from "../../context/I18nContext";
import { ChannelPicker, DateRangeControl } from "./shared";
import { useAnalytics } from "./hooks";
import { SCOPE_LABELS, buildSyncRequest, dayDiff, estimateRequests } from "./analyticsUtils";
import { SYNC_CHANNEL_MODES, fetchEndDay, initialSyncForm, isSyncSubmitBlocked, newerDaysOutside, overwriteDayCount } from "./syncDialogLogic";

// "Sync all" asks the question first: keep the stored numbers (append) or replace them (overwrite, admins and
// Report Managers only). The Advanced section is prefilled from the global filters with the end extended to the
// newest fetchable day (syncDialogLogic.initialSyncForm); the footer shows the server's dry-run plan (client
// estimate while it answers) and refuses a job above the request cap. The pure rules live in syncDialogLogic.js.

const PLAN_DEBOUNCE_MS = 350;
const SECONDS_PER_REQUEST = 0.35; // ≥ 250 ms pacing plus Google latency
const CHANNEL_MODES = SYNC_CHANNEL_MODES;
const NO_PLAN = { loading: true, estimate: null, overCap: false, error: "", key: "", days: null };

function planEstimate(plan) {
  const value = plan?.requests?.estimate ?? plan?.estimate;
  const number = Number(value);
  return value !== null && value !== undefined && Number.isFinite(number) ? number : null;
}

// The day summary of a dry-run plan ({ requested, missingFacts }) feeds the "Overwrite {count} days" button.
const planDays = (plan) => (plan?.days && typeof plan.days === "object" ? plan.days : null);

function ModeCard({ name, value, checked, onChange, title, text, danger = false }) {
  const active = danger ? "border-red-600 bg-red-50" : "border-blue-600 bg-blue-50";
  return (
    <label className={cx("flex cursor-pointer gap-3 rounded-2xl border-2 p-4 transition", checked ? active : "border-slate-200 bg-white hover:bg-slate-50")}>
      <input type="radio" name={name} value={value} checked={checked} onChange={() => onChange(value)} className={cx("mt-1 h-4 w-4 shrink-0", danger ? "accent-red-600" : "accent-blue-600")} />
      <span className="min-w-0">
        <span className={cx("block text-base font-black", danger ? "text-red-700" : "text-slate-950")}>{title}</span>
        <span className="mt-1 block text-sm text-slate-500">{text}</span>
      </span>
    </label>
  );
}

function OptionCheckbox({ checked, onChange, label, hint, disabled = false, tag }) {
  return (
    <label className={cx("flex items-start gap-3 rounded-2xl border border-slate-200 bg-white p-3", disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-slate-50")}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-blue-600" />
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-sm font-bold text-slate-800">
          {label}
          {tag && <span className="rounded-md bg-amber-50 px-1 py-0.5 text-[10px] font-black text-amber-700">{tag}</span>}
        </span>
        {hint && <span className="mt-0.5 block text-xs text-slate-400">{hint}</span>}
      </span>
    </label>
  );
}

// Mounted only while the dialog is open, so every opening starts from the current filters.
function SyncDialogForm({ options }) {
  const { t, tm, formatDate, formatNumber } = useI18n();
  const { closeSyncDialog, filters, permissions, inventory, startSync, syncing, notify, latestDay, latestAllowedDay, lagDays, presets, bootstrap, owner } = useAnalytics();
  const { canOverwrite, canMonetary, connected } = permissions;
  const [form, setForm] = useState(() => initialSyncForm(options, filters, permissions, { latestAllowedDay, lagDays }));
  const [advanced, setAdvanced] = useState(false);
  const [plan, setPlan] = useState(NO_PLAN);
  const [error, setError] = useState("");
  const sequenceRef = useRef(0);
  const formId = useId();
  const advancedId = useId();
  const modeGroup = useId();
  const channelGroup = useId();
  const channelModeName = useId();

  const update = (patch) => setForm((current) => ({ ...current, ...patch }));
  const request = useMemo(
    () => buildSyncRequest({ ...form, channelMode: form.channelMode === "selected" && !form.channelIds.length ? "all" : form.channelMode }, filters, permissions),
    [form, filters, permissions]
  );
  const requestKey = JSON.stringify(request);
  const dayCount = (dayDiff(request.startDate, request.endDate) ?? -1) + 1;
  const activeChannels = inventory.channels.filter((channel) => !channel.removedAt).length;
  const channelCount = request.channelMode === "none" ? 0 : request.channelMode === "selected" ? request.channelIds.length : activeChannels;
  const placeholder = estimateRequests({
    days: dayCount, channelCount, batch: bootstrap?.defaults?.channelBatch, monetary: request.monetary,
    breakdowns: request.includeBreakdowns, snapshots: request.includeSnapshots, scopes: request.scopes
  });
  const maxRequests = Number(bootstrap?.limits?.maxRequestsPerJob) || null;
  const estimate = plan.estimate ?? placeholder;
  const overCap = plan.overCap || (maxRequests !== null && estimate > maxRequests);
  const minutes = Math.max(1, Math.ceil((estimate * SECONDS_PER_REQUEST) / 60));
  const needsChannels = form.channelMode === "selected" && !form.channelIds.length;
  const overwrite = form.mode === "overwrite";
  const blocked = isSyncSubmitBlocked({ syncing, connected, overCap, needsChannels, dayCount, form });
  // Stored days the overwrite replaces: from the plan of the current body (not a stale one), else the range length.
  const overwriteDays = overwriteDayCount(plan.key === requestKey ? { days: plan.days } : null, dayCount);
  // Fetchable days after the chosen end (the "newer days not yet synced" of the Overview stay missing).
  const fetchEnd = fetchEndDay({ latestAllowedDay, lagDays });
  const newerDays = newerDaysOutside(request.endDate, { latestAllowedDay, lagDays });

  // The server plan for the current body, debounced; a stale answer (older sequence) is ignored.
  useEffect(() => {
    if (!connected) return undefined;
    sequenceRef.current += 1;
    const sequence = sequenceRef.current;
    const timer = setTimeout(() => {
      setPlan((current) => ({ ...current, loading: true, error: "" }));
      startSync({ ...JSON.parse(requestKey), dryRun: true })
        .then((response) => {
          if (sequence !== sequenceRef.current) return;
          setPlan({ loading: false, estimate: planEstimate(response?.plan), overCap: false, error: "", key: requestKey, days: planDays(response?.plan) });
        })
        .catch((failure) => {
          if (sequence !== sequenceRef.current) return;
          const capped = failure.status === 400 && Boolean(failure.plan);
          setPlan({ loading: false, estimate: planEstimate(failure.plan), overCap: capped, error: capped ? "" : failure.message || "", key: requestKey, days: planDays(failure.plan) });
        });
    }, PLAN_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [requestKey, startSync, connected]);

  async function submit(event) {
    event.preventDefault();
    if (blocked) return;
    setError("");
    try {
      const response = await startSync(request);
      closeSyncDialog();
      notify(response?.deduplicated ? t("An identical sync is already queued") : t("Sync queued"), "success");
    } catch (failure) {
      if (failure.plan) setPlan({ loading: false, estimate: planEstimate(failure.plan), overCap: failure.status === 400, error: "", key: requestKey, days: planDays(failure.plan) });
      setError(failure.message || t("Could not reach the Analytics service."));
    }
  }

  const planLine = (
    <p className={cx("flex items-center gap-2 text-xs font-bold", overCap ? "text-red-600" : "text-slate-500")}>
      {plan.loading && connected ? <LoaderCircle size={13} className="shrink-0 animate-spin" aria-hidden="true" /> : null}
      <span>{t("Up to {n} requests · about {m} min", { n: formatNumber(estimate), m: formatNumber(minutes) })}</span>
      {overCap && <span>· {t("Shorten the range or select fewer channels")}</span>}
    </p>
  );

  return (
    <Modal
      open
      size="lg"
      title={t("Sync all data")}
      subtitle={owner?.name || undefined}
      onClose={syncing ? undefined : closeSyncDialog}
      closeOnBackdrop={!syncing}
      footer={
        <>
          <div className="mr-auto min-w-0">{planLine}</div>
          <Button variant="secondary" onClick={closeSyncDialog} disabled={syncing}>
            {t("Cancel")}
          </Button>
          <Button type="submit" form={formId} variant={overwrite ? "danger" : "primary"} icon={RefreshCw} loading={syncing} disabled={blocked}>
            {overwrite ? t("Overwrite {count} days", { count: formatNumber(overwriteDays) }) : t("Add missing days")}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="space-y-4">
        <div role="radiogroup" aria-label={t("Sync all data")} className={cx("grid gap-3", canOverwrite && "md:grid-cols-2")}>
          <ModeCard
            name={modeGroup}
            value="append"
            checked={!overwrite}
            onChange={(mode) => update({ mode })}
            title={t("Only add missing numbers")}
            text={t("Days already stored stay exactly as they are. If YouTube now reports different numbers, they are recorded as drift for you to review.")}
          />
          {canOverwrite && (
            <ModeCard
              name={modeGroup}
              value="overwrite"
              danger
              checked={overwrite}
              onChange={(mode) => update({ mode })}
              title={t("Overwrite stored numbers")}
              text={t("Every day in the range is replaced with YouTube's latest numbers. Previous values are kept in the change ledger.")}
            />
          )}
        </div>
        <p className="text-xs text-slate-500">{t("Range reports (top videos, age and gender) are always refreshed.")}</p>

        <div className="rounded-2xl border border-slate-200">
          <button
            type="button"
            aria-expanded={advanced}
            aria-controls={advancedId}
            onClick={() => setAdvanced((current) => !current)}
            className="flex w-full items-center justify-between gap-3 rounded-2xl px-4 py-3 text-left text-sm font-black text-slate-800 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-200"
          >
            <span className="min-w-0">
              {t("Advanced")}
              <span className="ml-2 font-bold text-slate-400">
                {formatDate(request.startDate)} – {formatDate(request.endDate)} · {t("{count} days", { count: formatNumber(Math.max(0, dayCount)) })} ·{" "}
                {request.channelMode === "none" ? t("Content Owner totals only") : request.channelMode === "selected" ? t("{count} channels", { count: request.channelIds.length }) : t("All channels")}
              </span>
            </span>
            <ChevronDown size={16} className={cx("shrink-0 text-slate-400 transition", advanced && "rotate-180")} aria-hidden="true" />
          </button>
          {newerDays > 0 && fetchEnd && (
            <p className="px-4 pb-3 text-xs font-bold text-amber-700">
              {t("This range stops before {date}: {count} newer days are not included.", { date: formatDate(fetchEnd), count: formatNumber(newerDays) })}
            </p>
          )}
          {advanced && (
            <div id={advancedId} className="space-y-4 border-t border-slate-100 p-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="min-w-0">
                  <p className="text-xs font-black uppercase tracking-wide text-slate-400">{t("Date range")}</p>
                  <div className="mt-1.5">
                    <DateRangeControl
                      inline
                      value={{ startDate: form.startDate, endDate: form.endDate }}
                      onChange={(range) => update(range)}
                      latestDay={latestDay}
                      latestAllowedDay={latestAllowedDay}
                      lagDays={lagDays}
                      presets={presets}
                    />
                  </div>
                  <p className="mt-1 text-xs text-slate-400">
                    {t("Scope")}: {t(SCOPE_LABELS[request.scopes[0]] || request.scopes[0])} · {t("Up to 366 days per sync")}
                  </p>
                </div>
                <div className="min-w-0">
                  <p id={channelGroup} className="text-xs font-black uppercase tracking-wide text-slate-400">
                    {t("Channels")}
                  </p>
                  <div role="radiogroup" aria-labelledby={channelGroup} className="mt-1.5 flex flex-wrap gap-2">
                    {CHANNEL_MODES.map((modeKey) => {
                      const checked = form.channelMode === modeKey;
                      const label = modeKey === "all" ? t("All channels ({count})", { count: activeChannels }) : modeKey === "selected" ? t("Selected channels") : t("Content Owner totals only");
                      return (
                        <label key={modeKey} className={cx("inline-flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-1.5 text-xs font-bold transition", checked ? "border-blue-600 bg-blue-50 text-blue-700" : "border-slate-200 text-slate-600 hover:bg-slate-50")}>
                          <input type="radio" name={channelModeName} value={modeKey} checked={checked} onChange={() => update({ channelMode: modeKey })} className="h-3.5 w-3.5 accent-blue-600" />
                          {label}
                        </label>
                      );
                    })}
                  </div>
                  {form.channelMode === "selected" && (
                    <div className="mt-2">
                      <ChannelPicker size="sm" channels={inventory.channels} value={form.channelIds} onChange={(ids) => update({ channelIds: ids, channelMode: ids.length ? "selected" : "all" })} />
                      {needsChannels && <p className="mt-1 text-xs font-bold text-amber-700">{t("Pick at least one channel, or keep all channels")}</p>}
                    </div>
                  )}
                </div>
              </div>
              <div className={cx("grid gap-3", canMonetary ? "md:grid-cols-3" : "md:grid-cols-2")}>
                <OptionCheckbox checked={form.includeBreakdowns} onChange={(checked) => update({ includeBreakdowns: checked })} label={t("Breakdowns")} hint={t("Traffic sources, devices, countries and the other breakdowns per day")} />
                <OptionCheckbox checked={form.includeSnapshots} onChange={(checked) => update({ includeSnapshots: checked })} label={t("Range reports")} hint={t("Top videos and age & gender for the range")} />
                {canMonetary && <OptionCheckbox checked={form.monetary} onChange={(checked) => update({ monetary: checked })} label={t("Revenue")} tag="USD" hint={t("Estimated revenue, ad revenue, CPM and RPM")} />}
              </div>
            </div>
          )}
        </div>

        {overwrite && (
          <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm font-bold text-red-700">
            <input type="checkbox" checked={form.confirmed} onChange={(event) => update({ confirmed: event.target.checked })} className="mt-0.5 h-4 w-4 shrink-0 accent-red-600" />
            {t("I understand the stored numbers will be replaced")}
          </label>
        )}

        {!connected && <InlineMessage tone="warning" title={t("CMS disconnected")}>{t("Ask an administrator to reconnect the CMS OAuth in Settings > Network.")}</InlineMessage>}
        {plan.error && connected && !error && <InlineMessage tone="warning">{tm(plan.error)}</InlineMessage>}
        {error && <InlineMessage tone="error">{tm(error)}</InlineMessage>}
      </form>
    </Modal>
  );
}

export default function SyncDialog() {
  const { syncDialog } = useAnalytics();
  if (!syncDialog?.open) return null;
  return <SyncDialogForm options={syncDialog.options || {}} />;
}
