/**
 * The two write paths for a shared secret slot (§8.2), each its own drawer.
 *
 * The value field is **write-only** in the strongest sense available to a
 * browser: it is never prefilled (no read returns a value), it lives in this
 * component's state and nowhere else, it is cleared the moment the push
 * returns, and the component is unmounted on close — so closing the drawer is
 * itself the erasure. It never reaches the URL, `localStorage`, or a result
 * line: what comes back is the *path* that was written and how many agents were
 * re-keyed, which is the whole receipt.
 */
import { useState } from "react";
import { deleteSecret, pushSharedSecret } from "../../api/index.ts";
import type { SharedSecretView } from "../../api/index.ts";
import {
  canDeleteSecret,
  isValidSlug,
  rekeyReceiptMessage,
  toSaveError,
} from "../../logic/settings-logic.ts";
import type { SaveError } from "../../logic/settings-logic.ts";
import { Drawer, DrawerHead } from "../Drawer.tsx";

function Failure({ error }: { error: SaveError | null }) {
  if (error === null) return null;
  return (
    <div className="mono" style={{ color: "var(--bad)", fontSize: 12 }}>
      {error.code} · {error.message}
    </div>
  );
}

export function SecretPushDrawer({
  /** The slot being rotated, or `null` for a new one. */
  slot,
  onClose,
  onPushed,
}: {
  slot: SharedSecretView | null;
  onClose: () => void;
  onPushed: () => void;
}) {
  const rotating = slot !== null;
  const [slug, setSlug] = useState(slot?.slug ?? "");
  const [label, setLabel] = useState(slot?.label ?? "");
  const [value, setValue] = useState("");
  const [rekey, setRekey] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<SaveError | null>(null);
  const [receipt, setReceipt] = useState<{
    path: string;
    rekeyed: number;
    /** Whether "Re-key running agents" was ticked for this push. */
    rekeyRequested: boolean;
  } | null>(null);

  const trimmed = slug.trim();
  const slugOk = isValidSlug(trimmed);
  const ready = slugOk && value.length > 0 && !submitting;

  async function submit() {
    if (!ready) return;
    setSubmitting(true);
    setError(null);
    try {
      const out = await pushSharedSecret({
        shared: trimmed,
        value,
        // An *omitted* label leaves whatever the slot was already called
        // (`pushShared` in core), which on a rotate would make a name
        // impossible to remove. An emptied field is a stated erasure, so it is
        // sent as "" rather than dropped — and on a new slot there is nothing
        // to preserve either way.
        ...(label.trim() === "" && !rotating ? {} : { label: label.trim() }),
        ...(rekey ? { rekey: "all" as const } : {}),
      });
      // First thing after the round trip, before anything renders again.
      setValue("");
      setReceipt({ path: out.path, rekeyed: out.rekeyed?.length ?? 0, rekeyRequested: rekey });
      onPushed();
    } catch (e) {
      setError(toSaveError(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Drawer width={560} onClose={onClose} labelledBy="secret-push-title">
      <DrawerHead
        titleId="secret-push-title"
        kicker={rotating ? "Rotate a shared secret" : "Add a shared secret"}
        title={rotating ? `Rotate ${slot.slug}` : "New shared secret"}
        onClose={onClose}
      />

      {receipt !== null ? (
        <>
          <div className="form">
            <div className="callout ok">
              wrote <span className="mono">{receipt.path}</span>
              <div className="name-hint mono" style={{ color: "var(--fg3)" }}>
                {rekeyReceiptMessage(receipt)}
              </div>
            </div>
          </div>
          <div className="drawer-foot">
            <span className="mono" style={{ fontSize: 11, color: "var(--fg3)" }}>
              $ hermetic secrets push _fleet --shared {trimmed}
            </span>
            <button type="button" className="btn btn-primary" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="form">
            {rotating ? null : (
              <label style={{ display: "block" }}>
                <div className="kicker" style={{ marginBottom: 8 }}>
                  Slug
                </div>
                <input
                  className="name-input"
                  data-autofocus
                  spellCheck={false}
                  value={slug}
                  placeholder="e.g. nous-key"
                  onChange={(e) => setSlug(e.target.value.toLowerCase())}
                />
                <div
                  className="name-hint"
                  style={{ color: trimmed === "" || slugOk ? "var(--fg3)" : "var(--bad)" }}
                >
                  {trimmed === "" || slugOk
                    ? "lowercase, digits, dashes · becomes /hermetic/secrets/<slug>"
                    : "lowercase letters, digits and dashes · no leading dash · 1–31 chars"}
                </div>
              </label>
            )}

            <label style={{ display: "block" }}>
              <div className="kicker" style={{ marginBottom: 8 }}>
                Label
              </div>
              <input
                className="key-input"
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder={rotating ? "cleared if left empty" : "what this key is, in a list"}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </label>

            <label style={{ display: "block" }}>
              <div className="kicker" style={{ marginBottom: 8 }}>
                Value
              </div>
              <input
                className="key-input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                data-autofocus={rotating || undefined}
                placeholder={rotating ? "the new key" : "the provider's API key"}
                onChange={(e) => setValue(e.target.value)}
              />
              <div className="name-hint" style={{ color: "var(--fg3)" }}>
                write-only · stored as a SecureString at
                <span className="mono"> /hermetic/secrets/{trimmed || "<slug>"}</span>, never returned
                by any read
              </div>
            </label>

            {rotating ? (
              <label className="verify-row">
                <input
                  className="verify-check"
                  type="checkbox"
                  checked={rekey}
                  onChange={(e) => setRekey(e.target.checked)}
                />
                <span>
                  Re-key running agents
                  <span className="name-hint" style={{ color: "var(--fg3)", display: "block" }}>
                    re-copies this value into the slot of every agent on it; each takes it on its next{" "}
                    <span className="mono">recreate</span>. Without this, only future creates see it.
                  </span>
                </span>
              </label>
            ) : null}

            <Failure error={error} />
          </div>

          <div className="drawer-foot">
            <span className="mono" style={{ fontSize: 11, color: "var(--fg3)" }}>
              $ hermetic secrets push _fleet --shared {trimmed || "<slug>"}
              {rekey ? " --rekey all" : ""}
            </span>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!ready}
              style={{ opacity: ready ? 1 : 0.35 }}
              onClick={() => void submit()}
            >
              {submitting ? "Pushing…" : rotating ? "Rotate" : "Add secret"}
            </button>
          </div>
        </>
      )}
    </Drawer>
  );
}

/**
 * Deleting a slot is the volume-delete ceremony: one stage, one typed name.
 * A slug a provider still names is refused here *and* by the route — the
 * fallback for a create that loses its key is a prompt nobody is standing at.
 */
export function SecretDeleteDrawer({
  slot,
  onClose,
  onDeleted,
}: {
  slot: SharedSecretView;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<SaveError | null>(null);

  const allowed = canDeleteSecret({
    slug: slot.slug,
    exists: slot.exists,
    placeholder: slot.placeholder,
    used_by: slot.used_by,
    orphan: slot.orphan,
  });
  const matches = typed.trim() === slot.slug;
  const ready = allowed.ok && matches && !submitting;

  async function submit() {
    if (!ready) return;
    setSubmitting(true);
    setError(null);
    try {
      await deleteSecret(slot.slug);
      onDeleted();
    } catch (e) {
      setError(toSaveError(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Drawer width={560} onClose={onClose} labelledBy="secret-delete-title">
      <DrawerHead
        titleId="secret-delete-title"
        kicker="Delete a shared secret"
        title={`Delete ${slot.slug}`}
        onClose={onClose}
      />
      <div className="form">
        <div className="callout bad">
          The value in <span className="mono">/hermetic/secrets/{slot.slug}</span> is deleted and not
          recoverable. Agents already built from it keep their own copies.
        </div>

        {allowed.ok ? null : (
          <div className="mono" style={{ color: "var(--bad)", fontSize: 12 }}>
            {allowed.reason}
          </div>
        )}

        <label style={{ display: "block" }}>
          <div className="kicker" style={{ marginBottom: 8 }}>
            Type the slug to confirm
          </div>
          <input
            className="name-input"
            data-autofocus
            spellCheck={false}
            value={typed}
            placeholder={slot.slug}
            disabled={!allowed.ok}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
          <div className="name-hint" style={{ color: matches ? "var(--ok)" : "var(--fg3)" }}>
            {matches ? "matches" : "the slug, exactly as above"}
          </div>
        </label>

        <Failure error={error} />
      </div>

      <div className="drawer-foot">
        <span className="mono" style={{ fontSize: 11, color: "var(--fg3)" }}>
          $ hermetic secrets rm {slot.slug} --yes
        </span>
        <button
          type="button"
          className="btn btn-danger"
          disabled={!ready}
          style={{ opacity: ready ? 1 : 0.35 }}
          onClick={() => void submit()}
        >
          {submitting ? "Deleting…" : "Delete secret"}
        </button>
      </div>
    </Drawer>
  );
}
