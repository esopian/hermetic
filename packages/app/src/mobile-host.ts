/**
 * The desktop head's mobile bridge: started at boot when `mobile.settings`
 * says `enabled`, started and stopped again whenever that setting changes, and
 * stopped on quit.
 *
 * The bridge itself is core's (`startMobileBridge`, reached through
 * `mobileBridgeHost(hermetic)`); this module decides its lifetime and fans its
 * events out to the pages that follow it (`mobile.serve`). It never ticks
 * `chat.swarms` — the fleet poller already does — and it follows the current
 * `Hermetic`: every handler that swaps it (a fleet switch, the wizard adopting
 * a fresh `init`, a teardown's reset) calls `sync()`, which restarts the
 * bridge on the new instance, or stops it when there is no fleet to serve.
 *
 * A teardown stops it for as long as the teardown holds (`held`), so the
 * fleet being deleted is not served while it goes. A `sync` whose start fails
 * (the old listener still holds the port) retries once after
 * `START_RETRY_MS`, and a second failure reaches followers as an `error` frame
 * (`{code, message}`) after the null `status`, so Settings can say why it is
 * not serving instead of only showing it off.
 *
 * What it logs is ids, urls and outcomes. Never a token, a pair code, a
 * message or a request's params.
 */
import {
  type Hermetic,
  type MobileBridge,
  type MobileServeStatus,
  isHermeticError,
  mobileBridgeHost,
} from "@hermetic/core";
import type { StreamHandle, StreamSink } from "./handlers/streams.ts";
import type { AppLog } from "./log.ts";

/** How long a failed `sync` start waits before its one retry. */
export const START_RETRY_MS = 500;

/** The `error` frame a follower gets when the bridge should serve but could not start. */
export interface MobileHostError {
  code: string;
  message: string;
}

export interface MobileHost {
  /**
   * Start the bridge on the current `Hermetic` (restarting it after a fleet
   * switch). `null`, and nothing started, while a teardown holds it.
   */
  ensureStarted(): Promise<MobileServeStatus | null>;
  stop(reason?: string): Promise<void>;
  /**
   * Start, restart or stop to match the current `Hermetic` and its
   * `mobile.settings.enabled`. No fleet (the wizard, mid-teardown) stops it.
   * Never throws.
   */
  sync(): Promise<void>;
  /**
   * Close a revoked device's sockets on the hosted bridge now. Core's revoke
   * already does this for the bridge its own instance hosts; this covers a
   * bridge still owned by the instance a swap is replacing.
   */
  dropDevice(deviceId: string): void;
  status(): MobileServeStatus | null;
  /** A `status` frame now, then every bridge event, until the handle closes. */
  follow(sink: StreamSink): StreamHandle;
}

export interface MobileHostDeps {
  hermetic: () => Hermetic;
  log?: AppLog | undefined;
  /** Overrides `mobile.settings`' host and port; tests bind port 0. */
  bind?: { host?: string; port?: number } | undefined;
  /** True while nothing may be served: a teardown is deleting the fleet. */
  held?: (() => boolean) | undefined;
  /** Overrides `START_RETRY_MS`; tests shorten it. */
  retryMs?: number | undefined;
}

function errorOf(e: unknown): MobileHostError {
  if (isHermeticError(e)) return { code: e.code, message: e.message };
  // A bind failure is Bun's own error: its code (`EADDRINUSE`) says enough.
  const code =
    typeof e === "object" && e !== null && "code" in e && typeof e.code === "string"
      ? e.code
      : "INTERNAL";
  return { code, message: "the mobile bridge could not start" };
}

export function createMobileHost(deps: MobileHostDeps): MobileHost {
  let bridge: MobileBridge | null = null;
  let owner: Hermetic | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const followers = new Set<StreamSink>();
  /** Why the bridge is not serving though it should; cleared by a start or a deliberate stop. */
  let lastError: MobileHostError | null = null;
  const held = (): boolean => deps.held?.() === true;

  function fanout(event: string, data: unknown): void {
    for (const sink of [...followers]) {
      try {
        void sink({ event, data });
      } catch {
        /* a follower that cannot take a frame is closing */
      }
    }
  }

  /** One lifecycle change at a time: a toggle pressed twice must not start two. */
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const run = chain.then(work, work);
    chain = run.catch(() => {});
    return run;
  }

  async function stopNow(reason: string): Promise<void> {
    lastError = null;
    const current = bridge;
    bridge = null;
    owner = null;
    if (current === null) return;
    await current.close(reason);
    deps.log?.line("info", "mobile", "bridge stopped", { reason });
    fanout("status", null);
  }

  /** Start on `hermetic` — the instance `sync` already read, so both agree on it. */
  async function startNow(hermetic: Hermetic = deps.hermetic()): Promise<MobileServeStatus> {
    if (bridge !== null && owner === hermetic) return bridge.status();
    if (bridge !== null) await stopNow("fleet switched");
    const started = await mobileBridgeHost(hermetic).start({
      app: "desktop",
      tickSwarms: false,
      host: deps.bind?.host,
      port: deps.bind?.port,
    });
    bridge = started;
    owner = hermetic;
    lastError = null;
    started.on((event) => {
      if (event.type === "stopped") return;
      deps.log?.line("info", "mobile", `bridge ${event.type}`, {
        ...("device_id" in event ? { device: event.device_id } : {}),
        ...(event.type === "device" ? { action: event.action } : {}),
      });
      fanout(event.type, event);
      fanout("status", started.status());
    });
    deps.log?.line("info", "mobile", "bridge listening", { url: started.url });
    const status = started.status();
    fanout("status", status);
    return status;
  }

  /** Start, and once more after a pause if the first try fails; the second failure is reported. */
  async function startWithRetry(hermetic: Hermetic): Promise<void> {
    try {
      await startNow(hermetic);
      return;
    } catch (e) {
      deps.log?.line("warn", "mobile", "bridge could not start; retrying", { code: errorOf(e).code });
    }
    await Bun.sleep(deps.retryMs ?? START_RETRY_MS);
    // The instance moved on, or a teardown began, while we waited: the sync
    // queued behind this one decides.
    if (held() || currentOrNull() !== hermetic) return;
    try {
      await startNow(hermetic);
    } catch (e) {
      lastError = errorOf(e);
      deps.log?.line("warn", "mobile", "bridge could not start", { code: lastError.code });
      fanout("status", null);
      fanout("error", lastError);
    }
  }

  function currentOrNull(): Hermetic | null {
    try {
      return deps.hermetic();
    } catch {
      return null;
    }
  }

  return {
    ensureStarted: () =>
      serial(async () => {
        if (held()) return null;
        return await startNow();
      }),
    stop: (reason = "stopped") => serial(() => stopNow(reason)),
    sync: () =>
      serial(async () => {
        let reason = "no fleet";
        let enabled = false;
        // Read once: the start below runs on this instance, not on whatever
        // `deps.hermetic()` answers by the time it gets there.
        const hermetic = currentOrNull();
        try {
          if (held()) reason = "teardown";
          else if (hermetic !== null && hermetic.target !== null) {
            enabled = mobileBridgeHost(hermetic).settings().enabled;
            reason = "disabled";
          }
        } catch {
          // An unreadable setting is a bridge that stays off.
        }
        try {
          if (enabled && hermetic !== null) await startWithRetry(hermetic);
          else await stopNow(reason);
        } catch (e) {
          deps.log?.line("warn", "mobile", "bridge could not stop", { code: errorOf(e).code });
        }
      }),
    status: () => bridge?.status() ?? null,
    dropDevice(deviceId) {
      if (bridge === null) return;
      let current: Hermetic | null = null;
      try {
        current = deps.hermetic();
      } catch {
        /* no instance: the bridge is a leftover, drop on it */
      }
      if (current !== owner) bridge.dropDevice(deviceId);
    },
    follow(sink) {
      followers.add(sink);
      void sink({ event: "status", data: bridge?.status() ?? null });
      if (bridge === null && lastError !== null) void sink({ event: "error", data: lastError });
      let release: () => void = () => {};
      const done = new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        close() {
          followers.delete(sink);
          release();
        },
        done,
      };
    },
  };
}
