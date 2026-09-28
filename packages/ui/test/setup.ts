/**
 * The DOM harness for `packages/ui`'s behavioural tests.
 *
 * Every other file in `test/` renders with `renderToStaticMarkup`, which is a
 * photograph of the first paint: no effects, no events, no focus. That is the
 * right tool for "does this row say `degraded`", and the wrong one for every
 * behaviour that only exists after a click — a focus trap, a throttled live
 * region, a confirm button that unlocks when a name is typed. Those live in the
 * `*.dom.test.tsx` files, which get their DOM from here: this module registers
 * happy-dom's `window`/`document`/`Event`/… onto `globalThis` (once, however
 * many files import it) and turns on React 19's act environment.
 *
 * A `*.dom.test.tsx` file imports `./dom.ts` — *first*, before React or Testing
 * Library — and gets `render`/`screen`/`userEvent` from there. The indirection
 * is load-bearing: ES modules evaluate a file's imports before its body, so a
 * module that both registers the DOM and re-exports Testing Library would have
 * imported Testing Library into a global scope that had no `document` yet.
 * `dom.ts` imports this file first, so the DOM exists by the time Testing
 * Library is evaluated.
 *
 * Why an import rather than a `bunfig.toml` preload: bun reads `bunfig.toml`
 * from the cwd, so a `packages/ui/bunfig.toml` is ignored by the `bun test` and
 * `bun test packages/ui` everyone runs from the repo root, and a root one would
 * register happy-dom for every package's suite whether or not any UI test is in
 * the run. A per-file import keeps the DOM inside the files that asked for one
 * — as far as it can: `bun test` is one process, so the globals do outlive this
 * package's files, which is why the two blocks below put bun's own HTTP
 * primitives and the storages back the way the rest of the repo expects them.
 *
 * Cleanup: each DOM file calls `cleanup()` in `afterEach`. Bun runs every test
 * file in one process, so a container left mounted would still be in
 * `document.body` for the next file's `screen` queries.
 */
import { afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { setTransport } from "../src/api/transport.ts";
import { clearPageVisible } from "../src/lib/visibility.ts";
import { resetDoctorStore } from "../src/state/doctor-store.ts";

const g = globalThis as { __hermeticDom?: boolean; IS_REACT_ACT_ENVIRONMENT?: boolean };

/**
 * The globals happy-dom would replace that are *not* DOM: bun's own HTTP and
 * stream primitives. `bun test` runs every package's files in one process, so
 * registering the DOM here also handed `packages/app`'s suite happy-dom's
 * `Request`/`Response`/`fetch` — and Hono, which those tests drive with real
 * `Request` objects, does not accept them. Fifteen server tests failed for no
 * reason other than that a UI test file existed.
 *
 * Bun's versions are put back immediately after registration: nothing in
 * Testing Library or React needs happy-dom's, and the DOM tests install their
 * own transport rather than a server (`fake-transport.ts`).
 */
const NATIVE_KEYS = [
  "fetch",
  "Request",
  "Response",
  "Headers",
  "FormData",
  "Blob",
  "File",
  "AbortController",
  "AbortSignal",
  "ReadableStream",
  "WritableStream",
  "TransformStream",
  "TextEncoder",
  "TextDecoder",
  "WebSocket",
  "URL",
  "URLSearchParams",
] as const;

if (!g.__hermeticDom) {
  const native = new Map<string, PropertyDescriptor>();
  for (const key of NATIVE_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    if (descriptor) native.set(key, descriptor);
  }

  // A loopback origin, because that is the only origin the portal is ever
  // served from (`server/security.ts`), and `sessionStorage` needs one.
  GlobalRegistrator.register({ url: "http://127.0.0.1:7433/" });
  g.__hermeticDom = true;

  for (const [key, descriptor] of native) {
    Object.defineProperty(globalThis, key, { ...descriptor, configurable: true });
  }

  // happy-dom installs the storages as getters with no setter, so a *non*-DOM
  // test later in the same process that swaps `globalThis.sessionStorage` for a
  // hand-rolled stub (`test/init-wizard.test.ts` does) would throw "attempted
  // to assign to readonly property" — a failure caused entirely by this file
  // having been imported. Re-declared as ordinary writable properties, holding
  // the same `Storage` objects, so those files keep working unchanged.
  for (const key of ["sessionStorage", "localStorage"] as const) {
    Object.defineProperty(globalThis, key, {
      value: globalThis[key],
      writable: true,
      configurable: true,
    });
  }

  // happy-dom leaves `document.compatMode` undefined, which KaTeX reads as
  // quirks mode and warns about on its first render. The page itself has a
  // doctype, so standards mode is what the portal really runs in.
  if (document.compatMode === undefined) {
    Object.defineProperty(document, "compatMode", { value: "CSS1Compat", configurable: true });
  }
}

// React 19 refuses to run `act()` without this, and Testing Library wraps every
// render and every `user-event` step in `act()`.
g.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The transport, off.
 *
 * Nothing in this package fetches any more — every read and write is a name
 * through the transport seam (`src/api/transport.ts`) — so the stray call worth
 * catching is a request made by a component whose test installed no
 * `fakeServer`: usually a poll that was still in flight when the component
 * unmounted. Answered here, it says what it is and names the fix; left alone it
 * would be a `transport()` throw in the middle of an unrelated file's output.
 *
 * Installed rather than left null because "no transport installed" is the
 * message for production code that forgot to boot, and this is a test that
 * forgot to fake. `fakeServer` replaces it per test and puts null back
 * afterwards, which reads the same way.
 */
const refusal = (what: string): Error =>
  new Error(`the transport is off in ui tests (${what}) — install a fakeServer route for it`);

setTransport({
  // Rejected, never thrown: a request is asynchronous everywhere it is made,
  // and a synchronous throw out of a `useEffect` takes the component down
  // instead of reaching whatever the caller wrote for a failed read.
  request: (name) => Promise.reject(refusal(name)),
  subscribe: (_kind, _key, handlers) => {
    handlers.onConnected(false);
    return () => {};
  },
  openStream: (name, _params, handlers) => {
    queueMicrotask(() =>
      handlers.onEnd(false, { code: "NO_TRANSPORT", message: refusal(name).message }),
    );
    return () => {};
  },
});

/**
 * Page visibility: one owner for the whole run.
 *
 * `document.hidden` and `document.visibilityState` are read by shipped code
 * (`src/lib/visibility.ts`, `state/listening-state.tsx`, `chat/chat-state.tsx`,
 * `chat/components/avatar/Avatar.tsx`), so a suite that wants a hidden page has
 * to patch them. Fifteen files each patched them at module scope and none put
 * them back, and `bun test` runs every file of a run in one process: the last
 * file evaluated owned both properties for every file after it. Worse, the
 * patches were two incompatible shapes — ten files installed a permanent
 * `{ value: true }` data property, five installed a getter over their own
 * module-local flag — so a data property left behind by one file silently
 * replaced another file's getter and its local flag stopped meaning anything.
 * Which file lands last is filesystem readdir order, which differs between
 * macOS and Linux, so the suite was green on a laptop and thirty-nine tests
 * red on CI.
 *
 * So the properties are installed here, exactly once, as getters over the one
 * flag below, and no other file in `test/` may touch them —
 * `test-globals.test.ts` fails the suite if one does. Suites ask through
 * `setPageHidden`/`flipPageHidden`, re-exported from `dom.ts` with the rest of
 * the harness.
 *
 * Each suite that hides the page also puts it back in its own `afterEach`,
 * because a visible page is what every other file was written against. That is
 * belt and braces rather than the only thing holding it up: the `afterEach`
 * registered at the bottom of this module does run for every file of the run,
 * not only for the first one to import it, so the flag would be reset anyway.
 * Both, because the leak this whole comment is about cost two days to find, and
 * a suite that states its own precondition is also the one that survives being
 * read on its own.
 */
let pageHidden = false;
Object.defineProperty(document, "hidden", { get: () => pageHidden, configurable: true });
Object.defineProperty(document, "visibilityState", {
  get: () => (pageHidden ? "hidden" : "visible"),
  configurable: true,
});

/**
 * Put the page in that state. Does not dispatch — most callers only want the
 * state a render reads.
 *
 * The head's pushed answer is dropped first. `isVisible()` prefers it over
 * `document` (`src/lib/visibility.ts`), so a suite that asks for a hidden page
 * inside a test that has already built a real transport would otherwise still
 * be answered "visible" — the `afterEach` below clears it between tests, which
 * is too late to help the test doing the asking.
 */
export function setPageHidden(hidden: boolean): void {
  clearPageVisible();
  pageHidden = hidden;
}

/** Put the page in that state and tell the listeners, the way a browser would. */
export function flipPageHidden(hidden: boolean): void {
  setPageHidden(hidden);
  document.dispatchEvent(new Event("visibilitychange"));
}

/**
 * Reduced motion: one owner, and on by default.
 *
 * `Avatar.tsx` asks `window.matchMedia("(prefers-reduced-motion: reduce)")`
 * whether to animate, and happy-dom answers `false` — so under test the
 * component takes the animating path, hands GSAP a batch of hosts and lets its
 * CSSPlugin read their computed transforms. happy-dom has no layout engine:
 * `getComputedStyle(el).transform` is the empty string, GSAP's matrix parser
 * gets null where it expects `matrix(…)`, and it throws. Not from the tween's
 * constructor, which `tryGsap` catches, but from the ticker when a *staggered*
 * target initialises — outside every try this component has, so it lands as an
 * unhandled error in the middle of whatever test was running.
 *
 * That was hidden until now by the visibility leak this file exists to fix:
 * ten suites left a permanent `document.hidden = true` on the process, and
 * `queueEntrance` stands down in a hidden tab, so GSAP was accidentally
 * silenced for every file that happened to run after them. With the leak gone,
 * the crash surfaces in whatever file draws a rail of avatars first — which is
 * readdir order again.
 *
 * So reduced motion is on for the whole suite, deliberately and not as a
 * side effect: an animation in a DOM with no layout animates nothing and can
 * only ever be a source of throws. The one suite whose subject *is* the
 * animation (`avatar.dom.test.tsx`) turns it off through `setReducedMotion`
 * and turns it back on afterwards, exactly as `setPageHidden` works and for
 * the same reason (a hook registered here would run for one file only).
 *
 * Only the motion query is answered here; every other `matchMedia` call is
 * happy-dom's own.
 */
const REDUCED_DEFAULT = true;
let reducedMotion = REDUCED_DEFAULT;
const nativeMatchMedia = globalThis.matchMedia.bind(globalThis);
globalThis.matchMedia = ((query: string) => {
  if (!query.includes("prefers-reduced-motion")) return nativeMatchMedia(query);
  return {
    matches: reducedMotion && query.includes("reduce"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  };
}) as unknown as typeof globalThis.matchMedia;

/**
 * What the browser reports for reduced motion. `setReducedMotion(true)` is the
 * suite's default; a file that turns it off puts it back in its own
 * `afterEach`.
 */
export function setReducedMotion(on: boolean): void {
  reducedMotion = on;
}

/** The default, for the one suite that leaves it. */
export const REDUCED_MOTION_DEFAULT = REDUCED_DEFAULT;

/**
 * The page, back to the state every suite was written against, after each test.
 *
 * A visible page with reduced motion on is the default here, and the suites
 * that want otherwise say so per test. They restore it themselves as well —
 * this hook is the floor under them, not a licence to leak.
 *
 * `createRpcTransport` seeds
 * `setPageVisible(true)` as it is built, because the app's webview reports
 * `hidden` for the life of the window and the head's answer is the only true
 * one there. That answer is module state in `src/lib/visibility.ts` and bun
 * runs every file of a run in one process, so any file that installs a real
 * transport otherwise leaves the next one's gated readers told the page is
 * visible when its own `document` says otherwise. Cleared here rather than in
 * each such file, for the same reason the refusing transport above is
 * installed here rather than in each of them.
 *
 * The page's doctor run (`src/state/doctor-store.ts`) is module state for the
 * same reason, and any file that mounts the env strip or Settings can leave one
 * behind; forgotten here, so no suite opens on another's checklist.
 */
afterEach(() => {
  clearPageVisible();
  resetDoctorStore();
  pageHidden = false;
  reducedMotion = REDUCED_DEFAULT;
});
