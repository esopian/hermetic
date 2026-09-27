/**
 * The liveness rules: how stale a silence reads, when the drawer spends five
 * seconds probing without being asked, and how a §9 report renders.
 */
import { describe, expect, test } from "bun:test";
import type { AgentView, ProbeReport } from "../src/api/index.ts";
import {
  BOOTSTRAP_STALL_MS,
  CREATE_STALL_MS,
  absoluteTime,
  lastSeenLabel,
  probeSequencer,
  layerRows,
  outcomeColor,
  pendingLayerRows,
  shouldAutoProbe,
  verdictColor,
} from "../src/logic/liveness-logic.ts";

const NOW = Date.parse("2026-09-05T12:00:00.000Z");

function agent(overrides: Partial<AgentView> = {}): AgentView {
  return {
    name: "lumen",
    status: "ready",
    display_status: "ready",
    last_heartbeat: "2026-09-05T11:59:55.000Z",
    heartbeat_age_ms: 5_000,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-05T11:59:55.000Z",
    health: { hermes: true, tailscale: true, disk: true },
    ...overrides,
  } as AgentView;
}

function layer(over: Record<string, unknown> = {}) {
  return { outcome: "ok", detail: "", latency_ms: 0, ...over };
}

function report(over: Partial<ProbeReport> = {}): ProbeReport {
  return {
    name: "lumen",
    at: "2026-09-05T12:00:00.000Z",
    row: {},
    instance: layer({ detail: "running · system ok", latency_ms: 312 }),
    hermeticd: layer({ outcome: "fail", detail: "no answer on 100.64.0.9", latency_ms: 5_000 }),
    dashboard: layer({ outcome: "skip", detail: "no tailnet ip to reach", latency_ms: null }),
    desktop: layer({ outcome: "skip", detail: "no tailnet ip to reach", latency_ms: null }),
    browser: layer({
      outcome: "skip",
      detail: "the box did not report its browsers",
      latency_ms: null,
    }),
    verdict: {
      level: "bad",
      summary: "the box is up, hermeticd is not",
      hints: ["hermetic agent reboot lumen"],
    },
    ...over,
  } as ProbeReport;
}

describe("lastSeenLabel: how stale, not just that it is stale", () => {
  test("unreachable says how long ago the last heartbeat was", () => {
    expect(
      lastSeenLabel(agent({ display_status: "unreachable", heartbeat_age_ms: 3 * 3_600_000 })),
    ).toBe("last seen 3h 00m ago");
  });

  test("a row that never once reported says so rather than computing from null", () => {
    expect(lastSeenLabel(agent({ display_status: "unreachable", heartbeat_age_ms: null }))).toBe(
      "never seen",
    );
  });

  test("degraded is heartbeating, so it reports the age of the heartbeat", () => {
    expect(lastSeenLabel(agent({ display_status: "degraded", heartbeat_age_ms: 5_000 }))).toBe(
      "heartbeat just now",
    );
    expect(lastSeenLabel(agent({ display_status: "degraded", heartbeat_age_ms: 120_000 }))).toBe(
      "heartbeat 2m ago",
    );
  });

  test("a status that already says everything gets no trailer", () => {
    expect(lastSeenLabel(agent({ display_status: "ready" }))).toBeNull();
    expect(lastSeenLabel(agent({ display_status: "stopped", heartbeat_age_ms: null }))).toBeNull();
    expect(lastSeenLabel(agent({ display_status: "destroyed" }))).toBeNull();
    expect(lastSeenLabel(agent({ display_status: "bootstrapping" }))).toBeNull();
  });
});

describe("shouldAutoProbe", () => {
  test("a row that has already reported a problem is probed on open", () => {
    for (const display_status of ["unreachable", "degraded", "error"] as const) {
      expect(shouldAutoProbe(agent({ display_status }), NOW)).toBe(true);
    }
  });

  test("a healthy or deliberately-off row is never probed without being asked", () => {
    for (const display_status of ["ready", "stopped", "destroyed", "stopping", "destroying"] as const) {
      expect(shouldAutoProbe(agent({ status: "ready", display_status }), NOW)).toBe(false);
    }
  });

  test("bootstrapping is probed only once it has stopped moving", () => {
    const moving = agent({
      status: "bootstrapping",
      display_status: "bootstrapping",
      updated_at: new Date(NOW - BOOTSTRAP_STALL_MS).toISOString(),
    });
    // Exactly at the threshold is still a slow bootstrap, not a stuck one.
    expect(shouldAutoProbe(moving, NOW)).toBe(false);
    expect(shouldAutoProbe(moving, NOW + 1)).toBe(true);
    expect(BOOTSTRAP_STALL_MS).toBe(600_000);
  });

  test("creating gets the longer leash, and the same strict boundary", () => {
    const creating = agent({
      status: "creating",
      display_status: "creating",
      updated_at: new Date(NOW - CREATE_STALL_MS).toISOString(),
    });
    expect(shouldAutoProbe(creating, NOW)).toBe(false);
    expect(shouldAutoProbe(creating, NOW + 1)).toBe(true);
    // A creating row younger than the bootstrap threshold is not caught by it.
    expect(
      shouldAutoProbe(
        agent({
          status: "creating",
          display_status: "creating",
          updated_at: new Date(NOW - BOOTSTRAP_STALL_MS - 1).toISOString(),
        }),
        NOW,
      ),
    ).toBe(false);
    expect(CREATE_STALL_MS).toBe(900_000);
  });

  test("an unparseable updated_at is not a reason to probe", () => {
    expect(
      shouldAutoProbe(
        agent({ status: "bootstrapping", display_status: "bootstrapping", updated_at: "not a date" }),
        NOW,
      ),
    ).toBe(false);
  });
});

describe("layerRows", () => {
  test("five layers, outermost first, with formatted latency", () => {
    expect(layerRows(report())).toEqual([
      {
        key: "instance",
        outcome: "ok",
        label: "instance",
        detail: "running · system ok",
        latency: "312 ms",
      },
      {
        key: "hermeticd",
        outcome: "fail",
        label: "hermeticd",
        detail: "no answer on 100.64.0.9",
        latency: "5000 ms",
      },
      {
        key: "dashboard",
        outcome: "skip",
        label: "dashboard",
        detail: "no tailnet ip to reach",
        latency: null,
      },
      {
        key: "desktop",
        outcome: "skip",
        label: "desktop",
        detail: "no tailnet ip to reach",
        latency: null,
      },
      {
        key: "browser",
        outcome: "skip",
        label: "browser",
        detail: "the box did not report its browsers",
        latency: null,
      },
    ]);
  });

  test("a layer nothing was attempted on has no duration to report", () => {
    const rows = layerRows(report({ instance: layer({ outcome: "skip", latency_ms: null }) as never }));
    expect(rows[0]?.latency).toBeNull();
  });

  test("the pending rows carry the same keys and labels as a real report", () => {
    expect(pendingLayerRows().map((r) => [r.key, r.label])).toEqual(
      layerRows(report()).map((r) => [r.key, r.label]),
    );
    expect(pendingLayerRows().every((r) => r.outcome === "skip" && r.latency === null)).toBe(true);
  });
});

describe("colours", () => {
  test("a skipped layer is muted, not red — skip is not a failure", () => {
    expect(outcomeColor("ok")).toBe("var(--ok)");
    expect(outcomeColor("fail")).toBe("var(--bad)");
    expect(outcomeColor("skip")).toBe("var(--fg3)");
  });

  test("every verdict level has a colour, including the one that means nothing was learned", () => {
    expect(verdictColor("ok")).toBe("var(--ok)");
    expect(verdictColor("warn")).toBe("var(--warn)");
    expect(verdictColor("bad")).toBe("var(--bad)");
    expect(verdictColor("unknown")).toBe("var(--fg3)");
  });
});

describe("absoluteTime", () => {
  test("a row that never heartbeat has no wall clock to show", () => {
    expect(absoluteTime(null)).toBeNull();
  });

  test("a timestamp that will not parse is no tooltip, not a row of dashes", () => {
    expect(absoluteTime("not a date")).toBeNull();
    expect(absoluteTime("")).toBeNull();
  });

  test("today is the bare clock", () => {
    const iso = "2026-09-05T12:00:00.000Z";
    const out = absoluteTime(iso, Date.parse(iso));
    expect(out).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(out).toBe(new Date(iso).toTimeString().slice(0, 8));
  });

  test("any other day carries its date, so a `3d ago` tooltip is unambiguous", () => {
    const iso = "2026-09-02T11:59:55.000Z";
    const out = absoluteTime(iso, Date.parse("2026-09-05T12:00:00.000Z"));
    const clock = new Date(iso).toTimeString().slice(0, 8);
    expect(out).not.toBe(clock);
    expect(out?.endsWith(clock)).toBe(true);
    // The date part is locale-formatted, so assert it names the day, not a format.
    expect(out).toContain(String(new Date(iso).getDate()));
  });
});

describe("probeSequencer: which probe still owns the panel", () => {
  test("a ticket is current until it settles", () => {
    const q = probeSequencer();
    q.focus("lumen");
    const t = q.begin("lumen");
    expect(t).not.toBeNull();
    expect(q.inFlight()).toBe("lumen");
    expect(q.isCurrent(t!)).toBe(true);
    expect(q.settle(t!)).toBe(true);
    expect(q.inFlight()).toBeNull();
    expect(q.isCurrent(t!)).toBe(false);
  });

  test("a second probe for the same name is refused, not queued", () => {
    // The auto-probe fires on open; a click on top of it is the same request.
    const q = probeSequencer();
    q.focus("lumen");
    expect(q.begin("lumen")).not.toBeNull();
    expect(q.begin("lumen")).toBeNull();
    expect(q.begin("lumen")).toBeNull();
  });

  test("re-focusing the same name leaves the in-flight probe alone (StrictMode)", () => {
    // StrictMode mounts every effect twice. The second mount must not cancel
    // the first mount's request, and must not start a second one.
    const q = probeSequencer();
    expect(q.focus("lumen")).toBe(true);
    const first = q.begin("lumen");
    expect(first).not.toBeNull();
    expect(q.focus("lumen")).toBe(false);
    expect(q.begin("lumen")).toBeNull();
    expect(q.isCurrent(first!)).toBe(true);
  });

  test("A→B: A's answer is no longer wanted, and cannot clear B's spinner", () => {
    const q = probeSequencer();
    q.focus("lumen");
    const a = q.begin("lumen");
    expect(q.focus("ember")).toBe(true);
    // A is abandoned the moment the focus moves — before B even starts.
    expect(q.isCurrent(a!)).toBe(false);
    const b = q.begin("ember");
    expect(q.isCurrent(b!)).toBe(true);
    // A settling late is silent: `false` means "do not touch `probing`".
    expect(q.settle(a!)).toBe(false);
    expect(q.isCurrent(b!)).toBe(true);
    expect(q.inFlight()).toBe("ember");
    expect(q.settle(b!)).toBe(true);
  });

  test("A→B→A: the old A ticket never becomes current again", () => {
    const q = probeSequencer();
    q.focus("lumen");
    const a1 = q.begin("lumen");
    q.focus("ember");
    q.focus("lumen");
    const a2 = q.begin("lumen");
    expect(a2!.id).not.toBe(a1!.id);
    expect(q.isCurrent(a1!)).toBe(false);
    expect(q.isCurrent(a2!)).toBe(true);
    expect(q.settle(a1!)).toBe(false);
  });

  test("after a focus move the next probe is allowed straight away", () => {
    // `focus` abandons the old ticket rather than leaving the name blocked.
    const q = probeSequencer();
    q.focus("lumen");
    q.begin("lumen");
    q.focus("ember");
    expect(q.inFlight()).toBeNull();
    expect(q.begin("ember")).not.toBeNull();
  });
});
