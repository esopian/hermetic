import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHermetic } from "../src/open.ts";
import { createCanonicalSessions } from "../src/render/hermes-canonical.ts";
import { createBotMode } from "../src/chat/bot-mode.ts";
import { fixtureHermesChat } from "../src/chat/chat.ts";
import type { HermesChatClient } from "../src/chat/hermes/hermes-chat.ts";
import { MemoryInstanceListeningStore } from "../src/chat/instance-listening.ts";
import { FIXTURE_CONFIG, MemoryBackend, seedFixtureFleet } from "../src/backend/memory.ts";
import { FIXTURE_LEGACY_GATEWAY } from "../src/backend/fixture/fixture-bot-mode.ts";
import type { StackInfo } from "../src/backend/types.ts";
import { HermeticError } from "../src/errors.ts";
const botModeBackend = seedFixtureFleet(new MemoryBackend());
const botModeAgents = await botModeBackend.store.agents.scan();
const seededFleet = await botModeBackend.store.fleet.get();
if (seededFleet === null) throw new Error("the fixture seed writes a fleet item");
/** Narrowed once, because `ChatDeps.guardFleet` promises a fleet and not a maybe. */
const botModeFleet = seededFleet;
const homes: string[] = [];
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "hermetic-bot-mode-"));
  homes.push(home);
  const h = await openHermetic({ fixture: true, home });
  await h.chat.listen({ instance: "atlas", listening: true });
  await h.chat.listen({ instance: "corvid", listening: true });
  return h;
}
const box = { instance: "atlas", baseUrl: "https://fixture.invalid" };
function canonicalHarness(
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const service = createCanonicalSessions({
    now: () => "2026-09-18T00:00:00Z",
    patch: async () => ({ ok: true, archived: true }),
    connect: async () => ({
      request: async (method, params) => {
        calls.push({ method, params });
        return request(method, params);
      },
      close() {},
    }),
  });
  return { service, calls };
}
describe("canonical identity", () => {
  test("reads exact title and follows compression without warming or creating", async () => {
    const h = canonicalHarness(async () => ({
      sessions: [
        { id: "root", resolved_id: "tip", title: "Bot Chat" },
        { id: "routine", title: "Newest job" },
      ],
    }));
    expect(await h.service.conversation(box, "research")).toEqual({
      instance: "atlas",
      bot: "research",
      root_session: "root",
      session: "tip",
      kind: "canonical",
      created: false,
    });
    expect(h.calls).toEqual([
      {
        method: "session.list",
        params: { profile: "research", title: "Bot Chat", include_hidden: true, limit: 100 },
      },
    ]);
  });
  test("empty passive read never creates a conversation", async () => {
    const h = canonicalHarness(async () => ({ sessions: [] }));
    expect(await h.service.conversation(box, "default")).toBeNull();
    expect(h.calls.map((c) => c.method)).toEqual(["session.list"]);
  });
  test("scope failure never retries without the profile", async () => {
    const h = canonicalHarness(async () => {
      throw new HermeticError("FORBIDDEN", "Scoped read refused");
    });
    await expect(h.service.conversation(box, "private")).rejects.toThrow("Scoped read refused");
    expect(h.calls).toHaveLength(1);
  });
  test("concurrent first opens persist one title before returning", async () => {
    let stored = false;
    const h = canonicalHarness(async (method) => {
      if (method === "profiles.list")
        return {
          bot_mode_protocol: true,
          profiles: [{ name: "default", ui_meta: { "hermes-bots": { version: 1 } } }],
        };
      if (method === "session.list")
        return { sessions: stored ? [{ id: "root", title: "Bot Chat" }] : [] };
      if (method === "session.create") return { session_id: "runtime", stored_session_id: "root" };
      if (method === "session.title") {
        stored = true;
        return { title: "Bot Chat" };
      }
      throw new Error(method);
    });
    const result = await Promise.all([
      h.service.conversation(box, "default", { create: true }),
      h.service.conversation(box, "default", { create: true }),
    ]);
    expect(result[0]?.session).toBe("root");
    expect(result[1]?.session).toBe("root");
    expect(h.calls.filter((c) => c.method === "session.create")).toHaveLength(1);
    expect(h.calls.find((c) => c.method === "session.create")?.params).toMatchObject({
      title: "Bot Chat",
      source: "hermetic",
    });
    expect(h.calls.at(-1)?.method).toBe("session.title");
  });
  test("a new separate session and a compaction are stamped source: hermetic", async () => {
    const h = canonicalHarness(async (method) => {
      if (method === "session.create") return { session_id: "runtime", stored_session_id: "stored" };
      if (method === "session.title") return { title: "Chat" };
      if (method === "session.list") return { sessions: [{ id: "root", title: "Bot Chat" }] };
      if (method === "session.resume") return { session_id: "runtime" };
      if (method === "session.compress") return { status: "compressed" };
      throw new Error(method);
    });
    await h.service.conversation(box, "default", { new_session: true });
    await h.service.compact(box, "default");
    expect(h.calls.find((c) => c.method === "session.create")?.params).toMatchObject({
      source: "hermetic",
    });
    expect(h.calls.find((c) => c.method === "session.resume")?.params).toMatchObject({
      session_id: "root",
      source: "hermetic",
    });
  });
  test("a compressed row is canonical by its root title, as the session list reads it", async () => {
    // `mapSessions` classifies `kind: "canonical"` from `root_title ?? title`;
    // this lookup has to agree or a row is canonical in one read and absent
    // from the other.
    const h = canonicalHarness(async () => ({
      sessions: [{ id: "root", resolved_id: "tip", root_title: "Bot Chat", title: "x" }],
    }));
    const found = await h.service.conversation(box, "research");
    expect(found?.root_session).toBe("root");
    expect(found?.kind).toBe("canonical");
  });
  test("rejects another profile's canonical row", async () => {
    // Upstream's title summary omits `profile` at this pin; the guard is for
    // the shapes that carry it, which `mapSessions` filters on too.
    const h = canonicalHarness(async () => ({
      sessions: [{ id: "wrong", title: "Bot Chat", profile: "private" }],
    }));
    await expect(h.service.conversation(box, "default")).rejects.toThrow("another profile");
  });
  test("an archived Bot Chat is a named conflict, not an endless retry", async () => {
    // Upstream hides an archived session from the title lookup but keeps its
    // UNIQUE title, so create collides and the second look still finds nothing.
    const h = canonicalHarness(async (method) => {
      if (method === "profiles.list")
        return {
          bot_mode_protocol: true,
          profiles: [{ name: "default", ui_meta: { "hermes-bots": {} } }],
        };
      if (method === "session.list") return { sessions: [] };
      if (method === "session.create") return { session_id: "runtime", stored_session_id: "stored" };
      if (method === "session.title") throw new Error("Title 'Bot Chat' is already in use");
      throw new Error(method);
    });
    const failed = await h.service.conversation(box, "default", { create: true }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(failed).toBeInstanceOf(HermeticError);
    expect((failed as HermeticError).code).toBe("CONFLICT");
    // The message states what was observed — the title is taken by a session
    // this gateway does not list — and names archival as the likely cause, not
    // as a certainty: the same branch catches a row that has not landed yet.
    expect((failed as HermeticError).message).toContain("does not list");
    expect((failed as HermeticError).message).toContain("most likely archived");
    expect((failed as HermeticError).message).toContain("--session");
    expect((failed as HermeticError).message).not.toContain("retry");
  });
  test("title uniqueness conflict adopts another client's winner", async () => {
    let lists = 0;
    const h = canonicalHarness(async (method) => {
      if (method === "profiles.list")
        return {
          bot_mode_protocol: true,
          profiles: [{ name: "default", ui_meta: { "hermes-bots": {} } }],
        };
      if (method === "session.list")
        return {
          sessions: ++lists > 1 ? [{ id: "winner", resolved_id: "compressed", title: "Bot Chat" }] : [],
        };
      if (method === "session.create")
        return { session_id: "loser-runtime", stored_session_id: "loser" };
      if (method === "session.title") throw new Error("title already in use");
      throw new Error(method);
    });
    expect((await h.service.conversation(box, "default", { create: true }))?.session).toBe(
      "compressed",
    );
    expect(h.calls.some((c) => c.method === "prompt.submit")).toBe(false);
  });
});
describe("Bot Mode real surface in fixture mode", () => {
  test("watching gates all new scopes and no provider credential profile is created", async () => {
    const h = await fixture();
    await h.chat.listen({ instance: "atlas", listening: false });
    await expect(h.bots.get({ instance: "atlas", bot: "default" })).rejects.toThrow("listen");
    await expect(h.routines.list({ instance: "atlas", bot: "default" })).rejects.toThrow("listen");
    await expect(h.rooms.list({ instance: "atlas" })).rejects.toThrow("listen");
  });
  test("profile creation, canonical open and separate sessions retain identity", async () => {
    const h = await fixture();
    const profile = await h.bots.create({
      instance: "atlas",
      name: "librarian",
      soul: "Organize sources",
      description: "Library",
    });
    expect(profile.soul).toBe("Organize sources");
    const first = await h.chat.open({ instance: "atlas", bot: "librarian" });
    const separate = await h.chat.open({ instance: "atlas", bot: "librarian", new_session: true });
    expect(separate.session).not.toBe(first.session);
    expect((await h.chat.open({ instance: "atlas", bot: "librarian" })).session).toBe(first.session);
    const empty = await h.chat.history({ instance: "atlas", bot: "librarian" });
    expect(empty.session).toBe(first.session);
    expect(empty.messages).toEqual([]);
    expect(
      (await h.chat.swarms({ instance: "atlas" })).swarms[0]?.bots.some((b) => b.name === "librarian"),
    ).toBe(true);
    await expect(h.bots.delete({ instance: "atlas", bot: "default", confirm: true })).rejects.toThrow(
      "default",
    );
  });
  test("routines are profile scoped, editable and retain run history", async () => {
    const h = await fixture();
    const ref = { instance: "atlas", bot: "default" };
    const job = await h.routines.create({
      ...ref,
      name: "Daily brief",
      prompt: "Summarize",
      schedule: "0 8 * * *",
      deliver: "local",
    });
    expect(job.deliver).toBe("local");
    expect((await h.routines.list({ instance: "corvid", bot: "default" })).jobs).toHaveLength(0);
    await h.routines.update({ ...ref, id: job.id, paused: true });
    expect((await h.routines.list(ref)).jobs[0]?.paused).toBe(true);
    await h.routines.update({ ...ref, id: job.id, name: "Morning report", deliver: "bot" });
    const run = await h.routines.run({ ...ref, id: job.id });
    expect(run.paused).toBe(false);
    expect((await h.routines.history({ ...ref, id: job.id })).runs).toHaveLength(1);
    await h.routines.delete({ ...ref, id: job.id, confirm: true });
    expect((await h.routines.list(ref)).jobs).toHaveLength(0);
  });
  test("rooms share ordered history and reject cross-instance execution", async () => {
    const h = await fixture();
    const members = [
      { instance: "atlas", bot: "default" },
      { instance: "atlas", bot: "scribe" },
    ];
    await expect(
      h.rooms.create({
        instance: "atlas",
        room: "remote",
        name: "Remote",
        members: [members[0]!, { instance: "corvid", bot: "default" }],
      }),
    ).rejects.toThrow("Cross-instance");
    const room = await h.rooms.create({
      instance: "atlas",
      room: "review-room",
      name: "Review",
      members,
    });
    await h.rooms.send({
      instance: "atlas",
      room: room.id,
      text: "Compare notes",
      event_id: "event-1",
    });
    await h.rooms.send({
      instance: "atlas",
      room: room.id,
      text: "Compare notes",
      event_id: "event-1",
    });
    const history = await h.rooms.history({ instance: "atlas", room: room.id });
    expect(history.events.filter((e) => e.kind === "message.user")).toHaveLength(1);
    expect(history.events.filter((e) => e.kind === "message.member")).toHaveLength(2);
    expect(history.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    await h.rooms.control({ instance: "atlas", room: room.id, action: "stop" });
    await h.rooms.rename({ instance: "atlas", room: room.id, name: "Renamed", event_id: "rename-1" });
    expect((await h.rooms.get({ instance: "atlas", room: room.id })).name).toBe("Renamed");
  });
  test("archive retires canonical identity without deleting transcript", async () => {
    const h = await fixture();
    const ref = { instance: "atlas", bot: "default" },
      first = await h.chat.open(ref);
    await h.chat.archive({ ...ref, session: first.session });
    const next = await h.chat.open(ref);
    expect(next.session).not.toBe(first.session);
    expect((await h.chat.history({ ...ref, session: first.session })).messages.length).toBeGreaterThan(
      0,
    );
  });
});

describe("pending decision ownership", () => {
  test("answers the exact resumed request and never falls through to a different question", async () => {
    const h = canonicalHarness(async (method) =>
      method === "session.resume"
        ? {
            session_id: "runtime",
            open_requests: [
              {
                id: "request-1",
                method: "clarify",
                params: { session_id: "runtime", questions: [{ qid: "question-1" }] },
              },
            ],
          }
        : { status: "ok", remaining: [] },
    );
    const target = {
      instance: "atlas",
      bot: "research",
      session: "stored",
      request_id: "request-1",
      kind: "question" as const,
      answer: "Yes",
    };
    await expect(h.service.respond(box, { ...target, question_id: "wrong" })).rejects.toThrow(
      "exact pending question",
    );
    expect(await h.service.respond(box, { ...target, question_id: "question-1" })).toEqual({
      status: "ok",
      remaining: [],
    });
    expect(h.calls.find((c) => c.method === "session.resume")?.params).toMatchObject({
      profile: "research",
      session_id: "stored",
      source: "hermetic",
    });
    expect(h.calls.at(-1)).toEqual({
      method: "clarify.lock",
      params: {
        profile: "research",
        request_id: "request-1",
        question_id: "question-1",
        answer: "Yes",
      },
    });
  });
});

/**
 * `bots.capabilities`: every flag it reports has to rest on
 * something the gateway actually said.
 *
 * The double below is the gateway, because what is under test is not what
 * Hermes answers but what this module concludes from an answer — and the two
 * conclusions that matter are the negative ones. A gateway that 404s the job
 * registry is old; a gateway that 403s it is one this operator may not manage.
 * Both report `routines: false`, and an operator who cannot tell them apart
 * spends the afternoon upgrading a gateway that was never the problem.
 *
 * Nothing here reaches a network: `botModeRpc`/`botModeRest` are the stubs.
 */
const MODERN_GATEWAY = {
  protocol_version: 2,
  driver: true,
  persistent_process: true,
  methods: ["groups.create", "groups.send", "groups.state"],
  features: ["idempotent_send", "monotonic_log"],
};
interface GatewayStub {
  rpc?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  rest?: (method: string, path: string) => Promise<unknown>;
}
function gateway(stub: GatewayStub = {}) {
  const calls: string[] = [];
  const answer = async (method: string): Promise<unknown> => {
    if (method === "profiles.list") return { profiles: [{ name: "default" }, { name: "scribe" }] };
    if (method === "groups.capabilities") return MODERN_GATEWAY;
    if (method === "groups.create") return { room: { room_id: "review", name: "Review", members: [] } };
    if (method === "groups.send") return { accepted: true };
    throw new HermeticError("CHAT_PROTOCOL", `the double was not asked for ${method}`);
  };
  const hermes: HermesChatClient = {
    ...fixtureHermesChat({ delayMs: 0 }),
    botModeRpc: async (_box, method, params) => {
      calls.push(method);
      return stub.rpc ? stub.rpc(method, params) : answer(method);
    },
    botModeRest: async (_box, method, path) => {
      calls.push(`${method} ${path}`);
      return stub.rest ? stub.rest(method, path) : [];
    },
  };
  const listening = new MemoryInstanceListeningStore();
  for (const agent of botModeAgents) listening.set(botModeFleet.fleet_id, agent.name, true);
  const surface = createBotMode({
    guardFleet: () =>
      Promise.resolve({ config: FIXTURE_CONFIG, fleet: botModeFleet, stack: {} as StackInfo }),
    getAgent: (name: string) => {
      const found = botModeAgents.find((a) => a.name === name);
      if (found === undefined) throw new HermeticError("NOT_FOUND", `no fixture agent ${name}`);
      return Promise.resolve(found);
    },
    instanceListening: listening,
    hermes,
  });
  return { ...surface, calls };
}
const refuse = (code: "NOT_FOUND" | "FORBIDDEN", status: number) => async (): Promise<never> => {
  throw new HermeticError(code, `atlas: dashboard GET failed (HTTP ${status})`);
};
async function failureOf(work: Promise<unknown>): Promise<HermeticError> {
  const caught = await work.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(caught instanceof HermeticError)) throw new Error("expected a HermeticError");
  return caught;
}

describe("Bot Mode capability probes", () => {
  test("a missing routine registry reads as unsupported, not as a broken call", async () => {
    const g = gateway({ rest: refuse("NOT_FOUND", 404) });
    const c = await g.bots.capabilities({ instance: "atlas" });
    expect(c.routines).toBe(false);
    expect(c.detail.routines).toContain("unsupported by this gateway");
    expect(c.profiles).toBe(true);
    expect(c.hosted_rooms).toBe(true);
    expect(c.room_driver).toBe(true);
  });
  test("a refused routine registry reads as unauthorized, not as unsupported", async () => {
    const g = gateway({ rest: refuse("FORBIDDEN", 403) });
    const c = await g.bots.capabilities({ instance: "atlas" });
    expect(c.routines).toBe(false);
    expect(c.detail.routines).toContain("unauthorized for this session");
    expect(c.detail.routines).not.toContain("unsupported");
    expect(c.hosted_rooms).toBe(true);
  });
  test("a refused profile roster is one flag's answer and not the whole call's", async () => {
    const g = gateway({
      rpc: async (method) => {
        if (method === "profiles.list")
          throw new HermeticError("FORBIDDEN", "atlas: profile scope refused");
        return MODERN_GATEWAY;
      },
    });
    const c = await g.bots.capabilities({ instance: "atlas" });
    expect(c.profiles).toBe(false);
    expect(c.detail.profiles).toContain("unauthorized for this session");
    expect(c.routines).toBe(true);
    expect(c.hosted_rooms).toBe(true);
    expect(c.detail.hosted_rooms).toBeNull();
  });
  test("a refused hosted-room call degrades that flag instead of failing the read", async () => {
    const g = gateway({
      rpc: async (method) => {
        if (method === "groups.capabilities")
          throw new HermeticError("FORBIDDEN", "atlas: hosted rooms refused");
        return { profiles: [{ name: "default" }] };
      },
    });
    const c = await g.bots.capabilities({ instance: "atlas" });
    expect(c.hosted_rooms).toBe(false);
    expect(c.room_driver).toBe(false);
    expect(c.protocol_version).toBeNull();
    expect(c.reason).toContain("unauthorized for this session");
    expect(c.profiles).toBe(true);
  });
  test("a running driver is enough for local rooms when RoomLink is off", async () => {
    // What a v2026.9.24 gateway without a RoomLink secret answers: the room
    // service is running, and `persistent_process` comes from the disabled
    // RoomLink catalog, so it is false.
    const g = gateway({
      rpc: async (method) => {
        if (method === "groups.capabilities")
          return {
            ...MODERN_GATEWAY,
            persistent_process: false,
            room_link: { enabled: false, reason: "gateway_roomlink_secret_unavailable" },
          };
        if (method === "groups.create")
          return { room: { room_id: "review", name: "Review", members: [] } };
        return { profiles: [{ name: "default" }, { name: "scribe" }] };
      },
    });
    const c = await g.bots.capabilities({ instance: "atlas" });
    expect(c.room_driver).toBe(true);
    expect(c.status.room_driver).toBe("supported");
    expect(c.detail.room_driver).toBeNull();
    const room = await g.rooms.create({
      instance: "atlas",
      room: "review",
      name: "Review",
      members: [
        { instance: "atlas", bot: "default" },
        { instance: "atlas", bot: "scribe" },
      ],
    });
    expect(room.id).toBe("review");
  });
  test("a stopped driver refuses room work", async () => {
    const g = gateway({
      rpc: async (method) => {
        if (method === "groups.capabilities") return { ...MODERN_GATEWAY, driver: false };
        return { profiles: [{ name: "default" }, { name: "scribe" }] };
      },
    });
    const c = await g.bots.capabilities({ instance: "atlas" });
    expect(c.hosted_rooms).toBe(true);
    expect(c.room_driver).toBe(false);
    expect(c.status.room_driver).toBe("refused");
    expect(c.detail.room_driver).toContain("not running");
  });
  test("an unreachable box is never reported as an unsupported gateway", async () => {
    const g = gateway({
      rpc: async () => {
        throw new HermeticError("CHAT_UNREACHABLE", "atlas: the gateway did not answer");
      },
    });
    expect((await failureOf(g.bots.capabilities({ instance: "atlas" }))).code).toBe("CHAT_UNREACHABLE");
  });
  test("an older hosted-room protocol is reported by version and refuses room work", async () => {
    const g = gateway({
      rpc: async (method) => {
        if (method === "groups.capabilities")
          return { protocol_version: 1, driver: false, persistent_process: false, methods: [] };
        return { profiles: [{ name: "default" }, { name: "scribe" }] };
      },
    });
    const c = await g.bots.capabilities({ instance: "atlas" });
    expect(c.protocol_version).toBe(1);
    expect(c.hosted_rooms).toBe(false);
    expect(c.room_driver).toBe(false);
    expect(c.detail.hosted_rooms).toContain("version 1");
    const created = await failureOf(
      g.rooms.create({
        instance: "atlas",
        room: "review",
        name: "Review",
        members: [
          { instance: "atlas", bot: "default" },
          { instance: "atlas", bot: "scribe" },
        ],
      }),
    );
    expect(created.code).toBe("CHAT_PROTOCOL");
    expect(created.message).toContain("version 1");
    const sent = await failureOf(
      g.rooms.send({ instance: "atlas", room: "review", text: "Hello", event_id: "event-1" }),
    );
    expect(sent.code).toBe("CHAT_PROTOCOL");
  });
  test("a burst of sends probes the gateway once, and each instance on its own", async () => {
    const g = gateway();
    const send = (event_id: string, instance = "atlas") =>
      g.rooms.send({ instance, room: "review", text: "Compare notes", event_id });
    await send("event-1");
    await send("event-2");
    expect(g.calls.filter((c) => c === "groups.capabilities")).toHaveLength(1);
    expect(g.calls.filter((c) => c.startsWith("GET /api/cron/jobs"))).toHaveLength(1);
    await send("event-3", "corvid");
    expect(g.calls.filter((c) => c === "groups.capabilities")).toHaveLength(2);
  });
  test("the routine probe is the profile-scoped registry read and nothing wider", async () => {
    const g = gateway();
    await g.bots.capabilities({ instance: "atlas" });
    expect(g.calls.filter((c) => c.startsWith("GET /api/cron"))).toEqual([
      "GET /api/cron/jobs?profile=default",
    ]);
    expect(g.calls.some((c) => c.includes("profile=all"))).toBe(false);
  });
  test("the fixture gateway reports what it implements, and the old box reports less", async () => {
    const h = await fixture();
    await h.chat.listen({ instance: "kestrel", listening: true });
    const modern = await h.bots.capabilities({ instance: "atlas" });
    expect(modern).toMatchObject({
      profiles: true,
      routines: true,
      hosted_rooms: true,
      room_driver: true,
      protocol_version: 2,
      membership_edit: false,
      cross_instance_rooms: false,
      cross_instance_relay: false,
      reason: null,
    });
    expect(modern.room_features).toContain("idempotent_send");
    expect(modern.room_methods).toContain("groups.send");
    expect(Object.values(modern.detail)).toEqual([null, null, null, null]);
    const old = await h.bots.capabilities({ instance: FIXTURE_LEGACY_GATEWAY });
    expect(old).toMatchObject({ routines: false, hosted_rooms: false, room_driver: false });
    expect(old.protocol_version).toBe(1);
    expect(old.profiles).toBe(true);
    expect(old.detail.routines).toContain("unsupported by this gateway");
    expect(old.detail.hosted_rooms).toContain("version 1");
    const refused = await failureOf(
      h.rooms.send({
        instance: FIXTURE_LEGACY_GATEWAY,
        room: "review",
        text: "Hello",
        event_id: "event-1",
      }),
    );
    expect(refused.code).toBe("CHAT_PROTOCOL");
  });
});

/**
 * What a room log says about its own end, and what a repeated send says about
 * itself.
 *
 * The hosted-room protocol has no tail read — no reverse flag, no `before_seq`,
 * no negative offset — so `latest_seq` is the only way a client can aim a read
 * at the recent end of a long room. Dropping it forced every reader to walk the
 * transcript from seq 0.
 *
 * `idempotent` is the other flag worth keeping. An unknown delivery is not
 * permission to replay, so a retry carries the identity the first attempt
 * carried; this flag is the caller's only evidence that the retry reconciled
 * with the message already in the room rather than posting a second one. The
 * same id carrying *different* content is the opposite case — a mistake that
 * retrying can never fix — and it must not arrive spelled like a transport
 * failure.
 */
describe("tolerant reads of a gateway's own fields", () => {
  /** `1789000000000` is a millisecond epoch; `iso()` used to multiply it again. */
  const MILLIS = 1789000000000;
  test("a millisecond timestamp round-trips and an unparsable one reads as absent", async () => {
    const g = gateway({
      rest: async () => ({
        jobs: [
          {
            id: "job-1",
            name: "Nightly",
            prompt: "run it",
            schedule: "0 3 * * *",
            next_run_at: MILLIS,
            last_run_at: "not a date",
          },
        ],
      }),
    });
    const [job] = (await g.routines.list({ instance: "atlas", bot: "default" })).jobs;
    expect(job?.next_run_at).toBe(new Date(MILLIS).toISOString());
    expect(job?.next_run_at?.slice(0, 4)).toBe("2026");
    expect(job?.last_run_at).toBeNull();
  });
  test("a second-epoch timestamp is still read as seconds", async () => {
    const g = gateway({
      rest: async () => ({
        jobs: [{ id: "job-1", name: "N", prompt: "p", schedule: "@daily", next_run_at: MILLIS / 1000 }],
      }),
    });
    const [job] = (await g.routines.list({ instance: "atlas", bot: "default" })).jobs;
    expect(job?.next_run_at).toBe(new Date(MILLIS).toISOString());
  });
  test("an empty string is absence, so the next fallback in the chain answers", async () => {
    const g = gateway({
      rest: async () => ({
        runs: [{ id: "run-1", status: "", end_reason: "failed", preview: "", title: "Nightly" }],
      }),
    });
    const [run] = (await g.routines.history({ instance: "atlas", bot: "default", id: "job-1" })).runs;
    expect(run?.status).toBe("failed");
    expect(run?.text).toBe("Nightly");
  });
});

describe("hosted room tail reads and repeated sends", () => {
  const ROOM = { instance: "atlas", room: "review" };
  /** A gateway whose capability sweep passes, answering room calls with `rooms`. */
  const roomGateway = (rooms: (method: string, params: Record<string, unknown>) => unknown) =>
    gateway({
      rpc: async (method, params) => {
        if (method === "profiles.list") return { profiles: [{ name: "default" }] };
        if (method === "groups.capabilities") return MODERN_GATEWAY;
        return rooms(method, params);
      },
    });

  test("a history page carries the room's high-water mark, including when it is empty", async () => {
    const g = roomGateway((method, params) => {
      if (method !== "groups.log") throw new HermeticError("CHAT_PROTOCOL", `not asked for ${method}`);
      const since = Number(params.since_seq);
      return since >= 900
        ? { events: [], cursor: since, latest_seq: 900, has_more: false }
        : {
            events: [
              {
                room_id: "review",
                seq: 701,
                event_id: "e701",
                kind: "message.user",
                actor: { kind: "user", id: "operator" },
                payload: { text: "near the end" },
                created_at: "2026-09-18T00:00:00Z",
              },
            ],
            cursor: 701,
            latest_seq: 900,
            has_more: true,
          };
    });
    const page = await g.rooms.history({ ...ROOM, since_seq: 700 });
    expect(page.latest_seq).toBe(900);
    expect(page.cursor).toBe(701);
    expect(page.has_more).toBe(true);
    const empty = await g.rooms.history({ ...ROOM, since_seq: 900 });
    expect(empty.events).toHaveLength(0);
    expect(empty.latest_seq).toBe(900);
  });

  test("a gateway reporting no high-water mark never claims one ahead of its own log", async () => {
    const g = roomGateway(() => ({ events: [], cursor: 0, has_more: false }));
    // `since_seq` is the floor, not the answer: upstream refuses a read that
    // starts past the end, so a fabricated mark would break the next read.
    expect((await g.rooms.history({ ...ROOM, since_seq: 40 })).latest_seq).toBe(40);
  });

  test("a send says whether the gateway recognised the id or appended a new event", async () => {
    const g = roomGateway((method, params) => {
      if (method !== "groups.send") throw new HermeticError("CHAT_PROTOCOL", `not asked for ${method}`);
      return {
        accepted: true,
        event: { event_id: params.event_id, seq: 7, idempotent: params.event_id === "event-1" },
      };
    });
    const replayed = await g.rooms.send({ ...ROOM, text: "did this land", event_id: "event-1" });
    expect(replayed.duplicate).toBe(true);
    expect(replayed.event_id).toBe("event-1");
    expect((await g.rooms.send({ ...ROOM, text: "and this", event_id: "event-2" })).duplicate).toBe(
      false,
    );
  });

  test("an id reused for different text is a conflict, not a protocol failure", async () => {
    const g = roomGateway((method) => {
      if (method !== "groups.send") throw new HermeticError("CHAT_PROTOCOL", `not asked for ${method}`);
      // The wire shape of `EventConflictError`: one numeric room code, and a
      // message that is the only thing separating it from a disbanded room.
      throw new HermeticError(
        "CHAT_PROTOCOL",
        "atlas: event_id already exists with different content",
        { code: 4111 },
      );
    });
    const failed = await failureOf(g.rooms.send({ ...ROOM, text: "other text", event_id: "event-1" }));
    expect(failed.code).toBe("CONFLICT");
    expect(failed.message).toContain("different content");
  });

  test("the conflict wording is still recognised wrapped in a longer sentence", async () => {
    const g = roomGateway((method) => {
      if (method !== "groups.send") throw new HermeticError("CHAT_PROTOCOL", `not asked for ${method}`);
      // Same numeric code, but the message carries a lead-in sentence before
      // the phrase the matcher actually looks for — the matcher tests, it does
      // not anchor, so surrounding text must not defeat it.
      throw new HermeticError(
        "CHAT_PROTOCOL",
        "atlas: append_event refused — event_id already exists with different content",
        { code: 4111 },
      );
    });
    const failed = await failureOf(g.rooms.send({ ...ROOM, text: "other text", event_id: "event-1" }));
    expect(failed.code).toBe("CONFLICT");
  });

  test("an unrelated error under the same numeric room code is not mistaken for a conflict", async () => {
    const g = roomGateway((method) => {
      if (method !== "groups.send") throw new HermeticError("CHAT_PROTOCOL", `not asked for ${method}`);
      // `methods_groups.py` maps every `HostedRoomError` a send can raise onto
      // the same numeric code 4111, so a disbanded room and a reused id are
      // indistinguishable by code alone. Detection is message-text only
      // (`EVENT_CONFLICT`), so this must stay `CHAT_PROTOCOL`, not become a
      // false `CONFLICT` just because the code matches.
      throw new HermeticError("CHAT_PROTOCOL", "atlas: this room has been disbanded", { code: 4111 });
    });
    const failed = await failureOf(g.rooms.send({ ...ROOM, text: "other text", event_id: "event-1" }));
    expect(failed.code).toBe("CHAT_PROTOCOL");
    expect(failed.message).toContain("disbanded");
  });

  /**
   * Documents a known fragility, not a desired outcome: detection is a literal
   * match on upstream's exact wording (`EVENT_CONFLICT` in `bot-mode.ts`), so a
   * gateway that rewords the same refusal is read as an ordinary protocol
   * failure rather than a conflict. That is the safe direction to fail in —
   * `CHAT_PROTOCOL` surfaces as an error the caller sees, not a silently
   * swallowed retry loop or a wrong verdict — but it is still a miss this test
   * exists to keep visible.
   */
  test("a conflict reworded from upstream's exact phrasing degrades to CHAT_PROTOCOL rather than being recognised", async () => {
    const g = roomGateway((method) => {
      if (method !== "groups.send") throw new HermeticError("CHAT_PROTOCOL", `not asked for ${method}`);
      throw new HermeticError(
        "CHAT_PROTOCOL",
        "atlas: this event id is already bound to different content",
        { code: 4111 },
      );
    });
    const failed = await failureOf(g.rooms.send({ ...ROOM, text: "other text", event_id: "event-1" }));
    expect(failed.code).toBe("CHAT_PROTOCOL");
  });

  test("the fixture gateway answers a replay and a reused id the way upstream does", async () => {
    const h = await fixture();
    const members = [
      { instance: "atlas", bot: "default" },
      { instance: "atlas", bot: "scribe" },
    ];
    const room = await h.rooms.create({
      instance: "atlas",
      room: "replay-room",
      name: "Replay",
      members,
    });
    const target = { instance: "atlas", room: room.id };
    const first = await h.rooms.send({ ...target, text: "Compare notes", event_id: "event-1" });
    expect(first.duplicate).toBe(false);
    expect(
      (await h.rooms.send({ ...target, text: "Compare notes", event_id: "event-1" })).duplicate,
    ).toBe(true);
    const page = await h.rooms.history(target);
    expect(page.latest_seq).toBe(3);
    expect(page.events).toHaveLength(3);
    expect((await h.rooms.history({ ...target, since_seq: 3 })).latest_seq).toBe(3);
    const failed = await failureOf(
      h.rooms.send({ ...target, text: "something else entirely", event_id: "event-1" }),
    );
    expect(failed.code).toBe("CONFLICT");
  });
});

/**
 * The second half of the same question: not only "what did the gateway say"
 * but "did it say anything at all".
 *
 * `CHAT_PROTOCOL` is the REST mapper's catch-all — a 500, a truncated body, an
 * expired token all arrive under it — and reading one as "this capability is
 * unavailable", then caching it, hides a feature the box has for as long as the
 * memo lives. These tests pin the three ways a probe can end (answered, refused,
 * nothing learned), what each does to the memo, and which profile the routine
 * probe is allowed to name.
 */
describe("Bot Mode capability certainty", () => {
  const fault = (status: number) => async (): Promise<never> => {
    throw new HermeticError("CHAT_PROTOCOL", `atlas: dashboard GET failed (HTTP ${status})`);
  };
  const cronCalls = (g: { calls: string[] }) => g.calls.filter((c) => c.startsWith("GET /api/cron"));

  test("a gateway fault reads as unknown and is never cached", async () => {
    const g = gateway({ rest: fault(500) });
    const first = await g.bots.capabilities({ instance: "atlas" });
    expect(first.status.routines).toBe("unknown");
    expect(first.routines).toBe(false);
    expect(first.detail.routines).toContain("could not be determined");
    expect(first.detail.routines).not.toContain("unsupported by this gateway");
    const second = await g.bots.capabilities({ instance: "atlas" });
    expect(second.status.routines).toBe("unknown");
    // Both calls probed: an unknown is re-asked, not served from the memo.
    expect(cronCalls(g)).toHaveLength(2);
  });

  test("a definitive 404 is still cached for the memo's lifetime", async () => {
    const g = gateway({ rest: refuse("NOT_FOUND", 404) });
    const first = await g.bots.capabilities({ instance: "atlas" });
    const second = await g.bots.capabilities({ instance: "atlas" });
    expect(first.status.routines).toBe("refused");
    expect(second.status.routines).toBe("refused");
    expect(second.routines).toBe(false);
    expect(cronCalls(g)).toHaveLength(1);
  });

  test("an aborted probe propagates the abort and leaves nothing cached", async () => {
    const control = new AbortController();
    let attempts = 0;
    const g = gateway({
      // The first probe races the caller's abort: the gateway's 404 arrives for
      // a call nobody wants an answer to any more, and a cancelled probe is
      // never a verdict on a capability.
      rest: async () => {
        if (attempts++ > 0) return [];
        control.abort();
        throw new HermeticError("NOT_FOUND", "atlas: dashboard GET failed (HTTP 404)");
      },
    });
    const stopped = await failureOf(
      g.bots.capabilities({ instance: "atlas" }, { signal: control.signal }),
    );
    expect(stopped.code).toBe("ABORTED");
    const live = new AbortController();
    const after = await g.bots.capabilities({ instance: "atlas" }, { signal: live.signal });
    expect(after.routines).toBe(true);
    expect(after.status.routines).toBe("supported");
    expect(cronCalls(g)).toHaveLength(2);
  });

  test("the routine probe names the profile the gateway calls its default", async () => {
    const g = gateway({
      rpc: async (method) => {
        if (method === "profiles.list")
          return { profiles: [{ name: "ops-nightly" }, { name: "atlas-main", is_default: true }] };
        return MODERN_GATEWAY;
      },
    });
    const c = await g.bots.capabilities({ instance: "atlas" });
    expect(cronCalls(g)).toEqual(["GET /api/cron/jobs?profile=atlas-main"]);
    expect(c.routines).toBe(true);
    expect(c.status.routines).toBe("supported");
  });

  test("with no gateway default the routine probe takes the first profile in a stable order", async () => {
    const g = gateway({
      rpc: async (method) => {
        if (method === "profiles.list") return { profiles: [{ name: "zephyr" }, { name: "beacon" }] };
        return MODERN_GATEWAY;
      },
    });
    await g.bots.capabilities({ instance: "atlas" });
    expect(cronCalls(g)).toEqual(["GET /api/cron/jobs?profile=beacon"]);
  });

  test("a roster this gateway would not name leaves routines unknown, not unsupported", async () => {
    const g = gateway({
      rpc: async (method) => {
        if (method === "profiles.list")
          throw new HermeticError("FORBIDDEN", "atlas: profile scope refused");
        return MODERN_GATEWAY;
      },
      rest: refuse("NOT_FOUND", 404),
    });
    const c = await g.bots.capabilities({ instance: "atlas" });
    expect(c.status.profiles).toBe("refused");
    expect(c.status.routines).toBe("unknown");
    expect(c.routines).toBe(false);
    expect(c.detail.routines).toContain("could not be determined");
    // Still scoped, never widened, and never cached.
    expect(cronCalls(g)).toEqual(["GET /api/cron/jobs?profile=default"]);
    await g.bots.capabilities({ instance: "atlas" });
    expect(cronCalls(g)).toHaveLength(2);
    expect(g.calls.some((c) => c.includes("profile=all"))).toBe(false);
  });
});

describe("bot titles", () => {
  /**
   * A gateway whose `scribe` row carries Desktop's look keys beside a title, at
   * revision 4, and which records every `profiles.configure` it is sent.
   */
  function titleGateway(reply: (params: Record<string, unknown>) => unknown) {
    const sent: Record<string, unknown>[] = [];
    const g = gateway({
      rpc: async (method, params) => {
        if (method === "profiles.list")
          return {
            profiles: [
              {
                name: "scribe",
                ui_meta: {
                  "hermes-bots": { title: "Scribe", shape: "hex", color: "#123456", custom: true },
                  other: { kept: true },
                },
                ui_meta_revisions: { "hermes-bots": 4, other: 9 },
              },
            ],
          };
        if (method === "profiles.configure") {
          sent.push(params);
          return reply(params);
        }
        if (method === "profiles.describe") return { name: "scribe" };
        throw new HermeticError("CHAT_PROTOCOL", `the double was not asked for ${method}`);
      },
    });
    return { g, sent };
  }
  const saved = () => ({
    ok: true,
    applied: { ui_meta: true, ui_meta_revisions: { "hermes-bots": 5 } },
  });
  const REF = { instance: "atlas", bot: "scribe" };

  test("a rename merges the title into the existing namespace, at the revision it read", async () => {
    const { g, sent } = titleGateway(saved);
    await g.bots.update({ ...REF, title: "  Marshall  " });
    expect(sent).toEqual([
      {
        name: "scribe",
        ui_meta: {
          "hermes-bots": { title: "Marshall", shape: "hex", color: "#123456", custom: true },
        },
        ui_meta_expected_revisions: { "hermes-bots": 4 },
      },
    ]);
  });

  test("a reset deletes the title and keeps every other key", async () => {
    for (const title of [null, "", "   "]) {
      const { g, sent } = titleGateway(saved);
      await g.bots.update({ ...REF, title });
      expect(sent[0]?.ui_meta).toEqual({
        "hermes-bots": { shape: "hex", color: "#123456", custom: true },
      });
    }
  });

  test("a revision conflict is a named CONFLICT, not a silent overwrite", async () => {
    const { g } = titleGateway(() => ({
      ok: true,
      applied: {
        ui_meta: false,
        ui_meta_conflicts: { "hermes-bots": { expected: 4, actual: 5 } },
        ui_meta_revisions: { "hermes-bots": 5 },
      },
    }));
    const error = await failureOf(g.bots.update({ ...REF, title: "Marshall" }));
    expect(error.code).toBe("CONFLICT");
    expect(error.message).toContain("revision 4 expected, 5 found");
  });

  test("an unapplied write fails, and a gateway without the contract is unsupported", async () => {
    const failed = titleGateway(() => ({ ok: false, applied: { ui_meta: false } }));
    expect((await failureOf(failed.g.bots.update({ ...REF, title: "M" }))).code).toBe("CONFLICT");
    const old = titleGateway(() => ({ ok: true }));
    const error = await failureOf(old.g.bots.update({ ...REF, title: "M" }));
    expect(error.code).toBe("CHAT_PROTOCOL");
    expect(error.message).toContain("titles");
  });

  test("an update without a title never reads or writes ui_meta", async () => {
    const { g, sent } = titleGateway(() => ({ ok: true, applied: { description: true } }));
    await g.bots.update({ ...REF, description: "Digest" });
    expect(sent).toEqual([{ name: "scribe", description: "Digest" }]);
    expect(g.calls).not.toContain("profiles.list");
  });

  test("a title over 64 characters is refused before the gateway is asked", async () => {
    const { g, sent } = titleGateway(saved);
    expect((await failureOf(g.bots.update({ ...REF, title: "x".repeat(65) }))).code).toBe("VALIDATION");
    expect(sent).toEqual([]);
  });

  test("in the fixture a rename changes the roster title and a reset restores the profile name", async () => {
    const h = await fixture();
    const scribe = async () =>
      (await h.chat.swarms({ instance: "atlas" })).swarms[0]?.bots.find((b) => b.name === "scribe");
    expect((await scribe())?.title).toBe("Marshall");
    await h.bots.update({ instance: "atlas", bot: "scribe", title: "Archivist" });
    expect((await scribe())?.title).toBe("Archivist");
    await h.bots.update({ instance: "atlas", bot: "scribe", title: null });
    expect((await scribe())?.title).toBe("scribe");
    // The default profile's title is its display name, which a reset leaves alone.
    await h.bots.update({ instance: "atlas", bot: "default", title: "Front desk" });
    const atlas = async () => (await h.chat.swarms({ instance: "atlas" })).swarms[0]?.bots;
    expect((await atlas())?.find((b) => b.is_default)?.title).toBe("Front desk");
    await h.bots.update({ instance: "atlas", bot: "default", title: "" });
    expect((await atlas())?.find((b) => b.is_default)?.title).toBe("atlas");
  });
});
