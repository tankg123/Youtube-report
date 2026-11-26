// Where a visitor lands after signing in. Only the stand-alone tools listed here may be requested with
// /login?next=…; anything else (other pages, absolute or protocol-relative URLs, back-slashes, control
// characters) falls back to the default landing page, so the parameter can never be used as an open redirect.
//
// The value is NORMALISED before it is checked and the normalised form is what is returned: the URL parser
// resolves dot segments ("/pdf/../settings/system", also spelled "%2e%2e") exactly as the router would, so the
// allow-list is tested against the path the visitor would really land on.
const RETURNABLE_PREFIXES = Object.freeze(["/pdf"]);
const PARSE_BASE = "http://return.invalid";
const hasControlCharacter = (text) => [...text].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);

export function safeReturnPath(value) {
  const text = String(value ?? "");
  if (!text.startsWith("/") || text.startsWith("//") || text.includes("\\") || hasControlCharacter(text)) return "";
  let url;
  try {
    url = new URL(text, PARSE_BASE);
  } catch {
    return "";
  }
  if (url.origin !== PARSE_BASE) return "";
  const { pathname } = url;
  if (pathname.includes("//")) return "";
  if (!RETURNABLE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) return "";
  return `${pathname}${url.search}${url.hash}`;
}

// location.search of the login page → the validated path to return to ("" when there is none).
export function returnPathFromSearch(search) {
  try {
    return safeReturnPath(new URLSearchParams(search || "").get("next"));
  } catch {
    return "";
  }
}

// A stand-alone tool keeps its page when the session ends (token expiry, a 401 answer): the work it holds lives
// only in memory, so a redirect to /login would throw it away. The page tells the user itself (it reads
// useAuth().user) and stays mounted (StandaloneRoute in App.jsx).
export function keepsPageOnSessionEnd(pathname) {
  const path = typeof pathname === "string" ? pathname : "";
  return RETURNABLE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

// Sent on window by api.js when the server answers 401 on a page that stays: AuthContext then drops the user,
// which is what the page watches.
export const SESSION_ENDED_EVENT = "app:session-ended";

// The login URL for a visitor who was on `pathname`: plain "/login" unless the page is a returnable tool.
export function loginPathFor(pathname, search = "", hash = "") {
  const target = safeReturnPath(`${pathname || ""}${search || ""}${hash || ""}`);
  return target ? `/login?next=${encodeURIComponent(target)}` : "/login";
}
