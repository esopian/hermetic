import { RequestActions } from "../BotResponses.tsx";
/**
 * `approval` — the agent has stopped and is waiting on you.
 *
 * The one card in the transcript that is never softened and never collapsed.
 * It blocks a turn and holds one of the box's ~3 warm backend slots while it
 * waits, so an operator who scrolls past it has not merely missed a message —
 * they have left a machine parked. It is deliberately the loudest thing on
 * screen, and it does not obey the collapse rule because there is no verdict
 * yet: nothing has happened, which is the problem.
 *
 * The buttons are drawn and do nothing yet. Answering an approval is
 * `chat.respond`, which is Phase 10 and waits on a live re-probe of upstream's
 * framing (§8.2) — so this renders the decision and states where it is made,
 * rather than offering a control that would silently fail.
 */
import { RedactedText } from "../RedactedText.tsx";
import type { ChatBlockOf } from "../../../api/index.ts";
import { railTime } from "../../chat-logic.ts";

export function ApprovalBlock({ block, now }: { block: ChatBlockOf<"approval">; now: number }) {
  return (
    <div className="ch-approve">
      <div className="ch-card-head">
        <span>⚑ Approval required</span>
        {block.expires_at ? (
          <span className="right">{`expires ${railTime(block.expires_at, now)}`}</span>
        ) : null}
      </div>
      <div className="ch-card-body">
        <b>
          <RedactedText text={block.tool} />
        </b>
        <div className="mono">
          <RedactedText text={block.summary} />
        </div>
        {block.detail ? (
          <pre className="ch-code">
            <RedactedText text={block.detail} />
          </pre>
        ) : null}
      </div>
      <div className="ch-approve-foot">
        <RequestActions block={block} />
      </div>
    </div>
  );
}
