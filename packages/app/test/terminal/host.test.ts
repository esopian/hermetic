/**
 * The terminal host (`terminal/host.ts`, `terminal/session.ts`): caps, the
 * open path's refusals, the fixture's no-spawn guarantee, End's escalation,
 * shutdown, the ACL-denied exit, index reuse and view gating.
 *
 * Over the real fixture `Hermetic`, so the agent states, core's `ssh` argv
 * and the inbox rows are core's own. The PTY is a fake that does what it is
 * told (`FakePty`), except in the fixture cases, which run the canned shell.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { isHermeticError, openHermetic } from "@hermetic/core";
import type { Hermetic, Notification, TailscalePreflight } from "@hermetic/core";
import { memoryLog } from "../../src/log.ts";
import type { TerminalChannel, TerminalFrame } from "../../src/terminal/channel.ts";
import { gateTerminal, sshTarget } from "../../src/terminal/gate.ts";
import { TerminalHost } from "../../src/terminal/host.ts";
import {
  DataListeners,
  type PtyExit,
  type PtyLike,
  type PtySignal,
  type PtySpawner,
} from "../../src/terminal/pty.ts";
import { fixturePtySpawner } from "../../src/terminal/pty-fixture.ts";
import { endedByShellExit, exitReason } from "../../src/terminal/session.ts";
import { realTimers, type Timers } from "../../src/terminal/timers.ts";
import { testHome } from "../home.ts";
import { FakeTimers } from "./fake-timers.ts";

const BINARY = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

/** A PTY that records what it was sent and exits when told — or on a hangup, if `hupExits`. */
class FakePty implements PtyLike {
  readonly pid = 4242;
  readonly writes: string[] = [];
  readonly signals: PtySignal[] = [];
  readonly sizes: [number, number][] = [];
  closed = 0;
  hupExits = true;
  readonly exited: Promise<PtyExit>;
  private readonly listeners = new DataListeners();
  private resolveExit: (exit: PtyExit) => void = () => {};

  constructor(readonly argv: string[]) {
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  write(data: string | Uint8Array): void {
    this.writes.push(typeof data === "string" ? data : new TextDecoder().decode(data));
  }
  resize(cols: number, rows: number): void {
    this.sizes.push([cols, rows]);
  }
  signalGroup(sig: PtySignal): void {
    this.signals.push(sig);
    if (sig === "SIGKILL" || (sig === "SIGHUP" && this.hupExits)) this.end({ code: null, signal: sig });
  }
  close(): void {
    this.closed++;
  }
  onData(cb: (bytes: Uint8Array) => void): void {
    this.listeners.add(cb);
  }
  emit(text: string): void {
    this.listeners.emit(new TextEncoder().encode(text));
  }
  end(exit: PtyExit): void {
    this.resolveExit(exit);
  }
}

function fakeSpawner(): { ptys: FakePty[]; spawn: PtySpawner } {
  const ptys: FakePty[] = [];
  return {
    ptys,
    spawn: (argv) => {
      const pty = new FakePty(argv);
      ptys.push(pty);
      return pty;
    },
  };
}

/** A preflight that passes, on the tailnet core's fixture hosts live in. */
function running(tailnet: string | null): TailscalePreflight {
  return {
    ok: true,
    installed: true,
    running: true,
    backend_state: "Running",
    tailnet,
    cert_domains: [],
    hostname: "laptop",
    addresses: [],
    binary: BINARY,
    problem: null,
  };
}

interface Harness {
  hermetic: Hermetic;
  host: TerminalHost;
  ptys: FakePty[];
  timers: FakeTimers;
  log: ReturnType<typeof memoryLog>;
  flushes: { count: number };
  preflights: { count: number };
  tailnet: string | null;
}

async function harness(
  options: {
    preflight?: (tailnet: string | null) => TailscalePreflight;
    spawner?: PtySpawner;
    fixture?: boolean;
    timers?: Timers;
    openExternal?: (argv: string[]) => Promise<unknown>;
  } = {},
): Promise<Harness> {
  const hermetic = await openHermetic({ fixture: true, home: testHome("hermetic-terminal-host-") });
  const { tailnet } = sshTarget(await hermetic.ssh({ name: "atlas" }));
  const { ptys, spawn } = fakeSpawner();
  const timers = new FakeTimers();
  const log = memoryLog();
  const flushes = { count: 0 };
  const preflights = { count: 0 };
  let id = 0;
  const host = new TerminalHost({
    hermetic: () => hermetic,
    spawner: options.spawner ?? spawn,
    fixture: options.fixture ?? false,
    ...(options.fixture
      ? {}
      : {
          preflight: async () => {
            preflights.count++;
            return (options.preflight ?? running)(tailnet);
          },
        }),
    flush: () => void flushes.count++,
    timers: options.timers ?? timers,
    log,
    newId: () => `s${++id}`,
    ...(options.openExternal !== undefined ? { openExternal: options.openExternal } : {}),
  });
  return { hermetic, host, ptys, timers, log, flushes, preflights, tailnet };
}

/** Whatever a call threw, as a value. */
async function rejection(
  run: Promise<unknown>,
): Promise<{ code: string; details?: Record<string, unknown> }> {
  try {
    await run;
  } catch (e) {
    if (isHermeticError(e)) return { code: e.code, ...(e.details ? { details: e.details } : {}) };
    throw e;
  }
  throw new Error("expected a refusal; the call resolved");
}

/** A channel that keeps every frame, with the output decoded. */
function recorder(): TerminalChannel & { frames: TerminalFrame[]; text(): string } {
  const frames: TerminalFrame[] = [];
  return {
    frames,
    send: (frame) => void frames.push(frame),
    text: () =>
      frames
        .map((f) =>
          f.event === "data" || f.event === "snapshot"
            ? Buffer.from(f.data.b64, "base64").toString("utf8")
            : "",
        )
        .join(""),
  };
}

async function until(done: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const open = (h: Harness, name = "atlas") => h.host.open({ name, cols: 80, rows: 24 });

function terminalRows(all: Notification[], sessionId: string): Notification[] {
  return all.filter((n) => n.source === "terminal" && n.ref === sessionId);
}

async function inbox(h: Harness, sessionId: string): Promise<Notification[]> {
  const { notifications } = await h.hermetic.notifications.list({ view: "all", limit: 500 });
  return terminalRows(notifications, sessionId);
}

describe("open", () => {
  test("runs core's argv with the preflight's binary in place of tailscale", async () => {
    const h = await harness();
    const argv = await h.hermetic.ssh({ name: "atlas" });
    const opened = await open(h);
    expect(h.ptys[0]?.argv).toEqual([BINARY, ...argv.slice(1)]);
    expect(opened).toMatchObject({
      session_id: "s1",
      index: 1,
      name: "atlas",
      command: argv.join(" "),
    });
    const line = h.log.lines.find((l) => l.includes("session opened")) ?? "";
    expect(line).toContain('name="atlas"');
    expect(line).toContain('session="s1"');
    expect(line).toContain("cols=80");
    expect(line).toContain("rows=24");
  });

  test("a stopped agent is refused before the preflight runs", async () => {
    const h = await harness();
    const refused = await rejection(open(h, "juniper"));
    expect(refused.code).toBe("TERMINAL_AGENT_OFF");
    expect(refused.details).toMatchObject({ status: "stopped" });
    expect(h.preflights.count).toBe(0);
    expect(h.ptys).toEqual([]);
  });

  test("Tailscale not installed", async () => {
    const h = await harness({
      preflight: (t) => ({
        ...running(t),
        ok: false,
        installed: false,
        running: false,
        backend_state: null,
        binary: null,
      }),
    });
    expect((await rejection(open(h))).code).toBe("TAILSCALE_MISSING");
    expect(h.ptys).toEqual([]);
  });

  test("Tailscale not running, with its backend state", async () => {
    const h = await harness({
      preflight: (t) => ({ ...running(t), ok: false, running: false, backend_state: "Stopped" }),
    });
    const refused = await rejection(open(h));
    expect(refused.code).toBe("TAILSCALE_STOPPED");
    expect(refused.details).toMatchObject({ backend_state: "Stopped" });
    expect(h.ptys).toEqual([]);
  });

  test("this Mac on another tailnet", async () => {
    const h = await harness({ preflight: (t) => ({ ...running(t), tailnet: "elsewhere.ts.net" }) });
    const refused = await rejection(open(h));
    expect(refused.code).toBe("TAILSCALE_WRONG_TAILNET");
    expect(refused.details).toMatchObject({
      local_tailnet: "elsewhere.ts.net",
      fleet_tailnet: h.tailnet,
    });
    expect(h.ptys).toEqual([]);
  });

  test("the gate reads the fleet's tailnet off the host core resolved", () => {
    expect(sshTarget(["tailscale", "ssh", "hermes@fx-atlas.acme.ts.net"])).toEqual({
      host: "fx-atlas.acme.ts.net",
      tailnet: "acme.ts.net",
    });
    expect(
      gateTerminal(running("acme.ts.net"), ["tailscale", "ssh", "hermes@fx-atlas.acme.ts.net"]),
    ).toBe(BINARY);
  });
});

describe("caps", () => {
  test("three per agent; the fourth is TERMINAL_LIMIT", async () => {
    const h = await harness();
    for (let i = 0; i < 3; i++) await open(h);
    const refused = await rejection(open(h));
    expect(refused.code).toBe("TERMINAL_LIMIT");
    expect(refused.details).toMatchObject({ scope: "agent", limit: 3 });
    // Another agent is not affected.
    expect((await open(h, "corvid")).index).toBe(1);
  });

  test("eight per app", async () => {
    const h = await harness();
    for (const name of ["atlas", "atlas", "atlas", "corvid", "corvid", "corvid", "fathom", "fathom"]) {
      await open(h, name);
    }
    const refused = await rejection(open(h, "granite"));
    expect(refused.code).toBe("TERMINAL_LIMIT");
    expect(refused.details).toMatchObject({ scope: "app", limit: 8 });
  });

  test("opens in flight count, so two racing for the last slot cannot both win", async () => {
    const h = await harness();
    await open(h);
    await open(h);
    const results = await Promise.allSettled([open(h), open(h)]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  });

  test("an ended session holds its tab, not its slot; the next open takes its index", async () => {
    const h = await harness();
    await open(h);
    await open(h);
    const third = await open(h);
    h.ptys[1]?.end({ code: 0, signal: null });
    await until(() => h.host.list("atlas").some((r) => r.state === "ended"));
    expect(h.host.list("atlas").map((r) => [r.index, r.state])).toEqual([
      [1, "live"],
      [2, "ended"],
      [3, "live"],
    ]);
    const fourth = await open(h);
    expect(fourth.index).toBe(2);
    expect(h.host.list("atlas").map((r) => r.session_id)).toEqual([
      "s1",
      fourth.session_id,
      third.session_id,
    ]);
  });

  test("a closed session's index is reused", async () => {
    const h = await harness();
    await open(h);
    const second = await open(h);
    await h.host.close(second.session_id);
    expect((await open(h)).index).toBe(2);
  });
});

describe("close and stopAll", () => {
  test("End hangs up the group, kills it 2 s later, then closes the PTY", async () => {
    const h = await harness();
    const { session_id } = await open(h);
    const pty = h.ptys[0];
    if (pty === undefined) throw new Error("no pty");
    pty.hupExits = false;
    const channel = recorder();
    h.host.attach(session_id, channel);

    const closing = h.host.close(session_id);
    expect(pty.signals).toEqual(["SIGHUP"]);
    h.timers.advance(1999);
    expect(pty.signals).toEqual(["SIGHUP"]);
    expect(pty.closed).toBe(0);
    h.timers.advance(1);
    expect(pty.signals).toEqual(["SIGHUP", "SIGKILL"]);
    expect(pty.closed).toBe(1);

    expect(await closing).toEqual({ closed: true });
    expect(h.host.list()).toEqual([]);
    const last = channel.frames[channel.frames.length - 1];
    expect(last).toEqual({ event: "exit", data: { code: null, signal: "SIGKILL", reason: "closed" } });
    expect(h.log.lines.some((l) => l.includes("session ended") && l.includes('reason="closed"'))).toBe(
      true,
    );
  });

  test("a hangup that works ends it without the kill", async () => {
    const h = await harness();
    const { session_id } = await open(h);
    await h.host.close(session_id);
    expect(h.ptys[0]?.signals).toEqual(["SIGHUP"]);
    expect(h.timers.size).toBe(0);
  });

  test("closing an unknown session is not an error", async () => {
    const h = await harness();
    expect(await h.host.close("nope")).toEqual({ closed: false });
  });

  test("stopAll hangs up every live session synchronously and tells every attach", async () => {
    const h = await harness();
    const a = await open(h);
    await open(h, "corvid");
    for (const pty of h.ptys) pty.hupExits = false;
    const channel = recorder();
    h.host.attach(a.session_id, channel);

    h.host.stopAll();

    for (const pty of h.ptys) {
      expect(pty.signals).toEqual(["SIGHUP"]);
      expect(pty.closed).toBe(1);
    }
    expect(channel.frames[channel.frames.length - 1]).toEqual({
      event: "exit",
      data: { code: null, signal: "SIGHUP", reason: "shutdown" },
    });
  });
});

describe("exit reasons", () => {
  test("a 255 within 10 s with the policy's words is acl_denied", async () => {
    const h = await harness();
    const { session_id } = await open(h);
    h.ptys[0]?.emit("tailscale: tailnet policy does not permit you to SSH to this node\r\n");
    h.ptys[0]?.end({ code: 255, signal: null });
    await until(() => h.host.list()[0]?.state === "ended");
    expect(h.host.list()[0]?.exit).toEqual({ code: 255, signal: null, reason: "acl_denied" });
    expect(h.host.list()[0]?.session_id).toBe(session_id);
  });

  test("the same exit after 10 s is a disconnect", async () => {
    const h = await harness();
    await open(h);
    h.ptys[0]?.emit("tailscale: tailnet policy does not permit you to SSH to this node\r\n");
    h.timers.advance(10_000);
    h.ptys[0]?.end({ code: 255, signal: null });
    await until(() => h.host.list()[0]?.state === "ended");
    expect(h.host.list()[0]?.exit?.reason).toBe("disconnected");
  });

  test("the rules", () => {
    const base = { requested: null, signal: null, ranMs: 100, tail: () => "" };
    expect(exitReason({ ...base, code: 0 })).toBe("exited");
    // The remote shell's own status: `exit 1`, or Ctrl-D after a failed command.
    expect(exitReason({ ...base, code: 1 })).toBe("exited");
    // ssh's own failure status, unless the operator typed `exit 255`.
    expect(exitReason({ ...base, code: 255, shellExit: true })).toBe("exited");
    expect(exitReason({ ...base, code: null, signal: null })).toBe("disconnected");
    expect(exitReason({ ...base, code: null, signal: "SIGHUP" })).toBe("disconnected");
    expect(exitReason({ ...base, code: 255 })).toBe("disconnected");
    expect(exitReason({ ...base, code: 255, tail: () => "user is not allowed to ssh" })).toBe(
      "acl_denied",
    );
    expect(
      exitReason({ ...base, requested: "closed", code: 255, tail: () => "not allowed to ssh" }),
    ).toBe("closed");
    expect(exitReason({ ...base, requested: "shutdown", code: 0 })).toBe("shutdown");
  });

  test("a shell exit is read off the last command line the integration saw start", () => {
    expect(endedByShellExit({ state: "busy", cmd: "exit 3" })).toBe(true);
    expect(endedByShellExit({ state: "busy", cmd: "logout" })).toBe(true);
    expect(endedByShellExit({ state: "busy", cmd: "apt upgrade" })).toBe(false);
    expect(endedByShellExit({ state: "idle" })).toBe(false);
    expect(endedByShellExit({ state: "unknown" })).toBe(false);
  });
});

describe("views and the inbox", () => {
  test("output nobody is looking at raises once; looking marks it read and resolves it", async () => {
    const h = await harness();
    const { session_id } = await open(h);
    h.timers.advance(3000); // past the grace that starts at open
    h.ptys[0]?.emit("hello\r\n");
    expect(h.flushes.count).toBe(1);
    const raised = await inbox(h, session_id);
    expect(raised.map((n) => n.kind)).toEqual(["terminal.output"]);
    expect(raised[0]?.read_at ?? null).toBeNull();
    expect(h.host.list()[0]?.unseen).toBe(true);

    h.host.view("w1", session_id);
    // The badge hears it now, not on the next tick.
    expect(h.flushes.count).toBe(2);
    const seen = await inbox(h, session_id);
    expect(seen[0]?.read_at).toBeTruthy();
    expect(seen[0]?.resolved_at).toBeTruthy();
    expect(h.host.list()[0]?.unseen).toBe(false);
  });

  test("any window looking counts; the last one leaving starts the absence", async () => {
    const h = await harness();
    const { session_id } = await open(h);
    h.host.view("w1", session_id);
    h.host.view("w2", session_id);
    h.host.view("w1", null);
    h.timers.advance(3000);
    h.ptys[0]?.emit("still watched\r\n");
    expect(await inbox(h, session_id)).toEqual([]);
    h.host.forgetWindow("w2");
    h.timers.advance(3000);
    h.ptys[0]?.emit("now not\r\n");
    expect((await inbox(h, session_id)).map((n) => n.kind)).toEqual(["terminal.output"]);
  });

  test("terminal alerts are read from core per event, so a change made elsewhere holds at once", async () => {
    const h = await harness();
    const first = await open(h);
    // Through core directly — the CLI's `inbox settings --terminal-alerts` —
    // with nothing telling this host.
    await h.hermetic.notifications.settings({ terminal_alerts: false });
    expect(h.host.alertsOn).toBe(false);
    h.timers.advance(3000);
    h.ptys[0]?.emit("quiet\r\n");
    expect(h.flushes.count).toBe(0);
    expect(await inbox(h, first.session_id)).toEqual([]);

    await h.hermetic.notifications.settings({ terminal_alerts: true });
    const second = await open(h);
    h.timers.advance(3000);
    h.ptys[1]?.emit("loud\r\n");
    expect(h.flushes.count).toBe(1);
    expect((await inbox(h, second.session_id)).map((n) => n.kind)).toEqual(["terminal.output"]);
  });

  test("closing resolves the session's rows without marking them read", async () => {
    const h = await harness();
    const { session_id } = await open(h);
    h.timers.advance(3000);
    h.ptys[0]?.emit("hello\r\n");
    const before = h.flushes.count;
    await h.host.close(session_id);
    expect(h.flushes.count).toBe(before + 1);
    const rows = await inbox(h, session_id);
    expect(rows[0]?.resolved_at).toBeTruthy();
    expect(rows[0]?.read_at ?? null).toBeNull();
  });
});

describe("input", () => {
  test("two windows typing into one session each keep their own sequence", async () => {
    const h = await harness();
    const { session_id } = await open(h);
    h.host.input("A", session_id, 0, "a0");
    h.host.input("B", session_id, 0, "b0");
    h.host.input("A", session_id, 1, "a1");
    h.host.input("B", session_id, 1, "b1");
    h.host.input("A", session_id, 2, "a2");
    expect(h.ptys[0]?.writes).toEqual(["a0", "b0", "a1", "b1", "a2"]);
  });

  test("a forgotten window's sequence starts over", async () => {
    const h = await harness();
    const { session_id } = await open(h);
    h.host.input("A", session_id, 0, "a0");
    h.host.input("A", session_id, 1, "a1");
    h.host.forgetWindow("A");
    // A fresh sequence waits for 0: 1 is held until it arrives.
    h.host.input("A", session_id, 1, "n1");
    expect(h.ptys[0]?.writes).toEqual(["a0", "a1"]);
    h.host.input("A", session_id, 0, "n0");
    expect(h.ptys[0]?.writes).toEqual(["a0", "a1", "n0", "n1"]);
  });
});

describe("fixture mode", () => {
  test("a whole session runs on the canned shell and never spawns", async () => {
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
      throw new Error("fixture mode spawned a process");
    });
    try {
      const h = await harness({ fixture: true, spawner: fixturePtySpawner(), timers: realTimers });
      const { session_id } = await open(h);
      const channel = recorder();
      h.host.attach(session_id, channel);
      h.host.input("w1", session_id, 0, "whoami\r");
      await until(() => channel.text().includes("hermes\r\n"));
      h.host.input("w1", session_id, 1, "exit\r");
      await until(() => channel.frames.some((f) => f.event === "exit"));
      expect(channel.frames[channel.frames.length - 1]).toEqual({
        event: "exit",
        data: { code: 0, signal: null, reason: "exited" },
      });
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
    }
  });

  test("a running command is busy for the quit prompt; tmux would not be", async () => {
    const h = await harness({ fixture: true, spawner: fixturePtySpawner(), timers: realTimers });
    const { session_id } = await open(h);
    await until(() => h.host.list()[0]?.activity.state === "idle");
    expect(h.host.busySessions()).toEqual([]);
    h.host.input("w1", session_id, 0, "sleep 30\r");
    await until(() => h.host.busySessions().length === 1);
    expect(h.host.busySessions()).toEqual([{ name: "atlas", index: 1, label: "sleep 30" }]);
    h.host.stopAll();
  });

  test("Open in Terminal is refused", async () => {
    const h = await harness({ fixture: true, spawner: fixturePtySpawner(), timers: realTimers });
    expect((await rejection(h.host.external("atlas"))).code).toBe("UNSUPPORTED");
  });
});

test("Open in Terminal runs the gated argv, binary substituted", async () => {
  const ran: string[][] = [];
  const h = await harness({ openExternal: async (argv) => void ran.push(argv) });
  const argv = await h.hermetic.ssh({ name: "atlas" });
  expect(await h.host.external("atlas")).toEqual({ opened: true });
  expect(ran).toEqual([[BINARY, ...argv.slice(1)]]);
  expect((await rejection(h.host.external("juniper"))).code).toBe("TERMINAL_AGENT_OFF");
});
