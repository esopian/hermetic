/**
 * React, re-exported from inside this package.
 *
 * `react` is a dependency of `packages/ui` and of nothing else, so it resolves
 * from this directory and not from the repository root. The root seam tests may
 * — and must — import both a head's source and a browser's
 * (`tests/chat-stream-seam.test.ts`, and the rule in AGENTS.md that puts seam
 * tests at the root because no package may import both sides), and driving the
 * chat store means rendering the hook that holds it.
 *
 * So this is the door: a root test imports `packages/ui/test/dom.ts` for the
 * DOM and Testing Library, and this file for the two React entry points
 * Testing Library does not re-export. Deliberately nothing else — it is a
 * resolution bridge, not a harness.
 */
export { createElement, useEffect } from "react";
