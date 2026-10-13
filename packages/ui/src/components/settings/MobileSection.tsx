/**
 * Settings › Mobile: the code a phone scans to learn this fleet.
 *
 * One block. Nothing is read until "Show pairing code" is pressed; then
 * `mobile.pair` answers the fleet, its live agents and a `hermetic://fleet?…`
 * link, drawn as a QR beside the link itself. The phone talks to the boxes
 * directly over the tailnet, so the link carries no secret and the page holds
 * nothing back: it is a read, like Diagnostics.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { pairMobile } from "../../api/mobile.ts";
import { ApiError } from "../../api/errors.ts";
import type { MobilePairView } from "../../api/types.ts";
import {
  agentsInLinkLine,
  agentsLeftOutNote,
  fleetLabel,
  pairHelp,
  pairQrSvg,
} from "../../logic/mobile-logic.ts";
import { Block, Facts, SettingsPage } from "./Section.tsx";
import "./MobileSection.css";

/** A refusal as one line: core's code and sentence when it has them. */
function errorLine(e: unknown): string {
  if (e instanceof ApiError) return `${e.code} · ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

/**
 * The QR for the link, from core's encoder. A link the encoder cannot fit
 * draws no QR; the phone can still take the link pasted from the field below.
 */
function PairQr({ link }: { link: string }) {
  const svg = useMemo(() => pairQrSvg(link), [link]);
  if (svg === null) {
    return (
      <span className="mob-qr mob-qr-none mono" data-testid="pair-no-qr">
        too long for a QR · copy the link instead
      </span>
    );
  }
  return (
    <span
      className="mob-qr"
      role="img"
      aria-label="Pairing QR code"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: core's QR encoder emits fixed markup and module coordinates, never the link itself.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/** The link in a read-only field, with a button that puts it on the clipboard. */
function LinkField({ link }: { link: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  async function copy() {
    if (timer.current) clearTimeout(timer.current);
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(link);
      setState("copied");
      timer.current = setTimeout(() => setState("idle"), 1400);
    } catch {
      setState("failed");
    }
  }

  return (
    <>
      <div className="mob-link">
        <input
          className="key-input mono mob-link-input"
          type="text"
          readOnly
          spellCheck={false}
          aria-label="Pairing link"
          value={link}
          onFocus={(e) => e.currentTarget.select()}
        />
        <button type="button" className="btn btn-secondary" onClick={() => void copy()}>
          {state === "copied" ? "Copied" : "Copy link"}
        </button>
      </div>
      <span role="status" className={state === "failed" ? "st-hint mono st-err" : "sr-only"}>
        {state === "copied"
          ? "Copied the pairing link"
          : state === "failed"
            ? "Clipboard unavailable. Select the link and copy it."
            : ""}
      </span>
    </>
  );
}

function PairPanel({ pairing }: { pairing: MobilePairView }) {
  const { fleet, link, agents, agents_in_link } = pairing;
  const leftOut = agentsLeftOutNote(agents_in_link, agents.length);
  return (
    <>
      <Facts
        items={[
          { k: "Fleet", v: fleetLabel(fleet) },
          ...(fleet.alias === null ? [] : [{ k: "Fleet id", v: fleet.fleet_id }]),
          { k: "Tailnet", v: fleet.tailnet },
          { k: "Agents", v: `${agents_in_link} / ${agents.length}` },
        ]}
      />
      <div className="mob-pair">
        <PairQr link={link} />
        <div className="mob-pair-info">
          <span className="kicker">Link</span>
          {/* Keyed on the link, so a new code starts with a fresh "Copy link". */}
          <LinkField key={link} link={link} />
          <p className="mono mob-count" data-testid="pair-agents">
            {agentsInLinkLine(agents_in_link, agents.length)}
          </p>
          {leftOut === null ? null : <p className="st-hint">{leftOut}</p>}
          <p className="mob-help">{pairHelp(fleet.tailnet)}</p>
          <p className="st-hint">
            The code carries no secret: the phone is trusted by its tailnet membership.
          </p>
        </div>
      </div>
    </>
  );
}

export function MobileSection() {
  const [pairing, setPairing] = useState<MobilePairView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  // Set on every mount, not only by the initial value: StrictMode (the app's
  // entry wraps the page in it) unmounts and remounts once, and a ref left
  // false by that first cleanup would drop every answer.
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  async function show() {
    setBusy(true);
    setError(null);
    try {
      const read = await pairMobile();
      if (live.current) setPairing(read);
    } catch (e) {
      // A failed re-read keeps the last good code on screen, under the error.
      if (live.current) setError(errorLine(e));
    } finally {
      if (live.current) setBusy(false);
    }
  }

  return (
    <SettingsPage
      section="mobile"
      scope="readonly"
      desc="Pair the Hermetic phone app with this fleet. The phone talks to your agents directly, over the tailnet."
      primary={
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void show()}>
          {busy ? "Reading…" : pairing === null ? "Show pairing code" : "Read again"}
        </button>
      }
    >
      <Block title="Pair a phone">
        {error === null ? null : (
          <div className="wiz-error mono" role="alert">
            {error}
          </div>
        )}
        {pairing !== null ? (
          <PairPanel pairing={pairing} />
        ) : busy ? (
          <p className="st-hint mono">reading the fleet…</p>
        ) : error === null ? (
          <p className="st-hint mono">nothing read yet — Show pairing code, top right</p>
        ) : null}
      </Block>
    </SettingsPage>
  );
}
