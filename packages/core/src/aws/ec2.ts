import {
  AttachVolumeCommand,
  CreateTagsCommand,
  CreateVolumeCommand,
  DeleteSnapshotCommand,
  DeleteTagsCommand,
  DeleteVolumeCommand,
  DescribeAddressesCommand,
  DescribeImagesCommand,
  DescribeInstancesCommand,
  DescribeInstanceStatusCommand,
  DescribeNetworkInterfacesCommand,
  DescribeSnapshotsCommand,
  DescribeRouteTablesCommand,
  DescribeSecurityGroupRulesCommand,
  DescribeSubnetsCommand,
  DescribeVolumesCommand,
  type EC2Client,
  GetConsoleOutputCommand,
  type Instance,
  RebootInstancesCommand,
  ReleaseAddressCommand,
  RunInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  type Tag,
  TerminateInstancesCommand,
  type Volume,
} from "@aws-sdk/client-ec2";
import type { NatHealth } from "../schema/index.ts";
import type {
  AddressRef,
  ComputeApi,
  ConsoleOutput,
  InstanceRef,
  InstanceStatusChecks,
  ManagedVolumeRef,
  NetworkInterfaceRef,
  VolumeDetail,
  OwnedVolumeStatus,
  RetagVolumeOptions,
  RunInstanceSpec,
  SnapshotRef,
  TagSelector,
  VolumeRef,
  VolumeStatus,
} from "../backend/types.ts";
import {
  AGENT_TAG,
  FLEET_ID_TAG,
  FORMER_AGENT_TAG,
  MANAGED_TAG,
  MANAGED_TAG_VALUE,
  ROLE_DATA,
  ROLE_TAG,
} from "../backend/constants.ts";
import { HermeticError } from "../errors.ts";
import {
  OWNED_VOLUME_ROLE,
  assertResourceOwned,
  type ResourceOwner,
  type ResourceTags,
} from "../agents/ownership.ts";
import { asHermeticError, isAwsError } from "./client.ts";
import { resolveUbuntuAmi } from "./ami.ts";
import type { SSMClient } from "@aws-sdk/client-ssm";

/** Where the data volume shows up on the box; `hermeticd` mounts it at `/data`. */
export const DATA_DEVICE = "/dev/sdf";

/** The one `BlockDeviceMappings` entry a launch carries: the root disk, resized. */
type RootDeviceMapping = {
  DeviceName: string;
  Ebs: { VolumeSize: number; VolumeType: "gp3"; DeleteOnTermination: true };
};

/**
 * EC2 answers "I have never heard of this id" with a throw, not an empty list.
 * For a describe-by-id that is the same answer as "no such resource" — and for
 * a *release* it is the same answer as success: the two Elastic IP spellings
 * are how EC2 reports an allocation that is already gone, which is the ordinary
 * outcome of a `DescribeAddresses` taken moments before `DeleteStack` finished
 * reaping the stack's own address (§4.6).
 */
function isNotFound(e: unknown): boolean {
  return isAwsError(
    e,
    "InvalidInstanceID.NotFound",
    "InvalidVolume.NotFound",
    "InvalidAllocationID.NotFound",
    "InvalidAddress.NotFound",
  );
}

/** Resolved once from the foundation stack's outputs. */
export interface NetworkRefs {
  subnet_ids: string[];
  security_group_id: string;
  instance_profile_arn: string;
}

function tagList(tags: Record<string, string>) {
  return Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));
}

/** The other direction: what a describe returned, as the map the §6.7 check reads. */
function tagMap(tags: Tag[] | undefined): ResourceTags {
  const found: Record<string, string> = {};
  for (const t of tags ?? []) if (t.Key !== undefined && t.Value !== undefined) found[t.Key] = t.Value;
  return found;
}

/** One `DescribeInstances` instance as the ref core passes around. */
function instanceRef(found: Instance): InstanceRef {
  return {
    instance_id: found.InstanceId as string,
    state: found.State?.Name ?? "unknown",
    public_ip: found.PublicIpAddress ?? null,
    // §5: which subnet the box is actually in, so `network.status` can say
    // whether it is still where the fleet launches today.
    subnet_id: found.SubnetId ?? null,
  };
}

/** One `DescribeVolumes` volume as the status core passes around. */
function volumeStatus(found: Volume): VolumeStatus {
  return {
    volume_id: found.VolumeId as string,
    size_gib: found.Size ?? 0,
    state: found.State ?? "unknown",
    attachments: (found.Attachments ?? []).flatMap((a) =>
      a.InstanceId ? [{ instance_id: a.InstanceId, state: String(a.State ?? "unknown") }] : [],
    ),
  };
}

/**
 * Where a launch is placed, and whether it gets a public IP. `RunInstances`
 * accepts two mutually exclusive shapes and this picks between them:
 *
 * - **Network mode known** — a `NetworkInterfaces[0]` block carrying the subnet,
 *   the security group and an explicit `AssociatePublicIpAddress`. EC2 rejects
 *   `AssociatePublicIpAddress` alongside a top-level `SubnetId`/`SecurityGroupIds`,
 *   so saying it explicitly means saying the rest here too. A `public` fleet asks
 *   for the address, a `nat` fleet refuses it, and neither depends on the subnet's
 *   `MapPublicIpOnLaunch` happening to agree (§6.2).
 * - **Network mode absent** — the historical top-level form, for a fleet written
 *   before the field existed and not yet back-filled by the foundation migration.
 *   Public IP assignment keeps being inherited from the subnet, exactly as before,
 *   so nothing about those fleets moves.
 *
 * `Ipv6AddressCount`/`Ipv6Addresses` are deliberately unset in both shapes: the
 * subnet's `AssignIpv6AddressOnCreation` is what hands out the v6 address, and
 * naming either field here would take that decision away from it.
 * `DeleteOnTermination` is likewise left at its default.
 */
function placement(subnetId: string, securityGroupId: string, network: "public" | "nat" | undefined) {
  if (network === undefined) {
    return { SubnetId: subnetId, SecurityGroupIds: [securityGroupId] };
  }
  return {
    NetworkInterfaces: [
      {
        DeviceIndex: 0,
        SubnetId: subnetId,
        Groups: [securityGroupId],
        AssociatePublicIpAddress: network === "public",
      },
    ],
  };
}

/**
 * EC2 (§6.2, §6.6). Every finder exists so a step can check reality before
 * acting — the idempotency rule of §4.5 — and every lookup is by tag, because
 * `agent=<name>` plus `hermetic:managed=true` plus `hermetic:fleet_id=<id>` is
 * the only identity a resource has. Nothing here is looked up by an id kept on
 * the laptop.
 *
 * The fleet tag is not decoration. An agent name is unique only *within* a
 * fleet, so in an account holding two of them `agent=atlas` matches two boxes
 * and two data volumes — and `destroy atlas` on one fleet would have been free
 * to terminate the other's. Every filter below therefore carries the fleet id,
 * and the one method that deliberately does not (`listUnscopedManaged`) says so
 * in its own name.
 */
export class Ec2Compute implements ComputeApi {
  private azCache: string | null = null;
  /** One `DescribeImages` per AMI, not per launch: the fleet pins one image (§7.1). */
  private readonly rootDeviceCache = new Map<string, { name: string; gib: number } | null>();

  constructor(
    private readonly ec2: EC2Client,
    private readonly ssm: SSMClient,
    private readonly region: string,
    private readonly refs: () => Promise<NetworkRefs>,
    /**
     * The fleet this backend is bound to. A function rather than a value
     * because `init` binds the fleet *after* the backend is built
     * (`FoundationApi.bindFleet`), and a snapshot taken at construction would
     * be the wrong id — or none — for every call after that.
     */
    private readonly fleetId: () => string,
  ) {}

  /**
   * Drop the cached launch AZ. Called by `aws/index.ts` whenever the stack's
   * outputs move, for the same reason the outputs memo is dropped there: a
   * re-network replaces `SubnetIds` with the other pair, and an AZ remembered
   * from the subnet the fleet used to launch into would decide where the next
   * `agent create --volume` looks for a disk. Today's template happens to put
   * `PublicSubnet0` and `PrivateSubnet0` in the same AZ, so the stale value
   * would still be right — this does not depend on that staying true.
   */
  invalidate(): void {
    this.azCache = null;
  }

  /**
   * What the AMI itself says about its root disk: the device it boots from and
   * the size that device comes at. `null` when the image cannot be described or
   * names no root device.
   *
   * Memoised per AMI because the fleet pins exactly one (§7.1), so this is one
   * describe for the life of the process rather than one per launch.
   */
  private async rootDevice(amiId: string): Promise<{ name: string; gib: number } | null> {
    const cached = this.rootDeviceCache.get(amiId);
    if (cached !== undefined) return cached;
    let found: { name: string; gib: number } | null = null;
    try {
      const out = await this.ec2.send(new DescribeImagesCommand({ ImageIds: [amiId] }));
      const image = out.Images?.[0];
      const name = image?.RootDeviceName;
      if (name) {
        const root = image?.BlockDeviceMappings?.find((m) => m.DeviceName === name);
        found = { name, gib: root?.Ebs?.VolumeSize ?? 0 };
      }
    } catch {
      found = null;
    }
    this.rootDeviceCache.set(amiId, found);
    return found;
  }

  /**
   * The root block device mapping a launch carries, or `null` for none.
   *
   * The device *name* is read off the AMI rather than assumed. Canonical's
   * arm64 images call it `/dev/sda1`, but a mapping whose `DeviceName` does not
   * match the image's `RootDeviceName` is not an error EC2 reports — it is an
   * *additional* volume, silently attached beside a root disk still at the
   * AMI's own default. That failure looks exactly like the change not working,
   * and bills for the extra disk while it does.
   *
   * The AMI's own size is the floor. EBS will not create a volume smaller than
   * the snapshot behind it (`InvalidBlockDeviceMapping`), so an image that ships
   * a root larger than what was asked for must be honoured rather than argued
   * with — and an operator who asked for `ROOT_GIB_MIN` on an image whose own
   * root is bigger gets the image's, not a failed launch.
   *
   * `null` when no size was asked for, or when the image could not be described:
   * the launch then proceeds with no mapping at all, which is the historical
   * shape and boots a working box on the AMI default. Refusing to launch over a
   * describe that failed would trade a box with a small root disk for no box.
   */
  private async rootDeviceMapping(
    amiId: string,
    rootGib: number | undefined,
  ): Promise<RootDeviceMapping | null> {
    if (rootGib === undefined) return null;
    const device = await this.rootDevice(amiId);
    if (!device) return null;
    return {
      DeviceName: device.name,
      Ebs: {
        VolumeSize: Math.max(rootGib, device.gib),
        VolumeType: "gp3",
        // Spelled out rather than inherited. An overriding mapping that omits
        // it is documented to take the AMI's value, but the cost of that
        // documentation being wrong is a root volume that survives
        // `TerminateInstances` — untagged, so `destroy` cannot see it and
        // `volume ls` will not list it, and nothing but the console would ever
        // notice it billing.
        DeleteOnTermination: true,
      },
    };
  }

  /** The filter clause every instance and volume lookup carries. */
  private fleetFilter(): { Name: string; Values: string[] } {
    return { Name: `tag:${FLEET_ID_TAG}`, Values: [this.fleetId()] };
  }

  /** The AZ of the subnet agents launch into; a volume must share it. */
  private async launchSubnet(): Promise<{ subnet_id: string; az: string }> {
    const { subnet_ids } = await this.refs();
    const subnet_id = subnet_ids[0];
    if (!subnet_id) {
      throw new HermeticError("FLEET_MISMATCH", "the foundation stack exported no subnets", {});
    }
    if (this.azCache) return { subnet_id, az: this.azCache };
    const out = await this.ec2.send(new DescribeSubnetsCommand({ SubnetIds: [subnet_id] }));
    const az = out.Subnets?.[0]?.AvailabilityZone;
    if (!az) {
      throw new HermeticError("FLEET_MISMATCH", `subnet ${subnet_id} has no availability zone`, {
        subnet_id,
      });
    }
    this.azCache = az;
    return { subnet_id, az };
  }

  /**
   * The data volume for one agent — the disk that outlives instances and holds
   * everything the agent has learned (§1). Getting this wrong is the worst
   * failure mode in hermetic, so the query is deliberately wide and the
   * disambiguation deliberately narrow:
   *
   * - Filter only on `agent=<name>` + `hermetic:managed=true`. Filtering on
   *   `hermetic:role=data` in the query would make a volume created before that
   *   tag existed *invisible*, and create would silently provision a fresh empty
   *   one — orphaning the agent's memory rather than failing.
   * - Exactly one candidate is it, and it gets the `role` tag on the way past.
   * - Several candidates: the `role=data` one wins (the others are root disks).
   * - Several, none tagged, or more than one tagged: refuse. Guessing which disk
   *   holds an agent's memory is not a decision code gets to make.
   */
  async findVolumeByTag(name: string): Promise<VolumeRef | null> {
    // `agent=<name>` only. A kept volume a destroy released carries
    // `hermetic:former_agent=<name>` instead (§6.7), and must stay invisible
    // here so a later `create` of the same name starts fresh.
    const out = await this.ec2.send(
      new DescribeVolumesCommand({
        Filters: [
          { Name: `tag:${AGENT_TAG}`, Values: [name] },
          { Name: `tag:${MANAGED_TAG}`, Values: [MANAGED_TAG_VALUE] },
          this.fleetFilter(),
        ],
      }),
    );
    const candidates = (out.Volumes ?? []).filter(
      (v) => v.VolumeId && v.State !== "deleting" && v.State !== "deleted",
    );
    if (candidates.length === 0) return null;

    const ref = (v: (typeof candidates)[number]): VolumeRef => ({
      volume_id: v.VolumeId as string,
      size_gib: v.Size ?? 0,
      state: v.State ?? "unknown",
    });
    const isData = (v: (typeof candidates)[number]): boolean =>
      (v.Tags ?? []).some((t) => t.Key === ROLE_TAG && t.Value === ROLE_DATA);

    if (candidates.length === 1) {
      const only = candidates[0]!;
      // Adopt a volume from before the role tag existed, and label it so the
      // next lookup — and the snapshot policy — can see what it is.
      if (!isData(only)) await this.tagAsData(only.VolumeId as string);
      return ref(only);
    }

    const tagged = candidates.filter(isData);
    if (tagged.length === 1) return ref(tagged[0]!);

    throw new HermeticError(
      "CONFLICT",
      tagged.length === 0
        ? `${name} has ${candidates.length} managed volumes and none is tagged ${ROLE_TAG}=${ROLE_DATA}; hermetic will not guess which one holds its memory`
        : `${name} has ${tagged.length} volumes tagged ${ROLE_TAG}=${ROLE_DATA}; hermetic will not guess which one holds its memory`,
      {
        name,
        volume_ids: candidates.map((v) => v.VolumeId),
        data_volume_ids: tagged.map((v) => v.VolumeId),
      },
    );
  }

  /** Best effort: an untagged volume is still usable, just unlabelled. */
  private async tagAsData(volumeId: string): Promise<void> {
    try {
      await this.ec2.send(
        new CreateTagsCommand({
          Resources: [volumeId],
          Tags: [{ Key: ROLE_TAG, Value: ROLE_DATA }],
        }),
      );
    } catch {
      // Not fatal: the volume is the right one either way.
    }
  }

  /** gp3, encrypted with the AWS-managed EBS key (§7.1). Volumes are precious. */
  async createVolume(name: string, sizeGib: number, nameTag?: string): Promise<VolumeRef> {
    const { az } = await this.launchSubnet();
    try {
      const out = await this.ec2.send(
        new CreateVolumeCommand({
          AvailabilityZone: az,
          Size: sizeGib,
          VolumeType: "gp3",
          Encrypted: true,
          TagSpecifications: [
            {
              ResourceType: "volume",
              Tags: tagList({
                [AGENT_TAG]: name,
                [MANAGED_TAG]: MANAGED_TAG_VALUE,
                [FLEET_ID_TAG]: this.fleetId(),
                [ROLE_TAG]: ROLE_DATA,
                ...(nameTag === undefined ? {} : { Name: nameTag }),
              }),
            },
          ],
        }),
      );
      if (!out.VolumeId) {
        throw new HermeticError("INTERNAL", `CreateVolume for ${name} returned no volume id`, { name });
      }
      return { volume_id: out.VolumeId, size_gib: out.Size ?? sizeGib, state: out.State ?? "creating" };
    } catch (e) {
      throw asHermeticError(e, `could not create the data volume for ${name}`);
    }
  }

  /**
   * Deleting a volume EC2 has already forgotten is success, not a failure:
   * `destroy` is re-run to finish an interrupted one (§4.5), and the second run
   * must not die on the step the first one completed. The caller is responsible
   * for the volume being *free* — `waitVolumeReleased` in `attach.ts` owns that
   * wait, because a volume still detaching from a just-terminated instance is
   * `VolumeInUse` here, and that is a "too early", not a "no".
   */
  async deleteVolume(volumeId: string): Promise<void> {
    try {
      await this.ec2.send(new DeleteVolumeCommand({ VolumeId: volumeId }));
    } catch (e) {
      if (isNotFound(e)) return;
      throw asHermeticError(e, `could not delete volume ${volumeId}`);
    }
  }

  /**
   * Every live managed instance tagged for this agent, paged out in full. AWS
   * does not enforce one box per agent tag, so a list is the only honest
   * answer: the caller picks which one is the agent's, and sees the rest.
   * `shuttingDown` adds the boxes on their way out (see `ComputeApi`).
   */
  async listInstancesByTag(
    name: string,
    opts: { shuttingDown?: boolean } = {},
  ): Promise<InstanceRef[]> {
    const states = ["pending", "running", "stopping", "stopped"];
    if (opts.shuttingDown) states.push("shutting-down");
    const results: InstanceRef[] = [];
    let token: string | undefined;
    do {
      const out = await this.ec2.send(
        new DescribeInstancesCommand({
          Filters: [
            { Name: `tag:${AGENT_TAG}`, Values: [name] },
            { Name: `tag:${MANAGED_TAG}`, Values: [MANAGED_TAG_VALUE] },
            this.fleetFilter(),
            { Name: "instance-state-name", Values: states },
          ],
          ...(token ? { NextToken: token } : {}),
        }),
      );
      for (const reservation of out.Reservations ?? []) {
        for (const instance of reservation.Instances ?? []) {
          if (!instance.InstanceId) continue;
          results.push({
            instance_id: instance.InstanceId,
            state: instance.State?.Name ?? "unknown",
            public_ip: instance.PublicIpAddress ?? null,
          });
        }
      }
      token = out.NextToken;
    } while (token);
    return results;
  }

  /**
   * §6.2 step 7. Launch only — user-data carries the name, the parameter *path*,
   * the presigned URL and the SHA-256, never a value (§6.3). The data volume is
   * attached by `attachVolume` after the caller has persisted this instance id
   * onto the agent row: attach can fail (volume not yet available, instance
   * still settling) and an id that only lived in this return value would be
   * lost.
   */
  async runInstance(spec: RunInstanceSpec): Promise<InstanceRef> {
    const { subnet_id } = await this.launchSubnet();
    const { security_group_id, instance_profile_arn } = await this.refs();
    const rootDevice = await this.rootDeviceMapping(spec.ami_id, spec.root_gib);
    const tags = tagList({
      ...spec.tags,
      [MANAGED_TAG]: MANAGED_TAG_VALUE,
      [FLEET_ID_TAG]: this.fleetId(),
    });

    try {
      const out = await this.ec2.send(
        new RunInstancesCommand({
          ImageId: spec.ami_id,
          InstanceType: spec.instance_type as never,
          MinCount: 1,
          MaxCount: 1,
          ...placement(subnet_id, security_group_id, spec.network),
          IamInstanceProfile: { Arn: instance_profile_arn },
          UserData: Buffer.from(spec.user_data, "utf8").toString("base64"),
          MetadataOptions: { HttpTokens: "required", HttpEndpoint: "enabled" },
          /**
           * The root disk only, and only to resize it (§7.1). The data volume
           * is never a mapping here: it is its own `CreateVolume` plus an
           * attach, so that it can outlive the instance (§1).
           */
          ...(rootDevice === null ? {} : { BlockDeviceMappings: [rootDevice] }),
          /**
           * The instance only. Tagging `volume` here would stamp `agent=<name>`
           * and `hermetic:managed=true` onto the *root* volume as well, and
           * `findVolumeByTag` would then be free to return it — a resume would
           * attach the root disk and `destroy`, which deletes the data volume by
           * default (§6.7), could delete it.
           * The data volume is tagged at `CreateVolume`, where it is the only
           * thing being tagged.
           */
          TagSpecifications: [{ ResourceType: "instance", Tags: tags }],
        }),
      );
      const created = out.Instances?.[0];
      if (!created?.InstanceId) {
        throw new HermeticError("INTERNAL", `RunInstances for ${spec.name} returned no instance`, {
          name: spec.name,
        });
      }
      return {
        instance_id: created.InstanceId,
        state: created.State?.Name ?? "pending",
        public_ip: created.PublicIpAddress ?? null,
      };
    } catch (e) {
      throw asHermeticError(e, `could not launch an instance for ${spec.name}`);
    }
  }

  /**
   * Every ENI in the named subnets (§5) — the real answer to "can CloudFormation
   * delete these", which the agents table only approximates.
   *
   * Deliberately unfiltered by tag or by fleet. The interfaces that make a
   * subnet undeletable are exactly the ones nobody tagged: a create that spent
   * money and then lost the instance id, a box an operator launched by hand,
   * anything else that wandered into the VPC. Paginated because a large fleet's
   * private pair holds one interface per box and `DescribeNetworkInterfaces`
   * pages at a thousand.
   *
   * An empty `subnetIds` is an empty answer rather than a describe with no
   * filter, which would return every interface in the region.
   */
  async listNetworkInterfaces(subnetIds: readonly string[]): Promise<NetworkInterfaceRef[]> {
    if (subnetIds.length === 0) return [];
    const found: NetworkInterfaceRef[] = [];
    let token: string | undefined;
    try {
      do {
        const out = await this.ec2.send(
          new DescribeNetworkInterfacesCommand({
            Filters: [{ Name: "subnet-id", Values: [...subnetIds] }],
            ...(token ? { NextToken: token } : {}),
          }),
        );
        for (const eni of out.NetworkInterfaces ?? []) {
          if (!eni.NetworkInterfaceId || !eni.SubnetId) continue;
          found.push({
            id: eni.NetworkInterfaceId,
            subnet_id: eni.SubnetId,
            instance_id: eni.Attachment?.InstanceId ?? null,
            description: eni.Description ?? null,
          });
        }
        token = out.NextToken;
      } while (token);
    } catch (e) {
      throw asHermeticError(e, `could not list the network interfaces in ${subnetIds.join(", ")}`);
    }
    return found;
  }

  /**
   * One instance by id, including terminated ones — `listInstancesByTag` filters
   * those out, and the attach waiter needs to tell "still booting" from "gone".
   */
  async describeInstance(instanceId: string): Promise<InstanceRef | null> {
    const found = await this.rawInstance(instanceId);
    return found === null ? null : instanceRef(found);
  }

  /**
   * §6.7: the same describe, with the tags read off it. The ids `destroy` and
   * `recreate` terminate come from the agent row, which the box itself can
   * write, so the tags are what says the box is ours to terminate.
   */
  async describeOwnedInstance(instanceId: string, owner: ResourceOwner): Promise<InstanceRef | null> {
    const found = await this.rawInstance(instanceId);
    if (found === null) return null;
    assertResourceOwned("instance", instanceId, owner, tagMap(found.Tags));
    return instanceRef(found);
  }

  /** `DescribeInstances` for one id, with EC2's "never heard of it" read as gone. */
  private async rawInstance(instanceId: string): Promise<Instance | null> {
    try {
      const out = await this.ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
      const found = out.Reservations?.[0]?.Instances?.[0];
      return found?.InstanceId ? found : null;
    } catch (e) {
      // An id EC2 has already forgotten is "gone", not a failure to look.
      if (isNotFound(e)) return null;
      throw asHermeticError(e, `could not describe instance ${instanceId}`);
    }
  }

  /**
   * `DescribeInstanceStatus` for one instance, with `IncludeAllInstances` so a
   * `stopped` box answers at all — the default filters to `running` only, which
   * would make "stopped" and "gone" the same empty response, and telling those
   * two apart is most of what `agents.probe` is for (§9).
   *
   * A stopped instance comes back with a state and no summaries; that is not a
   * failure, it is EC2 saying it has no opinion about a box that is not on.
   */
  async describeInstanceStatus(instanceId: string): Promise<InstanceStatusChecks | null> {
    try {
      const out = await this.ec2.send(
        new DescribeInstanceStatusCommand({
          InstanceIds: [instanceId],
          IncludeAllInstances: true,
        }),
      );
      const found = out.InstanceStatuses?.[0];
      if (!found?.InstanceId) return null;
      return {
        instance_id: found.InstanceId,
        state: found.InstanceState?.Name ?? "unknown",
        system_status: found.SystemStatus?.Status ?? null,
        instance_status: found.InstanceStatus?.Status ?? null,
      };
    } catch (e) {
      // Same reading as `describeInstance`: an id EC2 has forgotten is "gone".
      if (isNotFound(e)) return null;
      throw asHermeticError(e, `could not describe status checks for ${instanceId}`);
    }
  }

  /**
   * `GetConsoleOutput --latest`: the last ~64 KiB EC2 buffered from the serial
   * console. Empty for the first minute or two of a boot, and empty forever for
   * a box that never printed, so "nothing yet" is `null` rather than an error —
   * the caller's job is to say "the box has not said anything yet", not to fail.
   */
  async consoleOutput(instanceId: string): Promise<ConsoleOutput | null> {
    try {
      const out = await this.ec2.send(
        new GetConsoleOutputCommand({ InstanceId: instanceId, Latest: true }),
      );
      // `Output` comes back base64-encoded, always: it is a raw serial buffer,
      // not text the API can promise is UTF-8. The `aws` CLI decodes it as a
      // courtesy to humans; the JS SDK hands it over as it arrived, so decoding
      // is ours to do — otherwise `logs --console` prints one 64 KiB blob.
      const output = Buffer.from(out.Output ?? "", "base64").toString("utf8");
      if (output.trim().length === 0) return null;
      return { at: (out.Timestamp ?? new Date()).toISOString(), output };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw asHermeticError(e, `could not read the console output of ${instanceId}`);
    }
  }

  /**
   * One volume by id, with its attachments. Looked up by id and not by tag on
   * purpose: this answers "is *this* disk free", which the tag lookup cannot.
   */
  async describeVolume(volumeId: string): Promise<VolumeStatus | null> {
    const found = await this.rawVolume(volumeId);
    return found === null ? null : volumeStatus(found);
  }

  /**
   * §6.7: the same describe, refusing a disk whose tags name another agent,
   * another fleet, or a root device. `destroy` deletes the id the agent row
   * carries by default — `--keep-volume` instead releases it under
   * `hermetic:former_agent` (§6.7) — and that row is writable by the box.
   */
  async describeOwnedVolume(volumeId: string, owner: ResourceOwner): Promise<OwnedVolumeStatus | null> {
    const found = await this.rawVolume(volumeId);
    if (found === null) return null;
    const tags = tagMap(found.Tags);
    assertResourceOwned("volume", volumeId, owner, tags, OWNED_VOLUME_ROLE);
    return { ...volumeStatus(found), former_agent: tags[FORMER_AGENT_TAG] ?? null };
  }

  /** `DescribeVolumes` for one id, with EC2's "never heard of it" read as gone. */
  private async rawVolume(volumeId: string): Promise<Volume | null> {
    try {
      const out = await this.ec2.send(new DescribeVolumesCommand({ VolumeIds: [volumeId] }));
      const found = out.Volumes?.[0];
      return found?.VolumeId ? found : null;
    } catch (e) {
      if (isNotFound(e)) return null;
      throw asHermeticError(e, `could not describe volume ${volumeId}`);
    }
  }

  /**
   * The raw call. Every precondition — the instance being `running`, the volume
   * being free — belongs to `attachAgentVolume` in `attach.ts`, which polls for
   * them and can therefore wait rather than fail. Sending this too early is an
   * ordinary transient error there, so nothing is classified here.
   */
  async attachVolume(instanceId: string, volumeId: string): Promise<void> {
    try {
      await this.ec2.send(
        new AttachVolumeCommand({
          InstanceId: instanceId,
          VolumeId: volumeId,
          Device: DATA_DEVICE,
        }),
      );
    } catch (e) {
      throw asHermeticError(e, `could not attach volume ${volumeId} to ${instanceId}`);
    }
  }

  /** An instance EC2 has already forgotten is terminated, which is the goal. */
  async terminate(instanceId: string): Promise<void> {
    try {
      await this.ec2.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
    } catch (e) {
      if (isNotFound(e)) return;
      throw asHermeticError(e, `could not terminate instance ${instanceId}`);
    }
  }

  async stop(instanceId: string): Promise<void> {
    try {
      await this.ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
    } catch (e) {
      throw asHermeticError(e, `could not stop instance ${instanceId}`);
    }
  }

  /**
   * `RebootInstances` is asynchronous and returns nothing useful: EC2 asks the
   * guest OS to reboot and falls back to a hard reset if it does not comply.
   * The instance stays `running` throughout, so there is no state to await.
   */
  async reboot(instanceId: string): Promise<void> {
    try {
      await this.ec2.send(new RebootInstancesCommand({ InstanceIds: [instanceId] }));
    } catch (e) {
      throw asHermeticError(e, `could not reboot instance ${instanceId}`);
    }
  }

  async start(instanceId: string): Promise<InstanceRef> {
    try {
      const out = await this.ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
      const state = out.StartingInstances?.[0]?.CurrentState?.Name ?? "pending";
      return { instance_id: instanceId, state, public_ip: null };
    } catch (e) {
      throw asHermeticError(e, `could not start instance ${instanceId}`);
    }
  }

  /**
   * The sealing invariant (§5, §11.3). `DescribeSecurityGroupRules` reports
   * ingress and egress in one list; only the ingress half may ever be empty.
   */
  async describeSecurityGroupInbound(): Promise<
    Array<{ protocol: string; from: number; to: number; cidr: string }>
  > {
    const { security_group_id } = await this.refs();
    const rules: Array<{ protocol: string; from: number; to: number; cidr: string }> = [];
    let token: string | undefined;
    do {
      const out = await this.ec2.send(
        new DescribeSecurityGroupRulesCommand({
          Filters: [{ Name: "group-id", Values: [security_group_id] }],
          ...(token ? { NextToken: token } : {}),
        }),
      );
      for (const rule of out.SecurityGroupRules ?? []) {
        if (rule.IsEgress !== false) continue;
        rules.push({
          protocol: rule.IpProtocol ?? "-1",
          from: rule.FromPort ?? -1,
          to: rule.ToPort ?? -1,
          cidr: rule.CidrIpv4 ?? rule.CidrIpv6 ?? rule.ReferencedGroupInfo?.GroupId ?? "(unknown)",
        });
      }
      token = out.NextToken;
    } while (token);
    return rules;
  }

  /** The fleet's pinned stock image, from Canonical's public SSM parameter. */
  async resolveUbuntuAmi(): Promise<string> {
    return resolveUbuntuAmi(this.ssm, this.region);
  }

  /** §9: every instance hermetic manages, for `doctor`'s EC2/DynamoDB reconciliation. */
  async listManagedInstances(): Promise<
    Array<{ instance_id: string; agent: string | null; state: string }>
  > {
    const results: Array<{ instance_id: string; agent: string | null; state: string }> = [];
    let token: string | undefined;
    do {
      const out = await this.ec2.send(
        new DescribeInstancesCommand({
          Filters: [
            { Name: `tag:${MANAGED_TAG}`, Values: [MANAGED_TAG_VALUE] },
            this.fleetFilter(),
            {
              Name: "instance-state-name",
              Values: ["pending", "running", "shutting-down", "stopping", "stopped"],
            },
          ],
          ...(token ? { NextToken: token } : {}),
        }),
      );
      for (const reservation of out.Reservations ?? []) {
        for (const instance of reservation.Instances ?? []) {
          if (!instance.InstanceId) continue;
          const agentTag = (instance.Tags ?? []).find((t) => t.Key === AGENT_TAG)?.Value;
          results.push({
            instance_id: instance.InstanceId,
            agent: agentTag ?? null,
            state: instance.State?.Name ?? "unknown",
          });
        }
      }
      token = out.NextToken;
    } while (token);
    return results;
  }

  /**
   * §6.6 keeps a data volume by default, so an account that has seen agents come
   * and go accumulates volumes no agent row names any more. `teardown
   * --delete-volumes` is the only thing that can find them, and the managed tag
   * is the only handle it has: the row that recorded the id is long gone.
   */
  async listManagedVolumes(): Promise<ManagedVolumeRef[]> {
    return this.describeManagedVolumes([]);
  }

  /**
   * `findVolumeByTag`'s query — `agent=<name>`, managed, this fleet, no role
   * filter — paged to the end, and nothing else: no `role=data` label on a
   * lone match, no `CONFLICT` on several. Read-only by construction, because
   * the release that calls it (§6.7) is cleaning up exactly the duplicates
   * `findVolumeByTag` refuses to choose between.
   */
  async listVolumesByAgentTag(name: string): Promise<ManagedVolumeRef[]> {
    return this.describeManagedVolumes([{ Name: `tag:${AGENT_TAG}`, Values: [name] }]);
  }

  /** Every managed volume in this fleet matching `extra` too, paged, none going away. */
  private async describeManagedVolumes(
    extra: Array<{ Name: string; Values: string[] }>,
  ): Promise<ManagedVolumeRef[]> {
    const results: ManagedVolumeRef[] = [];
    let token: string | undefined;
    do {
      const out = await this.ec2.send(
        new DescribeVolumesCommand({
          Filters: [
            ...extra,
            { Name: `tag:${MANAGED_TAG}`, Values: [MANAGED_TAG_VALUE] },
            this.fleetFilter(),
          ],
          ...(token ? { NextToken: token } : {}),
        }),
      );
      for (const volume of out.Volumes ?? []) {
        if (!volume.VolumeId) continue;
        if (volume.State === "deleting" || volume.State === "deleted") continue;
        results.push({
          volume_id: volume.VolumeId,
          size_gib: volume.Size ?? 0,
          agent: (volume.Tags ?? []).find((t) => t.Key === AGENT_TAG)?.Value ?? null,
          former_agent: (volume.Tags ?? []).find((t) => t.Key === FORMER_AGENT_TAG)?.Value ?? null,
          state: volume.State ?? "unknown",
          created_at: volume.CreateTime ? volume.CreateTime.toISOString() : null,
        });
      }
      token = out.NextToken;
    } while (token);
    return results;
  }

  /**
   * §9's volume inventory. Two queries, merged by id, because the two halves
   * have nothing in common but the answer they belong to: everything carrying
   * `hermetic:managed=true` in any state, and everything `available` — the
   * unattached volumes hermetic did not make, which bill exactly as much as the
   * ones it did. A volume already going away is not reported (§6.6).
   */
  async listVolumes(): Promise<VolumeDetail[]> {
    const byId = new Map<string, VolumeDetail>();
    const queries: Array<Array<{ Name: string; Values: string[] }>> = [
      [{ Name: `tag:${MANAGED_TAG}`, Values: [MANAGED_TAG_VALUE] }, this.fleetFilter()],
      /**
       * Deliberately unscoped: an unattached volume bills the account whoever
       * made it, and §9's inventory is about spend as much as about ownership.
       * What it must *not* do is present another fleet's data volume as this
       * fleet's to reclaim, so a volume whose fleet tag names somebody else is
       * dropped below — an *absent* tag is kept, because that is a pre-v3
       * leftover or an operator's own disk, which is exactly what this query
       * exists to surface.
       */
      [{ Name: "status", Values: ["available"] }],
    ];
    for (const Filters of queries) {
      let token: string | undefined;
      do {
        const out = await this.ec2.send(
          new DescribeVolumesCommand({ Filters, ...(token ? { NextToken: token } : {}) }),
        );
        for (const volume of out.Volumes ?? []) {
          if (!volume.VolumeId) continue;
          if (volume.State === "deleting" || volume.State === "deleted") continue;
          if (byId.has(volume.VolumeId)) continue;
          const tags: Record<string, string> = {};
          for (const t of volume.Tags ?? []) if (t.Key) tags[t.Key] = t.Value ?? "";
          // Another fleet's volume, and therefore another fleet's to reclaim,
          // rename or delete. Never listed here (§5).
          const owner = tags[FLEET_ID_TAG];
          if (owner !== undefined && owner !== this.fleetId()) continue;
          byId.set(volume.VolumeId, {
            volume_id: volume.VolumeId,
            size_gib: volume.Size ?? 0,
            state: volume.State ?? "unknown",
            availability_zone: volume.AvailabilityZone ?? null,
            created_at: volume.CreateTime ? volume.CreateTime.toISOString() : null,
            agent: tags[AGENT_TAG] ?? null,
            former_agent: tags[FORMER_AGENT_TAG] ?? null,
            managed: tags[MANAGED_TAG] === MANAGED_TAG_VALUE,
            role_data: tags[ROLE_TAG] === ROLE_DATA,
            tags,
            attachments: (volume.Attachments ?? []).flatMap((a) =>
              a.InstanceId ? [{ instance_id: a.InstanceId, state: String(a.State ?? "unknown") }] : [],
            ),
          });
        }
        token = out.NextToken;
      } while (token);
    }
    return [...byId.values()].sort((a, b) => (a.volume_id < b.volume_id ? -1 : 1));
  }

  /** The AZ every agent instance launches into, and therefore the only AZ a data volume may be in. */
  async launchAz(): Promise<string> {
    return (await this.launchSubnet()).az;
  }

  /**
   * `agent create --volume <id>` under a name the volume was not tagged with.
   * Both tags in one call: the `agent` tag is what `findVolumeByTag` reads, and
   * `role=data` is what keeps the pair unambiguous if the old name is ever
   * reused. `formerAgent` is the `hermetic:former_agent` tag a destroy that
   * keeps the volume moves the name to (§6.7): set, removed (`null`), or left
   * alone (absent), like `name`. `expectedAgent` makes removing `agent`
   * conditional on its value (`ComputeApi.retagVolume`).
   */
  async retagVolume(
    volumeId: string,
    agent: string | null,
    opts: RetagVolumeOptions = {},
  ): Promise<void> {
    const roleData = opts.roleData ?? true;
    /**
     * Absent means "leave the Name tag alone"; `null` means "no Name tag". It
     * is no longer derived from the agent: the display name is
     * `<fleet id>-<agent>-data` since v4 and only the caller knows the fleet.
     */
    const nameTag = opts.name;
    /**
     * Two calls at most, and only the ones that have something to say: EC2 has
     * no "set these tags and remove those" verb, so putting a volume back the
     * way `rollback.ts` found it — no agent tag, or no `role=data` — needs a
     * `DeleteTags` beside the `CreateTags`.
     *
     * The order is load-bearing: the `CreateTags` goes first. A release that
     * keeps the volume sets `former_agent=<name>` there and removes `agent` in
     * the `DeleteTags`, so a crash between the two leaves a volume carrying
     * both — which `release-name.ts` reads as "kept", never as "this agent's
     * disk to delete". The other order would leave a window in which the
     * volume says nothing about the promise to keep it.
     *
     * The order does not make that pair unambiguous on its own: an adoption
     * of a released disk (`create --volume`) sets `agent=<name>` here and
     * removes `former_agent` in the `DeleteTags`, so a crash between its two
     * calls leaves the same pair. The adopt path's resume tells them apart
     * and finishes its own rewrite (`create-agent.ts`), so no row survives
     * naming a disk an adoption left half-retagged.
     */
    const set: Record<string, string> = {
      [MANAGED_TAG]: MANAGED_TAG_VALUE,
      [FLEET_ID_TAG]: this.fleetId(),
    };
    /**
     * Each removal is a bare key, which `DeleteTags` deletes whatever its value
     * — except `agent` under `expectedAgent`, which carries the value and so
     * is deleted only while the volume still says that agent. The release's
     * sweep lists a disk and writes it a moment later (§6.7), and in between
     * another agent's adoption may have retagged it `agent=<other>`; an
     * unconditional delete would strip the new owner's tag and leave its live
     * row naming a disk `findVolumeByTag` no longer finds.
     */
    const remove: Array<{ Key: string; Value?: string }> = [];
    if (agent === null) {
      remove.push(
        opts.expectedAgent === undefined
          ? { Key: AGENT_TAG }
          : { Key: AGENT_TAG, Value: opts.expectedAgent },
      );
    } else set[AGENT_TAG] = agent;
    if (nameTag === null) remove.push({ Key: "Name" });
    else if (nameTag !== undefined) set["Name"] = nameTag;
    if (opts.formerAgent === null) remove.push({ Key: FORMER_AGENT_TAG });
    else if (opts.formerAgent !== undefined) set[FORMER_AGENT_TAG] = opts.formerAgent;
    if (roleData) set[ROLE_TAG] = ROLE_DATA;
    else remove.push({ Key: ROLE_TAG });
    try {
      await this.ec2.send(new CreateTagsCommand({ Resources: [volumeId], Tags: tagList(set) }));
      if (remove.length > 0) {
        await this.ec2.send(new DeleteTagsCommand({ Resources: [volumeId], Tags: remove }));
      }
    } catch (e) {
      throw asHermeticError(e, `could not retag volume ${volumeId} for ${agent ?? "no agent"}`);
    }
  }

  /**
   * The DLM policy of §7.1 copies the volume's tags onto every snapshot it
   * takes, so `hermetic:role=data` is what identifies a hermetic snapshot.
   * `OwnerIds: ["self"]` keeps the public snapshot catalogue out of the answer.
   */
  /**
   * §6.6 v3's legacy sweep: managed instances and volumes with no
   * `hermetic:fleet_id` tag at all. EC2 has no "tag is absent" filter, so the
   * managed set is listed and filtered here.
   */
  async listUnscopedManaged(): Promise<{ instances: string[]; volumes: string[] }> {
    const instances: string[] = [];
    const volumes: string[] = [];
    let token: string | undefined;
    do {
      const out = await this.ec2.send(
        new DescribeInstancesCommand({
          Filters: [
            { Name: `tag:${MANAGED_TAG}`, Values: [MANAGED_TAG_VALUE] },
            {
              Name: "instance-state-name",
              Values: ["pending", "running", "shutting-down", "stopping", "stopped"],
            },
          ],
          ...(token ? { NextToken: token } : {}),
        }),
      );
      for (const reservation of out.Reservations ?? []) {
        for (const instance of reservation.Instances ?? []) {
          if (!instance.InstanceId) continue;
          if ((instance.Tags ?? []).some((t) => t.Key === FLEET_ID_TAG)) continue;
          instances.push(instance.InstanceId);
        }
      }
      token = out.NextToken;
    } while (token);
    let volToken: string | undefined;
    do {
      const page = await this.ec2.send(
        new DescribeVolumesCommand({
          Filters: [{ Name: `tag:${MANAGED_TAG}`, Values: [MANAGED_TAG_VALUE] }],
          ...(volToken ? { NextToken: volToken } : {}),
        }),
      );
      for (const volume of page.Volumes ?? []) {
        if (!volume.VolumeId) continue;
        if (volume.State === "deleting" || volume.State === "deleted") continue;
        if ((volume.Tags ?? []).some((t) => t.Key === FLEET_ID_TAG)) continue;
        volumes.push(volume.VolumeId);
      }
      volToken = page.NextToken;
    } while (volToken);
    return { instances, volumes };
  }

  /** Adopt resources into this fleet. `CreateTags` overwrites, so a re-run is free. */
  async tagFleetId(resourceIds: readonly string[]): Promise<void> {
    if (resourceIds.length === 0) return;
    // `CreateTags` takes at most 1000 resources per call; batch well under it.
    for (let i = 0; i < resourceIds.length; i += 200) {
      const batch = resourceIds.slice(i, i + 200);
      try {
        await this.ec2.send(
          new CreateTagsCommand({
            Resources: [...batch],
            Tags: [{ Key: FLEET_ID_TAG, Value: this.fleetId() }],
          }),
        );
      } catch (e) {
        throw asHermeticError(e, `could not tag ${batch.length} resource(s) with the fleet id`);
      }
    }
  }

  async listSnapshots(tag: TagSelector): Promise<SnapshotRef[]> {
    const results: SnapshotRef[] = [];
    let token: string | undefined;
    do {
      const out = await this.ec2.send(
        new DescribeSnapshotsCommand({
          OwnerIds: ["self"],
          /**
           * The fleet clause is not optional here either. Every fleet's DLM
           * policy tags its snapshots `hermetic:role=data`, so the selector
           * alone matches the *account's* snapshots — and `teardown
           * --delete-snapshots` deletes what this returns.
           */
          Filters: [{ Name: `tag:${tag.key}`, Values: [tag.value] }, this.fleetFilter()],
          ...(token ? { NextToken: token } : {}),
        }),
      );
      for (const snapshot of out.Snapshots ?? []) {
        if (!snapshot.SnapshotId) continue;
        results.push({
          snapshot_id: snapshot.SnapshotId,
          volume_id: snapshot.VolumeId ?? "(unknown)",
          size_gib: snapshot.VolumeSize ?? 0,
          started_at: (snapshot.StartTime ?? new Date(0)).toISOString(),
        });
      }
      token = out.NextToken;
    } while (token);
    return results;
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    try {
      await this.ec2.send(new DeleteSnapshotCommand({ SnapshotId: snapshotId }));
    } catch (e) {
      throw asHermeticError(e, `could not delete snapshot ${snapshotId}`);
    }
  }

  /**
   * §4.6's leftover sweep. A `nat` foundation allocates an Elastic IP for the
   * NAT instance, and `DeleteStack` only deletes the allocation if its
   * association released first — when it did not, the address survives the
   * stack, bills `EIP_MONTHLY_COST` a month and is named by nothing hermetic prints.
   *
   * `DescribeAddresses` is not paginated (an account's allocations are few, and
   * the API returns them all), so there is no `NextToken` loop here.
   */
  async listAddresses(tag: TagSelector): Promise<AddressRef[]> {
    const out = await this.ec2.send(
      new DescribeAddressesCommand({
        /**
         * The selector, and then this fleet's clause — unconditionally, exactly
         * as `listSnapshots` does it. Scoping is this class's invariant and not
         * something a caller's selector is trusted to have got right: what comes
         * back is released under `--purge`, and one wrong selector would be one
         * `ReleaseAddress` against another fleet's egress address. When the
         * caller's tag *is* the fleet tag the same clause is simply sent twice,
         * which EC2 ANDs to the same answer.
         */
        Filters: [{ Name: `tag:${tag.key}`, Values: [tag.value] }, this.fleetFilter()],
      }),
    );
    const results: AddressRef[] = [];
    for (const address of out.Addresses ?? []) {
      if (!address.AllocationId) continue;
      const tags: Record<string, string> = {};
      for (const t of address.Tags ?? []) if (t.Key) tags[t.Key] = t.Value ?? "";
      results.push({
        allocation_id: address.AllocationId,
        public_ip: address.PublicIp ?? "(unknown)",
        association_id: address.AssociationId ?? null,
        instance_id: address.InstanceId ?? null,
        tags,
      });
    }
    return results.sort((a, b) => (a.allocation_id < b.allocation_id ? -1 : 1));
  }

  /**
   * Release one allocation. EC2 refuses an address that is still associated
   * (`InvalidIPAddress.InUse`) and that refusal is left to surface: teardown
   * never calls this on an associated address, so reaching the error means the
   * address was taken between the describe and the release.
   */
  async releaseAddress(allocationId: string): Promise<void> {
    try {
      await this.ec2.send(new ReleaseAddressCommand({ AllocationId: allocationId }));
    } catch (e) {
      // Already gone is released. `DescribeAddresses` can be a few seconds
      // stale either side of `DELETE_COMPLETE`, and reporting the stack's own
      // reaping as a failed release would tell the operator to go and look for
      // an address that no longer exists.
      if (isNotFound(e)) return;
      throw asHermeticError(e, `could not release Elastic IP allocation ${allocationId}`);
    }
  }
}

/**
 * The EC2 half of `FoundationApi.describeNat` (§5): is the NAT appliance up,
 * and does the private subnets' default route still resolve?
 *
 * The second question is the one that matters and the one nothing else asks.
 * `PrivateDefaultRoute` is pinned to the instance's *id*, so when that instance
 * is replaced — or simply terminated — the route does not fail over, it goes
 * `blackhole`, and every agent in the fleet loses egress with no symptom but
 * timeouts. A running instance beside a blackholed route is a real and
 * particularly confusing state, which is why both answers are returned rather
 * than one derived from the other.
 *
 * Never throws. It is read by `network.status` and by `doctor`, both of which
 * exist to report trouble; a probe that failed the whole command because one of
 * its two reads was denied would be the opposite of useful. An unreadable half
 * comes back `null`, which every reader shows as unchecked.
 */
export async function probeNat(
  ec2: EC2Client,
  ids: { instanceId: string; routeTableId: string },
): Promise<{ instance_state: string | null; route_state: NatHealth["route_state"] }> {
  let instance_state: string | null = null;
  try {
    const out = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [ids.instanceId] }));
    instance_state = out.Reservations?.[0]?.Instances?.[0]?.State?.Name ?? null;
  } catch {
    instance_state = null;
  }
  let route_state: NatHealth["route_state"] = null;
  try {
    const out = await ec2.send(new DescribeRouteTablesCommand({ RouteTableIds: [ids.routeTableId] }));
    // The IPv4 default only. The v6 default goes through the egress-only
    // gateway, which is not an instance and so cannot blackhole this way.
    const route = out.RouteTables?.[0]?.Routes?.find((r) => r.DestinationCidrBlock === "0.0.0.0/0");
    route_state =
      route?.State === "blackhole" ? "blackhole" : route?.State === "active" ? "active" : null;
  } catch {
    route_state = null;
  }
  return { instance_state, route_state };
}
