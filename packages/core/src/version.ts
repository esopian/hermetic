/**
 * The version of the `hermetic` tool suite itself (the CLI/server/agentd
 * binaries as built), stamped in at build time with
 * `bun build --define HERMETIC_VERSION=<pkg version>` (see `scripts/build.ts`).
 *
 * This is distinct from `BUILD_VERSIONS` in `hermetic.ts`, which pins the
 * `hermes`/`hermeticd` versions a given build of hermetic ships and upgrades
 * agents to — that is fleet software this tool manages, not the tool itself.
 *
 * A dev run (`bun run cli`, `bun test`, …) never sets the env var, so it falls
 * back to a value that is obviously not a release.
 */
// Dot-notation access is required, not `process.env["HERMETIC_VERSION"]`: Bun's
// `bun build --define process.env.HERMETIC_VERSION=…` only rewrites the exact
// member-expression form, so `scripts/build.ts` and this file must agree on it.
export const HERMETIC_VERSION: string = process.env.HERMETIC_VERSION ?? "0.0.0-dev";

/**
 * The version of the *foundation contract*: the CloudFormation template of §5,
 * the S3 layout of §1, and the shape of the remote state (`_fleet`, the fleet
 * manifest). Bump it whenever any of those change, add a `FOUNDATION_MIGRATIONS`
 * entry for the change, and update the digest table in
 * `packages/core/test/foundation-version.test.ts`.
 *
 * Distinct from both the other two versions in this repo, and never conflated
 * with either: `BUILD_VERSIONS.hermeticd` (`hermetic.ts`) is the fleet software
 * this build ships, and `HERMETIC_VERSION` above is the tool build itself.
 *
 * A fleet whose `_fleet` item carries no `foundation_version` is version **0** —
 * every fleet created before this existed — and `foundation.update` is what
 * moves it forward (§6.6).
 */
export const FOUNDATION_VERSION = 15;
