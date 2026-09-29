import { describe, expect, test } from "bun:test";
import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  HERMES_DASHBOARD_PORT,
  HERMES_DASHBOARD_UNIT,
  HERMES_GATEWAY_UNIT,
} from "@hermetic/core/schema";
import type { Agent, UpdateRequest } from "@hermetic/core/schema";
import { makeAws } from "../src/aws.ts";
import { runningBinarySha256 } from "../src/main.ts";
import { HERMETICD_PATH } from "../src/stages.ts";
import {
  BASELINE_PATH,
  BASELINE_WRITE_EVERY,
  DEGRADE_AFTER_TICKS,
  GATEWAY_STATE_PATH,
  GATEWAY_STATE_STALE_MS,
  HERMES_HEALTH_URL,
  RECOVER_AFTER_TICKS,
  HERMES_UNITS,
  ROOT_MOUNT,
  UNIT_SHOW_PROPERTIES,
  cpuPercent,
  dashboardUrl,
  makeHeartbeat,
  parseBaseline,
  parseGatewayState,
  parseMeminfo,
  parseProcStat,
  parseUnitState,
  shortReason,
} from "../src/heartbeat.ts";
import { FakeHost } from "./fake-host.ts";
import { RecordingSink, TEST_NAME, conditionalCheckFailed } from "./fixtures.ts";
import { captureOutput } from "./quiet.ts";

// The commands these tests drive write their progress and log lines to the
// process's own streams; kept out of the run's output (`quiet.ts`).
captureOutput();

const AGENTS = "hermetic-agents";
const EVENTS = "hermetic-events";

/** A status transition, as opposed to a heartbeat (which guards existence only). */
function statusGuarded(update: UpdateCommand): boolean {
  return String(update.input.ConditionExpression ?? "").includes("#status IN");
}

function row(status: Agent["status"]): Record<string, unknown> {
  return { name: TEST_NAME, status, version: 4, config_hash: "abc123def4567890" };
}

interface Harness {
  host: FakeHost;
  ddb: RecordingSink;
  warnings: string[];
  heartbeat: ReturnType<typeof makeHeartbeat>;
  updates: () => UpdateCommand[];
  /** Every request `onUpdateRequest` was called with, in order. */
  requested: UpdateRequest[];
  /** Every URL the fake fetch was asked for, in order. */
  fetched: string[];
  /** The `redirect` mode each `/api/health` probe was made with. */
  hermesRedirect: string[];
}

/**
 * `FakeHost`'s clock, which is what the staleness rule measures a snapshot
 * against — the heartbeat reads `updated_at` out of the file rather than the
 * file's mtime, because that is the field upstream re-stamps on every write
 * (`gateway/status.py:815`).
 */
const FAKE_NOW = new Date("2026-09-01T12:00:00.000Z");

/**
 * `gateway_state.json` as `write_runtime_status` leaves it
 * (`gateway/status.py:793-846`), with `updated_at` placed `ageMs` before the
 * box's clock. The timestamp carries an explicit offset and sub-millisecond
 * digits because `datetime.now(timezone.utc).isoformat()` does
 * (`gateway/status.py:178-179`).
 */
function gatewayStateFile(fields: Record<string, unknown>, ageMs = 0): string {
  const updatedAt = new Date(FAKE_NOW.getTime() - ageMs).toISOString().replace("Z", "000+00:00");
  return JSON.stringify({
    kind: "gateway",
    pid: 4242,
    updated_at: updatedAt,
    platforms: {},
    ...fields,
  });
}

/** What the fake tailnet publishes this node as, trailing dot and all. */
const DNS_NAME = "atlas.example.ts.net.";
const DASHBOARD_URL = "https://atlas.example.ts.net/";
/** Shaped like the real thing: the release, then the commit the build came from. */
const TAILSCALE_VERSION = "1.86.2-t01ab2cd34";

function harness(options: {
  status: Agent["status"];
  hermesHealthy?: boolean;
  /**
   * The status `/api/health` answers with, overriding `hermesHealthy` for the
   * HTTP probe only — so a test can have systemd say "inactive" while Hermes
   * itself answers, and see which of the two the probe believed.
   */
  hermesStatus?: number;
  /**
   * What `/api/health` says its `version` is — the box's own account of which
   * Hermes it is running, which the heartbeat reports as
   * `running_hermes_version`. A string that is not a version, or the key being
   * absent, is a separate case and set with `hermesHealthBody`.
   */
  hermesReports?: string;
  /**
   * A Hermes whose SPA catch-all is mounted: every loopback path *except*
   * `/api/health` answers 200 with `index.html`
   * (`mount_spa`, `hermes_cli/web_server_dashboard.py:93`). This is the box the
   * old `/healthz` probe could not fail on, so a fake that models it is the
   * only way to show that the probe now asks a route Hermes really serves.
   */
  spaCatchAll?: boolean;
  /**
   * `gateway_state.json` as it sits on the box, verbatim — a string, not an
   * object, because half of what this file has to survive is not valid JSON
   * (`COMPAT_MANIFEST.md:3-4`). Absent means the file is not there at all.
   */
  gatewayStateFile?: string;
  /** What `systemctl show` reports for `hermes-dashboard.service`, overriding the default. */
  hermesUnit?: { ActiveState: string; SubState: string };
  /** The same for `hermes-gateway.service`, which defaults to up. */
  gatewayUnit?: { ActiveState: string; SubState: string };
  /**
   * `NRestarts` per tick, consumed in order; the last value repeats. Absent
   * means systemd reports no counter at all, as an older systemd does.
   */
  hermesRestarts?: number[];
  /** The same for the gateway; the tick compares the sum of the two. */
  gatewayRestarts?: number[];
  tailscaleOnline?: boolean;
  /** The status the dashboard URL answers with; `"throw"` is a TLS/connect failure. */
  dashboard?: number | "throw" | "hang";
  /** `tailscale status` reports no MagicDNS name for this node. */
  noDnsName?: boolean;
  /**
   * The MagicDNS name the tailnet actually gave this node, trailing dot and
   * all. Overriding it is how a recreate is modelled: the old device still
   * holds `atlas`, so this one is `atlas-2`.
   */
  dnsName?: string;
  /**
   * What the daemon reports as its own version. `"none"` is the document with
   * no `Version` at all — a Tailscale old enough to omit it, and the shape the
   * row has to read as unknown rather than write as empty. A number stands for
   * the field being some other JSON type than the one it is declared as.
   */
  tailscaleVersion?: string | number | "none";
  dashboardTimeoutMs?: number;
  diskPct?: number;
  /**
   * The root filesystem's fullness, when it differs from `/data`'s.
   * `"unmeasured"` is the box where neither statvfs nor `df` answers for `/` —
   * the shape of an older hermeticd's row, which reports no `root_disk_pct`.
   */
  rootDiskPct?: number | "unmeasured";
  transitionSucceeds?: boolean;
  /** The row has been deleted underneath hermeticd. */
  rowDeleted?: boolean;
  /**
   * The `update_request` the row carries on tick 1, 2, … (§6.6). The last entry
   * stands for every later tick, so `[req]` is "the field is there and stays".
   */
  requests?: ReadonlyArray<UpdateRequest | null>;
  /**
   * A box this harness is not the first process on. Reusing the `FakeHost`
   * keeps its filesystem — which is where the crash-loop baseline lives — while
   * everything else here is built fresh, exactly like a hermeticd restart. Its
   * command stubs are replaced, not appended to, so the *new* process's script
   * is the one that answers.
   */
  host?: FakeHost;
  /** Called after the first heartbeat write that lands; `serve` settles a swap on it. */
  onFirstWrite?: () => void;
}): Harness {
  const host = options.host ?? new FakeHost();
  host.handlers.length = 0;
  const ddb = new RecordingSink();
  const warnings: string[] = [];

  const requested: UpdateRequest[] = [];
  let reads = 0;
  ddb.byCommand.set("GetCommand", () => {
    if (options.rowDeleted) return {};
    const queue = options.requests;
    const request = queue ? queue[Math.min(reads, queue.length - 1)] : null;
    reads += 1;
    return { Item: { ...row(options.status), ...(request ? { update_request: request } : {}) } };
  });
  ddb.byCommand.set("PutCommand", () => ({}));
  ddb.byCommand.set("UpdateCommand", (command) => {
    const input = (command as UpdateCommand).input;
    // A deleted row fails every conditional write, the heartbeat included.
    if (options.rowDeleted) return conditionalCheckFailed();
    const guardsStatus = String(input.ConditionExpression ?? "").includes("#status IN");
    return guardsStatus && options.transitionSucceeds === false ? conditionalCheckFailed() : {};
  });

  /** `NRestarts` for one unit, walking its queue one entry per read; the last repeats. */
  const counter = (queue: number[] | undefined): (() => number | null) => {
    let reads = 0;
    return () => {
      if (!queue || queue.length === 0) return null;
      const value = queue[Math.min(reads, queue.length - 1)] ?? null;
      reads += 1;
      return value;
    };
  };
  const dashboardRestarts = counter(options.hermesRestarts);
  const gatewayRestarts = counter(options.gatewayRestarts);

  const pct = options.diskPct ?? 20;
  const statfsAt = (full: number) => ({ blockSize: 4096, blocks: 1000, available: 1000 - full * 10 });
  host.statfsResult = statfsAt(pct);
  if (options.rootDiskPct !== undefined) {
    host.statfsByPath.set(
      ROOT_MOUNT,
      options.rootDiskPct === "unmeasured" ? null : statfsAt(options.rootDiskPct),
    );
  }
  if (options.gatewayStateFile !== undefined) {
    host.seed(GATEWAY_STATE_PATH, options.gatewayStateFile);
  }
  host.seed("/proc/stat", "cpu  100 0 100 700 100 0 0 0 0 0\n");
  host.seed("/proc/meminfo", "MemTotal:       1000 kB\nMemAvailable:    250 kB\n");
  host.handlers.push((argv) => {
    if (argv[0] === "tailscale" && argv[1] === "status") {
      return options.tailscaleOnline === false
        ? { code: 1, stdout: "", stderr: "not running" }
        : {
            code: 0,
            stdout: JSON.stringify({
              ...(options.tailscaleVersion === "none"
                ? {}
                : { Version: options.tailscaleVersion ?? TAILSCALE_VERSION }),
              Self: {
                Online: true,
                ...(options.noDnsName ? {} : { DNSName: options.dnsName ?? DNS_NAME }),
              },
            }),
            stderr: "",
          };
    }
    if (argv[0] === "tailscale" && argv[1] === "ip") {
      return { code: 0, stdout: "100.64.0.7\n", stderr: "" };
    }
    if (argv[0] === "systemctl" && argv[1] === "show") {
      // What systemd says about one Hermes unit — the tick asks about both: the
      // two state fields and the monotonic restart counter, which is the only
      // thing that gives a crash loop away between samples. The unit is the
      // last argument, so the fake answers per unit as a real systemd does.
      const gateway = argv.at(-1) === HERMES_GATEWAY_UNIT;
      const state = gateway
        ? (options.gatewayUnit ?? { ActiveState: "active", SubState: "running" })
        : (options.hermesUnit ??
          (options.hermesHealthy === false
            ? { ActiveState: "inactive", SubState: "dead" }
            : { ActiveState: "active", SubState: "running" }));
      const restarts = gateway ? gatewayRestarts() : dashboardRestarts();
      return {
        code: 0,
        stdout:
          `ActiveState=${state.ActiveState}\nSubState=${state.SubState}\n` +
          (restarts === null ? "" : `NRestarts=${restarts}\n`),
        stderr: "",
      };
    }
    return null;
  });

  // Dispatches on URL: the Hermes loopback probe and the public dashboard probe
  // are two different questions and a test needs to answer them separately.
  const fetched: string[] = [];
  /** The `redirect` mode each `/api/health` probe was made with. */
  const hermesRedirect: string[] = [];
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    fetched.push(String(input));
    if (String(input) === HERMES_HEALTH_URL) {
      hermesRedirect.push(String(init?.redirect ?? "follow"));
      if (options.hermesStatus !== undefined) {
        return new Response("gate", { status: options.hermesStatus });
      }
      if (options.hermesHealthy === false) return new Response("no", { status: 503 });
      // Upstream's real shape: `{"ok": true, "version": __version__, …}`. The
      // heartbeat reads `version` out of it and reports it as the box's own
      // account of which Hermes it is running.
      return Response.json({ ok: true, version: options.hermesReports ?? "0.21.0" });
    }
    // Any other loopback path is the SPA's, and upstream's catch-all answers it
    // with the bundle rather than a 404 — the whole reason `/healthz` "passed".
    if (options.spaCatchAll && String(input).startsWith(`http://127.0.0.1:${HERMES_DASHBOARD_PORT}/`)) {
      return new Response("<!doctype html>", { status: 200 });
    }
    const dashboard = options.dashboard ?? 200;
    if (dashboard === "throw") throw new TypeError("unable to verify the first certificate");
    if (dashboard === "hang") {
      // Never answers, but honours the abort — which is what a real fetch does
      // and the only reason the tick is not stuck here forever.
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason ?? new Error("aborted")),
        );
      });
    }
    return new Response("dashboard", { status: dashboard });
  }) as unknown as typeof fetch;

  const aws = makeAws({
    ddb,
    ssm: new RecordingSink(),
    s3: new RecordingSink(),
    agentsTable: AGENTS,
    eventsTable: EVENTS,
    now: () => host.now(),
    warn: (message) => void warnings.push(message),
  });

  return {
    host,
    ddb,
    warnings,
    requested,
    fetched,
    hermesRedirect,
    heartbeat: makeHeartbeat({
      host,
      aws,
      name: TEST_NAME,
      hermeticdVersion: "0.1.0",
      fetchImpl,
      ...(options.dashboardTimeoutMs ? { dashboardTimeoutMs: options.dashboardTimeoutMs } : {}),
      onUpdateRequest: (request) => void requested.push(request),
      ...(options.onFirstWrite ? { onFirstWrite: options.onFirstWrite } : {}),
    }),
    updates: () => ddb.commandCalls(UpdateCommand),
  };
}

describe("the heartbeat writer (§6.4)", () => {
  let h: Harness;

  test("a healthy tick writes last_heartbeat, health and metrics unconditionally", async () => {
    h = harness({ status: "ready" });
    const tick = await h.heartbeat.once();

    expect(tick.health).toEqual({ hermes: true, tailscale: true, disk: true, dashboard: true });
    expect(tick.transitioned).toBeNull();

    const [update, ...rest] = h.updates();
    expect(rest).toHaveLength(0);
    expect(update?.input.TableName).toBe(AGENTS);
    expect(update?.input.Key).toEqual({ name: TEST_NAME });
    // Guarded on existence only — never on status or version, so it cannot
    // lose a race with the operator, and never on nothing, so `UpdateItem`'s
    // upsert cannot recreate a destroyed row as a fragment.
    expect(update?.input.ConditionExpression).toBe("attribute_exists(#name)");
    expect(update?.input.ExpressionAttributeNames?.["#name"]).toBe("name");
    expect(update?.input.UpdateExpression).toContain("#lh = :at");
    expect(update?.input.UpdateExpression).toContain("#h = :h");
    expect(update?.input.ExpressionAttributeNames).toMatchObject({
      "#lh": "last_heartbeat",
      "#h": "health",
      "#m": "metrics",
      "#ua": "updated_at",
    });
    expect(update?.input.UpdateExpression).toContain("#m = :m");
    expect(update?.input.ExpressionAttributeValues?.[":h"]).toEqual({
      hermes: true,
      tailscale: true,
      disk: true,
      dashboard: true,
    });
    expect(update?.input.ExpressionAttributeValues?.[":hdv"]).toBe("0.1.0");
    // Out of Hermes's own `/api/health` body, not out of a dep this test hands
    // in. It used to be the latter — `HeartbeatDeps.hermesVersion`, which no
    // production caller ever set, so the row's Hermes version was laptop-only
    // and the box never got a say.
    expect(update?.input.ExpressionAttributeValues?.[":hv"]).toBe("0.21.0");
    expect(update?.input.ExpressionAttributeNames?.["#hv"]).toBe("running_hermes_version");
    expect(update?.input.ExpressionAttributeValues?.[":tip"]).toBe("100.64.0.7");
    // The name is reported alongside the address, with the trailing dot the
    // daemon reports stripped — the row's copy has to be paste-able into a URL.
    expect(update?.input.ExpressionAttributeNames?.["#tdn"]).toBe("tailscale_dns_name");
    expect(update?.input.ExpressionAttributeValues?.[":tdn"]).toBe("atlas.example.ts.net");
    // The daemon's own version, out of the same document as the two above. It
    // is on the row because nothing on the laptop chooses it: the box runs
    // Tailscale's updater, so this is the fleet's only record of the release it
    // reached.
    expect(update?.input.ExpressionAttributeNames?.["#tv"]).toBe("tailscale_version");
    expect(update?.input.ExpressionAttributeValues?.[":tv"]).toBe(TAILSCALE_VERSION);
  });

  test("a daemon that reports no version writes none, rather than an empty one", async () => {
    // Absence has to survive the whole path: an older Tailscale omits the field,
    // and a row that took `""` for it would render as a box running nothing
    // instead of a box that did not say.
    const h = harness({ status: "ready", tailscaleVersion: "none" });
    await h.heartbeat.once();
    const update = h.updates().at(-1);
    expect(update?.input.ExpressionAttributeValues?.[":tv"]).toBeUndefined();
    expect(update?.input.ExpressionAttributeNames?.["#tv"]).toBeUndefined();
  });

  test("a version that is not a string costs the version and nothing else", async () => {
    // `Version` is untrusted JSON. Reading it used to be able to throw, and the
    // throw was caught alongside `Self`, so a malformed version blanked the
    // online reading and the MagicDNS name too — three such ticks degrade a
    // healthy agent.
    const h = harness({ status: "ready", tailscaleVersion: 12345 });
    const tick = await h.heartbeat.once();
    const update = h.updates().at(-1);

    expect(tick.health.tailscale).toBe(true);
    expect(update?.input.ExpressionAttributeValues?.[":tdn"]).toBe("atlas.example.ts.net");
    expect(update?.input.ExpressionAttributeValues?.[":tv"]).toBeUndefined();
  });

  test("a tick whose `tailscale status` failed leaves the recorded version standing", async () => {
    // Same rule the address and the MagicDNS name follow: silence is not a
    // reading, and overwriting a known version with nothing would make a box
    // that is merely unreachable look like one that never reported.
    const h = harness({ status: "ready", tailscaleOnline: false });
    await h.heartbeat.once();
    const update = h.updates().at(-1);
    expect(update?.input.ExpressionAttributeValues?.[":tv"]).toBeUndefined();
  });

  /**
   * The failure this reports: a recreate leaves the old device in the tailnet's
   * device list holding `atlas`, so the new node is given `atlas-2` — and that
   * is the name `serve` publishes and the certificate is issued for. The row
   * must carry the name that resolves, not the name core asked for.
   */
  test("a suffixed node reports the name it was actually given", async () => {
    h = harness({ status: "ready", dnsName: "atlas-2.example.ts.net." });
    await h.heartbeat.once();

    expect(h.updates()[0]?.input.ExpressionAttributeValues?.[":tdn"]).toBe("atlas-2.example.ts.net");
  });

  /**
   * A tick where `tailscale status` failed knows nothing about the name, and
   * nothing is not the same as "no name" — writing null would erase a good
   * value and leave the laptop with no URL to offer at all.
   */
  test("a failed status read leaves the name and address on the row untouched", async () => {
    h = harness({ status: "ready", tailscaleOnline: false });
    await h.heartbeat.once();

    const update = h.updates()[0];
    expect(update?.input.UpdateExpression).not.toContain("#tdn");
    expect(update?.input.UpdateExpression).not.toContain("#tip");
    expect(update?.input.ExpressionAttributeNames?.["#tdn"]).toBeUndefined();
    // The health field is still written: the tick did learn that we are offline.
    expect(update?.input.ExpressionAttributeValues?.[":h"]).toMatchObject({ tailscale: false });
  });

  test("a heartbeat against a deleted row writes nothing and then stops trying", async () => {
    h = harness({ status: "ready", rowDeleted: true });

    const first = await h.heartbeat.once();
    expect(first.written).toBe(false);
    expect(first.transitioned).toBeNull();
    // The write was attempted once, refused by the condition, and swallowed.
    expect(h.updates()).toHaveLength(1);
    expect(h.updates()[0]?.input.ConditionExpression).toBe("attribute_exists(#name)");
    // Nothing was appended to `events` either: there is no row to describe.
    expect(h.ddb.commandCalls(PutCommand)).toHaveLength(0);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain("no longer exists");

    // Latched off: subsequent ticks do not write at all.
    const second = await h.heartbeat.once();
    const third = await h.heartbeat.once();
    expect(second.written).toBe(false);
    expect(third.written).toBe(false);
    expect(h.updates()).toHaveLength(1);
    // And the warning is logged once, not every 30 seconds.
    expect(h.warnings).toHaveLength(1);
  });

  test("a healthy tick reports that it was written", async () => {
    h = harness({ status: "ready" });
    expect((await h.heartbeat.once()).written).toBe(true);
  });

  test("the heartbeat never touches `version` — it must not break core's CAS", async () => {
    h = harness({ status: "ready" });
    await h.heartbeat.once();

    const update = h.updates()[0];
    expect(update?.input.UpdateExpression).not.toContain("version");
    expect(Object.values(update?.input.ExpressionAttributeNames ?? {})).not.toContain("version");
  });

  test("every attribute name in every UpdateExpression is aliased", async () => {
    // `metrics`, `status`, `name`, `version` and `health` are all DynamoDB
    // reserved words; an unaliased one is a ValidationException on the real
    // service and on no test double.
    h = harness({ status: "ready", hermesHealthy: false });
    for (let i = 0; i < DEGRADE_AFTER_TICKS; i += 1) await h.heartbeat.once();

    expect(h.updates().length).toBeGreaterThan(1);
    for (const update of h.updates()) {
      const expression = String(update.input.UpdateExpression);
      expect(expression.startsWith("SET ")).toBe(true);
      for (const assignment of expression.slice(4).split(", ")) {
        const target = assignment.split("=")[0]?.trim() ?? "";
        expect(target).toStartWith("#");
      }
      // Names referenced in the condition are aliased too.
      for (const name of String(update.input.ConditionExpression ?? "").matchAll(
        /[a-z_]+\(([^)]*)\)/g,
      )) {
        for (const arg of (name[1] ?? "").split(",")) {
          if (arg.trim().length > 0) expect(arg.trim()).toStartWith("#");
        }
      }
    }
  });

  /**
   * The tautology this probe used to be, made into a test.
   *
   * Hermes has no `/healthz`. What answered it was the SPA catch-all
   * (`mount_spa`, `hermes_cli/web_server_dashboard.py:93`), which serves
   * `index.html` with a 200 for any path outside `/api/*` — so the check was
   * true whenever a socket was bound and the bundle was readable, on a box
   * whose Hermes had never answered anything else. This fake is that box: 200
   * on `/`, 404 on the one route Hermes actually serves
   * (`hermes_cli/web_routers/status.py:110`). It must not read as healthy.
   */
  test("the SPA's 200 is not health: a 404 on /api/health fails", async () => {
    expect(HERMES_HEALTH_URL).toEndWith("/api/health");

    h = harness({ status: "ready", hermesHealthy: false, hermesStatus: 404, spaCatchAll: true });

    expect((await h.heartbeat.once()).health.hermes).toBe(false);
    // And the catch-all was never consulted: one loopback request, to the route.
    expect(h.fetched.filter((u) => u.includes("9119"))).toEqual([HERMES_HEALTH_URL]);
  });

  test("a 200 from /api/health is hermes answering, whatever systemd says", async () => {
    // systemd is made to disagree, so a pass can only have come from the route.
    h = harness({ status: "ready", hermesHealthy: false, hermesStatus: 200 });
    expect((await h.heartbeat.once()).health.hermes).toBe(true);
  });

  /**
   * A redirect used to pass, on the grounds that any answer was Hermes
   * answering. On a real route that reasoning is gone: `/api/health` returns
   * its JSON or something in front of it replied instead, and only 2xx is the
   * handler. It is still not followed — one request, never two.
   */
  test("a 302 no longer counts as hermes being up, and is not followed", async () => {
    h = harness({ status: "ready", hermesHealthy: false, hermesStatus: 302 });

    const tick = await h.heartbeat.once();

    expect(tick.health.hermes).toBe(false);
    expect(h.hermesRedirect).toEqual(["manual"]);
    // One request — the page it points at is not fetched.
    expect(h.fetched.filter((u) => u.includes("9119"))).toEqual([HERMES_HEALTH_URL]);

    // …and with systemd happy, a 302 falls through to it exactly as a 4xx does.
    h = harness({ status: "ready", hermesStatus: 302 });
    expect((await h.heartbeat.once()).health.hermes).toBe(true);
  });

  test("a 4xx from /api/health still falls through to systemd, as it always has", async () => {
    h = harness({ status: "ready", hermesHealthy: false, hermesStatus: 404 });
    expect((await h.heartbeat.once()).health.hermes).toBe(false);

    h = harness({ status: "ready", hermesStatus: 404 });
    expect((await h.heartbeat.once()).health.hermes).toBe(true);
  });

  /**
   * The crash loop `h+` used to hide. `hermes-dashboard.service` is `Restart=always`, so a
   * Hermes that dies on every start spends most of every cycle `active` — a
   * probe that samples once every thirty seconds sees a healthy unit and an
   * operator sees `h+` for an agent that has never answered a message. Only
   * systemd's monotonic `NRestarts` gives it away, and only between ticks.
   */
  describe("the crash-loop check", () => {
    test("a unit that has not restarted since the last tick is healthy", async () => {
      h = harness({ status: "ready", hermesRestarts: [4, 4] });
      expect((await h.heartbeat.once()).health.hermes).toBe(true);
      expect((await h.heartbeat.once()).health.hermes).toBe(true);
    });

    test("a unit whose restart count grew is failing, however well it answers", async () => {
      h = harness({ status: "ready", hermesRestarts: [4, 5] });
      // First tick has no baseline, so it can only judge the state — which is
      // exactly what makes the second tick the informative one.
      expect((await h.heartbeat.once()).health.hermes).toBe(true);
      expect((await h.heartbeat.once()).health.hermes).toBe(false);
    });

    test("`activating (auto-restart)` is not up, though `is-active` calls it active", async () => {
      h = harness({
        status: "ready",
        hermesHealthy: false,
        hermesUnit: { ActiveState: "activating", SubState: "auto-restart" },
      });
      expect((await h.heartbeat.once()).health.hermes).toBe(false);
    });

    test("a systemd that reports no counter is judged on state alone", async () => {
      h = harness({ status: "ready" });
      expect((await h.heartbeat.once()).health.hermes).toBe(true);
      expect((await h.heartbeat.once()).health.hermes).toBe(true);
    });
  });

  /**
   * An agent is two processes (§6.4) and `health.hermes` answers for both. The
   * gateway is where the messaging channels and the cron jobs run and it answers
   * no HTTP of its own, so before this the row read `ready` for a box with a
   * dead gateway: dashboard up, nothing answering a message.
   */
  describe("both Hermes units answer for `hermes`", () => {
    test("a tick samples the dashboard and the gateway, in that order", async () => {
      h = harness({ status: "ready" });
      await h.heartbeat.once();

      expect(h.host.commandsMatching(/^systemctl show/)).toEqual(
        HERMES_UNITS.map((unit) => `systemctl show -p ${UNIT_SHOW_PROPERTIES} ${unit}`),
      );
    });

    test("both units up is healthy, as it was when there was only one", async () => {
      h = harness({ status: "ready", hermesRestarts: [3, 3], gatewayRestarts: [1, 1] });
      expect((await h.heartbeat.once()).health.hermes).toBe(true);
      expect((await h.heartbeat.once()).health.hermes).toBe(true);
    });

    test("a dead gateway fails the check, however well the dashboard answers", async () => {
      h = harness({ status: "ready", gatewayUnit: { ActiveState: "inactive", SubState: "dead" } });
      expect((await h.heartbeat.once()).health.hermes).toBe(false);
    });

    test("the degrade detail names the unit that is down", async () => {
      h = harness({ status: "ready", gatewayUnit: { ActiveState: "failed", SubState: "failed" } });

      let tick = await h.heartbeat.once();
      for (let i = 1; i < DEGRADE_AFTER_TICKS; i += 1) tick = await h.heartbeat.once();
      expect(tick.transitioned).toBe("degraded");

      const detail = String(h.ddb.commandCalls(PutCommand)[0]?.input.Item?.["detail"]);
      expect(detail).toContain(HERMES_GATEWAY_UNIT);
      expect(detail).toContain("failed");
      // …and not the dashboard, which was up the whole time.
      expect(detail).not.toContain(`${HERMES_DASHBOARD_UNIT} `);
    });

    test("a flapping gateway is caught by the restart delta, like the dashboard", async () => {
      // The dashboard sits still on a larger count: only a *sum* moves here,
      // which is why the delta is summed across the units rather than maxed.
      h = harness({ status: "ready", hermesRestarts: [9, 9], gatewayRestarts: [1, 2] });

      // The first tick has no baseline, so it can only judge the states.
      expect((await h.heartbeat.once()).health.hermes).toBe(true);
      expect((await h.heartbeat.once()).health.hermes).toBe(false);
    });

    test("a gateway that reports no counter is judged on state alone", async () => {
      h = harness({ status: "ready", hermesRestarts: [4, 4] });
      expect((await h.heartbeat.once()).health.hermes).toBe(true);
      expect((await h.heartbeat.once()).health.hermes).toBe(true);
    });
  });

  /**
   * `NRestarts` says a process died; `gateway_state.json` says what it was
   * doing when it did (`gateway/status.py:793-846`). It is upstream's internal
   * format and not an API (`COMPAT_MANIFEST.md:3-4`), so every case below is
   * also a case about what happens when it is missing, stale or unrecognisable.
   */
  describe("the gateway's own account of itself", () => {
    test("an absent file fails nothing — it is a reason, never a witness", async () => {
      h = harness({ status: "ready" });

      expect((await h.heartbeat.once()).health.hermes).toBe(true);
      expect(await h.host.readFile(GATEWAY_STATE_PATH)).toBeNull();
    });

    /**
     * The state systemd cannot report. `startup_failed` is written by a gateway
     * that came up and gave up (`gateway/run_startup.py:859`, `:1107`), so the
     * unit is `active (running)` and `NRestarts` has not moved — both units read
     * healthy here, and the box still answers no messages.
     */
    test("`startup_failed` fails the check on its own", async () => {
      h = harness({
        status: "ready",
        gatewayStateFile: gatewayStateFile({
          gateway_state: "startup_failed",
          exit_reason: "Discord adapter: invalid bot token",
        }),
      });

      expect((await h.heartbeat.once()).health.hermes).toBe(false);
    });

    test("the degrade detail carries the gateway's reason, not just `hermes`", async () => {
      h = harness({
        status: "ready",
        gatewayStateFile: gatewayStateFile({
          gateway_state: "startup_failed",
          exit_reason: "Discord adapter: invalid bot token",
        }),
      });

      let tick = await h.heartbeat.once();
      for (let i = 1; i < DEGRADE_AFTER_TICKS; i += 1) tick = await h.heartbeat.once();
      expect(tick.transitioned).toBe("degraded");

      const detail = String(h.ddb.commandCalls(PutCommand)[0]?.input.Item?.["detail"]);
      expect(detail).toContain(HERMES_GATEWAY_UNIT);
      expect(detail).toContain("invalid bot token");
    });

    /**
     * A restart is not a symptom. Exit 75 is how the gateway *asks* to be
     * replaced and its unit is built for it (`hermes_cli/gateway.py:2825-2839`)
     * — the normal end of `/restart`, of `hermes update`, and of a code-skew
     * respawn. Not counted at all, rather than absorbed by the hysteresis:
     * three chained `/restart`s used to degrade an agent for obeying.
     */
    test("a restart the gateway asked for does not count", async () => {
      h = harness({
        status: "ready",
        gatewayRestarts: [7, 8, 9, 10],
        gatewayStateFile: gatewayStateFile({
          gateway_state: "stopped",
          exit_reason: "Gateway restart requested",
          restart_requested: true,
        }),
      });

      // Four ticks, three of them with the counter moving — past the hysteresis.
      for (let i = 0; i <= DEGRADE_AFTER_TICKS; i += 1) {
        expect((await h.heartbeat.once()).health.hermes).toBe(true);
      }
      expect(h.updates().filter(statusGuarded)).toHaveLength(0);
    });

    /**
     * The flag is not enough on its own, because upstream never clears it
     * promptly. `write_runtime_status` only assigns the fields it was passed
     * over a read-merge-write (`gateway/status.py:781-785`, `:818-820`); the
     * shutdown that set it writes `stopped` *with* it (`run_shutdown.py:1848`
     * → `run.py:3872-3875`); and the replacement process writes
     * `gateway_state="starting"` without passing it at all
     * (`run_startup.py:777`), so the stale `true` survives until startup
     * succeeds (`run_startup.py:1360`, `run.py:3284`).
     *
     * A gateway crash-looping in that window would read as planned every tick
     * while the counter delta had already been consumed — not a deferred
     * degrade but a permanently missed one. So the state has to agree.
     */
    test("`restart_requested` does not excuse a restart seen while starting", async () => {
      h = harness({
        status: "ready",
        gatewayRestarts: [7, 8, 9, 10],
        gatewayStateFile: gatewayStateFile({
          gateway_state: "starting",
          exit_reason: "Gateway restart requested",
          restart_requested: true,
        }),
      });

      let tick = await h.heartbeat.once();
      expect(tick.health.hermes).toBe(true);
      for (let i = 0; i < DEGRADE_AFTER_TICKS; i += 1) tick = await h.heartbeat.once();
      expect(tick.transitioned).toBe("degraded");
    });

    /** Draining is the other half of a restart it asked for, and is excused. */
    test("a restart the gateway asked for is excused while it is draining", async () => {
      h = harness({
        status: "ready",
        gatewayRestarts: [7, 8, 9, 10],
        gatewayStateFile: gatewayStateFile({
          gateway_state: "draining",
          exit_reason: "Gateway restart requested",
          restart_requested: true,
        }),
      });

      for (let i = 0; i <= DEGRADE_AFTER_TICKS; i += 1) {
        expect((await h.heartbeat.once()).health.hermes).toBe(true);
      }
      expect(h.updates().filter(statusGuarded)).toHaveLength(0);
    });

    test("an unexplained restart still fails, and the detail quotes the gateway", async () => {
      h = harness({
        status: "ready",
        gatewayRestarts: [7, 8, 9, 10],
        gatewayStateFile: gatewayStateFile({
          gateway_state: "stopped",
          exit_reason: "All messaging adapters disconnected",
        }),
      });

      // The first tick has no baseline; each of the next three sees it move.
      let tick = await h.heartbeat.once();
      expect(tick.health.hermes).toBe(true);
      for (let i = 0; i < DEGRADE_AFTER_TICKS; i += 1) tick = await h.heartbeat.once();
      expect(tick.transitioned).toBe("degraded");

      const detail = String(h.ddb.commandCalls(PutCommand)[0]?.input.Item?.["detail"]);
      expect(detail).toContain("restarted since the last tick");
      expect(detail).toContain("All messaging adapters disconnected");
    });

    /**
     * Past its TTL the snapshot describes an earlier life of the gateway
     * (`gateway/status.py:853-862`), and both directions matter: a stale
     * `restart_requested` must not excuse a restart happening now.
     */
    test("a stale snapshot excuses nothing", async () => {
      h = harness({
        status: "ready",
        gatewayRestarts: [7, 8],
        gatewayStateFile: gatewayStateFile(
          {
            gateway_state: "stopped",
            exit_reason: "Gateway restart requested",
            restart_requested: true,
          },
          GATEWAY_STATE_STALE_MS + 1_000,
        ),
      });

      expect((await h.heartbeat.once()).health.hermes).toBe(true);
      expect((await h.heartbeat.once()).health.hermes).toBe(false);
    });

    test("a stale `startup_failed` does not degrade a box that is running now", async () => {
      h = harness({
        status: "ready",
        gatewayStateFile: gatewayStateFile(
          { gateway_state: "startup_failed", exit_reason: "invalid bot token" },
          GATEWAY_STATE_STALE_MS + 1_000,
        ),
      });

      expect((await h.heartbeat.once()).health.hermes).toBe(true);
    });

    test("malformed JSON is tolerated, exactly as absence is", async () => {
      h = harness({
        status: "ready",
        gatewayRestarts: [7, 8],
        gatewayStateFile: '{"gateway_state": "run',
      });

      expect((await h.heartbeat.once()).health.hermes).toBe(true);
      // Not a failure by itself — and no excuse for the restart either.
      expect((await h.heartbeat.once()).health.hermes).toBe(false);
    });

    test("a shape this build does not recognise decides nothing", async () => {
      // Every key renamed by some later Hermes: parsed, empty, and harmless.
      h = harness({
        status: "ready",
        gatewayStateFile: JSON.stringify({ state: "startup_failed", updated_at: 17 }),
      });

      expect((await h.heartbeat.once()).health.hermes).toBe(true);
    });

    test("parseGatewayState reads what the gateway wrote and nothing more", () => {
      expect(
        parseGatewayState(
          '{"gateway_state":"running","exit_reason":null,"restart_requested":false,' +
            '"updated_at":"2026-09-01T11:59:30.123456+00:00"}',
        ),
      ).toEqual({
        state: "running",
        exitReason: null,
        restartRequested: false,
        updatedAt: new Date("2026-09-01T11:59:30.123Z"),
      });
      expect(parseGatewayState("not json")).toBeNull();
      // A field of a type this build does not expect reads as absent, rather
      // than failing the whole parse and losing the fields beside it.
      expect(parseGatewayState('{"gateway_state":7,"restart_requested":"yes"}')).toEqual({
        state: null,
        exitReason: null,
        restartRequested: false,
        updatedAt: null,
      });
    });

    test("a reason too long for an event detail is trimmed to one line", () => {
      expect(shortReason("adapter\n  lost")).toBe("adapter lost");
      expect(shortReason("x".repeat(200))).toHaveLength(120);
      expect(shortReason("x".repeat(200))).toEndWith("…");
    });
  });

  test("parseUnitState reads what systemd said and nothing more", () => {
    expect(parseUnitState("ActiveState=active\nSubState=running\nNRestarts=2\n")).toEqual({
      activeState: "active",
      subState: "running",
      restarts: 2,
    });
    // Absent is not zero: a counter systemd did not report licenses no comparison.
    expect(parseUnitState("ActiveState=failed\n")).toEqual({
      activeState: "failed",
      subState: null,
      restarts: null,
    });
    expect(parseUnitState("nonsense\nNRestarts=\n").restarts).toBeNull();
  });

  test("metrics carry cpu, mem and disk percentages in range", async () => {
    h = harness({ status: "ready", diskPct: 40 });
    const first = await h.heartbeat.once();
    expect(first.metrics.cpu_pct).toBe(0); // no delta on the first tick
    expect(first.metrics.mem_pct).toBe(75);
    expect(first.metrics.disk_pct).toBe(40);

    // Second sample: 100 more busy ticks, 100 more idle → 50% busy.
    h.host.seed("/proc/stat", "cpu  200 0 100 800 100 0 0 0 0 0\n");
    const second = await h.heartbeat.once();
    expect(second.metrics.cpu_pct).toBe(50);
  });

  test("the root filesystem is measured alongside /data", async () => {
    h = harness({ status: "ready", diskPct: 40, rootDiskPct: 62 });
    const tick = await h.heartbeat.once();
    // Two filesystems, two numbers: a comfortable `/data` no longer hides a
    // root disk the self-update is about to refuse to write to.
    expect(tick.metrics.disk_pct).toBe(40);
    expect(tick.metrics.root_disk_pct).toBe(62);
    expect(h.host.commands.filter((c) => c.startsWith("df "))).toHaveLength(0);
  });

  test("the root filesystem's free bytes ride along with its percentage", async () => {
    // `statfsAt` builds 1000 blocks of 4 KiB, so 62% full leaves 380 blocks —
    // 1.48 MiB, floored to 1. The point is not the figure but that it comes
    // from the filesystem rather than from `size × (1 - pct)`, which cannot see
    // the boot partitions and metadata that sit between the two.
    h = harness({ status: "ready", diskPct: 40, rootDiskPct: 62 });
    const tick = await h.heartbeat.once();
    expect(tick.metrics.root_free_mib).toBe(1);
    expect(h.host.commands.filter((c) => c.startsWith("df "))).toHaveLength(0);
  });

  test("an unmeasurable root filesystem omits the field rather than reporting 0%", async () => {
    h = harness({ status: "ready", diskPct: 40, rootDiskPct: "unmeasured" });
    // statvfs said nothing for `/`, and `df` would not either — the two ways of
    // asking are both exhausted, so nothing is claimed.
    h.host.handlers.unshift((argv) =>
      argv[0] === "df" && argv[2] === ROOT_MOUNT
        ? { code: 1, stdout: "", stderr: "df: /: No such file or directory" }
        : null,
    );
    const tick = await h.heartbeat.once();
    expect(tick.metrics.disk_pct).toBe(40);
    expect("root_disk_pct" in tick.metrics).toBe(false);
    // Both halves of the reading go together: a box that cannot measure the
    // ratio cannot measure the bytes either, and neither is guessed.
    expect("root_free_mib" in tick.metrics).toBe(false);
    // And an unmeasured root disk accuses nobody: the disk check still passes.
    expect(tick.health.disk).toBe(true);
  });

  test("a full root filesystem fails the disk check even when /data is fine", async () => {
    h = harness({ status: "ready", diskPct: 12, rootDiskPct: 97 });
    let tick = await h.heartbeat.once();
    expect(tick.metrics.root_disk_pct).toBe(97);
    expect(tick.health.disk).toBe(false);
    for (let i = 1; i < DEGRADE_AFTER_TICKS; i += 1) tick = await h.heartbeat.once();
    expect(tick.transitioned).toBe("degraded");
  });

  test(`a failing check moves ready → degraded only after ${DEGRADE_AFTER_TICKS} ticks`, async () => {
    h = harness({ status: "ready", hermesHealthy: false });

    // Hysteresis: one bad probe is a restart, not a degraded agent.
    for (let i = 1; i < DEGRADE_AFTER_TICKS; i += 1) {
      const early = await h.heartbeat.once();
      expect(early.health.hermes).toBe(false);
      expect(early.transitioned).toBeNull();
      expect(h.updates().every((u) => !statusGuarded(u))).toBe(true);
    }

    const tick = await h.heartbeat.once();
    expect(tick.health.hermes).toBe(false);
    expect(tick.transitioned).toBe("degraded");

    const transition = h.updates().find(statusGuarded);
    expect(transition?.input.ConditionExpression).toBe(
      "attribute_exists(#name) AND #status IN (:from0)",
    );
    expect(transition?.input.ExpressionAttributeValues?.[":from0"]).toBe("ready");
    expect(transition?.input.ExpressionAttributeValues?.[":to"]).toBe("degraded");
    expect(transition?.input.UpdateExpression).toContain("#status = :to");

    // The transition is recorded in the events table, attributed to the box.
    const event = h.ddb.commandCalls(PutCommand)[0];
    expect(event?.input.TableName).toBe(EVENTS);
    expect(event?.input.Item?.["actor"]).toBe(`hermeticd@${TEST_NAME}`);
    expect(event?.input.Item?.["to_status"]).toBe("degraded");
    expect(event?.input.Item?.["action"]).toBe("degrade");
    expect(event?.input.ConditionExpression).toBe("attribute_not_exists(#name)");
    expect(String(event?.input.Item?.["detail"])).toContain("hermes");
  });

  test(`recovery moves degraded → ready after ${RECOVER_AFTER_TICKS} passing ticks`, async () => {
    h = harness({ status: "degraded" });

    const early = await h.heartbeat.once();
    expect(early.transitioned).toBeNull();

    const tick = await h.heartbeat.once();
    expect(tick.transitioned).toBe("ready");
    const transition = h.updates().find(statusGuarded);
    expect(transition?.input.ExpressionAttributeValues?.[":from0"]).toBe("degraded");
    expect(transition?.input.ExpressionAttributeValues?.[":to"]).toBe("ready");
  });

  test("a failed condition is not an error: a destroying agent is never resurrected", async () => {
    h = harness({ status: "destroying", hermesHealthy: false, transitionSucceeds: false });
    let tick = await h.heartbeat.once();
    for (let i = 1; i < DEGRADE_AFTER_TICKS; i += 1) tick = await h.heartbeat.once();

    expect(tick.transitioned).toBeNull();
    // The row still gets its heartbeats, but no status change is even attempted.
    // Every write is a plain heartbeat; not one attempts a status change.
    expect(h.updates()).toHaveLength(DEGRADE_AFTER_TICKS);
    expect(h.updates().every((u) => !statusGuarded(u))).toBe(true);
    expect(h.ddb.commandCalls(PutCommand)).toHaveLength(0);
  });

  test("a full disk fails the disk check", async () => {
    h = harness({ status: "ready", diskPct: 95 });
    let tick = await h.heartbeat.once();
    expect(tick.health.disk).toBe(false);
    expect(tick.metrics.disk_pct).toBe(95);
    for (let i = 1; i < DEGRADE_AFTER_TICKS; i += 1) tick = await h.heartbeat.once();
    expect(tick.transitioned).toBe("degraded");
  });

  test("tailscale offline fails the tailscale check", async () => {
    h = harness({ status: "ready", tailscaleOnline: false });
    let tick = await h.heartbeat.once();
    expect(tick.health.tailscale).toBe(false);
    for (let i = 1; i < DEGRADE_AFTER_TICKS; i += 1) tick = await h.heartbeat.once();
    expect(tick.transitioned).toBe("degraded");
  });

  test("a single bad tick followed by recovery never touches the status", async () => {
    const host = new FakeHost();
    const ddb = new RecordingSink();
    ddb.byCommand.set("GetCommand", () => ({ Item: row("ready") }));
    ddb.byCommand.set("UpdateCommand", () => ({}));
    let hermesUp = false;
    host.handlers.push((argv) => {
      if (argv[0] === "tailscale" && argv[1] === "status") {
        return {
          code: 0,
          stdout: JSON.stringify({ Self: { Online: true, DNSName: DNS_NAME } }),
          stderr: "",
        };
      }
      if (argv[0] === "systemctl" && argv[1] === "is-active") {
        return hermesUp
          ? { code: 0, stdout: "active\n", stderr: "" }
          : { code: 3, stdout: "inactive\n", stderr: "" };
      }
      return null;
    });
    host.seed("/proc/stat", "cpu  1 0 1 8 0 0 0 0 0 0\n");
    host.seed("/proc/meminfo", "MemTotal: 10 kB\nMemAvailable: 5 kB\n");
    const beat = makeHeartbeat({
      host,
      aws: makeAws({
        ddb,
        ssm: new RecordingSink(),
        s3: new RecordingSink(),
        agentsTable: AGENTS,
        eventsTable: EVENTS,
        now: () => host.now(),
      }),
      name: TEST_NAME,
      hermeticdVersion: "0.1.0",
      fetchImpl: (async (input: string) =>
        String(input) === HERMES_HEALTH_URL
          ? new Response("no", { status: 503 })
          : new Response("ok")) as unknown as typeof fetch,
    });

    expect((await beat.once()).transitioned).toBeNull();
    hermesUp = true;
    expect((await beat.once()).transitioned).toBeNull();
    expect(ddb.commandCalls(UpdateCommand).every((u) => !statusGuarded(u))).toBe(true);
  });
});

describe("the dashboard check (§4.7)", () => {
  test("a tick fetches the node's own published URL and passes on 200", async () => {
    const h = harness({ status: "ready" });
    const tick = await h.heartbeat.once();

    expect(tick.health.dashboard).toBe(true);
    // The exact URL matters: it is the one the operator is told to open, built
    // from `Self.DNSName` with the trailing dot stripped — `https://atlas…ts.net./`
    // is not a URL a browser or a certificate agrees with.
    expect(h.fetched).toContain(DASHBOARD_URL);
    expect(h.fetched).not.toContain("https://atlas.example.ts.net./");
    expect(dashboardUrl("atlas.example.ts.net")).toBe(DASHBOARD_URL);
  });

  test("a 302 passes: a redirect is Hermes answering, so the chain in front of it worked", async () => {
    const h = harness({ status: "ready", dashboard: 302 });
    expect((await h.heartbeat.once()).health.dashboard).toBe(true);
  });

  test("a 401 passes harmlessly: a challenge would still be Hermes deciding who we are", async () => {
    const h = harness({ status: "ready", dashboard: 401 });
    expect((await h.heartbeat.once()).health.dashboard).toBe(true);
  });

  /**
   * The one that made this check honest. The chain is `serve` → the loopback
   * nginx proxy → Hermes, and a 400 is Hermes' own Host-header guard refusing
   * what it was handed — an nginx that rewrote the wrong `Host`, or a Hermes
   * not in local mode. That is exactly the shape of failure the probe exists to
   * catch, and a bare `status < 500` reported it as `dashboard: true`.
   */
  test("a 400 fails: that is the proxy or Hermes misconfigured, not an answer", async () => {
    const h = harness({ status: "ready", dashboard: 400 });
    expect((await h.heartbeat.once()).health.dashboard).toBe(false);
  });

  test("a 404 fails: the proxy reached something, but not a dashboard", async () => {
    const h = harness({ status: "ready", dashboard: 404 });
    expect((await h.heartbeat.once()).health.dashboard).toBe(false);
  });

  test("a 502 fails: the proxy answered but could not reach anything behind it", async () => {
    const h = harness({ status: "ready", dashboard: 502 });
    expect((await h.heartbeat.once()).health.dashboard).toBe(false);
  });

  test(`a TLS failure degrades the agent after ${DEGRADE_AFTER_TICKS} ticks with everything else passing`, async () => {
    // The failure this check exists for: certificates disabled on the tailnet,
    // so `tailscale serve --https` never publishes anything, while Hermes, the
    // tailnet and the disk all look fine.
    const h = harness({ status: "ready", dashboard: "throw" });

    let tick = await h.heartbeat.once();
    expect(tick.health).toEqual({ hermes: true, tailscale: true, disk: true, dashboard: false });
    for (let i = 1; i < DEGRADE_AFTER_TICKS; i += 1) {
      expect(tick.transitioned).toBeNull();
      tick = await h.heartbeat.once();
    }
    expect(tick.transitioned).toBe("degraded");

    const event = h.ddb.commandCalls(PutCommand)[0];
    expect(String(event?.input.Item?.["detail"])).toContain("dashboard");
    expect(String(event?.input.Item?.["detail"])).not.toContain("hermes");
  });

  test("no MagicDNS name fails the check and fetches nothing", async () => {
    const h = harness({ status: "ready", noDnsName: true });
    const tick = await h.heartbeat.once();
    expect(tick.health.dashboard).toBe(false);
    expect(tick.health.tailscale).toBe(true);
    expect(h.fetched).toEqual([HERMES_HEALTH_URL]);
  });

  test("a dashboard that never answers is bounded by the timeout, not by the tick", async () => {
    const h = harness({ status: "ready", dashboard: "hang", dashboardTimeoutMs: 25 });
    const started = Date.now();
    const tick = await h.heartbeat.once();
    // The tick completed at all, which is the point: the abort fired rather
    // than a stuck fetch holding the 30 s loop open forever.
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
    expect(tick.health.dashboard).toBe(false);
    expect(tick.written).toBe(true);
  });
});

describe("the rollout request on the row (§6.6)", () => {
  const request = (id: string, version = "0.2.0"): UpdateRequest => ({
    id,
    hermeticd_version: version,
    issued_at: "2026-09-04T12:00:00.000Z",
    issued_by: "evan",
  });

  test("a row with no update_request never calls the callback", async () => {
    const h = harness({ status: "ready" });
    await h.heartbeat.once();
    await h.heartbeat.once();
    expect(h.requested).toEqual([]);
  });

  test("the same request id is reported once, however many ticks see it", async () => {
    const h = harness({ status: "ready", requests: [request("op-1")] });

    await h.heartbeat.once();
    await h.heartbeat.once();
    await h.heartbeat.once();

    expect(h.requested).toEqual([request("op-1")]);
  });

  test("a new id is reported again — a second foundation update rolls out too", async () => {
    const h = harness({
      status: "ready",
      requests: [request("op-1"), request("op-1"), request("op-2", "0.3.0")],
    });

    await h.heartbeat.once();
    await h.heartbeat.once();
    await h.heartbeat.once();
    await h.heartbeat.once();

    expect(h.requested.map((r) => r.id)).toEqual(["op-1", "op-2"]);
    expect(h.requested[1]?.hermeticd_version).toBe("0.3.0");
  });

  test("the request is reported even when the box is unhealthy", async () => {
    const h = harness({ status: "ready", hermesHealthy: false, requests: [request("op-1")] });
    const tick = await h.heartbeat.once();
    expect(tick.health.hermes).toBe(false);
    expect(h.requested.map((r) => r.id)).toEqual(["op-1"]);
  });

  test("the field is only read, never cleared — hermetic reads the version instead", async () => {
    const h = harness({ status: "ready", requests: [request("op-1")] });
    await h.heartbeat.once();
    const wrote = h
      .updates()
      .map((u) => String(u.input.UpdateExpression ?? ""))
      .join(" ");
    expect(wrote).not.toContain("update_request");
  });
});

describe("/proc parsing", () => {
  test("parseProcStat sums the cpu line and counts idle+iowait as idle", () => {
    expect(parseProcStat("cpu  10 0 10 70 10 0 0 0 0 0\n")).toEqual({ total: 100, idle: 80 });
    expect(parseProcStat("intr 1 2 3\n")).toBeNull();
  });

  test("cpuPercent is 0 without a previous sample and clamps to [0,100]", () => {
    expect(cpuPercent(null, { total: 100, idle: 50 })).toBe(0);
    expect(cpuPercent({ total: 0, idle: 0 }, { total: 100, idle: 25 })).toBe(75);
    expect(cpuPercent({ total: 100, idle: 50 }, { total: 100, idle: 50 })).toBe(0);
  });

  test("parseMeminfo uses MemAvailable, falling back to MemFree", () => {
    expect(parseMeminfo("MemTotal: 1000 kB\nMemAvailable: 400 kB\n")).toBe(60);
    expect(parseMeminfo("MemTotal: 1000 kB\nMemFree: 100 kB\n")).toBe(90);
    expect(parseMeminfo("garbage")).toBe(0);
  });
});

/**
 * The crash-loop check compares this tick's `NRestarts` against the last one's,
 * and hermeticd restarts itself every time it takes a release (§6.5). Held in
 * memory, the baseline died with the process — so the nightly self-update
 * handed a Hermes that had been crash-looping all night a clean sheet, and the
 * check written to catch a crash loop was blinded by the one event guaranteed
 * to happen daily.
 */
/**
 * The evidence `serve` settles a binary swap on (§6.5). A heartbeat write that
 * lands means user-data parsed, the instance role signed, DynamoDB answered and
 * every probe ran — the whole chain a bad release breaks. It is a callback
 * because the heartbeat has no business knowing what an update is.
 */
describe("the first heartbeat write that lands", () => {
  test("is announced exactly once, however many ticks follow", async () => {
    let announced = 0;
    const h = harness({ status: "ready", onFirstWrite: () => (announced += 1) });

    await h.heartbeat.once();
    await h.heartbeat.once();
    await h.heartbeat.once();

    expect(announced).toBe(1);
  });

  test("is not announced when the write was refused", async () => {
    let announced = 0;
    const h = harness({ status: "ready", rowDeleted: true, onFirstWrite: () => (announced += 1) });

    const tick = await h.heartbeat.once();

    expect(tick.written).toBe(false);
    // A row that is gone is not evidence that this release works.
    expect(announced).toBe(0);
  });
});

describe("the crash-loop baseline outlives the process", () => {
  test("a restart between the two ticks is still caught after hermeticd restarts", async () => {
    const first = harness({ status: "ready", hermesRestarts: [4] });
    expect((await first.heartbeat.once()).health.hermes).toBe(true);
    expect(first.host.files.has(BASELINE_PATH)).toBe(true);

    // A new hermeticd on the same box: new process, same disk.
    const second = harness({ status: "ready", hermesRestarts: [5], host: first.host });

    expect((await second.heartbeat.once()).health.hermes).toBe(false);
  });

  test("a box that has not restarted keeps reporting healthy across the swap", async () => {
    const first = harness({ status: "ready", hermesRestarts: [4] });
    await first.heartbeat.once();

    const second = harness({ status: "ready", hermesRestarts: [4], host: first.host });

    expect((await second.heartbeat.once()).health.hermes).toBe(true);
  });

  test("the CPU sample survives too, so the first tick after a swap is not 0%", async () => {
    const first = harness({ status: "ready" });
    await first.heartbeat.once();

    const second = harness({ status: "ready", host: first.host });
    // Busier since the sample the previous process took: 100 more jiffies, all
    // of them non-idle.
    second.host.seed("/proc/stat", "cpu  200 0 100 700 100 0 0 0 0 0\n");

    expect((await second.heartbeat.once()).metrics.cpu_pct).toBeGreaterThan(0);
  });

  test("a truncated or foreign baseline is ignored, not fatal", async () => {
    const h = harness({ status: "ready", hermesRestarts: [5] });
    h.host.seed(BASELINE_PATH, '{"restarts":');

    // No baseline means no delta, which is the same answer a first tick gives.
    expect((await h.heartbeat.once()).health.hermes).toBe(true);
    expect(parseBaseline("{ not json")).toBeNull();
    expect(parseBaseline('{"restarts":"nope","cpu":{"total":1}}')).toEqual({
      restarts: null,
      cpu: null,
    });
  });

  /**
   * The heartbeat runs every 30 s for the life of the box; an fsync'd write per
   * tick is ~2,880 writes a day to a root volume for a file whose only reader
   * is the next process. The restart counter is written the moment it changes —
   * that is the value a crash loop turns on — and the rest is periodic.
   */
  test("the baseline is not rewritten on every tick", async () => {
    const h = harness({ status: "ready", hermesRestarts: [7] });
    const writes: string[] = [];
    const write = h.host.writeFile.bind(h.host);
    h.host.writeFile = async (path, content, mode) => {
      if (path === BASELINE_PATH) writes.push(content);
      await write(path, content, mode);
    };

    for (let i = 0; i < BASELINE_WRITE_EVERY; i += 1) await h.heartbeat.once();

    // Tick 1 (a fresh box needs a baseline at once) and tick 4 (the periodic
    // refresh); ticks 2 and 3 changed nothing worth an fsync.
    expect(writes).toHaveLength(2);
  });

  test("a restart is persisted the moment it appears, not on the next refresh", async () => {
    const h = harness({ status: "ready", hermesRestarts: [7, 8] });
    await h.heartbeat.once();
    await h.heartbeat.once();

    expect(parseBaseline(h.host.files.get(BASELINE_PATH)?.content ?? "")?.restarts).toBe(8);
  });

  test("a box that cannot write its baseline still heartbeats", async () => {
    const h = harness({ status: "ready" });
    h.host.writeFile = async () => {
      throw new Error("ENOSPC: no space left on device");
    };

    // The row write is what tells hermetic this box is alive; a full disk costs
    // a stale baseline, never a heartbeat.
    expect((await h.heartbeat.once()).written).toBe(true);
  });
});

describe("which binary this box says it is running (§6.6)", () => {
  /**
   * `/proc/self/exe` is preferred over `HERMETICD_PATH` because a swap is a
   * `rename` over that path: the moment an update lands without its restart,
   * the path holds the new bytes while the process goes on executing the old
   * ones. Hashing the running inode makes "the running code" true by
   * construction instead of by having read early enough.
   */
  test("prefers the running inode over the path a swap replaces", async () => {
    const host = new FakeHost();
    await host.writeFile("/proc/self/exe", "the bytes this process is executing", "0755");
    await host.writeFile(HERMETICD_PATH, "the bytes a swap just put there", "0755");

    const running = await runningBinarySha256(host);
    const swapped = await host.sha256File(HERMETICD_PATH);
    expect(running).toBe(await host.sha256File("/proc/self/exe"));
    expect(running).not.toBe(swapped);
  });

  test("falls back to the installed path where /proc is not there", async () => {
    const host = new FakeHost();
    await host.writeFile(HERMETICD_PATH, "the only copy there is", "0755");
    expect(await runningBinarySha256(host)).toBe(await host.sha256File(HERMETICD_PATH));
  });

  /**
   * A box that cannot hash itself still heartbeats. The field is simply absent,
   * which `foundation.update`'s rollout reports as unverifiable — never as
   * agreement.
   */
  test("a box that can hash neither reports nothing rather than failing", async () => {
    expect(await runningBinarySha256(new FakeHost())).toBeNull();
  });
});

describe("which Hermes this box says it is running (§6.6)", () => {
  /**
   * The gap this closed: `agents.hermes_version` is the *pin*, written only by
   * `agents.create` and `upgrade --hermes` — and that command's own event text
   * admits the change "takes effect on the next recreate". So between the two,
   * the row named a version no box was running and every surface rendered it as
   * fact. `HeartbeatDeps` had a `hermesVersion` slot for the box's answer, and
   * no caller in `main.ts` ever passed it: dead code where the confirmation
   * should have been.
   */
  test("reports what /api/health says, which is a fact about the box", async () => {
    const h = harness({ status: "ready", hermesReports: "0.22.0" });
    await h.heartbeat.once();
    const update = h.updates().at(-1);
    expect(update?.input.ExpressionAttributeValues?.[":hv"]).toBe("0.22.0");
  });

  /**
   * A tick that could not ask has learned nothing, and writing that nothing
   * would erase a reading the fleet is using — the same rule the two Tailscale
   * fields follow. Unknown, never "running nothing".
   */
  test("a dashboard that does not answer leaves the last reading standing", async () => {
    const h = harness({ status: "ready", hermesHealthy: false });
    await h.heartbeat.once();
    const update = h.updates().at(-1);
    expect(update?.input.ExpressionAttributeValues?.[":hv"]).toBeUndefined();
  });

  /**
   * Upstream's health body is an internal format, not an API
   * (`COMPAT_MANIFEST.md`), so a shape this build does not recognise must read
   * as unknown rather than be guessed at or degrade a healthy box.
   */
  test("a body with no usable version reports nothing and stays healthy", async () => {
    const h = harness({ status: "ready", hermesReports: "" });
    const tick = await h.heartbeat.once();
    expect(tick.health.hermes).toBe(true);
    expect(h.updates().at(-1)?.input.ExpressionAttributeValues?.[":hv"]).toBeUndefined();
  });
});
