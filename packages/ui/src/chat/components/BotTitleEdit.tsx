/**
 * The bot's name in a thread header, with a pencil that renames it in place.
 *
 * A rename is the friendly title only — `bots.update { title }`, which core
 * writes as `ui_meta['hermes-bots'].title` the way Hermes Desktop's Edit
 * profile does. The profile name (the `@handle`, the identity every request
 * carries) never changes here, which is why the field's placeholder is that
 * name: clearing the field and saving resets the title, and the placeholder is
 * what the header falls back to.
 */
import { useEffect, useRef, useState } from "react";
import { RedactedText } from "./RedactedText.tsx";

export function BotTitleEdit({
  label,
  title,
  fallback,
  onSave,
}: {
  /** What the header shows now. */
  label: string;
  /** The bot's current title, if it has one distinct from its profile name. */
  title: string | null;
  /** The name shown once the title is cleared. */
  fallback: string;
  /** Persist the new title; `null` clears it. Rejects with the reason it failed. */
  onSave: (title: string | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false),
    [draft, setDraft] = useState(""),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const pencil = useRef<HTMLButtonElement>(null),
    input = useRef<HTMLInputElement>(null);
  /** Focus goes back to the pencil once the field is gone, so a keyboard user is not dropped. */
  const refocus = useRef(false);
  /**
   * A failed save disabled the field, which drops its focus; it goes back to
   * the field once it is enabled again, so the operator can fix and resubmit.
   */
  const retry = useRef(false);
  useEffect(() => {
    if (saving || !retry.current) return;
    retry.current = false;
    input.current?.focus();
  }, [saving]);
  useEffect(() => {
    if (editing) input.current?.select();
    else if (refocus.current) {
      refocus.current = false;
      pencil.current?.focus();
    }
  }, [editing]);

  function close() {
    refocus.current = true;
    setEditing(false);
    setError("");
  }
  async function commit() {
    if (saving) return;
    const next = draft.trim();
    if (next === (title ?? "")) return close();
    setSaving(true);
    setError("");
    try {
      await onSave(next || null);
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      retry.current = true;
    } finally {
      setSaving(false);
    }
  }

  if (!editing)
    return (
      <>
        <RedactedText text={label} />
        <button
          ref={pencil}
          type="button"
          className="ch-title-edit"
          aria-label={`Rename ${label}`}
          title="Rename"
          onClick={() => {
            setDraft(title ?? "");
            setEditing(true);
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M16 3l5 5L8 21H3v-5z" />
            <path d="M13 6l5 5" />
          </svg>
        </button>
      </>
    );
  return (
    <form
      className="ch-title-form"
      onSubmit={(e) => {
        e.preventDefault();
        void commit();
      }}
    >
      <input
        ref={input}
        className="ch-title-input"
        aria-label="Bot name"
        value={draft}
        placeholder={fallback}
        maxLength={64}
        disabled={saving}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          // The header sits inside surfaces that close on Escape; this one is ours.
          e.preventDefault();
          e.stopPropagation();
          if (!saving) close();
        }}
      />
      <button type="submit" className="ch-chip" disabled={saving}>
        {saving ? "Saving…" : "Save"}
      </button>
      <button type="button" className="ch-chip" disabled={saving} onClick={close}>
        Cancel
      </button>
      {error ? (
        <span className="ch-title-error" role="alert">
          {error}
        </span>
      ) : null}
    </form>
  );
}
