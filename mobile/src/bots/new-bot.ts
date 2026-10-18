/**
 * The New bot form's pure parts: the name rule (core's `BotName`, checked as
 * the operator types), which instance it defaults to, and what a refused
 * create says.
 */
import { BotName } from "@hermetic/core/schema";
import { errorCode, errorCopy } from "../client/errors.ts";

/** Names are kept lowercase on the phone, whatever the keyboard typed. */
export const normalizeBotName = (raw: string): string => raw.trim().toLowerCase();

/**
 * Why `name` is not a bot name yet, or `null` when it is. Empty answers `null`
 * too: the Create button is off, and an empty field is not an error.
 */
export function botNameError(name: string): string | null {
  if (name.length === 0) return null;
  if (BotName.safeParse(name).success) return null;
  if (name.length > 64) return "At most 64 characters.";
  if (!/^[a-z0-9]/.test(name)) return "Start with a letter or a digit.";
  return "Use only letters, digits, dots, underscores and hyphens.";
}

/** The instance a new bot goes to first: the primary when it is listened to, else the first listened. */
export function defaultBotInstance(listened: readonly string[], primary: string | null): string | null {
  if (primary && listened.includes(primary)) return primary;
  return listened[0] ?? null;
}

/** What the form says when the create was refused. */
export function createBotErrorCopy(
  error: unknown,
  name: string,
  instance: string,
): { title: string; detail: string } {
  if (errorCode(error) === "CONFLICT")
    return {
      title: `A bot named ${name} already exists on ${instance}.`,
      detail: "Pick another name.",
    };
  return errorCopy(error);
}
