import { useMemo } from "react";
import { useI18n } from "../../../context/I18nContext";
import { cx } from "../../assetDelivery/utils";
import { BarList } from "../charts";
import { useAnalytics } from "../hooks";
import { ErrorPanel, MetricTable } from "../shared";
import { REPORT_DESCRIPTIONS, REPORT_LABELS, dimensionValueLabel, formatMetric, numberValue } from "../analyticsUtils";
import { BreakdownPanel, SnapshotPanel, ViewPlaceholder } from "./ContentView";

// Audience view: where the viewers are (countries), how they arrive (traffic sources), what they watch on (devices,
// operating systems), whether they subscribe, who they are (age & gender snapshot) and where they share.

const COUNTRY_METRICS = ["views", "engagedViews", "watchHours", "likes", "comments", "shares", "subscribersGained", "subscribersLost"];
const WATCH_METRICS = ["views", "engagedViews", "watchHours"];
const SHARE_METRICS = ["shares"];
const GENDER_ORDER = ["female", "male", "user_specified"];

const genderRank = (gender) => (GENDER_ORDER.includes(gender) ? GENDER_ORDER.indexOf(gender) : GENDER_ORDER.length);

// Age & gender rows ({ ageGroup, gender, viewerPercentage }) → one row per age group with a column per gender.
function demographicsTable(rows) {
  const byAge = new Map();
  const genders = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const age = String(row?.ageGroup ?? "");
    const gender = String(row?.gender ?? "");
    const value = numberValue(row?.viewerPercentage);
    if (!age || !gender || value === null) continue;
    genders.add(gender);
    const label = dimensionValueLabel(age, "ageGroup");
    const entry = byAge.get(age) || { id: age, label, total: 0 };
    entry[gender] = (entry[gender] ?? 0) + value;
    entry.total += value;
    byAge.set(age, entry);
  }
  return {
    genders: [...genders].sort((a, b) => genderRank(a) - genderRank(b) || a.localeCompare(b)),
    rows: [...byAge.values()].sort((a, b) => a.id.localeCompare(b.id))
  };
}

function DemographicsBody({ table }) {
  const { t, language } = useI18n();
  const percent = (value) => formatMetric(value, "viewerPercentage", { language });
  const columns = [
    { key: "label", label: t("Age group"), format: (value) => <span className="font-bold text-slate-800">{value}</span> },
    ...table.genders.map((gender) => ({ key: gender, label: t(dimensionValueLabel(gender, "gender")), align: "right", format: percent })),
    { key: "total", label: t("Total"), align: "right", format: percent }
  ];
  return (
    <div className="space-y-4">
      <BarList rows={table.rows.map((row) => ({ key: row.id, label: row.label, value: row.total }))} format={percent} title={t("Viewer percentage")} />
      <MetricTable columns={columns} rows={table.rows} rowKey="id" />
    </div>
  );
}

export default function AudienceView() {
  const { t } = useI18n();
  const { overview, overviewLoading, overviewError, refresh, filters } = useAnalytics();
  const demographics = useMemo(() => demographicsTable(overview?.demographics?.rows), [overview]);
  if (!overview) return <ViewPlaceholder loading={overviewLoading} error={overviewError} onRetry={refresh} ownerId={filters.ownerId} />;

  const breakdowns = overview.breakdowns || {};
  const demographicsCsv = {
    columns: [
      { key: "ageGroup", label: t("Age group"), value: (row) => dimensionValueLabel(row.ageGroup, "ageGroup") },
      { key: "gender", label: t("Gender"), value: (row) => t(dimensionValueLabel(row.gender, "gender")) },
      { key: "viewerPercentage", label: t("Viewer percentage") }
    ],
    rows: Array.isArray(overview.demographics?.rows) ? overview.demographics.rows : [],
    filename: `analytics-demographics-${filters.ownerId}-${filters.startDate}-${filters.endDate}.csv`
  };

  return (
    <div className={cx("space-y-5", overviewLoading && "opacity-60")} aria-busy={overviewLoading || undefined}>
      {overviewError && <ErrorPanel error={overviewError} onRetry={refresh} />}
      <BreakdownPanel
        dimension="country"
        title={t(REPORT_LABELS.countries)}
        subtitle={t(REPORT_DESCRIPTIONS.countries)}
        breakdown={breakdowns.country}
        metrics={COUNTRY_METRICS}
      />
      <div className="grid gap-5 xl:grid-cols-2">
        <BreakdownPanel
          dimension="insightTrafficSourceType"
          title={t(REPORT_LABELS.trafficSources)}
          subtitle={t(REPORT_DESCRIPTIONS.trafficSources)}
          breakdown={breakdowns.insightTrafficSourceType}
          metrics={WATCH_METRICS}
        />
        <BreakdownPanel
          dimension="deviceType"
          title={t(REPORT_LABELS.devices)}
          subtitle={t(REPORT_DESCRIPTIONS.devices)}
          breakdown={breakdowns.deviceType}
          metrics={WATCH_METRICS}
          chart="donut"
        />
        <BreakdownPanel
          dimension="operatingSystem"
          title={t(REPORT_LABELS.operatingSystems)}
          subtitle={t(REPORT_DESCRIPTIONS.operatingSystems)}
          breakdown={breakdowns.operatingSystem}
          metrics={WATCH_METRICS}
        />
        <BreakdownPanel
          dimension="subscribedStatus"
          title={t(REPORT_LABELS.subscribedStatus)}
          subtitle={t(REPORT_DESCRIPTIONS.subscribedStatus)}
          breakdown={breakdowns.subscribedStatus}
          metrics={WATCH_METRICS}
        />
        <SnapshotPanel
          title={t(REPORT_LABELS.demographics)}
          subtitle={t(REPORT_DESCRIPTIONS.demographics)}
          snapshot={overview.demographics}
          csv={demographicsCsv}
        >
          <DemographicsBody table={demographics} />
        </SnapshotPanel>
        <BreakdownPanel
          dimension="sharingService"
          title={t(REPORT_LABELS.sharing)}
          subtitle={t(REPORT_DESCRIPTIONS.sharing)}
          breakdown={breakdowns.sharingService}
          metrics={SHARE_METRICS}
        />
      </div>
    </div>
  );
}
