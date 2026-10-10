/*
 * Every link the landing page points outside itself, in one place. Docs routes are the Starlight
 * pages under src/content/docs/ (plus the ones scripts/sync-docs.ts and scripts/cli-reference.ts
 * generate); repo files link to GitHub because the site does not publish them.
 */
import { REPO_URL } from "./release";

const blob = (path: string): string => `${REPO_URL}/blob/master/${path}`;

export const docs = {
  gettingStarted: "/docs/start/install/",
  operations: "/docs/operate/overview/",
  cliReference: "/docs/reference/cli/",
  securityModel: "/docs/concepts/security-model/",
} as const;

export const repo = {
  home: REPO_URL,
  readme: `${REPO_URL}#readme`,
  contributing: blob("CONTRIBUTING.md"),
  architecture: blob("docs/architecture.md"),
  designSpec: blob("docs/design.md"),
  license: blob("LICENSE"),
} as const;
