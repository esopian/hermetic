import { describe, expect, test } from "bun:test";
import {
  LAG_MS,
  STALLED_MS,
  VOLUME_BADGE_PENDING,
  fleetPhase,
  fleetPhaseNote,
  fleetTick,
  skeletonCount,
  streamHealth,
  streamLabel,
  tickColor,
  volumeScan,
  volumeTick,
} from "../src/logic/loading.ts";

const base = { connected: false, everConnected: false, scanned: false, scanError: null };

describe("fleetPhase", () => {
  test("a fresh page with no socket yet is connecting", () => {
    expect(fleetPhase(base)).toBe("connecting");
  });

  test("an open socket with no scan behind it is scanning, not empty", () => {
    expect(fleetPhase({ ...base, connected: true })).toBe("scanning");
  });

  test("a socket that has dropped after being open is reconnecting", () => {
    expect(fleetPhase({ ...base, everConnected: true })).toBe("reconnecting");
  });

  test("a scan that threw before any scan succeeded is a failure with a retry", () => {
    expect(fleetPhase({ ...base, connected: true, scanError: "AccessDenied" })).toBe("failed");
  });

  // The whole point of the phase: it governs the first paint and then stops.
  test("one good scan makes the fleet ready for good", () => {
    expect(fleetPhase({ ...base, scanned: true })).toBe("ready");
    expect(fleetPhase({ ...base, scanned: true, connected: false, everConnected: true })).toBe("ready");
    expect(fleetPhase({ ...base, scanned: true, scanError: "throttled" })).toBe("ready");
  });
});

describe("fleetPhaseNote", () => {
  test("names the call rather than saying loading", () => {
    expect(fleetPhaseNote("scanning").title).toBe("Scanning for instances");
    expect(fleetPhaseNote("connecting").detail).toContain("/api/fleet/stream");
  });

  test("a failure carries the server's own message", () => {
    expect(fleetPhaseNote("failed", "AccessDenied on dynamodb:Scan").detail).toBe(
      "AccessDenied on dynamodb:Scan",
    );
  });

  test("a failure with no message still says something", () => {
    expect(fleetPhaseNote("failed").detail.length).toBeGreaterThan(0);
  });
});

describe("skeletonCount", () => {
  test("guesses small when nothing is remembered", () => {
    expect(skeletonCount(null)).toBe(4);
    expect(skeletonCount(0)).toBe(4);
  });

  test("redraws the shape the operator was looking at", () => {
    expect(skeletonCount(6)).toBe(6);
  });

  test("never fills the screen with placeholders for a large fleet", () => {
    expect(skeletonCount(40)).toBe(8);
  });
});

describe("streamHealth", () => {
  const now = Date.parse("2026-09-05T12:00:00.000Z");
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();

  test("a recent poll on an open socket is live", () => {
    expect(streamHealth({ connected: true, everConnected: true, lastPollAt: at(2000), now })).toBe(
      "live",
    );
  });

  test("an open socket that has stopped scanning is lagging, not disconnected", () => {
    expect(
      streamHealth({ connected: true, everConnected: true, lastPollAt: at(LAG_MS + 1), now }),
    ).toBe("lagging");
  });

  test("an open socket with no poll yet is still connecting", () => {
    expect(streamHealth({ connected: true, everConnected: true, lastPollAt: null, now })).toBe(
      "connecting",
    );
  });

  test("a closed socket that was once open is reconnecting", () => {
    expect(streamHealth({ connected: false, everConnected: true, lastPollAt: at(1000), now })).toBe(
      "reconnecting",
    );
  });

  test("a closed socket that never opened is connecting", () => {
    expect(streamHealth({ connected: false, everConnected: false, lastPollAt: null, now })).toBe(
      "connecting",
    );
  });
});

describe("streamLabel", () => {
  test("counts down to the scheduled reconnect instead of sitting on disconnected", () => {
    expect(streamLabel("reconnecting", 4200)).toBe("reconnecting in 5s");
  });

  test("a retry that is already due says so without a negative number", () => {
    expect(streamLabel("reconnecting", -500)).toBe("reconnecting…");
    expect(streamLabel("reconnecting", null)).toBe("reconnecting…");
  });

  test("live reads as a state, not a timestamp", () => {
    expect(streamLabel("live", null)).toBe("live");
  });

  /**
   * "no scan in a while" gave an operator no number to compare against the 3s
   * cadence they cannot see, and no hint whether to act. The socket is open in
   * this state, so a short gap is a slow `Scan` on a big table — and a long one
   * is a poller that has stopped.
   */
  test("lagging says how long, and reads as slow rather than broken at first", () => {
    expect(streamLabel("lagging", null, 9_000)).toBe("no scan for 9s · slow scan");
  });

  test("a gap of ten cadences stops being a slow scan and says so", () => {
    expect(streamLabel("lagging", null, STALLED_MS)).toBe(
      `no scan for ${Math.round(STALLED_MS / 1000)}s · the poller may be stuck`,
    );
    expect(streamLabel("lagging", null, STALLED_MS - 1000)).toContain("slow scan");
  });

  test("a lag it cannot measure still says something, and never a NaN", () => {
    // `lastPollAt` unparseable, or a clock that moved backwards.
    expect(streamLabel("lagging", null)).toBe("no scan for a while");
    expect(streamLabel("lagging", null, Number.NaN)).toBe("no scan for a while");
    expect(streamLabel("lagging", null, -500)).toBe("no scan for a while");
  });

  test("only a failed read is allowed the bad colour", () => {
    expect(fleetTick("live", null)).toBe("ok");
    expect(fleetTick("connecting", null)).toBe("pending");
    expect(fleetTick("lagging", null)).toBe("warn");
    expect(fleetTick("reconnecting", null)).toBe("warn");
    expect(fleetTick("live", "Scan throttled")).toBe("bad");
    expect(tickColor("ok")).toBe("var(--ok)");
    expect(tickColor("warn")).toBe("var(--warn)");
    expect(tickColor("bad")).toBe("var(--bad)");
    expect(tickColor("pending")).toBe("var(--fg3)");
  });
});

describe("volumeTick", () => {
  const now = Date.parse("2026-09-25T12:00:00.000Z");
  const at = (ago: number) => new Date(now - ago).toISOString();
  const base = { error: null, now, staleAfterMs: 180_000 };

  test("pending before the first read, ok on cadence, warn once stale", () => {
    expect(volumeTick({ ...base, readAt: null })).toBe("pending");
    expect(volumeTick({ ...base, readAt: at(60_000) })).toBe("ok");
    expect(volumeTick({ ...base, readAt: at(180_001) })).toBe("warn");
  });

  test("a failed read is bad, even over an inventory still on screen", () => {
    expect(volumeTick({ ...base, readAt: at(1000), error: "DescribeVolumes denied" })).toBe("bad");
  });
});

describe("volumeScan", () => {
  test("before the first read the view owes a skeleton, not an empty page", () => {
    const s = volumeScan({ loading: true, hasRead: false, error: null, count: 0 });
    expect(s.skeleton).toBe(true);
    expect(s.empty).toBe(false);
    expect(s.note).toContain("EC2");
  });

  // The first render happens before the effect flips `loading`; a skeleton keyed
  // on `loading` would flash "Nothing loose" for one frame on every mount.
  test("the frame before the read starts is still a skeleton", () => {
    expect(volumeScan({ loading: false, hasRead: false, error: null, count: 0 }).skeleton).toBe(true);
  });

  test("a read that came back empty is genuinely empty", () => {
    const s = volumeScan({ loading: false, hasRead: true, error: null, count: 0 });
    expect(s.skeleton).toBe(false);
    expect(s.empty).toBe(true);
  });

  test("a re-read over data on screen is busy, never a skeleton", () => {
    const s = volumeScan({ loading: true, hasRead: true, error: null, count: 3 });
    expect(s.skeleton).toBe(false);
    expect(s.busy).toBe(true);
    expect(s.empty).toBe(false);
  });

  test("a first read that failed shows the error, not a skeleton forever", () => {
    expect(volumeScan({ loading: false, hasRead: true, error: "boom", count: 0 }).skeleton).toBe(false);
  });

  test("the nav badge asks rather than answers before the first read", () => {
    expect(VOLUME_BADGE_PENDING).not.toBe("—");
  });
});
