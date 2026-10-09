/**
 * The in-flight turn fence.
 *
 * The problem it exists for is a clock problem. `chat.message` is raised by the
 * roster read, which compares the **box's** coordinate for a bot — the profile
 * row's `last_session`, or the newest session's `last_message_at` — against a
 * watermark this laptop persisted. A turn this laptop drove moves that
 * coordinate, so the turn has to advance the watermark too, or the operator is
 * told about the reply they just watched arrive.
 *
 * What the turn must *not* do is advance it with the laptop's own clock. The
 * two clocks are different clocks: a box running a few seconds ahead leaves a
 * laptop-stamped watermark below the reply it was meant to cover and the row is
 * raised anyway, and a box running behind leaves it above messages that have
 * not happened yet, which swallows a real message from somebody else. Taking
 * the max of the two is worse still — it is the swallowing failure, made
 * permanent. So the rule is absolute: **never compare or max() a laptop
 * timestamp against a box timestamp.** The watermark is always in the box's
 * coordinate system, and the only thing the laptop's clock is used for here is
 * measuring a lease against itself.
 *
 * That leaves a window. A turn takes seconds to minutes, and while it runs the
 * box's coordinate has already moved but the turn has not yet had a chance to
 * record where to. A roster read landing inside that window would raise a row
 * about a reply in progress. The fence closes it: the turn claims the bot for
 * the duration, and a roster read that finds a live claim **defers** — it
 * raises nothing and, crucially, leaves the stored watermark exactly where it
 * was, so the very next unfenced read classifies whatever happened rather than
 * having lost the chance to.
 *
 * It is persisted rather than held in a closure because the two heads are two
 * processes. An operator taking a turn from `hermetic chat` while the portal
 * polls the same fleet is the ordinary case, not the exotic one, and an
 * in-memory fence would fence only the process that is not reading.
 *
 * Leases, not locks. A CLI killed mid-turn must not fence a bot until somebody
 * finds the row and deletes it, so the claim carries an expiry and a crashed
 * holder is simply late by at most one TTL.
 */

import { randomUUID } from "node:crypto";

/** One claim, as it is stored. `expires_at` is laptop-clock ISO — see below. */
export interface ChatFenceRow {
  /** Who holds it, so one process's release cannot drop another's claim. */
  owner: string;
  /**
   * When the claim lapses, on the **laptop's** clock.
   *
   * This is the one timestamp here that is not the box's, and it is safe
   * because it is only ever compared against another reading of the same
   * laptop's clock. Two laptops sharing a home directory is not a thing that
   * happens; two processes on one laptop is, and they agree.
   */
  expires_at: string;
}

export interface ChatFenceStore {
  read(fleet: string | null, instance: string, bot: string): ChatFenceRow | null;
  write(fleet: string | null, instance: string, bot: string, row: ChatFenceRow): void;
  /**
   * Pushes `expires_at` out, but **only if `owner` still holds the row**, and
   * answers whether it did.
   *
   * Unconditional renewal was a bug with teeth: a superseded holder's timer
   * would take the row back by rewriting `owner` to itself, and its own release
   * would then delete a claim belonging to a turn that was still streaming —
   * un-fencing a live turn. A renewal is a claim to *still* hold something, not
   * a claim to take it.
   */
  renew(fleet: string | null, instance: string, bot: string, owner: string, expiresAt: string): boolean;
  /** Drops the claim only if `owner` still holds it. */
  clear(fleet: string | null, instance: string, bot: string, owner: string): void;
  /**
   * Drops every claim on `instance`'s bots, whoever holds it. Not `clear`: a
   * released name has no live turn left to be owed a fence, and a claim the
   * next agent of that name inherited would defer its first roster reads for up
   * to a TTL (§6.7).
   */
  forgetInstance(fleet: string | null, instance: string): void;
}

/**
 * How long a claim outlives the process that took it.
 *
 * 90 seconds, renewed every 30. The two numbers answer different questions and
 * neither is arbitrary:
 *
 * - **The TTL is the worst case after a crash.** A `hermetic chat` killed with
 *   `^C` at the wrong moment defers that bot's rows for at most 90 seconds, and
 *   deferring is not losing — the next read after the lapse still compares the
 *   untouched watermark and still raises whatever moved. 90s is chosen to be
 *   comfortably longer than the interval between two roster polls, so a fence
 *   that should be held is never briefly absent between renewals.
 * - **The renewal cadence must be far below the TTL**, or a scheduler hiccup
 *   drops a fence that is still legitimately held. 30s gives two missed
 *   renewals of headroom before a live turn is exposed.
 *
 * Renewal is on a timer and not on frame arrival, deliberately. Frames are not
 * a heartbeat: a model that thinks for two minutes before writing its first
 * word produces no frames at all in exactly the stretch the fence matters most.
 */
export const CHAT_FENCE_TTL_MS = 90_000;
export const CHAT_FENCE_RENEW_MS = 30_000;

/** The claim, from the holder's side. Every call is idempotent. */
export interface ChatFenceLease {
  owner: string;
  /**
   * `false` once this lease no longer holds the row — superseded by another
   * turn, or already released. The caller stops renewing when it hears that:
   * a lease that keeps retrying would be trying to take a claim back.
   */
  renew(): boolean;
  release(): void;
}

function keyOf(fleet: string | null, instance: string, bot: string): string {
  // Unambiguous rather than a separator a bot name could contain.
  return JSON.stringify([fleet, instance, bot]);
}

/**
 * The fence a `Hermetic` built without a local database gets: this process
 * only. Same bargain as `MemoryNotificationStore` — the single-process case is
 * still correct, and what is lost is the cross-process half.
 */
export class MemoryChatFenceStore implements ChatFenceStore {
  private readonly rows = new Map<string, ChatFenceRow>();

  read(fleet: string | null, instance: string, bot: string): ChatFenceRow | null {
    return this.rows.get(keyOf(fleet, instance, bot)) ?? null;
  }

  write(fleet: string | null, instance: string, bot: string, row: ChatFenceRow): void {
    this.rows.set(keyOf(fleet, instance, bot), { ...row });
  }

  renew(
    fleet: string | null,
    instance: string,
    bot: string,
    owner: string,
    expiresAt: string,
  ): boolean {
    const key = keyOf(fleet, instance, bot);
    const row = this.rows.get(key);
    if (row?.owner !== owner) return false;
    this.rows.set(key, { owner, expires_at: expiresAt });
    return true;
  }

  clear(fleet: string | null, instance: string, bot: string, owner: string): void {
    const key = keyOf(fleet, instance, bot);
    if (this.rows.get(key)?.owner === owner) this.rows.delete(key);
  }

  forgetInstance(fleet: string | null, instance: string): void {
    for (const key of [...this.rows.keys()]) {
      const [f, i] = JSON.parse(key) as [string | null, string, string];
      if (f === fleet && i === instance) this.rows.delete(key);
    }
  }
}

/** A claim that has not lapsed. An expired row is not a fence. */
export function chatFenced(
  store: ChatFenceStore,
  fleet: string | null,
  where: { instance: string; bot: string },
  nowMs: number,
): boolean {
  try {
    const row = store.read(fleet, where.instance, where.bot);
    if (row === null) return false;
    const until = Date.parse(row.expires_at);
    // A row this build cannot read the expiry of is treated as lapsed: failing
    // toward "not fenced" costs at worst one row about the operator's own
    // reply, and failing the other way would hide somebody else's message.
    if (Number.isNaN(until)) return false;
    return until > nowMs;
  } catch {
    // The fence is a courtesy on top of the inbox, which is itself a courtesy.
    // An unreadable one never fails a roster read.
    return false;
  }
}

/**
 * Claim a bot for the turn about to run.
 *
 * Last writer wins, and that is the right way round for a claim whose only
 * effect is to defer. Two processes taking a turn against one bot at once is
 * already a conversation with two authors; the second claim simply carries the
 * fence, and the first holder's release is a no-op because the owner moved.
 *
 * Never throws. A fence that could not be taken costs a notification about the
 * operator's own reply, which is the failure this whole mechanism is allowed to
 * have — it must never cost the turn.
 */
export function acquireChatFence(
  store: ChatFenceStore,
  fleet: string | null,
  where: { instance: string; bot: string },
  opts: { now?: () => number; owner?: string } = {},
): ChatFenceLease {
  const now = opts.now ?? (() => Date.now());
  const owner = opts.owner ?? randomUUID();
  let held = true;

  function expiry(): string {
    return new Date(now() + CHAT_FENCE_TTL_MS).toISOString();
  }

  try {
    store.write(fleet, where.instance, where.bot, { owner, expires_at: expiry() });
  } catch {
    // See above: recording is never what fails a turn.
  }
  return {
    owner,
    renew: () => {
      if (!held) return false;
      try {
        held = store.renew(fleet, where.instance, where.bot, owner, expiry());
      } catch {
        // An unreadable store is not evidence the claim was lost; the lease
        // lapses on its own if the writes really have stopped landing.
        return true;
      }
      return held;
    },
    release: () => {
      if (!held) return;
      held = false;
      try {
        store.clear(fleet, where.instance, where.bot, owner);
      } catch {
        // A claim that could not be dropped lapses on its own within the TTL.
      }
    },
  };
}
