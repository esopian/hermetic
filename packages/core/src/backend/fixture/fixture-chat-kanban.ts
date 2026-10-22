/**
 * `E2E_KANBAN` (issue #117): the agent files a card with `kanban_create`, and
 * the board then walks it through the lanes the way the dispatcher would —
 * triage, ready, running, done — on the fixture's kanban store, so the chat's
 * task widget and the WORK view both watch it move. At done, Hermes' notice
 * (`✔ @default Kanban t_… done — title`) lands in the conversation through the
 * activity store, as a wake turn's row does, already read by the same
 * `parseProcessNotice` the history reader runs.
 *
 * The walk is wall-clock timers, unref'd so a test that ends early does not
 * hold the process; each fixture stack owns its own store, so a late timer
 * only touches a board nobody reads any more.
 */
import { parseProcessNotice } from "../../chat/hermes/process-notice.ts";
import type { ChatBlock, ChatFrame } from "../../schema/index.ts";
import type { FixtureChatActivity, FixtureChatWhere } from "./fixture-chat-activity.ts";
import { frames } from "./fixture-chat-demo.ts";
import type { FixtureKanbanStore } from "./fixture-kanban.ts";

export const FIXTURE_KANBAN_TRIGGER = "E2E_KANBAN";

/** When each lane is reached, in ms after the turn. */
export const FIXTURE_KANBAN_TIMELINE_MS = { ready: 2_500, running: 5_000, done: 8_000 };

export const FIXTURE_KANBAN_TITLE = "Write a 3-line haiku about kanban boards to haiku.txt";
export const FIXTURE_KANBAN_SUMMARY =
  "Created a 3-line haiku about kanban boards (5-7-5). Written to haiku.txt in the workspace.";
const ASSIGNEE = "default";

type SequencedFrame = Extract<ChatFrame, { seq: number }>;

export interface FixtureKanbanTurnDeps {
  kanban: FixtureKanbanStore;
  activity?: FixtureChatActivity | undefined;
  /** The conversation the card subscribes; its session is the card's `session_id`. */
  where: FixtureChatWhere;
}

/** The turn `prompt` asks for, or null when it does not name `E2E_KANBAN`. */
export function fixtureKanbanTurn(
  prompt: string,
  deps: FixtureKanbanTurnDeps,
): ((message: string) => SequencedFrame[]) | null {
  if (!prompt.includes(FIXTURE_KANBAN_TRIGGER)) return null;
  return (message) => {
    const { kanban, activity, where } = deps;
    const args = { title: FIXTURE_KANBAN_TITLE, workspace_kind: "scratch" };
    const created = kanban.create(where.instance, {
      title: FIXTURE_KANBAN_TITLE,
      workspace_kind: "scratch",
      created_by: "chat",
      session_id: where.session ?? null,
    });
    const id = created.id;
    kanban.set(where.instance, id, { status: "triage" });
    const call = (status: "running" | "ok", result: unknown): ChatBlock => ({
      kind: "tool",
      tool_id: `tl-fixture-kanban-${id}`,
      name: "kanban_create",
      server: null,
      args,
      result,
      status,
      exit_code: null,
      duration_ms: status === "ok" ? 96 : null,
      render: "kanban_task",
    });

    const nowS = () => Math.floor(Date.now() / 1000);
    // A card deleted or archived meanwhile is left alone: the walk would throw or undo the archive.
    const at = (ms: number, step: () => void) =>
      setTimeout(() => {
        const now = kanban.get(where.instance, id);
        if (now && now.status !== "archived") step();
      }, ms).unref?.();
    const t = FIXTURE_KANBAN_TIMELINE_MS;
    at(t.ready, () => kanban.set(where.instance, id, { status: "ready", assignee: ASSIGNEE }));
    at(t.running, () =>
      kanban.set(where.instance, id, {
        status: "running",
        assignee: ASSIGNEE,
        started_at: nowS(),
        last_heartbeat_at: nowS(),
      }),
    );
    at(t.done, () => {
      kanban.set(where.instance, id, {
        status: "done",
        completed_at: nowS(),
        latest_summary: FIXTURE_KANBAN_SUMMARY,
      });
      if (!activity) return;
      const text = `✔ @${ASSIGNEE} Kanban ${id} done — ${FIXTURE_KANBAN_TITLE}\n${FIXTURE_KANBAN_SUMMARY}`;
      const notice = parseProcessNotice(text);
      // The later of the activity clock and now, as a background delegation's
      // results row is stamped (`fixture-chat-subagent.ts`), so a re-read sorted
      // by time never puts the notice above the turn that filed the card.
      const stamp = activity.stamp();
      const now = new Date().toISOString();
      activity.arrive(
        where,
        text,
        `mx-fixture-kanban-${id}`,
        Date.parse(now) > Date.parse(stamp) ? now : stamp,
        { role: "system", blocks: notice ? [notice] : [{ kind: "text", markdown: text }] },
      );
    });

    return [
      ...frames(message, [
        "I'll put that on the board so a worker picks it up.",
        call("running", null),
        call("ok", { task_id: id, status: "triage", subscribed: true }),
        "Filed — I'll report back here when it is done.",
      ]),
    ];
  };
}
