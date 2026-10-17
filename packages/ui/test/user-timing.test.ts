/**
 * `dropUserTimingMeasures` (`lib/user-timing.ts`): React's development build
 * records a measure per changed-props render and the engine keeps every one,
 * so the page clears the buffer each time the observer reports a batch.
 */
import { describe, expect, test } from "bun:test";
import { dropUserTimingMeasures, type UserTimingHost } from "../src/lib/user-timing.ts";

function fakeHost(supported: readonly string[] = ["mark", "measure"]) {
  const state = {
    cleared: 0,
    observed: [] as unknown[],
    disconnected: 0,
    callback: null as (() => void) | null,
  };
  class Observer {
    static readonly supportedEntryTypes = supported;
    constructor(callback: () => void) {
      state.callback = callback;
    }
    observe(options: unknown): void {
      state.observed.push(options);
    }
    disconnect(): void {
      state.disconnected += 1;
    }
  }
  const host: UserTimingHost = {
    performance: { clearMeasures: () => void (state.cleared += 1) },
    PerformanceObserver: Observer,
  };
  return { host, state };
}

describe("dropUserTimingMeasures", () => {
  test("observes measures and clears the buffer on every batch", () => {
    const { host, state } = fakeHost();
    const stop = dropUserTimingMeasures(host);
    expect(state.observed).toEqual([{ type: "measure" }]);
    state.callback?.();
    state.callback?.();
    expect(state.cleared).toBe(2);
    stop();
    expect(state.disconnected).toBe(1);
  });

  test("an engine that cannot observe measures is left alone", () => {
    const { host, state } = fakeHost(["mark"]);
    dropUserTimingMeasures(host)();
    expect(state.observed).toEqual([]);
    expect(dropUserTimingMeasures({})).toBeFunction();
  });

  test("clears real measures in this runtime when it can observe them", async () => {
    const stop = dropUserTimingMeasures();
    performance.measure("user-timing-test", { start: 0, end: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop();
    const supported =
      typeof PerformanceObserver !== "undefined" &&
      PerformanceObserver.supportedEntryTypes.includes("measure");
    expect(performance.getEntriesByName("user-timing-test").length).toBe(supported ? 0 : 1);
    performance.clearMeasures("user-timing-test");
  });
});
