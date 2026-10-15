/**
 * §7.1's snapshot policy against the real `CfnFoundation`: the change set that
 * moves it states its three parameters and keeps everything else, and the two
 * sibling change sets carry it forward — but only on a stack that has it,
 * because `UsePreviousValue` on a parameter the stack never had is an error
 * CloudFormation raises before doing anything.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  CloudFormationClient,
  CreateChangeSetCommand,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import { mockClient } from "aws-sdk-client-mock";
import { CfnFoundation } from "../src/aws/cfn.ts";
import { inputsOf, installTestProfile } from "./aws-harness.ts";

const profile = installTestProfile();
afterAll(() => profile.restore());

const cfn = mockClient(CloudFormationClient);
beforeEach(() => cfn.reset());

const FLEET_ID = "k7m2x9qa";
const STACK = `hermetic-${FLEET_ID}`;
const POLICY_PARAMS = [
  { ParameterKey: "SnapshotsEnabled", ParameterValue: "true" },
  { ParameterKey: "SnapshotRetainCount", ParameterValue: "7" },
  { ParameterKey: "SnapshotIntervalHours", ParameterValue: "24" },
];

function foundation() {
  return new CfnFoundation(new CloudFormationClient({ region: "us-west-2" }), {
    fleetId: FLEET_ID,
    bedrockModelArns: ["arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude"],
    hermeticVersion: "0.4.1",
    pollIntervalMs: 1,
  });
}

function stack(withPolicy: boolean) {
  return {
    Stacks: [
      {
        StackId: `arn:aws:cloudformation:us-west-2:123456789012:stack/${STACK}/abc`,
        StackName: STACK,
        StackStatus: "UPDATE_COMPLETE" as const,
        CreationTime: new Date(),
        Parameters: [
          { ParameterKey: "FleetId", ParameterValue: FLEET_ID },
          { ParameterKey: "HermeticVersion", ParameterValue: "0.4.0" },
          { ParameterKey: "Network", ParameterValue: "public" },
          { ParameterKey: "BedrockModelArns", ParameterValue: "arn:x" },
          ...(withPolicy ? POLICY_PARAMS : []),
        ],
        Tags: [{ Key: "hermetic:fleet_id", Value: FLEET_ID }],
        Outputs: [],
      },
    ],
  };
}

type Params = Array<{ ParameterKey: string; ParameterValue?: string; UsePreviousValue?: boolean }>;
const paramsOf = () => inputsOf<{ Parameters: Params }>(cfn, CreateChangeSetCommand)[0]!.Parameters;

describe("createSnapshotChangeSet", () => {
  test("states the three policy parameters and keeps every other one", async () => {
    cfn.on(DescribeStacksCommand).resolves(stack(true));
    cfn.on(CreateChangeSetCommand).resolves({ Id: "id" });
    await foundation().createSnapshotChangeSet({
      name: "cs-snap",
      hermeticVersion: "0.5.0",
      policy: { enabled: false, retain: 3, interval_hours: 12 },
    });
    const p = paramsOf();
    expect(p).toContainEqual({ ParameterKey: "SnapshotsEnabled", ParameterValue: "false" });
    expect(p).toContainEqual({ ParameterKey: "SnapshotRetainCount", ParameterValue: "3" });
    expect(p).toContainEqual({ ParameterKey: "SnapshotIntervalHours", ParameterValue: "12" });
    for (const k of ["FleetId", "Network", "BedrockModelArns"]) {
      expect(p).toContainEqual({ ParameterKey: k, UsePreviousValue: true });
    }
    expect(p.some((x) => x.ParameterKey === "FckNatAmiId")).toBe(false);
  });
});

describe("the sibling change sets carry the policy forward", () => {
  test("a foundation update and a re-network keep a stack's policy", async () => {
    cfn.on(DescribeStacksCommand).resolves(stack(true));
    cfn.on(CreateChangeSetCommand).resolves({ Id: "id" });
    await foundation().createChangeSet({ name: "cs-upd", hermeticVersion: "0.5.0" });
    await foundation().createNetworkChangeSet({
      name: "cs-net",
      hermeticVersion: "0.5.0",
      network: "public",
    });
    for (const input of inputsOf<{ Parameters: Params }>(cfn, CreateChangeSetCommand)) {
      for (const { ParameterKey } of POLICY_PARAMS) {
        expect(input.Parameters).toContainEqual({ ParameterKey, UsePreviousValue: true });
      }
    }
  });

  test("on a stack from before v16 they name none of them, so the defaults apply", async () => {
    cfn.on(DescribeStacksCommand).resolves(stack(false));
    cfn.on(CreateChangeSetCommand).resolves({ Id: "id" });
    await foundation().createChangeSet({ name: "cs-upd", hermeticVersion: "0.5.0" });
    expect(paramsOf().some((x) => x.ParameterKey.startsWith("Snapshot"))).toBe(false);
  });
});

describe("one DescribeStacks per change set", () => {
  test("presence is read off the stack the change set was built from", async () => {
    cfn.on(DescribeStacksCommand).resolves(stack(true));
    cfn.on(CreateChangeSetCommand).resolves({ Id: "id" });
    await foundation().createNetworkChangeSet({
      name: "cs-nat",
      hermeticVersion: "0.5.0",
      network: "nat",
      fckNatAmiId: "ami-0fcknat",
    });
    expect(cfn.commandCalls(DescribeStacksCommand).length).toBe(1);
    for (const { ParameterKey } of POLICY_PARAMS) {
      expect(paramsOf()).toContainEqual({ ParameterKey, UsePreviousValue: true });
    }
  });

  test("a stack that cannot be read refuses the change set instead of dropping the policy", async () => {
    cfn.on(DescribeStacksCommand).rejects(new Error("Rate exceeded"));
    cfn.on(CreateChangeSetCommand).resolves({ Id: "id" });
    await expect(
      foundation().createChangeSet({ name: "cs-upd", hermeticVersion: "0.5.0" }),
    ).rejects.toThrow();
    expect(cfn.commandCalls(CreateChangeSetCommand).length).toBe(0);
  });
});
