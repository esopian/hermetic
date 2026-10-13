/**
 * The desktop head's mobile bridge: started at boot when `mobile.settings`
 * says `enabled`, started and stopped again whenever that setting changes, and
 * stopped on quit.
 *
 * The bridge itself is core's (`startMobileBridge`, reached through
 * `mobileBridgeHost(hermetic)`); this module decides its lifetime and fans its
 * events out to the pages that follow it (`mobile.serve`). It never ticks
 * `chat.swarms` — the fleet poller already does — and it follows the current
 * `Hermetic`: a fleet switch restarts the bridge on the new one at the next
 * `sync()` or `ensureStarted()`.
 *
 * What it logs is ids, urls and outcomes. Never a token, a pair code, a
 * message or a request's params.
 */
import {
  type Hermetic,
  type MobileBridge,
  type MobileServeStatus,
  mobileBridgeHost,
} from "@hermetic/core";
import type { StreamHandle, StreamSink } from "./handlers/streams.ts";
import type { AppLog } from "./log.ts";

export interface MobileHost {
  /** Start the bridge on the current `Hermetic` (restarting it after a fleet switch). */
  ensureStarted(): Promise<MobileServeStatus>;
  stop(reason?: string): Promise<void>;
  /** Start or stop to match `mobile.settings.enabled`. Never throws. */
  sync(): Promise<void>;
  status(): MobileServeStatus | null;
  /** A `status` frame now, then every bridge event, until the handle closes. */
  follow(sink: StreamSink): StreamHandle;
}

export interface MobileHostDeps {
  hermetic: () => Hermetic;
  log?: AppLog | undefined;
  /** Overrides `mobile.settings`' host and port; tests bind port 0. */
  bind?: { host?: string; port?: number } | undefined;
}

export function createMobileHost(deps: MobileHostDeps): MobileHost {
  let bridge: MobileBridge | null = null;
  let owner: Hermetic | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const followers = new Set<StreamSink>();

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
    const current = bridge;
    bridge = null;
    owner = null;
    if (current === null) return;
    await current.close(reason);
    deps.log?.line("info", "mobile", "bridge stopped", { reason });
    fanout("status", null);
  }

  async function startNow(): Promise<MobileServeStatus> {
    const hermetic = deps.hermetic();
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

  return {
    ensureStarted: () => serial(startNow),
    stop: (reason = "stopped") => serial(() => stopNow(reason)),
    sync: () =>
      serial(async () => {
        try {
          const hermetic = deps.hermetic();
          const enabled = hermetic.target !== null && mobileBridgeHost(hermetic).settings().enabled;
          if (enabled) await startNow();
          else await stopNow("disabled");
        } catch (e) {
          deps.log?.line("warn", "mobile", "bridge could not start", {
            code: typeof e === "object" && e !== null && "code" in e ? String(e.code) : "INTERNAL",
          });
        }
      }),
    status: () => bridge?.status() ?? null,
    follow(sink) {
      followers.add(sink);
      void sink({ event: "status", data: bridge?.status() ?? null });
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
