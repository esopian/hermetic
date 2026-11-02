/**
 * `/btw`: a side question about a conversation, answered without touching it.
 *
 * Upstream's `prompt.btw {session_id, text}` (`tui_gateway/methods_prompt.py`)
 * replies at once with a `task_id`, answers from a snapshot of the session's
 * history on a thread of its own, and later emits `btw.complete {task_id,
 * question, text}` on the session's transport — the socket attached to that
 * runtime session. History, alternation and the prompt cache are untouched,
 * and it works while a turn is running. A failed answer is text beginning
 * `"error: "`. It is never `slash.exec`: the slash worker prints the answer
 * after its stdout capture closes, so only the acknowledgement would be seen.
 *
 * The answer arrives on whichever socket holds the session, so it is read by
 * `observe`, which every socket the session sockets build reports to
 * (`SessionSocketDeps.onEvent`), and matched to its waiter by `task_id` alone.
 */
import { checkAbort } from "../../abort.ts";
import { HermeticError } from "../../errors.ts";
import type { createCanonicalSessions } from "../../render/hermes-canonical.ts";
import { type Rpc, untilAbort } from "./hermes-chat-rpc.ts";
import type { SessionSockets } from "./hermes-chat-session-socket.ts";
import {
  CHAT_ERROR_CODES,
  chatError,
  type BoxAddress,
  type ChatBtwAnswer,
  type SendOptions,
} from "./hermes-chat-types.ts";
import { HERMETIC_SESSION_SOURCE, rec, str } from "./hermes-chat-wire.ts";

/**
 * How long a side question may take to answer. It is one model call over the
 * whole conversation snapshot, and upstream sets no limit of its own.
 */
export const BTW_TIMEOUT_MS = 300_000;

/** JSON-RPC's "method not found": a gateway that predates `prompt.btw`. */
const METHOD_NOT_FOUND = -32601;

/** Answers that beat their `prompt.btw` reply, and ids already answered, kept this many each. */
const KEPT = 32;

/** Drop the oldest entry of an insertion-ordered set or map once it is past `KEPT`. */
function trim(kept: Set<string> | Map<string, unknown>): void {
  if (kept.size > KEPT) kept.delete(kept.keys().next().value ?? "");
}

export interface SideQuestionDeps {
  sockets: SessionSockets;
  conversation: ReturnType<typeof createCanonicalSessions>["conversation"];
  timeoutMs?: number | undefined;
}

export function createSideQuestions(deps: SideQuestionDeps) {
  const timeoutMs = deps.timeoutMs ?? BTW_TIMEOUT_MS;
  const waiters = new Map<string, (payload: Record<string, unknown>) => void>();
  const early = new Map<string, Record<string, unknown>>();
  // The same answer can arrive twice — live on a socket, then replayed to the turn.
  const done = new Set<string>();

  function observe(event: Record<string, unknown>): void {
    if (str(event.type) !== "btw.complete") return;
    const payload = rec(event.payload) ?? {};
    const task = str(payload.task_id);
    if (!task || done.has(task)) return;
    const waiter = waiters.get(task);
    if (waiter) {
      trim(done.add(task));
      waiter(payload);
      return;
    }
    trim(early.set(task, payload));
  }

  async function ask(
    box: BoxAddress,
    bot: string,
    text: string,
    opts: SendOptions = {},
  ): Promise<ChatBtwAnswer> {
    const question = text.trim();
    if (!question) throw new HermeticError("VALIDATION", "/btw needs a question");
    checkAbort(opts.signal, "chat.btw");
    const stored = opts.session ?? (await deps.conversation(box, bot, opts))?.session;
    if (!stored)
      throw new HermeticError(
        "VALIDATION",
        "/btw needs a conversation to ask about; send a message first",
      );
    // A held socket is used as it is, with no lease: a running turn holds the
    // lease, and a second socket's `session.resume` would take the session's
    // transport away from that turn.
    const held = deps.sockets.peek(box, bot, stored);
    let task: string;
    if (held) task = await submit(held.rpc, box, held.runtime, question, opts.signal);
    else {
      const lease = await deps.sockets.lease(box, bot, stored, opts.signal);
      try {
        const runtime = await resume(lease.rpc, box, bot, stored, opts.signal);
        lease.keep(stored, runtime);
        task = await submit(lease.rpc, box, runtime, question, opts.signal);
      } finally {
        // Back to an idle hold at once; the answer reaches `observe` from there.
        lease.release(lease.rpc);
      }
    }
    const payload = await answer(task, opts.signal);
    const said = typeof payload.text === "string" ? payload.text : "";
    return {
      task_id: task,
      question: typeof payload.question === "string" ? payload.question : question,
      answer: said,
      error: said.startsWith("error: "),
    };
  }

  async function submit(
    rpc: Rpc,
    box: BoxAddress,
    runtime: string,
    text: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    let reply: unknown;
    try {
      reply = await rpc.request("prompt.btw", { session_id: runtime, text }, undefined, { signal });
    } catch (e) {
      if (e instanceof HermeticError && e.details?.code === METHOD_NOT_FOUND)
        throw new HermeticError(CHAT_ERROR_CODES.PROTOCOL, "This gateway does not support /btw");
      throw e;
    }
    const task = str(rec(reply)?.task_id);
    if (!task) throw chatError(CHAT_ERROR_CODES.PROTOCOL, `${box.instance}: prompt.btw named no task`);
    return task;
  }

  async function answer(
    task: string,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> {
    const ready = early.get(task);
    if (ready) {
      early.delete(task);
      trim(done.add(task));
      return ready;
    }
    // shortcut: an idle hold that drops and is revived replays nothing, so an answer emitted in
    // the gap is lost and this waits out the timeout; upgrade by reading `session.events.since` on revive.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answered = new Promise<Record<string, unknown>>((resolve, reject) => {
      waiters.set(task, resolve);
      timer = setTimeout(
        () =>
          reject(
            chatError(
              CHAT_ERROR_CODES.UNREACHABLE,
              `no answer to /btw within ${Math.round(timeoutMs / 1000)}s`,
              { task_id: task },
            ),
          ),
        timeoutMs,
      );
    });
    try {
      return await untilAbort(answered, signal, "chat.btw");
    } finally {
      waiters.delete(task);
      clearTimeout(timer);
    }
  }

  return { ask, observe, pending: () => waiters.size };
}

/** The turn's lazy resume (`hermes-chat-turn.ts`), for a socket with no hold. */
async function resume(
  rpc: Rpc,
  box: BoxAddress,
  bot: string,
  stored: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const result = rec(
    await rpc.request(
      "session.resume",
      {
        session_id: stored,
        profile: bot,
        source: HERMETIC_SESSION_SOURCE,
        defer_history: true,
        omit_messages: true,
      },
      undefined,
      { signal },
    ),
  );
  const runtime = str(result?.session_id);
  if (!runtime)
    throw chatError(
      CHAT_ERROR_CODES.PROTOCOL,
      `${box.instance}: session.resume named no runtime session`,
    );
  return runtime;
}
