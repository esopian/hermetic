/**
 * The Scheduled jobs rail re-reads the routine registry when a cron tool call
 * finishes in the turn in flight (`finishedCronCalls`, `@hermetic/core/shared`).
 */
import { finishedCronCalls } from "@hermetic/core/shared";
import { useEffect, useRef } from "react";
import type { ChatMessageView } from "../api/index.ts";

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
