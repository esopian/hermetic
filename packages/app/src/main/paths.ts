/**
 * Where the bundle keeps its sidecars, and where this process keeps its state.
 *
 * The app ships `hermetic`, `hermeticd`, the version stamps and the bootstrap
 * stages in `Contents/Resources/app/bin` (`scripts/app-stage.ts` stages them
 * into `dist/bin`, and `electrobun.config.ts` copies that to `bin`). The
 * process running this code is `Contents/MacOS/bun`, so they are *not* beside
 * its executable and core's sibling rule cannot find them on its own.
 * Core will find them if it is told: `HERMETIC_HERMETICD` and `HERMETIC_STAGES`
 * are the first, winning lookup in `release/artifacts-release.ts`, ahead of the
 * sibling-of-`execPath` rule the CLI relies on. `main/index.ts` sets both from
 * here before `openState`, which is why this is a module and not four
 * `join` calls at the top of it.
 *
 * Pure on purpose. `execPath` and the environment arrive as arguments rather
 * than being read off `process`, so the layout can be asserted — including the
 * cases this machine is not in, a `HERMETIC_HOME` override and a `$HOME` that
 * is not the one running the tests.
 */
import { join } from "node:path";
import { logPathFor } from "../log.ts";

export interface BundleInput {
  /**
   * `process.execPath` — the Bun runtime inside the bundle, at
   * `Contents/MacOS/bun`. The sidecars are in `../Resources/app/bin` from
   * there: Electrobun's own SDKs find `Resources` the same way, as a sibling
   * of the executable's directory. It is the one fact the layout turns on.
   */
  execPath: string;
  env: Readonly<Record<string, string | undefined>>;
  /** Fixture mode keeps its log beside the real one, under its own name. */
  fixture: boolean;
}

export interface BundlePaths {
  /** `Contents/Resources/app/bin`: `hermetic`, `hermeticd`, the stamps and `stages/`. */
  binDir: string;
  /** The bootstrap stages, as `HERMETIC_STAGES` names them. */
  stagesDir: string;
  /** The node agent, as `HERMETIC_HERMETICD` names it. */
  hermeticd: string;
  /** `$HERMETIC_HOME`, or `~/.hermetic`. The same directory the CLI writes. */
  home: string;
  /** Where this process's log file goes, or null when there is nowhere to put one. */
  logPath: string | null;
}

/** The directory `execPath` is in, without `node:path`'s opinion about trailing slashes. */
function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
}

/**
 * `hermeticHome` in core reads `process.env` itself, which is exactly what this
 * module is avoiding, so the same rule is applied to the environment it was
 * handed. A `HERMETIC_HOME` of `""` is not a home: the shell's way of unsetting
 * a variable it already exported would otherwise resolve every path to the
 * process's cwd.
 */
export function homeFrom(env: BundleInput["env"]): string {
  const override = env["HERMETIC_HOME"];
  if (override !== undefined && override !== "") return override;
  return join(env["HOME"] ?? "", ".hermetic");
}

export function bundlePaths(input: BundleInput): BundlePaths {
  // `join` normalises the `..`, so the path core reports in an error is the
  // one an operator can paste into `ls`.
  const binDir = join(parentOf(input.execPath), "..", "Resources", "app", "bin");
  const home = homeFrom(input.env);
  return {
    binDir,
    stagesDir: join(binDir, "stages"),
    hermeticd: join(binDir, "hermeticd"),
    home,
    // The head's own log, decided in one place: `log.ts` owns the filename and
    // the `:memory:` case, and a second copy of that rule here would be the
    // copy that goes stale.
    logPath: logPathFor(home, input.fixture),
  };
}
