/**
 * The rollout receiver (§6.6): the gate between the heartbeat, which sees
 * `update_request` on the row, and the update loop, which acts on it. The
 * interesting cases are all about not losing and not repeating a request —
 * hermetic never clears the field, so both mistakes are permanent.
 */
import { describe, expect, test } from "bun:test";
import type { UpdateRequest } from "@hermetic/core/schema";
import { makeUpdateGate } from "../src/update-request.ts";
import { UPDATE_POLL_MS, runUpdateLoop, updateTick } from "../src/main.ts";
import { FakeHost } from "./fake-host.ts";
import { TEST_NAME } from "./fixtures.ts";

/** Let the loop under test get as far as its next await. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const request = (id: string, version = "0.2.0"): UpdateRequest => ({
  id,
  hermeticd_version: version,
  issued_at: "2026-09-04T12:00:00.000Z",
  issued_by: "evan",
});

/** A run that installed something, i.e. anything other than `null`. */
const ran = { upToDate: false };

describe("the update gate (§6.6)", () => {
  test("a request is held until taken, and taken only once", () => {
    const gate = makeUpdateGate();
    expect(gate.take()).toBeNull();

    gate.onUpdateRequest(request("op-1"));

    expect(gate.pending()?.id).toBe("op-1");
    expect(gate.take()?.id).toBe("op-1");
    expect(gate.take()).toBeNull();
  });

  test("a restored request is handed out again, and a newer one wins", () => {
    const gate = makeUpdateGate();
    gate.onUpdateRequest(request("op-1"));
    const first = gate.take();
    expect(first).not.toBeNull();

    if (first) gate.restore(first);
    expect(gate.take()?.id).toBe("op-1");

    // A second foundation update landed while the first was in flight: the
    // release it names is the current one, so it must not be overwritten.
    gate.onUpdateRequest(request("op-1"));
    const stale = gate.take();
    gate.onUpdateRequest(request("op-2", "0.3.0"));
    if (stale) gate.restore(stale);
    expect(gate.take()?.id).toBe("op-2");
  });

  test("one redacted line is logged when a request arrives", () => {
    const lines: string[] = [];
    const gate = makeUpdateGate({ log: (message) => void lines.push(message) });

    gate.onUpdateRequest(request("op-1"));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("op-1");
    expect(lines[0]).toContain("0.2.0");
    expect(lines[0]).toContain("evan");
  });

  test("the wait returns at once when a request is already pending", async () => {
    const host = new FakeHost();
    const gate = makeUpdateGate();
    gate.onUpdateRequest(request("op-1"));

    await gate.wait(host, 60_000);

    // Not even a zero-length sleep: the loop had work before it asked.
    expect(host.sleeps).toEqual([]);
  });

  test("a request wakes the loop out of its poll interval", async () => {
    const host = new FakeHost();
    // A sleep that never resolves: only the request can end this wait, so the
    // test hangs rather than passes if the wake is dropped.
    host.sleep = () => new Promise<void>(() => {});
    const gate = makeUpdateGate();

    let woke = false;
    const waiting = gate.wait(host, 60_000).then(() => {
      woke = true;
    });
    gate.onUpdateRequest(request("op-1"));
    await waiting;

    expect(woke).toBe(true);
    expect(gate.pending()?.id).toBe("op-1");
  });

  test("a restored request no longer cuts the wait short", async () => {
    const host = new FakeHost();
    host.sleep = () => new Promise<void>(() => {});
    const gate = makeUpdateGate();
    gate.onUpdateRequest(request("op-1"));
    const taken = gate.take();
    expect(taken).not.toBeNull();
    if (taken) gate.restore(taken);

    let woke = false;
    const waiting = gate.wait(host, 60_000).then(() => {
      woke = true;
    });
    await flush();
    // Still pending, but the loop has already tried it: sleeping on it is the
    // difference between one poll interval and a spin loop.
    expect(gate.pending()?.id).toBe("op-1");
    expect(woke).toBe(false);

    // News still wakes it.
    gate.onUpdateRequest(request("op-2"));
    await waiting;
    expect(woke).toBe(true);
  });

  test("a request that arrives between waits is not lost", async () => {
    const host = new FakeHost();
    host.sleep = () => new Promise<void>(() => {});
    const gate = makeUpdateGate();

    gate.onUpdateRequest(request("op-1"));
    await gate.wait(host, 60_000);
    expect(gate.take()?.id).toBe("op-1");

    // The next wait is a real one again — nothing is pending.
    let woke = false;
    const waiting = gate.wait(host, 60_000).then(() => {
      woke = true;
    });
    expect(woke).toBe(false);
    gate.onUpdateRequest(request("op-2"));
    await waiting;
    expect(gate.take()?.id).toBe("op-2");
  });
});

describe("the update loop's tick (§6.6)", () => {
  test("nothing due and nothing requested runs no update", async () => {
    const gate = makeUpdateGate();
    let runs = 0;

    const outcome = await updateTick(gate, false, async () => {
      runs += 1;
      return ran;
    });

    expect(outcome).toBe("idle");
    expect(runs).toBe(0);
  });

  test("a requested update runs off-schedule and clears the request", async () => {
    const gate = makeUpdateGate();
    gate.onUpdateRequest(request("op-1"));
    let runs = 0;

    expect(
      await updateTick(gate, false, async () => {
        runs += 1;
        return ran;
      }),
    ).toBe("ran");
    expect(runs).toBe(1);
    expect(gate.pending()).toBeNull();

    // The next tick has nothing left to do: a request is acted on once.
    expect(await updateTick(gate, false, async () => ran)).toBe("idle");
    expect(runs).toBe(1);
  });

  test("a request seen while the bootstrap is active is retried next tick", async () => {
    const gate = makeUpdateGate();
    gate.onUpdateRequest(request("op-1"));
    const results: Array<typeof ran | null> = [null, ran];
    let runs = 0;
    const runUpdate = async (): Promise<typeof ran | null> => {
      const result = results[runs];
      runs += 1;
      return result === undefined ? ran : result;
    };

    // `maybeUpdate` returns null while hermeticd-bootstrap.service is running.
    expect(await updateTick(gate, false, runUpdate)).toBe("deferred");
    expect(gate.pending()?.id).toBe("op-1");

    expect(await updateTick(gate, false, runUpdate)).toBe("ran");
    expect(gate.pending()).toBeNull();
    expect(runs).toBe(2);
  });

  test("a no-op update — the digest was already current — still consumes the request", async () => {
    const gate = makeUpdateGate();
    gate.onUpdateRequest(request("op-1"));

    expect(await updateTick(gate, false, async () => ({ upToDate: true }))).toBe("ran");
    expect(gate.pending()).toBeNull();
  });

  test("a failing requested update is not retried every minute", async () => {
    const gate = makeUpdateGate();
    gate.onUpdateRequest(request("op-1"));

    await expect(
      updateTick(gate, false, () => Promise.reject(new Error("s3 is having a day"))),
    ).rejects.toThrow("s3 is having a day");

    // The nightly slot picks the box up; the loop does not spin on it.
    expect(gate.pending()).toBeNull();
    expect(await updateTick(gate, false, async () => ran)).toBe("idle");
  });

  test("the nightly slot still runs on its own, request or no request", async () => {
    const gate = makeUpdateGate();
    let runs = 0;

    expect(
      await updateTick(gate, true, async () => {
        runs += 1;
        return ran;
      }),
    ).toBe("ran");
    expect(runs).toBe(1);

    // Due but the bootstrap is still running: the caller leaves `nightlyDue` in
    // the past and tries again, exactly as before this feature existed.
    expect(await updateTick(gate, true, async () => null)).toBe("deferred");
  });
});

describe("the update loop (§4.4, §6.6)", () => {
  test("a deferred request waits out the poll interval before it is retried", async () => {
    const host = new FakeHost();
    const gate = makeUpdateGate();
    const stop = new AbortController();
    const startedAt: number[] = [];
    let calls = 0;

    await runUpdateLoop({
      host,
      gate,
      name: TEST_NAME,
      signal: stop.signal,
      log: () => {},
      runUpdate: async () => {
        calls += 1;
        startedAt.push(host.now().getTime());
        // 1: the start-up update, during which a heartbeat tick sees a rollout
        // request. 2: it runs at once, but the bootstrap unit is still active.
        // 3: the retry, one poll interval later.
        if (calls === 1) {
          gate.onUpdateRequest(request("op-1"));
          return ran;
        }
        if (calls === 2) return null;
        stop.abort();
        return ran;
      },
    });

    expect(calls).toBe(3);
    expect(startedAt[1]! - startedAt[0]!).toBe(0);
    expect(startedAt[2]! - startedAt[1]!).toBe(UPDATE_POLL_MS);
    // Exactly one sleep: the wake was free, the deferral cost a full interval.
    expect(host.sleeps).toEqual([UPDATE_POLL_MS]);
  });

  test("a fresh request wakes the loop out of a post-deferral sleep", async () => {
    const host = new FakeHost();
    let sleeps = 0;
    // A sleep that never ends: only a wake can move this loop on, so a test
    // that expects one hangs rather than passing by accident.
    host.sleep = () => {
      sleeps += 1;
      return new Promise<void>(() => {});
    };
    const gate = makeUpdateGate();
    const stop = new AbortController();
    let calls = 0;

    gate.onUpdateRequest(request("op-1"));
    const loop = runUpdateLoop({
      host,
      gate,
      name: TEST_NAME,
      signal: stop.signal,
      log: () => {},
      runUpdate: async () => {
        calls += 1;
        if (calls >= 2) stop.abort();
        // The bootstrap unit is active throughout.
        return null;
      },
    });

    await flush();
    expect(calls).toBe(1);
    expect(sleeps).toBe(1);
    expect(gate.pending()?.id).toBe("op-1");

    gate.onUpdateRequest(request("op-2", "0.3.0"));
    await loop;

    expect(calls).toBe(2);
    expect(sleeps).toBe(1);
  });

  test("an update that throws is logged and the loop keeps its schedule", async () => {
    const host = new FakeHost();
    const gate = makeUpdateGate();
    const stop = new AbortController();
    const lines: string[] = [];
    let calls = 0;

    await runUpdateLoop({
      host,
      gate,
      name: TEST_NAME,
      signal: stop.signal,
      log: (message) => void lines.push(message),
      runUpdate: async () => {
        calls += 1;
        if (calls === 1) throw new Error("s3 is having a day");
        stop.abort();
        return ran;
      },
    });

    expect(calls).toBe(2);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("s3 is having a day");
    // The start-up update never landed, so the retry is a poll interval later.
    expect(host.sleeps).toEqual([UPDATE_POLL_MS]);
  });
});
