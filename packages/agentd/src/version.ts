/**
 * hermeticd's version — the one and only one.
 *
 * It is stamped in at build time by whoever compiled this binary: `scripts/build.ts`
 * for a local build, `packages/core/src/artifacts.ts` for the copy `init` and
 * `artifacts push` upload, both passing
 * `--define process.env.HERMETIC_VERSION=<pkg version>`. That is the same
 * string the laptop writes into the fleet manifest, which is exactly why there
 * must not be a second, hand-maintained literal here: a box whose label
 * disagreed with the manifest's would find itself "out of date" forever,
 * download, restart, and come back reporting the same version — every night,
 * on every box in the fleet.
 *
 * Dot-notation access is required, not `process.env["HERMETIC_VERSION"]`:
 * Bun's `--define process.env.HERMETIC_VERSION=…` only rewrites that exact
 * member-expression form. Duplicated from `@hermetic/core/version` rather than
 * imported because agentd may only ever import `@hermetic/core/schema` (§3.1,
 * tests/boundaries.test.ts).
 *
 * Reporting only. What the nightly update actually compares is the *digest* of
 * the installed binary against the manifest's (§4.4).
 */
export const HERMETICD_VERSION: string = process.env.HERMETIC_VERSION ?? "0.0.0-dev";
