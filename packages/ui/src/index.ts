/**
 * The React head. Runs in the app's webview, so it cannot import
 * `@hermetic/core` and would not work if it did (§3.1). It talks to
 * `@hermetic/app` over the Electrobun bridge, and takes its types from the
 * bridge's own contract — type-only, which is all the boundary matrix allows
 * the UI from that package.
 */
import type { HermeticRPC } from "@hermetic/app";

/** The contract this page is written against: what it may ask, and what it is pushed. */
export type Api = HermeticRPC;
