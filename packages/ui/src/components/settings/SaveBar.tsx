/**
 * The bar a fleet-wide Settings form saves through.
 *
 * It appears when a form is dirty and not before, because these are fleet-wide
 * writes: nothing here saves on blur, so an operator who tabs through a field
 * and leaves has changed nothing on anybody else's laptop. It counts the staged
 * fields and names them, so what Save is about to send is on screen before it
 * is pressed. "Discard" is offered beside "Save" for the same reason — the way
 * out of a half-typed fleet default has to be one click, not a reload.
 *
 * `CONFLICT` turns the bar `--warn`, with its own sentence and its own button.
 * A lost race is not a failed write, it is a *stale form*: somebody else wrote
 * between load and save, and the only useful next action is to re-read what
 * they wrote rather than to press Save again with the same stale
 * `expected_version`.
 *
 * Laptop-only settings never reach this bar: they save as they are touched and
 * flash `✓ saved` instead (`SavedTick`).
 */
import type { SaveError } from "../../logic/settings-logic.ts";
import { isConflict } from "../../logic/settings-logic.ts";
import { Sq } from "./Section.tsx";

export function SaveBar({
  changes,
  saving,
  error,
  blocked,
  canSave = true,
  onSave,
  onDiscard,
  onReload,
  context,
  saveLabel = "Save",
}: {
  /** The staged fields, by label — the bar counts them and names them. */
  changes: readonly string[];
  saving: boolean;
  error: SaveError | null;
  /** Why Save cannot be pressed yet (a field that will not parse), or null. */
  blocked?: string | null;
  /** False when the staged edits add up to no write (e.g. `0100` for `100`). */
  canSave?: boolean;
  onSave: () => void;
  onDiscard: () => void;
  /** Re-read the fleet's settings — the way out of a `CONFLICT`. */
  onReload: () => void;
  /** Where it is going, e.g. `fxtr0001 · rev 18`. */
  context?: string;
  saveLabel?: string;
}) {
  const conflict = isConflict(error);
  const dirty = changes.length > 0;
  // A failure outlives the edit that caused it: the operator has to be able to
  // read why the last Save did not take even after discarding what they typed.
  if (!dirty && error === null) return null;

  const headline = conflict
    ? "Changed on another laptop"
    : dirty
      ? `${changes.length} unsaved change${changes.length === 1 ? "" : "s"}`
      : "Save failed";

  return (
    <div className={conflict ? "st-save st-save-conf" : "st-save"} role="status">
      <div className="st-save-say">
        <div className="st-save-line">
          <Sq tone={conflict ? "warn" : error !== null ? "bad" : "acc"} />
          <b>{headline}</b>
          {dirty ? <span className="mono dim">{changes.join(" · ")}</span> : null}
        </div>
        {conflict ? (
          <div className="st-save-sub mono">
            Another laptop saved these settings after this page read them. Reload to see what it wrote;
            if it changed these defaults, the form starts again from its values.
          </div>
        ) : error !== null ? (
          <div className="st-save-sub mono st-save-err">
            {error.code} · {error.message}
          </div>
        ) : blocked ? (
          <div className="st-save-sub mono st-save-err">{blocked}</div>
        ) : null}
      </div>
      <div className="st-save-acts">
        {context ? <span className="mono dim st-save-ctx">{context}</span> : null}
        {conflict ? (
          <button type="button" className="btn btn-primary" onClick={onReload}>
            Reload
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-secondary"
          disabled={saving || !dirty}
          onClick={() => {
            onDiscard();
            // Discarding after a lost race clears the error, and with it the
            // Reload button — which would leave the form back on the fleet's
            // *stale* values with no way left to ask for the real ones. So a
            // discard out of a conflict re-reads too.
            if (conflict) onReload();
          }}
        >
          Discard
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={saving || !dirty || !canSave || Boolean(blocked)}
          onClick={onSave}
        >
          {saving ? "Saving…" : saveLabel}
        </button>
      </div>
    </div>
  );
}
