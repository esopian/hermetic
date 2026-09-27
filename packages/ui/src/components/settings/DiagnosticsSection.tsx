/**
 * `doctor` (§6.5), on demand. Its own section rather than a button under the
 * account table: the read walks EC2, DynamoDB and the tailnet, so it is a thing
 * an operator asks for, not a thing opening Settings does — which is also why
 * the rail carries no square for it.
 *
 * What it draws is the whole checklist — every check that ran and how it came
 * out, from `doctor-logic.ts` — not only the ones that failed. A green verdict
 * over an empty page could not distinguish a fleet with nothing wrong from a
 * check that never ran.
 */
import type { Doctor } from "../../api/index.ts";
import type { CheckState, DoctorCheck } from "../../logic/doctor-logic.ts";
import { checkTally, doctorChecks, tallyLine } from "../../logic/doctor-logic.ts";
import { runDoctor, useDoctor } from "../../state/doctor-store.ts";
import { Block, Callout, Facts, SettingsPage, Sq } from "./Section.tsx";
import type { SqTone } from "./Section.tsx";

/** The square beside a check, and the word beside the square. */
const STATE_LABEL: Record<CheckState, string> = {
  ok: "pass",
  warn: "look",
  bad: "fail",
  info: "note",
  skip: "unchecked",
};

const STATE_TONE: Record<CheckState, SqTone> = {
  ok: "ok",
  warn: "warn",
  bad: "bad",
  info: "off",
  skip: "off",
};

function CheckRow({ check }: { check: DoctorCheck }) {
  const items = check.items ?? [];
  const rows = (
    <ul className="st-items">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
  return (
    <tr data-check={check.id} data-state={check.state}>
      <td className="st-c-sq">
        <Sq tone={STATE_TONE[check.state]} />
      </td>
      <td>
        <b>{check.label}</b>
        <div className="st-why">{check.detail}</div>
        {/*
          A passing check's rows fold away behind their summary; anything else
          shows them, because on a check that did not pass those rows *are* the
          answer — which agent, which instance, which block.
        */}
        {items.length === 0 ? null : check.state === "ok" && check.items_summary ? (
          <details className="st-more-rows">
            <summary>{check.items_summary}</summary>
            {rows}
          </details>
        ) : (
          rows
        )}
      </td>
      <td className="mono st-cell-sm st-acts">{STATE_LABEL[check.state]}</td>
    </tr>
  );
}

/** The report: a status block over one list block per check group. */
export function DoctorPanel({ doctor }: { doctor: Doctor }) {
  const groups = doctorChecks(doctor);
  const tally = checkTally(groups);
  return (
    <>
      <Block title="Status">
        <Facts
          items={[
            {
              k: "Verdict",
              v: doctor.ok
                ? "OK"
                : `${doctor.findings.length} finding${doctor.findings.length === 1 ? "" : "s"}`,
              tone: doctor.ok ? "ok" : "warn",
            },
            { k: "Passed", v: String(tally.ok) },
            { k: "Failed", v: String(tally.bad), tone: tally.bad > 0 ? "bad" : undefined },
            { k: "To look at", v: String(tally.warn), tone: tally.warn > 0 ? "warn" : undefined },
          ]}
        />
        <div className="st-hint mono doctor-tally">{tallyLine(tally)}</div>
        {/*
          The findings, still first and still verbatim: they are the sentences
          core wrote, each naming its own fix, and they are what `ok` is derived
          from. The checklist below says the same things per check — plus every
          check that passed, which is the half that used to be invisible.
        */}
        {doctor.findings.length > 0 ? (
          <Callout tone="warn">
            <ul className="st-items st-findings">
              {doctor.findings.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </Callout>
        ) : (
          <Callout tone="ok">Nothing to fix.</Callout>
        )}
      </Block>

      {groups.map((g) => (
        <Block key={g.title} title={g.title}>
          <table className="st-list">
            <tbody>
              {g.checks.map((c) => (
                <CheckRow key={c.id} check={c} />
              ))}
            </tbody>
          </table>
        </Block>
      ))}
    </>
  );
}

export function DiagnosticsSection() {
  // The page's run, shared with the env strip's fleet popover: a run from
  // either one shows in both.
  const { doctor, busy, error } = useDoctor();

  return (
    <SettingsPage
      section="diagnostics"
      scope="readonly"
      desc="Walks EC2, DynamoDB, the tailnet and this laptop's tailscale, and reports every check. Changes nothing."
      primary={
        <button type="button" className="btn btn-primary" disabled={busy} onClick={runDoctor}>
          {busy ? "Running…" : doctor === null ? "Run doctor" : "Run doctor again"}
        </button>
      }
    >
      {error ? <div className="wiz-error mono">{error}</div> : null}
      {/* A failed re-run keeps the last good report on screen, under the error:
          it is still the most recent thing anybody knows. */}
      {doctor ? (
        <DoctorPanel doctor={doctor} />
      ) : error ? null : (
        <div className="st-hint mono">not run yet — Run doctor, top right</div>
      )}
    </SettingsPage>
  );
}
