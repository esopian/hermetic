/**
 * The files service under hostile or unlucky conditions: a client that stops
 * sending, an index write that fails, an agent that swaps a file for a link,
 * two operations on one id at once, a socket that opens slots in a loop, a
 * tagged node the RPC policy admits, and the error text that reaches the log.
 */
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  FILES_DROP_DIR,
  FILES_INBOX_DIR,
  FILES_INDEX_PATH,
  FILES_LIMITS,
  FILES_SECRET_DIR,
  FILES_SOCKET_PATH,
  FILES_STAGE_DIR,
  FILES_TTL,
  encodeSecretEnvelope,
} from "@hermetic/core/shared";
import type { Aws } from "../src/aws.ts";
import { AgentdError } from "../src/errors.ts";
import { FilesError, filesErrorResponse, scrubPaths, toFilesResponse } from "../src/files/errors.ts";
import { materialiseAllFileSecrets, materialiseFileSecret } from "../src/files/secrets.ts";
import { FILES_SOCKET_UMASK, serveFilesSocket } from "../src/files/socket.ts";
import { diskSweepCommands } from "../src/files/sweeper.ts";
import { PATH_KIND_SCRIPT } from "../src/files/fs-ops.ts";
import {
  type PipedChild,
  READ_STREAM_REFUSED,
  READ_STREAM_SCRIPT,
  WRITE_STREAM_SCRIPT,
  pipeIntoChild,
} from "../src/host.ts";
import { FakeHost } from "./fake-host.ts";
import {
  MEMBER,
  PDF,
  PEM,
  TEXT,
  errorCode,
  filesBox,
  openSlot,
  post,
  put,
  sha256,
} from "./files-fixture.ts";

/** A body that sends `first` and then nothing, holding the connection open. */
function stalledBody(first: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(first);
    },
  });
}

function stalledPut(first: Uint8Array, declared: number): RequestInit {
  return {
    method: "PUT",
    body: stalledBody(first),
    headers: { "content-length": String(declared) },
    duplex: "half",
  } as RequestInit;
}

const KIB8 = new Uint8Array(8 * 1024).fill(0x61);

describe("a stalled upload (finding 1)", () => {
  test("is cut off after the idle timeout: 408, part unlinked, slot open again", async () => {
    const { socket, fetch, host, index } = await filesBox({ uploadIdleMs: 20 });
    const slot = await openSlot(socket);
    const res = await fetch(`/files/requests/${slot.request_id}`, stalledPut(KIB8, 64 * 1024));
    expect(res.status).toBe(408);
    expect([...host.files.keys()].filter((k) => k.startsWith(FILES_INBOX_DIR))).toEqual([]);
    expect(host.streamWrites).toHaveLength(1);
    expect(index().requests[0]).toMatchObject({ state: "open", rejected: { code: "VALIDATION" } });
    // The lock is free: a real upload now lands.
    const again = await fetch(
      `/files/requests/${slot.request_id}`,
      put(TEXT, { "x-hermetic-name": "a.txt" }),
    );
    expect(again.status).toBe(200);
  });

  test("a slot receiving past receivingMax is reclaimed by the sweeper and its upload aborted", async () => {
    const { socket, fetch, host, service, index } = await filesBox({ uploadIdleMs: 60_000 });
    const slot = await openSlot(socket);
    const pending = fetch(`/files/requests/${slot.request_id}`, stalledPut(KIB8, 64 * 1024));
    // Let the upload take the lock and start writing.
    for (let i = 0; i < 50 && host.streamWrites.length === 0; i += 1) await Bun.sleep(1);
    expect(index().requests[0]?.state).toBe("receiving");
    host.advance((FILES_TTL.receivingMax + 1) * 1000);
    await service.sweep();
    const res = await pending;
    expect(res.status).toBe(408);
    // Reopened, and — `receivingMax` being the slot's own lifetime — then expired.
    expect(index().requests[0]?.state).toBe("expired");
    expect(
      [...host.files.keys()].filter((k) =>
        k.endsWith(`.part-${host.streamWrites[0]?.path.split(".part-")[1]}`),
      ),
    ).toEqual([]);
  });
});

describe("the index (finding 2)", () => {
  test("a failed write leaves memory as it was", async () => {
    const { socket, service, host } = await filesBox();
    host.writeFaults.push((path) => (path === FILES_INDEX_PATH ? new Error("EIO: i/o error") : null));
    const res = await socket("/requests", post({ purpose: "x" }));
    expect(res.status).toBe(500);
    expect(service.ctx.store.read().requests).toEqual([]);
    host.writeFaults.length = 0;
    await openSlot(socket);
    expect(service.ctx.store.read().requests).toHaveLength(1);
  });
});

describe("durable secrets on tmpfs (finding 3)", () => {
  const PREFIX = "/hermes/fxtr0001/research-1/";
  const value = encodeSecretEnvelope({ name: "late.pem", bytes: PEM, sha256: sha256(PEM) });

  test("a secret placed while the boot sweep is listing SSM is not swept", async () => {
    const host = new FakeHost();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const aws = {
      getParametersByPath: async () => {
        await gate;
        return [];
      },
      getParameter: async () => value,
    } as unknown as Aws;
    const all = materialiseAllFileSecrets({ host, aws, paramPrefix: PREFIX });
    const one = materialiseFileSecret({ host, aws, paramPrefix: PREFIX }, "file-late-pem");
    await Bun.sleep(1);
    release();
    await all;
    await one;
    expect(host.files.has(`${FILES_SECRET_DIR}/late.pem`)).toBe(true);
  });

  test("the sweep leaves dot-prefixed staging files alone", async () => {
    const host = new FakeHost();
    host.seed(`${FILES_SECRET_DIR}/.late.pem.tmp-1`, "staging", "0600");
    host.seed(`${FILES_SECRET_DIR}/gone.pem`, "old", "0600");
    const aws = { getParametersByPath: async () => [] } as unknown as Aws;
    await materialiseAllFileSecrets({ host, aws, paramPrefix: PREFIX });
    expect(host.files.has(`${FILES_SECRET_DIR}/.late.pem.tmp-1`)).toBe(true);
    expect(host.files.has(`${FILES_SECRET_DIR}/gone.pem`)).toBe(false);
  });
});

describe("downloads (finding 4)", () => {
  async function committed() {
    const box = await filesBox();
    const { id } = (await (await box.fetch("/files/stage/doc.pdf", put(PDF))).json()) as { id: string };
    const { path } = (await (await box.fetch(`/files/${id}/commit`, post({}))).json()) as {
      path: string;
    };
    return { ...box, id, path };
  }

  test("an inbox file swapped for a symlink is refused, and nothing is read", async () => {
    const { fetch, host, id, path } = await committed();
    host.symlinks.add(path);
    const res = await fetch(`/files/${id}/content`);
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("FORBIDDEN");
    expect(host.streamReads).toEqual([]);
  });

  test("a file whose size no longer matches the index aborts the stream", async () => {
    const { fetch, host, id, path } = await committed();
    host.seedBytes(path, new Uint8Array(PDF.byteLength + 10).fill(1), "0600");
    const res = await fetch(`/files/${id}/content`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-digest")).toContain("sha-256=");
    await expect(res.arrayBuffer()).rejects.toThrow();
  });

  test("the reader script refuses a symlink and a non-regular file (exit 40), and cats a file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hermetic-read-"));
    try {
      writeFileSync(join(dir, "real"), "bytes");
      symlinkSync(join(dir, "real"), join(dir, "link"));
      const run = (p: string) => Bun.spawnSync(["sh", "-c", READ_STREAM_SCRIPT, "sh", p]);
      expect(run(join(dir, "link")).exitCode).toBe(READ_STREAM_REFUSED);
      expect(run(dir).exitCode).toBe(READ_STREAM_REFUSED);
      const ok = run(join(dir, "real"));
      expect(ok.exitCode).toBe(0);
      expect(ok.stdout.toString()).toBe("bytes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("one id, two operations (findings 5 and 15)", () => {
  test("a commit and a delete at once: one wins, the other is refused, and the index agrees with the disk", async () => {
    const { fetch, index, host } = await filesBox();
    const { id } = (await (await fetch("/files/stage/a.txt", put(TEXT))).json()) as { id: string };
    const [commit, del] = await Promise.all([
      fetch(`/files/${id}/commit`, post({})),
      fetch(`/files/${id}`, { method: "DELETE" }),
    ]);
    const onDisk = [...host.files.keys()].filter((k) => k.startsWith(FILES_INBOX_DIR));
    if (del.status === 204) {
      // The commit waited for the delete to let go, then found nothing to commit.
      expect(commit.status).toBe(404);
      expect(await errorCode(commit)).toBe("FILE_NOT_FOUND");
      expect(index().entries).toEqual([]);
      expect(onDisk).toEqual([]);
    } else {
      expect(del.status).toBe(409);
      expect(await errorCode(del)).toBe("CONFLICT");
      expect(commit.status).toBe(200);
      expect(index().entries[0]).toMatchObject({ id, dir: "inbox" });
      expect(onDisk).toEqual([index().entries[0]?.path ?? ""]);
    }
  });

  test("a second commit answers what the first did", async () => {
    const { fetch } = await filesBox();
    const { id } = (await (await fetch("/files/stage/a.txt", put(TEXT))).json()) as { id: string };
    const first = await (await fetch(`/files/${id}/commit`, post({}))).json();
    const second = await fetch(`/files/${id}/commit`, post({}));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(first);
  });

  test("the sweeper skips a claimed entry, and the disk pass excludes in-flight ids", async () => {
    const { fetch, host, service, index } = await filesBox();
    const { id } = (await (await fetch("/files/stage/a.txt", put(TEXT))).json()) as { id: string };
    const claim = service.ctx.store.claim(id);
    host.advance((FILES_TTL.stage + 60) * 1000);
    await service.sweep();
    expect(index().entries.map((e) => e.id)).toEqual([id]);
    const stageSweep = host.commands.find((c) => c.includes(`find ${FILES_STAGE_DIR} `)) ?? "";
    expect(stageSweep).toContain(`-not -name ${id}`);
    claim?.release();
    await service.sweep();
    expect(index().entries).toEqual([]);
  });

  test("the disk pass excludes an in-flight part file and ignores an unsafe id", () => {
    const [stage, parts] = diskSweepCommands(["f_abc123", "secret-name:x y"]);
    expect(stage?.join(" ")).toContain("-not -name f_abc123");
    expect(parts?.join(" ")).toContain("-not -name .part-f_abc123");
    expect(stage?.join(" ")).not.toContain("secret-name");
  });
});

describe("JSON bodies (finding 6)", () => {
  test("a body with no Content-Length is 411, read or not", async () => {
    const { fetch } = await filesBox();
    const res = await fetch("/files/f_aaaaaaaaaaaa/commit", {
      method: "POST",
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("{}"));
          c.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(411);
  });

  test("a Content-Length over 64 KiB is 413 before the body is read", async () => {
    const { fetch } = await filesBox();
    const text = JSON.stringify({ reason: "x".repeat(70 * 1024) });
    const res = await fetch("/files/requests/fr_aaaaaaaaaaaa/decline", {
      method: "POST",
      body: text,
      headers: { "content-length": String(text.length) },
    });
    expect(res.status).toBe(413);
  });
});

describe("open slots (finding 7)", () => {
  test(`the socket refuses slot ${FILES_LIMITS.openRequests + 1} with CONFLICT`, async () => {
    const { socket, index } = await filesBox();
    for (let i = 0; i < FILES_LIMITS.openRequests; i += 1) await openSlot(socket);
    const res = await socket("/requests", post({ purpose: "one more" }));
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("CONFLICT");
    expect(index().requests).toHaveLength(FILES_LIMITS.openRequests);
  });
});

describe("the socket bind (finding 8)", () => {
  test("chmods /run/hermetic 0711 first and binds under umask 0177, restored after", async () => {
    const host = new FakeHost();
    const before = process.umask();
    let during = -1;
    const dir = FILES_SOCKET_PATH.slice(0, FILES_SOCKET_PATH.lastIndexOf("/"));
    await serveFilesSocket(
      host,
      async () => new Response("x"),
      () => {
        during = process.umask();
        expect(host.chmods).toContainEqual([dir, "0711"]);
        return { stop: () => {} };
      },
    );
    expect(during).toBe(FILES_SOCKET_UMASK);
    expect(process.umask()).toBe(before);
  });
});

describe("error text (findings 9 and 10)", () => {
  test("scrubPaths hides every path under the files roots, spaces and all", () => {
    const msg =
      `ENOENT: open '${FILES_DROP_DIR}/fr_abc/acme prod.pem' and '${FILES_SECRET_DIR}/root key.pem'; ` +
      `mv: ${FILES_INBOX_DIR}/2026-09-01/f_x/deploy.pem`;
    const out = scrubPaths(msg);
    expect(out).not.toContain("acme");
    expect(out).not.toContain("root key");
    expect(out).not.toContain("deploy");
    expect(out).toContain("ENOENT: open '<files-path>'");
  });

  test("an unexpected error is logged scrubbed, and a 5xx body is scrubbed", async () => {
    const lines: string[] = [];
    toFilesResponse(
      new Error(`chown: '${FILES_DROP_DIR}/fr_a/secret-name.pem'`),
      (m) => lines.push(m),
      "fulfil",
    );
    expect(lines.join("\n")).not.toContain("secret-name");
    const res = filesErrorResponse(new FilesError("INTERNAL", `stuck at ${FILES_SECRET_DIR}/root.pem`));
    expect(JSON.stringify(await res.json())).not.toContain("root.pem");
  });

  test("a secret's audit line carries no digest", async () => {
    const { socket, fetch, audit } = await filesBox();
    const slot = await openSlot(socket, { sensitivity: "secret" });
    const res = await fetch(
      `/files/requests/${slot.request_id}`,
      put(PEM, { "x-hermetic-name": "k.pem" }),
    );
    expect(res.status).toBe(200);
    const line = audit.find((l) => l.startsWith("files fulfil "));
    expect(line).toContain("sha256=-");
    expect(line).not.toContain(sha256(PEM).slice(0, 12));
  });
});

describe("the write script (finding 11)", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (path: string, input: string) =>
    Bun.spawnSync(["sh", "-c", WRITE_STREAM_SCRIPT, "sh", path, "0600"], { stdin: Buffer.from(input) });

  test("refuses a symlink to a non-regular file with exit 17, and creates a fresh file 0600", () => {
    dir = mkdtempSync(join(tmpdir(), "hermetic-write-"));
    symlinkSync("/dev/null", join(dir, "sink"));
    symlinkSync(join(dir, "nowhere"), join(dir, "dangling"));
    expect(write(join(dir, "sink"), "secret").exitCode).toBe(17);
    expect(write(join(dir, "dangling"), "secret").exitCode).toBe(17);
    expect(write(join(dir, "fresh"), "hello").exitCode).toBe(0);
    expect(readFileSync(join(dir, "fresh"), "utf8")).toBe("hello");
    expect(statSync(join(dir, "fresh")).mode & 0o777).toBe(0o600);
    chmodSync(join(dir, "fresh"), 0o600);
    expect(write(join(dir, "fresh"), "again").exitCode).not.toBe(0);
  });
});

describe("streaming into a child (finding 12)", () => {
  test("a child that exits early stops the read and surfaces its own error", async () => {
    let pulled = 0;
    async function* body(): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < 2000; i += 1) {
        pulled += 1;
        yield new Uint8Array(16 * 1024);
        await Bun.sleep(1);
      }
    }
    const proc = Bun.spawn(["sh", "-c", "echo refused >&2; exit 3"], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
    });
    await expect(pipeIntoChild(proc, body(), "writing as hermes")).rejects.toThrow(
      /writing as hermes exited 3: refused/,
    );
    expect(pulled).toBeLessThan(200);
  });
});

describe("durable secret names (finding 14)", () => {
  const stub = (name: string) => async (slot: string) => ({
    slot,
    name,
    path: `${FILES_SECRET_DIR}/${name}`,
    sha256: sha256(PEM),
    bytes: PEM.byteLength,
  });

  test("a second slot naming a file another slot owns is 409, and SSM is not read", async () => {
    const asked: string[] = [];
    const { socket, fetch } = await filesBox({
      materialiseSecret: async (slot, expectName) => {
        asked.push(slot);
        return stub(expectName)(slot);
      },
    });
    const a = await openSlot(socket, { sensitivity: "secret", durable: true });
    const first = await fetch(
      `/files/requests/${a.request_id}/secret`,
      post({ ssm_slot: "file-deploy-a", name: "deploy.pem" }),
    );
    expect(first.status).toBe(200);
    const b = await openSlot(socket, { sensitivity: "secret", durable: true });
    const res = await fetch(
      `/files/requests/${b.request_id}/secret`,
      post({ ssm_slot: "file-deploy-b", name: "deploy.pem" }),
    );
    expect(res.status).toBe(409);
    expect(asked).toEqual(["file-deploy-a"]);
  });

  test("an envelope naming another file than body.name is refused before anything is written", async () => {
    const host = new FakeHost();
    const value = encodeSecretEnvelope({ name: "other.pem", bytes: PEM, sha256: sha256(PEM) });
    const aws = { getParameter: async () => value } as unknown as Aws;
    const err = await materialiseFileSecret(
      { host, aws, paramPrefix: "/hermes/fxtr0001/research-1/" },
      "file-deploy",
      "deploy.pem",
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FilesError);
    expect((err as FilesError).code).toBe("VALIDATION");
    expect(host.files.has(`${FILES_SECRET_DIR}/other.pem`)).toBe(false);

    const { socket, fetch } = await filesBox({
      materialiseSecret: async () => {
        throw err;
      },
    });
    const slot = await openSlot(socket, { sensitivity: "secret", durable: true });
    const res = await fetch(
      `/files/requests/${slot.request_id}/secret`,
      post({ ssm_slot: "file-deploy", name: "deploy.pem" }),
    );
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("VALIDATION");
  });
});

describe("tagged nodes (finding 16)", () => {
  test("a node carrying an allowed tag is refused on the files routes, and nothing is written", async () => {
    const { fetch, host } = await filesBox({
      peer: { ...MEMBER, tags: ["tag:ops"] },
      allowedTags: ["tag:ops"],
    });
    const res = await fetch("/files/stage/a.txt", put(TEXT));
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("FORBIDDEN");
    expect(host.streamWrites).toEqual([]);
    // The read-only routes it was allowed stay open to it.
    expect((await fetch("/healthz")).status).toBe(200);
  });
});

// ─── Round 2 ─────────────────────────────────────────────────────────────────

/** Stage `name` and return its id and stage path. */
async function stage(
  fetch: (path: string, init?: RequestInit) => Promise<Response>,
  name: string,
  bytes: Uint8Array = TEXT,
): Promise<{ id: string; stagePath: string }> {
  const res = await fetch(`/files/stage/${name}`, put(bytes));
  if (res.status !== 201) throw new Error(`stage failed: ${res.status} ${await res.text()}`);
  const { id } = (await res.json()) as { id: string };
  return { id, stagePath: `${FILES_STAGE_DIR}/${id}/${name}` };
}

describe("the sweeper and a commit at once (round 2, finding 1)", () => {
  test("a commit landing while the sweeper works keeps its entry and its inbox file", async () => {
    const { fetch, host, service, index } = await filesBox();
    const a = await stage(fetch, "a.txt");
    const b = await stage(fetch, "b.txt");
    host.advance((FILES_TTL.stage + 60) * 1000);
    // B is committed while the sweeper is still removing A: the sweeper's
    // snapshot of B, taken before, still says `stage` and due.
    const realExec = host.exec.bind(host);
    const pending: { commit: Promise<Response> | null } = { commit: null };
    host.exec = async (argv, opts) => {
      if (pending.commit === null && argv.join(" ").includes(`rm -rf -- ${FILES_STAGE_DIR}/${a.id}`)) {
        pending.commit = fetch(`/files/${b.id}/commit`, post({}));
        await pending.commit;
      }
      return realExec(argv, opts);
    };
    await service.sweep();
    expect((await pending.commit)?.status).toBe(200);
    const committed = index().entries.find((e) => e.id === b.id);
    expect(committed).toMatchObject({ dir: "inbox" });
    expect(host.files.has(committed?.path ?? "")).toBe(true);
    expect(index().entries.map((e) => e.id)).toEqual([b.id]);
  });
});

describe("a path check that cannot be made (round 2, finding 2)", () => {
  test("is 500 on a download and forgets nothing, there or in the sweeper", async () => {
    const { fetch, host, service, index } = await filesBox();
    const { id } = await stage(fetch, "doc.pdf", PDF);
    expect((await fetch(`/files/${id}/commit`, post({}))).status).toBe(200);
    const stop = host.when(/echo missing/, { code: 125, stderr: "runuser: cannot set groups" });
    const res = await fetch(`/files/${id}/content`);
    expect(res.status).toBe(500);
    expect(await errorCode(res)).toBe("INTERNAL");
    expect(index().entries.map((e) => e.id)).toEqual([id]);
    const report = await service.sweep();
    expect(report.forgotten).toBe(0);
    expect(index().entries.map((e) => e.id)).toEqual([id]);
    stop();
    expect((await fetch(`/files/${id}/content`)).status).toBe(200);
  });

  test("the kind script answers regular, other or missing, and exits 0 for each", () => {
    const dir = mkdtempSync(join(tmpdir(), "hermetic-kind-"));
    try {
      writeFileSync(join(dir, "real"), "bytes");
      symlinkSync(join(dir, "real"), join(dir, "link"));
      const run = (p: string) => Bun.spawnSync(["sh", "-c", PATH_KIND_SCRIPT, "sh", p]);
      const answer = (p: string) => {
        const out = run(p);
        expect(out.exitCode).toBe(0);
        return out.stdout.toString().trim();
      };
      expect(answer(join(dir, "real"))).toBe("regular");
      expect(answer(join(dir, "link"))).toBe("other");
      expect(answer(dir)).toBe("other");
      expect(answer(join(dir, "nothing"))).toBe("missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SSM and the secrets lock (round 2, finding 3)", () => {
  const PREFIX = "/hermes/fxtr0001/research-1/";
  const value = (bytes: Uint8Array) =>
    encodeSecretEnvelope({ name: "late.pem", bytes, sha256: sha256(bytes) });

  test("a hung SSM read times out instead of hanging", async () => {
    const host = new FakeHost();
    const aws = { getParameter: () => new Promise<string>(() => {}) } as unknown as Aws;
    const err = await materialiseFileSecret(
      { host, aws, paramPrefix: PREFIX, ssmTimeoutMs: 20 },
      "file-late-pem",
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentdError);
    expect((err as AgentdError).code).toBe("INTERNAL");
  }, 2000);

  test("a hung listing does not hold up a route placing its own slot", async () => {
    const host = new FakeHost();
    const aws = {
      getParametersByPath: () => new Promise(() => {}),
      getParameter: async () => value(PEM),
    } as unknown as Aws;
    const all = materialiseAllFileSecrets({ host, aws, paramPrefix: PREFIX, ssmTimeoutMs: 100 }).catch(
      (e: unknown) => e,
    );
    await materialiseFileSecret({ host, aws, paramPrefix: PREFIX }, "file-late-pem");
    expect(host.files.has(`${FILES_SECRET_DIR}/late.pem`)).toBe(true);
    expect(await all).toBeInstanceOf(AgentdError);
  }, 2000);

  test("a listing older than a route's read does not overwrite what the route placed", async () => {
    const host = new FakeHost();
    const fresh = new TextEncoder().encode("FIXTURE-fresh");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const aws = {
      getParametersByPath: async () => {
        await gate;
        return [{ name: `${PREFIX}file-late-pem`, value: value(PEM) }];
      },
      getParameter: async () => value(fresh),
    } as unknown as Aws;
    const all = materialiseAllFileSecrets({ host, aws, paramPrefix: PREFIX });
    await materialiseFileSecret({ host, aws, paramPrefix: PREFIX }, "file-late-pem");
    release();
    await all;
    expect(host.files.get(`${FILES_SECRET_DIR}/late.pem`)?.content).toBe("FIXTURE-fresh");
  });

  test("a route read that loses to a newer listing does not put its stale value back", async () => {
    const host = new FakeHost();
    const stale = new TextEncoder().encode("FIXTURE-stale");
    const fresh = new TextEncoder().encode("FIXTURE-fresh");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const aws = {
      getParametersByPath: async () => [{ name: `${PREFIX}file-late-pem`, value: value(fresh) }],
      // The first route read hangs until the listing has placed; a re-read sees the fresh value.
      getParameter: async () => {
        reads += 1;
        if (reads === 1) {
          await gate;
          return value(stale);
        }
        return value(fresh);
      },
    } as unknown as Aws;
    const route = materialiseFileSecret({ host, aws, paramPrefix: PREFIX }, "file-late-pem");
    await materialiseAllFileSecrets({ host, aws, paramPrefix: PREFIX });
    release();
    const placed = await route;
    expect(host.files.get(`${FILES_SECRET_DIR}/late.pem`)?.content).toBe("FIXTURE-fresh");
    expect(reads).toBe(2);
    expect(placed.name).toBe("late.pem");
  });
});

describe("taking a slot (round 2, finding 4)", () => {
  test("a receiving slot is never persisted without its claim, and a failed save frees it", async () => {
    const { socket, fetch, host, service } = await filesBox();
    const slot = await openSlot(socket);
    host.writeFaults.push((path) => (path === FILES_INDEX_PATH ? new Error("EIO: i/o error") : null));
    const failed = await fetch(`/files/requests/${slot.request_id}`, put(TEXT));
    expect(failed.status).toBe(500);
    expect(service.ctx.store.claimed(slot.request_id)).toBeUndefined();
    host.writeFaults.length = 0;

    const heldAtWrite: boolean[] = [];
    host.writeFaults.push((path) => {
      if (path === FILES_INDEX_PATH) {
        heldAtWrite.push(service.ctx.store.claimed(slot.request_id) !== undefined);
      }
      return null;
    });
    const res = await fetch(`/files/requests/${slot.request_id}`, put(TEXT));
    expect(res.status).toBe(200);
    // The first index write is the one that persists `receiving`.
    expect(heldAtWrite[0]).toBe(true);
  });
});

describe("a commit that loses a brief race (round 2, finding 5)", () => {
  test("waits for the holder to let go instead of answering 409", async () => {
    const { fetch, service } = await filesBox({ delay: () => Bun.sleep(1) });
    const { id } = await stage(fetch, "a.txt");
    const held = service.ctx.store.claim(id);
    const commit = fetch(`/files/${id}/commit`, post({}));
    await Bun.sleep(10);
    held?.release();
    expect((await commit).status).toBe(200);
  });

  test("the sweeper does not claim an entry it has nothing to do with", async () => {
    const { fetch, service } = await filesBox();
    const { id } = await stage(fetch, "a.txt");
    const store = service.ctx.store;
    const claimed: string[] = [];
    const claim = store.claim.bind(store);
    store.claim = (what) => {
      claimed.push(what);
      return claim(what);
    };
    await service.sweep();
    expect(claimed).not.toContain(id);
  });
});

describe("a commit whose index save fails (round 2, finding 6)", () => {
  test("moves the file back to the stage, and a retry commits it", async () => {
    const { fetch, host, index } = await filesBox();
    const { id, stagePath } = await stage(fetch, "a.txt");
    host.writeFaults.push((path) => (path === FILES_INDEX_PATH ? new Error("EIO: i/o error") : null));
    expect((await fetch(`/files/${id}/commit`, post({}))).status).toBe(500);
    expect(host.files.has(stagePath)).toBe(true);
    expect(index().entries[0]).toMatchObject({ id, dir: "stage", path: stagePath });
    host.writeFaults.length = 0;
    const retry = await fetch(`/files/${id}/commit`, post({}));
    expect(retry.status).toBe(200);
    const { path } = (await retry.json()) as { path: string };
    expect(host.files.has(path)).toBe(true);
    expect(index().entries[0]).toMatchObject({ id, dir: "inbox", path });
  });

  test("when even the move back fails, a retry finishes the commit from the inbox", async () => {
    const { fetch, host, index, audit } = await filesBox();
    const { id, stagePath } = await stage(fetch, "secret-plan.txt");
    host.writeFaults.push((path) => (path === FILES_INDEX_PATH ? new Error("EIO: i/o error") : null));
    // Only the move back (inbox → stage) fails.
    const stop = host.when(/mv -n -T/, (argv) =>
      argv.at(-1)?.startsWith(FILES_STAGE_DIR)
        ? { code: 1, stderr: "mv: No space left on device" }
        : null,
    );
    expect((await fetch(`/files/${id}/commit`, post({}))).status).toBe(500);
    expect(host.files.has(stagePath)).toBe(false);
    expect(audit.join("\n")).not.toContain("secret-plan");
    host.writeFaults.length = 0;
    stop();
    const retry = await fetch(`/files/${id}/commit`, post({}));
    expect(retry.status).toBe(200);
    const { path } = (await retry.json()) as { path: string };
    expect(host.files.has(path)).toBe(true);
    expect(index().entries[0]).toMatchObject({ id, dir: "inbox", path });
  });
});

describe("a delete whose removal fails (round 2, finding 7)", () => {
  test("is 500, keeps the entry, and names no path", async () => {
    const { fetch, host, index } = await filesBox();
    const { id, stagePath } = await stage(fetch, "secret-plan.txt");
    host.when(new RegExp(`rm -rf -- \\S*${id}`), {
      code: 1,
      stderr: `rm: cannot remove '${stagePath}': Permission denied`,
    });
    const res = await fetch(`/files/${id}`, { method: "DELETE" });
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain("INTERNAL");
    expect(body).not.toContain("secret-plan");
    expect(index().entries.map((e) => e.id)).toEqual([id]);
  });
});

describe("idle bounds on JSON bodies and downloads (round 2, finding 8)", () => {
  test("a JSON body that stalls is cut off with 408", async () => {
    const { fetch } = await filesBox({ uploadIdleMs: 20 });
    const { id } = await stage(fetch, "a.txt");
    const res = await fetch(`/files/${id}/commit`, {
      method: "POST",
      body: stalledBody(new TextEncoder().encode("{")),
      headers: { "content-length": "10" },
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(408);
  }, 2000);

  test("a download nobody reads is cancelled after the idle bound, and its reader stopped", async () => {
    const { fetch, host } = await filesBox({ uploadIdleMs: 20 });
    const { id } = await stage(fetch, "doc.pdf", PDF);
    const { path } = (await (await fetch(`/files/${id}/commit`, post({}))).json()) as { path: string };
    const res = await fetch(`/files/${id}/content`);
    expect(res.status).toBe(200);
    await Bun.sleep(100);
    expect(host.cancelledReads).toEqual([path]);
    // Cut off short of its Content-Length: the client's length check refuses it.
    expect((await res.arrayBuffer()).byteLength).toBeLessThan(PDF.byteLength);
  });

  test("a download read promptly is whole", async () => {
    const { fetch } = await filesBox({ uploadIdleMs: 20 });
    const { id } = await stage(fetch, "doc.pdf", PDF);
    await fetch(`/files/${id}/commit`, post({}));
    const res = await fetch(`/files/${id}/content`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF);
  });
});

describe("streaming into a child, which error wins (round 2, finding 9)", () => {
  const child = (exited: Promise<number>, flush: () => unknown = () => undefined): PipedChild => ({
    stdin: { write: () => undefined, flush, end: () => undefined },
    stderr: new Response("cat: No space left on device").body as ReadableStream<Uint8Array>,
    exited,
    kill: () => undefined,
  });

  test("the body's own error wins over a child that already exited", async () => {
    const stalled = new FilesError("VALIDATION", "the upload stalled", 408);
    // A body whose first read fails, after the child has already gone.
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          await Bun.sleep(5);
          throw stalled;
        },
      }),
    };
    const err = await pipeIntoChild(child(Promise.resolve(1)), body, "writing as hermes").catch(
      (e: unknown) => e,
    );
    expect(err).toBe(stalled);
  });

  test("a broken pipe reports the child's exit code and stderr", async () => {
    async function* body(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array(16);
    }
    const exited = new Promise<number>((resolve) => setTimeout(() => resolve(2), 5));
    const epipe = () =>
      Promise.reject(Object.assign(new Error("EPIPE: broken pipe"), { code: "EPIPE" }));
    const err = await pipeIntoChild(child(exited, epipe), body(), "writing as hermes").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AgentdError);
    expect((err as Error).message).toMatch(/exited 2: cat: No space left on device/);
  });
});

describe("a move that fails for another reason (round 2, finding 10)", () => {
  test("is 500 INTERNAL, not 409, and the staged file stays", async () => {
    const { fetch, host, index } = await filesBox();
    const { id, stagePath } = await stage(fetch, "a.txt");
    host.when(/mv -n -T/, { code: 1, stderr: "mv: No space left on device" });
    const res = await fetch(`/files/${id}/commit`, post({}));
    expect(res.status).toBe(500);
    expect(await errorCode(res)).toBe("INTERNAL");
    expect(host.files.has(stagePath)).toBe(true);
    expect(index().entries[0]).toMatchObject({ id, dir: "stage" });
  });
});
