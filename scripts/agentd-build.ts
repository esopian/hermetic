/**
 * How `hermeticd` is compiled, as data rather than as a side effect.
 *
 * It is its own module for the same reason `stages.ts` is: this is the part of
 * `scripts/build.ts` with a behaviour worth testing rather than merely running,
 * and `build.ts` cannot be imported by a test because it builds on import.
 *
 * The behaviour in question is one string. `hermeticd` must be stamped with
 * `BUILD_VERSIONS.hermeticd` — the release version the laptop writes into the
 * fleet manifest — and *not* with the tool's own `HERMETIC_VERSION` from root
 * `package.json`, which is what the two heads get. They are different numbers
 * (`0.5.0` and `0.1.0` as this is written) and nothing downstream can tell the
 * mistake from the truth: `resolveHermeticd` checks the stamp *file* beside the
 * binary, never the binary, so a hermeticd compiled with the wrong one pushes
 * cleanly and then reports a version no fleet manifest ever names. Every agent
 * reads as out of date forever, `foundation update`'s rollout never confirms,
 * and the only symptom is a number that will not move.
 *
 * `tests/build-stamp.test.ts` holds the compiled-in version equal to the stamp.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { BUILD_VERSIONS } from "../packages/core/src/hermetic.ts";

/** hermeticd is always linux-arm64, whatever the laptop is (§3.6). */
export const AGENTD_TARGET = "bun-linux-arm64";

/** The agentd entrypoint, relative to the repo root. */
export const AGENTD_ENTRY = "packages/agentd/src/main.ts";

/**
 * The `--define` flag `bun build` takes, in the one form Bun rewrites.
 *
 * Bun only substitutes the exact member-expression `process.env.HERMETIC_VERSION`
 * — not `process.env["HERMETIC_VERSION"]` — so this string and the access in
 * `packages/agentd/src/version.ts` have to agree character for character. Both
 * say so in a comment; the test checks it rather than trusting either.
 */
export const VERSION_DEFINE = "process.env.HERMETIC_VERSION";

export interface AgentdBuildPlan {
  /** The full `bun build` argv. */
  readonly args: readonly string[];
  /** Compiled into the binary, and written to `<outfile>.version`. */
  readonly version: string;
  readonly outfile: string;
  readonly entry: string;
}

/** What `build.ts` runs, and what the test inspects without running it. */
export function agentdBuildPlan(root: string, outfile: string): AgentdBuildPlan {
  const entry = join(root, AGENTD_ENTRY);
  const version = BUILD_VERSIONS.hermeticd;
  return {
    version,
    entry,
    outfile,
    args: [
      "bun",
      "build",
      "--compile",
      `--target=${AGENTD_TARGET}`,
      "--define",
      `${VERSION_DEFINE}="${version}"`,
      entry,
      "--outfile",
      outfile,
    ],
  };
}

/**
 * The version a plan's argv actually stamps in, read back out of the flag.
 *
 * The test asserts on this rather than on `plan.version` so that it is checking
 * the argv that will be run, not the field the argv was built from — the bug
 * this module exists to prevent was exactly a correct-looking field next to an
 * argv built from a different one.
 */
export function stampedVersion(args: readonly string[]): string | null {
  const i = args.indexOf("--define");
  if (i === -1) return null;
  const flag = args[i + 1];
  if (flag === undefined) return null;
  const prefix = `${VERSION_DEFINE}="`;
  if (!flag.startsWith(prefix) || !flag.endsWith('"')) return null;
  return flag.slice(prefix.length, -1);
}

/**
 * The three files a build lays down for `hermeticd`: the binary, the release
 * version stamp `resolveHermeticd` checks before it pushes, and the source
 * fingerprint `releaseDrift` compares. All three, or the copy is not a release.
 */
export const AGENTD_ARTIFACTS = ["hermeticd", "hermeticd.version", "hermeticd.build"] as const;

/**
 * Copy `hermeticd` and both of its stamps from one directory into another, so
 * that a cross-compiled `dist/<target>/` is a self-contained install rather
 * than a head that has to find its agent somewhere else.
 *
 * `hermeticd` is the same linux-arm64 binary for every target — it runs on the
 * box, never on the laptop — so it is compiled once and copied, not rebuilt per
 * target. The stamps travel with it because `resolveHermeticd` reads them from
 * beside the binary it found: a bundle carrying the binary alone would push a
 * release whose build nobody can name, and `releaseDrift` would go silent.
 *
 * Throws when any of the three is missing, for the same reason `copyStages`
 * does: a target directory that quietly shipped no agent produces a `hermetic`
 * that falls back to a source checkout on the machine that built it and fails
 * with `HERMETICD_UNAVAILABLE` on every machine that installed it.
 */
export function copyAgentd(fromDir: string, outDir: string): string[] {
  for (const name of AGENTD_ARTIFACTS) {
    if (!existsSync(join(fromDir, name))) {
      throw new Error(
        `${join(fromDir, name)} does not exist. Every distributed target directory ships hermeticd and both of its stamps; without them an installed hermetic cannot push a release.`,
      );
    }
  }
  mkdirSync(outDir, { recursive: true });
  for (const name of AGENTD_ARTIFACTS) {
    copyFileSync(join(fromDir, name), join(outDir, name));
  }
  return [...AGENTD_ARTIFACTS];
}
