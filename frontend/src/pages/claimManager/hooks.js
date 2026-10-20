import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { confirmClaims, listClaimAccounts, recheckClaims, reinstateClaims, releaseClaims, searchClaims } from "../../api/contentIdClaimsApi";
import { t, tk } from "../../i18n/index.js";
import { DEFAULT_LIMITS, MAX_RECHECK_ITEMS, RELEASE_BATCH_SIZE, RELEASE_UNKNOWN_STATUS } from "./constants";
import {
  activateActionOf,
  activateBatches,
  activateBlockReason,
  batchFailureMessage,
  buildReleaseItems,
  claimKey,
  httpStatus,
  isCanceled,
  isRetryableStatus,
  isUnknownOutcomeError,
  mergeResultsByKey,
  normalizeStatus,
  outcomesForBatch,
  recheckToOutcome,
  reconcileBatchResults,
  requestMessage,
  retryAfterSeconds,
  statusLabel,
  unknownOutcomeMessage
} from "./utils";

const EMPTY_USER = { limited: false, allowed_labels: [] };

/** GET /content-id/claims/accounts with reload; `loading` is derived from a tick so no state is set synchronously in the effect. */
export function useClaimAccounts() {
  const [tick, setTick] = useState(0);
  const [state, setState] = useState({ tick: -1, accounts: [], limits: DEFAULT_LIMITS, user: EMPTY_USER, error: "" });

  useEffect(() => {
    let active = true;
    listClaimAccounts()
      .then((data) => {
        if (!active) return;
        setState({
          tick,
          accounts: Array.isArray(data?.accounts) ? data.accounts : [],
          limits: { ...DEFAULT_LIMITS, ...(data?.limits || {}) },
          user: {
            limited: Boolean(data?.user?.limited),
            allowed_labels: Array.isArray(data?.user?.allowed_labels) ? data.user.allowed_labels : []
          },
          error: ""
        });
      })
      .catch((error) => {
        if (!active) return;
        setState((current) => ({ ...current, tick, error: requestMessage(error) }));
      });
    return () => {
      active = false;
    };
  }, [tick]);

  const reload = useCallback(() => setTick((current) => current + 1), []);

  return {
    accounts: state.accounts,
    limits: state.limits,
    user: state.user,
    error: state.error,
    loading: state.tick !== tick,
    loaded: state.tick >= 0,
    reload
  };
}

const INITIAL_SEARCH = { status: "idle", error: "", result: null, claims: [], tokens: [], token: "" };

/**
 * Claim search with cancellation (AbortController) and explore paging.
 * `run(payload)` starts a new search; `nextPage()` / `previousPage()` reuse the last payload
 * with the page tokens; `updateClaims(fn)` edits the rows in place after a release.
 */
export function useClaimSearch() {
  const [state, setState] = useState(INITIAL_SEARCH);
  const controllerRef = useRef(null);
  const payloadRef = useRef(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const execute = useCallback(async (payload, tokens, token, keepResult) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState((current) => ({
      ...current,
      status: "loading",
      error: "",
      result: keepResult ? current.result : null,
      claims: keepResult ? current.claims : []
    }));
    try {
      const body = token ? { ...payload, page_token: token } : payload;
      const data = await searchClaims(body, { signal: controller.signal });
      if (controller.signal.aborted) return null;
      controllerRef.current = null;
      setState({ status: "done", error: "", result: data, claims: Array.isArray(data?.claims) ? data.claims : [], tokens, token });
      return data;
    } catch (error) {
      if (isCanceled(error) || controller.signal.aborted) return null;
      controllerRef.current = null;
      setState((current) => ({ ...current, status: "error", error: requestMessage(error) }));
      return null;
    }
  }, []);

  const run = useCallback(
    (payload) => {
      payloadRef.current = payload;
      return execute(payload, [], "", false);
    },
    [execute]
  );

  const nextPage = useCallback(() => {
    const token = state.result?.page?.next_page_token;
    if (!token || !payloadRef.current) return Promise.resolve(null);
    return execute(payloadRef.current, [...state.tokens, state.token], token, true);
  }, [execute, state.result, state.tokens, state.token]);

  const previousPage = useCallback(() => {
    if (!payloadRef.current) return Promise.resolve(null);
    if (state.tokens.length) {
      const tokens = state.tokens.slice(0, -1);
      return execute(payloadRef.current, tokens, state.tokens[state.tokens.length - 1], true);
    }
    const token = state.result?.page?.previous_page_token;
    if (!token) return Promise.resolve(null);
    return execute(payloadRef.current, [], token, true);
  }, [execute, state.result, state.tokens]);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setState((current) => (current.status === "loading" ? { ...current, status: current.result ? "done" : "idle" } : current));
  }, []);

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    payloadRef.current = null;
    setState(INITIAL_SEARCH);
  }, []);

  const updateClaims = useCallback((updater) => {
    setState((current) => ({ ...current, claims: updater(current.claims) }));
  }, []);

  return {
    status: state.status,
    loading: state.status === "loading",
    error: state.error,
    result: state.result,
    claims: state.claims,
    hasNext: Boolean(state.result?.page?.next_page_token),
    hasPrevious: state.tokens.length > 0 || Boolean(state.result?.page?.previous_page_token),
    pageIndex: state.tokens.length + 1,
    run,
    nextPage,
    previousPage,
    cancel,
    reset,
    updateClaims
  };
}

/** Set of selected claim keys with immutable updates. */
export function useSelection() {
  const [selected, setSelected] = useState(() => new Set());

  const toggle = useCallback((key) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const add = useCallback((keys) => {
    setSelected((current) => {
      const next = new Set(current);
      keys.forEach((key) => next.add(key));
      return next;
    });
  }, []);

  const remove = useCallback((keys) => {
    setSelected((current) => {
      if (!keys.some((key) => current.has(key))) return current;
      const next = new Set(current);
      keys.forEach((key) => next.delete(key));
      return next;
    });
  }, []);

  const replace = useCallback((keys) => setSelected(new Set(keys)), []);
  const clear = useCallback(() => setSelected((current) => (current.size ? new Set() : current)), []);

  return { selected, toggle, add, remove, replace, clear, count: selected.size };
}

/** Ctrl/Cmd+Enter anywhere on the page runs `handler` while `enabled`. */
export function useSearchShortcut(enabled, handler) {
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    if (!enabled) return undefined;
    const listener = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        handlerRef.current?.();
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [enabled]);
}

/** Claims per release request: RELEASE_BATCH_SIZE, never more than the server's max_release_items. */
function releaseBatchSize(limits) {
  return Math.max(1, Math.min(RELEASE_BATCH_SIZE, Number(limits?.max_release_items) || RELEASE_BATCH_SIZE));
}

// The request behind each write; a batch names its write, so a run never mixes endpoints.
const WRITE_SENDERS = { release: releaseClaims, reinstate: reinstateClaims, confirm: confirmClaims };

/** Tag every outcome with the write that was sent for its claim (the table and a re-check read it). */
function tagOutcomes(outcomes, action) {
  return outcomes.map((outcome) => ({ ...outcome, action }));
}

/** The write a row would need to become active, for rows no write can take right now (status moved on). */
function inferredActivateAction(claim) {
  return normalizeStatus(claim?.status) === "potential" ? "confirm" : "reinstate";
}

/**
 * The batches of a run. A release sends `targets` in order, chunked by `batchSize`; an activate run
 * splits them into reinstate (inactive) and confirm (potential) batches (activateBatches). A target
 * neither write can take any more is listed in `dropped`: it gets a "skipped" result without a
 * request, so every claim of the run has an outcome.
 */
function planBatches(action, targets, batchSize) {
  if (action === "activate") {
    const batches = activateBatches(targets, batchSize);
    const planned = new Set(batches.flatMap((batch) => batch.claims.map((claim) => claimKey(claim))));
    return { batches, dropped: targets.filter((claim) => !planned.has(claimKey(claim))) };
  }
  const batches = [];
  for (let index = 0; index < targets.length; index += batchSize) {
    batches.push({ action: "release", claims: targets.slice(index, index + batchSize) });
  }
  return { batches, dropped: [] };
}

/**
 * Status-write runner used by ReleaseDialog. `action` is "release" (every batch goes to /release)
 * or "activate" (reinstate batches for the released claims, confirm batches for the potential ones;
 * see activateBatches). Sequential batches of `batchSize`, results kept per claim key (a retry
 * replaces the previous outcome); every outcome carries `action`, the write that was sent for that
 * claim ("release" | "reinstate" | "confirm"). A request error marks the batch "failed" (retryable
 * for 429 / 502 / 503) and stops the run; a request that got no answer (client timeout, dropped
 * connection, 504, cancel) marks the batch "unknown" and also stops the run, so no further 300 s
 * batch is pushed into an outage. Claims that were never sent stay in `run.unsent` until a later
 * run (`retry` / `retryUnsent`) sends them.
 * `onResults(outcomes)` is called after every batch so the table updates in place;
 * `recheck(keys)` reads the current status back in chunks of MAX_RECHECK_ITEMS and maps each
 * answer against the write that was sent for that claim.
 */
export function useWriteRun({ action = "release", claims, limits, note, onResults, onRecheckResults }) {
  const [run, setRun] = useState(null);
  const [busyKeys, setBusyKeys] = useState(() => new Set());
  const controllerRef = useRef(null);
  // Mirror of run.unsent: a retry computes the carried-over list from it instead of a stale closure.
  const unsentRef = useRef([]);
  // claim key → the write sent for it, so a re-check reads the status back against the right write.
  const actionsRef = useRef(new Map());
  const batchSize = useMemo(() => releaseBatchSize(limits), [limits]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const markBusy = useCallback((keys, busy) => {
    setBusyKeys((current) => {
      const next = new Set(current);
      keys.forEach((key) => (busy ? next.add(key) : next.delete(key)));
      return next;
    });
  }, []);

  // kind: "run" (first send of the whole selection), "retry" (retryable failures), "unsent" (claims a stopped run never sent).
  const execute = useCallback(
    async (targets, { kind = "retry" } = {}) => {
      const initial = kind === "run";
      if (!targets.length) return { outcomes: [], unsent: unsentRef.current };
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      const keys = targets.map((claim) => claimKey(claim));
      const keySet = new Set(keys);
      // The claims this run sends leave the unsent list; the others stay listed until they are sent.
      const carried = initial ? [] : unsentRef.current.filter((key) => !keySet.has(key));
      unsentRef.current = carried;
      if (initial) actionsRef.current = new Map();
      const { batches: plan, dropped } = planBatches(action, targets, batchSize);
      markBusy(keys, true);
      setRun((current) => ({
        ...(initial || !current ? { results: [] } : current),
        phase: "running",
        kind,
        retrying: !initial,
        error: "",
        recheckError: "",
        unsent: carried,
        batch: 0,
        batches: plan.length,
        sent: 0,
        total: targets.length
      }));

      let error = "";
      let processed = 0;
      let attempted = 0;
      let stop = false;
      let noAnswer = false;
      let cancelled = false;
      const all = [];
      const report = (outcomes) => {
        processed += outcomes.length;
        all.push(...outcomes);
        onResults?.(outcomes);
        setRun((current) => (current ? { ...current, sent: processed, results: mergeResultsByKey(current.results || [], outcomes) } : current));
      };
      if (dropped.length) {
        // Rows the status moved on from since the dialog opened: nothing to send, say why per claim.
        report(
          dropped.map((claim) => {
            const write = inferredActivateAction(claim);
            actionsRef.current.set(claimKey(claim), write);
            return { ...outcomesForBatch([claim], "skipped", activateBlockReason(claim) || tk("This claim can no longer be activated."))[0], action: write };
          })
        );
      }
      for (const batch of plan) {
        if (stop) break;
        attempted += 1;
        setRun((current) => (current ? { ...current, batch: attempted } : current));
        batch.claims.forEach((claim) => actionsRef.current.set(claimKey(claim), batch.action));
        let outcomes;
        try {
          const data = await WRITE_SENDERS[batch.action](buildReleaseItems(batch.claims), note, { signal: controller.signal });
          outcomes = reconcileBatchResults(batch.claims, data?.results);
        } catch (requestError) {
          if (isUnknownOutcomeError(requestError)) {
            outcomes = outcomesForBatch(batch.claims, "unknown", unknownOutcomeMessage(requestError, { action: batch.action }));
            // Google (or the server) never answered: stop instead of queueing more batches behind an
            // outage. The operator re-checks these claims, then sends the unsent ones.
            stop = true;
            cancelled = isCanceled(requestError);
            noAnswer = !cancelled;
          } else {
            // Per claim without the 429 wait (the dialog renders " Retry after N s." from retry_after);
            // the run banner has no such field, so it keeps the full hint.
            outcomes = outcomesForBatch(batch.claims, "failed", batchFailureMessage(requestError), {
              retryable: isRetryableStatus(requestError),
              retry_after: retryAfterSeconds(requestError) || null
            });
            error = requestMessage(requestError);
            stop = true;
          }
        }
        report(tagOutcomes(outcomes, batch.action));
        if (controller.signal.aborted) stop = true;
      }

      // The batches a stopped run never attempted (in plan order: for an activate run the reinstate
      // batches come before the confirm batches).
      const remaining = plan.slice(attempted).flatMap((batch) => batch.claims.map((claim) => claimKey(claim)));
      if (!error && remaining.length && (cancelled || noAnswer)) {
        const params = { count: remaining.length, label: t(statusLabel(RELEASE_UNKNOWN_STATUS)) };
        const one = remaining.length === 1;
        // A client abort does not stop the server: the batch that was in flight is still being written there.
        if (cancelled) {
          error = one
            ? t("Cancelled: {count} claim was not sent. The server finishes the calls already in flight; re-check the claims marked \"{label}\" in about a minute, then send the unsent claims.", params)
            : t("Cancelled: {count} claims were not sent. The server finishes the calls already in flight; re-check the claims marked \"{label}\" in about a minute, then send the unsent claims.", params);
        } else {
          error = one
            ? t("The last batch got no answer, so the remaining {count} claim was not sent. Re-check the claims marked \"{label}\", then send the unsent claims.", params)
            : t("The last batch got no answer, so the remaining {count} claims were not sent. Re-check the claims marked \"{label}\", then send the unsent claims.", params);
        }
      }
      const unsent = [...carried, ...remaining];
      unsentRef.current = unsent;
      markBusy(keys, false);
      setRun((current) => ({ ...current, phase: "done", error, unsent, retrying: false }));
      if (controllerRef.current === controller) controllerRef.current = null;
      return { outcomes: all, unsent };
    },
    [action, batchSize, note, onResults, markBusy]
  );

  const start = useCallback(() => execute(claims, { kind: "run" }), [execute, claims]);

  const retry = useCallback(
    (keys) => {
      const wanted = new Set(keys);
      return execute(claims.filter((claim) => wanted.has(claimKey(claim))), { kind: "retry" });
    },
    [execute, claims]
  );

  /** Send the claims a stopped run never sent (they are still listed in run.unsent). */
  const retryUnsent = useCallback(() => {
    const wanted = new Set(unsentRef.current);
    return execute(claims.filter((claim) => wanted.has(claimKey(claim))), { kind: "unsent" });
  }, [execute, claims]);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  const recheck = useCallback(
    async (keys) => {
      const wanted = new Set(keys);
      const targets = claims.filter((claim) => wanted.has(claimKey(claim)));
      if (!targets.length) return;
      const targetKeys = targets.map((claim) => claimKey(claim));
      const byKey = new Map(targets.map((claim) => [claimKey(claim), claim]));
      markBusy(targetKeys, true);
      const raw = [];
      let error = "";
      try {
        // The endpoint accepts at most MAX_RECHECK_ITEMS claims per call; the first failed chunk
        // ends the read (a 424 / 429 would only repeat), the chunks already read are kept.
        for (let index = 0; index < targets.length; index += MAX_RECHECK_ITEMS) {
          const chunk = targets.slice(index, index + MAX_RECHECK_ITEMS);
          try {
            const data = await recheckClaims(chunk.map((claim) => ({ network_id: claim.network_id, claim_id: claim.claim_id })));
            if (Array.isArray(data?.results)) raw.push(...data.results);
          } catch (requestError) {
            const left = targets.length - index;
            error = requestMessage(requestError);
            if (left < targets.length) error = `${error} ${t("{left} of the {total} claims were not re-checked.", { left, total: targets.length })}`;
            break;
          }
        }
      } finally {
        markBusy(targetKeys, false);
      }
      // Each answer is read against the write that was sent for that claim; a claim this run never
      // sent falls back to the write its row would take (activate) or to the release.
      const writeOf = (item) => {
        const key = item?.key || claimKey(item?.network_id, item?.claim_id);
        return actionsRef.current.get(key) || (action === "activate" && activateActionOf(byKey.get(key))) || "release";
      };
      const outcomes = raw.map((item) => recheckToOutcome(item, { action: writeOf(item) }));
      setRun((current) => (current ? { ...current, results: mergeResultsByKey(current.results, outcomes), recheckError: error } : current));
      if (raw.length) onRecheckResults?.(raw);
    },
    [action, claims, markBusy, onRecheckResults]
  );

  return { run, busyKeys, running: run?.phase === "running", batchSize, start, retry, retryUnsent, recheck, cancel };
}

/** Release-only runner (the original name): useWriteRun with `action: "release"`. */
export function useReleaseRun(options) {
  return useWriteRun({ ...options, action: "release" });
}

/**
 * Single-claim activate used by the page's confirm dialog: `activate(claim, action, note)` with
 * `action` "reinstate" (POST /content-id/claims/reinstate, inactive → active) or "confirm" (POST
 * /content-id/claims/confirm, potential → active). It marks the claim busy, reports the outcome
 * through `onResults(outcomes)` (one result tagged with `action`, reconciled so a missing server
 * result reads as "unknown") and resolves with `{ outcome, message, result }`. A request that got no
 * answer (timeout, dropped connection, 504) is an "unknown" outcome, never a failure; any other
 * request error is rethrown with the operator message (requestMessage) so the caller can toast it.
 */
export function useActivateClaim({ onResults } = {}) {
  const [busyKeys, setBusyKeys] = useState(() => new Set());

  const activate = useCallback(
    async (claim, action = "reinstate", note = "") => {
      const write = action === "confirm" ? "confirm" : "reinstate";
      const key = claimKey(claim);
      setBusyKeys((current) => new Set(current).add(key));
      try {
        let outcomes;
        try {
          const data = await WRITE_SENDERS[write](buildReleaseItems([claim]), note);
          outcomes = reconcileBatchResults([claim], data?.results);
        } catch (requestError) {
          if (!isUnknownOutcomeError(requestError)) {
            const error = new Error(requestMessage(requestError));
            error.cause = requestError;
            error.status = httpStatus(requestError);
            throw error;
          }
          outcomes = outcomesForBatch([claim], "unknown", unknownOutcomeMessage(requestError, { action: write }));
        }
        outcomes = tagOutcomes(outcomes, write);
        onResults?.(outcomes);
        const result = outcomes[0];
        return { outcome: result.outcome, message: result.message || "", result };
      } finally {
        setBusyKeys((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [onResults]
  );

  return { activate, busyKeys, busy: busyKeys.size > 0 };
}

/** Reinstate-only flavour (the original name): `reinstate(claim, note)` is `activate(claim, "reinstate", note)`. */
export function useReinstate(options) {
  const { activate, ...rest } = useActivateClaim(options);
  const reinstate = useCallback((claim, note) => activate(claim, "reinstate", note), [activate]);
  return { reinstate, ...rest };
}
