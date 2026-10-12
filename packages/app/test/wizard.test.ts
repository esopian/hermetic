/**
 * The browser init wizard (§4.7 from a window instead of a terminal).
 *
 * The whole point is that the app comes up on a laptop that has never run
 * `init`: the head holds core's pre-init instance, serves the page, walks the
 * operator through profile → identity → twelve digits → create, and then swaps
 * the initialized instance in behind every request without a restart.
 *
 * Driven through `dispatch`: what is asserted is what the handlers answered and
 * which code they refused with, not how a transport rendered either.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createChatOwner } from "../src/chat-owner.ts";
import type { HandlerContext } from "../src/handlers/ctx.ts";
import { dispatch } from "../src/handlers/dispatch.ts";
import { createStreamRegistry, type StreamFrame } from "../src/handlers/streams.ts";
import { testHome } from "./home.ts";
import { OpRegistry } from "../src/ops.ts";
import { type AppState, openState } from "../src/state.ts";
import {
  FIXTURE_CONFIG,
  clearConfig,
  fixtureConfigFor,
  isHermeticError,
  openLocalDb,
  redactInitInput,
  writeConfig,
} from "@hermetic/core";
import type { Hermetic } from "@hermetic/core";
import { RequestValidationError } from "../src/validation.ts";

const SECRET = "tskey-client-WIZARD-SECRET-do-not-log";

function contextFor(state: AppState, ops: OpRegistry, fixture = true): HandlerContext {
  return {
    state,
    hermetic: () => state.hermetic,
    ops,
    poller: () => state.poller,
    chatOwner: createChatOwner({ hermetic: () => state.hermetic }),
    fixture,
    opts: { fixture },
    streams: createStreamRegistry(),
  };
}

/** An uninitialized head over the memory backend: no AWS, no local database. */
async function wizard() {
  const state = await openState({ fixture: true, uninitialized: true, home: testHome() });
  const ops = new OpRegistry();
  return { state, ops, ctx: contextFor(state, ops) };
}

/**
 * The refusal a call threw, as the code and sentence a caller is given.
 *
 * Both kinds count: core's `HermeticError` and the head's own
 * `RequestValidationError`, which carries an `ErrorCode` of its own for a
 * request that never reached core.
 */
async function refusal(run: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await run;
  } catch (e) {
    if (isHermeticError(e) || e instanceof RequestValidationError) return e;
    throw e;
  }
  throw new Error("expected a refusal; the call resolved");
}

/** Drains a stream request into the frames it pushed, then closes it. */
async function drain(
  ctx: HandlerContext,
  name: string,
  params: Record<string, unknown>,
): Promise<StreamFrame[]> {
  const frames: StreamFrame[] = [];
  const { stream_id } = (await dispatch(ctx, name, params, (f) => void frames.push(f))) as {
    stream_id: string;
  };
  const handle = ctx.streams.get(stream_id);
  // The op has already settled in every caller here, so `done` resolves on its
  // own; the close is the belt for an op that somehow has not.
  await Promise.race([handle?.done ?? Promise.resolve(), Bun.sleep(2000)]);
  ctx.streams.close(stream_id);
  return frames;
}

describe("an uninitialized head", () => {
  test("boots, and says so", async () => {
    const { ctx } = await wizard();
    const meta = (await dispatch(ctx, "meta.get", {})) as {
      initialized: boolean;
      header: string;
      config: unknown;
      tailnet: unknown;
      home: string;
      fixture: boolean;
    };
    expect(meta.initialized).toBe(false);
    expect(meta.header).toBe(`▸ not initialized · ${meta.home} · FIXTURE`);
    expect(meta.config).toBeNull();
    expect(meta.tailnet).toBeNull();
    expect(meta.fixture).toBe(true);
    expect(meta.home).toBeString();
  });

  test("refuses the fleet methods with the code the UI switches on", async () => {
    const { ctx } = await wizard();
    expect((await refusal(dispatch(ctx, "agents.list", {}))).code).toBe("NOT_INITIALIZED");
  });

  test("has no poller, so nothing is scanning an account that is not chosen yet", async () => {
    const { state, ctx } = await wizard();
    expect(state.poller).toBeNull();
    expect((await refusal(dispatch(ctx, "fleet.subscribe", {}, () => {}))).code).toBe("UNSUPPORTED");
  });
});

describe("--uninitialized never masks an already-initialized real home", () => {
  test("every init.* request still refuses once this home has a frozen config", async () => {
    const home = mkdtempSync(join(tmpdir(), "hermetic-uninit-guard-"));
    try {
      // A real, already-initialized home: `HERMETIC_UNINIT=1` exists to force
      // the wizard on a laptop that has never run `init`, not to reopen the
      // "already initialized" refusals on one that has (item 1).
      const local = openLocalDb({ home });
      writeConfig(local.db, FIXTURE_CONFIG);
      local.close();

      const fakeHermetic = {
        config: {
          show: async () => ({ ...FIXTURE_CONFIG, stack_id: null, tailnet: null }),
        },
        agents: { list: async () => [] },
      } as unknown as Hermetic;

      const state = await openState({
        fixture: false,
        uninitialized: true,
        home,
        hermetic: fakeHermetic,
      });
      expect(state.initialized).toBe(true);
      expect(state.session).toBeNull();

      const ctx = contextFor(state, new OpRegistry(), false);
      const calls: Array<[string, Record<string, unknown>]> = [
        ["init.profiles", {}],
        ["init.identity", { profile: "acme-dev" }],
        ["init.acl", {}],
        ["init.tailscale", {}],
        ["init.verifyOauth", { secret: SECRET }],
        ["init", { profile: "acme-dev", account_id_typed: FIXTURE_CONFIG.account_id }],
      ];
      for (const [name, params] of calls) {
        expect([name, (await refusal(dispatch(ctx, name, params))).code]).toEqual([name, "CONFLICT"]);
      }

      state.poller?.stop();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("step 1: the profile picker", () => {
  test("lists profiles without resolving any identity", async () => {
    const { ctx } = await wizard();
    const { profiles } = (await dispatch(ctx, "init.profiles", {})) as {
      profiles: Array<{ name: string; region: string | null; credential_type: string }>;
    };
    expect(profiles.map((p) => p.name)).toEqual(["acme-dev", "acme-prod", "sandbox"]);
    expect(profiles[0]).toMatchObject({ region: "us-west-2", credential_type: "sso" });
  });
});

describe("step 2: resolving one identity", () => {
  test("returns the account and whether a foundation is already there", async () => {
    const { ctx } = await wizard();
    const body = (await dispatch(ctx, "init.identity", { profile: "acme-dev" })) as {
      identity: { account_id: string; region: string; profile: string; alias: string | null };
      foundation: { found: boolean; fleet_id: string | null; tailnet: string | null };
    };
    // The region came from the profile's own default, not from the request:
    // core resolves in the region it is handed and does not guess.
    expect(body.identity).toMatchObject({
      account_id: "123456789012",
      region: "us-west-2",
      profile: "acme-dev",
      alias: "acme-dev",
    });
    // A fresh account: the wizard shows the `create` branch.
    expect(body.foundation.found).toBe(false);
    expect(body.foundation.fleet_id).toBeNull();
  });

  test("an explicit region overrides the profile's default", async () => {
    const { ctx } = await wizard();
    const body = (await dispatch(ctx, "init.identity", {
      profile: "acme-dev",
      region: "eu-west-1",
    })) as { identity: { region: string } };
    expect(body.identity.region).toBe("eu-west-1");
  });

  test("`credential_type` and `source` stay snake_case for the UI", async () => {
    const { ctx } = await wizard();
    const { profiles } = (await dispatch(ctx, "init.profiles", {})) as {
      profiles: Array<Record<string, unknown>>;
    };
    expect(Object.keys(profiles[0] ?? {}).sort()).toEqual([
      "credential_type",
      "name",
      "region",
      "source",
    ]);
  });

  test("an unnamed profile is a validation refusal, not an internal error", async () => {
    const { ctx } = await wizard();
    expect((await refusal(dispatch(ctx, "init.identity", {}))).code).toBe("VALIDATION");
  });

  /**
   * §4.7 preflight. Step 3 shows this instead of asking the operator to type a
   * tailnet nothing validated — and `init` refuses the create branch on the same
   * reading, so the panel is a preview of a gate, not a substitute for one.
   */
  test("the preflight reports which tailnet this machine is on", async () => {
    const { ctx } = await wizard();
    const { tailscale } = (await dispatch(ctx, "init.tailscale", {})) as {
      tailscale: { ok: boolean; tailnet: string | null; problem: string | null };
    };
    expect(tailscale.ok).toBe(true);
    expect(tailscale.tailnet).toBe("hermetic.ts.net");
    expect(tailscale.problem).toBeNull();
  });

  test("the OAuth client is verified by using it, and the verdict carries no secret", async () => {
    const { ctx } = await wizard();
    const verdict = await dispatch(ctx, "init.verifyOauth", { secret: SECRET });
    expect(verdict).toMatchObject({ oauth: { ok: true, authenticated: true, can_mint: true } });
    // §8.3: the secret is an input; it must not come back out.
    expect(JSON.stringify(verdict)).not.toContain("WIZARD-SECRET");
  });

  test("verifying with no secret is a validation refusal", async () => {
    const { ctx } = await wizard();
    expect((await refusal(dispatch(ctx, "init.verifyOauth", {}))).code).toBe("VALIDATION");
  });

  test("the tailnet policy snippet is available for step 4", async () => {
    const { ctx } = await wizard();
    const { snippet, parts } = (await dispatch(ctx, "init.acl", {})) as {
      snippet: string;
      parts: Array<{ key: string; body: string }>;
    };
    expect(snippet).toContain("tag:hermetic");
    expect(snippet).toContain("tagOwners");
    // The wizard pastes these one per top-level key, policy first (§4.7 step 4).
    expect(parts.map((p) => p.key)).toEqual(["tagOwners", "ssh", "acls"]);
  });
});

describe("step 3: init itself", () => {
  test("needs the twelve digits", async () => {
    const { ctx } = await wizard();
    expect((await refusal(dispatch(ctx, "init", { profile: "acme-dev" }))).code).toBe(
      "CONFIRMATION_REQUIRED",
    );
  });

  test("needs a profile to bind to", async () => {
    const { ctx } = await wizard();
    expect((await refusal(dispatch(ctx, "init", { account_id_typed: "123456789012" }))).code).toBe(
      "VALIDATION",
    );
  });

  test("mode: attach with no foundation is refused before any op starts", async () => {
    const { ctx, ops } = await wizard();
    const e = await refusal(
      dispatch(ctx, "init", {
        profile: "acme-dev",
        account_id_typed: "123456789012",
        mode: "attach",
        tailnet: "hermetic.ts.net",
      }),
    );
    expect(e.code).toBe("CONFLICT");
    // The point of the synchronous refusal: no op was started to fail later.
    expect(ops.list({}).ops.length).toBe(0);
  });

  test("the whole flow: identity → init → the dashboard appears", async () => {
    const { ctx, ops, state } = await wizard();

    // A region and tailnet the operator actually chose, not the fixture's own
    // defaults (`us-west-2` / `hermetic.ts.net`) — the point of this test is
    // that what the operator sent is what the dashboard shows afterward, not
    // whatever `--fixture` would have frozen on its own (§4.7 / `adopt()`).
    const identity = (await dispatch(ctx, "init.identity", {
      profile: "acme-dev",
      region: "eu-west-1",
    })) as { identity: { account_id: string; region: string } };
    expect(identity.identity.region).toBe("eu-west-1");

    const { op_id } = (await dispatch(ctx, "init", {
      profile: "acme-dev",
      region: identity.identity.region,
      account_id_typed: identity.identity.account_id,
      mode: "create",
      tailnet: "live.example.net",
      tailscale_oauth_secret: SECRET,
      network: "public",
    })) as { op_id: string };

    const summary = await ops.wait(op_id);
    expect(summary?.status).toBe("ok");
    expect(summary?.method).toBe("init");

    // The swap is scheduled off the op's completion, so give the microtask that
    // reopens core a turn.
    for (let i = 0; i < 50 && !state.initialized; i += 1) await Bun.sleep(10);
    expect(state.initialized).toBe(true);

    const meta = (await dispatch(ctx, "meta.get", {})) as {
      initialized: boolean;
      header: string;
      tailnet: string | null;
      config: { region: string } | null;
    };
    expect(meta.initialized).toBe(true);
    expect(meta.header).toContain("123456789012");
    // Sent values, not the fixture's baked-in defaults: this is what breaks if
    // `adopt()` reopens a fresh `FIXTURE_CONFIG` instead of using
    // `session.reopen()` on the same in-memory backend the wizard wrote to.
    expect(meta.tailnet).toBe("live.example.net");
    expect(meta.config?.region).toBe("eu-west-1");

    // Same context, same handlers, no restart.
    expect(((await dispatch(ctx, "agents.list", {})) as unknown[]).length).toBe(11);

    // And the poller the uninitialized head had no fleet for is running.
    expect(state.poller).not.toBeNull();
  });

  test("the wizard requests close once the home is initialized", async () => {
    const { ctx, ops, state } = await wizard();
    const { op_id } = (await dispatch(ctx, "init", {
      profile: "acme-dev",
      account_id_typed: "123456789012",
      mode: "create",
      tailnet: "hermetic.ts.net",
    })) as { op_id: string };
    await ops.wait(op_id);
    for (let i = 0; i < 50 && !state.initialized; i += 1) await Bun.sleep(10);

    for (const [name, params] of [
      ["init.profiles", {}],
      ["init.acl", {}],
      ["init.identity", { profile: "acme-dev" }],
      ["init", { account_id_typed: "123456789012" }],
    ] as Array<[string, Record<string, unknown>]>) {
      const e = await refusal(dispatch(ctx, name, params));
      expect([name, e.code, e.message]).toEqual([
        name,
        "CONFLICT",
        "already initialized; use `hermetic init --reset`",
      ]);
    }
  });

  test("two concurrent inits single-flight to exactly one op", async () => {
    const { ctx } = await wizard();
    const params = {
      profile: "acme-dev",
      account_id_typed: "123456789012",
      mode: "create",
      tailnet: "hermetic.ts.net",
      tailscale_oauth_secret: SECRET,
      network: "public",
    };

    const settled = await Promise.allSettled([
      dispatch(ctx, "init", params),
      dispatch(ctx, "init", params),
    ]);
    const accepted = settled.filter((s) => s.status === "fulfilled");
    const refused = settled.filter((s) => s.status === "rejected");
    expect([accepted.length, refused.length]).toEqual([1, 1]);

    const conflict = (refused[0] as PromiseRejectedResult).reason as {
      code: string;
      opId: string | null;
    };
    expect(conflict.code).toBe("CONFLICT");
    // Carried either way, per the spec — `null` until the winner's op actually
    // exists (both requests claim the slot in the same tick, before either has
    // minted a real op id), a real id afterward.
    expect("opId" in conflict).toBe(true);

    expect((accepted[0] as PromiseFulfilledResult<{ op_id: string }>).value.op_id).toBeString();
  });
});

describe("the tailscale secret", () => {
  test("is dropped from anything the head keeps", () => {
    const redacted = redactInitInput({
      profile: "acme-dev",
      account_id_typed: "123456789012",
      tailscale_oauth_secret: SECRET,
      tailnet: "hermetic.ts.net",
    });
    // Core masks the value rather than dropping the key; either way the secret
    // itself is gone, which is the property that matters.
    expect(JSON.stringify(redacted)).not.toContain(SECRET);
    expect(redacted.tailscale_oauth_secret).not.toBe(SECRET);
  });

  test("never appears in the op record or its event stream", async () => {
    const { ctx, ops } = await wizard();
    const { op_id } = (await dispatch(ctx, "init", {
      profile: "acme-dev",
      account_id_typed: "123456789012",
      mode: "create",
      tailnet: "hermetic.ts.net",
      tailscale_oauth_secret: SECRET,
    })) as { op_id: string };
    await ops.wait(op_id);

    // Everything a caller can read back about the op.
    const record = JSON.stringify(await dispatch(ctx, "ops.get", { id: op_id }));
    const listed = JSON.stringify(await dispatch(ctx, "ops.list", {}));
    const stream = JSON.stringify(await drain(ctx, "ops.subscribe", { op_id }));
    for (const text of [record, listed, stream]) {
      expect(text).not.toContain(SECRET);
    }
    // The op record does keep the redacted input, so the UI can show what was
    // asked for — proof the redaction is load-bearing and not decorative.
    expect(record).toContain("hermetic.ts.net");
    expect(record).toContain("(redacted)");
    // The op did run, so this is not vacuous.
    expect(stream).toContain("tailscale OAuth client secret stored in SSM");
  });
});

/**
 * A UI-driven teardown, from the other side: a fleet that already exists gets
 * torn down from a window, and — when `reset_local` was true — the head drops
 * straight back to the same wizard `wizard()` above boots into, without a
 * restart. `openState({ fixture: true })` (no `uninitialized`) opens the
 * *initialized* fixture fleet, the same as `--fixture` would.
 */
describe("teardown, from the dashboard", () => {
  async function initializedFixture() {
    /**
     * Its own home, holding exactly one fleet. Both halves matter: the fixture
     * home records which fleet is default, so a suite that used the operator's
     * would test whichever fleet they last selected — and since a teardown that
     * leaves another fleet frozen now moves the head onto it rather than to the
     * wizard (§4.6), "back to the wizard" is only the right answer for a home
     * with nothing left.
     */
    const home = testHome("wizard-teardown");
    const state = await openState({ fixture: true, home });
    const local = openLocalDb({ home, fixture: true });
    clearConfig(local.db, fixtureConfigFor("staging").fleet_id);
    local.close();
    const ops = new OpRegistry();
    // The fixture fleet ships eleven live agents and one tombstone; teardown
    // refuses while any of them are still alive, same as it would against a
    // real account (§9). Destroying the tombstone again is a no-op.
    for (const agent of await state.hermetic.agents.list()) {
      for await (const _e of state.hermetic.agents.destroy({ name: agent.name, yes: true })) {
        // drain to completion
      }
    }
    // §4.7: mutations name the fleet this head actually opened, which the
    // fixture directory decides — not whichever one `FIXTURE_CONFIG` describes.
    return { state, ops, ctx: contextFor(state, ops), target: state.target };
  }

  test("reset_local: true drops the head back to the wizard, once", async () => {
    const { state, ops, ctx, target } = await initializedFixture();
    expect(state.initialized).toBe(true);
    expect(state.poller).not.toBeNull();

    const { op } = (await dispatch(ctx, "teardown", {
      yes: true,
      reset_local: true,
      confirm_account_id: FIXTURE_CONFIG.account_id,
      target,
    })) as { op: { id: string } };
    expect((await ops.wait(op.id))?.status).toBe("ok");

    // The reset is scheduled off the op's completion, same as `adopt()` is —
    // and the teardown block is released only once it has finished (F5), so
    // both are waited for rather than one being assumed from the other.
    for (let i = 0; i < 50 && (state.initialized || state.teardownOpId !== null); i += 1) {
      await Bun.sleep(10);
    }
    expect(state.initialized).toBe(false);
    expect(state.poller).toBeNull();
    expect(state.teardownOpId).toBeNull();

    const meta = (await dispatch(ctx, "meta.get", {})) as {
      initialized: boolean;
      last_teardown: {
        at: string;
        account_id: string;
        region: string;
        fleet_id: string;
        manual_steps: string[];
      } | null;
    };
    expect(meta.initialized).toBe(false);
    expect(meta.last_teardown).not.toBeNull();
    expect(meta.last_teardown?.account_id).toBe(FIXTURE_CONFIG.account_id);
    expect(meta.last_teardown?.region).toBe(FIXTURE_CONFIG.region);
    expect(meta.last_teardown?.fleet_id).toBe(FIXTURE_CONFIG.fleet_id);
    // The manual Tailscale checklist is in there, alongside whatever the plan
    // said would be kept given the (default) flags this teardown ran with.
    expect(meta.last_teardown?.manual_steps.length).toBeGreaterThan(0);
    expect(meta.last_teardown?.manual_steps.some((w) => w.includes("Tailscale"))).toBe(true);

    // The wizard is open for business again, on the same context.
    expect(await dispatch(ctx, "init.profiles", {})).toMatchObject({ profiles: expect.anything() });
  });

  /**
   * F5: `endTeardown()` used to run before `resetToUninitialized()` resolved,
   * which unblocked every mutation for the duration of the reset — while the
   * instance they would have used was pointed at a foundation that had just
   * been deleted. The block now spans the reset.
   */
  test("the teardown block is held until the reset finishes", async () => {
    const { state, ops, ctx, target } = await initializedFixture();
    const realReset = state.resetToUninitialized.bind(state);
    let resetDone = false;
    state.resetToUninitialized = async (lastTeardown) => {
      await realReset(lastTeardown);
      // Stand in for the openForInit round trip taking a moment on a real box.
      await Bun.sleep(50);
      resetDone = true;
    };

    const { op } = (await dispatch(ctx, "teardown", {
      yes: true,
      reset_local: true,
      confirm_account_id: FIXTURE_CONFIG.account_id,
      target,
    })) as { op: { id: string } };
    expect((await ops.wait(op.id))?.status).toBe("ok");

    // Inside the window: the state has already flipped, the reset has not
    // returned, and the guard is still holding the mutations shut.
    for (let i = 0; i < 50 && state.initialized; i += 1) await Bun.sleep(1);
    expect(state.initialized).toBe(false);
    expect(resetDone).toBe(false);
    expect(state.teardownOpId).not.toBeNull();
    expect((await refusal(dispatch(ctx, "agents.create", { name: "probe", target }))).code).toBe(
      "CONFLICT",
    );

    for (let i = 0; i < 100 && state.teardownOpId !== null; i += 1) await Bun.sleep(10);
    expect(resetDone).toBe(true);
    expect(state.teardownOpId).toBeNull();
  });

  test("reset_local: false leaves the head initialized", async () => {
    const { state, ops, ctx, target } = await initializedFixture();
    const { op } = (await dispatch(ctx, "teardown", {
      yes: true,
      reset_local: false,
      confirm_account_id: FIXTURE_CONFIG.account_id,
      target,
    })) as { op: { id: string } };
    expect((await ops.wait(op.id))?.status).toBe("ok");

    // Give the (would-be) reset callback a turn; there is nothing to observe
    // changing this time.
    await Bun.sleep(20);
    expect(state.initialized).toBe(true);
    expect(state.teardownOpId).toBeNull();

    const meta = (await dispatch(ctx, "meta.get", {})) as {
      initialized: boolean;
      last_teardown: unknown;
    };
    expect(meta.initialized).toBe(true);
    expect(meta.last_teardown).toBeNull();

    // The wizard still refuses: this home is still initialized.
    expect((await refusal(dispatch(ctx, "init.profiles", {}))).code).toBe("CONFLICT");
  });
});
