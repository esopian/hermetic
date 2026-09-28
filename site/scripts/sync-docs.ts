// Copies the repo's own prose into the docs site. The repo files stay the source of truth; the
// copies land in the git-ignored src/content/docs/_synced/ tree and are rewritten on every run.
//
//   docs/operations.md   -> _synced/operate/<slug>.md   (one page per `## ` section)
//
// The site is for people running hermetic, not working on it (site/AGENTS.md "Audience"), so
// developer-facing files (docs/architecture.md, CONTRIBUTING.md) are not synced, and prose that
// only matters in a checkout (the fixture backend, `bun run` scripts) is dropped sentence by
// sentence; see stripDevNotes().
//
// Links are rewritten so they work on the site: a link into one of the files above becomes a site
// path pointing at the page (and heading) it now lives on; any other repo-relative link becomes a
// GitHub blob URL. `--check` writes nothing and exits 1 on a missing source, a duplicate page slug,
// a rewritten link whose page or anchor does not exist, or output on disk that is out of date.
//
// _synced/reference/ belongs to scripts/cli-reference.ts; this script never touches it.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import GithubSlugger from "github-slugger";

const SITE = dirname(import.meta.dir);
const ROOT = dirname(SITE);
const OUT = join(SITE, "src/content/docs/_synced");
const REPO = "https://github.com/esopian/hermetic";
const MANAGED_DIRS = ["operate", "concepts", "contribute"] as const;

type Page = {
  /** Path under _synced/, without extension, e.g. `operate/teardown`. */
  path: string;
  /** Site path the page is served at. */
  url: string;
  title: string;
  /** Sidebar label, when it should differ from the title. */
  label?: string;
  order: number;
  source: string;
  body: string;
  /** Heading ids Starlight will give this page's headings. */
  anchors: Set<string>;
};

/** Where an anchor of an original source document now lives. */
type AnchorTarget = { page: Page; anchor: string | null };

type Source = {
  file: string;
  split: boolean;
  /** For a single page: its path under _synced/. For a split: the directory and the preamble's slug. */
  path: string;
  preambleSlug?: string;
};

const SOURCES: Source[] = [
  { file: "docs/operations.md", split: true, path: "operate", preambleSlug: "overview" },
];

const FENCE = /^\s{0,3}(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

type Line = { text: string; fenced: boolean };

/** Marks every line inside (or delimiting) a fenced code block. */
function scan(markdown: string): Line[] {
  const out: Line[] = [];
  let open: string | null = null;
  for (const text of markdown.split("\n")) {
    const fence = FENCE.exec(text);
    if (open !== null) {
      out.push({ text, fenced: true });
      if (fence?.[1] === open && /^(`{3,}|~{3,})\s*$/.test(text.trim())) {
        open = null;
      }
      continue;
    }
    if (fence?.[1]) {
      open = fence[1];
      out.push({ text, fenced: true });
      continue;
    }
    out.push({ text, fenced: false });
  }
  return out;
}

/** The heading's text as a slugger sees it: inline code and emphasis markers stripped. */
function headingText(raw: string): string {
  return raw
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|_)(.+?)\1/g, "$2");
}

function pageSlug(title: string): string {
  return new GithubSlugger().slug(headingText(title)).replace(/-+/g, "-").replace(/^-|-$/g, "");
}

type Problem = string;

function buildPages(problems: Problem[]): {
  pages: Page[];
  anchors: Map<string, Map<string, AnchorTarget>>;
} {
  const pages: Page[] = [];
  const anchors = new Map<string, Map<string, AnchorTarget>>();

  for (const source of SOURCES) {
    const abs = join(ROOT, source.file);
    if (!existsSync(abs)) {
      problems.push(`missing source: ${source.file}`);
      continue;
    }
    const lines = scan(readFileSync(abs, "utf8").replace(/\r\n/g, "\n"));
    const docSlugger = new GithubSlugger();
    const docAnchors = new Map<string, AnchorTarget>();
    anchors.set(source.file, docAnchors);

    // Document title: the first H1, dropped from the body (Starlight renders the title itself).
    let docTitle = source.file;
    const h1 = lines.findIndex((l) => !l.fenced && /^#\s/.test(l.text));
    if (h1 >= 0) {
      docTitle = HEADING.exec(lines[h1]?.text ?? "")?.[2] ?? docTitle;
      docSlugger.slug(headingText(docTitle));
      lines.splice(h1, 1);
    }

    type Chunk = { title: string; slug: string; lines: Line[] };
    const chunks: Chunk[] = [];
    if (source.split) {
      let current: Chunk = { title: docTitle, slug: source.preambleSlug ?? "overview", lines: [] };
      for (const line of lines) {
        const m = !line.fenced && /^##\s/.test(line.text) ? HEADING.exec(line.text) : null;
        if (m?.[2]) {
          chunks.push(current);
          current = { title: m[2], slug: pageSlug(m[2]), lines: [] };
          continue;
        }
        current.lines.push(line);
      }
      chunks.push(current);
    } else {
      chunks.push({ title: docTitle, slug: posix.basename(source.path), lines });
    }

    const seen = new Set<string>();
    chunks.forEach((chunk, i) => {
      if (seen.has(chunk.slug)) problems.push(`${source.file}: duplicate page slug "${chunk.slug}"`);
      seen.add(chunk.slug);
      const path = source.split ? `${source.path}/${chunk.slug}` : source.path;
      const page: Page = {
        path,
        url: `/docs/${path}/`,
        title: headingText(chunk.title),
        ...(source.split && i === 0 ? { label: "Overview" } : {}),
        order: i,
        source: source.file,
        body: "",
        anchors: new Set(),
      };
      // The section's own heading became the page title; its anchor in the original document
      // now means "the top of this page".
      if (source.split && i > 0)
        docAnchors.set(docSlugger.slug(headingText(chunk.title)), { page, anchor: null });

      const pageSlugger = new GithubSlugger();
      const body: Line[] = [];
      for (const line of chunk.lines) {
        const m = !line.fenced ? HEADING.exec(line.text) : null;
        if (m?.[1] && m[2]) {
          // A split page lost one level: its `###` subsections are now the page's `##`.
          const depth = source.split ? Math.max(2, m[1].length - 1) : m[1].length;
          const text = headingText(m[2]);
          const id = pageSlugger.slug(text);
          page.anchors.add(id);
          docAnchors.set(docSlugger.slug(text), { page, anchor: id });
          body.push({ text: `${"#".repeat(depth)} ${m[2]}`, fenced: false });
          continue;
        }
        body.push(line);
      }
      page.body = body
        .map((l) => l.text)
        .join("\n")
        .trim();
      pages.push(page);
    });
  }
  return { pages, anchors };
}

const LINK = /\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g;

function rewriteLinks(
  page: Page,
  anchors: Map<string, Map<string, AnchorTarget>>,
  problems: Problem[],
): string {
  const lines = scan(page.body);
  const sourceDir = posix.dirname(page.source);
  return lines
    .map((line) => {
      if (line.fenced) return line.text;
      return line.text.replace(LINK, (whole, target: string, title: string) => {
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) return whole;
        const hash = target.indexOf("#");
        const pathPart = hash >= 0 ? target.slice(0, hash) : target;
        const anchor = hash >= 0 ? target.slice(hash + 1) : null;
        const resolved =
          pathPart === ""
            ? page.source
            : pathPart.startsWith("/")
              ? posix.normalize(pathPart.slice(1))
              : posix.normalize(posix.join(sourceDir, pathPart));

        const docAnchors = anchors.get(resolved);
        if (docAnchors) {
          let dest: AnchorTarget | undefined;
          if (anchor === null || anchor === "") {
            // The document itself: its first page (the preamble, for a split source).
            const top = PAGES.find((p) => p.source === resolved && p.order === 0);
            if (!top) {
              problems.push(`${page.url}: no page for ${resolved}`);
              return whole;
            }
            dest = { page: top, anchor: null };
          } else {
            dest = docAnchors.get(decodeURIComponent(anchor).toLowerCase());
            if (!dest) {
              problems.push(
                `${page.source} -> ${page.url}: link to ${target} names no heading in ${resolved}`,
              );
              return whole;
            }
          }
          if (dest.anchor !== null && !dest.page.anchors.has(dest.anchor)) {
            problems.push(`${page.url}: rewritten link ${target} -> #${dest.anchor} does not exist`);
          }
          const url = dest.page === page && dest.anchor ? "" : dest.page.url;
          return `](${url}${dest.anchor ? `#${dest.anchor}` : ""}${title})`;
        }
        return `](${REPO}/blob/master/${resolved}${anchor !== null ? `#${anchor}` : ""}${title})`;
      });
    })
    .join("\n");
}

let PAGES: Page[] = [];

function render(page: Page, body: string): string {
  const front = [
    "---",
    `# Generated by site/scripts/sync-docs.ts from ${page.source}. Do not edit: edit the source.`,
    `slug: ${page.url.replace(/^\/|\/$/g, "")}`,
    `title: ${JSON.stringify(page.title)}`,
    `editUrl: ${JSON.stringify(`${REPO}/edit/master/${page.source}`)}`,
    "sidebar:",
    ...(page.label ? [`  label: ${JSON.stringify(page.label)}`] : []),
    `  order: ${page.order}`,
    "---",
  ];
  const note = `<!-- Generated from ${page.source} by site/scripts/sync-docs.ts. Edit the source, not this file. -->`;
  return `${front.join("\n")}\n\n${note}\n\n${body}\n`;
}

function listFiles(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
  );
}

/** Checkout-only material: the in-memory fixture backend and the repo's `bun run` scripts. */
const DEV_NOTE = /fixture|`bun run /i;

/**
 * Drops developer-only prose from a synced page. Outside code fences, a trailing "and the fixture
 * backend" is trimmed from a list of test surfaces, then any sentence still matching DEV_NOTE is
 * removed, and a line left empty by that is removed with it. Fenced code, headings and tables are
 * never touched.
 */
function stripDevNotes(markdown: string): string {
  const out: string[] = [];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (FENCE.test(line)) fenced = !fenced;
    if (fenced || FENCE.test(line) || !DEV_NOTE.test(line) || /^\s*(#|\|)/.test(line)) {
      out.push(line);
      continue;
    }
    const trimmed = line.replace(/\s+and the fixture backend/gi, "");
    if (!DEV_NOTE.test(trimmed)) {
      out.push(trimmed);
      continue;
    }
    const lead = /^\s*(?:[-*]|\d+\.)?\s*/.exec(trimmed)?.[0] ?? "";
    const kept = trimmed
      .slice(lead.length)
      .split(/(?<=[.!?])\s+(?=[A-Z`*(\[])/)
      .filter((sentence) => !DEV_NOTE.test(sentence))
      .join(" ");
    if (kept.trim() !== "") out.push(lead + kept);
  }
  return out.join("\n");
}

function main(): number {
  const check = process.argv.includes("--check");
  const problems: Problem[] = [];
  const { pages, anchors } = buildPages(problems);
  PAGES = pages;

  const outputs = new Map<string, string>();
  for (const page of pages)
    outputs.set(`${page.path}.md`, render(page, stripDevNotes(rewriteLinks(page, anchors, problems))));

  if (check) {
    const onDisk = MANAGED_DIRS.flatMap((d) => listFiles(join(OUT, d), `${d}/`));
    for (const file of onDisk) {
      if (!outputs.has(file))
        problems.push(`stale generated file: _synced/${file} (run \`bun run sync\`)`);
    }
    for (const [file, content] of outputs) {
      const abs = join(OUT, file);
      if (!existsSync(abs) || readFileSync(abs, "utf8") !== content) {
        problems.push(`out of date: _synced/${file} (run \`bun run sync\`)`);
      }
    }
  } else {
    for (const dir of MANAGED_DIRS) rmSync(join(OUT, dir), { recursive: true, force: true });
    for (const [file, content] of outputs) {
      const abs = join(OUT, file);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
  }

  for (const p of problems) process.stderr.write(`sync-docs: ${p}\n`);
  if (problems.length > 0) return 1;
  if (!check) process.stdout.write(`sync-docs: wrote ${outputs.size} pages\n`);
  return 0;
}

process.exit(main());
