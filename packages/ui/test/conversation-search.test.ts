/**
 * The sidebar filter and quick jump's chat-mode conversation search
 * (`conversation-search.ts`): pure, over what the page already holds.
 */
import { describe, expect, test } from "bun:test";
import type { SessionView, SwarmView } from "../src/api/index.ts";
import { conversationCandidates, matchesQuery } from "../src/chat/conversation-search.ts";

function bot(instance: string, name: string, over: Record<string, unknown> = {}) {
  return {
    instance,
    name,
    title: name === "default" ? instance : name,
    is_default: name === "default",
    avatar_seed: `${instance}/${name}`,
    last_message_at: null,
    last_message_session: null,
    preview: null,
    unread: 0,
    needs_action: false,
    muted: false,
    warm: false,
    ...over,
  };
}

function swarm(instance: string, bots: ReturnType<typeof bot>[]): SwarmView {
  return {
    instance,
    reachable: true,
    bots,
    rooms: [],
    warm_slots: { used: 0, total: 3 },
    sections: [],
  } as unknown as SwarmView;
}

function session(id: string, over: Partial<SessionView> = {}): SessionView {
  return {
    id,
    instance: "atlas",
    bot: "default",
    kind: "thread",
    origin: "portal",
    origin_detail: null,
    title: id,
    preview: null,
    last_message_at: null,
    unread: 0,
    turn_count: 1,
    ...over,
  } as SessionView;
}

describe("matchesQuery", () => {
  test("an empty or blank query matches everything", () => {
    expect(matchesQuery("", "atlas")).toBe(true);
    expect(matchesQuery("   ")).toBe(true);
  });

  test("case-insensitive substring over the fields joined by a space", () => {
    expect(matchesQuery("ATL", "atlas", "default")).toBe(true);
    expect(matchesQuery("  las def ", "atlas", "default")).toBe(true);
    expect(matchesQuery("granite", "atlas", "default")).toBe(false);
  });

  test("absent fields are skipped, never matched as text", () => {
    expect(matchesQuery("null", null, "atlas", undefined)).toBe(false);
    expect(matchesQuery("atlas default", "atlas", null, "default")).toBe(true);
  });
});

describe("conversationCandidates", () => {
  const swarms = [
    swarm("atlas", [
      bot("atlas", "default", {
        last_message_session: "s-portal",
        last_message_at: "2026-09-17T09:00:00Z",
        preview: "roster preview of the portal chat",
      }),
      bot("atlas", "scribe", {
        title: "Marshall",
        last_message_session: "s-scribe",
        last_message_at: "2026-09-17T10:00:00Z",
        preview: "Daily digest is ready",
      }),
    ]),
    swarm("granite", [
      bot("granite", "default", {
        last_message_session: "s-granite",
        last_message_at: "2026-09-17T08:00:00Z",
        preview: "NO_REPLY",
        preview_role: "bot",
      }),
      // No session named: nothing to open, so not a candidate.
      bot("granite", "quiet", { last_message_at: "2026-09-17T11:00:00Z", preview: "hi" }),
    ]),
  ];
  const sessions = [
    session("s-portal", {
      title: "gp3 write cache",
      preview: "full preview from the session read",
      last_message_at: "2026-09-17T09:30:00Z",
    }),
    session("s-report", {
      title: "Reading the volume report",
      last_message_at: "2026-09-17T07:00:00Z",
    }),
  ];
  const selection = { instance: "atlas", bot: "default", session: null };
  const ids = (query: string, sel: typeof selection | null = selection) =>
    conversationCandidates({ swarms, sessions, selection: sel, query }).map((c) => c.target.session);

  test("no query: every candidate, newest first, a session both sources name listed once", () => {
    expect(ids("")).toEqual(["s-scribe", "s-portal", "s-granite", "s-report"]);
  });

  test("the session read wins a duplicate: its title, its preview, its timestamp", () => {
    const portal = conversationCandidates({ swarms, sessions, selection, query: "" }).find(
      (c) => c.target.session === "s-portal",
    );
    expect(portal).toEqual({
      target: { instance: "atlas", bot: "default", session: "s-portal" },
      label: "atlas",
      title: "gp3 write cache",
      preview: "full preview from the session read",
      last_message_at: "2026-09-17T09:30:00Z",
    });
  });

  test("matches box, bot name, bot title, conversation title and preview; order kept", () => {
    expect(ids("granite")).toEqual(["s-granite"]);
    expect(ids("scribe")).toEqual(["s-scribe"]);
    expect(ids("marshall")).toEqual(["s-scribe"]);
    expect(ids("VOLUME REPORT")).toEqual(["s-report"]);
    expect(ids("digest")).toEqual(["s-scribe"]);
    expect(ids("atlas")).toEqual(["s-scribe", "s-portal", "s-report"]);
    expect(ids("nothing like this")).toEqual([]);
  });

  test("sessions count only for the selected bot; the roster's latest still does", () => {
    expect(ids("", null)).toEqual(["s-scribe", "s-portal", "s-granite"]);
    expect(ids("", { instance: "atlas", bot: "scribe", session: null })).toEqual([
      "s-scribe",
      "s-portal",
      "s-granite",
    ]);
  });

  test("a silent preview reads as silence; a long one is shortened but matched in full", () => {
    const [granite] = conversationCandidates({ swarms, sessions, selection, query: "granite" });
    expect(granite?.preview).toBe("stayed silent");
    expect(granite?.label).toBe("granite");
    expect(granite?.title).toBeNull();

    const long = `${"word ".repeat(40)}needle at the end`;
    const found = conversationCandidates({
      swarms,
      sessions: [session("s-long", { preview: long })],
      selection,
      query: "needle at the end",
    });
    expect(found.map((c) => c.target.session)).toEqual(["s-long"]);
    expect(found[0]!.preview!.length).toBeLessThanOrEqual(120);
    expect(found[0]!.preview!.endsWith("…")).toBe(true);
  });
});
