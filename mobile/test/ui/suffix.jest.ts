import { quietSuffix, sharedTitles } from "../../src/bots/suffix.ts";

describe("quietSuffix", () => {
  test("drops an instance that only repeats the title, whatever its case", () => {
    expect(quietSuffix("atlas", null, "atlas")).toBeNull();
    expect(quietSuffix("Corvid", null, "corvid")).toBeNull();
    expect(quietSuffix("Magpie", null, "corvid")).toBe("corvid");
  });

  test("says the bot's name when titles collide, then the instance, never twice", () => {
    expect(quietSuffix("Scribe", "scribe-2", "atlas")).toBe("scribe-2 · atlas");
    expect(quietSuffix("Scribe", "scribe", "atlas")).toBe("atlas");
    expect(quietSuffix("Scribe", "atlas", "atlas")).toBe("atlas");
    expect(quietSuffix("Scribe", null, null)).toBeNull();
  });
});

describe("sharedTitles", () => {
  test("only bots of one instance sharing a title", () => {
    const shared = sharedTitles([
      { instance: "atlas", name: "scribe", title: "Scribe" },
      { instance: "atlas", name: "scribe-2", title: "scribe" },
      { instance: "corvid", name: "scribe", title: "Scribe" },
      { instance: "corvid", name: "magpie", title: "" },
    ]);
    expect([...shared].sort()).toEqual(["atlas/scribe", "atlas/scribe-2"]);
  });
});
