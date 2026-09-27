/**
 * §7.3: mirror the pinned Chrome for Testing build into the fleet's bucket, so
 * a `browser: true` agent installs its browser from S3 over the gateway
 * endpoint instead of reaching a third-party CDN at boot.
 *
 * The same bargain `hermes-mirror.ts` makes, for the same three reasons: the
 * fleet's browser version becomes a fact recorded in the manifest rather than
 * whatever the CDN served that morning, a create stops depending on a service
 * nobody here operates, and a box with no general egress still works.
 *
 * **Ubuntu 24.04 arm64 ships no usable browser.** `chromium-browser` and
 * `firefox` are transitional packages onto snaps, and the snap refuses to run
 * for an account whose home is outside `/home` — which is every account Hermes
 * uses. So the browser is not a package: it is a pinned zip, mirrored here and
 * unpacked by a bootstrap stage into `/opt/hermetic/chrome/<chrome_ref>/`.
 *
 * **The digest is checked on the laptop, before anything is uploaded.** The
 * bytes are 196 MB of executable that an agent will point at arbitrary web
 * content while holding live sessions, and the only place hermetic can compare
 * them against a reviewed pin is here. A mismatch is a `HermeticError`
 * (`BROWSER_MIRROR_MISMATCH`) and nothing reaches the bucket: unlike a network
 * failure, it is not a thing a retry fixes, and it is not a thing to warn about
 * and carry on from.
 *
 * **Every other failure is soft**, exactly as the Hermes mirror's is. A laptop
 * that cannot reach the CDN warns and leaves the manifest block untouched,
 * because an `artifacts push` is how the whole fleet is maintained and a
 * browser that could not be refreshed must not stop a hermeticd release from
 * being published. The difference from `hermes/` is that there is no fallback
 * on the box — a box whose build is not in the bucket has no browser — so the
 * warning says that plainly.
 *
 * Deps are explicit (AGENTS.md rule 5) and `fetch` among them defaults to the
 * global one in `hermetic.ts`, for the reason §4.7's preflight probes do: an
 * absent dependency must not be able to silently disable the step. Fixture mode
 * is canned in `fixtureBrowserMirror` and never opens a socket.
 */
import { createHash } from "node:crypto";
import type { FetchLike } from "../aws/tailscale.ts";
import type { ArtifactsApi } from "../backend/types.ts";
import { HermeticError } from "../errors.ts";
import {
  BROWSER_FOUNDATION_VERSION,
  browserBuildKey,
  type FleetItem,
  type FleetManifest,
  isChromeRef,
} from "../schema/index.ts";

/**
 * Where the builds come from: Playwright's own CDN, which is what resolves
 * `npx playwright install chromium` and therefore the one place a build
 * numbered like upstream's is published per architecture.
 */
export const CHROME_CDN_BASE = "https://cdn.playwright.dev/builds/cft";

/** The CDN object one pinned build lives at. */
export function chromeDownloadUrl(chromeRef: string): string {
  return `${CHROME_CDN_BASE}/${chromeRef}/linux-arm64/chrome-linux-arm64.zip`;
}

/**
 * Generous, because this is a ~190 MB download on whatever connection the
 * operator has, and a timeout firing mid-transfer looks exactly like the outage
 * this exists to route around. Shorter than the Hermes mirror's fifteen
 * minutes: one object over HTTP is not a cold clone of a repository that ships
 * a web app.
 */
export const BROWSER_MIRROR_TIMEOUT_MS = 10 * 60_000;

const ZIP_CONTENT_TYPE = "application/zip";

/**
 * Deliberately no `Clock`, for the reason `HermesMirrorDeps` has none: nothing
 * here is timestamped. The entry this returns is dated by the manifest write
 * that records it.
 */
export interface BrowserMirrorDeps {
  artifacts: Pick<ArtifactsApi, "putObject" | "exists">;
  /** Injected in tests; production passes the global `fetch` (`hermetic.ts`). */
  fetch?: FetchLike;
  /** Shrunk by the timeout test; nothing else sets it. */
  timeoutMs?: number;
}

export interface BrowserMirrorInput {
  /** `BUILD_VERSIONS.chrome_ref` at every call site today. */
  chrome_ref: string;
  /** `BUILD_VERSIONS.chrome_sha256`: what the CDN object must hash to. */
  sha256: string;
  /** `BUILD_VERSIONS.chrome_size`: what it must weigh, in bytes. */
  size: number;
  /** The manifest's browser block as it stands, so this merges rather than replaces. */
  existing?: FleetManifest["browser"];
  /** Defaults to `chromeDownloadUrl(chrome_ref)`; a test points it at a local server. */
  url?: string;
}

/**
 * - `present`: the build is already in the bucket and named by the manifest.
 *   Nothing was downloaded — the idempotent path every re-push takes.
 * - `pushed`: the zip was fetched, verified and uploaded; `block` gains an entry.
 * - `skipped`: the download or the upload failed. `block` is unchanged and
 *   `warning` says why. A digest mismatch is *not* this: it throws.
 */
export type BrowserMirrorStatus = "present" | "pushed" | "skipped";

export interface BrowserMirrorResult {
  /** The manifest block to write: `existing` plus this build, or `existing`. */
  block: FleetManifest["browser"];
  status: BrowserMirrorStatus;
  /** The build this call was about, whatever became of it. */
  chrome_ref: string;
  /** `true` only when bytes actually came over the network. */
  downloaded: boolean;
  warning?: string;
}

/** How a caller asks for the mirror, whichever implementation is wired in. */
export type BrowserMirrorFn = (input: {
  chrome_ref: string;
  sha256: string;
  size: number;
  existing: FleetManifest["browser"];
}) => Promise<BrowserMirrorResult>;

/**
 * The same thing with this build's pin already bound. `artifacts.ts` takes this
 * shape rather than `BrowserMirrorFn` for the reason it takes
 * `HermesMirrorStep`: which build is pinned is `BUILD_VERSIONS`, which lives in
 * `hermetic.ts` — and `hermetic.ts` imports `artifacts.ts`, not the reverse.
 */
export type BrowserMirrorStep = (existing: FleetManifest["browser"]) => Promise<BrowserMirrorResult>;

/**
 * Ensure `browser/chrome-linux-arm64-<ref>.zip` is in the bucket and return the
 * manifest block that names it. Throws only for the two things no retry fixes:
 * a ref that is not a ref, and bytes that are not the pinned build.
 */
export async function ensureBrowserMirror(
  deps: BrowserMirrorDeps,
  input: BrowserMirrorInput,
): Promise<BrowserMirrorResult> {
  const ref = input.chrome_ref;
  /**
   * A programmer error, not an outage: the ref becomes an object key, a URL
   * path segment and a directory name on the box, and none of those is a place
   * to find out it was something else.
   */
  if (!isChromeRef(ref)) {
    throw new HermeticError(
      "VALIDATION",
      `${JSON.stringify(ref)} is not a Chrome for Testing build number hermetic will mirror: dotted digits, as the CDN publishes them`,
      { chrome_ref: ref },
    );
  }
  const key = browserBuildKey(ref);
  const url = input.url ?? chromeDownloadUrl(ref);
  const existing = input.existing;

  try {
    /**
     * Idempotent: a build the manifest already names, whose object is still
     * there, is a no-op — nothing is downloaded and nothing is uploaded. The
     * digest is not re-verified here, because that would mean pulling 196 MB out
     * of S3 on every push; the box verifies the bytes against this digest before
     * it unpacks anything, which is where a corrupted object has to be caught
     * anyway.
     *
     * What *is* compared is the whole recorded entry against this build's pin,
     * not just the key. The key is a function of `chrome_ref` alone, so a
     * release that corrects a wrong `chrome_sha256`, `chrome_size` or URL for a
     * ref it had already published leaves the key identical — and keying the
     * skip on that alone made the fleet manifest keep the wrong digest for good.
     * Nothing else rewrites that entry, and the box verifies against it rather
     * than against the laptop's pin, so `artifacts push` — the command an
     * operator would reach for — was the one command that could not repair the
     * thing it exists to publish.
     *
     * Inside the `try` because `exists` is an S3 call: expired credentials, a
     * bucket policy, a 503 — every one of them throws, and a throw escaping over
     * a probe whose whole purpose is to decide whether to skip work would take
     * `artifacts push`, `init` and `foundation update` down with it.
     */
    const recorded = existing?.[ref];
    if (
      recorded?.key === key &&
      recorded.sha256 === input.sha256 &&
      recorded.size === input.size &&
      recorded.url === url &&
      (await deps.artifacts.exists(key))
    ) {
      return { block: existing, status: "present", chrome_ref: ref, downloaded: false };
    }
    const bytes = await download(deps, url);
    /**
     * Verified *before* `putObject`, not after, and both halves are checked:
     * a truncated transfer and a substituted object fail differently, and the
     * operator wants to be told which. Nothing is written to the bucket on
     * either — a fleet that keeps the build it had is strictly better off than
     * one holding bytes nobody reviewed.
     */
    assertPinned(bytes, { chrome_ref: ref, url, sha256: input.sha256, size: input.size });
    await deps.artifacts.putObject(key, bytes, ZIP_CONTENT_TYPE);
    return {
      block: {
        ...(existing ?? {}),
        [ref]: { key, sha256: input.sha256, size: input.size, url },
      },
      status: "pushed",
      chrome_ref: ref,
      downloaded: true,
    };
  } catch (e) {
    // The one failure that is not soft: bytes that are not the pinned build are
    // a fact about the world, not a transient, and carrying on would publish a
    // fleet whose browser nobody reviewed.
    if (e instanceof HermeticError) throw e;
    return {
      block: existing,
      status: "skipped",
      chrome_ref: ref,
      downloaded: false,
      warning: `could not mirror the browser (Chrome for Testing ${ref}) into the fleet bucket (${e instanceof Error ? e.message : String(e)}); agents created with \`--browser\` will have no browser to run until \`hermetic artifacts push\` succeeds from a laptop that can reach ${CHROME_CDN_BASE}`,
    };
  }
}

/**
 * The mirror with this build's pin bound: what a push takes, and the shape that
 * keeps `BUILD_VERSIONS` — which lives in `hermetic.ts` — out of `artifacts.ts`.
 */
export function browserMirrorStep(
  mirror: BrowserMirrorFn,
  pin: { chrome_ref: string; chrome_sha256: string; chrome_size: number },
): BrowserMirrorStep {
  return (existing) =>
    mirror({
      chrome_ref: pin.chrome_ref,
      sha256: pin.chrome_sha256,
      size: pin.chrome_size,
      existing,
    });
}

/**
 * The mirror a `Hermetic` uses when its caller named none: the real one, or
 * fixture mode's stand-in. Here rather than inline in `hermetic.ts` because the
 * choice between the two implementations is this module's, and `hermetic.ts` is
 * the file AGENTS.md rule 5 keeps having to be split.
 */
export function browserMirrorFor(opts: {
  artifacts: Pick<ArtifactsApi, "putObject" | "exists">;
  fixture: boolean;
}): BrowserMirrorFn {
  return async (input) =>
    opts.fixture
      ? fixtureBrowserMirror(opts.artifacts, input)
      : ensureBrowserMirror(
          { artifacts: opts.artifacts },
          {
            chrome_ref: input.chrome_ref,
            sha256: input.sha256,
            size: input.size,
            existing: input.existing,
          },
        );
}

/**
 * Fixture mode's mirror: a stand-in object, in the in-memory bucket. Shape
 * rather than content, the same way `fixtureHermesMirror` and `STAND_IN_STAGES`
 * are — a fixture bucket boots nothing, and `--fixture` must not open a socket
 * any more than it may construct an AWS client.
 *
 * The pin is deliberately *not* enforced here: the fixture's bytes are its own,
 * so its digest and size are computed from them. Checking a real build's digest
 * against a stand-in would only ever fail.
 */
export async function fixtureBrowserMirror(
  artifacts: Pick<ArtifactsApi, "putObject" | "exists">,
  input: { chrome_ref: string; existing: FleetManifest["browser"] },
): Promise<BrowserMirrorResult> {
  const { chrome_ref: ref, existing } = input;
  const key = browserBuildKey(ref);
  if (existing?.[ref]?.key === key && (await artifacts.exists(key))) {
    return { block: existing, status: "present", chrome_ref: ref, downloaded: false };
  }
  const bytes = fixtureBrowserBytes(ref);
  await artifacts.putObject(key, bytes, ZIP_CONTENT_TYPE);
  return {
    block: { ...(existing ?? {}), [ref]: fixtureBrowserEntry(ref) },
    status: "pushed",
    chrome_ref: ref,
    downloaded: false,
  };
}

/**
 * The stand-in build's bytes. `PK` so anything sniffing the object
 * sees a zip, and nothing else — a fixture must not carry 196 MB around.
 *
 * Exported because the seeded fixture fleet puts the same object in its bucket
 * (`memory-fixture.ts`), and a seed that disagreed with this would make a
 * fixture `artifacts push` re-upload a build that was already there.
 */
export function fixtureBrowserBytes(chromeRef: string): Uint8Array {
  return new TextEncoder().encode(`PKfixture chrome for testing ${chromeRef}\n`);
}

/** The manifest entry those bytes produce, for the fixture seed and for tests. */
export function fixtureBrowserEntry(chromeRef: string): {
  key: string;
  sha256: string;
  size: number;
  url: string;
} {
  const bytes = fixtureBrowserBytes(chromeRef);
  return {
    key: browserBuildKey(chromeRef),
    sha256: digestOf(bytes),
    size: bytes.byteLength,
    url: chromeDownloadUrl(chromeRef),
  };
}

/**
 * Refuse an agent on a fleet whose foundation cannot read the mirror (§7.3).
 *
 * Here rather than in `lifecycle.ts` because it is this module's subject: v14
 * is the version that grants `browser/*`, and the grant and the mirror are one
 * contract. Without this the promise of "a clear needs-foundation-update" is a
 * 403 in a bootstrap stage, eight minutes into a first boot nobody is watching.
 *
 * It takes no `browser` argument, because there is no longer an agent this does
 * not apply to. Every agent runs a browser, so a fleet below v14 can create and
 * rerun **nothing** until it is updated — a wider refusal than the flagged one
 * it replaced, and deliberately so: the alternative was keeping a second shape
 * of agent alive purely so that a stale fleet could still make one.
 */
export function assertBrowserSupported(fleet: Pick<FleetItem, "foundation_version">): void {
  if ((fleet.foundation_version ?? 0) >= BROWSER_FOUNDATION_VERSION) return;
  throw new HermeticError(
    "BROWSER_NEEDS_FOUNDATION_UPDATE",
    `every agent runs a browser, which needs foundation v${BROWSER_FOUNDATION_VERSION} (it grants the box read on the mirrored Chrome build) — run \`hermetic foundation update\``,
    {
      required: BROWSER_FOUNDATION_VERSION,
      foundation_version: fleet.foundation_version ?? 0,
    },
  );
}

function digestOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The whole object, in memory. 196 MB is a lot to hold and still the right
 * shape: the digest has to be over the complete bytes before any of them are
 * uploaded, so there is no streaming version of this that also refuses a
 * substituted object before it reaches the bucket.
 */
async function download(deps: BrowserMirrorDeps, url: string): Promise<Uint8Array> {
  const http: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init));
  const res = await http(url, {
    signal: AbortSignal.timeout(deps.timeoutMs ?? BROWSER_MIRROR_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GET ${url} answered ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Length first, then digest: a truncated transfer has a cheaper answer. */
function assertPinned(
  bytes: Uint8Array,
  pin: { chrome_ref: string; url: string; sha256: string; size: number },
): void {
  if (bytes.byteLength !== pin.size) {
    throw new HermeticError(
      "BROWSER_MIRROR_MISMATCH",
      `${pin.url} is ${bytes.byteLength} bytes; this build of hermetic pins Chrome for Testing ${pin.chrome_ref} at ${pin.size} bytes, so nothing was uploaded`,
      { chrome_ref: pin.chrome_ref, url: pin.url, expected: pin.size, actual: bytes.byteLength },
    );
  }
  const actual = digestOf(bytes);
  if (actual !== pin.sha256) {
    throw new HermeticError(
      "BROWSER_MIRROR_MISMATCH",
      `${pin.url} hashes to ${actual}; this build of hermetic pins Chrome for Testing ${pin.chrome_ref} at ${pin.sha256}, so nothing was uploaded`,
      { chrome_ref: pin.chrome_ref, url: pin.url, expected: pin.sha256, actual },
    );
  }
}

/** `196 MB`, for an event that says what is being downloaded and how big it is. */
export function megabytes(size: number): string {
  return `${Math.round(size / 1_000_000)} MB`;
}
