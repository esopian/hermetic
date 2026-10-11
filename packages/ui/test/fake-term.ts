/**
 * A DOM-free stand-in for the terminal screen (issue #18).
 *
 * happy-dom has no canvas and no layout, so xterm cannot run under it. The
 * Terminal section only ever talks to a `TermView` (`xterm-adapter.ts`), and
 * this is one: it keeps everything written as text (escape sequences
 * stripped, so a test reads what an operator would), types on cue, and can
 * fire a title or a bell. Write callbacks land on a microtask, as xterm's
 * parse callbacks land after the write call returns.
 */
import {
  setTermFactory,
  type TermDisposable,
  type TermView,
} from "../src/components/agent/xterm-adapter.ts";

type Listener<T> = (value: T) => void;

function listen<T>(set: Set<Listener<T>>, cb: Listener<T>): TermDisposable {
  set.add(cb);
  return { dispose: () => set.delete(cb) };
}

/** What a terminal would show, roughly: CSI and OSC sequences out, CR dropped. */
export function plainText(raw: string): string {
  // biome-ignore-start lint/suspicious/noControlCharactersInRegex: stripping escape sequences is the point
  return raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/\r/g, "");
  // biome-ignore-end lint/suspicious/noControlCharactersInRegex: see above
}

export class FakeTermView implements TermView {
  static instances: FakeTermView[] = [];

  static last(): FakeTermView {
    const view = FakeTermView.instances[FakeTermView.instances.length - 1];
    if (view === undefined) throw new Error("no terminal screen has been made");
    return view;
  }

  raw = "";
  cols = 80;
  rows = 24;
  resets = 0;
  disposed = false;
  el: HTMLElement | null = null;
  /** What `proposeSize` answers: the pane's size, as fit would measure it. */
  size: { cols: number; rows: number } | null = { cols: 100, rows: 30 };
  private readonly data = new Set<Listener<string>>();
  private readonly binary = new Set<Listener<string>>();
  private readonly title = new Set<Listener<string>>();
  private readonly bell = new Set<Listener<void>>();
  private readonly decoder = new TextDecoder();

  open(el: HTMLElement): void {
    this.el = el;
    // Something focusable inside, as xterm's helper textarea is.
    const input = document.createElement("textarea");
    input.setAttribute("aria-label", "Terminal input");
    el.appendChild(input);
  }

  write(data: Uint8Array | string, done?: () => void): void {
    this.raw += typeof data === "string" ? data : this.decoder.decode(data);
    if (done) queueMicrotask(done);
  }

  reset(): void {
    this.raw = "";
    this.resets++;
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  proposeSize(): { cols: number; rows: number } | null {
    return this.size;
  }

  focus(): void {
    this.el?.querySelector("textarea")?.focus();
  }

  onData(cb: Listener<string>): TermDisposable {
    return listen(this.data, cb);
  }

  onBinary(cb: Listener<string>): TermDisposable {
    return listen(this.binary, cb);
  }

  onTitle(cb: Listener<string>): TermDisposable {
    return listen(this.title, cb);
  }

  onBell(cb: () => void): TermDisposable {
    return listen(this.bell, cb);
  }

  dispose(): void {
    this.disposed = true;
  }

  /* ── the test's side ── */

  /** The screen as text. */
  text(): string {
    return plainText(this.raw);
  }

  /** Keystrokes, as xterm's `onData` would report them. */
  type(data: string): void {
    for (const cb of [...this.data]) cb(data);
  }

  fireTitle(title: string): void {
    for (const cb of [...this.title]) cb(title);
  }

  ring(): void {
    for (const cb of [...this.bell]) cb();
  }
}

/** Every screen made from now on is a `FakeTermView`. Returns the restore. */
export function installFakeTerms(): () => void {
  FakeTermView.instances = [];
  setTermFactory(async () => {
    const view = new FakeTermView();
    FakeTermView.instances.push(view);
    return view;
  });
  return () => {
    setTermFactory(null);
    FakeTermView.instances = [];
  };
}
