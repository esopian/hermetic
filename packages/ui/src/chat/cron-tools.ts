/**
 * Cron tool calls in a chat turn, as the Scheduled jobs rail needs to see them.
 *
 * A job created or changed by the bot itself, through its `cronjob` tool,
 * reaches the routine registry without passing through the rail — so the rail
 * watches the turn in flight for a cron call finishing and re-reads then. Only
 * the cron tools: any other tool finishing says nothing about the registry, and
 * a re-read on every tool call would be one `routines.list` per step of a long
 * turn.
 */
import { useEffect, useRef } from "react";
import type { ChatMessageView } from "../api/index.ts";

/** Hermes' cron tools, by the name a `tool` block carries. */
export const CRON_TOOL_NAMES: ReadonlySet<string> = new Set(["cronjob", "cronjob_manage"]);

/**
 * The keys of the cron calls in `message` that have finished, whatever their
 * verdict — a failed call may still have written half a job.
 *
 * Keyed by `tool_id`, else by position in the message: a running call and its
 * completion replace one another in place (`chat-state.tsx`, `toolKey`), so the
 * position of a call does not move while its turn is live.
 */
export function finishedCronCalls(message: ChatMessageView | null | undefined): string[] {
  if (!message) return [];
  const keys: string[] = [];
  message.blocks.forEach((block, index) => {
    if (block.kind !== "tool" || !CRON_TOOL_NAMES.has(block.name)) return;
    if (block.status === "running") return;
    keys.push(block.tool_id ? `id:${block.tool_id}` : `${message.id}:${index}`);
  });
  return keys;
}

/**
 * Call `onFinished` once for each cron call that finishes in `live`.
 *
 * Only calls seen in the live turn count; the transcript is not watched, so a
 * history read that brings back last week's cron calls re-reads nothing.
 */
export function useCronCallFinished(
  live: ChatMessageView | null | undefined,
  onFinished: () => void,
): void {
  const seen = useRef(new Set<string>());
  const callback = useRef(onFinished);
  callback.current = onFinished;
  useEffect(() => {
    let fresh = false;
    for (const key of finishedCronCalls(live)) {
      if (seen.current.has(key)) continue;
      seen.current.add(key);
      fresh = true;
    }
    if (fresh) callback.current();
  }, [live]);
}
