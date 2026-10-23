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
import { RenderedFile } from "../schema/index.ts";
import type { AgentConfig } from "../schema/index.ts";
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
