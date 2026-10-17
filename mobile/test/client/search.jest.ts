import { searchBots, searchKey, searchRank } from "../../src/client/search.ts";
import { bot } from "../helpers/fixtures.ts";

const names = (bots: { instance: string; name: string }[]) =>
  bots.map((b) => `${b.instance}/${b.name}`);

describe("searchBots", () => {
  const bots = [
    bot({
      instance: "atlas",
      name: "nickqabot",
      title: "NickQABot",
      description: "Reviews pull requests",
    }),
    bot({
      instance: "atlas",
      name: "sre",
      title: "SRE",
      preview: "I sent Marshall the weekly SRE digest",
    }),
    bot({ instance: "corvid", name: "clio", title: "Clio", description: "Archivist" }),
    bot({
      instance: "corvid",
      name: "slack",
      title: "Sammy Slack",
      preview: "Messaged Marshall: ArtHelper untracked",
      last_message_at: "2026-10-12T10:00:00.000Z",
    }),
  ];

  test("an empty or blank query finds nothing", () => {
    expect(searchBots(bots, "")).toEqual([]);
    expect(searchBots(bots, "   \n ")).toEqual([]);
  });

  test("case- and whitespace-insensitive", () => {
    expect(names(searchBots(bots, "NICK qa"))).toEqual(["atlas/nickqabot"]);
    expect(names(searchBots(bots, "  sammy   SLACK "))).toEqual(["corvid/slack"]);
    expect(searchKey(" A b\tC ")).toBe("abc");
  });

  test("matches name, title, description, instance and the preview", () => {
    expect(names(searchBots(bots, "sammy"))).toEqual(["corvid/slack"]);
    expect(names(searchBots(bots, "archiv"))).toEqual(["corvid/clio"]);
    expect(names(searchBots(bots, "corvid"))).toEqual(["corvid/slack", "corvid/clio"]);
    expect(names(searchBots(bots, "digest"))).toEqual(["atlas/sre"]);
    expect(searchBots(bots, "nothing like it")).toEqual([]);
  });

  test("ranks name/title prefix > substring > description/instance > preview", () => {
    const ranked = [
      bot({ instance: "x", name: "preview-only", title: "Zed", preview: "talked about mars" }),
      bot({ instance: "x", name: "about", title: "Yew", description: "mars rover" }),
      bot({ instance: "x", name: "inner", title: "Lemars" }),
      bot({ instance: "x", name: "prefix", title: "Marshall" }),
    ];
    expect(ranked.map((b) => searchRank(b, "mars"))).toEqual([3, 2, 1, 0]);
    expect(names(searchBots(ranked, "mars"))).toEqual([
      "x/prefix",
      "x/inner",
      "x/about",
      "x/preview-only",
    ]);
  });

  test("several words each matching somewhere rank by the weakest word", () => {
    expect(names(searchBots(bots, "clio corvid"))).toEqual(["corvid/clio"]);
    expect(searchRank(bots[2] as (typeof bots)[number], "clio corvid")).toBe(2);
    expect(searchBots(bots, "clio atlas")).toEqual([]);
  });

  test("ties go to the most recent message, then the title", () => {
    const tied = [
      bot({ instance: "a", name: "bravo", title: "Bravo" }),
      bot({ instance: "a", name: "alpha", title: "Alpha" }),
      bot({
        instance: "a",
        name: "charlie",
        title: "Charlie",
        last_message_at: "2026-10-13T09:00:00.000Z",
      }),
    ];
    // Alpha is the only prefix hit; Bravo and Charlie tie on a substring hit.
    expect(names(searchBots(tied, "a"))).toEqual(["a/alpha", "a/charlie", "a/bravo"]);
    // Same tier, neither has a message: the title decides.
    const untimed = [
      bot({ instance: "a", name: "zeta", title: "Zeta" }),
      bot({ instance: "a", name: "yara", title: "Yara" }),
    ];
    expect(untimed.map((b) => searchRank(b, "a"))).toEqual([1, 1]);
    expect(names(searchBots(untimed, "a"))).toEqual(["a/yara", "a/zeta"]);
  });
});
