import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DescribeImagesCommand, EC2Client } from "@aws-sdk/client-ec2";
import { S3Client } from "@aws-sdk/client-s3";
import { SSMClient } from "@aws-sdk/client-ssm";
import type { Backend, FoundationApi } from "../backend/types.ts";
import { HermeticError, isHermeticError } from "../errors.ts";
import { bedrockBaseModelId } from "../profiles/provider-profiles.ts";
import { DEFAULT_DIRECTORY_REGION } from "../schema/directory.ts";
import { AGENTS_TABLE, EVENTS_TABLE, STACK_NAME } from "../schema/fleet.ts";
import { makeClientFactory, type ClientFactory } from "./client.ts";
import { bedrockApi } from "./bedrock.ts";
import { CfnFoundation } from "./cfn.ts";
import { createDynamoDirectory } from "./directory.ts";
import { createDynamoStores } from "./dynamo.ts";
import { Ec2Compute, probeNat, type NetworkRefs } from "./ec2.ts";
import { AwsIdentity } from "./identity.ts";
import { HermeticdRpc } from "./rpc.ts";
import { S3Artifacts } from "./s3.ts";
import { SsmSecrets } from "./ssm.ts";
import { TailscaleClient } from "./tailscale.ts";

export * from "./client.ts";
export * from "./cfn-template.ts";
export * from "./cfn.ts";
export * from "./directory.ts";
export * from "./bedrock.ts";
export * from "./dynamo.ts";
export * from "./ec2.ts";
export * from "./identity.ts";
export * from "./probe.ts";
export * from "./ami.ts";
export * from "./rpc.ts";
export * from "./s3.ts";
export * from "./ssm.ts";
export * from "./tailscale.ts";

/** Bedrock model ids the agent role may invoke; ARNs are built per region (§5.1). */
export const DEFAULT_BEDROCK_MODEL_IDS = [
  // §8.3's Bedrock default. First in the list because it is what a new Bedrock
  // profile selects, and a grant that did not cover it would make the fleet's
  // own default unusable.
  "zai.glm-4.7-flash",
  "anthropic.claude-sonnet-4-5-20250929-v1:0",
  "anthropic.claude-haiku-4-5-20251001-v1:0",
  "anthropic.claude-opus-4-1-20250805-v1:0",
] as const;

export function bedrockModelArns(
  region: string,
  accountId: string,
  ids: readonly string[] = DEFAULT_BEDROCK_MODEL_IDS,
): string[] {
  /**
   * Normalised to the bare foundation id *first*, because the two lines below
   * spell the two forms of one model from one string and only the bare form
   * fits both.
   *
   * A caller can perfectly well arrive with `us.anthropic.claude-…`: the
   * catalog lists inference profiles under exactly that name (§8.3), so a
   * profile or an agent row may pin one, and `desiredBedrockModelIds` records
   * whatever they pinned. Passed through verbatim it would produce
   * `foundation-model/us.anthropic.claude-…`, which is not a resource that
   * exists, and `inference-profile/*.us.anthropic.claude-…`, whose wildcard
   * would have to match a `.` the real ARN does not contain — so the grant
   * would cover neither spelling and every turn would fail with
   * `AccessDeniedException`. Stripping the prefix gives
   * `inference-profile/*.anthropic.claude-…`, which the `us.` profile's own ARN
   * does match, and the bare foundation model beside it.
   */
  const base = [...new Set(ids.map(bedrockBaseModelId))].sort();
  return [
    // Foundation models are account-less; inference profiles are not.
    ...base.map((id) => `arn:aws:bedrock:${region}::foundation-model/${id}`),
    ...base.map((id) => `arn:aws:bedrock:${region}:${accountId}:inference-profile/*.${id}`),
  ];
}

/** fck-nat's published arm64 image. */
export const FCK_NAT_OWNER = "568608671756";
export const FCK_NAT_NAME = "fck-nat-al2023-*-arm64-ebs";

export interface AwsBackendOptions {
  profile: string;
  region: string;
  expectedAccountId: string;
  /**
   * The fleet whose foundation this backend talks to. It names the stack
   * (`hermetic-<fleet_id>`) and therefore every resource in it. Absent while
   * `init` is still deciding what to attach to or create.
   */
  fleetId?: string;
  /**
   * The region the account-global fleet directory lives in (§4.8). It is
   * separate from `region` on purpose: the directory is one table for the whole
   * account, so a laptop can enumerate fleets in six regions with one lookup,
   * and it therefore gets a client factory of its own — same profile, same
   * frozen account, different region.
   */
  directoryRegion?: string;
  /** Table and bucket names, when they are already known from `_fleet`/`config`. */
  hermeticVersion?: string | undefined;
  bedrockModelIds?: readonly string[];
  /** Test seam for `CfnFoundation`'s create waiter. */
  stackPollIntervalMs?: number;
}

export interface AwsBackend extends Backend {
  readonly factory: ClientFactory;
}

/**
 * `AwsBackend`: the real half of the `Backend` interface (§4.1). Every client is
 * built through `makeClientFactory`, so the account guard of §4.7 runs exactly
 * once per process and no code path can construct an unguarded client.
 *
 * Bucket, table, subnet, security-group and instance-profile names are *not*
 * configuration: they are read from the foundation stack's outputs, once, lazily.
 * That is what makes "the stack is the foundation" true rather than aspirational.
 */
export function createAwsBackend(opts: AwsBackendOptions): AwsBackend {
  const factory = makeClientFactory({
    profile: opts.profile,
    region: opts.region,
    expectedAccountId: opts.expectedAccountId,
  });

  /**
   * A second factory, not a second credential source: same profile, same frozen
   * account (the guard of §4.7 runs against it too), only a different region.
   * When the directory happens to live in the fleet's own region this is the
   * same factory, so the common case still makes exactly one STS call.
   */
  const directoryRegion = opts.directoryRegion ?? DEFAULT_DIRECTORY_REGION;
  const directoryFactory =
    directoryRegion === opts.region
      ? factory
      : makeClientFactory({
          profile: opts.profile,
          region: directoryRegion,
          expectedAccountId: opts.expectedAccountId,
        });

  const cfnClient = factory.client(CloudFormationClient);
  const ddbClient = factory.client(DynamoDBClient);
  const ec2Client = factory.client(EC2Client);
  const s3Client = factory.client(S3Client);
  const ssmClient = factory.client(SSMClient);

  const cfnFoundation = new CfnFoundation(cfnClient, {
    ...(opts.fleetId !== undefined ? { fleetId: opts.fleetId } : {}),
    bedrockModelArns: bedrockModelArns(opts.region, opts.expectedAccountId, opts.bedrockModelIds),
    hermeticVersion: opts.hermeticVersion ?? "0.0.0",
    ...(opts.stackPollIntervalMs !== undefined ? { pollIntervalMs: opts.stackPollIntervalMs } : {}),
    resolveFckNatAmi: async () => {
      const out = await ec2Client.send(
        new DescribeImagesCommand({
          Owners: [FCK_NAT_OWNER],
          Filters: [
            { Name: "name", Values: [FCK_NAT_NAME] },
            { Name: "architecture", Values: ["arm64"] },
            { Name: "state", Values: ["available"] },
          ],
        }),
      );
      const newest = [...(out.Images ?? [])].sort((a, b) =>
        (b.CreationDate ?? "").localeCompare(a.CreationDate ?? ""),
      )[0];
      if (!newest?.ImageId) {
        throw new HermeticError("NOT_FOUND", `no ${FCK_NAT_NAME} image in ${opts.region}`, {
          region: opts.region,
        });
      }
      return newest.ImageId;
    },
    // The EC2 half of `describeNat` (§5). Constructed here because this is
    // where `aws.client()` hands out clients; `CfnFoundation` holds only a
    // CloudFormation one.
    probeNat: (ids) => probeNat(ec2Client, ids),
  });

  /** One `DescribeStacks`, memoised: everything per-agent needs these five values. */
  let outputs: Promise<Record<string, string>> | null = null;
  /**
   * Drop the memo. Anything that can move the stack's outputs has to call this,
   * or a long-lived portal keeps answering from a describe taken before the
   * change: after `apply` kind `network` executes its change set the stack's
   * `SubnetIds` are the *other* pair, and an un-invalidated memo would go on
   * launching every new agent into the subnets the fleet no longer uses (§5).
   */
  const invalidateStackOutputs = (): void => {
    outputs = null;
    /**
     * The bucket name is the same describe, resolved once and kept for the life
     * of the backend — twice over, because `LazyBucketArtifacts` then binds an
     * `S3Artifacts` to it. Neither copy can move under a re-network, but both
     * move under `bindFleet`: every fleet has its own bucket, and a stale name
     * would point an artifacts push — or the teardown's `emptyBucket` — at
     * another fleet's objects.
     */
    bucketName = null;
    artifacts.invalidate();
    // And the AZ `Ec2Compute` remembered from the launch subnet those outputs
    // named: it is derived from the same describe, and a re-network moves it.
    compute.invalidate();
  };
  const stackOutputs = (): Promise<Record<string, string>> => {
    outputs ??= (async () => {
      const stack = await cfnFoundation.describeStack();
      if (!stack) {
        throw new HermeticError(
          "FLEET_MISMATCH",
          `no ${STACK_NAME} foundation stack in ${opts.region}; run \`hermetic init\``,
          { region: opts.region },
        );
      }
      return stack.outputs;
    })();
    return outputs;
  };

  const output = async (key: string, ...fallbacks: string[]): Promise<string> => {
    const all = await stackOutputs();
    for (const k of [key, ...fallbacks]) {
      const value = all[k];
      if (value) return value;
    }
    throw new HermeticError(
      "FLEET_MISMATCH",
      `the ${STACK_NAME} stack has no ${key} output; it may predate this hermetic version`,
      { output: key },
    );
  };

  const refs = async (): Promise<NetworkRefs> => ({
    subnet_ids: (await output("SubnetIds")).split(",").filter(Boolean),
    security_group_id: await output("SecurityGroupId", "AgentSecurityGroupId"),
    instance_profile_arn: await output("InstanceProfileArn"),
  });

  /**
   * Table and bucket names are stack outputs, resolved on first use so
   * constructing a backend costs no AWS call. Reading them from the stack —
   * rather than rebuilding the convention here — is what lets the foundation
   * rename itself without core having to agree in advance: a fleet-scoped stack
   * answers `hermetic-<fleet_id>-agents`, a pre-rename one `hermetic-agents`.
   */
  const tableName = async (key: string, beforeTheOutputExisted: string): Promise<string> => {
    try {
      return await output(key);
    } catch (e) {
      // A stack that is *there* but has no such output predates the outputs, so
      // its tables are the pre-rename ones. A missing stack is a different
      // failure entirely and must keep its own message (§4.7).
      if (isHermeticError(e) && e.details?.["output"] === key) return beforeTheOutputExisted;
      throw e;
    }
  };
  const tables = {
    agents: () => tableName("AgentsTable", AGENTS_TABLE),
    events: () => tableName("EventsTable", EVENTS_TABLE),
  };
  const stores = createDynamoStores(ddbClient, tables);

  let bucketName: string | null = null;
  const bucket = async (): Promise<string> => (bucketName ??= await output("BucketName", "Bucket"));

  /**
   * The fleet id every tag filter and SSM path in this backend is scoped by
   * (§8.2, §5). Read back out of the foundation rather than captured from
   * `opts`, because `init` chooses the fleet *after* the backend exists
   * (`bindFleet`) and a captured copy would be stale for every call after it.
   */
  const requireFleetId = (): string => {
    const id = cfnFoundation.fleetId();
    if (id === undefined) {
      throw new HermeticError(
        "NOT_INITIALIZED",
        "this backend is not bound to a fleet yet; `init` binds one before any per-agent call",
      );
    }
    return id;
  };

  /**
   * The stack API, with the three calls that move the stack's outputs wired to
   * drop the memo above. A wrapper rather than a method on `CfnFoundation`
   * because the memo is this module's — the class knows nothing about who is
   * caching its answers.
   */
  const foundation: FoundationApi = {
    describeStack: () => cfnFoundation.describeStack(),
    listStacks: () => cfnFoundation.listStacks(),
    /**
     * Binding is not a read: it changes *which stack* `describeStack` answers
     * about, so every memo taken against the fleet that was bound before is
     * about a different foundation entirely — different subnets, different
     * tables, different bucket (§4.8).
     */
    bindFleet: (fleetId) => {
      cfnFoundation.bindFleet(fleetId);
      invalidateStackOutputs();
    },
    createStack: async (params) => {
      const stack = await cfnFoundation.createStack(params);
      invalidateStackOutputs();
      return stack;
    },
    deleteStack: async (opts) => {
      await cfnFoundation.deleteStack(opts);
      invalidateStackOutputs();
    },
    createChangeSet: (params) => cfnFoundation.createChangeSet(params),
    createNetworkChangeSet: (params) => cfnFoundation.createNetworkChangeSet(params),
    describeChangeSet: (name) => cfnFoundation.describeChangeSet(name),
    executeChangeSet: async (params) => {
      const stack = await cfnFoundation.executeChangeSet(params);
      invalidateStackOutputs();
      return stack;
    },
    deleteChangeSet: (name) => cfnFoundation.deleteChangeSet(name),
    resolveFckNatAmi: () => cfnFoundation.resolveFckNatAmi(),
    describeNat: () => cfnFoundation.describeNat(),
  };

  const secrets = new SsmSecrets(ssmClient);
  const artifacts = new LazyBucketArtifacts(s3Client, bucket);
  /**
   * Declared after `invalidateStackOutputs` closes over it, which is safe
   * because that function is only ever *called* from the stack wrappers below —
   * long after this line has run.
   */
  const compute = new Ec2Compute(ec2Client, ssmClient, opts.region, refs, requireFleetId);

  return {
    factory,
    identity: new AwsIdentity(factory),
    store: stores,
    secrets,
    artifacts,
    compute,
    foundation,
    tailscale: new TailscaleClient(secrets, {
      fleetId: () => cfnFoundation.fleetId(),
      // What licenses the pre-v3 root fallback, and nothing else does (§8.2).
      foundationVersion: async () => (await stores.fleet.get())?.foundation_version ?? null,
    }),
    rpc: new HermeticdRpc(stores.agents),
    directory: createDynamoDirectory({
      client: directoryFactory.client(DynamoDBClient),
      region: directoryRegion,
      accountId: opts.expectedAccountId,
    }),
    // §8.3: the two `List*` calls the model picker reads Bedrock's catalog
    // with, in the fleet's own region. Lazy — the client is built on the first
    // call — so a fleet that never opens the picker never constructs one.
    bedrock: {
      catalog: (signal?: AbortSignal) => bedrockApi(factory).catalog(signal),
    },
    clock: { now: () => new Date() },
  };
}

/**
 * `S3Artifacts` wants a bucket name at construction; the bucket name comes from
 * the stack. This defers the lookup to the first call without making every
 * artifact method async twice over.
 */
class LazyBucketArtifacts {
  private inner: Promise<S3Artifacts> | null = null;

  /**
   * Forget the bucket this was bound to. Called from `invalidateStackOutputs`:
   * the name came from the stack's outputs, so anything that changes which
   * stack answers changes this too (§4.8).
   */
  invalidate(): void {
    this.inner = null;
  }

  constructor(
    private readonly client: S3Client,
    private readonly bucket: () => Promise<string>,
  ) {}

  private get real(): Promise<S3Artifacts> {
    this.inner ??= this.bucket().then((name) => new S3Artifacts(this.client, name));
    return this.inner;
  }

  async putObject(key: string, body: Uint8Array, contentType?: string): Promise<void> {
    return (await this.real).putObject(key, body, contentType);
  }
  async purgeByPrefix(prefix: string): Promise<number> {
    return (await this.real).purgeByPrefix(prefix);
  }
  async copy(fromKey: string, toKey: string): Promise<void> {
    return (await this.real).copy(fromKey, toKey);
  }
  async exists(key: string): Promise<boolean> {
    return (await this.real).exists(key);
  }
  async getText(key: string): Promise<string | null> {
    return (await this.real).getText(key);
  }
  async getObject(key: string): Promise<Uint8Array | null> {
    return (await this.real).getObject(key);
  }
  async list(prefix: string): Promise<string[]> {
    return (await this.real).list(prefix);
  }
  async deleteByPrefix(prefix: string): Promise<string[]> {
    return (await this.real).deleteByPrefix(prefix);
  }
  async emptyBucket(onPage?: () => Promise<void>): Promise<number> {
    return (await this.real).emptyBucket(onPage);
  }
  async presign(key: string, expiresInSeconds?: number): Promise<string> {
    return (await this.real).presign(key, expiresInSeconds);
  }
}
