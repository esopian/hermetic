/**
 * The tailnet files routes, through the real RPC handler: the `whois` gate,
 * the name sanitizer, the upload checks, stage → commit, downloads, deletes
 * and `/healthz`'s capability.
 */
import { describe, expect, test } from "bun:test";
import {
  FILES_CAPABILITY,
  FILES_INBOX_DIR,
  FILES_LIMITS,
  FILES_NOT_SECRET_HEADER,
  FILES_SESSION_HEADER,
  FILES_STAGE_DIR,
  HERMES_HOME,
  RPC_PATHS,
  formatContentDigest,
  inboxRelPath,
} from "@hermetic/core/shared";
import { expectRan } from "./fake-host.ts";
import {
  AGENT_NODE,
  PDF,
  PEM,
  PNG,
  STRANGER_IP,
  TEXT,
  errorCode,
  filesBox,
  post,
  put,
  sha256,
} from "./files-fixture.ts";

describe("the whois gate on the files routes", () => {
  test("an untagged tailnet member may stage", async () => {
    const { fetch } = await filesBox();
    const res = await fetch("/files/stage/notes.txt", put(TEXT));
    expect(res.status).toBe(201);
  });

  test("a tagged node (another agent) is refused with 403 and nothing is written", async () => {
    const { fetch, host } = await filesBox({ peer: AGENT_NODE });
    const res = await fetch("/files/stage/notes.txt", put(TEXT));
    expect(res.status).toBe(403);
    expect(host.streamWrites).toEqual([]);
    expect((await fetch("/files")).status).toBe(403);
  });

  test("a peer whois cannot name is refused with 403", async () => {
    const { fetch, host } = await filesBox();
    const res = await fetch("/files/stage/notes.txt", put(TEXT), STRANGER_IP);
    expect(res.status).toBe(403);
    expect(host.streamWrites).toEqual([]);
  });

  test("the audit line never carries the staged file's name", async () => {
    const { fetch, audit } = await filesBox();
    await fetch("/files/stage/merger-plans.pdf", put(PDF));
    expect(audit.join("\n")).not.toContain("merger-plans");
    expect(
      audit.some((l) => l.startsWith("files stage id=f_") && l.includes("login=evan@example.com")),
    ).toBe(true);
  });
});

describe("file names", () => {
  const bad: Array<[string, string]> = [
    ["a traversal with an encoded slash", "..%2Fx"],
    ["a NUL", "a%00b.txt"],
    ["an RTL override", "invoice%E2%80%AEfdp.exe"],
    ["a 300-byte name", `${"a".repeat(296)}.txt`],
    ["a dotfile", ".env"],
  ];
  for (const [what, segment] of bad) {
    test(`${what} is 400 FILE_NAME_INVALID and nothing is written`, async () => {
      const { fetch, host } = await filesBox();
      const res = await fetch(`/files/stage/${segment}`, put(TEXT));
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe("FILE_NAME_INVALID");
      expect(host.streamWrites).toEqual([]);
    });
  }
});

describe("upload checks", () => {
  test("no Content-Length is 411", async () => {
    const { fetch } = await filesBox();
    const res = await fetch("/files/stage/notes.txt", { method: "PUT", body: TEXT });
    expect(res.status).toBe(411);
    expect(await errorCode(res)).toBe("VALIDATION");
  });

  test("a Content-Length over the cap is 413 before a byte is read", async () => {
    const { fetch, host } = await filesBox();
    const res = await fetch(
      "/files/stage/big.bin",
      put(TEXT, { "content-length": String(FILES_LIMITS.fileBytes + 1) }),
    );
    expect(res.status).toBe(413);
    expect(await errorCode(res)).toBe("FILE_TOO_LARGE");
    expect(host.streamWrites).toEqual([]);
  });

  test("a body longer than its Content-Length is cut off mid-stream with 413, the part removed", async () => {
    const { fetch, host } = await filesBox();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(6000).fill(65));
        c.enqueue(new Uint8Array(6000).fill(66));
        c.close();
      },
    });
    const res = await fetch("/files/stage/notes.txt", {
      method: "PUT",
      body,
      headers: { "content-length": "8000" },
    });
    expect(res.status).toBe(413);
    expect(host.streamWrites).toHaveLength(1);
    expect(host.files.has(host.streamWrites[0]?.path ?? "")).toBe(false);
  });

  test("a digest mismatch is 422 and the part file is unlinked", async () => {
    const { fetch, host, index } = await filesBox();
    const res = await fetch(
      "/files/stage/notes.txt",
      put(TEXT, { "content-digest": formatContentDigest(sha256(PDF)) }),
    );
    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe("FILE_DIGEST_MISMATCH");
    const part = host.streamWrites[0]?.path ?? "";
    expect(part).toMatch(/\/\.part-f_[a-z0-9]{12}$/);
    expect(host.files.has(part)).toBe(false);
    expect(index().entries).toEqual([]);
  });

  test("no Content-Digest is accepted (curl -T) and the box still returns the sha256", async () => {
    const { fetch } = await filesBox();
    const res = await fetch("/files/stage/notes.txt", {
      method: "PUT",
      body: TEXT,
      headers: { "content-length": String(TEXT.byteLength) },
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { sha256: string }).sha256).toBe(sha256(TEXT));
  });

  test("a write that would breach the disk floor is 507", async () => {
    const { fetch, host } = await filesBox();
    host.filesystemResult = {
      mount: "/data",
      size: 100 * 1024 ** 3,
      available: 2 * 1024 ** 3,
      usePct: 98,
    };
    const res = await fetch("/files/stage/notes.txt", put(TEXT));
    expect(res.status).toBe(507);
    expect(await errorCode(res)).toBe("DISK_FULL");
    expect(host.streamWrites).toEqual([]);
  });

  test("an unmeasurable volume is let through", async () => {
    const { fetch, host } = await filesBox();
    host.filesystemResult = null;
    expect((await fetch("/files/stage/notes.txt", put(TEXT))).status).toBe(201);
  });

  test("key material on a stage is 409 FILE_LOOKS_SECRET, nothing written; the not-secret header admits it", async () => {
    const { fetch, host } = await filesBox();
    const refused = await fetch("/files/stage/deploy.pem", put(PEM));
    expect(refused.status).toBe(409);
    expect(await errorCode(refused)).toBe("FILE_LOOKS_SECRET");
    expect(host.streamWrites).toEqual([]);
    const admitted = await fetch(
      "/files/stage/deploy.pem",
      put(PEM, { [FILES_NOT_SECRET_HEADER]: "1" }),
    );
    expect(admitted.status).toBe(201);
  });
});

describe("stage, then commit", () => {
  test("the staged file is written as hermes at 0600, then moved to the inbox path inboxRelPath names", async () => {
    const { fetch, host, index, service } = await filesBox();
    const staged = await fetch("/files/stage/shot.png", put(PNG, { [FILES_SESSION_HEADER]: "sess-1" }));
    expect(staged.status).toBe(201);
    const result = (await staged.json()) as {
      id: string;
      mime: string;
      class: string;
      bytes: number;
      sha256: string;
    };
    expect(result).toMatchObject({
      mime: "image/png",
      class: "image",
      bytes: PNG.byteLength,
      sha256: sha256(PNG),
    });
    expect(host.streamWrites[0]).toMatchObject({ user: "hermes", mode: "0600" });
    expect(host.streamWrites[0]?.path.startsWith(`${FILES_STAGE_DIR}/${result.id}/.part-`)).toBe(true);
    expect(host.files.get(`${FILES_STAGE_DIR}/${result.id}/shot.png`)?.ownership).toBe("hermes:hermes");
    expect(index().entries[0]).toMatchObject({ id: result.id, dir: "stage", session_id: "sess-1" });

    const committed = await fetch(`/files/${result.id}/commit`, post({ session_id: "sess-1" }));
    expect(committed.status).toBe(200);
    const { rel, path } = (await committed.json()) as { rel: string; path: string };
    expect(rel).toBe(inboxRelPath(host.now(), result.id, "shot.png"));
    expect(path).toBe(`${HERMES_HOME}/${rel}`);
    expect(host.files.get(path)?.bytes).toEqual(PNG);
    expect(host.files.has(`${FILES_STAGE_DIR}/${result.id}/shot.png`)).toBe(false);
    expect(index().entries[0]).toMatchObject({ dir: "inbox", rel, path });
    // Download, sweep and delete too, so every path the service takes is covered.
    expect((await fetch(`/files/${result.id}/content`)).status).toBe(200);
    await service.sweep();
    expect((await fetch(`/files/${result.id}`, { method: "DELETE" })).status).toBe(204);
    // Every move, mkdir, test and unlink under /data ran as the account, never as root…
    for (const c of host.commands.filter((c) => c.includes(FILES_INBOX_DIR))) {
      expect(c.startsWith("runuser -u hermes -- ")).toBe(true);
    }
    expectRan(host, /^runuser -u hermes -- mv -n -T -- /);
    // …and root's own Host calls (lstat, stat, read, write, rename, remove…) never went there.
    expect(host.rootFsCalls.filter((c) => c.split(" ")[1]?.startsWith("/data"))).toEqual([]);
  });

  test("committing an unknown id is 404", async () => {
    const { fetch } = await filesBox();
    const res = await fetch("/files/f_aaaaaaaaaaaa/commit", post({}));
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("FILE_NOT_FOUND");
  });

  test("a destination that already exists is never overwritten", async () => {
    const { fetch, host } = await filesBox();
    const staged = (await (await fetch("/files/stage/notes.txt", put(TEXT))).json()) as { id: string };
    const dest = `${HERMES_HOME}/${inboxRelPath(host.now(), staged.id, "notes.txt")}`;
    host.seed(dest, "planted");
    const res = await fetch(`/files/${staged.id}/commit`, post({}));
    expect(res.status).toBe(409);
    expect(host.files.get(dest)?.content).toBe("planted");
  });
});

describe("reading and removing", () => {
  test("content streams an inbox file as hermes with its type, length and digest", async () => {
    const { fetch, host } = await filesBox();
    const { id } = (await (await fetch("/files/stage/doc.pdf", put(PDF))).json()) as { id: string };
    await fetch(`/files/${id}/commit`, post({}));
    const res = await fetch(`/files/${id}/content`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-length")).toBe(String(PDF.byteLength));
    expect(res.headers.get("content-digest")).toBe(formatContentDigest(sha256(PDF)));
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF);
    expect(host.streamReads.every((r) => r.startsWith("hermes "))).toBe(true);
  });

  test("list and entry report metadata only", async () => {
    const { fetch } = await filesBox();
    const { id } = (await (await fetch("/files/stage/notes.txt", put(TEXT))).json()) as { id: string };
    const list = (await (await fetch("/files")).json()) as {
      inbox: Array<{ id: string }>;
      usage: { retention_days: number };
    };
    expect(list.inbox.map((e) => e.id)).toEqual([id]);
    expect(list.usage.retention_days).toBe(7);
    expect((await fetch(`/files/${id}`)).status).toBe(200);
  });

  test("delete removes the per-id directory as hermes and the index entry", async () => {
    const { fetch, host, index, audit } = await filesBox();
    const { id } = (await (await fetch("/files/stage/notes.txt", put(TEXT))).json()) as { id: string };
    const res = await fetch(`/files/${id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expectRan(host, new RegExp(`^runuser -u hermes -- rm -rf -- ${FILES_STAGE_DIR}/${id}$`));
    expect(host.files.has(`${FILES_STAGE_DIR}/${id}/notes.txt`)).toBe(false);
    expect(index().entries).toEqual([]);
    expect(audit.some((l) => l.startsWith(`files delete id=${id}`))).toBe(true);
  });

  test("an unknown files path is a JSON 404", async () => {
    const { fetch } = await filesBox();
    const res = await fetch("/files/nope/whatever/else");
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("NOT_FOUND");
  });
});

describe("/healthz", () => {
  test("reports the files capability when the service is wired", async () => {
    const { fetch } = await filesBox();
    const res = await fetch(RPC_PATHS.health);
    expect(((await res.json()) as { capabilities?: string[] }).capabilities).toEqual([
      FILES_CAPABILITY,
    ]);
  });
});
