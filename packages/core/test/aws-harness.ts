import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `aws-sdk-client-mock@4` works under `bun test`; `aws-sdk-client-mock-jest` does
 * not (it extends npm's `expect`, not `bun:test`'s), so the assertions here are
 * hand-rolled over `mock.commandCalls`.
 */

export interface CommandMock {
  commandCalls(ctor: unknown): Array<{ args: [{ input: unknown }] }>;
}

/** Every input a mocked client received for one command type. */
export function inputsOf<T = Record<string, unknown>>(mock: CommandMock, ctor: unknown): T[] {
  return mock.commandCalls(ctor).map((call) => call.args[0].input as T);
}

export function callCount(mock: CommandMock, ctor: unknown): number {
  return mock.commandCalls(ctor).length;
}

/**
 * `aws.client()` pins the frozen profile with `fromIni` and ignores the
 * environment chain (§4.7), so tests need a real profile on disk — presigning in
 * particular resolves credentials for the signature even though nothing is sent.
 */
export const TEST_PROFILE = "hermetic-test";

export function installTestProfile(): { dir: string; restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "hermetic-aws-"));
  const credentials = join(dir, "credentials");
  const config = join(dir, "config");
  writeFileSync(
    credentials,
    `[${TEST_PROFILE}]\naws_access_key_id = AKIAFIXTUREFIXTURE00\naws_secret_access_key = fixture-secret-key-not-real\n`,
  );
  writeFileSync(config, `[profile ${TEST_PROFILE}]\nregion = us-west-2\n`);

  const previous = {
    creds: process.env["AWS_SHARED_CREDENTIALS_FILE"],
    config: process.env["AWS_CONFIG_FILE"],
  };
  process.env["AWS_SHARED_CREDENTIALS_FILE"] = credentials;
  process.env["AWS_CONFIG_FILE"] = config;

  return {
    dir,
    restore: () => {
      if (previous.creds === undefined) delete process.env["AWS_SHARED_CREDENTIALS_FILE"];
      else process.env["AWS_SHARED_CREDENTIALS_FILE"] = previous.creds;
      if (previous.config === undefined) delete process.env["AWS_CONFIG_FILE"];
      else process.env["AWS_CONFIG_FILE"] = previous.config;
    },
  };
}

/** Set environment variables for the duration of one test, then restore them. */
export function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
