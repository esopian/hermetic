/**
 * The shapes a head hands `createHermetic` (`hermetic.ts`): the deps object
 * itself and the four local stores it may carry. They live here rather than
 * beside the assembly because they are the *contract* of the SDK — what
 * `open.ts` fills in and what a test overrides — and the assembly is long
 * enough on its own. Everything here is re-exported from `hermetic.ts`, which
 * remains the door every importer names.
 */
import type {
  AwsProfileInfo,
  FoundationSummary,
  LocalConfig,
  ResolvedIdentity,
  Run,
  RunsListInput,
  TailscaleOauthCheck,
  TailscalePreflight,
  TeardownReceipt,
  TeardownsListInput,
} from "./schema/index.ts";
import type { Backend, DirectoryApi } from "./backend/types.ts";
import type { HermeticdCandidate } from "./release/artifacts.ts";
import type { HermesMirrorFn } from "./release/hermes-mirror.ts";
import type { BrowserMirrorFn } from "./release/browser-mirror.ts";
import type { GitBuildInfo } from "./release/git.ts";
import type { FetchLike } from "./aws/tailscale.ts";
import type { BedrockCatalog } from "./aws/bedrock.ts";
import type { FoundationDeps } from "./fleet/foundation/index.ts";
import type { FixtureChatPacing } from "./backend/fixture/fixture-chat-stack.ts";
import type { NotificationStore } from "./chat/notifications.ts";
import type { LocalChatSessions } from "./chat/chat.ts";
import type { ChatFenceStore } from "./chat/chat-fence.ts";
import type { InstanceListeningStore } from "./chat/instance-listening.ts";
import type { IncarnationStore } from "./local/incarnations.ts";
import type { PresetStore } from "./local/create-presets.ts";

export interface OpOptions {
  signal?: AbortSignal;
  /**
   * The head's id for this operation, when it has one. Core neither creates nor
   * interprets it; `teardown` records it on the receipt so a stored receipt and
   * a live op stream can be recognised as the same run (§4.6).
   */
  opId?: string;
}

/** The local `runs` table (§4.6), backed by `bun:sqlite` in `local/db.ts`. */
export interface RunStore {
  list(input: RunsListInput): Promise<Run[]>;
}

/**
 * The local `teardowns` table (§4.6): one receipt per teardown, written whether
 * it succeeded or failed, and never cleared — `--reset-local` forgets the
 * account, and the receipt is what still says what was left in it.
 */
export interface TeardownStore {
  record(receipt: TeardownReceipt): Promise<void>;
  list(input: TeardownsListInput): Promise<TeardownReceipt[]>;
}

/**
 * The frozen fleet rows (§4.6, §4.8). `init` is the only writer of a row, and
 * everything goes through this interface so no SQLite call appears in the
 * lifecycle path.
 *
 * Everything past `write` is optional because the pre-`init` instance, the
 * fixture wizard and most tests hand in a store that can only freeze — a home
 * that cannot answer "which fleets are here" degrades `fleet ls` to what it
 * already knows, which is the fleet it was opened as.
 */
export interface ConfigStore {
  /**
   * Upsert one frozen fleet row, keyed by `fleet_id` (§4.6). The row's `name`
   * is a cache of the directory's display alias and carries no local
   * uniqueness rule, so there is nothing here a caller has to ask permission
   * to overwrite.
   */
  write(config: LocalConfig): Promise<void>;
  /** `init --reset` archives the run log rather than dropping it (§4.7). */
  archiveRuns?(): Promise<void>;
  /**
   * Forget one fleet's frozen row, by `fleet_id`, returning this home to
   * uninitialized for that fleet — `teardown --reset-local` only, and only
   * after the foundation is gone (§4.6). With no id it forgets every row,
   * which is what it meant when a home could hold only one.
   */
  clear?(fleetId?: string): Promise<void>;
  /** Every fleet frozen here (§4.8), for `fleets.list` and the selection rule. */
  list?(): Promise<LocalConfig[]>;
  read?(fleetId?: string): Promise<LocalConfig | null>;
  /** `prefs.default_fleet`: the `fleet_id` a bare command means on this laptop. */
  defaultFleet?(): Promise<string | null>;
  setDefaultFleet?(fleetId: string | null): Promise<void>;
  /** `prefs.directory_region`, persisted by `init` (§4.8). */
  directoryRegion?(): Promise<string | null>;
  setDirectoryRegion?(region: string): Promise<void>;
}

/**
 * The two pre-`init` reads of §4.7 steps 1–2. They exist behind an interface for
 * the same reason `aws.client()` exists: they are the *only* AWS work done
 * before an account is frozen, and keeping them here means `hermetic.ts` still
 * imports no SDK. `openForInit` wires the real implementation.
 */
export interface InitSupport {
  listProfiles(): Promise<AwsProfileInfo[]>;
  resolveIdentity(profile: string, region: string): Promise<ResolvedIdentity>;
  /**
   * Read-only `DescribeStacks` for the fixed stack name in that profile's
   * account, so the wizard can show "you are about to join fleet X" before the
   * operator types twelve digits at it (§4.7 step 4).
   */
  describeFoundation(profile: string, region: string): Promise<FoundationSummary>;
  /**
   * §4.8: the account's directory, in a region the *request* named. `init
   * --directory-region <r>` arrives as a field of the init call, long after the
   * backend was built — and the directory is the only part of that backend the
   * choice affects, since every other client is in the fleet's own region. So
   * `init` asks for that one API rather than for a whole second backend.
   *
   * `openForInit` wires the real implementation; absent, naming a region the
   * backend was not built for is refused rather than silently ignored.
   */
  directoryFor?(region: string): DirectoryApi;
}

export interface HermeticDeps {
  backend: Backend;
  /** `null` before `init` — every method except `init` then fails NOT_INITIALIZED. */
  config: LocalConfig | null;
  /** Overrides the actor ARN from STS; only tests should pass this. */
  actor?: string;
  runs?: RunStore;
  /** The permanent teardown record (§4.6); absent in tests and fixtures. */
  teardowns?: TeardownStore;
  /**
   * The operator's local inbox (§4.9). Absent — tests, a home that
   * could not be opened — an in-process store stands in, so `notifications.*`
   * always answers and `agents.list` always has somewhere to record what it
   * saw. Losing it costs the inbox, never the fleet.
   */
  notifications?: NotificationStore;
  /**
   * §9.2: which chat sessions *this laptop* started. Local, never the
   * fleet's — see `LocalChatSessions`. Absent means every session reads as
   * foreign, which is the safe default and what a `Hermetic` with no local
   * database gets.
   */
  localSessions?: LocalChatSessions;
  /**
   * The in-flight turn fence (`chat-fence.ts`). Local, and local for a reason
   * beyond the usual one: its whole job is to be visible to the *other* local
   * process, so that the portal's roster poll defers for a turn the CLI is
   * taking. Absent means an in-process fence, which still covers a portal
   * polling while it streams its own turn.
   */
  chatFence?: ChatFenceStore;
  instanceListening?: InstanceListeningStore;
  /**
   * Which incarnation of each agent name this laptop's local state describes
   * (`local/incarnations.ts`, §6.7). Local, beside the tables it guards. Absent
   * means an in-process record, which reconciles within one process's life.
   */
  incarnations?: IncarnationStore;
  /**
   * §4.6's create presets: one `prefs` row on this laptop. Absent — tests, a
   * home-less instance — an in-process store stands in, which reads as the
   * built-ins until something is set.
   */
  presets?: PresetStore;
  /** hermeticd version this build ships, pushed to S3 by `init`/`upgrade`. */
  hermeticdVersion?: string | undefined;
  /** Hermes version pinned into a fresh render. */
  hermesVersion?: string;
  /** Where `init` freezes the local config; absent in tests and fixtures. */
  configStore?: ConfigStore;
  /** Profile enumeration and identity resolution for the interactive init flow. */
  initSupport?: InitSupport;
  /**
   * The §4.7 Tailscale preflight, overridable so tests and the fixture backend
   * never spawn a binary or reach api.tailscale.com. They default to the real
   * probes rather than to "skip": an absent dependency must not silently
   * disable the gate that keeps `init --create` from building an unreachable
   * fleet.
   */
  localTailscale?: () => Promise<TailscalePreflight>;
  verifyTailscaleOauth?: (secret: string) => Promise<TailscaleOauthCheck>;
  /**
   * §3.6's Hermes source mirror, overridable for the same reason the two probes
   * above are: the real one spawns `git` and reaches github.com, which no test
   * and no fixture may do. It defaults to the real mirror rather than to
   * "skip" — an absent dependency must not be able to quietly stop a fleet's
   * bundles being refreshed, leaving every box back on the direct clone.
   */
  hermesMirror?: HermesMirrorFn;
  /** §7.3's browser mirror: the real one downloads ~190 MB from a CDN. */
  browserMirror?: BrowserMirrorFn;
  /**
   * Where the bare Hermes mirror is kept between pushes. `open.ts` puts it
   * beside the local database (`$HERMETIC_HOME/mirror`); absent, that is what it
   * works out for itself.
   */
  mirrorDir?: string;
  /**
   * How often the unbounded data-volume attach polls, and how often it says so
   * (`attach.ts`), and how long `destroy` and `recreate` wait for the agent's
   * tailnet devices to read offline (`TAILNET_OFFLINE_WAIT_MS`). Tests shrink all three; nothing else
   * sets them.
   */
  attach?: { pollMs?: number; progressMs?: number; tailnetOfflineMs?: number };
  /**
   * `agents.probe`'s laptop-side HTTP client and per-layer timeout (§9). The
   * `fetch` exists for the same reason the Tailscale preflight's probes are
   * injectable: fixture mode must not open a socket, and a test must not wait
   * five seconds to prove a layer times out. Absent, the probe uses the
   * platform `fetch` — the honest default, since the dashboard layer's whole
   * job is to say whether *this machine* can reach the agent.
   */
  probe?: { fetch?: FetchLike; timeoutMs?: number };
  /**
   * §8.3's model discovery transport. Injectable for the reason every other
   * probe here is: no test and no fixture may open a socket, and fixture mode
   * may not construct an AWS client — so `bedrock` is handed in there rather
   * than taken from the backend.
   */
  modelCatalog?: {
    fetch?: FetchLike;
    timeoutMs?: number;
    bedrock?: (signal?: AbortSignal) => Promise<BedrockCatalog>;
  };
  /**
   * The bounded watch `create` runs after handoff (`handoff.ts`). Defaults to
   * off — a zero budget — because a backend with no real box to wait for would
   * only ever spend the whole window. `open.ts` turns it on for real mode.
   */
  handoff?: { budgetMs?: number; pollMs?: number };
  /**
   * How long §6.5's converge waits for a box to report the config it was asked
   * for, and how often it looks. Injected so a test does not spend real minutes;
   * the defaults (`rollout.ts`) are what a real fleet gets.
   */
  rollout?: { convergeTimeoutMs?: number; convergePollMs?: number };
  /**
   * Path of the compiled `hermeticd` this build ships, so `init` and `upgrade`
   * can push it (§3.6). Absent, `resolveHermeticd` is asked instead.
   */
  hermeticdPath?: string | undefined;
  /**
   * Finds the binary when no path was given: env, the sibling of the running
   * executable, or a source build (`artifacts.ts`). `open.ts` wires the real
   * one in real mode; absent on a real backend means pushes refuse.
   */
  resolveHermeticd?: () => Promise<HermeticdCandidate | null>;
  /**
   * Which build of `hermeticd` this process would push, answered without
   * building one (`artifacts.ts`'s `localBuild`). `create` and `rerun` compare
   * it against the build the fleet's release was pushed from, so a checkout
   * whose hermeticd has moved on from the fleet's says so before a box fails a
   * stage rather than after.
   *
   * Absent ⇒ `null` ⇒ no comparison and no warning: fixture mode and tests
   * never walk the real repository unless they ask to.
   */
  localBuild?: () => string | null;
  /**
   * Which commit this checkout is on, and whether it is clean (`git.ts`).
   *
   * Absent means the real reader, for the reason §4.7's preflight gives: a gate
   * an absent dependency can switch off is not a gate. It is overridable so a
   * test can say what the machine looks like — and `testHermetic` says "no
   * checkout", because the real reader walks *this* repository and a suite that
   * failed whenever its author had unsaved work would be intolerable.
   */
  git?: (() => GitBuildInfo | null) | undefined;
  /**
   * Publish from a dirty tree anyway (`HERMETIC_ALLOW_DIRTY=1`). Threaded rather
   * than read here so a head can decide, and so a test can exercise both sides.
   */
  allowDirty?: boolean;
  /**
   * `true` only for the in-memory backend. It defaults to **false**, and
   * everything that reads it must default the same way: a caller that forgets
   * the flag has to get the real behaviour — refusing to invent placeholder
   * bytes — because the failure in the other direction is a stand-in binary
   * under a real fleet manifest, which boots nothing and looks published.
   */
  fixture?: boolean;
  /**
   * Pacing for the fixture chat adapter — frame delay and the frame to cut the
   * socket after. Read only when `fixture` is true; `open.ts` fills it from
   * `OpenOptions.fixtureOptions`.
   */
  fixtureChat?: FixtureChatPacing;
  /**
   * How often `teardown` emits a "still deleting" event while it waits for
   * CloudFormation. Only tests shorten it; the real wait is minutes long.
   */
  stackWaitProgressMs?: number;
  /**
   * The deployment-shaped half of `foundation.update` (§6.6): where the local
   * recovery archive goes, how to copy the database into it, and how long the
   * rollout waits. `open.ts` fills it in for real mode; fixtures and tests leave
   * it out, which is what makes the local archive skipped and the wait zero.
   */
  foundation?: Pick<
    FoundationDeps,
    | "archiveDir"
    | "archiveLocalDb"
    | "localDb"
    | "rolloutWaitMs"
    | "rolloutPollMs"
    | "changeSetPollMs"
    | "changeSetTimeoutMs"
    | "heartbeatMs"
    // The advisory upstream-Hermes check's way out to GitHub (§6.6). Real by
    // default (rule 6); fixtures and tests hand in one that reaches nothing.
    | "hermesFetch"
    // Which build this checkout would push, for `plan.foundation`'s release
    // comparison. Overridable so a test can be two different checkouts without
    // compiling anything; the default is the real `localBuild` wired below.
    | "localBuild"
  >;
}

export interface UpgradeTarget {
  name: string;
  hermes_version: string;
  hermeticd_version: string | null;
}
