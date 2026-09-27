/**
 * The quit guard.
 *
 * Nothing native here: the events are fired by hand, the dialog is a deferred
 * promise the test resolves when it wants to, and the op registry is an array.
 * That is enough to pin the two things worth pinning — what the dialog says,
 * and that a second Cmd-Q while the first one is on screen does not open a
 * second dialog.
 */
import { describe, expect, test } from "bun:test";
import { memoryLog } from "../../src/log.ts";
import {
  type CloseAttempt,
  MAX_LISTED_OPS,
  closeDecision,
  installCloseGuard,
} from "../../src/main/close-guard.ts";
import type { OpSummary } from "../../src/ops.ts";

function op(method: string, target: string | null): OpSummary {
  return {
    id: `${method}:${target ?? "-"}`,
    method,
    target,
    status: "running",
    started_at: "2026-09-21T00:00:00.000Z",
    finished_at: null,
    event_count: 0,
    dropped: 0,
    error: null,
  };
}

describe("closeDecision", () => {
  test("nothing running asks nothing", () => {
    expect(closeDecision([])).toEqual({ needsPrompt: false, message: "" });
  });

  test("one op is named, in the singular", () => {
    const decision = closeDecision([op("agents.create", "lisbon")]);
    expect(decision.needsPrompt).toBe(true);
    expect(decision.message).toContain("1 operation is still running");
    expect(decision.message).toContain("agents.create lisbon");
  });

  test("an op with no target is named by method alone", () => {
    const decision = closeDecision([op("foundation.update", null)]);
    expect(decision.message).toContain("foundation.update");
    // No dangling separator where the target would have been.
    expect(decision.message).not.toContain("foundation.update ");
  });

  test("several ops are all named, in the plural", () => {
    const decision = closeDecision([
      op("agents.create", "lisbon"),
      op("agents.destroy", "oslo"),
      op("plan.apply", "lima"),
    ]);
    expect(decision.message).toContain("3 operations are still running");
    for (const line of ["agents.create lisbon", "agents.destroy oslo", "plan.apply lima"]) {
      expect(decision.message).toContain(line);
    }
    expect(decision.message).not.toContain("more");
  });

  test("a long list is capped and the remainder counted", () => {
    const running = Array.from({ length: 20 }, (_, i) => op("agents.create", `box-${i}`));
    const decision = closeDecision(running);
    expect(decision.message).toContain("20 operations are still running");
    expect(decision.message).toContain("box-0");
    expect(decision.message).toContain(`+${20 - MAX_LISTED_OPS} more`);
    // Only the first five survive; the sixth is inside the "+15 more".
    expect(decision.message).not.toContain("box-5");
    expect(decision.message.split("\n").filter((l) => l.startsWith("  ")).length).toBe(
      MAX_LISTED_OPS + 1,
    );
  });
});

/**
 * Two turns of the microtask queue: enough for the guard's deferred half to
 * reach `confirm` and for the answer to come back.
 *
 * Deliberately not a `setTimeout`: the guard's own deferral is injected below,
 * so this suite waits on nothing the other suites in the same `bun test`
 * process can have replaced (happy-dom's globals swap the timer out).
 */
const tick = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

/**
 * A guard wired to arrays and hand-fired events.
 *
 * `fire` returns what the native side would have read: whether the listener
 * denied the close *before it returned*. Asserting on the return value rather
 * than on a later flag is the point — a deny that arrives a tick late is a
 * window that is already gone.
 */
function harness(running: OpSummary[], answer: boolean | Promise<boolean>) {
  const calls: string[] = [];
  const listeners = new Map<string, (attempt: CloseAttempt) => void>();
  const log = memoryLog();
  installCloseGuard({
    ops: { list: () => ({ ops: running }) },
    confirm: async (message: string) => {
      calls.push(`confirm:${message}`);
      return await answer;
    },
    shutdown: async () => void calls.push("shutdown"),
    on: (event, listener) => void listeners.set(event, listener),
    // Run it where the guard would have scheduled it. The one thing the
    // deferral has to guarantee — that it happens after `deny()` — is asserted
    // by `fire`'s return value, not by a clock.
    defer: (run) => run(),
    log,
  });
  return {
    calls,
    log,
    fire: (event: string): boolean => {
      let denied = false;
      listeners.get(event)?.({
        deny: () => {
          denied = true;
        },
      });
      return denied;
    },
    events: () => [...listeners.keys()],
  };
}

describe("installCloseGuard", () => {
  test("subscribes both ways of leaving", () => {
    const h = harness([], true);
    expect(h.events().sort()).toEqual(["before-quit", "will-close"]);
  });

  test("nothing running shuts down without asking", async () => {
    const h = harness([], true);
    // Denied even with nothing to ask about: leaving is this process's own
    // teardown, not the native side's exit-on-last-window-closed racing it.
    expect(h.fire("will-close")).toBe(true);
    await tick();
    expect(h.calls).toEqual(["shutdown"]);
  });

  test("the default deferral is a real one", async () => {
    // Everything else here injects `defer`. This is the one case that pins the
    // production default: the work must not run on the event's own stack,
    // because that stack is the FFI callback whose window the teardown closes.
    const calls: string[] = [];
    let listener: ((attempt: CloseAttempt) => void) | undefined;
    installCloseGuard({
      ops: { list: () => ({ ops: [] }) },
      confirm: async () => true,
      shutdown: async () => void calls.push("shutdown"),
      on: (event, given) => {
        if (event === "will-close") listener = given;
      },
    });
    let denied = false;
    listener?.({
      deny: () => {
        denied = true;
      },
    });
    expect(denied).toBe(true);
    expect(calls).toEqual([]);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(["shutdown"]);
  });

  test("running ops deny the close in the same tick", () => {
    const h = harness([op("agents.create", "lisbon")], new Promise<boolean>(() => {}));
    // Nothing awaited: the native side reads the response the moment the
    // listener returns, and the dialog has not even been drawn yet.
    expect(h.fire("will-close")).toBe(true);
    expect(h.log.lines.join("")).toContain("close denied");
  });

  test("a quit reaches the same guard", () => {
    const h = harness([op("agents.create", "lisbon")], new Promise<boolean>(() => {}));
    expect(h.fire("before-quit")).toBe(true);
  });

  test("running ops prompt with the decision's message", async () => {
    const running = [op("agents.create", "lisbon")];
    const h = harness(running, true);
    h.fire("before-quit");
    await tick();
    expect(h.calls[0]).toBe(`confirm:${closeDecision(running).message}`);
    expect(h.calls).toContain("shutdown");
  });

  test("the quit the guard asked for is not vetoed by the guard", async () => {
    // The devkit's `process.exit` is `Utils.quit()`, which asks the
    // `before-quit` listeners first. Denying that one is how an app tears
    // everything down and then refuses to die.
    const h = harness([], true);
    expect(h.fire("will-close")).toBe(true);
    await tick();
    expect(h.calls).toEqual(["shutdown"]);
    expect(h.fire("before-quit")).toBe(false);
    expect(h.fire("will-close")).toBe(false);
  });

  test("declining leaves the app up", async () => {
    const h = harness([op("agents.create", "lisbon")], false);
    expect(h.fire("will-close")).toBe(true);
    await tick();
    expect(h.calls.filter((c) => c === "shutdown")).toEqual([]);
    expect(h.log.lines.join("")).toContain("quit cancelled");
    // And the next attempt is denied again rather than sailing through on a
    // flag nobody reset.
    expect(h.fire("will-close")).toBe(true);
  });

  test("a second event during the prompt does not open a second dialog", async () => {
    let resolve: ((v: boolean) => void) | undefined;
    const pending = new Promise<boolean>((r) => {
      resolve = r;
    });
    const h = harness([op("agents.create", "lisbon")], pending);

    expect(h.fire("will-close")).toBe(true);
    await tick();
    // Cmd-Q again while the modal is up, plus the other event for the same
    // gesture: neither may reach `confirm`, and both are still denied.
    expect(h.fire("before-quit")).toBe(true);
    expect(h.fire("will-close")).toBe(true);
    await tick();
    expect(h.calls.filter((c) => c.startsWith("confirm:")).length).toBe(1);

    resolve?.(true);
    await pending;
    await tick();
    expect(h.calls.filter((c) => c === "shutdown").length).toBe(1);
  });

  test("declining then trying again asks again", async () => {
    const h = harness([op("agents.create", "lisbon")], false);
    h.fire("will-close");
    await tick();
    h.fire("will-close");
    await tick();
    expect(h.calls.filter((c) => c.startsWith("confirm:")).length).toBe(2);
  });
});
