/**
 * The two Bot Mode dialogs that create something on a gateway, and therefore
 * the two that have to know what the gateway supports.
 *
 * They live here rather than inline in `BotWorkspace` because the capability
 * sweep is a real call to a real box: mounting it with the workspace would probe
 * every instance the operator merely looked at, and every test that renders a
 * bot chat would need the route. Mounted with the dialog, the probe happens when
 * the operator asks to create something — which is also the moment its answer
 * matters.
 *
 * The instance picker is inside the dialog for the same reason the gate is: the
 * answer is per instance, so changing the picker re-probes and the note beneath
 * it changes with it.
 */
import { useState } from "react";
import type { SwarmView } from "../../api/index.ts";
import { HERMETIC_GATES, gateFor, roomGate, useBotCapabilities } from "../bot-capabilities.ts";
import { BotModeDialog, BotField } from "./BotModeDialog.tsx";
import { CapabilityNote, GatedNote, gateReason } from "./CapabilityNote.tsx";

/** The instance a create dialog is aimed at: the operator's choice, else a reachable one. */
function useChosenInstance(swarms: SwarmView[], initial: string) {
  const [chosen, setChosen] = useState("");
  const instance = chosen || initial || (swarms.find((s) => s.reachable)?.instance ?? "");
  return { instance, setChosen };
}

function InstancePicker({
  swarms,
  value,
  onChange,
}: {
  swarms: SwarmView[];
  value: string;
  onChange: (instance: string) => void;
}) {
  return (
    <label className="bm-field">
      Instance
      <select
        className="wiz-input"
        name="instance"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {swarms
          .filter((s) => s.reachable)
          .map((s) => (
            <option key={s.instance} value={s.instance}>
              {s.instance}
            </option>
          ))}
      </select>
    </label>
  );
}

export function BotCreateDialog({
  swarms,
  initialInstance,
  onClose,
  onSubmit,
}: {
  swarms: SwarmView[];
  initialInstance: string;
  onClose: () => void;
  onSubmit: (data: FormData) => Promise<void>;
}) {
  const { instance, setChosen } = useChosenInstance(swarms, initialInstance);
  const capabilities = useBotCapabilities(instance);
  const gate = gateFor(capabilities, "profiles");
  return (
    <BotModeDialog
      title="New bot"
      submit="Create bot"
      blocked={gate.allowed ? null : gateReason(gate)}
      onClose={onClose}
      onSubmit={onSubmit}
    >
      <InstancePicker swarms={swarms} value={instance} onChange={setChosen} />
      <CapabilityNote gate={gate} onRetry={capabilities.reload} />
      <BotField label="Profile name" name="name" required />
      {/* Desktop's create dialog asks for the same thing ("Title"); it is the
          name the roster shows, and a rename edits it later. */}
      <BotField label="Friendly name (optional)" name="title" maxLength={64} />
      <BotField label="Description" name="description" />
      <BotField label="Role" name="soul" textarea />
      <BotField label="Model (optional)" name="model" />
      <p className="bm-note">
        Creates a Hermes bot profile on the selected instance. Provider credentials remain managed
        separately.
      </p>
    </BotModeDialog>
  );
}

export function RoomCreateDialog({
  swarms,
  initialInstance,
  onClose,
  onSubmit,
}: {
  swarms: SwarmView[];
  initialInstance: string;
  onClose: () => void;
  onSubmit: (data: FormData) => Promise<void>;
}) {
  const { instance, setChosen } = useChosenInstance(swarms, initialInstance);
  const capabilities = useBotCapabilities(instance);
  const gate = roomGate(capabilities);
  return (
    <BotModeDialog
      title="New group room"
      submit="Create room"
      blocked={gate.allowed ? null : gateReason(gate)}
      onClose={onClose}
      onSubmit={onSubmit}
    >
      <InstancePicker swarms={swarms} value={instance} onChange={setChosen} />
      <CapabilityNote gate={gate} onRetry={capabilities.reload} />
      <BotField label="Room name" name="name" required />
      <p className="bm-note">Choose 2–6 bots on one instance.</p>
      <GatedNote>{HERMETIC_GATES.cross_instance_rooms}</GatedNote>
      <GatedNote>{HERMETIC_GATES.membership_edit}</GatedNote>
      {swarms
        .find((s) => s.instance === instance)
        ?.bots.map((b) => (
          <label className="bm-member-check" key={b.name}>
            <span>
              {b.title}
              <small>{b.name}</small>
            </span>
            <input type="checkbox" name="members" value={b.name} />
          </label>
        ))}
    </BotModeDialog>
  );
}
