/**
 * `mobile.*` through `dispatch` (`handlers/mobile.ts`) and the desktop's
 * bridge lifetime (`mobile-host.ts`): the local methods answer like core's,
 * `mobile.settings` starts and stops the hosted bridge, `mobile.serve` follows
 * it with a `status` frame first, and a context with no host refuses
 * `mobile.serve` `UNSUPPORTED`. A fleet switch restarts the bridge on the new
 * fleet, and a revoke closes the phone's socket at once, whichever instance
 * owns the bridge.
 */
import { describe, expect, test } from "bun:test";
import {
  MOBILE_PROTOCOL,
  MOBILE_ROUTES,
  fleetTargetOf,
  hasCode,
  mobileBridgeHost,
  openHermetic,
} from "@hermetic/core";
import type { Hermetic, MobileHello } from "@hermetic/core";
import { createChatOwner } from "../../src/chat-owner.ts";
import type { HandlerContext } from "../../src/handlers/ctx.ts";
import { dispatch } from "../../src/handlers/dispatch.ts";
import { createStreamRegistry, type StreamFrame } from "../../src/handlers/streams.ts";
import { memoryLog } from "../../src/log.ts";
import { createMobileHost, type MobileHost } from "../../src/mobile-host.ts";
import { OpRegistry } from "../../src/ops.ts";
import { AppState, fixedInstance, openState } from "../../src/state.ts";
import { testHome } from "../home.ts";

function stateContext(state: AppState, mobile?: MobileHost): HandlerContext {
  return {
    state,
    hermetic: () => state.hermetic,
    ops: new OpRegistry(),
    poller: () => state.poller,
    chatOwner: createChatOwner({ hermetic: () => state.hermetic }),
    fixture: true,
    opts: { fixture: true },
    streams: createStreamRegistry(),
    ...(mobile !== undefined ? { mobile } : {}),
  };
}

const HEADER = { [MOBILE_PROTOCOL.VERSION_HEADER]: "1", "content-type": "application/json" };

/** Redeem a pair code on a running bridge, as a phone would. */
async function redeem(url: string, code: string): Promise<{ token: string; hello: MobileHello }> {
  const res = await fetch(`${url}${MOBILE_ROUTES.pair}`, {
    method: "POST",
    headers: HEADER,
    body: JSON.stringify({ code, device_name: "FIXTURE phone", platform: "ios" }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { token: string; hello: MobileHello };
}

/** An authenticated socket, and the close code it ends with. */
async function authedSocket(url: string, token: string): Promise<{ closed: Promise<number> }> {
  const ws = new WebSocket(`${url.replace("http", "ws")}${MOBILE_ROUTES.ws}`);
  const closed = new Promise<number>((resolve) => ws.addEventListener("close", (e) => resolve(e.code)));
  const authed = new Promise<void>((resolve) =>
    ws.addEventListener("message", (e) => {
      if (String(e.data).includes("auth.ok")) resolve();
    }),
  );
  ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "auth", token, protocol: 1 })));
  await authed;
  return { closed };
}

/** Resolves to the close code, or `null` if the socket is still open after `ms`. */
function closedWithin(closed: Promise<number>, ms: number): Promise<number | null> {
  return Promise.race([closed, Bun.sleep(ms).then(() => null)]);
}

function contextFor(hermetic: Hermetic, mobile?: MobileHost): HandlerContext {
  const state = new AppState({
    fixture: true,
    home: ":memory:",
    reopen: fixedInstance(hermetic),
    hermetic,
    target: hermetic.target === null ? null : fleetTargetOf(hermetic.target),
    poller: null,
  });
  return {
    state,
    hermetic: () => state.hermetic,
    ops: new OpRegistry(),
    poller: () => null,
    chatOwner: createChatOwner({ hermetic: () => state.hermetic }),
    fixture: true,
    opts: { fixture: true },
    streams: createStreamRegistry(),
    ...(mobile !== undefined ? { mobile } : {}),
  };
}

describe("mobile handlers", () => {
  test("pair, devices, revoke and settings answer like core", async () => {
    const hermetic = await openHermetic({ fixture: true, home: testHome("mobile-handlers-") });
    const ctx = contextFor(hermetic);
    const pair = (await dispatch(ctx, "mobile.pair", { name: "FIXTURE phone" })) as { url: string };
    expect(pair.url.startsWith("hermetic://pair?")).toBe(true);
    expect(await dispatch(ctx, "mobile.devices", {})).toEqual({ devices: [], serving: null });
    expect(await dispatch(ctx, "mobile.revoke", { device_id: "nope" })).toEqual({ revoked: false });
    expect(await dispatch(ctx, "mobile.settings", {})).toEqual({
      enabled: false,
      host: null,
      port: null,
    });
    let refused = false;
    try {
      await dispatch(ctx, "mobile.serve", {}, () => {});
    } catch (e) {
      refused = hasCode(e, "UNSUPPORTED");
    }
    expect(refused).toBe(true);
  });

  test("settings start and stop the hosted bridge; serve follows it", async () => {
    const hermetic = await openHermetic({ fixture: true, home: testHome("mobile-host-") });
    const log = memoryLog();
    // Port 0, so the test never collides with a real bridge on 7877.
    const host = createMobileHost({ hermetic: () => hermetic, log, bind: { port: 0 } });
    const ctx = contextFor(hermetic, host);
    await host.sync();
    expect(host.status()).toBeNull();

    await dispatch(ctx, "mobile.settings", { enabled: true });
    const started = host.status();
    if (started === null) throw new Error("enabling did not start the bridge");
    expect(started.app).toBe("desktop");
    expect(await host.ensureStarted()).toMatchObject({ url: started.url });
    const devices = (await dispatch(ctx, "mobile.devices", {})) as { serving: { url: string } | null };
    expect(devices.serving?.url).toBe(started.url);

    const frames: StreamFrame[] = [];
    const opened = (await dispatch(ctx, "mobile.serve", {}, (f) => {
      frames.push(f);
    })) as { stream_id: string };
    expect(frames[0]?.event).toBe("status");
    expect((frames[0]?.data as { url: string } | undefined)?.url).toBe(started.url);

    // Disabling stops it, and the follower hears a null status.
    await dispatch(ctx, "mobile.settings", { enabled: false });
    expect(host.status()).toBeNull();
    expect(frames.at(-1)).toEqual({ event: "status", data: null });
    expect(await dispatch(ctx, "mobile.unsubscribe", { stream_id: opened.stream_id })).toEqual({
      closed: true,
    });
    expect(log.lines.some((l) => l.includes("bridge listening"))).toBe(true);
    expect(log.lines.some((l) => l.includes("bridge stopped"))).toBe(true);
  });

  test("a fleet switch restarts the hosted bridge on the new fleet", async () => {
    const state = await openState({ fixture: true, home: testHome("mobile-switch-") });
    const host = createMobileHost({ hermetic: () => state.hermetic, bind: { port: 0 } });
    const ctx = stateContext(state, host);
    await dispatch(ctx, "mobile.settings", { enabled: true });
    const main = state.hermetic;
    const before = host.status();
    if (before === null) throw new Error("enabling did not start the bridge");
    expect(mobileBridgeHost(main).active()?.url).toBe(before.url);

    await dispatch(ctx, "fleets.switch", { fleet: "staging" });
    const staging = state.hermetic;
    expect(staging).not.toBe(main);
    const after = host.status();
    if (after === null) throw new Error("the switch left no bridge running");
    // The old instance's bridge is gone; the new one hosts the running bridge.
    expect(mobileBridgeHost(main).active()).toBeNull();
    expect(mobileBridgeHost(staging).active()?.url).toBe(after.url);

    // A phone pairing now is told the new fleet.
    const { code } = (await dispatch(ctx, "mobile.pair", {})) as { code: string };
    const { hello } = await redeem(after.url, code);
    expect(hello.fleet.fleet_id).toBe(staging.target?.fleet_id ?? "");
    expect(hello.fleet.fleet_id).not.toBe(main.target?.fleet_id ?? "");
    await host.stop("test");
  }, 20_000);

  test("revoke closes the phone's socket now, even on a bridge a swap has not caught up with", async () => {
    const home = testHome("mobile-revoke-");
    const first = await openHermetic({ fixture: true, home });
    const second = await openHermetic({ fixture: true, home });
    let current = first;
    const host = createMobileHost({ hermetic: () => current, bind: { port: 0 } });
    const ctx: HandlerContext = { ...contextFor(first, host), hermetic: () => current };
    await dispatch(ctx, "mobile.settings", { enabled: true });
    const status = host.status();
    if (status === null) throw new Error("enabling did not start the bridge");

    // The bridge's own instance revokes: core drops the socket itself.
    const a = (await dispatch(ctx, "mobile.pair", {})) as { code: string };
    const phoneA = await redeem(status.url, a.code);
    const socketA = await authedSocket(status.url, phoneA.token);
    const devices = (await dispatch(ctx, "mobile.devices", {})) as {
      devices: Array<{ device_id: string }>;
    };
    const idA = devices.devices[0]?.device_id ?? "";
    expect(await dispatch(ctx, "mobile.revoke", { device_id: idA })).toEqual({ revoked: true });
    expect(await closedWithin(socketA.closed, 2_000)).toBe(4401);

    // The instance moved but the bridge has not been re-synced: the host drops it.
    const b = (await dispatch(ctx, "mobile.pair", {})) as { code: string };
    const phoneB = await redeem(status.url, b.code);
    const socketB = await authedSocket(status.url, phoneB.token);
    current = second;
    const listed = (await dispatch(ctx, "mobile.devices", {})) as {
      devices: Array<{ device_id: string; name: string }>;
    };
    const idB = listed.devices.find((d) => d.device_id !== idA)?.device_id ?? "";
    expect(await dispatch(ctx, "mobile.revoke", { device_id: idB })).toEqual({ revoked: true });
    expect(await closedWithin(socketB.closed, 2_000)).toBe(4401);
    await host.stop("test");
  }, 20_000);
});
