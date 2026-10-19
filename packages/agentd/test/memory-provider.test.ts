/**
 * The box half of the external memory provider: the provider's Python
 * dependencies in Hermes's venv (`memory-provider`), and for a service
 * provider the pinned server itself (`memory-service`) — its venv, model and
 * Hermes plugin, the credential file its unit reads, and the unit's removal
 * when the agent no longer has one.
 *
 * Manifests are the fixture's plus what core renders for a service provider
 * (the unit, the server's config), written out by hand here: this suite is
 * about what the box does with such a manifest, not about the renderer.
 */
import { describe, expect, test } from "bun:test";
import { GetParameterCommand } from "@aws-sdk/client-ssm";
import type { AgentConfig, ApplyRequest, RenderedFile } from "@hermetic/core/schema";
import {
  HERMES_HOME,
  MEMORY_LLM_ENV_PATH,
  MEMORY_SERVICES,
  MEMORY_SERVICE_ROOT,
  MEMORY_SERVICE_UNIT,
  PRISM_DATA_DIR,
  PRISM_FASTEMBED_DIR,
  PRISM_PORT,
  PRISM_TIKTOKEN_DIR,
  hermesMemoryProviderName,
  hermesPluginDir,
  memoryServiceDir,
  openvikingConfPath,
} from "@hermetic/core/shared";
import {
  MEMORY_PIN_MARKER,
  MEMORY_SERVICE_UNIT_PATH,
  PLUGIN_REF_MARKER,
  SECRETS_ENV_PATH,
  apply,
  importNameOf,
} from "../src/apply/index.ts";
import { HERMES_VENV_DIR } from "../src/apply/hermes.ts";
import { PRISM_CACHE_MARKER } from "../src/apply/memory-service.ts";
import { NET_ATTEMPTS } from "../src/apply/memory-shared.ts";
import { BUNDLED_MEMORY_PLUGINS } from "../src/apply/plugins.ts";
import { makeAws } from "../src/aws.ts";
import { convergeOnce } from "../src/converge.ts";
import { AgentdError } from "../src/errors.ts";
import { collector } from "../src/events.ts";
import { FLEET_CACHE_PATH } from "../src/fleet.ts";
import { checkHermes } from "../src/hermes-check.ts";
import { HERMETICD_CAPABILITIES, MANIFEST_PATH } from "../src/manifest.ts";
import { run } from "../src/main.ts";
import { USER_DATA_JSON_PATH } from "../src/userdata.ts";
import { BoxHost, fakeConfigBundle } from "./fake-box.ts";
import { expectNotRan, expectRan, ran } from "./fake-host.ts";
import { MemoryBox, blob, parseBlob } from "./memory-box.ts";
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
import { captureOutput } from "./quiet.ts";

const out = captureOutput();

/**
 * The agent's provider key. A space and a `#` so `envLine` quotes it, and no
 * shape any redaction pattern knows, so only never emitting it keeps it out.
 */
const PROVIDER_KEY = "FIXTURE anthropic #key";
const HINDSIGHT = MEMORY_SERVICES.hindsight;
const OPENVIKING = MEMORY_SERVICES.openviking;
const PLUGIN = HINDSIGHT.plugin!;
const MODEL = OPENVIKING.model!;
const HERMES_PYTHON = `${HERMES_VENV_DIR}/bin/python`;
const HINDSIGHT_DIR = memoryServiceDir("hindsight");
const OPENVIKING_DIR = memoryServiceDir("openviking");
const PLUGIN_DIR = hermesPluginDir("hindsight");
const MODEL_PATH = `${OPENVIKING_DIR}/models/${MODEL.file}`;

type ServiceProvider = "hindsight" | "openviking" | "prism";

function unitFile(provider: ServiceProvider): RenderedFile {
  const spec = MEMORY_SERVICES[provider];
  return {
    path: MEMORY_SERVICE_UNIT_PATH,
    mode: "0644",
    content:
      "[Service]\nUser=hermes\n" +
      `EnvironmentFile=${MEMORY_LLM_ENV_PATH}\n` +
      `ExecStart=${memoryServiceDir(provider)}/venv/bin/${spec.command} --host 127.0.0.1 --port ${spec.port}\n`,
  };
}

/** A service provider's manifest: the fixture's, plus the unit and the server's config. */
function serviceManifest(
  provider: ServiceProvider,
  options: {
    vendor?: "anthropic" | "bedrock";
    pin?: string;
    key_env?: NonNullable<NonNullable<AgentConfig["memory"]>["llm"]>["key_env"];
  } = {},
): AgentConfig {
  const vendor = options.vendor ?? "anthropic";
  const base = makeManifest({
    provider: vendor,
    memory: {
      provider,
      pin: options.pin ?? MEMORY_SERVICES[provider].pin,
      // prism stores without extraction, so its server makes no model calls.
      ...(provider === "prism"
        ? {}
        : {
            llm: {
              vendor,
              model: "FIXTURE-model",
              key_env: options.key_env ?? (vendor === "bedrock" ? [] : ["HINDSIGHT_API_LLM_API_KEY"]),
            },
          }),
    },
    units: [
      "hermeticd.service",
      "hermes-dashboard.service",
      "hermes-gateway.service",
      MEMORY_SERVICE_UNIT,
    ],
  });
  // Hindsight's plugin is configured by env lines in the Hermes units, so only
  // OpenViking has a config file of its own.
  const config: RenderedFile[] =
    provider === "openviking"
      ? [
          {
            path: openvikingConfPath,
            mode: "0640",
            content: '{"server":{"host":"127.0.0.1","port":1933}}\n',
            owner: "root",
            group: "hermes",
          },
        ]
      : [];
  return { ...base, files: [...base.files, unitFile(provider), ...config] };
}

function openvikingBox(): MemoryBox {
  const host = new MemoryBox();
  host.curlBodies.set(MODEL.url, blob(MODEL.sha256, MODEL.size));
  return host;
}

/** The commands that would mean the second apply did install work. */
const NETWORK_WORK = /^(?:runuser -u hermes -- )?(?:uv |git clone|git -C \S+\.clone|curl )/;

/** Every file under `/data` or `/etc/hermetic` whose content holds `secret`. */
function leaks(host: MemoryBox, secret: string): string[] {
  return [...host.files]
    .filter(
      ([path, f]) =>
        (path.startsWith("/data/") || path.startsWith("/etc/hermetic/")) && f.content.includes(secret),
    )
    .map(([path]) => path);
}

describe("capabilities", () => {
  test("hermeticd advertises both memory capabilities", () => {
    expect(HERMETICD_CAPABILITIES.has("memory-provider")).toBe(true);
    expect(HERMETICD_CAPABILITIES.has("memory-service")).toBe(true);
  });

  test("distribution specs map to the module they import as", () => {
    expect(importNameOf("hindsight-client==0.10.3")).toBe("hindsight_client");
    expect(importNameOf("numpy")).toBe("numpy");
  });
});

describe("hindsight", () => {
  test("installs the server, the plugin and the client, and starts the unit", async () => {
    const host = new MemoryBox();
    const result = await apply(serviceManifest("hindsight"), { host, providerKey: PROVIDER_KEY });

    // The dirs, as the account.
    expectRan(host, `^runuser -u hermes -- install -d -m 0750 ${MEMORY_SERVICE_ROOT}$`);
    expectRan(host, `^runuser -u hermes -- install -d -m 0750 ${HINDSIGHT_DIR}/hf$`);
    // The venv, as the account, then the pinned server into it.
    expectRan(
      host,
      `^runuser -u hermes -- uv venv --no-config --python 3\\.11 ${HINDSIGHT_DIR}/venv$`,
      1,
    );
    const pip = ran(
      host,
      `^runuser -u hermes -- uv pip install .*--python ${HINDSIGHT_DIR}/venv/bin/python`,
    );
    expect(pip).toHaveLength(1);
    expect(pip[0]!.split(" ")).toContain("hindsight-all==0.10.3");
    // The wheel cache would otherwise land on the data volume, under the account's HOME.
    expect(pip[0]!.split(" ")).toContain("--no-cache");
    // Nothing re-owns the service tree recursively.
    expectNotRan(host, `chown -R .*${MEMORY_SERVICE_ROOT}`);
    expect(host.files.get(`${HINDSIGHT_DIR}/${MEMORY_PIN_MARKER}`)?.content).toBe(`${HINDSIGHT.pin}\n`);

    // The plugin, at the pinned commit, as the account.
    expectRan(
      host,
      `^runuser -u hermes -- git clone --filter=blob:none --no-checkout --quiet ${PLUGIN.repo} `,
      1,
    );
    expectRan(
      host,
      `^runuser -u hermes -- git -C \\S+ sparse-checkout set --no-cone ${PLUGIN.subdir}$`,
      1,
    );
    expectRan(host, `^runuser -u hermes -- git -C \\S+ checkout --quiet ${PLUGIN.sha}$`, 1);
    expect(host.files.get(`${PLUGIN_DIR}/plugin.yaml`)?.content).toContain(PLUGIN.sha);
    expect(host.files.get(`${PLUGIN_DIR}/${PLUGIN_REF_MARKER}`)?.content).toBe(`${PLUGIN.sha}\n`);
    expect([...host.files.keys()].filter((p) => p.includes(".hindsight.clone"))).toEqual([]);

    // The client side, in Hermes's venv.
    expectRan(host, `^uv pip install --python ${HERMES_PYTHON} hindsight-client==0\\.10\\.3$`, 1);

    // The unit: landed, enabled, started.
    expect(host.files.get(MEMORY_SERVICE_UNIT_PATH)?.content).toContain("127.0.0.1");
    expect(host.enabledUnits.has(MEMORY_SERVICE_UNIT)).toBe(true);
    expect(result.restarted).toContain(MEMORY_SERVICE_UNIT);

    // The credential: tmpfs, root-only, under the server's name, nowhere else.
    const env = host.files.get(MEMORY_LLM_ENV_PATH);
    expect(env?.mode).toBe("0600");
    expect(env?.content).toBe("HINDSIGHT_API_LLM_API_KEY='FIXTURE anthropic #key'\n");
    expect(leaks(host, PROVIDER_KEY)).toEqual([]);
    // Only Hermes's own variable in Hermes's environment file.
    expect(host.files.get(SECRETS_ENV_PATH)?.content).not.toContain("HINDSIGHT_API_LLM_API_KEY");
  });

  test("the key never reaches stdout, stderr, events or argv", async () => {
    const host = new MemoryBox();
    const { emit, events } = collector();
    await apply(serviceManifest("hindsight"), { host, emit, providerKey: PROVIDER_KEY });
    expect(out.stdout).not.toContain(PROVIDER_KEY);
    expect(out.stderr).not.toContain(PROVIDER_KEY);
    expect(JSON.stringify(events)).not.toContain(PROVIDER_KEY);
    expect(host.commands.join("\n")).not.toContain(PROVIDER_KEY);
  });

  test("a second apply on the converged box installs nothing and restarts nothing", async () => {
    const host = new MemoryBox();
    const manifest = serviceManifest("hindsight");
    await apply(manifest, { host, providerKey: PROVIDER_KEY });

    host.commands.length = 0;
    host.restarted.length = 0;
    const second = await apply(manifest, { host, providerKey: PROVIDER_KEY });
    expect(host.commands.filter((c) => NETWORK_WORK.test(c))).toEqual([]);
    expect(second.restarted).toEqual([]);
    expect(host.restarted).toEqual([]);
    expect(second.installed).toEqual([]);
  });

  test("a dry run reports the install and runs none of it", async () => {
    const host = new MemoryBox();
    const plan = await apply(serviceManifest("hindsight"), {
      host,
      providerKey: PROVIDER_KEY,
      dryRun: true,
    });
    expect(plan.installed).toContain(`memory:${HINDSIGHT.pin}`);
    expect(plan.installed).toContain(`plugin:hindsight@${PLUGIN.sha}`);
    expect(
      host.commands.filter((c) => /^runuser -u hermes -- (uv|git|curl|install|tee|mv|rm) /.test(c)),
    ).toEqual([]);
    expect(host.files.has(MEMORY_LLM_ENV_PATH)).toBe(false);
  });

  /**
   * Bedrock, so the provider-key check before it has nothing to refuse, with a
   * `key_env` core would never render for it: what refuses is `memoryLlmFor`.
   */
  test("a key_env with no provider key resolved is refused before either file", async () => {
    const host = new MemoryBox();
    const manifest = serviceManifest("hindsight", {
      vendor: "bedrock",
      key_env: ["HINDSIGHT_API_LLM_API_KEY"],
    });
    const refused = await apply(manifest, { host }).catch((e) => e);
    expect((refused as AgentdError).code).toBe("INTERNAL");
    expect((refused as AgentdError).message).toContain("HINDSIGHT_API_LLM_API_KEY");
    expect(host.files.has(MEMORY_LLM_ENV_PATH)).toBe(false);
    expect(host.files.has(SECRETS_ENV_PATH)).toBe(false);
  });

  test("a venv whose interpreter went with the root volume is rebuilt with --clear", async () => {
    const host = new MemoryBox();
    const manifest = serviceManifest("hindsight");
    await apply(manifest, { host, providerKey: PROVIDER_KEY });
    // The first build had nothing to clear.
    expectNotRan(host, /uv venv .*--clear/);

    // A recreate: the data volume keeps the venv and its marker, the new root
    // volume has no interpreter for `bin/python` to point at.
    host.files.delete(`${HINDSIGHT_DIR}/venv/bin/python`);
    host.commands.length = 0;
    const result = await apply(manifest, { host, providerKey: PROVIDER_KEY });
    expectRan(
      host,
      `^runuser -u hermes -- uv venv --no-config --clear --python 3\\.11 ${HINDSIGHT_DIR}/venv$`,
      1,
    );
    expectRan(
      host,
      `^runuser -u hermes -- uv pip install .*--python ${HINDSIGHT_DIR}/venv/bin/python`,
      1,
    );
    expect(result.restarted).toContain(MEMORY_SERVICE_UNIT);
  });
});

describe("openviking", () => {
  test("installs from upstream's wheel index, seeds the model, lands ov.conf", async () => {
    const host = openvikingBox();
    await apply(serviceManifest("openviking", { vendor: "bedrock" }), { host });

    const pip = ran(
      host,
      `^runuser -u hermes -- uv pip install .*--python ${OPENVIKING_DIR}/venv/bin/python`,
    );
    expect(pip).toHaveLength(1);
    const argv = pip[0]!.split(" ");
    expect(
      argv.slice(argv.indexOf("--extra-index-url"), argv.indexOf("--extra-index-url") + 2),
    ).toEqual(["--extra-index-url", OPENVIKING.extra_index[0]!]);
    expect(argv.slice(argv.indexOf("--only-binary"), argv.indexOf("--only-binary") + 2)).toEqual([
      "--only-binary",
      "llama-cpp-python",
    ]);
    expect(argv).toContain("openviking[local-embed]==0.5.0");

    expectRan(
      host,
      `^runuser -u hermes -- curl -fsSL --retry 3 -o \\S+ ${MODEL.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      1,
    );
    expect(parseBlob(host.files.get(MODEL_PATH)?.content)).toEqual({
      sha: MODEL.sha256,
      size: MODEL.size,
    });
    expect([...host.files.keys()].filter((p) => p.endsWith(".part"))).toEqual([]);
    expect(host.files.get(openvikingConfPath)?.content).toContain("127.0.0.1");
    expect(host.files.get(openvikingConfPath)?.ownership).toBe("root:hermes");
    expectRan(host, `^runuser -u hermes -- install -d -m 0750 ${OPENVIKING_DIR}/data$`, 1);
    expectRan(host, `^runuser -u hermes -- install -d -m 0750 ${OPENVIKING_DIR}/data-remote$`, 1);

    // Bedrock: no key, and still the file the unit's `EnvironmentFile=` names.
    expect(host.files.get(MEMORY_LLM_ENV_PATH)).toEqual({ content: "\n", mode: "0600" });
    // No plugin to check out, no client to install: both are upstream's.
    expectNotRan(host, /git clone --filter/);
    expectNotRan(host, ` -c import `);
  });

  test("the model is fetched only when missing or wrong", async () => {
    const host = openvikingBox();
    const manifest = serviceManifest("openviking", { vendor: "bedrock" });
    await apply(manifest, { host });

    host.commands.length = 0;
    await apply(manifest, { host });
    expectNotRan(host, /^runuser -u hermes -- curl /);

    // Swapped on the box since: replaced with the pinned file.
    host.files.set(MODEL_PATH, { content: blob("0".repeat(64), MODEL.size), mode: "0644" });
    host.commands.length = 0;
    const repaired = await apply(manifest, { host });
    expectRan(host, /^runuser -u hermes -- curl /, 1);
    expect(repaired.installed).toEqual([`model:${MODEL.file}`]);
    expect(parseBlob(host.files.get(MODEL_PATH)?.content)?.sha).toBe(MODEL.sha256);
    expect(repaired.restarted).toContain(MEMORY_SERVICE_UNIT);
  });

  test("a download that is not the pinned file fails and leaves nothing behind", async () => {
    const host = new MemoryBox();
    host.curlBodies.set(MODEL.url, blob("f".repeat(64), MODEL.size));
    const refused = await apply(serviceManifest("openviking", { vendor: "bedrock" }), { host }).catch(
      (e) => e,
    );
    expect(refused).toBeInstanceOf(AgentdError);
    expect((refused as AgentdError).code).toBe("CHECKSUM_MISMATCH");
    expect([...host.files.keys()].filter((p) => p.startsWith(`${OPENVIKING_DIR}/models/`))).toEqual([]);
  });

  test("a second apply on the converged box installs nothing and restarts nothing", async () => {
    const host = openvikingBox();
    const manifest = serviceManifest("openviking", { vendor: "bedrock" });
    await apply(manifest, { host });
    host.commands.length = 0;
    host.restarted.length = 0;
    const second = await apply(manifest, { host });
    expect(host.commands.filter((c) => NETWORK_WORK.test(c))).toEqual([]);
    expect(second.restarted).toEqual([]);
  });
});

describe("prism", () => {
  const PRISM = MEMORY_SERVICES.prism;
  const PRISM_DIR = memoryServiceDir("prism");
  const PRME_DIR = `${HERMES_HOME}/plugins/prme`;
  const FILES = BUNDLED_MEMORY_PLUGINS.prism!;

  test("installs the server and the bundled prme plugin, as the account", async () => {
    const host = new MemoryBox();
    const result = await apply(serviceManifest("prism"), { host, providerKey: PROVIDER_KEY });

    expectRan(host, `^runuser -u hermes -- install -d -m 0750 ${PRISM_DATA_DIR}$`, 1);
    expectRan(host, `^runuser -u hermes -- install -d -m 0750 ${PRISM_FASTEMBED_DIR}$`, 1);
    expectRan(host, `^runuser -u hermes -- install -d -m 0750 ${PRISM_TIKTOKEN_DIR}$`, 1);
    const pip = ran(
      host,
      `^runuser -u hermes -- uv pip install .*--python ${PRISM_DIR}/venv/bin/python`,
    );
    expect(pip).toHaveLength(1);
    const argv = pip[0]!.split(" ");
    // The server first, then its storage and embedding stack, every one exact.
    const specs = argv.slice(argv.indexOf("prme[api]==0.16.0a3"));
    expect(specs).toEqual([...PRISM.packages]);
    expect(specs.every((p) => /^[a-z[\]-]+==\S+$/.test(p))).toBe(true);
    expect(specs).toEqual(
      expect.arrayContaining(["duckdb==1.4.4", "fastembed==0.7.4", "tiktoken==0.12.0"]),
    );
    const binaries = argv.flatMap((a, i) => (a === "--only-binary" ? [argv[i + 1]] : []));
    expect(binaries).toEqual([
      "duckdb",
      "usearch",
      "tantivy",
      "onnxruntime",
      "tokenizers",
      "tiktoken",
      "py-rust-stemmers",
      "cryptography",
      "pillow",
      "numpy",
    ]);
    expect(host.files.get(`${PRISM_DIR}/${MEMORY_PIN_MARKER}`)?.content).toBe(`${PRISM.pin}\n`);

    // Hermes knows the provider as `prme`; the plugin is hermeticd's own, written by the account.
    expect(hermesPluginDir(hermesMemoryProviderName("prism"))).toBe(PRME_DIR);
    for (const { name, content } of FILES) {
      const file = host.files.get(`${PRME_DIR}/${name}`);
      expect(file?.content).toBe(content);
      expect(file?.ownership).toBe("hermes:hermes");
      expect(file?.mode).toBe("0644");
    }
    expect(
      host.streamWrites.filter((w) => w.path.startsWith(`${PRME_DIR}/`)).map((w) => w.user),
    ).toEqual(["hermes", "hermes"]);
    expectNotRan(host, /git clone --filter/);
    expect(result.installed).toEqual(expect.arrayContaining([`memory:${PRISM.pin}`, "plugin:prism"]));
    expect(result.restarted).toContain(MEMORY_SERVICE_UNIT);
  });

  const WARM = `^runuser -u hermes -- ${PRISM_DIR}/venv/bin/python -c from fastembed import TextEmbedding; .*import tiktoken`;

  test("warms fastembed's model and tiktoken's encoding at install, into the unit's caches, once", async () => {
    const host = new MemoryBox();
    const manifest = serviceManifest("prism");
    await apply(manifest, { host, providerKey: PROVIDER_KEY });
    expectRan(host, WARM, 1);
    expect(host.commands.join("\n")).toContain("TextEmbedding('BAAI/bge-small-en-v1.5')");
    // The fake fills the directories the warm-up's env names: the unit's.
    expect(
      host.files.has(`${PRISM_FASTEMBED_DIR}/models--qdrant--bge-small-en-v1.5-onnx-q/model.onnx`),
    ).toBe(true);
    expect(host.files.has(`${PRISM_TIKTOKEN_DIR}/9b5ad71b2ce5302211f9c61530b329a4922fc6a4`)).toBe(true);
    // The marker, by the account, only after the warm-up ran.
    const marker = `${PRISM_DIR}/${PRISM_CACHE_MARKER}`;
    expect(host.files.get(marker)?.content).toBe(
      "BAAI/bge-small-en-v1.5 cl100k_base fastembed==0.7.4\n",
    );
    expect(host.files.get(marker)?.ownership).toBe("hermes:hermes");

    // Converged: the marker answers, nothing is fetched.
    host.commands.length = 0;
    await apply(manifest, { host, providerKey: PROVIDER_KEY });
    expectNotRan(host, WARM);

    // A stale marker (another fastembed) or none warms again.
    for (const stale of ["BAAI/bge-small-en-v1.5 cl100k_base fastembed==0.7.3\n", null]) {
      if (stale === null) host.files.delete(marker);
      else host.seed(marker, stale);
      host.commands.length = 0;
      await apply(manifest, { host, providerKey: PROVIDER_KEY });
      expectRan(host, WARM, 1);
      expect(host.files.get(marker)?.content).toBe(
        "BAAI/bge-small-en-v1.5 cl100k_base fastembed==0.7.4\n",
      );
    }
  });

  test("an interrupted download that left caches behind, but no marker, is warmed again", async () => {
    const host = new MemoryBox();
    const manifest = serviceManifest("prism");
    await apply(manifest, { host, providerKey: PROVIDER_KEY });
    // What a killed hf_hub fetch leaves: the model's directory, a partial blob, the encoding.
    host.files.delete(`${PRISM_DIR}/${PRISM_CACHE_MARKER}`);
    host.seed(
      `${PRISM_FASTEMBED_DIR}/models--qdrant--bge-small-en-v1.5-onnx-q/blobs/ab.incomplete`,
      "",
    );
    host.commands.length = 0;
    await apply(manifest, { host, providerKey: PROVIDER_KEY });
    expectRan(host, WARM, 1);
  });

  test("a warm-up that keeps failing fails the apply, leaves no marker, and is retried next apply", async () => {
    const host = new MemoryBox();
    const manifest = serviceManifest("prism");
    const marker = `${PRISM_DIR}/${PRISM_CACHE_MARKER}`;
    host.warmFails = true;
    const failed = await apply(manifest, { host, providerKey: PROVIDER_KEY }).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(AgentdError);
    expect((failed as AgentdError).code).toBe("COMMAND_FAILED");
    expect((failed as AgentdError).message).toContain("could not warm the prism caches");
    expectRan(host, WARM, NET_ATTEMPTS);
    expect(host.files.has(marker)).toBe(false);

    host.warmFails = false;
    host.commands.length = 0;
    await apply(manifest, { host, providerKey: PROVIDER_KEY });
    expectRan(host, WARM, 1);
    expect(host.files.get(marker)?.content).toBe(
      "BAAI/bge-small-en-v1.5 cl100k_base fastembed==0.7.4\n",
    );
  });

  test("a plugin that cannot be written fails the apply, unlike hermetic-files", async () => {
    const host = new MemoryBox();
    host.dirs.add(PRME_DIR);
    host.symlinks.add(PRME_DIR);
    const refused = await apply(serviceManifest("prism"), { host, providerKey: PROVIDER_KEY }).catch(
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toContain(PRME_DIR);
    expect(host.streamWrites.filter((w) => w.path.startsWith(`${PRME_DIR}/`))).toEqual([]);
  });

  test("a second apply on the converged box installs nothing and restarts nothing", async () => {
    const host = new MemoryBox();
    const manifest = serviceManifest("prism");
    await apply(manifest, { host, providerKey: PROVIDER_KEY });

    host.commands.length = 0;
    host.restarted.length = 0;
    host.streamWrites.length = 0;
    const second = await apply(manifest, { host, providerKey: PROVIDER_KEY });
    expect(host.commands.filter((c) => NETWORK_WORK.test(c))).toEqual([]);
    expect(host.streamWrites.filter((w) => w.path.startsWith(`${PRME_DIR}/`))).toEqual([]);
    expect(second.installed).toEqual([]);
    expect(second.restarted).toEqual([]);
  });

  test("a dry run reports the plugin and writes none of it", async () => {
    const host = new MemoryBox();
    const { emit, events } = collector();
    const plan = await apply(serviceManifest("prism"), {
      host,
      emit,
      providerKey: PROVIDER_KEY,
      dryRun: true,
    });
    expect(plan.installed).toEqual(expect.arrayContaining([`memory:${PRISM.pin}`, "plugin:prism"]));
    expect(host.streamWrites.filter((w) => w.path.startsWith(`${PRME_DIR}/`))).toEqual([]);
    expect(host.commands.filter((c) => c.includes(PRME_DIR))).toEqual([]);
    // The warm-up is reported, not run, and no marker claims it.
    expect(events.some((e) => e.message.includes("fetching the prism embedding model"))).toBe(true);
    expectNotRan(host, WARM);
    expect(host.files.has(`${PRISM_DIR}/${PRISM_CACHE_MARKER}`)).toBe(false);
  });

  test("the embedded plugin is the one in the source tree, at the pin's plugin version", async () => {
    const dir = new URL("../plugins/prme/", import.meta.url);
    for (const { name, content } of FILES) {
      expect(content).toBe(await Bun.file(new URL(name, dir)).text());
    }
    expect(FILES.map((f) => f.name).sort()).toEqual(["__init__.py", "plugin.yaml"]);
    const manifest = FILES.find((f) => f.name === "plugin.yaml")!.content;
    expect(manifest).toContain("name: prme\n");
    const version = /^version: "([^"]+)"$/m.exec(manifest)?.[1];
    expect(PRISM.pin.endsWith(`+plugin-${version}`)).toBe(true);
    // Hermes's discovery reads the text, not the module (`_is_memory_provider_dir`).
    expect(FILES.find((f) => f.name === "__init__.py")!.content).toContain("register_memory_provider");
  });

  test("the plugin only speaks HTTP: the server is the one process that opens the pack", () => {
    const init = FILES.find((f) => f.name === "__init__.py")!.content;
    expect(init).not.toMatch(/^\s*(?:import prme|from prme)\b/m);
    expect(init).not.toContain("MemoryClient");
  });

  test("the plugin defaults to the port the unit serves on", () => {
    const init = FILES.find((f) => f.name === "__init__.py")!.content;
    expect(init).toContain(`DEFAULT_API_URL = "http://127.0.0.1:${PRISM_PORT}"`);
  });

  test("hermeticd advertises memory-prism", () => {
    expect(HERMETICD_CAPABILITIES.has("memory-prism")).toBe(true);
  });
});

describe("the pin", () => {
  test("a pin this hermeticd does not install is refused before any command runs", async () => {
    const host = new MemoryBox();
    const refused = await apply(serviceManifest("hindsight", { pin: "hindsight-all==9.9.9" }), {
      host,
      providerKey: PROVIDER_KEY,
    }).catch((e) => e);
    expect(refused).toBeInstanceOf(AgentdError);
    expect((refused as AgentdError).code).toBe("MANIFEST_REFUSED");
    expect((refused as AgentdError).message).toContain("hindsight-all==9.9.9");
    expect((refused as AgentdError).message).toContain(HINDSIGHT.pin);
    expect(host.commands).toEqual([]);
    expect(host.files.size).toBe(0);
  });

  test("a pin on an in-process provider is refused too", async () => {
    const host = new MemoryBox();
    const manifest = makeManifest({ memory: { provider: "holographic", pin: "numpy==1" } });
    const refused = await apply(manifest, { host }).catch((e) => e);
    expect((refused as AgentdError).code).toBe("MANIFEST_REFUSED");
    expect(host.commands).toEqual([]);
  });
});

describe("removal", () => {
  /** A box that ran hindsight, now given a manifest with `memory`. */
  function formerHindsightBox(): MemoryBox {
    const host = new MemoryBox();
    host.seed(MEMORY_SERVICE_UNIT_PATH, unitFile("hindsight").content);
    host.enabledUnits.add(MEMORY_SERVICE_UNIT);
    host.runningUnits.add(MEMORY_SERVICE_UNIT);
    host.seed(`${HINDSIGHT_DIR}/pg/PG_VERSION`, "16\n");
    host.seed(MEMORY_LLM_ENV_PATH, "HINDSIGHT_API_LLM_API_KEY=FIXTURE-old\n", "0600");
    return host;
  }

  for (const [label, memory] of [
    ["no provider", undefined],
    ["an in-process provider", { provider: "holographic" as const }],
  ] as const) {
    test(`a recreate onto ${label} stops and removes the unit, keeping the data`, async () => {
      const host = formerHindsightBox();
      host.hermesModules.add("numpy");
      const result = await apply(makeManifest(memory ? { memory } : {}), { host });

      expect(host.stopped).toContain(MEMORY_SERVICE_UNIT);
      expect(host.enabledUnits.has(MEMORY_SERVICE_UNIT)).toBe(false);
      expect(host.files.has(MEMORY_SERVICE_UNIT_PATH)).toBe(false);
      expect(result.changed).toContain(MEMORY_SERVICE_UNIT_PATH);
      expect(host.files.get(`${HINDSIGHT_DIR}/pg/PG_VERSION`)?.content).toBe("16\n");
      expect(host.files.has(MEMORY_LLM_ENV_PATH)).toBe(false);
      expect(host.daemonReloads.length).toBeGreaterThan(0);
    });
  }
});

describe("holographic", () => {
  test("only numpy, in Hermes's venv: no server, no credential file", async () => {
    const host = new MemoryBox();
    const manifest = makeManifest({ memory: { provider: "holographic" } });
    const first = await apply(manifest, { host });
    expectRan(host, `^${HERMES_PYTHON} -c import numpy$`, 1);
    expectRan(host, `^uv pip install --python ${HERMES_PYTHON} numpy$`, 1);
    expect(first.installed).toContain("pip:numpy");
    expect(first.restarted.sort()).toEqual(
      ["hermes-dashboard.service", "hermes-gateway.service", "hermeticd.service"].sort(),
    );
    expectNotRan(host, MEMORY_SERVICE_ROOT);
    expectNotRan(host, /^runuser -u hermes -- (uv pip|git|curl)/);
    expect(host.files.has(MEMORY_LLM_ENV_PATH)).toBe(false);

    host.commands.length = 0;
    const second = await apply(manifest, { host });
    expectRan(host, `^${HERMES_PYTHON} -c import numpy$`, 1);
    expectNotRan(host, /uv pip install/);
    expect(second.restarted).toEqual([]);
  });
});

function parameterNotFound(): Error {
  const e = new Error("Parameter not found");
  e.name = "ParameterNotFound";
  return e;
}

describe("the boot oneshot and converge", () => {
  /** A box with `manifest` on disk and SSM answering the provider-key slot. */
  function rig(manifest: AgentConfig) {
    const host = new MemoryBox();
    host.seed(USER_DATA_JSON_PATH, makeUserDataJson());
    host.seed(FLEET_CACHE_PATH, JSON.stringify(makeFleetManifest()));
    host.seed(MANIFEST_PATH, JSON.stringify(manifest));
    const ssm = new RecordingSink();
    ssm.byCommand.set("GetParameterCommand", (command) =>
      (command as GetParameterCommand).input.Name?.endsWith("/provider-key")
        ? { Parameter: { Value: PROVIDER_KEY } }
        : parameterNotFound(),
    );
    const aws = makeAws({
      ddb: new RecordingSink(),
      ssm,
      s3: new RecordingSink(),
      agentsTable: TEST_AGENTS_TABLE,
      eventsTable: TEST_EVENTS_TABLE,
      now: () => host.now(),
    });
    return {
      host,
      materialise: () => run(["secrets", "materialise"], host, { aws: () => aws }),
      materialiseTo: (out: string) =>
        run(["secrets", "materialise", "--out", out], host, { aws: () => aws }),
      slotsRead: () =>
        ssm.commandCalls(GetParameterCommand).map((c) => c.input.Name?.split("/").at(-1)),
    };
  }

  test("secrets materialise writes the memory credential beside secrets.env", async () => {
    const r = rig(serviceManifest("hindsight"));
    expect(await r.materialise()).toBe(0);
    expect(r.host.files.get(MEMORY_LLM_ENV_PATH)?.content).toBe(
      "HINDSIGHT_API_LLM_API_KEY='FIXTURE anthropic #key'\n",
    );
    expect(r.host.files.get(MEMORY_LLM_ENV_PATH)?.mode).toBe("0600");
    expect(r.host.files.get(SECRETS_ENV_PATH)?.content).toBe(
      "ANTHROPIC_API_KEY='FIXTURE anthropic #key'\n",
    );
    // The provider key is the one read; the memory server has no slot of its own.
    expect(r.slotsRead()).toEqual(["provider-key"]);
    expect(out.stderr).not.toContain(PROVIDER_KEY);
  });

  test("secrets materialise --out elsewhere leaves the live credential file alone", async () => {
    const r = rig(serviceManifest("hindsight"));
    r.host.seed(MEMORY_LLM_ENV_PATH, "HINDSIGHT_API_LLM_API_KEY=FIXTURE-live\n", "0600");
    expect(await r.materialiseTo("/run/hermetic/look.env")).toBe(0);
    expect(r.host.files.get("/run/hermetic/look.env")).toBeDefined();
    expect(r.host.files.get(MEMORY_LLM_ENV_PATH)?.content).toBe(
      "HINDSIGHT_API_LLM_API_KEY=FIXTURE-live\n",
    );

    const bare = rig(makeManifest());
    bare.host.seed(MEMORY_LLM_ENV_PATH, "HINDSIGHT_API_LLM_API_KEY=FIXTURE-live\n", "0600");
    expect(await bare.materialiseTo("/run/hermetic/look.env")).toBe(0);
    expect(bare.host.files.has(MEMORY_LLM_ENV_PATH)).toBe(true);
  });

  test("secrets materialise removes it for an agent without a server", async () => {
    const r = rig(makeManifest({ memory: { provider: "holographic" } }));
    r.host.seed(MEMORY_LLM_ENV_PATH, "HINDSIGHT_API_LLM_API_KEY=FIXTURE-old\n", "0600");
    expect(await r.materialise()).toBe(0);
    expect(r.host.files.has(MEMORY_LLM_ENV_PATH)).toBe(false);
  });

  test("a converge writes the credential from the provider key", async () => {
    const host = new MemoryBox();
    const manifest: AgentConfig = { ...serviceManifest("hindsight"), config_hash: "cafef00d" };
    const ddb = new RecordingSink();
    ddb.byCommand.set("GetCommand", () => ({
      Item: {
        name: TEST_NAME,
        status: "ready",
        version: 3,
        resources: { config_key: `config/${TEST_NAME}/cafef00d.tgz`, ssm_paths: [] },
      },
    }));
    const ssm = new RecordingSink();
    ssm.byCommand.set("GetParameterCommand", (command) =>
      (command as GetParameterCommand).input.Name?.endsWith("/provider-key")
        ? { Parameter: { Value: PROVIDER_KEY } }
        : parameterNotFound(),
    );
    const s3 = new RecordingSink();
    s3.byCommand.set("GetObjectCommand", () => ({ Body: fakeConfigBundle(manifest) }));
    const aws = makeAws({
      ddb,
      ssm,
      s3,
      agentsTable: TEST_AGENTS_TABLE,
      eventsTable: TEST_EVENTS_TABLE,
      now: () => host.now(),
    });
    const request: ApplyRequest = {
      id: "req-1",
      config_hash: "cafef00d",
      issued_at: "2026-09-10T00:00:00.000Z",
      issued_by: "arn:aws:sts::123456789012:assumed-role/Admin/session",
    };

    const outcome = await convergeOnce(
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

    expect(outcome.kind).toBe("applied");
    expect(host.files.get(MEMORY_LLM_ENV_PATH)?.content).toBe(
      "HINDSIGHT_API_LLM_API_KEY='FIXTURE anthropic #key'\n",
    );
    expect(ssm.commandCalls(GetParameterCommand)).toHaveLength(1);
  });
});

describe("verify-hermes", () => {
  const managed = (provider: string) =>
    `model:\n  provider: "bedrock"\nmemory:\n  provider: "${provider}"\n`;

  test("the managed config must select the provider the manifest names", async () => {
    const host = new BoxHost();
    const manifest = makeManifest({ memory: { provider: "hindsight" } });
    host.seed("/etc/hermes/config.yaml", managed("hindsight"), "0640");
    const good = await checkHermes(host, manifest);
    expect(good.find((c) => c.name === "memory")?.ok).toBe(true);

    host.seed("/etc/hermes/config.yaml", managed("openviking"), "0640");
    const drifted = await checkHermes(host, manifest);
    const memory = drifted.find((c) => c.name === "memory");
    expect(memory?.ok).toBe(false);
    expect(memory?.detail).toContain("openviking");
  });

  test("prism is selected as prme, the name Hermes knows it by", async () => {
    const host = new BoxHost();
    const manifest = makeManifest({ memory: { provider: "prism", pin: MEMORY_SERVICES.prism.pin } });
    host.seed("/etc/hermes/config.yaml", managed("prme"), "0640");
    expect((await checkHermes(host, manifest)).find((c) => c.name === "memory")?.ok).toBe(true);

    host.seed("/etc/hermes/config.yaml", managed("prism"), "0640");
    const memory = (await checkHermes(host, manifest)).find((c) => c.name === "memory");
    expect(memory?.ok).toBe(false);
    expect(memory?.detail).toContain("not prme");
  });

  test("no memory check without a provider", async () => {
    const checks = await checkHermes(new BoxHost(), makeManifest());
    expect(checks.map((c) => c.name)).not.toContain("memory");
  });
});
