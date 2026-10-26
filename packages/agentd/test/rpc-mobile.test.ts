import { describe, expect, test } from "bun:test";
import { MobileFleetView, decodeRpcFrame } from "@hermetic/core/schema";
import type { MobilePushDevice } from "@hermetic/core/schema";
import { FLEET_KEY, RPC_PATHS, pushDevicePath } from "@hermetic/core/shared";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import {
  PUSH_DEVICES_MAX,
  PUSH_DEVICES_PATH,
  deviceTag,
  pushDeviceStore,
} from "../src/push/devices.ts";
import { makeAws } from "../src/aws.ts";
import {
  FLEET_VIEW_CACHE_MS,
  PUSH_BODY_DEADLINE_MS,
  PUSH_BODY_MAX_BYTES,
  PUSH_WRITES_PER_MINUTE,
  accountOfArn,
  makeMobileRoutes,
} from "../src/rpc-mobile.ts";
import { TAGGED_DEVICES_LOGIN, auditPath, peerOwner } from "../src/rpc.ts";
import { FakeHost } from "./fake-host.ts";
import { RecordingSink, TEST_AGENTS_TABLE, TEST_EVENTS_TABLE, makeFleetManifest } from "./fixtures.ts";
import {
  MEMBER,
  OTHER_MEMBER,
  OTHER_MEMBER_IP,
  STRANGER_IP,
  agentRow,
  fleetRow,
  mobileRig,
} from "./mobile-fixtures.ts";

const TOKEN = "ExponentPushToken[FIXTURE-rpc-mobile]";

function device(over: Partial<MobilePushDevice> = {}): MobilePushDevice {
  return {
    device_id: "phone-1",
    token: TOKEN,
    platform: "ios",
    app_version: "1.0.0",
    listening: "all",
    previews: false,
    ...over,
  };
}

async function errorOf(response: Response): Promise<{ code: string; message: string }> {
  const frame = decodeRpcFrame((await response.text()).trim());
  if (frame.type !== "error") throw new Error(`expected an error frame, got ${frame.type}`);
  return { code: frame.code, message: frame.message };
}

function accessDenied(): Error {
  const e = new Error("User is not authorized to perform: dynamodb:Scan");
  e.name = "AccessDeniedException";
  return e;
}

describe("the whois gate covers the phone routes", () => {
  for (const [method, path, body] of [
    ["GET", RPC_PATHS.fleet, null],
    ["POST", RPC_PATHS.pushDevices, JSON.stringify(device())],
    ["DELETE", pushDevicePath("phone-1"), null],
  ] as const) {
    test(`${method} ${path}: a stranger and a tagged node are refused, nothing is read or written`, async () => {
      const rig = mobileRig();
      const stranger = await rig.call(method, path, body, STRANGER_IP);
      expect(stranger.status).toBe(403);
      expect((await errorOf(stranger)).code).toBe("FORBIDDEN");

      const tagged = mobileRig({
        peer: { login: TAGGED_DEVICES_LOGIN, node: "bravo.tailnet.ts.net", tags: ["tag:hermetic"] },
      });
      expect((await tagged.call(method, path, body)).status).toBe(403);
      expect(rig.ddb.calls).toHaveLength(0);
      expect(tagged.ddb.calls).toHaveLength(0);
      expect(rig.host.files.has(PUSH_DEVICES_PATH)).toBe(false);
    });
  }
});

describe("GET /fleet", () => {
  /**
   * Every box may write every agent's row, so a name the row reports is passed
   * to the phone only when it is one hermetic gives that agent in the fleet's
   * tailnet; anything else goes out as null, and the phone derives the name.
   */
  test("passes on only the node names hermetic gives each agent", async () => {
    const rig = mobileRig({
      items: [
        fleetRow(),
        agentRow({ name: "atlas", tailscale_dns_name: "fxtr0001-atlas.tail1234.ts.net." }),
        agentRow({ name: "corvid", tailscale_dns_name: "fxtr0001-atlas.tail1234.ts.net" }),
        agentRow({ name: "ember", tailscale_dns_name: "fxtr0001-ember.attacker.ts.net" }),
        agentRow({ name: "fable", tailscale_dns_name: "main-fable.tail1234.ts.net" }),
        agentRow({ name: "gale", tailscale_dns_name: "fxtr0001-gale-2.tail1234.ts.net" }),
      ],
    });
    const view = MobileFleetView.parse(await (await rig.call("GET", RPC_PATHS.fleet)).json());
    expect(Object.fromEntries(view.agents.map((a) => [a.name, a.tailscale_dns_name]))).toEqual({
      atlas: "fxtr0001-atlas.tail1234.ts.net",
      corvid: null,
      ember: null,
      fable: "main-fable.tail1234.ts.net",
      gale: null,
    });
  });

  test("answers MobileFleetView: live agents sorted, _ and destroyed rows dropped", async () => {
    const rig = mobileRig({
      items: [
        fleetRow(),
        agentRow({ name: "zephyr", status: "stopped", tailscale_ip: null, tailscale_dns_name: null }),
        agentRow({
          name: "atlas",
          running_hermes_version: "0.16.2",
          health: { hermes: true, tailscale: true, disk: true, dashboard: true },
        }),
        agentRow({ name: "gone", status: "destroyed" }),
        { name: "_lock", whatever: true },
        { name: "broken", status: "ready" },
      ],
    });
    const response = await rig.call("GET", RPC_PATHS.fleet);
    expect(response.status).toBe(200);
    const view = MobileFleetView.parse(await response.json());
    expect(view.fleet).toEqual({
      fleet_id: "fxtr0001",
      alias: "main",
      tailnet: "tail1234.ts.net",
      region: "us-east-1",
      account_id: "123456789012",
      foundation_version: 16,
    });
    expect(view.agents.map((a) => a.name)).toEqual(["atlas", "zephyr"]);
    expect(view.agents[0]).toEqual({
      name: "atlas",
      status: "ready",
      tailscale_dns_name: "fxtr0001-atlas.tail1234.ts.net",
      tailscale_ip: "100.64.0.10",
      version: "0.16.2",
      health: { hermes: true, tailscale: true, disk: true, dashboard: true },
    });
    // No heartbeat yet: the pin stands in for the running version, no health key.
    expect(view.agents[1]?.version).toBe("0.15.0");
    expect("health" in (view.agents[1] ?? {})).toBe(false);
    expect(view.read_at).toBe(rig.host.now().toISOString());
    expect(rig.audit.join("\n")).toContain("skipped 1 agent row");
  });

  test("the Scan is consistent, and one Scan answers for ten seconds", async () => {
    const rig = mobileRig();
    await rig.call("GET", RPC_PATHS.fleet);
    await rig.call("GET", RPC_PATHS.fleet);
    const scans = rig.ddb.commandCalls(ScanCommand);
    expect(scans).toHaveLength(1);
    expect(scans[0]?.input.ConsistentRead).toBe(true);
    rig.host.advance(FLEET_VIEW_CACHE_MS);
    await rig.call("GET", RPC_PATHS.fleet);
    expect(rig.ddb.commandCalls(ScanCommand)).toHaveLength(2);
  });

  test("AccessDenied (foundation below v17) is 503 FLEET_LIST_UNAVAILABLE, cached too", async () => {
    const rig = mobileRig({ scanError: accessDenied() });
    const response = await rig.call("GET", RPC_PATHS.fleet);
    expect(response.status).toBe(503);
    const error = await errorOf(response);
    expect(error.code).toBe("FLEET_LIST_UNAVAILABLE");
    expect(error.message).toContain("foundation predates version 17");
    expect((await rig.call("GET", RPC_PATHS.fleet)).status).toBe(503);
    expect(rig.ddb.commandCalls(ScanCommand)).toHaveLength(1);
  });

  test("no _fleet row is 503 too, never a half-filled identity", async () => {
    const rig = mobileRig({ fleet: null });
    const response = await rig.call("GET", RPC_PATHS.fleet);
    expect(response.status).toBe(503);
    expect((await errorOf(response)).message).toContain(FLEET_KEY);
  });

  test("a foundation_version missing from _fleet falls back to the manifest's, then 0", async () => {
    const rig = mobileRig({ fleet: fleetRow({ foundation_version: undefined }) });
    const view = MobileFleetView.parse(await (await rig.call("GET", RPC_PATHS.fleet)).json());
    expect(view.fleet.foundation_version).toBe(0);
  });

  test("the view carries the manifest's own fleet_id, from a _fleet row that names it", async () => {
    const rig = mobileRig();
    const view = MobileFleetView.parse(await (await rig.call("GET", RPC_PATHS.fleet)).json());
    expect(view.fleet.fleet_id).toBe(makeFleetManifest().fleet_id);
    expect(fleetRow()["fleet_id"]).toBe(makeFleetManifest().fleet_id);
  });

  test("a _fleet row naming another fleet, or none, is 503: a mis-pointed manifest serves nothing", async () => {
    for (const fleet_id of ["sg7k2m4p", undefined]) {
      const rig = mobileRig({
        items: [fleetRow({ fleet_id }), agentRow()],
        fleet: fleetRow({ fleet_id }),
      });
      const response = await rig.call("GET", RPC_PATHS.fleet);
      expect(response.status).toBe(503);
      const error = await errorOf(response);
      expect(error.code).toBe("FLEET_LIST_UNAVAILABLE");
      expect(error.message).toContain(makeFleetManifest().fleet_id);
      expect(error.message).not.toContain("atlas");
    }
  });

  test("POST /fleet is 405", async () => {
    expect((await mobileRig().call("POST", RPC_PATHS.fleet, "{}")).status).toBe(405);
  });

  test("accountOfArn reads the fifth field and nothing else", () => {
    expect(accountOfArn("arn:aws:iam::123456789012:role/x")).toBe("123456789012");
    expect(accountOfArn("arn:aws:iam:::role/x")).toBeNull();
    expect(accountOfArn(undefined)).toBeNull();
  });
});

describe("scanAgents", () => {
  test("follows LastEvaluatedKey to the end, consistently", async () => {
    const ddb = new RecordingSink();
    ddb.responses.push(
      { Items: [{ name: "a" }], LastEvaluatedKey: { name: "a" } },
      { Items: [{ name: "b" }] },
    );
    const aws = makeAws({
      ddb,
      ssm: new RecordingSink(),
      s3: new RecordingSink(),
      agentsTable: TEST_AGENTS_TABLE,
      eventsTable: TEST_EVENTS_TABLE,
      now: () => new Date(),
    });
    expect(await aws.scanAgents()).toEqual([{ name: "a" }, { name: "b" }]);
    const scans = ddb.commandCalls(ScanCommand);
    expect(scans.map((s) => s.input.ExclusiveStartKey)).toEqual([undefined, { name: "a" }]);
    expect(
      scans.every((s) => s.input.ConsistentRead === true && s.input.TableName === TEST_AGENTS_TABLE),
    ).toBe(true);
  });
});

describe("POST /push/devices", () => {
  test("stores a valid registration (0600) and the audit names the device, never the token", async () => {
    const rig = mobileRig();
    const response = await rig.call("POST", RPC_PATHS.pushDevices, JSON.stringify(device()));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, device_id: "phone-1" });
    const file = rig.host.files.get(PUSH_DEVICES_PATH);
    expect(file?.mode).toBe("0600");
    expect(JSON.parse(file?.content ?? "{}")).toEqual({
      devices: [{ ...device(), owner: MEMBER.login, renewed_at: rig.host.now().toISOString() }],
    });
    const audit = rig.audit.join("\n");
    expect(audit).toContain(`push device registered: ${deviceTag("phone-1")} (ios) by ${MEMBER.login}`);
    expect(audit).not.toContain("FIXTURE-rpc-mobile");
    expect(audit).not.toContain("phone-1");
  });

  test("a body that does not arrive by the deadline is 408, and nothing is written", async () => {
    const host = new FakeHost();
    const deadline = new AbortController();
    const routes = makeMobileRoutes({
      devices: pushDeviceStore(host),
      now: () => host.now().getTime(),
      bodyDeadline: () => deadline.signal,
    });
    // A peer that opens the request, sends a little, and then stalls.
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"device_id":'));
      },
    });
    const request = new Request(`http://100.64.0.1:7434${RPC_PATHS.pushDevices}`, {
      method: "POST",
      body: stalled,
    });
    const pending = routes(request, new URL(request.url), { ip: "100.64.0.7", owner: MEMBER.login });
    deadline.abort();
    const response = await pending;
    expect(response?.status).toBe(408);
    expect((await errorOf(response as Response)).code).toBe("ABORTED");
    expect(host.files.has(PUSH_DEVICES_PATH)).toBe(false);
    expect(PUSH_BODY_DEADLINE_MS).toBe(5_000);
  });

  test("a registry full of other owners' phones is 507, and evicts nobody", async () => {
    const rig = mobileRig();
    const store = pushDeviceStore(rig.host);
    for (let i = 0; i < PUSH_DEVICES_MAX; i++) {
      await store.upsert(
        device({ device_id: `other-${i}`, token: `ExponentPushToken[FIXTURE-o${i}]` }),
        `user${i}@example.com`,
      );
    }
    const before = rig.host.files.get(PUSH_DEVICES_PATH)?.content;
    const full = await rig.call("POST", RPC_PATHS.pushDevices, JSON.stringify(device()));
    expect(full.status).toBe(507);
    expect((await errorOf(full)).code).toBe("PAYLOAD_TOO_LARGE");
    expect(rig.host.files.get(PUSH_DEVICES_PATH)?.content).toBe(before);
    const audit = rig.audit.join("\n");
    expect(audit).toContain(
      `push device ${deviceTag("phone-1")}: registration by ${MEMBER.login} refused`,
    );
    expect(audit).not.toContain("phone-1");
  });

  test("an owner's fifth phone evicts their own oldest, named by its tag", async () => {
    const rig = mobileRig();
    for (let i = 0; i < 5; i++) {
      const ok = await rig.call(
        "POST",
        RPC_PATHS.pushDevices,
        JSON.stringify(device({ device_id: `phone-${i}`, token: `ExponentPushToken[FIXTURE-p${i}]` })),
      );
      expect(ok.status).toBe(200);
    }
    const stored = JSON.parse(rig.host.files.get(PUSH_DEVICES_PATH)?.content ?? "{}");
    expect(stored.devices.map((d: { device_id: string }) => d.device_id)).toEqual([
      "phone-1",
      "phone-2",
      "phone-3",
      "phone-4",
    ]);
    expect(rig.audit.join("\n")).toContain(`evicted their ${deviceTag("phone-0")}`);
  });

  test("not JSON, or not a MobilePushDevice, is 400 VALIDATION — and the message carries no value", async () => {
    const rig = mobileRig();
    const notJson = await rig.call("POST", RPC_PATHS.pushDevices, "{nope");
    expect(notJson.status).toBe(400);
    expect((await errorOf(notJson)).code).toBe("VALIDATION");

    const badToken = await rig.call(
      "POST",
      RPC_PATHS.pushDevices,
      JSON.stringify({ ...device(), token: "FIXTURE-not-an-expo-token" }),
    );
    expect(badToken.status).toBe(400);
    const error = await errorOf(badToken);
    expect(error.message).toContain("token");
    expect(error.message).not.toContain("FIXTURE-not-an-expo-token");

    const extra = await rig.call(
      "POST",
      RPC_PATHS.pushDevices,
      JSON.stringify({ ...device(), admin: true }),
    );
    expect(extra.status).toBe(400);
    expect(rig.host.files.has(PUSH_DEVICES_PATH)).toBe(false);
  });

  test("a body over 8 KB is 413 PAYLOAD_TOO_LARGE, declared or not", async () => {
    const rig = mobileRig();
    const big = JSON.stringify({ ...device(), app_version: "x".repeat(PUSH_BODY_MAX_BYTES) });
    const declared = await rig.call("POST", RPC_PATHS.pushDevices, big);
    expect(declared.status).toBe(413);
    expect((await errorOf(declared)).code).toBe("PAYLOAD_TOO_LARGE");

    // A streamed body carries no content-length; the cap is enforced on read.
    const bytes = new TextEncoder().encode(big);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 1024) controller.enqueue(bytes.slice(i, i + 1024));
        controller.close();
      },
    });
    const streamed = await rig.call("POST", RPC_PATHS.pushDevices, stream);
    expect(streamed.status).toBe(413);
    expect(rig.host.files.has(PUSH_DEVICES_PATH)).toBe(false);
  });

  test(`more than ${PUSH_WRITES_PER_MINUTE} writes a minute from one peer is 429, and it drains`, async () => {
    const rig = mobileRig();
    for (let i = 0; i < PUSH_WRITES_PER_MINUTE; i++) {
      const ok = await rig.call(
        "POST",
        RPC_PATHS.pushDevices,
        JSON.stringify(device({ app_version: `1.0.${i}` })),
      );
      expect(ok.status).toBe(200);
    }
    const limited = await rig.call("POST", RPC_PATHS.pushDevices, JSON.stringify(device()));
    expect(limited.status).toBe(429);
    expect((await errorOf(limited)).code).toBe("RATE_LIMITED");
    // Another peer has its own budget.
    expect(
      (await rig.call("POST", RPC_PATHS.pushDevices, JSON.stringify(device()), "100.64.0.8")).status,
    ).toBe(200);
    rig.host.advance(60_000);
    expect((await rig.call("POST", RPC_PATHS.pushDevices, JSON.stringify(device()))).status).toBe(200);
  });

  test("GET /push/devices is 405: the registry is never read back over the wire", async () => {
    expect((await mobileRig().call("GET", RPC_PATHS.pushDevices)).status).toBe(405);
  });
});

describe("DELETE /push/devices/<device_id>", () => {
  test("removes the phone, idempotently", async () => {
    const rig = mobileRig();
    await rig.call("POST", RPC_PATHS.pushDevices, JSON.stringify(device()));
    const first = await rig.call("DELETE", pushDevicePath("phone-1"));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, device_id: "phone-1", removed: true });
    expect(JSON.parse(rig.host.files.get(PUSH_DEVICES_PATH)?.content ?? "{}")).toEqual({ devices: [] });
    const again = await rig.call("DELETE", pushDevicePath("phone-1"));
    expect(await again.json()).toEqual({ ok: true, device_id: "phone-1", removed: false });
    expect(rig.audit.join("\n")).toContain(`push device unregistered: ${deviceTag("phone-1")}`);
    // Not even the listener's own audit line spells the id: its path is tagged too.
    expect(rig.audit.join("\n")).not.toContain("phone-1");
    expect(rig.audit.join("\n")).toContain(`DELETE /push/devices/${deviceTag("phone-1")} from`);
  });

  test("auditPath tags a device id in the path and leaves every other path alone", () => {
    expect(auditPath(pushDevicePath("phone-1"))).toBe(`/push/devices/${deviceTag("phone-1")}`);
    expect(auditPath(RPC_PATHS.pushDevices)).toBe(RPC_PATHS.pushDevices);
    expect(auditPath(RPC_PATHS.health)).toBe(RPC_PATHS.health);
  });

  test("an id outside the device_id shape is 400", async () => {
    const response = await mobileRig().call("DELETE", pushDevicePath("../../etc/passwd"));
    expect(response.status).toBe(400);
  });
});

describe("a registration belongs to the login that made it (§9.4)", () => {
  test("the owner may renew and delete; renewal moves renewed_at", async () => {
    const rig = mobileRig();
    expect((await rig.call("POST", RPC_PATHS.pushDevices, JSON.stringify(device()))).status).toBe(200);
    rig.host.advance(60_000);
    const renewed = await rig.call(
      "POST",
      RPC_PATHS.pushDevices,
      JSON.stringify(device({ listening: ["granite"] })),
    );
    expect(renewed.status).toBe(200);
    const stored = JSON.parse(rig.host.files.get(PUSH_DEVICES_PATH)?.content ?? "{}");
    expect(stored.devices).toEqual([
      {
        ...device({ listening: ["granite"] }),
        owner: MEMBER.login,
        renewed_at: rig.host.now().toISOString(),
      },
    ]);
    expect((await rig.call("DELETE", pushDevicePath("phone-1"))).status).toBe(200);
  });

  test("another member's DELETE of a device_id only the first holds is 403 FORBIDDEN, logged by tag", async () => {
    const rig = mobileRig();
    await rig.call("POST", RPC_PATHS.pushDevices, JSON.stringify(device()));
    const before = rig.host.files.get(PUSH_DEVICES_PATH)?.content;

    const silence = await rig.call("DELETE", pushDevicePath("phone-1"), null, OTHER_MEMBER_IP);
    expect(silence.status).toBe(403);
    const error = await errorOf(silence);
    expect(error.code).toBe("FORBIDDEN");
    // The caller is not told whose phone it is.
    expect(error.message).not.toContain(MEMBER.login);
    expect(rig.host.files.get(PUSH_DEVICES_PATH)?.content).toBe(before);

    const tag = deviceTag("phone-1");
    expect(rig.audit.filter((line) => line.startsWith(`push device ${tag}:`))).toEqual([
      `push device ${tag}: delete by ${OTHER_MEMBER.login} refused; registered to ${MEMBER.login}`,
    ]);
    const audit = rig.audit.join("\n");
    expect(audit).not.toContain("phone-1");
    expect(audit).not.toContain("FIXTURE-rpc-mobile");
  });

  test("another member posting the same device_id first cannot lock the owner out, or redirect them", async () => {
    const rig = mobileRig();
    // The squatter gets there first, with the victim's id and their own token.
    const squat = await rig.call(
      "POST",
      RPC_PATHS.pushDevices,
      JSON.stringify(device({ token: "ExponentPushToken[FIXTURE-hijack]" })),
      OTHER_MEMBER_IP,
    );
    expect(squat.status).toBe(200);
    // The real phone still registers.
    expect((await rig.call("POST", RPC_PATHS.pushDevices, JSON.stringify(device()))).status).toBe(200);
    const stored = JSON.parse(rig.host.files.get(PUSH_DEVICES_PATH)?.content ?? "{}");
    expect(stored.devices.map((d: { owner: string; token: string }) => [d.owner, d.token])).toEqual([
      [OTHER_MEMBER.login, "ExponentPushToken[FIXTURE-hijack]"],
      [MEMBER.login, TOKEN],
    ]);
    // Each delete touches only the caller's own record.
    expect((await rig.call("DELETE", pushDevicePath("phone-1"), null, OTHER_MEMBER_IP)).status).toBe(
      200,
    );
    const after = JSON.parse(rig.host.files.get(PUSH_DEVICES_PATH)?.content ?? "{}");
    expect(after.devices.map((d: { owner: string }) => d.owner)).toEqual([MEMBER.login]);
    const audit = rig.audit.join("\n");
    expect(audit).not.toContain("FIXTURE-rpc-mobile");
    expect(audit).not.toContain("FIXTURE-hijack");
  });

  test("another member registering their own device_id is fine", async () => {
    const rig = mobileRig();
    await rig.call("POST", RPC_PATHS.pushDevices, JSON.stringify(device()));
    const own = await rig.call(
      "POST",
      RPC_PATHS.pushDevices,
      JSON.stringify(device({ device_id: "phone-2", token: "ExponentPushToken[FIXTURE-two]" })),
      OTHER_MEMBER_IP,
    );
    expect(own.status).toBe(200);
    const stored = JSON.parse(rig.host.files.get(PUSH_DEVICES_PATH)?.content ?? "{}");
    expect(
      stored.devices.map((d: { device_id: string; owner: string }) => [d.device_id, d.owner]),
    ).toEqual([
      ["phone-1", MEMBER.login],
      ["phone-2", OTHER_MEMBER.login],
    ]);
  });

  test("peerOwner: a person is their login, a tagged node its node name", () => {
    expect(peerOwner(MEMBER)).toBe(MEMBER.login);
    expect(
      peerOwner({ login: TAGGED_DEVICES_LOGIN, node: "bravo.tailnet.ts.net", tags: ["tag:ci"] }),
    ).toBe("node:bravo.tailnet.ts.net");
  });
});
