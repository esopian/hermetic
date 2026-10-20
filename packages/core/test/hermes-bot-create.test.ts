import { describe, expect, test } from "bun:test";
import { createBotOverRpc } from "../src/chat/hermes/hermes-bot-create.ts";
import { HermeticError } from "../src/errors.ts";

type Call = { method: string; params: Record<string, unknown> };

/** A scripted gateway: each method answers from `answers`, every call recorded. */
function scripted(answers: Record<string, unknown>) {
  const calls: Call[] = [];
  const call = async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    if (!(method in answers)) throw new Error(`unscripted ${method}`);
    return answers[method];
  };
  return { calls, call };
}

const DESCRIBED = {
  name: "scout",
  description: "Finds things",
  soul: "Curious",
  model: { provider: "anthropic", default: "claude" },
  skills: [{ name: "web", enabled: true }],
  toolsets: [],
  mcp_servers: [],
};

describe("createBotOverRpc", () => {
  test("creates, writes the hermes-bots marker, then describes", async () => {
    const gw = scripted({
      "profiles.create": { ok: true, name: "scout" },
      "profiles.configure": { ok: true, applied: { ui_meta: true } },
      "profiles.describe": DESCRIBED,
    });
    const profile = await createBotOverRpc(
      gw.call,
      {
        instance: "atlas",
        name: "scout",
        title: "Scout",
        description: "Finds things",
        model: "claude",
      },
      () => 1_700_000_000_000,
    );
    expect(gw.calls).toEqual([
      {
        method: "profiles.create",
        params: {
          name: "scout",
          description: "Finds things",
          model: "claude",
          mirror_credentials: true,
        },
      },
      {
        method: "profiles.configure",
        params: {
          name: "scout",
          ui_meta: { "hermes-bots": { version: 1, title: "Scout", created: 1_700_000_000_000 } },
        },
      },
      { method: "profiles.describe", params: { name: "scout" } },
    ]);
    expect(profile).toEqual({
      instance: "atlas",
      bot: "scout",
      description: "Finds things",
      soul: "Curious",
      model: { provider: "anthropic", default: "claude" },
      skills: [{ name: "web", enabled: true }],
      toolsets: [],
      mcp_servers: [],
    });
  });

  test("an empty title writes no title key", async () => {
    const gw = scripted({
      "profiles.create": { ok: true },
      "profiles.configure": { ok: true, applied: { ui_meta: true } },
      "profiles.describe": DESCRIBED,
    });
    await createBotOverRpc(gw.call, { instance: "atlas", name: "scout", title: "" }, () => 5);
    expect(gw.calls[1]?.params).toEqual({
      name: "scout",
      ui_meta: { "hermes-bots": { version: 1, created: 5 } },
    });
  });

  test("a create the gateway does not confirm stops before the marker", async () => {
    const gw = scripted({ "profiles.create": { ok: false } });
    const failure = await createBotOverRpc(gw.call, { instance: "atlas", name: "scout" }).catch(
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(HermeticError);
    expect((failure as HermeticError).code).toBe("CHAT_PROTOCOL");
    expect(gw.calls.map((c) => c.method)).toEqual(["profiles.create"]);
  });

  test("a marker the gateway did not apply is refused, the profile left alone", async () => {
    const gw = scripted({
      "profiles.create": { ok: true },
      "profiles.configure": { ok: true, applied: { ui_meta: false } },
    });
    const failure = await createBotOverRpc(gw.call, { instance: "atlas", name: "scout" }).catch(
      (e: unknown) => e,
    );
    expect((failure as HermeticError).code).toBe("CHAT_PROTOCOL");
    expect((failure as HermeticError).message).toContain("inspect the profile");
    expect(gw.calls.map((c) => c.method)).toEqual(["profiles.create", "profiles.configure"]);
  });
});
