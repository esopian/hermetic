/**
 * Holds main-process pushes until a window's page is live.
 *
 * A push to the page is a script evaluated in its webview. Under WKWebView a
 * push that lands before the page exists is evaluated against nothing and
 * lost; under CEF (the dev renderer, `electrobun.config.ts`) the browser is
 * created asynchronously, and an evaluation before it exists dereferences a
 * null browser and aborts the whole process. The window's own `focus` event
 * is enough to trigger that: it fires as the window opens, and its
 * `app.visibility` push (`windows.ts`) is sent before CEF has a browser.
 *
 * So a window's pushes are dropped until the page has shown a sign of life,
 * which is the same outcome WKWebView always gave them, made explicit and
 * renderer-independent. Two signs count, whichever comes first: the preload's
 * `dom-ready` event (the top-level `load`), and any request or message from
 * the page — a page that can call the bridge can be called back, and the page
 * mounts and subscribes before its `load` fires, so waiting for `dom-ready`
 * alone could drop the first frames of a stream it opened.
 *
 * The gate never closes again: a reload keeps the browser, and a push during
 * one is the WKWebView case — lost, not fatal.
 *
 * Nothing here imports the devkit, so a test drives it with fake options.
 */
import type { RpcOptions } from "../rpc/bind.ts";

export interface PageGate {
  /** Whether pushes reach the page yet. */
  readonly isOpen: boolean;
  /** The page is live. Idempotent. */
  open(): void;
  /** Counts a push dropped while closed, for the line `open()` logs. */
  dropped(): void;
}

export function createPageGate(onOpen?: (droppedCount: number) => void): PageGate {
  let isOpen = false;
  let droppedCount = 0;
  return {
    get isOpen() {
      return isOpen;
    },
    open() {
      if (isOpen) return;
      isOpen = true;
      onOpen?.(droppedCount);
    },
    dropped() {
      droppedCount += 1;
    },
  };
}

type Handlers = Record<string, (params: never) => unknown>;

function opening(handlers: Handlers, gate: PageGate): Handlers {
  const wrapped: Handlers = {};
  for (const [name, handler] of Object.entries(handlers)) {
    wrapped[name] = (params: never) => {
      gate.open();
      return handler(params);
    };
  }
  return wrapped;
}

/**
 * The same RPC options, with every request and message handler opening the
 * gate before it runs.
 */
export function openOnInbound(options: RpcOptions, gate: PageGate): RpcOptions {
  const { requests, messages } = options.handlers;
  return {
    ...options,
    handlers: {
      requests: opening(requests, gate),
      ...(messages === undefined ? {} : { messages: opening(messages, gate) }),
    },
  };
}
