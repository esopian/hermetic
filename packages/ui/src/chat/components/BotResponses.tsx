import { createContext, useContext, useState } from "react";
import type { ChatBlockOf } from "../../api/index.ts";
export type Decision = {
  request_id: string;
  kind: "approval" | "question";
  choice?: "once" | "session" | "always" | "deny";
  answer?: string;
  question_id?: string;
};
export const BotResponses = createContext<((decision: Decision) => Promise<unknown>) | null>(null);
export function RequestActions({
  block,
}: {
  block: ChatBlockOf<"approval"> | ChatBlockOf<"question">;
}) {
  const respond = useContext(BotResponses),
    [state, setState] = useState(""),
    [busy, setBusy] = useState(false),
    [answer, setAnswer] = useState("");
  const expired = !!block.expires_at && Date.parse(block.expires_at) < Date.now();
  if (!respond || !block.request_id)
    return block.kind === "question" ? (
      <>
        <div className="ch-prompts">
          {block.choices.map((choice, index) => (
            <button type="button" className="ch-prompt" disabled key={`${index}-${choice}`}>
              {choice}
            </button>
          ))}
        </div>
        <p className="bm-note">Respond in Hermes. Choices are shown here for reference.</p>
      </>
    ) : (
      <p className="bm-note">Respond in Hermes. This conversation is waiting for your approval.</p>
    );
  async function submit(value: string) {
    if (busy || expired) return;
    setBusy(true);
    setState("");
    try {
      const payload =
        block.payload && typeof block.payload === "object"
          ? (block.payload as Record<string, unknown>)
          : {};
      const q =
        payload.question && typeof payload.question === "object"
          ? (payload.question as Record<string, unknown>)
          : payload;
      const result = await respond!({
        request_id: block.request_id!,
        kind: block.kind,
        ...(block.kind === "approval"
          ? { choice: value as Decision["choice"] }
          : { answer: value, ...(typeof q.qid === "string" ? { question_id: q.qid } : {}) }),
      });
      setState(
        result && typeof result === "object" && "status" in result && result.status === "expired"
          ? "Already answered or expired."
          : "Response sent.",
      );
    } catch (e) {
      setState(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  if (state === "Response sent." || state === "Already answered or expired.")
    return <p role="status">{state}</p>;
  return (
    <div className="bm-request-actions">
      {expired ? (
        <p>Request expired.</p>
      ) : block.kind === "approval" ? (
        <div className="ch-prompts">
          {(
            [
              ["once", "Approve once"],
              ["session", "This session"],
              ["always", "Always allow"],
              ["deny", "Deny"],
            ] as const
          ).map(([value, label]) => (
            <button
              className="btn btn-secondary"
              type="button"
              disabled={busy}
              key={value}
              onClick={() => void submit(value)}
            >
              {label}
            </button>
          ))}
        </div>
      ) : (
        <>
          <div className="ch-prompts">
            {block.choices.map((choice, index) => (
              <button
                className="ch-prompt"
                type="button"
                disabled={busy}
                key={`${index}-${choice}`}
                onClick={() => void submit(choice)}
              >
                {choice}
              </button>
            ))}
          </div>
          <div className="bm-answer">
            <input
              className="wiz-input"
              aria-label="Your answer"
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
            />
            <button
              className="btn btn-secondary"
              type="button"
              disabled={busy || !answer.trim()}
              onClick={() => void submit(answer)}
            >
              Answer
            </button>
          </div>
        </>
      )}
      {state ? (
        <p role="alert" className="bm-error">
          {state}
        </p>
      ) : null}
    </div>
  );
}
