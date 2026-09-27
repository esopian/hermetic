/**
 * What the progress view says when an op stops: the warnings core deliberately
 * left for the end, the last thing the op actually said, whether the rail may
 * fade itself away, and what to try when it stopped badly.
 */
import { describe, expect, test } from "bun:test";
import type { OpEvent } from "../src/api/index.ts";
import {
  SAFE_TO_CLOSE,
  failureHints,
  opFinalMessage,
  opNextActions,
  railFades,
  railNotes,
  serverReportedEnd,
} from "../src/logic/op-hints.ts";

function event(over: Partial<OpEvent> = {}): OpEvent {
  return {
    phase: "done",
    progress: 1,
    message: "a thing that is not ready",
    at: "2026-09-06T12:00:00.000Z",
    ...over,
  };
}

/**
 * `agents.upgrade`'s real tail (core `hermetic.ts`): a per-agent `<name>:done`
 * line, then one terminal `done` line whose level is `undefined` when nothing
 * was skipped and `"warn"` when something was. The info case is the common one
 * and carries the sentence that is the whole point of pressing Upgrade.
 */
function upgradeLog(skipped: boolean): OpEvent[] {
  return [
    event({ phase: "validate", message: "1 agent(s) to pin", progress: 0.1 }),
    event({ phase: "lumen:render", message: "lumen pinned to hermes 1.3.0", progress: 0.5 }),
    event({ phase: "lumen:done", message: "lumen upgraded", progress: 0.9 }),
    skipped
      ? event({
          message: "pinned 1 agent(s) to hermes 1.3.0; skipped 1 held by another operator",
          level: "warn",
        })
      : event({
          message: "pinned 1 agent(s) to hermes 1.3.0; each takes it on its next recreate",
        }),
  ];
}

describe("opNextActions", () => {
  test("says nothing while the op is still running", () => {
    // A terminal warning mid-op has not been earned yet: the op may still do
    // the thing the warning is about.
    expect(opNextActions([event({ level: "warn" })], false)).toEqual([]);
  });

  /**
   * Filtering on `ready` alone was the bug: only `init` ends there. Every other
   * op ends on `done`, so an `upgrade --all` that skipped a locked agent — the
   * one case where it reports success and did less than it was asked — was
   * silently dropped.
   */
  test("collects warnings from either terminal phase, not just init's", () => {
    expect(opNextActions(upgradeLog(true), true)).toEqual([
      "pinned 1 agent(s) to hermes 1.3.0; skipped 1 held by another operator",
    ]);
    expect(
      opNextActions([event({ phase: "ready", level: "warn", message: "no secret" })], true),
    ).toEqual(["no secret"]);
  });

  test("ignores warnings from phases the op merely passed through", () => {
    const events = [
      event({ phase: "instance", level: "warn", message: "a warning that scrolled by" }),
      event({ message: "done" }),
    ];
    expect(opNextActions(events, true)).toEqual([]);
  });
});

describe("opFinalMessage", () => {
  /**
   * The whole of item 1: this line is an ordinary *info* event, because nothing
   * went wrong — and it is still the entire answer to "did pressing Upgrade
   * change anything yet".
   */
  test("surfaces the upgrade's info-level last word, which no warn filter catches", () => {
    expect(opFinalMessage(upgradeLog(false), true)).toBe(
      "pinned 1 agent(s) to hermes 1.3.0; each takes it on its next recreate",
    );
    expect(opNextActions(upgradeLog(false), true)).toEqual([]);
  });

  test("says nothing while the op runs, and nothing about a warn already reported", () => {
    expect(opFinalMessage(upgradeLog(false), false)).toBeNull();
    // The warn case is `opNextActions`' to render; returning it here too would
    // put the same sentence on screen twice.
    expect(opFinalMessage(upgradeLog(true), true)).toBeNull();
  });

  test("a terminal line that only says `done` adds nothing the phase label did not", () => {
    for (const message of ["done", "Done.", "ok", "", "   "]) {
      expect(opFinalMessage([event({ message })], true)).toBeNull();
    }
  });

  test("an op with no terminal event at all has no last word", () => {
    expect(opFinalMessage([event({ phase: "instance", message: "launching" })], true)).toBeNull();
  });
});

describe("railNotes", () => {
  test("warnings first, then the last word, then the caller's own hints", () => {
    const events = [
      event({ phase: "ready", level: "warn", message: "no OAuth secret yet" }),
      event({ message: "fleet is ready" }),
    ];
    expect(railNotes(events, true, ["`hermetic doctor`"])).toEqual([
      "no OAuth secret yet",
      "fleet is ready",
      "`hermetic doctor`",
    ]);
  });

  test("deduplicates, because a repeated line is a duplicate React key", () => {
    const events = [event({ phase: "ready", level: "warn", message: "same line" })];
    expect(railNotes(events, true, ["same line"])).toEqual(["same line"]);
  });

  test("a running op has nothing to say yet", () => {
    expect(railNotes(upgradeLog(false), false)).toEqual([]);
  });
});

describe("railFades", () => {
  const base = { live: true, finished: true, ok: true, notes: [] as string[] };

  test("a clean, silent success fades", () => {
    expect(railFades(base)).toBe(true);
  });

  /**
   * The rail used to fade 1.3s after *any* success, taking the callout and the
   * log with it — so `upgrade`'s one useful sentence appeared for about a
   * second and then deleted itself.
   */
  test("a rail that is still saying something stays put", () => {
    expect(railFades({ ...base, notes: ["takes effect on the next recreate"] })).toBe(false);
  });

  test("a failure stays put, so the reason and the hints survive", () => {
    expect(railFades({ ...base, ok: false })).toBe(false);
  });

  test("an op still running never fades, and one nobody watched never faded in", () => {
    expect(railFades({ ...base, finished: false })).toBe(false);
    expect(railFades({ ...base, live: false })).toBe(false);
  });
});

describe("serverReportedEnd", () => {
  /**
   * `followOp` reports a dead socket through the same callback as a real
   * verdict: `(false, null)`. The init wizard drops its reattach breadcrumb on
   * "the op ended", so a portal restart must not be able to erase the
   * breadcrumb for an op that is still building a foundation.
   */
  test("a dead transport is not a verdict", () => {
    expect(serverReportedEnd({ finished: true, ok: false, error: null })).toBe(false);
  });

  test("a real done frame is, whichever way it went", () => {
    expect(serverReportedEnd({ finished: true, ok: true, error: null })).toBe(true);
    expect(
      serverReportedEnd({ finished: true, ok: false, error: { code: "INTERNAL", message: "boom" } }),
    ).toBe(true);
  });

  test("an op that has not stopped has not been reported either", () => {
    expect(serverReportedEnd({ finished: false, ok: true, error: null })).toBe(false);
  });
});

describe("failureHints", () => {
  /**
   * Core refuses `rerun` from any status but `error` ("rerun re-runs the
   * bootstrap stages of an agent that failed one"), so suggesting it otherwise
   * is advice that comes back INVALID_TRANSITION.
   */
  test("offers the resume only for a row core would actually accept it for", () => {
    expect(failureHints("INTERNAL", "create", "lumen", "error").join(" ")).toContain(
      "hermetic agent rerun lumen",
    );
    expect(failureHints("INTERNAL", "recreate", "lumen", "error").join(" ")).toContain(
      "hermetic agent rerun lumen",
    );
    for (const status of ["creating", "stopped", "ready", null, undefined]) {
      expect(failureHints("INTERNAL", "create", "lumen", status).join(" ")).not.toContain("rerun");
    }
  });

  test("a failed start suggests start again, not a bootstrap resume", () => {
    const hints = failureHints("INTERNAL", "start", "lumen", "stopped").join(" ");
    expect(hints).toContain("hermetic agent start lumen");
    expect(hints).not.toContain("rerun");
  });

  test("a failed upgrade suggests the upgrade command, with the flag it needs", () => {
    expect(failureHints("INTERNAL", "upgrade → 1.3.0", "lumen", "ready").join(" ")).toContain(
      "hermetic upgrade lumen --hermes <version>",
    );
  });

  /**
   * A half-made agent has already claimed its name, so `agent create` would
   * answer NAME_TAKEN and put the operator one step further from the fix.
   */
  test("a failed create never suggests creating it again", () => {
    const hints = failureHints("INTERNAL", "create", "lumen", "creating").join(" ");
    expect(hints).not.toContain("agent create");
    expect(hints).toContain("hermetic agent status lumen");
  });

  test("stop and destroy suggest themselves", () => {
    expect(failureHints("INTERNAL", "stop", "lumen", "ready").join(" ")).toContain(
      "hermetic agent stop lumen",
    );
    expect(failureHints("INTERNAL", "destroy", "lumen", "ready").join(" ")).toContain(
      "hermetic agent destroy lumen",
    );
  });

  test("an op known only as `operation` still gets the two that are always true", () => {
    // The label the drawer uses before the registry has named the op.
    const hints = failureHints("INTERNAL", "operation", "lumen", "ready");
    expect(hints.some((h) => h.includes("doctor"))).toBe(true);
    expect(hints.some((h) => h.includes("app.log"))).toBe(true);
  });

  test("a lock is a wait, not a retry, and says where to look", () => {
    expect(failureHints("LOCKED", "destroy", "lumen", "ready")[0]).toContain("hermetic runs");
  });

  test("a frozen-home mismatch is the only thing worth saying", () => {
    // Every other suggestion would be "try the refused thing again".
    expect(failureHints("ACCOUNT_MISMATCH", "create", "lumen", "error")).toEqual([
      "this home is frozen to a different account or fleet — `hermetic doctor`",
    ]);
  });

  test("an unnamed agent still produces a runnable-looking command", () => {
    expect(failureHints("INTERNAL", "start", "", "stopped").join(" ")).toContain("<name>");
  });

  test("every failure names the log that has the failing AWS call in it", () => {
    for (const code of ["INTERNAL", "LOCKED", "ABORTED", null]) {
      const line = failureHints(code, "create", "lumen", "error").join(" ");
      // Both names, because the file a fixture run writes is not the one a real
      // run writes and the operator is only ever looking at one of them
      // (`app/src/log.ts`).
      expect(line).toContain("~/.hermetic/app.log");
      expect(line).toContain("app-fixture.log");
    }
  });

  /**
   * Every command suggested here has to exist. Checked against `hermetic agent
   * --help` and `hermetic upgrade --help` at the time of writing; this pins the
   * shapes so a renamed subcommand shows up as a failing test rather than as
   * advice that does not run.
   */
  test("only names subcommands the CLI actually has", () => {
    const known = [
      /hermetic agent (rerun|status|start|stop|destroy|recreate) /,
      /hermetic upgrade \S+ --hermes/,
      /hermetic runs/,
      /hermetic doctor/,
    ];
    const labels = ["create", "recreate", "start", "stop", "destroy", "upgrade → 1.3.0", "operation"];
    for (const label of labels) {
      for (const status of ["error", "ready", "creating", null]) {
        for (const hint of failureHints("INTERNAL", label, "lumen", status)) {
          const commands = hint.match(/`([^`]+)`/g) ?? [];
          for (const command of commands) {
            const bare = command.slice(1, -1);
            expect(known.some((re) => re.test(`${bare} `))).toBe(true);
          }
        }
      }
    }
  });
});

describe("SAFE_TO_CLOSE", () => {
  test("is a clause both callers finish themselves, so it ends without a stop", () => {
    expect(SAFE_TO_CLOSE.endsWith(".")).toBe(false);
    expect(SAFE_TO_CLOSE).toContain("engine");
  });
});
