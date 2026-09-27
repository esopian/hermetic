import { describe, expect, test } from "bun:test";
import type { AgentView } from "../src/api/index.ts";
import type { StageState } from "../src/logic/bootstrap.ts";
import {
  awaitingFirstReport,
  bootstrapCollapsedByDefault,
  bootstrapSummary,
  currentStage,
  currentStageLabel,
  failedStages,
  fmtStageDuration,
  rerunState,
  silentForMs,
  stageColor,
  stageDurationMs,
  stageLabel,
  stageMeta,
  stageTextColor,
  stages,
} from "../src/logic/bootstrap.ts";

/** The stage ids the fixture fleet boots through (§4.3's initial set). */
const IDS = [
  "00-preflight",
  "01-tailscale",
  "02-data-volume",
  "03-config",
  "04-apply",
  "05-service",
  "06-verify",
];

function stage(overrides: Partial<StageState> & { id: string }): StageState {
  return {
    status: "ok",
    attempt: 1,
    started_at: "2026-09-01T00:00:00.000Z",
    ended_at: "2026-09-01T00:00:12.300Z",
    exit_code: 0,
    message: null,
    ...overrides,
  } as StageState;
}

/** A `ready` agent: every stage `ok`, nothing pending, no command. */
function allOk(): StageState[] {
  return IDS.map((id) => stage({ id }));
}

/** The fixture's broken agent: `02-data-volume` failed, later stages pending. */
function withFailure(): StageState[] {
  return IDS.map((id, i) => {
    if (i < 2) return stage({ id });
    if (i === 2) {
      return stage({
        id,
        status: "failed",
        exit_code: 100,
        message: "device /dev/nvme1n1 has an unknown signature; refusing to mkfs",
      });
    }
    return stage({
      id,
      status: "pending",
      attempt: 0,
      started_at: null,
      ended_at: null,
      exit_code: null,
    });
  });
}

function agent(overrides: Partial<AgentView> = {}): AgentView {
  return {
    name: "atlas",
    status: "ready",
    version: 1,
    lock: null,
    size: "medium",
    instance_type: "t4g.2xlarge",
    region: "us-west-2",
    instance_id: "i-1",
    volume_id: "vol-1",
    volume_gib: 100,
    hermes_version: "1.2.0",
    hermeticd_version: "1.2.0",
    config_hash: null,
    bootstrap: {
      hermeticd_version: "1.2.0",
      stages: allOk(),
      current: null,
      started_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-01T00:02:00.000Z",
      last_command_id: null,
    },
    command: null,
    provider: "bedrock",
    secrets_mode: "none",
    browser: true,
    tailscale_ip: "100.64.0.1",
    resources: { ssm_paths: [] },
    last_heartbeat: "2026-09-01T12:00:00.000Z",
    health: { hermes: true, tailscale: true, disk: true },
    metrics: { cpu_pct: 10, mem_pct: 20, disk_pct: 30 },
    created_by: "evan",
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T12:00:00.000Z",
    display_status: "ready",
    heartbeat_age_ms: 5_000,
    ...overrides,
  } as AgentView;
}

/** The `error` agent the fixture seeds, with `02-data-volume` failed. */
function broken(overrides: Partial<AgentView> = {}): AgentView {
  return agent({
    status: "error",
    display_status: "error",
    bootstrap: {
      hermeticd_version: "1.2.0",
      stages: withFailure(),
      current: null,
      started_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-01T00:01:00.000Z",
      last_command_id: null,
    },
    ...overrides,
  } as Partial<AgentView>);
}

describe("stageLabel", () => {
  test("strips the ordinal, unhyphenates, and capitalizes", () => {
    expect(stageLabel("00-preflight")).toBe("Preflight");
    expect(stageLabel("02-data-volume")).toBe("Data volume");
    expect(stageLabel("06-verify")).toBe("Verify");
  });

  test("tolerates an id with no ordinal or a multi-digit one", () => {
    expect(stageLabel("tailscale")).toBe("Tailscale");
    expect(stageLabel("100-late-stage")).toBe("Late stage");
  });

  test("falls back to the raw id rather than rendering nothing", () => {
    expect(stageLabel("07-")).toBe("07-");
    expect(stageLabel("")).toBe("");
  });
});

describe("stage colours", () => {
  test("one token per status", () => {
    expect(stageColor("ok")).toBe("var(--ok)");
    expect(stageColor("failed")).toBe("var(--bad)");
    expect(stageColor("running")).toBe("var(--acc)");
    expect(stageColor("pending")).toBe("var(--line2)");
  });

  test("the status word never uses the hairline colour", () => {
    expect(stageTextColor("pending")).toBe("var(--fg3)");
    expect(stageTextColor("ok")).toBe("var(--ok)");
    expect(stageTextColor("failed")).toBe("var(--bad)");
    expect(stageTextColor("running")).toBe("var(--acc)");
  });
});

describe("durations", () => {
  test("stageDurationMs needs both ends, in order", () => {
    expect(stageDurationMs(stage({ id: "00-preflight" }))).toBe(12_300);
    expect(stageDurationMs(stage({ id: "x", ended_at: null }))).toBeNull();
    expect(stageDurationMs(stage({ id: "x", started_at: null }))).toBeNull();
    expect(stageDurationMs(stage({ id: "x", started_at: "nope" }))).toBeNull();
    expect(
      stageDurationMs(
        stage({
          id: "x",
          started_at: "2026-09-01T00:01:00.000Z",
          ended_at: "2026-09-01T00:00:00.000Z",
        }),
      ),
    ).toBeNull();
  });

  test("fmtStageDuration reads in seconds under a minute", () => {
    expect(fmtStageDuration(12_300)).toBe("12.3s");
    expect(fmtStageDuration(900)).toBe("0.9s");
    expect(fmtStageDuration(64_000)).toBe("1m 04s");
    expect(fmtStageDuration(-1)).toBe("—");
  });

  test("stageMeta shows the attempt only past the first, then the duration", () => {
    expect(stageMeta(stage({ id: "00-preflight" }))).toBe("12.3s");
    expect(stageMeta(stage({ id: "00-preflight", attempt: 2 }))).toBe("attempt 2 · 12.3s");
    expect(stageMeta(stage({ id: "06-verify", status: "pending", attempt: 0, ended_at: null }))).toBe(
      "",
    );
  });
});

describe("reading the checklist", () => {
  test("stages/failedStages/currentStage read through a missing bootstrap", () => {
    const none = agent({ bootstrap: null });
    expect(stages(none)).toEqual([]);
    expect(failedStages(none)).toEqual([]);
    expect(currentStage(none)).toBeNull();
    expect(stages(agent())).toHaveLength(7);
    expect(failedStages(broken()).map((s) => s.id)).toEqual(["02-data-volume"]);
  });

  test("currentStage only speaks while the agent is bootstrapping", () => {
    const booting = agent({
      status: "bootstrapping",
      display_status: "bootstrapping",
      bootstrap: { ...agent().bootstrap!, current: "04-apply" },
    });
    expect(currentStage(booting)).toBe("04-apply");
    expect(
      currentStage(agent({ bootstrap: { ...agent().bootstrap!, current: "04-apply" } })),
    ).toBeNull();
    expect(
      currentStage(agent({ status: "bootstrapping", display_status: "bootstrapping" })),
    ).toBeNull();
  });

  test("currentStageLabel spells the chip's stage the way the checklist does", () => {
    const booting = agent({
      status: "bootstrapping",
      display_status: "bootstrapping",
      bootstrap: { ...agent().bootstrap!, current: "02-data-volume" },
    });
    expect(currentStageLabel(booting)).toBe("Data volume");
    expect(currentStageLabel(agent())).toBeNull();
    expect(currentStageLabel(agent({ bootstrap: null }))).toBeNull();
  });

  test("bootstrapSummary counts ok and failed", () => {
    expect(bootstrapSummary(agent())).toBe("7/7 ok");
    expect(bootstrapSummary(broken())).toBe("2/7 ok · 1 failed");
    expect(bootstrapSummary(agent({ bootstrap: null }))).toBe("no stages recorded");
  });
});

describe("collapse rule", () => {
  test("a ready agent with every stage ok is collapsed", () => {
    expect(bootstrapCollapsedByDefault(agent())).toBe(true);
  });

  test("a failure, a pending stage, or a non-ready status stays open", () => {
    expect(bootstrapCollapsedByDefault(broken())).toBe(false);
    expect(
      bootstrapCollapsedByDefault(
        agent({
          status: "bootstrapping",
          display_status: "bootstrapping",
          bootstrap: { ...agent().bootstrap!, stages: withFailure() },
        }),
      ),
    ).toBe(false);
    // Ready on the row, but the heartbeat went stale: the derived status is
    // what the operator is looking at, so the list opens.
    expect(bootstrapCollapsedByDefault(agent({ display_status: "unreachable" }))).toBe(false);
  });

  test("nothing to show collapses rather than rendering an empty list", () => {
    expect(bootstrapCollapsedByDefault(agent({ bootstrap: null }))).toBe(true);
  });
});

describe("rerunState", () => {
  test("enabled only for an error row with a failed stage", () => {
    const s = rerunState(broken());
    expect(s.kind).toBe("enabled");
    expect(s.label).toBe("Rerun failed stages");
    expect(s.reason).toContain("first failure");
  });

  test("disabled on a healthy agent, naming the status", () => {
    const s = rerunState(agent());
    expect(s.kind).toBe("disabled");
    expect(s.reason).toBe("rerun needs an agent in error; this one is ready");
  });

  test("disabled on an error row with no bootstrap recorded", () => {
    const s = rerunState(agent({ status: "error", display_status: "error", bootstrap: null }));
    expect(s.kind).toBe("disabled");
    expect(s.reason).toContain("no staged bootstrap");
  });

  test("disabled on an error row whose stages all passed", () => {
    const s = rerunState(agent({ status: "error", display_status: "error" }));
    expect(s.kind).toBe("disabled");
    expect(s.reason).toBe("no bootstrap stage has failed");
  });

  test("pending while the row carries a command the box has not acked", () => {
    const queued = broken({
      command: {
        id: "cmd-1",
        action: "rerun",
        issued_by: "evan",
        issued_at: "2026-09-01T00:05:00.000Z",
      },
    });
    const s = rerunState(queued);
    expect(s.kind).toBe("pending");
    expect(s.label).toBe("Rerun queued…");
  });

  test("pending clears once last_command_id matches the command", () => {
    const acked = broken({
      command: {
        id: "cmd-1",
        action: "rerun",
        issued_by: "evan",
        issued_at: "2026-09-01T00:05:00.000Z",
      },
      bootstrap: { ...broken().bootstrap!, last_command_id: "cmd-1" },
    });
    expect(rerunState(acked).kind).toBe("enabled");
  });

  test("the id this tab just issued holds the pending state until the row acks it", () => {
    // The POST returned, but neither the command nor the ack is on the row yet.
    expect(rerunState(broken(), "cmd-9").kind).toBe("pending");
    const acked = broken({ bootstrap: { ...broken().bootstrap!, last_command_id: "cmd-9" } });
    expect(rerunState(acked, "cmd-9").kind).toBe("enabled");
  });

  test("pending wins over a bootstrapping status while the rerun is in flight", () => {
    const running = agent({
      status: "bootstrapping",
      display_status: "bootstrapping",
      command: {
        id: "cmd-2",
        action: "rerun",
        issued_by: "evan",
        issued_at: "2026-09-01T00:05:00.000Z",
      },
    });
    expect(rerunState(running).kind).toBe("pending");
  });
});

/**
 * The state the drawer used to render as nothing at all: a box that launched
 * and never wrote a row. Every report hermeticd makes is a DynamoDB write, so
 * this covers the whole class of boots that die before they can speak.
 */
describe("awaitingFirstReport", () => {
  function silent(overrides: Partial<AgentView> = {}): AgentView {
    return agent({
      status: "creating",
      display_status: "creating",
      bootstrap: null,
      ...overrides,
    });
  }

  test("a creating agent with an instance and no bootstrap is silent", () => {
    expect(awaitingFirstReport(silent())).toBe(true);
  });

  test("so is one that reached bootstrapping without writing a stage", () => {
    expect(
      awaitingFirstReport(silent({ status: "bootstrapping", display_status: "bootstrapping" })),
    ).toBe(true);
  });

  test("an agent that has reported is not silent, however little it said", () => {
    expect(awaitingFirstReport(agent())).toBe(false);
  });

  test("an agent with no instance yet is early, not silent", () => {
    expect(awaitingFirstReport(silent({ instance_id: null }))).toBe(false);
  });

  test("a stopped or destroyed row is not booting, so it is not silent either", () => {
    expect(awaitingFirstReport(silent({ status: "stopped", display_status: "stopped" }))).toBe(false);
    expect(awaitingFirstReport(silent({ status: "destroyed", display_status: "destroyed" }))).toBe(
      false,
    );
  });

  test("silentForMs measures from created_at and never goes negative", () => {
    const a = agent({ created_at: "2026-09-01T00:00:00.000Z" });
    expect(silentForMs(a, Date.parse("2026-09-01T00:04:00.000Z"))).toBe(240_000);
    expect(silentForMs(a, Date.parse("2026-08-31T00:00:00.000Z"))).toBe(0);
    expect(silentForMs(agent({ created_at: "not a date" }), Date.now())).toBeNull();
  });
});
