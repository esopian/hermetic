/**
 * The one rule for what this process may hand the operator's browser.
 *
 * Three callers reach `Utils.openExternal`, and all three go through here: the
 * page's `app.openExternal` request (`handlers/app.ts`), a link or `window.open`
 * the main window refused to navigate to (`main/navigation.ts`), and the
 * updater's "open the release page" (`main/updates.ts`). One predicate rather
 * than three copies, because the second copy is the one that forgets the
 * credentials check.
 */
import { HermeticError } from "@hermetic/core";

/**
 * The scheme is the whole point of the check. `openExternal` is the OS's "open
 * this with whatever claims it", so an unfiltered string is a page asking the
 * main process to launch `file:///…`, a custom scheme registered by some other
 * application, or a `javascript:` payload — a privilege the page does not have
 * itself and must not borrow. Two schemes are enough for everything the UI
 * links to (docs, the AWS console, a box's own https endpoints).
 */
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/**
 * The normalised URL to open, or a `VALIDATION` refusal saying why not.
 */
export function externalUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // A relative link is a page bug rather than an attack, and it is refused
    // for the same reason: nothing outside this app knows what it means.
    throw new HermeticError("VALIDATION", `${url} is not a URL a browser can be handed.`);
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new HermeticError(
      "VALIDATION",
      `Only http and https links are opened outside the app; ${parsed.protocol} is not.`,
    );
  }
  /**
   * `https://user:pass@host/` is a well-formed https URL and still not one to
   * hand over: the credentials travel into the operator's browser, its history
   * and whatever a proxy logs, and §8.3 says a secret does not leave this
   * process by accident. No link the UI builds carries any.
   */
  if (parsed.username !== "" || parsed.password !== "") {
    throw new HermeticError(
      "VALIDATION",
      "A link with credentials in it is not opened outside the app.",
    );
  }
  return parsed.href;
}
