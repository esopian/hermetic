/**
 * The CLI head, run as a real process (§11.6). Golden-file tests on `--json` are
 * the contract scripts consume, and the stdout/stderr split is what makes
 * `hermetic … --json | jq` work while the account header is still visible.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILD_VERSIONS, runRecorderFor } from "@hermetic/core";
/** The recorded row, as core hands it back — not the spawned process below. */
import type { Run as CoreRun } from "@hermetic/core";
import { cliBinary, seedFixtureHome } from "./cli-binary.ts";

/** Every spawned CLI writes its `runs` log here, never into the real ~/.hermetic. */
const HOME = mkdtempSync(join(tmpdir(), "hermetic-cli-test-"));
beforeAll(() => seedFixtureHome(HOME));

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(...args: string[]): Promise<Run> {
  const proc = Bun.spawn([await cliBinary(), ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HERMETIC_FIXTURE: "1", HERMETIC_NO_TTY: "1", HERMETIC_HOME: HOME },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

// §4.8: the fleet name comes first — one account may hold several fleets.
const HEADER = "▸ main · acme-dev · 123456789012 · us-west-2 · profile acme-dev · FIXTURE";

describe("--json output is a golden contract", () => {
  test("agent ps", async () => {
    const { code, stdout } = await run("agent", "ps", "--json");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchSnapshot();
  });

  test("agent status atlas", async () => {
    const { code, stdout } = await run("agent", "status", "atlas", "--json");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchSnapshot();
  });

  test("agent probe atlas", async () => {
    const { code, stdout } = await run("agent", "probe", "atlas", "--json");
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as {
      name: string;
      instance: { outcome: string };
      hermeticd: { outcome: string };
      dashboard: { outcome: string };
      desktop: { outcome: string; url: string | null };
      browser: { outcome: string; browsers: Array<{ name: string }> };
      verdict: { level: string; hints: string[] };
    };
    expect(report.name).toBe("atlas");
    // Every layer answers on the fixture's healthy agent.
    expect(report.instance.outcome).toBe("ok");
    expect(report.hermeticd.outcome).toBe("ok");
    expect(report.dashboard.outcome).toBe("ok");
    expect(report.desktop.outcome).toBe("ok");
    expect(report.desktop.url).toMatch(/\/vnc\/$/);
    expect(report.browser.outcome).toBe("ok");
    expect(report.browser.browsers.map((b) => b.name)).toEqual(["default"]);
    expect(report.verdict.level).toBe("ok");
  });

  /**
   * The point of the command: `lumen` is the fixture's stale-heartbeat agent, so
   * `ps` shows it `unreachable` — one word — and `probe` says which layer is
   * actually silent and what to type next.
   */
  test("agent probe lumen names the failing layer, and still exits 0", async () => {
    const { code, stdout } = await run("agent", "probe", "lumen", "--json");
    // A layer that does not answer is data, not an error: no exit code moves.
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as {
      row: { display_status: string };
      instance: { outcome: string };
      hermeticd: { outcome: string; detail: string };
      verdict: { level: string; hints: string[] };
    };
    expect(report.row.display_status).toBe("unreachable");
    expect(report.instance.outcome).toBe("ok");
    expect(report.hermeticd.outcome).toBe("fail");
    expect(report.verdict.level).toBe("bad");
    expect(report.verdict.hints.join("\n")).toContain("hermetic ssh lumen");
  });

  test("agent probe renders a layer table when --json is absent", async () => {
    const { code, stdout } = await run("agent", "probe", "atlas");
    expect(code).toBe(0);
    expect(stdout).toContain("instance");
    expect(stdout).toContain("hermeticd");
    expect(stdout).toContain("dashboard");
    expect(stdout).toContain("desktop");
    expect(stdout).toContain("browser");
    expect(stdout).toContain("OK: all layers answer");
  });

  /**
   * §6.5: `corvid` is the fixture's recreated agent, whose predecessor still
   * holds `corvid.hermetic.ts.net` in the tailnet. `agent status` has to print
   * the name the node actually answers on, and say why it is not the obvious
   * one — otherwise the operator reads `corvid-2` as a typo.
   */
  test("agent status names the tailnet name and the stale device holding the canonical one", async () => {
    const canonical = await run("agent", "status", "atlas");
    expect(canonical.code).toBe(0);
    // `fxtr0001-` is the fleet prefix every node wears in the tailnet since
    // foundation v4 (`cloudName`): the fixture fleet's *id*, not its name.
    expect(canonical.stdout).toContain("tailnet name       fxtr0001-atlas.hermetic.ts.net");
    expect(canonical.stdout).not.toContain("stale device");

    const { code, stdout } = await run("agent", "status", "corvid");
    expect(code).toBe(0);
    expect(stdout).toContain(
      "tailnet name       fxtr0001-corvid-2.hermetic.ts.net (canonical fxtr0001-corvid.hermetic.ts.net is held by a stale device)",
    );
  });

  /** `ps` gains nothing: the table's width is its own contract (§9). */
  test("agent ps shows no new column", async () => {
    const { stdout } = await run("agent", "ps");
    expect(stdout).not.toContain("corvid-2");
    expect(stdout).toContain("corvid");
  });

  /**
   * The stale device is printed, and is not a finding: `doctor`'s verdict is
   * about what somebody can go and fix with hermetic, and this one is fixed in
   * the Tailscale console. Counted as a finding it would pin the whole report
   * to PROBLEMS for as long as the device existed, which is for ever.
   */
  /**
   * §4.7: the same rule the device list follows. hermetic's policy entries are
   * reported, never counted as a finding — an operator whose OAuth client has
   * no `policy_file` scope would otherwise read PROBLEMS for ever.
   */
  test("doctor reports the tailnet policy without making it a finding", async () => {
    const { code, stdout } = await run("doctor");
    expect(code).toBe(0);
    expect(stdout).toContain("tailscale      policy: absent (ssh, acls) — run `hermetic plan policy`");
    expect(stdout).not.toContain("finding        policy");
  });

  test("doctor prints a stale device as a tailscale line, not a finding", async () => {
    const { code, stdout } = await run("doctor");
    expect(code).toBe(0);
    expect(stdout).toContain("tailscale      corvid: the node is fxtr0001-corvid-2.hermetic.ts.net");
    expect(stdout).toContain("Machines → corvid");
    expect(stdout).not.toContain("finding        corvid");
  });

  test("agent probe on an unknown agent is NOT_FOUND", async () => {
    const { code, stderr } = await run("agent", "probe", "nosuchagent", "--json");
    expect(code).not.toBe(0);
    expect(stderr).toContain("nosuchagent");
  });

  test("agent history atlas", async () => {
    const { code, stdout } = await run("agent", "history", "atlas", "--json");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchSnapshot();
  });

  /**
   * The fleet item's own log. `_fleet` is reserved as an *agent* name and is
   * refused everywhere one is meant, but it is the name hermetic files its
   * fleet-wide events under (`secrets push _fleet`, `upgrade --hermeticd`), so
   * the one command that reads a log has to accept it.
   */
  test("agent history _fleet reads the fleet's own log", async () => {
    const { code, stdout, stderr } = await run("agent", "history", "_fleet", "--json");
    expect(code).toBe(0);
    expect(`${stdout}${stderr}`).not.toContain("invalid");
    expect(Array.isArray(JSON.parse(stdout))).toBe(true);
  });

  test("agent history rejects a name that is neither an agent nor _fleet", async () => {
    const { code, stderr } = await run("agent", "history", "_nope");
    expect(code).not.toBe(0);
    expect(stderr).not.toBe("");
  });

  /**
   * §4.7: the tailnet policy. The fixture policy carries the operator's own
   * `tag:hermetic` owner, so `tagOwners` is skipped and the two hermetic writes
   * are shown as the change.
   */
  test("policy prints the scope, each block and the diff", async () => {
    const { code, stdout } = await run("policy");
    expect(code).toBe(0);
    expect(stdout).toContain("scope          read + write (policy_file)");
    expect(stdout).toContain("managed        absent");
    expect(stdout).toContain("tagOwners    skipped");
    expect(stdout).toContain("+    // hermetic:managed begin");
    expect(stdout).toContain("tag:hermetic:22");
    /**
     * §8.3: the diff covers hermetic's marker-to-marker ranges and nothing
     * else. The fixture policy's own `acls` rule sits two lines from where
     * hermetic's block lands, and its `groups` entry is an email address —
     * neither may travel just because they were near the change.
     */
    expect(stdout).not.toContain("tag:build:22");
    expect(stdout).not.toContain("ops@example.com");
    expect(stdout).not.toContain("The build fleet");
    // Colour-free, like every other table here.
    expect(stdout).not.toContain("\u001b[");
  });

  /**
   * §5: the fleet's network mode. The `main` fixture is `public`, so the NAT
   * line reads `n/a` — which is a *skip*, not a check that passed, and the copy
   * has to say which.
   */
  test("network status prints the mode, the stack, the NAT line and each placement", async () => {
    const { code, stdout } = await run("network", "status");
    expect(code).toBe(0);
    expect(stdout).toContain("mode           public");
    expect(stdout).toContain("stack          public");
    expect(stdout).toContain("consistent     yes");
    expect(stdout).toContain("subnets        subnet-fixture0, subnet-fixture1");
    expect(stdout).toContain("nat            n/a — this fleet has no NAT instance");
    expect(stdout).toContain("drifted        0");
    expect(stdout).toContain("atlas        matches  subnet-fixture0");
    expect(stdout).not.toContain("\u001b[");
  });

  test("network status on the nat fixture fleet prints the appliance and its egress ip", async () => {
    const { code, stdout } = await run("network", "status", "--fleet", "staging");
    expect(code).toBe(0);
    expect(stdout).toContain("mode           nat");
    expect(stdout).toContain("egress ip      203.0.113.200");
    expect(stdout).toContain("default route active");
  });

  test("plan network --to nat --json is the plan core returns", async () => {
    const { code, stdout } = await run("plan", "network", "--to", "nat", "--json");
    expect(code).toBe(0);
    const plan = JSON.parse(stdout) as {
      kind: string;
      options: { network?: string };
      steps: Array<{ id: string; destructive: boolean }>;
      warnings: string[];
    };
    expect(plan.kind).toBe("network");
    expect(plan.options.network).toBe("nat");
    expect(plan.steps.map((s) => s.id)).toEqual(["preflight", "archive", "stack", "stamp", "drift"]);
    expect(plan.steps.filter((s) => s.destructive).map((s) => s.id)).toEqual(["stack"]);
    expect(plan.warnings.some((w) => w.includes("agent recreate"))).toBe(true);
  });

  /**
   * §5 decision: a target the fleet is already in is a refusal, not a no-op
   * plan an operator could confirm and apply for nothing.
   */
  test("plan network refuses a target the fleet is already in", async () => {
    const { code, stderr } = await run("plan", "network", "--to", "public");
    expect(code).not.toBe(0);
    expect(stderr).toContain("CONFLICT");
    expect(stderr).toContain("already in `public` mode");
  });

  test("policy --json is the report core returns", async () => {
    const { code, stdout } = await run("policy", "--json");
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as {
      scope: string;
      managed: string;
      blocks: Array<{ key: string; state: string }>;
      etag: string;
      diff: string;
    };
    expect(report.scope).toBe("write");
    expect(report.managed).toBe("absent");
    expect(report.blocks.map((b) => b.key)).toEqual(["tagOwners", "ssh", "acls"]);
    expect(report.etag).toBe('"fixture-policy-1"');
    expect(report.diff).toContain("hermetic:managed");
  });

  test("plan policy prints the steps and the diff under them", async () => {
    const { code, stdout } = await run("plan", "policy");
    expect(code).toBe(0);
    expect(stdout).toContain("plan: policy tailnet");
    expect(stdout).toContain("! write");
    expect(stdout).toContain("warning: the change, as a unified diff:");
    // Hunks are named by the key they change, not by a line number in a file
    // the operator is the only owner of.
    expect(stdout).toContain("@@ acls (new block at end of container) @@");
    expect(stdout).not.toContain("ops@example.com");
  });

  test("plan policy", async () => {
    const { code, stdout } = await run("plan", "policy", "--json");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchSnapshot();
  });

  test("plan teardown", async () => {
    const { code, stdout } = await run("plan", "teardown", "--json");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchSnapshot();
  });

  test("settings show", async () => {
    const { code, stdout } = await run("settings", "show", "--json");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchSnapshot();
  });

  test("secrets ls", async () => {
    const { code, stdout } = await run("secrets", "ls", "--json");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchSnapshot();
  });
});

/**
 * §8.2/§8.3's fleet-level shared secrets, through the CLI.
 *
 * Each `run` is a fresh process over a fresh in-memory fixture, so a push in
 * one is invisible to the next — the cross-command sequences (push, then see it
 * set; clear a provider, then delete the slug it named) are core's tests
 * (`packages/core/test/shared-secrets.test.ts`). What is CLI-shaped and only
 * testable here is the stdin read, the exit statuses, and the fact that neither
 * the terminal nor the run log ever sees the value.
 */
describe.concurrent("secrets · the fleet's shared slots", () => {
  interface SecretsJson {
    secrets: Array<{
      slug: string;
      label?: string;
      exists: boolean;
      placeholder: boolean;
      used_by: string[];
      orphan?: boolean;
    }>;
  }

  test("ls names both fixture slots, who reads them, and no value", async () => {
    const { code, stdout } = await run("secrets", "ls", "--json");
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as SecretsJson;
    const bySlug = new Map(result.secrets.map((s) => [s.slug, s]));
    expect(bySlug.get("nous-key")).toMatchObject({
      label: "Nous Portal",
      exists: true,
      placeholder: false,
      used_by: ["nous"],
    });
    // Declared but never filled — the state that makes a provider naming it
    // fall back to prompting on the next create.
    expect(bySlug.get("openrouter-key")).toMatchObject({ exists: true, placeholder: true });
    expect(stdout).not.toContain("sk-nous-FIXTURE");
  });

  test("the plain table separates set from empty and names the readers", async () => {
    const { code, stdout } = await run("secrets", "ls");
    expect(code).toBe(0);
    expect(stdout).toContain("SLUG");
    expect(stdout).toContain("USED BY");
    expect(stdout).toMatch(/nous-key\s+Nous Portal\s+set\s+nous/);
    expect(stdout).toMatch(/openrouter-key\s+OpenRouter\s+empty/);
  });

  test("push --shared reads the value from stdin and echoes only the path", async () => {
    const secret = "sk-or-v1-FIXTURE-SHARED-CLI";
    const proc = Bun.spawn(
      [
        await cliBinary(),
        "secrets",
        "push",
        "_fleet",
        "--shared",
        "openrouter-key",
        "--label",
        "OpenRouter",
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HERMETIC_FIXTURE: "1", HERMETIC_NO_TTY: "1", HERMETIC_HOME: HOME },
      },
    );
    proc.stdin.write(`${secret}\n`);
    await proc.stdin.end();
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(code).toBe(0);
    // Fleet-scoped since v3 (§8.2); `fxtr0001` is the fixture fleet's id.
    expect(stdout).toContain("wrote /hermetic/fxtr0001/secrets/openrouter-key");
    expect(`${stdout}${stderr}`).not.toContain(secret);

    // §8.3 again, on the other surface a value could survive on: the run log
    // records that the command ran, never what it pushed.
    const recorder = runRecorderFor({ home: HOME, fixture: true });
    try {
      const rows = await recorder.list({ limit: 50 });
      expect(rows.some((r) => r.command === "secrets push")).toBe(true);
      for (const r of rows) expect(r.log).not.toContain(secret);
    } finally {
      recorder.close();
    }
  });

  test("--label without --shared is a usage error, before anything is read", async () => {
    const { code, stderr } = await run("secrets", "push", "atlas", "--provider-key", "--label", "x");
    expect(code).toBe(2);
    expect(stderr).toContain("--label");
  });

  test("verify _fleet warns about an empty slot nobody names, on stderr", async () => {
    const { stdout, stderr } = await run("secrets", "verify", "_fleet");
    // The verdict a script reads stays on stdout; the advice does not.
    expect(stdout).toContain("/hermetic/fxtr0001/secrets/openrouter-key");
    expect(stderr).toContain("warning: shared slot openrouter-key is declared but empty");
    expect(stdout).not.toContain("warning:");
  });

  test("rm is refused while an unbound agent still reads the slug", async () => {
    const { code, stderr } = await run("secrets", "rm", "nous-key", "--yes");
    // CONFLICT: a conflict with reality, nothing was done.
    expect(code).toBe(7);
    // The agent that reads it, not the provider entry that points at it:
    // `marrow` is what the operator has to re-create or destroy (§8.2).
    expect(stderr).toContain("marrow");
    expect(stderr).toContain("pre-profile");
  });

  test("rm without --yes refuses rather than prompting in a pipe", async () => {
    const { code, stderr } = await run("secrets", "rm", "openrouter-key");
    expect(code).toBe(8);
    expect(stderr).toContain("irreversible");
  });

  test("rm --yes deletes a slug nothing names", async () => {
    const { code, stdout } = await run("secrets", "rm", "openrouter-key", "--yes");
    expect(code).toBe(0);
    expect(stdout).toContain("deleted shared secret openrouter-key");
  });

  test("rm of a slug that was never there is NOT_FOUND", async () => {
    const { code } = await run("secrets", "rm", "never-existed", "--yes");
    expect(code).toBe(6);
  });

  test("a typo is NOT_FOUND rather than a confirmation prompt for nothing", async () => {
    const { code, stderr } = await run("secrets", "rm", "typo-slug");
    expect(code).toBe(6);
    expect(stderr).not.toContain("irreversible");
  });
});

/**
 * §4.6: the fleet's shared settings, through the CLI.
 *
 * Every `run` is a fresh process over a fresh in-memory fixture, so a write in
 * one is invisible to the next — which is why each test asserts against the
 * settings the write itself answers with. That is also the contract a script
 * consumes: the write returns the new state, so nothing has to re-read.
 */
describe.concurrent("settings and providers", () => {
  interface SettingsJson {
    settings: {
      version: number;
      defaults: { provider: string; size: string };
      default_profile?: string | null;
      agent_defaults?: { model?: string; approvals_mode?: string };
      providers: Record<string, { enabled: boolean; default_model?: string }>;
    };
    persisted: boolean;
    catalog: Record<string, { default_model: string }>;
  }

  test("show reports the fixture's persisted settings and the catalog beside them", async () => {
    const { code, stdout } = await run("settings", "show", "--json");
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as SettingsJson;
    expect(result.persisted).toBe(true);
    expect(result.settings.defaults.provider).toBe("bedrock");
    // The fixture's one override, so the "(fleet)" column has something in it.
    expect(result.settings.providers["nous"]?.default_model).toBe("deepseek-v4-flash-0731");
    // The catalog is the fallback, and it rides along rather than being polled.
    expect(result.catalog["bedrock"]?.default_model).toBeTruthy();
  });

  test("the plain table marks the default provider and where each model came from", async () => {
    const { code, stdout } = await run("settings", "show");
    expect(code).toBe(0);
    expect(stdout).toContain("bedrock *");
    expect(stdout).toContain("(catalog)");
    expect(stdout).toContain("deepseek-v4-flash-0731 (fleet)");
  });

  test("set --default-profile moves the fleet default and bumps the version", async () => {
    const { code, stdout } = await run(
      "settings",
      "set",
      "--default-profile",
      "openrouter-cheap",
      "--json",
    );
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as SettingsJson;
    expect(result.settings.default_profile).toBe("rtr00002");
    expect(result.settings.version).toBe(2);
    expect(result.persisted).toBe(true);
  });

  test("set --model writes the fleet-wide agent defaults", async () => {
    const { code, stdout } = await run("settings", "set", "--model", "claude-sonnet-5", "--json");
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as SettingsJson;
    expect(result.settings.agent_defaults?.model).toBe("claude-sonnet-5");
  });

  test("set --approvals writes the fleet-wide starting mode, and refuses a typo", async () => {
    const { code, stdout } = await run("settings", "set", "--approvals", "manual", "--json");
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as SettingsJson;
    expect(result.settings.agent_defaults?.approvals_mode).toBe("manual");
    const bad = await run("settings", "set", "--approvals", "sometimes");
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("approvals_mode");
  });

  test("a profile the fleet does not have is NOT_FOUND, on stderr", async () => {
    const { code, stderr } = await run("settings", "set", "--default-profile", "nope");
    expect(code).toBe(6);
    expect(stderr).toContain("no provider profile nope");
  });

  test("making a disabled profile the fleet default is refused, on stderr", async () => {
    // `vercel-gw` is the fixture's disabled profile.
    const { code, stderr } = await run("settings", "set", "--default-profile", "vercel-gw");
    expect(code).not.toBe(0);
    expect(stderr).toContain("a disabled profile cannot be the fleet default");
  });

  test("a stale --expected-version refuses rather than overwriting", async () => {
    const { code, stderr } = await run(
      "settings",
      "set",
      "--size",
      "large",
      "--expected-version",
      "99",
    );
    expect(code).not.toBe(0);
    expect(stderr).toContain("re-read and retry");
  });

  test("settings set with no flags is a usage error, not a no-op write", async () => {
    const { code, stderr } = await run("settings", "set");
    expect(code).toBe(2);
    expect(stderr).toContain("at least one");
  });
});

describe.concurrent("the stdout/stderr split", () => {
  test("the header goes to stderr and stdout is nothing but JSON", async () => {
    const { stdout, stderr } = await run("agent", "ps", "--json");
    expect(stderr).toContain(HEADER);
    expect(stdout).not.toContain("▸");
    expect(() => JSON.parse(stdout) as unknown).not.toThrow();
  });

  test("the table goes to stdout when --json is absent", async () => {
    const { stdout, stderr } = await run("agent", "ps");
    expect(stdout).toContain("NAME");
    expect(stdout).toContain("atlas");
    expect(stdout).toContain("unreachable");
    // The header, and — because the fixture's destroyed agent kept its data
    // volume — the loose-volume trailer of §9. Both are stderr: stdout stays
    // the table alone, so a pipe is unchanged by either.
    expect(stderr).toContain(HEADER);
    expect(stderr).toContain("no agent · 600 GiB");
    expect(stdout).not.toContain("no agent");
  });

  test("the loose-volume trailer is stderr only, and absent from --json", async () => {
    const { stdout, stderr } = await run("agent", "ps", "--json");
    expect(stderr).not.toContain("no agent");
    expect(() => JSON.parse(stdout) as unknown).not.toThrow();
  });

  test("streamed op events are NDJSON on stdout", async () => {
    const { code, stdout } = await run("agent", "stop", "atlas", "--json");
    expect(code).toBe(0);
    const lines = stdout.trim().split("\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(JSON.parse(line) as { phase: string }).toHaveProperty("phase");
    }
  });
});

describe.concurrent("destructive commands confirm", () => {
  test("recreate with no --yes and no terminal is 8", async () => {
    const { code, stderr } = await run("agent", "recreate", "atlas", "--json");
    expect(code).toBe(8);
    expect(stderr).toContain("CONFIRMATION_REQUIRED");
  });

  test("recreate with --yes prints the plan it is about to run", async () => {
    const { code, stderr } = await run("agent", "recreate", "atlas", "--yes");
    expect(code).toBe(0);
    expect(stderr).toContain("plan: recreate atlas");
  });

  test("plan recreate is a dry run of the same plan", async () => {
    const { code, stdout } = await run("plan", "recreate", "atlas", "--json");
    expect(code).toBe(0);
    expect(JSON.parse(stdout) as { kind: string }).toMatchObject({ kind: "recreate", target: "atlas" });
  });

  test("apply refuses a plan file that is not JSON", async () => {
    const file = `${process.env["TMPDIR"] ?? "/tmp"}/hermetic-bad-plan-${Date.now()}.json`;
    await Bun.write(file, "{ this is not json");
    const { code, stderr } = await run("apply", file, "--yes");
    expect(code).toBe(2);
    expect(stderr).toContain("not valid JSON");
  });
});

describe.concurrent("init confirms with the twelve digits", () => {
  test("--yes alone does not stand in for typing them", async () => {
    const { code, stderr } = await run("init", "--yes");
    expect(code).toBe(8);
    expect(stderr).toContain("--confirm-account-id");
  });

  test("--confirm-account-id must be twelve digits", async () => {
    expect((await run("init", "--confirm-account-id", "12345")).code).toBe(2);
  });

  test("the right digits get through to core", async () => {
    const { code } = await run("init", "--confirm-account-id", "123456789012");
    expect(code).toBe(0);
  });

  test("the wrong digits are core's confirmation failure, not the head's", async () => {
    const { code, stderr } = await run("init", "--confirm-account-id", "999999999999");
    expect(code).toBe(8);
    expect(stderr).toContain("does not match");
  });
});

/**
 * §4.8: the fixture home freezes two fleets, so every one of these passes
 * `--fleet main` — `teardown` refuses to fall through to the default when more
 * than one is frozen, and that refusal is pinned in `fleets.test.ts`. What is
 * being tested here is the *second* gate, the typed digits, which is reached
 * only once the fleet has been named.
 */
describe.concurrent("teardown confirms with the twelve digits, and never just --yes", () => {
  test("--yes alone, non-interactively, is 8: it needs --confirm-account-id too", async () => {
    const { code, stderr } = await run("teardown", "--fleet", "main", "--yes");
    expect(code).toBe(8);
    expect(stderr).toContain("--confirm-account-id");
  });

  test("--confirm-account-id without --yes is still 8", async () => {
    const { code, stderr } = await run(
      "teardown",
      "--fleet",
      "main",
      "--confirm-account-id",
      "123456789012",
    );
    expect(code).toBe(8);
    expect(stderr).toContain("CONFIRMATION_REQUIRED");
  });

  test("--confirm-account-id must be twelve digits", async () => {
    const { code, stderr } = await run(
      "teardown",
      "--fleet",
      "main",
      "--yes",
      "--confirm-account-id",
      "12345",
    );
    expect(code).toBe(2);
    expect(stderr).toContain("twelve digits");
  });

  test("the wrong digits are a confirmation failure, not a doomed teardown", async () => {
    const { code, stderr } = await run(
      "teardown",
      "--fleet",
      "main",
      "--yes",
      "--confirm-account-id",
      "999999999999",
    );
    expect(code).toBe(8);
    expect(stderr).toContain("does not match");
  });

  test("the plan and its manual-steps warnings print before the account id is asked for", async () => {
    const { stderr } = await run(
      "teardown",
      "--fleet",
      "main",
      "--yes",
      "--confirm-account-id",
      "999999999999",
    );
    expect(stderr).toContain("plan: teardown");
    expect(stderr).toContain("manual steps after teardown");
  });
});

/**
 * F1/F2: `hermetic apply plan.json --yes` used to be the way round the §4.7
 * ceremony — a teardown plan applied with nothing but a habitual keypress. A
 * teardown-kind plan now confirms the way `hermetic teardown` does.
 */
describe.concurrent("apply of a teardown plan confirms with the twelve digits", () => {
  /**
   * §4.8: two fleets are frozen in the fixture home, so both halves name the
   * one they mean — the plan is *made* for `main` and the apply is *pointed*
   * at `main`. `fleets.test.ts` pins what happens when either half is left to
   * chance.
   */
  async function teardownPlanFile(): Promise<string> {
    const { code, stdout } = await run("plan", "teardown", "--fleet", "main", "--json");
    expect(code).toBe(0);
    const file = join(HOME, `teardown-plan-${crypto.randomUUID()}.json`);
    await Bun.write(file, stdout);
    return file;
  }

  test("--yes alone, non-interactively, is 8: it needs --confirm-account-id too", async () => {
    const file = await teardownPlanFile();
    const { code, stderr } = await run("apply", file, "--fleet", "main", "--yes");
    expect(code).toBe(8);
    expect(stderr).toContain("--confirm-account-id");
  });

  test("--confirm-account-id must be twelve digits", async () => {
    const file = await teardownPlanFile();
    const { code, stderr } = await run(
      "apply",
      file,
      "--fleet",
      "main",
      "--yes",
      "--confirm-account-id",
      "12345",
    );
    expect(code).toBe(2);
    expect(stderr).toContain("twelve digits");
  });

  test("the wrong digits are a confirmation failure, and nothing is applied", async () => {
    const file = await teardownPlanFile();
    const { code, stderr } = await run(
      "apply",
      file,
      "--fleet",
      "main",
      "--yes",
      "--confirm-account-id",
      "999999999999",
    );
    expect(code).toBe(8);
    expect(stderr).toContain("does not match");
  });

  test("the plan is printed before the account id is asked for", async () => {
    const file = await teardownPlanFile();
    const { stderr } = await run(
      "apply",
      file,
      "--fleet",
      "main",
      "--yes",
      "--confirm-account-id",
      "999999999999",
    );
    expect(stderr).toContain("plan: teardown");
  });

  /** An agent-level plan keeps its own ceremony: `--yes`, not the digits. */
  test("a destroy plan still applies with --yes alone", async () => {
    const { code, stdout } = await run("plan", "destroy", "atlas", "--json");
    expect(code).toBe(0);
    const file = join(HOME, `destroy-plan-${crypto.randomUUID()}.json`);
    await Bun.write(file, stdout);
    const applied = await run("apply", file, "--yes");
    expect(applied.code).toBe(0);
    expect(applied.stderr).toContain("plan: destroy atlas");
  });
});

describe.concurrent("exit statuses", () => {
  test("a destructive command with no --yes and no terminal is 8", async () => {
    const { code, stderr } = await run("agent", "destroy", "x");
    expect(code).toBe(8);
    expect(stderr).toContain("CONFIRMATION_REQUIRED");
  });

  test("teardown with no --yes is 8", async () => {
    expect((await run("teardown")).code).toBe(8);
  });

  test("core's own Zod schema rejects a bad name with 2", async () => {
    const { code, stderr } = await run("agent", "create", "BAD_NAME");
    expect(code).toBe(2);
    expect(stderr).toContain("invalid arguments");
    expect(stderr).toContain("name");
  });

  test("upgrade with neither version fails the schema's refinement with 2", async () => {
    expect((await run("upgrade", "atlas")).code).toBe(2);
  });

  test("an unknown agent is 6", async () => {
    expect((await run("agent", "status", "nosuchagent")).code).toBe(6);
  });

  test("Ctrl-C ends the process with 130", async () => {
    // `secrets push` in a non-terminal blocks reading the value from stdin, so
    // this is a command that is genuinely waiting when the signal arrives.
    const proc = Bun.spawn([await cliBinary(), "secrets", "push", "atlas", "--bws-token"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HERMETIC_FIXTURE: "1", HERMETIC_NO_TTY: "1", HERMETIC_HOME: HOME },
    });
    await Bun.sleep(400);
    proc.kill("SIGINT");
    expect(await proc.exited).toBe(130);
  });

  test("--json puts the error on stdout as well", async () => {
    const { code, stdout } = await run("agent", "status", "nosuchagent", "--json");
    expect(code).toBe(6);
    expect(JSON.parse(stdout) as { error: { code: string } }).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
  });
});

/**
 * §6.4's operator surface: the four Hermes settings, on the command that moves
 * them. Stating one is what makes hermetic *manage* it, so these flags are the
 * difference between "the agent's model" and "the fleet's model for this agent"
 * — and each one is validated by the same Zod schema core uses, which is what
 * makes a typo a refusal here rather than a config the box cannot read.
 */
describe.concurrent("agent set · the Hermes settings", () => {
  // `atlas` is on Bedrock, and a bare `--model` on a row with nothing staged is
  // checked against the fleet's grant (§5.1/§8.3) — so the model named here is
  // one the fixture fleet's role may actually invoke.
  test("--model is accepted and comes back managed", async () => {
    const { code, stdout } = await run("agent", "set", "atlas", "--model", "zai.glm-4.7-flash");
    expect(code).toBe(0);
    expect(stdout).toContain("zai.glm-4.7-flash (managed)");
  });

  test("a Bedrock model the fleet's role may not invoke is refused, not managed", async () => {
    const { code, stderr } = await run("agent", "set", "atlas", "--model", "zai.glm-9-ungranted");
    expect(code).not.toBe(0);
    expect(stderr).toContain("foundation update");
  });

  test("--terminal takes the two backends and refuses a third", async () => {
    expect((await run("agent", "set", "atlas", "--terminal", "docker")).code).toBe(0);
    const { code, stderr } = await run("agent", "set", "atlas", "--terminal", "kubernetes");
    expect(code).toBe(2);
    expect(stderr).toContain("terminal_backend");
  });

  test("--max-turns takes a positive integer and refuses zero", async () => {
    expect((await run("agent", "set", "atlas", "--max-turns", "42")).code).toBe(0);
    const { code, stderr } = await run("agent", "set", "atlas", "--max-turns", "0");
    expect(code).toBe(2);
    expect(stderr).toContain("max_turns");
  });

  test("--reasoning takes the three efforts and refuses a fourth", async () => {
    expect((await run("agent", "set", "atlas", "--reasoning", "high")).code).toBe(0);
    const { code, stderr } = await run("agent", "set", "atlas", "--reasoning", "maximum");
    expect(code).toBe(2);
    expect(stderr).toContain("reasoning_effort");
  });

  /**
   * The one seed-only flag (`SEED_ONLY` in `schema/hermes.ts`): stating it moves
   * where the agent starts, and never makes the mode a key hermetic holds — so
   * the row it prints says seeded whether or not the operator named it.
   */
  test("--approvals takes the three modes and refuses a fourth", async () => {
    const ok = await run("agent", "set", "atlas", "--approvals", "manual");
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("manual (seeded");
    const { code, stderr } = await run("agent", "set", "atlas", "--approvals", "ask-me");
    expect(code).toBe(2);
    expect(stderr).toContain("approvals_mode");
  });

  test("a stated approvals mode is still seeded, never managed", async () => {
    const { code, stdout } = await run("agent", "set", "atlas", "--approvals", "smart");
    expect(code).toBe(0);
    expect(stdout).toContain("smart (seeded");
    expect(stdout).not.toContain("smart (managed)");
  });

  test("an agent nobody set a mode on shows hermetic's own default", async () => {
    const { code, stdout } = await run("agent", "status", "corvid");
    expect(code).toBe(0);
    expect(stdout).toContain("off (seeded");
  });

  test("an empty --model is refused rather than managed as nothing", async () => {
    const { code, stderr } = await run("agent", "set", "atlas", "--model", "");
    expect(code).toBe(2);
    expect(stderr).toContain("model");
  });

  test("the settings an operator did not name stay seeded", async () => {
    const { code, stdout } = await run("agent", "set", "atlas", "--model", "zai.glm-4.7-flash");
    expect(code).toBe(0);
    expect(stdout).toContain("(seeded — the agent's to change)");
  });

  /**
   * §8.3's stale-form guard on the row, from the CLI. A second terminal — or a
   * drawer left open — that composed its change against a version somebody else
   * has already consumed must be told, not quietly allowed to win.
   */
  test("--expected-version refuses a row that has moved, and passes one that has not", async () => {
    const { code, stdout } = await run("agent", "status", "atlas", "--json");
    expect(code).toBe(0);
    const version = (JSON.parse(stdout) as { version: number }).version;

    const ok = await run(
      "agent",
      "set",
      "atlas",
      "--max-turns",
      "11",
      "--expected-version",
      String(version),
    );
    expect(ok.code).toBe(0);

    // Every fixture run starts from the same seed, so "the row has moved" is
    // stated as a version the row has not reached rather than by writing twice.
    const stale = await run(
      "agent",
      "set",
      "atlas",
      "--max-turns",
      "12",
      "--expected-version",
      String(version + 1),
    );
    expect(stale.code).not.toBe(0);
    expect(stale.stderr).toContain("re-read and retry");
  });

  test("--expected-version that is not a number is refused before anything is read", async () => {
    const { code, stderr } = await run("agent", "set", "atlas", "--expected-version", "soon");
    expect(code).toBe(2);
    expect(stderr).toContain("expected_version");
  });
});

/**
 * §8.3: **a create never asks for a credential.** The key lives on the provider
 * profile, core copies it from there into the agent's own slot, and this run
 * has no terminal and no stdin — so a create that still asked would hang.
 */
describe.concurrent("agent create · the credential the profile already holds", () => {
  test("a profile-bound create needs no prompt, and never echoes the value", async () => {
    const { code, stdout, stderr } = await run(
      "agent",
      "create",
      "kite",
      "--provider-profile",
      "openrouter-cheap",
      "--json",
    );
    expect(code).toBe(0);
    expect(stdout).toContain("copied from provider profile openrouter-cheap");
    for (const stream of [stdout, stderr]) {
      expect(stream).not.toContain("sk-profile-FIXTURE");
    }
    // …and the run log, which is the other place a value could land (§8.3).
    const recorder = runRecorderFor({ home: HOME, fixture: true });
    try {
      const rows = await recorder.list({ limit: 50 });
      const row = rows.find((r) => r.command === "agent create" && r.args[0] === "kite");
      expect(row).toBeDefined();
      expect(JSON.stringify(row)).not.toContain("sk-profile-FIXTURE");
    } finally {
      recorder.close();
    }
  });

  /** A `--provider` the enum does not know is a usage error, as it always was. */
  test("an unknown --provider is a usage error", async () => {
    const { code, stderr } = await run("agent", "create", "kestrel", "--provider", "bogus", "--json");
    expect(code).toBe(2);
    expect(stderr).toContain("provider");
  });

  /** A bare `--provider` resolves to the fleet's designated profile for it. */
  test("a bare --provider resolves to the fleet's profile for it", async () => {
    const { code } = await run("agent", "create", "wren", "--provider", "bedrock", "--json");
    expect(code).toBe(0);
  });

  /**
   * §8.3: the flag is gone from `create`, and the refusal names where keys live
   * now rather than reporting an unknown option.
   */
  test("--api-key-stdin is no longer an option on create", async () => {
    const { code, stderr } = await run("agent", "create", "wren", "--api-key-stdin", "--json");
    expect(code).toBe(2);
    expect(stderr).toContain("api-key-stdin");
  });
});

/**
 * §4.6: which fleet a run was against, for every way of choosing one.
 *
 * The row is opened before core is, so all the head can put in it at `start` is
 * what the operator typed — which meant an alias, `HERMETIC_FLEET` and the
 * persisted default all recorded nothing, and the readers filled the silence
 * with whatever fleet was open at the time. These run the real binary through
 * each branch of the selection chain and read back what the row says.
 */
describe("a run is attributed to the fleet it resolved", () => {
  /** The rows this home has now, newest first. */
  async function rows(): Promise<CoreRun[]> {
    const recorder = runRecorderFor({ home: HOME, fixture: true });
    try {
      return await recorder.list({ limit: 500 });
    } finally {
      recorder.close();
    }
  }

  /** Run a command and hand back the one row it added. */
  async function rowFor(env: Record<string, string>, ...args: string[]): Promise<CoreRun> {
    const before = new Set((await rows()).map((r) => r.id));
    const proc = Bun.spawn([await cliBinary(), ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HERMETIC_FIXTURE: "1", HERMETIC_NO_TTY: "1", HERMETIC_HOME: HOME, ...env },
    });
    await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    const added = (await rows()).find((r) => !before.has(r.id));
    expect(added).toBeDefined();
    return added as CoreRun;
  }

  /** Every branch writes the same target; only the way of asking differs. */
  const MAIN_FLEET = { fleet: "fxtr0001", fleet_name: "main" };
  const STAGING_FLEET = { fleet: "sg7k2m4p", fleet_name: "staging" };

  test("an explicit fleet id is recorded as itself", async () => {
    const row = await rowFor({}, "agent", "ps", "--fleet", "fxtr0001");
    expect(row).toMatchObject(MAIN_FLEET);
    // The rest of the target, so a row can still be placed once the home has
    // been re-pointed at another account (§4.6).
    expect(row.account_id).toBe("123456789012");
    expect(row.region).toBe("us-west-2");
  });

  test("an alias is recorded as the fleet it resolved to, not as the label", async () => {
    const row = await rowFor({}, "agent", "ps", "--fleet", "staging");
    expect(row).toMatchObject(STAGING_FLEET);
  });

  test("HERMETIC_FLEET is recorded, though the flag said nothing", async () => {
    const row = await rowFor({ HERMETIC_FLEET: "staging" }, "agent", "ps");
    expect(row).toMatchObject(STAGING_FLEET);
  });

  test("the persisted default is recorded, though nothing named it at all", async () => {
    const row = await rowFor({}, "agent", "ps");
    expect(row).toMatchObject(MAIN_FLEET);
  });

  /**
   * The row that stays unattributed, and should: nothing resolved, so there is
   * no fleet this command was against. A reader shows it as unknown rather than
   * as whichever fleet is open — that one's history is a different list.
   */
  test("a command that never resolved a fleet records no identity", async () => {
    const row = await rowFor({}, "agent", "ps", "--fleet", "nosuchflt");
    expect(row.fleet).toBeNull();
    expect(row.account_id).toBeNull();
    expect(row.region).toBeNull();
    expect(row.fleet_name).toBeNull();
    expect(row.exit_code).not.toBe(0);
  });

  /**
   * §4.8: an alias is a label over an id, and `--fleet <alias>` is still only a
   * provisional answer until core has resolved it. What lands in the row is the
   * id, so a run stays attributed to the fleet it ran against after the label
   * has moved to another one.
   */
  test("two fleets' rows are told apart by id, not by the alias they shared", async () => {
    const staging = await rowFor({}, "agent", "ps", "--fleet", "sg7k2m4p");
    const main = await rowFor({}, "agent", "ps", "--fleet", "fxtr0001");
    expect(staging.fleet).toBe("sg7k2m4p");
    expect(main.fleet).toBe("fxtr0001");
  });
});

describe("the local run log", () => {
  /**
   * §4.6: every command this laptop ran, with its output and exit code. Read
   * back through core rather than through `hermetic runs`, because
   * `openHermetic({ fixture: true })` wires no run store — see the report's
   * core-gap list.
   */
  test("a successful command is recorded with its output", async () => {
    await run("agent", "status", "atlas");
    const recorder = runRecorderFor({ home: HOME, fixture: true });
    try {
      const rows = await recorder.list({ limit: 50 });
      const row = rows.find((r) => r.command === "agent status" && r.args[0] === "atlas");
      expect(row).toBeDefined();
      expect(row?.exit_code).toBe(0);
      expect(row?.agent).toBe("atlas");
      expect(row?.log).toContain("atlas");
      expect(row?.finished_at).not.toBeNull();
    } finally {
      recorder.close();
    }
  });

  test("a failed command is recorded with the status it failed on", async () => {
    await run("agent", "status", "nosuchagent");
    const recorder = runRecorderFor({ home: HOME, fixture: true });
    try {
      const rows = await recorder.list({ limit: 50 });
      const row = rows.find((r) => r.args[0] === "nosuchagent");
      expect(row?.exit_code).toBe(6);
    } finally {
      recorder.close();
    }
  });

  test("`runs` does not record its own output into the log it prints", async () => {
    // The bug: `runs --json` printed every row's log, and its own output was
    // then recorded as the next row's log, so five invocations went
    // 295 → 871 → 2120 → 4899 → 11290 bytes and kept squaring.
    for (let i = 0; i < 5; i += 1) await run("runs", "--json");
    const recorder = runRecorderFor({ home: HOME, fixture: true });
    try {
      const rows = (await recorder.list({ limit: 50 })).filter((r) => r.command === "runs");
      expect(rows.length).toBeGreaterThanOrEqual(5);
      for (const row of rows) expect(row.log).toBe("");
    } finally {
      recorder.close();
    }
  });

  test("no row's captured output exceeds the cap", async () => {
    await run("agent", "ps");
    await run("agent", "history", "atlas");
    const recorder = runRecorderFor({ home: HOME, fixture: true });
    try {
      for (const row of await recorder.list({ limit: 200 })) {
        expect(row.log.length).toBeLessThanOrEqual(4 * 1024);
      }
    } finally {
      recorder.close();
    }
  });

  test("`runs` omits the log column unless --full asks for it", async () => {
    await run("agent", "ps");
    const brief = JSON.parse((await run("runs", "--json")).stdout) as Array<Record<string, unknown>>;
    expect(brief.length).toBeGreaterThan(0);
    for (const row of brief) expect(row).not.toHaveProperty("log");

    const full = JSON.parse((await run("runs", "--json", "--full")).stdout) as Array<
      Record<string, unknown>
    >;
    expect(full[0]).toHaveProperty("log");
  });

  test("secrets push records that it ran, never what it pushed", async () => {
    const proc = Bun.spawn([await cliBinary(), "secrets", "push", "kestrel", "--bws-token"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HERMETIC_FIXTURE: "1", HERMETIC_NO_TTY: "1", HERMETIC_HOME: HOME },
    });
    proc.stdin.write("super-secret-value\n");
    await proc.stdin.end();
    await proc.exited;

    const recorder = runRecorderFor({ home: HOME, fixture: true });
    try {
      const rows = await recorder.list({ limit: 50 });
      const row = rows.find((r) => r.command === "secrets push");
      expect(row).toBeDefined();
      expect(row?.log).toBe("[redacted]");
      for (const r of rows) expect(r.log).not.toContain("super-secret-value");
    } finally {
      recorder.close();
    }
  });

  /**
   * The only fleet slot (§5): rotating the Tailscale OAuth client, which is
   * the only way a fleet whose client predates `devices:core` gets the scope —
   * Tailscale cannot add one to an existing client. End-to-end because the
   * value arrives on stdin and the verdict is core's, and the thing worth
   * proving is that neither the terminal nor the run log sees the secret.
   *
   * Piped with a CRLF on purpose: the trailing newline belongs to the pipe, not
   * to the operator, and `\r` as much as `\n` — a CRLF here-doc, a Windows
   * shell or a secret copied out of a CRLF file all arrive with the carriage
   * return attached. A `\r` that survived `readSecret` would make this a value
   * Tailscale never issued, so a zero exit is the proof it was stripped.
   */
  test("the fleet's Tailscale OAuth client rotates from stdin, unechoed", async () => {
    const secret = "tskey-client-FIXTURE1-FIXTUREFIXTURE";
    const proc = Bun.spawn([await cliBinary(), "secrets", "push", "_fleet", "--tailscale-oauth"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HERMETIC_FIXTURE: "1", HERMETIC_NO_TTY: "1", HERMETIC_HOME: HOME },
    });
    proc.stdin.write(`${secret}\r\n`);
    await proc.stdin.end();
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain("wrote /hermetic/fxtr0001/tailscale/oauth-secret");
    // The fixture client carries both scopes, so there is nothing to warn about.
    expect(`${stdout}${stderr}`).not.toContain("warning:");
    expect(`${stdout}${stderr}`).not.toContain(secret);
  });

  test("a value that is not an OAuth client secret is refused, unechoed", async () => {
    const bad = "FIXTURE-not-a-client-secret";
    const proc = Bun.spawn([await cliBinary(), "secrets", "push", "_fleet", "--tailscale-oauth"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HERMETIC_FIXTURE: "1", HERMETIC_NO_TTY: "1", HERMETIC_HOME: HOME },
    });
    proc.stdin.write(bad);
    await proc.stdin.end();
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(code).not.toBe(0);
    expect(`${stdout}${stderr}`).toContain("tskey-client-");
    expect(`${stdout}${stderr}`).not.toContain(bad);
  });
});

/**
 * §6.5: the two halves of `upgrade` take different shapes, and the CLI is where
 * an operator finds that out. `--hermeticd` moves the one pointer every box
 * follows, so it takes no agent — and naming one has to be refused, not
 * silently widened to the fleet.
 */
describe.concurrent("upgrade: hermeticd is fleet-wide", () => {
  test("`upgrade --hermeticd V` parses with no positional and reaches core", async () => {
    const { code, stdout, stderr } = await run(
      "upgrade",
      "--hermeticd",
      BUILD_VERSIONS.hermeticd,
      "--json",
    );
    expect(`${stdout}${stderr}`).not.toContain("required");
    // It reaches core and runs: the fixture bucket holds the release this build
    // ships. Named rather than spelled out, so bumping `BUILD_VERSIONS` does not
    // leave this test asserting against a version nothing published.
    expect(code).toBe(0);
    expect(`${stdout}${stderr}`).toContain("fleet manifest");
  });

  test("`upgrade <name> --hermeticd V` is refused, and says why", async () => {
    const { code, stdout, stderr } = await run("upgrade", "atlas", "--hermeticd", "0.5.0");
    expect(code).not.toBe(0);
    expect(`${stdout}${stderr}`).toContain("fleet-wide");
  });
});

/**
 * §7.1: journald holds Hermes's startup banner and uvicorn's request
 * noise, because upstream attaches no stderr handler unless it is run verbose.
 * The turn that failed is in `$HERMES_HOME/logs/errors.log`, so `logs` can name
 * a file instead of a unit.
 */
describe.concurrent("logs: Hermes's own log files", () => {
  test("`logs <name> --file errors` reads the file, labelled by the file", async () => {
    const { code, stdout } = await run("logs", "atlas", "--file", "errors", "--json");
    expect(code).toBe(0);
    const lines = stdout
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { unit: string });
    expect(lines.map((l) => l.unit)).toEqual(["errors.log"]);
  });

  test("a file name the enum does not know is a usage error on the laptop", async () => {
    const { code, stdout, stderr } = await run("logs", "atlas", "--file", "everything");
    expect(code).not.toBe(0);
    // Commander's own `choices` message, before anything reaches the tailnet.
    expect(`${stdout}${stderr}`).toContain("Allowed choices");
  });

  test.each([
    ["a unit and a file", ["logs", "atlas", "hermes-dashboard.service", "--file", "agent"]],
    ["the console and a file", ["logs", "atlas", "--file", "agent", "--console"]],
  ])("%s is refused before the request goes out", async (_why, argv) => {
    const { code, stdout, stderr } = await run(...argv);
    expect(code).not.toBe(0);
    expect(`${stdout}${stderr}`).toContain("file");
  });
});

/**
 * §8.3's provider profiles, through the real process. The fixture's canned
 * catalogs answer `providers models`, so nothing here opens a socket — and the
 * assertion that matters on every one of them is that no key is anywhere in
 * stdout, stderr or the `runs` log.
 */
describe("providers: named profiles over the fixture fleet", () => {
  test("`providers ls` renders every fixture profile and marks the default", async () => {
    const { code, stdout, stderr } = await run("providers", "ls");
    expect(code).toBe(0);
    expect(stderr).toContain(HEADER);
    for (const name of [
      "anthropic-main",
      "openrouter-cheap",
      "nous-lab",
      "bedrock-role",
      "vercel-gw",
    ]) {
      expect(stdout).toContain(name);
    }
    expect(stdout).toContain("anthropic-main *");
    // Readiness is stated, in core's own words.
    expect(stdout).toContain("no (key-placeholder)");
    expect(stdout).toContain("no (disabled)");
    expect(stdout).toContain("granted");
  });

  test("`providers ls --json` is the same answer as a document", async () => {
    const { code, stdout } = await run("providers", "ls", "--json");
    expect(code).toBe(0);
    const body = JSON.parse(stdout) as {
      profiles: Array<{ name: string; ready: boolean; linked_agents: string[] }>;
      default_profile: string;
      bedrock_model_ids: string[];
    };
    expect(body.profiles).toHaveLength(5);
    expect(body.bedrock_model_ids).toContain("zai.glm-4.7-flash");
    // No slot value reaches a head, ever (§8.3).
    expect(stdout).not.toContain("sk-profile-FIXTURE");
  });

  test("`providers models --profile` pins the profile's own model first", async () => {
    const { code, stdout } = await run("providers", "models", "--profile", "anthropic-main", "--json");
    expect(code).toBe(0);
    const body = JSON.parse(stdout) as {
      provider: string;
      default_model: string;
      models: Array<{ id: string }>;
    };
    expect(body.provider).toBe("anthropic");
    expect(body.default_model).toBe("claude-sonnet-5");
    expect(body.models[0]?.id).toBe("claude-sonnet-5");
    // The fixture catalog carries an embedding model; it is excluded.
    expect(body.models.map((m) => m.id)).not.toContain("claude-embed-v1");
  });

  test("`providers models` on a profile with no key stored says so", async () => {
    const { code, stdout, stderr } = await run("providers", "models", "--profile", "nous-lab");
    expect(code).not.toBe(0);
    expect(`${stdout}${stderr}`).toContain("no key stored");
  });

  test("naming both a profile and a provider is a usage error", async () => {
    const { code, stdout, stderr } = await run(
      "providers",
      "models",
      "--profile",
      "anthropic-main",
      "--provider",
      "openai",
    );
    expect(code).not.toBe(0);
    expect(`${stdout}${stderr}`).toContain("exactly one");
  });

  test("`providers update` bumps the revision and re-states the profile", async () => {
    const { code, stdout } = await run(
      "providers",
      "update",
      "openrouter-cheap",
      "--model",
      "z-ai/glm-5.2",
      "--json",
    );
    expect(code).toBe(0);
    const body = JSON.parse(stdout) as { profile: { model: string; revision: number } };
    expect(body.profile).toMatchObject({ model: "z-ai/glm-5.2", revision: 2 });
  });

  test("`providers update --provider` is refused: the provider is immutable", async () => {
    const { code, stdout, stderr } = await run(
      "providers",
      "update",
      "openrouter-cheap",
      "--provider",
      "openai",
    );
    expect(code).not.toBe(0);
    expect(`${stdout}${stderr}`).toContain("immutable");
  });

  /**
   * Commander spells `--no-key` as `key: false`, not `noKey: true`. Reading the
   * camel-cased name meant the flag did nothing: on a TTY the prompt still
   * appeared, which is the one thing it exists to suppress. The spawned CLI is
   * never a TTY, so what this asserts is the flag's *other* effect — a profile
   * that is created and is honestly not ready.
   */
  test("`providers create --no-key` makes a profile that is not ready yet", async () => {
    const { code, stdout } = await run(
      "providers",
      "create",
      "--provider",
      "openai",
      "--name",
      "cli-nokey",
      "--no-key",
      "--json",
    );
    expect(code).toBe(0);
    const body = JSON.parse(stdout) as {
      profile: { name: string; ready: boolean; ready_reason: string };
    };
    expect(body.profile).toMatchObject({
      name: "cli-nokey",
      ready: false,
      ready_reason: "key-missing",
    });
  });

  test("`providers rm` needs --yes when nobody can be asked", async () => {
    const { code, stdout, stderr } = await run("providers", "rm", "vercel-gw");
    expect(code).not.toBe(0);
    expect(`${stdout}${stderr}`).toContain("yes");
  });

  test("`providers create --api-key-stdin` never puts the key in the run log", async () => {
    const key = "sk-FIXTURE-CLI-PROFILE-KEY";
    const proc = Bun.spawn(
      [
        await cliBinary(),
        "providers",
        "create",
        "--provider",
        "openai",
        "--name",
        "cli-openai",
        "--api-key-stdin",
        "--json",
      ],
      {
        stdin: new Response(key),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HERMETIC_FIXTURE: "1", HERMETIC_NO_TTY: "1", HERMETIC_HOME: HOME },
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code).toBe(0);
    const body = JSON.parse(stdout) as { profile: { name: string; ready: boolean } };
    expect(body.profile).toMatchObject({ name: "cli-openai", ready: true });
    expect(`${stdout}${stderr}`).not.toContain(key);
    const recorder = runRecorderFor({ home: HOME, fixture: true });
    expect(JSON.stringify(recorder.list({ limit: 5 }))).not.toContain(key);
  });
});
