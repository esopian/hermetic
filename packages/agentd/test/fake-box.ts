/**
 * `BoxHost`: the recording `FakeHost` plus just enough of a box to make
 * idempotency observable. dpkg knows what apt installed, the account exists
 * after `useradd`, a clone leaves a checkout, `curl -o` leaves a file — the
 * facts apply reads back before deciding whether to do a thing again. Only the
 * apply suite needs this; everything else runs on the plain recording host.
 */
import { createHash } from "node:crypto";
import { CHROME_ZIP_ROOT_DIR } from "@hermetic/core/schema";
import type { ExecOptions, ExecResult } from "../src/host.ts";
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

export class BoxHost extends FakeHost {
  readonly installedPackages = new Set<string>();
  /** Tools a bare `command -v` resolves beyond apt's packages, e.g. an installed uv. */
  readonly availableCommands = new Set<string>();
  /** Accounts `id -u` resolves. `useradd`, in argv or a post-step script, adds one. */
  readonly users = new Set<string>(["root"]);
  /** Separate from users: `root:hermes` is an account from boot and a group a post-step creates. */
  readonly groups = new Set<string>(["root"]);
  /** Each account's home, field 6 of `getent passwd`; `useradd --home-dir` and `usermod --home` move it. */
  readonly userHomes = new Map<string, string>([["root", "/root"]]);
  /** URL → the bytes `curl -o` writes for it; unscripted fetches get `stubBody`. */
  readonly curlBodies = new Map<string, string | Uint8Array>();
  /** Upstream Hermes: ref → the version `hermes --version` prints once installed from it. */
  readonly hermesVersionByRef = new Map<string, string>([["v2026.8.31", "0.21.0"]]);
  hermesUnknownRefVersion = "0.0.0-unpinned";
  hermesInstalledVersion: string | null = null;
  /** What the checkout under `/usr/local/lib/hermes-agent` is currently on. */
  hermesCheckedOutRef: string | null = null;
  private hermesFetchedRef: string | null = null;
  /** A `--depth 1` clone, as opposed to one of the fleet's bundle: one commit either way, only one shallow. */
  private hermesShallow = false;
  /** Whether a clone leaves a root `package-lock.json`, as upstream's does. */
  rootLockfile = true;
  /** Whether a clone leaves `web/` and `ui-tui/` at all. */
  hermesWeb = true;
  hermesTui = true;
  /** `git config --system`: key → values in order; `safe.directory` is a list `--add` appends to. */
  readonly gitSystemConfig = new Map<string, string[]>();
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
        return ok(`${name}:x:1000:1000::${home}:/usr/sbin/nologin\n`);
      }
      case "useradd":
      case "usermod": {
        const who = operands(args).at(-1);
        const home = flagValue(args, ["--home-dir", "--home", "-d"]);
        if (who && bin === "useradd") this.addUser(who);
        if (who && home) this.userHomes.set(who, home);
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
        if (path) this.files.set(path, fetched(this.curlBodies.get(url) ?? stubBody(path, url)));
        return ok();
      }
      case "/bin/sh":
        return this.sh(args[1] ?? "");
      case "git":
        return this.git(args);
      case "uv":
        return this.uv(args);
      case "npm":
        return this.npm(argv, args, opts);
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
    if (bin.endsWith("/hermes") && args[0] === "--version") {
      // The real banner: apply substring-matches the version out of it.
      return this.hermesInstalledVersion
        ? ok(`Hermes Agent v${this.hermesInstalledVersion} (2026-08-31) · upstream deadbeef\n`)
        : fail(1, "hermes: command not found");
    }
    return super.builtin(argv, opts);
  }

  /** The shell one-liners apply runs: post-steps that create accounts, `command -v`, `ls <glob>`. */
  private sh(script: string): ExecResult {
    const created = /\buseradd\b([^;&|]*)/.exec(script)?.[1]?.trim().split(/\s+/).at(-1);
    if (created && !created.startsWith("-")) this.addUser(created);
    const group = /\bgroupadd\b([^;&|]*)/.exec(script)?.[1]?.trim().split(/\s+/).at(-1);
    if (group && !group.startsWith("-")) this.groups.add(group);
    if (script.startsWith("command -v ")) {
      const tool = script.slice("command -v ".length).trim();
      if (this.availableCommands.has(tool)) return ok(`/usr/local/bin/${tool}\n`);
      return this.installedPackages.has(tool) || this.files.has(`/usr/bin/${tool}`)
        ? ok(`/usr/bin/${tool}\n`)
        : fail(1);
    }
    // astral's installer really does leave a uv on PATH.
    if (script.includes("astral.sh/uv/install.sh")) this.availableCommands.add("uv");
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
    this.hermesCheckedOutRef = ref;
    this.dirs.add(dir);
    this.dirs.add(`${dir}/.git`);
    this.seed(`${dir}/.git/HEAD`, `ref: ${ref}\n`);
    this.seed(`${dir}/pyproject.toml`, "[project]\n");
    this.seed(`${dir}/package.json`, '{"workspaces":["ui-tui","web"]}\n');
    if (this.rootLockfile) this.seed(`${dir}/package-lock.json`, '{"lockfileVersion":3}\n');
    if (this.hermesWeb) {
      this.dirs.add(`${dir}/web`);
      this.seed(`${dir}/web/package.json`, '{"name":"web"}\n');
    }
    if (this.hermesTui) {
      this.dirs.add(`${dir}/ui-tui`);
      this.seed(`${dir}/ui-tui/package.json`, '{"name":"hermes-tui"}\n');
    }
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
      return ok();
    }
    if (verb === "clone") {
      // A bundle names its own ref (a tag on its one commit), so `--branch` is not passed on that path.
      const ref = bundle ? this.bundleRef(bundle) : args[args.indexOf("--branch") + 1];
      if (!ref) return fail(128, bundle ? `'${bundle}' does not look like a v2 bundle` : "no ref");
      this.hermesShallow = !bundle && args.includes("--depth");
      this.hermesCheckout(dir, ref);
      return ok();
    }
    if (verb === "fetch") {
      if (!this.files.has(`${dir}/.git/HEAD`)) return fail(128, "not a git repository");
      if (bundle && this.bundleRef(bundle) === null) return fail(128, `could not read ${bundle}`);
      if (bundle) this.hermesShallow = false; // a bundle fetch brings whole history
      this.hermesFetchedRef = args.at(-1) ?? null;
      return ok();
    }
    if (verb === "checkout") {
      if (this.hermesFetchedRef === null) return fail(1, "FETCH_HEAD does not exist");
      this.hermesCheckedOutRef = this.hermesFetchedRef;
      this.hermesFetchedRef = null;
    }
    return ok();
  }

  /** `uv venv` makes an interpreter; `uv pip install -e` makes a `hermes`. */
  private uv(args: readonly string[]): ExecResult {
    if (args[0] === "venv") {
      const dir = args.at(-1);
      if (!dir) return fail(1, "no venv path");
      this.seed(`${dir}/bin/python`, "#!/bin/sh\n", "0755");
      return ok();
    }
    if (args[0] === "pip" && args[1] === "install") {
      const dir = (args[args.indexOf("-e") + 1] ?? "").replace(/\[.*\]$/, "");
      if (!this.files.has(`${dir}/.git/HEAD`)) return fail(1, `no checkout at ${dir}`);
      if (!this.files.has(`${dir}/venv/bin/python`)) return fail(1, `no venv at ${dir}/venv`);
      this.hermesInstalledVersion =
        (this.hermesCheckedOutRef === null
          ? null
          : this.hermesVersionByRef.get(this.hermesCheckedOutRef)) ?? this.hermesUnknownRefVersion;
      this.seed(`${dir}/venv/bin/hermes`, "#!/bin/sh\n", "0755");
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
    this.npmRuns.push({ argv: [...argv], cwd: opts?.cwd ?? null, env: { ...(opts?.env ?? {}) } });
    return ok();
  }

  /** Two archives get unpacked: an agent's config bundle (`.tgz`), and a Node release (`.tar.xz`). */
  private tar(args: readonly string[]): ExecResult {
    const dest = flagValue(args, ["-C"]);
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
   */
  private gatewayInstall(argv: readonly string[], opts?: ExecOptions): ExecResult {
    this.gatewayInstalls.push({ argv: [...argv], env: { ...(opts?.env ?? {}) } });
    this.seed(
      "/etc/systemd/system/hermes-gateway.service",
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
