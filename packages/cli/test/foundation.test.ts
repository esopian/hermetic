/**
 * §6.6 through the CLI head, run as a real process like the rest of
 * `packages/cli/test`. Two things are being pinned here: the shape of
 * `foundation status --json` (a scripted contract), and the one stderr line
 * every *other* command prints when the fleet is behind — including the cases
 * where it must stay silent, which is the half a warning usually gets wrong.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import {
  FOUNDATION_CHECK_TIMEOUT_MS,
  skipsFoundationCheck,
  warnFoundationOutdated,
} from "../src/context.ts";
import {
  bedrockGrantLine,
  renderFoundationStatus,
  renderHermesLine,
} from "../src/commands/foundation.ts";
import { BUILD_VERSIONS, FOUNDATION_VERSION } from "@hermetic/core";
import type { FoundationStatus } from "@hermetic/core";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliBinary, seedFixtureHome } from "./cli-binary.ts";

const HOME = mkdtempSync(join(tmpdir(), "hermetic-foundation-test-"));
beforeAll(() => seedFixtureHome(HOME));

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * `HERMETIC_FIXTURE_OUTDATED=1` seeds a `_fleet` with no `foundation_version`
 * at all and an older release — what every fleet created before the stamp
 * existed looks like (core `backend/memory.ts`).
 */
async function run(opts: { outdated?: boolean }, ...args: string[]): Promise<Run> {
  const proc = Bun.spawn([await cliBinary(), ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HERMETIC_FIXTURE: "1",
      HERMETIC_NO_TTY: "1",
      HERMETIC_HOME: HOME,
      ...(opts.outdated ? { HERMETIC_FIXTURE_OUTDATED: "1" } : {}),
    },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/**
 * §6.6: the nag is now the skew warning. The headline still carries both
 * version numbers — they are the facts an operator acts on — but the sentence
 * beside them is core's generic one, and it is generic on purpose: a list of
 * what an old contract breaks would need rewriting at every bump and would read
 * as a promise about everything absent from it.
 */
const WARNING = `fleet foundation v0 · this build expects v${FOUNDATION_VERSION}`;
const SENTENCE = "some things will not behave as expected until the fleet is updated";

interface StatusJson {
  fleet: {
    foundation_version: number;
    template_sha256: string | null;
    hermeticd_version: string;
    ubuntu_release: string;
    ami_id: string;
  };
  available: { foundation_version: number; template_sha256: string; hermeticd_version: string };
  update_available: boolean;
  tool_outdated: boolean;
  in_progress: unknown;
  agents: Array<{ name: string; status: string; hermeticd_version: string | null; current: boolean }>;
}

describe.concurrent("the pre-command foundation warning", () => {
  test("an outdated fleet warns on stderr, once, and does not fail the command", async () => {
    const { code, stdout, stderr } = await run({ outdated: true }, "agent", "ps");
    expect(code).toBe(0);
    expect(stderr).toContain(WARNING);
    expect(stderr).toContain(SENTENCE);
    // Exactly one line for a read — `agent ps` is accurate on a skewed fleet;
    // it is the numbers in its output that need the context, not the command.
    // And never on stdout: `--json` has to stay a document.
    expect(stderr.split("\n").filter((l) => l.includes(WARNING)).length).toBe(1);
    expect(stdout).not.toContain(WARNING);
  });

  test("a current fleet says nothing", async () => {
    const { code, stderr } = await run({}, "agent", "ps");
    expect(code).toBe(0);
    expect(stderr).not.toContain("this build expects");
  });

  test("`foundation status` does not warn about what it is already printing", async () => {
    const { code, stderr } = await run({ outdated: true }, "foundation", "status");
    expect(code).toBe(0);
    expect(stderr).not.toContain("this build expects");
  });

  test("a write command gets the block, with the fix and the way to quiet it", async () => {
    // `agent create` inherits from a fleet whose shared settings an old
    // contract does not have, so it is worth interrupting for; a read is not.
    const { stderr } = await run({ outdated: true }, "agent", "create", "atlas", "--size", "small");
    expect(stderr).toContain("VERSION SKEW");
    expect(stderr).toContain(SENTENCE);
    expect(stderr).toContain("hermetic foundation update");
    expect(stderr).toContain("HERMETIC_NO_SKEW_WARNING=1");
  });

  test("`plan foundation` still warns — it is a plan command, not a foundation one", async () => {
    const { stderr } = await run({ outdated: true }, "plan", "foundation");
    expect(stderr).toContain(WARNING);
  });
});

/**
 * The nag costs an STS call, a `_fleet` GetItem and a full agents scan, so the
 * predicate deciding whether to pay for it is worth pinning without spawning a
 * process per entry. Two rules, for two different reasons: commands that report
 * the same thing better themselves, and commands that touch AWS not at all.
 */
describe.concurrent("which commands pay for the foundation check", () => {
  test("the commands that say it better themselves are skipped", () => {
    for (const command of ["init", "foundation", "foundation status", "foundation update"]) {
      expect(skipsFoundationCheck(command)).toBe(true);
    }
  });

  test("local-only commands are skipped — they touch AWS not at all", () => {
    for (const command of ["runs", "teardowns", "config", "config show"]) {
      expect(skipsFoundationCheck(command)).toBe(true);
    }
  });

  test("everything that already talks to AWS still pays", () => {
    for (const command of [
      "agent ps",
      "agent create",
      "agent destroy",
      "doctor",
      "teardown",
      "upgrade",
      "plan foundation",
      "plan teardown",
      "secrets push",
      "artifacts push",
      "apply",
    ]) {
      expect(skipsFoundationCheck(command)).toBe(false);
    }
  });

  test("a prefix match is on the whole word, not the letters", () => {
    // `configure`/`foundations` are not commands, but a `startsWith` without the
    // space would skip them if they ever were.
    expect(skipsFoundationCheck("configure")).toBe(false);
    expect(skipsFoundationCheck("foundations")).toBe(false);
    expect(skipsFoundationCheck("runsomething")).toBe(false);
  });
});

describe.concurrent("the check is bounded", () => {
  /**
   * The failure this guards: a wedged VPN, an AWS SDK still retrying, and
   * `hermetic agent ps` blocked behind a courtesy it never asked for.
   * `warnFoundationOutdated` is called for its side effect only, so "returned"
   * is the whole assertion — and it must return well before the never-resolving
   * read it is waiting on ever would.
   */
  const hanging = {
    foundation: { status: () => new Promise<never>(() => {}) },
  } as unknown as Parameters<typeof warnFoundationOutdated>[0];

  test("a status read that never resolves gives up at the deadline", async () => {
    const began = Date.now();
    await warnFoundationOutdated(hanging, { timeoutMs: 40 });
    const took = Date.now() - began;
    expect(took).toBeLessThan(1000);
    expect(took).toBeGreaterThanOrEqual(30);
  });

  test("an already-aborted signal gives up at once, without waiting out the budget", async () => {
    const began = Date.now();
    await warnFoundationOutdated(hanging, {
      timeoutMs: 5000,
      signal: AbortSignal.abort(),
    });
    expect(Date.now() - began).toBeLessThan(1000);
  });

  test("a status read that rejects is swallowed, not rethrown", async () => {
    const broken = {
      foundation: { status: () => Promise.reject(new Error("no _fleet item")) },
    } as unknown as Parameters<typeof warnFoundationOutdated>[0];
    expect(await warnFoundationOutdated(broken, { timeoutMs: 40 })).toBeUndefined();
  });

  test("the default budget is a second and a half", () => {
    expect(FOUNDATION_CHECK_TIMEOUT_MS).toBe(1500);
  });
});

describe.concurrent("foundation status", () => {
  test("--json carries fleet, available, the two flags and every agent", async () => {
    const { code, stdout } = await run({ outdated: true }, "foundation", "status", "--json");
    expect(code).toBe(0);
    const status = JSON.parse(stdout) as StatusJson;
    expect(status.fleet.foundation_version).toBe(0);
    expect(status.available.foundation_version).toBe(FOUNDATION_VERSION);
    expect(status.fleet.hermeticd_version).toBe("0.4.0");
    // Named, not spelled out: this is "the release this build ships", which is
    // exactly what `available` means, and a literal here would have to be
    // edited on every patch bump.
    expect(status.available.hermeticd_version).toBe(BUILD_VERSIONS.hermeticd);
    // The image is a fleet fact with no "available" side to compare it with.
    expect(status.fleet.ubuntu_release).toBe("24.04");
    expect(status.fleet.ami_id).toBe("ami-0abc1234def567890");
    expect(status.update_available).toBe(true);
    expect(status.tool_outdated).toBe(false);
    expect(status.in_progress).toBeNull();
    expect(status.agents.length).toBeGreaterThan(0);
    // The per-agent half: a box on an older release is `current: false`.
    const ember = status.agents.find((a) => a.name === "ember");
    expect(ember?.hermeticd_version).toBe("0.4.0");
    expect(ember?.current).toBe(false);
    const atlas = status.agents.find((a) => a.name === "atlas");
    expect(atlas?.current).toBe(true);
  });

  test("the table names both sides and the verdict", async () => {
    const { code, stdout } = await run({ outdated: true }, "foundation", "status");
    expect(code).toBe(0);
    expect(stdout).toContain("FLEET");
    expect(stdout).toContain("AVAILABLE");
    expect(stdout).toContain("ubuntu release    24.04");
    expect(stdout).toContain("ami id            ami-0abc1234def567890");
    expect(stdout).toContain("update available  yes");
    expect(stdout).toContain("tool outdated     no");
    expect(stdout).toContain("HERMETICD");
    expect(stdout).toContain("HERMES");
    expect(stdout).toContain("behind");
  });

  /**
   * §8.3: `foundation status` reports a stale Bedrock grant. It is deliberately
   * not folded into `update_available` — a grant is a fact about the fleet's
   * IAM policy, not about its version — so the table has to say it out loud or
   * the only reading of it is the JSON.
   */
  test("the Bedrock grant is a row, in both of its states", async () => {
    const { code, stdout } = await run({}, "foundation", "status");
    expect(code).toBe(0);
    expect(stdout).toContain("bedrock grant     current");
  });

  test("a stale grant names the models and the command that grants them", () => {
    const status = JSON.parse(
      JSON.stringify({
        fleet: {
          foundation_version: FOUNDATION_VERSION,
          template_sha256: null,
          hermeticd_version: BUILD_VERSIONS.hermeticd,
          ubuntu_release: "24.04",
          ami_id: "ami-0abc1234def567890",
        },
        available: {
          foundation_version: FOUNDATION_VERSION,
          template_sha256: null,
          hermeticd_version: BUILD_VERSIONS.hermeticd,
        },
        update_available: false,
        tool_outdated: false,
        in_progress: null,
        stale_bedrock_grants: ["zai.glm-4.7-flash"],
        agents: [],
      }),
    ) as FoundationStatus;

    const rendered = renderFoundationStatus(status);
    expect(rendered).toContain("bedrock grant     stale: zai.glm-4.7-flash");
    expect(rendered).toContain("hermetic foundation update");
  });

  /**
   * The field has three states and the row has to have three answers.
   *
   * Core *omits* `stale_bedrock_grants` on a fleet that predates v10: it does
   * not record its grant, so there is nothing to compare and "nothing is stale"
   * is not a thing anybody checked. Printing `current` for that told an operator
   * their IAM policy had been verified when it had not — and the command that
   * makes the check possible is the same one the stale case names.
   */
  test("an unrecorded grant says so rather than reporting current", () => {
    expect(bedrockGrantLine(undefined)).toBe("not recorded — run `hermetic foundation update`");
    expect(bedrockGrantLine([])).toBe("current");
    expect(bedrockGrantLine(["zai.glm-4.7-flash"])).toBe(
      "stale: zai.glm-4.7-flash — run `hermetic foundation update`",
    );
  });

  test("the whole table carries the unrecorded answer, not just the helper", () => {
    const status = JSON.parse(
      JSON.stringify({
        fleet: {
          foundation_version: FOUNDATION_VERSION,
          template_sha256: null,
          hermeticd_version: BUILD_VERSIONS.hermeticd,
          ubuntu_release: "24.04",
          ami_id: "ami-0abc1234def567890",
        },
        available: {
          foundation_version: FOUNDATION_VERSION,
          template_sha256: null,
          hermeticd_version: BUILD_VERSIONS.hermeticd,
        },
        update_available: false,
        tool_outdated: false,
        in_progress: null,
        agents: [],
      }),
    ) as FoundationStatus;
    expect(status.stale_bedrock_grants).toBeUndefined();

    const rendered = renderFoundationStatus(status);
    expect(rendered).toContain("bedrock grant     not recorded");
    expect(rendered).not.toContain("bedrock grant     current");
  });

  test("the fixture's canned upstream reaches the rendered line", async () => {
    // Fixture mode cans a GitHub answer one release ahead of what this build
    // pins (`open.ts`), so the advisory state is developable offline.
    const { code, stdout } = await run({}, "foundation", "status");
    expect(code).toBe(0);
    expect(stdout).toContain("hermes ");
    expect(stdout).toContain("update available — set BUILD_VERSIONS");
  });
});

/**
 * §6.6's advisory Hermes line. Pure, so every state is asserted without
 * spawning a process; the end-to-end shape is covered by the fixture run below.
 */
describe("renderHermesLine", () => {
  type Hermes = NonNullable<FoundationStatus["hermes"]>;
  const base: Hermes = {
    pinned: "0.21.0",
    pinned_ref: "v2026.8.31",
    latest: "2026.8.31",
    update_available: false,
    checked_at: "2026-09-06T10:00:00.000Z",
    error: null,
  };
  const line = (over: Partial<Hermes> = {}) => renderHermesLine({ ...base, ...over });

  test("names both numbers when there is nothing to do", () => {
    expect(line()).toContain("pinned 0.21.0 (v2026.8.31)");
    expect(line()).toContain("latest 2026.8.31");
    expect(line()).toContain("up to date");
  });

  test("an update names both halves of the bump, and says to try one agent first", () => {
    const out = line({ latest: "2026.9.4", update_available: true });
    expect(out).toContain("update available");
    // `foundation update` applies no Hermes, and `--hermes` alone would check
    // out the old ref and fail its own version assertion (§6.6).
    expect(out).toContain("BUILD_VERSIONS.hermes/hermes_ref");
    expect(out).toContain("hermetic upgrade <name> --hermes <version>");
    expect(out).toContain("one agent first");
  });

  test("a check that did not answer says so rather than claiming up to date", () => {
    const out = line({ latest: null, error: "timeout" });
    expect(out).toContain("could not check (timeout)");
    expect(out).not.toContain("up to date");
  });

  test("a tag that could not be ordered is shown, and not called an update", () => {
    const out = line({ latest: "nightly", error: "unrecognised tag" });
    expect(out).toContain("nightly");
    expect(out).toContain("could not compare (unrecognised tag)");
  });

  test("a server that did not check at all is not silently 'up to date' either", () => {
    expect(renderHermesLine(undefined)).toContain("not checked");
  });
});

describe.concurrent("plan foundation", () => {
  test("lists the op's phases as steps, without executing any of them", async () => {
    const { code, stdout } = await run({ outdated: true }, "plan", "foundation", "--json");
    expect(code).toBe(0);
    const plan = JSON.parse(stdout) as { kind: string; steps: Array<{ id: string }> };
    expect(plan.kind).toBe("foundation");
    expect(plan.steps.map((s) => s.id)).toEqual([
      "preflight",
      "archive",
      // v3 copies this fleet's SSM parameters under their new prefix before the
      // template narrows the agent role to that prefix (§6.6).
      "pre-stack",
      "stack",
      // §8.3: the Bedrock grant the update states on the change set.
      "bedrock-grant",
      "artifacts",
      "migrate",
      "rollout",
    ]);
  });

  test("the human rendering is the same plan `foundation update` confirms with", async () => {
    const { code, stdout } = await run({ outdated: true }, "plan", "foundation");
    expect(code).toBe(0);
    expect(stdout).toContain("plan: foundation");
    expect(stdout).toContain("preflight");
    expect(stdout).toContain("rollout");
  });
});

describe.concurrent("foundation update", () => {
  test("--yes runs every phase through to done and exits 0", async () => {
    const { code, stdout, stderr } = await run(
      { outdated: true },
      "foundation",
      "update",
      "--yes",
      "--json",
    );
    expect(code).toBe(0);
    // The plan is still printed to stderr before the op — `--yes` skips the
    // question, not the review.
    expect(stderr).toContain("plan: foundation");
    const phases = stdout
      .trim()
      .split("\n")
      .map((l) => (JSON.parse(l) as { phase: string }).phase);
    for (const phase of ["preflight", "archive", "stack", "artifacts", "migrate", "rollout", "done"]) {
      expect(phases).toContain(phase);
    }
    expect(phases[phases.length - 1]).toBe("done");
  }, 30_000);

  test("without --yes and with no terminal to ask in, it is CONFIRMATION_REQUIRED", async () => {
    const { code, stderr } = await run({ outdated: true }, "foundation", "update");
    expect(code).toBe(8);
    expect(stderr).toContain("update the foundation?");
  });
});
