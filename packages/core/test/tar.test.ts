import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tar, tarGz, archivePath } from "../src/release/tar.ts";
import { renderAgentConfig } from "../src/render/render.ts";

const SCRATCH = tmpdir();

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(SCRATCH, "hermetic-tar-"));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Round-trip through the system `tar`: the box unpacks with it, so must we. */
async function listWithSystemTar(bytes: Uint8Array): Promise<string[]> {
  const dir = scratch();
  const path = join(dir, "bundle.tgz");
  await Bun.write(path, bytes);
  const proc = Bun.spawnSync(["tar", "-tzf", path]);
  expect(proc.exitCode, new TextDecoder().decode(proc.stderr)).toBe(0);
  return new TextDecoder()
    .decode(proc.stdout)
    .split("\n")
    .filter((l) => l.length > 0);
}

async function extract(bytes: Uint8Array, entry: string): Promise<string> {
  const dir = scratch();
  const path = join(dir, "bundle.tgz");
  await Bun.write(path, bytes);
  const proc = Bun.spawnSync(["tar", "-xzOf", path, entry]);
  expect(proc.exitCode, new TextDecoder().decode(proc.stderr)).toBe(0);
  return new TextDecoder().decode(proc.stdout);
}

describe("the ustar writer", () => {
  test("produces an archive the system tar reads", async () => {
    const bytes = tarGz([
      { path: "manifest.json", mode: "0644", content: '{"a":1}\n' },
      { path: "etc/hermes/hermes.toml", mode: "0640", content: "[agent]\n" },
    ]);
    expect(await listWithSystemTar(bytes)).toEqual(["manifest.json", "etc/hermes/hermes.toml"]);
    expect(await extract(bytes, "etc/hermes/hermes.toml")).toBe("[agent]\n");
  });

  test("is deterministic — the same entries give the same bytes", () => {
    const entries = [{ path: "manifest.json", mode: "0644", content: "{}\n" }];
    expect(tar(entries)).toEqual(tar(entries));
  });

  test("pads to 512-byte blocks and ends with two zero blocks", () => {
    const bytes = tar([{ path: "a.txt", mode: "0644", content: "x" }]);
    expect(bytes.length % 512).toBe(0);
    // header + one padded content block + two zero blocks.
    expect(bytes.length).toBe(512 * 4);
    expect(bytes.slice(-1024).every((b) => b === 0)).toBe(true);
  });

  test("a path too long for a ustar header is refused, not silently truncated", () => {
    const long = `${"a".repeat(90)}/${"b".repeat(120)}`;
    expect(() => tar([{ path: long, mode: "0644", content: "" }])).toThrow(RangeError);
  });

  test("archivePath strips the leading slash", () => {
    expect(archivePath("/etc/hermes/hermes.toml")).toBe("etc/hermes/hermes.toml");
    expect(archivePath("already/relative")).toBe("already/relative");
  });
});

/** §6.2 step 5: what actually lands in `config/<name>/<hash>.tgz`. */
describe("the rendered config bundle", () => {
  const rendered = renderAgentConfig({
    name: "atlas",
    size: "medium",
    provider: "bedrock",
    secrets_mode: "none",
    tailnet: "hermetic.ts.net",
    hermes_version: "0.15.0",
    hermes_ref: "v2026.8.31",
    chrome_ref: "153.0.8010.12",
    region: "us-west-2",
  });

  test("is a real gzip, not JSON wearing a .tgz suffix", () => {
    expect(rendered.key).toEndWith(".tgz");
    // gzip magic.
    expect([rendered.tarball[0], rendered.tarball[1]]).toEqual([0x1f, 0x8b]);
  });

  test("holds manifest.json at the root plus every rendered file", async () => {
    const entries = await listWithSystemTar(rendered.tarball);
    expect(entries[0]).toBe("manifest.json");
    for (const file of rendered.manifest.files) {
      expect(entries).toContain(archivePath(file.path));
    }
    expect(entries).toHaveLength(rendered.manifest.files.length + 1);
  });

  test("the unpacked manifest.json is the manifest hermeticd validates", async () => {
    const text = await extract(rendered.tarball, "manifest.json");
    expect(JSON.parse(text)).toEqual(rendered.manifest);
  });

  test("the same input renders byte-identical bundles", () => {
    const input = {
      name: "atlas",
      size: "medium",
      provider: "bedrock",
      secrets_mode: "none",
      tailnet: "hermetic.ts.net",
      hermes_version: "0.15.0",
      hermes_ref: "v2026.8.31",
      chrome_ref: "153.0.8010.12",
      hermeticd_version: "0.4.1",
      region: "us-west-2",
    } as const;
    expect(renderAgentConfig(input).tarball).toEqual(renderAgentConfig(input).tarball);
  });
});
