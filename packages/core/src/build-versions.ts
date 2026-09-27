/**
 * What this build of hermetic ships: the `hermeticd` it pushes to the bucket and
 * the Hermes it pins into a fresh render. Exported so the heads print the same
 * numbers core acts on rather than keeping their own copy.
 *
 * Its own module so the render and the runtime helpers can read the pins
 * without importing the SDK assembly (`hermetic.ts`) that re-exports them.
 */
export const BUILD_VERSIONS = {
  hermeticd: "0.5.1",
  hermes: "0.21.3",
  /**
   * The upstream git tag that *is* `hermes: "0.21.3"` — Hermes Agent ships no
   * PyPI release, so the box clones this ref and then asserts the checkout
   * reports the version above. Upstream tags by date, so bumping one means
   * looking the other up; they cannot be derived from each other.
   */
  hermes_ref: "v2026.9.14",
  /**
   * The Chrome for Testing build every `browser: true` agent runs, headed, on
   * its X display (§7.3). Playwright's CDN publishes it per architecture;
   * `artifacts push` mirrors it into the fleet bucket as
   * `browser/chrome-linux-arm64-<version>.zip` (`browser-mirror.ts`), and the
   * digest below is checked on the laptop before anything is uploaded, so a
   * swapped CDN object is refused rather than mirrored. Bumping this means
   * fetching the new zip's sha256 and size by hand, then `artifacts push`.
   */
  chrome_ref: "153.0.8010.12",
  chrome_sha256: "7d8a4b4ff289efe44a06501a519df142c4c18fff7aaf1c1401a3fbb12b3bd069",
  chrome_size: 195926016,
} as const;
