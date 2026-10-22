/**
 * The Scheduled jobs rail's compact rows and the two drawers behind them:
 * create/edit with a schedule picker, and run history. Times read on the
 * profile's clock (`routines.list`'s `timezone`), never the laptop's.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "./dom.ts";
import { resetBotCapabilityMemo } from "../src/chat/bot-capabilities.ts";
import { ScheduledJobs } from "../src/chat/components/ScheduledJobs.tsx";
import { fakeServer } from "./fake-transport.ts";
import type { FakeServer } from "./fake-transport.ts";

const INSTANCE = "atlas";
const BOT = "default";
const JOB = {
  instance: INSTANCE,
  bot: BOT,
  id: "job-1",
  name: "Morning digest",
  prompt: "Summarise the inbox",
  schedule: "0 8 * * 1-5",
  deliver: "bot",
  paused: false,
  next_run_at: "2099-01-05T16:00:00.000Z",
  last_run_at: "2026-10-21T15:00:00.000Z",
  last_status: "completed",
  repeat: { times: 10, completed: 4 },
  continuity: true,
};
const RUNS = [
  {
    id: "run-2",
    status: "failed",
    started_at: "2026-10-21T15:00:00Z",
    finished_at: "2026-10-21T15:00:42Z",
    text: "",
    error: "Provider returned 429",
  },
  {
    id: "run-1",
    status: "completed",
    started_at: "2026-10-20T15:00:00Z",
    finished_at: "2026-10-20T15:00:30Z",
    text: "Two things need a decision.",
    error: null,
  },
];

let server: FakeServer | null = null;
afterEach(() => {
  server?.restore();
  server = null;
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
    "routines.list": { jobs: [JOB], timezone: "America/Los_Angeles" },
    "routines.history": { runs: RUNS },
    "routines.create": JOB,
    "routines.update": JOB,
  });
  return server;
}
const params = (name: Parameters<FakeServer["to"]>[0]) =>
  server?.to(name).at(-1)?.params as Record<string, unknown>;

async function mounted() {
  serve();
  render(<ScheduledJobs instance={INSTANCE} bot={BOT} title="Atlas" fleetId="fxtr0001" />);
  return screen.findByRole("button", { name: /Morning digest/, expanded: false });
}

describe("the compact row", () => {
  test("reads the schedule in words and opens to its runs and actions", async () => {
    const row = await mounted();
    expect(row.textContent).toContain("Weekdays at 8:00 AM");
    expect(screen.getByText(/instance’s timezone \(America\/Los_Angeles\)/)).toBeTruthy();
    fireEvent.click(row);
    await waitFor(() => expect(screen.getByLabelText("Last 2 runs")).toBeTruthy());
    expect(screen.getByText("4 of 10 · 6 left")).toBeTruthy();
    expect(screen.getByText(/continues from last run/)).toBeTruthy();
    for (const name of ["▶ Run now", "Pause", "Edit", "History", "Remove Morning digest"])
      expect(screen.getByRole("button", { name })).toBeTruthy();
  });
});

describe("the edit drawer", () => {
  test("creates from the picker, with a run cap and continuity", async () => {
    await mounted();
    fireEvent.click(screen.getAllByRole("button", { name: "Add scheduled job" })[0] as HTMLElement);
    const drawer = await screen.findByRole("dialog");
    const at = within(drawer);
    fireEvent.change(at.getByLabelText("Job name"), { target: { value: "Weekly review" } });
    fireEvent.change(at.getByLabelText("Instructions"), { target: { value: "Review the week" } });
    fireEvent.click(at.getByRole("button", { name: "Every week" }));
    fireEvent.click(at.getByRole("button", { name: "Fri" }));
    fireEvent.click(at.getByRole("button", { name: "Mon" }));
    fireEvent.change(at.getByLabelText("Time"), { target: { value: "16:30" } });
    expect(at.getByText("Every Friday at 4:30 PM")).toBeTruthy();
    fireEvent.change(at.getByLabelText("Stop after runs"), { target: { value: "8" } });
    fireEvent.click(at.getByLabelText(/Continue from the last run/));
    fireEvent.click(at.getByRole("button", { name: "Create job" }));
    await waitFor(() => expect(server?.to("routines.create").length).toBe(1));
    expect(params("routines.create")).toMatchObject({
      name: "Weekly review",
      prompt: "Review the week",
      schedule: "30 16 * * 5",
      deliver: "local",
      repeat: 8,
      continuity: true,
    });
  });
  test("a cron that will not parse blocks saving and says why", async () => {
    await mounted();
    fireEvent.click(screen.getAllByRole("button", { name: "Add scheduled job" })[0] as HTMLElement);
    const at = within(await screen.findByRole("dialog"));
    fireEvent.click(at.getByRole("button", { name: "Advanced (cron)" }));
    fireEvent.change(at.getByLabelText(/^Cron expression/), { target: { value: "0 8 * *" } });
    expect(at.getAllByText(/Not a cron expression/).length).toBeGreaterThan(0);
    expect(at.getByRole("button", { name: "Create job" }).hasAttribute("disabled")).toBe(true);
  });
  test("an edit sends only what changed", async () => {
    fireEvent.click(await mounted());
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const at = within(await screen.findByRole("dialog"));
    fireEvent.change(at.getByLabelText("Job name"), { target: { value: "Morning report" } });
    fireEvent.click(at.getByRole("button", { name: "Save job" }));
    await waitFor(() => expect(server?.to("routines.update").length).toBe(1));
    const { target: _, ...sent } = params("routines.update");
    expect(sent).toEqual({ instance: INSTANCE, bot: BOT, id: JOB.id, name: "Morning report" });
  });
});

describe("the history drawer", () => {
  test("totals the runs and shows the chosen one's output", async () => {
    fireEvent.click(await mounted());
    fireEvent.click(await screen.findByRole("button", { name: "History" }));
    const at = within(await screen.findByRole("dialog"));
    await waitFor(() => expect(at.getAllByRole("option")).toHaveLength(2));
    expect(at.getByText("36s")).toBeTruthy();
    expect(at.getByText("Provider returned 429")).toBeTruthy();
    fireEvent.click(at.getAllByRole("option")[1] as HTMLElement);
    expect(at.getByText("Two things need a decision.")).toBeTruthy();
  });
});
