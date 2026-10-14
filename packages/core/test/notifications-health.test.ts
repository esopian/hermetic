/**
 * `agent.health` (§4.9): a bad status is announced only once it has held, so a
 * single missed heartbeat window or a short run of failing checks never
 * reaches the operator, and a recovery is announced only for trouble that was.
 *
 * Every case runs over both stores, like the other inbox suites, with one
 * clock injected into the store and the deps alike.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  HEALTH_ALERT_HOLD_MS,
  MemoryNotificationStore,
  UNREACHABLE_ALERT_HEARTBEATS,
  notificationsList,
  observeHealth,
} from "../src/chat/notifications.ts";
import type { NotificationDeps, NotificationStore } from "../src/chat/notifications.ts";
import { HEARTBEAT_INTERVAL_MS, UNREACHABLE_INTERVALS } from "../src/agents/state.ts";
import { migrate } from "../src/local/db/index.ts";
import { SqliteNotificationStore } from "../src/local/db/notifications.ts";
import type { AgentStatus, AgentView, DisplayStatus } from "../src/schema/index.ts";

const FLEET = "fleet001";
const START = Date.parse("2026-10-13T12:00:00.000Z");
/** The app's poll period. */
const SCAN_MS = 60_000;
/** A heartbeat age that has just crossed into `unreachable`. */
const JUST_UNREACHABLE_MS = HEARTBEAT_INTERVAL_MS * UNREACHABLE_INTERVALS + 10_000;

interface Harness {
  deps: NotificationDeps;
  advance(ms: number): void;
  /** Runs one fleet scan over these agents. */
  scan(...agents: AgentView[]): void;
  /** Every `agent.health` row, oldest first, as `<class> <title>`. */
  health(): string[];
  /** The same laptop opening the same home again — the CLI after the app. */
  reopen(): Harness;
}

function harness(kind: "memory" | "sqlite"): Harness {
  let clock = START;
  const now = () => new Date(clock);
  const db = kind === "sqlite" ? new Database(":memory:") : null;
  if (db) migrate(db);
  const open = (): Harness => {
    const store: NotificationStore = db
      ? new SqliteNotificationStore(db, now)
      : new MemoryNotificationStore(now);
    const deps: NotificationDeps = { store, fleet: () => FLEET, now };
    return {
      deps,
      advance: (ms) => {
        clock += ms;
      },
      scan: (...agents) => observeHealth(deps, agents),
      health: () =>
        notificationsList(deps, {})
          .notifications.filter((n) => n.kind === "agent.health")
          .reverse()
          .map((n) => `${n.class} ${n.title}`),
      reopen: () => {
        if (!db) throw new Error("only a sqlite home outlives its process");
        return open();
      },
    };
  };
  return open();
}

function agent(
  display_status: DisplayStatus,
  over: { status?: AgentStatus; heartbeat_age_ms?: number | null } = {},
): AgentView {
  const status =
    over.status ?? (display_status === "unreachable" ? "ready" : (display_status as AgentStatus));
  const heartbeat_age_ms =
    over.heartbeat_age_ms !== undefined
      ? over.heartbeat_age_ms
      : display_status === "unreachable"
        ? JUST_UNREACHABLE_MS
        : 5_000;
  return {
    name: "atlas",
    status,
    display_status,
    heartbeat_age_ms,
    health: { hermes: display_status !== "degraded", tailscale: true, disk: true, dashboard: true },
  } as AgentView;
}

describe.each(["memory", "sqlite"] as const)("agent.health alert hold (%s)", (kind) => {
  test("the hold is three heartbeat intervals and unreachable short-circuits at six missed", () => {
    expect(HEALTH_ALERT_HOLD_MS).toBe(3 * HEARTBEAT_INTERVAL_MS);
    expect(UNREACHABLE_ALERT_HEARTBEATS).toBe(6);
  });

  test("degraded alerts only once it has held, on the second scan after the first", () => {
    const h = harness(kind);
    h.scan(agent("ready"));
    h.scan(agent("degraded"));
    expect(h.health()).toEqual([]);
    h.advance(SCAN_MS);
    h.scan(agent("degraded"));
    expect(h.health()).toEqual([]);
    h.advance(SCAN_MS);
    h.scan(agent("degraded"));
    expect(h.health()).toEqual(["bad atlas went degraded"]);
    // Held trouble is announced once, not once per scan.
    h.advance(SCAN_MS);
    h.scan(agent("degraded"));
    expect(h.health()).toEqual(["bad atlas went degraded"]);
  });

  test("a single unreachable scan that clears raises nothing, not even a recovery", () => {
    const h = harness(kind);
    h.scan(agent("ready"));
    h.advance(SCAN_MS);
    h.scan(agent("unreachable"));
    h.advance(SCAN_MS);
    h.scan(agent("ready"));
    h.advance(HEALTH_ALERT_HOLD_MS * 2);
    h.scan(agent("ready"));
    expect(h.health()).toEqual([]);
  });

  test("trouble that clears restarts the clock for the next stretch", () => {
    const h = harness(kind);
    h.scan(agent("ready"));
    h.scan(agent("degraded"));
    h.advance(SCAN_MS);
    h.scan(agent("ready"));
    h.advance(SCAN_MS);
    h.scan(agent("degraded"));
    h.advance(SCAN_MS);
    h.scan(agent("degraded"));
    expect(h.health()).toEqual([]);
    h.advance(SCAN_MS);
    h.scan(agent("degraded"));
    expect(h.health()).toEqual(["bad atlas went degraded"]);
  });

  test("degraded becoming unreachable is one stretch of trouble on one clock", () => {
    const h = harness(kind);
    h.scan(agent("ready"));
    h.scan(agent("degraded"));
    h.advance(SCAN_MS);
    h.scan(agent("unreachable", { status: "degraded" }));
    expect(h.health()).toEqual([]);
    h.advance(HEALTH_ALERT_HOLD_MS - SCAN_MS);
    h.scan(agent("unreachable", { status: "degraded" }));
    expect(h.health()).toEqual(["bad atlas went unreachable"]);
  });

  test("unreachable alerts at once when the heartbeat is six intervals old", () => {
    const h = harness(kind);
    h.scan(agent("ready"));
    h.advance(SCAN_MS);
    h.scan(
      agent("unreachable", {
        heartbeat_age_ms: UNREACHABLE_ALERT_HEARTBEATS * HEARTBEAT_INTERVAL_MS - 1,
      }),
    );
    expect(h.health()).toEqual([]);
    h.scan(
      agent("unreachable", {
        heartbeat_age_ms: UNREACHABLE_ALERT_HEARTBEATS * HEARTBEAT_INTERVAL_MS,
      }),
    );
    expect(h.health()).toEqual(["bad atlas went unreachable"]);
  });

  test("error and a stalled bootstrap alert at once", () => {
    const h = harness(kind);
    h.scan(agent("ready"));
    h.scan(agent("error"));
    expect(h.health()).toEqual(["bad atlas went error"]);

    const b = harness(kind);
    b.scan(agent("bootstrapping"));
    b.scan(agent("unreachable", { status: "bootstrapping", heartbeat_age_ms: null }));
    expect(b.health()).toEqual(["bad atlas went unreachable"]);
  });

  test("a recovery is announced for trouble that was announced", () => {
    const h = harness(kind);
    h.scan(agent("ready"));
    h.scan(agent("degraded"));
    h.advance(HEALTH_ALERT_HOLD_MS);
    h.scan(agent("degraded"));
    h.advance(SCAN_MS);
    h.scan(agent("ready"));
    expect(h.health()).toEqual(["bad atlas went degraded", "ok atlas recovered"]);
  });

  test("an operator stop ends pending trouble silently", () => {
    const h = harness(kind);
    h.scan(agent("ready"));
    h.scan(agent("degraded"));
    h.advance(SCAN_MS);
    h.scan(agent("stopping"));
    h.advance(SCAN_MS);
    h.scan(agent("ready"));
    h.scan(agent("degraded"));
    h.advance(SCAN_MS);
    h.scan(agent("degraded"));
    expect(h.health()).toEqual([]);
  });

  test("first sighting of a bad agent stays silent", () => {
    const h = harness(kind);
    h.scan(agent("degraded"));
    h.advance(HEALTH_ALERT_HOLD_MS * 2);
    h.scan(agent("degraded"));
    expect(h.health()).toEqual([]);
  });
});

test("the wait survives from one process to the next over the same home", () => {
  const app = harness("sqlite");
  app.scan(agent("ready"));
  app.scan(agent("degraded"));
  app.advance(HEALTH_ALERT_HOLD_MS);
  const cli = app.reopen();
  cli.scan(agent("degraded"));
  expect(cli.health()).toEqual(["bad atlas went degraded"]);
});
