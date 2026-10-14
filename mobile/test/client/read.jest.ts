import { markConversationRead, type ReadTarget } from "../../src/client/read.ts";
import { memoryFile } from "../../src/fleet/store.ts";
import { type InboxEntry, InboxStore } from "../../src/inbox/store.ts";
import { inboxEntry } from "../helpers/fixtures.ts";

/**
 * An inbox holding one unread entry per session named (`""`: no session), and
 * a roster that records `markSeen`.
 */
function setup(sessions: readonly string[]) {
  const entries: InboxEntry[] = sessions.map((session, n) =>
    inboxEntry({
      id: `i${n + 1}`,
      session,
      kind: n === 0 ? "needs_action" : "turn.done",
      dedupe: `atlas:${session}:${n}:x`,
    }),
  );
  const inbox = new InboxStore(memoryFile(JSON.stringify(entries)));
  const seen: string[] = [];
  const roster = { markSeen: (instance: string, bot: string) => seen.push(`${instance}/${bot}`) };
  const read = async (target: Omit<ReadTarget, "instance" | "bot">) => {
    await inbox.load();
    markConversationRead({ roster, inbox }, { instance: "atlas", bot: "scribe", ...target });
    return inbox
      .getState()
      .entries.filter((e) => !e.read_at)
      .map((e) => e.session)
      .sort();
  };
  return { read, seen };
}

describe("markConversationRead", () => {
  test("a separate session clears entries naming its opened id or its resolved one", async () => {
    // Compacted: entries carry the old id and the rotated one.
    const s = setup(["s-2", "s-2b", "s-1", "s-3"]);
    expect(await s.read({ session: "s-2", resolved: "s-2b" })).toEqual(["s-1", "s-3"]);
    expect(s.seen).toEqual([]);
  });

  test("a separate session whose resolved id is unknown clears only its opened id", async () => {
    const s = setup(["s-2", "s-2b", ""]);
    expect(await s.read({ session: "s-2", resolved: null })).toEqual(["", "s-2b"]);
  });

  test("the Bot Chat clears the bot but leaves its listed separate sessions' entries", async () => {
    // The separate session's needs_action stays: it is read by opening that session.
    const s = setup(["s-2", "s-1", "s-1-old", "", "s-new"]);
    expect(await s.read({ session: null, resolved: "s-1", separate: ["s-2"] })).toEqual(["s-2"]);
    expect(s.seen).toEqual(["atlas/scribe"]);
  });

  test("before the session list is known the Bot Chat clears only its own and session-less entries", async () => {
    const s = setup(["s-2", "s-1", ""]);
    expect(await s.read({ session: null, resolved: "s-1" })).toEqual(["s-2"]);
    expect(s.seen).toEqual(["atlas/scribe"]);
    const unknown = setup(["s-2", "s-1", ""]);
    expect(await unknown.read({ session: null, resolved: null })).toEqual(["s-1", "s-2"]);
  });

  test("another bot's entries are never touched", async () => {
    const s = setup(["s-1"]);
    const inbox = new InboxStore(
      memoryFile(JSON.stringify([inboxEntry({ bot: "other", session: "s-1" })])),
    );
    await inbox.load();
    markConversationRead(
      { roster: { markSeen: () => {} }, inbox },
      { instance: "atlas", bot: "scribe", session: null, resolved: "s-1", separate: [] },
    );
    expect(inbox.getState().unread).toBe(1);
    expect(await s.read({ session: null, resolved: "s-1", separate: [] })).toEqual([]);
  });
});
