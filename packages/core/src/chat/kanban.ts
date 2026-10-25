/**
 * Typed kanban board operations (§9.2 Bot Mode, issue #117). Upstream's kanban
 * plugin owns the board; this module reads and writes it through each box's
 * dashboard (`/api/plugins/kanban/*`, Hermes v0.21.5 `plugin_api.py`).
 *
 * The board is a fleet-wide view, so unlike the rest of Bot Mode it does not
 * require the instance to be watched (`dashboardBox(…, false)`).
 */
import * as S from "../schema/kanban.ts";
import type { ChatDeps } from "./chat.ts";
import { HermeticError } from "../errors.ts";
import { MemoryChatSettingsStore } from "./chat-settings.ts";
import { ENDPOINT_UNKNOWNS, createOperation, dashboardAddress, dashboardBox } from "./bot-mode.ts";
import { record, records, str } from "./hermes/hermes-chat-wire.ts";

const API = "/api/plugins/kanban";
/** How long one box gets to answer before it reads as unreachable. */
const DEADLINE_MS = 8_000;
// shortcut: profiles and board slugs are cached 5 min per instance, so a profile added on the box shows late; read them on every poll if that matters.
const META_TTL_MS = 5 * 60_000;
/** The command that turns the bundled plugin on, run on the box. */
export const KANBAN_ENABLE_HINT = "hermes plugins enable kanban";

type Box = ReturnType<typeof dashboardAddress>;
type Opts = { signal?: AbortSignal | undefined };
type KanbanDeps = Pick<
  ChatDeps,
  "guardFleet" | "getAgent" | "listAgents" | "instanceListening" | "hermes" | "chatSettings"
>;

/** The `{task}` envelope upstream's create and PATCH answer with. */
function taskOf(instance: string, raw: unknown): S.KanbanTask {
  const parsed = S.KanbanTask.safeParse(record(raw).task);
  if (!parsed.success)
    throw new HermeticError(
      "CHAT_PROTOCOL",
      `${instance}: the kanban plugin answered without the task`,
    );
  return parsed.data;
}

/** A board read's columns, flattened (`parseKanbanBoardTasks`). */
function boardTasks(instance: string, raw: unknown): S.KanbanTask[] {
  const tasks = S.parseKanbanBoardTasks(raw);
  if (!tasks) throw new HermeticError("CHAT_PROTOCOL", `${instance}: the board read has no columns`);
  return tasks;
}

export function createKanban(deps: KanbanDeps) {
  const operation = createOperation(deps.chatSettings ?? new MemoryChatSettingsStore());
  const nowS = () => Math.floor(Date.now() / 1000);
  const key = (box: Box) => `${box.fleet_id}/${box.instance}`;
  /** Each instance's last good board read: what an unreachable box shows, marked stale. */
  const lastGood = new Map<string, { at: number; tasks: S.KanbanTask[] }>();
  const meta = new Map<string, { at: number; board: string | null; profiles: string[] }>();

  /**
   * One dashboard call under the 8 s deadline. A box that runs out of time is
   * `CHAT_UNREACHABLE`, never `ABORTED`, which stays the caller's own hang-up.
   */
  async function call(box: Box, method: string, path: string, body: unknown, o: Opts) {
    const rest = deps.hermes.botModeRest;
    if (!rest)
      throw new HermeticError("CHAT_PROTOCOL", "The dashboard API is unavailable on this gateway");
    const deadline = AbortSignal.timeout(DEADLINE_MS);
    try {
      return await rest(box, method, `${API}${path}`, body, {
        signal: o.signal ? AbortSignal.any([o.signal, deadline]) : deadline,
        detail: true,
      });
    } catch (error) {
      if (!o.signal?.aborted && deadline.aborted)
        throw new HermeticError(
          "CHAT_UNREACHABLE",
          `${box.instance}: the kanban board did not answer within ${DEADLINE_MS / 1000} s`,
        );
      throw error;
    }
  }
  const rest = async (instance: string, method: string, path: string, body: unknown, o: Opts) =>
    call(await dashboardBox(deps, instance, false), method, path, body, o);

  /** The roster and the current board slug, cached; a failed read is empty, not a failed board. */
  async function readMeta(box: Box, o: Opts) {
    const hit = meta.get(key(box));
    if (hit && Date.now() - hit.at < META_TTL_MS) return hit;
    const [profiles, boards] = await Promise.all([
      call(box, "GET", "/profiles", undefined, o).catch(() => null),
      call(box, "GET", "/boards", undefined, o).catch(() => null),
    ]);
    const value = {
      at: Date.now(),
      board: str(record(boards).current),
      profiles: records(record(profiles).profiles).flatMap((p) => str(p.name) ?? []),
    };
    if (profiles !== null && boards !== null) meta.set(key(box), value);
    return value;
  }

  // shortcut: polling, upgrade to /events socket if latency matters.
  async function readBoard(box: Box, o: Opts): Promise<S.KanbanInstanceBoard> {
    const base = {
      instance: box.instance,
      reason: null,
      hint: null,
      board: null,
      profiles: [],
      tasks: [],
      read_at: nowS(),
      stale_since: null,
    };
    try {
      const [raw, m] = await Promise.all([call(box, "GET", "/board", undefined, o), readMeta(box, o)]);
      const tasks = boardTasks(box.instance, raw);
      lastGood.set(key(box), { at: base.read_at, tasks });
      return { ...base, state: "on", board: m.board, profiles: m.profiles, tasks };
    } catch (error) {
      if (o.signal?.aborted) throw error;
      const code = error instanceof HermeticError ? error.code : null;
      if (code === "CHAT_UNREACHABLE") {
        const last = lastGood.get(key(box));
        return {
          ...base,
          state: "unreachable",
          reason: `${box.instance} did not answer.`,
          tasks: last?.tasks ?? [],
          stale_since: last?.at ?? null,
        };
      }
      // Upstream's disabled-plugin gate is a 404 (`web_server.py`); a 403 or 409 is something else.
      if (code === "NOT_FOUND")
        return {
          ...base,
          state: "off",
          reason: `The kanban plugin is off on ${box.instance}, or its Hermes predates the board API.`,
          hint: KANBAN_ENABLE_HINT,
        };
      // A 5xx, a body that is not JSON or not a board: the box answered, with something else.
      return {
        ...base,
        state: "unknown",
        reason:
          code === null || ENDPOINT_UNKNOWNS.has(code)
            ? `${box.instance} answered, but not with a board API.`
            : (error as Error).message,
      };
    }
  }

  const board = operation(S.KanbanBoardInput, async (p, o): Promise<S.KanbanBoard> => {
    const { fleet } = await deps.guardFleet();
    const agents = p.instance ? [await deps.getAgent(p.instance)] : await deps.listAgents();
    const sorted = [...agents].sort((a, b) => a.name.localeCompare(b.name, "en"));
    return {
      fleet_id: fleet.fleet_id,
      instances: await Promise.all(sorted.map((a) => readBoard(dashboardAddress(fleet, a), o))),
    };
  });

  const task = operation(S.KanbanTaskInput, async (p, o): Promise<S.KanbanTaskDetail> => {
    const box = await dashboardBox(deps, p.instance, false);
    let raw: unknown;
    try {
      raw = await call(box, "GET", `/tasks/${p.id}`, undefined, o);
    } catch (error) {
      const last = lastGood.get(key(box));
      const cached = last?.tasks.find((t) => t.id === p.id);
      if (!(error instanceof HermeticError && error.code === "CHAT_UNREACHABLE") || !last || !cached)
        throw error;
      return {
        instance: p.instance,
        task: cached,
        comments: [],
        events: [],
        runs: [],
        links: { parents: [], children: [] },
        stale_since: last.at,
      };
    }
    const detail = S.parseKanbanTaskDetail(p.instance, raw);
    if (!detail)
      throw new HermeticError(
        "CHAT_PROTOCOL",
        `${p.instance}: the kanban plugin answered without the task`,
      );
    return detail;
  });

  const log = operation(S.KanbanLogInput, async (p, o): Promise<S.KanbanLog> => {
    const query = p.tail === undefined ? "" : `?tail=${p.tail}`;
    const raw = record(await rest(p.instance, "GET", `/tasks/${p.id}/log${query}`, undefined, o));
    return S.KanbanLog.parse({ ...raw, instance: p.instance, task_id: p.id });
  });

  const create = operation(S.KanbanCreateInput, async (p, o) => {
    const { instance, start, ...fields } = p;
    // JSON drops the undefined fields, so upstream's own defaults apply to them.
    return taskOf(
      instance,
      await rest(instance, "POST", "/tasks", { ...fields, triage: start === "triage" }, o),
    );
  });

  const postComment = (instance: string, id: string, body: string, o: Opts) =>
    rest(instance, "POST", `/tasks/${id}/comments`, { body, author: "hermetic" }, o);
  const patch = async (instance: string, id: string, body: Record<string, unknown>, o: Opts) =>
    taskOf(instance, await rest(instance, "PATCH", `/tasks/${id}`, body, o));

  const comment = operation(S.KanbanCommentInput, async (p, o) => {
    await postComment(p.instance, p.id, p.body, o);
    return { ok: true as const };
  });
  /** The answer lands first, so the worker that claims the card reads it. */
  const unblock = operation(S.KanbanUnblockInput, async (p, o) => {
    if (!p.answer?.trim()) return patch(p.instance, p.id, { status: "ready" }, o);
    await postComment(p.instance, p.id, p.answer, o);
    try {
      return await patch(p.instance, p.id, { status: "ready" }, o);
    } catch (error) {
      // Said plainly so the operator does not send the answer again.
      if (!(error instanceof HermeticError) || o.signal?.aborted) throw error;
      // An unanswered PATCH may still have landed, so it is not called a refusal.
      const outcome = error.code === "CHAT_UNREACHABLE" ? "did not get an answer" : "was refused";
      throw new HermeticError(
        error.code,
        `Your answer was posted to ${p.id}, but the unblock ${outcome}: ${error.message}`,
      );
    }
  });
  const assign = operation(S.KanbanAssignInput, async (p, o) => {
    await rest(p.instance, "POST", `/tasks/${p.id}/reassign`, { profile: p.profile }, o);
    return { assignee: p.profile };
  });
  const move = operation(S.KanbanMoveInput, (p, o) => patch(p.instance, p.id, { status: p.status }, o));
  const archive = operation(S.KanbanArchiveInput, (p, o) =>
    patch(p.instance, p.id, { status: "archived" }, o),
  );
  /**
   * Direct, with `confirm: true`, the model `routines.delete` uses: one card on
   * one box, nothing a plan could preview beyond the card itself.
   */
  const remove = operation(S.KanbanDeleteInput, async (p, o) => {
    const result = record(await rest(p.instance, "DELETE", `/tasks/${p.id}`, undefined, o));
    if (result.deleted !== true)
      throw new HermeticError("CHAT_PROTOCOL", "The kanban plugin did not confirm the delete");
    return { deleted: true as const };
  });

  return {
    kanban: { board, task, log, create, comment, unblock, assign, move, archive, delete: remove },
  };
}
