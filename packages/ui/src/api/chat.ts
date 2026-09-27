/**
 * The chat wrappers (§9.2) and Bot Mode's typed operations.
 * A turn is a finite stream rather than a request — see §9.2 and
 * `transport.ts`'s `openStream`.
 */
import { FETCH_KEYS, cachedFetch, invalidateFetchCache } from "../lib/fetch-cache.ts";
import { target } from "./client.ts";
import type { FleetTarget } from "./client.ts";
import { transport } from "./transport.ts";
import type { RequestName } from "./transport.ts";
import type {
  BridgeInput,
  BridgeName,
  BridgeResult,
  ChatAbortResult,
  ChatFrameView,
  ChatHistoryResult,
  ChatResumeResult,
  ChatSessionsResult,
  ChatSwarmsResult,
} from "./types.ts";

/* ── chat (§9.2) ──────────────────────────────────────────────────────────── */

/** Local, fleet-scoped instances this operator has chosen to monitor. */
export function fetchListening(): Promise<{ instances: string[] }> {
  // Deduped and briefly cached: this read is made on mount, on a timer, and on
  // a return to the window, which can arrive together.
  return cachedFetch(FETCH_KEYS.listening, () =>
    transport().request<{ instances: string[] }>("chat.listening"),
  );
}

export async function setInstanceListening(
  instance: string,
  listening: boolean,
): Promise<{ instances: string[] }> {
  const result = await transport().request<{ instances: string[] }>("chat.listen", {
    instance,
    listening,
    target: target(),
  });
  // The write is the newer truth; no reader may be handed the pre-write answer.
  invalidateFetchCache(FETCH_KEYS.listening);
  return result;
}

/**
 * `GET /api/chat/swarms`. The rail's whole content in one read: every box's
 * roster, including the boxes that did not answer.
 *
 * A fleet-wide read is a fan-out with a timeout per box, so it is slow in a way
 * no other read here is, and it never *fails* for an unreachable box — that
 * arrives as `reachable: false` with a reason on the swarm. The rail draws it
 * striped rather than dropping it (§9.2): a box that is off the tailnet is the
 * box an operator is most likely to be looking for.
 */
export function fetchSwarms(
  input: { instance?: string } = {},
  signal?: AbortSignal,
): Promise<ChatSwarmsResult> {
  return transport().request<ChatSwarmsResult>("chat.swarms", { ...input }, { signal });
}

/** `GET /api/chat/:instance/:bot/sessions` — one bot's conversations, with their origins. */
export function fetchSessions(
  instance: string,
  bot: string,
  signal?: AbortSignal,
): Promise<ChatSessionsResult> {
  return transport().request<ChatSessionsResult>("chat.sessions", { instance, bot }, { signal });
}

/**
 * `GET /api/chat/:instance/:bot/history` — the transcript, read from the box.
 *
 * Read every time and never merged into (§9.2). The box is
 * authoritative and anything this browser is holding is a cache that is allowed
 * to be wrong; merging a re-read into it is the bug that looks like it works.
 */
export function fetchHistory(
  instance: string,
  bot: string,
  input: { session?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<ChatHistoryResult> {
  return transport().request<ChatHistoryResult>(
    "chat.history",
    { instance, bot, ...input },
    { signal },
  );
}

/**
 * `POST /api/chat/:instance/:bot/abort` — stop the turn in flight.
 *
 * `aborted` reports whether a running session was interrupted. An already-idle
 * session returns false without starting or warming a backend.
 *
 * The session is the durable ID selected by the composer. The server resolves
 * it against the exact runtime tracked for this portal's active turn. A new
 * turn may not have published its durable ID yet, so that argument is optional.
 */
export function abortTurn(
  instance: string,
  bot: string,
  session?: string | null,
): Promise<ChatAbortResult> {
  return transport().request<ChatAbortResult>("chat.abort", {
    instance,
    bot,
    session,
    target: target(),
  });
}

/**
 * `chat.observe.resume` — ask this head to hold one conversation's
 * observation again, after it ended.
 *
 * The narrow sibling of `setInstanceListening`, and the difference is the whole
 * point of the route. Writing the listen preference reconciles every listened
 * box, so one click on one bot re-opened every dropped observation in the
 * fleet; this asks for exactly the conversation named in the path. It writes
 * nothing to the box — the observation is a read of a conversation that is
 * already there.
 *
 * The session rides in the query string, as it does on the `GET` of the same
 * path, because the URL already names the conversation twice and a body would
 * be a third way to say it. There is no body at all.
 */
export function resumeObservation(
  instance: string,
  bot: string,
  session?: string | null,
): Promise<ChatResumeResult> {
  return transport().request<ChatResumeResult>("chat.observe.resume", { instance, bot, session });
}

export interface ChatTurnHandlers {
  onFrame: (frame: ChatFrameView) => void;
  /**
   * The turn is over. `ok` is false for an `error` frame *and* for a socket that
   * died without one — the second is this browser's stream to the portal
   * dropping, and the caller's answer to both is the same: re-read the
   * transcript from the box. A drop between the portal and the box is core's,
   * and it continues the turn from its cursor rather than ending it (§9.2);
   * what arrives here is a `done` with `incomplete` set only once that has run
   * out of ways to continue.
   */
  onEnd: (ok: boolean, error: { code: string; message: string } | null) => void;
}

/**
 * One turn, streamed. Returns a canceller.
 *
 * A sibling of `fetchConsole`, not of `followOp`, and the difference is the
 * whole of §9.2. An op is long, restartable, replayable and persisted, so
 * `followOp` resumes from `Last-Event-ID` against a server-side buffer. A turn
 * is a live pipe to a process already running elsewhere: there is no registry
 * behind this response and nothing buffered on the portal, so this hop has
 * nothing to resume *to*, and the request body is a message that must be said
 * exactly once.
 *
 * Hence `openStream` rather than a feed the transport re-opens by itself: a
 * turn that dies is dead rather than silently re-issued, because a re-open
 * would have sent the message a second time.
 *
 * Delivery after a drop is unknown from this side, which is why nothing retries:
 * the caller reconciles by re-reading the transcript. The gateway's own event
 * log is what makes the other hop different — core reconnects to the box and
 * replays from its cursor (§9.2) — and none of it is reachable from here,
 * which is why re-reading stays this side's only answer.
 */
export function sendTurn(
  instance: string,
  bot: string,
  message: string,
  handlers: ChatTurnHandlers,
  opts: { session?: string } = {},
): () => void {
  let fleet: FleetTarget;
  try {
    fleet = target();
  } catch (error) {
    // `target()` throws for a tab that does not know its fleet. The contract
    // here is a canceller and an `onEnd`, never a synchronous throw, so the
    // refusal is delivered the way every other failure of this turn is.
    queueMicrotask(() =>
      handlers.onEnd(false, {
        code: "NO_TARGET",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return () => {};
  }
  return transport().openStream(
    "chat.turn",
    { instance, bot, message, session: opts.session, target: fleet },
    {
      /**
       * Only the frames this turn is about, and only the ones that decoded.
       *
       * A frame the transport could not read arrives with `data` undefined,
       * which is the one thing worth ignoring; a render error belongs to the
       * consumer, and the transport re-raises it without losing the stream.
       */
      onFrame: (frame) => {
        if (
          frame.event !== "block" &&
          frame.event !== "delta" &&
          frame.event !== "done" &&
          frame.event !== "error"
        ) {
          return;
        }
        if (frame.data === undefined) return;
        handlers.onFrame(frame.data as ChatFrameView);
      },
      onEnd: handlers.onEnd,
    },
  );
}

/* ── Bot Mode: explicit typed operations, each one named request through the seam ── */

/**
 * One Bot Mode operation, as every one of them is: a name, the method's own
 * input, and the §4.7 fleet envelope this window is on.
 *
 * A factory rather than twenty-four copies of the same four lines. What used to
 * make them worth writing out was the route path each one had to name; with the
 * name *being* the method, the only thing left to say per operation is that
 * name — and each `const` below still declares its own parameter and return
 * types through `K`, so a caller sees exactly what it saw before.
 *
 * `target` is added here rather than by the caller because every one of these
 * is a fleet-scoped write or a read against one box, and a request that does
 * not name its fleet is one the head refuses (`client.ts`, `target()`).
 */
function botModeCall<K extends BridgeName & RequestName>(name: K) {
  return (input: Omit<BridgeInput<K>, "target">, signal?: AbortSignal): Promise<BridgeResult<K>> =>
    transport().request<BridgeResult<K>>(name, { ...input, target: target() }, { signal });
}

export const chatOpen = botModeCall("chat.open");
export const chatCompact = botModeCall("chat.compact");
export const chatArchive = botModeCall("chat.archive");
export const chatRespond = botModeCall("chat.respond");
export const botsCapabilities = botModeCall("bots.capabilities");
export const botsGet = botModeCall("bots.get");
export const botsCreate = botModeCall("bots.create");
export const botsUpdate = botModeCall("bots.update");
export const botsDelete = botModeCall("bots.delete");
export const roomsGet = botModeCall("rooms.get");
export const roomsCreate = botModeCall("rooms.create");
export const roomsRename = botModeCall("rooms.rename");
export const roomsDelete = botModeCall("rooms.delete");
export const roomsHistory = botModeCall("rooms.history");
export const roomsSend = botModeCall("rooms.send");
export const roomsControl = botModeCall("rooms.control");
export const roomsRespond = botModeCall("rooms.respond");
export const routinesList = botModeCall("routines.list");
export const routinesCreate = botModeCall("routines.create");
export const routinesUpdate = botModeCall("routines.update");
export const routinesDelete = botModeCall("routines.delete");
export const routinesRun = botModeCall("routines.run");
export const routinesHistory = botModeCall("routines.history");

export type BotProfileView = Awaited<ReturnType<typeof botsGet>>;
export type BotModeCapabilitiesView = Awaited<ReturnType<typeof botsCapabilities>>;
export type BotRoutineView = Awaited<ReturnType<typeof routinesList>>["jobs"][number];
export type HostedRoomView = Awaited<ReturnType<typeof roomsGet>>;
export type RoomEventView = Awaited<ReturnType<typeof roomsHistory>>["events"][number];
