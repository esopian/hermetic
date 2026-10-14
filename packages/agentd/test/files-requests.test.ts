/**
 * Request slots end to end: opened on the socket, filled or declined over the
 * tailnet, long-polled and consumed on the socket.
 */
import { describe, expect, test } from "bun:test";
import {
  FILES_DROP_DIR,
  FILES_LIMITS,
  FILES_NAME_HEADER,
  FILES_NOT_SECRET_HEADER,
  HERMES_HOME,
  HERMETICD_RPC_PORT,
  formatContentDigest,
} from "@hermetic/core/shared";
import { expectRan } from "./fake-host.ts";
import { TEST_NAME } from "./fixtures.ts";
import {
  PDF,
  PEM,
  PNG,
  TEXT,
  errorCode,
  filesBox,
  openSlot,
  post,
  put,
  sha256,
} from "./files-fixture.ts";

describe("opening a slot", () => {
  test("the socket opens a slot with deliver_with fallbacks; the tailnet sees its metadata", async () => {
    const { socket, fetch } = await filesBox();
    const slot = await openSlot(socket, { accept: [".pdf"] });
    expect(slot.status).toBe("open");
    expect(slot.deliver_with).toEqual([
      `hermetic files put ${TEST_NAME} --request ${slot.request_id} <path>`,
      `curl -T <path> http://${TEST_NAME}:${HERMETICD_RPC_PORT}/files/requests/${slot.request_id}`,
    ]);
    const res = await fetch(`/files/requests/${slot.request_id}`);
    expect(await res.json()).toMatchObject({
      request_id: slot.request_id,
      state: "open",
      accept: [".pdf"],
    });
    const list = (await (await fetch("/files/requests")).json()) as { requests: unknown[] };
    expect(list.requests).toHaveLength(1);
  });

  test("max_bytes is clamped to the class cap", async () => {
    const { socket, fetch } = await filesBox();
    const slot = await openSlot(socket, { sensitivity: "secret", max_bytes: 10 * 1024 * 1024 });
    const got = (await (await fetch(`/files/requests/${slot.request_id}`)).json()) as {
      max_bytes: number;
    };
    expect(got.max_bytes).toBe(FILES_LIMITS.secretEphemeralBytes);
  });

  test("the socket's hello and outbox", async () => {
    const { socket } = await filesBox();
    expect(await (await socket("/hello")).json()).toEqual({ hermeticd_version: "0.1.0", protocol: 1 });
    const outbox = await socket("/outbox", post({ path: "/data/hermes/x" }));
    expect(outbox.status).toBe(501);
    expect(await errorCode(outbox)).toBe("UNSUPPORTED");
  });
});

describe("fulfilling a slot", () => {
  test("a file lands in the inbox as hermes, named by the header, and the slot is fulfilled", async () => {
    const { socket, fetch, host, audit } = await filesBox();
    const slot = await openSlot(socket, { accept: [".pdf"] });
    const res = await fetch(
      `/files/requests/${slot.request_id}`,
      put(PDF, { [FILES_NAME_HEADER]: encodeURIComponent("Q3 report.pdf") }),
    );
    expect(res.status).toBe(200);
    const result = (await res.json()) as { path: string; class: string; sha256: string };
    expect(result.class).toBe("file");
    expect(result.sha256).toBe(sha256(PDF));
    expect(result.path).toMatch(
      new RegExp(`^${HERMES_HOME}/inbox/\\d{4}-\\d{2}-\\d{2}/f_[a-z0-9]{12}/Q3 report\\.pdf$`),
    );
    expect(host.files.get(result.path)?.ownership).toBe("hermes:hermes");
    expect(host.streamWrites[0]?.user).toBe("hermes");
    const wait = (await (await socket(`/requests/${slot.request_id}/wait?s=0`)).json()) as Record<
      string,
      unknown
    >;
    expect(wait).toMatchObject({ status: "fulfilled", path: result.path, by: "evan@example.com" });
    expect(audit.join("\n")).not.toContain("Q3 report");
  });

  test("a second PUT to the same slot is 409, and the first file is untouched", async () => {
    const { socket, fetch, host } = await filesBox();
    const slot = await openSlot(socket);
    const first = (await (await fetch(`/files/requests/${slot.request_id}`, put(TEXT))).json()) as {
      path: string;
    };
    const second = await fetch(`/files/requests/${slot.request_id}`, put(PDF));
    expect(second.status).toBe(409);
    expect(await errorCode(second)).toBe("FILE_REQUEST_FULFILLED");
    expect(host.files.get(first.path)?.bytes).toEqual(TEXT);
  });

  test("two concurrent PUTs: one wins, the other is 409 while the first is in flight", async () => {
    const { socket, fetch } = await filesBox();
    const slot = await openSlot(socket);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow = new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(TEXT.subarray(0, 4));
        await gate;
        c.enqueue(TEXT.subarray(4));
        c.close();
      },
    });
    const first = fetch(`/files/requests/${slot.request_id}`, {
      method: "PUT",
      body: slow,
      headers: { "content-length": String(TEXT.byteLength) },
    });
    await Bun.sleep(5);
    const second = await fetch(`/files/requests/${slot.request_id}`, put(PDF));
    expect(second.status).toBe(409);
    release();
    expect((await first).status).toBe(200);
  });

  test("a digest mismatch is 422, the part is gone, and the slot is open again with the refusal recorded", async () => {
    const { socket, fetch, host } = await filesBox();
    const slot = await openSlot(socket);
    const res = await fetch(
      `/files/requests/${slot.request_id}`,
      put(TEXT, { "content-digest": formatContentDigest(sha256(PDF)) }),
    );
    expect(res.status).toBe(422);
    expect(host.files.has(host.streamWrites[0]?.path ?? "")).toBe(false);
    const got = (await (await fetch(`/files/requests/${slot.request_id}`)).json()) as {
      state: string;
      rejected?: { code: string };
    };
    expect(got.state).toBe("open");
    expect(got.rejected?.code).toBe("FILE_DIGEST_MISMATCH");
    // And it can still be filled.
    expect((await fetch(`/files/requests/${slot.request_id}`, put(TEXT))).status).toBe(200);
  });

  test("a type outside accept is 415 before anything is written", async () => {
    const { socket, fetch, host } = await filesBox();
    const slot = await openSlot(socket, { accept: ["image/*"] });
    const res = await fetch(
      `/files/requests/${slot.request_id}`,
      put(PDF, { [FILES_NAME_HEADER]: "x.png" }),
    );
    expect(res.status).toBe(415);
    expect(await errorCode(res)).toBe("FILE_TYPE_REJECTED");
    expect(host.streamWrites).toEqual([]);
    expect(
      (await fetch(`/files/requests/${slot.request_id}`, put(PNG, { [FILES_NAME_HEADER]: "x.png" })))
        .status,
    ).toBe(200);
  });

  test("over the slot's max_bytes is 413", async () => {
    const { socket, fetch } = await filesBox();
    const slot = await openSlot(socket, { max_bytes: 4 });
    const res = await fetch(`/files/requests/${slot.request_id}`, put(TEXT));
    expect(res.status).toBe(413);
  });

  test("an expired slot is 410", async () => {
    const { socket, fetch, host } = await filesBox();
    const slot = await openSlot(socket);
    host.advance(3 * 3600 * 1000);
    const res = await fetch(`/files/requests/${slot.request_id}`, put(TEXT));
    expect(res.status).toBe(410);
    expect(await errorCode(res)).toBe("FILE_REQUEST_EXPIRED");
  });
});

describe("the secret lane", () => {
  test("a secret slot goes to the root-owned drop at 0600, chowned to hermes, never under /data", async () => {
    const { socket, fetch, host } = await filesBox();
    const slot = await openSlot(socket, { sensitivity: "secret", name_hint: "~/keys/token.txt" });
    const res = await fetch(`/files/requests/${slot.request_id}`, put(TEXT));
    expect(res.status).toBe(200);
    const result = (await res.json()) as { path: string; class: string };
    expect(result.class).toBe("secret");
    expect(result.path).toBe(`${FILES_DROP_DIR}/${slot.request_id}/token.txt`);
    expect(host.files.get(result.path)?.mode).toBe("0600");
    expectRan(host, new RegExp(`^chown hermes:hermes ${result.path}$`));
    expect(host.chmods).toContainEqual([`${FILES_DROP_DIR}/${slot.request_id}`, "0711"]);
    expect(host.streamWrites).toEqual([]);
    expect([...host.files.keys()].some((k) => k.startsWith("/data/"))).toBe(false);
  });

  test("key material sent to a normal slot is forced into the drop; the not-secret header keeps it a file", async () => {
    const { socket, fetch, host } = await filesBox();
    const forced = await openSlot(socket);
    const res = await fetch(
      `/files/requests/${forced.request_id}`,
      put(PEM, { [FILES_NAME_HEADER]: "deploy.pem" }),
    );
    expect(((await res.json()) as { path: string; class: string }).class).toBe("secret");
    expect(host.streamWrites).toEqual([]);

    const plain = await openSlot(socket);
    const kept = await fetch(
      `/files/requests/${plain.request_id}`,
      put(PEM, { [FILES_NAME_HEADER]: "deploy.pem", [FILES_NOT_SECRET_HEADER]: "1" }),
    );
    expect(((await kept.json()) as { class: string }).class).toBe("file");
  });

  test("a secret's content is 403 FILE_SECRET_FORBIDDEN", async () => {
    const { socket, fetch, index } = await filesBox();
    const slot = await openSlot(socket, { sensitivity: "secret" });
    await fetch(`/files/requests/${slot.request_id}`, put(TEXT));
    const id = index().entries[0]?.id ?? "";
    const res = await fetch(`/files/${id}/content`);
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("FILE_SECRET_FORBIDDEN");
  });

  test("consume deletes the ephemeral secret and marks the slot consumed", async () => {
    const { socket, fetch, host, index } = await filesBox();
    const slot = await openSlot(socket, { sensitivity: "secret" });
    const { path } = (await (await fetch(`/files/requests/${slot.request_id}`, put(TEXT))).json()) as {
      path: string;
    };
    const res = await socket(`/requests/${slot.request_id}/consume`, { method: "POST" });
    expect(((await res.json()) as { status: string }).status).toBe("consumed");
    expect(host.files.has(path)).toBe(false);
    expect(host.fsOps).toContain(`remove ${FILES_DROP_DIR}/${slot.request_id}`);
    expect(index().entries).toEqual([]);
  });

  test("a durable secret from SSM fulfils the slot without bytes over HTTP", async () => {
    const asked: string[] = [];
    const { socket, fetch, index } = await filesBox({
      materialiseSecret: async (slot) => {
        asked.push(slot);
        return {
          slot,
          name: "github-app.pem",
          path: "/run/hermetic/files/github-app.pem",
          sha256: sha256(PEM),
          bytes: PEM.byteLength,
        };
      },
    });
    const slot = await openSlot(socket, { sensitivity: "secret", durable: true });
    const res = await fetch(
      `/files/requests/${slot.request_id}/secret`,
      post({ ssm_slot: "file-github-app-pem", name: "github-app.pem" }),
    );
    expect(res.status).toBe(200);
    expect(asked).toEqual(["file-github-app-pem"]);
    expect(index().entries[0]).toMatchObject({
      dir: "secret",
      class: "secret",
      slot: "file-github-app-pem",
    });
    expect(index().requests[0]?.state).toBe("fulfilled");
  });
});

describe("waiting", () => {
  test("a long-poll resolves when the slot is fulfilled", async () => {
    const { socket, fetch } = await filesBox({ delay: (ms, signal) => realWait(ms, signal) });
    const slot = await openSlot(socket);
    const waiting = socket(`/requests/${slot.request_id}/wait?s=30`);
    await Bun.sleep(5);
    await fetch(`/files/requests/${slot.request_id}`, put(TEXT));
    const result = (await (await waiting).json()) as { status: string; path?: string };
    expect(result.status).toBe("fulfilled");
    expect(result.path).toBeDefined();
  });

  test("a long-poll resolves when the slot is declined", async () => {
    const { socket, fetch, audit } = await filesBox({ delay: (ms, signal) => realWait(ms, signal) });
    const slot = await openSlot(socket, { purpose: "a very private purpose" });
    const waiting = socket(`/requests/${slot.request_id}/wait?s=30`);
    await Bun.sleep(5);
    const declined = await fetch(
      `/files/requests/${slot.request_id}/decline`,
      post({ reason: "not today" }),
    );
    expect(declined.status).toBe(200);
    expect(((await (await waiting).json()) as { status: string }).status).toBe("declined");
    expect(audit.some((l) => l.startsWith(`files decline id=${slot.request_id}`))).toBe(true);
    expect(audit.join("\n")).not.toContain("very private");
    // Declined is closed: an upload now is refused.
    const late = await fetch(`/files/requests/${slot.request_id}`, put(TEXT));
    expect(await errorCode(late)).toBe("FILE_REQUEST_CLOSED");
  });

  test("a long-poll that times out answers open", async () => {
    const { socket } = await filesBox();
    const slot = await openSlot(socket);
    const result = (await (await socket(`/requests/${slot.request_id}/wait?s=5`)).json()) as {
      status: string;
    };
    expect(result.status).toBe("open");
  });
});

function realWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });
}
