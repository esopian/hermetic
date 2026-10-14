/**
 * Pull-to-refresh state with a floor on how long the spinner shows.
 *
 * A read on the tailnet can answer within a frame or two of the
 * release. Ending the refresh while the list is still settling from the pull
 * made iOS snap the content back under the still-visible spinner, which then
 * sat over the first row. Holding `refreshing` for
 * `MIN_REFRESH_MS` lets the list settle under the spinner first, so the end of
 * the refresh is one clean animation.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export const MIN_REFRESH_MS = 600;

export function usePullRefresh(
  read: (() => Promise<unknown>) | null,
  minMs = MIN_REFRESH_MS,
): { refreshing: boolean; onRefresh: () => void } {
  const [refreshing, setRefreshing] = useState(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const onRefresh = useCallback(() => {
    if (!read) return;
    setRefreshing(true);
    const floor = new Promise<void>((resolve) => setTimeout(resolve, minMs));
    void Promise.all([read().catch(() => {}), floor]).then(() => {
      if (live.current) setRefreshing(false);
    });
  }, [read, minMs]);
  return { refreshing, onRefresh };
}
