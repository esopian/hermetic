/**
 * `hermeticd stage disk-prepare` (§4.3). These assertions moved here verbatim
 * from the old `bootstrap.test.ts`: the code changed address, the safety
 * property did not. `/data` holds an agent's whole memory, so the only
 * acceptable failure mode is refusing to act.
 */
import { describe, expect, test } from "bun:test";
import {
  DEVICE_WAIT_MS,
  isBlank,
  mountDataVolume,
  pickDataDevice,
  sizeToBytes,
  waitForDataDevice,
} from "../src/disk.ts";
import { collector } from "../src/events.ts";
import { FakeHost } from "./fake-host.ts";

/** A box with a freshly attached, genuinely blank 100 GiB volume. */
function box(): FakeHost {
  const host = new FakeHost();
  // blkid exit 2 is "no signature found": the device really is blank.
  host.when(/^blkid /, { code: 2 });
  host.seed("/dev/nvme1n1", "", "0660");
  return host;
}

describe("the data volume (§4.3, §6.5)", () => {
  test("a genuinely blank device is formatted once and mounted with nofail", async () => {
    const host = box();
    const { emit } = collector();

    expect(await isBlank(host, "/dev/nvme1n1")).toBe(true);
    await mountDataVolume(host, emit);

    expect(host.commandsMatching(/^mkfs\.ext4/)).toHaveLength(1);
    expect(host.commandsMatching(/^mount \/dev\/nvme1n1 \/data/)).toHaveLength(1);
    // `nofail` so a missing volume never wedges the boot into emergency mode.
    expect(host.files.get("/etc/fstab")?.content).toContain("nofail");
  });

  test("a reattached volume that already holds a filesystem is never formatted", async () => {
    const host = box();
    const { emit } = collector();
    host.when(/^blkid .*TYPE/, { stdout: "ext4\n" });

    await mountDataVolume(host, emit);

    expect(host.commandsMatching(/^mkfs\.ext4/)).toEqual([]);
    expect(host.commandsMatching(/^mount \/dev\/nvme1n1 \/data/)).toHaveLength(1);
  });

  test("an unknown blkid exit code aborts rather than guessing", async () => {
    const host = box();
    const { emit } = collector();
    host.when(/^blkid /, { code: 4, stderr: "usage error" });

    await expect(mountDataVolume(host, emit)).rejects.toThrow(/refusing to decide/);
    await expect(mountDataVolume(host, emit)).rejects.toMatchObject({ code: "COMMAND_FAILED" });
    expect(host.commandsMatching(/^mkfs\.ext4/)).toEqual([]);
  });

  test("wipefs seeing a signature vetoes the format even when blkid says nothing", async () => {
    const host = box();
    host.when(/^wipefs /, { stdout: "DEVICE OFFSET TYPE\nnvme1n1 0x438 ext4\n" });
    expect(await isBlank(host, "/dev/nvme1n1")).toBe(false);
  });

  test("neither wipefs nor lsblk able to inspect the device refuses to format it", async () => {
    const host = box();
    host.when(/^(wipefs|lsblk) /, { code: 1, stderr: "cannot open" });
    await expect(isBlank(host, "/dev/nvme1n1")).rejects.toThrow(/refusing to format it/);
  });

  test("an already-mounted /data is left alone", async () => {
    const host = box();
    const { emit } = collector();
    host.when(/^findmnt /, { stdout: "/dev/nvme1n1\n" });

    expect(await mountDataVolume(host, emit)).toBe("/dev/nvme1n1");
    expect(host.commandsMatching(/^mkfs\.ext4/)).toEqual([]);
    expect(host.commandsMatching(/^mount /)).toEqual([]);
  });

  test("the EBS device is polled for, not assumed present at boot", async () => {
    const host = new FakeHost();
    const { emit } = collector();

    let polls = 0;
    host.handlers.push((argv) => {
      if (argv[0] === "lsblk" && argv.includes("-J")) {
        polls += 1;
        // The volume attaches on the third look.
        if (polls >= 3) host.seed("/dev/nvme1n1", "", "0660");
        return { code: 0, stdout: JSON.stringify({ blockdevices: [] }), stderr: "" };
      }
      return null;
    });

    expect(await waitForDataDevice(host, emit)).toBe("/dev/nvme1n1");
    expect(host.sleeps.length).toBeGreaterThan(0);
  });

  test("a volume that never attaches fails with a directed error", async () => {
    const host = new FakeHost();
    const { emit } = collector();
    host.handlers.push((argv) =>
      argv[0] === "lsblk" && argv.includes("-J")
        ? { code: 0, stdout: JSON.stringify({ blockdevices: [] }), stderr: "" }
        : null,
    );

    expect(await waitForDataDevice(host, emit, DEVICE_WAIT_MS)).toBeNull();
    await expect(mountDataVolume(host, emit)).rejects.toThrow(/no data volume appeared/);
  });

  test("--wait-ms shortens the poll rather than being ignored", async () => {
    const host = new FakeHost();
    const { emit } = collector();
    host.handlers.push((argv) =>
      argv[0] === "lsblk" && argv.includes("-J")
        ? { code: 0, stdout: JSON.stringify({ blockdevices: [] }), stderr: "" }
        : null,
    );

    await expect(mountDataVolume(host, emit, "/data", 1_000)).rejects.toMatchObject({
      detail: { waited_ms: 1_000 },
    });
  });
});

describe("picking the device", () => {
  test("pickDataDevice picks the unmounted, unpartitioned disk", () => {
    const lsblk = JSON.stringify({
      blockdevices: [
        { name: "nvme0n1", type: "disk", mountpoint: null, children: [{ name: "nvme0n1p1" }] },
        { name: "nvme1n1", type: "disk", mountpoint: null, children: [] },
      ],
    });
    expect(pickDataDevice(lsblk)).toBe("/dev/nvme1n1");
    expect(pickDataDevice("not json")).toBeNull();
    expect(pickDataDevice(JSON.stringify({ blockdevices: [] }))).toBeNull();
  });

  test("pickDataDevice takes the LARGEST blank disk, not the first one listed", () => {
    // Two blank disks: a small stray one enumerated first, and the 100 GiB data
    // volume. Picking by enumeration order would format the wrong device.
    const lsblk = JSON.stringify({
      blockdevices: [
        { name: "nvme2n1", type: "disk", mountpoint: null, size: 8 * 1024 ** 3, children: [] },
        { name: "nvme1n1", type: "disk", mountpoint: null, size: 100 * 1024 ** 3, children: [] },
      ],
    });
    expect(pickDataDevice(lsblk)).toBe("/dev/nvme1n1");
  });

  test("pickDataDevice understands both `lsblk -b` bytes and human sizes", () => {
    const human = JSON.stringify({
      blockdevices: [
        { name: "sda", type: "disk", mountpoint: null, size: "8G", children: [] },
        { name: "sdb", type: "disk", mountpoint: null, size: "100G", children: [] },
      ],
    });
    expect(pickDataDevice(human)).toBe("/dev/sdb");
    expect(sizeToBytes("100G")).toBe(100 * 1024 ** 3);
    expect(sizeToBytes("512")).toBe(512);
    expect(sizeToBytes(1024)).toBe(1024);
    expect(sizeToBytes(undefined)).toBe(0);
    expect(sizeToBytes("nonsense")).toBe(0);
  });

  test("equal-sized blank disks are picked deterministically, by name", () => {
    const lsblk = JSON.stringify({
      blockdevices: [
        { name: "nvme2n1", type: "disk", mountpoint: null, size: 100, children: [] },
        { name: "nvme1n1", type: "disk", mountpoint: null, size: 100, children: [] },
      ],
    });
    expect(pickDataDevice(lsblk)).toBe("/dev/nvme1n1");
  });
});
