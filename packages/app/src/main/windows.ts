/**
 * The windows this process has open, and what closing one means.
 * There is one window today. The set exists anyway because the things that
 * belong to a window — its RPC binding, the streams it opened, the messages it
 * is pushed — have to belong to *something*, and a module-level pair of
 * variables is the version of that which quietly breaks the day a second window
 * appears. A push goes to every open window (`broadcast`); a close drops that
 * window's streams and nothing else.
 *
 * The window factory is injected. Constructing a `BrowserWindow` means
 * importing `electrobun/bun`, which throws outside a built app, so the one
 * import lives in `main/index.ts` and this module is written against what it
 * hands back.
 */
import type { SendMessage } from "../rpc/bind.ts";
import type { WebviewMessages } from "../rpc/schema.ts";

/** A window's position and size in screen points, as the resize event reports it. */
export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The smallest window the dashboard is laid out for, as a content size. The
 * width is one pixel above the header's narrow breakpoint (`@media (max-width:
 * 1100px)` in `packages/ui/src/styles/polish.css`), so the fleet / chat /
 * settings navigation never collapses into its narrow form; the two must move
 * together. Below 560 tall the fleet toolbar, env strip and one row of cards
 * no longer fit together.
 *
 * These are the numbers `main/min-size.ts` hands AppKit as the window's
 * content minimum, and the numbers `clampFrame` backstops with if that call
 * did not take.
 */
export const MIN_FRAME = { width: 1101, height: 560 } as const;

/** The size a new window opens at: the desktop layout the UI brief designs for. */
export const DEFAULT_FRAME = { width: 1440, height: 900 } as const;

/**
 * The frame to set back when a resize went under the minimum, or `null` when
 * the resize is fine. Pure, so the test can cover the corners without a
 * window: a shrink on one axis grows only that axis, the position is kept.
 *
 * The backstop half of the floor. When `applyMinimumSize` got the native
 * minimum onto the window, the drag never produces an under-minimum resize in
 * the first place and this never runs; it is here for the window whose native
 * call failed, where a frame that springs back is still better than a
 * dashboard squashed to nothing.
 */
export function clampFrame(frame: Frame): Frame | null {
  const width = Math.max(frame.width, MIN_FRAME.width);
  const height = Math.max(frame.height, MIN_FRAME.height);
  if (width === frame.width && height === frame.height) return null;
  return { x: frame.x, y: frame.y, width, height };
}

/** As much of a native window as this module touches. */
export interface ManagedWindow {
  close(): void;
  setFrame(x: number, y: number, width: number, height: number): void;
  /**
   * `close` is the only event subscribed to here: it is the window telling us
   * it *has* gone, which is when its streams stop being anybody's.
   *
   * Deliberately not `will-close`, which is a question rather than an
   * announcement: the close guard (`main/close-guard.ts`) answers it with
   * `allow: false` whenever an op is running, and a window that is still on
   * screen because the operator said "don't quit" must not have had its RPC
   * binding torn out from under it.
   */
  on(event: string, listener: (...args: unknown[]) => void): void;
}

/** What Electrobun hands a `resize` listener: `{ data: { id, x, y, width, height } }`. */
interface ResizeEvent {
  data: Frame;
}

function isResizeEvent(event: unknown): event is ResizeEvent {
  if (typeof event !== "object" || event === null) return false;
  const data = (event as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return false;
  const frame = data as Partial<Frame>;
  return (
    typeof frame.x === "number" &&
    typeof frame.y === "number" &&
    typeof frame.width === "number" &&
    typeof frame.height === "number"
  );
}

export interface OpenedWindow {
  window: ManagedWindow;
  /** Pushes at this window's page; `broadcast` calls one per open window. */
  send: SendMessage;
  /** The binding's cleanup — `RpcBinding.close`, which drops this window's streams. */
  close(): void;
}

/** Builds a window and its binding together, because the binding needs the page. */
export type WindowFactory = () => OpenedWindow;

export interface WindowSetOptions {
  open: WindowFactory;
}

export interface WindowSet {
  /** Opens one, registers its cleanup, and hands it back for the caller to keep. */
  open(): OpenedWindow;
  broadcast<K extends keyof WebviewMessages>(name: K, payload: WebviewMessages[K]): void;
  /** How many are open. The test's way of seeing the set shrink; also the quit check. */
  readonly size: number;
  /** Closes every one, cleanup included. What quitting means for the windows. */
  closeAll(): void;
}

export function createWindows(options: WindowSetOptions): WindowSet {
  const open = new Set<OpenedWindow>();

  /**
   * Cleanup, at most once per window.
   *
   * Membership is the guard rather than a flag on the entry: `closeAll` and the
   * window's own `close` both arrive when the app quits, in an order neither of
   * them decides, and closing a stream registry twice would be harmless only
   * for as long as `close()` stays a `closeAll()`.
   */
  const drop = (entry: OpenedWindow): void => {
    if (!open.delete(entry)) return;
    entry.close();
  };

  return {
    open() {
      const entry = options.open();
      open.add(entry);
      entry.window.on("close", () => drop(entry));
      /**
       * The page's only honest source of visibility (`app.visibility` in
       * `rpc/schema.ts`). Sent per window rather than broadcast: focus is a
       * fact about *this* window, and broadcasting it would tell a background
       * window it was on screen the moment another one came forward.
       */
      entry.window.on("focus", () => entry.send("app.visibility", { visible: true }));
      entry.window.on("blur", () => entry.send("app.visibility", { visible: false }));
      /**
       * The backstop under the native floor (`main/min-size.ts`). A window
       * whose `setContentMinSize:` took hold never reports a resize under
       * `MIN_FRAME` at all — AppKit refuses the drag at the edge — so this
       * listener costs that window nothing and fires for the one whose
       * native call failed, or whose frame lands a fraction under the
       * minimum. Kept unconditional because the alternative is a window with
       * no floor whenever the native path is the thing that broke: one
       * `setFrame` per offending resize, and the resize that causes is at the
       * minimum and clamps to nothing.
       */
      entry.window.on("resize", (event) => {
        if (!isResizeEvent(event)) return;
        const clamped = clampFrame(event.data);
        if (clamped !== null)
          entry.window.setFrame(clamped.x, clamped.y, clamped.width, clamped.height);
      });
      return entry;
    },
    broadcast(name, payload) {
      // Over a copy: a send to a page that has already gone can bring its
      // `will-close` back synchronously, which would mutate the set being
      // iterated.
      for (const entry of [...open]) entry.send(name, payload);
    },
    get size() {
      return open.size;
    },
    closeAll() {
      for (const entry of [...open]) {
        drop(entry);
        entry.window.close();
      }
    },
  };
}
