/**
 * The sweeper's TTLs, the index's load, and the plugin socket's setup.
 */
import { describe, expect, test } from "bun:test";
import {
  FILES_DROP_DIR,
  FILES_INDEX_PATH,
  FILES_OUTBOX_DIR,
  FILES_SECRET_DIR,
  FILES_SOCKET_PATH,
  FILES_STAGE_DIR,
  FILES_TTL,
} from "@hermetic/core/shared";
import { STATE_DIR } from "../src/fleet.ts";
import { serveFilesSocket } from "../src/files/socket.ts";
import { loadFilesIndex } from "../src/files/store.ts";
import { diskSweepCommands } from "../src/files/sweeper.ts";
import { FakeHost, expectRan } from "./fake-host.ts";
import { PNG, TEXT, filesBox, openSlot, post, put } from "./files-fixture.ts";

const HOUR = 3600 * 1000;

describe("the sweeper", () => {
  test("each root's TTL: stage at 1 h, drop at 1 h, inbox at the retention; durable secrets never", async () => {
    const removed: string[] = [];
    const box = await filesBox({ removeSecret: async (name) => void removed.push(name) });
    const { fetch, socket, host, service, index } = box;
    host.seed(`${FILES_SECRET_DIR}/github-app.pem`, "FIXTURE", "0600");

    const staged = (await (await fetch("/files/stage/a.txt", put(TEXT))).json()) as { id: string };
    const toInbox = (await (await fetch("/files/stage/b.png", put(PNG))).json()) as { id: string };
    const { path: inboxPath } = (await (
      await fetch(`/files/${toInbox.id}/commit`, post({}))
    ).json()) as { path: string };
    const secret = await openSlot(socket, { sensitivity: "secret" });
    const { path: dropPath } = (await (
      await fetch(`/files/requests/${secret.request_id}`, put(TEXT))
    ).json()) as {
      path: string;
    };
    const stagePath = `${FILES_STAGE_DIR}/${staged.id}/a.txt`;

    host.advance(HOUR - 1000);
    await service.sweep();
    expect(host.files.has(stagePath)).toBe(true);
    expect(host.files.has(dropPath)).toBe(true);

    host.advance(2000);
    await service.sweep();
    expect(host.files.has(stagePath)).toBe(false);
    expect(host.files.has(dropPath)).toBe(false);
    expect(host.files.has(inboxPath)).toBe(true);

    host.advance(FILES_TTL.inbox * 1000);
    const report = await service.sweep();
    expect(report.removed).toBe(1);
    expect(host.files.has(inboxPath)).toBe(false);
    expect(index().entries).toEqual([]);

    // Durable secrets: not read, not removed, not named in any command.
    expect(host.files.has(`${FILES_SECRET_DIR}/github-app.pem`)).toBe(true);
    expect(removed).toEqual([]);
    expect(host.commands.some((c) => c.includes(FILES_SECRET_DIR))).toBe(false);
    expect(host.fsOps.some((op) => op.includes(FILES_SECRET_DIR))).toBe(false);
  });

  test("an outbox entry goes after 24 h, and a durable secret entry is kept however old", async () => {
    const { host, service, index } = await filesBox();
    const at = host.now().toISOString();
    const outboxEntry = {
      id: "sh_aaaaaaaaaaaa",
      dir: "outbox" as const,
      class: "file" as const,
      name: "out.txt",
      bytes: 4,
      mime: "text/plain",
      sha256: "0".repeat(64),
      created_at: at,
      expires_at: new Date(host.now().getTime() + FILES_TTL.outbox * 1000).toISOString(),
      path: `${FILES_OUTBOX_DIR}/sh_aaaaaaaaaaaa/out.txt`,
      from: { kind: "agent" as const },
    };
    const secretEntry = {
      ...outboxEntry,
      id: "f_bbbbbbbbbbbb",
      dir: "secret" as const,
      class: "secret" as const,
      name: "key.pem",
      expires_at: null,
      path: `${FILES_SECRET_DIR}/key.pem`,
      slot: "file-key-pem",
    };
    host.seed(outboxEntry.path, "out!");
    await service.ctx.store.mutate((i) => {
      i.entries.push(outboxEntry, secretEntry);
    });
    host.advance(FILES_TTL.outbox * 1000 + 1000);
    await service.sweep();
    expectRan(host, new RegExp(`^runuser -u hermes -- rm -rf -- ${FILES_OUTBOX_DIR}/sh_aaaaaaaaaaaa$`));
    expect(host.files.has(outboxEntry.path)).toBe(false);
    expect(index().entries.map((e) => e.id)).toEqual(["f_bbbbbbbbbbbb"]);
  });

  test("an open request past its expiry becomes expired and wakes its waiter", async () => {
    let wake: () => void = () => {};
    const { socket, host, service } = await filesBox({
      delay: (_ms, signal) =>
        new Promise((resolve) => {
          wake = resolve;
          signal.addEventListener("abort", () => resolve());
        }),
    });
    const slot = await openSlot(socket);
    const waiting = socket(`/requests/${slot.request_id}/wait?s=60`);
    await Bun.sleep(5);
    host.advance(FILES_TTL.request * 1000 + 1000);
    const report = await service.sweep();
    expect(report.expired).toBe(1);
    expect(((await (await waiting).json()) as { status: string }).status).toBe("expired");
    wake();
  });

  test("an entry whose file is gone is forgotten", async () => {
    const { fetch, host, service, index } = await filesBox();
    const { id } = (await (await fetch("/files/stage/a.txt", put(TEXT))).json()) as { id: string };
    host.files.delete(`${FILES_STAGE_DIR}/${id}/a.txt`);
    const report = await service.sweep();
    expect(report.forgotten).toBe(1);
    expect(index().entries).toEqual([]);
  });

  test("the disk pass runs as hermes under /data and as root only in the drop", async () => {
    const { host, service } = await filesBox();
    await service.sweep();
    for (const argv of diskSweepCommands()) expect(host.commands).toContain(argv.join(" "));
    const finds = host.commands.filter((c) => c.includes(" find ") || c.startsWith("find "));
    for (const c of finds) {
      if (c.startsWith("find ")) expect(c.startsWith(`find ${FILES_DROP_DIR} `)).toBe(true);
      else expect(c.startsWith("runuser -u hermes -- find /data/hermes/")).toBe(true);
    }
  });

  test("a failing command never throws out of a sweep", async () => {
    const { host, service } = await filesBox();
    host.execFaults.push(() => new Error("boom"));
    await expect(service.sweep()).resolves.toBeDefined();
  });
});

describe("the index", () => {
  test("a corrupt index starts empty, and says so", async () => {
    const host = new FakeHost();
    host.seed(FILES_INDEX_PATH, "{not json", "0600");
    const said: string[] = [];
    expect(await loadFilesIndex(host, (m) => void said.push(m))).toEqual({ entries: [], requests: [] });
    expect(said.join("\n")).toContain("starting empty");
  });

  test("a slot left receiving by a dead process is open again", async () => {
    const { socket, host } = await filesBox();
    const slot = await openSlot(socket);
    const doc = JSON.parse(host.files.get(FILES_INDEX_PATH)?.content ?? "{}");
    doc.requests[0].state = "receiving";
    host.seed(FILES_INDEX_PATH, JSON.stringify(doc), "0600");
    const loaded = await loadFilesIndex(host, () => {});
    expect(loaded.requests[0]).toMatchObject({ request_id: slot.request_id, state: "open" });
  });

  test("the index is root's: 0600, in hermeticd's own state directory", async () => {
    const { fetch, host } = await filesBox();
    expect(FILES_INDEX_PATH).toBe(`${STATE_DIR}/files.json`);
    await fetch("/files/stage/a.txt", put(TEXT));
    expect(host.files.get(FILES_INDEX_PATH)?.mode).toBe("0600");
    expect(host.files.get(FILES_INDEX_PATH)?.content).not.toContain("hello, agent");
  });
});

describe("the plugin socket", () => {
  test("removes a stale socket, listens, then chowns root:hermes and chmods 0660", async () => {
    const host = new FakeHost();
    host.seed(FILES_SOCKET_PATH, "stale");
    const order: string[] = [];
    host.fsFaults.push((op, path) => {
      order.push(`${op} ${path}`);
      return null;
    });
    await serveFilesSocket(
      host,
      async () => new Response("x"),
      (path) => {
        order.push(`listen ${path}`);
        return { stop: () => {} };
      },
    );
    expect(order).toEqual([`remove ${FILES_SOCKET_PATH}`, `listen ${FILES_SOCKET_PATH}`]);
    expectRan(host, new RegExp(`^chown root:hermes ${FILES_SOCKET_PATH}$`));
    expect(host.chmods).toContainEqual([FILES_SOCKET_PATH, "0660"]);
  });

  test("a failed chown stops the listener rather than leaving it open at the wrong owner", async () => {
    const host = new FakeHost();
    host.when(/^chown/, { code: 1, stderr: "no such group" });
    let stopped = false;
    await expect(
      serveFilesSocket(
        host,
        async () => new Response("x"),
        () => ({ stop: () => void (stopped = true) }),
      ),
    ).rejects.toThrow();
    expect(stopped).toBe(true);
  });

  test("an unknown socket route is a JSON 404", async () => {
    const { socket } = await filesBox();
    expect((await socket("/nope")).status).toBe(404);
  });
});
