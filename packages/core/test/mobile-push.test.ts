/**
 * Pushes (`mobile/push.ts`): what each event says with previews on and off,
 * that a key reaches a device once, that a live socket suppresses the push,
 * that `DeviceNotRegistered` forgets the token, and that the Expo sender
 * batches by 100 and turns failures into receipts.
 */
import { describe, expect, test } from "bun:test";
import type { Notification, TurnSummary } from "../src/schema/index.ts";
import { MemoryMobileStore, type MobileDeviceRow } from "../src/mobile/device-store.ts";
import {
  buildPush,
  createPushNotifier,
  expoPushSender,
  memoryPushSender,
  previewText,
  type ExpoPushMessage,
} from "../src/mobile/push.ts";

const TURN: TurnSummary = {
  turn_id: "t1",
  instance: "atlas",
  bot: "default",
  session: "s1",
  started_at: "2026-10-13T12:00:00.000Z",
  state: "done",
  last_n: 4,
  truncated: false,
  device_id: "d1",
};

function device(id: string, over: Partial<MobileDeviceRow> = {}): MobileDeviceRow {
  return {
    device_id: id,
    name: `FIXTURE ${id}`,
    platform: "ios",
    token_sha256: id.padEnd(64, "0"),
    created_at: "2026-10-13T11:00:00.000Z",
    last_seen_at: null,
    expo_push_token: `ExponentPushToken[FIXTURE-${id}]`,
    previews: true,
    enabled: true,
    revoked_at: null,
    fleet_id: "fxtr0001",
    ...over,
  };
}

const ROW: Notification = {
  id: "n1",
  at: "2026-10-13T12:00:00.000Z",
  source: "chat",
  kind: "chat.error",
  class: "bad",
  title: "default on atlas could not answer",
  detail: "CHAT_TURN_FAILED - rate limited",
  agent: "atlas",
  ref: "atlas/default",
  actions: [{ label: "Open chat", target: "chat", ref: "atlas/default" }],
  muted: false,
};

describe("what a push says", () => {
  test("a reply preview is redacted, flattened and cut to 140", () => {
    const long = `line one\n\n${"word ".repeat(60)}`;
    const preview = previewText(long);
    expect(preview.length).toBeLessThanOrEqual(140);
    expect(preview.endsWith("…")).toBe(true);
    expect(preview).not.toContain("\n");
    const secret = previewText("the key is sk-ant-api03-FIXTUREFIXTUREFIXTUREFIXTUREFIXTURE ok");
    expect(secret).not.toContain("FIXTUREFIXTUREFIXTURE");
  });

  test("turn.done carries the preview, or a fixed body with previews off", () => {
    const on = buildPush({ kind: "turn.done", turn: TURN, reply: "All green." }, { previews: true });
    expect(on?.message.title).toBe("default · atlas");
    expect(on?.message.body).toBe("All green.");
    expect(on?.message.data).toMatchObject({
      kind: "turn.done",
      turn_id: "t1",
      dedupe: "turn:t1:done",
    });
    const off = buildPush({ kind: "turn.done", turn: TURN, reply: "All green." }, { previews: false });
    expect(off?.message.body).toBe("Reply ready");
    expect(JSON.stringify(off)).not.toContain("All green");
  });

  test("needs_action names the category and the request; previews off says only 'Needs you'", () => {
    const block = {
      kind: "approval" as const,
      tool: "terminal",
      summary: "rm -rf /var/cache/fixture-build",
      request_id: "req-1",
      choices: ["once" as const, "deny" as const],
    };
    const on = buildPush(
      { kind: "needs_action", instance: "atlas", bot: "default", session: "s1", block },
      { previews: true },
    );
    expect(on?.message.categoryId).toBe("hermetic.approval");
    expect(on?.message.body).toBe("Approval needed: rm -rf /var/cache/fixture-build");
    expect(on?.message.data).toMatchObject({
      request_kind: "approval",
      request_id: "req-1",
      dedupe: "req:req-1",
    });
    const off = buildPush(
      { kind: "needs_action", instance: "atlas", bot: "default", session: "s1", block },
      { previews: false },
    );
    expect(off?.message.body).toBe("Needs you");
    const question = buildPush(
      {
        kind: "needs_action",
        instance: "atlas",
        bot: "default",
        session: null,
        block: { kind: "question", prompt: "Keep going?", choices: ["Yes", "No"], request_id: "q-1" },
      },
      { previews: true },
    );
    expect(question?.message.categoryId).toBe("hermetic.question");
    expect(question?.message.body).toBe("Keep going?");
    // No request id: nothing a phone could answer.
    expect(
      buildPush(
        {
          kind: "needs_action",
          instance: "a",
          bot: "b",
          session: null,
          block: { ...block, request_id: null },
        },
        { previews: true },
      ),
    ).toBeNull();
  });

  test("a notification is its title, with the detail only when previews are on", () => {
    const on = buildPush({ kind: "notification", row: ROW }, { previews: true });
    expect(on?.message).toMatchObject({ title: ROW.title, body: "CHAT_TURN_FAILED - rate limited" });
    expect(on?.message.data).toMatchObject({
      id: "n1",
      dedupe: "notif:n1",
      target: "chat",
      ref: "atlas/default",
    });
    const off = buildPush({ kind: "notification", row: ROW }, { previews: false });
    expect(off?.message.body).toBeUndefined();
  });
});

describe("the notifier", () => {
  test("sends each key to each device once, skips live, disabled and unregistered devices", async () => {
    const store = new MemoryMobileStore();
    store.insertDevice(device("a"));
    store.insertDevice(device("b"));
    store.insertDevice(device("c", { enabled: false }));
    store.insertDevice(device("d", { expo_push_token: null }));
    const sender = memoryPushSender();
    const notifier = createPushNotifier({ store, sender, isLive: (id) => id === "b" });
    await notifier.notify({ kind: "turn.done", turn: TURN, reply: "ok" });
    await notifier.notify({ kind: "turn.done", turn: TURN, reply: "ok" });
    expect(sender.sent.map((m) => m.to)).toEqual(["ExponentPushToken[FIXTURE-a]"]);
  });

  test("only phones paired for the fleet served now are pushed to, and none with no fleet", async () => {
    const store = new MemoryMobileStore();
    store.insertDevice(device("a"));
    store.insertDevice(device("b", { fleet_id: "zzzz9999" }));
    store.insertDevice(device("c", { fleet_id: null }));
    const sender = memoryPushSender();
    let fleet: string | null = "fxtr0001";
    const notifier = createPushNotifier({ store, sender, isLive: () => false, fleetId: () => fleet });
    await notifier.notify({ kind: "notification", row: ROW });
    expect(sender.sent.map((m) => m.to)).toEqual(["ExponentPushToken[FIXTURE-a]"]);
    fleet = null;
    await notifier.notify({ kind: "turn.done", turn: TURN, reply: "ok" });
    expect(sender.sent).toHaveLength(1);
  });

  test("DeviceNotRegistered forgets the push token", async () => {
    const store = new MemoryMobileStore();
    store.insertDevice(device("a"));
    store.insertDevice(device("b"));
    const sender = memoryPushSender((m) =>
      m.to.includes("-a]")
        ? { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } }
        : { status: "ok", id: "x" },
    );
    const notifier = createPushNotifier({ store, sender, isLive: () => false });
    await notifier.notify({ kind: "notification", row: ROW });
    expect(store.device("a")?.expo_push_token).toBeNull();
    expect(store.device("b")?.expo_push_token).toBe("ExponentPushToken[FIXTURE-b]");
  });

  test("a sender that throws is swallowed", async () => {
    const store = new MemoryMobileStore();
    store.insertDevice(device("a"));
    const notifier = createPushNotifier({
      store,
      sender: async () => {
        throw new Error("boom");
      },
      isLive: () => false,
    });
    await notifier.notify({ kind: "notification", row: ROW });
  });
});

describe("the Expo sender", () => {
  test("posts batches of 100 and maps receipts, failures included", async () => {
    const bodies: ExpoPushMessage[][] = [];
    let call = 0;
    const sender = expoPushSender(async (url, init) => {
      expect(url).toBe("https://exp.host/--/api/v2/push/send");
      const batch = JSON.parse(String(init?.body)) as ExpoPushMessage[];
      bodies.push(batch);
      call++;
      if (call === 2) return new Response("nope", { status: 503 });
      return Response.json({
        data: batch.map((_, i) =>
          i === 0
            ? { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } }
            : { status: "ok", id: `r${i}` },
        ),
      });
    });
    const messages = Array.from({ length: 250 }, (_, i) => ({
      to: `ExponentPushToken[FIXTURE-${i}]`,
      title: "t",
      data: {},
    }));
    const receipts = await sender(messages);
    expect(bodies.map((b) => b.length)).toEqual([100, 100, 50]);
    expect(receipts).toHaveLength(250);
    expect(receipts[0]).toEqual({
      status: "error",
      message: "gone",
      details: { error: "DeviceNotRegistered" },
    });
    expect(receipts[1]).toEqual({ status: "ok", id: "r1" });
    expect(receipts[100]?.status).toBe("error");
    expect(receipts[249]).toEqual({ status: "ok", id: "r49" });
  });

  test("an unreachable service is a receipt per message, not a throw", async () => {
    const sender = expoPushSender(async () => {
      throw new Error("offline");
    });
    const receipts = await sender([{ to: "x", title: "t", data: {} }]);
    expect(receipts).toEqual([{ status: "error", message: "push service unreachable" }]);
  });
});
