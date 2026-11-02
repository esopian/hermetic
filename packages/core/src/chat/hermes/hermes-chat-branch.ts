/**
 * "Continue as a branch": a new session for the same bot, seeded with the
 * parent conversation's visible history and, from a `/btw` card, the side
 * question and its answer.
 *
 * Upstream's `session.create` (`tui_gateway/methods_session.py`) takes
 * `messages` (`_coerce_seed_history`: `{role, content}` with non-blank text)
 * and `parent_session_id`, and with both persists the child row at once
 * (`_seed_branch_row`). Its `session.branch_stored` copies the whole parent
 * server-side, which cannot cut at a snapshot or append a pair, so the seed is
 * built here from the same transcript read `chat.history` makes.
 *
 * The parent is never resumed: the create runs on a socket of its own, so a
 * turn holding the parent's socket keeps it. The new runtime session is closed
 * before that socket is; the stored row is what outlives it.
 */
import { checkAbort } from "../../abort.ts";
import { HermeticError } from "../../errors.ts";
import type { ChatMessage } from "../../schema/chat.ts";
import type { createCanonicalSessions } from "../../render/hermes-canonical.ts";
import type { Rpc } from "./hermes-chat-rpc.ts";
import {
  CHAT_ERROR_CODES,
  type BoxAddress,
  type ChatBranched,
  type ChatBranchRequest,
  type HistoryOptions,
  type SendOptions,
} from "./hermes-chat-types.ts";
import { HERMETIC_SESSION_SOURCE, num, rec, str } from "./hermes-chat-wire.ts";

/** JSON-RPC's "method not found". */
const METHOD_NOT_FOUND = -32601;

const unsupported = () =>
  new HermeticError(CHAT_ERROR_CODES.PROTOCOL, "This gateway cannot seed a branch session");

export interface SeedMessage {
  role: "user" | "assistant";
  content: string;
}

/** A row's visible text: its text blocks, nothing else. */
function textOf(message: ChatMessage): string {
  return message.blocks
    .flatMap((b) => (b.kind === "text" ? [b.markdown] : []))
    .join("\n\n")
    .trim();
}

/** Upstream's `trim_snapshot_for_fork`: a finished assistant reply, no tool calls, no failure. */
function finished(message: ChatMessage): boolean {
  return (
    message.role === "bot" &&
    !message.error &&
    !message.incomplete &&
    !message.blocks.some((b) => b.kind === "tool")
  );
}

/**
 * The seed: user/assistant rows with visible text up to the `until_message`
 * row (when the history has it) and stamped at or before `until`, trimmed back to the last finished assistant reply so a running
 * turn's prompt and steps stay out, then the side question and answer.
 */
export function branchSeed(history: readonly ChatMessage[], input: ChatBranchRequest): SeedMessage[] {
  const cut = input.until ? Date.parse(input.until) : Number.POSITIVE_INFINITY;
  // An id the box's history lacks (a laptop-local row) cuts nothing.
  const last = input.until_message ? history.findIndex((m) => m.id === input.until_message) : -1;
  const kept = (last >= 0 ? history.slice(0, last + 1) : history).filter(
    (m) => (m.role === "user" || m.role === "bot") && Date.parse(m.at) <= cut && textOf(m) !== "",
  );
  while (kept.length > 0 && !finished(kept[kept.length - 1] as ChatMessage)) kept.pop();
  const seed: SeedMessage[] = kept.map((m) => ({
    role: m.role === "bot" ? "assistant" : "user",
    content: textOf(m),
  }));
  if (input.question && input.answer)
    seed.push({ role: "user", content: input.question }, { role: "assistant", content: input.answer });
  return seed;
}

export interface BranchDeps {
  connect(box: BoxAddress, signal: AbortSignal | undefined): Promise<Rpc>;
  conversation: ReturnType<typeof createCanonicalSessions>["conversation"];
  history(box: BoxAddress, bot: string, opts?: HistoryOptions): Promise<ChatMessage[]>;
}

export function createBranches(deps: BranchDeps) {
  async function branch(
    box: BoxAddress,
    bot: string,
    input: ChatBranchRequest,
    opts: SendOptions = {},
  ): Promise<ChatBranched> {
    checkAbort(opts.signal, "chat.branch");
    const parent =
      input.session ?? (await deps.conversation(box, bot, { signal: opts.signal }))?.session;
    const nothing = () => new HermeticError("VALIDATION", "nothing to branch — send a message first");
    if (!parent) throw nothing();
    // The whole transcript, read exactly as `chat.history` reads it.
    const seed = branchSeed(
      await deps.history(box, bot, { session: parent, signal: opts.signal }),
      input,
    );
    if (seed.length === 0) throw nothing();
    const rpc = await deps.connect(box, opts.signal);
    let runtime: string | null = null;
    try {
      let reply: Record<string, unknown> | null;
      try {
        reply = rec(
          await rpc.request(
            "session.create",
            {
              profile: bot,
              source: HERMETIC_SESSION_SOURCE,
              parent_session_id: parent,
              messages: seed,
            },
            undefined,
            { signal: opts.signal },
          ),
        );
      } catch (e) {
        if (e instanceof HermeticError && e.details?.code === METHOD_NOT_FOUND) throw unsupported();
        throw e;
      }
      runtime = str(reply?.session_id);
      const stored = str(reply?.stored_session_id);
      // An older gateway ignores `messages` and makes an empty, unpersisted draft.
      const count = num(reply?.message_count);
      if (!count) throw unsupported();
      if (!stored)
        throw new HermeticError(
          CHAT_ERROR_CODES.PROTOCOL,
          `${box.instance}: session.create named no stored session`,
        );
      return { session: stored, parent_session: parent, messages: count };
    } finally {
      // The row is persisted at create; the runtime session would only idle until reaped.
      if (runtime) await rpc.request("session.close", { session_id: runtime }).catch(() => undefined);
      rpc.close();
    }
  }
  return { branch };
}
