/**
 * `HonchoBox`: the stateful box the honcho suites run apply against
 * (`memory-honcho.test.ts`, `memory-switch.test.ts`).
 */
import { expect } from "bun:test";
import { HONCHO_PG_BIN, memoryServiceDir } from "@hermetic/core/shared";
import { HONCHO_CREATECLUSTER_CONF } from "../src/apply/memory-honcho.ts";
import type { ExecOptions, ExecResult } from "../src/host.ts";
import { fail, ok } from "./fake-host.ts";
import { MemoryBox } from "./memory-box.ts";

const DIR = memoryServiceDir("honcho");
const VENV = `${DIR}/venv`;
const CLONE = `${DIR}/.src.clone`;

/**
 * `MemoryBox` plus what honcho's steps read back: uv-managed Pythons, the
 * source checkout, `uv sync` building the venv, tiktoken filling its cache,
 * `initdb` leaving a cluster, and symlinks `readlink` can answer for.
 */
export class HonchoBox extends MemoryBox {
  /** Minor versions `uv python find --managed-python` finds. */
  readonly managedPythons = new Set<string>();
  /** Symlink → target, for `readlink`; `lstat` sees them through `symlinks`. */
  readonly linkTargets = new Map<string, string>();
  /** Every exec with the options it was given, for env/cwd/stdin assertions. */
  readonly execs: Array<{ command: string; opts: ExecOptions | undefined }> = [];
  /** Whether the createcluster drop-in was on disk when Postgres was installed. */
  confAtAptInstall: boolean | null = null;
  /** `postgres --single` answers this on stderr when set. */
  singleError: string | null = null;

  override async exec(argv: readonly string[], opts?: ExecOptions): Promise<ExecResult> {
    this.execs.push({ command: argv.join(" "), opts });
    return super.exec(argv, opts);
  }

  /** The options of the one exec matching `pattern`. */
  optsOf(pattern: RegExp): ExecOptions | undefined {
    const hits = this.execs.filter((e) => pattern.test(e.command));
    expect(hits, `expected one exec matching ${String(pattern)}`).toHaveLength(1);
    return hits[0]!.opts;
  }

  /** A symlink as `ln -s` leaves it. */
  symlink(target: string, path: string): void {
    this.files.set(path, { content: "", mode: "0777" });
    this.symlinks.add(path);
    this.linkTargets.set(path, target);
  }

  protected override drop(path: string): void {
    this.symlinks.delete(path);
    this.linkTargets.delete(path);
    super.drop(path);
  }

  protected override builtin(argv: readonly string[], opts?: ExecOptions): ExecResult {
    const [bin = "", ...args] = argv;
    if (bin === "apt-get" && args.includes("install") && args.includes("postgresql-16")) {
      this.confAtAptInstall = this.files.has(HONCHO_CREATECLUSTER_CONF);
    }
    if (bin === "uv" && args[0] === "python") {
      const version = args.at(-1) ?? "";
      if (args[1] === "find")
        return this.managedPythons.has(version) ? ok(`/x/python${version}\n`) : fail(2);
      if (args[1] === "install") this.managedPythons.add(version);
      return ok();
    }
    if (bin === "uv" && args[0] === "sync") {
      const venv = opts?.env?.UV_PROJECT_ENVIRONMENT ?? "";
      if (!this.files.has(`${opts?.cwd ?? ""}/uv.lock`)) return fail(2, "No `pyproject.toml` found");
      if (!this.managedPythons.has("3.13")) return fail(2, "No interpreter found for Python 3.13");
      this.seed(`${venv}/bin/python`, "#!/bin/sh\n", "0755");
      this.seed(`${venv}/bin/uvicorn`, "#!/bin/sh\n", "0755");
      return ok();
    }
    if (bin === `${VENV}/bin/python` && args[0] === "-c" && args[1]?.includes("tiktoken")) {
      if (!this.files.has(bin)) return fail(127, "no such file");
      const cache = opts?.env?.TIKTOKEN_CACHE_DIR ?? "";
      this.seed(`${cache}/9b5ad71b2ce5302211f9c61530b329a4922fc6a4`, "o200k");
      this.seed(`${cache}/fb374d419588a4632f3f557e76b4b70aebbca790`, "cl100k");
      return ok();
    }
    if (bin === "git" && args[0] === "clone" && args.at(-1) === CLONE) {
      this.dirs.add(CLONE);
      this.dirs.add(`${CLONE}/.git`);
      return ok();
    }
    if (bin === "git" && args[0] === "-C" && args[1] === CLONE && args[2] === "checkout") {
      // uv's workspace members are part of the whole-tree checkout.
      for (const f of [
        "pyproject.toml",
        "uv.lock",
        "sdks/python/pyproject.toml",
        "honcho-cli/pyproject.toml",
      ]) {
        this.seed(`${CLONE}/${f}`, `# at ${args.at(-1)}\n`);
      }
      return ok();
    }
    if (bin === `${HONCHO_PG_BIN}/initdb`) {
      const data = args[args.indexOf("-D") + 1] ?? "";
      this.dirs.add(data);
      this.seed(`${data}/PG_VERSION`, "16\n", "0600");
      return ok();
    }
    if (bin === `${HONCHO_PG_BIN}/postgres` && args[0] === "--single") {
      if (!this.files.has(`${args[args.indexOf("-D") + 1] ?? ""}/PG_VERSION`))
        return fail(1, "no cluster");
      return this.singleError === null ? ok() : { code: 0, stdout: "", stderr: this.singleError };
    }
    if (bin === "ln" && args.includes("-s")) {
      const [target, path] = args.filter((a) => !a.startsWith("-"));
      if (!target || !path || this.files.has(path))
        return fail(1, `ln: failed to create symbolic link`);
      this.symlink(target, path);
      return ok();
    }
    if (bin === "readlink") {
      const target = this.linkTargets.get(args.at(-1) ?? "");
      return target === undefined ? fail(1) : ok(`${target}\n`);
    }
    return super.builtin(argv, opts);
  }
}
