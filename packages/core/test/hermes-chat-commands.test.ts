/**
 * `chat.commands`: the gateway's `commands.catalog` mapped to `ChatCommand`
 * (`hermes-chat-commands.ts`), the live-session binding of the read, and the
 * facade's door (`chat.ts`) — validation, masking, a client without a catalog.
 */
import { describe, expect, test } from "bun:test";
import { createChatCommands, mapCommandCatalog } from "../src/chat/hermes/hermes-chat-commands.ts";
import type { BoxAddress, HermesChatClient } from "../src/chat/hermes/hermes-chat.ts";
import { createChat } from "../src/chat/chat.ts";
import { MemoryInstanceListeningStore } from "../src/chat/instance-listening.ts";
import { MemoryChatSettingsStore } from "../src/chat/chat-settings.ts";
import { fixtureChatClient } from "../src/backend/fixture/fixture-chat.ts";
import { FIXTURE_CONFIG, MemoryBackend, seedFixtureFleet } from "../src/backend/memory.ts";
import type { StackInfo } from "../src/backend/types.ts";
import { ChatCommandsResult } from "../src/schema/index.ts";
import { HermeticError } from "../src/errors.ts";

const BOX: BoxAddress = { instance: "atlas", baseUrl: "https://atlas.example.ts.net" };

/** A catalog reply in upstream's shape, trimmed to one of each kind of entry. */
const REPLY = {
  pairs: [
    ["/new", "Start a new session (fresh session ID + history)"],
    ["/skin", "Show or change the display skin/theme"],
    ["/version", "Show Hermes Agent version"],
    ["/deploy", "exec: ./deploy.sh"],
    ["/work", "Work through a task list"],
    ["/new", "a duplicate is dropped"],
    ["not a/command", "unreadable names are dropped"],
    ["/gone"],
  ],
  sub: {},
  canon: { "/new": "/new", "/reset": "/new" },
  commands: {
    "/new": { argument_mode: "text", desktop: null },
    "/reset": { argument_mode: "text", desktop: null },
    "/skin": { argument_mode: "options", desktop: "terminal" },
    "/version": { argument_mode: null, desktop: null },
    "/work": { argument_mode: "bogus", desktop: null },
  },
  categories: [
    { name: "Session", pairs: [["/new", "Start a new session"]] },
    { name: "Configuration", pairs: [["/skin", "x"]] },
    { name: "Info", pairs: [["/version", "x"]] },
    { name: "User commands", pairs: [["/deploy", "x"]] },
  ],
  skills: { "/work": { usage: 4, origin: "hub" } },
  skill_count: 1,
  warning: "",
};

describe("mapCommandCatalog", () => {
  test("maps each kind of entry, in the gateway's order", () => {
    const { commands, warning } = mapCommandCatalog(REPLY);
    expect(warning).toBeNull();
    expect(commands).toEqual([
      {
        name: "/new",
        description: "Start a new session (fresh session ID + history)",
        category: "Session",
        argument_mode: "text",
        desktop: null,
        skill: null,
      },
      {
        name: "/skin",
        description: "Show or change the display skin/theme",
        category: "Configuration",
        argument_mode: "options",
        desktop: "terminal",
        skill: null,
      },
      {
        name: "/version",
        description: "Show Hermes Agent version",
        category: "Info",
        argument_mode: null,
        desktop: null,
        skill: null,
      },
      // A quick command has no desktop metadata: no argument, offered.
      {
        name: "/deploy",
        description: "exec: ./deploy.sh",
        category: "User commands",
        argument_mode: null,
        desktop: null,
        skill: null,
      },
      // An argument mode this build does not know reads as none.
      {
        name: "/work",
        description: "Work through a task list",
        category: null,
        argument_mode: null,
        desktop: null,
        skill: { origin: "hub" },
      },
      {
        name: "/gone",
        description: "",
        category: null,
        argument_mode: null,
        desktop: null,
        skill: null,
      },
    ]);
    // Every row is a valid `ChatCommand`.
    ChatCommandsResult.parse({ instance: "atlas", bot: "default", commands, warning });
  });

  test("keeps the discovery warning, and reads nonsense as an empty catalog", () => {
    expect(mapCommandCatalog({ ...REPLY, warning: "skill discovery unavailable: boom" }).warning).toBe(
      "skill discovery unavailable: boom",
    );
    expect(mapCommandCatalog(null)).toEqual({ commands: [], warning: null });
    expect(mapCommandCatalog({ pairs: "nope" })).toEqual({ commands: [], warning: null });
  });
});

describe("createChatCommands", () => {
  function rpcDouble(active: unknown = { sessions: [] }) {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const rpc = (_box: BoxAddress, method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "session.active_list")
        return active instanceof Error ? Promise.reject(active) : Promise.resolve(active);
      return Promise.resolve(REPLY);
    };
    return { calls, catalog: createChatCommands({ rpc }) };
  }

  test("without a session the catalog is read unbound, for the bot's profile", async () => {
    const { calls, catalog } = rpcDouble();
    const result = await catalog.commands(BOX, "scribe");
    expect(result.commands).toHaveLength(6);
    expect(calls).toEqual([{ method: "commands.catalog", params: { profile: "scribe" } }]);
  });

  test("a conversation live on the gateway binds the read to its runtime session", async () => {
    const { calls, catalog } = rpcDouble({
      sessions: [
        { id: "rt-other", session_key: "20260917_other" },
        { id: "rt-live", session_key: "20260917_live" },
      ],
    });
    await catalog.commands(BOX, "default", { session: "20260917_live" });
    expect(calls.at(-1)).toEqual({
      method: "commands.catalog",
      params: { profile: "default", session_id: "rt-live" },
    });
  });

  test("a conversation that is not live, or a failed lookup, reads unbound", async () => {
    for (const active of [{ sessions: [] }, new Error("socket closed")]) {
      const { calls, catalog } = rpcDouble(active);
      await catalog.commands(BOX, "default", { session: "20260917_cold" });
      expect(calls.at(-1)).toEqual({ method: "commands.catalog", params: { profile: "default" } });
    }
  });
});

/* ── the facade ──────────────────────────────────────────────────────────── */

const backend = seedFixtureFleet(new MemoryBackend());
const agents = await backend.store.agents.scan();
const fleet = await backend.store.fleet.get();
if (fleet === null) throw new Error("the fixture seed writes a fleet item");
const fleetItem = fleet;

function facade(client: Partial<HermesChatClient>, redact = false) {
  const instanceListening = new MemoryInstanceListeningStore();
  for (const agent of agents) instanceListening.set(fleetItem.fleet_id, agent.name, true);
  return createChat({
    guardFleet: () =>
      Promise.resolve({ config: FIXTURE_CONFIG, fleet: fleetItem, stack: {} as StackInfo }),
    getAgent: (name: string) => {
      const found = agents.find((a) => a.name === name);
      return found ? Promise.resolve(found) : Promise.reject(new HermeticError("NOT_FOUND", name));
    },
    listAgents: () => Promise.resolve(agents),
    instanceListening,
    chatSettings: new MemoryChatSettingsStore({ redact }),
    hermes: { ...fixtureChatClient(), ...client },
  });
}

describe("chat.commands", () => {
  test("answers the fixture box's catalog, addressed to the bot", async () => {
    const result = await facade({}).commands({ instance: "atlas", bot: "scribe" });
    expect(result.instance).toBe("atlas");
    expect(result.bot).toBe("scribe");
    expect(result.commands.map((c) => c.name)).toContain("/help");
    expect(result.commands.find((c) => c.name === "/sketch-helper")?.skill).toEqual({
      origin: "bundled",
    });
    ChatCommandsResult.parse(result);
  });

  test("passes the durable session down", async () => {
    let seen: unknown;
    const chat = facade({
      commands: (_box, _bot, opts) => {
        seen = opts?.session;
        return Promise.resolve({ commands: [], warning: null });
      },
    });
    await chat.commands({ instance: "atlas", bot: "default", session: "20260917_live" });
    expect(seen).toBe("20260917_live");
  });

  test("masks what the box wrote when redaction is on", async () => {
    const key = "sk-ant-FIXTUREFIXTUREFIXTURE";
    const chat = facade(
      {
        commands: () =>
          Promise.resolve({
            commands: [
              {
                name: "/deploy",
                description: `exec: ANTHROPIC_API_KEY=${key} ./deploy.sh`,
                category: "User commands",
                argument_mode: null,
                desktop: null,
                skill: null,
              },
            ],
            warning: null,
          }),
      },
      true,
    );
    const result = await chat.commands({ instance: "atlas", bot: "default" });
    expect(JSON.stringify(result)).not.toContain(key);
  });

  test("refuses a malformed request, and a client with no catalog", async () => {
    await expect(facade({}).commands({ instance: "atlas", bot: "../x" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(
      facade({ commands: undefined }).commands({ instance: "atlas", bot: "default" }),
    ).rejects.toMatchObject({ code: "CHAT_PROTOCOL" });
  });
});
