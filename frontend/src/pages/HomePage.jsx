import { Link } from "react-router-dom";
import {
  ArrowRight,
  BarChart3,
  BellRing,
  Check,
  ChevronRight,
  CircleDollarSign,
  Disc3,
  FileCheck2,
  FileSpreadsheet,
  Headphones,
  Mail,
  Moon,
  Music2,
  Network,
  ShieldCheck,
  Sparkles,
  Sun,
  TrendingUp,
  UsersRound,
  WalletCards,
  Workflow
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../context/I18nContext";
import { useSystemSettings } from "../context/SystemSettingsContext";
import { useTheme } from "../context/ThemeContext";

const homeCopy = {
  en: {
    publicEyebrow: "Revenue operations for modern music networks",
    privateEyebrow: "Your music revenue command center",
    publicTitle: "From YouTube revenue to partner-ready files —",
    publicAccent: "one clear workflow.",
    privateTitle: "Welcome back, {name}.",
    privateAccent: "Keep every monthly close moving.",
    lead: "Import monthly reports, apply sharing rules, review channel performance, prepare payout files, and notify partners while keeping import and delivery history visible.",
    register: "Start your workspace",
    signIn: "Sign in",
    explore: "Explore the workflow",
    publicTrust: "Built for MCNs, labels, music teams and partner networks.",
    privateTrust: "Your available tools are connected below.",
    deskEyebrow: "Music Revenue Desk",
    deskTitle: "A clearer monthly close",
    deskNote: "Illustrative workflow",
    chartTitle: "Workflow momentum",
    chartState: "Connected flow",
    deskRows: [
      { title: "Report intake", text: "Monthly network data", status: "Imported" },
      { title: "Revenue sharing", text: "Group and partner rules", status: "Applied" },
      { title: "Payout package", text: "PDF and Excel exports", status: "Prepared" }
    ],
    deskFooter: "One workspace, fewer handoffs",
    proof: [
      { label: "Monthly reports", value: "XLSX / CSV" },
      { label: "Partner terms", value: "Profiles & sharing" },
      { label: "Payout files", value: "PDF / Excel" }
    ],
    flowEyebrow: "One connected workflow",
    flowTitle: "From report intake to partner communication.",
    flowBody: "Keep the monthly close structured while every team works from the same monthly source data.",
    flowSteps: [
      { title: "Import & organize", text: "Load monthly channel reports by network and keep import history traceable." },
      { title: "Review & calculate", text: "See revenue, paid and profit summaries, then apply group sharing rules." },
      { title: "Prepare payout", text: "Connect partner payment details, group shares and exchange rates to payout documents." },
      { title: "Deliver & follow up", text: "Export PDF or Excel files and send scheduled revenue notifications." }
    ],
    capabilityEyebrow: "Built around real operations",
    capabilityTitle: "Everything stays in tune.",
    capabilityBody: "A focused workspace for the teams who manage music revenue, channels, partners and communication every month.",
    capabilities: [
      { title: "Revenue clarity", text: "Import monthly reports, review revenue, paid and profit views, and keep import history visible.", tag: "Reports & dashboard" },
      { title: "Partner operations", text: "Keep profiles, payment details, request intake and contract timelines connected.", tag: "Partners & contracts" },
      { title: "Channel portfolio", text: "Track network assignment, audience metrics, channel status, collaborators and sharing rates.", tag: "Channels & networks" },
      { title: "Communication flow", text: "Build email templates, send now, schedule later and manage follow-up messages.", tag: "Email automation" }
    ],
    quickEyebrow: "Continue your work",
    quickTitle: "Jump back into your workspace.",
    quickBody: "Shortcuts are shown from your current permissions.",
    noAccess: "Your account is ready. Ask an administrator to assign the modules you need.",
    closingTitle: "Ready for a calmer monthly close?",
    closingBody: "Bring reports, sharing rules, payout files and partner communication into one dependable workspace.",
    actions: {
      analytic: ["Analytic", "Content Owner performance, audience and estimated revenue"],
      reports: ["Report dashboard", "Revenue, paid and profit overview"],
      partnerDashboard: ["Partner dashboard", "Partner revenue and channel performance"],
      channels: ["Channel overview", "Portfolio status, assignment and sharing"],
      partners: ["Partner operations", "Profiles, payment details and contracts"],
      contentId: ["Content ID", "Claims, products and catalog operations"],
      contentIdClaim: ["Content ID claims", "Claims and label operations"],
      expenses: ["Expense overview", "Balances, transactions and revenue"],
      email: ["Email automation", "Templates, schedules and follow-ups"],
      groups: ["Revenue groups", "Monthly tiers and channel sharing"],
      account: ["Account", "Profile and access management"]
    },
    publicNavLabel: "Public navigation",
    workflowCapabilitiesLabel: "Workflow capabilities",
    preferencesLabel: "Display preferences",
    useEnglish: "Use English",
    useVietnamese: "Use Vietnamese",
    useLightTheme: "Switch to light theme",
    useDarkTheme: "Switch to dark theme"
  },
  vi: {
    publicEyebrow: "Vận hành doanh thu cho mạng lưới âm nhạc hiện đại",
    privateEyebrow: "Trung tâm vận hành doanh thu âm nhạc",
    publicTitle: "Từ doanh thu YouTube đến hồ sơ thanh toán đối tác —",
    publicAccent: "trong một quy trình rõ ràng.",
    privateTitle: "Chào {name}.",
    privateAccent: "Giữ mọi kỳ chốt doanh thu luôn thông suốt.",
    lead: "Nhập báo cáo tháng, áp dụng tỷ lệ chia, theo dõi hiệu suất kênh, chuẩn bị hồ sơ thanh toán và thông báo đối tác, đồng thời giữ rõ lịch sử nhập và gửi dữ liệu.",
    register: "Bắt đầu workspace",
    signIn: "Đăng nhập",
    explore: "Khám phá quy trình",
    publicTrust: "Dành cho MCN, label, đội ngũ âm nhạc và mạng lưới đối tác.",
    privateTrust: "Các công cụ bạn có quyền truy cập được kết nối bên dưới.",
    deskEyebrow: "Bàn điều hành doanh thu",
    deskTitle: "Kỳ chốt doanh thu rõ ràng hơn",
    deskNote: "Quy trình minh họa",
    chartTitle: "Nhịp độ xử lý",
    chartState: "Luồng đã kết nối",
    deskRows: [
      { title: "Tiếp nhận báo cáo", text: "Dữ liệu network theo tháng", status: "Đã nhập" },
      { title: "Chia sẻ doanh thu", text: "Quy tắc group và đối tác", status: "Đã áp dụng" },
      { title: "Hồ sơ thanh toán", text: "Xuất PDF và Excel", status: "Đã chuẩn bị" }
    ],
    deskFooter: "Một workspace, ít bàn giao hơn",
    proof: [
      { label: "Báo cáo tháng", value: "XLSX / CSV" },
      { label: "Điều khoản đối tác", value: "Hồ sơ & tỷ lệ chia" },
      { label: "File thanh toán", value: "PDF / Excel" }
    ],
    flowEyebrow: "Một quy trình kết nối",
    flowTitle: "Từ nhập báo cáo đến thông báo đối tác.",
    flowBody: "Giữ kỳ chốt doanh thu có cấu trúc, đồng thời giúp mọi đội ngũ làm việc trên cùng dữ liệu nguồn theo tháng.",
    flowSteps: [
      { title: "Nhập & tổ chức", text: "Tải báo cáo kênh theo tháng và network, đồng thời lưu lịch sử import rõ ràng." },
      { title: "Kiểm tra & tính toán", text: "Xem tổng quan doanh thu, đã trả, lợi nhuận và áp dụng tỷ lệ chia theo group." },
      { title: "Chuẩn bị thanh toán", text: "Kết nối thông tin thanh toán đối tác, tỷ lệ chia group và tỷ giá với chứng từ." },
      { title: "Gửi & theo dõi", text: "Xuất PDF hoặc Excel và gửi thông báo doanh thu theo lịch." }
    ],
    capabilityEyebrow: "Xây dựng theo vận hành thực tế",
    capabilityTitle: "Mọi thứ luôn đúng nhịp.",
    capabilityBody: "Workspace tập trung cho đội ngũ quản lý doanh thu âm nhạc, kênh, đối tác và liên lạc mỗi tháng.",
    capabilities: [
      { title: "Doanh thu rõ ràng", text: "Nhập báo cáo tháng, xem doanh thu, đã thanh toán, lợi nhuận và giữ rõ lịch sử import.", tag: "Báo cáo & dashboard" },
      { title: "Vận hành đối tác", text: "Kết nối hồ sơ, thông tin thanh toán, yêu cầu đối tác và tiến trình hợp đồng.", tag: "Đối tác & hợp đồng" },
      { title: "Danh mục kênh", text: "Theo dõi network, chỉ số khán giả, trạng thái kênh, cộng tác viên và tỷ lệ chia.", tag: "Kênh & network" },
      { title: "Luồng giao tiếp", text: "Tạo mẫu email, gửi ngay, lên lịch và quản lý các thông báo follow-up.", tag: "Email tự động" }
    ],
    quickEyebrow: "Tiếp tục công việc",
    quickTitle: "Quay lại workspace của bạn.",
    quickBody: "Các lối tắt được hiển thị theo quyền hiện tại.",
    noAccess: "Tài khoản đã sẵn sàng. Hãy nhờ quản trị viên gán các module bạn cần.",
    closingTitle: "Sẵn sàng cho kỳ chốt doanh thu nhẹ nhàng hơn?",
    closingBody: "Đưa báo cáo, tỷ lệ chia, file thanh toán và giao tiếp đối tác vào một workspace đáng tin cậy.",
    actions: {
      analytic: ["Analytic", "Hiệu suất Content Owner, khán giả và doanh thu ước tính"],
      reports: ["Dashboard báo cáo", "Tổng quan doanh thu, đã trả và lợi nhuận"],
      partnerDashboard: ["Dashboard đối tác", "Doanh thu đối tác và hiệu suất kênh"],
      channels: ["Tổng quan kênh", "Trạng thái, phân bổ và tỷ lệ chia"],
      partners: ["Vận hành đối tác", "Hồ sơ, thanh toán và hợp đồng"],
      contentId: ["Content ID", "Claim, sản phẩm và danh mục"],
      contentIdClaim: ["Content ID Claim", "Quản lý claim và label"],
      expenses: ["Tổng quan chi phí", "Số dư, giao dịch và doanh thu"],
      email: ["Email tự động", "Mẫu, lịch gửi và follow-up"],
      groups: ["Group doanh thu", "Tier tháng và tỷ lệ chia kênh"],
      account: ["Tài khoản", "Hồ sơ và quản lý truy cập"]
    },
    publicNavLabel: "Điều hướng công khai",
    workflowCapabilitiesLabel: "Khả năng của quy trình",
    preferencesLabel: "Tùy chọn hiển thị",
    useEnglish: "Dùng tiếng Anh",
    useVietnamese: "Dùng tiếng Việt",
    useLightTheme: "Chuyển sang giao diện sáng",
    useDarkTheme: "Chuyển sang giao diện tối"
  }
};

const workflowIcons = [FileSpreadsheet, BarChart3, UsersRound, BellRing];
const capabilityIcons = [CircleDollarSign, UsersRound, Network, Mail];
const deskIcons = [FileSpreadsheet, Workflow, FileCheck2];
const chartBars = [32, 48, 42, 64, 58, 78, 70, 88, 82, 96];

export default function HomePage({ publicView = false }) {
  const { settings, isSidebarVisible } = useSystemSettings();
  const { language, setLanguage } = useI18n();
  const { theme, setTheme } = useTheme();
  const auth = useAuth() || {};
  const copy = homeCopy[language] || homeCopy.en;
  const brandName = settings?.brand_name || "ANS Network";
  const subtitle = settings?.brand_subtitle || "MCN Manager System";
  const logoSrc = settings?.logo_data_url
    ? settings.logo_data_url
    : "/ans-logo.png";
  const isUploadedLogo = Boolean(settings?.logo_data_url);
  const nameParts = String(auth.user?.full_name || brandName).trim().split(/\s+/).filter(Boolean);
  const greetingName = (language === "vi" ? nameParts.at(-1) : nameParts[0]) || brandName;

  const quickActions = [
    { show: auth.canViewAnalytics, path: "/analytic/overview", icon: BarChart3, content: copy.actions.analytic },
    { show: auth.canViewPartnerDashboard, path: "/partner-dashboard", icon: TrendingUp, content: copy.actions.partnerDashboard },
    { show: auth.canViewReports, path: "/report-dashboard", icon: BarChart3, content: copy.actions.reports },
    { show: auth.canViewChannelManagement, path: "/channel-management", icon: Network, content: copy.actions.channels },
    { show: auth.canViewPartner, path: "/partners/overview", icon: UsersRound, content: copy.actions.partners },
    { show: auth.canViewContentId, path: auth.canViewContentIdFull && isSidebarVisible("/content-id/creator") ? "/content-id/creator" : "/content-id/claims", icon: Disc3, content: auth.canViewContentIdFull ? copy.actions.contentId : copy.actions.contentIdClaim },
    { show: auth.canViewExpense, path: "/expenses/overview", icon: WalletCards, content: copy.actions.expenses },
    { show: auth.canViewEmail, path: "/email/notification", icon: Mail, content: copy.actions.email },
    { show: auth.canViewPartnerGroups, path: "/groups", icon: Headphones, content: copy.actions.groups },
    { show: auth.canViewAccount, path: "/account", icon: ShieldCheck, content: copy.actions.account }
  ].filter((item) => item.show && isSidebarVisible(item.path));

  const primaryAction = quickActions[0];
  const secondaryAction = quickActions[1];
  const title = publicView
    ? copy.publicTitle
    : copy.privateTitle.replace("{name}", greetingName);
  const accentTitle = publicView ? copy.publicAccent : copy.privateAccent;

  return (
    <div className={`home-page-3d home-v3 ${publicView ? "is-public" : "is-private"}`}>
      <div className="home-v3-shell">
        {publicView && (
          <header className="home-v3-nav">
            <div className="home-v3-brand">
              <div className="home-v3-logo">
                <img
                  src={logoSrc}
                  alt={brandName}
                  className={isUploadedLogo ? "is-uploaded" : "is-default"}
                />
              </div>
              <div className="home-v3-brand-copy">
                <strong>{brandName}</strong>
                <span>{subtitle}</span>
              </div>
            </div>
            <div className="home-v3-public-tools">
              <div className="home-v3-preferences" role="group" aria-label={copy.preferencesLabel}>
                <button
                  type="button"
                  className={`home-v3-preference-button ${language === "en" ? "is-active" : ""}`}
                  onClick={() => setLanguage("en")}
                  aria-label={copy.useEnglish}
                  aria-pressed={language === "en"}
                  title={copy.useEnglish}
                >
                  EN
                </button>
                <button
                  type="button"
                  className={`home-v3-preference-button ${language === "vi" ? "is-active" : ""}`}
                  onClick={() => setLanguage("vi")}
                  aria-label={copy.useVietnamese}
                  aria-pressed={language === "vi"}
                  title={copy.useVietnamese}
                >
                  VN
                </button>
                <button
                  type="button"
                  className="home-v3-preference-button home-v3-theme-button"
                  onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                  aria-label={theme === "dark" ? copy.useLightTheme : copy.useDarkTheme}
                  title={theme === "dark" ? copy.useLightTheme : copy.useDarkTheme}
                >
                  {theme === "dark" ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
                </button>
              </div>
              <nav className="home-v3-nav-actions" aria-label={copy.publicNavLabel}>
                <Link to="/login" className="home-v3-button home-v3-button-quiet">{copy.signIn}</Link>
                <Link to="/register" className="home-v3-button home-v3-button-primary">
                  {copy.register}<ArrowRight size={16} aria-hidden="true" />
                </Link>
              </nav>
            </div>
          </header>
        )}

        <div className="home-v3-content" role={publicView ? "main" : undefined}>
          <section className="home-v3-hero" aria-labelledby="home-hero-title">
            <div className="home-v3-orbit home-v3-orbit-one" aria-hidden="true" />
            <div className="home-v3-orbit home-v3-orbit-two" aria-hidden="true" />
            <div className="home-v3-hero-grid">
              <div className="home-v3-hero-copy">
                <p className="home-v3-eyebrow">
                  <Sparkles size={16} aria-hidden="true" />
                  {publicView ? copy.publicEyebrow : copy.privateEyebrow}
                </p>
                <h1 id="home-hero-title" className="home-v3-title">
                  {title} <span>{accentTitle}</span>
                </h1>
                <p className="home-v3-lead">{copy.lead}</p>

                <div className="home-v3-hero-actions">
                  {publicView ? (
                    <>
                      <Link to="/register" className="home-v3-button home-v3-button-primary home-v3-button-large">
                        {copy.register}<ArrowRight size={18} aria-hidden="true" />
                      </Link>
                      <a href="#workflow" className="home-v3-button home-v3-button-quiet home-v3-button-large">
                        {copy.explore}<ChevronRight size={18} aria-hidden="true" />
                      </a>
                    </>
                  ) : primaryAction ? (
                    <>
                      <Link to={primaryAction.path} className="home-v3-button home-v3-button-primary home-v3-button-large">
                        {primaryAction.content[0]}<ArrowRight size={18} aria-hidden="true" />
                      </Link>
                      {secondaryAction && (
                        <Link to={secondaryAction.path} className="home-v3-button home-v3-button-quiet home-v3-button-large">
                          {secondaryAction.content[0]}<ChevronRight size={18} aria-hidden="true" />
                        </Link>
                      )}
                    </>
                  ) : (
                    <span className="home-v3-access-note"><ShieldCheck size={18} />{copy.noAccess}</span>
                  )}
                </div>

                <p className="home-v3-trust"><Check size={16} aria-hidden="true" />{publicView ? copy.publicTrust : copy.privateTrust}</p>

                <div className="home-v3-proof" role="list" aria-label={copy.workflowCapabilitiesLabel}>
                  {copy.proof.map((item, index) => (
                    <div key={item.label} className="home-v3-proof-item" role="listitem">
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <div><small>{item.label}</small><strong>{item.value}</strong></div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="home-v3-visual" role="group" aria-label={copy.deskEyebrow}>
                <div className="home-v3-float-card home-v3-float-top" aria-hidden="true">
                  <TrendingUp size={17} />
                  <span>{copy.chartState}</span>
                </div>
                <div className="home-v3-desk">
                  <div className="home-v3-desk-head">
                    <div>
                      <p>{copy.deskEyebrow}</p>
                      <h2>{copy.deskTitle}</h2>
                    </div>
                    <span className="home-v3-demo-badge">{copy.deskNote}</span>
                  </div>

                  <div className="home-v3-chart-head">
                    <span>{copy.chartTitle}</span>
                    <div className="home-v3-live-state"><i />{copy.chartState}</div>
                  </div>
                  <div className="home-v3-chart" role="img" aria-label={`${copy.chartTitle}: ${copy.deskNote}`}>
                    <div className="home-v3-chart-lines" aria-hidden="true"><i /><i /><i /></div>
                    <div className="home-v3-bars" aria-hidden="true">
                      {chartBars.map((height, index) => (
                        <span key={`${height}-${index}`} style={{ "--bar-height": `${height}%`, "--bar-delay": `${index * 55}ms` }} />
                      ))}
                    </div>
                  </div>

                  <div className="home-v3-desk-list">
                    {copy.deskRows.map((row, index) => {
                      const Icon = deskIcons[index];
                      return (
                        <div key={row.title} className="home-v3-desk-row">
                          <span className="home-v3-desk-icon"><Icon size={18} /></span>
                          <div><strong>{row.title}</strong><small>{row.text}</small></div>
                          <em>{row.status}</em>
                        </div>
                      );
                    })}
                  </div>

                  <div className="home-v3-desk-foot">
                    <div className="home-v3-avatar-stack" aria-hidden="true"><span>RM</span><span>OP</span><span>FN</span></div>
                    <p>{copy.deskFooter}</p>
                    <Music2 size={18} aria-hidden="true" />
                  </div>
                </div>
                <div className="home-v3-float-card home-v3-float-bottom" aria-hidden="true">
                  <FileCheck2 size={17} />
                  <span>PDF · XLSX</span>
                </div>
              </div>
            </div>
          </section>

          {!publicView && quickActions.length > 0 && (
            <section className="home-v3-section home-v3-quick" aria-labelledby="home-quick-title">
              <div className="home-v3-section-head">
                <div>
                  <p className="home-v3-section-eyebrow">{copy.quickEyebrow}</p>
                  <h2 id="home-quick-title">{copy.quickTitle}</h2>
                </div>
                <p>{copy.quickBody}</p>
              </div>
              <div className="home-v3-quick-grid">
                {quickActions.map((item) => {
                  const Icon = item.icon;
                  return (
                    <Link key={item.path} to={item.path} className="home-v3-quick-card">
                      <span><Icon size={20} /></span>
                      <div><strong>{item.content[0]}</strong><small>{item.content[1]}</small></div>
                      <ArrowRight size={18} aria-hidden="true" />
                    </Link>
                  );
                })}
              </div>
            </section>
          )}

          <section id="workflow" className="home-v3-section home-v3-workflow" aria-labelledby="home-workflow-title">
            <div className="home-v3-section-head">
              <div>
                <p className="home-v3-section-eyebrow">{copy.flowEyebrow}</p>
                <h2 id="home-workflow-title">{copy.flowTitle}</h2>
              </div>
              <p>{copy.flowBody}</p>
            </div>
            <div className="home-v3-steps">
              {copy.flowSteps.map((step, index) => {
                const Icon = workflowIcons[index];
                return (
                  <article key={step.title} className="home-v3-step">
                    <div className="home-v3-step-top"><span>{String(index + 1).padStart(2, "0")}</span><Icon size={21} /></div>
                    <h3>{step.title}</h3>
                    <p>{step.text}</p>
                    {index < copy.flowSteps.length - 1 && <i className="home-v3-step-connector" aria-hidden="true" />}
                  </article>
                );
              })}
            </div>
          </section>

          <section id="capabilities" className="home-v3-section home-v3-capabilities" aria-labelledby="home-capabilities-title">
            <div className="home-v3-section-head">
              <div>
                <p className="home-v3-section-eyebrow">{copy.capabilityEyebrow}</p>
                <h2 id="home-capabilities-title">{copy.capabilityTitle}</h2>
              </div>
              <p>{copy.capabilityBody}</p>
            </div>
            <div className="home-v3-bento">
              {copy.capabilities.map((item, index) => {
                const Icon = capabilityIcons[index];
                return (
                  <article key={item.title} className={`home-v3-feature home-v3-feature-${index + 1}`}>
                    <div className="home-v3-feature-icon"><Icon size={24} /></div>
                    <span className="home-v3-feature-tag">{item.tag}</span>
                    <h3>{item.title}</h3>
                    <p>{item.text}</p>
                    <div className="home-v3-feature-visual" aria-hidden="true">
                      <i /><i /><i /><i />
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          {publicView && (
            <section className="home-v3-closing" aria-labelledby="home-closing-title">
              <div>
                <p className="home-v3-section-eyebrow">{copy.publicEyebrow}</p>
                <h2 id="home-closing-title">{copy.closingTitle}</h2>
                <p>{copy.closingBody}</p>
              </div>
              <div className="home-v3-closing-actions">
                <Link to="/register" className="home-v3-button home-v3-button-primary home-v3-button-large">{copy.register}<ArrowRight size={18} aria-hidden="true" /></Link>
                <Link to="/login" className="home-v3-button home-v3-button-quiet home-v3-button-large">{copy.signIn}</Link>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
