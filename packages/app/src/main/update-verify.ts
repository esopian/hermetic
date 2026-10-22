/**
 * The gate between Electrobun downloading an update and Electrobun installing
 * it: is the prepared tar the one the release key signed?
 *
 * `Updater.downloadUpdate()` leaves the new build as a decompressed tar in the
 * app's data folder and describes it in a small JSON record; `applyUpdate()`
 * reads that record and hands the tar to a native helper that swaps the
 * bundle. This module reads the same record, hashes the same tar, fetches the
 * signature asset for that exact update from the release, and checks it
 * (`@hermetic/core`'s `verifyAppUpdate`). Anything short of a good signature
 * discards the download, so a later `applyUpdate()` has nothing to install.
 *
 * The record's location and shape are the devkit's (`PREPARED_UPDATE_FILE` in
 * its `core/Updater.ts`), so they are validated strictly rather than trusted:
 * a record that names a tar anywhere but the devkit's own path is refused.
 */
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type AppUpdateTarget,
  appUpdateSignatureFile,
  sha256File,
  verifyAppUpdate,
} from "@hermetic/core";
import { z } from "zod";
import { isNewerVersion } from "./updates.ts";

/** The devkit's record of the download `applyUpdate` will install. */
const PreparedUpdate = z.object({
  schema_version: z.literal(1),
  identifier: z.string(),
  channel: z.string(),
  version: z.string(),
  hash: z.string().regex(/^[a-z0-9]{1,13}$/),
  platform: z.string(),
  arch: z.string(),
  retained_tar_path: z.string(),
});

/** A signature is 64 bytes, so its base64 is under 100; anything longer is not one. */
const MAX_SIGNATURE_BYTES = 1024;

export type VerifyResult = { ok: true; version: string } | { ok: false; reason: string };

export interface VerifyDeps {
  /** `Updater.appDataFolder()`: where the devkit keeps its `self-extraction/` folder. */
  appDataFolder(): Promise<string>;
  /** This bundle's own `version.json`. */
  local: { identifier: string; channel: string; version: string };
  /** Where the release assets are: a constant, never anything the manifest says. */
  assetsUrl: string;
  fetch(url: string, init: { signal: AbortSignal }): Promise<Response>;
  /** Injected for tests; the compiled-in release key otherwise. */
  publicKey?: string;
}

export async function verifyPreparedUpdate(deps: VerifyDeps): Promise<VerifyResult> {
  const folder = join(await deps.appDataFolder(), "self-extraction");
  const recordPath = join(folder, ".electrobun-prepared-update.json");
  let tarPath: string | null = null;
  const refuse = (reason: string): VerifyResult => {
    // Discard, so `applyUpdate` finds nothing to install and the next check
    // downloads afresh instead of reusing what failed.
    rmSync(recordPath, { force: true });
    if (tarPath !== null) rmSync(tarPath, { force: true });
    return { ok: false, reason };
  };

  let record: z.infer<typeof PreparedUpdate>;
  try {
    record = PreparedUpdate.parse(await Bun.file(recordPath).json());
  } catch (e: unknown) {
    return refuse(`no readable prepared update: ${e instanceof Error ? e.message : String(e)}`);
  }
  const expectedTar = resolve(folder, `${record.hash}.tar`);
  if (record.retained_tar_path !== expectedTar) {
    return refuse(`prepared update names an unexpected tar: ${record.retained_tar_path}`);
  }
  tarPath = expectedTar;
  if (record.identifier !== deps.local.identifier || record.channel !== deps.local.channel) {
    return refuse(`prepared update is for ${record.identifier}/${record.channel}`);
  }
  if (!isNewerVersion(record.version, deps.local.version)) {
    return refuse(`prepared update ${record.version} is not newer than ${deps.local.version}`);
  }

  const target: AppUpdateTarget = {
    identifier: record.identifier,
    channel: record.channel,
    platform: record.platform,
    arch: record.arch,
    version: record.version,
    hash: record.hash,
  };
  let signature: string;
  try {
    const url = `${deps.assetsUrl}/${appUpdateSignatureFile(target)}`;
    const response = await deps.fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) return refuse(`signature request failed with HTTP ${response.status}`);
    signature = await response.text();
    if (signature.length > MAX_SIGNATURE_BYTES) return refuse("signature asset is too large");
  } catch (e: unknown) {
    return refuse(`signature unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }

  let digest: string;
  try {
    digest = await sha256File(tarPath);
  } catch (e: unknown) {
    return refuse(`prepared tar unreadable: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!verifyAppUpdate(signature, target, digest, deps.publicKey)) {
    return refuse(`signature does not verify for ${record.version}`);
  }
  return { ok: true, version: record.version };
}
