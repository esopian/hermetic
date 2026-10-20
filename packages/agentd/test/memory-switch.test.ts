/**
 * An existing agent's memory provider changed in place (`agents.set --memory`),
 * reaching the running box the way every configuration change does: a
 * converge (`converge.ts`) into the same `apply` the bootstrap stages use.
 *
 * The rule under test is the operator's: moving away from a provider (to
 * another, or to none) stops and removes its units and **never deletes its
 * data**, and moving back reuses that data — no new cluster, no new venv, no
 * model fetched again. Then the edges of doing this live rather than at a
 * create: the secrets oneshot during a converge, the apt index of a long-lived
 * `serve`, and Hermes starting only once the memory server is listening.
 *
 * Manifests follow what core renders (`render.ts`, `render-memory.ts`), written
 * out by hand, with the order and the files that matter here: the secrets
 * unit first, then the memory units, then the rest, and a managed
 * `config.yaml` that names the provider. The renderer's side of those facts is
 * held by `tests/seams.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import type { GetParameterCommand } from "@aws-sdk/client-ssm";
import type { AgentConfig, ApplyRequest, RenderedFile } from "@hermetic/core/schema";
import {
  HERMES_ACCOUNT_HOME,
  HERMES_HOME,
  HERMES_USER_ENV,
  MANAGED_ENV_BEGIN,
  MANAGED_ENV_END,
  HONCHO_PG_BIN,
  HONCHO_PLUGIN_CONFIG_LINK,
  MEMORY_DB_UNIT,
  MEMORY_LLM_ENV_PATH,
  MEMORY_SERVICES,
  MEMORY_SERVICE_UNIT,
  MEMORY_SERVICE_UNITS,
  MEMORY_WORKER_UNIT,
  PROVIDERS,
  hermesPluginDir,
  honchoClientConfPath,
  honchoEnvPath,
  honchoPgDataDir,
  honchoTiktokenDir,
  memoryServiceDir,
  openvikingConfPath,
  type MemoryProvider,
} from "@hermetic/core/shared";
import { MEMORY_READY_TIMEOUT_MS, SECRETS_ENV_PATH, SECRETS_UNIT, apply } from "../src/apply/index.ts";
import { HONCHO_CREATECLUSTER_CONF } from "../src/apply/memory-honcho.ts";
import { UNIT_DIR } from "../src/apply/shared.ts";
import { makeAws, type Aws } from "../src/aws.ts";
import { convergeOnce } from "../src/converge.ts";
import { collector } from "../src/events.ts";
import { FLEET_CACHE_PATH } from "../src/fleet.ts";
import type { ExecOptions, ExecResult } from "../src/host.ts";
import { APPLIED_CONFIG_PATH, MANIFEST_PATH } from "../src/manifest.ts";
import { run } from "../src/main.ts";
import { USER_DATA_JSON_PATH } from "../src/userdata.ts";
import { expectNotRan, expectRan, ranInOrder } from "./fake-host.ts";
import {
  RecordingSink,
  TEST_AGENTS_TABLE,
  TEST_BUCKET,
  TEST_EVENTS_TABLE,
  TEST_NAME,
  makeFleetManifest,
  makeManifest,
  makeUserDataJson,
} from "./fixtures.ts";
import { HonchoBox } from "./honcho-box.ts";
import { blob } from "./memory-box.ts";
import { captureOutput } from "./quiet.ts";

const out = captureOutput();

const PROVIDER_KEY = "FIXTURE provider key";
const unitPath = (unit: string): string => `${UNIT_DIR}/${unit}`;
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const HERMES_UNITS = ["hermes-dashboard.service", "hermes-gateway.service"];
const OV_MODEL = MEMORY_SERVICES.openviking.model!;

type Vendor = "openai" | "anthropic";
type Choice = MemoryProvider | "none";

/** The secrets oneshot as `secretsUnit` renders it: its comment names the vendor's variable. */
function secretsUnitFile(vendor: Vendor): RenderedFile {
  return {
    path: unitPath(SECRETS_UNIT),
    mode: "0644",
    content:
      "[Service]\nType=oneshot\nRemainAfterExit=yes\n" +
      "ExecStart=/usr/local/bin/hermeticd secrets materialise\n" +
      `# ${PROVIDERS[vendor].env ?? ""} is read from SSM at this fleet's SSM prefix + ${TEST_NAME}/provider-key by hermeticd.\n`,
  };
}

function unitFile(unit: string, body: string): RenderedFile {
  return {
    path: unitPath(unit),
    mode: "0644",
    content: `[Unit]\nAfter=${SECRETS_UNIT}\nRequires=${SECRETS_UNIT}\n\n[Service]\nUser=hermes\n${body}\n`,
  };
}

/** A root-owned configuration file readable by the account, as core renders them. */
function confFile(path: string, content: string, restart: string[]): RenderedFile {
  return { path, mode: "0640", content, owner: "root", group: "hermes", restart_units: restart };
}

/** What `render-memory.ts` adds for `provider`: its `memory` block, units and files. */
function memoryPart(
  provider: Choice,
  vendor: Vendor,
): { memory?: AgentConfig["memory"]; units: string[]; files: RenderedFile[] } {
  const llm = (key_env: NonNullable<NonNullable<AgentConfig["memory"]>["llm"]>["key_env"]) => ({
    vendor,
    model: "FIXTURE-model",
    key_env,
  });
  switch (provider) {
    case "none":
      return { units: [], files: [] };
    case "holographic":
      return { memory: { provider }, units: [], files: [] };
    case "hindsight":
      return {
        memory: {
          provider,
          pin: MEMORY_SERVICES.hindsight.pin,
          llm: llm(["HINDSIGHT_API_LLM_API_KEY"]),
        },
        units: [MEMORY_SERVICE_UNIT],
        files: [
          unitFile(
            MEMORY_SERVICE_UNIT,
            `EnvironmentFile=${MEMORY_LLM_ENV_PATH}\nExecStart=${memoryServiceDir("hindsight")}/venv/bin/hindsight-api --port 8888`,
          ),
        ],
      };
    case "openviking":
      return {
        memory: { provider, pin: MEMORY_SERVICES.openviking.pin, llm: llm(["OPENAI_API_KEY"]) },
        units: [MEMORY_SERVICE_UNIT],
        files: [
          unitFile(
            MEMORY_SERVICE_UNIT,
            `EnvironmentFile=${MEMORY_LLM_ENV_PATH}\nExecStart=${memoryServiceDir("openviking")}/venv/bin/openviking-server --port 1933`,
          ),
          confFile(openvikingConfPath, '{"server":{"port":1933}}\n', [MEMORY_SERVICE_UNIT]),
        ],
      };
    case "honcho": {
      const venv = `${memoryServiceDir("honcho")}/venv`;
      return {
        memory: { provider, pin: MEMORY_SERVICES.honcho.pin, llm: llm(["LLM_OPENAI_API_KEY"]) },
        units: [MEMORY_DB_UNIT, MEMORY_SERVICE_UNIT, MEMORY_WORKER_UNIT],
        files: [
          unitFile(MEMORY_DB_UNIT, `ExecStart=${HONCHO_PG_BIN}/postgres -D ${honchoPgDataDir}`),
          unitFile(
            MEMORY_SERVICE_UNIT,
            `EnvironmentFile=${MEMORY_LLM_ENV_PATH}\nExecStart=${venv}/bin/uvicorn src.main:app --port 18000`,
          ),
          unitFile(
            MEMORY_WORKER_UNIT,
            `EnvironmentFile=${MEMORY_LLM_ENV_PATH}\nExecStart=${venv}/bin/python -m src.deriver`,
          ),
          confFile(honchoEnvPath, "AUTH_USE_AUTH=false\n", [MEMORY_SERVICE_UNIT, MEMORY_WORKER_UNIT]),
          confFile(honchoClientConfPath, '{"baseUrl":"http://127.0.0.1:18000"}\n', HERMES_UNITS),
        ],
      };
    }
  }
}

/** The agent's whole manifest with `provider` as its memory and `vendor` as its model's. */
function agent(provider: Choice, options: { vendor?: Vendor; hash?: string } = {}): AgentConfig {
  const vendor = options.vendor ?? "openai";
  const part = memoryPart(provider, vendor);
  const base = makeManifest({
    provider: vendor,
    ...(part.memory ? { memory: part.memory } : {}),
    hermesConfigBody:
      `model:\n  provider: "${vendor}"\n` +
      (part.memory ? `memory:\n  provider: "${part.memory.provider}"\n` : ""),
    units: [
      SECRETS_UNIT,
      ...part.units,
      "hermeticd.service",
      "hermes-dashboard.service",
      "hermes-gateway.service",
    ],
  });
  return {
    ...base,
    config_hash: options.hash ?? `${provider}-${vendor}`,
    files: [...base.files, secretsUnitFile(vendor), ...part.files],
  };
}

/**
 * A box that can run every provider, and whose `hermetic-secrets.service`
 * does what the real one does when it is started: `hermeticd secrets
 * materialise`, against whatever `MANIFEST_PATH` says at that moment.
 */
class SwitchBox extends HonchoBox {
  oneshot: (() => Promise<number>) | null = null;

  constructor() {
    super();
    this.curlBodies.set(OV_MODEL.url, blob(OV_MODEL.sha256, OV_MODEL.size));
  }

  override async exec(argv: readonly string[], opts?: ExecOptions): Promise<ExecResult> {
    if (
      this.oneshot !== null &&
      argv[0] === "systemctl" &&
      (argv[1] === "restart" || argv[1] === "start") &&
      argv[2] === SECRETS_UNIT
    ) {
      await this.oneshot();
    }
    return super.exec(argv, opts);
  }

  /** Forget what ran, so the next step's commands stand alone. */
  reset(): void {
    this.commands.length = 0;
    this.execs.length = 0;
    this.restarted.length = 0;
    this.stopped.length = 0;
    this.daemonReloads.length = 0;
  }
}

/** The row, the bucket and SSM, serving whichever manifest `rollOut` was last given. */
function fleet(host: SwitchBox) {
  let current: AgentConfig | null = null;
  const ddb = new RecordingSink();
  ddb.byCommand.set("GetCommand", () => ({
    Item: {
      name: TEST_NAME,
      status: "ready",
      version: 3,
      resources: { config_key: `config/${TEST_NAME}/${current!.config_hash}.tgz`, ssm_paths: [] },
    },
  }));
  ddb.byCommand.set("UpdateCommand", () => ({}));
  ddb.byCommand.set("PutCommand", () => ({}));
  const s3 = new RecordingSink();
  s3.byCommand.set("GetObjectCommand", () => ({
    Body: new TextEncoder().encode(JSON.stringify({ manifest: current })),
  }));
  const ssm = new RecordingSink();
  ssm.byCommand.set("GetParameterCommand", (command) => {
    if ((command as GetParameterCommand).input.Name?.endsWith("/provider-key")) {
      return { Parameter: { Value: PROVIDER_KEY } };
    }
    const e = new Error("Parameter not found");
    e.name = "ParameterNotFound";
    return e;
  });
  const aws: Aws = makeAws({
    ddb,
    ssm,
    s3,
    agentsTable: TEST_AGENTS_TABLE,
    eventsTable: TEST_EVENTS_TABLE,
    now: () => host.now(),
  });
  host.seed(USER_DATA_JSON_PATH, makeUserDataJson());
  host.seed(FLEET_CACHE_PATH, JSON.stringify(makeFleetManifest()));
  let n = 0;
  return {
    aws,
    /** The real oneshot, wired to this fleet's SSM. */
    materialise: () => run(["secrets", "materialise"], host, { aws: () => aws }),
    /** `agent set` then a rollout: the row names `manifest`, and the box converges onto it. */
    async rollOut(manifest: AgentConfig) {
      current = manifest;
      n += 1;
      const request: ApplyRequest = {
        id: `req-${String(n)}`,
        config_hash: manifest.config_hash,
        issued_at: "2026-10-14T00:00:00.000Z",
        issued_by: "arn:aws:sts::123456789012:assumed-role/Admin/session",
      };
      return convergeOnce(
        {
          host,
          aws,
          name: TEST_NAME,
          bucket: TEST_BUCKET,
          paramPrefix: `/hermes/fxtr0001/${TEST_NAME}/`,
        },
        request,
        async () => false,
      );
    },
  };
}

/**
 * A box bootstrapped onto `manifest`: `03-config` left it at `MANIFEST_PATH`,
 * `04-apply` applied it, and a reboot's worth of state is there — the secrets
 * oneshot active.
 */
async function bootstrapped(
  manifest: AgentConfig,
): Promise<{ host: SwitchBox; f: ReturnType<typeof fleet> }> {
  const host = new SwitchBox();
  const f = fleet(host);
  host.seed(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "0640");
  await apply(manifest, { host, providerKey: PROVIDER_KEY });
  host.reset();
  return { host, f };
}

/** Where each provider keeps the agent's memory, and a file planted in each. */
const DATA: Record<MemoryProvider, Array<[string, string]>> = {
  holographic: [[`${HERMES_HOME}/memory_store.db`, "SQLite format 3\0holographic facts"]],
  hindsight: [
    [`${HERMES_ACCOUNT_HOME}/.pg0/PG_VERSION`, "17\n"],
    [`${HERMES_ACCOUNT_HOME}/.pg0/base/5/16384`, "hindsight memory rows"],
    [`${memoryServiceDir("hindsight")}/hf/hub/models--bge/blob`, "embedding weights"],
  ],
  openviking: [
    [`${memoryServiceDir("openviking")}/data/vectordb/store`, "openviking local store"],
    [`${memoryServiceDir("openviking")}/data-remote/vectordb/store`, "openviking remote store"],
  ],
  honcho: [
    [`${honchoPgDataDir}/base/16384/2619`, "honcho memory rows"],
    [`${honchoPgDataDir}/postgresql.auto.conf`, "# honcho tuned\n"],
  ],
};

/** Every path under which a provider's data, install or plugin lives. */
function rootsOf(provider: MemoryProvider): string[] {
  switch (provider) {
    case "holographic":
      return [`${HERMES_HOME}/memory_store.db`];
    case "hindsight":
      return [
        memoryServiceDir("hindsight"),
        `${HERMES_ACCOUNT_HOME}/.pg0`,
        hermesPluginDir("hindsight"),
      ];
    case "openviking":
      return [memoryServiceDir("openviking")];
    case "honcho":
      return [memoryServiceDir("honcho")];
  }
}

function plant(host: SwitchBox, provider: MemoryProvider): void {
  for (const [path, content] of DATA[provider]) host.seed(path, content, "0600");
}

/** Every file under `provider`'s roots, path → content. */
function snapshot(host: SwitchBox, provider: MemoryProvider): Map<string, string> {
  const roots = rootsOf(provider);
  const files = new Map<string, string>();
  for (const [path, file] of host.files) {
    if (roots.some((root) => path === root || path.startsWith(`${root}/`)))
      files.set(path, file.content);
  }
  return files;
}

/** Work that would mean a return re-installed or re-initialised anything. */
const INSTALL_WORK =
  /^(?:runuser -u hermes -- )?(?:apt-get install|uv (?!python find)|git clone|curl |\S+\/initdb |\S+\/postgres --single|\S+\/venv\/bin\/python -c import tiktoken|rm -rf )/;

/** Restarted `unit`, at its last restart, after `before`'s last. */
function restartedAfter(host: SwitchBox, unit: string, before: string): boolean {
  return (
    host.restarted.lastIndexOf(unit) > host.restarted.lastIndexOf(before) &&
    host.restarted.includes(before)
  );
}

describe("a memory switch away and back keeps the first provider's data and reuses it", () => {
  for (const [a, b] of [
    ["hindsight", "openviking"],
    ["honcho", "hindsight"],
    ["holographic", "honcho"],
  ] as const) {
    test(`${a} → ${b} → ${a}`, async () => {
      const { host, f } = await bootstrapped(agent(a));
      plant(host, a);
      const before = snapshot(host, a);
      for (const [path] of DATA[a]) expect(before.has(path)).toBe(true);

      // Away to b: a's units go, its data does not.
      expect((await f.rollOut(agent(b))).kind).toBe("applied");
      expect(snapshot(host, a)).toEqual(before);
      for (const root of rootsOf(a)) expectNotRan(host, `rm -rf ${esc(root)}(?:/|$)`);
      // The managed config moved, so both Hermes units restarted onto b.
      for (const unit of HERMES_UNITS) expect(host.restarted).toContain(unit);
      plant(host, b);
      host.reset();

      // Back to a: the same bytes, and none of the install work done again.
      expect((await f.rollOut(agent(a, { hash: `${a}-again` }))).kind).toBe("applied");
      expect(snapshot(host, a)).toEqual(before);
      expectNotRan(host, INSTALL_WORK);
      for (const unit of HERMES_UNITS) expect(host.restarted).toContain(unit);
      // And b's data is kept in its turn.
      for (const [path, content] of DATA[b]) expect(host.files.get(path)?.content).toBe(content);
    });
  }
});

describe("a memory switch to none", () => {
  test("honcho → none removes the units, the link and the credential, and keeps the data", async () => {
    const { host, f } = await bootstrapped(agent("honcho"));
    plant(host, "honcho");
    const before = snapshot(host, "honcho");
    expect(host.linkTargets.get(HONCHO_PLUGIN_CONFIG_LINK)).toBe(honchoClientConfPath);
    expect(host.files.has(MEMORY_LLM_ENV_PATH)).toBe(true);

    expect((await f.rollOut(agent("none"))).kind).toBe("applied");

    for (const unit of [MEMORY_DB_UNIT, MEMORY_SERVICE_UNIT, MEMORY_WORKER_UNIT]) {
      expect(host.stopped).toContain(unit);
      expect(host.enabledUnits.has(unit)).toBe(false);
      expect(host.files.has(unitPath(unit))).toBe(false);
      expect(host.restarted).not.toContain(unit);
    }
    // hermetic's own link goes; an operator's stays (`memory-honcho.test.ts`).
    expect(host.files.has(HONCHO_PLUGIN_CONFIG_LINK)).toBe(false);
    expect(host.files.has(MEMORY_LLM_ENV_PATH)).toBe(false);
    expect(snapshot(host, "honcho")).toEqual(before);
    for (const unit of HERMES_UNITS) expect(host.restarted).toContain(unit);
    expect(host.files.get("/etc/hermes/config.yaml")?.content).not.toContain("memory:");
  });

  test("hindsight → none keeps the cluster, the venv, the model cache and the plugin", async () => {
    const { host, f } = await bootstrapped(agent("hindsight"));
    plant(host, "hindsight");
    const before = snapshot(host, "hindsight");
    expect(before.has(`${hermesPluginDir("hindsight")}/__init__.py`)).toBe(true);

    expect((await f.rollOut(agent("none"))).kind).toBe("applied");

    expect(host.stopped).toContain(MEMORY_SERVICE_UNIT);
    expect(host.files.has(unitPath(MEMORY_SERVICE_UNIT))).toBe(false);
    expect(host.files.has(MEMORY_LLM_ENV_PATH)).toBe(false);
    expect(snapshot(host, "hindsight")).toEqual(before);
  });
});

describe("none → honcho, live, through a converge", () => {
  test("installs everything in order, then starts the server, then Hermes", async () => {
    const { host, f } = await bootstrapped(agent("none"));
    // A box that never had honcho has none of its directories: FakeHost
    // refuses a write into one nothing created, so a missing mkdir fails here.
    expect(host.dirs.has(memoryServiceDir("honcho"))).toBe(false);
    expect(host.dirs.has("/etc/postgresql-common/createcluster.d")).toBe(false);

    const outcome = await f.rollOut(agent("honcho"));
    expect(outcome.kind).toBe("applied");

    // The drop-in was on disk before apt installed Postgres.
    expect(host.files.has(HONCHO_CREATECLUSTER_CONF)).toBe(true);
    expect(host.confAtAptInstall).toBe(true);
    expect(
      ranInOrder(host, [
        /^apt-get update/,
        /^apt-get install .*postgresql-16/,
        /^uv python install 3\.13$/,
        / git clone .*\.src\.clone$/,
        / uv sync /,
        /import tiktoken/,
        /\/initdb /,
        /\/postgres --single .* -j honcho$/,
        `ln -s -T ${esc(honchoClientConfPath)} ${esc(HONCHO_PLUGIN_CONFIG_LINK)}$`,
        "^systemctl daemon-reload$",
        `^systemctl enable ${esc(MEMORY_DB_UNIT)}$`,
        `^systemctl restart ${esc(MEMORY_DB_UNIT)}$`,
        `^systemctl restart ${esc(MEMORY_SERVICE_UNIT)}$`,
        `^systemctl restart ${esc(MEMORY_WORKER_UNIT)}$`,
        `/dev/tcp/127\\.0\\.0\\.1/${String(MEMORY_SERVICES.honcho.port)}$`,
        "^systemctl restart hermes-dashboard\\.service$",
        "^systemctl restart hermes-gateway\\.service$",
      ]),
    ).toBe(true);
    expect(host.files.get(`${honchoPgDataDir}/PG_VERSION`)?.content).toBe("16\n");
    expect((await host.readdir(honchoTiktokenDir)).length).toBe(2);
    expect(host.files.get(MEMORY_LLM_ENV_PATH)?.content).toBe(`LLM_OPENAI_API_KEY="${PROVIDER_KEY}"\n`);
    for (const unit of MEMORY_SERVICE_UNITS) expect(host.enabledUnits.has(unit)).toBe(true);
    // Recorded as applied only now, by the apply itself; the manifest follows.
    expect(JSON.parse(host.files.get(APPLIED_CONFIG_PATH)!.content).config_hash).toBe("honcho-openai");
    expect(JSON.parse(host.files.get(MANIFEST_PATH)!.content).config_hash).toBe("honcho-openai");
  });
});

describe("Hermes waits for the memory server it was just given", () => {
  const PROBE = `/dev/tcp/127\\.0\\.0\\.1/${String(MEMORY_SERVICES.hindsight.port)}$`;

  test("polls until the server listens, then restarts Hermes", async () => {
    const { host, f } = await bootstrapped(agent("none"));
    let refused = 3;
    host.when(/\/dev\/tcp\//, () => (refused-- > 0 ? { code: 1, stderr: "Connection refused" } : null));
    host.sleeps.length = 0;

    await f.rollOut(agent("hindsight"));

    expectRan(host, PROBE, 4);
    expect(host.sleeps).toEqual([1000, 1000, 1000]);
    expect(
      ranInOrder(host, [
        `^systemctl restart ${esc(MEMORY_SERVICE_UNIT)}$`,
        PROBE,
        PROBE,
        PROBE,
        PROBE,
        "^systemctl restart hermes-dashboard\\.service$",
      ]),
    ).toBe(true);
  });

  test("gives up after the bound, says so, and starts Hermes anyway", async () => {
    const { host } = await bootstrapped(agent("none"));
    host.when(/\/dev\/tcp\//, { code: 1, stderr: "Connection refused" });
    host.sleeps.length = 0;
    const { emit, events } = collector();

    const result = await apply(agent("hindsight"), { host, providerKey: PROVIDER_KEY, emit });

    const waited = host.sleeps.reduce((sum, ms) => sum + ms, 0);
    expect(waited).toBe(MEMORY_READY_TIMEOUT_MS);
    expect(events.some((e) => e.message.includes("not listening on 127.0.0.1:8888"))).toBe(true);
    for (const unit of HERMES_UNITS) expect(result.restarted).toContain(unit);
    expect(restartedAfter(host, "hermes-dashboard.service", MEMORY_SERVICE_UNIT)).toBe(true);
  });

  test("an apply that does not restart the server does not wait for it", async () => {
    const { host } = await bootstrapped(agent("hindsight"));
    const changed = agent("hindsight");
    const config = changed.files.find((file) => file.path === "/etc/hermes/config.yaml")!;
    const moved = {
      ...changed,
      files: changed.files.map((file) =>
        file === config ? { ...file, content: `${file.content}# a Hermes-only change\n` } : file,
      ),
    };

    const result = await apply(moved, { host, providerKey: PROVIDER_KEY });

    expect(result.restarted).not.toContain(MEMORY_SERVICE_UNIT);
    for (const unit of HERMES_UNITS) expect(result.restarted).toContain(unit);
    expectNotRan(host, /\/dev\/tcp\//);
  });
});

describe("the secrets oneshot during a converge", () => {
  /**
   * A switch off a server provider in the same rollout as a vendor change:
   * the vendor moves the secrets unit's own file, so the units phase owes it a
   * restart — and the oneshot reads `MANIFEST_PATH`, which a converge moves
   * only after the apply succeeds.
   */
  const from = () => agent("hindsight", { vendor: "anthropic" });
  const to = () => agent("none", { vendor: "openai" });

  test("an active oneshot is not re-run, so the files are this config's", async () => {
    const { host, f } = await bootstrapped(from());
    host.oneshot = f.materialise;
    expect(host.files.get(MEMORY_LLM_ENV_PATH)).toBeDefined();

    expect((await f.rollOut(to())).kind).toBe("applied");

    expect(host.restarted).not.toContain(SECRETS_UNIT);
    expect(host.files.get(HERMES_USER_ENV)?.content).toBe(
      `${MANAGED_ENV_BEGIN}\nOPENAI_API_KEY="${PROVIDER_KEY}"\n${MANAGED_ENV_END}\n`,
    );
    expect(host.files.has(SECRETS_ENV_PATH)).toBe(false);
    expect(host.files.has(MEMORY_LLM_ENV_PATH)).toBe(false);
    // What `Requires=` would have restarted with it, restarted explicitly.
    for (const unit of HERMES_UNITS) expect(host.restarted).toContain(unit);
    expect(out.stderr).not.toContain(PROVIDER_KEY);
  });

  test("an inactive oneshot is started, and this config's files are put back after it", async () => {
    const { host, f } = await bootstrapped(from());
    host.oneshot = f.materialise;
    host.when(`^systemctl is-active ${esc(SECRETS_UNIT)}$`, { code: 3, stdout: "failed\n" });

    expect((await f.rollOut(to())).kind).toBe("applied");

    expect(host.restarted[0]).toBe(SECRETS_UNIT);
    expect(host.files.get(HERMES_USER_ENV)?.content).toBe(
      `${MANAGED_ENV_BEGIN}\nOPENAI_API_KEY="${PROVIDER_KEY}"\n${MANAGED_ENV_END}\n`,
    );
    expect(host.files.has(SECRETS_ENV_PATH)).toBe(false);
    expect(host.files.has(MEMORY_LLM_ENV_PATH)).toBe(false);
    for (const unit of HERMES_UNITS) expect(restartedAfter(host, unit, SECRETS_UNIT)).toBe(true);
  });

  test("a bootstrap still starts the oneshot on a new box", async () => {
    const host = new SwitchBox();
    const result = await apply(agent("hindsight"), { host, providerKey: PROVIDER_KEY });
    expect(result.restarted[0]).toBe(SECRETS_UNIT);
    expect(restartedAfter(host, MEMORY_SERVICE_UNIT, SECRETS_UNIT)).toBe(true);
    expect(restartedAfter(host, "hermes-dashboard.service", MEMORY_SERVICE_UNIT)).toBe(true);
  });
});

describe("the apt index in a long-lived serve", () => {
  test("every converge that installs a package refreshes the index first", async () => {
    const { host, f } = await bootstrapped(agent("none"));
    expect((await f.rollOut(agent("honcho"))).kind).toBe("applied");
    expectRan(host, /^apt-get update/, 1);
    expect(ranInOrder(host, [/^apt-get update/, /^apt-get install .*postgresql-16/])).toBe(true);
    host.reset();

    // Days later in the same process: another package to install.
    const later = agent("honcho", { hash: "honcho-later" });
    const withPackage = { ...later, packages: [...later.packages, "sqlite3"] };
    expect((await f.rollOut(withPackage)).kind).toBe("applied");
    expect(ranInOrder(host, [/^apt-get update/, /^apt-get install .*sqlite3/])).toBe(true);
  });
});
