/**
 * The `hermetic://fixture?…` route (`app/fixture.tsx`): without the fixture
 * it applies nothing and goes to the entry; with it, it waits for the stored
 * pairing to load, takes the link's steps in order through the real providers'
 * methods, then replaces itself with the link's `to`. `createBot` goes
 * through the provider's client, the new one when the same link paired.
 */
import { act, render } from "@testing-library/react-native";
import FixtureDrive from "../../app/fixture.tsx";
import { drive } from "../../src/fixture/drive.ts";
import { fixturePairingLink } from "../../src/fixture/index.ts";
import {
  FleetContext,
  type FleetContextValue,
  type FleetStatus,
} from "../../src/fleet/FleetProvider.tsx";
import type { PairedLink } from "../../src/fleet/pairing.ts";
import type { KvStorage } from "../../src/fleet/store.ts";
import { PrefsProvider } from "../../src/prefs/prefs.tsx";
import { ThemeProvider } from "../../src/theme/theme.tsx";
import { flush } from "../helpers/fakes.ts";

let mockParams: Record<string, string> = {};
const mockRouter = {
  replace: jest.fn(),
  dismissAll: jest.fn(),
  canDismiss: jest.fn(() => false),
};
// Delegating: the factory runs when the screen is imported, before `mockRouter` is set.
jest.mock("expo-router", () => ({
  router: {
    replace: (href: string) => mockRouter.replace(href),
    dismissAll: () => mockRouter.dismissAll(),
    canDismiss: () => mockRouter.canDismiss(),
  },
  useLocalSearchParams: () => mockParams,
}));

/** A storage that records each write into `log` under `name`. */
function loggingKv(name: string, log: string[]): KvStorage {
  const map = new Map<string, string>();
  return {
    get: async (key) => map.get(key) ?? null,
    set: async (key, value) => {
      map.set(key, value);
      log.push(`${name}:${value}`);
    },
    remove: async (key) => {
      map.delete(key);
    },
  };
}

/** A client double that only creates bots, logging which client made each. */
function botClient(label: string, log: string[]) {
  return {
    createBot: jest.fn(async (instance: string, input: { name: string; title?: string }) => {
      log.push(`createBot@${label}:${instance}:${input.name}`);
      return { name: input.name };
    }),
  };
}

function setup(withFixture: boolean, status: FleetStatus = "paired") {
  const log: string[] = [];
  const ctx = {
    status,
    client: botClient("first", log),
    operatorTailnet: null,
    pair: jest.fn(async (link: PairedLink) => {
      log.push(`pair:${link.payload.fleet_id}`);
    }),
    setPrimary: jest.fn(async (name: string) => {
      log.push(`primary:${name}`);
    }),
    fleet: {
      setListening: jest.fn(async (name: string, on: boolean) => {
        log.push(`listen:${name}:${on}`);
        return [name];
      }),
    },
    fixture: withFixture
      ? { link: fixturePairingLink(), drive, tailscale: { get: () => "ok", set: () => {} } }
      : null,
  } as unknown as FleetContextValue;
  const themeKv = loggingKv("theme", log);
  const prefsKv = loggingKv("prefs", log);
  const tree = (value: FleetContextValue) => (
    <ThemeProvider storage={themeKv}>
      <PrefsProvider storage={prefsKv}>
        <FleetContext.Provider value={value}>
          <FixtureDrive />
        </FleetContext.Provider>
      </PrefsProvider>
    </ThemeProvider>
  );
  return { ctx, log, tree };
}

beforeEach(() => {
  mockParams = {};
  mockRouter.replace.mockClear();
  mockRouter.dismissAll.mockClear();
  mockRouter.canDismiss.mockReturnValue(false);
});

test("without the fixture: straight to the entry, nothing applied", async () => {
  mockParams = { pair: "1", primary: "atlas", avatar: "pixel", theme: "light", to: "/settings" };
  const { ctx, log, tree } = setup(false);
  const view = await render(tree(ctx));
  await act(flush);
  expect(mockRouter.replace).toHaveBeenCalledTimes(1);
  expect(mockRouter.replace).toHaveBeenCalledWith("/");
  expect(log).toEqual([]);
  expect(ctx.pair).not.toHaveBeenCalled();
  expect(ctx.setPrimary).not.toHaveBeenCalled();
  expect(view.toJSON()).toBeNull();
});

test("with the fixture: waits for the pairing to load, steps in order, then replace(to)", async () => {
  mockParams = {
    to: "/chat/atlas/default?demo=E2E_APPROVAL",
    theme: "light",
    avatar: "pixel",
    primary: "atlas",
    listen: "corvid",
    pair: "1",
  };
  const { ctx, log, tree } = setup(true, "loading");
  const view = await render(tree(ctx));
  await act(flush);
  // Still loading: nothing yet.
  expect(log).toEqual([]);
  expect(mockRouter.replace).not.toHaveBeenCalled();

  await view.rerender(tree({ ...ctx, status: "unpaired" }));
  await act(flush);
  // The fleet's steps in order; the prefs write lands when React applies the
  // update, so only its presence is checked here (`drive.jest.ts` pins the order).
  expect(log.slice(0, 3)).toEqual(["pair:fxtr0001", "listen:corvid:true", "primary:atlas"]);
  expect(log.slice(3).sort()).toEqual([
    expect.stringMatching(/^prefs:.*"avatarStyle":"pixel"/),
    "theme:light",
  ]);
  expect(mockRouter.replace).toHaveBeenCalledTimes(1);
  expect(mockRouter.replace).toHaveBeenLastCalledWith("/chat/atlas/default?demo=E2E_APPROVAL");

  // A later render does not drive again.
  await view.rerender(tree({ ...ctx, status: "paired" }));
  await act(flush);
  expect(mockRouter.replace).toHaveBeenCalledTimes(1);
});

test("with the fixture: whatever the link opened over is dismissed first", async () => {
  mockRouter.canDismiss.mockReturnValue(true);
  mockParams = { to: "/settings" };
  const { ctx, tree } = setup(true);
  await render(tree(ctx));
  await act(flush);
  expect(mockRouter.dismissAll).toHaveBeenCalledTimes(1);
  expect(mockRouter.replace).toHaveBeenCalledWith("/settings");
});

test("with the fixture: a non-relative `to` goes to the entry", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  mockParams = { to: "https://example.com" };
  const { ctx, tree } = setup(true);
  await render(tree(ctx));
  await act(flush);
  expect(mockRouter.replace).toHaveBeenCalledWith("/");
  expect(warn).toHaveBeenCalledWith("fixture drive: to=https://example.com: not an in-app route");
  warn.mockRestore();
});

test("createBot: made through the client after the primary, then its chat when `to` is absent", async () => {
  mockParams = { createBot: "atlas:scout:Scout", primary: "atlas" };
  const { ctx, log, tree } = setup(true);
  await render(tree(ctx));
  await act(flush);
  expect(log).toEqual(["primary:atlas", "createBot@first:atlas:scout"]);
  const created = (ctx.client as unknown as ReturnType<typeof botClient>).createBot;
  expect(created).toHaveBeenCalledWith("atlas", { name: "scout", title: "Scout" });
  expect(mockRouter.replace).toHaveBeenCalledWith("/chat/atlas/scout");
});

test("createBot after pair=1 waits for the client the new pairing builds", async () => {
  mockParams = { pair: "1", createBot: "atlas:scout" };
  const { ctx, log, tree } = setup(true);
  const view = await render(tree(ctx));
  await act(flush);
  // The client this render holds is the one the pairing replaced: nothing yet.
  expect(log).toEqual(["pair:fxtr0001"]);
  expect(mockRouter.replace).not.toHaveBeenCalled();
  await view.rerender(
    tree({ ...ctx, client: botClient("second", log) } as unknown as FleetContextValue),
  );
  await act(flush);
  expect(log).toEqual(["pair:fxtr0001", "createBot@second:atlas:scout"]);
  expect(mockRouter.replace).toHaveBeenCalledWith("/chat/atlas/scout");
});
