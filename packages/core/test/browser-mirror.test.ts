/**
 * `browser-mirror.ts`: the laptop half of §7.3's browser mirror.
 *
 * No network (§11). The CDN is an injected `fetch` that answers from bytes the
 * test made, so the digest the module checks is one the test chose — which is
 * the only way to assert both "the pinned build is accepted" and "a substituted
 * one is refused" without downloading 196 MB.
 */
import { describe, expect, test } from "bun:test";
import {
  BROWSER_MIRROR_TIMEOUT_MS,
  type BrowserMirrorFn,
  CHROME_CDN_BASE,
  assertBrowserSupported,
  chromeDownloadUrl,
  ensureBrowserMirror,
  fixtureBrowserBytes,
  fixtureBrowserMirror,
  megabytes,
} from "../src/release/browser-mirror.ts";
import { HermeticError, isHermeticError } from "../src/errors.ts";
import {
  BROWSER_FOUNDATION_VERSION,
  browserBuildKey,
  type FleetItem,
  type OpEvent,
} from "../src/schema/index.ts";
import { BUILD_VERSIONS } from "../src/hermetic.ts";
import { FIXTURE_CHROME_REF } from "../src/backend/fixture/memory-fixture.ts";
import { FIXTURE_CONFIG, MemoryBackend, seedFixtureFleet } from "../src/backend/memory.ts";
import { readFleetManifest } from "../src/release/artifacts.ts";
import { renderAgentConfig } from "../src/render/render.ts";
import { testHermetic } from "./helpers.ts";

const REF = "153.0.8010.12";
/** The bytes this test's "CDN" serves, and the pin computed from them. */
const BUILD = new TextEncoder().encode("PK a perfectly good chrome for testing\n");
const PIN = {
  sha256: new Bun.CryptoHasher("sha256").update(BUILD).digest("hex"),
  size: BUILD.byteLength,
};

/** A bucket that records what was put in it. `exists` answers from the same map. */
function fakeArtifacts() {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    putObject: async (key: string, body: Uint8Array): Promise<void> => {
      objects.set(key, body);
    },
    exists: async (key: string): Promise<boolean> => objects.has(key),
  };
}

/** A CDN that serves `body`, counting the requests it was asked for. */
function fakeCdn(body: Uint8Array | null, status = 200) {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (url: string): Promise<Response> => {
      urls.push(url);
      if (body === null) return new Response("nope", { status });
      // A fresh copy per call: `arrayBuffer()` consumes the body.
      return new Response(new Uint8Array(body), { status });
    },
  };
}

describe("ensureBrowserMirror", () => {
  test("downloads, verifies and uploads the pinned build", async () => {
    const artifacts = fakeArtifacts();
    const cdn = fakeCdn(BUILD);
    const result = await ensureBrowserMirror(
      { artifacts, fetch: cdn.fetch },
      { chrome_ref: REF, ...PIN },
    );

    expect(result.status).toBe("pushed");
    expect(result.downloaded).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(cdn.urls).toEqual([chromeDownloadUrl(REF)]);

    const entry = result.block?.[REF];
    expect(entry).toEqual({
      key: browserBuildKey(REF),
      sha256: PIN.sha256,
      size: PIN.size,
      // The provenance the manifest records: the CDN object, not the bucket one.
      url: `${CHROME_CDN_BASE}/${REF}/linux-arm64/chrome-linux-arm64.zip`,
    });
    expect(artifacts.objects.get(browserBuildKey(REF))).toEqual(BUILD);
  });

  test("merges into the block it was given rather than replacing it", async () => {
    const artifacts = fakeArtifacts();
    const older = {
      "152.0.1.1": {
        key: browserBuildKey("152.0.1.1"),
        sha256: "a".repeat(64),
        size: 1,
        url: "https://example.com/x.zip",
      },
    };
    const result = await ensureBrowserMirror(
      { artifacts, fetch: fakeCdn(BUILD).fetch },
      { chrome_ref: REF, ...PIN, existing: older },
    );
    // A fleet is legitimately on two builds while an older configuration is
    // still the document governing a box (`foundation.ts`'s keep set).
    expect(Object.keys(result.block ?? {}).sort()).toEqual(["152.0.1.1", REF]);
  });

  test("a build already in the bucket is not downloaded again", async () => {
    const artifacts = fakeArtifacts();
    const first = await ensureBrowserMirror(
      { artifacts, fetch: fakeCdn(BUILD).fetch },
      { chrome_ref: REF, ...PIN },
    );

    const cdn = fakeCdn(BUILD);
    const again = await ensureBrowserMirror(
      { artifacts, fetch: cdn.fetch },
      { chrome_ref: REF, ...PIN, existing: first.block },
    );
    expect(again.status).toBe("present");
    expect(again.downloaded).toBe(false);
    expect(again.block).toEqual(first.block);
    expect(cdn.urls).toEqual([]);
  });

  /**
   * The other half of that skip, and the reason it compares the whole entry
   * rather than the key. The key is a function of `chrome_ref` alone, so a
   * release correcting a wrong digest for a ref it had already published leaves
   * the key identical — and a skip keyed on the key alone left the fleet
   * manifest holding the wrong digest for good. The box verifies against that
   * entry, not against the laptop's pin, so `artifacts push` was the one
   * command that could not repair what it exists to publish.
   */
  test("a corrected pin for a ref already in the bucket is re-mirrored", async () => {
    const artifacts = fakeArtifacts();
    const first = await ensureBrowserMirror(
      { artifacts, fetch: fakeCdn(BUILD).fetch },
      { chrome_ref: REF, sha256: "0".repeat(64), size: BUILD.byteLength, existing: undefined },
    ).catch(() => null);
    // That first push refuses: the bytes are not what the wrong pin claimed.
    expect(first?.status ?? "refused").not.toBe("pushed");

    // A fleet manifest that nonetheless records the wrong digest — the state a
    // release which published one and was then corrected leaves behind.
    const stale = {
      [REF]: {
        key: browserBuildKey(REF),
        sha256: "0".repeat(64),
        size: 1,
        url: chromeDownloadUrl(REF),
      },
    };
    await artifacts.putObject(browserBuildKey(REF), BUILD);

    const cdn = fakeCdn(BUILD);
    const fixed = await ensureBrowserMirror(
      { artifacts, fetch: cdn.fetch },
      { chrome_ref: REF, ...PIN, existing: stale },
    );

    expect(fixed.status).toBe("pushed");
    expect(fixed.block?.[REF]?.sha256).toBe(PIN.sha256);
    expect(fixed.block?.[REF]?.size).toBe(PIN.size);
    expect(cdn.urls).toHaveLength(1);
  });

  test("a manifest naming a build whose object is gone re-mirrors it", async () => {
    const artifacts = fakeArtifacts();
    const first = await ensureBrowserMirror(
      { artifacts, fetch: fakeCdn(BUILD).fetch },
      { chrome_ref: REF, ...PIN },
    );
    // What a prune, or an emptied bucket, leaves behind: the pointer without
    // the object. The block alone is not evidence the build is there.
    artifacts.objects.delete(browserBuildKey(REF));

    const cdn = fakeCdn(BUILD);
    const again = await ensureBrowserMirror(
      { artifacts, fetch: cdn.fetch },
      { chrome_ref: REF, ...PIN, existing: first.block },
    );
    expect(again.status).toBe("pushed");
    expect(cdn.urls).toHaveLength(1);
  });

  test("a digest that is not the pinned one refuses before anything is uploaded", async () => {
    const artifacts = fakeArtifacts();
    // The same length, one byte different: the length check must not be what
    // catches a substituted build, or a same-size swap would sail through.
    const substituted = new Uint8Array(BUILD);
    substituted[3] = (substituted[3] ?? 0) ^ 0xff;

    const error = await ensureBrowserMirror(
      { artifacts, fetch: fakeCdn(substituted).fetch },
      { chrome_ref: REF, ...PIN },
    ).catch((e: unknown) => e);

    expect(isHermeticError(error)).toBe(true);
    expect((error as HermeticError).code).toBe("BROWSER_MIRROR_MISMATCH");
    expect((error as HermeticError).message).toContain(PIN.sha256);
    // The whole point of verifying on the laptop: nothing reached the bucket.
    expect(artifacts.objects.size).toBe(0);
  });

  test("a length that is not the pinned one refuses too, and says so", async () => {
    const artifacts = fakeArtifacts();
    const truncated = BUILD.subarray(0, BUILD.byteLength - 4);
    const error = await ensureBrowserMirror(
      { artifacts, fetch: fakeCdn(truncated).fetch },
      { chrome_ref: REF, ...PIN },
    ).catch((e: unknown) => e);

    expect((error as HermeticError).code).toBe("BROWSER_MIRROR_MISMATCH");
    expect((error as HermeticError).message).toContain(`${truncated.byteLength} bytes`);
    expect(artifacts.objects.size).toBe(0);
  });

  test("a CDN that cannot be reached warns and leaves the block alone", async () => {
    const artifacts = fakeArtifacts();
    const existing = {
      [REF]: { key: browserBuildKey(REF), sha256: PIN.sha256, size: PIN.size, url: "u" },
    };
    const result = await ensureBrowserMirror(
      { artifacts, fetch: async (): Promise<Response> => Promise.reject(new Error("ENETDOWN")) },
      { chrome_ref: REF, ...PIN, existing },
    );
    expect(result.status).toBe("skipped");
    expect(result.block).toEqual(existing);
    expect(result.warning).toContain("ENETDOWN");
    expect(result.warning).toContain("--browser");
  });

  test("a 404 is a warning, not a throw", async () => {
    const result = await ensureBrowserMirror(
      { artifacts: fakeArtifacts(), fetch: fakeCdn(null, 404).fetch },
      { chrome_ref: REF, ...PIN },
    );
    expect(result.status).toBe("skipped");
    expect(result.warning).toContain("404");
  });

  test("a ref that is not a build number is a programmer error, not a warning", async () => {
    const error = await ensureBrowserMirror(
      { artifacts: fakeArtifacts(), fetch: fakeCdn(BUILD).fetch },
      { chrome_ref: "../manifest.json", ...PIN },
    ).catch((e: unknown) => e);
    expect((error as HermeticError).code).toBe("VALIDATION");
  });

  test("the download is bounded by a signal", async () => {
    let seen: AbortSignal | undefined;
    await ensureBrowserMirror(
      {
        artifacts: fakeArtifacts(),
        timeoutMs: 50,
        fetch: async (_url, init): Promise<Response> => {
          seen = init?.signal ?? undefined;
          return new Response(new Uint8Array(BUILD));
        },
      },
      { chrome_ref: REF, ...PIN },
    );
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(BROWSER_MIRROR_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe("fixtureBrowserMirror", () => {
  test("puts a stand-in build in the bucket and never fetches", async () => {
    const artifacts = fakeArtifacts();
    const result = await fixtureBrowserMirror(artifacts, { chrome_ref: REF, existing: undefined });

    expect(result.status).toBe("pushed");
    expect(result.downloaded).toBe(false);
    const bytes = artifacts.objects.get(browserBuildKey(REF));
    expect(bytes).toEqual(fixtureBrowserBytes(REF));
    /**
     * The fixture's digest is of its own bytes, not of the real build's: the
     * pin is enforced on the real path only, and a fixture checked against a
     * 196 MB digest could only ever fail.
     */
    const entry = result.block?.[REF];
    expect(entry?.sha256).toBe(new Bun.CryptoHasher("sha256").update(bytes!).digest("hex"));
    expect(entry?.size).toBe(bytes!.byteLength);
  });

  test("a second call is a no-op", async () => {
    const artifacts = fakeArtifacts();
    const first = await fixtureBrowserMirror(artifacts, { chrome_ref: REF, existing: undefined });
    const again = await fixtureBrowserMirror(artifacts, {
      chrome_ref: REF,
      existing: first.block,
    });
    expect(again.status).toBe("present");
  });

  test("the fixture fleet names the build this checkout pins", () => {
    // Held equal here rather than imported across the seam: `memory-fixture.ts`
    // must not reach up into the SDK for `BUILD_VERSIONS`, and a bumped pin that
    // left the fixture behind would seed a fleet whose manifest names a build a
    // fixture `artifacts push` would then mirror a second copy of.
    expect(FIXTURE_CHROME_REF).toBe(BUILD_VERSIONS.chrome_ref);
  });
});

describe("the browser build key", () => {
  test("lives outside artifacts/", () => {
    expect(browserBuildKey(REF)).toBe(`browser/chrome-linux-arm64-${REF}.zip`);
  });

  test("the pinned build is described in whole megabytes", () => {
    expect(megabytes(BUILD_VERSIONS.chrome_size)).toBe("196 MB");
  });
});

describe("assertBrowserSupported", () => {
  const fleetAt = (version: number | undefined): Pick<FleetItem, "foundation_version"> =>
    version === undefined ? {} : { foundation_version: version };

  test("a fleet on v14 or later may run an agent", () => {
    expect(() => assertBrowserSupported(fleetAt(BROWSER_FOUNDATION_VERSION))).not.toThrow();
    expect(() => assertBrowserSupported(fleetAt(BROWSER_FOUNDATION_VERSION + 1))).not.toThrow();
  });

  test("an older fleet is refused, with the command that fixes it", () => {
    const error = (() => {
      try {
        assertBrowserSupported(fleetAt(BROWSER_FOUNDATION_VERSION - 1));
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect((error as HermeticError).code).toBe("BROWSER_NEEDS_FOUNDATION_UPDATE");
    expect((error as HermeticError).message).toContain("hermetic foundation update");
  });

  test("a fleet with no stamp at all reads as version 0 and is refused", () => {
    expect(() => assertBrowserSupported(fleetAt(undefined))).toThrow(HermeticError);
  });

  /**
   * There used to be a way past this: `--no-browser`. There is not any more, and
   * the widened refusal is the point rather than a side effect — an agent is a
   * thing with a browser, so a fleet that cannot read the mirror cannot make one
   * at all until it is updated.
   */
  test("nothing is exempt: an old fleet can create no agent at all", () => {
    expect(() => assertBrowserSupported(fleetAt(BROWSER_FOUNDATION_VERSION - 1))).toThrow(
      HermeticError,
    );
  });
});

/**
 * §7.3's keep set, the browser twin of the Hermes one in `hermes-mirror.test.ts`.
 *
 * The release prune does not cover `browser/`, and a configuration rendered by
 * an older laptop names the build *that* laptop shipped — so an update run from
 * a newer checkout must not delete the browser a live agent reinstalls from.
 * Unlike a missing Hermes bundle, there is no fallback: the box has no other
 * way to get a browser.
 */
describe("foundation update prunes stale browser builds", () => {
  const STALE = "151.0.1.1";
  const PINNED = "152.0.2.2";

  const entryFor = (ref: string) => ({
    key: browserBuildKey(ref),
    sha256: "7".repeat(64),
    size: 20,
    url: chromeDownloadUrl(ref),
  });

  function hermeticFor(backend: MemoryBackend) {
    return testHermetic({
      backend,
      config: FIXTURE_CONFIG,
      browserMirror: async ({ chrome_ref, existing }) => ({
        block: { ...(existing ?? {}), [chrome_ref]: entryFor(chrome_ref) },
        status: "pushed",
        chrome_ref,
        downloaded: true,
      }),
    });
  }

  /** The config object the agent's row already names, rendered at `chromeRef`. */
  async function uploadConfig(backend: MemoryBackend, name: string, chromeRef: string): Promise<void> {
    const agent = (await backend.store.agents.get(name))!;
    const rendered = renderAgentConfig({
      name,
      size: agent.size,
      provider: agent.provider,
      secrets_mode: agent.secrets_mode,
      hermes_version: agent.hermes_version,
      hermes_ref: BUILD_VERSIONS.hermes_ref,
      chrome_ref: chromeRef,
      region: agent.region,
      tailnet: "example.ts.net",
    });
    await backend.artifacts.putObject(agent.resources.config_key!, rendered.tarball);
  }

  /** Add build entries to the published manifest and put the objects behind them. */
  async function nameInManifest(backend: MemoryBackend, refs: readonly string[]): Promise<void> {
    const before = (await readFleetManifest(backend.artifacts))!;
    const browser = { ...(before.browser ?? {}) };
    for (const ref of refs) {
      browser[ref] = entryFor(ref);
      await backend.artifacts.putObject(browserBuildKey(ref), new TextEncoder().encode(`build ${ref}`));
    }
    await backend.artifacts.putObject(
      "manifest.json",
      new TextEncoder().encode(JSON.stringify({ ...before, browser })),
    );
  }

  test("keeps this build's pin, deletes the rest, and rewrites the block", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const hermetic = hermeticFor(backend);
    await hermetic.artifacts.push({ version: "0.5.0" });
    await nameInManifest(backend, [STALE]);

    const messages: string[] = [];
    for await (const e of hermetic.foundation.update({ yes: true })) messages.push(e.message);

    const after = (await readFleetManifest(backend.artifacts))!;
    expect(Object.keys(after.browser ?? {})).toEqual([BUILD_VERSIONS.chrome_ref]);
    expect(backend.objects.has(browserBuildKey(STALE))).toBe(false);
    expect(messages.some((m) => m.includes(`Chrome for Testing ${STALE}`))).toBe(true);
    // And it says what it is downloading before it downloads it.
    expect(messages.some((m) => m.includes(megabytes(BUILD_VERSIONS.chrome_size)))).toBe(true);
  });

  test("a build a live agent's uploaded config pins is kept", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const hermetic = hermeticFor(backend);
    await hermetic.artifacts.push({ version: "0.5.0" });

    const live = (await backend.store.agents.scan()).filter((a) => a.status !== "destroyed");
    await uploadConfig(backend, live[0]!.name, BUILD_VERSIONS.chrome_ref);
    // The older laptop's render: a build this checkout no longer ships, and the
    // one the box would reinstall from on its next recreate.
    await uploadConfig(backend, live[1]!.name, PINNED);
    await nameInManifest(backend, [STALE, PINNED]);

    for await (const _ of hermetic.foundation.update({ yes: true }));

    const after = (await readFleetManifest(backend.artifacts))!;
    expect(Object.keys(after.browser ?? {}).sort()).toEqual([BUILD_VERSIONS.chrome_ref, PINNED].sort());
    expect(backend.objects.has(browserBuildKey(PINNED))).toBe(true);
    expect(backend.objects.has(browserBuildKey(STALE))).toBe(false);
  });

  /**
   * Conservative on a read that failed, on the same rule the Hermes keep set
   * follows: an object that *cannot be read* is no evidence that nothing pins
   * its build, so nothing is pruned at all.
   */
  test("a configuration that cannot be read prunes nothing", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const live = (await backend.store.agents.scan()).find((a) => a.status !== "destroyed")!;
    const configKey = live.resources.config_key!;
    const artifacts = {
      ...backend.artifacts,
      getObject: async (key: string): Promise<Uint8Array | null> => {
        if (key === configKey) throw new Error("AccessDenied");
        return backend.artifacts.getObject(key);
      },
    };
    const hermetic = hermeticFor(backend);
    await hermetic.artifacts.push({ version: "0.5.0" });
    await nameInManifest(backend, [STALE]);

    const guarded = testHermetic({
      backend: { ...backend, artifacts },
      config: FIXTURE_CONFIG,
      browserMirror: async ({ chrome_ref, existing }) => ({
        block: { ...(existing ?? {}), [chrome_ref]: entryFor(chrome_ref) },
        status: "pushed",
        chrome_ref,
        downloaded: true,
      }),
    });
    for await (const _ of guarded.foundation.update({ yes: true }));

    expect(backend.objects.has(browserBuildKey(STALE))).toBe(true);
  });

  /**
   * The mirror is what makes the keep set true: it holds the build this
   * checkout pins on the understanding that the step above has just uploaded
   * it. A skipped mirror — an unreachable CDN, a failed upload — breaks that,
   * and on a bumped pin the keep set then names a build that is in no bucket
   * while the build the fleet is running is named by nothing. Pruning there
   * deletes the fleet's only browser, and the box has no upstream to fall back
   * to the way it does for Hermes.
   */
  test("a skipped mirror prunes nothing, even when the pin has moved", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const skipped = testHermetic({
      backend,
      config: FIXTURE_CONFIG,
      browserMirror: async ({ chrome_ref, existing }) => ({
        block: existing,
        status: "skipped",
        chrome_ref,
        downloaded: false,
        warning: "could not mirror the browser: the CDN hung up",
      }),
    });
    await skipped.artifacts.push({ version: "0.5.0" });
    // The build the fleet is running: mirrored by an older laptop, on a ref this
    // checkout no longer pins, and pinned by no agent config yet.
    await nameInManifest(backend, [PINNED]);

    const messages: string[] = [];
    for await (const e of skipped.foundation.update({ yes: true })) messages.push(e.message);

    expect(backend.objects.has(browserBuildKey(PINNED))).toBe(true);
    expect(Object.keys((await readFleetManifest(backend.artifacts))!.browser ?? {})).toContain(PINNED);
    expect(messages.some((m) => m.includes("the browser mirror did not run"))).toBe(true);
    expect(messages.some((m) => m.includes("pruned the mirrored browser"))).toBe(false);
  });
});

/**
 * §7.3's soft failure, as far as a head can see it. The release itself went up
 * either way, so this is a warning — but it is a *separate* warning from the
 * Hermes mirror's, because the consequence differs in kind: a fleet without its
 * Hermes bundle boots more slowly, while a fleet without its browser build
 * cannot run a `--browser` agent at all.
 */
describe("a browser mirror that could not run reaches the operator", () => {
  const failing: BrowserMirrorFn = async ({ chrome_ref, existing }) => ({
    block: existing,
    status: "skipped",
    chrome_ref,
    downloaded: false,
    warning: "could not mirror the browser: the CDN hung up",
  });

  test("`artifacts push` hands it back beside the Hermes one", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG, browserMirror: failing });

    const pushed = await hermetic.artifacts.push({ version: "0.5.0" });
    expect(pushed.key).toMatch(/^artifacts\/0\.5\.0\/[0-9a-f]{16}\/hermeticd$/);
    expect(pushed.browser_warning).toContain("the CDN hung up");
    // And it is not the Hermes mirror's field: the two are told apart.
    expect(pushed.mirror_warning).toBeUndefined();
  });

  test("`init --create` yields it as a warning of its own", async () => {
    const backend = new MemoryBackend();
    const hermetic = testHermetic({ backend, config: null, browserMirror: failing });

    const events: OpEvent[] = [];
    for await (const e of hermetic.init({
      create: true,
      profile: FIXTURE_CONFIG.profile,
      region: FIXTURE_CONFIG.region,
      confirm_account_id: FIXTURE_CONFIG.account_id,
      tailnet: "acme.ts.net",
    })) {
      events.push(e);
    }
    expect(events.some((e) => e.level === "warn" && e.message.includes("the CDN hung up"))).toBe(true);
  });
});
