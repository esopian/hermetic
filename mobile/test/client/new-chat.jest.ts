import { freshChatPath, isFresh, newChatBots } from "../../src/chat/new-chat.ts";
import { bot, swarm } from "../helpers/fixtures.ts";

describe("new chat sheet", () => {
  test("listened bots only, in listening order, the default bot first, then by title", () => {
    const swarms = [
      swarm("atlas", [
        bot({ name: "scribe", title: "Scribe" }),
        bot({ name: "default", title: "Atlas", is_default: true }),
        bot({ name: "archer", title: "Archer" }),
      ]),
      swarm("corvid", [bot({ name: "clio", title: "Clio" })]),
      swarm("muted", [bot({ name: "ignored" })]),
    ];
    expect(newChatBots(swarms, ["corvid", "atlas"]).map((b) => `${b.instance}/${b.name}`)).toEqual([
      "corvid/clio",
      "atlas/default",
      "atlas/archer",
      "atlas/scribe",
    ]);
    expect(newChatBots(swarms, [])).toEqual([]);
  });

  test("a pick opens the conversation with fresh=1, names encoded", () => {
    expect(freshChatPath({ instance: "at las", name: "a/b" })).toBe("/chat/at%20las/a%2Fb?fresh=1");
  });

  test("isFresh reads the route param once, in either shape", () => {
    expect(isFresh("1")).toBe(true);
    expect(isFresh(["1"])).toBe(true);
    expect(isFresh(undefined)).toBe(false);
    expect(isFresh("0")).toBe(false);
  });
});
