/**
 * `fleetStream` against a fake stream: the dispatch table above the transport
 * seam.
 *
 * The stream is the whole of how the dashboard learns anything (§11.2 — there
 * is no incremental sync), so its failure mode is invisible in a screenshot: a
 * `scan_error` treated as a dead socket would tear down a working stream every
 * time DynamoDB hiccuped. The socket itself — reconnect, backoff, the timer
 * that must not outlive the unsubscribe — belongs to `transport-rpc.ts` now,
 * and is asserted in `transport-rpc.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import type { AgentView } from "../src/api/index.ts";
import { fleetStream } from "../src/api/index.ts";
import type { FleetHandlers } from "../src/api/index.ts";
import { FakeStream } from "./fake-stream.ts";
import { type FakeServer, fakeServer } from "./fake-transport.ts";

let server: FakeServer;

beforeEach(() => {
  server = fakeServer();
});
afterEach(() => {
  server.restore();
  jest.useRealTimers();
});

interface Seen {
  snapshots: Array<{ agents: AgentView[]; at: string; scanned: boolean }>;
  agents: AgentView[];
  removed: string[];
  polls: string[];
  connected: boolean[];
  scanErrors: string[];
  retries: number[];
}

function subscribe(): { seen: Seen; stop: () => void } {
  const seen: Seen = {
    snapshots: [],
    agents: [],
    removed: [],
    polls: [],
    connected: [],
    scanErrors: [],
    retries: [],
  };
  const handlers: FleetHandlers = {
    onSnapshot: (agents, at, scanned) => seen.snapshots.push({ agents, at, scanned }),
    onAgent: (a) => seen.agents.push(a),
    onRemoved: (n) => seen.removed.push(n),
    onPoll: (at) => seen.polls.push(at),
    onConnected: (c) => seen.connected.push(c),
    onScanError: (m) => seen.scanErrors.push(m),
    onRetryIn: (ms) => seen.retries.push(ms),
  };
  return { seen, stop: fleetStream(handlers) };
}

const agent = (name: string) => ({ name }) as AgentView;

describe("fleetStream · dispatch", () => {
  test("each frame reaches its own callback, and nothing else's", () => {
    const { seen, stop } = subscribe();
    const es = FakeStream.last("fleet");

    es.emit("snapshot", { agents: [agent("lumen")], at: "2026-09-06T12:00:00.000Z", scanned: true });
    es.emit("agent", { agent: agent("cinder") });
    es.emit("removed", { name: "lumen" });
    es.emit("poll", { at: "2026-09-06T12:00:03.000Z" });

    expect(seen.snapshots).toEqual([
      { agents: [agent("lumen")], at: "2026-09-06T12:00:00.000Z", scanned: true },
    ]);
    expect(seen.agents.map((a) => a.name)).toEqual(["cinder"]);
    expect(seen.removed).toEqual(["lumen"]);
    expect(seen.polls).toEqual(["2026-09-06T12:00:03.000Z"]);
    expect(seen.scanErrors).toEqual([]);
    stop();
  });

  test("a snapshot from a server that does not send `scanned` is treated as read", () => {
    // A mismatched build must not sit on a loading screen forever.
    const { seen, stop } = subscribe();
    FakeStream.last("fleet").emit("snapshot", { agents: [], at: "2026-09-06T12:00:00.000Z" });
    expect(seen.snapshots[0]?.scanned).toBe(true);
    stop();
  });

  test("`scan_error` reports the failed scan and leaves the socket alone", () => {
    jest.useFakeTimers();
    const { seen, stop } = subscribe();
    const es = FakeStream.last("fleet");

    es.emit("scan_error", { message: "ProvisionedThroughputExceeded" });

    expect(seen.scanErrors).toEqual(["ProvisionedThroughputExceeded"]);
    // The regression this catches: naming it `error` (which the transport
    // reserves for a dead socket) would close a stream that is perfectly fine.
    expect(es.closed).toBe(false);
    expect(seen.retries).toEqual([]);
    expect(seen.connected).toEqual([]);
    jest.advanceTimersByTime(60_000);
    expect(FakeStream.instances.length).toBe(1);
    stop();
  });
});
