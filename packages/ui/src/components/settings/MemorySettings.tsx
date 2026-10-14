/**
 * Settings › Defaults' memory rows: the fleet's default Hermes external memory
 * provider, and what each provider in the catalogue costs the box.
 *
 * The default saves at once, like the default profile row, and for the same
 * reason: it is not part of the staged defaults patch but its own
 * `settings.set` field, CAS'd on the version the shell holds.
 *
 * Every provider is set up on the box with no operator input — no account, no
 * key — so there is nothing here to fill in: the list only says where each one
 * runs, how much instance memory it needs, and whether it spends the agent's
 * own model credential (`MEMORY_PROVIDERS` in `@hermetic/core/shared`).
 */
import { useId, useState } from "react";
import { MEMORY_PROVIDERS_LIST, isMemoryProvider } from "@hermetic/core/shared";
import { setSettings } from "../../api/index.ts";
import type { SettingsResult } from "../../api/index.ts";
import { openExternal } from "../../lib/open-external.ts";
import { memoryTags } from "../../logic/memory-logic.ts";
import { toSaveError } from "../../logic/settings-logic.ts";
import type { SaveError } from "../../logic/settings-logic.ts";
import { RowNote, SavedTick, SettingRow, useSavedTick } from "./Section.tsx";

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
}: {
  result: SettingsResult;
  expectedVersion: number | null;
  /** The write's answer, handed to the shell so every section holds the new version. */
  onSaved: (next: SettingsResult) => void;
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SaveError | null>(null);
  const [ticked, flash] = useSavedTick();
  const current = result.settings.default_memory_provider ?? null;

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
      <table className="st-list" aria-label="Memory providers">
        <thead>
          <tr>
            <th>Provider</th>
            <th aria-label="Documentation" />
          </tr>
        </thead>
        <tbody>
          {MEMORY_PROVIDERS_LIST.map((p) => (
            <tr key={p.id} data-field={`memory-provider-${p.id}`}>
              <td>
                <div className="st-name">
                  <b>{p.label}</b>
                  {p.id === current ? <span className="tag ghost">default</span> : null}
                </div>
                <div className="st-sub">{p.summary}</div>
                <div className="st-why">{memoryTags(p.id).join(" · ")}</div>
              </td>
              <td className="st-acts">
                <button
                  type="button"
                  className="linklike"
                  title={p.docs}
                  onClick={() => openExternal(p.docs)}
                >
                  Docs ↗
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
