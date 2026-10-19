/**
 * The managed block in every Hermes `.env` (§8.1): the splice, the sync across
 * the default profile and every bot, and the daemon's catch-up loops.
 *
 * Directories are made explicitly: a real fresh box has none of them, and a
 * fake that invented parents once hid a missing `mkdir` (`fake-host.ts`).
 */
import { describe, expect, test } from "bun:test";
import {
  HERMES_PROFILES_DIR,
  HERMES_USER_ENV,
  MANAGED_ENV_BEGIN,
  MANAGED_ENV_END,
  MEMORY_LLM_ENV_PATH,
  MEMORY_SERVICE_UNIT,
} from "@hermetic/core/shared";
import type { AgentConfig } from "@hermetic/core/schema";
import { spliceManagedBlock, writeManagedEnv } from "../src/apply/secrets.ts";
import { MANIFEST_PATH } from "../src/manifest.ts";
import { listBotHomes, makeSecretsSyncer, resolveAndSync, syncSecrets } from "../src/secrets-sync.ts";
import { FakeHost } from "./fake-host.ts";
import { makeManifest } from "./fixtures.ts";

const KEY = "NOUS_API_KEY=FIXTURE-key";
const fenced = (...lines: string[]) => [MANAGED_ENV_BEGIN, ...lines, MANAGED_ENV_END, ""].join("\n");
const bot = (name: string) => `${HERMES_PROFILES_DIR}/${name}`;

/** A box with the account's home and `/run/hermetic`, and nothing else. */
function box(): FakeHost {
  const host = new FakeHost();
  for (const dir of ["/data", "/data/hermes", "/data/hermes/.hermes", "/run/hermetic"])
    host.dirs.add(dir);
  return host;
}

/** An `Aws` that answers one slot, counting reads; `version` is what SSM reports now. */
function slots(state: { version: number; value: string }) {
  const calls = { version: 0, value: 0 };
  return {
    calls,
    aws: {
      getParameterVersion: async () => {
        calls.version += 1;
        return state.version;
      },
      getParameter: async () => {
        calls.value += 1;
        return state.value;
      },
    },
  };
}

describe("writeManagedEnv", () => {
  test("a file with no block gets one on top; every other byte is kept", async () => {
    const host = box();
    const outside = "# note\r\nTZ=UTC\nBROWSER_CDP_URL=http://127.0.0.1:9222";
    host.seed(HERMES_USER_ENV, outside, "0600");
    expect(await writeManagedEnv(host, HERMES_USER_ENV, [KEY])).toBe(true);
    expect(host.files.get(HERMES_USER_ENV)?.content).toBe(fenced(KEY) + outside);
  });

  test("an existing block is replaced in place, the lines around it byte-identical", async () => {
    const host = box();
    const before = "A=1\r\n# kept\n";
    const after = "\nexport B='two'\n\n";
    host.seed(HERMES_USER_ENV, `${before}${fenced("NOUS_API_KEY=FIXTURE-old", "X=1")}${after}`, "0600");
    await writeManagedEnv(host, HERMES_USER_ENV, [KEY]);
    expect(host.files.get(HERMES_USER_ENV)?.content).toBe(`${before}${fenced(KEY)}${after}`);
  });

  test("Bedrock's empty line list leaves an empty fence", () => {
    expect(spliceManagedBlock(fenced(KEY), [])).toBe(fenced());
    expect(spliceManagedBlock("", [])).toBe(fenced());
  });

  test("a missing file is created as the account, 0600, through a staged rename", async () => {
    const host = box();
    await writeManagedEnv(host, HERMES_USER_ENV, [KEY]);
    const file = host.files.get(HERMES_USER_ENV);
    expect(file?.content).toBe(fenced(KEY));
    expect(file?.mode).toBe("0600");
    expect(file?.ownership).toBe("hermes:hermes");
    expect(host.streamWrites.map((w) => [w.user, w.mode])).toEqual([["hermes", "0600"]]);
    expect(host.fsOps.some((op) => op.endsWith(`-> ${HERMES_USER_ENV}`))).toBe(true);
    // Root never opened anything under `/data`.
    expect(host.rootFsCalls.filter((c) => c.includes("/data/"))).toEqual([]);
  });

  test("unchanged content is not rewritten", async () => {
    const host = box();
    host.seed(HERMES_USER_ENV, `TZ=UTC\n${fenced(KEY)}`, "0600");
    expect(await writeManagedEnv(host, HERMES_USER_ENV, [KEY])).toBe(false);
    expect(host.streamWrites).toEqual([]);
  });

  test("a symlink is refused, and nothing is written through it", async () => {
    const host = box();
    host.symlink(HERMES_USER_ENV, "/etc/shadow");
    await expect(writeManagedEnv(host, HERMES_USER_ENV, [KEY])).rejects.toMatchObject({
      code: "AGENT_DIR_UNSAFE",
    });
    expect(host.streamWrites).toEqual([]);
  });
});

describe("syncSecrets", () => {
  test("the default .env and every bot get the block; dot-names and symlinked homes do not", async () => {
    const host = box();
    host.seed(`${bot("alpha")}/.env`, "# placeholder\n", "0600");
    host.dirs.add(HERMES_PROFILES_DIR);
    host.dirs.add(bot("beta"));
    host.dirs.add(bot(".gamma.staging-41"));
    // A symlink to a directory: `lstat` sees both.
    host.dirs.add(bot("link"));
    host.symlinks.add(bot("link"));
    // A bot whose `.env` is a symlink is refused on its own; the rest go on.
    host.dirs.add(bot("odd"));
    host.symlink(`${bot("odd")}/.env`, "/etc/shadow");

    expect(await listBotHomes(host)).toEqual(["alpha", "beta", "odd"]);
    const result = await syncSecrets({
      host,
      providerKey: { env: "NOUS_API_KEY", value: "FIXTURE-key" },
    });

    expect(result.bots).toEqual(["alpha", "beta"]);
    expect(result.refused).toEqual(["odd"]);
    expect(result.changed).toEqual([HERMES_USER_ENV, `${bot("alpha")}/.env`, `${bot("beta")}/.env`]);
    expect(host.files.get(`${bot("alpha")}/.env`)?.content).toBe(`${fenced(KEY)}# placeholder\n`);
    expect(host.files.get(`${bot("beta")}/.env`)?.content).toBe(fenced(KEY));
    expect(host.files.has(`${bot(".gamma.staging-41")}/.env`)).toBe(false);
    expect(host.files.has(`${bot("link")}/.env`)).toBe(false);

    // A second sync with the same key rewrites nothing.
    const again = await syncSecrets({
      host,
      providerKey: { env: "NOUS_API_KEY", value: "FIXTURE-key" },
    });
    expect(again.changed).toEqual([]);
  });

  test("a dry run answers without writing", async () => {
    const host = box();
    const result = await syncSecrets({
      host,
      providerKey: { env: "NOUS_API_KEY", value: "FIXTURE-key" },
      dryRun: true,
    });
    expect(result.changed).toEqual([HERMES_USER_ENV]);
    expect(host.files.has(HERMES_USER_ENV)).toBe(false);
  });
});

describe("resolveAndSync", () => {
  const hindsight = (): AgentConfig => ({
    ...makeManifest({
      provider: "nous",
      memory: {
        provider: "hindsight",
        llm: { vendor: "nous", model: "fixture-model", key_env: ["HINDSIGHT_API_LLM_API_KEY"] },
      } as AgentConfig["memory"],
    }),
    units: ["hermes-dashboard.service", MEMORY_SERVICE_UNIT],
  });

  test("reports the slot version, and restarts the memory server only when asked and moved", async () => {
    const host = box();
    const { aws } = slots({ version: 4, value: "FIXTURE-key" });
    const first = await resolveAndSync({ host, aws, paramPrefix: "/hermes/x", manifest: hindsight() });
    expect(first.slotVersion).toBe(4);
    expect(first.memoryChanged).toBe(true);
    expect(host.files.get(MEMORY_LLM_ENV_PATH)?.content).toBe(
      "HINDSIGHT_API_LLM_API_KEY=FIXTURE-key\n",
    );
    // The boot oneshot's shape: the server starts after it, so no restart.
    expect(host.restarted).toEqual([]);

    const rotated = slots({ version: 5, value: "FIXTURE-new" });
    await resolveAndSync({
      host,
      aws: rotated.aws,
      paramPrefix: "/hermes/x",
      manifest: hindsight(),
      restartMemory: true,
    });
    expect(host.restarted).toEqual([MEMORY_SERVICE_UNIT]);
  });
});

describe("the daemon's syncer", () => {
  function syncerRig() {
    const host = box();
    host.seed(MANIFEST_PATH, JSON.stringify(makeManifest({ provider: "nous" })));
    const state = { version: 1, value: "FIXTURE-key" };
    const { aws, calls } = slots(state);
    const logs: string[] = [];
    const syncer = makeSecretsSyncer({ host, aws, paramPrefix: "/hermes/x", log: (m) => logs.push(m) });
    return { host, state, calls, syncer, logs };
  }

  test("the first tick syncs; an unchanged Version does not; a moved one does", async () => {
    const r = syncerRig();
    await r.syncer.tick();
    expect(r.calls.value).toBe(1);
    expect(r.host.files.get(HERMES_USER_ENV)?.content).toBe(fenced(KEY));

    await r.syncer.tick();
    expect(r.calls.value).toBe(1);

    r.state.version = 2;
    r.state.value = "FIXTURE-new";
    await r.syncer.tick();
    expect(r.calls.value).toBe(2);
    expect(r.host.files.get(HERMES_USER_ENV)?.content).toBe(fenced("NOUS_API_KEY=FIXTURE-new"));
    // Names and counts only, never a value.
    expect(r.logs.join("\n")).not.toContain("FIXTURE");
  });

  test("a tick with no manifest yet (mid-bootstrap) does nothing and does not throw", async () => {
    const r = syncerRig();
    await r.host.remove(MANIFEST_PATH);
    await r.syncer.tick();
    expect(r.calls).toEqual({ version: 0, value: 0 });
  });

  test("a bot directory that appears is keyed at the next poll", async () => {
    const r = syncerRig();
    r.host.dirs.add(HERMES_PROFILES_DIR);
    const stop = new AbortController();
    let polls = 0;
    r.host.sleep = async () => {
      polls += 1;
      // After the first look, upstream publishes a bot by renaming its staging dir in.
      if (polls === 1) r.host.seed(`${bot("scout")}/.env`, "# placeholder\n", "0600");
      if (polls === 2) stop.abort();
    };
    await r.syncer.watchProfiles(stop.signal, 2_000);
    expect(r.host.files.get(`${bot("scout")}/.env`)?.content).toBe(`${fenced(KEY)}# placeholder\n`);
  });
});
