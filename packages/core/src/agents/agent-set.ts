/**
 * `agents.set`: patch the row, stage a provider change (§8.3), and re-render so
 * the row's `config_key` names a tarball that matches it. Its own module with
 * an explicit deps object (AGENTS.md rule 5): the shared guards, locks and
 * render come from `agent-runtime.ts`; the binding ports from `profile-apply.ts`.
 */
import type { AgentView, HermesSettings, SetAgentInput } from "../schema/index.ts";
import { SIZES, SetAgentInput as SetAgentInputSchema } from "../schema/index.ts";
import { HermeticError } from "../errors.ts";
import { validateName } from "../shared/naming.ts";
import { settingsOf } from "../profiles/settings.ts";
import {
  assertModelGranted,
  assertProfileUsable,
  describePending,
  pendingApplied,
  stageProfileChange,
  stagesProfileChange,
  type BindingPorts,
} from "../profiles/profile-binding.ts";
import type { CoreContext } from "../context.ts";

/** What `agents.set` needs beyond the shared context: the slots a binding reads (§8.3). */
export interface SetDeps {
  ctx: CoreContext;
  bindingPorts: BindingPorts;
}

export function createAgentSet(deps: SetDeps) {
  const {
    guardFleet,
    assertFleetUnlocked,
    getAgent,
    nowIso,
    actor,
    assertCanApply,
    ensureConfig,
    appendEvent,
    view,
  } = deps.ctx;
  const agents = deps.ctx.backend.store.agents;
  const { bindingPorts } = deps;

  async function set(input: SetAgentInput): Promise<AgentView> {
    const parsed = SetAgentInputSchema.parse(input);
    validateName(parsed.name);
    const { fleet } = await guardFleet();
    // §4.4: a fleet-wide lock refuses every agent mutation, and this is one —
    // it writes the row that a teardown's agent check has just proved empty and
    // that a foundation update is rewriting. Before the read, so an operator is
    // told what is happening rather than which version their row is at.
    await assertFleetUnlocked(parsed.name);
    const agent = await getAgent(parsed.name);
    /**
     * §8.3's stale-form guard, the same one `settings.set` has — and asked
     * here, before any refusal that costs a read, because the answer is already
     * in hand and a caller whose row has moved wants to hear that first.
     *
     * The store's own conditional write catches a row that moves *during* this
     * call; this catches one that moved before it, which the conditional write
     * cannot see: `getAgent` above would read the new version and compose a
     * patch onto it quite happily, quietly discarding whatever the other
     * operator staged.
     */
    if (parsed.expected_version !== undefined && parsed.expected_version !== agent.version) {
      throw new HermeticError(
        "CONFLICT",
        `${agent.name} is at version ${agent.version}, not ${parsed.expected_version}; re-read and retry`,
        { name: agent.name, expected: parsed.expected_version, actual: agent.version },
      );
    }

    const patch: Record<string, unknown> = {};
    if (parsed.secrets !== undefined) patch["secrets_mode"] = parsed.secrets;
    if (parsed.hermes_version !== undefined) patch["hermes_version"] = parsed.hermes_version;
    /**
     * A merge, not a replacement (`SetAgentInput.hermes`): `--max-turns N`
     * states one field and must leave the others alone. Setting a field is also
     * what moves it from the seeded half to the managed half — see
     * `splitHermesSettings` — so this is the line that decides hermetic now
     * holds that setting on this agent.
     */
    const hermesPatch: HermesSettings = { ...(agent.hermes ?? {}), ...(parsed.hermes ?? {}) };
    // The SDK/HTTP shape can carry the model inside `hermes` (the CLI's `set`
    // never does; `--model` is top-level there). It is the same write as the
    // bare `--model` branch below and gets the same grant check, or a Bedrock
    // model outside the grant would land through this door and not that one.
    if (parsed.hermes?.model !== undefined) {
      assertModelGranted(agent.provider, parsed.hermes.model, fleet);
    }
    if (parsed.hermes !== undefined) patch["hermes"] = hermesPatch;

    /**
     * §8.3: a provider change is *staged*, not applied.
     *
     * Everything else `set` writes takes effect the next time the box applies
     * anything, and until then the row and the box simply disagree about a
     * setting. A provider change cannot work that way: it needs a credential
     * copied into a slot the running configuration does not name, and it needs
     * the box to be told to restart Hermes. So `set` writes the intention onto
     * `pending` and `apply` (the rollout §6.5 already has) is what performs it.
     *
     * `--provider` is treated as `--provider-profile` would be — it resolves to
     * the fleet's designated profile for that provider — because a row that
     * carried a provider with another provider's credential slot beside it
     * would be a configuration nothing can render.
     */
    const { settings } = settingsOf(fleet);
    if (stagesProfileChange(parsed)) {
      const pending = stageProfileChange(settings, agent, parsed, {
        staged_at: nowIso(),
        staged_by: await actor(),
      });
      const profile = settings.profiles?.[pending.profile_id];
      if (profile === undefined) {
        throw new HermeticError("NOT_FOUND", `no provider profile ${pending.profile_id}`, {
          profile: pending.profile_id,
        });
      }
      await assertProfileUsable(bindingPorts, profile);
      assertModelGranted(pending.provider, pending.model, fleet);
      /**
       * Asked here rather than only at apply: a binding onto a revision slot is
       * a document an older hermeticd refuses, and an operator who learns that
       * from `apply` has already been told `set` succeeded. Same refusal, same
       * code — `HERMETICD_UNAVAILABLE` — one command earlier.
       */
      await assertCanApply(pendingApplied({ ...agent, pending }), fleet);
      patch["pending"] = pending;
    } else if (parsed.model !== undefined) {
      const staged = agent.pending;
      if (staged !== null && staged !== undefined) {
        /**
         * §8.3: with a change staged, `pending.model` is what will land.
         *
         * Writing `hermes.model` here instead would be silently undone —
         * `applyPendingPatch` overwrites `hermes.model` with `pending.model`
         * when the rollout applies — so the operator would see the model they
         * asked for on every reading of the row until the apply reverted it.
         * The model they named is patched onto the staged binding, which is the
         * thing that takes effect.
         */
        assertModelGranted(staged.provider, parsed.model, fleet);
        patch["pending"] = { ...staged, model: parsed.model };
      } else {
        // No profile change and nothing staged: the model is the ordinary
        // managed Hermes setting it has always been, merged onto the row.
        //
        // Granted first, exactly as the two branches above do. A Bedrock agent
        // moved onto a model outside the fleet's grant would boot and then fail
        // every turn with `AccessDeniedException` — and the refusal has to be
        // here rather than only at the apply, because this branch *is* the
        // apply: nothing is staged, so the row write below is what takes effect.
        assertModelGranted(agent.provider, parsed.model, fleet);
        patch["hermes"] = { ...hermesPatch, model: parsed.model };
      }
    }
    if (parsed.size !== undefined) {
      patch["size"] = parsed.size;
      patch["instance_type"] = parsed.instance_type ?? SIZES[parsed.size].instance_type;
    } else if (parsed.instance_type !== undefined) {
      patch["instance_type"] = parsed.instance_type;
    }
    // Recreate-only, like `size` and `instance_type` beside it: the root disk is
    // a property of an instance, and the running one already has the disk it
    // booted with (§7.1). A `rerun` will not move it.
    if (parsed.root_gib !== undefined) patch["root_gib"] = parsed.root_gib;
    if (Object.keys(patch).length === 0) {
      throw new HermeticError("UNSUPPORTED", "nothing to set", { name: parsed.name });
    }

    let next = await agents.update(agent.name, agent.version, patch);

    /**
     * Re-render and re-upload, the same way `upgrade` does, so the row's
     * `config_key` names a tarball that matches the row.
     *
     * Without this the change is real on the row and invisible to the box until
     * something else happens to re-render: `agent rerun` fetches whatever
     * `config_key` already pointed at, which would be the config from before
     * the change. It does not make the change take effect on its own — that
     * still needs an apply, which is what `rerun` and `recreate` are — but it
     * means both of them now carry it.
     */
    const rendered = await ensureConfig(next, fleet);
    if (next.config_hash !== rendered.config_hash) {
      next = await agents.update(next.name, next.version, {
        config_hash: rendered.config_hash,
        resources: { ...next.resources, config_key: rendered.key },
      });
    }

    const staged = describePending(next);
    await appendEvent(
      agent.name,
      "set",
      `${Object.keys(patch).sort().join(", ")} changed; config ${rendered.config_hash} uploaded — it takes effect on the next rerun or recreate` +
        (staged === null ? "" : `; staged for apply: ${staged}`),
    );
    return view(next, settings);
  }

  return { set };
}
