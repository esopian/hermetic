/**
 * Where a box's Hermes checkout comes from.
 *
 * Every agent used to clone `github.com/NousResearch/hermes-agent` from the box
 * itself at boot, which makes agent creation depend on a third party's
 * availability and leaves the bytes un-pinned. The fleet bucket already carries
 * every other byte a box needs, each named by a sha256 in the fleet manifest —
 * Hermes was the exception.
 *
 * So the laptop mirrors the checked-out tree into `hermes/<ref>.bundle` and
 * records its digest in `FleetManifest.hermes`, and this module is the box half:
 * read the manifest, fetch the bundle, refuse bytes whose digest is wrong, and
 * leave a file `git clone` and `git fetch` accept as a remote. A fleet whose
 * manifest carries no entry for the ref — one created before the mirror landed,
 * or one whose mirror push failed — gets `null`, and the caller falls back to
 * the direct clone.
 *
 * A bundle is *not* made from a shallow clone (that produces a repo claiming a
 * history it does not have, where every traversal fails); it is a synthesized
 * single root commit over the tree, tagged with the ref. So the commit sha on
 * the box is hermetic's, not upstream's, and the real provenance survives only
 * in the manifest's `upstream_sha` and in the ref marker this module formats.
 */
import type { FleetManifest, HermesBundleEntry } from "@hermetic/core/schema";
import { realAws } from "./aws.ts";
import { AgentdError } from "./errors.ts";
import { readUsableFleetManifest, STATE_DIR } from "./fleet.ts";
import type { Host } from "./host.ts";
import { redactValue } from "./redact.ts";
import { sha256Hex } from "./stages.ts";

/** One object out of the fleet bucket. Injected so the apply path is testable. */
export type ObjectFetch = (bucket: string, key: string) => Promise<Uint8Array>;

/**
 * Where the fetched bundle is staged. One fixed name rather than one per ref:
 * it is deleted as soon as git has read it, so two of them never coexist, and a
 * constant path keeps a manifest-supplied ref out of a filesystem path.
 */
export const HERMES_BUNDLE_PATH = `${STATE_DIR}/hermes.bundle`;

/** A bundle on disk, ready for `git clone` or `git fetch`. */
export interface HermesBundle {
  /** Absolute path of the staged bundle file. */
  readonly path: string;
  /** The upstream commit the mirrored tree was taken from. */
  readonly upstreamSha: string;
}

/** `HERMES_REF_MARKER`, parsed. */
export interface HermesRefMarker {
  readonly ref: string;
  /**
   * `null` for a marker written by an older hermeticd, and for any checkout
   * that came from the direct clone — there the commit *is* upstream's, so
   * there is nothing the marker could add.
   */
  readonly upstreamSha: string | null;
}

/**
 * Read the marker. Tolerates the one-line form, which is what every box
 * installed before the mirror landed has on disk.
 */
export function parseRefMarker(text: string | null): HermesRefMarker | null {
  if (text === null) return null;
  const lines = text.split("\n").map((line) => line.trim());
  const ref = lines[0] ?? "";
  if (ref === "") return null;
  const upstream = lines[1] ?? "";
  return { ref, upstreamSha: upstream === "" ? null : upstream };
}

/** The inverse: one line for a direct clone, two when a bundle named a commit. */
export function formatRefMarker(ref: string, upstreamSha: string | null): string {
  return upstreamSha === null ? `${ref}\n` : `${ref}\n${upstreamSha}\n`;
}

/**
 * The real S3 read, used when the caller injected none.
 *
 * Defaulted rather than required so that a box gets the mirror without every
 * caller of `apply` having to thread a client through — an absent dependency
 * must not silently turn the mirror off, which is the same reasoning core's
 * §4.7 preflight carries. `realAws` also builds DynamoDB and SSM clients that
 * nothing here calls; constructing a client makes no request, and the
 * alternative is a second copy of the S3 body decoding.
 *
 * Exported because the browser mirror (`browser-source.ts`) reads out of the
 * same bucket with the same credentials, and two spellings of "the fleet's own
 * S3 read" is a drift nobody would notice until one of them stopped working.
 */
export function realObjectFetch(fleet: FleetManifest, host: Host): ObjectFetch {
  const region = process.env["AWS_REGION"] ?? fleet.region;
  const aws = realAws(region, () => host.now(), {
    agents: fleet.resources.agents_table,
    events: fleet.resources.events_table,
  });
  return (bucket, key) => aws.getObjectBytes(bucket, key);
}

/**
 * The fleet's mirror of one Hermes ref, staged on the box — or `null` when this
 * fleet has no mirror of it and the caller should clone from github.com.
 *
 * Three outcomes, and the difference between them matters:
 *
 *   - **no entry** — `null`, silently. A fleet pushed before the mirror existed
 *     is not a fleet with a problem; it is a fleet on the documented fallback.
 *   - **the read failed** — `null`, with a warning. The instance role's S3 read
 *     is scoped by the foundation template, so a box on a fleet that has not
 *     taken the policy widening gets `AccessDenied` here; falling back is what
 *     keeps it bootable.
 *   - **the bytes are not the ones pinned** — `CHECKSUM_MISMATCH`, and the apply
 *     stops. Both halves of the manifest's record are checked, length then
 *     digest. Bytes that fail either are never quietly replaced with bytes from
 *     somewhere else: that would turn a pinned install into an unpinned one at
 *     exactly the moment something is provably wrong.
 */
export async function fetchHermesBundle(
  host: Host,
  ref: string,
  warn: (message: string) => void,
  getObject?: ObjectFetch,
): Promise<HermesBundle | null> {
  // Before anything else, including the manifest read. A bundle staged by an
  // apply that was killed between `writeBytes` and the clone is not these bytes
  // and is nobody's to collect: the removal further down only runs on the path
  // that got as far as fetching, so on "no entry" and "the read failed" a stale
  // file would sit in `STATE_DIR` at the size of a whole Hermes tree until some
  // later apply happened to take the success path. Removing first makes the only
  // `hermes.bundle` that outlives this call one that this call wrote.
  await host.remove(HERMES_BUNDLE_PATH);

  const fleet = await readUsableFleetManifest(host, warn);
  const entry: HermesBundleEntry | undefined = fleet?.hermes?.[ref];
  if (!fleet || !entry) return null;

  const bucket = fleet.resources.bucket;
  let bytes: Uint8Array;
  try {
    bytes = await (getObject ?? realObjectFetch(fleet, host))(bucket, entry.key);
  } catch (e) {
    warn(
      `could not read s3://${bucket}/${entry.key} ` +
        `(${redactValue(e instanceof Error ? e.message : String(e))}); ` +
        `cloning hermes ${ref} from upstream instead`,
    );
    return null;
  }

  // Length before digest, because the manifest records both and a short read is
  // the failure the length describes exactly: `size` is what the laptop uploaded
  // and `byteLength` is what arrived, so a truncated body is named as one
  // instead of being reported as bytes whose sha256 came out wrong. Same code
  // either way — both mean "these are not the bytes the manifest pinned", and
  // neither is a reason to fall back to an unpinned source.
  if (bytes.byteLength !== entry.size) {
    throw new AgentdError(
      "CHECKSUM_MISMATCH",
      `${entry.key} is ${bytes.byteLength} bytes, not the ${entry.size} the fleet manifest records`,
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

  await host.mkdir(STATE_DIR, "0755");
  await host.writeBytes(HERMES_BUNDLE_PATH, bytes, "0600");
  return { path: HERMES_BUNDLE_PATH, upstreamSha: entry.upstream_sha };
}
