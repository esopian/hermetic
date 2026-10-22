/**
 * Hermes' kanban notices (`tui_gateway/session_notifications.py:302-342`):
 * the user-role row a subscribed card's event wakes the chat with, read as a
 * `kanban` event and never as the operator; and `kanban_create`'s tool block.
 */
import { describe, expect, test } from "bun:test";
import type { BoxAddress } from "../src/chat/hermes/hermes-chat.ts";
import { mapHistory } from "../src/chat/hermes/hermes-chat.ts";
import { toolBlock } from "../src/chat/hermes/hermes-chat-blocks.ts";
import { previewInjectedNotice, readInjectedNotice } from "../src/chat/hermes/injected-notice.ts";
import { parseProcessNotice, processNoticePreview } from "../src/chat/hermes/process-notice.ts";
import { ChatBlock } from "../src/schema/index.ts";

const ID = "t_ab12cd34";

describe("readInjectedNotice — kanban", () => {
  test.each([
    [
      `✔ [ops] @worker Kanban ${ID} done — Ship the notes\nWrote CHANGELOG.md`,
      "ok",
      {
        board: "ops",
        assignee: "worker",
        kanban_kind: "completed",
        detail: "Ship the notes",
        body: "Wrote CHANGELOG.md",
      },
    ],
    [
      `⏸ Kanban ${ID} blocked: which branch?`,
      "warn",
      { board: null, assignee: null, kanban_kind: "blocked", detail: "which branch?", body: null },
    ],
    [`⏸ @w Kanban ${ID} blocked`, "warn", { assignee: "w", kanban_kind: "blocked", detail: null }],
    [
      `✖ [ops] Kanban ${ID} gave up after repeated spawn failures\nprofile not found`,
      "failed",
      { board: "ops", assignee: null, kanban_kind: "gave_up", detail: null, body: "profile not found" },
    ],
    [
      `✖ Kanban ${ID} worker crashed (pid gone); dispatcher will retry`,
      "failed",
      { kanban_kind: "crashed", detail: null, body: null },
    ],
    [
      `⏱ Kanban ${ID} timed out (max_runtime=300s); will retry`,
      "warn",
      { kanban_kind: "timed_out", detail: "max_runtime=300s" },
    ],
    [`🔄 @w Kanban ${ID} → review`, "warn", { assignee: "w", kanban_kind: "status", detail: "review" }],
    // An unknown wording keeps the glyph's outcome and the suffix verbatim.
    [
      `✔ Kanban ${ID} landed somewhere new`,
      "ok",
      { kanban_kind: null, detail: "landed somewhere new" },
    ],
  ] as const)("%p", (text, outcome, fields) => {
    const read = readInjectedNotice(text, null);
    expect(read?.event).toBe("kanban");
    expect(read?.outcome).toBe(outcome);
    expect(read?.notice).toMatchObject({ task_id: ID, ...fields });
  });

  test.each([
    "✔ done, shipped it",
    `✔ I moved Kanban ${ID} done — x`,
    `Kanban ${ID} done — x`,
    `see ✔ Kanban ${ID} done — x`,
    "✔ Kanban t_XYZ done — x",
  ])("%p stays the operator's", (text) => {
    expect(readInjectedNotice(text, null)).toBeNull();
  });

  test("the block parses and the history row is a system event, not You", () => {
    const text = `✔ @worker Kanban ${ID} done — Ship the notes\nWrote CHANGELOG.md`;
    const block = parseProcessNotice(text);
    expect(ChatBlock.parse(block)).toMatchObject({ kind: "process_event", event: "kanban", raw: text });
    const box: BoxAddress = { instance: "kestrel", baseUrl: "https://x.ts.net/", fleet_id: "fxtr0001" };
    const out = mapHistory(box, "s1", {
      messages: [{ id: 1, role: "user", content: text, timestamp: "2026-10-21T09:00:00.000Z" }],
    });
    expect(out.map((m) => m.role)).toEqual(["system"]);
  });
});

describe("a batch of kanban notices in one row", () => {
  const ID2 = "t_ffee0011";
  const text = `✔ @w Kanban ${ID} done — Ship the notes\nWrote CHANGELOG.md\n⏸ Kanban ${ID2} blocked: which branch?`;

  test("the first card's body stops at the next notice, which is the rest", () => {
    const read = readInjectedNotice(text, null);
    expect(read?.notice).toMatchObject({ task_id: ID, body: "Wrote CHANGELOG.md" });
    expect(read?.rest).toBe(`⏸ Kanban ${ID2} blocked: which branch?`);
  });

  test("history draws one event row per card", () => {
    const box: BoxAddress = { instance: "kestrel", baseUrl: "https://x.ts.net/", fleet_id: "fxtr0001" };
    const out = mapHistory(box, "s1", {
      messages: [{ id: 7, role: "user", content: text, timestamp: "2026-10-21T09:00:00.000Z" }],
    });
    expect(
      out.map((m) => {
        const b = m.blocks[0];
        return [m.id, m.role, b?.kind === "process_event" ? b.notice?.task_id : null];
      }),
    ).toEqual([
      ["s1:7:notice", "system", ID],
      ["s1:7", "system", ID2],
    ]);
  });
});

describe("kanban previews", () => {
  test("previewInjectedNotice reads a flattened row", () => {
    const read = previewInjectedNotice(`✔ @w Kanban ${ID} done — Ship the notes Wrote CHANGE`, true);
    expect(read?.event).toBe("kanban");
    expect(read?.notice.task_id).toBe(ID);
  });

  test("the rail sentence names the card and what happened", () => {
    expect(processNoticePreview(`✔ @w Kanban ${ID} done — Ship the notes`)).toBe(
      `Kanban ${ID} done — Ship the notes`,
    );
    expect(processNoticePreview(`⏸ Kanban ${ID} blocked: which branch?`)).toBe(
      `Kanban ${ID} blocked: which branch?`,
    );
    expect(processNoticePreview(`🔄 Kanban ${ID} → review`)).toBe(`Kanban ${ID} → review`);
    expect(processNoticePreview("✔ done, shipped it")).toBeNull();
  });
});

describe("kanban_create", () => {
  test("renders as kanban_task and keeps the parsed result", () => {
    const block = toolBlock(
      { name: "kanban_create", args: { title: "Ship" }, result: { task_id: ID, subscribed: true } },
      null,
    );
    expect(block).toMatchObject({ kind: "tool", render: "kanban_task", result: { task_id: ID } });
    expect(ChatBlock.parse(block)).toMatchObject({ render: "kanban_task" });
  });
});
