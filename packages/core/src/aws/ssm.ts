import {
  DeleteParameterCommand,
  DeleteParametersCommand,
  GetParameterCommand,
  GetParametersByPathCommand,
  PutParameterCommand,
  type SSMClient,
} from "@aws-sdk/client-ssm";
import type { SecretsApi } from "../backend/types.ts";
import { SECRET_PLACEHOLDER } from "../backend/constants.ts";
import { asHermeticError, awsErrorName, isAwsError } from "./client.ts";
import { HermeticError } from "../errors.ts";

/**
 * §8.2, slot and push: hermetic owns the *existence* of every secret — the
 * parameter name and the IAM policy — and never sees the *value* except in
 * transit. Nothing here returns a value to core; `isPlaceholder` compares and
 * discards.
 */
export class SsmSecrets implements SecretsApi {
  constructor(private readonly ssm: SSMClient) {}

  private async read(path: string, decrypt: boolean): Promise<string | null> {
    try {
      const out = await this.ssm.send(new GetParameterCommand({ Name: path, WithDecryption: decrypt }));
      return out.Parameter?.Value ?? null;
    } catch (e) {
      if (isAwsError(e, "ParameterNotFound")) return null;
      throw asHermeticError(e, `could not read the SSM slot ${path}`);
    }
  }

  /** Idempotent: an existing slot is left exactly as it is, value included. */
  async ensureSlot(path: string): Promise<void> {
    if ((await this.read(path, false)) !== null) return;
    try {
      await this.ssm.send(
        new PutParameterCommand({
          Name: path,
          Type: "SecureString",
          Value: SECRET_PLACEHOLDER,
          Overwrite: false,
          Description: "hermetic-owned slot",
        }),
      );
    } catch (e) {
      // Someone else created it between the read and the write — that is fine.
      if (isAwsError(e, "ParameterAlreadyExists")) return;
      throw asHermeticError(e, `could not create the SSM slot ${path}`);
    }
  }

  async put(path: string, value: string): Promise<void> {
    try {
      await this.ssm.send(
        new PutParameterCommand({ Name: path, Type: "SecureString", Value: value, Overwrite: true }),
      );
    } catch (e) {
      /**
       * This is the one call in hermetic that has a secret in its hand, so the
       * provider's own message is dropped rather than wrapped: an SDK error can
       * quote the request it failed on, and that request is the value (§8.3).
       * The slot name and the AWS error name are enough to act on.
       */
      throw new HermeticError("INTERNAL", `could not write the SSM slot ${path}`, {
        path,
        aws_error: awsErrorName(e),
      });
    }
  }

  async exists(path: string): Promise<boolean> {
    return (await this.read(path, false)) !== null;
  }

  async isPlaceholder(path: string): Promise<boolean> {
    return (await this.read(path, true)) === SECRET_PLACEHOLDER;
  }

  /** Read a slot's value. Only the tailscale client uses this; it never logs it. */
  async reveal(path: string): Promise<string | null> {
    return this.read(path, true);
  }

  /**
   * The same read, but as an assertion: a caller that is about to *move* a
   * value (a shared key into an agent's slot, a digest into a comparison) has
   * no sensible branch for `null`, so an absent slot is `NOT_FOUND` here rather
   * than a nullable the caller might pass on.
   */
  async get(path: string): Promise<string> {
    const value = await this.read(path, true);
    if (value === null) {
      throw new HermeticError("NOT_FOUND", `no SSM slot ${path}`, { path });
    }
    return value;
  }

  /** One exact parameter. Deleting one that is already gone is not a failure. */
  async delete(path: string): Promise<void> {
    try {
      await this.ssm.send(new DeleteParameterCommand({ Name: path }));
    } catch (e) {
      if (isAwsError(e, "ParameterNotFound")) return;
      throw asHermeticError(e, `could not delete the SSM slot ${path}`);
    }
  }

  async list(prefix: string): Promise<string[]> {
    const path = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    const names: string[] = [];
    let token: string | undefined;
    do {
      const out = await this.ssm.send(
        new GetParametersByPathCommand({
          Path: path === "" ? "/" : path,
          Recursive: true,
          WithDecryption: false,
          ...(token ? { NextToken: token } : {}),
        }),
      );
      for (const p of out.Parameters ?? []) if (p.Name) names.push(p.Name);
      token = out.NextToken;
    } while (token);
    return names.sort();
  }

  async deleteByPrefix(prefix: string): Promise<string[]> {
    const names = await this.list(prefix);
    for (let i = 0; i < names.length; i += 10) {
      await this.ssm.send(new DeleteParametersCommand({ Names: names.slice(i, i + 10) }));
    }
    return names;
  }
}
