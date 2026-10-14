/**
 * The honcho server, box side (the `memory-honcho` capability): everything
 * `hermetic-memory.service` (its API), `hermetic-memory-worker.service` (its
 * deriver) and `hermetic-memory-db.service` (its Postgres) need that is not a
 * rendered file. The three units, `honcho.env` and the plugin's `honcho.json`
 * are the laptop's, landed by the files phase.
 *
 * In order, each probed first so a converged box runs no `apt-get`, `uv`,
 * `git`, `curl`, `initdb` or `postgres --single`:
 *
 * 1. root: `HONCHO_CREATECLUSTER_CONF`, before the packages, so the distro
 *    never creates and starts a `16/main` cluster of its own;
 * 2. root: `HONCHO_APT_PACKAGES` (Postgres and pgvector);
 * 3. root: the uv-managed Python the server needs, which the account cannot
 *    install into the root-owned `UV_PYTHON_INSTALL_DIR` itself;
 * 4. the account: the server's source at the pinned commit
 *    (`ensureCheckout`), its locked dependencies synced into the venv, and
 *    tiktoken's two encodings pre-fetched;
 * 5. the account: the database cluster, created once and never touched again;
 * 6. the account: `HONCHO_PLUGIN_CONFIG_LINK`, where the Hermes plugin looks
 *    for its configuration, pointed at the rendered `honchoClientConfPath`;
 *
 * and last the pin marker, which says every one of them finished for this pin.
 */
import {
  HONCHO_DB_NAME,
  HONCHO_PG_BIN,
  HONCHO_PG_MAJOR,
  HONCHO_PLUGIN_CONFIG_LINK,
  honchoClientConfPath,
  honchoPgDataDir,
  honchoSrcDir,
  honchoTiktokenDir,
  type MemoryServiceSpec,
} from "@hermetic/core/shared";
import { asHermes } from "../account-dirs.ts";
import { AgentdError } from "../errors.ts";
import type { Emit } from "../events.ts";
import { opEvent } from "../events.ts";
import type { Host } from "../host.ts";
import { must } from "../host.ts";
import { HERMES_USER } from "./accounts.ts";
import { installPackages, missingPackages } from "./apt.ts";
import { UV_ENV } from "./hermes.ts";
import {
  ACCOUNT_ENV,
  ACCOUNT_EXEC,
  MEMORY_PIN_MARKER,
  NET_ATTEMPTS,
  NET_RETRY_MS,
  ensureCheckout,
  writeAsHermes,
} from "./memory-shared.ts";
import type { ApplyResult } from "./shared.ts";
import { retry } from "./shared.ts";

/**
 * A `createcluster.d` drop-in: postgresql-common's `createcluster.conf` ends
 * in `include_dir '/etc/postgresql-common/createcluster.d'`, and the
 * `postgresql-16` postinst asks it (`pg_conftool … show -bs
 * create_main_cluster`) whether to create `16/main`. Written before the
 * package is installed, so the answer is `off` the first time it is asked.
 */
export const HONCHO_CREATECLUSTER_DIR = "/etc/postgresql-common/createcluster.d";
export const HONCHO_CREATECLUSTER_CONF = `${HONCHO_CREATECLUSTER_DIR}/50-hermetic.conf`;
const CREATECLUSTER_CONTENT =
  "# hermetic: honcho's database is its own cluster on the data volume\n" +
  "# (hermetic-memory-db.service), so the distro's main cluster is never created.\n" +
  "create_main_cluster = false\n";

/** Where `initdb` builds the cluster before it is moved into `honchoPgDataDir` whole. */
export const HONCHO_PG_STAGING = `${honchoPgDataDir}.init`;

/**
 * The two encodings honcho loads (`src/utils/tokens.py` at import time,
 * `src/embedding_client.py` on first use), fetched now into
 * `honchoTiktokenDir` — the `TIKTOKEN_CACHE_DIR` `honcho.env` names — so the
 * server never reaches for openaipublic.blob.core.windows.net while serving.
 */
const TIKTOKEN_WARM =
  "import tiktoken; tiktoken.get_encoding('o200k_base'); tiktoken.get_encoding('cl100k_base')";
/** tiktoken caches one file per encoding. */
const TIKTOKEN_FILES = 2;

export interface HonchoOutcome {
  /** Anything the server runs on moved: the units restart. */
  readonly installed: boolean;
}

/**
 * Install everything the honcho server needs that is not a rendered file
 * (the module header lists it). `dir` is `memoryServiceDir("honcho")`, which
 * `ensureServiceDirs` has made (with `tiktoken` under it) before this runs.
 */
export async function ensureHoncho(input: {
  host: Host;
  spec: MemoryServiceSpec;
  dir: string;
  emit: Emit;
  dry: boolean;
  result?: ApplyResult;
}): Promise<HonchoOutcome> {
  const { host, spec, dir, emit, dry, result } = input;
  const source = spec.source;
  if (source === null) {
    throw new AgentdError("INTERNAL", `the honcho spec ${spec.pin} names no source checkout`);
  }

  const conf = await ensureCreateclusterConf(host, dry);
  if (conf) result?.changed.push(HONCHO_CREATECLUSTER_CONF);
  const apt = await ensureAptPackages(host, spec, emit, dry);
  result?.installed.push(...apt);
  const python = await ensureManagedPython(host, spec.python, emit, dry);
  if (python) result?.installed.push(`python:${spec.python}`);

  const checkout = await ensureCheckout(
    host,
    {
      repo: source.repo,
      sha: source.sha,
      subdir: null,
      target: honchoSrcDir,
      label: `the honcho server ${source.tag}`,
    },
    emit,
    dry,
    0.36,
  );
  if (checkout) result?.installed.push(`source:honcho@${source.sha}`);

  const marker = `${dir}/${MEMORY_PIN_MARKER}`;
  const pinned = (await host.readFile(marker))?.trim() === spec.pin;
  const synced = await ensureSync(host, spec, dir, checkout || !pinned, emit, dry);
  if (synced) result?.installed.push(`memory:${spec.pin}`);
  const warmed = await ensureTiktoken(host, dir, synced, emit, dry);
  const cluster = await ensureCluster(host, emit, dry);
  if (cluster) result?.installed.push(`pgdata:${honchoPgDataDir}`);
  const linked = await ensurePluginLink(host, emit, dry);
  if (linked) result?.changed.push(HONCHO_PLUGIN_CONFIG_LINK);

  // Last: the record that every step above finished for this pin.
  if (!dry && !pinned) await writeAsHermes(host, marker, `${spec.pin}\n`);
  // Steps 1 and 2 restart nothing: the drop-in is read only by a package
  // install, and a Postgres package is no part of what the API, the worker
  // or Hermes execute.
  return { installed: python || checkout || synced || warmed || cluster || linked };
}

/** Step 1, as root: `/etc` is root's, and nothing under it is the account's to steer. */
async function ensureCreateclusterConf(host: Host, dry: boolean): Promise<boolean> {
  if ((await host.readFile(HONCHO_CREATECLUSTER_CONF)) === CREATECLUSTER_CONTENT) return false;
  if (dry) return true;
  // A fresh box has no postgresql-common yet, so no directory for the drop-in either.
  await host.mkdir(HONCHO_CREATECLUSTER_DIR, "0755");
  await host.writeFile(HONCHO_CREATECLUSTER_CONF, CREATECLUSTER_CONTENT, "0644");
  return true;
}

/** Step 2: the packages dpkg does not have, through the same apt path as the manifest's own. */
async function ensureAptPackages(
  host: Host,
  spec: MemoryServiceSpec,
  emit: Emit,
  dry: boolean,
): Promise<string[]> {
  if (spec.apt.length === 0) return [];
  const missing = await missingPackages(host, spec.apt);
  if (missing.length === 0) return [];
  emit(
    opEvent("packages", 0.355, `installing ${missing.join(" ")} for the honcho database`, host.now()),
  );
  if (!dry) await installPackages(host, missing, false);
  return missing;
}

/**
 * Step 3: `uv python install <version>` as root, under `UV_ENV` like Hermes's
 * own 3.11, after asking uv whether a managed one is already there
 * (`--managed-python`, so a system interpreter of the same minor never
 * satisfies it: the venv is built on the managed one). The probe is a read,
 * so a dry run asks it too.
 */
async function ensureManagedPython(
  host: Host,
  version: string,
  emit: Emit,
  dry: boolean,
): Promise<boolean> {
  const env = { env: { ...UV_ENV } };
  const found = await host.exec(["uv", "python", "find", "--managed-python", version], env);
  if (found.code === 0) return false;
  emit(opEvent("packages", 0.358, `installing Python ${version} for the honcho server`, host.now()));
  if (dry) return true;
  await retry(host, NET_ATTEMPTS, NET_RETRY_MS, () =>
    must(host, ["uv", "python", "install", version], env),
  );
  return true;
}

/**
 * Step 4b: the server's locked dependencies into `<dir>/venv`, from the
 * checkout's `uv.lock` (`--frozen`: never re-resolved), without the dev group
 * and without the project itself — honcho has no build system and runs from
 * its source tree, as upstream's Dockerfile does.
 *
 * Run when the checkout moved, the pin did, or the venv's interpreter is gone:
 * the venv is on the data volume, the managed Python its `bin/python` links to
 * is on the root volume a recreate replaces. That venv is removed first, so the
 * sync builds a fresh one on the interpreter step 3 just installed.
 * `UV_PYTHON_DOWNLOADS=never`: step 3 is the only place a Python comes from.
 */
async function ensureSync(
  host: Host,
  spec: MemoryServiceSpec,
  dir: string,
  stale: boolean,
  emit: Emit,
  dry: boolean,
): Promise<boolean> {
  const venv = `${dir}/venv`;
  const hasPython = (await host.stat(`${venv}/bin/python`)) !== null;
  if (hasPython && !stale) {
    emit(opEvent("packages", 0.37, `honcho server ${spec.pin} already installed`, host.now()));
    return false;
  }
  emit(opEvent("packages", 0.37, `installing the honcho server (${spec.pin})`, host.now()));
  if (dry) return true;

  if (!hasPython && (await host.lstat(venv)) !== null) {
    await must(host, asHermes(["rm", "-rf", venv]), ACCOUNT_EXEC);
  }
  const argv = [
    "uv",
    "sync",
    "--frozen",
    "--no-dev",
    "--no-install-project",
    "--no-config",
    "--no-cache",
    "--python",
    spec.python,
  ];
  const env = {
    ...UV_ENV,
    ...ACCOUNT_ENV,
    UV_PROJECT_ENVIRONMENT: venv,
    UV_PYTHON_DOWNLOADS: "never",
  };
  await retry(host, NET_ATTEMPTS, NET_RETRY_MS, () =>
    must(host, asHermes(argv), { env, cwd: honchoSrcDir }),
  );
  return true;
}

/**
 * Step 4c: tiktoken's encodings, fetched by the venv's own tiktoken. After
 * every sync (a new tiktoken may name new files), and whenever the cache is
 * short of them.
 */
async function ensureTiktoken(
  host: Host,
  dir: string,
  synced: boolean,
  emit: Emit,
  dry: boolean,
): Promise<boolean> {
  const cached = (await host.readdir(honchoTiktokenDir)).filter((f) => !f.endsWith(".tmp"));
  if (!synced && cached.length >= TIKTOKEN_FILES) return false;
  emit(opEvent("packages", 0.375, "fetching the honcho server's tiktoken encodings", host.now()));
  if (dry) return true;
  await retry(host, NET_ATTEMPTS, NET_RETRY_MS, () =>
    must(host, asHermes([`${dir}/venv/bin/python`, "-c", TIKTOKEN_WARM]), {
      env: { ...ACCOUNT_ENV, TIKTOKEN_CACHE_DIR: honchoTiktokenDir },
      ...ACCOUNT_EXEC,
    }),
  );
  return true;
}

/**
 * Step 5: the database cluster, once.
 *
 * `initdb` builds it in `HONCHO_PG_STAGING` (cleared first, so a half-built one
 * from a failed apply never counts), the database and its extensions are made
 * in single-user mode — no server, no socket, no password: the bootstrap role
 * is `hermes`, and local connections authenticate by peer — and only then is
 * it moved to `honchoPgDataDir`. So `PG_VERSION` there means a finished
 * cluster, and its presence is the whole probe.
 *
 * A cluster that is there is never touched: it is the agent's memory, kept
 * across recreates and provider changes. One from another Postgres major (or
 * a directory that is no cluster at all) is refused, not upgraded or
 * replaced — the remedy is the operator's.
 */
async function ensureCluster(host: Host, emit: Emit, dry: boolean): Promise<boolean> {
  const versionFile = `${honchoPgDataDir}/PG_VERSION`;
  const version = (await host.readFile(versionFile))?.trim() ?? null;
  if (version === String(HONCHO_PG_MAJOR)) return false;
  if (version !== null || (await host.lstat(honchoPgDataDir)) !== null) {
    throw new AgentdError(
      "UNSUPPORTED",
      `${honchoPgDataDir} holds ${version === null ? "something that is not a Postgres cluster" : `a Postgres ${version} cluster`}; ` +
        `the honcho database runs on Postgres ${String(HONCHO_PG_MAJOR)}. hermetic will not touch it: it is the agent's ` +
        "memory. Move it aside (or upgrade it with pg_upgrade) on the box, then re-apply.",
      { path: honchoPgDataDir, found: version, want: String(HONCHO_PG_MAJOR) },
    );
  }

  emit(opEvent("packages", 0.38, "creating the honcho database", host.now()));
  if (dry) return true;
  await must(host, asHermes(["rm", "-rf", HONCHO_PG_STAGING]), ACCOUNT_EXEC);
  await must(
    host,
    asHermes([
      `${HONCHO_PG_BIN}/initdb`,
      "-D",
      HONCHO_PG_STAGING,
      "-U",
      HERMES_USER,
      "--auth-local=peer",
      "--auth-host=reject",
      "-E",
      "UTF8",
      "--locale=C.UTF-8",
    ]),
    ACCOUNT_EXEC,
  );
  await single(host, "postgres", [`CREATE DATABASE ${HONCHO_DB_NAME};`]);
  await single(host, HONCHO_DB_NAME, [
    "CREATE EXTENSION IF NOT EXISTS vector;",
    "CREATE EXTENSION IF NOT EXISTS pg_trgm;",
  ]);
  await must(host, asHermes(["mv", "-T", HONCHO_PG_STAGING, honchoPgDataDir]), ACCOUNT_EXEC);
  return true;
}

/**
 * Statements through `postgres --single` against the staged cluster. `-j`
 * makes a statement end at `;` and a blank line rather than at every newline.
 * Single-user mode reports a failed statement and carries on to a zero exit,
 * so its output is read for the `ERROR:` it would have printed.
 */
async function single(host: Host, database: string, statements: readonly string[]): Promise<void> {
  const argv = asHermes([
    `${HONCHO_PG_BIN}/postgres`,
    "--single",
    "-D",
    HONCHO_PG_STAGING,
    "-j",
    database,
  ]);
  const res = await must(host, argv, {
    stdin: statements.map((s) => `${s}\n\n`).join(""),
    ...ACCOUNT_EXEC,
  });
  if (/\bERROR:/.test(`${res.stdout}\n${res.stderr}`)) {
    throw new AgentdError("COMMAND_FAILED", `creating the honcho database failed in ${database}`, {
      database,
      statements: [...statements],
      stderr: res.stderr.slice(-2000),
    });
  }
}

/**
 * Step 6: `HONCHO_PLUGIN_CONFIG_LINK` → `honchoClientConfPath`, as the account
 * (it is under `$HERMES_HOME`), only when nothing is there. A file of the
 * operator's own, or a link pointing anywhere else, is theirs and left alone.
 * The target is a rendered file the files phase lands after this, so the link
 * may dangle for the length of one apply.
 */
async function ensurePluginLink(host: Host, emit: Emit, dry: boolean): Promise<boolean> {
  const found = await host.lstat(HONCHO_PLUGIN_CONFIG_LINK);
  if (found !== null) {
    if (
      found.isSymlink &&
      (await linkTarget(host, HONCHO_PLUGIN_CONFIG_LINK)) === honchoClientConfPath
    ) {
      return false;
    }
    emit(
      opEvent(
        "packages",
        0.39,
        `${HONCHO_PLUGIN_CONFIG_LINK} is the operator's own; leaving it (hermetic renders ${honchoClientConfPath})`,
        host.now(),
      ),
    );
    return false;
  }
  emit(
    opEvent(
      "packages",
      0.39,
      `linking ${HONCHO_PLUGIN_CONFIG_LINK} to ${honchoClientConfPath}`,
      host.now(),
    ),
  );
  if (dry) return true;
  await must(
    host,
    asHermes(["ln", "-s", "-T", honchoClientConfPath, HONCHO_PLUGIN_CONFIG_LINK]),
    ACCOUNT_EXEC,
  );
  return true;
}

/** Where a symlink points, unresolved; null when it is no symlink. */
export async function linkTarget(host: Host, path: string): Promise<string | null> {
  const res = await host.exec(["readlink", path]);
  return res.code === 0 ? res.stdout.trim() : null;
}
