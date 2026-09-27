/**
 * What closing the window, or quitting the app, means while work is in flight.
 *
 * The portal's ops are not background jobs on somebody else's machine: an
 * `agents.create` is this process talking to CloudFormation, and a quit halfway
 * through leaves a half-built stack nobody is watching. The browser head never
 * had this problem — closing a tab left the server running — so the guard is
 * new work that the native head owes the operator.
 *
 * The decision is a pure function of the running ops, separate from the wiring,
 * because the interesting part (what the dialog says when twenty things are
 * running) is worth testing without a window, a dialog or an event loop.
 */
import type { AppLog } from "../log.ts";
import type { OpSummary } from "../ops.ts";

/**
 * How many ops the message names before it summarises the rest. A dialog is
 * read at a glance; a list of twenty is a wall the operator dismisses without
 * reading, which is worse than no list at all.
 */
export const MAX_LISTED_OPS = 5;

export interface CloseDecision {
  /** False means close without asking: there is nothing to lose. */
  needsPrompt: boolean;
  /** Body of the confirmation. Empty when `needsPrompt` is false. */
  message: string;
}

/** One op as a line the operator recognises: the method and what it is acting on. */
function describe(op: OpSummary): string {
  return op.target === null ? op.method : `${op.method} ${op.target}`;
}

/**
 * Whether to ask, and what to ask. Pure — no clock, no registry, no dialog — so
 * the phrasing at 0, 1, 5 and 20 running ops is a test rather than a screenshot.
 */
export function closeDecision(running: OpSummary[]): CloseDecision {
  if (running.length === 0) return { needsPrompt: false, message: "" };

  const listed = running.slice(0, MAX_LISTED_OPS).map((op) => `  ${describe(op)}`);
  const hidden = running.length - listed.length;
  if (hidden > 0) listed.push(`  +${hidden} more`);

  const count =
    running.length === 1
      ? "1 operation is still running"
      : `${running.length} operations are still running`;
  return {
    needsPrompt: true,
    // "Quitting will not stop them on AWS" is the part worth saying: the
    // operator's real question is whether closing the window cancels the work
    // or merely stops watching it. It stops watching it.
    message: `${count}:\n\n${listed.join("\n")}\n\nQuitting stops watching them; it does not undo work already started on AWS. Quit anyway?`,
  };
}

/** As much of the op registry as the guard reads. */
export interface RunningOps {
  list(options: { status: "running" }): { ops: OpSummary[] };
}

/**
 * The one thing a listener may do to the native event, and the reason this
 * module still imports no devkit.
 *
 * Both `will-close` and `before-quit` are cancellable, and both are cancelled
 * the same way: by setting `event.response = { allow: false }` *during* the
 * listener call. A promise resolved a tick later is too late — the native side
 * has already read the response and closed the window. So the wiring in
 * `main/index.ts` hands the guard a `deny()` that does that assignment, and the
 * test hands it a function that sets a boolean.
 */
export interface CloseAttempt {
  /** Cancels this close/quit. Must be called synchronously, from the listener. */
  deny(): void;
}

export interface CloseGuardOptions {
  ops: RunningOps;
  /** Native modal; resolves true when the operator chose to quit. */
  confirm(message: string): Promise<boolean>;
  /** The same teardown `installShutdown` runs for a signal: poller, chat, exit. */
  shutdown(): Promise<void>;
  /** Subscribes the injected window/app hooks. Injected so no devkit is needed here. */
  on(event: string, listener: (attempt: CloseAttempt) => void): void;
  /**
   * How the work after the decision leaves the event's own stack. The default
   * is a `setTimeout`; a test passes a function that runs it, so nothing here
   * depends on a timer another suite in the same process may have replaced.
   */
  defer?: (run: () => void) => void;
  log?: AppLog;
}

/** The events that mean "the operator is trying to leave". */
export const CLOSE_EVENTS = ["will-close", "before-quit"] as const;

export function installCloseGuard(options: CloseGuardOptions): void {
  const defer = options.defer ?? ((run: () => void): void => void setTimeout(run, 0));

  /**
   * One attempt at a time.
   *
   * `will-close` and `before-quit` both fire for a Cmd-Q on the last window,
   * and the operator can hammer Cmd-Q while the modal is already up. Without
   * this, that is two dialogs stacked over each other and — worse — two
   * `shutdown()` calls racing to stop the same poller and exit the same
   * process. `windows.ts` has the same problem and uses set membership as the
   * guard, because it has a set; here there is nothing to be a member of, so
   * the flag is explicit. Only two things clear it: a declined prompt, and a
   * throw — once an accepted shutdown has started, leaving is the only
   * outcome.
   */
  let leaving = false;

  /**
   * Set once the guard itself has decided to leave, and never cleared.
   *
   * After that point every close and every quit must be *allowed*, because one
   * of them is ours: the devkit replaces `process.exit` with its own
   * `Utils.quit()`, which asks the `before-quit` listeners for permission
   * first (`core/Utils.ts`'s `requestQuitApproval`). A guard that denied that
   * one would veto the exit it had just asked the operator for — observed as an
   * app that logged a complete teardown and then sat there, unquittable.
   */
  let committed = false;

  /** Everything after the decision, which may take as long as a human does. */
  const settle = async (running: OpSummary[], message: string): Promise<void> => {
    if (message !== "") {
      const quit = await options.confirm(message);
      if (!quit) {
        // Declined: the window stays, and the next Cmd-Q must be able to ask
        // again — this is the one path that puts the flag back.
        leaving = false;
        options.log?.line("info", "close", "quit cancelled", { running: running.length });
        return;
      }
      options.log?.line("warn", "close", "quitting with running ops", { running: running.length });
    }
    committed = true;
    await options.shutdown();
  };

  /**
   * The synchronous half, and the whole point of this rewrite: the decision is
   * taken at event time and the native close is denied *before* any await.
   *
   * Denied in both branches, not only when there is something to ask about.
   * With `runtime.exitOnLastWindowClosed` the native side exits the process as
   * soon as the last window is really closed, so an allowed close is a race
   * between that exit and our own `shutdown()` — the poller, the chat owner and
   * the pending-op store would be left to whatever the process does on the way
   * out. Denying always makes leaving this process's own decision: the guard
   * tears down and exits, and the window it refused to close dies with it.
   */
  const attempt = (event: CloseAttempt): void => {
    if (committed) return;
    if (leaving) {
      // A modal is up, or a teardown is already running. Either way this app
      // is not closing behind its own back.
      event.deny();
      return;
    }
    const running = options.ops.list({ status: "running" }).ops;
    const decision = closeDecision(running);
    event.deny();
    leaving = true;
    if (decision.needsPrompt) {
      options.log?.line("info", "close", "close denied, confirming with the operator", {
        running: running.length,
      });
    }
    /**
     * Off the native callback's own stack.
     *
     * This listener is called from inside the FFI callback that asked whether
     * the window may close, and the teardown it starts closes that same window
     * through the same FFI. Doing that before the callback has returned wedges
     * the native side: an idle close logged `shutting down` and then nothing,
     * with the process still alive a minute later. A macrotask lets the
     * callback return its answer first; the decision above has already been
     * taken, so nothing about it can change in between. Injectable, because a
     * test that waits on a real timer is at the mercy of whatever the other
     * suites in the same `bun test` process did to the global one.
     */
    defer(() => {
      void settle(running, decision.needsPrompt ? decision.message : "").catch((e: unknown) => {
        // A dialog or a teardown that throws must not leave the app
        // permanently unquittable: clear the flag so the next Cmd-Q gets a
        // fresh attempt rather than the silent `return` above.
        leaving = false;
        options.log?.line(
          "warn",
          "close",
          `close guard failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
    });
  };

  for (const event of CLOSE_EVENTS) options.on(event, attempt);
}
