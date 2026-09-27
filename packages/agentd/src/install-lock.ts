/**
 * The one lock on the box, and why it is a file after all.
 *
 * Two things install code into `/opt/hermetic/stages` and
 * `/usr/local/bin/hermeticd`: the bootstrap runner (§4.2) and the self-update
 * (§6.5). They run in different processes by design — the runner is a oneshot
 * unit, the updater is a loop inside `hermeticd.service` that stage `05-service`
 * itself starts — so for a window of a minute or two on every first boot, both
 * are alive and either could decide to write.
 *
 * The first answer to that was "ask systemd": the updater skipped itself while
 * `hermeticd-bootstrap.service` was active, and the comment in `main.ts` said a
 * lock file was the wrong shape because it outlives the process that took it.
 * That objection is real, and it is also answerable — a lock that records *who*
 * holds it can be checked for liveness rather than trusted:
 *
 *  - the holder's pid, which `/proc/<pid>` answers for. A pid that is gone took
 *    nothing with it, whatever its file still claims;
 *  - the kernel's boot id, because pids are recycled across a reboot and a lock
 *    written before one is by definition held by nobody.
 *
 * So a lock file whose holder is dead is not a lock, it is litter, and the next
 * installer removes it and takes over. What the file buys over the systemd
 * query is the direction the query could not answer: the *bootstrap* runner has
 * no way to ask "is the updater installing right now", because the updater is a
 * loop inside a long-lived service that is `active` either way.
 *
 * Taking it is `link(2)` and not `open(O_CREAT)`, because `Host` has no
 * exclusive create: a link to an existing name fails with `EEXIST`, which is
 * the same atomic "I got there first" the flag would have given.
 */
import { AgentdError } from "./errors.ts";
import { STATE_DIR } from "./fleet.ts";
import type { Host } from "./host.ts";

/** Beside the update state and the fleet cache; names no secret, so 0644. */
export const INSTALL_LOCK_PATH = `${STATE_DIR}/install.lock`;

/**
 * The kernel's own id for this boot. It changes on reboot and cannot be reused
 * within one, which makes it the other half of the "is that process still
 * there" question: a pid alone is recycled, so a lock from a previous boot
 * whose number happens to match a live process today would otherwise read as
 * held. Absent (a container, a kernel without it) simply drops back to the pid.
 */
export const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";

/** How long the bootstrap runner waits for an install already in flight. */
export const LOCK_WAIT_MS = 5 * 60_000;

/** How often it looks again while waiting. */
export const LOCK_POLL_MS = 5_000;

/** Which of the two installers a lock belongs to. Reported, never compared. */
export type InstallLockHolder = "bootstrap" | "update";

export interface InstallLockRecord {
  readonly holder: InstallLockHolder;
  readonly pid: number;
  readonly boot_id: string | null;
  readonly taken_at: string;
}

/** A lock this process is holding. `release` is idempotent. */
export interface HeldInstallLock {
  readonly record: InstallLockRecord;
  release(): Promise<void>;
}

/**
 * Errors that mean "this filesystem does not do hard links", not "this failed".
 *
 * The same set the binary backup falls back on (`update.ts`), for the same
 * reason: `link(2)` is `EPERM` on overlayfs and on anything mounted `nolink`,
 * and a lock that treated that as fatal would refuse every install on a box
 * where everything else works.
 */
const NO_HARDLINK_CODES = new Set(["EPERM", "ENOSYS", "EOPNOTSUPP", "EXDEV", "EMLINK", "EACCES"]);

export interface TakeLockOptions {
  /** This process's id. Injected so a test can be a second process. */
  readonly pid?: number;
}

export interface WaitLockOptions extends TakeLockOptions {
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly log?: (message: string) => void;
}

/** The kernel's boot id, trimmed. `null` where there is none to read. */
export async function readBootId(host: Host): Promise<string | null> {
  const text = await host.readFile(BOOT_ID_PATH);
  const trimmed = text?.trim();
  return trimmed ? trimmed : null;
}

function isHolder(value: unknown): value is InstallLockHolder {
  return value === "bootstrap" || value === "update";
}

/** `null` for anything that is not a lock record this build wrote. */
export function parseInstallLock(text: string): InstallLockRecord | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const value = json as Record<string, unknown>;
  const pid = value["pid"];
  if (!isHolder(value["holder"]) || typeof pid !== "number" || !Number.isFinite(pid)) return null;
  return {
    holder: value["holder"],
    pid,
    boot_id: typeof value["boot_id"] === "string" ? value["boot_id"] : null,
    taken_at: typeof value["taken_at"] === "string" ? value["taken_at"] : "",
  };
}

export async function readInstallLock(host: Host): Promise<InstallLockRecord | null> {
  const text = await host.readFile(INSTALL_LOCK_PATH);
  return text === null ? null : parseInstallLock(text);
}

/**
 * Whether the process named by a lock is still there to hold it.
 *
 * Three answers, and the middle one is the point:
 *
 *  - a different boot id — nothing from that boot survived, so the lock is
 *    litter however alive its pid number looks today;
 *  - `/proc/<pid>` present — held, and nobody else may install;
 *  - `/proc` itself unreadable — we cannot tell, so the lock stands. An
 *    installer that guessed "probably dead" here would be guessing about the
 *    one case the lock exists to prevent.
 */
export async function installLockIsLive(
  host: Host,
  record: InstallLockRecord,
  selfPid: number,
): Promise<boolean> {
  const bootId = await readBootId(host);
  if (record.boot_id !== null && bootId !== null && record.boot_id !== bootId) return false;
  if (record.pid === selfPid) return true;
  const proc = await host.stat("/proc");
  if (proc === null) return true;
  return (await host.stat(`/proc/${record.pid}`)) !== null;
}

function heldLock(host: Host, record: InstallLockRecord): HeldInstallLock {
  return {
    record,
    async release(): Promise<void> {
      // Only ever our own: a lock judged stale and taken over by somebody else
      // must not be removed by the process whose death made it stale.
      const current = await readInstallLock(host);
      if (current === null) return;
      if (current.pid !== record.pid || current.taken_at !== record.taken_at) return;
      await host.remove(INSTALL_LOCK_PATH);
    },
  };
}

/**
 * Take the lock, or report who has it. `null` means "somebody live holds it" —
 * never "something went wrong", which throws.
 */
export async function takeInstallLock(
  host: Host,
  holder: InstallLockHolder,
  opts: TakeLockOptions = {},
): Promise<HeldInstallLock | null> {
  const self = opts.pid ?? process.pid;
  const record: InstallLockRecord = {
    holder,
    pid: self,
    boot_id: await readBootId(host),
    taken_at: host.now().toISOString(),
  };
  await host.mkdir(STATE_DIR, "0755");
  const staged = `${INSTALL_LOCK_PATH}.${self}`;
  await host.writeFile(staged, JSON.stringify(record) + "\n", "0644");
  try {
    // Two passes at most: one to find a lock there, one to take it after the
    // stale one has been cleared. A third would be a race with a third
    // installer, and there is no third installer on this box.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await host.link(staged, INSTALL_LOCK_PATH);
        return heldLock(host, record);
      } catch (e) {
        const code = (e as { code?: string }).code ?? "";
        if (NO_HARDLINK_CODES.has(code)) {
          /**
           * No exclusive create to be had on this filesystem, so the check and
           * the write are two steps rather than one. The window between them is
           * microseconds and there are at most two installers on a box, one of
           * which (the bootstrap runner) waits rather than races — and the
           * alternative is a filesystem on which no install is ever allowed.
           */
          const held = await readInstallLock(host);
          if (held !== null && (await installLockIsLive(host, held, self))) return null;
          await host.writeFile(INSTALL_LOCK_PATH, JSON.stringify(record) + "\n", "0644");
          return heldLock(host, record);
        }
        if (code !== "EEXIST") throw e;
      }
      const existing = await readInstallLock(host);
      // Unreadable is not held: a truncated lock names nobody, and leaving it
      // there would wedge every install on this box until somebody logged in.
      if (existing !== null && (await installLockIsLive(host, existing, self))) return null;
      await host.remove(INSTALL_LOCK_PATH);
    }
    return null;
  } finally {
    await host.remove(staged).catch(() => undefined);
  }
}

/**
 * Wait for the lock, and give up loudly rather than install alongside somebody.
 *
 * The bootstrap runner's caller: `Restart=on-failure`/`RestartSec=60` on
 * `hermeticd-bootstrap.service` means giving up is a retry a minute later, not
 * a dead box, and an update that is genuinely in flight finishes in well under
 * the wait.
 */
export async function waitForInstallLock(
  host: Host,
  holder: InstallLockHolder,
  opts: WaitLockOptions = {},
): Promise<HeldInstallLock> {
  const say = opts.log ?? (() => {});
  const pollMs = opts.pollMs ?? LOCK_POLL_MS;
  const deadline = host.now().getTime() + (opts.timeoutMs ?? LOCK_WAIT_MS);
  let announced = false;
  for (;;) {
    const lock = await takeInstallLock(host, holder, opts);
    if (lock !== null) return lock;
    const other = await readInstallLock(host);
    if (!announced) {
      announced = true;
      say(`waiting for the ${other?.holder ?? "other"} installer to finish before running stages`);
    }
    if (host.now().getTime() >= deadline) {
      throw new AgentdError(
        "CONFLICT",
        `another installer (${other?.holder ?? "unknown"}, pid ${other?.pid ?? "?"}) has held ` +
          `${INSTALL_LOCK_PATH} for longer than this boot is willing to wait`,
        { holder: other?.holder ?? null, pid: other?.pid ?? null },
      );
    }
    await host.sleep(pollMs);
  }
}
