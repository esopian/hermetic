/**
 * The window's native minimum size.
 *
 * Electrobun 2.0.1 has no minimum-size option on `BrowserWindow`, so the first
 * version of this floor was a `resize` listener that set the frame back after
 * a drag went under it (`main/windows.ts`, `clampFrame`). That works, but it
 * is visibly after the fact: the window shrinks past the minimum and springs
 * back a frame later, which reads as a bug rather than a limit.
 *
 * AppKit has the real thing. `-[NSWindow setContentMinSize:]` makes the window
 * server itself refuse the drag — the edge simply stops — and constrains
 * programmatic `setFrame:` too. The native window lives in this process, and
 * `BrowserWindow.ptr` is its `NSWindow*` (the devkit's own public getter over
 * `ffi.request.getWindowPointer`), so reaching it needs no devkit internals:
 * one `objc_msgSend` through `bun:ffi` and the floor is the window's own.
 *
 * On arm64 an `NSSize` is two doubles, and the AAPCS64 rule for a homogeneous
 * floating-point aggregate of two members is that it is passed in `v0`/`v1` —
 * exactly where two plain `f64` arguments go. That is why `objc_msgSend` can
 * be declared `(ptr, ptr, f64, f64) -> void` for this one selector, and why
 * this module is arm64-macOS only by construction.
 *
 * The objc call is injected so the test can assert the selector and the two
 * doubles without loading `libobjc`, and every failure path is caught: a
 * window with no floor is worse than one with a late floor, but both are much
 * better than an app that cannot open a window at all.
 */
import { dlopen, FFIType, ptr, suffix } from "bun:ffi";
import type { AppLog } from "../log.ts";

/**
 * The selector. `setContentMinSize:` rather than `setMinSize:` because
 * `MIN_FRAME` describes the page: 760 is where the narrow-desktop breakpoints
 * stop applying and 560 is where the toolbar, env strip and a row of cards
 * stop fitting, all of which are measured inside the titlebar, not outside it.
 */
export const MIN_SIZE_SELECTOR = "setContentMinSize:";

/** A size in screen points — `MIN_FRAME`'s shape, without its position. */
export interface Size {
  width: number;
  height: number;
}

/**
 * As much of a native window as this module touches: the devkit's `ptr`
 * getter, which is `NSWindow*` as an integer, or `null` before the window
 * exists.
 */
export interface PointedWindow {
  readonly ptr: number | null;
}

/**
 * The objc call, injected. `target` is the `NSWindow*`; the implementation
 * registers `selector` and sends it with `width` and `height` as an `NSSize`.
 */
export type SendSizeMessage = (target: number, selector: string, width: number, height: number) => void;

export interface ApplyMinimumSizeOptions {
  window: PointedWindow;
  size: Size;
  log: AppLog;
  /** Defaults to the real `objc_msgSend`; tests pass a recorder. */
  send?: SendSizeMessage;
}

let objcSend: SendSizeMessage | null = null;
let objcLoadFailed = false;

/**
 * Opens `libobjc` once per process and returns the sender, or `null` if this
 * runtime has no such library to open (anything that is not macOS).
 *
 * The selector is encoded per call rather than cached: `sel_registerName`
 * interns, so the second call for the same name is a hash lookup, and there is
 * exactly one call per window anyway.
 */
function loadObjcSend(): SendSizeMessage | null {
  if (objcSend !== null) return objcSend;
  if (objcLoadFailed) return null;
  try {
    if (suffix !== "dylib") {
      objcLoadFailed = true;
      return null;
    }
    const objc = dlopen("/usr/lib/libobjc.A.dylib", {
      sel_registerName: { args: [FFIType.cstring], returns: FFIType.ptr },
      objc_msgSend: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.f64, FFIType.f64],
        returns: FFIType.void,
      },
    });
    const encoder = new TextEncoder();
    objcSend = (target, selector, width, height) => {
      const name = encoder.encode(`${selector}\0`);
      const sel = objc.symbols.sel_registerName(ptr(name));
      if (sel === null) throw new Error(`sel_registerName returned null for ${selector}`);
      objc.symbols.objc_msgSend(target, sel, width, height);
    };
    return objcSend;
  } catch (e: unknown) {
    objcLoadFailed = true;
    throw e;
  }
}

/**
 * Gives the window a native floor.
 *
 * Returns whether the floor was applied, which is what the caller uses to
 * decide whether the `resize` clamp still has to stand behind it. Never
 * throws: a missing pointer, a runtime without `bun:ffi` and a platform
 * without `libobjc` all come back as `false` with a `warn` line naming which.
 */
export function applyMinimumSize(options: ApplyMinimumSizeOptions): boolean {
  const { window, size, log } = options;
  const target = window.ptr;
  if (target === null || target === undefined) {
    log.line("warn", "min-size", "window has no native pointer; falling back to the resize clamp");
    return false;
  }
  try {
    const send = options.send ?? loadObjcSend();
    if (send === null) {
      log.line("warn", "min-size", "no objc runtime here; falling back to the resize clamp");
      return false;
    }
    send(target, MIN_SIZE_SELECTOR, size.width, size.height);
    log.line("debug", "min-size", "native minimum size applied", {
      selector: MIN_SIZE_SELECTOR,
      width: size.width,
      height: size.height,
    });
    return true;
  } catch (e: unknown) {
    log.line(
      "warn",
      "min-size",
      `native minimum size failed: ${e instanceof Error ? e.message : String(e)}`,
      { selector: MIN_SIZE_SELECTOR },
    );
    return false;
  }
}
