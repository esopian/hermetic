/**
 * Settings → Notifications: the rules that decide how much of the inbox
 * interrupts, and the full inbox itself.
 *
 * Two things in one section on purpose. The rules are unreadable in the
 * abstract — "should health changes toast?" is a question nobody can answer
 * without seeing how many health changes there are — so the archive they are
 * about is on the same page, below them.
 *
 * Everything here is *this laptop's* (§7.1 item 4), which is why the page has
 * no save bar: delivery mode, quiet hours and the desktop permission only
 * change what this app does with a row, so they live in `localStorage`, not in
 * `_fleet.settings`, and each control saves as it is touched and flashes
 * `✓ saved`. Mutes go to core rather than `localStorage`, because they are
 * about the rows themselves and the CLI's `hermetic inbox` on this machine has
 * to agree — but they are still this home's, not the fleet's.
 */
import { useMemo, useState } from "react";
import {
  DELIVERIES,
  PREF_GROUPS,
  desktopAllowed,
  inQuietHours,
  isResolved,
} from "../../logic/notification-logic.ts";
import type { Delivery, PrefGroup } from "../../logic/notification-logic.ts";
import { useNotify } from "../../state/notify-state.tsx";
import type { MuteTarget } from "../../state/notify-state.tsx";
import type { NotificationSourceView } from "../../api/index.ts";
import { NotificationRow } from "../notify/NotificationRow.tsx";
import {
  Block,
  PageFoot,
  RowNote,
  SavedTick,
  SettingRow,
  SettingsPage,
  Sq,
  TextAction,
  useSavedTick,
} from "./Section.tsx";

const DELIVERY_LABEL: Record<Delivery, string> = { off: "Off", inbox: "Inbox", toast: "Toast" };

/** The sources a mute may name, matching core's `NotificationSource`. */
const MUTEABLE_SOURCES: readonly NotificationSourceView[] = [
  "operation",
  "agent",
  "fleet",
  "chat",
  "budget",
];

/**
 * A `<select>` value and the tail of a `source:<name>` mute target are both
 * plain strings; the route takes the enum. Narrow here rather than assert, so a
 * source this build does not know about is a no-op instead of a failed write.
 */
function asSource(value: string): NotificationSourceView | null {
  return MUTEABLE_SOURCES.find((s) => s === value) ?? null;
}

function RuleRow({
  id,
  label,
  what,
  delivery,
  desktop,
  onDelivery,
  onDesktop,
}: {
  id: PrefGroup;
  label: string;
  what: string;
  delivery: Delivery;
  desktop: boolean;
  onDelivery: (d: Delivery) => void;
  onDesktop: (on: boolean) => void;
}) {
  const [ticked, flash] = useSavedTick();
  const allowed = desktopAllowed(delivery);
  return (
    <SettingRow label={label} desc={what} field={id} state={<SavedTick on={ticked} />}>
      <div className="seg st-seg nt-seg" role="group" aria-label={`${label} delivery`}>
        {DELIVERIES.map((d) => (
          <button
            type="button"
            key={d}
            aria-pressed={delivery === d}
            onClick={() => {
              onDelivery(d);
              flash();
            }}
          >
            {DELIVERY_LABEL[d]}
          </button>
        ))}
      </div>
      <label
        className="st-check"
        title={allowed ? undefined : "Only a group that toasts can raise a desktop notification"}
      >
        <input
          type="checkbox"
          checked={allowed && desktop}
          disabled={!allowed}
          onChange={(e) => {
            onDesktop(e.target.checked);
            flash();
          }}
          aria-label={`${label}: desktop notification`}
          data-group={id}
        />
        desktop
      </label>
    </SettingRow>
  );
}

function permissionLine(p: ReturnType<typeof useNotify>["desktopPermission"]): string {
  switch (p) {
    case "granted":
      return "Granted · banners fire only while the app is open.";
    case "denied":
      return "Blocked. Nothing here can re-ask; the permission has to be reset outside the app.";
    case "unsupported":
      return "No desktop notification API here. Toasts still work.";
    default:
      return "Desktop notifications need permission first.";
  }
}

export function NotificationsSection() {
  const notify = useNotify();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [muteAgent, setMuteAgent] = useState("");
  const [muteSource, setMuteSource] = useState<NotificationSourceView | "">("");
  const [quietTicked, flashQuiet] = useSavedTick();
  const now = Date.now();

  /**
   * "Unread only" means the rows the unread count is counting, and core does not
   * count a row whose condition has cleared — so neither does this filter. The
   * full list still holds them, marked as history: a cleared condition is a
   * record, not an item of work, and the two lists say so the same way the
   * centre's `all` and `needs you` tabs do.
   */
  const rows = useMemo(
    () => (unreadOnly ? notify.items.filter((n) => !n.read_at && !isResolved(n)) : notify.items),
    [notify.items, unreadOnly],
  );

  const prefs = notify.prefs;
  const setDelivery = (group: PrefGroup, delivery: Delivery) => {
    notify.setPrefs({ ...prefs, delivery: { ...prefs.delivery, [group]: delivery } });
  };
  const setDesktop = (group: PrefGroup, on: boolean) => {
    notify.setPrefs({ ...prefs, desktop: { ...prefs.desktop, [group]: on } });
  };
  const setQuiet = (patch: Partial<typeof prefs.quiet>) => {
    notify.setPrefs({ ...prefs, quiet: { ...prefs.quiet, ...patch } });
    flashQuiet();
  };

  const holding = inQuietHours(new Date(now), prefs.quiet);

  return (
    <SettingsPage
      section="notifications"
      scope="laptop"
      desc="What reaches you, and how. Only this laptop; another laptop on the fleet keeps its own."
      primary={
        <button type="button" className="btn btn-secondary" onClick={notify.sendTest}>
          Send test
        </button>
      }
    >
      <Block title="Desktop">
        <SettingRow label="Desktop notifications" desc={permissionLine(notify.desktopPermission)}>
          {notify.desktopPermission === "default" ? (
            <button type="button" className="btn-mini" onClick={() => void notify.requestDesktop()}>
              Ask for permission
            </button>
          ) : (
            <span className="mono st-cell-sm">{notify.desktopPermission}</span>
          )}
        </SettingRow>
      </Block>

      {/* Delivery is per source and three-valued, because "off" and "in the
          inbox but silent" are different requests. */}
      <Block title="Rules" right={<span className="mono dim">off · inbox only · toast</span>}>
        {PREF_GROUPS.map((g) => (
          <RuleRow
            key={g.id}
            id={g.id}
            label={g.label}
            what={g.what}
            delivery={prefs.delivery[g.id]}
            desktop={prefs.desktop[g.id]}
            onDelivery={(d) => setDelivery(g.id, d)}
            onDesktop={(on) => setDesktop(g.id, on)}
          />
        ))}
      </Block>

      <Block title="Quiet hours">
        <SettingRow
          label="Quiet hours"
          desc="Toasts and desktop banners are held; the inbox still fills. Approvals are never held."
          state={
            <>
              {quietTicked ? null : <RowNote>{holding ? "holding now" : "not holding"}</RowNote>}
              <SavedTick on={quietTicked} />
            </>
          }
        >
          <label className="st-check">
            <input
              type="checkbox"
              checked={prefs.quiet.enabled}
              onChange={(e) => setQuiet({ enabled: e.target.checked })}
              aria-label="Quiet hours on"
            />
            on
          </label>
          <input
            type="time"
            className="st-time"
            value={prefs.quiet.start}
            aria-label="Quiet hours start"
            onChange={(e) => setQuiet({ start: e.target.value })}
          />
          <span className="dim">to</span>
          <input
            type="time"
            className="st-time"
            value={prefs.quiet.end}
            aria-label="Quiet hours end"
            onChange={(e) => setQuiet({ end: e.target.value })}
          />
        </SettingRow>
      </Block>

      {/* Per agent and per source. Muting hides toasts and clears the badge;
          the row is still written, and still readable in the inbox below. */}
      <Block title={`Muted · ${notify.mutes.length}`}>
        {notify.mutes.length === 0 ? (
          <div className="st-hint mono">Nothing is muted.</div>
        ) : (
          <table className="st-list">
            <tbody>
              {notify.mutes.map((m) => {
                const [kind, ...rest] = m.target.split(":");
                const name = rest.join(":");
                const source = asSource(name);
                const target: MuteTarget | null =
                  kind === "agent" ? { agent: name } : source ? { source } : null;
                return (
                  <tr key={m.target} data-mute={m.target}>
                    <td className="st-c-sq">
                      <Sq tone="off" />
                    </td>
                    <td>
                      <b className="mono">{name || m.target}</b>
                    </td>
                    <td className="mono st-cell-sm">{kind === "agent" ? "agent" : "source"}</td>
                    <td className="st-acts">
                      <TextAction
                        label={`Unmute ${m.target}`}
                        allowed={target ? { ok: true } : { ok: false, reason: "unknown mute target" }}
                        onClick={() => {
                          if (target) void notify.unmute(target);
                        }}
                      >
                        Unmute
                      </TextAction>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div className="st-mute-add">
          <input
            className="st-inline-input"
            placeholder="agent name"
            value={muteAgent}
            aria-label="Mute an agent by name"
            onChange={(e) => setMuteAgent(e.target.value)}
          />
          <button
            type="button"
            className="btn-mini"
            disabled={muteAgent.trim().length === 0}
            onClick={() => {
              void notify.mute({ agent: muteAgent.trim() });
              setMuteAgent("");
            }}
          >
            Mute agent
          </button>
          <select
            className="st-inline-input"
            value={muteSource}
            aria-label="Mute a source"
            onChange={(e) => setMuteSource(asSource(e.target.value) ?? "")}
          >
            <option value="">source…</option>
            {MUTEABLE_SOURCES.map((s) => (
              <option value={s} key={s}>
                {s}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn-mini"
            disabled={muteSource === ""}
            onClick={() => {
              if (muteSource === "") return;
              void notify.mute({ source: muteSource });
              setMuteSource("");
            }}
          >
            Mute source
          </button>
        </div>
      </Block>

      <Block
        title="Inbox"
        right={
          <>
            <TextAction onClick={() => void notify.ackAll()}>Mark all read</TextAction>
            <TextAction onClick={() => void notify.refresh()}>Refresh</TextAction>
          </>
        }
      >
        <div className="nt-inbox-bar">
          <label className="st-check">
            <input
              type="checkbox"
              checked={unreadOnly}
              onChange={(e) => setUnreadOnly(e.target.checked)}
            />
            unread only
          </label>
          <span className="mono st-cell-sm nt-inbox-count">
            {notify.unread} unread · {notify.needsAction} need you
          </span>
        </div>
        {notify.error ? (
          <div className="wiz-error mono" role="alert">
            Could not read the inbox: {notify.error}
          </div>
        ) : null}
        <div className="nt-inbox">
          {rows.length === 0 ? (
            <div className="nt-empty mono">
              {unreadOnly
                ? "Nothing unread."
                : "Nothing yet. Failed and finished operations, health changes and fleet advisories land here."}
            </div>
          ) : (
            rows.map((n) => (
              <NotificationRow key={n.id} n={n} now={now} onAck={(id) => void notify.ack(id)} />
            ))
          )}
        </div>
      </Block>

      <PageFoot>saves as you change it · rules in this app&apos;s storage, mutes in this home</PageFoot>
    </SettingsPage>
  );
}
