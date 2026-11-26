import { useId, useRef } from "react";
import { Lock, ShieldAlert, TriangleAlert } from "lucide-react";
import { useI18n } from "../../../context/I18nContext";
import DialogFrame, { DialogButton } from "../ui/dialogs/DialogFrame.jsx";
import { useEditor } from "../ui/editorHooks.js";

// What "Sign with certificate" has to ask or say BEFORE its drawer opens (UX specification 7.11):
//   kind "insecure"         the page is not in a secure context (no WebCrypto): say that the site must be opened
//                           over https; nothing that would fail is offered
//   kind "signedWithEdits"  the document has signatures and edits that are in no file yet:
//                             "keep"   Add my signature only: the edits are discarded (after saying how many)
//                             "apply"  Apply my edits and sign: the document is rewritten, the existing
//                                      signatures are not kept
//   kind "locked"           certified with "no changes allowed": only a rewritten copy can be signed ("rewrite")
//   kind "rewrite"          the file cannot take a signature as it is (protected with a password, damaged):
//                           a decrypted, rewritten copy is signed instead ("rewrite")
//   kind "cannotSign"       the file can only be viewed here (the writer refused it: `code` says why): it is
//                           not signed as it is, and no copy can be made
// onClose(answer): "keep" | "apply" | "rewrite"; anything else = cancelled.
//
// Test hooks: pdfx-dialog-signChoice (data-kind on .pdfx-sign-choice), pdfx-action-sign-keep, -apply, -rewrite, -cancel.
export default function SignChoiceDialog({ kind, signatureCount = 0, changes = 0, canKeep = false, code, params, onClose }) {
  const { t } = useI18n();
  const { messages } = useEditor();
  const cancelRef = useRef(null);
  const textId = useId();
  const cancel = () => onClose(undefined);

  let title;
  let lead;
  let icon = TriangleAlert;
  let tone = "warning";
  const notes = [];
  const buttons = [];

  if (kind === "insecure") {
    title = t("Signing with a certificate is not available here");
    icon = ShieldAlert;
    lead = messages.describeCode("SIGN_NO_WEBCRYPTO");
    notes.push(t("Reading, editing and the picture signature keep working. Checking existing signatures also needs a secure connection."));
  } else if (kind === "signedWithEdits") {
    title = t("This document is already signed");
    lead =
      signatureCount === 1
        ? t("This document has 1 signature, and you made changes that are not in any file yet. Choose what gets signed.")
        : t("This document has {count} signatures, and you made changes that are not in any file yet. Choose what gets signed.", { count: signatureCount });
    if (!canKeep) notes.push(t("The document combines pages of several files or was rebuilt, so the existing signatures cannot be kept."));
  } else if (kind === "locked") {
    title = t("This document was locked by its signer");
    icon = Lock;
    lead = messages.describeCode(code || "SIGN_CERTIFIED_NO_CHANGES", params || {});
    notes.push(t("You can sign a copy instead: the copy is rewritten, and the existing signatures are not kept in it."));
    buttons.push({ id: "rewrite", label: t("Sign a rewritten copy") });
  } else if (kind === "rewrite") {
    title = t("This file cannot be signed as it is");
    lead = messages.describeCode(code, params || {});
    notes.push(
      code === "SIGN_ENCRYPTED"
        ? t("The editor can do that now: a decrypted, rewritten copy will be signed instead. The signed copy opens without a password, and existing signatures are not kept in it.")
        : t("The editor can do that now: a rewritten copy will be signed instead. Existing signatures are not kept in that copy.")
    );
    buttons.push({ id: "rewrite", label: t("Sign a rewritten copy") });
  } else {
    title = t("This file cannot be signed here");
    tone = "danger";
    lead = messages.describeCode(code, params || {});
    notes.push(t("A signature vouches for what a reader sees, and the editor cannot be sure that other PDF programs show this file the way it is shown here. It is therefore not signed, and a rewritten copy cannot be made from it."));
    notes.push(t("Print the file to a new PDF or repair it with another program, then open and sign the new file."));
  }

  return (
    <DialogFrame
      alert
      size="md"
      tone={tone}
      icon={icon}
      title={title}
      describedBy={textId}
      initialFocusRef={cancelRef}
      onClose={cancel}
      footer={
        <>
          <DialogButton ref={cancelRef} data-testid="pdfx-action-sign-cancel" onClick={cancel}>
            {buttons.length || kind === "signedWithEdits" ? t("Cancel") : t("Close")}
          </DialogButton>
          {buttons.map((button) => (
            <DialogButton key={button.id} variant="primary" data-testid={`pdfx-action-sign-${button.id}`} onClick={() => onClose(button.id)}>
              {button.label}
            </DialogButton>
          ))}
        </>
      }
    >
      <div id={textId} className="pdfx-sign-choice" data-kind={kind}>
        <p className="pdfx-dialog-text">{lead}</p>
        {notes.map((note) => (
          <p key={note} className="pdfx-dialog-note">
            {note}
          </p>
        ))}
        {kind === "signedWithEdits" ? (
          <div className="pdfx-sign-options">
            {canKeep ? (
              <button type="button" className="pdfx-sign-option" data-testid="pdfx-action-sign-keep" onClick={() => onClose("keep")}>
                <strong>{t("Add my signature only")}</strong>
                <span>
                  {changes === 1
                    ? t("Your 1 change is discarded. The file stays as it was signed, so the existing signatures stay valid.")
                    : changes > 1
                      ? t("Your {count} changes are discarded. The file stays as it was signed, so the existing signatures stay valid.", { count: changes })
                      : t("Your changes are discarded. The file stays as it was signed, so the existing signatures stay valid.")}
                </span>
              </button>
            ) : null}
            <button type="button" className="pdfx-sign-option" data-testid="pdfx-action-sign-apply" onClick={() => onClose("apply")}>
              <strong>{t("Apply my edits and sign")}</strong>
              <span>{t("The document is rewritten with your edits and then signed. The existing signatures are not kept in the signed copy.")}</span>
            </button>
          </div>
        ) : null}
      </div>
    </DialogFrame>
  );
}
