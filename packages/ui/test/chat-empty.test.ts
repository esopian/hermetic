/**
 * `chatEmptyKind`: which empty state Chat owes, and — the half worth pinning —
 * that it owes none while either read is still out, so a cold start on Chat
 * never flashes a panel the next read takes back.
 */
import { describe, expect, test } from "bun:test";
import type { AgentView } from "../src/api/index.ts";
import { chatEmptyKind } from "../src/chat/components/ChatEmpty.tsx";
import type { Listening } from "../src/state/listening-state.tsx";

const agent = (name: string) => ({ name, status: "ready" }) as AgentView;

function listening(instances: string[], over: Partial<Listening> = {}): Listening {
  return {
    instances,
    loading: false,
    error: null,
    pending: [],
    setListening: async () => true,
    refresh: async () => {},
    ...over,
  };
}

describe("chatEmptyKind", () => {
  test("nothing before the fleet has been read", () => {
    expect(chatEmptyKind({ fleetRead: false, agents: [], listening: listening([]) })).toBeNull();
  });

  test("an empty fleet is no agents, whatever the listening read says", () => {
    for (const l of [listening([]), listening([], { loading: true }), null]) {
      expect(chatEmptyKind({ fleetRead: true, agents: [], listening: l })).toBe("no-agents");
    }
  });

  test("agents with none listened to is none listening", () => {
    const agents = [agent("atlas"), agent("heron")];
    expect(chatEmptyKind({ fleetRead: true, agents, listening: listening([]) })).toBe("none-listening");
    // A listened name this fleet does not have is not one of its agents.
    expect(chatEmptyKind({ fleetRead: true, agents, listening: listening(["ghost"]) })).toBe(
      "none-listening",
    );
  });

  test("one listened agent is enough, stopped or not", () => {
    const agents = [agent("atlas"), { ...agent("heron"), status: "stopped" } as AgentView];
    expect(chatEmptyKind({ fleetRead: true, agents, listening: listening(["heron"]) })).toBeNull();
  });

  test("nothing while the listening set is unread, unknown or failed", () => {
    const agents = [agent("atlas")];
    expect(
      chatEmptyKind({ fleetRead: true, agents, listening: listening([], { loading: true }) }),
    ).toBeNull();
    expect(chatEmptyKind({ fleetRead: true, agents, listening: null })).toBeNull();
    expect(
      chatEmptyKind({ fleetRead: true, agents, listening: listening([], { error: "read failed" }) }),
    ).toBeNull();
  });
});
