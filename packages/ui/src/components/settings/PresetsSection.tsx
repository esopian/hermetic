/**
 * This laptop › Create presets (§4.6): the four machines the New agent panel
 * offers, their order, which one it opens on, and the operator's own presets.
 *
 * Two blocks. The **loadout** is exactly what the panel's strip shows, left to
 * right: four cards, one of them DEFAULT, reordered by dragging (or, from the
 * keyboard, the card's `…` menu). The **library** is every preset in three
 * lanes — CPU, GPU, Custom — each row expanding in place for its details. The
 * tick adds a preset to the loadout or takes it out; with the loadout full, a
 * row is dropped on the card it should replace.
 *
 * Laptop-only and instant-save: every gesture computes the next document
 * (`preset-loadout.ts`), sends it (`presets.set`), and flashes `✓ saved`.
 * Built-ins are read-only; there is no duplicate — "+ New preset" is the one
 * way to make your own.
 */
import { useState } from "react";
import type { DragEvent, ReactNode } from "react";
import { BUILTIN_PRESETS } from "@hermetic/core/shared";
import type { MachinePreset, PresetView } from "@hermetic/core/shared";
import { ROOT_BOOTSTRAP_GIB, fmtUsd, sizeSpec, volumeMonthlyUsd } from "../../logic/format.ts";
import { presetMonthlyUsd } from "../../logic/create-presets.ts";
import {
  LOADOUT_FULL_HINT,
  deleteCustom,
  docOf,
  inLoadout,
  loadoutFull,
  mintPresetId,
  moveSlot,
  patchOf,
  placeInSlot,
  presetGlyph,
  removeSlot,
  setDefault,
  toggleInLoadout,
  upsertCustom,
} from "../../logic/preset-loadout.ts";
import type { LoadoutDoc } from "../../logic/preset-loadout.ts";
import { savePresets, usePresets } from "../../state/presets-store.ts";
import { PresetDrawer } from "./PresetDrawer.tsx";
import type { PresetDraft } from "./PresetDrawer.tsx";
import {
  Block,
  Overflow,
  PageFoot,
  SavedTick,
  SettingsPage,
  TextAction,
  useSavedTick,
} from "./Section.tsx";

/** What a drag carries: a library row (`preset:<id>`) or a loadout card (`slot:<n>`). */
const DRAG_TYPE = "text/plain";

type Editing = { draft: PresetDraft; inLoadout: boolean } | null;

function priceText(p: PresetView): string {
  const usd = presetMonthlyUsd(p);
  return usd === null ? "—" : fmtUsd(usd);
}

export function PresetsSection() {
  const { view, loaded } = usePresets();
  const doc = docOf(view);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ticked, flash] = useSavedTick();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  /** The row whose tick was refused by a full loadout, and so shows the hint. */
  const [fullHint, setFullHint] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [dropSlot, setDropSlot] = useState<number | null>(null);

  const byId = (id: string) => view.presets.find((p) => p.id === id) ?? null;

  async function save(next: LoadoutDoc | { reset: true }): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await savePresets("reset" in next ? { reset: true } : patchOf(next));
      flash();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function toggle(id: string) {
    const result = toggleInLoadout(doc, id);
    if (!result.ok) {
      setFullHint(id);
      return;
    }
    setFullHint(null);
    void save(result.doc);
  }

  function onDrop(e: DragEvent, slot: number) {
    e.preventDefault();
    setDropSlot(null);
    const data = e.dataTransfer.getData(DRAG_TYPE);
    if (data.startsWith("slot:")) {
      void save(moveSlot(doc, Number(data.slice(5)), slot));
    } else if (data.startsWith("preset:")) {
      const p = byId(data.slice(7));
      if (p !== null) {
        setFullHint(null);
        void save(placeInSlot(doc, p.id, slot));
      }
    }
  }

  function startNew() {
    setEditError(null);
    setEditing({
      draft: { id: null, name: "", size: "medium", volume_gib: 100, root_gib: 40 },
      inLoadout: false,
    });
  }

  function startEdit(p: PresetView) {
    setEditError(null);
    setEditing({
      draft: {
        id: p.id,
        name: p.name,
        size: sizeSpec(p.size).id,
        volume_gib: p.volume_gib,
        root_gib: p.root_gib,
      },
      inLoadout: inLoadout(doc, p.id),
    });
  }

  async function saveEdit(next: Omit<MachinePreset, "id"> & { id: string | null }, load: boolean) {
    const preset: MachinePreset = { ...next, id: next.id ?? mintPresetId(next.name, doc) };
    const result = upsertCustom(doc, preset, load);
    if (!result.ok) {
      setEditError(LOADOUT_FULL_HINT);
      return;
    }
    setEditError(null);
    if (await save(result.doc)) setEditing(null);
  }

  async function remove(id: string) {
    if (await save(deleteCustom(doc, id))) setEditing(null);
  }

  const filled = doc.loadout.filter((id) => id !== null).length;
  const lanes: { key: "cpu" | "gpu" | "custom"; title: string; glyph: string }[] = [
    { key: "cpu", title: "CPU · built-in", glyph: "C" },
    { key: "gpu", title: "GPU · built-in", glyph: "G" },
    { key: "custom", title: "Custom", glyph: "+" },
  ];

  return (
    <SettingsPage
      section="presets"
      scope="laptop"
      desc="The four starting points the New agent panel offers. Other laptops keep their own."
      primary={
        <button type="button" className="btn btn-primary" onClick={startNew}>
          + New preset
        </button>
      }
    >
      <Block
        title={`Loadout · ${filled} of ${doc.loadout.length}`}
        right={
          <>
            <SavedTick on={ticked} />
            <TextAction
              onClick={() => void save({ reset: true })}
              busy={busy}
              allowed={
                view.source === "builtin"
                  ? { ok: false, reason: "already the built-in loadout" }
                  : { ok: true }
              }
            >
              Reset to built-in
            </TextAction>
          </>
        }
      >
        {error !== null ? <p className="st-err pr-err">{error}</p> : null}
        <div className="pr-load" role="group" aria-label="Loadout">
          {doc.loadout.map((id, slot) => {
            const p = id === null ? null : byId(id);
            return (
              <LoadoutCard
                key={slot}
                slot={slot}
                preset={p}
                isDefault={p !== null && p.id === doc.default}
                dropping={dropSlot === slot}
                busy={busy}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDropSlot(slot);
                }}
                onDragLeave={() => setDropSlot((s) => (s === slot ? null : s))}
                onDrop={(e) => onDrop(e, slot)}
                onMove={(to) => void save(moveSlot(doc, slot, to))}
                onDefault={() => p !== null && void save(setDefault(doc, p.id))}
                onRemove={() => void save(removeSlot(doc, slot))}
              />
            );
          })}
        </div>
        <p className="pr-note">
          Drag to reorder · “…” on a card: Move, Set as default, Remove · loadout full: drop a preset on
          a card to swap it in
        </p>
      </Block>

      <Block
        title="Library"
        right={<span className="mono dim">prices: instance + data + system disk</span>}
      >
        <div className="pr-lib">
          {lanes.map((lane) => {
            const rows = view.presets.filter((p) => p.lane === lane.key);
            return (
              <div className="pr-col" key={lane.key} role="group" aria-label={lane.title}>
                <div className="pr-colh">
                  <span
                    className={`pr-g sm${lane.key === "gpu" ? " pr-g-gpu" : ""}${lane.key === "custom" ? " pr-g-custom" : ""}`}
                    aria-hidden="true"
                  >
                    {lane.glyph}
                  </span>
                  {lane.title}
                </div>
                {rows.map((p) => (
                  <LibraryRow
                    key={p.id}
                    p={p}
                    inLoadout={inLoadout(doc, p.id)}
                    expanded={open.has(p.id)}
                    fullHint={fullHint === p.id}
                    busy={busy}
                    onExpand={() =>
                      setOpen((prev) => {
                        const next = new Set(prev);
                        if (next.has(p.id)) next.delete(p.id);
                        else next.add(p.id);
                        return next;
                      })
                    }
                    onToggle={() => toggle(p.id)}
                    onEdit={() => startEdit(p)}
                    onDelete={() => void remove(p.id)}
                  />
                ))}
                {lane.key === "gpu" ? (
                  <p className="pr-note">NVIDIA T4G (G5g). Arm, 16 GiB VRAM per GPU.</p>
                ) : null}
                {lane.key === "custom" ? (
                  <>
                    <button type="button" className="pr-add" onClick={startNew}>
                      + New preset
                    </button>
                    <p className="pr-note">Built-ins are read-only. Use + New preset for your own.</p>
                  </>
                ) : null}
              </div>
            );
          })}
        </div>
      </Block>

      <PageFoot>
        {loaded
          ? "saves as you change it · this laptop's hermetic.db · prefs"
          : `showing the ${BUILTIN_PRESETS.length} built-ins · reading this laptop's presets…`}
      </PageFoot>

      {editing !== null ? (
        <PresetDrawer
          key={editing.draft.id ?? "new"}
          preset={editing.draft}
          inLoadout={editing.inLoadout}
          loadoutFull={loadoutFull(doc)}
          busy={busy}
          error={editError ?? error}
          onSave={(next, load) => void saveEdit(next, load)}
          onDelete={editing.draft.id === null ? null : () => void remove(editing.draft.id as string)}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </SettingsPage>
  );
}

function LoadoutCard({
  slot,
  preset,
  isDefault,
  dropping,
  busy,
  onDragOver,
  onDragLeave,
  onDrop,
  onMove,
  onDefault,
  onRemove,
}: {
  slot: number;
  preset: PresetView | null;
  isDefault: boolean;
  dropping: boolean;
  busy: boolean;
  onDragOver: (e: DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: DragEvent) => void;
  onMove: (to: number) => void;
  onDefault: () => void;
  onRemove: () => void;
}) {
  const cls = ["pr-card"];
  if (isDefault) cls.push("pr-def");
  if (dropping || preset === null) cls.push("pr-drop");
  const drop = { onDragOver, onDragLeave, onDrop };
  if (preset === null) {
    return (
      <div className={cls.join(" ")} data-slot={slot} {...drop}>
        <span className="pr-sub">Slot {slot + 1}</span>
        <b className="pr-empty">Drop a preset here</b>
        <span className="pr-sub">or tick one in the library</span>
      </div>
    );
  }
  const spec = preset.usable ? sizeSpec(preset.size) : null;
  const price = presetMonthlyUsd(preset);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dragging is the pointer path; the card's menu is the keyboard one
    <div
      className={cls.join(" ")}
      data-slot={slot}
      data-preset={preset.id}
      draggable={!busy}
      onDragStart={(e) => e.dataTransfer.setData(DRAG_TYPE, `slot:${slot}`)}
      {...drop}
    >
      {isDefault ? <span className="pr-deftag">Default</span> : null}
      <span className="pr-grip" aria-hidden="true">
        ⠿
      </span>
      <span
        className={`pr-g${spec?.family === "gpu" ? " pr-g-gpu" : ""}${preset.builtin ? "" : " pr-g-custom"}`}
        aria-hidden="true"
      >
        {presetGlyph(preset)}
      </span>
      <b>{preset.name}</b>
      <span className="pr-sub">
        {spec === null ? `unknown size ${preset.size}` : `${spec.id} · ${spec.instance_type}`}
      </span>
      <span className="pr-sub">
        {preset.volume_gib} GiB data · {preset.root_gib} GiB system
      </span>
      <span className="pr-cost">{price === null ? "—" : `≈ ${fmtUsd(price)}/mo`}</span>
      <div className="pr-cardmenu">
        <Overflow
          label={`More actions for ${preset.name}`}
          disabled={busy}
          items={[
            {
              label: "Move left",
              onSelect: () => onMove(slot - 1),
              allowed: slot === 0 ? { ok: false, reason: "already first" } : { ok: true },
            },
            {
              label: "Move right",
              onSelect: () => onMove(slot + 1),
              allowed: slot === 3 ? { ok: false, reason: "already last" } : { ok: true },
            },
            {
              label: "Set as default",
              onSelect: onDefault,
              allowed: isDefault ? { ok: false, reason: "already the default" } : { ok: true },
            },
            { label: "Remove", onSelect: onRemove, danger: true },
          ]}
        />
      </div>
    </div>
  );
}

function LibraryRow({
  p,
  inLoadout: isIn,
  expanded,
  fullHint,
  busy,
  onExpand,
  onToggle,
  onEdit,
  onDelete,
}: {
  p: PresetView;
  inLoadout: boolean;
  expanded: boolean;
  fullHint: boolean;
  busy: boolean;
  onExpand: () => void;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const spec = p.usable ? sizeSpec(p.size) : null;
  const tick = (
    <button
      type="button"
      className={isIn ? "pr-tick on" : "pr-tick"}
      aria-pressed={isIn}
      aria-label={isIn ? `Remove ${p.name} from the loadout` : `Add ${p.name} to the loadout`}
      disabled={busy || (!p.usable && !isIn)}
      title={p.usable ? undefined : `unknown size ${p.size}`}
      onClick={onToggle}
    >
      {isIn ? "✓" : ""}
    </button>
  );
  const row = (
    // biome-ignore lint/a11y/noStaticElementInteractions: dragging a row onto a card is the pointer path; the tick and the card menu are the keyboard one
    <div
      className={isIn ? "pr-row in" : "pr-row"}
      data-preset={p.id}
      draggable={!busy && p.usable}
      onDragStart={(e) => e.dataTransfer.setData(DRAG_TYPE, `preset:${p.id}`)}
    >
      <button
        type="button"
        className="pr-car"
        aria-expanded={expanded}
        aria-label={`${expanded ? "Hide" : "Show"} details for ${p.name}`}
        onClick={onExpand}
      >
        {expanded ? "▾" : "▸"}
      </button>
      <b>{p.name}</b>
      {tick}
      <span className="pr-rc mono">{p.usable ? priceText(p) : "unknown size"}</span>
      <span className="pr-grip" aria-hidden="true">
        ⠿
      </span>
    </div>
  );
  const hint = fullHint ? (
    <p className="pr-full" role="status">
      {LOADOUT_FULL_HINT}
    </p>
  ) : null;
  if (!expanded) {
    return (
      <>
        {row}
        {hint}
      </>
    );
  }
  const instance = spec === null ? null : spec.monthlyUsd;
  const data = volumeMonthlyUsd(p.volume_gib);
  const system = volumeMonthlyUsd(p.root_gib);
  const total = presetMonthlyUsd(p);
  const kv = (k: string, v: ReactNode) => (
    <>
      <span className="k">{k}</span>
      <span className="v mono">{v}</span>
    </>
  );
  return (
    <div className="pr-exp">
      {row}
      {hint}
      <div className="pr-det">
        <div className="kv pr-kv">
          {kv("size", spec === null ? `${p.size} (unknown)` : `${spec.id} · ${spec.instance_type}`)}
          {kv(
            "cpu · mem",
            spec === null
              ? "—"
              : `${spec.vcpu} vCPU · ${spec.memGib} GiB${spec.gpu ? ` · ${spec.gpu.count}× ${spec.gpu.model}` : ""}`,
          )}
          {kv("data volume", `${p.volume_gib} GiB gp3`)}
          {kv(
            "system disk",
            `${p.root_gib} GiB · ≈${Math.max(0, p.root_gib - ROOT_BOOTSTRAP_GIB)} free`,
          )}
        </div>
        <div className="pr-cb mono">
          <span>instance {instance === null ? "—" : `$${instance.toFixed(2)}`}</span>
          <span>+ data ${data.toFixed(2)}</span>
          <span>+ system ${system.toFixed(2)}</span>
          <b>{total === null ? "—" : `≈ ${fmtUsd(total)}/mo`}</b>
        </div>
        <div className="pr-acts">
          <TextAction
            onClick={onToggle}
            busy={busy}
            allowed={
              !p.usable && !isIn ? { ok: false, reason: `unknown size ${p.size}` } : { ok: true }
            }
          >
            {isIn ? "In loadout ✓" : "Add to loadout"}
          </TextAction>
          {p.builtin ? null : (
            <>
              <TextAction onClick={onEdit} busy={busy} label={`Edit ${p.name}`}>
                Edit
              </TextAction>
              <TextAction onClick={onDelete} busy={busy} tone="danger" label={`Delete ${p.name}`}>
                Delete
              </TextAction>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
