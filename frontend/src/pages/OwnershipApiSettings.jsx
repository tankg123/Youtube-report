import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import api from "../api/api";
import { useI18n } from "../context/I18nContext";
import { Button, CopyButton, Field, InlineMessage, TextInput } from "./assetDelivery/shared";
import { requestMessage } from "./claimManager/utils";

const keysPath = "/settings/ownership-api-keys";
const endpoint = `${api.defaults.baseURL.replace(/\/$/, "")}/public/ownership-email`;
const example = JSON.stringify({ "Channel ID": "UChqLjZzv_zWqBTHtsLlDNYA", "CMS Name": "Eternal MCN" }, null, 2);

export default function OwnershipApiSettings() {
  const { t, tm } = useI18n();
  const [keys, setKeys] = useState([]);
  const [name, setName] = useState("");
  const [secret, setSecret] = useState(null);
  const [confirmId, setConfirmId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    api.get(keysPath, { signal: controller.signal }).then(({ data }) => {
      if (!controller.signal.aborted) { setKeys(data.keys); setLoaded(true); }
    }).catch((err) => { if (!controller.signal.aborted) setError(requestMessage(err)); });
    return () => controller.abort();
  }, [reload]);

  async function create(event) {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const { data } = await api.post(keysPath, { name: name.trim() });
      setSecret({ id: data.id, value: data.key });
      setName("");
      setKeys((items) => [{ id: data.id, name: data.name, prefix: data.prefix }, ...items]);
    } catch (err) { setError(requestMessage(err)); }
    finally { setBusy(false); }
  }

  async function revoke(id) {
    setBusy(true);
    setError("");
    try {
      await api.delete(`${keysPath}/${id}`);
      setKeys((items) => items.map((item) => item.id === id ? { ...item, revoked_at: true } : item));
      if (secret?.id === id) setSecret(null);
      setConfirmId(null);
    } catch (err) { setError(requestMessage(err)); }
    finally { setBusy(false); }
  }

  return (
    <section className="surface-3d space-y-4 rounded-3xl border border-slate-200 bg-white p-6">
      <h2 className="flex items-center gap-2 text-lg font-bold text-slate-900"><KeyRound size={20} />{t("Ownership API keys")}</h2>
      <p className="text-sm text-slate-600">{t("Send the key in the x-api-key header. GET accepts query parameters and POST accepts a JSON body.")}</p>
      <code className="block break-all text-sm">{endpoint}</code>
      <details className="text-sm"><summary className="cursor-pointer font-semibold">{t("Request example")}</summary>
        <pre className="my-2 overflow-x-auto rounded-lg bg-slate-50 p-3">{example}</pre>
        <p>{t("Success returns the verified CMS email. Please check manually returns an empty Email. Token erro indicates a CMS token problem.")}</p>
        <p>{t("On a lookup problem, read message for the reason and videos_checked for the number of distinct videos checked. The default time limit is 30 seconds per channel (OWNERSHIP_CHANNEL_TIMEOUT_MS).")}</p>
      </details>
      <form className="flex flex-wrap items-end gap-2" onSubmit={create}>
        <Field htmlFor="ownership-key-name" label={t("Key name")}>
          <TextInput id="ownership-key-name" maxLength={100} required value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Button type="submit" disabled={!name.trim() || !loaded || busy}>{t("Create API key")}</Button>
      </form>
      {error && <InlineMessage tone="error" actions={!loaded && <Button onClick={() => { setError(""); setReload(reload + 1); }}>{t("Retry")}</Button>}>{tm(error)}</InlineMessage>}
      {secret && <div role="status" className="space-y-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm">
        <p>{t("Copy this key now. It is shown once.")}</p>
        <div className="flex flex-wrap items-center gap-2"><code className="break-all">{secret.value}</code><CopyButton text={secret.value} label={t("Copy API key")} /><Button size="sm" variant="ghost" onClick={() => setSecret(null)}>{t("Close")}</Button></div>
      </div>}
      <ul className="divide-y divide-slate-200">
        {keys.map((key) => <li key={key.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
          <span className="break-all"><strong>{key.name}</strong> <code className="text-slate-500">{key.prefix}…</code></span>
          {key.revoked_at ? <span>{t("Revoked")}</span> : confirmId === key.id ? (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => setConfirmId(null)}>{t("Cancel")}</Button>
              <Button size="sm" disabled={busy} onClick={() => revoke(key.id)}>{t("Confirm revocation")}</Button>
            </div>
          ) : <Button size="sm" variant="secondary" disabled={busy} onClick={() => setConfirmId(key.id)}>{t("Revoke key")}</Button>}
        </li>)}
      </ul>
    </section>
  );
}
