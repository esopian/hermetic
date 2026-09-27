import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { IAMClient, ListAccountAliasesCommand } from "@aws-sdk/client-iam";
import { DescribeOrganizationCommand, OrganizationsClient } from "@aws-sdk/client-organizations";
import { fromIni } from "@aws-sdk/credential-providers";
import type { CallerIdentity, IdentityApi } from "../backend/types.ts";
import type { ResolvedIdentity } from "../schema/index.ts";
import { HermeticError } from "../errors.ts";
import { credentialError, type ClientFactory } from "./client.ts";

/**
 * §4.4: identity is free — `sts get-caller-identity` supplies the actor ARN for
 * every event, so there is no login system. The alias and the org id are
 * best-effort display fields; member accounts commonly cannot read the
 * organisation, and that never blocks anything (§4.7 step 2).
 */
export class AwsIdentity implements IdentityApi {
  private cached: CallerIdentity | null = null;

  constructor(private readonly factory: ClientFactory) {}

  async callerIdentity(): Promise<CallerIdentity> {
    if (this.cached) return this.cached;
    const sts = this.factory.client(STSClient);
    const out = await sts.send(new GetCallerIdentityCommand({}));
    if (!out.Account || !out.Arn) {
      throw new HermeticError("INTERNAL", "sts get-caller-identity returned no account or arn", {});
    }
    this.cached = { account_id: out.Account, arn: out.Arn, user_id: out.UserId ?? "" };
    return this.cached;
  }

  async accountAlias(): Promise<string | null> {
    try {
      const iam = this.factory.client(IAMClient);
      const out = await iam.send(new ListAccountAliasesCommand({}));
      return out.AccountAliases?.[0] ?? null;
    } catch {
      return null;
    }
  }

  async orgId(): Promise<string | null> {
    try {
      const orgs = this.factory.client(OrganizationsClient);
      const out = await orgs.send(new DescribeOrganizationCommand({}));
      return out.Organization?.Id ?? null;
    } catch {
      return null;
    }
  }
}

/**
 * §4.7 step 2, for the *one* profile the operator chose in the picker. This runs
 * before any account is frozen, so it deliberately does not go through
 * `aws.client()`: there is nothing to guard against yet, and the whole point is
 * to discover what the profile resolves to.
 */
export async function resolveIdentity(profile: string, region: string): Promise<ResolvedIdentity> {
  const credentials = fromIni({ profile });
  const sts = new STSClient({ region, credentials });

  let account_id: string;
  let arn: string;
  try {
    const out = await sts.send(new GetCallerIdentityCommand({}));
    if (!out.Account || !out.Arn) {
      throw new HermeticError("INTERNAL", `profile ${profile} resolved no account`, { profile });
    }
    account_id = out.Account;
    arn = out.Arn;
  } catch (e) {
    throw credentialError(e, profile);
  }

  let alias: string | null = null;
  try {
    const iam = new IAMClient({ region, credentials });
    alias = (await iam.send(new ListAccountAliasesCommand({}))).AccountAliases?.[0] ?? null;
  } catch {
    alias = null;
  }

  let org_id: string | null = null;
  try {
    const orgs = new OrganizationsClient({ region, credentials });
    org_id = (await orgs.send(new DescribeOrganizationCommand({}))).Organization?.Id ?? null;
  } catch {
    org_id = null;
  }

  return { account_id, arn, alias, org_id, region, profile };
}
