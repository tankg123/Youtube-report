import { useId, useRef, useState } from "react";
import { ChevronDown, ChevronUp, FilePlus2, ShieldCheck, Trash2 } from "lucide-react";
import { useI18n } from "../../../context/I18nContext";
import { useEditor } from "../ui/editorHooks.js";
import { useTrustedCertificates } from "./signingHooks.js";
import { getTrustList, reinspectAll } from "./state.js";
import { MAX_CERTIFICATE_BYTES, certificatesOfFile, trustedEntry } from "./storage.js";

// "Trusted certificates on this device": the small list that lets a signer ever read as verified.
// The user imports the PUBLIC certificate of an authority or of a signer they trust (.cer / .crt / .pem); the
// list is kept in localStorage of this browser and handed to the signature check, so that a signature whose
// certificate leads to one of them is shown as "Valid". Nothing but public certificates is ever stored: a file
// with a private key is refused, and of a text file only the blocks labelled CERTIFICATE are read.
//
// Test hooks: pdfx-trust (data-count, data-open), pdfx-action-trust-toggle, pdfx-trust-input,
// pdfx-action-trust-import, pdfx-trust-item (data-id), pdfx-action-trust-remove, pdfx-trust-message (data-tone).

const CERTIFICATE_TYPES = ".cer,.crt,.pem,.der,application/x-x509-ca-cert,application/pkix-cert,application/x-pem-file";

export default function TrustedCertificates() {
  const { t, formatDate } = useI18n();
  const editor = useEditor();
  const trusted = useTrustedCertificates();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState(null); // { tone: "ok" | "bad", text }
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  const bodyId = useId();

  const importFiles = async (files) => {
    setBusy(true);
    setMessage(null);
    let added = 0;
    let known = 0;
    let refused = "";
    try {
      const signing = await editor.loadSigning();
      for (const file of files) {
        if (file.size > MAX_CERTIFICATE_BYTES * 8) {
          refused = t("{name} is not a certificate file.", { name: file.name });
          continue;
        }
        const found = certificatesOfFile(new Uint8Array(await file.arrayBuffer()));
        if (!found.certificates.length) {
          refused = found.hasPrivateKey
            ? t("{name} holds a private key. Choose a file that holds only the certificate (.cer, .crt or .pem): a private key is never stored here.", { name: file.name })
            : t("{name} is not a certificate file.", { name: file.name });
          continue;
        }
        for (const der of found.certificates) {
          try {
            const facts = await signing.certificateFacts(der);
            const result = getTrustList().add(trustedEntry(der, facts));
            if (!result.ok) refused = result.reason === "full" ? t("The list is full. Remove a certificate first.") : t("{name} is not a certificate file.", { name: file.name });
            else if (result.added) added += 1;
            else known += 1;
          } catch (error) {
            refused = editor.messages.describeError(error);
          }
        }
      }
    } catch (error) {
      refused = editor.messages.describeError(error);
    }
    setBusy(false);
    if (added) reinspectAll(editor);
    if (refused) setMessage({ tone: "bad", text: refused });
    else if (added === 1) setMessage({ tone: "ok", text: t("1 certificate was added. The signatures are checked again.") });
    else if (added > 1) setMessage({ tone: "ok", text: t("{count} certificates were added. The signatures are checked again.", { count: added }) });
    else if (known) setMessage({ tone: "ok", text: t("This certificate is already in the list.") });
  };

  const remove = (entry) => {
    if (!getTrustList().remove(entry.id)) return;
    setMessage({ tone: "ok", text: t("{name} was removed. The signatures are checked again.", { name: entry.subject || t("The certificate") }) });
    reinspectAll(editor);
  };

  return (
    <section className="pdfx-trust" data-count={trusted.length} data-open={open ? "true" : "false"} data-testid="pdfx-trust">
      <button type="button" className="pdfx-trust-toggle" aria-expanded={open ? "true" : "false"} aria-controls={bodyId} data-testid="pdfx-action-trust-toggle" onClick={() => setOpen((now) => !now)}>
        <ShieldCheck size={15} strokeWidth={1.75} aria-hidden="true" />
        <span>{trusted.length ? t("Trusted certificates on this device ({count})", { count: trusted.length }) : t("Trusted certificates on this device")}</span>
        {open ? <ChevronUp size={15} strokeWidth={1.75} aria-hidden="true" /> : <ChevronDown size={15} strokeWidth={1.75} aria-hidden="true" />}
      </button>
      {open ? (
        <div id={bodyId} className="pdfx-trust-body">
          <p className="pdfx-sign-hint">
            {t("This list is your own decision and stays in this browser on this device: a signature whose certificate leads to a certificate listed here is shown as Valid. Only public certificates are kept (.cer, .crt or .pem files).")}
          </p>
          {trusted.length ? (
            <ul className="pdfx-trust-list">
              {trusted.map((entry) => (
                <li key={entry.id} data-id={entry.id} data-testid="pdfx-trust-item">
                  <div className="pdfx-trust-text">
                    <strong>{entry.subject || t("Unnamed certificate")}</strong>
                    <span>{entry.selfSigned ? t("Self-signed") : t("Issued by {name}", { name: entry.issuer || "-" })}</span>
                    {entry.notAfter ? <span>{t("Valid until {date}", { date: formatDate(entry.notAfter) })}</span> : null}
                    <span className="pdfx-mono" title={entry.id}>
                      {t("Fingerprint {value}", { value: `${entry.id.slice(0, 23)}…` })}
                    </span>
                  </div>
                  <button type="button" className="pdfx-btn" aria-label={t("Remove {name} from the trusted certificates", { name: entry.subject || entry.id.slice(0, 11) })} data-tip={t("Remove")} data-tip-align="end" data-testid="pdfx-action-trust-remove" onClick={() => remove(entry)}>
                    <Trash2 size={15} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="pdfx-sign-hint">{t("No certificate is trusted yet, so every signer is shown as not verified.")}</p>
          )}
          <button type="button" className="pdfx-btn pdfx-btn-text pdfx-btn-outline" disabled={busy} data-testid="pdfx-action-trust-import" onClick={() => inputRef.current?.click()}>
            <FilePlus2 size={15} strokeWidth={1.75} aria-hidden="true" />
            <span className="pdfx-btn-label">{t("Add a certificate")}</span>
          </button>
          <input
            ref={inputRef}
            type="file"
            accept={CERTIFICATE_TYPES}
            multiple
            hidden
            tabIndex={-1}
            data-testid="pdfx-trust-input"
            onChange={(event) => {
              const files = [...event.target.files];
              event.target.value = "";
              if (files.length) importFiles(files);
            }}
          />
          <p className="pdfx-trust-message" role="status" data-tone={message?.tone || ""} data-testid={message ? "pdfx-trust-message" : undefined}>
            {message ? message.text : null}
          </p>
        </div>
      ) : null}
    </section>
  );
}
