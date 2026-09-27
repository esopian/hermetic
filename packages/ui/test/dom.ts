/**
 * The one door into the DOM harness: `import { render, screen, userEvent } from
 * "./dom.ts";` as the *first* import of a `*.dom.test.tsx` file. See
 * `setup.ts` for what it installs and why it is not a `bunfig.toml` preload.
 *
 * Testing Library is pulled in with `await import` rather than a static import
 * on purpose. Testing Library is CommonJS, bun hoists its `require` above the
 * ESM side-effect import next to it, and `@testing-library/dom`'s `screen`
 * binds its queries to `document.body` at module scope — so a static import
 * bound them before happy-dom existed and every `screen.getBy*` threw "a global
 * document has to be available". The top-level `await` is what makes
 * "register the DOM, *then* load the library" an order the bundler cannot
 * rearrange.
 */
import "./setup.ts";

// Page visibility is `setup.ts`'s to own — see the comment there. A suite that
// wants a hidden page asks through these two rather than patching `document`.
export { flipPageHidden, setPageHidden } from "./setup.ts";

// Reduced motion is `setup.ts`'s too, and on by default — see the comment
// there. Only the suite that tests the animation itself turns it off.
export { REDUCED_MOTION_DEFAULT, setReducedMotion } from "./setup.ts";

const rtl = await import("@testing-library/react");
const ue = await import("@testing-library/user-event");

export const { act, cleanup, fireEvent, render, screen, waitFor, within } = rtl;
export const userEvent = ue.default;
