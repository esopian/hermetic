/**
 * `defaultRole` (`packages/core/src/chat/hermes/hermes-chat-activity.ts`) picks `status`
 * vs `work` for every activity core mints. `isStatusBlock`'s fallback
 * (`packages/ui/src/chat/components/Activity.tsx`) is a hand-copy of that
 * rule for role-less payloads — older stored blocks, or any head still on
 * the fixture backend (`packages/app/src/backend/fixture-chat.ts`) minted
 * before the field existed. A hand-copy drifts silently, so it is pinned by
 * behaviour here: the same category/key pairs run through both sides,
 * compared. `hermes-chat-turn.ts` also mints two `generation`/`reasoning`
 * snapshots inline (not through `hermesActivity`), which the UI fallback
 * must also call `status` — covered below alongside the `defaultRole` cases.
 *
 * This file is at the root, so it may read both sides (§3.1, `packages/ui`
 * may not import core; root `tests/` is exempt — see `naming-mirror.test.ts`).
 */
import { describe, expect, test } from "bun:test";
import { defaultRole } from "../packages/core/src/chat/hermes/hermes-chat-activity.ts";
import type { ChatBlock } from "../packages/core/src/schema/chat.ts";
import type { ChatBlockOf } from "../packages/ui/src/api/index.ts";
import { isStatusBlock } from "../packages/ui/src/chat/components/Activity.tsx";

// core's activity shape (`payload: unknown`) and the UI's wire-typed view
// (`payload: JSONValue`) are structurally the same block once `payload` is
// left unset, which every case below does — so one literal, typed as the
// UI's view (what `isStatusBlock` actually takes), also satisfies
// `defaultRole`'s category/key inputs.
type CoreCategory = Extract<ChatBlock, { kind: "activity" }>["category"];
type UiActivity = ChatBlockOf<"activity">;

function roleless(category: UiActivity["category"], key: string): UiActivity {
  return {
    kind: "activity",
    category,
    key,
    title: "t",
    state: "running",
  };
}

const CASES: Array<[CoreCategory, string]> = [
  ["connection", "connection"],
  ["queue", "queue"],
  ["history", "history:history"],
  ["usage", "usage"],
  ["generation", "generation"],
  ["generation", "model:aggregation"],
  ["generation", "subagent:x"],
  ["notice", "status:foo"],
  ["notice", "notice"],
  ["notice", "error"],
  ["notice", "risk:call1"],
];

describe("core's defaultRole and the UI's role-less fallback agree", () => {
  test.each(CASES)("category=%s key=%s", (category, key) => {
    const block = roleless(category, key);
    const coreRole = defaultRole(category, key);
    const uiSaysStatus = isStatusBlock(block);
    expect(uiSaysStatus).toBe(coreRole === "status");
  });

  test("hermes-chat-turn.ts's inline reasoning snapshots agree too", () => {
    // Not routed through hermesActivity/defaultRole (minted inline in
    // hermes-chat-turn.ts at the "Thinking…"/"Thinking complete" sites), but
    // both are explicitly role: "status" there, so the fallback must agree.
    expect(isStatusBlock(roleless("generation", "reasoning"))).toBe(true);
  });
});
