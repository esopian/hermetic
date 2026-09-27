import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { fromIni } from "@aws-sdk/credential-providers";
import { HermeticError } from "../errors.ts";

export { CREDENTIAL_ENV_VARS, detectEnvCredentialOverrides } from "./env.ts";
export type { CredentialEnvVar } from "./env.ts";

/** The subset of an SDK v3 client `aws.client()` needs to see. */
export interface SdkClientLike {
  send(command: unknown, options?: unknown): Promise<unknown>;
  destroy?(): void;
}

/** `fromIni` returns the provider; deriving the type avoids a @smithy/types import. */
export type CredentialProvider = ReturnType<typeof fromIni>;

export interface SdkClientConfig {
  region: string;
  credentials: CredentialProvider;
}

export type SdkClientCtor<T extends SdkClientLike> = new (config: SdkClientConfig) => T;

export interface ClientFactoryOptions {
  /** The frozen profile. Passed to `fromIni` explicitly — the env chain is ignored. */
  profile: string;
  region: string;
  /** The frozen account id. Every process verifies against it exactly once. */
  expectedAccountId: string;
}

/**
 * Hung off every client `aws.client()` builds, so a wrapper that must construct
 * a *derived* client — `DynamoDBDocumentClient.from(...)`, which does not reuse
 * the proxied `send` — can find the guard and re-apply it. Without this the
 * document client would talk to DynamoDB with the account check never run.
 */
export const ACCOUNT_GUARD: unique symbol = Symbol.for("hermetic.accountGuard");

export type AccountGuard = () => Promise<void>;

/** The guard attached to a client built by `aws.client()`, if it has one. */
export function accountGuardOf(client: unknown): AccountGuard | null {
  if (typeof client !== "object" || client === null) return null;
  const guard = (client as Record<symbol, unknown>)[ACCOUNT_GUARD];
  return typeof guard === "function" ? (guard as AccountGuard) : null;
}

/** Re-apply an account guard to a client built outside `aws.client()`. */
export function guardClient<T extends object>(client: T, assertAccount: AccountGuard): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === ACCOUNT_GUARD) return assertAccount;
      if (prop !== "send") return Reflect.get(target, prop, receiver);
      return async (command: unknown, options?: unknown) => {
        await assertAccount();
        return (target as unknown as SdkClientLike).send(command, options);
      };
    },
  });
}

export interface ClientFactory {
  /**
   * Construct any SDK v3 client. The returned client verifies the account on its
   * first `send` — one STS call per process, ~50 ms (§4.7).
   */
  client<T extends SdkClientLike>(Ctor: SdkClientCtor<T>): T;
  /** Force the account check now (used by `doctor` and by the init flow). */
  assertAccount(): Promise<void>;
  readonly region: string;
  readonly profile: string;
  readonly expectedAccountId: string;
}

/**
 * §4.7. One function constructs every AWS client in core, so there is exactly one
 * place where credentials are chosen and exactly one place the account guard can
 * be bypassed — and it is a build error to construct a client anywhere else.
 *
 * The guard is memoised per factory (one per process in practice). Once it has
 * failed it stays failed: every later `send` rethrows the same
 * `ACCOUNT_MISMATCH` without another STS call, so a wrong-account process makes
 * no further AWS requests.
 */
export function makeClientFactory(opts: ClientFactoryOptions): ClientFactory {
  const credentials = fromIni({ profile: opts.profile });

  let pending: Promise<void> | null = null;
  let failure: HermeticError | null = null;

  async function verify(): Promise<void> {
    const sts = new STSClient({ region: opts.region, credentials });
    let accountId: string | undefined;
    try {
      const out = await sts.send(new GetCallerIdentityCommand({}));
      accountId = out.Account;
    } catch (e) {
      // A credential failure is not an account mismatch; surface it as-is but do
      // not memoise it, so a re-login can succeed without a new process.
      pending = null;
      throw credentialError(e, opts.profile);
    }
    if (accountId !== opts.expectedAccountId) {
      failure = new HermeticError(
        "ACCOUNT_MISMATCH",
        `credentials for profile ${opts.profile} resolve to account ${accountId ?? "(unknown)"} but this hermetic home is frozen to ${opts.expectedAccountId}`,
        { observed: accountId ?? null, frozen: opts.expectedAccountId, profile: opts.profile },
      );
      throw failure;
    }
  }

  async function assertAccount(): Promise<void> {
    if (failure) throw failure;
    pending ??= verify();
    await pending;
  }

  function client<T extends SdkClientLike>(Ctor: SdkClientCtor<T>): T {
    const inner = new Ctor({ region: opts.region, credentials });
    return guardClient(inner as unknown as object, assertAccount) as T;
  }

  return {
    client,
    assertAccount,
    region: opts.region,
    profile: opts.profile,
    expectedAccountId: opts.expectedAccountId,
  };
}

/**
 * A profile the SDK cannot resolve is an operator mistake — a typo in the picker,
 * an expired SSO session, a profile that was renamed, an unresolvable
 * credential chain — not an internal fault. `INTERNAL` would send the CLI to
 * exit code 70 and the browser to a 500 for what is really "that profile does
 * not work"; these map to `VALIDATION` instead.
 *
 * The SDK v3 credential-provider chain throws a `CredentialsProviderError`
 * whose message varies by provider ("Could not resolve credentials using
 * profile...", "Profile ... not found", token/SSO-session messages, ...), so
 * the check matches on the error's name as well as its message text — a
 * message that doesn't match one of these phrasings would otherwise fall
 * through to `asHermeticError` and be misreported as `INTERNAL`.
 */
const CREDENTIAL_RESOLUTION_FAILURE =
  /could not resolve credentials|could not load credentials|unable to resolve credentials|token (?:is )?expired|sso session|refresh.*token|profile is not configured|profile\s+(?:\S+\s+)?(?:could not be found|not found|does not exist)|could not be found in shared credentials|no such profile/i;

export function credentialError(e: unknown, profile: string): HermeticError {
  if (e instanceof HermeticError) return e;
  const message = e instanceof Error ? e.message : String(e);
  if (awsErrorName(e) === "CredentialsProviderError" || CREDENTIAL_RESOLUTION_FAILURE.test(message)) {
    return new HermeticError(
      "VALIDATION",
      `AWS profile '${profile}' could not be resolved: ${message}`,
      { profile },
    );
  }
  return asHermeticError(e, `profile ${profile} could not be used`);
}

/** Normalise an SDK throw into core's one error type, preserving the AWS name. */
export function asHermeticError(e: unknown, message: string): HermeticError {
  if (e instanceof HermeticError) return e;
  const name = awsErrorName(e);
  const detail = e instanceof Error ? e.message : String(e);
  return new HermeticError("INTERNAL", `${message}: ${detail}`, { aws_error: name });
}

/** The `name` an SDK v3 error carries (`ConditionalCheckFailedException`, …). */
export function awsErrorName(e: unknown): string | null {
  if (typeof e !== "object" || e === null) return null;
  const withName = e as { name?: unknown; __type?: unknown; Code?: unknown };
  if (typeof withName.name === "string") return withName.name;
  if (typeof withName.__type === "string") return withName.__type;
  if (typeof withName.Code === "string") return withName.Code;
  return null;
}

export function isAwsError(e: unknown, ...names: string[]): boolean {
  const name = awsErrorName(e);
  return name !== null && names.includes(name);
}

/** HTTP status an SDK v3 error carries, when it carries one. */
export function awsStatusCode(e: unknown): number | null {
  const meta = (e as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata;
  return typeof meta?.httpStatusCode === "number" ? meta.httpStatusCode : null;
}
