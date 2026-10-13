import { type Alert, createHermeticClient, pairDevice, replyPreview } from "../../src/client/client.ts";
import type { FetchLike } from "../../src/client/http.ts";
import { FakeTimers, flush, socketFactory } from "../helpers/fakes.ts";
import { approval, block, delta, done, hello, msg, notification } from "../helpers/fixtures.ts";

const T = { instance: "atlas", bot: "scribe", session: null };

async function connected() {
  const timers = new FakeTimers();
  const factory = socketFactory();
  const alerts: Alert[] = [];
  const fetch: FetchLike = async () => ({ ok: true, status: 200, text: async () => "{}" });
  const { credentials } = await pairDevice({
    baseUrl: "http://127.0.0.1:7877",
    code: "ABCD1234",
    device_name: "FIXTURE phone",
    platform: "ios",
    fetch: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ token: "hmt_FIXTURE", device_id: "dev1", hello: hello() }),
    }),
    now: () => 0,
  });
  expect(credentials).toMatchObject({
    token: "hmt_FIXTURE",
    device_id: "dev1",
    baseUrl: "http://127.0.0.1:7877",
  });
  const client = createHermeticClient({
    credentials,
    createSocket: factory.create,
    fetch,
    timers,
    random: () => 0,
    onAlert: (a) => alerts.push(a),
  });
  client.connect();
  const ws = factory.current();
  ws.open();
  ws.push({ type: "auth.ok", hello: hello() });
  // answer every rpc the client makes on connect with something plausible
  const answer = () => {
    for (const f of ws.sent) {
      if (f.type !== "rpc" || answered.has(f.id)) continue;
      answered.add(f.id);
      const result =
        f.method === "notifications.list"
          ? {
              notifications: [],
              unread: 0,
              needs_action: 0,
              snoozed: 0,
              history: 0,
              next_snooze_at: null,
              mutes: [],
            }
          : f.method === "chat.history"
            ? {
                instance: "atlas",
                bot: "scribe",
                session: "s-1",
                messages: [msg({ id: "m1", text: "All done" })],
              }
            : f.method === "chat.sessions"
              ? { instance: "atlas", bot: "scribe", sessions: [] }
              : {};
      ws.push({ type: "res", id: f.id, ok: true, result });
    }
  };
  const answered = new Set<string>();
  return { client, ws, alerts, timers, answer };
}

test("replyPreview folds and truncates", () => {
  expect(replyPreview(msg({ text: "a\n\nb" }))).toBe("a b");
  expect(replyPreview(msg({ text: "x".repeat(200) }))!.length).toBe(140);
  expect(replyPreview(null)).toBeNull();
});

test("a turn streamed over the socket lands in the conversation and raises one alert in background", async () => {
  const { client, ws, alerts, answer } = await connected();
  client.setPhase("background");
  expect(client.conversations.send(T, "hello")).toBe(true);
  const start = ws.last("turn.start");
  expect(start.turn).toMatchObject({ instance: "atlas", bot: "scribe", message: "hello" });
  expect(start.target).toEqual({
    account_id: "123456789012",
    region: "us-west-2",
    fleet_id: "fxtr0001",
  });
  ws.push({ type: "res", id: start.id, ok: true, result: { turn_id: "T1" } });
  await flush();
  ws.push({ type: "turn.frame", turn_id: "T1", n: 1, frame: delta(0, "All ") });
  ws.push({ type: "turn.frame", turn_id: "T1", n: 2, frame: delta(1, "done") });
  expect(client.conversations.view(T).live?.blocks).toEqual([{ kind: "text", markdown: "All done" }]);
  ws.push({ type: "turn.frame", turn_id: "T1", n: 3, frame: done(2) });
  ws.push({ type: "turn.end", turn_id: "T1", n: 3, state: "done" });
  await flush();
  answer();
  await flush();
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toMatchObject({
    decision: "local",
    title: "scribe · atlas",
    body: "All done",
    data: { kind: "turn.done", turn_id: "T1", dedupe: "turn:T1:done" },
  });
  // The same event arriving again (a push) is already claimed.
  expect(client.inbox.dedupe.claim("turn:T1:done")).toBe(false);
});

test("an approval in a followed turn raises a needs-you alert with the approval category", async () => {
  const { client, ws, alerts } = await connected();
  client.setPhase("background");
  client.conversations.send(T, "do it");
  ws.push({ type: "res", id: ws.last("turn.start").id, ok: true, result: { turn_id: "T2" } });
  await flush();
  ws.push({ type: "turn.frame", turn_id: "T2", n: 1, frame: block(0, approval()) });
  expect(alerts).toEqual([
    expect.objectContaining({
      category: "hermetic.approval",
      body: "Approval needed: rm -rf build",
      data: expect.objectContaining({ kind: "needs_action", request_id: "r1", dedupe: "req:r1" }),
    }),
  ]);
});

test("notification frames update the inbox and alert unless watching", async () => {
  const { client, ws, alerts } = await connected();
  client.setWatched({ instance: "atlas", bot: "scribe", focused: true });
  ws.push({
    type: "notification",
    row: notification({ id: "n1" }),
    counts: { unread: 1, needs_action: 0 },
  });
  expect(client.inbox.getState().rows).toHaveLength(1);
  expect(alerts).toHaveLength(0);
  ws.push({
    type: "notification",
    row: notification({
      id: "n2",
      ref: "kestrel/ops",
      title: "ops replied",
      detail: "deploy finished",
    }),
    counts: { unread: 2, needs_action: 0 },
  });
  expect(alerts).toEqual([
    expect.objectContaining({ decision: "banner", title: "ops replied", body: "deploy finished" }),
  ]);
  expect(client.inbox.badgeCount()).toBe(2);
});

test("listening frames reach the roster", async () => {
  const { client, ws } = await connected();
  ws.push({ type: "listening", instances: ["atlas", "kestrel"] });
  expect(client.roster.getState().listening).toEqual(["atlas", "kestrel"]);
  client.dispose();
  expect(client.socket.state).toBe("idle");
});

test("the app phase reaches the bridge as a phase frame on the injected socket", async () => {
  const { client, ws } = await connected();
  expect(ws.last("phase")).toEqual({ type: "phase", phase: "foreground" });
  client.setPhase("background");
  expect(ws.last("phase")).toEqual({ type: "phase", phase: "background" });
  client.setPhase("inactive");
  client.setPhase("active");
  expect(ws.sent.filter((f) => f.type === "phase").map((f) => (f as { phase: string }).phase)).toEqual([
    "foreground",
    "background",
    "foreground",
  ]);
});
