import { Component } from "react";
import { TriangleAlert } from "lucide-react";
import { useI18n } from "../../../context/I18nContext";

// The editor's own error boundary. A failure while the frame renders must not take the page to the
// application's error screen: the document lives in the editor context ABOVE this boundary and survives, so
// "Try again" draws the frame again around the same document and its undo history.
// Test hooks: pdfx-crash, pdfx-action-crash-retry, pdfx-action-crash-home.

function CrashScreen({ onRetry, withDocument }) {
  const { t, language } = useI18n();
  return (
    <div className="pdfx-root pdfx-crash" lang={language} data-readonly-allow="true" data-testid="pdfx-crash" role="alert">
      <div className="pdfx-empty-card">
        <TriangleAlert size={36} strokeWidth={1.5} aria-hidden="true" className="pdfx-empty-icon pdfx-empty-icon-error" />
        <p className="pdfx-empty-lead">{t("The editor ran into a problem.")}</p>
        <p className="pdfx-empty-note">{withDocument ? t("Your document is still in memory. Try again to continue where you were.") : t("Try again, or reload the page.")}</p>
        <div className="pdfx-empty-actions">
          <button type="button" className="pdfx-btn pdfx-btn-text pdfx-btn-primary" data-testid="pdfx-action-crash-retry" onClick={onRetry}>
            <span className="pdfx-btn-label">{t("Try again")}</span>
          </button>
          <a href="/home" className="pdfx-btn pdfx-btn-text pdfx-btn-outline" data-testid="pdfx-action-crash-home">
            <span className="pdfx-btn-label">{t("Back to home")}</span>
          </a>
        </div>
      </div>
    </div>
  );
}

/**
 * Props: `withDocument` (the fallback says that the document survived: true inside the editor context),
 * `onError(error)` (told once per failure).
 */
export default class ShellBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false, attempt: 0 };
    this.retry = () => this.setState((state) => ({ failed: false, attempt: state.attempt + 1 }));
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    this.props.onError?.(error);
  }

  render() {
    if (this.state.failed) return <CrashScreen onRetry={this.retry} withDocument={Boolean(this.props.withDocument)} />;
    return this.props.children;
  }
}
