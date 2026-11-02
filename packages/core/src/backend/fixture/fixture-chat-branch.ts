/**
 * The fixture's "Continue as a branch" (`chat.branch`): a new session seeded
 * the way the real adapter seeds one (`branchSeed`, `hermes-chat-branch.ts`),
 * its rows written where the fixture keeps what it was sent, so the next
 * `history`, `observe` or `send` on the new id carries on from them, and the
 * session listed beside the parent's.
 */
import { HermeticError } from "../../errors.ts";
import { branchSeed } from "../../chat/hermes/hermes-chat-branch.ts";
import type {
  BoxAddress,
  ChatBranched,
  ChatBranchRequest,
  HistoryOptions,
} from "../../chat/hermes/hermes-chat-types.ts";
import type { ChatMessage, Session } from "../../schema/index.ts";

export interface FixtureBranchDeps {
  history(box: BoxAddress, bot: string, opts?: HistoryOptions): Promise<ChatMessage[]>;
  /** The parent a branch falls back to when the caller named none. */
  canonicalOf(instance: string, bot: string): string | undefined;
  /** The writable rows of one session, the lane `send` appends to. */
  rows(instance: string, bot: string, session: string): ChatMessage[];
  mint(): string;
  titleOf(session: string): string | undefined;
}

export function createFixtureBranches(deps: FixtureBranchDeps) {
  const made: Session[] = [];

  async function branch(box: BoxAddress, bot: string, input: ChatBranchRequest): Promise<ChatBranched> {
    const parent = input.session ?? deps.canonicalOf(box.instance, bot);
    const seed = parent ? branchSeed(await deps.history(box, bot, { session: parent }), input) : [];
    if (!parent || seed.length === 0)
      throw new HermeticError("VALIDATION", "nothing to branch — send a message first");
    const session = `sx-branch-${made.length + 1}`;
    const rows = deps.rows(box.instance, bot, session);
    for (const [i, m] of seed.entries())
      rows.push({
        id: `${session}:${i}`,
        session,
        role: m.role === "assistant" ? "bot" : "user",
        at: deps.mint(),
        blocks: [{ kind: "text", markdown: m.content }],
        usage: null,
        error: null,
        incomplete: null,
      });
    made.push({
      id: session,
      instance: box.instance,
      bot,
      kind: "thread",
      origin: "hermetic",
      origin_detail: null,
      title: `Branch of ${deps.titleOf(parent) ?? parent}`,
      last_message_at: rows.at(-1)?.at ?? null,
      unread: 0,
      turn_count: seed.filter((m) => m.role === "user").length,
    });
    return { session, parent_session: parent, messages: seed.length };
  }

  const list = (instance: string, bot: string): Session[] =>
    made.filter((s) => s.instance === instance && s.bot === bot).map((s) => ({ ...s }));

  return { branch, list };
}
