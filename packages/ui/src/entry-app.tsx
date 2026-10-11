/**
 * The page's entry, and the only one.
 *
 * Two things happen here, in this order, and the order is the reason the mount
 * sits inside an async function rather than at module scope:
 *
 * 1. the RPC transport is installed. `transport()` throws when nothing is
 *    (`api/transport.ts`) — there is one transport now and no default to fall
 *    back to — so nothing above the seam may run before this resolves.
 * 2. React mounts, and only then does the page send `page.ready`: the handshake
 *    a head with no socket has instead of a connection (`app/src/rpc/schema.ts`,
 *    `BunMessages`).
 *
 * The imports below can be static, which they could not be while the HTTP
 * transport existed: it registered itself as the default as it was *evaluated*,
 * so any static path to `api/client.ts` beat the install. Nothing in `api/`
 * installs anything at import time any more — every `transport()` is inside a
 * function — so the only ordering left to honour is "installed before the first
 * render", which `boot` states outright.
 *
 * `installRpcTransport` reaches `electrobun/view` through a dynamic import of
 * its own, because the `electrobun` package in `node_modules` is a bootstrap
 * whose every export throws: the real module comes from the Hutch devkit and
 * exists only behind `views://` (`api/transport-rpc.ts`).
 */
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installRpcTransport, sendPageReady } from "./api/transport-rpc.ts";
import { Portal } from "./Portal.tsx";
import { FleetProvider } from "./state/state.tsx";
// KaTeX's own stylesheet, first so the app's rules win where they overlap. The
// fonts it references are bundled with it (§3.6: the app is one bundle and
// never fetches a stylesheet or a face over the network).
import "katex/dist/katex.min.css";
import "./styles/polish.css";
// After polish.css, which pulls in styles.css: the chat rules are overrides of
// the app's own, and chat-soft.css is an override of chat.css. Deleting the
// second import and the `data-skin` attribute removes the soft skin whole.
import "./chat/styles/chat.css";
import "./chat/styles/chat-soft.css";
import "./chat/styles/chat-activity-status.css";
// Background-process event rows, the burst fold and the DM reply card.
import "./chat/styles/chat-events.css";
// Bot-to-bot DM markers and the exchange panel.
import "./chat/styles/bot-dm.css";
// GFM tables, thematic breaks, task boxes and math, scoped to `.ch-msg-body`.
import "./chat/styles/chat-markdown.css";
import "./chat/styles/bot-mode.css";
import "./styles/listening.css";
import "./styles/drawer.css";
import "./styles/create.css";
import "./styles/shell.css";
import "./styles/settings.css";

async function boot(): Promise<Root> {
  await installRpcTransport();

  const el = document.getElementById("root");
  if (!el) throw new Error("no #root in index.html");

  const root = createRoot(el);
  root.render(
    <StrictMode>
      <FleetProvider>
        <Portal />
      </FleetProvider>
    </StrictMode>,
  );

  sendPageReady();
  return root;
}

/**
 * The mounted root, or null when the boot failed. Nothing in the page reads it;
 * it is exported for `test/entry-app.test.ts`, which mounts the real portal and
 * has to unmount it again — bun runs every test file in one process, and a
 * portal left mounted keeps polling into whatever file runs next.
 */
export const booted: Promise<Root | null> = boot().catch((error: unknown) => {
  // The one console call in the UI that is not a mistake: this is the failure
  // that leaves a blank window, and the webview's console is forwarded to the
  // main process log, which is where it will be looked for.
  console.error("the portal failed to start", error);
  return null;
});
