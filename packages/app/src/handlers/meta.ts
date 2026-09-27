/**
 * `meta.get`'s body, and the laptop-local reads beside it — `runs.list`,
 * `teardowns.list` and the notification inbox (§4.9).
 *
 * Everything here answers in both head states, because it is what the UI boots
 * from and what the wizard shows after a teardown.
 *
 * There is no liveness request: the Hono head had one, and it asserted nothing
 * but "a head that can answer at all is answering" — which a bridge that
 * answers any request at all has already said. `meta.get` is machinery rather
 * than a core method for the same reason `fleets.switch` is — it describes
 * *this head*, not the account — so it is registered with
 * `declareMachineryRpc`.
 */
import {
  NotificationsAckInput,
  NotificationsListInput,
  NotificationsMuteInput,
  PresetsGetInput,
  PresetsSetInput,
  RunsListInput,
  TeardownsListInput,
} from "@hermetic/core";
import { BUILD_VERSIONS, headerLine as coreHeaderLine } from "@hermetic/core";
import type { LocalConfig } from "@hermetic/core";
import { declareMachineryRpc, declareRpc } from "../declare.ts";
import { uninitializedHeader } from "../init-op.ts";
import { requireTarget, withTarget } from "../target.ts";
import { parseInput } from "../validation.ts";
import type { HandlerContext } from "./ctx.ts";
import type { Handler } from "./dispatch.ts";

export const runsListSchema = declareRpc("runs.list", RunsListInput);
export const teardownsListSchema = declareRpc("teardowns.list", TeardownsListInput);
/**
 * §4.9: the operator's inbox. Three methods over the laptop's own
 * SQLite — no AWS, no fleet guard — so the centre still draws when the fleet
 * this portal is pointed at cannot be reached.
 */
export const notificationsListSchema = declareRpc("notifications.list", NotificationsListInput);
export const notificationsAckSchema = declareRpc("notifications.ack", NotificationsAckInput);
export const notificationsMuteSchema = declareRpc("notifications.mute", NotificationsMuteInput);
/**
 * §4.6's create presets: one `prefs` row on this laptop. No fleet envelope —
 * a preset is not about any fleet, and the same loadout is offered whichever
 * fleet this window is on.
 */
export const presetsGetSchema = declareRpc("presets.get", PresetsGetInput);
export const presetsSetSchema = declareRpc("presets.set", PresetsSetInput);

/**
 * The inbox writes take the same envelope as every other fleet-scoped
 * mutation (`handlers/shared.ts`): a mute is a row in this laptop's inbox keyed
 * on the fleet it was raised for.
 */
export const notificationsAckBody = withTarget(notificationsAckSchema);
export const notificationsMuteBody = withTarget(notificationsMuteSchema);

/** The name `/api/meta` answers under, for a transport that has no paths. */
export const META_GET = declareMachineryRpc("meta.get");

/**
 * The §4.7 header line the UI pins to its header bar. Core owns the format; this
 * is a thin alias so the caller reads plainly.
 */
export function headerLine(config: LocalConfig, fixture: boolean): string {
  return coreHeaderLine(config, { fixture });
}

/**
 * What `/api/meta` answers, as a value rather than a response, because the
 * fleet switch answers with it too (a browser that has just moved the server
 * needs every one of these fields again, and a second round trip to fetch
 * them would be a second round trip that could disagree with the first).
 */
export function createMetaBody({ state, hermetic, fixture, opts }: HandlerContext) {
  return async () => {
    const versions = {
      hermeticd_version: opts.hermeticdVersion ?? BUILD_VERSIONS.hermeticd,
      hermes_version: opts.hermesVersion ?? BUILD_VERSIONS.hermes,
    };
    /**
     * §4.8: which fleet this server is serving, which one this laptop means by
     * default, and where the directory lives. `fleets.list` is the source for
     * all three rather than `config.show().default`, which is a boolean about
     * *this* fleet and so cannot name a default that is some other fleet —
     * which is exactly the state `PUT /api/fleets/default` leaves the server in
     * until the operator switches.
     *
     * Read through `state.fleetsSummary()`, which caches for `FLEETS_CACHE_MS`
     * and is dropped by every write that could change it: `/api/meta` is polled
     * and a directory Scan per call is not what a header line is worth.
     * `GET /api/fleets` — the list an operator actually asked for — bypasses it.
     */
    const listed = await state.fleetsSummary();
    /**
     * §4.6: `id` is identity and `alias` is the optional label over it, so both
     * travel and the browser decides what to show (`alias ?? id`). `default` is
     * a `fleet_id` for the same reason `prefs.default_fleet` is: an alias may
     * move between two polls of this endpoint, and an id may not.
     */
    const fleet = {
      id: state.fleetId,
      alias: listed?.fleets.find((f) => f.fleet_id === state.fleetId)?.name ?? null,
      default: listed?.fleets.find((f) => f.default)?.fleet_id ?? null,
      directory_region: listed?.directory_region ?? null,
    };
    // Before `init` there is no config to describe and no account to name, so
    // the header says so rather than inventing one. The UI reads
    // `initialized` to decide between the wizard and the dashboard.
    if (!state.initialized) {
      const session = state.session;
      return {
        initialized: false as const,
        home: state.home,
        header: uninitializedHeader(state.home, fixture),
        config: null,
        fleet,
        /**
         * §4.8: set when this home *has* fleets and none is selected — a
         * `teardown --reset-local` that took the default away, or a stale
         * `HERMETIC_FLEET`. The UI shows the switcher rather than the wizard
         * when this is set, because there is nothing here to initialize.
         */
        fleet_error: state.fleetError,
        fixture,
        tailnet: null,
        // Credential env vars the wizard warns about (§4.7), and the path an
        // unreadable `hermetic.db` was renamed aside to, if either applies —
        // both already lived on the init session but were never surfaced.
        env_overrides: session?.envOverrides ? [...session.envOverrides] : [],
        corrupted_to: session?.corruptedTo ?? null,
        // Set when a finished `init` op could not be adopted (see
        // `AppState.adopt`); the UI should show this rather than the
        // wizard, since re-running `init` here would target a fleet that
        // already exists.
        adopt_error: state.adoptError,
        // Set once by a teardown that reset this server to uninitialized; the
        // wizard shows it once and it is cleared the next time `init` adopts
        // (`AppState.adopt`).
        last_teardown: state.lastTeardown,
        // Nothing to compare against before a fleet exists.
        foundation: null,
        ...versions,
      };
    }
    const config = await hermetic().config.show();
    /**
     * §6.6: the dashboard's copy of `foundation status`, so the EnvStrip pill
     * and the Settings section have it without a second round trip. `null` on
     * any failure — an unreadable `_fleet` is already reported by every other
     * route, and `/api/meta` is what the whole UI boots from.
     */
    const foundation = await hermetic()
      .foundation.status()
      .catch(() => null);
    /**
     * §4.6: the fleet's shared settings, so the Settings view and the create
     * drawer paint the fleet's own defaults on the first render instead of
     * `—` followed by a correction. `null` on any failure, for the same
     * reason `foundation` is: `/api/meta` is what the whole UI boots from,
     * and an unreadable `_fleet` must not be the thing that stops it.
     */
    const settings = await hermetic()
      .settings.get()
      .catch(() => null);
    return {
      initialized: true as const,
      home: state.home,
      header: headerLine(config, fixture),
      config,
      // `state.fleetId` is set by whatever installed this instance; `config` is
      // the instance itself answering, so the two cannot disagree — and the
      // second is the one that is true even for an app built around a bare
      // `Hermetic`, which never went through `adopt()` or `switchFleet()`.
      fleet: { ...fleet, id: state.fleetId ?? config.fleet_id, alias: fleet.alias ?? config.name },
      // Always null here: a server with an instance has a fleet selected.
      fleet_error: state.fleetError,
      foundation,
      settings,
      fixture,
      // Lifted out of `config` so the UI's header bar can read it without
      // knowing the shape of the frozen config. Core resolves it from
      // `_fleet.tailnet`; it is null until a fleet records one.
      tailnet: config.tailnet ?? null,
      last_teardown: state.lastTeardown,
      ...versions,
    };
  };
}

export type MetaBody = ReturnType<typeof createMetaBody>;

/** `meta.get`: the body above, for a caller that named it rather than a path. */
export async function metaGet(ctx: HandlerContext) {
  return await createMetaBody(ctx)();
}

export async function runsList(ctx: HandlerContext, params: unknown) {
  return await ctx.hermetic().runs.list(parseInput(runsListSchema, params));
}

/**
 * §4.6: readable in *both* server states. The receipt of the teardown that
 * just returned this home to uninitialized is the one thing the wizard has to
 * be able to show, and by then `state.hermetic` is the pre-init instance —
 * which reads the same local table, because `teardowns.list` takes no fleet
 * guard: it is most useful precisely when there is no fleet.
 */
export async function teardownsList(ctx: HandlerContext, params: unknown) {
  return await ctx.hermetic().teardowns.list(parseInput(teardownsListSchema, params));
}

/**
 * §4.9. Read-only and local, so it takes neither the teardown guard nor
 * the update guard: an inbox is most worth reading while something is going
 * wrong with the thing those guards protect.
 */
export async function notificationsList(ctx: HandlerContext, params: unknown) {
  return await ctx.hermetic().notifications.list(parseInput(notificationsListSchema, params));
}

/**
 * Both writes touch nothing but this laptop's own rows, so neither is blocked
 * by a teardown or a foundation update in flight — no `requireWritable` here. A
 * `409` on "mark read" while the fleet is being torn down would be the portal
 * refusing to let an operator clear the notifications the teardown is
 * generating.
 */
export async function notificationsAck(ctx: HandlerContext, params: unknown) {
  const { hermetic: h, input } = requireTarget(ctx.state, parseInput(notificationsAckBody, params));
  return await h.notifications.ack(input);
}

export async function notificationsMute(ctx: HandlerContext, params: unknown) {
  const { hermetic: h, input } = requireTarget(ctx.state, parseInput(notificationsMuteBody, params));
  return await h.notifications.mute(input);
}

/**
 * Both local and fleet-free, so neither takes a target nor the teardown and
 * update guards: a loadout is this laptop's, and rearranging it while a
 * foundation update runs changes nothing that update is about.
 */
export async function presetsGet(ctx: HandlerContext, params: unknown) {
  return await ctx.hermetic().presets.get(parseInput(presetsGetSchema, params ?? {}));
}

export async function presetsSet(ctx: HandlerContext, params: unknown) {
  return await ctx.hermetic().presets.set(parseInput(presetsSetSchema, params));
}

/** This module's contribution to the dispatch table (`dispatch.ts`). */
export const metaHandlers = {
  [META_GET]: metaGet,
  "runs.list": runsList,
  "teardowns.list": teardownsList,
  "notifications.list": notificationsList,
  "notifications.ack": notificationsAck,
  "notifications.mute": notificationsMute,
  "presets.get": presetsGet,
  "presets.set": presetsSet,
} satisfies Record<string, Handler>;
