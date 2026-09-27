/**
 * The fleet as a whole: §4.8's fleet management, the fleet-level reads and
 * settings, and the poller fan-out every dashboard watches.
 *
 * Every function here takes the same two things — a `HandlerContext` and the
 * caller's raw params — and nothing in it knows what a status code is: a
 * refusal is a thrown `HermeticError`. The schemas are declared
 * here, so the method and the schema the parity contract compares cannot drift
 * apart (`declare.ts`).
 *
 * Two names here wrap no core method and so are machinery: the fleet switch,
 * which repoints *this head* rather than changing the account, and the
 * subscribe/unsubscribe pair the fleet stream is made of.
 */
import {
  ConfigShowInput,
  DirectoryStatusInput,
  DoctorInput,
  FleetsAliasInput,
  FleetsListInput,
  FleetsUseInput,
  NetworkStatusInput,
  PolicyStatusInput,
  SettingsGetInput,
  SettingsSetInput,
} from "@hermetic/core";
import { HermeticError } from "@hermetic/core";
import { z } from "zod";
import { declareMachineryRpc, declareRpc } from "../declare.ts";
import { FOLLOW_KEEPALIVE_MS } from "../ops.ts";
import type { FleetEvent } from "../poller.ts";
import { requireTarget, withTarget } from "../target.ts";
import { parseInput } from "../validation.ts";
import type { HandlerContext } from "./ctx.ts";
import type { Handler } from "./dispatch.ts";
import { createMetaBody } from "./meta.ts";
import { requireWritable } from "./shared.ts";
import { KEEPALIVE_EVENT, StreamRefRequest, requireSink } from "./streams.ts";
import type { StreamSink } from "./streams.ts";

export const configShowSchema = declareRpc("config.show", ConfigShowInput);
/**
 * §4.6's shared settings. The write is a patch: a caller states the fields it
 * wants changed, over a version it names, and everything it did not mention
 * stays.
 */
export const settingsGetSchema = declareRpc("settings.get", SettingsGetInput);
export const settingsSetSchema = declareRpc("settings.set", SettingsSetInput);
export const doctorSchema = declareRpc("doctor", DoctorInput);
export const policyStatusSchema = declareRpc("policy.status", PolicyStatusInput);
/** §5's read: which side of a NAT this fleet's agents live on. */
export const networkStatusSchema = declareRpc("network.status", NetworkStatusInput);
/** §4.8's three. */
export const fleetsListSchema = declareRpc("fleets.list", FleetsListInput);
export const fleetsUseSchema = declareRpc("fleets.use", FleetsUseInput);
export const fleetsAliasSchema = declareRpc("fleets.alias", FleetsAliasInput);
export const directoryStatusSchema = declareRpc("directory.status", DirectoryStatusInput);

export const FLEET_SUBSCRIBE = declareMachineryRpc("fleet.subscribe");
export const FLEET_UNSUBSCRIBE = declareMachineryRpc("fleet.unsubscribe");
export const FLEETS_SWITCH = declareMachineryRpc("fleets.switch");

// §4.7 mutation bodies — see `handlers/shared.ts` and `target.ts`.
export const settingsSetBody = withTarget(settingsSetSchema);

/**
 * The app's own fleet switch. Machinery, not a core method: it repoints
 * *this process* at another fleet frozen in the same home
 * (`AppState.switchFleet`), which is a fact about the app and not about
 * the account — the CLI's equivalent is `--fleet`, which needs no round trip
 * at all.
 */
export const FleetSwitchRequest = z.object({ fleet: z.string().min(1) });

/** A subscription to the poller takes nothing; the fleet is whichever one this server is on. */
export const FleetSubscribeRequest = z.object({});

export const NO_POLLER = "this app was built without a fleet poller";

/**
 * §4.8: which fleets this account has, and which one this laptop means by
 * default.
 *
 * Answers in both server states. A laptop that has never run `init` still has
 * an honest answer ("nothing frozen here, and no directory to ask"), and core
 * gives it: `fleets.list` reports a directory it cannot reach through
 * `directory_error` rather than throwing, so no `NOT_INITIALIZED` catch is
 * needed here.
 */
export async function fleetsList(ctx: HandlerContext, params: unknown) {
  parseInput(fleetsListSchema, params ?? {});
  // Deliberately not `state.fleetsSummary()`: a list an operator asked for is
  // one they want to be true now. The answer warms the cache `/api/meta`
  // reads, so asking twice costs one directory read rather than two.
  const listed = await ctx.hermetic().fleets.list();
  ctx.state.cacheFleets(listed);
  return listed;
}

/**
 * Local only: it records which fleet a bare command on this laptop means, and
 * writes nothing to AWS. Guarded anyway, for the reason the settings patch is
 * — a teardown or a foundation update is mid-sentence about the fleet whose
 * name is being written, and a write that lands in the middle of one is a
 * write whose meaning depends on which side of it the operator looks from.
 */
export async function fleetsUse(ctx: HandlerContext, params: unknown) {
  requireWritable(ctx.state);
  const used = await ctx.hermetic().fleets.use(parseInput(fleetsUseSchema, params));
  // `default` moved, so whatever `meta.get` last cached is now wrong.
  ctx.state.invalidateFleets();
  return used;
}

export async function fleetsAlias(ctx: HandlerContext, params: unknown) {
  requireWritable(ctx.state);
  const changed = await ctx.hermetic().fleets.alias(parseInput(fleetsAliasSchema, params));
  ctx.state.invalidateFleets();
  return changed;
}

/**
 * The portal's own fleet switch (machinery — see `FleetSwitchRequest`). It
 * answers with the same `/api/meta` body the UI boots from, taken *after* the
 * switch, so one round trip both moves the server and tells the browser
 * everything that moved with it.
 *
 * Refused while anything is running: `AppState.switchFleet` owns that
 * decision, and the ops registry's half of the question is supplied here
 * because the registry belongs to the app rather than to the state.
 */
export async function fleetsSwitch(ctx: HandlerContext, params: unknown) {
  const { state, ops, chatOwner, opts } = ctx;
  const { fleet } = parseInput(FleetSwitchRequest, params);
  const previous = state.fleetId;
  await state.switchFleet(fleet, {
    opsRunning: ops.list({ status: "running", limit: 1 }).ops.length > 0,
  });
  opts.log?.line("info", "portal", `switch fleet ${previous ?? "(none)"} -> ${fleet}`);
  /**
   * The observations belonged to the fleet this server has just left — their
   * next authoritative read would be refused by core's own fleet guard.
   * Dropped here, and re-established from the new fleet's listen preferences,
   * which are per-fleet too (`instance-listening.ts`).
   */
  await chatOwner.reset();
  void chatOwner.sync();
  // The id the switch landed on, which is not necessarily what was asked for:
  // the request may name a display alias, and the resolver answers with the
  // fleet's own id.
  return { fleet_id: state.fleetId, meta: await createMetaBody(ctx)() };
}

export async function settingsGet(ctx: HandlerContext, params: unknown) {
  return await ctx.hermetic().settings.get(parseInput(settingsGetSchema, params));
}

export async function settingsSet(ctx: HandlerContext, params: unknown) {
  // A `foundation update` rewrites `_fleet` wholesale and a teardown is
  // deleting the table this lives in; either racing a settings write is a
  // write that silently loses (§6.6).
  requireWritable(ctx.state);
  const { hermetic: h, input } = requireTarget(ctx.state, parseInput(settingsSetBody, params));
  return await h.settings.set(input);
}

export async function configShow(ctx: HandlerContext, params: unknown) {
  parseInput(configShowSchema, params ?? {});
  return await ctx.hermetic().config.show();
}

export async function doctor(ctx: HandlerContext, params: unknown) {
  parseInput(doctorSchema, params ?? {});
  return await ctx.hermetic().doctor();
}

/**
 * §4.8: the account-global fleet directory table itself — where it is, how it
 * is billed, how far back it can be recovered, and every fleet in it. A read
 * of a real DynamoDB table, so unlike `fleets.list` it refuses before `init`
 * like every other AWS read.
 */
export async function directoryStatus(ctx: HandlerContext, params: unknown) {
  parseInput(directoryStatusSchema, params ?? {});
  return await ctx.hermetic().directory.status();
}

/**
 * §4.7: hermetic's own entries in the tailnet policy file. A read — the write
 * is `apply` with the plan `plan.policy` produced, like every other
 * destructive change.
 */
export async function policyStatus(ctx: HandlerContext, params: unknown) {
  parseInput(policyStatusSchema, params ?? {});
  return await ctx.hermetic().policy.status();
}

/** §5, and a read for the same reason: the change is `apply` with `plan.network`'s plan. */
export async function networkStatus(ctx: HandlerContext, params: unknown) {
  parseInput(networkStatusSchema, params ?? {});
  return await ctx.hermetic().network.status();
}

/**
 * A client that stops reading must not grow the fan-out without bound; the
 * oldest events go and the gap is announced, the same contract the op buffer
 * has.
 */
const MAX_QUEUED = 1000;

/**
 * Everything the poller sees, snapshot first.
 *
 * The snapshot is taken *after* the listener is attached, so nothing emitted
 * between the two is lost. What follows is the queue drained in order, with a
 * `dropped` frame whenever the reader fell far enough behind to lose events,
 * and a keepalive whenever the poller goes quiet — a paused poller must not
 * let a socket idle out and force a reconnect and a re-snapshot.
 */
export async function fleetSubscribe(
  ctx: HandlerContext,
  params: unknown,
  sink: StreamSink,
): Promise<{ stream_id: string }> {
  parseInput(FleetSubscribeRequest, params ?? {});
  const poller = ctx.poller();
  if (poller === null) throw new HermeticError("UNSUPPORTED", NO_POLLER);
  const queue: FleetEvent[] = [];
  let dropped = 0;
  let wake: (() => void) | null = null;
  let open = true;
  const unsubscribe = poller.subscribe((event) => {
    queue.push(event);
    while (queue.length > MAX_QUEUED) {
      queue.shift();
      dropped += 1;
    }
    wake?.();
  });
  const stop = () => {
    open = false;
    wake?.();
  };
  const done = (async () => {
    // In a `finally`, the way `chat-stream.ts` does it: a close is not the only
    // way out of the loop below, and a sink that throws on a socket the runtime
    // never told us about used to leave this listener attached to the poller
    // for the life of the process.
    try {
      await sink({ event: "snapshot", data: poller.snapshot() });
      while (open) {
        if (queue.length === 0) {
          let timer: ReturnType<typeof setTimeout> | null = null;
          const quiet = await new Promise<boolean>((resolve) => {
            wake = () => resolve(false);
            timer = setTimeout(() => resolve(true), FOLLOW_KEEPALIVE_MS);
          });
          wake = null;
          if (timer !== null) clearTimeout(timer);
          if (quiet && open) await sink({ event: KEEPALIVE_EVENT, data: null });
          continue;
        }
        if (dropped > 0) {
          const gap = dropped;
          dropped = 0;
          await sink({ event: "dropped", data: { count: gap } });
        }
        const event = queue.shift();
        if (event === undefined) continue;
        await sink({ event: event.type, data: event });
      }
    } catch {
      // `done` never rejects (`streams.ts`).
    } finally {
      unsubscribe();
    }
  })();
  const stream_id = ctx.streams.open({ close: stop, done });
  void done.then(() => {
    ctx.streams.close(stream_id);
  });
  return { stream_id };
}

export async function fleetUnsubscribe(
  ctx: HandlerContext,
  params: unknown,
): Promise<{ closed: boolean }> {
  const { stream_id } = parseInput(StreamRefRequest, params);
  return { closed: ctx.streams.close(stream_id) };
}

/** This module's contribution to the dispatch table (`dispatch.ts`). */
export const fleetHandlers = {
  "config.show": configShow,
  "settings.get": settingsGet,
  "settings.set": settingsSet,
  doctor,
  "policy.status": policyStatus,
  "network.status": networkStatus,
  "fleets.list": fleetsList,
  "fleets.use": fleetsUse,
  "fleets.alias": fleetsAlias,
  "directory.status": directoryStatus,
  [FLEETS_SWITCH]: fleetsSwitch,
  [FLEET_SUBSCRIBE]: (ctx: HandlerContext, params: unknown, sink?: StreamSink) =>
    fleetSubscribe(ctx, params, requireSink(sink)),
  [FLEET_UNSUBSCRIBE]: fleetUnsubscribe,
} satisfies Record<string, Handler>;
