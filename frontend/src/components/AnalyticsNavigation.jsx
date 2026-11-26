import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Activity, ChevronDown } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../context/I18nContext";
import { useSystemSettings } from "../context/SystemSettingsContext";
import { ANALYTICS_SECTIONS } from "../pages/analytics/analyticsUtils";

// Sidebar entry of the Analytics module: one link per section (Revenue only for the monetary roles). Links keep the
// current ?owner=&start=&end=… while the user is inside /analytic so the filters follow the navigation.
export default function AnalyticsNavigation({ collapsed = false, dark = false }) {
  const { pathname, search } = useLocation();
  const { t } = useI18n();
  const { isSidebarVisible } = useSystemSettings();
  const { isAdmin, isReportManager } = useAuth() || {};
  const canMonetary = Boolean(isAdmin || isReportManager);
  const active = pathname === "/analytic" || pathname.startsWith("/analytic/");
  const query = active ? search : "";
  const [expanded, setExpanded] = useState(active);
  // The submenu follows the route: it opens when the user enters /analytic (Home tile, redirect, link) and closes
  // when they leave; the manual toggle only overrides it while the route stays on the same side (React's
  // "adjust state on prop change" pattern, no effect).
  const [routeActive, setRouteActive] = useState(active);
  if (routeActive !== active) {
    setRouteActive(active);
    setExpanded(active);
  }
  const passive = dark ? "text-slate-300 hover:bg-slate-800" : "text-slate-700 hover:bg-slate-100";
  const triggerClass = `w-full flex items-center gap-3 px-4 py-3 rounded-2xl transition-all ${active ? "bg-indigo-600 text-white shadow-lg shadow-indigo-900/25" : passive}`;
  const sections = ANALYTICS_SECTIONS.filter((section) =>
    (!section.monetary || canMonetary) && isSidebarVisible(`/analytic/${section.path}`));
  if (!sections.length) return null;

  return (
    <div>
      {collapsed ? (
        <Link to={`/analytic/${sections[0].path}${query}`} title={t("Analytic")} aria-label={t("Analytic")} className={triggerClass}><Activity size={20} /></Link>
      ) : (
        <button type="button" className={triggerClass} onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} aria-controls="analytic-sidebar-menu">
          <Activity size={20} /><span className="font-medium flex-1 text-left">{t("Analytic")}</span>
          <ChevronDown size={17} className={`transition ${expanded ? "rotate-180" : ""}`} />
        </button>
      )}
      {expanded && !collapsed && (
        <div id="analytic-sidebar-menu" className={`mt-2 ml-6 space-y-1 border-l pl-3 ${dark ? "border-slate-700" : "border-slate-200"}`}>
          {sections.map((section) => {
            const Icon = section.icon;
            const href = `/analytic/${section.path}`;
            const selected = pathname === href || pathname.startsWith(`${href}/`) || (section.key === "overview" && pathname === "/analytic");
            return (
              <Link key={section.key} to={`${href}${query}`} aria-current={selected ? "page" : undefined} className={`flex items-center gap-2 px-3 py-2 rounded-xl text-sm transition-all ${selected ? dark ? "bg-indigo-500/20 text-white" : "bg-indigo-50 text-indigo-700" : passive}`}>
                <Icon size={16} /><span className="font-medium">{t(section.label)}</span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
