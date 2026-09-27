/**
 * The rule that stops a flapping browser pane from becoming a poll.
 *
 * Measured against a live portal: an embedded pane being captured flaps
 * hidden↔visible every couple of seconds, and the roster read that fires "when
 * the tab comes back" fired on every visible half — a fleet-wide fan-out over
 * the tailnet, twice a minute turned into thirty. Both halves of the fix are
 * tested here because either alone leaves a hole: a transition without an age
 * still reads on every real flap, and an age without a transition still reads
 * on an event that did not change anything.
 */
import { flipPageHidden, setPageHidden } from "./setup.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { onReturnVisible, RETURN_READ_MIN_AGE_MS } from "../src/lib/visibility.ts";

/**
 * The page's own state, moved under `setup.ts`'s getter — it owns the two
 * `document` properties for the whole run, and this file puts a visible page
 * back for the next one.
 */
const flip = (next: "visible" | "hidden"): void => flipPageHidden(next === "hidden");

// A visible page, back for the next file: the reset is each suite's own (`setup.ts`).
afterEach(() => setPageHidden(false));

/** A clock the test owns, and a page it can flap. */
function harness(minAgeMs = RETURN_READ_MIN_AGE_MS) {
  let clock = 1_000_000;
  let reads = 0;
  const stop = onReturnVisible(
    () => {
      reads += 1;
    },
    { minAgeMs, now: () => clock },
  );
  return {
    get reads() {
      return reads;
    },
    stop,
    tick(ms: number) {
      clock += ms;
    },
    set: flip,
  };
}

describe("a return to the page is a transition, and a read has a minimum age", () => {
  test("a pane flapping every two seconds reads once per minimum age, not once per flap", () => {
    const host = harness();
    // Thirty toggles across a minute: fifteen returns, which the naive
    // listener answered with fifteen reads.
    for (let i = 0; i < 15; i++) {
      host.set("hidden");
      host.tick(1_000);
      host.set("visible");
      host.tick(3_000);
    }
    expect(host.reads).toBeLessThanOrEqual(Math.floor(60_000 / RETURN_READ_MIN_AGE_MS) + 1);
    expect(host.reads).toBe(4);
    host.stop();
  });

  test("an event that does not change the state is not a return", () => {
    const host = harness();
    host.tick(RETURN_READ_MIN_AGE_MS * 10);
    host.set("visible");
    host.set("visible");
    host.set("visible");
    expect(host.reads).toBe(0);
    host.stop();
  });

  test("a real return after a long absence reads immediately", () => {
    const host = harness();
    host.set("hidden");
    host.tick(RETURN_READ_MIN_AGE_MS * 4);
    host.set("visible");
    expect(host.reads).toBe(1);
    host.stop();
  });

  test("the caller's own reads count: a fresh answer is not read again", () => {
    let clock = 1_000_000;
    let reads = 0;
    const lastReadAt = { current: 0 };
    const stop = onReturnVisible(
      () => {
        reads += 1;
      },
      { lastReadAt, now: () => clock },
    );
    // Something else — a mutation, the store's own tick — has just read.
    lastReadAt.current = clock;
    flip("hidden");
    clock += 1_000;
    flip("visible");
    expect(reads).toBe(0);
    stop();
  });

  test("unsubscribing is the end of it", () => {
    const host = harness(0);
    host.stop();
    host.set("hidden");
    host.set("visible");
    expect(host.reads).toBe(0);
  });
});
