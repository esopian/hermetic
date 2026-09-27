/**
 * §8.3's profiles as the fixture fleet seeds them, for the tests that render
 * something built out of them.
 *
 * Five profiles, one per interesting state: ready with a key, ready on the
 * instance role, a placeholder key, a disabled profile, and one whose Bedrock
 * model the fleet has not granted. Mirrors `memory-fixture.ts` closely enough
 * that a test asserting on the fixture and a browser pointed at
 * `bun run dev:fixture` see the same words.
 *
 * `FIXTURE` is the only key-shaped string allowed anywhere in the suite, and
 * none of these carry one at all — a profile record names its slot, never its
 * value.
 */
import type { ProfileView } from "../src/api/index.ts";
import type { ProfilesState } from "../src/state/state.tsx";

const AT = "2026-09-01T00:00:00.000Z";

function profile(over: Partial<ProfileView> & Pick<ProfileView, "id" | "name" | "provider">) {
  return {
    model: "claude-sonnet-5",
    enabled: true,
    revision: 1,
    credential: { kind: "secret" as const, slug: `profile-${over.id}` },
    ready: true,
    ready_reason: "key-set" as const,
    linked_agents: [],
    is_default: false,
    created_at: AT,
    created_by: "evan",
    updated_at: AT,
    updated_by: "evan",
    ...over,
  } as ProfileView;
}

/**
 * The fleet's default is deliberately **not** the first ready profile.
 *
 * While it was both, "preselect the fleet's default" and "preselect the first
 * ready profile" produced the same id in every test in this suite, so nothing
 * could tell them apart — and §8.3 says they are not the same rule at all: a
 * fleet whose default is missing, disabled or unkeyed must leave the picker
 * empty and require a choice, never fall back to whoever happens to be first.
 * `openrouter-cheap` is first and `anthropic-main` is the default.
 */
export const FIXTURE_PROFILES: ProfileView[] = [
  profile({
    id: "0pr0ut3r",
    name: "openrouter-cheap",
    provider: "openrouter",
    model: "deepseek/deepseek-v4.1-flash",
  }),
  profile({
    id: "an7hr0p1",
    name: "anthropic-main",
    provider: "anthropic",
    model: "claude-sonnet-5",
    is_default: true,
    linked_agents: ["lumen"],
  }),
  profile({
    id: "n0us1ab0",
    name: "nous-lab",
    provider: "nous",
    model: "deepseek/deepseek-v4.1-flash",
    ready: false,
    ready_reason: "key-placeholder",
  }),
  profile({
    id: "b3dr0ck0",
    name: "bedrock-role",
    provider: "bedrock",
    model: "zai.glm-4.7-flash",
    credential: { kind: "role" },
    ready_reason: "role",
    grant: "granted",
  }),
  profile({
    id: "v3rc3l00",
    name: "vercel-gw",
    provider: "vercel",
    model: "deepseek/deepseek-v4.1-flash",
    enabled: false,
    ready: false,
    ready_reason: "disabled",
  }),
];

export function profilesState(over: Partial<ProfilesState> = {}): ProfilesState {
  return {
    list: [],
    defaultProfile: null,
    bedrockModelIds: [],
    error: null,
    loading: false,
    refresh: () => {},
    ...over,
  };
}

/** The fixture fleet: five profiles, `anthropic-main` the default. */
export function fixtureProfilesState(over: Partial<ProfilesState> = {}): ProfilesState {
  return profilesState({ list: FIXTURE_PROFILES, defaultProfile: "an7hr0p1", ...over });
}

/** What `GET /api/provider-profiles` answers with, for a `fakeServer` route. */
export function profilesReply(profiles: ProfileView[] = FIXTURE_PROFILES) {
  return {
    profiles,
    default_profile: profiles.find((p) => p.is_default)?.id ?? null,
    catalog: {},
    bedrock_model_ids: ["zai.glm-4.7-flash"],
  };
}
