/**
 * A memory choice's resource card: its one-line summary, a wrapping row of
 * resource chips, the estimates caveat, and — given a fit — whether the box it
 * is for can run it, with a one-click way to the smallest size that can.
 *
 * One component for every place a memory choice is drawn: the create drawer's
 * Memory field and the agent drawer's memory chooser (each under its select,
 * `variant="attached"`), and the radio rows of Settings › Defaults, which reuse
 * the chip row (`MemoryResourceChips`) and the note (`MemoryEstimateNote`) on
 * their own.
 * Every figure comes from core's `memoryResourceFacts` (via
 * `memoryResourceChips`), so the CLI's help says the same thing.
 *
 * Styles: `styles/memory.css` (`.mem-*`).
 */
import { MEMORY_RESOURCE_ESTIMATE_NOTE } from "@hermetic/core/shared";
import type { Provider, SizeId } from "@hermetic/core/shared";
import { memoryChoiceText, memoryResourceChips } from "../logic/memory-logic.ts";
import type { MemoryChoice, MemoryFitResult } from "../logic/memory-logic.ts";

/**
 * The resource chips for one choice, `Label: value` each, wrapping. `vendor`
 * makes an embeddings answer that depends on it the effective one.
 */
export function MemoryResourceChips({
  choice,
  vendor,
  compact = false,
}: {
  choice: MemoryChoice;
  vendor?: Provider | null;
  /** Tighter chips, for a list of several choices. */
  compact?: boolean;
}) {
  return (
    <ul
      className={compact ? "mem-chips mem-chips-compact" : "mem-chips"}
      aria-label="Resource estimates"
      title={MEMORY_RESOURCE_ESTIMATE_NOTE}
    >
      {memoryResourceChips(choice, vendor).map((f) => (
        <li key={f.key} className="mem-chip" data-fact={f.key}>
          <span className="mem-chip-k">{f.label}:</span> {f.value}
        </li>
      ))}
    </ul>
  );
}

/** The caveat under the chips: the figures are estimates, only the RAM floor is a rule. */
export function MemoryEstimateNote() {
  return <div className="mem-est">{MEMORY_RESOURCE_ESTIMATE_NOTE}</div>;
}

export interface MemoryProviderCardProps {
  choice: MemoryChoice;
  /** The agent's vendor, when known (`memoryResourceChips`). */
  vendor?: Provider | null;
  /**
   * `memoryFit`'s answer for the box this choice is for. `undersized` and
   * `vendor-blocked` draw an amber line with the message; anything else, or
   * none, draws nothing.
   */
  fit?: MemoryFitResult | null;
  /**
   * Offered as `Switch to <size> →` on an undersized fit with a `switchTo`.
   * It should be the same setter the size picker uses, so the size reads as
   * the operator's own choice.
   */
  onSwitchSize?: (size: SizeId) => void;
  /**
   * `attached` joins the card to the control above it (no top border);
   * `plain` is a box of its own.
   */
  variant?: "attached" | "plain";
  /** Draw the choice's label as a heading (a standalone card, not under a select naming it). */
  showLabel?: boolean;
  /**
   * The id of the fit message, for the control's `aria-describedby`. The
   * message element is always rendered (a live `status` region, empty while
   * the choice fits) so a change is announced. The control it names is where
   * focus goes when `Switch to …` removes itself.
   */
  fitId?: string;
}

export function MemoryProviderCard({
  choice,
  vendor,
  fit,
  onSwitchSize,
  variant = "plain",
  showLabel = false,
  fitId,
}: MemoryProviderCardProps) {
  const text = memoryChoiceText(choice);
  const warn =
    fit !== null &&
    fit !== undefined &&
    fit.message !== null &&
    (fit.state === "undersized" || fit.state === "vendor-blocked");
  const switchTo = warn && fit.state === "undersized" ? fit.switchTo : null;
  return (
    <div
      className={variant === "attached" ? "mem-card mem-card-attached" : "mem-card"}
      data-memory-card={choice}
    >
      {showLabel ? <div className="mem-card-label">{text.label}</div> : null}
      <p className="mem-card-sum">{text.summary}</p>
      <MemoryResourceChips choice={choice} vendor={vendor} />
      <MemoryEstimateNote />
      <div className={warn ? "mem-fit mem-fit-warn" : "mem-fit"} data-fit={fit?.state ?? "none"}>
        <span className="mem-fit-msg" role="status" id={fitId}>
          {warn ? fit.message : ""}
        </span>
        {switchTo !== null && onSwitchSize !== undefined ? (
          <button
            type="button"
            className="mem-switch"
            onClick={(e) => {
              // The button leaves with the warning it answers. Hand focus to the
              // control this card describes first, or the drawer's focus trap
              // recovers it to its first field, far above the Memory row.
              const control =
                fitId === undefined
                  ? null
                  : e.currentTarget.ownerDocument.querySelector<HTMLElement>(
                      `[aria-describedby~="${fitId}"]`,
                    );
              onSwitchSize(switchTo);
              control?.focus({ preventScroll: true });
            }}
          >
            Switch to {switchTo} →
          </button>
        ) : null}
      </div>
    </div>
  );
}
