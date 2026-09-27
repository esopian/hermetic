/**
 * Unpacking a config bundle that is a *real* gzipped tar (§6.5).
 *
 * `manifest.test.ts` covers the JSON stand-in core renders in fixtures, which
 * needs no tar at all, and every other suite hands `readBundleManifest` that
 * shape or a `FakeHost` whose `tar` is a stub. Nothing exercised the path the
 * box actually takes: bytes out of S3, written to disk, handed to `tar -xzf`,
 * read back as files. So these tests build genuine archives and run them
 * through the production function on a `realHost`, in a temporary directory.
 *
 * Offline and deterministic: `tar` is spawned locally for the ordinary archives
 * and the awkward ones are assembled here, header by header, because `tar`
 * refuses to *create* the members they are about — an entry that climbs out of
 * the directory it is extracted into.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgentdError } from "../src/errors.ts";
import { realHost } from "../src/host.ts";
import { readBundleManifest } from "../src/manifest.ts";
import { makeManifest } from "./fixtures.ts";

const host = realHost();
const MANIFEST = makeManifest();

/** Where the bundle is unpacked, and a sibling nothing may ever write into. */
let root: string;
let dest: string;
let staging: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hermeticd-bundle-"));
  dest = join(root, "etc-hermetic");
  staging = join(root, "staging");
  await mkdir(dest);
  await mkdir(staging);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Member {
  readonly name: string;
  readonly body: string;
  readonly mode?: number;
}

/** A real `.tgz`, built by the same `tar` that will unpack it. */
async function tarball(members: readonly Member[]): Promise<Uint8Array> {
  for (const member of members) {
    const path = join(staging, member.name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, member.body);
    if (member.mode !== undefined) await chmod(path, member.mode);
  }
  const archive = join(root, "bundle-source.tgz");
  const proc = Bun.spawn(["tar", "-czf", archive, "-C", staging, ...members.map((m) => m.name)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await proc.exited).toBe(0);
  return await Bun.file(archive).bytes();
}

/**
 * A gzipped tar assembled from ustar headers, for the members `tar` will not
 * create: it strips a leading `../` or `/` from a member name as it writes the
 * archive, which is precisely the thing being tested for on the way back out.
 */
function handBuiltArchive(members: readonly Member[]): Uint8Array {
  const encoder = new TextEncoder();
  const blocks: Uint8Array[] = [];
  for (const member of members) {
    const header = new Uint8Array(512);
    const put = (text: string, offset: number, length: number): void => {
      header.set(encoder.encode(text).subarray(0, length), offset);
    };
    const body = encoder.encode(member.body);
    put(member.name, 0, 100);
    put((member.mode ?? 0o644).toString(8).padStart(7, "0"), 100, 8);
    put("0000000", 108, 8);
    put("0000000", 116, 8);
    put(body.length.toString(8).padStart(11, "0"), 124, 12);
    // A fixed mtime, so the same members always make the same bytes.
    put("0".repeat(11), 136, 12);
    // The checksum is computed with its own field full of spaces.
    put(" ".repeat(8), 148, 8);
    put("0", 156, 1);
    put("ustar", 257, 6);
    put("00", 263, 2);
    let sum = 0;
    for (const byte of header) sum += byte;
    put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
    blocks.push(header);
    const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
    padded.set(body);
    blocks.push(padded);
  }
  // Two zero blocks end the archive.
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((n, block) => n + block.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    joined.set(block, offset);
    offset += block.length;
  }
  return Bun.gzipSync(joined);
}

const manifestMember = (): Member => ({
  name: "manifest.json",
  body: `${JSON.stringify(MANIFEST)}\n`,
  mode: 0o600,
});

describe("a real config bundle", () => {
  test("unpacks through `tar` and yields the manifest it carries", async () => {
    const bytes = await tarball([
      manifestMember(),
      { name: "extra/hermes/config.yaml", body: "model:\n  default: fixture\n", mode: 0o600 },
      { name: "extra/bin/refresh.sh", body: "#!/usr/bin/env bash\nexit 0\n", mode: 0o755 },
    ]);

    const manifest = await readBundleManifest(bytes, host, dest);

    expect(manifest.config_hash).toBe(MANIFEST.config_hash);
    expect(manifest.name).toBe(MANIFEST.name);
    // The whole tree lands, not just the file that was read back.
    expect(await Bun.file(join(dest, "extra/hermes/config.yaml")).text()).toBe(
      "model:\n  default: fixture\n",
    );
    expect(await Bun.file(join(dest, "extra/bin/refresh.sh")).text()).toContain("bash");
  });

  test("the modes in the archive are the modes on disk", async () => {
    const bytes = await tarball([
      manifestMember(),
      { name: "extra/bin/refresh.sh", body: "#!/usr/bin/env bash\nexit 0\n", mode: 0o755 },
    ]);

    await readBundleManifest(bytes, host, dest);

    // A bundle carries rendered config, so a member the archive kept private
    // must not arrive group-readable — and a script must arrive executable.
    expect((await host.stat(join(dest, "manifest.json")))?.mode).toBe("0600");
    expect((await host.stat(join(dest, "extra/bin/refresh.sh")))?.mode).toBe("0755");
  });

  test("the downloaded archive is staged 0600 and left in the bundle directory", async () => {
    const bytes = await tarball([manifestMember()]);

    await readBundleManifest(bytes, host, dest);

    expect((await host.stat(join(dest, "bundle.tgz")))?.mode).toBe("0600");
  });

  test("an archive with no manifest.json is refused, not half-adopted", async () => {
    const bytes = await tarball([{ name: "extra/notes.txt", body: "nothing to see\n" }]);

    await expect(readBundleManifest(bytes, host, dest)).rejects.toMatchObject({
      code: "MANIFEST_REFUSED",
    });
    // …and the refusal is about the manifest, after an unpack that worked.
    expect(existsSync(join(dest, "extra/notes.txt"))).toBe(true);
  });

  test("bytes that are neither a tarball nor JSON are refused", async () => {
    const junk = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

    await expect(readBundleManifest(junk, host, dest)).rejects.toThrow(/did not unpack/);
  });

  test("a gzip stream that is not a tar is refused", async () => {
    const bytes = Bun.gzipSync(new TextEncoder().encode("not a tar archive at all"));

    await expect(readBundleManifest(bytes, host, dest)).rejects.toMatchObject({
      code: "MANIFEST_REFUSED",
    });
  });

  test("a hand-built ustar archive is an ordinary archive", async () => {
    // The control for the two traversal tests below: the same builder, with
    // member names that go nowhere unusual.
    const bytes = handBuiltArchive([manifestMember()]);

    const manifest = await readBundleManifest(bytes, host, dest);

    expect(manifest.config_hash).toBe(MANIFEST.config_hash);
  });
});

/**
 * The property these two assert is the one that survives the difference
 * between tar implementations: GNU tar strips a leading `../` or `/` and
 * carries on, bsdtar skips the member and exits non-zero, so the *outcome* of
 * the call is not portable — but "nothing was written outside the bundle
 * directory" is, and it is the part that matters on a box where the parent of
 * `/etc/hermetic` is `/etc`.
 */
describe("a bundle that tries to write outside its directory", () => {
  const settle = async (bytes: Uint8Array): Promise<"parsed" | "refused"> =>
    await readBundleManifest(bytes, host, dest).then(
      (manifest) => {
        expect(manifest.config_hash).toBe(MANIFEST.config_hash);
        return "parsed" as const;
      },
      (error: unknown) => {
        expect(error).toBeInstanceOf(AgentdError);
        expect((error as AgentdError).code).toBe("MANIFEST_REFUSED");
        return "refused" as const;
      },
    );

  test("a member that climbs out with `..` never lands there", async () => {
    const bytes = handBuiltArchive([
      manifestMember(),
      { name: "../escaped.json", body: '{"owned": true}\n' },
    ]);

    await settle(bytes);

    expect(existsSync(join(root, "escaped.json"))).toBe(false);
    expect(existsSync(join(dirname(root), "escaped.json"))).toBe(false);
  });

  test("a member with an absolute path never lands at it", async () => {
    const target = join(root, "absolute-target");
    await mkdir(target);
    const bytes = handBuiltArchive([
      manifestMember(),
      { name: join(target, "owned.json"), body: '{"owned": true}\n' },
    ]);

    await settle(bytes);

    expect(existsSync(join(target, "owned.json"))).toBe(false);
  });
});
