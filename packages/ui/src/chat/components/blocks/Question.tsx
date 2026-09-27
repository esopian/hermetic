import { RequestActions } from "../BotResponses.tsx";
/**
 * `question` — the agent asks you something.
 *
 * Choices, not free text, and the distinction is the block's whole reason for
 * existing: a bot that needs a decision from an unattended operator gets a
 * decision it can act on, not a sentence it has to parse. The turn is paused
 * while this is on screen, which the head says.
 *
 * Like the approval card, the choices are drawn and inert. Answering one is
 * `chat.respond` and lands in Phase 10; an enabled button that silently did
 * nothing would be worse than a disabled one that says why.
 */
import { RedactedText } from "../RedactedText.tsx";
import type { ChatBlockOf } from "../../../api/index.ts";

export function QuestionBlock({ block }: { block: ChatBlockOf<"question"> }) {
  return (
    <div className="ch-card acc">
      <div className="ch-card-head">
        <span>question</span>
        <span className="right">turn paused</span>
      </div>
      <div className="ch-card-body">
        <p>
          <RedactedText text={block.prompt} />
        </p>
        <RequestActions block={block} />
      </div>
    </div>
  );
}
