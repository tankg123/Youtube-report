import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { analyticsApi, analyticsError } from "../../api/analyticsApi";
import { AnalyticsContext } from "./analyticsContext";
import { ACTIVE_JOBS } from "./analyticsUtils";

const isCancelled = (error) => error?.code === "ERR_CANCELED" || error?.name === "CanceledError" || error?.name === "AbortError";

export function useAnalytics() {
  const context = useContext(AnalyticsContext);
  if (!context) throw new Error("useAnalytics must be used inside AnalyticsProvider");
  return context;
}

// useAbortableLoader(loader, { enabled, version }) runs loader(signal) whenever the memoised loader, `enabled` or
// `version` changes and aborts the request in flight; reload() re-runs it. A new loader (a new selection) clears
// the previous data, a reload or version bump keeps it on screen while loading. Errors are analyticsError() texts.
export function useAbortableLoader(loader, { enabled = true, version = 0 } = {}) {
  const [state, setState] = useState({ data: null, loading: Boolean(enabled), error: "" });
  const [reloadKey, setReloadKey] = useState(0);
  const lastLoaderRef = useRef(null);
  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    const selectionChanged = lastLoaderRef.current !== loader;
    lastLoaderRef.current = loader;
    const load = async () => {
      setState((previous) => ({ data: selectionChanged ? null : previous.data, loading: true, error: "" }));
      try {
        const data = await loader(controller.signal);
        if (!controller.signal.aborted) setState({ data, loading: false, error: "" });
      } catch (error) {
        if (controller.signal.aborted || isCancelled(error)) return;
        setState((previous) => ({ data: previous.data, loading: false, error: analyticsError(error) }));
      }
    };
    load();
    return () => controller.abort();
  }, [loader, enabled, version, reloadKey]);

  return { data: state.data, loading: enabled && state.loading, error: state.error, reload };
}

// Polls GET /jobs/:id every `interval` ms while the job is queued / running / cancelling. onUpdate(job) receives every
// answer, onFinish(job) the first terminal one; transient errors retry at a third of the pace, a vanished job stops.
export function useJobPolling(job, { interval = 2500, onUpdate, onFinish } = {}) {
  const jobId = job?.id ?? null;
  const active = Boolean(jobId) && ACTIVE_JOBS.includes(job?.status);
  const callbacksRef = useRef({ onUpdate, onFinish });

  useEffect(() => {
    callbacksRef.current = { onUpdate, onFinish };
  }, [onUpdate, onFinish]);

  useEffect(() => {
    if (!active) return undefined;
    const controller = new AbortController();
    let timer = null;
    const poll = async () => {
      try {
        const response = await analyticsApi.job(jobId, controller.signal);
        if (controller.signal.aborted || !response?.job) return;
        callbacksRef.current.onUpdate?.(response.job);
        if (ACTIVE_JOBS.includes(response.job.status)) timer = setTimeout(poll, interval);
        else callbacksRef.current.onFinish?.(response.job);
      } catch (error) {
        if (controller.signal.aborted || isCancelled(error)) return;
        const status = error?.response?.status;
        if (status === 404 || status === 403) return;
        timer = setTimeout(poll, interval * 3);
      }
    };
    timer = setTimeout(poll, interval);
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [jobId, active, interval]);
}
