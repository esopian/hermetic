/*
 * Every link the landing page points outside itself, in one place. Docs routes are the Starlight
 * pages under src/content/docs/ (plus the ones scripts/sync-docs.ts and scripts/cli-reference.ts
 * generate); repo files link to GitHub because the site does not publish them.
 */
import { EXPLAINER_HOME, pathHref } from "./explainer";
import { REPO_URL } from "./release";

const blob = (path: string): string => `${REPO_URL}/blob/master/${path}`;

export const docs = {
  overview: "/docs/",
  gettingStarted: "/docs/start/install/",
  operations: "/docs/operate/overview/",
  cliReference: "/docs/reference/cli/",
  securityModel: "/docs/concepts/security-model/",
} as const;

// The animated walkthrough (src/pages/explainer.astro); a path link opens the player on that path.
export const explainer = {
  home: EXPLAINER_HOME,
  overview: pathHref("overview"),
  deploy: pathHref("deploy"),
  contrib: pathHref("contrib"),
  security: pathHref("security"),
} as const;

export const repo = {
  home: REPO_URL,
  readme: `${REPO_URL}#readme`,
  contributing: blob("CONTRIBUTING.md"),
  architecture: blob("docs/architecture.md"),
  designSpec: blob("docs/design.md"),
  license: blob("LICENSE"),
} as const;
