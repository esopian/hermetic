/**
 * `mobile.*`: the phone companion's bridge, from the desktop page.
 *
 * `pair`, `devices`, `revoke` and `settings` are local reads and writes of
 * this laptop's database, so like `presets.*` they take no fleet envelope.
 * `settings` also moves the bridge: a change to `enabled`, `host` or `port`
 * re-syncs the `MobileHost` before answering, so the page's next `devices`
 * already shows it serving or not.
 *
 * `mobile.serve` follows the bridge this process hosts — a `status` frame and
 * every bridge event — and starts it if it is not running. It never starts a
 * second one; the desktop serves per `mobile.settings`, so its host and port
 * come from there. A context with no host refuses `UNSUPPORTED`, like the
 * terminals.
 */
import {
  HermeticError,
  MobileDevicesInput,
  MobilePairInput,
  MobileRevokeInput,
  MobileServeInput,
  MobileSettingsInput,
} from "@hermetic/core";
import { declareMachineryRpc, declareRpc } from "../declare.ts";
import type { MobileHost } from "../mobile-host.ts";
import { parseInput } from "../validation.ts";
import type { HandlerContext } from "./ctx.ts";
import type { Handler } from "./dispatch.ts";
import { type StreamSink, StreamRefRequest, requireSink } from "./streams.ts";

export const mobilePairSchema = declareRpc("mobile.pair", MobilePairInput);
export const mobileDevicesSchema = declareRpc("mobile.devices", MobileDevicesInput);
export const mobileRevokeSchema = declareRpc("mobile.revoke", MobileRevokeInput);
export const mobileSettingsSchema = declareRpc("mobile.settings", MobileSettingsInput);
export const mobileServeSchema = declareRpc("mobile.serve", MobileServeInput);

export const MOBILE_UNSUBSCRIBE = declareMachineryRpc("mobile.unsubscribe");

function requireHost(ctx: HandlerContext): MobileHost {
  if (ctx.mobile === undefined) {
    throw new HermeticError("UNSUPPORTED", "this head does not host the mobile bridge");
  }
  return ctx.mobile;
}

export async function mobilePair(ctx: HandlerContext, params: unknown) {
  return await ctx.hermetic().mobile.pair(parseInput(mobilePairSchema, params ?? {}));
}

export async function mobileDevices(ctx: HandlerContext, params: unknown) {
  return await ctx.hermetic().mobile.devices(parseInput(mobileDevicesSchema, params ?? {}));
}

export async function mobileRevoke(ctx: HandlerContext, params: unknown) {
  return await ctx.hermetic().mobile.revoke(parseInput(mobileRevokeSchema, params));
}

export async function mobileSettings(ctx: HandlerContext, params: unknown) {
  const input = parseInput(mobileSettingsSchema, params ?? {});
  const before = await ctx.hermetic().mobile.settings({});
  const after = await ctx.hermetic().mobile.settings(input);
  const moved = before.host !== after.host || before.port !== after.port;
  if (ctx.mobile !== undefined) {
    // A new address needs a new listener; `sync` alone would keep the old one.
    if (moved) await ctx.mobile.stop("settings changed");
    await ctx.mobile.sync();
  }
  return after;
}

/**
 * Frames are `{event, data}`: `status` (a `MobileServeStatus`, or null once
 * stopped), then `paired`, `device` and `stopped` as the bridge reports them.
 */
export async function mobileServe(
  ctx: HandlerContext,
  params: unknown,
  sink?: StreamSink,
): Promise<{ stream_id: string }> {
  const out = requireSink(sink);
  parseInput(mobileServeSchema, params ?? {});
  const host = requireHost(ctx);
  await host.ensureStarted();
  const handle = host.follow(out);
  const stream_id = ctx.streams.open(handle);
  void handle.done.then(() => {
    ctx.streams.close(stream_id);
  });
  return { stream_id };
}

export async function mobileUnsubscribe(
  ctx: HandlerContext,
  params: unknown,
): Promise<{ closed: boolean }> {
  const { stream_id } = parseInput(StreamRefRequest, params);
  return { closed: ctx.streams.close(stream_id) };
}

/** This module's contribution to the dispatch table (`dispatch.ts`). */
export const mobileHandlers = {
  "mobile.pair": mobilePair,
  "mobile.devices": mobileDevices,
  "mobile.revoke": mobileRevoke,
  "mobile.settings": mobileSettings,
  "mobile.serve": mobileServe,
  [MOBILE_UNSUBSCRIBE]: mobileUnsubscribe,
} satisfies Record<string, Handler>;
