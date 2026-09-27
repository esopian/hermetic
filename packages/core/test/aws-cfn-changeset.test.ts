/**
 * The real CloudFormation change-set wrappers of §6.6 step 3.
 *
 * What is worth asserting against the SDK rather than against `MemoryBackend`:
 * the parameters a change set is created with (only `HermeticVersion` gets a new
 * value, and `FckNatAmiId` is only referenced when the stack actually has it),
 * that `Changes[]` is flattened and paged, and that an executed change set which
 * ends in `UPDATE_ROLLBACK_COMPLETE` is a *failure* even though the same status
 * is healthy for every other reader of the stack.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  CloudFormationClient,
  CreateChangeSetCommand,
  DeleteChangeSetCommand,
  DescribeChangeSetCommand,
  DescribeStackEventsCommand,
  DescribeStacksCommand,
  ExecuteChangeSetCommand,
} from "@aws-sdk/client-cloudformation";
import type { StackStatus } from "@aws-sdk/client-cloudformation";
import { mockClient } from "aws-sdk-client-mock";
import { CfnFoundation } from "../src/aws/cfn.ts";
import { foundationTemplateBody } from "../src/aws/cfn-template.ts";
import { HermeticError } from "../src/errors.ts";
import { inputsOf, callCount, installTestProfile } from "./aws-harness.ts";

const profile = installTestProfile();
afterAll(() => profile.restore());

const cfn = mockClient(CloudFormationClient);
beforeEach(() => cfn.reset());

const FLEET_ID = "k7m2x9qa";
const STACK = `hermetic-${FLEET_ID}`;

function foundation() {
  return new CfnFoundation(new CloudFormationClient({ region: "us-west-2" }), {
    fleetId: FLEET_ID,
    bedrockModelArns: ["arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude"],
    hermeticVersion: "0.4.1",
    pollIntervalMs: 1,
  });
}

function stack(
  status: StackStatus,
  parameters: string[] = ["FleetId", "HermeticVersion", "Network", "BedrockModelArns"],
  lastUpdatedTime?: Date,
) {
  return {
    Stacks: [
      {
        ...(lastUpdatedTime ? { LastUpdatedTime: lastUpdatedTime } : {}),
        StackId: `arn:aws:cloudformation:us-west-2:123456789012:stack/${STACK}/abc`,
        StackName: STACK,
        StackStatus: status,
        CreationTime: new Date(),
        Parameters: parameters.map((ParameterKey) => ({ ParameterKey, ParameterValue: "x" })),
        Tags: [
          { Key: "hermetic:fleet_id", Value: FLEET_ID },
          { Key: "hermetic:version", Value: "0.4.0" },
          { Key: "network", Value: "public" },
        ],
        Outputs: [{ OutputKey: "BucketName", OutputValue: "hermetic-bucket" }],
      },
    ],
  };
}

describe("createChangeSet", () => {
  test("sends this build's template, named IAM, and previous values for everything but the version", async () => {
    cfn.on(DescribeStacksCommand).resolves(stack("CREATE_COMPLETE"));
    cfn.on(CreateChangeSetCommand).resolves({ Id: "arn:changeset/abc" });

    const out = await foundation().createChangeSet({ name: "cs-1", hermeticVersion: "0.5.0" });
    expect(out.name).toBe("cs-1");

    const [input] = inputsOf<{
      StackName: string;
      ChangeSetName: string;
      ChangeSetType: string;
      TemplateBody: string;
      Capabilities: string[];
      Parameters: Array<{ ParameterKey: string; ParameterValue?: string; UsePreviousValue?: boolean }>;
    }>(cfn, CreateChangeSetCommand);
    expect(input!.StackName).toBe(STACK);
    expect(input!.ChangeSetType).toBe("UPDATE");
    expect(input!.TemplateBody).toBe(foundationTemplateBody());
    expect(input!.Capabilities).toEqual(["CAPABILITY_NAMED_IAM"]);
    expect(input!.Parameters).toEqual([
      { ParameterKey: "HermeticVersion", ParameterValue: "0.5.0" },
      { ParameterKey: "FleetId", UsePreviousValue: true },
      { ParameterKey: "Network", UsePreviousValue: true },
      { ParameterKey: "BedrockModelArns", UsePreviousValue: true },
    ]);
    // A `public` fleet has no FckNatAmiId, and CloudFormation rejects a
    // previous-value reference to a parameter that was never set.
    expect(input!.Parameters.some((p) => p.ParameterKey === "FckNatAmiId")).toBe(false);
  });

  test("re-asserts the stack's tags, because an update replaces the tag set wholesale", async () => {
    cfn.on(DescribeStacksCommand).resolves(stack("CREATE_COMPLETE"));
    cfn.on(CreateChangeSetCommand).resolves({ Id: "id" });
    await foundation().createChangeSet({ name: "cs-tags", hermeticVersion: "0.5.0" });

    const [input] = inputsOf<{ Tags: Array<{ Key: string; Value: string }> }>(
      cfn,
      CreateChangeSetCommand,
    );
    const tags = Object.fromEntries((input!.Tags ?? []).map((t) => [t.Key, t.Value]));
    /**
     * The whole point: `ExecuteChangeSet` replaces the tag set with whatever the
     * change set names, so omitting this strips `hermetic:fleet_id` — the tag
     * `guardFleet` reads on every later call — and a successful foundation
     * update ends with the fleet unreachable by its own tooling.
     */
    expect(tags["hermetic:fleet_id"]).toBe(FLEET_ID);
    expect(tags["hermetic:version"]).toBe("0.5.0");
    // Anything else the stack carried comes back too, unchanged.
    expect(tags["network"]).toBe("public");
    // …but not the bare aliases `normalizeStack` synthesises for core's guards;
    // CloudFormation never had those.
    expect(input!.Tags.some((t) => t.Key === "fleet_id")).toBe(false);
    expect(input!.Tags.some((t) => t.Key === "hermetic_version")).toBe(false);
  });

  test("reuses FckNatAmiId when the stack carries it", async () => {
    cfn
      .on(DescribeStacksCommand)
      .resolves(
        stack("CREATE_COMPLETE", [
          "FleetId",
          "HermeticVersion",
          "Network",
          "BedrockModelArns",
          "FckNatAmiId",
        ]),
      );
    cfn.on(CreateChangeSetCommand).resolves({ Id: "id" });
    await foundation().createChangeSet({ name: "cs-2", hermeticVersion: "0.4.1" });
    const [input] = inputsOf<{ Parameters: Array<{ ParameterKey: string }> }>(
      cfn,
      CreateChangeSetCommand,
    );
    expect(input!.Parameters.map((p) => p.ParameterKey)).toContain("FckNatAmiId");
  });

  test("refuses NOT_FOUND when there is no stack to update", async () => {
    const missing = new Error(`Stack with id ${STACK} does not exist`);
    missing.name = "ValidationError";
    cfn.on(DescribeStacksCommand).rejects(missing);
    await expect(
      foundation().createChangeSet({ name: "cs-3", hermeticVersion: "0.4.1" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(callCount(cfn, CreateChangeSetCommand)).toBe(0);
  });
});

describe("describeChangeSet", () => {
  test("flattens ResourceChange, pages, and keeps `Replacement` distinct from absent", async () => {
    cfn.on(DescribeStacksCommand).resolves(stack("CREATE_COMPLETE"));
    cfn
      .on(DescribeChangeSetCommand)
      .resolvesOnce({
        Status: "CREATE_COMPLETE",
        ChangeSetId: "arn:changeset/abc",
        NextToken: "page2",
        Changes: [
          {
            ResourceChange: {
              LogicalResourceId: "AgentPolicy",
              ResourceType: "AWS::IAM::Policy",
              Action: "Modify",
              Replacement: "False",
            },
          },
        ],
      })
      .resolvesOnce({
        Status: "CREATE_COMPLETE",
        ChangeSetId: "arn:changeset/abc",
        Changes: [
          {
            ResourceChange: {
              LogicalResourceId: "SnapshotPolicy",
              ResourceType: "AWS::DLM::LifecyclePolicy",
              Action: "Add",
            },
          },
        ],
      });

    const info = await foundation().describeChangeSet("cs-1");
    expect(info.status).toBe("CREATE_COMPLETE");
    expect(info.id).toBe("arn:changeset/abc");
    expect(info.changes).toEqual([
      {
        logicalId: "AgentPolicy",
        resourceType: "AWS::IAM::Policy",
        action: "Modify",
        replacement: "False",
      },
      {
        logicalId: "SnapshotPolicy",
        resourceType: "AWS::DLM::LifecyclePolicy",
        action: "Add",
        // Unset, which is not the same as "False": CloudFormation only reports
        // it for a Modify.
        replacement: null,
      },
    ]);
  });

  test("carries the reason back, which is how a no-op update is recognised", async () => {
    cfn.on(DescribeStacksCommand).resolves(stack("CREATE_COMPLETE"));
    cfn.on(DescribeChangeSetCommand).resolves({
      Status: "FAILED",
      StatusReason: "The submitted information didn't contain changes.",
    });
    const info = await foundation().describeChangeSet("cs-1");
    expect(info.status).toBe("FAILED");
    expect(info.statusReason).toContain("didn't contain changes");
    expect(info.changes).toEqual([]);
  });
});

describe("executeChangeSet", () => {
  test("does not return on the pre-update status: it waits for the stack to move", async () => {
    /**
     * The defect this pins. `ExecuteChangeSet` returns as soon as CloudFormation
     * accepts it, and the very next `DescribeStacks` still reports the stack
     * exactly as it was — `CREATE_COMPLETE`, which is both terminal and in the
     * healthy set. The waiter used to return on that first read, so the
     * artifacts, migrate and stamp phases all ran against a stack that was still
     * updating (or already rolling back).
     */
    let describes = 0;
    cfn.on(DescribeStacksCommand).callsFake(() => {
      describes += 1;
      // 1: the snapshot taken before the execute.
      // 2–3: polls that still say CREATE_COMPLETE — the stack has not moved.
      // 4+: it finally has.
      if (describes <= 3) return stack("CREATE_COMPLETE");
      if (describes <= 5) return stack("UPDATE_IN_PROGRESS");
      return stack("UPDATE_COMPLETE");
    });
    cfn.on(ExecuteChangeSetCommand).resolves({});
    cfn.on(DescribeStackEventsCommand).resolves({
      StackEvents: [
        {
          StackId: "arn:stack",
          StackName: STACK,
          EventId: "e1",
          LogicalResourceId: "AgentPolicy",
          ResourceType: "AWS::IAM::Policy",
          ResourceStatus: "UPDATE_COMPLETE",
          Timestamp: new Date(),
        },
      ],
    });

    const seen: string[] = [];
    const out = await foundation().executeChangeSet({
      name: "cs-1",
      onProgress: (p) => seen.push(...p.events.map((e) => `${e.logical_id}:${e.status}`)),
    });

    expect(out.status).toBe("UPDATE_COMPLETE");
    // It kept polling past the two CREATE_COMPLETE reads rather than believing
    // the first one.
    expect(describes).toBeGreaterThan(3);
    expect(seen).toContain("AgentPolicy:UPDATE_COMPLETE");
    expect(inputsOf<{ ChangeSetName: string }>(cfn, ExecuteChangeSetCommand)[0]!.ChangeSetName).toBe(
      "cs-1",
    );
  });

  test("a change so fast no poll saw UPDATE_IN_PROGRESS is caught by LastUpdatedTime", async () => {
    // The other half of the gate: the status is `UPDATE_COMPLETE` immediately
    // and never differs from the snapshot's… except that the snapshot was
    // `CREATE_COMPLETE`, so this case is the reverse — the status is *identical*
    // throughout and only the timestamp moves.
    let describes = 0;
    const before = new Date("2026-09-01T12:00:00.000Z");
    const after = new Date("2026-09-01T12:04:00.000Z");
    cfn.on(DescribeStacksCommand).callsFake(() => {
      describes += 1;
      return stack("UPDATE_COMPLETE", undefined, describes <= 2 ? before : after);
    });
    cfn.on(ExecuteChangeSetCommand).resolves({});
    cfn.on(DescribeStackEventsCommand).resolves({ StackEvents: [] });

    const out = await foundation().executeChangeSet({ name: "cs-1" });
    expect(out.status).toBe("UPDATE_COMPLETE");
    // Poll 1 was the snapshot; the wait did not accept the identical status
    // until the timestamp had moved.
    expect(describes).toBeGreaterThan(2);
  });

  test("UPDATE_ROLLBACK_COMPLETE is a failure here, though it is healthy elsewhere", async () => {
    let describes = 0;
    cfn.on(DescribeStacksCommand).callsFake(() => {
      describes += 1;
      // The snapshot, then a stack that has visibly moved — into a rollback.
      return describes === 1 ? stack("CREATE_COMPLETE") : stack("UPDATE_ROLLBACK_COMPLETE");
    });
    cfn.on(ExecuteChangeSetCommand).resolves({});
    cfn.on(DescribeStackEventsCommand).resolves({
      StackEvents: [
        {
          StackId: "arn:stack",
          StackName: STACK,
          EventId: "e1",
          LogicalResourceId: "AgentPolicy",
          ResourceType: "AWS::IAM::Policy",
          ResourceStatus: "UPDATE_FAILED",
          ResourceStatusReason: "the policy document is too long",
          Timestamp: new Date(),
        },
      ],
    });

    let error: unknown;
    try {
      await foundation().executeChangeSet({ name: "cs-1" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(HermeticError);
    expect((error as HermeticError).code).toBe("FOUNDATION_UPDATE_FAILED");
    expect((error as HermeticError).message).toContain("AgentPolicy");
    expect((error as HermeticError).message).toContain("the policy document is too long");

    // The same status, read by anyone else, is still a healthy stack.
    cfn.resetHistory();
    expect((await foundation().describeStack())!.status).toBe("UPDATE_ROLLBACK_COMPLETE");
  });
});

describe("deleteChangeSet", () => {
  test("names the stack alongside the change set", async () => {
    cfn.on(DescribeStacksCommand).resolves(stack("CREATE_COMPLETE"));
    cfn.on(DeleteChangeSetCommand).resolves({});
    await foundation().deleteChangeSet("cs-1");
    expect(
      inputsOf<{ StackName: string; ChangeSetName: string }>(cfn, DeleteChangeSetCommand)[0],
    ).toMatchObject({
      StackName: STACK,
      ChangeSetName: "cs-1",
    });
  });

  test("a change set that is already gone is not an error", async () => {
    cfn.on(DescribeStacksCommand).resolves(stack("CREATE_COMPLETE"));
    const missing = new Error("ChangeSet [cs-1] does not exist");
    missing.name = "ChangeSetNotFoundException";
    cfn.on(DeleteChangeSetCommand).rejects(missing);
    await foundation().deleteChangeSet("cs-1");
  });
});
