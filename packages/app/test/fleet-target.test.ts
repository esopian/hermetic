/**
 * §4.7 through the head: a mutation names the fleet it means, and the head
 * refuses it when that is not the fleet it is serving.
 *
 * The bug these cover is not hypothetical and not a race in the usual sense.
 * Fleet selection is a property of the *process*: `fleets.switch` repoints the
 * whole of it, and every open window with it. A window that has been showing
 * `main` since before a switch is still showing `main`'s agents, and the next
 * thing it sends — `agents.destroy` for `ember` — used to be executed against
 * whatever fleet the process had moved to. Both fixture fleets have an `ember`,
 * which is what makes the two-window test below a deletion rather than a
 * `NOT_FOUND`.
 *
 * `openState` rather than `new AppState({ hermetic })` for most of these: the
 * guard is only as strong as the state's ability to say which fleet it is on,
 * and `openState` is the path the app takes. A state built around a bare
 * instance takes its target from that instance instead, and is guarded exactly
 * as firmly — it used to be left unguarded on the grounds that it cannot
 * *switch* fleets, which is a fact about the process and not about the client
 * sending it a stale target. The last test in the mismatch block holds that
 * line.
 */
import { describe, expect, test } from "bun:test";
import { fleetTargetOf, isHermeticError, openHermetic } from "@hermetic/core";
import type { FleetTarget, Hermetic } from "@hermetic/core";
import { createChatOwner } from "../src/chat-owner.ts";
import type { HandlerContext } from "../src/handlers/ctx.ts";
import { dispatch } from "../src/handlers/dispatch.ts";
import { createStreamRegistry } from "../src/handlers/streams.ts";
import { memoryLog, type AppLog } from "../src/log.ts";
import { OpRegistry } from "../src/ops.ts";
import { MACHINERY_RPC, RPC_DECLARATIONS } from "../src/rpc/registry.ts";
import { AppState, fixedInstance, openState } from "../src/state.ts";
import { requirePlanTarget } from "../src/target.ts";
import { RequestValidationError } from "../src/validation.ts";
import { testHome } from "./home.ts";

const MAIN_ID = "fxtr0001";
const STAGING_ID = "sg7k2m4p";
const FIXTURE_ACCOUNT_ID = "123456789012";

const home = () => testHome("hermetic-target-");

/**
 * The methods that are deliberately *not* fleet-scoped, each with the reason a
 * `target` could not improve on. Anything else that mutates is expected to
 * carry the guard, and `BODIES` has to know how to ask it.
 */
const UNSCOPED: Record<string, string> = {
  // §4.6: the wizard's own method. There is no fleet to be wrong about yet —
  // naming one is what `init` is for — and every other method on an
  // uninitialized head refuses `NOT_INITIALIZED` before anything else.
  init: "runs before there is a fleet to name",
  // §4.8: laptop-level preferences rather than fleet state. Both name the fleet
  // they are about in the request itself, and neither touches the account.
  "fleets.use": "changes which fleet this laptop means, not the fleet",
  "fleets.alias": "changes a display label in the directory, not the fleet",
  // A provider's model catalogue, read with a key the request carried. It
  // reaches the provider and never AWS.
  "providers.models": "a provider read that carries a secret",
};

/**
 * The same decision for the requests that wrap no core method
 * (`MACHINERY_RPC`). None of them is fleet-scoped — but that has to be recorded
 * per name, not left as a gap nothing can look into, which is why a new
 * machinery name fails this file until it is written down here.
 */
const UNSCOPED_MACHINERY: Record<string, string> = {
  "app.checkForUpdate": "asks this build about itself; no account is involved",
  "app.info": "asks this build about itself; no account is involved",
  "app.installCli": "writes a shim onto this laptop's PATH",
  "app.notify": "raises a banner on this laptop",
  "app.openExternal": "hands a URL to this laptop's browser",
  "chat.observe.resume": "re-establishes this head's own observation; it writes nothing",
  "chat.subscribe": "reads this head's own observations",
  /**
   * Not an exemption on the merits — a hole, recorded as one.
   *
   * `chat.turn` is not a wrapper around the guarded `chat.send`: it is a second
   * dispatch entry that validates with `chatSendSchema` (which has no `target`
   * field) and calls `ctx.hermetic()` directly, so no §4.7 check runs on it at
   * all. It is also the only send path the page has — `packages/ui/src/api/chat.ts`
   * passes a `target` that zod then strips — so a window left open across a
   * fleet switch can land a turn on a box in the fleet the head moved to.
   *
   * TODO(evan): give `chat.turn` the same `withTarget`/`requireTarget` pair
   * `chat.send` has (`packages/app/src/handlers/chat.ts:229`). Left alone here
   * because adding a guard is a behaviour change, not part of the head cutover;
   * the pinning case below fails the moment it is fixed, which is the signal to
   * move this name into `BODIES` and delete both.
   */
  "chat.turn": "UNGUARDED — a known hole, pinned below; see the TODO(evan) above",
  "chat.turn.abort": "closes a stream this head opened",
  "chat.unsubscribe": "closes a stream this head opened",
  "fixture.chat.hint": "exists only in fixture mode, where there is no account to mismatch",
  "fixture.chat.inject": "exists only in fixture mode, where there is no account to mismatch",
  "fleet.subscribe": "reads this head's own poller",
  "fleet.unsubscribe": "closes a stream this head opened",
  "fleets.switch": "is the switch; a request bound to the fleet it leaves could never run",
  "init.acl": "renders a policy snippet from constants",
  "init.identity": "runs before there is a fleet to name",
  "init.profiles": "runs before there is a fleet to name",
  "init.tailscale": "probes this laptop's tailnet, not an account",
  "init.verifyOauth": "proves an OAuth client, and reaches Tailscale rather than AWS",
  "logs.close": "closes a stream this head opened",
  "logs.open": "a second transport of `logs`, whose own entry carries the guard",
  "meta.get": "describes this head",
  "ops.abort": "names an op on this head, which is already this head's fleet",
  "ops.get": "reads this head's op registry",
  "ops.list": "reads this head's op registry",
  "ops.subscribe": "reads this head's op registry",
  "ops.unsubscribe": "closes a stream this head opened",
};

/**
 * A params object each guarded method accepts, so that the refusal under test
 * is the fleet one and not a complaint about a missing field. None of them ever
 * runs: the guard answers before core does.
 */
const BODIES: Record<string, object> = {
  "artifacts.push": {},
  teardown: { yes: true, reset_local: false, confirm_account_id: FIXTURE_ACCOUNT_ID },
  "foundation.update": { yes: true },
  "agents.create": { name: "newbie" },
  "agents.set": { name: "ember", size: "large" },
  "agents.stop": { name: "ember" },
  "agents.start": { name: "ember" },
  "agents.recreate": { name: "ember", yes: true },
  "agents.destroy": { name: "ember", yes: true },
  "agents.rerun": { name: "ember" },
  "agents.reboot": { name: "ember" },
  "volumes.delete": { volume_id: "vol-fixture0", yes: true },
  "secrets.push": { name: "ember", bws_token: true, value: "FIXTURE-BWS-TOKEN" },
  "secrets.delete": { slug: "openrouter-key", yes: true },
  "settings.set": { defaults: { size: "small" } },
  "providers.create": { name: "vireo", provider: "openrouter", api_key: "FIXTURE-PROVIDER-KEY" },
  "providers.update": { profile: "ant00001", name: "anthropic-two" },
  "providers.delete": { profile: "ant00001", yes: true },
  upgrade: { name: "ember", hermes: "0.15.1" },
  apply: {
    plan: { kind: "teardown", target: "t", options: {}, steps: [], warnings: [] },
    yes: true,
  },

  "notifications.ack": { all: true },
  "notifications.mute": { agent: "ember" },
  "chat.listen": { instance: "ember", listening: true },
  "chat.send": { instance: "ember", bot: "default", message: "hello" },
  "chat.abort": { instance: "ember", bot: "default" },
  /* Bot Mode (§9.2): every one of these writes to a box. */
  "chat.open": { instance: "ember", bot: "default" },
  "chat.compact": { instance: "ember", bot: "default" },
  "chat.archive": { instance: "ember", bot: "default", session: "s-1" },
  "chat.respond": {
    instance: "ember",
    bot: "default",
    session: "s-1",
    request_id: "r-1",
    kind: "approval",
    choice: "once",
  },
  "bots.capabilities": { instance: "ember" },
  "bots.get": { instance: "ember", bot: "default" },
  "bots.create": { instance: "ember", name: "vireo" },
  "bots.update": { instance: "ember", bot: "default", description: "a bot" },
  "bots.delete": { instance: "ember", bot: "default", confirm: true },
  "rooms.list": { instance: "ember" },
  "rooms.get": { instance: "ember", room: "r-1" },
  "rooms.create": {
    instance: "ember",
    room: "r-1",
    name: "a room",
    members: [
      { instance: "ember", bot: "default" },
      { instance: "atlas", bot: "default" },
    ],
  },
  "rooms.rename": { instance: "ember", room: "r-1", name: "renamed", event_id: "e-1" },
  "rooms.delete": { instance: "ember", room: "r-1", confirm: true },
  "rooms.history": { instance: "ember", room: "r-1" },
  "rooms.send": { instance: "ember", room: "r-1", text: "hello", event_id: "e-1" },
  "rooms.control": { instance: "ember", room: "r-1", action: "stop" },
  "rooms.respond": {
    instance: "ember",
    room: "r-1",
    member_id: "m-1",
    task_id: "t-1",
    execution_generation: 0,
    request_id: "r-1",
    choice: "once",
  },
  "routines.list": { instance: "ember", bot: "default" },
  "routines.create": {
    instance: "ember",
    bot: "default",
    name: "nightly",
    prompt: "do the thing",
    schedule: "0 3 * * *",
  },
  "routines.update": { instance: "ember", bot: "default", id: "j-1", paused: true },
  "routines.delete": { instance: "ember", bot: "default", id: "j-1", confirm: true },
  "routines.run": { instance: "ember", bot: "default", id: "j-1" },
  "routines.history": { instance: "ember", bot: "default", id: "j-1" },
};

function contextFor(state: AppState, ops = new OpRegistry(), log?: AppLog): HandlerContext {
  return {
    state,
    hermetic: () => state.hermetic,
    ops,
    poller: () => state.poller,
    chatOwner: createChatOwner({ hermetic: () => state.hermetic }),
    fixture: true,
    opts: { fixture: true, ...(log ? { log } : {}) },
    ...(log ? { log } : {}),
    streams: createStreamRegistry(),
  };
}

async function harness() {
  // The fixture directory is process-global and `openForInit` empties it; every
  // harness puts the two seeded fleets back rather than depending on file order.
  const state = await openState({ fixture: true, home: home() });
  const ops = new OpRegistry();
  const log = memoryLog();
  return { state, ops, log, ctx: contextFor(state, ops, log) };
}

/**
 * Teardown refuses a fleet that still has agents on it, so every teardown test
 * here empties the fixture fleet first.
 */
async function empty(h: Hermetic): Promise<void> {
  for (const a of await h.agents.list()) {
    for await (const _e of h.agents.destroy({ name: a.name, yes: true })) {
      // drain to completion
    }
  }
}

async function emptyHarness() {
  const h = await harness();
  await empty(h.state.hermetic);
  return h;
}

/** The refusal a call threw: core's code, or the head's own validation code. */
async function refusal(run: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await run;
  } catch (e) {
    if (isHermeticError(e) || e instanceof RequestValidationError) return e;
    throw e;
  }
  throw new Error("expected a refusal; the call resolved");
}

const agent = (ctx: HandlerContext, name: string) =>
  dispatch(ctx, "agents.get", { name }) as Promise<{ name: string; status: string }>;

describe("§4.7: a mutation names the fleet it is for", () => {
  test("a head opened on a fleet knows the whole of that fleet's identity", async () => {
    const { state } = await harness();
    expect(state.target).toEqual({
      account_id: FIXTURE_ACCOUNT_ID,
      region: "us-west-2",
      fleet_id: MAIN_ID,
    });
  });

  /**
   * The whole point, in one test: two windows, one switch, and the stale one's
   * destroy lands on nothing. `ember` exists in both fixture fleets, so without
   * the guard this request deletes the *other* fleet's `ember` and reports
   * success while doing it.
   */
  test("a window left open across a switch is refused, and the agent it named is untouched", async () => {
    const { ctx, state, ops } = await harness();
    const stale = state.target as FleetTarget;
    expect(stale.fleet_id).toBe(MAIN_ID);

    await dispatch(ctx, "fleets.switch", { fleet: STAGING_ID });
    expect(state.target?.fleet_id).toBe(STAGING_ID);

    const e = await refusal(
      dispatch(ctx, "agents.destroy", { name: "ember", yes: true, target: stale }),
    );
    expect(e.code).toBe("FLEET_MISMATCH");
    // Both fleets by name, because "reload the page" is only useful advice when
    // the operator can see which page they were on.
    expect(e.message).toContain(MAIN_ID);
    expect(e.message).toContain(STAGING_ID);
    // Nothing was started, and `ember` on the fleet actually being served is
    // exactly where it was.
    expect(ops.list({ limit: 10 }).ops).toHaveLength(0);
    expect((await agent(ctx, "ember")).status).not.toBe("destroyed");
  });

  /**
   * The control for the test above: the same request, naming the fleet the head
   * is now serving, is obeyed. Without this the previous test would pass just as
   * well against a handler that refused everything.
   */
  test("the same request naming the fleet being served is obeyed", async () => {
    const { ctx, state, ops } = await harness();
    await dispatch(ctx, "fleets.switch", { fleet: STAGING_ID });

    const { op } = (await dispatch(ctx, "agents.destroy", {
      name: "ember",
      yes: true,
      target: state.target,
    })) as { op: { id: string } };
    expect((await ops.wait(op.id))?.status).toBe("ok");
    // §6.7: a finished destroy deletes the row and leaves a tombstone.
    expect(await refusal(agent(ctx, "ember"))).toMatchObject({ code: "NOT_FOUND" });
    const gone = (await dispatch(ctx, "agents.destroyed", { name: "ember" })) as Array<{
      name: string;
    }>;
    expect(gone.map((t) => t.name)).toEqual(["ember"]);
  }, 30_000);

  /**
   * `target` is `.optional()` in the schema so that an absent one is a
   * confirmation question rather than a field list (`target.ts`). This is the
   * test that keeps "optional" from quietly becoming "unenforced": a head that
   * has a fleet refuses a request that names none, exactly as it refuses one
   * that names the wrong fleet.
   */
  test("a mutation that says no fleet at all is refused just as firmly", async () => {
    const { ctx, state, ops } = await harness();
    expect(state.target).not.toBeNull();

    const e = await refusal(dispatch(ctx, "agents.destroy", { name: "ember", yes: true }));
    expect(e.code).toBe("FLEET_MISMATCH");
    expect(e.message).toContain("does not say which fleet");
    expect(ops.list({ limit: 10 }).ops).toHaveLength(0);
    expect((await agent(ctx, "ember")).status).not.toBe("destroyed");
  });

  /**
   * An unconfirmed mutation meets the fleet guard *first*. `agents.destroy`
   * without `yes` is a confirmation question, and it has to be asked about the
   * fleet the caller actually named — a head that answered
   * `CONFIRMATION_REQUIRED` to a request for a fleet it has left would be
   * inviting the operator to confirm the wrong deletion.
   */
  test("an unconfirmed mutation is refused by the fleet guard, not by the confirmation", async () => {
    const { ctx } = await harness();
    expect((await refusal(dispatch(ctx, "agents.destroy", { name: "atlas" }))).code).toBe(
      "FLEET_MISMATCH",
    );
  });

  /**
   * §4.7: the gap `requireTarget` being synchronous does not close.
   *
   * A destroy and a recreate both read the agent's immutable identity before
   * they start their op, for the pending log, and that read is a round trip. It
   * is the one `await` between the check that said which fleet this request is
   * for and the `ops.start` that writes the run and pending rows — and
   * `ops.start` asks the registry which fleet the head is on *now*. So a switch
   * landing in that window used to produce an op running against the fleet the
   * request named and rows claiming it ran against the fleet the head had moved
   * to; a pending row that names the wrong fleet is one a later boot replays
   * against the wrong fleet.
   */
  test("a switch landing during the identity read refuses the destroy", async () => {
    const { ctx, state, ops } = await harness();
    const mine = state.target;
    expect(mine?.fleet_id).toBe(MAIN_ID);

    // Hold the handler inside `agents.get`, which is where its only `await`
    // before `ops.start` is, so the switch below lands in exactly that gap.
    let entered = false;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agents: Pick<Hermetic["agents"], "get"> = state.hermetic.agents;
    const read = agents.get;
    agents.get = (name: string) => {
      entered = true;
      return gate.then(() => read(name));
    };

    const started = dispatch(ctx, "agents.destroy", { name: "ember", yes: true, target: mine });
    while (!entered) await new Promise((r) => setTimeout(r, 1));

    await dispatch(ctx, "fleets.switch", { fleet: STAGING_ID });
    expect(state.target?.fleet_id).toBe(STAGING_ID);

    release();
    const e = await refusal(started);
    expect(e.code).toBe("FLEET_MISMATCH");
    expect(e.message).toContain(STAGING_ID);
    // No op, so no run row and no pending row: nothing was written that could
    // name either fleet, and nothing is left for a later boot to replay.
    expect(ops.list({ limit: 10 }).ops).toHaveLength(0);
  }, 30_000);

  /**
   * Every fleet-scoped mutation, asked rather than remembered.
   *
   * This used to name six routes by hand, so it tested the six somebody thought
   * of. Each entry in `BODIES` is now *probed*: the method is dispatched with a
   * target belonging to another account, and the answer has to be the fleet
   * refusal. A method listed here that stopped being guarded fails, and a stale
   * entry fails the completeness check below rather than rotting quietly.
   */
  test("the guard is on the whole mutating surface, not only destroy", async () => {
    const { ctx } = await harness();
    const elsewhere: FleetTarget = {
      account_id: "999999999999",
      region: "eu-west-1",
      fleet_id: STAGING_ID,
    };

    for (const [name, body] of Object.entries(BODIES)) {
      // A sink for the streaming entries (`chat.send`): without one
      // `requireSink` refuses `UNSUPPORTED` before the guard is reached, which
      // would make this loop green for the wrong reason.
      const e = await refusal(dispatch(ctx, name, { ...body, target: elsewhere }, () => {}));
      expect([name, e.code]).toEqual([name, "FLEET_MISMATCH"]);
    }
  });

  /**
   * Every name this head answers is classified exactly once: guarded (and
   * probed above), a declared method that is deliberately unscoped, machinery
   * with its reason, or a read. A name that is none of those is a method
   * somebody added without deciding, which is the gap the derivation exists to
   * close.
   */
  test("every declared method and every machinery name is accounted for", () => {
    const declared = RPC_DECLARATIONS.map((d) => d.path);
    const unknown = [...declared, ...MACHINERY_RPC].filter(
      (name) => !(name in BODIES) && !(name in UNSCOPED) && !(name in UNSCOPED_MACHINERY),
    );
    // Reads are the remainder, and they are named so that a *mutation* landing
    // in this list is visible rather than absorbed.
    expect(unknown.every((name) => !name.endsWith(".create") && !name.endsWith(".delete"))).toBe(true);
    // Nothing in the three tables names a request this head does not answer.
    const answered = new Set([...declared, ...MACHINERY_RPC]);
    expect(
      [...Object.keys(BODIES), ...Object.keys(UNSCOPED), ...Object.keys(UNSCOPED_MACHINERY)].filter(
        (name) => !answered.has(name),
      ),
    ).toEqual([]);
    // And every machinery name has a reason written down.
    expect([...MACHINERY_RPC].filter((n) => !(n in UNSCOPED_MACHINERY)).sort()).toEqual([]);
  });

  /**
   * The hole `UNSCOPED_MACHINERY` records for `chat.turn`, pinned so it cannot
   * be forgotten and cannot be fixed silently.
   *
   * `test.failing` on purpose: it passes while the hole is open and *fails* the
   * day someone gives `chat.turn` a target guard — which is when this case and
   * the `UNSCOPED_MACHINERY` entry both go, and the name joins `BODIES` above.
   */
  test.failing("chat.turn refuses a foreign target the way `chat.send` does", async () => {
    const { ctx } = await harness();
    const elsewhere: FleetTarget = {
      account_id: "999999999999",
      region: "eu-west-1",
      fleet_id: STAGING_ID,
    };
    const outcome = await dispatch(
      ctx,
      "chat.turn",
      { instance: "ember", bot: "default", message: "hello", target: elsewhere },
      () => {},
    ).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    // Today this resolves with a `stream_id`: the turn was accepted against the
    // fleet the request did not name. Close it before asserting, so the pinning
    // case leaves no live turn behind whichever way it goes.
    if ("value" in outcome) {
      ctx.streams.close((outcome.value as { stream_id: string }).stream_id);
      throw new Error("chat.turn accepted a foreign target");
    }
    expect(isHermeticError(outcome.error) ? outcome.error.code : outcome.error).toBe("FLEET_MISMATCH");
  });

  /**
   * §4.7: the same guard on a head built around a bare `Hermetic`.
   *
   * That shape used to leave `state.target` null, on the reasoning that such a
   * head cannot switch fleets so no request could have meant a different one.
   * It is a statement about the head and the danger is on the client: whatever
   * is talking to it still sends the target it last read.
   */
  test("a head built around a single instance is guarded too", async () => {
    const hermetic = await openHermetic({ fixture: true, home: home() });
    const mine = fleetTargetOf(await hermetic.config.show());
    const ops = new OpRegistry();
    const state = new AppState({
      fixture: true,
      home: ":memory:",
      reopen: fixedInstance(hermetic),
      hermetic,
      target: mine,
    });
    const ctx = contextFor(state, ops);

    expect(
      (
        await refusal(
          dispatch(ctx, "agents.destroy", {
            name: "ember",
            yes: true,
            target: { ...mine, account_id: "999999999999" },
          }),
        )
      ).code,
    ).toBe("FLEET_MISMATCH");
    expect((await refusal(dispatch(ctx, "agents.destroy", { name: "ember", yes: true }))).code).toBe(
      "FLEET_MISMATCH",
    );

    // Nothing was destroyed by either, and the fleet it *is* serving still works.
    expect(ops.list({ limit: 10 }).ops).toHaveLength(0);
    expect(
      await dispatch(ctx, "agents.destroy", { name: "ember", yes: true, target: mine }),
    ).toMatchObject({ op: expect.anything() });
  });
});

describe("§4.7: a plan is applied to the fleet it was computed against", () => {
  test("a plan whose summary names another fleet is refused before anything runs", async () => {
    const { ctx, state, ops } = await harness();
    const plan = (await dispatch(ctx, "plan.teardown", {})) as {
      summary?: Record<string, unknown>;
    };
    expect(plan.summary).toBeTruthy();

    const e = await refusal(
      dispatch(ctx, "apply", {
        // The request names this fleet; the *document* names another. A plan
        // that reached this head from somewhere else is still a plan about
        // somewhere else.
        plan: { ...plan, summary: { ...plan.summary, account_id: "999999999999" } },
        yes: true,
        confirm_account_id: FIXTURE_ACCOUNT_ID,
        target: state.target,
      }),
    );
    expect(e.code).toBe("FLEET_MISMATCH");
    expect(ops.list({ limit: 10 }).ops).toHaveLength(0);
  });

  /**
   * "Absent" and "present and unreadable" are different facts about a summary,
   * and they used to get the same answer: an older hermetic's plan carries no
   * summary and is applied on the strength of the request's own target, and a
   * summary that failed to parse took the same path. So one malformed field
   * disarmed the binding the summary exists to provide. A summary that is there
   * and cannot be read is refused.
   */
  test("a plan whose summary cannot be read is refused, not treated as absent", async () => {
    const { ctx, state, ops } = await harness();
    const plan = (await dispatch(ctx, "plan.teardown", {})) as {
      summary?: Record<string, unknown>;
    };

    // Not another fleet — no fleet this head can check against at all.
    await refusal(
      dispatch(ctx, "apply", {
        plan: { ...plan, summary: { ...plan.summary, account_id: "not-an-account" } },
        yes: true,
        confirm_account_id: FIXTURE_ACCOUNT_ID,
        target: state.target,
      }),
    );
    expect(ops.list({ limit: 10 }).ops).toHaveLength(0);
  });

  /**
   * The same refusal at the seam itself, because the handler reaches it only
   * for a document the request schema let through: `PlanSummary` carries the
   * same `AccountId`/`Region` primitives `FleetTarget` does, so a malformed
   * summary is usually caught one step earlier. Both steps have to refuse, or a
   * document reaching `apply` by some other door is unbound again.
   */
  test("requirePlanTarget refuses an unparseable summary directly", async () => {
    const { state } = await harness();
    expect(() =>
      requirePlanTarget(state, { account_id: "nope", region: "nowhere", fleet_id: "fxtr0001" }),
    ).toThrow(/does not name a fleet this portal can check it against/);
    // The control: a summary naming this very fleet is not refused.
    expect(() => requirePlanTarget(state, state.target!)).not.toThrow();
  });

  /**
   * A teardown plan applied here *is* a teardown, and used to be the one door
   * into it that claimed no slot: the head stayed open to agent mutations while
   * its own foundation was being deleted.
   */
  test("applying a teardown plan claims the teardown slot and blocks mutations", async () => {
    const { ctx, state, ops } = await emptyHarness();
    const plan = await dispatch(ctx, "plan.teardown", {});

    const { op } = (await dispatch(ctx, "apply", {
      plan,
      yes: true,
      confirm_account_id: FIXTURE_ACCOUNT_ID,
      target: state.target,
    })) as { op: { id: string } };
    expect(state.teardownOpId).toBe(op.id);

    expect(
      (await refusal(dispatch(ctx, "agents.create", { name: "probe", target: state.target }))).code,
    ).toBe("CONFLICT");

    expect((await ops.wait(op.id))?.status).toBe("ok");
    // The slot is released only once the state has finished changing, and that
    // now includes re-running fleet selection (§4.6), so the wait above is not
    // enough on its own.
    for (let i = 0; i < 200 && state.teardownOpId !== null; i += 1) await Bun.sleep(1);
    expect(state.teardownOpId).toBeNull();
  }, 60_000);

  /**
   * And the other half of what `teardown` does and this door did not:
   * `reset_local` resets this laptop's local state, and the head follows it
   * onto whatever fleet is left (§4.6) — here `staging`, which this home froze
   * alongside the fleet the teardown removed.
   */
  test("applying a teardown plan with reset_local re-runs fleet selection", async () => {
    const { ctx, state, ops } = await emptyHarness();
    const plan = (await dispatch(ctx, "plan.teardown", { reset_local: true })) as {
      options: { reset_local?: boolean };
    };
    expect(plan.options.reset_local).toBe(true);

    const { op } = (await dispatch(ctx, "apply", {
      plan,
      yes: true,
      confirm_account_id: FIXTURE_ACCOUNT_ID,
      target: state.target,
    })) as { op: { id: string } };
    expect((await ops.wait(op.id))?.status).toBe("ok");
    for (let i = 0; i < 200 && state.teardownOpId !== null; i += 1) await Bun.sleep(1);
    expect(state.fleetId).toBe(STAGING_ID);
    // The receipt is still shown once, and it names the fleet that is gone.
    expect(state.lastTeardown?.fleet_id).toBe(MAIN_ID);
  }, 60_000);
});

/**
 * The teardown slot is claimed before the plan is computed, not after. Planning
 * is two awaits during which the state used to believe nothing was in flight,
 * so a switch arriving in the gap was accepted and the teardown that followed
 * deleted a foundation nobody had planned.
 *
 * The gate is a stand-in for a slow `DescribeStacks`. Driving the real one and
 * hoping the switch lands inside it is a test that eventually loses its race.
 */
describe("§4.7: a teardown holds the fleet from the moment it is confirmed", () => {
  test("a switch during planning is refused, and the planned fleet is the one torn down", async () => {
    const base: Hermetic = await openHermetic({ fixture: true, home: home() });
    await empty(base);
    const config = await base.config.show();
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const gated: Hermetic = {
      ...base,
      plan: {
        ...base.plan,
        teardown: async (input) => {
          await gate;
          return base.plan.teardown(input);
        },
      },
    };
    const state = new AppState({
      fixture: true,
      home: home(),
      reopen: () => Promise.resolve(base),
      hermetic: gated,
      fleetId: config.fleet_id,
      target: fleetTargetOf(config),
    });
    const ops = new OpRegistry();
    const ctx = contextFor(state, ops);

    const started = dispatch(ctx, "teardown", {
      yes: true,
      reset_local: false,
      confirm_account_id: FIXTURE_ACCOUNT_ID,
      target: state.target,
    });
    // The claim is synchronous with the handler; one turn of the loop is enough
    // and no more is needed.
    while (state.teardownOpId === null) await new Promise((r) => setTimeout(r, 1));

    expect((await refusal(dispatch(ctx, "fleets.switch", { fleet: STAGING_ID }))).code).toBe(
      "CONFLICT",
    );
    expect(state.target?.fleet_id).toBe(MAIN_ID);

    open();
    const { op } = (await started) as { op: { id: string } };
    // The reservation is replaced by the real op id, not stacked on top of it.
    expect(state.teardownOpId).toBe(op.id);
    expect((await ops.wait(op.id))?.status).toBe("ok");
    await Promise.resolve();
    await Promise.resolve();
    expect(state.teardownOpId).toBeNull();
  }, 60_000);

  test("a plan that throws releases the slot instead of wedging the head", async () => {
    const base: Hermetic = await openHermetic({ fixture: true, home: home() });
    const config = await base.config.show();
    const gated: Hermetic = {
      ...base,
      plan: {
        ...base.plan,
        teardown: () => Promise.reject(new Error("describe-stacks is having a day")),
      },
    };
    const state = new AppState({
      fixture: true,
      home: home(),
      reopen: () => Promise.resolve(base),
      hermetic: gated,
      fleetId: config.fleet_id,
      target: fleetTargetOf(config),
    });

    await refusal(
      dispatch(contextFor(state), "teardown", {
        yes: true,
        reset_local: false,
        confirm_account_id: FIXTURE_ACCOUNT_ID,
        target: state.target,
      }),
    ).catch(() => {});
    expect(state.teardownOpId).toBeNull();
  });
});
