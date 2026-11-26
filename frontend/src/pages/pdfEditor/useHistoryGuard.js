import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";

// The app uses a plain <BrowserRouter>: there is no useBlocker, and a Back / Forward press is a client-side
// route change that fires neither beforeunload nor any prompt. While `active` (unsaved work) this hook keeps a
// same-URL "guard" entry on top of the history stack:
//   [… , /pdf , /pdf (guard)]
// Back then pops the guard and lands on the plain /pdf entry: same route, so the editor stays mounted. The
// popstate listener notices that the guard is gone, pushes it again and calls onBackAttempt (the page opens
// its own "Leave the editor?" dialog). Leaving for real is the page's job: navigate("/home", { replace: true }).
// Not covered: a jump of several entries (long-press on Back, history.go(-2)) to another route.
export const HISTORY_GUARD_KEY = "pdfxGuard";

const isGuardEntry = () => Boolean(window.history.state?.usr?.[HISTORY_GUARD_KEY]);

export function useHistoryGuard(active, onBackAttempt) {
  const navigate = useNavigate();
  const location = useLocation();
  const latest = useRef({ navigate, location, onBackAttempt });

  useEffect(() => {
    latest.current = { navigate, location, onBackAttempt };
  });

  useEffect(() => {
    if (!active) return undefined;
    const pushGuard = () => {
      const { navigate: go, location: here } = latest.current;
      go({ pathname: here.pathname, search: here.search, hash: here.hash }, { state: { ...(here.state || {}), [HISTORY_GUARD_KEY]: true } });
    };
    // React Router writes history.state synchronously, so the second effect run of StrictMode sees the guard.
    if (!isGuardEntry()) pushGuard();
    const onPopState = () => {
      if (isGuardEntry()) return; // Forward onto the guard entry, or a pop between two guard entries
      if (window.location.pathname !== latest.current.location.pathname) return; // already on another route
      pushGuard();
      latest.current.onBackAttempt?.();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [active]);
}
