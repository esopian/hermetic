/**
 * The documents hermeticd serves a paired phone, and the one it sends it (§9.4).
 *
 * At the root because it reads both sides of each seam: agentd's routes and
 * watcher (`packages/agentd/src`) on one side, core's `schema/mobile.ts` — the
 * shapes the phone validates against — on the other. This is the box half:
 *
 *  - `GET /fleet`, built from the agent rows core's own fixture fleet holds,
 *    parses with `MobileFleetView`;
 *  - a `MobilePushDevice` body round-trips through `POST /push/devices` into
 *    the file the watcher reads, unchanged, beside the `owner` and
 *    `renewed_at` the box adds (`MobilePushDeviceRecord`);
 *  - the `data` of every push the watcher sends parses with `MobilePushData`,
 *    and its `dedupe` is the documented `<instance>:<session>:<count>:<kind>`.
 *
 * The phone half — the phone's own client reading the same documents — is
 * added beside it with the phone's fleet and push code.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHermetic } from "@hermetic/core";
import {
  MobileFleetView,
  MobilePushData,
  type MobilePushDevice,
  MobilePushDeviceList,
} from "@hermetic/core/schema";
import type { HermesChatClient } from "@hermetic/core/chat-client";
import { RPC_PATHS } from "@hermetic/core/shared";
import type { ExpoPushMessage } from "@hermetic/core/shared";
import { PUSH_DEVICES_PATH, pushDeviceStore } from "../packages/agentd/src/push/devices.ts";
import { createWatcher } from "../packages/agentd/src/push/watch.ts";
import { redactValue } from "../packages/agentd/src/redact.ts";
import { FakeHost } from "../packages/agentd/test/fake-host.ts";
import { MEMBER, agentRow, fleetRow, mobileRig } from "../packages/agentd/test/mobile-fixtures.ts";

const DEVICE: MobilePushDevice = {
  device_id: "seam-phone",
  token: "ExponentPushToken[FIXTURE-seam]",
  platform: "android",
  app_version: "2.3.4",
  listening: ["granite", "atlas"],
};

/** The fixture fleet's agent rows, as core's `agents.list` answers them. */
async function fixtureRows(): Promise<Record<string, unknown>[]> {
  const h = await openHermetic({
    fixture: true,
    home: mkdtempSync(join(tmpdir(), "hermetic-box-seam-")),
  });
  const listed = (await h.agents.list({})) as unknown;
  const rows = Array.isArray(listed) ? listed : ((listed as { agents?: unknown[] }).agents ?? []);
  return rows as Record<string, unknown>[];
}

describe("GET /fleet → MobileFleetView", () => {
  test("the core fixture fleet's rows come back as a view the phone's schema accepts", async () => {
    const rows = await fixtureRows();
    expect(rows.length).toBeGreaterThan(3);
    const rig = mobileRig({ items: [fleetRow(), ...rows] });
    const response = await rig.call("GET", RPC_PATHS.fleet);
    expect(response.status).toBe(200);
    const view = MobileFleetView.parse(await response.json());
    const live = rows.filter((r) => r["status"] !== "destroyed").map((r) => String(r["name"]));
    expect(view.agents.map((a) => a.name)).toEqual([...live].sort((a, b) => a.localeCompare(b, "en")));
    expect(rig.audit.join("\n")).not.toContain("skipped");
  });

  test("the hand-built row the agentd tests use is a row core's schema accepts too", async () => {
    const rig = mobileRig({ items: [fleetRow(), agentRow()] });
    const view = MobileFleetView.parse(await (await rig.call("GET", RPC_PATHS.fleet)).json());
    expect(view.agents.map((a) => a.name)).toEqual(["atlas"]);
  });
});

describe("POST /push/devices → push-devices.json", () => {
  test("the body round-trips into the file unchanged, as a MobilePushDeviceList, owned by the caller", async () => {
    const rig = mobileRig();
    const response = await rig.call("POST", RPC_PATHS.pushDevices, JSON.stringify(DEVICE));
    expect(response.status).toBe(200);
    const file = MobilePushDeviceList.parse(
      JSON.parse(rig.host.files.get(PUSH_DEVICES_PATH)?.content ?? "{}"),
    );
    expect(file.devices).toEqual([
      { ...DEVICE, owner: MEMBER.login, renewed_at: rig.host.now().toISOString() },
    ]);
  });
});

describe("the watcher's push → MobilePushData", () => {
  test("every kind's data parses, with the documented dedupe", async () => {
    const host = new FakeHost();
    const devices = pushDeviceStore(host);
    await devices.upsert({ ...DEVICE, listening: "all" }, MEMBER.login);
    const sent: ExpoPushMessage[] = [];
    const snapshots: unknown[] = [
      { sessions: [{ id: "l1", session_key: "s-turn", status: "working", message_count: 1 }] },
      {
        sessions: [
          { id: "l1", session_key: "s-turn", status: "idle", message_count: 2 },
          { id: "l2", session_key: "s-wait", status: "waiting", message_count: 4 },
          { id: "l3", session_key: "s-cron", status: "idle", message_count: 2, preview: "digest" },
        ],
      },
    ];
    const chat = {
      botModeRpc: async () => snapshots.shift() ?? { sessions: [] },
      swarm: async () => ({
        instance: "atlas",
        reachable: true,
        bots: [
          {
            instance: "atlas",
            name: "granite",
            title: "Granite",
            is_default: false,
            avatar_seed: "x",
            unread: 0,
            needs_action: false,
            muted: false,
            warm: false,
          },
        ],
        rooms: [],
        warm_slots: { used: 0, total: null },
        sections: [],
      }),
      sessions: async () =>
        ["s-turn", "s-wait", "s-cron"].map((id) => ({
          id,
          instance: "atlas",
          bot: "granite",
          kind: "canonical",
          origin: "portal",
          title: id,
          unread: 0,
          turn_count: 1,
        })),
      history: async () => [
        {
          id: "m1",
          session: "s-turn",
          role: "bot",
          at: "2026-09-01T12:00:00.000Z",
          blocks: [{ kind: "text", markdown: "done" }],
        },
      ],
      token: async () => "unused",
      send: () => {
        throw new Error("unused");
      },
      abort: async () => false,
    } as unknown as HermesChatClient;
    let clock = 0;
    const watcher = createWatcher({
      chat,
      devices,
      send: async (messages) => {
        sent.push(...messages);
        return messages.map(() => ({ status: "ok" as const }));
      },
      fetchReceipts: async () => new Map(),
      now: () => clock,
      sleep: async () => {},
      log: () => {},
      instance: "atlas",
      fleet_id: "fxtr0001",
      redact: redactValue,
    });
    await watcher.tick();
    clock += 3_000;
    await watcher.tick();
    const data = sent.map((m) => MobilePushData.parse(m.data));
    expect(data.map((d) => [d.kind, d.dedupe])).toEqual([
      ["turn.done", "atlas:s-turn:2:turn.done"],
      ["needs_action", "atlas:s-wait:4:needs_action"],
      ["message", "atlas:s-cron:2:message"],
    ]);
    // The dedupe is built from the payload's own fields, which is what lets the
    // phone recompute it from a socket event and drop the duplicate.
    for (const d of data) {
      expect(d.dedupe.startsWith(`${d.instance}:${d.session}:`)).toBe(true);
      expect(d.dedupe.endsWith(`:${d.kind}`)).toBe(true);
      expect(d.fleet_id).toBe("fxtr0001");
    }
  });
});
