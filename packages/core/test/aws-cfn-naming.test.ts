/**
 * §5: every foundation resource is named for its stack, and the stack is named
 * for its fleet — `hermetic-<fleet_id>`. Two fleets in one account share no
 * name, so a leftover from one can never block or be reached by the other.
 *
 * The other half of the contract is finding a foundation again once the name is
 * no longer a constant: by the name the fleet id implies, and failing that, by
 * hermetic's own stack tag — which is what still finds a pre-rename `hermetic`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  CloudFormationClient,
  CreateStackCommand,
  DescribeStacksCommand,
  type Stack,
} from "@aws-sdk/client-cloudformation";
import { mockClient } from "aws-sdk-client-mock";
import { CfnFoundation, listHermeticStacks } from "../src/aws/cfn.ts";
import {
  STACK_NAME,
  isHermeticStackName,
  stackNameFor,
  stackNameFromId,
  tablesFor,
} from "../src/schema/index.ts";

const cfn = mockClient(CloudFormationClient);
afterEach(() => cfn.reset());

const FLEET = "fxtr0001";

function foundation(fleetId?: string) {
  return new CfnFoundation(new CloudFormationClient({ region: "us-east-1" }), {
    ...(fleetId !== undefined ? { fleetId } : {}),
    bedrockModelArns: ["arn:aws:bedrock:us-east-1::foundation-model/x"],
    hermeticVersion: "0.4.1",
    pollIntervalMs: 1,
  });
}

function stackNamed(
  name: string,
  tags: Array<{ Key: string; Value: string }> = [],
  status: Stack["StackStatus"] = "CREATE_COMPLETE",
): Stack {
  return {
    StackId: `arn:aws:cloudformation:us-east-1:123456789012:stack/${name}/abc`,
    StackName: name,
    StackStatus: status,
    CreationTime: new Date("2026-09-01T00:00:00.000Z"),
    Tags: tags,
    Outputs: [{ OutputKey: "AgentsTable", OutputValue: `${name}-agents` }],
  };
}

/**
 * CloudFormation, as far as these tests are concerned: a named lookup answers
 * only for a stack of that name, and a nameless one lists everything — which is
 * exactly the distinction the resolution path turns on.
 */
function answer(stacks: Record<string, Stack>): void {
  cfn.on(DescribeStacksCommand).callsFake((input: { StackName?: string }) => {
    if (input.StackName === undefined) return { Stacks: Object.values(stacks) };
    const one = stacks[input.StackName];
    if (!one) throw new Error(`Stack with id ${input.StackName} does not exist`);
    return { Stacks: [one] };
  });
}

describe("names derived from the fleet id", () => {
  test("the stack, and therefore the tables, carry the fleet id", () => {
    expect(stackNameFor(FLEET)).toBe("hermetic-fxtr0001");
    expect(tablesFor(stackNameFor(FLEET))).toEqual({
      agents: "hermetic-fxtr0001-agents",
      events: "hermetic-fxtr0001-events",
    });
  });

  test("a pre-rename fleet's names are recovered from its stack, not assumed", () => {
    // `_fleet.stack_id` is the ARN, and the name inside it is the truth.
    expect(stackNameFromId("arn:aws:cloudformation:us-east-1:1:stack/hermetic/uuid")).toBe("hermetic");
    expect(tablesFor("hermetic")).toEqual({ agents: "hermetic-agents", events: "hermetic-events" });
    // A malformed or absent ARN falls back to the pre-rename name rather than
    // inventing one: that is the only stack that could have had no fleet in it.
    expect(stackNameFromId("")).toBe(STACK_NAME);
  });

  test("both name shapes are recognised as hermetic's", () => {
    expect(isHermeticStackName("hermetic")).toBe(true);
    expect(isHermeticStackName("hermetic-fxtr0001")).toBe(true);
    // The prefix must be followed by the separator: this is somebody else's.
    expect(isHermeticStackName("hermetically-sealed-app")).toBe(false);
    expect(isHermeticStackName("some-app")).toBe(false);
  });
});

describe("createStack", () => {
  test("creates `hermetic-<fleet_id>`, never a shared name", async () => {
    cfn.on(CreateStackCommand).resolves({ StackId: "arn:stack/x/1" });
    cfn.on(DescribeStacksCommand).resolves({ Stacks: [stackNamed(stackNameFor(FLEET))] });

    await foundation(FLEET).createStack({ fleet_id: FLEET, network: "public", tags: {} });

    const input = cfn.commandCalls(CreateStackCommand)[0]!.args[0].input as { StackName: string };
    expect(input.StackName).toBe("hermetic-fxtr0001");
  });
});

describe("finding the foundation again", () => {
  test("the fleet-scoped name is one call, and no scan", async () => {
    answer({ [stackNameFor(FLEET)]: stackNamed(stackNameFor(FLEET)) });

    const stack = await foundation(FLEET).describeStack();
    expect(stack?.stack_name).toBe("hermetic-fxtr0001");
    expect(cfn.commandCalls(DescribeStacksCommand)).toHaveLength(1);
  });

  test("a pre-rename stack is found by its fleet tag", async () => {
    answer({ hermetic: stackNamed(STACK_NAME, [{ Key: "hermetic:fleet_id", Value: FLEET }]) });

    const stack = await foundation(FLEET).describeStack();
    expect(stack?.stack_name).toBe("hermetic");
    // Its tables are the pre-rename ones, and the stack says so itself.
    expect(stack?.outputs["AgentsTable"]).toBe("hermetic-agents");
  });

  test("another fleet's stack is not this fleet's foundation", async () => {
    answer({
      "hermetic-other123": stackNamed("hermetic-other123", [
        { Key: "hermetic:fleet_id", Value: "other123" },
      ]),
    });

    expect(await foundation(FLEET).describeStack()).toBeNull();
  });

  test("a backend with no fleet yet — what `init` holds — finds the one foundation there is", async () => {
    answer({
      "hermetic-live0001": stackNamed("hermetic-live0001", [
        { Key: "hermetic:fleet_id", Value: "live0001" },
      ]),
    });

    expect((await foundation().describeStack())?.stack_name).toBe("hermetic-live0001");
  });
});

describe("listHermeticStacks", () => {
  test("skips other people's stacks and stacks CloudFormation has already reaped", async () => {
    cfn.on(DescribeStacksCommand).resolves({
      Stacks: [
        stackNamed("some-app", [{ Key: "team", Value: "platform" }]),
        stackNamed(
          "hermetic-gone0001",
          [{ Key: "hermetic:fleet_id", Value: "gone0001" }],
          "DELETE_COMPLETE",
        ),
        stackNamed("hermetic-live0001", [{ Key: "hermetic:fleet_id", Value: "live0001" }]),
      ],
    });

    const found = await listHermeticStacks(new CloudFormationClient({ region: "us-east-1" }));
    expect(found.map((s) => s.stack_name)).toEqual(["hermetic-live0001"]);
  });

  test("pages until CloudFormation stops handing out a token", async () => {
    cfn
      .on(DescribeStacksCommand, { NextToken: undefined })
      .resolves({ Stacks: [stackNamed("some-app")], NextToken: "page2" })
      .on(DescribeStacksCommand, { NextToken: "page2" })
      .resolves({
        Stacks: [stackNamed("hermetic-live0001", [{ Key: "hermetic:fleet_id", Value: "live0001" }])],
      });

    const found = await listHermeticStacks(new CloudFormationClient({ region: "us-east-1" }));
    expect(found.map((s) => s.stack_name)).toEqual(["hermetic-live0001"]);
  });
});
