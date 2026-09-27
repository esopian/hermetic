/**
 * Performing a staged provider change (§8.3), and the two small reads that sit
 * beside it.
 *
 * Its own module for the reason `profile-binding.ts` is one (core rule 5):
 * `hermetic.ts` is the file that keeps arriving at the 2500-line cap, and this
 * is a self-contained subject — the slots the binding reads and writes, the
 * ordered write that turns `pending` into the running configuration, and the
 * fleet read every row view is annotated from. `profile-binding.ts` decides
 * *what* a binding says; this performs it.
 *
 * Everything is taken as an explicit deps object rather than closed over a
 * backend, which is the point of the split: the one function here that moves a
 * credential is handed the five secret calls it makes and the two path rules it
 * follows, so "this module reads the fleet's slot and writes the agent's, and
 * touches nothing else" is a claim the type states rather than one a reader has
 * to verify.
 */
import { HermeticError, isHermeticError } from "../errors.ts";
import {
  applyPendingPatch,
  assertModelGranted,
  pendingApplied,
  snapshotCredential,
  type BindingPorts,
} from "./profile-binding.ts";
import { settingsOf } from "./settings.ts";
import { agentParamPath, sharedSecretPath } from "../backend/constants.ts";
import type { CoreContext } from "../context.ts";
import type { Agent, FleetSettings } from "../schema/index.ts";

/**
 * §8.3's apply needs nothing beyond the shared context: the slots a binding
 * reads and writes are the backend's SSM, the paths are the fleet's, and the
 * render is the same `ensureConfig` every other writer of a config bundle
 * uses. The hash and the binding have to be one write; see `applyPending`.
 */
export interface ProfileApplyDeps {
  ctx: CoreContext;
}

export function createProfileApply(deps: ProfileApplyDeps) {
  /**
   * The slots and path rules `profile-binding.ts` needs, gathered once and
   * shared by `agents.set` and the rollout's apply (§8.3). Deliberately not the
   * backend: the module it feeds resolves credentials, and handing it more than
   * the slots it reads and writes would make that claim unverifiable.
   */
  const { ctx } = deps;
  const bindingPorts: BindingPorts = {
    secrets: ctx.backend.secrets,
    sharedPath: (slug) => sharedSecretPath(ctx.fleetId(), slug),
    agentPath: (agent, slot) => agentParamPath(ctx.fleetId(), agent, slot),
  };

  /**
   * The fleet's settings for the two readers that annotate a row with them
   * (`update_available`, §8.3), and `undefined` when the item cannot be read.
   *
   * Soft on purpose: `agent ps` answering about agents must not fail because
   * `_fleet` was momentarily unreadable. The annotation is simply absent, which
   * is what every head renders as nothing to show.
   */
  async function settingsForView(): Promise<FleetSettings | undefined> {
    const fleet = await ctx.backend.store.fleet.get().catch(() => null);
    return fleet === null ? undefined : settingsOf(fleet).settings;
  }

  /**
   * §8.3: perform the change `agents.set` staged on this row.
   *
   * Order is the whole of the crash-safety story, and it is the same one
   * `create` uses: everything that can be re-done idempotently happens first,
   * and **one** conditional row write is the commit point.
   *
   * 1. The credential is copied into the slot the *new* binding names — a slot
   *    the running configuration does not read, so a failure here changes
   *    nothing the box is serving.
   * 2. The configuration the new binding renders is uploaded, exactly as
   *    `create` uploads before it writes the row. The object is keyed by its
   *    own hash, so an upload for an apply that then fails is a few kilobytes
   *    nothing points at, never a document that contradicts a row.
   * 3. The row write moves the binding, clears `pending` **and states the
   *    `config_hash`/`config_key` that binding renders**, all under the row's
   *    version.
   *
   * Step 3 carries the hash because the alternative is a row that can tear. If
   * the binding moved in one write and the hash followed in another, a failure
   * between them — an S3 error, a lost CAS race, a laptop closing — would leave
   * a row naming the new profile, with nothing staged, whose `config_hash` is
   * still the document the box is running and already reports as applied. Every
   * laptop-side reading would say the change had landed; the box would go on
   * serving the previous credential; and nothing on the row would say otherwise.
   *
   * The credential is read from the *profile*, here, on the laptop — never from
   * anything the request carried, and never by the box, which cannot read
   * `/hermetic/*` at all.
   */
  async function applyPending(agent: Agent): Promise<Agent> {
    const pending = agent.pending;
    if (pending === null || pending === undefined) return agent;
    const { fleet } = await ctx.guardFleet();
    const { settings } = settingsOf(fleet);
    const profile = settings.profiles?.[pending.profile_id];
    if (profile === undefined) {
      throw new HermeticError(
        "NOT_FOUND",
        `${agent.name} is staged onto provider profile ${pending.profile_id}, which no longer exists; re-stage it with \`hermetic agent set ${agent.name} --provider-profile <id|name>\``,
        { name: agent.name, profile: pending.profile_id },
      );
    }
    /**
     * §8.3: the staged revision is the one whose credential this apply would
     * copy, and the slot it copies into is named for it. A profile rotated
     * since the staging has a *different* key under the same `profile_id`, so
     * going ahead would put today's key in the slot named for the revision the
     * operator staged and record `profile_revision` as that older number — a
     * row whose snapshot claims a revision it does not hold, and an
     * `update_available` that reads as "not yet applied" for a key that has
     * already landed.
     *
     * Refused rather than silently re-pinned: staging is what the operator
     * reviewed in `plan.rollout`, and quietly applying a different revision of
     * a credential is the same class of substitution `assertModelGranted`
     * refuses to make.
     */
    if (profile.revision !== pending.profile_revision) {
      throw new HermeticError(
        "CONFLICT",
        `${agent.name} is staged onto provider profile ${profile.name} at r${String(pending.profile_revision)}, ` +
          `which has since moved to r${String(profile.revision)}; re-stage it with ` +
          `\`hermetic agent set ${agent.name} --refresh-profile\` and apply again`,
        {
          name: agent.name,
          profile: profile.id,
          staged_revision: pending.profile_revision,
          revision: profile.revision,
        },
      );
    }
    assertModelGranted(pending.provider, pending.model, fleet);
    let snapshot: { path: string; filled: boolean } | null;
    try {
      snapshot = await snapshotCredential(bindingPorts, profile, agent.name, pending.credential_ref);
    } catch (e) {
      /**
       * Re-thrown with the step named rather than swallowed. The previous
       * binding is untouched — nothing has written the row yet — but a
       * half-written *slot* is the one thing an operator has to be told about,
       * so `partial_write` says which one.
       */
      throw new HermeticError(
        isHermeticError(e) ? e.code : "INTERNAL",
        `${agent.name}'s staged credential could not be written to ${pending.credential_ref ?? "(no slot)"}, so its binding is unchanged: ${isHermeticError(e) ? e.message : String(e)}`,
        { name: agent.name, partial_write: pending.credential_ref ?? null },
      );
    }
    if (snapshot !== null && !snapshot.filled) {
      throw new HermeticError(
        "VALIDATION",
        `provider profile ${profile.name} holds no key, so ${agent.name} cannot be moved onto it; \`hermetic providers update ${profile.name} --api-key-stdin\``,
        { name: agent.name, profile: profile.id },
      );
    }
    const paths =
      snapshot === null || agent.resources.ssm_paths.includes(snapshot.path)
        ? agent.resources.ssm_paths
        : [...agent.resources.ssm_paths, snapshot.path];
    /**
     * Rendered from the row as it *will* stand, and uploaded before the commit.
     * `pendingApplied` is the same patch the write below applies, so the hash
     * recorded there and the document in the bucket cannot name different
     * bindings.
     */
    const rendered = await ctx.ensureConfig(pendingApplied(agent), fleet);
    return await ctx.backend.store.agents.update(agent.name, agent.version, {
      ...applyPendingPatch(agent),
      config_hash: rendered.config_hash,
      resources: { ...agent.resources, ssm_paths: paths, config_key: rendered.key },
    });
  }

  return { bindingPorts, applyPending, settingsForView };
}
