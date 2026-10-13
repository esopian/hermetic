/** One background wake: fleet view, Tailscale, badge — over the fixture network, no laptop. */
jest.mock("expo-secure-store", () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1 }));
jest.mock("expo-file-system", () => ({ File: class {}, Paths: { document: "/doc" } }));
jest.mock("expo-notifications", () => ({ setBadgeCountAsync: jest.fn(async () => true) }));
jest.mock("expo-background-task", () => ({
  BackgroundTaskResult: { Success: 1, Failed: 2 },
  BackgroundTaskStatus: { Available: 2 },
}));
jest.mock("expo-task-manager", () => ({ isTaskDefined: () => false, defineTask: jest.fn() }));

import { type FixtureKit, fixtureKit } from "../../src/fixture/index.ts";
import { BACKGROUND_REFRESH_TASK, backgroundRefresh } from "../../src/fleet/background.ts";
import { readPairingLink } from "../../src/fleet/pairing.ts";
import { FleetStore, memoryFile, memoryKv } from "../../src/fleet/store.ts";
import { inboxEntry } from "../helpers/fixtures.ts";

const NOW = "2026-10-13T10:00:00.000Z";

test("the task is defined at module load", () => {
  const TaskManager = jest.requireMock("expo-task-manager") as { defineTask: jest.Mock };
  expect(TaskManager.defineTask).toHaveBeenCalledWith(BACKGROUND_REFRESH_TASK, expect.any(Function));
});

test("unpaired: only the badge", async () => {
  const kit = fixtureKit("1", () => NOW) as FixtureKit;
  const badges: number[] = [];
  const out = await backgroundRefresh({
    secure: memoryKv(),
    viewCache: memoryFile(),
    inboxFile: memoryFile(),
    fetch: kit.fetch,
    setBadge: async (n) => {
      badges.push(n);
    },
    now: () => NOW,
  });
  expect(out).toEqual({ paired: false, refreshed: false, tailscale: null, badge: 0 });
  expect(badges).toEqual([0]);
});

test("paired: refreshes the fleet view into the cache, probes Tailscale, sets the badge", async () => {
  const kit = fixtureKit("1", () => NOW) as FixtureKit;
  const secure = memoryKv();
  const viewCache = memoryFile();
  const read = readPairingLink(kit.link);
  if (!read.ok) throw new Error(read.error.title);
  await new FleetStore({ secure, viewCache, fetch: kit.fetch, now: () => NOW }).pair(read.link);
  const saved = JSON.stringify([inboxEntry(), inboxEntry({ id: "i2", read_at: NOW })]);
  const inboxFile = memoryFile(saved);
  const badges: number[] = [];
  const calls: string[] = [];
  const out = await backgroundRefresh({
    secure,
    viewCache,
    inboxFile,
    fetch: (input, init) => {
      calls.push(String(input));
      return kit.fetch(input, init);
    },
    setBadge: async (n) => {
      badges.push(n);
    },
    now: () => NOW,
  });
  expect(out).toMatchObject({ paired: true, refreshed: true, tailscale: { status: "ok" }, badge: 1 });
  expect(badges).toEqual([1]);
  expect(JSON.parse(viewCache.text() ?? "{}").agents).toHaveLength(11);
  // Boxes only: hermeticd's /fleet and the gateways' health route.
  expect(
    calls.every((url) =>
      /^(http:\/\/fxtr0001-[a-z0-9-]+\.hermetic\.ts\.net:7434\/fleet|https:\/\/fxtr0001-[a-z0-9-]+\.hermetic\.ts\.net\/api\/health)$/.test(
        url,
      ),
    ),
  ).toBe(true);
  // The inbox file is read, never rewritten.
  expect(inboxFile.text()).toBe(saved);
});
