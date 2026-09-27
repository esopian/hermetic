/**
 * Everything a create can state beyond the name, the brain and the preset,
 * behind one disclosure: Machine, Storage, Behaviour.
 *
 * Every field carries a tag saying where its value comes from. Size, data
 * volume and system disk read `from preset` — the selected loadout card states
 * them — until they are moved off it, and then `changed · reset`, where reset
 * puts the preset's value back. Secrets, On failure and Approvals read `fleet
 * default` until touched: such a field is omitted and inherits
 * (`create-form.ts`), and its reset untouches it. With no preset in the
 * loadout, the machine fields inherit the same way.
 */
import { useMemo, useState } from "react";
import {
  ROOT_BOOTSTRAP_GIB,
  ROOT_GIB_MAX,
  ROOT_GIB_MIN,
  SIZES,
  volumeMonthlyUsd,
} from "../../logic/format.ts";
import type { SizeSpec } from "../../logic/format.ts";
import type { ApprovalsMode, SecretsMode } from "../../logic/create-form.ts";
import { APPROVALS_MODES } from "../../logic/settings-logic.ts";
import { Field, Seg, SizeCells, Slider } from "./controls.tsx";
import { INHERITED_HINT, INHERITED_VALUE, isPrimarySize } from "./useCreateForm.ts";
import type { CreateFormModel } from "./useCreateForm.ts";

/**
 * The canonical data-volume sizes. Not the whole list the picker renders: the
 * fleet's own default is unioned in, because a `Seg` whose value is not one of
 * its cells draws with nothing selected.
 */
const VOLUMES = [50, 100, 200, 500];
const PRIMARY_SIZES = SIZES.filter((s) => isPrimarySize(s.id));
const MORE_CPU_SIZES = SIZES.filter((s) => s.family === "cpu" && !isPrimarySize(s.id));
const GPU_SIZES = SIZES.filter((s) => s.family === "gpu");
const SECRETS_OPTIONS = ["none", "bitwarden"] as const;
const ROLLBACK_OPTIONS = ["keep for re-run", "roll back"] as const;
/**
 * §6.4's approvals modes, with `""` first: there is no fleet value to show,
 * because the fleet's answer reaches the agent by the request leaving the field
 * out. So the empty option is not a placeholder — it is the choice.
 */
const APPROVALS_OPTIONS = ["", ...APPROVALS_MODES] as const satisfies readonly (ApprovalsMode | "")[];

export function Customize({ f, initiallyOpen }: { f: CreateFormModel; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const summary =
    f.customized === 0
      ? f.preset === null
        ? "everything at fleet default"
        : `from ${f.preset.name}`
      : `${f.customized} field${f.customized === 1 ? "" : "s"} changed`;
  return (
    <div className={open ? "cr-disc cr-open" : "cr-disc"}>
      <div className="cr-disc-h">
        <button
          type="button"
          className="cr-disc-t"
          aria-expanded={open}
          aria-controls="create-customize"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "▾" : "▸"} Customize
        </button>
        {open && f.customized > 0 ? (
          <button type="button" className="linklike cr-resetall" onClick={f.resetAll}>
            {f.preset === null ? "Reset all to fleet default" : "Reset all"}
          </button>
        ) : (
          <span className="cr-disc-s mono">{summary}</span>
        )}
      </div>
      {open ? (
        <div id="create-customize">
          <Machine f={f} />
          <Storage f={f} />
          <Behaviour f={f} />
        </div>
      ) : (
        <div className="cr-disc-sum mono">
          machine · storage · behaviour (secrets, on failure, approvals)
        </div>
      )}
    </div>
  );
}

function Machine({ f }: { f: CreateFormModel }) {
  const shown: SizeSpec["id"] | null = f.inherits("size") ? null : f.size;
  const more = MORE_CPU_SIZES.length;
  return (
    <div className="cr-grp">
      <h5 className="kicker">Machine</h5>
      <Field
        label="Size"
        changed={f.fieldChanged("size")}
        onReset={() => f.resetField("size")}
        source={f.preset === null ? "fleet" : "preset"}
        hint={f.inherits("size") ? INHERITED_HINT : undefined}
      >
        <SizeCells sizes={PRIMARY_SIZES} size={shown} onChoose={f.chooseSize} />
        {!f.showMoreSizes ? (
          <button
            type="button"
            className="more-sizes"
            aria-expanded={false}
            onClick={() => f.setShowMoreSizes(true)}
          >
            More sizes ({more} CPU, {GPU_SIZES.length} GPU) →
          </button>
        ) : (
          <div className="more-size-groups">
            <div>
              <div className="kicker more-sizes-title">More CPU sizes</div>
              <SizeCells
                sizes={MORE_CPU_SIZES}
                size={shown}
                onChoose={f.chooseSize}
                label="More CPU sizes"
              />
            </div>
            <div>
              <div className="kicker more-sizes-title">GPU accelerated</div>
              <SizeCells sizes={GPU_SIZES} size={shown} onChoose={f.chooseSize} label="GPU sizes" />
            </div>
          </div>
        )}
      </Field>
    </div>
  );
}

function Storage({ f }: { f: CreateFormModel }) {
  const { defaults, volume } = f;
  /**
   * The picker offers the fleet's own default alongside the canonical sizes,
   * and whatever a restored draft chose, so the pressed cell is always one of
   * them.
   */
  const choices = useMemo(
    () => Array.from(new Set([...VOLUMES, defaults.volume_gib, volume])).sort((a, b) => a - b),
    [defaults.volume_gib, volume],
  );
  const rootInherits = f.inherits("root_gib");
  const headroom = f.rootGib - ROOT_BOOTSTRAP_GIB;
  return (
    <div className="cr-grp">
      <h5 className="kicker">Storage</h5>
      {f.locked ? null : (
        <Field
          label="Data volume"
          changed={f.fieldChanged("volume_gib")}
          onReset={() => f.resetField("volume_gib")}
          source={f.preset === null ? "fleet" : "preset"}
          hint={
            f.inherits("volume_gib")
              ? `gp3 · kept across rebuilds · ${INHERITED_HINT}`
              : "gp3 · kept across rebuilds and on destroy unless asked · bills while stopped"
          }
        >
          <Seg
            label="Data volume"
            values={choices}
            value={f.inherits("volume_gib") ? null : volume}
            onChange={f.chooseVolume}
            format={(v) => `${v} GiB`}
            price={(v) => `$${Math.round(volumeMonthlyUsd(v))}/mo`}
          />
        </Field>
      )}
      <Field
        label="System disk"
        changed={f.fieldChanged("root_gib")}
        onReset={() => f.resetField("root_gib")}
        source={f.preset === null ? "fleet" : "preset"}
        hint={
          /*
           * The headroom is a subtraction from the value on the track, so it
           * says nothing while that value is the placeholder under an unread
           * fleet default.
           */
          rootInherits ? (
            `~${ROOT_BOOTSTRAP_GIB} GiB used by Ubuntu + Hermes + browser · ${INHERITED_HINT}`
          ) : (
            <>
              ~{ROOT_BOOTSTRAP_GIB} GiB used by Ubuntu + Hermes + browser, leaving{" "}
              <b style={{ color: headroom < 4 ? "var(--warn)" : "var(--fg2)" }}>≈{headroom} GiB</b> ·
              replaced on every rebuild
            </>
          )
        }
      >
        <Slider
          label="System disk"
          value={f.rootGib}
          min={ROOT_GIB_MIN}
          max={ROOT_GIB_MAX}
          onChange={f.chooseRoot}
          format={(v) =>
            rootInherits ? INHERITED_VALUE : `${v} GiB · $${volumeMonthlyUsd(v).toFixed(2)}/mo`
          }
        />
      </Field>
    </div>
  );
}

function Behaviour({ f }: { f: CreateFormModel }) {
  const secretsInherit = f.inherits("secrets");
  return (
    <div className="cr-grp">
      <h5 className="kicker">Behaviour</h5>
      <Field
        label="Secrets"
        changed={f.touched.has("secrets")}
        onReset={() => f.untouch("secrets")}
        hint={secretsInherit ? INHERITED_HINT : undefined}
        control={(id) => (
          <div className="select-wrap">
            <select
              id={id}
              className="select-input"
              value={secretsInherit ? INHERITED_VALUE : f.secrets}
              onChange={(e) => {
                // Re-picking "fleet default" is not a choice, and must not
                // become one: it would pin the placeholder as an override.
                if (e.target.value === INHERITED_VALUE) return;
                f.chooseSecrets(e.target.value as SecretsMode);
              }}
            >
              {secretsInherit ? <option value={INHERITED_VALUE}>{INHERITED_VALUE}</option> : null}
              {SECRETS_OPTIONS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>
        )}
      />
      <Field
        label="On failure"
        changed={f.touched.has("rollback")}
        onReset={() => f.untouch("rollback")}
        control={(id) => (
          <div className="select-wrap">
            <select
              id={id}
              className="select-input"
              value={f.rollback ? "roll back" : "keep for re-run"}
              onChange={(e) => f.chooseRollback(e.target.value === "roll back")}
            >
              {ROLLBACK_OPTIONS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>
        )}
      />
      <Field
        label="Approvals"
        changed={f.approvals !== ""}
        onReset={() => f.setApprovals("")}
        hint="seeded: the agent can still change it from its own dashboard"
        control={(id) => (
          <div className="select-wrap">
            <select
              id={id}
              className="select-input"
              value={f.approvals}
              onChange={(e) => f.setApprovals(e.target.value as ApprovalsMode | "")}
            >
              {APPROVALS_OPTIONS.map((v) => (
                <option key={v} value={v}>
                  {v === "" ? INHERITED_VALUE : v}
                </option>
              ))}
            </select>
          </div>
        )}
      />
    </div>
  );
}
