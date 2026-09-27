import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import {
  CREDENTIAL_ENV_VARS,
  credentialError,
  detectEnvCredentialOverrides,
  makeClientFactory,
} from "../src/aws/client.ts";
import { createDynamoStores } from "../src/aws/dynamo.ts";
import { HermeticError } from "../src/errors.ts";
import { callCount, installTestProfile, TEST_PROFILE, withEnv } from "./aws-harness.ts";

const profile = installTestProfile();
afterAll(() => profile.restore());

const FROZEN = "123456789012";
const OTHER = "999999999999";

const sts = mockClient(STSClient);
const ssm = mockClient(SSMClient);
const ddb = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  sts.reset();
  ssm.reset();
  ddb.reset();
});

function factory() {
  return makeClientFactory({ profile: TEST_PROFILE, region: "us-west-2", expectedAccountId: FROZEN });
}

/** §11.3: the guard that justifies the whole account-safety design. */
describe("the account guard", () => {
  test("passes when STS returns the frozen account, and costs one STS call", async () => {
    sts
      .on(GetCallerIdentityCommand)
      .resolves({ Account: FROZEN, Arn: "arn:aws:iam::123456789012:user/e" });
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: "ami-0123456789abcdef0" } });

    const f = factory();
    const client = f.client(SSMClient);
    await client.send(new GetParameterCommand({ Name: "/x" }));
    await client.send(new GetParameterCommand({ Name: "/y" }));

    // Memoised per process: two AWS calls, one identity check (§4.7).
    expect(callCount(sts, GetCallerIdentityCommand)).toBe(1);
    expect(callCount(ssm, GetParameterCommand)).toBe(2);
  });

  test("ACCOUNT_MISMATCH fires when STS returns another account", async () => {
    sts
      .on(GetCallerIdentityCommand)
      .resolves({ Account: OTHER, Arn: "arn:aws:iam::999999999999:user/e" });
    const client = factory().client(SSMClient);

    let error: HermeticError | null = null;
    try {
      await client.send(new GetParameterCommand({ Name: "/x" }));
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error).toBeInstanceOf(HermeticError);
    expect(error!.code).toBe("ACCOUNT_MISMATCH");
    expect(error!.details).toMatchObject({ observed: OTHER, frozen: FROZEN });
    // The guarded call never reached SSM.
    expect(callCount(ssm, GetParameterCommand)).toBe(0);
  });

  test("fires with AWS_PROFILE and AWS_ACCESS_KEY_ID set in the environment", async () => {
    sts
      .on(GetCallerIdentityCommand)
      .resolves({ Account: OTHER, Arn: "arn:aws:iam::999999999999:user/e" });

    const run = withEnv(
      {
        AWS_PROFILE: "some-other-profile",
        AWS_ACCESS_KEY_ID: "AKIAENVOVERRIDE00000",
        AWS_SECRET_ACCESS_KEY: "env-secret",
      },
      () => {
        // The env chain is ignored: `fromIni` is given the frozen profile
        // explicitly, so the guard still sees the profile's account (§4.7).
        expect(detectEnvCredentialOverrides()).toEqual([
          "AWS_PROFILE",
          "AWS_ACCESS_KEY_ID",
          "AWS_SECRET_ACCESS_KEY",
        ]);
        return factory()
          .client(SSMClient)
          .send(new GetParameterCommand({ Name: "/x" }));
      },
    );

    await expect(run).rejects.toThrow(HermeticError);
    await run.catch((e: HermeticError) => expect(e.code).toBe("ACCOUNT_MISMATCH"));
    expect(callCount(ssm, GetParameterCommand)).toBe(0);
  });

  test("after a mismatch every further call throws without hitting STS again", async () => {
    sts
      .on(GetCallerIdentityCommand)
      .resolves({ Account: OTHER, Arn: "arn:aws:iam::999999999999:user/e" });
    const f = factory();
    const a = f.client(SSMClient);
    const b = f.client(SSMClient);

    await expect(a.send(new GetParameterCommand({ Name: "/x" }))).rejects.toThrow(HermeticError);
    await expect(b.send(new GetParameterCommand({ Name: "/y" }))).rejects.toThrow(HermeticError);
    await expect(f.assertAccount()).rejects.toThrow(HermeticError);

    // One STS call for the whole process, mismatch included: no further AWS
    // requests are made once the account is known to be wrong.
    expect(callCount(sts, GetCallerIdentityCommand)).toBe(1);
    expect(callCount(ssm, GetParameterCommand)).toBe(0);
  });
});

/**
 * `DynamoDBDocumentClient.from()` builds a *new* client rather than reusing the
 * proxied `send`, so without deliberate re-wrapping the busiest AWS surface in
 * hermetic would be the one that never checks the account.
 */
describe("the guard reaches the DynamoDB document client", () => {
  const ROW = {
    name: "atlas",
    status: "creating",
    version: 1,
    lock: null,
    size: "medium",
    instance_type: "t4g.2xlarge",
    region: "us-west-2",
    instance_id: null,
    volume_id: null,
    volume_gib: 100,
    hermes_version: "0.15.0",
    hermeticd_version: "0.4.1",
    config_hash: null,
    provider: "bedrock",
    secrets_mode: "none",
    browser: true,
    tailscale_ip: null,
    resources: { ssm_paths: [] },
    last_heartbeat: null,
    health: null,
    metrics: null,
    created_by: "arn:aws:iam::123456789012:user/e",
    created_at: "2026-09-01T12:00:00.000Z",
    updated_at: "2026-09-01T12:00:00.000Z",
  };

  function stores() {
    return createDynamoStores(factory().client(DynamoDBClient), {
      agents: "hermetic-agents",
      events: "hermetic-events",
    });
  }

  test("a read against the wrong account is ACCOUNT_MISMATCH, not a row", async () => {
    sts
      .on(GetCallerIdentityCommand)
      .resolves({ Account: OTHER, Arn: "arn:aws:iam::999999999999:user/e" });
    ddb.on(GetCommand).resolves({ Item: ROW });

    let error: HermeticError | null = null;
    try {
      await stores().agents.get("atlas");
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error).toBeInstanceOf(HermeticError);
    expect(error!.code).toBe("ACCOUNT_MISMATCH");
    // The guard ran, and the read never reached DynamoDB.
    expect(callCount(sts, GetCallerIdentityCommand)).toBe(1);
    expect(callCount(ddb, GetCommand)).toBe(0);
  });

  test("every store method is guarded, not just reads", async () => {
    sts
      .on(GetCallerIdentityCommand)
      .resolves({ Account: OTHER, Arn: "arn:aws:iam::999999999999:user/e" });
    ddb.on(GetCommand).resolves({ Item: undefined });
    const s = stores();
    await expect(s.events.query("atlas")).rejects.toThrow(HermeticError);
    await expect(s.fleet.get()).rejects.toThrow(HermeticError);
    await expect(s.agents.scan()).rejects.toThrow(HermeticError);
  });

  test("the right account passes through and the row is returned", async () => {
    sts
      .on(GetCallerIdentityCommand)
      .resolves({ Account: FROZEN, Arn: "arn:aws:iam::123456789012:user/e" });
    ddb.on(GetCommand).resolves({ Item: ROW });
    expect((await stores().agents.get("atlas"))!.name).toBe("atlas");
    expect(callCount(sts, GetCallerIdentityCommand)).toBe(1);
  });
});

/**
 * A credential-resolution failure — a typo'd profile, an expired SSO session,
 * an unresolvable chain — is an operator mistake, not an internal fault: it
 * must map to `VALIDATION`, never `INTERNAL`.
 */
describe("credentialError", () => {
  test("a fake CredentialsProviderError maps to VALIDATION, not INTERNAL", () => {
    class CredentialsProviderError extends Error {
      override name = "CredentialsProviderError";
    }
    const e = new CredentialsProviderError("Could not resolve credentials using profile: [acme-dev]");
    const error = credentialError(e, "acme-dev");
    expect(error).toBeInstanceOf(HermeticError);
    expect(error.code).toBe("VALIDATION");
    expect(error.message).toBe(
      "AWS profile 'acme-dev' could not be resolved: Could not resolve credentials using profile: [acme-dev]",
    );
    expect(error.details).toEqual({ profile: "acme-dev" });
  });

  test("a 'profile not found' message maps to VALIDATION too", () => {
    const e = new Error("Profile acme-dev not found");
    const error = credentialError(e, "acme-dev");
    expect(error.code).toBe("VALIDATION");
    expect(error.message).toContain("AWS profile 'acme-dev' could not be resolved");
  });

  test("an unrelated AWS error still falls through to asHermeticError as INTERNAL", () => {
    const e = new Error("some unrelated throttling failure");
    const error = credentialError(e, "acme-dev");
    expect(error.code).toBe("INTERNAL");
  });
});

describe("detectEnvCredentialOverrides", () => {
  test("reports nothing when nothing is set", () => {
    const cleared = Object.fromEntries(CREDENTIAL_ENV_VARS.map((n) => [n, undefined]));
    withEnv(cleared, () => {
      expect(detectEnvCredentialOverrides()).toEqual([]);
    });
  });

  test("covers every variable the default credential chain would prefer", () => {
    expect([...CREDENTIAL_ENV_VARS]).toEqual([
      "AWS_PROFILE",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_ROLE_ARN",
      "AWS_WEB_IDENTITY_TOKEN_FILE",
    ]);
    expect(detectEnvCredentialOverrides({ AWS_ROLE_ARN: "arn:aws:iam::1:role/x" })).toEqual([
      "AWS_ROLE_ARN",
    ]);
    // An empty string is not an override.
    expect(detectEnvCredentialOverrides({ AWS_PROFILE: "" })).toEqual([]);
  });
});

/**
 * `getSignedUrl` signs from the client's config directly and never calls `send`,
 * so the proxy cannot see it. A presigned URL is a bearer credential for an
 * object in *some* account, and it goes into user-data (§6.2 step 7).
 */
describe("presigning is guarded too", () => {
  test("a mismatched account throws before anything is signed", async () => {
    const { S3Artifacts } = await import("../src/aws/s3.ts");
    const { S3Client } = await import("@aws-sdk/client-s3");
    sts
      .on(GetCallerIdentityCommand)
      .resolves({ Account: OTHER, Arn: "arn:aws:iam::999999999999:user/e" });

    const artifacts = new S3Artifacts(factory().client(S3Client), "hermetic-bucket");
    let error: HermeticError | null = null;
    try {
      await artifacts.presign("artifacts/0.4.1/hermeticd", 3600);
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error!.code).toBe("ACCOUNT_MISMATCH");
    expect(callCount(sts, GetCallerIdentityCommand)).toBe(1);
  });

  test("the right account signs a URL for the requested key", async () => {
    const { S3Artifacts } = await import("../src/aws/s3.ts");
    const { S3Client } = await import("@aws-sdk/client-s3");
    sts
      .on(GetCallerIdentityCommand)
      .resolves({ Account: FROZEN, Arn: "arn:aws:iam::123456789012:user/e" });

    const artifacts = new S3Artifacts(factory().client(S3Client), "hermetic-bucket");
    const url = await artifacts.presign("artifacts/0.4.1/hermeticd", 3600);
    expect(url).toContain("artifacts/0.4.1/hermeticd");
    expect(url).toContain("X-Amz-Signature");
    expect(url).toContain("X-Amz-Expires=3600");
  });

  test("an S3 client not built by aws.client() cannot presign at all", async () => {
    const { S3Artifacts } = await import("../src/aws/s3.ts");
    const { S3Client } = await import("@aws-sdk/client-s3");
    const artifacts = new S3Artifacts(new S3Client({ region: "us-west-2" }), "hermetic-bucket");
    let error: HermeticError | null = null;
    try {
      await artifacts.presign("artifacts/0.4.1/hermeticd", 3600);
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error!.code).toBe("INTERNAL");
    expect(error!.message).toContain("no account guard");
  });
});
