/**
 * Fixture mode's chat stack, assembled (§9.2).
 *
 * Three pieces that only work together, and used to be wired in three places:
 *
 * - `fixtureChatClient` — the canned swarm, transcripts and turn.
 * - `withFixtureBotMode` — the stateful half: conversations this process
 *   created, profiles it edited, transcripts it wrote.
 * - `createFixtureControls` — the staging surface, `hermetic.fixture`.
 *
 * What ties them is one `FixtureChatActivity`: the table an externally
 * originated message is appended to. The client reads it in `history`, the Bot
 * Mode wrapper merges it into the conversations it owns, the client's `observe`
 * announces writes to it, and the control surface is the only thing that
 * writes. Handing the same store to all three is the whole of the wiring, and
 * getting it wrong is undetectable at the type level — an absent store leaves
 * `observe` inert and every arrival invisible, which is precisely the defect
 * this module exists to make unrepeatable. It shipped that way once.
 *
 * `createHermetic` therefore asks for a stack rather than building one, and
 * gets `{ hermes: null, controls: null }` in every other mode — which is also
 * the guard: a real-mode `Hermetic` has nothing on `.fixture` to call.
 */
import type { HermesChatClient } from "../../chat/hermes/hermes-chat.ts";
import { withFixtureBotMode } from "./fixture-bot-mode.ts";
import {
  createFixtureChatActivity,
  fixtureChatClient,
  type FixtureChatOptions,
} from "./fixture-chat.ts";
import type { FixtureControls } from "./fixture-controls.ts";
import { createFixtureControls } from "./fixture-controls.ts";

export interface FixtureChatStack {
  /** The chat adapter, or null when this is not fixture mode. */
  hermes: HermesChatClient | null;
  /** `hermetic.fixture`, or null when this is not fixture mode. */
  controls: FixtureControls | null;
}

/** The pacing knobs a head may set on the fixture adapter (`OpenOptions.fixtureOptions`). */
export type FixtureChatPacing = Pick<FixtureChatOptions, "delayMs" | "cutAfter">;

export function createFixtureChatStack(
  fixture: boolean,
  pacing: FixtureChatPacing = {},
): FixtureChatStack {
  if (!fixture) return { hermes: null, controls: null };
  const activity = createFixtureChatActivity();
  return {
    hermes: withFixtureBotMode(fixtureChatClient({ activity, ...pacing }), { activity }),
    controls: createFixtureControls({ fixture: true, activity }),
  };
}
