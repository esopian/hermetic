/**
 * Settings › Defaults' memory rows: the fleet's default Hermes external memory
 * provider, and the fleet-shared key each keyed provider reads at create.
 *
 * Both save at once, like the default profile row, and for the same reason:
 * neither is part of the staged defaults patch. The default is its own
 * `settings.set` field, CAS'd on the version the shell holds; a key is a
 * `secrets.push` into the shared slot `memory-<id>`, which a create then copies
 * into the agent's own slot.
 *
 * A key is write-only here as everywhere (`SecretDrawers.tsx`): never
 * prefilled, held in this component's state only until the push returns, then
 * cleared. Nothing reads it back; the row only says whether the slot is filled.
 */
import { useEffect, useId, useState } from "react";
import {
  MEMORY_PROVIDERS,
  MEMORY_PROVIDERS_LIST,
  isMemoryProvider,
  memoryKeySlug,
  memoryProviderNeedsKey,
} from "@hermetic/core/shared";
import type { MemoryProvider } from "@hermetic/core/shared";
import { listSecrets, pushSharedSecret, setSettings } from "../../api/index.ts";
import type { SettingsResult, SharedSecretView } from "../../api/index.ts";
import { memoryKeyState } from "../../logic/memory-logic.ts";
import { toSaveError } from "../../logic/settings-logic.ts";
import type { SaveError } from "../../logic/settings-logic.ts";
import { RowNote, SavedTick, SettingRow, useSavedTick } from "./Section.tsx";

const KEYED = MEMORY_PROVIDERS_LIST.filter((p) => memoryProviderNeedsKey(p.id));

function ErrorLine({ error }: { error: SaveError }) {
  return (
    <span className="st-err">
      {error.code} · {error.message}
    </span>
  );
}

export function MemoryDefaultRows({
  result,
  expectedVersion,
  onSaved,
  onWritten,
}: {
  result: SettingsResult;
  expectedVersion: number | null;
  /** The write's answer, handed to the shell so every section holds the new version. */
  onSaved: (next: SettingsResult) => void;
  /** A key push wrote `_fleet` too (the slot's metadata): re-read the settings. */
  onWritten: () => void;
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SaveError | null>(null);
  const [ticked, flash] = useSavedTick();
  const current = result.settings.default_memory_provider ?? null;
  const [slots, setSlots] = useState<SharedSecretView[] | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    listSecrets()
      .then((out) => {
        if (live) setSlots(out.secrets);
      })
      .catch(() => {
        /* Unknown, not missing: the rows say so rather than inventing a state. */
      });
    return () => {
      live = false;
    };
  }, [nonce]);

  async function choose(value: string) {
    const next = isMemoryProvider(value) ? value : null;
    if (next === current) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await setSettings({ default_memory_provider: next, expected_version: expectedVersion }));
      flash();
    } catch (e) {
      setError(toSaveError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SettingRow
        label="Default memory provider"
        desc={
          error !== null ? (
            <ErrorLine error={error} />
          ) : (
            "What a create with no --memory runs beside Hermes's built-in memory."
          )
        }
        htmlFor={id}
        field="default_memory_provider"
        state={
          <>
            {ticked ? null : <RowNote>saves at once</RowNote>}
            <SavedTick on={ticked} />
          </>
        }
      >
        <div className="select-wrap st-w">
          <select
            id={id}
            className="select-input"
            disabled={busy}
            value={current ?? ""}
            onChange={(e) => void choose(e.target.value)}
          >
            <option value="">None — built-in only</option>
            {MEMORY_PROVIDERS_LIST.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      </SettingRow>
      {KEYED.map((p) => (
        <MemoryKeyRow
          key={p.id}
          provider={p.id}
          slots={slots}
          onPushed={() => {
            setNonce((n) => n + 1);
            onWritten();
          }}
        />
      ))}
    </>
  );
}

function MemoryKeyRow({
  provider,
  slots,
  onPushed,
}: {
  provider: MemoryProvider;
  slots: SharedSecretView[] | null;
  onPushed: () => void;
}) {
  const id = useId();
  const spec = MEMORY_PROVIDERS[provider];
  const slug = memoryKeySlug(provider);
  const state = memoryKeyState(provider, slots);
  const exists = slots?.some((s) => s.slug === slug) ?? false;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SaveError | null>(null);
  const [ticked, flash] = useSavedTick();

  async function push() {
    if (value.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      // A new slot is named for its provider; an existing one keeps its label.
      await pushSharedSecret({ shared: slug, value, ...(exists ? {} : { label: spec.label }) });
      setValue("");
      setEditing(false);
      flash();
      onPushed();
    } catch (e) {
      setError(toSaveError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingRow
      label={`${spec.label} key`}
      desc={error !== null ? <ErrorLine error={error} /> : `${spec.env ?? ""} · shared slot ${slug}`}
      htmlFor={editing ? id : undefined}
      field={`memory-key-${provider}`}
      state={
        <>
          {ticked ? null : (
            <RowNote>
              {state === "unknown" ? "not read" : state === "set" ? "key set" : "key missing"}
            </RowNote>
          )}
          <SavedTick on={ticked} />
        </>
      }
    >
      {editing ? (
        <>
          <input
            id={id}
            className="key-input st-key-inline"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={`${spec.label} API key`}
            onChange={(e) => setValue(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-primary btn-mini"
            disabled={busy || value.length === 0}
            onClick={() => void push()}
          >
            {busy ? "Saving…" : "Save key"}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-mini"
            disabled={busy}
            onClick={() => {
              setValue("");
              setEditing(false);
            }}
          >
            Cancel
          </button>
        </>
      ) : (
        <button type="button" className="btn btn-secondary btn-mini" onClick={() => setEditing(true)}>
          {state === "set" ? `Replace ${spec.label} key` : `Set ${spec.label} key`}
        </button>
      )}
    </SettingRow>
  );
}
