import { useEffect, useId, useMemo, useState } from "react";
import { CalendarClock, Plus, Save, Undo2, X } from "lucide-react";
import { Badge, Button, Card, Field, IconButton, InlineMessage, Select, TextInput, Toggle } from "../assetDelivery/shared";
import { cx } from "../assetDelivery/utils";
import { useI18n } from "../../context/I18nContext";
import { analyticsApi, analyticsError } from "../../api/analyticsApi";
import { ChannelPicker, ErrorPanel, LoadingPanel, StatusBadge } from "./shared";
import { useAnalytics } from "./hooks";
import { ANALYTICS_SYNC_TIMEZONE, SCOPE_LABELS, countDays, formatScheduleDate } from "./analyticsUtils";

// The daily schedule of the current Content Owner (GET/PUT /schedules). The form is a patch over the stored row
// (or the bootstrap defaults), so a reload after a finished job never discards unsaved edits; Save needs
// permissions.canManageSchedules and a schedule that already includes revenue stays locked for non-monetary roles.

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const MAX_TIMES = 6;
const MAX_CHANNELS = 200;
const LAG_DAYS = [3, 4, 5, 6, 7];
const LOOKBACK_RANGE = [3, 90];
const SETTLE_RANGE = [3, 30];
const CHANNEL_MODES = ["all", "selected", "none"];
const SCOPES = Object.keys(SCOPE_LABELS);
const EMPTY_DEFAULTS = Object.freeze({});
const CHIP = "inline-flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-1.5 text-xs font-bold transition";
const CHIP_ON = "border-blue-600 bg-blue-50 text-blue-700";
const CHIP_OFF = "border-slate-200 text-slate-600 hover:bg-slate-50";

const isCancelled = (error) => error?.code === "ERR_CANCELED" || error?.name === "CanceledError" || error?.name === "AbortError";
const ownerIdOf = (schedule) => String(schedule?.ownerId ?? schedule?.owner_id ?? "");
const toCount = (value) => (Array.isArray(value) ? value.length : Number.isFinite(Number(value)) ? Number(value) : 0);

function inRange(value, [min, max]) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function intOr(value, range, fallback) {
  const number = Number(value);
  return inRange(number, range) ? number : fallback;
}

// The editable fields of a stored schedule row; a missing row starts from the server defaults.
function scheduleForm(schedule, defaults) {
  const times = Array.isArray(schedule?.times) && schedule.times.length ? schedule.times : Array.isArray(defaults.scheduleTimes) && defaults.scheduleTimes.length ? defaults.scheduleTimes : ["09:00"];
  const scopes = Array.isArray(schedule?.scopes) ? SCOPES.filter((scope) => schedule.scopes.includes(scope)) : [];
  return {
    enabled: Boolean(schedule?.enabled),
    times: [...times],
    lagDays: intOr(schedule?.lagDays, [LAG_DAYS[0], LAG_DAYS[LAG_DAYS.length - 1]], intOr(defaults.lagDays, [3, 7], 3)),
    lookbackDays: intOr(schedule?.lookbackDays, LOOKBACK_RANGE, intOr(defaults.lookbackDays, LOOKBACK_RANGE, 7)),
    scopes: scopes.length ? scopes : [SCOPES.includes(schedule?.scope) ? schedule.scope : "claimed"],
    channelMode: CHANNEL_MODES.includes(schedule?.channelMode) ? schedule.channelMode : "all",
    channelIds: Array.isArray(schedule?.channelIds) ? schedule.channelIds.slice(0, MAX_CHANNELS) : [],
    includeBreakdowns: schedule ? schedule.includeBreakdowns !== false : true,
    includeSnapshots: schedule ? schedule.includeSnapshots !== false : true,
    monetary: Boolean(schedule?.monetary),
    refreshProvisional: Boolean(schedule?.refreshProvisional),
    settleDays: intOr(schedule?.settleDays, SETTLE_RANGE, intOr(defaults.settleDays, SETTLE_RANGE, 7))
  };
}

// The daily-run status (schedules[].lastRun and overview.dailyRun share the backend's dailyRunStatus shape: status,
// late, consecutiveFailures, firstError, counts, days). Day counts come from result.days (addedCount / driftedCount);
// an older job without them gets the row-oriented sentence, never row counters in a "days" sentence.
function LastRunLine({ lastRun }) {
  const { t, tm, language, formatNumber } = useI18n();
  const counts = lastRun.counts || {};
  const days = lastRun.days && typeof lastRun.days === "object" ? lastRun.days : null;
  const status = lastRun.status || "not-run";
  const error = typeof lastRun.firstError === "string" ? lastRun.firstError : lastRun.firstError?.message || "";
  const failures = toCount(lastRun.consecutiveFailures);
  const fmt = (value) => formatNumber(toCount(value));
  const details = [];
  if (status === "completed" || status === "partial") {
    if (lastRun.finishedAt) details.push(t("Finished {instant}", { instant: formatScheduleDate(lastRun.finishedAt, language) }));
    if (days) details.push(t("Added {days} · {drift} days drifted", { days: formatNumber(countDays(days, "added")), drift: formatNumber(countDays(days, "drifted")) }));
    else if (lastRun.counts) details.push(t("{inserted} added · {updated} updated · {drift} drift", { inserted: fmt(counts.inserted), updated: fmt(counts.updated), drift: fmt(counts.drift) }));
  } else if (lastRun.scheduledFor) {
    details.push(t("Scheduled for {instant}", { instant: formatScheduleDate(lastRun.scheduledFor, language) }));
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <StatusBadge status={status} />
      {lastRun.late && <Badge tone="amber">{t("Late")}</Badge>}
      {failures >= 2 && <Badge tone="red">{t("{count} consecutive failures", { count: failures })}</Badge>}
      {details.length > 0 && <span className="text-slate-500">{details.join(" · ")}</span>}
      {error && (
        <span className="min-w-0 truncate font-bold text-red-600" title={tm(error)}>
          {tm(error)}
        </span>
      )}
    </span>
  );
}

// onScheduleLoaded(schedule | null) tells the Data & sync view which stored schedule applies (its Sync-all card words
// the daily run's write behaviour after refreshProvisional).
export default function ScheduleCard({ onScheduleLoaded }) {
  const { t, tm, language, formatNumber } = useI18n();
  const { filters, permissions, inventory, bootstrap, overview, refreshKey, notify } = useAnalytics();
  const ownerId = filters.ownerId;
  const { canManageSchedules, canMonetary, connected } = permissions;
  const [state, setState] = useState({ schedule: null, loaded: false, loading: true, error: "" });
  const [attempt, setAttempt] = useState(0);
  const [patch, setPatch] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const timesId = useId();
  const scopesId = useId();
  const channelsId = useId();
  const channelModeName = useId();
  const lagId = useId();
  const lookbackId = useId();
  const settleId = useId();

  // refreshKey: a finished job updates the last-run outcome; the patch (unsaved edits) survives the reload.
  useEffect(() => {
    if (!ownerId) return undefined;
    const controller = new AbortController();
    const load = async () => {
      setState((previous) => ({ ...previous, loading: true, error: "" }));
      try {
        const response = await analyticsApi.schedules(controller.signal);
        if (controller.signal.aborted) return;
        const rows = Array.isArray(response?.schedules) ? response.schedules : [];
        setState({ schedule: rows.find((row) => ownerIdOf(row) === ownerId) || null, loaded: true, loading: false, error: "" });
      } catch (failure) {
        if (controller.signal.aborted || isCancelled(failure)) return;
        setState((previous) => ({ ...previous, loading: false, error: analyticsError(failure) }));
      }
    };
    load();
    return () => controller.abort();
  }, [ownerId, attempt, refreshKey]);

  useEffect(() => {
    if (typeof onScheduleLoaded === "function" && state.loaded) onScheduleLoaded(state.schedule);
  }, [onScheduleLoaded, state.loaded, state.schedule]);

  const defaults = bootstrap?.defaults ?? EMPTY_DEFAULTS;
  const baseline = useMemo(() => scheduleForm(state.schedule, defaults), [state.schedule, defaults]);
  const form = useMemo(() => ({ ...baseline, ...patch }), [baseline, patch]);
  const changedKeys = Object.keys(patch).filter((key) => JSON.stringify(patch[key]) !== JSON.stringify(baseline[key]));
  const dirty = changedKeys.length > 0;
  const locked = Boolean(state.schedule?.monetary) && !canMonetary;
  const editable = canManageSchedules && state.loaded && !locked && !saving;
  const activeChannels = inventory.channels.filter((channel) => !channel.removedAt).length;
  const schedule = state.schedule;
  // One daily-run story: schedules[].lastRun and overview.dailyRun are the same backend status (dailyRunStatus).
  const lastRun = schedule?.lastRun || overview?.dailyRun || null;
  // The stored schedule's write behaviour (not the unsaved edits): with "Refresh unsettled days" the daily run
  // overwrites the newest settleDays days through the ledger; everything else stays append-only.
  const refreshes = Boolean(schedule?.refreshProvisional);
  const settleDays = intOr(schedule?.settleDays, SETTLE_RANGE, baseline.settleDays);

  const update = (changes) => {
    setPatch((current) => ({ ...current, ...changes }));
    setSaveError("");
  };

  const problems = [];
  if (!form.times.length || form.times.length > MAX_TIMES || form.times.some((time) => !TIME.test(time))) problems.push(t("Enter between 1 and {max} run times as HH:MM", { max: MAX_TIMES }));
  else if (new Set(form.times).size !== form.times.length) problems.push(t("Run times must be different"));
  if (!inRange(form.lookbackDays, LOOKBACK_RANGE)) problems.push(t("Lookback must be between {min} and {max} days", { min: LOOKBACK_RANGE[0], max: LOOKBACK_RANGE[1] }));
  if (form.refreshProvisional && !inRange(form.settleDays, SETTLE_RANGE)) problems.push(t("Settle days must be between {min} and {max}", { min: SETTLE_RANGE[0], max: SETTLE_RANGE[1] }));
  if (!form.scopes.length) problems.push(t("Select at least one scope"));
  if (form.channelMode === "selected" && !form.channelIds.length) problems.push(t("Pick at least one channel, or keep all channels"));
  if (form.enabled && !connected) problems.push(t("Turn the schedule off or reconnect the CMS before saving"));

  async function save(event) {
    event.preventDefault();
    if (!editable || !dirty || problems.length) return;
    setSaving(true);
    setSaveError("");
    try {
      const response = await analyticsApi.saveSchedule({
        ownerId,
        enabled: form.enabled,
        times: form.times,
        timezone: ANALYTICS_SYNC_TIMEZONE,
        lagDays: form.lagDays,
        lookbackDays: form.lookbackDays,
        scopes: form.scopes,
        channelMode: form.channelMode,
        channelIds: form.channelMode === "selected" ? form.channelIds : [],
        includeBreakdowns: form.includeBreakdowns,
        includeSnapshots: form.includeSnapshots,
        monetary: canMonetary && form.monetary,
        refreshProvisional: form.refreshProvisional,
        settleDays: form.settleDays
      });
      if (response?.schedule) setState({ schedule: response.schedule, loaded: true, loading: false, error: "" });
      setPatch({});
      notify(t("Schedule saved"), "success");
    } catch (failure) {
      setSaveError(analyticsError(failure));
    } finally {
      setSaving(false);
    }
  }

  if (!state.loaded) {
    return state.error ? <ErrorPanel error={state.error} onRetry={() => setAttempt((count) => count + 1)} /> : <LoadingPanel rows={6} />;
  }

  const channelHint = {
    all: t("Every active channel of the inventory gets its own daily rows."),
    selected: t("Only the picked channels get daily rows (up to {max}).", { max: MAX_CHANNELS }),
    none: t("Only the Content Owner totals and breakdowns are stored.")
  };

  return (
    <Card
      eyebrow={t("Schedule")}
      icon={CalendarClock}
      tone="blue"
      title={t("Daily sync")}
      subtitle={
        refreshes
          ? t("Runs every day at the times below and only adds days that are not stored yet, except the last {n} unsettled days, which it refreshes; every change is kept in the ledger.", { n: formatNumber(settleDays) })
          : t("Runs every day at the times below and only adds days that are not stored yet; numbers YouTube revised are recorded as drift.")
      }
      actions={
        <Toggle
          checked={form.enabled}
          disabled={!editable || (!connected && !form.enabled)}
          onChange={(checked) => update({ enabled: checked })}
          label={form.enabled ? t("Enabled") : t("Disabled")}
        />
      }
    >
      <form onSubmit={save} className="space-y-5" aria-busy={state.loading || undefined}>
        {locked && <InlineMessage tone="warning">{t("Only administrators and Report Managers can change this schedule.")}</InlineMessage>}
        {!canManageSchedules && !locked && <InlineMessage tone="neutral">{t("Only accounts that can sync may change the schedule.")}</InlineMessage>}
        {!connected && <InlineMessage tone="warning">{t("Reconnect the CMS to enable the schedule; you can still turn it off.")}</InlineMessage>}

        <fieldset disabled={!editable} className="space-y-5">
          <div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span id={timesId} className="text-xs font-black uppercase tracking-wide text-slate-400">
                {t("Run times")}
              </span>
              <span className="text-xs font-bold text-slate-400">
                {t("GMT+7")} · {t("Vietnam time")}
              </span>
            </div>
            <div role="group" aria-labelledby={timesId} className="mt-1.5 flex flex-wrap items-center gap-2">
              {form.times.map((time, index) => (
                <span key={index} className="inline-flex items-center gap-1">
                  <TextInput
                    type="time"
                    compact
                    step={60}
                    value={time}
                    invalid={!TIME.test(time)}
                    aria-label={t("Run time {number}", { number: index + 1 })}
                    onChange={(event) => update({ times: form.times.map((item, position) => (position === index ? event.target.value : item)) })}
                    className="w-28"
                  />
                  <IconButton
                    size="sm"
                    icon={X}
                    label={t("Remove run time {number}", { number: index + 1 })}
                    disabled={form.times.length <= 1}
                    onClick={() => update({ times: form.times.filter((_, position) => position !== index) })}
                  />
                </span>
              ))}
              {form.times.length < MAX_TIMES && (
                <Button variant="ghost" size="sm" icon={Plus} onClick={() => update({ times: [...form.times, ""] })}>
                  {t("Add another time")}
                </Button>
              )}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Field label={t("Lag days")} htmlFor={lagId} hint={t("YouTube publishes a day 48–72 hours later: each run requests up to the day {days} days before it and stores every day already published (normally up to 4 days back).", { days: form.lagDays })}>
              <Select id={lagId} compact value={form.lagDays} onChange={(event) => update({ lagDays: Number(event.target.value) })} options={LAG_DAYS.map((days) => ({ value: days, label: t("{count} days", { count: days }) }))} />
            </Field>
            <Field label={t("Lookback days")} htmlFor={lookbackId} hint={t("Each run re-reads the last {days} days and records changed numbers as drift.", { days: form.lookbackDays })}>
              <TextInput
                id={lookbackId}
                type="number"
                compact
                min={LOOKBACK_RANGE[0]}
                max={LOOKBACK_RANGE[1]}
                value={form.lookbackDays}
                invalid={!inRange(form.lookbackDays, LOOKBACK_RANGE)}
                onChange={(event) => update({ lookbackDays: event.target.value === "" ? "" : Number(event.target.value) })}
              />
            </Field>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="min-w-0">
              <p id={scopesId} className="text-xs font-black uppercase tracking-wide text-slate-400">
                {t("Scopes")}
              </p>
              <div role="group" aria-labelledby={scopesId} className="mt-1.5 flex flex-wrap gap-2">
                {SCOPES.map((scope) => {
                  const checked = form.scopes.includes(scope);
                  return (
                    <label key={scope} className={cx(CHIP, checked ? CHIP_ON : CHIP_OFF)}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(event) => update({ scopes: SCOPES.filter((item) => (item === scope ? event.target.checked : form.scopes.includes(item))) })}
                        className="h-3.5 w-3.5 accent-blue-600"
                      />
                      {t(SCOPE_LABELS[scope])}
                    </label>
                  );
                })}
              </div>
              <p className="mt-1 text-xs text-slate-400">{t("Scopes overlap and are stored separately; the run requests each selected scope.")}</p>
            </div>
            <div className="min-w-0">
              <p id={channelsId} className="text-xs font-black uppercase tracking-wide text-slate-400">
                {t("Channel tracking")}
              </p>
              <div role="radiogroup" aria-labelledby={channelsId} className="mt-1.5 flex flex-wrap gap-2">
                {CHANNEL_MODES.map((mode) => {
                  const checked = form.channelMode === mode;
                  const label = mode === "all" ? t("All channels ({count})", { count: activeChannels }) : mode === "selected" ? t("Selected channels") : t("Content Owner totals only");
                  return (
                    <label key={mode} className={cx(CHIP, checked ? CHIP_ON : CHIP_OFF)}>
                      <input type="radio" name={channelModeName} value={mode} checked={checked} onChange={() => update({ channelMode: mode })} className="h-3.5 w-3.5 accent-blue-600" />
                      {label}
                    </label>
                  );
                })}
              </div>
              {form.channelMode === "selected" && (
                <div className="mt-2">
                  <ChannelPicker
                    size="sm"
                    channels={inventory.channels}
                    value={form.channelIds}
                    disabled={!editable}
                    maxSelectable={MAX_CHANNELS}
                    onChange={(ids) => update({ channelIds: ids, channelMode: ids.length ? "selected" : "all" })}
                  />
                </div>
              )}
              <p className="mt-1 text-xs text-slate-400">{channelHint[form.channelMode]}</p>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <Toggle size="sm" checked={form.includeBreakdowns} disabled={!editable} onChange={(checked) => update({ includeBreakdowns: checked })} label={t("Breakdowns")} description={t("Traffic sources, devices, countries and the other breakdowns per day")} />
            <Toggle size="sm" checked={form.includeSnapshots} disabled={!editable} onChange={(checked) => update({ includeSnapshots: checked })} label={t("Range reports")} description={t("Top videos and age & gender for the 7, 28 and 90-day windows")} />
            {canMonetary && (
              <Toggle size="sm" checked={form.monetary} disabled={!editable} onChange={(checked) => update({ monetary: checked })} label={t("Revenue")} description={t("Estimated revenue, ad revenue, CPM and RPM (USD)")} />
            )}
            <Toggle size="sm" checked={form.refreshProvisional} disabled={!editable} onChange={(checked) => update({ refreshProvisional: checked })} label={t("Refresh unsettled days")} description={t("Re-read the newest days in overwrite mode; older days stay append-only and every change is kept in the ledger.")} />
          </div>
          {form.refreshProvisional && (
            <Field label={t("Settle days")} htmlFor={settleId} hint={t("Days within {days} days of the window end count as unsettled.", { days: form.settleDays })} className="md:w-64">
              <TextInput
                id={settleId}
                type="number"
                compact
                min={SETTLE_RANGE[0]}
                max={SETTLE_RANGE[1]}
                value={form.settleDays}
                invalid={!inRange(form.settleDays, SETTLE_RANGE)}
                onChange={(event) => update({ settleDays: event.target.value === "" ? "" : Number(event.target.value) })}
              />
            </Field>
          )}
        </fieldset>

        <dl className="grid gap-3 rounded-2xl bg-slate-50 p-4 text-sm md:grid-cols-2">
          <div>
            <dt className="text-xs font-black uppercase tracking-wide text-slate-400">{t("Next run")}</dt>
            <dd className="mt-0.5 font-bold text-slate-800">{schedule?.enabled && schedule.nextRunAt ? formatScheduleDate(schedule.nextRunAt, language) : t("Automatic sync is off")}</dd>
          </div>
          <div>
            <dt className="text-xs font-black uppercase tracking-wide text-slate-400">{t("Last run")}</dt>
            <dd className="mt-0.5 font-bold text-slate-800">{schedule?.lastRunAt ? formatScheduleDate(schedule.lastRunAt, language) : t("Not yet")}</dd>
          </div>
          <div className="md:col-span-2">
            <dt className="text-xs font-black uppercase tracking-wide text-slate-400">{t("Last job")}</dt>
            <dd className="mt-1 font-bold text-slate-800">{lastRun ? <LastRunLine lastRun={lastRun} /> : t("Not yet")}</dd>
          </div>
          {schedule?.lastError && (
            <div className="md:col-span-2">
              <dt className="text-xs font-black uppercase tracking-wide text-slate-400">{t("Last error")}</dt>
              <dd className="mt-0.5 font-bold text-red-600">
                {tm(String(schedule.lastError))}
                {schedule.lastErrorAt && <span className="ml-1 font-medium text-slate-500">({formatScheduleDate(schedule.lastErrorAt, language)})</span>}
                {schedule.enabled && schedule.retryAt && <span className="ml-1 font-medium text-slate-500">· {t("Retry at {instant}", { instant: formatScheduleDate(schedule.retryAt, language) })}</span>}
              </dd>
            </div>
          )}
        </dl>

        {saveError && <InlineMessage tone="error">{tm(saveError)}</InlineMessage>}
        {canManageSchedules && !locked && (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" icon={Save} loading={saving} disabled={!dirty || problems.length > 0}>
              {t("Save schedule")}
            </Button>
            {dirty && (
              <Button
                variant="ghost"
                icon={Undo2}
                disabled={saving}
                onClick={() => {
                  setPatch({});
                  setSaveError("");
                }}
              >
                {t("Discard changes")}
              </Button>
            )}
            {problems.length > 0 && <p className="text-xs font-bold text-red-600">{problems[0]}</p>}
            {!problems.length && dirty && <p className="text-xs font-bold text-slate-400">{t("{count} unsaved changes", { count: formatNumber(changedKeys.length) })}</p>}
          </div>
        )}
      </form>
    </Card>
  );
}
