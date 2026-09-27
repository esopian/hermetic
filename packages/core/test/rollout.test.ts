/**
 * §6.5's converge, from the laptop: `plan.rollout` and the `apply` that runs it.
 *
 * The properties worth holding are all about *restraint*. A plan must write
 * nothing. An apply must converge the agents the plan named and no others, one
 * at a time, and must not let one box's silence stop the fleet. And a box that
 * never reports the config it was asked for must be reported as unconverged —
 * never as done, because a rollout that counts an unreachable box as finished is
 * worse than one that cannot reach it.
 */
import { describe, expect, test } from "bun:test";
import { FIXTURE_CONFIG, MemoryBackend, seedFixtureFleet } from "../src/backend/memory.ts";
import { agentParamPath } from "../src/backend/constants.ts";
import { HermeticError } from "../src/errors.ts";
import { pendingApplied } from "../src/profiles/profile-binding.ts";
import { drain, testHermetic } from "./helpers.ts";
import type { Agent, OpEvent } from "../src/schema/index.ts";

// The fixture directory is process-global; each file says which account it is in.
/** A fixture fleet whose boxes all report the config the row names — nothing to do. */
function fleet(options: { convergeTimeoutMs?: number } = {}) {
  const backend = seedFixtureFleet(new MemoryBackend({ directory: "seeded" }));
  const hermetic = testHermetic({
    backend,
    config: FIXTURE_CONFIG,
    rollout: { convergeTimeoutMs: options.convergeTimeoutMs ?? 50, convergePollMs: 1 },
  });
  return { backend, hermetic };
}

/** Make an agent look like a box that has fallen behind its row. */
function behind(backend: MemoryBackend, name: string): Agent {
  const row = backend.agents.get(name)!;
  const next = { ...row, applied_config_hash: "0000000000000000" } as Agent;
  backend.agents.set(name, next);
  return next;
}

const messages = (events: OpEvent[]): string => events.map((e) => e.message).join("\n");

describe("plan.rollout", () => {
  test("it writes nothing: no row moves, no object is uploaded", async () => {
    const { backend, hermetic } = fleet();
    behind(backend, "atlas");
    const before = backend.mutations.length;
    const objects = backend.objects.size;

    const plan = await hermetic.plan.rollout({});

    expect(plan.kind).toBe("rollout");
    expect(backend.mutations.length).toBe(before);
    expect(backend.objects.size).toBe(objects);
  });

  /**
   * Every agent gets a step, including the ones that will be skipped: "which
   * boxes will this touch" is the question the plan exists to answer, and an
   * agent silently missing from the list answers it wrongly.
   */
  test("every agent is accounted for, converging or skipped with a reason", async () => {
    const { backend, hermetic } = fleet();
    behind(backend, "atlas");

    const plan = await hermetic.plan.rollout({});
    const ids = plan.steps.map((s) => s.id);

    expect(ids).toContain("atlas");
    expect(ids.length).toBe([...backend.agents.keys()].filter((n) => n !== "_fleet").length);
    const atlas = plan.steps.find((s) => s.id === "atlas")!;
    expect(atlas.description).toContain("apply");
    // A converge deletes nothing; the confirmation is about blast radius.
    expect(plan.steps.every((s) => !s.destructive)).toBe(true);
    // A destroyed agent has no box, and says so rather than being dropped.
    const destroyed = plan.steps.find((s) => s.description.includes("destroyed"));
    expect(destroyed?.description).toContain("skipped");
  });

  test("--agent narrows it, and an unknown name is refused rather than ignored", async () => {
    const { backend, hermetic } = fleet();
    behind(backend, "atlas");

    const plan = await hermetic.plan.rollout({ agents: ["atlas"] });
    expect(plan.steps.map((s) => s.id)).toEqual(["atlas"]);
    // Carried as data so `apply` executes the plan that was read, not a wider one.
    expect(plan.options.rollout_agents).toEqual(["atlas"]);

    await expect(hermetic.plan.rollout({ agents: ["nobody"] })).rejects.toThrow(/no such agent/);
  });

  /**
   * §8.3: the hash a staged row will reach is the one its *pending* binding
   * renders. `apply` rewrites the binding and renders afterwards, so a plan
   * that rendered the row as it stands would name a hash the apply never
   * produces — the plan being wrong about the only number it exists to state,
   * and an operator comparing the two afterwards seeing drift that is not
   * there.
   */
  test("a staged row's plan names the hash the apply actually records", async () => {
    const { backend, hermetic } = fleet();
    const before = backend.agents.get("corvid")!;
    expect(before.pending).toBeTruthy();

    const plan = await hermetic.plan.rollout({ agents: ["corvid"] });
    const promised = /apply ([0-9a-f]+)/.exec(plan.steps[0]!.description)?.[1];
    expect(promised).toBeTruthy();
    // Not the hash the row carries today: the binding is about to move.
    expect(promised).not.toBe(before.config_hash);

    await drain(hermetic.apply({ plan, yes: true }));

    const after = backend.agents.get("corvid")!;
    expect(after.config_hash).toBe(promised);
    expect(after.apply_request?.config_hash).toBe(promised);
  });

  test("a fleet that is already current says so instead of promising work", async () => {
    const { backend, hermetic } = fleet();
    // "Current" means running the hash *this build renders*, not whatever the
    // row happened to be stamped with — so the plan itself is what says which.
    const first = await hermetic.plan.rollout({});
    for (const step of first.steps) {
      const row = backend.agents.get(step.id);
      if (!row) continue;
      const to = /apply ([0-9a-f]+)/.exec(step.description)?.[1];
      if (to) {
        // `pending` too: §8.3 counts a staged provider change as work even when
        // the hashes agree, because the apply is what performs it — so a fleet
        // that is "already current" has nothing staged either. The staged
        // binding is *applied* to the row rather than merely dropped: the hash
        // the plan named is the one the new binding renders, so a row that
        // claimed that hash while still carrying the old binding would be a
        // fleet lying about itself rather than one that is up to date.
        backend.agents.set(step.id, {
          ...pendingApplied(row),
          config_hash: to,
          applied_config_hash: to,
        } as Agent);
      }
    }

    const plan = await hermetic.plan.rollout({});
    expect(plan.warnings.join(" ")).toContain("nothing to converge");
  });
});

describe("applying a rollout plan", () => {
  test("it asks the box, waits for the box's own account, and reports it done", async () => {
    const { backend, hermetic } = fleet();
    behind(backend, "atlas");
    // The box answers as soon as it is asked.
    const original = backend.agents.set.bind(backend.agents);
    backend.agents.set = ((name: string, row: Agent) => {
      const applied =
        row.apply_request && row.applied_config_hash !== row.config_hash
          ? ({ ...row, applied_config_hash: row.config_hash } as Agent)
          : row;
      return original(name, applied);
    }) as typeof backend.agents.set;

    const plan = await hermetic.plan.rollout({ agents: ["atlas"] });
    const events = await drain(hermetic.apply({ plan, yes: true }));

    const row = backend.agents.get("atlas")!;
    expect(row.apply_request?.config_hash).toBe(row.config_hash ?? "");
    expect(messages(events)).toContain("atlas asked to apply");
    expect(messages(events)).toContain("atlas is running");
    expect(messages(events)).toContain("1 converged");
  });

  /**
   * The honest failure. A box that never reports the config — because its
   * hermeticd predates converge support, or because it is wedged — is reported
   * as unconverged, the request stays on its row, and the op still finishes so
   * the rest of the fleet is not held hostage.
   */
  test("a box that never reports is unconverged, not done", async () => {
    const { backend, hermetic } = fleet({ convergeTimeoutMs: 5 });
    behind(backend, "atlas");

    const plan = await hermetic.plan.rollout({ agents: ["atlas"] });
    const events = await drain(hermetic.apply({ plan, yes: true }));

    const said = messages(events);
    expect(said).toContain("has not reported config");
    expect(said).toContain("hermetic artifacts push");
    expect(said).toContain("1 unconverged");
    // The request stays: the box may still take it.
    expect(backend.agents.get("atlas")?.apply_request).toBeTruthy();
    // And the op ends `warn`, not thrown — the fleet is not held hostage.
    expect(events.at(-1)?.level).toBe("warn");
  });

  test("it converges only the agents the plan named", async () => {
    const { backend, hermetic } = fleet({ convergeTimeoutMs: 5 });
    behind(backend, "atlas");
    behind(backend, "lumen");

    const plan = await hermetic.plan.rollout({ agents: ["atlas"] });
    await drain(hermetic.apply({ plan, yes: true }));

    expect(backend.agents.get("atlas")?.apply_request).toBeTruthy();
    expect(backend.agents.get("lumen")?.apply_request ?? null).toBeNull();
  });

  test("an agent that cannot apply is skipped with its reason, and the run goes on", async () => {
    const { backend, hermetic } = fleet({ convergeTimeoutMs: 5 });
    const stopped = backend.agents.get("atlas")!;
    backend.agents.set("atlas", { ...stopped, status: "stopped" } as Agent);
    behind(backend, "lumen");

    const plan = await hermetic.plan.rollout({ agents: ["atlas", "lumen"] });
    const events = await drain(hermetic.apply({ plan, yes: true }));

    expect(messages(events)).toContain("atlas skipped — stopped");
    expect(backend.agents.get("atlas")?.apply_request ?? null).toBeNull();
    // …and the agent after it was still asked.
    expect(backend.agents.get("lumen")?.apply_request).toBeTruthy();
  });

  test("the lock is released before the wait, so nobody is blocked behind a slow box", async () => {
    const { backend, hermetic } = fleet({ convergeTimeoutMs: 5 });
    behind(backend, "atlas");

    const plan = await hermetic.plan.rollout({ agents: ["atlas"] });
    await drain(hermetic.apply({ plan, yes: true }));

    expect(backend.agents.get("atlas")?.lock ?? null).toBeNull();
  });
});

/**
 * §8.3: `apply` is what performs a staged provider change, so what it does with
 * one when it cannot finish is the whole of the crash-safety story.
 *
 * `corvid` is the fixture's staged row: running on `openrouter-cheap`, staged
 * onto `anthropic-main`, waiting for an apply. The rule is that the *row write*
 * is the commit point — it moves the binding and clears `pending` in one
 * conditional update — so everything that can fail before it leaves the agent
 * running exactly what it was running, with the change still staged for the next
 * attempt. Half-performing it would be the bad outcome: a row claiming a binding
 * whose credential was never written is an agent nobody can explain.
 */
describe("a staged provider change, and the applies that cannot finish it", () => {
  /** The fixture's staged row, as it stands before anything is applied. */
  function staged(backend: MemoryBackend): Agent {
    const row = backend.agents.get("corvid")!;
    expect(row.pending).toBeTruthy();
    expect(row.provider).toBe("openrouter");
    return row;
  }

  /**
   * A box that is not up cannot apply anything, so the rollout defers it before
   * it touches a credential — and the plan says so in as many words, because
   * "my staged change is still there" is the question an operator asks after a
   * converge that skipped their agent.
   */
  test("a box that is not up keeps its staged change, and the plan says it stays", async () => {
    const { backend, hermetic } = fleet({ convergeTimeoutMs: 5 });
    const before = staged(backend);
    backend.agents.set("corvid", { ...before, status: "stopped" } as Agent);

    const plan = await hermetic.plan.rollout({ agents: ["corvid"] });
    expect(plan.steps[0]!.description).toContain("stays staged");
    backend.resetMutations();
    const events = await drain(hermetic.apply({ plan, yes: true }));

    expect(messages(events)).toContain("corvid skipped — stopped");
    const after = backend.agents.get("corvid")!;
    expect(after.pending).toEqual(before.pending);
    // The running binding is untouched, and no credential was copied: a skip
    // that had already written the new slot would leave a key in SSM for a
    // binding the row never took.
    expect(after.provider).toBe("openrouter");
    expect(after.profile_id).toBe(before.profile_id);
    expect(after.apply_request ?? null).toBeNull();
    expect(backend.mutations).not.toContain("secrets.put");
  });

  /**
   * The credential write is the step before the commit point. A `PutParameter`
   * that fails takes the op down naming the slot it could not fill, and the row
   * is exactly as it was — still on the old binding, still staged.
   */
  test("a credential that cannot be written leaves the change staged and the binding alone", async () => {
    const { backend, hermetic } = fleet({ convergeTimeoutMs: 5 });
    const before = staged(backend);
    backend.secrets.put = async () => {
      throw new HermeticError("INTERNAL", "PutParameter was throttled", {});
    };

    const plan = await hermetic.plan.rollout({ agents: ["corvid"] });
    await expect(drain(hermetic.apply({ plan, yes: true }))).rejects.toThrow(
      /binding is unchanged.*throttled/s,
    );

    const after = backend.agents.get("corvid")!;
    expect(after.pending).toEqual(before.pending);
    expect(after.provider).toBe("openrouter");
    expect(after.credential_ref).toBe(before.credential_ref);
    expect(after.apply_request ?? null).toBeNull();
    // …and the lock is not left behind on a row somebody else may need.
    expect(after.lock ?? null).toBeNull();
  });

  /**
   * The other side of the same line, stated so it cannot drift by accident: once
   * the row write lands, the change **is** performed, even though the box has
   * not confirmed anything. The binding is the fleet's record of what the agent
   * should be running; the box catching up is what `apply_request` and the
   * unconverged report are for. Keeping `pending` here instead would mean a
   * second apply re-performing a change that already happened.
   */
  test("a box that never answers still has its binding moved, and is reported unconverged", async () => {
    const { backend, hermetic } = fleet({ convergeTimeoutMs: 5 });
    const before = staged(backend);

    const plan = await hermetic.plan.rollout({ agents: ["corvid"] });
    const events = await drain(hermetic.apply({ plan, yes: true }));

    const after = backend.agents.get("corvid")!;
    expect(after.pending ?? null).toBeNull();
    expect(after.provider).toBe("anthropic");
    expect(after.profile_id).toBe(before.pending!.profile_id);
    expect(after.hermes?.model).toBe(before.pending!.model);
    // Said out loud on the way past, and written to the agent's own log.
    expect(messages(events)).toContain("corvid: openrouter/");
    // The box never reported it: not done, and the request stays for it.
    expect(messages(events)).toContain("has not reported config");
    expect(messages(events)).toContain("1 unconverged");
    expect(after.apply_request?.config_hash).toBe(after.config_hash ?? "");
  });
});

/**
 * The other half of the capability contract (§6.3). `assertCapable` on the box
 * refuses a config it cannot apply — which is the right answer for a running
 * agent and no answer at all for `agent create`, where by the time a box exists
 * to refuse, an instance is running and billing. So the laptop asks the same
 * question of the release the fleet *publishes*, before it renders anything.
 */
describe("a config the fleet's published release could not apply", () => {
  async function publish(capabilities: string[] | undefined) {
    const backend = seedFixtureFleet(new MemoryBackend({ directory: "seeded" }));
    const hermetic = testHermetic({
      backend,
      config: FIXTURE_CONFIG,
      rollout: { convergeTimeoutMs: 5, convergePollMs: 1 },
    });
    const manifest = JSON.parse(new TextDecoder().decode(backend.objects.get("manifest.json")!)) as {
      hermeticd: Record<string, unknown>;
    };
    manifest.hermeticd = {
      ...manifest.hermeticd,
      ...(capabilities === undefined ? {} : { capabilities }),
    };
    backend.objects.set("manifest.json", new TextEncoder().encode(JSON.stringify(manifest)));
    return { backend, hermetic };
  }

  test("is refused before anything is rendered, naming the fix", async () => {
    const { hermetic } = await publish(["restart-units"]);

    await expect(hermetic.agents.set({ name: "atlas", size: "large" })).rejects.toThrow(
      /gateway-unit.*does not implement.*artifacts push/s,
    );
  });

  test("a release that implements everything is not refused", async () => {
    // `atlas` is a browser agent in the fixture, so the document it renders
    // also asks for the browser stack — "everything" is every capability this
    // agent's configuration names, not a fixed pair.
    const { hermetic } = await publish(["gateway-unit", "restart-units", "browser-stack"]);
    await expect(hermetic.agents.set({ name: "atlas", size: "large" })).resolves.toBeTruthy();
  });

  /**
   * A manifest written before the field says nothing about what its binary can
   * do, and "says nothing" must not read as "implements nothing" — that would
   * refuse every fleet that has not been re-pushed since this landed. The box's
   * own refusal and the build-drift warning still cover it.
   */
  test("a release that cannot say is not treated as a release that cannot do", async () => {
    const { hermetic } = await publish(undefined);
    await expect(hermetic.agents.set({ name: "atlas", size: "large" })).resolves.toBeTruthy();
  });

  /**
   * §8.3's slot family is the same contract one command earlier. A binding onto
   * `provider-key-<profile_id>-r<N>` is a document only a release implementing
   * `provider-key-ref` can apply, and the operator has to learn that at `set` —
   * the command they ran — rather than from an apply that has already told them
   * the change was saved.
   */
  test("staging a binding onto a revision slot is refused at `set`, and stages nothing", async () => {
    const { backend, hermetic } = await publish(["gateway-unit", "restart-units"]);
    const before = backend.agents.get("kestrel")!;

    await expect(hermetic.agents.set({ name: "kestrel", refresh_profile: true })).rejects.toThrow(
      /provider-key-ref.*does not implement.*artifacts push/s,
    );

    const after = backend.agents.get("kestrel")!;
    expect(after.pending ?? null).toBeNull();
    expect(after.version).toBe(before.version);
  });

  /**
   * And the apply's half. The refusal has to come *before* `applyPending`,
   * which is the commit point: it copies the credential, rewrites the binding
   * and clears `pending` in one write, so a render that refused afterwards
   * would leave the row bound to a slot no box in this fleet reads, with
   * nothing staged to retry.
   */
  test("an apply onto a slot the published release cannot read leaves the row untouched", async () => {
    const { backend, hermetic } = await publish(["gateway-unit", "restart-units"]);
    const before = backend.agents.get("corvid")!;
    expect(before.pending).toBeTruthy();
    // The plan is computed against the fleet as it was published; the refusal
    // belongs to the apply, which is what would write.
    const plan = await hermetic.plan.rollout({ agents: ["corvid"] });

    await expect(drain(hermetic.apply({ plan, yes: true }))).rejects.toThrow(
      /provider-key-ref.*does not implement/s,
    );

    const after = backend.agents.get("corvid")!;
    expect(after.pending).toEqual(before.pending);
    expect(after.provider).toBe(before.provider);
    expect(after.profile_id).toBe(before.profile_id);
    expect(after.credential_ref).toBe(before.credential_ref);
    expect(after.hermes?.model).toBe(before.hermes?.model);
    // The row moved only by the lock it took and gave back; nothing of the
    // binding was written.
    expect(after.config_hash).toBe(before.config_hash);
  });

  /**
   * And `recreate`'s half, which consumes a staged change for the same reason a
   * rollout does — a rebuild is a fresh boot into a fresh configuration, so it
   * must not boot the replacement onto the binding the operator has moved off.
   *
   * It therefore needs the same guard in the same place. Without it the
   * sequence is `applyPending` and only then `ensureConfig`, so a fleet whose
   * published hermeticd cannot read a revision slot would have the credential
   * copied, the binding rewritten and `pending` cleared, and *then* be told the
   * document cannot be applied — mid-recreate, with the old instance already
   * gone and nothing staged to retry.
   */
  test("a recreate onto a slot the published release cannot read leaves the binding staged", async () => {
    const { backend, hermetic } = await publish(["gateway-unit", "restart-units"]);
    const before = backend.agents.get("corvid")!;
    expect(before.pending).toBeTruthy();

    await expect(drain(hermetic.agents.recreate({ name: "corvid", yes: true }))).rejects.toThrow(
      /provider-key-ref.*does not implement/s,
    );

    const after = backend.agents.get("corvid")!;
    expect(after.pending).toEqual(before.pending);
    expect(after.provider).toBe(before.provider);
    expect(after.profile_id).toBe(before.profile_id);
    expect(after.credential_ref).toBe(before.credential_ref);
    expect(after.hermes?.model).toBe(before.hermes?.model);
    // The staged slot was never filled: the refusal comes before the copy, so
    // there is no half-performed change to reason about on the next attempt.
    expect(
      backend.params.has(
        agentParamPath(FIXTURE_CONFIG.fleet_id, "corvid", before.pending!.credential_ref!),
      ),
    ).toBe(false);
  });
});
