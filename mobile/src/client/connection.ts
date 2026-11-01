/**
 * The home header's connection path: phone → Tailscale → box (§9.4).
 *
 * A cold start with Tailscale set to connect on demand takes a while: the
 * tunnel wakes, the tailnet map syncs, then the boxes answer. The first probes
 * fail the whole time, and reading those failures as "Tailscale is off" paints
 * an error over what is only a wait. So each attempt (a launch, a return to
 * the foreground, a retry) gets a grace window: inside it the header shows
 * which step the phone is on, and only once it runs out does a failure read
 * as one.
 *
 * Per listened instance, from the last probe and that instance's roster read:
 *
 * - `waking` — the Tailscale client has not answered as connected yet;
 * - `reaching` — Tailscale is connected, this box has not answered yet;
 * - `answered` — this box answered a read made during this attempt;
 * - `no_tailscale` — the grace ran out with Tailscale still not connected;
 * - `no_box` — the grace ran out with Tailscale connected and this box silent.
 *
 * `connectionView` (the screen's hook) adds the beat after `answered`: the
 * path shows `connected` briefly, then the header settles back to the
 * instance's ordinary state, and an attempt that never showed a wait never
 * shows the beat either.
 *
 * Pure: the clock is an argument.
 */
import type { TailscaleProbe } from "../gateway/tailscale.ts";

export type ConnectionStep = "waking" | "reaching" | "answered" | "no_tailscale" | "no_box";

/** How long an attempt waits before a failure reads as one. */
export const CONNECT_GRACE_MS = 30_000;
/** How often the phone asks again while an attempt is inside its grace. */
export const CONNECT_RETRY_MS = 3_000;
/** How long `connected` stays up before the header settles. */
export const CONNECTED_BEAT_MS = 1_600;
/**
 * A read that answers this fast never shows the path at all: a healthy
 * return to the foreground should not flicker a wait the operator never had.
 */
export const CONNECT_QUIET_MS = 700;

export interface ConnectionAttempt {
  /** When this attempt started (ms epoch). */
  startedAt: number;
}

/** Whether the Tailscale client says it is connected; `null` when it said nothing usable. */
export function tunnelUp(probe: TailscaleProbe | null): boolean | null {
  if (!probe) return null;
  if (probe.tunnel === "connected") return true;
  if (probe.tunnel === "no_netmap" || probe.tunnel === "down") return false;
  // The page said nothing either way: fall back on the box probes.
  if (probe.status === "ok" || probe.status === "unreachable") return true;
  if (probe.status === "off") return false;
  return null;
}

/**
 * One instance's step in this attempt. `answeredAt` is when its last
 * successful read started (`null` if it has not answered); a read from before
 * this attempt does not count, since the tunnel may have dropped since.
 */
export function connectionStep(input: {
  attempt: ConnectionAttempt;
  now: number;
  probe: TailscaleProbe | null;
  answeredAt: number | null;
}): ConnectionStep {
  const { attempt, now, probe, answeredAt } = input;
  if (answeredAt !== null && answeredAt >= attempt.startedAt) return "answered";
  const up = tunnelUp(probe);
  if (now - attempt.startedAt < CONNECT_GRACE_MS) return up ? "reaching" : "waking";
  return up ? "no_box" : "no_tailscale";
}

/** Whether the attempt is still inside its grace and something is still being waited on. */
export function connecting(steps: readonly ConnectionStep[]): boolean {
  return steps.some((s) => s === "waking" || s === "reaching");
}

/** What the header draws for one instance: a step, `connected` for the beat, or nothing. */
export type ConnectionShown = Exclude<ConnectionStep, "answered"> | "connected" | null;

/**
 * Fold a step into what is on screen. `shownSince` is when the path first
 * appeared in this attempt (`null` while it has not); `answeredAt` when the
 * instance answered. Before `CONNECT_QUIET_MS` a wait shows nothing; an answer
 * after a shown wait holds `connected` for `CONNECTED_BEAT_MS`, then nothing.
 */
export function shownStep(input: {
  step: ConnectionStep;
  attempt: ConnectionAttempt;
  now: number;
  shownSince: number | null;
  answeredAt: number | null;
}): ConnectionShown {
  const { step, attempt, now, shownSince, answeredAt } = input;
  if (step === "answered") {
    if (shownSince === null || answeredAt === null) return null;
    return now - Math.max(answeredAt, shownSince) < CONNECTED_BEAT_MS ? "connected" : null;
  }
  if (step === "no_box" || step === "no_tailscale") return step;
  return now - attempt.startedAt < CONNECT_QUIET_MS && shownSince === null ? null : step;
}

/** The word after the instance's name in its header. */
export function connectionWord(shown: Exclude<ConnectionShown, null>, instance: string): string {
  switch (shown) {
    case "waking":
      return "waking tailscale";
    case "reaching":
      return `reaching ${instance}`;
    case "connected":
      return "connected";
    case "no_tailscale":
      return "no tailscale";
    case "no_box":
      return "not answering";
  }
}

/** The caption under the header: the step in a sentence, and how old the chats below are. */
export function connectionCaption(input: {
  shown: Exclude<ConnectionShown, null>;
  instance: string;
  /** When the chats on screen were read, if they are from an earlier read; `null` for none. */
  asOf: string | null;
  graceSeconds?: number;
}): string {
  const { shown, instance, asOf } = input;
  const seconds = input.graceSeconds ?? Math.round(CONNECT_GRACE_MS / 1000);
  const tail = asOf ? ` · chats as of ${asOf}` : "";
  switch (shown) {
    case "waking":
      return `Waking Tailscale…${tail}`;
    case "reaching":
      return `Tailscale is up · asking ${instance}…`;
    case "connected":
      return "Connected · updating chats";
    case "no_tailscale":
      return `Tailscale didn’t connect in ${seconds}s${tail}`;
    case "no_box":
      return `Tailscale is up, but ${instance} didn’t answer in ${seconds}s${tail}`;
  }
}
