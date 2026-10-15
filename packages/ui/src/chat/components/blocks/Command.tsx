/**
 * A slash command's answer from the gateway's command layer (§9.2).
 *
 * Drawn as a mono pane under the command it answers, not as prose: the model
 * never saw the line and did not write the output, and the operator must not
 * read it as the agent speaking. A refusal or an unsupported directive is an
 * alert, so an unknown command is never a quiet no-op.
 */
import type { ChatBlockOf } from "../../../api/index.ts";
import { CodePane } from "../Card.tsx";
import { RedactedText } from "../RedactedText.tsx";

const STATE_LABEL = { done: null, error: "Failed", unsupported: "Not supported here" } as const;

export function CommandBlock({ block }: { block: ChatBlockOf<"command"> }) {
  const label = STATE_LABEL[block.state];
  return (
    <div
      className={`ch-command ${block.state}`}
      role={block.state === "done" ? "note" : "alert"}
      data-chat-command={block.command}
    >
      <div className="ch-command-head">
        <code>
          <RedactedText text={block.command} />
        </code>
        {label ? <span className="kicker">{label}</span> : null}
      </div>
      {block.warning ? (
        <p className="ch-command-warning">
          <RedactedText text={block.warning} />
        </p>
      ) : null}
      {block.output ? <CodePane text={block.output} /> : null}
      {block.prefill ? <CodePane text={block.prefill} /> : null}
    </div>
  );
}
