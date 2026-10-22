/**
 * Ordering two builds of hermetic (§6.6): the one reading the fleet against the
 * one that last published to it (`_fleet.published_by`).
 *
 * Two laptops on different builds can share a fleet, and each renders its own
 * config. Without an order, each would see the other's render as "an update"
 * and push its own back — the config would flap with every refresh. With one,
 * only a strictly newer build offers or auto-runs an update, and an older one
 * is told it is older.
 *
 * Pure, so `foundation.status` can answer it on every read without a
 * `GetObject`.
 */
import type { BuildIdentity } from "../schema/fleet.ts";
import { compareVersions } from "../schema/fleet.ts";

export type BuildOrder = "newer" | "same" | "older" | "unknown";

/** `HERMETIC_VERSION` on a source run: not a release, so it orders nothing. */
const DEV_VERSION = /-dev$/;

/**
 * `local` relative to `published`.
 *
 * A build number orders two checkouts of the same history, so when both sides
 * have one it decides. Otherwise two stamped release versions decide. Anything
 * else — a dev run against a released app, a fleet nobody recorded — is
 * `unknown`, which never auto-runs anything: guessing "newer" here is how a
 * fleet gets moved backwards.
 */
export function compareBuild(
  local: BuildIdentity,
  published: BuildIdentity | null | undefined,
): BuildOrder {
  if (!published) return "unknown";
  if (local.build_number !== undefined && published.build_number !== undefined) {
    const d = local.build_number - published.build_number;
    return d > 0 ? "newer" : d < 0 ? "older" : "same";
  }
  if (DEV_VERSION.test(local.hermetic_version) || DEV_VERSION.test(published.hermetic_version)) {
    return "unknown";
  }
  const d = compareVersions(local.hermetic_version, published.hermetic_version);
  return d > 0 ? "newer" : d < 0 ? "older" : "same";
}
