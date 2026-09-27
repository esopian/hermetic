import { createHash } from "node:crypto";
import { STACK_NAME } from "../schema/fleet.ts";
import { FLEET_ID_TAG, ROLE_DATA, ROLE_TAG, VERSION_TAG } from "../backend/constants.ts";

/**
 * The foundation stack of §5, built in code as a plain JSON object rather than
 * shipped as a YAML string: it is one artifact, it typechecks, and
 * `aws-cfn-template.test.ts` can assert the invariants that matter — the agent
 * security group has no inbound rules at all, and the agent policy is scoped to
 * the fleet's own resources and grants no view of the fleet (§5.1).
 *
 * Six static resource groups, created once. This is the only declarative piece
 * in hermetic; everything per-agent is an SDK call (§1).
 */

export { STACK_NAME };

/** Template parameters. `init` supplies all of them. */
export const TEMPLATE_PARAMETERS = [
  "FleetId",
  "HermeticVersion",
  "Network",
  "BedrockModelArns",
  "FckNatAmiId",
] as const;
export type TemplateParameter = (typeof TEMPLATE_PARAMETERS)[number];

export type CfnValue = unknown;
export type CfnTemplate = {
  AWSTemplateFormatVersion: string;
  Description: string;
  /** Tool configuration that ships with the template (cfn-lint reads `cfn-lint`). */
  Metadata: Record<string, CfnValue>;
  Parameters: Record<string, Record<string, CfnValue>>;
  Conditions: Record<string, CfnValue>;
  Resources: Record<string, Record<string, CfnValue>>;
  Outputs: Record<string, Record<string, CfnValue>>;
};

const sub = (s: string): CfnValue => ({ "Fn::Sub": s });
const ref = (s: string): CfnValue => ({ Ref: s });
const getAtt = (r: string, a: string): CfnValue => ({ "Fn::GetAtt": [r, a] });

/** `hermetic:fleet_id` and `hermetic:version` go on every taggable resource (§5). */
function tags(extra: Array<{ Key: string; Value: CfnValue }> = []): CfnValue {
  return [
    { Key: FLEET_ID_TAG, Value: ref("FleetId") },
    { Key: VERSION_TAG, Value: ref("HermeticVersion") },
    ...extra,
  ];
}

const AZ = (n: number): CfnValue => ({ "Fn::Select": [n, { "Fn::GetAZs": "" }] });

/** IPv6 /64s carved out of the VPC's Amazon-provided /56 (§5, dual-stack). */
const ipv6Slice = (n: number): CfnValue => ({
  "Fn::Select": [n, { "Fn::Cidr": [{ "Fn::Select": [0, getAtt("Vpc", "Ipv6CidrBlocks")] }, 8, "64"] }],
});

function publicSubnet(index: number, cidr: string): Record<string, CfnValue> {
  return {
    Type: "AWS::EC2::Subnet",
    DependsOn: "Ipv6Cidr",
    Properties: {
      VpcId: ref("Vpc"),
      CidrBlock: cidr,
      Ipv6CidrBlock: ipv6Slice(index),
      AvailabilityZone: AZ(index),
      MapPublicIpOnLaunch: true,
      AssignIpv6AddressOnCreation: true,
      Tags: tags([{ Key: "Name", Value: sub(`\${AWS::StackName}-public-${index}`) }]),
    },
  };
}

/**
 * Private subnets are dual-stack too. `nat` mode used to drop IPv6 entirely —
 * no `Ipv6CidrBlock`, no egress-only gateway — which made the VPC dual-stack in
 * `public` mode and IPv4-only in `nat` mode with nothing saying so. The /64s
 * come after the two public ones (slices 0 and 1), so no two subnets claim the
 * same slice out of the VPC's Amazon-provided /56.
 */
function privateSubnet(index: number, cidr: string): Record<string, CfnValue> {
  return {
    Type: "AWS::EC2::Subnet",
    Condition: "IsNat",
    DependsOn: "Ipv6Cidr",
    Properties: {
      VpcId: ref("Vpc"),
      CidrBlock: cidr,
      Ipv6CidrBlock: ipv6Slice(index + 2),
      AvailabilityZone: AZ(index),
      MapPublicIpOnLaunch: false,
      AssignIpv6AddressOnCreation: true,
      Tags: tags([{ Key: "Name", Value: sub(`\${AWS::StackName}-private-${index}`) }]),
    },
  };
}

/**
 * §5.1. One role for the whole fleet, scoped to the fleet's own resources.
 *
 * This *was* written as ABAC — every statement conditioned on
 * `${aws:PrincipalTag/agent}`, with the instance's `agent=<name>` tag as the
 * identity — and it could never work. An EC2 instance's tags do not reach IAM
 * as principal tags; only tags on the *role* do, and this role is shared by the
 * whole fleet, so the variable resolved to nothing and every statement was an
 * implicit deny. A first boot died on its own `dynamodb:GetItem`, which is also
 * the call `reportBootFailure` needs, so the box could not even say why.
 *
 * So the scope is the fleet, not the agent: an agent can read every agent's SSM
 * parameters, rows and config prefix. That is a real reduction in blast radius
 * containment — a compromised box is no longer confined to its own row — and it
 * is deliberate for now. Restoring per-agent isolation means a per-agent role
 * (tagged `agent=<name>`, whose tags *are* principal tags) and per-agent IAM
 * churn on create and destroy; the statements below would then need no edit
 * beyond putting the variable back.
 */
function agentPolicy(): CfnValue {
  return {
    PolicyName: "hermetic-agent",
    PolicyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          /**
           * Scoped by fleet id since foundation v3. Two fleets in one account
           * share the `/hermes/` root, so `parameter/hermes/*` handed every box
           * in this fleet the *other* fleet's Tailscale auth keys and provider
           * keys. Nothing under `/hermetic/` is granted at all — an agent never
           * reads a shared slot (`/hermetic/<fleet>/secrets/*`) or the fleet's
           * OAuth client; a shared key reaches a box only by being copied into
           * that box's own `/hermes/` slot by the laptop (§8.3), which is what
           * makes this one statement the whole of an agent's SSM reach.
           *
           * That last sentence only became true at foundation v12. Until then
           * the role also attached `AmazonSSMManagedInstanceCore`, which allows
           * `ssm:GetParameter`/`ssm:GetParameters` on `Resource: "*"`; IAM
           * unions policies, so the scope below was decorative and a box could
           * read any parameter name it could guess — this fleet's Tailscale
           * OAuth secret under `/hermetic/<fleet>/tailscale/*` included. The
           * managed policy is gone and `SsmAgent` below carries what the SSM
           * agent actually needs, minus every parameter read.
           */
          Sid: "FleetParameters",
          Effect: "Allow",
          Action: ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"],
          Resource: [
            sub(
              "arn:${AWS::Partition}:ssm:${AWS::Region}:${AWS::AccountId}:parameter/hermes/${FleetId}/*",
            ),
          ],
        },
        {
          /**
           * Kept on `Resource: "*"`, and it is not a hole. The condition means
           * these keys can only be used *through* SSM, and since v12 the only
           * parameters SSM will hand this role are the ones `FleetParameters`
           * names — so the effective reach of the decrypt is the fleet's own
           * `/hermes/<fleet_id>/*` tree and nothing else. Naming key ARNs here
           * instead is not possible in a template: the account default key
           * (`alias/aws/ssm`) is the usual holder and a fleet may later move a
           * slot onto a customer-managed key without the stack knowing.
           */
          Sid: "DecryptFleetParameters",
          Effect: "Allow",
          Action: ["kms:Decrypt"],
          Resource: "*",
          Condition: {
            StringEquals: { "kms:ViaService": sub("ssm.${AWS::Region}.amazonaws.com") },
          },
        },
        {
          /**
           * What the SSM agent itself needs to register the instance, run
           * inventory and associations, and be reachable by Session Manager —
           * `AmazonSSMManagedInstanceCore`'s document, written out, **minus
           * `ssm:GetParameter` and `ssm:GetParameters`** (and never
           * `ssm:GetParametersByPath`, which that document does not grant
           * either).
           *
           * Attaching the managed policy is what made those three exclusions
           * necessary: it grants the parameter reads on `Resource: "*"`, IAM
           * unions it with the inline document, and the fleet-scoped
           * `FleetParameters` statement above therefore bounded nothing at all.
           * A compromised box could read any parameter name in the account it
           * could guess, starting with this fleet's own Tailscale OAuth secret
           * at `/hermetic/<fleet_id>/tailscale/oauth-secret` and every other
           * fleet's `/hermes/<other>/…` slots.
           *
           * None of the actions here read a parameter, so Session Manager keeps
           * working as the break-glass path of §6.3 while the only SSM values a
           * box can fetch are the ones in its own fleet's tree. Every action is
           * on `Resource: "*"` because none of them is resource-scopable: they
           * address the instance the agent is running on, and the managed
           * policy AWS publishes writes them the same way.
           */
          Sid: "SsmAgent",
          Effect: "Allow",
          Action: [
            "ssm:DescribeAssociation",
            "ssm:DescribeDocument",
            "ssm:GetDeployablePatchSnapshotForInstance",
            "ssm:GetDocument",
            "ssm:GetManifest",
            "ssm:ListAssociations",
            "ssm:ListInstanceAssociations",
            "ssm:PutComplianceItems",
            "ssm:PutConfigurePackageResult",
            "ssm:PutInventory",
            "ssm:UpdateAssociationStatus",
            "ssm:UpdateInstanceAssociationStatus",
            "ssm:UpdateInstanceInformation",
          ],
          Resource: "*",
        },
        {
          // The Session Manager control and data channels (§6.3 break-glass).
          // Split from `SsmAgent` because the service is a different one and
          // its four actions are the whole of what an interactive session
          // needs — dropping this statement disables break-glass and nothing
          // else.
          Sid: "SsmMessages",
          Effect: "Allow",
          Action: [
            "ssmmessages:CreateControlChannel",
            "ssmmessages:CreateDataChannel",
            "ssmmessages:OpenControlChannel",
            "ssmmessages:OpenDataChannel",
          ],
          Resource: "*",
        },
        {
          // The legacy message-delivery transport the SSM agent still falls
          // back to when `ssmmessages` is unreachable. Carried over from the
          // managed policy verbatim rather than dropped: without it, an
          // instance in a subnet whose endpoints differ silently stops
          // answering `send-command`.
          Sid: "Ec2Messages",
          Effect: "Allow",
          Action: [
            "ec2messages:AcknowledgeMessage",
            "ec2messages:DeleteMessage",
            "ec2messages:FailMessage",
            "ec2messages:GetEndpoint",
            "ec2messages:GetMessages",
            "ec2messages:SendReply",
          ],
          Resource: "*",
        },
        {
          // `Query` and not `Scan`: an agent reads and writes rows by key. The
          // key it uses is still its own name — nothing in hermeticd addresses
          // another agent's row — but IAM no longer enforces that.
          Sid: "FleetRows",
          Effect: "Allow",
          Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"],
          Resource: [getAtt("AgentsTable", "Arn"), getAtt("EventsTable", "Arn")],
        },
        {
          Sid: "FleetConfigPrefix",
          Effect: "Allow",
          Action: ["s3:GetObject", "s3:GetObjectVersion"],
          Resource: [sub("${Bucket.Arn}/config/*")],
        },
        {
          // The release, and the *fleet manifest* that names it: hermeticd
          // fetches `manifest.json` first at every boot and every nightly
          // update, and everything else it needs — the tables, its SSM prefix,
          // every stage with its digest — comes out of it (§1).
          Sid: "ReadArtifacts",
          Effect: "Allow",
          Action: ["s3:GetObject"],
          Resource: [
            sub("${Bucket.Arn}/artifacts/*"),
            /**
             * The Hermes source mirror (§3.6), since foundation v7. Outside
             * `artifacts/` on purpose: the §6.6 release prune deletes whole
             * release prefixes, and a bundle a running agent reinstalls from
             * must not be collateral of a hermeticd upgrade.
             */
            sub("${Bucket.Arn}/hermes/*"),
            /**
             * The mirrored browser (§7.3), since foundation v14, and outside
             * `artifacts/` for the same reason `hermes/` is. This grant is what
             * `BROWSER_NEEDS_FOUNDATION_UPDATE` is about: without it a
             * `browser: true` agent boots and then 403s in its browser stage.
             */
            sub("${Bucket.Arn}/browser/*"),
            sub("${Bucket.Arn}/manifest.json"),
          ],
        },
        {
          Sid: "ListFleetPrefixes",
          Effect: "Allow",
          Action: ["s3:ListBucket"],
          Resource: [getAtt("Bucket", "Arn")],
          Condition: {
            StringLike: {
              "s3:prefix": ["config/*", "artifacts/*", "hermes/*", "browser/*", "manifest.json"],
            },
          },
        },
        {
          Sid: "Bedrock",
          Effect: "Allow",
          Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
          Resource: ref("BedrockModelArns"),
        },
        {
          /**
           * Read-only enumeration, `Resource: "*"` because neither call takes
           * one — the API has no per-model ARN to scope a list to. Separate from
           * `Bedrock` above for exactly that reason: invocation stays scoped to
           * the model ARNs the fleet chose, and widening the list must not
           * widen what a box may run.
           *
           * Upstream calls both: `hermes doctor` lists foundation models to say
           * whether Bedrock answers at all
           * (`hermes_cli/doctor_connectivity.py:232`), and the model picker
           * builds its catalog from foundation models *and* cross-region
           * inference profiles (`agent/bedrock_adapter.py:859`, `:880`).
           * Without these, both fail with an IAM error on a fleet whose
           * invocation policy is perfectly correct.
           */
          Sid: "BedrockCatalog",
          Effect: "Allow",
          Action: ["bedrock:ListFoundationModels", "bedrock:ListInferenceProfiles"],
          Resource: "*",
        },
      ],
    },
  };
}

/** The one-time foundation template (§5). */
export function foundationTemplate(): CfnTemplate {
  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Description:
      "hermetic foundation: dedicated dual-stack VPC, sealed agent security group, fleet-scoped agent role, versioned bucket, agents/events tables, daily snapshots.",

    Metadata: {
      "cfn-lint": {
        config: {
          /**
           * W2506: `FckNatAmiId` is typed `String`, not `AWS::EC2::Image::Id`.
           * Deliberate — CloudFormation validates the typed parameter against
           * the account at CreateStack, and the placeholder default would fail
           * every `Network=public` fleet, which never looks an AMI up.
           * Everything else cfn-lint reports fails `bun run lint:cfn`
           * (`scripts/lint-cfn.ts`).
           */
          ignore_checks: ["W2506"],
        },
      },
    },

    Parameters: {
      FleetId: {
        Type: "String",
        Description:
          "8-character lowercase Crockford base32 id minted by `hermetic init`; ties this stack to one hermetic home (§4.6).",
        AllowedPattern: "^[0-9abcdefghjkmnpqrstvwxyz]{8}$",
      },
      HermeticVersion: { Type: "String", Description: "hermetic version that created this stack." },
      Network: {
        Type: "String",
        Default: "public",
        AllowedValues: ["public", "nat"],
        Description: "`public` (default, §10) or `nat` for private subnets behind fck-nat.",
      },
      BedrockModelArns: {
        Type: "CommaDelimitedList",
        Description: "Model ARNs resolved for the region at init and recorded on _fleet (§5.1).",
      },
      FckNatAmiId: {
        Type: "String",
        Default: "ami-00000000000000000",
        Description: "fck-nat arm64 AMI, looked up by name at init. Unused when Network=public.",
      },
    },

    Conditions: {
      IsNat: { "Fn::Equals": [ref("Network"), "nat"] },
    },

    Resources: {
      // ── network ──────────────────────────────────────────────────────────
      Vpc: {
        Type: "AWS::EC2::VPC",
        Properties: {
          CidrBlock: "10.42.0.0/16",
          EnableDnsSupport: true,
          EnableDnsHostnames: true,
          Tags: tags([{ Key: "Name", Value: ref("AWS::StackName") }]),
        },
      },
      Ipv6Cidr: {
        Type: "AWS::EC2::VPCCidrBlock",
        Properties: { VpcId: ref("Vpc"), AmazonProvidedIpv6CidrBlock: true },
      },
      InternetGateway: {
        Type: "AWS::EC2::InternetGateway",
        Properties: { Tags: tags() },
      },
      InternetGatewayAttachment: {
        Type: "AWS::EC2::VPCGatewayAttachment",
        Properties: { VpcId: ref("Vpc"), InternetGatewayId: ref("InternetGateway") },
      },
      PublicSubnet0: publicSubnet(0, "10.42.0.0/20"),
      PublicSubnet1: publicSubnet(1, "10.42.16.0/20"),
      PublicRouteTable: {
        Type: "AWS::EC2::RouteTable",
        Properties: {
          VpcId: ref("Vpc"),
          Tags: tags([{ Key: "Name", Value: sub("${AWS::StackName}-public") }]),
        },
      },
      PublicDefaultRoute: {
        Type: "AWS::EC2::Route",
        DependsOn: "InternetGatewayAttachment",
        Properties: {
          RouteTableId: ref("PublicRouteTable"),
          DestinationCidrBlock: "0.0.0.0/0",
          GatewayId: ref("InternetGateway"),
        },
      },
      PublicDefaultRouteV6: {
        Type: "AWS::EC2::Route",
        DependsOn: "InternetGatewayAttachment",
        Properties: {
          RouteTableId: ref("PublicRouteTable"),
          DestinationIpv6CidrBlock: "::/0",
          GatewayId: ref("InternetGateway"),
        },
      },
      PublicSubnet0RouteAssociation: {
        Type: "AWS::EC2::SubnetRouteTableAssociation",
        Properties: { SubnetId: ref("PublicSubnet0"), RouteTableId: ref("PublicRouteTable") },
      },
      PublicSubnet1RouteAssociation: {
        Type: "AWS::EC2::SubnetRouteTableAssociation",
        Properties: { SubnetId: ref("PublicSubnet1"), RouteTableId: ref("PublicRouteTable") },
      },

      // Free, and they keep artifact and state traffic on AWS's network (§5).
      S3Endpoint: {
        Type: "AWS::EC2::VPCEndpoint",
        Properties: {
          VpcId: ref("Vpc"),
          ServiceName: sub("com.amazonaws.${AWS::Region}.s3"),
          VpcEndpointType: "Gateway",
          RouteTableIds: {
            "Fn::If": [
              "IsNat",
              [ref("PublicRouteTable"), ref("PrivateRouteTable")],
              [ref("PublicRouteTable")],
            ],
          },
        },
      },
      DynamoDbEndpoint: {
        Type: "AWS::EC2::VPCEndpoint",
        Properties: {
          VpcId: ref("Vpc"),
          ServiceName: sub("com.amazonaws.${AWS::Region}.dynamodb"),
          VpcEndpointType: "Gateway",
          RouteTableIds: {
            "Fn::If": [
              "IsNat",
              [ref("PublicRouteTable"), ref("PrivateRouteTable")],
              [ref("PublicRouteTable")],
            ],
          },
        },
      },

      /**
       * The inbound boundary. No `SecurityGroupIngress` property at all — not an
       * empty list, not a commented-out rule. `doctor` verifies this and `create`
       * refuses to run if a rule has been added (§5, §11.3).
       */
      AgentSecurityGroup: {
        Type: "AWS::EC2::SecurityGroup",
        Properties: {
          GroupDescription:
            "hermetic agents: zero inbound rules, outbound open (sealed inbound, open outbound)",
          VpcId: ref("Vpc"),
          SecurityGroupEgress: [
            { IpProtocol: "-1", CidrIp: "0.0.0.0/0", Description: "outbound open" },
            { IpProtocol: "-1", CidrIpv6: "::/0", Description: "outbound open (v6)" },
          ],
          Tags: tags([{ Key: "Name", Value: sub("${AWS::StackName}-agent") }]),
        },
      },

      // ── identity ─────────────────────────────────────────────────────────
      AgentRole: {
        Type: "AWS::IAM::Role",
        Properties: {
          RoleName: sub("${AWS::StackName}-agent"),
          AssumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: { Service: "ec2.amazonaws.com" },
                Action: "sts:AssumeRole",
              },
            ],
          },
          /**
           * **No `ManagedPolicyArns`, deliberately, since foundation v12.**
           * Session Manager is still here as break-glass (Tailscale is the
           * normal path, §6.3), but its permissions are written out inline in
           * `agentPolicy()` — `SsmAgent`, `SsmMessages`, `Ec2Messages` — rather
           * than inherited from `AmazonSSMManagedInstanceCore`.
           *
           * The managed policy grants `ssm:GetParameter`/`ssm:GetParameters` on
           * `Resource: "*"`. IAM unions an attached policy with the inline one,
           * so attaching it made the fleet-scoped `FleetParameters` statement
           * mean nothing: a box could read any parameter name in the account,
           * this fleet's Tailscale OAuth secret included. Its contents are also
           * AWS's to change, which is the second reason to state them here: a
           * future revision cannot widen this role without a template edit.
           */
          Policies: [agentPolicy()],
          Tags: tags(),
        },
      },
      AgentInstanceProfile: {
        Type: "AWS::IAM::InstanceProfile",
        Properties: {
          InstanceProfileName: sub("${AWS::StackName}-agent"),
          Roles: [ref("AgentRole")],
        },
      },

      // ── state ────────────────────────────────────────────────────────────
      Bucket: {
        Type: "AWS::S3::Bucket",
        UpdateReplacePolicy: "Retain",
        DeletionPolicy: "Delete",
        Properties: {
          BucketName: sub("${AWS::StackName}-${AWS::AccountId}-${AWS::Region}"),
          VersioningConfiguration: { Status: "Enabled" },
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            BlockPublicPolicy: true,
            IgnorePublicAcls: true,
            RestrictPublicBuckets: true,
          },
          BucketEncryption: {
            ServerSideEncryptionConfiguration: [
              { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" }, BucketKeyEnabled: true },
            ],
          },
          OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] },
          LifecycleConfiguration: {
            Rules: [
              {
                // Big, and re-pushed on every dev iteration of the same version.
                Id: "expire-noncurrent-artifacts",
                Status: "Enabled",
                Prefix: "artifacts/",
                NoncurrentVersionExpiration: { NoncurrentDays: 7, NewerNoncurrentVersions: 1 },
              },
              {
                // Whole bucket: manifest.json, config/*, archive/*. Small, and the §6.6
                // archive is the real recovery path, so history here is a courtesy. This
                // rule also covers artifacts/, where it overlaps the rule above; S3
                // resolves overlapping expirations by honouring the shorter one.
                //
                // It also covers browser/* (v14), which is not small — but that object is
                // re-pushed idempotently *by key*, so it makes a noncurrent version only
                // if a build number is ever reused. The 7-day artifacts/ rule above is
                // deliberately not widened to it: a browser build a live agent's uploaded
                // configuration still pins must not be reclaimed on the schedule a
                // dev-iterated release is.
                Id: "expire-noncurrent-and-markers",
                Status: "Enabled",
                NoncurrentVersionExpiration: { NoncurrentDays: 30, NewerNoncurrentVersions: 3 },
                ExpiredObjectDeleteMarker: true,
                AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
              },
            ],
          },
          Tags: tags(),
        },
      },
      /** Reachable only through the gateway endpoint or by this account (§5). */
      BucketPolicy: {
        Type: "AWS::S3::BucketPolicy",
        Properties: {
          Bucket: ref("Bucket"),
          PolicyDocument: {
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "DenyInsecureTransport",
                Effect: "Deny",
                Principal: "*",
                Action: "s3:*",
                Resource: [getAtt("Bucket", "Arn"), sub("${Bucket.Arn}/*")],
                Condition: { Bool: { "aws:SecureTransport": "false" } },
              },
              {
                Sid: "DenyOutsideVpcEndpointAndAccount",
                Effect: "Deny",
                Principal: "*",
                Action: "s3:*",
                Resource: [getAtt("Bucket", "Arn"), sub("${Bucket.Arn}/*")],
                Condition: {
                  StringNotEquals: { "aws:SourceVpce": ref("S3Endpoint") },
                  StringNotEqualsIfExists: { "aws:PrincipalAccount": ref("AWS::AccountId") },
                },
              },
            ],
          },
        },
      },
      AgentsTable: {
        Type: "AWS::DynamoDB::Table",
        UpdateReplacePolicy: "Retain",
        DeletionPolicy: "Delete",
        Properties: {
          TableName: sub("${AWS::StackName}-agents"),
          BillingMode: "PAY_PER_REQUEST",
          AttributeDefinitions: [{ AttributeName: "name", AttributeType: "S" }],
          KeySchema: [{ AttributeName: "name", KeyType: "HASH" }],
          // Deliberately no TTL. DynamoDB's TTL deletes the whole item, and an
          // expired lock must lose the *lock*, not the agent record; expiry is
          // decided against the clock in `hermetic.ts` instead (§4.4).
          PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
          Tags: tags(),
        },
      },
      EventsTable: {
        Type: "AWS::DynamoDB::Table",
        UpdateReplacePolicy: "Retain",
        // Deleted with the stack, like every other foundation resource. It was
        // `Retain` once, which left an orphaned table behind every teardown —
        // one that `teardown`'s own summary claimed had been deleted.
        DeletionPolicy: "Delete",
        Properties: {
          TableName: sub("${AWS::StackName}-events"),
          BillingMode: "PAY_PER_REQUEST",
          AttributeDefinitions: [
            { AttributeName: "name", AttributeType: "S" },
            { AttributeName: "timestamp", AttributeType: "S" },
          ],
          KeySchema: [
            { AttributeName: "name", KeyType: "HASH" },
            { AttributeName: "timestamp", KeyType: "RANGE" },
          ],
          Tags: tags(),
        },
      },

      // ── snapshots (§7.1: daily, keep 7) ──────────────────────────────────
      SnapshotRole: {
        Type: "AWS::IAM::Role",
        Properties: {
          RoleName: sub("${AWS::StackName}-dlm"),
          AssumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: { Service: "dlm.amazonaws.com" },
                Action: "sts:AssumeRole",
              },
            ],
          },
          ManagedPolicyArns: [
            sub(
              "arn:${AWS::Partition}:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole",
            ),
          ],
          Tags: tags(),
        },
      },
      SnapshotPolicy: {
        Type: "AWS::DLM::LifecyclePolicy",
        Properties: {
          Description: sub("${AWS::StackName} daily data-volume snapshots"),
          State: "ENABLED",
          ExecutionRoleArn: getAtt("SnapshotRole", "Arn"),
          PolicyDetails: {
            PolicyType: "EBS_SNAPSHOT_MANAGEMENT",
            ResourceTypes: ["VOLUME"],
            /**
             * Data volumes of *this fleet* only. Root volumes are disposable
             * (§1, §7.1), and DLM ANDs its target tags — so adding the fleet id
             * is what stops each fleet's policy snapshotting every fleet's
             * disks in the account, and every fleet then paying for the same
             * snapshot several times over. It is also what makes `teardown
             * --delete-snapshots` a per-fleet operation rather than an
             * account-wide one.
             */
            TargetTags: [
              { Key: ROLE_TAG, Value: ROLE_DATA },
              { Key: FLEET_ID_TAG, Value: ref("FleetId") },
            ],
            Schedules: [
              {
                Name: "daily",
                CreateRule: { Interval: 24, IntervalUnit: "HOURS", Times: ["05:00"] },
                RetainRule: { Count: 7 },
                CopyTags: true,
              },
            ],
          },
          Tags: tags(),
        },
      },

      /**
       * ── `--network nat` (§5) ───────────────────────────────────────────────
       *
       * Everything below exists only for `Network=nat`, gated on `IsNat`.
       * Agents move into private subnets and reach the internet through one
       * fck-nat instance: a `t4g.nano` with `SourceDestCheck` off, which is the
       * cheapest way out of a small fleet's private subnets and costs a
       * fraction of a managed NAT gateway.
       *
       * What the branch now has: a stable egress address (`NatEip`, associated
       * with the instance), and real IPv6 egress (`EgressOnlyInternetGateway` +
       * `PrivateDefaultRouteV6`, with `Ipv6CidrBlock` on each private subnet),
       * so a `nat` VPC is dual-stack exactly as a `public` one is.
       *
       * What it deliberately does **not** have: failover. There is one NAT
       * instance, not an ASG behind a floating ENI, so if it dies
       * `PrivateDefaultRoute` — pinned to `InstanceId` — blackholes and the
       * fleet loses IPv4 egress until the instance is replaced. `NatRole` below
       * already carries the permissions fck-nat's own failover needs
       * (`AttachNetworkInterface`, `AssociateAddress`, …), which is what makes
       * adding the ASG a template change and nothing more; until then `doctor`
       * is what notices. `public` mode has no such single point of failure,
       * which is why it stays the default (§6.4).
       */
      PrivateSubnet0: privateSubnet(0, "10.42.128.0/20"),
      PrivateSubnet1: privateSubnet(1, "10.42.144.0/20"),
      PrivateRouteTable: {
        Type: "AWS::EC2::RouteTable",
        Condition: "IsNat",
        Properties: {
          VpcId: ref("Vpc"),
          Tags: tags([{ Key: "Name", Value: sub("${AWS::StackName}-private") }]),
        },
      },
      PrivateDefaultRoute: {
        Type: "AWS::EC2::Route",
        Condition: "IsNat",
        Properties: {
          RouteTableId: ref("PrivateRouteTable"),
          DestinationCidrBlock: "0.0.0.0/0",
          InstanceId: ref("NatInstance"),
        },
      },
      /**
       * IPv6 egress for the private subnets. There is no NAT for IPv6 — an
       * egress-only internet gateway is the v6 equivalent: outbound-initiated
       * traffic only, no inbound. It is not routed through `NatInstance`, so v6
       * egress survives the NAT box being down.
       */
      EgressOnlyInternetGateway: {
        Type: "AWS::EC2::EgressOnlyInternetGateway",
        Condition: "IsNat",
        Properties: { VpcId: ref("Vpc") },
      },
      PrivateDefaultRouteV6: {
        Type: "AWS::EC2::Route",
        Condition: "IsNat",
        Properties: {
          RouteTableId: ref("PrivateRouteTable"),
          DestinationIpv6CidrBlock: "::/0",
          EgressOnlyInternetGatewayId: ref("EgressOnlyInternetGateway"),
        },
      },
      PrivateSubnet0RouteAssociation: {
        Type: "AWS::EC2::SubnetRouteTableAssociation",
        Condition: "IsNat",
        Properties: { SubnetId: ref("PrivateSubnet0"), RouteTableId: ref("PrivateRouteTable") },
      },
      PrivateSubnet1RouteAssociation: {
        Type: "AWS::EC2::SubnetRouteTableAssociation",
        Condition: "IsNat",
        Properties: { SubnetId: ref("PrivateSubnet1"), RouteTableId: ref("PrivateRouteTable") },
      },
      NatSecurityGroup: {
        Type: "AWS::EC2::SecurityGroup",
        Condition: "IsNat",
        Properties: {
          GroupDescription: "fck-nat: accepts only traffic originating inside the VPC",
          VpcId: ref("Vpc"),
          SecurityGroupIngress: [
            { IpProtocol: "-1", CidrIp: "10.42.0.0/16", Description: "VPC egress via NAT" },
          ],
          SecurityGroupEgress: [
            { IpProtocol: "-1", CidrIp: "0.0.0.0/0", Description: "outbound open" },
          ],
          Tags: tags([{ Key: "Name", Value: sub("${AWS::StackName}-nat") }]),
        },
      },
      NatRole: {
        Type: "AWS::IAM::Role",
        Condition: "IsNat",
        Properties: {
          RoleName: sub("${AWS::StackName}-nat"),
          AssumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: { Service: "ec2.amazonaws.com" },
                Action: "sts:AssumeRole",
              },
            ],
          },
          Policies: [
            {
              PolicyName: "fck-nat",
              PolicyDocument: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Action: [
                      "ec2:AttachNetworkInterface",
                      "ec2:ModifyNetworkInterfaceAttribute",
                      "ec2:AssociateAddress",
                      "ec2:DisassociateAddress",
                      "ec2:DescribeNetworkInterfaces",
                      "ec2:DescribeAddresses",
                      "ec2:DescribeSubnets",
                    ],
                    Resource: "*",
                  },
                ],
              },
            },
          ],
          Tags: tags(),
        },
      },
      NatInstanceProfile: {
        Type: "AWS::IAM::InstanceProfile",
        Condition: "IsNat",
        Properties: { InstanceProfileName: sub("${AWS::StackName}-nat"), Roles: [ref("NatRole")] },
      },
      NatInstance: {
        Type: "AWS::EC2::Instance",
        Condition: "IsNat",
        Properties: {
          // t4g.nano, not a managed NAT gateway: the cheapest way out of a small
          // fleet's private subnets (§5).
          InstanceType: "t4g.nano",
          ImageId: ref("FckNatAmiId"),
          IamInstanceProfile: ref("NatInstanceProfile"),
          SubnetId: ref("PublicSubnet0"),
          SecurityGroupIds: [ref("NatSecurityGroup")],
          SourceDestCheck: false,
          Tags: tags([{ Key: "Name", Value: sub("${AWS::StackName}-nat") }]),
        },
      },
      /**
       * The fleet's egress address, and unconditional in `nat` mode. Without
       * it the NAT instance carries an auto-assigned public IP that changes
       * every time the box is replaced, so every allowlist an operator writes
       * against this fleet goes stale without warning. An EIP is also what
       * `NatRole`'s `ec2:AssociateAddress`/`DisassociateAddress` grants are
       * *for*: fck-nat moves the address onto a replacement instance.
       */
      NatEip: {
        Type: "AWS::EC2::EIP",
        Condition: "IsNat",
        DependsOn: "InternetGatewayAttachment",
        Properties: {
          Domain: "vpc",
          Tags: tags([{ Key: "Name", Value: sub("${AWS::StackName}-nat") }]),
        },
      },
      NatEipAssociation: {
        Type: "AWS::EC2::EIPAssociation",
        Condition: "IsNat",
        Properties: {
          AllocationId: getAtt("NatEip", "AllocationId"),
          InstanceId: ref("NatInstance"),
        },
      },
    },

    Outputs: {
      VpcId: { Description: "hermetic VPC", Value: ref("Vpc") },
      SubnetIds: {
        Description: "Subnets agents launch into",
        Value: {
          "Fn::If": [
            "IsNat",
            { "Fn::Join": [",", [ref("PrivateSubnet0"), ref("PrivateSubnet1")]] },
            { "Fn::Join": [",", [ref("PublicSubnet0"), ref("PublicSubnet1")]] },
          ],
        },
      },
      SecurityGroupId: { Description: "Sealed agent security group", Value: ref("AgentSecurityGroup") },
      InstanceProfileArn: {
        Description: "Shared agent instance profile",
        Value: getAtt("AgentInstanceProfile", "Arn"),
      },
      RoleArn: { Description: "Shared agent role", Value: getAtt("AgentRole", "Arn") },
      BucketName: { Description: "hermeticd artifacts and rendered config", Value: ref("Bucket") },
      AgentsTable: { Description: "agents table", Value: ref("AgentsTable") },
      EventsTable: { Description: "events table", Value: ref("EventsTable") },
      /**
       * The mode the stack was built in, readable from the outputs as well as
       * from the parameters. `_fleet.network` caches it; this is what the
       * cache is reconciled against when only the outputs are to hand.
       */
      Network: { Description: "Fleet network mode", Value: ref("Network") },
      /**
       * The fleet's stable outbound address, so an operator can allowlist it.
       * Only a `nat` fleet has one — in `public` mode every agent has its own
       * address and there is no single egress IP to report.
       */
      NatEgressIp: {
        Description: "Stable egress address of the NAT instance",
        Condition: "IsNat",
        Value: ref("NatEip"),
      },
    },
  };
}

/**
 * The logical ids `FoundationApi.describeNat` resolves to physical ones (§5).
 * Named here, beside the resources themselves, because a probe that looked up
 * the wrong logical id would report a healthy `null` — "this fleet has no NAT"
 * — for a fleet whose NAT is on fire.
 */
export const NAT_INSTANCE_LOGICAL_ID = "NatInstance";
export const PRIVATE_ROUTE_TABLE_LOGICAL_ID = "PrivateRouteTable";

/**
 * How many resources CloudFormation will create for a given `Network`, so a
 * head can say "14/31" while it waits. Counted from the template itself, not
 * asked of AWS: resources gated on the `IsNat` condition only exist for
 * `nat`. The stack's own event (logical id = stack name) is not a resource.
 */
export function foundationResourceCount(network: "public" | "nat"): number {
  return Object.values(foundationTemplate().Resources).filter((r) => {
    const condition = r["Condition"];
    return condition === undefined || (condition === "IsNat") === (network === "nat");
  }).length;
}

/** The template as CloudFormation wants it: one JSON string. */
export function foundationTemplateBody(): string {
  return JSON.stringify(foundationTemplate(), null, 2);
}

/**
 * The digest of the template this build would apply. Recorded on `_fleet` and
 * in the fleet manifest beside `FOUNDATION_VERSION`, so a template edit that
 * forgot to bump the version is still detected: the version says "the contract
 * changed", the digest says "the bytes changed", and `foundation.status`
 * reports an update as available on either.
 */
export function foundationTemplateSha256(): string {
  return createHash("sha256").update(foundationTemplateBody()).digest("hex");
}
