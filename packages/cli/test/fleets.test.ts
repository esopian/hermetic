/**
 * §4.8 through the CLI head, spawned as a real process like the rest of
 * `packages/cli/test`. The fixture home freezes both fixture fleets (`main`,
 * the twelve-agent one, and `staging`, two agents and one foundation version
 * behind), which is exactly the shape this feature exists for: several fleets
 * in one account, one of them the default.
 *
 * Each test that *writes* — `fleet use` records a default — gets its own home,
 * so the order tests run in cannot change what another one sees.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearConfig,
  fixtureConfigFor,
  listConfigs,
  openLocalDb,
  setDefaultFleet,
} from "@hermetic/core";
import { skipsFoundationCheck } from "../src/context.ts";
import { cliBinary, seedFixtureHome } from "./cli-binary.ts";

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function home(): string {
  return mkdtempSync(join(tmpdir(), "hermetic-fleets-test-"));
}

/**
 * A fixture home materialises its two fleets the first time core is opened in
 * it (`seedFixtureFleets`), and `teardown`'s guard reads the local rows before
 * opening anything — so a test whose *first* command is the guarded one would
 * be asking a home that is still empty. One cheap read first is the fixture's
 * equivalent of having run `init`.
 */
async function seededHome(): Promise<string> {
  const h = home();
  expect((await runIn(h, "fleet", "ls", "--json")).code).toBe(0);
  return h;
}

/** Read-only commands share one home; a writing test passes its own. */
const SHARED = home();
beforeAll(() => seedFixtureHome(SHARED));

async function run(...args: string[]): Promise<Run> {
  return runIn(SHARED, ...args);
}

async function runIn(hermeticHome: string, ...args: string[]): Promise<Run> {
  return runEnv({ home: hermeticHome }, ...args);
}

async function runEnv(
  opts: { home: string; fixture?: boolean; env?: Record<string, string> },
  ...args: string[]
): Promise<Run> {
  const proc = Bun.spawn([await cliBinary(), ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...(opts.fixture === false ? {} : { HERMETIC_FIXTURE: "1" }),
      HERMETIC_NO_TTY: "1",
      HERMETIC_HOME: opts.home,
      // The selection rule reads it, and a developer's shell may have set it.
      HERMETIC_FLEET: "",
      ...opts.env,
    },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

interface FleetRow {
  name: string;
  fleet_id: string | null;
  local: boolean;
  registered: boolean;
  default: boolean;
  current: boolean;
  foundation_version: number | null;
  update_available: boolean;
}

interface FleetsJson {
  directory_region: string;
  directory_error: string | null;
  fleets: FleetRow[];
}

describe.concurrent("fleet ls", () => {
  test("lists both fixture fleets, saying which is current and which is behind", async () => {
    const { code, stdout } = await run("fleet", "ls", "--json");
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as FleetsJson;
    expect(result.directory_error).toBeNull();
    const byName = new Map(result.fleets.map((f) => [f.name, f]));
    expect([...byName.keys()].sort()).toEqual(["main", "staging"]);

    const main = byName.get("main") as FleetRow;
    expect(main.current).toBe(true);
    expect(main.default).toBe(true);
    expect(main.local).toBe(true);
    expect(main.registered).toBe(true);
    expect(main.update_available).toBe(false);

    const staging = byName.get("staging") as FleetRow;
    expect(staging.current).toBe(false);
    // The whole point of the second fixture fleet: one foundation version
    // behind, so every head has something to flag without an AWS account.
    expect(staging.update_available).toBe(true);
    expect(staging.foundation_version).toBe((main.foundation_version as number) - 1);
  });

  test("the table marks the current fleet, the default, and the update", async () => {
    const { code, stdout } = await run("fleet", "ls");
    expect(code).toBe(0);
    expect(stdout).toContain("NAME");
    expect(stdout).toContain("*main");
    expect(stdout).toContain("(update available)");
    // `*` in the DEFAULT column, on the row that is the default.
    const mainRow = stdout.split("\n").find((l) => l.includes("*main")) as string;
    expect(mainRow.trimEnd().endsWith("*")).toBe(true);
  });
});

describe.concurrent("--fleet picks the fleet, on either side of the subcommand", () => {
  test("before the subcommand", async () => {
    const { code, stdout, stderr } = await run("--fleet", "staging", "agent", "ps", "--json");
    expect(code).toBe(0);
    const agents = JSON.parse(stdout) as Array<{ name: string }>;
    expect(agents.map((a) => a.name)).toEqual(["ember", "quill"]);
    // §4.7's header now leads with the fleet, so the operator can see which one
    // answered without reading the account id.
    expect(stderr.split("\n")[0]).toStartWith("▸ staging");
  });

  test("after the subcommand", async () => {
    const { code, stdout, stderr } = await run("agent", "ps", "--fleet", "staging", "--json");
    expect(code).toBe(0);
    const agents = JSON.parse(stdout) as Array<{ name: string }>;
    expect(agents.map((a) => a.name)).toEqual(["ember", "quill"]);
    expect(stderr.split("\n")[0]).toStartWith("▸ staging");
  });
});

describe.concurrent("init --attach", () => {
  test("freezes a seeded fleet that is missing from this home", async () => {
    const h = await seededHome();
    const staging = fixtureConfigFor("staging");
    const before = openLocalDb({ home: h, fixture: true });
    clearConfig(before.db, staging.fleet_id);
    expect(listConfigs(before.db).map((f) => f.name)).toEqual(["main"]);
    before.close();

    const result = await runIn(
      h,
      "init",
      "--attach",
      "--fleet",
      "staging",
      "--confirm-account-id",
      staging.account_id,
      "--yes",
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("▸ staging");

    const after = openLocalDb({ home: h, fixture: true });
    expect(listConfigs(after.db).map((f) => f.name)).toEqual(["main", "staging"]);
    after.close();
  });
});

describe.concurrent("fleet use", () => {
  test("records the default, and a bare command then means it", async () => {
    const h = home();
    const used = await runIn(h, "fleet", "use", "staging");
    expect(used.code).toBe(0);
    // The document a command produces goes to stdout; this one produces none.
    expect(used.stdout).toBe("");
    // §4.6: an alias goes in, the fleet id is what gets recorded and reported.
    expect(used.stderr).toContain("default fleet: sg7k2m4p (was fxtr0001)");

    const { code, stdout, stderr } = await runIn(h, "agent", "ps", "--json");
    expect(code).toBe(0);
    expect((JSON.parse(stdout) as Array<{ name: string }>).map((a) => a.name)).toEqual([
      "ember",
      "quill",
    ]);
    expect(stderr.split("\n")[0]).toStartWith("▸ staging");
  });

  test("a fleet this home has not frozen is NOT_FOUND, not a silent switch", async () => {
    const { code, stderr } = await runIn(home(), "fleet", "use", "nope");
    expect(code).toBe(6);
    expect(stderr).toContain("NOT_FOUND");
    expect(stderr).toContain("is not frozen in this home");
  });
});

describe.concurrent("directory status", () => {
  test("reports the table, its backup bound, and every fleet in it", async () => {
    const { code, stdout } = await run("directory", "status", "--json");
    expect(code).toBe(0);
    const status = JSON.parse(stdout) as {
      exists: boolean;
      pitr_enabled: boolean;
      pitr_recovery_days: number | null;
      deletion_protection: boolean;
      fleets: Array<{ name: string }>;
    };
    expect(status.exists).toBe(true);
    expect(status.pitr_enabled).toBe(true);
    // §4.8: the recovery window is bounded, and 7 days is the bound.
    expect(status.pitr_recovery_days).toBe(7);
    expect(status.deletion_protection).toBe(true);
    expect(status.fleets.map((f) => f.name).sort()).toEqual(["main", "staging"]);
  });
});

describe.concurrent("teardown will not guess which fleet", () => {
  test("two fleets frozen and no --fleet is a refusal, not the default", async () => {
    const { code, stderr } = await runIn(await seededHome(), "teardown", "--yes");
    expect(code).toBe(8);
    expect(stderr).toContain("two or more fleets are frozen here (fxtr0001, sg7k2m4p)");
    expect(stderr).toContain("teardown needs an explicit --fleet <fleet-id>");
    // It refused before planning anything.
    expect(stderr).not.toContain("plan: teardown");
  });

  test("with --fleet it plans, and the typed confirmation names the fleet", async () => {
    const { code, stderr } = await runIn(await seededHome(), "teardown", "--yes", "--fleet", "staging");
    // No TTY and no --confirm-account-id: it gets as far as the typed gate.
    expect(code).toBe(8);
    expect(stderr).toContain("plan: teardown");
    expect(stderr).toContain('teardown of fleet "staging"');
  });
});

describe.concurrent("HERMETIC_FLEET selects, but it does not decide", () => {
  test("teardown still refuses: an exported variable is not an explicit --fleet", async () => {
    const { code, stderr } = await runEnv(
      { home: await seededHome(), env: { HERMETIC_FLEET: "staging" } },
      "teardown",
      "--yes",
    );
    expect(code).toBe(8);
    expect(stderr).toContain("teardown needs an explicit --fleet <fleet-id>");
  });

  test("but it does pick the fleet for an ordinary command", async () => {
    const { code, stderr } = await runEnv(
      { home: home(), env: { HERMETIC_FLEET: "staging" } },
      "agent",
      "ps",
    );
    expect(code).toBe(0);
    expect(stderr.split("\n")[0]).toStartWith("▸ staging");
  });

  test("`--fleet` with nothing after it is a bad argument, not `no fleet`", async () => {
    const { code, stderr } = await runIn(home(), "agent", "ps", "--fleet", "");
    expect(code).toBe(2);
    expect(stderr).toContain("--fleet needs a fleet name");
  });
});

/**
 * `apply` is the second door into a whole-foundation delete: the plan is a
 * document, so the invocation that applies it is the only thing that says which
 * fleet it lands on.
 */
describe.concurrent("apply of a teardown plan is guarded like teardown itself", () => {
  async function stagingPlan(hermeticHome: string): Promise<string> {
    // Also the read that materialises this home's fleets; see `seededHome`.
    const { code, stdout } = await runIn(
      hermeticHome,
      "plan",
      "teardown",
      "--fleet",
      "staging",
      "--json",
    );
    expect(code).toBe(0);
    const file = join(hermeticHome, "teardown-staging.json");
    await Bun.write(file, stdout);
    return file;
  }

  test("no --fleet, two fleets frozen: refused before the plan is even read", async () => {
    const h = await seededHome();
    const file = await stagingPlan(h);
    const { code, stderr } = await runIn(
      h,
      "apply",
      file,
      "--yes",
      "--confirm-account-id",
      "123456789012",
    );
    expect(code).toBe(8);
    expect(stderr).toContain("teardown needs an explicit --fleet <fleet-id>");
  });

  test("a plan for another fleet is refused before the digits are asked for", async () => {
    const h = await seededHome();
    const file = await stagingPlan(h);
    const { code, stderr } = await runIn(
      h,
      "apply",
      file,
      "--fleet",
      "main",
      "--yes",
      "--confirm-account-id",
      "123456789012",
    );
    // The same code core's own `apply` throws, so the head is early, not different.
    expect(code).toBe(4);
    expect(stderr).toContain("FLEET_MISMATCH");
    expect(stderr).toContain("plan was made for fleet sg7k2m4p");
    // Refused before the ceremony, not after it.
    expect(stderr).not.toContain("does not match");
  });

  test("the right fleet reaches the typed gate, and the digits are still checked", async () => {
    const h = await seededHome();
    const file = await stagingPlan(h);
    const { code, stderr } = await runIn(
      h,
      "apply",
      file,
      "--fleet",
      "staging",
      "--yes",
      "--confirm-account-id",
      "999999999999",
    );
    expect(code).toBe(8);
    expect(stderr).toContain("does not match");
  });

  test("the confirmation names the fleet the plan is for, not just the account", async () => {
    const h = await seededHome();
    const file = await stagingPlan(h);
    // No digits and no terminal: the refusal is the sentence the prompt would
    // have asked, which is where the subject shows.
    const { code, stderr } = await runIn(h, "apply", file, "--fleet", "staging", "--yes");
    expect(code).toBe(8);
    expect(stderr).toContain('teardown of fleet "staging" (sg7k2m4p)');
  });
});

/**
 * The state every other command refuses in: two fleets frozen, no default, and
 * nothing named. `fleet ls` is the way out of it, so it is the one read that
 * has to work there.
 */
describe.concurrent("several fleets and none chosen", () => {
  /** Seed the fixture home, then take its default away. */
  async function homeWithNoDefault(): Promise<string> {
    const h = await seededHome();
    const local = openLocalDb({ home: h, fixture: true });
    try {
      setDefaultFleet(local.db, null);
      expect(listConfigs(local.db).length).toBe(2);
    } finally {
      local.close();
    }
    return h;
  }

  test("an ordinary command refuses: FLEET_REQUIRED is exit 2", async () => {
    const { code, stderr } = await runIn(await homeWithNoDefault(), "agent", "ps");
    expect(code).toBe(2);
    expect(stderr).toContain("FLEET_REQUIRED");
  });

  test("`fleet ls` still answers, with nothing marked current", async () => {
    const { code, stdout, stderr } = await runIn(await homeWithNoDefault(), "fleet", "ls", "--json");
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as FleetsJson;
    expect(result.fleets.length).toBe(2);
    // Nothing was chosen, so nothing may claim to be what the operator is on.
    expect(result.fleets.every((f) => !f.current)).toBe(true);
    expect(result.fleets.every((f) => !f.default)).toBe(true);
    // The header says the same thing the table does.
    expect(stderr).toContain("▸ (no fleet chosen) · acme-dev · 123456789012 · us-west-2");
  });

  test("`fleet use` is the way out, and works from there", async () => {
    const h = await homeWithNoDefault();
    const used = await runIn(h, "fleet", "use", "staging");
    expect(used.code).toBe(0);
    expect(used.stderr).toContain("default fleet: sg7k2m4p (was none)");
    const after = await runIn(h, "agent", "ps", "--json");
    expect(after.code).toBe(0);
    expect((JSON.parse(after.stdout) as Array<{ name: string }>).map((a) => a.name)).toEqual([
      "ember",
      "quill",
    ]);
  });
});

describe.concurrent("a fleet-less home still gets a header", () => {
  test("nothing frozen: `fleet ls` says so on both streams", async () => {
    const { code, stdout, stderr } = await runEnv({ home: home(), fixture: false }, "fleet", "ls");
    expect(code).toBe(0);
    expect(stderr).toContain("▸ (not initialized)");
    expect(stdout).toContain("this laptop has none frozen");
  });
});

describe.concurrent("the foundation nag", () => {
  test("§4.8's own commands skip it — they report every fleet's version themselves", () => {
    for (const command of ["fleet", "fleet ls", "fleet use", "directory", "directory status"]) {
      expect(skipsFoundationCheck(command)).toBe(true);
    }
    // The fleet-wide destructive command still pays for it.
    expect(skipsFoundationCheck("teardown")).toBe(false);
  });
});
