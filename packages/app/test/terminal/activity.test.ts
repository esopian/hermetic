/**
 * The OSC 133 activity parser (`src/terminal/activity.ts`) on a real headless
 * xterm: transitions, nonce pinning, a forged marker, `cmd` carrying `;n=`,
 * the detachable exemption and background jobs.
 */
import { describe, expect, test } from "bun:test";
import type { ShellMarker } from "@hermetic/core/shared";
import {
  type Activity,
  ShellActivity,
  commandLabel,
  createHeadlessTerminal,
  readCursorLine,
} from "../../src/terminal/activity.ts";

const NONCE = "a1b2c3d4e5f6a7b8c9";
const A = (opts: { n?: string; pre?: 0 | 1; jobs?: number } = {}) =>
  `\x1b]133;A;hermetic=1;n=${opts.n ?? NONCE};pre=${opts.pre ?? 1};jobs=${opts.jobs ?? 0}\x07`;
const C = (cmd: string, n = NONCE) => `\x1b]133;C;n=${n};cmd=${cmd}\x07`;
const D = (exit: number, n = NONCE) => `\x1b]133;D;${exit};n=${n}\x07`;

function session() {
  const term = createHeadlessTerminal(80, 24);
  const activity = new ShellActivity(term);
  const changes: Activity[] = [];
  const markers: ShellMarker[] = [];
  activity.onChange((a) => changes.push(a));
  activity.onMarker((m) => markers.push(m));
  // xterm parses asynchronously; the callback is when this chunk has been seen.
  const feed = (data: string) => new Promise<void>((resolve) => term.write(data, resolve));
  return { term, activity, changes, markers, feed };
}

describe("ShellActivity", () => {
  test("unknown until the first prompt, then idle → busy → idle", async () => {
    const s = session();
    expect(s.activity.activity).toEqual({ state: "unknown" });
    expect(s.activity.nonce).toBeNull();

    await s.feed(`motd\r\n${A()}$ `);
    expect(s.activity.nonce).toBe(NONCE);
    expect(s.activity.activity).toEqual({ state: "idle" });

    await s.feed(`sleep 4\r\n${C("sleep 4")}`);
    expect(s.activity.activity).toEqual({ state: "busy", cmd: "sleep 4" });

    await s.feed(`${D(0)}${A()}$ `);
    expect(s.activity.activity).toEqual({ state: "idle" });
    expect(s.changes.map((c) => c.state)).toEqual(["idle", "busy", "idle"]);
    expect(s.markers.map((m) => m.kind)).toEqual(["A", "C", "D", "A"]);
    expect(s.markers[2]?.exit).toBe(0);
  });

  test("a marker with another nonce is ignored, even one claiming idle", async () => {
    const s = session();
    await s.feed(`${A()}$ `);
    await s.feed(C("make all"));
    expect(s.activity.activity.state).toBe("busy");

    // A running command prints a fake prompt marker to look idle.
    await s.feed(`${A({ n: "0000" })}${D(0, "0000")}`);
    expect(s.activity.activity).toEqual({ state: "busy", cmd: "make all" });
    // Nor can it re-pin: the nonce stays the first prompt's.
    expect(s.activity.nonce).toBe(NONCE);
    // A marker with no nonce at all is just as foreign.
    await s.feed("\x1b]133;A;pre=1;jobs=0\x07");
    expect(s.activity.activity.state).toBe("busy");
    expect(s.markers.map((m) => m.kind)).toEqual(["A", "C"]);
  });

  test("nothing is believed before the first prompt pins a nonce", async () => {
    const s = session();
    await s.feed(C("rm -rf"));
    expect(s.activity.activity).toEqual({ state: "unknown" });
    expect(s.activity.nonce).toBeNull();
    expect(s.markers).toEqual([]);
  });

  test("a cmd containing `;n=` neither re-pins nor rejects", async () => {
    const s = session();
    await s.feed(A());
    await s.feed(C("echo a;n=forged;jobs=9"));
    expect(s.activity.activity).toEqual({ state: "busy", cmd: "echo a;n=forged;jobs=9" });
    expect(s.activity.nonce).toBe(NONCE);
  });

  test("pre=0 is unknown; background jobs are busy", async () => {
    const s = session();
    await s.feed(A({ jobs: 2 }));
    expect(s.activity.activity).toEqual({ state: "busy", jobs: 2 });
    expect(s.activity.busyForQuit()).toEqual({ busy: true, label: "2 background jobs" });

    await s.feed(A({ jobs: 1 }));
    expect(s.activity.busyForQuit()).toEqual({ busy: true, label: "1 background job" });

    await s.feed(A({ pre: 0 }));
    expect(s.activity.activity).toEqual({ state: "unknown" });
    expect(s.activity.busyForQuit()).toEqual({ busy: false });
  });

  test("busyForQuit: tmux and screen are exempt, other commands are named", async () => {
    const s = session();
    await s.feed(A());
    expect(s.activity.busyForQuit()).toEqual({ busy: false });

    await s.feed(C("apt upgrade"));
    expect(s.activity.busyForQuit()).toEqual({ busy: true, label: "apt upgrade" });

    await s.feed(C("tmux new"));
    expect(s.activity.busyForQuit()).toEqual({ busy: false });
    await s.feed(C("sudo screen"));
    expect(s.activity.busyForQuit()).toEqual({ busy: false });

    // A first word that is not a program name is not shown at all.
    await s.feed(C("TOKEN=abc ./run"));
    expect(s.activity.busyForQuit()).toEqual({ busy: true });
  });

  test("commandLabel keeps an argument only when it reads as a word", () => {
    expect(commandLabel("apt upgrade")).toBe("apt upgrade");
    expect(commandLabel("export TOKEN=x")).toBe("export");
    expect(commandLabel("sudo apt")).toBe("apt");
    expect(commandLabel("Secret123")).toBeNull();
    expect(commandLabel(undefined)).toBeNull();
  });

  test("readCursorLine reads the line under the cursor", async () => {
    const s = session();
    await s.feed("one\r\ntwo\r\nContinue? [Y/n] ");
    // Trailing cells nothing wrote are trimmed; the space the prompt printed is not.
    expect(readCursorLine(s.term)).toBe("Continue? [Y/n] ");
  });

  test("dispose stops listening", async () => {
    const s = session();
    s.activity.dispose();
    await s.feed(A());
    expect(s.activity.nonce).toBeNull();
  });
});
