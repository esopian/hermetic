/**
 * The frozen config, read-only (§4.6): which account this home is bound to and
 * what it was bound with. Almost nothing here is editable — `init` froze it,
 * and the only way to move it is a teardown or a second home.
 *
 * The §4.8 exceptions are commands rather than settings, so the page is still
 * read-only in the sense its badge means: the fleet's display *alias* (a
 * directory write, saved as it is pressed), and which fleet this laptop means
 * by default (the same "make default" the header switcher offers, per row of
 * the account's fleet list). The directory block at the foot is a read of the
 * account-global table itself — where it lives, and what protects it — fetched
 * here rather than carried on `/api/meta` because it is a real DynamoDB round
 * trip nobody owes the dashboard on every boot.
 */
import { Fragment, useEffect, useId, useRef, useState } from "react";
import { getDirectory, setDefaultFleet, setFleetAlias } from "../../api/index.ts";
import type { DirectoryStatus, LocalConfig, Meta } from "../../api/index.ts";
import { fmtDate } from "../../logic/format.ts";
import { defaultable, fleetBadge, fleetLabel, sortFleets } from "../../nav/fleet-switch.ts";
import type { FleetListEntry } from "../../nav/fleet-switch.ts";
import { Skel } from "../Loading.tsx";
import { useFleetIfAvailable } from "../../state/state.tsx";
import {
  Block,
  Facts,
  SavedTick,
  SettingRow,
  SettingsPage,
  Sq,
  TextAction,
  useSavedTick,
} from "./Section.tsx";
import type { Allowed } from "./Section.tsx";

/** The block's rows, named once so the skeleton and the answer are the same shape. */
const DIRECTORY_KEYS = [
  "region",
  "table",
  "exists",
  "point-in-time recovery",
  "deletion protection",
  "items",
] as const;

/** `pitr_recovery_days` spelled the way the operator reads it in the console. */
function pitrLine(d: DirectoryStatus): string {
  if (!d.pitr_enabled) return "off";
  return d.pitr_recovery_days === null ? "on" : `on, ${d.pitr_recovery_days}-day window`;
}

function DirectoryBlock() {
  const [status, setStatus] = useState<DirectoryStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getDirectory()
      .then((d) => {
        if (alive) setStatus(d);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Block title="Fleet directory" right={<span className="mono dim">account-wide · §4.8</span>}>
      {error !== null ? (
        <div className="st-hint mono st-err">could not read the fleet directory: {error}</div>
      ) : status === null ? (
        // Every key it will have, so the block does not grow under the reader
        // when the read lands. Same rule the fleet board follows: a skeleton is
        // the shape of the answer, not a placeholder of some other size.
        <div className="kv">
          {DIRECTORY_KEYS.map((k) => (
            <Fragment key={k}>
              <span className="k">{k}</span>
              <span className="v mono">
                <Skel w="150px" />
              </span>
            </Fragment>
          ))}
        </div>
      ) : (
        <div className="kv">
          <span className="k">region</span>
          <span className="v mono">{status.region}</span>
          <span className="k">table</span>
          <span className="v mono">{status.table}</span>
          <span className="k">exists</span>
          <span className="v mono">{status.exists ? "yes" : "no"}</span>
          <span className="k">point-in-time recovery</span>
          <span className="v mono">{pitrLine(status)}</span>
          <span className="k">deletion protection</span>
          <span className="v mono">{status.deletion_protection ? "on" : "off"}</span>
          <span className="k">items</span>
          <span className="v mono">{status.item_count === null ? "—" : status.item_count}</span>
        </div>
      )}
    </Block>
  );
}

/** Why a fleet cannot be made this laptop's default, said before the click. */
function defaultAllowed(f: FleetListEntry): Allowed {
  if (defaultable(f)) return { ok: true };
  if (f.default) return { ok: false, reason: "already this laptop's default" };
  if (!f.local) return { ok: false, reason: "not frozen in this home — attach to it first" };
  return { ok: false, reason: "torn down" };
}

const BADGE_TONE = { ok: "ok", warn: "warn", muted: "off" } as const;

function FleetsBlock({
  fleets,
  busy,
  onMakeDefault,
}: {
  fleets: readonly FleetListEntry[];
  busy: boolean;
  onMakeDefault: (fleetId: string) => void;
}) {
  const rows = sortFleets([...fleets]);
  return (
    <Block title={`Fleets · ${rows.length}`} right={<span className="mono dim">in this account</span>}>
      <table className="st-list">
        <thead>
          <tr>
            <th aria-label="State" />
            <th>Fleet</th>
            <th>Region</th>
            <th>Foundation</th>
            <th className="st-acts">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => {
            const badge = fleetBadge(f);
            const label = fleetLabel(f);
            return (
              <tr key={f.fleet_id ?? label} data-fleet={f.fleet_id ?? undefined}>
                <td className="st-c-sq">
                  <Sq tone={BADGE_TONE[badge.kind]} title={badge.label} />
                </td>
                <td>
                  <div className="st-name">
                    <b className="mono">{label}</b>
                    {f.current ? <span className="tag ghost">this fleet</span> : null}
                    {f.default ? <span className="tag">default</span> : null}
                  </div>
                  {f.name !== null && f.fleet_id !== null ? (
                    <div className="mono st-sub">{f.fleet_id}</div>
                  ) : null}
                </td>
                <td className="mono st-cell-sm">{f.region ?? "—"}</td>
                <td className="mono st-cell-sm">{badge.label}</td>
                <td className="st-acts">
                  <TextAction
                    busy={busy}
                    allowed={defaultAllowed(f)}
                    label={`Make ${label} the default`}
                    onClick={() => {
                      if (f.fleet_id !== null) onMakeDefault(f.fleet_id);
                    }}
                  >
                    Make default
                  </TextAction>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Block>
  );
}

export function AccountSection({ config, meta }: { config: LocalConfig | null; meta: Meta | null }) {
  const aliasId = useId();
  const fleet = useFleetIfAvailable();
  const fleets = fleet?.fleets ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aliasDraft, setAliasDraft] = useState("");
  const [aliasTicked, flashAlias] = useSavedTick();
  const fleetId = meta?.fleet?.id ?? config?.fleet_id ?? null;
  /**
   * §4.6: the alias is the directory's, so the fleet *list* is its authority —
   * `/api/meta` caches for a few seconds and a "save alias" has to show at
   * once. The meta copy is the fallback until the list has answered.
   */
  const authoritative =
    fleetId === null ? undefined : fleets?.find((entry) => entry.fleet_id === fleetId);
  const alias = authoritative ? authoritative.name : (meta?.fleet?.alias ?? null);
  /**
   * Seeded per *fleet*, not per poll. `/api/meta` and the fleet list are both
   * polled, so reseeding whenever the alias value arrives again would wipe
   * whatever the operator had half-typed every few seconds. Switching fleets is
   * the only moment this field is describing something else, so that is the
   * only moment it is refilled; `saveAlias` is what writes it back.
   */
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (seededFor.current === fleetId) return;
    seededFor.current = fleetId;
    setAliasDraft(alias ?? "");
  }, [fleetId, alias]);
  /**
   * Nothing is said about the default until something has reported one. Before
   * either source answers, "default" and "make default" are both claims — one
   * that this fleet is the default, one that it is not — so the row shows the
   * label alone rather than picking a side of a question nobody has asked the
   * server yet.
   */
  const known = fleets !== null || meta?.fleet !== undefined;
  // The list is the authority on which fleet is the default: `meta.fleet.default`
  // names it too, but the list is what a "make default" write refreshes.
  const isDefault =
    fleetId !== null &&
    (fleets?.some((f) => f.fleet_id === fleetId && f.default) ?? meta?.fleet?.default === fleetId);

  const makeDefault = async (id: string | null) => {
    if (id === null) return;
    setBusy(true);
    setError(null);
    try {
      await setDefaultFleet(id);
      await fleet?.refreshFleets();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveAlias = async (clear = false) => {
    if (fleetId === null) return;
    setBusy(true);
    setError(null);
    try {
      await setFleetAlias(fleetId, clear ? null : aliasDraft.trim() === "" ? null : aliasDraft.trim());
      if (clear) setAliasDraft("");
      await fleet?.refreshFleets();
      flashAlias();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsPage
      section="account"
      scope="readonly"
      desc="The AWS account this home was frozen to at init, and the fleets in it."
    >
      <Block title="This home">
        <Facts
          items={[
            // §4.6: the alias when there is one, the fleet id when there is not.
            { k: "Fleet", v: alias ?? fleetId ?? "—" },
            { k: "Account id", v: config?.account_id ?? "—" },
            { k: "Region", v: config?.region ?? "—" },
            { k: "Frozen", v: config ? fmtDate(config.frozen_at) : "—" },
          ]}
        />
        <div className="kv">
          <span className="k">fleet</span>
          <span className="v mono">
            {alias ?? fleetId ?? "—"}
            {!known || fleetId === null ? null : isDefault ? (
              <span className="fleet-sw-tag" style={{ marginLeft: 10 }}>
                default
              </span>
            ) : (
              <button
                type="button"
                className="fleet-sw-link"
                style={{ marginLeft: 10 }}
                disabled={busy}
                onClick={() => void makeDefault(fleetId)}
              >
                make default
              </button>
            )}
          </span>
          <span className="k">profile</span>
          <span className="v mono">{config?.profile ?? "—"}</span>
          <span className="k">account id</span>
          <span className="v mono">{config?.account_id ?? "—"}</span>
          <span className="k">account alias</span>
          <span className="v mono">{config?.account_alias ?? "—"}</span>
          <span className="k">org id</span>
          <span className="v mono">{config?.org_id ?? "—"}</span>
          <span className="k">fleet id</span>
          <span className="v mono">{config?.fleet_id ?? "—"}</span>
          <span className="k">stack id</span>
          <span className="v mono">{config?.stack_id ?? "—"}</span>
          <span className="k">home path</span>
          <span className="v mono">{meta?.home ?? "—"}</span>
          <span className="k">hermeticd</span>
          <span className="v mono">{meta?.hermeticd_version ?? "—"}</span>
          <span className="k">hermes</span>
          <span className="v mono">{meta?.hermes_version ?? "—"}</span>
          <span className="k">tailnet</span>
          <span className="v mono">{meta?.tailnet ?? config?.tailnet ?? "—"}</span>
          <span className="k">tailscale oauth client</span>
          <span className="v mono">{config?.tailscale_oauth_client_id ?? "—"}</span>
        </div>
        {error === null ? null : (
          <div className="st-hint mono st-err" role="alert">
            {error}
          </div>
        )}

        {/*
          Guidance, not a form. The rotation needs a client created by hand in
          the Tailscale admin console (there is no API), and the secret must not
          travel through a field it could be autofilled into or left in — so the
          page points at the CLI rather than offering to take the value (§8.3).

          Folded away: nothing here reports a problem, so it is an answer to a
          question ("how do I replace this client?") rather than news, and it
          waits until the question is asked. The live verdict on whether the
          current client is *missing* a scope is the Tailnet policy section's to
          report, where it is read from Tailscale rather than guessed at.
        */}
        <details className="hint-more" style={{ marginTop: 12 }}>
          <summary>Replacing this OAuth client</summary>
          <p>
            The secret never travels through this page — rotation is one CLI command, and it prompts for
            the value:
          </p>
          <p className="mono">hermetic secrets push _fleet --tailscale-oauth</p>
          <p>
            Tailscale cannot add a scope to a client that already exists, so widening what hermetic may
            do means replacing the client rather than editing it. In the Tailscale admin console, under
            Settings → OAuth clients, generate one with these three scopes:
          </p>
          <ul>
            <li>
              <b>Auth Keys</b> — Write, tagged <span className="mono">tag:hermetic</span>. Lets hermetic
              enrol a new agent onto the tailnet.
            </li>
            <li>
              <b>Devices → Core</b> — Read and Write, tagged <span className="mono">tag:hermetic</span>.
              Lets it notice stale devices and clean up after a recreate.
            </li>
            <li>
              <b>Policy File</b> — Read and Write. Lets it keep the tailnet ACL blocks it manages in
              step.
            </li>
          </ul>
          <p>Then run the command above and paste the new secret when it asks.</p>
        </details>
      </Block>

      <Block title="Display alias">
        <SettingRow
          label="Fleet display alias"
          desc="Shown instead of the fleet id. The id stays the identity; saved as you press Save."
          htmlFor={aliasId}
          state={<SavedTick on={aliasTicked} />}
        >
          <input
            id={aliasId}
            className="key-input st-w"
            value={aliasDraft}
            placeholder={fleetId ?? ""}
            disabled={busy || fleetId === null}
            onChange={(event) => setAliasDraft(event.target.value)}
          />
          <TextAction busy={busy || fleetId === null} onClick={() => void saveAlias()}>
            Save
          </TextAction>
          <TextAction busy={busy || fleetId === null} onClick={() => void saveAlias(true)}>
            Clear
          </TextAction>
        </SettingRow>
      </Block>

      {fleets === null || fleets.length === 0 ? null : (
        <FleetsBlock fleets={fleets} busy={busy} onMakeDefault={(id) => void makeDefault(id)} />
      )}

      <DirectoryBlock />
    </SettingsPage>
  );
}
