/**
 * The Chrome build a browser agent runs, out of the fleet's own mirror (§7.3).
 *
 * The properties this file is for: nothing unverified is ever unpacked, a build
 * the fleet does not carry is a named error rather than an S3 403 out of the
 * middle of a stage, and a box that already has the pinned bytes does not
 * re-download 190 MB on every apply.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { browserBuildKey, chromeBinaryPath, chromeInstallDir } from "@hermetic/core/schema";
import {
  CHROME_ZIP_PATH,
  chromeMarkerPath,
  ensureChromeBuild,
  pruneSupersededBuilds,
} from "../src/browser-source.ts";
import { AgentdError } from "../src/errors.ts";
import { collector } from "../src/events.ts";
import { FLEET_CACHE_PATH } from "../src/fleet.ts";
import { BoxHost as FakeHost } from "./fake-box.ts";
import { makeFleetManifest, makeManifest, TEST_BUCKET, TEST_CHROME_REF } from "./fixtures.ts";

const REF = TEST_CHROME_REF;
const ZIP = "PK chrome-for-testing\n";
const BINARY = chromeBinaryPath(REF);
const MARKER = chromeMarkerPath(REF);

describe("the mirrored Chrome build", () => {
  let host: FakeHost;

  beforeEach(() => {
    host = new FakeHost();
  });

  /** A fleet manifest naming the build, and (unless told otherwise) the bytes. */
  function seedMirror(opts: { withBytes?: boolean; sha256?: string; size?: number } = {}): void {
    if (opts.withBytes !== false) {
      host.s3Objects.set(browserBuildKey(REF), new TextEncoder().encode(ZIP));
    }
    const corrupt =
      opts.sha256 !== undefined || opts.size !== undefined
        ? {
            [REF]: {
              ...(opts.sha256 !== undefined ? { sha256: opts.sha256 } : {}),
              ...(opts.size !== undefined ? { size: opts.size } : {}),
            },
          }
        : undefined;
    host.seed(
      FLEET_CACHE_PATH,
      JSON.stringify(
        makeFleetManifest({
          browser: { [REF]: ZIP },
          ...(corrupt ? { corruptBrowser: corrupt } : {}),
        }),
      ),
    );
  }

  const run = () => {
    const { emit, events } = collector();
    return ensureChromeBuild(host, makeManifest({ browser: true }), emit, {
      getObject: host.getObject,
    }).then((build) => ({ build, events }));
  };

  test("an agent with no browsers unpacks nothing and reads no manifest", async () => {
    const { emit, events } = collector();
    const build = await ensureChromeBuild(host, makeManifest(), emit, { getObject: host.getObject });

    expect(build).toBeNull();
    expect(events).toEqual([]);
    expect(host.commands).toEqual([]);
  });

  test("a build the fleet manifest does not carry is a named error, not a 403", async () => {
    host.seed(FLEET_CACHE_PATH, JSON.stringify(makeFleetManifest()));

    const err = (await run().catch((e: unknown) => e)) as AgentdError;
    expect(err).toBeInstanceOf(AgentdError);
    expect(err.code).toBe("BROWSER_BUILD_MISSING");
    // Both remedies, because the two causes are not distinguishable from here.
    expect(err.message).toContain("artifacts push");
    expect(err.message).toContain("foundation update");
    expect(host.commandsMatching(/^unzip/)).toEqual([]);
  });

  test("a read the instance role is not allowed is the same named error", async () => {
    seedMirror({ withBytes: false });

    const err = (await run().catch((e: unknown) => e)) as AgentdError;
    expect(err.code).toBe("BROWSER_BUILD_MISSING");
    expect(err.message).toContain("foundation v14");
    expect(host.files.has(CHROME_ZIP_PATH)).toBe(false);
  });

  test("the happy path verifies, unzips, marks the build and drops the zip", async () => {
    seedMirror();

    const { build, events } = await run();

    expect(build).toEqual({ ref: REF, binary: BINARY, installed: true });
    expect(host.commands).toContain(`s3:GetObject ${TEST_BUCKET} ${browserBuildKey(REF)}`);
    expect(host.commandsMatching(/^unzip/)).toEqual([
      `unzip -q -o ${CHROME_ZIP_PATH} -d ${chromeInstallDir(REF)}`,
    ]);
    expect(host.files.get(BINARY)?.mode).toBe("0755");
    // The zip is the size of the build again once it has been read.
    expect(host.files.has(CHROME_ZIP_PATH)).toBe(false);
    expect(events.map((e) => e.phase)).toEqual(["packages", "packages"]);
    expect(events.at(-1)?.message).toContain(chromeInstallDir(REF));
  });

  test("the marker records the digest the fleet manifest pinned", async () => {
    seedMirror();
    await run();
    const manifest = makeFleetManifest({ browser: { [REF]: ZIP } });
    expect(host.files.get(MARKER)?.content).toBe(`${manifest.browser?.[REF]?.sha256 ?? ""}\n`);
  });

  test("a second apply on the same build fetches nothing", async () => {
    seedMirror();
    await run();
    const before = host.commands.length;

    const { build, events } = await run();

    expect(build).toEqual({ ref: REF, binary: BINARY, installed: false });
    expect(host.commands.slice(before).filter((c) => /^s3:GetObject|^unzip/.test(c))).toEqual([]);
    expect(events.at(-1)?.message).toBe(`chrome ${REF} already installed`);
  });

  test("a re-pushed build under the same ref reinstalls: the marker is the digest", async () => {
    seedMirror();
    await run();
    // Same `chrome_ref`, different bytes — what a corrected mirror push looks
    // like. The binary is still there, so only the marker can notice.
    const rebuilt = "PK chrome-for-testing, rebuilt\n";
    host.s3Objects.set(browserBuildKey(REF), new TextEncoder().encode(rebuilt));
    host.seed(FLEET_CACHE_PATH, JSON.stringify(makeFleetManifest({ browser: { [REF]: rebuilt } })));

    const { build } = await run();

    expect(build?.installed).toBe(true);
    expect(host.commandsMatching(/^unzip/)).toHaveLength(2);
  });

  test("bytes that are not the length the manifest records are refused", async () => {
    seedMirror({ size: ZIP.length + 99 });

    const err = (await run().catch((e: unknown) => e)) as AgentdError;
    expect(err.code).toBe("CHECKSUM_MISMATCH");
    expect(host.commandsMatching(/^unzip/)).toEqual([]);
    expect(host.files.has(CHROME_ZIP_PATH)).toBe(false);
    expect(host.files.has(BINARY)).toBe(false);
  });

  test("bytes whose digest is not the pinned one are refused before anything is unpacked", async () => {
    seedMirror({ sha256: "f".repeat(64) });

    const err = (await run().catch((e: unknown) => e)) as AgentdError;
    expect(err.code).toBe("CHECKSUM_MISMATCH");
    expect(host.commandsMatching(/^unzip/)).toEqual([]);
    expect(host.files.has(BINARY)).toBe(false);
    expect(host.files.has(MARKER)).toBe(false);
  });

  test("a zip staged by a killed apply is removed before the next one runs", async () => {
    seedMirror();
    host.seedBytes(CHROME_ZIP_PATH, new TextEncoder().encode("half a download"), "0600");

    await run();

    expect(host.fsOps.filter((op) => op === `remove ${CHROME_ZIP_PATH}`)).toHaveLength(2);
  });

  test("a dry run says what it would install and touches nothing", async () => {
    seedMirror();
    const { emit, events } = collector();

    const build = await ensureChromeBuild(host, makeManifest({ browser: true }), emit, {
      getObject: host.getObject,
      dryRun: true,
    });

    expect(build?.installed).toBe(true);
    expect(events.at(-1)?.message).toContain(`would install chrome ${REF}`);
    expect(host.commands).toEqual([]);
    expect(host.files.has(BINARY)).toBe(false);
  });

  /**
   * Two refusals, because there are two gates and they are not the same gate.
   *
   * `AgentConfig` refuses the value before any of this runs — `chrome_ref` is
   * `CHROME_REF_RE` in core's schema, the same rule the laptop mirrors under
   * (`browser-mirror.ts`), so the box and the laptop cannot disagree about what
   * a build number is. `ensureChromeBuild` refuses it again on the way into a
   * path, which is defence in depth rather than duplication: the check that
   * matters is the one closest to `unzip -d`.
   */
  test("a chrome_ref that could climb out of /opt is refused by the schema", () => {
    expect(() => makeManifest({ browser: true, chrome_ref: "../../etc" })).toThrow(/does not validate/);
  });

  test("a chrome_ref that could climb out of /opt is refused before it reaches a path", async () => {
    seedMirror();
    const { emit } = collector();
    // Past the schema on purpose: the manifest is valid, the field is not.
    const manifest = { ...makeManifest({ browser: true }), chrome_ref: "../../etc" };

    const err = (await ensureChromeBuild(host, manifest, emit, {
      getObject: host.getObject,
    }).catch((e: unknown) => e)) as AgentdError;

    expect(err.code).toBe("MANIFEST_REFUSED");
  });
});

/**
 * What a bump leaves behind. An unpacked Chrome is ~500 MB, `chrome_ref` moves
 * whenever the fleet pins a newer build, and nothing else on the box ever
 * collects the old tree — so without this the root volume the agent's memory,
 * logs and Hermes checkout share fills up one browser at a time.
 */
describe("the builds a bump supersedes", () => {
  let host: FakeHost;

  beforeEach(() => {
    host = new FakeHost();
    host.s3Objects.set(browserBuildKey(REF), new TextEncoder().encode(ZIP));
    host.seed(FLEET_CACHE_PATH, JSON.stringify(makeFleetManifest({ browser: { [REF]: ZIP } })));
  });

  const OLD = "141.0.7390.54";

  /** A build this box installed before: unpacked tree plus its digest marker. */
  function seedInstalled(ref: string): void {
    host.seed(chromeBinaryPath(ref), "old chrome");
    host.seed(chromeMarkerPath(ref), "deadbeef\n");
  }

  /*
   * Unpack, then prune — the two halves in the order `apply` runs them, with the
   * units phase's restart in between on a real box. They are two calls here
   * because they are two calls there: pruning at the unpack site deleted the
   * tree the running browser was still executing from.
   */
  const install = async () => {
    const { emit, events } = collector();
    const build = await ensureChromeBuild(host, makeManifest({ browser: true }), emit, {
      getObject: host.getObject,
    });
    if (build?.installed === true) await pruneSupersededBuilds(host, build.ref, emit);
    return { build, events };
  };

  test("the previous build's tree is removed once the new one is unpacked", async () => {
    seedInstalled(OLD);

    const { events } = await install();

    expect(host.files.has(chromeBinaryPath(OLD))).toBe(false);
    expect(host.fsOps).toContain(`remove ${chromeInstallDir(OLD)}`);
    expect(events.map((e) => e.message)).toContain(
      `removed superseded chrome ${OLD}, no longer pinned`,
    );
    // …and the build this agent is pinned to is still there.
    expect(host.files.has(BINARY)).toBe(true);
    expect(host.files.has(MARKER)).toBe(true);
  });

  test("a second apply of the same ref removes nothing", async () => {
    await install();
    const before = host.fsOps.length;

    await install();

    // The staged zip is removed on every run, by the step that stages it; no
    // *tree* under the install root is.
    expect(
      host.fsOps.slice(before).filter((op) => op.startsWith("remove") && !op.endsWith("chrome.zip")),
    ).toEqual([]);
    expect(host.files.has(BINARY)).toBe(true);
  });

  /**
   * hermetic removes what hermetic wrote, and `/opt/hermetic/chrome` is not a
   * directory hermetic gets to sweep: the staged zip is its own (and is removed
   * by name, in its own step), and anything whose name is not a usable ref was
   * put there by somebody else.
   */
  test("the staged zip and anything that is not a ref are left alone", async () => {
    seedInstalled(OLD);
    await host.writeBytes(CHROME_ZIP_PATH, new TextEncoder().encode("staged"), "0600");
    host.seed(`${chromeInstallDir(".hidden")}/keep`, "not a ref");
    host.seed(`${chromeInstallDir("-notes")}/keep`, "not a ref either");

    await install();

    expect(host.files.has(`${chromeInstallDir(".hidden")}/keep`)).toBe(true);
    expect(host.files.has(`${chromeInstallDir("-notes")}/keep`)).toBe(true);
    // Twice, which is the staging step's own pair — before the download and
    // after the unzip. A third would be the prune treating it as a build.
    expect(host.fsOps.filter((op) => op === `remove ${CHROME_ZIP_PATH}`)).toHaveLength(2);
    expect(host.files.has(chromeBinaryPath(OLD))).toBe(false);
  });

  test("a box that already has the pinned build prunes nothing", async () => {
    // The skip path: binary present and the marker matching the manifest.
    await install();
    host.fsOps.length = 0;
    seedInstalled(OLD);

    const { build } = await install();

    expect(build?.installed).toBe(false);
    expect(host.files.has(chromeBinaryPath(OLD))).toBe(true);
  });
});
