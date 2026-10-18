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
import { FILES_LIMITS } from "@hermetic/core/shared";

/**
 * Phone-local: more attachments were picked than one message may carry
 * (`FILES_LIMITS.attachmentsPerTurn`). The phone refuses the extra ones itself.
 */
export const ATTACHMENT_LIMIT = "ATTACHMENT_LIMIT";

/** Phone-local: iOS refused the app a device permission (the camera, for a photo). */
export const PERMISSION_DENIED = "PERMISSION_DENIED";

/** A whole-MiB cap for the attachment copy. */
const mib = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))} MiB`;

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
    // Attachments (`gateway/files.ts`): the phone's own checks and the box's refusals.
    case "FILE_TOO_LARGE":
      return {
        title: "That file is too large to attach.",
        detail: `Images can be at most ${mib(FILES_LIMITS.imageBytes)} and other files ${mib(FILES_LIMITS.fileBytes)}; the fleet may set a lower cap.`,
      };
    case "FILE_DIGEST_MISMATCH":
      return {
        title: "The upload was corrupted on the way.",
        detail: "The box received different bytes from the ones sent. Try attaching it again.",
      };
    case "FILE_NAME_INVALID":
      return {
        title: "That file name is not allowed.",
        detail: "Rename the file, then attach it again.",
      };
    case "FILE_LOOKS_SECRET":
      return {
        title: "That file looks like a private key.",
        detail: "Keys and credentials are not sent as attachments. Use a secret instead.",
      };
    case "FILE_TYPE_REJECTED":
      return { title: "The box refuses this kind of file.", detail: message };
    case "FILE_NOT_FOUND":
      return {
        title: "The attachment expired on the box.",
        detail: "Staged files are kept for a limited time. Attach it again.",
      };
    case "DISK_FULL":
      return {
        title: "The box's disk is full.",
        detail: "Free space on the agent's volume, then attach the file again.",
      };
    case ATTACHMENT_LIMIT:
      return {
        title: `At most ${FILES_LIMITS.attachmentsPerTurn} attachments per message.`,
        detail: "Send these first, or remove some.",
      };
    case PERMISSION_DENIED:
      return { title: "Hermetic does not have permission.", detail: message };
    case "UNSUPPORTED":
      return { title: "This box cannot do that yet.", detail: message };
    case "FORBIDDEN":
      return { title: "The box refused this phone.", detail: message };
    default:
      return { title: "Something went wrong.", detail: message || code };
  }
}
