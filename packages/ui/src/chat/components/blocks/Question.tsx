/**
 * `question` — the agent asks you something.
 *
 * One card per clarify request, however many questions it carries: the
 * gateway holds the turn until every question has an answer, so a batch is
 * answered as one form and confirmed once (`QuestionCard`). The card draws its
 * own head, because "turn paused" is true only while the form can still answer
 * the request. Without a way to respond from here (no provider, or a request
 * with no id) the questions and their choices are drawn disabled, with a note
 * saying where to answer; a question with no id whose answers were recorded is
 * a clarify read back from history, and reads as settled.
 */
import type { ChatBlockOf } from "../../../api/index.ts";
import { QuestionCard } from "../BotResponses.tsx";

export function QuestionBlock({ block, now }: { block: ChatBlockOf<"question">; now?: number }) {
  return <QuestionCard block={block} now={now} />;
}
