import { Check, ExternalLink, Loader2, Lock, Users } from "lucide-react";
import { useI18n } from "../../context/I18nContext";
import { CopyButton } from "../assetDelivery/shared";
import { cx, truncate } from "../assetDelivery/utils";
import { RELEASE_OUTCOME_META, TONE_CLASSES } from "./constants";
import { outcomeLabel, statusLabel, statusTone, videoTitle, videoUrl } from "./utils";

// Small presentational pieces shared by the Claim Manager panels. Components only
// (react-refresh): data lives in constants.js, logic in utils.js.

export function ToneBadge({ tone = "slate", icon: Icon, children, title, className }) {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-black uppercase tracking-wide",
        TONE_CLASSES[tone] || TONE_CLASSES.slate,
        className
      )}
    >
      {Icon && <Icon size={11} />}
      {children}
    </span>
  );
}

export function ClaimStatusBadge({ status, title, className }) {
  const { t } = useI18n();
  return (
    <ToneBadge tone={statusTone(status)} title={title} className={className}>
      {t(statusLabel(status))}
    </ToneBadge>
  );
}

export function OutcomeBadge({ outcome, className }) {
  const { t } = useI18n();
  const meta = RELEASE_OUTCOME_META[outcome];
  return (
    <ToneBadge tone={meta?.tone || "slate"} className={className} title={meta?.description ? t(meta.description) : undefined}>
      {t(outcomeLabel(outcome))}
    </ToneBadge>
  );
}

/** Toggle chip (aria-pressed) used for CMS, status and content-type filters. */
export function Chip({ active = false, disabled = false, onClick, children, count, title, tone = "blue", className }) {
  const activeClass = tone === "slate" ? "border-slate-400 bg-slate-100 text-slate-900" : "border-blue-300 bg-blue-50 text-blue-700 shadow-sm";
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cx(
        "inline-flex max-w-full items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-left text-xs font-black transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-200 disabled:cursor-not-allowed disabled:opacity-50",
        active ? activeClass : "border-slate-200 bg-white text-slate-500 hover:border-blue-200 hover:text-slate-900",
        className
      )}
    >
      {active && <Check size={12} className="shrink-0" />}
      <span className="truncate">{children}</span>
      {count !== undefined && count !== null && (
        <span className={cx("rounded-full px-1.5 py-0.5 text-[10px] font-black", active ? "bg-white/70 text-blue-700" : "bg-slate-100 text-slate-500")}>{count}</span>
      )}
    </button>
  );
}

/** Radio-group styled as a segmented control (search mode). */
export function SegmentedControl({ options = [], value, onChange, disabled = false, label, className }) {
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  // A radio group: one tab stop (the selected option), arrows / Home / End move the selection.
  function handleKeyDown(event) {
    if (disabled || !options.length) return;
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    let next;
    if (step) next = (selectedIndex + step + options.length) % options.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = options.length - 1;
    else return;
    event.preventDefault();
    onChange?.(options[next].value);
    event.currentTarget.querySelectorAll('[role="radio"]')[next]?.focus();
  }
  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={handleKeyDown}
      className={cx("grid gap-1 rounded-2xl border border-slate-200 bg-slate-50 p-1", className)}
      style={{ gridTemplateColumns: `repeat(${options.length || 1}, minmax(0, 1fr))` }}
    >
      {options.map((option, index) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={index === selectedIndex ? 0 : -1}
            title={option.title}
            disabled={disabled}
            onClick={() => onChange?.(option.value)}
            className={cx(
              // No truncation: a cut-off option name cannot be read, so the label may wrap instead.
              "min-w-0 rounded-xl px-2 py-2 text-xs font-black leading-tight transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-200 disabled:cursor-not-allowed",
              active ? "bg-white text-blue-700 shadow-sm ring-1 ring-slate-200" : "text-slate-500 hover:text-slate-900"
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** Solid red button for the destructive "Release" actions. */
export function ReleaseButton({ children, icon: Icon, loading = false, size = "md", className, disabled = false, type = "button", ...props }) {
  const iconSize = size === "sm" ? 14 : 17;
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
      className={cx(
        "inline-flex shrink-0 items-center justify-center whitespace-nowrap bg-red-600 font-black text-white shadow-lg shadow-red-900/20 transition hover:bg-red-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-300 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none",
        size === "sm" ? "h-9 gap-1.5 rounded-xl px-3 text-xs" : "h-11 gap-2 rounded-2xl px-5 text-sm",
        className
      )}
    >
      {loading ? <Loader2 size={iconSize} className="animate-spin" /> : Icon ? <Icon size={iconSize} /> : null}
      {children}
    </button>
  );
}

/** Anchor styled like the secondary Button. */
export function LinkButton({ href, children, icon: Icon = ExternalLink, size = "md", className, disabled = false }) {
  const sizing = size === "sm" ? "h-9 gap-1.5 rounded-xl px-3 text-xs" : "h-11 gap-2 rounded-2xl px-4 text-sm";
  if (!href || disabled) {
    return (
      <span className={cx("inline-flex cursor-not-allowed items-center justify-center border border-slate-200 bg-white font-black text-slate-400 opacity-60", sizing, className)}>
        {Icon && <Icon size={size === "sm" ? 14 : 17} />}
        {children}
      </span>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cx(
        "inline-flex items-center justify-center whitespace-nowrap border border-slate-200 bg-white font-black text-slate-700 transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-300",
        sizing,
        className
      )}
    >
      {Icon && <Icon size={size === "sm" ? 14 : 17} />}
      {children}
    </a>
  );
}

/**
 * Monospace identifier with an inline copy button (copies `value`, shows `display` when given);
 * `onClick` turns the id into a button (e.g. open details).
 */
export function MonoId({ value, display, copy = true, onClick, className, title, tone = "text-slate-900" }) {
  const { t } = useI18n();
  const text = value === undefined || value === null ? "" : String(value);
  if (!text) return <span className="text-xs text-slate-400">-</span>;
  const shown = display === undefined || display === null ? text : String(display);
  return (
    <span className={cx("inline-flex max-w-full items-center gap-0.5", className)}>
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          title={title || t("Open details")}
          className={cx("truncate rounded-md font-mono text-xs font-black underline-offset-2 hover:text-blue-700 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-200", tone)}
        >
          {shown}
        </button>
      ) : (
        <span className={cx("truncate font-mono text-xs font-black", tone)} title={title || text}>
          {shown}
        </span>
      )}
      {copy && <CopyButton text={text} iconOnly label={t("Copy {text}", { text })} />}
    </span>
  );
}

export function LabelBadges({ labels, max = 3, className }) {
  const list = Array.isArray(labels) ? labels.filter(Boolean) : [];
  if (!list.length) return null;
  const visible = list.slice(0, max);
  const rest = list.length - visible.length;
  return (
    <span className={cx("inline-flex flex-wrap items-center gap-1", className)} title={list.join(", ")}>
      {visible.map((label) => (
        <span key={label} className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-black text-indigo-700">
          {label}
        </span>
      ))}
      {rest > 0 && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-black text-slate-500">+{rest}</span>}
    </span>
  );
}

/** Thumbnail + title + channel + id for a claim row or a video group. */
export function VideoSummary({ claim, group, size = "sm", className }) {
  const { t, tm } = useI18n();
  const id = group?.video_id || claim?.video_id || "";
  const url = group?.video_url || claim?.video_url || videoUrl(id);
  // tm(): the title is data, except the canonical "Untitled video" fallback of videoTitle() / the group builder.
  const title = tm(group ? group.title : videoTitle(claim));
  const channel = group?.channel_title || claim?.video?.channel_title || "";
  const thumbnail = group?.thumbnail || claim?.video?.thumbnail || "";
  const duration = group?.duration_text || claim?.video?.duration_text || "";
  const large = size === "md";
  return (
    <div className={cx("flex min-w-0 items-start gap-3", className)}>
      {thumbnail ? (
        <a href={url} target="_blank" rel="noreferrer" className={cx("relative shrink-0 overflow-hidden rounded-xl border border-slate-200 bg-slate-100", large ? "h-16 w-28" : "h-11 w-20")} title={t("Watch on YouTube")}>
          <img src={thumbnail} alt="" loading="lazy" className="h-full w-full object-cover" />
          {duration && <span className="absolute bottom-1 right-1 rounded bg-black/80 px-1 py-0.5 text-[10px] font-black text-white">{duration}</span>}
        </a>
      ) : null}
      <div className="min-w-0">
        <a href={url || undefined} target="_blank" rel="noreferrer" className={cx("block truncate font-black text-slate-950 hover:text-blue-700", large ? "max-w-[520px] text-base" : "max-w-[260px] text-sm")} title={title}>
          {title}
        </a>
        {channel && (
          <span className={cx("block truncate text-xs font-bold text-slate-500", large ? "max-w-[520px]" : "max-w-[260px]")} title={channel}>
            {channel}
          </span>
        )}
        <span className="mt-0.5 flex items-center gap-1">
          <MonoId value={id} tone="text-slate-500" />
          {url && (
            <a href={url} target="_blank" rel="noreferrer" aria-label={t("Open on YouTube")} title={t("Open on YouTube")} className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-800">
              <ExternalLink size={13} />
            </a>
          )}
        </span>
      </div>
    </div>
  );
}

/** Asset id + title + ISRC / UPC + labels. */
export function AssetSummary({ claim, className }) {
  const { t } = useI18n();
  const asset = claim?.asset || null;
  const id = claim?.asset_id || asset?.id || "";
  const codes = [asset?.isrc ? t("ISRC {isrc}", { isrc: asset.isrc }) : "", asset?.upc ? t("UPC {upc}", { upc: asset.upc }) : ""].filter(Boolean).join(" · ");
  return (
    <div className={cx("min-w-0", className)}>
      <MonoId value={id} tone="text-slate-800" />
      {asset?.title && (
        <span className="block max-w-[240px] truncate text-xs font-bold text-slate-600" title={asset.title}>
          {truncate(asset.title, 80)}
        </span>
      )}
      {codes && <span className="block font-mono text-[11px] text-slate-500">{codes}</span>}
      <LabelBadges labels={asset?.labels} className="mt-1" />
    </div>
  );
}

/** Definition list used by the detail modal and the release dialog summary; `empty` is the text shown when no item has a value. */
export function KeyValueList({ items = [], columns = 2, empty, className }) {
  const { t } = useI18n();
  const visible = items.filter((item) => item && item.value !== undefined && item.value !== null && item.value !== "");
  if (!visible.length) return <p className="text-sm text-slate-400">{empty === undefined ? t("Nothing to show.") : empty}</p>;
  return (
    <dl className={cx("grid gap-x-4 gap-y-2", columns === 1 ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2", className)}>
      {visible.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-[11px] font-black uppercase tracking-wide text-slate-400">{item.label}</dt>
          <dd className={cx("mt-0.5 break-words text-sm font-bold text-slate-800", item.mono && "font-mono text-xs")}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Section({ title, icon: Icon, actions, children, className }) {
  return (
    <section className={cx("rounded-2xl border border-slate-200 bg-white p-4", className)}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-sm font-black text-slate-950">
          {Icon && <Icon size={15} className="text-slate-400" />}
          {title}
        </h3>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function Kbd({ children }) {
  return <kbd className="rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] font-bold text-slate-500">{children}</kbd>;
}

/**
 * Lock icon with the release block reason (shown next to non-releasable statuses): tooltip for the
 * mouse, visually hidden text for screen readers (an aria-label on a plain span is not announced).
 */
export function BlockedHint({ reason }) {
  const { tm } = useI18n();
  if (!reason) return null;
  return (
    <span title={tm(reason)} className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-slate-100 text-slate-400">
      <Lock size={11} aria-hidden="true" />
      <span className="sr-only">{tm(reason)}</span>
    </span>
  );
}

export function LimitedBadge({ labels = [] }) {
  const { t } = useI18n();
  const list = Array.isArray(labels) ? labels : [];
  return (
    <ToneBadge tone="amber" icon={Users} title={list.length ? t("Allowed asset labels: {labels}", { labels: list.join(", ") }) : t("Your role only sees claims of the asset labels assigned to you")}>
      {list.length ? t("Limited to {labels}", { labels: truncate(list.join(", "), 40) }) : t("Limited to your labels")}
    </ToneBadge>
  );
}
