/**
 * Which disk becomes `/data`, and what the box writes down about it (§4.3,
 * §6.5).
 *
 * `disk.test.ts` covers the decision that cannot be undone — whether to format.
 * This file covers the one before it: *which* device that decision is made
 * about, and whether the identity recorded in `/etc/fstab` is the volume's own
 * or merely the name this boot happened to give it. A device name is not an
 * identity: `/dev/nvme1n1` is whatever EBS attached second, and the same volume
 * comes back as `/dev/nvme2n1` on a box whose root disk enumerated differently.
 */
import { describe, expect, test } from "bun:test";
import { mountDataVolume, pickDataDevice, waitForDataDevice } from "../src/disk.ts";
import { collector } from "../src/events.ts";
import { FakeHost } from "./fake-host.ts";

/** The label `mkfs.ext4 -L hermetic-data` wrote, as a device path. */
const BY_LABEL = "/dev/disk/by-label/hermetic-data";
const UUID = "6f3b2c1a-4d5e-4f60-8a71-b2c3d4e5f607";
const OTHER_UUID = "11111111-2222-4333-8444-555555555555";

/** `blkid -o value -s UUID <device>` answers, and nothing else does. */
function withUuid(host: FakeHost, uuid: string): void {
  host.handlers.unshift((argv) =>
    argv[0] === "blkid" && argv.includes("UUID") ? { code: 0, stdout: `${uuid}\n`, stderr: "" } : null,
  );
}

/** What `lsblk -J -b` reports on this box. */
function withLsblk(host: FakeHost, blockdevices: unknown[]): void {
  host.handlers.unshift((argv) =>
    argv[0] === "lsblk" && argv.includes("-J")
      ? { code: 0, stdout: JSON.stringify({ blockdevices }), stderr: "" }
      : null,
  );
}

const fstabLines = (host: FakeHost): string[] =>
  (host.files.get("/etc/fstab")?.content ?? "").split("\n").filter((line) => line.includes(" /data "));

describe("which disk is /data", () => {
  test("the label written at mkfs is a device candidate of its own", async () => {
    const host = new FakeHost();
    const { emit } = collector();
    // The one name that follows the volume rather than the boot: a rebuilt box
    // reattaching this disk finds it here whatever nvme called it this time.
    host.seed(BY_LABEL, "", "0660");

    expect(await waitForDataDevice(host, emit)).toBe(BY_LABEL);
    // Recorded identity beats enumeration: nothing had to be sized up.
    expect(host.commandsMatching(/^lsblk/)).toEqual([]);
  });

  test("a candidate device is taken without asking lsblk which disk is biggest", async () => {
    const host = new FakeHost();
    const { emit } = collector();
    host.seed("/dev/nvme1n1", "", "0660");
    // A larger blank disk that is not the data volume. Size is the fallback
    // heuristic, and it must not outrank a device the box already knows to look
    // for.
    withLsblk(host, [
      { name: "nvme3n1", type: "disk", mountpoint: null, size: 900 * 1024 ** 3, children: [] },
    ]);

    expect(await waitForDataDevice(host, emit)).toBe("/dev/nvme1n1");
    expect(host.commandsMatching(/^lsblk/)).toEqual([]);
  });

  test("a row-sourced EBS identity outranks a familiar device path", async () => {
    const host = new FakeHost();
    const { emit } = collector();
    host.seed("/dev/nvme1n1", "", "0660");
    withLsblk(host, [
      {
        name: "nvme1n1",
        type: "disk",
        mountpoint: null,
        size: 100 * 1024 ** 3,
        serial: "vol0wrong00000000001",
        children: [],
      },
      {
        name: "nvme3n1",
        type: "disk",
        mountpoint: null,
        size: 50 * 1024 ** 3,
        serial: "vol0right00000000001",
        children: [],
      },
    ]);

    expect(await waitForDataDevice(host, emit, 1_000, "vol-0right00000000001")).toBe("/dev/nvme3n1");
  });

  test("a missing expected EBS identity never falls back to the largest blank disk", async () => {
    const host = new FakeHost();
    const { emit } = collector();
    withLsblk(host, [
      {
        name: "nvme3n1",
        type: "disk",
        mountpoint: null,
        size: 900 * 1024 ** 3,
        serial: "vol0wrong00000000001",
        children: [],
      },
    ]);

    expect(await waitForDataDevice(host, emit, 1_000, "vol-0right00000000001")).toBeNull();
    await expect(mountDataVolume(host, emit, "/data", 1_000, "vol-0right00000000001")).rejects.toThrow(
      /refusing another disk/,
    );
    expect(host.commandsMatching(/^mkfs\.ext4/)).toEqual([]);
  });

  test("a disk something else is already mounted on is never chosen", () => {
    const lsblk = JSON.stringify({
      blockdevices: [
        { name: "nvme0n1", type: "disk", mountpoint: "/", size: 900 * 1024 ** 3, children: [] },
        { name: "nvme1n1", type: "disk", mountpoint: null, size: 100 * 1024 ** 3, children: [] },
      ],
    });
    // The root volume is the larger of the two here, which is the case size
    // alone gets wrong.
    expect(pickDataDevice(lsblk)).toBe("/dev/nvme1n1");
  });

  test("a box where every disk is spoken for picks nothing rather than guessing", async () => {
    const host = new FakeHost();
    const { emit } = collector();
    withLsblk(host, [
      { name: "nvme0n1", type: "disk", mountpoint: "/", size: 900 * 1024 ** 3, children: [] },
      { name: "nvme2n1", type: "disk", mountpoint: "/var/log", size: 8 * 1024 ** 3, children: [] },
    ]);

    expect(await waitForDataDevice(host, emit, 1_000)).toBeNull();
    await expect(mountDataVolume(host, emit, "/data", 1_000)).rejects.toThrow(/no data volume/);
    expect(host.commandsMatching(/^mkfs\.ext4/)).toEqual([]);
  });

  test("an already-mounted /data is reported by its source, whatever device that is", async () => {
    const host = new FakeHost();
    const { emit } = collector();
    // Not one of the candidates, and not the device this boot would have
    // picked: `/data` is already mounted, so nothing about it is this run's to
    // decide.
    host.handlers.unshift((argv) =>
      argv[0] === "findmnt" ? { code: 0, stdout: "/dev/nvme7n1\n", stderr: "" } : null,
    );

    expect(await mountDataVolume(host, emit)).toBe("/dev/nvme7n1");
    expect(host.commandsMatching(/^mkfs\.ext4/)).toEqual([]);
    expect(host.commandsMatching(/^mount /)).toEqual([]);
    expect(fstabLines(host)).toEqual(["/dev/nvme7n1 /data ext4 defaults,nofail 0 2"]);
  });

  test("an already-mounted disk with the wrong EBS identity is refused", async () => {
    const host = new FakeHost();
    const { emit } = collector();
    host.handlers.unshift((argv) => {
      if (argv[0] === "findmnt") return { code: 0, stdout: "/dev/nvme7n1\n", stderr: "" };
      if (argv[0] === "lsblk" && argv.includes("SERIAL")) {
        return { code: 0, stdout: "vol0wrong00000000001\n", stderr: "" };
      }
      return null;
    });

    await expect(mountDataVolume(host, emit, "/data", 1_000, "vol-0right00000000001")).rejects.toThrow(
      /expected vol-0right/,
    );
    expect(host.commandsMatching(/^mkfs\.ext4/)).toEqual([]);
  });
});

describe("the identity /etc/fstab records", () => {
  test("the volume's UUID is recorded, not the device name this boot gave it", async () => {
    const host = new FakeHost();
    const { emit } = collector();
    host.seed("/dev/nvme1n1", "", "0660");
    withUuid(host, UUID);

    await mountDataVolume(host, emit);

    expect(fstabLines(host)).toEqual([`UUID=${UUID} /data ext4 defaults,nofail 0 2`]);
    // The name is this boot's; a reattach to a differently enumerated box would
    // mount the wrong disk, or nothing at all.
    expect(host.files.get("/etc/fstab")?.content).not.toContain("/dev/nvme1n1 /data");
  });

  test("a device with no UUID to read is recorded by path rather than not at all", async () => {
    const host = new FakeHost();
    const { emit } = collector();
    host.seed("/dev/nvme1n1", "", "0660");
    // The FakeHost default: `blkid` exits 2, which is also what it answers for
    // a freshly made filesystem on a kernel that has not reread the table.

    await mountDataVolume(host, emit);

    expect(fstabLines(host)).toEqual(["/dev/nvme1n1 /data ext4 defaults,nofail 0 2"]);
  });

  test("an fstab that already names this volume is left byte for byte alone", async () => {
    const host = new FakeHost();
    const { emit } = collector();
    host.seed("/dev/nvme1n1", "", "0660");
    withUuid(host, UUID);
    const existing = `UUID=root / ext4 defaults 0 1\nUUID=${UUID} /data ext4 defaults,nofail 0 2\n`;
    host.seed("/etc/fstab", existing);

    await mountDataVolume(host, emit);

    expect(host.files.get("/etc/fstab")?.content).toBe(existing);
  });

  test("a stale /data entry is replaced by the mounted volume's identity", async () => {
    const host = new FakeHost();
    const { emit } = collector();
    host.seed("/dev/nvme1n1", "", "0660");
    withUuid(host, UUID);
    host.seed("/etc/fstab", `UUID=${OTHER_UUID} /data ext4 defaults,nofail 0 2\n`);

    await mountDataVolume(host, emit);

    expect(fstabLines(host)).toEqual([`UUID=${UUID} /data ext4 defaults,nofail 0 2`]);
  });

  test("an fstab with no trailing newline is extended, not joined onto", async () => {
    const host = new FakeHost();
    const { emit } = collector();
    host.seed("/dev/nvme1n1", "", "0660");
    withUuid(host, UUID);
    host.seed("/etc/fstab", "UUID=root / ext4 defaults 0 1");

    await mountDataVolume(host, emit);

    expect(host.files.get("/etc/fstab")?.content).toBe(
      `UUID=root / ext4 defaults 0 1\nUUID=${UUID} /data ext4 defaults,nofail 0 2\n`,
    );
  });
});
