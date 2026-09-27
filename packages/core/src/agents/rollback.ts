/**
 * Undoing a failed `create` — the opt-in half of §4.5.
 *
 * `create` is resume-forward by default: a run that dies partway leaves a row
 * naming exactly what exists in AWS, and any operator can re-run `create` to
 * finish it or `destroy` to clean it up. That is the right default because data
 * volumes are precious (§1) and a half-made agent is still an agent. But an
 * operator who would rather have *nothing* than something to finish — a script,
 * or a first attempt at a name — asks for `--rollback-on-failure`, and this is
 * what that flag runs.
 *
 * Two rules make it safe to run against a real account:
 *
 * 1. **Only what this run made.** `CreateLedger` is written by `create` at the
 *    two moments it can know the difference: the `createVolume` call it made
 *    because `findVolumeByTag` returned nothing, and the `runInstance` call it
 *    made because `listInstancesByTag` came back empty. A volume or instance
 *    that was *found* is somebody else's work — a previous attempt, or another
 *    operator — and is never touched here.
 * 2. **A failed step does not stop the unwind.** Each step is separately
 *    caught: a step that fails says so, by name and by error *code* (never its
 *    message, §8.3), and the next step still runs. The row is deleted only when
 *    every earlier step succeeded; otherwise the row survives, because it is
 *    the only thing left that names what is still out there (§4.5).
 * 3. **Losing the lock does.** Rule 2's tolerance is for a step that could not
 *    finish, not for a run that is no longer entitled to try. Ownership is
 *    re-proved at every step boundary — the TTL lock can expire mid-unwind, and
 *    the unbounded detach wait is exactly where that happens — and the moment
 *    it cannot be, the unwind stops where it stands. It never deletes a config
 *    prefix, an SSM slot or a row that now belongs to somebody else's `create`
 *    or `destroy`.
 *
 * Its own module rather than more of `lifecycle.ts` (AGENTS.md rule 5), taking
 * an explicit deps object like `LifecycleDeps`/`TeardownDeps` do.
 */
import { waitVolumeReleased, type AttachDeps } from "./attach.ts";
import type { ArtifactsApi, ComputeApi, SecretsApi, StoreApi } from "../backend/types.ts";
import { isHermeticError } from "../errors.ts";
import type { Agent, OpEvent } from "../schema/index.ts";
import type { EvtFn } from "../events.ts";

/** The phase every event of an unwind carries; `create`'s rail appends it. */
const PHASE = "rollback";

/**
 * What *this* run of `create` brought into existence. Anything it merely found
 * is absent from here on purpose: this is the list of things it is allowed to
 * destroy.
 */
export interface CreateLedger {
  /** This run claimed the row with `putIfAbsent` — it did not pre-exist. */
  claimed: boolean;
  /** Volume this run created (`createVolume`), not one found by tag. */
  volumeId: string | null;
  /** Instance this run launched (`runInstance`), not one found by tag. */
  instanceId: string | null;
  /**
   * The `agent`/`role=data` tags `create --volume` overwrote when it adopted a
   * volume under a new name, and what they said before.
   *
   * Adoption *is* a change to something this run did not make: the volume goes
   * on holding an earlier agent's memory, but after the retag only the new name
   * can find it (`findVolumeByTag`). Without this, a failed
   * `create bravo --volume vol-X --rollback-on-failure` left `vol-X` tagged
   * `agent=bravo` with no bravo anywhere — so a later plain `create bravo`
   * would silently attach somebody else's memory, which is the one thing §1
   * forbids. Null when no rewrite happened (no `--volume`, or the tag already
   * named this agent).
   */
  retag: {
    volumeId: string;
    agent: string | null;
    roleData: boolean;
    /** The `Name` tag as it was, so a restore does not delete the operator's. */
    name: string | null;
  } | null;
}

/** What `rollbackCreate` needs, and nothing more. */
export interface RollbackDeps {
  compute: Pick<
    ComputeApi,
    | "describeInstance"
    | "terminate"
    | "describeVolume"
    | "deleteVolume"
    /** The two the adopted-volume tag restore needs, and only it. */
    | "listVolumes"
    | "retagVolume"
  >;
  secrets: Pick<SecretsApi, "deleteByPrefix">;
  artifacts: Pick<ArtifactsApi, "deleteByPrefix">;
  /**
   * `get` is not there to find work: it is the ownership check below, which
   * is the only thing standing between a stale run and another operator's
   * agent.
   */
  store: { agents: Pick<StoreApi["agents"], "delete" | "get"> };
  /**
   * Take the lock again, conditionally on the version just read — `create`
   * supplies `acquireLock(latest, owner)`. This is the *second* half of the
   * ownership gate and the half that actually holds: a read alone proves only
   * what was true a moment ago, and the deletes below are unconditional
   * (`store.agents.delete` is a plain `DeleteItem`). Throws `LOCKED` if another
   * owner holds it and `CONFLICT` if the row moved since the read; either means
   * the answer is no.
   */
  reclaim: (latest: Agent) => Promise<Agent>;
  /** The attach waiter's world, so the detach wait polls on the caller's clock. */
  attachDeps: () => AttachDeps;
  /**
   * Renew the create's TTL lock while the unwind waits. Rollback runs *before*
   * the lock is released, so no second operator can resume the row half-undone
   * (§4.4). A throw from it ends the unwind: see `keepLock` below.
   */
  heartbeat: () => Promise<void>;
  evt: EvtFn;
  nowIso: () => string;
  appendEvent: (name: string, action: string, detail?: string) => Promise<void>;
  agentPrefix: (name: string) => string;
  configPrefix: (name: string) => string;
}

/**
 * What the unwind managed. `complete` is the gate on deleting the row: false
 * means something out there outlived the rollback and the row still has to
 * name it.
 */
export interface RollbackOutcome {
  complete: boolean;
  /** Step names that did what they set out to do. */
  undone: string[];
  /** Step names that threw. */
  failed: string[];
  /**
   * The unwind stopped because this run could no longer prove the row was its
   * own — not because a step failed. It is reported separately because the two
   * ask different things of the operator: a failed step leaves resources this
   * run made and still owns, while this leaves a row somebody else is working
   * on, and `hermetic agent destroy` is the wrong answer to it.
   */
  ownership_lost: boolean;
}

/** A failed step is reported by code, never by message (§8.3). */
function codeOf(e: unknown): string {
  return isHermeticError(e) ? e.code : "INTERNAL";
}

/**
 * The lock renewal inside the detach wait failed, so this run can no longer
 * prove it holds the row.
 *
 * Internal to this module and never thrown out of it: it exists only so the
 * volume step can tell "EC2 refused the delete" (a step failure, rule 2) from
 * "the row is not ours any more" (terminal, rule 3). Both arrive at the same
 * `catch`, and by the time they do the difference is no longer visible in the
 * error itself — `CONFLICT` is what the store says about a lost version race
 * *and* what the waiter says about a volume held by a live instance.
 */
class LockLost extends Error {
  constructor(readonly errorCode: string) {
    super(`lock renewal failed (${errorCode})`);
    this.name = "LockLost";
  }
}

export interface RollbackOptions {
  /**
   * An abort that arrives *during* the unwind. `create` never starts a rollback
   * from an abort — an abort means stop, and the row is left resumable — so
   * this is only ever the operator stopping a rollback that is already running.
   *
   * It matters because the detach wait below is unbounded: an instance stuck in
   * `shutting-down` would otherwise loop forever, heartbeating a lock nobody
   * can take. Aborting makes that wait throw.
   *
   * An abort **ends the unwind** at the next step boundary; it does not merely
   * end the step it interrupted. Stop has to mean stop: answering it by going
   * on to delete the agent's SSM slots — its minted Tailscale key, a provider
   * key the operator pushed — would be the opposite of what was asked. The row
   * is kept, the outcome is incomplete, and what is left is named on it (§4.5).
   */
  signal?: AbortSignal;
}

/**
 * Unwind `create`, in reverse order, one step at a time, and say what happened.
 *
 * Never throws: the caller is already carrying an error worth more than
 * anything this can produce, and it is about to rethrow it. `progress` is the
 * furthest the create got, so the rail does not jump backwards.
 *
 * `owner` is the lock owner of the run that is unwinding, and it is checked
 * against the row before anything is touched — see below.
 */
export async function* rollbackCreate(
  deps: RollbackDeps,
  name: string,
  ledger: CreateLedger,
  owner: string,
  progress: number,
  opts: RollbackOptions = {},
): AsyncGenerator<OpEvent, RollbackOutcome> {
  const at = () => deps.nowIso();
  const undone: string[] = [];
  const failed: string[] = [];

  const say = (message: string, level?: OpEvent["level"]): OpEvent =>
    deps.evt(PHASE, progress, message, at(), level);

  const stepFailed = (step: string, e: unknown): OpEvent => {
    failed.push(step);
    return say(`rollback step ${step} failed (${codeOf(e)}); continuing with the rest`, "warn");
  };

  /**
   * Rule 3's two halves: the event that says where the unwind stopped and why,
   * and the outcome that carries the same fact back to the caller. `ownership`
   * joins `failed` so that `complete` is false and the row is kept by the same
   * arithmetic every other incomplete unwind uses.
   */
  const ownershipLost = (step: string, why: string): OpEvent => {
    failed.push("ownership");
    return say(
      `rollback stopped before the ${step} step: ${why}. Nothing further was rolled back; whatever this create made is named on the ${name} row, which is now somebody else's to finish or remove`,
      "warn",
    );
  };
  const lostOutcome = (): RollbackOutcome => ({
    complete: false,
    undone,
    failed,
    ownership_lost: true,
  });

  /**
   * The heartbeat the detach wait polls on, wrapped so that a renewal it could
   * not make ends the unwind instead of being swallowed as a failed step.
   *
   * Every throw counts, not only a lock conflict. A renewal is one conditional
   * write against the agent row: it fails when the version moved (somebody took
   * the row), when the row is gone, and when DynamoDB simply refused — and from
   * in here the third is indistinguishable from the first two. What is certain
   * either way is that the lock was not pushed out, so from the next poll on
   * this run cannot claim to hold it.
   */
  const keepLock = async (): Promise<void> => {
    try {
      await deps.heartbeat();
    } catch (e) {
      throw new LockLost(codeOf(e));
    }
  };

  if (!ledger.claimed && !ledger.volumeId && !ledger.instanceId && !ledger.retag) {
    // A create that failed before it made anything of its own — a resume that
    // died at the first step, say. There is nothing to undo, and saying so is
    // better than silence in an op stream the operator is watching. Checked
    // before the ownership gate below: there is nothing to reclaim the lock
    // for, and a reclaim here would take a lock write and bump a version for
    // no reason at all.
    yield say(`rollback: this run created nothing for ${name}; nothing to undo`);
    return { complete: true, undone, failed, ownership_lost: false };
  }

  /**
   * The gate on everything below, and the first thing done when there is
   * something to undo: is this row still this run's to destroy? `unwind` asks
   * the same question before releasing the lock; a rollback that did not ask
   * would be strictly more dangerous than the failure it is cleaning up after.
   * Two real cases it catches:
   *
   * - **The create finished.** Handoff commits the row with `lock: null` and
   *   *then* writes its history line. A throw on that write (a throttled events
   *   table) lands here with a full ledger — and without this check the unwind
   *   would terminate a healthy booting instance and delete its disk because a
   *   log line failed.
   * - **Somebody else took the row.** A run stalled past `LOCK_TTL_MS` loses
   *   the lock silently — `renewLock` returns rather than throwing — so the
   *   first sign is a `CONFLICT` on an update, by which time another operator
   *   (or `resume.ts`) is mid-create on the same name. Their secrets, their
   *   config and their row are not ours to delete.
   *
   * A *read* is not enough to decide that, and this is the subtle part. The
   * deletes below are unconditional, and nothing renews the lock between the
   * read and them when there is no volume to wait for — so a run that stalled
   * inside `RunInstances` (no heartbeat covers that call) can pass a read taken
   * milliseconds before its lock expires and then delete a row that changed
   * hands in the gap. So the gate *re-takes the lock*, conditionally on the
   * version it just read: after `reclaim` returns, this run demonstrably holds
   * the row with a full `LOCK_TTL_MS` ahead of it, and the deletes that follow
   * are milliseconds against that. `reclaim` throwing is an answer too.
   *
   * However it comes out: say which of the four it was, touch nothing, and
   * report the unwind as incomplete — whatever is out there, this run is no
   * longer the one that may remove it.
   *
   * And it is asked again before every destructive step below, not only here.
   * One answer at the top was enough while the unwind was short, but the detach
   * wait between the instance step and the rest is unbounded: a lock renewal
   * that fails inside it means the TTL lapsed and another operator's `create`
   * or `destroy` has the row *by the time the volume step returns*. Everything
   * after it — the tag restore, the config prefix, the SSM slots, the row —
   * would then be undoing their work rather than ours.
   */
  const confirmOwnership = async (): Promise<string | null> => {
    try {
      const latest = await deps.store.agents.get(name);
      if (latest === null) return `row for ${name} is gone`;
      const lock = latest.lock;
      if (!lock || lock.owner !== owner) {
        // An ARN and a uuid: an operator identity, not a secret (§8.3).
        if (lock) return `row for ${name} is now held by ${lock.owner}`;
        // Unlocked *and* fully provisioned: this create succeeded, and what
        // threw was something after the handoff.
        if (latest.resources.config_key !== undefined) {
          return `${name} finished provisioning before this failure`;
        }
        return `row for ${name} is no longer locked by this run`;
      }
      /**
       * A lock past its TTL is one any other operator may take at any instant,
       * and the read that found it says nothing about whether they already
       * have. The `reclaim` below would in fact still be safe — it is a
       * compare-and-swap on the version, so a row that changed hands fails it —
       * but re-taking a lock this run let lapse is not the same thing as never
       * having lost it, and the cost of refusing is one `destroy` the operator
       * runs deliberately.
       */
      const expires = Date.parse(lock.expires);
      if (!Number.isFinite(expires) || expires <= Date.parse(at())) {
        return `this run's lock on ${name} expired at ${lock.expires}`;
      }
      await deps.reclaim(latest);
      return null;
    } catch {
      // (d). A read or a reclaim that threw is not permission to delete.
      return `could not confirm ${name} is still this run's`;
    }
  };

  const denial = await confirmOwnership();
  if (denial !== null) {
    yield say(`${denial}; nothing rolled back`, "warn");
    return { complete: false, undone, failed: ["ownership"], ownership_lost: true };
  }

  /**
   * Stop means stop, at a step boundary. Checked here — before the first
   * destructive act — and again after the volume step, which is the one that
   * can block. The row is kept (`complete` is false), so it goes on naming
   * whatever this run left behind, which is exactly §4.5's default.
   */
  const interrupted = (): OpEvent =>
    say(
      `rollback interrupted; whatever is left is named on the ${name} row — run \`hermetic agent destroy ${name} --yes\``,
      "warn",
    );
  if (opts.signal?.aborted) {
    yield interrupted();
    return { complete: false, undone, failed: [...failed, "interrupted"], ownership_lost: false };
  }

  yield say(`rolling back what this create made for ${name}`, "warn");

  // ─── instance ────────────────────────────────────────────────────────────
  if (ledger.instanceId) {
    const instanceId = ledger.instanceId;
    try {
      const live = await deps.compute.describeInstance(instanceId);
      if (!live || live.state === "terminated" || live.state === "shutting-down") {
        // Nothing was undone here: the box was already on its way out.
        yield say(`instance ${instanceId} is already ${live?.state ?? "gone"}`);
      } else {
        await deps.compute.terminate(instanceId);
        yield say(`terminated instance ${instanceId} launched by this create`, "warn");
        undone.push("instance");
      }
    } catch (e) {
      yield stepFailed("instance", e);
    }
  }

  // ─── volume ──────────────────────────────────────────────────────────────
  if (ledger.volumeId) {
    const volumeId = ledger.volumeId;
    try {
      /**
       * The terminate above only *asked*: EC2 keeps the volume attached through
       * `shutting-down` and detaches it seconds later, so a `DeleteVolume` sent
       * now is refused with `VolumeInUse`. Wait for the detach — and carry the
       * operator's signal into the wait, because it is unbounded and an
       * instance that never leaves `shutting-down` would otherwise trap the
       * unwind (see `RollbackOptions.signal`).
       */
      const release = yield* waitVolumeReleased(deps.attachDeps(), volumeId, {
        ...(opts.signal ? { signal: opts.signal } : {}),
        heartbeat: keepLock,
        phase: PHASE,
        progress: { waiting: progress, done: progress },
      });
      if (release === "gone") {
        // Already deleted or deleting: nothing of ours left to remove.
        yield say(`data volume ${volumeId} is already gone`);
      } else {
        await deps.compute.deleteVolume(volumeId);
        yield say(`deleted data volume ${volumeId} created by this run`, "warn");
        undone.push("volume");
      }
    } catch (e) {
      /**
       * The one place ownership can be lost *inside* a step rather than between
       * two of them, because it is the only step that waits. A renewal that
       * threw is not a step that failed: the lock it was renewing is gone, and
       * with it the right to run the four steps below.
       */
      if (e instanceof LockLost) {
        yield ownershipLost(
          "volume tag restore",
          `${name}'s TTL lock could not be renewed while waiting for volume ${volumeId} to detach (${e.errorCode})`,
        );
        return lostOutcome();
      }
      yield stepFailed("volume", e);
    }
  }

  // ─── the adopted volume's tags ───────────────────────────────────────────
  /**
   * Not a delete — a *put back*. The volume itself is never this run's to
   * remove (it is somebody's memory from before this create existed), but the
   * `agent` tag pointing at this run's name is this run's doing, and leaving it
   * behind is how a later create under the same name silently inherits a disk
   * nobody meant to give it.
   *
   * Only what this run changed, and only while it is still what this run left:
   * a tag that now names a third party is somebody else's decision, taken after
   * ours, and putting our predecessor's name back over it would be the guess
   * §1 forbids.
   */
  if (ledger.retag) {
    const { volumeId, agent, roleData, name: nameTag } = ledger.retag;
    const lost = await confirmOwnership();
    if (lost !== null) {
      yield ownershipLost("volume tag restore", lost);
      return lostOutcome();
    }
    try {
      const now = (await deps.compute.listVolumes()).find((v) => v.volume_id === volumeId);
      if (!now) {
        yield say(`volume ${volumeId} is gone; there is no tag left to restore`);
      } else if (now.agent !== name) {
        yield say(
          `volume ${volumeId} is tagged agent=${now.agent ?? "(none)"} rather than ${name}; leaving it as it is`,
          "warn",
        );
      } else {
        await deps.compute.retagVolume(volumeId, agent, { roleData, name: nameTag });
        yield say(
          `restored volume ${volumeId} to agent=${agent ?? "(none)"}, the tag it carried before this create adopted it`,
          "warn",
        );
        undone.push("volume_tag");
      }
    } catch (e) {
      yield stepFailed("volume_tag", e);
    }
  }

  // The volume step is the only one that waits, so it is the only one an abort
  // can arrive in the middle of. Ending here leaves the SSM slots and the
  // config alone, which is what the operator asked for by pressing stop.
  if (opts.signal?.aborted) {
    yield interrupted();
    return { complete: false, undone, failed: [...failed, "interrupted"], ownership_lost: false };
  }

  /**
   * The config tarball and the SSM slots are unwound only for a fresh claim.
   * On a resume the slots may hold a provider key the operator pushed before
   * this run ever started, and the config may predate it — deleting either
   * would destroy work this create did not do.
   */
  if (ledger.claimed) {
    // ─── config ────────────────────────────────────────────────────────────
    /**
     * Re-proved here rather than trusted from the gate: everything above this
     * line — a terminate, a detach wait, a retag — is time in which the lock
     * could have lapsed, and this prefix is the one a *newer* owner's box is
     * about to fetch its config from.
     */
    const lostConfig = await confirmOwnership();
    if (lostConfig !== null) {
      yield ownershipLost("config delete", lostConfig);
      return lostOutcome();
    }
    try {
      const objects = await deps.artifacts.deleteByPrefix(deps.configPrefix(name));
      yield say(`removed ${objects.length} config object(s)`, "warn");
      undone.push("config");
    } catch (e) {
      yield stepFailed("config", e);
    }

    // ─── secrets ───────────────────────────────────────────────────────────
    /**
     * And again: the slots below hold a minted Tailscale key and whatever
     * provider key the operator pushed, and there is no getting them back.
     */
    const lostSecrets = await confirmOwnership();
    if (lostSecrets !== null) {
      yield ownershipLost("secrets delete", lostSecrets);
      return lostOutcome();
    }
    try {
      const params = await deps.secrets.deleteByPrefix(deps.agentPrefix(name));
      yield say(`removed ${params.length} SSM parameter(s)`, "warn");
      undone.push("secrets");
    } catch (e) {
      yield stepFailed("secrets", e);
    }
  }

  // ─── row ─────────────────────────────────────────────────────────────────
  const complete = failed.length === 0;
  if (!ledger.claimed) {
    yield say(`kept the existing ${name} row: this run resumed it rather than creating it`);
  } else if (!complete) {
    yield say(
      `rollback incomplete (${failed.join(", ")}); keeping the ${name} row, which names what is left — run \`hermetic agent destroy ${name} --yes\``,
      "warn",
    );
  } else {
    /**
     * The last and least reversible step, so the last confirmation. It is what
     * makes the delete below version-conditional in the only way `AgentStore`
     * allows: `delete(name)` is a plain `DeleteItem` with no condition of its
     * own, so the condition is `reclaim`'s — a compare-and-swap against the
     * version this check just read. A row that changed hands at any point since
     * the gate fails it, and the delete is never sent.
     */
    const lostRow = await confirmOwnership();
    if (lostRow !== null) {
      yield ownershipLost("row delete", lostRow);
      return lostOutcome();
    }
    try {
      await deps.store.agents.delete(name);
      // Recorded the moment the delete resolves. Anything after this is
      // bookkeeping, and a row that is gone must never be reported as one the
      // operator still has to `destroy`.
      undone.push("row");
    } catch (e) {
      yield stepFailed("row", e);
      return { complete: false, undone, failed, ownership_lost: false };
    }
    try {
      await deps.appendEvent(name, PHASE, "row deleted; nothing this create made remains");
    } catch {
      // History only. The caller's `unwind` appends a `failed` event next, and
      // the row this one would have described no longer exists.
    }
    yield say(`deleted the ${name} row; nothing this create made remains`, "warn");
  }

  return { complete, undone, failed, ownership_lost: false };
}
