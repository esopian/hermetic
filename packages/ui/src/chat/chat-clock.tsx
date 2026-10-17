/**
 * The transcript clock, read where it is drawn.
 *
 * The chat store ticks `now` every 30 s (`chat-state.tsx`). Handed down as a
 * prop, that tick re-rendered every message of every open transcript, although
 * almost nothing in a message depends on it: a message's own stamp is a clock
 * time (`fmtClock`), and only a request card still waiting on the operator
 * reads expiry against the moving clock. So the clock is a context, and only
 * the leaves that draw a relative time — and a message with an open request —
 * read it. Everything else sits out the tick.
 *
 * `released` rides beside it for the same reason: it is read only by a message
 * that has a request still open, and passing it through the whole chat store
 * made every message re-render on every change to that store.
 */
import { createContext, useContext } from "react";
import { threadTime } from "./chat-logic.ts";

/** The transcript clock in epoch ms; `null` where no thread provides one. */
export const ClockContext = createContext<number | null>(null);

/**
 * The request ids the operator answered from their own card (`Chat.released`),
 * for the messages that still draw an open request.
 */
export const ReleasedContext = createContext<ReadonlySet<string> | null>(null);

/** The transcript clock, or the wall clock where no thread provides one. */
export function useClock(): number {
  return useContext(ClockContext) ?? Date.now();
}

/**
 * The stamp beside a message or event in a transcript (`threadTime`), drawn
 * against the transcript clock. A leaf, so the tick re-renders the stamp and
 * not the row around it.
 */
export function ThreadTime({ at }: { at: string | null | undefined }) {
  return <>{threadTime(at, useClock())}</>;
}

/**
 * Local midnight on the day `now` falls in. Day dividers depend on the clock
 * only through the date, so a transcript keyed on this re-groups once a day
 * rather than once per tick.
 */
export function startOfDay(now: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}
