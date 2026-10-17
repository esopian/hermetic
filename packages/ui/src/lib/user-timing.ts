/**
 * Keep the page's User Timing buffer empty.
 *
 * React 19.2's development build records a `performance.measure` entry for
 * every re-render whose props changed, with a structured-cloned prop diff as its
 * `detail`, for the DevTools "Components ⚛" track. Neither WebKit nor Chromium
 * ever evicts a user timing entry, so in a dev window left open on a busy chat
 * they pile up for good: about 300k entries in a quarter hour under load, and a
 * renderer at 9.5 GB after a day and a half. Clearing that buffer brought one
 * from 503 MB back to 166 MB.
 *
 * A release ships React's production build (`packages/app/view-build.ts`), which
 * records no measures, so there this observer never fires. The page itself
 * reads no measures, and clearing the buffer costs a profile nothing: DevTools
 * records a measure into its trace when it is made, not from the buffer.
 *
 * An observer rather than a timer: it does work only when measures are being
 * made, and a test that mounts the page leaves no interval behind.
 */

/** The two globals this needs, injectable so a test can drive it. */
export interface UserTimingHost {
  performance?: Pick<Performance, "clearMeasures">;
  PerformanceObserver?: {
    new (callback: () => void): Pick<PerformanceObserver, "observe" | "disconnect">;
    readonly supportedEntryTypes?: readonly string[];
  };
}

/** Start dropping measures as they are recorded; the result stops it. */
export function dropUserTimingMeasures(host: UserTimingHost = globalThis): () => void {
  const perf = host.performance;
  const Observer = host.PerformanceObserver;
  if (perf === undefined || typeof perf.clearMeasures !== "function" || Observer === undefined) {
    return () => {};
  }
  if (!(Observer.supportedEntryTypes ?? []).includes("measure")) return () => {};
  const observer = new Observer(() => perf.clearMeasures());
  observer.observe({ type: "measure" });
  return () => observer.disconnect();
}
