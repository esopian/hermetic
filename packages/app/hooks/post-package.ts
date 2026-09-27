/**
 * The `scripts.postPackage` hook: build the stable channel's DMG.
 *
 * Hutch can make the disk image itself (`build.mac.createDmg`), and it did
 * until this hook existed, but it runs
 *
 *     hdiutil create -volname <name> -srcfolder <staging> -format ULFO <out>
 *
 * with no `-size`, so the volume is exactly as large as hdiutil's own estimator
 * decides — and `ElectrobunConfig` exposes `createDmg?: boolean` and nothing
 * else, no padding knob and no environment variable. That estimator is a
 * property of the host, not of the bundle. On macOS 26 it leaves ~16 MB spare
 * on a 66 MB bundle; on the `macos-14-arm64` runner it left less than the
 * ~65 MB `Contents/Resources/<hash>.tar.zst` needed, and every release after
 * v0.1.3 died with `hdiutil: create failed - No space left on device` — on the
 * mounted `/Volumes/Hermetic`, not on the runner's disk, which had 110 GB free.
 * v0.1.3 shipped a *larger* bundle and passed, so that was the estimator
 * landing right rather than anything about the tree.
 *
 * So Hutch's DMG step is off and this hook makes the image with an explicit
 * `-size`. The padding is free: `ULFO` compresses unused blocks away, so a
 * volume with 64 MB spare produces the same DMG as one sized to the byte.
 *
 * The artifact keeps the name Hutch gave it, `macos-arm64-Hermetic.dmg`, which
 * the README, the docs and `gh release create packages/app/artifacts/*` all
 * depend on.
 *
 * Only the stable channel builds a DMG. Canary is a "does it still build"
 * check, and the app bundle plus update archive prove the same thing.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Spare space on the staging volume, in KB. Free blocks cost nothing in ULFO. */
const PADDING_KB = 64 * 1024;

const APP_NAME = "Hermetic";
const DMG_NAME = "macos-arm64-Hermetic.dmg";

/** Package root — derived from this file, because `cwd` belongs to the caller. */
const PACKAGE_ROOT = join(import.meta.dir, "..");

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`postPackage: ${command} exited ${result.status ?? "on a signal"}`);
  }
}

/** `du -sk`, in KB, of a directory tree — symlinks counted as themselves. */
function sizeKb(path: string): number {
  const du = spawnSync("du", ["-sk", path], { encoding: "utf8" });
  if (du.error) throw du.error;
  if (du.status !== 0) throw new Error(`postPackage: du exited ${du.status ?? "on a signal"}`);
  const kb = Number.parseInt(du.stdout.trim().split(/\s+/)[0] ?? "", 10);
  if (!Number.isFinite(kb) || kb <= 0) throw new Error(`postPackage: unreadable du output`);
  return kb;
}

export default function postPackage(): void {
  if (process.env.ELECTROBUN_BUILD_ENV !== "stable") return;

  // Hutch sets these for the hook; the fallbacks are its documented defaults
  // (`build.buildFolder`, `build.artifactFolder`), which this project keeps.
  const buildDir =
    process.env.ELECTROBUN_BUILD_DIR ?? join(PACKAGE_ROOT, "build", "stable-macos-arm64");
  const artifactDir = process.env.ELECTROBUN_ARTIFACT_DIR ?? join(PACKAGE_ROOT, "artifacts");

  const app = join(buildDir, `${APP_NAME}.app`);
  if (!existsSync(app)) throw new Error(`postPackage: no app bundle at ${app}`);

  // Staged next to the build rather than in the system temp directory, so the
  // copy stays on one volume and `ditto` has somewhere to put a 66 MB bundle.
  const staging = join(buildDir, ".dmg-stage");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    // `ditto` rather than `cp`: it preserves the mode bits the sidecars under
    // `Contents/Resources/app/bin` need, and the bundle's extended attributes.
    run("ditto", [app, join(staging, `${APP_NAME}.app`)]);
    run("ln", ["-s", "/Applications", join(staging, "Applications")]);

    mkdirSync(artifactDir, { recursive: true });
    const dmg = join(artifactDir, DMG_NAME);
    const volumeKb = sizeKb(staging) + PADDING_KB;
    run("hdiutil", [
      "create",
      "-volname",
      APP_NAME,
      "-srcfolder",
      staging,
      "-fs",
      "HFS+",
      "-format",
      "ULFO",
      "-size",
      `${volumeKb}k`,
      "-ov",
      "-quiet",
      dmg,
    ]);
    console.log(`created: ${dmg} (staging volume ${volumeKb} KB)`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
