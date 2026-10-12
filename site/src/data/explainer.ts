/*
 * The explainer (/explainer/): an animated walkthrough of hermetic in five paths. The player and
 * its scenes are plain browser scripts under public/explainer/, served as they are; this file is
 * what the rest of the site needs to know about them.
 *
 * PATHS mirrors each path's own `pathway({ id, title, audience, minutes, tagline })` call in
 * public/explainer/path-<id>.js, in the explainer's landing-page order. tests/site-explainer.test.ts
 * (repo root) fails if the two drift: change them together.
 */

export const EXPLAINER_HOME = "/explainer/";

export interface ExplainerPath {
  id: string;
  title: string;
  audience: string;
  minutes: number;
  tagline: string;
}

export const PATHS: readonly ExplainerPath[] = [
  {
    id: "overview",
    title: "The big picture",
    audience: "Anyone",
    minutes: 6,
    tagline: "What hermetic is for and how it works, in pictures.",
  },
  {
    id: "user",
    title: "Working with agents",
    audience: "Agent users",
    minutes: 8,
    tagline: "What an agent can do for you, how to talk to it, and where its limits are.",
  },
  {
    id: "deploy",
    title: "Standing up a fleet",
    audience: "Operators",
    minutes: 13,
    tagline: "From an empty AWS account to running agents and back: every command, in order.",
  },
  {
    id: "contrib",
    title: "Inside the code",
    audience: "Contributors",
    minutes: 13,
    tagline: "The layout, the rules, and how to add a core method end to end.",
  },
  {
    id: "security",
    title: "Trust model & seals",
    audience: "Security reviewers",
    minutes: 16,
    tagline: "Trust boundaries, twenty containment seals, five attacks, and the gaps on the record.",
  },
];

/** A deep link that opens the player at the start of one path (`#<path>/<scene>/<beat>`). */
export const pathHref = (id: string): string => `${EXPLAINER_HOME}#${id}`;

/**
 * The player's scripts, in load order: the engine, the shared glossary, the scene library (scenes
 * more than one path uses), then one file per path. Each is a classic script that registers itself
 * through the engine's globals, so the order matters and none of them is bundled.
 */
export const SCRIPTS: readonly string[] = [
  "engine",
  "glossary",
  "lib-software",
  "lib-aws",
  "lib-box",
  "lib-comms",
  "lib-rails",
  ...PATHS.map((p) => `path-${p.id}`),
].map((name) => `${EXPLAINER_HOME}${name}.js`);
