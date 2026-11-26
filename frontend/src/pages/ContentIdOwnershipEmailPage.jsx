import { useEffect, useRef, useState } from "react";
import { ExternalLink, Mail, Search } from "lucide-react";
import api from "../api/api";
import { useI18n } from "../context/I18nContext";
import { Button, CopyButton, Field, InlineMessage, Select, TextInput } from "./assetDelivery/shared";
import { useClaimAccounts } from "./claimManager/hooks";
import { requestMessage } from "./claimManager/utils";

function OwnerContact({ owner }) {
  const { t, tm } = useI18n();
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
      <span className="break-words font-semibold text-slate-900">{owner.name || owner.owner_id}</span>
      {owner.email ? (
        <span className="inline-flex max-w-full items-center gap-1">
          <a className="break-all text-blue-700 underline" href={`mailto:${encodeURIComponent(owner.email).replace("%40", "@")}`}>{owner.email}</a>
          <CopyButton text={owner.email} label={t("Copy email")} iconOnly />
        </span>
      ) : <span className="text-slate-600">{owner.contact_error ? tm(owner.contact_error) : t("YouTube did not provide a contact email.")}</span>}
    </div>
  );
}

function VideoOwnership({ video }) {
  const { t, tm } = useI18n();
  return (
    <article className="space-y-3 border-t border-slate-200 py-4">
      <header>
        <h3 className="font-semibold text-blue-800">
          <a className="hover:underline" target="_blank" rel="noreferrer" href={`https://www.youtube.com/watch?v=${video.id}`}>{video.title || video.id}</a>
        </h3>
        <p className="mt-1 text-xs text-slate-600"><span className="font-mono">{video.id}</span>{video.licensed && <> · {t("Marked as licensed content by YouTube")}</>}</p>
      </header>
      {video.warnings.map((message) => <InlineMessage key={message} tone="warning">{tm(message)}</InlineMessage>)}
      {!video.assets.length && <p className="text-sm text-slate-600">{t("No upload asset was identified for this video.")}</p>}
      {video.assets.map((asset) => (
        <section key={asset.id} className="space-y-2 rounded-xl border border-slate-200 p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h4 className="text-sm font-bold">{asset.title || asset.id}</h4>
            <a href={asset.ownership_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:underline">
              {t("Ownership and Policy")} <ExternalLink size={13} />
            </a>
          </div>
          <p className="break-all font-mono text-xs text-slate-600">{asset.id}</p>
          {asset.evidence === "title" ? (
            <p className="rounded-md bg-amber-50 px-2 py-1.5 text-sm text-amber-900">{t("Matching title only. The link between this asset and the video is unconfirmed.")}</p>
          ) : (
            <p className="text-sm font-medium text-emerald-700">{asset.evidence === "upload_claim" ? t("Linked by an active upload claim") : t("Linked by a reference with this video ID")}</p>
          )}
          {asset.owners.length ? asset.owners.map((owner) => <OwnerContact key={owner.owner_id} owner={owner} />)
            : <p className="text-sm text-slate-600">{t("YouTube did not return effective ownership for this asset.")}</p>}
        </section>
      ))}
    </article>
  );
}

export default function ContentIdOwnershipEmailPage() {
  const { t, tm } = useI18n();
  const accounts = useClaimAccounts();
  const networks = accounts.accounts.filter((account) => account.has_partner_scope);
  const [selected, setSelected] = useState("");
  const [input, setInput] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const pending = useRef(null);
  const networkId = networks.find((network) => String(network.id) === selected)?.id || networks[0]?.id;
  useEffect(() => () => pending.current?.abort(), []);

  function reset() {
    pending.current?.abort();
    setResult(null);
    setError("");
    setLoading(false);
  }

  async function search(pageToken) {
    pending.current?.abort();
    const id = input.trim();
    if (!/^(?:UC[\w-]{22}|[\w-]{11})$/.test(id)) {
      setError(t("Enter a valid YouTube channel ID or video ID."));
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    if (!pageToken) setResult(null);
    setLoading(true);
    setError("");
    let token = pageToken;
    const seen = new Set();
    try {
      do {
        if (seen.has(token)) throw new Error(t("YouTube returned a repeated uploads page."));
        seen.add(token);
        const { data } = await api.get("/content-id/ownership-email", {
          params: { network_id: networkId, id, page_token: token || undefined },
          signal: controller.signal, timeout: 120000
        });
        if (controller.signal.aborted) return;
        setResult((prior) => {
          const videos = new Map((prior?.videos || []).map((video) => [video.id, video]));
          for (const video of data.videos) videos.set(video.id, video);
          const warnings = new Set([...(prior?.warnings || []), ...data.warnings]);
          return { channel: data.channel, videos: [...videos.values()], next_page_token: data.next_page_token, warnings: [...warnings] };
        });
        token = data.next_page_token;
      } while (token);
    } catch (err) {
      if (!controller.signal.aborted) setError(requestMessage(err));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5 px-4 py-6 sm:px-6">
      <header>
        <div className="mb-3 inline-flex rounded-2xl bg-indigo-50 p-3 text-indigo-700"><Mail size={24} aria-hidden="true" /></div>
        <h1 className="text-2xl font-black text-slate-900">{t("Ownership email")}</h1>
        <p className="mt-1 text-sm text-slate-600">{t("Look up a channel’s managing network and the ownership contacts for its video assets.")}</p>
      </header>
      <form className="grid items-end gap-3 rounded-2xl border border-slate-200 bg-white p-4 sm:grid-cols-[1fr_2fr_auto]" onSubmit={(event) => { event.preventDefault(); search(); }}>
        <Field htmlFor="ownership-cms" label={t("CMS")}>
          <Select id="ownership-cms" value={networkId || ""} disabled={accounts.loading || !networks.length} onChange={(event) => { reset(); setSelected(event.target.value); }}>
            {!networks.length && <option value="">{accounts.loading ? t("Loading…") : "—"}</option>}
            {networks.map((network) => <option key={network.id} value={network.id}>{network.name}</option>)}
          </Select>
        </Field>
        <Field htmlFor="ownership-id" label={t("Channel ID or video ID")}>
          <TextInput id="ownership-id" required value={input} spellCheck={false} onChange={(event) => { reset(); setInput(event.target.value); }} />
        </Field>
        <Button type="submit" icon={Search} loading={loading && !result} disabled={!networkId || !input.trim() || loading}>{t("Search")}</Button>
      </form>
      {accounts.error && <InlineMessage tone="error" actions={<Button onClick={accounts.reload} variant="secondary">{t("Retry")}</Button>}>{tm(accounts.error)}</InlineMessage>}
      {!accounts.loading && !accounts.error && !networks.length && <InlineMessage tone="warning">{t("A connected CMS with YouTube Partner access is required.")}</InlineMessage>}
      {error && <InlineMessage tone="error">{tm(error)}</InlineMessage>}
      {result && (
        <>
          {result.warnings.map((message) => <InlineMessage tone="warning" key={message}>{tm(message)}</InlineMessage>)}
          <section className="space-y-3 rounded-2xl border border-slate-200 bg-white p-5">
            <h2 className="text-lg font-bold"><a className="text-blue-800 hover:underline" target="_blank" rel="noreferrer" href={`https://www.youtube.com/channel/${result.channel.id}`}>{result.channel.title}</a></h2>
            <p className="break-all font-mono text-xs text-slate-500">{result.channel.id}</p>
            <h3 className="text-sm font-bold">{t("Channel managing network")}</h3>
            {result.channel.manager ? <OwnerContact owner={result.channel.manager} />
              : <p className="text-sm text-slate-600">{t("YouTube did not disclose the channel’s managing network to this CMS.")}</p>}
          </section>
          <section className="rounded-2xl border border-slate-200 bg-white p-5">
            <h2 className="font-bold">{t("Video asset ownership")}</h2>
            <p className="mb-3 mt-1 text-sm text-slate-600">{t("Videos checked: {count}", { count: result.videos.length })}</p>
            {result.videos.map((video) => <VideoOwnership key={video.id} video={video} />)}
            {result.next_page_token && (loading
              ? <Button variant="secondary" onClick={() => { pending.current?.abort(); setLoading(false); }}>{t("Stop checking uploads")}</Button>
              : <Button variant="secondary" onClick={() => search(result.next_page_token)}>{t("Check more uploads")}</Button>)}
          </section>
        </>
      )}
    </div>
  );
}
