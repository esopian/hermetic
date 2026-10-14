/**
 * The box half of the honcho memory provider (`memory-honcho`): distro
 * Postgres with no distro cluster, a second managed Python, the server's
 * source at its pinned commit synced from its lockfile, tiktoken pre-fetched,
 * the database cluster created once, the plugin's config link — and the
 * worker and database units' removal when the agent leaves honcho.
 *
 * Manifests carry what core renders for honcho (three units, `honcho.env`,
 * `honcho.json`), written out by hand: this suite is about what the box does
 * with such a manifest, not about the renderer.
 */
import { describe, expect, test } from "bun:test";
import type { AgentConfig, RenderedFile } from "@hermetic/core/schema";
import {
  HONCHO_PG_BIN,
  HONCHO_PLUGIN_CONFIG_LINK,
  MEMORY_DB_UNIT,
  MEMORY_LLM_ENV_PATH,
  MEMORY_SERVICES,
  MEMORY_SERVICE_ROOT,
  MEMORY_SERVICE_UNIT,
  MEMORY_WORKER_UNIT,
  honchoClientConfPath,
  honchoEnvPath,
  honchoPgDataDir,
  honchoSrcDir,
  honchoTiktokenDir,
  memoryServiceDir,
} from "@hermetic/core/shared";
import { MEMORY_PIN_MARKER, PLUGIN_REF_MARKER, apply } from "../src/apply/index.ts";
import { HERMES_VENV_DIR, UV_ENV } from "../src/apply/hermes.ts";
import {
  HONCHO_CREATECLUSTER_CONF,
  HONCHO_CREATECLUSTER_DIR,
  HONCHO_PG_STAGING,
} from "../src/apply/memory-honcho.ts";
import { UNIT_DIR } from "../src/apply/shared.ts";
import { AgentdError } from "../src/errors.ts";
import { HERMETICD_CAPABILITIES, parseManifest } from "../src/manifest.ts";
import { expectNotRan, expectRan, ranInOrder } from "./fake-host.ts";
import { makeManifest } from "./fixtures.ts";
import { HonchoBox } from "./honcho-box.ts";

const PROVIDER_KEY = "FIXTURE openai key";
const HONCHO = MEMORY_SERVICES.honcho;
const SOURCE = HONCHO.source!;
const DIR = memoryServiceDir("honcho");
const VENV = `${DIR}/venv`;
const CLONE = `${DIR}/.src.clone`;
const PG_VERSION = `${honchoPgDataDir}/PG_VERSION`;
const HERMES_PYTHON = `${HERMES_VENV_DIR}/bin/python`;
const unitPath = (unit: string): string => `${UNIT_DIR}/${unit}`;
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What the second apply on a converged box must not run: installs, network, cluster creation. */
const INSTALL_WORK =
  /^(?:runuser -u hermes -- )?(?:apt-get |uv (?!python find)|git clone|git -C \S+\.clone|curl |\S+\/initdb |\S+\/postgres --single|\S+\/venv\/bin\/python -c import tiktoken|ln -s -T )/;

function unit(path: string, body: string): RenderedFile {
  return { path, mode: "0644", content: `[Service]\nUser=hermes\n${body}\n` };
}

/** A honcho manifest: the fixture's, plus the three units, `honcho.env` and `honcho.json`. */
function honchoManifest(): AgentConfig {
  const base = makeManifest({
    provider: "openai",
    memory: {
      provider: "honcho",
      pin: HONCHO.pin,
      llm: { vendor: "openai", model: "FIXTURE-model", key_env: ["LLM_OPENAI_API_KEY"] },
    },
    units: [
      "hermeticd.service",
      "hermes-dashboard.service",
      "hermes-gateway.service",
      MEMORY_DB_UNIT,
      MEMORY_SERVICE_UNIT,
      MEMORY_WORKER_UNIT,
    ],
  });
  const conf = (path: string, content: string, restart: string[]): RenderedFile => ({
    path,
    mode: "0640",
    content,
    owner: "root",
    group: "hermes",
    restart_units: restart,
  });
  return {
    ...base,
    files: [
      ...base.files,
      unit(unitPath(MEMORY_DB_UNIT), `ExecStart=${HONCHO_PG_BIN}/postgres -D ${honchoPgDataDir}`),
      unit(unitPath(MEMORY_SERVICE_UNIT), `ExecStart=${VENV}/bin/uvicorn src.main:app`),
      unit(unitPath(MEMORY_WORKER_UNIT), `ExecStart=${VENV}/bin/python -m src.deriver`),
      conf(honchoEnvPath, "AUTH_USE_AUTH=false\n", [MEMORY_SERVICE_UNIT, MEMORY_WORKER_UNIT]),
      conf(honchoClientConfPath, '{"baseUrl":"http://127.0.0.1:18000"}\n', [
        "hermes-dashboard.service",
        "hermes-gateway.service",
      ]),
    ],
  };
}

/** hindsight in place of honcho: `MEMORY_SERVICE_UNIT` stays, as hindsight's. */
function hindsightManifest(): AgentConfig {
  const base = makeManifest({
    provider: "openai",
    memory: {
      provider: "hindsight",
      pin: MEMORY_SERVICES.hindsight.pin,
      llm: { vendor: "openai", model: "FIXTURE-model", key_env: ["HINDSIGHT_API_LLM_API_KEY"] },
    },
    units: [
      "hermeticd.service",
      "hermes-dashboard.service",
      "hermes-gateway.service",
      MEMORY_SERVICE_UNIT,
    ],
  });
  return {
    ...base,
    files: [
      ...base.files,
      unit(
        unitPath(MEMORY_SERVICE_UNIT),
        `ExecStart=${memoryServiceDir("hindsight")}/venv/bin/hindsight-api`,
      ),
    ],
  };
}

async function convergedBox(): Promise<HonchoBox> {
  const host = new HonchoBox();
  await apply(honchoManifest(), { host, providerKey: PROVIDER_KEY });
  host.commands.length = 0;
  host.execs.length = 0;
  host.restarted.length = 0;
  host.stopped.length = 0;
  host.daemonReloads.length = 0;
  return host;
}

describe("honcho: a fresh box", () => {
  test("installs Postgres, Python, the server, its cluster and the plugin link, in order", async () => {
    const host = new HonchoBox();
    const result = await apply(honchoManifest(), { host, providerKey: PROVIDER_KEY });

    // a. The drop-in, in a directory a fresh box does not have, before the packages.
    expect(host.dirs.has(HONCHO_CREATECLUSTER_DIR)).toBe(true);
    expect(host.files.get(HONCHO_CREATECLUSTER_CONF)?.content).toContain(
      "create_main_cluster = false\n",
    );
    expect(host.confAtAptInstall).toBe(true);
    // b. The packages, through apt.
    expectRan(
      host,
      /^apt-get install -y --no-install-recommends .* postgresql-16 postgresql-16-pgvector$/,
      1,
    );
    // c. The managed Python, probed, then installed by root under UV_ENV.
    expect(
      ranInOrder(host, ["^uv python find --managed-python 3\\.13$", "^uv python install 3\\.13$"]),
    ).toBe(true);
    expect(host.optsOf(/^uv python install/)?.env).toMatchObject(UV_ENV);
    // d. Its dirs, as the account; not the cluster's.
    expectRan(host, `^runuser -u hermes -- install -d -m 0750 ${esc(DIR)}$`, 1);
    expectRan(host, `^runuser -u hermes -- install -d -m 0750 ${esc(honchoTiktokenDir)}$`, 1);
    expect(
      host.commands.filter(
        (command) => command.includes("install -d ") && command.includes(honchoPgDataDir),
      ),
    ).toEqual([]);
    // e. The whole tree at the sha, not sparse, as the account.
    expectRan(
      host,
      `^runuser -u hermes -- git clone --filter=blob:none --no-checkout --quiet ${esc(SOURCE.repo)} ${esc(CLONE)}$`,
      1,
    );
    expectNotRan(host, /sparse-checkout/);
    expectRan(host, `^runuser -u hermes -- git -C ${esc(CLONE)} checkout --quiet ${SOURCE.sha}$`, 1);
    expectRan(host, `^runuser -u hermes -- mv -T ${esc(CLONE)} ${esc(honchoSrcDir)}$`, 1);
    expect(host.files.get(`${honchoSrcDir}/${PLUGIN_REF_MARKER}`)?.content).toBe(`${SOURCE.sha}\n`);
    expect(host.files.has(`${honchoSrcDir}/honcho-cli/pyproject.toml`)).toBe(true);
    // f. The locked sync, as the account, from the checkout, into the venv.
    expectRan(
      host,
      "^runuser -u hermes -- uv sync --frozen --no-dev --no-install-project --no-config --no-cache --python 3\\.13$",
      1,
    );
    const sync = host.optsOf(/ uv sync /);
    expect(sync?.cwd).toBe(honchoSrcDir);
    expect(sync?.env).toMatchObject({
      ...UV_ENV,
      HOME: "/data/hermes",
      UV_PROJECT_ENVIRONMENT: VENV,
      UV_PYTHON_DOWNLOADS: "never",
    });
    expect(host.optsOf(/import tiktoken/)?.env?.TIKTOKEN_CACHE_DIR).toBe(honchoTiktokenDir);
    expect((await host.readdir(honchoTiktokenDir)).length).toBe(2);
    // g. initdb into the staging dir, the SQL in single-user mode, then the move.
    expectRan(
      host,
      `^runuser -u hermes -- ${esc(HONCHO_PG_BIN)}/initdb -D ${esc(HONCHO_PG_STAGING)} -U hermes ` +
        "--auth-local=peer --auth-host=reject -E UTF8 --locale=C\\.UTF-8$",
      1,
    );
    const single = host.execs.filter((e) => / --single /.test(e.command));
    expect(single.map((e) => e.command.split(" ").slice(4).join(" "))).toEqual([
      `${HONCHO_PG_BIN}/postgres --single -D ${HONCHO_PG_STAGING} -j postgres`,
      `${HONCHO_PG_BIN}/postgres --single -D ${HONCHO_PG_STAGING} -j honcho`,
    ]);
    expect(single.map((e) => e.opts?.stdin)).toEqual([
      "CREATE DATABASE honcho;\n\n",
      "CREATE EXTENSION IF NOT EXISTS vector;\n\nCREATE EXTENSION IF NOT EXISTS pg_trgm;\n\n",
    ]);
    expect(host.files.get(PG_VERSION)?.content).toBe("16\n");
    expect([...host.files.keys()].filter((p) => p.startsWith(`${HONCHO_PG_STAGING}/`))).toEqual([]);
    // h. The link, as the account.
    expectRan(
      host,
      `^runuser -u hermes -- ln -s -T ${esc(honchoClientConfPath)} ${esc(HONCHO_PLUGIN_CONFIG_LINK)}$`,
      1,
    );
    expect(host.linkTargets.get(HONCHO_PLUGIN_CONFIG_LINK)).toBe(honchoClientConfPath);
    // The pin marker, last of all.
    expect(host.files.get(`${DIR}/${MEMORY_PIN_MARKER}`)?.content).toBe(`${HONCHO.pin}\n`);
    expect(
      ranInOrder(host, [
        "apt-get install",
        "uv python install",
        "git clone",
        "uv sync",
        "import tiktoken",
        "/initdb ",
        "-j honcho$",
        `mv -T ${esc(HONCHO_PG_STAGING)}`,
        "ln -s",
        `tee ${esc(`${DIR}/${MEMORY_PIN_MARKER}`)}$`,
      ]),
    ).toBe(true);

    // The plugin's SDK in Hermes's venv.
    expectRan(host, `^uv pip install --python ${esc(HERMES_PYTHON)} honcho-ai==2\\.2\\.0$`, 1);
    // The three units up, and the credential under honcho's name only.
    for (const u of [MEMORY_DB_UNIT, MEMORY_SERVICE_UNIT, MEMORY_WORKER_UNIT]) {
      expect(host.enabledUnits.has(u)).toBe(true);
      expect(result.restarted).toContain(u);
    }
    expect(host.files.get(MEMORY_LLM_ENV_PATH)?.content).toBe(
      "LLM_OPENAI_API_KEY='FIXTURE openai key'\n",
    );
    expect(result.installed).toEqual(
      expect.arrayContaining([
        "postgresql-16",
        "postgresql-16-pgvector",
        "python:3.13",
        `source:honcho@${SOURCE.sha}`,
        `memory:${HONCHO.pin}`,
        `pgdata:${honchoPgDataDir}`,
      ]),
    );
  });

  test("a dry run reports the install and runs none of it", async () => {
    const host = new HonchoBox();
    const plan = await apply(honchoManifest(), { host, providerKey: PROVIDER_KEY, dryRun: true });
    expect(plan.installed).toEqual(
      expect.arrayContaining(["postgresql-16", `memory:${HONCHO.pin}`, `pgdata:${honchoPgDataDir}`]),
    );
    expect(plan.changed).toContain(HONCHO_CREATECLUSTER_CONF);
    expect(host.commands.filter((c) => INSTALL_WORK.test(c) || c.startsWith("runuser "))).toEqual([]);
    expect(host.files.has(HONCHO_CREATECLUSTER_CONF)).toBe(false);
  });

  test("a failed statement in single-user mode fails the apply and moves nothing into place", async () => {
    const host = new HonchoBox();
    host.singleError = 'ERROR:  could not open extension control file "vector.control"';
    const refused = await apply(honchoManifest(), { host, providerKey: PROVIDER_KEY }).catch((e) => e);
    expect((refused as AgentdError).code).toBe("COMMAND_FAILED");
    expect(host.files.has(PG_VERSION)).toBe(false);
    expect(host.files.has(`${DIR}/${MEMORY_PIN_MARKER}`)).toBe(false);
  });
});

describe("honcho: a converged box", () => {
  test("a second apply installs nothing, creates nothing and restarts nothing", async () => {
    const host = await convergedBox();
    const second = await apply(honchoManifest(), { host, providerKey: PROVIDER_KEY });
    expect(host.commands.filter((c) => INSTALL_WORK.test(c))).toEqual([]);
    expect(second.installed).toEqual([]);
    expect(second.restarted).toEqual([]);
    expect(host.restarted).toEqual([]);
  });

  test("a new credential restarts the API and the worker, not the database", async () => {
    const host = await convergedBox();
    const second = await apply(honchoManifest(), { host, providerKey: "FIXTURE rotated key" });
    expect(second.restarted.sort()).toEqual([MEMORY_SERVICE_UNIT, MEMORY_WORKER_UNIT].sort());
  });

  test("a pin the venv did not receive re-syncs, without a clone or an initdb", async () => {
    const host = await convergedBox();
    host.seed(`${DIR}/${MEMORY_PIN_MARKER}`, "honcho==3.2.0+honcho-ai==2.1.0\n");
    const result = await apply(honchoManifest(), { host, providerKey: PROVIDER_KEY });
    expectRan(host, / uv sync --frozen /, 1);
    expectRan(host, /import tiktoken/, 1);
    expectNotRan(host, /git clone|\/initdb |--single/);
    expect(host.files.get(`${DIR}/${MEMORY_PIN_MARKER}`)?.content).toBe(`${HONCHO.pin}\n`);
    expect(result.restarted).toEqual(
      expect.arrayContaining([MEMORY_SERVICE_UNIT, MEMORY_WORKER_UNIT, "hermes-dashboard.service"]),
    );
    expect(result.restarted).not.toContain(MEMORY_DB_UNIT);
  });

  test("a checkout at another commit is replaced and re-synced", async () => {
    const host = await convergedBox();
    host.seed(`${honchoSrcDir}/${PLUGIN_REF_MARKER}`, `${"0".repeat(40)}\n`);
    await apply(honchoManifest(), { host, providerKey: PROVIDER_KEY });
    expectRan(host, /git clone/, 1);
    expectRan(host, / uv sync /, 1);
    expect(host.files.get(`${honchoSrcDir}/${PLUGIN_REF_MARKER}`)?.content).toBe(`${SOURCE.sha}\n`);
    expectNotRan(host, /\/initdb /);
  });

  test("a recreate rebuilds the root volume's half and keeps the cluster", async () => {
    const host = await convergedBox();
    // The new root volume: no packages, no drop-in, no managed Python; the
    // data volume's venv links to an interpreter that is gone.
    host.installedPackages.delete("postgresql-16");
    host.installedPackages.delete("postgresql-16-pgvector");
    host.files.delete(HONCHO_CREATECLUSTER_CONF);
    host.dirs.delete(HONCHO_CREATECLUSTER_DIR);
    host.managedPythons.clear();
    host.files.delete(`${VENV}/bin/python`);
    host.seed(`${honchoPgDataDir}/base/1/1259`, "FIXTURE memory");

    await apply(honchoManifest(), { host, providerKey: PROVIDER_KEY });
    expect(host.confAtAptInstall).toBe(true);
    expectRan(host, /^uv python install 3\.13$/, 1);
    expect(ranInOrder(host, [`rm -rf ${esc(VENV)}$`, " uv sync "])).toBe(true);
    expect(host.files.has(`${VENV}/bin/python`)).toBe(true);
    expectNotRan(host, /git clone|\/initdb |--single/);
    expect(host.files.get(`${honchoPgDataDir}/base/1/1259`)?.content).toBe("FIXTURE memory");
  });
});

describe("honcho: what is not hermetic's", () => {
  /** The ownership probe and its fix, over the memory tree only (`$HERMES_HOME`'s is not this). */
  const REOWN = new RegExp(`^(?:stat|find|chown) .*${esc(MEMORY_SERVICE_ROOT)}`);
  const FOREIGN_FILE = `${honchoPgDataDir}/base/1/1259`;

  test("a tree left by another uid is re-owned by root before the account's steps", async () => {
    const host = await convergedBox();
    // A recreate allocated `hermes` another uid; the data volume kept the old.
    for (const dir of [DIR, honchoPgDataDir]) host.dirOwners.set(dir, "UNKNOWN:UNKNOWN");
    await apply(honchoManifest(), { host, providerKey: PROVIDER_KEY });
    expectRan(
      host,
      `^find ${esc(DIR)} -xdev \\( ! -user hermes -o ! -group hermes \\) -print -quit$`,
      1,
    );
    expectRan(host, `^chown -R -h hermes:hermes ${esc(DIR)}$`, 1);
    expect(
      ranInOrder(host, [`^chown -R -h hermes:hermes ${esc(DIR)}$`, `install -d -m 0750 ${esc(DIR)}$`]),
    ).toBe(true);
    expect(host.treeOf(DIR).filter(([, owner]) => owner !== "hermes:hermes")).toEqual([]);
    expectNotRan(host, /\/initdb /);
  });

  test("a child a killed re-own left behind, under a top that is right, is re-owned", async () => {
    const host = await convergedBox();
    host.seed(FOREIGN_FILE, "FIXTURE memory");
    host.files.set(FOREIGN_FILE, { ...host.files.get(FOREIGN_FILE)!, ownership: "UNKNOWN:UNKNOWN" });
    await apply(honchoManifest(), { host, providerKey: PROVIDER_KEY });
    expectRan(host, `^chown -R -h hermes:hermes ${esc(DIR)}$`, 1);
    expect(host.files.get(FOREIGN_FILE)?.ownership).toBe("hermes:hermes");
    expect(host.files.get(FOREIGN_FILE)?.content).toBe("FIXTURE memory");
  });

  test("a tree the account already owns is walked and not re-owned", async () => {
    const host = await convergedBox();
    await apply(honchoManifest(), { host, providerKey: PROVIDER_KEY });
    expectRan(host, `^find ${esc(DIR)} `, 1);
    expectNotRan(host, `^chown .*${esc(MEMORY_SERVICE_ROOT)}/`);
  });

  test("no tree yet: nothing is probed or re-owned", async () => {
    const host = new HonchoBox();
    await apply(honchoManifest(), { host, providerKey: PROVIDER_KEY });
    expectNotRan(host, REOWN);
  });

  test("a dry run probes and re-owns nothing", async () => {
    const host = await convergedBox();
    host.dirOwners.set(DIR, "UNKNOWN:UNKNOWN");
    await apply(honchoManifest(), { host, providerKey: PROVIDER_KEY, dryRun: true });
    // (The rendered files' own `stat -c %U:%G` probes, under /etc, are `ensureOwnership`'s.)
    expectNotRan(host, REOWN);
    expect(host.dirOwners.get(DIR)).toBe("UNKNOWN:UNKNOWN");
  });

  test("a symlink at the service dir is neither walked nor re-owned, and is refused", async () => {
    const host = new HonchoBox();
    host.dirs.add(DIR);
    host.symlinks.add(DIR);
    const refused = await apply(honchoManifest(), { host, providerKey: PROVIDER_KEY }).catch((e) => e);
    expect((refused as AgentdError).code).toBe("AGENT_DIR_UNSAFE");
    expectNotRan(host, REOWN);
  });

  test("a symlink at the cluster is never descended into or re-owned through", async () => {
    const host = await convergedBox();
    host.dirs.add("/srv/elsewhere");
    host.seed("/srv/elsewhere/PG_VERSION", "16\n");
    host.files.set("/srv/elsewhere/PG_VERSION", {
      content: "16\n",
      mode: "0600",
      ownership: "root:root",
    });
    for (const path of [...host.files.keys()])
      if (path.startsWith(`${honchoPgDataDir}/`)) host.files.delete(path);
    host.symlinks.add(honchoPgDataDir);
    // Seen through the link: what would be walked if `find` followed it.
    host.seed(`${honchoPgDataDir}/PG_VERSION`, "16\n");
    host.files.set(`${honchoPgDataDir}/PG_VERSION`, {
      content: "16\n",
      mode: "0600",
      ownership: "root:root",
    });
    await apply(honchoManifest(), { host, providerKey: PROVIDER_KEY });
    expectNotRan(host, `^(?:stat|find|chown) .*${esc(honchoPgDataDir)}`);
    expectNotRan(host, `^chown .*${esc(MEMORY_SERVICE_ROOT)}/`);
    expect(host.files.get(`${honchoPgDataDir}/PG_VERSION`)?.ownership).toBe("root:root");
  });

  test("a cluster from another Postgres major is refused and left alone", async () => {
    const host = new HonchoBox();
    host.seed(PG_VERSION, "15\n");
    const refused = await apply(honchoManifest(), { host, providerKey: PROVIDER_KEY }).catch((e) => e);
    expect(refused).toBeInstanceOf(AgentdError);
    expect((refused as AgentdError).code).toBe("UNSUPPORTED");
    expect((refused as AgentdError).message).toContain("Postgres 15");
    expectNotRan(host, /\/initdb |--single|rm -rf \S*pg/);
    expect(host.files.get(PG_VERSION)?.content).toBe("15\n");
  });

  test("a data dir that is no cluster is refused too", async () => {
    const host = new HonchoBox();
    host.seed(`${honchoPgDataDir}/notes.txt`, "mine");
    const refused = await apply(honchoManifest(), { host, providerKey: PROVIDER_KEY }).catch((e) => e);
    expect((refused as AgentdError).code).toBe("UNSUPPORTED");
    expectNotRan(host, /\/initdb /);
  });

  test("an operator's honcho.json, file or link, is left alone, here and on removal", async () => {
    for (const own of ["file", "link"] as const) {
      const host = new HonchoBox();
      if (own === "file") host.seed(HONCHO_PLUGIN_CONFIG_LINK, '{"workspace":"mine"}\n');
      else host.symlink("/data/hermes/my-honcho.json", HONCHO_PLUGIN_CONFIG_LINK);
      await apply(honchoManifest(), { host, providerKey: PROVIDER_KEY });
      expectNotRan(host, /\bln -s -T /);
      await apply(makeManifest(), { host });
      expectNotRan(host, `rm -f ${esc(HONCHO_PLUGIN_CONFIG_LINK)}`);
      if (own === "file")
        expect(host.files.get(HONCHO_PLUGIN_CONFIG_LINK)?.content).toBe('{"workspace":"mine"}\n');
      else expect(host.linkTargets.get(HONCHO_PLUGIN_CONFIG_LINK)).toBe("/data/hermes/my-honcho.json");
    }
  });
});

describe("honcho: removal", () => {
  test("honcho → hindsight removes the worker and the database, keeps the API unit as hindsight's", async () => {
    const host = await convergedBox();
    const result = await apply(hindsightManifest(), { host, providerKey: PROVIDER_KEY });

    for (const u of [MEMORY_WORKER_UNIT, MEMORY_DB_UNIT]) {
      expect(host.stopped).toContain(u);
      expect(host.enabledUnits.has(u)).toBe(false);
      expect(host.files.has(unitPath(u))).toBe(false);
      expect(result.changed).toContain(unitPath(u));
    }
    expect(host.stopped).not.toContain(MEMORY_SERVICE_UNIT);
    expect(host.files.get(unitPath(MEMORY_SERVICE_UNIT))?.content).toContain("hindsight-api");
    expect(result.restarted).toContain(MEMORY_SERVICE_UNIT);
    // One reload, after both removals and with hindsight's unit file on disk.
    expect(host.daemonReloads).toHaveLength(1);
    // The plugin link goes; the memory stays.
    expect(host.symlinks.has(HONCHO_PLUGIN_CONFIG_LINK)).toBe(false);
    expect(host.files.has(HONCHO_PLUGIN_CONFIG_LINK)).toBe(false);
    expect(host.files.get(PG_VERSION)?.content).toBe("16\n");
    expect(host.files.has(`${VENV}/bin/python`)).toBe(true);
    expectNotRan(host, /apt-get (?:remove|purge)/);
  });

  test("honcho → none removes all three units, the link and the credential, and keeps the data", async () => {
    const host = await convergedBox();
    const result = await apply(makeManifest(), { host });
    for (const u of [MEMORY_SERVICE_UNIT, MEMORY_WORKER_UNIT, MEMORY_DB_UNIT]) {
      expect(host.stopped).toContain(u);
      expect(host.enabledUnits.has(u)).toBe(false);
      expect(host.files.has(unitPath(u))).toBe(false);
      expect(result.changed).toContain(unitPath(u));
    }
    expect(host.daemonReloads).toHaveLength(1);
    expect(host.files.has(HONCHO_PLUGIN_CONFIG_LINK)).toBe(false);
    expect(host.files.has(MEMORY_LLM_ENV_PATH)).toBe(false);
    expect(host.files.get(PG_VERSION)?.content).toBe("16\n");
    expect(host.files.get(`${honchoSrcDir}/${PLUGIN_REF_MARKER}`)?.content).toBe(`${SOURCE.sha}\n`);
  });

  test("a dry run reports the removals and performs none", async () => {
    const host = await convergedBox();
    const plan = await apply(makeManifest(), { host, dryRun: true });
    expect(plan.changed).toEqual(
      expect.arrayContaining([
        unitPath(MEMORY_WORKER_UNIT),
        unitPath(MEMORY_DB_UNIT),
        HONCHO_PLUGIN_CONFIG_LINK,
      ]),
    );
    expect(host.stopped).toEqual([]);
    expect(host.files.has(unitPath(MEMORY_DB_UNIT))).toBe(true);
    expect(host.symlinks.has(HONCHO_PLUGIN_CONFIG_LINK)).toBe(true);
  });
});

describe("honcho: the capability", () => {
  test("this hermeticd implements memory-honcho", () => {
    expect(HERMETICD_CAPABILITIES.has("memory-honcho")).toBe(true);
    const manifest = { ...honchoManifest(), requires: ["memory-service", "memory-honcho"] };
    expect(parseManifest(manifest).requires).toContain("memory-honcho");
  });

  test("a hermeticd without it refuses a honcho manifest before anything is applied", () => {
    const capabilities = HERMETICD_CAPABILITIES as Set<string>;
    capabilities.delete("memory-honcho");
    try {
      const manifest = { ...honchoManifest(), requires: ["memory-service", "memory-honcho"] };
      const refused = (() => {
        try {
          parseManifest(manifest);
        } catch (e) {
          return e;
        }
        return null;
      })();
      expect(refused).toBeInstanceOf(AgentdError);
      expect((refused as AgentdError).code).toBe("MANIFEST_REFUSED");
      expect((refused as AgentdError).message).toContain("memory-honcho");
    } finally {
      capabilities.add("memory-honcho");
    }
  });
});
