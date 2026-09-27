/**
 * The agent drawer's words about an agent (`agent-summary.ts`): the Overview's
 * one sentence, and the sub-lines under the Overview and Lifecycle entries of
 * its left nav. Pure, so every status is walked here rather than rendered.
 *
 * Plus the Logs section's one rule that is not a render: which sources an
 * agent can serve, and why not (`sourceUnavailable`).
 */
import { describe, expect, test } from "bun:test";
import type { AgentView } from "../src/api/index.ts";
import type { RerunState } from "../src/logic/bootstrap.ts";
import {
  failingChecks,
  lifecycleSubline,
  overviewSubline,
  statusSentence,
} from "../src/components/agent/agent-summary.ts";
import { LOG_SOURCES, sourceUnavailable } from "../src/components/agent/AgentLogs.tsx";

function agent(overrides: Partial<AgentView> = {}): AgentView {
  return {
    name: "lumen",
    status: "ready",
    display_status: "ready",
    size: "medium",
    instance_type: "t4g.2xlarge",
    instance_id: "i-1",
    volume_id: "vol-1",
    volume_gib: 100,
    hermes_version: "1.2.0",
    heartbeat_age_ms: 5_000,
    last_heartbeat: "2026-09-05T11:59:55.000Z",
    health: { hermes: true, tailscale: true, disk: true, dashboard: true },
    created_at: "2026-09-01T00:00:00.000Z",
    ...overrides,
  } as AgentView;
}

const NO_RERUN: RerunState = { kind: "disabled", label: "Rerun failed stages", reason: "" };

describe("statusSentence", () => {
  test("a healthy ready agent is serving, and says when it last spoke", () => {
    const say = statusSentence(agent());
    expect(say.lead).toBe("Ready and serving chats.");
    expect(say.detail).toContain("Last heartbeat just now");
    expect(say.tone).toBe("ok");
  });

  test("a ready agent with a failing check names the check", () => {
    const say = statusSentence(
      agent({ health: { hermes: true, tailscale: true, disk: false, dashboard: false } }),
    );
    expect(say.tone).toBe("warn");
    expect(say.detail).toContain("disk and dashboard are not reporting healthy");
  });

  test("an unreported check is not a failing one", () => {
    expect(failingChecks(agent({ health: { hermes: true, tailscale: true, disk: true } }))).toEqual([]);
  });

  test("a failed bootstrap names the stage, its message, and where the fix is", () => {
    const say = statusSentence(
      agent({
        status: "error",
        display_status: "error",
        bootstrap: {
          hermeticd_version: "0.4.0",
          stages: [
            { id: "01-tailscale", status: "ok" },
            { id: "02-data-volume", status: "failed", message: "refusing to mkfs" },
          ],
        },
      } as Partial<AgentView>),
    );
    expect(say.lead).toBe("Bootstrap failed at Data volume.");
    expect(say.detail).toContain("refusing to mkfs");
    expect(say.detail).toContain("Lifecycle");
    expect(say.tone).toBe("bad");
  });

  test("a silent agent points at the probe and the reboot", () => {
    const say = statusSentence(agent({ display_status: "unreachable", heartbeat_age_ms: 10 * 60_000 }));
    expect(say.lead).toBe("Not answering.");
    expect(say.detail).toContain("Probe");
    expect(say.detail).toContain("reboot");
  });

  test("a destroyed agent reads as the record it is", () => {
    const say = statusSentence(agent({ status: "destroyed", display_status: "destroyed" }));
    expect(say.lead).toBe("Destroyed.");
    expect(say.detail).toContain("vol-1 retained");
  });

  test("every status has a sentence", () => {
    for (const s of [
      "creating",
      "bootstrapping",
      "ready",
      "degraded",
      "stopping",
      "stopped",
      "destroying",
      "destroyed",
      "error",
      "unreachable",
    ]) {
      expect(statusSentence(agent({ display_status: s } as Partial<AgentView>)).lead).not.toBe("");
    }
  });
});

describe("the nav sub-lines", () => {
  test("Overview reads the checks in a word", () => {
    expect(overviewSubline(agent())).toBe("all checks ok");
    expect(overviewSubline(agent({ health: undefined }))).toBe("no report yet");
    expect(
      overviewSubline(
        agent({ health: { hermes: false, tailscale: true, disk: true, dashboard: true } }),
      ),
    ).toBe("hermes failing");
  });

  test("Lifecycle recommends only what the page would enable", () => {
    expect(lifecycleSubline(agent(), "1.2.0", NO_RERUN)).toEqual({
      text: "no action needed",
      accent: false,
    });
    expect(lifecycleSubline(agent(), "1.3.0", NO_RERUN)).toEqual({
      text: "upgrade available",
      accent: true,
    });
    expect(lifecycleSubline(agent(), "1.3.0", { kind: "enabled", label: "", reason: "" }).text).toBe(
      "rerun available",
    );
    // A destroyed row is never behind, and never offered anything.
    expect(lifecycleSubline(agent({ display_status: "destroyed" }), "1.3.0", NO_RERUN)).toEqual({
      text: "destroyed",
      accent: false,
    });
  });
});

describe("the Logs sources an agent can serve", () => {
  const byId = (id: string) => LOG_SOURCES.find((s) => s.id === id)!;

  test("Activity always reads; it is hermetic's record, not the box's", () => {
    expect(
      sourceUnavailable(byId("activity"), agent({ display_status: "destroyed", instance_id: null })),
    ).toBeNull();
  });

  test("a stopped box serves no journal or log file, but its console still reads", () => {
    const stopped = agent({ status: "stopped", display_status: "stopped" });
    expect(sourceUnavailable(byId("errors"), stopped)).toContain("stopped");
    expect(sourceUnavailable(byId("dashboard"), stopped)).toContain("stopped");
    expect(sourceUnavailable(byId("console"), stopped)).toBeNull();
  });

  test("no instance, no console", () => {
    expect(sourceUnavailable(byId("console"), agent({ instance_id: null }))).toContain("no instance");
  });

  test("each box source names exactly one of unit, file or console", () => {
    for (const s of LOG_SOURCES) {
      if (!s.query) continue;
      const named =
        ["unit", "file"].filter((k) => k in s.query!).length + (s.query.source === "console" ? 1 : 0);
      expect(named).toBeLessThanOrEqual(1);
    }
  });
});
