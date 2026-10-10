import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openLocalDb,
  SqliteChatFenceStore,
  SqliteInstanceListeningStore,
  SqliteLocalChatSessions,
  SqliteNotificationStore,
} from "../src/local/db/index.ts";
import { MemoryChatFenceStore } from "../src/chat/chat-fence.ts";
import type { ChatFenceStore } from "../src/chat/chat-fence.ts";
import { MemoryLocalChatSessions } from "../src/chat/chat.ts";
import type { LocalChatSessions } from "../src/chat/chat.ts";
import { MemoryInstanceListeningStore } from "../src/chat/instance-listening.ts";
import type { InstanceListeningStore } from "../src/chat/instance-listening.ts";
import { MemoryNotificationStore } from "../src/chat/notifications.ts";
import type { NotificationStore } from "../src/chat/notifications.ts";
import { createLocalAgentPurge } from "../src/local/purge-agent.ts";
import { agentMuteTarget } from "../src/schema/index.ts";
import { FIXTURE_CONFIG, MemoryBackend, seedFixtureFleet } from "../src/backend/memory.ts";
import { drain, testHermetic } from "./helpers.ts";

const F = "fleetaaa";
const G = "fleetbbb";
// Recent, so the sessions table's retention pruning never touches a seeded row.
const RECENT = new Date().toISOString();
const FAR_FUTURE = "2999-01-01T00:00:00.000Z";

interface Stores {
  notifications: NotificationStore;
  instanceListening: InstanceListeningStore;
  localSessions: LocalChatSessions;
  chatFence: ChatFenceStore;
  close(): void;
}

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function build(kind: "memory" | "sqlite"): Stores {
  if (kind === "memory") {
    return {
      notifications: new MemoryNotificationStore(),
      instanceListening: new MemoryInstanceListeningStore(),
      localSessions: new MemoryLocalChatSessions(),
      chatFence: new MemoryChatFenceStore(),
      close: () => {},
    };
  }
  const home = mkdtempSync(join(tmpdir(), "hermetic-purge-"));
  homes.push(home);
  const local = openLocalDb({ home });
  return {
    notifications: new SqliteNotificationStore(local.db),
    instanceListening: new SqliteInstanceListeningStore(local.db),
    localSessions: new SqliteLocalChatSessions(local.db),
    chatFence: new SqliteChatFenceStore(local.db),
    close: () => local.close(),
  };
}

/** Everything the purge is responsible for, for one fleet + agent. */
function seed(s: Stores, fleet: string, name: string): void {
  s.notifications.setSeenStatus(fleet, name, "healthy");
  s.notifications.setSeenStatus(fleet, `chat:${name}/bot`, "2026-01-01T00:00:00Z");
  s.instanceListening.set(fleet, name, true);
  s.chatFence.write(fleet, name, "bot", { owner: "cli-1", expires_at: FAR_FUTURE });
  s.localSessions.remember(
    fleet,
    { instance: name, bot: "bot", session: `sess-${fleet}-${name}` },
    RECENT,
  );
  s.notifications.insert({
    source: "agent",
    kind: "agent.health",
    class: "bad",
    title: `${name} went unreachable`,
    agent: name,
    fleet,
    key: `agent.health:${fleet}:${name}`,
  });
}

function present(s: Stores, fleet: string, name: string) {
  return {
    seen: s.notifications.seenStatus(fleet, name) !== null,
    seenChat: s.notifications.seenStatus(fleet, `chat:${name}/bot`) !== null,
    listening: s.instanceListening.list(fleet).includes(name),
    fence: s.chatFence.read(fleet, name, "bot") !== null,
    session: s.localSessions.mine(fleet, [`sess-${fleet}-${name}`]).size === 1,
    open: s.notifications
      .list({ limit: 50 }, fleet)
      .filter((n) => n.agent === name && n.resolved_at == null).length,
  };
}

for (const kind of ["memory", "sqlite"] as const) {
  describe(`purgeLocalAgent (${kind})`, () => {
    test("removes only the named agent's rows in the named fleet", async () => {
      const s = build(kind);
      for (const [fleet, name] of [
        [F, "alpha"],
        [F, "alphabet"],
        [G, "alpha"],
      ] as const) {
        seed(s, fleet, name);
      }
      s.notifications.mute(agentMuteTarget("alpha"));
      s.notifications.mute(agentMuteTarget("alphabet"));

      await createLocalAgentPurge(s)(F, "alpha");

      expect(present(s, F, "alpha")).toEqual({
        seen: false,
        seenChat: false,
        listening: false,
        fence: false,
        session: false,
        open: 0,
      });
      for (const [fleet, name] of [
        [F, "alphabet"],
        [G, "alpha"],
      ] as const) {
        expect(present(s, fleet, name)).toEqual({
          seen: true,
          seenChat: true,
          listening: true,
          fence: true,
          session: true,
          open: 1,
        });
      }
      // The mute key names no fleet, so it goes with the name.
      expect(s.notifications.mutes().map((m) => m.target)).toEqual([agentMuteTarget("alphabet")]);
      s.close();
    });

    test("resolves the agent's notifications instead of deleting them", async () => {
      const s = build(kind);
      seed(s, F, "alpha");
      await createLocalAgentPurge(s)(F, "alpha");

      const rows = s.notifications.list({ limit: 50 }, F).filter((n) => n.agent === "alpha");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.resolved_at).not.toBeNull();
      expect(s.notifications.counts(F)).toEqual({ unread: 0, needs_action: 0 });
      s.close();
    });

    test("a wildcard in the name does not reach other agents' watermarks", async () => {
      const s = build(kind);
      s.notifications.setSeenStatus(F, "chat:a_c/bot", "x");
      s.notifications.setSeenStatus(F, "chat:abc/bot", "x");
      await createLocalAgentPurge(s)(F, "a_c");
      expect(s.notifications.seenStatus(F, "chat:a_c/bot")).toBeNull();
      expect(s.notifications.seenStatus(F, "chat:abc/bot")).toBe("x");
      s.close();
    });

    test("a failing step does not skip the rest, and is rethrown", async () => {
      const s = build(kind);
      seed(s, F, "alpha");
      s.chatFence.forgetInstance = () => {
        throw new Error("fence unwritable");
      };
      await expect(createLocalAgentPurge(s)(F, "alpha")).rejects.toThrow("fence unwritable");
      const after = present(s, F, "alpha");
      expect(after.fence).toBe(true);
      expect({ ...after, fence: false }).toEqual({
        seen: false,
        seenChat: false,
        listening: false,
        fence: false,
        session: false,
        open: 0,
      });
      s.close();
    });
  });
}

describe("agents.destroy purges local state", () => {
  test("drops the listening opt-in and watermarks of the destroyed agent only", async () => {
    const instanceListening = new MemoryInstanceListeningStore();
    const notifications = new MemoryNotificationStore();
    const hermetic = testHermetic({
      backend: seedFixtureFleet(new MemoryBackend()),
      config: FIXTURE_CONFIG,
      instanceListening,
      notifications,
    });
    const fleet = FIXTURE_CONFIG.fleet_id;
    for (const name of ["ember", "atlas"]) {
      instanceListening.set(fleet, name, true);
      notifications.setSeenStatus(fleet, `chat:${name}/bot`, "x");
    }

    await drain(hermetic.agents.destroy({ name: "ember", yes: true }));

    expect(instanceListening.list(fleet)).toEqual(["atlas"]);
    expect(notifications.seenStatus(fleet, "chat:ember/bot")).toBeNull();
    expect(notifications.seenStatus(fleet, "chat:atlas/bot")).toBe("x");
  });
});
