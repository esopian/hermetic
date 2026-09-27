/**
 * The webview's hot-reload server (`bun run dev:hmr`), and nothing else.
 *
 * Vite never builds the shipped page: `hutch electrobun build` bundles
 * `src/entry-app.tsx` itself and copies `index.html` across verbatim
 * (`packages/app/electrobun.config.ts`). This file exists so a dev build of the
 * app can load its page from `http://localhost:<port>` instead of `views://`,
 * and React edits land without relaunching the main process — the Vite loop
 * from Electrobun's hot-reloading guide. `scripts/dev-hmr.ts` starts it and
 * hands the URL to the app as `HERMETIC_VIEW_URL` (`app/src/main/view-url.ts`).
 *
 * `electrobun/view` is aliased to the SDK Hutch projects into
 * `packages/app/.hutch/devkit/` — the same file `tsconfig.json` maps it to —
 * because the `electrobun` package in `node_modules` is a bootstrap whose
 * exports throw. The helper refuses with a pointed message when the devkit is
 * missing (`bun run app:prepare`).
 */
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { electrobunViteAliases } from "../app/.hutch/devkit/api/config/electrobun-vite.ts";

/** Where `dev-hmr.ts` points the app. Overridable for a second checkout. */
const port = Number(process.env["HERMETIC_HMR_PORT"] ?? 5273);

/**
 * `index.html` names the *built* files (`index.js`, `entry-app.css`) because
 * the build copies it untouched. Under the dev server the entry is the source
 * module, and its CSS arrives through the module graph, so the two tags are
 * rewritten here rather than keeping a second copy of the page.
 */
function devEntry(): Plugin {
  return {
    name: "hermetic-dev-entry",
    apply: "serve",
    // `pre`, so Vite's own scan of the page never sees the built names.
    transformIndexHtml: {
      order: "pre",
      handler: (html) =>
        html
          .replace(/<link rel="stylesheet" href="\.\/entry-app\.css" \/>\n?/, "")
          .replace('src="./index.js"', 'src="/src/entry-app.tsx"'),
    },
  };
}

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), devEntry()],
  resolve: { alias: electrobunViteAliases(resolve(import.meta.dirname, "../app/.hutch/devkit")) },
  server: { port, strictPort: true, host: "127.0.0.1" },
  clearScreen: false,
});
