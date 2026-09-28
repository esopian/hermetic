// Renders the CLI reference from the CLI's own help text, so the site cannot describe a flag the
// binary does not have. Spawns `bun ../packages/cli/src/main.ts --fixture <path…> --help` for the
// root and every subcommand it lists (walked recursively), plus `help exit-codes`, and writes
//
//   _synced/reference/cli.md         one section per command, help text in fenced blocks
//   _synced/reference/exit-codes.md  the exit-code table
//
// The CLI runs against a throwaway HERMETIC_HOME (removed afterwards) with HERMETIC_FLEET and every
// AWS credential variable unset, so it can never read or write the real ~/.hermetic. The site does
// not import the CLI; it only runs it. _synced/reference/ is this script's alone.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SITE = dirname(import.meta.dir);
const ROOT = dirname(SITE);
const OUT = join(SITE, "src/content/docs/_synced/reference");
const MAIN = "../packages/cli/src/main.ts";
const CONCURRENCY = 8;

const home = mkdtempSync(join(tmpdir(), "hermetic-site-cli-"));

function env(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.startsWith("HERMETIC_") || k.startsWith("AWS_") || k === "FORCE_COLOR") continue;
    out[k] = v;
  }
  return { ...out, HERMETIC_HOME: home, NO_COLOR: "1" };
}

/** Removes anything machine-specific a help text might carry. */
function scrub(text: string): string {
  // The global --fixture flag and its examples are for working on hermetic, not running it
  // (site/AGENTS.md "Audience"); the reference leaves them out.
  return text
    .split("\n")
    .filter((line) => !/fixture/i.test(line))
    .join("\n")
    .replaceAll(home, "~/.hermetic")
    .replaceAll(ROOT, "<repo>")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

async function run(args: string[]): Promise<string> {
  const proc = Bun.spawn(["bun", MAIN, ...args], {
    cwd: SITE,
    env: env(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`hermetic ${args.join(" ")} exited ${code}\n${stderr || stdout}`);
  return scrub(stdout);
}

const help = (path: string[]) => run(["--fixture", ...path, "--help"]);

type Group = { name: string; commands: string[] };

/** The root help lists commands under group headings (`  fleet`, then `    init …`). */
function parseRoot(text: string): Group[] {
  const groups: Group[] = [];
  let inCommands = false;
  for (const line of text.split("\n")) {
    if (/^Commands\b/.test(line)) {
      inCommands = true;
      continue;
    }
    if (!inCommands) continue;
    if (line.trim() === "") {
      if (groups.length > 0) break;
      continue;
    }
    const heading = /^ {2}(\S+)\s*$/.exec(line);
    if (heading?.[1]) {
      groups.push({ name: heading[1], commands: [] });
      continue;
    }
    const command = /^ {4}(\S+)/.exec(line);
    if (command?.[1] && command[1] !== "help") groups.at(-1)?.commands.push(command[1]);
  }
  return groups;
}

/** A subcommand's help lists its own children under `Commands:`, two spaces in. */
function parseSub(text: string): string[] {
  const names: string[] = [];
  let inCommands = false;
  for (const line of text.split("\n")) {
    if (/^Commands:/.test(line)) {
      inCommands = true;
      continue;
    }
    if (!inCommands) continue;
    // The list ends at the first blank line; examples and prose follow it, also indented.
    if (line.trim() === "" || /^\S/.test(line)) break;
    const command = /^ {2}(\S+)/.exec(line);
    if (command?.[1] && command[1] !== "help") names.push(command[1]);
  }
  return names;
}

type Entry = { path: string[]; text: string };

async function walk(roots: string[][]): Promise<Entry[]> {
  const entries: Entry[] = [];
  let level = roots;
  while (level.length > 0) {
    const texts: string[] = [];
    for (let i = 0; i < level.length; i += CONCURRENCY) {
      texts.push(...(await Promise.all(level.slice(i, i + CONCURRENCY).map(help))));
    }
    const next: string[][] = [];
    level.forEach((path, i) => {
      const text = texts[i] ?? "";
      // A path the CLI did not resolve to a command prints its parent's help instead; stop there.
      const usage = /^Usage: hermetic (.*)$/m.exec(text)?.[1] ?? "";
      if (!`${usage} `.startsWith(`${path.join(" ")} `)) {
        throw new Error(`\`hermetic ${path.join(" ")} --help\` printed help for \`hermetic ${usage}\``);
      }
      entries.push({ path, text });
      for (const child of parseSub(text)) next.push([...path, child]);
    });
    level = next;
  }
  return entries;
}

function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(longest + 1);
  return `${f}text\n${text}\n${f}`;
}

function front(slug: string, title: string, description: string, order: number): string {
  return [
    "---",
    "# Generated by site/scripts/cli-reference.ts from the CLI's own --help output. Do not edit.",
    `slug: ${slug}`,
    `title: ${JSON.stringify(title)}`,
    `description: ${JSON.stringify(description)}`,
    "editUrl: false",
    "sidebar:",
    `  order: ${order}`,
    "---",
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const rootHelp = await help([]);
  const groups = parseRoot(rootHelp);
  if (groups.length === 0) throw new Error("could not find any command groups in `hermetic --help`");

  const sections: string[] = [];
  for (const group of groups) {
    const entries = await walk(group.commands.map((c) => [c]));
    // Depth first, in the order each help lists its children, so `agent create` follows `agent`.
    const byPath = new Map(entries.map((e) => [e.path.join(" "), e]));
    const ordered: Entry[] = [];
    const visit = (path: string[]) => {
      const entry = byPath.get(path.join(" "));
      if (!entry) return;
      ordered.push(entry);
      for (const child of parseSub(entry.text)) visit([...path, child]);
    };
    for (const c of group.commands) visit([c]);
    sections.push(`## ${group.name} commands`);
    for (const e of ordered) {
      sections.push(`### hermetic ${e.path.join(" ")}\n\n${fence(e.text)}`);
    }
  }

  const cli = [
    front(
      "docs/reference/cli",
      "CLI reference",
      "Every hermetic command and its options, from the CLI's own help text.",
      1,
    ),
    "The text below is the output of `hermetic <command> --help` for every command, generated from the CLI at build time. Run the same command locally for the version you have installed.",
    "",
    "## hermetic",
    "",
    fence(rootHelp),
    "",
    sections.join("\n\n"),
    "",
  ].join("\n");

  const exitText = await run(["help", "exit-codes"]);
  const rows = exitText
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => `| ${m[1]} | ${(m[2] ?? "").replace(/\|/g, "\\|")} |`);
  if (rows.length === 0) throw new Error("could not parse `hermetic help exit-codes`");
  const exitCodes = [
    front(
      "docs/reference/exit-codes",
      "Exit codes",
      "The exit code each hermetic error code maps to.",
      2,
    ),
    "Each error code the CLI can report maps to one process exit code, so a script can branch on the exit status. Codes without their own row exit 1.",
    "",
    "| Exit | Error codes |",
    "| --- | --- |",
    ...rows,
    "",
    "Generated from `hermetic help exit-codes`:",
    "",
    fence(exitText),
    "",
  ].join("\n");

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "cli.md"), cli);
  writeFileSync(join(OUT, "exit-codes.md"), exitCodes);
  process.stdout.write(
    `cli-reference: wrote ${sections.length - groups.length} command sections, ${rows.length} exit codes\n`,
  );
}

try {
  await main();
} catch (error) {
  process.stderr.write(`cli-reference: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  rmSync(home, { recursive: true, force: true });
}
