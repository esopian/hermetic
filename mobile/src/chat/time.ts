/**
 * The stamp beside a message, in the home list's clock format ("4:38 PM",
 * `src/client/home-rows.ts`) so a time reads the same on both screens. Today
 * it is the clock time; before today, `railTime`'s older forms (`Fri`,
 * `Sep 2`). The locale and options are explicit, never the device default.
 */
import { railTime } from "../client/chat-logic.ts";

/** Written as a code point: a literal no-break space is invisible in review. */
const NBSP = String.fromCharCode(0xa0);

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** `4:38 PM` today, `railTime`'s forms before; `—` for a missing or bad stamp. */
export function chatTime(iso: string | null | undefined, now: number): string {
  if (!iso) return "—";
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "—";
  if (!sameDay(then, new Date(now))) return railTime(iso, now);
  // A no-break space before AM/PM, so a wrap never strands it on its own line.
  return then.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(/\s/g, NBSP);
}
