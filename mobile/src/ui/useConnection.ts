/**
 * Home's connection steps, per listened instance, on a clock: what each
 * instance header draws right now (`src/client/connection.ts`). The clock
 * ticks only while something is being waited on or the `connected` beat is
 * up, so a settled home does not re-render four times a second.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CONNECT_GRACE_MS,
  CONNECTED_BEAT_MS,
  type ConnectionAttempt,
  type ConnectionShown,
  connectionStep,
  shownStep,
} from "../client/connection.ts";
import type { TailscaleProbe } from "../gateway/tailscale.ts";

const TICK_MS = 250;

export function useConnection(input: {
  attempt: ConnectionAttempt | null;
  probe: TailscaleProbe | null;
  instances: readonly string[];
  answeredAt: Readonly<Record<string, number>>;
}): ReadonlyMap<string, ConnectionShown> {
  const { attempt, probe, instances, answeredAt } = input;
  const [now, setNow] = useState(() => Date.now());
  // When the path first showed for each instance, this attempt.
  const since = useRef<{ attempt: ConnectionAttempt | null; at: Map<string, number> }>({
    attempt: null,
    at: new Map(),
  });
  if (since.current.attempt !== attempt) since.current = { attempt, at: new Map() };

  const shown = useMemo(() => {
    const out = new Map<string, ConnectionShown>();
    if (!attempt) return out;
    for (const instance of instances) {
      const answered = answeredAt[instance] ?? null;
      const step = connectionStep({ attempt, now, probe, answeredAt: answered });
      const shownSince = since.current.at.get(instance) ?? null;
      const value = shownStep({ step, attempt, now, shownSince, answeredAt: answered });
      if (value !== null && value !== "connected" && shownSince === null)
        since.current.at.set(instance, now);
      out.set(instance, value);
    }
    return out;
  }, [attempt, probe, instances, answeredAt, now]);

  // Tick while inside the grace with something unanswered, or while a beat is up.
  const live =
    !!attempt &&
    ([...shown.values()].some((s) => s === "waking" || s === "reaching" || s === "connected") ||
      (now - attempt.startedAt < CONNECT_GRACE_MS + CONNECTED_BEAT_MS &&
        instances.some((i) => (answeredAt[i] ?? 0) < attempt.startedAt)));
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [live]);
  // A new attempt or answer is read at once, not on the next tick.
  useEffect(() => setNow(Date.now()), [attempt, probe, answeredAt]);

  return shown;
}
