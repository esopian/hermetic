/** Observed turn work is independent of whether a Hermes backend is warm. */
import type { ChatFrameView } from "../api/index.ts";

export type TurnActivity = "idle" | "thinking" | "streaming";
export interface ConversationActivity {
  instance: string;
  bot: string;
  session: string | null;
  activity: TurnActivity;
}

/** Only meaningful accepted frames change phase; asynchronous snapshots do not. */
export function nextTurnActivity(current: TurnActivity, frame: ChatFrameView): TurnActivity {
  if (frame.type === "done" || frame.type === "error") return "idle";
  if (frame.type === "delta") return frame.text.trim() ? "streaming" : current;
  const block = frame.block;
  if (block.kind === "text") return block.markdown.trim() ? "streaming" : current;
  if (block.kind === "tool" || block.kind === "reasoning") return "thinking";
  if (block.kind === "approval" || block.kind === "question") return "idle";
  if (block.kind === "activity") {
    if (block.category === "generation" && block.state === "running") return "thinking";
    if (block.request_id && block.state === "done") return "thinking";
  }
  return current;
}

/** Concurrent output outranks thinking; a finished sibling cannot idle an active owner. */
export function activityFor(
  turns: readonly ConversationActivity[],
  instance: string,
  bot?: string,
): TurnActivity {
  let activity: TurnActivity = "idle";
  for (const turn of turns) {
    if (turn.instance !== instance || (bot !== undefined && turn.bot !== bot)) continue;
    if (turn.activity === "streaming") return "streaming";
    if (turn.activity === "thinking") activity = "thinking";
  }
  return activity;
}
