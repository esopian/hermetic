/**
 * Settings › Defaults' memory rows: the fleet's default Hermes external memory
 * provider, chosen from a radio list that says what each choice costs the box.
 *
 * The default is not part of the staged defaults patch but its own
 * `settings.set` field, CAS'd on the version the shell holds, so it has its own
 * Save. Picking a radio only stages the choice: a radio group moves its
 * selection with the arrow keys, and a save on every move would write each
 * provider passed on the way.
 *
 * Every provider is set up on the box with no operator input — no account, no
 * key — so there is nothing here to fill in: each row only says where the
 * provider runs, what it needs and what it spends (`MEMORY_PROVIDERS` and
 * `memoryResourceFacts` in `@hermetic/core/shared`), with no vendor, so the
 * embeddings chip states the general rule.
 */
import { useEffect, useId, useRef, useState } from "react";
import { MEMORY_PROVIDERS, MEMORY_PROVIDERS_LIST, MEMORY_PROVIDER_NONE } from "@hermetic/core/shared";
import { setSettings } from "../../api/index.ts";
import type { SettingsResult } from "../../api/index.ts";
import { openExternal } from "../../lib/open-external.ts";
import {
  type MemoryChoice,
  isMemoryChoice,
  memoryChoiceText,
  memoryUnavailableNote,
} from "../../logic/memory-logic.ts";
import { toSaveError } from "../../logic/settings-logic.ts";
import type { SaveError } from "../../logic/settings-logic.ts";
import { MemoryEstimateNote, MemoryResourceChips } from "../MemoryProviderCard.tsx";
import { RowChanged, SavedTick, SettingRow, useSavedTick } from "./Section.tsx";

function ErrorLine({ error }: { error: SaveError }) {
  return (
    <span className="st-err">
      {error.code} · {error.message}
    </span>
  );
}

/** Every choice, in the create drawer's order: built-in only, then the catalogue. */
const CHOICES: readonly MemoryChoice[] = [
  MEMORY_PROVIDER_NONE,
  ...MEMORY_PROVIDERS_LIST.map((p) => p.id),
];

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
  const base = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SaveError | null>(null);
  const [ticked, flash] = useSavedTick();
  /**
   * The stored default exactly as read. A newer build may have written a
   * provider this one does not know: it is shown as such and no radio claims
   * it, so None + Save can still clear it (coercing it to None would leave
   * nothing to save).
   */
  const stored: string = result.settings.default_memory_provider ?? MEMORY_PROVIDER_NONE;
  const saved: MemoryChoice | null = isMemoryChoice(stored) ? stored : null;
  /** The staged pick; null follows the saved default. */
  const [staged, setStaged] = useState<MemoryChoice | null>(null);
  /** Null only when the stored default is unknown and nothing is staged. */
  const picked: MemoryChoice | null = staged ?? saved;
  const dirty = picked !== null && picked !== stored;
  const group = useRef<HTMLDivElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  /**
   * Set after a save, a failed save or a Revert. Each leaves focus nowhere —
   * the pressed button was disabled while the write ran, or is gone — so once
   * the commit has re-enabled the controls focus goes to the checked radio
   * (the first, when the stored default is unknown) or, after a refusal, back
   * to Save, so a keyboard user keeps their place.
   */
  const [refocus, setRefocus] = useState<{ n: number; to: "radio" | "save" } | null>(null);
  useEffect(() => {
    if (refocus === null) return;
    if (refocus.to === "save" && saveButton.current !== null && !saveButton.current.disabled) {
      saveButton.current.focus();
      return;
    }
    const radios = group.current?.querySelectorAll<HTMLInputElement>("input[type=radio]");
    const checked = group.current?.querySelector<HTMLInputElement>("input[type=radio]:checked");
    (checked ?? radios?.[0])?.focus();
  }, [refocus]);
  const refocusTo = (to: "radio" | "save") => setRefocus((r) => ({ n: (r?.n ?? 0) + 1, to }));

  async function save() {
    if (!dirty || picked === null) return;
    setBusy(true);
    setError(null);
    try {
      const next = picked === MEMORY_PROVIDER_NONE ? null : picked;
      onSaved(await setSettings({ default_memory_provider: next, expected_version: expectedVersion }));
      setStaged(null);
      refocusTo("radio");
      flash();
    } catch (e) {
      setError(toSaveError(e));
      refocusTo("save");
    } finally {
      setBusy(false);
    }
  }

  const unknownId = `${base}-unknown`;

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
        field="default_memory_provider"
        changed={dirty}
        state={
          <>
            {dirty ? (
              <RowChanged was={saved === null ? stored : memoryChoiceText(saved).label} />
            ) : null}
            <SavedTick on={ticked && !dirty} />
          </>
        }
      >
        <div className="mem-def-acts">
          <button
            ref={saveButton}
            id={`${base}-save`}
            type="button"
            className="btn btn-secondary btn-mini"
            disabled={busy || !dirty}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save default"}
          </button>
          {dirty && !busy ? (
            <button
              type="button"
              className="linklike"
              onClick={() => {
                setStaged(null);
                setError(null);
                refocusTo("radio");
              }}
            >
              Revert
            </button>
          ) : null}
        </div>
      </SettingRow>
      {saved === null ? (
        <div id={unknownId} className="mem-def-unknown">
          Stored default: <code>{stored}</code> (unknown to this version). Pick a provider and save to
          replace it.
        </div>
      ) : null}
      <div
        ref={group}
        className="mem-opts"
        role="radiogroup"
        aria-label="Default memory provider"
        aria-describedby={saved === null ? unknownId : undefined}
      >
        {CHOICES.map((c) => {
          const text = memoryChoiceText(c);
          const on = picked === c;
          const unavailable = c === MEMORY_PROVIDER_NONE ? null : memoryUnavailableNote(c);
          const docs = c === MEMORY_PROVIDER_NONE ? null : MEMORY_PROVIDERS[c].docs;
          const nameId = `${base}-${c}-name`;
          const sumId = `${base}-${c}-sum`;
          const noteId = `${base}-${c}-note`;
          const tagId = `${base}-${c}-tag`;
          const isDefault = c === saved;
          const describedBy = [isDefault ? tagId : null, sumId, unavailable === null ? null : noteId]
            .filter((x) => x !== null)
            .join(" ");
          return (
            <div key={c} className={on ? "mem-opt on" : "mem-opt"} data-field={`memory-provider-${c}`}>
              <label className="mem-opt-main">
                <input
                  type="radio"
                  id={`${base}-${c}-radio`}
                  className="mem-radio"
                  name={`${base}-default-memory`}
                  value={c}
                  checked={on}
                  disabled={busy}
                  aria-labelledby={nameId}
                  aria-describedby={describedBy}
                  onChange={() => {
                    setStaged(c);
                    setError(null);
                  }}
                />
                <div className="mem-opt-body">
                  <div className="mem-opt-head">
                    <b id={nameId}>{text.label}</b>
                    {isDefault ? (
                      <span id={tagId} className="tag mem-tag-default">
                        Fleet default
                      </span>
                    ) : null}
                  </div>
                  <div id={sumId} className="mem-opt-sum">
                    {text.summary}
                  </div>
                  <MemoryResourceChips choice={c} compact />
                  {unavailable === null ? null : (
                    <div id={noteId} className="mem-opt-note">
                      {unavailable}
                    </div>
                  )}
                </div>
              </label>
              {docs === null ? null : (
                <button
                  type="button"
                  className="linklike mem-opt-docs"
                  title={docs}
                  aria-label={`${text.label} documentation`}
                  onClick={() => openExternal(docs)}
                >
                  Docs ↗
                </button>
              )}
            </div>
          );
        })}
      </div>
      <MemoryEstimateNote />
    </>
  );
}
