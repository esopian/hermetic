/**
 * How the page bundle is built, per build environment.
 *
 * Bun's bundler inlines `process.env.NODE_ENV` as `"development"` for a browser
 * target unless it is told otherwise, minified or not, so without a `define` a
 * canary or stable build shipped React's development build. That is slower on
 * every render, and React 19.2's development build records a
 * `performance.measure` entry (carrying a structured-cloned prop diff) for every
 * re-render whose props changed. Neither WebKit nor Chromium ever evicts user
 * timing entries, so a window left open for a day held millions of them: the
 * dev renderer reached 9.5 GB before anyone looked.
 *
 * The same convention as `renderer.ts`: only a `dev` build keeps the
 * development React, and any other environment, an unset one included, gets
 * the production build. A dev build keeps it for its warnings and DevTools
 * tracks; `packages/ui/src/entry-app.tsx` clears the measures it piles up.
 *
 * Nothing here imports the devkit, so a test drives it with a plain env.
 */
import { BUILD_ENV } from "./renderer.ts";

export interface ViewBuild {
  define?: Record<string, string>;
}

export function viewBuild(env: Record<string, string | undefined>): ViewBuild {
  if ((env[BUILD_ENV] ?? "") === "dev") return {};
  return { define: { "process.env.NODE_ENV": JSON.stringify("production") } };
}
