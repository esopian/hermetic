/**
 * The fixture gate: without `EXPO_PUBLIC_HERMETIC_FIXTURE=1` the app's deps
 * are the real platform's, and nothing from the fixture door is constructed.
 */
jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock("expo-file-system", () => ({ File: class {}, Paths: { document: "/doc" } }));
jest.mock("expo-notifications", () => ({}));
jest.mock("expo-device", () => ({ isDevice: false }));
jest.mock("expo-background-task", () => ({
  BackgroundTaskResult: { Success: 1, Failed: 2 },
  BackgroundTaskStatus: { Available: 2 },
}));
jest.mock("expo-task-manager", () => ({ isTaskDefined: () => true, defineTask: jest.fn() }));
jest.mock("expo-constants", () => ({
  __esModule: true,
  default: { expoConfig: { version: "0.1.0" } },
}));
jest.mock("@hermetic/core/chat-client-fixture", () => {
  const actual = jest.requireActual("@hermetic/core/chat-client-fixture");
  return { fixtureChatClient: jest.fn(actual.fixtureChatClient) };
});

import { fixtureChatClient } from "@hermetic/core/chat-client-fixture";
import { appFleetDeps } from "../../src/fleet/deps.ts";

/** What a fixture build carries; a release build's `load` answers `null`. */
const fixtureBuild = () => jest.requireActual("../../src/fixture/index.ts");

const built = fixtureChatClient as unknown as jest.Mock;

beforeEach(() => built.mockClear());

describe("appFleetDeps", () => {
  test("no flag: the real platform, and no fixture is built", () => {
    // This suite runs without the flag, so the module-level require never ran either.
    expect(appFleetDeps(undefined).fixture).toBeNull();
    for (const flag of [undefined, "", "0", "true"]) {
      const deps = appFleetDeps(flag, fixtureBuild);
      expect(deps.fixture).toBeNull();
      expect(deps.chat).toBeUndefined();
      expect(deps.background).not.toBeNull();
    }
    expect(built).not.toHaveBeenCalled();
  });

  test("the flag: the fixture kit's chat, link and Tailscale switch, and no background task", () => {
    const deps = appFleetDeps("1", fixtureBuild);
    expect(built).toHaveBeenCalledTimes(1);
    expect(deps.chat).toBeDefined();
    expect(deps.fixture?.link.startsWith("hermetic://fleet?")).toBe(true);
    expect(deps.fixture?.tailscale.get()).toBe("ok");
    expect(deps.background).toBeNull();
  });

  test("the fixture pairing lives under its own keys", async () => {
    const SecureStore = jest.requireMock("expo-secure-store") as { setItemAsync: jest.Mock };
    await appFleetDeps("1", fixtureBuild).secure.set("hermetic.fleet.v2", "x");
    await appFleetDeps(undefined).secure.set("hermetic.fleet.v2", "y");
    const keys = SecureStore.setItemAsync.mock.calls.map((c: unknown[]) => c[0]);
    expect(keys).toEqual(["fixture.hermetic.fleet.v2", "hermetic.fleet.v2"]);
  });
});
