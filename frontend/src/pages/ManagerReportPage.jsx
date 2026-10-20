import { useEffect, useRef, useState } from "react";
import { AlertCircle, Calendar, FileSpreadsheet, Loader2, Network, RefreshCw, Trash2, Upload } from "lucide-react";
import api from "../api/api";
import { useSystemSettings } from "../context/SystemSettingsContext";
import { useI18n } from "../context/I18nContext";
// tk marks the canonical English of stored messages (identity); taking it from the index keeps the
// fetch helpers free of hook values. formatDate renders the range / month labels in the UI language.
import { formatDate, tk } from "../i18n/index.js";
import { revenueTaxFlags } from "../utils/revenueTax";

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function toDateInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function monthLabel(month, language) {
  const [year, monthIndex] = month.split("-").map(Number);
  return formatDate(new Date(year, monthIndex - 1, 1), language, {
    month: "long",
    year: "numeric"
  });
}

function recentMonths(count = 10) {
  const now = new Date();
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth() - index, 1);
    return toDateInput(date).slice(0, 7);
  });
}

function rangeLabel(startDate, endDate, language) {
  const format = (value) => formatDate(new Date(value), language, {
    month: "short",
    day: "2-digit",
    year: "numeric"
  });
  return `${format(startDate)} - ${format(endDate)}`;
}

function money(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2
  }).format(Number(value || 0));
}

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function ManagerReportPage() {
  const { settings } = useSystemSettings();
  const { t, tm, language } = useI18n();
  const revenueTax = revenueTaxFlags(settings);
  const revenueTaxEnabled = revenueTax.any;
  const taxCardCount = (revenueTax.us ? 1 : 0) + (revenueTax.br ? 1 : 0);
  // Shown before importing whenever a tax is on, so the operator checks the file has the matching column(s).
  const taxColumnsReminder = revenueTax.us && revenueTax.br
    ? t("US and BR tax are on: check that the file has the Revenue US and Revenue BR columns before importing.")
    : revenueTax.us
      ? t("US tax is on: check that the file has a Revenue US column before importing.")
      : revenueTax.br
        ? t("BR tax is on: check that the file has a Revenue BR column before importing.")
        : "";
  const today = new Date();
  const [month, setMonth] = useState(currentMonth());
  const [rangeStart, setRangeStart] = useState(toDateInput(startOfMonth(today)));
  const [rangeEnd, setRangeEnd] = useState(toDateInput(today));
  const [rangeOpen, setRangeOpen] = useState(false);
  const rangeRef = useRef(null);
  const [networks, setNetworks] = useState([]);
  const [networkId, setNetworkId] = useState("");
  const [file, setFile] = useState(null);
  const [summary, setSummary] = useState({ rows: [], history: [], total_rows: 0, total_revenue: 0 });
  const [loading, setLoading] = useState(false);
  const [pageLoading, setPageLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [missing, setMissing] = useState([]);
  // Taxes that are on but had no column in the last imported file ("us" / "br"), with the month it concerns.
  const [missingTaxColumns, setMissingTaxColumns] = useState({ month: "", kinds: [] });
  const [quota, setQuota] = useState(null);

  async function fetchNetworks() {
    try {
      const res = await api.get("/reports/networks");
      const items = res.data.data || [];
      setNetworks(items);
      setNetworkId((current) => current || String(items[0]?.id || ""));
    } catch (error) {
      setMessage(error.response?.data?.message || tk("Could not load the networks"));
    }
  }

  async function fetchQuota() {
    try {
      const res = await api.get("/reports/youtube/quota");
      setQuota(res.data.data || null);
    } catch {
      setQuota(null);
    }
  }

  async function fetchSummary(selectedMonth = month, selectedNetwork = networkId) {
    try {
      setPageLoading(true);
      const res = await api.get("/reports/manager", {
        params: {
          month: selectedMonth,
          month_from: rangeStart.slice(0, 7),
          month_to: rangeEnd.slice(0, 7),
          network_id: selectedNetwork
        }
      });
      setSummary(res.data.data || { rows: [], history: [], total_rows: 0, total_revenue: 0 });
    } catch (error) {
      setMessage(error.response?.data?.message || tk("Could not load the report"));
    } finally {
      setPageLoading(false);
    }
  }

  async function handleImport(e) {
    e.preventDefault();

    if (!networkId) {
      setMessage(tk("Select a network before importing"));
      return;
    }

    if (!file) {
      setMessage(tk("Select an Excel or CSV file"));
      return;
    }

    try {
      setLoading(true);
      setMessage("");
      setMissing([]);
      setMissingTaxColumns({ month: "", kinds: [] });

      const fileBase64 = await toBase64(file);
      const res = await api.post("/reports/manager/import", {
        month,
        network_id: networkId,
        fileName: file.name,
        fileBase64
      });

      setMessage(res.data.message || tk("Report imported"));
      setMissing(res.data.data?.missing_channels || []);
      setMissingTaxColumns({ month, kinds: res.data.data?.missing_tax_columns || [] });
      setFile(null);
      await fetchSummary(month, networkId);
      await fetchQuota();
    } catch (error) {
      const detail = error.response?.data?.error || error.response?.data?.message || tk("Could not import the report");
      setMessage(detail);
      await fetchQuota();
    } finally {
      setLoading(false);
    }
  }

  async function handleDeleteImport() {
    if (!networkId) {
      setMessage(tk("Select the network whose import should be deleted"));
      return;
    }

    const network = networks.find((item) => String(item.id) === String(networkId));
    const ok = window.confirm(t("Delete the whole {month} import of network {network}?", { month, network: network?.name || networkId }));

    if (!ok) return;

    try {
      setLoading(true);
      const res = await api.delete("/reports/manager", {
        data: {
          month,
          network_id: networkId
        }
      });
      setMessage(res.data.message || tk("Import deleted"));
      await fetchSummary(month, networkId);
    } catch (error) {
      setMessage(error.response?.data?.message || error.response?.data?.error || tk("Could not delete the import"));
    } finally {
      setLoading(false);
    }
  }

  function applyRange(label) {
    const now = new Date();
    let start = startOfMonth(now);
    let end = now;

    if (label === "last-month") {
      start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      end = new Date(now.getFullYear(), now.getMonth(), 0);
    }

    if (label === "this-quarter") {
      const quarterStart = Math.floor(now.getMonth() / 3) * 3;
      start = new Date(now.getFullYear(), quarterStart, 1);
    }

    if (label === "last-quarter") {
      const quarterStart = Math.floor(now.getMonth() / 3) * 3 - 3;
      start = new Date(now.getFullYear(), quarterStart, 1);
      end = new Date(now.getFullYear(), quarterStart + 3, 0);
    }

    if (label === "this-year") {
      start = new Date(now.getFullYear(), 0, 1);
    }

    if (label === "last-year") {
      start = new Date(now.getFullYear() - 1, 0, 1);
      end = new Date(now.getFullYear() - 1, 11, 31);
    }

    setRangeStart(toDateInput(start));
    setRangeEnd(toDateInput(end));
    setMonth(toDateInput(start).slice(0, 7));
    setRangeOpen(false);
  }

  function applySingleMonth(selectedMonth) {
    const [year, monthIndex] = selectedMonth.split("-").map(Number);
    const start = new Date(year, monthIndex - 1, 1);
    const end = new Date(year, monthIndex, 0);
    setRangeStart(toDateInput(start));
    setRangeEnd(toDateInput(end));
    setMonth(selectedMonth);
    setRangeOpen(false);
  }

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchNetworks();
      fetchQuota();
    }, 0);

    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchSummary(month, networkId);
    }, 0);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, networkId, rangeStart, rangeEnd]);

  // The range picker closes when a preset or a recent month is picked (above), on Escape, or on a click outside.
  useEffect(() => {
    if (!rangeOpen) return undefined;
    function handlePointerDown(event) {
      if (rangeRef.current && !rangeRef.current.contains(event.target)) setRangeOpen(false);
    }
    function handleKeyDown(event) {
      if (event.key === "Escape") setRangeOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [rangeOpen]);

  return (
    <div className="p-5 lg:p-8">
      <div className="flex flex-col xl:flex-row xl:items-end xl:justify-between gap-5 mb-7">
        <div>
          <div className="inline-flex items-center gap-2 bg-emerald-50 text-emerald-700 px-4 py-2 rounded-full text-sm font-bold mb-4">
            <FileSpreadsheet size={18} />
            {t("Manager report")}
          </div>
          <h1 className="text-3xl lg:text-4xl font-black text-slate-900">{t("Manager Report")}</h1>
          <p className="text-slate-500 mt-2">
            {t("The import file needs a Channel ID and a Revenue column. Channel IDs missing the UC prefix are completed before the YouTube Data API v3 update.")}
          </p>
          {revenueTaxEnabled && (
            <p className="mt-3 inline-flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm font-semibold text-amber-800">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <span>{taxColumnsReminder}</span>
            </p>
          )}
        </div>

        <form onSubmit={handleImport} className="bg-white border border-slate-200 rounded-3xl p-3 shadow-sm grid sm:grid-cols-[330px_220px_1fr_auto] gap-3 w-full xl:w-[1160px]">
          <div className="relative" ref={rangeRef}>
            <button
              type="button"
              onClick={() => setRangeOpen((value) => !value)}
              className="w-full flex items-center justify-between gap-2 bg-white border border-slate-900 rounded-2xl px-4 py-3 text-left text-slate-700"
            >
              <span className="flex items-center gap-2">
                <Calendar size={18} className="text-slate-500" />
                {rangeLabel(rangeStart, rangeEnd, language)}
              </span>
              <span className="text-slate-500">{rangeOpen ? "⌃" : "⌄"}</span>
            </button>

            {rangeOpen && (
              <div className="absolute left-0 top-[58px] z-30 w-[620px] max-w-[calc(100vw-48px)] rounded-3xl border border-slate-200 bg-white p-5 shadow-2xl">
                <div className="flex flex-wrap gap-3 mb-4">
                  {[
                    ["this-month", t("This month")],
                    ["last-month", t("Last month")],
                    ["this-quarter", t("This quarter")],
                    ["last-quarter", t("Last quarter")],
                    ["this-year", t("This year")],
                    ["last-year", t("Last year")]
                  ].map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => applyRange(key)}
                      className="rounded-full border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-900 hover:text-white"
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <div className="grid sm:grid-cols-2 gap-3 mb-4">
                  <label className="text-sm text-slate-500">
                    {t("From")}
                    <input
                      type="date"
                      value={rangeStart}
                      onChange={(e) => {
                        setRangeStart(e.target.value);
                        setMonth(e.target.value.slice(0, 7));
                      }}
                      className="mt-1 w-full rounded-2xl border border-slate-200 px-4 py-3 text-slate-800"
                    />
                  </label>
                  <label className="text-sm text-slate-500">
                    {t("To")}
                    <input
                      type="date"
                      value={rangeEnd}
                      onChange={(e) => setRangeEnd(e.target.value)}
                      className="mt-1 w-full rounded-2xl border border-slate-200 px-4 py-3 text-slate-800"
                    />
                  </label>
                </div>

                <p className="text-xs font-black uppercase tracking-widest text-slate-400 mb-3">{t("Recent months")}</p>
                <div className="flex flex-wrap gap-3">
                  {recentMonths(12).map((recentMonth) => (
                    <button
                      key={recentMonth}
                      type="button"
                      onClick={() => applySingleMonth(recentMonth)}
                      className="rounded-full border border-slate-200 px-4 py-2 text-sm text-slate-700 hover:border-blue-200 hover:bg-blue-50"
                    >
                      {monthLabel(recentMonth, language)}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <label className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-2xl px-4">
            <Network size={18} className="text-slate-500 shrink-0" />
            <select
              value={networkId}
              onChange={(e) => setNetworkId(e.target.value)}
              className="w-full bg-transparent py-3 outline-none"
            >
              <option value="">{t("Select a network")}</option>
              {networks.map((network) => (
                <option key={network.id} value={network.id}>{network.name}</option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-3 bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 min-w-0">
            <Upload size={18} className="text-slate-500 shrink-0" />
            <span className="truncate text-slate-600">{file?.name || t("Choose a .xlsx or .csv file")}</span>
            <input
              type="file"
              accept=".xlsx,.csv"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
            />
          </label>

          <button
            type="submit"
            disabled={loading}
            className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white rounded-2xl px-5 py-3 font-bold flex items-center justify-center gap-2"
          >
            {loading ? <Loader2 className="animate-spin" size={18} /> : <Upload size={18} />}
            {t("Import")}
          </button>
        </form>
      </div>

      {message && (
        <div className="mb-5 bg-blue-50 border border-blue-100 text-blue-700 rounded-2xl px-5 py-4 font-medium">
          {tm(message)}
        </div>
      )}

      {missing.length > 0 && (
        <div className="mb-5 bg-amber-50 border border-amber-100 text-amber-800 rounded-2xl px-5 py-4">
          <div className="flex items-center gap-2 font-bold mb-2">
            <AlertCircle size={18} />
            {t("Channels not found on YouTube")}
          </div>
          <p className="text-sm break-words">{missing.join(", ")}</p>
        </div>
      )}

      {missingTaxColumns.kinds.length > 0 && (
        <div className="mb-5 bg-amber-50 border border-amber-100 text-amber-800 rounded-2xl px-5 py-4">
          <div className="flex items-center gap-2 font-bold mb-2">
            <AlertCircle size={18} />
            {t("Tax column missing in the imported file")}
          </div>
          <p className="text-sm">
            {missingTaxColumns.kinds.includes("us") && missingTaxColumns.kinds.includes("br")
              ? t("The file imported for {month} has neither a Revenue US nor a Revenue BR column, so US and BR tax for that month are calculated on 0. Import a file that has the columns to correct it.", { month: missingTaxColumns.month })
              : missingTaxColumns.kinds.includes("us")
                ? t("The file imported for {month} has no Revenue US column, so US tax for that month is calculated on 0. Import a file that has the column to correct it.", { month: missingTaxColumns.month })
                : t("The file imported for {month} has no Revenue BR column, so BR tax for that month is calculated on 0. Import a file that has the column to correct it.", { month: missingTaxColumns.month })}
          </p>
        </div>
      )}

      <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-white border border-slate-200 rounded-3xl px-5 py-4 shadow-sm">
        <div>
          <p className="font-black text-slate-900">{t("Import by network")}</p>
          <p className="text-sm text-slate-500">{t("The data is filtered by the selected month and network.")}</p>
        </div>
        <button
          type="button"
          onClick={handleDeleteImport}
          disabled={loading || !networkId}
          className="bg-red-50 hover:bg-red-100 disabled:opacity-50 text-red-600 rounded-2xl px-4 py-3 font-bold flex items-center justify-center gap-2"
        >
          <Trash2 size={17} />
          {t("Delete this month's import")}
        </button>
      </div>

      <div className={`grid ${taxCardCount === 2 ? "md:grid-cols-5" : taxCardCount === 1 ? "md:grid-cols-4" : "md:grid-cols-3"} gap-4 mb-6`}>
        <div className="bg-slate-900 text-white rounded-3xl p-5 shadow-sm">
          <p className="text-sm text-slate-300">{t("Month")}</p>
          <p className="text-3xl font-black mt-4">{month}</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-3xl p-5 shadow-sm">
          <p className="text-sm text-slate-500">{t("Rows")}</p>
          <p className="text-3xl font-black mt-4">{summary.total_rows}</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-3xl p-5 shadow-sm">
          <p className="text-sm text-slate-500">{t("Total Revenue")}</p>
          <p className="text-3xl font-black mt-4 text-emerald-700">{money(summary.total_revenue)}</p>
        </div>
        {revenueTax.us && (
          <div className="bg-white border border-slate-200 rounded-3xl p-5 shadow-sm">
            <p className="text-sm text-slate-500">{t("Revenue US")}</p>
            <p className="text-3xl font-black mt-4 text-blue-700">{money(summary.total_revenue_us || 0)}</p>
          </div>
        )}
        {revenueTax.br && (
          <div className="bg-white border border-slate-200 rounded-3xl p-5 shadow-sm">
            <p className="text-sm text-slate-500">{t("Revenue BR")}</p>
            <p className="text-3xl font-black mt-4 text-indigo-700">{money(summary.total_revenue_br || 0)}</p>
          </div>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-3xl shadow-sm p-5 mb-6">
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="font-black text-slate-900">{t("YouTube API quota")}</h2>
              <span className="text-xs font-bold bg-slate-100 text-slate-500 px-2 py-1 rounded-full">{quota?.api_key || t("No key")}</span>
            </div>
            <p className="text-sm text-slate-500 mt-1">
              {t("Estimated quota used by this backend since it started. Google does not expose exact project quota through an API key.")}
            </p>
          </div>
          <button type="button" onClick={fetchQuota} className="rounded-2xl border border-slate-200 px-4 py-3 font-bold flex items-center justify-center gap-2">
            <RefreshCw size={16} />
            {t("Refresh quota")}
          </button>
        </div>

        <div className="grid md:grid-cols-3 gap-4 mt-5">
          <div className="rounded-2xl bg-slate-50 border border-slate-100 p-4">
            <p className="text-xs uppercase font-black text-slate-400">{t("Estimated used")}</p>
            <p className="text-2xl font-black text-slate-900 mt-2">{quota?.estimated_used ?? 0}</p>
          </div>
          <div className="rounded-2xl bg-slate-50 border border-slate-100 p-4">
            <p className="text-xs uppercase font-black text-slate-400">{t("Estimated remaining")}</p>
            <p className="text-2xl font-black text-emerald-700 mt-2">{quota?.estimated_remaining ?? 0}</p>
          </div>
          <div className="rounded-2xl bg-slate-50 border border-slate-100 p-4">
            <p className="text-xs uppercase font-black text-slate-400">{t("Daily limit")}</p>
            <p className="text-2xl font-black text-slate-900 mt-2">{quota?.daily_limit ?? 10000}</p>
          </div>
        </div>

        {quota?.last_error && (
          <div className="mt-4 rounded-2xl border border-red-100 bg-red-50 p-4 text-sm">
            <p className="font-black text-red-700">{t("Last YouTube error")}</p>
            <p className="text-red-700 mt-1">
              {quota.last_error.status || quota.last_error.code} {quota.last_error.reason ? `- ${quota.last_error.reason}` : ""}
            </p>
            <p className="text-red-600 mt-1 break-words">{tm(quota.last_error.message)}</p>
          </div>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-3xl shadow-sm overflow-hidden mb-6">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <h2 className="font-black text-slate-900">{t("Import History")}</h2>
          <span className="text-xs font-bold text-slate-500 bg-slate-100 px-3 py-1 rounded-full">
            {(summary.history?.length || 0) === 1
              ? t("{count} import", { count: summary.history?.length || 0 })
              : t("{count} imports", { count: summary.history?.length || 0 })}
          </span>
        </div>

        {!summary.history?.length ? (
          <div className="p-8 text-center text-slate-500">{t("No import history for this month / network yet.")}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="text-left px-5 py-3">{t("File")}</th>
                  <th className="text-left px-5 py-3">{t("Network")}</th>
                  <th className="text-left px-5 py-3">{t("Imported at")}</th>
                  <th className="text-right px-5 py-3">{t("Channels")}</th>
                  <th className="text-right px-5 py-3">{t("Total Revenue")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {summary.history.map((item) => (
                  <tr key={item.id} className="hover:bg-slate-50">
                    <td className="px-5 py-4 font-bold text-slate-800">{item.file_name}</td>
                    <td className="px-5 py-4 text-slate-600">{item.network_name}</td>
                    <td className="px-5 py-4 text-slate-500">{item.imported_at}</td>
                    <td className="px-5 py-4 text-right font-black">{item.channel_count}</td>
                    <td className="px-5 py-4 text-right font-black text-emerald-700">{money(item.total_revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-3xl shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <h2 className="font-black text-slate-900">{t("Imported Channels")}</h2>
          <span className="text-xs font-bold text-slate-500 bg-slate-100 px-3 py-1 rounded-full">
            {summary.rows.length === 1 ? t("{count} row", { count: summary.rows.length }) : t("{count} rows", { count: summary.rows.length })}
          </span>
        </div>

        {pageLoading ? (
          <div className="py-16 flex justify-center">
            <Loader2 className="animate-spin text-emerald-600" size={34} />
          </div>
        ) : summary.rows.length === 0 ? (
          <div className="p-12 text-center text-slate-500">{t("No report data for this month yet.")}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="text-left px-5 py-3">{t("Channel")}</th>
                  <th className="text-left px-5 py-3">{t("Network")}</th>
                  <th className="text-left px-5 py-3">{t("Channel ID")}</th>
                  <th className="text-right px-5 py-3">{t("Revenue")}</th>
                  {revenueTax.us && <th className="text-right px-5 py-3">{t("Revenue US")}</th>}
                  {revenueTax.br && <th className="text-right px-5 py-3">{t("Revenue BR")}</th>}
                  <th className="text-left px-5 py-3">{t("File")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {summary.rows.map((row) => (
                  <tr key={`${row.month}-${row.channel_id}`} className="hover:bg-slate-50">
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-3 min-w-[240px]">
                        <img src={row.thumbnail || "/favicon.svg"} className="w-10 h-10 rounded-xl object-cover bg-slate-100" />
                        <span className="font-bold text-slate-800">{row.title || t("Waiting for YouTube data")}</span>
                      </div>
                    </td>
                    <td className="px-5 py-4 text-slate-600">{row.network_name || "-"}</td>
                    <td className="px-5 py-4 font-mono text-xs text-emerald-700">{row.channel_id}</td>
                    <td className="px-5 py-4 text-right font-black">{money(row.revenue)}</td>
                    {revenueTax.us && <td className="px-5 py-4 text-right font-black text-blue-700">{money(row.revenue_us || 0)}</td>}
                    {revenueTax.br && <td className="px-5 py-4 text-right font-black text-indigo-700">{money(row.revenue_br || 0)}</td>}
                    <td className="px-5 py-4 text-slate-500">{row.source_file || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
