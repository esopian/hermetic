import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HEREDOC_DELIMITER,
  HERMETICD_INSTALL_PATH,
  USER_DATA_JSON_PATH,
  cloudInitUserData,
  userDataJson,
  type UserDataFields,
} from "../src/render/cloud-init.ts";
import { HermeticError } from "../src/errors.ts";

const FIELDS: UserDataFields = {
  name: "atlas",
  bucket: "hermetic-123456789012-us-west-2",
  hermeticd_url:
    "https://hermetic-123456789012-us-west-2.s3.us-west-2.amazonaws.com/artifacts/0.4.1/hermeticd?X-Amz-Signature=deadbeef&X-Amz-Expires=3600",
  hermeticd_sha256: "a".repeat(64),
};

/** §6.3: ten lines, on a stock image, before a single package is installed. */
describe("the cloud-init script", () => {
  const script = cloudInitUserData(userDataJson(FIELDS));

  test("needs neither python3 nor jq", () => {
    expect(script).not.toContain("python3");
    expect(script).not.toContain("jq ");
  });

  test("sets the hostname to the fleet-prefixed cloud name, falling back to the agent name", () => {
    // `${host:-$name}` and not `$host`: user-data written before v3 carries no
    // `hostname` field, and a box that came up with an empty hostname would be
    // unreachable by any name at all.
    expect(script).toContain('hostnamectl set-hostname "${host:-$name}"');
    const prefixed = cloudInitUserData(userDataJson({ ...FIELDS, hostname: "main-atlas" }));
    expect(prefixed).toContain('"hostname":"main-atlas"');
  });

  test("verifies the checksum before installing, and hands over to the staged bootstrap", () => {
    const sha = script.indexOf("sha256sum -c -");
    const install = script.indexOf(`install -m 0755 /tmp/hermeticd ${HERMETICD_INSTALL_PATH}`);
    // `--install` writes the oneshot unit the runner runs under (§4.1); the
    // stages, and everything else, come from the fleet manifest after that.
    const exec = script.indexOf(`exec ${HERMETICD_INSTALL_PATH} bootstrap --install`);
    expect(sha).toBeGreaterThan(0);
    expect(install).toBeGreaterThan(sha);
    expect(exec).toBeGreaterThan(install);
  });

  test("leaves the JSON where hermeticd re-reads it, with exactly the fields hermeticd reads", () => {
    expect(script).toContain(USER_DATA_JSON_PATH);
    const body = new RegExp(`<<'${HEREDOC_DELIMITER}'\\n([\\s\\S]*?)\\n${HEREDOC_DELIMITER}`).exec(
      script,
    )?.[1];
    const parsed = JSON.parse(body!) as Record<string, string>;
    // Four, and no more. The tables, the SSM prefix and the stage list are the
    // fleet manifest's to say (§1), so user-data cannot go stale about them.
    expect(Object.keys(parsed).sort()).toEqual(["bucket", "hermeticd_sha256", "hermeticd_url", "name"]);
  });

  test("the sed extraction recovers a presigned URL with slashes and ampersands", () => {
    // The same expression the script runs, applied to the same one-line JSON.
    const line = userDataJson(FIELDS);
    const url = /.*"hermeticd_url":"([^"]*)".*/.exec(line)?.[1];
    expect(url).toBe(FIELDS.hermeticd_url);
  });

  test("bails out rather than proceeding with an empty field", () => {
    expect(script).toContain('[ -n "$name" ] && [ -n "$url" ] && [ -n "$want" ]');
    expect(script).toContain("set -euo pipefail");
  });
});

/** The blob is embedded verbatim in a here-doc, so its shape is load-bearing. */
describe("userDataJson", () => {
  test("is always a single line", () => {
    expect(userDataJson(FIELDS)).not.toInclude("\n");
  });

  test("refuses content that would truncate the here-doc", () => {
    expect(() => userDataJson({ ...FIELDS, name: `x\n${HEREDOC_DELIMITER}\n` })).toThrow(HermeticError);
  });

  test("escapes a newline in a value rather than emitting one", () => {
    // JSON.stringify already guarantees this; the assertion is here so the
    // here-doc's single-line invariant is checked rather than assumed.
    const json = userDataJson({ ...FIELDS, bucket: "a\nb" });
    expect(json).not.toInclude("\n");
    expect(json).toInclude("a\\nb");
  });
});

/**
 * The assertions above read the script with JavaScript. This one hands it to
 * the two programs that will actually run it: `bash -n` parses it, and `sed`
 * runs the three extractions verbatim against the here-doc the script itself
 * wrote. A JS `RegExp` that happens to agree with `sed` is not evidence that
 * `sed` does — and after the field set shrank to four, the extraction of the
 * presigned URL (slashes, `&`, `=`) is the part worth proving for real.
 */
describe("the cloud-init script, run by the programs that will run it", () => {
  const shell = Bun.which("bash");
  const sed = Bun.which("sed");

  const it = shell && sed ? test : test.skip;

  it("parses under `bash -n`, and its sed extractions recover every field", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hermetic-cloudinit-"));
    try {
      const script = join(dir, "user-data.sh");
      writeFileSync(script, cloudInitUserData(userDataJson(FIELDS)));

      const parse = Bun.spawn([shell!, "-n", script], { stdout: "pipe", stderr: "pipe" });
      const [parseCode, parseErr] = await Promise.all([
        parse.exited,
        new Response(parse.stderr).text(),
      ]);
      expect(parseErr).toBe("");
      expect(parseCode).toBe(0);

      /**
       * The JSON is written the way the script writes it — one line, in a
       * here-doc — and then read back with the script's own expressions. A
       * `sed` that could not recover `hermeticd_url` would leave a boot
       * downloading from an empty URL.
       */
      const json = join(dir, "hermetic.json");
      writeFileSync(json, `${userDataJson(FIELDS)}\n`);
      const extract = (field: string) => `${sed} -n 's/.*"${field}":"\\([^"]*\\)".*/\\1/p' ${json}`;
      const run = Bun.spawn(
        [
          shell!,
          "-c",
          [
            "set -euo pipefail",
            `name="$(${extract("name")})"`,
            `url="$(${extract("hermeticd_url")})"`,
            `want="$(${extract("hermeticd_sha256")})"`,
            `bucket="$(${extract("bucket")})"`,
            '[ -n "$name" ] && [ -n "$url" ] && [ -n "$want" ]',
            'printf "%s\\n%s\\n%s\\n%s\\n" "$name" "$url" "$want" "$bucket"',
          ].join("\n"),
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [code, out] = await Promise.all([run.exited, new Response(run.stdout).text()]);
      expect(code).toBe(0);
      expect(out.trimEnd().split("\n")).toEqual([
        FIELDS.name,
        FIELDS.hermeticd_url,
        FIELDS.hermeticd_sha256,
        FIELDS.bucket,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
