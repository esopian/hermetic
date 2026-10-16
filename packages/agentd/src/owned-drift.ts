/**
 * Drift on the keys hermetic owns in Hermes's config (§6.4), as the heartbeat
 * watches it.
 *
 * Report-only. hermetic provisions the agent's config and then leaves Hermes
 * free to edit it; the one thing it keeps watching is the set of keys it holds
 * in the managed file (`AgentConfig.hermes_owned`). When one of those moves on
 * the box, the heartbeat writes an event saying which, and does nothing else:
 * the next apply rewrites the managed file, and that is the operator's call.
 * A key the manifest does not name is never read, so an agent changing its own
 * model, turn limit or allowlist is never reported.
 */
import { HERMES_MANAGED_CONFIG, hermesOwnedDrift, type OwnedKeyDrift } from "@hermetic/core/shared";
import type { Host } from "./host.ts";
import { MANIFEST_PATH, parseManifestJson, readAppliedConfigHash } from "./manifest.ts";

/**
 * The owned keys whose value in the box's managed file is not the one
 * rendered, or `null` when there is nothing to compare yet.
 *
 * `null` covers every case where a difference would not be drift: no manifest,
 * a manifest from before `hermes_owned` (it records nothing to watch), and a
 * fetched manifest the box has not finished applying. The last one matters:
 * between the config stage's fetch and the apply's files phase, the managed
 * file on disk is the previous configuration's, and comparing it with the new
 * record would report every changed key as drift for the length of an apply.
 * A missing managed file on an applied box is drift on every owned key, and is
 * reported as such.
 */
export async function readOwnedDrift(host: Host): Promise<OwnedKeyDrift[] | null> {
  const text = await host.readFile(MANIFEST_PATH);
  if (text === null) return null;
  let owned: Readonly<Record<string, string>> | undefined;
  let fetched: string;
  try {
    const manifest = parseManifestJson(text);
    owned = manifest.hermes_owned;
    fetched = manifest.config_hash;
  } catch {
    return null;
  }
  if (owned === undefined) return null;
  if ((await readAppliedConfigHash(host)) !== fetched) return null;
  const managed = (await host.readFile(HERMES_MANAGED_CONFIG)) ?? "";
  return hermesOwnedDrift(owned, managed);
}

/** How long one quoted value may run in an event detail. */
const VALUE_LIMIT = 60;

function clip(value: string): string {
  return value.length > VALUE_LIMIT ? `${value.slice(0, VALUE_LIMIT - 1)}…` : value;
}

/**
 * The event detail for a set of drifted keys: each key, what hermetic rendered
 * and what the box has. The managed file holds no secrets (it names the key's
 * variable, never its value), so the values are safe to print; they are
 * clipped because one of them is a paragraph-long platform hint.
 */
export function describeOwnedDrift(drift: readonly OwnedKeyDrift[]): string {
  const keys = drift.map((d) =>
    d.found === null
      ? `${d.key} (expected "${clip(d.expected)}", missing)`
      : `${d.key} (expected "${clip(d.expected)}", found "${clip(d.found)}")`,
  );
  return (
    `${HERMES_MANAGED_CONFIG} no longer says what hermetic rendered for ${keys.join("; ")}` +
    " — the next apply restores it"
  );
}

/**
 * A stable identity for a drift reading, so the heartbeat reports a change in
 * what has drifted rather than the same finding every 30 s.
 */
export function driftSignature(drift: readonly OwnedKeyDrift[]): string {
  return JSON.stringify(drift.map((d) => [d.key, d.found]));
}
