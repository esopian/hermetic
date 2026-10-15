/**
 * `MemoryBox`: the stateful box the memory-provider suites run apply against
 * (`memory-provider.test.ts`, `memory-honcho.test.ts`).
 */
import { MEMORY_SERVICES, hermesPluginDir } from "@hermetic/core/shared";
import { importNameOf } from "../src/apply/index.ts";
import { HERMES_VENV_DIR } from "../src/apply/hermes.ts";
import type { ExecOptions, ExecResult, FileStat } from "../src/host.ts";
import { BoxHost } from "./fake-box.ts";
import { fail, ok } from "./fake-host.ts";

const HERMES_PYTHON = `${HERMES_VENV_DIR}/bin/python`;
const PLUGIN = MEMORY_SERVICES.hindsight.plugin!;

/** A downloaded file this fake stands in for: its claimed digest and size, not its bytes. */
export const blob = (sha: string, size: number): string => `BLOB ${sha} ${size}`;
export function parseBlob(content: string | undefined): { sha: string; size: number } | null {
  const m = /^BLOB ([0-9a-f]{64}) (\d+)$/.exec(content ?? "");
  return m ? { sha: m[1]!, size: Number(m[2]) } : null;
}

const operands = (args: readonly string[]): string[] => args.filter((a) => !a.startsWith("-"));

/**
 * `BoxHost` plus what the memory service's steps read back: `tee`/`rm`/`mv`
 * as the account move files, `uv pip install` into a venv records what it
 * installed (so a probe of Hermes's venv answers honestly), the plugin's
 * sparse clone leaves its subdirectory, and a model file `curl` fetched has
 * the digest and size the test said it would.
 */
export class MemoryBox extends BoxHost {
  /** Modules importable from Hermes's venv; `python -c import X` probes this. */
  readonly hermesModules = new Set<string>();
  /**
   * `owner:group` of a directory, as `stat -c %U:%G` reports it; a directory
   * with no entry is the account's (the steps make theirs with `install -d`
   * as `hermes`). `UNKNOWN:UNKNOWN` is a uid the box no longer has a name for.
   */
  readonly dirOwners = new Map<string, string>();

  override async stat(path: string): Promise<FileStat | null> {
    const stat = await super.stat(path);
    const b = parseBlob(this.files.get(path)?.content);
    return stat && b ? { ...stat, size: b.size } : stat;
  }

  override async sha256File(path: string): Promise<string | null> {
    return parseBlob(this.files.get(path)?.content)?.sha ?? super.sha256File(path);
  }

  /** Everything at or under `path`, files and directories. */
  /**
   * Every entry at or under `root` with its owner, as `find` walks it: a
   * directory with no `dirOwners` entry, and a file with no `ownership`, is
   * the account's (the memory steps make both as `hermes`). Nothing below a
   * symlink is visited.
   */
  treeOf(root: string): Array<[string, string]> {
    const under = (p: string): boolean => p === root || p.startsWith(`${root}/`);
    const viaLink = (p: string): boolean =>
      [...this.symlinks].some((link) => link !== p && p.startsWith(`${link}/`));
    const entries: Array<[string, string]> = [];
    for (const dir of [...this.dirs].sort()) {
      if (under(dir) && !viaLink(dir)) entries.push([dir, this.dirOwners.get(dir) ?? "hermes:hermes"]);
    }
    for (const [path, file] of this.files) {
      if (under(path) && !viaLink(path)) entries.push([path, file.ownership ?? "hermes:hermes"]);
    }
    return entries;
  }

  protected drop(path: string): void {
    for (const key of [...this.files.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) this.files.delete(key);
    }
    for (const dir of [...this.dirs])
      if (dir === path || dir.startsWith(`${path}/`)) this.dirs.delete(dir);
  }

  protected override builtin(argv: readonly string[], opts?: ExecOptions): ExecResult {
    const [bin = "", ...args] = argv;
    if (bin === "tee") {
      const path = args.at(-1) ?? "";
      if (!this.dirs.has(path.slice(0, path.lastIndexOf("/"))))
        return fail(1, `tee: ${path}: No such file`);
      this.files.set(path, { content: opts?.stdin ?? "", mode: "0644", ownership: "hermes:hermes" });
      return ok(opts?.stdin ?? "");
    }
    if (bin === "stat" && this.dirs.has(args.at(-1) ?? "")) {
      return ok(`${this.dirOwners.get(args.at(-1) ?? "") ?? "hermes:hermes"}\n`);
    }
    // `find <path> -xdev ( ! -user U -o ! -group G ) -print -quit`: the first
    // entry not owned by U:G, never descending through a symlink.
    if (bin === "find" && args.includes("-user")) {
      const root = args[0] ?? "";
      const want = `${args[args.indexOf("-user") + 1] ?? ""}:${args[args.indexOf("-group") + 1] ?? ""}`;
      const hit = this.treeOf(root).find(([, owner]) => owner !== want);
      return ok(hit ? `${hit[0]}\n` : "");
    }
    if (bin === "chown" && args.includes("-R")) {
      const [owner = "", path = ""] = operands(args);
      for (const dir of this.dirs)
        if (dir === path || dir.startsWith(`${path}/`)) this.dirOwners.set(dir, owner);
    }
    // A non-recursive chown of a directory: `BoxHost` models ownership on files only.
    if (bin === "chown" && !args.includes("-R") && this.dirs.has(operands(args).at(-1) ?? "")) {
      return ok();
    }
    if (bin === "rm") {
      for (const path of operands(args)) this.drop(path);
      return ok();
    }
    if (bin === "mv") {
      const [from, to] = operands(args);
      if (!from || !to) return fail(1, "mv: missing operand");
      if (!this.files.has(from) && !this.dirs.has(from)) return fail(1, `mv: cannot stat '${from}'`);
      this.drop(to);
      for (const [key, file] of [...this.files]) {
        if (key === from || key.startsWith(`${from}/`)) {
          this.files.delete(key);
          this.files.set(to + key.slice(from.length), file);
        }
      }
      for (const dir of [...this.dirs]) {
        if (dir === from || dir.startsWith(`${from}/`)) {
          this.dirs.delete(dir);
          this.dirs.add(to + dir.slice(from.length));
        }
      }
      return ok();
    }
    if (bin === "uv" && args[0] === "pip" && args[1] === "install" && !args.includes("-e")) {
      const python = args[args.indexOf("--python") + 1];
      if (python === HERMES_PYTHON) {
        const specs: string[] = [];
        for (let i = 2; i < args.length; i += 1) {
          if (args[i] === "--python") i += 1;
          else if (!args[i]!.startsWith("-")) specs.push(args[i]!);
        }
        for (const spec of specs) this.hermesModules.add(importNameOf(spec));
      }
      return ok();
    }
    if (bin === HERMES_PYTHON && args[0] === "-c") {
      const module = /^import (\S+)$/.exec(args[1] ?? "")?.[1] ?? "";
      return this.hermesModules.has(module) ? ok() : fail(1, `No module named '${module}'`);
    }
    // The plugin's sparse clone; Hermes's own checkout stays BoxHost's.
    const clone = `${hermesPluginDir("")}.hindsight.clone`;
    if (bin === "git" && args[0] === "clone" && args.at(-1) === clone) {
      this.dirs.add(clone);
      this.dirs.add(`${clone}/.git`);
      return ok();
    }
    if (bin === "git" && args[0] === "-C" && args[1] === clone) {
      if (args[2] === "checkout") {
        const sub = `${clone}/${PLUGIN.subdir}`;
        this.seed(`${sub}/plugin.yaml`, `name: hindsight\n# at ${args.at(-1)}\n`);
        this.seed(`${sub}/__init__.py`, "\n");
        this.dirs.add(sub);
      }
      return ok();
    }
    return super.builtin(argv, opts);
  }
}
