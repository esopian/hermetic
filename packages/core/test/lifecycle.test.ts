import { describe, expect, test } from "bun:test";
import { HermeticError } from "../src/errors.ts";
import type { TailscaleDeleteOutcome, TailscaleDevice } from "../src/backend/types.ts";
import {
  FIXTURE_CONFIG,
  FIXTURE_HERMETICD_VERSION,
  FIXTURE_PROFILE_IDS,
  MemoryBackend,
  fixtureConfigFor,
  seedFixtureFleet,
  seedFixtureFoundation,
  type FixtureDirectoryMode,
} from "../src/backend/memory.ts";
import { readFleetManifest } from "../src/release/artifacts.ts";
import { BROWSER_FOUNDATION_VERSION, FLEET_MANIFEST_KEY, LogsInput } from "../src/schema/index.ts";
import type { FleetManifest } from "../src/schema/index.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHermetic } from "../src/hermetic.ts";
import {
  OK_OAUTH,
  OK_TAILSCALE,
  drain,
  freshFleet,
  installTestStages,
  testHermetic,
} from "./helpers.ts";

/**
 * §4.8: these walk `init --create`, so the account they describe has no fleets
 * in it yet. The fixture directory is process-global and seeded with
 * `main`/`staging` for the *populated* fixture account, and an unnamed create
 * against that one is correctly refused — so each of these says which account
 * it is in rather than inheriting whichever ran last.
 */
function seeded(directory: FixtureDirectoryMode = "absent") {
  const backend = seedFixtureFleet(new MemoryBackend({ directory }));
  return { backend, hermetic: testHermetic({ backend, config: FIXTURE_CONFIG }) };
}

/**
 * The fixture's *other* fleet: two agents, one foundation version behind.
 *
 * `foundationVersion` says which older version is meant rather than leaning on
 * "one behind": `BROWSER_FOUNDATION_VERSION` is pinned at the version that
 * introduced the browser grant, so a §7.3 refusal needs a fleet below *that*
 * number, which `FOUNDATION_VERSION - 1` only matches until the next unrelated
 * bump moves past it.
 */
function staging(foundationVersion?: number) {
  const backend = seedFixtureFleet(new MemoryBackend(), {
    fleet: "staging",
    ...(foundationVersion === undefined ? {} : { foundationVersion }),
  });
  return { backend, hermetic: testHermetic({ backend, config: fixtureConfigFor("staging") }) };
}

describe("agents.list / get", () => {
  test("returns the seeded fixture fleet with derived display status", async () => {
    const { hermetic } = seeded();
    const rows = await hermetic.agents.list();
    expect(rows.map((r) => r.name)).toEqual([
      "atlas",
      "corvid",
      "ember",
      "fathom",
      "granite",
      "heron",
      "ibis",
      "juniper",
      "kestrel",
      "lumen",
      "marrow",
    ]);
    const byName = new Map(rows.map((r) => [r.name, r]));
    expect(byName.get("atlas")!.display_status).toBe("ready");
    expect(byName.get("ember")!.display_status).toBe("degraded");
    expect(byName.get("ember")!.health!.hermes).toBe(false);
    expect(byName.get("heron")!.display_status).toBe("error");
    // The one seeded bootstrap that stopped: `agent rerun` is what it is for.
    expect(byName.get("heron")!.bootstrap!.stages.find((s) => s.status === "failed")!.id).toBe(
      "02-data-volume",
    );
    expect(byName.get("juniper")!.display_status).toBe("stopped");
    expect(byName.get("marrow")!.display_status).toBe("stopped");
    // `oriole` is destroyed, so it has no row (§6.7): it is a tombstone, read
    // through `agents.destroyed` (`destroyed-read.test.ts`), never listed.
    // A stale heartbeat derives `unreachable` without anything storing it.
    expect(byName.get("lumen")!.status).toBe("ready");
    expect(byName.get("lumen")!.display_status).toBe("unreachable");
    // Every listed agent carries metrics for the UI's CPU/Mem/Disk bars.
    for (const row of rows) expect(row.metrics).not.toBeNull();
    // One region, and one agent still on an older hermes.
    expect(new Set(rows.map((r) => r.region))).toEqual(new Set([FIXTURE_CONFIG.region]));
    expect(rows.some((r) => r.hermes_version === "0.13.8")).toBe(true);
  });

  test("filters by display status", async () => {
    const { hermetic } = seeded();
    expect((await hermetic.agents.list({ status: "unreachable" })).map((r) => r.name)).toEqual([
      "lumen",
    ]);
  });

  test("get returns one agent, NOT_FOUND otherwise", async () => {
    const { hermetic } = seeded();
    expect((await hermetic.agents.get("atlas")).tailscale_ip).toBe("100.64.12.4");
    await expect(hermetic.agents.get("nosuch")).rejects.toThrow(HermeticError);
  });

  test("reads never mutate", async () => {
    const { backend, hermetic } = seeded();
    await hermetic.agents.list();
    await hermetic.agents.get("atlas");
    await hermetic.agents.history({ name: "atlas" });
    await hermetic.config.show();
    await hermetic.doctor();
    await hermetic.plan.destroy({ name: "atlas" });
    await hermetic.plan.teardown();
    expect(backend.mutations).toEqual([]);
  });
});

describe("agents.history", () => {
  test("is newest-first and honours a limit", async () => {
    const { hermetic } = seeded();
    const rows = await hermetic.agents.history({ name: "atlas" });
    expect(rows.length).toBeGreaterThan(3);
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i - 1]!.timestamp >= rows[i]!.timestamp).toBe(true);
    }
    expect(await hermetic.agents.history({ name: "atlas", limit: 2 })).toHaveLength(2);
  });

  /**
   * The fleet item keeps a log too — `secrets push _fleet --tailscale-oauth`
   * and `upgrade --hermeticd` both append to it — and until this it was the one
   * log with no reader: the write side already used `_fleet`, the read side
   * refused the only name that reaches it. `_fleet` stays reserved everywhere
   * an *agent* is meant; here it is the name of a real event stream.
   */
  test("`_fleet` is readable, so the fleet's own events have a reader", async () => {
    const { hermetic } = seeded();

    await hermetic.secrets.push({
      name: "_fleet",
      tailscale_oauth: true,
      value: "tskey-client-FIXTURE-OAUTH",
    });
    const rows = await hermetic.agents.history({ name: "_fleet" });

    const pushed = rows.find((r) => r.action === "secrets.push");
    expect(pushed?.name).toBe("_fleet");
    expect(pushed?.detail).toContain("/hermetic/fxtr0001/tailscale/oauth-secret");
    // Never the value, only the path and the client id (§8.3).
    expect(JSON.stringify(rows)).not.toContain("FIXTURE-OAUTH");
  });

  test("a name that is neither an agent nor `_fleet` is still refused", async () => {
    const { hermetic } = seeded();
    await expect(hermetic.agents.history({ name: "_nope" })).rejects.toThrow();
  });
});

describe("agents.set", () => {
  test("records the change and says when it takes effect", async () => {
    const { backend, hermetic } = seeded();
    const next = await hermetic.agents.set({ name: "fathom", secrets: "bitwarden", size: "large" });
    expect(next.secrets_mode).toBe("bitwarden");
    expect(next.size).toBe("large");
    expect(next.instance_type).toBe("r8g.2xlarge");

    const [latest] = await backend.store.events.query("fathom", 1);
    expect(latest!.action).toBe("set");
    expect(latest!.detail).toContain("next rerun or recreate");
  });

  /**
   * `set` re-renders and re-uploads, so `config_key` names a tarball that
   * matches the row. Without it `agent rerun` would fetch the config from
   * before the change and apply that — the change would be real on the row and
   * invisible on the box.
   */
  test("re-renders the config so a rerun carries the change", async () => {
    const { hermetic } = seeded();
    const before = await hermetic.agents.get("fathom");
    const next = await hermetic.agents.set({
      name: "fathom",
      hermes: { model: "us.anthropic.claude-haiku-4-5-20251001-v1:0" },
    });
    expect(next.hermes?.model).toBe("us.anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(next.config_hash).not.toBe(before.config_hash);
    expect(next.resources.config_key).toBe(`config/fathom/${next.config_hash}.tgz`);
  });

  /** `--model X` states one field; it must not clear the rest (§6.4). */
  test("merges hermes settings rather than replacing them", async () => {
    const { hermetic } = seeded();
    await hermetic.agents.set({ name: "fathom", hermes: { max_turns: 40 } });
    // A granted Bedrock model: `fathom` is a bedrock row and the grant check
    // now covers this door too.
    const next = await hermetic.agents.set({ name: "fathom", hermes: { model: "zai.glm-4.7-flash" } });
    expect(next.hermes).toEqual({ max_turns: 40, model: "zai.glm-4.7-flash" });
  });

  /**
   * §8.3: a provider change is *staged*, not applied. `fathom` is a bedrock
   * agent; naming a keyed provider writes `pending` and leaves the running
   * binding exactly where it was, because moving it needs a credential copied
   * into a slot the running configuration does not read and the box told to
   * restart — which is `apply`'s job, not `set`'s.
   */
  test("switching to a keyed provider is staged, not applied", async () => {
    const { hermetic } = seeded();
    const next = await hermetic.agents.set({ name: "fathom", provider: "openrouter" });
    expect(next.provider).toBe("bedrock");
    expect(next.pending).toMatchObject({
      provider: "openrouter",
      profile_id: FIXTURE_PROFILE_IDS.openrouter,
      profile_revision: 1,
      model: "deepseek/deepseek-v4.1-flash",
      credential_ref: `provider-key-${FIXTURE_PROFILE_IDS.openrouter}-r1`,
    });
  });

  /** A switch resets the model: a model id from one catalog aimed at another
   * provider's endpoint is not a setting worth carrying over. */
  test("a profile switch resets the model unless one is stated in the same call", async () => {
    const { hermetic } = seeded();
    // A model the fleet's role may actually invoke: `fathom` is on Bedrock, and
    // a bare `--model` on an unstaged row is checked against the grant.
    await hermetic.agents.set({ name: "fathom", model: "zai.glm-4.7-flash" });
    const reset = await hermetic.agents.set({ name: "fathom", provider_profile: "openrouter-cheap" });
    expect(reset.pending?.model).toBe("deepseek/deepseek-v4.1-flash");

    const stated = await hermetic.agents.set({
      name: "fathom",
      provider_profile: "openrouter-cheap",
      model: "stated-in-the-same-call",
    });
    expect(stated.pending?.model).toBe("stated-in-the-same-call");
  });

  /** A refresh is not a switch: it re-pins the same profile and keeps the override. */
  test("--refresh-profile keeps an explicit model override", async () => {
    const { hermetic } = seeded();
    await drain(hermetic.agents.create({ name: "wren", provider_profile: "openrouter-cheap" }));
    await hermetic.agents.set({ name: "wren", model: "an-override" });
    await hermetic.providers.update({ profile: "openrouter-cheap", api_key: "sk-or-v1-FIXTURE-NEW" });

    const next = await hermetic.agents.set({ name: "wren", refresh_profile: true });
    expect(next.pending).toMatchObject({
      profile_id: FIXTURE_PROFILE_IDS.openrouter,
      profile_revision: 2,
      model: "an-override",
      credential_ref: `provider-key-${FIXTURE_PROFILE_IDS.openrouter}-r2`,
    });
  });

  /**
   * A row written before profiles names none, and the answer for it is the
   * profile the fleet designates for its provider — the same rule
   * `providers.list` reports `linked_agents` with, so "which profile is this
   * agent on" has one answer wherever it is asked (§8.3).
   */
  test("--refresh-profile on a legacy row picks up the fleet's designation", async () => {
    const { hermetic } = seeded();
    const next = await hermetic.agents.set({ name: "fathom", refresh_profile: true });
    expect(next.pending).toMatchObject({
      provider: "bedrock",
      profile_id: FIXTURE_PROFILE_IDS.bedrock,
    });
  });

  /**
   * A sibling profile makes the designation ambiguous, but the row still runs
   * on the profile it predates — the oldest of its provider — and a refresh
   * re-pins that one rather than refusing or moving it to the newcomer.
   */
  test("--refresh-profile with an ambiguous designation re-pins the profile it runs on", async () => {
    const { hermetic } = seeded();
    await hermetic.providers.create({
      provider: "bedrock",
      name: "bedrock-spare",
      model: "zai.glm-4.7-flash",
    });
    await hermetic.providers.update({ profile: FIXTURE_PROFILE_IDS.openrouter, default: true });
    const next = await hermetic.agents.set({ name: "fathom", refresh_profile: true });
    expect(next.pending).toMatchObject({ profile_id: FIXTURE_PROFILE_IDS.bedrock });
  });

  /** …and a refusal when its provider has no profile at all, rather than a silent no-op. */
  test("--refresh-profile with no profile of the row's provider is refused", async () => {
    const { backend, hermetic } = seeded();
    const settings = backend.fleetItem!.settings!;
    const { [FIXTURE_PROFILE_IDS.bedrock]: _bedrock, ...rest } = settings.profiles!;
    backend.fleetItem = { ...backend.fleetItem!, settings: { ...settings, profiles: rest } };
    await expect(hermetic.agents.set({ name: "fathom", refresh_profile: true })).rejects.toThrow(
      /not bound to a provider profile/,
    );
  });

  /**
   * §5.1/§8.3: the grant is checked on *every* branch that decides a model, and
   * this is the branch that decides one outright.
   *
   * With a profile change staged the model is checked against the staged
   * binding, and a switch checks the profile's — but a bare `--model` on a row
   * with nothing staged writes `hermes.model` and is therefore the apply as
   * well as the request. A Bedrock model outside the fleet's grant that got
   * through here would boot and then fail every turn with
   * `AccessDeniedException`, with nothing on the laptop having said so.
   */
  test("a bare --model onto an ungranted Bedrock model is MODEL_NOT_GRANTED", async () => {
    const { backend, hermetic } = seeded();
    const before = (await backend.store.agents.get("fathom"))!;
    expect(before.provider).toBe("bedrock");
    expect(before.pending ?? null).toBeNull();

    let error: HermeticError | null = null;
    try {
      await hermetic.agents.set({ name: "fathom", model: "zai.glm-9-ungranted" });
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error?.code).toBe("MODEL_NOT_GRANTED");
    expect(error?.message).toInclude("foundation update");
    // Refused before the write: the row still runs what it was running.
    const after = (await backend.store.agents.get("fathom"))!;
    expect(after.hermes?.model).toBe(before.hermes?.model);
    expect(after.version).toBe(before.version);
  });

  /**
   * The same write through the SDK/HTTP shape, where the model rides inside
   * `hermes` rather than as the top-level `model` the CLI sends: one door, one
   * guard.
   */
  test("hermes.model onto an ungranted Bedrock model is MODEL_NOT_GRANTED too", async () => {
    const { backend, hermetic } = seeded();
    const before = (await backend.store.agents.get("fathom"))!;

    let error: HermeticError | null = null;
    try {
      await hermetic.agents.set({ name: "fathom", hermes: { model: "zai.glm-9-ungranted" } });
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error?.code).toBe("MODEL_NOT_GRANTED");
    const after = (await backend.store.agents.get("fathom"))!;
    expect(after.hermes?.model).toBe(before.hermes?.model);
    expect(after.version).toBe(before.version);
  });

  /** A granted model on the same branch still goes through, so the guard is a guard. */
  test("a bare --model onto a granted Bedrock model is written", async () => {
    const { hermetic } = seeded();
    const next = await hermetic.agents.set({ name: "fathom", model: "zai.glm-4.7-flash" });
    expect(next.hermes?.model).toBe("zai.glm-4.7-flash");
    expect(next.pending ?? null).toBeNull();
  });

  test("refuses an empty patch", async () => {
    const { hermetic } = seeded();
    await expect(hermetic.agents.set({ name: "fathom" })).rejects.toThrow(HermeticError);
  });
});

describe("agents.stop / start", () => {
  test("stop drains through stopping and start goes back to bootstrapping", async () => {
    const { backend, hermetic } = seeded();
    await drain(hermetic.agents.stop("atlas"));
    let agent = (await backend.store.agents.get("atlas"))!;
    expect(agent.status).toBe("stopped");
    expect(agent.tailscale_ip).toBeNull();
    // The name goes with the address. A powered-off box holds neither, and the
    // next boot may be admitted under a different name entirely (§6.5), so a
    // kept `tailscale_dns_name` is a link pointing at a node nothing answers on.
    expect(agent.tailscale_dns_name ?? null).toBeNull();
    // And the daemon version the box last reported: Tailscale's updater runs on
    // the box, so what it was running before it was switched off says nothing
    // about what it will answer with when it comes back.
    expect(agent.tailscale_version ?? null).toBeNull();
    expect(backend.instances.get(agent.resources.instance_id!)!.state).toBe("stopped");

    await drain(hermetic.agents.start("atlas"));
    agent = (await backend.store.agents.get("atlas"))!;
    expect(agent.status).toBe("bootstrapping");
    expect(agent.lock).toBeNull();

    const actions = (await backend.store.events.query("atlas")).map((e) => e.action);
    expect(actions.filter((a) => a === "transition").length).toBeGreaterThanOrEqual(3);
  });

  /**
   * The bug this replaced: `StopInstances` returning means EC2 *accepted* the
   * request, not that the box is off. `stop` wrote `stopped` on that acceptance
   * and finished in two seconds, so the `agent start` an operator typed straight
   * after was refused by EC2 — "not in a state from which it can be started" —
   * while the row and the dashboard both said stopped. §4.3's `stopping` is that
   * window, and the row stays in it until DescribeInstances agrees.
   */
  test("stop waits for the instance to reach stopped before the row says so", async () => {
    const { backend, hermetic } = seeded();
    const instanceId = (await backend.store.agents.get("atlas"))!.resources.instance_id!;
    // The pre-check sees `running`; the wait then sees EC2 taking its time.
    const seen = ["running", "stopping", "stopping", "stopped"];
    const rowWhileStopping: string[] = [];
    let polls = 0;
    backend.compute.describeInstance = async (id: string) => {
      const state = seen[Math.min(polls, seen.length - 1)]!;
      polls += 1;
      if (state === "stopping") {
        rowWhileStopping.push((await backend.store.agents.get("atlas"))!.status);
      }
      return { instance_id: id, state, public_ip: null };
    };

    const events = await drain(hermetic.agents.stop("atlas"));

    expect(polls).toBe(4);
    // The row was honest for every poll EC2 was still working.
    expect(rowWhileStopping).toEqual(["stopping", "stopping"]);
    expect(backend.mutations).toContain("compute.stop");
    expect((await backend.store.agents.get("atlas"))!.status).toBe("stopped");

    const waiting = events.filter((e) => e.message.startsWith("waiting for"));
    expect(waiting).toHaveLength(2);
    expect(waiting[0]!.phase).toBe("instance");
    expect(waiting[0]!.message).toBe(`waiting for ${instanceId} to stop (0s so far)`);
    expect(events.some((e) => e.message === `instance ${instanceId} stopped after 0s`)).toBe(true);
    expect(events.at(-1)!.message).toContain("stopped; the data volume is untouched");
  });

  /**
   * Aborting the wait is not a failure of the stop: EC2 is still shutting the
   * box down. `stopping` is the true answer, and `stop` is re-entrant from
   * there — it joins the wait rather than asking again.
   */
  test("an abort during the wait leaves the row stopping, and a second stop finishes", async () => {
    const { backend, hermetic } = seeded();
    const controller = new AbortController();
    let polls = 0;
    backend.compute.describeInstance = async (id: string) => {
      polls += 1;
      return { instance_id: id, state: polls === 1 ? "running" : "stopping", public_ip: null };
    };

    let code: string | null = null;
    try {
      for await (const e of hermetic.agents.stop("atlas", { signal: controller.signal })) {
        if (e.message.startsWith("waiting for")) controller.abort();
      }
    } catch (e) {
      code = (e as HermeticError).code;
    }
    expect(code).toBe("ABORTED");

    const after = (await backend.store.agents.get("atlas"))!;
    expect(after.status).toBe("stopping");
    expect(after.lock).toBeNull();

    backend.compute.describeInstance = async (id: string) => ({
      instance_id: id,
      state: "stopping",
      public_ip: null,
    });
    // The box finishes on its own while the second stop is waiting.
    let more = 0;
    const events = await drain(
      (async function* () {
        for await (const e of hermetic.agents.stop("atlas")) {
          if (e.message.startsWith("waiting for") && ++more === 2) {
            backend.compute.describeInstance = async (id: string) => ({
              instance_id: id,
              state: "stopped",
              public_ip: null,
            });
          }
          yield e;
        }
      })(),
    );

    // Already `stopping`, so the second run never re-sends StopInstances.
    expect(events.some((e) => e.message.includes("is already stopping"))).toBe(true);
    expect((await backend.store.agents.get("atlas"))!.status).toBe("stopped");
  });

  test("an instance that is already terminated is a warning, not a stop", async () => {
    const { backend, hermetic } = seeded();
    const instanceId = (await backend.store.agents.get("atlas"))!.resources.instance_id!;
    backend.compute.describeInstance = async (id: string) => ({
      instance_id: id,
      state: "terminated",
      public_ip: null,
    });
    backend.resetMutations();

    const events = await drain(hermetic.agents.stop("atlas"));

    expect(backend.mutations).not.toContain("compute.stop");
    expect(events.some((e) => e.message === `instance ${instanceId} is already terminated`)).toBe(true);
    expect((await backend.store.agents.get("atlas"))!.status).toBe("stopped");
  });

  /**
   * The mirror of the terminated pre-check: the instance goes away *during* the
   * wait. Nothing is left running, which is all `stop` promised, so it says so
   * and finishes rather than waiting for a `stopped` that will never come.
   */
  test("an instance that disappears mid-wait ends the wait with a warning", async () => {
    const { backend, hermetic } = seeded();
    let polls = 0;
    backend.compute.describeInstance = async (id: string) => {
      polls += 1;
      if (polls === 1) return { instance_id: id, state: "running", public_ip: null };
      if (polls === 2) return { instance_id: id, state: "stopping", public_ip: null };
      return null;
    };

    const events = await drain(hermetic.agents.stop("atlas"));

    expect(events.some((e) => e.message.includes("is gone; nothing left to stop"))).toBe(true);
    expect(events.find((e) => e.message.includes("nothing left to stop"))!.level).toBe("warn");
    expect((await backend.store.agents.get("atlas"))!.status).toBe("stopped");
  });

  /**
   * `describeInstance` returns `null` for two different worlds, and one of them
   * is EC2's own eventual consistency: `InvalidInstanceID.NotFound` about an
   * instance that very much exists, most likely in the seconds right after
   * `StopInstances` — which is exactly when this wait is polling. Concluding
   * "gone" on one unlucky read would write `stopped` over a running box, the
   * lie the wait exists to prevent. Two consecutive misses are an answer; one
   * is just another iteration.
   */
  test("a single missed poll mid-wait is not 'gone'; the wait reads again", async () => {
    const { backend, hermetic } = seeded();
    const seen: (string | null)[] = ["running", null, "stopping", "stopped"];
    let polls = 0;
    backend.compute.describeInstance = async (id: string) => {
      const state = seen[Math.min(polls, seen.length - 1)]!;
      polls += 1;
      return state === null ? null : { instance_id: id, state, public_ip: null };
    };

    const events = await drain(hermetic.agents.stop("atlas"));

    expect(polls).toBe(4);
    expect(events.some((e) => e.message.includes("nothing left to stop"))).toBe(false);
    expect(events.some((e) => e.message.includes("reading again before calling it gone"))).toBe(true);
    expect((await backend.store.agents.get("atlas"))!.status).toBe("stopped");
  });

  /**
   * `shutting-down` is not a slow stop; it is a *terminate* somebody else
   * asked for, and it will never reach `stopped`. Writing the row `stopped`
   * would name a box that is being deleted as one an operator can `start`.
   */
  test("an instance terminating mid-wait is a CONFLICT and leaves the row stopping", async () => {
    const { backend, hermetic } = seeded();
    const instanceId = (await backend.store.agents.get("atlas"))!.resources.instance_id!;
    let polls = 0;
    backend.compute.describeInstance = async (id: string) => {
      polls += 1;
      return {
        instance_id: id,
        state: polls === 1 ? "running" : "shutting-down",
        public_ip: null,
      };
    };

    let err: HermeticError | null = null;
    try {
      await drain(hermetic.agents.stop("atlas"));
    } catch (e) {
      err = e as HermeticError;
    }
    expect(err?.code).toBe("CONFLICT");
    expect(err?.message).toContain(`instance ${instanceId} is shutting down (terminating)`);
    expect(err?.message).toContain("hermetic agent recreate");

    // `unwind` released the lock; the row stays where the truth left it.
    const after = (await backend.store.agents.get("atlas"))!;
    expect(after.status).toBe("stopping");
    expect(after.lock).toBeNull();
    const history = await backend.store.events.query("atlas");
    expect(history.some((e) => e.detail === "stop failed (CONFLICT)")).toBe(true);
  });

  /**
   * §6.3: a start reboots the *same* root disk, so the stage markers are still
   * there and the unit's re-run is a no-op resume — `bootstrap` must survive,
   * unlike on a `recreate`. The `command`, though, was addressed to the run that
   * just ended; left behind unacknowledged it would refuse every future
   * `agent rerun` with CONFLICT (§6.5).
   */
  test("start clears the stale command and keeps the bootstrap progress", async () => {
    const { backend, hermetic } = seeded();
    await drain(hermetic.agents.stop("atlas"));
    const stopped = (await backend.store.agents.get("atlas"))!;
    const bootstrap = {
      hermeticd_version: FIXTURE_HERMETICD_VERSION,
      stages: [{ id: "01-tailscale", status: "ok" as const, attempt: 1 }],
      current: null,
      started_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-01T00:05:00.000Z",
      last_command_id: "cmd-acked-0001",
    };
    const command = {
      id: "cmd-stale-0002",
      action: "rerun" as const,
      issued_by: "operator@example.com",
      issued_at: "2026-09-01T00:00:00.000Z",
    };
    await backend.store.agents.update("atlas", stopped.version, {
      bootstrap,
      command,
      // A reading from the box `stop` then powered off.
      health: { hermes: true, tailscale: true, disk: true },
    });

    await drain(hermetic.agents.start("atlas"));

    const started = (await backend.store.agents.get("atlas"))!;
    expect(started.status).toBe("bootstrapping");
    expect(started.command ?? null).toBeNull();
    expect(started.health ?? null).toBeNull();
    expect(started.bootstrap).toEqual(bootstrap);
    expect(started.bootstrap!.last_command_id).toBe("cmd-acked-0001");
  });

  /**
   * The shortcut is still a shortcut — but it is taken on EC2's word, not the
   * row's. `describeInstance` is a read and records no mutation, so "mutates
   * nothing" is unchanged; what changed is that something looked.
   */
  test("stopping an already stopped agent asks EC2 first, then mutates nothing", async () => {
    const { backend, hermetic } = seeded();
    const row = (await backend.store.agents.get("juniper"))!;
    const asked: string[] = [];
    const describe = backend.compute.describeInstance;
    backend.compute.describeInstance = async (id: string) => {
      asked.push(id);
      return describe(id);
    };
    backend.resetMutations();

    const events = await drain(hermetic.agents.stop("juniper"));

    expect(events.at(-1)?.message).toContain("already stopped");
    expect(asked).toEqual([row.resources.instance_id ?? row.instance_id!]);
    expect(backend.mutations).toEqual([]);
  });

  /**
   * The bug the shortcut hid: a `start` whose transition write failed, or a box
   * started from the console, leaves a running instance under a row that says
   * `stopped`. `stop` used to no-op on it forever while it billed.
   */
  test("a row that says stopped over a running instance still stops the box", async () => {
    const { backend, hermetic } = seeded();
    const row = (await backend.store.agents.get("juniper"))!;
    const instanceId = row.resources.instance_id ?? row.instance_id!;
    // The row's account of reality is the stale half: EC2 has it running.
    backend.instances.set(instanceId, {
      instance_id: instanceId,
      state: "running",
      public_ip: "203.0.113.40",
      agent: "juniper",
      fleet_id: FIXTURE_CONFIG.fleet_id,
    });
    backend.resetMutations();

    const events = await drain(hermetic.agents.stop("juniper"));

    expect(backend.mutations).toContain("compute.stop");
    expect(backend.instances.get(instanceId)!.state).toBe("stopped");
    expect(events.some((e) => e.level === "warn" && e.message.includes("recorded as stopped"))).toBe(
      true,
    );

    const after = (await backend.store.agents.get("juniper"))!;
    expect(after.status).toBe("stopped");
    expect(after.lock ?? null).toBeNull();
    // §4.3 has no `stopped → stopping` edge and this must not invent one: the
    // row was already where the op was going, so no transition was written.
    const transitions = (await backend.store.events.query("juniper")).filter(
      (e) => e.action === "transition",
    );
    expect(transitions.map((e) => e.to_status)).not.toContain("stopping");
    // But the disagreement itself is on the history, which is where an operator
    // asking "why did my stopped agent bill me" would look.
    expect(
      (await backend.store.events.query("juniper")).some(
        (e) => e.action === "stop" && (e.detail ?? "").includes("recorded as stopped"),
      ),
    ).toBe(true);
  });

  /**
   * The drift check must only act on states `StopInstances` can act on. A box
   * already `shutting-down` under somebody's terminate is not one of them:
   * asking EC2 to stop it earns an `IncorrectInstanceState` that names neither
   * the agent nor the fix, for a row that is already right about the box not
   * running.
   */
  test("a stopped row over a shutting-down instance stops nothing and says why", async () => {
    const { backend, hermetic } = seeded();
    const row = (await backend.store.agents.get("juniper"))!;
    const instanceId = row.resources.instance_id ?? row.instance_id!;
    backend.instances.set(instanceId, {
      instance_id: instanceId,
      state: "shutting-down",
      public_ip: null,
      agent: "juniper",
      fleet_id: FIXTURE_CONFIG.fleet_id,
    });
    backend.resetMutations();

    const events = await drain(hermetic.agents.stop("juniper"));

    expect(backend.mutations).toEqual([]);
    expect(events.some((e) => e.level === "warn" && e.message.includes("shutting-down"))).toBe(true);
    expect(events.at(-1)?.message).toContain("already stopped");
  });

  test("a state EC2 has invented since is left alone rather than stopped", async () => {
    const { backend, hermetic } = seeded();
    const row = (await backend.store.agents.get("juniper"))!;
    const instanceId = row.resources.instance_id ?? row.instance_id!;
    backend.instances.set(instanceId, {
      instance_id: instanceId,
      // Not in EC2's vocabulary today. The allow-list is the point: a state
      // nobody here has heard of is not one to send a stop into.
      state: "quarantined",
      public_ip: null,
      agent: "juniper",
    });
    backend.resetMutations();

    await drain(hermetic.agents.stop("juniper"));
    expect(backend.mutations).toEqual([]);
  });

  /**
   * The extra read must not be able to break a command that needed no read at
   * all: a throttle or an expired session turning "your stopped agent is
   * stopped" into a failed op would be a worse bug than the one the read fixes.
   */
  test("a describe that fails falls back to the old offline answer", async () => {
    const { backend, hermetic } = seeded();
    backend.compute.describeInstance = async () => {
      throw new HermeticError("INTERNAL", "Request limit exceeded", {
        aws_error: "RequestLimitExceeded",
      });
    };
    backend.resetMutations();

    const events = await drain(hermetic.agents.stop("juniper"));

    expect(events.at(-1)?.progress).toBe(1);
    expect(events.at(-1)?.message).toContain("could not be asked");
    expect(events.at(-1)?.level).toBe("warn");
    expect(backend.mutations).toEqual([]);
    expect((await backend.store.agents.get("juniper"))!.status).toBe("stopped");
  });

  test("starting a ready agent is an invalid transition", async () => {
    const { hermetic } = seeded();
    let code: string | null = null;
    try {
      await drain(hermetic.agents.start("atlas"));
    } catch (e) {
      code = (e as HermeticError).code;
    }
    expect(code).toBe("INVALID_TRANSITION");
  });
});

describe("agents.reboot", () => {
  test("one RebootInstances; the instance, the row's status and the volume all stay", async () => {
    const { backend, hermetic } = seeded();
    const before = (await backend.store.agents.get("atlas"))!;
    backend.resetMutations();

    const view = await hermetic.agents.reboot({ name: "atlas" });

    expect(view.status).toBe(before.status);
    const after = (await backend.store.agents.get("atlas"))!;
    expect(after.status).toBe(before.status);
    expect(after.resources.instance_id).toBe(before.resources.instance_id!);
    expect(after.volume_id).toBe(before.volume_id!);
    // Still running: a reboot never leaves the state, which is what separates
    // it from stop+start.
    expect(backend.instances.get(after.resources.instance_id!)!.state).toBe("running");
    expect(backend.mutations).toContain("compute.reboot");
    expect(backend.mutations).not.toContain("compute.terminate");
    expect(backend.mutations).not.toContain("compute.stop");

    const actions = (await backend.store.events.query("atlas")).map((e) => e.action);
    expect(actions).toContain("reboot");
  });

  /** The readings all describe the box that just went down. */
  test("the stale heartbeat, health and command are cleared", async () => {
    const { backend, hermetic } = seeded();
    const before = (await backend.store.agents.get("atlas"))!;
    await backend.store.agents.update("atlas", before.version, {
      health: { hermes: true, tailscale: true, disk: true },
      last_heartbeat: "2026-09-01T00:00:00.000Z",
      command: {
        id: "cmd-stale-0003",
        action: "rerun" as const,
        issued_by: "operator@example.com",
        issued_at: "2026-09-01T00:00:00.000Z",
      },
    });

    await hermetic.agents.reboot({ name: "atlas" });

    const after = (await backend.store.agents.get("atlas"))!;
    expect(after.health ?? null).toBeNull();
    expect(after.last_heartbeat ?? null).toBeNull();
    expect(after.command ?? null).toBeNull();
  });

  test("a stopped agent is refused, and told to start it", async () => {
    const { hermetic } = seeded();
    let err: HermeticError | null = null;
    try {
      await hermetic.agents.reboot({ name: "juniper" });
    } catch (e) {
      err = e as HermeticError;
    }
    expect(err?.code).toBe("INVALID_TRANSITION");
    expect(err?.message).toContain("agent start");
  });
});

describe("agents.recreate", () => {
  test("terminates the instance, keeps the volume, launches a new one", async () => {
    const { backend, hermetic } = seeded();
    const before = (await backend.store.agents.get("atlas"))!;
    await drain(hermetic.agents.recreate({ name: "atlas", yes: true }));
    const after = (await backend.store.agents.get("atlas"))!;

    expect(after.status).toBe("bootstrapping");
    expect(after.volume_id).toBe(before.volume_id!);
    expect(backend.volumes.has(before.volume_id!)).toBe(true);
    expect(after.instance_id).not.toBe(before.instance_id);
    expect(backend.instances.get(before.instance_id!)!.state).toBe("terminated");
    expect(after.lock).toBeNull();
  });

  /**
   * A recreate is a first boot on the same volume: it runs the stages from the
   * beginning, on whatever release the fleet manifest names now. The previous
   * boot's progress — and any command it never acked — must not survive into it
   * and be read as this one's (§4.2).
   */
  test("stamps the fleet's release and clears the previous boot's state", async () => {
    const { backend, hermetic } = seeded();
    // `heron` is the seeded failure: an older hermeticd, a failed stage, and —
    // as of the rerun below — an unacked command.
    await hermetic.agents.rerun({ name: "heron" });
    const before = (await backend.store.agents.get("heron"))!;
    expect(before.hermeticd_version).toBe("0.4.0");
    expect(before.bootstrap).not.toBeNull();
    expect(before.command).not.toBeNull();

    await drain(hermetic.agents.recreate({ name: "heron", yes: true }));

    const after = (await backend.store.agents.get("heron"))!;
    expect(after.status).toBe("bootstrapping");
    expect(after.hermeticd_version).toBe(FIXTURE_HERMETICD_VERSION);
    expect(after.bootstrap).toBeNull();
    expect(after.command).toBeNull();
  });

  /**
   * Create's find-or-launch is a resume; recreate's job is a *new* instance, so
   * it must never adopt one. The case that matters is a row that lost its
   * `instance_id` — `doctor`'s `instance_unrecorded` drift — where there is
   * nothing to terminate by id but a box is still tagged for the agent.
   */
  test("terminates a stray tagged instance instead of adopting it", async () => {
    const { backend, hermetic } = seeded();
    const before = (await backend.store.agents.get("atlas"))!;
    const stray = before.instance_id!;
    // The row forgets the instance — both places it could be named — while AWS
    // still has it, tagged.
    await backend.store.agents.update("atlas", before.version, {
      instance_id: null,
      resources: { ...before.resources, instance_id: undefined },
    });

    backend.resetMutations();
    const events = await drain(hermetic.agents.recreate({ name: "atlas", yes: true }));

    const after = (await backend.store.agents.get("atlas"))!;
    expect(backend.instances.get(stray)!.state).toBe("terminated");
    expect(after.instance_id).not.toBe(stray);
    expect(after.status).toBe("bootstrapping");
    expect(backend.mutations.filter((m) => m === "compute.runInstance")).toHaveLength(1);
    expect(events.some((e) => e.message.includes("still tagged for atlas"))).toBe(true);
  });

  /**
   * Two boxes can end up wearing one agent tag — two recreates racing, or a
   * launch whose id was never persisted followed by another. Sweeping only the
   * first would leave the other billed and on the tailnet for good, since the
   * row names neither.
   */
  test("terminates every stray tagged instance, not just the first", async () => {
    const { backend, hermetic } = seeded();
    const before = (await backend.store.agents.get("atlas"))!;
    const first = before.instance_id!;
    // A second box wearing the same tag, and a row that names neither — so both
    // are found by the tag sweep rather than one of them by id.
    backend.instances.set("i-double00000000", {
      instance_id: "i-double00000000",
      state: "running",
      public_ip: "203.0.113.77",
      agent: "atlas",
      fleet_id: FIXTURE_CONFIG.fleet_id,
    });
    await backend.store.agents.update("atlas", before.version, {
      instance_id: null,
      resources: { ...before.resources, instance_id: undefined },
    });

    const events = await drain(hermetic.agents.recreate({ name: "atlas", yes: true }));

    expect(backend.instances.get(first)!.state).toBe("terminated");
    expect(backend.instances.get("i-double00000000")!.state).toBe("terminated");
    const warned = events.filter((e) => e.message.includes("still tagged for atlas"));
    expect(warned).toHaveLength(2);
    expect(warned.map((e) => e.message).join(" ")).toContain(first);
    expect(warned.map((e) => e.message).join(" ")).toContain("i-double00000000");
    const after = (await backend.store.agents.get("atlas"))!;
    expect(after.instance_id).not.toBe(first);
    expect(after.instance_id).not.toBe("i-double00000000");
  });

  test("refuses an agent that is not settled", async () => {
    const { backend, hermetic } = seeded();
    await backend.store.agents.update("heron", backend.agents.get("heron")!.version, {
      status: "destroying",
    });
    let code: string | null = null;
    try {
      await drain(hermetic.agents.recreate({ name: "heron", yes: true }));
    } catch (e) {
      code = (e as HermeticError).code;
    }
    expect(code).toBe("INVALID_TRANSITION");
  });

  /**
   * The dead end this closes: `stop` refuses with CONFLICT when EC2 says the
   * instance is `shutting-down` — a terminate this run did not ask for, which
   * will never reach `stopped` — leaving the row in `stopping` and telling the
   * operator to run `hermetic agent recreate`. Recreate then refused `stopping`
   * with INVALID_TRANSITION, so the one command the error named was the one
   * command that could not be run.
   */
  test("recreates an agent left in stopping by a terminate it did not ask for", async () => {
    const { backend, hermetic } = seeded();
    const before = (await backend.store.agents.get("atlas"))!;
    await backend.store.agents.update("atlas", before.version, { status: "stopping" });

    await drain(hermetic.agents.recreate({ name: "atlas", yes: true }));

    const after = (await backend.store.agents.get("atlas"))!;
    expect(after.status).toBe("bootstrapping");
    expect(after.instance_id).not.toBe(before.instance_id);
    expect(backend.instances.get(before.instance_id!)!.state).toBe("terminated");
    expect(after.lock).toBeNull();
    // It drained: `stopping → stopped → bootstrapping`, over edges §4.3 already
    // has. The `stopping` re-entry writes no history event, so the row is only
    // recorded moving on from where it already was.
    const moves = (await backend.store.events.query("atlas"))
      .filter((e) => e.action === "transition")
      .map((e) => `${e.from_status}→${e.to_status}`);
    expect(moves.slice(-2)).toEqual(["stopping→stopped", "stopped→bootstrapping"]);
  });

  /**
   * §6.5: the replacement re-registers with Tailscale and may well be admitted
   * as `<name>-2`, because the device it replaced still holds the canonical
   * name. Whatever it ends up called, the *old* name is not it — and a row that
   * kept it points every dashboard link, and the drawer's stale-device note, at
   * the node this run just terminated, until the first heartbeat lands.
   */
  test("clears the terminated node's tailnet identity on both paths", async () => {
    for (const name of ["atlas", "heron"] as const) {
      const { backend, hermetic } = seeded();
      const before = (await backend.store.agents.get(name))!;
      // `atlas` is ready and drains through `stopping`; `heron` is in `error`
      // and goes straight back to `bootstrapping` — the path that cleared
      // nothing at all.
      expect(before.tailscale_dns_name).toBeTruthy();
      expect(before.tailscale_version).toBeTruthy();

      await drain(hermetic.agents.recreate({ name, yes: true }));

      const after = (await backend.store.agents.get(name))!;
      expect(after.status).toBe("bootstrapping");
      expect(after.tailscale_dns_name ?? null).toBeNull();
      expect(after.tailscale_ip).toBeNull();
      expect(after.tailscale_version ?? null).toBeNull();
      expect(after.last_heartbeat ?? null).toBeNull();
      expect(after.health).toBeNull();
      expect(after.metrics).toBeNull();
    }
  });

  /**
   * §6.5: the data volume is the agent (§1), so recreate resolves the disk the
   * row names by id and proves it before it terminates anything. It used to
   * find the disk by tag scan alone, with a `CreateVolume` behind the scan —
   * which turned every way a tag can drift into a silent swap for an empty
   * disk, under a row rewritten to point at it, reported as "recreated on the
   * same volume".
   */
  describe("the recorded data volume", () => {
    /** The drift: the disk is there, and its `agent` tag names somebody else. */
    function driftTag(backend: MemoryBackend, volumeId: string, agent: string | null): void {
      const vol = backend.volumes.get(volumeId)!;
      backend.volumes.set(volumeId, { ...vol, agent });
    }

    test("a recorded disk whose tags have drifted refuses, and nothing is built", async () => {
      const { backend, hermetic } = seeded();
      const before = (await backend.store.agents.get("atlas"))!;
      const volumeId = before.resources.volume_id!;
      driftTag(backend, volumeId, "someone-elses");
      backend.resetMutations();

      let code: string | null = null;
      try {
        await drain(hermetic.agents.recreate({ name: "atlas", yes: true }));
      } catch (e) {
        code = (e as HermeticError).code;
      }

      expect(code).toBe("RESOURCE_NOT_OWNED");
      expect(backend.mutations).not.toContain("compute.createVolume");
      // Before the terminate, so the box the agent was running on is still there.
      expect(backend.mutations).not.toContain("compute.terminate");
      const after = (await backend.store.agents.get("atlas"))!;
      expect(after.status).toBe(before.status);
      expect(after.resources.volume_id).toBe(volumeId);
      expect(after.instance_id).toBe(before.instance_id);
      expect(after.lock).toBeNull();
    });

    test("a recorded disk EC2 no longer has refuses with VOLUME_MISSING", async () => {
      const { backend, hermetic } = seeded();
      const before = (await backend.store.agents.get("atlas"))!;
      const volumeId = before.resources.volume_id!;
      backend.volumes.delete(volumeId);
      backend.resetMutations();

      let error: HermeticError | null = null;
      try {
        await drain(hermetic.agents.recreate({ name: "atlas", yes: true }));
      } catch (e) {
        error = e as HermeticError;
      }

      expect(error?.code).toBe("VOLUME_MISSING");
      // The message is the recovery: the id that is gone, and the way back.
      expect(error?.message).toContain(volumeId);
      expect(error?.message).toContain("hermetic volume ls");
      expect(error?.message).toContain("--volume");
      expect(backend.mutations).not.toContain("compute.createVolume");
      expect(backend.mutations).not.toContain("compute.terminate");
      const after = (await backend.store.agents.get("atlas"))!;
      expect(after.resources.volume_id).toBe(volumeId);
      expect(after.status).toBe(before.status);
    });

    test("a recorded disk that is still the agent's is reused without a scan", async () => {
      const { backend, hermetic } = seeded();
      const before = (await backend.store.agents.get("atlas"))!;
      const volumeId = before.resources.volume_id!;
      backend.resetMutations();

      await drain(hermetic.agents.recreate({ name: "atlas", yes: true }));

      const after = (await backend.store.agents.get("atlas"))!;
      expect(after.volume_id).toBe(volumeId);
      expect(after.resources.volume_id).toBe(volumeId);
      expect(backend.volumes.has(volumeId)).toBe(true);
      expect(backend.mutations).not.toContain("compute.createVolume");
    });

    /**
     * The one row discovery is still for: one that records no disk at all. The
     * tag scan finds it, and only a scan that finds nothing creates.
     */
    test("a row recording no disk falls back to the tag scan, then to creating one", async () => {
      const { backend, hermetic } = seeded();
      const before = (await backend.store.agents.get("atlas"))!;
      const volumeId = before.resources.volume_id!;
      await backend.store.agents.update("atlas", before.version, {
        volume_id: null,
        resources: { ...before.resources, volume_id: undefined },
      });
      backend.resetMutations();

      await drain(hermetic.agents.recreate({ name: "atlas", yes: true }));

      expect((await backend.store.agents.get("atlas"))!.volume_id).toBe(volumeId);
      expect(backend.mutations).not.toContain("compute.createVolume");

      // And with the tag gone too, there is nothing to find and one is made.
      const { backend: bare, hermetic: fresh } = seeded();
      const row = (await bare.store.agents.get("atlas"))!;
      const orphan = row.resources.volume_id!;
      await bare.store.agents.update("atlas", row.version, {
        volume_id: null,
        resources: { ...row.resources, volume_id: undefined },
      });
      bare.volumes.delete(orphan);
      bare.resetMutations();

      await drain(fresh.agents.recreate({ name: "atlas", yes: true }));

      expect(bare.mutations).toContain("compute.createVolume");
      const made = (await bare.store.agents.get("atlas"))!.volume_id!;
      expect(made).not.toBe(orphan);
      expect(bare.volumes.has(made)).toBe(true);
    });
  });
});

/**
 * §6.5/§6.7: the tailnet cleanup that gives the canonical MagicDNS name back.
 * The fixture seeds `corvid` as an agent whose predecessor still holds
 * `corvid.<tailnet>` — two devices, one OS hostname — so these run against the
 * shape a real recreated fleet is actually in.
 */
describe("tailnet device cleanup", () => {
  const hostnames = (backend: MemoryBackend): string[] =>
    (backend.tailscaleDevices ?? []).map((d) => d.name);

  /**
   * Order is the whole point: the replacement is admitted as `corvid` only if
   * nothing holds the name at the moment it joins, and the auth key is what it
   * joins with. A delete after the mint would be a race the corpse wins.
   */
  test("recreate deletes the agent's devices before it mints the new auth key", async () => {
    const { backend, hermetic } = seeded();
    expect(hostnames(backend)).toContain("fxtr0001-corvid.hermetic.ts.net");
    expect(hostnames(backend)).toContain("fxtr0001-corvid-2.hermetic.ts.net");

    backend.resetMutations();
    const events = await drain(hermetic.agents.recreate({ name: "corvid", yes: true }));

    expect(hostnames(backend)).not.toContain("fxtr0001-corvid.hermetic.ts.net");
    expect(hostnames(backend)).not.toContain("fxtr0001-corvid-2.hermetic.ts.net");
    // Every other agent's device is untouched.
    expect(hostnames(backend)).toContain("fxtr0001-atlas.hermetic.ts.net");

    const deletes = backend.mutations.indexOf("tailscale.deleteDevice");
    const mint = backend.mutations.indexOf("tailscale.mintAuthKey");
    expect(deletes).toBeGreaterThan(-1);
    expect(deletes).toBeLessThan(mint);

    const tailnet = events.filter((e) => e.phase === "tailnet");
    expect(tailnet.map((e) => e.message)).toEqual([
      "removed tailnet device fxtr0001-corvid-2.hermetic.ts.net",
      "removed tailnet device fxtr0001-corvid.hermetic.ts.net",
    ]);
    expect(tailnet.every((e) => (e.level ?? "info") === "info")).toBe(true);
  });

  test("destroy deletes the device, so the next agent of that name gets it", async () => {
    const { backend, hermetic } = seeded();
    const events = await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));
    expect(hostnames(backend)).not.toContain("fxtr0001-atlas.hermetic.ts.net");
    expect(events.filter((e) => e.phase === "tailnet").map((e) => e.message)).toEqual([
      "removed tailnet device fxtr0001-atlas.hermetic.ts.net",
    ]);
  });

  /**
   * The device is matched on the OS hostname *and* the fleet's tag. A node
   * somebody else put in this tailnet under the same hostname is not ours, and
   * hermetic does not delete other people's machines (§1).
   */
  /**
   * §5/§6.5: a fleet that has taken v4 but whose *nodes* have not been recreated
   * yet still has boxes on the tailnet under their older names. The row's own
   * `tailscale_dns_name` is what says so — it is what that node reported about
   * itself — and it is the only evidence that ties a particular device to this
   * row. A foreign `atlas` has no row here, so nothing points at it.
   */
  test("a migrated fleet deletes its own bare-named node, and no foreign one", async () => {
    const { backend, hermetic } = seeded();
    const atlas = backend.agents.get("atlas")!;
    // The pre-v3 shape: the box came up as `atlas`, and the row records it.
    backend.agents.set("atlas", { ...atlas, tailscale_dns_name: "atlas.hermetic.ts.net" });
    backend.tailscaleDevices = (backend.tailscaleDevices ?? []).map((d) =>
      d.hostname === "fxtr0001-atlas"
        ? { ...d, hostname: "atlas", name: "atlas.hermetic.ts.net", online: false }
        : d,
    );
    // Another fleet's pre-v3 `atlas`, in the same tailnet, with the same tag
    // and the same hostname — and no row in this fleet naming it.
    backend.tailscaleDevices.push({
      id: "nodeFIXTUREforeign",
      name: "atlas-7.hermetic.ts.net",
      hostname: "atlas",
      addresses: ["100.64.77.7"],
      online: false,
      tags: ["tag:hermetic"],
    });

    await drain(hermetic.agents.recreate({ name: "atlas", yes: true }));
    const left = (backend.tailscaleDevices ?? []).map((d) => d.name);
    // Ours went; theirs did not.
    expect(left).not.toContain("atlas.hermetic.ts.net");
    expect(left).toContain("atlas-7.hermetic.ts.net");
  });

  /** A row that has never reported has no device to point at, and none is guessed. */
  test("a row with no reported name only matches its canonical cloud name", async () => {
    const { backend, hermetic } = seeded();
    const atlas = backend.agents.get("atlas")!;
    backend.agents.set("atlas", { ...atlas, tailscale_dns_name: null });
    backend.tailscaleDevices!.push({
      id: "nodeFIXTUREbare",
      name: "atlas.hermetic.ts.net",
      hostname: "atlas",
      addresses: ["100.64.77.8"],
      online: false,
      tags: ["tag:hermetic"],
    });

    await drain(hermetic.agents.recreate({ name: "atlas", yes: true }));
    const left = (backend.tailscaleDevices ?? []).map((d) => d.name);
    expect(left).toContain("atlas.hermetic.ts.net");
    expect(left).not.toContain("fxtr0001-atlas.hermetic.ts.net");
  });

  test("a device with the same hostname but not the fleet's tag is never deleted", async () => {
    const { backend, hermetic } = seeded();
    backend.tailscaleDevices!.push({
      id: "nodeFIXTUREstranger",
      name: "fxtr0001-atlas-9.hermetic.ts.net",
      hostname: "fxtr0001-atlas",
      addresses: ["100.64.99.9"],
      online: false,
      tags: ["tag:someone-else"],
    });
    await drain(hermetic.agents.recreate({ name: "atlas", yes: true }));
    expect(hostnames(backend)).toEqual(expect.arrayContaining(["fxtr0001-atlas-9.hermetic.ts.net"]));
    expect(hostnames(backend)).not.toContain("fxtr0001-atlas.hermetic.ts.net");
  });

  /**
   * A destroy against the default three-minute tailnet wait, on a tailnet that
   * lags: every `listDevices` moves the fixture's clock ten seconds, and from
   * the `offlineAfter`-th list on, the devices named in `going` read offline.
   * The instance is already gone, so the double's terminate never flips them
   * itself — only the lag does.
   */
  function lagging(going: string[], offlineAfter: number) {
    const backend = seedFixtureFleet(new MemoryBackend());
    const hermetic = testHermetic({
      backend,
      config: FIXTURE_CONFIG,
      attach: { pollMs: 1, progressMs: 0 },
    });
    const atlas = backend.agents.get("atlas")!;
    backend.instances.delete(atlas.instance_id!);
    const list = backend.tailscale.listDevices;
    let lists = 0;
    backend.tailscale.listDevices = async () => {
      lists += 1;
      backend.advance(10_000);
      if (lists >= offlineAfter) {
        backend.tailscaleDevices = backend.tailscaleDevices!.map((d) =>
          going.includes(d.name) ? { ...d, online: false } : d,
        );
      }
      return list();
    };
    return { backend, hermetic, lists: () => lists };
  }

  /**
   * §6.7: Tailscale notices a stopped node late, so after the termination wait
   * the destroy polls until the device reads offline and only then sweeps —
   * deleting it, so the next node of the name is not pushed onto `<name>-2`.
   * Other agents' devices, online ones included, are untouched.
   */
  test("destroy waits for a lagging device to go offline, then deletes it", async () => {
    const device = "fxtr0001-atlas.hermetic.ts.net";
    // One list for the first pass, three more online, offline on the fifth.
    const { backend, hermetic, lists } = lagging([device], 5);
    expect(backend.tailscaleDevices!.find((d) => d.name === device)!.online).toBe(true);
    const others = hostnames(backend).filter((h) => h !== device);
    expect(others.length).toBeGreaterThan(0);

    // Kept: the double's volume stays attached to the vanished instance, and
    // the tailnet step is what this test is about, not the detach wait.
    const events = await drain(
      hermetic.agents.destroy({ name: "atlas", yes: true, keep_volume: true }),
    );
    const tailnet = events.filter((e) => e.phase === "tailnet");
    expect(tailnet.map((e) => e.message)).toEqual([
      `waiting up to 3m for ${device} to go offline`,
      `removed tailnet device ${device}`,
    ]);
    expect(tailnet.every((e) => (e.level ?? "info") === "info")).toBe(true);
    expect(lists()).toBe(6);
    expect(hostnames(backend)).not.toContain(device);
    expect(hostnames(backend)).toEqual(others);
    expect(await backend.store.agents.get("atlas")).toBeNull();
  });

  /**
   * A matching device still online when the wait runs out is a machine that is
   * running, and a hostname-plus-tag match is not proof it is the box this
   * destroy terminated — an orphaned node whose instance lost its tags looks
   * the same. It is named and left; the name is released anyway.
   */
  test("a device still online at the deadline is warned about, not deleted", async () => {
    const device = "fxtr0001-atlas.hermetic.ts.net";
    const { backend, hermetic, lists } = lagging([], Infinity);

    const events = await drain(
      hermetic.agents.destroy({ name: "atlas", yes: true, keep_volume: true }),
    );
    const tailnet = events.filter((e) => e.phase === "tailnet");
    expect(tailnet.map((e) => [e.level ?? "info", e.message])).toEqual([
      ["info", `waiting up to 3m for ${device} to go offline`],
      ["warn", `${device} is still online; not deleting a live node`],
    ]);
    // It polled for the whole budget: 180 s at 10 s a list, plus both sweeps.
    expect(lists()).toBeGreaterThan(18);
    expect(hostnames(backend)).toContain(device);
    expect(backend.mutations).not.toContain("tailscale.deleteDevice");
    expect(await backend.store.agents.get("atlas")).toBeNull();
    expect(events.at(-1)!.phase).toBe("done");
  });

  /**
   * The row's `tailscale_dns_name` is written by the box it describes. A
   * compromised or stale box pointing it at another agent's live node must
   * not get that node deleted: the destroy waits for it like any match, and
   * when it is still online at the deadline names it instead. The agent's own
   * device, which does go offline during the wait, is deleted as usual.
   */
  test("a forged tailscale_dns_name cannot get another agent's online node deleted", async () => {
    const own = "fxtr0001-atlas.hermetic.ts.net";
    const { backend, hermetic, lists } = lagging([own], 3);
    const victim = "fxtr0001-bravo.hermetic.ts.net";
    backend.tailscaleDevices = [
      ...backend.tailscaleDevices!.filter((d) => d.name !== victim),
      {
        id: "nodeFIXTUREvictim",
        name: victim,
        hostname: "fxtr0001-bravo",
        addresses: ["100.64.88.8"],
        online: true,
        tags: ["tag:hermetic"],
      },
    ];
    backend.agents.set("atlas", { ...backend.agents.get("atlas")!, tailscale_dns_name: `${victim}.` });

    const events = await drain(
      hermetic.agents.destroy({ name: "atlas", yes: true, keep_volume: true }),
    );

    expect(hostnames(backend)).toContain(victim);
    expect(hostnames(backend)).not.toContain(own);
    const tailnet = events.filter((e) => e.phase === "tailnet");
    expect(tailnet.map((e) => [e.level ?? "info", e.message])).toEqual([
      ["info", `waiting up to 3m for ${own}, ${victim} to go offline`],
      ["info", `removed tailnet device ${own}`],
      ["warn", `${victim} is still online; not deleting a live node`],
    ]);
    // The victim kept the wait going to the deadline after `own` went.
    expect(lists()).toBeGreaterThan(18);
    expect(await backend.store.agents.get("atlas")).toBeNull();
  });

  /**
   * §3.2 rule 2: the tailnet wait is up to three minutes, so the operator's
   * abort has to end it at once — not after the budget, and not by carrying on
   * into the sweep and the release. The device is left and the name is not
   * released.
   */
  test("an abort during the tailnet wait stops the destroy before the release", async () => {
    const device = "fxtr0001-atlas.hermetic.ts.net";
    const { backend, hermetic, lists } = lagging([], Infinity);
    const controller = new AbortController();

    let code: string | null = null;
    let phase: unknown = null;
    try {
      for await (const e of hermetic.agents.destroy(
        { name: "atlas", yes: true, keep_volume: true },
        { signal: controller.signal },
      )) {
        if (e.message.startsWith("waiting up to")) controller.abort();
      }
    } catch (e) {
      code = (e as HermeticError).code;
      phase = (e as HermeticError).details?.["phase"];
    }
    expect(code).toBe("ABORTED");
    expect(phase).toBe("tailnet");
    // The first sweep's list and the wait's first: nothing listed after the abort.
    expect(lists()).toBe(2);
    expect(hostnames(backend)).toContain(device);
    expect(backend.mutations).not.toContain("tailscale.deleteDevice");
    expect(await backend.store.agents.get("atlas")).not.toBeNull();
  });

  /**
   * §6.7: real EC2 accepts the terminate and keeps the box `shutting-down` for
   * a while, and its node stays online on the tailnet until it is really gone.
   * The sweep right after the terminate request cannot delete it; the one
   * after the termination wait can, so the name is free for the next create.
   */
  test("destroy removes a device that only goes offline once the box is terminated", async () => {
    const { backend, hermetic } = seeded();
    const atlas = backend.agents.get("atlas")!;
    const instanceId = atlas.instance_id!;
    const volumeId = atlas.volume_id!;
    const device = "fxtr0001-atlas.hermetic.ts.net";
    expect(backend.tailscaleDevices!.find((d) => d.name === device)!.online).toBe(true);

    backend.compute.terminate = async (id: string) => {
      const inst = backend.instances.get(id)!;
      backend.instances.set(id, { ...inst, state: "shutting-down", public_ip: null });
      const vol = backend.volumes.get(volumeId)!;
      backend.volumes.set(volumeId, { ...vol, state: "available", attached_to: null });
    };
    const describe = backend.compute.describeInstance;
    backend.compute.describeInstance = async (id: string) => {
      const inst = backend.instances.get(id);
      if (id === instanceId && inst?.state === "shutting-down") {
        backend.instances.set(id, { ...inst, state: "terminated" });
        backend.tailscaleDevices = backend.tailscaleDevices!.map((d) =>
          d.name === device ? { ...d, online: false } : d,
        );
      }
      return describe(id);
    };

    const events = await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));

    expect(hostnames(backend)).not.toContain(device);
    const tailnet = events.filter((e) => e.phase === "tailnet");
    expect(tailnet.map((e) => e.message)).toEqual([`removed tailnet device ${device}`]);
    expect(tailnet.every((e) => (e.level ?? "info") === "info")).toBe(true);
    expect(await backend.store.agents.get("atlas")).toBeNull();
  });

  /**
   * A recreate on a real account: EC2 accepts the terminate and keeps the old
   * box `shutting-down` until the `describes`-th describe of it after the
   * terminate, and its node reads online on the tailnet until `offlineAfter`
   * device lists after that (each list moving the clock ten seconds, so the
   * three-minute wait can run out). `log` records, in order, every terminate,
   * every describe of the old instance with the state it answered, every
   * device delete, the auth-key mint and the launch.
   */
  function lingering(describes: number, offlineAfter: number) {
    const backend = seedFixtureFleet(new MemoryBackend());
    const hermetic = testHermetic({
      backend,
      config: FIXTURE_CONFIG,
      attach: { pollMs: 1, progressMs: 0 },
    });
    const old = backend.agents.get("atlas")!.instance_id!;
    const log: string[] = [];
    const terminate = backend.compute.terminate;
    backend.compute.terminate = async (id: string) => {
      log.push(`terminate ${id}`);
      const inst = backend.instances.get(id)!;
      backend.instances.set(id, { ...inst, state: "shutting-down" });
    };
    let asked = 0;
    let terminated = false;
    const describe = backend.compute.describeInstance;
    backend.compute.describeInstance = async (id: string) => {
      if (id === old && backend.instances.get(id)?.state === "shutting-down") {
        asked += 1;
        if (asked >= describes) {
          // EC2 finishes the terminate — the double's own terminate does that,
          // volume detach included — but the node's flag lags behind it.
          const devices = backend.tailscaleDevices!.map((d) => ({ ...d }));
          await terminate(id);
          backend.tailscaleDevices = devices;
          terminated = true;
        }
      }
      const ref = await describe(id);
      if (id === old) log.push(`describe ${id} ${ref?.state ?? "gone"}`);
      return ref;
    };
    const list = backend.tailscale.listDevices;
    let lists = 0;
    backend.tailscale.listDevices = async () => {
      backend.advance(10_000);
      if (terminated) {
        lists += 1;
        if (lists >= offlineAfter) {
          backend.tailscaleDevices = backend.tailscaleDevices!.map((d) =>
            d.hostname === "fxtr0001-atlas" ? { ...d, online: false } : d,
          );
        }
      }
      return list();
    };
    const deleteDevice = backend.tailscale.deleteDevice;
    backend.tailscale.deleteDevice = async (id: string) => {
      log.push(`deleteDevice ${id}`);
      return deleteDevice(id);
    };
    const mint = backend.tailscale.mintAuthKey;
    backend.tailscale.mintAuthKey = async (name: string) => {
      log.push("mintAuthKey");
      return mint(name);
    };
    const run = backend.compute.runInstance;
    backend.compute.runInstance = async (spec) => {
      log.push("runInstance");
      return run(spec);
    };
    return { backend, hermetic, old, log };
  }

  /**
   * §6.5: the replacement may only join once the box it replaces is gone.
   * Launched beside a `shutting-down` predecessor, its node meets the old one
   * still online and is pushed onto `<name>-2` — so the launch waits for the
   * describe that says `terminated`.
   */
  test("recreate waits for the old instance to terminate before launching", async () => {
    const { backend, hermetic, old, log } = lingering(3, 1);

    const events = await drain(hermetic.agents.recreate({ name: "atlas", yes: true }));

    const terminateAt = log.indexOf(`terminate ${old}`);
    const lingeringAt = log.indexOf(`describe ${old} shutting-down`);
    const terminatedAt = log.indexOf(`describe ${old} terminated`);
    const launchAt = log.indexOf("runInstance");
    expect(terminateAt).toBeGreaterThan(-1);
    expect(lingeringAt).toBeGreaterThan(terminateAt);
    expect(terminatedAt).toBeGreaterThan(lingeringAt);
    expect(launchAt).toBeGreaterThan(terminatedAt);
    expect(log.indexOf("mintAuthKey")).toBeGreaterThan(terminatedAt);
    // The old box shows up in the stray listing while it shuts down; it is the
    // one already being waited on, not a stray.
    expect(events.some((e) => e.message.includes("still tagged for atlas"))).toBe(false);
    expect(log.filter((l) => l.startsWith("terminate "))).toEqual([`terminate ${old}`]);
    expect(
      events.some(
        (e) => e.phase === "instance" && e.message.startsWith(`instance ${old} terminated after`),
      ),
    ).toBe(true);
    const after = (await backend.store.agents.get("atlas"))!;
    expect(after.status).toBe("bootstrapping");
    expect(after.instance_id).not.toBe(old);
  });

  /**
   * The node reads online for a while after its machine is `terminated`. The
   * recreate waits for the flag rather than sweeping past it, deletes the
   * device, and only then mints and launches — so the replacement gets the name.
   */
  test("recreate deletes a lagging device once it goes offline, before launching", async () => {
    const device = "fxtr0001-atlas.hermetic.ts.net";
    const { backend, hermetic, log } = lingering(1, 3);
    const id = backend.tailscaleDevices!.find((d) => d.name === device)!.id;

    const events = await drain(hermetic.agents.recreate({ name: "atlas", yes: true }));

    const tailnet = events.filter((e) => e.phase === "tailnet");
    expect(tailnet.map((e) => [e.level ?? "info", e.message])).toEqual([
      ["info", `waiting up to 3m for ${device} to go offline`],
      ["info", `removed tailnet device ${device}`],
    ]);
    const deleteAt = log.indexOf(`deleteDevice ${id}`);
    expect(deleteAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeLessThan(log.indexOf("mintAuthKey"));
    expect(deleteAt).toBeLessThan(log.indexOf("runInstance"));
    expect(hostnames(backend)).not.toContain(device);
    // Progress never runs backwards across the new waits.
    const progress = events.map((e) => e.progress);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });

  /**
   * A device still online when the wait runs out is a running machine as far
   * as anyone can tell, and is not deleted on a guess (§1). It is named once,
   * and the replacement is launched anyway: a node hermetic cannot stop must
   * not hold the recreate hostage.
   */
  test("recreate warns once about a device still online at the deadline, and launches", async () => {
    const device = "fxtr0001-atlas.hermetic.ts.net";
    const { backend, hermetic, log } = lingering(1, Infinity);

    const events = await drain(hermetic.agents.recreate({ name: "atlas", yes: true }));

    const warns = events.filter((e) => e.level === "warn");
    expect(warns.map((e) => [e.phase, e.message])).toEqual([
      ["tailnet", `${device} is still online; not deleting a live node`],
    ]);
    expect(log.some((l) => l.startsWith("deleteDevice"))).toBe(false);
    expect(log.filter((l) => l === "runInstance")).toHaveLength(1);
    expect(hostnames(backend)).toContain(device);
    expect(events.at(-1)!.phase).toBe("done");
    expect((await backend.store.agents.get("atlas"))!.status).toBe("bootstrapping");
  });

  /** Without `devices:core` a destroy says so once, not once per pass. */
  test("destroy with no devices:core scope warns once across both passes", async () => {
    const { backend, hermetic } = seeded();
    backend.tailscaleDevices = null;
    const events = await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));
    const tailnet = events.filter((e) => e.phase === "tailnet");
    expect(tailnet).toHaveLength(1);
    expect(tailnet[0]!.level).toBe("warn");
    expect(tailnet[0]!.message).toContain("devices:core");
    expect(events.at(-1)!.phase).toBe("done");
  });

  /** The fleet whose OAuth client was never re-scoped: one warning, then on. */
  test("no devices:core scope is one warning and a completed op", async () => {
    const { backend, hermetic } = seeded();
    backend.tailscaleDevices = null;
    const events = await drain(hermetic.agents.recreate({ name: "corvid", yes: true }));
    const tailnet = events.filter((e) => e.phase === "tailnet");
    expect(tailnet).toHaveLength(1);
    expect(tailnet[0]!.level).toBe("warn");
    expect(tailnet[0]!.message).toContain("devices:core");
    expect(tailnet[0]!.message).toContain("admin console");
    expect(events.at(-1)!.phase).toBe("done");
    expect((await backend.store.agents.get("corvid"))!.status).toBe("bootstrapping");
  });

  /** A client that can read devices but not write them: the same one warning. */
  test("a forbidden delete warns once and stops trying", async () => {
    const { backend, hermetic } = seeded();
    backend.tailscale.deleteDevice = async (): Promise<TailscaleDeleteOutcome> => "forbidden";
    const events = await drain(hermetic.agents.recreate({ name: "corvid", yes: true }));
    const tailnet = events.filter((e) => e.phase === "tailnet");
    // One, not one per device — corvid has two.
    expect(tailnet).toHaveLength(1);
    expect(tailnet[0]!.message).toContain("devices:core");
    expect(events.at(-1)!.phase).toBe("done");
  });

  /** A device somebody deleted in the console first is the state we wanted. */
  test("a device that is already gone is not news", async () => {
    const { backend, hermetic } = seeded();
    backend.tailscale.deleteDevice = async (): Promise<TailscaleDeleteOutcome> => "not_found";
    const events = await drain(hermetic.agents.recreate({ name: "corvid", yes: true }));
    expect(events.filter((e) => e.phase === "tailnet")).toEqual([]);
    expect(events.at(-1)!.phase).toBe("done");
  });

  /** A tailnet hiccup must never fail a recreate that already killed the box. */
  test("an API failure on the delete is a warning, not a failed op", async () => {
    const { backend, hermetic } = seeded();
    backend.tailscale.deleteDevice = async (): Promise<TailscaleDeleteOutcome> => {
      throw new HermeticError("TAILSCALE_UNAVAILABLE", "tailscale is down (HTTP 502)", {});
    };
    const events = await drain(hermetic.agents.recreate({ name: "corvid", yes: true }));
    const tailnet = events.filter((e) => e.phase === "tailnet");
    expect(tailnet).toHaveLength(1);
    expect(tailnet[0]!.level).toBe("warn");
    expect(tailnet[0]!.message).toContain("could not delete tailnet device");
    expect(tailnet[0]!.message).toContain("HTTP 502");
    expect(events.at(-1)!.phase).toBe("done");
    expect((await backend.store.agents.get("corvid"))!.status).toBe("bootstrapping");
  });

  /** The same, one call earlier: the list itself can fail too. */
  test("an API failure on the list is a warning, not a failed op", async () => {
    const { backend, hermetic } = seeded();
    backend.tailscale.listDevices = async (): Promise<TailscaleDevice[] | null> => {
      throw new HermeticError("TAILSCALE_UNAVAILABLE", "tailscale is down (HTTP 502)", {});
    };
    const events = await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));
    const tailnet = events.filter((e) => e.phase === "tailnet");
    expect(tailnet).toHaveLength(1);
    expect(tailnet[0]!.level).toBe("warn");
    expect(tailnet[0]!.message).toContain("tailnet devices not checked");
    expect(await backend.store.agents.get("atlas")).toBeNull();
  });
});

/**
 * §3.6: the fleet's release and this checkout can be the same *version* and
 * different *bytes* — a release pushed two days ago by a checkout that predates
 * a feature the manifest rendered today depends on. The version cannot say so;
 * the build fingerprint can, and `create` and `rerun` are the two moments where
 * it changes what an operator should do next.
 */
describe("release build drift", () => {
  /** Rewrite the seeded fleet manifest's `hermeticd.build`, or remove it. */
  function setManifestBuild(backend: MemoryBackend, build: string | null): void {
    const raw = backend.objects.get(FLEET_MANIFEST_KEY)!;
    const manifest: FleetManifest = JSON.parse(new TextDecoder().decode(raw));
    if (build === null) delete manifest.hermeticd.build;
    else manifest.hermeticd.build = build;
    backend.objects.set(
      FLEET_MANIFEST_KEY,
      new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
    );
  }

  function fleetBuilt(published: string | null, local: string | null) {
    const backend = seedFixtureFleet(new MemoryBackend());
    setManifestBuild(backend, published);
    return {
      backend,
      hermetic: testHermetic({ backend, config: FIXTURE_CONFIG, localBuild: () => local }),
    };
  }

  test("create warns when the fleet's release came from a different build", async () => {
    const { hermetic } = fleetBuilt("aaaa", "bbbb");
    const events = await drain(hermetic.agents.create({ name: "abalone" }));
    const warn = events.filter((e) => e.level === "warn" && e.message.includes("different build"));
    expect(warn).toHaveLength(1);
    // Said before anything is made, in the phase that read the release.
    expect(warn[0]!.phase).toBe("validate");
    expect(warn[0]!.message).toContain("hermetic artifacts push");
  });

  test("create says nothing when the builds agree, or when either is unknown", async () => {
    const same = await drain(fleetBuilt("aaaa", "aaaa").hermetic.agents.create({ name: "abalone" }));
    expect(same.filter((e) => e.message.includes("different build"))).toHaveLength(0);

    const absent = await drain(fleetBuilt(null, "bbbb").hermetic.agents.create({ name: "acorn" }));
    expect(absent.filter((e) => e.message.includes("different build"))).toHaveLength(0);

    const blind = await drain(fleetBuilt("aaaa", null).hermetic.agents.create({ name: "alder" }));
    expect(blind.filter((e) => e.message.includes("different build"))).toHaveLength(0);
  });

  /**
   * `rerun` writes a row and returns a view rather than a stream, so its
   * warning goes where an operator looking at the failed box will find it: the
   * agent's own history, beside the rerun it belongs to.
   */
  test("rerun records the drift in the agent's history", async () => {
    const { backend, hermetic } = fleetBuilt("aaaa", "bbbb");
    await hermetic.agents.rerun({ name: "heron" });
    const history = await backend.store.events.query("heron", 2);
    expect(history.some((e) => (e.detail ?? "").includes("different build"))).toBe(true);
  });

  test("rerun records nothing extra when the builds agree or either is unknown", async () => {
    for (const [published, local] of [
      ["aaaa", "aaaa"],
      [null, "bbbb"],
      ["aaaa", null],
    ] as const) {
      const { backend, hermetic } = fleetBuilt(published, local);
      await hermetic.agents.rerun({ name: "heron" });
      const history = await backend.store.events.query("heron", 2);
      expect(history.some((e) => (e.detail ?? "").includes("different build"))).toBe(false);
    }
  });
});

describe("agents.rerun", () => {
  test("writes one command on the row and an event, and nothing else", async () => {
    const { backend, hermetic } = seeded();
    backend.resetMutations();
    const next = await hermetic.agents.rerun({ name: "heron" });

    expect(next.command).toMatchObject({ action: "rerun", issued_by: FIXTURE_CONFIG.frozen_by });
    expect(next.command!.id).toMatch(/^[0-9a-f-]{36}$/);
    // Core writes a request; the box does the work (§4.2). No RPC, no instance.
    expect(backend.mutations).toEqual(["store.agents.update", "store.events.append"]);

    const [latest] = await backend.store.events.query("heron", 1);
    expect(latest!.action).toBe("rerun");
    expect(latest!.detail).toContain("02-data-volume");
  });

  test("refuses an agent that has not failed a stage", async () => {
    const { hermetic } = seeded();
    let code: string | null = null;
    try {
      await hermetic.agents.rerun({ name: "atlas" });
    } catch (e) {
      code = (e as HermeticError).code;
    }
    expect(code).toBe("INVALID_TRANSITION");
  });

  test("is a NOT_FOUND for an agent that does not exist", async () => {
    const { hermetic } = seeded();
    await expect(hermetic.agents.rerun({ name: "nobody" })).rejects.toThrow(HermeticError);
  });

  /**
   * §7.3: a rerun re-runs the stage that fetches the browser from `browser/*`,
   * so a browser agent on a pre-v14 fleet would fail in exactly the way it
   * failed the first time. Said with the command that fixes it instead.
   */
  test("a browser agent on a fleet below v14 is refused, with the fix named", async () => {
    const { backend, hermetic } = staging(BROWSER_FOUNDATION_VERSION - 1);
    const ember = (await backend.store.agents.get("ember"))!;
    await backend.store.agents.update("ember", ember.version, {
      status: "error",
    });
    let error: HermeticError | null = null;
    try {
      await hermetic.agents.rerun({ name: "ember" });
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error?.code).toBe("BROWSER_NEEDS_FOUNDATION_UPDATE");
    // No command was written: the box is not asked to do what it cannot.
    expect((await backend.store.agents.get("ember"))?.command).toBeNull();
  });

  /**
   * The fixture plays the runner (§3.2). It does it in the two steps the real
   * one takes, because the *resuming* state — `bootstrapping`, the failed stage
   * `running` again on attempt 2 — is the one the board has to render and would
   * otherwise never appear.
   */
  test("the fixture runner resumes through bootstrapping before it reaches ready", async () => {
    const { backend, hermetic } = seeded();
    // Each step lands at a multiple of this, so the sleeps below fall in the
    // middle of a step rather than on its edge.
    backend.rerunDelayMs = 100;
    await hermetic.agents.rerun({ name: "heron" });

    await Bun.sleep(150);
    const resuming = (await backend.store.agents.get("heron"))!;
    expect(resuming.status).toBe("bootstrapping");
    expect(resuming.command).toBeNull();
    expect(resuming.bootstrap!.current).toBe("02-data-volume");
    const stage = resuming.bootstrap!.stages.find((s) => s.id === "02-data-volume")!;
    expect(stage.status).toBe("running");
    expect(stage.attempt).toBe(2);

    await Bun.sleep(120);
    const done = (await backend.store.agents.get("heron"))!;
    expect(done.status).toBe("ready");
    expect(done.bootstrap!.stages.every((s) => s.status === "ok")).toBe(true);
    expect(done.bootstrap!.current).toBeNull();
  });

  test("refuses a second rerun while the box has not acked the first", async () => {
    const { hermetic } = seeded();
    await hermetic.agents.rerun({ name: "heron" });
    let code: string | null = null;
    try {
      await hermetic.agents.rerun({ name: "heron" });
    } catch (e) {
      code = (e as HermeticError).code;
    }
    expect(code).toBe("CONFLICT");
  });

  test("a command the box has already acked is not in the way", async () => {
    const { backend, hermetic } = seeded();
    const first = await hermetic.agents.rerun({ name: "heron" });
    // The runner's ack: `bootstrap.last_command_id` catches up with the command.
    const row = (await backend.store.agents.get("heron"))!;
    await backend.store.agents.update("heron", row.version, {
      bootstrap: { ...row.bootstrap!, last_command_id: first.command!.id },
    });
    const second = await hermetic.agents.rerun({ name: "heron" });
    expect(second.command!.id).not.toBe(first.command!.id);
  });

  test("refuses while another operator holds the agent's lock", async () => {
    const { backend, hermetic } = seeded();
    const held = (await backend.store.agents.get("heron"))!;
    await backend.store.agents.update("heron", held.version, {
      lock: {
        owner: "someone-else",
        expires: new Date(backend.now().getTime() + 600_000).toISOString(),
      },
    });
    let code: string | null = null;
    try {
      await hermetic.agents.rerun({ name: "heron" });
    } catch (e) {
      code = (e as HermeticError).code;
    }
    expect(code).toBe("LOCKED");
  });
});

describe("upgrade", () => {
  test("--hermes pins the version and re-renders, and says when it takes effect", async () => {
    const { backend, hermetic } = seeded();
    const events = await drain(hermetic.upgrade({ name: "juniper", hermes: "0.16.0" }));
    expect((await backend.store.agents.get("juniper"))!.hermes_version).toBe("0.16.0");
    const actions = (await backend.store.events.query("juniper")).map((e) => e.action);
    expect(actions).toContain("upgrade");
    expect(events.some((e) => e.message.includes("next recreate"))).toBe(true);
  });

  test("--hermeticd moves the fleet manifest's pointer and writes no agent row", async () => {
    const { backend, hermetic } = seeded();
    await hermetic.artifacts.push({ version: "0.5.0" });
    const versionsBefore = (await hermetic.agents.list()).map((r) => r.version);

    // Push moved the pointer already; move it back so the upgrade has work.
    await drain(hermetic.upgrade({ all: true, hermeticd: FIXTURE_HERMETICD_VERSION }));
    expect((await readFleetManifest(backend.artifacts))!.hermeticd.version).toBe(
      FIXTURE_HERMETICD_VERSION,
    );

    await drain(hermetic.upgrade({ all: true, hermeticd: "0.5.0" }));
    const manifest = (await readFleetManifest(backend.artifacts))!;
    expect(manifest.hermeticd.version).toBe("0.5.0");
    // The generation `describeRelease` resolved, not a key rebuilt from the
    // version: pointing the fleet at a release means pointing it at one
    // immutable set of objects (§3.6).
    expect(manifest.hermeticd.generation).toMatch(/^[0-9a-f]{16}$/);
    expect(manifest.hermeticd.files["hermeticd"]!.key).toBe(
      `artifacts/0.5.0/${manifest.hermeticd.generation}/hermeticd`,
    );
    // Fleet-wide means fleet-wide: not one agent row was touched.
    expect((await hermetic.agents.list()).map((r) => r.version)).toEqual(versionsBefore);
    const fleetEvents = await backend.store.events.query("_fleet");
    expect(fleetEvents.some((e) => e.detail === "hermeticd → 0.5.0")).toBe(true);
  });

  test("--hermeticd refuses a version that is not in the bucket", async () => {
    const { hermetic } = seeded();
    let code: string | null = null;
    try {
      await drain(hermetic.upgrade({ all: true, hermeticd: "9.9.9" }));
    } catch (e) {
      code = (e as HermeticError).code;
    }
    expect(code).toBe("NOT_FOUND");
  });

  test("--hermeticd needs no target at all: there is nothing for one to select", async () => {
    const { backend, hermetic } = seeded();
    await hermetic.artifacts.push({ version: "0.5.0" });
    await drain(hermetic.upgrade({ hermeticd: FIXTURE_HERMETICD_VERSION }));
    expect((await readFleetManifest(backend.artifacts))!.hermeticd.version).toBe(
      FIXTURE_HERMETICD_VERSION,
    );
  });

  test("--hermeticd with an agent name is refused: it is fleet-wide", async () => {
    const { hermetic } = seeded();
    let code: string | null = null;
    try {
      await drain(hermetic.upgrade({ name: "atlas", hermeticd: FIXTURE_HERMETICD_VERSION }));
    } catch (e) {
      code = (e as HermeticError).code;
    }
    expect(code).toBe("VALIDATION");
  });

  test("--all touches every non-destroyed agent", async () => {
    const { backend, hermetic } = seeded();
    // A legacy `destroyed` row, the shape a pre-tombstone destroy left (§6.7):
    // the fixture seeds none, so this test makes the one it is about.
    backend.agents.set("cinder", {
      ...structuredClone(backend.agents.get("juniper")!),
      name: "cinder",
      status: "destroyed",
      instance_id: null,
    });
    const events = await drain(hermetic.upgrade({ all: true, hermes: "0.16.0" }));
    const rows = (await hermetic.agents.list()).filter((r) => r.status !== "destroyed");
    expect(rows.every((r) => r.hermes_version === "0.16.0")).toBe(true);
    for (const row of rows) {
      expect(events.some((e) => e.phase === `${row.name}:done`)).toBe(true);
    }
    // The destroyed row is left exactly as it was — nothing to upgrade.
    const gone = (await backend.store.agents.get("cinder"))!;
    expect(gone.hermes_version).not.toBe("0.16.0");
    expect(events.some((e) => e.phase === `${gone.name}:done`)).toBe(false);
  });

  test("requires a version and a target", async () => {
    const { hermetic } = seeded();
    await expect(drain(hermetic.upgrade({ name: "atlas" }))).rejects.toThrow();
    await expect(drain(hermetic.upgrade({ hermes: "0.16.0" }))).rejects.toThrow();
  });

  /**
   * §6.6: `upgrade --hermeticd` is a write to the one object every box follows,
   * and `foundation.update`'s prune decides what it may delete from the
   * manifest it read moments earlier. A pointer moved into that window names a
   * release the prune then removes, and every box's next update 404s. It was
   * the one write path that never checked the fleet lock.
   */
  test("--hermeticd is refused while a foundation update holds the fleet lock", async () => {
    const { backend, hermetic } = seeded();
    await hermetic.artifacts.push({ version: "0.5.0" });
    // Through `lockFleet`, the only door onto the lock: `put` creates `_fleet`
    // and refuses a row that is already there (§4.4).
    await backend.store.fleet.lockFleet(
      "arn:aws:iam::123456789012:user/other#op-1",
      new Date(backend.now().getTime() + 60_000).toISOString(),
      backend.now(),
    );
    const pointed = (await readFleetManifest(backend.artifacts))!.hermeticd.version;

    let code: string | null = null;
    try {
      await drain(hermetic.upgrade({ all: true, hermeticd: FIXTURE_HERMETICD_VERSION }));
    } catch (e) {
      code = (e as HermeticError).code;
    }

    expect(code).toBe("LOCKED");
    // And the pointer really did not move.
    expect((await readFleetManifest(backend.artifacts))!.hermeticd.version).toBe(pointed);
  });

  /**
   * Refusing on a *read* only narrows the window: `foundation.update`'s prune
   * decides what to delete from the manifest it read a moment ago, so the
   * pointer has to move with the fleet lock *held*, not merely after a look at
   * it. This asserts the lock is on the `_fleet` item at the moment the
   * manifest object is written, and off it afterwards.
   */
  test("--hermeticd holds the fleet lock across the read and the write", async () => {
    const { backend, hermetic } = seeded();
    await hermetic.artifacts.push({ version: "0.5.0" });

    let lockedDuringWrite: string | null = null;
    const putObject = backend.artifacts.putObject;
    backend.artifacts.putObject = async (key: string, bytes: Uint8Array) => {
      if (key === FLEET_MANIFEST_KEY) {
        lockedDuringWrite = (await backend.store.fleet.get())?.lock?.owner ?? null;
      }
      return putObject(key, bytes);
    };

    await drain(hermetic.upgrade({ all: true, hermeticd: FIXTURE_HERMETICD_VERSION }));

    expect(lockedDuringWrite).toBeString();
    // And handed straight back, so the next agent operation is not refused.
    expect((await backend.store.fleet.get())?.lock ?? null).toBeNull();
  });

  test("artifacts.push holds it too, and gives it back when the push throws", async () => {
    const { backend, hermetic } = seeded();
    let lockedDuringUpload: string | null = null;
    const putObject = backend.artifacts.putObject;
    backend.artifacts.putObject = async (key: string, bytes: Uint8Array) => {
      if (key.startsWith("artifacts/")) {
        lockedDuringUpload = (await backend.store.fleet.get())?.lock?.owner ?? null;
      }
      if (key === FLEET_MANIFEST_KEY) throw new HermeticError("INTERNAL", "PutObject failed", {});
      return putObject(key, bytes);
    };

    await expect(hermetic.artifacts.push({ version: "0.6.0" })).rejects.toThrow(HermeticError);

    expect(lockedDuringUpload).toBeString();
    // A failed push must not leave the fleet locked for the whole TTL (§4.4).
    expect((await backend.store.fleet.get())?.lock ?? null).toBeNull();
  });

  /**
   * The foundation stamp reaches the bucket before it reaches `_fleet`
   * (`pushAndPrune`, then the stamp), so for the length of the migrate phase the
   * manifest is ahead of the row. A manifest rebuilt from the row alone inside
   * that window silently rewinds the version every box reads.
   */
  test("--hermeticd keeps the foundation block the manifest already carries", async () => {
    const { backend, hermetic } = seeded();
    await hermetic.artifacts.push({ version: "0.5.0" });
    const manifest = (await readFleetManifest(backend.artifacts))!;
    const ahead = {
      version: (manifest.foundation?.version ?? 0) + 1,
      template_sha256: "a".repeat(64),
      applied_at: "2026-09-01T00:00:00.000Z",
      applied_by: "arn:aws:iam::123456789012:user/ops",
    };
    backend.objects.set(
      FLEET_MANIFEST_KEY,
      new TextEncoder().encode(`${JSON.stringify({ ...manifest, foundation: ahead }, null, 2)}\n`),
    );

    await drain(hermetic.upgrade({ all: true, hermeticd: FIXTURE_HERMETICD_VERSION }));

    const after = (await readFleetManifest(backend.artifacts))!;
    expect(after.hermeticd.version).toBe(FIXTURE_HERMETICD_VERSION);
    expect(after.foundation).toEqual(ahead);
  });
});

/**
 * A consumer that stops consuming — a `for await` that breaks, a closed browser
 * tab, `.return()` on the generator — resumes the op at its last `yield` with a
 * *return* completion. That runs `finally` and skips `catch`, so while every
 * lifecycle op released its TTL lock in a `catch` an abandoned one held the row
 * for the full ten minutes with nothing on its history to say why (§4.4).
 */
describe("an abandoned op still releases its lock", () => {
  test("breaking out of a destroy unlocks the row and records the abandonment", async () => {
    const { backend, hermetic } = seeded();

    for await (const _ of hermetic.agents.destroy({ name: "atlas", yes: true })) {
      break;
    }

    const row = (await backend.store.agents.get("atlas"))!;
    expect(row.lock ?? null).toBeNull();
    // The row stays where the abandoned run left it, which is honest and
    // re-runnable (§4.5) — what must not survive is the lock.
    expect(row.status).toBe("destroying");
    const history = await backend.store.events.query("atlas");
    expect(history.some((e) => e.action === "failed" && (e.detail ?? "").includes("ABORTED"))).toBe(
      true,
    );
  });

  test("breaking out of a create unlocks the row too", async () => {
    const { backend, hermetic } = freshFleet();

    for await (const e of hermetic.agents.create({ name: "abalone" })) {
      if (e.phase === "secrets") break;
    }

    const row = (await backend.store.agents.get("abalone"))!;
    expect(row.lock ?? null).toBeNull();
    expect(row.status).toBe("creating");
  });
});

/**
 * The other half of the same mechanism, and the one that made it dangerous.
 *
 * A consumer that reads the terminal `done` event and stops — `break` on
 * `progress === 1`, a UI closing its stream, the CLI's renderer returning —
 * resumes the generator *at that yield* with a `return` completion. With the
 * flag set on the line after the yield, the flag never ran: every completely
 * successful op unwound itself in `finally` and wrote a permanent
 * `<method> failed (ABORTED)` onto the agent's history. The history is the one
 * durable record an operator later reads to decide whether an agent is sound,
 * and it was lying about every op that worked.
 */
describe("an op consumed to its end records no failure", () => {
  const stops: Array<{
    label: string;
    run: (h: ReturnType<typeof seeded>["hermetic"]) => AsyncIterable<{ progress: number }>;
  }> = [
    { label: "stop", run: (h) => h.agents.stop("atlas") },
    { label: "start", run: (h) => h.agents.start("juniper") },
    { label: "destroy", run: (h) => h.agents.destroy({ name: "corvid", yes: true }) },
    { label: "recreate", run: (h) => h.agents.recreate({ name: "fathom", yes: true }) },
  ];

  for (const { label, run } of stops) {
    test(`${label} consumed to its done event and then abandoned writes no failed event`, async () => {
      const { backend, hermetic } = seeded();
      const name = { stop: "atlas", start: "juniper", destroy: "corvid", recreate: "fathom" }[
        label
      ] as string;

      // Exactly what a head does: read until the op says it is finished, then
      // stop reading — which calls `.return()` on the generator.
      for await (const e of run(hermetic)) {
        if (e.progress === 1) break;
      }

      const history = await backend.store.events.query(name);
      expect(history.filter((e) => e.action === "failed")).toEqual([]);
      // `?.`: a finished destroy has released the row, lock and all (§6.7).
      expect((await backend.store.agents.get(name))?.lock ?? null).toBeNull();
    });
  }

  test("create consumed to its done event and then abandoned writes no failed event", async () => {
    const { backend, hermetic } = freshFleet();

    for await (const e of hermetic.agents.create({ name: "alabaster" })) {
      if (e.progress === 1) break;
    }

    const history = await backend.store.events.query("alabaster");
    expect(history.filter((e) => e.action === "failed")).toEqual([]);
    const row = (await backend.store.agents.get("alabaster"))!;
    expect(row.lock ?? null).toBeNull();
    expect(row.resources.config_key).toBeString();
  });

  /**
   * And the window between: `create` commits at the handoff and then *watches*.
   * A tab closed during that watch is somebody walking away from an agent that
   * exists and works, not a failure of the create.
   */
  test("abandoning a create after the handoff writes no failed event either", async () => {
    const { backend, hermetic } = freshFleet();

    for await (const e of hermetic.agents.create({ name: "alacrity" })) {
      if (e.message.includes("handed off")) break;
    }

    const history = await backend.store.events.query("alacrity");
    expect(history.some((e) => e.action === "handoff")).toBe(true);
    expect(history.filter((e) => e.action === "failed")).toEqual([]);
    const row = (await backend.store.agents.get("alacrity"))!;
    expect(row.lock ?? null).toBeNull();
    // The row really did commit: this is a created agent, not a stranded one.
    expect(row.resources.config_key).toBeString();
  });
});

describe("doctor", () => {
  test("is clean on a healthy fixture fleet apart from the stale heartbeat", async () => {
    // A healthy fleet is one the account's directory knows about (§4.8).
    const { hermetic } = seeded("seeded");
    const report = await hermetic.doctor();
    expect(report.account.ok).toBe(true);
    expect(report.fleet.ok).toBe(true);
    expect(report.foundation.present).toBe(true);
    expect(report.security_group.ok).toBe(true);
    // One, seeded on purpose: `lumen`'s stale heartbeat. `corvid` — the fixture's
    // agent recreated while its old tailnet device still held the canonical name
    // — is *not* a finding: nothing hermetic can run clears it, so counting it
    // would make this fleet answer PROBLEMS for ever. It is said instead as a
    // tailnet detail, in the same words — with the command that now clears it,
    // since this fixture's device list is readable and so its OAuth client has
    // `devices:core` (§6.5).
    expect(report.findings).toEqual(["lumen is ready but has not heartbeated recently"]);
    expect(report.tailscale.stale.map((s) => s.note)).toEqual([
      "corvid: the node is fxtr0001-corvid-2.hermetic.ts.net, not fxtr0001-corvid.hermetic.ts.net: a stale device holds the name; delete it in the Tailscale admin console (Machines → corvid) — hermetic agent recreate corvid will remove it — until then fxtr0001-corvid.hermetic.ts.net resolves to the dead node (tailscale_stale_device)",
    ]);
    expect(report.ok).toBe(false);
    expect(report.heartbeats.find((h) => h.name === "lumen")!.unreachable).toBe(true);
  });

  test("reports a three-way fleet_id disagreement", async () => {
    const { backend, hermetic } = seeded();
    backend.stack!.tags["fleet_id"] = "11111111-1111-4111-8111-111111111111";
    backend.fleetItem!.fleet_id = "22222222-2222-4222-8222-222222222222";
    const report = await hermetic.doctor();
    expect(report.fleet).toMatchObject({
      local: FIXTURE_CONFIG.fleet_id,
      stack_tag: "11111111-1111-4111-8111-111111111111",
      fleet_item: "22222222-2222-4222-8222-222222222222",
      ok: false,
    });
    expect(report.findings).toContain("stack fleet_id tag disagrees with local config");
  });

  test("reports an inbound security-group rule", async () => {
    const { backend, hermetic } = seeded();
    backend.sgInbound = [{ protocol: "tcp", from: 22, to: 22, cidr: "0.0.0.0/0" }];
    const report = await hermetic.doctor();
    expect(report.security_group.ok).toBe(false);
    expect(report.findings.join(" ")).toContain("must have none");
  });

  test("reports an account mismatch", async () => {
    const { backend, hermetic } = seeded();
    backend.accountId = "999999999999";
    const report = await hermetic.doctor();
    expect(report.account.ok).toBe(false);
  });
});

describe("secrets", () => {
  test("push and verify refuse an agent whose secrets_mode is none", async () => {
    const { hermetic } = seeded();
    for (const call of [
      () => hermetic.secrets.push({ name: "atlas", bws_token: true, value: "x" }),
      () => hermetic.secrets.verify({ name: "atlas" }),
    ]) {
      let code: string | null = null;
      try {
        await call();
      } catch (e) {
        code = (e as HermeticError).code;
      }
      expect(code).toBe("SECRETS_DISABLED");
    }
  });

  test("verify reports a placeholder slot", async () => {
    const { backend, hermetic } = freshFleet();
    await drain(hermetic.agents.create({ name: "research-1", secrets: "bitwarden" }));
    let report = await hermetic.secrets.verify({ name: "research-1" });
    expect(report.ok).toBe(false);
    expect(report.slots.find((s) => s.path.endsWith("bws-token"))).toMatchObject({
      exists: true,
      placeholder: true,
    });

    await hermetic.secrets.push({ name: "research-1", bws_token: true, value: "real" });
    report = await hermetic.secrets.verify({ name: "research-1" });
    expect(report.ok).toBe(true);
    expect(backend.params.get("/hermes/fxtr0001/research-1/bws-token")).toBe("real");
  });

  /**
   * §8.3: the one maintenance path for an agent's own key, and it writes the
   * slot the *running* configuration reads — `credential_ref` on a
   * profile-bound row — rather than the fixed `provider-key` a box stopped
   * reading at its last apply.
   */
  test("--provider-key fills the slot this agent's running configuration reads", async () => {
    const { backend, hermetic } = freshFleet();
    await drain(hermetic.agents.create({ name: "research-1", provider_profile: "openrouter-cheap" }));

    let report = await hermetic.secrets.verify({ name: "research-1" });
    expect(report.ok).toBe(true);
    expect(report.slots.find((s) => s.path.endsWith("provider-key-rtr00002-r1"))).toMatchObject({
      exists: true,
      placeholder: false,
    });
    // A `secrets_mode: none` agent's slots are not invented for it.
    expect(report.slots.some((s) => s.path.endsWith("bws-token"))).toBe(false);

    const pushed = await hermetic.secrets.push({
      name: "research-1",
      provider_key: true,
      value: "sk-or-v1-FIXTURE-REPLACED",
    });
    expect(pushed.path).toBe("/hermes/fxtr0001/research-1/provider-key-rtr00002-r1");
    expect(backend.params.get("/hermes/fxtr0001/research-1/provider-key-rtr00002-r1")).toBe(
      "sk-or-v1-FIXTURE-REPLACED",
    );
    report = await hermetic.secrets.verify({ name: "research-1" });
    expect(report.ok).toBe(true);
  });

  test("--provider-key is refused for a provider that has no key", async () => {
    const { hermetic } = freshFleet();
    await drain(hermetic.agents.create({ name: "research-1", provider_profile: "bedrock-role" }));
    let code: string | null = null;
    try {
      await hermetic.secrets.push({ name: "research-1", provider_key: true, value: "x" });
    } catch (e) {
      code = (e as HermeticError).code;
    }
    expect(code).toBe("SECRETS_DISABLED");
  });

  test("--from-bitwarden is not implemented yet", async () => {
    const { hermetic } = freshFleet();
    await drain(hermetic.agents.create({ name: "research-1", secrets: "bitwarden" }));
    let code: string | null = null;
    try {
      await hermetic.secrets.push({ name: "research-1", from_bitwarden: true });
    } catch (e) {
      code = (e as HermeticError).code;
    }
    expect(code).toBe("UNSUPPORTED");
  });
});

describe("ssh / logs", () => {
  test("ssh returns argv for the head to exec; core never spawns", async () => {
    const { hermetic } = seeded();
    // The row's own `tailscale_dns_name`, which is what the node answers on —
    // never the bare agent name, which since v3 is not a hostname at all.
    expect(await hermetic.ssh({ name: "atlas" })).toEqual([
      "tailscale",
      "ssh",
      "fxtr0001-atlas.hermetic.ts.net",
    ]);
    await expect(hermetic.ssh({ name: "Atlas" })).rejects.toThrow(HermeticError);
  });

  test("logs streams lines from the hermeticd RPC", async () => {
    const { hermetic } = seeded();
    const lines = [];
    for await (const line of hermetic.logs({ name: "atlas", unit: "hermes" })) lines.push(line);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.unit).toBe("hermes");
  });

  test("logs --file reads one of Hermes's own logs instead of a unit", async () => {
    const { hermetic } = seeded();
    const lines = [];
    for await (const line of hermetic.logs({ name: "atlas", file: "errors" })) lines.push(line);
    // The file, not a unit: journald never sees these lines at all, because
    // upstream attaches no stderr handler unless it is run verbose.
    expect(lines.map((l) => l.unit)).toEqual(["errors.log"]);
  });

  /**
   * Three sources, one of which answers. A request naming two is refused by the
   * schema every head validates with, rather than resolved by precedence: an
   * operator who asked for `errors.log` and silently got the journal would read
   * an empty stream as "nothing went wrong", which is the opposite of what
   * happened.
   */
  test.each([
    ["a unit and a file", { name: "atlas", unit: "hermes-dashboard.service", file: "agent" }],
    ["the console and a file", { name: "atlas", file: "agent", source: "console" }],
  ])("LogsInput refuses %s", (_why, input) => {
    expect(LogsInput.safeParse(input).success).toBe(false);
    expect(LogsInput.safeParse({ name: "atlas", file: "agent" }).success).toBe(true);
  });

  test("an aborted logs stream ends", async () => {
    const { hermetic } = seeded();
    const controller = new AbortController();
    controller.abort();
    const lines = [];
    for await (const line of hermetic.logs({ name: "atlas" }, { signal: controller.signal })) {
      lines.push(line);
    }
    expect(lines).toEqual([]);
  });
});

describe("config.show / runs.list / artifacts.push", () => {
  test("config.show returns the frozen row plus the live stack id and tailnet", async () => {
    const { backend, hermetic } = seeded();
    const shown = await hermetic.config.show();
    expect(shown.account_id).toBe(FIXTURE_CONFIG.account_id);
    expect(shown.fleet_id).toBe(FIXTURE_CONFIG.fleet_id);
    expect(shown.stack_id).toBe(backend.stack!.stack_id);
    // The tailnet is fleet-wide, not local: it comes from `_fleet` (§6.4).
    expect(shown.tailnet).toBe(backend.fleetItem!.tailnet);
    expect(shown.tailnet).toBe("hermetic.ts.net");
  });

  test("config.show reports a null tailnet when there is no _fleet item", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    backend.fleetItem = null;
    const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG });
    expect((await hermetic.config.show()).tailnet).toBeNull();
  });

  test("config.show fails NOT_INITIALIZED without a config row", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const hermetic = testHermetic({ backend, config: null });
    await expect(hermetic.config.show()).rejects.toThrow(HermeticError);
  });

  test("runs.list is empty until a run store is injected", async () => {
    const { hermetic } = seeded();
    expect(await hermetic.runs.list()).toEqual([]);

    const backend = seedFixtureFleet(new MemoryBackend());
    const withStore = testHermetic({
      backend,
      config: FIXTURE_CONFIG,
      runs: {
        list: async () => [
          {
            id: "1",
            command: "agent ps",
            args: [],
            agent: null,
            started_at: "2026-09-01T11:00:00.000Z",
            finished_at: "2026-09-01T11:00:01.000Z",
            exit_code: 0,
            log: "",
            fleet: null,
            account_id: null,
            region: null,
            fleet_name: null,
          },
        ],
      },
    });
    expect(await withStore.runs.list({ last: true })).toHaveLength(1);
  });

  /**
   * §3.6: `fixture` defaults to false everywhere it is read. A core built
   * without the flag must therefore behave as the real one — otherwise a
   * 14-byte stand-in binary lands under a real fleet manifest, and the fleet
   * looks published while booting nothing.
   */
  /**
   * A file standing in for the compiled binary. §3.6's clean-tree rule is about
   * the *checkout*, not about the bytes, so the bytes can be anything — and a
   * real cross-compile in a unit test would be a minute of nothing.
   */
  const standinDir = mkdtempSync(join(tmpdir(), "hermetic-standin-"));
  const HERMETICD_STANDIN = join(standinDir, "hermeticd");
  writeFileSync(HERMETICD_STANDIN, "not a real binary");

  test("a dirty checkout cannot publish a release", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const hermetic = testHermetic({
      backend,
      config: FIXTURE_CONFIG,
      fixture: false,
      hermeticdPath: HERMETICD_STANDIN,
      git: () => ({ build_number: 35, commit: "427e7b2", dirty: true }),
    });

    let code: string | null = null;
    try {
      await hermetic.artifacts.push({});
    } catch (e) {
      code = (e as HermeticError).code;
    }
    expect(code).toBe("WORKING_TREE_DIRTY");
    // And nothing was uploaded: the refusal is before any read or compile, so a
    // dirty tree never half-publishes and never pays for a cross-compile it is
    // not allowed to push.
    expect(backend.mutations).not.toContain("artifacts.putObject");
  });

  test("the same push succeeds once the tree is committed, and records the build number", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const hermetic = testHermetic({
      backend,
      config: FIXTURE_CONFIG,
      fixture: false,
      hermeticdPath: HERMETICD_STANDIN,
      git: () => ({ build_number: 36, commit: "deadbee", dirty: false }),
    });

    await hermetic.artifacts.push({});
    const manifest = await readFleetManifest(backend.artifacts);
    // The number an operator reads, and the commit it resolves back to.
    expect(manifest?.hermeticd.build_number).toBe(36);
    expect(manifest?.hermeticd.commit).toBe("deadbee");
  });

  test("a checkout that cannot say records no number, and is not refused", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const hermetic = testHermetic({
      backend,
      config: FIXTURE_CONFIG,
      fixture: false,
      hermeticdPath: HERMETICD_STANDIN,
      // A released binary, a tarball, a shallow clone: no repository to ask.
      git: () => null,
    });

    await hermetic.artifacts.push({});
    const manifest = await readFleetManifest(backend.artifacts);
    // Absent, never `0` — `0` would order below every real release.
    expect(manifest?.hermeticd.build_number).toBeUndefined();
    expect(manifest?.hermeticd.commit).toBeUndefined();
  });

  test("a core built without `fixture` is real: it refuses rather than inventing a binary", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const hermetic = createHermetic({
      backend,
      config: FIXTURE_CONFIG,
      localTailscale: OK_TAILSCALE,
      verifyTailscaleOauth: OK_OAUTH,
      resolveHermeticd: async () => null,
      // This test is about the *binary* being absent, so the checkout must not
      // be the thing that refuses first (§3.6).
      git: () => null,
    });
    let code: string | null = null;
    try {
      // Deliberately not `FIXTURE_HERMETICD_VERSION`: the fixture fleet already
      // carries a release at that version, and an object that was seeded would
      // read exactly like an object this push wrote.
      await hermetic.artifacts.push({ version: "9.9.9" });
    } catch (e) {
      code = (e as HermeticError).code;
    }
    expect(code).toBe("HERMETICD_UNAVAILABLE");
    expect(backend.objects.has("artifacts/9.9.9/hermeticd")).toBe(false);
  });

  /**
   * Every route to a push carries the stages, not just the one that resolves
   * the binary for itself: `--path` is what `init` takes, and a release with a
   * binary and no stages boots nothing (§1).
   */
  test("a push that names a binary still publishes the stages beside it", async () => {
    const stages = installTestStages(["00-preflight.sh", "01-tailscale.sh"]);
    const binary = mkdtempSync(join(tmpdir(), "hermetic-bin-"));
    try {
      writeFileSync(join(binary, "hermeticd"), "ELF");
      const { backend, hermetic } = seeded();

      for (const input of [
        { path: join(binary, "hermeticd") },
        { bytes: new TextEncoder().encode("ELF") },
      ]) {
        await hermetic.artifacts.push({ version: "0.5.0", ...input });
        const manifest = (await readFleetManifest(backend.artifacts))!;
        expect(Object.keys(manifest.hermeticd.files).sort()).toEqual([
          "hermeticd",
          "stages/00-preflight.sh",
          "stages/01-tailscale.sh",
        ]);
      }
    } finally {
      rmSync(binary, { recursive: true, force: true });
      stages.restore();
    }
  });

  test("artifacts.push writes the generation key and points the fleet manifest at it", async () => {
    const { backend, hermetic } = seeded();
    const out = await hermetic.artifacts.push({ version: "0.5.0" });
    expect(out.generation).toMatch(/^[0-9a-f]{16}$/);
    expect(out.key).toBe(`artifacts/0.5.0/${out.generation}/hermeticd`);
    expect(await backend.artifacts.exists(out.key)).toBe(true);

    /**
     * The pointer is the last write *to the bucket*, and it names what was just
     * pushed (§1). The very last mutation of the op is now the fleet lock going
     * back — the push holds it so a concurrent `foundation.update` cannot prune
     * the release it is pointing at — which says nothing about the bucket.
     */
    expect(backend.mutations.filter((m) => m.startsWith("artifacts.")).at(-1)).toBe(
      "artifacts.putObject",
    );
    expect(backend.mutations.at(-1)).toBe("store.fleet.unlockFleet");
    expect([...backend.objects.keys()]).toContain(FLEET_MANIFEST_KEY);
    const manifest = (await readFleetManifest(backend.artifacts))!;
    expect(manifest.hermeticd.version).toBe("0.5.0");
    expect(manifest.hermeticd.files["hermeticd"]!.sha256).toBe(out.sha256);
    expect(manifest.resources.param_prefix).toBe("/hermes/fxtr0001/");
    expect(manifest.resources.agents_table).toBe("hermetic-fxtr0001-agents");
  });

  /**
   * The same two doors `upgrade --hermeticd` now knocks on (§6.6). `artifacts
   * push` writes the same object, for the same reason, and had neither: it
   * could move the pointer into a running `foundation.update`'s prune window,
   * and it rebuilt the manifest from `_fleet` alone.
   *
   * `init --attach` reaches the same publish and deliberately keeps neither
   * check — there is no `_fleet` lock, and often no `_fleet` item, until init
   * has written one.
   */
  test("artifacts.push is refused while a foundation update holds the fleet lock", async () => {
    const { backend, hermetic } = seeded();
    await hermetic.artifacts.push({ version: "0.5.0" });
    // Through `lockFleet`, the only door onto the lock: `put` creates `_fleet`
    // and refuses a row that is already there (§4.4).
    await backend.store.fleet.lockFleet(
      "arn:aws:iam::123456789012:user/other#op-1",
      new Date(backend.now().getTime() + 60_000).toISOString(),
      backend.now(),
    );
    const pointed = (await readFleetManifest(backend.artifacts))!.hermeticd.version;

    let code: string | null = null;
    try {
      await hermetic.artifacts.push({ version: FIXTURE_HERMETICD_VERSION });
    } catch (e) {
      code = (e as HermeticError).code;
    }

    expect(code).toBe("LOCKED");
    // Nothing was pushed and the pointer did not move.
    expect((await readFleetManifest(backend.artifacts))!.hermeticd.version).toBe(pointed);
  });

  test("artifacts.push keeps the foundation block the manifest already carries", async () => {
    const { backend, hermetic } = seeded();
    await hermetic.artifacts.push({ version: "0.5.0" });
    const manifest = (await readFleetManifest(backend.artifacts))!;
    const ahead = {
      version: (manifest.foundation?.version ?? 0) + 1,
      template_sha256: "a".repeat(64),
      applied_at: "2026-09-01T00:00:00.000Z",
      applied_by: "arn:aws:iam::123456789012:user/ops",
    };
    backend.objects.set(
      FLEET_MANIFEST_KEY,
      new TextEncoder().encode(`${JSON.stringify({ ...manifest, foundation: ahead }, null, 2)}\n`),
    );

    await hermetic.artifacts.push({ version: FIXTURE_HERMETICD_VERSION });

    const after = (await readFleetManifest(backend.artifacts))!;
    expect(after.hermeticd.version).toBe(FIXTURE_HERMETICD_VERSION);
    // The newer stamp survived the rebuild; the row's older one did not win.
    expect(after.foundation).toEqual(ahead);
  });
});

describe("init", () => {
  test("creates a foundation, the _fleet item and stores the tailscale secret", async () => {
    const backend = new MemoryBackend();
    const hermetic = testHermetic({ backend, config: null });
    const events = await drain(
      hermetic.init({
        create: true,
        region: "us-west-2",
        confirm_account_id: "123456789012",
        tailnet: "acme.ts.net",
        tailscale_oauth_secret: "tskey-client-FIXTURE",
      }),
    );
    expect(events.at(-1)?.progress).toBe(1);
    expect(backend.stack).not.toBeNull();
    expect(backend.fleetItem).not.toBeNull();
    expect(backend.fleetItem!.region).toBe("us-west-2");
    expect(backend.fleetItem!.fleet_id).toBe(backend.stack!.tags["fleet_id"]!);
    // The canonical slot is `backend/constants.ts` `tailscaleOauthSecretPath`,
    // which is fleet-scoped: this fleet's id was minted by the init above.
    const minted = backend.fleetItem!.fleet_id;
    expect(backend.params.get(`/hermetic/${minted}/tailscale/oauth-secret`)).toBe(
      "tskey-client-FIXTURE",
    );
  });

  test("attach refreshes the fleet manifest's resources without re-uploading the release", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend({ directory: "seeded" }));
    const before = (await readFleetManifest(backend.artifacts))!;
    // A manifest written by an older build, or against a stack since updated:
    // the half that goes stale is `resources`, and it is where the box reads
    // its table names.
    backend.objects.set(
      FLEET_MANIFEST_KEY,
      new TextEncoder().encode(
        `${JSON.stringify(
          {
            ...before,
            resources: { ...before.resources, agents_table: "hermetic-agents", vpc_id: "vpc-old" },
          },
          null,
          2,
        )}\n`,
      ),
    );
    backend.resetMutations();

    const hermetic = testHermetic({ backend, config: null });
    await drain(hermetic.init({ attach: true, profile: FIXTURE_CONFIG.profile }));

    const after = (await readFleetManifest(backend.artifacts))!;
    expect(after.resources.agents_table).toBe("hermetic-fxtr0001-agents");
    expect(after.resources.vpc_id).toBe("vpc-fixture");
    // The release itself was left alone: only the pointer was rewritten.
    expect(after.hermeticd).toEqual(before.hermeticd);
    expect(backend.mutations).toEqual(["directory.ensure", "artifacts.putObject"]);
  });

  /**
   * The fleet's release is fleet-wide state, and `attach` is the command an
   * operator reaches for when something is already wrong. An older laptop
   * attaching must therefore not repoint a fleet someone else has upgraded:
   * every box would downgrade itself on its next nightly update, from a command
   * that was supposed to be safe.
   */
  test("attach never repoints a fleet backwards to an older hermeticd", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    // The fleet has been upgraded past this build by a newer laptop.
    await testHermetic({ backend, config: FIXTURE_CONFIG }).artifacts.push({ version: "0.9.0" });
    const ahead = (await readFleetManifest(backend.artifacts))!;
    expect(ahead.hermeticd.version).toBe("0.9.0");
    backend.resetMutations();

    const events = await drain(
      testHermetic({ backend, config: null }).init({ attach: true, profile: FIXTURE_CONFIG.profile }),
    );

    const after = (await readFleetManifest(backend.artifacts))!;
    expect(after.hermeticd.version).toBe("0.9.0");
    expect(after.hermeticd.files).toEqual(ahead.hermeticd.files);
    const warned = events.find((e) => e.phase === "artifacts");
    expect(warned).toMatchObject({ level: "warn" });
    expect(warned!.message).toContain("newer than");
    expect(warned!.message).toContain("upgrade --hermeticd");
    // Nothing new was uploaded: the release this build ships stayed put.
    expect(
      [...backend.objects.keys()].some(
        (k) => k.startsWith(`artifacts/${FIXTURE_HERMETICD_VERSION}/`) && k.endsWith("/hermeticd"),
      ),
    ).toBe(true);
    expect(backend.mutations.filter((m) => m === "artifacts.putObject")).toHaveLength(0);
  });

  test("attach publishes when the fleet is behind this build", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    // A fleet last pushed by an older laptop. The version and the keys its
    // objects sit under move together: a release lives at `artifacts/<version>/`,
    // so a manifest that rewound only the version would be naming another
    // release's objects — which `readFleetManifest` refuses (`MANIFEST_REFUSED`)
    // rather than hand to a booting box.
    const stale = (await readFleetManifest(backend.artifacts))!;
    const older = {
      ...stale.hermeticd,
      version: "0.1.0",
      files: Object.fromEntries(
        Object.entries(stale.hermeticd.files).map(([name, file]) => [
          name,
          {
            ...file,
            key: file.key.replace(`artifacts/${stale.hermeticd.version}/`, "artifacts/0.1.0/"),
          },
        ]),
      ),
    };
    backend.objects.set(
      FLEET_MANIFEST_KEY,
      new TextEncoder().encode(`${JSON.stringify({ ...stale, hermeticd: older }, null, 2)}\n`),
    );

    await drain(
      testHermetic({ backend, config: null }).init({ attach: true, profile: FIXTURE_CONFIG.profile }),
    );
    expect((await readFleetManifest(backend.artifacts))!.hermeticd.version).toBe(
      FIXTURE_HERMETICD_VERSION,
    );
  });

  test("attaches to an existing foundation", async () => {
    // An account whose directory already knows this fleet: attach reads the
    // name it is filed under and registers nothing (§4.8).
    const backend = seedFixtureFoundation(new MemoryBackend({ directory: "seeded" }));
    const hermetic = testHermetic({ backend, config: null });
    const events = await drain(hermetic.init({ attach: true }));
    expect(events.some((e) => e.phase === "attach")).toBe(true);
    // `directory.ensure` is idempotent, and it is the only write an attach to a
    // registered fleet makes: nothing else about the account changes.
    expect(backend.mutations).toEqual(["directory.ensure"]);
  });

  /**
   * §4.6/§4.8: an account may hold several fleets, and a fleet is created with
   * no display alias at all — so a second `--create` in an account that already
   * holds one needs nothing from the operator and collides with nothing. There
   * is no name to ask for, which is the whole point of the change.
   */
  test("--create in an account that already has a fleet builds a second, unlabelled one", async () => {
    // The seeded account already holds `main` and `staging`, both labelled.
    const backend = seedFixtureFoundation(new MemoryBackend({ directory: "seeded" }));
    const hermetic = testHermetic({ backend, config: null });
    await drain(hermetic.init({ create: true, region: "us-west-2", tailnet: "acme.ts.net" }));

    const registered = await backend.directory.list();
    expect(registered).toHaveLength(3);
    expect(registered.filter((e) => e.name === null)).toHaveLength(1);
    expect(backend.mutations).toContain("foundation.createStack");
  });

  test("--attach fails when there is nothing to attach to", async () => {
    const hermetic = testHermetic({ backend: new MemoryBackend(), config: null });
    let code: string | null = null;
    try {
      await drain(hermetic.init({ attach: true }));
    } catch (e) {
      code = (e as HermeticError).code;
    }
    expect(code).toBe("NOT_FOUND");
  });

  test("a mistyped account id is refused", async () => {
    const hermetic = testHermetic({ backend: new MemoryBackend(), config: null });
    let code: string | null = null;
    try {
      await drain(hermetic.init({ create: true, confirm_account_id: "000000000000" }));
    } catch (e) {
      code = (e as HermeticError).code;
    }
    expect(code).toBe("CONFIRMATION_REQUIRED");
  });

  test("--attach and --create together are unsupported", async () => {
    const hermetic = testHermetic({ backend: new MemoryBackend(), config: null });
    let code: string | null = null;
    try {
      await drain(hermetic.init({ attach: true, create: true }));
    } catch (e) {
      code = (e as HermeticError).code;
    }
    expect(code).toBe("UNSUPPORTED");
  });
});

describe("apply", () => {
  test("refuses a plan kind it cannot execute yet", async () => {
    const { hermetic } = seeded();
    let code: string | null = null;
    try {
      await drain(
        hermetic.apply({
          plan: { kind: "upgrade", target: "atlas", options: {}, steps: [], warnings: [] },
          yes: true,
        }),
      );
    } catch (e) {
      code = (e as HermeticError).code;
    }
    expect(code).toBe("UNSUPPORTED");
  });
});

/**
 * §6.5: the fleet is upgraded one agent at a time. `--rolling N` used to run N
 * at once through a worker pool; it is gone, and these tests hold the line that
 * nothing reintroduces concurrency here by accident.
 */
describe("upgrade is serial", () => {
  /**
   * The per-agent work is the render and the upload, so that is where overlap
   * would show: `putObject` counts how many upgrades are inside it at once.
   */
  function watchUploads(backend: MemoryBackend): () => number {
    let inFlight = 0;
    let peak = 0;
    const real = backend.artifacts.putObject;
    backend.artifacts.putObject = async (key: string, body: Uint8Array) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        await new Promise((r) => setTimeout(r, 1));
        await real.call(backend.artifacts, key, body);
      } finally {
        inFlight -= 1;
      }
    };
    return () => peak;
  }

  test("the whole fleet is upgraded one at a time", async () => {
    const { backend, hermetic } = seeded();
    const peak = watchUploads(backend);

    const rows = (await hermetic.agents.list()).filter((r) => r.status !== "destroyed");
    const events = await drain(hermetic.upgrade({ all: true, hermes: "0.16.0" }));

    expect(peak()).toBe(1);
    for (const row of rows) {
      expect(events.some((e) => e.phase === `${row.name}:done`)).toBe(true);
    }
    expect(events.at(-1)).toMatchObject({ phase: "done", progress: 1 });
    expect(
      (await hermetic.agents.list())
        .filter((r) => r.status !== "destroyed")
        .every((r) => r.hermes_version === "0.16.0"),
    ).toBe(true);
  });

  test("events arrive grouped by agent, never interleaved", async () => {
    // The reason serial is worth the wall-clock: the stream reads top to bottom.
    // Under the old pool an agent's `:render` could land between another's
    // `:render` and `:done`.
    const { hermetic } = seeded();
    const events = await drain(hermetic.upgrade({ all: true, hermes: "0.16.0" }));

    const seen = new Set<string>();
    let current: string | null = null;
    for (const e of events) {
      const name = e.phase.includes(":") ? e.phase.split(":")[0]! : null;
      if (name === null || name === current) continue;
      expect(seen.has(name)).toBe(false);
      if (current !== null) seen.add(current);
      current = name;
    }
  });

  test("a failure stops the run and surfaces rather than being swallowed", async () => {
    const { backend, hermetic } = seeded();
    backend.artifacts.putObject = async () => {
      throw new HermeticError("CONFLICT", "the bucket refused");
    };

    await expect(drain(hermetic.upgrade({ all: true, hermes: "0.16.0" }))).rejects.toThrow(
      HermeticError,
    );
  });

  test("a failure leaves the agents before it upgraded and the rest untouched", async () => {
    const { backend, hermetic } = seeded();
    const rows = await hermetic.agents.list();
    expect(rows.length).toBeGreaterThan(2);

    // Fail on the third agent's upload, whichever that turns out to be.
    let uploads = 0;
    const real = backend.artifacts.putObject;
    backend.artifacts.putObject = async (key: string, body: Uint8Array) => {
      uploads += 1;
      if (uploads === 3) throw new HermeticError("CONFLICT", "the bucket refused");
      await real.call(backend.artifacts, key, body);
    };

    await expect(drain(hermetic.upgrade({ all: true, hermes: "0.16.0" }))).rejects.toThrow(
      HermeticError,
    );

    /**
     * Serial means the damage is a *prefix*: the agents before the failure took
     * the new pin, every agent after it is untouched, and nothing is left
     * locked. Three rows carry the pin rather than two because `upgradeOne`
     * writes it before it uploads — so the agent the upload failed on is pinned
     * to a version whose config never reached the bucket. Re-running the same
     * upgrade re-renders and re-uploads it, which is the point of leaving the
     * row honest about what it is pinned to.
     */
    const after = await hermetic.agents.list();
    const pinned = after.filter((r) => r.hermes_version === "0.16.0");
    expect(pinned.length).toBe(3);
    expect(after.length).toBeGreaterThan(pinned.length);
    for (const row of after) {
      expect((await backend.store.agents.get(row.name))!.lock).toBeNull();
    }
  });
});
