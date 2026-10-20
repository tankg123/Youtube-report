// Entry point of the i18n layer: registers every Vietnamese dictionary and re-exports the core API.
// Components get t/tm/formatters from useI18n() (src/context/I18nContext.jsx) so they re-render on a
// language change; plain modules (utils, constants, hooks) import t / tm / tk from here.
import * as core from "./core.js";
import { translations } from "./legacy.js";
import rules from "./vi/rules.js";
import englishRules from "./en/rules.js";
import serverVietnamese from "./en/serverVietnamese.js";
import assetDeliveryDetail from "./vi/assetDeliveryDetail.js";
import assetDeliveryForm from "./vi/assetDeliveryForm.js";
import assetDeliveryList from "./vi/assetDeliveryList.js";
import assetDeliveryShared from "./vi/assetDeliveryShared.js";
import claimManagerLogic from "./vi/claimManagerLogic.js";
import claimManagerPage from "./vi/claimManagerPage.js";
import claimManagerPanels from "./vi/claimManagerPanels.js";
import common from "./vi/common.js";
import contentIdAssets from "./vi/contentIdAssets.js";
import contentIdCreator from "./vi/contentIdCreator.js";
import reportChannels from "./vi/reportChannels.js";
import reportDashboard from "./vi/reportDashboard.js";
import reportGroups from "./vi/reportGroups.js";
import reportManager from "./vi/reportManager.js";
import server from "./vi/server.js";
import videoDelivery from "./vi/videoDelivery.js";

// One dictionary per feature slice. `runtimeOnly` namespaces hold texts that never appear as t()/tk()
// literals in the frontend source (server answers), so the coverage test does not report them stale.
export const NAMESPACES = Object.freeze([
  { name: "common", entries: common },
  { name: "claimManagerPage", entries: claimManagerPage },
  { name: "claimManagerPanels", entries: claimManagerPanels },
  { name: "claimManagerLogic", entries: claimManagerLogic },
  { name: "assetDeliveryDetail", entries: assetDeliveryDetail },
  { name: "assetDeliveryForm", entries: assetDeliveryForm },
  { name: "assetDeliveryShared", entries: assetDeliveryShared },
  { name: "assetDeliveryList", entries: assetDeliveryList },
  { name: "videoDelivery", entries: videoDelivery },
  { name: "contentIdCreator", entries: contentIdCreator },
  { name: "contentIdAssets", entries: contentIdAssets },
  { name: "reportGroups", entries: reportGroups },
  { name: "reportDashboard", entries: reportDashboard },
  { name: "reportManager", entries: reportManager },
  { name: "reportChannels", entries: reportChannels },
  { name: "server", entries: server, runtimeOnly: true }
]);

export const VI_RULES = rules;

// English side: the backend still writes a few messages in Vietnamese (report import, groups, channels,
// auth); tm() turns them into English when the UI is English and leaves them alone in Vietnamese.
export const EN_SERVER = serverVietnamese;
export const EN_RULES = englishRules;

core.registerLegacyTranslations("en", translations.en);
core.registerLegacyTranslations("vi", translations.vi);
NAMESPACES.forEach(({ entries }) => core.registerTranslations("vi", entries));
core.registerTranslations("en", serverVietnamese);
core.registerMessageRules("vi", rules);
core.registerMessageRules("en", englishRules);

export const {
  LANGUAGES,
  DEFAULT_LANGUAGE,
  normalizeLanguage,
  getLanguage,
  setLanguage,
  subscribe,
  translate,
  translateMessage,
  tk,
  hasTranslation,
  registerTranslations,
  registerMessageRules,
  lookup,
  interpolate,
  placeholdersOf,
  dictionarySize
} = core;

// Short names for plain modules: t("…") renders now in the current language, tm(message) translates a
// runtime message, tk("…") marks a canonical string for later.
export const t = core.translate;
export const tm = core.translateMessage;

export { formatDate, formatDateTime, formatNumber, localeOf, regionName, toDate } from "./format.js";
export { translations } from "./legacy.js";
