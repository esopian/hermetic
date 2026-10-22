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
import { withFixtureDevtap } from "./fixture-devtap.ts";
import {
  createFixtureKanbanStore,
  withFixtureKanban,
  type FixtureKanbanStore,
} from "./fixture-kanban.ts";
import type { TapSource } from "../../chat/devtap.ts";

export interface FixtureChatStack {
  /** The chat adapter, or null when this is not fixture mode. */
  hermes: HermesChatClient | null;
  /** `hermetic.fixture`, or null when this is not fixture mode. */
  controls: FixtureControls | null;
  /** The boxes' kanban boards; the same store the chat client's `opts.kanban` holds. */
  kanban: FixtureKanbanStore | null;
}

/** The pacing knobs a head may set on the fixture adapter (`OpenOptions.fixtureOptions`). */
export type FixtureChatPacing = Pick<FixtureChatOptions, "delayMs" | "cutAfter">;

/** What the stack takes from the fixture backend, beside the pacing. */
export type FixtureChatBackend = Pick<FixtureChatOptions, "files"> & {
  /** The developer tools' capture; the fixture's frames get synthetic wire beneath them. */
  devtap?: TapSource | undefined;
};

export function createFixtureChatStack(
  fixture: boolean,
  pacing: FixtureChatPacing = {},
  backend: FixtureChatBackend = {},
): FixtureChatStack {
  if (!fixture) return { hermes: null, controls: null, kanban: null };
  const activity = createFixtureChatActivity();
  const { devtap, ...files } = backend;
  const kanban = createFixtureKanbanStore();
  const client = withFixtureKanban(
    withFixtureBotMode(fixtureChatClient({ activity, kanban, ...pacing, ...files }), { activity }),
    kanban,
  );
  return {
    hermes: devtap === undefined ? client : withFixtureDevtap(client, devtap),
    controls: createFixtureControls({ fixture: true, activity }),
    kanban,
  };
}
