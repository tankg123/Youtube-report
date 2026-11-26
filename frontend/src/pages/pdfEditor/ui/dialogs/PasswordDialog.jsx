import { useId, useRef, useState } from "react";
import { Eye, EyeOff, FileLock2, LoaderCircle } from "lucide-react";
import { useI18n } from "../../../../context/I18nContext";
import DialogFrame, { DialogButton } from "./DialogFrame.jsx";

// The password of a protected PDF (UX specification 10). One dialog per file: after a wrong password the
// same dialog stays open, says so under the field and has the keyboard in the field again.
// Props (from actions.openFiles): fileName, reason "need" | "incorrect", attempt (counts the questions),
// checking (the answer is being tried), onSubmit(password), onCancel(). The password lives in this component
// only while the dialog is open; it is never stored or logged.
export default function PasswordDialog({ fileName, reason, attempt, checking = false, onSubmit, onCancel }) {
  const { t } = useI18n();
  // a new question is a new answer: the field is empty again
  const [answer, setAnswer] = useState({ attempt, value: "" });
  const value = answer.attempt === attempt ? answer.value : "";
  const [visible, setVisible] = useState(false);
  const inputRef = useRef(null);
  const focusedFor = useRef(attempt);
  const textId = useId();
  const wrongId = useId();
  const wrong = reason === "incorrect";

  // after a wrong password the keyboard is in the (emptied) field again
  const takeFocus = (element) => {
    inputRef.current = element;
    if (element && focusedFor.current !== attempt) {
      focusedFor.current = attempt;
      element.focus({ preventScroll: true });
    }
  };

  const submit = () => {
    if (!checking) onSubmit(value);
  };

  return (
    <DialogFrame
      icon={FileLock2}
      title={t("Password required")}
      subtitle={fileName}
      describedBy={textId}
      initialFocusRef={inputRef}
      onClose={onCancel}
      footer={
        <>
          <DialogButton data-testid="pdfx-action-password-cancel" onClick={onCancel}>
            {t("Cancel")}
          </DialogButton>
          <DialogButton variant="primary" icon={checking ? LoaderCircle : undefined} aria-busy={checking ? "true" : undefined} disabled={checking} data-testid="pdfx-action-password-open" onClick={submit}>
            {t("Open")}
          </DialogButton>
        </>
      }
    >
      <p id={textId} className="pdfx-dialog-text">
        {t("This PDF is protected. Enter the password to open it.")}
      </p>
      <div className="pdfx-field-row">
        <input
          key={attempt}
          ref={takeFocus}
          className="pdfx-input"
          data-testid="pdfx-password-input"
          type={visible ? "text" : "password"}
          autoComplete="off"
          spellCheck="false"
          aria-label={t("Password")}
          aria-invalid={wrong ? "true" : undefined}
          aria-describedby={wrongId}
          value={value}
          onChange={(event) => setAnswer({ attempt, value: event.target.value })}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            submit();
          }}
        />
        <button
          type="button"
          className="pdfx-btn"
          aria-label={visible ? t("Hide password") : t("Show password")}
          aria-pressed={visible ? "true" : "false"}
          data-tip={visible ? t("Hide password") : t("Show password")}
          data-tip-align="end"
          data-testid="pdfx-action-password-reveal"
          onClick={() => setVisible((shown) => !shown)}
        >
          {visible ? <EyeOff size={18} strokeWidth={1.75} aria-hidden="true" /> : <Eye size={18} strokeWidth={1.75} aria-hidden="true" />}
        </button>
      </div>
      <p id={wrongId} className="pdfx-field-error" role="alert" data-testid={wrong ? "pdfx-password-wrong" : undefined}>
        {wrong ? t("Incorrect password. Try again.") : null}
      </p>
    </DialogFrame>
  );
}
