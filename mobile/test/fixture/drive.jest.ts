/**
 * The fixture's drive link (`src/fixture/drive.ts`): its query read into
 * checked steps, the steps taken in a fixed order whatever the URL's, an
 * off-device `to` refused, unknown parameters ignored, a failing step
 * reported without stopping the rest, and `createBot` (checked, created after
 * the primary, a bot that exists already counted as made, its chat the default
 * destination).
 */
import {
  applyDrive,
  DRIVE_DEFAULT_ROUTE,
  drive,
  isAppRoute,
  parseDriveBot,
  parseDriveParams,
} from "../../src/fixture/drive.ts";
import { fixtureKit } from "../../src/fixture/index.ts";
import type { FixtureDriveActions } from "../../src/fleet/FleetProvider.tsx";

type Failure = string | { code: string; message: string };

function recorder(fail: Partial<Record<"pair" | "setPrimary" | "listen" | "createBot", Failure>> = {}) {
  const calls: string[] = [];
  const warnings: string[] = [];
  const maybeFail = (step: keyof typeof fail) => {
    const failure = fail[step];
    if (typeof failure === "string") throw new Error(failure);
    if (failure) throw Object.assign(new Error(failure.message), { code: failure.code });
  };
  const actions: FixtureDriveActions = {
    pair: async () => {
      calls.push("pair");
      maybeFail("pair");
    },
    setPrimary: async (name) => {
      calls.push(`primary:${name}`);
      maybeFail("setPrimary");
    },
    listen: async (name) => {
      calls.push(`listen:${name}`);
      maybeFail("listen");
    },
    createBot: async (instance, input) => {
      calls.push(`createBot:${instance}:${JSON.stringify(input)}`);
      maybeFail("createBot");
    },
    setAvatarStyle: (style) => {
      calls.push(`avatar:${style}`);
    },
    setTheme: (preference) => {
      calls.push(`theme:${preference}`);
    },
    warn: (message) => {
      warnings.push(message);
    },
  };
  return { actions, calls, warnings };
}

describe("parseDriveParams", () => {
  test("an empty link does nothing and goes to the entry", () => {
    expect(parseDriveParams({})).toEqual({
      pair: false,
      listen: [],
      primary: null,
      createBot: null,
      avatar: null,
      theme: null,
      to: null,
      refused: [],
    });
    expect(DRIVE_DEFAULT_ROUTE).toBe("/");
  });

  test("reads every parameter", () => {
    expect(
      parseDriveParams({
        pair: "1",
        primary: "atlas",
        listen: "corvid, heron,corvid,",
        createBot: "atlas:Scout:Field scout: north",
        avatar: "pixel",
        theme: "light",
        to: "/chat/atlas/default?demo=E2E_APPROVAL",
      }),
    ).toEqual({
      pair: true,
      listen: ["corvid", "heron"],
      primary: "atlas",
      createBot: { instance: "atlas", name: "scout", title: "Field scout: north" },
      avatar: "pixel",
      theme: "light",
      to: "/chat/atlas/default?demo=E2E_APPROVAL",
      refused: [],
    });
  });

  test("a repeated parameter takes its first value", () => {
    expect(parseDriveParams({ primary: ["atlas", "corvid"] }).primary).toBe("atlas");
  });

  test("unknown parameters are ignored", () => {
    const ops = parseDriveParams({ banana: "1", demo: "E2E_APPROVAL", fleet: "x" });
    expect(ops).toEqual(parseDriveParams({}));
  });

  test("bad values are refused, one line each, and the rest still read", () => {
    const ops = parseDriveParams({
      pair: "yes",
      primary: "Not A Name",
      listen: "atlas,bad_name",
      createBot: "atlas",
      avatar: "photo",
      theme: "sepia",
      to: "https://example.com",
    });
    expect(ops.pair).toBe(false);
    expect(ops.primary).toBeNull();
    expect(ops.listen).toEqual(["atlas"]);
    expect(ops.avatar).toBeNull();
    expect(ops.theme).toBeNull();
    expect(ops.to).toBe(DRIVE_DEFAULT_ROUTE);
    expect(ops.createBot).toBeNull();
    expect(ops.refused).toHaveLength(7);
    expect(ops.refused.map((line) => line.split("=")[0])).toEqual([
      "pair",
      "listen",
      "primary",
      "createBot",
      "avatar",
      "theme",
      "to",
    ]);
  });

  test("pair=0 is no pairing, not a refusal", () => {
    expect(parseDriveParams({ pair: "0" })).toMatchObject({ pair: false, refused: [] });
  });
});

describe("parseDriveBot", () => {
  test("instance and name, lowercased; a title when given", () => {
    expect(parseDriveBot("atlas:scout")).toEqual({ instance: "atlas", name: "scout" });
    expect(parseDriveBot(" atlas : Scout.v2 : ")).toEqual({ instance: "atlas", name: "scout.v2" });
    expect(parseDriveBot("atlas:scout:Scout")).toEqual({
      instance: "atlas",
      name: "scout",
      title: "Scout",
    });
  });
  test.each([
    ["atlas", "expected <instance>:<name>[:<title>]"],
    [":scout", "(empty) is not an agent name"],
    ["Atlas!:scout", "Atlas! is not an agent name"],
    ["atlas:", "(empty) is not a bot name"],
    ["atlas:-scout", "-scout is not a bot name"],
    ["atlas:sc out", "sc out is not a bot name"],
    [`atlas:scout:${"x".repeat(65)}`, "the title is longer than 64 characters"],
  ])("%j is refused", (raw, why) => {
    expect(parseDriveBot(raw)).toBe(why);
  });
});

describe("isAppRoute", () => {
  test.each(["/", "/home", "/settings", "/chat/atlas/default?demo=E2E_APPROVAL"])(
    "%s is in-app",
    (to) => {
      expect(isAppRoute(to)).toBe(true);
    },
  );
  test.each([
    "home",
    "https://example.com/home",
    "hermetic://home",
    "//example.com/home",
    "/\\example.com",
    "/home\nx",
    "javascript:alert(1)",
  ])("%j is refused", (to) => {
    expect(isAppRoute(to)).toBe(false);
    // Refused is not absent: the entry, never a created bot's chat.
    expect(parseDriveParams({ to }).to).toBe(DRIVE_DEFAULT_ROUTE);
  });
});

describe("applyDrive", () => {
  test("steps run pair, listen, primary, createBot, avatar, theme whatever the URL order", async () => {
    const { actions, calls, warnings } = recorder();
    const to = await drive(
      {
        to: "/settings",
        theme: "dark",
        avatar: "blob",
        createBot: "atlas:scout",
        primary: "atlas",
        listen: "corvid,heron",
        pair: "1",
      },
      actions,
    );
    expect(calls).toEqual([
      "pair",
      "listen:corvid",
      "listen:heron",
      "primary:atlas",
      'createBot:atlas:{"name":"scout"}',
      "avatar:blob",
      "theme:dark",
    ]);
    expect(warnings).toEqual([]);
    // A `to` wins over the new bot's chat.
    expect(to).toBe("/settings");
  });

  test("a created bot's chat is where the link goes when it names nowhere", async () => {
    const { actions, calls, warnings } = recorder();
    const to = await drive({ createBot: "atlas:scout:Scout" }, actions);
    expect(calls).toEqual(['createBot:atlas:{"name":"scout","title":"Scout"}']);
    expect(warnings).toEqual([]);
    expect(to).toBe("/chat/atlas/scout");
  });

  test("a bot that exists already (CONFLICT) counts as made, unwarned", async () => {
    const { actions, warnings } = recorder({ createBot: { code: "CONFLICT", message: "exists" } });
    expect(await drive({ createBot: "atlas:scout" }, actions)).toBe("/chat/atlas/scout");
    expect(warnings).toEqual([]);
  });

  test("a create that fails is warned, the rest run, and the link goes to the entry", async () => {
    const { actions, calls, warnings } = recorder({
      createBot: { code: "UNREACHABLE", message: "atlas did not answer" },
    });
    const to = await drive({ createBot: "atlas:scout", theme: "light" }, actions);
    expect(calls).toEqual(['createBot:atlas:{"name":"scout"}', "theme:light"]);
    expect(warnings).toEqual(["createBot atlas:scout: atlas did not answer"]);
    expect(to).toBe("/");
  });

  test("only what the link names runs", async () => {
    const { actions, calls } = recorder();
    expect(await drive({ avatar: "sigil" }, actions)).toBe("/");
    expect(calls).toEqual(["avatar:sigil"]);
  });

  test("a failing step is warned and the rest still run", async () => {
    const { actions, calls, warnings } = recorder({ setPrimary: "nope is not an agent in this fleet" });
    const to = await applyDrive(
      parseDriveParams({ primary: "nope", theme: "light", to: "/home" }),
      actions,
    );
    expect(calls).toEqual(["primary:nope", "theme:light"]);
    expect(warnings).toEqual(["primary nope: nope is not an agent in this fleet"]);
    expect(to).toBe("/home");
  });

  test("refusals are warned before any step", async () => {
    const { actions, calls, warnings } = recorder();
    const to = await drive({ to: "https://example.com", avatar: "pixel" }, actions);
    expect(warnings).toEqual(["to=https://example.com: not an in-app route"]);
    expect(calls).toEqual(["avatar:pixel"]);
    expect(to).toBe("/");
  });
});

test("the fixture kit carries the driver", () => {
  expect(fixtureKit("1")?.drive).toBe(drive);
});
