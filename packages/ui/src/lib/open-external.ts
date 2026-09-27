/**
 * Opens a link in the operator's browser, by asking the app to.
 *
 * The page never opens a window of its own. `window.open` in the app's webview
 * is a navigation the main process refuses (`app/src/main/navigation.ts`), and
 * even where it worked it would bypass the one place that decides which URLs
 * may leave the app: `app.openExternal`'s scheme and credential checks
 * (`app/src/external-url.ts`). So every button that means "open this outside"
 * comes here.
 *
 * Fire and forget, like `app.notify`: a refused or failed open has nothing for
 * the button to show, and a rejection nobody awaits must not surface as an
 * unhandled one.
 */
import { transport } from "../api/transport.ts";

export function openExternal(url: string): void {
  try {
    void transport()
      .request("app.openExternal", { url })
      .catch(() => {});
  } catch {
    // No transport installed: a page outside the app, which has no browser to
    // hand the link to either.
  }
}
