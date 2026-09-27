/**
 * How a closed Bot Mode gate reads.
 *
 * Three different closures, three different sentences and two different offers.
 * A refusal is the gateway's settled answer, so it is stated and left alone; an
 * undetermined probe is the portal admitting it does not know, so it is stated
 * as such and comes with a retry, the same `btn-secondary btn-mini` refresh the
 * model picker already uses. A feature Hermetic gates on purpose is neither, and
 * says so in its own words rather than borrowing the gateway's.
 *
 * Nothing here introduces a visual language: `bm-note`/`bm-error` are the
 * existing Bot Mode notes and `.bm-gate` only groups them.
 */
import type { CapabilityGate } from "../bot-capabilities.ts";

/**
 * One sentence carrying the whole reason, for a control that cannot show prose.
 *
 * A disabled button is not reachable by keyboard and its `title` is not reliably
 * announced, so the reason also goes in `aria-label` — the pattern `ListenButton`
 * already uses, where the label says what the control is for and the title
 * repeats it for a pointer.
 */
export function gateReason(gate: CapabilityGate): string {
  return gate.detail === null ? gate.headline : `${gate.headline}. ${gate.detail}`;
}

/**
 * The props a gated control needs so its refusal is not purely visual. Spread
 * onto a `<button>`: `aria-disabled` keeps the reason announceable even where a
 * `disabled` node is skipped, and the label carries it.
 */
export function gateControl(gate: CapabilityGate, action: string) {
  if (gate.allowed) return { disabled: false };
  const reason = gateReason(gate);
  return {
    disabled: true,
    "aria-disabled": true,
    "aria-label": `${action} — unavailable. ${reason}`,
    title: reason,
  } as const;
}

export function CapabilityNote({ gate, onRetry }: { gate: CapabilityGate; onRetry: () => void }) {
  if (gate.allowed) return null;
  if (gate.verdict === "reading") return <p className="bm-note">{gate.headline}</p>;
  return (
    <div
      className={`bm-gate${gate.retryable ? " undetermined" : ""}`}
      // Undetermined and unreadable both land here after an async probe, so they
      // are announced; a refusal is part of the pane as rendered and is not.
      {...(gate.retryable ? { role: "status" } : {})}
    >
      <b>{gate.headline}</b>
      {gate.detail === null ? null : <p className="bm-note">{gate.detail}</p>}
      {gate.retryable ? (
        <button type="button" className="btn btn-secondary btn-mini" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

/**
 * A feature this repo holds back. Deliberately not a `CapabilityGate`: it never
 * has a status, never reads as a gateway verdict and never offers a retry.
 */
export function GatedNote({ children }: { children: string }) {
  return (
    <p className="bm-note bm-gated">
      <b>Gated in Hermetic</b> · {children}
    </p>
  );
}
