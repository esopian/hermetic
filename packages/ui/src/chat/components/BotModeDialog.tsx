import { useState, useId } from "react";
import type { ReactNode, FormEvent } from "react";
import { Dialog } from "../../components/Dialog.tsx";
export function BotModeDialog({
  title,
  children,
  onClose,
  onSubmit,
  submit = "Save",
  blocked = null,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  onSubmit?: (data: FormData) => Promise<void>;
  submit?: string;
  /**
   * Why this dialog cannot be submitted, when something outside the form says
   * so — a capability the gateway refused, or one the probe could not confirm.
   * The sentence is on the button rather than only beside it because a disabled
   * button is skipped by the keyboard and its `title` is not announced.
   */
  blocked?: string | null;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!onSubmit || busy || blocked !== null) return;
    setBusy(true);
    setError("");
    try {
      await onSubmit(new FormData(event.currentTarget));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      as="section"
      className="bm-dialog"
      modal
      label={title}
      // A submit in flight owns the dialog: Escape is swallowed, not honoured.
      onDismiss={busy ? undefined : onClose}
      backdrop={{ className: "bm-overlay" }}
    >
      <header>
        <h2>{title}</h2>
        <button
          type="button"
          className="btn-mini"
          disabled={busy}
          aria-label="Close dialog"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <form onSubmit={save}>
        <fieldset disabled={busy}>{children}</fieldset>
        {error ? (
          <p role="alert" className="bm-error">
            {error}
          </p>
        ) : null}
        <footer>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>
            Close
          </button>
          {onSubmit ? (
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || blocked !== null}
              {...(blocked === null
                ? {}
                : {
                    "aria-disabled": true,
                    "aria-label": `${submit} — unavailable. ${blocked}`,
                    title: blocked,
                  })}
            >
              {busy ? "Saving…" : submit}
            </button>
          ) : null}
        </footer>
      </form>
    </Dialog>
  );
}
export function BotField({
  label,
  name,
  value = "",
  textarea = false,
  required = false,
  maxLength,
}: {
  label: string;
  name: string;
  value?: string;
  textarea?: boolean;
  required?: boolean;
  maxLength?: number;
}) {
  const id = useId();
  return (
    <label className="bm-field" htmlFor={id}>
      <span>{label}</span>
      {textarea ? (
        <textarea
          id={id}
          className="wiz-input"
          name={name}
          defaultValue={value}
          required={required}
          rows={4}
        />
      ) : (
        <input
          id={id}
          className="wiz-input"
          name={name}
          defaultValue={value}
          required={required}
          maxLength={maxLength}
        />
      )}
    </label>
  );
}
