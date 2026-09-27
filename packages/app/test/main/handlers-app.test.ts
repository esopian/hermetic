/**
 * The five native requests, over `dispatch`.
 *
 * Driven through `dispatch` rather than by calling the handlers directly,
 * because the name is half of what is being asserted: the page sends
 * `app.openExternal` over the bridge, and a handler wired under the wrong key
 * is exactly the failure a direct call cannot see.
 *
 * The context is built the way `packages/app/test/handlers/dispatch.test.ts`
 * builds one — fixture backend, real registry, no transport — with a fake
 * `native` bolted on, because the real one is `main/index.ts`'s and needs a
 * devkit. The absent-`native` cases are the HTTP head's behaviour: same object
 * without the field.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { fleetTargetOf, isHermeticError, openHermetic } from "@hermetic/core";
import { createChatOwner, type ChatOwner } from "../../src/chat-owner.ts";
import type { HandlerContext, NativeDeps } from "../../src/handlers/ctx.ts";
import { dispatch } from "../../src/handlers/dispatch.ts";
import { createStreamRegistry } from "../../src/handlers/streams.ts";
import { OpRegistry } from "../../src/ops.ts";
import { AppState, fixedInstance } from "../../src/state.ts";
import { testHome } from "../home.ts";

const owners: ChatOwner[] = [];
afterAll(async () => {
  for (const owner of owners.splice(0)) await owner.stop();
});

/** Everything the fake native was asked to do, in order. */
interface Calls {
  opened: string[];
  checks: number;
  installs: number;
  notified: { title: string; body: string; tag?: string }[];
}

function fakeNative(calls: Calls): NativeDeps {
  return {
    info: () => ({
      version: "9.9.9",
      channel: "canary",
      home: "/tmp/home",
      logPath: "/tmp/home/app.log",
    }),
    openExternal: (url) => {
      calls.opened.push(url);
    },
    checkForUpdate: async () => {
      calls.checks += 1;
    },
    installCli: async () => {
      calls.installs += 1;
      return { path: "/usr/local/bin/hermetic", elevated: true };
    },
    notify: (request) => {
      calls.notified.push(request);
      return { delivered: true, permission: "granted" };
    },
  };
}

/** A context over the fixture backend, with and without a desktop head behind it. */
async function harness(): Promise<{ ctx: HandlerContext; bare: HandlerContext; calls: Calls }> {
  const home = testHome("hermetic-native-");
  const hermetic = await openHermetic({ fixture: true, home });
  const state = new AppState({
    fixture: true,
    home,
    reopen: fixedInstance(hermetic),
    hermetic,
    target: hermetic.target === null ? null : fleetTargetOf(hermetic.target),
    poller: null,
  });
  const chatOwner = createChatOwner({ hermetic: () => state.hermetic });
  owners.push(chatOwner);
  const bare: HandlerContext = {
    state,
    hermetic: () => state.hermetic,
    ops: new OpRegistry(),
    poller: () => state.poller,
    chatOwner,
    fixture: true,
    opts: { fixture: true },
    streams: createStreamRegistry(),
  };
  const calls: Calls = { opened: [], checks: 0, installs: 0, notified: [] };
  return { ctx: { ...bare, native: fakeNative(calls) }, bare, calls };
}

/** The code a `HermeticError` carried, or the whole throw if it was not one. */
async function codeOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (e) {
    if (isHermeticError(e)) return e.code;
    if (e instanceof Error && "code" in e) return String((e as { code: unknown }).code);
    throw e;
  }
  throw new Error("expected a refusal; the call resolved");
}

describe("the native requests, with a desktop head behind them", () => {
  test("app.info reports the build, the channel and where the state lives", async () => {
    const { ctx } = await harness();
    expect(await dispatch(ctx, "app.info", {})).toEqual({
      version: "9.9.9",
      channel: "canary",
      home: "/tmp/home",
      logPath: "/tmp/home/app.log",
    });
  });

  test("app.openExternal hands an http(s) URL to the browser", async () => {
    const { ctx, calls } = await harness();
    await dispatch(ctx, "app.openExternal", { url: "https://example.com/docs" });
    await dispatch(ctx, "app.openExternal", { url: "http://127.0.0.1:7433/" });
    expect(calls.opened).toEqual(["https://example.com/docs", "http://127.0.0.1:7433/"]);
  });

  test("app.checkForUpdate runs one check", async () => {
    const { ctx, calls } = await harness();
    expect(await dispatch(ctx, "app.checkForUpdate", {})).toEqual({ checked: true });
    expect(calls.checks).toBe(1);
  });

  test("app.installCli answers with where the shim landed", async () => {
    const { ctx, calls } = await harness();
    expect(await dispatch(ctx, "app.installCli", {})).toEqual({
      path: "/usr/local/bin/hermetic",
      elevated: true,
    });
    expect(calls.installs).toBe(1);
  });

  test("app.notify carries a headline with no detail", async () => {
    const { ctx, calls } = await harness();
    // A banner that is only a headline is the common case, not a malformed
    // request: refusing it would drop the notification rather than shorten it.
    await dispatch(ctx, "app.notify", { title: "corvid", body: "" });
    expect(calls.notified).toEqual([{ title: "corvid", body: "" }]);
  });

  test("app.notify raises the banner the page asked for", async () => {
    const { ctx, calls } = await harness();
    expect(await dispatch(ctx, "app.notify", { title: "corvid", body: "done", tag: "c" })).toEqual({
      delivered: true,
      permission: "granted",
    });
    // No tag sent means no tag forwarded: an empty one would collapse every
    // banner into one (`main/notify.ts`).
    await dispatch(ctx, "app.notify", { title: "atlas", body: "done" });
    expect(calls.notified).toEqual([
      { title: "corvid", body: "done", tag: "c" },
      { title: "atlas", body: "done" },
    ]);
  });
});

describe("the same five with no desktop head", () => {
  test("are refused UNSUPPORTED rather than answered with nothing", async () => {
    const { bare } = await harness();
    // The HTTP head's context is this one: no window, no updater, no
    // notification centre. A resolved `undefined` here would read to the page
    // as a notification that was delivered and an update that was checked.
    expect(await codeOf(dispatch(bare, "app.info", {}))).toBe("UNSUPPORTED");
    expect(await codeOf(dispatch(bare, "app.openExternal", { url: "https://example.com" }))).toBe(
      "UNSUPPORTED",
    );
    expect(await codeOf(dispatch(bare, "app.checkForUpdate", {}))).toBe("UNSUPPORTED");
    expect(await codeOf(dispatch(bare, "app.installCli", {}))).toBe("UNSUPPORTED");
    expect(await codeOf(dispatch(bare, "app.notify", { title: "a", body: "b" }))).toBe("UNSUPPORTED");
  });

  test("refuse before validating, so a bad request is still 'wrong head'", async () => {
    const { bare } = await harness();
    // Which complaint comes first matters: telling a browser its URL is
    // malformed implies that a good one would have been opened.
    expect(await codeOf(dispatch(bare, "app.openExternal", { url: "" }))).toBe("UNSUPPORTED");
  });
});

describe("a URL the page must not be able to open", () => {
  test("a file:// link is refused", async () => {
    const { ctx, calls } = await harness();
    // The mutation this guards: handing the string straight to the OS opener,
    // which would let a page launch anything with a registered scheme.
    expect(await codeOf(dispatch(ctx, "app.openExternal", { url: "file:///etc/passwd" }))).toBe(
      "VALIDATION",
    );
    expect(await codeOf(dispatch(ctx, "app.openExternal", { url: "javascript:alert(1)" }))).toBe(
      "VALIDATION",
    );
    expect(await codeOf(dispatch(ctx, "app.openExternal", { url: "not a url" }))).toBe("VALIDATION");
    expect(calls.opened).toEqual([]);
  });

  test("a link carrying credentials is refused", async () => {
    const { ctx, calls } = await harness();
    // Well-formed https, and still not one to hand over: the password would
    // land in the operator's browser history (§8.3).
    expect(await codeOf(dispatch(ctx, "app.openExternal", { url: "https://u:pw@example.com/" }))).toBe(
      "VALIDATION",
    );
    expect(await codeOf(dispatch(ctx, "app.openExternal", { url: "https://u@example.com/" }))).toBe(
      "VALIDATION",
    );
    expect(calls.opened).toEqual([]);
  });

  test("an empty url is refused by the schema", async () => {
    const { ctx, calls } = await harness();
    expect(await codeOf(dispatch(ctx, "app.openExternal", { url: "" }))).toBe("VALIDATION");
    expect(await codeOf(dispatch(ctx, "app.openExternal", {}))).toBe("VALIDATION");
    expect(calls.opened).toEqual([]);
  });
});

describe("a notification with no title", () => {
  test("is refused rather than shown as a nameless banner", async () => {
    const { ctx, calls } = await harness();
    // macOS renders a titleless banner as a nameless box from a nameless app,
    // and the operator has nothing to act on. The body is the optional half.
    expect(await codeOf(dispatch(ctx, "app.notify", { title: "", body: "done" }))).toBe("VALIDATION");
    expect(await codeOf(dispatch(ctx, "app.notify", { body: "done" }))).toBe("VALIDATION");
    expect(calls.notified).toEqual([]);
  });
});
