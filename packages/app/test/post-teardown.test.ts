/**
 * What the head is after a teardown (§4.6, §4.8).
 *
 * `teardown --reset-local` drops the row of the fleet it removed and no other,
 * and returns the home to uninitialized only when no fleet row is left. The
 * head has to answer the same way, because it is what the operator is looking
 * at when it happens: a two-fleet laptop dropped into the init wizard is being
 * told it has nothing frozen, which is false, and the fleet switcher that would
 * fix it is behind the screen it was just sent to.
 *
 * Driven through `dispatch`, so what is asserted is what the handlers did —
 * the head's answer, not a transport's rendering of it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearConfig,
  fixtureConfigFor,
  openLocalDb,
  setDefaultFleet,
  writeConfig,
} from "@hermetic/core";
import { createChatOwner, type ChatOwner } from "../src/chat-owner.ts";
import type { HandlerContext } from "../src/handlers/ctx.ts";
import { dispatch } from "../src/handlers/dispatch.ts";
import { createStreamRegistry } from "../src/handlers/streams.ts";
import { OpRegistry } from "../src/ops.ts";
import { openState } from "../src/state.ts";

const MAIN_ID = fixtureConfigFor("main").fleet_id;
const STAGING_ID = fixtureConfigFor("staging").fleet_id;

const homes: string[] = [];
const owners: ChatOwner[] = [];
afterAll(async () => {
  for (const owner of owners.splice(0)) await owner.stop();
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

/**
 * A head on the fixture `main` fleet, in its own home, with every agent
 * already destroyed — teardown refuses while any is alive, exactly as it would
 * against a real account.
 */
async function headOnMain() {
  const home = mkdtempSync(join(tmpdir(), "hermetic-post-teardown-"));
  homes.push(home);
  const state = await openState({ fixture: true, home });
  const ops = new OpRegistry();
  const chatOwner = createChatOwner({ hermetic: () => state.hermetic });
  owners.push(chatOwner);
  const ctx: HandlerContext = {
    state,
    hermetic: () => state.hermetic,
    ops,
    poller: () => state.poller,
    chatOwner,
    fixture: true,
    opts: { fixture: true },
    streams: createStreamRegistry(),
  };
  for (const agent of await state.hermetic.agents.list()) {
    for await (const _e of state.hermetic.agents.destroy({ name: agent.name, yes: true })) {
      // drain to completion
    }
  }
  return { home, state, ops, ctx, target: state.target };
}

/** Runs the teardown the dashboard runs, and waits for the reset behind it. */
async function tearDown(h: Awaited<ReturnType<typeof headOnMain>>): Promise<void> {
  const { op } = (await dispatch(h.ctx, "teardown", {
    yes: true,
    reset_local: true,
    confirm_account_id: fixtureConfigFor("main").account_id,
    target: h.target,
  })) as { op: { id: string } };
  expect((await h.ops.wait(op.id))?.status).toBe("ok");
  for (let i = 0; i < 200 && h.state.teardownOpId !== null; i += 1) await Bun.sleep(10);
  expect(h.state.teardownOpId).toBeNull();
}

describe("the head after a teardown", () => {
  test("post-teardown state adopts a surviving fleet", async () => {
    const h = await headOnMain();
    expect(h.state.fleetId).toBe(MAIN_ID);

    await tearDown(h);

    // `staging` is still frozen in this home, so the head is serving it — not
    // sitting in a wizard telling the operator to run `init`.
    expect(h.state.initialized).toBe(true);
    expect(h.state.fleetId).toBe(STAGING_ID);
    expect(h.state.target?.fleet_id).toBe(STAGING_ID);
    expect(h.state.fleetError).toBeNull();
    expect(h.state.poller).not.toBeNull();

    const meta = (await dispatch(h.ctx, "meta.get", {})) as {
      initialized: boolean;
      fleet: { id: string };
      last_teardown: { fleet_id: string } | null;
    };
    expect(meta.initialized).toBe(true);
    expect(meta.fleet.id).toBe(STAGING_ID);
    // The receipt still has to be shown once: the fleet that was torn down is
    // gone whatever this head is serving now.
    expect(meta.last_teardown?.fleet_id).toBe(MAIN_ID);

    // The dashboard is live against the surviving fleet, not the deleted one.
    const agents = (await dispatch(h.ctx, "agents.list", {})) as Array<{ name: string }>;
    expect(agents.map((a) => a.name).sort()).toEqual(["ember", "quill"]);
  });

  test("with no fleet left, the wizard is still the answer", async () => {
    const h = await headOnMain();
    // A single-fleet laptop: forget the other row before the teardown, which is
    // the shape every home had before §4.8.
    const local = openLocalDb({ home: h.home, fixture: true });
    clearConfig(local.db, STAGING_ID);
    local.close();

    await tearDown(h);

    expect(h.state.initialized).toBe(false);
    expect(h.state.fleetId).toBeNull();
    expect(h.state.session).not.toBeNull();
    expect(h.state.fleetError).toBeNull();
    // The wizard's first step is callable, which is what "still the answer"
    // means: an already-initialized home refuses it with `CONFLICT`.
    const { profiles } = (await dispatch(h.ctx, "init.profiles", {})) as { profiles: unknown[] };
    expect(Array.isArray(profiles)).toBe(true);
  });

  test("fleets left but none selectable is the picker, not the wizard", async () => {
    const h = await headOnMain();
    // Three rows, so tearing one down leaves two and no rule that picks
    // between them: the recoverable selection state, reached from a teardown
    // instead of from a boot.
    const local = openLocalDb({ home: h.home, fixture: true });
    writeConfig(local.db, { ...fixtureConfigFor("staging"), fleet_id: "zz111111", name: "spare" });
    setDefaultFleet(local.db, MAIN_ID);
    local.close();

    await tearDown(h);

    expect(h.state.initialized).toBe(false);
    expect(h.state.fleetError?.code).toBe("FLEET_REQUIRED");
    // The switcher is what resolves it, and it still works.
    const switched = (await dispatch(h.ctx, "fleets.switch", { fleet: STAGING_ID })) as {
      fleet_id: string;
    };
    expect(switched.fleet_id).toBe(STAGING_ID);
    expect(h.state.fleetId).toBe(STAGING_ID);
    expect(h.state.fleetError).toBeNull();
  });
});
