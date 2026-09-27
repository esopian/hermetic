/**
 * Update notices: find out a newer release exists, and send the operator to it.
 *
 * This module never installs anything. Electrobun's updater can download a
 * release and swap it in under the running process, but in the devkit this
 * app builds against it verifies nothing beyond TLS: the manifest's `hash` is a
 * short cache key (`SAFE_HASH_PATTERN` in the devkit's `core/Updater.ts`), not a
 * digest or a signature over the bits. Applying what it fetched would mean
 * whoever can publish a release on the repository — or tamper with the asset
 * store behind it — can replace the binary on every installed copy, silently.
 * So the check stays (it reads one small JSON document and nothing else) and
 * everything after it is the operator's browser: "an update is available", and
 * a dialog whose one affirmative opens the release page, where the DMG is
 * downloaded and installed the way the first one was.
 *
 * Re-enabling in-place updates needs signed releases first: a detached
 * signature over each artifact (minisign, with the public key compiled into
 * the app) verified before anything is applied. `UpdaterLike` deliberately has
 * no `downloadUpdate` or `applyUpdate`, and `main/index.ts` hands this module
 * only `checkForUpdate`, so that change cannot be made here by accident;
 * `test/main/updates.test.ts` scans the package source for either call.
 *
 * `Updater` is injected as a structural type rather than imported: importing
 * `electrobun/bun` throws outside a built app, and this module has to be
 * loadable in a test with no devkit.
 */
import type { AppLog } from "../log.ts";
import type { OpSummary } from "../ops.ts";
import type { WebviewMessages } from "../rpc/schema.ts";

/** Six hours. Long enough that a laptop left open does not poll a release server raw. */
export const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Where an operator goes to get a new build. The same repository as
 * `release.baseUrl` in `electrobun.config.ts` (the suite holds the two
 * together), and a constant rather than built from the manifest's version: the
 * manifest is the untrusted half of the check, and nothing it says should
 * become a URL this process opens.
 */
export const RELEASES_URL = "https://github.com/esopian/hermetic/releases/latest";

/**
 * What the footer is told. A small closed set rather than free text, because
 * the page switches on it:
 *
 * - `none` — checked, nothing newer. Also what a skipped or dev-channel tick
 *   leaves standing, since neither of those learns anything.
 * - `available` — a newer release exists; the release page is where it is.
 * - `error` — the check failed. The app keeps running on the version it has.
 */
export const UPDATE_STATUSES = ["none", "available", "error"] as const;
export type UpdateStatus = (typeof UPDATE_STATUSES)[number];

/**
 * As much of Electrobun's `Updater` as this module uses — and all of it this
 * module is allowed to use. See the header for why there is no download or
 * apply here.
 */
export interface UpdaterLike {
  /** This bundle's channel and version, read once at startup (`version.json`). */
  localInfo: { channel(): string; version(): string };
  /**
   * The devkit reports a failed fetch in `error` rather than by throwing; a
   * non-empty one is treated exactly like a throw.
   */
  checkForUpdate(): Promise<{ updateAvailable: boolean; version?: string; error?: string }>;
}

/** As much of the op registry as the updater reads. */
export interface RunningOps {
  list(options: { status: "running" }): { ops: OpSummary[] };
}

/** Starts a repeating timer and hands back the way to stop it. Injected for the fake clock. */
export type SetTimer = (fn: () => void, ms: number) => () => void;

export interface UpdaterOptions {
  updater: UpdaterLike;
  ops: RunningOps;
  /** Native modal; true means open the release page. */
  prompt(message: string): Promise<boolean>;
  /** `Utils.openExternal`, behind the same allow-list the page's links use. */
  openExternal(url: string): void;
  /** Pushes `app.update` at every open window (`WindowSet.broadcast`). */
  broadcast(name: "app.update", payload: WebviewMessages["app.update"]): void;
  log?: AppLog;
  /** Injected so a test can drive the 6 h tick without waiting 6 h. */
  setTimer?: SetTimer;
}

export interface CheckOptions {
  /**
   * The operator asked ("Check for Updates…" in the menu, or
   * `app.checkForUpdate`): ask about a release even if this session already
   * asked about it once, and even with an op running.
   */
  interactive?: boolean;
}

export interface UpdateChecker {
  /** One check, now. Returns when the flow settles (or immediately if one is in flight). */
  check(options?: CheckOptions): Promise<void>;
  /** Checks once and arms the repeat. */
  start(): void;
  /** Disarms the repeat. Does not abort a check already running. */
  stop(): void;
}

/** What the box says. Exported so the test asserts the operator's wording once. */
export function updatePrompt(version: string | undefined): string {
  const which = version === undefined ? "A newer version of Hermetic" : `Hermetic ${version}`;
  return `${which} is available. Open the release page to download it?`;
}

/** `MAJOR.MINOR.PATCH`, optionally `-prerelease`; build metadata is not compared. */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Whether `offered` is strictly newer than `installed`, by semver.
 *
 * The devkit's `updateAvailable` means only "the manifest's hash differs from
 * mine", which an older or re-published build satisfies just as well as a
 * newer one — and the dialog would then send the operator to install a
 * downgrade. Anything that does not parse as a version reads as "not newer":
 * a notice that fails to appear is the safe direction.
 */
export function isNewerVersion(offered: string | undefined, installed: string): boolean {
  if (offered === undefined || !SEMVER.test(offered) || !SEMVER.test(installed)) return false;
  return Bun.semver.order(offered, installed) === 1;
}

const defaultSetTimer: SetTimer = (fn, ms) => {
  const handle = setInterval(fn, ms);
  return () => clearInterval(handle);
};

export function createUpdater(options: UpdaterOptions): UpdateChecker {
  const setTimer = options.setTimer ?? defaultSetTimer;
  let cancelTimer: (() => void) | null = null;
  /** One check at a time: a manual "Check for Updates…" during the 6 h tick is a no-op. */
  let checking = false;
  /**
   * The last error already written to the log.
   *
   * A release server that is down is down for hours, and a line every six
   * hours forever turns `app.log` into a record of one outage. Logging only
   * when the *message changes* keeps the first occurrence and every genuinely
   * new failure, and drops the repeats.
   *
   * Cleared by a check that completes: the memo suppresses a *repeat*, not a
   * recurrence. Without the reset, an outage, a recovery, then the same outage
   * next week would be a silent second outage — the one the operator most needs
   * the file to have recorded.
   */
  let lastLoggedError: string | null = null;
  /**
   * The version this session already asked about, whatever the answer.
   *
   * Only meaningful for this run of the process: a relaunch asks again. Without
   * it, every six hours puts the same box back over whatever the operator is
   * doing. An interactive check ignores it — the operator asked.
   */
  let askedVersion: string | null = null;

  const broadcast = (status: UpdateStatus, version?: string): void => {
    options.broadcast("app.update", version === undefined ? { status } : { status, version });
  };

  const fail = (e: unknown): void => {
    const message = e instanceof Error ? e.message : String(e);
    if (message !== lastLoggedError) {
      lastLoggedError = message;
      options.log?.line("warn", "update", `update check failed: ${message}`);
    }
    broadcast("error");
  };

  const run = async (interactive: boolean): Promise<void> => {
    /**
     * Electrobun's own rule: a dev build has no release channel to compare
     * itself against, so `checkForUpdate` has nothing meaningful to answer.
     * The guard is before the call, not after it, so a dev run never touches
     * the network at all.
     */
    if (options.updater.localInfo.channel() === "dev") return;

    /**
     * Not over an op in flight. Nothing here can end the process any more,
     * but a modal raised over a CloudFormation build the operator is watching
     * is still an interruption they did not ask for. Silent: the next tick
     * picks it up once the fleet is idle. An interactive check is the operator
     * asking, so it goes ahead.
     */
    if (!interactive && options.ops.list({ status: "running" }).ops.length > 0) return;

    const result = await options.updater.checkForUpdate();
    if (result.error !== undefined && result.error !== "") throw new Error(result.error);
    // The server answered, so whatever was failing is over. Reset here rather
    // than at the end of `check`, because a dev-channel or mid-op return never
    // reached the server and so learned nothing about the outage.
    lastLoggedError = null;
    if (
      !result.updateAvailable ||
      !isNewerVersion(result.version, options.updater.localInfo.version())
    ) {
      broadcast("none");
      return;
    }

    broadcast("available", result.version);

    /**
     * Keyed by version so a *newer* build still gets asked about. `unknown`
     * stands in when the updater reports no version, which collapses two
     * anonymous builds into one — the conservative direction, since the
     * alternative is nagging.
     */
    const version = result.version ?? "unknown";
    if (!interactive && version === askedVersion) return;
    askedVersion = version;

    const open = await options.prompt(updatePrompt(result.version));
    options.log?.line("info", "update", open ? "opening the release page" : "update deferred", {
      version,
    });
    if (open) options.openExternal(RELEASES_URL);
  };

  const check = async (checkOptions: CheckOptions = {}): Promise<void> => {
    if (checking) return;
    checking = true;
    try {
      await run(checkOptions.interactive === true);
    } catch (e: unknown) {
      fail(e);
    } finally {
      checking = false;
    }
  };

  return {
    check,
    start() {
      // Once at launch — an app opened after a week away should not wait six
      // hours to notice — then on the interval.
      void check();
      cancelTimer?.();
      cancelTimer = setTimer(() => void check(), UPDATE_INTERVAL_MS);
    },
    stop() {
      cancelTimer?.();
      cancelTimer = null;
    },
  };
}
