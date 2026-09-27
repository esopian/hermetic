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
import { convergeOnce } from "../src/converge.ts";
import { runConvergeLoop, type ConvergeLoopDeps } from "../src/main.ts";
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
  makeManifest,
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
function box(options: { configHash?: string; onDisk?: string | null; packed?: boolean } = {}) {
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
    const control = new AbortController();
    const deps: ConvergeLoopDeps = {
      host,
      gate,
      signal: control.signal,
      run,
      record: async (action, detail) => {
        events.push({ action, detail });
      },
      log: () => {},
    };
    return { gate, events, control, deps };
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
});
