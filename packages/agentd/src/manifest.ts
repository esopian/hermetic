/**
 * The manifest gate (§6.3 step 3). hermeticd refuses to continue if
 * `manifest.json` does not parse, or if its `schema_version` is newer than this
 * build understands — a newer laptop must not be able to drive an older box into
 * a half-understood configuration. Refusal exits 3.
 */
import { AgentConfig } from "@hermetic/core/schema";
import { AGENT_CONFIG_SCHEMA_VERSION } from "@hermetic/core/shared";
import type { AgentCapability, AgentConfig as AgentConfigType } from "@hermetic/core/schema";
import { AgentdError } from "./errors.ts";
import { STATE_DIR } from "./fleet.ts";
import { HERMETICD_VERSION } from "./version.ts";
import type { Host } from "./host.ts";

export const SUPPORTED_SCHEMA_VERSION = AGENT_CONFIG_SCHEMA_VERSION;

/**
 * What *this* build of hermeticd can do for a manifest that asks
 * (`AGENT_CONFIG_CAPABILITIES` in core's schema names the whole vocabulary).
 *
 * Spelled out here rather than imported wholesale, and that is the point: core's
 * list is every capability that exists, this one is every capability this binary
 * implements, and the difference between them is precisely what an older box
 * running against a newer laptop cannot do. A capability is added to this set in
 * the same commit that implements the behaviour, never before.
 */
export const HERMETICD_CAPABILITIES: ReadonlySet<AgentCapability> = new Set<AgentCapability>([
  "gateway-unit",
  "restart-units",
  "provider-key-ref",
  "browser-stack",
]);

export const MANIFEST_PATH = "/etc/hermetic/manifest.json";
export const BUNDLE_DIR = "/etc/hermetic";

/**
 * Where a converge unpacks a bundle it has not decided to apply yet.
 *
 * Unpacking into `BUNDLE_DIR` writes `MANIFEST_PATH` as a side effect — the
 * bundle carries that file — and `MANIFEST_PATH` is the box's answer to "what
 * config are you running". A converge that unpacked in place therefore
 * overwrote the answer before it had asked the question, and every converge
 * after the first read the incoming hash back as the applied one and declared
 * itself already current (`converge.ts`). Bootstrap's `fetch-config` still
 * unpacks into `BUNDLE_DIR`: there the apply follows unconditionally.
 */
export const INCOMING_DIR = "/etc/hermetic/incoming";

export function parseManifest(input: unknown): AgentConfigType {
  // Read the version before zod does, so a future manifest is refused with the
  // version-specific message rather than a `literal(1)` mismatch.
  const declared = (input as { schema_version?: unknown } | null)?.schema_version;
  if (typeof declared === "number" && declared > SUPPORTED_SCHEMA_VERSION) {
    throw new AgentdError(
      "MANIFEST_REFUSED",
      `manifest schema_version ${declared} is newer than this hermeticd understands (${SUPPORTED_SCHEMA_VERSION})`,
      { declared, supported: SUPPORTED_SCHEMA_VERSION },
    );
  }
  const parsed = AgentConfig.safeParse(input);
  if (!parsed.success) {
    throw new AgentdError("MANIFEST_REFUSED", `manifest does not validate against AgentConfig`, {
      issues: parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".")}: ${i.message}`),
    });
  }
  assertCapable(parsed.data);
  return parsed.data;
}

/**
 * Refuse a manifest that needs something this hermeticd cannot do — *before* the
 * apply starts, rather than in the middle of it.
 *
 * The alternative is what happened: a laptop rendered a config naming a unit
 * only a newer hermeticd installs, the box wrote a dozen files, enabled four
 * units, and then failed on `systemctl enable` with a message about systemd. Half
 * a configuration was applied, the row said `error`, and nothing named the actual
 * problem — which is that the fleet's published release is older than the laptop
 * that rendered this.
 *
 * `schema_version` cannot express it (the shape did not change) and versions
 * cannot either (both sides say `0.5.0`), so the manifest says what it needs and
 * this is the box answering honestly. The remedy is in the message because the
 * operator, not the box, is the one who can apply it.
 */
export function assertCapable(manifest: AgentConfigType): void {
  const missing = (manifest.requires ?? []).filter(
    (c) => !HERMETICD_CAPABILITIES.has(c as AgentCapability),
  );
  if (missing.length === 0) return;
  throw new AgentdError(
    "MANIFEST_REFUSED",
    `the agent manifest (config ${manifest.config_hash}) needs ${missing.join(", ")}, which this ` +
      `hermeticd (${HERMETICD_VERSION}) does not implement — it was rendered by a newer hermetic ` +
      "than the release this fleet publishes. Publish this checkout with `hermetic artifacts push`, " +
      "then `hermetic agent recreate <name>`: a rerun re-runs the stages under the hermeticd this " +
      "box is already running, which is the one that cannot apply this manifest, while a recreate " +
      "launches a box that fetches the release just published. Nothing has been applied.",
    { missing, config_hash: manifest.config_hash, hermeticd_version: HERMETICD_VERSION },
  );
}

export function parseManifestJson(text: string): AgentConfigType {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new AgentdError("MANIFEST_REFUSED", `manifest.json is not valid JSON: ${String(e)}`);
  }
  return parseManifest(json);
}

/**
 * Where the box records the config it has actually **applied**, as opposed to
 * the one it has merely fetched.
 *
 * The two used to be one file. `/etc/hermetic/manifest.json` is written by the
 * config stage, which only downloads the bundle; the apply that acts on it is a
 * separate stage, and a converge is a separate call again. So between the fetch
 * and the apply there was a window in which the box's own answer to "what
 * configuration are you running" was a statement of intent — and a crash inside
 * that window left the intent on disk looking exactly like an accomplishment.
 * Nothing downstream could tell the difference: the stage markers said the
 * apply was done, the fetched hash matched what the fleet asked for, and the
 * box reported `ready` without the change ever having been applied.
 *
 * Splitting them makes each file say one thing. `manifest.json` is what was
 * fetched, and it is the document `apply` and `verify` are pointed at;
 * `applied-config.json` is what an apply finished, and it is written last, by
 * `apply` itself, only on success. Readiness and `applied_config_hash` are read
 * from this one.
 */
export const APPLIED_CONFIG_PATH = `${STATE_DIR}/applied-config.json`;

/** What `applied-config.json` holds. Deliberately tiny; it is not a manifest. */
export interface AppliedConfig {
  readonly config_hash: string;
  readonly applied_at: string;
}

/**
 * The `config_hash` of the agent manifest currently on disk, or `null` when the
 * box has not fetched one yet.
 *
 * "Fetched" is the whole distinction: this is what the config stage downloaded
 * and what `apply`/`verify` are handed, not what any of them finished. Use
 * `readAppliedConfigHash` for the box's account of what it is *running*.
 */
export async function readFetchedConfigHash(host: Host): Promise<string | null> {
  const text = await host.readFile(MANIFEST_PATH);
  if (text === null) return null;
  try {
    return parseManifestJson(text).config_hash;
  } catch {
    // A manifest this build refuses is not a config this box is running.
    return null;
  }
}

/**
 * The `config_hash` of the last apply that **succeeded**, or `null` on a box
 * that has not completed one. It is what `ready` reports on the row and what
 * `GET /healthz` answers with — the box's own account of what it is running.
 *
 * `null` on a box last applied by a hermeticd older than this file, too. That
 * is the honest answer rather than an inconvenience: an older hermeticd never
 * recorded the fact, so nothing on the box knows it, and the next apply — which
 * a reboot performs anyway, since a marker written by that build no longer
 * satisfies `stageDone` — supplies it.
 */
export async function readAppliedConfigHash(host: Host): Promise<string | null> {
  const text = await host.readFile(APPLIED_CONFIG_PATH);
  if (text === null) return null;
  try {
    const hash = (JSON.parse(text) as { config_hash?: unknown }).config_hash;
    return typeof hash === "string" && hash.length > 0 ? hash : null;
  } catch {
    // A record that will not parse records nothing.
    return null;
  }
}

/**
 * Record a completed apply. Called by `apply` as its last act, so the fact is
 * never on disk before the work it describes.
 *
 * The cost of that ordering is one window, and it is the cheap one: a crash
 * between the last unit restart and this write leaves the old hash recorded,
 * the fleet reads the box as drifted, and the next apply repeats work that is
 * idempotent. The opposite ordering loses the change itself.
 */
export async function recordAppliedConfig(host: Host, configHash: string): Promise<void> {
  const record: AppliedConfig = { config_hash: configHash, applied_at: host.now().toISOString() };
  await host.mkdir(STATE_DIR, "0755");
  await host.writeFile(APPLIED_CONFIG_PATH, `${JSON.stringify(record)}\n`, "0644");
}

/**
 * Unpack the config bundle S3 holds at `config/<name>/<hash>.tgz`.
 *
 * Two shapes are accepted. On the box it is a real gzipped tar, unpacked with
 * `tar` through the host. In fixtures core emits a canonical JSON stand-in
 * (`{ manifest, extra }`, see `render.ts`), which needs no tar at all — so the
 * same code path is exercised in tests.
 */
export async function readBundleManifest(
  tarball: Uint8Array,
  host: Host,
  dir: string = BUNDLE_DIR,
): Promise<AgentConfigType> {
  const text = new TextDecoder().decode(tarball.slice(0, 8));
  const looksJson = text.trimStart().startsWith("{");
  if (looksJson) {
    const whole = new TextDecoder().decode(tarball);
    let parsed: unknown;
    try {
      parsed = JSON.parse(whole);
    } catch {
      throw new AgentdError("MANIFEST_REFUSED", "config bundle is neither a tarball nor JSON");
    }
    const manifest = (parsed as { manifest?: unknown }).manifest ?? parsed;
    return parseManifest(manifest);
  }

  const tmp = `${dir}/bundle.tgz`;
  await host.mkdir(dir);
  await host.writeBytes(tmp, tarball, "0600");
  const untar = await host.exec(["tar", "-xzf", tmp, "-C", dir]);
  if (untar.code !== 0) {
    throw new AgentdError("MANIFEST_REFUSED", `config bundle did not unpack: ${untar.stderr}`);
  }
  const json = await host.readFile(`${dir}/manifest.json`);
  if (json === null) {
    throw new AgentdError("MANIFEST_REFUSED", "config bundle has no manifest.json");
  }
  return parseManifestJson(json);
}
