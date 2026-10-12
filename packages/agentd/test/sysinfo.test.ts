/**
 * `systeminformation` answers for every mount at once, and its own filter is a
 * substring match (`fsSize("/")` matches everything), so picking the mount that
 * holds a path is ours. The readings themselves are exercised against the real
 * library in `host.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { mountFor } from "../src/sysinfo.ts";

describe("mountFor", () => {
  const mounts = ["/", "/data", "/boot/efi", "/data/archive"];

  test("the longest mount holding the path wins", () => {
    expect(mountFor(mounts, "/data")).toBe("/data");
    expect(mountFor(mounts, "/data/hermes/logs")).toBe("/data");
    expect(mountFor(mounts, "/data/archive/x")).toBe("/data/archive");
    expect(mountFor(mounts, "/usr/local/bin")).toBe("/");
    expect(mountFor(mounts, "/")).toBe("/");
  });

  test("a mount is a directory prefix, not a string prefix", () => {
    expect(mountFor(mounts, "/database")).toBe("/");
    expect(mountFor(mounts, "/boot/efi-old")).toBe("/");
  });

  test("no mount holds it: null", () => {
    expect(mountFor(["/data"], "/usr")).toBeNull();
    expect(mountFor([], "/")).toBeNull();
    expect(mountFor(mounts, "relative/path")).toBeNull();
  });
});
