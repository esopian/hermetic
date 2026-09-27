/**
 * The one file in the suite that uses the *real* `Host`.
 *
 * Everything else runs against `FakeHost`, which is the right trade almost
 * everywhere — but atomicity is a property of the implementation, not of the
 * interface, and a fake that models "the write happened" cannot tell you
 * whether a write that *didn't* happen left a mangled file behind. So this runs
 * against `node:fs` in a temp directory: no root, no network, no systemd, and
 * nothing outside `mkdtemp` is touched.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realHost, stagingPathFor } from "../src/host.ts";

const host = realHost();
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hermeticd-host-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const octal = (mode: number): string => "0" + (mode & 0o777).toString(8).padStart(3, "0");

describe("every write is all of it or none of it (§8.3)", () => {
  test("a write lands with its content and its mode, and leaves no staged file behind", async () => {
    const path = join(dir, "secrets.env");

    await host.writeFile(path, "NOUS_API_KEY=x\n", "0600");

    expect(await readFile(path, "utf8")).toBe("NOUS_API_KEY=x\n");
    expect(octal((await stat(path)).mode)).toBe("0600");
    expect(await readdir(dir)).toEqual(["secrets.env"]);
  });

  test("a rewrite with no mode keeps the mode the file already had", async () => {
    const path = join(dir, "unit");
    await host.writeFile(path, "one\n", "0640");

    await host.writeFile(path, "two\n");

    expect(await readFile(path, "utf8")).toBe("two\n");
    // A rename replaces the inode, so the mode has to be carried across on
    // purpose — `writeFile(path, content)` has always meant "leave it alone".
    expect(octal((await stat(path)).mode)).toBe("0640");
  });

  /**
   * The failure the staging exists for. A direct `write(2)` that dies partway
   * leaves the truncated prefix *at the target* — a systemd unit or a
   * `fleet.json` that parses as far as it goes and is wrong after that, on a
   * box nobody is watching. Staging makes the rename the only observable step,
   * so a failed write is a write that did not happen.
   *
   * The failure is provoked by putting a directory where the staged file wants
   * to be: the open fails, and the question is what the target looks like
   * afterwards.
   */
  test("a write that fails leaves the previous content exactly as it was", async () => {
    const path = join(dir, "fleet.json");
    await host.writeFile(path, '{"schema_version":1}\n', "0644");
    // Staging cannot be blocked by planting a file any more (the name is
    // random and the open is `O_EXCL`), so the failure comes from the one
    // place left: a directory nothing may be created in.
    await chmod(dir, 0o500);
    try {
      await expect(host.writeFile(path, "the new manifest\n", "0644")).rejects.toThrow();
    } finally {
      await chmod(dir, 0o700);
    }

    expect(await readFile(path, "utf8")).toBe('{"schema_version":1}\n');
    expect(await readdir(dir)).toEqual(["fleet.json"]);
  });

  test("a first write that fails leaves no file at all — never an empty one", async () => {
    const path = join(dir, "fleet.json");
    await chmod(dir, 0o500);
    try {
      await expect(host.writeBytes(path, new TextEncoder().encode("bytes"), "0644")).rejects.toThrow();
    } finally {
      await chmod(dir, 0o700);
    }

    expect(await stat(path).catch(() => null)).toBeNull();
  });

  /**
   * These writes happen as root into directories a less privileged account may
   * be able to create entries in. A staging name anyone can predict is a file
   * — or a symlink to somewhere else entirely — that root can be made to write
   * through. The name is random and the open is `O_EXCL`, so a planted file at
   * the name does not receive the bytes: it makes the write fail.
   */
  test("a file already at the staging name is never written through", async () => {
    const path = join(dir, "unit");
    await host.writeFile(path, "one\n", "0640");
    const planted = stagingPathFor(path, "deadbeef");
    await writeFile(planted, "planted\n");

    // Forced onto the planted name, `O_EXCL` refuses rather than truncating it.
    await expect(open(planted, "wx", 0o600).then((h) => h.close())).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(await readFile(planted, "utf8")).toBe("planted\n");

    // …and the write that picks its own name still succeeds around it.
    await host.writeFile(path, "two\n", "0640");
    expect(await readFile(path, "utf8")).toBe("two\n");
  });

  /**
   * A symlink at the target is either a mistake or somebody redirecting a root
   * write. Following it would replace the link with a regular file *and* adopt
   * the destination's mode; refusing is the only answer that cannot be turned
   * into a primitive.
   */
  test("a symlink at the target is refused, not written through", async () => {
    const target = join(dir, "elsewhere");
    const link = join(dir, "unit");
    await writeFile(target, "original\n");
    await symlink(target, link);

    await expect(host.writeFile(link, "hijacked\n", "0644")).rejects.toThrow(/symlink/);

    expect(await readFile(target, "utf8")).toBe("original\n");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });

  test("the staged file is cleaned up when the write fails after it was opened", async () => {
    const path = join(dir, "nested", "unit");
    // The parent exists, so staging succeeds; the *rename* is what fails, onto
    // a target that is a non-empty directory.
    await mkdir(join(dir, "nested", "unit"), { recursive: true });
    await writeFile(join(path, "occupant"), "x");

    await expect(host.writeFile(path, "content\n", "0644")).rejects.toThrow();

    expect(await readdir(join(dir, "nested"))).toEqual(["unit"]);
  });

  test("the staging name is a random sibling, never a predictable one", () => {
    expect(stagingPathFor("/usr/local/bin/hermeticd", "abc")).toBe("/usr/local/bin/.hermeticd.tmp.abc");
    // Dot-prefixed, because `installStages`'s prune skips dot entries — a write
    // in flight is not a file a release stopped naming.
    expect(stagingPathFor("/opt/hermetic/stages/00-preflight.sh", "abc")).toBe(
      "/opt/hermetic/stages/.00-preflight.sh.tmp.abc",
    );
    // Two calls, two names: neither a second process nor an onlooker can guess
    // where the next write will be staged.
    const names = new Set(Array.from({ length: 8 }, () => stagingPathFor("/usr/local/bin/hermeticd")));
    expect(names.size).toBeGreaterThan(1);
  });

  test("a hard link puts a file beside itself without the original going away", async () => {
    const path = join(dir, "hermeticd");
    await host.writeFile(path, "ELF\n", "0755");

    await host.link(path, join(dir, "hermeticd.prev"));

    expect(await readFile(path, "utf8")).toBe("ELF\n");
    expect(await readFile(join(dir, "hermeticd.prev"), "utf8")).toBe("ELF\n");
  });

  test("appendFile is still an append — a stage log is written a line at a time", async () => {
    const path = join(dir, "stage.log");
    await host.appendFile(path, "one\n", "0644");
    await host.appendFile(path, "two\n");
    expect(await readFile(path, "utf8")).toBe("one\ntwo\n");
  });
});

/**
 * A followed read has no end of its own. Nothing makes `tail -F` — or
 * `journalctl --follow` — exit, and neither notices a closed pipe until it next
 * writes, which on the quiet log an operator has stopped watching is never. So
 * the consumer going away has to kill the child.
 *
 * A real `tail -F`, on a real file, with no network: the generator parks
 * exactly where it parks on the box, and the test hangs until its own timeout
 * if the kill does not happen. The child is spawned directly rather than under
 * a shell on purpose — a shell that forks keeps the write end of the pipe open
 * in a process the signal never reached, so the stream would not close even
 * though the command was killed.
 */
describe("a followed `execLines` does not outlive its reader", () => {
  test("aborting the signal ends the stream, even parked between lines", async () => {
    const path = join(dir, "followed.log");
    await writeFile(path, "one\n");
    const stop = new AbortController();
    const lines: string[] = [];

    for await (const line of host.execLines(["tail", "-n", "1", "-F", path], {
      signal: stop.signal,
    })) {
      lines.push(line);
      // Parks the generator inside its next read, which is the position a
      // `return()` from the consumer cannot reach — see `ExecOptions.signal`.
      stop.abort();
    }

    expect(lines).toEqual(["one"]);
  });
});
