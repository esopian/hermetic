/**
 * `plan.foundation` (§3.2 rule 3, §6.6): the dry run of `update`.
 */
import { FLEET_KEY, releaseKey } from "../../schema/index.ts";
import type { Plan, PlanStep } from "../../schema/index.ts";
import { readFleetManifest, releaseDrift } from "../../release/artifacts.ts";
import { isNoChanges, unsafeReplacements } from "../stack-change.ts";
import { migrationsBetween } from "../foundation-migrations.ts";
import { ROLLOUT_STATUSES, foundationHelpers, type FoundationCtx } from "./shared.ts";
import { BUILD_VERSIONS } from "../../build-versions.ts";
import type { createChangeSet } from "./change-set.ts";

/**
 * The foundation version whose template first gave a `nat` fleet's NAT instance
 * a stable Elastic IP. A fleet crossing into it swaps the appliance's
 * auto-assigned public address for the EIP, which `plan` warns about.
 */
const NAT_EIP_VERSION = 6;

export function createPlan(ctx: FoundationCtx, changeSet: ReturnType<typeof createChangeSet>) {
  const { deps, core, backend, hermeticdVersion, versionOf, lockIsLive, foundationVersion } = ctx;
  const { grantedNow, bedrockGrant, changeSetName, computeChangeSet } = changeSet;
  const { releaseVersions, newerError, blockingAgents } = foundationHelpers(ctx);

  // ─── plan.foundation ───────────────────────────────────────────────────────

  /**
   * The dry run (§3.2 rule 3). It does everything the update's first three
   * phases *read* — the guards, the agent scan, a real change set computed by
   * CloudFormation and then deleted — and nothing any of them write. Two change
   * sets per update (one for the plan, one for the run) is the price of showing
   * an operator the actual resource list rather than a guess at it.
   *
   * Refusals differ from the update's on purpose. `FOUNDATION_NEWER` throws,
   * because there is no plan to show for a tool that is behind its own fleet.
   * A live lock, a busy agent and an unsafe replacement are *warnings*: a plan
   * that refuses to describe itself while another operator is mid-update is a
   * plan that is useless exactly when it is wanted.
   */
  async function plan(
    _input: Record<string, never> = {},
    opts: { signal?: AbortSignal } = {},
  ): Promise<Plan> {
    const { config, fleet, stack } = await core.guardFleet();
    const from = versionOf(fleet);
    if (from > foundationVersion) throw newerError(fleet);

    const agents = (await backend.store.agents.scan()).filter((a) => a.status !== "destroyed");
    const warnings: string[] = [];
    if (lockIsLive(fleet)) {
      warnings.push(
        `a foundation update is already running (locked by ${fleet.lock?.owner ?? "another operator"} until ${fleet.lock?.expires}); this plan cannot be applied until it finishes`,
      );
    }
    for (const busy of blockingAgents(agents)) warnings.push(busy);

    const steps: PlanStep[] = [
      {
        id: "preflight",
        description: `take the ${FLEET_KEY} lock; every agent operation refuses with LOCKED while it is held`,
        destructive: false,
      },
      {
        id: "archive",
        description: `archive foundation v${from} — the fleet manifest, every config object, the ${FLEET_KEY} item, ${agents.length} agent row(s), their events and the SSM parameter names — to archive/foundation-v${from}/ (and the local archive), replacing the one previous archive`,
        destructive: false,
      },
    ];

    /**
     * §6.6: the half of a migration that has to run *before* CloudFormation is
     * asked for anything, listed where it happens. v3's is the parameter copy:
     * the same template narrows the agent role to the fleet-scoped prefix, so
     * the parameters have to be there first or there is a window in which the
     * role can read only an empty namespace.
     */
    const preStack = migrationsBetween(from, foundationVersion, deps.migrations).filter(
      (m) => m.before !== undefined,
    );
    if (preStack.length > 0) {
      // A required step is worth naming in the preview: it is the one kind of
      // step whose failure ends the update with nothing changed, which is a
      // different outcome to read than the warning an optional one produces.
      const requiredBefore = preStack.filter((m) => m.beforeRequired);
      steps.push({
        id: "pre-stack",
        description: `before the stack update, run ${preStack.length} pre-stack step(s): ${preStack
          .map((m) => `v${m.version} ${m.describe}`)
          .join("; ")}${
          requiredBefore.length === 0
            ? ""
            : `; ${requiredBefore.map((m) => `v${m.version}`).join(", ")} must finish, and the stack is not changed if it does not`
        }`,
        destructive: false,
      });
    }

    /**
     * A real change set, computed by CloudFormation and deleted again, so the
     * step list is the resources that will actually change rather than a guess.
     * Creating and deleting one is idempotent and free of side effects on the
     * stack itself — a `plan foundation` that fails halfway and is retried
     * leaves nothing behind but the `finally` below, which deletes it either
     * way. That is why this stays a GET, like every other `plan.*`.
     */
    const name = changeSetName(foundationVersion);
    try {
      const info = await computeChangeSet(name, opts.signal);
      if (isNoChanges(info)) {
        steps.push({
          id: "stack",
          description: "the foundation stack is already at this template; no CloudFormation change",
          destructive: false,
        });
      } else if (info.status !== "CREATE_COMPLETE") {
        warnings.push(
          `CloudFormation could not compute a change set: ${info.statusReason ?? info.status}`,
        );
      } else {
        const unsafe = unsafeReplacements(info);
        steps.push({
          id: "stack",
          description: `update the foundation stack: ${info.changes
            .map(
              (c) =>
                `${c.action} ${c.logicalId} (${c.resourceType})${c.replacement === "True" ? " — REPLACEMENT" : ""}`,
            )
            .join(", ")}`,
          destructive: unsafe.length > 0,
        });
        if (unsafe.length > 0) {
          warnings.push(
            `the change set would REPLACE ${unsafe.join(", ")} — every row and object in them would be lost, so \`foundation update\` refuses it (FOUNDATION_UNSAFE) and there is no override`,
          );
        }
      }
    } finally {
      // Always, including on the way out of a failure: a change set the plan
      // created and did not delete is one an operator finds in the console
      // later with no idea who made it or whether it is safe to run.
      await backend.foundation.deleteChangeSet(name).catch(() => {});
    }

    /**
     * §8.3: what the update would do to the fleet's Bedrock grant, as its own
     * step. It is the one parameter an update restates, and a step list that
     * did not say so would leave "why did my IAM policy change" to the console.
     */
    /**
     * Both sides read the grant the same way (`grantedNow`). Taking `_fleet`'s
     * field alone here would make every pre-v10 fleet — which records nothing
     * there, and whose grant lives on the stack — look as though it granted
     * nothing, so the step would list every model the update *keeps* as a model
     * it adds.
     */
    const grantNow = await grantedNow(fleet);
    const grantNext = await bedrockGrant(fleet, grantNow);
    const grantAdds = grantNext.filter((id) => !grantNow.includes(id));
    steps.push({
      id: "bedrock-grant",
      description:
        grantAdds.length === 0
          ? `the fleet's Bedrock grant already covers every model its profiles and agents name (${String(grantNext.length)} model(s))`
          : `grant the agent role ${String(grantAdds.length)} further Bedrock model(s): ${grantAdds.join(", ")}`,
      destructive: false,
    });

    const keep = new Set([hermeticdVersion, fleet.min_hermetic_version]);
    const pruned = (await releaseVersions()).filter((v) => !keep.has(v));
    steps.push({
      id: "artifacts",
      description: `push hermeticd ${hermeticdVersion} to ${releaseKey(hermeticdVersion, "")}, keep ${[...keep].join(" and ")}, and delete ${pruned.length} older release directory(ies)${pruned.length > 0 ? `: ${pruned.join(", ")}` : ""}; mirror hermes ${BUILD_VERSIONS.hermes_ref}, keep it and every ref a live agent's configuration pins, and delete any other; then rewrite the fleet manifest`,
      destructive: pruned.length > 0,
    });

    const migrations = migrationsBetween(from, foundationVersion, deps.migrations);
    steps.push({
      id: "migrate",
      description:
        migrations.length === 0
          ? `no migrations between v${from} and v${foundationVersion}; stamp the ${FLEET_KEY} item`
          : `run ${migrations.length} migration(s): ${migrations.map((m) => `v${m.version} ${m.describe}`).join("; ")}; then stamp the ${FLEET_KEY} item`,
      destructive: false,
    });

    const targets = agents.filter((a) => ROLLOUT_STATUSES.includes(a.status) && a.instance_id);
    const deferred = agents.filter((a) => !targets.includes(a));
    steps.push({
      id: "rollout",
      description: `ask ${targets.length} agent(s) to take hermeticd ${hermeticdVersion} now${targets.length > 0 ? ` (${targets.map((a) => a.name).join(", ")})` : ""}; ${deferred.length} deferred to their next start-up or nightly check${deferred.length > 0 ? ` (${deferred.map((a) => a.name).join(", ")})` : ""}`,
      destructive: false,
    });

    /**
     * §5: the one-off egress-address change a `nat` fleet crossing into v6 pays.
     *
     * v6's template gives the NAT instance a stable Elastic IP (`NatEip` plus
     * `NatEipAssociation`). Associating an EIP with a running instance *replaces*
     * its auto-assigned public address, so the fleet's egress address changes the
     * moment the change set lands and every outbound connection open across it
     * is dropped once. Nothing is broken afterwards — the whole point of the EIP
     * is that the address stops moving — but an upstream that allow-lists the old
     * one starts refusing the fleet silently, which is not something to discover
     * after the fact.
     */
    if (stack.parameters["Network"] === "nat" && from < NAT_EIP_VERSION) {
      warnings.push(
        `this is a \`nat\` fleet on foundation v${from}, and v${NAT_EIP_VERSION} gives its NAT instance a stable Elastic IP: the fleet's egress address changes as the change set lands, and every outbound connection open across the NAT drops once. Nothing reconnects to the old address afterwards. Update any upstream allow-list to the new address, which the stack reports as its \`NatEgressIp\` output (\`hermetic network status\`) once the update finishes.`,
      );
    }

    warnings.push(
      `CloudFormation rolls a failed stack update back on its own, and the ${FLEET_KEY} stamp is the last write — a failure before it leaves the fleet exactly where it is, and the update re-runnable`,
    );

    /**
     * The release comparison the drawer's `hermeticd <from> → <to>` line cannot
     * make: both sides of that line come from `BUILD_VERSIONS.hermeticd`, so it
     * is a constant compared with itself and reads `0.5.0 → 0.5.0` however much
     * the binary changed. `build` is the fingerprint that can tell two
     * checkouts apart at the same version, and `releaseDrift` is the sentence.
     *
     * One `GetObject`, here and not in `foundation.status`: this function
     * already creates and deletes a real CloudFormation change set and lists
     * the bucket, while `status` is served on every `/api/meta`.
     *
     * Soft: a fleet with no published manifest (`--skip-artifacts`, an emptied
     * bucket) leaves every field null, which the heads render as unknown.
     */
    const publishedManifest = await readFleetManifest(backend.artifacts).catch(() => null);
    const localBuild = (deps.localBuild ?? core.localBuild)() ?? null;
    // No refusal here, only a reading: `plan` changes nothing, so a dirty tree
    // is something to *report* — the push it would lead to is where §3.6's rule
    // actually bites, and saying so here is how an operator finds out before
    // they click.
    const localGit = deps.git?.() ?? null;
    const release = {
      published_version: publishedManifest?.hermeticd.version ?? null,
      published_build: publishedManifest?.hermeticd.build ?? null,
      local_version: hermeticdVersion,
      local_build: localBuild,
      published_build_number: publishedManifest?.hermeticd.build_number ?? null,
      local_build_number: localGit?.build_number ?? null,
      published_commit: publishedManifest?.hermeticd.commit ?? null,
      local_commit: localGit?.commit ?? null,
      drift: releaseDrift(publishedManifest?.hermeticd ?? null, {
        version: hermeticdVersion,
        build: localBuild,
      }),
    };
    if (release.drift !== null) warnings.push(release.drift);

    return {
      kind: "foundation",
      target: `${stack.stack_name} · v${from} → v${foundationVersion}`,
      options: {},
      steps,
      warnings,
      release,
      summary: {
        account_id: config.account_id,
        region: config.region,
        fleet_id: config.fleet_id,
        stack_id: stack.stack_id,
      },
    };
  }

  return { plan };
}
