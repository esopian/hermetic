/**
 * `HermeticError.code` → process exit status. Core never exits (§3.2 rule 1);
 * this table is the CLI's half of that contract, and scripts depend on it.
 */
import type { ErrorCode } from "@hermetic/core";

export const EXIT_OK = 0;
/** Anything not otherwise mapped. */
export const EXIT_FAILURE = 1;
/** The parsed flags failed core's Zod schema. */
export const EXIT_VALIDATION = 2;
/** Ctrl-C: the op was aborted through its AbortSignal. */
export const EXIT_ABORTED = 130;

export const EXIT_CODES: Readonly<Record<ErrorCode, number>> = {
  NOT_INITIALIZED: 3,
  ACCOUNT_MISMATCH: 4,
  FLEET_MISMATCH: 4,
  NAME_INVALID: 5,
  NAME_TAKEN: 5,
  NOT_FOUND: 6,
  CONFLICT: 7,
  /**
   * A reviewed plan no longer matches the row (§6.7). A conflict with reality
   * like `CONFLICT`, and nothing was done — it exits the same, and is its own
   * code so a caller can tell "re-plan and try again" from every other 7.
   */
  PLAN_STALE: 7,
  LOCKED: 7,
  INVALID_TRANSITION: 7,
  AGENTS_EXIST: 7,
  CONFIRMATION_REQUIRED: 8,
  /**
   * §4.8: the home holds more than one fleet and nothing said which. It is a
   * bad invocation, not a bad account, so it exits like any other validation
   * failure — `--fleet` is the missing argument.
   */
  FLEET_REQUIRED: EXIT_VALIDATION,
  /**
   * The fleet's foundation is newer than this build knows (§6.6). Same family
   * as `FLEET_MISMATCH`: the tool is pointed at something it must not touch.
   */
  FOUNDATION_NEWER: 4,
  /**
   * The change set would replace a stateful resource, so the update refused
   * (§6.6). A conflict with reality, like `LOCKED` — nothing was done.
   */
  FOUNDATION_UNSAFE: 7,
  /** The request was refused, not rejected — same family as a guard failure. */
  FORBIDDEN: 4,
  /** Input failed core's schema; the same status a Commander/Zod failure gets. */
  VALIDATION: EXIT_VALIDATION,
  /**
   * A conflict with reality, like `LOCKED`: the volume is attached, or it is
   * not one hermetic may touch. Nothing was done.
   */
  VOLUME_IN_USE: 7,
  VOLUME_UNUSABLE: 7,
  /**
   * The row names a data volume that no longer exists (§6.5). A conflict with
   * reality like the two above it, and nothing was done: `recreate` stopped
   * before it terminated anything.
   */
  VOLUME_MISSING: 7,
  /**
   * The recorded instance or volume is tagged for another agent or fleet (§6.7).
   * A conflict with reality like the two above it: nothing was done.
   */
  RESOURCE_NOT_OWNED: 7,
  SG_INBOUND_RULE: 9,
  /** A precondition of the environment (§4.8): the account's directory table. */
  DIRECTORY_UNAVAILABLE: 9,
  SECRETS_DISABLED: 9,
  /** A precondition of the environment, like the two above it. */
  TAILSCALE_UNAVAILABLE: 9,
  HERMETICD_UNAVAILABLE: 9,
  /**
   * The fleet manifest records a key outside the release it publishes (§3.6).
   * A precondition of the fleet rather than of the invocation, and the remedy is
   * the same as the line above it: `hermetic artifacts push`.
   */
  MANIFEST_REFUSED: 9,
  /** Also a precondition of the environment: this checkout is not committed (§3.6). */
  WORKING_TREE_DIRTY: 9,
  /**
   * §8.3's model catalog: the provider could not be reached, or refused the
   * credential, or answered with something that is not a catalog. Each is a
   * precondition of the environment rather than a bad invocation, so they join
   * the other 9s.
   */
  PROVIDER_UNREACHABLE: 9,
  PROVIDER_AUTH: 9,
  PROVIDER_MALFORMED: 9,
  /** Nothing said which profile, and more than one would fit: a bad invocation. */
  AMBIGUOUS_PROFILE: EXIT_VALIDATION,
  /** The profile still has agents on it: a conflict with reality, like `VOLUME_IN_USE`. */
  PROFILE_IN_USE: 7,
  /** The fleet's role may not invoke that Bedrock model yet: also a conflict with reality. */
  MODEL_NOT_GRANTED: 7,
  /**
   * The box could not be reached for a chat turn, answered without a session
   * token, answered with something that is not the protocol, or never freed a
   * warm backend slot (§9.2). All four are preconditions of the
   * environment — the laptop is off the tailnet, the instance is stopped, the
   * box is running a Hermes this build cannot speak to, or the gateway is
   * saturated — so they join the other 9s rather than looking like a bad
   * invocation. A script retrying on 9 is doing the right thing for each.
   */
  CHAT_UNREACHABLE: 9,
  CHAT_NO_TOKEN: 9,
  CHAT_PROTOCOL: 9,
  CHAT_NO_SLOT: 9,
  /**
   * The transport worked and the agent failed the turn. Nothing about the
   * environment is wrong and retrying the same prompt will usually fail the
   * same way, so this is a plain failure rather than a 9.
   */
  CHAT_TURN_FAILED: EXIT_FAILURE,
  /**
   * The fleet's foundation predates the browser grant (§7.3): a conflict with
   * reality, like the two above — nothing was created, and `hermetic foundation
   * update` is the fix.
   */
  BROWSER_NEEDS_FOUNDATION_UPDATE: 7,
  /** The CDN served something other than the pinned build: a precondition of the environment. */
  BROWSER_MIRROR_MISMATCH: 9,
  UNSUPPORTED: 10,
  /** The stack update itself failed or rolled back: a plain failure (§6.6 step 3). */
  FOUNDATION_UPDATE_FAILED: EXIT_FAILURE,
  /** The re-network's change set failed the same way, and is the same kind of failure (§5). */
  NETWORK_UPDATE_FAILED: EXIT_FAILURE,
  ABORTED: EXIT_ABORTED,
  INTERNAL: EXIT_FAILURE,
} as const;

export function exitCodeFor(code: ErrorCode): number {
  return EXIT_CODES[code] ?? EXIT_FAILURE;
}

/**
 * The human-readable version of the table above, for `hermetic --help`'s
 * footer and `hermetic help exit-codes`. Built from `EXIT_CODES` itself (plus
 * the four statuses that aren't `HermeticError` codes: 0, 1, 2, 130) so the two
 * can't drift.
 */
export function exitCodeTable(): string {
  const byCode = new Map<number, string[]>();
  byCode.set(EXIT_OK, ["ok"]);
  for (const [errorCode, exit] of Object.entries(EXIT_CODES)) {
    const names = byCode.get(exit) ?? [];
    names.push(errorCode);
    byCode.set(exit, names);
  }
  const failureNames = byCode.get(EXIT_FAILURE) ?? [];
  byCode.set(EXIT_FAILURE, [
    ...new Set(["INTERNAL / unmapped", ...failureNames.filter((n) => n !== "INTERNAL")]),
  ]);
  byCode.set(EXIT_ABORTED, [...new Set([...(byCode.get(EXIT_ABORTED) ?? []), "Ctrl-C"])]);

  const rows = [...byCode.entries()].sort(([a], [b]) => a - b);
  const width = Math.max(...rows.map(([code]) => String(code).length));
  return rows
    .map(([code, names]) => `  ${String(code).padStart(width)}  ${names.join(", ")}`)
    .join("\n");
}
