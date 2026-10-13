/**
 * The box half of the external memory provider (`memory-provider` capability):
 * the key `memory.key_ref` names lands in `secrets.env` under the provider's
 * variable, every author of that file writes it the same way, and the
 * provider's Python dependencies are in Hermes's venv before Hermes starts.
 */
import { describe, expect, test } from "bun:test";
import { GetParameterCommand } from "@aws-sdk/client-ssm";
import type { AgentConfig, ApplyRequest } from "@hermetic/core/schema";
import { MEMORY_KEY_SLOT } from "@hermetic/core/shared";
import { apply, importNameOf, SECRETS_ENV_PATH } from "../src/apply/index.ts";
import { HERMES_VENV_DIR } from "../src/apply/hermes.ts";
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
import { expectNotRan, expectRan } from "./fake-host.ts";
import {
  RecordingSink,
  TEST_AGENTS_TABLE,
  TEST_BUCKET,
  TEST_EVENTS_TABLE,
  TEST_NAME,
  makeFleetManifest,
  makeManifest,
  makeUserDataJson,
  type ManifestOverrides,
} from "./fixtures.ts";
import { captureOutput } from "./quiet.ts";

const out = captureOutput();

/** Short and unshaped on purpose: no redaction pattern would catch it, so only not emitting it keeps it out. */
const MEMORY_KEY = "FIXTURE-memory-key";
const SUPERMEMORY = { provider: "supermemory", key_ref: MEMORY_KEY_SLOT } as const;
const PYTHON = `${HERMES_VENV_DIR}/bin/python`;
const PIP_SUPERMEMORY = `uv pip install --python ${PYTHON} supermemory`;

function parameterNotFound(): Error {
  const e = new Error("Parameter not found");
  e.name = "ParameterNotFound";
  return e;
}

/** A box with this agent's manifest on disk and SSM answering from `slots`. */
function rig(options: ManifestOverrides & { slots?: Readonly<Record<string, string>> } = {}) {
  const { slots = {}, ...manifestOverrides } = options;
  const host = new BoxHost();
  host.seed(USER_DATA_JSON_PATH, makeUserDataJson());
  host.seed(FLEET_CACHE_PATH, JSON.stringify(makeFleetManifest()));
  host.seed(MANIFEST_PATH, JSON.stringify(makeManifest(manifestOverrides)));

  const ssm = new RecordingSink();
  ssm.byCommand.set("GetParameterCommand", (command) => {
    const name = (command as GetParameterCommand).input.Name ?? "";
    const value = slots[name.slice(name.lastIndexOf("/") + 1)];
    if (value === undefined) throw parameterNotFound();
    return { Parameter: { Value: value } };
  });
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
    ssm,
    materialise: () => run(["secrets", "materialise"], host, { aws: () => aws }),
    apply: () => run(["apply"], host, { aws: () => aws }),
    env: () => host.files.get(SECRETS_ENV_PATH)?.content ?? null,
    slotsRead: () =>
      ssm.commandCalls(GetParameterCommand).map((c) => {
        const name = c.input.Name ?? "";
        return name.slice(name.lastIndexOf("/") + 1);
      }),
  };
}

/**
 * `import supermemory` fails until `uv pip install … supermemory` has run, the
 * way a fresh venv answers. Returns the install count.
 */
function venvWithoutSupermemory(host: BoxHost): { installs: () => number } {
  let installs = 0;
  host.when(`${PYTHON} -c import supermemory`, () => (installs > 0 ? { code: 0 } : { code: 1 }));
  host.when(PIP_SUPERMEMORY, () => {
    installs += 1;
    return { code: 0 };
  });
  return { installs: () => installs };
}

describe("the memory key in secrets.env", () => {
  test("hermeticd advertises the capability a memory manifest asks for", () => {
    expect(HERMETICD_CAPABILITIES.has("memory-provider")).toBe(true);
  });

  test("materialise and apply write the same SUPERMEMORY_API_KEY line", async () => {
    const m = rig({ memory: SUPERMEMORY, slots: { [MEMORY_KEY_SLOT]: MEMORY_KEY } });
    expect(await m.materialise()).toBe(0);
    expect(m.env()).toBe(`SUPERMEMORY_API_KEY=${MEMORY_KEY}\n`);
    expect(m.host.files.get(SECRETS_ENV_PATH)?.mode).toBe("0600");
    // Bedrock has no key of its own, so the memory slot is the only read.
    expect(m.slotsRead()).toEqual([MEMORY_KEY_SLOT]);

    const a = rig({ memory: SUPERMEMORY, slots: { [MEMORY_KEY_SLOT]: MEMORY_KEY } });
    expect(await a.apply()).toBe(0);
    expect(a.env()).toBe(m.env());
    expect(a.slotsRead()).toEqual([MEMORY_KEY_SLOT]);
  });

  test("after the provider key, before Bitwarden", async () => {
    const r = rig({
      provider: "nous",
      memory: SUPERMEMORY,
      slots: { "provider-key": "nous-FIXTURE-KEY", [MEMORY_KEY_SLOT]: MEMORY_KEY },
    });
    expect(await r.materialise()).toBe(0);
    expect(r.env()).toBe(`NOUS_API_KEY=nous-FIXTURE-KEY\nSUPERMEMORY_API_KEY=${MEMORY_KEY}\n`);
  });

  test("a local provider writes no memory line and reads no slot", async () => {
    const r = rig({ memory: { provider: "holographic" } });
    expect(await r.apply()).toBe(0);
    expect(r.env()).toBe("\n");
    expect(r.slotsRead()).toEqual([]);
  });

  test("the key never reaches stdout, stderr, events or argv", async () => {
    const r = rig({ memory: SUPERMEMORY, slots: { [MEMORY_KEY_SLOT]: MEMORY_KEY } });
    expect(await r.apply()).toBe(0);
    expect(await r.materialise()).toBe(0);

    const host = new BoxHost();
    const { emit, events } = collector();
    await apply(makeManifest({ memory: SUPERMEMORY }), { host, emit, memoryKey: MEMORY_KEY });

    expect(r.env()).toContain(MEMORY_KEY);
    expect(out.stdout).not.toContain(MEMORY_KEY);
    expect(out.stderr).not.toContain(MEMORY_KEY);
    expect(JSON.stringify(events)).not.toContain(MEMORY_KEY);
    expect([...r.host.commands, ...host.commands].join("\n")).not.toContain(MEMORY_KEY);
  });

  test("a manifest naming a key_ref with no key resolved is refused INTERNAL", async () => {
    const host = new BoxHost();
    const refused = await apply(makeManifest({ memory: SUPERMEMORY }), { host }).catch((e) => e);
    expect(refused).toBeInstanceOf(AgentdError);
    expect((refused as AgentdError).code).toBe("INTERNAL");
    expect((refused as AgentdError).message).toContain("SUPERMEMORY_API_KEY");
    // Refused before the file is touched: the previous binding's file stands.
    expect(host.files.has(SECRETS_ENV_PATH)).toBe(false);

    // The CLI with an empty slot fails the same way, at the read.
    const r = rig({ memory: SUPERMEMORY });
    const viaCli = await r.apply().catch((e) => e);
    expect((viaCli as AgentdError).code).toBe("INTERNAL");
    expect(r.env()).toBe(null);
  });

  /**
   * `key_ref` becomes an SSM path under the agent's own prefix, where `ts-key`
   * and `bws-token` live too. A manifest that names one must not turn it into
   * `SUPERMEMORY_API_KEY` — so it is refused before anything is read. Built
   * past the schema, so this holds however core spells the field.
   */
  test("a key_ref that is not the memory slot is refused and never read", async () => {
    const stolen = { provider: "supermemory", key_ref: "ts-key" } as unknown as AgentConfig["memory"];

    const host = new BoxHost();
    const refused = await apply(
      { ...makeManifest(), memory: stolen },
      { host, memoryKey: "tskey-auth-FIXTURE" },
    ).catch((e) => e);
    expect((refused as AgentdError).code).toBe("MANIFEST_REFUSED");
    // Refused at the top: nothing installed, nothing written.
    expect(host.commands).toEqual([]);
    expect(host.files.has(SECRETS_ENV_PATH)).toBe(false);

    for (const command of ["materialise", "apply"] as const) {
      const r = rig({ slots: { "ts-key": "tskey-auth-FIXTURE", [MEMORY_KEY_SLOT]: MEMORY_KEY } });
      r.host.seed(MANIFEST_PATH, JSON.stringify({ ...makeManifest(), memory: stolen }));
      const viaCli = await r[command]().catch((e) => e);
      expect((viaCli as AgentdError).code).toBe("MANIFEST_REFUSED");
      expect(r.slotsRead()).not.toContain("ts-key");
      expect(r.env()).toBe(null);
    }
  });
});

describe("the memory provider's Python dependencies", () => {
  test("a provider with no dependencies probes and installs nothing", async () => {
    const host = new BoxHost();
    await apply(makeManifest({ memory: { provider: "holographic" } }), { host });
    expectNotRan(host, / -c import /);
    expect(host.commands.filter((c) => /^uv pip install /.test(c) && !c.includes(" -e "))).toEqual([]);
  });

  test("supermemory is installed into Hermes's venv once, then probed and skipped", async () => {
    const host = new BoxHost();
    const venv = venvWithoutSupermemory(host);
    const manifest = makeManifest({ memory: SUPERMEMORY });

    const first = await apply(manifest, { host, memoryKey: MEMORY_KEY });
    expect(venv.installs()).toBe(1);
    expect(first.installed).toContain("pip:supermemory");
    // After the venv exists, and before Hermes is started on it.
    const pip = host.commands.indexOf(PIP_SUPERMEMORY);
    expect(pip).toBeGreaterThan(host.commands.findIndex((c) => / -e /.test(c)));
    expect(pip).toBeLessThan(host.commands.indexOf("systemctl restart hermes-gateway.service"));

    host.commands.length = 0;
    const second = await apply(manifest, { host, memoryKey: MEMORY_KEY });
    expect(venv.installs()).toBe(1);
    expectRan(host, `${PYTHON} -c import supermemory`, 1);
    expect(second.installed).toEqual([]);
    expect(second.restarted).toEqual([]);
  });

  test("an install on a running box restarts Hermes so it loads the provider", async () => {
    const host = new BoxHost();
    const manifest = makeManifest({ memory: SUPERMEMORY });
    await apply(manifest, { host, memoryKey: MEMORY_KEY });
    host.restarted.length = 0;
    // The dependency went missing since (an operator's `uv pip uninstall`).
    const venv = venvWithoutSupermemory(host);

    const result = await apply(manifest, { host, memoryKey: MEMORY_KEY });
    expect(venv.installs()).toBe(1);
    expect(result.restarted.sort()).toEqual(["hermes-dashboard.service", "hermes-gateway.service"]);
  });

  test("a dry run probes and reports, and installs nothing", async () => {
    const host = new BoxHost();
    const manifest = makeManifest({ memory: SUPERMEMORY });
    await apply(manifest, { host, memoryKey: MEMORY_KEY });
    const venv = venvWithoutSupermemory(host);

    const plan = await apply(manifest, { host, memoryKey: MEMORY_KEY, dryRun: true });
    expect(plan.installed).toEqual(["pip:supermemory"]);
    expect(venv.installs()).toBe(0);
  });

  test("distribution specs map to the module they import as", () => {
    expect(importNameOf("supermemory")).toBe("supermemory");
    expect(importNameOf("honcho-ai")).toBe("honcho");
    expect(importNameOf("mem0ai>=2.0.10,<3")).toBe("mem0");
    expect(importNameOf("requests")).toBe("requests");
  });
});

describe("converge", () => {
  test("a converge reads the memory slot and writes the key", async () => {
    const host = new BoxHost();
    const manifest: AgentConfig = { ...makeManifest({ memory: SUPERMEMORY }), config_hash: "cafef00d" };
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
      (command as GetParameterCommand).input.Name?.endsWith(`/${MEMORY_KEY_SLOT}`)
        ? { Parameter: { Value: MEMORY_KEY } }
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
    expect(host.files.get(SECRETS_ENV_PATH)?.content).toBe(`SUPERMEMORY_API_KEY=${MEMORY_KEY}\n`);
  });
});

describe("verify-hermes", () => {
  const managed = (provider: string) =>
    `model:\n  provider: "bedrock"\nmemory:\n  provider: "${provider}"\n`;

  test("the managed config must select the provider the manifest names", async () => {
    const host = new BoxHost();
    host.seed("/etc/hermes/config.yaml", managed("supermemory"), "0640");
    const ok = await checkHermes(host, makeManifest({ memory: SUPERMEMORY }));
    expect(ok.find((c) => c.name === "memory")?.ok).toBe(true);

    host.seed("/etc/hermes/config.yaml", managed("honcho"), "0640");
    const drifted = await checkHermes(host, makeManifest({ memory: SUPERMEMORY }));
    const memory = drifted.find((c) => c.name === "memory");
    expect(memory?.ok).toBe(false);
    expect(memory?.detail).toContain("honcho");
  });

  test("no memory check without a provider", async () => {
    const checks = await checkHermes(new BoxHost(), makeManifest());
    expect(checks.map((c) => c.name)).not.toContain("memory");
  });
});
