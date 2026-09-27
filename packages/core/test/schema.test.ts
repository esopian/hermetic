import { describe, expect, test } from "bun:test";
import {
  Agent,
  AgentConfig,
  AgentEvent,
  AgentStatus,
  BootstrapState,
  CreateAgentInput,
  DestroyAgentInput,
  FleetItem,
  FleetManifest,
  Health,
  LocalConfig,
  Lock,
  Metrics,
  OpEvent,
  Plan,
  RerunInput,
  Resources,
  SIZES,
  Size,
  UpgradeInput,
  compareVersions,
  hermesBundleKey,
  hermesRefFromKey,
  isHermesRef,
  orderStages,
  releaseKey,
} from "../src/schema/index.ts";
import { FIXTURE_CONFIG, seedFixtureFleet, MemoryBackend } from "../src/backend/memory.ts";

const validAgent = {
  name: "atlas",
  status: "ready",
  version: 3,
  lock: null,
  size: "medium",
  instance_type: "t4g.2xlarge",
  region: "us-west-2",
  instance_id: "i-0123456789abcdef0",
  volume_id: "vol-0123456789abcdef0",
  volume_gib: 100,
  hermes_version: "0.15.0",
  hermeticd_version: "0.4.1",
  config_hash: "cafebabecafebabe",
  provider: "bedrock",
  secrets_mode: "none",
  tailscale_ip: "100.64.12.4",
  resources: { ssm_paths: ["/hermes/atlas/ts-key"] },
  last_heartbeat: "2026-09-01T12:00:00.000Z",
  health: { hermes: true, tailscale: true, disk: true },
  metrics: { cpu_pct: 34, mem_pct: 61, disk_pct: 62 },
  created_by: "arn:aws:sts::123456789012:assumed-role/r/evan",
  created_at: "2026-07-22T14:05:00.000Z",
  updated_at: "2026-09-01T12:00:00.000Z",
};

describe("Agent", () => {
  test("accepts a full valid row", () => {
    expect(Agent.parse(validAgent).name).toBe("atlas");
  });

  test("rejects an unknown status", () => {
    expect(() => Agent.parse({ ...validAgent, status: "running" })).toThrow();
  });

  test("rejects a non-ISO timestamp", () => {
    expect(() => Agent.parse({ ...validAgent, created_at: "2026-07-22" })).toThrow();
  });

  test("rejects a malformed region", () => {
    expect(() => Agent.parse({ ...validAgent, region: "west" })).toThrow();
  });

  test("rejects a non-semver hermes version", () => {
    expect(() => Agent.parse({ ...validAgent, hermes_version: "v0.15" })).toThrow();
  });

  test("rejects a negative version", () => {
    expect(() => Agent.parse({ ...validAgent, version: -1 })).toThrow();
  });

  test("health and metrics are optional before the first heartbeat", () => {
    const row = Agent.parse({ ...validAgent, health: null, metrics: null, last_heartbeat: null });
    expect(row.health).toBeNull();
  });
});

describe("AgentStatus", () => {
  test("is exactly the nine statuses of §4.3", () => {
    expect(AgentStatus.options).toEqual([
      "creating",
      "bootstrapping",
      "ready",
      "degraded",
      "stopping",
      "stopped",
      "destroying",
      "destroyed",
      "error",
    ]);
  });

  test("no longer accepts converging", () => {
    expect(AgentStatus.options).not.toContain("converging");
    expect(() => AgentStatus.parse("converging")).toThrow();
    expect(() => Agent.parse({ ...validAgent, status: "converging" })).toThrow();
  });
});

describe("SIZES", () => {
  test("matches the §7.1 CPU and GPU profiles", () => {
    expect(Size.options).toEqual([
      "micro",
      "xxsmall",
      "xsmall",
      "small",
      "medium",
      "large",
      "xlarge",
      "xxlarge",
      "3xlarge",
      "gpu-xsmall",
      "gpu-small",
      "gpu-medium",
      "gpu-large",
      "gpu-xlarge",
    ]);
    expect(SIZES.micro).toMatchObject({
      instance_type: "t4g.micro",
      vcpu: 2,
      memGib: 1,
      monthlyUsd: 7,
    });
    expect(SIZES.xxsmall).toMatchObject({
      instance_type: "t4g.small",
      vcpu: 2,
      memGib: 2,
      monthlyUsd: 14,
    });
    expect(SIZES.xsmall).toMatchObject({
      instance_type: "t4g.medium",
      vcpu: 2,
      memGib: 4,
      monthlyUsd: 28,
    });
    expect(SIZES.small.instance_type).toBe("r8g.large");
    expect(SIZES.medium.instance_type).toBe("t4g.2xlarge");
    expect(SIZES.large.instance_type).toBe("r8g.2xlarge");
    expect(SIZES.small).toMatchObject({ vcpu: 2, memGib: 16, monthlyUsd: 86 });
    expect(SIZES.medium).toMatchObject({ vcpu: 8, memGib: 32, monthlyUsd: 196 });
    expect(SIZES.large).toMatchObject({ vcpu: 8, memGib: 64, monthlyUsd: 344 });
    expect(SIZES.xlarge).toMatchObject({
      instance_type: "r8g.4xlarge",
      vcpu: 16,
      memGib: 128,
      monthlyUsd: 688,
    });
    expect(SIZES.xxlarge).toMatchObject({
      instance_type: "r8g.8xlarge",
      vcpu: 32,
      memGib: 256,
      monthlyUsd: 1376,
    });
    expect(SIZES["3xlarge"]).toMatchObject({
      instance_type: "r8g.16xlarge",
      vcpu: 64,
      memGib: 512,
      monthlyUsd: 2752,
    });
    expect(SIZES["gpu-xsmall"]).toMatchObject({
      instance_type: "g5g.xlarge",
      gpu: { count: 1, memGib: 16, model: "NVIDIA T4G" },
    });
    expect(SIZES["gpu-xlarge"]).toMatchObject({
      instance_type: "g5g.16xlarge",
      gpu: { count: 2, memGib: 32, model: "NVIDIA T4G" },
    });
  });

  test("hourly price is the monthly figure over 730 hours", () => {
    for (const spec of Object.values(SIZES)) {
      expect(spec.hourlyUsd).toBeCloseTo(spec.monthlyUsd / 730, 10);
    }
  });
});

describe("Health / Metrics / Lock / Resources", () => {
  test("Health requires all three checks", () => {
    expect(Health.parse({ hermes: true, tailscale: false, disk: true }).tailscale).toBe(false);
    expect(() => Health.parse({ hermes: true, tailscale: true })).toThrow();
  });

  test("Metrics are percentages", () => {
    expect(() => Metrics.parse({ cpu_pct: 101, mem_pct: 0, disk_pct: 0 })).toThrow();
    expect(() => Metrics.parse({ cpu_pct: -1, mem_pct: 0, disk_pct: 0 })).toThrow();
  });

  test("Lock expiry must be ISO", () => {
    expect(Lock.parse({ owner: "me", expires: "2026-09-01T12:10:00.000Z" }).owner).toBe("me");
    expect(() => Lock.parse({ owner: "me", expires: "soon" })).toThrow();
  });

  test("Resources always carries an ssm_paths array", () => {
    expect(Resources.parse({ ssm_paths: [] }).ssm_paths).toEqual([]);
    expect(() => Resources.parse({})).toThrow();
  });
});

describe("FleetItem", () => {
  test("accepts the seeded fixture fleet", () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    expect(FleetItem.parse(backend.fleetItem).region).toBe(FIXTURE_CONFIG.region);
  });

  test("rejects a non-UUID fleet_id", () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    expect(() => FleetItem.parse({ ...backend.fleetItem, fleet_id: "nope" })).toThrow();
  });

  test("rejects a malformed AMI id", () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    expect(() => FleetItem.parse({ ...backend.fleetItem, ami_id: "i-123" })).toThrow();
  });
});

describe("AgentEvent", () => {
  test("accepts a transition event", () => {
    expect(
      AgentEvent.parse({
        name: "atlas",
        timestamp: "2026-09-01T12:00:00.000Z",
        actor: "arn:aws:sts::123456789012:assumed-role/r/evan",
        action: "transition",
        from_status: "bootstrapping",
        to_status: "ready",
        detail: "all checks passing",
      }).to_status,
    ).toBe("ready");
  });

  test("rejects an unknown to_status", () => {
    expect(() =>
      AgentEvent.parse({
        name: "atlas",
        timestamp: "2026-09-01T12:00:00.000Z",
        actor: "a",
        action: "x",
        to_status: "unreachable",
      }),
    ).toThrow();
  });
});

describe("LocalConfig", () => {
  test("accepts the fixture config", () => {
    expect(LocalConfig.parse(FIXTURE_CONFIG).account_id).toBe("123456789012");
  });

  test("rejects an eleven-digit account id", () => {
    expect(() => LocalConfig.parse({ ...FIXTURE_CONFIG, account_id: "12345678901" })).toThrow();
  });

  test("rejects a future schema_version", () => {
    expect(() => LocalConfig.parse({ ...FIXTURE_CONFIG, schema_version: 2 })).toThrow();
  });
});

describe("AgentConfig manifest", () => {
  const base = {
    schema_version: 1,
    name: "atlas",
    size: "medium",
    instance_type: "t4g.2xlarge",
    provider: "bedrock",
    secrets_mode: "none",
    hermes_version: "0.15.0",
    hermes_ref: "v2026.8.31",
    config_hash: "cafebabe",
    packages: ["curl"],
    apt_sources: [{ name: "tailscale", uri: "https://pkgs.tailscale.com/stable/ubuntu noble main" }],
    files: [{ path: "/etc/hermes/hermes.toml", mode: "0640", content: "x" }],
    units: ["hermes-dashboard.service"],
    commands: ["nft -f /etc/hermetic/nftables.hermetic.nft"],
    tailscale_serve: { enabled: true, hostname: "atlas", routes: [] },
  };

  test("accepts a minimal valid manifest", () => {
    expect(AgentConfig.parse(base).name).toBe("atlas");
  });

  test("refuses a future schema_version", () => {
    expect(() => AgentConfig.parse({ ...base, schema_version: 2 })).toThrow();
  });

  test("carries no hermeticd_version — that is a fleet-level fact", () => {
    expect(AgentConfig.parse({ ...base, hermeticd_version: "0.4.1" })).not.toHaveProperty(
      "hermeticd_version",
    );
  });

  test("file paths must be absolute and modes octal", () => {
    expect(() =>
      AgentConfig.parse({ ...base, files: [{ path: "etc/x", mode: "0644", content: "" }] }),
    ).toThrow();
    expect(() =>
      AgentConfig.parse({ ...base, files: [{ path: "/etc/x", mode: "644", content: "" }] }),
    ).toThrow();
  });
});

describe("OpEvent and Plan", () => {
  test("progress is clamped to 0..1", () => {
    const at = "2026-09-01T12:00:00.000Z";
    expect(OpEvent.parse({ phase: "p", progress: 1, message: "m", at }).progress).toBe(1);
    expect(() => OpEvent.parse({ phase: "p", progress: 1.5, message: "m", at })).toThrow();
    expect(() => OpEvent.parse({ phase: "p", progress: -0.1, message: "m", at })).toThrow();
  });

  test("Plan requires a kind from the enum", () => {
    expect(Plan.parse({ kind: "destroy", target: "atlas", steps: [], warnings: [] }).kind).toBe(
      "destroy",
    );
    expect(() => Plan.parse({ kind: "nuke", target: "atlas", steps: [], warnings: [] })).toThrow();
  });
});

describe("request schemas", () => {
  test("CreateAgentInput rejects an invalid name and a silly volume", () => {
    expect(CreateAgentInput.parse({ name: "atlas" }).name).toBe("atlas");
    expect(() => CreateAgentInput.parse({ name: "Atlas" })).toThrow();
    expect(() => CreateAgentInput.parse({ name: "atlas", volume_gib: 4 })).toThrow();
  });

  test("DestroyAgentInput requires an explicit yes flag", () => {
    expect(() => DestroyAgentInput.parse({ name: "atlas" })).toThrow();
    expect(DestroyAgentInput.parse({ name: "atlas", yes: false }).yes).toBe(false);
  });

  test("RerunInput is name-only and rejects the reserved name", () => {
    expect(RerunInput.parse({ name: "atlas" }).name).toBe("atlas");
    expect(() => RerunInput.parse({ name: "_fleet" })).toThrow();
    expect(() => RerunInput.parse({})).toThrow();
  });

  test("UpgradeInput needs a version, and --hermes needs a target", () => {
    expect(() => UpgradeInput.parse({ name: "atlas" })).toThrow();
    expect(() => UpgradeInput.parse({ hermes: "0.16.0" })).toThrow();
    expect(UpgradeInput.parse({ hermes: "0.16.0", all: true }).all).toBe(true);
    expect(UpgradeInput.parse({ hermes: "0.16.0", name: "atlas" }).name).toBe("atlas");
  });

  /**
   * `--hermeticd` moves one pointer in the fleet manifest, which every box
   * follows: there is nothing for a target to select, so requiring `--all`
   * would be ceremony with no meaning behind it. A *name* still parses here —
   * core refuses it with `VALIDATION`, where the reason can be explained.
   */
  test("UpgradeInput takes --hermeticd on its own: it is fleet-wide", () => {
    expect(UpgradeInput.parse({ hermeticd: "0.5.0" }).hermeticd).toBe("0.5.0");
    expect(UpgradeInput.parse({ hermeticd: "0.5.0", all: true }).all).toBe(true);
    expect(UpgradeInput.parse({ hermeticd: "0.5.0", name: "atlas" }).name).toBe("atlas");
  });
});

describe("compareVersions", () => {
  test("orders numerically, field by field — not as strings", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("0.9.0", "0.10.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(compareVersions("0.4.1", "0.4.1")).toBe(0);
  });

  test("a pre-release precedes the release it leads to", () => {
    expect(compareVersions("0.5.0-rc1", "0.5.0")).toBeLessThan(0);
    expect(compareVersions("0.5.0", "0.5.0-rc1")).toBeGreaterThan(0);
    expect(compareVersions("0.5.0-rc1", "0.5.0-rc2")).toBeLessThan(0);
  });

  test("a missing field is zero, so 0.5 and 0.5.0 are the same release", () => {
    expect(compareVersions("0.5", "0.5.0")).toBe(0);
    expect(compareVersions("0.5.1", "0.5")).toBeGreaterThan(0);
  });
});

describe("orderStages", () => {
  test("returns a valid set sorted by ordinal", () => {
    expect(orderStages(["03-config.sh", "00-preflight.sh", "01-tailscale.sh"])).toEqual([
      "00-preflight.sh",
      "01-tailscale.sh",
      "03-config.sh",
    ]);
  });

  /**
   * An empty set is exactly the shape an interrupted push used to leave behind
   * — a binary with no stages beside it — so "valid because there is nothing to
   * check" is the one answer that must not be given.
   */
  test("rejects an empty release rather than blessing it", () => {
    expect(() => orderStages([])).toThrow(/no stages/);
  });

  test("rejects a name that is not NN-<name>.sh", () => {
    expect(() => orderStages(["00-preflight.sh", "tailscale.sh"])).toThrow(/tailscale\.sh/);
    expect(() => orderStages(["1-preflight.sh"])).toThrow(/NN-<name>\.sh/);
    expect(() => orderStages(["00-Preflight.sh"])).toThrow();
    expect(() => orderStages(["00-preflight.bash"])).toThrow();
  });

  test("rejects a duplicate ordinal, naming both files", () => {
    expect(() => orderStages(["01-tailscale.sh", "01-network.sh"])).toThrow(
      "duplicate stage ordinal 01: 01-tailscale.sh and 01-network.sh",
    );
  });
});

describe("releaseKey", () => {
  test("is the one place the release key scheme lives", () => {
    expect(releaseKey("0.4.1", "hermeticd")).toBe("artifacts/0.4.1/hermeticd");
    expect(releaseKey("0.4.1", "stages/01-tailscale.sh")).toBe(
      "artifacts/0.4.1/stages/01-tailscale.sh",
    );
  });
});

describe("FleetManifest", () => {
  const digest = "a".repeat(64);
  const manifest = {
    schema_version: 1,
    fleet_id: "k7m2x9qa",
    region: "us-west-2",
    hermetic_version: "0.9.2",
    hermeticd: {
      version: "0.4.1",
      files: {
        hermeticd: { key: "artifacts/0.4.1/hermeticd", sha256: digest, size: 51_312_640 },
        "stages/01-tailscale.sh": {
          key: "artifacts/0.4.1/stages/01-tailscale.sh",
          sha256: "b".repeat(64),
          size: 812,
        },
      },
    },
    resources: {
      bucket: "hermetic-k7m2x9qa-123456789012",
      stack_id: "arn:aws:cloudformation:us-west-2:123456789012:stack/hermetic-k7m2x9qa/uuid",
      agents_table: "hermetic-k7m2x9qa-agents",
      events_table: "hermetic-k7m2x9qa-events",
      param_prefix: "/hermes/",
      vpc_id: "vpc-0123456789abcdef0",
      subnet_ids: ["subnet-0123456789abcdef0"],
      security_group_id: "sg-0123456789abcdef0",
      instance_profile_arn: "arn:aws:iam::123456789012:instance-profile/hermetic-k7m2x9qa",
      role_arn: "arn:aws:iam::123456789012:role/hermetic-k7m2x9qa",
    },
    updated_at: "2026-09-03T09:00:00.000Z",
    updated_by: "arn:aws:sts::123456789012:assumed-role/r/evan",
  };

  test("accepts a realistic manifest", () => {
    const parsed = FleetManifest.parse(manifest);
    expect(parsed.hermeticd.version).toBe("0.4.1");
    expect(parsed.hermeticd.files["hermeticd"]?.sha256).toBe(digest);
    const stages = Object.keys(parsed.hermeticd.files)
      .filter((key) => key.startsWith("stages/"))
      .map((key) => key.slice("stages/".length));
    expect(orderStages(stages)).toEqual(["01-tailscale.sh"]);
  });

  test("refuses a future schema_version", () => {
    expect(() => FleetManifest.parse({ ...manifest, schema_version: 2 })).toThrow();
  });

  test("refuses a digest that is not 64 hex characters", () => {
    const files = { hermeticd: { key: "k", sha256: "abc", size: 1 } };
    expect(() =>
      FleetManifest.parse({ ...manifest, hermeticd: { ...manifest.hermeticd, files } }),
    ).toThrow();
  });

  test("refuses a negative size and a non-semver version", () => {
    const files = { hermeticd: { key: "k", sha256: digest, size: -1 } };
    expect(() =>
      FleetManifest.parse({ ...manifest, hermeticd: { ...manifest.hermeticd, files } }),
    ).toThrow();
    expect(() =>
      FleetManifest.parse({
        ...manifest,
        hermeticd: { ...manifest.hermeticd, version: "latest" },
      }),
    ).toThrow();
  });

  test("requires every resource the box needs", () => {
    const { agents_table: _dropped, ...rest } = manifest.resources;
    expect(() => FleetManifest.parse({ ...manifest, resources: rest })).toThrow();
  });

  /**
   * The Hermes source mirror is additive: a manifest written before it existed
   * still parses, and `schema_version` stays 1 either way. That is what lets an
   * older hermeticd read a manifest a newer laptop wrote.
   */
  describe("the hermes mirror block", () => {
    const hermes = {
      "v2026.8.31": {
        key: "hermes/v2026.8.31.bundle",
        sha256: "c".repeat(64),
        size: 4_194_304,
        upstream_sha: "576efebfd41f459334b9cb55d9f11f1da3be5cfe",
      },
    };

    test("a manifest without it parses, and reports no mirror", () => {
      expect(FleetManifest.parse(manifest).hermes).toBeUndefined();
    });

    test("a manifest with it parses, keyed by ref", () => {
      const parsed = FleetManifest.parse({ ...manifest, hermes });
      expect(parsed.schema_version).toBe(1);
      expect(parsed.hermes?.["v2026.8.31"]?.key).toBe("hermes/v2026.8.31.bundle");
      expect(parsed.hermes?.["v2026.8.31"]?.upstream_sha).toHaveLength(40);
    });

    /** Two refs at once: a fleet mid-`upgrade --hermes` is on both (§6.5). */
    test("holds more than one ref", () => {
      const two = {
        ...hermes,
        "v2026.9.4": { ...hermes["v2026.8.31"], key: "hermes/v2026.9.4.bundle" },
      };
      expect(Object.keys(FleetManifest.parse({ ...manifest, hermes: two }).hermes ?? {})).toEqual([
        "v2026.8.31",
        "v2026.9.4",
      ]);
    });

    test("refuses an entry with a short digest or no upstream commit", () => {
      const short = { v1: { ...hermes["v2026.8.31"], sha256: "abc" } };
      expect(() => FleetManifest.parse({ ...manifest, hermes: short })).toThrow();
      const { upstream_sha: _dropped, ...rest } = hermes["v2026.8.31"];
      expect(() => FleetManifest.parse({ ...manifest, hermes: { v1: rest } })).toThrow();
    });
  });
});

describe("hermesBundleKey", () => {
  test("is `hermes/<ref>.bundle`, outside the pruned artifacts prefix", () => {
    expect(hermesBundleKey("v2026.8.31")).toBe("hermes/v2026.8.31.bundle");
    expect(hermesBundleKey("v2026.8.31").startsWith("artifacts/")).toBe(false);
  });

  test("round-trips through hermesRefFromKey, and refuses anything else", () => {
    expect(hermesRefFromKey(hermesBundleKey("v2026.8.31"))).toBe("v2026.8.31");
    expect(hermesRefFromKey("artifacts/0.5.0/hermeticd")).toBeNull();
    expect(hermesRefFromKey("hermes/")).toBeNull();
    expect(hermesRefFromKey("hermes/../manifest.json.bundle")).toBeNull();
  });

  test("a ref that would escape the prefix or the argv is not a ref", () => {
    expect(isHermesRef("v2026.8.31")).toBe(true);
    expect(isHermesRef("release/2026")).toBe(false);
    expect(isHermesRef("../secret")).toBe(false);
    expect(isHermesRef("v1 v2")).toBe(false);
    expect(isHermesRef("--upload-pack=x")).toBe(false);
    expect(isHermesRef("")).toBe(false);
  });
});

describe("BootstrapState", () => {
  const state = {
    hermeticd_version: "0.4.1",
    stages: [
      {
        id: "00-preflight",
        status: "ok",
        attempt: 1,
        started_at: "2026-09-03T09:00:00.000Z",
        ended_at: "2026-09-03T09:00:02.000Z",
        exit_code: 0,
        message: null,
      },
      {
        id: "02-data-volume",
        status: "failed",
        attempt: 2,
        started_at: "2026-09-03T09:00:02.000Z",
        ended_at: "2026-09-03T09:00:09.000Z",
        exit_code: 100,
        message: "device /dev/nvme1n1 has an unknown signature; refusing to mkfs",
      },
      { id: "03-config", status: "pending", attempt: 0 },
    ],
    current: null,
    started_at: "2026-09-03T09:00:00.000Z",
    updated_at: "2026-09-03T09:00:09.000Z",
    last_command_id: "0f1b0c0e-0000-4000-8000-000000000001",
  };

  test("parses a part-failed bootstrap", () => {
    const parsed = BootstrapState.parse(state);
    expect(parsed.stages.map((s) => s.status)).toEqual(["ok", "failed", "pending"]);
    expect(parsed.stages[1]?.exit_code).toBe(100);
    expect(parsed.stages[2]?.started_at ?? null).toBeNull();
  });

  test("rejects an unknown stage status and a negative attempt", () => {
    const bad = (stage: unknown) => () => BootstrapState.parse({ ...state, stages: [stage] });
    expect(bad({ id: "00-preflight", status: "converging", attempt: 1 })).toThrow();
    expect(bad({ id: "00-preflight", status: "ok", attempt: -1 })).toThrow();
  });

  test("truncation is enforced: a message over 512 characters is refused", () => {
    expect(
      BootstrapState.parse({
        ...state,
        stages: [{ id: "x", status: "failed", attempt: 1, message: "e".repeat(512) }],
      }).stages[0]?.message?.length,
    ).toBe(512);
    expect(() =>
      BootstrapState.parse({
        ...state,
        stages: [{ id: "x", status: "failed", attempt: 1, message: "e".repeat(513) }],
      }),
    ).toThrow();
  });

  test("an Agent row carries bootstrap and command, or neither", () => {
    const row = Agent.parse({
      ...validAgent,
      status: "error",
      bootstrap: state,
      command: {
        id: "0f1b0c0e-0000-4000-8000-000000000002",
        action: "rerun",
        issued_by: "arn:aws:sts::123456789012:assumed-role/r/evan",
        issued_at: "2026-09-03T09:01:00.000Z",
      },
    });
    expect(row.bootstrap?.stages).toHaveLength(3);
    expect(row.command?.action).toBe("rerun");
    expect(Agent.parse(validAgent).bootstrap ?? null).toBeNull();
  });

  test("rejects a command action that is not rerun", () => {
    expect(() =>
      Agent.parse({
        ...validAgent,
        command: {
          id: "x",
          action: "converge",
          issued_by: "me",
          issued_at: "2026-09-03T09:01:00.000Z",
        },
      }),
    ).toThrow();
  });
});
