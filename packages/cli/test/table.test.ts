/**
 * `agent status`'s text, rendered directly rather than through a spawned CLI:
 * the lines here are about one row's fields, and a fixture fleet cannot carry
 * every shape a real Tailscale answer has.
 */
import { describe, expect, test } from "bun:test";
import type { AgentEvent, AgentTombstone, AgentView, ProbeReport } from "@hermetic/core";
import {
  formatDisk,
  renderDestroyed,
  renderHistory,
  renderProbe,
  renderPs,
  renderStatus,
} from "../src/table.ts";

function agent(overrides: Partial<AgentView> = {}): AgentView {
  return {
    name: "atlas",
    status: "ready",
    display_status: "ready",
    version: 3,
    lock: null,
    size: "medium",
    instance_type: "t4g.2xlarge",
    region: "us-west-2",
    instance_id: "i-0123456789abcdef0",
    volume_id: "vol-0123456789abcdef0",
    volume_gib: 100,
    hermes_version: "0.21.0",
    hermeticd_version: "0.4.1",
    config_hash: "abc123",
    provider: "bedrock",
    secrets_mode: "none",
    browsers: [{ name: "default", serve_path: "/vnc" }],
    tailscale_ip: "100.64.12.4",
    resources: { ssm_paths: [] },
    last_heartbeat: "2026-09-05T11:59:55.000Z",
    heartbeat_age_ms: 5_000,
    health: { hermes: true, tailscale: true, disk: true, dashboard: true },
    metrics: { cpu_pct: 10, mem_pct: 20, disk_pct: 30 },
    created_by: "evan",
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-05T11:59:55.000Z",
    ...overrides,
  } as AgentView;
}

/** One `agent status` line by its label, with the label and padding stripped. */
function line(a: AgentView, label: string): string {
  return renderStatus(a)
    .split("\n")
    .find((l) => l.startsWith(`${label} `) || l === label)!
    .slice(label.length)
    .trim();
}

/**
 * §6.4's two layers, as `agent status` reports them. Hermetic manages what it
 * was told to manage: a setting the operator stated is in the managed config
 * and `agent set` moves it; one they did not is seeded into the agent's own
 * config and is the agent's from then on. Printing the second as though it were
 * current fact would be a lie — the box may have changed it — so the line says
 * which of the two it is.
 */
describe("agent status · the Hermes settings", () => {
  test("an unstated setting shows the seeded default and says whose it is", () => {
    const a = agent({ provider: "bedrock", hermes: null });
    expect(line(a, "model")).toBe("zai.glm-4.7-flash (seeded — the agent's to change)");
    expect(line(a, "terminal")).toBe("local (seeded — the agent's to change)");
    expect(line(a, "max turns")).toBe("500 (seeded — the agent's to change)");
    expect(line(a, "reasoning")).toBe("medium (seeded — the agent's to change)");
  });

  test("a stated setting is managed, and only that one", () => {
    const a = agent({ hermes: { model: "claude-sonnet-5", max_turns: 42 } });
    expect(line(a, "model")).toBe("claude-sonnet-5 (managed)");
    expect(line(a, "max turns")).toBe("42 (managed)");
    expect(line(a, "terminal")).toBe("local (seeded — the agent's to change)");
    expect(line(a, "reasoning")).toBe("medium (seeded — the agent's to change)");
  });

  /**
   * `approvals_mode` is seed-only: `managed` can never carry it, so the row has
   * no owner to decide and says the one thing that is always true — the value
   * hermetic asked for, and that the agent may have moved it since.
   */
  test("approvals is seeded whether or not the operator stated it", () => {
    const unstated = line(agent({ hermes: null }), "approvals");
    expect(unstated).toStartWith("off (seeded — the agent's to change");
    const stated = line(agent({ hermes: { approvals_mode: "smart" } }), "approvals");
    expect(stated).toStartWith("smart (seeded — the agent's to change");
    // Never the managed branch, however it was stated.
    expect(stated).not.toContain("(managed)");
  });

  /**
   * The fleet's answers are frozen onto the row at create (`Agent.seed`), and
   * they outrank this build's constants for every field the operator left
   * alone. Reading them is the difference between reporting what the box was
   * actually seeded with and reporting what a default-everything agent would
   * have got — and on `approvals` that is the line somebody checks before
   * believing an agent will not stop and wait for a human who is not there.
   */
  test("an unstated setting reads the fleet's seed, not this build's default", () => {
    const a = agent({
      hermes: null,
      seed: { approvals_mode: "smart", max_turns: 42, reasoning_effort: "high" },
    });
    expect(line(a, "approvals")).toStartWith("smart (seeded — the agent's to change");
    expect(line(a, "max turns")).toBe("42 (seeded — the agent's to change)");
    expect(line(a, "reasoning")).toBe("high (seeded — the agent's to change)");
    // A stated setting still outranks the fleet's answer.
    const stated = agent({ hermes: { approvals_mode: "off" }, seed: { approvals_mode: "smart" } });
    expect(line(stated, "approvals")).toStartWith("off (seeded");
  });

  test("the seeded model follows the provider, since there is no fleet-wide answer", () => {
    expect(line(agent({ provider: "anthropic", hermes: null }), "model")).toContain("seeded");
    expect(line(agent({ provider: "anthropic", hermes: null }), "model")).not.toBe(
      line(agent({ provider: "bedrock", hermes: null }), "model"),
    );
  });
});

/** The `tailnet name` line, whichever of the pairs it lands on. */
function tailnetLine(a: AgentView): string {
  return renderStatus(a)
    .split("\n")
    .find((l) => l.startsWith("tailnet name"))!
    .replace(/^tailnet name\s+/, "");
}

describe("agent status · the tailnet name", () => {
  test("a node holding its own name is printed plainly", () => {
    expect(tailnetLine(agent({ tailscale_dns_name: "atlas.hermetic.ts.net" }))).toBe(
      "atlas.hermetic.ts.net",
    );
  });

  test("a node under another name says which device holds the canonical one", () => {
    expect(tailnetLine(agent({ tailscale_dns_name: "atlas-2.hermetic.ts.net" }))).toBe(
      "atlas-2.hermetic.ts.net (canonical atlas.hermetic.ts.net is held by a stale device)",
    );
  });

  /**
   * Tailscale's `DNSName` is fully qualified — the root dot is really there in
   * the API's answer. Left on, it becomes a trailing empty label: the canonical
   * name reconstructed from the suffix came out `atlas.hermetic.ts.net.`, which
   * is not what any other line of hermetic prints and not what an operator
   * would type.
   */
  test("a fully qualified name loses its root dot", () => {
    expect(tailnetLine(agent({ tailscale_dns_name: "atlas.hermetic.ts.net." }))).toBe(
      "atlas.hermetic.ts.net",
    );
    expect(tailnetLine(agent({ tailscale_dns_name: "atlas-2.hermetic.ts.net." }))).toBe(
      "atlas-2.hermetic.ts.net (canonical atlas.hermetic.ts.net is held by a stale device)",
    );
  });

  test("a row whose node has not reported prints nothing to guess from", () => {
    expect(tailnetLine(agent({ tailscale_dns_name: null }))).toBe("-");
  });
});

/**
 * The two URLs an operator would otherwise have to assemble by hand: the
 * dashboard, and the Hermes Desktop connection (§7.4), which nothing else in
 * hermetic links to.
 */
describe("agent status · the URLs", () => {
  /** Every line with this label, since `desktop` is one per browser. */
  function lines(a: AgentView, label: string): string[] {
    return renderStatus(a)
      .split("\n")
      .filter((l) => l.startsWith(`${label} `))
      .map((l) => l.slice(label.length).trim());
  }

  test("both, addressed at the name the node actually holds", () => {
    const a = agent({ tailscale_dns_name: "atlas-2.hermetic.ts.net" });
    expect(lines(a, "dashboard")).toEqual(["https://atlas-2.hermetic.ts.net/"]);
    // The trailing slash: `/vnc` alone resolves the client's links at the root.
    expect(lines(a, "desktop")).toEqual(["https://atlas-2.hermetic.ts.net/vnc/"]);
  });

  test("an agent with no browser gets no desktop line — `browser off` says why", () => {
    const a = agent({ browsers: [], tailscale_dns_name: "atlas.hermetic.ts.net" });
    expect(lines(a, "desktop")).toEqual([]);
    expect(lines(a, "dashboard")).toHaveLength(1);
  });

  /**
   * A URL built from a name the node may not answer on is worse than no URL,
   * so a row whose node has not reported one yet gets neither line.
   */
  test("a row whose node has not reported a name prints no URL at all", () => {
    const a = agent({ tailscale_dns_name: null });
    expect(lines(a, "dashboard")).toEqual([]);
    expect(lines(a, "desktop")).toEqual([]);
  });

  test("the root dot Tailscale reports does not reach the URL", () => {
    const a = agent({ tailscale_dns_name: "atlas.hermetic.ts.net." });
    expect(lines(a, "desktop")).toEqual(["https://atlas.hermetic.ts.net/vnc/"]);
  });
});

/**
 * `agent probe` prints every layer, passing or not, because the *shape* of the
 * failure is the diagnosis. The two browser layers are part of that shape.
 */
describe("agent probe · the layer table", () => {
  function report(over: Partial<ProbeReport> = {}): ProbeReport {
    const layer = { outcome: "ok" as const, detail: "fine", latency_ms: 5 };
    return {
      name: "atlas",
      at: "2026-09-16T12:00:00.000Z",
      row: {
        status: "ready",
        display_status: "ready",
        last_heartbeat: "2026-09-16T11:59:55.000Z",
        heartbeat_age_ms: 5_000,
        updated_at: "2026-09-16T11:59:55.000Z",
        health: { hermes: true, tailscale: true, disk: true },
        hermeticd_version: "0.5.1",
        lock: null,
        bootstrap: null,
      },
      instance: {
        ...layer,
        instance_id: "i-1",
        state: "running",
        system_status: "ok",
        instance_status: "ok",
        not_found: false,
      },
      hermeticd: {
        ...layer,
        tailscale_ip: "100.64.12.4",
        hermeticd_version: "0.5.1",
        protocol: 1,
        config_hash: "abc",
      },
      dashboard: { ...layer, url: "https://atlas.hermetic.ts.net/", http_status: 200 },
      desktop: { ...layer, url: "https://atlas.hermetic.ts.net/vnc/", http_status: 200 },
      browser: { ...layer, browsers: [] },
      verdict: { level: "ok", summary: "all layers answer", hints: [] },
      ...over,
    };
  }

  test("five layers, in the order they fail in", () => {
    const printed = renderProbe(report())
      .split("\n")
      .filter((l) => /^[\u2713\u2717\u2013]/.test(l))
      .map((l) => l.slice(3).trim().split(/\s\s+/)[0]);
    expect(printed).toEqual(["instance", "hermeticd", "dashboard", "desktop", "browser"]);
  });

  test("the browser row prints the layer's own detail, including which one is down", () => {
    const printed = renderProbe(
      report({
        browser: {
          outcome: "fail",
          detail: "default: hermetic-browser@default is activating (auto-restart)",
          latency_ms: 7,
          browsers: [],
        },
      }),
    );
    expect(printed).toContain("\u2717  browser");
    expect(printed).toContain("default: hermetic-browser@default is activating (auto-restart)");
  });

  test("a `--no-browser` agent shows both rows as skipped, with the reason", () => {
    const printed = renderProbe(
      report({
        desktop: {
          outcome: "skip",
          detail: "created with --no-browser",
          latency_ms: null,
          url: null,
          http_status: null,
        },
        browser: {
          outcome: "skip",
          detail: "created with --no-browser",
          latency_ms: null,
          browsers: [],
        },
      }),
    );
    expect(printed).toContain("\u2013  desktop");
    expect(printed).toContain("\u2013  browser");
  });
});

/**
 * The root filesystem is a second, separately-failing disk (§6.4): it is what
 * the self-update needs space on, and a row that reports nothing about it is
 * not a row reporting an empty one.
 */
describe("the two disks", () => {
  test("`agent status` names both filesystems, and sizes both when it can", () => {
    const a = agent({
      root_gib: 20,
      metrics: { cpu_pct: 10, mem_pct: 20, disk_pct: 30, root_disk_pct: 91 },
    });
    expect(line(a, "disk")).toBe("data 30% of 100 GiB · system 91% of 20 GiB");
  });

  test("a row from before `root_gib` reports the reading without inventing a size", () => {
    const a = agent({ metrics: { cpu_pct: 10, mem_pct: 20, disk_pct: 30, root_disk_pct: 91 } });
    expect(line(a, "disk")).toBe("data 30% of 100 GiB · system 91%");
  });

  test("a row from an older hermeticd says so rather than printing 0%", () => {
    expect(line(agent(), "disk")).toBe("data 30% of 100 GiB · system not reported");
    expect(line(agent({ metrics: null }), "disk")).toBe(
      "data not reported of 100 GiB · system not reported",
    );
  });

  test("`agent ps` carries a data/root cell, with `-` for anything unmeasured", () => {
    expect(formatDisk({ cpu_pct: 1, mem_pct: 1, disk_pct: 30, root_disk_pct: 91 })).toBe("30%/91%");
    expect(formatDisk({ cpu_pct: 1, mem_pct: 1, disk_pct: 30 })).toBe("30%/-");
    expect(formatDisk(null)).toBe("-/-");

    const table = renderPs([
      agent({ metrics: { cpu_pct: 10, mem_pct: 20, disk_pct: 30, root_disk_pct: 91 } }),
    ]);
    expect(table.split("\n")[0]).toContain("DISK D/R");
    expect(table.split("\n")[1]).toContain("30%/91%");
  });
});

/**
 * `agent history` is where a failed boot is read from a laptop that cannot
 * reach the box. The table is the index — one line per event — and a failed
 * stage's `log_tail` is the evidence, printed under it rather than crammed into
 * the `DETAIL` column (§4.2).
 */
describe("a failed stage's log tail in `agent history`", () => {
  function event(overrides: Partial<AgentEvent> = {}): AgentEvent {
    return {
      name: "atlas",
      timestamp: "2026-09-05T12:00:00.000Z",
      actor: "hermeticd@atlas",
      action: "stage",
      from_status: null,
      to_status: null,
      detail: "01-tailscale ok in 3.1s",
      ...overrides,
    };
  }

  test("a history with no tails renders as the bare table", () => {
    const rendered = renderHistory([event()]);
    expect(rendered.split("\n")[0]).toContain("TIMESTAMP");
    expect(rendered.split("\n")).toHaveLength(2);
    expect(rendered).not.toContain("log tail");
  });

  test("an event carrying a tail prints it under the table, indented", () => {
    const failed = event({
      detail: "01-tailscale failed exit 7: backend error",
      log_tail: "resolving the tailnet\nstderr: backend error: no route to host",
    });
    const lines = renderHistory([event(), failed]).split("\n");

    // The table is untouched: header plus one line per event, then the block.
    expect(lines[0]).toContain("TIMESTAMP");
    expect(lines[1]).toContain("01-tailscale ok in 3.1s");
    expect(lines[2]).toContain("failed exit 7");
    expect(lines[3]).toBe("");
    expect(lines[4]).toBe("--- 2026-09-05T12:00:00.000Z stage · log tail (2 lines) ---");
    expect(lines[5]).toBe("  resolving the tailnet");
    expect(lines[6]).toBe("  stderr: backend error: no route to host");
  });

  test("one line reads as one line", () => {
    const rendered = renderHistory([event({ log_tail: "the only thing it said" })]);
    expect(rendered).toContain("log tail (1 line) ---");
  });
});

describe("agent destroyed · the tombstone table", () => {
  const NOW = Date.parse("2026-09-29T12:00:00.000Z");
  const tombstone = (over: Partial<AgentTombstone> = {}): AgentTombstone => ({
    name: "granite",
    fleet_id: "fxtr0001",
    created_at: "2026-09-01T09:00:00.000Z",
    created_by: "arn:aws:iam::123456789012:user/ops",
    destroyed_at: "2026-09-29T09:00:00.000Z",
    destroyed_by: "arn:aws:iam::123456789012:user/ops",
    size: "small",
    region: "us-west-2",
    provider: "anthropic",
    profile_id: "ant00001",
    instance_id: "i-0abc",
    volume_id: "vol-0abc",
    volume_kept: false,
    hermes_version: "0.21.1",
    legacy: false,
    ...over,
  });

  test("nothing destroyed says so", () => {
    expect(renderDestroyed([], NOW)).toBe("no destroyed agents");
  });

  test("a row carries the age and the instant, who, when created, and the volume's fate", () => {
    const [head, row] = renderDestroyed([tombstone()], NOW).split("\n");
    expect(head).toMatch(/^NAME\s+DESTROYED\s+BY\s+CREATED\s+VOLUME$/);
    expect(row).toContain("granite");
    expect(row).toContain("3h ago · 2026-09-29T09:00:00.000Z");
    expect(row).toContain("2026-09-01T09:00:00.000Z");
    expect(row).toContain("vol-0abc deleted");
    expect(row).not.toContain("legacy");
  });

  test("a kept volume, no volume, and a legacy record each read as themselves", () => {
    const lines = renderDestroyed(
      [
        tombstone({ volume_kept: true }),
        tombstone({ name: "oriole", volume_id: null }),
        tombstone({ name: "cinder", legacy: true }),
      ],
      NOW,
    ).split("\n");
    expect(lines[1]).toContain("vol-0abc kept");
    expect(lines[2]).toMatch(/oriole.*\s-\s*$/);
    expect(lines[3]).toMatch(/legacy$/);
  });
});
