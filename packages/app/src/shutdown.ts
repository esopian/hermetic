/**
 * Ctrl-C at a running app, and the SIGTERM a supervisor sends.
 *
 * Without a handler the process dies wherever it happened to be: the log ends
 * mid-line, the poller's interval is still armed, and every stream the head was
 * pumping simply stops mid-frame. With one, the last line in `<home>/app.log`
 * says the operator asked for this — which is the difference between "the app
 * stopped" and "the app crashed" when someone reads the file tomorrow.
 *
 * Nothing here waits on a reader. The long-lived streams are long-lived by
 * design (an op stream and the fleet stream end when the operator closes the
 * window, not before), so a *graceful* stop would wait for a page that is never
 * going to let go. The shutdown is: stop scanning, close what is open, exit.
 */
import { disposeChatRequestPools } from "@hermetic/core";
import type { AppLog } from "./log.ts";

/**
 * As much of whatever this process holds open as a shutdown needs.
 *
 * Named for the listener the Hono head passed, and kept because the shape is
 * exactly right for what the desktop head passes instead: `main/index.ts` hands
 * it the window set, whose `stop(closeActive)` closes the windows.
 */
export interface StoppableServer {
  stop(closeActiveConnections?: boolean): void | Promise<void>;
}

/** As much of `AppState` as a shutdown needs; `null` before `init` has run. */
export interface PollingState {
  readonly poller: { stop(): void } | null;
}

/** As much of the chat owner as a shutdown needs (`chat-owner.ts`). */
export interface StoppableObservations {
  stop(): Promise<void>;
}

/** As much of the chat coverage watchdog as a shutdown needs (`chat-watchdog.ts`). */
export interface StoppableWatchdog {
  /** Disarms every timer. Synchronous: it holds nothing worth waiting for. */
  stop(): void;
}

/** As much of the terminal host as a shutdown needs (`terminal/host.ts`). */
export interface StoppableTerminals {
  /** Hangs up every live session. Synchronous: nothing after a quit gets to wait. */
  stopAll(): void;
}

export interface ShutdownTarget {
  server: StoppableServer;
  state?: PollingState;
  log?: AppLog;
  chat?: StoppableObservations;
  /** Stopped before `chat`, so nothing re-pins what the owner is letting go of. */
  watchdog?: StoppableWatchdog;
  terminals?: StoppableTerminals;
}

/**
 * The shell's convention for "ended by this signal": 128 + the signal number.
 * A supervisor reading the status of `hermetic-portal` should see that it was
 * asked to stop, not that it failed.
 */
export const SIGNAL_EXIT_CODES: Readonly<Record<string, number>> = {
  SIGINT: 130,
  SIGTERM: 143,
};

/** Stops the poller and closes the listener. Exported so a test can call it. */
export async function shutdown(target: ShutdownTarget, signal: string): Promise<void> {
  target.log?.line("info", "portal", `shutting down (${signal})`);
  /**
   * The terminal sessions first, and synchronously (issue #18): every
   * `tailscale ssh` this process started is hung up before anything below can
   * await, so a teardown that stalls on the chat owner or a second Ctrl-C that
   * exits mid-way still leaves no session running without its window.
   */
  try {
    target.terminals?.stopAll();
  } catch {
    // Same rule as the poller: a session that will not stop is not a reason to stay up.
  }
  try {
    target.state?.poller?.stop();
  } catch {
    // A poller that will not stop must not stop the process from stopping.
  }
  /**
   * The coverage watchdog before the observations it watches: a sync or a
   * resume it fired mid-teardown would otherwise be asking a stopping owner to
   * hold something again. Synchronous, like the poller.
   */
  try {
    target.watchdog?.stop();
  } catch {
    // Same rule as the poller.
  }
  /**
   * The chat observations this process holds (`chat-owner.ts`). Aborting one
   * stops this laptop reading; it interrupts nothing on any box.
   *
   * Guarded rather than `await target.chat?.stop()`, because `await undefined`
   * is still a suspension: a target with no observations must reach
   * `server.stop()` in the same tick it always did, which is what the second
   * Ctrl-C ("exit without waiting") is asserted against.
   */
  if (target.chat !== undefined) {
    try {
      await target.chat.stop();
    } catch {
      // Same rule as the poller: an observation that will not let go is not a
      // reason to stay up.
    }
  }
  /**
   * Bot Mode's pooled request sockets (`hermes-chat-pool.ts`). They are held
   * per box with a short idle TTL, so a portal that stops between two probes
   * would otherwise leave one open on every box the pane touched until the TTL
   * expired — after the process claimed to have shut down.
   */
  try {
    disposeChatRequestPools();
  } catch {
    // Same rule as the poller: a socket that will not close is not a reason to
    // stay up.
  }
  // `true`: close active connections too, which is what ends the SSE streams.
  await target.server.stop(true);
}

export interface InstallShutdownOptions {
  /** Injected by tests; production ends the process. */
  exit?: (code: number) => void;
  /** Injected by tests; production is `process`. */
  on?: (signal: NodeJS.Signals, handler: () => void) => void;
}

/**
 * Registers the handlers. A second signal is an order rather than a request —
 * the same escalation `packages/cli/src/main.ts` gives Ctrl-C — so it exits
 * without waiting for the first shutdown to finish.
 */
export function installShutdown(target: ShutdownTarget, options: InstallShutdownOptions = {}): void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const on =
    options.on ?? ((signal: NodeJS.Signals, handler: () => void) => void process.on(signal, handler));
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    on(signal, () => {
      const code = SIGNAL_EXIT_CODES[signal] ?? 0;
      if (stopping) {
        exit(code);
        return;
      }
      stopping = true;
      void shutdown(target, signal)
        .catch((e: unknown) => {
          target.log?.line(
            "warn",
            "portal",
            `shutdown failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        })
        .finally(() => exit(code));
    });
  }
}
