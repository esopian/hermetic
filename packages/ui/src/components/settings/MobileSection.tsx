/**
 * Settings › Mobile: the bridge the Hermetic phone app talks to, served by this
 * app, and the phones paired with it.
 *
 * Three blocks. Bridge is the switch, the address and what the bridge is doing
 * right now (`mobile.serve`, followed only while the bridge is enabled, since
 * following starts it). Pair a phone is a short-lived code and its QR, held in
 * this component's state and nowhere else: it is a credential until it expires
 * or a phone spends it. Paired phones is the device list, with Revoke confirmed
 * in place.
 *
 * Everything here is local to this laptop (`mobile.*` takes no fleet envelope)
 * and saves as it is touched, like Chat.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { encodeQr, qrToSvg } from "@hermetic/core/shared";
import {
  fetchMobileDevices,
  fetchMobileSettings,
  followMobile,
  pairMobile,
  revokeMobileDevice,
  setMobileSettings,
} from "../../api/mobile.ts";
import type {
  MobileDeviceView,
  MobilePairView,
  MobileServingView,
  MobileSettingsView,
} from "../../api/types.ts";
import {
  type AddressDraft,
  DEFAULT_MOBILE_PORT,
  addressDirty,
  describeFeedEvent,
  draftOf,
  fmtClock,
  fmtCountdown,
  fmtStamp,
  formatPairCode,
  isWildcardHost,
  mobileFeedEvent,
  nextConnected,
  parseAddress,
  platformLabel,
} from "../../logic/mobile-logic.ts";
import { EmptyState } from "../EmptyState.tsx";
import { useTicker } from "../OpProgress.tsx";
import {
  Block,
  Callout,
  Facts,
  PageFoot,
  RowNote,
  SavedTick,
  SettingRow,
  SettingsPage,
  Sq,
  Tally,
  TextAction,
  useSavedTick,
} from "./Section.tsx";
import "./MobileSection.css";

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type Follow = "off" | "following" | "unavailable";

/** A pair URL as an SVG QR, or `null` when it is too long for the encoder (a long host name). */
function qrSvgOf(url: string): string | null {
  try {
    return qrToSvg(encodeQr(url));
  } catch {
    return null;
  }
}

/**
 * The QR for a pair URL, drawn from core's encoder. The SVG is numbers only: no
 * input text reaches the markup. A URL the encoder cannot fit shows as text
 * instead — the phone can still pair by pasting it or typing the code.
 */
function PairQr({ url }: { url: string }) {
  const svg = useMemo(() => qrSvgOf(url), [url]);
  if (svg === null) {
    return (
      <span className="mob-pair-url" data-testid="pair-url">
        <span className="kicker">Pair URL (too long for a QR)</span>
        <span className="mono" style={{ overflowWrap: "anywhere" }}>
          {url}
        </span>
      </span>
    );
  }
  return (
    <span
      className="mob-qr"
      role="img"
      aria-label="Pairing QR code"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: core's QR encoder emits fixed markup and module coordinates, never the URL itself.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function PairPanel({
  pairing,
  serving,
  busy,
  onRegenerate,
  onDone,
}: {
  pairing: MobilePairView;
  serving: boolean;
  busy: boolean;
  onRegenerate: () => void;
  onDone: () => void;
}) {
  const deadline = Date.parse(pairing.expires_at);
  const [expired, setExpired] = useState(() => deadline <= Date.now());
  // One ticker for the countdown, stopped once the code has lapsed.
  const now = useTicker(!expired);
  const remaining = deadline - now;
  useEffect(() => {
    if (!expired && remaining <= 0) setExpired(true);
  }, [expired, remaining]);
  useEffect(() => {
    setExpired(Date.parse(pairing.expires_at) <= Date.now());
  }, [pairing.expires_at]);

  return (
    <Block
      title="Pair a phone"
      className="mob-pair-blk"
      right={
        <span className={expired ? "mono st-err" : "mono"} aria-live="polite" data-testid="pair-expiry">
          {expired ? "code expired" : `expires in ${fmtCountdown(remaining)}`}
        </span>
      }
    >
      <div className={expired ? "mob-pair mob-expired" : "mob-pair"}>
        <PairQr url={pairing.url} />
        <div className="mob-pair-info">
          <span className="kicker">Pairing code</span>
          <output className="mono mob-code" aria-label="Pairing code">
            {formatPairCode(pairing.code)}
          </output>
          <span className="kicker">Bridge</span>
          <span className="mono">
            {pairing.host}:{pairing.port}
          </span>
          <p className="st-hint">
            Scan the code with the Hermetic app, or type it in. The phone must be on the tailnet —
            signed in to the same Tailscale network as this laptop. A code works once.
          </p>
          {serving ? null : (
            <Callout tone="warn">
              The bridge is not running. Turn it on above so the phone can reach it.
            </Callout>
          )}
          <span className="st-acts-in mob-pair-acts">
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={onRegenerate}>
              Generate new code
            </button>
            <button type="button" className="btn btn-secondary" onClick={onDone}>
              Done
            </button>
          </span>
        </div>
      </div>
    </Block>
  );
}

function DevicesTable({
  devices,
  connected,
  onRevoke,
}: {
  devices: readonly MobileDeviceView[];
  connected: ReadonlySet<string>;
  onRevoke: (device: MobileDeviceView) => void;
}) {
  return (
    <table className="st-list mob-devices">
      <thead>
        <tr>
          <th aria-label="Connection" />
          <th>Phone</th>
          <th>Platform</th>
          <th>Paired</th>
          <th>Last seen</th>
          <th>Push</th>
          <th>Previews</th>
          <th className="st-acts">Actions</th>
        </tr>
      </thead>
      <tbody>
        {devices.map((d) => {
          const live = connected.has(d.device_id);
          return (
            <tr key={d.device_id} data-device={d.device_id}>
              <td className="st-c-sq">
                <Sq tone={live ? "ok" : "off"} title={live ? "connected now" : "not connected"} />
              </td>
              <td>
                <b>{d.name}</b>
                <div className="mono st-sub">{d.device_id}</div>
              </td>
              <td className="mono st-cell-sm">{platformLabel(d.platform)}</td>
              <td className="mono st-cell-sm">{fmtStamp(d.created_at)}</td>
              <td className="mono st-cell-sm">{live ? "now" : fmtStamp(d.last_seen_at)}</td>
              <td className="mono st-cell-sm">{d.push_registered ? "registered" : "—"}</td>
              <td className="mono st-cell-sm">{d.previews ? "on" : "off"}</td>
              <td className="st-acts">
                <span className="st-acts-in">
                  <TextAction tone="danger" onClick={() => onRevoke(d)} label={`Revoke ${d.name}`}>
                    Revoke
                  </TextAction>
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function MobileSection() {
  const [settings, setSettings] = useState<MobileSettingsView | null>(null);
  const [draft, setDraft] = useState<AddressDraft>({ host: "", port: "" });
  const [devices, setDevices] = useState<MobileDeviceView[] | null>(null);
  const [serving, setServing] = useState<MobileServingView | null>(null);
  const [follow, setFollow] = useState<Follow>("off");
  const [connected, setConnected] = useState<Set<string>>(() => new Set());
  const [lastEvent, setLastEvent] = useState<{ text: string; at: number } | null>(null);
  const [pairing, setPairing] = useState<MobilePairView | null>(null);
  const [justPaired, setJustPaired] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<MobileDeviceView | null>(null);
  const [busy, setBusy] = useState<"enabled" | "address" | "pair" | "revoke" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ticked, flash] = useSavedTick();
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  const refreshDevices = useCallback(async () => {
    try {
      const read = await fetchMobileDevices();
      if (!live.current) return;
      setDevices(read.devices);
      setServing(read.serving);
    } catch (e) {
      if (live.current) setError(messageOf(e));
    }
  }, []);

  useEffect(() => {
    // Through a promise, so a transport that refuses synchronously is an error
    // on the page rather than a throw out of the effect.
    Promise.resolve()
      .then(() => fetchMobileSettings())
      .then(
        (read) => {
          if (!live.current) return;
          setSettings(read);
          setDraft(draftOf(read));
        },
        (e: unknown) => {
          if (live.current) setError(messageOf(e));
        },
      );
    void refreshDevices();
  }, [refreshDevices]);

  /** Names for the "last event" line, read at event time rather than captured by the feed. */
  const names = useRef<ReadonlyMap<string, string>>(new Map());
  names.current = new Map((devices ?? []).map((d) => [d.device_id, d.name]));

  const enabled = settings?.enabled === true;
  useEffect(() => {
    if (!enabled) {
      setFollow("off");
      return;
    }
    return followMobile({
      onConnected: (ok) => setFollow(ok ? "following" : "unavailable"),
      onFrame: (frame) => {
        const event = mobileFeedEvent(frame);
        if (event === null) return;
        if (event.kind === "status") setServing(event.status);
        setConnected((current) => nextConnected(current, event));
        const text = describeFeedEvent(event, (id) => names.current.get(id) ?? id);
        if (text !== null) setLastEvent({ text, at: Date.now() });
        if (event.kind === "paired") {
          // A code works once: the one on screen is spent.
          setPairing(null);
          setJustPaired(event.name);
        }
        if (event.kind !== "status") void refreshDevices();
      },
    });
  }, [enabled, refreshDevices]);

  async function toggle(next: boolean) {
    setBusy("enabled");
    setError(null);
    try {
      const saved = await setMobileSettings({ enabled: next });
      setSettings(saved);
      flash();
      await refreshDevices();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
    }
  }

  const parsed = parseAddress(draft);
  const dirty = addressDirty(settings, draft);

  async function saveAddress() {
    if (!parsed.ok) return;
    setBusy("address");
    setError(null);
    try {
      const saved = await setMobileSettings(parsed.patch);
      setSettings(saved);
      setDraft(draftOf(saved));
      flash();
      await refreshDevices();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
    }
  }

  async function pair() {
    setBusy("pair");
    setError(null);
    setJustPaired(null);
    try {
      setPairing(await pairMobile());
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
    }
  }

  async function revoke(device: MobileDeviceView) {
    setBusy("revoke");
    setError(null);
    try {
      await revokeMobileDevice(device.device_id);
      setConfirming(null);
      await refreshDevices();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
    }
  }

  const wildcard = isWildcardHost(draft.host) || isWildcardHost(settings?.host);
  const bridgeState =
    serving !== null
      ? { v: "listening", tone: "ok" as const }
      : enabled
        ? { v: "not serving", tone: "warn" as const }
        : { v: "off", tone: undefined };

  return (
    <SettingsPage
      section="mobile"
      scope="laptop"
      desc="Chat with your agents from the Hermetic phone app. This app serves the bridge the phone connects to, over the tailnet."
      primary={
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy === "pair" || settings === null}
          onClick={() => void pair()}
        >
          Pair a phone
        </button>
      }
    >
      {error !== null ? (
        <div className="st-hint mono st-err" role="alert">
          {error}
        </div>
      ) : null}

      <Block title="Bridge" right={<SavedTick on={ticked} />}>
        <Facts
          items={[
            { k: "Bridge", v: bridgeState.v, ...(bridgeState.tone ? { tone: bridgeState.tone } : {}) },
            { k: "Listening on", v: serving?.url ?? "—" },
            { k: "Phones connected", v: serving === null ? "—" : String(serving.connected) },
            {
              k: "Last event",
              v: lastEvent === null ? "—" : `${lastEvent.text} · ${fmtClock(lastEvent.at)}`,
            },
          ]}
        />
        <SettingRow
          label="Serve the bridge"
          desc="While this app is open. Paired phones reconnect on their own."
          htmlFor="mobile-enabled"
          field="enabled"
          state={settings === null ? null : <RowNote>{enabled ? "on" : "off"}</RowNote>}
        >
          <label className="st-check">
            <input
              id="mobile-enabled"
              type="checkbox"
              checked={enabled}
              disabled={settings === null || busy === "enabled"}
              onChange={(e) => void toggle(e.target.checked)}
              aria-label="Serve the mobile bridge"
            />
            on
          </label>
        </SettingRow>
        <SettingRow
          label="Host"
          desc="Where the bridge listens and phones connect. Empty: this laptop's tailnet address."
          htmlFor="mobile-host"
          field="host"
          state={
            settings === null ? null : (
              <RowNote>{settings.host === null ? "tailnet default" : "override"}</RowNote>
            )
          }
        >
          <input
            id="mobile-host"
            className="key-input st-w"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder={serving?.host ?? "tailnet address"}
            value={draft.host}
            disabled={settings === null}
            onChange={(e) => setDraft({ ...draft, host: e.target.value })}
          />
        </SettingRow>
        <SettingRow
          label="Port"
          desc={`Empty: ${DEFAULT_MOBILE_PORT}.`}
          htmlFor="mobile-port"
          field="port"
          state={
            settings === null ? null : (
              <RowNote>{settings.port === null ? "default" : "override"}</RowNote>
            )
          }
        >
          <input
            id="mobile-port"
            className="key-input mob-port"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            placeholder={String(DEFAULT_MOBILE_PORT)}
            value={draft.port}
            disabled={settings === null}
            onChange={(e) => setDraft({ ...draft, port: e.target.value })}
          />
        </SettingRow>
        {dirty ? (
          <div className="mob-addr-acts">
            {parsed.ok ? (
              <span className="st-hint mono">
                {enabled
                  ? "saving restarts the bridge; connected phones reconnect"
                  : "saved for the next start"}
              </span>
            ) : (
              <span className="st-hint mono st-err" role="alert">
                {parsed.error}
              </span>
            )}
            <span className="st-acts-in">
              <button
                type="button"
                className="btn btn-primary"
                disabled={!parsed.ok || busy === "address"}
                onClick={() => void saveAddress()}
              >
                Save address
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setDraft(draftOf(settings))}
              >
                Cancel
              </button>
            </span>
          </div>
        ) : null}
        {wildcard ? (
          <Callout tone="warn">
            <code>0.0.0.0</code> listens on every network this laptop joins — café Wi-Fi and office LANs
            too, not only the tailnet. Phones still need a pairing, but anyone on those networks can
            reach the bridge. Leave Host empty to listen on the tailnet address alone.
          </Callout>
        ) : null}
        {enabled && follow === "unavailable" ? (
          <p className="st-hint mono">
            live status unavailable in this window · the list refreshes after each change
          </p>
        ) : null}
      </Block>

      {pairing !== null ? (
        <PairPanel
          pairing={pairing}
          serving={serving !== null}
          busy={busy === "pair"}
          onRegenerate={() => void pair()}
          onDone={() => setPairing(null)}
        />
      ) : null}

      <Block
        title="Paired phones"
        right={
          devices === null ? null : (
            <Tally tone={connected.size > 0 ? "ok" : "off"}>
              {devices.length} paired · {connected.size} connected
            </Tally>
          )
        }
      >
        {justPaired !== null ? <Callout tone="ok">Paired {justPaired}.</Callout> : null}
        {devices === null ? (
          <p className="st-hint mono">reading paired phones…</p>
        ) : devices.length === 0 ? (
          <EmptyState
            title="No phones paired"
            hint="Pair a phone to chat with your agents away from this laptop"
          />
        ) : (
          <DevicesTable devices={devices} connected={connected} onRevoke={setConfirming} />
        )}
        {confirming !== null ? (
          <div className="st-confirm" role="alertdialog" aria-label={`Revoke ${confirming.name}`}>
            <span>
              Revoking <b>{confirming.name}</b> signs it out now. It has to pair again to reconnect.
              Continue?
            </span>
            <span className="st-acts-in">
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy === "revoke"}
                onClick={() => void revoke(confirming)}
              >
                Revoke phone
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setConfirming(null)}>
                Cancel
              </button>
            </span>
          </div>
        ) : null}
      </Block>

      <PageFoot>saves as you change it · this laptop only · hermetic mobile devices</PageFoot>
    </SettingsPage>
  );
}
