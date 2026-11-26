// The registry of the bundled fonts (browser): one fetch per face, the SAME bytes for the screen and for the
// PDF. A face is fetched when it is first needed, checked against the manifest, registered as a FontFace
// built from that very ArrayBuffer under the prefixed family ("PDF Arimo": an installed font can never win),
// and its bytes are what the export engines embed.
//
// The registry is the only authority on "is this face loaded": document.fonts.check() answers true for a
// family that does not exist, so nothing in the editor asks it.
import { PdfEditorError } from "../engine/errors.js";
import { findFont } from "./fontSupport.js";
import { cssFaceOf } from "./textStyle.js";

const FONT_DIRECTORY = "pdf-fonts/";
const MANIFEST_FILE = "manifest.json";
/** After a failed download the same file is not asked for again before this many milliseconds have passed. */
export const RETRY_AFTER_MS = 3000;

const toHex = (buffer) => Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * @param {object} options
 * @param {string} options.baseUrl  where the app is served from, with or without the final slash
 *        (import.meta.env.BASE_URL); fonts are read from `${baseUrl}pdf-fonts/<file>`
 * @param {Function} [options.fetch]  replaces window.fetch (tests)
 * The remaining options exist for tests outside a browser: `FontFace` (constructor), `fontSet` (an object
 * with add / delete, default document.fonts), `subtle` (SubtleCrypto, null = skip the hash check) and `now`
 * (a clock in milliseconds).
 *
 * @returns {{
 *   loadManifest(): Promise<object>,
 *   ensureFont(fontKey: string): Promise<{ fontKey: string, cssFamily: string, bytes: Uint8Array }>,
 *   ensureFonts(fontKeys: string[]): Promise<object[]>,
 *   getFontBytes(fontKey: string): Promise<Uint8Array>,
 *   isLoaded(fontKey: string): boolean,
 *   faceOf(fontKey: string): { fontFamily: string, fontWeight: number, fontStyle: string } | null,
 *   subscribe(listener: Function): Function,
 *   getVersion(): number,
 *   manifest: object | null,
 *   dispose(): void
 * }}
 */
export function createFontRegistry({ baseUrl = "/", fetch: fetchOption, FontFace: FaceOption, fontSet: fontSetOption, subtle: subtleOption, now = () => Date.now() } = {}) {
  const base = String(baseUrl || "/").endsWith("/") ? String(baseUrl || "/") : `${baseUrl}/`;
  const fetchFn = fetchOption || ((...args) => globalThis.fetch(...args));
  const FaceConstructor = FaceOption || globalThis.FontFace;
  const fontSet = fontSetOption || globalThis.document?.fonts;
  const subtle = subtleOption === undefined ? globalThis.crypto?.subtle : subtleOption;

  let manifest = null;
  let manifestPromise = null;
  let version = 0;
  let disposed = false;
  const pending = new Map(); // fontKey -> Promise of the public record
  const loaded = new Map(); // fontKey -> { record, face }
  const failures = new Map(); // fontKey (or MANIFEST_FILE) -> { error, at }: what failed a moment ago
  const listeners = new Set();

  // A box that renders, or a field that is typed in, asks for its fonts again and again: while a download
  // keeps failing (offline, a missing file) that must not become a request per keystroke.
  const recentFailure = (key) => {
    const failure = failures.get(key);
    if (!failure) return null;
    if (now() - failure.at < RETRY_AFTER_MS) return failure.error;
    failures.delete(key);
    return null;
  };

  const notify = (fontKey) => {
    version += 1;
    for (const listener of [...listeners]) {
      try {
        listener(fontKey);
      } catch {
        // a listener must not break font loading for the others
      }
    }
  };

  async function fetchBytes(url, failure) {
    let response;
    try {
      response = await fetchFn(url);
    } catch (cause) {
      throw failure(0, cause);
    }
    if (!response || !response.ok) throw failure(response?.status || 0);
    try {
      return await response.arrayBuffer();
    } catch (cause) {
      throw failure(response.status || 0, cause);
    }
  }

  function loadManifest() {
    if (manifest) return Promise.resolve(manifest);
    if (!manifestPromise) {
      const recent = recentFailure(MANIFEST_FILE);
      if (recent) return Promise.reject(recent);
      const failure = (status, cause) => new PdfEditorError("TEXT_FONT_MANIFEST_FAILED", { status }, { cause });
      manifestPromise = (async () => {
        const buffer = await fetchBytes(`${base}${FONT_DIRECTORY}${MANIFEST_FILE}`, failure);
        let parsed;
        try {
          parsed = JSON.parse(new TextDecoder().decode(buffer));
        } catch (cause) {
          throw failure(200, cause);
        }
        // an SPA fallback answers 200 with index.html for a missing file: insist on the real thing
        if (!parsed || !Array.isArray(parsed.fonts) || parsed.fonts.some((font) => !font || typeof font.id !== "string" || typeof font.file !== "string")) throw failure(200);
        manifest = parsed;
        return parsed;
      })();
      manifestPromise.catch((error) => {
        manifestPromise = null; // a later call tries again
        failures.set(MANIFEST_FILE, { error, at: now() });
      });
    }
    return manifestPromise;
  }

  async function load(fontKey) {
    const list = await loadManifest();
    const entry = findFont(list, fontKey);
    if (!entry) throw new PdfEditorError("TEXT_FONT_UNKNOWN", { font: String(fontKey) });
    const buffer = await fetchBytes(`${base}${FONT_DIRECTORY}${entry.file}`, (status, cause) => new PdfEditorError("TEXT_FONT_FETCH_FAILED", { font: fontKey, status }, { cause }));
    if (Number.isFinite(entry.bytes) && buffer.byteLength !== entry.bytes) {
      throw new PdfEditorError("TEXT_FONT_CORRUPT", { font: fontKey }, { detail: `${buffer.byteLength} bytes, the manifest says ${entry.bytes}` });
    }
    // WebCrypto exists only in secure contexts: without it the size check above is all there is
    if (subtle && entry.sha256) {
      const digest = toHex(await subtle.digest("SHA-256", buffer));
      if (digest !== String(entry.sha256).toLowerCase()) throw new PdfEditorError("TEXT_FONT_CORRUPT", { font: fontKey }, { detail: "SHA-256 differs from the manifest" });
    }
    const face = new FaceConstructor(entry.cssFamily, buffer, { weight: String(entry.weight), style: entry.italic ? "italic" : "normal" });
    try {
      await face.load();
    } catch (cause) {
      // a browser reports bytes it cannot use as a font with a SyntaxError
      throw new PdfEditorError("TEXT_FONT_CORRUPT", { font: fontKey }, { cause, detail: "the browser refused the font" });
    }
    const record = Object.freeze({ fontKey: entry.id, cssFamily: entry.cssFamily, bytes: new Uint8Array(buffer) });
    if (disposed) return record;
    fontSet.add(face);
    loaded.set(entry.id, { record, face });
    notify(entry.id);
    return record;
  }

  /**
   * Fetches, checks and registers one face (once; concurrent and later calls share the result). A failure is
   * remembered for RETRY_AFTER_MS only (calls in that time are rejected with the same error, without a new
   * request): the first call after that tries again. `bytes` is the registry's own copy: read it, never
   * transfer or change it (getFontBytes hands out copies).
   */
  function ensureFont(fontKey) {
    const done = loaded.get(fontKey);
    if (done) return Promise.resolve(done.record);
    let promise = pending.get(fontKey);
    if (!promise) {
      const recent = recentFailure(fontKey);
      if (recent) return Promise.reject(recent);
      promise = load(fontKey);
      pending.set(fontKey, promise);
      promise.then(
        () => {
          if (pending.get(fontKey) === promise) pending.delete(fontKey);
        },
        (error) => {
          if (pending.get(fontKey) === promise) pending.delete(fontKey);
          failures.set(fontKey, { error, at: now() });
        }
      );
    }
    return promise;
  }

  return {
    loadManifest,
    ensureFont,
    ensureFonts: (fontKeys) => Promise.all([...new Set(fontKeys)].map((fontKey) => ensureFont(fontKey))),
    /** The `fonts` callback of the export engines: a private copy of the face's bytes. */
    getFontBytes: async (fontKey) => (await ensureFont(fontKey)).bytes.slice(),
    /** True once the face is registered: only then may text in it be measured or drawn. */
    isLoaded: (fontKey) => loaded.has(fontKey),
    /** The CSS face of a font key (also before anything is loaded); null for an unknown key. */
    faceOf(fontKey) {
      const entry = manifest ? findFont(manifest, fontKey) : null;
      if (entry) return { fontFamily: entry.cssFamily, fontWeight: entry.weight, fontStyle: entry.italic ? "italic" : "normal" };
      const face = cssFaceOf(fontKey);
      return face ? { fontFamily: face.fontFamily, fontWeight: face.fontWeight, fontStyle: face.fontStyle } : null;
    },
    /** `listener(fontKey)` runs every time a face has finished loading. Returns the unsubscribe function. */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** A number that grows with every loaded face (the snapshot for useSyncExternalStore). */
    getVersion: () => version,
    /** The manifest once loadManifest() has resolved, null before. */
    get manifest() {
      return manifest;
    },
    /** Takes the registry's faces out of the document again (a second registry may hold the same families). */
    dispose() {
      disposed = true;
      for (const { face } of loaded.values()) fontSet.delete(face);
      loaded.clear();
      pending.clear();
      failures.clear();
      listeners.clear();
    }
  };
}

const shared = new Map(); // base URL -> registry

/**
 * The registry of a page, one per base URL and never disposed: the editor's shell asks for it every time the
 * /pdf route mounts (also twice under React.StrictMode) and always gets the same faces, already loaded.
 */
export function sharedFontRegistry(baseUrl = "/") {
  const key = String(baseUrl || "/");
  if (!shared.has(key)) shared.set(key, createFontRegistry({ baseUrl: key }));
  return shared.get(key);
}
