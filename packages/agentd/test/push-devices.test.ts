import { describe, expect, test } from "bun:test";
import type { MobilePushDevice } from "@hermetic/core/schema";
import {
  PUSH_DEVICES_MAX,
  PUSH_DEVICES_PATH,
  PUSH_DEVICE_TTL_MS,
  listensTo,
  pushDeviceStore,
} from "../src/push/devices.ts";
import { FakeHost } from "./fake-host.ts";

const OWNER = "evan@example.com";
const OTHER = "mallory@example.com";
const DAY_MS = 86_400_000;

function device(id: string, over: Partial<MobilePushDevice> = {}): MobilePushDevice {
  return {
    device_id: id,
    token: `ExponentPushToken[FIXTURE-${id}]`,
    platform: "ios",
    app_version: "1.0.0",
    listening: "all",
    ...over,
  };
}

describe("push device store", () => {
  test("upsert writes the list to /var/lib/hermeticd/push-devices.json with mode 0600", async () => {
    const host = new FakeHost();
    const store = pushDeviceStore(host);
    await store.upsert(device("phone-a"), OWNER);
    const file = host.files.get(PUSH_DEVICES_PATH);
    expect(file?.mode).toBe("0600");
    expect(JSON.parse(file?.content ?? "{}")).toEqual({
      devices: [{ ...device("phone-a"), owner: OWNER, renewed_at: host.now().toISOString() }],
    });
  });

  test("upsert replaces by device_id and moves it to the newest end", async () => {
    const store = pushDeviceStore(new FakeHost());
    await store.upsert(device("a"), OWNER);
    await store.upsert(device("b"), OWNER);
    await store.upsert(device("a", { listening: ["granite"] }), OWNER);
    expect((await store.list()).map((d) => [d.device_id, d.listening])).toEqual([
      ["b", "all"],
      ["a", ["granite"]],
    ]);
  });

  test("past the cap the least-recently registered phone is evicted", async () => {
    const store = pushDeviceStore(new FakeHost());
    for (let i = 0; i < PUSH_DEVICES_MAX; i++) await store.upsert(device(`d${i}`), OWNER);
    expect(await store.upsert(device("newest"), OWNER)).toEqual({ ok: true, evicted: "d0" });
    const list = await store.list();
    expect(list).toHaveLength(PUSH_DEVICES_MAX);
    expect(list.at(-1)?.device_id).toBe("newest");
  });

  test("upsert refuses an unvalidated shape", async () => {
    const store = pushDeviceStore(new FakeHost());
    await expect(store.upsert(device("x", { token: "not-a-token" }), OWNER)).rejects.toThrow();
    expect(await store.list()).toEqual([]);
  });

  test("remove by id, and by id+token only while the token still matches", async () => {
    const store = pushDeviceStore(new FakeHost());
    await store.upsert(device("a"), OWNER);
    await store.upsert(device("b"), OWNER);
    expect(await store.remove("a", "ExponentPushToken[FIXTURE-old]")).toBe(false);
    expect(await store.remove("a", "ExponentPushToken[FIXTURE-a]")).toBe(true);
    expect(await store.remove("b")).toBe(true);
    expect(await store.remove("b")).toBe(false);
    expect(await store.list()).toEqual([]);
  });

  test("a restart reads the file back; a corrupt file or entry is dropped, not fatal", async () => {
    const host = new FakeHost();
    await pushDeviceStore(host).upsert(device("kept"), OWNER);
    expect((await pushDeviceStore(host).list()).map((d) => d.device_id)).toEqual(["kept"]);

    const logs: string[] = [];
    await host.writeFile(
      PUSH_DEVICES_PATH,
      JSON.stringify({
        devices: [
          { ...device("ok"), owner: OWNER, renewed_at: host.now().toISOString() },
          { device_id: "bad" },
          // No owner: a registration nobody owns could be taken over by anyone.
          device("unowned"),
        ],
      }),
      "0600",
    );
    expect(
      (await pushDeviceStore(host, (m) => void logs.push(m)).list()).map((d) => d.device_id),
    ).toEqual(["ok"]);
    expect(logs.join("\n")).toContain("dropped 2 entries");

    await host.writeFile(PUSH_DEVICES_PATH, "{not json", "0600");
    expect(await pushDeviceStore(host, () => {}).list()).toEqual([]);
  });

  test("another login may neither replace nor unregister a phone; its owner may", async () => {
    const host = new FakeHost();
    const store = pushDeviceStore(host);
    await store.upsert(device("a"), OWNER);
    const before = host.files.get(PUSH_DEVICES_PATH)?.content;
    expect(await store.upsert(device("a", { token: "ExponentPushToken[FIXTURE-x]" }), OTHER)).toEqual({
      ok: false,
      owner: OWNER,
    });
    expect(await store.unregister("a", OTHER)).toEqual({ ok: false, owner: OWNER });
    expect(host.files.get(PUSH_DEVICES_PATH)?.content).toBe(before);
    expect(await store.unregister("a", OWNER)).toEqual({ ok: true, removed: true });
    expect(await store.unregister("a", OWNER)).toEqual({ ok: true, removed: false });
  });

  test("a registration lapses 30 days after its last renewal: unlisted, then pruned", async () => {
    expect(PUSH_DEVICE_TTL_MS).toBe(30 * DAY_MS);
    const host = new FakeHost();
    const logs: string[] = [];
    const store = pushDeviceStore(host, (m) => void logs.push(m));
    await store.upsert(device("stale"), OWNER);
    await store.upsert(device("fresh"), OWNER);
    host.advance(10 * DAY_MS);
    await store.upsert(device("fresh"), OWNER);

    host.advance(PUSH_DEVICE_TTL_MS - 10 * DAY_MS - 1);
    expect((await store.list()).map((d) => d.device_id)).toEqual(["stale", "fresh"]);
    host.advance(1);
    expect((await store.list()).map((d) => d.device_id)).toEqual(["fresh"]);
    expect(logs.join("\n")).toContain("1 registration lapsed");

    // The next write drops it from the file too.
    expect(host.files.get(PUSH_DEVICES_PATH)?.content).toContain("stale");
    await store.upsert(device("other"), OWNER);
    const file = JSON.parse(host.files.get(PUSH_DEVICES_PATH)?.content ?? "{}");
    expect(file.devices.map((d: { device_id: string }) => d.device_id)).toEqual(["fresh", "other"]);
  });

  test("a lapsed entry in the file is skipped on load, and its id is free to register", async () => {
    const host = new FakeHost();
    await pushDeviceStore(host).upsert(device("a"), OWNER);
    host.advance(PUSH_DEVICE_TTL_MS);
    const restarted = pushDeviceStore(host);
    expect(await restarted.list()).toEqual([]);
    expect(await restarted.upsert(device("a"), OTHER)).toEqual({ ok: true, evicted: null });
    expect((await restarted.list()).map((d) => d.owner)).toEqual([OTHER]);
  });

  test("listensTo: all, or the named bots", () => {
    expect(listensTo(device("a"), "granite")).toBe(true);
    expect(listensTo(device("a", { listening: ["granite"] }), "granite")).toBe(true);
    expect(listensTo(device("a", { listening: ["granite"] }), "basalt")).toBe(false);
  });
});
