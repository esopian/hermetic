import { describe, expect, test } from "bun:test";
import type { AgentView } from "../src/api/index.ts";
import {
  DEFAULT_TAILNET,
  SIZES,
  agentCost,
  ec2InstanceConsoleUrl,
  ebsVolumeConsoleUrl,
  compareVersions,
  canonicalHostname,
  cloudName,
  legacyCloudNames,
  dashboardUrl,
  destroyedSummary,
  drawerActions,
  rebootState,
  fmtClock,
  fmtClockTz,
  fmtDate,
  fmtDateTime,
  fmtDuration,
  fmtUsd,
  healthColors,
  healthTitle,
  heartbeatAge,
  hostname,
  hostnameMismatch,
  isBehind,
  isBusy,
  isOff,
  latestHermes,
  tzLabel,
  volumeMonthlyUsd,
  fullDiskDetail,
  loadColor,
  offlineDetail,
  offlineUnit,
  pct,
  sizeGlyph,
  sizeSpec,
  statusColor,
  worstDisk,
  uptime,
  usedGib,
  rootFree,
  diskTitle,
  versionColor,
  width,
} from "../src/logic/format.ts";

/** Minimal, fully-populated AgentView; tests override only what they need. */
function agent(overrides: Partial<AgentView> = {}): AgentView {
  return {
    name: "atlas",
    status: "ready",
    version: 1,
    lock: null,
    size: "medium",
    instance_type: "t4g.2xlarge",
    region: "us-west-2",
    instance_id: "i-1",
    volume_id: "vol-1",
    volume_gib: 100,
    hermes_version: "1.2.0",
    hermeticd_version: "1.2.0",
    config_hash: null,
    provider: "bedrock",
    secrets_mode: "none",
    browser: true,
    tailscale_ip: "100.64.0.1",
    resources: { ssm_paths: [] },
    last_heartbeat: "2026-09-01T12:00:00.000Z",
    health: { hermes: true, tailscale: true, disk: true },
    metrics: { cpu_pct: 10, mem_pct: 20, disk_pct: 30 },
    created_by: "evan",
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T12:00:00.000Z",
    display_status: "ready",
    heartbeat_age_ms: 5_000,
    ...overrides,
  } as AgentView;
}

describe("durations and ages", () => {
  test("fmtDuration renders days, hours, minutes", () => {
    expect(fmtDuration(90 * 1000)).toBe("1m");
    expect(fmtDuration(90 * 60 * 1000)).toBe("1h 30m");
    expect(fmtDuration(3 * 86400 * 1000 + 4 * 3600 * 1000)).toBe("3d 04h");
  });

  test("fmtDuration rejects invalid input", () => {
    expect(fmtDuration(Number.NaN)).toBe("—");
    expect(fmtDuration(-5)).toBe("—");
  });

  test("uptime is — for stopped/destroyed agents or before the first heartbeat", () => {
    const now = Date.parse("2026-09-01T02:00:00.000Z");
    expect(uptime(agent({ display_status: "stopped" }), now)).toBe("—");
    expect(uptime(agent({ last_heartbeat: null }), now)).toBe("—");
    expect(uptime(agent({ created_at: "2026-09-01T00:00:00.000Z" }), now)).toBe("2h 00m");
  });

  test("heartbeatAge: never, just now, or an aged duration", () => {
    expect(heartbeatAge(agent({ heartbeat_age_ms: null }))).toBe("never");
    expect(heartbeatAge(agent({ heartbeat_age_ms: 30_000 }))).toBe("just now");
    expect(heartbeatAge(agent({ heartbeat_age_ms: 5 * 60_000 }))).toBe("5m ago");
  });
});

describe("percentages and bars", () => {
  test("pct renders — for null/undefined and rounds otherwise", () => {
    expect(pct(null)).toBe("—");
    expect(pct(undefined)).toBe("—");
    expect(pct(42.6)).toBe("43%");
  });

  test("width clamps into 0..100 and renders —-safe fallback for missing values", () => {
    expect(width(undefined)).toBe("0%");
    expect(width(-10)).toBe("0%");
    expect(width(150)).toBe("100%");
    expect(width(55)).toBe("55%");
  });

  test("loadColor thresholds", () => {
    expect(loadColor(null)).toBe("var(--fg3)");
    expect(loadColor(90)).toBe("var(--bad)");
    expect(loadColor(75)).toBe("var(--warn)");
    expect(loadColor(10)).toBe("var(--fg2)");
  });
});

/**
 * Two filesystems, one `disk` check (§6.4). The root disk is the one the
 * self-update needs room on, and until hermeticd learned to measure it a box
 * that had filled it looked healthy right up to the failed update.
 */
describe("the two disks", () => {
  test("worstDisk takes the fuller of the two", () => {
    expect(worstDisk({ cpu_pct: 1, mem_pct: 1, disk_pct: 30, root_disk_pct: 91 })).toBe(91);
    expect(worstDisk({ cpu_pct: 1, mem_pct: 1, disk_pct: 88, root_disk_pct: 12 })).toBe(88);
  });

  test("an unreported root disk is left out, not counted as empty", () => {
    // The bug this guards: `Math.max(30, root ?? 0)` reads the same as a root
    // disk measured at 0%, and an old hermeticd's silence would look like room.
    expect(worstDisk({ cpu_pct: 1, mem_pct: 1, disk_pct: 30 })).toBe(30);
    expect(worstDisk(null)).toBeNull();
    expect(worstDisk(undefined)).toBeNull();
    expect(loadColor(worstDisk(null))).toBe("var(--fg3)");
  });

  test("a barely-used volume reads as barely used, not as empty", () => {
    // 0.1% of 100 GiB is 0.1 GiB. Rounded to whole GiB it printed `0 GiB used`,
    // which on screen is the same thing an unmeasured volume says.
    expect(usedGib(0.1, 100)).toBe("0.1 GiB");
    expect(usedGib(18, 100)).toBe("18 GiB");
    expect(usedGib(5, 100)).toBe("5.0 GiB");
    expect(usedGib(null, 100)).toBe("—");
  });

  test("free space is a reading when the box reported one, and an estimate otherwise", () => {
    // Measured: printed as-is, no qualifier. This is the shape of the real
    // incident box — 96% of 8 GiB, and 256 MiB rather than the 327 the ratio
    // implies, because the volume is not the filesystem.
    expect(
      rootFree({ cpu_pct: 1, mem_pct: 1, disk_pct: 18, root_disk_pct: 96, root_free_mib: 256 }, 8),
    ).toEqual({ text: "256 MiB", measured: true });

    // No reading: derived from size × percentage, and marked `≈` because it
    // overstates by exactly the partitions and metadata it cannot see.
    expect(rootFree({ cpu_pct: 1, mem_pct: 1, disk_pct: 18, root_disk_pct: 96 }, 8)).toEqual({
      text: "≈328 MiB",
      measured: false,
    });
    expect(rootFree({ cpu_pct: 1, mem_pct: 1, disk_pct: 18, root_disk_pct: 50 }, 20)).toEqual({
      text: "≈10.0 GiB",
      measured: false,
    });

    // Nothing to derive from: a row with no size, or no reading at all.
    expect(rootFree({ cpu_pct: 1, mem_pct: 1, disk_pct: 18, root_disk_pct: 96 }, null)).toBeNull();
    expect(rootFree({ cpu_pct: 1, mem_pct: 1, disk_pct: 18 }, 8)).toBeNull();
    expect(rootFree(null, 8)).toBeNull();
  });

  test("the shared disk sentence carries both sizes, and says so when it cannot", () => {
    const measured = agent({
      root_gib: 8,
      metrics: { cpu_pct: 1, mem_pct: 1, disk_pct: 18, root_disk_pct: 96, root_free_mib: 256 },
    });
    expect(diskTitle(measured)).toBe(
      "data disk 18% of 100 GiB · system disk 96% of 8 GiB, 256 MiB free",
    );

    // A row from before the disk was sizeable: the reading is real, the
    // denominator is not known, and neither is invented.
    const unsized = agent({
      metrics: { cpu_pct: 1, mem_pct: 1, disk_pct: 18, root_disk_pct: 96 },
    });
    expect(diskTitle(unsized)).toBe(
      "data disk 18% of 100 GiB · system disk 96% full, size not recorded",
    );

    // An older hermeticd reports no root reading at all — which must never
    // render as `system disk — full`, the shape this replaced.
    expect(diskTitle(agent({ root_gib: 20 }))).toBe(
      "data disk 30% of 100 GiB · system disk not reported",
    );
  });

  test("a failing disk check names the filesystem that tripped it", () => {
    const rootFull = agent({
      root_gib: 8,
      health: { hermes: true, tailscale: true, disk: false },
      metrics: { cpu_pct: 1, mem_pct: 1, disk_pct: 18, root_disk_pct: 96, root_free_mib: 256 },
    });
    // The size and the bytes, because "96% full" alone is the same sentence on
    // a 500 GiB root that is completely fine.
    expect(fullDiskDetail(rootFull)).toContain("the system disk is 96% full of 8 GiB, 256 MiB free");
    // Both remedies, in the order they help: a rebuild on an 8 GiB root lands
    // back at ~75% and trips again on the next snap revision.
    expect(fullDiskDetail(rootFull)).toContain("A rebuild frees it for now");
    expect(fullDiskDetail(rootFull)).toContain("--root-gib");

    const dataFull = agent({
      health: { hermes: true, tailscale: true, disk: false },
      metrics: { cpu_pct: 1, mem_pct: 1, disk_pct: 94, root_disk_pct: 20 },
    });
    expect(fullDiskDetail(dataFull)).toBe("the data disk is 94% full of 100 GiB · system disk 20%");

    // Nothing measured, or a `/data` reading of 0% — which is what an unmounted
    // volume looks like — falls back to naming both possibilities.
    expect(fullDiskDetail(agent({ metrics: null }))).toBe("data volume is low or unmounted");
    expect(fullDiskDetail(agent({ metrics: { cpu_pct: 1, mem_pct: 1, disk_pct: 0 } }))).toBe(
      "data volume is low or unmounted",
    );
  });
});

describe("cost strings", () => {
  test("running agent: compute + storage monthly, hourly + gp3 breakdown", () => {
    const a = agent({ display_status: "ready", size: "medium", volume_gib: 100 });
    const cost = agentCost(a);
    expect(cost.monthly).toBe("≈ $204/mo"); // 196 + 100*0.08 = 204
    expect(cost.hourly).toContain("compute");
    expect(cost.hourly).toContain("gp3");
  });

  test("stopped agent: storage-only cost, compute called out as stopped", () => {
    const a = agent({ display_status: "stopped", size: "large", volume_gib: 50 });
    const cost = agentCost(a);
    expect(cost.monthly).toBe("≈ $4/mo");
    expect(cost.hourly).toBe("compute stopped · storage only");
  });

  test("destroyed agent with its volume kept: storage only, named as retained", () => {
    // §6.6: `destroy` keeps the data volume unless asked not to, and that
    // volume keeps costing money — the drawer must say so.
    const a = agent({
      display_status: "destroyed",
      size: "large",
      volume_gib: 50,
      volume_id: "vol-9",
      instance_id: null,
    });
    const cost = agentCost(a);
    expect(cost.monthly).toBe("≈ $4/mo");
    expect(cost.hourly).toBe("storage only · data volume retained");
  });

  test("destroyed agent whose volume was deleted bills nothing", () => {
    // A destroy that deleted the volume nulls `volume_id` but leaves `volume_gib`; the
    // old code billed the leftover size for a volume that no longer exists.
    const a = agent({
      display_status: "destroyed",
      size: "large",
      volume_gib: 50,
      volume_id: null,
      instance_id: null,
    });
    const cost = agentCost(a);
    expect(cost.monthly).toBe("≈ $0/mo");
    expect(cost.hourly).toBe("terminated · no ongoing cost");
  });

  test("fmtUsd rounds to whole dollars", () => {
    expect(fmtUsd(85.6)).toBe("$86");
  });
});

describe("hostname builder", () => {
  test("uses the given tailnet", () => {
    expect(hostname("atlas", "example.ts.net")).toBe("atlas.example.ts.net");
  });

  test("falls back to the default tailnet when none is given", () => {
    expect(hostname("atlas")).toBe(`atlas.${DEFAULT_TAILNET}`);
    expect(hostname("atlas", null)).toBe(`atlas.${DEFAULT_TAILNET}`);
  });

  test("dashboardUrl is the agent's own tailnet root — the Hermes dashboard", () => {
    expect(dashboardUrl("atlas", "example.ts.net")).toBe("https://atlas.example.ts.net/");
    expect(dashboardUrl("atlas")).toBe(`https://atlas.${DEFAULT_TAILNET}/`);
  });

  /**
   * The name the node reported wins over the one it was asked for. A recreate
   * cannot delete the old device, so the replacement joins as `<name>-2` and
   * MagicDNS keeps `<name>` on the terminated box — a link built from the
   * canonical spelling opens nothing.
   */
  test("the node's reported name wins over the canonical one", () => {
    expect(hostname("atlas", "example.ts.net", "atlas-2.example.ts.net")).toBe(
      "atlas-2.example.ts.net",
    );
    expect(dashboardUrl("atlas", "example.ts.net", "atlas-2.example.ts.net")).toBe(
      "https://atlas-2.example.ts.net/",
    );
  });

  test("a null or absent reported name falls back to the canonical one", () => {
    expect(hostname("atlas", "example.ts.net", null)).toBe("atlas.example.ts.net");
    expect(hostname("atlas", "example.ts.net", undefined)).toBe("atlas.example.ts.net");
    expect(canonicalHostname("atlas", "example.ts.net")).toBe("atlas.example.ts.net");
  });

  test("hostnameMismatch names both spellings, and is null when they agree", () => {
    expect(
      hostnameMismatch(
        { name: "atlas", tailscale_dns_name: "atlas-2.example.ts.net" },
        "example.ts.net",
      ),
    ).toEqual({
      real: "atlas-2.example.ts.net",
      canonical: "atlas.example.ts.net",
      // Nothing hermetic ever named a node `atlas-2`; that is Tailscale's
      // suffix, which is what a device sitting on the canonical name looks like.
      kind: "stale",
    });
    expect(
      hostnameMismatch({ name: "atlas", tailscale_dns_name: "atlas.example.ts.net" }, "example.ts.net"),
    ).toBeNull();
    // A row whose first heartbeat has not landed makes no claim either way.
    expect(hostnameMismatch({ name: "atlas", tailscale_dns_name: null }, "example.ts.net")).toBeNull();
  });

  /**
   * The tailnet is only known once `/api/meta` has answered. `hostname` may fall
   * back to `DEFAULT_TAILNET` to *show* something in the meantime; comparing
   * against that guess is how every agent with a dns name came to be called
   * stale for the first paint of every session. Core's `agentHostnameMismatch`
   * has the same clause — the two mirror each other.
   */
  test("hostnameMismatch says nothing when the tailnet is unknown", () => {
    const atlas = { name: "atlas", tailscale_dns_name: "atlas.example.ts.net" };
    expect(hostnameMismatch(atlas, null)).toBeNull();
    expect(hostnameMismatch(atlas)).toBeNull();
    expect(hostnameMismatch(atlas, "")).toBeNull();
    // And with a real tailnet, this row is not stale at all — the null above is
    // "cannot say", not "the check is off".
    expect(hostnameMismatch(atlas, "example.ts.net")).toBeNull();
    expect(
      hostnameMismatch({ name: "atlas", tailscale_dns_name: "atlas-2.example.ts.net" }, null),
    ).toBeNull();
  });

  /**
   * Since foundation v4 a node joins the tailnet as `<fleet id>-<agent>`
   * (`cloudName`, mirroring core's `packages/core/src/schema/fleet.ts`). Every
   * caller that knows the fleet's id has to spell that prefix, or a freshly
   * created agent that has not reported a `tailscale_dns_name` yet would show
   * (and link to) the bare agent name — a spelling nobody holds.
   */
  describe("cloudName / the fleet-prefixed hostname", () => {
    test("prefixes the agent name with the fleet's id, mirroring core's cloudName", () => {
      expect(cloudName("k7m2x9qa", "atlas")).toBe("k7m2x9qa-atlas");
    });

    test("an unknown or empty fleet id falls back to the bare agent name", () => {
      // Undefined/null: the caller does not know the fleet yet (meta has not
      // answered). Empty string: a pre-v3 fleet, which core also leaves bare.
      expect(cloudName(undefined, "atlas")).toBe("atlas");
      expect(cloudName(null, "atlas")).toBe("atlas");
      expect(cloudName("", "atlas")).toBe("atlas");
    });

    test("canonicalHostname and dashboardUrl carry the fleet prefix through", () => {
      expect(canonicalHostname("atlas", "hermetic.ts.net", "k7m2x9qa")).toBe(
        "k7m2x9qa-atlas.hermetic.ts.net",
      );
      expect(dashboardUrl("atlas", "hermetic.ts.net", null, "k7m2x9qa")).toBe(
        "https://k7m2x9qa-atlas.hermetic.ts.net/",
      );
    });

    test("hostname falls back to the canonical, fleet-prefixed name when no dns name has been reported", () => {
      // The exact shape a freshly created agent renders before its first
      // heartbeat: no `tailscale_dns_name` yet, so the canonical spelling —
      // with the fleet-id prefix — is the only thing there is to show.
      expect(hostname("atlas", "hermetic.ts.net", null, "k7m2x9qa")).toBe(
        "k7m2x9qa-atlas.hermetic.ts.net",
      );
      expect(hostname("atlas", "hermetic.ts.net", undefined, "k7m2x9qa")).toBe(
        "k7m2x9qa-atlas.hermetic.ts.net",
      );
    });

    test("a reported dns name still wins over the fleet-prefixed canonical one", () => {
      expect(hostname("atlas", "hermetic.ts.net", "atlas-2.hermetic.ts.net", "k7m2x9qa")).toBe(
        "atlas-2.hermetic.ts.net",
      );
    });

    test("hostnameMismatch compares against the fleet-prefixed canonical spelling", () => {
      // A device wearing a name hermetic never hands out — Tailscale's `-2`
      // suffix — is a stale device sitting on the canonical spelling.
      expect(
        hostnameMismatch(
          { name: "atlas", tailscale_dns_name: "k7m2x9qa-atlas-2.hermetic.ts.net" },
          "hermetic.ts.net",
          "k7m2x9qa",
          "main",
        ),
      ).toEqual({
        real: "k7m2x9qa-atlas-2.hermetic.ts.net",
        canonical: "k7m2x9qa-atlas.hermetic.ts.net",
        kind: "stale",
      });
      // And no mismatch once the reported name already carries the prefix.
      expect(
        hostnameMismatch(
          { name: "atlas", tailscale_dns_name: "k7m2x9qa-atlas.hermetic.ts.net" },
          "hermetic.ts.net",
          "k7m2x9qa",
          "main",
        ),
      ).toBeNull();
    });

    /**
     * The distinction the drawer's two sentences hang on. A node wearing a
     * spelling hermetic itself used to hand out is this agent's own machine
     * keeping the hostname it booted with — telling an operator to delete that
     * device in the admin console would evict the running agent.
     */
    describe("a node built before the naming rule moved", () => {
      test("the v3 `<fleet name>-<agent>` spelling reads as legacy, not stale", () => {
        expect(
          hostnameMismatch(
            { name: "atlas", tailscale_dns_name: "main-atlas.hermetic.ts.net" },
            "hermetic.ts.net",
            "k7m2x9qa",
            "main",
          ),
        ).toEqual({
          real: "main-atlas.hermetic.ts.net",
          canonical: "k7m2x9qa-atlas.hermetic.ts.net",
          kind: "legacy",
        });
      });

      test("the pre-v3 bare spelling reads as legacy too", () => {
        expect(
          hostnameMismatch(
            { name: "atlas", tailscale_dns_name: "atlas.hermetic.ts.net" },
            "hermetic.ts.net",
            "k7m2x9qa",
            "main",
          ),
        ).toEqual({
          real: "atlas.hermetic.ts.net",
          canonical: "k7m2x9qa-atlas.hermetic.ts.net",
          kind: "legacy",
        });
      });

      /**
       * Without the fleet's own name there is no way to know that
       * `main-atlas` was ever a spelling hermetic chose, so it reads as a
       * device holding a name — the safe direction to be wrong in, because it
       * over-reports rather than telling anyone to delete something.
       */
      test("the v3 spelling needs the fleet's name to be recognised", () => {
        expect(
          hostnameMismatch(
            { name: "atlas", tailscale_dns_name: "main-atlas.hermetic.ts.net" },
            "hermetic.ts.net",
            "k7m2x9qa",
          )?.kind,
        ).toBe("stale");
      });

      test("legacyCloudNames mirrors core: v3 spelling first, then the bare one", () => {
        expect(legacyCloudNames("main", "atlas")).toEqual(["main-atlas", "atlas"]);
        expect(legacyCloudNames(null, "atlas")).toEqual(["atlas"]);
      });
    });
  });
});

describe("version comparison and status", () => {
  test("compareVersions tolerates a leading v and missing segments", () => {
    expect(compareVersions("v1.2.0", "1.2")).toBe(0);
    expect(compareVersions("1.3.0", "1.2.9")).toBeGreaterThan(0);
    expect(compareVersions("1.1.0", "1.2.0")).toBeLessThan(0);
  });

  test("latestHermes prefers meta's version, else the fleet max", () => {
    expect(latestHermes([], "2.0.0")).toBe("2.0.0");
    const agents = [agent({ hermes_version: "1.0.0" }), agent({ hermes_version: "1.5.0" })];
    expect(latestHermes(agents, null)).toBe("1.5.0");
    expect(latestHermes([], undefined)).toBeNull();
  });

  test("isBehind and versionColor", () => {
    const a = agent({ hermes_version: "1.0.0" });
    expect(isBehind(a, "1.1.0")).toBe(true);
    expect(isBehind(a, null)).toBe(false);
    expect(versionColor(a, "1.1.0")).toBe("var(--warn)");
    expect(versionColor(a, "1.0.0")).toBe("var(--fg)");
  });

  test("a destroyed agent is never behind — it cannot take an upgrade", () => {
    const gone = agent({ hermes_version: "1.0.0", display_status: "destroyed" });
    expect(isBehind(gone, "1.1.0")).toBe(false);
    expect(versionColor(gone, "1.1.0")).toBe("var(--fg)");
  });

  test("a stopped agent that is behind still shows it", () => {
    // It takes the upgrade on its next start/recreate, so the signal is real.
    const off = agent({ hermes_version: "1.0.0", display_status: "stopped" });
    expect(isBehind(off, "1.1.0")).toBe(true);
    expect(versionColor(off, "1.1.0")).toBe("var(--warn)");
  });

  test("statusColor covers every display status bucket", () => {
    expect(statusColor("ready")).toBe("var(--ok)");
    expect(statusColor("degraded")).toBe("var(--warn)");
    expect(statusColor("unreachable")).toBe("var(--bad)");
    expect(statusColor("error")).toBe("var(--bad)");
    expect(statusColor("stopped")).toBe("var(--fg3)");
    expect(statusColor("destroyed")).toBe("var(--fg3)");
    expect(statusColor("creating")).toBe("var(--acc)");
  });

  test("isBusy / isOff", () => {
    expect(isBusy(agent({ display_status: "creating" }))).toBe(true);
    expect(isBusy(agent({ display_status: "bootstrapping" }))).toBe(true);
    expect(isBusy(agent({ display_status: "stopping" }))).toBe(true);
    expect(isBusy(agent({ display_status: "destroying" }))).toBe(true);
    expect(isBusy(agent({ display_status: "ready" }))).toBe(false);
    // `converging` left the state machine with `converge` itself (§4.3); a
    // server still sending it must not be read as an operation in flight.
    const stale = agent();
    (stale as { display_status: string }).display_status = "converging";
    expect(isBusy(stale)).toBe(false);
    expect(isBusy(agent({ display_status: "error" }))).toBe(false);
    expect(isOff(agent({ display_status: "stopped" }))).toBe(true);
    expect(isOff(agent({ display_status: "destroyed" }))).toBe(true);
    expect(isOff(agent({ display_status: "ready" }))).toBe(false);
  });
});

describe("health squares", () => {
  test("offline agents render all fg3", () => {
    expect(healthColors(agent({ display_status: "stopped" }))).toEqual([
      "var(--fg3)",
      "var(--fg3)",
      "var(--fg3)",
    ]);
  });

  test("no health yet renders pending (line2)", () => {
    expect(healthColors(agent({ health: null }))).toEqual([
      "var(--line2)",
      "var(--line2)",
      "var(--line2)",
    ]);
  });

  test("failing checks render bad, or warn while degraded", () => {
    const bad = agent({ health: { hermes: false, tailscale: true, disk: true } });
    expect(healthColors(bad)[0]).toBe("var(--bad)");
    const degraded = agent({
      display_status: "degraded",
      health: { hermes: false, tailscale: true, disk: true },
    });
    expect(healthColors(degraded)[0]).toBe("var(--warn)");
  });

  test("healthTitle summarizes failing checks", () => {
    expect(healthTitle(agent({ display_status: "stopped" }))).toBe("offline");
    expect(healthTitle(agent({ health: null }))).toBe("pending");
    expect(healthTitle(agent({ health: { hermes: false, tailscale: false, disk: true } }))).toBe(
      "hermes, tailscale failing",
    );
    expect(healthTitle(agent())).toBe("all checks passing");
  });
});

describe("sizes", () => {
  test("sizeSpec resolves known ids and falls back to medium", () => {
    expect(sizeSpec("small").instance_type).toBe("r8g.large");
    expect(sizeSpec("gpu-xlarge")).toMatchObject({
      instance_type: "g5g.16xlarge",
      gpu: { count: 2, memGib: 32 },
    });
    expect(sizeSpec("nonsense").id).toBe("medium");
  });

  test("sizeGlyph mirrors sizeSpec", () => {
    for (const s of SIZES) expect(sizeGlyph(s.id)).toBe(s.glyph);
  });
});

describe("ec2InstanceConsoleUrl", () => {
  test("builds the regional instance-details console URL", () => {
    expect(ec2InstanceConsoleUrl("i-0abcd1234ef567890", "us-east-1")).toBe(
      "https://us-east-1.console.aws.amazon.com/ec2/home?region=us-east-1#InstanceDetails:instanceId=i-0abcd1234ef567890",
    );
  });

  test("returns null when the instance id or region is missing", () => {
    expect(ec2InstanceConsoleUrl(null, "us-east-1")).toBeNull();
    expect(ec2InstanceConsoleUrl("i-1", null)).toBeNull();
    expect(ec2InstanceConsoleUrl(undefined, undefined)).toBeNull();
  });
});

describe("clock/date formatting", () => {
  test("fmtClock renders HH:MM:SS and — for invalid input", () => {
    expect(fmtClock("2026-09-01T12:34:56.000Z")).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(fmtClock("not-a-date")).toBe("--:--:--");
  });

  test("fmtDate renders a short date and — for invalid input", () => {
    expect(fmtDate("2026-09-01T00:00:00.000Z")).toContain("2026");
    expect(fmtDate("not-a-date")).toBe("—");
  });

  /**
   * §4.4 has more than one operator per fleet, and every absolute time in this
   * UI is rendered in whichever of their local zones happens to be reading it.
   * A bare wall clock is a number two of them will read differently and both be
   * sure of.
   */
  test("tzLabel names a zone, or nothing at all — never `undefined`", () => {
    const label = tzLabel();
    expect(typeof label).toBe("string");
    // Whatever the runner's TZ is, it is not the string "undefined".
    expect(label).not.toContain("undefined");
  });

  test("fmtDateTime carries the date, the time and the zone", () => {
    const out = fmtDateTime("2026-09-01T12:34:56.000Z");
    expect(out).toContain("2026");
    // The zone label is what the plain `toLocaleString()` these call sites used
    // to reach for did not have.
    const zone = tzLabel(new Date("2026-09-01T12:34:56.000Z"));
    if (zone) expect(out).toContain(zone);
  });

  /**
   * The teardown receipt had no guard at all and rendered "Invalid Date" for a
   * malformed record. The stored bytes are more use to whoever has to explain
   * them than an em dash is, so they come back verbatim.
   */
  test("fmtDateTime hands back an unparseable value rather than Invalid Date", () => {
    expect(fmtDateTime("not-a-date")).toBe("not-a-date");
    expect(fmtDateTime("")).toBe("");
  });

  test("fmtClockTz is fmtClock plus a zone, and keeps the dashes for bad input", () => {
    expect(fmtClockTz("not-a-date")).toBe("--:--:--");
    expect(fmtClockTz("2026-09-01T12:34:56.000Z")).toContain(fmtClock("2026-09-01T12:34:56.000Z"));
  });
});

describe("ebsVolumeConsoleUrl", () => {
  test("opens the volume's own page in its region", () => {
    const url = ebsVolumeConsoleUrl("vol-0a1b2c3d", "us-west-2");
    expect(url).toContain("us-west-2.console.aws.amazon.com");
    expect(url).toContain("region=us-west-2");
    expect(url).toContain("VolumeDetails:volumeId=vol-0a1b2c3d");
  });

  test("returns null when either half is missing, so the caller can drop the link", () => {
    // Same rule as the instance link: the console is regional, so an id alone
    // is not a URL.
    expect(ebsVolumeConsoleUrl("vol-1", null)).toBeNull();
    expect(ebsVolumeConsoleUrl(null, "us-west-2")).toBeNull();
    expect(ebsVolumeConsoleUrl(undefined, undefined)).toBeNull();
  });
});

describe("volumeMonthlyUsd", () => {
  test("prices gp3 off the one constant the cost copy uses", () => {
    // The create drawer's volume picker and the agent drawer's cost line must
    // not be able to disagree about what 100 GiB costs.
    expect(volumeMonthlyUsd(100)).toBeCloseTo(8, 6);
    expect(volumeMonthlyUsd(0)).toBe(0);
    expect(volumeMonthlyUsd(500)).toBeCloseTo(40, 6);
  });
});

describe("drawerActions", () => {
  test("a destroyed agent gets no lifecycle actions at all", () => {
    // `TRANSITIONS.destroyed` is empty in core, so start/recreate/rerun/upgrade
    // /destroy would every one come back INVALID_TRANSITION.
    expect(drawerActions("destroyed")).toEqual({
      dashboard: false,
      upgrade: false,
      rerun: false,
      reboot: false,
      rebuild: false,
      power: null,
      destroy: false,
    });
  });

  test("a stopped agent is offered Start and a rebuild, but no reboot", () => {
    const a = drawerActions("stopped");
    expect(a.power).toBe("start");
    // There is an instance, but no operating system to ask — core refuses it
    // and names `agent start` instead.
    expect(a.reboot).toBe(false);
    expect(a.rebuild).toBe(true);
    expect(a.destroy).toBe(true);
  });

  test("a ready agent is offered Stop, Reboot and Rebuild", () => {
    const a = drawerActions("ready");
    expect(a.power).toBe("stop");
    expect(a.reboot).toBe(true);
    expect(a.rebuild).toBe(true);
    expect(a.dashboard).toBe(true);
  });

  test("an unreachable agent — the case reboot is for — still gets it", () => {
    const a = drawerActions("unreachable");
    expect(a.reboot).toBe(true);
  });

  test("a stopping agent is mid-operation: neither reboot nor rebuild", () => {
    const a = drawerActions("stopping");
    expect(a.reboot).toBe(false);
    expect(a.rebuild).toBe(false);
  });

  test("an errored agent is offered Rerun", () => {
    const a = drawerActions("error");
    expect(a.rerun).toBe(true);
    expect(a.power).toBe("stop");
  });
});

describe("offlineDetail", () => {
  test("names what actually happened to the instance", () => {
    expect(offlineDetail("destroyed")).toBe("offline · instance terminated");
    expect(offlineDetail("stopped")).toBe("offline · instance stopped");
  });
});

describe("offlineUnit", () => {
  test("the metric tiles make the same distinction the health strip does", () => {
    expect(offlineUnit("destroyed")).toBe("terminated");
    expect(offlineUnit("stopped")).toBe("stopped");
  });
});

describe("destroyedSummary", () => {
  test("names the volume a legacy destroyed row still owns", () => {
    expect(destroyedSummary("vol-123")).toBe(
      "destroyed · legacy record · data volume vol-123 retained",
    );
  });

  test("says so when the destroy deleted it", () => {
    expect(destroyedSummary(null)).toBe("destroyed · legacy record · data volume deleted");
    expect(destroyedSummary(undefined)).toBe("destroyed · legacy record · data volume deleted");
  });
});

describe("rebootState", () => {
  const beat = "2026-09-01T11:58:00.000Z";

  test("nothing pressed reads Reboot", () => {
    expect(rebootState({ last_heartbeat: beat }, null)).toMatchObject({
      pending: false,
      label: "Reboot",
    });
  });

  test("pending while the row still carries the pre-reboot heartbeat, or none", () => {
    const issued = { before: beat };
    expect(rebootState({ last_heartbeat: beat }, issued).pending).toBe(true);
    expect(rebootState({ last_heartbeat: null }, issued).label).toBe("Rebooting…");
  });

  test("any other heartbeat is the box back, even one stamped earlier by a skewed clock", () => {
    const issued = { before: beat };
    expect(rebootState({ last_heartbeat: "2026-09-01T11:59:00.000Z" }, issued).pending).toBe(false);
    expect(rebootState({ last_heartbeat: "2026-09-01T11:57:59.000Z" }, issued).pending).toBe(false);
  });

  test("a box that had never heartbeated is back on its first", () => {
    const issued = { before: null };
    expect(rebootState({ last_heartbeat: null }, issued).pending).toBe(true);
    expect(rebootState({ last_heartbeat: beat }, issued).pending).toBe(false);
  });
});
