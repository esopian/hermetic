import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  DescribeInstanceStatusCommand,
  DescribeInstancesCommand,
  EC2Client,
  GetConsoleOutputCommand,
  StartInstancesCommand,
  StopInstancesCommand,
} from "@aws-sdk/client-ec2";
import { SSMClient } from "@aws-sdk/client-ssm";
import { mockClient } from "aws-sdk-client-mock";
import { Ec2Compute } from "../src/aws/ec2.ts";
import { HermeticError } from "../src/errors.ts";
import { installTestProfile } from "./aws-harness.ts";

const profile = installTestProfile();
afterAll(() => profile.restore());

const ec2 = mockClient(EC2Client);
const ssm = mockClient(SSMClient);

beforeEach(() => {
  ec2.reset();
  ssm.reset();
});

/** The fleet every filter and tag in these tests is scoped by (§5). */
const TEST_FLEET_ID = "fxtr0001";

function compute() {
  return new Ec2Compute(
    new EC2Client({ region: "us-west-2" }),
    new SSMClient({ region: "us-west-2" }),
    "us-west-2",
    async () => ({
      subnet_ids: ["subnet-aaa"],
      security_group_id: "sg-sealed",
      instance_profile_arn: "arn:aws:iam::123456789012:instance-profile/hermetic-agent",
    }),
    () => TEST_FLEET_ID,
  );
}

/**
 * The tag lookup. AWS does not enforce one instance per `agent` tag, so the
 * honest answer is a list: create's find-or-launch, recreate's stray sweep and
 * `doctor`'s `instance_duplicate` all need every match, and there is no
 * first-match variant beside it to drop the second box silently.
 */
describe("listInstancesByTag", () => {
  test("returns every live tagged instance, across pages", async () => {
    ec2
      .on(DescribeInstancesCommand)
      .resolvesOnce({
        Reservations: [{ Instances: [{ InstanceId: "i-first", State: { Name: "running" } }] }],
        NextToken: "page2",
      })
      .resolvesOnce({
        Reservations: [
          {
            Instances: [
              { InstanceId: "i-second", State: { Name: "stopped" }, PublicIpAddress: "203.0.113.7" },
            ],
          },
        ],
      });

    const out = await compute().listInstancesByTag("atlas");
    expect(out).toEqual([
      { instance_id: "i-first", state: "running", public_ip: null },
      { instance_id: "i-second", state: "stopped", public_ip: "203.0.113.7" },
    ]);

    const input = ec2.commandCalls(DescribeInstancesCommand)[0]!.args[0].input as {
      Filters?: Array<{ Name?: string; Values?: string[] }>;
    };
    expect(input.Filters?.find((f) => f.Name === "tag:agent")?.Values).toEqual(["atlas"]);
    expect(input.Filters?.find((f) => f.Name === "tag:hermetic:managed")?.Values).toEqual(["true"]);
    expect(input.Filters?.find((f) => f.Name === "instance-state-name")?.Values).not.toContain(
      "terminated",
    );
    // Without the token on the second call the first page comes back forever.
    const calls = ec2.commandCalls(DescribeInstancesCommand);
    expect(calls).toHaveLength(2);
    expect((calls[0]!.args[0].input as { NextToken?: string }).NextToken).toBeUndefined();
    expect((calls[1]!.args[0].input as { NextToken?: string }).NextToken).toBe("page2");
  });

  test("nothing live is an empty list", async () => {
    ec2.on(DescribeInstancesCommand).resolves({ Reservations: [] });
    expect(await compute().listInstancesByTag("atlas")).toEqual([]);
  });
});

/** §9: the EC2 half of `doctor`'s three-way reconciliation. */
describe("listManagedInstances", () => {
  test("filters to managed, non-terminated instances and reads the agent tag", async () => {
    ec2.on(DescribeInstancesCommand).resolves({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: "i-atlas",
              State: { Name: "running" },
              Tags: [
                { Key: "hermetic:managed", Value: "true" },
                { Key: "agent", Value: "atlas" },
              ],
            },
          ],
        },
        {
          Instances: [
            {
              InstanceId: "i-orphan",
              State: { Name: "running" },
              Tags: [{ Key: "hermetic:managed", Value: "true" }],
            },
          ],
        },
      ],
    });

    const out = await compute().listManagedInstances();
    expect(out).toEqual([
      { instance_id: "i-atlas", agent: "atlas", state: "running" },
      { instance_id: "i-orphan", agent: null, state: "running" },
    ]);
  });

  test("the query filters out terminated instances and scopes to hermetic:managed", async () => {
    ec2.on(DescribeInstancesCommand).resolves({ Reservations: [] });
    await compute().listManagedInstances();

    const calls = ec2.commandCalls(DescribeInstancesCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input as {
      Filters?: Array<{ Name?: string; Values?: string[] }>;
    };
    const managedFilter = input.Filters?.find((f) => f.Name === "tag:hermetic:managed");
    expect(managedFilter?.Values).toEqual(["true"]);
    const stateFilter = input.Filters?.find((f) => f.Name === "instance-state-name");
    expect(stateFilter?.Values).not.toContain("terminated");
    // `doctor` reasons about these: a box mid-terminate is `shutting-down`, and
    // `isDying` there exists because this query returns it.
    expect(stateFilter?.Values).toContain("shutting-down");
  });

  test("pages through NextToken", async () => {
    ec2
      .on(DescribeInstancesCommand)
      .resolvesOnce({
        Reservations: [{ Instances: [{ InstanceId: "i-1", State: { Name: "running" } }] }],
        NextToken: "page2",
      })
      .resolvesOnce({
        Reservations: [{ Instances: [{ InstanceId: "i-2", State: { Name: "stopped" } }] }],
      });

    const out = await compute().listManagedInstances();
    expect(out.map((i) => i.instance_id)).toEqual(["i-1", "i-2"]);

    // Without the token on the second call the first page comes back forever.
    const calls = ec2.commandCalls(DescribeInstancesCommand);
    expect(calls).toHaveLength(2);
    expect((calls[0]!.args[0].input as { NextToken?: string }).NextToken).toBeUndefined();
    expect((calls[1]!.args[0].input as { NextToken?: string }).NextToken).toBe("page2");
  });
});

/**
 * The log source that needs nothing from the box (§6.3). EC2 buffers nothing
 * for the first minute or two of a boot and nothing at all for an instance that
 * never printed, so "not yet" has to be an answer rather than a failure — the
 * caller's job is to say the box has been silent, not to error.
 */
describe("consoleOutput", () => {
  // EC2 returns the serial buffer base64-encoded and the JS SDK does not decode
  // it — only the `aws` CLI does — so the mock speaks base64 and the assertion
  // is on plain text. Without the decode this test would see one long blob.
  test("returns the decoded buffer and EC2's own timestamp", async () => {
    const at = new Date("2026-09-04T15:05:58.000Z");
    const text = "cloud-init: OK\nFAILED Failed to start hermeticd-bootstrap.service.";
    ec2.on(GetConsoleOutputCommand).resolves({
      Output: Buffer.from(text, "utf8").toString("base64"),
      Timestamp: at,
    });
    const out = await compute().consoleOutput("i-1");
    expect(out?.at).toBe(at.toISOString());
    expect(out?.output).toBe(text);
    expect(ec2.commandCalls(GetConsoleOutputCommand)[0]!.args[0].input).toEqual({
      InstanceId: "i-1",
      Latest: true,
    });
  });

  test("an empty or whitespace-only buffer is `nothing yet`, not an empty log", async () => {
    ec2.on(GetConsoleOutputCommand).resolves({
      Output: Buffer.from("   \n  ", "utf8").toString("base64"),
    });
    expect(await compute().consoleOutput("i-1")).toBeNull();
    ec2.on(GetConsoleOutputCommand).resolves({});
    expect(await compute().consoleOutput("i-1")).toBeNull();
  });

  test("an instance EC2 has forgotten is null, not a throw", async () => {
    const gone = Object.assign(new Error("no such instance"), {
      name: "InvalidInstanceID.NotFound",
    });
    ec2.on(GetConsoleOutputCommand).rejects(gone);
    expect(await compute().consoleOutput("i-gone")).toBeNull();
  });

  test("any other failure is a HermeticError naming the instance", async () => {
    ec2
      .on(GetConsoleOutputCommand)
      .rejects(Object.assign(new Error("nope"), { name: "UnauthorizedOperation" }));
    expect(compute().consoleOutput("i-1")).rejects.toThrow(/i-1/);
  });
});

/**
 * `DescribeInstanceStatus` — the EC2 half of `agents.probe` (§9). It is a
 * separate call from `DescribeInstances` because it answers a separate
 * question: not where the instance is in its lifecycle, but whether EC2 thinks
 * the hypervisor and the guest are well.
 */
describe("describeInstanceStatus", () => {
  test("asks with IncludeAllInstances, so a stopped box answers at all", async () => {
    let sent: unknown = null;
    ec2.on(DescribeInstanceStatusCommand).callsFake((input: unknown) => {
      sent = input;
      return {
        InstanceStatuses: [{ InstanceId: "i-stopped", InstanceState: { Name: "stopped" } }],
      };
    });

    const out = await compute().describeInstanceStatus("i-stopped");
    // Without the flag EC2 filters to `running`, and "stopped" and "gone" become
    // the same empty response — which is the distinction the probe exists for.
    expect(sent).toMatchObject({ InstanceIds: ["i-stopped"], IncludeAllInstances: true });
    expect(out).toEqual({
      instance_id: "i-stopped",
      state: "stopped",
      // EC2 has no opinion about a box that is not on; that absence is data.
      system_status: null,
      instance_status: null,
    });
  });

  test("carries both check summaries verbatim", async () => {
    ec2.on(DescribeInstanceStatusCommand).resolves({
      InstanceStatuses: [
        {
          InstanceId: "i-sick",
          InstanceState: { Name: "running" },
          SystemStatus: { Status: "ok" },
          InstanceStatus: { Status: "impaired" },
        },
      ],
    });

    expect(await compute().describeInstanceStatus("i-sick")).toEqual({
      instance_id: "i-sick",
      state: "running",
      system_status: "ok",
      instance_status: "impaired",
    });
  });

  test("an id EC2 knows nothing about is null, not a throw", async () => {
    ec2.on(DescribeInstanceStatusCommand).resolves({ InstanceStatuses: [] });
    expect(await compute().describeInstanceStatus("i-nope")).toBeNull();
  });

  test("an InvalidInstanceID.NotFound is `gone`, the same reading describeInstance takes", async () => {
    const notFound = Object.assign(new Error("not found"), {
      name: "InvalidInstanceID.NotFound",
    });
    ec2.on(DescribeInstanceStatusCommand).rejects(notFound);
    expect(await compute().describeInstanceStatus("i-vanished")).toBeNull();
  });
});

/**
 * The two instance verbs whose SDK throw used to escape raw. Every other call
 * in `ec2.ts` wraps with `asHermeticError`, and `ec2-preconditions.ts` makes
 * the memory double refuse in that same shape — `INTERNAL` carrying EC2's
 * error name in `details.aws_error`. A caller that reads `aws_error` to decide
 * whether to retry needs both sides to agree, so a raw `IncorrectInstanceState`
 * from the real client is a branch core never takes against the double.
 */
describe("stop and start", () => {
  function incorrectState(instanceId: string) {
    return Object.assign(
      new Error(`The instance '${instanceId}' is not in a state from which it can be started.`),
      { name: "IncorrectInstanceState" },
    );
  }

  test("stop and start turn an SDK failure into a HermeticError like every other call", async () => {
    ec2.on(StopInstancesCommand).rejects(incorrectState("i-going"));
    ec2.on(StartInstancesCommand).rejects(incorrectState("i-going"));

    for (const [verb, call] of [
      ["stop", () => compute().stop("i-going")],
      ["start", () => compute().start("i-going")],
    ] as const) {
      const thrown = await call().then(
        () => null,
        (e: unknown) => e,
      );
      expect(thrown).toBeInstanceOf(HermeticError);
      const err = thrown as HermeticError;
      expect(err.code).toBe("INTERNAL");
      expect(err.message).toStartWith(`could not ${verb} instance i-going: `);
      expect(err.details).toMatchObject({ aws_error: "IncorrectInstanceState" });
    }
  });

  test("an instance EC2 has never heard of is a HermeticError too, not a swallowed miss", async () => {
    const gone = Object.assign(new Error("The instance ID 'i-gone' does not exist."), {
      name: "InvalidInstanceID.NotFound",
    });
    ec2.on(StopInstancesCommand).rejects(gone);
    ec2.on(StartInstancesCommand).rejects(gone);

    // Unlike `terminate`, where a forgotten instance is the goal, a stop or a
    // start of an id EC2 does not know is a failure the caller has to see.
    for (const call of [() => compute().stop("i-gone"), () => compute().start("i-gone")]) {
      const thrown = await call().then(
        () => null,
        (e: unknown) => e,
      );
      expect(thrown).toBeInstanceOf(HermeticError);
      expect((thrown as HermeticError).details).toMatchObject({
        aws_error: "InvalidInstanceID.NotFound",
      });
    }
  });
});
