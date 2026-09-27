/**
 * The boot-time swap protocol (§6.5): what the last binary swap left behind,
 * whether this process is the one that did it, and when the new binary has
 * earned its keep or crash-looped its way back to `hermeticd.prev`. Runs at
 * the top of `serve`, before anything with a dependency that can fail.
 */
import type { Host } from "../host.ts";
import { must } from "../host.ts";
import { HERMETICD_PATH } from "../stages.ts";
import type { Emit } from "../events.ts";
import { opEvent } from "../events.ts";
import { readBootId } from "../install-lock.ts";
import {
  queueEvent,
  readUpdateState,
  writeUpdateState,
  type SwapMarker,
  type UpdateState,
} from "./state.ts";

/**
 * The binary the last swap replaced, kept beside the new one. It is the only
 * copy of the previous release on the box — S3 still has it, but a box whose
 * hermeticd will not stay up is a box that cannot fetch anything. Removed the
 * moment the swap settles: one generation back is a rollback target, two is
 * 100 MB of a root volume nobody will boot.
 */
export const HERMETICD_PREV_PATH = `${HERMETICD_PATH}.prev`;

/**
 * How many restarts an unsettled swap may see before it is judged a crash loop.
 *
 * The counter is untimed, and it is the *settle* that bounds it: a binary that
 * works clears the marker within seconds of its first heartbeat, so a healthy
 * release is never anywhere near this number however often the box is later
 * restarted. A binary that cannot stay up never clears anything, so its
 * restarts accumulate — fast if it crashes immediately, slowly if it takes
 * twenty-five seconds to die, and the count is the same either way. That is the
 * property a wall-clock window did not have.
 *
 * Only the service counts (`asService`): `hermeticd apply` from a stage and a
 * hand-run `hermeticd update` are separate processes by design, and counting
 * them would roll back a healthy release on a box that was merely booting.
 */
export const MAX_SWAP_BOOTS = 3;

/**
 * How long a new binary must *keep running* before its swap is declared good.
 *
 * Uptime of the process itself, measured from when it started — not wall-clock
 * since the swap. The difference is the whole point: a binary that dies slowly
 * (25 s of IMDS and STS timeouts, then an exception) would cross a wall-clock
 * window on its third incarnation and settle a release that never once stayed
 * up. Settling now needs positive evidence — this process reached its first
 * successful heartbeat write, or has simply been alive this long — and until
 * one of those arrives the boot counter keeps counting.
 *
 * Two minutes: longer than any start-up path on the box (the slowest is
 * `serveRpc` waiting for a Tailscale address, which fails loudly rather than
 * hanging), and short enough that an operator restarting a healthy box four
 * times in a row would have to do it inside two minutes to be counted at all —
 * and in practice the first heartbeat settles it within thirty seconds.
 */
export const SWAP_SETTLE_MS = 2 * 60_000;

/**
 * The pid systemd currently has for the service.
 *
 * `hermeticd update --check` runs as a *different* process from the `serve`
 * that did the swap, so comparing the marker against `process.pid` there could
 * only ever answer "not us" — the one state the operator ran the command to
 * find out about was the one it could not report. systemd knows which process
 * is the service; ask it. `null` when there is no systemd to ask, which falls
 * back to this process's own id.
 */
export async function serviceMainPid(host: Host): Promise<number | null> {
  const res = await host
    .exec(["systemctl", "show", "-p", "MainPID", "--value", "hermeticd.service"])
    .catch(() => null);
  if (res === null || res.code !== 0) return null;
  const pid = Number(res.stdout.trim());
  // `0` is systemd's answer for a unit that is not running, and it is a real
  // answer — the service being *down* with a swap outstanding is exactly the
  // state `--check` exists to report. Only "systemctl could not tell us" is
  // `null`, and only that falls back to this process's own id.
  return Number.isFinite(pid) && pid >= 0 ? pid : null;
}

/**
 * What settling a swap needs, and nothing more.
 *
 * No `Aws`, no bucket, no manifest: this runs at the top of `serve`, before
 * `bootContext` has read user-data or built a client, because the binary a
 * rollback exists for is precisely the one that dies *in* those dependencies.
 * Local files and `systemctl`, both of which work on a box with no network and
 * no credentials.
 */
export interface SwapDeps {
  readonly host: Host;
  readonly pid?: number;
  readonly emit?: Emit;
  readonly log?: (message: string) => void;
  /**
   * True only for the process systemd is managing — `serve`, and the update
   * loop inside it. Every other entry point (`hermeticd apply` from a stage, a
   * hand-run `hermeticd update`) is a *different* process by design, and
   * counting those as restarts of the service would roll back a healthy release
   * on a box that was doing nothing but booting normally.
   */
  readonly asService?: boolean;
}

/** What the marker said about the swap before it, and what was done about it. */
export type SwapOutcome =
  /** No swap is outstanding. */
  | "none"
  /** We are still the process that swapped: the restart has not happened. */
  | "restart-pending"
  /** A new process is up and the swap is still inside its settle window. */
  | "watching"
  /** The new binary stayed up; the marker is cleared. */
  | "settled"
  /** The new binary crash-looped; `hermeticd.prev` is back at the binary path. */
  | "rolled-back";

/**
 * Decide what this process is looking at, and act on it.
 *
 * The one thing it never does is act on a digest: the digest on disk is the new
 * release either way, which is precisely why it cannot distinguish a landed
 * swap from a swap whose restart failed. Nor does it act on a clock. It asks
 * one question — *are we the process that swapped?* — and counts the answers.
 *
 * Settling is not decided here at all. A marker is cleared only by positive
 * evidence that the new binary works (`markSwapSettled`, armed by `serve`), so
 * a release that never stays up never accumulates a reason to be trusted,
 * however long it takes to fail.
 */
export async function settleSwap(deps: SwapDeps): Promise<SwapOutcome> {
  const { host } = deps;
  const say = deps.log ?? (() => {});
  const pid = deps.pid ?? process.pid;
  const state = await readUpdateState(host);
  const marker = state.swap;
  if (marker === null) return "none";

  const bootId = await readBootId(host);
  // A pid alone is recycled; a boot id says which boot that pid belonged to. If
  // either says "somebody else", the restart happened.
  const sameBoot = marker.boot_id === null || bootId === null || marker.boot_id === bootId;
  if (sameBoot && marker.swapped_by_pid === pid) return "restart-pending";

  // Only the service's own restarts are evidence of anything (see `asService`).
  if (deps.asService !== true) return "watching";

  if (marker.seen_by_pid !== pid) {
    // A process that is neither the swapper nor the one already watching: the
    // first incarnation of the new binary, or the nth of a crash loop. A
    // healthy release settles long before this counter matters.
    const boots = marker.boots + 1;
    if (boots > MAX_SWAP_BOOTS) return await rollbackSwap(deps, state, marker, boots);
    say(`watching hermeticd ${marker.target} settle (boot ${boots} of ${MAX_SWAP_BOOTS})`);
    await writeUpdateState(host, {
      ...state,
      swap: { ...marker, seen_by_pid: pid, seen_at: host.now().toISOString(), boots },
    });
  }
  return "watching";
}

/**
 * The swap worked: clear the marker and drop the backup.
 *
 * Called on evidence, not on a timer reading the wrong clock — `serve` arms it
 * two ways (`update.ts` has neither, deliberately: the update loop is not proof
 * of anything the heartbeat has not already proved better):
 *
 *  - the first heartbeat write that succeeds, which means this binary got all
 *    the way through user-data, the instance role, DynamoDB and the probes;
 *  - failing that, `SWAP_SETTLE_MS` of *this process's* uptime, for a box whose
 *    row has been deleted or whose table is unreachable but which is otherwise
 *    perfectly alive.
 *
 * Idempotent, because both of those can arrive.
 */
export async function markSwapSettled(deps: SwapDeps): Promise<SwapOutcome> {
  const { host } = deps;
  const state = await readUpdateState(host);
  const marker = state.swap;
  if (marker === null) return "none";
  (deps.log ?? (() => {}))(`hermeticd ${marker.target} is up and settled`);
  await writeUpdateState(host, {
    ...state,
    swap: null,
    pending_events: queueEvent(
      state,
      "update",
      `hermeticd ${marker.target} is up and settled`,
      host.now(),
    ),
  });
  // Only once the marker is gone: a `.prev` removed first would leave a window
  // where the marker still promises a rollback target that is not there.
  await host.remove(HERMETICD_PREV_PATH);
  return "settled";
}

/** `markSwapSettled` after this process has been up long enough to mean it. */
export async function settleAfterUptime(
  deps: SwapDeps,
  uptimeMs: number = SWAP_SETTLE_MS,
): Promise<SwapOutcome> {
  await deps.host.sleep(uptimeMs);
  return await markSwapSettled(deps);
}

/**
 * `settleSwap` without the side effects, for `--check`: it reports the one
 * state an operator asking "what would you do" needs to hear about — a swap the
 * service never restarted into — and writes nothing, clears nothing and rolls
 * nothing back (§6.5).
 *
 * The comparison is against systemd's `MainPID`, not this process's: `--check`
 * is run from a shell, so its own pid is never the one in the marker. A
 * `MainPID` of `0` is systemd saying the unit is not running at all, which with
 * a swap outstanding is the worst version of the same answer.
 */
export async function peekSwap(deps: SwapDeps): Promise<SwapOutcome> {
  const state = await readUpdateState(deps.host);
  const marker = state.swap;
  if (marker === null) return "none";
  const bootId = await readBootId(deps.host);
  if (marker.boot_id !== null && bootId !== null && marker.boot_id !== bootId) return "watching";
  const mainPid = await serviceMainPid(deps.host);
  if (mainPid === 0) return "restart-pending";
  const pid = mainPid ?? deps.pid ?? process.pid;
  return marker.swapped_by_pid === pid ? "restart-pending" : "watching";
}

/**
 * Ask systemd again for the restart that did not happen.
 *
 * Normally unreachable past its own first line — systemd stops this process to
 * start the new one — so a `true` here means the restart was accepted *and* we
 * are somehow still running, which the next tick will notice again.
 */
export async function retryRestart(deps: SwapDeps): Promise<boolean> {
  const emit = deps.emit ?? (() => {});
  emit(
    opEvent(
      "restart",
      0.95,
      "a binary swap is still waiting on its restart; asking systemd again",
      deps.host.now(),
    ),
  );
  await must(deps.host, ["systemctl", "restart", "hermeticd.service"]);
  return true;
}

/**
 * Put the previous binary back, refuse the release that would not run, and
 * restart into the old one.
 *
 * The backup is verified against the digest the swap recorded first: a
 * `hermeticd.prev` that is not the release we saved is not something to boot a
 * box into, and rolling back onto unknown bytes is a worse failure than staying
 * on a bad release that at least gets restarted by systemd. When there is
 * nothing trustworthy to go back to, the marker is dropped and the box is left
 * to systemd and the nightly check — hermetic sees the version stop moving.
 *
 * Either way the failed digest is recorded, because a rollback without it is a
 * loop: the manifest still names the release, so the next tick reinstalls it.
 */
async function rollbackSwap(
  deps: SwapDeps,
  state: UpdateState,
  marker: SwapMarker,
  boots: number,
): Promise<SwapOutcome> {
  const { host } = deps;
  const say = deps.log ?? (() => {});
  const emit = deps.emit ?? (() => {});
  const previous = await host.sha256File(HERMETICD_PREV_PATH);
  const restorable = marker.previous_sha256 !== null && previous === marker.previous_sha256;

  const refused: UpdateState = {
    ...state,
    swap: null,
    failed_sha256: marker.sha256,
    failed_target: marker.target,
    failed_at: host.now().toISOString(),
    failed_notified: false,
  };

  if (!restorable) {
    const detail =
      `hermeticd ${marker.target} restarted ${boots} times without settling and there is ` +
      `no usable ${HERMETICD_PREV_PATH} to roll back to`;
    say(detail);
    await writeUpdateState(host, {
      ...refused,
      pending_events: queueEvent(state, "update-failed", detail, host.now()),
    });
    return "watching";
  }

  const detail = `hermeticd ${marker.target} restarted ${boots} times without settling; rolled back`;
  say(detail);
  emit(opEvent("rollback", 0.5, `rolling back to the binary before ${marker.target}`, host.now()));
  // A rename over the live path: atomic, and the path is never empty for an
  // instant. Going back also means the release that would not stay up is the
  // one discarded, which is what makes `.prev` the right place to take it from.
  await host.rename(HERMETICD_PREV_PATH, HERMETICD_PATH);
  // Written *before* the restart. State still naming the swap would have the
  // restored process count itself as another failed boot.
  await writeUpdateState(host, {
    ...refused,
    pending_events: queueEvent(state, "update-failed", detail, host.now()),
  });
  await must(host, ["systemctl", "restart", "hermeticd.service"]);
  return "rolled-back";
}
