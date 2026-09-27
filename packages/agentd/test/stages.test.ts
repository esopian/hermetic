/**
 * The staged bootstrap runner (§4.2) and the oneshot unit that starts it (§4.1).
 *
 * The whole point of stages is that a failed boot is *resumable*: it names the
 * step, keeps the ones that worked, and waits to be told to try again. So most
 * of what is asserted here is about what the runner does NOT do — not re-run an
 * `ok` stage, not install a stage whose digest is wrong, not write a row update
 * per output line, not let a secret reach a log.
 */
import { describe, expect, test } from "bun:test";
import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { FLEET_MANIFEST_KEY } from "@hermetic/core/schema";
import type { FleetManifest, StageState } from "@hermetic/core/schema";
import { makeAws } from "../src/aws.ts";
import {
  LOG_TAIL_LINES,
  MARKER_DIR,
  INSTALL_TMP_PREFIX,
  STAGES_DIR,
  configBoundStages,
  formatMarker,
  installStages,
  markerPath,
  parseMarker,
  parseFacts,
  parseProgress,
  resetForConfigDrift,
  resumeStages,
  runStages,
  stageIdOf,
  stageLogPath,
} from "../src/stages.ts";
import type { StagesDeps } from "../src/stages.ts";
import { BOOTSTRAP_UNIT, BOOTSTRAP_UNIT_PATH } from "../src/bootstrap.ts";
import { APPLIED_CONFIG_PATH, MANIFEST_PATH } from "../src/manifest.ts";
import { assertTmpfs, isKnownSlot, parseArgv, run, writeSecretFile } from "../src/main.ts";
import { EXEC_ENV_ALLOWLIST, execEnv } from "../src/host.ts";
import { FakeHost } from "./fake-host.ts";
import type { StreamScript } from "./fake-host.ts";
import {
  RecordingSink,
  conditionalCheckFailed,
  TEST_AGENTS_TABLE,
  TEST_BUCKET,
  TEST_EVENTS_TABLE,
  TEST_NAME,
  TEST_STAGE_BODIES,
  makeFleetManifest,
  releaseFileAt,
  makeManifest,
  makeUserDataJson,
  sha256Of,
} from "./fixtures.ts";

const STAGE_FILES = Object.keys(TEST_STAGE_BODIES);
const STAGE_IDS = STAGE_FILES.map(stageIdOf);
const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

interface RigOptions {
  stages?: Readonly<Record<string, string>>;
  corrupt?: Readonly<Record<string, string>>;
  /** The row `getOwnRow` returns; merged over the default `creating` row. */
  row?: Record<string, unknown>;
  giveUpMs?: number;
}

function rig(options: RigOptions = {}) {
  const host = new FakeHost();
  const ddb = new RecordingSink();
  const ssm = new RecordingSink();
  const s3 = new RecordingSink();
  const bodies = options.stages ?? TEST_STAGE_BODIES;
  const fleet = makeFleetManifest({
    stages: bodies,
    ...(options.corrupt ? { corrupt: options.corrupt } : {}),
  });

  const row: Record<string, unknown> = {
    name: TEST_NAME,
    status: "creating",
    version: 1,
    resources: { config_key: `config/${TEST_NAME}/abc123def4567890.tgz`, ssm_paths: [] },
    ...options.row,
  };
  /** Rows handed back by successive `getOwnRow` calls; the last one repeats. */
  const rowQueue: Array<Record<string, unknown>> = [];

  ddb.byCommand.set("GetCommand", () => ({ Item: rowQueue.shift() ?? row }));
  ddb.byCommand.set("UpdateCommand", () => ({}));
  ddb.byCommand.set("PutCommand", () => ({}));
  s3.byCommand.set("GetObjectCommand", (command) => {
    const key = String((command as { input: { Key?: string } }).input.Key);
    if (key === FLEET_MANIFEST_KEY) return { Body: enc(JSON.stringify(fleet)) };
    // Only the objects the manifest records exist; see `releaseFileAt`.
    const file = releaseFileAt(fleet, key);
    if (file?.startsWith("stages/") === true) {
      const body = bodies[file.slice("stages/".length)];
      if (body === undefined) return new Error(`NoSuchKey: ${key}`);
      return { Body: enc(body) };
    }
    if (file === "hermeticd") return { Body: enc("ELF-hermeticd") };
    return new Error(`NoSuchKey: ${key}`);
  });

  const aws = makeAws({
    ddb,
    ssm,
    s3,
    agentsTable: TEST_AGENTS_TABLE,
    eventsTable: TEST_EVENTS_TABLE,
    now: () => host.now(),
  });

  const deps: StagesDeps = {
    host,
    aws,
    name: TEST_NAME,
    bucket: TEST_BUCKET,
    fleet,
    paramPrefix: `/hermes/${TEST_NAME}/`,
    region: "us-east-1",
    pollMs: 10,
    giveUpMs: options.giveUpMs ?? 1_000,
  };

  return { host, ddb, ssm, s3, aws, fleet, deps, row, rowQueue, bodies };
}

/** Every `UpdateCommand` that wrote `bootstrap`, in order. */
function bootstrapWrites(ddb: RecordingSink): UpdateCommand[] {
  return ddb
    .commandCalls(UpdateCommand)
    .filter((c) => c.input.ExpressionAttributeNames?.["#bootstrap"] === "bootstrap");
}

function stateOf(command: UpdateCommand): { stages: StageState[]; current: string | null } {
  return command.input.ExpressionAttributeValues?.[":bs"] as {
    stages: StageState[];
    current: string | null;
  };
}

/** The `(from…, to)` pair of every status transition, in order. */
function transitions(ddb: RecordingSink): Array<[unknown[], unknown]> {
  return ddb
    .commandCalls(UpdateCommand)
    .filter((c) => c.input.ExpressionAttributeValues?.[":to"] !== undefined)
    .map((c) => [
      Object.entries(c.input.ExpressionAttributeValues ?? {})
        .filter(([k]) => k.startsWith(":from"))
        .map(([, v]) => v),
      c.input.ExpressionAttributeValues?.[":to"],
    ]);
}

/**
 * The event items exactly as they were put, so a test can ask whether an
 * attribute is *absent* — `log_tail` is written only when there is one, and
 * "no key" is the signal readers go by.
 */
function events(
  ddb: RecordingSink,
): Array<{ action: string; detail: string | null; log_tail?: string }> {
  return ddb
    .commandCalls(PutCommand)
    .map((c) => c.input.Item as { action: string; detail: string | null; log_tail?: string });
}

/** A stage that fails the first time it is asked and succeeds the second. */
function flakyStage(file: string, stderr: string): (argv: readonly string[]) => StreamScript | null {
  let calls = 0;
  return (argv) => {
    if (!argv[1]?.endsWith(file)) return null;
    calls += 1;
    return calls === 1 ? { code: 100, lines: [{ stream: "stderr", line: stderr }] } : { lines: [] };
  };
}

/**
 * Pre-seed the markers a successful run would have left.
 *
 * `configHash` is what the config stage and everything after it ran against; a
 * marker without it is what an older hermeticd wrote, which some tests want on
 * purpose.
 */
function seedMarkers(
  host: FakeHost,
  bodies: Readonly<Record<string, string>>,
  configHash: string | null = null,
): void {
  const ids = Object.keys(bodies).map(stageIdOf);
  const bound = configBoundStages(ids.map((id) => ({ id })));
  for (const [file, body] of Object.entries(bodies)) {
    const id = stageIdOf(file);
    host.seed(markerPath(id), formatMarker(sha256Of(body), bound.has(id) ? configHash : null));
  }
}

describe("the stage runner (§4.2)", () => {
  test("fetches, verifies and runs every stage in order, then reports ready", async () => {
    const { host, ddb, deps, bodies } = rig();

    const outcome = await runStages(deps);

    expect(outcome.ok).toBe(true);
    expect(outcome.gaveUp).toBe(false);
    // Ordinal order, from the manifest — not S3 listing order, not object order.
    expect(host.streamed).toEqual(STAGE_FILES.map((f) => `bash ${STAGES_DIR}/${f}`));
    // Installed 0755, from a temp name renamed over the target.
    for (const [file, body] of Object.entries(bodies)) {
      expect(host.files.get(`${STAGES_DIR}/${file}`)?.content).toBe(body);
      expect(host.files.get(`${STAGES_DIR}/${file}`)?.mode).toBe("0755");
      expect(host.files.has(`${STAGES_DIR}/.${file}.new`)).toBe(false);
      // The marker holds the digest, which is what makes a reboot cheap.
      expect(host.files.get(markerPath(stageIdOf(file)))?.content.trim()).toBe(sha256Of(body));
    }
    expect(transitions(ddb)).toEqual([
      [["creating", "stopped", "error"], "bootstrapping"],
      [["bootstrapping"], "ready"],
    ]);
    expect(
      events(ddb)
        .filter((e) => e.action === "stage")
        .map((e) => e.detail),
    ).toEqual(STAGE_IDS.map((id) => expect.stringContaining(`${id} ok in`)));
    expect(outcome.stages.map((s) => [s.id, s.status, s.attempt])).toEqual(
      STAGE_IDS.map((id) => [id, "ok", 1]),
    );
  });

  test("the environment a stage gets is exactly the §4.3 contract", async () => {
    const { host, deps } = rig();
    await runStages(deps);

    expect(host.streamedEnv[1]).toEqual({
      HERMETIC_NAME: TEST_NAME,
      HERMETIC_REGION: "us-east-1",
      HERMETIC_BUCKET: TEST_BUCKET,
      HERMETIC_HOSTNAME: TEST_NAME,
      HERMETIC_PARAM_PREFIX: `/hermes/${TEST_NAME}/`,
      HERMETIC_DATA_MOUNT: "/data",
      HERMETIC_CONFIG_DIR: "/etc/hermetic",
      HERMETIC_STAGE: "01-tailscale",
      HERMETIC_FACTS: "/run/hermetic/facts.01-tailscale",
      HERMETICD: "/usr/local/bin/hermeticd",
    });
    // No secret is ever in a stage's environment or argv: a stage that needs
    // one asks `hermeticd stage secret` for a 0600 file on tmpfs (§8.3).
    const everything = JSON.stringify(host.streamedEnv) + host.streamed.join(" ");
    expect(everything).not.toMatch(/tskey-|sk-ant-|TOKEN|SECRET|--auth-key/i);
    // Nothing the runner did not choose to say: hermeticd's own environment
    // carries whatever cloud-init and the instance role left in it.
    for (const env of host.streamedEnv) {
      expect(Object.keys(env).every((k) => k.startsWith("HERMETIC"))).toBe(true);
    }
  });

  test("a stage's real process environment is an allowlist, not hermeticd's own", () => {
    const source = {
      PATH: "/usr/bin",
      HOME: "/root",
      AWS_SECRET_ACCESS_KEY: "should-never-be-inherited",
      BWS_ACCESS_TOKEN: "should-never-be-inherited",
      ANTHROPIC_API_KEY: "should-never-be-inherited",
    };
    const env = execEnv({ env: { HERMETIC_NAME: TEST_NAME } }, source);
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/root", HERMETIC_NAME: TEST_NAME });
    expect(EXEC_ENV_ALLOWLIST).toContain("DEBIAN_FRONTEND");
  });

  test("a reboot with every marker matching runs nothing at all", async () => {
    const { host, ddb, deps, bodies } = rig({ row: { status: "ready" } });
    seedMarkers(host, bodies);

    const outcome = await runStages(deps);

    expect(outcome.ok).toBe(true);
    expect(host.streamed).toEqual([]);
    // No row writes: the row already says `ready`, and there is nothing to add.
    expect(bootstrapWrites(ddb)).toEqual([]);
    expect(transitions(ddb)).toEqual([]);
  });

  test("a reboot whose row never reached ready gets the ready guard, and nothing else", async () => {
    const { host, ddb, deps, bodies } = rig({ row: { status: "bootstrapping" } });
    seedMarkers(host, bodies);

    await runStages(deps);

    expect(host.streamed).toEqual([]);
    // Through `bootstrapping`: `ready` is only ever entered from the state
    // that means "this boot is happening", never straight out of `error`.
    expect(transitions(ddb)).toEqual([
      [["creating", "stopped", "error"], "bootstrapping"],
      [["bootstrapping"], "ready"],
    ]);
  });

  test("a stage whose digest moved runs again; its neighbours do not", async () => {
    const { host, deps, bodies } = rig();
    seedMarkers(host, bodies);
    // A new release of 01 only: its marker holds the *previous* digest.
    host.seed(markerPath("01-tailscale"), sha256Of("something else") + "\n");

    await runStages(deps);

    expect(host.streamed).toEqual([`bash ${STAGES_DIR}/01-tailscale.sh`]);
  });

  /**
   * A failure before the first stage used to leave the row in `creating`
   * forever: no status, no `BootstrapState`, no event, and an operator with
   * nothing to look at but an instance that never reported.
   */
  test("a bad digest refuses before a single stage runs — and says so on the row", async () => {
    const { host, ddb, deps } = rig({ corrupt: { "stages/01-tailscale.sh": "0".repeat(64) } });

    await expect(runStages(deps)).rejects.toThrow(/01-tailscale\.sh does not match/);
    await expect(runStages(deps)).rejects.toMatchObject({ code: "CHECKSUM_MISMATCH" });
    // Not one stage ran, and not one file was installed — including the ones
    // whose digests were fine.
    expect(host.streamed).toEqual([]);
    expect(host.files.has(`${STAGES_DIR}/00-preflight.sh`)).toBe(false);
    expect(transitions(ddb)).toEqual([
      [["creating", "stopped", "bootstrapping"], "error"],
      [["creating", "stopped", "bootstrapping"], "error"],
    ]);
    const failure = events(ddb).find((e) => e.action === "error");
    expect(failure?.detail).toContain("01-tailscale.sh does not match");
  });

  test("a DynamoDB read that fails before the stages reports error too", async () => {
    const { host, ddb, deps } = rig();
    ddb.byCommand.set("GetCommand", () => new Error("ProvisionedThroughputExceededException"));

    await expect(runStages(deps)).rejects.toThrow(/ProvisionedThroughput/);
    expect(host.streamed).toEqual([]);
    expect(transitions(ddb)).toEqual([[["creating", "stopped", "bootstrapping"], "error"]]);
  });

  test("a pre-stage failure's message is redacted before it reaches the row", async () => {
    const { ddb, aws } = rig();
    const key = "sk-ant-" + "FIXTURE".repeat(4);
    aws.getFleetManifest = async () => {
      throw new Error(`S3 refused the request for ${key}`);
    };
    // The manifest fetch lives in bootstrap.ts; the reporter is shared.
    const { reportBootFailure } = await import("../src/stages.ts");
    await reportBootFailure(aws, TEST_NAME, new Error(`S3 refused the request for ${key}`));

    const detail = events(ddb).find((e) => e.action === "error")?.detail ?? "";
    expect(detail).toContain("«redacted»");
    expect(detail).not.toContain(key);
  });

  test("a manifest whose stage names do not order refuses with the reason", async () => {
    const { deps } = rig({
      stages: { "00-a.sh": "#!/usr/bin/env bash\n", "00-b.sh": "#!/usr/bin/env bash\n" },
    });
    await expect(runStages(deps)).rejects.toThrow(/duplicate stage ordinal 00/);
  });
});

describe("progress, facts and logs", () => {
  test("::progress lines throttle row writes but the last state is always flushed", async () => {
    const { host, ddb, deps } = rig();
    const lines = Array.from({ length: 12 }, (_, i) => ({
      stream: "stdout" as const,
      line: `::progress 0.${i} step ${i}`,
    }));
    host.streamHandlers.push((argv) =>
      argv[1]?.endsWith("00-preflight.sh") ? { lines } : { lines: [] },
    );
    // Every emitted event advances the clock a second, so the 5 s throttle is
    // exercised without a real timer.
    const emitting = { ...deps, emit: () => host.advance(1_000) };

    await runStages(emitting);

    const writes = bootstrapWrites(ddb);
    const preflight = writes.filter((c) =>
      stateOf(c).stages.some((s) => s.id === "00-preflight" && s.status !== "pending"),
    );
    // Twelve progress lines, nowhere near twelve writes.
    expect(preflight.length).toBeLessThan(lines.length);
    expect(preflight.length).toBeGreaterThan(2);
    // …and the final one is the outcome, not a throttled intermediate.
    const last = stateOf(preflight[preflight.length - 1] as UpdateCommand);
    expect(last.stages.find((s) => s.id === "00-preflight")?.status).toBe("ok");
    expect(last.current).toBeNull();
  });

  /**
   * The other half of "is this box still there?". A stage that prints nothing
   * for ten minutes — the SPA build, an apt install over a slow mirror — left
   * `bootstrap.updated_at` standing still, and `agent ps` had no way to tell
   * that from a box that had stopped answering. The runner pulses the row while
   * a stage runs, so silence is reported as silence rather than as death.
   */
  test("a stage that says nothing still pulses the row while it runs", async () => {
    const { ddb, host, deps } = rig();
    host.streamHandlers.push((argv) =>
      argv[1]?.endsWith("00-preflight.sh")
        ? { before: async () => void (await Bun.sleep(25)), lines: [] }
        : { lines: [] },
    );

    await runStages({ ...deps, pulseMs: 2 });

    // The write that marked the stage `running`, plus at least one pulse that
    // said nothing new — without the pulse there is exactly one.
    const whileRunning = bootstrapWrites(ddb).filter((c) => stateOf(c).current === "00-preflight");
    expect(whileRunning.length).toBeGreaterThan(1);
  });

  test("the pulse stops with the stage rather than outliving it", async () => {
    const { ddb, deps } = rig();

    await runStages({ ...deps, pulseMs: 1 });
    const after = bootstrapWrites(ddb).length;
    await Bun.sleep(10);

    // Nothing is still ticking once every stage has ended.
    expect(bootstrapWrites(ddb).length).toBe(after);
  });

  test("parseProgress and parseFacts read only what the contract defines", () => {
    expect(parseProgress("::progress 0.5 joining the tailnet")).toEqual({
      progress: 0.5,
      message: "joining the tailnet",
    });
    expect(parseProgress("::progress 3 clamped")?.progress).toBe(1);
    expect(parseProgress("progress 0.5 no prefix")).toBeNull();
    expect(parseProgress("::progress nope")).toBeNull();

    expect(parseFacts("tailscale_ip=100.64.0.7\n\nnot-a-fact\nk=v=w\n")).toEqual({
      tailscale_ip: "100.64.0.7",
      k: "v=w",
    });
    expect(parseFacts(null)).toEqual({});
  });

  test("a fact a stage reported becomes a row attribute in the same guarded write", async () => {
    const { host, ddb, deps } = rig();
    host.streamHandlers.push((argv, opts) =>
      argv[1]?.endsWith("01-tailscale.sh")
        ? {
            before: () => {
              host.seed(
                String(opts?.env?.["HERMETIC_FACTS"]),
                "tailscale_ip=100.64.0.7\ntailscale_dns_name=atlas-2.example.ts.net\nmood=cheerful\n",
              );
            },
            lines: [],
          }
        : null,
    );

    await runStages(deps);

    const withFact = bootstrapWrites(ddb).find(
      (c) => c.input.ExpressionAttributeNames?.["#a1"] === "tailscale_ip",
    );
    expect(withFact?.input.ExpressionAttributeValues?.[":a1"]).toBe("100.64.0.7");
    // The name goes up in the same write. It is not derivable from the agent's
    // name — a recreate whose predecessor still holds `atlas` is handed
    // `atlas-2` — so the row is the only place it can come from (§7.1).
    expect(withFact?.input.ExpressionAttributeNames?.["#a2"]).toBe("tailscale_dns_name");
    expect(withFact?.input.ExpressionAttributeValues?.[":a2"]).toBe("atlas-2.example.ts.net");
    // No `version` bump: a boot writes this dozens of times and must never
    // make an operator's CAS write lose a race it should have won (§4.2).
    expect(withFact?.input.UpdateExpression).not.toContain("#version");
    expect(withFact?.input.ConditionExpression).toBe("attribute_exists(#name)");
    // An unknown fact key is ignored rather than written blind.
    expect(withFact?.input.ExpressionAttributeNames?.["#a3"]).toBeUndefined();
  });

  test("stage output is written to a per-stage log with a header per attempt", async () => {
    const { host, deps } = rig();
    host.streamHandlers.push((argv) =>
      argv[1]?.endsWith("00-preflight.sh")
        ? {
            lines: [
              { stream: "stdout", line: "hello" },
              { stream: "stderr", line: "a warning" },
            ],
          }
        : null,
    );

    await runStages(deps);

    const log = host.files.get(stageLogPath("00-preflight"))?.content ?? "";
    expect(log).toContain("=== 00-preflight attempt 1 at ");
    expect(log).toContain("hello");
    expect(log).toContain("stderr: a warning");
    expect(host.files.get(stageLogPath("00-preflight"))?.mode).toBe("0640");
  });

  test("a failed stage's event carries the tail of its log", async () => {
    const { host, ddb, deps } = rig();
    host.streamHandlers.push((argv) =>
      argv[1]?.endsWith("01-tailscale.sh")
        ? {
            code: 7,
            lines: [
              { stream: "stdout", line: "resolving the tailnet" },
              { stream: "stdout", line: "attempt 1 of 1" },
              { stream: "stderr", line: "backend error: no route to host" },
            ],
          }
        : null,
    );

    await runStages({ ...deps, giveUpMs: 0 });

    const stageEvents = events(ddb).filter((e) => e.action === "stage");
    const failed = stageEvents.find((e) => e.detail?.includes("failed exit 7"));
    // The evidence, in the shape the log file has it — a stderr line keeps the
    // prefix that says it was stderr.
    expect(failed?.log_tail).toContain("resolving the tailnet");
    expect(failed?.log_tail).toContain("attempt 1 of 1");
    expect(failed?.log_tail).toContain("stderr: backend error: no route to host");
    // A stage that worked has nothing an operator needs to read, so its event
    // has no `log_tail` key at all — the same thing an event written before the
    // field existed looks like.
    const ok = stageEvents.filter((e) => e.detail?.includes(" ok in "));
    expect(ok.length).toBeGreaterThan(0);
    for (const e of ok) expect("log_tail" in e).toBe(false);
    // And the transition beside it says where the rest of the log is.
    const error = events(ddb).find((e) => e.action === "error");
    expect(error?.detail).toContain("the stage event carries the log tail");
    expect(error?.detail).toContain(stageLogPath("01-tailscale"));
  });

  test("the tail is bounded: a chatty stage sends its last lines, not all of them", async () => {
    const { host, ddb, deps } = rig();
    const lines = Array.from({ length: 400 }, (_, i) => ({
      stream: "stdout" as const,
      line: `line ${i + 1}`,
    }));
    host.streamHandlers.push((argv) =>
      argv[1]?.endsWith("01-tailscale.sh") ? { code: 3, lines } : null,
    );

    await runStages({ ...deps, giveUpMs: 0 });

    const failed = events(ddb).find((e) => e.detail?.includes("failed exit 3"));
    const tail = (failed?.log_tail ?? "").split("\n");
    expect(tail.length).toBe(LOG_TAIL_LINES);
    // The end is the part that says why, so it is the end that is kept.
    expect(tail.at(-1)).toBe("line 400");
    expect(tail[0]).toBe(`line ${400 - LOG_TAIL_LINES + 1}`);
  });

  test("a secret a stage prints is redacted in the tail as well as in the log", async () => {
    // FIXTURE sentinel, padded to the length a real `sk-ant-` key has.
    const key = "sk-ant-" + "FIXTURE".repeat(4);
    const { host, ddb, deps } = rig();
    host.streamHandlers.push((argv) =>
      argv[1]?.endsWith("01-tailscale.sh")
        ? {
            code: 4,
            lines: [
              { stream: "stdout", line: `exporting HERMES_API_KEY=${key}` },
              { stream: "stderr", line: `provider rejected ${key}` },
            ],
          }
        : null,
    );

    await runStages({ ...deps, giveUpMs: 0 });

    const failed = events(ddb).find((e) => e.detail?.includes("failed exit 4"));
    expect(failed?.log_tail).toContain("«redacted»");
    expect(failed?.log_tail).not.toContain(key);
    // Nothing else the run wrote carries it either.
    expect(JSON.stringify(ddb.calls.map((c) => (c as PutCommand).input))).not.toContain(key);
  });

  test("a provider key a stage prints is redacted too, not just a tailnet key", async () => {
    // FIXTURE sentinel, padded to the length a real `sk-ant-` key has.
    const key = "sk-ant-" + "FIXTURE".repeat(4);
    const { host, ddb, deps } = rig();
    host.streamHandlers.push((argv) =>
      argv[1]?.endsWith("00-preflight.sh")
        ? { code: 2, lines: [{ stream: "stderr", line: `provider rejected ${key}` }] }
        : null,
    );

    const outcome = await runStages({ ...deps, giveUpMs: 0 });

    const failed = outcome.stages.find((s) => s.id === "00-preflight");
    expect(failed?.message).toContain("«redacted»");
    expect(failed?.message).not.toContain(key);
    const written =
      JSON.stringify(ddb.calls.map((c) => (c as UpdateCommand).input)) +
      (host.files.get(stageLogPath("00-preflight"))?.content ?? "");
    expect(written).not.toContain(key);
  });

  test("a secret a stage prints is redacted before it reaches the log or the row", async () => {
    const { host, ddb, deps } = rig();
    host.streamHandlers.push((argv) =>
      argv[1]?.endsWith("01-tailscale.sh")
        ? {
            code: 1,
            lines: [{ stream: "stderr", line: "backend error: invalid key tskey-auth-kFixture123" }],
          }
        : null,
    );

    const outcome = await runStages({ ...deps, giveUpMs: 0 });

    expect(outcome.ok).toBe(false);
    const failed = outcome.stages.find((s) => s.id === "01-tailscale");
    expect(failed?.message).toContain("«redacted»");
    expect(failed?.message).not.toContain("tskey-auth-kFixture123");
    const everythingWritten =
      JSON.stringify(ddb.calls.map((c) => (c as UpdateCommand).input)) +
      (host.files.get(stageLogPath("01-tailscale"))?.content ?? "");
    expect(everythingWritten).not.toContain("tskey-auth-kFixture123");
  });
});

/**
 * `agent set` renders a new config, uploads it and writes the new `config_hash`
 * onto the row — then tells the operator it takes effect on the next rerun. It
 * did not. A resume decides a stage is done from the *stage script's* digest,
 * and `agent set` changes no scripts, so the rerun walked straight past the
 * stage that fetches the config and re-verified the box against the one it
 * already had. The box's own `/etc/hermetic/manifest.json` is what settles it.
 */
describe("a config the operator changed (§6.4)", () => {
  /** A release with a config stage and two stages that consume its output. */
  const CONFIG_STAGES: Readonly<Record<string, string>> = {
    "00-preflight.sh": "#!/usr/bin/env bash\nset -euo pipefail\necho preflight\n",
    "03-config.sh": "#!/usr/bin/env bash\nset -euo pipefail\necho config\n",
    "04-apply.sh": "#!/usr/bin/env bash\nset -euo pipefail\necho apply\n",
    "06-verify.sh": "#!/usr/bin/env bash\nset -euo pipefail\necho verify\n",
  };
  const OLD_HASH = "1111111111111111";
  const NEW_HASH = "2222222222222222";

  /** What `03-config` leaves on the box: the manifest it fetched. */
  function seedFetchedConfig(host: FakeHost, configHash: string): void {
    host.seed(MANIFEST_PATH, JSON.stringify({ ...makeManifest(), config_hash: configHash }));
  }

  /** …and what a `04-apply` that finished leaves: the config it applied. */
  function seedAppliedConfig(host: FakeHost, configHash: string): void {
    host.seed(
      APPLIED_CONFIG_PATH,
      JSON.stringify({ config_hash: configHash, applied_at: "2026-09-01T11:00:00.000Z" }),
    );
  }

  /** A box that fetched, applied and verified `configHash`, and then rebooted. */
  function seedSettledBox(host: FakeHost, configHash: string): void {
    seedMarkers(host, CONFIG_STAGES, configHash);
    seedFetchedConfig(host, configHash);
    seedAppliedConfig(host, configHash);
  }

  test("a boot whose row records a newer config re-arms the config stage and what follows", async () => {
    const { host, deps } = rig({ stages: CONFIG_STAGES, row: { config_hash: NEW_HASH } });
    seedSettledBox(host, OLD_HASH);

    const outcome = await runStages(deps);

    expect(outcome.ok).toBe(true);
    // Every marker matched, so without the config check this boot would have
    // run nothing at all.
    expect(host.streamed).toEqual([
      `bash ${STAGES_DIR}/03-config.sh`,
      `bash ${STAGES_DIR}/04-apply.sh`,
      `bash ${STAGES_DIR}/06-verify.sh`,
    ]);
  });

  test("a box already holding the row's config re-runs nothing", async () => {
    const { host, deps } = rig({ stages: CONFIG_STAGES, row: { config_hash: OLD_HASH } });
    seedSettledBox(host, OLD_HASH);

    await runStages(deps);

    expect(host.streamed).toEqual([]);
  });

  test("a rerun after `agent set` re-fetches the config before verifying again", async () => {
    const { host, deps, row, rowQueue } = rig({
      stages: CONFIG_STAGES,
      row: { config_hash: OLD_HASH },
    });
    // The stages before the failure are done; `06-verify` is not.
    seedSettledBox(host, OLD_HASH);
    host.files.delete(markerPath("06-verify"));
    // It fails once — "hermes has no model" — and passes after the new config.
    host.streamHandlers.push(flakyStage("06-verify.sh", "hermes names no model"));
    // The operator runs `agent set --model …`, which uploads a new config and
    // writes its hash on the row, and then `agent rerun`.
    rowQueue.push(row, {
      ...row,
      status: "error",
      config_hash: NEW_HASH,
      command: {
        id: "cmd-1",
        action: "rerun",
        issued_by: "evan@example.com",
        issued_at: "2026-09-01T12:00:00.000Z",
      },
    });

    const outcome = await runStages(deps);

    expect(outcome.ok).toBe(true);
    expect(host.streamed).toEqual([
      `bash ${STAGES_DIR}/06-verify.sh`,
      `bash ${STAGES_DIR}/03-config.sh`,
      `bash ${STAGES_DIR}/04-apply.sh`,
      `bash ${STAGES_DIR}/06-verify.sh`,
    ]);
  });

  test("a rerun with no config change resumes at the failure, as it always has", async () => {
    const { host, deps, row, rowQueue } = rig({
      stages: CONFIG_STAGES,
      row: { config_hash: OLD_HASH },
    });
    seedSettledBox(host, OLD_HASH);
    host.files.delete(markerPath("06-verify"));
    host.streamHandlers.push(flakyStage("06-verify.sh", "hermes is not answering yet"));
    rowQueue.push(row, {
      ...row,
      status: "error",
      command: {
        id: "cmd-1",
        action: "rerun",
        issued_by: "evan@example.com",
        issued_at: "2026-09-01T12:00:00.000Z",
      },
    });

    await runStages(deps);

    expect(host.streamed).toEqual([
      `bash ${STAGES_DIR}/06-verify.sh`,
      `bash ${STAGES_DIR}/06-verify.sh`,
    ]);
  });

  test("resetForConfigDrift touches nothing before the config stage, and nothing unless it must", async () => {
    const host = new FakeHost();
    const stages = (): StageState[] =>
      ["00-preflight", "03-config", "04-apply", "06-verify"].map((id) => ({
        id,
        status: "ok" as const,
        attempt: 1,
        started_at: null,
        ended_at: null,
        exit_code: 0,
        message: null,
      }));

    // No manifest on disk: a box that never fetched one has nothing stale.
    expect(await resetForConfigDrift(host, stages(), NEW_HASH)).toBe(false);

    host.seed(MANIFEST_PATH, JSON.stringify({ ...makeManifest(), config_hash: OLD_HASH }));
    // No hash on the row is not a mismatch either.
    expect(await resetForConfigDrift(host, stages(), null)).toBe(false);
    expect(await resetForConfigDrift(host, stages(), OLD_HASH)).toBe(false);

    const drifted = stages();
    expect(await resetForConfigDrift(host, drifted, NEW_HASH)).toBe(true);
    expect(drifted.map((st) => [st.id, st.status])).toEqual([
      ["00-preflight", "ok"],
      ["03-config", "pending"],
      ["04-apply", "pending"],
      ["06-verify", "pending"],
    ]);
  });

  /**
   * The in-memory re-arm is not enough on its own, and this is what it missed:
   * the invalidation has to be on disk before the config stage can replace
   * `/etc/hermetic/manifest.json`, or a process that dies in between leaves a
   * box whose fetched config reads as current and whose markers still say the
   * apply and the verify are done.
   */
  test("the markers go before the manifest, and the ones before the config stage stay", async () => {
    const host = new FakeHost();
    const ids = ["00-preflight", "03-config", "04-apply", "06-verify"];
    for (const id of ids) host.seed(markerPath(id), formatMarker(`sha-${id}`, null));
    seedFetchedConfig(host, OLD_HASH);
    seedAppliedConfig(host, OLD_HASH);

    const drifted: StageState[] = ids.map((id) => ({
      id,
      status: "ok" as const,
      attempt: 1,
      started_at: null,
      ended_at: null,
      exit_code: 0,
      message: null,
    }));
    expect(await resetForConfigDrift(host, drifted, NEW_HASH)).toBe(true);

    expect(host.files.has(markerPath("00-preflight"))).toBe(true);
    expect(ids.slice(1).map((id) => host.files.has(markerPath(id)))).toEqual([false, false, false]);
  });

  /**
   * The crash H16 names: the new config is fetched and the process dies before
   * `04-apply` can act on it. Everything on disk then agrees the box is current
   * — the fetched manifest holds the row's hash, and no stage *script* changed
   * — so the runner reached `ready` without the change ever being applied. The
   * markers were deleted before the fetch and the ones that remain carry the
   * config digest, so the next run does the work instead.
   */
  test("a crash after the fetch and before the apply leaves the apply owed", async () => {
    const { host, ddb, deps } = rig({ stages: CONFIG_STAGES, row: { config_hash: NEW_HASH } });
    seedSettledBox(host, OLD_HASH);
    // `03-config` fetches the new bundle and writes it out, exactly as
    // `hermeticd stage fetch-config` does; `04-apply` never returns.
    host.streamHandlers.push((argv) => {
      if (argv[1]?.endsWith("03-config.sh")) {
        return { before: () => seedFetchedConfig(host, NEW_HASH), lines: [] };
      }
      if (argv[1]?.endsWith("04-apply.sh")) {
        return {
          before: () => {
            throw new Error("the box lost power");
          },
        };
      }
      return null;
    });

    const crashed = await runStages(deps).catch((e: unknown) => e);
    expect(crashed).toBeInstanceOf(Error);
    // Fetched, not applied: nothing claims this box is running the new config,
    // and nothing has told the row it is ready.
    expect(host.files.get(MANIFEST_PATH)?.content).toContain(NEW_HASH);
    expect(host.files.get(APPLIED_CONFIG_PATH)?.content).toContain(OLD_HASH);
    expect(transitions(ddb).map(([, to]) => to)).not.toContain("ready");
    // What outlived the process: the markers for the work that is still owed
    // are gone from disk, so nothing on this box says the apply is done.
    expect(host.files.has(markerPath("04-apply"))).toBe(false);
    expect(host.files.has(markerPath("06-verify"))).toBe(false);

    // The reboot: same box, same files, a fresh runner.
    host.streamHandlers.length = 0;
    host.streamed.length = 0;
    host.streamHandlers.push((argv) =>
      argv[1]?.endsWith("03-config.sh") ? { before: () => seedFetchedConfig(host, NEW_HASH) } : null,
    );

    const outcome = await runStages(deps);

    expect(outcome.ok).toBe(true);
    // The apply and the verify run, which is the whole point; the config stage
    // runs with them because the box is still recording `OLD_HASH` as the last
    // configuration it *applied*, and re-fetching a bundle it already holds is
    // the cheap half of that.
    expect(host.streamed).toEqual([
      "bash " + STAGES_DIR + "/03-config.sh",
      "bash " + STAGES_DIR + "/04-apply.sh",
      "bash " + STAGES_DIR + "/06-verify.sh",
    ]);
    expect(transitions(ddb).map(([, to]) => to)).toContain("ready");
  });

  test("a marker records the config it ran against, and a stale one is not trusted", async () => {
    const { host, deps } = rig({ stages: CONFIG_STAGES, row: { config_hash: NEW_HASH } });
    host.streamHandlers.push((argv) =>
      argv[1]?.endsWith("03-config.sh") ? { before: () => seedFetchedConfig(host, NEW_HASH) } : null,
    );

    await runStages(deps);

    // The config stage and what follows carry the digest; `00-preflight`, which
    // has nothing to do with the config, carries only its own.
    for (const id of ["03-config", "04-apply", "06-verify"]) {
      expect(parseMarker(host.files.get(markerPath(id))?.content ?? null)?.config).toBe(NEW_HASH);
    }
    expect(parseMarker(host.files.get(markerPath("00-preflight"))?.content ?? null)?.config).toBe(null);

    // A marker naming an older config is a stage that ran against something
    // this box is no longer meant to be running…
    host.seed(
      markerPath("04-apply"),
      formatMarker(sha256Of(CONFIG_STAGES["04-apply.sh"] as string), OLD_HASH),
    );
    // …and one naming none at all is what a hermeticd before this wrote, which
    // cannot say which config it ran against at all.
    host.seed(
      markerPath("06-verify"),
      formatMarker(sha256Of(CONFIG_STAGES["06-verify.sh"] as string), null),
    );
    host.streamed.length = 0;

    await runStages(deps);

    expect(host.streamed).toEqual([
      "bash " + STAGES_DIR + "/04-apply.sh",
      "bash " + STAGES_DIR + "/06-verify.sh",
    ]);
  });
});

describe("failure, rerun and giving up (§4.2 step 7)", () => {
  const flaky = flakyStage;

  test("a failed stage reports error, waits, and a rerun resumes from it at attempt 2", async () => {
    const message = "device /dev/nvme1n1 has an unknown signature; refusing to mkfs";
    const { host, ddb, deps, row, rowQueue } = rig();
    host.streamHandlers.push(flaky("02-data-volume.sh", message));
    // The runner reads its own row once at the start; the next poll finds the
    // operator's command.
    rowQueue.push(row, {
      ...row,
      status: "error",
      command: {
        id: "cmd-1",
        action: "rerun",
        issued_by: "evan@example.com",
        issued_at: "2026-09-01T12:00:00.000Z",
      },
    });

    const outcome = await runStages(deps);

    expect(outcome.ok).toBe(true);
    // 00 and 01 were `ok` before the failure and are not run a second time.
    expect(host.streamed).toEqual([
      `bash ${STAGES_DIR}/00-preflight.sh`,
      `bash ${STAGES_DIR}/01-tailscale.sh`,
      `bash ${STAGES_DIR}/02-data-volume.sh`,
      `bash ${STAGES_DIR}/02-data-volume.sh`,
    ]);
    expect(outcome.stages.map((s) => [s.id, s.status, s.attempt])).toEqual([
      ["00-preflight", "ok", 1],
      ["01-tailscale", "ok", 1],
      ["02-data-volume", "ok", 2],
    ]);
    expect(transitions(ddb)).toEqual([
      [["creating", "stopped", "error"], "bootstrapping"],
      [["bootstrapping"], "error"],
      [["creating", "stopped", "error"], "bootstrapping"],
      [["bootstrapping"], "ready"],
    ]);
    // The failure is on the row, and named the stage.
    const failure = events(ddb).find((e) => e.detail?.includes("failed exit 100"));
    expect(failure).toMatchObject({ action: "stage" });
    expect(failure?.detail).toContain("02-data-volume failed exit 100");
    expect(failure?.detail).toContain("refusing to mkfs");
    expect(events(ddb).some((e) => e.action === "rerun")).toBe(true);
  });

  test("the rerun is acked once: last_command_id on the row, then the command cleared", async () => {
    const { host, ddb, deps, row, rowQueue } = rig();
    host.streamHandlers.push(flaky("02-data-volume.sh", "boom"));
    const command = {
      id: "cmd-1",
      action: "rerun" as const,
      issued_by: "evan@example.com",
      issued_at: "2026-09-01T12:00:00.000Z",
    };
    // The command stays on the row after the ack: the runner must act once, by
    // its own `last_command_id`, not by the row being tidied.
    rowQueue.push(row, { ...row, status: "error", command });

    await runStages(deps);

    const acked = bootstrapWrites(ddb).filter(
      (c) => (stateOf(c) as unknown as { last_command_id?: string }).last_command_id === "cmd-1",
    );
    expect(acked.length).toBeGreaterThan(0);
    const remove = ddb
      .commandCalls(UpdateCommand)
      .find((c) => c.input.UpdateExpression?.startsWith("REMOVE #command"));
    expect(remove?.input.ExpressionAttributeValues?.[":id"]).toBe("cmd-1");
    // Guarded on the id, so a second rerun issued meanwhile is not swallowed.
    expect(remove?.input.ConditionExpression).toContain("#command.#id = :id");
    expect(remove?.input.UpdateExpression).not.toContain("#version");
  });

  test("a stale command (already acked) is ignored rather than run twice", async () => {
    const { host, deps, row, rowQueue } = rig({ giveUpMs: 40 });
    host.streamHandlers.push((argv) =>
      argv[1]?.endsWith("02-data-volume.sh") ? { code: 100, lines: [] } : null,
    );
    const command = {
      id: "cmd-1",
      action: "rerun" as const,
      issued_by: "evan@example.com",
      issued_at: "2026-09-01T12:00:00.000Z",
    };
    // The row already records this very command as applied.
    rowQueue.push({
      ...row,
      bootstrap: {
        hermeticd_version: "0.1.0",
        stages: [],
        started_at: "2026-09-01T11:00:00.000Z",
        updated_at: "2026-09-01T11:00:00.000Z",
        last_command_id: "cmd-1",
      },
      command,
    });

    const outcome = await runStages(deps);

    expect(outcome.gaveUp).toBe(true);
    expect(host.streamed.filter((c) => c.includes("02-data-volume"))).toHaveLength(1);
  });

  test("no rerun inside the give-up window exits so systemd can try again", async () => {
    const { ddb, host, deps } = rig({ giveUpMs: 50 });
    host.streamHandlers.push((argv) =>
      argv[1]?.endsWith("01-tailscale.sh")
        ? { code: 3, lines: [{ stream: "stderr", line: "no tailnet" }] }
        : null,
    );

    const outcome = await runStages(deps);

    expect(outcome).toMatchObject({ ok: false, gaveUp: true });
    expect(transitions(ddb).at(-1)).toEqual([["bootstrapping"], "error"]);
    // The successful stages kept their markers: the next boot resumes at 01.
    expect(host.files.has(markerPath("00-preflight"))).toBe(true);
    expect(host.files.has(markerPath("01-tailscale"))).toBe(false);
    expect(MARKER_DIR).toBe("/var/lib/hermeticd/stages");
  });
});

describe("pruning, resuming and acking", () => {
  /**
   * §6.3: a release that drops a stage, renames it, or re-uses an ordinal for
   * something else must not leave a marker behind — a stale marker is what
   * makes the runner skip a stage that has never run on this box.
   */
  test("a dropped or renamed stage loses its file and its marker", async () => {
    const { host, deps, bodies } = rig();
    seedMarkers(host, bodies);
    // Left over from a release that had a fourth stage, and from one whose 02
    // was called something else.
    host.seed(`${STAGES_DIR}/03-old.sh`, "#!/usr/bin/env bash\n", "0755");
    host.seed(markerPath("03-old"), "deadbeef\n");
    host.seed(markerPath("02-was-called-this"), "deadbeef\n");

    await runStages(deps);

    expect(host.files.has(`${STAGES_DIR}/03-old.sh`)).toBe(false);
    expect(host.files.has(markerPath("03-old"))).toBe(false);
    expect(host.files.has(markerPath("02-was-called-this"))).toBe(false);
    // The stages this release does name are untouched.
    expect(host.files.has(markerPath("02-data-volume"))).toBe(true);
  });

  test("an ordinal re-used for a different stage runs, rather than reading as ok", async () => {
    const renamed = {
      "00-preflight.sh": TEST_STAGE_BODIES["00-preflight.sh"] as string,
      "01-tailscale.sh": TEST_STAGE_BODIES["01-tailscale.sh"] as string,
      "02-storage.sh": "#!/usr/bin/env bash\nset -euo pipefail\necho storage\n",
    };
    const { host, deps } = rig({ stages: renamed });
    // The box last booted a release whose 02 was `02-data-volume`.
    seedMarkers(host, TEST_STAGE_BODIES);

    await runStages(deps);

    expect(host.streamed).toEqual([`bash ${STAGES_DIR}/02-storage.sh`]);
    expect(host.files.has(markerPath("02-data-volume"))).toBe(false);
  });

  /**
   * §10: a systemd restart of the boot unit re-enters the runner. Wiping the
   * message would leave the row saying a stage is `pending` with no reason,
   * losing the one line that says why the boot stopped.
   */
  test("a restart carries the previous failure's reason forward", async () => {
    const { host, deps, bodies } = rig();
    const prior = {
      hermeticd_version: "0.1.0",
      stages: [
        { id: "00-preflight", status: "ok" as const, attempt: 1 },
        {
          id: "01-tailscale",
          status: "failed" as const,
          attempt: 2,
          exit_code: 100,
          message: "backend error: tailnet is full",
        },
        { id: "02-data-volume", status: "pending" as const, attempt: 0 },
      ],
      started_at: "2026-09-01T11:00:00.000Z",
      updated_at: "2026-09-01T11:00:00.000Z",
    };
    const stages = await installStages({ host, aws: deps.aws, bucket: TEST_BUCKET, fleet: deps.fleet });
    host.seed(markerPath("00-preflight"), sha256Of(bodies["00-preflight.sh"] as string) + "\n");

    const resumed = await resumeStages(host, stages, prior);

    expect(resumed[0]).toMatchObject({ id: "00-preflight", status: "ok", message: null });
    expect(resumed[1]).toMatchObject({
      id: "01-tailscale",
      status: "pending",
      attempt: 2,
      exit_code: 100,
      message: "backend error: tailnet is full",
    });
    expect(resumed[2]).toMatchObject({ id: "02-data-volume", message: null });
  });

  /**
   * §6.5: an ack that never reached DynamoDB leaves a command the UI keeps
   * showing as pending. A thrown error is a call that did not happen and is
   * worth retrying; `false` is the row saying the command is already gone.
   */
  test("an ack that fails to reach DynamoDB is retried", async () => {
    const { host, ddb, deps, row, rowQueue } = rig();
    host.streamHandlers.push(flakyStage("02-data-volume.sh", "boom"));
    let removes = 0;
    ddb.byCommand.set("UpdateCommand", (command) => {
      const update = (command as UpdateCommand).input.UpdateExpression ?? "";
      if (!update.startsWith("REMOVE #command")) return {};
      removes += 1;
      return removes === 1 ? new Error("ThrottlingException") : {};
    });
    rowQueue.push(row, {
      ...row,
      status: "error",
      command: {
        id: "cmd-1",
        action: "rerun",
        issued_by: "evan@example.com",
        issued_at: "2026-09-01T12:00:00.000Z",
      },
    });

    const outcome = await runStages(deps);

    expect(outcome.ok).toBe(true);
    expect(removes).toBe(2);
  });

  test("an ack the row refuses is NOT retried — the command has moved on", async () => {
    const { host, ddb, deps, row, rowQueue } = rig();
    host.streamHandlers.push(flakyStage("02-data-volume.sh", "boom"));
    let removes = 0;
    ddb.byCommand.set("UpdateCommand", (command) => {
      const update = (command as UpdateCommand).input.UpdateExpression ?? "";
      if (!update.startsWith("REMOVE #command")) return {};
      removes += 1;
      return conditionalCheckFailed();
    });
    rowQueue.push(row, {
      ...row,
      status: "error",
      command: {
        id: "cmd-1",
        action: "rerun",
        issued_by: "evan@example.com",
        issued_at: "2026-09-01T12:00:00.000Z",
      },
    });

    await runStages(deps);

    expect(removes).toBe(1);
  });
});

describe("installStages", () => {
  test("re-installing is idempotent and leaves no temp files behind", async () => {
    const { host, aws, fleet, bodies } = rig();
    const first = await installStages({ host, aws, bucket: TEST_BUCKET, fleet });
    const second = await installStages({ host, aws, bucket: TEST_BUCKET, fleet });

    expect(second).toEqual(first);
    expect(first.map((s) => s.id)).toEqual(STAGE_IDS);
    expect(first[0]?.sha256).toBe(sha256Of(bodies["00-preflight.sh"] as string));
    expect([...host.files.keys()].filter((k) => k.includes("/.")).length).toBe(0);
  });

  /**
   * `05-service` starts hermeticd.service, whose update loop runs immediately —
   * while this runner is still in `05`/`06`. Two installers sharing one temp
   * name would have each other's half-written files renamed and pruned out from
   * under them.
   */
  test("temps go in a per-process directory, never beside the target", async () => {
    const { host, aws, fleet } = rig();
    const seen: string[] = [];
    const originalRename = host.rename.bind(host);
    host.rename = async (from: string, to: string) => {
      seen.push(from);
      await originalRename(from, to);
    };

    await installStages({ host, aws, bucket: TEST_BUCKET, fleet });

    for (const from of seen) {
      expect(from.startsWith(`${STAGES_DIR}/${INSTALL_TMP_PREFIX}`)).toBe(true);
      expect(from).not.toMatch(/\.new$/);
    }
    // …and the scratch directory does not outlive the install.
    expect([...host.files.keys()].some((k) => k.includes(INSTALL_TMP_PREFIX))).toBe(false);
  });

  test("a concurrent installer's scratch directory survives prune", async () => {
    const { host, deps } = rig();
    // Another process, mid-install.
    host.seed(`${STAGES_DIR}/${INSTALL_TMP_PREFIX}9999/01-tailscale.sh`, "#!/usr/bin/env bash\n");
    host.seed(`${MARKER_DIR}/.tmp-marker`, "in flight");

    await runStages(deps);

    expect(host.files.has(`${STAGES_DIR}/${INSTALL_TMP_PREFIX}9999/01-tailscale.sh`)).toBe(true);
    expect(host.files.has(`${MARKER_DIR}/.tmp-marker`)).toBe(true);
  });

  test("a release that names no stages is refused rather than booting into nothing", async () => {
    const { host, aws } = rig();
    const empty = makeFleetManifest({ stages: {} }) as FleetManifest;
    await expect(installStages({ host, aws, bucket: TEST_BUCKET, fleet: empty })).rejects.toThrow(
      /names no stages/,
    );
  });
});

describe("the oneshot unit (§4.1)", () => {
  test("`bootstrap --install` writes the unit and starts it without blocking", async () => {
    const host = new FakeHost();

    expect(await run(["bootstrap", "--install"], host)).toBe(0);

    const unit = host.files.get(BOOTSTRAP_UNIT_PATH)?.content ?? "";
    expect(unit).toContain("Type=oneshot");
    expect(unit).toContain("ExecStart=/usr/local/bin/hermeticd bootstrap");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("RestartSec=60");
    expect(unit).toContain("After=network-online.target");
    expect(unit).toContain("Wants=network-online.target");
    // `journal+console`: a boot that fails before the tailnet is up, or before
    // it can write its row, is readable only through `ec2:GetConsoleOutput`.
    expect(unit).toContain("StandardOutput=journal+console");
    expect(unit).toContain("StandardError=journal+console");
    // No `RemainAfterExit`: the unit stays re-triggerable, so `systemctl start
    // hermeticd-bootstrap` from an SSH session actually runs the boot again.
    expect(unit).not.toContain("RemainAfterExit");
    expect(host.files.get(BOOTSTRAP_UNIT_PATH)?.mode).toBe("0644");
    expect(host.daemonReloads).toHaveLength(1);
    // `--no-block`: cloud-init called us, and a boot takes minutes.
    expect(host.commands.at(-1)).toBe(`systemctl enable --now --no-block ${BOOTSTRAP_UNIT}`);
  });
});

describe("argument parsing", () => {
  test("handles --flag value, --flag=value and bare --flag", () => {
    expect(parseArgv(["apply", "--manifest", "/tmp/m.json", "--dry-run"])).toEqual({
      command: "apply",
      sub: null,
      flags: { manifest: "/tmp/m.json", "dry-run": true },
      rest: [],
    });
    expect(parseArgv(["secrets", "materialise", "--out=/run/x.env"])).toEqual({
      command: "secrets",
      sub: "materialise",
      flags: { out: "/run/x.env" },
      rest: [],
    });
    expect(parseArgv(["stage", "secret", "--slot", "ts-key", "--out", "/run/k"])).toEqual({
      command: "stage",
      sub: "secret",
      flags: { slot: "ts-key", out: "/run/k" },
      rest: [],
    });
    expect(parseArgv([]).command).toBe("");
  });

  test("`stage secret` refuses a slot it does not own, before touching AWS", async () => {
    const host = new FakeHost();
    await expect(
      run(["stage", "secret", "--slot", "root-password", "--out", "/run/k"], host),
    ).rejects.toThrow(/--slot <ts-key\|bws-token\|provider-key\|provider-key-<profile>-r<N>>/);
    expect(host.commands).toEqual([]);
  });

  /**
   * §8.3: `provider-key` is a family, and the usage line has to say so. A stage
   * on a profile-bound agent is handed `provider-key-<profile_id>-r<revision>`
   * by the manifest, so a usage line naming only the three fixed slots would
   * tell an operator the slot their own configuration names is not a slot.
   */
  test("`stage secret` usage names the revision-slot family it accepts", async () => {
    const host = new FakeHost();
    await expect(
      run(["stage", "secret", "--slot", "provider-key-rX", "--out", "/run/k"], host),
    ).rejects.toThrow(/provider-key-<profile>-r<N>/);
    // And the family itself is accepted, so the usage line is not promising
    // something the guard refuses. The profile id is part of the name: the
    // revision alone is not a slot, because every profile's revisions start at 1.
    expect(isKnownSlot("provider-key-ant00001-r7")).toBe(true);
    expect(isKnownSlot("provider-key-r7")).toBe(false);
    expect(host.commands).toEqual([]);
  });

  test.each([
    "/etc/hermetic/key",
    // `/run/../etc/shadow` starts with `/run/` and is not on tmpfs. A stage's
    // variable expansion is exactly where a path like that comes from.
    "/run/../etc/shadow",
    "/run/hermetic/../../etc/x",
    "run/hermetic/key",
  ])("`stage secret` refuses to write to %s", async (out) => {
    const host = new FakeHost();
    await expect(run(["stage", "secret", "--slot", "ts-key", "--out", out], host)).rejects.toThrow(
      /runtime secrets live under \/run/,
    );
    expect(host.files.size).toBe(0);
  });

  test("assertTmpfs accepts a plain tmpfs path and nothing that resolves off it", () => {
    expect(() => assertTmpfs("/run/hermetic/ts-authkey")).not.toThrow();
    expect(() => assertTmpfs("/run/../run/hermetic/k")).toThrow();
    expect(() => assertTmpfs("/runaway/k")).toThrow();
  });

  /**
   * §8.3: a 0600 file inside a 0755 directory is enumerable by every account on
   * the box. `mkdir` honours the umask and leaves an existing directory alone,
   * so the mode is set explicitly.
   */
  test("a secret lands 0600 in a 0700 directory, even one that already existed", async () => {
    const host = new FakeHost();
    host.dirs.add("/run/hermetic");

    await writeSecretFile(host, "/run/hermetic/ts-authkey", "tskey-auth-kFIXTURE");

    expect(host.files.get("/run/hermetic/ts-authkey")?.mode).toBe("0600");
    expect(host.chmods).toContainEqual(["/run/hermetic", "0700"]);
  });

  test("`heartbeat` on a box that has never booted names the missing cache", async () => {
    const host = new FakeHost();
    host.seed("/var/lib/cloud/instance/hermetic.json", makeUserDataJson());

    await expect(run(["heartbeat", "--once"], host)).rejects.toThrow(
      /no fleet manifest cache at \/var\/lib\/hermeticd\/fleet\.json; run `hermeticd bootstrap` first/,
    );
  });
});
