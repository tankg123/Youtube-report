import { lazy, Suspense, useState } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  useLocation,
  Navigate
} from "react-router-dom";
import { Loader2, LogOut, Mail, ShieldCheck, Sparkles } from "lucide-react";

import Sidebar from "./components/Sidebar";
import Topbar from "./components/Topbar";
import ChannelManagementPage from "./pages/ChannelManagementPage";
import CollaboratorsPage from "./pages/CollaboratorsPage";
import RevenueSharingPage from "./pages/RevenueSharingPage";
import ChannelPage from "./pages/ChannelPage";
import AccountPage from "./pages/AccountPage";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import VerifyEmailPage from "./pages/VerifyEmailPage";
import ForgotPasswordPage from "./pages/ForgotPasswordPage";
import ManagerReportPage from "./pages/ManagerReportPage";
import ReportDashboardPage from "./pages/ReportDashboardPage";
import PartnerReportDashboardPage from "./pages/PartnerReportDashboardPage";
import ExportMultiPage from "./pages/ExportMultiPage";
import PartnerPage from "./pages/PartnerPage";
import PartnerOverviewPage from "./pages/PartnerOverviewPage";
import PartnerContractsPage from "./pages/PartnerContractsPage";
import PartnerRequestPage from "./pages/PartnerRequestPage";
import EmailNotificationPage from "./pages/EmailNotificationPage";
import HomePage from "./pages/HomePage";
import GroupChannelPage from "./pages/GroupChannelPage";
import NetworkPage from "./pages/NetworkPage";
import ExchangeRatePage from "./pages/ExchangeRatePage";
import CompanyPage from "./pages/CompanyPage";
import SettingsPage from "./pages/SettingsPage";
import SidebarSettings from "./pages/SidebarSettings";
import ContentIdCreatorPage from "./pages/ContentIdCreatorPage";
import ContentIdDeliveryPage from "./pages/ContentIdDeliveryPage";
import ContentIdVideoDeliveryPage from "./pages/ContentIdVideoDeliveryPage";
import ContentIdProductsPage from "./pages/ContentIdProductsPage";
import ContentIdSettingsPage from "./pages/ContentIdSettingsPage";
import ContentIdCatalogPage from "./pages/ContentIdCatalogPage";
import ContentIdWebAssetPage from "./pages/ContentIdWebAssetPage";
import ContentIdClaimPage from "./pages/ContentIdClaimPage";
import ContentIdCheckPage from "./pages/ContentIdCheckPage";
import ContentIdOwnershipEmailPage from "./pages/ContentIdOwnershipEmailPage";
import ContentIdWhitelistPage from "./pages/ContentIdWhitelistPage";
import { ExpenseAccountsPage, ExpenseCategoriesPage, ExpenseOverviewPage, ExpenseRevenuePage, ExpenseTransactionsPage } from "./pages/ExpensePages";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { I18nProvider, useI18n } from "./context/I18nContext";
import { ThemeProvider } from "./context/ThemeContext";
import { SystemSettingsProvider, useSystemSettings } from "./context/SystemSettingsContext";
import LanguageRuntime from "./components/LanguageRuntime";
import ReadOnlyRuntime from "./components/ReadOnlyRuntime";
import ErrorBoundary from "./components/ErrorBoundary";
import { loginPathFor, returnPathFromSearch } from "./utils/returnTo";

const AnalyticsPage = lazy(() => import("./pages/analytics/AnalyticsPage"));
// /pdf: stand-alone PDF editor (no Sidebar / Topbar, not linked from the navigation).
const PdfEditorPage = lazy(() => import("./pages/pdfEditor/PdfEditorPage"));

function LockedPage() {
  const { user, logout } = useAuth();
  const { settings } = useSystemSettings();
  const { t } = useI18n();
  const brandName = settings?.brand_name || "ANS Network";

  function handleLogout() {
    logout();
    window.location.href = "/login";
  }

  return (
    <div className="locked-page-3d min-h-[calc(100vh-64px)] overflow-hidden bg-[radial-gradient(circle_at_top_left,#dcfce7,transparent_32%),radial-gradient(circle_at_bottom_right,#dbeafe,transparent_36%)] p-6">
      <div className="mx-auto flex min-h-[calc(100vh-112px)] max-w-5xl items-center justify-center">
        <section className="relative w-full overflow-hidden rounded-[36px] border border-white/70 bg-white/90 p-8 text-center shadow-2xl shadow-slate-900/10 backdrop-blur lg:p-12">
          <div className="absolute -left-16 -top-16 h-44 w-44 rounded-full bg-emerald-100 blur-2xl" />
          <div className="absolute -bottom-20 -right-20 h-56 w-56 rounded-full bg-blue-100 blur-2xl" />

          <div className="relative mx-auto flex h-24 w-24 items-center justify-center rounded-[32px] bg-emerald-600 text-white shadow-xl shadow-emerald-900/20">
            <Sparkles size={42} />
          </div>

          <div className="relative mt-8">
            <p className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-4 py-2 text-sm font-black text-emerald-700">
              <ShieldCheck size={18} />
              {t("Account created successfully")}
            </p>

            <h1 className="mt-5 text-4xl font-black leading-tight text-slate-950 lg:text-5xl">
              {t("Welcome to {brand}", { brand: brandName })}
            </h1>

            <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-slate-600 lg:text-lg">
              {t("Your account is ready, but it does not have an active role yet. Please contact the administrator to assign permissions before using the system.")}
            </p>

            <div className="mx-auto mt-8 grid max-w-2xl gap-3 rounded-3xl border border-slate-200 bg-slate-50 p-4 text-left md:grid-cols-2">
              <div className="rounded-2xl bg-white p-4">
                <p className="text-xs font-black uppercase tracking-wider text-slate-400">{t("Account")}</p>
                <p className="mt-1 font-black text-slate-900">{user?.full_name || t("New user")}</p>
                <p className="mt-1 flex items-center gap-2 text-sm text-slate-500">
                  <Mail size={15} />
                  {user?.email || "-"}
                </p>
              </div>
              <div className="rounded-2xl bg-white p-4">
                <p className="text-xs font-black uppercase tracking-wider text-slate-400">{t("Next step")}</p>
                <p className="mt-1 font-black text-slate-900">{t("Contact administrator")}</p>
                <p className="mt-1 text-sm text-slate-500">{t("Ask an admin to add the correct role in Account Management.")}</p>
              </div>
            </div>

            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <a
                href="mailto:no-reply@ansnetwork.uk"
                className="inline-flex items-center justify-center gap-2 rounded-2xl bg-blue-600 px-6 py-3 font-black text-white shadow-lg shadow-blue-900/20 hover:bg-blue-700"
              >
                <Mail size={18} />
                {t("Contact admin")}
              </a>
              <button
                type="button"
                onClick={handleLogout}
                className="inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-6 py-3 font-black text-slate-700 hover:bg-slate-50"
              >
                <LogOut size={18} />
                {t("Sign out")}
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function PrivateLayout() {
  const { canViewAnalytics } = useAuth();
  const { user, authLoading, canViewReports, canViewEmail, canViewChannelManagement, canViewContentIdFull, canViewContentIdClaim, canViewExpense, canViewPartner, canViewAccount, canViewSettings, canViewContentIdSettings, canViewPartnerGroups, canViewPartnerDashboard } = useAuth();

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#f3f6fb]">
        <Loader2 className="animate-spin text-blue-600" size={42} />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  const defaultPath = "/home";

  return (
    <div className="app-shell min-h-screen flex bg-[#f3f6fb]">
      <ReadOnlyRuntime />
      <Sidebar />

      <main className="app-main flex-1 min-w-0">
        <Topbar />

        <Routes>
          <Route path="/analytic/*" element={canViewAnalytics ? <Suspense fallback={<div className="p-12 flex justify-center" role="status"><Loader2 className="animate-spin text-indigo-600" size={36} /></div>}><AnalyticsPage /></Suspense> : <Navigate to={defaultPath} replace />} />
          <Route path="/analytics/*" element={<Navigate to="/analytic/overview" replace />} />
          <Route
            path="/"
            element={
              <Navigate to={defaultPath} replace />
            }
          />
          <Route
            path="/home"
            element={<HomePage />}
          />
          <Route
            path="/channel-management"
            element={
              canViewChannelManagement ? (
                <ChannelManagementPage />
              ) : (
                <Navigate to={defaultPath} replace />
              )
            }
          />
          <Route
            path="/channel-management/collaborators"
            element={
              canViewChannelManagement ? (
                <CollaboratorsPage />
              ) : (
                <Navigate to={defaultPath} replace />
              )
            }
          />
          <Route
            path="/channel-management/sharing"
            element={
              canViewChannelManagement ? (
                <RevenueSharingPage />
              ) : (
                <Navigate to={defaultPath} replace />
              )
            }
          />
          <Route
            path="/report-dashboard"
            element={
              canViewReports ? (
                <ReportDashboardPage />
              ) : (
                <Navigate to={defaultPath} replace />
              )
            }
          />
          <Route
            path="/partner-dashboard"
            element={
              canViewPartnerDashboard ? (
                <PartnerReportDashboardPage />
              ) : (
                <Navigate to={defaultPath} replace />
              )
            }
          />
          <Route
            path="/reports"
            element={
              canViewReports ? (
                <ManagerReportPage />
              ) : (
                <Navigate to={defaultPath} replace />
              )
            }
          />
          <Route
            path="/export-multi"
            element={
              canViewReports ? (
                <ExportMultiPage />
              ) : (
                <Navigate to={defaultPath} replace />
              )
            }
          />
          <Route
            path="/channels"
            element={
              canViewReports ? (
                <ChannelPage />
              ) : (
                <Navigate to={defaultPath} replace />
              )
            }
          />
          <Route
            path="/networks"
            element={
              canViewSettings ? (
                <NetworkPage />
              ) : (
                <Navigate to={defaultPath} replace />
              )
            }
          />
          <Route
            path="/exchange-rates"
            element={
              canViewReports ? (
                <ExchangeRatePage />
              ) : (
                <Navigate to={defaultPath} replace />
              )
            }
          />
          <Route
            path="/companies"
            element={
              canViewReports ? (
                <CompanyPage />
              ) : (
                <Navigate to={defaultPath} replace />
              )
            }
          />
          <Route
            path="/partners"
            element={<Navigate to="/partners/overview" replace />}
          />
          <Route
            path="/partners/overview"
            element={
              canViewPartner ? (
                <PartnerOverviewPage />
              ) : (
                <Navigate to={defaultPath} replace />
              )
            }
          />
          <Route
            path="/partners/list"
            element={
              canViewPartner ? (
                <PartnerPage />
              ) : (
                <Navigate to={defaultPath} replace />
              )
            }
          />
          <Route
            path="/partners/contracts"
            element={
              canViewPartner ? (
                <PartnerContractsPage />
              ) : (
                <Navigate to={defaultPath} replace />
              )
            }
          />
          <Route
            path="/groups"
            element={
              canViewPartnerGroups ? (
                <GroupChannelPage />
              ) : (
                <Navigate to={defaultPath} replace />
              )
            }
          />
          <Route path="/content-id" element={<Navigate to={canViewContentIdFull ? "/content-id/creator" : "/content-id/claims"} replace />} />
          <Route
            path="/content-id/creator"
            element={canViewContentIdFull ? <ContentIdCreatorPage /> : <Navigate to={defaultPath} replace />}
          />
          <Route
            path="/content-id/delivery"
            element={canViewContentIdFull ? <ContentIdDeliveryPage /> : <Navigate to={defaultPath} replace />}
          />
          <Route
            path="/content-id/video-delivery"
            element={canViewContentIdFull ? <ContentIdVideoDeliveryPage /> : <Navigate to={defaultPath} replace />}
          />
          <Route
            path="/content-id/web-assets"
            element={canViewContentIdFull ? <ContentIdWebAssetPage /> : <Navigate to={defaultPath} replace />}
          />
          <Route
            path="/content-id/products"
            element={canViewContentIdFull ? <ContentIdProductsPage /> : <Navigate to={defaultPath} replace />}
          />
          <Route
            path="/content-id/claims"
            element={canViewContentIdClaim ? <ContentIdClaimPage /> : <Navigate to={defaultPath} replace />}
          />
          <Route
            path="/content-id/ownership-email"
            element={canViewContentIdFull ? <ContentIdOwnershipEmailPage /> : <Navigate to={defaultPath} replace />}
          />
          <Route
            path="/content-id/check"
            element={canViewContentIdFull ? <ContentIdCheckPage /> : <Navigate to={defaultPath} replace />}
          />
          <Route
            path="/content-id/whitelists"
            element={canViewContentIdFull ? <ContentIdWhitelistPage /> : <Navigate to={defaultPath} replace />}
          />
          <Route
            path="/content-id/labels"
            element={canViewContentIdClaim ? <ContentIdCatalogPage type="labels" /> : <Navigate to={defaultPath} replace />}
          />
          <Route
            path="/content-id/artists"
            element={canViewContentIdFull ? <ContentIdCatalogPage type="artists" /> : <Navigate to={defaultPath} replace />}
          />
          <Route path="/expenses" element={<Navigate to="/expenses/overview" replace />} />
          <Route path="/expenses/overview" element={canViewExpense ? <ExpenseOverviewPage /> : <Navigate to={defaultPath} replace />} />
          <Route path="/expenses/categories" element={canViewExpense ? <ExpenseCategoriesPage /> : <Navigate to={defaultPath} replace />} />
          <Route path="/expenses/transactions" element={canViewExpense ? <ExpenseTransactionsPage /> : <Navigate to={defaultPath} replace />} />
          <Route path="/expenses/accounts" element={canViewExpense ? <ExpenseAccountsPage /> : <Navigate to={defaultPath} replace />} />
          <Route path="/expenses/revenue" element={canViewExpense ? <ExpenseRevenuePage /> : <Navigate to={defaultPath} replace />} />
          <Route path="/email" element={<Navigate to="/email/notification" replace />} />
          <Route path="/email/notification" element={canViewEmail ? <EmailNotificationPage /> : <Navigate to={defaultPath} replace />} />
          <Route path="/account" element={canViewAccount ? <AccountPage /> : <Navigate to={defaultPath} replace />} />
          <Route path="/settings" element={<Navigate to="/settings/system" replace />} />
          <Route path="/settings/system" element={canViewSettings ? <SettingsPage /> : <Navigate to={defaultPath} replace />} />
          <Route path="/settings/sidebar" element={canViewSettings ? <SidebarSettings /> : <Navigate to={defaultPath} replace />} />
          <Route path="/settings/content-id" element={canViewContentIdSettings ? <ContentIdSettingsPage /> : <Navigate to={defaultPath} replace />} />
          <Route path="/locked" element={<LockedPage />} />
          <Route path="*" element={<Navigate to={defaultPath} replace />} />
        </Routes>
      </main>
    </div>
  );
}

function PublicRoute({ children }) {
  const { user, authLoading } = useAuth();
  const location = useLocation();

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#f3f6fb]">
        <Loader2 className="animate-spin text-blue-600" size={42} />
      </div>
    );
  }

  if (user) {
    return <Navigate to={returnPathFromSearch(location.search) || "/home"} replace />;
  }

  return children;
}

// Stand-alone tools (no Sidebar / Topbar / ReadOnlyRuntime): any signed-in user, whatever the role. A visitor
// who is not signed in goes to /login?next=<this page>. The page is admitted once the session check has
// finished with a user; from then on it stays mounted when the session ends (token expiry, 401): the work it
// holds lives only in memory, and the page reads useAuth().user itself to tell the user.
function StandaloneRoute({ children }) {
  const { user, authLoading } = useAuth();
  const location = useLocation();
  const [admitted, setAdmitted] = useState(false);

  if (user && !authLoading && !admitted) setAdmitted(true);

  if (!admitted) {
    if (authLoading || user) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-[#f3f6fb]">
          <Loader2 className="animate-spin text-blue-600" size={42} />
        </div>
      );
    }
    return <Navigate to={loginPathFor(location.pathname, location.search, location.hash)} replace />;
  }

  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-[#f3f6fb]" role="status"><Loader2 className="animate-spin text-blue-600" size={42} /></div>}>
      {children}
    </Suspense>
  );
}

function HomeRoute() {
  const { user, authLoading } = useAuth();

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#f3f6fb]">
        <Loader2 className="animate-spin text-blue-600" size={42} />
      </div>
    );
  }

  return user ? (
    <div className="app-shell min-h-screen flex bg-[#f3f6fb]">
      <ReadOnlyRuntime />
      <Sidebar />
      <main className="app-main flex-1 min-w-0">
        <Topbar />
        <HomePage />
      </main>
    </div>
  ) : <HomePage publicView />;
}

function AppRoutes() {
  return (
    <>
      <LanguageRuntime />
      <div className="app-routes-3d">
        <Routes>
          <Route path="/partner-request/:token" element={<PartnerRequestPage />} />
          <Route path="/" element={<HomeRoute />} />
          <Route path="/home" element={<HomeRoute />} />
          <Route path="/pdf/*" element={<StandaloneRoute><PdfEditorPage /></StandaloneRoute>} />

      <Route
        path="/login"
        element={
          <PublicRoute>
            <LoginPage />
          </PublicRoute>
        }
      />

      <Route
        path="/register"
        element={
          <PublicRoute>
            <RegisterPage />
          </PublicRoute>
        }
      />

      <Route
        path="/verify-email"
        element={
          <PublicRoute>
            <VerifyEmailPage />
          </PublicRoute>
        }
      />

      <Route
        path="/forgot-password"
        element={
          <PublicRoute>
            <ForgotPasswordPage />
          </PublicRoute>
        }
      />

          <Route path="/*" element={<PrivateLayout />} />
        </Routes>
      </div>
    </>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <I18nProvider>
          <ThemeProvider>
            <SystemSettingsProvider>
              <AuthProvider>
                <AppRoutes />
              </AuthProvider>
            </SystemSettingsProvider>
          </ThemeProvider>
        </I18nProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
