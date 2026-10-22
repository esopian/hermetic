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
 *
 * Beside it, the same kind of row for §6.6's `auto_upgrade` (absent means off,
 * `autoUpgrade`): whether the desktop app runs the fleet update itself when it
 * is a newer build.
 */
import { useState } from "react";
import { autoUpdateHermeticd, autoUpgrade } from "@hermetic/core/shared";
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

/**
 * §6.6's opt-in, off by default (`autoUpgrade` from core): the app's own fleet
 * update. The row's line is clipped to one line, so the part that matters —
 * On restarts Hermes on some boxes unasked — leads, and the whole rule rides
 * in the row's tooltip.
 */
const UPGRADE_ON = "Restarts Hermes on agents whose config changed.";
const UPGRADE_OFF = "On restarts Hermes where an agent's config changed.";
const UPGRADE_FULL =
  "On: when this app is a newer build than the one that last updated the fleet, it runs the fleet update itself — hermeticd and every agent's config. Hermes restarts on agents whose config changed. It never runs a foundation update and never moves the fleet to an older build. Off: fleet updates start only when you run them.";

type Field = "auto_update_hermeticd" | "auto_upgrade";

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
  if (settings === null) return null;
  const shared = { settings, onSaved, onRefresh, disabledReason: disabledReason ?? null };
  return (
    <Block title="hermeticd updates">
      <SwitchRow
        {...shared}
        field="auto_update_hermeticd"
        label="Auto-update hermeticd"
        current={autoUpdateHermeticd(settings.settings)}
        descOn={DESC_ON}
        descOff={DESC_OFF}
      />
      <SwitchRow
        {...shared}
        field="auto_upgrade"
        label="Auto-upgrade fleet"
        current={autoUpgrade(settings.settings)}
        descOn={UPGRADE_ON}
        descOff={UPGRADE_OFF}
        descTitle={UPGRADE_FULL}
      />
    </Block>
  );
}

/** One instant-save On/Off over one boolean field of the fleet settings. */
function SwitchRow({
  settings,
  onSaved,
  onRefresh,
  disabledReason,
  field,
  label,
  current,
  descOn,
  descOff,
  descTitle,
}: {
  settings: SettingsResult;
  onSaved: (next: SettingsResult) => void;
  onRefresh: () => Promise<void>;
  disabledReason: string | null;
  field: Field;
  label: string;
  current: boolean;
  descOn: string;
  descOff: string;
  /** The whole explanation, when the one clipped line cannot hold it. */
  descTitle?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SaveError | null>(null);
  /** The write landed but its follow-on did not (the manifest republish); core names the fix. */
  const [warning, setWarning] = useState<string | null>(null);
  const [ticked, flash] = useSavedTick();

  // `persisted: false` is a fleet nobody has written settings for: the write
  // says `null` ("there was none"), not the synthesized version number.
  const expected = settings.persisted ? settings.settings.version : null;
  const locked = busy || disabledReason !== null;

  async function choose(next: boolean) {
    if (next === current || locked) return;
    setBusy(true);
    setError(null);
    setWarning(null);
    try {
      const result = await setSettings({ [field]: next, expected_version: expected });
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

  const idle = current ? descOn : descOff;
  const desc =
    error === null ? (
      descTitle === undefined ? (
        idle
      ) : (
        <span title={descTitle}>{idle}</span>
      )
    ) : (
      <span className="st-err">
        {isConflict(error)
          ? "Changed on another laptop — settings reloaded, try again."
          : `${error.code} · ${error.message}`}
      </span>
    );

  return (
    <>
      <SettingRow
        label={label}
        desc={desc}
        field={field}
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
          aria-label={label}
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
    </>
  );
}
