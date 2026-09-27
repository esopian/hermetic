/**
 * The custom-preset editor (Settings › Create presets, §4.6): a right drawer
 * with the machine and nothing else — name, size, data volume, system disk —
 * plus whether the preset sits in the loadout.
 *
 * No provider profile or model: those are picked in the New agent panel each
 * time. Approvals, secrets and the Hermes seeds come from Fleet › Defaults.
 */
import { useId, useState } from "react";
import { LOADOUT_SLOTS, PRESET_NAME_MAX, ROOT_GIB_MAX, ROOT_GIB_MIN } from "@hermetic/core/shared";
import type { MachinePreset } from "@hermetic/core/shared";
import { ROOT_BOOTSTRAP_GIB, SIZES, fmtUsd, volumeMonthlyUsd } from "../../logic/format.ts";
import type { SizeSpec } from "../../logic/format.ts";
import { machineMonthlyUsd } from "../../logic/create-presets.ts";
import { LOADOUT_FULL_HINT } from "../../logic/preset-loadout.ts";
import { Drawer, DrawerHead } from "../Drawer.tsx";
import { Seg, SizeCells, Slider } from "../create/controls.tsx";
import { isPrimarySize } from "../create/useCreateForm.ts";

const VOLUMES = [50, 100, 200, 300, 500];
const PRIMARY_SIZES = SIZES.filter((s) => isPrimarySize(s.id));
const MORE_CPU_SIZES = SIZES.filter((s) => s.family === "cpu" && !isPrimarySize(s.id));
const GPU_SIZES = SIZES.filter((s) => s.family === "gpu");

export interface PresetDraft {
  /** `null` while creating: the id is minted from the name on Save. */
  id: string | null;
  name: string;
  size: SizeSpec["id"];
  volume_gib: number;
  root_gib: number;
}

export function PresetDrawer({
  preset,
  inLoadout,
  loadoutFull,
  busy,
  error,
  onSave,
  onDelete,
  onClose,
}: {
  /** The preset being edited, or a starting point for a new one (`id: null`). */
  preset: PresetDraft;
  inLoadout: boolean;
  /** Every slot filled — ticking "In the loadout" cannot add another. */
  loadoutFull: boolean;
  busy: boolean;
  error: string | null;
  onSave: (next: Omit<MachinePreset, "id"> & { id: string | null }, inLoadout: boolean) => void;
  onDelete: (() => void) | null;
  onClose: () => void;
}) {
  const ids = useId();
  const [name, setName] = useState(preset.name);
  const [size, setSize] = useState<SizeSpec["id"]>(preset.size);
  const [volume, setVolume] = useState(preset.volume_gib);
  const [root, setRoot] = useState(preset.root_gib);
  const [load, setLoad] = useState(inLoadout);
  const [more, setMore] = useState(!isPrimarySize(preset.size));
  const creating = preset.id === null;
  const trimmed = name.trim();
  const blocked =
    trimmed === ""
      ? "name the preset"
      : trimmed.length > PRESET_NAME_MAX
        ? `at most ${PRESET_NAME_MAX} characters`
        : null;
  // Only adding is refused on a full loadout; one already in it may stay or go.
  const cannotAdd = loadoutFull && !inLoadout;
  const total = machineMonthlyUsd({ size, volume_gib: volume, root_gib: root });
  const choices = Array.from(new Set([...VOLUMES, volume])).sort((a, b) => a - b);

  return (
    <Drawer width={600} onClose={onClose} labelledBy={`${ids}-title`}>
      <DrawerHead
        titleId={`${ids}-title`}
        kicker={creating ? "Create preset · custom" : `Create preset · ${preset.id}`}
        title={creating ? "New preset" : `Edit ${preset.name}`}
        sub={
          <div className="pr-drawer-sub">
            <span className="st-scope st-laptop">This laptop only</span>
            <span className="mono dim">{inLoadout ? "in loadout" : "not in loadout"}</span>
          </div>
        }
        onClose={onClose}
      />
      <div className="form">
        <label style={{ display: "block" }} htmlFor={`${ids}-name`}>
          <div className="kicker" style={{ marginBottom: 8 }}>
            Name
          </div>
          <input
            id={`${ids}-name`}
            className="key-input"
            data-autofocus
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="e.g. research"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <div>
          <div className="kicker" style={{ marginBottom: 8 }}>
            Size
          </div>
          <SizeCells sizes={PRIMARY_SIZES} size={size} onChoose={setSize} />
          {!more ? (
            <button
              type="button"
              className="more-sizes"
              aria-expanded={false}
              onClick={() => setMore(true)}
            >
              More sizes ({MORE_CPU_SIZES.length} CPU, {GPU_SIZES.length} GPU) →
            </button>
          ) : (
            <div className="more-size-groups">
              <div>
                <div className="kicker more-sizes-title">More CPU sizes</div>
                <SizeCells
                  sizes={MORE_CPU_SIZES}
                  size={size}
                  onChoose={setSize}
                  label="More CPU sizes"
                />
              </div>
              <div>
                <div className="kicker more-sizes-title">GPU accelerated</div>
                <SizeCells sizes={GPU_SIZES} size={size} onChoose={setSize} label="GPU sizes" />
              </div>
            </div>
          )}
        </div>

        <div>
          <div className="kicker" style={{ marginBottom: 8 }}>
            Data volume
          </div>
          <Seg
            label="Data volume"
            values={choices}
            value={volume}
            onChange={setVolume}
            format={(v) => `${v} GiB`}
            price={(v) => `$${Math.round(volumeMonthlyUsd(v))}/mo`}
          />
        </div>

        <div>
          <div className="kicker" style={{ marginBottom: 8 }}>
            System disk
          </div>
          <Slider
            label="System disk"
            value={root}
            min={ROOT_GIB_MIN}
            max={ROOT_GIB_MAX}
            onChange={setRoot}
            format={(v) => `${v} GiB · ≈${Math.max(0, v - ROOT_BOOTSTRAP_GIB)} free`}
          />
        </div>

        <label className="pr-check">
          <input
            type="checkbox"
            checked={load}
            disabled={cannotAdd}
            onChange={(e) => setLoad(e.target.checked)}
          />
          <span>In the loadout</span>
          <small className="mono dim">
            {cannotAdd
              ? LOADOUT_FULL_HINT
              : `one of the ${LOADOUT_SLOTS} presets the New agent panel offers`}
          </small>
        </label>

        <p className="pr-note">
          No provider profile or model here: you pick those in the New agent panel each time. Approvals,
          secrets and Hermes settings come from Fleet › Defaults.
        </p>

        {error !== null ? (
          <div className="mono" style={{ color: "var(--bad)", fontSize: 12 }}>
            {error}
          </div>
        ) : null}
      </div>

      <div className="drawer-foot">
        <div className="pr-total">
          <span className="kicker">Total</span> <b>≈{fmtUsd(total)}/mo</b>
        </div>
        <span style={{ display: "flex", gap: 8 }}>
          {onDelete !== null ? (
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={onDelete}>
              Delete
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || blocked !== null}
            title={blocked ?? undefined}
            onClick={() =>
              onSave({ id: preset.id, name: trimmed, size, volume_gib: volume, root_gib: root }, load)
            }
          >
            {busy ? "Saving…" : "Save preset"}
          </button>
        </span>
      </div>
    </Drawer>
  );
}
