/**
 * The one typed-confirmation control: an input, a live verdict under it, and a
 * `matches` boolean the caller gates its destructive button on.
 *
 * Three drawers hand-rolled this — the volume delete, the foundation teardown
 * (twice) and the agent destroy — and the three had drifted: different classes,
 * different disabled opacities, and the agent one had no live feedback at all,
 * so the only way to learn you had mistyped a name was that the button stayed
 * grey. The ceremony is deliberate (§ `confirm.ts` in the CLI has the same
 * escalation), so it should read the same everywhere it appears.
 *
 * Matching is exact after trimming: this is a value copied off the screen
 * above, not a search.
 */
import type { ReactNode } from "react";

/** The comparison itself, so a caller can gate a submit on it without a ref. */
export function confirmMatches(typed: string, expected: string): boolean {
  return typed.trim() === expected && expected !== "";
}

export function TypedConfirm({
  label,
  expected,
  value,
  onChange,
  onSubmit,
  hint,
  matches: matchesProp,
  matchLabel = "matches",
  placeholder,
  autoFocus,
  inputMode,
  ariaLabel,
  sanitize,
}: {
  /** The kicker above the box: "Type the volume id to confirm". */
  label: ReactNode;
  /**
   * What the typed value has to equal, exactly. Ignored when `matches` is
   * given — some fields are stricter than equality (the teardown account id
   * must also be twelve digits) and the verdict line must be decided by the
   * *same* function that decides whether the button is live, or the two drift
   * and the box says "matches" over a disabled button.
   */
  expected: string;
  /** The stricter rule, when there is one. Shared with the caller's submit gate. */
  matches?: (typed: string) => boolean;
  value: string;
  onChange: (v: string) => void;
  /** Enter, when there is a single obvious action behind this box. */
  onSubmit?: () => void;
  /** What the verdict line says while it does not match yet. */
  hint: string;
  matchLabel?: string;
  placeholder?: string;
  autoFocus?: boolean;
  inputMode?: "numeric" | "text";
  ariaLabel?: string;
  /** e.g. digits-only for an account id; applied on every keystroke. */
  sanitize?: (v: string) => string;
}) {
  const matches = matchesProp ? matchesProp(value) : confirmMatches(value, expected);
  return (
    <label className="wiz-field">
      <div className="kicker">{label}</div>
      <input
        className="name-input"
        type="text"
        autoComplete="off"
        spellCheck={false}
        data-autofocus={autoFocus || undefined}
        inputMode={inputMode}
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(sanitize ? sanitize(e.target.value) : e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && onSubmit) onSubmit();
        }}
      />
      <div
        className={matches ? "name-hint td-hint-ok" : "name-hint td-hint"}
        role="status"
        aria-live="polite"
      >
        {matches ? matchLabel : hint}
      </div>
    </label>
  );
}
