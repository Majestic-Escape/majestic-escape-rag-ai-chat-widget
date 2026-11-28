// A time limit for the database calls a customer's request waits on. The client has no socket timeout (the
// listing change stream needs long first waits), so one stalled call could hold a request until the driver
// notices the server is gone; a chat turn was held 25 s (staging drill 2026-11-28). The driver's `signal` /
// `timeoutMS` options are experimental, so the wait is bounded here instead.

/** How long one request-path database call may wait. Healthy calls carry maxTimeMS 1.5-2 s. The worst chat turn
 *  is a catalogue that fails after 2 x 3 s (the database also behind it) plus one wait here: about 8.5 s, inside
 *  the 9 s turn deadline. */
export const DB_WAIT_MS = 2500;

/** `p`, or a rejection once `ms` pass or `signal` fires. A write cut off this way may still land later. */
export function bounded<T>(p: Promise<T>, ms: number = DB_WAIT_MS, signal?: AbortSignal): Promise<T> {
  const stop = signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
  return new Promise<T>((resolve, reject) => {
    const quit = () => reject(stop.reason);
    if (stop.aborted) return quit();
    stop.addEventListener("abort", quit, { once: true });
    p.then(
      (v) => { stop.removeEventListener("abort", quit); resolve(v); },
      (e) => { stop.removeEventListener("abort", quit); reject(e); }
    );
  });
}
