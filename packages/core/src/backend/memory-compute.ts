/**
 * The fixture's EC2: the `compute` port of `MemoryBackend`, split out of
 * `memory.ts` (AGENTS.md rule 5). The fleet-scoping helpers it leans on
 * (`inFleet`, `instanceFacts`, the tag maps) stay on the backend because the
 * other ports share them.
 */
import { DEFAULT_ROOT_GIB, cloudName } from "../schema/index.ts";
import { HermeticError } from "../errors.ts";
import {
  assertAttachable,
  assertRebootable,
  assertStartable,
  assertStoppable,
  assertVolumeDeletable,
} from "./ec2-preconditions.ts";
import type {
  Backend,
  ConsoleOutput,
  InstanceRef,
  InstanceStatusChecks,
  AddressRef,
  ManagedVolumeRef,
  NetworkInterfaceRef,
  VolumeDetail,
  RunInstanceSpec,
  SnapshotRef,
  TagSelector,
  VolumeRef,
  OwnedVolumeStatus,
  VolumeStatus,
} from "./types.ts";

import {
  AGENT_TAG,
  FLEET_ID_TAG,
  FORMER_AGENT_TAG,
  MANAGED_TAG,
  MANAGED_TAG_VALUE,
  ROLE_DATA,
  ROLE_TAG,
} from "./constants.ts";
import { OWNED_VOLUME_ROLE, assertResourceOwned, type ResourceOwner } from "../agents/ownership.ts";

import { FIXTURE_HERMETICD_VERSION } from "./fixture/memory-fixture.ts";

import type { MemoryBackend } from "./memory.ts";
import { simulateReboot } from "./memory-simulation.ts";

/**
 * A resource carrying no `hermetic:fleet_id` tag at all — the pre-v3 shape the
 * v3 migration adopts. `undefined` and `null` are the same state here, because
 * EC2 has only one: the tag is absent.
 */
function untagged(r: { fleet_id?: string | null }): boolean {
  return r.fleet_id === undefined || r.fleet_id === null;
}

export function createMemoryCompute(b: MemoryBackend): Backend["compute"] {
  return {
    findVolumeByTag: async (name: string): Promise<VolumeRef | null> => {
      for (const v of b.volumes.values()) {
        if (v.agent !== name || v.role !== "data" || !b.inFleet(v)) continue;
        return { volume_id: v.volume_id, size_gib: v.size_gib, state: v.state };
      }
      return null;
    },
    createVolume: async (name: string, sizeGib: number, nameTag?: string): Promise<VolumeRef> => {
      b.record("compute.createVolume");
      const volume_id = b.nextId("vol");
      b.volumes.set(volume_id, {
        volume_id,
        size_gib: sizeGib,
        state: "available",
        agent: name,
        role: "data",
        fleet_id: b.boundFleetId(),
        ...(nameTag === undefined ? {} : { name_tag: nameTag }),
        az: b.launchAzId,
        created_at: b.now().toISOString(),
      });
      return { volume_id, size_gib: sizeGib, state: "available" };
    },
    /**
     * A volume EC2 has forgotten is already deleted, which is success (§4.5);
     * one still attached is `VolumeInUse`, the refusal `waitVolumeReleased`
     * exists to wait out.
     */
    deleteVolume: async (volumeId: string): Promise<void> => {
      const vol = b.volumes.get(volumeId);
      const facts = b.volumeFacts(volumeId);
      if (!vol || facts === null) return;
      b.assertNotAnotherFleets("volume", volumeId, vol);
      assertVolumeDeletable(facts);
      b.record("compute.deleteVolume");
      b.volumes.delete(volumeId);
    },
    /**
     * Every live instance carrying this agent's tag — a fixture can hold two.
     * `shuttingDown` adds the dying ones, exactly as `Ec2Compute` widens its
     * state filter.
     */
    listInstancesByTag: async (
      name: string,
      opts: { shuttingDown?: boolean } = {},
    ): Promise<InstanceRef[]> => {
      const live = b.liveByTag(name);
      if (!opts.shuttingDown) return live;
      const dying = [...b.instances.values()]
        .filter((i) => i.agent === name && i.state === "shutting-down" && b.inFleet(i))
        .map((i) => ({ instance_id: i.instance_id, state: i.state, public_ip: i.public_ip }));
      return [...live, ...dying];
    },
    listNetworkInterfaces: async (subnetIds: readonly string[]): Promise<NetworkInterfaceRef[]> =>
      subnetIds.length === 0 ? [] : b.enisIn(subnetIds),
    runInstance: async (spec: RunInstanceSpec): Promise<InstanceRef> => {
      b.record("compute.runInstance");
      const instance_id = b.nextId("i");
      /**
       * The subnet a real launch would have put it in: the first of the stack's
       * current `SubnetIds`, which is what `launchSubnet()` picks. Recorded so
       * that a fleet which later changes mode leaves this box measurably in the
       * wrong place — which is the drift `network.status` reports (§5).
       */
      const ref = {
        instance_id,
        state: "pending",
        public_ip: b.fixturePublicIp("203.0.113.10"),
        subnet_id: b.currentLaunchSubnet(),
      };
      b.instances.set(instance_id, {
        ...ref,
        agent: spec.name,
        fleet_id: b.boundFleetId(),
        // The zone that subnet is in, so an attach can be judged against it.
        az: b.launchAzId,
      });
      // Launching produces a root volume carrying the instance's tags. It is
      // disposable, and `findVolumeByTag` must not mistake it for the data disk.
      // The two tags the EC2 layer adds for itself are recorded here too, so a
      // fixture assertion sees the tag set a real launch would have written.
      b.instanceTags.push({
        ...spec.tags,
        [MANAGED_TAG]: MANAGED_TAG_VALUE,
        ...(b.boundFleetId() === null ? {} : { [FLEET_ID_TAG]: b.boundFleetId() as string }),
      });
      const root_id = b.nextId("vol");
      b.volumes.set(root_id, {
        volume_id: root_id,
        size_gib: spec.root_gib ?? DEFAULT_ROOT_GIB,
        state: "in-use",
        agent: spec.name,
        role: "root",
        fleet_id: b.boundFleetId(),
        attached_to: instance_id,
      });
      return ref;
    },
    /**
     * Fixture instances boot: `runInstance` returns `pending`, and the first
     * describe after that reports `running`. `attachAgentVolume` waits for
     * exactly that transition against AWS, so the fixture has to make it —
     * an instance stuck at `pending` forever would make the fixture's create
     * hang rather than demonstrate the wait.
     */
    describeInstance: async (instanceId: string): Promise<InstanceRef | null> => {
      const inst = b.instances.get(instanceId);
      if (!inst) return null;
      const next = inst.state === "pending" ? { ...inst, state: "running" } : inst;
      if (next !== inst) b.instances.set(instanceId, next);
      return {
        instance_id: next.instance_id,
        state: next.state,
        public_ip: next.public_ip,
        subnet_id: next.subnet_id ?? null,
      };
    },
    /**
     * §6.7, modelled exactly as `Ec2Compute` does it: the describe above, with
     * the instance's tags checked against the agent the row claims it belongs
     * to. A fixture that answered this without looking at its own tags would
     * make the poisoned-row case untestable in the double.
     */
    describeOwnedInstance: async (
      instanceId: string,
      owner: ResourceOwner,
    ): Promise<InstanceRef | null> => {
      const inst = b.instances.get(instanceId);
      if (!inst) return null;
      assertResourceOwned("instance", instanceId, owner, b.instanceTagMap(inst));
      return await b.compute.describeInstance(instanceId);
    },
    /**
     * EC2's status checks, shaped the way the real API answers: a `running` box
     * is `ok`/`ok`, and anything else has no summary at all — which is what
     * `IncludeAllInstances` returns for a stopped instance. `agents.probe`
     * reads that absence, so inventing an `ok` here would hide the one case the
     * fixture's stopped agents exist to show.
     */
    describeInstanceStatus: async (instanceId: string): Promise<InstanceStatusChecks | null> => {
      const inst = b.instances.get(instanceId);
      if (!inst) return null;
      const running = inst.state === "running";
      return {
        instance_id: inst.instance_id,
        state: inst.state,
        system_status: running ? "ok" : null,
        instance_status: running ? "ok" : null,
      };
    },
    /**
     * A plausible serial console for a box mid-boot, so `logs --console` has
     * something to render in fixture mode. Deliberately shaped like the real
     * thing: cloud-init, then the bootstrap unit's own redacted stage lines.
     */
    consoleOutput: async (instanceId: string): Promise<ConsoleOutput | null> => {
      const inst = b.instances.get(instanceId);
      if (!inst) return null;
      const at = b.now().toISOString();
      return {
        at,
        output: [
          "[    9.8] cloud-init[934]: Cloud-init running 'modules:config'",
          "[   13.0] cloud-init[1063]: /tmp/hermeticd: OK",
          "         Starting hermeticd-bootstrap.service - hermetic staged bootstrap...",
          `hermeticd[1191]: [  2%] manifest: fleet manifest names hermeticd ${FIXTURE_HERMETICD_VERSION}`,
          "hermeticd[1191]: [ 10%] 01-tailscale: running 01-tailscale.sh",
          "hermeticd[1191]: [ 40%] 02-disk: running 02-disk.sh",
        ].join("\n"),
      };
    },
    describeVolume: async (volumeId: string): Promise<VolumeStatus | null> => {
      const vol = b.volumes.get(volumeId);
      if (!vol) return null;
      return {
        volume_id: vol.volume_id,
        size_gib: vol.size_gib,
        state: vol.state,
        attachments: vol.attached_to ? [{ instance_id: vol.attached_to, state: "attached" }] : [],
      };
    },
    /**
     * §6.7's volume half: the agent's data disk, gone, or a refusal — with the
     * `hermetic:former_agent` tag in the answer and in a refusal's `found`.
     */
    describeOwnedVolume: async (
      volumeId: string,
      owner: ResourceOwner,
    ): Promise<OwnedVolumeStatus | null> => {
      const vol = b.volumes.get(volumeId);
      if (!vol) return null;
      const former_agent = vol.former_agent ?? null;
      const tags = {
        ...b.volumeTagMap(vol),
        ...(former_agent === null ? {} : { [FORMER_AGENT_TAG]: former_agent }),
      };
      assertResourceOwned("volume", volumeId, owner, tags, OWNED_VOLUME_ROLE);
      const status = await b.compute.describeVolume(volumeId);
      return status === null ? null : { ...status, former_agent };
    },
    /**
     * Raw, like `Ec2Compute.attachVolume`: `attachAgentVolume` polls the
     * describes above for readiness and can therefore wait rather than fail, so
     * nothing is *waited* for here. What is refused is what EC2 refuses —
     * unknown ids, a disk already handed out, either resource in the wrong
     * state, a disk in the wrong zone — because a double that accepted those
     * would pass a test a real account fails (`ec2-preconditions.ts`).
     */
    attachVolume: async (instanceId: string, volumeId: string): Promise<void> => {
      assertAttachable(instanceId, volumeId, b.instanceFacts(instanceId), b.volumeFacts(volumeId));
      b.record("compute.attachVolume");
      const vol = b.volumes.get(volumeId);
      if (vol) b.volumes.set(volumeId, { ...vol, state: "in-use", attached_to: instanceId });
    },
    terminate: async (instanceId: string): Promise<void> => {
      const inst = b.instances.get(instanceId);
      if (!inst || inst.state === "terminated") return;
      b.assertNotAnotherFleets("instance", instanceId, inst);
      b.record("compute.terminate");
      b.instances.set(instanceId, { ...inst, state: "terminated", public_ip: null });
      // Terminating detaches every volume that was on the box; the data volume
      // must become `available` again so recreate can attach it to the next
      // instance (§1).
      for (const [id, vol] of b.volumes) {
        if (vol.attached_to === instanceId) {
          b.volumes.set(id, {
            ...vol,
            state: vol.role === "root" ? "deleted" : "available",
            attached_to: null,
          });
        }
      }
      /**
       * The tailnet node goes down with the box, seconds later. Modelled here
       * because `recreate`/`destroy` refuse to delete a device that is still
       * `online` (§6.5) — a fixture whose devices stayed up for ever would make
       * the tailnet cleanup unreachable in `--fixture`, which is the one place
       * it can be watched without a real fleet.
       */
      const devices = b.tailscaleDevices;
      if (devices && inst.agent) {
        const host = cloudName(b.fleetItem?.fleet_id, inst.agent);
        for (const [i, d] of devices.entries()) {
          if (d.hostname === host) devices[i] = { ...d, online: false };
        }
      }
    },
    /**
     * `StopInstances` is idempotent over a box that is already off, and refuses
     * one that is terminated or on its way there — which a drifted row can
     * still name, so the double has to refuse it too rather than quietly move a
     * terminated instance to `stopped`.
     */
    stop: async (instanceId: string): Promise<void> => {
      assertStoppable(instanceId, b.instanceFacts(instanceId));
      const inst = b.instances.get(instanceId);
      if (!inst || inst.state === "stopped") return;
      b.record("compute.stop");
      b.instances.set(instanceId, { ...inst, state: "stopped", public_ip: null });
    },
    /** `StartInstances`: a terminated or still-stopping box is a refusal, not a boot. */
    start: async (instanceId: string): Promise<InstanceRef> => {
      assertStartable(instanceId, b.instanceFacts(instanceId));
      const inst = b.instances.get(instanceId);
      if (!inst) {
        throw new HermeticError("NOT_FOUND", `no such instance: ${instanceId}`, { instanceId });
      }
      if (inst.state === "running" || inst.state === "pending") {
        return { instance_id: inst.instance_id, state: inst.state, public_ip: inst.public_ip };
      }
      b.record("compute.start");
      const next = { ...inst, state: "pending", public_ip: b.fixturePublicIp("203.0.113.11") };
      b.instances.set(instanceId, next);
      return { instance_id: next.instance_id, state: next.state, public_ip: next.public_ip };
    },
    /**
     * A reboot leaves the instance exactly where it was — same id, same state,
     * same attachments — which is the whole point of it, so the fixture's job
     * is to refuse what EC2 refuses, record the call, and play the box's first
     * heartbeat on the way back up (`simulateReboot`).
     */
    reboot: async (instanceId: string): Promise<void> => {
      assertRebootable(instanceId, b.instanceFacts(instanceId));
      b.record("compute.reboot");
      simulateReboot(b, instanceId);
    },
    describeSecurityGroupInbound: async () => structuredClone(b.sgInbound),
    resolveUbuntuAmi: async (): Promise<string> => b.ubuntuAmiId,
    listManagedInstances: async (): Promise<
      Array<{ instance_id: string; agent: string | null; state: string }>
    > =>
      [...b.instances.values()]
        .filter((i) => i.state !== "terminated" && b.inFleet(i))
        .map((i) => ({ instance_id: i.instance_id, agent: i.agent, state: i.state })),
    /**
     * Everything carrying `hermetic:managed=true`, which is what `Ec2Compute`
     * answers: the managed tag is the whole of teardown's handle on a volume no
     * agent row names any more, and a volume from before `hermetic:role` existed
     * has no role at all. The exclusions are AWS's own: a root volume is tagged
     * by `RunInstances` from the *instance*, so it never carries the managed tag
     * (§7.1), and a volume already going away is not reported (§6.6).
     */
    listManagedVolumes: async (): Promise<ManagedVolumeRef[]> =>
      [...b.volumes.values()]
        .filter(
          (v) =>
            b.isManagedVolume(v) && b.inFleet(v) && v.state !== "deleting" && v.state !== "deleted",
        )
        .map((v) => ({
          volume_id: v.volume_id,
          size_gib: v.size_gib,
          agent: v.agent,
          former_agent: v.former_agent ?? null,
          state: v.state,
        }))
        .sort((a, b) => (a.volume_id < b.volume_id ? -1 : 1)),
    /**
     * `Ec2Compute.listVolumesByAgentTag`: managed, this fleet, `agent=<name>`,
     * any role. The model's root disks carry the instance's `agent` tag but
     * are not managed (`isManagedVolume`), as EC2's untagged ones are not.
     */
    listVolumesByAgentTag: async (name: string): Promise<ManagedVolumeRef[]> =>
      [...b.volumes.values()]
        .filter(
          (v) =>
            v.agent === name &&
            b.isManagedVolume(v) &&
            b.inFleet(v) &&
            v.state !== "deleting" &&
            v.state !== "deleted",
        )
        .map((v) => ({
          volume_id: v.volume_id,
          size_gib: v.size_gib,
          agent: v.agent,
          former_agent: v.former_agent ?? null,
          state: v.state,
        }))
        .sort((a, b) => (a.volume_id < b.volume_id ? -1 : 1)),
    /**
     * §9's inventory: everything managed, plus every unattached volume the
     * fixture holds that hermetic did not make. The root volume `runInstance`
     * produces is unmanaged and attached, so it appears here as neither — which
     * is what EC2 answers too, since `RunInstances` never tags it.
     */
    listVolumes: async (): Promise<VolumeDetail[]> =>
      [...b.volumes.values()]
        .filter((v) => v.state !== "deleting" && v.state !== "deleted")
        // Two queries in `Ec2Compute`, merged: everything managed *by this
        // fleet*, plus every unattached volume whoever owns it — which is the
        // one place another fleet's volume legitimately shows up, because an
        // available volume bills the account either way.
        .filter((v) => (b.isManagedVolume(v) && b.inFleet(v)) || v.state === "available")
        /**
         * Another fleet's volume is another fleet's to reclaim, rename or
         * delete, so it is not in this fleet's inventory at all — the same cut
         * `Ec2Compute.listVolumes` makes after reading the tags back. An
         * *untagged* volume is kept: that is a pre-v3 leftover or an operator's
         * own disk, which is exactly what the `available` query is for.
         */
        .filter((v) => v.fleet_id === undefined || v.fleet_id === null || b.inFleet(v))
        .map((v) => {
          const managed = b.isManagedVolume(v);
          const tags: Record<string, string> = {};
          if (v.agent !== null) tags[AGENT_TAG] = v.agent;
          if (managed) tags[MANAGED_TAG] = MANAGED_TAG_VALUE;
          if (v.role === "data") tags[ROLE_TAG] = ROLE_DATA;
          const fleetTag = v.fleet_id === undefined ? b.boundFleetId() : v.fleet_id;
          if (managed && fleetTag !== null) tags[FLEET_ID_TAG] = fleetTag;
          if (v.name_tag) tags["Name"] = v.name_tag;
          if (v.former_agent) tags[FORMER_AGENT_TAG] = v.former_agent;
          return {
            volume_id: v.volume_id,
            size_gib: v.size_gib,
            state: v.state,
            availability_zone: v.az ?? b.launchAzId,
            created_at: v.created_at ?? null,
            agent: v.agent,
            former_agent: v.former_agent ?? null,
            managed,
            role_data: v.role === "data",
            tags,
            attachments: v.attached_to ? [{ instance_id: v.attached_to, state: "attached" }] : [],
          };
        })
        .sort((a, b) => (a.volume_id < b.volume_id ? -1 : 1)),
    launchAz: async (): Promise<string> => b.launchAzId,
    retagVolume: async (
      volumeId: string,
      agent: string | null,
      opts: { roleData?: boolean; name?: string | null; formerAgent?: string | null } = {},
    ): Promise<void> => {
      const roleData = opts.roleData ?? true;
      const vol = b.volumes.get(volumeId);
      if (!vol) {
        throw new HermeticError("NOT_FOUND", `volume ${volumeId} does not exist`, { volumeId });
      }
      b.record("compute.retagVolume");
      // A managed volume is never a root volume (`isManagedVolume`), so
      // "not role=data" is "no role tag" — which is what a restore puts back.
      // An absent `opts.name` leaves the display `Name` alone; `null` clears it,
      // which is what a rollback of an adopted volume asks for.
      b.volumes.set(volumeId, {
        ...vol,
        agent,
        role: roleData ? "data" : null,
        fleet_id: b.boundFleetId(),
        ...(opts.name === undefined ? {} : { name_tag: opts.name }),
        // Same three states for `hermetic:former_agent` (§6.7).
        ...(opts.formerAgent === undefined ? {} : { former_agent: opts.formerAgent }),
      });
    },
    /**
     * §6.6 v3's legacy sweep. The only reader here that looks past the fleet
     * tag, because "which managed resources carry no fleet tag" is exactly the
     * question the migration asks before it adopts them.
     */
    listUnscopedManaged: async (): Promise<{ instances: string[]; volumes: string[] }> => ({
      instances: [...b.instances.values()]
        .filter((i) => i.state !== "terminated" && untagged(i))
        .map((i) => i.instance_id)
        .sort(),
      volumes: [...b.volumes.values()]
        .filter(
          (v) => b.isManagedVolume(v) && untagged(v) && v.state !== "deleting" && v.state !== "deleted",
        )
        .map((v) => v.volume_id)
        .sort(),
    }),
    tagFleetId: async (resourceIds: readonly string[]): Promise<void> => {
      if (resourceIds.length === 0) return;
      b.record("compute.tagFleetId");
      const id = b.boundFleetId();
      for (const resourceId of resourceIds) {
        const vol = b.volumes.get(resourceId);
        if (vol) b.volumes.set(resourceId, { ...vol, fleet_id: id });
        const inst = b.instances.get(resourceId);
        if (inst) b.instances.set(resourceId, { ...inst, fleet_id: id });
      }
    },
    listSnapshots: async (tag: TagSelector): Promise<SnapshotRef[]> =>
      [...b.snapshots.values()]
        .filter((s) => s.tags[tag.key] === tag.value)
        .map(({ snapshot_id, volume_id, size_gib, started_at }) => ({
          snapshot_id,
          volume_id,
          size_gib,
          started_at,
        }))
        .sort((a, b) => (a.snapshot_id < b.snapshot_id ? -1 : 1)),
    deleteSnapshot: async (snapshotId: string): Promise<void> => {
      if (!b.snapshots.has(snapshotId)) return;
      b.record("compute.deleteSnapshot");
      b.snapshots.delete(snapshotId);
    },
    /**
     * §4.6. Selects on the tag it was asked for, exactly as `DescribeAddresses`
     * does: an allocation carrying no such tag — another fleet's, or an
     * operator's own — is not in the answer at all.
     */
    listAddresses: async (tag: TagSelector): Promise<AddressRef[]> =>
      [...b.addresses.values()]
        .filter((a) => a.tags[tag.key] === tag.value)
        .map((a) => structuredClone(a))
        .sort((a, b) => (a.allocation_id < b.allocation_id ? -1 : 1)),
    releaseAddress: async (allocationId: string): Promise<void> => {
      const address = b.addresses.get(allocationId);
      if (!address) return;
      // EC2 refuses an associated address (`InvalidIPAddress.InUse`), and
      // teardown depends on that refusal: an address still attached to
      // something is reported, never released (§4.6).
      if (address.association_id !== null) {
        throw new HermeticError(
          "CONFLICT",
          `Elastic IP ${address.public_ip} is still associated; disassociate it before releasing`,
          { allocationId, association_id: address.association_id },
        );
      }
      b.record("compute.releaseAddress");
      b.addresses.delete(allocationId);
    },
  };
}
