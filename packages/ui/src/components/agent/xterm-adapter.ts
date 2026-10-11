/**
 * The terminal screen, as the little the Terminal section needs from it
 * (issue #18).
 *
 * The section talks to a `TermView`, never to xterm: happy-dom has no canvas
 * and no layout, so a flow test hands in a DOM-free stand-in
 * (`setTermFactory`) that keeps what was written as text and types on cue.
 * In the app the factory is `xtermView`: `@xterm/xterm` with the DOM renderer
 * (D7 — no WebGL or canvas addon), `addon-fit` for the size and
 * `addon-web-links` for links, which go out through `app.openExternal`.
 *
 * xterm is imported on first use rather than at module scope, so a page that
 * never opens a terminal never parses it, and a test that imports the section
 * never evaluates it.
 */

export interface TermDisposable {
  dispose(): void;
}

export interface TermView {
  /** Mount into `el`. Called once, before anything else. */
  open(el: HTMLElement): void;
  /** Parse bytes (or text); `done` fires once xterm has parsed them — where acks come from. */
  write(data: Uint8Array | string, done?: () => void): void;
  /** Back to a blank screen and empty scrollback, before a snapshot. */
  reset(): void;
  resize(cols: number, rows: number): void;
  /** The size that fills the mounted element, or null when it cannot be measured. */
  proposeSize(): { cols: number; rows: number } | null;
  readonly cols: number;
  readonly rows: number;
  focus(): void;
  /** Keystrokes and pastes as text (xterm `onData`). */
  onData(cb: (data: string) => void): TermDisposable;
  /** Byte-valued input (xterm `onBinary`: mouse reports and the like). */
  onBinary(cb: (data: string) => void): TermDisposable;
  /** OSC 0/2, raw; the caller sanitizes. */
  onTitle(cb: (title: string) => void): TermDisposable;
  onBell(cb: () => void): TermDisposable;
  dispose(): void;
}

export interface TermViewOptions {
  /** A link the operator clicked (web-links, or the check-mode auth URL). */
  onLink: (url: string) => void;
}

export type TermFactory = (options: TermViewOptions) => Promise<TermView>;

/**
 * The terminal's own ground, in both themes (ui-brief "Terminal"): it is a
 * screen, not a surface of the app. Cursor and selection are the app's
 * accent and selection tokens, read when the screen is made.
 */
export const TERM_GROUND = "#0a0a09";
export const TERM_FG = "#d8d5cc";
const TERM_FONT = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

function token(name: string, fallback: string): string {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === "" ? fallback : value;
}

/**
 * xterm's `linkHandler` for OSC 8 hyperlinks: every activation goes to
 * `onLink` (`app.openExternal`), and xterm itself refuses anything but
 * http(s) before asking (`allowNonHttpProtocols: false`).
 */
export function linkHandlerFor(onLink: (url: string) => void): {
  activate: (event: MouseEvent, uri: string) => void;
  allowNonHttpProtocols: false;
} {
  return {
    activate: (_event, uri) => onLink(uri),
    allowNonHttpProtocols: false,
  };
}

/** The real screen: xterm 5.5, DOM renderer, fit and web-links. */
export const xtermView: TermFactory = async ({ onLink }) => {
  const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
    import("@xterm/addon-web-links"),
  ]);
  const term = new Terminal({
    fontFamily: TERM_FONT,
    fontSize: 12.5,
    lineHeight: 1.25,
    cursorBlink: true,
    scrollback: 5000,
    // Option is Option on a Mac keyboard (é, ñ); Meta would steal them.
    macOptionIsMeta: false,
    // OSC 8 hyperlinks. With no handler xterm asks `confirm()` and calls
    // `window.open`, which would leave the app without `app.openExternal`'s
    // scheme and credential checks. Same door as web-links, http(s) only.
    linkHandler: linkHandlerFor(onLink),
    theme: {
      background: TERM_GROUND,
      foreground: TERM_FG,
      cursor: token("--acc", "#ff5a1f"),
      cursorAccent: TERM_GROUND,
      selectionBackground: token("--sel", "#22211e"),
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((_event, uri) => onLink(uri)));
  // OSC 52 is the remote writing this Mac's clipboard. Ignored in v1: claim
  // the sequence so nothing else ever acts on it.
  term.parser.registerOscHandler(52, () => true);
  return {
    open: (el) => term.open(el),
    write: (data, done) => term.write(data, done),
    reset: () => term.reset(),
    resize: (cols, rows) => term.resize(cols, rows),
    proposeSize: () => {
      const dims = fit.proposeDimensions();
      if (dims === undefined || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return null;
      return { cols: dims.cols, rows: dims.rows };
    },
    get cols() {
      return term.cols;
    },
    get rows() {
      return term.rows;
    },
    focus: () => term.focus(),
    onData: (cb) => term.onData(cb),
    onBinary: (cb) => term.onBinary(cb),
    onTitle: (cb) => term.onTitleChange(cb),
    onBell: (cb) => term.onBell(cb),
    dispose: () => term.dispose(),
  };
};

let factory: TermFactory = xtermView;

/** Make every screen from now on with `next`; `null` puts xterm back. Tests only. */
export function setTermFactory(next: TermFactory | null): void {
  factory = next ?? xtermView;
}

export function createTermView(options: TermViewOptions): Promise<TermView> {
  return factory(options);
}
