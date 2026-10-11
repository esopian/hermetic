/**
 * The terminal's requests and messages, end to end through the real binding
 * and `dispatch` over the fixture (`handlers/terminal.ts`, `rpc/bind.ts`):
 * open, attach, type, ack, resize, view, list, close — the round trip the
 * page makes, minus the page.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { type Bridge, bridge, until } from "./bridge.ts";

const bridges: Bridge[] = [];
afterAll(async () => {
  for (const b of bridges.splice(0)) await b.close();
});

async function opened(options: Parameters<typeof bridge>[0] = {}): Promise<Bridge> {
  const b = await bridge(options);
  bridges.push(b);
  return b;
}

async function refusal(run: Promise<unknown>): Promise<{ code: string }> {
  try {
    await run;
  } catch (e) {
    return e as { code: string };
  }
  throw new Error("expected a refusal; the request resolved");
}

describe("the round trip", () => {
  test("open, attach, type, ack, resize, list, view, close", async () => {
    const b = await opened();
    const session = (await b.request("terminal.open", { name: "atlas", cols: 80, rows: 24 })) as {
      session_id: string;
      index: number;
      command: string;
    };
    expect(session.index).toBe(1);
    expect(session.command).toContain("ssh hermes@");

    const { stream_id } = (await b.request("terminal.attach", {
      session_id: session.session_id,
    })) as { stream_id: string };
    // The snapshot went out before the id existed; the pump held it and tagged it.
    expect(b.frames[0]?.stream_id).toBe(stream_id);
    expect(b.frames[0]?.frame.event).toBe("snapshot");

    b.message("terminal.input", { session_id: session.session_id, in_seq: 0, data: "whoami\r" });
    await until(() => b.text(stream_id).includes("hermes\r\n"));
    b.message("terminal.input", {
      session_id: session.session_id,
      in_seq: 1,
      binary: Buffer.from("echo bytes-in\r").toString("base64"),
    });
    await until(() => b.text(stream_id).includes("bytes-in\r\n"));

    const data = b.frames.filter((f) => f.frame.event === "data").map((f) => f.frame);
    const last = data[data.length - 1];
    if (last?.event !== "data") throw new Error("no data frame");
    b.message("terminal.ack", { stream_id, gen: last.data.gen, upto: last.data.end });

    expect(
      await b.request("terminal.resize", { session_id: session.session_id, cols: 100, rows: 30 }),
    ).toEqual({ resized: true });

    b.message("terminal.view", { session_id: session.session_id });
    const listed = (await b.request("terminal.list", { name: "atlas" })) as {
      sessions: { session_id: string; state: string; unseen: boolean }[];
      alerts: boolean;
    };
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0]).toMatchObject({
      session_id: session.session_id,
      state: "live",
      unseen: false,
    });
    expect(listed.alerts).toBe(true);
    expect((await b.request("terminal.list", { name: "corvid" })) as unknown).toMatchObject({
      sessions: [],
    });

    expect(await b.request("terminal.close", { session_id: session.session_id })).toEqual({
      closed: true,
    });
    const final = b.frames[b.frames.length - 1];
    expect(final?.frame).toEqual({
      event: "exit",
      data: { code: null, signal: "SIGHUP", reason: "closed" },
    });
    expect(b.ctx.streams.has(stream_id)).toBe(false);
    expect(((await b.request("terminal.list", {})) as { sessions: unknown[] }).sessions).toEqual([]);
  });

  test("detach stops one stream and leaves the session running", async () => {
    const b = await opened();
    const { session_id } = (await b.request("terminal.open", {
      name: "atlas",
      cols: 80,
      rows: 24,
    })) as { session_id: string };
    const { stream_id } = (await b.request("terminal.attach", { session_id })) as {
      stream_id: string;
    };
    expect(await b.request("terminal.detach", { stream_id })).toEqual({ closed: true });
    expect(await b.request("terminal.detach", { stream_id })).toEqual({ closed: false });
    const rows = (await b.request("terminal.list", {})) as { sessions: { state: string }[] };
    expect(rows.sessions.map((r) => r.state)).toEqual(["live"]);
    // A second attach starts again from a snapshot.
    const again = (await b.request("terminal.attach", { session_id })) as { stream_id: string };
    expect(b.frames.find((f) => f.stream_id === again.stream_id)?.frame.event).toBe("snapshot");
  });
});

describe("refusals", () => {
  test("sizes outside the bounds are refused", async () => {
    const b = await opened();
    expect((await refusal(b.request("terminal.open", { name: "atlas", cols: 1, rows: 24 }))).code).toBe(
      "VALIDATION",
    );
    expect(
      (await refusal(b.request("terminal.open", { name: "atlas", cols: 80, rows: 201 }))).code,
    ).toBe("VALIDATION");
  });

  test("a stopped agent", async () => {
    const b = await opened();
    expect(
      (await refusal(b.request("terminal.open", { name: "juniper", cols: 80, rows: 24 }))).code,
    ).toBe("TERMINAL_AGENT_OFF");
  });

  test("an unknown session", async () => {
    const b = await opened();
    expect((await refusal(b.request("terminal.attach", { session_id: "nope" }))).code).toBe(
      "NOT_FOUND",
    );
    expect(
      (await refusal(b.request("terminal.resize", { session_id: "nope", cols: 80, rows: 24 }))).code,
    ).toBe("NOT_FOUND");
  });

  test("Open in Terminal in fixture mode", async () => {
    const b = await opened();
    expect((await refusal(b.request("terminal.external", { name: "atlas" }))).code).toBe("UNSUPPORTED");
  });

  test("a context with no host refuses the requests and ignores the messages", async () => {
    const b = await opened({ withHost: false });
    expect(
      (await refusal(b.request("terminal.open", { name: "atlas", cols: 80, rows: 24 }))).code,
    ).toBe("UNSUPPORTED");
    expect(() => b.message("terminal.view", { session_id: null })).not.toThrow();
  });

  test("a malformed message is dropped, never thrown", async () => {
    const b = await opened();
    for (const name of ["terminal.input", "terminal.ack", "terminal.view"]) {
      for (const payload of [null, 7, "x", {}, { session_id: "../etc", in_seq: -1 }]) {
        expect(() => b.message(name, payload)).not.toThrow();
      }
    }
    // Both halves at once, or neither, is not a keystroke.
    expect(() =>
      b.message("terminal.input", { session_id: "s", in_seq: 0, data: "a", binary: "YQ==" }),
    ).not.toThrow();
  });
});

test("the window going away stops it counting as a viewer", async () => {
  const b = await opened();
  const { session_id } = (await b.request("terminal.open", {
    name: "atlas",
    cols: 80,
    rows: 24,
  })) as { session_id: string };
  b.message("terminal.view", { session_id });
  b.host.input("test-window", session_id, 0, "whoami\r");
  await until(() => b.host.list()[0]?.activity.state === "idle");
  expect(b.host.list()[0]?.unseen).toBe(false);

  b.closeWindow();
  // The window's sequence went with it: a new one counts from 0.
  b.host.input("test-window", session_id, 0, "whoami\r");
  await until(() => b.host.list()[0]?.unseen === true);
});

test("turning terminal alerts off reaches the host at once, and back on", async () => {
  const b = await opened();
  expect(b.host.alertsOn).toBe(true);
  await b.request("notifications.settings", { terminal_alerts: false });
  expect(b.host.alertsOn).toBe(false);
  expect(((await b.request("terminal.list", {})) as { alerts: boolean }).alerts).toBe(false);
  await b.request("notifications.settings", { terminal_alerts: true });
  expect(b.host.alertsOn).toBe(true);
});

test("a page reload closes the old page's attaches, which nobody can ack any more", async () => {
  const b = await opened();
  const { session_id } = (await b.request("terminal.open", {
    name: "atlas",
    cols: 80,
    rows: 24,
  })) as { session_id: string };
  const { stream_id } = (await b.request("terminal.attach", { session_id })) as {
    stream_id: string;
  };
  expect(b.ctx.streams.has(stream_id)).toBe(true);
  b.message("page.ready", {});
  expect(b.ctx.streams.has(stream_id)).toBe(false);
  await until(() => b.host.attachIds(() => true).length === 0);
  // The session itself carries on, and the new page attaches afresh.
  const again = (await b.request("terminal.attach", { session_id })) as { stream_id: string };
  expect(b.ctx.streams.has(again.stream_id)).toBe(true);
});

test("a page reload forgets what the old page said it was viewing", async () => {
  const b = await opened();
  const { session_id } = (await b.request("terminal.open", {
    name: "atlas",
    cols: 80,
    rows: 24,
  })) as { session_id: string };
  b.message("terminal.view", { session_id });
  b.message("page.ready", {});
  // The new page has not reported a view, so output now is unseen.
  b.host.input("test-window", session_id, 0, "whoami\r");
  await until(() => b.host.list()[0]?.unseen === true);
});
