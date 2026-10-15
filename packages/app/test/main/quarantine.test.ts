/**
 * `main/quarantine.ts`: a file `files.get` saved is marked with
 * `com.apple.quarantine` on macOS, through `/usr/bin/xattr` with an argv, and
 * never fails the download.
 */
import { expect, test } from "bun:test";
import { QUARANTINE_ATTR, XATTR, markQuarantined, quarantineValue } from "../../src/main/quarantine.ts";

const PATH = "/tmp/hermetic-quarantine/report.pdf";

test("darwin: one xattr -w with the download flags, the hex time and the app's name", async () => {
  const calls: string[][] = [];
  await markQuarantined(PATH, {
    platform: "darwin",
    now: () => 1_700_000_000_000,
    spawn: async (argv) => {
      calls.push(argv);
      return 0;
    },
  });
  expect(calls).toEqual([[XATTR, "-w", QUARANTINE_ATTR, "0081;6553f100;Hermetic;", PATH]]);
  expect(quarantineValue(1_700_000_000_999)).toBe("0081;6553f100;Hermetic;");
});

test("another platform runs nothing", async () => {
  let ran = false;
  await markQuarantined(PATH, {
    platform: "linux",
    spawn: async () => {
      ran = true;
      return 0;
    },
  });
  expect(ran).toBe(false);
});

test("a failing or missing xattr is swallowed", async () => {
  await markQuarantined(PATH, {
    platform: "darwin",
    spawn: async () => {
      throw new Error("ENOENT");
    },
  });
  await markQuarantined(PATH, { platform: "darwin", spawn: async () => 1 });
});

test("a hung xattr is abandoned and killed after the timeout", async () => {
  let killed = false;
  const started = Date.now();
  await markQuarantined(PATH, {
    platform: "darwin",
    timeoutMs: 20,
    spawn: (_argv, signal) =>
      new Promise<number>((resolve) => {
        signal.addEventListener("abort", () => {
          killed = true;
          resolve(137);
        });
      }),
  });
  expect(killed).toBe(true);
  expect(Date.now() - started).toBeLessThan(1000);
});
