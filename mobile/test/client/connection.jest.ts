import {
  CONNECT_GRACE_MS,
  CONNECT_QUIET_MS,
  CONNECTED_BEAT_MS,
  connectionCaption,
  connectionStep,
  connectionWord,
  shownStep,
  tunnelUp,
} from "../../src/client/connection.ts";
import type { TailscaleProbe } from "../../src/gateway/tailscale.ts";

const T0 = 1_760_000_000_000;
const attempt = { startedAt: T0 };
const probe = (
  tunnel: TailscaleProbe["tunnel"],
  status: TailscaleProbe["status"] = "off",
): TailscaleProbe => ({
  status,
  failing: [],
  tunnel,
});

describe("tunnelUp", () => {
  test("Tailscale's own answer decides when it gives one", () => {
    expect(tunnelUp(probe("connected", "off"))).toBe(true);
    expect(tunnelUp(probe("no_netmap", "ok"))).toBe(false);
    expect(tunnelUp(probe("down", "ok"))).toBe(false);
  });

  test("a page that says nothing falls back on the box probes", () => {
    expect(tunnelUp(probe("unknown", "ok"))).toBe(true);
    expect(tunnelUp(probe("unknown", "unreachable"))).toBe(true);
    expect(tunnelUp(probe("unknown", "off"))).toBe(false);
    expect(tunnelUp(probe("unknown", "unknown"))).toBeNull();
    expect(tunnelUp(null)).toBeNull();
  });
});

describe("connectionStep", () => {
  test("inside the grace: waking until Tailscale is up, then reaching", () => {
    const now = T0 + 5_000;
    expect(connectionStep({ attempt, now, probe: null, answeredAt: null })).toBe("waking");
    expect(connectionStep({ attempt, now, probe: probe("no_netmap"), answeredAt: null })).toBe(
      "waking",
    );
    expect(connectionStep({ attempt, now, probe: probe("connected"), answeredAt: null })).toBe(
      "reaching",
    );
  });

  test("a box that answered during this attempt is answered, whatever the probe", () => {
    expect(
      connectionStep({ attempt, now: T0 + 1_000, probe: probe("down"), answeredAt: T0 + 200 }),
    ).toBe("answered");
  });

  test("an answer from before this attempt does not count", () => {
    expect(connectionStep({ attempt, now: T0 + 1_000, probe: probe("down"), answeredAt: T0 - 1 })).toBe(
      "waking",
    );
  });

  test("past the grace a wait becomes a failure, named by where it stopped", () => {
    const now = T0 + CONNECT_GRACE_MS;
    expect(connectionStep({ attempt, now, probe: probe("down"), answeredAt: null })).toBe(
      "no_tailscale",
    );
    expect(connectionStep({ attempt, now, probe: probe("connected"), answeredAt: null })).toBe(
      "no_box",
    );
  });
});

describe("shownStep", () => {
  test("a fast answer never shows the path", () => {
    expect(
      shownStep({
        step: "waking",
        attempt,
        now: T0 + CONNECT_QUIET_MS - 1,
        shownSince: null,
        answeredAt: null,
      }),
    ).toBeNull();
    expect(
      shownStep({ step: "answered", attempt, now: T0 + 300, shownSince: null, answeredAt: T0 + 100 }),
    ).toBeNull();
  });

  test("a wait past the quiet beat shows, and keeps showing", () => {
    expect(
      shownStep({
        step: "waking",
        attempt,
        now: T0 + CONNECT_QUIET_MS,
        shownSince: null,
        answeredAt: null,
      }),
    ).toBe("waking");
    expect(
      shownStep({ step: "reaching", attempt, now: T0 + 4_000, shownSince: T0 + 700, answeredAt: null }),
    ).toBe("reaching");
  });

  test("an answer after a shown wait holds connected for the beat, then settles", () => {
    const answeredAt = T0 + 8_000;
    const base = { step: "answered" as const, attempt, shownSince: T0 + 700, answeredAt };
    expect(shownStep({ ...base, now: answeredAt + CONNECTED_BEAT_MS - 1 })).toBe("connected");
    expect(shownStep({ ...base, now: answeredAt + CONNECTED_BEAT_MS })).toBeNull();
  });

  test("failures show at once", () => {
    expect(
      shownStep({ step: "no_box", attempt, now: T0 + 40_000, shownSince: null, answeredAt: null }),
    ).toBe("no_box");
  });
});

describe("words", () => {
  test("the header word and the caption name the step", () => {
    expect(connectionWord("waking", "sindri")).toBe("waking tailscale");
    expect(connectionWord("reaching", "sindri")).toBe("reaching sindri");
    expect(connectionCaption({ shown: "waking", instance: "sindri", asOf: "9:41" })).toBe(
      "Waking Tailscale… · chats as of 9:41",
    );
    expect(connectionCaption({ shown: "no_tailscale", instance: "sindri", asOf: null })).toBe(
      "Tailscale didn’t connect in 30s",
    );
    expect(connectionCaption({ shown: "no_box", instance: "sindri", asOf: null })).toBe(
      "Tailscale is up, but sindri didn’t answer in 30s",
    );
  });
});
