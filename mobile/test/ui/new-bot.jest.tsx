/**
 * New bot: the name is lowercased and checked as it is typed, the instance
 * defaults to the primary, Create calls `client.createBot` and opens the new
 * bot's chat, and a duplicate name says so. Also the New chat sheet's
 * "New bot…" row and the form's pure helpers.
 */
import { act, fireEvent, screen } from "@testing-library/react-native";
import NewBot from "../../app/new-bot.tsx";
import NewChat from "../../app/new-chat.tsx";
import {
  botNameError,
  createBotErrorCopy,
  defaultBotInstance,
  normalizeBotName,
} from "../../src/bots/new-bot.ts";
import { HermeticError } from "../../src/client/errors.ts";
import { FleetContext, type FleetContextValue } from "../../src/fleet/FleetProvider.tsx";
import { flush } from "../helpers/fakes.ts";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { renderUi } from "../helpers/render.tsx";

const METRICS = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};

const mockRouter = { back: jest.fn(), push: jest.fn() };
// Delegating: the factory runs when the screens are imported, before `mockRouter` is set.
jest.mock("expo-router", () => ({
  router: { back: () => mockRouter.back(), push: (href: string) => mockRouter.push(href) },
}));

beforeEach(() => {
  mockRouter.back.mockClear();
  mockRouter.push.mockClear();
});

describe("helpers", () => {
  test("names: lowercased, checked against core's BotName", () => {
    expect(normalizeBotName("  Scribe ")).toBe("scribe");
    expect(botNameError("")).toBeNull();
    expect(botNameError("scribe-2.v1_x")).toBeNull();
    expect(botNameError("-scribe")).toBe("Start with a letter or a digit.");
    expect(botNameError("my bot")).toBe("Use only letters, digits, dots, underscores and hyphens.");
    expect(botNameError("a".repeat(65))).toBe("At most 64 characters.");
  });

  test("the default instance is the primary when listened, else the first listened", () => {
    expect(defaultBotInstance(["atlas", "corvid"], "corvid")).toBe("corvid");
    expect(defaultBotInstance(["atlas", "corvid"], "heron")).toBe("atlas");
    expect(defaultBotInstance([], "atlas")).toBeNull();
  });

  test("CONFLICT names the bot and the instance; anything else is errorCopy's", () => {
    const conflict = createBotErrorCopy(new HermeticError("CONFLICT", "exists"), "scribe", "atlas");
    expect(conflict.title).toBe("A bot named scribe already exists on atlas.");
    expect(createBotErrorCopy(new HermeticError("CHAT_UNREACHABLE", "x"), "s", "a").title).toBe(
      "The box did not answer.",
    );
  });
});

function context(listened: string[], primary: string | null, createBot: jest.Mock) {
  const state = { link: null };
  return {
    primary,
    client: { createBot },
    fleet: { subscribe: () => () => {}, getState: () => state, listened: () => listened },
  } as unknown as FleetContextValue;
}

async function setup(listened: string[], primary: string | null, createBot: jest.Mock) {
  await renderUi(
    <SafeAreaProvider initialMetrics={METRICS}>
      <FleetContext.Provider value={context(listened, primary, createBot)}>
        <NewBot />
      </FleetContext.Provider>
    </SafeAreaProvider>,
  );
}

test("typing: lowercased, a bad name is shown under the field and Create stays off", async () => {
  const createBot = jest.fn();
  await setup(["atlas", "corvid"], "corvid", createBot);
  const create = () => screen.getByLabelText("Create bot");
  expect(create().props.accessibilityState.disabled).toBe(true);
  await fireEvent.changeText(screen.getByLabelText("Bot name"), "-Bad");
  expect(screen.getByLabelText("Bot name").props.value).toBe("-bad");
  expect(screen.getByText("Start with a letter or a digit.")).toBeTruthy();
  expect(create().props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(create());
  expect(createBot).not.toHaveBeenCalled();
});

test("Create: the primary by default, the name lowercased, then the bot's chat", async () => {
  const createBot = jest.fn(async () => ({}));
  await setup(["atlas", "corvid"], "corvid", createBot);
  // The primary is preselected among several listened instances.
  expect(screen.getByLabelText("corvid, primary").props.accessibilityState.checked).toBe(true);
  await fireEvent.changeText(screen.getByLabelText("Bot name"), "Scribe");
  await fireEvent.changeText(screen.getByLabelText("Bot title"), "  Digest writer ");
  await fireEvent.press(screen.getByLabelText("Create bot"));
  await act(flush);
  expect(createBot).toHaveBeenCalledWith("corvid", { name: "scribe", title: "Digest writer" });
  expect(mockRouter.back).toHaveBeenCalledTimes(1);
  expect(mockRouter.push).toHaveBeenCalledWith("/chat/corvid/scribe");
});

test("another listened instance can be picked", async () => {
  const createBot = jest.fn(async () => ({}));
  await setup(["atlas", "corvid"], "corvid", createBot);
  await fireEvent.press(screen.getByLabelText("atlas"));
  await fireEvent.changeText(screen.getByLabelText("Bot name"), "ops");
  await fireEvent.changeText(screen.getByLabelText("Bot description"), "Runs the checks.");
  await fireEvent.press(screen.getByLabelText("Create bot"));
  await act(flush);
  expect(createBot).toHaveBeenCalledWith("atlas", { name: "ops", description: "Runs the checks." });
});

test("a single listened instance is a fixed line", async () => {
  await setup(["heron"], null, jest.fn());
  expect(screen.getByTestId("new-bot-instance")).toBeTruthy();
  expect(screen.getByText("heron")).toBeTruthy();
});

test("a duplicate name: the CONFLICT copy, the sheet stays open", async () => {
  const createBot = jest.fn(async () => {
    throw new HermeticError("CONFLICT", "profile exists");
  });
  await setup(["atlas"], "atlas", createBot);
  await fireEvent.changeText(screen.getByLabelText("Bot name"), "scribe");
  await fireEvent.press(screen.getByLabelText("Create bot"));
  await act(flush);
  expect(screen.getByText("A bot named scribe already exists on atlas.")).toBeTruthy();
  expect(mockRouter.push).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Create bot").props.accessibilityState.disabled).toBe(false);
});

test("New chat: a New bot row before Add instance opens the form", async () => {
  const state = { link: null };
  const roster = {
    subscribe: () => () => {},
    getState: () => rosterState,
    layout: () => null,
  };
  const rosterState = { swarms: [], listening: ["atlas"] };
  const inbox = { subscribe: () => () => {}, getState: () => null };
  const ctx = {
    client: { roster, inbox },
    fleet: { subscribe: () => () => {}, getState: () => state },
  } as unknown as FleetContextValue;
  await renderUi(
    <SafeAreaProvider initialMetrics={METRICS}>
      <FleetContext.Provider value={ctx}>
        <NewChat />
      </FleetContext.Provider>
    </SafeAreaProvider>,
  );
  const labels = screen
    .getAllByRole("button")
    .map((b) => b.props.accessibilityLabel as string | undefined);
  expect(labels.indexOf("New bot")).toBeGreaterThanOrEqual(0);
  expect(labels.indexOf("New bot")).toBeLessThan(labels.indexOf("Add instance"));
  await fireEvent.press(screen.getByLabelText("New bot"));
  expect(mockRouter.back).toHaveBeenCalledTimes(1);
  expect(mockRouter.push).toHaveBeenCalledWith("/new-bot");
});
