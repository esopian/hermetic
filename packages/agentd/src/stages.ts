/**
 * The staged bootstrap runner (§4.2). `hermeticd bootstrap` fetches an ordered
 * set of bash stages from the fleet bucket and runs them, one at a time, while
 * reporting exactly where the boot is on the agent's own DynamoDB row.
 *
 * Why stages at all: a first boot is a dozen unrelated things — hostname,
 * tailnet, disk, config, packages, units — and the old single `bootstrap()`
 * could only ever say "it failed". A stage has an id, a marker, a log file and a
 * row entry, so a failed boot names the step, keeps the successful ones, and can
 * be resumed by an operator with `hermetic agent rerun` rather than rebuilt.
 *
 * Three properties are load-bearing:
 *
 *  - **Digests before anything runs.** Every stage is fetched and verified
 *    against the fleet manifest before a single byte is installed, so a
 *    tampered or truncated release fails with the file name rather than half
 *    executing.
 *  - **Markers make a reboot cheap, and bind to the config.**
 *    `/var/lib/hermeticd/stages/<id>.ok` holds the sha256 of the stage that
 *    wrote it, and — from the config stage down — the `config_hash` it ran
 *    against. A reboot with every marker matching exits without running
 *    anything; a marker whose digest no longer matches is a new release of that
 *    stage, and one whose config no longer matches is the same stage with new
 *    work to do. Both run again.
 *  - **A failure stays resident.** The runner does not exit on a failed stage:
 *    it reports `error` and then polls its own row for a `rerun` command for up
 *    to 24 hours, because the operator's next move is nearly always "look at
 *    the log, fix the thing, run it again" and a dead process cannot resume.
 */
import { createHash } from "node:crypto";
import type { BootstrapState, FleetManifest, OpEvent, StageState } from "@hermetic/core/schema";
import { isReleaseObjectKey, orderStages } from "@hermetic/core/shared";
import type { Aws } from "./aws.ts";
import type { Host } from "./host.ts";
import { DATA_MOUNT } from "./disk.ts";
import { STATE_DIR } from "./fleet.ts";
import { BUNDLE_DIR, readAppliedConfigHash, readFetchedConfigHash } from "./manifest.ts";
import type { Emit } from "./events.ts";
import { opEvent } from "./events.ts";
import { redactValue } from "./redact.ts";
import { AgentdError } from "./errors.ts";

/** Where a verified release's stages are installed. Root-owned, 0755. */
export const STAGES_DIR = "/opt/hermetic/stages";
/**
 * `<id>.ok` holds the sha256 of the stage that succeeded, and — for a stage
 * that consumes the agent config — the config digest it succeeded against.
 */
export const MARKER_DIR = `${STATE_DIR}/stages`;
/** One append-only log per stage, with a header line per attempt. */
export const STAGE_LOG_DIR = "/var/log/hermetic/stages";
/** tmpfs: a stage's facts, and the only place a stage may leave a secret. */
export const FACTS_DIR = "/run/hermetic";
/** Where cloud-init put the binary; stages call it as `$HERMETICD`. */
export const HERMETICD_PATH = "/usr/local/bin/hermeticd";
/** Per-process install scratch under `STAGES_DIR`; `prune` never touches it. */
export const INSTALL_TMP_PREFIX = ".install-";

/**
 * A busy stage can emit `::progress` every few lines. One row write per line
 * would be hundreds of DynamoDB updates per boot for a bar that moves smoothly
 * either way, so writes are throttled — and the last one is always flushed, so
 * the row never rests on a stale message.
 */
export const PROGRESS_THROTTLE_MS = 5_000;
/**
 * How often a stage that is saying *nothing* still refreshes its row.
 *
 * A stage reports by printing `::progress`, and the honest ones do — but the
 * long ones are long precisely because they are waiting on something that does
 * not print: `npm ci && npm run build` of the Hermes SPA, an apt install
 * through a slow mirror, a docker pull. During that silence the row's
 * `bootstrap.updated_at` stood still, and `agent ps` — which has to decide
 * "still working" from "stopped answering" with nothing else to go on — read a
 * healthy box as `unreachable`.
 *
 * So the runner says so itself, once a minute, with no new content: the row
 * moves, `deriveDisplayStatus` sees a box that is still there, and a stage that
 * really has died still ages past `BOOTSTRAP_STALE_MS`. One extra write a
 * minute, against a throttle that already permits one every five seconds.
 */
export const LIVENESS_PULSE_MS = 60_000;
/** How often a failed runner looks at its row for an operator `rerun`. */
export const COMMAND_POLL_MS = 10_000;
/**
 * After a day nobody is coming. Exit 1 and let systemd's `Restart=on-failure`
 * try again; the markers make that a resume rather than a restart.
 */
export const GIVE_UP_MS = 24 * 60 * 60_000;

/**
 * The `HERMETIC_FACTS` keys the runner is willing to put on the row.
 *
 * `tailscale_dns_name` is here because it is not derivable from the name: a
 * recreate whose predecessor still holds `<name>` in the tailnet's device list
 * is given `<name>-2`, and that suffixed name is what `serve` publishes and
 * what the certificate is for. The row has to carry the real one.
 */
const FACT_ATTRIBUTES = new Set(["tailscale_ip", "tailscale_dns_name"]);

/** `StageState.message` is bounded by the schema; so is what we put in it. */
const MESSAGE_MAX = 512;

/**
 * How many of a failed stage's last log lines ride out on its event (§4.2).
 *
 * A hundred and twenty is about a screen and a half — enough to hold the
 * command that failed, its output and whatever the stage said on the way in,
 * which is the span an operator actually reads. The whole log stays on the box;
 * this is the part they would have scrolled to.
 */
export const LOG_TAIL_LINES = 120;
/**
 * …and the hard ceiling on that tail in bytes, because one line is not a
 * bounded thing: a stage that prints a base64 blob or a minified stack could
 * put megabytes on a DynamoDB item (400 KiB max) through 120 lines alone. The
 * two caps are applied together — oldest lines go until both hold.
 */
export const LOG_TAIL_BYTES = 16 * 1024;

/** One stage of a verified release, as installed on the box. */
export interface Stage {
  /** The file name minus `.sh`, e.g. `01-tailscale`. */
  readonly id: string;
  readonly file: string;
  readonly path: string;
  readonly sha256: string;
}

export interface StagesDeps {
  readonly host: Host;
  readonly aws: Aws;
  readonly name: string;
  /**
   * The name this node registers with the tailnet — `<fleet id>-<agent>` since
   * foundation v4, and `<fleet name>-<agent>` under v3. Absent on a pre-v3 box,
   * where it is the agent name. Whatever it is, it is fixed at first boot: a
   * node keeps the name it registered with until it is rebuilt.
   */
  readonly hostname?: string;
  readonly bucket: string;
  readonly fleet: FleetManifest;
  /** This agent's own SSM prefix, `/hermes/<fleet_id>/<name>/` since foundation v4. */
  readonly paramPrefix: string;
  readonly region: string;
  readonly emit?: Emit;
  /** Stage output, passed through verbatim to the runner's stdout (journald). */
  readonly log?: (line: string) => void;
  /** Test seams; the defaults are the constants above. */
  readonly pollMs?: number;
  readonly giveUpMs?: number;
  /** How often the liveness pulse fires while a stage runs. */
  readonly pulseMs?: number;
}

export interface StagesOutcome {
  readonly ok: boolean;
  /** True when a stage failed and no `rerun` arrived within 24 h. */
  readonly gaveUp: boolean;
  readonly stages: readonly StageState[];
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function stageIdOf(file: string): string {
  return file.replace(/\.sh$/, "");
}

export function markerPath(id: string): string {
  return `${MARKER_DIR}/${id}.ok`;
}

/**
 * What a completion marker says: the digest of the stage script that wrote it,
 * and — for a stage downstream of the config stage — the `config_hash` it ran
 * against.
 *
 * The second line is what makes a marker a statement about *this* configuration
 * rather than only about the script. Without it, "done" meant "a stage with
 * these bytes succeeded here once", which stays true across a config change
 * that the stage exists to apply, and a resume walked past the very work the
 * change required.
 */
export interface StageMarker {
  readonly sha256: string;
  /** `null` on a stage that does not consume the config, and on a pre-config marker. */
  readonly config: string | null;
}

export function formatMarker(sha256: string, config: string | null): string {
  return config === null ? `${sha256}\n` : `${sha256}\nconfig=${config}\n`;
}

/** `null` for a marker that names no digest at all — a truncated or empty file. */
export function parseMarker(text: string | null): StageMarker | null {
  if (text === null) return null;
  let sha: string | null = null;
  let config: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    if (line.startsWith("config=")) {
      config = line.slice("config=".length) || null;
      continue;
    }
    sha ??= line;
  }
  return sha === null ? null : { sha256: sha, config };
}

/**
 * Is this stage done, as the marker on disk tells it?
 *
 * Two questions, and a config-dependent stage has to answer both: the script
 * that succeeded must be the script this release installs, and the config it
 * succeeded against must be the config the fleet is asking for. A marker with
 * no config line fails the second for a stage that needs it — that is a marker
 * an older hermeticd wrote, and it cannot say which configuration it ran
 * against, so the honest reading is "run it again".
 *
 * `configHash` is `null` on a box whose fleet names no configuration at all
 * (a pre-config row, a release without the config stage), and there the digest
 * is the whole question, exactly as it was.
 */
export function stageDone(
  marker: StageMarker | null,
  stage: Stage,
  options: { readonly configBound: boolean; readonly configHash: string | null },
): boolean {
  if (marker === null || marker.sha256 !== stage.sha256) return false;
  if (!options.configBound || options.configHash === null) return true;
  return marker.config === options.configHash;
}

export function stageLogPath(id: string): string {
  return `${STAGE_LOG_DIR}/${id}.log`;
}

export function factsPath(id: string): string {
  return `${FACTS_DIR}/facts.${id}`;
}

/**
 * `::progress <0..1> <message>` — the one thing a stage says to the runner
 * rather than to the log. Anything else on stdout is just output.
 */
export function parseProgress(line: string): { progress: number; message: string } | null {
  const match = /^::progress (\d*\.?\d+) (.*)$/.exec(line.trim());
  if (!match?.[1] || match[2] === undefined) return null;
  const progress = Number(match[1]);
  if (!Number.isFinite(progress)) return null;
  return { progress: Math.min(1, Math.max(0, progress)), message: match[2] };
}

/** `key=value` lines. Unknown keys are ignored, not rejected — stages evolve. */
export function parseFacts(text: string | null): Record<string, string> {
  const facts: Record<string, string> = {};
  for (const line of (text ?? "").split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key.length > 0 && value.length > 0) facts[key] = value;
  }
  return facts;
}

/** The environment every stage gets (§4.3). No secret is ever in it. */
export function stageEnv(deps: StagesDeps, id: string): Record<string, string> {
  return {
    HERMETIC_NAME: deps.name,
    // The tailnet/OS hostname, which is the agent name only on a pre-v3 fleet.
    // `HERMETIC_NAME` stays the agent name for everything else — SSM slots,
    // the DynamoDB row, log lines — so a stage never has to know the difference.
    HERMETIC_HOSTNAME: deps.hostname ?? deps.name,
    HERMETIC_REGION: deps.region,
    HERMETIC_BUCKET: deps.bucket,
    HERMETIC_PARAM_PREFIX: deps.paramPrefix,
    HERMETIC_DATA_MOUNT: DATA_MOUNT,
    HERMETIC_CONFIG_DIR: BUNDLE_DIR,
    HERMETIC_STAGE: id,
    HERMETIC_FACTS: factsPath(id),
    HERMETICD: HERMETICD_PATH,
  };
}

/**
 * The release's stage files, ordered, with the object key and the digest each
 * must have.
 *
 * The **key comes from the manifest**, never from `releaseKey(version, …)`.
 * That rebuild was correct only while a version named exactly one set of
 * objects, and it stopped being so the moment releases became immutable
 * generations (`artifacts/<version>/<generation>/…`): a box that recomputed the
 * key would fetch whatever the flat path happened to hold and check it against
 * a digest recorded for a different set of bytes. A manifest is a document the
 * box obeys, so the box reads the objects it names and no others.
 */
export function releaseStages(
  fleet: FleetManifest,
): Array<{ file: string; key: string; sha256: string }> {
  const prefixed = Object.entries(fleet.hermeticd.files).filter(([key]) => key.startsWith("stages/"));
  if (prefixed.length === 0) {
    throw new AgentdError(
      "INTERNAL",
      `the fleet manifest names no stages for hermeticd ${fleet.hermeticd.version}`,
      { version: fleet.hermeticd.version },
    );
  }
  const byFile = new Map(prefixed.map(([key, entry]) => [key.slice("stages/".length), entry]));
  let ordered: string[];
  try {
    ordered = orderStages([...byFile.keys()]);
  } catch (e) {
    throw new AgentdError(
      "INTERNAL",
      `the fleet manifest's stage list is invalid: ${e instanceof Error ? e.message : String(e)}`,
      { version: fleet.hermeticd.version },
    );
  }
  return ordered.map((file) => {
    const entry = byFile.get(file) as { key: string; sha256: string };
    const key = releaseObjectKey(
      fleet.hermeticd.version,
      `stages/${file}`,
      entry.key,
      fleet.hermeticd.generation,
    );
    return { file, key, sha256: entry.sha256 };
  });
}

/**
 * The key the manifest records for one release file, checked before it is used.
 *
 * The check is the point. "Fetch exactly the objects the manifest records" must
 * not widen into "fetch any key in the bucket the manifest names": the box has
 * `GetObject` on `config/*` and `hermes/*` too, and a manifest that named one of
 * those for a stage would have the box run somebody's config tarball as root.
 * `isReleaseObjectKey` is core's rule, imported rather than restated, so the
 * writer and the reader cannot drift. It is scoped to the release the manifest
 * says the fleet is on — both halves of it: the `version`, so a manifest cannot
 * claim one version while handing the box the objects of another, and the
 * `generation` when the manifest records one, so it cannot claim one generation
 * of that version while handing the box the binary of an earlier one.
 */
export function releaseObjectKey(
  version: string,
  file: string,
  key: string,
  generation?: string,
): string {
  if (isReleaseObjectKey(key, version, generation)) return key;
  throw new AgentdError(
    "MANIFEST_REFUSED",
    `the fleet manifest records ${file} of hermeticd ${version} at ${key}, which is not an object of that release; refusing to fetch it`,
    { version, file, key, ...(generation === undefined ? {} : { generation }) },
  );
}

/**
 * Fetch, verify and install the release's stages (§4.2 step 3).
 *
 * Every file is downloaded and checked against the fleet manifest before any
 * of them is installed, so a bad digest cannot leave `/opt/hermetic/stages`
 * half from one release and half from another. Each install is then a write to
 * a dot-prefixed temp name beside the target and a rename over it, which is the
 * atomic step that matters: a stage file is never observed partially written.
 */
export async function installStages(deps: {
  host: Host;
  aws: Aws;
  bucket: string;
  fleet: FleetManifest;
}): Promise<Stage[]> {
  const { host, aws, bucket, fleet } = deps;
  const version = fleet.hermeticd.version;

  const verified: Array<{ file: string; sha256: string; bytes: Uint8Array }> = [];
  for (const { file, key, sha256 } of releaseStages(fleet)) {
    const bytes = await aws.getObjectBytes(bucket, key);
    const actual = sha256Hex(bytes);
    if (actual !== sha256) {
      throw new AgentdError(
        "CHECKSUM_MISMATCH",
        `${file} does not match the fleet manifest digest; refusing to run any stage of hermeticd ${version}`,
        { key, file, expected: sha256, actual },
      );
    }
    verified.push({ file, sha256, bytes });
  }

  await host.mkdir(STAGES_DIR, "0755");
  // A per-process temp *directory*, and not merely the per-process sibling that
  // `host.writeBytes` already stages every write through (`stagingPathFor`):
  // the whole set is staged and then renamed one by one, so a release is never
  // half-installed under the names the runner reads. The bootstrap runner is
  // still in `05-service`/`06-verify` when the hermeticd it just started runs
  // its own start-up update, and two installers sharing one temp name would
  // have each other's half-written files renamed and pruned out from under
  // them. `prune` ignores dot entries, so a concurrent installer's directory
  // survives its neighbour (§4.2).
  const tmp = `${STAGES_DIR}/${INSTALL_TMP_PREFIX}${process.pid}`;
  await host.mkdir(tmp, "0700");
  const stages: Stage[] = [];
  try {
    for (const { file, sha256, bytes } of verified) {
      const path = `${STAGES_DIR}/${file}`;
      await host.writeBytes(`${tmp}/${file}`, bytes, "0755");
      await host.rename(`${tmp}/${file}`, path);
      stages.push({ id: stageIdOf(file), file, path, sha256 });
    }
  } finally {
    await host.remove(tmp);
  }
  await prune(host, stages);
  return stages;
}

/**
 * Delete the stage files and markers this release does not name.
 *
 * A release that drops `03-config.sh`, renames it, or re-uses ordinal 03 for
 * something else leaves a marker behind, and a marker is what makes the runner
 * skip. Without this, a re-used ordinal would be "already ok" on every box that
 * ever ran the old one — the boot would silently not happen.
 */
async function prune(host: Host, stages: readonly Stage[]): Promise<void> {
  const files = new Set(stages.map((s) => s.file));
  const markers = new Set(stages.map((s) => `${s.id}.ok`));
  for (const name of await host.readdir(STAGES_DIR)) {
    // Dot entries belong to an installer that may still be running.
    if (!name.startsWith(".") && !files.has(name)) await host.remove(`${STAGES_DIR}/${name}`);
  }
  for (const name of await host.readdir(MARKER_DIR)) {
    if (!name.startsWith(".") && !markers.has(name)) await host.remove(`${MARKER_DIR}/${name}`);
  }
}

/** The runner's working copy of `BootstrapState`, mutated as stages run. */
interface RunState {
  startedAt: string;
  lastCommandId: string | null;
  /** A command whose row-side clear has not been confirmed yet (§4.2 step 7). */
  pendingAckId: string | null;
  current: string | null;
  stages: StageState[];
}

function bootstrapStateOf(state: RunState, version: string, at: Date): BootstrapState {
  return {
    hermeticd_version: version,
    stages: state.stages,
    current: state.current,
    started_at: state.startedAt,
    updated_at: at.toISOString(),
    last_command_id: state.lastCommandId,
  };
}

/**
 * The stage that fetches this agent's rendered config bundle from S3 and lands
 * it at `/etc/hermetic` — the one whose output every later stage consumes.
 *
 * Named here because the runner has to be able to say "the config this box is
 * holding is not the config the fleet has for it", and that is a statement
 * about this stage in particular. It is the only stage id the runner knows;
 * everything else about a release is whatever the manifest ordered.
 */
export const CONFIG_STAGE_ID = "03-config";

/**
 * The stages whose completion depends on *which* configuration was in play: the
 * config stage itself and everything after it. A stage before it — hostname,
 * tailnet, the data volume — has nothing to do with the config and its marker
 * says nothing about one.
 *
 * Taken from the installed order rather than from a list of ids, because the
 * only thing the runner knows about a release is what the fleet manifest
 * ordered; `03-config` is the single id it is allowed to recognise.
 */
export function configBoundStages(stages: ReadonlyArray<{ id: string }>): ReadonlySet<string> {
  const from = stages.findIndex((stage) => stage.id === CONFIG_STAGE_ID);
  if (from === -1) return new Set<string>();
  return new Set(stages.slice(from).map((stage) => stage.id));
}

/**
 * Re-arm the config stage when the box is holding a stale config.
 *
 * `agent set` renders a new bundle, uploads it and writes the new `config_hash`
 * onto the row — and then says "it takes effect on the next rerun". But a
 * resume decides a stage is done by comparing the *stage script's* digest
 * against its marker, and `agent set` changes no scripts. So a rerun from a
 * failed `06-verify` skipped straight past `03-config` and `04-apply` and
 * verified the same box against the same old config, forever.
 *
 * The comparison is between facts that already exist: the hash on the row (what
 * the fleet has rendered for this agent) and what this box is holding — the
 * config it last *applied* (`applied-config.json`), or, on a box that has
 * fetched one and never finished applying it, the config it fetched.
 *
 * **The markers go first.** Re-arming only the in-memory `StageState[]` was
 * enough for the run that did it and nothing else: the next thing the config
 * stage does is replace `/etc/hermetic/manifest.json` with the new bundle, and
 * a process that died after that left a box whose fetched config looked current
 * and whose on-disk markers still said the apply and the verify were done. The
 * change was silently skipped on every boot thereafter. Deleting the markers
 * before the new manifest can land makes the invalidation outlive the process
 * that decided on it, which is the whole point of writing intent down.
 *
 * Only from the config stage down — a stage before it (hostname, tailnet, the
 * data volume) has nothing to do with the config. Within that range every
 * marker goes, `ok` or not; the returned boolean is about the in-memory reset,
 * which is what the caller has something to say about.
 */
export async function resetForConfigDrift(
  host: Host,
  stages: StageState[],
  rowConfigHash: string | null | undefined,
): Promise<boolean> {
  if (!rowConfigHash) return false;
  const held = (await readAppliedConfigHash(host)) ?? (await readFetchedConfigHash(host));
  // A box that has never fetched a config has nothing stale to re-arm; the
  // config stage is `pending` there for the ordinary reason.
  if (held === null || held === rowConfigHash) return false;

  const from = stages.findIndex((stage) => stage.id === CONFIG_STAGE_ID);
  if (from === -1) return false;
  let reset = false;
  for (const stage of stages.slice(from)) {
    await host.remove(markerPath(stage.id));
    if (stage.status !== "ok") continue;
    stage.status = "pending";
    stage.ended_at = null;
    stage.exit_code = null;
    reset = true;
  }
  return reset;
}

/**
 * The state a resumed run starts from: `ok` for every stage whose marker holds
 * the digest of the stage we just installed — and, downstream of the config
 * stage, the configuration the fleet is asking for — `pending` for the rest.
 * Attempts carry over from the row, so a rerun reports attempt 2 rather than 1.
 *
 * `configHash` is what the fleet has rendered for this agent, which is the
 * question a resume has to ask: a marker recording any other configuration is a
 * stage that ran, correctly, against something this box is no longer meant to
 * be running.
 */
export async function resumeStages(
  host: Host,
  stages: readonly Stage[],
  prior: BootstrapState | null | undefined,
  configHash: string | null = null,
): Promise<StageState[]> {
  const byId = new Map((prior?.stages ?? []).map((s) => [s.id, s]));
  const configBound = configBoundStages(stages);
  const resumed: StageState[] = [];
  for (const stage of stages) {
    const before = byId.get(stage.id);
    const marker = parseMarker(await host.readFile(markerPath(stage.id)));
    const done = stageDone(marker, stage, { configBound: configBound.has(stage.id), configHash });
    resumed.push({
      id: stage.id,
      status: done ? "ok" : "pending",
      attempt: before?.attempt ?? 0,
      started_at: done ? (before?.started_at ?? null) : null,
      ended_at: done ? (before?.ended_at ?? null) : null,
      exit_code: done ? 0 : (before?.exit_code ?? null),
      // A systemd restart of the boot unit must not erase why the last attempt
      // stopped: until this stage runs again, the previous failure is still
      // the truest thing the row can say about it.
      message: done ? null : (before?.message ?? null),
    });
  }
  return resumed;
}

function truncate(message: string): string {
  const clean = message.trim();
  return clean.length > MESSAGE_MAX ? clean.slice(0, MESSAGE_MAX - 1) + "…" : clean;
}

const encoder = new TextEncoder();

/**
 * The bounded ring of recent lines one stage attempt keeps for its event.
 *
 * Lines go in exactly as they were written to the log file — already redacted,
 * and with the `stderr: ` prefix the log uses — so the tail an operator reads
 * on the laptop is a verbatim excerpt of the file on the box rather than a
 * second, differently-shaped rendering of it. Oldest lines are dropped until
 * both `LOG_TAIL_LINES` and `LOG_TAIL_BYTES` hold, because the end of a failed
 * stage is the part that says why it failed.
 */
function makeLogTail(): { push(line: string): void; lines(): string[] } {
  const lines: string[] = [];
  let bytes = 0;
  // The newline each line costs once they are joined.
  const sizeOf = (line: string): number => encoder.encode(line).length + 1;
  return {
    push(line) {
      lines.push(line);
      bytes += sizeOf(line);
      while (lines.length > 0 && (lines.length > LOG_TAIL_LINES || bytes > LOG_TAIL_BYTES)) {
        bytes -= sizeOf(lines.shift() as string);
      }
    },
    lines: () => [...lines],
  };
}

/**
 * `aws.transition` returns `false` when the row's status moved under us between
 * the read and the conditional write (§4.3) — never thrown, because a
 * concurrent operator action (a `stop`, a `destroy`) is not a boot failure.
 * This is the warning that makes the skip visible instead of silent.
 */
function skippedTransitionMessage(from: readonly string[], to: string): string {
  return `row status moved under us; expected ${from.join(", ")}, transition to ${to} skipped`;
}

/** The statuses a boot may start from: first boot, a start after a stop, a retry. */
const BOOT_FROM = ["creating", "stopped", "error"] as const;
/** …and the ones a *pre-stage* failure can interrupt. */
const FAIL_FROM = ["creating", "stopped", "bootstrapping"] as const;

/**
 * Report a failure that happened before any stage could run — a fleet manifest
 * that will not fetch or parse, a stage whose digest is wrong, a DynamoDB read
 * that failed (§4.2).
 *
 * Without this the row sits in `creating` forever: no status, no
 * `BootstrapState`, no event, and an operator with nothing to look at but an
 * instance that never reported. Best effort by construction — a box that cannot
 * write `error` is one the fleet already sees as `unreachable` from the missing
 * heartbeat.
 */
export async function reportBootFailure(aws: Aws, name: string, error: unknown): Promise<void> {
  const raw = error instanceof Error ? error.message : String(error);
  await aws
    .transition({
      name,
      from: FAIL_FROM,
      to: "error",
      action: "error",
      detail: truncate(redactValue(raw)),
    })
    .catch(() => false);
}

export async function runStages(deps: StagesDeps): Promise<StagesOutcome> {
  const { host, aws, name, fleet } = deps;
  const emit = deps.emit ?? ((_: OpEvent) => {});
  const version = fleet.hermeticd.version;

  // Everything before the first stage is guarded: a bad digest, a 404, a
  // DynamoDB outage must leave a row that says `error` and why, not one stuck
  // in `creating` with nothing recorded anywhere.
  let stages: Stage[];
  let row: Awaited<ReturnType<Aws["getOwnRow"]>>;
  try {
    stages = await installStages(deps);
    row = await aws.getOwnRow(name);
  } catch (e) {
    // Redacted here too, not only on the row: this line goes to journald.
    emit(
      opEvent(
        "stages",
        0,
        redactValue(e instanceof Error ? e.message : String(e)),
        host.now(),
        "error",
      ),
    );
    await reportBootFailure(aws, name, e);
    throw e;
  }

  /**
   * The configuration this boot is resuming *towards*. The row is the fleet's
   * statement of what this agent should be running; a box whose row says
   * nothing (an older row, a fleet with no config stage) falls back to what it
   * fetched, which is the only other thing on the box that can answer.
   */
  const configHash = row?.config_hash ?? (await readFetchedConfigHash(host));
  const configBound = configBoundStages(stages);
  const state: RunState = {
    startedAt: row?.bootstrap?.started_at ?? host.now().toISOString(),
    lastCommandId: row?.bootstrap?.last_command_id ?? null,
    pendingAckId: null,
    current: null,
    stages: await resumeStages(host, stages, row?.bootstrap, configHash),
  };

  // A boot onto a box whose config the operator has changed since: the markers
  // say the config stage is done, and the row says it is done with the wrong
  // config.
  if (await resetForConfigDrift(host, state.stages, row?.config_hash)) {
    emit(
      opEvent(
        "stages",
        0.02,
        `${CONFIG_STAGE_ID} and later stages re-armed: this box is holding an older config than the row records`,
        host.now(),
      ),
    );
  }

  // A reboot: every marker matches, so there is nothing to run. The only write
  // is the `ready` guard, for the case where the row never got there.
  if (state.stages.every((s) => s.status === "ok")) {
    emit(opEvent("stages", 1, `all ${stages.length} stage(s) already applied`, host.now()));
    if (row && row.status !== "ready") {
      // Through `bootstrapping`, never straight from `error` to `ready`: the
      // markers say the stages ran, and `ready` is only ever entered from the
      // state that means "this boot is happening".
      await aws
        .transition({
          name,
          from: BOOT_FROM,
          to: "bootstrapping",
          action: "boot",
          detail: `all ${stages.length} stage(s) already applied`,
        })
        .catch(() => false);
      await transitionReady(deps, stages.length);
    }
    return { ok: true, gaveUp: false, stages: state.stages };
  }

  for (;;) {
    const moved = await aws.transition({
      name,
      from: BOOT_FROM,
      to: "bootstrapping",
      action: "boot",
      detail: `running ${stages.length} bootstrap stage(s) from hermeticd ${version}`,
    });
    if (!moved) {
      emit(
        opEvent(
          "stages",
          0.02,
          skippedTransitionMessage(BOOT_FROM, "bootstrapping"),
          host.now(),
          "warn",
        ),
      );
    }
    await writeState(deps, state);

    const failed = await runPending(deps, state, stages, configBound);
    if (!failed) {
      await transitionReady(deps, stages.length);
      emit(opEvent("done", 1, `${name} is ready`, host.now()));
      return { ok: true, gaveUp: false, stages: state.stages };
    }

    await aws
      .transition({
        name,
        from: ["bootstrapping"],
        to: "error",
        action: "error",
        // The headline, then where the rest of it is: the stage event beside
        // this one carries the tail, and the box keeps the whole file.
        detail:
          `${failed.id} failed: ${failed.message ?? `exit ${failed.exit_code}`}` +
          `; the stage event carries the log tail, the full log is at ${stageLogPath(failed.id)}`,
      })
      .catch(() => false);
    emit(
      opEvent(
        failed.id,
        1,
        `${failed.id} failed; waiting for a rerun (the log is at ${stageLogPath(failed.id)})`,
        host.now(),
        "error",
      ),
    );

    if (!(await waitForCommand(deps, state))) {
      return { ok: false, gaveUp: true, stages: state.stages };
    }
  }
}

/** Run every stage that is not already `ok`, in order. Returns the one that failed. */
async function runPending(
  deps: StagesDeps,
  state: RunState,
  stages: readonly Stage[],
  configBound: ReadonlySet<string>,
): Promise<StageState | null> {
  for (let i = 0; i < stages.length; i += 1) {
    const stage = stages[i] as Stage;
    if ((state.stages[i] as StageState).status === "ok") continue;
    const result = await runStage(deps, state, stage, i, configBound);
    if (result.status !== "ok") return result;
  }
  return null;
}

async function runStage(
  deps: StagesDeps,
  state: RunState,
  stage: Stage,
  index: number,
  configBound: ReadonlySet<string>,
): Promise<StageState> {
  const { host, aws, name } = deps;
  const emit = deps.emit ?? ((_: OpEvent) => {});
  const log = deps.log ?? (() => {});

  const startedMs = host.now().getTime();
  const st = state.stages[index] as StageState;
  st.status = "running";
  st.attempt += 1;
  st.started_at = new Date(startedMs).toISOString();
  st.ended_at = null;
  st.exit_code = null;
  st.message = null;
  state.current = stage.id;
  await writeState(deps, state);

  const logPath = stageLogPath(stage.id);
  await host.mkdir(STAGE_LOG_DIR, "0750");
  await host.mkdir(FACTS_DIR, "0700");
  // A stale facts file from the previous attempt would be read as this one's.
  await host.remove(factsPath(stage.id));

  const buffered: string[] = [`=== ${stage.id} attempt ${st.attempt} at ${st.started_at} ===`];
  // Appended, not rewritten: a stage that prints for ten minutes must not cost
  // a full read-and-write of its own log on every flush.
  const flushLog = async (): Promise<void> => {
    if (buffered.length === 0) return;
    await host.appendFile(logPath, buffered.join("\n") + "\n", "0640");
    buffered.length = 0;
  };

  // Only this attempt's lines: the log file is append-only across attempts, so
  // a tail read from it would carry the previous failure's output too.
  const tail = makeLogTail();
  let lastWriteMs = startedMs;
  let lastStderr: string | null = null;
  let lastLine: string | null = null;
  let exitCode = 1;

  emit(opEvent(stage.id, 0, `running ${stage.file}`, host.now()));
  // Started before the first line is read, because the case it exists for is a
  // stage that never prints one.
  const pulse = startPulse(deps.pulseMs ?? LIVENESS_PULSE_MS, async () => {
    lastWriteMs = host.now().getTime();
    await writeState(deps, state);
  });
  try {
    for await (const event of host.execEvents(["bash", stage.path], {
      env: stageEnv(deps, stage.id),
    })) {
      if (event.type === "exit") {
        exitCode = event.code;
        continue;
      }
      // Redaction happens before the line is stored, logged or echoed — a stage
      // that prints a secret must not be able to leave it anywhere (§8.3).
      const line = redactValue(event.line);
      const logged = event.stream === "stderr" ? `stderr: ${line}` : line;
      buffered.push(logged);
      tail.push(logged);
      log(line);
      lastLine = line;
      if (event.stream === "stderr" && line.trim().length > 0) lastStderr = line;

      const progress = parseProgress(line);
      if (!progress) continue;
      st.message = truncate(progress.message);
      emit(opEvent(stage.id, progress.progress, progress.message, host.now()));
      const nowMs = host.now().getTime();
      if (nowMs - lastWriteMs >= PROGRESS_THROTTLE_MS) {
        lastWriteMs = nowMs;
        await flushLog();
        await writeState(deps, state);
      }
    }
  } finally {
    await pulse.stop();
  }

  const endedMs = host.now().getTime();
  const seconds = ((endedMs - startedMs) / 1000).toFixed(1);
  st.ended_at = new Date(endedMs).toISOString();
  st.exit_code = exitCode;
  state.current = null;

  const facts = parseFacts(await host.readFile(factsPath(stage.id)));
  const attributes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(facts)) {
    if (FACT_ATTRIBUTES.has(key)) attributes[key] = redactValue(value);
  }

  let detail: string;
  if (exitCode === 0) {
    st.status = "ok";
    st.message = null;
    await host.mkdir(MARKER_DIR, "0755");
    // Read now rather than passed in: a config-dependent stage is recorded
    // against the configuration that is on the box *as it finishes*, which for
    // the config stage itself is the bundle it has just fetched.
    const config = configBound.has(stage.id) ? await readFetchedConfigHash(host) : null;
    await host.writeFile(markerPath(stage.id), formatMarker(stage.sha256, config), "0644");
    detail = `${stage.id} ok in ${seconds}s`;
  } else {
    st.status = "failed";
    // The last stderr line is what a human would read first; the whole log
    // stays on the box, which is why 512 characters is enough here.
    st.message = truncate(lastStderr ?? lastLine ?? `exit ${exitCode}`);
    detail = `${stage.id} failed exit ${exitCode}: ${st.message}`;
  }

  await flushLog();
  // Always the last write of the stage, so the row never rests on a throttled
  // intermediate message.
  await writeState(deps, state, attributes);
  await aws
    .appendEvent({
      name,
      action: "stage",
      detail,
      // Only a failure carries evidence: a stage that worked has nothing an
      // operator needs to read, and the log is on the box either way.
      ...(exitCode === 0 ? {} : { log_tail: tail.lines().join("\n") }),
    })
    .catch(() => undefined);
  emit(opEvent(stage.id, 1, detail, host.now(), exitCode === 0 ? undefined : "error"));
  return st;
}

/**
 * A repeating call that stops cleanly, used for the liveness pulse.
 *
 * The wait is a real timer and deliberately not `host.sleep`. `host.sleep` is
 * the seam a *sequential* loop uses to skip waiting, and the fake host
 * implements it by fast-forwarding a fake clock — which is exactly right for a
 * poll loop the test is driving, and exactly wrong for a background pulse,
 * which would then fire on every microtask and write more rows in a test than a
 * quiet stage ever writes on a box. `pulseMs` is the seam instead: a test that
 * wants to see a pulse shortens it.
 */
function startPulse(intervalMs: number, tick: () => Promise<void>): { stop(): Promise<void> } {
  let running = true;
  let wake: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const loop = (async (): Promise<void> => {
    while (running) {
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, intervalMs);
      });
      if (timer !== null) clearTimeout(timer);
      timer = null;
      wake = null;
      if (!running) return;
      await tick();
    }
  })();

  return {
    async stop(): Promise<void> {
      running = false;
      if (timer !== null) clearTimeout(timer);
      // Resolve the sleep we just cancelled, or `loop` would never return.
      wake?.();
      await loop;
    },
  };
}

async function writeState(
  deps: StagesDeps,
  state: RunState,
  attributes?: Readonly<Record<string, unknown>>,
): Promise<void> {
  await deps.aws
    .setBootstrap(
      deps.name,
      bootstrapStateOf(state, deps.fleet.hermeticd.version, deps.host.now()),
      attributes,
    )
    .catch(() => false);
}

/** How many times an ack is retried before the resume goes ahead regardless. */
export const ACK_ATTEMPTS = 3;

/**
 * Clear an acked command, retrying only the failure that deserves it. A thrown
 * error is a call that did not happen; `false` is the row telling us the
 * command is already gone or has been replaced, and retrying that would clear
 * an instruction the operator has only just issued.
 */
async function retryPendingAck(deps: StagesDeps, state: RunState, attempts = 1): Promise<void> {
  for (let attempt = 0; attempt < attempts && state.pendingAckId !== null; attempt += 1) {
    if (attempt > 0) await deps.host.sleep(deps.pollMs ?? COMMAND_POLL_MS);
    try {
      await deps.aws.ackCommand(deps.name, state.pendingAckId);
      state.pendingAckId = null;
    } catch {
      // Keep it: the next poll, or the next failure, tries again.
    }
  }
}

async function transitionReady(deps: StagesDeps, count: number): Promise<void> {
  const { host, aws, name, fleet } = deps;
  const emit = deps.emit ?? ((_: OpEvent) => {});
  const configHash = await readAppliedConfigHash(host);
  // Only from `bootstrapping`. Widening this would let a box that never
  // verified anything claim `ready` straight out of `error`.
  const readyFrom = ["bootstrapping"] as const;
  const moved = await aws.transition({
    name,
    from: readyFrom,
    to: "ready",
    action: "ready",
    detail: `${count} stage(s) ok`,
    set: {
      hermeticd_version: fleet.hermeticd.version,
      /**
       * Both halves of §6.6's config axis, and they are not the same claim.
       * `applied_config_hash` is this box reporting what it applied — the field
       * only hermeticd writes. `config_hash` is kept in step here only because
       * a box reaching `ready` has, by definition, just applied what its row
       * asked for; every other writer of it is a laptop that has rendered a new
       * bundle, and the two disagreeing afterwards is exactly the drift the
       * skew warning reports.
       */
      ...(configHash ? { config_hash: configHash, applied_config_hash: configHash } : {}),
    },
  });
  if (!moved) {
    emit(opEvent("done", 1, skippedTransitionMessage(readyFrom, "ready"), host.now(), "warn"));
  }
}

/**
 * Stay resident after a failure and wait for `hermetic agent rerun` (§4.2 step
 * 7). The ack is `bootstrap.last_command_id`: it is written *before* the
 * command is cleared, so a crash between the two re-reads a command it has
 * already recorded and does nothing, rather than running the stages twice.
 */
async function waitForCommand(deps: StagesDeps, state: RunState): Promise<boolean> {
  const { host, aws, name } = deps;
  const emit = deps.emit ?? ((_: OpEvent) => {});
  const pollMs = deps.pollMs ?? COMMAND_POLL_MS;
  const deadline = host.now().getTime() + (deps.giveUpMs ?? GIVE_UP_MS);

  for (;;) {
    await host.sleep(pollMs);
    const row = await aws.getOwnRow(name).catch(() => null);
    const command = row?.command;
    // A previous ack that never reached DynamoDB is retried before anything
    // else: an uncleared command is one the UI keeps showing as pending.
    await retryPendingAck(deps, state);
    if (command && command.action === "rerun" && command.id !== state.lastCommandId) {
      state.lastCommandId = command.id;
      state.pendingAckId = command.id;
      state.current = null;
      // The reason most reruns are issued: `agent set` changed the config and
      // said it would take effect on the next one. Without this the resume
      // walks past the stage that fetches it, because no stage *script*
      // changed — and re-verifies the box against the config it already had.
      if (await resetForConfigDrift(host, state.stages, row?.config_hash)) {
        emit(
          opEvent(
            "rerun",
            0,
            `${CONFIG_STAGE_ID} and later stages re-armed: the row records a newer config than this box fetched`,
            host.now(),
          ),
        );
      }
      await writeState(deps, state);
      await retryPendingAck(deps, state, ACK_ATTEMPTS);
      await aws
        .appendEvent({ name, action: "rerun", detail: `rerun requested by ${command.issued_by}` })
        .catch(() => undefined);
      emit(opEvent("rerun", 0, `rerun requested by ${command.issued_by}`, host.now()));
      return true;
    }
    if (host.now().getTime() >= deadline) {
      emit(
        opEvent(
          "rerun",
          1,
          "no rerun in 24h; exiting so systemd can try the boot again",
          host.now(),
          "warn",
        ),
      );
      return false;
    }
  }
}
