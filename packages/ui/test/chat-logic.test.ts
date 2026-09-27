/**
 * The chat rules (§9.2).
 *
 * Every decision the chat view makes that is not layout lives in
 * `chat-logic.ts`, and all of it is checked here without mounting anything.
 * Three of these are not style rules and are worth naming: which origins oblige
 * the composer to restate a destination (a reply into a `channel` session
 * leaves the tailnet), the collapse rule (a green exit code was never news),
 * and the block-kind fallthrough (a `hermes_ref` bump can never blank a
 * transcript).
 */
import { describe, expect, test } from "bun:test";
import {
  blockKind,
  compareBots,
  compareBuckets,
  composerState,
  dayDivider,
  destinationNotice,
  failureCopy,
  fmtBytes,
  fmtMs,
  formatPayload,
  hasKnownOrigin,
  messageRows,
  originClass,
  originNotice,
  ORIGIN_NAMES,
  railBuckets,
  railFooter,
  safeHref,
  safeImageSrc,
  railTime,
  startsCollapsed,
  threadState,
  threadTime,
  threadTotals,
  toolsUsed,
  toolVerdict,
  unknownName,
  unknownPayload,
  unreadBadge,
  warmSlots,
} from "../src/chat/chat-logic.ts";
import type { BotLike, MessageLike, SwarmLike } from "../src/chat/chat-logic.ts";

function bot(over: Partial<BotLike> = {}): BotLike {
  return {
    instance: "atlas",
    name: "atlas",
    title: "the default bot",
    is_default: true,
    section: null,
    avatar_seed: "seed",
    last_message_at: null,
    unread: 0,
    needs_action: false,
    muted: false,
    warm: true,
    ...over,
  };
}

function swarm(over: Partial<SwarmLike> = {}): SwarmLike {
  return {
    instance: "atlas",
    reachable: true,
    unreachable_reason: null,
    bots: [bot()],
    rooms: [],
    warm_slots: { used: 1, total: 3 },
    sections: [],
    ...over,
  };
}

function message(over: Partial<MessageLike> = {}): MessageLike {
  return {
    id: "m1",
    session: "s1",
    role: "bot",
    author: null,
    at: "2026-09-16T09:12:04.000Z",
    blocks: [],
    usage: null,
    error: null,
    incomplete: null,
    ...over,
  };
}

/* ── time ────────────────────────────────────────────────────────────────── */

describe("railTime", () => {
  const now = new Date("2026-09-16T12:00:00Z").getTime();

  test("a fresh message is `now`, and so is one from the future", () => {
    expect(railTime("2026-09-16T11:59:50Z", now)).toBe("now");
    // Two clocks, a little skew. Not something to put on screen.
    expect(railTime("2026-09-16T12:00:30Z", now)).toBe("now");
  });

  test("minutes inside the hour, wall clock the same day", () => {
    expect(railTime("2026-09-16T11:51:00Z", now)).toBe("9m");
    const sameDay = new Date("2026-09-16T03:00:00Z");
    expect(railTime(sameDay.toISOString(), now)).toMatch(/^\d{2}:\d{2}$/);
  });

  test("a weekday inside the week, a date beyond it", () => {
    expect(railTime("2026-09-13T12:00:00Z", now)).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/);
    expect(railTime("2026-09-02T12:00:00Z", now)).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });

  test("absence and nonsense are a dash, never `Invalid Date`", () => {
    expect(railTime(null, now)).toBe("—");
    expect(railTime("not a date", now)).toBe("—");
  });

  test("a message stamp is the wall clock today and the rail's own forms before it", () => {
    // One ladder, two surfaces. The rail says `now` for a fresh message; a
    // transcript stamp says the clock time it was sent at, because a record
    // that drifts under a reader is not a record. Everything older is
    // `railTime` verbatim, so the two can never disagree about a date.
    expect(threadTime("2026-09-16T11:59:50Z", now)).toMatch(/^\d{2}:\d{2}$/);
    expect(threadTime("2026-09-16T11:51:00Z", now)).toMatch(/^\d{2}:\d{2}$/);
    expect(threadTime("2026-09-13T12:00:00Z", now)).toBe(railTime("2026-09-13T12:00:00Z", now));
    expect(threadTime("2026-09-02T12:00:00Z", now)).toBe(railTime("2026-09-02T12:00:00Z", now));
    expect(threadTime(null, now)).toBe("—");
    expect(threadTime("not a date", now)).toBe("—");
  });

  test("the day divider says Today only for today", () => {
    expect(dayDivider("2026-09-16T01:00:00Z", now)).toStartWith("Today · ");
    expect(dayDivider("2026-09-02T01:00:00Z", now)).not.toStartWith("Today");
  });
});

test("durations and sizes read in a consistent, compact format", () => {
  expect(fmtMs(420)).toBe("420ms");
  expect(fmtMs(6200)).toBe("6.2s");
  expect(fmtMs(null)).toBe("");
  expect(fmtBytes(214 * 1024)).toBe("214 KB");
  expect(fmtBytes(900)).toBe("900 B");
});

/* ── the origin banner ───────────────────────────────────────────────────── */

describe("the destination banner", () => {
  test("only `portal` is silent — every other origin restates the destination", () => {
    expect(originNotice("portal", null)).toBeNull();
    for (const origin of ORIGIN_NAMES.filter((o) => o !== "portal")) {
      expect(originNotice(origin, null)).not.toBeNull();
    }
  });

  test("an origin this build has never heard of is foreign, not `portal`", () => {
    // The failure this gate prevents is silent, so the default has to be "warn".
    // Labelling an unrecognised origin as local by omission is the bug.
    const notice = originNotice("hologram", null);
    expect(notice).not.toBeNull();
    expect(notice?.tone).toBe("warn");
    expect(notice?.headline).toContain("hologram");
  });

  test("a channel reply is named as leaving the tailnet", () => {
    const notice = originNotice("channel", "#acme-support");
    expect(notice?.tone).toBe("warn");
    expect(notice?.badge).toBe("#acme-support");
    expect(notice?.detail).toContain("leaves the tailnet");
  });

  test("a peer reply says it is answering a robot", () => {
    const notice = originNotice("peer", "granite@atlas");
    expect(notice?.headline).toContain("granite@atlas");
    expect(notice?.detail).toContain("robot");
  });

  test("a routine reply says it starts a new session the routine will not read", () => {
    expect(originNotice("routine", "nightly")?.detail).toContain("new session");
  });

  test("a room reply names the room it posts into", () => {
    expect(originNotice("room", "#disk-triage")?.detail).toContain("#disk-triage");
  });

  test('a cli reply is softened to "another client", not just a shell', () => {
    // Upstream Hermes stamps every websocket client `source: \"tui\"`, including
    // its own CLI/TUI and this portal's own canonical-session client, so `cli`
    // means "a client this portal did not record", not specifically a shell.
    const notice = originNotice("cli", null);
    expect(notice?.headline).toContain("another client");
    expect(notice?.headline).not.toContain("command line");
  });

  test("a cli origin on an empty canonical session shows no banner", () => {
    // A freshly created, empty canonical Bot Chat also reads `cli` (same
    // upstream `tui` stamping), and the banner over \"Nothing said yet\" would
    // contradict itself. Suppressed only for this specific, harmless case.
    expect(originNotice("cli", null, true)).toBeNull();
  });

  test("a cli origin on a non-empty session still restates the destination", () => {
    expect(originNotice("cli", null, false)).not.toBeNull();
  });

  // The header badge is the same claim as the banner, in four characters, so it
  // is decided by the same predicate rather than by a second copy of it.
  test("an empty canonical session has no origin to name", () => {
    expect(hasKnownOrigin({ kind: "canonical" }, 0)).toBe(false);
    expect(originNotice("cli", null, !hasKnownOrigin({ kind: "canonical" }, 0))).toBeNull();
  });

  test("a canonical session with messages in it has an origin", () => {
    expect(hasKnownOrigin({ kind: "canonical" }, 1)).toBe(true);
  });

  test("an empty session that is not canonical still has an origin", () => {
    // Only the canonical Bot Chat is created by the portal itself; an empty
    // `thread` session was opened by whoever the origin names.
    expect(hasKnownOrigin({ kind: "thread" }, 0)).toBe(true);
  });

  test("a session that has not been read yet is not treated as empty canonical", () => {
    expect(hasKnownOrigin(null, 0)).toBe(true);
    expect(hasKnownOrigin(undefined, 0)).toBe(true);
  });
});

describe("the destination, which is what the composer actually takes", () => {
  test("a destination that is not yet known is never silent and never sendable", () => {
    // The whole point. `portal` is the one value that suppresses the band, so
    // anything short of a session that was read must show something and must
    // hold the send — a bare `origin ?? \"portal\"` showed nothing and sent.
    for (const dest of [
      { state: "pending" } as const,
      { state: "unchosen", count: 2 } as const,
      { state: "unknown", reason: "The session list could not be read." } as const,
    ]) {
      expect(destinationNotice(dest)).not.toBeNull();
      expect(composerState("ready", dest).enabled).toBe(false);
      expect(originClass(dest)).not.toBe("portal");
    }
  });

  test("a read `portal` is the only thing that silences the band", () => {
    const portal = { state: "known", origin: "portal", detail: null } as const;
    expect(destinationNotice(portal)).toBeNull();
    expect(composerState("ready", portal).enabled).toBe(true);
    expect(originClass(portal)).toBe("portal");
  });

  test("a bot whose only conversations are foreign makes the operator pick one", () => {
    // The fixture has exactly this: a bot with a room and a Slack channel and
    // no canonical session. There is no portal conversation to fall into, and
    // the two that exist go to different places.
    const dest = { state: "unchosen", count: 2 } as const;
    expect(destinationNotice(dest)?.headline).toContain("2 conversations");
    expect(destinationNotice(dest)?.detail).toContain("leave the tailnet");
    expect(composerState("ready", dest).placeholder).toContain("pick a conversation");
  });

  test("a known foreign origin passes straight through to the origin copy", () => {
    const dest = { state: "known", origin: "channel", detail: "#acme-support" } as const;
    expect(destinationNotice(dest)?.detail).toContain("leaves the tailnet");
    expect(originClass(dest)).toBe("channel");
  });

  test("`emptyCanonical` on a known `cli` destination silences the band", () => {
    const dest = { state: "known", origin: "cli", detail: null, emptyCanonical: true } as const;
    expect(destinationNotice(dest)).toBeNull();
  });

  test("a healthy thread with no destination is still not sendable", () => {
    // Both gates, and the destination one is checked first: a `ready` box you
    // cannot name a destination for is exactly where an enabled composer does
    // the damage.
    expect(composerState("ready", { state: "pending" }).enabled).toBe(false);
    expect(composerState("stopped", { state: "pending" }).enabled).toBe(false);
  });
});

/* ── the collapse rule ───────────────────────────────────────────────────── */

describe("the collapse rule", () => {
  test("a settled verdict starts collapsed", () => {
    for (const verdict of ["ok", "warn", "bad", "acc", "muted"] as const) {
      expect(startsCollapsed(verdict)).toBe(true);
    }
  });

  test("`unknown` and anything that failed start open", () => {
    expect(startsCollapsed("unknown")).toBe(false);
    expect(startsCollapsed("ok", true)).toBe(false);
    expect(startsCollapsed("bad", true)).toBe(false);
  });

  test("a running tool is accent, and a status nobody knows is unknown", () => {
    expect(toolVerdict("running")).toBe("acc");
    expect(toolVerdict("ok")).toBe("ok");
    expect(toolVerdict("quantum")).toBe("unknown");
    // …which means it also opens expanded, by the rule above.
    expect(startsCollapsed(toolVerdict("quantum"))).toBe(false);
  });
});

/* ── the block switch ────────────────────────────────────────────────────── */

describe("the block-kind fallthrough", () => {
  test("every kind in the catalogue reaches its own renderer", () => {
    const kinds: string[] = [
      "text",
      "reasoning",
      "tool",
      "attachment",
      "approval",
      "question",
      "sources",
      "hermetic",
      "unknown",
    ];
    for (const kind of kinds) expect(blockKind({ kind })).toBe(kind as never);
  });

  test("a kind this build has never seen is `unknown`, not a crash and not nothing", () => {
    // This is the contract, not a defensive branch: a `hermes_ref` bump can add
    // block kinds, and a version bump must never blank a transcript.
    expect(blockKind({ kind: "hologram" })).toBe("unknown");
    expect(blockKind({})).toBe("unknown");
    expect(blockKind({ kind: 7 })).toBe("unknown");
  });

  test("an unknown block is drawn under its tool name, and an unknown kind under its kind", () => {
    expect(unknownName({ kind: "unknown", name: "bitwarden_secret_get" })).toBe("bitwarden_secret_get");
    expect(unknownName({ kind: "hologram" })).toBe("hologram");
  });

  test("a kind with no `payload` field renders its whole self as the payload", () => {
    expect(unknownPayload({ kind: "unknown", payload: { a: 1 } })).toEqual({ a: 1 });
    const alien = { kind: "hologram", shimmer: true };
    expect(unknownPayload(alien)).toBe(alien);
  });

  test("a payload that cannot be serialised is still shown as something", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(formatPayload(cyclic)).toBeString();
    expect(formatPayload(undefined)).toBe("undefined");
  });
});

/* ── message-level failure ───────────────────────────────────────────────── */

describe("failureCopy", () => {
  test("the six turn failures are one renderer with six sets of words", () => {
    expect(failureCopy("PROVIDER_RATE_LIMIT").title).toContain("Rate limited");
    expect(failureCopy("PROVIDER_AUTH").tone).toBe("bad");
    // The same two failures reach this from three vocabularies — core's
    // `ErrorCode`, the provider's own wording passed through by the box, and
    // the fixture — so the aliases are part of the contract, not a kindness.
    expect(failureCopy("PROVIDER_RATE_LIMITED").title).toContain("Rate limited");
    expect(failureCopy("PROVIDER_UNAUTHORIZED").title).toContain("key was rejected");
    expect(failureCopy("MAX_TURNS").title).toContain("turn ceiling");
    expect(failureCopy("CONTEXT_FULL").title).toContain("window");
    expect(failureCopy("CHAT_UNREACHABLE").title).toContain("stopped answering");
    expect(failureCopy("MODEL_NOT_GRANTED").title).toContain("may not invoke");
  });

  test("a code this build has never heard of still gets a card, with the code on it", () => {
    const copy = failureCopy("HOLOGRAM_REFUSED", "the box said no");
    expect(copy.right).toBe("HOLOGRAM_REFUSED");
    expect(copy.detail).toBe("the box said no");
  });

  test("a turn that merely stopped is not reported as a failure of the box", () => {
    expect(failureCopy("INCOMPLETE").head).toBe("cut off");
    expect(failureCopy("INCOMPLETE").detail).toContain("transcript on the box");
  });
});

/* ── grouping the transcript ─────────────────────────────────────────────── */

describe("messageRows", () => {
  const now = new Date("2026-09-16T12:00:00Z").getTime();

  test("consecutive turns from one author collapse into one block", () => {
    const rows = messageRows(
      [message({ id: "a" }), message({ id: "b" }), message({ id: "c", role: "user" })],
      now,
    );
    expect(rows.map((r) => r.continuation)).toEqual([false, true, false]);
  });

  test("a day boundary raises a divider and breaks the run", () => {
    const rows = messageRows(
      [
        message({ id: "a", at: "2026-09-15T23:50:00Z" }),
        message({ id: "b", at: "2026-09-16T00:10:00Z" }),
      ],
      now,
    );
    expect(rows[0]?.divider).not.toBeNull();
    expect(rows[1]?.divider).not.toBeNull();
    expect(rows[1]?.continuation).toBe(false);
  });

  test("a failed turn never hides under the name of the one above it", () => {
    const rows = messageRows(
      [message({ id: "a" }), message({ id: "b", incomplete: true }), message({ id: "c" })],
      now,
    );
    expect(rows[1]?.continuation).toBe(false);
    expect(rows[2]?.continuation).toBe(false);
  });
});

/* ── the rail ────────────────────────────────────────────────────────────── */

describe("railBuckets", () => {
  test("all-instances scope returns one bucket per box; one-instance returns one", () => {
    const swarms = [
      swarm(),
      swarm({ instance: "ember", bots: [bot({ instance: "ember", name: "ember" })] }),
    ];
    expect(railBuckets(swarms, { scope: { kind: "all" } })).toHaveLength(2);
    const one = railBuckets(swarms, { scope: { kind: "instance", instance: "ember" } });
    expect(one).toHaveLength(1);
    expect(one[0]?.instance).toBe("ember");
  });

  test("an unreachable box keeps its bucket even when the filter would empty it", () => {
    // It is the box an operator is most likely to be looking for. A rail that
    // drops it answers "where did ember go" with silence.
    const swarms = [
      swarm({ instance: "ember", reachable: false, unreachable_reason: "off the tailnet", bots: [] }),
    ];
    const buckets = railBuckets(swarms, { scope: { kind: "all" }, filter: "needs" });
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.reachable).toBe(false);
    expect(buckets[0]?.reason).toBe("off the tailnet");
  });

  test("a reachable box with nothing matching the filter drops out", () => {
    const buckets = railBuckets([swarm()], { scope: { kind: "all" }, filter: "needs" });
    expect(buckets).toHaveLength(0);
  });

  test("sections follow the swarm's declared order, and a section it never declared still shows", () => {
    const swarms = [
      swarm({
        instance: "corvid",
        sections: ["Clients", "Team"],
        bots: [
          bot({ instance: "corvid", name: "unsectioned", is_default: true }),
          bot({ instance: "corvid", name: "teamer", is_default: false, section: "Team" }),
          bot({ instance: "corvid", name: "acme", is_default: false, section: "Clients" }),
          bot({ instance: "corvid", name: "stray", is_default: false, section: "Undeclared" }),
        ],
      }),
    ];
    const sections = railBuckets(swarms, { scope: { kind: "all" } })[0]?.sections ?? [];
    expect(sections.map((s) => s.name)).toEqual(["Clients", "Team", "Undeclared", null]);
  });

  test("the query matches a bot's name, its instance and its section", () => {
    const swarms = [
      swarm({
        bots: [bot({ name: "researcher", is_default: false, section: "Team" }), bot({ name: "atlas" })],
      }),
    ];
    const names = (q: string) =>
      railBuckets(swarms, { scope: { kind: "all" }, query: q }).flatMap((b) =>
        b.sections.flatMap((s) => s.bots.map((x) => x.name)),
      );
    expect(names("resear")).toEqual(["researcher"]);
    expect(names("team")).toEqual(["researcher"]);
    expect(names("atlas")).toContain("atlas");
  });

  test("buckets sink when unreachable and rise when something wants you", () => {
    const quiet = swarm({ instance: "quiet" });
    const loud = swarm({ instance: "loud", bots: [bot({ instance: "loud", needs_action: true })] });
    const gone = swarm({ instance: "gone", reachable: false, bots: [] });
    const order = railBuckets([quiet, gone, loud], { scope: { kind: "all" } }).map((b) => b.instance);
    expect(order[0]).toBe("loud");
    expect(order[2]).toBe("gone");
  });
});

describe("conversation order and badges", () => {
  test("blocked on you outranks unread outranks recency", () => {
    const blocked = bot({ name: "blocked", needs_action: true, is_default: false });
    const unread = bot({ name: "unread", unread: 3, is_default: false });
    const recent = bot({ name: "recent", last_message_at: "2026-09-16T11:00:00Z", is_default: false });
    const sorted = [recent, unread, blocked].sort(compareBots).map((b) => b.name);
    expect(sorted).toEqual(["blocked", "unread", "recent"]);
  });

  test("the default bot wins a tie, because it is the bot that is the box", () => {
    const def = bot({ name: "zebra", is_default: true });
    const other = bot({ name: "alpha", is_default: false });
    expect([other, def].sort(compareBots).map((b) => b.name)).toEqual(["zebra", "alpha"]);
  });

  test("gold outranks orange on the pill too", () => {
    expect(unreadBadge({ unread: 9, needs_action: true })).toBe("!");
    expect(unreadBadge({ unread: 9, needs_action: false })).toBe("9");
    expect(unreadBadge({ unread: 0, needs_action: false })).toBeNull();
  });

  test("compareBuckets is stable enough to be a sort comparator", () => {
    const a = { instance: "a", reachable: true, needsAction: false, unread: 0, lastAt: null };
    expect(compareBuckets(a as never, { ...a, instance: "b" } as never)).toBeLessThan(0);
  });
});

describe("warm slots", () => {
  test("used slots are on, the next one is waiting, the rest are empty", () => {
    // The queue is visible from the first second rather than the thirtieth,
    // because upstream *fails* an open after thirty seconds of waiting.
    expect(warmSlots(2, 3, true)).toEqual(["on", "on", "wait"]);
    expect(warmSlots(1, 3, false)).toEqual(["on", "", ""]);
  });

  test("a box that reported no total still draws three", () => {
    expect(warmSlots(0, 0)).toHaveLength(3);
  });
});

test("the rail footer counts boxes and what is waiting", () => {
  const buckets = railBuckets(
    [swarm(), swarm({ instance: "ember", bots: [bot({ instance: "ember", needs_action: true })] })],
    { scope: { kind: "all" } },
  );
  const foot = railFooter(buckets);
  expect(foot.roster).toBe("2 instances · 2 bots");
  expect(foot.attention).toBe("1 needs you");
});

/* ── thread state ────────────────────────────────────────────────────────── */

describe("threadState", () => {
  const base = { status: "ready", reachable: true, reconnecting: false, empty: false };

  test("the fleet row outranks anything chat learned", () => {
    // Saying "reconnecting…" about a box the fleet already reports stopped is a
    // worse lie than saying nothing.
    expect(threadState({ ...base, status: "stopped", reconnecting: true })).toBe("stopped");
    expect(threadState({ ...base, status: "destroyed", reachable: false })).toBe("destroyed");
    expect(threadState({ ...base, status: "bootstrapping" })).toBe("bootstrapping");
  });

  test("every box failing is no tailnet; one box failing is unreachable", () => {
    expect(threadState({ ...base, reachable: false, fleetUnreachable: true })).toBe("no_tailnet");
    expect(threadState({ ...base, reachable: false })).toBe("unreachable");
  });

  test("a dropped stream, then an empty read, then ready", () => {
    expect(threadState({ ...base, reconnecting: true })).toBe("dropped");
    expect(threadState({ ...base, empty: true })).toBe("empty");
    expect(threadState(base)).toBe("ready");
  });
});

describe("composerState", () => {
  test("terminal and unreachable states refuse a message and say why", () => {
    for (const state of ["destroyed", "stopped", "dropped", "unreachable", "no_tailnet"] as const) {
      const composer = composerState(state);
      expect(composer.enabled).toBe(false);
      expect(composer.placeholder.length).toBeGreaterThan(0);
    }
  });

  test("a box still bootstrapping accepts one, because the message is queued", () => {
    expect(composerState("bootstrapping").enabled).toBe(true);
    expect(composerState("ready").enabled).toBe(true);
  });
});

/* ── the context panel's two derivations ─────────────────────────────────── */

describe("toolsUsed and threadTotals", () => {
  test("tools are listed in first-use order, holding their worst verdict", () => {
    const rows = toolsUsed([
      message({ blocks: [{ kind: "tool", name: "terminal", status: "ok" }] }),
      message({ blocks: [{ kind: "tool", name: "write_file", status: "warn" }] }),
      message({ blocks: [{ kind: "tool", name: "terminal", status: "bad" }] }),
    ]);
    expect(rows.map((r) => r.name)).toEqual(["terminal", "write_file"]);
    expect(rows[0]?.verdict).toBe("bad");
  });

  test("a thread nobody metered says so, rather than claiming it cost nothing", () => {
    expect(threadTotals([message()]).metered).toBe(false);
    const metered = threadTotals([
      message({ usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0.01, model: "m" } }),
    ]);
    expect(metered.metered).toBe(true);
    expect(metered.costUsd).toBeCloseTo(0.01);
  });
});

/* ── URLs a model wrote ──────────────────────────────────────────────────── */

describe("safeHref", () => {
  test("the four shapes a transcript legitimately produces are allowed", () => {
    expect(safeHref("https://docs.aws.amazon.com/ebs")).toBe("https://docs.aws.amazon.com/ebs");
    expect(safeHref("http://127.0.0.1:7433/x")).toBe("http://127.0.0.1:7433/x");
    expect(safeHref("mailto:ops@example.com")).toBe("mailto:ops@example.com");
    expect(safeHref("/api/chat/attachments/fixture/a.png")).toBe("/api/chat/attachments/fixture/a.png");
    expect(safeHref("#source-1")).toBe("#source-1");
  });

  test("a script URL is refused, however it is spelled", () => {
    // The portal is served from loopback, talks to `/api/*` with no token
    // beyond same-origin and has no CSP, so one click on a model-authored
    // `javascript:` link is the whole fleet surface. Allow-list, not blocklist.
    expect(safeHref("javascript:fetch('/api/settings')")).toBeNull();
    expect(safeHref("JavaScript:alert(1)")).toBeNull();
    expect(safeHref("  javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
    expect(safeHref("vbscript:msgbox")).toBeNull();
  });

  test("a protocol-relative URL is absolute, not same-origin", () => {
    expect(safeHref("//evil.example/x")).toBeNull();
  });

  test("absence and nonsense are refused rather than rendered", () => {
    expect(safeHref(null)).toBeNull();
    expect(safeHref("")).toBeNull();
    expect(safeHref("not a url at all")).toBeNull();
  });
});

describe("safeImageSrc", () => {
  test("only what this portal serves, because an image is fetched with no click", () => {
    // A link the operator never follows costs nothing; an `<img>` is a request
    // the browser makes on their behalf, off the tailnet, before anybody
    // clicked. So this is strictly narrower than `safeHref`.
    expect(safeImageSrc("/api/chat/attachments/fixture/a.png")).toBe(
      "/api/chat/attachments/fixture/a.png",
    );
    expect(safeImageSrc("https://beacon.example/pixel?data=secret")).toBeNull();
    expect(safeImageSrc("//beacon.example/p.png")).toBeNull();
    expect(safeImageSrc("data:image/png;base64,AAAA")).toBeNull();
    expect(safeImageSrc(null)).toBeNull();
  });
});
