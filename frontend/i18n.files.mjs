// The files of the bilingual (English / Vietnamese) pages: Content ID, Report and the shared chrome.
// Shared by eslint.config.js (the i18n/no-untranslated rule runs only on these) and by the coverage
// test (every t()/tk()/tm() literal in them must have a Vietnamese entry). Globs are relative to
// the frontend folder and use `*` (one segment) and `**` (any depth).
export const BILINGUAL_FILES = [
  "src/App.jsx",
  "src/components/Sidebar.jsx",
  "src/components/Topbar.jsx",
  "src/components/PaginationFooter.jsx",
  "src/components/ReadOnlyRuntime.jsx",
  "src/components/ChannelCard.jsx",
  "src/api/contentIdClaimsApi.js",
  "src/api/deliveryApi.js",
  "src/api/analyticsApi.js",
  "src/components/AnalyticsNavigation.jsx",
  "src/pages/analytics/**/*.{js,jsx}",
  // PDF editor (/pdf): the user-interface folders. Its engines (engine/, model/, text/ and the .js modules of
  // viewer/) hold no text for the user: they report codes that messages.js turns into sentences.
  "src/pages/pdfEditor/*.{js,jsx}",
  "src/pages/pdfEditor/tools/**/*.{js,jsx}",
  "src/pages/pdfEditor/ui/**/*.{js,jsx}",
  "src/pages/pdfEditor/overlay/**/*.{js,jsx}",
  "src/pages/pdfEditor/pages/**/*.{js,jsx}",
  "src/pages/pdfEditor/signing/**/*.{js,jsx}",
  "src/pages/pdfEditor/viewer/**/*.jsx",
  "src/pages/SettingsPage.jsx",
  "src/pages/SidebarSettings.jsx",
  "src/pages/OwnershipApiSettings.jsx",
  "src/pages/ContentId*.jsx",
  "src/pages/assetDelivery/**/*.{js,jsx}",
  "src/pages/videoDelivery/**/*.{js,jsx}",
  "src/pages/claimManager/**/*.{js,jsx}",
  "src/pages/ReportDashboardPage.jsx",
  "src/pages/PartnerReportDashboardPage.jsx",
  "src/pages/ManagerReportPage.jsx",
  "src/pages/ExportMultiPage.jsx",
  "src/pages/ChannelPage.jsx",
  "src/pages/ExchangeRatePage.jsx",
  "src/pages/CompanyPage.jsx",
  "src/pages/GroupChannelPage.jsx"
];

// Converts one glob of the list above into a RegExp over "/"-separated paths relative to the frontend folder.
export function globToRegExp(glob) {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        source += glob[index + 2] === "/" ? "(?:.*/)?" : ".*";
        index += glob[index + 2] === "/" ? 2 : 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "{") {
      const end = glob.indexOf("}", index);
      source += `(?:${glob.slice(index + 1, end).split(",").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`;
      index = end;
    } else if (/[.+?^$()|[\]\\]/.test(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(`^${source}$`);
}

const MATCHERS = BILINGUAL_FILES.map(globToRegExp);

export function isBilingualFile(relativePath) {
  const normalized = String(relativePath).replace(/\\/g, "/").replace(/^\.\//, "");
  return MATCHERS.some((matcher) => matcher.test(normalized));
}
