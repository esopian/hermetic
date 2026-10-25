/**
 * The Routines sheet (`src/chat/RoutinesSheet.tsx`) over core's routine calls
 * (`src/client/routines.ts`) against a scripted dashboard REST answer: the list
 * reads each job's schedule in words, its next run on the profile's clock, and
 * Run now posts the trigger.
 */
import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { RoutinesSheet } from "../../src/chat/RoutinesSheet.tsx";
import { phoneRoutines } from "../../src/client/routines.ts";
import { renderUi } from "../helpers/render.tsx";

const METRICS = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};
/** Wednesday 2026-10-21, 22:40 in Los Angeles. */
const NOW = Date.parse("2026-10-22T05:40:00Z");

const JOBS = [
  {
    id: "job-1",
    name: "[bot:scribe] Morning digest",
    prompt: "Summarise the inbox",
    schedule: { kind: "cron", expr: "0 8 * * 1-5", display: "weekdays 8am" },
    enabled: true,
    state: "scheduled",
    next_run_at: "2026-10-22T15:00:00Z",
    last_run_at: "2026-10-21T15:00:00Z",
    last_status: "ok",
  },
  {
    id: "job-2",
    name: "Hourly check",
    prompt: "Check the build",
    schedule: "every 2h",
    enabled: false,
    state: "paused",
  },
];

test("lists each routine in words with its next run, and Run now triggers it", async () => {
  const calls: string[] = [];
  const rest = jest.fn(async ({ method, path }: { method: string; path: string }) => {
    calls.push(`${method} ${path}`);
    if (path.startsWith("/api/config")) return { timezone: "America/Los_Angeles" };
    if (path.includes("/trigger")) return JOBS[0];
    return JOBS;
  });
  await renderUi(
    <SafeAreaProvider initialMetrics={METRICS}>
      <RoutinesSheet
        visible
        instance="atlas"
        bot="scribe"
        title="Scribe"
        routines={phoneRoutines(rest)}
        refreshKey={0}
        now={NOW}
        onClose={jest.fn()}
      />
    </SafeAreaProvider>,
  );
  expect(await screen.findByText("Morning digest")).toBeTruthy();
  expect(screen.getByText("Weekdays at 8:00 AM")).toBeTruthy();
  expect(screen.getByText("Next: Tomorrow, 8:00 AM")).toBeTruthy();
  expect(screen.getByText("Every 2 hours")).toBeTruthy();
  expect(screen.getByText("Paused")).toBeTruthy();
  expect(screen.getByText("Resume")).toBeTruthy();
  expect(screen.getByText(/timezone \(America\/Los_Angeles\)/)).toBeTruthy();

  fireEvent.press(screen.getAllByLabelText("Run now")[0]!);
  await waitFor(() => expect(calls).toContain("POST /api/cron/jobs/job-1/trigger?profile=scribe"));
});
