import { describe, expect, test } from "bun:test";
import type { MobilePushDevice } from "@hermetic/core/schema";
import {
  PUSH_DEVICES_MAX,
  PUSH_DEVICES_PATH,
  listensTo,
  pushDeviceStore,
} from "../src/push/devices.ts";
import { FakeHost } from "./fake-host.ts";

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
    await store.upsert(device("phone-a"));
    const file = host.files.get(PUSH_DEVICES_PATH);
    expect(file?.mode).toBe("0600");
    expect(JSON.parse(file?.content ?? "{}")).toEqual({ devices: [device("phone-a")] });
  });

  test("upsert replaces by device_id and moves it to the newest end", async () => {
    const store = pushDeviceStore(new FakeHost());
    await store.upsert(device("a"));
    await store.upsert(device("b"));
    await store.upsert(device("a", { listening: ["granite"] }));
    expect((await store.list()).map((d) => [d.device_id, d.listening])).toEqual([
      ["b", "all"],
      ["a", ["granite"]],
    ]);
  });

  test("past the cap the least-recently registered phone is evicted", async () => {
    const store = pushDeviceStore(new FakeHost());
    for (let i = 0; i < PUSH_DEVICES_MAX; i++) await store.upsert(device(`d${i}`));
    const { evicted } = await store.upsert(device("newest"));
    expect(evicted).toBe("d0");
    const list = await store.list();
    expect(list).toHaveLength(PUSH_DEVICES_MAX);
    expect(list.at(-1)?.device_id).toBe("newest");
  });

  test("upsert refuses an unvalidated shape", async () => {
    const store = pushDeviceStore(new FakeHost());
    await expect(store.upsert(device("x", { token: "not-a-token" }))).rejects.toThrow();
    expect(await store.list()).toEqual([]);
  });

  test("remove by id, and by id+token only while the token still matches", async () => {
    const store = pushDeviceStore(new FakeHost());
    await store.upsert(device("a"));
    await store.upsert(device("b"));
    expect(await store.remove("a", "ExponentPushToken[FIXTURE-old]")).toBe(false);
    expect(await store.remove("a", "ExponentPushToken[FIXTURE-a]")).toBe(true);
    expect(await store.remove("b")).toBe(true);
    expect(await store.remove("b")).toBe(false);
    expect(await store.list()).toEqual([]);
  });

  test("a restart reads the file back; a corrupt file or entry is dropped, not fatal", async () => {
    const host = new FakeHost();
    await pushDeviceStore(host).upsert(device("kept"));
    expect((await pushDeviceStore(host).list()).map((d) => d.device_id)).toEqual(["kept"]);

    const logs: string[] = [];
    await host.writeFile(
      PUSH_DEVICES_PATH,
      JSON.stringify({ devices: [device("ok"), { device_id: "bad" }] }),
      "0600",
    );
    expect(
      (await pushDeviceStore(host, (m) => void logs.push(m)).list()).map((d) => d.device_id),
    ).toEqual(["ok"]);
    expect(logs.join("\n")).toContain("dropped 1 entry");

    await host.writeFile(PUSH_DEVICES_PATH, "{not json", "0600");
    expect(await pushDeviceStore(host, () => {}).list()).toEqual([]);
  });

  test("listensTo: all, or the named bots", () => {
    expect(listensTo(device("a"), "granite")).toBe(true);
    expect(listensTo(device("a", { listening: ["granite"] }), "granite")).toBe(true);
    expect(listensTo(device("a", { listening: ["granite"] }), "basalt")).toBe(false);
  });
});
