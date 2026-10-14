/**
 * Steer and Stop for one delegated child (WI-14 steps 6–7), and the operator's
 * unsent steer per child.
 *
 * A separate path from the turn's own steer and stop (`chat-turn-actions.ts`):
 * it needs no running parent turn (D25 — the gateway takes a child's control
 * from a fresh socket after the turn ended), it inserts nothing into the
 * transcript, and Stop ends the one child while the turn goes on.
 *
 * What the box answers is only half of the truth, so the record keeps the
 * answer and the label is read against the child's block every render
 * (`steerLabel`/`stopLabel` in `chat-subagents.ts`): a queued steer is "not yet
 * confirmed" until the child makes another tool call, and a delivered stop is
 * "requested" until the child's `interrupted` completion arrives.
 */
import { useCallback, useMemo } from "react";
import type { RefObject } from "react";
import type { ChatApi, ChatSelection } from "./chat-state.tsx";
import type { Conversation } from "./chat-conversation-record.ts";
import { sessionOf } from "./chat-conversation-record.ts";
import { remember, subagentIn, toolsSeen } from "./chat-subagents.ts";
import type { SubagentControl, SubagentTrail } from "./chat-subagents.ts";

export interface SubagentControls {
  trail: ReadonlyMap<string, SubagentTrail>;
  drafts: ReadonlyMap<string, string>;
  control: ReadonlyMap<string, SubagentControl>;
  setDraft: (subagentId: string, text: string) => void;
  steer: (subagentId: string, text: string) => Promise<void>;
  stop: (subagentId: string) => Promise<void>;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function useSubagentControls(deps: {
  current: Conversation;
  selected: RefObject<ChatSelection | null>;
  get: (target: ChatSelection) => Conversation;
  /** The record answering to `target`, without creating one. */
  find: (target: ChatSelection) => Conversation | undefined;
  changed: () => void;
  permits: (instance: string) => boolean;
  api: RefObject<ChatApi>;
}): SubagentControls & { forTarget: (target: ChatSelection) => SubagentControls } {
  const { current, selected, get, find, changed, permits, api } = deps;
  const record = useCallback(
    (target?: ChatSelection): Conversation | null => {
      const where = target ?? selected.current;
      return where && permits(where.instance) ? get(where) : null;
    },
    [get, permits, selected],
  );

  const setDraft = useCallback(
    (id: string, text: string, target?: ChatSelection) => {
      const r = record(target);
      if (!r) return;
      if (text) r.subagentDrafts = remember(r.subagentDrafts, id, text);
      else if (r.subagentDrafts.has(id)) {
        const next = new Map(r.subagentDrafts);
        next.delete(id);
        r.subagentDrafts = next;
      }
      changed();
    },
    [changed, record],
  );

  const control = useCallback((r: Conversation, id: string, patch: SubagentControl) => {
    r.subagentControl = remember(r.subagentControl, id, { ...r.subagentControl.get(id), ...patch });
  }, []);

  /**
   * Where an answer lands: the record holding `session` *now*. A rollover while
   * the request was out moves the child's control state onto the retired
   * session's copy (`takeSubagents`), and the answer must follow it there
   * rather than write into the conversation that replaced it.
   */
  const owner = useCallback(
    (r: Conversation, session: string | null): Conversation | null => {
      if (session === null || sessionOf(r) === session) return r;
      const moved = find({ instance: r.target.instance, bot: r.target.bot, session });
      return moved && sessionOf(moved) === session ? moved : null;
    },
    [find],
  );

  const steer = useCallback(
    async (id: string, text: string, target?: ChatSelection) => {
      const r = record(target);
      const body = text.trim();
      if (!r || !body) return;
      const at = Date.now();
      const session = sessionOf(r);
      control(r, id, { steer: { state: "sending", text: body, at, tools: 0 } });
      setDraft(id, "", target);
      const call = api.current.steerSubagent;
      try {
        if (!call) throw new Error("this view cannot steer a subagent");
        const result = await call(r.target.instance, r.target.bot, id, body, session);
        const home = owner(r, session);
        if (!home) return;
        const block = subagentIn(home, id);
        control(home, id, {
          steer: {
            state: result.status === "queued" ? "queued" : "rejected",
            text: body,
            at,
            // Counted at the answer: a call made while the steer was in flight
            // ran without it, and must not read as the steer landing.
            tools: block ? toolsSeen(block) : 0,
          },
        });
      } catch (error) {
        const home = owner(r, session);
        if (!home) return;
        control(home, id, {
          steer: { state: "failed", text: body, at, tools: 0, error: messageOf(error) },
        });
        // The words are not lost to a failed send: they go back in the field.
        if (!home.subagentDrafts.get(id)) home.subagentDrafts = remember(home.subagentDrafts, id, body);
      } finally {
        changed();
      }
    },
    [api, changed, control, owner, record, setDraft],
  );

  const stop = useCallback(
    async (id: string, target?: ChatSelection) => {
      const r = record(target);
      if (!r) return;
      const at = Date.now();
      const session = sessionOf(r);
      control(r, id, { stop: { state: "sending", at } });
      changed();
      const call = api.current.stopSubagent;
      try {
        if (!call) throw new Error("this view cannot stop a subagent");
        const result = await call(r.target.instance, r.target.bot, id, session);
        const home = owner(r, session);
        if (home)
          control(home, id, { stop: { state: result.aborted ? "requested" : "not_found", at } });
      } catch (error) {
        const home = owner(r, session);
        if (home) control(home, id, { stop: { state: "failed", at, error: messageOf(error) } });
      }
      changed();
    },
    [api, changed, control, owner, record],
  );

  const forTarget = useCallback(
    (target: ChatSelection): SubagentControls => {
      const scoped = get(target);
      return {
        trail: scoped.subagentTrail,
        drafts: scoped.subagentDrafts,
        control: scoped.subagentControl,
        setDraft: (id, text) => setDraft(id, text, target),
        steer: (id, text) => steer(id, text, target),
        stop: (id) => stop(id, target),
      };
    },
    [get, setDraft, steer, stop],
  );

  return useMemo(
    () => ({
      trail: current.subagentTrail,
      drafts: current.subagentDrafts,
      control: current.subagentControl,
      setDraft,
      steer,
      stop,
      forTarget,
    }),
    [
      current.subagentTrail,
      current.subagentDrafts,
      current.subagentControl,
      setDraft,
      steer,
      stop,
      forTarget,
    ],
  );
}
