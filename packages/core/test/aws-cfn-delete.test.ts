/**
 * F4: `DeleteStack` is asynchronous. It returns the moment CloudFormation
 * accepts the request, with the VPC, both tables and the bucket still there —
 * so `deleteStack` waits for the deletion to actually finish, and every way it
 * can end is a case here.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  CloudFormationClient,
  DeleteStackCommand,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import { mockClient } from "aws-sdk-client-mock";
import { CfnFoundation } from "../src/aws/cfn.ts";
import { HermeticError } from "../src/errors.ts";
import { callCount, installTestProfile } from "./aws-harness.ts";

const profile = installTestProfile();
afterAll(() => profile.restore());

const cfn = mockClient(CloudFormationClient);

beforeEach(() => {
  cfn.reset();
});

function foundation(opts: { deleteTimeoutMs?: number } = {}) {
  return new CfnFoundation(new CloudFormationClient({ region: "us-west-2" }), {
    bedrockModelArns: ["arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude"],
    hermeticVersion: "0.4.1",
    // Milliseconds, so the waiter's several polls cost nothing.
    pollIntervalMs: 1,
    ...(opts.deleteTimeoutMs === undefined ? {} : { deleteTimeoutMs: opts.deleteTimeoutMs }),
  });
}

/** CloudFormation reports an absent stack as a validation error, not a 404. */
function doesNotExist(): Error {
  const e = new Error("Stack with id hermetic does not exist");
  e.name = "ValidationError";
  return e;
}

/** The SDK's output type wants a name and a creation time; neither matters here. */
function stackWith(
  status: "DELETE_IN_PROGRESS" | "DELETE_COMPLETE" | "DELETE_FAILED",
  extra: Record<string, unknown> = {},
) {
  return {
    Stacks: [
      {
        StackId: "arn:stack/hermetic",
        StackName: "hermetic",
        StackStatus: status,
        CreationTime: new Date("2026-08-01T00:00:00.000Z"),
        ...extra,
      },
    ],
  };
}

const deleting = stackWith("DELETE_IN_PROGRESS");

async function errorOf(fn: () => Promise<unknown>): Promise<HermeticError> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof HermeticError) return e;
    throw e;
  }
  throw new Error("expected a HermeticError");
}

describe("deleteStack waits for the deletion to finish", () => {
  test("polls DescribeStacks until the stack no longer exists", async () => {
    cfn.on(DeleteStackCommand).resolves({});
    cfn
      .on(DescribeStacksCommand)
      .resolvesOnce(deleting)
      .resolvesOnce(deleting)
      .rejectsOnce(doesNotExist());

    await foundation().deleteStack();

    expect(callCount(cfn, DeleteStackCommand)).toBe(1);
    expect(callCount(cfn, DescribeStacksCommand)).toBe(3);
  });

  test("DELETE_COMPLETE is the other spelling of gone", async () => {
    cfn.on(DeleteStackCommand).resolves({});
    cfn.on(DescribeStacksCommand).resolvesOnce(deleting).resolvesOnce(stackWith("DELETE_COMPLETE"));

    await foundation().deleteStack();
    expect(callCount(cfn, DescribeStacksCommand)).toBe(2);
  });

  /** The reason is the only part of a DELETE_FAILED an operator can act on. */
  test("DELETE_FAILED throws, carrying the stack status reason", async () => {
    cfn.on(DeleteStackCommand).resolves({});
    cfn
      .on(DescribeStacksCommand)
      .resolvesOnce(deleting)
      .resolvesOnce(
        stackWith("DELETE_FAILED", {
          StackStatusReason: "The bucket you tried to delete is not empty (hermetic-fleet-bucket)",
        }),
      );

    const error = await errorOf(() => foundation().deleteStack());
    expect(error.message).toContain("DELETE_FAILED");
    expect(error.message).toContain("bucket you tried to delete is not empty");
    expect(error.details?.["reason"]).toContain("not empty");
  });

  test("a DELETE_FAILED with no reason still says so rather than throwing undefined", async () => {
    cfn.on(DeleteStackCommand).resolves({});
    cfn.on(DescribeStacksCommand).resolves(stackWith("DELETE_FAILED"));

    const error = await errorOf(() => foundation().deleteStack());
    expect(error.message).toContain("CloudFormation gave no reason");
  });

  /** §3.2 rule 2: every long operation in hermetic honours the caller's signal. */
  test("an aborted signal stops the wait and says the stack is still going", async () => {
    cfn.on(DeleteStackCommand).resolves({});
    cfn.on(DescribeStacksCommand).resolves(deleting);
    const controller = new AbortController();
    controller.abort();

    const error = await errorOf(() => foundation().deleteStack({ signal: controller.signal }));
    expect(error.code).toBe("ABORTED");
    expect(error.message).toContain("still being deleted in AWS");
    // The DeleteStack itself was sent; only the waiting stopped.
    expect(callCount(cfn, DeleteStackCommand)).toBe(1);
    expect(callCount(cfn, DescribeStacksCommand)).toBe(0);
  });

  test("a signal aborted mid-wait stops it too", async () => {
    cfn.on(DeleteStackCommand).resolves({});
    cfn.on(DescribeStacksCommand).resolves(deleting);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);

    const error = await errorOf(() => foundation().deleteStack({ signal: controller.signal }));
    expect(error.code).toBe("ABORTED");
  });

  /** A VPC whose ENIs will not detach can sit in DELETE_IN_PROGRESS forever. */
  test("it gives up after the cap rather than waiting for ever", async () => {
    cfn.on(DeleteStackCommand).resolves({});
    cfn.on(DescribeStacksCommand).resolves(deleting);

    const error = await errorOf(() => foundation({ deleteTimeoutMs: 5 }).deleteStack());
    expect(error.message).toContain("DELETE_IN_PROGRESS");
    expect(error.message).toContain("still being deleted in AWS");
  });

  test("a DeleteStack the API refuses never reaches the waiter", async () => {
    cfn.on(DeleteStackCommand).rejects(new Error("AccessDenied: not your stack"));

    const error = await errorOf(() => foundation().deleteStack());
    expect(error.message).toContain("could not delete the hermetic stack");
    expect(callCount(cfn, DescribeStacksCommand)).toBe(0);
  });

  test("a DescribeStacks failure that is not `does not exist` is not success", async () => {
    cfn.on(DeleteStackCommand).resolves({});
    cfn.on(DescribeStacksCommand).rejects(new Error("Throttling: rate exceeded"));

    const error = await errorOf(() => foundation().deleteStack());
    expect(error.message).toContain("could not watch the hermetic stack being deleted");
  });
});

/**
 * §4.7 step 4 reads this status to decide whether the foundation is attachable
 * at all, so `describeStack` has to report it verbatim rather than flattening
 * every non-healthy state into "absent".
 */
describe("describeStack reports the stack status", () => {
  test("a stack being deleted is reported, not hidden", async () => {
    cfn
      .on(DescribeStacksCommand)
      .resolves(
        stackWith("DELETE_IN_PROGRESS", { Tags: [{ Key: "hermetic:fleet_id", Value: "fleet-1" }] }),
      );

    const stack = await foundation().describeStack();
    expect(stack?.status).toBe("DELETE_IN_PROGRESS");
    expect(stack?.tags["fleet_id"]).toBe("fleet-1");
  });

  test("a DELETE_FAILED stack is reported with that status", async () => {
    cfn.on(DescribeStacksCommand).resolves(stackWith("DELETE_FAILED"));
    expect((await foundation().describeStack())?.status).toBe("DELETE_FAILED");
  });

  test("an absent stack is still null", async () => {
    cfn.on(DescribeStacksCommand).rejects(doesNotExist());
    expect(await foundation().describeStack()).toBeNull();
  });
});
