/**
 * `agents.probe` (§9). Two halves, deliberately:
 *
 * - `verdictFor` is pure, so the reading of the four layers — which combination
 *   means what, and what the operator should type next — is table-tested with
 *   no backend, no clock and no network at all.
 * - the integration half proves the plumbing: that the layers really do run in
 *   parallel and catch their own failures, that a layer which never answers
 *   becomes `fail` rather than a rejected promise, and that nothing was
 *   written to the fleet on the way past.
 */
import { describe, expect, test } from "bun:test";
import type { HermeticError } from "../src/errors.ts";
import { verdictFor } from "../src/agents/probe.ts";
import type {
  ProbeBrowser,
  ProbeDashboard,
  ProbeDesktop,
  ProbeHermeticd,
  ProbeInstance,
  ProbeReport,
  ProbeRow,
  RpcHealth,
} from "../src/schema/index.ts";
import { FIXTURE_CONFIG, MemoryBackend, seedFixtureFleet } from "../src/backend/memory.ts";
import { testHermetic } from "./helpers.ts";

const AT = "2026-09-01T12:00:00.000Z";

function row(over: Partial<ProbeRow> = {}): ProbeRow {
  return {
    status: "ready",
    display_status: "ready",
    last_heartbeat: AT,
    heartbeat_age_ms: 4_000,
    updated_at: AT,
    health: { hermes: true, tailscale: true, disk: true },
    hermeticd_version: "0.4.1",
    lock: null,
    bootstrap: null,
    ...over,
  };
}

function instance(over: Partial<ProbeInstance> = {}): ProbeInstance {
  return {
    outcome: "ok",
    detail: "running · system ok · instance ok",
    latency_ms: 12,
    instance_id: "i-1",
    state: "running",
    system_status: "ok",
    instance_status: "ok",
    not_found: false,
    ...over,
  };
}

function hermeticd(over: Partial<ProbeHermeticd> = {}): ProbeHermeticd {
  return {
    outcome: "ok",
    detail: "hermeticd 0.4.1 · protocol 1",
    latency_ms: 8,
    tailscale_ip: "100.64.12.4",
    hermeticd_version: "0.4.1",
    protocol: 1,
    config_hash: "abc",
    ...over,
  };
}

function dashboard(over: Partial<ProbeDashboard> = {}): ProbeDashboard {
  return {
    outcome: "ok",
    detail: "HTTP 200 from https://atlas.acme.ts.net/",
    latency_ms: 30,
    url: "https://atlas.acme.ts.net/",
    http_status: 200,
    ...over,
  };
}

function desktop(over: Partial<ProbeDesktop> = {}): ProbeDesktop {
  return {
    outcome: "ok",
    detail: "HTTP 200 from https://atlas.acme.ts.net/vnc/",
    latency_ms: 31,
    url: "https://atlas.acme.ts.net/vnc/",
    http_status: 200,
    ...over,
  };
}

function browser(over: Partial<ProbeBrowser> = {}): ProbeBrowser {
  return {
    outcome: "ok",
    detail: "default: hermetic-browser@default active, CDP Chrome/153.0.8010.12",
    latency_ms: 8,
    browsers: [
      {
        name: "default",
        unit_active: true,
        cdp_ok: true,
        cdp_version: "Chrome/153.0.8010.12",
        detail: "hermetic-browser@default active, CDP on 127.0.0.1:9222",
      },
    ],
    ...over,
  };
}

/** The `unreachable` row: heartbeat expected and far too old (§4.3). */
const STALE = { display_status: "unreachable" as const, heartbeat_age_ms: 1_200_000 };

describe("verdictFor — the pure reading of the four layers", () => {
  /**
   * Every rule, in the order they are tried, each with the *minimum* input that
   * should reach it. The order is load-bearing three times over: rule 1 stops a
   * failed EC2 lookup from being read as a missing instance, rule 4 stops
   * row/EC2 drift from being reported as a TLS problem, and rules 2/3 keep
   * `recreate`/`destroy` behind a positive "this instance does not exist".
   */
  const cases: Array<{
    rule: number;
    label: string;
    input: Parameters<typeof verdictFor>[0];
    level: string;
    summary: RegExp;
    hint?: RegExp;
    noHint?: RegExp;
  }> = [
    {
      rule: 1,
      label: "EC2 timed out, so nothing is known about the instance",
      input: {
        name: "atlas",
        row: row(),
        instance: instance({
          outcome: "fail",
          detail: "timed out after 5000ms",
          state: null,
          system_status: null,
          instance_status: null,
        }),
        hermeticd: hermeticd(),
        dashboard: dashboard(),
      },
      level: "warn",
      summary: /EC2 did not answer about the instance: timed out after 5000ms/,
      hint: /probe atlas` again/,
      // The whole point: a slow API call must never propose rebuilding a box.
      noHint: /recreate|destroy/,
    },
    {
      rule: 2,
      label: "a create whose instance EC2 says does not exist",
      input: {
        name: "vireo",
        row: row({ status: "creating", display_status: "creating", health: null }),
        instance: instance({
          outcome: "fail",
          detail: "not found",
          state: null,
          system_status: null,
          instance_status: null,
          not_found: true,
        }),
        hermeticd: hermeticd({ outcome: "skip", tailscale_ip: null }),
        dashboard: dashboard({ outcome: "skip" }),
      },
      level: "bad",
      summary: /create died before the instance came up/,
      hint: /agent destroy vireo/,
      // There is nothing to recreate *into*; the row is what needs clearing.
      noHint: /agent recreate/,
    },
    {
      rule: 3,
      label: "EC2 positively does not have the instance the ready row names",
      input: {
        name: "atlas",
        row: row(STALE),
        instance: instance({
          outcome: "fail",
          detail: "not found",
          state: null,
          system_status: null,
          instance_status: null,
          not_found: true,
        }),
        hermeticd: hermeticd({ outcome: "fail" }),
        dashboard: dashboard({ outcome: "fail" }),
      },
      level: "bad",
      summary: /instance is gone but the row still says ready/,
      hint: /agent recreate atlas/,
    },
    {
      rule: 3,
      label: "the instance is terminated and the row says ready",
      input: {
        name: "atlas",
        row: row(STALE),
        instance: instance({ state: "terminated", system_status: null, instance_status: null }),
        hermeticd: hermeticd({ outcome: "fail" }),
        dashboard: dashboard({ outcome: "fail" }),
      },
      level: "bad",
      summary: /instance is gone/,
      hint: /agent destroy atlas/,
    },
    {
      rule: 4,
      label: "a stopped row over a running, billing instance",
      input: {
        name: "juniper",
        row: row({
          status: "stopped",
          display_status: "stopped",
          last_heartbeat: null,
          heartbeat_age_ms: null,
          health: null,
        }),
        instance: instance(),
        hermeticd: hermeticd(),
        // The reviewer's case: the dashboard is also down, and rule 14 would
        // have answered "enable HTTPS certificates" to a box nobody is watching.
        dashboard: dashboard({ outcome: "fail", detail: "TLS handshake failed" }),
      },
      level: "bad",
      summary: /the row says stopped but EC2 says the instance is running/,
      hint: /hermetic agent stop juniper/,
      noHint: /HTTPS Certificates/,
    },
    {
      rule: 4,
      label: "a stopped row whose instance is terminated — `agent start` cannot work",
      input: {
        name: "juniper",
        row: row({ status: "stopped", display_status: "stopped", health: null }),
        instance: instance({ state: "terminated", system_status: null, instance_status: null }),
        hermeticd: hermeticd({ outcome: "skip", tailscale_ip: null }),
        dashboard: dashboard({ outcome: "skip" }),
      },
      level: "bad",
      summary: /the row says stopped but EC2 says the instance is terminated/,
      hint: /`hermetic agent start juniper` cannot work/,
    },
    {
      rule: 5,
      label: "someone stopped the box outside hermetic",
      input: {
        name: "atlas",
        row: row(STALE),
        instance: instance({ state: "stopped", system_status: null, instance_status: null }),
        hermeticd: hermeticd({ outcome: "fail" }),
        dashboard: dashboard({ outcome: "fail" }),
      },
      level: "bad",
      summary: /stopped outside hermetic/,
      hint: /agent start atlas/,
    },
    {
      rule: 6,
      label: "the instance is still pending",
      input: {
        name: "atlas",
        row: row({ status: "bootstrapping", display_status: "bootstrapping" }),
        instance: instance({ state: "pending", system_status: null, instance_status: null }),
        hermeticd: hermeticd({ outcome: "skip" }),
        dashboard: dashboard({ outcome: "skip" }),
      },
      level: "warn",
      summary: /still booting/,
      hint: /--console/,
    },
    {
      rule: 7,
      label: "EC2's own status checks are impaired",
      input: {
        name: "atlas",
        row: row(STALE),
        instance: instance({ instance_status: "impaired" }),
        hermeticd: hermeticd({ outcome: "fail" }),
        dashboard: dashboard({ outcome: "fail" }),
      },
      level: "bad",
      summary: /status checks are failing/,
      hint: /agent reboot atlas/,
    },
    {
      rule: 8,
      label: "an error row names the stage that failed",
      input: {
        name: "heron",
        row: row({
          status: "error",
          display_status: "error",
          health: { hermes: false, tailscale: true, disk: true },
          bootstrap: {
            hermeticd_version: "0.4.0",
            started_at: AT,
            updated_at: AT,
            stages: [
              { id: "01-tailscale", status: "ok", attempt: 1 },
              {
                id: "02-data-volume",
                status: "failed",
                attempt: 1,
                exit_code: 100,
                message: "device /dev/nvme1n1 has an unknown signature",
              },
            ],
          },
        }),
        instance: instance(),
        hermeticd: hermeticd(),
        // Down, and rule 14 must not claim that is the story on an error row.
        dashboard: dashboard({ outcome: "fail", detail: "TLS handshake failed" }),
      },
      level: "warn",
      summary: /bootstrap stage 02-data-volume failed: device \/dev\/nvme1n1/,
      hint: /agent rerun heron/,
      noHint: /HTTPS Certificates/,
    },
    {
      rule: 8,
      label: "an error row with no bootstrap block still says what it is",
      input: {
        name: "heron",
        row: row({ status: "error", display_status: "error", health: null }),
        instance: instance(),
        hermeticd: hermeticd(),
        dashboard: dashboard(),
      },
      level: "warn",
      summary: /the row is in error: a bootstrap stage failed/,
      hint: /agent history heron/,
    },
    {
      rule: 9,
      label: "a create with a running instance is in progress, or died after launch",
      input: {
        name: "vireo",
        row: row({ status: "creating", display_status: "creating", health: null }),
        instance: instance(),
        hermeticd: hermeticd({ outcome: "skip", tailscale_ip: null }),
        dashboard: dashboard({ outcome: "skip" }),
      },
      level: "warn",
      summary: /create is still in progress, or died after the instance launched/,
      hint: /hermetic runs/,
    },
    {
      rule: 9,
      label: "a create that has not launched anything yet",
      input: {
        name: "vireo",
        row: row({ status: "creating", display_status: "creating", health: null }),
        instance: instance({
          outcome: "skip",
          detail: "the row has no instance",
          instance_id: null,
          state: null,
          system_status: null,
          instance_status: null,
        }),
        hermeticd: hermeticd({ outcome: "skip", tailscale_ip: null }),
        dashboard: dashboard({ outcome: "skip" }),
      },
      level: "warn",
      summary: /no instance has been launched yet/,
      hint: /hermetic runs/,
    },
    {
      rule: 10,
      label: "hermeticd answers but the heartbeat is stale — the write path is broken",
      input: {
        name: "atlas",
        row: row(STALE),
        instance: instance(),
        hermeticd: hermeticd(),
        dashboard: dashboard(),
      },
      level: "bad",
      summary: /heartbeat is not reaching DynamoDB/,
      hint: /--unit hermeticd/,
    },
    {
      rule: 11,
      label: "bootstrapping with no tailscale address yet",
      input: {
        name: "atlas",
        row: row({ status: "bootstrapping", display_status: "bootstrapping" }),
        instance: instance(),
        hermeticd: hermeticd({ outcome: "skip", tailscale_ip: null }),
        dashboard: dashboard({ outcome: "skip" }),
      },
      level: "warn",
      summary: /tailscale has not come up yet/,
      hint: /--console/,
    },
    {
      rule: 12,
      label: "the box is up and completely silent",
      input: {
        name: "atlas",
        row: row(STALE),
        instance: instance(),
        hermeticd: hermeticd({ outcome: "fail", detail: "did not answer" }),
        dashboard: dashboard({ outcome: "fail" }),
      },
      level: "bad",
      summary: /not answering and has stopped heartbeating/,
      hint: /hermetic ssh atlas/,
    },
    {
      rule: 13,
      label: "heartbeats land but this laptop cannot reach the box",
      input: {
        name: "atlas",
        row: row(),
        instance: instance(),
        hermeticd: hermeticd({ outcome: "fail", detail: "connection refused" }),
        dashboard: dashboard({ outcome: "fail" }),
      },
      level: "warn",
      summary: /this laptop cannot reach it over the tailnet/,
      hint: /tailscale status/,
    },
    {
      rule: 14,
      label: "hermeticd answers but nothing serves HTTPS",
      input: {
        name: "atlas",
        row: row(),
        instance: instance(),
        hermeticd: hermeticd(),
        dashboard: dashboard({ outcome: "fail", detail: "TLS handshake failed", http_status: null }),
      },
      level: "warn",
      summary: /dashboard is not reachable over HTTPS/,
      hint: /HTTPS Certificates/,
    },
    {
      rule: 15,
      label: "every layer answers and the box reports a failing check",
      input: {
        name: "atlas",
        row: row({ health: { hermes: false, tailscale: true, disk: true } }),
        instance: instance(),
        hermeticd: hermeticd(),
        dashboard: dashboard(),
      },
      level: "warn",
      summary: /failing checks: hermes/,
      hint: /agent status atlas/,
    },
    {
      rule: 15,
      label: "the box's own dashboard check is the only one failing",
      input: {
        name: "atlas",
        row: row({ health: { hermes: true, tailscale: true, disk: true, dashboard: false } }),
        instance: instance(),
        hermeticd: hermeticd(),
        dashboard: dashboard(),
      },
      level: "warn",
      // Hermes binds loopback and the loopback proxy in front of it needs no
      // login, so `dashboard` down with `hermes` up is the tailnet path and
      // nothing else. There is no slot to push and none to read.
      summary: /tailnet path rather than Hermes/,
      hint: /HTTPS Certificates|logs atlas --unit tailscaled/,
      noHint: /secrets push _fleet|agent recreate/,
    },
    {
      rule: 15,
      label: "the dashboard down alongside something else stays a plain list",
      input: {
        name: "atlas",
        row: row({ health: { hermes: false, tailscale: true, disk: true, dashboard: false } }),
        instance: instance(),
        hermeticd: hermeticd(),
        dashboard: dashboard(),
      },
      level: "warn",
      summary: /failing checks: hermes, dashboard/,
      hint: /agent status atlas/,
    },
    {
      rule: 16,
      label: "a stopped row whose instance really is stopped",
      input: {
        name: "juniper",
        row: row({
          status: "stopped",
          display_status: "stopped",
          last_heartbeat: null,
          heartbeat_age_ms: null,
          health: { hermes: false, tailscale: false, disk: true },
        }),
        instance: instance({ state: "stopped", system_status: null, instance_status: null }),
        hermeticd: hermeticd({ outcome: "skip", tailscale_ip: null }),
        dashboard: dashboard({ outcome: "fail" }),
      },
      level: "ok",
      summary: /stopped, and the instance is stopped/,
    },
    {
      rule: 17,
      label: "everything answers and the row is healthy",
      input: {
        name: "atlas",
        row: row(),
        instance: instance(),
        hermeticd: hermeticd(),
        dashboard: dashboard(),
      },
      level: "ok",
      summary: /^all layers answer$/,
    },
    {
      rule: 17,
      label: "a skipped layer is not counted as an answer",
      input: {
        name: "atlas",
        row: row(),
        instance: instance(),
        hermeticd: hermeticd(),
        dashboard: dashboard({ outcome: "skip", detail: "tailnet not recorded in config" }),
      },
      level: "ok",
      summary: /^every layer that could be asked answers$/,
    },
    {
      rule: 18,
      label: "a shape no rule names",
      input: {
        name: "atlas",
        // Running, heartbeating, healthy — and yet no tailnet address on the
        // row at all, which none of the rules above has a reading for.
        row: row(),
        instance: instance({ system_status: "insufficient-data" }),
        hermeticd: hermeticd({ outcome: "skip", detail: "no route to host", tailscale_ip: null }),
        dashboard: dashboard({ outcome: "skip", detail: "TLS handshake failed" }),
      },
      level: "unknown",
      summary: /hermeticd: no route to host/,
      hint: /hermetic doctor/,
    },
  ];

  for (const c of cases) {
    test(`rule ${c.rule}: ${c.label}`, () => {
      const v = verdictFor(c.input);
      expect(v.level).toBe(c.level as typeof v.level);
      expect(v.summary).toMatch(c.summary);
      if (c.hint) expect(v.hints.join("\n")).toMatch(c.hint);
      if (c.noHint) expect(v.hints.join("\n")).not.toMatch(c.noHint);
    });
  }

  /**
   * The invariant behind rules 1-3, stated once rather than per case: the two
   * commands that cost an operator their box only ever follow a *positive*
   * statement from EC2 that the instance is gone or going.
   */
  test("destructive hints never follow a merely failed EC2 lookup", () => {
    for (const status of ["ready", "degraded", "bootstrapping", "stopped", "destroying"] as const) {
      const v = verdictFor({
        name: "atlas",
        row: row({ status, display_status: status, health: null }),
        instance: instance({
          outcome: "fail",
          detail: "RequestLimitExceeded",
          state: null,
          system_status: null,
          instance_status: null,
          not_found: false,
        }),
        hermeticd: hermeticd({ outcome: "fail" }),
        dashboard: dashboard({ outcome: "fail" }),
      });
      expect(v.hints.join("\n")).not.toMatch(/agent recreate|agent destroy/);
    }
  });

  /**
   * `absentInstance` must not read a failed lookup as absence: "we could not
   * ask" and "there is nothing there" are the same shape and opposite
   * meanings, and a destroyed row over an unreadable EC2 was being reported as
   * consistent when nothing had actually been checked.
   */
  test("a destroyed row over an unreadable EC2 is not blessed as consistent", () => {
    const v = verdictFor({
      name: "oriole",
      row: row({ status: "destroyed", display_status: "destroyed", health: null }),
      instance: instance({
        outcome: "fail",
        detail: "RequestLimitExceeded",
        state: null,
        system_status: null,
        instance_status: null,
        not_found: false,
      }),
      hermeticd: hermeticd({ outcome: "skip", tailscale_ip: null }),
      dashboard: dashboard({ outcome: "skip" }),
    });
    expect(v.level).toBe("warn");
    expect(v.summary).toMatch(/EC2 did not answer/);
  });

  /** A destroyed row EC2 confirms is gone *is* consistent, and says so. */
  test("a destroyed row whose instance EC2 confirms is gone is ok", () => {
    const v = verdictFor({
      name: "oriole",
      row: row({ status: "destroyed", display_status: "destroyed", health: null }),
      instance: instance({
        outcome: "fail",
        detail: "not found",
        state: null,
        system_status: null,
        instance_status: null,
        not_found: true,
      }),
      hermeticd: hermeticd({ outcome: "skip", tailscale_ip: null }),
      dashboard: dashboard({ outcome: "skip" }),
    });
    expect(v.level).toBe("ok");
    expect(v.summary).toMatch(/destroyed, and the instance is gone/);
  });

  /**
   * `health` on a stopped row is the *last* heartbeat's snapshot, which of
   * course says hermes and tailscale are down. Rule 15 must not fire on it, or
   * every stopped agent is permanently amber for having stopped.
   */
  test("a stopped agent's stale health checks do not raise a warning", () => {
    const v = verdictFor({
      name: "juniper",
      row: row({
        status: "stopped",
        display_status: "stopped",
        health: { hermes: false, tailscale: false, disk: true },
      }),
      instance: instance({ state: "stopped", system_status: null, instance_status: null }),
      hermeticd: hermeticd({ outcome: "skip" }),
      dashboard: dashboard({ outcome: "skip" }),
    });
    expect(v.level).toBe("ok");
  });

  /** A held lock explains a lot of apparent silence, so it rides on any verdict. */
  test("a held lock is appended to the hints of whatever the verdict was", () => {
    const v = verdictFor({
      name: "atlas",
      row: row({ lock: { owner: "arn:aws:sts::1:assumed-role/op", expires: AT } }),
      instance: instance(),
      hermeticd: hermeticd(),
      dashboard: dashboard(),
    });
    expect(v.level).toBe("ok");
    expect(v.hints.at(-1)).toContain("holds the lock until");
  });

  test("the verdict is a total function: no input produces an empty summary", () => {
    for (const c of cases) expect(verdictFor(c.input).summary.length).toBeGreaterThan(0);
  });
});

function seeded() {
  const backend = seedFixtureFleet(new MemoryBackend());
  return { backend, hermetic: testHermetic({ backend, config: FIXTURE_CONFIG }) };
}

describe("agents.probe over a backend", () => {
  test("a healthy agent answers on every layer", async () => {
    const { backend, hermetic } = seeded();
    const report = await hermetic.agents.probe("atlas");

    expect(report.name).toBe("atlas");
    expect(report.instance.outcome).toBe("ok");
    expect(report.instance.state).toBe("running");
    expect(report.instance.system_status).toBe("ok");
    expect(report.hermeticd.outcome).toBe("ok");
    expect(report.hermeticd.protocol).toBe(1);
    expect(report.dashboard.outcome).toBe("ok");
    expect(report.verdict.level).toBe("ok");
    // A probe is a read (§9): nothing about the fleet moved.
    expect(backend.mutations).toEqual([]);
  });

  /** Rule 5, end to end: a `ready` row over a box someone stopped in the console. */
  test("a stopped instance under a ready row is rule 5, with `agent start` as the hint", async () => {
    const { backend, hermetic } = seeded();
    const atlas = backend.agents.get("atlas")!;
    backend.instances.set(atlas.instance_id!, {
      instance_id: atlas.instance_id!,
      state: "stopped",
      public_ip: null,
      agent: "atlas",
      fleet_id: FIXTURE_CONFIG.fleet_id,
    });

    const report = await hermetic.agents.probe("atlas");
    expect(report.instance.state).toBe("stopped");
    // EC2 has no status-check opinion about a box that is off.
    expect(report.instance.system_status).toBeNull();
    expect(report.verdict.level).toBe("bad");
    expect(report.verdict.hints).toContain("hermetic agent start atlas");
  });

  /**
   * Rule 8: the fixture's `lumen` is twenty minutes stale, so `ps` calls it
   * `unreachable` and the RPC fake refuses — the whole point of the fixture's
   * two halves agreeing.
   */
  test("a stale row whose hermeticd refuses is rule 12, and the failure is data", async () => {
    const { hermetic } = seeded();
    const report = await hermetic.agents.probe("lumen");

    expect(report.row.display_status).toBe("unreachable");
    expect(report.instance.outcome).toBe("ok");
    expect(report.hermeticd.outcome).toBe("fail");
    expect(report.hermeticd.detail).toContain("did not answer");
    expect(report.verdict.level).toBe("bad");
    expect(report.verdict.hints).toContain("hermetic ssh lumen");
  });

  /**
   * The property the whole module rests on: a layer that never comes back must
   * become a `fail` on the report, not a probe that hangs or rejects. A fetch
   * that never resolves and a 20 ms budget is the cheapest way to say so.
   */
  test("a layer that never answers times out into `fail`, not a rejection", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const hermetic = testHermetic({
      backend,
      config: FIXTURE_CONFIG,
      probe: {
        timeoutMs: 20,
        fetch: (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            const fail = (): void => reject(new Error("aborted"));
            if (init?.signal?.aborted) return fail();
            init?.signal?.addEventListener("abort", fail);
          }),
      },
    });

    const report = await hermetic.agents.probe("atlas");
    expect(report.dashboard.outcome).toBe("fail");
    expect(report.dashboard.detail).toContain("timed out after 20ms");
    expect(report.dashboard.latency_ms).not.toBeNull();
    // The other two layers still answered: one dead layer is not four.
    expect(report.instance.outcome).toBe("ok");
    expect(report.hermeticd.outcome).toBe("ok");
  });

  /**
   * The end of the wire for the dashboard-only rule. Nothing about it is a
   * secret any more: the dashboard needs no login, so the verdict makes no SSM
   * read and the advice is the tailnet path in every case.
   */
  test("the dashboard-only verdict points at the tailnet, not at a secret", async () => {
    const { backend, hermetic } = seeded();
    const atlas = backend.agents.get("atlas")!;
    backend.agents.set("atlas", {
      ...atlas,
      health: { hermes: true, tailscale: true, disk: true, dashboard: false },
    });

    const report = await hermetic.agents.probe("atlas");
    expect(report.verdict.summary).toContain("tailnet path rather than Hermes");
    expect(report.verdict.hints.join("\n")).toContain("HTTPS Certificates");
    expect(report.verdict.hints.join("\n")).not.toContain("secrets push _fleet");
  });

  /** No instance on the row at all — `skip`, which is not the same as `fail`. */
  test("a destroyed row skips the instance and hermeticd layers", async () => {
    const { hermetic } = seeded();
    const report = await hermetic.agents.probe("oriole");
    expect(report.instance.outcome).toBe("skip");
    expect(report.instance.detail).toBe("the row has no instance");
    expect(report.hermeticd.outcome).toBe("skip");
    expect(report.verdict.level).toBe("ok");
    expect(report.verdict.summary).toContain("destroyed");
  });

  test("an unknown agent is NOT_FOUND — the one thing a probe still throws", async () => {
    const { hermetic } = seeded();
    let code = "";
    try {
      await hermetic.agents.probe("nosuchagent");
    } catch (e) {
      code = (e as HermeticError).code;
    }
    expect(code).toBe("NOT_FOUND");
  });

  test("a reserved name is refused before any layer runs", async () => {
    const { hermetic } = seeded();
    let code = "";
    try {
      await hermetic.agents.probe("_fleet");
    } catch (e) {
      code = (e as HermeticError).code;
    }
    expect(code).toBe("NAME_INVALID");
  });

  /**
   * The dashboard layer must not invent a URL when the fleet does not record a
   * tailnet: `skip` says "not asked", which is honest, where `fail` would read
   * as "the agent's dashboard is down".
   */
  test("a fleet with no tailnet makes the dashboard layer skip, not fail", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    backend.fleetItem = { ...backend.fleetItem!, tailnet: "" };
    const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG });

    const report = await hermetic.agents.probe("atlas");
    expect(report.dashboard.outcome).toBe("skip");
    expect(report.dashboard.detail).toBe("tailnet not recorded in config");
    expect(report.dashboard.url).toBeNull();
  });

  /**
   * The bound that the timeout signal alone could not provide. `ComputeApi`
   * takes no `AbortSignal`, so an EC2 call that never settles ignores the
   * deadline entirely — `layer` has to race it. Before this, a hanging
   * `describeInstance` with `timeoutMs: 20` left the probe still pending
   * seconds later.
   */
  test("an EC2 call that ignores its signal is still bounded by the deadline", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    // Deliberately signal-blind: it never resolves and never listens.
    backend.compute.describeInstance = () => new Promise<never>(() => {});
    const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG, probe: { timeoutMs: 20 } });

    const started = Date.now();
    const report = await hermetic.agents.probe("atlas");
    const elapsed = Date.now() - started;

    expect(report.instance.outcome).toBe("fail");
    expect(report.instance.detail).toBe("timed out after 20ms");
    // The bound, not merely the outcome: a signal nobody reads must still stop it.
    expect(elapsed).toBeLessThan(200);
    // And the reading of a lookup that failed is "we do not know", never
    // "your instance is gone" — no destructive hint on a timeout.
    expect(report.instance.not_found).toBe(false);
    expect(report.verdict.level).toBe("warn");
    expect(report.verdict.hints.join("\n")).not.toMatch(/agent recreate|agent destroy/);
  });

  /** The same bound for the DynamoDB read that resolves the dashboard URL. */
  test("a hung fleet read cannot make the dashboard layer unbounded", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    backend.store.fleet.get = () => new Promise<never>(() => {});
    const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG, probe: { timeoutMs: 20 } });

    const started = Date.now();
    const report = await hermetic.agents.probe("atlas");
    expect(Date.now() - started).toBeLessThan(200);
    expect(report.dashboard.outcome).toBe("fail");
    expect(report.dashboard.detail).toBe("timed out after 20ms");
  });

  /**
   * An operator's Ctrl-C is not a finding about the agent. Three `fail` layers
   * and a confident verdict would be a diagnosis of a question that was never
   * asked, so the probe rejects instead (§3.2 rule 2).
   */
  test("a caller abort rejects with ABORTED rather than reporting three dead layers", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    backend.compute.describeInstance = () => new Promise<never>(() => {});
    const hermetic = testHermetic({
      backend,
      config: FIXTURE_CONFIG,
      // Far longer than the test: only the caller's abort can end this.
      probe: { timeoutMs: 60_000 },
    });

    const controller = new AbortController();
    const run = hermetic.agents.probe("atlas", { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);

    let code = "";
    try {
      await run;
    } catch (e) {
      code = (e as HermeticError).code;
    }
    expect(code).toBe("ABORTED");
  });

  test("a signal that is already aborted is refused before any layer runs", async () => {
    const { hermetic } = seeded();
    let code = "";
    try {
      await hermetic.agents.probe("atlas", { signal: AbortSignal.abort() });
    } catch (e) {
      code = (e as HermeticError).code;
    }
    expect(code).toBe("ABORTED");
  });

  test("the report parses against its own schema", async () => {
    const { hermetic } = seeded();
    const report: ProbeReport = await hermetic.agents.probe("atlas");
    const { ProbeReport: Schema } = await import("../src/schema/index.ts");
    expect(() => Schema.parse(report)).not.toThrow();
  });
});

/**
 * §7.3: the desktop an operator watches the agent's browser in,
 * and the browser stack behind it.
 *
 * The property every test here is really about is the last one: neither layer
 * reaches `verdictFor`. A browser that is down is something to *report* — it is
 * not a sick agent, and letting it colour the verdict would make `probe` the
 * command that calls a perfectly healthy fleet bad.
 */
describe("the desktop and browser layers", () => {
  /** hermeticd's `/healthz`, with whatever this test wants it to say. */
  function health(backend: MemoryBackend, over: Partial<RpcHealth>): void {
    const real = backend.rpc.health.bind(backend.rpc);
    backend.rpc.health = async (name: string) => ({ ...(await real(name)), ...over });
  }

  test("a browser agent answers on both layers", async () => {
    const { hermetic } = seeded();
    const report = await hermetic.agents.probe("atlas");

    expect(report.desktop.outcome).toBe("ok");
    // The trailing slash is the whole point of `agentDesktopUrl`: without it
    // the client's relative links resolve at the site root.
    expect(report.desktop.url).toMatch(/\/vnc\/$/);
    expect(report.desktop.http_status).toBe(200);
    expect(report.browser.outcome).toBe("ok");
    expect(report.browser.detail).toBe(
      "default: hermetic-browser@default active, CDP Chrome/153.0.8010.12",
    );
    expect(report.browser.browsers.map((b) => b.name)).toEqual(["default"]);
    expect(report.verdict.level).toBe("ok");
  });

  /**
   * The field is optional because a hermeticd from before it simply does not
   * send it. That is "not asked" and it has a fix — reporting it as "no
   * browsers are running" would send an operator to debug a healthy unit.
   */
  test("a hermeticd that reports no browsers field skips, and names the fix", async () => {
    const { backend, hermetic } = seeded();
    health(backend, { browsers: undefined });

    const report = await hermetic.agents.probe("atlas");
    expect(report.browser.outcome).toBe("skip");
    expect(report.browser.detail).toContain("older release");
    expect(report.browser.detail).toContain("artifacts push");
    // The desktop is reached from the laptop, so it is unaffected by this.
    expect(report.desktop.outcome).toBe("ok");
  });

  /**
   * The other half of that distinction, and the reason it is worth keeping: an
   * empty list is a current hermeticd reading a manifest that lists no
   * browsers. On an agent whose row says browser is on, that is a stale applied
   * configuration — a different fault from an old binary, with a different fix.
   */
  test("an empty browser list on a browser agent fails, naming the rerun", async () => {
    const { backend, hermetic } = seeded();
    health(backend, { browsers: [] });

    const report = await hermetic.agents.probe("atlas");
    expect(report.browser.outcome).toBe("fail");
    expect(report.browser.detail).toBe(
      "hermeticd reports no browser identities although this agent has browser on — " +
        "its applied config predates the browser stack; run agent rerun",
    );
    expect(report.browser.browsers).toEqual([]);
    // Still data, not a verdict: the agent itself is reachable and healthy.
    expect(report.verdict.level).toBe("ok");
    expect(report.verdict.summary).not.toContain("browser");
  });

  test("a browser whose unit is down fails the layer, naming it — and not the verdict", async () => {
    const { backend, hermetic } = seeded();
    health(backend, {
      browsers: [
        {
          name: "default",
          unit_active: false,
          cdp_ok: false,
          cdp_version: null,
          detail: "hermetic-browser@default is activating (auto-restart)",
        },
      ],
    });

    const report = await hermetic.agents.probe("atlas");
    expect(report.browser.outcome).toBe("fail");
    expect(report.browser.detail).toContain("default:");
    expect(report.browser.detail).toContain("auto-restart");
    // The layer is data. The agent is reachable and its row is true, so the
    // reading of the probe is unchanged.
    expect(report.verdict.level).toBe("ok");
    expect(report.verdict.summary).not.toContain("browser");
  });

  /**
   * The desktop layer's acceptance rule is narrower than the dashboard's: the
   * question is whether a noVNC *client* is published there, so a 404 is a
   * failure with something to do about it rather than proof the node answers.
   */
  test("a 404 at /vnc/ fails the desktop layer with the re-apply hint, and not the verdict", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const hermetic = testHermetic({
      backend,
      config: FIXTURE_CONFIG,
      probe: {
        fetch: async (url: string) =>
          new Response("", { status: new URL(url).pathname === "/" ? 200 : 404 }),
      },
    });

    const report = await hermetic.agents.probe("atlas");
    expect(report.dashboard.outcome).toBe("ok");
    expect(report.desktop.outcome).toBe("fail");
    expect(report.desktop.http_status).toBe(404);
    expect(report.desktop.detail).toContain("re-apply this agent");
    expect(report.verdict.level).toBe("ok");
  });

  /** A server-side redirect to the client page is a published desktop too. */
  test("a redirect at /vnc/ passes the desktop layer", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const hermetic = testHermetic({
      backend,
      config: FIXTURE_CONFIG,
      probe: {
        fetch: async (url: string) =>
          new Response("", { status: new URL(url).pathname === "/" ? 200 : 302 }),
      },
    });

    const report = await hermetic.agents.probe("atlas");
    expect(report.desktop.outcome).toBe("ok");
    expect(report.desktop.http_status).toBe(302);
  });

  /**
   * The box is asked once. `/healthz` carries both answers, so a second call
   * would be a network round trip bought to re-read a field we already have.
   */
  test("both layers come from one /healthz", async () => {
    const { backend, hermetic } = seeded();
    let calls = 0;
    const real = backend.rpc.health.bind(backend.rpc);
    backend.rpc.health = async (name: string) => {
      calls += 1;
      return real(name);
    };

    const report = await hermetic.agents.probe("atlas");
    expect(calls).toBe(1);
    expect(report.hermeticd.outcome).toBe("ok");
    expect(report.browser.outcome).toBe("ok");
  });

  /** A silent hermeticd is not a statement about the browsers it did not list. */
  test("a hermeticd that does not answer leaves the browser layer skipped", async () => {
    const { hermetic } = seeded();
    const report = await hermetic.agents.probe("lumen");
    expect(report.hermeticd.outcome).toBe("fail");
    expect(report.browser.outcome).toBe("skip");
    expect(report.browser.detail).toContain("browsers were not asked");
  });

  test("a report carrying both new layers parses against the schema", async () => {
    const { hermetic } = seeded();
    const report = await hermetic.agents.probe("atlas");
    const { ProbeReport: Schema } = await import("../src/schema/index.ts");
    expect(() =>
      Schema.parse({ ...report, desktop: desktop({ outcome: "fail" }), browser: browser() }),
    ).not.toThrow();
  });
});

/**
 * §6.4/§6.5: a `recreate` cannot delete the old tailnet device, so the new node
 * joins as `<name>-2` and MagicDNS keeps `<name>` pointed at the terminated
 * box. Two things follow, and both are tested here: the probe must ask the name
 * the node actually holds (otherwise it diagnoses the corpse), and it must say
 * which device to go and delete (otherwise nobody ever does).
 */
describe("a node that did not get its canonical name", () => {
  test("verdictFor appends the stale-device note and lifts an ok to warn", () => {
    const clean = verdictFor({
      name: "atlas",
      row: row(),
      instance: instance(),
      hermeticd: hermeticd(),
      dashboard: dashboard(),
    });
    expect(clean.level).toBe("ok");

    const v = verdictFor({
      name: "atlas",
      row: row(),
      instance: instance(),
      hermeticd: hermeticd(),
      dashboard: dashboard(),
      hostname_mismatch: { real: "atlas-2.acme.ts.net", canonical: "atlas.acme.ts.net", kind: "stale" },
    });
    expect(v.level).toBe("warn");
    expect(v.hints).toContain(
      "the node is atlas-2.acme.ts.net, not atlas.acme.ts.net: a stale device holds the name; delete it in the Tailscale admin console (Machines → atlas)",
    );
  });

  /** Never a downgrade: a naming problem cannot make a broken agent look better. */
  test("a bad verdict stays bad and still carries the note", () => {
    const v = verdictFor({
      name: "atlas",
      row: row({ status: "ready", ...STALE }),
      instance: instance({ state: "stopped", detail: "stopped" }),
      hermeticd: hermeticd({ outcome: "fail", detail: "connection refused" }),
      dashboard: dashboard({ outcome: "fail", detail: "TLS handshake failed" }),
      hostname_mismatch: { real: "atlas-2.acme.ts.net", canonical: "atlas.acme.ts.net", kind: "stale" },
    });
    expect(v.level).toBe("bad");
    expect(v.hints.join("\n")).toContain("a stale device holds the name");
  });

  test("no mismatch, no note", () => {
    const v = verdictFor({
      name: "atlas",
      row: row(),
      instance: instance(),
      hermeticd: hermeticd(),
      dashboard: dashboard(),
      hostname_mismatch: null,
    });
    expect(v.level).toBe("ok");
    expect(v.hints.join("\n")).not.toContain("stale device");
  });

  /**
   * A `legacy` node — one wearing a spelling hermetic itself used to hand out —
   * is said, and does not warn. On the day a fleet moves to v4 every box in it
   * is legacy, and a probe that went amber fleet-wide for a state that is
   * expected and correct would train an operator to ignore the colour.
   */
  test("a legacy name is explained without lifting an ok to warn", () => {
    const v = verdictFor({
      name: "atlas",
      row: row(),
      instance: instance(),
      hermeticd: hermeticd(),
      dashboard: dashboard(),
      hostname_mismatch: {
        real: "main-atlas.acme.ts.net",
        canonical: "k7m2x9qa-atlas.acme.ts.net",
        kind: "legacy",
      },
    });
    expect(v.level).toBe("ok");
    expect(v.hints.join("\n")).toContain("it is wearing a name hermetic used to hand out");
    expect(v.hints.join("\n")).toContain("hermetic agent recreate atlas");
    // The two sentences that belong to a corpse, and to nothing else.
    expect(v.hints.join("\n")).not.toContain("stale device");
    expect(v.hints.join("\n")).not.toContain("Tailscale admin console");
  });

  test("the laptop-side layers fetch the name the node holds, not the canonical one", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const atlas = backend.agents.get("atlas")!;
    backend.agents.set("atlas", { ...atlas, tailscale_dns_name: "atlas-2.hermetic.ts.net" });
    const asked: string[] = [];
    const hermetic = testHermetic({
      backend,
      config: FIXTURE_CONFIG,
      probe: {
        fetch: async (input: string | URL | Request) => {
          asked.push(String(input));
          return new Response("", { status: 200 });
        },
      },
    });

    const report = await hermetic.agents.probe("atlas");
    // Both of them: a desktop URL built from the canonical name would open a
    // VNC session onto the corpse for exactly the same reason.
    expect(asked.sort()).toEqual([
      "https://atlas-2.hermetic.ts.net/",
      "https://atlas-2.hermetic.ts.net/vnc/",
    ]);
    expect(report.dashboard.url).toBe("https://atlas-2.hermetic.ts.net/");
    expect(report.desktop.url).toBe("https://atlas-2.hermetic.ts.net/vnc/");
    expect(report.verdict.hints.join("\n")).toContain("Machines → atlas");
  });

  /**
   * The comparison needs the tailnet, and the tailnet comes from `_fleet`. A
   * fleet item this caller cannot read means the canonical spelling is unknown,
   * and an unknown one must not be guessed at — a note naming the wrong device
   * is worse than no note.
   */
  test("an unreadable fleet item makes no claim about the name", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const atlas = backend.agents.get("atlas")!;
    backend.agents.set("atlas", { ...atlas, tailscale_dns_name: "atlas-2.hermetic.ts.net" });
    backend.fleetItem = { ...backend.fleetItem!, tailnet: "" };
    const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG });

    const report = await hermetic.agents.probe("atlas");
    expect(report.dashboard.outcome).toBe("skip");
    expect(report.verdict.hints.join("\n")).not.toContain("stale device");
  });
});
