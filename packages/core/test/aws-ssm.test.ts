/**
 * `SsmSecrets`'s two newest doors (§8.2): reading one slot's value, and
 * deleting one exact parameter.
 *
 * They exist for the shared-secret surface — a value has to *move* from the
 * fleet's slot into an agent's, and `secrets rm` deletes one slug rather than a
 * prefix — and both have a failure mode worth pinning: `get` must refuse an
 * absent slot rather than hand back a nullable a caller could pass on, and
 * `delete` must treat an already-gone parameter as done rather than as an
 * error, because a re-run of a failed delete is the ordinary case.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DeleteParameterCommand,
  GetParameterCommand,
  PutParameterCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";
import { mockClient } from "aws-sdk-client-mock";
import { SsmSecrets } from "../src/aws/ssm.ts";
import type { HermeticError } from "../src/errors.ts";

const ssm = mockClient(SSMClient);

/** A fixture value; the leak grep in `secrets-leak.test.ts` covers the shape. */
const VALUE = "sk-nous-FIXTURE-SSM-VALUE";
const PATH = "/hermetic/secrets/nous-key";

function notFound(): Error {
  const e = new Error("ParameterNotFound");
  e.name = "ParameterNotFound";
  return e;
}

beforeEach(() => ssm.reset());
afterEach(() => ssm.reset());

describe("SsmSecrets.get", () => {
  test("decrypts the slot it was asked for", async () => {
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: VALUE } });
    const secrets = new SsmSecrets(new SSMClient({ region: "us-west-2" }));
    expect(await secrets.get(PATH)).toBe(VALUE);
    const call = ssm.commandCalls(GetParameterCommand)[0]!.args[0].input;
    // Without decryption a SecureString comes back as ciphertext, which would
    // make every digest comparison in `secrets verify` a false negative.
    expect(call).toMatchObject({ Name: PATH, WithDecryption: true });
  });

  test("an absent slot is NOT_FOUND, not null", async () => {
    ssm.on(GetParameterCommand).rejects(notFound());
    const secrets = new SsmSecrets(new SSMClient({ region: "us-west-2" }));
    const error = await secrets.get(PATH).catch((e: unknown) => e as HermeticError);
    expect((error as HermeticError).code).toBe("NOT_FOUND");
    expect((error as HermeticError).details?.["path"]).toBe(PATH);
  });
});

describe("SsmSecrets.delete", () => {
  test("deletes exactly the one parameter it names", async () => {
    ssm.on(DeleteParameterCommand).resolves({});
    const secrets = new SsmSecrets(new SSMClient({ region: "us-west-2" }));
    await secrets.delete(PATH);
    expect(ssm.commandCalls(DeleteParameterCommand)).toHaveLength(1);
    expect(ssm.commandCalls(DeleteParameterCommand)[0]!.args[0].input).toEqual({ Name: PATH });
  });

  test("a parameter that is already gone is done, not an error", async () => {
    ssm.on(DeleteParameterCommand).rejects(notFound());
    const secrets = new SsmSecrets(new SSMClient({ region: "us-west-2" }));
    await expect(secrets.delete(PATH)).resolves.toBeUndefined();
  });
});

describe("SsmSecrets.put", () => {
  function alreadyExists(): Error {
    const e = new Error("ParameterAlreadyExists");
    e.name = "ParameterAlreadyExists";
    return e;
  }

  test("overwrites by default, as every existing caller expects", async () => {
    ssm.on(PutParameterCommand).resolves({});
    const secrets = new SsmSecrets(new SSMClient({ region: "us-west-2" }));
    await secrets.put(PATH, VALUE);
    const call = ssm.commandCalls(PutParameterCommand)[0]!.args[0].input;
    expect(call.Overwrite).toBe(true);
  });

  test("overwrite: false asks SSM to refuse, and ParameterAlreadyExists is CONFLICT", async () => {
    ssm.on(PutParameterCommand).rejects(alreadyExists());
    const secrets = new SsmSecrets(new SSMClient({ region: "us-west-2" }));
    const error = (await secrets
      .put(PATH, VALUE, { overwrite: false })
      .catch((e: unknown) => e)) as HermeticError;
    expect(ssm.commandCalls(PutParameterCommand)[0]!.args[0].input.Overwrite).toBe(false);
    expect(error.code).toBe("CONFLICT");
    expect(error.details).toEqual({ path: PATH, already_exists: true });
    expect(error.message.includes(VALUE)).toBe(false);
  });

  test("with overwrite on, ParameterAlreadyExists is not a conflict", async () => {
    ssm.on(PutParameterCommand).rejects(alreadyExists());
    const secrets = new SsmSecrets(new SSMClient({ region: "us-west-2" }));
    const error = (await secrets.put(PATH, VALUE).catch((e: unknown) => e)) as HermeticError;
    expect(error.code).toBe("INTERNAL");
    expect(error.details?.["already_exists"]).toBeUndefined();
  });
});
