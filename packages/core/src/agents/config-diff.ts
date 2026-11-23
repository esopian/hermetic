/**
 * What converging one agent would change on its box (§6.5): the bundle the box
 * last applied, read back out of the bucket, against the manifest this build
 * renders for it.
 *
 * The plans print this (`ConfigChange`), and the fleet update's deferrals read
 * the applied bundle's `requires` from it, so it is computed once per agent.
 * Paths and field names only, never content: a rendered file can carry an
 * operator's prompts, and a plan is printed.
 *
 * Never throws. A plan must not fail because one object is missing or one read
 * was refused, so an unreadable bundle is a `note` and `files: null`.
 */
import { z } from "zod";
import type { ArtifactsApi } from "../backend/types.ts";
import { RenderedFile, Version } from "../schema/index.ts";
import type { Agent, AgentConfig } from "../schema/index.ts";
import { HermeticError } from "../errors.ts";
import { configManifestOf } from "../release/tar.ts";

export interface ConfigDiff {
  /** Rendered paths added, removed or changed, sorted; `null` when the applied bundle was unreadable. */
  files: string[] | null;
  /** Manifest-level fields that differ (`commands`, `packages`, `units`, …). */
  manifest: string[];
  note: string | null;
  /** The applied bundle's `requires`, or `null` when it could not be read. */
  appliedRequires: string[] | null;
}

/**
 * Just enough of an applied manifest to compare, and no more: a bundle rendered
 * by an older build must still read, so this is not the full `AgentConfig`.
 */
const AppliedManifest = z
  .object({ files: z.array(RenderedFile), requires: z.array(z.string()).optional() })
  .passthrough();

/** Compared path by path (`files`), or not at all: the hash itself, and `hermes_owned`, which is derived from `files`. */
const NOT_FIELDS = new Set(["files", "config_hash", "hermes_owned"]);

const unavailable = (note: string): ConfigDiff => ({
  files: null,
  manifest: [],
  note,
  appliedRequires: null,
});

export async function diffAppliedConfig(
  artifacts: Pick<ArtifactsApi, "getObject">,
  name: string,
  from: string | null,
  next: AgentConfig,
): Promise<ConfigDiff> {
  if (from === null) return unavailable("no applied config reported");
  const bytes = await artifacts.getObject(`config/${name}/${from}.tgz`).catch(() => null);
  const parsed = AppliedManifest.safeParse(configManifestOf(bytes));
  if (!parsed.success) return unavailable("applied bundle unavailable");
  const applied = parsed.data;

  const before = new Map(applied.files.map((f) => [f.path, f]));
  const after = new Map(next.files.map((f) => [f.path, f]));
  const files = [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => {
      const a = before.get(path);
      const b = after.get(path);
      return (
        a === undefined ||
        b === undefined ||
        a.content !== b.content ||
        a.mode !== b.mode ||
        a.owner !== b.owner ||
        a.group !== b.group
      );
    })
    .sort();

  // shortcut: compares JSON text, so a field an older renderer wrote with its
  // keys in another order reads as changed; upgrade to a canonical compare if
  // that ever shows up in a plan.
  const was = applied as Record<string, unknown>;
  const now = next as Record<string, unknown>;
  const manifest = [...new Set([...Object.keys(was), ...Object.keys(now)])]
    .filter((k) => !NOT_FIELDS.has(k) && JSON.stringify(was[k]) !== JSON.stringify(now[k]))
    .sort();

  return { files, manifest, note: null, appliedRequires: applied.requires ?? [] };
}

/**
 * The Hermes version an uploaded config bundle pins, or `null` when the bundle
 * is missing or unreadable. The bundle is the document a box installs from, so
 * it says which Hermes a config hash means even when the row's pin has moved
 * on since (`upgrade --hermes V` without `--now` moves only the pin).
 */
export async function configHermesVersion(
  artifacts: Pick<ArtifactsApi, "getObject">,
  name: string,
  hash: string | null | undefined,
): Promise<string | null> {
  if (!hash) return null;
  const bytes = await artifacts.getObject(`config/${name}/${hash}.tgz`).catch(() => null);
  return hermesOf(bytes);
}

function hermesOf(bytes: Uint8Array | null): string | null {
  const manifest = configManifestOf(bytes) as { hermes_version?: unknown } | null;
  const parsed = Version.safeParse(manifest?.hermes_version);
  return parsed.success ? parsed.data : null;
}

/**
 * `configHermesVersion` for a decision that must fail closed: a bundle that
 * cannot be read or parsed throws, keeping the read error's code when it has
 * one, so a refusal never rests on a guess about which Hermes a config names.
 */
export async function requireConfigHermesVersion(
  artifacts: Pick<ArtifactsApi, "getObject">,
  name: string,
  hash: string,
): Promise<string> {
  const key = `config/${name}/${hash}.tgz`;
  let bytes: Uint8Array | null;
  try {
    bytes = await artifacts.getObject(key);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new HermeticError(
      e instanceof HermeticError ? e.code : "HERMES_UPGRADE_REQUIRED",
      `${name}: config ${hash} could not be read (${why}), so which Hermes it installs is unknown. Nothing was changed; try again`,
      { name, config_hash: hash },
    );
  }
  const version = hermesOf(bytes);
  if (version === null) {
    throw new HermeticError(
      "HERMES_UPGRADE_REQUIRED",
      `${name}: config ${hash} is missing or unreadable at s3 key ${key}, so which Hermes it installs is unknown. ` +
        `Nothing was changed; \`hermetic plan recreate ${name}\` renders a fresh one`,
      { name, config_hash: hash },
    );
  }
  return version;
}

/**
 * The row with `running_hermes_version` taken from its applied bundle when the
 * box has not reported one (a started box whose dashboard has not answered
 * yet): the config a box last applied is the Hermes it installed. Unknown
 * stays `null`, which `hermesDeferral` still defers.
 */
export async function withAppliedHermes(
  artifacts: Pick<ArtifactsApi, "getObject">,
  agent: Agent,
): Promise<Agent> {
  if ((agent.running_hermes_version ?? null) !== null) return agent;
  const applied = await configHermesVersion(artifacts, agent.name, agent.applied_config_hash);
  return applied === null ? agent : { ...agent, running_hermes_version: applied };
}
