// Reads the duration of a media file in the browser (metadata only, nothing is uploaded) so
// clips that Content ID cannot fingerprint are refused before any bytes leave the machine.
// The backend re-checks MP4/MOV files, so this is the fast, user-facing gate.
import { t } from "../../i18n/index.js";

export const MIN_VIDEO_REFERENCE_SECONDS = 20;
const PROBE_TIMEOUT_MS = 15000;

/** Duration in seconds, or null when the browser cannot read the container (e.g. MKV, AVI). */
export function probeMediaDuration(file, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    if (typeof document === "undefined" || !file || typeof URL?.createObjectURL !== "function") {
      resolve(null);
      return;
    }
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.onloadedmetadata = null;
      video.ondurationchange = null;
      video.onerror = null;
      video.removeAttribute("src");
      try {
        video.load();
      } catch {
        // detaching the source is best effort
      }
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(value) && value > 0 ? value : null);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    video.onloadedmetadata = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        finish(video.duration);
        return;
      }
      // Streams without an index (some WebM/MKV) report Infinity until the end is sought.
      if (video.duration === Infinity) {
        video.ondurationchange = () => {
          if (Number.isFinite(video.duration) && video.duration > 0) finish(video.duration);
        };
        try {
          video.currentTime = 1e101;
        } catch {
          finish(null);
        }
        return;
      }
      finish(null);
    };
    video.onerror = () => finish(null);
    video.src = url;
  });
}

// Rendered in the current language (t): components showing it must use useI18n().
export function formatSeconds(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return t("unknown length");
  if (value < 60) return t("{seconds} s", { seconds: value < 10 ? value.toFixed(1) : Math.round(value) });
  const minutes = Math.floor(value / 60);
  const rest = Math.round(value % 60);
  return t("{minutes} min {seconds} s", { minutes, seconds: rest });
}

/**
 * Splits files into those long enough for a video reference and those that are too short.
 * Files whose duration cannot be read are accepted (the server checks MP4/MOV again).
 * → { accepted: File[], rejected: [{ file, duration }] }
 */
export async function splitByReferenceLength(files, minSeconds = MIN_VIDEO_REFERENCE_SECONDS) {
  const probed = await Promise.all((files || []).map(async (file) => ({ file, duration: await probeMediaDuration(file) })));
  const accepted = [];
  const rejected = [];
  probed.forEach((item) => {
    if (item.duration !== null && item.duration < minSeconds) rejected.push(item);
    else accepted.push(item.file);
  });
  return { accepted, rejected };
}
