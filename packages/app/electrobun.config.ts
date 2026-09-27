/**
 * The Electrobun build description.
 *
 * `mainProcess: "bun"` is load-bearing: `@hermetic/core` is built on the real
 * Bun runtime — `bun:sqlite` for the local database, `Bun.spawn` for `git` and
 * `tailscale` — so the main process cannot be the lighter JavaScriptCore host.
 *
 * The version is read from the root `package.json` rather than repeated here.
 * The app, the CLI and the portal have always shipped one version number, and a
 * second place to bump is a second place to forget.
 *
 * `ElectrobunConfig` comes from the devkit Hutch projects into
 * `.hutch/devkit/` — the `electrobun` npm package is a bootstrap whose exports
 * throw and ships no types at all — so this file only typechecks on a checkout
 * where `bun run app:prepare` has run. `satisfies` rather than an annotation:
 * the literal keeps its own narrow types, and an unknown key is still an error.
 */
import type { ElectrobunConfig } from "electrobun/bun";
import pkg from "../../package.json" with { type: "json" };

/** Set by `scripts/dev-hmr.ts`, which also starts the server it names. */
const hmr = (process.env["HERMETIC_VIEW_URL"] ?? "") !== "";

export default {
  app: { name: "Hermetic", identifier: "sh.hermetic.app", version: pkg.version },
  runtime: { exitOnLastWindowClosed: true },
  build: {
    mainProcess: "bun",
    bun: { entrypoint: "src/main/index.ts" },
    // `entry-app.tsx` installs the RPC transport before the app mounts, and
    // `index.html` links the emitted `index.js` + `entry-app.css` (the
    // stylesheet is named after the entry's basename). The page is copied
    // verbatim rather than generated, because Hutch emits no HTML of its own.
    views: { main: { entrypoint: "../ui/src/entry-app.tsx" } },
    copy: {
      "../ui/index.html": "views/main/index.html",
      "../ui/fonts": "views/main/fonts",
      "dist/bin": "bin",
    },
    // Under `bun run dev:hmr` the page is Vite's (`main/view-url.ts`), so a UI
    // edit is a hot update and must not also relaunch the app: the view's
    // sources come out of the watch and only main-process code rebuilds.
    watch: hmr ? ["../core/src"] : ["../ui/src", "../core/src"],
    watchIgnore: hmr ? ["dist/**", "../ui/**"] : ["dist/**"],
    // `createDmg: false` even on the stable channel: Hutch's own DMG step runs
    // `hdiutil create … -format ULFO` with no `-size`, so the volume is only as
    // large as hdiutil's estimator guesses, and on the macos-14 runner that was
    // too small for the bundle's ~65 MB update payload ("No space left on
    // device" on the mounted /Volumes/Hermetic, with 110 GB free on the disk).
    // `scripts.postPackage` below makes the stable DMG instead, with an
    // explicit size — see `hooks/post-package.ts`.
    // `assets/icon.iconset` is rendered from `assets/icon-1024.png` with `sips`
    // (16 to 512, @1x and @2x); regenerate the set from that file, never edit
    // the sizes by hand.
    mac: { createDmg: false, icons: "assets/icon.iconset", bundleCEF: false },
    // Code signing and notarisation are driven by ELECTROBUN_DEVELOPER_ID /
    // ELECTROBUN_APPLEID / ELECTROBUN_APPLEIDPASS / ELECTROBUN_TEAMID, so an
    // unsigned local build needs no edit here and a release needs no secret in
    // the repository.
  },
  // Build hooks are top-level, not `build.hooks`: a `build.hooks` key is
  // silently ignored by the builder, which is why the sidecars never staged.
  // The value is a module path resolved against this package, and Hutch calls
  // that module's default export — not a shell line (`hooks/pre-build.ts`).
  // `postPackage` runs once the artifacts are written; it builds the stable
  // channel's DMG, which Hutch no longer makes (see `build.mac.createDmg`).
  // It reads `ELECTROBUN_BUILD_ENV` itself — there is no per-environment
  // override block in `ElectrobunConfig`, so a canary build calls the same
  // module and returns early.
  scripts: { preBuild: "./hooks/pre-build.ts", postPackage: "./hooks/post-package.ts" },
  release: {
    baseUrl: "https://github.com/esopian/hermetic/releases/latest/download",
    generatePatch: true,
  },
} satisfies ElectrobunConfig;
