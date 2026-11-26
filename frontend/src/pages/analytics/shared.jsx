import { useSystemSettings } from "../../context/SystemSettingsContext";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  ArrowDown,
  ArrowDownRight,
  ArrowUp,
  ArrowUpDown,
  ArrowUpRight,
  CalendarDays,
  Check,
  ChevronDown,
  CloudOff,
  Download,
  FileSpreadsheet,
  FileText,
  LoaderCircle,
  Minus,
  Play,
  RefreshCw,
  Search,
  Users
} from "lucide-react";
import { Badge, Button, EmptyState, InlineMessage, Modal, Select, TextInput } from "../assetDelivery/shared";
import { cx } from "../assetDelivery/utils";
import { useI18n } from "../../context/I18nContext";
import { DATE_PRESETS, STATUS_META, addDays, countDays, dayDiff, foldText, formatScheduleDate, isValidDay, presetRange } from "./analyticsUtils";

// Pure building blocks of the Analytics views: props in, callbacks out, never useAnalytics(). Standard Tailwind
// utilities only, so the global .theme-dark overrides apply. Controls that never write anything (export menu,
// sync pill, date presets, channel picker, retry) sit inside data-readonly-allow="true" so ReadOnlyRuntime leaves
// them usable for the Read Only role; write actions (Fill missing days, Run the daily sync now) stay unwrapped and
// are hidden without canSync.

const MAX_RANGE_DAYS = 366;
const EARLIEST_DAY = "2009-01-01";
const MAX_VISIBLE_CHANNELS = 400;
const SKELETON_ROWS = [0, 1, 2, 3, 4];
const LIST_KEYS = ["ArrowDown", "ArrowUp", "Home", "End"];

const SOFT_TONES = {
  slate: "bg-slate-100 text-slate-600",
  blue: "bg-blue-50 text-blue-700",
  emerald: "bg-emerald-50 text-emerald-700",
  amber: "bg-amber-50 text-amber-700",
  red: "bg-red-50 text-red-600"
};
const LINE_TONES = {
  slate: "border-slate-200",
  blue: "border-blue-200",
  emerald: "border-emerald-200",
  amber: "border-amber-200",
  red: "border-red-200"
};
const DOT_TONES = {
  slate: "bg-slate-400",
  blue: "bg-blue-600",
  emerald: "bg-emerald-600",
  amber: "bg-amber-500",
  red: "bg-red-600"
};
const ALIGN = { left: "text-left", right: "text-right", center: "text-center" };
const TRIGGER_CLASS =
  "inline-flex w-full min-w-0 items-center gap-2 border border-slate-200 bg-white font-bold text-slate-900 transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-100 disabled:cursor-not-allowed disabled:opacity-60";

function toCount(value) {
  if (Array.isArray(value)) return value.length;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function isConnected(owner) {
  return owner?.authStatus === "connected" || owner?.connected === true;
}

function ownerLabel(owner) {
  return String(owner?.name || owner?.ownerId || "");
}

function isActiveJob(status) {
  return status === "queued" || status === "running" || status === "cancelling";
}

// Roving focus inside a menu / listbox: Arrow keys cycle, Home / End jump.
function handleListKeys(event, selector) {
  if (!LIST_KEYS.includes(event.key)) return;
  const items = Array.from(event.currentTarget.querySelectorAll(selector)).filter((item) => !item.disabled);
  if (!items.length) return;
  event.preventDefault();
  const index = items.indexOf(document.activeElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
  items[next].focus();
}

// Open / close state of a popover anchored to a trigger: outside pointer and Escape close it and the trigger
// takes the focus back. Escape is stopped at document level so a kit Modal behind the popover stays open.
function usePopover() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointer = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
    };
    const handleKey = (event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  return { open, setOpen, rootRef, triggerRef };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export function StatusBadge({ status }) {
  const { t } = useI18n();
  if (!status) return null;
  const meta = (STATUS_META && STATUS_META[status]) || null;
  return (
    <Badge tone={meta?.tone || "slate"}>
      {isActiveJob(status) && <LoaderCircle size={11} className="animate-spin" aria-hidden="true" />}
      {meta?.label ? t(meta.label) : String(status).replace(/[-_]/g, " ")}
    </Badge>
  );
}

export function PanelHeader({ title, subtitle, status, actions }) {
  return (
    <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
      <div className="min-w-0">
        <h3 className="flex flex-wrap items-center gap-2 text-base font-black text-slate-950">
          {title}
          {status && <StatusBadge status={status} />}
        </h3>
        {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function LoadingPanel({ rows = 4 }) {
  const { t } = useI18n();
  const count = Math.max(1, Math.min(12, Number(rows) || 4));
  return (
    <div role="status" aria-live="polite" className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
      {Array.from({ length: count }, (_, index) => (
        <span key={index} className="block h-3.5 animate-pulse rounded bg-slate-400/30" style={{ width: `${100 - (index % 3) * 18}%` }} />
      ))}
      <span className="sr-only">{t("Loading…")}</span>
    </div>
  );
}

export function ErrorPanel({ error, onRetry }) {
  const { t, tm } = useI18n();
  const message = typeof error === "string" ? error : error?.message || error?.response?.data?.message || "";
  return (
    <InlineMessage
      tone="error"
      title={t("Something went wrong")}
      actions={
        onRetry ? (
          <span data-readonly-allow="true">
            <Button variant="secondary" size="sm" icon={RefreshCw} onClick={() => onRetry()}>
              {t("Retry")}
            </Button>
          </span>
        ) : undefined
      }
    >
      {message ? tm(message) : null}
    </InlineMessage>
  );
}

// ---------------------------------------------------------------------------
// Filters: owner, channels, date range
// ---------------------------------------------------------------------------

export function OwnerSelect({ owners = [], value = "", onChange, disabled = false }) {
  const { t } = useI18n();
  const list = useMemo(
    () => [...owners].sort((a, b) => Number(isConnected(b)) - Number(isConnected(a)) || ownerLabel(a).localeCompare(ownerLabel(b))),
    [owners]
  );
  const selected = list.find((owner) => owner.ownerId === value) || null;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Select
        aria-label={t("Content Owner")}
        value={value || ""}
        disabled={disabled || !list.length}
        placeholder={list.length ? undefined : t("No Content Owner available")}
        onChange={(event) => onChange?.(event.target.value)}
        options={list.map((owner) => ({
          value: owner.ownerId,
          label: isConnected(owner) ? ownerLabel(owner) : `${ownerLabel(owner)} — ${t("CMS disconnected")}`
        }))}
        wrapperClassName="min-w-0 flex-1"
      />
      {selected && !isConnected(selected) && (
        <Badge tone="red" icon={CloudOff} title={selected.authError || undefined}>
          {t("CMS disconnected")}
        </Badge>
      )}
    </div>
  );
}

function ChannelRow({ id, title, thumbnail, removed = false, unknown = false, checked, disabled, onToggle }) {
  const { t } = useI18n();
  return (
    <li>
      <label className={cx("flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-slate-50", disabled && "cursor-not-allowed opacity-60")}>
        <input type="checkbox" className="h-4 w-4 shrink-0 accent-blue-600" checked={checked} disabled={disabled} onChange={(event) => onToggle(id, event.target.checked)} />
        {thumbnail ? (
          <img src={thumbnail} alt="" loading="lazy" className="h-7 w-7 shrink-0 rounded-full object-cover" />
        ) : (
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-400">
            <Users size={13} aria-hidden="true" />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate font-bold text-slate-800">{title}</span>
          <span className="block truncate font-mono text-[11px] text-slate-400">{id}</span>
        </span>
        {removed && <Badge tone="slate">{t("No longer managed")}</Badge>}
        {unknown && <Badge tone="amber">{t("Unknown channel")}</Badge>}
      </label>
    </li>
  );
}

// Mounted only while open, so the draft starts from the committed value on every opening.
function ChannelPickerDialog({ channels, byId, selected, maxSelectable, title, onClose, onApply }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(selected);
  const [query, setQuery] = useState("");
  const searchId = useId();
  const sorted = useMemo(() => [...channels].sort((a, b) => String(a.title || "").localeCompare(String(b.title || ""))), [channels]);
  const folded = useMemo(() => sorted.map((channel) => ({ channel, text: String(foldText(`${channel.title || ""} ${channel.channelId}`) ?? "") })), [sorted]);
  const needle = String(foldText(query.trim()) ?? "");
  const matches = useMemo(() => (needle ? folded.filter((item) => item.text.includes(needle)).map((item) => item.channel) : sorted), [folded, needle, sorted]);
  const visible = matches.slice(0, MAX_VISIBLE_CHANNELS);
  const draftSet = useMemo(() => new Set(draft), [draft]);
  const unknown = draft.filter((id) => !byId.has(id));
  const atCap = draft.length >= maxSelectable;

  function toggle(id, checked) {
    setDraft((current) => (checked ? (current.includes(id) ? current : [...current, id]) : current.filter((item) => item !== id)));
  }

  // Selecting the whole filtered list up to the cap; a selection that covers every channel collapses to [] (= all).
  function selectFiltered() {
    setDraft((current) => {
      const next = [...current];
      for (const channel of matches) {
        if (next.length >= maxSelectable) break;
        if (!next.includes(channel.channelId)) next.push(channel.channelId);
      }
      return channels.length && channels.every((channel) => next.includes(channel.channelId)) ? [] : next;
    });
  }

  return (
    <Modal
      open
      size="md"
      title={title}
      onClose={onClose}
      footer={
        <span data-readonly-allow="true" className="flex flex-wrap items-center justify-end gap-3">
          <Button variant="secondary" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button onClick={() => onApply(draft)}>{t("Apply")}</Button>
        </span>
      }
    >
      <div data-readonly-allow="true" className="space-y-3">
        <div className="relative">
          <Search size={15} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
          <TextInput
            id={searchId}
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("Search channels by name or ID…")}
            aria-label={t("Search channels by name or ID…")}
            className="pl-10"
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-bold text-slate-500">
          <span>{draft.length ? t("{count} selected", { count: draft.length }) : t("All channels")}</span>
          <span className="flex flex-wrap items-center gap-1">
            <Button variant="ghost" size="sm" onClick={selectFiltered} disabled={!matches.length || atCap}>
              {t("Select all (filtered)")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setDraft([])} disabled={!draft.length}>
              {t("Clear selection")}
            </Button>
          </span>
        </div>
        {atCap && <p className="text-xs font-bold text-amber-700">{t("Up to {max} channels can be selected", { max: maxSelectable })}</p>}
        {channels.length ? (
          <ul className="max-h-[50vh] divide-y divide-slate-100 overflow-y-auto rounded-2xl border border-slate-200">
            {unknown.map((id) => (
              <ChannelRow key={id} id={id} title={t("Unknown channel")} checked unknown disabled={false} onToggle={toggle} />
            ))}
            {visible.map((channel) => (
              <ChannelRow
                key={channel.channelId}
                id={channel.channelId}
                title={channel.title || channel.channelId}
                thumbnail={channel.thumbnail}
                removed={Boolean(channel.removedAt)}
                checked={draftSet.has(channel.channelId)}
                disabled={!draftSet.has(channel.channelId) && atCap}
                onToggle={toggle}
              />
            ))}
          </ul>
        ) : (
          <EmptyState compact icon={Users} title={t("No channels in the inventory yet")} />
        )}
        {!matches.length && needle && channels.length > 0 && (
          <p className="text-xs font-bold text-slate-500">{t("No channels match “{query}”", { query: query.trim() })}</p>
        )}
        {matches.length > MAX_VISIBLE_CHANNELS && (
          <p className="text-xs font-bold text-slate-500">
            {t("Showing the first {count} of {total} matches — refine the search", { count: MAX_VISIBLE_CHANNELS, total: matches.length })}
          </p>
        )}
      </div>
    </Modal>
  );
}

/**
 * Controlled multi-select over the owner's channel inventory. `value` = [] means "all channels"; the dialog keeps a
 * draft and commits it with Apply, so the filters (and the overview request) change once.
 */
export function ChannelPicker({ channels = [], value = [], onChange, disabled = false, label, maxSelectable = 200, size = "md" }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const selected = useMemo(() => (Array.isArray(value) ? value.filter(Boolean) : []), [value]);
  const byId = useMemo(() => new Map(channels.map((channel) => [channel.channelId, channel])), [channels]);
  const all = selected.length === 0;
  const chips = selected.slice(0, 3).map((id) => ({ id, name: byId.get(id)?.title || t("Unknown channel") }));
  const summary = all ? t("All channels ({count})", { count: channels.length }) : t("{count} channels", { count: selected.length });
  const triggerLabel = label || t("Select channels");

  return (
    <>
      <span data-readonly-allow="true" className="inline-flex min-w-0 max-w-full">
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={triggerLabel}
          title={triggerLabel}
          className={cx(TRIGGER_CLASS, size === "sm" ? "h-9 rounded-xl px-2.5 text-xs" : "h-11 rounded-2xl px-4 text-sm")}
        >
          <Users size={size === "sm" ? 14 : 16} className="shrink-0 text-slate-400" aria-hidden="true" />
          <span className="truncate">{summary}</span>
          {!all && (
            <span className="hidden min-w-0 items-center gap-1 sm:inline-flex">
              {chips.map((chip) => (
                <span key={chip.id} title={chip.id} className="max-w-[8.5rem] truncate rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-black text-blue-700">
                  {chip.name}
                </span>
              ))}
              {selected.length > 3 && <span className="text-[11px] font-black text-slate-400">+{selected.length - 3}</span>}
            </span>
          )}
          <ChevronDown size={14} className="shrink-0 text-slate-400" aria-hidden="true" />
        </button>
      </span>
      {open && (
        <ChannelPickerDialog
          channels={channels}
          byId={byId}
          selected={selected}
          maxSelectable={maxSelectable}
          title={triggerLabel}
          onClose={() => setOpen(false)}
          onApply={(next) => {
            setOpen(false);
            onChange?.(next);
          }}
        />
      )}
    </>
  );
}

// `presets` items are DATE_PRESETS entries ({ key, label }), bare keys, or { key, label, startDate, endDate } for a
// fixed range; every other key resolves through presetRange with the same context as the shell's detectPreset.
function presetRows(presets, ctx) {
  const source = Array.isArray(presets) && presets.length ? presets : DATE_PRESETS;
  const rows = source
    .map((item) => {
      const preset = typeof item === "string" ? { key: item } : item || {};
      const key = String(preset.key ?? "");
      const label = preset.label || DATE_PRESETS.find((candidate) => candidate.key === key)?.label || key;
      const range =
        key === "custom" ? null : isValidDay(preset.startDate) && isValidDay(preset.endDate) ? { startDate: preset.startDate, endDate: preset.endDate } : presetRange(key, ctx);
      return { key, label, range };
    })
    .filter((row) => row.key && (row.key === "custom" || row.range));
  if (!rows.some((row) => row.key === "custom")) rows.push({ key: "custom", label: DATE_PRESETS.find((candidate) => candidate.key === "custom")?.label || "custom", range: null });
  return rows;
}

function validateRange(start, end, latestAllowedDay, t, formatDate) {
  if (!isValidDay(start) || !isValidDay(end)) return t("Enter both dates as YYYY-MM-DD");
  if (start > end) return t("The start date must be on or before the end date");
  if (dayDiff(start, end) + 1 > MAX_RANGE_DAYS) return t("The range cannot exceed {max} days", { max: MAX_RANGE_DAYS });
  if (isValidDay(latestAllowedDay) && end > latestAllowedDay) return t("The end date cannot be after {date}", { date: formatDate(latestAllowedDay) });
  return "";
}

// Remounted (key) whenever the committed range changes, so the draft never fights the URL.
function CustomRangeForm({ startDate, endDate, latestAllowedDay, onApply }) {
  const { t, formatDate } = useI18n();
  const [draft, setDraft] = useState({ startDate, endDate });
  const [touched, setTouched] = useState(false);
  const startId = useId();
  const endId = useId();
  const error = validateRange(draft.startDate, draft.endDate, latestAllowedDay, t, formatDate);
  const changed = draft.startDate !== startDate || draft.endDate !== endDate;

  function update(field, value) {
    setTouched(true);
    setDraft((current) => ({ ...current, [field]: value }));
  }

  return (
    <form
      className="mt-2 border-t border-slate-100 px-2 pb-1 pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        setTouched(true);
        if (!error) onApply({ startDate: draft.startDate, endDate: draft.endDate });
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor={startId} className="text-[11px] font-black uppercase tracking-wide text-slate-400">
            {t("From")}
          </label>
          <TextInput id={startId} type="date" compact min={EARLIEST_DAY} max={latestAllowedDay || undefined} value={draft.startDate} onChange={(event) => update("startDate", event.target.value)} className="mt-1" />
        </div>
        <div>
          <label htmlFor={endId} className="text-[11px] font-black uppercase tracking-wide text-slate-400">
            {t("To")}
          </label>
          <TextInput id={endId} type="date" compact min={EARLIEST_DAY} max={latestAllowedDay || undefined} value={draft.endDate} onChange={(event) => update("endDate", event.target.value)} className="mt-1" />
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <p className={cx("min-w-0 text-[11px] font-bold", touched && error ? "text-red-600" : "text-slate-400")}>{touched && error ? error : t("Custom")}</p>
        <Button type="submit" size="sm" variant="secondary" disabled={Boolean(error) || !changed}>
          {t("Apply")}
        </Button>
      </div>
    </form>
  );
}

/**
 * Preset rows (7 / 28 / 90 days, this month, last month, last 12 months) end at `latestDay` when the owner has
 * stored data, else at `latestAllowedDay − lagDays`; the custom range commits only when valid. `inline` renders the
 * preset list and the custom form in place (no trigger, no popover) for the Filters modal and the Sync dialog, whose
 * scroll containers would clip a popover.
 */
export function DateRangeControl({ value, onChange, latestDay, latestAllowedDay, lagDays = 3, presets, disabled = false, inline = false }) {
  const { t, formatDate } = useI18n();
  const { open, setOpen, rootRef, triggerRef } = usePopover();
  const panelRef = useRef(null);
  const panelId = useId();
  const ctx = useMemo(() => ({ latestDay, latestAllowedDay, lagDays }), [latestDay, latestAllowedDay, lagDays]);
  // The day every preset ends on, exactly as the shell's detectPreset resolves it.
  const anchor = presetRange("1", ctx)?.endDate || null;
  const rows = useMemo(() => presetRows(presets, ctx), [presets, ctx]);
  const startDate = value?.startDate || "";
  const endDate = value?.endDate || "";
  const activeKey = rows.find((row) => row.range && row.range.startDate === startDate && row.range.endDate === endDate)?.key || "custom";
  const activeLabel = rows.find((row) => row.key === activeKey)?.label || "";
  const rangeText = isValidDay(startDate) && isValidDay(endDate) ? `${formatDate(startDate)} – ${formatDate(endDate)}` : t("Date range");
  const showPanel = inline || open;

  useEffect(() => {
    if (open && !inline) panelRef.current?.querySelector('[role="option"][aria-selected="true"], [role="option"]')?.focus();
  }, [open, inline]);

  function close() {
    if (inline) return;
    setOpen(false);
    triggerRef.current?.focus();
  }

  function pick(row) {
    if (row.key === "custom" || !row.range) {
      panelRef.current?.querySelector('input[type="date"]')?.focus();
      return;
    }
    close();
    if (row.range.startDate !== startDate || row.range.endDate !== endDate) onChange?.({ ...row.range });
  }

  const panel = showPanel && (
    <div
      ref={panelRef}
      id={panelId}
      role={inline ? "group" : "dialog"}
      aria-label={t("Date range")}
      className={cx(
        "rounded-2xl border border-slate-200 bg-white p-2",
        inline ? "w-full" : "absolute left-0 top-full z-40 mt-2 w-80 max-w-[calc(100vw-2rem)] shadow-xl",
        inline && disabled && "pointer-events-none opacity-60"
      )}
    >
      <div role="listbox" aria-label={t("Date range")} onKeyDown={(event) => handleListKeys(event, '[role="option"]')}>
        {rows.map((row) => {
          const isActive = row.key === activeKey;
          const unavailable = row.key !== "custom" && !row.range;
          return (
            <button
              key={row.key}
              type="button"
              role="option"
              aria-selected={isActive}
              disabled={unavailable || (inline && disabled)}
              onClick={() => pick(row)}
              className={cx(
                "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm font-bold transition focus:outline-none focus-visible:bg-blue-50",
                isActive ? "text-blue-700" : "text-slate-700 hover:bg-slate-50",
                unavailable && "cursor-not-allowed opacity-50"
              )}
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center">{isActive && <Check size={16} strokeWidth={3} aria-hidden="true" />}</span>
              <span className="min-w-0 flex-1 truncate">{t(row.label)}</span>
              {row.range && (
                <span className="shrink-0 text-[11px] font-medium text-slate-400">
                  {formatDate(row.range.startDate)} – {formatDate(row.range.endDate)}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {anchor && <p className="px-3 pt-1 text-[11px] font-bold text-slate-400">{t("Latest data: {date}", { date: formatDate(anchor) })}</p>}
      <CustomRangeForm
        key={`${startDate}:${endDate}`}
        startDate={startDate}
        endDate={endDate}
        latestAllowedDay={latestAllowedDay}
        onApply={(range) => {
          close();
          onChange?.(range);
        }}
      />
    </div>
  );

  if (inline) {
    return (
      <div data-readonly-allow="true" className="min-w-0 w-full">
        <p className="mb-1.5 flex items-center gap-2 text-xs font-bold text-slate-600">
          <CalendarDays size={14} className="shrink-0 text-slate-400" aria-hidden="true" />
          <span className="truncate">{rangeText}</span>
          <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-black text-slate-500">{t(activeLabel)}</span>
        </p>
        {panel}
      </div>
    );
  }

  return (
    <div ref={rootRef} data-readonly-allow="true" className="relative inline-flex min-w-0 max-w-full">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((current) => !current)}
        className={cx(TRIGGER_CLASS, "h-11 rounded-2xl px-4 text-sm")}
      >
        <CalendarDays size={16} className="shrink-0 text-slate-400" aria-hidden="true" />
        <span className="truncate">{rangeText}</span>
        <span className="hidden shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-black text-slate-500 sm:inline">{t(activeLabel)}</span>
        <ChevronDown size={14} className="shrink-0 text-slate-400" aria-hidden="true" />
      </button>
      {panel}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tiles, coverage, sync status, export
// ---------------------------------------------------------------------------

/** `value` is display-ready; `change` is a percent (12.5 = +12.5 %) or null; `invert` makes a decrease the good direction. */
export function KpiTile({ label, value, change = null, invert = false, hint, tone = "slate", icon: Icon, loading = false, monetary = false }) {
  const { t, formatNumber } = useI18n();
  const delta = change === null || change === undefined || change === "" || !Number.isFinite(Number(change)) ? null : Number(change);
  const direction = delta === null ? null : delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  const good = direction === "up" ? !invert : direction === "down" ? invert : null;
  const DeltaIcon = direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : Minus;
  return (
    <div className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4" aria-busy={loading || undefined}>
      <div className="flex items-start justify-between gap-2">
        <p className="line-clamp-2 min-w-0 text-xs font-black uppercase tracking-wide text-slate-400" title={typeof label === "string" ? label : undefined}>
          {label}
          {monetary && <span className="ml-1.5 rounded-md bg-amber-50 px-1 py-0.5 text-[10px] normal-case tracking-normal text-amber-700">USD</span>}
        </p>
        {Icon && (
          <span className={cx("shrink-0 rounded-xl p-1.5", SOFT_TONES[tone] || SOFT_TONES.slate)}>
            <Icon size={15} aria-hidden="true" />
          </span>
        )}
      </div>
      {/* Phone widths: a smaller size and wrapping keep the whole formatted amount ("12.369,48 US$") visible. */}
      <p className="mt-1 break-words text-lg font-black leading-tight text-slate-950 sm:text-2xl" title={!loading && typeof value === "string" ? value : undefined}>{loading ? <span className="inline-block h-7 w-24 animate-pulse rounded-lg bg-slate-400/30 align-middle" /> : value ?? "—"}</p>
      <div className="mt-1 flex min-h-4 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
        {direction && !loading && (
          <span
            title={t("vs previous range")}
            className={cx("inline-flex items-center gap-0.5 font-black", good === true ? "text-emerald-700" : good === false ? "text-red-600" : "text-slate-500")}
          >
            <DeltaIcon size={13} aria-hidden="true" />
            {formatNumber(delta, { signDisplay: "exceptZero", maximumFractionDigits: 1 })}%
          </span>
        )}
        {hint && <span className="line-clamp-2 min-w-0 text-slate-400" title={typeof hint === "string" ? hint : undefined}>{hint}</span>}
      </div>
    </div>
  );
}

/**
 * One line about the stored days of the current range: "{covered}/{total} days stored · last sync … · n days drifted ·
 * data stops at … — n newer days not yet synced", with "Fill missing days" for sync roles. `coverage` is the overview
 * coverage object; `staleDays` falls back to latestAllowedDay − lagDays − lastDay when the server omits it.
 */
export function CoverageStrip({ coverage, latestAllowedDay, lagDays = 3, onFill, canSync = false, loading = false }) {
  const { t, language, formatDate } = useI18n();
  const days = Array.isArray(coverage?.days) ? coverage.days : [];
  const missing = toCount(coverage?.missing);
  const pending = toCount(coverage?.pending);
  const covered = Number.isFinite(Number(coverage?.covered)) && coverage?.covered !== null ? Number(coverage.covered) : days.filter((day) => day?.facts).length;
  const total = days.length || covered + missing + pending;
  const drifted = toCount(coverage?.driftDays);
  const lastDay = isValidDay(coverage?.lastDay) ? coverage.lastDay : null;
  const target = isValidDay(latestAllowedDay) ? addDays(latestAllowedDay, -Math.max(0, Number(lagDays) || 0)) : null;
  const staleDays = Number.isFinite(Number(coverage?.staleDays)) && coverage?.staleDays !== null ? Math.max(0, Number(coverage.staleDays)) : lastDay && target ? Math.max(0, dayDiff(lastDay, target)) : 0;
  const status = coverage?.status || (!total || !covered ? "empty" : missing || pending ? "partial" : "complete");
  const tone = (STATUS_META && STATUS_META[status]?.tone) || "slate";
  const percent = total ? Math.round((covered / total) * 100) : 0;
  const storedText = total ? t("{covered}/{total} days stored", { covered, total }) : t("No days stored yet");
  const parts = [storedText];
  if (coverage?.lastSyncedAt) parts.push(t("last sync {instant}", { instant: formatScheduleDate(coverage.lastSyncedAt, language) }));
  if (drifted) parts.push(t("{count} days drifted", { count: drifted }));
  if (lastDay && staleDays > 0) parts.push(t("data stops at {day} — {count} newer days not yet synced", { day: formatDate(lastDay), count: staleDays }));

  return (
    <div className={cx("flex flex-col gap-3 rounded-2xl border bg-white px-4 py-3 md:flex-row md:items-center", LINE_TONES[tone] || LINE_TONES.slate, loading && "opacity-60")} aria-busy={loading || undefined}>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <StatusBadge status={status} />
          <p className="min-w-0 truncate text-sm font-bold text-slate-700" title={parts.join(" · ")}>
            {parts.join(" · ")}
          </p>
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label={storedText}>
          <div className={cx("h-full rounded-full", percent === 100 ? "bg-emerald-600" : "bg-blue-600")} style={{ width: `${percent}%` }} />
        </div>
      </div>
      {canSync && missing > 0 && typeof onFill === "function" && (
        <Button variant="secondary" size="sm" icon={RefreshCw} onClick={() => onFill()} disabled={loading}>
          {t("Fill missing days")}
        </Button>
      )}
    </div>
  );
}

/** Compact live pill for the latest / active job; a plain Link (to the Data & sync view) keeps it usable in Read Only mode. */
export function SyncStatusPill({ job, to }) {
  const { t, language } = useI18n();
  if (!job) return null;
  const status = job.status || "queued";
  const meta = (STATUS_META && STATUS_META[status]) || null;
  const tone = meta?.tone || "slate";
  const active = isActiveJob(status);
  // `progress` is a 0–100 percentage (API contract); completed / total only when the server omits it.
  const rawProgress = Number(job.progress);
  const fraction = Number.isFinite(rawProgress) && rawProgress >= 0 && job.progress !== null && job.progress !== "" ? rawProgress / 100 : Number(job.total) > 0 ? Number(job.completed) / Number(job.total) : 0;
  const percent = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  const text = status === "running" ? t("Syncing {percent}%", { percent }) : meta?.label ? t(meta.label) : String(status);
  const when = job.finishedAt || job.startedAt || job.createdAt;
  const content = (
    <>
      <span className="truncate">{text}</span>
      {!active && when && <span className="hidden truncate font-medium opacity-70 sm:inline">{formatScheduleDate(when, language)}</span>}
    </>
  );
  return (
    <span data-readonly-allow="true" role="status" className={cx("inline-flex max-w-full items-center gap-2 rounded-full border px-3 py-1 text-xs font-black", LINE_TONES[tone] || LINE_TONES.slate, SOFT_TONES[tone] || SOFT_TONES.slate)}>
      {active ? <LoaderCircle size={13} className="shrink-0 animate-spin" aria-hidden="true" /> : <span className={cx("h-2 w-2 shrink-0 rounded-full", DOT_TONES[tone] || DOT_TONES.slate)} aria-hidden="true" />}
      {to ? (
        <Link to={to} className="inline-flex min-w-0 items-center gap-2 hover:underline">
          {content}
        </Link>
      ) : (
        <span className="inline-flex min-w-0 items-center gap-2">{content}</span>
      )}
    </span>
  );
}

/** `options` labels are display-ready; `busy` is the key of the option being exported (or any truthy value). */
export function ExportMenu({ options = [], onSelect, busy = "" }) {
  const { t } = useI18n();
  const { open, setOpen, rootRef, triggerRef } = usePopover();
  const panelRef = useRef(null);
  const menuId = useId();
  const items = options.filter((option) => option && option.key);
  const isBusy = Boolean(busy);

  useEffect(() => {
    if (open) panelRef.current?.querySelector('[role="menuitem"]:not([disabled])')?.focus();
  }, [open]);

  function choose(option) {
    setOpen(false);
    triggerRef.current?.focus();
    onSelect?.(option);
  }

  return (
    <div ref={rootRef} data-readonly-allow="true" className="relative inline-flex">
      <Button
        ref={triggerRef}
        variant="secondary"
        size="sm"
        icon={Download}
        loading={isBusy}
        disabled={!items.length}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        {isBusy ? t("Exporting…") : t("Export")}
        <ChevronDown size={14} className={cx("transition", open && "rotate-180")} aria-hidden="true" />
      </Button>
      {open && (
        <div
          ref={panelRef}
          id={menuId}
          role="menu"
          aria-label={t("Export options")}
          onKeyDown={(event) => handleListKeys(event, '[role="menuitem"]')}
          className="absolute right-0 top-full z-40 mt-2 w-64 max-w-[calc(100vw-2rem)] rounded-2xl border border-slate-200 bg-white p-1.5 shadow-xl"
        >
          {items.map((option) => {
            const FormatIcon = option.format === "xlsx" ? FileSpreadsheet : FileText;
            return (
              <button
                key={option.key}
                type="button"
                role="menuitem"
                disabled={isBusy}
                onClick={() => choose(option)}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm font-bold text-slate-700 transition hover:bg-slate-50 focus:outline-none focus-visible:bg-blue-50 focus-visible:text-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy === option.key ? <LoaderCircle size={15} className="shrink-0 animate-spin" aria-hidden="true" /> : <FormatIcon size={15} className="shrink-0 text-slate-400" aria-hidden="true" />}
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                <span className="shrink-0 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-black uppercase text-slate-500">{String(option.format || "csv")}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/**
 * Sortable, clickable metric table. `columns[].format(value, row)` renders a cell, `sort` = { key, direction } is
 * controlled through `onSort`; while `loading` with rows the previous rows stay at reduced opacity (no layout jump).
 */
export function MetricTable({ columns = [], rows = [], rowKey = "id", sort, onSort, onRowClick, loading = false, empty, footer }) {
  const { t } = useI18n();
  const clickable = typeof onRowClick === "function";
  const showSkeleton = loading && !rows.length;
  const showEmpty = !loading && !rows.length;
  const keyOf = (row, index) => (typeof rowKey === "function" ? rowKey(row, index) : row?.[rowKey] ?? index);

  function requestSort(column) {
    if (!onSort || !column.sortable) return;
    onSort({ key: column.key, direction: sort?.key === column.key && sort?.direction === "desc" ? "asc" : "desc" });
  }

  return (
    <div className="min-w-0">
      <div className="overflow-x-auto">
        {!showEmpty && (
        <table className={cx("w-full min-w-[640px] border-collapse text-sm", loading && rows.length > 0 && "opacity-60")} aria-busy={loading || undefined}>
          <thead>
            <tr className="border-b border-slate-200 text-[11px] font-black uppercase tracking-wide text-slate-400">
              {columns.map((column) => {
                const isActive = sort?.key === column.key;
                const SortIcon = isActive ? (sort.direction === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    style={column.width ? { width: column.width, minWidth: column.width } : undefined}
                    aria-sort={isActive ? (sort.direction === "asc" ? "ascending" : "descending") : undefined}
                    className={cx("px-3 py-2.5 font-black", ALIGN[column.align] || ALIGN.left)}
                  >
                    {column.sortable && onSort ? (
                      <button
                        type="button"
                        onClick={() => requestSort(column)}
                        className={cx("inline-flex items-center gap-1 rounded-md uppercase transition hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-200", isActive && "text-slate-800")}
                      >
                        {column.label}
                        <SortIcon size={12} aria-hidden="true" />
                      </button>
                    ) : (
                      column.label
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {showSkeleton &&
              SKELETON_ROWS.map((row) => (
                <tr key={row}>
                  {columns.map((column) => (
                    <td key={column.key} className="px-3 py-3">
                      <span className="block h-3.5 w-full animate-pulse rounded bg-slate-400/30" />
                    </td>
                  ))}
                </tr>
              ))}
            {!showSkeleton &&
              rows.map((row, index) => (
                <tr
                  key={keyOf(row, index)}
                  tabIndex={clickable ? 0 : undefined}
                  onClick={clickable ? () => onRowClick(row) : undefined}
                  onKeyDown={
                    clickable
                      ? (event) => {
                          if (event.key !== "Enter" && event.key !== " ") return;
                          event.preventDefault();
                          onRowClick(row);
                        }
                      : undefined
                  }
                  className={cx("text-slate-700", clickable && "cursor-pointer transition hover:bg-slate-50 focus:outline-none focus-visible:bg-blue-50")}
                >
                  {columns.map((column) => {
                    const raw = row?.[column.key];
                    return (
                      <td key={column.key} className={cx("px-3 py-2.5 align-middle", ALIGN[column.align] || ALIGN.left, column.align === "right" && "tabular-nums")}>
                        {column.format ? column.format(raw, row) : raw ?? "—"}
                      </td>
                    );
                  })}
                </tr>
              ))}
          </tbody>
        </table>
        )}
        {showEmpty && (typeof empty === "string" || empty === undefined || empty === null ? <EmptyState compact title={empty || t("No stored data for this range")} /> : empty)}
      </div>
      {footer}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Daily sync status line
// ---------------------------------------------------------------------------

/**
 * Morning status of the scheduled run: one action per state — failed / not-run → "Run the daily sync now" (canSync),
 * partial / completed → "View job" link to the Data & sync view (filters kept), running → live badge.
 */
export function DailyRunLine({ dailyRun, onRunNow, canSync = false }) {
  const { isSidebarVisible } = useSystemSettings();
  const { t, tm, language } = useI18n();
  const location = useLocation();
  if (!dailyRun) return null;
  const status = dailyRun.status || "not-run";
  const tone = (STATUS_META && STATUS_META[status]?.tone) || "slate";
  const counts = dailyRun.counts || {};
  const details = [];
  if (status === "completed" || status === "partial") {
    if (dailyRun.finishedAt) details.push(t("Finished {instant}", { instant: formatScheduleDate(dailyRun.finishedAt, language) }));
    // `days` carries real day totals (addedCount / driftedCount); `counts` are fact + breakdown row counters, so
    // without `days` the sentence speaks of rows, never of days.
    if (dailyRun.days && typeof dailyRun.days === "object") {
      details.push(t("Added {days} · {drift} days drifted", { days: countDays(dailyRun.days, "added"), drift: countDays(dailyRun.days, "drifted") }));
    } else if (counts.inserted !== undefined || counts.drift !== undefined) {
      details.push(t("{inserted} rows added · {drift} rows drifted", { inserted: toCount(counts.inserted), drift: toCount(counts.drift) }));
    }
  } else if (dailyRun.scheduledFor) {
    details.push(t("Scheduled for {instant}", { instant: formatScheduleDate(dailyRun.scheduledFor, language) }));
  }
  if (status === "not-run" && !dailyRun.jobId) details.push(t("The scheduled run has not started"));
  const failures = toCount(dailyRun.consecutiveFailures);
  const error = typeof dailyRun.firstError === "string" ? dailyRun.firstError : dailyRun.firstError?.message || "";
  const showRun = canSync && typeof onRunNow === "function" && (status === "failed" || status === "not-run");
  const jobLink = isSidebarVisible("/analytic/sync") && dailyRun.jobId && status !== "running" ? { pathname: "/analytic/sync", search: location.search } : null;

  return (
    <div className={cx("flex flex-col gap-2 rounded-2xl border bg-white px-4 py-3 md:flex-row md:items-center", LINE_TONES[tone] || LINE_TONES.slate)}>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="font-black text-slate-800">{t("Daily sync")}</span>
        <StatusBadge status={status} />
        {dailyRun.late && <Badge tone="amber">{t("Late")}</Badge>}
        {failures >= 2 && <Badge tone="red">{t("{count} consecutive failures", { count: failures })}</Badge>}
        {details.length > 0 && <span className="min-w-0 truncate text-slate-500">{details.join(" · ")}</span>}
        {error && (
          <span className="min-w-0 truncate font-bold text-red-600" title={tm(error)}>
            {tm(error)}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {jobLink && (
          <Link to={jobLink} className="text-xs font-black text-blue-700 hover:underline">
            {t("View job")}
          </Link>
        )}
        {showRun && (
          <Button size="sm" icon={Play} onClick={() => onRunNow()}>
            {t("Run the daily sync now")}
          </Button>
        )}
      </div>
    </div>
  );
}
