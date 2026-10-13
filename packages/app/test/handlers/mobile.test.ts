/**
 * `mobile.*` through `dispatch` (`handlers/mobile.ts`) and the desktop's
 * bridge lifetime (`mobile-host.ts`): the local methods answer like core's,
 * `mobile.settings` starts and stops the hosted bridge, `mobile.serve` follows
 * it with a `status` frame first, and a context with no host refuses
 * `mobile.serve` `UNSUPPORTED`.
 */
import { describe, expect, test } from "bun:test";
import { fleetTargetOf, hasCode, openHermetic } from "@hermetic/core";
import type { Hermetic } from "@hermetic/core";
import { createChatOwner } from "../../src/chat-owner.ts";
import type { HandlerContext } from "../../src/handlers/ctx.ts";
import { dispatch } from "../../src/handlers/dispatch.ts";
import { createStreamRegistry, type StreamFrame } from "../../src/handlers/streams.ts";
import { memoryLog } from "../../src/log.ts";
import { createMobileHost, type MobileHost } from "../../src/mobile-host.ts";
import { OpRegistry } from "../../src/ops.ts";
import { AppState, fixedInstance } from "../../src/state.ts";
import { testHome } from "../home.ts";

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
});
