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
import type {
  DevtoolsClearInput,
  DevtoolsExportInput,
  DevtoolsSettingsInput,
  DevtoolsTapInput,
  FilesCapabilityInput,
  FilesSecretTextUploadInput,
  FilesUploadRefInput,
  FilesUploadOpenInput,
  FilesContentInput,
  FilesGetFrame,
  FilesPutFrame,
  FilesRequestRefInput,
  FilesStageFrame,
  FleetTarget,
  PublicMethod,
  REQUEST_SCHEMAS,
  TapRecord,
} from "@hermetic/core";
import { PUBLIC_METHODS } from "@hermetic/core";
import type { z, ZodType } from "zod";
import type * as agents from "../handlers/agents.ts";
import type * as app from "../handlers/app.ts";
import type * as botMode from "../handlers/bot-mode.ts";
import type * as chat from "../handlers/chat.ts";
import type * as devtools from "../handlers/devtools.ts";
import type * as files from "../handlers/files.ts";
import type * as fixture from "../handlers/fixture.ts";
import type * as fleet from "../handlers/fleet.ts";
import type * as init from "../handlers/init.ts";
import type * as lifecycle from "../handlers/lifecycle.ts";
import type * as meta from "../handlers/meta.ts";
import type * as mobile from "../handlers/mobile.ts";
import type * as ops from "../handlers/ops.ts";
import type * as plans from "../handlers/plans.ts";
import type * as providers from "../handlers/providers.ts";
import type * as secrets from "../handlers/secrets.ts";
import type { StreamFrame, StreamRefRequest } from "../handlers/streams.ts";
import type * as terminal from "../handlers/terminal.ts";
import type { TerminalFrame } from "../terminal/channel.ts";

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
  typeof devtools.devtoolsHandlers &
  typeof files.filesHandlers &
  typeof fixture.fixtureHandlers &
  typeof fleet.fleetHandlers &
  typeof init.initHandlers &
  typeof lifecycle.lifecycleHandlers &
  typeof meta.metaHandlers &
  typeof mobile.mobileHandlers &
  typeof ops.opHandlers &
  typeof plans.planHandlers &
  typeof providers.providerHandlers &
  typeof secrets.secretHandlers &
  typeof terminal.terminalHandlers;

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
  "chat.turn": RpcRequest<Input<typeof chat.chatSendBody>, { stream_id: string }>;
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
   * The composer's attachments. `files.stage` is public; these
   * are its cancel, the webview's bounded text-secret upload into main-process memory, the
   * capability probe, a staged entry's delete, its thumbnail bytes and the
   * native open dialog.
   */
  "files.stage.abort": RpcRequest<StreamRef, StreamClosed>;
  "files.upload.open": RpcRequest<Input<typeof FilesUploadOpenInput>, Answer<typeof files.uploadOpen>>;
  "files.secretText.upload": RpcRequest<
    Input<typeof FilesSecretTextUploadInput>,
    Answer<typeof files.secretTextUpload>
  >;
  "files.upload.discard": RpcRequest<
    Input<typeof FilesUploadRefInput>,
    Answer<typeof files.uploadDiscard>
  >;
  "files.capability": RpcRequest<Input<typeof FilesCapabilityInput>, Answer<typeof files.capability>>;
  "files.discard": RpcRequest<Input<typeof files.filesDiscardBody>, Answer<typeof files.discard>>;
  "files.content": RpcRequest<Input<typeof FilesContentInput>, Answer<typeof files.content>>;
  "files.pickNative": RpcRequest<Input<typeof FilesCapabilityInput>, Answer<typeof files.pickNative>>;
  /** `files.put`'s cancel, and the request card's read of the box's slot. */
  "files.put.abort": RpcRequest<StreamRef, StreamClosed>;
  "files.request.get": RpcRequest<Input<typeof FilesRequestRefInput>, Answer<typeof files.requestGet>>;
  /**
   * `files.get`'s cancel, and the save dialog: an opaque `dest_id` for the
   * folder the operator chose, `null` when they cancelled — never the path.
   */
  "files.get.abort": RpcRequest<StreamRef, StreamClosed>;
  "files.saveNative": RpcRequest<Input<typeof FilesCapabilityInput>, Answer<typeof files.saveNative>>;

  /**
   * Fixture-only staging. Core validates inside the fixture control surface —
   * the schema is the fixture backend's, not this head's — so the params are
   * forwarded whole, which is what the handler does.
   */
  "fixture.chat.inject": RpcRequest<unknown, Answer<typeof fixture.inject>>;
  "fixture.chat.hint": RpcRequest<unknown, Answer<typeof fixture.hint>>;

  /**
   * The developer tools (`handlers/devtools.ts`). Core validates each input
   * against its own schema, so the params are core's input types and the
   * handler forwards them whole. `devtools.tap` opens a stream whose records
   * ride `devtools.record`; `devtools.untap` is its close half. Every one but
   * `devtools.settings` is refused `DEVTOOLS_DISABLED` while the tools are off.
   */
  "devtools.settings": RpcRequest<DevtoolsSettingsInput, Answer<typeof devtools.settings>>;
  "devtools.stats": RpcRequest<Record<string, never>, Answer<typeof devtools.stats>>;
  "devtools.tap": RpcRequest<DevtoolsTapInput, { stream_id: string }>;
  "devtools.untap": RpcRequest<StreamRef, StreamClosed>;
  "devtools.clear": RpcRequest<DevtoolsClearInput, Answer<typeof devtools.clear>>;
  "devtools.export": RpcRequest<DevtoolsExportInput, Answer<typeof devtools.exportCapture>>;

  /**
   * The native requests (`handlers/app.ts`). A head without a window refuses every
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
  "app.installUpdate": RpcRequest<Record<string, never>, Answer<typeof app.installUpdate>>;
  "app.installCli": RpcRequest<Record<string, never>, Answer<typeof app.installCli>>;
  "app.notify": RpcRequest<Input<typeof app.AppNotifyRequest>, Answer<typeof app.notify>>;

  /**
   * The in-app terminal (issue #18, `handlers/terminal.ts`). `terminal.attach`
   * opens a stream whose frames ride `terminal.frame`; `terminal.detach` is its
   * close half. Keystrokes, acks and the view state are messages
   * (`BunMessages`), not requests.
   */
  "terminal.open": RpcRequest<Input<typeof terminal.TerminalOpenRequest>, Answer<typeof terminal.open>>;
  "terminal.attach": RpcRequest<Input<typeof terminal.TerminalSessionRequest>, { stream_id: string }>;
  "terminal.detach": RpcRequest<StreamRef, StreamClosed>;
  "terminal.resize": RpcRequest<
    Input<typeof terminal.TerminalResizeRequest>,
    Answer<typeof terminal.resize>
  >;
  "terminal.close": RpcRequest<
    Input<typeof terminal.TerminalSessionRequest>,
    Answer<typeof terminal.close>
  >;
  "terminal.list": RpcRequest<Input<typeof terminal.TerminalListRequest>, Answer<typeof terminal.list>>;
  "terminal.external": RpcRequest<
    Input<typeof terminal.TerminalExternalRequest>,
    Answer<typeof terminal.external>
  >;
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
  "files.stage.abort",
  "files.upload.open",
  "files.secretText.upload",
  "files.upload.discard",
  "files.capability",
  "files.discard",
  "files.content",
  "files.pickNative",
  "files.put.abort",
  "files.request.get",
  "files.get.abort",
  "files.saveNative",
  "fixture.chat.inject",
  "fixture.chat.hint",
  "devtools.settings",
  "devtools.stats",
  "devtools.tap",
  "devtools.untap",
  "devtools.clear",
  "devtools.export",
  "app.info",
  "app.openExternal",
  "app.checkForUpdate",
  "app.installUpdate",
  "app.installCli",
  "app.notify",
  "terminal.open",
  "terminal.attach",
  "terminal.detach",
  "terminal.resize",
  "terminal.close",
  "terminal.list",
  "terminal.external",
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
  /**
   * Named by the op and by the subscription that produced it. Two readers of
   * one op each have their own subscription, and a frame goes to its own
   * reader only: shared by `op_id`, a live frame meant for one could reach a
   * reader still waiting for its replay and put it out of order.
   */
  "op.event": { op_id: string; stream_id: string; msg: StreamFrame };
  "fleet.event": { event: StreamFrame };
  "chat.event": { event: StreamFrame };
  /** `frame` and `done` are core's `ChatFrame`s; see `PublicRequests` on why they are not typed. */
  "chat.frame": { stream_id: string; frame?: unknown; done?: unknown };
  /** `line` is core's `LogLine`; `done` is the tail's `{ ok }`. */
  "logs.line": { stream_id: string; line?: unknown; done?: unknown };
  /**
   * One `files.stage` frame: `frame` is a progress event, `done` the last word
   * — `staged` with the box's answer, or `error` (`FilesStageFrame`).
   */
  "files.frame": { stream_id: string; frame?: FilesStageFrame; done?: FilesStageFrame };
  /**
   * One `files.put` frame: `frame` is a progress event, `done` the last word
   * — `fulfilled` with the box's answer, or `error` (`FilesPutFrame`).
   */
  "files.put.frame": { stream_id: string; frame?: FilesPutFrame; done?: FilesPutFrame };
  /**
   * One `files.get` frame: `frame` is a progress event, `done` the last word
   * — `saved` with the name it was saved under, or `error` (`FilesGetFrame`).
   */
  "files.get.frame": { stream_id: string; frame?: FilesGetFrame; done?: FilesGetFrame };
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
  /**
   * One frame of a `terminal.attach` stream (`terminal/channel.ts`): the
   * session's snapshot, raw output, a refused keystroke chunk, or `exit`,
   * which is always the last. `keepalive` is never sent, as for every stream.
   */
  "terminal.frame": { stream_id: string; frame: TerminalFrame };
  /**
   * One push of a `devtools.tap` stream: `records` is a batch of captured
   * records in capture order (coalesced, `handlers/devtools.ts`), `done` the
   * tap's last word when its source ended — `{ ok: false, error }`.
   */
  "devtools.record": { stream_id: string; records?: TapRecord[]; done?: unknown };
};

export type WebviewMessageName = keyof WebviewMessages;

/**
 * Page → main process, fire-and-forget. `page.ready`: the page has mounted and
 * is ready to be pushed at, which is what a head with no socket has instead of
 * a connection. The three `terminal.*` messages are the in-app terminal's hot
 * path (`handlers/terminal.ts`): a keystroke is not worth a round trip, and
 * none of them is ever logged.
 */
export type BunMessages = {
  "page.ready": Record<string, never>;
  /**
   * Keystrokes for a session, `in_seq` counting from 0 per page; exactly one
   * of `data` (xterm `onData`) and `binary` (`onBinary`, base64). At most
   * 16 KiB each, or the chunk comes back as an `input_error` frame.
   */
  "terminal.input": Input<typeof terminal.TerminalInputMessage>;
  /** Output parsed up to `upto` on screen generation `gen` of one attach. */
  "terminal.ack": Input<typeof terminal.TerminalAckMessage>;
  /** The session this window shows now, or null: visible, focused, drawer on Terminal. */
  "terminal.view": Input<typeof terminal.TerminalViewMessage>;
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
  "files.stage": "files.frame",
  "files.put": "files.put.frame",
  "files.get": "files.get.frame",
  "terminal.attach": "terminal.frame",
  "devtools.tap": "devtools.record",
} as const satisfies Record<string, WebviewMessageName>;

export type StreamingRequestName = keyof typeof MESSAGE_FOR_REQUEST;
export type StreamMessageName = (typeof MESSAGE_FOR_REQUEST)[StreamingRequestName];
