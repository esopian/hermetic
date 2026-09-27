import { loadSharedConfigFiles } from "@smithy/shared-ini-file-loader";
import type { AwsProfileInfo, CredentialType } from "../schema/index.ts";
import { asHermeticErrorMessage } from "./errors.ts";

/**
 * §4.7 step 1: load profiles from `~/.aws/config` and `~/.aws/credentials` via
 * the SDK's own shared-ini loader, which covers SSO and assumed-role profiles.
 *
 * **No identity is resolved here.** Calling STS for each profile would trigger an
 * SSO login per profile just to draw a picker. The credential *type* is inferred
 * from the keys present in the file, which costs nothing and is all the picker
 * needs to show.
 */

function classify(entry: Record<string, string | undefined>): CredentialType {
  if (entry["sso_session"] || entry["sso_start_url"] || entry["sso_account_id"]) return "sso";
  if (entry["role_arn"] || entry["source_profile"] || entry["credential_source"]) return "assume_role";
  if (entry["credential_process"]) return "process";
  if (entry["aws_access_key_id"]) return "static";
  return "unknown";
}

export async function listAwsProfiles(): Promise<AwsProfileInfo[]> {
  let files: {
    configFile: Record<string, Record<string, string | undefined>>;
    credentialsFile: Record<string, Record<string, string | undefined>>;
  };
  try {
    files = (await loadSharedConfigFiles({ ignoreCache: true })) as typeof files;
  } catch (e) {
    throw asHermeticErrorMessage(e, "could not read the shared AWS config files");
  }

  const names = new Set([...Object.keys(files.configFile), ...Object.keys(files.credentialsFile)]);
  const out: AwsProfileInfo[] = [];
  for (const name of names) {
    const inConfig = files.configFile[name];
    const inCredentials = files.credentialsFile[name];
    const merged = { ...inConfig, ...inCredentials };
    out.push({
      name,
      region: merged["region"] ?? null,
      credential_type: classify(merged),
      source: inConfig && inCredentials ? "both" : inConfig ? "config" : "credentials",
    });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
