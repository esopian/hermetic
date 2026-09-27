/**
 * The contract both halves of the app read.
 *
 * There is one head and one page, and between them one bridge. This file is
 * what each of them is allowed to say on it: the request names the main
 * process answers, the params each one takes, the messages the main process
 * pushes at the page, and the one message the page pushes back. `rpc/bind.ts`
 * binds the main-process half to it; `packages/ui` reads its response types off
 * it in Phase 5, which is why it is a type declaration rather than a runtime
 * table.
 *
 * The request names are the dotted method names themselves — `agents.create`,
 * `plan.destroy`, `ops.subscribe` — because that is what `dispatch` is keyed
 * on. There is no path, no verb and no status code to invent: the name *is*
 * the method, and `tests/parity.test.ts` already asserts that the set of names
 * `dispatch` knows is exactly `PUBLIC_METHODS` plus the machinery.
 *
 * TODO(evan): re-type against the devkit's `RPCSchema` once Hutch is installed.
 * Electrobun 2.x ships no types through npm, so the
 * shape is declared structurally here; `HermeticRPC` is laid out the way
 * `RPCSchema` lays a contract out — `bun`/`webview`, each with `requests` and
 * `messages` — so the re-type is a parameterisation and not a rewrite.
 */
import type { FleetTarget, PublicMethod, REQUEST_SCHEMAS } from "@hermetic/core";
import { PUBLIC_METHODS } from "@hermetic/core";
import type { z, ZodType } from "zod";
import type * as agents from "../handlers/agents.ts";
import type * as app from "../handlers/app.ts";
import type * as botMode from "../handlers/bot-mode.ts";
import type * as chat from "../handlers/chat.ts";
import type * as fixture from "../handlers/fixture.ts";
import type * as fleet from "../handlers/fleet.ts";
import type * as init from "../handlers/init.ts";
import type * as lifecycle from "../handlers/lifecycle.ts";
import type * as meta from "../handlers/meta.ts";
import type * as ops from "../handlers/ops.ts";
import type * as plans from "../handlers/plans.ts";
import type * as providers from "../handlers/providers.ts";
import type * as secrets from "../handlers/secrets.ts";
import type { StreamFrame, StreamRefRequest } from "../handlers/streams.ts";

/** One entry of `bun.requests`: what the page sends, and what it gets back. */
export interface RpcRequest<Params, Response> {
  params: Params;
  response: Response;
}

/** What a handler resolved with, read off the function rather than guessed. */
type Answer<F> = F extends (...args: never[]) => Promise<infer R> ? R : never;

/** What a schema parses to, for the machinery schemas that are Zod objects. */
type Input<S> = S extends ZodType<infer T> ? T : never;

/**
 * Every public method, with core's own request type plus the fleet envelope.
 *
 * The envelope is optional on every entry because `withTarget` makes it
 * optional on every schema it wraps (`target.ts`): a read does not carry one, a
 * fleet-scoped mutation is refused `FLEET_MISMATCH` by the *guard* rather than
 * by the schema, and an uninitialized head has no fleet to compare against. One
 * mapped type over the whole surface is therefore honest, where marking the
 * mutations and only the mutations would be a second list to keep in step with
 * `handlers/shared.ts`.
 *
 * Responses come off the handlers themselves (`HandlerTables` below), the same
 * way the machinery entries take theirs: a method that changes what it answers
 * changes this contract with it, and the page's own types move with it. Nothing
 * here is transcribed, so there is no second copy of a shape to drift.
 */
export type PublicRequests = {
  [K in PublicMethod]: RpcRequest<
    z.infer<(typeof REQUEST_SCHEMAS)[K]> & { target?: FleetTarget },
    Answer<HandlerTables[K]>
  >;
};

/**
 * Every handler table merged, as types only.
 *
 * `dispatch.ts` performs this same merge at runtime and immediately widens it
 * to `Record<string, Handler>` — the lookup is keyed on a name off the wire, so
 * it has to be. That widening is what used to leave this file nothing to read.
 * Intersecting the tables here instead keeps each key's own function type, and
 * every table is a `satisfies Record<string, Handler>` rather than an
 * annotation precisely so that these survive.
 *
 * A `PublicMethod` with no entry here is a compile error on `PublicRequests`
 * above — which is the same fact `tests/parity.test.ts` asserts at runtime,
 * caught a step earlier.
 */
type HandlerTables = typeof agents.agentHandlers &
  typeof app.appHandlers &
  typeof botMode.botModeHandlers &
  typeof chat.chatHandlers &
  typeof fixture.fixtureHandlers &
  typeof fleet.fleetHandlers &
  typeof init.initHandlers &
  typeof lifecycle.lifecycleHandlers &
  typeof meta.metaHandlers &
  typeof ops.opHandlers &
  typeof plans.planHandlers &
  typeof providers.providerHandlers &
  typeof secrets.secretHandlers;

/** The one shape every close half answers with (`streams.ts`). */
export type StreamClosed = { closed: boolean };

/** What every close half takes: the id its open half returned. */
type StreamRef = Input<typeof StreamRefRequest>;

/**
 * The head's own requests: the op registry, the streams, the fleet switch, the
 * wizard's pre-init helpers, the fixture staging surface and the five native
 * ones the desktop head answers itself.
 *
 * Typed by hand, because there is no core schema to read them off — but not
 * *invented*: params come from the schema the handler validates with, and
 * responses from the handler's own return type, so a handler that changes its
 * answer changes this with it. The open halves and the close halves are the two
 * shapes `streams.ts` fixes, so they are written out rather than inferred.
 */
export type MachineryRequests = {
  "meta.get": RpcRequest<Record<string, never>, Answer<typeof meta.metaGet>>;

  "init.profiles": RpcRequest<Record<string, never>, Answer<typeof init.profiles>>;
  "init.identity": RpcRequest<Input<typeof init.IdentityRequest>, Answer<typeof init.identity>>;
  "init.acl": RpcRequest<Record<string, never>, Answer<typeof init.acl>>;
  "init.tailscale": RpcRequest<Record<string, never>, Answer<typeof init.tailscale>>;
  "init.verifyOauth": RpcRequest<
    Input<typeof init.TailscaleOauthRequest>,
    Answer<typeof init.verifyOauth>
  >;

  "ops.list": RpcRequest<Input<typeof ops.OpsListRequest>, Answer<typeof ops.list>>;
  "ops.get": RpcRequest<Input<typeof ops.OpRefRequest>, Answer<typeof ops.get>>;
  "ops.abort": RpcRequest<Input<typeof ops.OpRefRequest>, Answer<typeof ops.abort>>;
  "ops.subscribe": RpcRequest<Input<typeof ops.OpsSubscribeRequest>, { stream_id: string }>;
  "ops.unsubscribe": RpcRequest<StreamRef, StreamClosed>;

  "fleet.subscribe": RpcRequest<Input<typeof fleet.FleetSubscribeRequest>, { stream_id: string }>;
  "fleet.unsubscribe": RpcRequest<StreamRef, StreamClosed>;
  "fleets.switch": RpcRequest<
    Input<typeof fleet.FleetSwitchRequest>,
    Answer<typeof fleet.fleetsSwitch>
  >;

  /** `chat.send` under the name a socketless transport opens a turn with. */
  "chat.turn": RpcRequest<Input<typeof chat.chatSendSchema>, { stream_id: string }>;
  "chat.turn.abort": RpcRequest<StreamRef, StreamClosed>;
  "chat.subscribe": RpcRequest<Input<typeof chat.ChatSubscribeRequest>, { stream_id: string }>;
  "chat.unsubscribe": RpcRequest<StreamRef, StreamClosed>;
  "chat.observe.resume": RpcRequest<
    Input<typeof chat.chatObserveSchema>,
    Answer<typeof chat.observeResume>
  >;

  "logs.open": RpcRequest<Input<typeof agents.logsSchema>, { stream_id: string }>;
  "logs.close": RpcRequest<StreamRef, StreamClosed>;

  /**
   * Fixture-only staging. Core validates inside the fixture control surface —
   * the schema is the fixture backend's, not this head's — so the params are
   * forwarded whole, which is what the handler does.
   */
  "fixture.chat.inject": RpcRequest<unknown, Answer<typeof fixture.inject>>;
  "fixture.chat.hint": RpcRequest<unknown, Answer<typeof fixture.hint>>;

  /**
   * The native five (`handlers/app.ts`). A head without a window refuses every
   * one `UNSUPPORTED`, but a refusal is an error rather than an answer, so the
   * responses are the desktop head's real ones — read off the handlers like
   * everything else here. `app.info` and `app.notify` forward what `ctx.native`
   * returns, so their shapes come from `NativeDeps` (`handlers/ctx.ts`) and
   * move with it.
   */
  "app.info": RpcRequest<Record<string, never>, Answer<typeof app.info>>;
  "app.openExternal": RpcRequest<
    Input<typeof app.AppOpenExternalRequest>,
    Answer<typeof app.openExternal>
  >;
  "app.checkForUpdate": RpcRequest<Record<string, never>, Answer<typeof app.checkForUpdate>>;
  "app.installCli": RpcRequest<Record<string, never>, Answer<typeof app.installCli>>;
  "app.notify": RpcRequest<Input<typeof app.AppNotifyRequest>, Answer<typeof app.notify>>;
};

/**
 * The machinery names as values, so `bind.ts` can build a table over them and
 * `rpc/bind.test.ts` can assert the set against what `dispatch` knows. `satisfies`
 * ties it to the interface above: a name here with no entry there is a compile
 * error, and the test catches the other direction.
 */
export const MACHINERY_REQUEST_NAMES = [
  "meta.get",
  "init.profiles",
  "init.identity",
  "init.acl",
  "init.tailscale",
  "init.verifyOauth",
  "ops.list",
  "ops.get",
  "ops.abort",
  "ops.subscribe",
  "ops.unsubscribe",
  "fleet.subscribe",
  "fleet.unsubscribe",
  "fleets.switch",
  "chat.turn",
  "chat.turn.abort",
  "chat.subscribe",
  "chat.unsubscribe",
  "chat.observe.resume",
  "logs.open",
  "logs.close",
  "fixture.chat.inject",
  "fixture.chat.hint",
  "app.info",
  "app.openExternal",
  "app.checkForUpdate",
  "app.installCli",
  "app.notify",
] as const satisfies readonly (keyof MachineryRequests)[];

export type BunRequests = PublicRequests & MachineryRequests;
export type RequestName = keyof BunRequests;

/** Every name the bridge answers. The order is the contract's, not the table's. */
export const REQUEST_NAMES: readonly RequestName[] = [...PUBLIC_METHODS, ...MACHINERY_REQUEST_NAMES];

/**
 * Main process → page.
 *
 * Every stream a handler opens pushes its frames through one of these. Which
 * one is `MESSAGE_FOR_REQUEST` below; how a `StreamFrame` becomes a payload is
 * `bind.ts`'s business, and the split between the two styles here is the reason
 * it is not uniform:
 *
 * - `op.event`, `fleet.event` and `chat.event` carry the whole frame, because
 *   what a reader does with one depends on the frame's *name*: a fleet
 *   subscription emits `snapshot`, every `FleetEvent["type"]`, and `dropped`,
 *   which is not a `FleetEvent` at all. The name has to travel with the value.
 * - `chat.frame` and `logs.line` carry the value alone, because a turn frame
 *   and a log line already carry their own discriminator, and the terminal
 *   frame is split out as `done` so a reader can stop without inspecting it.
 *
 * `keepalive` is never sent. It exists to prove a socket alive and there is no
 * socket here (`streams.ts`).
 */
export type WebviewMessages = {
  /** Correlated by the op, not the stream: the page asked about a named op. */
  "op.event": { op_id: string; msg: StreamFrame };
  "fleet.event": { event: StreamFrame };
  "chat.event": { event: StreamFrame };
  /** `frame` and `done` are core's `ChatFrame`s; see `PublicRequests` on why they are not typed. */
  "chat.frame": { stream_id: string; frame?: unknown; done?: unknown };
  /** `line` is core's `LogLine`; `done` is the tail's `{ ok }`. */
  "logs.line": { stream_id: string; line?: unknown; done?: unknown };
  /** The updater's state, for the footer. */
  "app.update": { status: string; version?: string };
  /**
   * Whether the operator is looking at this window.
   *
   * The page cannot work this out for itself: the webview reports
   * `document.visibilityState === "hidden"` for the life of the window and
   * never fires `visibilitychange`, so every read the UI gates on visibility
   * (the swarms refresh, the listening poll, the transcript tick) would
   * silently never run. `main/windows.ts` pushes the window's own `focus` and
   * `blur` instead, and `lib/visibility.ts` in the page prefers this answer
   * over the `document`'s.
   */
  "app.visibility": { visible: boolean };
};

export type WebviewMessageName = keyof WebviewMessages;

/**
 * Page → main process. One message: the page has mounted and is ready to be
 * pushed at, which is what a head with no socket has instead of a connection.
 */
export type BunMessages = {
  "page.ready": Record<string, never>;
};

/**
 * The contract as the devkit's `ElectrobunRPCSchema` wants it: both sides carry
 * a `requests` table and a `messages` table, and every table is an object type
 * rather than an interface — an interface gets no implicit index signature, so
 * an interface here is not assignable to the devkit's `Record<string, …>` bound
 * and every generic it is passed to collapses to the base schema.
 *
 * `webview.requests` is empty and stays empty. The page answers nothing: it
 * asks and it listens (`WebviewMessages`), which is the whole shape of a head
 * with one window.
 */
export type HermeticRPC = {
  bun: { requests: BunRequests; messages: BunMessages };
  webview: { requests: Record<string, never>; messages: WebviewMessages };
};

/**
 * Which message a streaming request's frames arrive on.
 *
 * `bind.ts` reads it to decide what to do with a sink frame, and a name that is
 * not a key here is a plain request that answers once. Both halves of every
 * stream are here — `chat.send` and `chat.turn` are the same turn over two
 * names, `logs` and `logs.open` the same tail — because the *name the caller
 * used* is what `bind.ts` has in hand.
 */
export const MESSAGE_FOR_REQUEST = {
  "ops.subscribe": "op.event",
  "fleet.subscribe": "fleet.event",
  "chat.subscribe": "chat.event",
  "chat.observe": "chat.event",
  "chat.turn": "chat.frame",
  "chat.send": "chat.frame",
  logs: "logs.line",
  "logs.open": "logs.line",
} as const satisfies Record<string, WebviewMessageName>;

export type StreamingRequestName = keyof typeof MESSAGE_FOR_REQUEST;
export type StreamMessageName = (typeof MESSAGE_FOR_REQUEST)[StreamingRequestName];
