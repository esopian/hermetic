/**
 * The desktop half of §4.9's notifications.
 *
 * Every rule about *whether* to notify — focused thread, quiet hours, mute,
 * per-source delivery mode — stays in the page, where the state those rules
 * read already lives. This module is only the last step the page cannot take
 * itself: raising the banner through the devkit.
 *
 * There is no permission to ask for. In the browser, `Notification` is gated by
 * a prompt because a page is a stranger to the operating system; a signed
 * application raising its own banner is not, so the answer is `"granted"` and
 * the page's permission branch becomes a branch that is never taken. The field
 * is still reported rather than dropped, because the page's state machine is
 * written against it and a bridge that answered with silence would read as a
 * delivery that failed.
 */
import { HermeticError } from "@hermetic/core";
import type { AppLog } from "../log.ts";

export interface NotifyRequest {
  title: string;
  body: string;
  /** Replaces an earlier banner carrying the same tag, as the web API does. */
  tag?: string;
}

export interface NotifyResult {
  delivered: true;
  permission: "granted";
}

export interface NotifierDeps {
  /** `Utils.showNotification`, structurally. The real object arrives from `main/index.ts`. */
  showNotification(options: { title: string; body: string; tag?: string }): void;
  log: Pick<AppLog, "line">;
}

export function createNotifier(deps: NotifierDeps): (request: NotifyRequest) => NotifyResult {
  return (request) => {
    const title = request.title.trim();
    const body = request.body.trim();

    // A banner with no title is a banner the operator cannot act on, and macOS
    // renders it as a nameless box from a nameless app. Refuse at the bridge
    // rather than let an empty string reach the notification centre.
    if (title === "" || body === "") {
      throw new HermeticError("VALIDATION", "A notification needs both a title and a body.");
    }

    const tag = request.tag?.trim();
    deps.showNotification(tag === undefined || tag === "" ? { title, body } : { title, body, tag });

    // §8.3: the title and body are the message, so neither is logged. The tag
    // is a routing key the page chose and is safe to correlate against.
    deps.log.line("debug", "notify", "raised desktop notification", { tag: tag ?? null });

    return { delivered: true, permission: "granted" };
  };
}
