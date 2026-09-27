/**
 * The CloudFormation waiter narrates (§4.7): resource events per poll, oldest
 * first and never twice; a failure that names the resource and its reason; and
 * a missing `DescribeStackEvents` permission that degrades to heartbeats.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  CloudFormationClient,
  CreateStackCommand,
  DescribeStackEventsCommand,
  DescribeStacksCommand,
  type StackEvent,
} from "@aws-sdk/client-cloudformation";
import { mockClient } from "aws-sdk-client-mock";
import { CfnFoundation } from "../src/aws/cfn.ts";
import type { StackProgress } from "../src/backend/types.ts";
import { HermeticError } from "../src/errors.ts";

const cfn = mockClient(CloudFormationClient);
afterEach(() => cfn.reset());

function foundation() {
  return new CfnFoundation(new CloudFormationClient({ region: "us-east-1" }), {
    bedrockModelArns: ["arn:aws:bedrock:us-east-1::foundation-model/x"],
    hermeticVersion: "0.4.1",
    pollIntervalMs: 1,
  });
}
const stack = (status: string) => ({
  Stacks: [
    {
      StackId: "arn:stack/hermetic/1",
      StackName: "hermetic",
      StackStatus: status,
      CreationTime: new Date(),
      Tags: [],
      Outputs: [],
    },
  ],
});
const ev = (
  id: string,
  logical: string,
  status: string,
  reason?: string,
  type = "AWS::EC2::VPC",
): StackEvent => ({
  EventId: id,
  StackId: "arn:stack/hermetic/1",
  StackName: "hermetic",
  LogicalResourceId: logical,
  ResourceType: type,
  ResourceStatus: status as StackEvent["ResourceStatus"],
  ...(reason ? { ResourceStatusReason: reason } : {}),
  Timestamp: new Date(`2026-09-02T00:00:0${id.length % 10}Z`),
});

describe("createStack narrates", () => {
  test("resource events arrive per poll, oldest first, each once; the stack's own events are skipped", async () => {
    cfn.on(CreateStackCommand).resolves({ StackId: "arn:stack/hermetic/1" });
    let poll = 0;
    cfn
      .on(DescribeStacksCommand)
      .callsFake(() => stack(++poll >= 3 ? "CREATE_COMPLETE" : "CREATE_IN_PROGRESS"));
    // Newest first, as the API returns them; page 2 on the second poll carries the stack's own event too.
    const pages = [
      {
        StackEvents: [
          ev("e2", "Vpc", "CREATE_COMPLETE"),
          ev("e1", "Vpc", "CREATE_IN_PROGRESS"),
          ev("e0", "hermetic", "CREATE_IN_PROGRESS", undefined, "AWS::CloudFormation::Stack"),
        ],
      },
      {
        StackEvents: [
          ev("e3", "Bucket", "CREATE_IN_PROGRESS", undefined, "AWS::S3::Bucket"),
          ev("e2", "Vpc", "CREATE_COMPLETE"),
          ev("e1", "Vpc", "CREATE_IN_PROGRESS"),
        ],
      },
      {
        StackEvents: [
          ev("e4", "Bucket", "CREATE_COMPLETE", undefined, "AWS::S3::Bucket"),
          ev("e3", "Bucket", "CREATE_IN_PROGRESS", undefined, "AWS::S3::Bucket"),
        ],
      },
    ];
    let page = 0;
    cfn.on(DescribeStackEventsCommand).callsFake(() => pages[Math.min(page++, pages.length - 1)]);

    const seen: StackProgress[] = [];
    await foundation().createStack({
      fleet_id: "f",
      network: "public",
      tags: {},
      onProgress: (p) => seen.push(p),
    });
    expect(seen.length).toBe(3);
    expect(seen.map((p) => p.events.map((e) => `${e.logical_id}:${e.status}`))).toEqual([
      ["Vpc:CREATE_IN_PROGRESS", "Vpc:CREATE_COMPLETE"],
      ["Bucket:CREATE_IN_PROGRESS"],
      ["Bucket:CREATE_COMPLETE"],
    ]);
    expect(seen.every((p) => p.events_available)).toBe(true);
    expect(seen[2]!.status).toBe("CREATE_COMPLETE");
  });

  test("a rollback names the first resource that failed and CloudFormation's reason", async () => {
    cfn.on(CreateStackCommand).resolves({ StackId: "arn:stack/hermetic/1" });
    let poll = 0;
    cfn
      .on(DescribeStacksCommand)
      .callsFake(() => stack(++poll >= 2 ? "ROLLBACK_COMPLETE" : "CREATE_IN_PROGRESS"));
    cfn.on(DescribeStackEventsCommand).resolves({
      StackEvents: [
        ev("e3", "Bucket", "CREATE_FAILED", "Resource creation cancelled", "AWS::S3::Bucket"),
        ev(
          "e2",
          "AgentRole",
          "CREATE_FAILED",
          "hermetic-agent already exists in stack arn:other",
          "AWS::IAM::Role",
        ),
        ev("e1", "Vpc", "CREATE_COMPLETE"),
      ],
    });
    let err: unknown;
    try {
      await foundation().createStack({ fleet_id: "f", network: "public", tags: {} });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HermeticError);
    const he = err as HermeticError;
    expect(he.message).toContain("ROLLBACK_COMPLETE");
    expect(he.message).toContain(
      "AgentRole (AWS::IAM::Role) CREATE_FAILED: hermetic-agent already exists",
    );
    expect(he.message).not.toContain("cancelled");
    expect(he.details).toMatchObject({ failed_resource: "AgentRole", failed_type: "AWS::IAM::Role" });
  });

  test("no permission for DescribeStackEvents degrades to heartbeats and says so on failure", async () => {
    cfn.on(CreateStackCommand).resolves({ StackId: "arn:stack/hermetic/1" });
    let poll = 0;
    cfn
      .on(DescribeStacksCommand)
      .callsFake(() => stack(++poll >= 3 ? "CREATE_COMPLETE" : "CREATE_IN_PROGRESS"));
    cfn.on(DescribeStackEventsCommand).rejects(new Error("AccessDenied"));
    const seen: StackProgress[] = [];
    await foundation().createStack({
      fleet_id: "f",
      network: "public",
      tags: {},
      onProgress: (p) => seen.push(p),
    });
    expect(seen.length).toBe(3);
    expect(seen.every((p) => p.events.length === 0 && p.events_available === false)).toBe(true);
    // Asked once, then never again.
    expect(cfn.commandCalls(DescribeStackEventsCommand).length).toBe(1);
  });
});
