import { useEffect, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { fmtClock } from "../logic/format.ts";
import { fleetTick, streamHealth, streamLabel, tickColor, volumeTick } from "../logic/loading.ts";
import { VOLUME_POLL_MS } from "../state/state.tsx";

/**
 * How old the volume inventory may get before its square turns `warn`: three
 * of its own ticks, the same margin the fleet stream gets (`LAG_MS`).
 */
const VOLUME_STALE_MS = VOLUME_POLL_MS * 3;

/**
 * The status line: two squares, one for the fleet stream and one for the
 * volume inventory, each a colour and a word. Ages ("polled 41s ago") were a
 * number the operator had to interpret against a cadence they could not see;
 * the colour is that interpretation done once, here (`fleetTick`,
 * `volumeTick`), and the detail — last read time, the error, the retry
 * countdown — is in the tooltip for whoever wants it. A square pulses while a
 * read is actually in flight or the stream is reconnecting.
 */
export function Footer({
  lastPollAt,
  connected,
  everConnected = false,
  retryAt = null,
  scanError = null,
  volumesReadAt = null,
  volumesBusy = false,
  volumesError = null,
  shortcutsRef,
  onShortcuts,
  update = null,
}: {
  lastPollAt: string | null;
  connected: boolean;
  everConnected?: boolean;
  /** Epoch ms of the scheduled reconnect, so the tooltip can count down to it. */
  retryAt?: number | null;
  /** A scan the server failed to run; the socket is fine, the read was not. */
  scanError?: string | null;
  /**
   * §9.1: the volume inventory has its own tick, separate from the fleet
   * stream — two `DescribeVolumes` against EC2 rather than a scan the main
   * process is already doing — so it gets its own square.
   */
  volumesReadAt?: string | null;
  /** A volume read is in flight; its square pulses while it is. */
  volumesBusy?: boolean;
  /** The last volume read failed (the last good inventory stays on screen). */
  volumesError?: string | null;
  /**
   * The `?` sheet's anchor. The footer is where it belongs: the shortcuts were
   * undiscoverable, and the footer is on every dashboard screen, so the hint
   * costs no layout anywhere.
   */
  shortcutsRef?: RefObject<HTMLButtonElement | null>;
  onShortcuts?: () => void;
  /**
   * The updater's line (`state/app-update-state.tsx`), when there is a head
   * broadcasting one. A prop rather than a lookup from inside: the notice is
   * app chrome and the footer is the strip it belongs on, and passing it is the
   * whole of what the two have to agree about.
   */
  update?: ReactNode;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const health = streamHealth({ connected, everConnected, lastPollAt, now });
  const fleet = fleetTick(health, scanError);
  const lagMs = lastPollAt === null ? null : now - Date.parse(lastPollAt);
  const fleetDetail = scanError
    ? `scan failed: ${scanError}`
    : [
        streamLabel(health, retryAt === null ? null : retryAt - now, lagMs),
        lastPollAt ? `last scan ${fmtClock(lastPollAt)}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
  const fleetPulse = health === "connecting" || health === "reconnecting";

  const volumes = volumeTick({
    readAt: volumesReadAt,
    error: volumesError,
    now,
    staleAfterMs: VOLUME_STALE_MS,
  });
  const volumesDetail = volumesError
    ? `read failed: ${volumesError}`
    : volumesBusy
      ? "reading…"
      : volumesReadAt
        ? `last read ${fmtClock(volumesReadAt)}`
        : "not read yet";

  return (
    <div className="footer">
      <span className="foot-tick" data-tick={fleet} title={`fleet · ${fleetDetail}`}>
        <i
          className={fleetPulse ? "tick-dot pulse" : "tick-dot"}
          style={{ background: tickColor(fleet) }}
        />
        fleet
      </span>
      <span className="foot-tick" data-tick={volumes} title={`volumes · ${volumesDetail}`}>
        <i
          className={volumesBusy ? "tick-dot pulse" : "tick-dot"}
          style={{ background: tickColor(volumes) }}
        />
        volumes
      </span>
      {update}
      {onShortcuts ? (
        <button
          type="button"
          className="linkish foot-shortcuts right"
          ref={shortcutsRef}
          onClick={onShortcuts}
          aria-haspopup="dialog"
        >
          ? for shortcuts
        </button>
      ) : null}
    </div>
  );
}
