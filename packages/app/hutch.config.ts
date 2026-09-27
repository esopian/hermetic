// @hutch cli=0.26.0 cottontail=0.6.0
/**
 * The Hutch project file for the desktop app.
 *
 * The pragma on the first line is what the `hutch` launcher reads before it
 * reads anything else: it pins the CLI this project is built with, so a
 * developer whose global Hutch is newer still builds with 0.26.0, and it names
 * the paired `cottontail` WebKit runtime that `hutch electrobun prepare`
 * resolved. `.hutch-version` at the repo root holds the CLI number for the
 * installer and `.hutch/dependencies.lock` records the runtime;
 * `test/pins.test.ts` asserts all three agree — one place to bump, three
 * consumers kept honest.
 *
 * `packageManager: "bun"` and nothing else: the workspace is an external
 * manager's territory, and the root `bun.lock` stays the only lockfile in the
 * repo. Hutch installs nothing here.
 *
 * Scripts are argv arrays wherever an argv array will do, so no argument is
 * ever re-split by a shell. The two fixture variants are the exception, and
 * they are strings on purpose: they differ from `dev` only by the environment
 * they set (`HERMETIC_FIXTURE`, `HERMETIC_UNINIT` — `state.ts` reads them in
 * `openState`), an argv array cannot carry one, and only the string form runs
 * through `Bun.$`, which honours the `VAR=value` prefix.
 */
export default {
  electrobun: { version: "2.0.1" },
  packageManager: "bun",
  scripts: {
    install: ["bun", "install"],
    prepare: ["hutch", "electrobun", "prepare"],
    dev: ["hutch", "electrobun", "dev", "--watch"],
    "dev:fixture": "HERMETIC_FIXTURE=1 hutch electrobun dev --watch",
    "dev:wizard": "HERMETIC_FIXTURE=1 HERMETIC_UNINIT=1 hutch electrobun dev --watch",
    start: ["hutch", "electrobun", "start"],
    "build:canary": ["hutch", "electrobun", "build", "--env=canary"],
    "build:stable": ["hutch", "electrobun", "build", "--env=stable"],
  },
};
