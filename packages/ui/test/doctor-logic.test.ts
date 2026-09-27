/**
 * The doctor checklist: every check states itself, passing or not, and a check
 * that could not run says so rather than being left out — a missing row and a
 * passing row look identical to the operator reading the panel, which is the
 * bug this module exists to prevent.
 */
import { describe, expect, test } from "bun:test";
import type { DoctorCheck, DoctorFacts } from "../src/logic/doctor-logic.ts";
import { checkTally, doctorChecks, tallyLine } from "../src/logic/doctor-logic.ts";

/**
 * A fleet with nothing wrong: every check below should pass on this.
 *
 * It is a `nat` fleet on purpose. `public` is the commoner mode but it has no
 * NAT appliance, so two of §5's checks cannot run there and come back `skip` —
 * which is correct, and would quietly turn "every check passes" into "every
 * check passes or was not run". A healthy `nat` fleet is the only shape that
 * keeps that assertion strict; the `public` case is asserted on its own below.
 */
function healthy(): DoctorFacts {
  return {
    ok: true,
    account: { frozen: "123456789012", observed: "123456789012", ok: true },
    fleet: { local: "f-abc", stack_tag: "f-abc", fleet_item: "f-abc", ok: true },
    foundation: {
      present: true,
      status: "CREATE_COMPLETE",
      outdated: false,
      version: 2,
      available_version: 2,
    },
    security_group: { inbound_rules: 0, ok: true },
    env_overrides: [],
    unparseable_rows: [],
    heartbeats: [{ name: "atlas", status: "ready", age_ms: 20_000, unreachable: false }],
    findings: [],
    instance_drift: [],
    tailscale: {
      available: true,
      missing: [],
      stale: [],
      detail: null,
      policy: { scope: "write", managed: "managed", blocks_drifted: [] },
    },
    local_tailscale: {
      ok: true,
      tailnet: "hermetic.ts.net",
      https_certificates: true,
      detail: "tailscale: hermetic.ts.net, HTTPS certificates on",
    },
    network: {
      mode: "nat",
      stack_mode: "nat",
      consistent: true,
      nat: {
        instance_id: "i-nat0",
        instance_state: "running",
        egress_ip: "203.0.113.10",
        route_state: "active",
      },
      checked_nat: true,
      drifted: [],
    },
  };
}

/** The commoner mode: no NAT appliance, so §5's two appliance checks cannot run. */
function publicFleet(): DoctorFacts {
  const d = healthy();
  d.network = {
    mode: "public",
    stack_mode: "public",
    consistent: true,
    nat: null,
    checked_nat: false,
    drifted: [],
  };
  return d;
}

function flat(d: DoctorFacts): DoctorCheck[] {
  return doctorChecks(d).flatMap((g) => g.checks);
}

function byId(d: DoctorFacts, id: string): DoctorCheck {
  const check = flat(d).find((c) => c.id === id);
  if (!check) throw new Error(`no check ${id}`);
  return check;
}

describe("doctorChecks", () => {
  test("a healthy fleet still renders every check, all passing", () => {
    const checks = flat(healthy());
    expect(checks.length).toBeGreaterThan(10);
    expect(checks.every((c) => c.state === "ok")).toBe(true);
  });

  test("no two checks share an id — the id is the render key", () => {
    const ids = flat(healthy()).map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every check says something, in every state", () => {
    const d = healthy();
    d.account.ok = false;
    d.tailscale.available = false;
    d.local_tailscale = { ok: false, tailnet: null, https_certificates: false, detail: "wedged" };
    for (const c of flat(d)) expect(c.detail.length).toBeGreaterThan(0);
  });

  test("groups are the five an operator reads, in order", () => {
    expect(doctorChecks(healthy()).map((g) => g.title)).toEqual([
      "Account and fleet",
      "Agents",
      "Network",
      "Tailnet",
      "This machine",
    ]);
  });
});

describe("the network checks (§5)", () => {
  test("a public fleet skips the NAT checks rather than passing them", () => {
    const d = publicFleet();
    expect(byId(d, "nat-instance").state).toBe("skip");
    expect(byId(d, "nat-route").state).toBe("skip");
    // The mode itself is still checked: a public fleet records a mode too.
    expect(byId(d, "network-mode").state).toBe("ok");
    expect(byId(d, "network-placement").state).toBe("ok");
  });

  test("a healthy nat fleet passes all four and names the egress ip", () => {
    const d = healthy();
    expect(byId(d, "network-mode").state).toBe("ok");
    expect(byId(d, "nat-instance").state).toBe("ok");
    expect(byId(d, "nat-instance").detail).toContain("203.0.113.10");
    expect(byId(d, "nat-route").state).toBe("ok");
    expect(byId(d, "network-placement").state).toBe("ok");
  });

  test("a stopped NAT instance fails, and says the fleet has no internet", () => {
    const d = healthy();
    d.network = {
      ...d.network,
      nat: { instance_id: "i-nat0", instance_state: "stopped", egress_ip: null, route_state: "active" },
    };
    const c = byId(d, "nat-instance");
    expect(c.state).toBe("bad");
    expect(c.detail).toContain("stopped");
    expect(c.detail).toContain("internet");
  });

  test("a blackholed private route fails", () => {
    const d = healthy();
    d.network = {
      ...d.network,
      nat: {
        instance_id: "i-nat0",
        instance_state: "running",
        egress_ip: null,
        route_state: "blackhole",
      },
    };
    expect(byId(d, "nat-route").state).toBe("bad");
  });

  test("an unrecorded mode against a real stack is a failure, not a skip", () => {
    const d = healthy();
    d.network = { ...d.network, mode: null, stack_mode: "nat", consistent: false };
    const c = byId(d, "network-mode");
    expect(c.state).toBe("bad");
    expect(c.detail).toContain("back-fill");
  });

  test("neither side answering is a skip, never a pass", () => {
    const d = healthy();
    d.network = { ...d.network, mode: null, stack_mode: null, consistent: false };
    expect(byId(d, "network-mode").state).toBe("skip");
  });

  test("agents left on the old subnets fail and are named", () => {
    const d = healthy();
    d.network = { ...d.network, drifted: ["atlas", "borg"] };
    const c = byId(d, "network-placement");
    expect(c.state).toBe("bad");
    expect(c.items).toEqual(["atlas", "borg"]);
    expect(c.detail).toContain("agent recreate");
  });
});

describe("the account and fleet checks", () => {
  test("a mismatched account fails and names both accounts", () => {
    const d = healthy();
    d.account = { frozen: "111111111111", observed: "222222222222", ok: false };
    const c = byId(d, "account");
    expect(c.state).toBe("bad");
    expect(c.detail).toContain("111111111111");
    expect(c.detail).toContain("222222222222");
  });

  test("a disagreeing fleet id lists all three copies", () => {
    const d = healthy();
    d.fleet = { local: "f-abc", stack_tag: "f-xyz", fleet_item: null, ok: false };
    const c = byId(d, "fleet");
    expect(c.state).toBe("bad");
    expect(c.items).toEqual(["local config: f-abc", "stack tag: f-xyz", "_fleet item: —"]);
  });

  test("a missing stack fails", () => {
    const d = healthy();
    d.foundation = { ...d.foundation, present: false, status: null };
    expect(byId(d, "foundation-stack").state).toBe("bad");
  });

  test("an available foundation update is a `warn`, never a `bad`", () => {
    const d = healthy();
    d.foundation = { ...d.foundation, outdated: true, version: 1, available_version: 2 };
    const c = byId(d, "foundation-version");
    expect(c.state).toBe("warn");
    expect(c.detail).toContain("v1 → v2");
  });

  test("inbound rules on the agent security group fail", () => {
    const d = healthy();
    d.security_group = { inbound_rules: 2, ok: false };
    const c = byId(d, "security-group");
    expect(c.state).toBe("bad");
    expect(c.detail).toContain("2 inbound rules");
  });

  test("unparseable rows fail and are listed", () => {
    const d = healthy();
    d.unparseable_rows = ["atlas", "corvid"];
    const c = byId(d, "agent-rows");
    expect(c.state).toBe("bad");
    expect(c.items).toEqual(["atlas", "corvid"]);
  });
});

describe("the agent checks", () => {
  test("every agent is listed with its status and heartbeat age", () => {
    const d = healthy();
    d.heartbeats = [
      { name: "atlas", status: "ready", age_ms: 20_000, unreachable: false },
      { name: "ember", status: "ready", age_ms: 900_000, unreachable: true },
    ];
    const c = byId(d, "heartbeats");
    expect(c.state).toBe("bad");
    expect(c.detail).toContain("1 of 2 agents");
    expect(c.items).toEqual(["atlas · ready · just now", "ember · ready · 15m ago · unreachable"]);
  });

  test("an agent that never heartbeated says never", () => {
    const d = healthy();
    d.heartbeats = [{ name: "atlas", status: "creating", age_ms: null, unreachable: false }];
    expect(byId(d, "heartbeats").items).toEqual(["atlas · creating · never"]);
  });

  test("an empty fleet is informational, not a pass or a failure", () => {
    const d = healthy();
    d.heartbeats = [];
    expect(byId(d, "heartbeats").state).toBe("info");
  });

  test("instance drift fails and carries core's own sentences", () => {
    const d = healthy();
    d.instance_drift = [
      { kind: "orphan_instance", agent: "ghost", detail: "live EC2 instance i-1 has no row" },
    ];
    const c = byId(d, "instance-drift");
    expect(c.state).toBe("bad");
    expect(c.items).toEqual(["live EC2 instance i-1 has no row"]);
  });
});

describe("the tailnet checks", () => {
  test("an unreadable device list is informational, and the peer check is skipped", () => {
    const d = healthy();
    d.tailscale = { ...d.tailscale, available: false, detail: "lacks devices:core" };
    expect(byId(d, "device-list").state).toBe("info");
    expect(byId(d, "device-list").items).toEqual(["lacks devices:core"]);
    // Not `ok`: nothing was compared, and a pass here would read as a clean bill.
    expect(byId(d, "device-peers").state).toBe("skip");
  });

  test("ready agents with no device fail and are named", () => {
    const d = healthy();
    d.tailscale = { ...d.tailscale, missing: ["ember"] };
    const c = byId(d, "device-peers");
    expect(c.state).toBe("bad");
    expect(c.items).toEqual(["ember"]);
  });

  test("stale devices are informational — no hermetic command deletes one", () => {
    const d = healthy();
    d.tailscale = { ...d.tailscale, stale: [{ agent: "atlas", note: "atlas: delete atlas" }] };
    const c = byId(d, "stale-devices");
    expect(c.state).toBe("info");
    expect(c.items).toEqual(["atlas: delete atlas"]);
  });

  test("a policy that could not be read is not shown as a clean bill", () => {
    const d = healthy();
    d.tailscale = { ...d.tailscale, policy: null };
    expect(byId(d, "policy").state).toBe("info");
  });

  test("no policy_file scope is `skip`, not a failure", () => {
    const d = healthy();
    d.tailscale = {
      ...d.tailscale,
      policy: { scope: "none", managed: "unmanaged", blocks_drifted: [] },
    };
    expect(byId(d, "policy").state).toBe("skip");
  });

  test("drifted managed blocks are a `warn` and are listed", () => {
    const d = healthy();
    d.tailscale = {
      ...d.tailscale,
      policy: { scope: "write", managed: "managed", blocks_drifted: ["ssh", "acls"] },
    };
    const c = byId(d, "policy");
    expect(c.state).toBe("warn");
    expect(c.items).toEqual(["ssh", "acls"]);
  });
});

describe("the local machine checks", () => {
  test("a wedged daemon fails, and HTTPS is unchecked rather than off", () => {
    const d = healthy();
    d.local_tailscale = {
      ok: false,
      tailnet: null,
      https_certificates: false,
      detail: "`tailscale status --json` did not answer",
    };
    expect(byId(d, "local-tailscale").state).toBe("bad");
    expect(byId(d, "https-certificates").state).toBe("skip");
  });

  test("a tailnet that answered with HTTPS off is a real failure", () => {
    const d = healthy();
    d.local_tailscale = {
      ok: false,
      tailnet: "hermetic.ts.net",
      https_certificates: false,
      detail: "HTTPS Certificates is off",
    };
    expect(byId(d, "https-certificates").state).toBe("bad");
  });

  test("exported credential env vars are a `warn` naming them", () => {
    const d = healthy();
    d.env_overrides = ["AWS_PROFILE", "AWS_ACCESS_KEY_ID"];
    const c = byId(d, "env-overrides");
    expect(c.state).toBe("warn");
    expect(c.detail).toContain("AWS_PROFILE");
  });
});

describe("the tally", () => {
  test("counts every check by state", () => {
    const tally = checkTally(doctorChecks(healthy()));
    expect(tally.bad).toBe(0);
    expect(tally.ok).toBe(flat(healthy()).length);
  });

  test("a healthy fleet says only how many passed", () => {
    expect(tallyLine(checkTally(doctorChecks(healthy())))).toMatch(/^\d+ passed$/);
  });

  test("failures, offers and unchecked checks each get their own clause", () => {
    const d = healthy();
    d.account.ok = false;
    d.foundation = { ...d.foundation, outdated: true };
    d.tailscale = { ...d.tailscale, available: false, stale: [{ agent: "a", note: "n" }] };
    const line = tallyLine(checkTally(doctorChecks(d)));
    expect(line).toContain("failed");
    expect(line).toContain("to look at");
    expect(line).toContain("informational");
    expect(line).toContain("unchecked");
  });
});
