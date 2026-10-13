/**
 * Errors on the phone: what a thrown value's code is, and what the operator is
 * told about it.
 *
 * The phone throws and receives core's `HermeticError` (re-exported by
 * `@hermetic/core/chat-client`): the adapter raises `CHAT_*` codes, the fleet
 * and push calls to hermeticd raise `HERMETICD_UNAVAILABLE` and pass a box's
 * own code through (`FLEET_LIST_UNAVAILABLE` before the foundation grants the
 * scan). Turn failures inside a transcript are drawn by `failureCopy`
 * (`chat-logic.ts`); this is the copy for everything else: a band, a toast, a
 * refused action. Pure.
 */
import { HermeticError, isHermeticError, redactText } from "@hermetic/core/chat-client";

/**
 * Phone-local: a plain-HTTP call to hermeticd was not sent because HTTPS to the
 * same box had not been shown to work (`src/gateway/hermeticd.ts`, the tunnel
 * gate). Not a core code; the phone raises it and only the phone reads it.
 */
export const TUNNEL_UNVERIFIED = "TUNNEL_UNVERIFIED";

/** A thrown value's string `code`, when it carries one. */
export function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * `{ code, message }` for anything thrown, with the message through the
 * transcript mask's string door (a socket error can carry a URL, and a URL to a
 * gateway carries its session token). An abort is `ABORTED`.
 */
export function reasonOf(error: unknown): { code: string; message: string } {
  if (isHermeticError(error)) return { code: error.code, message: redactText(error.message) };
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError" || name === "TimeoutError")
    return { code: "ABORTED", message: redactText(error instanceof Error ? error.message : name) };
  const code = errorCode(error) ?? "INTERNAL";
  const message = error instanceof Error ? error.message : String(error);
  return { code, message: redactText(message) };
}

/** Whether the failure says "could not reach the box" rather than "the box said no". */
export function isUnreachable(error: unknown): boolean {
  const code = errorCode(error);
  return (
    code === "CHAT_UNREACHABLE" ||
    code === "HERMETICD_UNAVAILABLE" ||
    code === TUNNEL_UNVERIFIED ||
    code === "ABORTED"
  );
}

export { HermeticError, isHermeticError };

export interface ErrorCopy {
  title: string;
  detail: string;
}

/** One sentence and its explanation for a refused action or a failed read. */
export function errorCopy(error: unknown): ErrorCopy {
  const { code, message } = reasonOf(error);
  switch (code) {
    case "CHAT_UNREACHABLE":
      return {
        title: "The box did not answer.",
        detail:
          "Check the Tailscale app is connected and signed in to the fleet's tailnet, and that the agent is running.",
      };
    case "CHAT_NO_TOKEN":
      return {
        title: "The box answered, but not as Hermes.",
        detail: "No session token in the dashboard's page — the gateway may be restarting.",
      };
    case "CHAT_PROTOCOL":
      return {
        title: "The box answered with something this build cannot read.",
        detail: message || "This usually means the fleet's Hermes is a different version from the pin.",
      };
    case "CHAT_NO_SLOT":
      return {
        title: "The gateway had no warm backend to give this turn.",
        detail: "About three bots run warm per box. Another one has to go idle first.",
      };
    case "HERMETICD_UNAVAILABLE":
      return {
        title: "No box's agent service answered.",
        detail: "Showing the agent list from pairing. It refreshes when a box answers on the tailnet.",
      };
    case TUNNEL_UNVERIFIED:
      return {
        title: "The box could not be confirmed on the tailnet.",
        detail:
          "Its secure address did not answer, so nothing was sent to it. Check the Tailscale app is connected and signed in to the fleet's tailnet.",
      };
    case "FLEET_LIST_UNAVAILABLE":
      return {
        title: "The fleet list is not available from the boxes yet.",
        detail:
          "Showing the agent list from pairing. On the laptop, run `hermetic foundation update` and recreate the agents.",
      };
    case "NOT_FOUND":
      return { title: "Not found.", detail: message || "That bot or session is gone." };
    case "VALIDATION":
      return { title: "That was refused.", detail: message };
    case "CONFLICT":
      return { title: "That conflicts with the box's state.", detail: message };
    case "ABORTED":
      return { title: "Stopped.", detail: "The request was cancelled." };
    default:
      return { title: "Something went wrong.", detail: message || code };
  }
}
