/**
 * §8.3's binding, end to end: staging a change onto a row, the optimistic lock
 * that keeps two operators from writing over each other, and the rotation that
 * has to travel all the way to a box.
 *
 * Both halves are about *one* write being the commit point.
 *
 * `agents.set` reads a row and writes it back under its version, so two people
 * staging different things at once is a race with exactly one winner — and the
 * loser has to be told, because a staging command that silently lost would
 * report "saved — pending apply" for a change nothing recorded.
 *
 * And a rotation only reaches a box through `config_hash`. The new key goes into
 * a slot the running configuration does not name, which is what makes the
 * rotation stageable; the manifest naming that slot is what carries it; and the
 * hash moving is the only thing a rollout can act on. If any link in that chain
 * did not move, the key would be in SSM, every laptop-side reading would say it
 * had landed, and the box would go on serving with the previous credential.
 */
import { describe, expect, test } from "bun:test";
import {
  FIXTURE_CONFIG,
  FIXTURE_PROFILE_IDS,
  MemoryBackend,
  seedFixtureFleet,
} from "../src/backend/memory.ts";
import { agentParamPath, sharedSecretPath } from "../src/backend/constants.ts";
import { profileSlotSlug } from "../src/schema/index.ts";
import type { Agent } from "../src/schema/index.ts";
import { type HermeticError, isHermeticError } from "../src/errors.ts";
import { drain, testHermetic } from "./helpers.ts";

// The fixture directory is process-global; each file says which account it is in.
/** A fixture value that is still obviously a fixture (§11.3, the leak grep). */
const ROTATED = "sk-ant-FIXTURE-ROTATED";

/**
 * The fixture's plainest bound row: `ready`, on `anthropic-main` at revision 1,
 * with nothing staged and a box that already reports the config the row names.
 * Everything a rotation moves on it is a thing this test moved.
 */
const BOUND = "kestrel";

function fleet() {
  const backend = seedFixtureFleet(new MemoryBackend({ directory: "seeded" }));
  const hermetic = testHermetic({
    backend,
    config: FIXTURE_CONFIG,
    // Milliseconds: no test waits on a box that is never going to answer.
    rollout: { convergeTimeoutMs: 5, convergePollMs: 1 },
  });
  return { backend, hermetic };
}

const agentSlot = (name: string, slot: string): string =>
  agentParamPath(FIXTURE_CONFIG.fleet_id, name, slot);

function codeOf(e: unknown): string | null {
  return isHermeticError(e) ? e.code : null;
}

describe("two operators writing the same row", () => {
  /**
   * The genuine race: both calls read the row, both compose a patch against the
   * version they read, and the store admits one. The other is `CONFLICT` — the
   * same code every optimistic-lock failure in the backend reports — rather than
   * a silent overwrite of whatever the winner just staged.
   */
  test("two concurrent sets: one lands, the loser is CONFLICT", async () => {
    const { backend, hermetic } = fleet();
    const before = (await backend.store.agents.get("fathom"))!;

    const results = await Promise.allSettled([
      hermetic.agents.set({ name: "fathom", provider_profile: "openrouter-cheap" }),
      hermetic.agents.set({ name: "fathom", provider_profile: "anthropic-main" }),
    ]);

    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(codeOf((lost[0] as PromiseRejectedResult).reason)).toBe("CONFLICT");

    // Exactly one staged change is on the row, and it is the winner's — not a
    // blend of the two, and not the loser's written over the top.
    const after = (await backend.store.agents.get("fathom"))!;
    const winner = (won[0] as PromiseFulfilledResult<{ pending?: unknown }>).value;
    expect(after.pending).toEqual(winner.pending as Agent["pending"]);
    expect(after.version).toBeGreaterThan(before.version);
  });

  /**
   * The same failure stated deterministically, because a concurrency test that
   * happens to interleave one way today is not a contract. Somebody else's write
   * lands between this operation's read and its write; the store refuses the
   * stale version and says what it found.
   */
  test("a row that moved between the read and the write is refused, naming both versions", async () => {
    const { backend, hermetic } = fleet();
    const update = backend.store.agents.update.bind(backend.store.agents);
    let raced = false;
    backend.store.agents.update = async (name, version, patch) => {
      if (!raced) {
        raced = true;
        // Another operator, landing in the gap.
        const row = backend.agents.get(name)!;
        backend.agents.set(name, { ...row, version: row.version + 1 } as Agent);
      }
      return update(name, version, patch);
    };

    let error: HermeticError | null = null;
    try {
      await hermetic.agents.set({ name: "fathom", provider_profile: "openrouter-cheap" });
    } catch (e) {
      error = e as HermeticError;
    }

    expect(error?.code).toBe("CONFLICT");
    expect(error?.message).toContain("changed underneath this operation");
    // Nothing of this operation's is on the row: the CAS write is all or nothing.
    expect((await backend.store.agents.get("fathom"))!.pending ?? null).toBeNull();
  });

  /**
   * And the apply's half of it. The row write is what performs a staged change,
   * so losing the race there means the change is *still staged* rather than
   * half-performed — the outcome `applyPending`'s ordering exists to guarantee.
   */
  test("an apply that loses the race leaves the change staged rather than half-performed", async () => {
    const { backend, hermetic } = fleet();
    const before = backend.agents.get("corvid")!;
    expect(before.pending).toBeTruthy();

    const update = backend.store.agents.update.bind(backend.store.agents);
    backend.store.agents.update = async (name, version, patch) => {
      if (name === "corvid" && "pending" in patch) {
        const row = backend.agents.get(name)!;
        backend.agents.set(name, { ...row, version: row.version + 1 } as Agent);
      }
      return update(name, version, patch);
    };

    const plan = await hermetic.plan.rollout({ agents: ["corvid"] });
    await expect(drain(hermetic.apply({ plan, yes: true }))).rejects.toThrow(/changed underneath/);

    const after = backend.agents.get("corvid")!;
    expect(after.pending).toEqual(before.pending);
    expect(after.provider).toBe("openrouter");
    expect(after.credential_ref).toBe(before.credential_ref);
  });
});

describe("rotating a profile's key reaches the box", () => {
  /**
   * The whole chain, in the order an operator walks it: rotate, refresh, apply.
   * Every step is asserted for the thing that has to move *and* the thing that
   * must not, because the failure this guards against is a rotation that looks
   * complete from the laptop and never arrives.
   */
  test("rotate → refresh → apply moves the slot, the key and the hash", async () => {
    const { backend, hermetic } = fleet();
    const before = (await backend.store.agents.get(BOUND))!;
    expect(before.profile_revision).toBe(1);
    expect(before.credential_ref).toBe("provider-key-ant00001-r1");

    // ── rotate ────────────────────────────────────────────────────────────
    // Every change bumps the revision, a key rotation included: an agent pinned
    // to revision N is stale the moment anything about the profile moves.
    await hermetic.providers.update({ profile: "anthropic-main", api_key: ROTATED });
    const { profiles } = await hermetic.providers.list();
    expect(profiles.find((p) => p.id === FIXTURE_PROFILE_IDS.anthropic)?.revision).toBe(2);
    // The agent has not moved: a rotation must not change anything underneath a
    // box that is still serving.
    const unmoved = (await backend.store.agents.get(BOUND))!;
    expect(unmoved.credential_ref).toBe("provider-key-ant00001-r1");
    expect(unmoved.config_hash).toBe(before.config_hash);

    // ── refresh ───────────────────────────────────────────────────────────
    const staged = await hermetic.agents.set({ name: BOUND, refresh_profile: true });
    expect(staged.pending).toMatchObject({
      profile_id: FIXTURE_PROFILE_IDS.anthropic,
      profile_revision: 2,
      credential_ref: "provider-key-ant00001-r2",
    });
    // Staging still changes nothing the *binding* says: the running
    // configuration names the old slot, and the new slot has not even been
    // written yet. (`set` does re-render, because it also re-uploads the bundle
    // the row names — but it renders the binding the row still holds.)
    const onRow = (await backend.store.agents.get(BOUND))!;
    expect(onRow.credential_ref).toBe("provider-key-ant00001-r1");
    expect(backend.params.has(agentSlot(BOUND, "provider-key-ant00001-r2"))).toBe(false);
    // The document the box is still being asked to run, rendered by this build.
    const stagedHash = onRow.config_hash!;

    // ── apply ─────────────────────────────────────────────────────────────
    const plan = await hermetic.plan.rollout({ agents: [BOUND] });
    await drain(hermetic.apply({ plan, yes: true }));
    const after = (await backend.store.agents.get(BOUND))!;

    expect(after.pending ?? null).toBeNull();
    expect(after.profile_revision).toBe(2);
    expect(after.credential_ref).toBe("provider-key-ant00001-r2");
    // The hash moved, which is the *only* thing a rollout can act on — and the
    // uploaded bundle is the one the row now names. Compared against the
    // staged-but-unapplied render rather than the seeded stand-in, so the
    // difference is the slot and nothing else.
    expect(after.config_hash).not.toBe(stagedHash);
    expect(after.resources.config_key).toBe(`config/${BOUND}/${after.config_hash}.tgz`);
    expect(after.apply_request?.config_hash).toBe(after.config_hash ?? "");
    expect([...backend.objects.keys()]).toContain(after.resources.config_key!);
  });

  /**
   * The credential itself, without naming it. The new slot holds what the
   * profile's shared slot holds — a copy made on the laptop, with the
   * operator's credentials, because the instance role cannot read `/hermetic/*`
   * at all — and the previous slot is still there, because an agent rolled back
   * to its old binding must still find the credential that binding ran on.
   */
  test("the new slot is a copy of the profile's, and the old slot is kept", async () => {
    const { backend, hermetic } = fleet();
    const shared = sharedSecretPath(
      FIXTURE_CONFIG.fleet_id,
      profileSlotSlug(FIXTURE_PROFILE_IDS.anthropic),
    );
    const wasBound = backend.params.get(agentSlot(BOUND, "provider-key-ant00001-r1"));
    expect(wasBound).toBeDefined();

    await hermetic.providers.update({ profile: "anthropic-main", api_key: ROTATED });
    await hermetic.agents.set({ name: BOUND, refresh_profile: true });
    await drain(hermetic.apply({ plan: await hermetic.plan.rollout({ agents: [BOUND] }), yes: true }));

    expect(backend.params.get(agentSlot(BOUND, "provider-key-ant00001-r2"))).toBe(
      backend.params.get(shared),
    );
    // The rotation really did change the value, rather than re-copying the old
    // one into a differently named slot.
    expect(backend.params.get(agentSlot(BOUND, "provider-key-ant00001-r2"))).not.toBe(wasBound);
    // And nothing swept the previous revision: only `destroy` does that (§8.3).
    expect(backend.params.get(agentSlot(BOUND, "provider-key-ant00001-r1"))).toBe(wasBound);
    // The row records both slots it owns, so a teardown can account for them.
    expect((await backend.store.agents.get(BOUND))!.resources.ssm_paths).toContain(
      agentSlot(BOUND, "provider-key-ant00001-r2"),
    );
  });

  /**
   * A second apply with nothing staged must not move the hash again. A rotation
   * that re-rendered on every converge would report drift on a fleet nobody had
   * changed, which is the noise that makes a real drift unreadable.
   */
  test("a second apply with nothing staged renders the same document", async () => {
    const { backend, hermetic } = fleet();
    await hermetic.providers.update({ profile: "anthropic-main", api_key: ROTATED });
    await hermetic.agents.set({ name: BOUND, refresh_profile: true });
    await drain(hermetic.apply({ plan: await hermetic.plan.rollout({ agents: [BOUND] }), yes: true }));
    const settled = (await backend.store.agents.get(BOUND))!.config_hash;

    await drain(hermetic.apply({ plan: await hermetic.plan.rollout({ agents: [BOUND] }), yes: true }));

    expect((await backend.store.agents.get(BOUND))!.config_hash).toBe(settled);
  });
});

/**
 * §8.3's two ways to say "model" — the row's managed Hermes setting, and the
 * model a staged binding will land with — and the rows that predate profiles
 * altogether.
 *
 * Both tests here are about a value the operator chose being *kept*. A model
 * hermetic replaces with a profile's, or writes somewhere the next apply will
 * overwrite, is the same failure seen from two ends: the agent runs a model
 * nobody asked for, and every laptop-side reading says otherwise until it does.
 */
describe("the model an operator pinned", () => {
  /** A row as it was written before profiles existed: no binding, a pinned model. */
  function legacyRow(backend: MemoryBackend, name: string, model: string): Agent {
    const row = backend.agents.get(name)!;
    const legacy = {
      ...row,
      provider: "anthropic",
      hermes: { ...(row.hermes ?? {}), model },
      pending: null,
    } as Agent;
    delete (legacy as { profile_id?: string }).profile_id;
    delete (legacy as { profile_revision?: number }).profile_revision;
    delete (legacy as { credential_ref?: string | null }).credential_ref;
    backend.agents.set(name, legacy);
    return legacy;
  }

  /**
   * A refresh is how a rotated key reaches an agent, and it must not undo a
   * model the operator chose. A legacy row has no `profile_id` at all, so the
   * profile it is refreshed against — the fleet's designation for its provider —
   * compares as a *different* profile and reads as a switch unless the refresh
   * itself says otherwise.
   */
  test("a legacy row refreshed keeps the model it pinned, not the profile's", async () => {
    const { backend, hermetic } = fleet();
    legacyRow(backend, "fathom", "claude-opus-4-1-FIXTURE");

    const staged = await hermetic.agents.set({ name: "fathom", refresh_profile: true });

    expect(staged.pending?.profile_id).toBe(FIXTURE_PROFILE_IDS.anthropic);
    expect(staged.pending?.model).toBe("claude-opus-4-1-FIXTURE");
  });

  /** A switch still resets it: a model id from one catalog aimed at another's endpoint. */
  test("a switch onto another profile still takes that profile's model", async () => {
    const { backend, hermetic } = fleet();
    legacyRow(backend, "fathom", "claude-opus-4-1-FIXTURE");

    const staged = await hermetic.agents.set({
      name: "fathom",
      provider_profile: "openrouter-cheap",
    });

    expect(staged.pending?.model).not.toBe("claude-opus-4-1-FIXTURE");
  });

  /**
   * With a change staged, `pending.model` is what lands — `applyPendingPatch`
   * writes it over `hermes.model` on the way past. A bare `--model` therefore
   * has to patch the staged binding; written to `hermes.model` instead it would
   * show up on every reading of the row until the apply silently reverted it.
   */
  test("a bare --model with a change staged patches the staged binding", async () => {
    const { backend, hermetic } = fleet();
    const before = backend.agents.get("corvid")!;
    expect(before.pending).toBeTruthy();

    const set = await hermetic.agents.set({ name: "corvid", model: "claude-haiku-5-FIXTURE" });

    expect(set.pending?.model).toBe("claude-haiku-5-FIXTURE");
    // The staged binding is otherwise the one that was already there.
    expect(set.pending?.profile_id).toBe(before.pending!.profile_id);
    expect(set.pending?.credential_ref).toBe(before.pending!.credential_ref);
    // And the row's own model is left where it was: it is what the box runs
    // until the apply, and the apply writes the staged model over it.
    const row = backend.agents.get("corvid")!;
    expect(row.hermes?.model).toBe(before.hermes?.model);

    // The apply lands the model the operator named, rather than the one the
    // change was staged with.
    await drain(
      hermetic.apply({ plan: await hermetic.plan.rollout({ agents: ["corvid"] }), yes: true }),
    );
    expect(backend.agents.get("corvid")!.hermes?.model).toBe("claude-haiku-5-FIXTURE");
  });

  /** With nothing staged it is the ordinary managed setting it has always been. */
  test("a bare --model with nothing staged writes the row's model directly", async () => {
    const { backend, hermetic } = fleet();
    expect(backend.agents.get(BOUND)!.pending ?? null).toBeNull();

    const set = await hermetic.agents.set({ name: BOUND, model: "claude-haiku-5-FIXTURE" });

    expect(set.pending ?? null).toBeNull();
    expect(backend.agents.get(BOUND)!.hermes?.model).toBe("claude-haiku-5-FIXTURE");
  });
});

/**
 * The slot a binding names has to be unique to the *binding*, not to the
 * revision — which is the one thing a `provider-key-r<N>` name could not be.
 *
 * Every profile's revisions start at 1, so a fleet with two profiles has two
 * different credentials that both call themselves r1. An agent bound to one at
 * r1 and staged onto the other at r1 would therefore name a single slot for its
 * running *and* its staged binding, and `applyPending` — whose whole safety
 * argument is that it writes into a slot nothing reads before the row write
 * commits — would overwrite the credential the box is serving on. If the CAS
 * write then lost, the row would still say the old binding while the slot held
 * the new profile's key: an agent quietly authenticating to one provider with
 * another's credential.
 *
 * `corvid` is exactly that pair in the fixture — `openrouter-cheap` r1 running,
 * `anthropic-main` r1 staged — so the collision is asserted where it happened
 * rather than on a constructed row.
 */
describe("a slot names the binding, not just the revision", () => {
  test("two profiles at the same revision give an agent two different slots", () => {
    const { backend } = fleet();
    const row = backend.agents.get("corvid")!;

    expect(row.profile_revision).toBe(1);
    expect(row.pending?.profile_revision).toBe(1);
    expect(row.profile_id).not.toBe(row.pending?.profile_id);
    // The point: same revision, different profile, different slot.
    expect(row.credential_ref).toBe(`provider-key-${FIXTURE_PROFILE_IDS.openrouter}-r1`);
    expect(row.pending?.credential_ref).toBe(`provider-key-${FIXTURE_PROFILE_IDS.anthropic}-r1`);
    expect(row.pending?.credential_ref).not.toBe(row.credential_ref);
  });

  test("applying a staged switch never writes the slot the running binding reads", async () => {
    const { backend, hermetic } = fleet();
    const row = backend.agents.get("corvid")!;
    const running = agentSlot("corvid", row.credential_ref!);
    const staged = agentSlot("corvid", row.pending!.credential_ref!);
    // The value the box is serving on, before anything is applied.
    const wasRunning = backend.params.get(running);
    expect(wasRunning).toBeDefined();
    expect(backend.params.has(staged)).toBe(false);

    await drain(
      hermetic.apply({ plan: await hermetic.plan.rollout({ agents: ["corvid"] }), yes: true }),
    );

    // The staged slot now holds the *other* profile's key, and the slot the
    // previous binding read is untouched — which is what makes the apply's
    // ordering safe and a lost CAS write recoverable.
    const anthropicKey = backend.params.get(
      sharedSecretPath(FIXTURE_CONFIG.fleet_id, profileSlotSlug(FIXTURE_PROFILE_IDS.anthropic)),
    );
    expect(backend.params.get(staged)).toBe(anthropicKey!);
    expect(backend.params.get(running)).toBe(wasRunning!);
    expect(backend.agents.get("corvid")!.credential_ref).toBe(row.pending!.credential_ref);
  });
});

/**
 * §8.3's apply is **one** write, and these are the two ways it used not to be.
 *
 * A row that names a profile it is not running, with nothing staged to say so,
 * is the worst state this feature can reach: every laptop-side reading agrees
 * the change has landed, the box goes on serving the previous credential, and
 * there is nothing left on the row for an operator or a converge to act on. So
 * the binding, the cleared `pending` and the `config_hash` that binding renders
 * all move together or none of them does.
 */
describe("the apply cannot tear", () => {
  /** Make the bundle upload fail, the way a denied or throttled S3 put does. */
  function breakUploads(backend: MemoryBackend): void {
    backend.artifacts.putObject = async () => {
      throw new Error("AccessDenied: PutObject");
    };
  }

  test("an upload that fails after the credential copy leaves the row fully old", async () => {
    const { backend, hermetic } = fleet();
    await hermetic.providers.update({ profile: "anthropic-main", api_key: ROTATED });
    await hermetic.agents.set({ name: BOUND, refresh_profile: true });
    const before = (await backend.store.agents.get(BOUND))!;
    expect(before.pending).toBeTruthy();

    breakUploads(backend);
    await expect(
      drain(hermetic.apply({ plan: await hermetic.plan.rollout({ agents: [BOUND] }), yes: true })),
    ).rejects.toThrow(/AccessDenied/);

    const after = (await backend.store.agents.get(BOUND))!;
    // Fully old: the binding, the revision, the slot the box reads and the hash
    // it is running are all the ones it had, and the change is still staged.
    expect(after.pending).toEqual(before.pending);
    expect(after.profile_revision).toBe(1);
    expect(after.credential_ref).toBe("provider-key-ant00001-r1");
    expect(after.config_hash).toBe(before.config_hash);
    expect(after.resources.config_key).toBe(before.resources.config_key);
  });

  /**
   * And the successful half, asserted as the *other* whole state: the hash the
   * row records is the one the new binding renders, and the bundle it names is
   * in the bucket. A row whose binding had moved while its hash had not would
   * pass every other assertion in this file.
   */
  test("an apply that succeeds moves the binding and the hash in the same write", async () => {
    const { backend, hermetic } = fleet();
    const versions: number[] = [];
    const update = backend.store.agents.update.bind(backend.store.agents);
    backend.store.agents.update = async (name, version, patch) => {
      // `pending: null` is the commit write specifically — `agents.set`'s
      // staging write also carries a `pending`, and it is the other one.
      if (name === BOUND && patch["pending"] === null) {
        expect(patch).toHaveProperty("profile_revision");
        expect(patch).toHaveProperty("config_hash");
        versions.push(version);
      }
      return await update(name, version, patch);
    };

    await hermetic.providers.update({ profile: "anthropic-main", api_key: ROTATED });
    await hermetic.agents.set({ name: BOUND, refresh_profile: true });
    const staged = (await backend.store.agents.get(BOUND))!;
    await drain(hermetic.apply({ plan: await hermetic.plan.rollout({ agents: [BOUND] }), yes: true }));

    expect(versions).toHaveLength(1);
    const after = (await backend.store.agents.get(BOUND))!;
    expect(after.config_hash).not.toBe(staged.config_hash);
    expect(after.resources.config_key).toBe(`config/${BOUND}/${after.config_hash}.tgz`);
    expect([...backend.objects.keys()]).toContain(after.resources.config_key!);
  });
});

/**
 * §8.3: the staged *revision* is part of what was staged.
 *
 * `pending` names a profile **and** a revision, and the slot the apply copies
 * into is named for that revision. A profile rotated between the staging and
 * the apply holds a different key under the same id, so going ahead would put
 * today's key into the slot named for yesterday's revision and record the row
 * as pinned to a revision it does not hold — an `update_available` that reads
 * as "not yet applied" for a credential that has already landed.
 */
describe("a staged revision that has moved", () => {
  test("the apply refuses, naming `--refresh-profile`", async () => {
    const { backend, hermetic } = fleet();
    const before = backend.agents.get("corvid")!;
    expect(before.pending?.profile_revision).toBe(1);

    // Somebody rotates the profile this row is staged onto, after the staging.
    await hermetic.providers.update({ profile: "anthropic-main", api_key: ROTATED });

    let error: unknown = null;
    try {
      await drain(
        hermetic.apply({ plan: await hermetic.plan.rollout({ agents: ["corvid"] }), yes: true }),
      );
    } catch (e) {
      error = e;
    }
    expect(codeOf(error)).toBe("CONFLICT");
    expect((error as HermeticError).message).toContain("--refresh-profile");
    expect((error as HermeticError).details).toMatchObject({ staged_revision: 1, revision: 2 });

    // Nothing moved, and the change is still staged — re-staging it is the one
    // action the refusal asks for.
    const after = backend.agents.get("corvid")!;
    expect(after.pending).toEqual(before.pending);
    expect(after.provider).toBe("openrouter");
    expect(after.credential_ref).toBe(before.credential_ref);
    expect(backend.params.has(agentSlot("corvid", before.pending!.credential_ref!))).toBe(false);
  });

  test("a recreate consuming the same stale staging refuses too", async () => {
    const { backend, hermetic } = fleet();
    await hermetic.providers.update({ profile: "anthropic-main", api_key: ROTATED });

    let error: unknown = null;
    try {
      await drain(hermetic.agents.recreate({ name: "corvid", yes: true }));
    } catch (e) {
      error = e;
    }
    expect(codeOf(error)).toBe("CONFLICT");
    expect(backend.agents.get("corvid")!.provider).toBe("openrouter");
  });

  /**
   * And re-staging is what clears it: `--refresh-profile` pins the revision the
   * profile has actually reached, and the apply then goes through.
   */
  test("re-staging at the profile's current revision unblocks the apply", async () => {
    const { backend, hermetic } = fleet();
    await hermetic.providers.update({ profile: "anthropic-main", api_key: ROTATED });
    await hermetic.agents.set({ name: "corvid", provider_profile: "anthropic-main" });

    await drain(
      hermetic.apply({ plan: await hermetic.plan.rollout({ agents: ["corvid"] }), yes: true }),
    );

    const after = backend.agents.get("corvid")!;
    expect(after.pending ?? null).toBeNull();
    expect(after.provider).toBe("anthropic");
    expect(after.profile_revision).toBe(2);
    expect(after.credential_ref).toBe(`provider-key-${FIXTURE_PROFILE_IDS.anthropic}-r2`);
  });
});

/**
 * §8.3's optimistic lock on the *row*, stated by the caller rather than
 * inferred.
 *
 * The store's conditional write already refuses a row that moves during a call.
 * What it cannot see is a row that moved before the call: `agents.set` reads
 * whatever is there now and composes a patch onto it quite happily, so a drawer
 * left open while somebody else staged a provider change would overwrite that
 * staging with a version of the row that no longer exists.
 */
describe("agents.set --expected-version", () => {
  test("a version the row has moved past is CONFLICT, and writes nothing", async () => {
    const { backend, hermetic } = fleet();
    const before = backend.agents.get("fathom")!;

    let error: unknown = null;
    try {
      await hermetic.agents.set({
        name: "fathom",
        expected_version: before.version - 1,
        provider_profile: "anthropic-main",
      });
    } catch (e) {
      error = e;
    }
    expect(codeOf(error)).toBe("CONFLICT");
    expect((error as HermeticError).details).toMatchObject({
      expected: before.version - 1,
      actual: before.version,
    });
    expect(backend.agents.get("fathom")!).toEqual(before);
  });

  test("the version the caller read goes through, and the view carries it", async () => {
    const { hermetic } = fleet();
    const view = await hermetic.agents.get("fathom");
    // The head sends back what it rendered, so the field has to be on the view.
    expect(typeof view.version).toBe("number");

    const next = await hermetic.agents.set({
      name: "fathom",
      expected_version: view.version,
      provider_profile: "anthropic-main",
    });
    expect(next.pending?.profile_id).toBe(FIXTURE_PROFILE_IDS.anthropic);
    expect(next.version).toBeGreaterThan(view.version);
  });

  test("a second write against the version the first consumed is refused", async () => {
    const { hermetic } = fleet();
    const view = await hermetic.agents.get("fathom");
    await hermetic.agents.set({ name: "fathom", expected_version: view.version, size: "large" });
    expect(
      codeOf(
        await hermetic.agents
          .set({ name: "fathom", expected_version: view.version, provider_profile: "nous-lab" })
          .then(() => null)
          .catch((e: unknown) => e),
      ),
    ).toBe("CONFLICT");
  });

  test("omitting it is unchanged: the row as it stands now", async () => {
    const { hermetic } = fleet();
    const next = await hermetic.agents.set({ name: "fathom", size: "large" });
    expect(next.size).toBe("large");
  });
});
