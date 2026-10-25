/**
 * The board screen as data: every listened instance's cards in one list,
 * cut by a lens (needs you, open, all) and a filter, then grouped the way the
 * desktop's Work queue groups them (`KANBAN_QUEUE_GROUPS`). Pure.
 */
import type { KanbanTask } from "@hermetic/core/schema";
import { KANBAN_QUEUE_GROUPS, type KanbanTone, kanbanNeedsYou } from "@hermetic/core/shared";
import type { InstanceBoard } from "./kanban.ts";

export type BoardLens = "you" | "open" | "all";
export type BoardCard = KanbanTask & { instance: string };

export interface BoardSection {
  label: string;
  tone: KanbanTone;
  hint: string;
  data: BoardCard[];
}

export function boardCards(boards: readonly InstanceBoard[]): BoardCard[] {
  return boards.flatMap((b) => b.tasks.map((t) => ({ ...t, instance: b.instance })));
}

const inLens = (t: BoardCard, lens: BoardLens): boolean =>
  lens === "you" ? kanbanNeedsYou(t) : lens === "open" ? t.status !== "done" : true;

export function lensCounts(cards: readonly BoardCard[]): Record<BoardLens, number> {
  return {
    you: cards.filter((t) => inLens(t, "you")).length,
    open: cards.filter((t) => inLens(t, "open")).length,
    all: cards.length,
  };
}

/**
 * The groups with the cards the lens and filter keep, highest priority then
 * newest first. "Needs you" always shows, so its emptiness says so; the other
 * groups only when they hold a card.
 */
export function boardSections(
  cards: readonly BoardCard[],
  lens: BoardLens,
  query: string,
): BoardSection[] {
  const q = query.trim().toLowerCase();
  const shown = cards.filter(
    (t) =>
      inLens(t, lens) &&
      (!q || `${t.title} ${t.id} ${t.instance} ${t.assignee ?? ""}`.toLowerCase().includes(q)),
  );
  return KANBAN_QUEUE_GROUPS.flatMap((g, i) => {
    const data = shown
      .filter(g.test)
      .sort((a, b) => b.priority - a.priority || b.created_at - a.created_at);
    return data.length || i === 0 ? [{ label: g.label, tone: g.tone, hint: g.hint, data }] : [];
  });
}
