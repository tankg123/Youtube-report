import { useEffect, useState } from "react";
import { Mail, RefreshCw } from "lucide-react";
import { getThirdPartyUploads } from "../../api/contentIdClaimsApi";
import { useI18n } from "../../context/I18nContext";
import { Button, CopyButton, InlineMessage, Modal, Spinner } from "../assetDelivery/shared";
import { ClaimStatusBadge, LinkButton } from "./shared";
import { isCanceled, requestMessage } from "./utils";

export default function ThirdPartyUploadsModal({ video, networks, onClose }) {
  const { t, tm } = useI18n();
  const [attempt, setAttempt] = useState(0);
  const [response, setResponse] = useState(null);
  const videoId = video.video_id;
  const loading = !response || response.attempt !== attempt;
  const claims = response?.data?.claims || [];
  const errors = response?.data?.errors || [];

  useEffect(() => {
    const controller = new AbortController();
    getThirdPartyUploads(videoId, networks.map((network) => network.id), { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setResponse({ attempt, data });
      })
      .catch((error) => {
        if (!controller.signal.aborted && !isCanceled(error)) setResponse({ attempt, error: requestMessage(error) });
      });
    return () => controller.abort();
  }, [attempt, networks, videoId]);

  return (
    <Modal
      open
      size="lg"
      title={t("Third-party uploads")}
      subtitle={video.title || video.video_title || videoId}
      onClose={onClose}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          {(response?.error || errors.length > 0) && (
            <Button variant="secondary" icon={RefreshCw} disabled={loading} onClick={() => setAttempt(attempt + 1)}>
              {t("Retry")}
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>{t("Close")}</Button>
        </div>
      }
    >
      {loading ? (
        <p role="status" className="flex items-center gap-2 text-sm text-slate-600"><Spinner />{t("Checking third-party uploads…")}</p>
      ) : (
        <div className="space-y-3">
          {response.error && <InlineMessage tone="error">{tm(response.error)}</InlineMessage>}
          {errors.map((error, index) => (
            <InlineMessage key={`${error.network_id}:${index}`} tone="warning" title={error.network_name}>
              {tm(error.message)}
            </InlineMessage>
          ))}
          {!claims.length && !response.error && !errors.length && <p className="text-sm text-slate-600">{t("No third-party upload claims found.")}</p>}
          {claims.map((claim) => (
            <article key={`${claim.network_id}:${claim.claim_id}`} className="space-y-3 rounded-2xl border border-slate-200 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="break-words text-sm font-bold text-slate-900">
                    {claim.asset_title || claim.asset_id}{claim.artists?.length ? ` - ${claim.artists.join(", ")}` : ""}
                  </h3>
                  <p className="break-all text-xs text-slate-600">
                    {t("Lookup CMS: {name}", { name: claim.network_name })} · {t("Asset")} {claim.asset_id} · {t("Claim")} {claim.claim_id}
                  </p>
                </div>
                <ClaimStatusBadge status={claim.status} />
              </div>
              <div className="space-y-2 border-t border-slate-100 pt-3">
                <h4 className="text-xs font-bold text-slate-600">{claim.ownership_source === "submitted"
                  ? t("Submitted ownership") : claim.ownership_source === "effective" ? t("Effective ownership") : t("Ownership contact")}</h4>
                {claim.contacts === null && <p className="text-sm text-slate-600">{t("Ownership contacts could not be loaded.")}</p>}
                {claim.contacts?.length === 0 && <p className="text-sm text-slate-600">{t("YouTube did not provide an ownership contact.")}</p>}
                {claim.contacts?.map((contact) => {
                  const subject = t("Ownership request for asset {id}", { id: claim.asset_id });
                  const body = t("I am contacting you about ownership of YouTube asset {assetId}, claim {claimId}, on video {videoUrl}.", {
                    assetId: claim.asset_id,
                    claimId: claim.claim_id,
                    videoUrl: `https://www.youtube.com/watch?v=${videoId}`
                  });
                  return (
                    <div key={contact.owner_id} className="rounded-xl bg-slate-50 px-3 py-2 text-sm">
                      <p className="font-bold text-slate-800">{contact.name || contact.owner_id}</p>
                      {contact.email ? (
                        <div className="flex flex-wrap items-center gap-x-2">
                          <a
                            className="inline-flex items-center gap-1 break-all text-blue-700 underline"
                            href={`mailto:${encodeURIComponent(contact.email).replace("%40", "@")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`}
                            title={t("Compose ownership email")}
                          >
                            <Mail className="shrink-0" size={14} aria-hidden="true" />
                            {contact.email}
                          </a>
                          <CopyButton text={contact.email} label={t("Copy email")} iconOnly />
                        </div>
                      ) : <p className="text-slate-600">{contact.contact_error ? tm(contact.contact_error) : t("YouTube did not provide a contact email.")}</p>}
                    </div>
                  );
                })}
              </div>
              <div className="flex flex-wrap gap-2">
                <LinkButton href={claim.ownership_url} size="sm">{t("Ownership and Policy")}</LinkButton>
                {claim.studio_url && <LinkButton href={claim.studio_url} size="sm">{t("Open claim in Studio")}</LinkButton>}
              </div>
            </article>
          ))}
        </div>
      )}
    </Modal>
  );
}
