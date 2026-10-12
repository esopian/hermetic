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
 * Answering it is `chat.respond`, through `RequestActions` (`ApprovalActions.tsx`),
 * which draws only the choices the gateway offered. Without a way to respond
 * from here (no provider, or a request with no id) the card states where the
 * decision is made rather than offering a control that would silently fail.
 * Closed by the box, it stays to say the command was not run.
 */
import { RedactedText } from "../RedactedText.tsx";
import type { ChatBlockOf } from "../../../api/index.ts";
import { railTime } from "../../chat-logic.ts";
import type { ClosedRequest } from "../../chat-requests.ts";
import { RequestActions } from "../ApprovalActions.tsx";

export function ApprovalBlock({
  block,
  now,
  closed,
  pending,
}: {
  block: ChatBlockOf<"approval">;
  now: number;
  closed?: ClosedRequest;
  pending?: number;
}) {
  return (
    <div className="ch-approve">
      <div className="ch-card-head">
        <span>⚑ Approval required</span>
        {block.expires_at && !closed ? (
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
        <RequestActions block={block} closed={closed} pending={pending} now={now} />
      </div>
    </div>
  );
}
