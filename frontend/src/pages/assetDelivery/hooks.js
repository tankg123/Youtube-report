import { useCallback, useEffect, useRef, useState } from "react";
import { readLocalStorage, writeLocalStorage } from "./utils";

const TOAST_TONE_ALIASES = {
  green: "success",
  ok: "success",
  red: "error",
  danger: "error",
  amber: "warning",
  warn: "warning",
  blue: "info",
  slate: "dark",
  default: "dark"
};

/**
 * Toast state with auto-hide. `showToast(message, tone = "dark", ttl = duration)` where tone is
 * one of dark | success | error | warning | info (aliases accepted) and `ttl` overrides the
 * auto-hide delay for a message that needs more time to be read.
 */
export function useToast(duration = 3500) {
  const [toast, setToast] = useState(null);
  const timerRef = useRef(null);

  const hideToast = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setToast(null);
  }, []);

  const showToast = useCallback(
    (message, tone = "dark", ttl = duration) => {
      const text = typeof message === "string" ? message : message?.message || String(message ?? "");
      if (!text) return;
      const resolvedTone = TOAST_TONE_ALIASES[tone] || tone || "dark";
      if (timerRef.current) clearTimeout(timerRef.current);
      setToast({ message: text, tone: resolvedTone, id: Date.now() });
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setToast(null);
      }, Number(ttl) > 0 ? Number(ttl) : duration);
    },
    [duration]
  );

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );

  return { toast, showToast, hideToast };
}

/** useState mirrored into localStorage (JSON). */
export function useLocalStorageState(key, initialValue) {
  const [value, setValue] = useState(() => readLocalStorage(key, initialValue));

  useEffect(() => {
    writeLocalStorage(key, value);
  }, [key, value]);

  return [value, setValue];
}

export function useDebouncedValue(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}

/** setInterval that always calls the latest callback; pass null delay to pause. */
export function useInterval(callback, delay) {
  const savedRef = useRef(callback);

  useEffect(() => {
    savedRef.current = callback;
  }, [callback]);

  useEffect(() => {
    if (delay === null || delay === undefined || delay === false) return undefined;
    const id = setInterval(() => {
      if (typeof savedRef.current === "function") savedRef.current();
    }, delay);
    return () => clearInterval(id);
  }, [delay]);
}

export function useDocumentVisible() {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");

  useEffect(() => {
    const handler = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, []);

  return visible;
}
