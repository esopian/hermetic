/**
 * When the Scheduled jobs rail re-reads the routine registry.
 *
 * The registry changes behind the rail's back in two ways: the bot schedules a
 * job itself, through its `cronjob` tool, or something else on the box does.
 * The first is seen in the turn in flight — a finished cron call re-reads at
 * once, and no other tool does — and the second is caught by a once-a-minute
 * poll that runs only while the rail is mounted and the page is on screen.
 *
 * The poll is stepped on `fakeClock`, handed in through the rail's
 * `setInterval` seam rather than by faking the globals (see `fake-clock.ts` for
 * why), so "one read per minute" is counted at virtual time with nothing slept.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, flipPageHidden, render, screen, setPageHidden, waitFor } from "./dom.ts";
import type { ChatBlockView, ChatMessageView } from "../src/api/index.ts";
import { resetBotCapabilityMemo } from "../src/chat/bot-capabilities.ts";
import { ROUTINES_POLL_MS, ScheduledJobs } from "../src/chat/components/ScheduledJobs.tsx";
import { finishedCronCalls } from "../src/chat/cron-tools.ts";
import { fakeClock, settle } from "./fake-clock.ts";
import { fakeServer } from "./fake-transport.ts";
import type { FakeServer } from "./fake-transport.ts";

const INSTANCE = "atlas";
const BOT = "default";
const JOBS = "routines.list";
/** Longer than any run of this file, for the cases not measuring the poll. */
const NEVER_MS = 600_000;

const JOB = {
  id: "job-1",
  name: "Morning digest",
  prompt: "Summarise the inbox",
  schedule: "0 8 * * *",
  deliver: "local",
  paused: false,
  last_status: null,
};

let server: FakeServer | null = null;
afterEach(() => {
  server?.restore();
  server = null;
  setPageHidden(false);
  cleanup();
});
afterEach(resetBotCapabilityMemo);

function serve(): FakeServer {
  server = fakeServer({
    "bots.capabilities": {
      instance: INSTANCE,
      profiles: true,
      routines: true,
      hosted_rooms: true,
      room_driver: true,
      room_methods: [],
      protocol_version: 2,
      room_features: [],
      membership_edit: false,
      cross_instance_rooms: false,
      cross_instance_relay: false,
      reason: null,
      detail: { profiles: null, routines: null, hosted_rooms: null, room_driver: null },
      status: {
        profiles: "supported",
        routines: "supported",
        hosted_rooms: "supported",
        room_driver: "supported",
      },
    },
    [JOBS]: { instance: INSTANCE, bot: BOT, jobs: [JOB] },
    "routines.delete": { instance: INSTANCE, bot: BOT, id: JOB.id, deleted: true },
  });
  return server;
}

function tool(name: string, status: "running" | "ok" | "bad", toolId = `call-${name}`): ChatBlockView {
  return { kind: "tool", tool_id: toolId, name, args: {}, status } as ChatBlockView;
}

function turn(...blocks: ChatBlockView[]): ChatMessageView {
  return {
    id: "live-1",
    session: "s-1",
    role: "bot",
    at: "2026-10-13T12:00:00Z",
    blocks,
  } as ChatMessageView;
}

function rail(props: {
  live?: ChatMessageView | null;
  pollMs?: number;
  clock?: ReturnType<typeof fakeClock>;
}) {
  return (
    <ScheduledJobs
      instance={INSTANCE}
      bot={BOT}
      title="Atlas"
      fleetId="fxtr0001"
      live={props.live ?? null}
      pollMs={props.pollMs ?? NEVER_MS}
      setInterval={props.clock?.timing.setInterval}
    />
  );
}

/** Mounted, with the first read landed and drawn. */
async function mounted(element: ReturnType<typeof rail>) {
  const view = render(element);
  await waitFor(() => expect(screen.getByText(JOB.name)).toBeTruthy());
  expect(server?.to(JOBS).length).toBe(1);
  return view;
}

describe("finishedCronCalls", () => {
  test("counts finished cron calls of either name and nothing else", () => {
    const message = turn(
      tool("cronjob", "ok"),
      tool("cronjob_manage", "bad"),
      tool("cronjob", "running", "call-pending"),
      tool("terminal", "ok"),
    );
    expect(finishedCronCalls(message)).toEqual(["id:call-cronjob", "id:call-cronjob_manage"]);
    expect(finishedCronCalls(null)).toEqual([]);
  });
});

describe("the rail re-reads on a cron call in chat", () => {
  test("a finished cron tool block re-reads the registry once", async () => {
    serve();
    const view = await mounted(rail({ live: turn(tool("cronjob", "running")) }));
    view.rerender(rail({ live: turn(tool("cronjob", "ok")) }));
    await waitFor(() => expect(server?.to(JOBS).length).toBe(2));
    // The same finished call, redrawn by a later frame, is not a second change.
    view.rerender(rail({ live: turn(tool("cronjob", "ok"), tool("terminal", "running")) }));
    await settle();
    expect(server?.to(JOBS).length).toBe(2);
    // The list stays on screen through a re-read nobody asked for.
    expect(screen.queryByText("Reading scheduled jobs…")).toBeNull();
  });

  test("a finished non-cron tool block does not re-read", async () => {
    serve();
    const view = await mounted(rail({ live: turn(tool("terminal", "running")) }));
    view.rerender(rail({ live: turn(tool("terminal", "ok"), tool("web_search", "ok")) }));
    await settle();
    expect(server?.to(JOBS).length).toBe(1);
  });

  test("a cron call still running does not re-read", async () => {
    serve();
    const view = await mounted(rail({}));
    view.rerender(rail({ live: turn(tool("cronjob_manage", "running")) }));
    await settle();
    expect(server?.to(JOBS).length).toBe(1);
  });
});

describe("the rail polls while it is on screen", () => {
  test("one re-read per minute while mounted, none after unmount", async () => {
    serve();
    const clock = fakeClock();
    const view = await mounted(rail({ pollMs: ROUTINES_POLL_MS, clock }));
    await clock.advance(ROUTINES_POLL_MS - 1);
    expect(server?.to(JOBS).length).toBe(1);
    await clock.advance(1);
    await waitFor(() => expect(server?.to(JOBS).length).toBe(2));
    await clock.advance(ROUTINES_POLL_MS);
    await waitFor(() => expect(server?.to(JOBS).length).toBe(3));
    view.unmount();
    expect(clock.pending()).toBe(0);
    await clock.advance(ROUTINES_POLL_MS * 3);
    expect(server?.to(JOBS).length).toBe(3);
  });

  test("a hidden page stops the poll and a visible one re-arms it", async () => {
    serve();
    const clock = fakeClock();
    await mounted(rail({ pollMs: ROUTINES_POLL_MS, clock }));
    flipPageHidden(true);
    await settle();
    expect(clock.pending()).toBe(0);
    await clock.advance(ROUTINES_POLL_MS * 2);
    expect(server?.to(JOBS).length).toBe(1);
    flipPageHidden(false);
    await settle();
    await clock.advance(ROUTINES_POLL_MS);
    await waitFor(() => expect(server?.to(JOBS).length).toBe(2));
  });
});

describe("the rail's own changes", () => {
  test("removing a job still re-reads the registry", async () => {
    serve();
    await mounted(rail({}));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove job" }));
    await waitFor(() => expect(server?.to("routines.delete").length).toBe(1));
    await waitFor(() => expect(server?.to(JOBS).length).toBe(2));
  });
});
