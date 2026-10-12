/**
 * The auto-update backstop (`auto_update_hermeticd`, §6.5): while the fleet
 * manifest leaves it on, the update loop checks the manifest every
 * `AUTO_UPDATE_CHECK_MS` and installs a changed release then, instead of
 * waiting for the nightly slot. Off, the box behaves exactly as before: the
 * start-up run, the nightly slot, and `update_request`.
 *
 * The cases that matter are the ones where the backstop must do *less* than a
 * full update: nothing at all when switched off, nothing visible when nothing
 * changed, and never a second try at a release this box already refused.
 */
import { describe, expect, test } from "bun:test";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { FLEET_MANIFEST_KEY, type FleetManifest } from "@hermetic/core/schema";
import type { OpEvent } from "@hermetic/core/schema";
import { makeAws } from "../src/aws.ts";
import { BOOTSTRAP_UNIT } from "../src/bootstrap.ts";
import { FLEET_CACHE_PATH } from "../src/fleet.ts";
import { HERMETICD_PATH, STAGES_DIR } from "../src/stages.ts";
import { BOOT_ID_PATH, INSTALL_LOCK_PATH } from "../src/install-lock.ts";
import {
  EMPTY_UPDATE_STATE,
  UPDATE_STATE_PATH,
  autoUpdate,
  installErrorRelease,
  update,
  msUntilNightly,
  readUpdateState,
  writeUpdateState,
} from "../src/update/index.ts";
import { makeUpdateGate } from "../src/update-request.ts";
import { AUTO_UPDATE_CHECK_MS, UPDATE_POLL_MS, maybeUpdate, runUpdateLoop } from "../src/main.ts";
import { FakeHost } from "./fake-host.ts";
import {
  RecordingSink,
  TEST_AGENTS_TABLE,
  TEST_BUCKET,
  TEST_EVENTS_TABLE,
  TEST_NAME,
  TEST_STAGE_BODIES,
  makeFleetManifest,
  releaseFileAt,
  sha256Of,
} from "./fixtures.ts";
import { captureOutput } from "./quiet.ts";

const output = captureOutput();

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const BINARY = "ELF-hermeticd";
const NEW_BINARY = "ELF-hermeticd-0.2.0";

/** A release manifest, with the switch as given; `undefined` leaves the field out. */
function release(binary: string, auto: boolean | undefined): FleetManifest {
  const fleet = makeFleetManifest({
    version: binary === BINARY ? "0.1.0" : "0.2.0",
    stages: TEST_STAGE_BODIES,
    binary,
  });
  return auto === undefined ? fleet : { ...fleet, auto_update_hermeticd: auto };
}

/**
 * A box running `BINARY` with its stages installed and the bootstrap unit
 * finished, against a bucket whose manifest the test can swap (`publish`).
 */
function rig(initial: FleetManifest = release(BINARY, undefined)) {
  const host = new FakeHost();
  host.unitStates.set(BOOTSTRAP_UNIT, "inactive");
  host.seed(HERMETICD_PATH, BINARY, "0755");
  for (const [file, body] of Object.entries(TEST_STAGE_BODIES)) {
    host.seed(`${STAGES_DIR}/${file}`, body);
  }

  let current = initial;
  const binaries = new Map<string, string>([
    [sha256Of(BINARY), BINARY],
    [sha256Of(NEW_BINARY), NEW_BINARY],
  ]);
  const ddb = new RecordingSink();
  const s3 = new RecordingSink();
  ddb.byCommand.set("PutCommand", () => ({}));
  ddb.byCommand.set("UpdateCommand", () => ({}));
  s3.byCommand.set("GetObjectCommand", (command) => {
    const key = String((command as { input: { Key?: string } }).input.Key);
    if (key === FLEET_MANIFEST_KEY) return { Body: enc(JSON.stringify(current)) };
    const file = releaseFileAt(current, key);
    if (file === "hermeticd") {
      const body = binaries.get(current.hermeticd.files["hermeticd"]?.sha256 ?? "");
      return body === undefined ? new Error(`NoSuchKey: ${key}`) : { Body: enc(body) };
    }
    const body = file?.startsWith("stages/") === true ? TEST_STAGE_BODIES[file.slice(7)] : undefined;
    return body === undefined ? new Error(`NoSuchKey: ${key}`) : { Body: enc(body) };
  });
  const aws = makeAws({
    ddb,
    ssm: new RecordingSink(),
    s3,
    agentsTable: TEST_AGENTS_TABLE,
    eventsTable: TEST_EVENTS_TABLE,
    now: () => host.now(),
  });
  const events: OpEvent[] = [];
  const logged: string[] = [];
  const deps = {
    host,
    aws,
    name: TEST_NAME,
    bucket: TEST_BUCKET,
    hermeticdVersion: "0.1.0",
    emit: (event: OpEvent) => void events.push(event),
    log: (message: string) => void logged.push(message),
    asService: true,
  };
  const keysFetched = (): string[] =>
    s3.calls.map((c) => String((c as { input: { Key?: string } }).input.Key));
  const appended = (): Array<{ action: string; detail: string }> =>
    ddb.commandCalls(PutCommand).map((c) => c.input.Item as { action: string; detail: string });
  return {
    host,
    deps,
    events,
    logged,
    keysFetched,
    appended,
    /** Digest → the bytes S3 serves for a binary with that digest. */
    binaries,
    publish: (fleet: FleetManifest) => {
      current = fleet;
    },
  };
}

/** A box that rolled back from `NEW_BINARY` and has already said so once. */
async function refuseNewBinary(host: FakeHost): Promise<void> {
  await writeUpdateState(host, {
    ...EMPTY_UPDATE_STATE,
    failed_sha256: sha256Of(NEW_BINARY),
    failed_target: "0.2.0",
    failed_at: "2026-08-31T03:12:00.000Z",
    failed_notified: true,
  });
}

describe("autoUpdate: one backstop check", () => {
  test.each([
    ["absent (an older manifest)", undefined],
    ["true", true],
  ])("auto-update %s: a changed release is installed", async (_why, auto) => {
    const { host, deps } = rig(release(NEW_BINARY, auto));

    const result = await autoUpdate(deps);

    expect(result).not.toBe("off");
    expect(result).toMatchObject({ binaryChanged: true, restarted: true });
    expect(host.files.get(HERMETICD_PATH)?.content).toBe(NEW_BINARY);
    expect(host.restarted).toEqual(["hermeticd.service"]);
  });

  test("auto-update off: the manifest is read and nothing else happens", async () => {
    const { host, deps, events, keysFetched, appended } = rig(release(NEW_BINARY, false));

    expect(await autoUpdate(deps)).toBe("off");

    expect(keysFetched()).toEqual([FLEET_MANIFEST_KEY]);
    expect(host.files.get(HERMETICD_PATH)?.content).toBe(BINARY);
    expect(host.restarted).toEqual([]);
    // Not adopted either: a release the fleet did not ask this box to take is
    // not the manifest its other subcommands should read.
    expect(host.files.has(FLEET_CACHE_PATH)).toBe(false);
    expect(events).toEqual([]);
    expect(appended()).toEqual([]);
  });

  test("nothing changed: no event, no line, no download", async () => {
    const { host, deps, events, logged, keysFetched, appended } = rig();

    const result = await autoUpdate(deps);

    expect(result).toMatchObject({ upToDate: true, restarted: false });
    expect(keysFetched()).toEqual([FLEET_MANIFEST_KEY]);
    expect(events).toEqual([]);
    expect(logged).toEqual([]);
    expect(appended()).toEqual([]);
    expect(host.files.has(FLEET_CACHE_PATH)).toBe(true);
  });

  test("a release this box rolled back from is not reinstalled, and not re-announced", async () => {
    const { host, deps, events, keysFetched, appended } = rig(release(NEW_BINARY, true));
    await refuseNewBinary(host);

    const first = await autoUpdate(deps);
    const second = await autoUpdate(deps);

    expect(first).toMatchObject({ blocked: true, restarted: false });
    expect(second).toMatchObject({ blocked: true, restarted: false });
    expect(keysFetched().every((k) => k === FLEET_MANIFEST_KEY)).toBe(true);
    expect(host.files.get(HERMETICD_PATH)?.content).toBe(BINARY);
    expect(host.restarted).toEqual([]);
    expect(events).toEqual([]);
    expect(appended()).toEqual([]);
    expect((await readUpdateState(host)).failed_sha256).toBe(sha256Of(NEW_BINARY));
  });

  test("an un-announced refusal is announced once, as the full update does", async () => {
    const { host, deps, appended } = rig(release(NEW_BINARY, true));
    await writeUpdateState(host, {
      ...EMPTY_UPDATE_STATE,
      failed_sha256: sha256Of(NEW_BINARY),
      failed_target: "0.2.0",
    });

    await autoUpdate(deps);
    await autoUpdate(deps);

    expect(appended().map((e) => e.action)).toEqual(["update-failed"]);
  });
});

/**
 * A release whose binary never verifies: the manifest names a digest, S3
 * serves other bytes. Every attempt is a full download that ends in
 * `CHECKSUM_MISMATCH`.
 */
function brokenRelease(r: ReturnType<typeof rig>, auto: boolean | undefined = true): FleetManifest {
  const good = release(NEW_BINARY, auto);
  const entry = good.hermeticd.files["hermeticd"];
  if (!entry) throw new Error("fixture has no binary");
  const sha256 = sha256Of("the bytes the manifest promised");
  r.binaries.set(sha256, NEW_BINARY);
  return {
    ...good,
    hermeticd: {
      ...good.hermeticd,
      files: { ...good.hermeticd.files, hermeticd: { ...entry, sha256 } },
    },
  };
}

/** `release(NEW_BINARY)` as generation `generation`, with one stage digest wrong if asked. */
function generationOf(generation: string, breakStage: boolean): FleetManifest {
  const fleet = makeFleetManifest({
    version: "0.2.0",
    generation,
    stages: TEST_STAGE_BODIES,
    binary: NEW_BINARY,
  });
  if (!breakStage) return { ...fleet, auto_update_hermeticd: true };
  const [file, entry] =
    Object.entries(fleet.hermeticd.files).find(([f]) => f.startsWith("stages/")) ?? [];
  if (!file || !entry) throw new Error("fixture has no stages");
  return {
    ...fleet,
    auto_update_hermeticd: true,
    hermeticd: {
      ...fleet.hermeticd,
      files: { ...fleet.hermeticd.files, [file]: { ...entry, sha256: sha256Of("not this stage") } },
    },
  };
}

const binaryFetches = (keys: string[]): number => keys.filter((k) => k.endsWith("/hermeticd")).length;

describe("autoUpdate after a failed install", () => {
  test("backs off a release whose install failed, until the manifest names another", async () => {
    const r = rig();
    const broken = brokenRelease(r);
    r.publish(broken);

    // The first auto check tries it, downloads it, and records the failure
    // against the digest it was for.
    await expect(autoUpdate(r.deps)).rejects.toThrow(/digest|match/i);
    expect(binaryFetches(r.keysFetched())).toBe(1);
    const recorded = await readUpdateState(r.host);
    expect(recorded.last_install_error).not.toBeNull();
    expect(recorded.last_install_error_release).toBe(installErrorRelease(broken));

    // Every auto check after that reads the manifest and nothing more — and
    // says nothing, which is what every five minutes needs.
    r.events.length = 0;
    for (let i = 0; i < 3; i += 1) {
      expect(await autoUpdate(r.deps)).toMatchObject({ blocked: true, restarted: false });
    }
    expect(binaryFetches(r.keysFetched())).toBe(1);
    expect(r.events).toEqual([]);
    expect(r.logged).toEqual([]);

    // A fixed release is a different binary, so a different generation too, and
    // installs on the next check.
    r.publish(generationOf("0000000000000004", false));
    expect(await autoUpdate(r.deps)).toMatchObject({ binaryChanged: true, restarted: true });
    expect(r.host.files.get(HERMETICD_PATH)?.content).toBe(NEW_BINARY);
    expect((await readUpdateState(r.host)).last_install_error).toBeNull();
  });

  test("the nightly run, a rollout request and --force still retry it", async () => {
    const r = rig();
    r.publish(brokenRelease(r));
    await expect(autoUpdate(r.deps)).rejects.toThrow();
    expect(binaryFetches(r.keysFetched())).toBe(1);

    // `maybeUpdate` without `auto` is what the nightly slot and a request run.
    await expect(maybeUpdate(r.host, r.deps)).rejects.toThrow();
    expect(binaryFetches(r.keysFetched())).toBe(2);
    await expect(update(r.deps, { force: true })).rejects.toThrow();
    expect(binaryFetches(r.keysFetched())).toBe(3);
  });

  test("an error recorded before the digest was remembered is retried once", async () => {
    const r = rig();
    r.publish(brokenRelease(r));
    // A state file from a build that kept the message and not the digest.
    r.host.seed(
      UPDATE_STATE_PATH,
      JSON.stringify({ last_install_error: "CHECKSUM_MISMATCH: an older failure" }),
    );
    expect((await readUpdateState(r.host)).last_install_error_release).toBeNull();

    await expect(autoUpdate(r.deps)).rejects.toThrow();
    expect(await autoUpdate(r.deps)).toMatchObject({ blocked: true });
    expect(binaryFetches(r.keysFetched())).toBe(1);
  });

  test("a stage that fails its digest after the binary download is backed off too", async () => {
    const good = release(NEW_BINARY, true);
    const [file, entry] =
      Object.entries(good.hermeticd.files).find(([f]) => f.startsWith("stages/")) ?? [];
    if (!file || !entry) throw new Error("fixture has no stages");
    const r = rig();
    r.publish({
      ...good,
      hermeticd: {
        ...good.hermeticd,
        files: { ...good.hermeticd.files, [file]: { ...entry, sha256: sha256Of("not this stage") } },
      },
    });

    await expect(autoUpdate(r.deps)).rejects.toThrow();
    expect(binaryFetches(r.keysFetched())).toBe(1);
    expect(await autoUpdate(r.deps)).toMatchObject({ blocked: true });
    expect(binaryFetches(r.keysFetched())).toBe(1);
    expect(r.host.files.get(HERMETICD_PATH)?.content).toBe(BINARY);
  });
});

describe("the back-off is keyed on the release, not the binary", () => {
  test("a stage-only fix over the same binary installs on the next auto check", async () => {
    const r = rig();
    const broken = generationOf("0000000000000001", true);
    const fixed = generationOf("0000000000000002", false);
    // The premise: the fix changes the stages and nothing else.
    expect(fixed.hermeticd.files["hermeticd"]?.sha256).toBe(
      broken.hermeticd.files["hermeticd"]?.sha256 ?? "",
    );

    r.publish(broken);
    await expect(autoUpdate(r.deps)).rejects.toThrow();
    expect(await autoUpdate(r.deps)).toMatchObject({ blocked: true });

    r.publish(fixed);
    expect(await autoUpdate(r.deps)).toMatchObject({ binaryChanged: true, restarted: true });
    expect(r.host.files.get(HERMETICD_PATH)?.content).toBe(NEW_BINARY);
    expect((await readUpdateState(r.host)).last_install_error).toBeNull();
  });

  test("a manifest from before generations falls back to the binary digest", () => {
    const fleet = makeFleetManifest({ generation: null, binary: NEW_BINARY });
    expect(installErrorRelease(fleet)).toBe(sha256Of(NEW_BINARY));
    expect(installErrorRelease(makeFleetManifest({ generation: "0000000000000003" }))).toBe(
      "0000000000000003",
    );
  });
});

describe("autoUpdate while another installer holds the lock", () => {
  const BOOT = "11111111-2222-3333-4444-555555555555";
  function locked() {
    const r = rig(release(NEW_BINARY, true));
    r.host.seed(BOOT_ID_PATH, `${BOOT}\n`);
    r.host.livePids.add(4242);
    r.host.seed(
      INSTALL_LOCK_PATH,
      JSON.stringify({
        holder: "bootstrap",
        pid: 4242,
        boot_id: BOOT,
        taken_at: "2026-09-01T11:59:00Z",
      }),
    );
    return { ...r, deps: { ...r.deps, pid: 99 } };
  }

  test("the auto check stands aside without a warning", async () => {
    const { host, deps, events, logged } = locked();

    expect(await autoUpdate(deps)).toMatchObject({ blocked: true, restarted: false });
    expect(host.files.get(HERMETICD_PATH)?.content).toBe(BINARY);
    expect(events).toEqual([]);
    expect(logged).toEqual([]);
  });

  test("a full update still warns, as it always has", async () => {
    const { deps, events, logged } = locked();

    expect(await update(deps)).toMatchObject({ blocked: true });
    expect(logged.some((l) => l.includes("another installer"))).toBe(true);
    expect(events.at(-1)).toMatchObject({ level: "warn" });
  });
});

describe("maybeUpdate's auto check", () => {
  test("defers while the bootstrap unit runs, without fetching or logging", async () => {
    const { host, deps, keysFetched } = rig(release(NEW_BINARY, true));
    host.unitStates.set(BOOTSTRAP_UNIT, "activating");

    expect(await maybeUpdate(host, deps, { auto: true })).toBeNull();

    expect(keysFetched()).toEqual([]);
    expect(host.files.get(HERMETICD_PATH)?.content).toBe(BINARY);
    expect(output.stderr).toBe("");
  });

  test("runs `autoUpdate`, not the full update, once the unit is idle", async () => {
    const { host, deps } = rig(release(NEW_BINARY, false));

    expect(await maybeUpdate(host, deps, { auto: true })).toBe("off");
    // The same box, asked for a full update, still takes the release: the
    // switch gates the backstop only.
    expect(await maybeUpdate(host, deps)).toMatchObject({ binaryChanged: true });
  });
});

describe("the update loop's backstop", () => {
  /**
   * The service's own wiring (`updateLoop` in `daemon.ts`) over a rig: the
   * start-up run sees `BINARY`, then the test publishes `next`. Stops at the
   * first restart, or at `until`.
   */
  async function serveUntilRestart(next: FleetManifest, until = Number.POSITIVE_INFINITY) {
    const r = rig(release(BINARY, next.auto_update_hermeticd));
    const { host, deps } = r;
    const gate = makeUpdateGate();
    const stop = new AbortController();
    const started = host.now().getTime();
    const runs: Array<{ kind: "full" | "auto"; at: number }> = [];
    const watch = async <T>(kind: "full" | "auto", run: () => Promise<T>): Promise<T> => {
      runs.push({ kind, at: host.now().getTime() - started });
      const result = await run();
      if (runs.length === 1) r.publish(next);
      if (host.restarted.length > 0 || host.now().getTime() - started >= until) stop.abort();
      return result;
    };
    await runUpdateLoop({
      host,
      gate,
      name: TEST_NAME,
      signal: stop.signal,
      log: () => {},
      runUpdate: () => watch("full", () => maybeUpdate(host, deps)),
      runAutoCheck: () => watch("auto", () => maybeUpdate(host, deps, { auto: true })),
    });
    return { ...r, runs, started };
  }

  test("auto on: a pushed release is installed one interval later, not at the nightly slot", async () => {
    const { host, runs, started } = await serveUntilRestart(release(NEW_BINARY, undefined));

    expect(host.files.get(HERMETICD_PATH)?.content).toBe(NEW_BINARY);
    expect(runs).toEqual([
      { kind: "full", at: 0 },
      { kind: "auto", at: AUTO_UPDATE_CHECK_MS },
    ]);
    expect(AUTO_UPDATE_CHECK_MS).toBeLessThan(msUntilNightly(new Date(started), TEST_NAME));
  });

  test("auto off: nothing is installed until the nightly slot", async () => {
    const nightly = msUntilNightly(new FakeHost().now(), TEST_NAME);
    const { host, runs } = await serveUntilRestart(release(NEW_BINARY, false), nightly + 1);

    expect(host.files.get(HERMETICD_PATH)?.content).toBe(NEW_BINARY);
    // The backstop kept looking, and kept doing nothing; the install was the
    // nightly run's.
    const last = runs.at(-1);
    expect(last?.kind).toBe("full");
    expect(last?.at).toBeGreaterThanOrEqual(nightly);
    expect(last?.at).toBeLessThan(nightly + UPDATE_POLL_MS);
    expect(runs.filter((r) => r.kind === "full")).toHaveLength(2);
    expect(runs.filter((r) => r.kind === "auto").length).toBeGreaterThan(100);
  });
});

describe("the update loop's schedule with a backstop", () => {
  /** Drive the loop with stubs until `stopAt` ms of fake time have passed. */
  async function schedule(
    stopAt: number,
    stubs: { full?: () => Promise<unknown>; auto?: () => Promise<unknown> } = {},
    onStart?: (gate: ReturnType<typeof makeUpdateGate>, host: FakeHost, started: number) => void,
  ) {
    const host = new FakeHost();
    const gate = makeUpdateGate();
    const started = host.now().getTime();
    onStart?.(gate, host, started);
    const stop = new AbortController();
    const full: number[] = [];
    const auto: number[] = [];
    const lines: string[] = [];
    const tick = (into: number[], stub?: () => Promise<unknown>) => async () => {
      into.push(host.now().getTime() - started);
      if (host.now().getTime() - started >= stopAt) stop.abort();
      return stub ? await stub() : { upToDate: true };
    };
    await runUpdateLoop({
      host,
      gate,
      name: TEST_NAME,
      signal: stop.signal,
      log: (message) => void lines.push(message),
      runUpdate: tick(full, stubs.full),
      runAutoCheck: tick(auto, stubs.auto),
    });
    return { host, gate, full, auto, lines, started };
  }

  test("auto checks never move the nightly slot", async () => {
    const nightly = msUntilNightly(new FakeHost().now(), TEST_NAME);
    // Stop on the first run past the slot, whichever kind it is.
    const { full, auto } = await schedule(nightly);

    expect(full[0]).toBe(0);
    expect(full[1]).toBeGreaterThanOrEqual(nightly);
    expect(full[1]).toBeLessThan(nightly + UPDATE_POLL_MS);
    // Every interval before the slot was an auto check, evenly spaced.
    expect(auto[0]).toBe(AUTO_UPDATE_CHECK_MS);
    for (let i = 1; i < auto.length; i += 1) {
      expect(auto[i]! - auto[i - 1]!).toBe(AUTO_UPDATE_CHECK_MS);
    }
    expect(auto.at(-1)!).toBeLessThan(full[1]!);
  });

  test("a failing auto check is logged and waits a full interval", async () => {
    const { full, auto, lines } = await schedule(3 * AUTO_UPDATE_CHECK_MS, {
      auto: () => Promise.reject(new Error("s3 is having a day")),
    });

    expect(full).toEqual([0]);
    expect(auto).toEqual([AUTO_UPDATE_CHECK_MS, 2 * AUTO_UPDATE_CHECK_MS, 3 * AUTO_UPDATE_CHECK_MS]);
    expect(lines).toHaveLength(3);
    expect(lines.every((l) => l.includes("s3 is having a day"))).toBe(true);
  });

  test("a deferred auto check (bootstrap running) waits a full interval too", async () => {
    const { auto } = await schedule(2 * AUTO_UPDATE_CHECK_MS, { auto: async () => null });

    expect(auto).toEqual([AUTO_UPDATE_CHECK_MS, 2 * AUTO_UPDATE_CHECK_MS]);
  });

  test("a rollout request runs the full update, and restarts the backstop's interval", async () => {
    const requestAt = 3 * UPDATE_POLL_MS;
    const { full, auto } = await schedule(
      requestAt + AUTO_UPDATE_CHECK_MS,
      {},
      (gate, host, started) => {
        const sleep = host.sleep.bind(host);
        host.sleep = async (ms) => {
          await sleep(ms);
          if (host.now().getTime() - started === requestAt) {
            gate.onUpdateRequest({
              id: "op-1",
              hermeticd_version: "0.2.0",
              issued_at: "2026-09-04T12:00:00.000Z",
              issued_by: "evan",
            });
          }
        };
      },
    );

    // The request is served by the full update, not the backstop; the next
    // auto check counts from it rather than from the start-up run.
    expect(full).toEqual([0, requestAt]);
    expect(auto).toEqual([requestAt + AUTO_UPDATE_CHECK_MS]);
  });
});
