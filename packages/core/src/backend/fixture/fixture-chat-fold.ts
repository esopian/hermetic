/**
 * A fixture turn folded into the row a box would hold for it.
 *
 * Both halves of the fixture chat stack write transcripts from the frames a turn
 * streams (`fixture-chat.ts`'s own rows, `fixture-bot-mode.ts`'s owned ones), and
 * the folding rule is one rule, so it lives here: deltas land in the text block
 * they were opened against, a tool's completion replaces the row that announced
 * it running, and what a box never writes down stays out.
 *
 * That last part is the point of the module. A parked request (a clarify
 * question or an approval) is a live card: once the gateway resolves it, the
 * box's history holds the tool call and its result, not the card, and Hermes
 * Desktop rebuilds the settled summary from that result. So the parked block is
 * not persisted, the `clarify` tool's JSON result goes through the same
 * `settledClarify` a real box's history does, and the "Request closed" notice a
 * `request.cancel` becomes is not persisted either.
 */
import { settledClarify } from "../../chat/hermes/hermes-chat-history.ts";
import type { ChatBlock } from "../../schema/index.ts";

export interface FixtureTurnRow {
  /** The row's blocks so far. Mutated in place, so a holder may keep the array. */
  blocks: ChatBlock[];
  /**
   * True once something went by that the flat text-only row would lose: a
   * parked request (the turn had a human in its loop) or a delegation (a
   * `subagent` block or a `delegate_task` call). Such a turn is stored with its
   * blocks; an ordinary one is stored flat, as the wrapper always has.
   */
  full: boolean;
  fold(block: ChatBlock): void;
  delta(text: string): void;
}

const json = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
};

export function createFixtureTurnRow(): FixtureTurnRow {
  const blocks: ChatBlock[] = [];
  const row: FixtureTurnRow = {
    blocks,
    full: false,
    fold(block) {
      // A status activity block is the client saying what it is doing, not
      // something the box wrote down. The reconnect card is the only one the
      // fixture mints, and folding it in would make the durable row depend on
      // whether the socket happened to survive the turn.
      if (block.kind === "activity" && block.role === "status") return;
      // `todo.updated` is an event; the list lives in the `todo_list` call's result.
      if (block.kind === "activity" && block.key === "tasks") return;
      // The gateway's withdrawal of a request is an event, not a row.
      if (block.kind === "activity" && block.key.startsWith("request:")) return;
      // A parked request. Its answer lives in the tool's result.
      if (block.kind === "approval" || (block.kind === "question" && block.request_id)) {
        row.full = true;
        return;
      }
      if (block.kind === "subagent" || (block.kind === "tool" && block.name === "delegate_task"))
        row.full = true;
      // A file or secret request card is read back from history (attachments
      // plan §8.3): a late delivery is answered from it after the turn ended.
      if (
        block.kind === "tool" &&
        (block.render === "file_request" || block.render === "secret_request")
      )
        row.full = true;
      // A shared file's card and chip are read back from history too: the
      // download is offered after the turn ended.
      if (
        (block.kind === "tool" && block.render === "file_share") ||
        (block.kind === "attachment" && block.href.startsWith("outbox/"))
      )
        row.full = true;
      // A background process's notice and a bot-to-bot DM are rows of their
      // own in a real transcript, never flattened into the reply's text
      // (`fixture-chat-demo.ts` raises both live).
      if (block.kind === "process_event" || (block.kind === "tool" && block.render === "message_agent"))
        row.full = true;
      if (block.kind === "tool" && block.todos) row.full = true;
      if (block.kind === "tool") {
        const found = blocks.findIndex((b) => b.kind === "tool" && b.tool_id === block.tool_id);
        const at = found >= 0 ? found : blocks.length;
        blocks[at] = { ...block };
        if (block.name === "clarify" && block.status === "ok") {
          const settled = settledClarify(block.args, json(block.result));
          if (settled) blocks.splice(at + 1, 0, settled);
        }
        return;
      }
      blocks.push({ ...block });
    },
    delta(text) {
      const last = blocks.at(-1);
      if (last?.kind === "text") last.markdown += text;
    },
  };
  return row;
}
