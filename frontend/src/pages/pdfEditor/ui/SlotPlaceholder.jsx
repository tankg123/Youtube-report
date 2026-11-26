import { useI18n } from "../../../context/I18nContext";

// The empty state of a feature slot whose feature is not built yet (the stubs of overlay/, pages/ and
// signing/ render it). `icon`: a lucide-react component.
export default function SlotPlaceholder({ icon: Icon, testId }) {
  const { t } = useI18n();
  return (
    <div className="pdfx-placeholder" data-testid={testId}>
      {Icon ? <Icon size={24} strokeWidth={1.5} aria-hidden="true" /> : null}
      <p>{t("This part of the editor is not available yet.")}</p>
    </div>
  );
}
