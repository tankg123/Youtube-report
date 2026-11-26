import { useEffect } from "react";

/**
 * Puts the keyboard on `ref` when a dialog opens (Cancel in a warning, the field in a form).
 * The shared Modal remembers who opened it in an effect of its own; moving the focus one microtask later
 * leaves that memory intact, so closing the dialog still gives the focus back to the opener.
 * `token`: focus again when it changes (a wrong password).
 */
export function useInitialFocus(ref, token) {
  useEffect(() => {
    let live = true;
    queueMicrotask(() => {
      if (live) ref.current?.focus({ preventScroll: true });
    });
    return () => {
      live = false;
    };
  }, [ref, token]);
}
