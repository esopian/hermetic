/**
 * `NavProvider` for a component test.
 *
 * Header, the create drawer and Settings read where they are from
 * `useNav()` rather than from props, so a test that mounts one of them alone
 * wraps it here — the real provider, not a stub, so the hash it writes is the
 * observable outcome of a navigation the component asked for.
 */
import type { ReactNode } from "react";
import { NavProvider } from "../src/nav/nav-state.tsx";

export function withNav(node: ReactNode) {
  return <NavProvider>{node}</NavProvider>;
}

/**
 * The provider seeds its view from `window.location.hash` and writes back to
 * it, so a test that navigated leaves the next one starting somewhere else
 * unless the hash is cleared between them.
 */
export function resetHash(): void {
  history.replaceState(null, "", window.location.pathname + window.location.search);
}
