import { type Alert, localDedupe } from "../../src/client/client.ts";
import {
  foregroundDecision,
  ingestPush,
  type NoteContent,
  presentsLocally,
  type PushFleet,
  pushDataOf,
  routeFor,
} from "../../src/fleet/alerts.ts";
import { memoryFile } from "../../src/fleet/store.ts";
import { InboxStore } from "../../src/inbox/store.ts";

const AT = "2026-10-13T10:00:00.000Z";
const FLEET: PushFleet = { fleet_id: "fxtr0001", agents: ["atlas", "corvid"] };

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
    expect(foregroundDecision(inbox, push(), false, AT, FLEET)).toBe(true);
    expect(inbox.getState().entries).toHaveLength(1);
    expect(inbox.getState().entries[0]).toMatchObject({ title: "scribe · atlas", body: "the answer" });
    expect(foregroundDecision(inbox, push(), false, AT, FLEET)).toBe(false);
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
    expect(foregroundDecision(inbox, push(), false, "2026-10-13T10:00:20.000Z", FLEET)).toBe(false);
    expect(inbox.getState().entries).toHaveLength(1);
  });

  test("a push read later from the notification centre is filed at its own delivery time", () => {
    const inbox = new InboxStore(memoryFile(), () => AT);
    // The socket raised it during the background linger.
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
    // Delivered 30 s later, read ten minutes later on foreground: still the same event.
    const delivered = { ...push(), date: Date.parse("2026-10-13T10:00:30.000Z") };
    expect(ingestPush(inbox, delivered, "2026-10-13T10:10:00.000Z", FLEET)).toBe(false);
    expect(inbox.getState().entries).toHaveLength(1);
    // Without a delivery time the read time stands, and the fold window has passed.
    expect(ingestPush(inbox, push(), "2026-10-13T10:10:00.000Z", FLEET)).toBe(true);
    expect(inbox.getState().entries[0]?.at).toBe("2026-10-13T10:10:00.000Z");
  });

  test("a local notification this app scheduled is always shown, and not filed twice", () => {
    const inbox = new InboxStore(memoryFile(), () => AT);
    expect(foregroundDecision(inbox, push(), true, AT, FLEET)).toBe(true);
    expect(inbox.getState().entries).toHaveLength(0);
  });

  test("a notification that is not ours is shown and not filed", () => {
    const inbox = new InboxStore(memoryFile(), () => AT);
    expect(foregroundDecision(inbox, { title: "x", data: {} }, false, AT, FLEET)).toBe(true);
    expect(inbox.getState().entries).toHaveLength(0);
  });

  test("ingestPush answers whether it was new", () => {
    const inbox = new InboxStore(memoryFile(), () => AT);
    expect(ingestPush(inbox, push(), AT, FLEET)).toBe(true);
    expect(ingestPush(inbox, push(), AT, FLEET)).toBe(false);
    expect(ingestPush(inbox, { data: "nope" }, AT, FLEET)).toBe(false);
  });

  test("a push for another fleet, or an agent the pairing does not name, is dropped unfiled", () => {
    const inbox = new InboxStore(memoryFile(), () => AT);
    const other = push({ fleet_id: "sg7k2m4p", dedupe: "atlas:s-1:5:turn.done" });
    const stranger = push({ instance: "heron", dedupe: "heron:s-1:4:turn.done" });
    expect(ingestPush(inbox, other, AT, FLEET)).toBe(false);
    expect(ingestPush(inbox, stranger, AT, FLEET)).toBe(false);
    expect(foregroundDecision(inbox, other, false, AT, FLEET)).toBe(false);
    expect(foregroundDecision(inbox, stranger, false, AT, FLEET)).toBe(false);
    // Unpaired: nothing belongs.
    expect(ingestPush(inbox, push(), AT, null)).toBe(false);
    expect(inbox.getState().entries).toHaveLength(0);
  });
});

describe("presentsLocally", () => {
  const alert = (decision: Alert["decision"], instance = "atlas"): Alert => ({
    decision,
    title: "scribe · atlas",
    body: "Reply ready",
    category: null,
    data: {
      fleet_id: "fxtr0001",
      instance,
      bot: "scribe",
      session: "s-1",
      kind: "turn.done",
      dedupe: "atlas:s-1:phone-t1:turn.done",
    },
  });

  test("backgrounded: no local alert for a box whose push registration is on", () => {
    const covers = (instance: string) => instance === "atlas";
    expect(presentsLocally(alert("local"), covers)).toBe(false);
    // A box that does not hold the registration: this phone is the only alert.
    expect(presentsLocally(alert("local", "corvid"), covers)).toBe(true);
    // Push off: nothing covers anything.
    expect(presentsLocally(alert("local"), () => false)).toBe(true);
  });

  test("in the foreground the banner always shows", () => {
    expect(presentsLocally(alert("banner"), () => true)).toBe(true);
  });
});
