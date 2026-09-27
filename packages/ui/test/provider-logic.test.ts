/**
 * §8.3's rules, without a DOM: what a badge says, which profiles a create may
 * offer, which actions are refused and why, and how a live catalog is ordered
 * against the model that is already selected.
 */
import { describe, expect, test } from "bun:test";
import type { AgentView, CatalogModel, ProfileView } from "../src/api/index.ts";
import {
  canDeleteProfile,
  canDisableProfile,
  canRotateKey,
  canSetDefault,
  catalogFailure,
  credentialLine,
  pinSelected,
  preselectedProfile,
  profileUpdateAvailable,
  readyBadge,
  readyProfiles,
  searchModels,
} from "../src/logic/provider-logic.ts";
import { FIXTURE_PROFILES } from "./profiles-fixture.ts";

function byName(name: string): ProfileView {
  const found = FIXTURE_PROFILES.find((p) => p.name === name);
  if (found === undefined) throw new Error(`no fixture profile ${name}`);
  return found;
}

describe("readiness", () => {
  test("a stored key is reported as stored, never as verified", () => {
    const badge = readyBadge(byName("anthropic-main"));
    expect(badge.label).toBe("ready");
    expect(badge.reason).toContain("not the same as verified");
  });

  test("each unready reason has its own word and its own colour", () => {
    expect(readyBadge(byName("nous-lab")).label).toBe("placeholder");
    expect(readyBadge(byName("nous-lab")).color).toBe("var(--bad)");
    expect(readyBadge(byName("vercel-gw")).label).toBe("disabled");
    expect(readyBadge({ ready_reason: "grant-missing" })).toMatchObject({
      label: "needs foundation update",
      color: "var(--warn)",
    });
  });

  test("a create is offered only ready profiles", () => {
    expect(readyProfiles(FIXTURE_PROFILES).map((p) => p.name)).toEqual([
      "openrouter-cheap",
      "anthropic-main",
      "bedrock-role",
    ]);
  });

  test("the fleet default is preselected only while it is ready", () => {
    // The fixture's default is deliberately not the first ready profile, so
    // this asserts "the default" rather than "whoever is first".
    expect(readyProfiles(FIXTURE_PROFILES)[0]?.name).not.toBe("anthropic-main");
    expect(preselectedProfile(FIXTURE_PROFILES, "an7hr0p1")?.name).toBe("anthropic-main");
    // A default that has gone unready is not silently replaced by another one.
    expect(preselectedProfile(FIXTURE_PROFILES, "n0us1ab0")).toBeNull();
    expect(preselectedProfile(FIXTURE_PROFILES, null)).toBeNull();
  });
});

describe("what a profile's actions are allowed to do", () => {
  test("a profile with agents on it cannot be deleted, and the agents are named", () => {
    const refusal = canDeleteProfile(byName("anthropic-main"));
    expect(refusal.ok).toBe(false);
    expect(refusal.reason).toContain("lumen");
  });

  test("the fleet default cannot be deleted or disabled", () => {
    const orphanDefault = { ...byName("openrouter-cheap"), is_default: true };
    expect(canDeleteProfile(orphanDefault).ok).toBe(false);
    expect(canDisableProfile(orphanDefault).ok).toBe(false);
    expect(canDisableProfile(byName("openrouter-cheap")).ok).toBe(true);
  });

  test("only a ready profile may become the default", () => {
    expect(canSetDefault(byName("nous-lab")).ok).toBe(false);
    expect(canSetDefault(byName("nous-lab")).reason).toContain("not ready");
    expect(canSetDefault(byName("openrouter-cheap")).ok).toBe(true);
    expect(canSetDefault(byName("anthropic-main")).ok).toBe(false);
  });

  test("a role-authenticated profile has no key to rotate", () => {
    expect(canRotateKey(byName("bedrock-role")).ok).toBe(false);
    expect(canRotateKey(byName("anthropic-main")).ok).toBe(true);
  });
});

describe("the catalog", () => {
  const models: CatalogModel[] = [
    { id: "a-1", name: "A one" },
    { id: "b-2", name: "B two" },
    { id: "c-3", name: "C three" },
  ];

  test("the selected model is pinned first, and the rest keep their order", () => {
    expect(pinSelected(models, "c-3").map((m) => m.id)).toEqual(["c-3", "a-1", "b-2"]);
  });

  test("a selection the provider does not list is kept and marked unlisted", () => {
    const out = pinSelected(models, "my/custom-model");
    expect(out[0]).toEqual({ id: "my/custom-model", name: "my/custom-model", unlisted: true });
    expect(out).toHaveLength(4);
  });

  test("refreshing cannot move the selection: the order is a function of it alone", () => {
    const refreshed: CatalogModel[] = [{ id: "z-9", name: "Z nine" }, ...models];
    expect(pinSelected(refreshed, "b-2")[0]?.id).toBe("b-2");
    expect(pinSelected(refreshed, "my/custom-model")[0]?.id).toBe("my/custom-model");
  });

  test("search matches id and display name, case-insensitively", () => {
    expect(searchModels(models, "b").map((m) => m.id)).toEqual(["b-2"]);
    expect(searchModels(models, "THREE").map((m) => m.id)).toEqual(["c-3"]);
    expect(searchModels(models, "  ")).toHaveLength(3);
  });

  test("a failure keeps its code, because the next move differs per code", () => {
    expect(catalogFailure("PROVIDER_AUTH", "…")).toContain("PROVIDER_AUTH");
    expect(catalogFailure("PROVIDER_AUTH", "…")).toContain("rejected this key");
    expect(catalogFailure("PROVIDER_UNREACHABLE", "…")).toContain("could not be reached");
    expect(catalogFailure("WHAT", "the message core wrote")).toBe("WHAT · the message core wrote");
  });
});

describe("an agent's binding", () => {
  function agent(over: Partial<AgentView>): AgentView {
    return { name: "lumen", ...over } as AgentView;
  }

  test("the row's own answer wins where core computed one", () => {
    expect(profileUpdateAvailable(agent({ update_available: true }), FIXTURE_PROFILES)).toBe(true);
    expect(
      profileUpdateAvailable(
        agent({ update_available: false, profile_id: "an7hr0p1", profile_revision: 1 }),
        FIXTURE_PROFILES.map((p) => ({ ...p, revision: 9 })),
      ),
    ).toBe(false);
  });

  test("absent, it is the same comparison made from the profile list", () => {
    expect(
      profileUpdateAvailable(agent({ profile_id: "an7hr0p1", profile_revision: 1 }), FIXTURE_PROFILES),
    ).toBe(false);
    expect(
      profileUpdateAvailable(
        agent({ profile_id: "an7hr0p1", profile_revision: 1 }),
        FIXTURE_PROFILES.map((p) => (p.id === "an7hr0p1" ? { ...p, revision: 4 } : p)),
      ),
    ).toBe(true);
  });

  test("a row with no binding at all claims nothing", () => {
    expect(profileUpdateAvailable(agent({}), FIXTURE_PROFILES)).toBe(false);
  });

  /**
   * `credential_ref` has three states and only one of them is a slot name, so
   * the line has three answers. The bug it was written for: `?? "provider-key"`
   * read `null` — the *cleared* state a role-authenticated agent carries — as
   * the legacy slot, telling an operator their Bedrock agent reads a key that
   * has never existed.
   */
  test("a slot name is shown as it is", () => {
    expect(
      credentialLine(
        agent({ provider: "anthropic", credential_ref: "provider-key-an7hr0p1-r1" }),
        FIXTURE_PROFILES,
        "an7hr0p1",
      ),
    ).toEqual({ text: "provider-key-an7hr0p1-r1", mono: true });
  });

  test("a cleared ref is the instance role, never the legacy slot", () => {
    expect(
      credentialLine(
        agent({ provider: "bedrock", credential_ref: null }),
        FIXTURE_PROFILES,
        "b3dr0ck0",
      ),
    ).toEqual({ text: "IAM instance role · no key", mono: false });
  });

  test("a role-authenticated provider says so even with no ref and no profile", () => {
    // The pre-profiles shape of a Bedrock row: nothing to name, and a
    // `provider-key` slot that was never written for it either.
    expect(credentialLine(agent({ provider: "bedrock" }), [])).toEqual({
      text: "IAM instance role · no key",
      mono: false,
    });
  });

  test("only a keyed provider with no ref falls back to the legacy slot", () => {
    expect(credentialLine(agent({ provider: "anthropic" }), [])).toEqual({
      text: "provider-key",
      mono: true,
    });
  });
});
