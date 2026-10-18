/**
 * Continuous observation (§9.2), wired to the seams `chat.ts`
 * already owns: its `history` for the snapshot and its `address` for the hint
 * stream. The per-instance record of gateways whose hint channel has been
 * shown not to deliver lives here beside the stream that learns it.
 */
import { OBSERVE_RECONNECT_ATTEMPTS, OBSERVE_WINDOW, createChatObservation } from "./chat-observe.ts";
import type {
  ChatObserveBusyOptions,
  ChatObserveHint,
  ChatObserveOptions,
  ChatObserveTarget,
} from "./chat-observe.ts";
import type { BoxAddress, HermesChatClient } from "./hermes/hermes-chat.ts";
import type { ObserveAddressCache } from "./chat-observe-address.ts";
import type { ChatDeps, ChatHistoryResult, ChatOptions } from "./chat.ts";
import type { TranscriptMask } from "./chat-redact.ts";
import type { SubagentBlock } from "../schema/index.ts";

/** What the observation reads from the surface that built it. */
export interface ChatObserveContext {
  deps: ChatDeps;
  hermes: HermesChatClient;
  /**
   * The observation's own guarded lookup (`chat-observe-address.ts`): the fleet
   * guard and the agent row cached for a while, the listen check run every time.
   */
  addresses: ObserveAddressCache;
  /**
   * `chat.ts`'s `history`, handed the lookup to read through, so every
   * reconcile passes the listen check and, when the cache is cold, the guard.
   */
  history: (
    input: unknown,
    opts?: ChatOptions,
    resolve?: (instance: string) => Promise<BoxAddress>,
  ) => Promise<ChatHistoryResult>;
  now: () => string;
  /** The redaction door (`chat.ts`'s `mask`), for the one payload a hint carries. */
  mask: () => TranscriptMask;
}

/**
 * A subagent block through the door, the way a live frame carrying it goes:
 * every text field masked with redaction on, the failure text either way.
 */
function maskSubagent(view: TranscriptMask, block: SubagentBlock): SubagentBlock | undefined {
  const framed = view.frame({ type: "block", seq: 0, message: "", block });
  return framed.type === "block" && framed.block.kind === "subagent" ? framed.block : undefined;
}

export function createChatObserveWiring(ctx: ChatObserveContext) {
  const { deps, hermes, addresses, history, now, mask } = ctx;

  /**
   * Continuous observation (§9.2), wired to the seams this module
   * already owns rather than given seams of its own.
   *
   * `snapshot` is `chat.ts`'s `history`, read through `addresses` — the fleet
   * guard and the agent row kept for a while (`chat-observe-address.ts`), and
   * the listen check run on *every* reconcile rather than once at the start. An
   * instance the operator stops listening to fails the next read with
   * `VALIDATION`, which `chat-observe.ts` treats as terminal, so unlistening
   * ends the observation instead of leaving a loop reading a box nobody asked
   * about. A read whose cached address no longer answers is retried once
   * through a freshly guarded one, so a recreated or destroyed box is seen on
   * that read.
   * It also means the messages the service sees have already been through the
   * redaction door; `chat-observe.ts` is not a second one.
   *
   * `busy` is passed only when the adapter has one, and goes through the same
   * lookup, so an unlistened instance is never probed. Without it an
   * observation emits no `busy` event and a head knows only its own turns.
   *
   * `hints` is passed only when the adapter has one, and `hintsUsable` decides
   * separately whether the one it has is working. Asking only the first
   * question was the bug behind a much worse one: every real adapter defines
   * `observe`, so a gateway whose socket closed the instant it was opened
   * looked supported, and the documented degrade-to-poll path was unreachable
   * in production. A gateway with no hint channel, or with one that does not
   * work, leaves the service on its poll floor, which is a complete design.
   *
   * There is no `notify`. §4.9 gives `chat.message` exactly one source — the
   * `chat.swarms` roster diff — and an observation is not one: it reconciles
   * mid-turn, before `done` advances the watermark, so it reports the reply the
   * operator is watching arrive as news.
   */
  const observation = createChatObservation({
    snapshot: async (target, request) => {
      const result = await addresses.read(
        target.instance,
        (box) =>
          history(
            {
              instance: target.instance,
              bot: target.bot,
              ...(target.session !== undefined ? { session: target.session } : {}),
              limit: OBSERVE_WINDOW,
            },
            request,
            async () => box,
          ),
        request.signal,
      );
      return { session: result.session, messages: result.messages };
    },
    ...(hermes.observe ? { hints, hintsUsable } : {}),
    ...(hermes.busy ? { busy } : {}),
    pollMs: deps.observeTuning?.pollMs,
    hintedPollMs: deps.observeTuning?.hintedPollMs,
    clock: deps.observeTuning?.clock,
    sleep: deps.observeTuning?.sleep,
    reconnect: deps.observeTuning?.reconnect,
    now,
    ...(deps.devtap !== undefined ? { devtap: deps.devtap } : {}),
  });

  /**
   * The adapter's busy probe, addressed. A refusal from the lookup reads as
   * "could not tell", like any other probe failure: ending the watch is the
   * next authoritative read's job, not the probe's. A failure other than an
   * abort also drops the cached address, so the next read re-guards.
   */
  async function busy(
    target: ChatObserveTarget,
    request: ChatObserveBusyOptions,
  ): Promise<boolean | null> {
    const probe = hermes.busy;
    if (!probe) return null;
    const box = await addresses.get(target.instance);
    try {
      return await probe(box, target.bot, request.sessions, { signal: request.signal });
    } catch (error) {
      if (request.signal?.aborted !== true) addresses.forget(target.instance);
      throw error;
    }
  }

  /**
   * The adapter's hint stream, addressed.
   *
   * An async generator rather than a direct call because the box has to be
   * resolved first, and resolving it is the same lookup the reads go through.
   * A hint stream is therefore refused for an instance this laptop is not
   * listening to, exactly as a read is.
   */
  async function* hints(
    target: ChatObserveTarget,
    request: ChatObserveOptions,
  ): AsyncIterable<ChatObserveHint> {
    const open = hermes.observe;
    if (!open) return;
    const box = await addresses.get(target.instance);
    let heard = false;
    try {
      for await (const hint of open(box, target.bot, {
        signal: request.signal,
        ...(target.session !== undefined ? { session: target.session } : {}),
        // The observation knows which session its last read resolved to; a
        // pinned watch would otherwise drop every hint after a compression.
        ...(request.sessions !== undefined ? { sessions: request.sessions } : {}),
      })) {
        heard = true;
        // One hint is proof the gateway broadcasts. Whatever it did before
        // stops being evidence of anything.
        hintsBroken.delete(target.instance);
        // The mask is taken per hint, like a read: a settings change between
        // two child updates applies to the second.
        yield hint.subagent ? { ...hint, subagent: maskSubagent(mask(), hint.subagent) } : hint;
      }
    } catch (error) {
      // A socket that failed before it said anything is the same evidence as
      // one that closed before it said anything.
      if (!heard) strikeHints(target.instance);
      if (request.signal?.aborted !== true) addresses.forget(target.instance);
      throw error;
    }
    // Ended cleanly and said nothing. An abort is not evidence of anything: it
    // is this laptop closing its own socket.
    if (!heard && request.signal?.aborted !== true) strikeHints(target.instance);
  }

  /**
   * Which gateways have been shown not to broadcast, and how many times.
   *
   * The question `hermes.observe` answers is "is there code for a hint
   * channel?", and for every real adapter the answer is permanently yes. The
   * question that matters is "does this deployment's socket actually deliver?",
   * and only the socket can answer it, so the answer is recorded here per
   * instance as it is learned.
   *
   * A strike is a hint stream that ended, or failed, having never yielded a
   * single hint. One strike is not a verdict — a dashboard restart drops a
   * perfectly good stream mid-silence — so the verdict takes as many strikes as
   * the observation service is willing to spend reopening, which is the same
   * budget and therefore the same moment. Hearing one hint clears the record.
   *
   * The verdict expires, because a gateway that has since been upgraded should
   * not be polled for the rest of the portal's life on the strength of what it
   * did an hour ago. Re-probing costs one stream per conversation per window.
   */
  const hintsBroken = new Map<string, { strikes: number; at: number }>();
  const HINTS_BROKEN_MS = 5 * 60_000;
  const hintsStrikeLimit = deps.observeTuning?.reconnect?.attempts ?? OBSERVE_RECONNECT_ATTEMPTS;

  function strikeHints(instance: string): void {
    const prior = hintsBroken.get(instance);
    hintsBroken.set(instance, { strikes: (prior?.strikes ?? 0) + 1, at: Date.parse(now()) });
  }

  function hintsUsable(target: ChatObserveTarget): boolean {
    const record = hintsBroken.get(target.instance);
    if (record === undefined || record.strikes < hintsStrikeLimit) return true;
    if (Date.parse(now()) - record.at < HINTS_BROKEN_MS) return false;
    hintsBroken.delete(target.instance);
    return true;
  }

  return observation;
}
