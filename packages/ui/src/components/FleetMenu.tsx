/**
 * The env strip's fleet control: the open fleet's name as a button, and the
 * popover it opens — §4.8's switcher over every fleet this home knows
 * (`FleetSwitcher.tsx`), the frozen config of the current one, a doctor run and
 * the way into Settings.
 *
 * It used to be the header's target block. It moved to the env strip because
 * that strip is already the line that names where an action lands (account,
 * region, tailnet), and the fleet is the one fact on it that can change — so
 * the control sits beside the facts it changes, and the header is left to the
 * views.
 *
 * The safety that used to come from immovability (§4.6 froze one home to one
 * fleet) comes from three things instead: the strip always names the open
 * fleet, a switch needs an explicit confirm on the row that offered it, and the
 * server refuses the move outright while any op is running.
 *
 * `popoverOpen` lives in `NavContext`, not here, so the keyboard handler and a
 * fleet switch can both close it. The doctor read is not here either: it is
 * the page's (`state/doctor-store.ts`), shared with Settings › Diagnostics, so
 * it survives closing the popover and a run in either place shows in both.
 */
import { useRef } from "react";
import type { Doctor, Meta } from "../api/index.ts";
import { useNav } from "../nav/nav-state.tsx";
import { runDoctor, useDoctor } from "../state/doctor-store.ts";
import { FleetSwitcher } from "./FleetSwitcher.tsx";
import { InlineScan } from "./Loading.tsx";
import { Popover } from "./Popover.tsx";

function DoctorCheck({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li>
      <i className={ok ? "doctor-check ok" : "doctor-check bad"} aria-hidden="true">
        {ok ? "✓" : "✕"}
      </i>
      {label}
    </li>
  );
}

function DoctorChecklist({ doctor }: { doctor: Doctor }) {
  return (
    <ul className="popover-doctor-list">
      <DoctorCheck
        ok={doctor.account.ok}
        label={`account ${doctor.account.ok ? "matches" : "MISMATCH"}`}
      />
      <DoctorCheck
        ok={doctor.foundation.present}
        label={`foundation ${doctor.foundation.present ? (doctor.foundation.status ?? "present") : "missing"}`}
      />
      <DoctorCheck
        ok={!doctor.foundation.outdated}
        label={
          doctor.foundation.outdated
            ? `foundation update available (v${doctor.foundation.version} → v${doctor.foundation.available_version})`
            : "foundation up to date"
        }
      />
      <DoctorCheck
        ok={doctor.security_group.ok}
        label={`${doctor.security_group.inbound_rules} inbound rule${doctor.security_group.inbound_rules === 1 ? "" : "s"}`}
      />
      <DoctorCheck
        ok={doctor.findings.length === 0}
        label={`${doctor.findings.length} finding${doctor.findings.length === 1 ? "" : "s"}`}
      />
    </ul>
  );
}

/**
 * §4.6: the alias when there is one, the fleet id when there is not — never
 * blank, and never `config.name`. The frozen config is read once when the
 * server opens a fleet and is not re-read on the meta poll, so falling back to
 * its cached label would keep showing an alias somebody cleared. `meta.fleet`
 * is the live answer; nothing else is.
 */
export function openFleetLabel(meta: Meta | null): string {
  const config = meta?.config ?? null;
  return (
    meta?.fleet?.alias ??
    meta?.fleet?.id ??
    config?.fleet_id ??
    config?.account_alias ??
    config?.profile ??
    "—"
  );
}

export function FleetMenu({ meta }: { meta: Meta | null }) {
  const { popoverOpen: open, setPopoverOpen: setOpen, openSettings } = useNav();
  const { doctor, busy: doctorLoading, error: doctorError } = useDoctor();
  const trigger = useRef<HTMLButtonElement>(null);
  const label = openFleetLabel(meta);

  return (
    <>
      <button
        type="button"
        ref={trigger}
        className={open ? "envstrip-fleet open" : "envstrip-fleet"}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Fleet ${label}, switch fleet`}
        title="Switch fleet, frozen config, doctor"
      >
        <span className="envstrip-fleet-kicker">fleet</span>
        <span className="envstrip-fleet-name">{label}</span>
        <span className="envstrip-fleet-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open ? (
        <Popover anchor={trigger} onClose={() => setOpen(false)} label="Fleet switcher">
          <div className="popover-body">
            <FleetSwitcher meta={meta} />
            <div className="popover-foot">
              <button
                type="button"
                className="popover-doctor-btn"
                onClick={runDoctor}
                disabled={doctorLoading}
              >
                {doctorLoading
                  ? "running…"
                  : doctorError
                    ? "Retry doctor"
                    : doctor
                      ? "run doctor again →"
                      : "run doctor →"}
              </button>
              {doctorLoading ? (
                <InlineScan label="doctor  running · sts · cloudformation · ec2" />
              ) : null}
              {doctorError ? (
                <div className="wiz-error mono" role="alert">
                  Could not run doctor: {doctorError}
                  {doctor ? " · showing the last good result" : ""}
                </div>
              ) : null}
              {doctor ? (
                <DoctorChecklist doctor={doctor} />
              ) : !doctorLoading && !doctorError ? (
                <div className="doctor mono">doctor not run</div>
              ) : null}
              <button
                type="button"
                className="btn btn-primary popover-settings"
                onClick={() => {
                  setOpen(false);
                  openSettings();
                }}
              >
                Settings →
              </button>
            </div>
          </div>
        </Popover>
      ) : null}
    </>
  );
}
