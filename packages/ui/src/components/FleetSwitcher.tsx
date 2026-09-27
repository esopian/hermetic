/**
 * The fleet menu's popover body (`FleetMenu.tsx`): §4.8's fleet switcher.
 *
 * §4.6 froze one *home* to one account, and it still does — profile, account
 * and region below are read-only facts about the fleet currently open. What is
 * no longer frozen is which fleet of that account this portal is pointed at, so
 * this list is a control rather than a readout. The safety that used to come
 * from "there is nothing to click" now comes from three things instead: the
 * env strip always names the open fleet, no switch happens without an
 * explicit confirm on the row that asked for it, and the server refuses the
 * whole move while any op is in flight (`CONFLICT`, shown here inline).
 *
 * Every rule about *which* fleets can be switched to, in what order, and what
 * badge each one carries lives in `fleet-switch.ts`; this file is the markup
 * and the round trips.
 */
import { useCallback, useState } from "react";
import { setDefaultFleet } from "../api/index.ts";
import type { Meta } from "../api/index.ts";
import {
  confirmSwitchText,
  defaultable,
  fleetBadge,
  fleetLabel,
  sortFleets,
  switchability,
} from "../nav/fleet-switch.ts";
import type { FleetListEntry } from "../nav/fleet-switch.ts";
import { fmtDate } from "../logic/format.ts";
import { Skel } from "./Loading.tsx";
import { useFleet } from "../state/state.tsx";

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <>
      <span className="k">{k}</span>
      <span className="v mono" title={v}>
        {v}
      </span>
    </>
  );
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function FleetSwitcher({
  meta,
  facts = true,
}: {
  meta: Meta | null;
  /**
   * Whether to draw the current fleet's frozen config above the list. On in
   * the env strip's fleet menu, where the list is an addition to a readout that
   * already existed; off in the pre-open fleet picker, where there is no current fleet
   * and every one of those rows would be an em-dash pretending to be a fact.
   */
  facts?: boolean;
}) {
  const { fleets, fleetsError, directoryError, refreshFleets, switchTo } = useFleet();
  /** The row whose Switch was clicked; the confirm lives inside that row. */
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /**
   * The last refusal *and the row it belongs to*. Keyed rather than global
   * because the two actions here fail independently: a "make default" that
   * bounced on `staging` must not appear inside an open switch confirm on
   * `main`, where it would read as a reason that switch cannot proceed.
   */
  const [error, setError] = useState<{ fleet: string; message: string } | null>(null);

  const config = meta?.config ?? null;
  /**
   * §4.6: what the current fleet is *called* — its alias, else its id. Read
   * from `meta.fleet` and never from the frozen config's cached label, which is
   * captured when the server opens a fleet and never refreshed: a cleared alias
   * would go on being displayed until the portal restarted. Rows are keyed and
   * acted on by `fleet_id`; this string is only ever displayed.
   */
  const current = meta?.fleet?.alias ?? meta?.fleet?.id ?? config?.fleet_id ?? null;
  const factRows = !facts ? null : (
    <>
      <div className="popover-head">Frozen target · this home</div>
      <div className="fleet-sw-facts">
        <Fact k="profile" v={config?.profile ?? "—"} />
        <Fact k="account id" v={config?.account_id ?? "—"} />
        <Fact k="alias" v={config?.account_alias ?? "—"} />
        <Fact k="org id" v={config?.org_id ?? "—"} />
        <Fact k="region" v={config?.region ?? "—"} />
        <Fact k="fleet id" v={config?.fleet_id ?? "—"} />
        <Fact k="frozen at" v={config ? fmtDate(config.frozen_at) : "—"} />
        <Fact k="home" v={meta?.home ?? "—"} />
      </div>
    </>
  );

  const confirm = useCallback(
    async (fleetId: string) => {
      setBusy(fleetId);
      setError(null);
      try {
        await switchTo(fleetId);
        setPending(null);
      } catch (e) {
        // A refused switch is the most important thing on screen and the least
        // useful as a toast: it belongs beside the row that asked for it.
        setError({ fleet: fleetId, message: messageOf(e) });
      } finally {
        setBusy(null);
      }
    },
    [switchTo],
  );

  const makeDefault = useCallback(
    async (fleetId: string) => {
      setBusy(fleetId);
      setError(null);
      try {
        await setDefaultFleet(fleetId);
        await refreshFleets();
      } catch (e) {
        setError({ fleet: fleetId, message: messageOf(e) });
      } finally {
        setBusy(null);
      }
    },
    [refreshFleets],
  );

  return (
    <div className="fleet-sw">
      {factRows}

      <div className="popover-head">Fleets · this account</div>
      {/*
        An unread list is a skeleton, never an empty one: "no fleets" is a
        claim, and until `/api/fleets` answers nobody has grounds to make it.
      */}
      {fleets === null ? (
        <div className="fleet-sw-loading">
          <Skel w="60%" />
          <Skel w="40%" />
        </div>
      ) : fleets.length === 0 ? (
        <div className="fleet-sw-note mono">no fleets</div>
      ) : (
        <ul className="fleet-sw-list" aria-label="Fleets in this account">
          {sortFleets(fleets).map((f: FleetListEntry) => {
            const badge = fleetBadge(f);
            const { can, reason } = switchability(f);
            /**
             * §4.6: every key, every comparison and every request target is the
             * `fleet_id`. Keying any of them on the alias would give two
             * aliasless fleets one row key, one busy flag and one error slot.
             */
            const id = f.fleet_id;
            /**
             * `pending`, `busy` and `error.fleet` all start as `null`, so a row
             * whose id is somehow missing must never compare equal to "nothing
             * is pending" — that would open the confirm on a row nobody clicked.
             */
            const is = (held: string | null): boolean => id !== null && held === id;
            return (
              <li
                key={id ?? fleetLabel(f)}
                className={f.current ? "fleet-sw-row current" : "fleet-sw-row"}
              >
                <div className="fleet-sw-main">
                  <span className="fleet-sw-name">
                    <i className={`sq ${badge.kind}`} aria-hidden="true" />
                    <b>{fleetLabel(f)}</b>
                    {f.current ? <span className="fleet-sw-tag current">current</span> : null}
                    {f.default ? <span className="fleet-sw-tag">default</span> : null}
                  </span>
                  <span className="fleet-sw-sub mono">
                    {f.region ?? "—"} · {badge.label}
                  </span>
                </div>
                <div className="fleet-sw-actions">
                  {defaultable(f) ? (
                    <button
                      type="button"
                      className="fleet-sw-link"
                      disabled={busy !== null}
                      onClick={() => id !== null && void makeDefault(id)}
                    >
                      make default
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="fleet-sw-btn"
                    disabled={!can || busy !== null}
                    title={reason ?? undefined}
                    onClick={() => {
                      setError(null);
                      setPending(id);
                    }}
                  >
                    Switch
                  </button>
                </div>
                {/*
                  A disabled control with the reason only in its `title` is a
                  reason nobody reads: it needs a hover, a mouse and the
                  patience to wait for the tooltip. The current row is the one
                  exception — "current fleet" is already said by the tag beside
                  the name, so repeating it would be noise on the row an
                  operator looks at first.
                */}
                {can || f.current ? null : (
                  <div className="fleet-sw-note fleet-sw-reason mono">{reason}</div>
                )}
                {error !== null && is(error.fleet) && !is(pending) ? (
                  <div className="fleet-sw-note fleet-sw-error mono" role="alert">
                    {error.message}
                  </div>
                ) : null}
                {is(pending) ? (
                  <div className="fleet-sw-confirm">
                    <div className="fleet-sw-confirm-head">Confirm target change</div>
                    <div className="fleet-sw-confirm-line mono">{confirmSwitchText(current, f)}</div>
                    <div className="fleet-sw-confirm-note">
                      Every create, upgrade and teardown will run against this fleet. Unsaved settings
                      and open drafts will be discarded.
                    </div>
                    {error !== null && is(error.fleet) ? (
                      <div className="fleet-sw-error mono" role="alert">
                        {error.message}
                      </div>
                    ) : null}
                    <div className="fleet-sw-confirm-actions">
                      <button
                        type="button"
                        className="fleet-sw-go"
                        disabled={busy !== null}
                        onClick={() => id !== null && void confirm(id)}
                      >
                        {is(busy) ? "Switching…" : "Switch target"}
                      </button>
                      <button
                        type="button"
                        className="fleet-sw-cancel"
                        disabled={busy !== null}
                        onClick={() => {
                          setPending(null);
                          setError(null);
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {fleetsError === null ? null : (
        <div className="fleet-sw-note mono">could not read the fleet list: {fleetsError}</div>
      )}
      {directoryError === null ? null : (
        <div className="fleet-sw-note mono">directory unavailable: {directoryError}</div>
      )}
      {/*
        Only where there is something to add. A home with one fleet, frozen
        locally, has nowhere to attach *from* — the line would be a permanent
        instruction to solve a problem that laptop does not have, and the first
        thing an operator learns to stop reading. It appears the moment the
        account holds a fleet this home has not frozen, or more than one fleet
        at all.
      */}
      {(fleets ?? []).some((f) => (f.registered && !f.local) || (fleets ?? []).length > 1) ? (
        <div className="fleet-sw-note mono">
          to add a fleet frozen elsewhere: hermetic init --attach --fleet &lt;id&gt;
        </div>
      ) : null}
    </div>
  );
}

/**
 * §4.8's pre-open state, which is not the same thing as an uninitialized home.
 *
 * `FLEET_REQUIRED` (several fleets frozen here, none of them the default) and
 * `NOT_FOUND` (the one named is not frozen here) both leave the server with no
 * fleet open, and `/api/meta` therefore says `initialized: false` — but there
 * *is* a fleet to open, so showing the init wizard would answer a question
 * nobody asked and invite a second foundation onto an account that already has
 * one. This is the other answer: the same list the fleet menu carries, with no
 * current row to highlight, and `init` still one link away.
 */
export function FleetPicker({
  meta,
  onSetUpNewFleet,
}: {
  meta: Meta | null;
  /** Shows the init wizard instead: the operator has no fleet they want here. */
  onSetUpNewFleet: () => void;
}) {
  return (
    <div className="fleet-picker">
      <div className="fleet-picker-panel">
        <div className="kicker">This home · no fleet open</div>
        <h2 className="fleet-picker-title">Choose a fleet</h2>
        {meta?.fleet_error ? (
          <div className="fleet-picker-why mono">{meta.fleet_error.message}</div>
        ) : null}
        <FleetSwitcher meta={meta} facts={false} />
        <button type="button" className="fleet-sw-link fleet-picker-alt" onClick={onSetUpNewFleet}>
          set up a new fleet instead →
        </button>
      </div>
    </div>
  );
}
