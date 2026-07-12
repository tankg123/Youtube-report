import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BarChart3,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  ExternalLink,
  FileSpreadsheet,
  Layers3,
  Loader2,
  Network,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  TrendingDown,
  TrendingUp,
  UsersRound,
  Video,
  WalletCards
} from "lucide-react";
import api from "../api/api";
import { useI18n } from "../context/I18nContext";

const NETWORK_COLORS = ["#16a36a", "#3b82f6", "#8b5cf6", "#f59e0b", "#ec4899", "#06b6d4"];

const reportCopy = {
  en: {
    eyebrow: "Revenue intelligence",
    title: "Report overview",
    description: "A decision-ready view of gross revenue, calculated partner obligations, network performance and report quality.",
    modelNote: "Payable and retained revenue are modeled from current group rules. They are not recorded settlements or net accounting profit.",
    month: "Reporting month",
    chooseMonth: "Choose reporting month",
    latestPeriod: "Latest",
    selectedPeriodBadge: "Selected",
    updatingPeriod: "Updating period…",
    refresh: "Refresh data",
    openReports: "Import & review reports",
    manageGroups: "Manage revenue groups",
    latestImport: "Latest import",
    noImport: "No import recorded",
    grossRevenue: "Gross revenue",
    grossRevenueDetail: "Current imported revenue",
    partnerPayable: "Calculated payable",
    partnerPayableDetail: "After group fee, under current rules",
    retainedRevenue: "Retained revenue",
    retainedRevenueDetail: "Gross revenue minus calculated payable",
    retainedMargin: "Retained margin",
    retainedMarginDetail: "Before operating expenses and tax",
    percentagePoints: " pp",
    versus: "vs",
    noComparison: "No earlier month",
    noBaseline: "The previous month has no comparable revenue baseline",
    lifetimeTitle: "Modeled lifetime snapshot",
    lifetimeDescription: "Historical payable is recalculated using the current sharing configuration.",
    lifetimeRevenue: "Gross revenue",
    lifetimePayable: "Calculated payable",
    lifetimeRetained: "Retained revenue",
    totalPartners: "Partner records",
    totalChannels: "Channel catalog",
    trendEyebrow: "Historical performance",
    trendTitle: "Revenue and payable trend",
    trendDescription: "Up to 12 imported months ending at the selected reporting period.",
    gross: "Gross revenue",
    payable: "Calculated payable",
    retained: "Retained",
    viewTable: "View chart data",
    monthColumn: "Month",
    revenueChannels: "Earning channels",
    trendCaption: "Each column compares imported gross revenue with the partner payable calculated from current group rules.",
    networkEyebrow: "Revenue composition",
    networkTitle: "Network mix",
    networkDescription: "Share of selected-month gross revenue by imported network.",
    noNetworkData: "No network revenue for this month.",
    currentHealth: "Current channel health",
    healthDescription: "Current catalog status; not a historical monthly measure.",
    healthy: "Healthy",
    needsAttention: "Needs attention",
    inactive: "Inactive",
    unknown: "Unknown",
    insightEyebrow: "Decision support",
    insightTitle: "Executive insights",
    insightDescription: "Deterministic observations calculated directly from report and configuration data.",
    momentum: "Revenue momentum",
    groupCoverage: "Group configuration coverage",
    concentration: "Network concentration",
    importQuality: "Import readiness",
    dataEyebrow: "Control center",
    dataTitle: "Data confidence",
    dataDescription: "Coverage, import freshness and metadata synchronization for the selected month.",
    revenueCoverage: "Revenue connected to groups",
    channelCoverage: "Earning channels in groups",
    networkCoverage: "Networks imported",
    metadataGaps: "Missing metadata at latest import",
    metadataGapNote: "Revenue rows remain available; this records YouTube metadata lookup gaps at import time.",
    recentImports: "Recent import files",
    files: "files",
    channels: "channels",
    missing: "gaps",
    noRecentImports: "No import history for this month.",
    networkPerformance: "Network performance",
    networkPerformanceDescription: "Gross revenue, modeled payable and retained revenue by network.",
    network: "Network",
    margin: "Margin",
    partnerRanking: "Partner payable ranking",
    partnerRankingDescription: "Calculated obligations under current group rules; click a row to open its primary group.",
    modeledGross: "Modeled gross",
    channelRanking: "Top earning channels",
    channelRankingDescription: "Highest imported gross revenue in the selected month.",
    shareOfMonth: "of monthly gross",
    openYoutube: "Open YouTube channel",
    noPartnerData: "No calculated partner payable for this month.",
    noChannelData: "No channel revenue for this month.",
    loading: "Building report intelligence…",
    retry: "Try again",
    loadError: "Could not load report overview",
    dataScope: "Current configuration model",
    selectedPeriod: "Selected period",
    importedData: "Imported data",
    rows: "rows"
  },
  vi: {
    eyebrow: "Phân tích doanh thu",
    title: "Tổng quan báo cáo",
    description: "Góc nhìn sẵn sàng cho quyết định về doanh thu gộp, nghĩa vụ đối tác được tính toán, hiệu suất network và chất lượng báo cáo.",
    modelNote: "Khoản phải trả và doanh thu giữ lại được mô phỏng theo rule group hiện tại; không phải giao dịch đã thanh toán hay lợi nhuận kế toán ròng.",
    month: "Tháng báo cáo",
    chooseMonth: "Chọn tháng báo cáo",
    latestPeriod: "Mới nhất",
    selectedPeriodBadge: "Đang chọn",
    updatingPeriod: "Đang cập nhật kỳ…",
    refresh: "Làm mới dữ liệu",
    openReports: "Nhập & kiểm tra báo cáo",
    manageGroups: "Quản lý group doanh thu",
    latestImport: "Import gần nhất",
    noImport: "Chưa có lịch sử import",
    grossRevenue: "Doanh thu gộp",
    grossRevenueDetail: "Doanh thu import trong kỳ",
    partnerPayable: "Khoản phải trả dự tính",
    partnerPayableDetail: "Sau phí group, theo rule hiện tại",
    retainedRevenue: "Doanh thu giữ lại",
    retainedRevenueDetail: "Doanh thu gộp trừ khoản phải trả dự tính",
    retainedMargin: "Biên giữ lại",
    retainedMarginDetail: "Trước chi phí vận hành và thuế",
    percentagePoints: " điểm %",
    versus: "so với",
    noComparison: "Chưa có tháng trước",
    noBaseline: "Tháng trước chưa có mốc doanh thu để so sánh",
    lifetimeTitle: "Toàn kỳ theo mô hình hiện tại",
    lifetimeDescription: "Khoản phải trả lịch sử được tính lại bằng cấu hình chia sẻ đang áp dụng.",
    lifetimeRevenue: "Doanh thu gộp",
    lifetimePayable: "Khoản phải trả dự tính",
    lifetimeRetained: "Doanh thu giữ lại",
    totalPartners: "Hồ sơ đối tác",
    totalChannels: "Danh mục kênh",
    trendEyebrow: "Hiệu suất lịch sử",
    trendTitle: "Xu hướng doanh thu và khoản phải trả",
    trendDescription: "Tối đa 12 tháng đã import, kết thúc tại kỳ báo cáo đang chọn.",
    gross: "Doanh thu gộp",
    payable: "Khoản phải trả dự tính",
    retained: "Giữ lại",
    viewTable: "Xem bảng dữ liệu biểu đồ",
    monthColumn: "Tháng",
    revenueChannels: "Kênh có doanh thu",
    trendCaption: "Mỗi cột so sánh doanh thu gộp đã import với khoản phải trả đối tác được tính theo rule group hiện tại.",
    networkEyebrow: "Cơ cấu doanh thu",
    networkTitle: "Tỷ trọng network",
    networkDescription: "Tỷ trọng doanh thu gộp trong tháng theo từng network đã import.",
    noNetworkData: "Tháng này chưa có doanh thu theo network.",
    currentHealth: "Sức khỏe kênh hiện tại",
    healthDescription: "Trạng thái danh mục hiện tại, không phải chỉ số lịch sử theo tháng.",
    healthy: "Ổn định",
    needsAttention: "Cần kiểm tra",
    inactive: "Ngừng hoạt động",
    unknown: "Chưa xác định",
    insightEyebrow: "Hỗ trợ quyết định",
    insightTitle: "Insight điều hành",
    insightDescription: "Nhận định xác định trực tiếp từ dữ liệu báo cáo và cấu hình, không dùng số liệu giả lập.",
    momentum: "Động lực doanh thu",
    groupCoverage: "Độ phủ cấu hình group",
    concentration: "Mức tập trung network",
    importQuality: "Mức sẵn sàng dữ liệu",
    dataEyebrow: "Trung tâm kiểm soát",
    dataTitle: "Độ tin cậy dữ liệu",
    dataDescription: "Độ phủ, độ mới của import và đồng bộ metadata trong tháng đang chọn.",
    revenueCoverage: "Doanh thu đã kết nối group",
    channelCoverage: "Kênh doanh thu đã vào group",
    networkCoverage: "Network đã import",
    metadataGaps: "Thiếu metadata tại lần import mới nhất",
    metadataGapNote: "Dòng doanh thu vẫn được lưu; đây là khoảng trống tra cứu metadata YouTube tại thời điểm import.",
    recentImports: "File import gần đây",
    files: "file",
    channels: "kênh",
    missing: "khoảng trống",
    noRecentImports: "Tháng này chưa có lịch sử import.",
    networkPerformance: "Hiệu suất network",
    networkPerformanceDescription: "Doanh thu gộp, khoản phải trả dự tính và phần giữ lại theo network.",
    network: "Network",
    margin: "Biên giữ lại",
    partnerRanking: "Xếp hạng khoản phải trả đối tác",
    partnerRankingDescription: "Nghĩa vụ được tính theo rule group hiện tại; nhấn vào từng dòng để mở group chính.",
    modeledGross: "Doanh thu theo group",
    channelRanking: "Kênh tạo doanh thu cao nhất",
    channelRankingDescription: "Các kênh có doanh thu gộp đã import cao nhất trong tháng.",
    shareOfMonth: "doanh thu gộp tháng",
    openYoutube: "Mở kênh YouTube",
    noPartnerData: "Tháng này chưa có khoản phải trả đối tác được tính.",
    noChannelData: "Tháng này chưa có doanh thu kênh.",
    loading: "Đang tổng hợp phân tích báo cáo…",
    retry: "Thử lại",
    loadError: "Không thể tải tổng quan báo cáo",
    dataScope: "Mô hình theo cấu hình hiện tại",
    selectedPeriod: "Kỳ đang chọn",
    importedData: "Dữ liệu đã import",
    rows: "dòng"
  }
};

function numeric(value) {
  return Number(value || 0);
}

function money(value, language = "en", digits = 2) {
  return new Intl.NumberFormat(language === "vi" ? "vi-VN" : "en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: digits
  }).format(numeric(value));
}

function compact(value, language = "en") {
  return new Intl.NumberFormat(language === "vi" ? "vi-VN" : "en-US", {
    notation: Math.abs(numeric(value)) >= 1000 ? "compact" : "standard",
    maximumFractionDigits: 1
  }).format(numeric(value));
}

function percentage(value, digits = 1) {
  return `${numeric(value).toLocaleString("en-US", { maximumFractionDigits: digits })}%`;
}

function ratio(value, total) {
  return numeric(total) ? numeric(value) / numeric(total) * 100 : 0;
}

function change(current, previous) {
  if (!numeric(previous)) return null;
  return (numeric(current) - numeric(previous)) / Math.abs(numeric(previous)) * 100;
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, numeric(value)));
}

function monthLabel(value, language = "en", short = false) {
  if (!/^\d{4}-\d{2}$/.test(String(value || ""))) return value || "—";
  const [year, month] = value.split("-").map(Number);
  return new Intl.DateTimeFormat(language === "vi" ? "vi-VN" : "en-US", {
    month: short ? "short" : "long",
    year: short ? "2-digit" : "numeric"
  }).format(new Date(year, month - 1, 1));
}

function dateTime(value, language = "en") {
  if (!value) return "—";
  const source = String(value).trim().replace(" ", "T");
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(source) ? source : `${source}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(language === "vi" ? "vi-VN" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function initials(value = "C") {
  return String(value || "C").trim().charAt(0).toUpperCase() || "C";
}

function ChangeBadge({ value, label, neutral = false, suffix = "%", language = "en" }) {
  if (value === null || !Number.isFinite(value)) {
    return <span className="report-overview-delta is-neutral">{label}</span>;
  }

  const direction = value > 0 ? "positive" : value < 0 ? "negative" : "neutral";
  const Icon = value > 0 ? TrendingUp : value < 0 ? TrendingDown : Activity;
  const display = `${value > 0 ? "+" : ""}${numeric(value).toLocaleString(language === "vi" ? "vi-VN" : "en-US", { maximumFractionDigits: 1 })}${suffix}`;

  return (
    <span className={`report-overview-delta is-${neutral ? "neutral" : direction}`}>
      <Icon size={13} aria-hidden="true" />
      {display} {label}
    </span>
  );
}

function MetricCard({ title, value, detail, icon: Icon, tone, delta, deltaLabel, neutralDelta = false, deltaSuffix, language }) {
  return (
    <article className={`report-overview-metric is-${tone}`}>
      <div className="report-overview-metric-head">
        <span className="report-overview-metric-icon"><Icon size={21} aria-hidden="true" /></span>
        <ChangeBadge value={delta} label={deltaLabel} neutral={neutralDelta} suffix={deltaSuffix} language={language} />
      </div>
      <p>{title}</p>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function SectionHeading({ id, eyebrow, title, description, action }) {
  return (
    <div className="report-overview-section-heading">
      <div>
        {eyebrow && <p>{eyebrow}</p>}
        <h2 id={id}>{title}</h2>
        {description && <span>{description}</span>}
      </div>
      {action}
    </div>
  );
}

function TrendChart({ items, selectedMonth, language, copy }) {
  const maximum = Math.max(1, ...items.map((item) => numeric(item.revenue_usd)));

  if (!items.length) {
    return <div className="report-overview-empty">{copy.noChannelData}</div>;
  }

  const chartSummary = items.map((item) => (
    `${monthLabel(item.month, language)}: ${copy.gross} ${money(item.revenue_usd, language)}, ${copy.payable} ${money(item.paid_usd, language)}`
  )).join("; ");

  return (
    <figure className="report-overview-trend">
      <div className="report-overview-chart-legend" aria-label={`${copy.gross}, ${copy.payable}`}>
        <span><i className="is-gross" />{copy.gross}</span>
        <span><i className="is-payable" />{copy.payable}</span>
      </div>
      <div className="report-overview-trend-scroll">
        <div className="report-overview-trend-plot" style={{ "--report-points": items.length }} role="img" aria-label={`${copy.trendTitle}. ${chartSummary}`}>
          {items.map((item) => {
            const revenueHeight = numeric(item.revenue_usd) / maximum * 100;
            const payableHeight = numeric(item.paid_usd) / maximum * 100;
            const label = `${monthLabel(item.month, language)}: ${copy.gross} ${money(item.revenue_usd, language)}, ${copy.payable} ${money(item.paid_usd, language)}, ${copy.retained} ${money(item.profit_usd, language)}`;
            return (
              <div
                key={item.month}
                className={`report-overview-trend-column ${item.month === selectedMonth ? "is-selected" : ""}`}
                aria-hidden="true"
                title={label}
              >
                <div className="report-overview-trend-values" aria-hidden="true">
                  <span className="is-gross">{compact(item.revenue_usd, language)}</span>
                  <span className="is-payable">{compact(item.paid_usd, language)}</span>
                </div>
                <div className="report-overview-trend-bars" aria-hidden="true">
                  <i className="is-gross" style={{ "--report-bar-height": `${revenueHeight}%` }} />
                  <i className="is-payable" style={{ "--report-bar-height": `${payableHeight}%` }} />
                </div>
                <strong>{monthLabel(item.month, language, true)}</strong>
                <small>{compact(item.revenue_channels, language)} {copy.channels}</small>
              </div>
            );
          })}
        </div>
      </div>
      <figcaption>{copy.trendCaption}</figcaption>
      <details className="report-overview-chart-data">
        <summary>{copy.viewTable}</summary>
        <div className="report-overview-table-scroll">
          <table>
            <caption className="sr-only">{copy.trendTitle}</caption>
            <thead>
              <tr><th scope="col">{copy.monthColumn}</th><th scope="col">{copy.gross}</th><th scope="col">{copy.payable}</th><th scope="col">{copy.retained}</th><th scope="col">{copy.revenueChannels}</th></tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={`trend-row-${item.month}`}>
                  <td>{monthLabel(item.month, language)}</td>
                  <td>{money(item.revenue_usd, language)}</td>
                  <td>{money(item.paid_usd, language)}</td>
                  <td>{money(item.profit_usd, language)}</td>
                  <td>{compact(item.revenue_channels, language)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

function donutGradient(segments, total) {
  if (!numeric(total)) return "conic-gradient(#cbd5e1 0 100%)";
  let cursor = 0;
  return `conic-gradient(${segments.map((segment) => {
    const start = cursor;
    cursor += ratio(segment.value, total);
    return `${segment.color} ${start}% ${cursor}%`;
  }).join(", ")})`;
}

function DonutChart({ segments, total, centerValue, centerLabel, ariaLabel }) {
  return (
    <div
      className="report-overview-donut"
      style={{ "--report-donut": donutGradient(segments, total) }}
      role="img"
      aria-label={ariaLabel}
    >
      <div><strong>{centerValue}</strong><span>{centerLabel}</span></div>
    </div>
  );
}

function NetworkMix({ items, totalRevenue, language, copy }) {
  const segments = items.map((item, index) => ({
    label: item.network_name,
    value: numeric(item.revenue_usd),
    color: NETWORK_COLORS[index % NETWORK_COLORS.length]
  }));
  const ariaLabel = segments.length
    ? segments.map((item) => `${item.label} ${percentage(ratio(item.value, totalRevenue))}`).join(", ")
    : copy.noNetworkData;

  return (
    <div className="report-overview-mix-layout">
      <DonutChart
        segments={segments}
        total={totalRevenue}
        centerValue={compact(totalRevenue, language)}
        centerLabel={copy.gross}
        ariaLabel={ariaLabel}
      />
      <div className="report-overview-mix-legend">
        {segments.length ? segments.map((item) => (
          <div key={item.label}>
            <i style={{ backgroundColor: item.color }} />
            <span><strong>{item.label}</strong><small>{money(item.value, language)}</small></span>
            <b>{percentage(ratio(item.value, totalRevenue))}</b>
          </div>
        )) : <p className="report-overview-empty is-compact">{copy.noNetworkData}</p>}
      </div>
    </div>
  );
}

function HealthSummary({ health, language, copy }) {
  const segments = [
    { label: copy.healthy, value: numeric(health.healthy_channels), color: "#10b981" },
    { label: copy.needsAttention, value: numeric(health.error_channels), color: "#f43f5e" },
    { label: copy.inactive, value: numeric(health.inactive_channels), color: "#f59e0b" },
    { label: copy.unknown, value: numeric(health.unknown_channels), color: "#94a3b8" }
  ].filter((item) => item.value > 0);
  const total = segments.reduce((sum, item) => sum + item.value, 0);
  const healthyRate = ratio(health.healthy_channels, total);

  return (
    <div className="report-overview-health-layout">
      <DonutChart
        segments={segments}
        total={total}
        centerValue={percentage(healthyRate, 0)}
        centerLabel={copy.healthy}
        ariaLabel={segments.map((item) => `${item.label} ${compact(item.value, language)}`).join(", ")}
      />
      <div className="report-overview-health-list">
        {segments.map((item) => (
          <div key={item.label}><i style={{ backgroundColor: item.color }} /><span>{item.label}</span><strong>{compact(item.value, language)}</strong></div>
        ))}
      </div>
    </div>
  );
}

function CoverageMetric({ label, value, detail, tone = "primary" }) {
  return (
    <div className="report-overview-coverage-metric">
      <div><span>{label}</span><strong>{percentage(value)}</strong></div>
      <div className="report-overview-progress" aria-hidden="true"><i className={`is-${tone}`} style={{ "--report-progress": `${clampPercent(value)}%` }} /></div>
      <small>{detail}</small>
    </div>
  );
}

function InsightCard({ icon: Icon, tone, title, body }) {
  return (
    <article className={`report-overview-insight is-${tone}`}>
      <span><Icon size={19} aria-hidden="true" /></span>
      <div><h3>{title}</h3><p>{body}</p></div>
    </article>
  );
}

function LoadingState({ copy }) {
  return (
    <div className="report-overview-loading" aria-live="polite">
      <Loader2 size={30} aria-hidden="true" />
      <strong>{copy.loading}</strong>
      <div className="report-overview-loading-grid" aria-hidden="true"><i /><i /><i /><i /></div>
    </div>
  );
}

export default function ReportDashboardPage() {
  const navigate = useNavigate();
  const { language } = useI18n();
  const copy = reportCopy[language] || reportCopy.en;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [failedMonth, setFailedMonth] = useState("");
  const [monthChoice, setMonthChoice] = useState("");
  const [monthMenuOpen, setMonthMenuOpen] = useState(false);
  const [monthMenuLayout, setMonthMenuLayout] = useState({
    placement: "below",
    style: { top: 0, left: 0, width: 320, maxHeight: 288 }
  });
  const abortRef = useRef(null);
  const requestIdRef = useRef(0);
  const committedMonthRef = useRef("");
  const monthPickerRef = useRef(null);
  const monthMenuRef = useRef(null);
  const refreshButtonRef = useRef(null);

  const requestDashboard = useCallback(async (selectedMonth = "") => {
    const requestId = ++requestIdRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    if (selectedMonth) setMonthChoice(selectedMonth);

    try {
      setLoading(true);
      setMessage("");
      setFailedMonth("");
      const res = await api.get("/reports/dashboard", {
        params: selectedMonth ? { month: selectedMonth } : {},
        signal: controller.signal
      });
      if (requestId !== requestIdRef.current) return;
      setData(res.data.data);
      committedMonthRef.current = res.data.data?.month || selectedMonth;
      setMonthChoice(committedMonthRef.current);
    } catch (error) {
      if (error.code === "ERR_CANCELED" || requestId !== requestIdRef.current) return;
      setMessage("load_error");
      setFailedMonth(selectedMonth);
      setMonthChoice(committedMonthRef.current);
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
        abortRef.current = null;
      }
    }
  }, []);

  const updateMonthMenuPosition = useCallback(() => {
    const trigger = monthPickerRef.current;
    if (!trigger) return false;

    const rect = trigger.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const margin = 12;

    if (
      rect.bottom <= margin
      || rect.top >= viewportHeight - margin
      || rect.right <= margin
      || rect.left >= viewportWidth - margin
    ) {
      setMonthMenuOpen(false);
      return false;
    }

    if (viewportWidth <= 640) {
      setMonthMenuLayout({
        placement: "sheet",
        style: {
          left: margin,
          bottom: "max(0.75rem, env(safe-area-inset-bottom))",
          width: Math.max(0, viewportWidth - margin * 2),
          maxHeight: Math.max(0, Math.min(viewportHeight * 0.7, viewportHeight - margin * 2))
        }
      });
      return true;
    }

    const gap = 8;
    const availableWidth = Math.max(0, viewportWidth - margin * 2);
    const width = Math.min(Math.max(rect.width, Math.min(320, availableWidth)), availableWidth);
    const left = Math.max(margin, Math.min(rect.left, viewportWidth - width - margin));
    const spaceBelow = viewportHeight - rect.bottom - margin;
    const spaceAbove = rect.top - margin;
    const openAbove = spaceBelow < 260 && spaceAbove > spaceBelow;
    const availableHeight = (openAbove ? spaceAbove : spaceBelow) - gap;
    const maxHeight = Math.max(0, Math.min(320, availableHeight));

    if (maxHeight < 120) {
      setMonthMenuLayout({
        placement: "sheet",
        style: {
          left,
          bottom: margin,
          width,
          maxHeight: Math.max(0, viewportHeight - margin * 2)
        }
      });
      return true;
    }

    setMonthMenuLayout({
      placement: openAbove ? "above" : "below",
      style: openAbove
        ? { left, bottom: viewportHeight - rect.top + gap, width, maxHeight }
        : { left, top: rect.bottom + gap, width, maxHeight }
    });
    return true;
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => requestDashboard(""), 0);
    return () => {
      window.clearTimeout(timer);
      requestIdRef.current += 1;
      abortRef.current?.abort();
    };
  }, [requestDashboard]);

  useEffect(() => {
    if (!monthMenuOpen) return undefined;

    function isMonthPickerTarget(target) {
      if (!(target instanceof Node)) return false;
      return monthPickerRef.current?.contains(target) || monthMenuRef.current?.contains(target);
    }

    function closeMonthPicker(event) {
      if (!isMonthPickerTarget(event.target)) setMonthMenuOpen(false);
    }

    function closeMonthPickerWithKeyboard(event) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMonthMenuOpen(false);
      window.requestAnimationFrame(() => monthPickerRef.current?.focus());
    }

    function closeMonthPickerOnFocus(event) {
      if (!isMonthPickerTarget(event.target)) setMonthMenuOpen(false);
    }

    function repositionMonthPicker(event) {
      if (event.target instanceof Node && monthMenuRef.current?.contains(event.target)) return;
      updateMonthMenuPosition();
    }

    document.addEventListener("pointerdown", closeMonthPicker);
    document.addEventListener("keydown", closeMonthPickerWithKeyboard);
    document.addEventListener("focusin", closeMonthPickerOnFocus);
    window.addEventListener("resize", updateMonthMenuPosition);
    window.addEventListener("scroll", repositionMonthPicker, true);
    return () => {
      document.removeEventListener("pointerdown", closeMonthPicker);
      document.removeEventListener("keydown", closeMonthPickerWithKeyboard);
      document.removeEventListener("focusin", closeMonthPickerOnFocus);
      window.removeEventListener("resize", updateMonthMenuPosition);
      window.removeEventListener("scroll", repositionMonthPicker, true);
    };
  }, [monthMenuOpen, updateMonthMenuPosition]);

  const selectedMonth = data?.month || "";
  const monthControlValue = monthChoice || selectedMonth;
  const displayMonth = selectedMonth || monthControlValue;
  const monthOptions = data?.available_months?.length
    ? data.available_months
    : selectedMonth ? [selectedMonth] : [];

  useEffect(() => {
    if (!monthMenuOpen) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const selectedOption = monthMenuRef.current?.querySelector('[data-report-month-option][aria-selected="true"]');
      (selectedOption || monthMenuRef.current?.querySelector("[data-report-month-option]"))?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [monthControlValue, monthMenuOpen, monthOptions.length]);

  const monthSummary = data?.month_summary || {};
  const previousSummary = data?.previous_month_summary || {};
  const full = data?.full || {};
  const counts = data?.counts || {};
  const importSummary = data?.import_summary || {};
  const health = data?.channel_health || {};
  const networkRows = data?.network_breakdown?.month || [];
  const topChannels = data?.top_channels || [];
  const topPartners = useMemo(
    () => [...(data?.top_partners_by_payable || data?.top_partners || [])]
      .filter((item) => Math.abs(numeric(item.paid_usd)) > 0.0001)
      .sort((a, b) => numeric(b.paid_usd) - numeric(a.paid_usd)),
    [data]
  );

  const revenue = numeric(monthSummary.total_revenue_usd);
  const payable = numeric(monthSummary.total_paid_usd);
  const retained = numeric(monthSummary.total_profit_usd);
  const retainedMargin = ratio(retained, revenue);
  const previousRevenue = numeric(previousSummary.total_revenue_usd);
  const previousPayable = numeric(previousSummary.total_paid_usd);
  const previousRetained = numeric(previousSummary.total_profit_usd);
  const previousMargin = ratio(previousRetained, previousRevenue);
  const comparisonLabel = data?.previous_month
    ? previousRevenue ? `${copy.versus} ${monthLabel(data.previous_month, language, true)}` : copy.noBaseline
    : copy.noComparison;
  const revenueCoverage = ratio(importSummary.grouped_revenue_usd, revenue);
  const channelCoverage = ratio(importSummary.grouped_channels, importSummary.revenue_channels);
  const networkCoverage = ratio(importSummary.imported_networks, importSummary.total_networks);
  const topNetwork = networkRows[0] || {};
  const topNetworkShare = ratio(topNetwork.revenue_usd, revenue);
  const topChannelRevenue = topChannels.reduce((sum, item) => sum + numeric(item.revenue_usd), 0);
  const topChannelShare = ratio(topChannelRevenue, revenue);
  const maxNetworkRevenue = Math.max(1, ...networkRows.map((item) => numeric(item.revenue_usd)));
  const maxPartnerPayable = Math.max(1, ...topPartners.map((item) => numeric(item.paid_usd)));
  const maxChannelRevenue = Math.max(1, ...topChannels.map((item) => numeric(item.revenue_usd)));
  const revenueMomentum = change(revenue, previousRevenue);

  const insights = [
    {
      icon: revenueMomentum !== null && revenueMomentum < 0 ? TrendingDown : TrendingUp,
      tone: revenueMomentum !== null && revenueMomentum < 0 ? "warning" : "positive",
      title: copy.momentum,
      body: data?.previous_month && revenueMomentum !== null
        ? language === "vi"
          ? `Doanh thu gộp ${revenueMomentum >= 0 ? "tăng" : "giảm"} ${percentage(Math.abs(revenueMomentum))} so với ${monthLabel(data.previous_month, language)}.`
          : `Gross revenue ${revenueMomentum >= 0 ? "increased" : "decreased"} ${percentage(Math.abs(revenueMomentum))} versus ${monthLabel(data.previous_month, language)}.`
        : data?.previous_month ? copy.noBaseline : copy.noComparison
    },
    {
      icon: Layers3,
      tone: revenueCoverage >= 90 ? "positive" : "warning",
      title: copy.groupCoverage,
      body: language === "vi"
        ? `${percentage(revenueCoverage)} doanh thu đã kết nối group; ${money(importSummary.ungrouped_revenue_usd, language)} chưa được gán group.`
        : `${percentage(revenueCoverage)} of revenue is connected to groups; ${money(importSummary.ungrouped_revenue_usd, language)} remains ungrouped.`
    },
    {
      icon: Network,
      tone: topNetworkShare > 70 ? "warning" : "neutral",
      title: copy.concentration,
      body: topNetwork.network_name
        ? language === "vi"
          ? `${topNetwork.network_name} đóng góp ${percentage(topNetworkShare)} doanh thu gộp của tháng.`
          : `${topNetwork.network_name} contributes ${percentage(topNetworkShare)} of monthly gross revenue.`
        : copy.noNetworkData
    },
    {
      icon: importSummary.missing_channels ? AlertTriangle : ShieldCheck,
      tone: importSummary.missing_channels ? "warning" : "positive",
      title: copy.importQuality,
      body: language === "vi"
        ? `${compact(importSummary.imports, language)} file mới nhất trên ${compact(importSummary.imported_networks, language)}/${compact(importSummary.total_networks, language)} network; ${compact(importSummary.missing_channels, language)} kênh thiếu metadata lúc import.`
        : `${compact(importSummary.imports, language)} latest files across ${compact(importSummary.imported_networks, language)}/${compact(importSummary.total_networks, language)} networks; ${compact(importSummary.missing_channels, language)} channels lacked metadata at import.`
    }
  ];

  function openPartnerGroup(partner) {
    if (!partner?.group_id) return;
    navigate(`/groups?group_id=${partner.group_id}&month=${selectedMonth}`);
  }

  function youtubeChannelUrl(channelId) {
    return `https://www.youtube.com/channel/${encodeURIComponent(channelId || "")}`;
  }

  function chooseReportingMonth(nextMonth) {
    setMonthMenuOpen(false);
    if (nextMonth === monthControlValue) {
      window.requestAnimationFrame(() => monthPickerRef.current?.focus());
      return;
    }
    requestDashboard(nextMonth);
    window.requestAnimationFrame(() => monthPickerRef.current?.focus());
  }

  function moveMonthOptionFocus(event) {
    const options = [...(monthMenuRef.current?.querySelectorAll("[data-report-month-option]") || [])];
    const currentIndex = options.indexOf(event.currentTarget);
    let nextIndex;

    if (["ArrowDown", "ArrowRight"].includes(event.key)) nextIndex = (currentIndex + 1) % options.length;
    else if (["ArrowUp", "ArrowLeft"].includes(event.key)) nextIndex = (currentIndex - 1 + options.length) % options.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = options.length - 1;
    else return;

    event.preventDefault();
    options[nextIndex]?.focus();
  }

  function toggleMonthMenu() {
    if (!monthOptions.length) return;
    if (monthMenuOpen) {
      setMonthMenuOpen(false);
      return;
    }
    if (updateMonthMenuPosition()) setMonthMenuOpen(true);
  }

  function openMonthMenuWithKeyboard(event) {
    if (!["ArrowDown", "ArrowUp"].includes(event.key) || !monthOptions.length) return;
    event.preventDefault();
    if (!monthMenuOpen && updateMonthMenuPosition()) setMonthMenuOpen(true);
  }

  function handleMonthMenuTab(event) {
    if (event.key !== "Tab") return;
    event.preventDefault();
    setMonthMenuOpen(false);
    const refreshButton = refreshButtonRef.current;
    const nextTarget = event.shiftKey || refreshButton?.disabled ? monthPickerRef.current : refreshButton;
    window.requestAnimationFrame(() => nextTarget?.focus());
  }

  return (
    <div className="report-overview" aria-busy={loading}>
      <section className="report-overview-hero" aria-labelledby="report-overview-title">
        <div className="report-overview-orb is-one" aria-hidden="true" />
        <div className="report-overview-orb is-two" aria-hidden="true" />
        <div className="report-overview-hero-copy">
          <p className="report-overview-eyebrow"><Sparkles size={15} aria-hidden="true" />{copy.eyebrow}</p>
          <h1 id="report-overview-title">{copy.title}</h1>
          <p className="report-overview-lead">{copy.description}</p>
          <div className="report-overview-model-note"><ShieldCheck size={17} aria-hidden="true" /><span>{copy.modelNote}</span></div>
          <div className="report-overview-hero-actions">
            <Link to="/reports"><FileSpreadsheet size={17} aria-hidden="true" />{copy.openReports}<ChevronRight size={16} aria-hidden="true" /></Link>
            <Link to="/groups"><Layers3 size={17} aria-hidden="true" />{copy.manageGroups}</Link>
          </div>
        </div>
        <div className="report-overview-controls">
          <div className="report-overview-period-card">
            <span><CalendarDays size={18} aria-hidden="true" />{copy.selectedPeriod}</span>
            <strong>{monthLabel(displayMonth, language)}</strong>
            <small className={loading ? "is-loading" : ""} role="status" aria-live="polite"><i />{loading ? copy.updatingPeriod : copy.dataScope}</small>
          </div>
          <div className={`report-overview-month-picker ${monthMenuOpen ? "is-open" : ""}`}>
            <button
              ref={monthPickerRef}
              type="button"
              className="report-overview-month-picker-trigger"
              aria-label={`${copy.month}: ${monthLabel(monthControlValue, language)}`}
              aria-haspopup="listbox"
              aria-expanded={monthMenuOpen}
              aria-controls={monthMenuOpen ? "report-overview-month-options" : undefined}
              disabled={!monthOptions.length}
              onClick={toggleMonthMenu}
              onKeyDown={openMonthMenuWithKeyboard}
            >
              <span className="report-overview-month-picker-icon"><CalendarDays size={18} aria-hidden="true" /></span>
              <span className="report-overview-month-picker-copy"><small>{copy.month}</small><strong>{monthLabel(monthControlValue, language)}</strong></span>
              <span className="report-overview-month-picker-badge"><i />{loading ? copy.updatingPeriod : copy.selectedPeriodBadge}</span>
              <ChevronDown className="report-overview-month-picker-chevron" size={18} aria-hidden="true" />
            </button>
          </div>
          <button ref={refreshButtonRef} type="button" className="report-overview-refresh" onClick={() => requestDashboard(selectedMonth)} disabled={loading} aria-label={copy.refresh} title={copy.refresh}>
            <RefreshCw size={17} className={loading ? "is-spinning" : ""} aria-hidden="true" />
            <span>{copy.refresh}</span>
          </button>
          <p className="report-overview-import-time"><i aria-hidden="true" /><Clock3 size={15} aria-hidden="true" />{copy.latestImport}: <time dateTime={importSummary.latest_imported_at ? `${String(importSummary.latest_imported_at).replace(" ", "T")}Z` : undefined}>{importSummary.latest_imported_at ? dateTime(importSummary.latest_imported_at, language) : copy.noImport}</time></p>
        </div>
        {monthMenuOpen && typeof document !== "undefined" && createPortal(
          <div
            ref={monthMenuRef}
            className={`report-overview-month-menu is-${monthMenuLayout.placement}`}
            style={monthMenuLayout.style}
            onKeyDown={handleMonthMenuTab}
          >
              <div className="report-overview-month-menu-head"><span>{copy.chooseMonth}</span><b>{monthOptions.length}</b></div>
              <div id="report-overview-month-options" className="report-overview-month-options" role="listbox" aria-label={copy.chooseMonth}>
                {monthOptions.map((item) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={item === monthControlValue}
                    tabIndex={item === monthControlValue ? 0 : -1}
                    data-report-month-option
                    className={item === monthControlValue ? "is-selected" : ""}
                    key={item}
                    onClick={() => chooseReportingMonth(item)}
                    onKeyDown={moveMonthOptionFocus}
                  >
                    <span className="report-overview-month-option-index">M{item.slice(5)}</span>
                    <span className="report-overview-month-option-copy"><strong>{monthLabel(item, language)}</strong><small>{item}</small></span>
                    <span className="report-overview-month-option-state">
                      {item === monthOptions[0] && <em>{copy.latestPeriod}</em>}
                      {item === monthControlValue ? <CheckCircle2 size={18} aria-hidden="true" /> : <ChevronRight size={17} aria-hidden="true" />}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          , document.body
        )}
      </section>

      {message && (
        <div className="report-overview-alert" role="alert">
          <AlertTriangle size={19} aria-hidden="true" />
          <span>{message === "load_error" ? copy.loadError : message}</span>
          <button type="button" onClick={() => requestDashboard(failedMonth || selectedMonth)}>{copy.retry}<ArrowRight size={15} aria-hidden="true" /></button>
        </div>
      )}

      <span className="sr-only" aria-live="polite">{loading ? copy.loading : ""}</span>

      {loading && !data ? <LoadingState copy={copy} /> : data ? (
        <>
          <section className="report-overview-metrics" aria-label={copy.title}>
            <MetricCard
              title={copy.grossRevenue}
              value={money(revenue, language)}
              detail={copy.grossRevenueDetail}
              icon={CircleDollarSign}
              tone="revenue"
              delta={change(revenue, previousRevenue)}
              deltaLabel={comparisonLabel}
              language={language}
            />
            <MetricCard
              title={copy.partnerPayable}
              value={money(payable, language)}
              detail={copy.partnerPayableDetail}
              icon={WalletCards}
              tone="payable"
              delta={change(payable, previousPayable)}
              deltaLabel={comparisonLabel}
              neutralDelta
              language={language}
            />
            <MetricCard
              title={copy.retainedRevenue}
              value={money(retained, language)}
              detail={copy.retainedRevenueDetail}
              icon={TrendingUp}
              tone="retained"
              delta={change(retained, previousRetained)}
              deltaLabel={comparisonLabel}
              language={language}
            />
            <MetricCard
              title={copy.retainedMargin}
              value={percentage(retainedMargin)}
              detail={copy.retainedMarginDetail}
              icon={BarChart3}
              tone="margin"
              delta={data?.previous_month && previousRevenue ? retainedMargin - previousMargin : null}
              deltaLabel={comparisonLabel}
              deltaSuffix={copy.percentagePoints}
              language={language}
            />
          </section>

          <section className="report-overview-lifetime" aria-labelledby="report-lifetime-title">
            <div>
              <p>{copy.importedData}</p>
              <h2 id="report-lifetime-title">{copy.lifetimeTitle}</h2>
              <span>{copy.lifetimeDescription}</span>
            </div>
            <dl>
              <div><dt>{copy.lifetimeRevenue}</dt><dd>{money(full.total_revenue_usd, language)}</dd></div>
              <div><dt>{copy.lifetimePayable}</dt><dd>{money(full.total_paid_usd, language)}</dd></div>
              <div><dt>{copy.lifetimeRetained}</dt><dd>{money(full.total_profit_usd, language)}</dd></div>
              <div><dt>{copy.totalPartners}</dt><dd>{compact(counts.total_partners, language)}</dd></div>
              <div><dt>{copy.totalChannels}</dt><dd>{compact(counts.total_channels, language)}</dd></div>
            </dl>
          </section>

          <div className="report-overview-analytics-grid">
            <section className="report-overview-panel report-overview-trend-panel" aria-labelledby="report-trend-title">
              <SectionHeading id="report-trend-title" eyebrow={copy.trendEyebrow} title={copy.trendTitle} description={copy.trendDescription} />
              <TrendChart items={data.trend || []} selectedMonth={selectedMonth} language={language} copy={copy} />
            </section>

            <div className="report-overview-side-stack">
              <section className="report-overview-panel" aria-labelledby="report-network-mix-title">
                <SectionHeading id="report-network-mix-title" eyebrow={copy.networkEyebrow} title={copy.networkTitle} description={copy.networkDescription} />
                <NetworkMix items={networkRows} totalRevenue={revenue} language={language} copy={copy} />
              </section>
              <section className="report-overview-panel" aria-labelledby="report-health-title">
                <SectionHeading id="report-health-title" title={copy.currentHealth} description={copy.healthDescription} />
                <HealthSummary health={health} language={language} copy={copy} />
              </section>
            </div>
          </div>

          <div className="report-overview-decision-grid">
            <section className="report-overview-panel" aria-labelledby="report-insight-title">
              <SectionHeading id="report-insight-title" eyebrow={copy.insightEyebrow} title={copy.insightTitle} description={copy.insightDescription} />
              <div className="report-overview-insights">
                {insights.map((item) => <InsightCard key={item.title} {...item} />)}
              </div>
            </section>

            <section className="report-overview-panel" aria-labelledby="report-data-title">
              <SectionHeading id="report-data-title" eyebrow={copy.dataEyebrow} title={copy.dataTitle} description={copy.dataDescription} />
              <div className="report-overview-coverage-grid">
                <CoverageMetric label={copy.revenueCoverage} value={revenueCoverage} detail={`${money(importSummary.grouped_revenue_usd, language)} / ${money(revenue, language)}`} />
                <CoverageMetric label={copy.channelCoverage} value={channelCoverage} detail={`${compact(importSummary.grouped_channels, language)} / ${compact(importSummary.revenue_channels, language)} ${copy.channels}`} tone="blue" />
                <CoverageMetric label={copy.networkCoverage} value={networkCoverage} detail={`${compact(importSummary.imported_networks, language)} / ${compact(importSummary.total_networks, language)} ${copy.network}`} tone="violet" />
              </div>
              <div className={`report-overview-gap-note ${importSummary.missing_channels ? "has-gap" : "is-clear"}`}>
                {importSummary.missing_channels ? <AlertTriangle size={18} aria-hidden="true" /> : <CheckCircle2 size={18} aria-hidden="true" />}
                <div><strong>{compact(importSummary.missing_channels, language)} {copy.metadataGaps}</strong><span>{copy.metadataGapNote}</span></div>
              </div>
              <div className="report-overview-imports">
                <h3>{copy.recentImports}<span>{compact(importSummary.import_history, language)} {copy.files}</span></h3>
                {(importSummary.recent_imports || []).length ? importSummary.recent_imports.map((item) => (
                  <article key={item.id}>
                    <span><FileSpreadsheet size={18} aria-hidden="true" /></span>
                    <div><strong>{item.network_name}</strong><small>{item.file_name || monthLabel(selectedMonth, language)} · {dateTime(item.imported_at, language)}</small></div>
                    <p>{compact(item.channel_count, language)} {copy.channels}<b>{money(item.total_revenue_usd, language)}</b></p>
                  </article>
                )) : <div className="report-overview-empty is-compact">{copy.noRecentImports}</div>}
              </div>
            </section>
          </div>

          <section className="report-overview-panel" aria-labelledby="report-network-performance-title">
            <SectionHeading id="report-network-performance-title" title={copy.networkPerformance} description={copy.networkPerformanceDescription} action={<span className="report-overview-period-chip">{monthLabel(selectedMonth, language)}</span>} />
            {networkRows.length ? (
              <div className="report-overview-table-scroll">
                <table className="report-overview-network-table">
                  <caption className="sr-only">{copy.networkPerformance}</caption>
                  <thead><tr><th scope="col">{copy.network}</th><th scope="col">{copy.gross}</th><th scope="col">{copy.payable}</th><th scope="col">{copy.retained}</th><th scope="col">{copy.margin}</th></tr></thead>
                  <tbody>
                    {networkRows.map((item, index) => {
                      const networkRetained = numeric(item.profit_usd);
                      const networkMargin = ratio(networkRetained, item.revenue_usd);
                      return (
                        <tr key={item.network_name}>
                          <td>
                            <div className="report-overview-network-name"><i style={{ backgroundColor: NETWORK_COLORS[index % NETWORK_COLORS.length] }} /><span><strong>{item.network_name}</strong><small>{percentage(ratio(item.revenue_usd, revenue))} {copy.shareOfMonth}</small></span></div>
                            <div className="report-overview-network-bar" aria-hidden="true"><i style={{ "--report-progress": `${ratio(item.revenue_usd, maxNetworkRevenue)}%`, backgroundColor: NETWORK_COLORS[index % NETWORK_COLORS.length] }} /></div>
                          </td>
                          <td>{money(item.revenue_usd, language)}</td>
                          <td>{money(item.paid_usd, language)}</td>
                          <td>{money(networkRetained, language)}</td>
                          <td><span className={`report-overview-margin-chip ${networkMargin >= 0 ? "is-positive" : "is-negative"}`}>{percentage(networkMargin)}</span></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : <div className="report-overview-empty">{copy.noNetworkData}</div>}
          </section>

          <div className="report-overview-ranking-grid">
            <section className="report-overview-panel" aria-labelledby="report-partner-ranking-title">
              <SectionHeading id="report-partner-ranking-title" title={copy.partnerRanking} description={copy.partnerRankingDescription} action={<UsersRound size={22} aria-hidden="true" />} />
              <div className="report-overview-ranking-list">
                {topPartners.length ? topPartners.map((partner, index) => (
                  <button type="button" key={`${partner.partner_id}-${index}`} onClick={() => openPartnerGroup(partner)} className="report-overview-ranking-row" title={partner.group_name || partner.partner_name}>
                    <span className="report-overview-rank">{String(index + 1).padStart(2, "0")}</span>
                    <div className="report-overview-ranking-copy">
                      <strong>{partner.partner_name}</strong>
                      <small>{partner.group_name || "—"} · {compact(partner.channels, language)} {copy.channels}</small>
                      <i aria-hidden="true"><b style={{ "--report-progress": `${ratio(partner.paid_usd, maxPartnerPayable)}%` }} /></i>
                    </div>
                    <div className="report-overview-ranking-value"><strong>{money(partner.paid_usd, language)}</strong><small>{copy.modeledGross}: {money(partner.revenue_usd, language)}</small></div>
                    <ChevronRight size={17} aria-hidden="true" />
                  </button>
                )) : <div className="report-overview-empty">{copy.noPartnerData}</div>}
              </div>
            </section>

            <section className="report-overview-panel" aria-labelledby="report-channel-ranking-title">
              <SectionHeading id="report-channel-ranking-title" title={copy.channelRanking} description={`${copy.channelRankingDescription} ${percentage(topChannelShare)} ${copy.shareOfMonth}.`} action={<Video size={22} aria-hidden="true" />} />
              <div className="report-overview-ranking-list">
                {topChannels.length ? topChannels.map((channel, index) => (
                  <a
                    key={`${channel.channel_id}-${index}`}
                    className="report-overview-channel-row"
                    href={youtubeChannelUrl(channel.channel_id)}
                    target="_blank"
                    rel="noreferrer"
                    title={copy.openYoutube}
                    aria-label={`${copy.openYoutube}: ${channel.title}, ${money(channel.revenue_usd, language)}`}
                  >
                    <span className="report-overview-channel-avatar" aria-hidden="true">
                      {channel.thumbnail ? <img src={channel.thumbnail} alt="" /> : <span>{initials(channel.title)}</span>}
                    </span>
                    <div className="report-overview-ranking-copy">
                      <strong>{String(index + 1).padStart(2, "0")}. {channel.title}</strong>
                      <small>{channel.channel_id}</small>
                      <i aria-hidden="true"><b style={{ "--report-progress": `${ratio(channel.revenue_usd, maxChannelRevenue)}%` }} /></i>
                    </div>
                    <div className="report-overview-ranking-value"><strong>{money(channel.revenue_usd, language)}</strong><small>{percentage(ratio(channel.revenue_usd, revenue))} {copy.shareOfMonth}</small></div>
                    <ExternalLink size={16} aria-hidden="true" />
                  </a>
                )) : <div className="report-overview-empty">{copy.noChannelData}</div>}
              </div>
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}
