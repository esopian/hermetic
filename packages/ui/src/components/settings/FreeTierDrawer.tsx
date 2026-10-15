/**
 * Settings › Defaults › AWS Free Tier (§10): the help and the confirm in one
 * drawer — what the Free Tier is, what a fleet uses against it, and exactly
 * what "Set to AWS Free Tier" is about to write.
 *
 * Every figure is read from `AWS_FREE_TIER` (`@hermetic/core/shared`); the
 * copy here explains them and restates none. The plan is computed by
 * `logic/free-tier.ts`, the same functions the Apply button sends.
 */
import { useId } from "react";
import { AWS_FREE_TIER, DEFAULT_ROOT_GIB } from "@hermetic/core/shared";
import type { FreeTierPlan, FreeTierTreatment, PresetsView } from "@hermetic/core/shared";
import type { SettingsResult } from "../../api/index.ts";
import { machineMonthlyUsd } from "../../logic/create-presets.ts";
import { fmtUsd, sizeSpec } from "../../logic/format.ts";
import { freeTierPresetsPlan } from "../../logic/free-tier.ts";
import type { FreeTierState } from "../../logic/free-tier.ts";
import type { SaveError } from "../../logic/settings-logic.ts";
import { Drawer, DrawerHead } from "../Drawer.tsx";

const TREATMENT: Record<FreeTierTreatment, { label: string; tone: string }> = {
  set: { label: "set", tone: "acc" },
  within: { label: "within", tone: "ok" },
  not_covered: { label: "billed", tone: "warn" },
};

const PLAN: Record<FreeTierPlan, string> = {
  legacy: "legacy plan",
  always: "all accounts",
  none: "—",
};

/** `hermetic presets set --loadout` spells an empty slot `-`. */
function loadoutArg(loadout: readonly (string | null)[]): string {
  return loadout.map((id) => id ?? "-").join(",");
}

function sizeText(id: string): string {
  const s = sizeSpec(id);
  return `${id} · ${s.instance_type}`;
}

function presetName(view: PresetsView, id: string | null): string {
  if (id === null) return "none";
  return view.presets.find((p) => p.id === id)?.name ?? id;
}

/** "13 Oct 2026" — explicit locale and options, per AGENTS.md's renderer rules. */
function fmtDay(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function FreeTierDrawer({
  result,
  presets,
  state,
  busy,
  error,
  readError,
  onRetryRead,
  onApply,
  onClose,
}: {
  result: SettingsResult;
  /** This laptop's presets, or `null` while unread — the laptop half then waits. */
  presets: PresetsView | null;
  state: FreeTierState;
  busy: boolean;
  error: SaveError | null;
  /** This laptop's presets could not be read: Apply waits on a retry rather than guessing. */
  readError: string | null;
  onRetryRead: () => void;
  onApply: () => void;
  onClose: () => void;
}) {
  const ids = useId();
  const b = AWS_FREE_TIER;
  const m = b.machine;
  const d = result.settings.defaults;
  const plan = presets === null ? null : freeTierPresetsPlan(presets);
  const applied = state.fleet && state.laptop === true;
  const list = fmtUsd(machineMonthlyUsd(m));
  const trial = b.arm_trial;

  const rows: Array<{ k: string; now: string; next: string; scope: string }> = [
    { k: "Size", now: sizeText(d.size), next: sizeText(m.size), scope: "fleet" },
    { k: "Data volume", now: `${d.volume_gib} GiB`, next: `${m.volume_gib} GiB`, scope: "fleet" },
    {
      k: "System disk",
      now: `${d.root_gib ?? DEFAULT_ROOT_GIB} GiB`,
      next: `${m.root_gib} GiB`,
      scope: "fleet",
    },
    {
      k: "Default create preset",
      now: presets === null ? "…" : presetName(presets, presets.default),
      next:
        plan === null
          ? "Free tier"
          : plan.replaces === null
            ? `Free tier (slot ${plan.slot})`
            : `Free tier (replaces ${presetName(presets as PresetsView, plan.replaces)} in slot ${plan.slot})`,
      scope: "laptop",
    },
  ];

  return (
    <Drawer width={720} onClose={onClose} labelledBy={`${ids}-title`}>
      <DrawerHead
        titleId={`${ids}-title`}
        kicker="Fleet › Defaults · AWS Free Tier"
        title="Set defaults to AWS Free Tier"
        sub={
          <div className="pr-drawer-sub">
            <span className="mono dim">figures reviewed {fmtDay(b.reviewed_on)}</span>
          </div>
        }
        onClose={onClose}
      />
      <div className="form ft-body">
        <section className="ft-sec" aria-labelledby={`${ids}-what`}>
          <h3 className="kicker" id={`${ids}-what`}>
            What the Free Tier is
          </h3>
          <p>
            AWS gives a new account a monthly allowance of some services at no charge. Which allowance
            you get depends on when the account was opened:
          </p>
          <ul className="ft-plans">
            <li>
              <b>Before 15 July 2025: legacy plan.</b> Fixed monthly allowances for 12 months. Use over
              an allowance is billed at normal rates. Eligible instance types:{" "}
              <span className="mono">{b.eligible_instance_types.legacy.join(", ")}</span>.
            </li>
            <li>
              <b>On or after 15 July 2025: Free plan.</b> ${b.free_plan_credits_usd.signup} of credits
              at sign-up, up to ${b.free_plan_credits_usd.max} in all, for 6 months or until the credits
              run out. Eligible instance types:{" "}
              <span className="mono">{b.eligible_instance_types.free_plan.join(", ")}</span>.
            </li>
          </ul>
          {trial !== null ? (
            <p>
              hermetic runs on Arm (Graviton), and on top of either plan AWS runs a{" "}
              <span className="mono">{trial.instance_type}</span> trial of {trial.hours_per_month} hours
              a month until {fmtDay(trial.ends_on)}. AWS states it is open to all customers, one trial
              per AWS Organization. The baseline uses that type.
            </p>
          ) : null}
        </section>

        <div className="st-callout warn">
          <b>The allowance covers one agent.</b> The {b.instance_hours_month} instance hours, and on the
          legacy plan the {b.ebs_gib_month} GB of EBS, are shared by the whole AWS account. A second
          agent, or an agent in another fleet on the same account, is billed.
        </div>
        <div className="st-callout warn">
          <b>On the Free plan this stretches credits; it is not free.</b> The legacy allowances below do
          not exist there: every charge draws the credits, and when the plan ends after 6 months the
          account closes, fleet included, unless it is upgraded to a paid plan.
        </div>
        <div className="st-callout warn">
          <b>2 GiB is tight.</b> Every agent runs Hermes and a headed browser stack, which want far more
          memory; that is why the standard size is 32 GiB. A Free Tier box suits light work and trying
          hermetic out, and will be slow under a browser. No larger Arm type is free.
        </div>

        <section className="ft-sec" aria-labelledby={`${ids}-plan`}>
          <h3 className="kicker" id={`${ids}-plan`}>
            What this button changes
          </h3>
          <table className="ft-table" data-testid="free-tier-plan">
            <thead>
              <tr>
                <th>Setting</th>
                <th>Now</th>
                <th>Free Tier</th>
                <th>Applies to</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.k} className={r.now === r.next ? "same" : undefined}>
                  <td>{r.k}</td>
                  <td className="mono">{r.now}</td>
                  <td className="mono">{r.next}</td>
                  <td>
                    <span className={`st-scope st-${r.scope}`}>
                      {r.scope === "fleet" ? "Fleet" : "This laptop"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="pr-note">
            Existing agents keep their machine; to move one, change it and recreate it. Network mode,
            secrets, provider profiles and the Hermes settings are not changed. From a terminal:{" "}
            <span className="mono">
              hermetic settings set --size {m.size} --volume-gib {m.volume_gib} --root-gib {m.root_gib}
            </span>{" "}
            and{" "}
            <span className="mono">
              hermetic presets set --loadout {plan === null ? "…" : loadoutArg(plan.loadout)} --default
              free-tier
            </span>
            .
          </p>
        </section>

        <section className="ft-sec" aria-labelledby={`${ids}-res`}>
          <h3 className="kicker" id={`${ids}-res`}>
            What a fleet uses against it
          </h3>
          <table className="ft-table ft-res" data-testid="free-tier-resources">
            <thead>
              <tr>
                <th>Resource</th>
                <th>Allowance</th>
                <th>hermetic</th>
                <th>Plan</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {b.resources.map((r) => (
                <tr key={r.id} data-resource={r.id}>
                  <td>{r.resource}</td>
                  <td>{r.allowance}</td>
                  <td>{r.hermetic}</td>
                  <td className="mono dim">{PLAN[r.plan]}</td>
                  <td>
                    <span className={`ft-badge ${TREATMENT[r.treatment].tone}`}>
                      {TREATMENT[r.treatment].label}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="pr-note">
            AWS revises these terms from time to time. Check your account&apos;s Billing › Free Tier
            page for what applies to you. Sources:{" "}
            {b.sources.map((s, i) => (
              <span key={s} className="mono">
                {i > 0 ? ", " : ""}
                {s.replace(/^https:\/\//, "")}
              </span>
            ))}
            .
          </p>
        </section>

        {readError !== null ? (
          <div className="mono" role="alert" style={{ color: "var(--bad)", fontSize: 12 }}>
            couldn&apos;t read this laptop&apos;s presets · {readError}{" "}
            <button type="button" className="linklike" onClick={onRetryRead}>
              Retry
            </button>
          </div>
        ) : null}
        {error !== null ? (
          <div className="mono" role="alert" style={{ color: "var(--bad)", fontSize: 12 }}>
            {error.code} · {error.message}
          </div>
        ) : null}
      </div>

      <div className="drawer-foot">
        <div className="pr-total">
          <span className="kicker">List price</span> <b>≈{list}/mo</b>
        </div>
        <span style={{ display: "flex", gap: 8 }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="btn btn-primary"
            data-autofocus
            disabled={busy || applied || presets === null}
            title={
              applied
                ? "Already applied"
                : presets === null
                  ? readError === null
                    ? "Reading presets…"
                    : "Retry reading presets first"
                  : undefined
            }
            onClick={onApply}
          >
            {busy ? "Applying…" : applied ? "Applied" : "Apply Free Tier defaults"}
          </button>
        </span>
      </div>
    </Drawer>
  );
}
