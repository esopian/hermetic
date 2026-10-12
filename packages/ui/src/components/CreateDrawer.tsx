/**
 * Create: a form, then the op's own progress. The op runs in the engine, so
 * closing the drawer ("run in background") only detaches this view — the row
 * keeps moving on the fleet stream and reopening re-attaches to the op stream.
 *
 * The form is one short screen for the common case — name, brain, machine
 * preset, Create — with everything else behind one Customize disclosure. Its
 * state lives in `create/useCreateForm.ts`; the pieces under `create/` are
 * layout.
 */
import type { Meta, VolumeView } from "../api/index.ts";
import { CREATE_PHASES, labelsForOp, useOp } from "../lib/useOp.ts";
import type { ProfilesState } from "../state/state.tsx";
import { Drawer, DrawerHead } from "./Drawer.tsx";
import { DrawerEnvStrip } from "./EnvStrip.tsx";
import { useModelCatalog } from "./ModelPicker.tsx";
import { BrainChooser } from "./create/BrainChooser.tsx";
import { CreateFooter } from "./create/CreateFooter.tsx";
import { CreateProgress } from "./create/CreateProgress.tsx";
import { Customize } from "./create/Customize.tsx";
import { LockedVolume } from "./create/LockedVolume.tsx";
import { NameField } from "./create/NameField.tsx";
import { PresetStrip } from "./create/PresetStrip.tsx";
import type { CreateOp } from "./create/types.ts";
import { useCreateForm } from "./create/useCreateForm.ts";

export type { CreateOp } from "./create/types.ts";

/**
 * Create's own reading of the shared phase names (`useOp.ts`), so this rail and
 * the agent drawer's word the same op the same way. Module-level: `useOp` takes
 * it as a memo dependency.
 */
const CREATE_LABELS = labelsForOp("create");

export function CreateDrawer({
  meta,
  names,
  latest,
  tailnet,
  active,
  profiles,
  onVolume = null,
  onStart,
  onClose,
}: {
  meta: Meta | null;
  names: Set<string>;
  latest: string | null;
  tailnet: string;
  active: CreateOp | null;
  /**
   * §8.3: a create picks a *profile*, and never asks for a key. Only ready
   * profiles are offered — enabled, with a stored non-placeholder credential,
   * and (on Bedrock) with the model actually granted — because everything else
   * would produce an agent that boots and cannot answer.
   */
  profiles: ProfilesState;
  /**
   * §9's reclaim path: build this agent on a volume that already exists. The
   * volume becomes a locked row, no preset or field can change it, and the name
   * is prefilled from the volume's `agent` tag, or the former owner's name a
   * destroy released (`retained_by`, §6.7) — or the next free variant of it,
   * when a live agent has since taken that name.
   */
  onVolume?: VolumeView | null;
  onStart: (op: CreateOp) => void;
  onClose: () => void;
}) {
  const f = useCreateForm({ meta, names, tailnet, profiles, onVolume, onStart });
  const op = useOp(active?.opId ?? null, CREATE_PHASES, CREATE_LABELS);
  /**
   * The catalog is read for the *chosen profile*, using the credential the
   * fleet already holds — there is no key on this form to read it with, and
   * that is the point (§8.3). Read here rather than inside the brain popover so
   * it is ready when the popover opens.
   *
   * Keyed on `chosenReady`, not on `profileId !== ""`: a restored draft names a
   * profile before this drawer has re-read the list, and reading a catalog for
   * a profile that has been deleted is a request whose only possible answer is
   * an error the operator never asked for.
   */
  const catalog = useModelCatalog(f.chosenReady ? { profile: f.profileId } : null, f.chosenReady);

  const progress = active !== null;
  const done = op.finished;

  return (
    <Drawer width={560} onClose={onClose} labelledBy="create-title">
      <DrawerHead
        titleId="create-title"
        kicker={
          progress
            ? done
              ? op.ok
                ? "Complete"
                : "Failed"
              : "Creating · streaming from engine"
            : onVolume
              ? "New agent · on an existing volume"
              : "New agent"
        }
        title={
          progress
            ? done
              ? op.ok
                ? "Agent handed off"
                : "Create failed"
              : "Creating…"
            : onVolume
              ? `Create agent on ${onVolume.agent ?? "this"}’s volume`
              : "Create agent"
        }
        onClose={onClose}
      />
      <DrawerEnvStrip meta={meta} right={progress ? undefined : "Target"} />

      {!progress ? (
        <>
          <div className="form cr-form">
            <NameField f={f} names={names} />
            <BrainChooser f={f} catalog={catalog} defaultProfile={profiles.defaultProfile} />
            {onVolume ? <LockedVolume volume={onVolume} name={f.trimmed} /> : null}
            <PresetStrip f={f} lockedGib={onVolume?.size_gib ?? null} />
            {/*
              Opened when a restored draft already changed something: a choice
              made before the detour should be visible on the way back, not
              folded away behind a summary.
            */}
            <Customize f={f} initiallyOpen={f.customized > 0} />
            <div className="cr-facts mono">
              <span className="sq ok" /> Tailscale only · 0 inbound rules · no SSH key · Hermes{" "}
              {latest ?? "—"} · Chromium · noVNC desktop
            </div>
            {f.failure ? (
              <div className="mono" style={{ color: "var(--bad)", fontSize: 12 }}>
                {f.failure}
              </div>
            ) : null}
          </div>
          <CreateFooter f={f} onClose={onClose} />
        </>
      ) : (
        <CreateProgress active={active} op={op} onClose={onClose} />
      )}
    </Drawer>
  );
}
