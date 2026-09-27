/**
 * The shapes the `init` modules share: what `createHermetic` hands `createInit`
 * (`InitDeps`), the one option every long operation takes, and `InitRun` — the
 * facts one `init` call establishes before it decides whether to attach or
 * create, handed to the helpers that used to close over them.
 */
import type { CallerIdentity, DirectoryApi } from "../backend/types.ts";
import type {
  AwsProfileInfo,
  DirectoryStatus,
  FoundationSummary,
  InitInput,
  LocalConfig,
  ResolvedIdentity,
  TailscaleOauthCheck,
  TailscalePreflight,
} from "../schema/index.ts";
import type { CoreContext } from "../context.ts";

/** Options every long operation takes (§3.2 rule 2). */
export interface InitOpOptions {
  signal?: AbortSignal;
}

/**
 * What `init` needs from `createHermetic`'s closure. Passing it explicitly is
 * what lets this file be read on its own — and `setActor` is the one write:
 * `init` is the call that first learns who the operator is, and the rest of the
 * SDK caches it.
 */
/**
 * What `init` needs beyond the shared context. The two §4.7 probes are
 * *required* here, not context defaults, for AGENTS.md rule 6: an absent
 * dependency must be a type error, never a gate that silently switched off.
 */
export interface InitDeps {
  ctx: CoreContext;
  configStore?:
    | {
        write(config: LocalConfig): Promise<void>;
        archiveRuns?(): Promise<void>;
        clear?(fleetId?: string): Promise<void>;
        /** The row this init would overwrite, by `fleet_id` — never "whichever is default". */
        read?(fleetId?: string): Promise<LocalConfig | null>;
        /** Every row this home holds, for the §4.6 one-home-one-account guard. */
        list?(): Promise<LocalConfig[]>;
        /** §4.8: the region the account's directory is already known to live in. */
        directoryRegion?(): Promise<string | null>;
        /** §4.8: `init` sets the default when this home has none, and only then. */
        defaultFleet?(): Promise<string | null>;
        setDefaultFleet?(fleetId: string | null): Promise<void>;
        /** §4.8: the directory region is asked for once, at `init`, and remembered. */
        setDirectoryRegion?(region: string): Promise<void>;
      }
    | undefined;
  initSupport?:
    | {
        listProfiles(): Promise<AwsProfileInfo[]>;
        resolveIdentity(profile: string, region: string): Promise<ResolvedIdentity>;
        describeFoundation(profile: string, region: string): Promise<FoundationSummary>;
        /** §4.8: the account directory in the region `--directory-region` named. */
        directoryFor?(region: string): DirectoryApi;
      }
    | undefined;
  /** Overrides the actor ARN `init` records; only tests pass this. */
  actor?: string | undefined;
  /** How often the foundation wait says "still creating"; tests shorten it. */
  heartbeatMs?: number | undefined;
  localTailscale: () => Promise<TailscalePreflight>;
  verifyTailscaleOauth: (secret: string) => Promise<TailscaleOauthCheck>;
}

/**
 * What one `init` call knows by the time it decides between attach and create,
 * and what every helper below the decision reads. All of it is settled before
 * the first helper runs — the validated input, the identity the credentials
 * resolved to, the home's existing row, the directory this run is about and
 * what it already held — so passing it explicitly changes nothing but where
 * the helpers live.
 */
export interface InitRun {
  parsed: InitInput;
  mode: "attach" | "create" | "auto";
  id: CallerIdentity;
  existingConfig: LocalConfig | null;
  alias: LocalConfig["account_alias"];
  org_id: LocalConfig["org_id"];
  directoryApi: DirectoryApi;
  /** The directory as it was *looked at*, before the gate (§4.8). */
  seen: DirectoryStatus;
}
