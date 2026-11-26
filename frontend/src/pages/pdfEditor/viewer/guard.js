// A way out of promises that may never settle. pdf.js leaves some of its promises pending for ever when their
// document is destroyed (getOperatorList() does), and a worker that died answers nothing at all: whoever awaits
// such a promise directly is stuck, and so is the render queue behind it.
//
//   const guard = createGuard();
//   const page = await guard.run(doc.getPage(1));   // rejects as soon as guard.cancel(error) is called
//
// Unlike Promise.race([promise, cancelled]) nothing piles up on a long-lived promise: a settled waiter is
// forgotten at once, together with its result. Pure module (tests/pdfViewerPages.test.mjs).

export function createGuard() {
  const waiters = new Set();
  let reason = null;
  let cancelled = false;
  return {
    get cancelled() {
      return cancelled;
    },
    /** The value cancel() was called with (undefined before). */
    get reason() {
      return reason;
    },
    /** Settles like `promise`, or rejects with the reason of cancel(), whichever happens first. */
    run(promise) {
      if (cancelled) {
        // the abandoned promise must not surface as an unhandled rejection
        Promise.resolve(promise).catch(() => {});
        return Promise.reject(reason);
      }
      return new Promise((resolve, reject) => {
        const waiter = { reject };
        waiters.add(waiter);
        Promise.resolve(promise).then(
          (value) => {
            if (waiters.delete(waiter)) resolve(value);
          },
          (error) => {
            if (waiters.delete(waiter)) reject(error);
          }
        );
      });
    },
    /** Rejects everything that waits and everything that will be asked for later. Only the first call counts. */
    cancel(error) {
      if (cancelled) return;
      cancelled = true;
      reason = error;
      for (const waiter of [...waiters]) waiter.reject(error);
      waiters.clear();
    }
  };
}
