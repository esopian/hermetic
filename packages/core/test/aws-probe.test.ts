import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { describeFoundation } from "../src/aws/probe.ts";
import { FLEET_KEY, NO_FOUNDATION, STACK_NAME, stackNameFor } from "../src/schema/index.ts";
import { inputsOf, installTestProfile, TEST_PROFILE } from "./aws-harness.ts";

const profile = installTestProfile();
afterAll(() => profile.restore());

const cfn = mockClient(CloudFormationClient);
const ddb = mockClient(DynamoDBDocumentClient);

const FLEET_ID = "fxtr0001";

beforeEach(() => {
  cfn.reset();
  ddb.reset();
});

function stack(
  tags: Array<{ Key: string; Value: string }>,
  status:
    | "CREATE_COMPLETE"
    | "ROLLBACK_COMPLETE"
    | "DELETE_IN_PROGRESS"
    | "DELETE_FAILED"
    | "DELETE_COMPLETE" = "CREATE_COMPLETE",
  name: string = stackNameFor(FLEET_ID),
) {
  // `CreationTime` is required by the SDK's output type but irrelevant here.
  return {
    $metadata: {},
    Stacks: [
      {
        StackId: `arn:aws:cloudformation:us-west-2:123456789012:stack/${name}/abc`,
        StackName: name,
        StackStatus: status,
        CreationTime: new Date("2026-07-20T09:00:00.000Z"),
        Tags: tags,
      },
    ],
  };
}

/** §4.7 step 4, read-only and pre-freeze: "which fleet am I about to join?" */
describe("describeFoundation", () => {
  test("reports nothing when the account holds no hermetic stack", async () => {
    cfn.on(DescribeStacksCommand).resolves({ $metadata: {}, Stacks: [] });
    expect(await describeFoundation(TEST_PROFILE, "us-west-2")).toEqual(NO_FOUNDATION);
  });

  /**
   * The probe no longer asks for a stack *by name* — a foundation is
   * `hermetic-<fleet_id>` — so somebody else's stack in the same account must
   * not read as a foundation.
   */
  test("stacks that are not hermetic's are ignored", async () => {
    cfn.on(DescribeStacksCommand).resolves({
      $metadata: {},
      Stacks: [
        {
          StackId: "arn:aws:cloudformation:us-west-2:123456789012:stack/some-app/xyz",
          StackName: "some-app",
          StackStatus: "CREATE_COMPLETE",
          CreationTime: new Date("2026-07-20T09:00:00.000Z"),
          Tags: [{ Key: "team", Value: "platform" }],
        },
      ],
    });
    expect(await describeFoundation(TEST_PROFILE, "us-west-2")).toEqual(NO_FOUNDATION);
  });

  test("a torn-down foundation CloudFormation still lists is not a foundation", async () => {
    cfn
      .on(DescribeStacksCommand)
      .resolves(stack([{ Key: "hermetic:fleet_id", Value: FLEET_ID }], "DELETE_COMPLETE"));
    expect(await describeFoundation(TEST_PROFILE, "us-west-2")).toEqual(NO_FOUNDATION);
  });

  test("a pre-rename foundation, whose stack is called plain `hermetic`, is still found", async () => {
    cfn
      .on(DescribeStacksCommand)
      .resolves(stack([{ Key: "hermetic:fleet_id", Value: FLEET_ID }], "CREATE_COMPLETE", STACK_NAME));
    ddb.on(GetCommand).resolves({ Item: { name: FLEET_KEY, tailnet: "acme.ts.net" } });

    const found = await describeFoundation(TEST_PROFILE, "us-west-2");
    expect(found.found).toBe(true);
    expect(found.fleet_id).toBe(FLEET_ID);
    // …and its tables are the pre-rename ones, read from the stack's own name.
    const [get] = inputsOf<{ TableName: string }>(ddb, GetCommand);
    expect(get!.TableName).toBe("hermetic-agents");
  });

  test("reads the fleet_id from the stack tag and the tailnet from _fleet", async () => {
    cfn.on(DescribeStacksCommand).resolves(stack([{ Key: "hermetic:fleet_id", Value: FLEET_ID }]));
    ddb.on(GetCommand).resolves({ Item: { name: FLEET_KEY, tailnet: "acme.ts.net" } });

    expect(await describeFoundation(TEST_PROFILE, "us-west-2")).toEqual({
      found: true,
      fleet_id: FLEET_ID,
      region: "us-west-2",
      tailnet: "acme.ts.net",
      stack_status: "CREATE_COMPLETE",
    });

    // Discovery, not a name lookup: nothing is asked for by name any more.
    const [query] = inputsOf<{ StackName?: string }>(cfn, DescribeStacksCommand);
    expect(query!.StackName).toBeUndefined();
    const [get] = inputsOf<{ Key: { name: string }; TableName: string }>(ddb, GetCommand);
    expect(get!.Key.name).toBe(FLEET_KEY);
    // The table it reads is the one this fleet's stack name implies.
    expect(get!.TableName).toBe(`${stackNameFor(FLEET_ID)}-agents`);
  });

  test("an unreadable _fleet item leaves the tailnet null rather than failing", async () => {
    cfn.on(DescribeStacksCommand).resolves(stack([{ Key: "hermetic:fleet_id", Value: FLEET_ID }]));
    ddb.on(GetCommand).rejects(new Error("AccessDeniedException"));

    const out = await describeFoundation(TEST_PROFILE, "us-west-2");
    expect(out.found).toBe(true);
    expect(out.fleet_id).toBe(FLEET_ID);
    expect(out.tailnet).toBeNull();
  });

  test("a stack with no fleet_id tag is found but unidentified", async () => {
    cfn.on(DescribeStacksCommand).resolves(stack([], "ROLLBACK_COMPLETE"));
    ddb.on(GetCommand).resolves({ Item: undefined });

    expect(await describeFoundation(TEST_PROFILE, "us-west-2")).toEqual({
      found: true,
      fleet_id: null,
      region: "us-west-2",
      tailnet: null,
      stack_status: "ROLLBACK_COMPLETE",
    });
  });

  /**
   * F4: a foundation on its way out is neither "found, attach to it" nor "not
   * found, create one". The probe reports the status; `init` is what refuses.
   */
  test("a foundation being deleted is reported with its DELETE_IN_PROGRESS status", async () => {
    cfn
      .on(DescribeStacksCommand)
      .resolves(stack([{ Key: "hermetic:fleet_id", Value: FLEET_ID }], "DELETE_IN_PROGRESS"));
    ddb.on(GetCommand).rejects(new Error("ResourceNotFoundException"));

    expect(await describeFoundation(TEST_PROFILE, "us-west-2")).toEqual({
      found: true,
      fleet_id: FLEET_ID,
      region: "us-west-2",
      tailnet: null,
      stack_status: "DELETE_IN_PROGRESS",
    });
  });

  test("a DELETE_FAILED foundation is reported the same way", async () => {
    cfn
      .on(DescribeStacksCommand)
      .resolves(stack([{ Key: "hermetic:fleet_id", Value: FLEET_ID }], "DELETE_FAILED"));
    ddb.on(GetCommand).resolves({});
    const found = await describeFoundation(TEST_PROFILE, "us-west-2");
    expect(found.stack_status).toBe("DELETE_FAILED");
    expect(found.found).toBe(true);
  });

  test("it mutates nothing", async () => {
    cfn.on(DescribeStacksCommand).resolves(stack([{ Key: "hermetic:fleet_id", Value: FLEET_ID }]));
    ddb.on(GetCommand).resolves({ Item: { name: FLEET_KEY, tailnet: "acme.ts.net" } });
    await describeFoundation(TEST_PROFILE, "us-west-2");
    // Two reads, and nothing else — the whole point of a probe.
    expect(cfn.calls()).toHaveLength(1);
    expect(ddb.calls()).toHaveLength(1);
  });
});
