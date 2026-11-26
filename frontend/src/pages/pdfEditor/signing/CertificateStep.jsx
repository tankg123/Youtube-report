import { useEffect, useId, useRef, useState } from "react";
import { Download, Eye, EyeOff, FileKey2, IdCard, LoaderCircle, Trash2, TriangleAlert } from "lucide-react";
import { useI18n } from "../../../context/I18nContext";
import { isPdfEditorError } from "../engine/errors.js";
import { Chip } from "../ui/controls.jsx";
import { useEditor } from "../ui/editorHooks.js";
import { forgetAppearance } from "./certSignFlow.js";
import { forgetIdentity, getBackup, markBackupDownloaded, setIdentity } from "./identity.js";
import { fileStem, saveFile } from "./saveFile.js";
import { useIdentity } from "./signingHooks.js";

// Step 1 of "Sign with certificate" (UX specification 7.11): the signing identity.
//   * open a certificate file (.p12 / .pfx) with its password, or
//   * create a self-signed certificate in the page (its .p12 is offered for download at once)
// and, once there is an identity, the certificate card: issued to, issued by, validity, key, badges and what
// the engine noted about the certificate. The identity stays in memory for the tab (identity.js) until
// "Forget this certificate".
//
// Passwords live in the state of this component only while they are typed: they are handed to the engine once
// and the fields are emptied right after, whatever the outcome. Nothing of them is stored or logged.
//
// Test hooks: pdfx-sign-step-1; pdfx-cert-source-file / -create (radio), pdfx-cert-file-input,
// pdfx-cert-file-name, pdfx-cert-password (+ -reveal), pdfx-action-cert-open, pdfx-cert-error (data-code),
// pdfx-cert-name / -organisation / -email / -country / -years / -keytype / -newpassword / -repeat,
// pdfx-action-cert-create, pdfx-cert-card (data-self-signed, data-validity, data-block, data-backup),
// pdfx-cert-blocked, pdfx-cert-warning (data-code), pdfx-action-cert-download, pdfx-action-cert-forget.

const P12_TYPES = ".p12,.pfx,application/x-pkcs12";
/** A certificate file is a few kilobytes: anything this large is another kind of file and is not even read. */
const P12_MAX_BYTES = 5 * 1024 * 1024;
const YEARS = [1, 2, 3, 5, 10];
const DEFAULT_KEY_TYPE = "RSA-2048";
const MIN_PASSWORD = 6;
const COUNTRY_CODES =
  "VN AE AR AT AU BD BE BG BR CA CH CL CN CO CZ DE DK EE EG ES FI FR GB GR HK HR HU ID IE IL IN IT JP KH KR LA LT LU LV MM MX MY NG NL NO NZ PE PH PK PL PT QA RO RS RU SA SE SG SI SK TH TR TW UA US UY ZA".split(" ");

function PasswordField({ id, value, onChange, onEnter, invalid, describedBy, testId, inputRef, disabled }) {
  const { t } = useI18n();
  const [shown, setShown] = useState(false);
  return (
    <div className="pdfx-sign-password">
      <input
        ref={inputRef}
        id={id}
        className="pdfx-input"
        type={shown ? "text" : "password"}
        autoComplete="off"
        spellCheck="false"
        value={value}
        disabled={disabled}
        aria-invalid={invalid ? "true" : undefined}
        aria-describedby={describedBy}
        data-testid={testId}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || !onEnter) return;
          event.preventDefault();
          onEnter();
        }}
      />
      <button
        type="button"
        className="pdfx-btn"
        aria-label={shown ? t("Hide password") : t("Show password")}
        aria-pressed={shown ? "true" : "false"}
        data-tip={shown ? t("Hide password") : t("Show password")}
        data-tip-align="end"
        data-testid={`${testId}-reveal`}
        onClick={() => setShown((now) => !now)}
      >
        {shown ? <EyeOff size={16} strokeWidth={1.75} aria-hidden="true" /> : <Eye size={16} strokeWidth={1.75} aria-hidden="true" />}
      </button>
    </div>
  );
}

/** The certificate file with its password. */
function OpenForm({ onOpened }) {
  const { t } = useI18n();
  const editor = useEditor();
  const [file, setFile] = useState(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null); // { code, text }
  const passwordRef = useRef(null);
  const fileRef = useRef(null);
  const abortRef = useRef(null);
  const errorId = useId();
  const passwordId = useId();

  // leaving the step stops a key derivation that is still running
  useEffect(() => () => abortRef.current?.abort(), []);

  // a wrong password: the keyboard goes back to the (emptied) password field once it can be typed in again
  const retry = !busy && (failure?.code === "CERT_WRONG_PASSWORD" || failure?.code === "CERT_DECRYPT_FAILED");
  useEffect(() => {
    if (retry) passwordRef.current?.focus();
  }, [retry, failure]);

  const open = async () => {
    if (!file || busy) return;
    if (file.size > P12_MAX_BYTES) {
      setPassword("");
      setFailure({ code: "CERT_NOT_PKCS12", text: editor.messages.describeCode("CERT_NOT_PKCS12", { hint: null }) });
      return;
    }
    const secret = password;
    setBusy(true);
    setFailure(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const signing = await editor.loadSigning();
      const bytes = new Uint8Array(await file.arrayBuffer());
      const identity = await signing.loadPkcs12(bytes, secret, { signal: controller.signal });
      if (controller.signal.aborted) return;
      onOpened(identity, file.name);
    } catch (error) {
      if (controller.signal.aborted || editor.messages.isSilent(error)) return;
      const code = isPdfEditorError(error) ? error.code : "CERT_CORRUPT";
      setFailure({ code, text: editor.messages.describeError(error) });
    } finally {
      // used once: the field never keeps a password
      setPassword("");
      if (abortRef.current === controller) abortRef.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  return (
    <div className="pdfx-sign-form">
      <div className="pdfx-sign-row">
        <button type="button" className="pdfx-btn pdfx-btn-text pdfx-btn-outline" disabled={busy} onClick={() => fileRef.current?.click()}>
          <FileKey2 size={16} strokeWidth={1.75} aria-hidden="true" />
          <span className="pdfx-btn-label">{t("Choose file")}</span>
        </button>
        <span className="pdfx-sign-file" data-testid="pdfx-cert-file-name">
          {file ? file.name : t("No file chosen")}
        </span>
        <input
          ref={fileRef}
          type="file"
          accept={P12_TYPES}
          hidden
          tabIndex={-1}
          data-testid="pdfx-cert-file-input"
          onChange={(event) => {
            const [chosen] = event.target.files;
            event.target.value = "";
            if (!chosen) return;
            setFile(chosen);
            setFailure(null);
            queueMicrotask(() => passwordRef.current?.focus());
          }}
        />
      </div>
      <label className="pdfx-sign-label" htmlFor={passwordId}>
        {t("Certificate password")}
      </label>
      <PasswordField id={passwordId} inputRef={passwordRef} value={password} onChange={setPassword} onEnter={open} invalid={Boolean(failure)} describedBy={errorId} disabled={busy} testId="pdfx-cert-password" />
      <p id={errorId} className="pdfx-sign-error" role="alert" data-code={failure?.code || ""} data-testid={failure ? "pdfx-cert-error" : undefined}>
        {failure ? failure.text : null}
      </p>
      <p className="pdfx-sign-hint">{t("The password is used once to open the file. Neither the password nor the certificate is stored.")}</p>
      <div className="pdfx-sign-actions">
        <button type="button" className="pdfx-btn pdfx-btn-text pdfx-btn-primary" disabled={!file || busy} data-testid="pdfx-action-cert-open" onClick={open}>
          {busy ? <LoaderCircle size={16} strokeWidth={2} aria-hidden="true" className="pdfx-spin" /> : null}
          <span className="pdfx-btn-label">{busy ? t("Opening the certificate…") : t("Open certificate")}</span>
        </button>
      </div>
    </div>
  );
}

/** A new self-signed certificate. */
function CreateForm({ onCreated }) {
  const { t, regionName } = useI18n();
  const editor = useEditor();
  const [form, setForm] = useState({ commonName: "", organization: "", email: "", country: "VN", years: 2, keyType: DEFAULT_KEY_TYPE });
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [keyTypes, setKeyTypes] = useState([DEFAULT_KEY_TYPE]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null); // { field, text }
  const nameId = useId();
  const organisationId = useId();
  const emailId = useId();
  const countryId = useId();
  const yearsId = useId();
  const keyId = useId();
  const passwordId = useId();
  const repeatId = useId();
  const errorId = useId();
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    // the key types the engine can generate
    editor
      .loadSigning()
      .then((signing) => {
        if (live.current && Array.isArray(signing.KEY_TYPES) && signing.KEY_TYPES.length) setKeyTypes([...signing.KEY_TYPES]);
      })
      .catch(() => {});
    return () => {
      live.current = false;
    };
  }, [editor]);

  const set = (key, value) => {
    setForm((current) => ({ ...current, [key]: value }));
    setFailure(null);
  };
  const typePassword = (value) => {
    setPassword(value);
    setFailure(null);
  };
  const typeRepeat = (value) => {
    setRepeat(value);
    setFailure(null);
  };
  const keyLabel = (type) => {
    const rsa = /^RSA-(\d+)$/.exec(type);
    return rsa ? t("RSA {bits}-bit", { bits: rsa[1] }) : t("Elliptic curve {curve}", { curve: type });
  };

  const create = async () => {
    if (busy) return;
    const name = form.commonName.trim();
    if (!name) {
      setFailure({ field: "commonName", text: editor.messages.describeCode("CERT_INVALID_OPTIONS", { field: "commonName" }) });
      return;
    }
    if (password.length < MIN_PASSWORD) {
      setFailure({ field: "password", text: t("Choose a password of at least {count} characters for the certificate file.", { count: MIN_PASSWORD }) });
      return;
    }
    if (password !== repeat) {
      setFailure({ field: "repeat", text: t("The two passwords are not the same.") });
      return;
    }
    const secret = password;
    setBusy(true);
    setFailure(null);
    try {
      const signing = await editor.loadSigning();
      const options = { commonName: name, years: Number(form.years), keyType: form.keyType, p12Password: secret };
      if (form.organization.trim()) options.organization = form.organization.trim();
      if (form.email.trim()) options.email = form.email.trim();
      if (form.country) options.country = form.country;
      const identity = await signing.createSelfSigned(options);
      if (live.current) onCreated(identity, `${fileStem(name)}.p12`);
    } catch (error) {
      if (live.current) setFailure({ field: isPdfEditorError(error) ? String(error.params?.field || "") : "", text: editor.messages.describeError(error) });
    } finally {
      // used once: the fields never keep a password
      setPassword("");
      setRepeat("");
      if (live.current) setBusy(false);
    }
  };

  const invalid = (field) => (failure?.field === field ? "true" : undefined);
  return (
    <div className="pdfx-sign-form">
      <label className="pdfx-sign-label" htmlFor={nameId}>
        {t("Name")} <span aria-hidden="true">*</span>
      </label>
      <input id={nameId} className="pdfx-input" maxLength={64} required aria-invalid={invalid("commonName")} aria-describedby={errorId} value={form.commonName} disabled={busy} data-testid="pdfx-cert-name" onChange={(event) => set("commonName", event.target.value)} />
      <label className="pdfx-sign-label" htmlFor={organisationId}>
        {t("Organisation")}
      </label>
      <input id={organisationId} className="pdfx-input" maxLength={64} value={form.organization} disabled={busy} data-testid="pdfx-cert-organisation" onChange={(event) => set("organization", event.target.value)} />
      <label className="pdfx-sign-label" htmlFor={emailId}>
        {t("E-mail")}
      </label>
      <input id={emailId} className="pdfx-input" type="email" autoComplete="off" aria-invalid={invalid("email")} aria-describedby={errorId} value={form.email} disabled={busy} data-testid="pdfx-cert-email" onChange={(event) => set("email", event.target.value)} />
      <div className="pdfx-sign-columns">
        <div>
          <label className="pdfx-sign-label" htmlFor={countryId}>
            {t("Country")}
          </label>
          <select id={countryId} className="pdfx-input" value={form.country} disabled={busy} data-testid="pdfx-cert-country" onChange={(event) => set("country", event.target.value)}>
            <option value="">{t("Not stated")}</option>
            {COUNTRY_CODES.map((code) => (
              <option key={code} value={code}>
                {t("{country} ({code})", { country: regionName(code, code), code })}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="pdfx-sign-label" htmlFor={yearsId}>
            {t("Valid for")}
          </label>
          <select id={yearsId} className="pdfx-input" value={form.years} disabled={busy} data-testid="pdfx-cert-years" onChange={(event) => set("years", Number(event.target.value))}>
            {YEARS.map((years) => (
              <option key={years} value={years}>
                {years === 1 ? t("1 year") : t("{count} years", { count: years })}
              </option>
            ))}
          </select>
        </div>
      </div>
      <label className="pdfx-sign-label" htmlFor={keyId}>
        {t("Key type")}
      </label>
      <select id={keyId} className="pdfx-input" value={form.keyType} disabled={busy} data-testid="pdfx-cert-keytype" onChange={(event) => set("keyType", event.target.value)}>
        {keyTypes.map((type) => (
          <option key={type} value={type}>
            {keyLabel(type)}
          </option>
        ))}
      </select>
      <label className="pdfx-sign-label" htmlFor={passwordId}>
        {t("Password for the .p12 file")} <span aria-hidden="true">*</span>
      </label>
      <PasswordField id={passwordId} value={password} onChange={typePassword} invalid={failure?.field === "password"} describedBy={errorId} disabled={busy} testId="pdfx-cert-newpassword" />
      <label className="pdfx-sign-label" htmlFor={repeatId}>
        {t("Repeat the password")} <span aria-hidden="true">*</span>
      </label>
      <PasswordField id={repeatId} value={repeat} onChange={typeRepeat} onEnter={create} invalid={failure?.field === "repeat"} describedBy={errorId} disabled={busy} testId="pdfx-cert-repeat" />
      <p id={errorId} className="pdfx-sign-error" role="alert" data-field={failure?.field || ""} data-testid={failure ? "pdfx-cert-error" : undefined}>
        {failure ? failure.text : null}
      </p>
      <p className="pdfx-sign-hint">{t("A self-signed certificate shows that the file was not changed after signing. Other programs will show the signer as not verified.")}</p>
      <div className="pdfx-sign-actions">
        <button type="button" className="pdfx-btn pdfx-btn-text pdfx-btn-primary" disabled={busy} data-testid="pdfx-action-cert-create" onClick={create}>
          {busy ? <LoaderCircle size={16} strokeWidth={2} aria-hidden="true" className="pdfx-spin" /> : <IdCard size={16} strokeWidth={1.75} aria-hidden="true" />}
          <span className="pdfx-btn-label">{busy ? t("Creating the certificate…") : t("Create certificate")}</span>
        </button>
      </div>
    </div>
  );
}

/** The certificate of the identity in memory. `compact`: the short form of the summary in step 4. */
export function CertificateCard({ identity, compact = false }) {
  const { t, formatDate } = useI18n();
  const editor = useEditor();
  const { facts } = identity;
  const subject = facts.subject || {};
  const issuer = facts.issuer || {};
  // the validity is said by the badge and the sentence under the facts: not a second time as a warning
  const warnings = [...new Map(identity.warnings.filter((warning) => warning.code !== "CERT_EXPIRED" && warning.code !== "CERT_NOT_YET_VALID").map((warning) => [warning.code, warning])).values()];
  const backup = compact ? null : getBackup();
  const download = () => {
    if (!backup) return;
    saveFile(editor, backup.bytes, backup.fileName, "application/x-pkcs12");
    markBackupDownloaded();
  };
  return (
    <div className="pdfx-sign-card" data-testid="pdfx-cert-card" data-self-signed={facts.selfSigned ? "true" : "false"} data-validity={facts.validity || ""} data-block={identity.block || ""} data-backup={identity.backup}>
      <div className="pdfx-sign-card-head">
        <strong className="pdfx-sign-card-name">{subject.commonName || facts.displayName || t("Unnamed certificate")}</strong>
        <span className="pdfx-sign-badges">
          {facts.selfSigned ? <Chip tone="warning">{t("Self-signed")}</Chip> : null}
          {facts.validity === "expired" ? <Chip tone="danger">{t("Expired")}</Chip> : null}
          {facts.validity === "notYetValid" ? <Chip tone="danger">{t("Not yet valid")}</Chip> : null}
        </span>
      </div>
      <dl className="pdfx-sign-facts">
        <div>
          <dt>{t("Issued to")}</dt>
          <dd>{[subject.commonName || facts.displayName, subject.organization].filter(Boolean).join(", ") || "-"}</dd>
        </div>
        <div>
          <dt>{t("Issued by")}</dt>
          <dd>{facts.selfSigned ? t("The holder itself (self-signed)") : [issuer.commonName || facts.issuerDisplayName, issuer.organization].filter(Boolean).join(", ") || "-"}</dd>
        </div>
        <div>
          <dt>{t("Validity")}</dt>
          <dd>{t("{from} to {to}", { from: formatDate(facts.notBefore), to: formatDate(facts.notAfter) })}</dd>
        </div>
        {compact ? null : (
          <div>
            <dt>{t("Key")}</dt>
            <dd>{identity.key || "-"}</dd>
          </div>
        )}
      </dl>
      {identity.block === "expired" ? (
        <p className="pdfx-sign-error" role="alert" data-testid="pdfx-cert-blocked">
          {t("This certificate expired on {date} and cannot be used to sign.", { date: formatDate(facts.notAfter) })}
        </p>
      ) : null}
      {identity.block === "notYetValid" ? (
        <p className="pdfx-sign-error" role="alert" data-testid="pdfx-cert-blocked">
          {t("This certificate is not valid before {date} and cannot be used to sign yet.", { date: formatDate(facts.notBefore) })}
        </p>
      ) : null}
      {compact
        ? null
        : warnings.map((warning) => (
            <p key={warning.code} className="pdfx-sign-warning" data-code={warning.code} data-testid="pdfx-cert-warning">
              <TriangleAlert size={14} strokeWidth={2} aria-hidden="true" />
              <span>{editor.messages.describeWarning(warning)}</span>
            </p>
          ))}
      {backup ? (
        <div className="pdfx-sign-backup" data-state={identity.backup}>
          <p>
            {identity.backup === "downloaded"
              ? t("The certificate file was downloaded. Keep it and its password in a safe place: you need both to sign with this certificate again.")
              : t("Download the certificate file now. It is not stored and is lost when you close this page.")}
          </p>
          <button type="button" className={identity.backup === "downloaded" ? "pdfx-btn pdfx-btn-text pdfx-btn-outline" : "pdfx-btn pdfx-btn-text pdfx-btn-primary"} data-testid="pdfx-action-cert-download" onClick={download}>
            <Download size={16} strokeWidth={1.75} aria-hidden="true" />
            <span className="pdfx-btn-label">{t("Download .p12")}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default function CertificateStep() {
  const { t } = useI18n();
  const identity = useIdentity();
  const [source, setSource] = useState("file");
  const groupName = useId();

  if (identity) {
    return (
      <div className="pdfx-sign-step" data-testid="pdfx-sign-step-1">
        <CertificateCard identity={identity} />
        {identity.facts.selfSigned ? <p className="pdfx-sign-hint">{t("A self-signed certificate shows that the file was not changed after signing. Other programs will show the signer as not verified.")}</p> : null}
        <p className="pdfx-sign-hint">{t("This certificate stays in memory for this tab only, so that you can sign several documents in a row.")}</p>
        <div className="pdfx-sign-actions pdfx-sign-actions-start">
          <button
            type="button"
            className="pdfx-btn pdfx-btn-text pdfx-btn-outline"
            data-testid="pdfx-action-cert-forget"
            onClick={() => {
              forgetIdentity();
              forgetAppearance();
            }}
          >
            <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
            <span className="pdfx-btn-label">{t("Forget this certificate")}</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="pdfx-sign-step" data-testid="pdfx-sign-step-1">
      <p className="pdfx-sign-lead">{t("Choose the certificate to sign with.")}</p>
      <div className="pdfx-sign-sources" role="radiogroup" aria-label={t("Where the certificate comes from")}>
        <label className="pdfx-sign-source" data-checked={source === "file" ? "true" : "false"}>
          <input type="radio" name={groupName} checked={source === "file"} data-testid="pdfx-cert-source-file" onChange={() => setSource("file")} />
          <span>{t("Use a certificate file (.p12 / .pfx)")}</span>
        </label>
        {source === "file" ? <OpenForm onOpened={(opened, fileName) => setIdentity(opened, { origin: "file", fileName })} /> : null}
        <label className="pdfx-sign-source" data-checked={source === "create" ? "true" : "false"}>
          <input type="radio" name={groupName} checked={source === "create"} data-testid="pdfx-cert-source-create" onChange={() => setSource("create")} />
          <span>{t("Use a new self-signed certificate")}</span>
        </label>
        {source === "create" ? <CreateForm onCreated={(created, fileName) => setIdentity(created, { origin: "created", fileName })} /> : null}
      </div>
    </div>
  );
}
