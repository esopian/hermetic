/**
 * The fixture's room approval (`fixture-bot-mode.ts`): a room message containing
 * `E2E_ROOM_APPROVAL` parks the room's first member on a command, `rooms.respond`
 * with `once` or `deny` settles it, and the room service's own refusal of any
 * other choice arrives as `VALIDATION`.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHermetic } from "../src/index.ts";
import type { Hermetic } from "../src/hermetic.ts";
import { HostedRoom } from "../src/schema/bot-mode.ts";

async function raised() {
  const home = mkdtempSync(join(tmpdir(), "hermetic-fixture-room-approval-"));
  const h: Hermetic = await openHermetic({ fixture: true, home });
  await h.chat.listen({ instance: "atlas", listening: true });
  const room = await h.rooms.create({
    instance: "atlas",
    room: "review-room",
    name: "Review",
    members: [
      { instance: "atlas", bot: "default" },
      { instance: "atlas", bot: "scribe" },
    ],
  });
  expect((await h.rooms.get({ instance: "atlas", room: room.id })).pending_actions).toEqual([]);
  await h.rooms.send({
    instance: "atlas",
    room: room.id,
    text: "please E2E_ROOM_APPROVAL now",
    event_id: "event-1",
  });
  const state = await h.rooms.get({ instance: "atlas", room: room.id });
  const action = state.pending_actions[0];
  if (!action) throw new Error("no pending action was raised");
  const respond = (
    choice: "once" | "session" | "always" | "deny",
    over: { member_id?: string; execution_generation?: number } = {},
  ) =>
    h.rooms.respond({
      instance: "atlas",
      room: room.id,
      member_id: String(action.member_id),
      task_id: action.task_id,
      execution_generation: Number(action.execution_generation),
      request_id: String(action.request_id),
      choice,
      ...over,
    });
  return { h, room, state, action, respond };
}

describe("E2E_ROOM_APPROVAL", () => {
  test("raises a pending approval action with the room service's choices and a session", async () => {
    const { state, action } = await raised();
    expect(HostedRoom.safeParse(state).success).toBe(true);
    expect(state.blocked).toBe(true);
    expect(state.pending_actions).toHaveLength(1);
    expect(action).toMatchObject({
      kind: "approval",
      choices: ["once", "deny"],
      execution_generation: 1,
    });
    expect(action.session_id).toMatch(/^fx-room-session-/);
    expect(action.request_id).toMatch(/^rrq-fixture-/);
    expect(action.member_id).toBeTruthy();
    expect(action.task_id).toBeTruthy();
  });

  test("`once` settles it and the room unblocks", async () => {
    const { h, room, respond } = await raised();
    expect(await respond("once")).toEqual({ accepted: true });
    const after = await h.rooms.get({ instance: "atlas", room: room.id });
    expect(after.pending_actions).toEqual([]);
    expect(after.blocked).toBe(false);
    const events = (await h.rooms.history({ instance: "atlas", room: room.id })).events;
    expect(events.some((e) => e.text?.includes("Approved once"))).toBe(true);
  });

  test("`deny` settles it too", async () => {
    const { h, room, respond } = await raised();
    expect(await respond("deny")).toEqual({ accepted: true });
    expect((await h.rooms.get({ instance: "atlas", room: room.id })).pending_actions).toEqual([]);
  });

  test("any other choice is refused as VALIDATION, and the action stays pending", async () => {
    const { h, room, respond } = await raised();
    for (const choice of ["session", "always"] as const) {
      const failed = await respond(choice).catch((e: unknown) => e);
      expect(failed).toMatchObject({ code: "VALIDATION" });
      expect(String((failed as Error).message)).toContain("room approval choice must be once or deny");
    }
    expect((await h.rooms.get({ instance: "atlas", room: room.id })).pending_actions).toHaveLength(1);
  });

  test("a second answer finds nothing pending", async () => {
    const { respond } = await raised();
    await respond("once");
    const failed = await respond("once").catch((e: unknown) => e);
    expect(failed).toMatchObject({ code: "CHAT_PROTOCOL" });
    expect(String((failed as Error).message)).toContain("room approval is no longer pending");
    // Pending is checked before the choice: a stale answer is stale whatever it chose.
    const stale = await respond("always").catch((e: unknown) => e);
    expect(stale).toMatchObject({ code: "CHAT_PROTOCOL" });
    expect(String((stale as Error).message)).toContain("no longer pending");
  });

  test("an answer for another member or generation is no longer pending, and nothing settles", async () => {
    const { h, room, respond } = await raised();
    for (const over of [{ member_id: "someone-else" }, { execution_generation: 2 }]) {
      const failed = await respond("once", over).catch((e: unknown) => e);
      expect(failed).toMatchObject({ code: "CHAT_PROTOCOL" });
      expect(String((failed as Error).message)).toContain("no longer pending");
    }
    expect((await h.rooms.get({ instance: "atlas", room: room.id })).pending_actions).toHaveLength(1);
  });

  test("a member is parked on one request at a time", async () => {
    const { h, room } = await raised();
    await h.rooms.send({
      instance: "atlas",
      room: room.id,
      text: "again E2E_ROOM_APPROVAL",
      event_id: "event-3",
    });
    expect((await h.rooms.get({ instance: "atlas", room: room.id })).pending_actions).toHaveLength(1);
  });

  test("rooms.stop clears the pending action", async () => {
    const { h, room, respond } = await raised();
    await h.rooms.control({ instance: "atlas", room: room.id, action: "stop" });
    const after = await h.rooms.get({ instance: "atlas", room: room.id });
    expect(after.pending_actions).toEqual([]);
    expect(after.blocked).toBe(false);
    const failed = await respond("once").catch((e: unknown) => e);
    expect(String((failed as Error).message)).toContain("no longer pending");
  });

  test("an ordinary room message raises nothing", async () => {
    const { h, room } = await raised();
    await h.rooms.send({
      instance: "atlas",
      room: room.id,
      text: "Compare notes",
      event_id: "event-2",
    });
    expect((await h.rooms.get({ instance: "atlas", room: room.id })).pending_actions).toHaveLength(1);
  });
});
