/**
 * `createKanban`: what the board concludes from each answer a box can give,
 * and the order of the two-step writes. The gateway is a `botModeRest` stub;
 * the last test runs the fixture end to end.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHermetic } from "../src/open.ts";
import { createKanban } from "../src/chat/kanban.ts";
import { fixtureHermesChat } from "../src/chat/chat.ts";
import { createHermesChat } from "../src/chat/hermes/hermes-chat.ts";
import type { ChatFetch, HermesChatClient } from "../src/chat/hermes/hermes-chat.ts";
import { DASHBOARD_HTML } from "./fixtures/hermes-frames.ts";
import { FIXTURE_CONFIG, MemoryBackend, seedFixtureFleet } from "../src/backend/memory.ts";
import type { StackInfo } from "../src/backend/types.ts";
import { HermeticError } from "../src/errors.ts";

const backend = seedFixtureFleet(new MemoryBackend());
const agents = (await backend.store.agents.scan()).filter((a) => a.name === "atlas");
const fleet = await backend.store.fleet.get();
if (fleet === null) throw new Error("the fixture seed writes a fleet item");

const TASK = { id: "t_0000abcd", title: "Card", status: "blocked", block_kind: "needs_input" };
const BOARD = {
  columns: [
    { name: "blocked", tasks: [TASK] },
    { name: "someday", tasks: [TASK] },
  ],
};

function kanban(rest: (method: string, path: string, body?: unknown) => Promise<unknown>) {
  const calls: string[] = [];
  const hermes: HermesChatClient = {
    ...fixtureHermesChat({ delayMs: 0 }),
    botModeRest: async (_box, method, path, body) => {
      calls.push(`${method} ${path}${body === undefined ? "" : ` ${JSON.stringify(body)}`}`);
      return rest(method, path, body);
    },
  };
  const surface = createKanban({
    guardFleet: () =>
      Promise.resolve({ config: FIXTURE_CONFIG, fleet: fleet!, stack: {} as StackInfo }),
    getAgent: async (name) => {
      const found = agents.find((a) => a.name === name);
      if (!found) throw new HermeticError("NOT_FOUND", `no agent ${name}`);
      return found;
    },
    listAgents: async () => agents,
    hermes,
  });
  return { ...surface.kanban, calls };
}
const throws = (code: "NOT_FOUND" | "FORBIDDEN" | "CHAT_PROTOCOL" | "CHAT_UNREACHABLE") => async () => {
  throw new HermeticError(code, `atlas: ${code}`);
};

describe("kanban.board state", () => {
  test("a board answer is on, columns flattened, an unknown column dropped", async () => {
    const k = kanban(async (_m, path) =>
      path.endsWith("/board")
        ? BOARD
        : path.endsWith("/profiles")
          ? { profiles: [{ name: "default" }, { name: "researcher" }] }
          : { current: "default" },
    );
    const [atlas] = (await k.board({})).instances;
    expect(atlas).toMatchObject({ state: "on", board: "default", profiles: ["default", "researcher"] });
    expect(atlas!.tasks.map((t) => [t.id, t.status, t.comment_count])).toEqual([
      ["t_0000abcd", "blocked", 0],
    ]);
  });

  test("a 404 is off, with the enable hint", async () => {
    const [atlas] = (await kanban(throws("NOT_FOUND")).board({})).instances;
    expect(atlas).toMatchObject({ state: "off", hint: "hermes plugins enable kanban", tasks: [] });
  });

  test("a 403 is not the disabled-plugin gate: unknown, naming the refusal", async () => {
    const [atlas] = (await kanban(throws("FORBIDDEN")).board({})).instances;
    expect(atlas).toMatchObject({ state: "unknown", hint: null, reason: "atlas: FORBIDDEN" });
  });

  test("CHAT_PROTOCOL and a non-board body are unknown", async () => {
    expect((await kanban(throws("CHAT_PROTOCOL")).board({})).instances[0]!.state).toBe("unknown");
    expect((await kanban(async () => "<html>").board({})).instances[0]!.state).toBe("unknown");
  });

  test("unreachable shows the last good read, marked stale; no read means no tasks", async () => {
    expect((await kanban(throws("CHAT_UNREACHABLE")).board({})).instances[0]).toMatchObject({
      state: "unreachable",
      tasks: [],
      stale_since: null,
    });
    let up = true;
    const k = kanban(async (_m, path) => {
      if (!up) throw new HermeticError("CHAT_UNREACHABLE", "atlas: down");
      return path.endsWith("/board") ? BOARD : {};
    });
    const first = (await k.board({ instance: "atlas" })).instances[0]!;
    up = false;
    const second = (await k.board({ instance: "atlas" })).instances[0]!;
    expect(second).toMatchObject({ state: "unreachable", stale_since: first.read_at });
    expect(second.tasks.map((t) => t.id)).toEqual(["t_0000abcd"]);
    // The task drawer falls back to the same read.
    expect(await k.task({ instance: "atlas", id: "t_0000abcd" })).toMatchObject({
      task: { id: "t_0000abcd" },
      events: [],
      stale_since: first.read_at,
    });
  });
});

describe("kanban writes", () => {
  test("create defaults to scratch; dir and worktree need a path", async () => {
    const k = kanban(async (_m, _p, body) => ({
      task: { ...TASK, status: "ready", ...(body as object) },
    }));
    expect((await k.create({ instance: "atlas", title: "A" })).workspace_kind).toBe("scratch");
    await expect(
      k.create({ instance: "atlas", title: "A", workspace_kind: "dir" }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      message: expect.stringContaining("workspace_path is required"),
    });
    await expect(
      k.create({ instance: "atlas", title: "A", workspace_kind: "dir", workspace_path: "work/x" }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      message: expect.stringContaining("start with / or ~"),
    });
    expect(
      (
        await k.create({
          instance: "atlas",
          title: "A",
          workspace_kind: "dir",
          workspace_path: "~/work/x",
        })
      ).workspace_kind,
    ).toBe("dir");
    expect(k.calls).toHaveLength(2);
  });

  test("a refused unblock after the answer posted says the answer landed", async () => {
    const k = kanban(async (method) => {
      if (method === "PATCH")
        throw new HermeticError("CONFLICT", "atlas: dashboard PATCH failed (HTTP 409)");
      return { ok: true };
    });
    await expect(
      k.unblock({ instance: "atlas", id: "t_0000abcd", answer: "Yes." }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("answer was posted to t_0000abcd, but the unblock was refused"),
    });
    // No answer is not a refusal: the PATCH may have landed.
    const silent = kanban(async (method) => {
      if (method === "PATCH") throw new HermeticError("CHAT_UNREACHABLE", "atlas: down");
      return { ok: true };
    });
    await expect(
      silent.unblock({ instance: "atlas", id: "t_0000abcd", answer: "Yes." }),
    ).rejects.toMatchObject({
      code: "CHAT_UNREACHABLE",
      message: expect.stringContaining("the unblock did not get an answer"),
    });
  });

  test("unblock posts the answer, then moves the card to ready", async () => {
    const k = kanban(async (method) =>
      method === "PATCH" ? { task: { ...TASK, status: "ready" } } : { ok: true },
    );
    const task = await k.unblock({ instance: "atlas", id: "t_0000abcd", answer: "Under $100." });
    expect(task.status).toBe("ready");
    expect(k.calls).toEqual([
      'POST /api/plugins/kanban/tasks/t_0000abcd/comments {"body":"Under $100.","author":"hermetic"}',
      'PATCH /api/plugins/kanban/tasks/t_0000abcd {"status":"ready"}',
    ]);
  });

  test("delete needs confirm: true", async () => {
    const k = kanban(async () => ({ deleted: true, task_id: "t_0000abcd" }));
    await expect(k.delete({ instance: "atlas", id: "t_0000abcd" } as never)).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(k.calls).toEqual([]);
    expect(await k.delete({ instance: "atlas", id: "t_0000abcd", confirm: true })).toEqual({
      deleted: true,
    });
  });
});

const homes: string[] = [];
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

test("fixture: board, unblock, board", async () => {
  const home = mkdtempSync(join(tmpdir(), "hermetic-kanban-"));
  homes.push(home);
  const h = await openHermetic({ fixture: true, home });
  const states = (b: Awaited<ReturnType<typeof h.kanban.board>>) =>
    Object.fromEntries(b.instances.map((i) => [i.instance, i.state]));
  const before = await h.kanban.board({});
  expect(states(before)).toMatchObject({
    atlas: "on",
    corvid: "on",
    ember: "off",
    kestrel: "off",
    fathom: "unknown",
    heron: "on",
    juniper: "unreachable",
  });
  const atlas = (b: typeof before) => b.instances.find((i) => i.instance === "atlas")!;
  expect(atlas(before).tasks.find((t) => t.id === "t_8b20d6e1")?.status).toBe("blocked");

  await h.kanban.unblock({
    instance: "atlas",
    id: "t_8b20d6e1",
    answer: "Up to $100/mo; no self-hosting.",
  });
  const after = await h.kanban.board({});
  expect(atlas(after).tasks.find((t) => t.id === "t_8b20d6e1")?.status).toBe("ready");
  // heron answered once; now it is the stale row.
  expect(after.instances.find((i) => i.instance === "heron")).toMatchObject({
    state: "unreachable",
    tasks: [{ id: "t_b7d3e019" }],
  });
  const detail = await h.kanban.task({ instance: "atlas", id: "t_8b20d6e1" });
  expect(detail.comments.at(-1)).toMatchObject({
    author: "hermetic",
    body: "Up to $100/mo; no self-hosting.",
  });
  expect(detail.events.at(-1)?.kind).toBe("unblocked");
});

test("botModeRest appends a refused write's detail only when asked", async () => {
  const fetch: ChatFetch = async (url, init) =>
    String(url).endsWith("/")
      ? new Response(DASHBOARD_HTML, { headers: { "content-type": "text/html" } })
      : init?.method === "GET"
        ? Response.json({ detail: "task t_0000abcd not found" }, { status: 404 })
        : Response.json(
            { detail: "Cannot move to 'ready': blocked by parent(s) not done" },
            { status: 409 },
          );
  const chat = createHermesChat({
    fetch,
    now: () => "2026-10-22T12:00:00.000Z",
    openSocket: () => {
      throw new Error("no socket in this test");
    },
  });
  const box = { instance: "atlas", baseUrl: "https://atlas.example/", fleet_id: "fxtr0001" };
  const path = "/api/plugins/kanban/tasks/t_0000abcd";
  await expect(chat.botModeRest!(box, "PATCH", path, {}, { detail: true })).rejects.toMatchObject({
    code: "CONFLICT",
    message:
      "atlas: dashboard PATCH failed (HTTP 409): Cannot move to 'ready': blocked by parent(s) not done",
  });
  // A 404's detail names the task, so a deleted card reads apart from a missing board.
  await expect(chat.botModeRest!(box, "GET", path, undefined, { detail: true })).rejects.toMatchObject({
    code: "NOT_FOUND",
    message: "atlas: dashboard GET failed (HTTP 404): task t_0000abcd not found",
  });
  await expect(chat.botModeRest!(box, "PATCH", path, {})).rejects.toMatchObject({
    message: "atlas: dashboard PATCH failed (HTTP 409)",
  });
});
