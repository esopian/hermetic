/**
 * Re-render once at `at` (epoch ms), so something that lapses with no event
 * after it — a server request's `expires_at` — stops being drawn as live on
 * time. One timer per caller, re-armed when `at` moves, cleared on unmount.
 */
import { useEffect, useState } from "react";

export function useWakeAt(at: number | null): void {
  const [, wake] = useState(0);
  useEffect(() => {
    if (at === null) return;
    // One past the moment, so the render it causes reads it as passed.
    const timer = setTimeout(() => wake((n) => n + 1), Math.max(0, at - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [at]);
}
