/**
 * The redaction door, as the chat surface's methods use it (§9.2): input
 * validation that never echoes a value, the structural masks for a roster and
 * a session list, the shape of a box that did not answer, and `sealed`, which
 * masks a thrown error on its way out. Every read in `chat.ts` goes through
 * these; nothing below the surface does its own.
 */
import type { Session, Swarm } from "../schema/index.ts";
import { redactDeep, redactText } from "./chat-redact.ts";
import { CHAT_ERROR_CODES, WARM_SLOTS_PER_GATEWAY } from "./hermes/hermes-chat.ts";
import { HermeticError } from "../errors.ts";

/** The same shape `notifications.ts` validates with: a `VALIDATION` refusal, never a raw zod throw. */
export function parse<T>(
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: unknown } },
  input: unknown,
  what: string,
): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issues = (result.error as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
  throw new HermeticError("VALIDATION", `${what} input does not validate`, {
    issues: (issues ?? []).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
  });
}

/**
 * Every string a bot can influence, masked on the way out (§9.2).
 *
 * `redactDeep` rather than a field-by-field pass, and that is the whole point:
 * a roster and a session list look like metadata and are not. Hermes titles a
 * session from the first thing said in it, so a key pasted into a composer is a
 * *session title* before it is anything else — and a hand-written list of the
 * fields worth masking would be one field behind the next schema change.
 * `redactBlock`'s exhaustive switch covers the transcript; the structural walk
 * covers everything around it.
 *
 * The cast is safe in the way that matters: `redactDeep` rebuilds objects and
 * arrays key for key and only ever replaces a string with another string, so
 * the shape it returns is the shape it was given.
 */
export function redactSessions(sessions: readonly Session[]): Session[] {
  return redactDeep(sessions) as Session[];
}

export function redactSwarm(swarm: Swarm): Swarm {
  return redactDeep(swarm) as Swarm;
}

/**
 * What a box that did not answer looks like in the roster.
 *
 * A fleet-wide read is a fan-out over boxes that fail independently — one off
 * the tailnet, one stopped, one running an older Hermes — and a read that threw
 * on the first of them would hide the twelve that answered. So an unreachable
 * instance is a `Swarm` with `reachable: false` and a reason, which is exactly
 * what the schema has those two fields for, and the head renders a bucket that
 * says why rather than a fleet that looks empty.
 */
export function unreachableSwarm(instance: string, reason: string): Swarm {
  return {
    instance,
    reachable: false,
    unreachable_reason: redactText(reason),
    bots: [],
    rooms: [],
    // The box has its three warm backend slots whether or not this laptop can
    // reach it, and the adapter reports them for a box that answered. Reporting
    // `0` here would make the rail's readout depend on which layer produced the
    // row — "0/0" for a silent box and "0/3" for a busy one.
    warm_slots: { used: 0, total: WARM_SLOTS_PER_GATEWAY },
    sections: [],
  };
}

/**
 * What went wrong, in the vocabulary a head can branch on.
 *
 * `ChatFrame`'s error code is `z.string()` and not `ErrorCode` on purpose, and
 * this is where that shows: a turn fails for reasons core has no code for — the
 * box is off the tailnet, the gateway has no warm slot, the model refused — and
 * inventing an `ErrorCode` for each would put transport failures of one
 * subsystem into the enum every other subsystem exits on. So a `HermeticError`
 * passes its own code through unchanged, and anything else is the adapter's own
 * `CHAT_UNREACHABLE`: hermetic asked the box and the box did not answer. The
 * constant comes from the adapter rather than being spelled again here, so a
 * head branching on chat failures reads one vocabulary and not two.
 */
export function reasonOf(error: unknown): { code: string; message: string } {
  if (error instanceof HermeticError) return { code: error.code, message: error.message };
  const message = error instanceof Error ? error.message : String(error);
  return { code: CHAT_ERROR_CODES.UNREACHABLE, message };
}

/**
 * The same door, for a failure.
 *
 * A thrown error is as much "something leaving this module" as a message is:
 * `packages/app/src/app.ts` writes `HermeticError.message` to
 * `~/.hermetic/portal.log` and returns it in the JSON error body, and the CLI
 * prints it. So a message composed anywhere below — by the adapter, by a
 * `fetch` that put the URL in its own text, by a box answering with its own
 * diagnostics — is masked here rather than trusted to have been born clean.
 * `details` goes through the structural walk for the same reason `args` and
 * `result` do: nothing models what is in there.
 *
 * The error is rebuilt rather than mutated, and the stack is masked too: its
 * first line is the message, so redacting one and not the other would put the
 * secret back.
 */
export function redactError(error: unknown): unknown {
  if (error instanceof HermeticError) {
    const details =
      error.details === undefined ? undefined : (redactDeep(error.details) as Record<string, unknown>);
    const copy = new HermeticError(error.code, redactText(error.message), details);
    if (error.stack !== undefined) copy.stack = redactText(error.stack);
    return copy;
  }
  if (error instanceof Error) {
    const copy = new Error(redactText(error.message));
    if (error.stack !== undefined) copy.stack = redactText(error.stack);
    return copy;
  }
  return error;
}

/** Runs a method with that door closed behind it. */
export async function sealed<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw redactError(error);
  }
}
