/**
 * `BoxHost`: the recording `FakeHost` plus just enough of a box to make
 * idempotency observable. dpkg knows what apt installed, the account exists
 * after `useradd`, a clone leaves a checkout, `curl -o` leaves a file — the
 * facts apply reads back before deciding whether to do a thing again. Only the
 * apply suite needs this; everything else runs on the plain recording host.
 */
import { createHash } from "node:crypto";
import { CHROME_ZIP_ROOT_DIR } from "@hermetic/core/schema";
import {
  HERMES_ACCOUNT,
  HERMES_ACCOUNT_HOME,
  HERMES_DASHBOARD_UNIT,
  HERMES_INSTALL_DIR,
} from "@hermetic/core/shared";
import { DATA_MOUNT } from "../src/disk.ts";
import { HERMES_HEALTH_URL } from "../src/heartbeat.ts";
import { uvRelease } from "../src/apply/hermes.ts";
import { PNPM_VERSION, pnpmRelease } from "../src/apply/node-web.ts";
import type { ExecOptions, ExecResult, FilesystemSample } from "../src/host.ts";
import { type FakeFile, FakeHost, fail, ok } from "./fake-host.ts";

const KEYRING_DIR = "/usr/share/keyrings";
const NODE_DIST = "https://nodejs.org/dist/";
const NODE_ARCHES = ["arm64", "x64"] as const;
/** apt options that take a separate value argument. */
const APT_VALUE_FLAGS = new Set(["-o", "-c", "-t", "--option", "--config-file", "--target-release"]);
/** Stands in for gzip's magic bytes, so `readBundleManifest` takes its tarball branch. */
const FAKE_TGZ_MARKER = "FAKE-TGZ\n";

/** A config bundle as this fake models one: the marker, then the manifest JSON `tar -C` writes back out. */
export function fakeConfigBundle(manifest: unknown): Uint8Array {
  return new TextEncoder().encode(FAKE_TGZ_MARKER + JSON.stringify(manifest, null, 2) + "\n");
}

/**
 * A stable 40-hex commit id for a ref, so `git rev-parse HEAD` answers like git
 * and a test asserting `HERMES_REVISION` can name the value it expects.
 */
export function fakeCommitSha(ref: string): string {
  return createHash("sha256").update(`commit:${ref}`).digest("hex").slice(0, 40);
}

const nodeTarball = (file: string): string => `node release tarball: ${file}\n`;

/**
 * The release files hermeticd pins by digest in source (uv, pnpm). A fake cannot
 * serve bytes with a given sha256, so it serves a marker naming the URL and
 * `sha256File` answers the pinned digest for it: "the server sent the pinned
 * bytes". A `curlBodies` override is real content, so its digest mismatches.
 */
const PINNED_RELEASES = new Map(
  (["arm64", "x64"] as const).flatMap((arch) =>
    [uvRelease(arch), pnpmRelease(arch)].map((r) => [r.url, r.sha256] as const),
  ),
);
const PINNED_BODY = /^pinned release: (\S+)\n$/;
/** What astral's unpinned installer left on a box born before uv was pinned. */
export const ASTRAL_UV_VERSION = "0.8.17";

/**
 * nodejs.org, modelled as the two files `ensureNode` fetches: a tarball, and a
 * `SHASUMS256.txt` whose digests are of the very bytes this fake serves — a
 * mismatch has to be asked for (`curlBodies`), which makes the check observable.
 */
function nodeDistBody(url: string): string | null {
  if (!url.startsWith(NODE_DIST)) return null;
  const file = url.slice(url.lastIndexOf("/") + 1);
  if (file !== "SHASUMS256.txt") return nodeTarball(file);
  const version = url.split("/").at(-2) ?? "";
  return (
    NODE_ARCHES.map((arch) => {
      const name = `node-${version}-linux-${arch}.tar.xz`;
      return `${createHash("sha256").update(nodeTarball(name)).digest("hex")}  ${name}`;
    }).join("\n") + "\n"
  );
}

/**
 * What `curl -o` leaves behind unscripted: under `/usr/share/keyrings` something
 * that passes for a binary keyring (an OpenPGP packet tag, then filler);
 * elsewhere a readable `fetched:<url>` marker.
 */
function stubBody(path: string, url: string): string | Uint8Array {
  if (PINNED_RELEASES.has(url)) return `pinned release: ${url}\n`;
  const node = nodeDistBody(url);
  if (node !== null) return node;
  if (!path.startsWith(KEYRING_DIR + "/")) return `fetched:${url}`;
  return new Uint8Array([0x99, 0x01, 0x0d, 0x04, ...new TextEncoder().encode(`fetched:${url}`)]);
}

function fetched(body: string | Uint8Array): FakeFile {
  return typeof body === "string"
    ? { content: body, mode: "0644" }
    : { content: new TextDecoder().decode(body), mode: "0644", bytes: body };
}

/** The value of whichever of `names` appears in `args`, spelled `--flag value`. */
function flagValue(args: readonly string[], names: readonly string[]): string | undefined {
  for (const name of names) {
    const at = args.indexOf(name);
    if (at !== -1) return args[at + 1];
  }
  return undefined;
}

const operands = (args: readonly string[]): string[] => args.filter((a) => !a.startsWith("-"));

/** What uv prints when the account tries to download a Python into root's install dir (the live failure). */
const uvDownloadDenied = (version: string): string =>
  `error: Failed to install cpython-${version}: Failed to create download directory\n` +
  "  Caused by: Permission denied (os error 13) at /usr/local/share/uv/python/.temp/fake";

/** An `apt-get` argv with its flags (and their values) removed: the verb, then packages. */
function aptOperands(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (APT_VALUE_FLAGS.has(arg)) i += 1;
    else if (!arg.startsWith("-")) out.push(arg);
  }
  return out;
}

/** A venv's `hermes`, tagged with the version its install resolved. */
const venvHermes = (version: string | null): string =>
  `#!/bin/sh\n# installed ${JSON.stringify(version)}\n`;

export class BoxHost extends FakeHost {
  /** A stopped unit reads back `inactive`, so a version change can verify its stop. */
  protected override readonly modelsUnitState = true;
  readonly installedPackages = new Set<string>();
  /** Tools a bare `command -v` resolves beyond apt's packages. */
  readonly availableCommands = new Set<string>();
  /** A uv already on `PATH` before hermeticd installed its own (astral's, say), by the version it reports. */
  uvVersion: string | null = null;
  /**
   * Minor versions in the root-owned `UV_PYTHON_INSTALL_DIR`. Root's `uv venv`
   * and `uv python install` download into it; the account's `uv venv` on a
   * version not in it fails as uv does, unable to write there.
   */
  readonly managedPythons = new Set<string>();
  /** Whether the command being run came under `runuser` (the account), not as root. */
  private asAccount = false;
  /** Accounts `id -u` resolves. `useradd`, in argv or a post-step script, adds one. */
  readonly users = new Set<string>(["root"]);
  /** Separate from users: `root:hermes` is an account from boot and a group a post-step creates. */
  readonly groups = new Set<string>(["root"]);
  /** Each account's home, field 6 of `getent passwd`; `useradd --home-dir` and `usermod --home` move it. */
  readonly userHomes = new Map<string, string>([["root", "/root"]]);
  /**
   * Each account's login shell, field 7 of `getent passwd`; `useradd --shell` and
   * `usermod --shell` set it. An account added without one reads back as
   * `/usr/sbin/nologin`, which is what a box created before `hermes` got a login
   * shell looks like.
   */
  readonly userShells = new Map<string, string>();
  /** URL → the bytes `curl -o` writes for it; unscripted fetches get `stubBody`. */
  readonly curlBodies = new Map<string, string | Uint8Array>();
  /** Upstream Hermes: ref → the version `hermes --version` prints once installed from it. */
  readonly hermesVersionByRef = new Map<string, string>([["v2026.8.31", "0.21.0"]]);
  hermesUnknownRefVersion = "0.0.0-unpinned";
  hermesInstalledVersion: string | null = null;
  /** What the checkout under `/usr/local/lib/hermes-agent` is currently on. */
  hermesCheckedOutRef: string | null = null;
  private hermesFetchedRef: string | null = null;
  /** Every ref the checkout has been on: their commits stay in the repository. */
  private readonly hermesSeenRefs = new Set<string>();
  /** A `--depth 1` clone, as opposed to one of the fleet's bundle: one commit either way, only one shallow. */
  private hermesShallow = false;
  /**
   * Refs whose checkout is upstream's v0.23 layout: `.python-version` 3.14, a
   * pnpm workspace, and a version that comes from the install stamp or a merged
   * tag. Every other ref is v0.21's: 3.11, npm, the version from `pyproject.toml`.
   */
  readonly hermesStampRefs = new Set<string>();
  /**
   * Whether the checked-out commit carries its tag. A clone keeps it; a fetch of
   * one ref into an existing repository stores none (B3), so a v0.23 checkout
   * reached by fetch has only the stamp to say what it is.
   */
  private hermesTagMerged = false;
  /** Whether a clone leaves a root `package-lock.json`, as upstream's does. */
  rootLockfile = true;
  /** Whether a clone leaves `web/` and `ui-tui/` at all. */
  hermesWeb = true;
  hermesTui = true;
  /**
   * The box's RAM in MB (`MemTotal`) for the web build's OOM model; `null` is a
   * box the build always fits, whose `memory()` is `FakeHost`'s 4 GiB.
   */
  memoryMb: number | null = null;
  /**
   * Whether `/data` is a filesystem of its own: `filesystem()` of a path under it
   * then names `/data` as its mount, sized as `filesystemResult` is.
   */
  dataMounted = true;
  /** `git config --system`: key → values in order; `safe.directory` is a list `--add` appends to. */
  readonly gitSystemConfig = new Map<string, string[]>();
  /** Every `pnpm` and `node scripts/build/node-deps.mjs` with the cwd and env it was given, in order. */
  readonly pnpmRuns: Array<{ argv: string[]; cwd: string | null; env: Record<string, string> }> = [];
  /** Every `npm` invocation with the cwd and env it was given, in order. */
  readonly npmRuns: Array<{ argv: string[]; cwd: string | null; env: Record<string, string> }> = [];
  /** Every `hermes gateway install` with the env it was given, in order. */
  readonly gatewayInstalls: Array<{ argv: string[]; env: Record<string, string> }> = [];

  /** A git bundle's content, as this fake models it: one line naming the ref its one tagged commit carries. */
  static bundleBytes(ref: string): Uint8Array {
    return new TextEncoder().encode(`hermes-bundle ${ref}\n`);
  }

  /** `useradd` without `--no-user-group` creates the matching group. */
  private addUser(who: string): void {
    this.users.add(who);
    this.groups.add(who);
  }

  override async exec(argv: readonly string[], opts?: ExecOptions): Promise<ExecResult> {
    this.asAccount = argv[0] === "runuser";
    return super.exec(argv, opts);
  }

  override async memory(): ReturnType<FakeHost["memory"]> {
    if (this.memoryMb === null) return super.memory();
    return { total: this.memoryMb * 1024 ** 2, available: (this.memoryMb - 480) * 1024 ** 2 };
  }

  override async filesystem(path: string): Promise<FilesystemSample | null> {
    const fs = await super.filesystem(path);
    const underData = path === DATA_MOUNT || path.startsWith(`${DATA_MOUNT}/`);
    if (fs === null || !this.dataMounted || !underData || this.filesystemByPath.has(path)) return fs;
    return { ...fs, mount: DATA_MOUNT };
  }

  /** Active swap in MB: the size column (KiB) of each `/proc/swaps` line after the header. */
  private swapMb(): number {
    const lines = (this.files.get("/proc/swaps")?.content ?? "").split("\n").slice(1);
    return lines.reduce((mb, l) => mb + Number(l.trim().split(/\s+/)[2] ?? 0) / 1024, 0);
  }

  /**
   * `fallocate -l 1G`, `mkswap`, `swapon`, `swapoff` on a swapfile, with
   * `/proc/swaps` as the record of what is active (`<path> file <KiB> 0 -2`).
   */
  private swapCommand(bin: string, args: readonly string[]): ExecResult {
    const path = args.at(-1) ?? "";
    const swaps = this.files.get("/proc/swaps")?.content ?? "Filename Type Size Used Priority\n";
    const listed = swaps.split("\n").some((l) => l.split(/\s+/)[0] === path);
    const file = this.files.get(path);
    if (bin === "fallocate") {
      if (!this.dirs.has(path.slice(0, path.lastIndexOf("/"))))
        return fail(1, `fallocate: cannot open ${path}: No such file or directory`);
      this.seed(path, `fallocated ${flagValue(args, ["-l"]) ?? "?"}\n`);
      return ok();
    }
    if (!file) return fail(1, `${bin}: cannot open ${path}: No such file or directory`);
    if (bin === "mkswap") {
      this.files.set(path, { ...file, content: `swap ${file.content}` });
      return ok();
    }
    if (bin === "swapon") {
      if (listed) return fail(1, `swapon: ${path}: swapon failed: Device or resource busy`);
      if (!file.content.startsWith("swap fallocated 1G"))
        return fail(1, `swapon: ${path}: read swap header failed`);
      this.seed("/proc/swaps", `${swaps}${path} file 1048572 0 -2\n`);
      return ok();
    }
    if (!listed) return fail(1, `swapoff: ${path}: swapoff failed: Invalid argument`);
    const kept = swaps.split("\n").filter((l) => l.split(/\s+/)[0] !== path);
    this.seed("/proc/swaps", kept.join("\n"));
    return ok();
  }

  protected override unitIsKnown(unit: string): boolean {
    if (super.unitIsKnown(unit)) return true;
    return unit === "nginx.service" && this.installedPackages.has("nginx");
  }

  protected override builtin(argv: readonly string[], opts?: ExecOptions): ExecResult {
    const [bin = "", ...args] = argv;
    switch (bin) {
      case "dpkg-query": {
        const wanted = operands(args);
        const lines = wanted
          .filter((p) => this.installedPackages.has(p))
          .map((p) => `${p} install ok installed`);
        return lines.length === wanted.length
          ? ok(lines.join("\n") + "\n")
          : { code: 1, stdout: lines.join("\n"), stderr: "no packages found" };
      }
      case "apt-get": {
        const [verb, ...pkgs] = aptOperands(args);
        if (verb === "install") for (const pkg of pkgs) this.installedPackages.add(pkg);
        return ok();
      }
      case "id": {
        const who = operands(args).at(-1) ?? "root";
        return this.users.has(who) ? ok("1000\n") : fail(1, `no such user: ${who}`);
      }
      case "getent": {
        const [db, name = ""] = args;
        if (db === "group") return this.groups.has(name) ? ok(`${name}:x:1000:\n`) : fail(2);
        if (!this.users.has(name)) return fail(2);
        const home = this.userHomes.get(name) ?? `/home/${name}`;
        const shell = this.userShells.get(name) ?? "/usr/sbin/nologin";
        return ok(`${name}:x:1000:1000::${home}:${shell}\n`);
      }
      case "useradd":
      case "usermod": {
        const who = operands(args).at(-1);
        const home = flagValue(args, ["--home-dir", "--home", "-d"]);
        if (who && bin === "useradd") this.addUser(who);
        const shell = flagValue(args, ["--shell", "-s"]);
        if (who && home) this.userHomes.set(who, home);
        if (who && shell) this.userShells.set(who, shell);
        return ok();
      }
      case "groupadd": {
        const who = operands(args).at(-1);
        if (who) this.groups.add(who);
        return ok();
      }
      case "install": {
        // `install -d [-m mode] [-o owner] [-g group] <dir>…` — so a `chown -R` over one is a walk.
        if (!args.includes("-d")) return ok();
        for (let i = 0; i < args.length; i += 1) {
          const arg = args[i] as string;
          if (arg === "-m" || arg === "-o" || arg === "-g") i += 1;
          else if (!arg.startsWith("-")) this.dirs.add(arg);
        }
        return ok();
      }
      case "chown": {
        const [ownership, path] = operands(args);
        if (!ownership || !path) return fail(1, "No such file or directory");
        if (args.includes("-R") && this.dirs.has(path)) {
          for (const [p, f] of this.files)
            if (p.startsWith(`${path}/`)) this.files.set(p, { ...f, ownership });
          return ok();
        }
        const file = this.files.get(path);
        if (!file) return fail(1, "No such file or directory");
        this.files.set(path, { ...file, ownership });
        return ok();
      }
      case "stat": {
        const file = this.files.get(args.at(-1) ?? "");
        return file ? ok((file.ownership ?? "root:root") + "\n") : fail(1, "No such file or directory");
      }
      case "chmod": {
        const [mode, path] = operands(args);
        const file = path === undefined ? undefined : this.files.get(path);
        if (!mode || !path || !file) return fail(1, "No such file or directory");
        this.chmods.push([path, mode]);
        this.files.set(path, { ...file, mode });
        return ok();
      }
      case "ln": {
        // `ln -sfn target link`: the link reads back as the target, which is how `stat` sees it.
        const [target, link] = operands(args);
        const file = target === undefined ? undefined : this.files.get(target);
        if (!file || !link) return fail(1, `no such file: ${String(target)}`);
        this.files.set(link, { ...file });
        return ok();
      }
      case "curl": {
        const path = flagValue(args, ["-o"]);
        const url = args.at(-1) ?? "";
        // The dashboard's `/api/health`: answered while it runs, with the version its Hermes reports.
        if (url === HERMES_HEALTH_URL && path === undefined) {
          const version = this.reportedHermesVersion();
          return this.runningUnits.has(HERMES_DASHBOARD_UNIT) && version !== null
            ? ok(`${JSON.stringify({ ok: true, version })}\n`)
            : fail(7, "curl: (7) Failed to connect to 127.0.0.1");
        }
        if (path) this.files.set(path, fetched(this.curlBodies.get(url) ?? stubBody(path, url)));
        return ok();
      }
      case "fallocate":
      case "mkswap":
      case "swapon":
      case "swapoff":
        return this.swapCommand(bin, args);
      case "/bin/sh":
        return this.sh(args[1] ?? "");
      case "git":
        return this.git(args);
      case "uv":
        return this.uv(args, opts);
      case "npm":
        return this.npm(argv, args, opts);
      case "pnpm":
      case "node":
        return this.pnpm(argv, args, opts);
      case "tar":
        return this.tar(args);
      case "unzip": {
        // A Chrome for Testing build: a single `chrome-linux-arm64/` at the zip's root.
        const dest = flagValue(args, ["-d"]);
        const archive = args.find((a) => a.endsWith(".zip")) ?? "";
        if (!dest || !this.files.has(archive)) return fail(9, `cannot find or open ${archive}`);
        this.dirs.add(dest);
        this.dirs.add(`${dest}/${CHROME_ZIP_ROOT_DIR}`);
        this.files.set(`${dest}/${CHROME_ZIP_ROOT_DIR}/chrome`, {
          content: "ELF-chrome\n",
          mode: "0755",
        });
        return ok();
      }
      default:
        break;
    }
    // An unpacked Node reports the version its tarball was named for; one never unpacked is not there.
    if (bin.endsWith("/bin/node") && args[0] === "--version") {
      const file = this.files.get(bin);
      return file ? ok(file.content) : fail(127, "no such file or directory");
    }
    if (bin.endsWith("/hermes") && args[0] === "gateway" && args[1] === "install") {
      return this.gatewayInstall(argv, opts);
    }
    if (bin.endsWith("/pnpm") && args[0] === "--version") {
      const file = this.files.get(bin);
      return file ? ok(file.content) : fail(127, "no such file or directory");
    }
    if (bin.endsWith("/hermes") && args[0] === "--version") {
      // The real banner: apply substring-matches the version out of it.
      const version = this.reportedHermesVersion();
      return version
        ? ok(`Hermes Agent v${version} (2026-08-31) · upstream deadbeef\n`)
        : fail(1, "hermes: command not found");
    }
    return super.builtin(argv, opts);
  }

  /**
   * What `hermes --version` prints. A v0.21 checkout reports what its install
   * resolved; a v0.23 one asks the install stamp first (ignored unless its
   * `commit` is `HEAD`), then a merged tag, and failing both says `git.<sha7>`
   * (`hermes_cli/version_info.py`).
   */
  private reportedHermesVersion(): string | null {
    if (this.hermesInstalledVersion === null || this.hermesCheckedOutRef === null) {
      return this.hermesInstalledVersion;
    }
    if (!this.hermesStampRefs.has(this.hermesCheckedOutRef)) return this.hermesInstalledVersion;
    const head = fakeCommitSha(this.hermesCheckedOutRef);
    const raw = this.files.get(`${HERMES_INSTALL_DIR}/install-stamp.json`)?.content;
    const stamp =
      raw === undefined ? null : (JSON.parse(raw) as { commit?: string; displayVersion?: string });
    if (stamp?.commit === head && stamp.displayVersion) return stamp.displayVersion;
    return this.hermesTagMerged ? this.hermesInstalledVersion : `git.${head.slice(0, 7)}`;
  }

  /**
   * The installed Hermes lives in the venv: moving the venv away takes it, and
   * moving one back brings back the version it was installed at.
   */
  override async rename(path: string, to: string): Promise<void> {
    const venv = `${HERMES_INSTALL_DIR}/venv`;
    await super.rename(path, to);
    if (path === venv) this.hermesInstalledVersion = null;
    if (to === venv) {
      const tag = /^# installed (.*)$/m.exec(this.files.get(`${venv}/bin/hermes`)?.content ?? "")?.[1];
      this.hermesInstalledVersion = tag === undefined ? null : (JSON.parse(tag) as string | null);
    }
  }

  /** `sha256File`, except a pinned release this fake served hashes to its pinned digest. */
  override async sha256File(path: string): Promise<string | null> {
    const real = await super.sha256File(path);
    const url = PINNED_BODY.exec(this.files.get(path)?.content ?? "")?.[1];
    return (url === undefined ? undefined : PINNED_RELEASES.get(url)) ?? real;
  }

  /** The shell one-liners apply runs: post-steps that create accounts, `command -v`, `ls <glob>`. */
  private sh(script: string): ExecResult {
    const created = /\buseradd\b([^;&|]*)/.exec(script)?.[1]?.trim().split(/\s+/).at(-1);
    if (created && !created.startsWith("-")) this.addUser(created);
    const group = /\bgroupadd\b([^;&|]*)/.exec(script)?.[1]?.trim().split(/\s+/).at(-1);
    if (group && !group.startsWith("-")) this.groups.add(group);
    if (script.startsWith("command -v ")) {
      const tool = script.slice("command -v ".length).trim();
      const uv = tool === "uv" && this.uvVersion !== null;
      if (this.availableCommands.has(tool) || uv || this.files.has(`/usr/local/bin/${tool}`)) {
        return ok(`/usr/local/bin/${tool}\n`);
      }
      return this.installedPackages.has(tool) || this.files.has(`/usr/bin/${tool}`)
        ? ok(`/usr/bin/${tool}\n`)
        : fail(1);
    }
    // astral's installer really does leave a uv on PATH: whatever version was current that day.
    if (script.includes("astral.sh/uv/install.sh")) {
      this.availableCommands.add("uv");
      this.uvVersion ??= ASTRAL_UV_VERSION;
    }
    if (script === "uv --version") {
      // hermeticd's own uv, once linked, shadows whatever was on PATH before it.
      const linked = this.files.get("/usr/local/bin/uv")?.content;
      if (linked !== undefined) return ok(linked);
      return this.uvVersion === null ? fail(127, "uv: not found") : ok(`uv ${this.uvVersion}\n`);
    }
    // `ls <glob> 2>/dev/null`: `ensureGatewayUnit` asks what upstream actually wrote.
    const pattern = /^ls\s+(\S+)(?:\s+2>\/dev\/null)?$/.exec(script.trim())?.[1];
    if (pattern) {
      const re = new RegExp(
        `^${pattern
          .split("*")
          .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join("[^/]*")}$`,
      );
      const listed = [...this.files.keys()].filter((path) => re.test(path)).sort();
      return listed.length === 0 ? fail(2) : ok(listed.join("\n") + "\n");
    }
    return ok();
  }

  /** The ref a staged bundle carries, or `null` when the path is not one this fake wrote. */
  private bundleRef(path: string): string | null {
    return /^hermes-bundle (\S+)/.exec(this.files.get(path)?.content ?? "")?.[1] ?? null;
  }

  /** The tree a clone leaves: upstream's layout, one root lockfile, `web/` and `ui-tui/` unbuilt. */
  private hermesCheckout(dir: string, ref: string): void {
    this.dirs.add(dir);
    this.dirs.add(`${dir}/.git`);
    this.seed(`${dir}/.git/HEAD`, `ref: ${ref}\n`);
    this.seed(`${dir}/package.json`, '{"workspaces":["ui-tui","web"]}\n');
    this.hermesTree(dir, ref);
    if (this.hermesWeb) {
      this.dirs.add(`${dir}/web`);
      this.seed(`${dir}/web/package.json`, '{"name":"web"}\n');
    }
    if (this.hermesTui) {
      this.dirs.add(`${dir}/ui-tui`);
      this.seed(`${dir}/ui-tui/package.json`, '{"name":"hermes-tui"}\n');
    }
  }

  /** The tracked files that differ between v0.21's layout and v0.23's; a checkout rewrites them. */
  private hermesTree(dir: string, ref: string): void {
    this.hermesCheckedOutRef = ref;
    this.hermesSeenRefs.add(ref);
    for (const [path, content] of Object.entries(this.hermesTreeFiles(ref))) {
      if (content !== null) this.seed(`${dir}/${path}`, content);
      else this.files.delete(`${dir}/${path}`);
    }
  }

  /** The layout-dependent tracked files at `ref`; `null` is absent from its tree. */
  private hermesTreeFiles(ref: string): Record<string, string | null> {
    const v023 = this.hermesStampRefs.has(ref);
    return {
      ".python-version": v023 ? "3.14\n" : "3.11\n",
      // v0.21 reports this version; v0.23 its install stamp, its pyproject a placeholder.
      "pyproject.toml": v023
        ? '[project]\nversion = "0.0.0"\n'
        : `[project]\nversion = "${this.hermesVersionByRef.get(ref) ?? this.hermesUnknownRefVersion}"\n`,
      "package-lock.json": !v023 && this.rootLockfile ? '{"lockfileVersion":3}\n' : null,
      "pnpm-lock.yaml": v023 ? "lockfileVersion: '9.0'\n" : null,
      "uv.lock": v023 ? "version = 1\nrevision = 5\n" : null,
      "hermes_cli/version_info.py": v023 ? "# reads install-stamp.json\n" : null,
    };
  }

  /** `<commit>:<path>` for a commit this repository holds: the file at that ref, or `null`. */
  private hermesBlob(spec: string | undefined): string | null {
    const [commit = "", path = ""] = (spec ?? "").split(":");
    const ref = [...this.hermesSeenRefs].find((r) => fakeCommitSha(r) === commit);
    return ref === undefined ? null : (this.hermesTreeFiles(ref)[path] ?? null);
  }

  /** Just enough git for apply: clone at a ref (upstream URL or staged bundle), fetch/detach, rev-parse, system config. */
  private git(args: readonly string[]): ExecResult {
    const dir = args[0] === "-C" ? args[1] : args.at(-1);
    const verb = args[0] === "-C" ? args[2] : args[0];
    if (!dir) return fail(1, "no repository");
    const bundle = args.find((a) => a.endsWith(".bundle"));
    if (verb === "config" && args.includes("--system")) {
      const get = args.indexOf("--get-all");
      if (get !== -1) {
        const values = this.gitSystemConfig.get(args[get + 1] ?? "") ?? [];
        return values.length === 0 ? fail(1) : ok(values.join("\n") + "\n");
      }
      const add = args.indexOf("--add");
      if (add !== -1) {
        const [key, value] = args.slice(add + 1);
        if (!key || value === undefined) return fail(129, "wrong number of arguments");
        this.gitSystemConfig.set(key, [...(this.gitSystemConfig.get(key) ?? []), value]);
      }
      return ok();
    }
    if (verb === "rev-parse") {
      if (this.hermesCheckedOutRef === null) return fail(128, "not a git repository");
      if (args.at(-1) === "HEAD") return ok(fakeCommitSha(this.hermesCheckedOutRef) + "\n");
      if (args.at(-1) === "--is-shallow-repository") return ok(String(this.hermesShallow) + "\n");
      if (args.at(-1) === "FETCH_HEAD^{commit}") {
        return this.hermesFetchedRef === null
          ? fail(128, "ambiguous argument 'FETCH_HEAD^{commit}'")
          : ok(fakeCommitSha(this.hermesFetchedRef) + "\n");
      }
      return ok();
    }
    if (verb === "show" || verb === "cat-file") {
      const blob = this.hermesBlob(args.at(-1));
      if (blob === null) return fail(128, `path does not exist in ${String(args.at(-1))}`);
      return ok(verb === "show" ? blob : "");
    }
    if (verb === "clone") {
      // A bundle names its own ref (a tag on its one commit), so `--branch` is not passed on that path.
      const ref = bundle ? this.bundleRef(bundle) : args[args.indexOf("--branch") + 1];
      if (!ref) return fail(128, bundle ? `'${bundle}' does not look like a v2 bundle` : "no ref");
      this.hermesShallow = !bundle && args.includes("--depth");
      this.hermesTagMerged = true;
      this.hermesCheckout(dir, ref);
      return ok();
    }
    if (verb === "fetch") {
      if (!this.files.has(`${dir}/.git/HEAD`)) return fail(128, "not a git repository");
      if (bundle && this.bundleRef(bundle) === null) return fail(128, `could not read ${bundle}`);
      if (bundle) this.hermesShallow = false; // a bundle fetch brings whole history
      this.hermesFetchedRef = args.at(-1) ?? null;
      // A fetch stores the commit: a later checkout of it needs no network.
      if (this.hermesFetchedRef !== null) this.hermesSeenRefs.add(this.hermesFetchedRef);
      return ok();
    }
    if (verb === "checkout" && args.at(-1) !== "FETCH_HEAD") {
      // A commit this repository already holds: no fetch, no network.
      const ref = [...this.hermesSeenRefs].find((r) => fakeCommitSha(r) === args.at(-1));
      if (ref === undefined) return fail(128, `reference is not a tree: ${String(args.at(-1))}`);
      this.hermesTagMerged = false;
      this.hermesTree(dir, ref);
      return ok();
    }
    if (verb === "checkout") {
      if (this.hermesFetchedRef === null) return fail(1, "FETCH_HEAD does not exist");
      this.hermesTagMerged = false;
      this.hermesTree(dir, this.hermesFetchedRef);
      this.hermesFetchedRef = null;
    }
    return ok();
  }

  /**
   * `uv venv` makes an interpreter; `uv pip install -e` (v0.21) or `uv sync` from
   * the checkout (v0.23) makes a `hermes`. On a 3.14 checkout the editable pip
   * install resolves the extras and no core dependency (B1), so its `hermes`
   * cannot even report a version.
   */
  private uv(args: readonly string[], opts?: ExecOptions): ExecResult {
    if (args[0] === "python") {
      const version = args.at(-1) ?? "";
      if (args[1] === "find") {
        return this.managedPythons.has(version) ? ok(`/x/python${version}\n`) : fail(2);
      }
      if (args[1] === "install") {
        if (this.asAccount) return fail(2, uvDownloadDenied(version));
        this.managedPythons.add(version);
      }
      return ok();
    }
    if (args[0] === "venv") {
      const dir = args.at(-1);
      const python = flagValue(args, ["--python"]);
      if (!dir || !python) return fail(1, "no venv path");
      // A version (not an interpreter path) uv does not have is downloaded first.
      if (!python.startsWith("/") && !this.managedPythons.has(python)) {
        if (this.asAccount) return fail(2, uvDownloadDenied(python));
        this.managedPythons.add(python);
      }
      this.seed(`${dir}/bin/python`, "#!/bin/sh\n", "0755");
      this.seed(`${dir}/pyvenv.cfg`, `implementation = CPython\nversion_info = ${python}.0\n`);
      return ok();
    }
    if (args[0] === "sync") {
      const dir = opts?.cwd ?? "";
      const venv = opts?.env?.["UV_PROJECT_ENVIRONMENT"] ?? `${dir}/.venv`;
      if (!this.files.has(`${dir}/uv.lock`)) return fail(2, `no uv.lock in ${dir}`);
      if (!args.includes("--frozen")) return fail(2, "the lock would be rewritten");
      const pin = this.files.get(`${dir}/.python-version`)?.content.trim() ?? "";
      if (!this.files.get(`${venv}/pyvenv.cfg`)?.content.includes(`version_info = ${pin}.`)) {
        return fail(2, `${venv} is not on python ${pin}`);
      }
      this.hermesInstalledVersion =
        (this.hermesCheckedOutRef === null
          ? null
          : this.hermesVersionByRef.get(this.hermesCheckedOutRef)) ?? this.hermesUnknownRefVersion;
      this.seed(`${venv}/bin/hermes`, venvHermes(this.hermesInstalledVersion), "0755");
      return ok();
    }
    if (args[0] === "pip" && args[1] === "install") {
      const editable = args[args.indexOf("-e") + 1] ?? "";
      const extrasStart = editable.indexOf("[");
      const dir =
        extrasStart >= 0 && editable.endsWith("]") ? editable.slice(0, extrasStart) : editable;
      if (!this.files.has(`${dir}/.git/HEAD`)) return fail(1, `no checkout at ${dir}`);
      if (!this.files.has(`${dir}/venv/bin/python`)) return fail(1, `no venv at ${dir}/venv`);
      const ref = this.hermesCheckedOutRef;
      this.hermesInstalledVersion =
        ref !== null && this.hermesStampRefs.has(ref)
          ? null
          : ((ref === null ? null : this.hermesVersionByRef.get(ref)) ?? this.hermesUnknownRefVersion);
      this.seed(`${dir}/venv/bin/hermes`, venvHermes(this.hermesInstalledVersion), "0755");
    }
    return ok();
  }

  /**
   * `npm run build` leaves a bundle where Vite's `outDir` puts it — `../hermes_cli/web_dist`,
   * never `web/dist` — and the TUI's esbuild step writes `ui-tui/dist/entry.js`, both
   * relative to the checkout root the command runs from.
   */
  private npm(argv: readonly string[], args: readonly string[], opts?: ExecOptions): ExecResult {
    if (args[0] === "run" && args[1] === "build" && opts?.cwd) {
      const workspace = args[args.indexOf("--workspace") + 1];
      if (workspace === "web")
        this.seed(`${opts.cwd}/hermes_cli/web_dist/index.html`, "<!doctype html>\n");
      if (workspace === "ui-tui")
        this.seed(`${opts.cwd}/ui-tui/dist/entry.js`, "#!/usr/bin/env node\n");
    }
    if ((args[0] === "ci" || args[0] === "install") && opts?.cwd) {
      this.seed(`${opts.cwd}/node_modules/.package-lock.json`, "{}\n");
    }
    this.npmRuns.push({ argv: [...argv], cwd: opts?.cwd ?? null, env: { ...(opts?.env ?? {}) } });
    return ok();
  }

  /**
   * `node scripts/build/node-deps.mjs` is upstream's pnpm install: it needs the
   * pinned pnpm on `PATH` and refuses a `node_modules` npm left (pnpm asks
   * before removing one, and nobody answers). `pnpm --filter <w> run build`
   * then writes what `npm run build` did, and only over installed dependencies.
   */
  private pnpm(argv: readonly string[], args: readonly string[], opts?: ExecOptions): ExecResult {
    const cwd = opts?.cwd ?? "";
    this.pnpmRuns.push({ argv: [...argv], cwd: opts?.cwd ?? null, env: { ...(opts?.env ?? {}) } });
    if (argv[0] === "node") {
      if (args[0] !== "scripts/build/node-deps.mjs") return ok();
      if (this.files.get("/usr/local/bin/pnpm")?.content.trim() !== PNPM_VERSION) {
        return fail(1, `pnpm ${PNPM_VERSION} is required (pm/lock.json)`);
      }
      const modules = [...this.files.keys()].filter((p) => p.startsWith(`${cwd}/node_modules/`));
      if (modules.length > 0 && !this.files.has(`${cwd}/node_modules/.modules.yaml`)) {
        return fail(1, "ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY");
      }
      this.seed(`${cwd}/node_modules/.modules.yaml`, "layoutVersion: 5\n");
      return ok();
    }
    if (args.includes("build")) {
      if (!this.files.has(`${cwd}/node_modules/.modules.yaml`)) return fail(1, "vite: not found");
      const workspace = flagValue(args, ["--filter"]);
      // v0.23.1 `scripts/build/web.mjs` typechecks and bundles in one process: the V8 heap
      // (4096 MB with no cgroup limit and no `--max-old-space-size` in NODE_OPTIONS), plus
      // ~400 MB of young generation and Rolldown's native memory. On a t4g.small (1834 MB,
      // no swap, Hermes and the browser stopped) the kernel, slab and resident services
      // hold ~480 MB, so one process gets ~1350 MB, and the live build was OOM-killed at
      // 1278 MB rss still growing (qa23-a, 2026-11-17). Its peak varies run to run; this
      // models the worst. A headed Chrome left running holds ~400 MB more (419 MB in its
      // cgroup, live); active swap adds its size.
      const cap = /--max-old-space-size=(\d+)/.exec(opts?.env?.["NODE_OPTIONS"] ?? "")?.[1];
      const chrome = [...this.runningUnits].some((u) => u.startsWith("hermetic-browser@")) ? 400 : 0;
      const room = (this.memoryMb ?? 0) - 480 - chrome + this.swapMb();
      if (workspace === "web" && this.memoryMb !== null && Number(cap ?? 4096) + 400 > room) {
        return fail(137, "Killed");
      }
      if (workspace === "web") this.seed(`${cwd}/hermes_cli/web_dist/index.html`, "<!doctype html>\n");
      if (workspace === "hermes-tui") this.seed(`${cwd}/ui-tui/dist/entry.js`, "#!/usr/bin/env node\n");
    }
    return ok();
  }

  /**
   * Archives that get unpacked: an agent's config bundle (`.tgz`), a Node release
   * (`.tar.xz`), and the pinned uv and pnpm releases (served as markers).
   */
  private tar(args: readonly string[]): ExecResult {
    const dest = flagValue(args, ["-C"]);
    const gz = args.find((a) => /\.(tgz|tar\.gz)$/.test(a)) ?? "";
    const released = PINNED_BODY.exec(this.files.get(gz)?.content ?? "")?.[1];
    if (dest && released) {
      const uv = /\/download\/([^/]+)\/(uv-[^/]+)\.tar\.gz$/.exec(released);
      if (uv) {
        for (const tool of ["uv", "uvx"])
          this.seed(`${dest}/${uv[2]}/${tool}`, `${tool} ${uv[1]}\n`, "0755");
      }
      const pnpm = /-(\d+\.\d+\.\d+)\.tgz$/.exec(released);
      if (pnpm) {
        this.seed(`${dest}/pnpm`, `${pnpm[1]}\n`, "0755");
        this.seed(`${dest}/package.json`, `{"name":"@pnpm/exe","version":"${pnpm[1]}"}\n`);
      }
      return ok();
    }
    const bundle = args.find((a) => a.endsWith(".tgz"));
    if (dest && bundle) {
      // `manifest.json` is the only member any code path reads back (`fakeConfigBundle` builds the bytes).
      const packed = this.files.get(bundle);
      if (!packed) return fail(2, `${bundle}: No such file or directory`);
      if (!packed.content.startsWith(FAKE_TGZ_MARKER)) return fail(2, `${bundle}: not in gzip format`);
      this.dirs.add(dest);
      this.seed(`${dest}/manifest.json`, packed.content.slice(FAKE_TGZ_MARKER.length));
      return ok();
    }
    const archive = args.find((a) => a.endsWith(".tar.xz")) ?? "";
    const named = /(node-v(\d+\.\d+\.\d+)-linux-(?:arm64|x64))\.tar\.xz$/.exec(archive);
    if (dest && named) {
      const dir = `${dest}/${named[1]}`;
      this.dirs.add(dir);
      this.dirs.add(`${dir}/bin`);
      for (const tool of ["node", "npm", "npx"])
        this.seed(`${dir}/bin/${tool}`, `v${named[2]}\n`, "0755");
    }
    return ok();
  }

  /**
   * `hermes gateway install --system` — upstream's own installer, modelled as the
   * one thing apply can observe: a plausible unit file appears, so a test can
   * assert hermetic never *wrote* it. Upstream's own `daemon-reload`/`enable`
   * are not modelled: those records are how the suite asserts what hermeticd did.
   *
   * The unit's name is upstream's `_profile_suffix()`: bare when `HERMES_HOME` is
   * a "native" home, else `-<sha256(HERMES_HOME)[:8]>`. v0.21 calls `$HOME/.hermes`
   * native; v0.23 calls the invoking uid's passwd home native (root's `/root`,
   * whatever `HOME` says), plus `SUDO_USER`'s (`hermes_constants.py:72-96,144-160`).
   */
  private gatewayInstall(argv: readonly string[], opts?: ExecOptions): ExecResult {
    const env = { ...(opts?.env ?? {}) };
    this.gatewayInstalls.push({ argv: [...argv], env });
    const home = env["HERMES_HOME"] ?? "/root/.hermes";
    const v023 =
      this.hermesCheckedOutRef !== null && this.hermesStampRefs.has(this.hermesCheckedOutRef);
    const sudoUser = env["SUDO_USER"] === HERMES_ACCOUNT ? HERMES_ACCOUNT_HOME : null;
    const native = v023
      ? ["/root/.hermes", ...(sudoUser === null ? [] : [`${sudoUser}/.hermes`])]
      : [`${env["HOME"] ?? "/root"}/.hermes`];
    const suffix = native.includes(home)
      ? ""
      : `-${createHash("sha256").update(home).digest("hex").slice(0, 8)}`;
    this.seed(
      `/etc/systemd/system/hermes-gateway${suffix}.service`,
      [
        "[Unit]",
        "Description=Hermes Gateway",
        "After=network-online.target user@998.service",
        "",
        "[Service]",
        "User=hermes",
        "Group=hermes",
        "Environment=HOME=/data/hermes",
        "Environment=HERMES_HOME=/data/hermes/.hermes",
        "WorkingDirectory=/data/hermes/.hermes",
        "ExecStart=/usr/local/lib/hermes-agent/venv/bin/python -m hermes_cli.main gateway run",
        "Restart=always",
        "",
        "[Install]",
        "WantedBy=multi-user.target",
        "",
      ].join("\n"),
    );
    return ok();
  }
}
