/**
 * §6.5's one switch: whether a newly published hermeticd release reaches the
 * fleet's running agents within minutes, or waits for each agent's nightly slot.
 *
 * An instant-save row, like the default profile (`DefaultsSection`): the flag is
 * a field on the shared settings but the Foundation page has no save bar, and a
 * rollout policy is a command — "do it this way from now on" — not a draft to
 * stage with other edits. So one click is one `settings.set` carrying only
 * `auto_update_hermeticd` and the version the page holds, and the write goes
 * back up to the shell (`onSaved`) so every section keeps reading one document.
 *
 * The value shown is `autoUpdateHermeticd(settings)` from core: absent means
 * on, and that default is core's to state, not this file's.
 */
import { useState } from "react";
import { autoUpdateHermeticd } from "@hermetic/core/shared";
import { setSettings } from "../../api/index.ts";
import type { SettingsResult } from "../../api/index.ts";
import { isConflict, toSaveError } from "../../logic/settings-logic.ts";
import type { SaveError } from "../../logic/settings-logic.ts";
import { Block, Callout, RowNote, SavedTick, SettingRow, useSavedTick } from "./Section.tsx";

const STATES = [
  { on: true, label: "On" },
  { on: false, label: "Off" },
] as const;

const DESC_ON = "New releases reach running agents within minutes.";
const DESC_OFF =
  "Each agent takes a new release at its nightly update (03:xx UTC), or when run with --now.";

export function HermeticdUpdates({
  settings,
  onSaved,
  onRefresh,
  disabledReason,
}: {
  /** The shell's held settings document; nothing renders until there is one. */
  settings: SettingsResult | null;
  onSaved: (next: SettingsResult) => void;
  /** Re-read the settings; rejects on failure. Used after a lost write race. */
  onRefresh: () => Promise<void>;
  /** Why the control is unavailable right now (a foundation update holds the fleet), if it is. */
  disabledReason?: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SaveError | null>(null);
  /** The write landed but its follow-on did not (the manifest republish); core names the fix. */
  const [warning, setWarning] = useState<string | null>(null);
  const [ticked, flash] = useSavedTick();

  if (settings === null) return null;
  const current = autoUpdateHermeticd(settings.settings);
  // `persisted: false` is a fleet nobody has written settings for: the write
  // says `null` ("there was none"), not the synthesized version number.
  const expected = settings.persisted ? settings.settings.version : null;
  const locked = busy || (disabledReason ?? null) !== null;

  async function choose(next: boolean) {
    if (next === current || locked) return;
    setBusy(true);
    setError(null);
    setWarning(null);
    try {
      const result = await setSettings({
        auto_update_hermeticd: next,
        expected_version: expected,
      });
      // The setting saved either way, so the shell holds the new document. A
      // warning means the boxes have not heard yet: say that, not "✓ saved".
      onSaved(result);
      if (result.warning === undefined || result.warning === "") flash();
      else setWarning(result.warning);
    } catch (e) {
      const raised = toSaveError(e);
      setError(raised);
      if (isConflict(raised)) {
        // Somebody else wrote between load and click. Take their version, so
        // the next click is composed against what is actually there.
        await onRefresh().catch(() => undefined);
      }
    } finally {
      setBusy(false);
    }
  }

  const idle = current ? DESC_ON : DESC_OFF;
  const desc =
    error === null ? (
      idle
    ) : (
      <span className="st-err">
        {isConflict(error)
          ? "Changed on another laptop — settings reloaded, try again."
          : `${error.code} · ${error.message}`}
      </span>
    );

  return (
    <Block title="hermeticd updates">
      <SettingRow
        label="Auto-update hermeticd"
        desc={desc}
        field="auto_update_hermeticd"
        state={
          <>
            {ticked ? null : <RowNote>saves at once</RowNote>}
            <SavedTick on={ticked} />
          </>
        }
      >
        <div
          className="seg st-seg st-w"
          role="group"
          aria-label="Auto-update hermeticd"
          title={disabledReason ?? undefined}
        >
          {STATES.map((s) => (
            <button
              type="button"
              key={s.label}
              aria-pressed={current === s.on}
              disabled={locked}
              onClick={() => void choose(s.on)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </SettingRow>
      {warning === null ? null : (
        <Callout tone="warn">
          <span className="mono">{warning}</span>
        </Callout>
      )}
    </Block>
  );
}
