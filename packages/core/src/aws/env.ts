/**
 * §4.7: `aws.client()` pins the frozen profile with `fromIni`, so the SDK's
 * environment credential chain is ignored. That is the safe behaviour, but a
 * silent one — an operator who exported credentials expecting them to be used
 * deserves to be told they are not. Core cannot print (§3.2 rule 1), so it
 * returns the list and the heads render the warning.
 *
 * The variable names are held in an array rather than read as
 * `process.env.AWS_PROFILE`, because reading that property anywhere in core is
 * itself a banned pattern (`no-console.test.ts`).
 */
export const CREDENTIAL_ENV_VARS = [
  "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_ROLE_ARN",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
] as const;

export type CredentialEnvVar = (typeof CREDENTIAL_ENV_VARS)[number];

/** Which credential environment variables are set, in declaration order. */
export function detectEnvCredentialOverrides(
  env: Record<string, string | undefined> = process.env,
): CredentialEnvVar[] {
  return CREDENTIAL_ENV_VARS.filter((name) => {
    const value = env[name];
    return typeof value === "string" && value.length > 0;
  });
}
