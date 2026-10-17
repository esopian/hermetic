/** A clock that re-renders every `ms` (30 s by default), so relative times move. */
import { useEffect, useState } from "react";

export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}
