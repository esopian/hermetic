/**
 * Where a box's Chrome comes from (§7.3).
 *
 * Ubuntu 24.04 arm64 ships no native-deb browser: its `chromium-browser` is a
 * transitional package onto a snap, and a snap cannot run as the `hermes`
 * account whose home is on `/data`. So the browser an agent drives is a pinned
 * Chrome for Testing build, mirrored into the fleet bucket by `hermetic
 * artifacts push` and recorded in `FleetManifest.browser` with its length and
 * digest — exactly the arrangement `hermes-source.ts` already has for the
 * Hermes bundle, and for the same reasons: the fleet's version is a fact in the
 * manifest, a create does not depend on a third-party CDN, and the bytes are
 * verified before anything executes them.
 *
 * The one difference from the Hermes mirror is that there is **no fallback**.
 * A missing bundle means "clone from github.com"; a missing Chrome build means
 * the box has no browser at all, so it is a named error (`BROWSER_BUILD_MISSING`)
 * with the operator's next move in the message, rather than an S3 403 surfacing
 * from the middle of a bootstrap stage.
 */
import type { AgentConfig, BrowserBuildEntry, FleetManifest } from "@hermetic/core/schema";
import {
  CHROME_INSTALL_ROOT,
  chromeBinaryPath,
  chromeInstallDir,
  isChromeRef,
} from "@hermetic/core/shared";
import { AgentdError } from "./errors.ts";
import type { Emit } from "./events.ts";
import { opEvent } from "./events.ts";
import { readUsableFleetManifest } from "./fleet.ts";
import type { ObjectFetch } from "./hermes-source.ts";
import { realObjectFetch } from "./hermes-source.ts";
import type { Host } from "./host.ts";
import { must } from "./host.ts";
import { redactValue } from "./redact.ts";
import { sha256Hex } from "./stages.ts";

/**
 * Where the mirrored zip is staged while it is being unpacked.
 *
 * One fixed name rather than one per build, for the reason `HERMES_BUNDLE_PATH`
 * is fixed: it is removed as soon as `unzip` has read it, so two never coexist,
 * and a constant keeps a manifest-supplied string out of a filesystem path.
 */
export const CHROME_ZIP_PATH = `${CHROME_INSTALL_ROOT}/chrome.zip`;

/**
 * The digest of the zip an install came from, written beside the unpacked tree.
 *
 * It is what makes the second apply a no-op *and* what makes a re-pushed build
 * under the same `chrome_ref` reinstall: the binary being present says only that
 * some zip was unpacked here once, and the manifest is the only statement of
 * which bytes that should have been.
 */
export const CHROME_MARKER_FILE = ".hermetic-sha256";

/** The marker path for one build. */
export function chromeMarkerPath(chromeRef: string): string {
  return `${chromeInstallDir(chromeRef)}/${CHROME_MARKER_FILE}`;
}

/*
 * What a `chrome_ref` may contain before it is allowed into a path is
 * `isChromeRef`, imported from core's schema rather than restated here.
 *
 * The manifest is hermetic's own document, so this is not a trust boundary — it
 * is the same defence in depth `parseManifest` is: the ref reaches
 * `chromeInstallDir` and `unzip -d`, and a value with a `/` or a `..` in it
 * would name a directory the build was never meant to land in. This file used
 * to carry its own, wider, pattern, which made one rule two — the laptop
 * refusing at `browser-mirror.ts` what the box would have accepted here. The
 * schema subpath is the door agentd is allowed through, and the rule is already
 * behind it.
 */

/** What `ensureChromeBuild` did, for the caller's `ApplyResult` and its events. */
export interface ChromeBuild {
  /** The build this agent's manifest pins. */
  readonly ref: string;
  /** The headed binary the `hermetic-browser@` units execute. */
  readonly binary: string;
  /** False when the box already had exactly these bytes unpacked. */
  readonly installed: boolean;
}

export interface ChromeBuildOptions {
  /** Injected in tests; the default is a real `GetObject` (see `realObjectFetch`). */
  readonly getObject?: ObjectFetch;
  /** Plan only: say what would be fetched, fetch nothing. */
  readonly dryRun?: boolean;
}

/**
 * Put the Chrome build this agent's manifest names on the box, or confirm it is
 * already there. `null` when the agent has no browsers at all.
 *
 * Ordering matters and is the caller's to get right: this runs in the packages
 * phase *after* apt, because `unzip` is one of the packages the manifest lists,
 * and before the units phase, because `hermetic-browser@<name>.service` names
 * the binary in its `ExecStart` and would crash-loop without it.
 */
export async function ensureChromeBuild(
  host: Host,
  manifest: AgentConfig,
  emit: Emit,
  opts: ChromeBuildOptions = {},
): Promise<ChromeBuild | null> {
  const browsers = manifest.browsers ?? [];
  // A `browser: false` agent unpacks nothing. It is also what a manifest
  // rendered before the browser stack says, which is the same answer.
  if (browsers.length === 0) return null;

  const ref = manifest.chrome_ref;
  if (ref === undefined || ref === "") {
    throw new AgentdError(
      "MANIFEST_REFUSED",
      `this agent runs ${String(browsers.length)} browser(s) but the manifest names no chrome_ref; ` +
        "re-render it with `hermetic agent rerun`",
      { browsers: browsers.map((b) => b.name) },
    );
  }
  if (!isChromeRef(ref)) {
    throw new AgentdError(
      "MANIFEST_REFUSED",
      `chrome_ref ${JSON.stringify(ref)} is not a usable name`,
      {
        chrome_ref: ref,
      },
    );
  }

  const dir = chromeInstallDir(ref);
  const binary = chromeBinaryPath(ref);

  // Before anything else, for the reason `fetchHermesBundle` removes its
  // staged bundle first: an apply killed between the write and the unzip leaves
  // ~190 MB under `/opt` that no later apply on the skip path would ever
  // collect.
  if (opts.dryRun !== true) await host.remove(CHROME_ZIP_PATH);

  const fleet = await readUsableFleetManifest(host, (message) =>
    emit(opEvent("packages", 0.2, message, host.now(), "warn")),
  );
  const entry = fleet?.browser?.[ref];
  if (!fleet || !entry) {
    // A named error and not an S3 403 out of the middle of a stage: the two
    // causes — a fleet that has never pushed this build, and a fleet whose
    // instance role predates foundation v14 — have different fixes, and both
    // are in the message. hermeticd is a compiled binary, so a box reaching
    // here may also simply be running a release from before the browser mirror;
    // `hermetic artifacts push` is the fix for that too.
    throw new AgentdError(
      "BROWSER_BUILD_MISSING",
      `fleet manifest records no Chrome build ${ref}; run \`hermetic artifacts push\` ` +
        "(and `hermetic foundation update` if the fleet is below v14)",
      { chrome_ref: ref },
    );
  }

  const installedDigest = (await host.readFile(chromeMarkerPath(ref)))?.trim() ?? null;
  if ((await host.stat(binary)) !== null && installedDigest === entry.sha256) {
    emit(opEvent("packages", 0.2, `chrome ${ref} already installed`, host.now()));
    return { ref, binary, installed: false };
  }

  if (opts.dryRun === true) {
    emit(opEvent("packages", 0.2, `would install chrome ${ref} from the fleet's mirror`, host.now()));
    return { ref, binary, installed: true };
  }

  emit(opEvent("packages", 0.2, `installing chrome ${ref} from the fleet's mirror`, host.now()));
  const bytes = await fetchBuild(host, fleet, entry, opts.getObject);

  await host.mkdir(CHROME_INSTALL_ROOT, "0755");
  // 0600 while it is only a downloaded file; what ends up executable is what
  // comes out of it, below.
  await host.writeBytes(CHROME_ZIP_PATH, bytes, "0600");
  await host.mkdir(dir, "0755");
  // `-o` because a half-unpacked tree from a killed apply must not turn the
  // retry into an interactive prompt, and `-q` because every file name in a
  // Chrome build in the journal is noise.
  await must(host, ["unzip", "-q", "-o", CHROME_ZIP_PATH, "-d", dir]);

  if ((await host.stat(binary)) === null) {
    throw new AgentdError("COMMAND_FAILED", `unzipping ${entry.key} left no chrome at ${binary}`, {
      chrome_ref: ref,
      key: entry.key,
      expected: binary,
    });
  }
  // The zip carries modes and `unzip` honours them, so this is belt and braces
  // — but an unreadable or non-executable binary is a crash loop in a unit
  // rather than a failure here, and root-owned 0755 is what the `hermes`
  // account needs (read and execute, never write).
  await host.chmod(binary, "0755");
  await host.writeFile(chromeMarkerPath(ref), `${entry.sha256}\n`, "0644");
  // The zip is the size of the build again; it has done its job.
  await host.remove(CHROME_ZIP_PATH);

  emit(opEvent("packages", 0.22, `chrome ${ref} unpacked at ${dir}`, host.now()));
  return { ref, binary, installed: true };
}

/**
 * Take away the Chrome trees this box no longer runs.
 *
 * An unpacked build is ~500 MB and `chrome_ref` moves every time the fleet pins
 * a newer one, so without this each bump leaves the previous build on the root
 * volume for good — on the same disk as the agent's memory, its logs and its
 * Hermes checkout. Nothing else ever collects them: `apply` is the only thing
 * that writes under `CHROME_INSTALL_ROOT`, and it only ever adds.
 *
 * Deliberately narrow. Only siblings of the build that was just installed, only
 * names that are valid refs, and never the staged zip — anything else under
 * `/opt/hermetic/chrome` was put there by somebody, and this is the same rule
 * the unit removals follow: hermetic removes what hermetic wrote.
 *
 * Called from `apply`'s **units** phase, after the restart that moves
 * `hermetic-browser@` onto the new binary — not from `ensureChromeBuild`, where
 * it used to be.
 *
 * Unpacking happens in the packages phase and the restart is two phases later,
 * so pruning at the install site deleted the tree the *running* Chrome was
 * still executing from. Its own pages are mapped, but it opens `.pak` files,
 * locales and the SwiftShader libraries lazily, so a tab could ask for a file
 * that was no longer there. Worse than the window: anything between the two
 * phases can fail — `ensureHermes`, the web UI build, a post-step — and then the
 * restart never happens at all, leaving a unit whose `ExecStart` still names a
 * deleted binary, to crash-loop under `Restart=always` until some later apply
 * completes. After the restart, the only tree this can remove is one nothing is
 * running from.
 */
export async function pruneSupersededBuilds(host: Host, ref: string, emit: Emit): Promise<void> {
  const zipName = CHROME_ZIP_PATH.slice(CHROME_INSTALL_ROOT.length + 1);
  for (const name of await host.readdir(CHROME_INSTALL_ROOT)) {
    if (name === ref || name === zipName || !isChromeRef(name)) continue;
    await host.remove(`${CHROME_INSTALL_ROOT}/${name}`);
    emit(opEvent("packages", 0.22, `removed superseded chrome ${name}, no longer pinned`, host.now()));
  }
}

/**
 * The mirrored zip, read and verified.
 *
 * The whole object is read into memory, which for a Chrome build is ~190 MB.
 * That is the same trade `fetchHermesBundle` makes and it is accepted for the
 * same reason: the digest has to be computed over the complete object before
 * any of it is written somewhere a unit can execute, and streaming it to disk
 * first would mean verifying bytes that are already on the box. A box small
 * enough for this to matter is smaller than any instance size §7.1 offers.
 */
async function fetchBuild(
  host: Host,
  fleet: FleetManifest,
  entry: BrowserBuildEntry,
  getObject?: ObjectFetch,
): Promise<Uint8Array> {
  const bucket = fleet.resources.bucket;
  let bytes: Uint8Array;
  try {
    bytes = await (getObject ?? realObjectFetch(fleet, host))(bucket, entry.key);
  } catch (e) {
    // No fallback to fetch: unlike the Hermes bundle there is no second source
    // for this object, so a read that failed is an agent with no browser. The
    // usual cause is an instance role from before foundation v14, which does
    // not grant `browser/*`.
    throw new AgentdError(
      "BROWSER_BUILD_MISSING",
      `could not read s3://${bucket}/${entry.key} ` +
        `(${redactValue(e instanceof Error ? e.message : String(e))}); ` +
        "a fleet below foundation v14 does not grant the agent role `browser/*` — run " +
        "`hermetic foundation update`, then `hermetic artifacts push`",
      { key: entry.key, bucket },
    );
  }

  // Length before digest, for the reason `hermes-source.ts` checks them in that
  // order: a short read is named as one rather than reported as bytes whose
  // sha256 came out wrong.
  if (bytes.byteLength !== entry.size) {
    throw new AgentdError(
      "CHECKSUM_MISMATCH",
      `${entry.key} is ${String(bytes.byteLength)} bytes, not the ${String(entry.size)} the fleet manifest records`,
      { key: entry.key, expected_size: entry.size, actual_size: bytes.byteLength },
    );
  }
  const actual = sha256Hex(bytes);
  if (actual !== entry.sha256) {
    throw new AgentdError("CHECKSUM_MISMATCH", `${entry.key} digest mismatch`, {
      key: entry.key,
      expected: entry.sha256,
      actual,
    });
  }
  return bytes;
}
