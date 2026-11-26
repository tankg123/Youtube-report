import { CircleAlert, Info, TriangleAlert, X } from "lucide-react";
import { useI18n } from "../../../context/I18nContext";
import { SlotBoundary } from "./controls.jsx";
import { useEditor, useUi } from "./editorHooks.js";

// The banners under the tool bar (UX specification 3.1 B2): first the banners of the features (the state of
// the signatures of a signed document), then the notices of the UI store: what the writer said about a file
// that was opened (it cannot be edited here, it is signed, a dynamic form is dropped), the session that ended,
// the page that is not served over https.
// A notice carries either a code of an engine (rendered through messages.js) or a tk() text.
//
// Test hooks: pdfx-notices; every notice is pdfx-notice with data-notice-id, data-code and data-tone;
// pdfx-action-dismiss-notice.
const TONE_ICONS = { info: Info, warning: TriangleAlert, error: CircleAlert };

export default function Notices() {
  const { t } = useI18n();
  const { features, messages, reportSlotError, ui } = useEditor();
  const notices = useUi((state) => state.notices);
  if (!features.banners.length && !notices.length) return null;
  return (
    <div className="pdfx-notices" data-testid="pdfx-notices">
      {features.banners.map((Banner, index) => (
        <SlotBoundary key={index} onError={reportSlotError}>
          <Banner />
        </SlotBoundary>
      ))}
      {notices.map((notice) => {
        const Icon = TONE_ICONS[notice.tone] || Info;
        return (
          <div key={notice.id} className="pdfx-notice" role={notice.tone === "error" ? "alert" : "status"} data-tone={notice.tone} data-notice-id={notice.id} data-code={notice.code || ""} data-testid="pdfx-notice">
            <Icon size={16} strokeWidth={2} aria-hidden="true" />
            <p>{notice.code ? messages.describeCode(notice.code, notice.params || {}) : t(notice.text, notice.textParams || undefined)}</p>
            {notice.dismissible ? (
              <button type="button" className="pdfx-notice-close" aria-label={t("Dismiss")} data-testid="pdfx-action-dismiss-notice" onClick={() => ui.dismissNotice(notice.id)}>
                <X size={14} strokeWidth={2} aria-hidden="true" />
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
