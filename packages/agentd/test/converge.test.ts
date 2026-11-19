/**
 * §6.5's converge receiver: the box half of a rollout.
 *
 * Two things are worth testing here and they are not the same thing. The first
 * is `convergeOnce` — does the box fetch the bundle its *row* names, write it,
 * and apply it, using the paths the stages use rather than a second set. The
 * second is `runConvergeLoop` — does a box that cannot act now keep the request,
 * does a failure stay a failure without killing the loop, and does the outcome
 * reach the event log an operator will read when the rollout says "unconverged".
 */
import { describe, expect, test } from "bun:test";
import type { ApplyRequest } from "@hermetic/core/schema";
import {
  HERMES_OPERATOR_HOLD_PATH,
  HERMES_ROLLED_BACK_PATH,
  NEEDS_OPERATOR,
  convergeOnce,
  heldResumeRequest,
  recordRolledBack,
  refuseRecorded,
} from "../src/converge.ts";
import { run } from "../src/cli.ts";
import { HERMES_HOLD_PATH } from "../src/apply/hermes-upgrade.ts";
import { FLEET_CACHE_PATH } from "../src/fleet.ts";
import { USER_DATA_JSON_PATH } from "../src/userdata.ts";
import { captureOutput } from "./quiet.ts";
import { runConvergeLoop, type ConvergeLoopDeps } from "../src/main.ts";
import { RESUME_RETRY_MS, UNSENT_FAILURE_PATH } from "../src/daemon.ts";
import { makeRequestGate } from "../src/request-gate.ts";
import { APPLIED_CONFIG_PATH, BUNDLE_DIR, INCOMING_DIR, MANIFEST_PATH } from "../src/manifest.ts";
import { AgentdError } from "../src/errors.ts";
import { BoxHost, fakeConfigBundle } from "./fake-box.ts";
import {
  RecordingSink,
  TEST_AGENTS_TABLE,
  TEST_BUCKET,
  TEST_EVENTS_TABLE,
  TEST_NAME,
  makeFleetManifest,
  makeManifest,
  makeUserDataJson,
} from "./fixtures.ts";
import { makeAws } from "../src/aws.ts";
import type { CommandSink } from "../src/aws.ts";

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

function request(overrides: Partial<ApplyRequest> = {}): ApplyRequest {
  return {
    id: "req-1",
    config_hash: "cafef00d",
    issued_at: "2026-09-10T00:00:00.000Z",
    issued_by: "arn:aws:sts::123456789012:assumed-role/Admin/session",
    ...overrides,
  };
}

/**
 * A box whose row names a bundle, with S3 serving that bundle as fixture JSON.
 *
 * `onDisk` is the config this box has *applied*: both the manifest the config
 * stage left and the record a finished apply wrote, which is what a converge
 * compares the request against.
 */
function box(
  options: {
    configHash?: string;
    onDisk?: string | null;
    packed?: boolean;
    /** The row's `apply_request`. */
    applyRequest?: ApplyRequest;
  } = {},
) {
  const host = new BoxHost();
  const manifest = { ...makeManifest(), config_hash: options.configHash ?? "cafef00d" };
  if (options.onDisk !== undefined && options.onDisk !== null) {
    host.seed(MANIFEST_PATH, JSON.stringify({ ...makeManifest(), config_hash: options.onDisk }));
    host.seed(
      APPLIED_CONFIG_PATH,
      JSON.stringify({ config_hash: options.onDisk, applied_at: "2026-09-10T00:00:00.000Z" }),
    );
  }
  if (options.onDisk === null) {
    host.seed(APPLIED_CONFIG_PATH, "{ this is not json");
  }

  const ddb = new RecordingSink();
  const ssm = new RecordingSink();
  const s3 = new RecordingSink();
  ddb.byCommand.set("GetCommand", () => ({
    Item: {
      name: TEST_NAME,
      status: "ready",
      version: 3,
      resources: { config_key: `config/${TEST_NAME}/${manifest.config_hash}.tgz`, ssm_paths: [] },
      ...(options.applyRequest ? { apply_request: options.applyRequest } : {}),
    },
  }));
  ddb.byCommand.set("UpdateCommand", () => ({}));
  ddb.byCommand.set("PutCommand", () => ({}));
  s3.byCommand.set("GetObjectCommand", () =>
    options.packed === true
      ? { Body: fakeConfigBundle(manifest) }
      : { Body: enc(JSON.stringify({ manifest })) },
  );

  const aws = makeAws({
    ddb,
    ssm,
    s3,
    agentsTable: TEST_AGENTS_TABLE,
    eventsTable: TEST_EVENTS_TABLE,
    now: () => host.now(),
  });
  const deps = {
    host,
    aws,
    name: TEST_NAME,
    bucket: TEST_BUCKET,
    paramPrefix: `/hermes/fxtr0001/${TEST_NAME}/`,
  };
  return { host, deps, manifest, s3: s3 as CommandSink };
}

const idle = async (): Promise<boolean> => false;
const busy = async (): Promise<boolean> => true;

describe("convergeOnce (§6.5)", () => {
  test("fetches the bundle the row names, writes it, and applies it", async () => {
    const { host, deps, manifest } = box();

    const outcome = await convergeOnce(deps, request(), idle);

    expect(outcome).toEqual({ kind: "applied", config_hash: manifest.config_hash });
    // The manifest on disk is what the heartbeat reads back as
    // `applied_config_hash`, which is the only thing that reports "converged".
    const written = host.files.get(MANIFEST_PATH);
    expect(written?.mode).toBe("0640");
    expect(JSON.parse(written!.content).config_hash).toBe(manifest.config_hash);
    // It really applied: the fake host saw the manifest's units enabled.
    expect(host.commands.some((c) => c.startsWith("systemctl enable"))).toBe(true);
  });

  /**
   * The same converge, against a bundle that is a tarball rather than the JSON
   * a fixture usually serves — which is the shape every real box gets.
   *
   * Unpacking a bundle writes `manifest.json`, because the bundle carries one.
   * This file unpacked into `BUNDLE_DIR`, which is where `MANIFEST_PATH` lives,
   * and then read `MANIFEST_PATH` to decide whether the incoming config was new
   * — so the answer was always "already running", no converge after the first
   * ever applied anything, and a rollout reported a fleet onto a configuration
   * no box had installed. Every existing test here passed throughout: a JSON
   * bundle takes `readBundleManifest`'s other branch and never unpacks.
   */
  test("a tarball bundle applies: unpacking it does not overwrite the applied manifest", async () => {
    const { host, deps, manifest } = box({ packed: true, onDisk: "0ldc0nf1g" });

    const outcome = await convergeOnce(deps, request(), idle);

    expect(outcome).toEqual({ kind: "applied", config_hash: manifest.config_hash });
    expect(host.commands.some((c) => c.startsWith("systemctl enable"))).toBe(true);
    // Unpacked beside the applied manifest, never over it.
    expect(host.commands.some((c) => c.includes(`tar -xzf ${INCOMING_DIR}/bundle.tgz`))).toBe(true);
    expect(host.commands.some((c) => c.includes(`-C ${BUNDLE_DIR} `))).toBe(false);
    expect(JSON.parse(host.files.get(MANIFEST_PATH)!.content).config_hash).toBe(manifest.config_hash);
  });

  /**
   * The other half of the same fix: a box that really is on the incoming config
   * still short-circuits. The hash it compares against has to be the one it had
   * before the bundle was unpacked, not the one the bundle brought with it.
   */
  test("a tarball bundle the box already runs is still a no-op", async () => {
    const { host, deps, manifest } = box({ packed: true, onDisk: "cafef00d" });

    const outcome = await convergeOnce(deps, request(), idle);

    expect(outcome).toEqual({ kind: "current", config_hash: manifest.config_hash });
    expect(host.commands.some((c) => c.startsWith("systemctl enable"))).toBe(false);
  });

  /**
   * §6.5, in the spec's own words: a failed apply "changes no status: the agent
   * is still serving the configuration it had, and its stale
   * `applied_config_hash` already reads as `drifted`".
   *
   * This file used to write the manifest *before* applying it, so the opposite
   * happened — the box's own account of its config named the config it had only
   * begun to install. Two consequences, both worse than the cosmetic one: the
   * heartbeat runs concurrently in the same process and reported the new hash
   * for the whole (possibly minutes-long) apply, and `resetForConfigDrift`
   * decides whether `agent rerun` re-runs `03-config`/`04-apply` by comparing
   * the row's hash against this file — which already matched, so the recovery
   * path skipped the very stages that would have fixed the box.
   */
  test("an apply that throws leaves the box's account of its config alone", async () => {
    const { host, deps, manifest } = box();
    // What this box was already running, and must still claim to be running.
    const before = JSON.stringify({ config_hash: "0ldc0nf1g" }, null, 2) + "\n";
    host.seed(MANIFEST_PATH, before, "0640");

    // Fail the apply partway, the way a real one does — the dpkg lock, a unit
    // that will not start — rather than by refusing at the door.
    host.handlers.push((argv) =>
      argv.join(" ").startsWith("systemctl enable")
        ? { code: 1, stdout: "", stderr: "Failed to enable unit: apt is holding the dpkg lock" }
        : null,
    );

    await expect(convergeOnce(deps, request(), idle)).rejects.toThrow();

    const written = host.files.get(MANIFEST_PATH);
    expect(written?.content).toBe(before);
    expect(JSON.parse(written!.content).config_hash).toBe("0ldc0nf1g");
    expect(JSON.parse(written!.content).config_hash).not.toBe(manifest.config_hash);
  });

  /**
   * The guard the updater takes, for the same reason: stage `04-apply` is
   * already writing these files, and two writers would race over `/etc/hermetic`
   * and over systemd.
   */
  test("defers while a bootstrap is running, and writes nothing", async () => {
    const { host, deps } = box();

    const outcome = await convergeOnce(deps, request(), busy);

    expect(outcome.kind).toBe("deferred");
    expect(host.files.has(MANIFEST_PATH)).toBe(false);
    expect(host.commands).toEqual([]);
  });

  /**
   * A box already holding the requested config has, by the only definition
   * hermetic uses, converged. Re-applying would restart units for nothing.
   */
  test("a box already running the config applies nothing", async () => {
    const { host, deps } = box({ configHash: "cafef00d", onDisk: "cafef00d" });

    const outcome = await convergeOnce(deps, request(), idle);

    expect(outcome).toEqual({ kind: "current", config_hash: "cafef00d" });
    expect(host.commands).toEqual([]);
  });

  /**
   * Holding the bundle is not running it. A box whose config stage fetched this
   * very manifest and whose apply never finished — a crash, a box last
   * configured by a hermeticd that recorded nothing — has not converged, and
   * the file it fetched must not be allowed to say otherwise.
   */
  test("a box that fetched the config but never applied it converges", async () => {
    const { host, deps, manifest } = box({ configHash: "cafef00d" });
    host.seed(MANIFEST_PATH, JSON.stringify({ ...makeManifest(), config_hash: "cafef00d" }));

    const outcome = await convergeOnce(deps, request(), idle);

    expect(outcome).toEqual({ kind: "applied", config_hash: manifest.config_hash });
    expect(host.commands.some((c) => c.startsWith("systemctl enable"))).toBe(true);
  });

  /**
   * A `manifest.json` that does not parse is a box running no configuration
   * hermetic recognises. The separate applied-config record is the source of
   * that fact now; reading it must return null rather than throw, because since
   * nothing acks a request (§6.5), the loop re-armed it on every heartbeat, so
   * the box logged a failed converge every 30 s rather than fixing itself once.
   */
  test("an unparseable applied-config record re-applies rather than throwing", async () => {
    const { host, deps, manifest } = box({ onDisk: null });

    const outcome = await convergeOnce(deps, request(), idle);

    expect(outcome).toEqual({ kind: "applied", config_hash: manifest.config_hash });
    expect(JSON.parse(host.files.get(APPLIED_CONFIG_PATH)!.content).config_hash).toBe(
      manifest.config_hash,
    );
  });

  test("a row that names no config_key is an error, not a silent skip", async () => {
    const { deps } = box();
    const ddb = new RecordingSink();
    ddb.byCommand.set("GetCommand", () => ({
      Item: { name: TEST_NAME, status: "ready", version: 3, resources: { ssm_paths: [] } },
    }));
    const aws = makeAws({
      ddb,
      ssm: new RecordingSink(),
      s3: new RecordingSink(),
      agentsTable: TEST_AGENTS_TABLE,
      eventsTable: TEST_EVENTS_TABLE,
      now: () => new Date(),
    });

    await expect(convergeOnce({ ...deps, aws }, request(), idle)).rejects.toBeInstanceOf(AgentdError);
  });
});

describe("the converge loop", () => {
  function loop(run: ConvergeLoopDeps["run"]) {
    const host = new BoxHost();
    const gate = makeRequestGate<ApplyRequest>();
    const events: Array<{ action: string; detail: string }> = [];
    const failures: Array<{ id: string; code: string }> = [];
    const control = new AbortController();
    const deps: ConvergeLoopDeps = {
      host,
      gate,
      signal: control.signal,
      run,
      record: async (action, detail) => {
        events.push({ action, detail });
      },
      reportFailure: async (failed, code) => {
        failures.push({ id: failed.id, code });
      },
      log: () => {},
    };
    return { gate, events, failures, control, deps, host };
  }

  /** The gate's wait, aborting the loop once the fake clock has run `limitMs` past the start. */
  function until(deps: ConvergeLoopDeps, control: AbortController, limitMs: number): ConvergeLoopDeps {
    const end = deps.host.now().getTime() + limitMs;
    return {
      ...deps,
      gate: {
        ...deps.gate,
        wait: async (h, ms) => {
          if (h.now().getTime() >= end) control.abort();
          await deps.gate.wait(h, ms);
        },
      },
    };
  }

  test("an applied converge lands on the agent's event log", async () => {
    const { gate, events, control, deps } = loop(async () => ({
      kind: "applied" as const,
      config_hash: "cafef00d",
    }));
    gate.onRequest(request());

    const running = runConvergeLoop(deps);
    // One turn is enough: the gate's wait is what the abort interrupts.
    await Promise.resolve();
    control.abort();
    await running;

    expect(events).toEqual([{ action: "apply", detail: "converged to config cafef00d" }]);
  });

  /**
   * The property that makes a rollout honest: a box that could not apply keeps
   * the request *and* keeps its old `applied_config_hash`, so the laptop reports
   * it unconverged rather than done.
   */
  test("a deferred request stays pending for the next tick", async () => {
    const { gate, events, control, deps } = loop(async () => ({
      kind: "deferred" as const,
      reason: "hermeticd-bootstrap.service is still running",
    }));
    gate.onRequest(request());

    const running = runConvergeLoop(deps);
    await Promise.resolve();
    control.abort();
    await running;

    expect(gate.pending()?.id).toBe("req-1");
    expect(events).toEqual([]);
  });

  test("a failure is recorded and the loop keeps running", async () => {
    let calls = 0;
    const { gate, events, control, deps } = loop(async () => {
      calls += 1;
      throw new Error("apt is holding the dpkg lock");
    });
    gate.onRequest(request());

    const running = runConvergeLoop(deps);
    await Promise.resolve();
    control.abort();
    await running;

    expect(calls).toBe(1);
    expect(events[0]?.action).toBe("apply");
    expect(events[0]?.detail).toContain("converge to config cafef00d failed");
    expect(events[0]?.detail).toContain("dpkg lock");
  });

  test("a failure is reported on the row with hermeticd's code", async () => {
    const { gate, failures, control, deps } = loop(async () => {
      throw new AgentdError("HERMES_BACKUP_FAILED", "the copy did not validate");
    });
    gate.onRequest(request());

    const running = runConvergeLoop(deps);
    await Promise.resolve();
    control.abort();
    await running;

    expect(failures).toEqual([{ id: "req-1", code: "HERMES_BACKUP_FAILED" }]);
  });

  test("a deferred or applied converge reports no failure", async () => {
    const { gate, failures, control, deps } = loop(async () => ({
      kind: "applied" as const,
      config_hash: "cafef00d",
    }));
    gate.onRequest(request());

    const running = runConvergeLoop(deps);
    await Promise.resolve();
    control.abort();
    await running;

    expect(failures).toEqual([]);
  });

  test("a held box with nothing pending asks for its resume again on the tick, after a back-off", async () => {
    const { control, deps, host } = loop(async () => {
      throw new AgentdError("COMMAND_FAILED", "uv sync: could not resolve host");
    });
    const asked: number[] = [];
    const resume = async (): Promise<ApplyRequest> => {
      asked.push(host.now().getTime());
      return request({ id: `resume-held-swap-${asked.length}` });
    };

    await runConvergeLoop(until({ ...deps, resume }, control, 3 * RESUME_RETRY_MS));

    expect(asked.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < asked.length; i += 1) {
      expect(asked[i]! - asked[i - 1]!).toBeGreaterThanOrEqual(RESUME_RETRY_MS);
    }
  });

  test("a failure that waits for an operator is not resumed by the box itself", async () => {
    const { control, deps, failures } = loop(async () => {
      throw new AgentdError("HERMES_RESTORE_FAILED", "the units stay held");
    });
    let asked = 0;
    const resume = async (): Promise<ApplyRequest> => {
      asked += 1;
      return request({ id: `resume-held-swap-${asked}` });
    };

    await runConvergeLoop(until({ ...deps, resume }, control, 3 * RESUME_RETRY_MS));

    expect(asked).toBe(1);
    expect(failures).toEqual([{ id: "resume-held-swap-1", code: "HERMES_RESTORE_FAILED" }]);
  });

  test("a failure report DynamoDB did not take is kept and sent on a later tick", async () => {
    const { gate, control, deps, host } = loop(async () => {
      throw new AgentdError("HERMES_ROLLBACK_FAILED", "the rollback failed too");
    });
    let attempts = 0;
    const sent: Array<{ id: string; code: string }> = [];
    gate.onRequest(request());

    await runConvergeLoop(
      until(
        {
          ...deps,
          reportFailure: async (failed, code) => {
            attempts += 1;
            if (attempts <= 2) throw new Error("ECONNRESET");
            sent.push({ id: failed.id, code });
          },
        },
        control,
        5 * 60_000,
      ),
    );

    expect(attempts).toBe(3);
    expect(sent).toEqual([{ id: "req-1", code: "HERMES_ROLLBACK_FAILED" }]);
    expect(host.files.has(UNSENT_FAILURE_PATH)).toBe(false);
  });
});

/**
 * The record a rollback or a failed rollback leaves (`HERMES_ROLLED_BACK_PATH`)
 * is read by every way an apply starts, and survives the process that wrote it.
 */
describe("a refused configuration outlives hermeticd", () => {
  captureOutput();

  const rolledBack = (host: BoxHost, code: "HERMES_UPGRADE_ROLLED_BACK" | "HERMES_ROLLBACK_FAILED") =>
    recordRolledBack(host, new AgentdError(code, "the swap failed"), "cafef00d", ["req-1"]);

  /** A booted box whose config stage fetched the row's config: what `04-apply` runs against. */
  function staged(applyRequest?: ApplyRequest) {
    const b = box(applyRequest ? { applyRequest } : {});
    b.host.seed(USER_DATA_JSON_PATH, makeUserDataJson());
    b.host.seed(FLEET_CACHE_PATH, JSON.stringify(makeFleetManifest()));
    b.host.seed(MANIFEST_PATH, JSON.stringify(b.manifest));
    const stage = () =>
      run(["apply"], b.host, { aws: () => b.deps.aws }).catch((e: unknown) => e as AgentdError);
    return { ...b, stage };
  }

  test("a reboot's `hermeticd apply` stage does not swap a rolled-back config again", async () => {
    for (const row of [request(), undefined]) {
      const { host, stage } = staged(row);
      await rolledBack(host, "HERMES_UPGRADE_ROLLED_BACK");
      const record = host.files.get(HERMES_ROLLED_BACK_PATH)?.content;

      expect(((await stage()) as AgentdError).code).toBe("HERMES_UPGRADE_ROLLED_BACK");
      expect(host.commands.some((c) => c.startsWith("systemctl"))).toBe(false);
      expect(host.files.get(HERMES_ROLLED_BACK_PATH)?.content).toBe(record);
    }
  });

  test("…and a new laptop request lets the stage apply it", async () => {
    const { host, stage } = staged(request({ id: "req-2" }));
    await rolledBack(host, "HERMES_UPGRADE_ROLLED_BACK");

    expect(await stage()).toBe(0);
    expect(host.commands.some((c) => c.startsWith("systemctl enable"))).toBe(true);
    expect(host.files.has(HERMES_ROLLED_BACK_PATH)).toBe(false);
  });

  test("an operator hold survives a restart: no resume, the row's request refused and reported, a new one applies", async () => {
    const { host, deps } = box({ applyRequest: request() });
    host.seed(HERMES_HOLD_PATH, "2026-09-10T00:00:00.000Z\n");
    await rolledBack(host, "HERMES_ROLLBACK_FAILED");

    // `serve` starts again: fresh loop state, and the first heartbeat re-delivers the row's request.
    expect(await heldResumeRequest(host)).toBeNull();
    const gate = makeRequestGate<ApplyRequest>();
    gate.onRequest(request());
    const control = new AbortController();
    const failures: Array<{ id: string; code: string }> = [];
    await runConvergeLoop({
      host,
      gate: { ...gate, wait: async () => control.abort() },
      signal: control.signal,
      run: (r) => convergeOnce(deps, r, idle),
      resume: () => heldResumeRequest(host),
      record: async () => {},
      reportFailure: async (failed, code) => {
        failures.push({ id: failed.id, code });
      },
      log: () => {},
    });

    expect(failures).toEqual([{ id: "req-1", code: "HERMES_ROLLBACK_FAILED" }]);
    expect(host.commands.some((c) => c.startsWith("systemctl"))).toBe(false);
    expect(host.files.has(HERMES_HOLD_PATH)).toBe(true);

    // A config with a different hash is held too: the hold is the box's, not the config's.
    host.files.delete(HERMES_HOLD_PATH);
    const other = box({ configHash: "0therc0f", applyRequest: request() });
    other.host.seed(HERMES_ROLLED_BACK_PATH, host.files.get(HERMES_ROLLED_BACK_PATH)!.content);
    const err = await convergeOnce(other.deps, request(), idle).catch((e: unknown) => e);
    expect((err as AgentdError).code).toBe("HERMES_ROLLBACK_FAILED");

    // The operator asks again.
    expect(await convergeOnce(other.deps, request({ id: "req-2" }), idle)).toMatchObject({
      kind: "applied",
    });
    expect(other.host.files.has(HERMES_ROLLED_BACK_PATH)).toBe(false);
  });

  test("an operator hold on the config the box records is refused or re-applied, never current", async () => {
    const { host, deps } = box({ onDisk: "cafef00d" });
    await rolledBack(host, "HERMES_ROLLBACK_FAILED");

    const err = await convergeOnce(deps, request(), idle).catch((e: unknown) => e);
    expect((err as AgentdError).code).toBe("HERMES_ROLLBACK_FAILED");

    expect(await convergeOnce(deps, request({ id: "req-2" }), idle)).toMatchObject({ kind: "applied" });
    expect(host.files.has(HERMES_ROLLED_BACK_PATH)).toBe(false);
  });

  test("a held box's own resume never applies a rolled-back config; a new laptop request does", async () => {
    const { host } = box();
    host.seed(HERMES_HOLD_PATH, "2026-09-10T00:00:00.000Z\n");
    await rolledBack(host, "HERMES_UPGRADE_ROLLED_BACK");
    const record = host.files.get(HERMES_ROLLED_BACK_PATH)?.content;

    const err = await refuseRecorded(host, "cafef00d", async () =>
      request({ id: "resume-held-swap-x" }),
    ).catch((e: unknown) => e);
    expect((err as AgentdError).code).toBe("HERMES_UPGRADE_ROLLED_BACK");
    expect(host.files.get(HERMES_ROLLED_BACK_PATH)?.content).toBe(record);

    // A laptop request, listed or not, still finishes or undoes the held swap.
    await refuseRecorded(host, "cafef00d", async () => request({ id: "req-2" }));
    await refuseRecorded(host, "cafef00d", async () => request());
  });

  test("an operator hold whose record cannot be written still stops the box's own resume after a restart", async () => {
    const { host } = box();
    host.seed(HERMES_HOLD_PATH, "2026-09-10T00:00:00.000Z\n");
    // req-1 (issued at 00:00) failed five minutes later.
    host.clock = new Date("2026-09-10T00:05:00.000Z");
    host.writeFaults.push((path) =>
      path === HERMES_ROLLED_BACK_PATH ? new Error("ENOSPC: no space left on device") : null,
    );
    const events: Array<{ message: string; level?: string }> = [];
    await recordRolledBack(
      host,
      new AgentdError("HERMES_RESTORE_FAILED", "the restore failed"),
      "cafef00d",
      ["req-1"],
      (e) => events.push(e),
    );
    expect(host.files.has(HERMES_ROLLED_BACK_PATH)).toBe(false);
    expect(events.some((e) => e.level === "warn" && e.message.includes("not recorded"))).toBe(true);

    // `serve` starts again with no record on disk.
    expect(await heldResumeRequest(host)).toBeNull();

    // The operator asks again: the apply let through drops the marker.
    await refuseRecorded(host, "cafef00d", async () =>
      request({ id: "req-2", issued_at: "2026-09-10T00:10:00.000Z" }),
    );
    expect(host.files.has(HERMES_OPERATOR_HOLD_PATH)).toBe(false);
    expect(await heldResumeRequest(host)).not.toBeNull();
  });

  /** req-1 failed with HERMES_RESTORE_FAILED at 00:05 and only the marker could be written. */
  async function markerOnly() {
    const b = box({ applyRequest: request() });
    const { host } = b;
    host.seed(HERMES_HOLD_PATH, "2026-09-10T00:00:00.000Z\n");
    host.clock = new Date("2026-09-10T00:05:00.000Z");
    host.writeFaults.push((path) =>
      path === HERMES_ROLLED_BACK_PATH ? new Error("ENOSPC: no space left on device") : null,
    );
    await recordRolledBack(
      host,
      new AgentdError("HERMES_RESTORE_FAILED", "the restore failed"),
      "cafef00d",
      ["req-1"],
    );
    host.writeFaults.length = 0;
    expect(host.files.has(HERMES_ROLLED_BACK_PATH)).toBe(false);
    expect(host.files.has(HERMES_OPERATOR_HOLD_PATH)).toBe(true);
    return b;
  }

  test("an unrecorded operator hold refuses the failed request re-delivered after a restart, and any request issued before it", async () => {
    const { host, deps } = await markerOnly();
    host.advance(60_000);

    for (const asked of [
      request(),
      request({ id: "req-0", issued_at: "2026-09-10T00:04:59.000Z" }),
      request({ id: "resume-held-swap-x", issued_at: "2026-09-10T00:06:00.000Z" }),
      null,
    ]) {
      const err = await refuseRecorded(host, "cafef00d", async () => asked).catch((e: unknown) => e);
      expect(NEEDS_OPERATOR.has((err as AgentdError).code)).toBe(true);
      expect(host.files.has(HERMES_OPERATOR_HOLD_PATH)).toBe(true);
    }
    // The converge the heartbeat hands over is refused before anything is applied.
    const err = await convergeOnce(deps, request(), idle).catch((e: unknown) => e);
    expect(NEEDS_OPERATOR.has((err as AgentdError).code)).toBe(true);
    expect(host.commands.some((c) => c.startsWith("systemctl"))).toBe(false);
  });

  test("…while a request issued after the hold passes it and drops the marker", async () => {
    const { host } = await markerOnly();
    await refuseRecorded(host, "cafef00d", async () =>
      request({ id: "req-2", issued_at: "2026-09-10T00:06:00.000Z" }),
    );
    expect(host.files.has(HERMES_OPERATOR_HOLD_PATH)).toBe(false);
  });

  test("a stale rolled-back record for another config does not let the failed request past the marker", async () => {
    const { host } = await markerOnly();
    host.seed(
      HERMES_ROLLED_BACK_PATH,
      `${JSON.stringify({ config_hash: "0therc0f", request_ids: ["req-0"], code: "HERMES_UPGRADE_ROLLED_BACK" })}\n`,
    );

    const err = await refuseRecorded(host, "cafef00d", async () => request()).catch((e: unknown) => e);

    expect(NEEDS_OPERATOR.has((err as AgentdError).code)).toBe(true);
    expect(host.files.has(HERMES_OPERATOR_HOLD_PATH)).toBe(true);
  });
});
