/** Future events remain inspectable without opening a large payload in the conversation. */
import type { ChatBlockView } from "../../../api/index.ts";
import { formatPayload, unknownName, unknownPayload } from "../../chat-logic.ts";
import type { BlockLike } from "../../chat-logic.ts";
import { CodePane } from "../Card.tsx";
import { RedactedText } from "../RedactedText.tsx";

export function UnknownBlock({ block }: { block: ChatBlockView }) {
  const payload = unknownPayload(block as unknown as BlockLike);
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  const args = record && "args" in record ? record["args"] : undefined;
  const result = record && "result" in record ? record["result"] : undefined;
  return (
    <details className="ch-event">
      <summary>
        <span>Additional activity</span>
        <code>
          <RedactedText text={unknownName(block)} />
        </code>
      </summary>
      <div className="ch-activity-detail">
        {args !== undefined || result !== undefined ? (
          <>
            <div className="kicker">Arguments</div>
            <CodePane text={formatPayload(args)} />
            <div className="kicker">Result</div>
            <CodePane text={formatPayload(result)} />
          </>
        ) : (
          <CodePane text={formatPayload(payload)} />
        )}
      </div>
    </details>
  );
}
