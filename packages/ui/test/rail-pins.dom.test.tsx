/**
 * Pinning bots to the top of the chat rail, and folding an instance's bucket
 * shut without going deaf to it.
 *
 * The operator's habit these serve: read one bot, or a handful across boxes,
 * most of the day, while the rest of the fleet can still ask for attention.
 * So a fold hides rows and never the signal — the header keeps the bucket's
 * unread and needs-you counts — and a pin lifts a bot out of its bucket, the
 * way Slack's starred channels leave their section.
 */
import { cleanup, fireEvent, render, screen, within } from "./dom.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { SwarmView } from "../src/api/index.ts";
import { CHAT_RAIL_PREFS_KEY, readRailPrefs } from "../src/chat/chat-rail-prefs.ts";
import { BotRail } from "../src/chat/components/BotRail.tsx";
import type { ChatSelection } from "../src/chat/chat-state.tsx";

const FLEET = "fxtr0001";

function clearPrefs() {
  for (const key of Object.keys(window.localStorage))
    if (key.startsWith(CHAT_RAIL_PREFS_KEY)) window.localStorage.removeItem(key);
}
beforeEach(clearPrefs);
afterEach(() => {
  cleanup();
  clearPrefs();
});

function bot(instance: string, name: string, over: Record<string, unknown> = {}) {
  return {
    instance,
    name,
    title: `${name} bot`,
    description: null,
    preview: null,
    is_default: name === "default",
    section: null,
    avatar_seed: "seed",
    last_message_at: "2026-09-19T10:00:00.000Z",
    unread: 0,
    needs_action: false,
    muted: false,
    warm: true,
    ...over,
  };
}

function swarm(instance: string, bots: ReturnType<typeof bot>[], over: Record<string, unknown> = {}) {
  return {
    instance,
    reachable: true,
    unreachable_reason: null,
    bots,
    rooms: [],
    warm_slots: { used: 1, total: 3 },
    sections: [],
    ...over,
  } as unknown as SwarmView;
}

const FLEET_SWARMS = [
  swarm("atlas", [bot("atlas", "default"), bot("atlas", "scribe")]),
  swarm("corvid", [bot("corvid", "default", { unread: 2 }), bot("corvid", "herald")]),
];

function rail(
  props: {
    swarms?: SwarmView[];
    query?: string;
    selection?: ChatSelection | null;
    fleetId?: string;
  } = {},
) {
  return render(
    <BotRail
      swarms={props.swarms ?? FLEET_SWARMS}
      sessions={[]}
      selection={props.selection ?? null}
      room={null}
      fleetId={props.fleetId ?? FLEET}
      now={Date.parse("2026-09-19T10:05:00.000Z")}
      query={props.query ?? ""}
      onQuery={() => {}}
      onSelect={() => {}}
      onRoom={() => {}}
      onCreateBot={() => {}}
      onCreateRoom={() => {}}
      onNewSession={() => {}}
      statusOf={() => "ready"}
      activities={[]}
    />,
  );
}

const rowTitles = (scope: ParentNode = document) =>
  [...scope.querySelectorAll(".ch-conv .ch-conv-name b")].map((b) => b.textContent);

const bucket = (instance: string) =>
  screen.getByRole("button", { name: new RegExp(`^(Collapse|Expand) ${instance}$`) });

test("pinning lifts a bot into a Pinned group at the top, out of its bucket", () => {
  rail();
  expect(document.querySelector(".bm-pinned")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Pin herald bot @ corvid" }));

  const group = document.querySelector(".bm-pinned") as HTMLElement;
  expect(group).not.toBeNull();
  expect(within(group).getByText("★ Pinned")).toBeTruthy();
  expect(rowTitles(group)).toEqual(["herald bot"]);
  // Out of its bucket, the row names its box itself.
  expect(group.querySelector(".bm-pin-where")?.textContent).toContain("corvid");
  // One row per bot: it is not drawn again under corvid.
  expect(rowTitles().filter((t) => t === "herald bot")).toHaveLength(1);
  // The Pinned group comes before every bucket.
  const list = document.querySelector(".ch-list") as HTMLElement;
  expect(list.firstElementChild).toBe(group);

  expect(readRailPrefs(FLEET).pinned).toEqual(["corvid/herald"]);
});

test("pins keep the order they were made in, across instances, and unpin in place", () => {
  rail();
  fireEvent.click(screen.getByRole("button", { name: "Pin scribe bot @ atlas" }));
  fireEvent.click(screen.getByRole("button", { name: "Pin default bot @ corvid" }));
  fireEvent.click(screen.getByRole("button", { name: "Pin herald bot @ corvid" }));
  const group = () => document.querySelector(".bm-pinned") as HTMLElement;
  expect(rowTitles(group())).toEqual(["scribe bot", "default bot", "herald bot"]);

  fireEvent.click(within(group()).getByRole("button", { name: "Unpin default bot @ corvid" }));
  expect(rowTitles(group())).toEqual(["scribe bot", "herald bot"]);
  expect(readRailPrefs(FLEET).pinned).toEqual(["atlas/scribe", "corvid/herald"]);
});

test("a bucket whose bots are all pinned draws no empty header", () => {
  rail();
  fireEvent.click(screen.getByRole("button", { name: "Pin default bot @ atlas" }));
  fireEvent.click(screen.getByRole("button", { name: "Pin scribe bot @ atlas" }));
  expect(screen.queryByRole("button", { name: /^(Collapse|Expand) atlas$/ })).toBeNull();
  expect(bucket("corvid")).toBeTruthy();
});

test("pins survive a remount and belong to one fleet", () => {
  const first = rail();
  fireEvent.click(screen.getByRole("button", { name: "Pin scribe bot @ atlas" }));
  first.unmount();

  rail();
  expect(rowTitles(document.querySelector(".bm-pinned") as HTMLElement)).toEqual(["scribe bot"]);
  cleanup();

  // The same instance and bot names on another fleet are other conversations.
  rail({ fleetId: "sg7k2m4p" });
  expect(document.querySelector(".bm-pinned")).toBeNull();
});

test("a pinned bot still obeys the search", () => {
  window.localStorage.setItem(
    `${CHAT_RAIL_PREFS_KEY}.${FLEET}`,
    JSON.stringify({ pinned: ["atlas/scribe"], collapsed: [] }),
  );
  rail({ query: "herald" });
  expect(document.querySelector(".bm-pinned")).toBeNull();
  expect(rowTitles()).toEqual(["herald bot"]);
});

test("folding a bucket hides its rows and keeps its unread count on the header", () => {
  rail();
  expect(bucket("corvid").getAttribute("aria-expanded")).toBe("true");
  expect(rowTitles()).toContain("herald bot");
  // Open, the rows carry the count; the header does not repeat it.
  expect(bucket("corvid").querySelector(".ch-unread")).toBeNull();

  fireEvent.click(bucket("corvid"));

  expect(bucket("corvid").getAttribute("aria-expanded")).toBe("false");
  expect(rowTitles()).toEqual(["default bot", "scribe bot"]);
  expect(bucket("corvid").querySelector(".ch-unread")?.textContent).toBe("2");
  expect(readRailPrefs(FLEET).collapsed).toEqual(["corvid"]);

  fireEvent.click(bucket("corvid"));
  expect(rowTitles()).toContain("herald bot");
  expect(readRailPrefs(FLEET).collapsed).toEqual([]);
});

test("a folded bucket with a bot waiting on you says `!`, not a count", () => {
  rail({
    swarms: [
      swarm("corvid", [
        bot("corvid", "default", { unread: 2 }),
        bot("corvid", "herald", { needs_action: true }),
      ]),
    ],
  });
  fireEvent.click(bucket("corvid"));
  const badge = bucket("corvid").querySelector(".ch-unread") as HTMLElement;
  expect(badge.textContent).toBe("!");
  expect(badge.className).toContain("needs-action");
});

test("a pinned bot stays in view while its bucket is folded", () => {
  rail();
  fireEvent.click(screen.getByRole("button", { name: "Pin herald bot @ corvid" }));
  fireEvent.click(bucket("corvid"));
  expect(rowTitles()).toEqual(["herald bot", "default bot", "scribe bot"]);
});

test("the open conversation stays drawn under its folded bucket", () => {
  window.localStorage.setItem(
    `${CHAT_RAIL_PREFS_KEY}.${FLEET}`,
    JSON.stringify({ pinned: [], collapsed: ["corvid"] }),
  );
  rail({ selection: { instance: "corvid", bot: "herald", session: null } });
  expect(bucket("corvid").getAttribute("aria-expanded")).toBe("false");
  expect(rowTitles()).toEqual(["default bot", "scribe bot", "herald bot"]);
});

test("a search opens folded buckets, so a match is never hidden", () => {
  window.localStorage.setItem(
    `${CHAT_RAIL_PREFS_KEY}.${FLEET}`,
    JSON.stringify({ pinned: [], collapsed: ["corvid"] }),
  );
  rail({ query: "herald" });
  expect(rowTitles()).toEqual(["herald bot"]);
  expect((bucket("corvid") as HTMLButtonElement).disabled).toBe(true);
});

test("an unreachable box keeps a read-only header, not a fold control", () => {
  rail({
    swarms: [
      swarm("ember", [bot("ember", "default")], {
        reachable: false,
        unreachable_reason: "off the tailnet",
      }),
    ],
  });
  const head = document.querySelector(".ch-bucket.offline") as HTMLElement;
  expect(head.tagName.toLowerCase()).toBe("div");
  expect(rowTitles()).toEqual(["default bot"]);
});

test("an unreadable stored document reads as no preference", () => {
  window.localStorage.setItem(`${CHAT_RAIL_PREFS_KEY}.${FLEET}`, "{not json");
  expect(readRailPrefs(FLEET)).toEqual({ pinned: [], collapsed: [] });
  window.localStorage.setItem(
    `${CHAT_RAIL_PREFS_KEY}.${FLEET}`,
    JSON.stringify({ pinned: ["a/b", 3, "a/b"], collapsed: "atlas" }),
  );
  expect(readRailPrefs(FLEET)).toEqual({ pinned: ["a/b"], collapsed: [] });
});
