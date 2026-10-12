/**
 * `hermetic teardown --yes` (§9): unmake the foundation.
 *
 * Outside `hermetic.ts` for the reason `plans.ts` and `doctor.ts` are: it is
 * one long operation with a dependency list it can be handed, and it shares
 * almost nothing with the per-agent lifecycle it used to sit beside — no locks,
 * no status transitions, no rendering. What it does share is the *order* of
 * `plan.teardown`'s steps, which is the contract a head shows the operator
 * before this runs (§3.2 rule 3).
 */
import { randomUUID } from "node:crypto";
import {
  EIP_MONTHLY_COST,
  fleetHasNatAddress,
  FLEET_KEY,
  TeardownInput as TeardownInputSchema,
  stackNameFromId,
  tablesFor,
} from "../schema/index.ts";
import type {
  AddressOutcomes,
  FleetItem,
  OpEvent,
  ResourceOutcome,
  TeardownInput,
  TeardownReceipt,
} from "../schema/index.ts";
import { hasCode, HermeticError, isHermeticError, isMissingTable } from "../errors.ts";
import { createFleetLock, LOCK_TTL_MS, lockActivity, lockOwner } from "./fleet-lock.ts";
import { legacyParamPrefixes, readFleetScope } from "./legacy-params.ts";
import type { AddressRef } from "../backend/types.ts";
import {
  agentParamPrefix,
  DATA_SNAPSHOT_TAG,
  hermeticParamPrefix,
  MANAGED_TAG,
  MANAGED_TAG_VALUE,
  AGENT_PARAM_ROOT,
  FLEET_ID_TAG,
  HERMETIC_PARAM_ROOT,
  ROLE_DATA,
  ROLE_TAG,
} from "../backend/constants.ts";
import type { ConfigStore, OpOptions, TeardownStore } from "../hermetic.ts";
import { POLICY_RETAINED_NOTICE } from "./policy.ts";
import { evt } from "../events.ts";
import { checkAbort } from "../abort.ts";
import type { CoreContext } from "../context.ts";

/** How often teardown says "still deleting" while it waits for CloudFormation. */
const STACK_WAIT_PROGRESS_MS = 15_000;

/** What an operator types to run this again, for the messages that ask them to. */
const RERUN = "hermetic teardown --yes";

/** Await `p`, giving up after `ms` — and never leaving a timer holding the loop open. */
async function raceTimer(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      p,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** What `teardown` needs beyond the shared context: the two local stores and a test's shorter wait. */
export interface TeardownDeps {
  ctx: CoreContext;
  configStore?: ConfigStore | undefined;
  teardowns?: TeardownStore | undefined;
  stackWaitProgressMs?: number | undefined;
}

export function createTeardown(deps: TeardownDeps) {
  const { actor, appendEvent, backend, guardFleet, nowIso, requireConfig } = deps.ctx;
  const scanAgentsAllowingMissingTable = deps.ctx.scanAgents;
  /**
   * §4.4's one fleet-wide lock — the same lock `foundation.update` and §8.3's
   * profile writes take. Built here rather than per-run because it holds no
   * state of its own: the run below holds the owner string.
   */
  const fleetLock = createFleetLock({
    backend,
    lockTtlMs: LOCK_TTL_MS,
    now: () => backend.clock.now(),
    rerun: RERUN,
  });

  /**
   * §9, `hermetic teardown --yes`: unmake the foundation. The phases are exactly
   * the steps `plan.teardown` enumerates, in the same order and under the same
   * ids, so a head can show the plan and then watch it happen — and `reset_local`
   * runs last, so a failure anywhere before it leaves a home that still knows
   * which account it was pointed at.
   */
  async function* teardown(input: TeardownInput, opts: OpOptions = {}): AsyncIterable<OpEvent> {
    const parsed = TeardownInputSchema.parse(input);
    if (!parsed.yes) {
      throw new HermeticError(
        "CONFIRMATION_REQUIRED",
        "teardown deletes the whole foundation; pass --yes",
      );
    }
    /**
     * §4.7 step 3: the twelve digits, not `y`. The heads ask, but core is what
     * the ceremony has to be enforced in — `apply` on a teardown plan reached
     * this function with nothing but `yes: true` before, so the same value is
     * now checked here against the frozen config no matter which head sent it.
     * It stays optional so an interactive head that already compared it is not
     * forced to re-send; what is not optional is that a *present* value agree.
     */
    const frozen = requireConfig();
    if (parsed.confirm_account_id !== undefined && parsed.confirm_account_id !== frozen.account_id) {
      throw new HermeticError(
        "CONFIRMATION_REQUIRED",
        `the account id you typed does not match the account this home is frozen to (${frozen.account_id})`,
        { typed: parsed.confirm_account_id, frozen: frozen.account_id },
      );
    }
    const { fleet, stack: boundStack } = await guardFleet();
    // Every message below names the stack it is actually deleting, and the
    // tables that go with it: both are `hermetic-<fleet_id>`-shaped now, and a
    // foundation created before the rename still answers to its old name.
    const stackName = stackNameFromId(fleet.stack_id);
    const tables = tablesFor(stackName);
    /**
     * `--purge` deletes these two prefixes and never the account roots
     * (`/hermetic/`, `/hermes/`): another fleet in this account keeps its
     * parameters under the same roots, and a teardown that swept them would
     * take a live fleet's Tailscale client and provider keys with it (§8.2).
     */
    const hermeticPrefix = hermeticParamPrefix(fleet.fleet_id);
    const agentPrefix = agentParamPrefix(fleet.fleet_id);

    /**
     * The events table goes with the stack, so an append after the `stack` phase
     * can legitimately fail. It is recorded rather than thrown: the account is
     * mid-teardown and stopping would leave more behind than the missing row.
     */
    const unrecorded: string[] = [];
    const recordFleet = async (detail: string): Promise<void> => {
      try {
        await appendEvent(FLEET_KEY, "teardown", detail);
      } catch {
        unrecorded.push(detail);
      }
    };

    /**
     * §4.6: the receipt. An event stream is prose that scrolls past, so the
     * same facts are collected as data — what was removed, what was kept and
     * why — and written to the local `teardowns` table at the end, whether this
     * run succeeds or fails. `--reset-local` does not clear that table: the
     * moment the home forgets which account it was pointed at is exactly when
     * the record of what is still in that account matters most.
     */
    const startedAt = nowIso();
    const log: OpEvent[] = [];
    const resources: ResourceOutcome[] = [];
    /**
     * §4.6's Elastic IP block. Collected as data beside `resources` because an
     * allocation id is something the operator has to type back into the console
     * or the AWS CLI, and a list that exists only inside an English sentence is
     * a list they have to retype from.
     */
    const addresses: AddressOutcomes = { kept: [], released: [] };
    const say = (...args: Parameters<typeof evt>): OpEvent => {
      const event = evt(...args);
      log.push(event);
      return event;
    };
    const res = (
      phase: string,
      disposition: ResourceOutcome["disposition"],
      what: string,
      count: number | null = null,
      detail: string | null = null,
    ): void => {
      resources.push({ phase, disposition, what, count, detail });
    };
    const writeReceipt = async (error: unknown): Promise<void> => {
      if (!deps.teardowns) return;
      const failed = error !== null && error !== undefined;
      // A refusal is not a teardown. `AGENTS_EXIST` and the like throw before
      // anything has been touched, and a record of them would bury the records
      // that matter — the runs that did change the account.
      const touchedSomething = resources.some(
        (r) => r.disposition === "removed" || r.disposition === "failed",
      );
      if (failed && !touchedSomething) return;
      const receipt: TeardownReceipt = {
        id: randomUUID(),
        op_id: opts.opId ?? null,
        started_at: startedAt,
        finished_at: nowIso(),
        account_id: frozen.account_id,
        region: frozen.region,
        fleet_id: frozen.fleet_id,
        stack_name: stackName,
        options: {
          purge: parsed.purge,
          delete_snapshots: parsed.delete_snapshots,
          delete_volumes: parsed.delete_volumes,
          reset_local: parsed.reset_local,
        },
        outcome: failed ? "failed" : "ok",
        error: failed
          ? {
              code: isHermeticError(error) ? error.code : "INTERNAL",
              message: error instanceof Error ? error.message : String(error),
            }
          : null,
        resources,
        addresses,
        events: log,
      };
      // A receipt that cannot be written must not turn a finished teardown into
      // a failed one: the account is already changed either way.
      try {
        await deps.teardowns.record(receipt);
      } catch {
        /* the run log and the portal log still have the events */
      }
    };

    /**
     * §4.8: the directory entry is the account's record that this fleet existed.
     * Teardown moves it through `tearing_down` → `torn_down` rather than
     * deleting it — the item *is* the history, it costs nothing, and a fleet
     * that vanished from the index leaves the next operator with no way to know
     * a name was ever used. Best effort throughout: the foundation is being
     * deleted either way, and an unreachable index must not be what stops it.
     */
    const markDirectory = async (
      status: "tearing_down" | "torn_down",
    ): Promise<{ kind: "written" | "absent" | "failed"; detail: string | null }> => {
      try {
        const entry = await backend.directory.get(frozen.fleet_id);
        if (!entry) return { kind: "absent", detail: "there was none" };
        await backend.directory.update({
          ...entry,
          status,
          ...(status === "torn_down" ? { torn_down_at: nowIso() } : {}),
          updated_at: nowIso(),
          updated_by: frozen.frozen_by,
        });
        return { kind: "written", detail: null };
      } catch (e) {
        return { kind: "failed", detail: e instanceof Error ? e.message : String(e) };
      }
    };

    /**
     * §4.6: the one thing the stack owns that deleting it may not take.
     * CloudFormation deletes an `AWS::EC2::EIP` only once its association has
     * released, so a `nat` fleet can leave an allocation behind — `EIP_MONTHLY_COST`
     * a month for ever, and named by nothing hermetic used to print.
     *
     * Called twice over, from the two places a leftover can be seen: after a
     * clean delete, where `--purge` may release it, and from the failed-delete
     * path above, where an address that would not release is the *reason* for
     * the failure and nothing may be released at all.
     *
     * Deliberately *not* under the one-active-fleet guard the pre-v3 parameter
     * sweep runs behind. That guard exists because `/hermetic/` and `/hermes/`
     * predate fleet scoping, so a path under a root may belong to any fleet.
     * The template tags the EIP `hermetic:fleet_id=<this fleet>` and that is the
     * tag asked for here: another fleet's address, or an operator's own, cannot
     * be in the answer at all.
     */
    async function* sweepAddresses(sweepOpts: {
      release: boolean;
      stackFailed?: boolean;
    }): AsyncGenerator<OpEvent> {
      const stackFailed = sweepOpts.stackFailed === true;
      /**
       * §4.6: a `nat` fleet always gets a line, even when there is nothing to
       * report, because `plan.teardown` promised this step for it and a phase
       * that only sometimes speaks is a plan that only sometimes came true. A
       * `public` fleet was promised no step, so it speaks only in the case that
       * would otherwise go unseen: an allocation that is somehow there anyway.
       */
      const promised = fleetHasNatAddress(boundStack.parameters["Network"], fleet.network);
      let leftoverAddresses: AddressRef[];
      try {
        leftoverAddresses = await backend.compute.listAddresses({
          key: FLEET_ID_TAG,
          value: fleet.fleet_id,
        });
      } catch (e) {
        /**
         * Non-fatal, exactly like the tailscale phase. This runs after the
         * destructive point, and a denied `ec2:DescribeAddresses` — or any
         * transient failure — must not abort the teardown before the directory
         * is marked `torn_down`: every other laptop's `fleet ls` would go on
         * calling a deleted fleet `tearing_down` for ever, and nothing later
         * clears that.
         */
        const why = e instanceof Error ? e.message : String(e);
        const where = `${FLEET_ID_TAG}=${fleet.fleet_id}`;
        res(
          "addresses",
          "manual",
          "Elastic IP allocations tagged for this fleet",
          null,
          `could not be checked: ${why}; look for ${where} under Elastic IPs in the EC2 console`,
        );
        yield say(
          "addresses",
          0.47,
          `could not check whether an Elastic IP outlived the ${stackName} stack (${why}); one would cost ${EIP_MONTHLY_COST} a month — look for ${where} under Elastic IPs in the EC2 console`,
          nowIso(),
          "warn",
        );
        return;
      }
      if (leftoverAddresses.length === 0) {
        if (!promised) return;
        res(
          "addresses",
          "skipped",
          `Elastic IP allocations tagged ${FLEET_ID_TAG}=${fleet.fleet_id}`,
          0,
          `the ${stackName} stack took its NAT address with it`,
        );
        yield say(
          "addresses",
          0.47,
          `no Elastic IP outlived the ${stackName} stack; the fleet's NAT address went with it`,
          nowIso(),
        );
        return;
      }

      /** `eipalloc-… (203.0.113.7)`, the two identifiers a console needs. */
      const named = (a: { allocation_id: string; public_ip: string }): string =>
        `${a.allocation_id} (${a.public_ip})`;
      const stillAttached = leftoverAddresses.filter((a) => a.association_id !== null);
      const free = leftoverAddresses.filter((a) => a.association_id === null);
      const keep = (a: AddressRef): void => {
        addresses.kept.push({
          allocation_id: a.allocation_id,
          public_ip: a.public_ip,
          associated: a.association_id !== null,
        });
      };
      /** What could not be released whatever the flags said, and why. */
      const failedToRelease: string[] = [];

      if (sweepOpts.release) {
        for (const address of free) {
          try {
            await backend.compute.releaseAddress(address.allocation_id);
            addresses.released.push(address.allocation_id);
            await recordFleet(`addresses: released ${address.allocation_id}`);
          } catch (e) {
            // The stack is already gone; a release that failed is one more
            // thing left behind, not a reason to abandon the teardown.
            keep(address);
            failedToRelease.push(`${named(address)}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      } else {
        for (const address of free) keep(address);
      }
      // Never released, with `--purge` or without it: freeing an attached
      // address needs a `DisassociateAddress` against whatever is holding it,
      // and teardown does not know that that is safe.
      for (const address of stillAttached) keep(address);

      if (addresses.released.length > 0) {
        res(
          "addresses",
          "removed",
          "Elastic IP allocation(s) the stack left behind",
          addresses.released.length,
          addresses.released.join(", "),
        );
        yield say(
          "addresses",
          0.47,
          `released ${addresses.released.length} leftover Elastic IP allocation(s): ${addresses.released.join(", ")}`,
          nowIso(),
          "warn",
        );
      }
      if (failedToRelease.length > 0) {
        res(
          "addresses",
          "failed",
          "Elastic IP allocation(s) that could not be released",
          failedToRelease.length,
          failedToRelease.join("; "),
        );
      }
      /**
       * Unassociated and still there. With `--purge` on that can only be a
       * release that failed, which has its own `failed` line above — this one
       * is the deliberate case: the flag was off, or the stack delete failed
       * before anything could be released.
       */
      const keptFree = sweepOpts.release ? [] : addresses.kept.filter((a) => !a.associated);
      /** Why it is still there, which is a different sentence in each case. */
      const keptFreeReason = stackFailed
        ? `the ${stackName} delete failed, so nothing was released; re-run the teardown once the stack is gone`
        : "`--purge` would have released them";
      if (keptFree.length > 0) {
        res(
          "addresses",
          "retained",
          "Elastic IP allocation(s) the stack left behind",
          keptFree.length,
          `${keptFree.map(named).join(", ")} — about ${EIP_MONTHLY_COST} a month each; ${keptFreeReason}`,
        );
      }
      if (stillAttached.length > 0) {
        res(
          "addresses",
          "manual",
          "Elastic IP allocation(s) still associated with an instance",
          stillAttached.length,
          stillAttached
            .map(
              (a) =>
                `${named(a)} is still associated with ${a.instance_id ?? a.association_id}; release it from the console`,
            )
            .join("; "),
        );
      }
      if (addresses.kept.length > 0) {
        const detail = [
          ...(keptFree.length > 0 ? [`${keptFree.map(named).join(", ")} — ${keptFreeReason}`] : []),
          ...stillAttached.map(
            (a) =>
              `${named(a)} is still associated with ${a.instance_id ?? a.association_id}, so hermetic will not release it; disassociate and release it in the EC2 console`,
          ),
          ...(failedToRelease.length > 0 ? [`could not release ${failedToRelease.join("; ")}`] : []),
        ].join("; ");
        yield say(
          "addresses",
          0.47,
          `${addresses.kept.length} Elastic IP allocation(s) outlived the ${stackName} stack and cost about ${EIP_MONTHLY_COST} a month each: ${detail}`,
          nowIso(),
          "warn",
        );
      }
    }

    /**
     * §4.4's fleet-wide lock, while this teardown runs. The owner string once
     * it is ours, `null` before and after.
     *
     * Reading the lock was not enough (§6.6). `guardFleet` proves this is the
     * right account and the right fleet, and a read proves nobody was mid-write
     * when we looked — but between that look and `emptyBucket` another laptop's
     * `agents.create` can claim a name and push its config, and the bucket sweep
     * takes the config prefix with it. Holding the lock is what makes the agent
     * check mean something: an agent operation that starts after it is refused
     * at the door with `LOCKED` (`assertFleetUnlocked` in `hermetic.ts`), and a
     * `foundation.update` cannot take a lock this run is holding.
     */
    let lockedAs: string | null = null;
    /** When the lock last had its expiry pushed out, on the backend's clock. */
    let renewedAt = 0;
    /**
     * The row this run holds the lock on, as the lock writes leave it. Only
     * `renew` reads it, and only to stamp the new expiry onto a copy; the
     * decisions are all made against what the store says.
     */
    let held: FleetItem = fleet;

    const takeLock = async (): Promise<void> => {
      const owner = lockOwner(await actor(), randomUUID(), "teardown");
      let taken: boolean;
      try {
        taken = await fleetLock.acquire(owner);
      } catch (e) {
        /**
         * The documented retry (§4.2): a teardown that died after `DeleteStack`
         * is run again, and `_fleet` is a row in the `agents` table the stack
         * took with it. There is nothing to lock, and nothing anybody else
         * could take either — so this run goes on lockless, the way
         * `scanAgentsAllowingMissingTable` below goes on empty. Any other
         * failure is a store this teardown cannot trust and still stops it.
         */
        if (!isMissingTable(e)) throw e;
        return;
      }
      if (!taken) {
        const latest = await backend.store.fleet.get();
        /**
         * A lock write is conditional on the row existing, so a refusal with no
         * row behind it is a missing `_fleet` — not a busy one. Saying "another
         * operator holds it" about that sends an operator looking for a person
         * who does not exist, when what they need is `hermetic doctor`
         * (`withFleetLock` in `artifacts.ts` splits the same two cases).
         */
        if (latest === null) {
          throw new HermeticError(
            "NOT_FOUND",
            `this fleet has no ${FLEET_KEY} record, so teardown cannot take the lock it holds for its whole run; run \`hermetic doctor\``,
            { scope: "fleet" },
          );
        }
        const holder = latest.lock ?? null;
        throw new HermeticError(
          "LOCKED",
          holder === null
            ? `the ${FLEET_KEY} lock is held by another operator; run \`${RERUN}\` again when they are done`
            : `${lockActivity(holder.owner)} (${FLEET_KEY} locked by ${holder.owner} until ${holder.expires}); run \`${RERUN}\` again when it finishes`,
          { owner: holder?.owner ?? null, expires: holder?.expires ?? null, scope: "fleet" },
        );
      }
      lockedAs = owner;
      held = fleetLock.withLock(fleet, owner);
      renewedAt = backend.clock.now().getTime();
    };

    /**
     * The heartbeat (§4.4): push the expiry out once the lock is a third of its
     * life old, from inside the long phases as well as between them. A stack
     * delete takes minutes and a VPC whose ENIs are still detaching takes more,
     * so a teardown that only renewed between phases would unlock itself
     * mid-delete and let a create in behind it.
     */
    const keepLock = async (): Promise<void> => {
      const owner = lockedAs;
      if (owner === null) return;
      const at = backend.clock.now().getTime();
      if (at - renewedAt < LOCK_TTL_MS / 3) return;
      renewedAt = at;
      try {
        // `renew`, never `acquire`: acquiring takes a lock that has *expired*,
        // which is the one case a heartbeat must never paper over. A teardown
        // whose own lock ran out has already left the door open, and stealing
        // it back would hide that from a `create` that walked through it.
        held = await fleetLock.renew(held, owner);
      } catch (e) {
        /**
         * The row, and the table it lives in, went with the stack: there is no
         * lock left to hold and nobody left who could take one, so the run goes
         * on. Everything else stops it — a throttle or an unreachable store
         * leaves this run's lock live and the fleet still protected, and a lock
         * another operator now holds is the loss the heartbeat exists to catch
         * (§4.4). Neither may be read as the table being gone.
         */
        if (isMissingTable(e)) {
          lockedAs = null;
          return;
        }
        if (!hasCode(e, "LOCKED")) throw e;
        // Re-worded, not re-read: `renew` already asked who holds it, and the
        // sentence an operator needs here is about the bucket this run may have
        // emptied rather than about a release it never touched.
        const holder = isHermeticError(e) ? ((e.details?.["holder"] as string | null) ?? null) : null;
        throw new HermeticError(
          "LOCKED",
          `the ${FLEET_KEY} lock was lost while tearing the foundation down; ${holder ?? "another operator"} holds it now. The fleet bucket may already be empty — check what is left before running \`${RERUN}\` again.`,
          { owner, holder, scope: "fleet" },
        );
      }
    };

    /**
     * Give it back, on every path out. Best effort: a teardown that reached the
     * stack has deleted the table the lock lives in, so a release that finds
     * nothing is the ordinary ending, and a release that fails must not replace
     * the outcome the operator actually cares about. The TTL covers whatever
     * never lands (§4.4).
     */
    const releaseLock = async (): Promise<void> => {
      const owner = lockedAs;
      if (owner === null) return;
      lockedAs = null;
      try {
        await fleetLock.unlock(owner);
      } catch {
        // Swallowed on purpose; see above. Core never logs (rule 1).
      }
    };

    let failure: unknown = null;
    try {
      // ── agents_check ─────────────────────────────────────────────────────────
      /**
       * Before the check, because the check is only true for as long as this
       * holds: §4.4's fleet lock is what stops an `agents.create` on another
       * laptop from claiming a name and pushing a config prefix into a bucket
       * this run is about to empty.
       */
      await takeLock();
      const fleetRows = await scanAgentsAllowingMissingTable();
      /**
       * The pre-v3 leftovers `--purge` may also take, under exactly the rule
       * `plan.teardown` printed (`legacy-params.ts`, which both call): only
       * when the directory *proves* this is the account's one live fleet, and
       * then only the paths this fleet's own agent table and the two fixed
       * fleet-level layouts name — never a root, because `deleteByPrefix` is
       * recursive and `/hermes/` now holds every other fleet's scoped
       * parameters too. Built from the scan above rather than a second one.
       */
      const scope = await readFleetScope(backend, fleet.fleet_id);
      /**
       * §6.7: a destroy now deletes the row, so a destroyed agent's name
       * survives only in its tombstone. Read under the same missing-table rule
       * as the scan: a table already gone has no names to give, and says so in
       * the note below rather than failing the teardown.
       */
      const tombstoned =
        scope.sole && !fleetRows.table_gone
          ? await backend.store.events.queryTombstones().catch((e: unknown) => {
              if (isMissingTable(e)) return [];
              throw e;
            })
          : [];
      const legacy = scope.sole
        ? legacyParamPrefixes(
            // Every row, legacy destroyed ones included, plus every tombstone:
            // between them they are the only record that `/hermes/<name>/` was
            // this fleet's. `plans.ts` must enumerate from exactly the same list.
            [...fleetRows.agents.map((a) => a.name), ...tombstoned.map((t) => t.name)],
            scope,
          )
        : { prefixes: [] as string[], skipped: [] as string[] };
      /** What the receipt and the events call the set `--purge` is about. */
      const purgeScope = [hermeticPrefix, agentPrefix, ...legacy.prefixes].join(" and ");
      /** Why anything was left out, when it was. Printed, not guessed at. */
      const legacyNotes: string[] = [];
      if (!scope.sole) {
        legacyNotes.push(
          `pre-v3 parameters under ${HERMETIC_PARAM_ROOT} and ${AGENT_PARAM_ROOT} are left alone: ${scope.reason ?? "this is not the account's only fleet"}`,
        );
      } else if (fleetRows.table_gone) {
        legacyNotes.push(
          `the agents table is already gone, so no pre-v3 ${AGENT_PARAM_ROOT}<agent>/ paths could be enumerated`,
        );
      }
      for (const name of legacy.skipped) {
        legacyNotes.push(
          `left ${AGENT_PARAM_ROOT}${name}/ alone: "${name}" is also a fleet id in this account's directory, so those parameters may not be this fleet's`,
        );
      }
      const legacyNote = legacyNotes.length === 0 ? null : legacyNotes.join("; ");

      const living = fleetRows.agents.filter((a) => a.status !== "destroyed");
      if (living.length > 0) {
        throw new HermeticError(
          "AGENTS_EXIST",
          `${living.length} agent(s) still exist; destroy them before tearing down the foundation`,
          { agents: living.map((a) => a.name) },
        );
      }
      res(
        "agents_check",
        "skipped",
        "agents",
        0,
        fleetRows.table_gone ? "the agents table was already gone" : "none left to destroy",
      );
      yield say(
        "agents_check",
        0.05,
        fleetRows.table_gone
          ? `the ${tables.agents} table is already gone, so there are no agent rows to check; continuing with the rest of the teardown`
          : "no agent rows remain; the foundation may go",
        nowIso(),
      );

      // ── bucket ───────────────────────────────────────────────────────────────
      checkAbort(opts.signal, "bucket");
      await keepLock();
      /**
       * The bucket is versioned (§5), so `DeleteStack` fails on `BucketNotEmpty`
       * while any object version or delete marker remains — including the ones a
       * plain delete leaves behind. Emptying it is part of teardown, not a manual
       * step the operator discovers from a CloudFormation error.
       */
      /**
       * The heartbeat goes *into* the sweep, not only around it. A versioned
       * bucket with a release history in it is paged a thousand versions at a
       * time, and a fleet with enough of them to outlast the ten-minute TTL
       * would otherwise unlock itself mid-sweep and let a create in behind it —
       * the very interleaving this lock was taken to stop (§4.4).
       */
      const removed = await backend.artifacts.emptyBucket(keepLock);
      await recordFleet(`bucket: removed ${removed} object version(s)`);
      res("bucket", "removed", `object versions in s3://${fleet.bucket}`, removed, "not recoverable");
      yield say(
        "bucket",
        0.2,
        `emptied the fleet bucket (${removed} object version(s)); this is not recoverable`,
        nowIso(),
        "warn",
      );

      // ── stack ────────────────────────────────────────────────────────────────
      checkAbort(opts.signal, "stack");
      await keepLock();
      /**
       * §4.8, and *after* the abort check on purpose: this is what tells every
       * other laptop's `fleet ls` that the fleet is coming down, and an abort
       * between the stamp and `DeleteStack` would leave the account's register
       * saying a fleet is being torn down that is in fact still entirely there
       * — a lie nothing later clears, because the teardown that would have
       * finished it never ran.
       *
       * Best effort — the foundation is coming down either way — but not
       * silent: a stamp that did not land is why somebody else's `fleet ls`
       * will keep calling this fleet `active`, and that is worth one line.
       */
      const marked = await markDirectory("tearing_down");
      if (marked.kind === "failed") {
        yield say(
          "stack",
          0.4,
          `could not mark "${frozen.name}" tearing_down in the fleet directory (${marked.detail}); another laptop's \`fleet ls\` will still call it active until the teardown finishes`,
          nowIso(),
          "warn",
        );
      }
      // Recorded before the call: the table this row lands in is one of the things
      // `DeleteStack` takes with it.
      await recordFleet(`stack: DeleteStack ${stackName}`);
      yield say("stack", 0.45, `deleting the ${stackName} stack`, nowIso(), "warn", "start");
      /**
       * `deleteStack` now resolves only when the stack is *gone* (§5), which takes
       * minutes — a VPC whose ENIs are still detaching takes more. A head with
       * nothing to show for those minutes looks hung, so the wait emits a
       * heartbeat of its own under the same phase id.
       */
      {
        const deletion = backend.foundation.deleteStack({
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
        let settled = false;
        let failure: unknown = null;
        const done = deletion.then(
          () => {
            settled = true;
          },
          (e: unknown) => {
            settled = true;
            failure = e;
          },
        );
        const tick = deps.stackWaitProgressMs ?? STACK_WAIT_PROGRESS_MS;
        let waitedMs = 0;
        while (!settled) {
          await raceTimer(done, tick);
          if (settled) break;
          waitedMs += tick;
          await keepLock();
          yield say(
            "stack",
            0.45,
            `still waiting for the ${stackName} stack to finish deleting (${Math.round(waitedMs / 1000)}s)`,
            nowIso(),
            "warn",
          );
        }
        await done;
        if (failure !== null) {
          /**
           * §4.6, and the case that *makes* the leftover: an `AWS::EC2::EIP`
           * whose association will not release is why CloudFormation ends in
           * DELETE_FAILED, so the one run that most needs the address named is
           * the run that never reaches the sweep below. Report-only — nothing
           * is released on a failed delete, because the stack may still own it.
           */
          yield* sweepAddresses({ release: false, stackFailed: true });
          throw failure;
        }
        // No separate "deleted" event: the next phase's first word closes the
        // `start` above (heads treat a later phase as ending the open one).
      }
      // Everything the stack owns went with it. Named one by one rather than as
      // "the stack": "what is gone" is the question the receipt answers, and
      // "a CloudFormation stack" is not an answer to it.
      res("stack", "removed", `the ${stackName} CloudFormation stack`);
      res("stack", "removed", `the ${tables.agents} DynamoDB table`);
      res("stack", "removed", `the ${tables.events} DynamoDB table`);
      res("stack", "removed", `the s3://${fleet.bucket} bucket`);
      res("stack", "removed", "the hermetic VPC, its subnets, route tables and gateway endpoints");
      res("stack", "removed", "the sealed agent security group");
      res("stack", "removed", `the ${stackName}-agent IAM role and instance profile`);
      res("stack", "removed", `the daily snapshot policy and its ${stackName}-dlm role`);

      yield* sweepAddresses({ release: parsed.purge });

      // ── directory ────────────────────────────────────────────────────────────
      checkAbort(opts.signal, "directory");
      const entryOutcome = await markDirectory("torn_down");
      res(
        "directory",
        /**
         * `retained`, not `removed`: the entry is *kept* and marked
         * `torn_down`. It is the account's record that this fleet and this name
         * existed, and the receipt's job is to say what is still there — an
         * entry filed under "removed" would tell an operator the opposite of
         * what the directory will show them.
         */
        entryOutcome.kind === "written"
          ? "retained"
          : entryOutcome.kind === "absent"
            ? "skipped"
            : "failed",
        `the "${frozen.name}" entry in the account's fleet directory`,
        null,
        entryOutcome.kind === "written"
          ? "marked torn_down and kept; the entry is the account's record that this fleet existed"
          : entryOutcome.detail,
      );
      yield say(
        "directory",
        0.5,
        entryOutcome.kind === "written"
          ? `marked "${frozen.name}" torn_down in the account's fleet directory; the entry is kept as the record`
          : entryOutcome.kind === "absent"
            ? `no "${frozen.name}" entry in the account's fleet directory to mark`
            : `could not mark "${frozen.name}" torn_down in the fleet directory: ${entryOutcome.detail}`,
        nowIso(),
        entryOutcome.kind === "failed" ? "warn" : undefined,
      );

      // ── tailscale ────────────────────────────────────────────────────────────
      /**
       * The tailnet, which is not in the stack (§5) — and which teardown reads
       * nothing of and writes nothing to. The OAuth client and any devices are
       * the operator's to remove; hermetic's *policy* entries are hermetic's,
       * and they stay (§5.2). They may be what another fleet on this tailnet is
       * reached through, and a fleet coming down has no way to know that it is
       * the last one, so the one-directional rule is the safe direction: put
       * entries in on `init`, never take them out on the way down.
       *
       * That makes this phase a notice rather than a step. It costs no API call
       * at all, which is deliberate: the run that most needs to hear this is
       * the one whose OAuth client has no `policy_file` scope, or whose
       * `--purge` has already deleted the credential the call would have used,
       * and a notice that depended on the API would go quiet in exactly those
       * cases. Same words in the plan, in this event and on the receipt.
       */
      checkAbort(opts.signal, "tailscale");
      res(
        "tailscale",
        "retained",
        "the hermetic entries in the tailnet policy",
        null,
        POLICY_RETAINED_NOTICE,
      );
      yield say("tailscale", 0.52, POLICY_RETAINED_NOTICE, nowIso());

      // ── ssm ──────────────────────────────────────────────────────────────────
      if (parsed.purge) {
        checkAbort(opts.signal, "ssm");
        const params = [
          ...(await backend.secrets.deleteByPrefix(hermeticPrefix)),
          ...(await backend.secrets.deleteByPrefix(agentPrefix)),
        ];
        for (const prefix of legacy.prefixes) {
          params.push(...(await backend.secrets.deleteByPrefix(prefix)));
        }
        await recordFleet(`ssm: deleted ${params.length} parameter(s)`);
        res(
          "ssm",
          "removed",
          `SSM parameters under ${purgeScope}`,
          params.length,
          "tailscale auth keys, provider keys and bitwarden tokens",
        );
        yield say(
          "ssm",
          0.6,
          `deleted ${params.length} SSM parameter(s) under ${purgeScope}${legacyNote ? ` — ${legacyNote}` : ""}`,
          nowIso(),
          "warn",
        );
      } else {
        res(
          "ssm",
          "retained",
          `SSM parameters under ${purgeScope}`,
          null,
          `they are not in the stack and nothing else removes them; \`--purge\` would have${legacyNote ? ` (${legacyNote})` : ""}`,
        );
      }

      // ── snapshots ────────────────────────────────────────────────────────────
      if (parsed.delete_snapshots) {
        checkAbort(opts.signal, "snapshots");
        const snapshots = await backend.compute.listSnapshots(DATA_SNAPSHOT_TAG);
        const gib = snapshots.reduce((sum, s) => sum + s.size_gib, 0);
        for (const snapshot of snapshots) await backend.compute.deleteSnapshot(snapshot.snapshot_id);
        await recordFleet(`snapshots: deleted ${snapshots.length} snapshot(s), ${gib} GiB`);
        res(
          "snapshots",
          snapshots.length > 0 ? "removed" : "skipped",
          `EBS snapshots tagged ${ROLE_TAG}=${ROLE_DATA}`,
          snapshots.length,
          snapshots.length > 0
            ? `${gib} GiB; the last copy of what the agents learned`
            : "there were none",
        );
        yield say(
          "snapshots",
          0.75,
          `deleted ${snapshots.length} DLM snapshot(s) tagged ${ROLE_TAG}=${ROLE_DATA} (${gib} GiB)`,
          nowIso(),
          "warn",
        );
      } else {
        res(
          "snapshots",
          "retained",
          `EBS snapshots tagged ${ROLE_TAG}=${ROLE_DATA}`,
          null,
          "still costing; deleting the stack removed the policy that made them, not the snapshots. `--delete-snapshots` would have",
        );
      }

      // ── volumes ──────────────────────────────────────────────────────────────
      if (parsed.delete_volumes) {
        checkAbort(opts.signal, "volumes");
        const volumes = await backend.compute.listManagedVolumes();
        const gib = volumes.reduce((sum, v) => sum + v.size_gib, 0);
        for (const volume of volumes) await backend.compute.deleteVolume(volume.volume_id);
        await recordFleet(`volumes: deleted ${volumes.length} volume(s), ${gib} GiB`);
        res(
          "volumes",
          volumes.length > 0 ? "removed" : "skipped",
          `EBS volumes tagged ${MANAGED_TAG}=${MANAGED_TAG_VALUE}`,
          volumes.length,
          volumes.length > 0
            ? `${gib} GiB: ${volumes.map((v) => v.volume_id).join(", ")} — every agent's memory, episode log and skill library`
            : "there were none",
        );
        yield say(
          "volumes",
          0.9,
          `deleted ${volumes.length} leftover volume(s) tagged ${MANAGED_TAG}=${MANAGED_TAG_VALUE} (${gib} GiB); every agent's memory, episode log and skill library is gone`,
          nowIso(),
          "warn",
        );
      } else {
        res(
          "volumes",
          "retained",
          `EBS volumes tagged ${MANAGED_TAG}=${MANAGED_TAG_VALUE}`,
          null,
          "they hold what the agents learned, and `destroy` keeps them by default (§6.6); `--delete-volumes` would have removed them",
        );
      }

      // ── local ────────────────────────────────────────────────────────────────
      // Last, and only because everything above got here without throwing: a home
      // that has forgotten its account cannot be pointed back at the leftovers.
      if (parsed.reset_local) {
        checkAbort(opts.signal, "local");
        await recordFleet("local: archiving runs and clearing the frozen config row");
        await deps.configStore?.archiveRuns?.();
        // §4.8: this fleet's row and no other. A home may hold several, and the
        // ones this teardown did not touch are still perfectly good.
        await deps.configStore?.clear?.(frozen.fleet_id);
        res(
          "local",
          "removed",
          `the frozen local config row for ${frozen.fleet_id}`,
          null,
          "the run log was archived, not dropped; this receipt is kept too",
        );
        yield say(
          "local",
          0.95,
          `archived the local runs log and removed the frozen config row for "${frozen.name}"`,
          nowIso(),
          "warn",
        );
      }

      if (!parsed.reset_local) {
        res(
          "local",
          "retained",
          "the frozen local config row",
          null,
          "this home still points at the deleted fleet; `--reset-local` would have cleared it",
        );
      }

      // What no flag can remove: hermetic has no credential that reaches it.
      res(
        "tailscale",
        "manual",
        "the Tailscale OAuth client",
        null,
        "there is no API to delete it; use the admin console",
      );
      res("tailscale", "manual", "any devices still on the tailnet");
      if (unrecorded.length > 0) {
        res(
          "events",
          "failed",
          "fleet event-log rows for this teardown",
          unrecorded.length,
          "the events table was already gone; the phases still happened, and are in this receipt",
        );
      }

      const manual = [
        "the Tailscale OAuth client (there is no API to delete it; use the admin console)",
        // Only when there are any: an EIP left behind is the exception, not a
        // standing line every teardown has to print (§4.6).
        ...(addresses.kept.length > 0
          ? [
              `${addresses.kept.length} Elastic IP allocation(s) at about ${EIP_MONTHLY_COST} a month each (${addresses.kept.map((a) => a.allocation_id).join(", ")})`,
            ]
          : []),
        "any devices still on the tailnet",
        ...(parsed.purge ? [] : [`SSM parameters under ${purgeScope}`]),
        ...(parsed.delete_snapshots ? [] : [`EBS snapshots tagged ${ROLE_TAG}=${ROLE_DATA}`]),
        ...(parsed.delete_volumes ? [] : [`EBS volumes tagged ${MANAGED_TAG}=${MANAGED_TAG_VALUE}`]),
        ...(parsed.reset_local
          ? []
          : ["the local frozen config row, which still names the deleted fleet"]),
      ];
      yield say(
        "done",
        1,
        `foundation deleted; still yours to remove by hand: ${manual.join("; ")}${
          unrecorded.length > 0
            ? ` (${unrecorded.length} phase(s) went unrecorded: the events table was already gone)`
            : ""
        }`,
        nowIso(),
        "warn",
      );
    } catch (e) {
      failure = e;
    } finally {
      /**
       * `finally`, not "after the catch". A consumer that abandons this
       * generator — a browser tab closing, a `for await` that `break`s, an op
       * the portal cancels — resumes it with a `return` completion at the yield
       * it is suspended on, which runs no `catch` and nothing after the `try`.
       * The lock would then be held by a run that has stopped, and every agent
       * operation on the fleet refused for the whole ten-minute TTL.
       */
      await releaseLock();
    }
    await writeReceipt(failure);
    if (failure !== null) throw failure;
  }

  return { teardown };
}
