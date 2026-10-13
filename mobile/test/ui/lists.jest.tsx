import { fireEvent, screen } from "@testing-library/react-native";
import { BotRow } from "../../src/bots/BotRow.tsx";
import { FilterChips } from "../../src/bots/BotsList.tsx";
import {
  groupNotifications,
  groupRow,
  inQuietHours,
  rowDestination,
} from "../../src/client/inbox-logic.ts";
import { previewLine, rosterRows } from "../../src/client/roster-rows.ts";
import { rosterLayout } from "../../src/client/roster-store.ts";
import { InboxRow } from "../../src/inbox/InboxRow.tsx";
import { bot, notification, swarm } from "../helpers/fixtures.ts";
import { NOW, renderUi } from "../helpers/render.tsx";

describe("bots list rows", () => {
  const swarms = [
    swarm("atlas", [
      bot({ name: "scribe", unread: 2, last_message_at: "2026-10-13T11:00:00.000Z" }),
      bot({ name: "pilot", needs_action: true }),
      bot({ name: "quiet" }),
    ]),
    swarm("borealis", [bot({ name: "keeper", unread: 1 })]),
    swarm("cinder", [], { reachable: false, unreachable_reason: "stopped" }),
  ];

  test("pinned block first, then buckets needs-first; an emptied bucket drops, an unreachable one sinks", () => {
    const layout = rosterLayout(swarms, { pinned: ["borealis/keeper"] });
    const rows = rosterRows(layout);
    expect(rows.map((r) => r.key)).toEqual([
      "h:pinned",
      "p:borealis/keeper",
      "h:atlas",
      "b:atlas/pilot",
      "b:atlas/scribe",
      "b:atlas/quiet",
      "h:cinder",
      "u:cinder",
      "footer",
    ]);
  });

  test("badges: ! for needs you, the count when unread, the inbox count when larger", () => {
    const rows = rosterRows(rosterLayout(swarms), (i, b) => (i === "atlas" && b === "scribe" ? 5 : 0));
    const badge = (key: string) => rows.find((r) => r.key === key && r.kind === "bot");
    expect(badge("b:atlas/pilot")).toMatchObject({ badge: "!" });
    expect(badge("b:atlas/scribe")).toMatchObject({ badge: "5" });
    expect(badge("b:atlas/quiet")).toMatchObject({ badge: null });
  });

  test("a folded bucket hides its bots and keeps its signal", () => {
    const rows = rosterRows(rosterLayout(swarms, { folded: ["atlas"] }));
    expect(rows.some((r) => r.key === "b:atlas/scribe")).toBe(false);
    expect(rows.find((r) => r.key === "h:atlas")).toMatchObject({ folded: true, badge: "!" });
  });

  test("the footer counts instances, bots and who needs you", () => {
    const rows = rosterRows(rosterLayout(swarms));
    expect(rows[rows.length - 1]).toMatchObject({
      kind: "footer",
      roster: "3 instances · 4 bots",
      attention: "1 needs you",
    });
  });

  test("preview: the operator's own last word reads 'You:'", () => {
    expect(previewLine(bot({ preview: "ship it", preview_role: "user" }))).toBe("You: ship it");
    expect(previewLine(bot({ preview: "done\nnext", preview_role: "bot" }))).toBe("done next");
    expect(previewLine(bot({}))).toBe("No messages yet");
  });

  test("BotRow: title, preview, time, badge; press and long-press", async () => {
    const onPress = jest.fn();
    const onLongPress = jest.fn();
    const b = bot({
      name: "scribe",
      title: "Scribe",
      unread: 3,
      preview: "the draft is ready",
      last_message_at: new Date(NOW - 5 * 60_000).toISOString(),
    });
    await renderUi(
      <BotRow
        bot={b}
        fleetId="fxtr0001"
        pinned
        badge="3"
        reachable
        now={NOW}
        onPress={onPress}
        onLongPress={onLongPress}
      />,
    );
    expect(screen.getByText("the draft is ready")).toBeTruthy();
    expect(screen.getByText("5m")).toBeTruthy();
    expect(screen.getByLabelText("3 unread")).toBeTruthy();
    const row = screen.getByLabelText("Scribe on atlas, 3 unread");
    await fireEvent.press(row);
    expect(onPress).toHaveBeenCalledWith(b);
    await fireEvent(row, "longPress");
    expect(onLongPress).toHaveBeenCalledWith(b, true);
  });

  test("filter chips", async () => {
    const onChange = jest.fn();
    await renderUi(<FilterChips value="all" needs={2} onChange={onChange} />);
    expect(screen.getByRole("tab", { selected: true })).toBeTruthy();
    await fireEvent.press(screen.getByText("Needs you"));
    expect(onChange).toHaveBeenCalledWith("needs");
    expect(screen.getByLabelText("needs you")).toBeTruthy();
  });
});

describe("inbox", () => {
  const rows = [
    notification({ id: "n4", at: "2026-10-13T11:04:00.000Z", ref: "atlas/scribe" }),
    notification({ id: "n3", at: "2026-10-13T11:03:00.000Z", ref: "atlas/scribe", read_at: "x" }),
    notification({
      id: "n2",
      at: "2026-10-13T11:02:00.000Z",
      kind: "operation.failed",
      source: "operation",
      class: "bad",
      ref: null,
      agent: "atlas",
      title: "stop failed",
    }),
    notification({ id: "n1", at: "2026-10-13T11:01:00.000Z", ref: "atlas/scribe" }),
  ];

  test("consecutive rows about one conversation fold; another row breaks the run", () => {
    const groups = groupNotifications(rows);
    expect(groups.map((g) => g.count)).toEqual([2, 1, 1]);
    expect(groups[0]?.latest.id).toBe("n4");
    expect(groups[0]?.key).toBe("chat.message:atlas/scribe@n3");
  });

  test("a folded card is unread if any member is", () => {
    const [first] = groupNotifications([
      notification({ id: "a", read_at: "x", at: "2026-10-13T11:05:00.000Z" }),
      notification({ id: "b", at: "2026-10-13T11:04:00.000Z" }),
    ]);
    if (!first) throw new Error("no group");
    expect(groupRow(first).read_at).toBeNull();
  });

  test("tap goes to the conversation, or the agent", () => {
    expect(rowDestination(notification({ ref: "atlas/scribe" }))).toEqual({
      kind: "chat",
      instance: "atlas",
      bot: "scribe",
    });
    expect(
      rowDestination(
        notification({ kind: "agent.health", source: "agent", ref: null, agent: "atlas" }),
      ),
    ).toEqual({ kind: "agent", name: "atlas" });
  });

  test("quiet hours cross midnight and equal ends are off", () => {
    const at = (h: number, m = 0) => new Date(2026, 9, 13, h, m);
    const q = { enabled: true, start: "22:00", end: "07:00" };
    expect(inQuietHours(at(23), q)).toBe(true);
    expect(inQuietHours(at(6, 59), q)).toBe(true);
    expect(inQuietHours(at(7), q)).toBe(false);
    expect(inQuietHours(at(23), { ...q, end: "22:00" })).toBe(false);
    expect(inQuietHours(at(23), { ...q, enabled: false })).toBe(false);
  });

  test("InboxRow: unread dot, needs-you tone, the folded count; tap opens", async () => {
    const onOpen = jest.fn();
    const group = groupNotifications([
      notification({
        id: "x2",
        class: "needs_action",
        title: "Approval needed",
        at: "2026-10-13T11:59:00.000Z",
      }),
      notification({
        id: "x1",
        class: "needs_action",
        title: "Approval needed",
        at: "2026-10-13T11:58:00.000Z",
      }),
    ])[0];
    if (!group) throw new Error("no group");
    await renderUi(<InboxRow group={group} now={NOW} onOpen={onOpen} onAck={jest.fn()} />);
    expect(screen.getByText("NEEDS YOU")).toBeTruthy();
    expect(screen.getByText("2 messages")).toBeTruthy();
    expect(screen.getByLabelText("unread")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Needs you: Approval needed"));
    expect(onOpen).toHaveBeenCalledWith(group);
  });
});
