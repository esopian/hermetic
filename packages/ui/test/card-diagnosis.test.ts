import { expect, test } from "bun:test";
import type { AgentView, ProfileView } from "../src/api/index.ts";
import { diagnose } from "../src/logic/card-diagnosis.ts";

const base = {
  name: "atlas",
  display_status: "ready",
  provider: "bedrock",
  hermes_version: "0.21.0",
  volume_id: null,
  volume_gib: 100,
  metrics: { cpu_pct: 34, mem_pct: 61, disk_pct: 62, root_disk_pct: 27 },
  heartbeat_age_ms: 30_000,
  pending: null,
  update_available: false,
  bootstrap: null,
} as AgentView;
const ctx = { latest: "0.21.0", volumes: [], profiles: [] as ProfileView[] };
const row = (change: Partial<AgentView>) => ({ ...base, ...change }) as AgentView;

test("one diagnosis follows urgency before maintenance and counts remaining items", () => {
  const a = row({
    display_status: "unreachable",
    heartbeat_age_ms: 1_200_000,
    metrics: { cpu_pct: 34, mem_pct: 61, disk_pct: 62, root_disk_pct: 96, root_free_mib: 256 },
    hermes_version: "0.14.2",
    update_available: true,
  });
  const d = diagnose(a, ctx);
  expect(d?.kind).toBe("urgent");
  expect(d?.message).toBe("No heartbeat for 20m.");
  expect(d?.evidence).toContain("root 96% · 256 MiB free");
  expect(d?.logSource).toBe("console");
  expect(d?.more).toBeGreaterThan(1);
});

test("stopped saved changes explain when they apply without an action link", () => {
  const a = row({
    display_status: "stopped",
    pending: {
      profile_id: "ant00001",
      profile_revision: 2,
      provider: "anthropic",
      model: "claude-sonnet-5",
      credential_ref: null,
      staged_at: "2026-10-01T00:00:00Z",
      staged_by: "fixture",
    },
  });
  const d = diagnose(a, ctx);
  expect(d?.message).toBe("Saved: bedrock → anthropic · claude-sonnet-5");
  expect(d?.evidence).toContain("start and apply");
  expect(d?.link).toBeUndefined();
  expect(d?.suppress).toBe("pending");
});

test("failed stage wins and preserves its reported cause", () => {
  const a = row({
    display_status: "error",
    bootstrap: {
      hermeticd_version: "fixture",
      started_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
      current: null,
      stages: [
        {
          id: "02-data-volume",
          status: "failed",
          attempt: 1,
          started_at: null,
          ended_at: null,
          exit_code: 100,
          message: "Unknown disk signature.",
        },
      ],
    },
    hermes_version: "0.14.2",
  });
  const d = diagnose(a, ctx);
  expect(d?.message).toBe("Unknown disk signature.");
  expect(d?.evidence).toBe("stage 02-data-volume · exit 100");
  expect(d?.more).toBeGreaterThan(0);
});

test("profile update and disk pressure choose the profile action", () => {
  const a = row({
    update_available: true,
    profile_id: "ant00001",
    profile_revision: 1,
    metrics: { cpu_pct: 2, mem_pct: 4, disk_pct: 12, root_disk_pct: 78, root_free_mib: 3891 },
  });
  const profile = { id: "ant00001", name: "anthropic", revision: 2 } as ProfileView;
  const d = diagnose(a, { ...ctx, profiles: [profile] });
  expect(d?.message).toContain("anthropic profile changed · r1 → r2");
  expect(d?.tab).toBe("config");
  expect(d?.suppress).toBe("update");
  expect(d?.more).toBe(1);
});

test("bootstrapping uses the stage strip ahead of saved maintenance", () => {
  const a = row({
    display_status: "bootstrapping",
    bootstrap: {
      hermeticd_version: "fixture",
      started_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:01:00Z",
      current: "02-data-volume",
      stages: [
        { id: "01-tailscale", status: "ok", attempt: 1 },
        { id: "02-data-volume", status: "running", attempt: 1 },
      ],
    },
    update_available: true,
  });
  const d = diagnose(a, ctx);
  expect(d?.kind).toBe("stage");
  expect(d?.stages?.map((s) => s.status)).toEqual(["ok", "running"]);
  expect(d?.more).toBe(1);
});
