/**
 * The `packages` primitive of `apply` (§6.4): the manifest's apt sources and
 * their keyrings, the packages dpkg does not already have, and the one rendered
 * directory whose files are validated before they are installed.
 */
import { APT_LOCK_TIMEOUT_SECONDS } from "@hermetic/core/shared";
import type { Host } from "../host.ts";
import { must } from "../host.ts";
import { AgentdError } from "../errors.ts";

/**
 * The one directory where a rendered file is validated before it is installed
 * (§6.4). Everywhere else a bad file breaks the thing that reads it; here a
 * syntax error makes `sudo` reject the *entire* ruleset, which on a box with no
 * key pair and no password is not a broken feature but a box whose agent can no
 * longer become root at all.
 */
export const SUDOERS_DIR = "/etc/sudoers.d/";
const KEYRING_DIR = "/usr/share/keyrings";
const SOURCES_DIR = "/etc/apt/sources.list.d";

/**
 * The bounds every `apt-get` this process runs carries on its own argv.
 *
 * `00-preflight.sh` writes the same three `Acquire::` values into
 * `/etc/apt/apt.conf.d/90hermetic`, and for the same reason: stock apt has no
 * timeouts and no retries, and the regional EC2 mirror pool is not uniformly
 * healthy — one member answers 503 for every index, the IPv6 members simply
 * hang. Unbounded, that is not an error but a ten-hour `apt-get install` with
 * no output, on a box nobody is watching.
 *
 * They are repeated here rather than inherited because `apply` must not depend
 * on a file another stage wrote. `apply` runs on every boot *and* on every
 * `hermeticd apply`, including on a box whose stage 00 predates that conf file,
 * or ran against an image where the rewrite found no regional mirror; an
 * explicit `-o` is true on all of them. Options on the argv win over the conf
 * file, and both say the same thing, so the two cannot drift into an argument.
 *
 * `DPkg::Lock::Timeout` is the one `90hermetic` does not carry: it bounds the
 * wait for the dpkg lock rather than the network, and the processes holding
 * that lock are `unattended-upgrades` and — since the agent installs its own
 * packages (§6.4) — Hermes, neither of which apt would otherwise queue behind
 * at all. The rendered `/etc/apt/apt.conf.d/91hermetic-dpkg` states the same
 * number globally so the agent's apt inherits it; both read
 * `APT_LOCK_TIMEOUT_SECONDS` rather than spelling it twice.
 */
export const APT_OPTIONS: readonly string[] = [
  "-o",
  "Acquire::Retries=3",
  "-o",
  "Acquire::http::Timeout=20",
  "-o",
  "Acquire::https::Timeout=20",
  "-o",
  `DPkg::Lock::Timeout=${String(APT_LOCK_TIMEOUT_SECONDS)}`,
];

/**
 * `apt-get update` is process-wide state, not per-apply: refreshing it once per
 * hermeticd run is enough, and a re-run of the apply stage should not re-index
 * for nothing.
 */
let aptUpdated = false;

/** Test seam: forget that this process has already refreshed the apt index. */
export function resetAptIndexState(): void {
  aptUpdated = false;
}

/**
 * Hand the missing packages to `apt-get install`, refreshing the index first
 * when a source moved or this process has not yet done so.
 */
export async function installPackages(
  host: Host,
  packages: readonly string[],
  sourcesChanged: boolean,
): Promise<void> {
  // Index refresh when a source moved, and once per process before the
  // first install — a stale index is the usual cause of a 404 from apt.
  if (sourcesChanged || !aptUpdated) {
    await must(host, ["apt-get", "update", ...APT_OPTIONS], {
      env: { DEBIAN_FRONTEND: "noninteractive" },
    });
    aptUpdated = true;
  }
  await must(
    host,
    ["apt-get", "install", "-y", "--no-install-recommends", ...APT_OPTIONS, ...packages],
    { env: { DEBIAN_FRONTEND: "noninteractive" } },
  );
}

/** `install ok installed` per `dpkg-query`; anything else counts as missing. */
export function parseDpkgQuery(stdout: string): Set<string> {
  const installed = new Set<string>();
  for (const line of stdout.split("\n")) {
    const [pkg, ...rest] = line.trim().split(/\s+/);
    if (!pkg) continue;
    if (rest.join(" ").includes("install ok installed")) installed.add(pkg);
  }
  return installed;
}

/** One `dpkg-query` for the whole list; anything it does not confirm is missing. */
export async function missingPackages(host: Host, packages: readonly string[]): Promise<string[]> {
  const dpkg = await host.exec(["dpkg-query", "-W", "-f=${Package} ${Status}\\n", ...packages]);
  const installed = parseDpkgQuery(dpkg.stdout);
  return packages.filter((p) => !installed.has(p));
}

/**
 * apt chooses how to parse a `signed-by=` file from its *extension*: `.gpg` must
 * be a binary keyring, `.asc` must be ASCII-armored. Get it wrong and the only
 * symptom is `NO_PUBKEY` on `apt-get update` — the file is there, apt just read
 * it with the wrong parser. Vendors serve both shapes (Tailscale's
 * `noble.noarmor.gpg` is binary, Docker's `/linux/ubuntu/gpg` is armored), so
 * the extension has to follow the bytes rather than the URL.
 */
function keyringPath(name: string, armored: boolean): string {
  return `${KEYRING_DIR}/${name}-archive-keyring.${armored ? "asc" : "gpg"}`;
}

/** Armored keys begin with this, possibly after leading whitespace. */
const ARMOR_MARKER = "-----BEGIN PGP";

/**
 * The first byte of a binary keyring is an OpenPGP packet tag for a public key:
 * old-format 0x98/0x99/0x9A/0x9B (tag 6, the four length encodings), new-format
 * 0xC6 (RFC 4880 §4.2). Checking it is what separates a keyring from the bodies
 * a `key_url` really returns when something is wrong — nothing at all, and a
 * proxy's HTML error page — both of which apt would accept as a `.gpg` and then
 * fail to verify with.
 */
const PGP_PUBKEY_TAGS = new Set([0x98, 0x99, 0x9a, 0x9b, 0xc6]);

/**
 * A keyring is kilobytes. Bodies past this are refused rather than installed:
 * the point is not to bound a download curl has already made, it is to keep an
 * absurd body out of `signed-by=` and out of this process's memory.
 */
const MAX_KEY_BYTES = 1_048_576;

type KeyShape = "armored" | "binary" | "invalid";

interface KeyFile {
  readonly shape: KeyShape;
  readonly bytes: Uint8Array;
}

/** Only the leading bytes decide: a binary keyring is not UTF-8 and nothing downstream wants its text. */
function shapeOf(bytes: Uint8Array): KeyShape {
  const tag = bytes[0];
  if (tag === undefined) return "invalid";
  if (new TextDecoder().decode(bytes.subarray(0, 64)).trimStart().startsWith(ARMOR_MARKER)) {
    return "armored";
  }
  // Fail closed. An unrecognised binary is rejected on purpose: the failure this
  // whole path exists to kill is apt silently being unable to read the file, and
  // guessing "probably a keyring" is how a box gets back into that state.
  return PGP_PUBKEY_TAGS.has(tag) ? "binary" : "invalid";
}

/** The file at `path`, read once and classified; `null` when it is not there. */
async function readKey(host: Host, path: string): Promise<KeyFile | null> {
  const bytes = await host.readBytes(path);
  return bytes === null ? null : { shape: shapeOf(bytes), bytes };
}

/** Size and first bytes of a body that is not a key — the cause, named without quoting it. */
function describeBody(bytes: Uint8Array): string {
  if (bytes.length === 0) return "0 bytes";
  const head = [...bytes.subarray(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
  return `${bytes.length} bytes starting ${head}`;
}

/**
 * Put the source's key on disk at a path whose extension matches its content,
 * and say where it landed so the `.list` can point at it.
 *
 * A keyring counts as installed only when its bytes agree with its extension.
 * One that does not is treated as absent *and removed*: that is the state every
 * box broken by the old unconditional `.gpg` is in, and leaving it beside the
 * good file would only invite the next reader to use it. Because the returned
 * path then differs, the `.list` is rewritten too, which is what makes a plain
 * `hermetic agent rerun` heal such a box without recreating it.
 */
export async function ensureKeyring(
  host: Host,
  name: string,
  keyUrl: string,
  dry: boolean,
): Promise<{ path: string; changed: boolean }> {
  // The source's name now steers a `rename` and two `remove`s, so it may not be
  // able to leave the keyring directory. Core validates what it renders; this
  // is the box declining to take a path from a manifest on trust.
  if (name.includes("/") || name === "." || name === "..") {
    throw new AgentdError(
      "MANIFEST_REFUSED",
      `apt source name ${JSON.stringify(name)} is not a bare name, so it cannot be a keyring path`,
      { name },
    );
  }

  const candidates = [
    [keyringPath(name, true), "armored"],
    [keyringPath(name, false), "binary"],
  ] as const;

  let good: string | null = null;
  const mismatched: Array<{ path: string; shape: KeyShape }> = [];
  for (const [path, want] of candidates) {
    const key = await readKey(host, path);
    if (key === null) continue;
    // `??=`, and `.asc` is probed first: if both extensions somehow hold a
    // valid key, the armored one wins and the other is cleaned up as a twin.
    if (key.shape === want) good ??= path;
    else mismatched.push({ path, shape: key.shape });
  }

  if (good !== null) {
    // Housekeeping, not a change: the source list already names the good file,
    // so removing its broken twin neither rewrites anything nor re-indexes apt.
    if (!dry) for (const bad of mismatched) await host.remove(bad.path);
    return { path: good, changed: false };
  }

  if (dry) {
    // A dry run downloads nothing, so the extension is knowable only from what
    // is already here — and on a broken box it is: an armored key mis-filed at
    // `.gpg` says exactly where the real run will put the re-fetched copy, so
    // the plan names the same path and reports the same `.list` rewrite. With
    // nothing to sniff, the conventional binary path stands in.
    const sniffed = mismatched.find((m) => m.shape !== "invalid");
    return { path: keyringPath(name, sniffed?.shape === "armored"), changed: true };
  }

  await host.mkdir(KEYRING_DIR);
  const tmp = `${KEYRING_DIR}/${name}-archive-keyring.tmp`;
  try {
    await must(host, ["curl", "-fsSL", "--max-filesize", String(MAX_KEY_BYTES), "-o", tmp, keyUrl]);

    // `--max-filesize` is a hint, not a guarantee: curl cannot enforce it on a
    // chunked response, whose length it only learns by reading to the end. The
    // size on disk is the answer that is always true, and it is checked before
    // the file is read into memory rather than after.
    const stat = await host.stat(tmp);
    if (stat !== null && stat.size > MAX_KEY_BYTES) {
      throw new AgentdError(
        "COMMAND_FAILED",
        `${keyUrl} returned ${stat.size} bytes, past the ${MAX_KEY_BYTES}-byte limit for a keyring`,
        { url: keyUrl, size: stat.size },
      );
    }

    // curl can exit 0 having written nothing, and a captive portal or an S3
    // error page is a 200. Neither may be renamed into place: apt's failure
    // would then be `NO_PUBKEY` on some later run, a mile from the cause.
    const key = await readKey(host, tmp);
    if (key === null || key.shape === "invalid") {
      throw new AgentdError(
        "COMMAND_FAILED",
        `${keyUrl} did not return an OpenPGP public key: ` +
          (key === null ? "curl wrote no file" : describeBody(key.bytes)),
        { url: keyUrl, path: tmp },
      );
    }

    const path = keyringPath(name, key.shape === "armored");
    await host.rename(tmp, path);
    // apt reads a `signed-by` keyring as the unprivileged `_apt` user, so a
    // restrictive umask here would break verification with the same silence.
    await host.chmod(path, "0644");
    for (const bad of mismatched) if (bad.path !== path) await host.remove(bad.path);
    return { path, changed: true };
  } catch (err) {
    // Nothing half-written may be left where the next run could adopt it. The
    // cleanup is guarded in turn: a failure to unlink must not replace the
    // error that explains what actually went wrong.
    try {
      await host.remove(tmp);
    } catch {
      // Best effort — the original failure is the one worth reporting.
    }
    throw err;
  }
}

export function sourceListPath(name: string): string {
  return `${SOURCES_DIR}/${name}.list`;
}

export function sourceListContent(uri: string, keyring: string | null): string {
  const opts = keyring === null ? "" : `[signed-by=${keyring}] `;
  return `# Rendered by hermetic. deb ${opts}${uri}\ndeb ${opts}${uri}\n`;
}

/**
 * Install a `sudoers.d` file only after `visudo` has agreed it parses.
 *
 * Staged at `<path>.new` on purpose, and the dot is the whole design: sudo
 * ignores any entry in `sudoers.d` whose name contains a `.` or a `~`, so a
 * temp file left behind by a crash between the write and the rename is inert
 * rather than half a policy. The rename is atomic, so the path is never a
 * partially written file either.
 *
 * A rejection fails the apply and carries visudo's own complaint: the operator
 * needs the line number, and hermeticd has no better wording for it than the
 * parser that found it.
 */
export async function writeSudoers(
  host: Host,
  path: string,
  content: string,
  mode: string,
): Promise<void> {
  const staged = `${path}.new`;
  await host.writeFile(staged, content, mode);
  const check = await host.exec(["visudo", "-c", "-q", "-f", staged]);
  if (check.code !== 0) {
    await host.remove(staged);
    const said = check.stderr.trim() || check.stdout.trim();
    throw new AgentdError(
      "COMMAND_FAILED",
      `visudo refused ${path}: ${said || `exited ${check.code}`}`,
      { path, code: check.code },
    );
  }
  await host.rename(staged, path);
}
