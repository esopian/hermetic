/**
 * The box address an observation reads through, cached (§9.2).
 *
 * Every observation read used to go through `chat.ts`'s `address()` in full:
 * the §4.7 fleet guard (a CloudFormation `DescribeStacks` and a DynamoDB read
 * of the fleet item) and a consistent read of the agent row, before the box
 * was asked anything. A pinned conversation reconciles on a floor of seconds,
 * so three of them spent tens of thousands of `DescribeStacks` calls a day
 * re-proving a fact that had not moved. This module keeps the proof for a
 * while, for the observation's own reads only: a send, a lifecycle call or a
 * roster read still runs the guard every time.
 *
 * What is cached, and why that is safe:
 *
 * - **The guarded fleet**, shared by every instance, for `OBSERVE_GUARD_TTL_MS`
 *   (five minutes). It is the expensive half — the CloudFormation call — and
 *   the slowest to move: a stack or fleet item changing hands is not something
 *   that happens between two reads of a conversation.
 * - **Each instance's `BoxAddress`** (`instance`, `baseUrl`, `fleet_id`) for
 *   `OBSERVE_ADDRESS_TTL_MS` (one minute). Re-reading the row costs one
 *   DynamoDB item and runs the row's incarnation reconcile (§6.7) — which is
 *   the reason this one is short: a name destroyed and created again from
 *   another laptop can keep the same tailnet name, so the old address goes on
 *   answering, and only the row read notices the new incarnation.
 * - **The listen check is never cached.** It is local state and costs nothing,
 *   so it runs on every lookup, hit or miss, and an instance the operator stops
 *   listening to fails its next read with `VALIDATION` — which the observation
 *   treats as terminal — exactly as it did before the cache.
 * - **A cold, expired or dropped guard runs the full guard.** So
 *   `ACCOUNT_MISMATCH`/`FLEET_MISMATCH` still fire the first time, after every
 *   TTL, and after any failure.
 * - **Any failure drops the instance's address and the guard.** An abort does
 *   not: it is this laptop hanging up, not evidence about the box. A read that
 *   failed through a cached address with `CHAT_UNREACHABLE` — the box behind
 *   the name is gone — is retried once, at once, through a freshly guarded one
 *   (`read`), so a recreated or destroyed box is seen on that same read rather
 *   than after the next backoff. A timeout or a busy gateway is not retried:
 *   asking a second time at once would only double the wait or the load.
 * - **The fleet is part of the key.** A lookup under a different local fleet
 *   than the cached guard's clears everything; a fleet switch rebuilds the
 *   surface anyway, but the cache does not rely on that.
 *
 * Operator writes are not hooked, deliberately: the writes that move an
 * address are spread across a dozen modules and can come from another process
 * entirely (the CLI beside the app), so no in-process hook could be complete.
 * The short address TTL, and the failure of an address whose box has gone, are
 * what bound a stale entry instead. A stop or a start leaves the address as it
 * was, and a profile change never touches it.
 */
import type { FleetItem } from "../schema/index.ts";
import type { BoxAddress } from "./hermes/hermes-chat.ts";
import { HermeticError } from "../errors.ts";

/** How long a passed fleet guard is trusted. See the header. */
export const OBSERVE_GUARD_TTL_MS = 5 * 60_000;
/** How long an instance's box address (its row read) is trusted. See the header. */
export const OBSERVE_ADDRESS_TTL_MS = 60_000;

/** The one failure retried at once through a fresh address: the box did not answer. */
const STALE_ADDRESS = new Set(["CHAT_UNREACHABLE"]);

export interface ObserveAddressDeps {
  /** The §4.7 guard (`guardFleet`), uncached. Throws on a mismatch. */
  guard(): Promise<FleetItem>;
  /**
   * Where one instance's box is, under a fleet the guard just returned: the
   * agent row read and `agentDashboardUrl`, listen check included. Uncached.
   */
  locate(fleet: FleetItem, instance: string): Promise<BoxAddress>;
  /** The local listen check; throws `VALIDATION` when not listening. */
  requireListening(fleetId: string, instance: string): void;
  /** The home's selected fleet, read locally; `null`/absent when unknown. */
  fleet?: (() => string | null) | undefined;
  /** Monotonic milliseconds. Injected so a test decides when a TTL passed. */
  clock?: (() => number) | undefined;
  guardTtlMs?: number | undefined;
  addressTtlMs?: number | undefined;
}

export interface ObserveAddressCache {
  /** The instance's box, cached within the TTLs, after a live listen check. */
  get(instance: string): Promise<BoxAddress>;
  /**
   * Run `work` against the instance's box. A failure drops the address (unless
   * `signal` was aborted); a `CHAT_UNREACHABLE` through a cached address runs
   * `work` once more against a freshly guarded one.
   */
  read<T>(instance: string, work: (box: BoxAddress) => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** Forget one instance's address, and the guard with it. */
  forget(instance: string): void;
  clear(): void;
}

interface Cached<T> {
  value: T;
  at: number;
}

export function createObserveAddressCache(deps: ObserveAddressDeps): ObserveAddressCache {
  const clock = deps.clock ?? (() => performance.now());
  const guardTtlMs = deps.guardTtlMs ?? OBSERVE_GUARD_TTL_MS;
  const addressTtlMs = deps.addressTtlMs ?? OBSERVE_ADDRESS_TTL_MS;
  let guarded: Cached<FleetItem> | null = null;
  const boxes = new Map<string, Cached<BoxAddress>>();

  const fresh = <T>(entry: Cached<T> | null | undefined, ttl: number): entry is Cached<T> =>
    entry !== null && entry !== undefined && clock() - entry.at < ttl;

  function clear(): void {
    guarded = null;
    boxes.clear();
  }

  function forget(instance: string): void {
    boxes.delete(instance);
    guarded = null;
  }

  /** The guarded fleet, from the cache or a fresh guard. */
  async function fleet(): Promise<FleetItem> {
    if (fresh(guarded, guardTtlMs)) return guarded.value;
    const value = await deps.guard();
    guarded = { value, at: clock() };
    return value;
  }

  async function lookup(instance: string): Promise<{ box: BoxAddress; cached: boolean }> {
    const local = deps.fleet?.() ?? null;
    if (local !== null && guarded !== null && guarded.value.fleet_id !== local) clear();
    try {
      const f = await fleet();
      if (local !== null && f.fleet_id !== local) clear();
      const entry = boxes.get(instance);
      if (fresh(entry, addressTtlMs) && entry.value.fleet_id === f.fleet_id) {
        deps.requireListening(f.fleet_id, instance);
        return { box: entry.value, cached: true };
      }
      boxes.delete(instance);
      const box = await deps.locate(f, instance);
      boxes.set(instance, { value: box, at: clock() });
      return { box, cached: false };
    } catch (error) {
      forget(instance);
      throw error;
    }
  }

  const codeOf = (error: unknown): string | null =>
    error instanceof HermeticError ? error.code : null;

  async function read<T>(
    instance: string,
    work: (box: BoxAddress) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const first = await lookup(instance);
    try {
      return await work(first.box);
    } catch (error) {
      if (signal?.aborted === true) throw error;
      forget(instance);
      if (!first.cached || !STALE_ADDRESS.has(codeOf(error) ?? "")) throw error;
    }
    const retry = await lookup(instance);
    try {
      return await work(retry.box);
    } catch (error) {
      if (!signal?.aborted) forget(instance);
      throw error;
    }
  }

  return {
    get: async (instance) => (await lookup(instance)).box,
    read,
    forget,
    clear,
  };
}
