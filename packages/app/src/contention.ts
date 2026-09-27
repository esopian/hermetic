/**
 * Telling "somebody else holds this right now" apart from "this cannot be
 * done" (§4.4).
 *
 * The difference decides what happens to a pending row. A resumed op that met
 * a live lease has not failed — it was told to wait — and clearing its row on
 * that refusal threw the operator's work away for good, because a lease
 * expiring an hour later triggers nothing at all. A resumed op that met a
 * genuine refusal (the name belongs to a finished agent, the quota is gone) has
 * failed, and keeping its row would replay the same refusal at every boot.
 *
 * Both arrive as a `HermeticError`, and the code alone does not separate them:
 * `LOCKED` always means a live lease, but `NAME_TAKEN` means either "that
 * agent exists" or "that agent is being created right now by somebody whose
 * lease has not lapsed". What separates them is the lease itself, which core
 * puts in the error's details — the owner, and when it expires.
 */
import { isHermeticError } from "@hermetic/core";

/** The codes that can be contention. Anything else is a refusal. */
const CONTENTION_CODES = new Set(["LOCKED", "NAME_TAKEN"]);

/**
 * How long to wait when the refusal names a holder but not an expiry. Old
 * builds and any future caller that forgets the detail land here: long enough
 * not to spin against whoever holds it, short enough that the work is not
 * parked for the rest of the day.
 */
export const UNSTATED_LEASE_WAIT_MS = 60_000;

/**
 * The shortest wait a retry may be scheduled with. A lease whose stated expiry
 * has already passed by the time the refusal is read — clock skew, or a slow
 * round trip — must not become a retry that runs immediately and meets the same
 * lease again.
 */
export const MIN_RETRY_WAIT_MS = 1000;

/** A refusal that is worth waiting out, and when the wait ends. */
export interface Contention {
  /** Who was holding it, when the refusal said. */
  owner: string | null;
  /** The earliest moment the work may be tried again, as an ISO stamp. */
  retry_after: string;
}

function detail(details: Record<string, unknown> | undefined, key: string): string | null {
  const value = details?.[key];
  return typeof value === "string" ? value : null;
}

/**
 * Whether this throw is a live lease refusing an attempt, and when that lease
 * runs out. `null` for anything else — including a `NAME_TAKEN` that names no
 * holder, which is an agent that exists rather than one being built.
 */
export function classifyContention(e: unknown, now: number): Contention | null {
  if (!isHermeticError(e) || !CONTENTION_CODES.has(e.code)) return null;
  const owner = detail(e.details, "owner");
  const expiresAt = Date.parse(detail(e.details, "expires") ?? "");
  if (Number.isNaN(expiresAt)) {
    // No stated expiry: a named holder is still contention, an unnamed one is
    // not — a refusal that can point at nobody is not evidence of a lease.
    if (owner === null) return null;
    return { owner, retry_after: new Date(now + UNSTATED_LEASE_WAIT_MS).toISOString() };
  }
  return {
    owner,
    retry_after: new Date(Math.max(expiresAt, now + MIN_RETRY_WAIT_MS)).toISOString(),
  };
}
