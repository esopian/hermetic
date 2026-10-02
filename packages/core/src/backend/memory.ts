import type {
  Agent,
  AgentEvent,
  AgentTombstone,
  FleetItem,
  NetworkMode,
  RpcHealth,
} from "../schema/index.ts";
import { FLEET_KEY, RPC_PROTOCOL_VERSION, browserIdentities, stackNameFor } from "../schema/index.ts";
import { HermeticError } from "../errors.ts";
import { parseHujson } from "../fleet/hujson.ts";
import type { Ec2InstanceFacts, Ec2VolumeFacts } from "./ec2-preconditions.ts";
import { NO_POLICY_WRITE_SCOPE } from "../aws/tailscale.ts";
import { HEARTBEAT_INTERVAL_MS, UNREACHABLE_INTERVALS } from "../agents/state.ts";
import type {
  Backend,
  CallerIdentity,
  ChangeSetChange,
  ChangeSetInfo,
  InstanceRef,
  AddressRef,
  LogLine,
  RpcLogsOptions,
  NetworkInterfaceRef,
  SnapshotRef,
  DirectoryApi,
  StackInfo,
  TailscaleDeleteOutcome,
  TailscaleDevice,
  TailscalePolicy,
  TailscaleWriteOutcome,
  VolumeClaim,
  VolumeRef,
} from "./types.ts";

import {
  createFixtureDirectory,
  type FixtureAccount,
  type FixtureDirectoryMode,
} from "./fixture/fixture-directory.ts";
import {
  AGENT_TAG,
  FLEET_ID_TAG,
  MANAGED_TAG,
  MANAGED_TAG_VALUE,
  ROLE_DATA,
  ROLE_TAG,
  SECRET_PLACEHOLDER,
  VERSION_TAG,
} from "./constants.ts";
import type { ResourceTags } from "../agents/ownership.ts";

import {
  FIXTURE_HERMETICD_VERSION,
  FIXTURE_NAT_EGRESS_IP,
  createFixtureAccount,
} from "./fixture/memory-fixture.ts";
import { createMemoryCompute } from "./memory-compute.ts";
import { createMemoryFoundation } from "./memory-foundation.ts";
import { tailscaleReformat } from "./memory-simulation.ts";
import { createMemoryStore } from "./memory-store.ts";

export { SECRET_PLACEHOLDER };
export type { FixtureAccount, FixtureDirectoryMode };

/**
 * A change set that replaces the agents table: what `changeSetChanges` becomes
 * under the heads' `foundationUnsafe` knob, so the `FOUNDATION_UNSAFE` refusal
 * has a fixture to fire on.
 */
export const FIXTURE_UNSAFE_CHANGES: readonly ChangeSetChange[] = [
  {
    logicalId: "AgentsTable",
    resourceType: "AWS::DynamoDB::Table",
    action: "Modify",
    replacement: "True",
  },
];

/** What the fixture's headed Chrome calls itself on `/json/version` (§7.3). */
const FIXTURE_CDP_VERSION = "Chrome/153.0.8010.12";

/**
 * The fixture tailnet's policy file, in the shape an operator's really is:
 * a header comment, groups, an owner for `tag:hermetic` they pasted by hand
 * before creating the OAuth client (§4.7 step 4), and two rules of their own
 * that hermetic must give back byte for byte.
 */

const FIXTURE_POLICY = `// Tailnet policy for hermetic.ts.net.
// Reviewed by the platform team; the comments are load-bearing.
{
  "groups": {
    "group:ops": ["ops@example.com"],
  },

  // Pasted by hand before the OAuth client could be created.
  "tagOwners": {
    "tag:hermetic": ["autogroup:admin"],
    "tag:build":    ["group:ops"],
  },

  "acls": [
    // The build fleet, nothing to do with hermetic.
    { "action": "accept", "src": ["group:ops"], "dst": ["tag:build:22"] },
  ],

  "ssh": [
    {
      "action": "check",
      "src":    ["autogroup:member"],
      "dst":    ["autogroup:self"],
      "users":  ["autogroup:nonroot", "root"],
    },
  ],
}
`;

/**
 * The fixture backend: a complete `Backend` in memory, with every mutating call
 * recorded so idempotency tests can assert "the second run mutated nothing"
 * (§11.1). Also what `--fixture` / `HERMETIC_FIXTURE=1` runs on, so UI work and
 * demos need no AWS account.
 */

/** The `instance-state-name` values `Ec2Compute.listInstancesByTag` asks for. */
const LISTED_INSTANCE_STATES = new Set(["pending", "running", "stopping", "stopped"]);

export class MemoryBackend implements Backend {
  /**
   * The fake account this backend stands in (§4.8) — its fleet directory.
   * `account` shares one: what the portal passes so a backend rebuilt per fleet
   * switch keeps the same fleet list, and what a test passes to put two
   * backends in one account. `directory` makes a fresh one in that state —
   * `seeded` for the populated fixture account, `empty` for a table that holds
   * nothing, `absent` for an account that has never run `init`. Neither is a
   * fresh `absent` account: a bare `new MemoryBackend()` is the pristine
   * account `init --create` walks, and `fixtureBackend()` is the seeded one.
   */
  readonly account: FixtureAccount;
  /** The fixture fleet directory (§4.8) over `account` — see `fixture-directory.ts`. */
  readonly directory: DirectoryApi;

  constructor(opts: { directory?: FixtureDirectoryMode; account?: FixtureAccount } = {}) {
    this.account = opts.account ?? createFixtureAccount(opts.directory ?? "absent");
    this.directory = createFixtureDirectory(this.account, (method) => this.record(method));
  }

  /** Stretch a fixture `createStack` over this many ms; 0 = instant. */
  slowStackMs = 0;
  /** Dotted names of every mutating backend call made so far, in order. */
  readonly mutations: string[] = [];

  readonly agents = new Map<string, Agent>();
  /** §9.1's reservations, by volume id — the real store's `_volume:<id>` rows. */
  readonly claims = new Map<string, VolumeClaim>();
  readonly events: AgentEvent[] = [];
  /** The `_destroyed` partition of the events table (§6.7), keyed by `tombstoneSortKey`. */
  readonly tombstones = new Map<string, AgentTombstone>();
  fleetItem: FleetItem | null = null;
  readonly params = new Map<string, string>();
  readonly objects = new Map<string, Uint8Array>();
  /**
   * `role` models what EC2 does: `RunInstances` produces a root volume for the
   * instance, and only `CreateVolume` produces the data volume. `findVolumeByTag`
   * must never return the root one (§1, §7.1) — a test asserts it.
   *
   * `null` is a volume carrying `hermetic:managed=true` and no `hermetic:role`
   * tag: one created by a build from before that tag existed. It is still
   * hermetic's, and `listManagedVolumes` — which selects on the managed tag
   * alone, exactly as `Ec2Compute` does — must be able to see it.
   */
  readonly volumes = new Map<
    string,
    VolumeRef & {
      /** `null` models a volume carrying no `agent` tag at all — a stray. */
      agent: string | null;
      role: "data" | "root" | null;
      /**
       * The `hermetic:fleet_id` tag (§5), modelled exactly as EC2 has it:
       * either the tag is there with a value, or it is not there at all.
       *
       * `undefined` and `null` are therefore the *same* state — untagged — and
       * an untagged resource is invisible to every filter here, because that is
       * what `DescribeInstances` with a `tag:hermetic:fleet_id` clause answers.
       * Only `listUnscopedManaged` (the v3 migration's legacy sweep) sees them.
       * A seed that means "this fleet's" must say so: `fleet_id: <the id>`.
       */
      fleet_id?: string | null;
      /** The display `Name` tag, `<fleet id>-<agent>-data` since v4. */
      name_tag?: string | null;
      /**
       * The `hermetic:former_agent` tag a destroy that keeps the volume leaves
       * (§6.7). Absent and `null` are the same: no such tag.
       */
      former_agent?: string | null;
      attached_to?: string | null;
      /**
       * `false` models a volume with no `hermetic:managed` tag: one hermetic did
       * not create. `listVolumes` reports it (it bills), every write path
       * refuses it, and `listManagedVolumes` — which selects on the managed tag
       * exactly as `Ec2Compute` does — cannot see it.
       */
      managed?: boolean;
      az?: string;
      created_at?: string;
      detached_at?: string;
    }
  >();
  /** The AZ the fixture fleet's launch subnet is in; a volume must share it. */
  launchAzId = "us-west-2a";
  /**
   * `agent` is `null` to model a managed instance with no `agent` tag, which
   * `doctor`'s reconciliation must still surface as an orphan rather than skip.
   */
  readonly instances = new Map<
    string,
    InstanceRef & {
      agent: string | null;
      /** The `hermetic:fleet_id` tag; see the volume map above for the three states. */
      fleet_id?: string | null;
      /**
       * The availability zone of the subnet it launched into. Absent means the
       * fleet's launch AZ, which is where `runInstance` puts every box — a seed
       * only has to say so when it means to model a box somewhere else, which
       * is what makes `AttachVolume`'s zone refusal reachable in the double.
       */
      az?: string;
    }
  >();
  /**
   * What the DLM policy of §7.1 has produced. `tags` is what the snapshot
   * carries, so `listSnapshots` selects on it the way `DescribeSnapshots` does —
   * a snapshot with no `hermetic:role=data` tag must stay invisible to teardown.
   */
  readonly snapshots = new Map<string, SnapshotRef & { tags: Record<string, string> }>();
  /**
   * Elastic IP allocations, keyed by allocation id (§4.6). Only a `nat` stack
   * makes one, and `tags` is what it carries — `listAddresses` selects on it the
   * way `DescribeAddresses` does, so an allocation belonging to another fleet,
   * or to the operator, is invisible here exactly as it is to EC2.
   */
  readonly addresses = new Map<string, AddressRef>();
  /**
   * Leave the `nat` stack's Elastic IP behind when `deleteStack` succeeds —
   * `DeleteStack --retain-resources NatEip`, which is what an operator runs to
   * get past the `DELETE_FAILED` an unreleasable address causes. The stack goes
   * and the allocation stays, unassociated and billing, which is the leftover
   * `teardown --purge` sweeps. Off by default: the ordinary case is that the
   * stack takes its address with it.
   */
  retainAddressOnDeleteStack = false;
  /** The bound fleet's foundation — what `describeStack` answers with. */
  stack: StackInfo | null = null;
  /**
   * §4.8: the *other* fleets' foundations in this fake account, by fleet id.
   * Only `stack`/`fleetItem` are ever live at once — this backend stands for one
   * fleet at a time, exactly as the real one does — so switching fleets parks
   * the pair that was live and brings the other back. Everything else (agents,
   * secrets, objects) stays shared: a fixture account with two fleets exists to
   * exercise the *choosing*, not to be a second complete fleet.
   */
  readonly parkedFleets = new Map<string, { stack: StackInfo; item: FleetItem | null }>();

  /** Change sets created and not yet executed or deleted, by name. */
  readonly changeSets = new Map<string, ChangeSetInfo>();
  /**
   * The network mode a pending change set would move the stack to, and the AMI
   * it would boot the NAT appliance from. Recorded at `createNetworkChangeSet`
   * and applied at `executeChangeSet`, because that is where a real stack
   * changes too: a change set that is computed and then deleted must leave the
   * fixture exactly as it was (§5).
   *
   * Keyed by change-set name, because a stack can hold several at once and each
   * carries its own parameters. A single pending value belonged to whichever
   * change set happened to execute next: a `plan network` that computed one and
   * a `foundation update` that executed its own would re-network the fixture by
   * accident, and deleting either would disarm the other.
   */
  readonly pendingNetwork = new Map<string, { network: NetworkMode; fckNatAmiId: string | null }>();
  /**
   * What `resolveFckNatAmi` answers. `null` makes the lookup *fail* — the state
   * a region with no published fck-nat image is in, and the one `apply` kind
   * `network` must refuse in preflight before it has archived or changed
   * anything.
   */
  fckNatAmiId: string | null = "ami-0fcknat00000fixture";
  /**
   * What `describeNat` reports for a `nat` fixture fleet. Mutable so a test can
   * say "the box is stopped" or "the route is blackholed" — the two states
   * `doctor` has findings for, and which no fixture would otherwise reach.
   */
  natHealth: {
    instance_state: string | null;
    route_state: "active" | "blackhole" | null;
  } = {
    instance_state: "running",
    route_state: "active",
  };
  /**
   * Network interfaces in the fixture's subnets that belong to no instance this
   * backend knows about — the ENI a failed create left behind, an appliance an
   * operator put in the VPC by hand. Nothing produces them; a test injects one
   * to say "this subnet cannot be deleted, and no agent row explains why",
   * which is exactly the state `nat` → `public` has to refuse (§5).
   */
  readonly strayEnis: NetworkInterfaceRef[] = [];
  /**
   * What a fixture `CreateChangeSet` computes. The default is the shape a real
   * v0 → v1 foundation update produces: the agent IAM policy is modified, in
   * place, and nothing is replaced.
   *
   * `FIXTURE_UNSAFE_CHANGES` (the heads' `foundationUnsafe` knob) swaps in a
   * change that *replaces* the agents table, so the `FOUNDATION_UNSAFE`
   * refusal — which no flag overrides — can be demoed in the UI without
   * inventing a broken template.
   */
  changeSetChanges: ChangeSetChange[] = [
    {
      logicalId: "AgentPolicy",
      resourceType: "AWS::IAM::Policy",
      action: "Modify",
      replacement: "False",
    },
  ];
  /** `FAILED` with a "didn't contain changes" reason is how a no-op update reads. */
  changeSetStatus = "CREATE_COMPLETE";
  changeSetStatusReason: string | null = null;
  pendingHermeticVersion: string | null = null;

  /**
   * What `tailscale.listDevices()` would return — `doctor`'s tailnet half of
   * the three-way reconciliation (§9). `null` models a client without the
   * `devices:core` read scope, or an unreachable API.
   */
  tailscaleDevices: TailscaleDevice[] | null = [];

  /**
   * What the fleet's OAuth client may do with the tailnet policy file (§4.7).
   * `write` is the default because it is the shape hermetic asks operators to
   * create today; the other two exist so a test — and `--fixture` demo — can
   * see the read-only and the no-scope paths, which are the ones every fleet
   * created before this feature is on.
   */
  policyScope: "write" | "read" | "none" = "write";

  /**
   * The tailnet policy, in the shape a real one is in: comments that say why a
   * rule exists, the operator's own groups and rules, and a `tag:hermetic`
   * owner they pasted by hand before creating the OAuth client — which is why
   * `policy.status` reports that block `skipped` on the fixture rather than
   * writing a second entry for the same tag.
   */
  policyText = FIXTURE_POLICY;

  /** Bumped on every accepted write, so a stale `If-Match` is a real 412. */
  private policyEtagSeq = 1;

  /** Rows `scan` pretends it could not parse, so `doctor` has something to report. */
  unparseableRows: string[] = [];

  /** Tags `runInstance` applied, in order — the AWS layer tags the instance only. */
  readonly instanceTags: Array<Record<string, string>> = [];

  /** What Canonical's public SSM parameter would resolve to (§6.2 step 7). */
  ubuntuAmiId = "ami-0abc1234def567890";

  /** Inbound rules on the shared agent security group. Must stay empty (§5). */
  sgInbound: Array<{ protocol: string; from: number; to: number; cidr: string }> = [];

  accountId = "123456789012";
  callerArn = "arn:aws:sts::123456789012:assumed-role/hermetic-operator/evan";
  alias: string | null = "acme-dev";
  organizationId: string | null = "o-fixture00";

  /** Fixed clock so rendered snapshots and heartbeat-age tests are deterministic. */
  private nowMs = Date.parse("2026-09-01T12:00:00.000Z");
  private seq = 0;

  now(): Date {
    return new Date(this.nowMs);
  }

  setNow(when: Date | string | number): void {
    this.nowMs = typeof when === "number" ? when : new Date(when).getTime();
  }

  advance(ms: number): void {
    this.nowMs += ms;
  }

  resetMutations(): void {
    this.mutations.length = 0;
  }

  record(method: string): void {
    this.mutations.push(method);
  }

  nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${String(this.seq).padStart(17, "0")}`;
  }

  /** How long each step of the fixture's imaginary runner takes. */
  rerunDelayMs = 1000;

  /** Schedule work that must never hold a test or a dev server open. */
  later(ms: number, work: () => void): void {
    const timer = setTimeout(work, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  readonly clock = {
    now: () => this.now(),
  };

  readonly identity = {
    callerIdentity: async (): Promise<CallerIdentity> => ({
      account_id: this.accountId,
      arn: this.callerArn,
      user_id: "AIDAFIXTURE",
    }),
    accountAlias: async (): Promise<string | null> => this.alias,
    orgId: async (): Promise<string | null> => this.organizationId,
  };

  readonly store = createMemoryStore(this);

  readonly secrets = {
    ensureSlot: async (path: string): Promise<void> => {
      if (this.params.has(path)) return; // idempotent: reality already matches
      this.record("secrets.ensureSlot");
      this.params.set(path, SECRET_PLACEHOLDER);
    },
    put: async (path: string, value: string): Promise<void> => {
      this.record("secrets.put");
      this.params.set(path, value);
    },
    exists: async (path: string): Promise<boolean> => this.params.has(path),
    isPlaceholder: async (path: string): Promise<boolean> =>
      this.params.get(path) === SECRET_PLACEHOLDER,
    get: async (path: string): Promise<string> => {
      const value = this.params.get(path);
      if (value === undefined) {
        throw new HermeticError("NOT_FOUND", `no SSM slot ${path}`, { path });
      }
      return value;
    },
    delete: async (path: string): Promise<void> => {
      if (!this.params.has(path)) return; // already gone is not a failure
      this.record("secrets.delete");
      this.params.delete(path);
    },
    deleteByPrefix: async (prefix: string): Promise<string[]> => {
      const hits = [...this.params.keys()].filter((k) => k.startsWith(prefix));
      if (hits.length === 0) return [];
      this.record("secrets.deleteByPrefix");
      for (const k of hits) this.params.delete(k);
      return hits;
    },
    list: async (prefix: string): Promise<string[]> =>
      [...this.params.keys()].filter((k) => k.startsWith(prefix)).sort(),
  };

  readonly artifacts = {
    putObject: async (key: string, body: Uint8Array): Promise<void> => {
      // Byte-for-byte, not length: `manifest.json` is rewritten in place by
      // every push, so "same size" is not "same object" the way it is for a
      // content-hashed config tarball.
      const existing = this.objects.get(key);
      if (existing && existing.length === body.length && existing.every((b, i) => b === body[i])) {
        return;
      }
      this.record("artifacts.putObject");
      this.objects.set(key, new Uint8Array(body));
    },
    /**
     * The fixture bucket keeps no versions, so this and `deleteByPrefix` remove
     * the same objects — the difference that matters is which one the caller
     * *asked* for, and `MUTATING_METHODS` records that, so a test can assert a
     * prune reached for the version-aware door.
     */
    purgeByPrefix: async (prefix: string): Promise<number> => {
      const hits = [...this.objects.keys()].filter((k) => k.startsWith(prefix));
      if (hits.length === 0) return 0;
      this.record("artifacts.purgeByPrefix");
      for (const k of hits) this.objects.delete(k);
      return hits.length;
    },
    copy: async (fromKey: string, toKey: string): Promise<void> => {
      const found = this.objects.get(fromKey);
      if (!found) {
        throw new HermeticError("NOT_FOUND", `no object at ${fromKey}`, { key: fromKey });
      }
      this.record("artifacts.copy");
      this.objects.set(toKey, new Uint8Array(found));
    },
    exists: async (key: string): Promise<boolean> => this.objects.has(key),
    list: async (prefix: string): Promise<string[]> =>
      [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort(),
    getText: async (key: string): Promise<string | null> => {
      const found = this.objects.get(key);
      return found ? new TextDecoder().decode(found) : null;
    },
    getObject: async (key: string): Promise<Uint8Array | null> => {
      const found = this.objects.get(key);
      return found ? new Uint8Array(found) : null;
    },
    deleteByPrefix: async (prefix: string): Promise<string[]> => {
      const hits = [...this.objects.keys()].filter((k) => k.startsWith(prefix));
      if (hits.length === 0) return [];
      this.record("artifacts.deleteByPrefix");
      for (const k of hits) this.objects.delete(k);
      return hits;
    },
    emptyBucket: async (onPage?: () => Promise<void>): Promise<number> => {
      // The whole model is one page, but the caller's heartbeat is still called
      // once for it: teardown renews the fleet lock from inside this sweep, and
      // a fixture that never called back would make that wiring untestable.
      await onPage?.();
      const n = this.objects.size;
      if (n === 0) return 0;
      this.record("artifacts.emptyBucket");
      this.objects.clear();
      return n;
    },
    presign: async (key: string, expiresInSeconds = 3600): Promise<string> =>
      // Presigning is a signature, not a mutation.
      `https://fixture-bucket.s3.amazonaws.com/${key}?X-Amz-Expires=${expiresInSeconds}&X-Amz-Signature=fixture`,
  };

  /**
   * The tag filter `listInstancesByTag` reads through. A method rather than a
   * member of `compute` itself: referring to `this.compute` from inside its own
   * initializer would make its inferred type circular.
   */
  /**
   * What carries `hermetic:managed=true` in the model: everything except the
   * root volume `RunInstances` makes (never tagged, §7.1) and anything a
   * fixture explicitly marks as somebody else's.
   */
  isManagedVolume(v: { role: "data" | "root" | null; managed?: boolean }): boolean {
    if (v.managed === false) return false;
    return v.role !== "root";
  }

  /** The fleet this backend stands for; `null` before `_fleet` has been written. */
  /**
   * The last fleet id `_fleet` named, kept for after it is gone.
   *
   * `_fleet` is a row in the `agents` table and the table is in the stack, so
   * `deleteStack` takes it — while the `hermetic:fleet_id` tag on a volume, a
   * snapshot or an Elastic IP is an EC2 fact that outlives both. That gap is
   * precisely where teardown does its leftover sweeps (§4.6), so a filter that
   * went blind the moment the row went would hide from the fixture exactly the
   * resources the fixture exists to model.
   */
  tornDownFleetId: string | null = null;

  boundFleetId(): string | null {
    return this.fleetItem?.fleet_id ?? this.tornDownFleetId;
  }

  /**
   * The `tag:hermetic:fleet_id = <this fleet>` clause every real EC2 filter
   * carries (`Ec2Compute.fleetFilter`). A resource with no fleet tag is
   * invisible here for the same reason it is invisible to `DescribeInstances`:
   * the filter does not match it. Only `listUnscopedManaged` looks for those.
   */
  /**
   * The tags a real `DescribeInstances` would return for this instance, built
   * from what the fixture models. Every managed instance here was launched by
   * `runInstance`, which tags `agent` and `hermetic:managed` unconditionally, so
   * the only tag that can be missing is the fleet id — and an `agent` of `null`
   * models the untagged stray `doctor` has to be able to see.
   */
  instanceTagMap(inst: { agent: string | null; fleet_id?: string | null }): ResourceTags {
    const tags: Record<string, string> = { [MANAGED_TAG]: MANAGED_TAG_VALUE };
    if (inst.agent !== null) tags[AGENT_TAG] = inst.agent;
    if (inst.fleet_id !== undefined && inst.fleet_id !== null) tags[FLEET_ID_TAG] = inst.fleet_id;
    return tags;
  }

  /** The same for a volume, including the `hermetic:role` tag when it has one. */
  volumeTagMap(vol: {
    agent: string | null;
    role: "data" | "root" | null;
    fleet_id?: string | null;
    managed?: boolean;
  }): ResourceTags {
    const tags: Record<string, string> = {};
    if (this.isManagedVolume(vol)) tags[MANAGED_TAG] = MANAGED_TAG_VALUE;
    if (vol.agent !== null) tags[AGENT_TAG] = vol.agent;
    if (vol.fleet_id !== undefined && vol.fleet_id !== null) tags[FLEET_ID_TAG] = vol.fleet_id;
    if (vol.role !== null) tags[ROLE_TAG] = vol.role === "data" ? ROLE_DATA : vol.role;
    return tags;
  }

  /**
   * The double's own backstop for §6.7, and the reason it is weaker than
   * `describeOwned*`: a raw `terminate`/`deleteVolume` is given an id and
   * nothing else, so the most it can check is the fleet the resource is tagged
   * for. A resource carrying *another* fleet's id is never this backend's to
   * destroy, whoever asked; an untagged one is a pre-v3 leftover the legacy
   * sweep is allowed to reap.
   *
   * TODO(evan): the real `Ec2Compute` cannot make this check without a describe
   * per call, so the two are not identical here. The ownership gate above is
   * where both backends agree; this only stops a fixture or a test from
   * pretending a cross-fleet destroy would have worked.
   */
  assertNotAnotherFleets(
    kind: "instance" | "volume",
    id: string,
    r: { fleet_id?: string | null },
  ): void {
    const bound = this.boundFleetId();
    if (r.fleet_id === undefined || r.fleet_id === null || bound === null) return;
    if (r.fleet_id === bound) return;
    throw new HermeticError(
      "RESOURCE_NOT_OWNED",
      `${kind} ${id} is tagged for fleet ${r.fleet_id}, not ${bound}`,
      { kind, id, expected: { fleet_id: bound }, found: { fleet_id: r.fleet_id } },
    );
  }

  /**
   * The two maps read as EC2 reads its own resources, for `ec2-preconditions.ts`.
   * An id nothing holds is `null` — "EC2 has never heard of this" — and a
   * resource with no recorded zone is in the fleet's launch AZ, which is where
   * `runInstance` and `createVolume` both put one.
   */
  instanceFacts(instanceId: string): Ec2InstanceFacts | null {
    const inst = this.instances.get(instanceId);
    if (!inst) return null;
    return { instance_id: inst.instance_id, state: inst.state, az: inst.az ?? this.launchAzId };
  }

  volumeFacts(volumeId: string): Ec2VolumeFacts | null {
    const vol = this.volumes.get(volumeId);
    if (!vol) return null;
    return {
      volume_id: vol.volume_id,
      state: vol.state,
      attached_to: vol.attached_to ?? null,
      az: vol.az ?? this.launchAzId,
    };
  }

  inFleet(r: { fleet_id?: string | null }): boolean {
    // (see `untagged` below for the "no tag at all" half of the same model)
    const bound = this.boundFleetId();
    return r.fleet_id !== undefined && r.fleet_id !== null && r.fleet_id === bound;
  }

  /**
   * The subnet the fleet launches into today — the first of the stack's current
   * `SubnetIds`, which is what `launchSubnet()` takes. Read at launch rather
   * than fixed, so a re-network genuinely changes where the *next* instance
   * lands while leaving every existing one where it was (§5).
   */
  currentLaunchSubnet(): string | null {
    const ids = (this.stack?.outputs["SubnetIds"] ?? "").split(",").filter(Boolean);
    return ids[0] ?? null;
  }

  /**
   * The public address a launch into the fleet's current launch subnet would
   * get, or `null` when it would get none (§5, §6.2).
   *
   * `nat` mode is the whole reason the field exists: `RunInstances` sets
   * `AssociatePublicIpAddress: false` for it, so a `nat` fleet's boxes are
   * reachable only over the tailnet and every head that shows a public IP must
   * show nothing. A fixture that handed out `203.0.113.x` regardless made the
   * `staging` fleet — the fixture's only `nat` one — render exactly the state
   * the mode exists to prevent.
   */
  fixturePublicIp(ip: string): string | null {
    return this.stack?.parameters["Network"] === "nat" ? null : ip;
  }

  /**
   * Network interfaces in the named subnets, derived from the instances table
   * plus whatever `strayEnis` injects (§5).
   *
   * One per live instance, which is what EC2 reports for a box with a single
   * ENI, and nothing at all for a terminated one. It is deliberately *not*
   * scoped to the bound fleet: the question `apply` kind `network` asks is what
   * CloudFormation will hit when it deletes the subnet, and an interface
   * belonging to nobody blocks the delete exactly as hard as one of ours.
   */
  enisIn(subnetIds: readonly string[]): NetworkInterfaceRef[] {
    const wanted = new Set(subnetIds);
    const out: NetworkInterfaceRef[] = [];
    for (const inst of this.instances.values()) {
      const subnet = inst.subnet_id ?? null;
      if (inst.state === "terminated" || subnet === null || !wanted.has(subnet)) continue;
      out.push({
        id: `eni-${inst.instance_id.replace(/^i-/, "")}`,
        subnet_id: subnet,
        instance_id: inst.instance_id,
        description: null,
      });
    }
    for (const eni of this.strayEnis) {
      if (wanted.has(eni.subnet_id)) out.push({ ...eni });
    }
    return out;
  }

  /**
   * `listInstancesByTag`, with `Ec2Compute`'s state filter: `pending`,
   * `running`, `stopping`, `stopped`. A box already `shutting-down` is as
   * invisible here as it is to that `DescribeInstances`, so a test cannot pass
   * on a stray the real account would never have returned.
   */
  liveByTag(name: string): InstanceRef[] {
    return [...this.instances.values()]
      .filter((i) => i.agent === name && LISTED_INSTANCE_STATES.has(i.state) && this.inFleet(i))
      .map((i) => ({ instance_id: i.instance_id, state: i.state, public_ip: i.public_ip }));
  }

  readonly compute = createMemoryCompute(this);

  /**
   * The `NatEip` a `nat` foundation allocates (§5), tagged the way the template
   * tags it: `hermetic:fleet_id`, `hermetic:version` and a `Name`. Unassociated,
   * because the fixture has no NAT instance to hold it — a test that wants the
   * "still associated" case sets `association_id`/`instance_id` itself.
   */
  allocateNatAddress(fleetId: string): AddressRef {
    const allocation_id = this.nextId("eipalloc");
    const address: AddressRef = {
      allocation_id,
      public_ip: FIXTURE_NAT_EGRESS_IP,
      association_id: null,
      instance_id: null,
      // Every tag the template's `tags()` helper stamps, and the `Name` the
      // `NatEip` resource adds: a fixture that carried fewer would let a filter
      // on the version tag pass here and find nothing on a real account. The
      // version is whatever the fixture's stack claims; only its presence is
      // modelled, since no fixture asserts a hermetic version off an address.
      tags: {
        [FLEET_ID_TAG]: fleetId,
        [VERSION_TAG]:
          this.stack?.tags[VERSION_TAG] ?? this.stack?.tags["hermetic_version"] ?? "fixture",
        Name: `${stackNameFor(fleetId)}-nat`,
      },
    };
    this.addresses.set(allocation_id, address);
    return address;
  }

  /** The fleet id a stack carries, however its tags are spelled. */
  stackFleetId(stack: StackInfo): string | null {
    return stack.tags[FLEET_ID_TAG] ?? stack.tags["fleet_id"] ?? null;
  }

  readonly foundation = createMemoryFoundation(this);

  readonly tailscale = {
    mintAuthKey: async (name: string): Promise<string> => {
      this.record("tailscale.mintAuthKey");
      return `tskey-auth-FIXTURE-SECRET-${name}`;
    },
    listDevices: async (): Promise<TailscaleDevice[] | null> =>
      this.tailscaleDevices === null ? null : structuredClone(this.tailscaleDevices),
    /**
     * The same three answers the real client gives (§6.5). A `null` device list
     * is the fixture's "no `devices:core` scope", so a delete against it is
     * `forbidden` rather than a silent success — otherwise the fixture would
     * make the unscoped path, which is the one most real fleets are on,
     * impossible to see.
     */
    deleteDevice: async (id: string): Promise<TailscaleDeleteOutcome> => {
      this.record("tailscale.deleteDevice");
      if (this.tailscaleDevices === null) return "forbidden";
      const idx = this.tailscaleDevices.findIndex((d) => d.id === id);
      if (idx === -1) return "not_found";
      this.tailscaleDevices.splice(idx, 1);
      return "deleted";
    },

    /** `null` is a client with no policy scope at all — the 403 of §4.7. */
    getPolicy: async (): Promise<TailscalePolicy | null> =>
      this.policyScope === "none" ? null : { text: this.policyText, etag: this.policyEtag() },

    /**
     * The fixture's validator is deliberately shallow — it parses, and it
     * refuses a policy with no `tagOwners` for the fleet's tag, which is the
     * one rejection an operator can actually provoke from here. A read-only
     * client answers the same 403 the real endpoint does, because that is how
     * `policy.status` tells the two scopes apart without writing.
     */
    validatePolicy: async (text: string): Promise<{ ok: true } | { ok: false; message: string }> => {
      if (this.policyScope !== "write") return { ok: false, message: NO_POLICY_WRITE_SCOPE };
      try {
        parseHujson(text);
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
      return { ok: true };
    },

    setPolicy: async (text: string, etag: string): Promise<TailscaleWriteOutcome> => {
      if (this.policyScope !== "write") return { kind: "forbidden" };
      // The whole point of the ETag: a plan made against one policy must not be
      // applied to another (§4.7).
      if (etag !== this.policyEtag()) return { kind: "conflict" };
      try {
        parseHujson(text);
      } catch (e) {
        return { kind: "invalid", message: e instanceof Error ? e.message : String(e) };
      }
      this.record("tailscale.setPolicy");
      // Stored the way Tailscale stores it, not the way it was posted.
      this.policyText = tailscaleReformat(text);
      this.policyEtagSeq += 1;
      return { kind: "written", etag: this.policyEtag() };
    },
  };

  /** The fixture's ETag: a counter, spelled the way Tailscale spells one. */
  policyEtag(): string {
    return `"fixture-policy-${this.policyEtagSeq}"`;
  }

  readonly rpc = {
    /**
     * The fixture's `/healthz`. It answers for a row with a tailnet address and
     * a *fresh* heartbeat, and refuses for one whose heartbeat is stale — the
     * seeded `lumen`, twenty minutes behind, is the fixture's `unreachable`
     * agent and so must also be the one whose probe reports a silent hermeticd.
     * A fixture that answered for every row would make `agent probe` look like
     * it always says "fine", which is the opposite of what it is for.
     */
    health: async (name: string): Promise<RpcHealth> => {
      const agent = this.agents.get(name);
      if (!agent) throw new HermeticError("NOT_FOUND", `no such agent: ${name}`, { name });
      const stale =
        !agent.tailscale_ip ||
        agent.last_heartbeat === null ||
        agent.last_heartbeat === undefined ||
        this.now().getTime() - Date.parse(agent.last_heartbeat) >
          HEARTBEAT_INTERVAL_MS * UNREACHABLE_INTERVALS;
      if (stale) {
        throw new HermeticError("INTERNAL", `hermeticd on ${name} did not answer`, { name });
      }
      return {
        name,
        hermeticd_version: agent.hermeticd_version ?? FIXTURE_HERMETICD_VERSION,
        protocol: RPC_PROTOCOL_VERSION,
        config_hash: agent.config_hash ?? null,
        /**
         * One entry per browser identity the agent runs (§7.3), all of them
         * healthy — the fixture's failing layers are hermeticd and the
         * dashboard, on `lumen`, and a second always-broken layer would only
         * make the fixture's probe unreadable. An agent created with
         * `--no-browser` reports none, which is what the layer's `skip` reads.
         */
        browsers: browserIdentities().map((b) => ({
          name: b.name,
          unit_active: true,
          cdp_ok: true,
          cdp_version: FIXTURE_CDP_VERSION,
          detail: `hermetic-browser@${b.name} active, CDP on 127.0.0.1:${b.cdp_port}`,
        })),
      };
    },
    /**
     * Two lines and then the end of the stream — including under `follow`. A
     * fixture has no journal to keep open, and a `--follow` that never returned
     * would hang every fixture-mode caller rather than demonstrating anything.
     */
    logs: (name: string, opts: RpcLogsOptions = {}) => {
      const at = this.now().toISOString();
      if (opts.file) {
        // The file source, named the way hermeticd names it: the file, not a
        // unit. `errors` gets a line worth reading, because the whole reason a
        // fixture carries this source is to show what the journal does not.
        const u = `${opts.file}.log`;
        const body =
          opts.file === "errors"
            ? "WARNING turn aborted: provider returned 429"
            : `INFO ${opts.file} log line`;
        return (async function* (): AsyncIterable<LogLine> {
          yield { unit: u, at, message: `[${name}] ${body}` };
        })();
      }
      const u = opts.unit ?? "hermes";
      return (async function* (): AsyncIterable<LogLine> {
        yield { unit: u, at, message: `[${name}] ${u}: started` };
        yield { unit: u, at, message: `[${name}] ${u}: healthy` };
      })();
    },
  };
}

export { FLEET_KEY };

/**
 * The fixture data, re-exported so this module stays the one door every test
 * and every head opens (`seedFixtureFleet`, `FIXTURE_CONFIG`, and the rest).
 */
export * from "./fixture/memory-fixture.ts";
