/**
 * Updates: find out a newer release exists, fetch it, prove it is ours, and
 * install it when the operator says so.
 *
 * Electrobun's updater does the fetching and the installing
 * (`downloadUpdate`, then `applyUpdate`, which hands the new bundle to a native
 * helper and relaunches). What it does not do is check what it fetched beyond
 * TLS: the manifest's `hash` is a short cache key, not a digest or signature.
 * So nothing is installed until `verify` (`main/update-verify.ts`) has checked
 * the downloaded tar against the release key's Ed25519 signature
 * (`@hermetic/core`'s `app-update-signature.ts`, signed in the release
 * workflow by `scripts/sign-update.ts`). It is checked twice: once after the
 * download, and again immediately before `applyUpdate`, because the operator
 * may say "Later" and restart hours afterwards.
 *
 * Any failure on the way — the download, a missing or bad signature, a build
 * that is not newer — discards the download and falls back to the manual path:
 * "an update is available" and a dialog whose one affirmative opens the
 * release page. A release that cannot be verified is never installed.
 *
 * `Updater` is injected as a structural type rather than imported: importing
 * `electrobun/bun` throws outside a built app, and this module has to be
 * loadable in a test with no devkit.
 */
import type { AppLog } from "../log.ts";
import type { OpSummary } from "../ops.ts";
import type { WebviewMessages } from "../rpc/schema.ts";
import type { VerifyResult } from "./update-verify.ts";

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
 * Where the latest release's assets are — `release.baseUrl` exactly — and so
 * where an update's signature is fetched from. A constant for the same reason.
 */
export const RELEASE_ASSETS_URL = `${RELEASES_URL}/download`;

/**
 * What the footer is told. A small closed set rather than free text, because
 * the page switches on it:
 *
 * - `none` — checked, nothing newer. Also what a skipped or dev-channel tick
 *   leaves standing, since neither of those learns anything.
 * - `downloading` — a newer release exists and is being fetched and verified.
 * - `ready` — downloaded and verified; a restart installs it.
 * - `available` — a newer release exists but could not be installed here (the
 *   download or its signature failed); the release page is where it is.
 * - `error` — the check failed. The app keeps running on the version it has.
 */
export const UPDATE_STATUSES = ["none", "downloading", "ready", "available", "error"] as const;
export type UpdateStatus = (typeof UPDATE_STATUSES)[number];

/** As much of Electrobun's `Updater` as this module uses. */
export interface UpdaterLike {
  /** This bundle's channel and version, read once at startup (`version.json`). */
  localInfo: { channel(): string; version(): string };
  /**
   * The devkit reports a failed fetch in `error` rather than by throwing; a
   * non-empty one is treated exactly like a throw.
   */
  checkForUpdate(): Promise<{ updateAvailable: boolean; version?: string; error?: string }>;
  /** Fetches and prepares the checked update. Failure lands in `updateInfo().error`, not a throw. */
  downloadUpdate(): Promise<void>;
  updateInfo(): { updateReady: boolean; error: string };
  /** Hands the prepared update to the native helper and quits. Only ever called right after `verify`. */
  applyUpdate(): Promise<void>;
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
  /** Checks the prepared download's signature, discarding it on failure (`main/update-verify.ts`). */
  verify(): Promise<VerifyResult>;
  /** Native modal; true means open the release page. */
  prompt(message: string): Promise<boolean>;
  /** Native modal; true means restart now and install the verified update. */
  confirmRestart(message: string): Promise<boolean>;
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
  /**
   * Installs the verified update and restarts: Settings' "Restart to update".
   * False when there is nothing verified to install, or a check is in flight.
   */
  install(): Promise<boolean>;
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

/** The restart box, once a download has verified. */
export function restartPrompt(version: string): string {
  return `Hermetic ${version} is downloaded and verified. Restart now to install it?`;
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
  /** The version downloaded and verified this session, waiting for a restart. */
  let readyVersion: string | null = null;
  /** The version whose download or signature failed this session. */
  let refusedVersion: string | null = null;

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

    // Keyed by version so a *newer* build is still fetched and asked about.
    // `isNewerVersion` refuses an undefined version, so the fallback is never used.
    const version = result.version ?? "unknown";
    if (readyVersion !== version) {
      // A version that failed once this session is not fetched again on the
      // timer — every six hours would be another full download that fails the
      // same way. The operator asking is worth another try.
      if (!interactive && version === refusedVersion) {
        await offerReleasePage(version, interactive);
        return;
      }
      readyVersion = null;
      broadcast("downloading", version);
      if (!(await prepare())) {
        refusedVersion = version;
        await offerReleasePage(version, interactive);
        return;
      }
      readyVersion = version;
    }
    broadcast("ready", version);

    // Asked once per version per session; an interactive check asks again.
    if (!interactive && version === askedVersion) return;
    askedVersion = version;
    const restart = await options.confirmRestart(restartPrompt(version));
    options.log?.line("info", "update", restart ? "restarting to install" : "install deferred", {
      version,
    });
    if (restart) await installVerified();
  };

  /** Download, then verify. False, with the reason logged, for any failure. */
  const prepare = async (): Promise<boolean> => {
    try {
      await options.updater.downloadUpdate();
    } catch (e: unknown) {
      options.log?.line(
        "warn",
        "update",
        `download failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return false;
    }
    const info = options.updater.updateInfo();
    if (!info.updateReady) {
      options.log?.line("warn", "update", `download failed: ${info.error || "not prepared"}`);
      return false;
    }
    return await verified();
  };

  const verified = async (): Promise<boolean> => {
    const result = await options.verify();
    if (!result.ok) options.log?.line("warn", "update", `update refused: ${result.reason}`);
    return result.ok;
  };

  /** The manual path: a release this app could not install is still one the operator can. */
  const offerReleasePage = async (version: string, interactive: boolean): Promise<void> => {
    broadcast("available", version);
    if (!interactive && version === askedVersion) return;
    askedVersion = version;
    const open = await options.prompt(updatePrompt(version));
    options.log?.line("info", "update", open ? "opening the release page" : "update deferred", {
      version,
    });
    if (open) options.openExternal(RELEASES_URL);
  };

  /**
   * Verified again here, not only after the download: "Later" can leave the
   * tar on disk for hours before the restart. A tar that no longer verifies
   * has been discarded, so the release page is what is left to offer.
   */
  const installVerified = async (): Promise<boolean> => {
    const version = readyVersion;
    if (version === null) return false;
    if (!(await verified())) {
      readyVersion = null;
      broadcast("available", version);
      return false;
    }
    options.log?.line("info", "update", "installing update", { version });
    await options.updater.applyUpdate();
    return true;
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
    async install() {
      // Not under a check: a download in flight could replace the tar between
      // this verification and the install.
      if (checking) return false;
      checking = true;
      try {
        return await installVerified();
      } catch (e: unknown) {
        fail(e);
        return false;
      } finally {
        checking = false;
      }
    },
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
