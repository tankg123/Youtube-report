import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { EmptyState } from "../assetDelivery/shared";
import { cx } from "../assetDelivery/utils";
import { useI18n } from "../../context/I18nContext";
import { tk } from "../../i18n/index.js";
import { addDays, dayDiff, formatMetric, isValidDay, metricLabel } from "./analyticsUtils";

// Hand-rolled SVG charts (no chart library): colours come from the CSS variables of analytics.css (light and
// .theme-dark), marks follow the dataviz specs (2px lines, washed areas, surface-ringed markers, hairline grid) and
// every chart has a non-visual twin: the "View data" table under the trend, the legend list beside the donut, the
// visible values of the bar list and the per-day aria-labels of the calendar. One tab stop per chart.

const SERIES = Array.from({ length: 8 }, (_, index) => `var(--an-series-${index + 1})`);
const OTHER_COLOR = "var(--an-previous)";
const MAX_SEGMENTS = 6;
const ALIGN = { left: "text-left", right: "text-right", center: "text-center" };
const STATE_CLASS = { covered: "an-cov-covered", drift: "an-cov-drift", missing: "an-cov-missing", pending: "an-cov-pending" };
const STATE_LABEL = { covered: tk("Stored"), drift: tk("Drift"), missing: tk("Missing"), pending: tk("Not yet published") };
const WEEK_ANCHOR = Date.UTC(2024, 0, 1); // a Monday: weekday headers are formatted from it

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// Consecutive non-null index runs: a null is a gap, never a zero.
function runs(values) {
  const out = [];
  let current = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (current.length) out.push(current);
      current = [];
    } else {
      current.push(index);
    }
  });
  if (current.length) out.push(current);
  return out;
}

function niceStep(span, count) {
  const raw = span / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / magnitude;
  const factor = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10;
  return factor * magnitude;
}

// Round ticks covering [min(0, min), max]; the domain is the tick span so the top line is always a label.
function buildTicks(min, max, count = 4) {
  const low = Math.min(0, min);
  const high = max > low ? max : low + 1;
  const step = niceStep(high - low, count);
  const start = Math.floor(low / step) * step;
  const steps = Math.ceil((high - start) / step - 1e-9);
  const ticks = Array.from({ length: steps + 1 }, (_, index) => Number((start + index * step).toPrecision(12)));
  return { ticks, min: start, max: ticks[ticks.length - 1] };
}

function monthStart(day) {
  return `${day.slice(0, 7)}-01`;
}

// Measured through a callback ref so a chart that first rendered empty still gets observed later.
function useElementWidth(element) {
  const [width, setWidth] = useState(() => (typeof ResizeObserver === "undefined" ? 640 : 0));
  useEffect(() => {
    if (!element || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect?.width ?? element.clientWidth);
      setWidth((current) => (current === next ? current : next));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return width;
}

// ---------------------------------------------------------------------------
// Data table twin
// ---------------------------------------------------------------------------

/** Collapsed "View data" table: `columns[].format(value, row)`, `rows[].key` optional. */
export function ChartDataTable({ caption, columns = [], rows = [] }) {
  const { t } = useI18n();
  if (!columns.length || !rows.length) return null;
  return (
    <details className="group mt-3 rounded-2xl border border-slate-200 bg-white">
      <summary className="flex cursor-pointer select-none list-none items-center justify-between gap-2 px-4 py-2 text-[11px] font-black uppercase tracking-wide text-slate-500 [&::-webkit-details-marker]:hidden">
        {t("View data")}
        <ChevronDown size={14} className="transition group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="max-h-72 overflow-auto border-t border-slate-100">
        <table className="w-full min-w-[420px] border-collapse text-xs">
          <caption className="sr-only">{caption}</caption>
          <thead className="sticky top-0 bg-white text-[10px] font-black uppercase tracking-wide text-slate-400">
            <tr>
              {columns.map((column) => (
                <th key={column.key} scope="col" className={cx("px-3 py-2", ALIGN[column.align] || ALIGN.left)}>
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row, index) => (
              <tr key={row.key ?? index}>
                {columns.map((column) => {
                  const raw = row?.[column.key];
                  return (
                    <td key={column.key} className={cx("px-3 py-1.5 text-slate-700", ALIGN[column.align] || ALIGN.left, column.align === "right" && "tabular-nums")}>
                      {column.format ? column.format(raw, row) : raw ?? "—"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Trend
// ---------------------------------------------------------------------------

/**
 * Daily line / area of one metric over `series` ([{ day, metrics|null, covered }]); `previousSeries` is aligned by
 * index and drawn dashed when `compare`. Null = gap. Pointer and keyboard (Arrow / Home / End) share one marker,
 * one tooltip and one aria-live announcement; the "View data" table is the non-visual twin.
 */
export function TrendChart({ series = [], previousSeries = [], metric = "views", kind = "area", compare = false, height = 260, title, formatValue }) {
  const { t, language, formatDate } = useI18n();
  const [element, setElement] = useState(null);
  const width = useElementWidth(element);
  const [active, setActive] = useState(null);
  const liveId = useId();
  const hintId = useId();
  const points = useMemo(
    () => (Array.isArray(series) ? series : []).map((row) => ({ day: row?.day || "", value: finite(row?.metrics?.[metric]), covered: row?.covered !== false })),
    [series, metric]
  );
  const previous = useMemo(
    () => (compare && Array.isArray(previousSeries) ? previousSeries : []).map((row) => ({ day: row?.day || "", value: finite(row?.metrics?.[metric]) })),
    [compare, previousSeries, metric]
  );
  const label = title || t(metricLabel(metric));
  const count = points.length;
  const values = points.map((point) => point.value);
  const previousValues = points.map((_, index) => previous[index]?.value ?? null);
  const numeric = [...values, ...previousValues].filter((value) => value !== null);
  const hasPrevious = compare && previousValues.some((value) => value !== null);
  const format = (value, compact = false) => (value === null ? "—" : formatValue ? formatValue(value) : formatMetric(value, metric, { language, compact }));

  if (!count || !numeric.length) return <EmptyState compact title={t("No stored data for this range")} />;

  const { ticks, min: domainMin, max: domainMax } = buildTicks(Math.min(...numeric), Math.max(...numeric));
  const tickLabels = ticks.map((tick) => format(tick, true));
  const marginLeft = Math.min(96, Math.max(36, Math.max(...tickLabels.map((text) => String(text).length)) * 6.5 + 10));
  const plot = { left: marginLeft, right: Math.max(marginLeft + 10, width - 12), top: 12, bottom: height - 28 };
  const xAt = (index) => (count > 1 ? plot.left + (index / (count - 1)) * (plot.right - plot.left) : (plot.left + plot.right) / 2);
  const yAt = (value) => plot.bottom - ((value - domainMin) / (domainMax - domainMin || 1)) * (plot.bottom - plot.top);
  const baseline = yAt(Math.min(Math.max(0, domainMin), domainMax));
  const currentRuns = runs(values);
  const previousRuns = runs(previousValues);
  const lineFor = (list, source) =>
    list
      .filter((run) => run.length > 1)
      .map((run) => run.map((index, position) => `${position ? "L" : "M"}${xAt(index).toFixed(1)} ${yAt(source[index]).toFixed(1)}`).join(" "))
      .join(" ");
  const areaFor = (list) =>
    list
      .filter((run) => run.length > 1)
      .map((run) => `M${xAt(run[0]).toFixed(1)} ${baseline.toFixed(1)} ${run.map((index) => `L${xAt(index).toFixed(1)} ${yAt(values[index]).toFixed(1)}`).join(" ")} L${xAt(run[run.length - 1]).toFixed(1)} ${baseline.toFixed(1)} Z`)
      .join(" ");
  const isolated = currentRuns.filter((run) => run.length === 1).map((run) => run[0]);
  const xTickCount = Math.max(2, Math.min(count, Math.floor((plot.right - plot.left) / 80) + 1));
  const xTicks = count === 1 ? [0] : [...new Set(Array.from({ length: xTickCount }, (_, index) => Math.round((index * (count - 1)) / (xTickCount - 1))))];
  const shortDay = (day) => (day ? formatDate(day, { day: "2-digit", month: "2-digit" }) : "");
  const activeIndex = active && active.index < count ? active.index : null;
  const activePoint = activeIndex === null ? null : points[activeIndex];
  const activeValue = activeIndex === null ? null : values[activeIndex];
  const activePrevious = activeIndex === null ? null : previousValues[activeIndex];
  const activeText = activePoint ? (activeValue === null ? (activePoint.covered ? t("No data") : t("Not stored")) : format(activeValue)) : "";
  const announcement = activePoint
    ? [`${formatDate(activePoint.day)}: ${label} ${activeText}`, hasPrevious ? `${t("Previous range")} ${format(activePrevious)}` : ""].filter(Boolean).join(" · ")
    : "";
  const summary = t("{title}, {count} days from {start} to {end}", { title: label, count, start: formatDate(points[0].day), end: formatDate(points[count - 1].day) });
  const tipX = activeIndex === null ? 0 : Math.max(72, Math.min(width - 72, xAt(activeIndex)));
  const tipY = activeIndex === null ? 0 : yAt(activeValue ?? activePrevious ?? domainMax);
  const tableColumns = [
    { key: "day", label: t("Day"), format: (value) => formatDate(value) },
    { key: "value", label, align: "right", format: (value) => format(value) },
    ...(hasPrevious ? [{ key: "previous", label: t("Previous range"), align: "right", format: (value) => format(value) }] : [])
  ];
  const tableRows = points.map((point, index) => ({ key: point.day || index, day: point.day, value: point.value, previous: previousValues[index] }));

  function indexAt(clientX, target) {
    if (count < 2) return 0;
    const px = clientX - target.getBoundingClientRect().left;
    return Math.max(0, Math.min(count - 1, Math.round((px - plot.left) / ((plot.right - plot.left) / (count - 1)))));
  }

  function handleKey(event) {
    const deltas = { ArrowRight: 1, ArrowLeft: -1 };
    if (!Object.hasOwn(deltas, event.key) && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    setActive((current) => {
      const base = current ? current.index : count - 1;
      const next = event.key === "Home" ? 0 : event.key === "End" ? count - 1 : Math.max(0, Math.min(count - 1, base + deltas[event.key]));
      return { index: next, keyboard: true };
    });
  }

  return (
    <figure className="min-w-0">
      {(title || hasPrevious) && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          {title ? <figcaption className="text-xs font-black uppercase tracking-wide text-slate-400">{title}</figcaption> : <span />}
          {hasPrevious && (
            <ul className="flex items-center gap-4 text-[11px] font-bold text-slate-500">
              <li className="inline-flex items-center gap-1.5">
                <span className="h-0.5 w-4 rounded-full" style={{ background: SERIES[0] }} aria-hidden="true" />
                {t("Current range")}
              </li>
              <li className="inline-flex items-center gap-1.5">
                <span className="w-4 border-t-2 border-dashed" style={{ borderColor: "var(--an-previous)" }} aria-hidden="true" />
                {t("Previous range")}
              </li>
            </ul>
          )}
        </div>
      )}
      <div ref={setElement} className="relative" style={{ minHeight: height }}>
        {width > 0 && (
          <>
            <svg
              className="an-chart"
              width={width}
              height={height}
              viewBox={`0 0 ${width} ${height}`}
              role="img"
              aria-label={summary}
              aria-describedby={hintId}
              tabIndex={0}
              onPointerMove={(event) => setActive({ index: indexAt(event.clientX, event.currentTarget), keyboard: false })}
              onPointerLeave={() => setActive((current) => (current?.keyboard ? current : null))}
              onKeyDown={handleKey}
              onFocus={() => setActive((current) => current ?? { index: count - 1, keyboard: true })}
              onBlur={() => setActive(null)}
            >
              {ticks.map((tick, index) => (
                <g key={tick}>
                  <line className={tick === 0 ? "an-axis" : "an-grid"} x1={plot.left} x2={plot.right} y1={yAt(tick)} y2={yAt(tick)} />
                  <text x={plot.left - 8} y={yAt(tick) + 4} textAnchor="end">
                    {tickLabels[index]}
                  </text>
                </g>
              ))}
              {kind === "area" && <path className="an-area" d={areaFor(currentRuns)} style={{ fill: SERIES[0] }} />}
              {hasPrevious && <path className="an-line an-line-previous" d={lineFor(previousRuns, previousValues)} />}
              <path className="an-line" d={lineFor(currentRuns, values)} style={{ stroke: SERIES[0] }} />
              {isolated.map((index) => (
                <circle key={index} className="an-marker" cx={xAt(index)} cy={yAt(values[index])} r={4} style={{ fill: SERIES[0] }} />
              ))}
              {xTicks.map((index) => (
                <text key={index} x={xAt(index)} y={height - 8} textAnchor={count > 1 && index === 0 ? "start" : count > 1 && index === count - 1 ? "end" : "middle"}>
                  {shortDay(points[index].day)}
                </text>
              ))}
              {activeIndex !== null && (
                <g pointerEvents="none">
                  <line className="an-crosshair" x1={xAt(activeIndex)} x2={xAt(activeIndex)} y1={plot.top} y2={plot.bottom} />
                  {activeValue !== null && <circle className="an-marker" cx={xAt(activeIndex)} cy={yAt(activeValue)} r={5} style={{ fill: SERIES[0] }} />}
                  {hasPrevious && activePrevious !== null && <circle className="an-marker" cx={xAt(activeIndex)} cy={yAt(activePrevious)} r={4} style={{ fill: "var(--an-previous)" }} />}
                </g>
              )}
            </svg>
            {activePoint && (
              <div
                className="pointer-events-none absolute z-10 w-max max-w-[16rem] rounded-xl bg-slate-950 px-3 py-2 text-xs text-white shadow-xl"
                style={{ left: tipX, top: Math.max(0, tipY - 10), transform: "translate(-50%, -100%)" }}
              >
                <p className="font-black">{formatDate(activePoint.day)}</p>
                <p className="mt-0.5 flex items-center gap-2">
                  <span className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: SERIES[0] }} aria-hidden="true" />
                  <span className="font-black tabular-nums">{activeText}</span>
                  <span className="truncate text-slate-300">{label}</span>
                </p>
                {hasPrevious && (
                  <p className="mt-0.5 flex items-center gap-2">
                    <span className="w-3 shrink-0 border-t-2 border-dashed border-slate-400" aria-hidden="true" />
                    <span className="font-black tabular-nums">{format(activePrevious)}</span>
                    <span className="truncate text-slate-300">
                      {t("Previous range")}
                      {previous[activeIndex]?.day ? ` · ${formatDate(previous[activeIndex].day)}` : ""}
                    </span>
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>
      <p id={hintId} className="mt-1 text-[11px] text-slate-400">
        {t("Hover or use the arrow keys to read each day")}
      </p>
      <p id={liveId} className="sr-only" aria-live="polite">
        {announcement}
      </p>
      <ChartDataTable caption={label} columns={tableColumns} rows={tableRows} />
    </figure>
  );
}

// ---------------------------------------------------------------------------
// Bars, donut, sparkline
// ---------------------------------------------------------------------------

/** Horizontal bars of one nominal series (all slot-1): `rows[].label` display-ready, `share` a 0–1 fraction. */
export function BarList({ rows = [], format, max, title }) {
  const { t, formatNumber } = useI18n();
  const list = (Array.isArray(rows) ? rows : []).map((row) => ({ ...row, value: finite(row?.value) })).filter((row) => row.value !== null);
  if (!list.length) return <EmptyState compact title={t("No stored data for this range")} />;
  const top = Math.max(finite(max) ?? 0, ...list.map((row) => row.value), 0) || 1;
  const fmt = (value) => (format ? format(value) : formatNumber(value));
  return (
    <figure className="min-w-0">
      {title && <figcaption className="mb-2 text-xs font-black uppercase tracking-wide text-slate-400">{title}</figcaption>}
      <ul className="space-y-2">
        {list.map((row, index) => {
          const percent = Math.max(0, Math.min(100, (row.value / top) * 100));
          const share = finite(row.share);
          return (
            <li key={row.key ?? index} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 text-sm" title={`${row.label ?? row.key}: ${fmt(row.value)}`}>
              <span className="truncate font-bold text-slate-700">{row.label ?? row.key}</span>
              <span className="h-2.5 overflow-hidden rounded-r-sm bg-slate-100">
                <span className="block h-full rounded-r-sm" style={{ width: `${percent}%`, background: SERIES[0] }} />
              </span>
              <span className="whitespace-nowrap text-right tabular-nums">
                <strong className="text-slate-900">{fmt(row.value)}</strong>
                {share !== null && <span className="ml-2 text-xs text-slate-400">{formatNumber(share * 100, { maximumFractionDigits: 1 })}%</span>}
              </span>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}

/** Part-to-whole ring, at most six segments (the tail folds into "Other"); the legend list is the readable twin. */
export function DonutChart({ segments = [], format, title }) {
  const { t, formatNumber } = useI18n();
  const [activeKey, setActiveKey] = useState(null);
  const parts = useMemo(() => {
    const clean = (Array.isArray(segments) ? segments : [])
      .map((segment) => ({ key: String(segment?.key ?? segment?.label ?? ""), label: String(segment?.label ?? segment?.key ?? ""), value: finite(segment?.value) }))
      .filter((segment) => segment.value !== null && segment.value > 0);
    if (clean.length <= MAX_SEGMENTS) return clean.map((segment, index) => ({ ...segment, color: SERIES[index] }));
    const head = clean.slice(0, MAX_SEGMENTS - 1).map((segment, index) => ({ ...segment, color: SERIES[index] }));
    const rest = clean.slice(MAX_SEGMENTS - 1).reduce((sum, segment) => sum + segment.value, 0);
    return [...head, { key: "__other", label: t("Other"), value: rest, color: OTHER_COLOR }];
  }, [segments, t]);
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  if (!parts.length || total <= 0) return <EmptyState compact title={t("No stored data for this range")} />;
  const fmt = (value) => (format ? format(value) : formatNumber(value));
  const pct = (value) => formatNumber((value / total) * 100, { maximumFractionDigits: 1 });
  const gap = parts.length > 1 ? 0.6 : 0; // ≈ 2px of surface between segments
  const shares = parts.map((part) => (part.value / total) * 100);
  const arcs = parts.map((part, index) => ({
    ...part,
    start: shares.slice(0, index).reduce((sum, share) => sum + share, 0),
    dash: Math.max(0, shares[index] - gap)
  }));
  const activePart = arcs.find((arc) => arc.key === activeKey) || null;
  const summary = `${title || t("Total")}: ${arcs.map((arc) => `${arc.label} ${pct(arc.value)}%`).join(", ")}`;

  return (
    <figure className="min-w-0">
      {title && <figcaption className="mb-2 text-xs font-black uppercase tracking-wide text-slate-400">{title}</figcaption>}
      <div className="flex flex-col items-center gap-5 sm:flex-row">
        <div className="relative h-40 w-40 shrink-0">
          <svg viewBox="0 0 160 160" className="h-full w-full -rotate-90" role="img" aria-label={summary} onPointerLeave={() => setActiveKey(null)}>
            {arcs.map((arc) => (
              <circle
                key={arc.key}
                className={cx("an-donut-segment", activeKey && activeKey !== arc.key && "is-dim")}
                cx="80"
                cy="80"
                r="60"
                fill="none"
                stroke={arc.color}
                strokeWidth={activeKey === arc.key ? 20 : 16}
                pathLength="100"
                strokeDasharray={`${arc.dash} ${100 - arc.dash}`}
                strokeDashoffset={-arc.start}
                onPointerEnter={() => setActiveKey(arc.key)}
              />
            ))}
          </svg>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-4 text-center">
            <span className="max-w-full truncate text-[11px] font-bold text-slate-400">{activePart ? activePart.label : t("Total")}</span>
            <span className="text-xl font-black text-slate-950">{activePart ? `${pct(activePart.value)}%` : fmt(total)}</span>
          </div>
        </div>
        <ul className="w-full min-w-0 flex-1 space-y-1.5 text-sm">
          {arcs.map((arc) => (
            <li
              key={arc.key}
              onPointerEnter={() => setActiveKey(arc.key)}
              onPointerLeave={() => setActiveKey(null)}
              className={cx("flex items-center gap-2 rounded-lg px-1.5 py-0.5 transition", activeKey === arc.key && "bg-slate-50")}
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-xs" style={{ background: arc.color }} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate font-bold text-slate-700">{arc.label}</span>
              <span className="shrink-0 tabular-nums text-slate-900">{fmt(arc.value)}</span>
              <span className="w-12 shrink-0 text-right text-xs tabular-nums text-slate-400">{pct(arc.value)}%</span>
            </li>
          ))}
        </ul>
      </div>
    </figure>
  );
}

/** Inline 96×28 trend of raw numbers (null = gap); announces first → last. */
export function Sparkline({ values = [] }) {
  const { t, formatNumber } = useI18n();
  const width = 96;
  const height = 28;
  const pad = 3;
  const list = (Array.isArray(values) ? values : []).map(finite);
  const numeric = list.filter((value) => value !== null);
  if (numeric.length < 2) return <svg width={width} height={height} aria-hidden="true" className="shrink-0" />;
  const min = Math.min(...numeric);
  const span = Math.max(...numeric) - min || 1;
  const xAt = (index) => pad + (index / (list.length - 1)) * (width - pad * 2);
  const yAt = (value) => height - pad - ((value - min) / span) * (height - pad * 2);
  const path = runs(list)
    .filter((run) => run.length > 1)
    .map((run) => run.map((index, position) => `${position ? "L" : "M"}${xAt(index).toFixed(1)} ${yAt(list[index]).toFixed(1)}`).join(" "))
    .join(" ");
  const lastIndex = list.length - 1 - [...list].reverse().findIndex((value) => value !== null);
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="shrink-0"
      role="img"
      aria-label={t("Trend from {first} to {last}", { first: formatNumber(numeric[0]), last: formatNumber(numeric[numeric.length - 1]) })}
    >
      <path className="an-line" d={path} style={{ stroke: SERIES[0] }} />
      <circle className="an-marker" cx={xAt(lastIndex)} cy={yAt(list[lastIndex])} r={3} style={{ fill: SERIES[0] }} />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Coverage calendar
// ---------------------------------------------------------------------------

function monthsBetween(start, end) {
  const out = [];
  let first = monthStart(start);
  while (first <= end) {
    const next = monthStart(addDays(first, 32));
    out.push({ key: first.slice(0, 7), first, last: addDays(next, -1) });
    first = next;
  }
  return out;
}

// Rows of seven cells, Monday first; blanks pad the first and last week.
function weeksOf(month) {
  const firstColumn = (new Date(`${month.first}T00:00:00Z`).getUTCDay() + 6) % 7;
  const cells = Array.from({ length: firstColumn }, () => ({ blank: true }));
  const length = dayDiff(month.first, month.last) + 1;
  for (let number = 1; number <= length; number += 1) cells.push({ day: `${month.key}-${String(number).padStart(2, "0")}`, number });
  while (cells.length % 7) cells.push({ blank: true });
  const weeks = [];
  for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7));
  return weeks;
}

function stateOf(entry) {
  if (!entry) return "missing";
  if (entry.pending) return "pending";
  if (entry.drift) return "drift";
  if (entry.facts) return "covered";
  return "missing";
}

/**
 * Month blocks of the range with the five coverage states (stored / drift / missing / not yet published + revenue
 * dot); one tab stop, Arrow keys move by day and week, Home / End jump to the range ends, Enter selects a day.
 */
export function CoverageCalendar({ days = [], startDate, endDate, onSelectDay, selectedDay, showMonetary = true }) {
  const { t, locale, formatDate } = useI18n();
  const [focusDay, setFocusDay] = useState(null);
  const cellRefs = useRef(new Map());
  const groupId = useId();
  const valid = isValidDay(startDate) && isValidDay(endDate) && startDate <= endDate;
  const byDay = useMemo(() => new Map((Array.isArray(days) ? days : []).filter((entry) => entry?.day).map((entry) => [entry.day, entry])), [days]);
  const months = useMemo(() => (valid ? monthsBetween(startDate, endDate) : []), [valid, startDate, endDate]);
  const weekdays = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
    return Array.from({ length: 7 }, (_, index) => formatter.format(new Date(WEEK_ANCHOR + index * 86400000)));
  }, [locale]);
  const monthFormatter = useMemo(() => new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }), [locale]);
  if (!valid) return null;

  const inRange = (day) => day >= startDate && day <= endDate;
  const focusTarget = focusDay && inRange(focusDay) ? focusDay : selectedDay && inRange(selectedDay) ? selectedDay : startDate;
  const clampDay = (day) => (day < startDate ? startDate : day > endDate ? endDate : day);

  function handleKey(event, day) {
    const deltas = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    const next = Object.hasOwn(deltas, event.key) ? clampDay(addDays(day, deltas[event.key])) : event.key === "Home" ? startDate : event.key === "End" ? endDate : null;
    if (!next) return;
    event.preventDefault();
    setFocusDay(next);
    cellRefs.current.get(next)?.focus();
  }

  return (
    <div className="min-w-0">
      <span id={groupId} className="sr-only">
        {t("Coverage calendar")}
      </span>
      {/* Selecting a day only filters what is shown: the grid stays clickable for the Read Only role (its Vietnamese
          labels contain "lưu", which ReadOnlyRuntime would otherwise lock as a save action). */}
      <div data-readonly-allow="true" className="flex flex-wrap gap-6" role="group" aria-labelledby={groupId}>
        {months.map((month) => {
          const weeks = weeksOf(month);
          const rangeDays = weeks.flat().filter((cell) => cell.day && inRange(cell.day));
          const storedCount = rangeDays.filter((cell) => ["covered", "drift"].includes(stateOf(byDay.get(cell.day)))).length;
          // Intl gives "tháng 10 năm 2026" in Vietnamese; a heading starts with a capital.
          const monthText = monthFormatter.format(new Date(`${month.first}T00:00:00Z`));
          const monthLabel = monthText.charAt(0).toUpperCase() + monthText.slice(1);
          return (
            <div key={month.key} role="grid" aria-label={monthLabel} className="min-w-[15.5rem] flex-1">
              <div className="mb-2 flex items-baseline justify-between gap-2">
                <h4 className="text-sm font-black text-slate-800">{monthLabel}</h4>
                <span className="text-[11px] font-bold text-slate-400">{t("{covered}/{total} days stored", { covered: storedCount, total: rangeDays.length })}</span>
              </div>
              <div role="row" className="grid grid-cols-7 gap-1 text-center text-[10px] font-black uppercase text-slate-400">
                {weekdays.map((name) => (
                  <span key={name} role="columnheader" className="py-1">
                    {name}
                  </span>
                ))}
              </div>
              {weeks.map((week, weekIndex) => (
                <div key={weekIndex} role="row" className="mt-1 grid grid-cols-7 gap-1">
                  {week.map((cell, cellIndex) => {
                    if (cell.blank) return <span key={`blank-${cellIndex}`} role="gridcell" aria-hidden="true" />;
                    if (!inRange(cell.day)) {
                      return (
                        <span key={cell.day} role="gridcell" aria-disabled="true" className="flex h-8 items-center justify-center rounded-lg text-xs text-slate-300">
                          {cell.number}
                        </span>
                      );
                    }
                    const entry = byDay.get(cell.day);
                    const state = stateOf(entry);
                    const monetary = showMonetary && Boolean(entry?.monetary);
                    const isSelected = cell.day === selectedDay;
                    const description = `${formatDate(cell.day)} — ${t(STATE_LABEL[state])}${monetary ? `, ${t("Revenue included")}` : ""}`;
                    return (
                      <button
                        key={cell.day}
                        type="button"
                        role="gridcell"
                        aria-selected={isSelected}
                        aria-label={description}
                        tabIndex={cell.day === focusTarget ? 0 : -1}
                        ref={(node) => {
                          if (node) cellRefs.current.set(cell.day, node);
                          else cellRefs.current.delete(cell.day);
                        }}
                        onKeyDown={(event) => handleKey(event, cell.day)}
                        onFocus={() => setFocusDay(cell.day)}
                        onClick={() => onSelectDay?.(cell.day)}
                        className={cx(
                          "relative flex h-8 items-center justify-center rounded-lg text-xs font-bold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400",
                          STATE_CLASS[state],
                          isSelected && "ring-2 ring-blue-600 ring-offset-1"
                        )}
                      >
                        {cell.number}
                        {monetary && <span className="an-cov-dot" aria-hidden="true" />}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          );
        })}
      </div>
      <ul className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] font-bold text-slate-500">
        {Object.entries(STATE_LABEL).map(([state, stateLabel]) => (
          <li key={state} className="inline-flex items-center gap-1.5">
            <span className={cx("relative inline-block h-4 w-4 rounded-md", STATE_CLASS[state])} aria-hidden="true" />
            {t(stateLabel)}
          </li>
        ))}
        {showMonetary && (
          <li className="inline-flex items-center gap-1.5">
            <span className="relative inline-block h-4 w-4 rounded-md an-cov-covered" aria-hidden="true">
              <span className="an-cov-dot" />
            </span>
            {t("Revenue included")}
          </li>
        )}
      </ul>
      <p className="mt-1 text-[11px] text-slate-400">{t("Use the arrow keys to move between days")}</p>
    </div>
  );
}
