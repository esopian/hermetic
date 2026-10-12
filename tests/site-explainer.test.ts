/**
 * Seam: the landing page's explainer cards (`site/src/data/explainer.ts` PATHS) must
 * describe the paths the player actually ships (`site/public/explainer/path-*.js`, each
 * registering itself with `pathway({ ... })`), and the page must load every player
 * script there is. The site is not a workspace; the data module imports nothing, and
 * the path files are read as text, since they are browser scripts that need the
 * engine's globals to run.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EXPLAINER_HOME, PATHS, SCRIPTS } from "../site/src/data/explainer";

const PUBLIC = join(import.meta.dir, "..", "site", "public");
const DIR = join(PUBLIC, "explainer");

interface PathMeta {
  id: string;
  title: string;
  audience: string;
  minutes: number;
  tagline: string;
}

/** Reads the scalar fields of the `pathway({ ... })` call in one path file. */
export function parsePathway(text: string, file: string): PathMeta {
  const start = text.indexOf("pathway({");
  if (start < 0) throw new Error(`${file}: no pathway({ ... }) call`);
  const head = text.slice(start, start + 2000);
  const str = (key: string): string => {
    const m = head.match(new RegExp(`\\n\\s*${key}:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    if (m?.[1] === undefined) throw new Error(`${file}: pathway has no string "${key}"`);
    return m[1];
  };
  const minutes = head.match(/\n\s*minutes:\s*(\d+)/)?.[1];
  if (minutes === undefined) throw new Error(`${file}: pathway has no numeric "minutes"`);
  return {
    id: str("id"),
    title: str("title"),
    audience: str("audience"),
    minutes: Number(minutes),
    tagline: str("tagline"),
  };
}

describe("site explainer data matches the player", () => {
  test("PATHS equals each path file's pathway() metadata, in load order", () => {
    const shipped = PATHS.map((p) => {
      const file = `path-${p.id}.js`;
      return parsePathway(readFileSync(join(DIR, file), "utf8"), file);
    });
    expect([...PATHS]).toEqual(shipped);
  });

  test("the page loads every player script, and only scripts that exist", () => {
    const onDisk = readdirSync(DIR)
      .filter((f) => f.endsWith(".js"))
      .map((f) => `${EXPLAINER_HOME}${f}`)
      .sort();
    expect([...SCRIPTS].sort()).toEqual(onDisk);
    expect(SCRIPTS[0]).toBe(`${EXPLAINER_HOME}engine.js`);
  });
});

describe("parser is not accidentally vacuous", () => {
  test("parsePathway reads a mutated pathway apart correctly", () => {
    const text = `pathway({\n  id: "x",\n  title: "A \\"quoted\\" title",\n  audience: "Anyone",\n  level: 1,\n  minutes: 7,\n  tagline: "Tag.",\n});`;
    expect(parsePathway(text, "t.js")).toEqual({
      id: "x",
      title: 'A \\"quoted\\" title',
      audience: "Anyone",
      minutes: 7,
      tagline: "Tag.",
    });
    expect(() => parsePathway("nothing here", "t.js")).toThrow("no pathway");
  });
});
