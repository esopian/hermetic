/**
 * Copying the bootstrap stages (§4.3) next to a built binary.
 *
 * It is its own module because it is the one part of `scripts/build.ts` with a
 * behaviour worth testing rather than merely running: `locateStages` finds an
 * installed CLI's stages by looking for a `stages/` directory beside the
 * executable, so a build that quietly shipped none would produce a `hermetic`
 * that publishes releases no box can boot. It throws rather than exiting, so a
 * test can assert the refusal; `build.ts` turns that into a message and an
 * exit code.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Where the stages live in a source checkout, relative to the repo root. */
export const AGENTD_STAGES = "packages/agentd/stages";

/**
 * Copy `<root>/packages/agentd/stages/*.sh` into `<outDir>/stages/`. Returns
 * the file names copied, in the order `readdir` gave them. Throws when the
 * source directory is missing or holds no `.sh` file at all — either is a build
 * that would ship a `hermetic` unable to publish a bootable release.
 */
export function copyStages(root: string, outDir: string): string[] {
  const src = join(root, AGENTD_STAGES);
  if (!existsSync(src)) {
    throw new Error(
      `${AGENTD_STAGES} does not exist. The bootstrap stages ship next to the binaries; without them a built hermetic can publish a release that boots nothing.`,
    );
  }
  const stages = readdirSync(src).filter((f) => f.endsWith(".sh"));
  if (stages.length === 0) {
    throw new Error(`${AGENTD_STAGES} holds no .sh files`);
  }
  const dest = join(outDir, "stages");
  mkdirSync(dest, { recursive: true });
  for (const stage of stages) copyFileSync(join(src, stage), join(dest, stage));
  return stages;
}
