import { LoaderCircle } from "lucide-react";
import { useI18n } from "../../../context/I18nContext";
import { useEditor, useUi } from "./editorHooks.js";

// The running job (actions.runJob): its title, the stage the engines report, a determinate bar where the
// work says how far it is, and Cancel where it can be stopped. While it shows, the root is data-busy="true"
// and the bars, panels and pages are inert (ui/Shell.jsx); this card is outside of them and stays reachable.
export default function JobCard() {
  const { t } = useI18n();
  const { actions, messages } = useEditor();
  const job = useUi((state) => state.job);
  if (!job) return null;
  const percent = job.progress === null ? null : Math.round(job.progress * 100);
  return (
    <div className="pdfx-job-layer">
      <div className="pdfx-job" role="status" aria-live="polite" data-testid="pdfx-job" data-job-progress={percent === null ? "" : String(percent)}>
        <div className="pdfx-job-head">
          <LoaderCircle size={18} strokeWidth={2} aria-hidden="true" className="pdfx-spin" />
          <strong>{t(job.titleKey)}</strong>
          {percent === null ? null : <span className="pdfx-job-percent">{percent}%</span>}
        </div>
        {job.detail ? <p className="pdfx-job-detail">{job.detail}</p> : null}
        {job.stage ? <p className="pdfx-job-stage">{messages.describeStage(job.stage)}</p> : null}
        <div className="pdfx-progress" role="progressbar" aria-label={t(job.titleKey)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent === null ? undefined : percent} data-indeterminate={percent === null ? "true" : "false"}>
          <span style={{ width: percent === null ? undefined : `${percent}%` }} />
        </div>
        {job.cancellable ? (
          <button type="button" className="pdfx-btn pdfx-btn-text pdfx-btn-outline" data-testid="pdfx-action-cancel-job" onClick={() => actions.cancelJob()}>
            <span className="pdfx-btn-label">{t("Cancel")}</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
