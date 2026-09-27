/**
 * `hermeticd stage disk-prepare` — wait for the data volume, decide (very
 * carefully) whether it may be formatted, mount it at `/data` and record it in
 * `/etc/fstab` (§4.3, §6.5).
 *
 * This is the reason the bootstrap stages are shell that calls TypeScript
 * rather than shell that does the work: `/data` is a separate gp3 volume so an
 * agent's memory and skills survive a rebuild, and a `mkfs` over a reattached
 * volume is the one mistake on this box that cannot be undone. The blank check
 * therefore demands two independent probes agree, and refuses on anything it
 * does not understand instead of guessing.
 *
 * Behaviour is unchanged from the pre-stages `bootstrap.ts`; only its home is.
 */
import type { Host } from "./host.ts";
import { must } from "./host.ts";
import type { Emit } from "./events.ts";
import { opEvent } from "./events.ts";
import { AgentdError } from "./errors.ts";

export const DATA_MOUNT = "/data";
/** Candidate data-volume devices, most specific first. */
const DEVICE_CANDIDATES = ["/dev/disk/by-label/hermetic-data", "/dev/nvme1n1", "/dev/xvdf"];
/** EBS attachment is asynchronous; the device can appear well after boot. */
export const DEVICE_WAIT_MS = 60_000;
export const DEVICE_POLL_MS = 2_000;

/** EBS attachment is asynchronous, so the device is polled rather than assumed. */
export async function waitForDataDevice(
  host: Host,
  emit: Emit,
  timeoutMs = DEVICE_WAIT_MS,
  expectedVolumeId?: string,
): Promise<string | null> {
  const deadline = host.now().getTime() + timeoutMs;
  let announced = false;
  for (;;) {
    if (expectedVolumeId === undefined) {
      for (const candidate of DEVICE_CANDIDATES) {
        if ((await host.stat(candidate)) !== null) return candidate;
      }
    }
    // `-b` so SIZE is bytes, which is what `pickDataDevice` sorts on.
    // SERIAL is the EBS volume id on NVMe instances (`vol0123...`, without
    // AWS's dash). When the row supplies that identity, no path or size
    // heuristic is allowed to outrank it.
    const lsblk = await host.exec(["lsblk", "-J", "-b", "-o", "NAME,TYPE,MOUNTPOINT,SIZE,SERIAL"]);
    const picked = pickDataDevice(lsblk.stdout, expectedVolumeId);
    if (picked) return picked;

    if (host.now().getTime() >= deadline) return null;
    if (!announced) {
      emit(opEvent("volume", 0.36, "waiting for the data volume to attach", host.now()));
      announced = true;
    }
    await host.sleep(DEVICE_POLL_MS);
  }
}

/**
 * `/data` is a separate gp3 volume so memory and skills survive a rebuild
 * (§6.5). It is formatted only when it is provably blank: `blkid` exiting 2 (no
 * signature found) *and* `wipefs -n` printing nothing. Any other `blkid` exit is
 * an unknown state, and hermeticd aborts rather than risk mkfs over a
 * reattached volume that holds an agent's whole memory.
 */
export async function mountDataVolume(
  host: Host,
  emit: Emit,
  mount: string = DATA_MOUNT,
  timeoutMs: number = DEVICE_WAIT_MS,
  expectedVolumeId?: string,
): Promise<string | null> {
  const mounted = await host.exec(["findmnt", "-n", "-o", "SOURCE", mount]);
  if (mounted.code === 0 && mounted.stdout.trim().length > 0) {
    const source = mounted.stdout.trim();
    if (expectedVolumeId !== undefined) {
      await assertVolumeIdentity(host, source, mount, expectedVolumeId);
    }
    await reconcileFstab(host, source, mount);
    emit(opEvent("volume", 0.4, `${mount} already mounted`, host.now()));
    return source;
  }

  const device = await waitForDataDevice(host, emit, timeoutMs, expectedVolumeId);
  if (!device) {
    throw new AgentdError(
      "INTERNAL",
      expectedVolumeId === undefined
        ? `no data volume appeared to mount at ${mount}`
        : `data volume ${expectedVolumeId} did not appear to mount at ${mount}; refusing another disk`,
      { waited_ms: timeoutMs, expected_volume_id: expectedVolumeId ?? null },
    );
  }

  if (await isBlank(host, device)) {
    emit(opEvent("volume", 0.38, `formatting ${device} ext4`, host.now()));
    await must(host, ["mkfs.ext4", "-L", "hermetic-data", "-m", "0", device]);
  } else {
    emit(opEvent("volume", 0.38, `${device} already holds a filesystem; mounting as-is`, host.now()));
  }

  await host.mkdir(mount, "0755");
  await must(host, ["mount", device, mount]);
  await reconcileFstab(host, device, mount);
  return device;
}

/** EBS spells `vol-0123` as `vol0123` in an NVMe serial. */
function normalizedVolumeId(value: string): string {
  return value.trim().toLowerCase().replaceAll("-", "");
}

/** Refuse an already-mounted filesystem when it belongs to another EBS volume. */
async function assertVolumeIdentity(
  host: Host,
  source: string,
  mount: string,
  expectedVolumeId: string,
): Promise<void> {
  const serial = await host.exec(["lsblk", "-ndo", "SERIAL", source]);
  const actual = serial.code === 0 ? serial.stdout.trim() : "";
  if (actual.length > 0 && normalizedVolumeId(actual) === normalizedVolumeId(expectedVolumeId)) return;
  throw new AgentdError(
    "INTERNAL",
    `${mount} is mounted from ${source}, but its EBS identity is ${actual || "unreadable"}; expected ${expectedVolumeId}`,
    { source, expected_volume_id: expectedVolumeId, actual_volume_id: actual || null },
  );
}

/**
 * Record exactly one `/data` entry, replacing stale identities rather than
 * appending another line that systemd may interpret in a different order.
 */
async function reconcileFstab(host: Host, device: string, mount: string): Promise<void> {
  const uuid = (await host.exec(["blkid", "-o", "value", "-s", "UUID", device])).stdout.trim();
  const spec = uuid ? `UUID=${uuid}` : device;
  // `nofail` so a missing volume never wedges the boot into emergency mode.
  const wanted = `${spec} ${mount} ext4 defaults,nofail 0 2`;
  const current = (await host.readFile("/etc/fstab")) ?? "";
  const lines = current.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const kept = lines.filter((line) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return true;
    return trimmed.split(/\s+/)[1] !== mount;
  });
  const next = [...kept, wanted].join("\n") + "\n";
  if (next !== current) await host.writeFile("/etc/fstab", next);
}

/**
 * True only when both probes agree the device carries no signature at all.
 * `blkid` exit 2 means "nothing found"; 0 means a filesystem exists; anything
 * else (2 is the only benign non-zero) is an error we refuse to interpret.
 */
export async function isBlank(host: Host, device: string): Promise<boolean> {
  const blkid = await host.exec(["blkid", "-o", "value", "-s", "TYPE", device]);
  if (blkid.code === 0) return false;
  if (blkid.code !== 2) {
    throw new AgentdError(
      "COMMAND_FAILED",
      `blkid ${device} exited ${blkid.code}; refusing to decide whether the data volume is blank`,
      { device, code: blkid.code },
    );
  }
  if (blkid.stdout.trim().length > 0) return false;

  // Second opinion: `wipefs -n` lists signatures without touching them.
  const wipefs = await host.exec(["wipefs", "-n", device]);
  if (wipefs.code !== 0) {
    const fstype = await host.exec(["lsblk", "-no", "FSTYPE", device]);
    if (fstype.code !== 0) {
      throw new AgentdError(
        "COMMAND_FAILED",
        `neither wipefs nor lsblk could inspect ${device}; refusing to format it`,
        { device },
      );
    }
    return fstype.stdout.trim().length === 0;
  }
  return wipefs.stdout.trim().length === 0;
}

/**
 * The largest `disk` with no mountpoint and no partitions — the attached data
 * volume. Size decides it because the root volume is deliberately small and
 * disposable while `/data` is 100 GiB by default (§7.1), and because `lsblk`
 * enumeration order is not something to depend on.
 */
export function pickDataDevice(lsblkJson: string, expectedVolumeId?: string): string | null {
  interface Node {
    name?: string;
    type?: string;
    mountpoint?: string | null;
    size?: string | number;
    serial?: string | null;
    children?: Node[];
  }
  let parsed: { blockdevices?: Node[] };
  try {
    parsed = JSON.parse(lsblkJson) as { blockdevices?: Node[] };
  } catch {
    return null;
  }
  const candidates = (parsed.blockdevices ?? [])
    .filter((d) => d.type === "disk" && !d.mountpoint && (d.children ?? []).length === 0 && d.name)
    .map((d) => ({ name: d.name as string, bytes: sizeToBytes(d.size), serial: d.serial ?? "" }))
    .filter(
      (d) =>
        expectedVolumeId === undefined ||
        normalizedVolumeId(d.serial) === normalizedVolumeId(expectedVolumeId),
    )
    .sort((a, b) => b.bytes - a.bytes || (a.name < b.name ? -1 : 1));
  const first = candidates[0];
  return first ? `/dev/${first.name}` : null;
}

const SIZE_SUFFIXES: Readonly<Record<string, number>> = {
  B: 1,
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
  P: 1024 ** 5,
};

/**
 * `lsblk -b` reports bytes as a number, but a human-readable `100G` is what an
 * older lsblk (or a caller that forgot `-b`) hands back, so both are accepted.
 */
export function sizeToBytes(size: string | number | undefined): number {
  if (typeof size === "number") return Number.isFinite(size) ? size : 0;
  if (!size) return 0;
  const trimmed = size.trim();
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) return numeric;
  const match = /^([\d.]+)\s*([BKMGTP])/i.exec(trimmed);
  if (!match?.[1] || !match[2]) return 0;
  return Number(match[1]) * (SIZE_SUFFIXES[match[2].toUpperCase()] ?? 1);
}
