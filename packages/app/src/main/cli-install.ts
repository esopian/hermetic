/**
 * "Install Command Line Tool…".
 *
 * What lands in `/usr/local/bin/hermetic` is a two-line shell script, not a
 * symlink. `hermetic` resolves its sidecars — `hermeticd`, the stages, the
 * version stamps — relative to `process.execPath`, and a symlink would leave
 * `execPath` pointing at `/usr/local/bin`, where none of them are. The shim
 * `exec`s the real binary inside the bundle, so the CLI run from a terminal
 * sees exactly the layout `main/paths.ts` describes.
 *
 * Every side effect arrives as an argument. Writing to `/usr/local/bin` needs
 * a real `/usr/local/bin`, and the elevated retry is a GUI password prompt, so
 * neither can be exercised in a test that owns its own outcome; `write` and
 * `spawn` are injected and the tests hand it a temporary directory and a fake.
 */
import { HermeticError } from "@hermetic/core";
import type { AppLog } from "../log.ts";

/** Where `which hermetic` is expected to find it, and what the menu item promises. */
export const DEFAULT_CLI_TARGET = "/usr/local/bin/hermetic";

/** `0o755`: the operator's shell has to be able to execute what was just installed. */
export const SHIM_MODE = 0o755;

/**
 * What the shim `exec`s. Derived in one place because there are two writers of
 * it — the ordinary write and the authorised one — and the first version of
 * this module had them disagree: one wrote the binary, the other wrote the
 * directory it is in, which `exec`s to nothing. Both call this.
 */
export function cliBinaryPath(binDir: string): string {
  return `${binDir}/hermetic`;
}

/**
 * The bytes, and nothing else, so the test that pins them does not have to
 * reach through a filesystem to read them back.
 */
export function shimContent(binDir: string): string {
  return `#!/bin/sh\nexec "${cliBinaryPath(binDir)}" "$@"\n`;
}

export interface CliInstallDeps {
  /** The bundle's `bin/` — `BundlePaths.binDir`. The shim points into it. */
  bundleBin: string;
  /** Defaults to `DEFAULT_CLI_TARGET`; tests point it at a temporary directory. */
  target?: string;
  write(path: string, content: string, mode: number): void | Promise<void>;
  /** Runs an argv and reports how it ended. Only ever asked to run `osascript`. */
  spawn(argv: string[]): Promise<{ exitCode: number }>;
  log: Pick<AppLog, "line">;
}

export interface CliInstallResult {
  path: string;
  /** True when the unprivileged write was refused and the password prompt answered it. */
  elevated: boolean;
}

/** A mounted disk image. Segment-aware: a bundle at `/Volumes2/…` is not on one. */
function onMountedVolume(path: string): boolean {
  return path === "/Volumes" || path.startsWith("/Volumes/");
}

/**
 * `errno` off an unknown throw. Node's filesystem errors carry it; a thrown
 * string or a plain `Error` does not, and either means "not a permission
 * problem", which is the only question being asked.
 */
function errnoOf(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null || !("code" in e)) return undefined;
  const code = (e as { code: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Both are "you may not write here" on macOS: `EACCES` is the ordinary
 * unwritable `/usr/local/bin`, `EPERM` is what a directory under SIP or an
 * immutable flag answers. They lead to the same remedy — ask for the password
 * once — so they are treated as one condition rather than two.
 */
function isPermissionDenied(e: unknown): boolean {
  const code = errnoOf(e);
  return code === "EACCES" || code === "EPERM";
}

/** Single-quoted for `/bin/sh`, safe for a path with spaces, quotes or `$`. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Double-quoted for AppleScript: backslashes first, then the quotes. */
function appleScriptQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * The elevated write, as one shell command.
 *
 * `printf` with a `%s` argument rather than a heredoc: the bundle path is the
 * only variable part and it goes through single quotes, so a path containing a
 * space, a quote or a `$` cannot become another word or another command. The
 * newlines stay as `\n` escapes for `printf` to expand, which keeps the whole
 * script a single line and keeps the AppleScript literal a single line with it.
 *
 * Nothing but paths is interpolated. There is no user data in this argv.
 */
export function elevatedArgv(bundleBin: string, target: string): string[] {
  const script =
    `printf '#!/bin/sh\\nexec "%s" "$@"\\n' ${shellQuote(cliBinaryPath(bundleBin))} ` +
    `> ${shellQuote(target)} ` +
    `&& chmod 755 ${shellQuote(target)}`;
  return [
    "osascript",
    "-e",
    `do shell script ${appleScriptQuote(script)} with administrator privileges`,
  ];
}

export async function installCli(deps: CliInstallDeps): Promise<CliInstallResult> {
  const target = deps.target ?? DEFAULT_CLI_TARGET;

  // The app is running from the mounted disk image. A shim written now would
  // point at a path that stops existing the moment the operator ejects it, and
  // it would keep reporting success until the day they tried to use it.
  if (onMountedVolume(deps.bundleBin)) {
    throw new HermeticError(
      "UNSUPPORTED",
      "Hermetic is running from a mounted disk image, so a command line tool installed now " +
        "would point at a path that disappears on eject. Drag Hermetic to /Applications, " +
        "open it from there, and install the command line tool again.",
    );
  }

  const content = shimContent(deps.bundleBin);

  try {
    await deps.write(target, content, SHIM_MODE);
    deps.log.line("info", "cli-install", "installed command line tool", { target });
    return { path: target, elevated: false };
  } catch (e) {
    if (!isPermissionDenied(e)) throw e;
    deps.log.line("info", "cli-install", "target not writable, asking for authorisation", {
      target,
    });
  }

  // Exactly one retry. A second refusal is the operator declining the prompt or
  // a directory nothing can write; asking again would only ask again.
  const result = await deps.spawn(elevatedArgv(deps.bundleBin, target));
  if (result.exitCode !== 0) {
    deps.log.line("warn", "cli-install", "authorised write refused", {
      target,
      exit_code: result.exitCode,
    });
    throw new HermeticError(
      "FORBIDDEN",
      `Could not write ${target}, even with administrator privileges. ` +
        `Create the directory and make it writable, then install the command line tool again.`,
    );
  }

  deps.log.line("info", "cli-install", "installed command line tool", { target, elevated: true });
  return { path: target, elevated: true };
}
