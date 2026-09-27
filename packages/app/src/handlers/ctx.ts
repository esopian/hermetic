/**
 * What a handler is handed.
 *
 * The handlers under `handlers/` are the head's real work: validate, guard,
 * call core, start an op. None of that was ever HTTP, which is why the Hono
 * head could be lifted off them and thrown away — `rpc/bind.ts` binds this
 * same context to the desktop bridge, and `dispatch.ts` is the table.
 */
import type { Hermetic } from "@hermetic/core";
import type { ChatOwner } from "../chat-owner.ts";
import type { AppLog } from "../log.ts";
import type { OpRegistry } from "../ops.ts";
import type { FleetPoller } from "../poller.ts";
import type { AppState } from "../state.ts";
import type { StreamRegistry } from "./streams.ts";

/**
 * The five things only a native head can do (`handlers/app.ts`).
 *
 * Declared here as plain functions rather than imported from `main/`, because
 * every module under `main/` that matters is reached through `main/index.ts`,
 * the one file allowed to import `electrobun/bun` — and `ctx.ts` is imported
 * by every handler test, so an import chain that ended at the devkit would
 * throw in all of them. `main/index.ts` builds an object of this shape out of
 * `createNotifier`, `createUpdater`, `installCli` and `Utils`.
 */
export interface NativeDeps {
  /** What this build is: version, update channel, and where its state and log live. */
  info(): { version: string; channel: string; home: string; logPath: string | null };
  /** Hands a URL to the operator's browser (`Utils.openExternal`). */
  openExternal(url: string): void;
  /** One update check, now — the menu's "Check for Updates…" (`main/updates.ts`). */
  checkForUpdate(): Promise<void>;
  /** Writes the `hermetic` shim onto `PATH`, elevating once if it must (`main/cli-install.ts`). */
  installCli(): Promise<{ path: string; elevated: boolean }>;
  /** Raises a desktop banner (`main/notify.ts`); the page decides whether to. */
  notify(request: { title: string; body: string; tag?: string }): {
    delivered: true;
    permission: "granted";
  };
}

export interface AppOptions {
  /** Reflected in `meta.get` and appended to the header line. */
  fixture?: boolean;
  ops?: OpRegistry;
  poller?: FleetPoller;
  /**
   * The chat observations this head holds (`chat-owner.ts`). Passed in by
   * `main/index.ts`, which also syncs it at boot and stops it on shutdown; a
   * context built without one gets its own, which observes nothing until
   * something calls `sync()`.
   */
  chatOwner?: ChatOwner;
  /** TODO(evan): PHASE2 — core exposes no build-version constants; the head is told. */
  hermeticdVersion?: string;
  hermesVersion?: string;
  /** Request failures are logged here as well as answered (see `log.ts`). */
  log?: AppLog;
}

/**
 * What the bridge hands each handler: the same things the handlers closed over
 * when they all lived in one function.
 */
export interface HandlerContext {
  state: AppState;
  /**
   * Handlers read the instance *per request*. `hermetic-portal` can boot before
   * `init` has ever run and swap in a real instance when the browser wizard
   * finishes, so a reference captured at construction would keep answering
   * `NOT_INITIALIZED` for the life of the process (see `state.ts`).
   */
  hermetic: () => Hermetic;
  ops: OpRegistry;
  /**
   * Read lazily for the same reason `hermetic` is: the state re-keys its poller
   * on every `adopt()` and every fleet switch (`state.ts`), so a handler that
   * captured one would go on reading the fleet the process has left.
   */
  poller: () => FleetPoller | null;
  chatOwner: ChatOwner;
  fixture: boolean;
  log?: AppLog;
  opts: AppOptions;
  /** Long-lived pushes a transport holds open on a caller's behalf; see `streams.ts`. */
  streams: StreamRegistry;
  /**
   * The caller going away, where that is something a handler can act on.
   *
   * A handful of reads forward it into core (`agents.probe`,
   * `agents.desktop`, the chat writes): a browser that navigated away
   * mid-probe should stop three outbound network calls rather than finish
   * paying for them. It is per *request*, not per process, so a binding that
   * has one derives a context with `withSignal` rather than mutating the
   * shared object.
   */
  signal?: AbortSignal;
  /**
   * The desktop head's own capabilities, when there is a desktop head.
   *
   * Optional because a head without a window has none of them: a context built
   * without this field makes the `app.*` handlers refuse `UNSUPPORTED`, which
   * is the honest answer from a process that has no window, no updater and no
   * notification centre. Keeping it optional is also what keeps the forty-odd
   * existing handler tests unchanged: a context that never had a `native` goes
   * on meaning exactly what it meant before.
   */
  native?: NativeDeps;
}

/**
 * The same context, bound to one caller's abort signal. Cheap enough to do per
 * request, and the only thing that varies between requests.
 */
export function withSignal(ctx: HandlerContext, signal: AbortSignal): HandlerContext {
  return { ...ctx, signal };
}
