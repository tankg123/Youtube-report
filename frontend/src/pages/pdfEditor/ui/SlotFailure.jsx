import { TriangleAlert } from "lucide-react";
import { useI18n } from "../../../context/I18nContext";

// What a panel shows when the feature inside it failed to render: the rest of the editor keeps working.
export default function SlotFailure({ onRetry }) {
  const { t } = useI18n();
  return (
    <div className="pdfx-slot-failure" role="alert" data-testid="pdfx-slot-failure">
      <TriangleAlert size={18} strokeWidth={1.75} aria-hidden="true" />
      <p>{t("This part of the editor could not be displayed. Your document is not affected.")}</p>
      <button type="button" className="pdfx-btn pdfx-btn-text pdfx-btn-outline" onClick={onRetry}>
        <span className="pdfx-btn-label">{t("Try again")}</span>
      </button>
    </div>
  );
}
