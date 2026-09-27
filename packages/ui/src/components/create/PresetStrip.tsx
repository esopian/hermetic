/**
 * The preset strip: this laptop's loadout (Settings › Create presets, §4.6),
 * left to right, each card a whole machine priced as the sum of its instance,
 * data volume and system disk (`create-presets.ts`). Empty loadout slots are
 * skipped. "Edit presets →" keeps the form (`create-draft.ts`) and opens the
 * Settings page that arranges this strip.
 */
import { saveCreateDraft } from "../../logic/create-draft.ts";
import { fmtUsd, sizeSpec } from "../../logic/format.ts";
import { presetMonthlyUsd } from "../../logic/create-presets.ts";
import { useNav } from "../../nav/nav-state.tsx";
import type { PresetView } from "@hermetic/core/shared";
import type { CreateFormModel } from "./useCreateForm.ts";

export function PresetStrip({ f, lockedGib }: { f: CreateFormModel; lockedGib: number | null }) {
  const { editPresets } = useNav();
  const edit = () => {
    saveCreateDraft(f.fleetId, f.draftNow());
    editPresets();
  };
  return (
    <div>
      <div className="cr-lbl">
        <span className="kicker">Preset</span>
        <span className="cr-src">
          {lockedGib === null ? "size + data volume + system disk" : "size + system disk"}
        </span>
        <button type="button" className="linklike cr-editpresets" onClick={edit}>
          Edit presets →
        </button>
      </div>
      {f.strip.length === 0 ? (
        <div className="cr-disc-sum mono">
          No presets in this laptop&apos;s loadout: the machine follows the fleet&apos;s defaults.
        </div>
      ) : (
        <div className="cr-presets" role="group" aria-label="Machine preset">
          {f.strip.map((p) => (
            <PresetCell key={p.id} p={p} f={f} lockedGib={lockedGib} />
          ))}
        </div>
      )}
    </div>
  );
}

function PresetCell({
  p,
  f,
  lockedGib,
}: {
  p: PresetView;
  f: CreateFormModel;
  lockedGib: number | null;
}) {
  const on = f.preset?.id === p.id;
  /*
   * On the reclaim path the volume is the volume's, whatever the preset says,
   * so the card prices and describes the machine that will actually be built.
   */
  const price = presetMonthlyUsd(lockedGib === null ? p : { ...p, volume_gib: lockedGib });
  const spec = p.usable ? sizeSpec(p.size) : null;
  return (
    <button
      type="button"
      className="cr-pre"
      aria-pressed={on}
      disabled={!p.usable}
      title={p.usable ? undefined : `unknown size ${p.size}`}
      onClick={() => f.choosePreset(p.id)}
    >
      <span className="t">{p.name}</span>
      <span className="d">
        {spec === null ? "unknown size" : `${spec.id} · ${lockedGib ?? p.volume_gib} GiB`}
      </span>
      <span className="d">
        {spec === null
          ? p.size
          : `${spec.gpu ? `${spec.gpu.model.replace("NVIDIA ", "")} · ` : ""}${spec.vcpu} vCPU · ${spec.memGib} GiB`}
      </span>
      <span className="p">
        {price === null ? "—" : fmtUsd(price)}
        <small>/mo</small>
      </span>
      {on && f.changes > 0 ? (
        <span className="cr-plus">
          + {f.changes} change{f.changes === 1 ? "" : "s"}
        </span>
      ) : null}
    </button>
  );
}
