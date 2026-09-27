/**
 * The updater's memory between processes: the JSON records under
 * `/var/lib/hermeticd` — the swap marker, the refused release, the queued
 * events, and the install intent — with their parsers, which read anything
 * unrecognisable as "nothing remembered". The boot-time swap protocol is in
 * `swap.ts`, the download and install in `install.ts`, and `update()` itself in
 * `index.ts`.
 */
import type { Host } from "../host.ts";
import { STATE_DIR } from "../fleet.ts";

/**
 * Everything the updater has to remember between processes: the swap in
 * flight, the release this box could not stay up on, and any event that
 * happened somewhere with no AWS client to write it. Names no secret; 0644 like
 * the fleet cache beside it.
 */
export const UPDATE_STATE_PATH = `${STATE_DIR}/update-state.json`;

/**
 * Everything the installer has to remember *while it is installing*: the
 * release it decided on, the digest it is replacing, and whether it still owes
 * a restart (§6.5).
 *
 * A separate file from `update-state.json` on purpose. The update state is read
 * at the top of a tick and written back several times from that one snapshot,
 * so a field added to it would be clobbered by any writer holding an older
 * copy — and the one property this record must have is that it survives
 * everything, including the process that wrote it.
 */
export const UPDATE_INTENT_PATH = `${STATE_DIR}/update-intent.json`;

/**
 * What the last binary swap left behind, and who has seen it since.
 *
 * Written before `systemctl restart` is asked for and read by whoever is
 * running next: the same process (the restart did not happen) or a new one (it
 * did). Deliberately not a schema in `@hermetic/core/schema` — it is
 * hermeticd's own note to its successor, never leaves the box, and the box must
 * be able to read one written by the binary it is about to replace.
 */
export interface SwapMarker {
  /** The release label installed at `HERMETICD_PATH`. */
  readonly target: string;
  /** Its digest — what a later tick checks the path still holds. */
  readonly sha256: string;
  /** The digest of the binary saved at `hermeticd.prev`; `null` if there was none. */
  readonly previous_sha256: string | null;
  readonly swapped_at: string;
  /** The pid that did the swap. Still ours ⇒ the restart never took effect. */
  readonly swapped_by_pid: number;
  /** The boot that pid belonged to; `null` where the kernel does not say. */
  readonly boot_id: string | null;
  /** The pid currently watching the swap settle, and when it first saw it. */
  readonly seen_by_pid: number | null;
  readonly seen_at: string | null;
  /** Distinct processes that have seen this marker inside the watch window. */
  readonly boots: number;
}

/**
 * An event that happened where there was no AWS client to write it.
 *
 * The settle and rollback decisions run at start-up, before `bootContext` has
 * built anything — that is the entire point of moving them there — so the
 * DynamoDB event is queued here and flushed by the next `update`, which has a
 * client. Bounded, because a box that never reaches AWS again must not grow
 * this file forever.
 */
export interface PendingEvent {
  readonly action: string;
  readonly detail: string;
  readonly at: string;
}

export const MAX_PENDING_EVENTS = 8;

/** Everything the updater remembers between processes. */
export interface UpdateState {
  readonly swap: SwapMarker | null;
  /**
   * The digest of a release this box swapped to and could not stay up on.
   *
   * Without it a rollback is a loop: the manifest still names that release, so
   * the very next tick finds the binary "stale" again, installs the same bytes
   * again, crash-loops again and rolls back again — every night, or every
   * minute if a rollout request is pending. A release is refused until the
   * fleet manifest names a different digest, which is what a fix looks like
   * from the box's side.
   */
  readonly failed_sha256: string | null;
  readonly failed_target: string | null;
  readonly failed_at: string | null;
  /** Whether the refusal has already been written to the event log once. */
  readonly failed_notified: boolean;
  /**
   * The last error an install threw, and whether the fleet has been told about
   * it. An update that fails once is weather — a throttled `GetObject`, a
   * mirror having a bad minute. The *same* error two ticks running is a box
   * that is stuck, and stuck is the thing an operator has no other way to see:
   * the version simply stops moving.
   */
  readonly last_install_error: string | null;
  readonly install_error_notified: boolean;
  readonly pending_events: readonly PendingEvent[];
}

export const EMPTY_UPDATE_STATE: UpdateState = {
  swap: null,
  failed_sha256: null,
  failed_target: null,
  failed_at: null,
  failed_notified: false,
  last_install_error: null,
  install_error_notified: false,
  pending_events: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** `null` for anything that is not a marker this build wrote. */
export function parseSwapMarker(value: unknown): SwapMarker | null {
  if (!isRecord(value)) return null;
  const { target, sha256, swapped_at, swapped_by_pid, boots } = value;
  if (typeof target !== "string" || typeof sha256 !== "string") return null;
  if (typeof swapped_at !== "string" || typeof swapped_by_pid !== "number") return null;
  if (typeof boots !== "number" || !Number.isFinite(boots)) return null;
  return {
    target,
    sha256,
    previous_sha256: str(value["previous_sha256"]),
    swapped_at,
    swapped_by_pid,
    boot_id: str(value["boot_id"]),
    seen_by_pid: typeof value["seen_by_pid"] === "number" ? (value["seen_by_pid"] as number) : null,
    seen_at: str(value["seen_at"]),
    boots,
  };
}

/**
 * State is a hint, never a fact worth failing over: a file truncated by a power
 * cut costs at most a redundant restart, while throwing on it would wedge the
 * update loop of a box whose only repair path *is* the update loop. Anything
 * unreadable reads as "nothing remembered".
 */
export function parseUpdateState(text: string): UpdateState {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return EMPTY_UPDATE_STATE;
  }
  if (!isRecord(json)) return EMPTY_UPDATE_STATE;
  const events = Array.isArray(json["pending_events"]) ? json["pending_events"] : [];
  return {
    swap: parseSwapMarker(json["swap"]),
    failed_sha256: str(json["failed_sha256"]),
    failed_target: str(json["failed_target"]),
    failed_at: str(json["failed_at"]),
    failed_notified: json["failed_notified"] === true,
    last_install_error: str(json["last_install_error"]),
    install_error_notified: json["install_error_notified"] === true,
    pending_events: events
      .filter((e): e is Record<string, unknown> => isRecord(e))
      .filter((e) => typeof e["action"] === "string" && typeof e["detail"] === "string")
      // The *last* N, like `queueEvent`: a file that somehow grew past the
      // bound is one whose oldest entries are the stalest, and dropping the
      // newest instead would quietly discard the rollback that just happened.
      .slice(-MAX_PENDING_EVENTS)
      .map((e) => ({
        action: String(e["action"]),
        detail: String(e["detail"]),
        at: str(e["at"]) ?? "",
      })),
  };
}

export async function readUpdateState(host: Host): Promise<UpdateState> {
  const text = await host.readFile(UPDATE_STATE_PATH);
  return text === null ? EMPTY_UPDATE_STATE : parseUpdateState(text);
}

export async function writeUpdateState(host: Host, state: UpdateState): Promise<void> {
  await host.mkdir(STATE_DIR, "0755");
  await host.writeFile(UPDATE_STATE_PATH, JSON.stringify(state, null, 2) + "\n", "0644");
}

/**
 * What this box decided to install, written down before it installed any of it.
 *
 * The swap marker covers the last step — the restart — and it used to be the
 * only thing written down, which left the steps before it uncovered. A crash
 * between the binary swap and the marker write (a failed stage download is
 * enough) left the *new* bytes at `/usr/local/bin/hermeticd`, the *old* process
 * running, and nothing on disk saying so: the next tick hashed the path, found
 * the release it wanted, and reported the box up to date forever. The digest on
 * disk cannot distinguish "installed and running" from "installed and not yet
 * restarted", which is the same blind spot `SwapMarker` exists for, one step
 * earlier in the sequence.
 *
 * So the intent is written first and cleared last: from the moment it exists,
 * whoever runs next knows a release was part-installed here, what it was, what
 * it replaced (so a rollback is possible even though no marker was ever
 * written), and whether a restart is still owed. Clearing it is the swap
 * marker's cue to take over — the two records are contiguous and never both
 * responsible for the same step.
 */
export interface InstallIntent {
  /** The release label being installed. */
  readonly target: string;
  /**
   * The digest the binary path must end up holding; `null` when this install
   * is a stage refresh and the binary is not moving.
   */
  readonly sha256: string | null;
  /** The digest of the binary being replaced, for a rollback that has no marker. */
  readonly previous_sha256: string | null;
  /** Every stage file this release names, so a resume installs the same set. */
  readonly stages: readonly string[];
  /**
   * Whether a `systemctl restart` is still owed. True for a binary swap and
   * false for a stage refresh, which deliberately does not restart (§6.5) —
   * and cleared the moment the swap marker takes over responsibility for it.
   */
  readonly restart_owed: boolean;
  readonly started_at: string;
  readonly started_by_pid: number;
  readonly boot_id: string | null;
}

/** `null` for anything that is not an intent this build wrote. */
export function parseInstallIntent(text: string): InstallIntent | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(json)) return null;
  const target = json["target"];
  const pid = json["started_by_pid"];
  if (typeof target !== "string" || typeof pid !== "number" || !Number.isFinite(pid)) return null;
  const stages = Array.isArray(json["stages"]) ? json["stages"] : [];
  return {
    target,
    sha256: str(json["sha256"]),
    previous_sha256: str(json["previous_sha256"]),
    stages: stages.filter((s): s is string => typeof s === "string"),
    restart_owed: json["restart_owed"] === true,
    started_at: str(json["started_at"]) ?? "",
    started_by_pid: pid,
    boot_id: str(json["boot_id"]),
  };
}

export async function readInstallIntent(host: Host): Promise<InstallIntent | null> {
  const text = await host.readFile(UPDATE_INTENT_PATH);
  return text === null ? null : parseInstallIntent(text);
}

export async function writeInstallIntent(host: Host, intent: InstallIntent): Promise<void> {
  await host.mkdir(STATE_DIR, "0755");
  await host.writeFile(UPDATE_INTENT_PATH, JSON.stringify(intent, null, 2) + "\n", "0644");
}

export async function clearInstallIntent(host: Host): Promise<void> {
  await host.remove(UPDATE_INTENT_PATH);
}

export function queueEvent(
  state: UpdateState,
  action: string,
  detail: string,
  at: Date,
): PendingEvent[] {
  return [...state.pending_events, { action, detail, at: at.toISOString() }].slice(-MAX_PENDING_EVENTS);
}
