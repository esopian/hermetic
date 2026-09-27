/**
 * `@hermetic/core` — the SDK. If it isn't in here, it doesn't exist (§1).
 * The CLI and the server are thin heads over this surface; `packages/ui` never
 * imports it, and `packages/agentd` may import only `@hermetic/core/schema`.
 */
export * from "./version.ts";
export * from "./schema/index.ts";
export * from "./errors.ts";
export * from "./shared/naming.ts";
/** `isFleetId`: the shape a `fleet_id` has (§4.6). Heads use it to tell an id from an alias. */
export { isFleetId } from "./fleet/fleet-id.ts";
export * from "./agents/state.ts";
export * from "./render/render.ts";
export * from "./render/cloud-init.ts";
export * from "./release/tar.ts";
export * from "./backend/types.ts";
export * from "./backend/constants.ts";
export * from "./backend/memory.ts";
export * from "./hermetic.ts";
/**
 * The shape `settings.get`/`settings.set` answer with. The
 * module's own `createSettings` is `hermetic.ts`'s business; the heads only
 * need to be able to name what comes back.
 */
export type { SettingsResult } from "./profiles/settings.ts";
/**
 * §8.3's provider profiles. The result shapes are exported for the heads that
 * render them; the deps object and the surface itself stay behind `hermetic.ts`
 * like every other module of this shape.
 */
export type {
  BedrockGrant,
  ProfileView,
  ProvidersDeleteResult,
  ProvidersListResult,
  ProvidersWriteResult,
  ReadyReason,
} from "./profiles/provider-profiles.ts";
export {
  bedrockBaseModelId,
  designatedProfile,
  profilesOf,
  resolveProfile,
} from "./profiles/provider-profiles.ts";
export { MODEL_CATALOG_TIMEOUT_MS } from "./profiles/model-catalog.ts";
export { derivedProfileId, withProviderProfiles } from "./profiles/profile-migrate.ts";
/**
 * What a create inherits from the fleet, exported because the CLI asks it the
 * same question before core does: whether to prompt for a provider key depends
 * on whether the fleet already holds one, and there must not be a second
 * implementation of that rule (§8.1).
 */
export * from "./render/create-defaults.ts";
/** The unbounded data-volume attach wait shared by `create` and `recreate`. */
export * from "./agents/attach.ts";
/** The §9 active liveness check, and the pure verdict its report carries. */
export * from "./agents/probe.ts";
/** §7.4: the Serve URL and session token Hermes Desktop attaches with. */
export type { DesktopAttach, DesktopDeps, DesktopOptions } from "./agents/desktop.ts";
/**
 * §4.6's create presets: the store contract and its in-process fallback, and
 * the rule `agent create --preset` resolves by — exported so the CLI resolves
 * a preset with core's rule rather than a second copy of it.
 */
export {
  MemoryPresetStore,
  resolveCreatePreset,
} from "./local/create-presets.ts";
export type {
  CreateMachineFlags,
  PresetStore,
  ResolvedCreatePreset,
} from "./local/create-presets.ts";
export * from "./open.ts";
export { fixtureOptionsFromEnv } from "./backend/fixture/options-env.ts";
/**
 * §4.8: which fleet a command is about. Exported because the heads run the same
 * rule — the CLI to report `FLEET_REQUIRED` before it opens anything, the
 * portal to decide what its switcher may switch to — and there must not be a
 * second implementation of it.
 */
export * from "./fleet/fleet-select.ts";
/**
 * §6.6: the version-skew comparison, exported for the same reason — the CLI
 * renders it on stderr and the portal renders it as a band, and a second
 * implementation of "is this fleet behind this build" is exactly how the two
 * heads would come to disagree about it.
 */
export * from "./fleet/skew.ts";
/** The §4.8 fleet surface's own deps shape, for a head that wires its own. */
export type { FleetsDeps } from "./fleet/fleets.ts";
/**
 * §4.9: the operator's inbox. The store contract and the
 * in-process fallback are exported because a head opens the store — the CLI and
 * the portal each open the local database themselves — and because the fixture
 * seed writes rows into one. The three methods themselves stay behind
 * `hermetic.ts`, like every other module of this shape.
 */
export type {
  NotificationDeps,
  NotificationInsert,
  NotificationStore,
  SettledOp,
  SettledRun,
} from "./chat/notifications.ts";
export {
  MemoryNotificationStore,
  NOTIFICATION_RETENTION_DAYS,
  formatElapsedMs,
  mintNotificationId,
  notifyOpSettled,
  opVerb,
} from "./chat/notifications.ts";
/**
 * §9.2: the chat surface's result shapes and its deps object. The five
 * methods themselves stay behind `hermetic.ts`, like every other module of this
 * shape — what the heads need is to be able to name what comes back, and a head
 * wiring its own (a test double, the fixture backend) needs the deps type.
 */
export type {
  ChatAbortResult,
  ChatDeps,
  ChatHistoryResult,
  ChatOptions,
  ChatSessionsResult,
  ChatSwarmsResult,
} from "./chat/chat.ts";
/**
 * Bot Mode's shared request sockets (`hermes-chat-pool.ts`), as the one thing a
 * head has to do about them: end them.
 *
 * Pooling is core's business and no head configures it. What a head owns is the
 * process — the CLI's is one command long and the portal's ends on a signal —
 * and an idle socket that outlives the work is a head-shaped problem, so the
 * release is head-shaped too. Idempotent, and safe on a build that never opened
 * one (fixture mode never does).
 */
export { disposeChatRequestPools } from "./chat/hermes/hermes-chat.ts";
/**
 * The secret masker (§8.3), so a head can close the same door on text it is
 * about to write to its own log.
 *
 * Core applies this to everything leaving it, which is why nothing else here
 * needs it. `packages/app` does: the portal log is a file on the laptop, and
 * an `error` event's message reaches it without passing through a response.
 * Exported rather than restated, because a second copy of the pattern set is a
 * copy that goes stale silently — the whole argument `chat-redact.ts` opens
 * with.
 */
export { redactText } from "./chat/chat-redact.ts";
/**
 * The size of one observation's read, which is also the size of its
 * deduplication window.
 *
 * Exported for the same reason the masker above is: `packages/app` holds an
 * observation across the tabs that read it and folds each incremental message
 * into the read it replays to the next joiner (`chat-owner.ts`). That folded
 * read has to be bounded the way core's own is, and a second copy of the number
 * is a copy that goes stale silently.
 */
export { OBSERVE_WINDOW } from "./chat/chat-observe.ts";
/**
 * One `chat.observe` per conversation, shared by every reader of it
 * (`observe-pool.ts`): the refcounted, pinned-or-guest multiplexing policy a
 * head with many readers of one conversation needs — the portal's tabs, a CLI
 * tailing two bots. Lifetime stays with the head (`packages/app`'s
 * `chat-owner.ts` decides what is pinned and when the pool stops); the pool
 * executes. Internal machinery, not a public method: it wraps `chat.observe`
 * rather than adding to the surface.
 */
export {
  OBSERVE_POOL_MAX_REMEMBERED_FAILURES,
  createObservePool,
  keyOf,
  refOf,
  type ChatConversationRef,
  type ChatObserveTarget,
  type ObservePool,
  type ObservePoolDeps,
  type ObservePoolEntry,
  type ObservePoolFailure,
  type ObservePoolLogLevel,
  type PooledChatEvent,
} from "./chat/observe-pool.ts";
/**
 * The canned swarm `bun run dev:fixture` chats with, and the
 * tables it answers from.
 *
 * The client itself is exported because a head's tests wire their own `Hermetic`
 * — `openHermetic({ fixture: true })` builds one, but a server test that wants a
 * paced stream, or one that wants an instant one, has to be able to say so. The
 * tables are exported for the reason `FIXTURE_NOTIFICATION_IDS` is: an assertion
 * about what the portal draws should name the fixture row it is drawing rather
 * than re-transcribe it, because a re-transcription is a second copy that goes
 * stale silently.
 */
export {
  FIXTURE_CHAT_FAILURES,
  FIXTURE_CHAT_INSTANCES,
  FIXTURE_CHAT_REPLY,
  FIXTURE_CHAT_SESSIONS,
  FIXTURE_CHAT_TRANSCRIPTS,
  createFixtureChatActivity,
  fixtureChatClient,
  fixtureChatReachable,
  fixtureSessionToken,
} from "./backend/fixture/fixture-chat.ts";
export type { FixtureChatActivity, FixtureChatOptions } from "./backend/fixture/fixture-chat.ts";
/**
 * Fixture mode's staging surface (§9.2), and the factory that wires
 * the whole fixture chat stack around one activity store.
 *
 * `hermetic.fixture` is where a head reaches it; these are exported so a test
 * can build the same stack without an `openHermetic`, and so a head's request
 * in `MACHINERY_RPC` can name the type it is holding. Neither of them can be
 * constructed against a real account: `createFixtureChatStack(false)` returns
 * a stack of nulls, and `createFixtureControls` refuses without `fixture: true`.
 */
export { createFixtureChatStack } from "./backend/fixture/fixture-chat-stack.ts";
export type { FixtureChatStack } from "./backend/fixture/fixture-chat-stack.ts";
export { createFixtureControls } from "./backend/fixture/fixture-controls.ts";
export type { FixtureControls, FixtureControlsDeps } from "./backend/fixture/fixture-controls.ts";
/**
 * The local database, including the fleet-aware `fleets` table (§4.8):
 * `openLocalDb`, `listConfigs`, `defaultFleet`/`setDefaultFleet`,
 * `directoryRegion`/`setDirectoryRegion`. Exported whole because a head's tests
 * have to be able to put a temp home into a particular state — a home with two
 * fleets and no default, say, which is the state the `FLEET_REQUIRED` refusal
 * and the portal's fleet picker both exist for.
 */
export * from "./local/db/index.ts";
/**
 * Which interrupted operations a boot hands back to the operator rather than
 * replaying, and what it tells them (§4.6). Both heads say it, so the sentence
 * lives here.
 */
export * from "./local/recovery.ts";
export * from "./local/profiles.ts";
/** The §4.7 Tailscale preflight: the local daemon probe and the OAuth check. */
export * from "./fleet/preflight.ts";
/** Where the compiled `hermeticd` comes from (§3.6): env, sibling binary, or a source build. */
export * from "./release/artifacts.ts";
/**
 * The AWS half. `aws/index.ts` re-exports every client wrapper plus the
 * foundation template, so a head can render `acl_snippet()` after `init --create`
 * without reaching into core's file tree.
 */
export * from "./aws/index.ts";
/**
 * The tailnet policy: the three entries the fleet needs, the managed blocks
 * hermetic writes through the Tailscale API, and the paste-ready snippet that
 * is still the fallback when the OAuth client cannot reach the policy file.
 */
export * from "./fleet/policy.ts";
export { aclSnippet as acl_snippet, aclSnippetParts as acl_snippet_parts } from "./fleet/policy.ts";
