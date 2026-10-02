/**
 * `agents.create` (§6.2): the one lifecycle op that writes a fresh row with its
 * lock already on it, and the crash-safe find-or-make sequence that follows.
 * Split out of `lifecycle.ts` for size; the design comments travelled with the
 * code. `createLifecycle` still owns `LifecycleDeps` and assembles the surface.
 */
import { randomUUID } from "node:crypto";
import {
  CreateAgentInput as CreateAgentInputSchema,
  DEFAULT_ROOT_GIB,
  PROVIDERS,
  SIZES,
  cloudName,
  providerNeedsKey,
} from "../../schema/index.ts";
import type { Agent, CreateAgentInput, OpEvent } from "../../schema/index.ts";
import { HermeticError, hasCode } from "../../errors.ts";
import { validateName } from "../../shared/naming.ts";
import type { VolumeRef } from "../../backend/types.ts";
import { adoptionOwner } from "../../volumes/volume-claims.ts";
import { attachAgentVolume } from "../attach.ts";
import { commitHandoff, watchHandoff } from "../handoff.ts";
import { abandoned, checkAbort } from "../../abort.ts";
import { evt } from "../../events.ts";
import { LOCK_TTL_MS } from "../../fleet/fleet-lock.ts";
import { rollbackCreate, type CreateLedger, type RollbackDeps } from "../rollback.ts";
import { releaseDrift } from "../../release/artifacts.ts";
import { assertBrowserSupported } from "../../release/browser-mirror.ts";
import { providerKeySource, resolveCreateDefaults } from "../../render/create-defaults.ts";
import {
  assertModelGranted,
  assertNoInlineKey,
  assertProfileUsable,
  bindingOf,
  selectCreateProfile,
  snapshotCredential,
  type BindingPorts,
  type ProfileBinding,
} from "../../profiles/profile-binding.ts";
import { settingsOf } from "../../profiles/settings.ts";
import { sharedSecretPath } from "../../backend/constants.ts";
import type { OpOptions } from "../../hermetic.ts";
import type { LifecycleDeps } from "../lifecycle.ts";
import { createVolumeAdoption } from "./adopt-volume.ts";
import { createReleaseName, strictlyAfter, type ReleaseResult } from "./release-name.ts";
import { createRecordedInstance } from "./recorded-instance.ts";
import type { ReleaseLookup } from "./release.ts";

export function createCreateOp(deps: LifecycleDeps, release: ReleaseLookup) {
  const { volumeClaims, bwsPath, agentSlotPath, sharedSlotPath, providerKeyPath, tsKeyPath } = deps;
  const {
    hermesVersion,
    hermeticdVersion,
    acquireLock,
    actor,
    agentPrefix,
    appendEvent,
    assertFleetUnlocked,
    assertSealed,
    attachDeps,
    backend,
    configPrefix,
    ensureConfig,
    getAgent,
    handoffDeps,
    guardFleet,
    isHandedOff,
    localBuild,
    lockHeldByOther,
    lockKeeper,
    nowIso,
    renewLock,
    unwind,
  } = deps.ctx;
  const { currentRelease, userDataFor } = release;
  const { resolveAdopted, reconfirmAdopted } = createVolumeAdoption({ backend, volumeClaims });
  const { recordedInstance } = createRecordedInstance(deps.ctx);
  const { releaseName, predecessorFloor } = createReleaseName({
    ctx: deps.ctx,
    purgeLocal: deps.purgeLocal,
  });

  /**
   * §6.7: a `destroyed` row is a legacy one — destroys before tombstones kept
   * the row, and with it the name, forever. A create of that name releases it
   * exactly as today's destroy ends (tombstone written, row deleted, a kept
   * volume retagged `former_agent`) and then claims the name afresh. It takes
   * the row's lock like any other write, so a second operator releasing or
   * creating the same name at the same moment is refused, not raced.
   *
   * `null` means the row was already gone when the lock was taken: another
   * operator's release (a destroy, or a create over the same legacy row) got
   * there first, so the name is free and the caller goes on to claim it.
   */
  async function releaseLegacyRow(
    existing: Agent,
    owner: string,
    who: string,
    signal: AbortSignal | undefined,
  ): Promise<ReleaseResult | null> {
    if (lockHeldByOther(existing, owner)) {
      throw new HermeticError(
        "NAME_TAKEN",
        `agent ${existing.name} is being released right now by ${existing.lock?.owner ?? "another operator"}`,
        {
          name: existing.name,
          owner: existing.lock?.owner ?? null,
          expires: existing.lock?.expires ?? null,
        },
      );
    }
    let locked: Agent;
    try {
      locked = await acquireLock(existing, owner);
    } catch (e) {
      /**
       * The row went between the read and the lock: somebody else released
       * it, and nothing holds the name any more. Not contention — the fresh
       * claim that follows is what decides who gets the name, and it loses
       * safely to whoever might already have claimed it.
       */
      if (hasCode(e, "NOT_FOUND")) return null;
      /**
       * The row moved between the read and the lock: another operator is
       * releasing or re-creating this name right now. That is contention for
       * the name, which is what `NAME_TAKEN` with the lock details says — a
       * bare CONFLICT would read as a fault.
       */
      if (!hasCode(e, "CONFLICT")) throw e;
      const latest = await backend.store.agents.get(existing.name).catch(() => null);
      throw new HermeticError(
        "NAME_TAKEN",
        `agent ${existing.name} changed while this create was releasing it; another operator is working on the name`,
        {
          name: existing.name,
          owner: latest?.lock?.owner ?? null,
          expires: latest?.lock?.expires ?? null,
        },
      );
    }
    try {
      return await releaseName(locked, {
        volumeKept: (locked.resources.volume_id ?? locked.volume_id ?? null) !== null,
        actor: who,
        signal,
      });
    } catch (e) {
      await unwind(existing.name, "create", owner, e);
      throw e;
    }
  }

  /**
   * The four SSM calls and two path rules `profile-binding.ts` needs, gathered
   * once. It is deliberately *not* the backend: the module it feeds resolves
   * credentials, and handing it anything more than the slots it reads and
   * writes would make that claim unverifiable.
   */
  const bindingPorts: BindingPorts = {
    secrets: backend.secrets,
    sharedPath: sharedSlotPath,
    agentPath: agentSlotPath,
  };

  /**
   * `rollback.ts`'s narrow view of the same world, built per run because both the
   * heartbeat it renews and the lock it re-takes are that run's (§4.4).
   */
  function rollbackDeps(
    owner: string,
    heartbeat: () => Promise<void>,
    adopt: (a: Agent) => void,
  ): RollbackDeps {
    return {
      compute: backend.compute,
      secrets: backend.secrets,
      artifacts: backend.artifacts,
      store: { agents: backend.store.agents },
      // The ownership gate: version-conditional, so it throws rather than
      // silently proceeding if the row moved or changed hands since the read.
      reclaim: async (latest) => {
        const next = await acquireLock(latest, owner);
        // The re-locked row carries a new version. `keepLock` renews against the
        // binding `adopt` writes, so without this the first renewal after a
        // reclaim would be a stale-version write and throw CONFLICT.
        adopt(next);
        return next;
      },
      attachDeps,
      heartbeat,
      evt,
      nowIso,
      appendEvent,
      agentPrefix,
      configPrefix,
    };
  }

  async function* create(input: CreateAgentInput, opts: OpOptions = {}): AsyncIterable<OpEvent> {
    const name = validateName(input.name);
    const parsed = CreateAgentInputSchema.parse({ ...input, name });
    const { config, fleet } = await guardFleet();

    /**
     * §6.6: `create` is the one lifecycle op that never calls `acquireLock` — it
     * writes a fresh row with its lock already on it — so the fleet-wide gate has
     * to be checked here explicitly. A box launched mid-update would fetch a
     * fleet manifest that is being rewritten underneath it.
     */
    await assertFleetUnlocked(name);
    await assertSealed("create an agent");

    const who = await actor();
    const owner = `${who}#${randomUUID()}`;
    /**
     * §6.2 step 6, the `--volume` branch: resolve and validate the volume the
     * operator named *before* the row is claimed, so a bad id costs nothing —
     * no name taken, no SSM slot, no key minted. Every refusal here is a case
     * where attaching would be a guess about whose memory this is (§1).
     */
    let adopted =
      parsed.volume_id === undefined
        ? null
        : await resolveAdopted(parsed.volume_id, name, fleet.fleet_id);

    /**
     * §4.6: the fleet's shared settings are where a create's defaults come from —
     * one read, from the item `guardFleet` already returned, and `settings.defaults`
     * mirrors `_fleet.defaults` so this is the same answer from one place rather
     * than two. `resolveCreateDefaults` then decides provider, the seeded Hermes
     * settings, and where the provider key is going to come from.
     */
    const { settings } = settingsOf(fleet);
    /**
     * §8.3: a credential is not something a create carries. It belongs to a
     * provider profile, and the create names the profile — so a key on the
     * request is refused with the command that stores one, before anything
     * exists to have to clean up.
     */
    assertNoInlineKey(parsed);
    /**
     * Which profile this agent is bound to, and therefore its provider, its
     * model and the slot its key will come from. The profile is *re-checked*
     * below, once this run owns the row: the drawer that offered it read the
     * fleet seconds ago, and a profile can be disabled or emptied in between.
     */
    const profile = selectCreateProfile(settings, parsed);
    const binding = bindingOf(profile, parsed.hermes?.model);
    assertModelGranted(binding.provider, binding.model, fleet);
    const defaults = resolveCreateDefaults({ ...parsed, provider: binding.provider }, settings);
    const size = parsed.size ?? settings.defaults.size;
    const secrets_mode = parsed.secrets ?? settings.defaults.secrets;
    /**
     * §7.3. Asked of **every** create, because every agent runs a browser —
     * there is no longer a shape of agent that skips the mirrored Chrome build,
     * so there is no longer a create this does not apply to.
     *
     * Refused here, before a name is claimed or a volume is made, because the
     * alternative is a box that boots and then 403s on `browser/*` — a grant
     * only `hermetic foundation update` can give it. The cost of making the
     * browser part of what an agent *is* is that a fleet below the grant can
     * create nothing at all until it is updated, where it used to be able to
     * create the agents that happened not to want one. That is the honest
     * trade: one fleet-wide update, named in the error, rather than two kinds
     * of agent forever.
     */
    assertBrowserSupported(fleet);
    const provider = binding.provider;
    const at0 = nowIso();

    /**
     * What *this run* brings into existence, for `--rollback-on-failure`
     * (`rollback.ts`). Only the branches that actually made something write to
     * it: anything found by tag belongs to an earlier attempt and is not this
     * run's to destroy.
     */
    const ledger: CreateLedger = { claimed: false, volumeId: null, instanceId: null, retag: null };
    /**
     * The furthest along this create got. A rollback's events carry it so the
     * progress rail stops where the failure did instead of walking backwards.
     */
    let reached = 0;
    const say = (
      phase: string,
      progress: number,
      message: string,
      at: string,
      level?: OpEvent["level"],
      kind?: OpEvent["kind"],
    ): OpEvent => {
      reached = Math.max(reached, progress);
      return evt(phase, progress, message, at, level, kind);
    };

    yield say("validate", 0.02, `creating ${name} (${size}) in ${config.region}`, at0);
    // §3.6: refuse here, before a row, a key or a volume exists, rather than
    // eight minutes into a first boot whose presigned download 404s. The
    // release is whatever the *fleet manifest* names — the version is a
    // fleet-level fact now, not a per-agent pin (§1).
    const release = await currentRelease();
    /**
     * §3.6: same version, different bytes. The box will fetch the release the
     * manifest names and then apply a config *this* checkout rendered, so a
     * checkout whose hermeticd has moved on from the fleet's can render a unit
     * the published hermeticd does not know how to install. The version cannot
     * express that; the build fingerprint can, and it is worth one line before
     * anything is created rather than eight minutes into a first boot.
     */
    const drift = releaseDrift(release, { version: hermeticdVersion, build: localBuild() });
    if (drift) yield say("validate", 0.02, drift, nowIso(), "warn");

    /**
     * §6.7: a legacy `destroyed` row on the name is released before the claim.
     * The release cannot be undone, so it comes after every refusal a create
     * can make without a row — a bad `--volume`, an unusable profile, a fleet
     * that cannot run a browser, no release to boot — and costs nothing when
     * one of them was going to stop this create anyway.
     *
     * It moves a kept volume from `agent=<name>` to `former_agent=<name>`, so
     * a `--volume` resolved above is resolved once more afterwards: the
     * adoption decides its retag from the disk's tags as they are now.
     */
    const legacy = await backend.store.agents.get(name);
    /** The predecessor's `destroyed_at`, which this life must start after. */
    let floor: string | null = null;
    if (legacy?.status === "destroyed") {
      await assertProfileUsable(bindingPorts, profile);
      const released = await releaseLegacyRow(legacy, owner, who, opts.signal);
      if (released) {
        floor = released.tombstone.destroyed_at;
        yield say(
          "claim",
          0.03,
          `released ${name}, destroyed before tombstones existed${
            released.volume === "released"
              ? `; its volume ${released.tombstone.volume_id} is tagged former_agent=${name}`
              : ""
          }`,
          nowIso(),
          "warn",
        );
      }
      if (adopted) adopted = await resolveAdopted(adopted.volume_id, name, fleet.fleet_id);
    }
    // No release of our own to date from — no legacy row, or somebody else
    // released it first: the newest tombstone for the name is the predecessor.
    if (floor === null) floor = await predecessorFloor(name);

    /**
     * The new incarnation is born now, after any legacy release above, and
     * strictly after the predecessor's `destroyed_at` — the two bound
     * `history --since/--until` (§6.7), which are inclusive, and a shared
     * boundary instant would blend two lives into one window. `at0` stays the
     * validate event's.
     */
    const bornAt = strictlyAfter(nowIso(), floor);
    let fresh: Agent = {
      name,
      status: "creating",
      version: 0,
      lock: { owner, expires: new Date(backend.clock.now().getTime() + LOCK_TTL_MS).toISOString() },
      size,
      instance_type: parsed.instance_type ?? SIZES[size].instance_type,
      region: config.region,
      instance_id: null,
      volume_id: null,
      // An adopted volume is whatever size it already is; `--volume-gib` cannot
      // be combined with `--volume` (the schema refuses it) because resizing a
      // disk is not something attaching it does.
      volume_gib: adopted?.size_gib ?? parsed.volume_gib ?? settings.defaults.volume_gib,
      /**
       * The root disk, resolved once here so the row — not the launch — is what
       * says how big this box's own filesystem is. `recreate` reads it back
       * rather than re-deciding, which is what makes `agent set --root-gib`
       * followed by `recreate` mean something.
       *
       * Unrelated to an adopted volume: reclaiming someone's `/data` says
       * nothing about the root disk of the box that will read it.
       */
      root_gib: parsed.root_gib ?? settings.defaults.root_gib ?? DEFAULT_ROOT_GIB,
      hermes_version: hermesVersion,
      hermeticd_version: release.version,
      config_hash: null,
      bootstrap: null,
      command: null,
      provider,
      profile_id: binding.profile_id,
      profile_revision: binding.profile_revision,
      ...(binding.credential_ref === null ? {} : { credential_ref: binding.credential_ref }),
      secrets_mode,
      /**
       * What the operator said, plus the one thing the profile says: the model.
       *
       * The model is *managed* on every profile-bound agent, and deliberately
       * so — a profile exists to answer "which model does this credential run",
       * and an agent that could drift off it on the box would make the answer a
       * suggestion. Everything else here is still only what was actually
       * stated; what is left unsaid stays seeded (`splitHermesSettings`).
       */
      hermes: { ...(parsed.hermes ?? {}), model: binding.model },
      /**
       * And what the *fleet* said, pinned as of now. Everything here is seeded,
       * never managed (`splitHermesSettings`), so it is the agent's from first
       * boot — but it is recorded on the row, because a fleet default that was
       * re-read at render time would move every existing agent's `config_hash`
       * the day somebody changed it.
       */
      seed: defaults.seed,
      // Both halves of the tailnet identity start empty and are filled in by the
      // node's first heartbeat; they are written together everywhere, because a
      // name without an address (or the reverse) is a row that describes no node.
      // The daemon's version joins them: it is a fact only the box can state,
      // and nothing here is entitled to guess which release it will install.
      tailscale_ip: null,
      tailscale_dns_name: null,
      tailscale_version: null,
      resources: { ssm_paths: [] },
      last_heartbeat: null,
      health: null,
      metrics: null,
      created_by: await actor(),
      created_at: bornAt,
      updated_at: bornAt,
    };

    /**
     * §6.2 step 1. Three cases, and the difference between them is the whole of
     * `create`'s crash-safety story:
     *
     * - no row → conditional `PutItem` claims the name;
     * - a row whose create finished → nothing to do, and nothing may be mutated;
     * - a row still in `creating`/`error` → resume it, unless another operator's
     *   unexpired lock says they are already doing so.
     */
    type Claim =
      | { kind: "claimed" }
      | { kind: "resume"; agent: Agent }
      | { kind: "complete" }
      | { kind: "released"; floor: string | null };

    async function classify(existing: Agent): Promise<Claim> {
      /**
       * A legacy `destroyed` row appearing only now — after the release above
       * found none, so between that read and the claim — is released the same
       * way, and the claim is made again.
       */
      if (existing.status === "destroyed") {
        const released = await releaseLegacyRow(existing, owner, who, opts.signal);
        return {
          kind: "released",
          floor: released ? released.tombstone.destroyed_at : await predecessorFloor(name),
        };
      }
      if (existing.status !== "creating" && existing.status !== "error") {
        throw new HermeticError("NAME_TAKEN", `agent ${name} already exists`, {
          name,
          status: existing.status,
        });
      }
      if (isHandedOff(existing)) return { kind: "complete" };
      if (lockHeldByOther(existing, owner)) {
        throw new HermeticError(
          "NAME_TAKEN",
          `agent ${name} is being created right now by ${existing.lock?.owner ?? "another operator"}`,
          // §4.4: who holds the lease and when it lapses. This refusal is the
          // one `NAME_TAKEN` that is contention rather than a taken name, and a
          // caller that has to tell the two apart — the portal's boot resume,
          // which waits the lease out rather than dropping the work — cannot do
          // it from the code alone.
          { name, owner: existing.lock?.owner ?? null, expires: existing.lock?.expires ?? null },
        );
      }
      return { kind: "resume", agent: existing };
    }

    async function claimFresh(): Promise<Claim> {
      /**
       * §8.3: the profile may not be bound to if the fleet has turned it off or
       * emptied its slot — but only where a *new* agent is being made. There is
       * no row here, so this is that case; a re-run against an existing
       * `creating` row goes down the `resume` branch above and finishes the
       * agent that exists, whatever the profile has done since.
       *
       * Asked here rather than beside `selectCreateProfile` on purpose: this is
       * the last moment before the name is claimed, which makes it the reading
       * that actually decides anything.
       */
      await assertProfileUsable(bindingPorts, profile);
      if (await backend.store.agents.putIfAbsent(fresh)) return { kind: "claimed" };
      // Someone claimed the name between the read and the put — that is the
      // race the conditional put exists to lose safely.
      return await classify(await getAgent(name));
    }

    const before = await backend.store.agents.get(name);
    let claim: Claim = before ? await classify(before) : await claimFresh();
    // A legacy row released just now: the name is free, so claim it — once.
    // As after the release above: the disk's tags have moved, and this life
    // starts after the one just released.
    if (claim.kind === "released") {
      if (adopted) adopted = await resolveAdopted(adopted.volume_id, name, fleet.fleet_id);
      const reborn = strictlyAfter(nowIso(), claim.floor);
      fresh = { ...fresh, created_at: reborn, updated_at: reborn };
      claim = await claimFresh();
    }
    if (claim.kind === "released") {
      throw new HermeticError(
        "CONFLICT",
        `the name ${name} was released and then taken again by a destroyed record; re-run the create`,
        { name },
      );
    }

    if (claim.kind === "complete") {
      yield evt("done", 1, `${name} already exists and is fully provisioned`, nowIso());
      return;
    }

    let agent: Agent;
    if (claim.kind === "claimed") {
      /**
       * H4's other half. The gate at the top of this function was read before
       * this row existed, so a teardown that took the fleet lock afterwards
       * could scan the table and never see the claim. Reading the gate a second
       * time, now that the row is written, leaves no interleaving where both
       * operations proceed: either teardown's scan sees the row, or this check
       * sees the lock. Losing hands the name straight back, so a refused create
       * leaves nothing of itself behind.
       */
      try {
        await assertFleetUnlocked(name);
      } catch (e) {
        await backend.store.agents.delete(name);
        throw e;
      }
      agent = fresh;
      // The row is this run's: a rollback may delete it again (`rollback.ts`).
      ledger.claimed = true;
      await appendEvent(name, "create", `requested (${size})`, null, "creating");
    } else {
      yield say("resume", 0.05, `resuming an interrupted create of ${name}`, nowIso(), "warn");
      agent = await acquireLock(claim.agent, owner);
    }

    /**
     * One keeper for every wait this create makes — the attach below, and the
     * detach a rollback waits on — so the TTL lock is renewed the same way
     * whichever of them is running (§4.4).
     */
    const keepLock = lockKeeper(
      () => agent,
      (a) => {
        agent = a;
      },
      owner,
    );

    /**
     * See `abandoned`. `done` is the whole op; `committed` is the earlier moment
     * this create stopped being undoable — the handoff, where the row is written
     * with `lock: null` and the instance takes over. Everything after it is a
     * read loop, so an abandonment there is somebody closing a tab on an agent
     * that exists and works, and must not be written down as a failure.
     */
    let done = false;
    let committed = false;
    let failure: unknown = null;

    try {
      checkAbort(opts.signal, "secrets");

      // §4.4: the `--volume` refusals were decided before this run owned
      // anything. Ask again now that it does, and before a key is minted or a
      // box is launched — see `reconfirmAdopted`.
      if (adopted) await reconfirmAdopted(adopted.volume_id, name);

      // §6.2 steps 2–4: slot and push. The value never appears in an event.
      const ssm_paths = [tsKeyPath(name)];
      await backend.secrets.ensureSlot(tsKeyPath(name));
      if (await backend.secrets.isPlaceholder(tsKeyPath(name))) {
        const key = await backend.tailscale.mintAuthKey(cloudName(fleet.fleet_id, name));
        await backend.secrets.put(tsKeyPath(name), key);
      }
      yield say("secrets", 0.2, "tailscale auth key minted and stored in its SSM slot", nowIso());

      /**
       * §8.3: a keyed provider needs its API key on the box before Hermes can
       * start, and it comes from the agent's *binding* — the profile the row
       * pins, snapshotted into this agent's own slot for that revision.
       *
       * The row is what is read, not the request: a resumed create finishes the
       * agent that exists, and a row written before profiles existed has no
       * binding at all and keeps the shared-slot rule it was created under.
       */
      const rowBinding: ProfileBinding | null =
        agent.profile_id !== undefined && agent.profile_revision !== undefined
          ? {
              provider: agent.provider,
              profile_id: agent.profile_id,
              profile_revision: agent.profile_revision,
              model: agent.hermes?.model ?? binding.model,
              credential_ref: agent.credential_ref ?? null,
            }
          : null;
      if (providerNeedsKey(agent.provider) && rowBinding !== null) {
        const keyVar = PROVIDERS[agent.provider].env;
        const bound = settings.profiles?.[rowBinding.profile_id];
        const snapshot =
          bound === undefined
            ? null
            : await snapshotCredential(bindingPorts, bound, name, rowBinding.credential_ref);
        if (snapshot !== null) ssm_paths.push(snapshot.path);
        if (snapshot?.filled === true) {
          await appendEvent(
            name,
            "secrets.push",
            `${rowBinding.credential_ref ?? "provider-key"} from profile ${rowBinding.profile_id} r${String(rowBinding.profile_revision)}`,
          );
          yield say(
            "secrets",
            0.22,
            `${keyVar} copied from provider profile ${bound?.name ?? rowBinding.profile_id} into its SSM slot`,
            nowIso(),
          );
        } else {
          yield say(
            "secrets",
            0.22,
            `provider profile ${bound?.name ?? rowBinding.profile_id} holds no key; Hermes will not start until \`hermetic providers update ${bound?.name ?? rowBinding.profile_id} --api-key-stdin\` fills it and this agent is recreated`,
            nowIso(),
            "warn",
          );
        }
      } else if (providerNeedsKey(agent.provider)) {
        // The pre-profiles path, kept for the rows that are on it (§8.3): one
        // fixed slot per agent, filled from the fleet's shared slot for the
        // provider. Nothing new is ever created down here.
        const keyVar = PROVIDERS[agent.provider].env;
        ssm_paths.push(providerKeyPath(name));
        await backend.secrets.ensureSlot(providerKeyPath(name));
        if (await backend.secrets.isPlaceholder(providerKeyPath(name))) {
          /**
           * §8.3: the fleet may already hold this provider's key in a shared
           * slot, and the copy happens *here*, on the laptop, with the operator's
           * credentials — no instance role can read `/hermetic/*`, so a box only
           * ever sees its own copy. The slug is stated; the value is a local
           * `const` that goes to SSM and nowhere else.
           *
           * The slot is resolved against the *row's* provider rather than the
           * request's, because a resumed create finishes the agent that exists.
           *
           * A slot that is empty is not a failure: the agent is created with an
           * empty key slot exactly as an unanswered prompt leaves it, and the
           * warning names the slot to fill rather than the agent.
           */
          const source = providerKeySource(agent.provider, settings);
          const slug = typeof source === "object" ? source.shared : null;
          const filled =
            slug !== null &&
            (await backend.secrets.exists(sharedSecretPath(fleet.fleet_id, slug))) &&
            !(await backend.secrets.isPlaceholder(sharedSecretPath(fleet.fleet_id, slug)));
          if (slug !== null && filled) {
            const value = await backend.secrets.get(sharedSecretPath(fleet.fleet_id, slug));
            await backend.secrets.put(providerKeyPath(name), value);
            await appendEvent(name, "secrets.push", `provider-key from shared slot ${slug}`);
            yield say(
              "secrets",
              0.22,
              `${keyVar} copied from the fleet's shared slot ${slug} into its SSM slot`,
              nowIso(),
            );
          } else {
            yield say(
              "secrets",
              0.22,
              slug === null
                ? `no ${keyVar} was supplied; Hermes will not start until \`hermetic secrets push ${name} --provider-key\` fills the slot`
                : `shared slot ${slug} is empty; Hermes will not start until \`hermetic secrets push _fleet --shared ${slug}\` fills it and this agent is recreated`,
              nowIso(),
              "warn",
            );
          }
        }
      }

      if (agent.secrets_mode === "bitwarden") {
        ssm_paths.push(bwsPath(name));
        await backend.secrets.ensureSlot(bwsPath(name));
        if (await backend.secrets.isPlaceholder(bwsPath(name))) {
          // TODO(evan): PHASE2 — mirror the machine-account token from the admin Bitwarden
          // project (§8.2 `--from-bitwarden`). Core cannot prompt, so until then
          // the operator pushes it explicitly.
          yield say(
            "secrets",
            0.24,
            `bitwarden slot created but empty; run \`hermetic secrets push ${name} --bws-token\``,
            nowIso(),
            "warn",
          );
        }
      }

      checkAbort(opts.signal, "render");
      agent = await renewLock(agent, owner);

      // §6.2 step 5: render final files, tarball, record config_hash.
      const rendered = await ensureConfig(agent, fleet);
      yield say(
        "render",
        0.4,
        `rendered ${rendered.manifest.files.length} files, config_hash ${rendered.config_hash}`,
        nowIso(),
      );

      /**
       * The configuration pointer, recorded here rather than at the handoff
       * (§6.2). The object is in the bucket as of the line above (§4.5), and
       * this is the last moment the row has one writer: the instance launched
       * below boots hermeticd, which writes this row too (see `commitHandoff`).
       *
       * `ssm_paths` deliberately does not come with it. It is the last field
       * `isHandedOff` waits for, and that predicate is how a re-run tells a
       * finished create from one to resume — moving it here would make a create
       * that died at the attach look complete to the next operator.
       */
      agent = await backend.store.agents.update(agent.name, agent.version, {
        config_hash: rendered.config_hash,
        resources: { ...agent.resources, config_key: rendered.key },
      });

      checkAbort(opts.signal, "volume");

      // §6.2 step 6: idempotent by checking reality first.
      let volume: VolumeRef | null;
      if (adopted) {
        /**
         * The reclaim path. Nothing is created, so `ledger.volumeId` stays null:
         * a rollback may never delete a volume this run merely adopted — it holds
         * an agent's memory from before this create existed (§1), exactly like
         * one found by tag.
         *
         * A resume re-enters here with the row already naming a volume. If it
         * names a *different* one, this create is being resumed with a different
         * `--volume` than it started with, and picking either would be a guess.
         */
        const already = agent.resources.volume_id ?? agent.volume_id;
        if (already !== null && already !== undefined && already !== adopted.volume_id) {
          throw new HermeticError(
            "CONFLICT",
            `${name} is already being created on ${already}; re-run without --volume, or with --volume ${already}`,
            { name, volume_id: adopted.volume_id, existing_volume_id: already },
          );
        }
        volume = { volume_id: adopted.volume_id, size_gib: adopted.size_gib, state: adopted.state };
        /**
         * The tag rewrite, decided in the volumes design: silent, and evented.
         * Without it `findVolumeByTag` would never find this volume again, and
         * the agent's memory would be invisible to every later resume, recreate
         * and destroy. It is not confirmed a second time — the operator named
         * this volume by id, which is not a guess — but the ledger explains it
         * afterwards.
         */
        if (adopted.agent !== name) {
          /**
           * Written *before* the call, not after: a `CreateTags` that fails
           * having already applied some of its tags would otherwise leave a
           * rewrite nothing records, and the whole point of the ledger is that
           * `--rollback-on-failure` can put back exactly what this run moved.
           * Restoring a tag that was never changed writes the same bytes twice.
           */
          ledger.retag = {
            volumeId: adopted.volume_id,
            agent: adopted.agent,
            roleData: adopted.role_data,
            name: adopted.tags["Name"] ?? null,
            formerAgent: adopted.former_agent,
          };
          /**
           * A volume a destroy kept carries `former_agent=<old name>` (§6.7).
           * Adoption gives it a current owner, so the past one goes: a disk
           * tagged with both would read as two agents' memory at once.
           */
          await backend.compute.retagVolume(adopted.volume_id, name, {
            name: `${cloudName(fleet.fleet_id, name)}-data`,
            ...(adopted.former_agent === null ? {} : { formerAgent: null }),
          });
          /**
           * What the disk said before, in its own words: a volume a destroy
           * released carries its old name as `former_agent`, not `agent`, and
           * "agent=(none)" would hide whose memory this is.
           */
          const was =
            adopted.agent === null && adopted.former_agent !== null
              ? `former_agent=${adopted.former_agent}`
              : `agent=${adopted.agent ?? "(none)"}`;
          await appendEvent(
            name,
            "volume",
            `adopted ${adopted.volume_id} (${adopted.size_gib} GiB); tag ${was} rewritten to agent=${name}`,
          );
          yield say(
            "volume",
            0.55,
            `adopted ${adopted.volume_id} (${adopted.size_gib} GiB); it was tagged ${was} and is now agent=${name}`,
            nowIso(),
            "warn",
          );
        } else {
          /**
           * The tag already names this agent, so there is no rewrite to make —
           * but there can still be one to *undo*. A first attempt that retagged
           * `vol-X` from `oriole` to `bravo` and then died leaves exactly this
           * shape, and a re-run that claimed the name afresh (so no row of ours
           * owned the volume before this run) is looking at that attempt's
           * debris. Without an entry here its `--rollback-on-failure` would
           * delete the row and leave `vol-X` tagged for a `bravo` that does not
           * exist — which is the trap the whole ledger entry exists to prevent:
           * the *next* plain `create bravo` would find it by tag and silently
           * attach somebody else's memory (§1).
           *
           * Whose it was is a fact the store still holds rather than a guess
           * (§6.7). The first attempt cleared the volume's `former_agent` tag,
           * but the destroy that kept the disk left a tombstone naming it
           * (`volume_kept`), so the newest such tombstone is the name to give
           * back — as `former_agent`, never as `agent`, so no later plain
           * `create` of that name adopts it by accident. A tag still present
           * says the same thing first-hand. A legacy `destroyed` row (from
           * before tombstones) that still names the disk is the older form of
           * the same record, and its volume kept `agent=<name>`, which is what
           * is put back. When nothing names it, nothing is recorded — the tag
           * was already like that when this run arrived (an operator's own
           * label, say), and stripping it would be a rollback undoing
           * something it never did.
           */
          if (ledger.claimed) {
            const formerAgent =
              adopted.former_agent ??
              (await backend.store.events.queryTombstones()).find(
                (t) => t.volume_kept && t.volume_id === adopted.volume_id,
              )?.name ??
              null;
            const legacyOwner =
              formerAgent === null
                ? (await backend.store.agents.scan()).find(
                    (a) =>
                      a.name !== name &&
                      a.status === "destroyed" &&
                      (a.resources.volume_id ?? a.volume_id) === adopted.volume_id,
                  )
                : undefined;
            if (formerAgent !== null) {
              ledger.retag = {
                volumeId: adopted.volume_id,
                agent: null,
                roleData: adopted.role_data,
                name: adopted.tags["Name"] ?? null,
                formerAgent,
              };
            } else if (legacyOwner) {
              ledger.retag = {
                volumeId: adopted.volume_id,
                agent: legacyOwner.name,
                roleData: adopted.role_data,
                name: adopted.tags["Name"] ?? null,
              };
            }
          }
          await appendEvent(name, "volume", `adopted ${adopted.volume_id} (${adopted.size_gib} GiB)`);
          yield say(
            "volume",
            0.55,
            `adopted ${adopted.volume_id} (${adopted.size_gib} GiB); no volume created`,
            nowIso(),
          );
        }
      } else {
        volume = await backend.compute.findVolumeByTag(name);
        if (!volume) {
          volume = await backend.compute.createVolume(
            name,
            agent.volume_gib,
            `${cloudName(fleet.fleet_id, name)}-data`,
          );
          // This disk did not exist a moment ago, so a rollback may delete it. One
          // found by tag holds an earlier attempt's data and never may (§1).
          ledger.volumeId = volume.volume_id;
        }
        yield say("volume", 0.55, `data volume ${volume.volume_id} (${volume.size_gib} GiB)`, nowIso());
      }

      // §4.5: `resources` records what each step produced as it happens, not
      // only at the end, so a crash between steps leaves the row describing
      // what actually exists in AWS for another operator to finish or clean up.
      agent = await backend.store.agents.update(agent.name, agent.version, {
        volume_id: volume.volume_id,
        resources: { ...agent.resources, volume_id: volume.volume_id },
      });

      /**
       * And that write is the end of §9.1's window: the row now names the disk,
       * which is the durable claim every later read consults — `resolveAdopted`
       * refuses it, `volume delete` refuses it, `volume ls` shows it as owned.
       * The reservation existed only to cover the stretch where no such record
       * existed, so it goes back here rather than being carried through a boot
       * that can take longer than its TTL.
       */
      if (adopted) await volumeClaims.release(volume.volume_id, adoptionOwner(name));

      checkAbort(opts.signal, "instance");
      agent = await renewLock(agent, owner);

      // §6.2 step 7, crash-safe order:
      //   1. find a live tagged instance, else launch one
      //   2. write the instance id onto the row *before* anything else
      //   3. attach the data volume (idempotent on resume)
      // Attach can fail after RunInstances has already spent the money; an id
      // that only lived in the EC2 response would then be invisible to every
      // later resume. Reality-first find covers the case where a previous
      // attempt launched but never persisted.
      //
      // Which live box is *this agent's* is decided the same way `doctor` decides
      // it — the one the row already records, if it is still there, and only
      // otherwise the first the tag returns. The two must never disagree: this
      // step rewrites `instance_id` with whatever it picks, so adopting EC2's
      // arbitrary first match would demote the correct box to a permanent
      // duplicate that nothing but a destructive `recreate` clears.
      const liveTagged = await backend.compute.listInstancesByTag(name);
      const recordedId = agent.resources.instance_id ?? agent.instance_id ?? null;
      let instance =
        (recordedId ? liveTagged.find((i) => i.instance_id === recordedId) : undefined) ?? null;
      /**
       * The tag query is an *index*, and it lags the instance it indexes. A
       * recorded id it did not return is therefore not evidence that the box is
       * gone — ask EC2 about the id itself first (`recordedInstance`), and only
       * then fall back to whatever the tag did return.
       */
      if (!instance && recordedId !== null) {
        instance = yield* recordedInstance(name, recordedId, say, opts);
      }
      instance = instance ?? liveTagged[0] ?? null;
      if (liveTagged.length > 1) {
        // Named, not terminated: create adopts, it does not destroy (§4.5), and
        // `recreate`'s sweep is where a stray is cleared.
        const strays = liveTagged
          .filter((i) => i.instance_id !== instance?.instance_id)
          .map((i) => i.instance_id);
        yield say(
          "instance",
          0.78,
          `${strays.length} other instance(s) are tagged for ${name} (${strays.join(", ")}); \`hermetic agent recreate ${name}\` terminates every stray`,
          nowIso(),
          "warn",
        );
      }
      if (instance) {
        yield say(
          "instance",
          0.78,
          `found live instance ${instance.instance_id}; capturing id on the agent row`,
          nowIso(),
          undefined,
          "start",
        );
      } else {
        yield say(
          "instance",
          0.8,
          `launching a ${agent.instance_type} on ${fleet.ami_id}`,
          nowIso(),
          undefined,
          "start",
        );
        instance = await backend.compute.runInstance({
          name,
          instance_type: agent.instance_type,
          ami_id: fleet.ami_id,
          user_data: await userDataFor(name, fleet, release),
          // Public IP assignment follows the fleet's mode explicitly rather than
          // whatever the subnet happens to default to (§6.2).
          network: fleet.network,
          // The row's, not the request's: a resumed create must launch the box
          // the first attempt decided on, and `recreate` reads the same field.
          ...(agent.root_gib ? { root_gib: agent.root_gib } : {}),
          /**
           * `hermetic:managed` and `hermetic:fleet_id` are stamped by the EC2
           * layer itself, because every filter there depends on them. What is
           * left for the caller is what only it knows: whose box this is, and
           * what the console should call it.
           */
          tags: { agent: name, Name: cloudName(fleet.fleet_id, name) },
        });
        // This run spent the money on this box, so a rollback may terminate it.
        ledger.instanceId = instance.instance_id;
      }

      // Persist before attach. This is the whole of the crash-safety story for
      // instances: whatever happens next, the row names what exists in AWS.
      agent = await backend.store.agents.update(agent.name, agent.version, {
        instance_id: instance.instance_id,
        resources: {
          ...agent.resources,
          volume_id: volume.volume_id,
          instance_id: instance.instance_id,
        },
      });
      yield say(
        "instance",
        0.85,
        `instance ${instance.instance_id} recorded on the agent row`,
        nowIso(),
        undefined,
        "done",
      );

      checkAbort(opts.signal, "attach");
      /**
       * Unbounded on purpose (`attach.ts`): a fresh instance takes minutes to
       * boot, and that is not a failure. The lock is renewed on every poll,
       * because a wait longer than `LOCK_TTL_MS` would otherwise unlock a
       * create that is still running (§4.4).
       */
      yield* attachAgentVolume(attachDeps(), instance.instance_id, volume.volume_id, {
        ...(opts.signal ? { signal: opts.signal } : {}),
        heartbeat: keepLock,
        progress: { waiting: 0.9, done: 0.92 },
      });
      reached = 0.92;

      checkAbort(opts.signal, "handoff");

      /**
       * The handoff itself: the ids this run is responsible for, the slots it
       * filled, and the lock going away. `commitHandoff` merges it with
       * whatever the box has said about itself meanwhile (`handoff.ts`), and
       * the patch is built from the row the write is conditioned on so a retry
       * spreads current `resources` rather than this run's old copy.
       */
      agent = await commitHandoff(
        {
          getAgent: (n) => backend.store.agents.get(n),
          update: (n, version, patch) => backend.store.agents.update(n, version, patch),
        },
        agent,
        (row) => ({
          instance_id: instance.instance_id,
          volume_id: volume.volume_id,
          resources: {
            ...row.resources,
            volume_id: volume.volume_id,
            instance_id: instance.instance_id,
            ssm_paths,
          },
          lock: null,
        }),
        { owner, instance_id: instance.instance_id },
      );
      await appendEvent(name, "handoff", "lock released; the instance reports from here");
      committed = true;

      yield say(
        "instance",
        0.93,
        `${name} handed off to its instance; hermeticd reports from here`,
        nowIso(),
        undefined,
        "done",
      );

      /**
       * The op does not end at handoff any more (`handoff.ts`). Nothing below
       * writes the row — the lock is already released — so this is a read loop an
       * operator can watch, abort, or ignore, and a box that never reports ends
       * the op `ok` with a warning rather than a green 100% over silence.
       */
      yield* watchHandoff(handoffDeps(), name, {
        ...(opts.signal ? { signal: opts.signal } : {}),
        progress: { waiting: 0.94, done: 0.99 },
        /**
         * What this create asked the tailnet to call the box — the same string
         * user-data carries, plus the fleet's tailnet. The watch compares it to
         * what the box says about itself, which is the earliest and cheapest
         * moment anything can: after this the op is over and the disagreement is
         * only visible to whoever opens a drawer or runs `doctor`.
         */
        expectHostname: `${cloudName(fleet.fleet_id, name)}.${fleet.tailnet}`,
      });

      /**
       * Before the yield, not after. A consumer that reads the terminal event and
       * stops — `for await (…) { if (e.progress === 1) break; }`, a UI that closes
       * its stream on `done` — resumes the generator with a `return` completion
       * *at this yield*, so a flag set on the line below would never run and a
       * fully successful op would unwind itself.
       */
      done = true;
      yield say("done", 1, `${name} created`, nowIso());
    } catch (e) {
      failure = e;
      /**
       * Opt-in, and it runs *before* the lock is released: an unwind with the
       * row unlocked is an unwind another operator can resume into the middle of.
       *
       * **Not on an abort.** An abort means stop, and stopping leaves a row that
       * names what exists for the next run to finish (§4.5) — which is strictly
       * better than what an interrupted unwind leaves. The heads do not wait: the
       * CLI's SIGINT handler force-exits ~1.5s after `abortAll()`, and the detach
       * wait inside a rollback polls on EC2's clock, so an abort-triggered
       * rollback would reliably die between terminating the instance and deleting
       * anything else, with the lock still held and no `failed` event written. An
       * abort that arrives *during* a rollback is a different thing and is
       * handled (`RollbackOptions.signal`).
       *
       * Both halves of that are tested, and they are not the same test. The code
       * is what `checkAbort` raised; the signal is what the operator did. No
       * `AbortSignal` reaches the AWS SDK calls, so ctrl-C during a `RunInstances`
       * that is already in flight lets it finish and throw its own answer —
       * `InsufficientInstanceCapacity`, say — and the code alone would then read
       * that as an ordinary failure and start unwinding into a process that is
       * about to be killed.
       *
       * `rollbackCreate` re-takes the lock to prove the row is still this run's
       * before it touches anything, and catches every step itself; the try here is
       * belt and braces, because nothing it could throw is worth more than `e`.
       */
      if (parsed.rollback_on_failure && !hasCode(e, "ABORTED") && !opts.signal?.aborted) {
        try {
          yield* rollbackCreate(
            rollbackDeps(owner, keepLock, (a) => {
              agent = a;
            }),
            name,
            ledger,
            owner,
            reached,
            { ...(opts.signal ? { signal: opts.signal } : {}) },
          );
        } catch {
          // The original failure is the one the operator needs; see below.
        }
      }
      throw e;
    } finally {
      // Whatever went wrong — including nobody being left to consume this — the
      // lock must not outlive this process's attempt, and the agent's history
      // must say why the run stopped. `unwind` reads the row rather than assuming
      // one, so a rollback that deleted it is fine.
      if (!done) {
        await unwind(name, "create", owner, failure ?? abandoned(name, "create"), {
          record: !committed,
        });
      }
    }
  }

  return { create };
}
