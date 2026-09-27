import { describe, expect, test } from "bun:test";
import {
  foundationResourceCount,
  foundationTemplate,
  foundationTemplateBody,
} from "../src/aws/cfn-template.ts";
import { STACK_NAME } from "../src/schema/index.ts";
import { FLEET_ID_TAG, ROLE_DATA, ROLE_TAG, VERSION_TAG } from "../src/backend/constants.ts";

const template = foundationTemplate();

type Statement = {
  Sid?: string;
  Effect?: string;
  Action?: string | string[];
  Resource?: unknown;
  Condition?: Record<string, Record<string, unknown>>;
};

function agentStatements(): Statement[] {
  const role = template.Resources["AgentRole"] as {
    Properties: { Policies: Array<{ PolicyDocument: { Statement: Statement[] } }> };
  };
  return role.Properties.Policies[0]!.PolicyDocument.Statement;
}

// ── effective permissions ──────────────────────────────────────────────────
//
// The helpers below answer "may this role do X to Y", over *everything*
// attached to the role rather than one statement at a time. That distinction is
// the whole reason they exist: until foundation v12 the role also attached
// `AmazonSSMManagedInstanceCore`, which allows `ssm:GetParameter` on
// `Resource: "*"`, and IAM unions an attached policy with an inline one — so
// every per-statement assertion about `FleetParameters` passed while a box
// could in fact read any parameter in the account.

/** Fixture values for the pseudo-parameters and template parameters a policy's ARNs interpolate. */
const SUBSTITUTIONS: Record<string, string> = {
  "AWS::Partition": "aws",
  "AWS::Region": "us-east-1",
  "AWS::AccountId": "000000000000",
  "AWS::StackName": "hermetic",
  FleetId: "fxtr0001",
};

/** A second fleet in the same account, to check this role cannot reach into its tree. */
const OTHER_FLEET = "sg7k2m4p";

/**
 * One policy resource, rendered the way IAM would see it for the fixture fleet.
 *
 * A `Ref`/`GetAtt` this test does not resolve becomes a sentinel that matches
 * no ARN pattern — every assertion below is about SSM, and the unresolved ones
 * are the bucket and the Bedrock model list.
 */
function renderResource(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = value as Record<string, unknown>;
  const template_ = rec["Fn::Sub"];
  if (typeof template_ === "string") {
    return asIam(template_).replace(/\$\{([^}]+)\}/g, (whole, name: string) =>
      name in SUBSTITUTIONS ? SUBSTITUTIONS[name]! : whole,
    );
  }
  if (typeof rec["Ref"] === "string") return `<unresolved:${rec["Ref"]}>`;
  if (Array.isArray(rec["Fn::GetAtt"])) return `<unresolved:${rec["Fn::GetAtt"].join(".")}>`;
  return `<unresolved:${JSON.stringify(value)}>`;
}

/** IAM's `*` and `?` wildcards, over an already-rendered pattern. */
function wildcardMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", ".*").replaceAll("?", ".")}$`).test(value);
}

function asList(value: unknown): unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Does anything attached to `AgentRole` allow `action` on `arn`?
 *
 * Deliberately conservative in two directions, so a "not allowed" assertion is
 * never weaker than reality. A statement carrying a `Condition` still counts as
 * an allow — the test does not evaluate conditions — and a `ManagedPolicyArns`
 * entry fails outright rather than being ignored, because this test cannot see
 * a managed policy's contents and must not report a bound it did not check.
 */
function roleAllows(action: string, arn: string): boolean {
  const role = template.Resources["AgentRole"] as {
    Properties: {
      ManagedPolicyArns?: unknown;
      Policies: Array<{ PolicyDocument: { Statement: Statement[] } }>;
    };
  };
  expect(
    role.Properties.ManagedPolicyArns,
    "AgentRole attaches a managed policy, whose contents this test cannot read — state the permissions inline instead (§5.1)",
  ).toBeUndefined();
  return role.Properties.Policies.some((p) =>
    p.PolicyDocument.Statement.some(
      (s) =>
        s.Effect === "Allow" &&
        asList(s.Action).some((a) => wildcardMatches(String(a), action)) &&
        asList(s.Resource).some((r) => wildcardMatches(renderResource(r), arn)),
    ),
  );
}

/** An SSM parameter ARN in the fixture account, for a parameter path. */
function parameterArn(path: string): string {
  return `arn:aws:ssm:us-east-1:000000000000:parameter${path}`;
}

function statement(sid: string): Statement {
  const found = agentStatements().find((s) => s.Sid === sid);
  expect(found).toBeDefined();
  return found!;
}

/** What IAM sees after CloudFormation resolves `Fn::Sub`'s `${!x}` escape to `${x}`. */
function asIam(json: string): string {
  return json.replaceAll("${!", "${");
}

/** Every `Fn::Sub` string in the template, wherever it sits. */
function subStrings(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value))
    value.forEach((v) => {
      subStrings(v, out);
    });
  else if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    if (typeof rec["Fn::Sub"] === "string") out.push(rec["Fn::Sub"]);
    else
      Object.values(rec).forEach((v) => {
        subStrings(v, out);
      });
  }
  return out;
}

describe("the foundation template", () => {
  test("is valid JSON and round-trips", () => {
    const body = foundationTemplateBody();
    expect(() => JSON.parse(body)).not.toThrow();
    expect(JSON.parse(body)).toEqual(JSON.parse(JSON.stringify(template)));
    expect(template.AWSTemplateFormatVersion).toBe("2010-09-09");
  });

  test("the stack is always named hermetic, one per account (§5)", () => {
    expect(STACK_NAME).toBe("hermetic");
  });

  /** §5, §11.3: the inbound boundary, and the reason `create` can refuse. */
  test("the agent security group has no inbound rules at all", () => {
    const sg = template.Resources["AgentSecurityGroup"] as {
      Properties: Record<string, unknown>;
    };
    expect(sg.Properties["SecurityGroupIngress"]).toBeUndefined();
    // Not an empty list either — the property is absent.
    expect(Object.keys(sg.Properties)).not.toContain("SecurityGroupIngress");
    // Outbound is open, in both address families.
    expect(sg.Properties["SecurityGroupEgress"]).toHaveLength(2);
  });

  test("only the optional fck-nat group has any ingress, and only from the VPC", () => {
    const withIngress = Object.entries(template.Resources).filter(
      ([, r]) => (r["Properties"] as Record<string, unknown> | undefined)?.["SecurityGroupIngress"],
    );
    expect(withIngress.map(([name]) => name)).toEqual(["NatSecurityGroup"]);
    expect(template.Resources["NatSecurityGroup"]!["Condition"]).toBe("IsNat");
  });

  /** §5.1: one role for the whole fleet, scoped to the fleet's own resources. */
  describe("the fleet-scoped agent policy", () => {
    /**
     * The regression this locks down. Every statement used to be conditioned on
     * `${aws:PrincipalTag/agent}`, sourced from the instance's `agent=<name>`
     * tag — but EC2 instance tags are not principal tags, so the variable
     * resolved to nothing and *every* statement was an implicit deny. A first
     * boot died on `dynamodb:GetItem` and could not report why, because
     * reporting is a row write. Until per-agent roles exist, no statement in
     * this policy may depend on that variable.
     */
    test("no statement depends on ${aws:PrincipalTag/agent}", () => {
      expect(asIam(JSON.stringify(agentStatements()))).not.toContain("aws:PrincipalTag/agent");
    });

    test("SSM is scoped to this fleet's own /hermes/ prefix, and nothing under /hermetic/", () => {
      const s = statement("FleetParameters");
      const resource = asIam(JSON.stringify(s.Resource));
      // The fleet id is the whole point: `parameter/hermes/*` handed every box
      // in this fleet the *other* fleet's auth keys and provider keys (§8.2).
      expect(resource).toContain("parameter/hermes/${FleetId}/*");
      expect(resource).not.toContain("parameter/hermes/*");
      // Nothing under `/hermetic/`: an agent never reads a shared slot or the
      // fleet's OAuth client — the laptop copies a shared key into that agent's
      // own `/hermes/` slot instead (§8.3).
      expect(resource).not.toContain("parameter/hermetic");
      expect(s.Condition).toBeUndefined();
    });

    /**
     * The failure this guards: `${aws:PrincipalTag/agent}` written bare inside
     * an `Fn::Sub` string is rejected at CreateStack with "variable names in
     * Fn::Sub syntax must contain only alphanumeric characters, underscores,
     * periods, and colons" — after `init` has already verified the account and
     * preflighted Tailscale. Every Sub variable must be a legal name or the
     * `${!literal}` escape.
     */
    test("every Fn::Sub variable is a legal name or an escaped literal", () => {
      const subs = subStrings(JSON.parse(foundationTemplateBody()));
      expect(subs.length).toBeGreaterThan(5);
      for (const s of subs) {
        for (const [, name] of s.matchAll(/\$\{([^}]*)\}/g)) {
          expect(name, `in Fn::Sub ${JSON.stringify(s)}`).toMatch(/^(![^}]+|[A-Za-z0-9_.:]+)$/);
        }
      }
    });

    test("DynamoDB is limited to the fleet's two tables, by key", () => {
      const s = statement("FleetRows");
      expect(JSON.stringify(s.Resource)).toContain("AgentsTable");
      expect(JSON.stringify(s.Resource)).toContain("EventsTable");
      expect(s.Condition).toBeUndefined();
    });

    test("S3 is scoped to config/* with artifacts read-only", () => {
      expect(asIam(JSON.stringify(statement("FleetConfigPrefix").Resource))).toContain("config/*");
      const artifacts = statement("ReadArtifacts");
      expect(artifacts.Action).toEqual(["s3:GetObject"]);
      expect(JSON.stringify(artifacts.Resource)).toContain("artifacts/*");
    });

    test("bedrock invocation is limited to the ARNs passed in as a parameter", () => {
      expect(statement("Bedrock").Resource).toEqual({ Ref: "BedrockModelArns" });
      expect(template.Parameters["BedrockModelArns"]!["Type"]).toBe("CommaDelimitedList");
    });

    test("nothing in the policy grants an agent a view of the fleet", () => {
      const actions = agentStatements().flatMap((s) =>
        typeof s.Action === "string" ? [s.Action] : (s.Action ?? []),
      );
      expect(actions).not.toContain("dynamodb:Scan");
      expect(actions).not.toContain("ec2:RunInstances");
      expect(actions).not.toContain("ssm:PutParameter");
    });

    /**
     * §5.1, foundation v12. The one assertion that is about the role rather
     * than about a statement, and the only shape of test that would have caught
     * the bug it locks down.
     *
     * `AmazonSSMManagedInstanceCore` was attached here as break-glass Session
     * Manager. It also allows `ssm:GetParameter` and `ssm:GetParameters` on
     * `Resource: "*"`, and IAM unions an attached policy with the inline one —
     * so `FleetParameters`, narrowed at v3 precisely to keep one fleet out of
     * another's tree, bounded nothing at all. A compromised box could read any
     * parameter name it could guess in the account: this fleet's Tailscale
     * OAuth secret, every other fleet's provider keys. Every per-statement test
     * above passed throughout.
     */
    test("effectively, the role reads this fleet's parameters and no others", () => {
      // What hermeticd actually reads: its own agent's slots (`agentd/src/aws.ts`).
      expect(roleAllows("ssm:GetParameter", parameterArn("/hermes/fxtr0001/atlas/provider-key"))).toBe(
        true,
      );

      // The fleet's own Tailscale OAuth client secret. Never read from a box —
      // the laptop copies what an agent needs into that agent's `/hermes/` slot
      // (§8.3) — and reachable from one for as long as the managed policy was
      // attached.
      expect(
        roleAllows("ssm:GetParameter", parameterArn("/hermetic/fxtr0001/tailscale/oauth-secret")),
      ).toBe(false);

      // Another fleet in the same account, by all three read verbs.
      for (const action of ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]) {
        expect(
          roleAllows(action, parameterArn(`/hermes/${OTHER_FLEET}/atlas/provider-key`)),
          `${action} must not reach fleet ${OTHER_FLEET}`,
        ).toBe(false);
      }

      // And break-glass Session Manager still works without any of that (§6.3):
      // the connectivity half of the managed policy is stated inline.
      expect(roleAllows("ssmmessages:CreateControlChannel", "*")).toBe(true);
      expect(roleAllows("ssm:UpdateInstanceInformation", "*")).toBe(true);
    });
  });

  test("both tables are pay-per-request", () => {
    for (const name of ["AgentsTable", "EventsTable"]) {
      const table = template.Resources[name] as { Properties: Record<string, unknown> };
      expect(table.Properties["BillingMode"]).toBe("PAY_PER_REQUEST");
    }
  });

  /**
   * TTL deletes the whole item, so a lock that outlived its operator would take
   * the agent record with it. Lock expiry is a clock comparison in core (§4.4).
   */
  test("neither table has a TTL", () => {
    for (const name of ["AgentsTable", "EventsTable"]) {
      const table = template.Resources[name] as { Properties: Record<string, unknown> };
      expect(table.Properties["TimeToLiveSpecification"]).toBeUndefined();
    }
    expect(foundationTemplateBody()).not.toContain("lock_expires");
  });

  test("the bucket is versioned and private", () => {
    const bucket = template.Resources["Bucket"] as { Properties: Record<string, unknown> };
    expect(bucket.Properties["VersioningConfiguration"]).toEqual({ Status: "Enabled" });
    expect(bucket.Properties["PublicAccessBlockConfiguration"]).toMatchObject({
      BlockPublicPolicy: true,
      RestrictPublicBuckets: true,
    });
  });

  /**
   * Versioning without expiry grows for ever: every re-push of the same release
   * label leaves the old ~100 MB binary behind as a noncurrent version nobody
   * can see in a plain listing. The shape is what matters here, not the exact
   * day counts — those are a judgement call and are meant to stay editable.
   */
  test("the bucket bounds its versioning with lifecycle rules", () => {
    const bucket = template.Resources["Bucket"] as {
      Properties: {
        LifecycleConfiguration: {
          Rules: Array<{
            Status: string;
            Prefix?: string;
            NoncurrentVersionExpiration?: { NoncurrentDays: number };
            ExpiredObjectDeleteMarker?: boolean;
            AbortIncompleteMultipartUpload?: { DaysAfterInitiation: number };
          }>;
        };
      };
    };
    const rules = bucket.Properties.LifecycleConfiguration.Rules;
    expect(rules.length).toBeGreaterThanOrEqual(2);
    for (const rule of rules) {
      expect(rule.Status).toBe("Enabled");
      expect(typeof rule.NoncurrentVersionExpiration?.NoncurrentDays).toBe("number");
    }
    expect(rules.some((rule) => rule.Prefix === "artifacts/")).toBe(true);
    expect(rules.some((rule) => rule.ExpiredObjectDeleteMarker === true)).toBe(true);
    expect(
      rules.some(
        (rule) => typeof rule.AbortIncompleteMultipartUpload?.DaysAfterInitiation === "number",
      ),
    ).toBe(true);
  });

  test("daily snapshots retain 7 and select this fleet's data volumes only", () => {
    const dlm = template.Resources["SnapshotPolicy"] as {
      Properties: {
        PolicyDetails: {
          TargetTags: Array<{ Key: string; Value: unknown }>;
          Schedules: Array<{ RetainRule: { Count: number }; CreateRule: { Interval: number } }>;
        };
      };
    };
    /**
     * Data volumes only — root volumes are disposable (§1) — and this fleet's
     * only. DLM ANDs its target tags, so without the fleet id every fleet's
     * policy would snapshot every fleet's disks and the account would pay for
     * each one several times over.
     */
    expect(dlm.Properties.PolicyDetails.TargetTags).toEqual([
      { Key: ROLE_TAG, Value: ROLE_DATA },
      { Key: "hermetic:fleet_id", Value: { Ref: "FleetId" } },
    ]);
    expect(dlm.Properties.PolicyDetails.Schedules[0]!.RetainRule.Count).toBe(7);
    expect(dlm.Properties.PolicyDetails.Schedules[0]!.CreateRule.Interval).toBe(24);
  });

  test("`--network nat` is a condition, not a second template", () => {
    expect(template.Conditions["IsNat"]).toEqual({ "Fn::Equals": [{ Ref: "Network" }, "nat"] });
    const nat = template.Resources["NatInstance"] as {
      Condition: string;
      Properties: Record<string, unknown>;
    };
    expect(nat.Condition).toBe("IsNat");
    expect(nat.Properties["InstanceType"]).toBe("t4g.nano");
    expect(nat.Properties["ImageId"]).toEqual({ Ref: "FckNatAmiId" });
    expect(nat.Properties["SourceDestCheck"]).toBe(false);
    for (const name of ["PrivateSubnet0", "PrivateSubnet1", "PrivateRouteTable"]) {
      expect(template.Resources[name]!["Condition"]).toBe("IsNat");
    }
  });

  test("the VPC is dual-stack with two public subnets and gateway endpoints", () => {
    expect(template.Resources["Ipv6Cidr"]!["Type"]).toBe("AWS::EC2::VPCCidrBlock");
    for (const n of [0, 1]) {
      const subnet = template.Resources[`PublicSubnet${n}`] as { Properties: Record<string, unknown> };
      expect(subnet.Properties["MapPublicIpOnLaunch"]).toBe(true);
      expect(subnet.Properties["AssignIpv6AddressOnCreation"]).toBe(true);
    }
    expect(template.Resources["S3Endpoint"]!["Properties"]).toMatchObject({
      VpcEndpointType: "Gateway",
    });
    expect(template.Resources["DynamoDbEndpoint"]!["Properties"]).toMatchObject({
      VpcEndpointType: "Gateway",
    });
    // No NAT gateway anywhere: it is the most expensive way out of a small fleet.
    expect(foundationTemplateBody()).not.toContain("AWS::EC2::NatGateway");
  });

  test("every taggable resource carries hermetic:fleet_id and hermetic:version", () => {
    const untagged: string[] = [];
    for (const [name, resource] of Object.entries(template.Resources)) {
      const props = resource["Properties"] as Record<string, unknown> | undefined;
      const tags = props?.["Tags"] as Array<{ Key: string }> | undefined;
      if (!tags) continue;
      const keys = tags.map((t) => t.Key);
      if (!keys.includes(FLEET_ID_TAG) || !keys.includes(VERSION_TAG)) untagged.push(name);
    }
    expect(untagged).toEqual([]);
  });

  test("outputs are exactly what the backend resolves the fleet from", () => {
    expect(Object.keys(template.Outputs).sort()).toEqual([
      "AgentsTable",
      "BucketName",
      "EventsTable",
      "InstanceProfileArn",
      // `nat` only: a `public` fleet has no single egress address to report.
      "NatEgressIp",
      "Network",
      "RoleArn",
      "SecurityGroupId",
      "SubnetIds",
      "VpcId",
    ]);
  });

  /**
   * §5: no foundation resource may carry a name that another fleet in the same
   * account could also want. Every one of them is `${AWS::StackName}`-derived,
   * and the stack is `hermetic-<fleet_id>`.
   */
  test("every named resource is derived from the stack name", () => {
    const t = foundationTemplate() as unknown as {
      Resources: Record<string, { Properties?: Record<string, unknown> }>;
    };
    const named: Array<[string, string]> = [
      ["AgentsTable", "TableName"],
      ["EventsTable", "TableName"],
      ["Bucket", "BucketName"],
      ["AgentRole", "RoleName"],
      ["AgentInstanceProfile", "InstanceProfileName"],
      ["SnapshotRole", "RoleName"],
    ];
    for (const [resource, property] of named) {
      const value = t.Resources[resource]?.Properties?.[property];
      const sub = (value as { "Fn::Sub"?: string })?.["Fn::Sub"];
      expect(sub, `${resource}.${property} must be an Fn::Sub`).toBeString();
      expect(sub, `${resource}.${property} must derive from the stack name`).toContain(
        "${AWS::StackName}",
      );
    }
    // And nothing anywhere hard-codes the pre-rename names.
    const body = foundationTemplateBody();
    expect(body).not.toContain('"hermetic-agents"');
    expect(body).not.toContain('"hermetic-events"');
  });

  /**
   * The events table was `Retain` once, which left an orphan behind every
   * teardown — one `teardown`'s own summary claimed had been deleted.
   */
  test("both tables and the bucket go with the stack", () => {
    const t = foundationTemplate() as unknown as {
      Resources: Record<string, { DeletionPolicy?: string }>;
    };
    for (const resource of ["AgentsTable", "EventsTable", "Bucket"]) {
      expect(t.Resources[resource]?.DeletionPolicy, resource).toBe("Delete");
    }
  });

  /**
   * §5, foundation v6. The `nat` branch used to be a half-built fck-nat
   * deployment: `NatRole` granted exactly the failover permissions
   * (`AssociateAddress`, `AttachNetworkInterface`) and the template created no
   * address for them to move. So the NAT box carried an auto-assigned public IP
   * that changed under every replacement, and any allowlist written against the
   * fleet went stale with nothing saying so.
   */
  test("a nat fleet has a stable egress address, and only a nat fleet", () => {
    const eip = template.Resources["NatEip"] as {
      Condition: string;
      DependsOn: string;
      Properties: Record<string, unknown>;
    };
    expect(eip.Condition).toBe("IsNat");
    expect(eip.Properties["Domain"]).toBe("vpc");
    expect(eip.DependsOn).toBe("InternetGatewayAttachment");

    const association = template.Resources["NatEipAssociation"] as {
      Condition: string;
      Properties: Record<string, unknown>;
    };
    expect(association.Condition).toBe("IsNat");
    expect(association.Properties["AllocationId"]).toEqual({
      "Fn::GetAtt": ["NatEip", "AllocationId"],
    });
    expect(association.Properties["InstanceId"]).toEqual({ Ref: "NatInstance" });

    // Reported, so an operator can allowlist it — and only for `nat`, because a
    // `public` fleet has no single egress address to report.
    expect(template.Outputs["NatEgressIp"]).toEqual({
      Description: "Stable egress address of the NAT instance",
      Condition: "IsNat",
      Value: { Ref: "NatEip" },
    });
  });

  /**
   * The VPC used to be dual-stack in `public` mode and IPv4-only in `nat` mode,
   * undocumented: private subnets got no `Ipv6CidrBlock` and there was no
   * egress-only gateway for them to route through.
   */
  test("a nat fleet has IPv6 egress, on /64s no public subnet claims", () => {
    const eigw = template.Resources["EgressOnlyInternetGateway"] as {
      Type: string;
      Condition: string;
      Properties: Record<string, unknown>;
    };
    expect(eigw.Condition).toBe("IsNat");
    expect(eigw.Type).toBe("AWS::EC2::EgressOnlyInternetGateway");
    expect(eigw.Properties["VpcId"]).toEqual({ Ref: "Vpc" });

    const route = template.Resources["PrivateDefaultRouteV6"] as {
      Condition: string;
      Properties: Record<string, unknown>;
    };
    expect(route.Condition).toBe("IsNat");
    expect(route.Properties["RouteTableId"]).toEqual({ Ref: "PrivateRouteTable" });
    expect(route.Properties["DestinationIpv6CidrBlock"]).toBe("::/0");
    // Not through `NatInstance`: there is no NAT for IPv6, and routing v6 that
    // way would take v6 egress down with the NAT box.
    expect(route.Properties["EgressOnlyInternetGatewayId"]).toEqual({
      Ref: "EgressOnlyInternetGateway",
    });

    /**
     * Each subnet gets its own /64 out of the VPC's /56. Two subnets on the
     * same slice is a CreateStack failure in `nat` mode only, which is exactly
     * the kind of thing nobody meets until the day they pick `--network nat`.
     */
    const slice = (name: string): number => {
      const subnet = template.Resources[name] as { Properties: Record<string, unknown> };
      const cidr = subnet.Properties["Ipv6CidrBlock"] as { "Fn::Select": [number, unknown] };
      return cidr["Fn::Select"][0];
    };
    const slices = ["PublicSubnet0", "PublicSubnet1", "PrivateSubnet0", "PrivateSubnet1"].map(slice);
    expect(slices).toEqual([0, 1, 2, 3]);

    for (const n of [0, 1]) {
      const subnet = template.Resources[`PrivateSubnet${n}`] as {
        DependsOn?: string;
        Properties: Record<string, unknown>;
      };
      expect(subnet.Properties["AssignIpv6AddressOnCreation"]).toBe(true);
      expect(subnet.Properties["MapPublicIpOnLaunch"]).toBe(false);
      // The /64 is carved from the VPC's Amazon-provided block, which only
      // exists once `Ipv6Cidr` has been associated.
      expect(subnet.DependsOn).toBe("Ipv6Cidr");
    }
  });

  /**
   * What a head counts against while it waits (`init.ts`). Exact numbers, so
   * adding a resource without noticing which branch it lands in fails here.
   */
  test("the resource count is per branch, and every nat resource is conditional", () => {
    expect(foundationResourceCount("public")).toBe(22);
    expect(foundationResourceCount("nat")).toBe(36);

    const conditional = Object.entries(template.Resources)
      .filter(([, r]) => r["Condition"] !== undefined)
      .map(([name]) => name);
    // Every condition in the template is `IsNat`; nothing else gates anything.
    for (const name of conditional) expect(template.Resources[name]!["Condition"]).toBe("IsNat");
    expect(conditional).toContain("NatEip");
    expect(conditional).toContain("NatEipAssociation");
    expect(conditional).toContain("EgressOnlyInternetGateway");
    expect(conditional).toContain("PrivateDefaultRouteV6");
    expect(foundationResourceCount("nat") - foundationResourceCount("public")).toBe(conditional.length);
  });

  /**
   * The mode is readable back off the stack. `_fleet.network` caches it and the
   * v6 migration back-fills that cache from the `Network` *parameter*; this
   * output is the same fact where a caller holding only outputs can see it.
   */
  test("the network mode is an output as well as a parameter", () => {
    expect(template.Outputs["Network"]).toEqual({
      Description: "Fleet network mode",
      Value: { Ref: "Network" },
    });
    expect(template.Outputs["Network"]!["Condition"]).toBeUndefined();
  });

  test("snapshot", () => {
    expect(foundationTemplateBody()).toMatchSnapshot();
  });
});
