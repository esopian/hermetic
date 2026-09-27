/**
 * One turn, streamed frame by frame — `chat.ts`'s `send`, in its own module.
 *
 * Everything it needs from the surface arrives in `ChatSendContext`: the
 * guarded address lookup, the fence store, the listening list and the clocks.
 * The rules it enforces — eager validation, error frames rather than throws,
 * the fence claimed before the prompt leaves, the watermark written in the
 * box's coordinate system — are documented on the function itself.
 */
import { ChatSendInput } from "../schema/index.ts";
import type { ChatFrame } from "../schema/index.ts";
import { redactText } from "./chat-redact.ts";
import { markChatTurn, notifyChatError, resolveChatErrors } from "./notifications.ts";
import type { BoxAddress, HermesChatClient } from "./hermes/hermes-chat.ts";
import { CHAT_FENCE_RENEW_MS, acquireChatFence } from "./chat-fence.ts";
import type { ChatFenceLease, ChatFenceStore } from "./chat-fence.ts";
import type { InstanceListeningStore } from "./instance-listening.ts";
import { HermeticError } from "../errors.ts";
import { createDeltaGate } from "./chat-gate.ts";
import { parse, reasonOf } from "./chat-seal.ts";
import type { ChatDeps, ChatOptions } from "./chat.ts";

/**
 * How long a finished turn will wait for the box to say where its transcript
 * got to, before giving up and declining to advance the watermark.
 *
 * The watermark has to be written before the terminal `done` is yielded, so
 * this read is on the critical path of every turn's visible end. Five seconds
 * is far longer than a local roster read and far shorter than the transport's
 * own deadline, which is the whole point: a box that stopped answering costs
 * the operator one inbox row, never a turn that appears to hang after the
 * model has already finished speaking.
 */
const ATTRIBUTION_DEADLINE_MS = 5_000;

/** What `send` reads from the surface that built it. */
export interface ChatSendContext {
  deps: ChatDeps;
  hermes: HermesChatClient;
  validateName: (name: string) => void;
  /** The guarded lookup every method goes through (`chat.ts`'s `address`). */
  address: (instance: string) => Promise<BoxAddress>;
  fenceStore: ChatFenceStore;
  instanceListening: InstanceListeningStore;
  now: () => string;
  /** The laptop's clock in milliseconds, for the lease and nothing else. */
  nowMs: () => number;
}

export function createChatSend(ctx: ChatSendContext) {
  const { deps, hermes, validateName, address, fenceStore, instanceListening, now, nowMs } = ctx;

  /**
   * One turn, streamed frame by frame.
   *
   * The input is validated *eagerly* — before the generator is entered — so a
   * malformed request is a thrown `VALIDATION` rather than a stream that opens
   * and immediately says no. That is the same split `logs` makes, and both heads
   * depend on it: the CLI wants exit 2 for a bad argument, and the server wants
   * to refuse before it has committed to a 200 and an SSE body.
   *
   * Everything after that point is an **error frame**, not a throw. By then the
   * head is already streaming: the server has sent its headers and the CLI is
   * writing to stdout, and neither can retroactively turn the response into a
   * failure. The frame carries a `HermeticError` code so a head can still tell
   * "the box is off the tailnet" from "the model refused" from "no warm slot"
   * without reading English — which is what `ErrorFrame` is for.
   */
  return function send(input: unknown, opts: ChatOptions = {}): AsyncIterable<ChatFrame> {
    const parsed = parse(ChatSendInput, input, "chat");
    validateName(parsed.instance);
    const where = { instance: parsed.instance, bot: parsed.bot };
    /** The fleet this turn resolved to, for the local session record below. */
    let fleetOfTurn: string | null = null;
    /** Whether this turn's watermark has already moved. See `markTurnSeen`. */
    let turnSeen = false;
    /** Where the turn went, kept so the terminal read can ask the same box. */
    let boxOfTurn: BoxAddress | null = null;
    /** The session this turn spoke into; what makes the box's coordinate attributable. */
    let sessionOfTurn: string | undefined;
    let fence: ChatFenceLease | null = null;
    let renewal: ReturnType<typeof setInterval> | null = null;

    /**
     * Drop the claim. Idempotent, and called from two places on purpose.
     *
     * The `finally` below is not enough by itself: a caller that stops pulling
     * at `done` without ever calling the iterator's `return` leaves the
     * generator parked forever, and its `finally` with it. So the terminal
     * `done` releases explicitly, before the frame leaves, for the same reason
     * the watermark moves there.
     */
    function releaseFence(): void {
      if (renewal !== null) {
        clearInterval(renewal);
        renewal = null;
      }
      fence?.release();
      fence = null;
    }
    return (async function* () {
      const gate = createDeltaGate();
      /**
       * The turn's verdict, accumulated as the frames go past rather than
       * decided at the end, because a turn reaches its end three different
       * ways: the adapter can throw, it can hand back an `error` frame without
       * throwing, and it can simply stop. A source that watched only one of
       * those would miss whichever the next adapter change happened to use.
       *
       * `failure` is *cleared* by a later `done`, and that is the point of it
       * being mutable rather than latching. Upstream can report a recoverable
       * problem mid-turn — a tool that failed, a retry — and then finish
       * normally; a run that ends with the answer in the operator's hands is
       * not a failed turn, however loudly it complained on the way.
       *
       * `produced` is why `done` is required for success rather than assumed
       * from the absence of an error. A stream that ends having said nothing at
       * all — the socket closed, the generator returned — has disproved
       * nothing, and resolving this bot's open failures on that would clear the
       * inbox on exactly the evidence that ought to fill it.
       */
      let failure: { code: string; message: string } | null = null;
      let done = false;
      try {
        const box = await address(parsed.instance);
        boxOfTurn = box;
        fleetOfTurn = box.fleet_id ?? null;
        /**
         * Claimed before the prompt is sent, because the box's coordinate moves
         * the moment it is: a roster read between the send and the first frame
         * would otherwise announce the operator's own question back at them.
         *
         * Renewed on a timer rather than on frame arrival — frames are not a
         * heartbeat, and the stretch where a model is thinking and saying
         * nothing is exactly the stretch the fence is for (`chat-fence.ts`).
         */
        fence = acquireChatFence(fenceStore, fleetOfTurn, where, { now: nowMs });
        renewal = setInterval(() => {
          // A lease that has been superseded stops renewing rather than taking
          // the claim back from whoever holds it now (`chat-fence.ts`).
          if (fence?.renew() === false && renewal !== null) {
            clearInterval(renewal);
            renewal = null;
          }
        }, CHAT_FENCE_RENEW_MS);
        // Never a reason for a process to stay alive: the fence lapses by itself.
        (renewal as { unref?: () => void }).unref?.();
        opts.signal?.throwIfAborted();
        const conversation = hermes.conversation
          ? await hermes.conversation(box, parsed.bot, {
              signal: opts.signal,
              create: true,
              ...(parsed.session ? { session: parsed.session } : {}),
              ...(parsed.new_session ? { new_session: true } : {}),
            })
          : null;
        const targetSession = conversation?.session ?? parsed.session;
        sessionOfTurn = targetSession;
        if (
          conversation?.kind === "canonical" &&
          /^\/(new|reset|compact)\s*$/.test(parsed.message.trim())
        ) {
          if (!hermes.compact)
            throw new HermeticError("CHAT_PROTOCOL", "Compaction is unavailable on this gateway");
          const result = await hermes.compact(box, parsed.bot, {
            signal: opts.signal,
            session: conversation.session,
          });
          yield {
            type: "block",
            seq: 0,
            message: "compact",
            block: {
              kind: "text",
              markdown: result.compressed
                ? "Context compacted. Bot Chat preserved."
                : `Compaction: ${result.status}`,
            },
          };
          yield { type: "done", seq: 1, message: "compact" };
          return;
        }
        for await (const frame of hermes.send(box, parsed.bot, parsed.message, {
          signal: opts.signal,
          ...(targetSession !== undefined ? { session: targetSession } : {}),
        })) {
          // The caller's own abort ends the loop here as well as reaching the
          // adapter: a socket that has not noticed yet must not be able to
          // write one more frame into a head that has stopped listening. It is
          // a `break` and not a `return` because what has already been said
          // still has to be flushed — an aborted turn keeps its words.
          if (opts.signal?.aborted) break;
          for (const out of gate.accept(frame)) {
            if (out.type === "error") failure = { code: out.code, message: out.message };
            if (out.type === "done") {
              done = true;
              failure = null;
              // The watermark moves before the frame leaves, because the
              // caller is under no obligation to ask for another one: the
              // CLI's `--json` head prints `done` and exits, and a generator
              // parked on a `yield` nobody resumes never runs another line.
              // Only the watermark — resolving this bot's open failures waits
              // for the turn to actually end, since it can still throw here.
              await markTurnSeen();
              releaseFence();
            }
            yield out;
          }
        }
        // Inside the `try`, so the fence is still held while the terminal
        // verdict is recorded: an aborted turn's watermark is read from the box
        // here, and releasing first would open exactly the window the fence
        // exists to close.
        yield* gate.flush();
        await notifyTurn(failure, done);
      } catch (error) {
        yield* gate.flush();
        const { code, message } = reasonOf(error);
        failure = { code, message: redactText(message) };
        yield { type: "error", code, message: failure.message };
        await notifyTurn(failure, done);
        return;
      } finally {
        // Every other way out of the turn — a throw, a `return`, a consumer
        // that called the iterator's `return` by breaking out of its loop.
        releaseFence();
      }
    })();

    /**
     * What the inbox learns from a settled turn.
     *
     * A failure raises a row. A turn that ran to `done` resolves whatever the
     * last failures against this bot were, because an answer disproves all of
     * them at once, and advances the bot's watermark so the roster read that
     * follows does not report the reply the caller just streamed as news.
     *
     * An *aborted* turn is neither. It raises nothing, because the operator
     * stopped it on purpose, and resolves nothing, because stopping a turn is
     * no evidence that the thread is healthy. It still advances the watermark:
     * the box very likely wrote a partial turn down, and the operator watched
     * every word of it arrive.
     *
     * A turn that ended without a `done` and without a failure — a socket that
     * closed quietly — does nothing at all. There is no verdict to record.
     *
     * The values handed on are the ones already yielded, so the masking the
     * caller saw is the masking the row gets; this is not a second door (§9.2).
     */
    async function notifyTurn(
      failure: { code: string; message: string } | null,
      done: boolean,
    ): Promise<void> {
      if (!instanceListening.list(fleetOfTurn).includes(parsed.instance)) return;
      const notifications = deps.notifications;
      if (failure) {
        if (notifications) notifyChatError(notifications, where, failure);
        return;
      }
      const aborted = opts.signal?.aborted === true;
      if (!done && !aborted) return;
      // Acknowledging own activity and declaring the thread healthy are two
      // different claims: an aborted turn does the first and never the second,
      // which is why the `await` is above the `aborted` test and not below it.
      await markTurnSeen();
      if (!notifications || aborted) return;
      resolveChatErrors(notifications, where);
    }

    /**
     * The half of the verdict that is safe to record early: this laptop was
     * here, and it has read what the box said.
     *
     * Split from the resolve because the two answer different questions. The
     * watermark is about a message the operator has already seen, and is true
     * the moment `done` is yielded; resolving this bot's open `chat.error` rows
     * claims the conversation is healthy, and a turn that throws *after* its
     * `done` has not shown that. Idempotent, because the end of the turn calls
     * it again for the paths that never reached a `done` frame.
     */
    async function markTurnSeen(): Promise<void> {
      if (turnSeen) return;
      // The instance the operator stopped listening to gets nothing, exactly as
      // it does on every other path through `notifyTurn`.
      if (!instanceListening.list(fleetOfTurn).includes(parsed.instance)) return;
      turnSeen = true;
      // The local session record is not the inbox's and does not depend on one:
      // a `Hermetic` with no notification store still owes the operator a
      // destination banner that stops firing on their own conversations.
      rememberSession();
      const notifications = deps.notifications;
      if (!notifications) return;
      const at = await boxCoordinate();
      // Attribution failed, so nothing moves. See `boxCoordinate`.
      if (at === null) return;
      markChatTurn(notifications, where, at);
    }

    /**
     * Where the box says this bot is up to, if and only if this turn is what
     * put it there.
     *
     * The watermark has to be written in the **box's** coordinate system,
     * because that is the system the roster read compares in. The laptop's
     * clock is not a substitute for it in either direction: stamped by a laptop
     * running behind the box, the watermark sits under the reply it was meant
     * to cover and the row is raised anyway; stamped by one running ahead, it
     * sits over a message somebody else sent during the turn and swallows it.
     * The two clocks are never compared and never max()-ed.
     *
     * So the coordinate is *read*, from the same two places the roster mapper
     * reads it: the bot's `last_message_at` on the swarm, and the session list
     * that says which conversation that timestamp belongs to. It is attributed
     * to this turn only when the session holding it is this turn's session.
     *
     * **Every other outcome declines to advance.** A read that failed, a turn
     * that named no session, a coordinate belonging to a different session —
     * that last one being the case that matters, because it means somebody else
     * spoke to this bot while the turn ran. Declining costs at most one row
     * about the operator's own reply, which the next roster read raises and the
     * operator recognises. Advancing on an unattributable coordinate would cost
     * a message from somebody else, silently and permanently. The asymmetry is
     * the policy.
     *
     * No `AbortSignal` is passed. An aborted turn still wrote a partial turn to
     * the box's transcript and the operator still watched it arrive, so it
     * still has activity to acknowledge — and a read cancelled by the very
     * abort it is reacting to could never do that.
     */
    async function boxCoordinate(): Promise<string | null> {
      const box = boxOfTurn;
      const session = sessionOfTurn;
      if (box === null || session === undefined) return null;
      /**
       * Bounded, because this read sits between the box's `done` and the
       * caller's: the watermark has to be persisted before the frame is
       * exposed (a caller is under no obligation to resume the generator), but
       * a box that has gone quiet must not hold a finished turn open for the
       * length of an RPC deadline. Past the deadline the turn declines and
       * releases, which costs one row about the operator's own reply — the
       * failure this mechanism is allowed to have.
       */
      const deadline = new AbortController();
      const timer = setTimeout(
        () => deadline.abort(),
        deps.attributionDeadlineMs ?? ATTRIBUTION_DEADLINE_MS,
      );
      (timer as { unref?: () => void }).unref?.();
      try {
        const roster = await Promise.race([
          hermes.swarm(box, { signal: deadline.signal }),
          new Promise<null>((resolve) => {
            deadline.signal.addEventListener("abort", () => resolve(null), { once: true });
          }),
        ]);
        const found = roster?.bots.find((b) => b.name === parsed.bot);
        const coordinate = found?.last_message_at;
        if (coordinate == null || coordinate === "") return null;
        /**
         * Attributed by the session the box read the coordinate *off*, which
         * the roster mapper carries beside it (`last_message_session`). The
         * earlier shape matched the coordinate against a `chat.sessions` read
         * instead, and that was wrong on every real box rather than merely
         * fragile: the roster maps its stamp from the profile row's
         * `last_active` and the session list maps its own from `started_at`,
         * so the two describe the same conversation with different numbers and
         * the match never held. A box too old to name the session declines,
         * which is the safe direction.
         */
        if (found?.last_message_session !== session) return null;
        return coordinate;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    }

    /**
     * Record that this laptop sent into this conversation, so the destination
     * banner stops calling it foreign (§9.2, and `LocalChatSessions` above).
     *
     * Written after the turn rather than when it was addressed, because a send
     * that never reached the box is not this portal joining a conversation. A
     * failed turn therefore records nothing, which is the safe direction: the
     * warning keeps firing until this laptop has actually spoken there.
     *
     * A turn that named **no** session records nothing either, and that is the
     * one real gap. The box picks or creates the session in that case and
     * nothing in the frames carries back which one, so the thread stays foreign
     * until the next turn into it — by which time the portal has read the
     * transcript, knows the session id, and addresses it explicitly. In the
     * portal that is the first turn into a brand-new bot and no others; erring
     * toward one extra warning is the direction this whole mechanism errs in.
     */
    function rememberSession(): void {
      const store = deps.localSessions;
      const session = parsed.session;
      if (!store || session === undefined) return;
      try {
        store.remember(fleetOfTurn, { ...where, session }, now());
      } catch {
        // A record that could not be written costs a warning that fires where
        // it need not have. Never a turn.
      }
    }
  };
}
