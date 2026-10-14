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

/** Before and after every entry `setup` files (10:00). */
const EARLIER = "2026-10-13T09:00:00.000Z";
const LATER = "2026-10-13T11:00:00.000Z";

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
    // Entries naming no listed session, filed before the list was asked for, are the
    // Bot Chat's (ids it carried before a compaction).
    const s = setup(["s-2", "s-1", "s-1-old", "", "s-new"]);
    expect(
      await s.read({ session: null, resolved: "s-1", separate: ["s-2"], listedAt: LATER }),
    ).toEqual(["s-2"]);
    expect(s.seen).toEqual(["atlas/scribe"]);
  });

  test("an entry naming an unlisted session filed after the list stays until a later list says whose", async () => {
    // Filed at 10:00; the list was asked for at 09:00, before a separate s-new may have existed.
    const s = setup(["s-1", "s-new", ""]);
    expect(await s.read({ session: null, resolved: "s-1", separate: [], listedAt: EARLIER })).toEqual([
      "s-new",
    ]);
    // A newer list naming it: a separate session's, still unread.
    expect(
      await s.read({ session: null, resolved: "s-1", separate: ["s-new"], listedAt: LATER }),
    ).toEqual(["s-new"]);
    // A newer list without it: the Bot Chat's old id, read.
    expect(await s.read({ session: null, resolved: "s-1", separate: [], listedAt: LATER })).toEqual([]);
  });

  test("with no time for the list, an unlisted session is never cleared", async () => {
    const s = setup(["s-1", "s-old"]);
    expect(await s.read({ session: null, resolved: "s-1", separate: [] })).toEqual(["s-old"]);
  });

  test("the Bot Chat's own id is read even when a stale list calls it separate", async () => {
    // A rollover moved the canonical flag; the list read before it still says thread.
    const s = setup(["s-1", "s-2", ""]);
    expect(
      await s.read({ session: null, resolved: "s-1", separate: ["s-1", "s-2"], listedAt: LATER }),
    ).toEqual(["s-2"]);
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
