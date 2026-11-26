// Hooks of the signing feature (kept out of the component files: those export components only).
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useI18n } from "../../../context/I18nContext";
import { pristineSourceId } from "../model/selectors.js";
import { useDocument, useEditor, useFeatureState } from "../ui/editorHooks.js";
import { renderStamp } from "./certSignFlow.js";
import { getIdentity, subscribeIdentity } from "./identity.js";
import { FEATURE_ID, getSignatureShelf, getTrustList, scheduleInspection, signedEntries } from "./state.js";
import { summarize } from "./verdict.js";

/** The bag of the signing feature: { reports, flow, flash } (state.js). */
export function useSigningBag() {
  const [bag] = useFeatureState(FEATURE_ID);
  return bag || null;
}

/** The certificate signing flow of the drawer, or null. */
export const useSignFlow = () => useSigningBag()?.flow || null;

/** What the interface may know about the signing identity of this tab (identity.js getIdentity), or null. */
export const useIdentity = () => useSyncExternalStore(subscribeIdentity, getIdentity);

/** The saved signature pictures of this device, newest first. */
export function useSavedSignatures() {
  const shelf = getSignatureShelf();
  return useSyncExternalStore(shelf.subscribe, shelf.list);
}

/** The certificates the user trusts on this device. */
export function useTrustedCertificates() {
  const list = getTrustList();
  return useSyncExternalStore(list.subscribe, list.list);
}

/**
 * The signatures of the working document: { entries, summary (verdict.js summarize), edited }.
 * edited: the document is no longer the signed file itself, so a downloaded copy will not carry the signatures.
 */
export function useSignatures() {
  const editor = useEditor();
  const pages = useDocument((state) => state.pages);
  const sources = useDocument((state) => state.sources);
  // an added object makes the document "edited" without touching the list of pages
  const objects = useDocument((state) => state.objects);
  const reports = useSigningBag()?.reports;
  const result = useMemo(() => {
    const entries = signedEntries({ pages, sources }, reports);
    return { entries, summary: summarize(entries), edited: entries.length > 0 && pristineSourceId({ pages, sources, objects }) === null };
  }, [pages, sources, objects, reports]);
  // a signed file whose pages came into the document another way (pages inserted from a PDF) is inspected too
  const { entries } = result;
  useEffect(() => {
    for (const entry of entries) if (!reports?.[entry.sourceId]) scheduleInspection(editor, entry.sourceId);
  }, [editor, entries, reports]);
  return result;
}

/**
 * The stamp of the open signing flow as a picture for a rectangle of `width` x `height` points:
 * { url (PNG data URL), empty, clipped } or null while it is painted. It follows every setting of the flow,
 * the identity and the language; the last picture stays on screen until the next one is ready.
 */
export function useStampPreview(width, height, enabled = true) {
  const editor = useEditor();
  const { language } = useI18n();
  const flow = useSignFlow();
  const identity = useIdentity();
  const [preview, setPreview] = useState(null);
  const w = Math.max(1, Math.round(width || 0));
  const h = Math.max(1, Math.round(height || 0));
  const settings = flow && enabled ? JSON.stringify([flow.visible, flow.layout, flow.show, flow.reason, flow.location, flow.pictureVersion, identity?.facts?.fingerprintSha256 || "", language, w, h]) : "";
  useEffect(() => {
    if (!settings) return undefined;
    let live = true;
    renderStamp(editor, { width: w, height: h })
      .then((stamp) => {
        if (live) setPreview({ url: stamp.dataUrl, empty: stamp.empty, clipped: stamp.clipped });
      })
      .catch(() => {
        if (live) setPreview(null);
      });
    return () => {
      live = false;
    };
  }, [editor, settings, w, h]);
  return settings ? preview : null;
}
