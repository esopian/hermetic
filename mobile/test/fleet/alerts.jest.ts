import { localDedupe } from "../../src/client/client.ts";
import {
  foregroundDecision,
  ingestPush,
  type NoteContent,
  pushDataOf,
  routeFor,
} from "../../src/fleet/alerts.ts";
import { memoryFile } from "../../src/fleet/store.ts";
import { InboxStore } from "../../src/inbox/store.ts";

const AT = "2026-10-13T10:00:00.000Z";

const push = (over: Record<string, unknown> = {}): NoteContent => ({
  title: "scribe · atlas",
  body: "the answer",
  data: {
    fleet_id: "fxtr0001",
    instance: "atlas",
    bot: "scribe",
    session: "s-1",
    kind: "turn.done",
    dedupe: "atlas:s-1:4:turn.done",
    ...over,
  },
});

describe("pushDataOf", () => {
  test("a box's push data is ours; anything else is not", () => {
    expect(pushDataOf(push())?.dedupe).toBe("atlas:s-1:4:turn.done");
    expect(pushDataOf({ data: { kind: "turn.done" } })).toBeNull();
    expect(pushDataOf({ data: null })).toBeNull();
    expect(pushDataOf(push({ kind: "approval" }))).toBeNull();
  });
});

describe("routeFor", () => {
  test("a push opens its conversation and session; anything else the inbox", () => {
    expect(routeFor(pushDataOf(push()))).toBe("/chat/atlas/scribe?session=s-1");
    expect(routeFor({ instance: "atlas", bot: "scribe", session: "a/b" })).toBe(
      "/chat/atlas/scribe?session=a%2Fb",
    );
    expect(routeFor(null)).toBe("/inbox");
  });
});

describe("foreground handler", () => {
  test("a push is filed and shown once; the same dedupe again is dropped", () => {
    const inbox = new InboxStore(memoryFile(), () => AT);
    expect(foregroundDecision(inbox, push(), false, AT)).toBe(true);
    expect(inbox.getState().entries).toHaveLength(1);
    expect(inbox.getState().entries[0]).toMatchObject({ title: "scribe · atlas", body: "the answer" });
    expect(foregroundDecision(inbox, push(), false, AT)).toBe(false);
    expect(inbox.getState().entries).toHaveLength(1);
  });

  test("a push for an event this phone's socket already showed is dropped", () => {
    const inbox = new InboxStore(memoryFile(), () => AT);
    // The socket path files it under its own key, moments before the box's push.
    inbox.ingest({
      kind: "turn.done",
      instance: "atlas",
      bot: "scribe",
      session: "s-1",
      title: "scribe · atlas",
      body: "the answer",
      at: AT,
      dedupe: localDedupe({ instance: "atlas", session: "s-1" }, "turn.done", "t1"),
    });
    expect(foregroundDecision(inbox, push(), false, "2026-10-13T10:00:20.000Z")).toBe(false);
    expect(inbox.getState().entries).toHaveLength(1);
  });

  test("a local notification this app scheduled is always shown, and not filed twice", () => {
    const inbox = new InboxStore(memoryFile(), () => AT);
    expect(foregroundDecision(inbox, push(), true, AT)).toBe(true);
    expect(inbox.getState().entries).toHaveLength(0);
  });

  test("a notification that is not ours is shown and not filed", () => {
    const inbox = new InboxStore(memoryFile(), () => AT);
    expect(foregroundDecision(inbox, { title: "x", data: {} }, false, AT)).toBe(true);
    expect(inbox.getState().entries).toHaveLength(0);
  });

  test("ingestPush answers whether it was new", () => {
    const inbox = new InboxStore(memoryFile(), () => AT);
    expect(ingestPush(inbox, push(), AT)).toBe(true);
    expect(ingestPush(inbox, push(), AT)).toBe(false);
    expect(ingestPush(inbox, { data: "nope" }, AT)).toBe(false);
  });
});
