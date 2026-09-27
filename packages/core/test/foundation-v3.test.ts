/**
 * The shipped v3 foundation migration (§6.6): fleet-scoped SSM paths, the
 * `hermetic:fleet_id` tag on every managed instance and volume, and
 * `_fleet.fleet_name`.
 *
 * Every step is best effort and idempotent, which is exactly the pair of
 * properties prose cannot be trusted with: a step that quietly did nothing and
 * a step that did the work twice look the same from outside. So each one is run
 * against a `MemoryBackend` seeded into the *pre-v3* shape — no `fleet_name`,
 * parameters on the account roots, resources carrying no fleet tag — and then
 * run again over its own output.
 *
 * `HERMETIC_FIXTURE_OUTDATED=1` seeds that shape for a whole process; this
 * builds it here instead, because a test that needed an env var set before
 * import could not sit beside the ones that do not.
 */
import { describe, expect, test } from "bun:test";
import {
  FIXTURE_CONFIG,
  MemoryBackend,
  fixtureConfigFor,
  seedFixtureFleet,
} from "../src/backend/memory.ts";
import { FOUNDATION_MIGRATIONS } from "../src/fleet/foundation-migrations.ts";
import type { FoundationMigrationDeps } from "../src/fleet/foundation-migrations.ts";
import { FOUNDATION_VERSION } from "../src/version.ts";
import type { FixtureAccount } from "../src/backend/fixture/fixture-directory.ts";
import { createFixtureAccount } from "../src/backend/memory.ts";
import { HermeticError } from "../src/errors.ts";
import { SECRET_PLACEHOLDER } from "../src/backend/constants.ts";
import type { OpEvent } from "../src/schema/index.ts";
import { createFoundation, type FoundationDeps } from "../src/fleet/foundation/index.ts";
import { OFFLINE_HERMES_RELEASE, drain, testContext } from "./helpers.ts";

/** The real `foundation.update`, wired to a fixture backend and the shipped migrations. */
function foundationDeps(backend: MemoryBackend): FoundationDeps {
  return {
    ctx: testContext(backend, {
      guardAccount: async () => {},
      guardFleet: async () => ({
        config: FIXTURE_CONFIG,
        fleet: backend.fleetItem!,
        stack: backend.stack!,
      }),
      actor: async () => FIXTURE_CONFIG.frozen_by,
      appendEvent: async () => {},
      nowIso: () => backend.now().toISOString(),
    }),
    hermesFetch: OFFLINE_HERMES_RELEASE,
    lockTtlMs: 60_000,
    changeSetPollMs: 0,
    rolloutPollMs: 1,
    rolloutWaitMs: 0,
    heartbeatMs: 60_000,
  };
}

const V3 = FOUNDATION_MIGRATIONS.find((m) => m.version === 3)!;
const FLEET_ID = FIXTURE_CONFIG.fleet_id;
const NOW = "2026-09-07T00:00:00.000Z";

/**
 * A fixture fleet as it stood before v3: `_fleet` without a name, every
 * parameter directly under the account roots, and no `hermetic:fleet_id` tag on
 * anything. This is what the migration is pointed at.
 */
function preV3(account: FixtureAccount = createFixtureAccount("seeded")): MemoryBackend {
  const backend = seedFixtureFleet(new MemoryBackend({ account }));
  backend.fleetItem = { ...backend.fleetItem!, fleet_name: undefined };

  const legacy = new Map<string, string>();
  for (const [path, value] of backend.params) {
    legacy.set(path.replace(`/${FLEET_ID}/`, "/"), value);
  }
  backend.params.clear();
  for (const [path, value] of legacy) backend.params.set(path, value);

  for (const [id, volume] of backend.volumes) backend.volumes.set(id, { ...volume, fleet_id: null });
  for (const [id, instance] of backend.instances) {
    backend.instances.set(id, { ...instance, fleet_id: null });
  }
  backend.resetMutations();
  return backend;
}

function depsFor(backend: MemoryBackend): FoundationMigrationDeps & { notes: string[] } {
  return {
    backend,
    fleet: backend.fleetItem!,
    actor: FIXTURE_CONFIG.frozen_by,
    nowIso: () => NOW,
    notes: [],
    // The only thing the copy waits for is a re-read of a slot it has just
    // written, and a suite must not spend real seconds proving it gave up.
    sleep: async () => {},
  };
}

/**
 * Both halves, in the order `foundation.update` runs them: `before` happens
 * ahead of the stack update (the parameter copy has to land before the template
 * narrows the role to the prefix it copies into), `remote` after.
 */
async function run(backend: MemoryBackend): Promise<string[]> {
  const deps = depsFor(backend);
  await V3.before?.(deps);
  await V3.remote?.(deps);
  // The hooks patch `deps.fleet` in place; the stamp writes it back (§6.6).
  backend.fleetItem = deps.fleet;
  return deps.notes;
}

/**
 * The post-stack half alone, for the steps that are still best effort. The
 * pre-stack copy refuses outright on an account it cannot read (§6.6), so a
 * test about what step 1 or step 2 does on such an account cannot reach them
 * through `run`.
 */
async function runRemote(backend: MemoryBackend): Promise<string[]> {
  const deps = depsFor(backend);
  await V3.remote?.(deps);
  backend.fleetItem = deps.fleet;
  return deps.notes;
}

/** An account whose directory proves this fleet is the only live one. */
function soleLiveFleet(): FixtureAccount {
  const account = createFixtureAccount("seeded");
  // §4.6: the fixture directory is keyed by `fleet_id`, not by display alias.
  const mainId = fixtureConfigFor("main").fleet_id;
  for (const key of [...account.entries.keys()]) if (key !== mainId) account.entries.delete(key);
  return account;
}

/** A directory whose every read throws — "cannot tell", never permission. */
function unreadableDirectory(backend: MemoryBackend): void {
  backend.directory.list = async () => {
    throw new HermeticError("DIRECTORY_UNAVAILABLE", "the directory table is not readable");
  };
}

describe("the v3 foundation migration", () => {
  /**
   * v3 is no longer the newest contract, so this asserts what is still true of
   * it: that it is a real entry, that it is reachable from every fleet older
   * than it, and that `FOUNDATION_VERSION` has moved past it rather than
   * behind it. `foundation-version.test.ts` owns the "this build's version has
   * an entry" check for whatever the newest one is.
   */
  test("it is an entry every older fleet still migrates through", () => {
    expect(FOUNDATION_VERSION).toBeGreaterThanOrEqual(3);
    expect(V3.version).toBe(3);
    expect(V3.describe.length).toBeGreaterThan(0);
  });

  /** Step 1: the name comes from the directory, which is the register of record. */
  test("back-fills _fleet.fleet_name from the directory entry with this fleet id", async () => {
    const backend = preV3();
    expect(backend.fleetItem!.fleet_name).toBeUndefined();

    const notes = await run(backend);
    expect(backend.fleetItem!.fleet_name).toBe("main");
    expect(notes.join("\n")).toContain('recorded the fleet name "main"');

    // Twice is once: the second run finds a name and says so rather than
    // re-deciding it.
    const again = await run(backend);
    expect(backend.fleetItem!.fleet_name).toBe("main");
    expect(again.join("\n")).toContain("already records the fleet name");
  });

  /**
   * A fleet the directory has never heard of gets no name — and the operator is
   * told which command supplies one, rather than being left with agents whose
   * boxes are silently still called `atlas`.
   */
  test("a fleet the directory does not know keeps no name, and says why", async () => {
    const backend = preV3(createFixtureAccount("absent"));
    const notes = await run(backend);
    expect(backend.fleetItem!.fleet_name).toBeUndefined();
    expect(notes.join("\n")).toContain("init --attach --fleet");
  });

  /** Step 2: adopt the untagged resources, because there is only one fleet here. */
  test("tags every managed instance and volume that carries no fleet id", async () => {
    const backend = preV3(soleLiveFleet());
    expect(await backend.compute.listUnscopedManaged()).not.toEqual({ instances: [], volumes: [] });
    // Until they are tagged they are invisible to every filter, exactly as they
    // would be to `DescribeInstances` with the fleet clause.
    expect(await backend.compute.listManagedInstances()).toEqual([]);

    const notes = await run(backend);
    expect(await backend.compute.listUnscopedManaged()).toEqual({ instances: [], volumes: [] });
    expect((await backend.compute.listManagedInstances()).length).toBeGreaterThan(0);
    expect(notes.join("\n")).toMatch(/tagged \d+ instance\(s\) and \d+ volume\(s\)/);

    const again = await run(backend);
    expect(again.join("\n")).toContain("already carries this fleet's id");
  });

  /**
   * The refusal that makes step 2 safe. With two fleets in the account there is
   * no way to tell whose an untagged volume is, and guessing would hand one
   * fleet's data disk to the other.
   */
  test("with more than one fleet in the account it adopts nothing and says how many", async () => {
    const backend = preV3();
    // The seeded fixture directory holds `main` and `staging`, both active.
    expect((await backend.directory.list()).filter((e) => e.status !== "torn_down")).toHaveLength(2);

    const before = await backend.compute.listUnscopedManaged();
    const notes = await run(backend);
    expect(await backend.compute.listUnscopedManaged()).toEqual(before);
    expect(notes.join("\n")).toContain("this account holds 2 live fleets (main, staging)");
  });

  /**
   * The three ways the gate can be false, each with its own reason — because
   * "could not read the directory" and "somebody else's account" are different
   * problems with different fixes, and `<= 1` used to collapse the first two
   * into permission to adopt.
   */
  test("a directory that cannot be read adopts nothing", async () => {
    const backend = preV3();
    unreadableDirectory(backend);
    const before = await backend.compute.listUnscopedManaged();
    // The post-stack half on its own: the pre-stack copy refuses an unreadable
    // directory outright, which is the test below this one.
    const notes = await runRemote(backend);
    expect(await backend.compute.listUnscopedManaged()).toEqual(before);
    expect(notes.join("\n")).toContain("could not be read");
  });

  test("a directory that lists no live fleet adopts nothing", async () => {
    const backend = preV3(createFixtureAccount("absent"));
    const before = await backend.compute.listUnscopedManaged();
    const notes = await run(backend);
    expect(await backend.compute.listUnscopedManaged()).toEqual(before);
    expect(notes.join("\n")).toContain("lists no live fleets");
  });

  test("one live fleet that is not this one adopts nothing", async () => {
    const account = createFixtureAccount("seeded");
    const stagingId = fixtureConfigFor("staging").fleet_id;
    for (const key of [...account.entries.keys()]) if (key !== stagingId) account.entries.delete(key);
    const backend = preV3(account);
    const before = await backend.compute.listUnscopedManaged();
    const notes = await run(backend);
    expect(await backend.compute.listUnscopedManaged()).toEqual(before);
    expect(notes.join("\n")).toContain(`the account's only live fleet is ${stagingId}`);
  });

  /** Step 3: parameters are copied under the fleet id, and the originals stay. */
  test("copies every legacy parameter under the fleet's prefixes, keeping the originals", async () => {
    const backend = preV3();
    const legacy = [...backend.params.keys()].sort();
    expect(legacy).toContain("/hermes/atlas/ts-key");
    expect(legacy).toContain("/hermetic/secrets/nous-key");

    const notes = await run(backend);
    for (const path of legacy) {
      const scoped = path.replace(/^\/(hermetic|hermes)\//, `/$1/${FLEET_ID}/`);
      expect(backend.params.get(scoped), scoped).toBe(backend.params.get(path)!);
    }
    // Kept, not moved: a rolled-back hermetic and every box still on the
    // previous release read the old paths.
    for (const path of legacy) expect(backend.params.has(path), path).toBe(true);
    expect(notes.join("\n")).toContain("the originals are kept");

    /**
     * A re-run creates nothing new and *keeps* what is already scoped, rather
     * than copying over it.
     */
    const before = new Map(backend.params);
    const again = await run(backend);
    expect(new Map(backend.params)).toEqual(before);
    expect(again.join("\n")).toContain(`kept existing ${legacy.length} scoped parameter(s)`);
  });

  /**
   * The copy is *enumerated* from this fleet's agent table, so another fleet's
   * already-scoped parameters are not reachable from it at all — they are not
   * read, not copied, and not nested into `/hermes/<id>/<id>/`.
   */
  test("another fleet's scoped parameters are never read or re-scoped", async () => {
    const backend = preV3();
    backend.params.set("/hermes/sg7k2m4p/ember/ts-key", "tskey-FIXTURE-OTHER-FLEET");
    await run(backend);
    expect(backend.params.has(`/hermes/${FLEET_ID}/sg7k2m4p/ember/ts-key`)).toBe(false);
    expect(backend.params.has("/hermes/sg7k2m4p/ember/ts-key")).toBe(true);
  });

  /**
   * The base32 heuristic this replaced would have skipped `research` — an eight
   * character agent name — leaving its key on the old path where the narrowed
   * IAM role can no longer read it. The agent table is the test now.
   */
  test("an eight-character agent name is copied like any other", async () => {
    const backend = preV3();
    const template = backend.agents.get("atlas")!;
    backend.agents.set("research", { ...template, name: "research" });
    backend.params.set("/hermes/research/ts-key", "tskey-FIXTURE-RESEARCH");

    await run(backend);
    expect(backend.params.get(`/hermes/${FLEET_ID}/research/ts-key`)).toBe("tskey-FIXTURE-RESEARCH");
  });

  /**
   * And its mirror: an agent whose name really *is* a live fleet's id makes
   * `/hermes/<that>/` ambiguous with that fleet's scoped root. Skipping it and
   * carrying on is the right answer for the callers that *delete*, and the
   * wrong one here — the template that follows narrows the role onto the
   * fleet-scoped path the skip leaves empty, and the stamp then takes v3 out of
   * `migrationsBetween`, so the box is cut off from a key nothing will ever
   * copy. The update stops instead, and names the command that resolves it.
   */
  test("an agent named like a live fleet's id stops the update with a remedy", async () => {
    const backend = preV3();
    const template = backend.agents.get("atlas")!;
    backend.agents.set("sg7k2m4p", { ...template, name: "sg7k2m4p" });
    backend.params.set("/hermes/sg7k2m4p/ts-key", "tskey-FIXTURE-AMBIGUOUS");

    let failure: HermeticError | null = null;
    try {
      await run(backend);
    } catch (e) {
      failure = e as HermeticError;
    }
    expect(failure?.code).toBe("FOUNDATION_UPDATE_FAILED");
    expect(failure?.message).toContain("hermetic secrets push sg7k2m4p");
    // Nothing read and nothing written: the other fleet's keys stay where they
    // are, this fleet's scoped path stays empty, and no value is in the message.
    expect(backend.params.has(`/hermes/${FLEET_ID}/sg7k2m4p/ts-key`)).toBe(false);
    expect(failure?.message).not.toContain("tskey-FIXTURE-AMBIGUOUS");
  });

  /**
   * The same shape, resolved rather than refused. A directory *entry* is a
   * memory: an id it lists as torn down, with no stack left in the account,
   * belongs to no fleet that could still be reading those paths, so the
   * ambiguity is not real and the agent's prefix is copied like any other.
   */
  test("an agent named like a torn-down fleet's id is copied, not contested", async () => {
    const backend = preV3();
    const gone = "tr7k9x2q";
    const entries = backend.account.entries;
    const template = entries.get(fixtureConfigFor("staging").fleet_id)!;
    entries.set(gone, { ...template, fleet_id: gone, name: "gone", status: "torn_down" });
    const agent = backend.agents.get("atlas")!;
    backend.agents.set(gone, { ...agent, name: gone });
    backend.params.set(`/hermes/${gone}/ts-key`, "tskey-FIXTURE-INHERITED");

    const notes = await run(backend);

    expect(backend.params.get(`/hermes/${FLEET_ID}/${gone}/ts-key`)).toBe("tskey-FIXTURE-INHERITED");
    expect(notes.join("\n")).toContain("no live fleet and no stack answers to");
  });

  /**
   * And the third answer: CloudFormation could not be asked, so nothing was
   * cleared. An unasked source is not an all-clear — the name stays contested
   * and the update stops, exactly as it would for a fleet that is still live.
   */
  test("an unreadable stack listing leaves an ambiguous prefix contested", async () => {
    const backend = preV3();
    const gone = "tr7k9x2q";
    const entries = backend.account.entries;
    const template = entries.get(fixtureConfigFor("staging").fleet_id)!;
    entries.set(gone, { ...template, fleet_id: gone, name: "gone", status: "torn_down" });
    const agent = backend.agents.get("atlas")!;
    backend.agents.set(gone, { ...agent, name: gone });
    backend.params.set(`/hermes/${gone}/ts-key`, "tskey-FIXTURE-INHERITED");
    backend.foundation.listStacks = async () => {
      throw new HermeticError("INTERNAL", "DescribeStacks is throttled");
    };

    let failure: HermeticError | null = null;
    try {
      await run(backend);
    } catch (e) {
      failure = e as HermeticError;
    }
    expect(failure?.code).toBe("FOUNDATION_UPDATE_FAILED");
    expect(backend.params.has(`/hermes/${FLEET_ID}/${gone}/ts-key`)).toBe(false);
  });

  /**
   * Without the directory there is no list of fleet ids to check an agent name
   * against, and `/hermes/<agent>/` is exactly where another fleet that has
   * already taken v3 keeps its parameters.
   *
   * This used to copy the two fleet-level layouts, skip every per-agent prefix
   * and leave a note telling the operator to re-run — advice the very next
   * phase made false, because the update carried on to the stamp and the re-run
   * would find v3 no longer pending. A required step that cannot prove it
   * copied everything refuses, and the copy that would have been half done is
   * not started.
   */
  test("an unreadable directory stops the update instead of copying half of it", async () => {
    const backend = preV3();
    unreadableDirectory(backend);

    let failure: HermeticError | null = null;
    try {
      await run(backend);
    } catch (e) {
      failure = e as HermeticError;
    }
    expect(failure?.code).toBe("FOUNDATION_UPDATE_FAILED");
    expect(failure?.message).toContain("fleet directory could not be read");
    expect(failure?.message).toContain("hermetic foundation update");
    // Not even the unambiguous half: a partial copy under a stamped version is
    // the state this refuses to reach.
    expect(backend.params.has(`/hermetic/${FLEET_ID}/secrets/nous-key`)).toBe(false);
    expect(backend.params.has(`/hermes/${FLEET_ID}/atlas/ts-key`)).toBe(false);
  });

  /**
   * §6.6: the copy runs in the `before` hook, ahead of the stack update — the
   * same template narrows the agent role to the prefix it copies into, so doing
   * it afterwards leaves a window in which the role can read only an empty
   * namespace.
   */
  test("the parameter copy is a pre-stack step, not a post-stack one", async () => {
    const backend = preV3();
    const deps = depsFor(backend);
    await V3.before?.(deps);
    expect(backend.params.has(`/hermes/${FLEET_ID}/atlas/ts-key`)).toBe(true);
    expect(deps.notes.join("\n")).toContain("copied");
    expect(V3.before).toBeDefined();
  });

  /**
   * The order, proved against the backend's own mutation log rather than
   * against the hook list: every parameter this fleet owns is written *before*
   * CloudFormation is asked to execute the change set that narrows the agent
   * role to the prefix they are written under.
   *
   * This runs the whole `foundation.update`, not the hooks in isolation,
   * because the ordering bug it guards is one only the op can have.
   */
  test("every parameter is written before the stack update executes", async () => {
    const backend = preV3(soleLiveFleet());
    backend.fleetItem = { ...backend.fleetItem!, foundation_version: 2 };
    backend.resetMutations();

    await drain(createFoundation(foundationDeps(backend)).update({ yes: true }));

    const firstPut = backend.mutations.indexOf("secrets.put");
    const execute = backend.mutations.indexOf("foundation.executeChangeSet");
    expect(firstPut).toBeGreaterThanOrEqual(0);
    expect(execute).toBeGreaterThanOrEqual(0);
    expect(firstPut).toBeLessThan(execute);
    // And the last one too: no straggler lands after the role is narrowed.
    expect(backend.mutations.lastIndexOf("secrets.put")).toBeLessThan(execute);
  });

  /**
   * The copy is a *required* pre-stack step, and this is what that buys.
   *
   * Every failure in it used to become a note, and the update carried on: the
   * template narrowed the agent role onto the fleet-scoped prefix the copy had
   * not filled, and then the stamp recorded the new foundation version — which
   * takes the entry out of every later `migrationsBetween`, so nothing ever
   * retried it. The destination was left unusable and the fleet reported
   * itself up to date.
   */
  test("required migration failure blocks the stack change and does not stamp the version", async () => {
    const backend = preV3(soleLiveFleet());
    backend.fleetItem = { ...backend.fleetItem!, foundation_version: 2 };
    const source = "/hermes/atlas/ts-key";
    const target = `/hermes/${FLEET_ID}/atlas/ts-key`;
    expect(await backend.secrets.isPlaceholder(source)).toBe(false);

    // One slot SSM refuses to take the value for. Named, never valued (§8.3).
    const put = backend.secrets.put;
    let refuseWrite = true;
    backend.secrets.put = async (path: string, value: string): Promise<void> => {
      if (refuseWrite && path === target) {
        throw new HermeticError("INTERNAL", `could not write the SSM slot ${path}`, { path });
      }
      await put(path, value);
    };
    backend.resetMutations();

    const events: OpEvent[] = [];
    let failure: HermeticError | null = null;
    try {
      for await (const event of createFoundation(foundationDeps(backend)).update({ yes: true })) {
        events.push(event);
      }
    } catch (e) {
      failure = e as HermeticError;
    }

    expect(failure?.code).toBe("FOUNDATION_UPDATE_FAILED");
    expect(failure?.message).toContain(target);
    // The change set was never even computed, so the role was never narrowed
    // onto a prefix that is missing a parameter the boxes read.
    expect(backend.mutations).not.toContain("foundation.createChangeSet");
    expect(backend.mutations).not.toContain("foundation.executeChangeSet");
    // And the version was not stamped, so v3 is still pending rather than
    // recorded as done — the lock is released and the op is re-runnable.
    expect(backend.fleetItem!.foundation_version).toBe(2);
    expect(backend.fleetItem!.lock).toBeNull();
    // Said out loud before it was thrown, naming the slot and not its value.
    const errors = events.filter((e) => e.level === "error").map((e) => e.message);
    expect(errors.join("\n")).toContain(target);
    expect(errors.join("\n")).not.toContain(backend.params.get(source)!);

    /**
     * And the re-run is the proof that nothing was stranded: the first attempt
     * left the destination as an empty slot, the second finishes it, and the
     * stamp follows.
     */
    refuseWrite = false;
    await drain(createFoundation(foundationDeps(backend)).update({ yes: true }));
    expect(backend.params.get(target)).toBe(backend.params.get(source)!);
    expect(backend.fleetItem!.foundation_version).toBe(FOUNDATION_VERSION);
  });

  /**
   * The crash window itself, closed from the other side. `ensureSlot` writes
   * hermetic's placeholder, which is this step's record of *intent*: the slot
   * is declared before the value is written into it, so an attempt interrupted
   * between the two is recognisable afterwards. Read as mere existence — which
   * is what the destination check used to do — it is indistinguishable from a
   * copy that finished, and the empty slot survives every later run.
   */
  test("a placeholder an interrupted copy left behind is finished on the retry", async () => {
    const backend = preV3();
    const source = "/hermes/atlas/ts-key";
    const target = `/hermes/${FLEET_ID}/atlas/ts-key`;
    // Exactly what a crash between the slot and the value leaves behind.
    await backend.secrets.ensureSlot(target);
    expect(await backend.secrets.isPlaceholder(target)).toBe(true);

    const notes = await run(backend);

    expect(backend.params.get(target)).toBe(backend.params.get(source)!);
    expect(await backend.secrets.isPlaceholder(target)).toBe(false);
    expect(notes.join("\n")).toContain("finished a copy a previous attempt had left as an empty slot");

    // A destination that holds a value is still kept, not written over: the
    // resume is for the placeholder and nothing else.
    backend.params.set(target, "tskey-FIXTURE-ROTATED-SINCE");
    await run(backend);
    expect(backend.params.get(target)).toBe("tskey-FIXTURE-ROTATED-SINCE");
  });

  /**
   * The other end of the same rule. A *source* nobody has ever pushed to holds
   * the placeholder itself — hermetic owns slot existence and never the value
   * (§8.2) — so there is no value to move and the destination is declared to
   * match it. That is not a failure, and must not be counted as one now that a
   * failure stops the update.
   */
  test("a source that was only ever declared gets a declared destination, not a failure", async () => {
    const backend = preV3();
    const source = "/hermetic/secrets/openrouter-key";
    const target = `/hermetic/${FLEET_ID}/secrets/openrouter-key`;
    expect(await backend.secrets.isPlaceholder(source)).toBe(true);
    expect(await backend.secrets.exists(target)).toBe(false);

    const notes = await run(backend);

    expect(await backend.secrets.isPlaceholder(target)).toBe(true);
    expect(notes.join("\n")).toContain("whose source has never been pushed to");
    // And a second run is a no-op rather than a failure: both ends match.
    const before = new Map(backend.params);
    await run(backend);
    expect(new Map(backend.params)).toEqual(before);
  });

  /**
   * The verification is `exists && !placeholder`, and both halves earn their
   * place. `SsmSecrets.isPlaceholder` reads the parameter and compares, so an
   * *absent* one answers `false` — which `!isPlaceholder` alone would read as a
   * finished copy. A write that vanishes is the case that matters most here and
   * the one that check got wrong.
   */
  test("a write that leaves nothing behind fails the copy rather than passing it", async () => {
    const backend = preV3();
    const target = `/hermes/${FLEET_ID}/atlas/ts-key`;
    const put = backend.secrets.put;
    backend.secrets.put = async (path: string, value: string): Promise<void> => {
      if (path === target) {
        // The write is accepted and the slot is not there afterwards.
        backend.params.delete(path);
        return;
      }
      await put(path, value);
    };

    let failure: HermeticError | null = null;
    try {
      await run(backend);
    } catch (e) {
      failure = e as HermeticError;
    }
    expect(failure?.code).toBe("FOUNDATION_UPDATE_FAILED");
    expect(failure?.message).toContain("does not hold the copied value");
    expect(await backend.secrets.exists(target)).toBe(false);
  });

  /** And the same check when the write lands but the value never does. */
  test("a destination still holding the placeholder after the write fails the copy", async () => {
    const backend = preV3();
    const target = `/hermes/${FLEET_ID}/atlas/ts-key`;
    const put = backend.secrets.put;
    backend.secrets.put = async (path: string, value: string): Promise<void> => {
      if (path === target) return; // accepted, and silently dropped
      await put(path, value);
    };

    let failure: HermeticError | null = null;
    try {
      await run(backend);
    } catch (e) {
      failure = e as HermeticError;
    }
    expect(failure?.code).toBe("FOUNDATION_UPDATE_FAILED");
    expect(await backend.secrets.isPlaceholder(target)).toBe(true);
  });

  /**
   * `PutParameter` is not read-your-writes: a `GetParameter` a moment later can
   * still answer with what was there before. That was harmless while nothing
   * read the slot back, and is not now that the answer fails the whole update,
   * so the read is retried before it is believed. Two stale answers, then the
   * truth — and the copy is a success, not a failure.
   */
  test("a stale read after the write is retried rather than failing the update", async () => {
    const backend = preV3();
    const source = "/hermes/atlas/ts-key";
    const target = `/hermes/${FLEET_ID}/atlas/ts-key`;
    const isPlaceholder = backend.secrets.isPlaceholder;
    let stale = 2;
    backend.secrets.isPlaceholder = async (path: string): Promise<boolean> => {
      if (path === target && backend.params.get(path) !== SECRET_PLACEHOLDER && stale > 0) {
        stale -= 1;
        return true; // the value is in the slot; this read has not caught up
      }
      return isPlaceholder(path);
    };

    const notes = await run(backend);

    expect(stale).toBe(0);
    expect(backend.params.get(target)).toBe(backend.params.get(source)!);
    expect(notes.join("\n")).toContain("copied");
  });

  /** Step 4: hostnames are not migrated, and the migration says so rather than pretending. */
  test("says plainly that hostnames are left for the next recreate", async () => {
    const notes = await run(preV3());
    expect(notes.join("\n")).toContain("hostnames are not migrated");
    expect(notes.join("\n")).toContain("hermetic doctor");
  });
});
