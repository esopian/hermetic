/**
 * What `OpProgress` says out loud, and how often.
 *
 * The log pane is a transcript and cannot be a live region — an op emits an
 * event every second or two and a screen reader reading all of them is
 * unusable — so the component carries one throttled sentence beside it. Both
 * halves of that are easy to get wrong in a way nobody sees: without the
 * throttle the region is the transcript again, and with the throttle applied to
 * the *verdict* the last thing an op says ("complete", or the error code) is
 * the one thing that can be lost, because a short op's view unmounts before the
 * trailing timer fires.
 */
import { act, cleanup, render, screen } from "./dom.ts";
import { afterEach, describe, expect, jest, test } from "bun:test";
import type { OpEvent } from "../src/api/index.ts";
import type { OpState } from "../src/lib/useOp.ts";
import { OpProgress } from "../src/components/OpProgress.tsx";

afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

/** `ANNOUNCE_MS` in `OpProgress.tsx`, which is deliberately not exported. */
const ANNOUNCE_MS = 4000;

const at = "2026-09-06T12:00:00.000Z";

function event(phase: string, message: string, progress: number): OpEvent {
  return { phase, message, progress, at };
}

function opState(over: Partial<OpState> = {}): OpState {
  return {
    events: [],
    steps: [],
    percent: 0,
    running: true,
    finished: false,
    ok: true,
    error: null,
    ...over,
  };
}

function view(op: OpState) {
  return <OpProgress title="lumen" sub="create · medium" op={op} />;
}

const status = () => screen.getByRole("status").textContent ?? "";

describe("OpProgress · the live region", () => {
  test("carries the latest message and the percent, not the whole log", () => {
    const op = opState({
      percent: 40,
      events: [
        event("volume", "creating the data volume", 0.2),
        event("instance", "launching i-123", 0.4),
      ],
    });
    render(view(op));

    expect(status()).toContain("40%");
    expect(status()).toContain("launching i-123");
    // The line before it is in the log pane, not in the announcement.
    expect(status()).not.toContain("creating the data volume");
  });

  test("the bar exposes the same percent to assistive tech", () => {
    render(view(opState({ percent: 40, events: [event("instance", "launching i-123", 0.4)] })));
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("40");
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("100");
  });

  test("a finished op announces the outcome, and the failure names the code", () => {
    render(
      view(
        opState({
          percent: 60,
          running: false,
          finished: true,
          ok: false,
          error: { code: "ATTACH_TIMEOUT", message: "the volume never attached" },
          events: [event("volume", "attaching vol-1", 0.6)],
        }),
      ),
    );
    expect(status()).toContain("failed");
    expect(status()).toContain("ATTACH_TIMEOUT");
  });
});

describe("OpProgress · the announcement throttle", () => {
  test("collapses a burst of events and flushes the last one", () => {
    jest.useFakeTimers();
    const { rerender } = render(
      view(opState({ percent: 10, events: [event("volume", "creating the data volume", 0.1)] })),
    );
    // Leading edge: the first thing an op says is immediate.
    expect(status()).toContain("creating the data volume");

    act(() => {
      rerender(view(opState({ percent: 40, events: [event("instance", "launching i-123", 0.4)] })));
    });
    act(() => {
      rerender(
        view(opState({ percent: 70, events: [event("bootstrap", "waiting for hermeticd", 0.7)] })),
      );
    });

    // Both landed inside the same window: the region is still on the first
    // sentence. Without the throttle it would have spoken three times.
    expect(status()).toContain("creating the data volume");
    expect(status()).not.toContain("launching i-123");
    expect(status()).not.toContain("waiting for hermeticd");

    act(() => {
      jest.advanceTimersByTime(ANNOUNCE_MS);
    });

    // The trailing flush carries the *latest* state, and the intermediate
    // sentence is never spoken at all — a status, not a transcript.
    expect(status()).toContain("waiting for hermeticd");
    expect(status()).toContain("70%");
    expect(status()).not.toContain("launching i-123");
  });

  test("the verdict is not held behind the throttle at all", () => {
    jest.useFakeTimers();
    const { rerender } = render(
      view(opState({ percent: 90, events: [event("ready", "verifying hermes", 0.9)] })),
    );
    act(() => {
      rerender(
        view(
          opState({
            percent: 100,
            running: false,
            finished: true,
            events: [event("ready", "agent is ready", 1)],
          }),
        ),
      );
    });

    // Inside the window a running op would have been held; a *terminal* value
    // bypasses the throttle instead of racing it. The regression this catches
    // is the one the trailing timer alone cannot fix: a short op whose view
    // unmounts before the flush, so the one sentence a screen-reader user
    // needed ("complete", or the error code) is the one never spoken.
    expect(status()).toContain("complete");
  });

  test("a failure gets the same immediate verdict, with its code", () => {
    jest.useFakeTimers();
    const { rerender } = render(
      view(opState({ percent: 30, events: [event("volume", "creating the data volume", 0.3)] })),
    );
    act(() => {
      rerender(
        view(
          opState({
            percent: 30,
            running: false,
            finished: true,
            ok: false,
            error: { code: "INSUFFICIENT_CAPACITY", message: "no t4g.2xlarge in us-west-2a" },
            events: [event("instance", "launching", 0.3)],
          }),
        ),
      );
    });
    expect(status()).toContain("INSUFFICIENT_CAPACITY");
  });
});
