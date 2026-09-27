/**
 * Ctrl-C at a running portal. The handler is installed with injected `on`/`exit`
 * so the test never touches this process's own signal handlers.
 */
import { describe, expect, test } from "bun:test";
import { memoryLog } from "../src/log.ts";
import { SIGNAL_EXIT_CODES, installShutdown, shutdown } from "../src/shutdown.ts";

function fakeServer() {
  const stops: Array<boolean | undefined> = [];
  return {
    stops,
    stop(closeActiveConnections?: boolean) {
      stops.push(closeActiveConnections);
    },
  };
}

function fakePoller() {
  const state = { stopped: 0 };
  return { state, poller: { stop: () => void (state.stopped += 1) } };
}

/** Collects the handlers `installShutdown` registers, and fires them by name. */
function signals() {
  const handlers = new Map<string, () => void>();
  return {
    on: (signal: NodeJS.Signals, handler: () => void) => void handlers.set(signal, handler),
    fire: (signal: string) => handlers.get(signal)?.(),
    names: () => [...handlers.keys()],
  };
}

describe("shutdown", () => {
  test("stops the poller and closes active connections", async () => {
    const server = fakeServer();
    const { state, poller } = fakePoller();
    const log = memoryLog();

    await shutdown({ server, state: { poller }, log }, "SIGINT");

    expect(state.stopped).toBe(1);
    // `true`: the SSE streams never end on their own, so a graceful close
    // would wait for a browser that is not going to hang up.
    expect(server.stops).toEqual([true]);
    expect(log.lines.join("")).toContain("INFO  portal shutting down (SIGINT)");
  });

  test("an uninitialized server has no poller and stops anyway", async () => {
    const server = fakeServer();
    await shutdown({ server, state: { poller: null } }, "SIGTERM");
    expect(server.stops).toEqual([true]);
  });

  test("a poller that throws does not stop the process from stopping", async () => {
    const server = fakeServer();
    await shutdown(
      {
        server,
        state: {
          poller: {
            stop() {
              throw new Error("wedged");
            },
          },
        },
      },
      "SIGINT",
    );
    expect(server.stops).toEqual([true]);
  });
});

describe("installShutdown", () => {
  test("both signals are handled, and each exits with the shell's status", async () => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const server = fakeServer();
      const { state, poller } = fakePoller();
      const sig = signals();
      const exits: number[] = [];
      installShutdown(
        { server, state: { poller }, log: memoryLog() },
        { on: sig.on, exit: (c) => void exits.push(c) },
      );

      expect(sig.names().sort()).toEqual(["SIGINT", "SIGTERM"]);
      sig.fire(signal);
      // The close is async; let the microtask that awaits it run.
      await Bun.sleep(0);
      expect(state.stopped).toBe(1);
      expect(exits).toEqual([SIGNAL_EXIT_CODES[signal] ?? 0]);
    }
  });

  test("a second Ctrl-C is an order: it exits without waiting", () => {
    const stops: number[] = [];
    const sig = signals();
    const exits: number[] = [];
    const server = {
      stop() {
        stops.push(1);
        // Never settles: the first shutdown is still in flight.
        return new Promise<void>(() => {});
      },
    };
    installShutdown({ server }, { on: sig.on, exit: (c) => void exits.push(c) });

    sig.fire("SIGINT");
    expect(exits).toEqual([]);
    sig.fire("SIGINT");
    expect(exits).toEqual([130]);
    // The hung first stop was not started twice.
    expect(stops.length).toBe(1);
  });

  /**
   * What `dev.ts` relies on under `--hot`: the handlers are installed once,
   * against an object later evaluations write into. Were the target read at
   * install time instead, Ctrl-C after a reload would stop the first
   * evaluation's server while the current one kept listening.
   */
  test("the target is read when the signal arrives, not when it is installed", async () => {
    const first = fakeServer();
    const second = fakeServer();
    const target = { server: first as { stop(c?: boolean): void } };
    const sig = signals();
    installShutdown(target, { on: sig.on, exit: () => {} });

    target.server = second;
    sig.fire("SIGINT");
    await Bun.sleep(0);

    expect(first.stops).toEqual([]);
    expect(second.stops).toEqual([true]);
  });

  test("a failed close still exits, and says why in the log", async () => {
    const log = memoryLog();
    const sig = signals();
    const exits: number[] = [];
    installShutdown(
      {
        server: {
          stop() {
            return Promise.reject(new Error("socket already gone"));
          },
        },
        log,
      },
      { on: sig.on, exit: (c) => void exits.push(c) },
    );

    sig.fire("SIGTERM");
    await Bun.sleep(0);
    expect(exits).toEqual([143]);
    expect(log.lines.join("")).toContain("shutdown failed: socket already gone");
  });
});
