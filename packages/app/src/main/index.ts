/**
 * The desktop head's entrypoint.
 *
 * The one file in this package that imports `electrobun/bun`. That import is a
 * runtime dependency on a devkit Hutch projects into `packages/app/.hutch/`, so
 * this module cannot be executed — or imported — outside a built app, and
 * nothing here may be worth testing: every decision it looks like it is making
 * belongs to `main/paths.ts`, `main/windows.ts` or `rpc/bind.ts`, which take
 * their dependencies as arguments and are tested without an app at all. What is
 * left is order, and the comments below are what each step is doing where it is.
 *
 * Modelled on the Hono head's `startServer`, minus the listener and the app.
 * It keeps none of that module's `globalThis.__hermetic*` singletons: those
 * guarded against Bun's `--hot` re-running module top-level code, and Hutch
 * relaunches the process instead of reloading it.
 */
import Electrobun, {
  ApplicationMenu,
  type ApplicationMenuItemConfig,
  BrowserView,
  BrowserWindow,
  Updater,
  Utils,
} from "electrobun/bun";
import { chmodSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  HERMETICD_ENV,
  STAGES_ENV,
  fixtureOptionsFromEnv,
  openPendingOpStore,
  runRecorderFor,
} from "@hermetic/core";
import { createChatOwner } from "../chat-owner.ts";
import { dispatch } from "../handlers/dispatch.ts";
import { createStreamRegistry } from "../handlers/streams.ts";
import type { HandlerContext } from "../handlers/ctx.ts";
import { createAppLog } from "../log.ts";
import { OpRegistry } from "../ops.ts";
import { resumePendingOps } from "../resume.ts";
import { openState } from "../state.ts";
import { createRpcBinding, type SendMessage } from "../rpc/bind.ts";
import type { HermeticRPC } from "../rpc/schema.ts";
import { shutdown, type StoppableServer } from "../shutdown.ts";
import { installCli } from "./cli-install.ts";
import { installCloseGuard } from "./close-guard.ts";
import { installDevProbe } from "./dev-probe.ts";
import { installMenu, type MenuItemModel } from "./menu.ts";
import { createNotifier } from "./notify.ts";
import { bundlePaths } from "./paths.ts";
import { createUpdater } from "./updates.ts";
import { applyNavigationRules, installNavigationGuard, mainNavigationRules } from "./navigation.ts";
import { externalUrl } from "../external-url.ts";
import { applyMinimumSize } from "./min-size.ts";
import { fetchProbe, resolveViewUrl } from "./view-url.ts";
import { createWindows, DEFAULT_FRAME, MIN_FRAME, type OpenedWindow } from "./windows.ts";

/**
 * What a GUI launch has instead of a `PATH`: nothing useful. LaunchServices
 * gives an app the system default, not the operator's shell environment, and
 * core spawns `git` bare (`release/git.ts`, `release/hermes-mirror.ts`) and
 * `tailscale` bare before falling back to absolute paths. Prepended rather than
 * replacing, so a launch from a terminal keeps the environment it was given.
 */
const GUI_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";

/**
 * What `app.info` reports as this build.
 *
 * A bundle has no `package.json` to read and no git checkout to ask, so the
 * version is stamped into the environment by the build and falls back to a
 * label that cannot be mistaken for a release.
 *
 * TODO(evan): stamp this (and the build number and commit) with `--define` at
 * bundle time, so a release pushed from a built app carries the same
 * provenance as one pushed from a source checkout.
 */
const APP_VERSION = process.env["HERMETIC_APP_VERSION"] ?? "0.0.0-dev";

/**
 * The release channel this bundle was built for, read once.
 *
 * Every accessor on the devkit's `Updater.localInfo` is async — it reads the
 * bundle's `version.json` the first time and caches it — while both readers
 * here want a plain string: `app.info` answers a request synchronously, and
 * `UpdaterLike` (`main/updates.ts`) is a structural contract a test satisfies
 * with a literal. Awaiting it once at startup is the whole adaptation; the
 * value cannot change while the process runs.
 */
const APP_CHANNEL = await Updater.localInfo.channel();

/**
 * The bundle's own version, from the same `version.json`, for the updater's
 * "is the offered release actually newer" comparison (`main/updates.ts`).
 */
const BUNDLE_VERSION = await Updater.localInfo.version();

const fixture = process.env["HERMETIC_FIXTURE"] === "1";
const uninitialized = process.env["HERMETIC_UNINIT"] === "1";

process.env["PATH"] = `${GUI_PATH}:${process.env["PATH"] ?? ""}`;

const paths = bundlePaths({ execPath: process.execPath, env: process.env, fixture });

/**
 * Before `openState`, because `init` and `artifacts push` resolve the release
 * the moment they are asked and these two variables are the explicit, winning
 * lookup (`release/artifacts-release.ts`). Set only when unset: an operator who
 * exported one meant it, and a development run against a checkout's own build
 * is exactly that case.
 */
if (process.env[HERMETICD_ENV] === undefined) process.env[HERMETICD_ENV] = paths.hermeticd;
if (process.env[STAGES_ENV] === undefined) process.env[STAGES_ENV] = paths.stagesDir;

/**
 * A laptop that has never run `init` still gets a window — that is what the
 * wizard is for. `NOT_INITIALIZED` is an outcome here, not a failure.
 */
const state = await openState({
  fixture,
  ...(fixture ? { fixtureOptions: fixtureOptionsFromEnv(process.env) } : {}),
  uninitialized,
});

// The real directory, not `state.home`: fixture state calls its home
// `:memory:`, which is not a path, and its log already lives in `$HERMETIC_HOME`.
const log = createAppLog({ home: paths.home, fixture });

const pending = openPendingOpStore({ fixture });
/**
 * §4.6/§4.8: every run and pending row this head writes says which fleet it was
 * against. A getter, so a fleet switch or the wizard's adopt moves the target
 * on every op started after it.
 */
const ops = new OpRegistry({
  runs: runRecorderFor({ fixture }),
  pending,
  log,
  target: () => state.runTarget,
});

/**
 * The conversations this process watches, held here rather than by a window so
 * that closing the last one does not stop the app noticing a message from
 * Hermes Desktop, another operator's CLI or a routine (`chat-owner.ts`).
 */
const chatOwner = createChatOwner({ hermetic: () => state.hermetic, log });

log.line("info", "app", `starting${fixture ? " (fixture)" : ""}`, {
  home: state.home,
  initialized: state.initialized,
  fleet: state.fleetId,
  bin: paths.binDir,
});

/**
 * The page every window loads: the bundled one, unless a dev build was started
 * by `bun run dev:hmr` and its Vite server answers (`main/view-url.ts`). Read
 * once, so a second window never lands on a different page than the first.
 */
const viewUrl = await resolveViewUrl({
  channel: APP_CHANNEL,
  env: process.env,
  probe: fetchProbe,
  log,
});

/** The page above and nothing else (`mainNavigationRules`). */
const navigationRules = mainNavigationRules(viewUrl);

/**
 * §4.6: anything still in the pending log is an op this laptop was running when
 * it last stopped. Restarted before the window opens, so the first fleet
 * snapshot the page gets already shows them running. An uninitialized home has
 * no fleet to resume against.
 */
if (state.initialized) {
  await resumePendingOps({
    ops,
    pending,
    hermetic: () => state.hermetic,
    // §4.7, §4.8: only this fleet's interrupted ops. Another fleet's are left
    // where they are, and so are rows that cannot say which fleet they were for.
    fleet: state.target,
    log,
  });
}

/**
 * The two modal questions this head asks, both on the devkit's message box.
 *
 * `showMessageBox` answers with the *index* of the button that was clicked, so
 * the affirmative is index 0 by construction and `cancelId` names the other —
 * Escape and a closed dialog then read as "no" rather than as "yes by
 * accident", which is the one mistake that matters here: a silent yes quits
 * with an op running, or throws a browser window over an operator who never
 * asked for one. `defaultId` is the negative for the same reason: Enter on a
 * prompt that appeared under the operator's hands must not be the yes.
 *
 * A throw is also a no. The dialog is native code we did not write, and the
 * caller of both of these treats `false` as "stay", which is the safe answer to
 * a question that could not be asked.
 */
async function askDialog(options: {
  title: string;
  message: string;
  affirmative: string;
  negative: string;
}): Promise<boolean> {
  try {
    const { response } = await Utils.showMessageBox({
      type: "question",
      title: options.title,
      message: options.message,
      buttons: [options.affirmative, options.negative],
      defaultId: 1,
      cancelId: 1,
    });
    return response === 0;
  } catch (e: unknown) {
    log.line("warn", "dialog", `message box failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** The close guard's: leaving now abandons work, so the affirmative is Quit. */
const confirmQuit = (message: string): Promise<boolean> =>
  askDialog({
    title: "Quit Hermetic",
    message,
    affirmative: "Quit",
    negative: "Cancel",
  });

/** The updater's: declining only defers, so the negative is Later, not Cancel. */
const confirmOpenRelease = (message: string): Promise<boolean> =>
  askDialog({
    title: "Update Hermetic",
    message,
    affirmative: "Open Release Page",
    negative: "Later",
  });

/**
 * Every devkit call is wrapped rather than passed as a bare method reference.
 * `Utils` and `ApplicationMenu` are objects we did not write, and an
 * implementation that reads `this` breaks silently when its method is handed
 * around detached — a failure that would only ever appear in a built app.
 */
const notify = createNotifier({
  showNotification: (options) => Utils.showNotification(options),
  log,
});

/**
 * "Install Command Line Tool…", with the two real side effects the module
 * refuses to reach for itself. The `mode` it passes is its own `SHIM_MODE`;
 * `chmodSync` follows the write because a mode argument only applies to a file
 * being *created*, and reinstalling over an existing shim is the common case —
 * a shim that is not executable is worse than no shim at all.
 */
const runCliInstall = () =>
  installCli({
    bundleBin: paths.binDir,
    write: (path, content, mode) => {
      writeFileSync(path, content, { mode });
      chmodSync(path, mode);
    },
    spawn: async (argv) => {
      const [command, ...args] = argv;
      const proc = Bun.spawn([command ?? "", ...args], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      return { exitCode: await proc.exited };
    },
    log,
  });

/** Whatever `BrowserView.defineRPC` hands back for this contract. */
type WindowRpc = ReturnType<typeof BrowserView.defineRPC<HermeticRPC>>;

/**
 * One `webview.messages` push, aimed at a window's bridge once it exists.
 *
 * The cast is the devkit's variance, not a shrug: `send` is generic over the
 * message name, so calling it with a name that is only known as a union gives a
 * payload that is an *intersection* of every payload. No real payload is
 * assignable to that, and every caller here already picked its name and payload
 * together — `SendMessage` is the pair. The alternative is a `send` overload
 * per message name, which is the same assertion written five times.
 */
function sendThrough(rpc: () => WindowRpc | null): SendMessage {
  return (name, payload) => {
    // The call form, never `send[name]`: Electrobun's `send` is a proxy over a
    // function, so a message sharing a name with a `Function` property (`call`,
    // `apply`, `name`, …) would resolve to that property instead (see
    // `RpcHandle` in `ui/src/api/transport-rpc.ts`).
    (rpc()?.send as ((name: string, payload: unknown) => void) | undefined)?.(name, payload);
  };
}

/**
 * The first window's handler context, kept so the dev probe can dispatch
 * through exactly what the page dispatches through (`main/dev-probe.ts`). A
 * context belongs to a window — its stream registry is that window's — so this
 * is the first one opened and nothing else.
 */
let firstCtx: HandlerContext | null = null;

/** The same window's native handle, so a probe can script the page it holds. */
let firstWindow: BrowserWindow | null = null;

const windows = createWindows({
  open(): OpenedWindow {
    /**
     * The knot this closure unties: the binding needs a way to push at the page,
     * which is the object `defineRPC` returns, which needs the handler table the
     * binding builds. `defineRPC` is called synchronously inside
     * `createRpcBinding`, so capturing its result on the way through is enough —
     * every `send` happens long after.
     */
    let rpc: ReturnType<typeof BrowserView.defineRPC<HermeticRPC>> | null = null;
    /**
     * One context per window, and one stream registry with it: the streams a
     * window opened are the streams its `close()` drops (`rpc/bind.ts`).
     */
    const ctx: HandlerContext = {
      state,
      hermetic: () => state.hermetic,
      ops,
      poller: () => state.poller,
      chatOwner,
      fixture,
      log,
      // `port` is the loopback guard's, and there is no listener to guard. The
      // default is carried so `AppOptions` is satisfied by something honest.
      opts: { fixture, ops, chatOwner, log },
      streams: createStreamRegistry(),
      /**
       * What makes this head the desktop one: the same five capabilities the
       * HTTP head has none of, so `handlers/app.ts` answers instead of
       * refusing. `updater` is read lazily because it is constructed below,
       * after the window set it broadcasts through — this closure runs on
       * `windows.open()`, long after both exist.
       */
      native: {
        info: () => ({
          version: APP_VERSION,
          channel: APP_CHANNEL,
          home: paths.home,
          logPath: paths.logPath,
        }),
        openExternal: (url) => Utils.openExternal(url),
        checkForUpdate: () => updater.check({ interactive: true }),
        installCli: runCliInstall,
        notify,
      },
    };
    firstCtx ??= ctx;
    const binding = createRpcBinding({
      defineRPC: (options) => {
        rpc = BrowserView.defineRPC<HermeticRPC>(options);
        return rpc;
      },
      send: sendThrough(() => rpc),
      ctx,
      log,
    });
    /**
     * The window's page and nothing else (`main/navigation.ts`). This webview
     * holds the RPC bridge, and Electrobun hands that bridge to every document
     * in it, subframes included — so the rules are native, and are set on
     * the webview the moment it exists. The constructor option is kept for
     * the day the devkit honours it; in 2.0.1 it is dropped before native
     * (`applyNavigationRules`), and the call below is what enforces anything.
     */
    const window = new BrowserWindow({
      title: "Hermetic",
      frame: { width: DEFAULT_FRAME.width, height: DEFAULT_FRAME.height },
      url: viewUrl,
      navigationRules: JSON.stringify(navigationRules),
      rpc: binding.rpc,
    });
    applyNavigationRules(window.webview, navigationRules);
    firstWindow ??= window;
    /**
     * What the rules refused, made useful: an http(s) link or `window.open`
     * goes to the operator's browser. Per-webview event names are the devkit's
     * `<event>-<webviewId>` (`events/eventEmitter.ts`).
     */
    installNavigationGuard({
      on: (event, listener) => Electrobun.events.on(`${event}-${window.webviewId}`, listener),
      openExternal: (url) => Utils.openExternal(url),
      log,
    });
    /**
     * The floor, asked of AppKit directly so the drag stops at the edge
     * instead of springing back from under it. Whether it took is logged
     * rather than acted on: `windows.ts` keeps its `resize` clamp behind
     * every window either way.
     */
    applyMinimumSize({ window, size: MIN_FRAME, log });
    return { window, send: sendThrough(() => rpc), close: binding.close };
  },
});

/**
 * What the shutdown closes.
 *
 * `ShutdownTarget.server` was named for the `Bun.serve` listener this process
 * used to own; there is no listener any more, and the honest equivalent of
 * "close the sockets" for a windowed app is "close the windows". Everything
 * else `shutdown()` does — stop the poller, hand back the chat observations,
 * dispose the Bot Mode pools — is unchanged, and is the whole reason a quit
 * goes through it rather than calling `process.exit` directly.
 */
const closingWindows: StoppableServer = {
  stop: () => windows.closeAll(),
};

/** Poller, chat, pools, windows — but not the process; the close guard exits. */
const teardown = (reason: string): Promise<void> =>
  shutdown({ server: closingWindows, state, log, chat: chatOwner }, reason);

/**
 * Check-and-notify only (`main/updates.ts`). The devkit's updater is handed
 * over as the two members `UpdaterLike` names and nothing else — not spread —
 * so its `downloadUpdate`/`applyUpdate` are unreachable from here: they apply
 * a release verified by TLS alone. `localInfo` is rebuilt because its devkit
 * accessors are async (see `APP_CHANNEL`).
 */
const updater = createUpdater({
  updater: {
    localInfo: { channel: () => APP_CHANNEL, version: () => BUNDLE_VERSION },
    checkForUpdate: () => Updater.checkForUpdate(),
  },
  ops,
  prompt: confirmOpenRelease,
  openExternal: (url) => Utils.openExternal(externalUrl(url)),
  broadcast: (name, payload) => windows.broadcast(name, payload),
  log,
});

const main = windows.open();

/**
 * Cancels a native close or quit.
 *
 * Both events are an `ElectrobunEvent` whose `response` setter flips a
 * `responseWasSet` flag the native side reads the instant the listener returns
 * (`.hutch/devkit/.../events/event.ts`, `proc/native.ts`'s
 * `windowShouldCloseCallback`, `core/Utils.ts`'s `requestQuitApproval`). The
 * guard never sees this type: it is handed a `deny()` and nothing else.
 */
function deny(event: unknown): void {
  if (typeof event !== "object" || event === null) return;
  (event as { response: { allow: boolean } }).response = { allow: false };
}

/**
 * Only after the window exists: the guard subscribes to that window's own
 * `will-close`, and there is nothing to subscribe to before it is open.
 */
installCloseGuard({
  ops,
  confirm: confirmQuit,
  shutdown: async () => {
    await teardown("quit");
    process.exit(0);
  },
  /**
   * The two events, on the two emitters that actually raise them.
   *
   * `will-close` belongs to a window (the red button, Cmd-W, and the close the
   * window manager does on a Cmd-Q); `before-quit` belongs to the application
   * and is raised by `Utils.requestQuitApproval` for a Cmd-Q, an Apple-menu
   * Quit or an `osascript` quit that need never touch this window. Both are
   * cancellable the same way — `event.response = { allow: false }` set while
   * the listener is on the stack — so both go through `deny`.
   */
  on: (event, listener) => {
    const fire = (native: unknown): void => listener({ deny: () => deny(native) });
    if (event === "will-close") main.window.on(event, fire);
    else Electrobun.events.on(event, fire);
  },
  log,
});

/**
 * Every clickable item's callback, keyed by the id `toMenuConfig` minted. Ids
 * are positional, so a click from a menu that has since been replaced resolves
 * to whatever now sits at that position; harmless while the menu is set once
 * at startup, and the thing to change (a generation prefix) if it ever is not.
 */
const menuClicks = new Map<string, () => void>();

/**
 * `MenuItemModel` → what the devkit serialises.
 *
 * Three differences, all forced: a divider is its own member of the devkit's
 * union rather than a `type` on an ordinary item, a role item carries no
 * action, and an action is a *string* the native side sends back. The ids are
 * positional (`item.0.2`) rather than the label, because a label is display
 * text and two of them could match.
 */
function toMenuConfig(items: MenuItemModel[], prefix = "item"): ApplicationMenuItemConfig[] {
  return items.map((item, index) => {
    if (item.type === "divider") return { type: "divider" };
    const id = `${prefix}.${index}`;
    if (item.action) menuClicks.set(id, item.action);
    return {
      label: item.label ?? "",
      ...(item.role ? { role: item.role } : {}),
      ...(item.action ? { action: id } : {}),
      ...(item.accelerator ? { accelerator: item.accelerator } : {}),
      ...(item.submenu ? { submenu: toMenuConfig(item.submenu, id) } : {}),
    };
  });
}

/**
 * The menu's three actions are the same three the page can ask for over RPC —
 * an operator reaches them from the menu bar, the page reaches them from a
 * button, and both end in the same function.
 */
installMenu({
  actions: {
    checkForUpdates: () => {
      void updater.check({ interactive: true }).catch((e: unknown) => {
        log.line("warn", "update", `check failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    },
    /**
     * Caught, not dropped. `installCli` refuses a run from a mounted disk image
     * and a password prompt the operator declined (`main/cli-install.ts`), and
     * a menu item whose promise rejects into nothing is an unhandled rejection
     * plus an operator who clicked and saw no result at all.
     *
     * TODO(evan): show the outcome — the path installed, or why not — once
     * there is a dialog to show it in.
     */
    installCli: () => {
      void runCliInstall().catch((e: unknown) => {
        log.line(
          "warn",
          "cli-install",
          `install failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
    },
    // A path is not a URL. `openExternal` takes one, and `file://` is how a
    // directory reaches Finder rather than being treated as a relative link.
    openPath: (path) => Utils.openExternal(pathToFileURL(path).href),
  },
  paths: { home: paths.home, userLogs: Utils.paths.userLogs },
  setApplicationMenu: (menu) => {
    menuClicks.clear();
    ApplicationMenu.setApplicationMenu(toMenuConfig(menu));
  },
});

/**
 * Clicks come back by name, not by closure.
 *
 * The devkit serialises the menu to native as JSON, so an item's `action` is a
 * string it hands back on `application-menu-clicked` — a function cannot cross
 * that boundary at all. `main/menu.ts` keeps the model it can test (a callback
 * per item) and this listener is the other half: the id `toMenuConfig` minted
 * for an item is what comes back, and `menuClicks` is where its callback was
 * left. An id with no entry is a click on a menu that has since been replaced.
 */
ApplicationMenu.on("application-menu-clicked", (event: unknown) => {
  const action = (event as { data?: { action?: unknown } }).data?.action;
  if (typeof action !== "string") return;
  menuClicks.get(action)?.();
});

/**
 * Last, and after the window: the first check runs immediately, and its
 * `app.update` push has to have somewhere to land (`WindowSet.broadcast`
 * reaches open windows only).
 */
updater.start();

/**
 * One observation per listened `<instance>/<bot>`, started without waiting for
 * the page. Not awaited — a roster read per listened box must not hold up the
 * window — and it cannot throw: an uninitialized home reads as "nothing to
 * observe" and says so in the log.
 */
void chatOwner.sync();

/**
 * Last of all, and only on a dev build: the shell's way in
 * (`main/dev-probe.ts`). After the window and its binding, because a probe's
 * first move is usually to script the page; not awaited, because a probe that
 * runs for a minute must not hold the process's startup open behind it.
 */
if (firstCtx !== null && firstWindow !== null) {
  const probeCtx = firstCtx;
  const probeWindow = firstWindow;
  void installDevProbe({
    channel: APP_CHANNEL,
    env: process.env,
    load: (href) => import(href),
    api: {
      dispatch: (name, params, sink) => dispatch(probeCtx, name, params, sink),
      window: probeWindow,
      log,
      env: process.env,
    },
    log,
  });
}
