/**
 * What a booting box is told: the release the fleet manifest names and the
 * cloud-init document that fetches it. Shared by `create` and `recreate`, and
 * built once in `createLifecycle` so the two can never disagree. Split out of
 * `lifecycle.ts` for size; the design comments travelled with the code.
 */
import { cloudName } from "../../schema/index.ts";
import type { FleetItem } from "../../schema/index.ts";
import { HermeticError } from "../../errors.ts";
import { readFleetManifest } from "../../release/artifacts.ts";
import { cloudInitUserData, userDataJson } from "../../render/cloud-init.ts";
import type { CoreContext } from "../../context.ts";

export type ReleaseLookup = ReturnType<typeof createRelease>;

export function createRelease(deps: Pick<CoreContext, "backend" | "hermeticdVersion">) {
  const { backend, hermeticdVersion } = deps;

  /**
   * The release every new boot fetches: whatever the *fleet manifest* names
   * (§1). It is read rather than assumed because the version is a fleet-level
   * fact the nightly update follows — a per-agent pin would let one box fetch a
   * binary nothing else in the fleet is running.
   */
  async function currentRelease(): Promise<{
    version: string;
    key: string;
    sha256: string;
    /** Which build pushed it (§3.6); `null` on a manifest written before builds were recorded. */
    build: string | null;
  }> {
    const manifest = await readFleetManifest(backend.artifacts);
    const binary = manifest?.hermeticd.files["hermeticd"];
    if (!manifest || !binary) {
      throw new HermeticError(
        "NOT_FOUND",
        "the fleet manifest names no hermeticd release; run `hermetic artifacts push` first",
        { version: hermeticdVersion },
      );
    }
    return {
      version: manifest.hermeticd.version,
      key: binary.key,
      sha256: binary.sha256,
      build: manifest.hermeticd.build ?? null,
    };
  }

  /**
   * §6.3: the whole of first boot, for `create` and `recreate` alike — one
   * helper so the two can never disagree about what a booting instance is told.
   * The release is passed in rather than read again: the caller has already
   * read it to stamp `hermeticd_version` on the row, and a second read could
   * return a version the row does not name.
   * The script is ten lines of bash that fetch, verify and exec `hermeticd`;
   * everything after uses the SDK, the instance role and the fleet manifest.
   * The JSON it embeds carries a bucket, a URL and a digest, never a value.
   */
  async function userDataFor(
    name: string,
    fleet: FleetItem,
    release: { key: string; sha256: string },
  ): Promise<string> {
    const url = await backend.artifacts.presign(release.key);
    return cloudInitUserData(
      userDataJson({
        name,
        // §5: the OS hostname, and therefore the name the node asks the tailnet
        // for. Prefixed with the fleet id since v4 so two fleets' `atlas` are
        // two devices, and so a later rename cannot invalidate what is written
        // here — this string is fixed for the life of the box.
        hostname: cloudName(fleet.fleet_id, name),
        bucket: fleet.bucket,
        hermeticd_url: url,
        hermeticd_sha256: release.sha256,
      }),
    );
  }

  return { currentRelease, userDataFor };
}
