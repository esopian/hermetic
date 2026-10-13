/**
 * The composer footer's context-window meter: a small ring and a percentage.
 *
 * Neutral below the warn line, then warn, then bad (`contextLevel`). The exact
 * figures are the tooltip and the accessible name. With no figure from the
 * gateway the composer does not mount it at all.
 */
import { contextDetail, contextLabel, contextLevel } from "../context-usage.ts";
import type { ContextUsage } from "../context-usage.ts";

const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function ContextMeter({ usage }: { usage: ContextUsage }) {
  const level = contextLevel(usage.percent);
  const detail = contextDetail(usage);
  const filled = (Math.min(100, usage.percent) / 100) * CIRCUMFERENCE;
  return (
    <span
      className={`ch-window ${level}`}
      data-level={level}
      data-tip={detail}
      role="meter"
      aria-label={detail}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={usage.percent}
      aria-valuetext={detail}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <circle className="track" cx="8" cy="8" r={RADIUS} />
        <circle
          className="arc"
          cx="8"
          cy="8"
          r={RADIUS}
          strokeDasharray={`${filled} ${CIRCUMFERENCE}`}
          transform="rotate(-90 8 8)"
        />
      </svg>
      <span aria-hidden="true">{contextLabel(usage)}</span>
    </span>
  );
}
