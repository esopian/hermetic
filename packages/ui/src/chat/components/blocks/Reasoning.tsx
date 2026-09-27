/**
 * `reasoning` — the model's own working.
 *
 * `muted`, which by the collapse rule means it opens shut. That is the right
 * default and not a slight: reasoning is the largest thing in a transcript and
 * the least often wanted, and a transcript that opens with two thousand tokens
 * of it above the answer is a transcript nobody scrolls.
 *
 * The head carries what it cost — `thought for 11.8s · 2,140 tokens` — because
 * that is the part that is worth seeing without opening it.
 */
import { RedactedText } from "../RedactedText.tsx";
import type { ChatBlockOf } from "../../../api/index.ts";
import { fmtMs } from "../../chat-logic.ts";
import { Card, CardBody } from "../Card.tsx";

export function ReasoningBlock({ block }: { block: ChatBlockOf<"reasoning"> }) {
  const cost = [
    block.duration_ms ? `thought for ${fmtMs(block.duration_ms)}` : null,
    block.tokens ? `${block.tokens.toLocaleString()} tokens` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Card verdict="muted" head="Reasoning" right={cost || "live"}>
      <CardBody>
        <div className="ch-think">
          <RedactedText text={block.text} />
        </div>
      </CardBody>
    </Card>
  );
}
