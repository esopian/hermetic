/**
 * A compaction asked for from the composer, as one turn's frames.
 *
 * `/compact [focus]` (or `/compress`) in any session, and `/new` or `/reset` in
 * a bot's canonical Bot Chat — the forever-chat never resets — run on the
 * gateway's `session.compress` instead of reaching the slash worker or the
 * model (§9.2). The desktop's `chat-send.ts` and the phone's transport both
 * run them through here, so the rule and the words cannot drift apart.
 */
import type { ChatFrame } from "../schema/chat.ts";
import { isCompactCommand, isNewSessionCommand, parseSlashCommand } from "../shared/slash.ts";

/**
 * How often the running status is sent again. Compressing is one LLM summary
 * call that can outlast a head's no-frame timer (the page's is ten minutes,
 * the gateway's own compute-host wait 630 s), so the turn keeps saying what it
 * is waiting on.
 */
export const COMPACT_HEARTBEAT_MS = 60_000;

/** What `session.compress` answered, as `createCanonicalSessions().compact` reports it. */
export interface CompactResult {
  compressed?: boolean | undefined;
  status?: string | undefined;
}

/**
 * The compaction `line` asks for in a conversation of `kind`, or `null` when
 * it is not one. `focus_topic` is `/compact`'s argument.
 */
export function compactionFor(line: string, kind: string): { focus_topic?: string } | null {
  if (isCompactCommand(line)) {
    const focus = parseSlashCommand(line.trim()).arg;
    return focus ? { focus_topic: focus } : {};
  }
  return kind === "canonical" && isNewSessionCommand(line) ? {} : null;
}

/**
 * What a compaction says in the transcript, for the line that asked for it.
 *
 * `/new` and `/reset` in Bot Chat get Hermes Desktop's "This chat never
 * resets" words (`apps/desktop/src/plugins/hermes-bots/plugin.tsx` at
 * v2026.9.24; its last line points at Sessions mode, Hermetic's equivalent is a
 * separate session). `/compact` gets the gateway's own completion line
 * (`tui_gateway/compute_host_bridge.py`). A compaction the gateway did not
 * perform says why either way; `pending` is a compute host still compressing
 * past its wait.
 */
export function compactNotice(line: string, result: CompactResult): string {
  const outcome = result.compressed
    ? null
    : result.status === "pending"
      ? "Compaction is still running on the box; this conversation shows it once it lands."
      : `Compaction: ${result.status ?? "not compressed"}`;
  if (isCompactCommand(line)) return outcome ?? "✓ Context compression complete";
  const notice =
    "This chat never resets. Bot chats are one continuous conversation — compacting instead. " +
    "For a throwaway session with this bot, start a separate session.";
  return outcome ? `${notice}\n\n${outcome}` : notice;
}

const status = (seq: number): ChatFrame => ({
  type: "block",
  seq,
  message: "compact",
  block: {
    kind: "activity",
    category: "notice",
    key: "status:compact",
    title: "Compacting context…",
    state: "running",
    role: "status",
  },
});

/**
 * The turn: the running status (again every `heartbeatMs` while it waits), then
 * the answer as a `command` block — the gateway keeps no copy of it, and a
 * command row outlives the transcript re-read that follows the turn — and
 * `done`. A failed compaction throws, for the caller's error frame. The
 * operator's Stop ends the wait at once and throws the abort.
 */
export async function* compactionFrames(
  line: string,
  compact: () => Promise<CompactResult>,
  signal?: AbortSignal,
  heartbeatMs = COMPACT_HEARTBEAT_MS,
): AsyncGenerator<ChatFrame> {
  const running = compact();
  // Settles on the answer, a failure or the operator's Stop, whichever is first.
  const landed = new Promise<true>((resolve) => {
    running.then(
      () => resolve(true),
      () => resolve(true),
    );
    signal?.addEventListener("abort", () => resolve(true), { once: true });
  });
  let seq = 0;
  for (;;) {
    yield status(seq++);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const beat = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), heartbeatMs);
    });
    const done = await Promise.race([landed, beat]);
    clearTimeout(timer);
    if (done) break;
  }
  signal?.throwIfAborted();
  const result = await running;
  const command = line.trim();
  yield {
    type: "block",
    seq: seq++,
    message: "compact",
    block: { kind: "command", command, output: compactNotice(command, result), state: "done" },
  };
  yield { type: "done", seq, message: "compact" };
}
