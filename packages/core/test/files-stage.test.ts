import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FIXTURE_CONFIG,
  FIXTURE_NO_FILES_AGENT,
  MemoryBackend,
  seedFixtureFleet,
} from "../src/backend/memory.ts";
import { HermeticError } from "../src/errors.ts";
import { UPLOAD_LIMITS, createUploadRegistry } from "../src/files/uploads.ts";
import type { FilesStageEvent } from "../src/schema/index.ts";
import { FILES_LIMITS } from "../src/shared/files.ts";
import { testHermetic } from "./helpers.ts";

/**
 * `files.stage`, the upload registry and the capability probe (§9),
 * over the fixture backend. No network, and no file outside a temp directory.
 */

const dir = mkdtempSync(join(tmpdir(), "hermetic-files-stage-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SECRET_NAME = "FIXTURE-board-minutes-confidential.pdf";
const PDF = new TextEncoder().encode("%PDF-1.7 FIXTURE minutes\n");
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const UPLOAD_ID_RE = /^up_[0-9a-f-]{36}$/;

function open() {
  const backend = seedFixtureFleet(new MemoryBackend());
  return { backend, hermetic: testHermetic({ backend, config: FIXTURE_CONFIG }) };
}

async function drain(events: AsyncIterable<FilesStageEvent>): Promise<FilesStageEvent[]> {
  const seen: FilesStageEvent[] = [];
  for await (const e of events) seen.push(e);
  return seen;
}

async function refusal(run: Promise<unknown>): Promise<HermeticError> {
  try {
    await run;
  } catch (e) {
    if (e instanceof HermeticError) return e;
    throw e;
  }
  throw new Error("expected a refusal");
}

function writeTemp(name: string, bytes: Uint8Array): string {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

describe("the upload registry", () => {
  test("open, append in order, close, take", () => {
    const r = createUploadRegistry();
    const { upload_id } = r.open({ name: "a.txt", size: 6 });
    expect(upload_id).toMatch(UPLOAD_ID_RE);
    expect(r.append(upload_id, 0, new Uint8Array([1, 2, 3]))).toEqual({ received: 3 });
    expect(r.append(upload_id, 3, new Uint8Array([4, 5, 6]))).toEqual({ received: 6 });
    expect(r.close(upload_id)).toEqual({ upload_id, name: "a.txt", size: 6 });
    const src = r.take(upload_id);
    expect(src.kind).toBe("bytes");
    if (src.kind === "bytes") expect([...src.bytes]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("an out-of-order offset, an oversize chunk and an overrun are refused", () => {
    const r = createUploadRegistry();
    const { upload_id } = r.open({ name: "a.txt", size: 4 });
    expect(() => r.append(upload_id, 1, new Uint8Array([1]))).toThrow(/out of order/);
    expect(() => r.append(upload_id, 0, new Uint8Array(5))).toThrow(/past the size/);
    const big = createUploadRegistry({ limits: { chunkBytes: 2 } });
    const id = big.open({ name: "b.txt", size: 10 }).upload_id;
    expect(() => big.append(id, 0, new Uint8Array(3))).toThrow(/at most/);
  });

  test("close refuses an incomplete upload, and take refuses an unclosed one", () => {
    const r = createUploadRegistry();
    const { upload_id } = r.open({ name: "a.txt", size: 4 });
    r.append(upload_id, 0, new Uint8Array(2));
    expect(() => r.close(upload_id)).toThrow(/incomplete/);
    expect(() => r.take(upload_id)).toThrow(/still receiving/);
  });

  test("one upload is capped, and so is everything in flight", () => {
    const r = createUploadRegistry();
    let e: unknown;
    try {
      r.open({ name: "a.bin", size: UPLOAD_LIMITS.uploadBytes + 1 });
    } catch (x) {
      e = x;
    }
    expect((e as HermeticError).code).toBe("FILE_TOO_LARGE");
    for (let i = 0; i < UPLOAD_LIMITS.totalBytes / UPLOAD_LIMITS.uploadBytes; i++) {
      r.open({ name: `a${i}.bin`, size: UPLOAD_LIMITS.uploadBytes });
    }
    expect(r.heldBytes()).toBe(UPLOAD_LIMITS.totalBytes);
    expect(() => r.open({ name: "one-more.bin", size: 1 })).toThrow(/still uploading/);
  });

  test("an idle upload is dropped after the TTL, and discard forgets one", () => {
    let now = 0;
    const r = createUploadRegistry({ now: () => now });
    const a = r.open({ name: "a.txt", size: 1 }).upload_id;
    const b = r.open({ name: "b.txt", size: 1 }).upload_id;
    now = UPLOAD_LIMITS.idleMs - 1;
    r.append(b, 0, new Uint8Array([1]));
    now = UPLOAD_LIMITS.idleMs + 1;
    expect(() => r.append(a, 0, new Uint8Array([1]))).toThrow(/no such upload/);
    expect(r.close(b).size).toBe(1);
    expect(r.discard(b)).toEqual({ discarded: true });
    expect(r.discard(b)).toEqual({ discarded: false });
  });

  test("a bad name is refused by reason, without repeating it", () => {
    const r = createUploadRegistry();
    let e: unknown;
    try {
      r.open({ name: ".env", size: 1 });
    } catch (x) {
      e = x;
    }
    expect((e as HermeticError).code).toBe("FILE_NAME_INVALID");
    expect((e as HermeticError).message).not.toContain(".env");
  });

  test("registerPath records a regular file without reading it", async () => {
    const path = writeTemp("picked.pdf", PDF);
    const r = createUploadRegistry();
    const got = await r.registerPath(path);
    expect(got).toMatchObject({ name: "picked.pdf", size: PDF.byteLength });
    expect(r.take(got.upload_id)).toEqual({
      kind: "path",
      name: "picked.pdf",
      size: PDF.byteLength,
      path,
    });
    expect((await refusal(r.registerPath(join(dir, "missing.pdf")))).code).toBe("NOT_FOUND");
  });
});

describe("files.stage", () => {
  test("a path stages through hash and upload; progress never names the file", async () => {
    const { backend, hermetic } = open();
    const path = writeTemp(SECRET_NAME, PDF);
    const events = await drain(hermetic.files.stage({ instance: "atlas", source: { path } }));
    const last = events.at(-1);
    expect(last?.type).toBe("staged");
    if (last?.type !== "staged") throw new Error("unreachable");
    expect(last.file).toMatchObject({
      name: SECRET_NAME,
      bytes: PDF.byteLength,
      mime: "application/pdf",
    });
    expect(last.file.sha256).toBe(createHash("sha256").update(PDF).digest("hex"));
    expect(backend.files.entry("atlas", last.file.id)?.state).toBe("staged");

    const progress = events.filter((e) => e.type === "progress");
    expect(progress.map((e) => (e.type === "progress" ? e.phase : ""))).toContain("hash");
    expect(progress.map((e) => (e.type === "progress" ? e.phase : ""))).toContain("upload");
    for (const e of progress) expect(JSON.stringify(e)).not.toContain("FIXTURE-board");
  });

  test("a file that shrank after it was picked is refused CONFLICT, not left hanging", async () => {
    const { hermetic } = open();
    const path = writeTemp("FIXTURE-shrinks.pdf", PDF);
    const picked = await hermetic.files.internal.uploads.registerPath(path);
    truncateSync(path, 4);
    const e = await refusal(
      drain(hermetic.files.stage({ instance: "atlas", source: { chunk_upload_id: picked.upload_id } })),
    );
    expect(e.code).toBe("CONFLICT");
    expect(e.message).toContain("changed since it was attached");
  });

  test("an unreadable file is refused FORBIDDEN without repeating its path", async () => {
    const { hermetic } = open();
    const path = writeTemp("FIXTURE-locked.pdf", PDF);
    chmodSync(path, 0o000);
    try {
      const e = await refusal(drain(hermetic.files.stage({ instance: "atlas", source: { path } })));
      expect(e.code).toBe("FORBIDDEN");
      expect(JSON.stringify({ message: e.message, details: e.details })).not.toContain(
        "FIXTURE-locked",
      );
      expect(e.details).toEqual({ errno: "EACCES" });
    } finally {
      chmodSync(path, 0o600);
    }
  });

  test("a chunked upload stages by id, and the registry lets go of it", async () => {
    const { hermetic } = open();
    const uploads = hermetic.files.internal.uploads;
    const { upload_id } = uploads.open({ name: "notes.txt", size: 5 });
    uploads.append(upload_id, 0, new TextEncoder().encode("hello"));
    uploads.close(upload_id);
    const events = await drain(
      hermetic.files.stage({
        instance: "atlas",
        source: { chunk_upload_id: upload_id },
        session: "s1",
      }),
    );
    expect(events.at(-1)).toMatchObject({ type: "staged", file: { name: "notes.txt", bytes: 5 } });
    expect(uploads.discard(upload_id)).toEqual({ discarded: false });
  });

  test("an image over the image cap is refused before a byte is sent", async () => {
    const { backend, hermetic } = open();
    const path = writeTemp("big.png", new Uint8Array(PNG_MAGIC));
    truncateSync(path, FILES_LIMITS.imageBytes + 1);
    let calls = 0;
    const real = backend.files.stage.bind(backend.files);
    backend.files.stage = async (...args) => {
      calls += 1;
      return await real(...args);
    };
    const e = await refusal(drain(hermetic.files.stage({ instance: "atlas", source: { path } })));
    expect(e.code).toBe("FILE_TOO_LARGE");
    expect(e.message).toContain("images can be at most 25.0 MB");
    expect(e.message).not.toContain("big.png");
    expect(calls).toBe(0);
  });

  test("key material is refused locally unless not_secret", async () => {
    const { hermetic } = open();
    const pem = new TextEncoder().encode("-----BEGIN OPENSSH PRIVATE KEY-----\nFIXTURE\n");
    const path = writeTemp("deploy.key", pem);
    const e = await refusal(drain(hermetic.files.stage({ instance: "atlas", source: { path } })));
    expect(e.code).toBe("FILE_LOOKS_SECRET");
    const ok = await drain(
      hermetic.files.stage({ instance: "atlas", source: { path }, not_secret: true }),
    );
    expect(ok.at(-1)?.type).toBe("staged");
  });

  test("the fixture triggers ride on the name override", async () => {
    const { hermetic } = open();
    const path = writeTemp("plain.pdf", PDF);
    const big = await refusal(
      drain(
        hermetic.files.stage({ instance: "atlas", source: { path }, name: "E2E_FILE_TOO_LARGE.pdf" }),
      ),
    );
    expect(big.code).toBe("FILE_TOO_LARGE");
    const digest = await refusal(
      drain(hermetic.files.stage({ instance: "atlas", source: { path }, name: "E2E_FILE_DIGEST.pdf" })),
    );
    expect(digest.code).toBe("FILE_DIGEST_MISMATCH");
  });

  test("input is refused before the stream: bad shape, bad agent name", () => {
    const { hermetic } = open();
    expect(() => hermetic.files.stage({ instance: "atlas", source: {} })).toThrow(HermeticError);
    expect(() => hermetic.files.stage({ instance: "_fleet", source: { path: "/x" } })).toThrow(
      HermeticError,
    );
  });

  test("an unknown agent is NOT_FOUND, and an aborted stage is ABORTED", async () => {
    const { hermetic } = open();
    const path = writeTemp("a.pdf", PDF);
    expect(
      (await refusal(drain(hermetic.files.stage({ instance: "nobody", source: { path } })))).code,
    ).toBe("NOT_FOUND");
    const controller = new AbortController();
    controller.abort();
    const e = await refusal(
      drain(
        hermetic.files.stage({ instance: "atlas", source: { path } }, { signal: controller.signal }),
      ),
    );
    expect(e.code).toBe("ABORTED");
  });

  test("an abort mid-upload stops the transfer", async () => {
    const { backend, hermetic } = open();
    const path = writeTemp("slow.pdf", PDF);
    const controller = new AbortController();
    backend.files.stage = (_name, _upload, opts) =>
      new Promise((_resolve, reject) => {
        opts.signal?.addEventListener("abort", () => reject(new Error("aborted by signal")));
        // The operator stops it while the bytes are in flight.
        controller.abort();
      });
    const e = await refusal(
      drain(
        hermetic.files.stage({ instance: "atlas", source: { path } }, { signal: controller.signal }),
      ),
    );
    expect(e.code).toBe("ABORTED");
  });
});

describe("files.internal", () => {
  test("capability reads /healthz: the fixture's older hermeticd has no files", async () => {
    const { hermetic } = open();
    expect(await hermetic.files.internal.capability("atlas")).toEqual({
      files: true,
      hermeticd_version: "0.6.0",
    });
    expect((await hermetic.files.internal.capability(FIXTURE_NO_FILES_AGENT)).files).toBe(false);
  });

  test("capability is cached, and a box that does not answer reads as no files", async () => {
    const { backend, hermetic } = open();
    let calls = 0;
    const real = backend.rpc.health;
    backend.rpc.health = async (name: string) => {
      calls += 1;
      return await real(name);
    };
    await hermetic.files.internal.capability("atlas");
    await hermetic.files.internal.capability("atlas");
    expect(calls).toBe(1);
    // `lumen` is the fixture's unreachable agent: its /healthz does not answer.
    expect(await hermetic.files.internal.capability("lumen")).toEqual({
      files: false,
      hermeticd_version: null,
    });
  });

  test("commit, content and discard reach the staged entry", async () => {
    const { backend, hermetic } = open();
    const path = writeTemp("chart.png", new Uint8Array([...PNG_MAGIC, 1, 2, 3]));
    const events = await drain(hermetic.files.stage({ instance: "atlas", source: { path } }));
    const staged = events.at(-1);
    if (staged?.type !== "staged") throw new Error("expected a staged event");
    const id = staged.file.id;
    const content = await hermetic.files.internal.content("atlas", id, FILES_LIMITS.imageBytes);
    expect(content.mime).toBe("image/png");
    const committed = await hermetic.files.internal.commit("atlas", id, "s1");
    expect(committed.rel).toMatch(new RegExp(`^inbox/\\d{4}-\\d{2}-\\d{2}/${id}/chart\\.png$`));
    expect(backend.files.committed("atlas").map((e) => e.id)).toEqual([id]);
    expect(await hermetic.files.internal.discard("atlas", id)).toEqual({ discarded: true });
    expect((await refusal(hermetic.files.internal.discard("atlas", id))).code).toBe("FILE_NOT_FOUND");
  });

  test("like the box: a repeated commit answers the first under any session; an expired entry is gone", async () => {
    const { backend, hermetic } = open();
    const stageOne = async (): Promise<string> => {
      const events = await drain(
        hermetic.files.stage({ instance: "atlas", source: { path: writeTemp("again.pdf", PDF) } }),
      );
      const last = events.at(-1);
      if (last?.type !== "staged") throw new Error("expected a staged event");
      return last.file.id;
    };
    const id = await stageOne();
    const first = await hermetic.files.internal.commit("atlas", id, "s1");
    expect(await hermetic.files.internal.commit("atlas", id, "s2")).toEqual(first);

    const old = await stageOne();
    const entry = backend.files.entry("atlas", old);
    if (!entry) throw new Error("expected the entry");
    entry.expires_at = "2000-01-01T00:00:00.000Z";
    const gone = await refusal(hermetic.files.internal.content("atlas", old, FILES_LIMITS.fileBytes));
    expect(gone.code).toBe("FILE_NOT_FOUND");
    expect(backend.files.entry("atlas", old)).toBeUndefined();
  });

  test("content with imagesOnly refuses a non-image", async () => {
    const { hermetic } = open();
    const events = await drain(
      hermetic.files.stage({ instance: "atlas", source: { path: writeTemp("notes.pdf", PDF) } }),
    );
    const last = events.at(-1);
    if (last?.type !== "staged") throw new Error("expected a staged event");
    const e = await refusal(
      hermetic.files.internal.content("atlas", last.file.id, FILES_LIMITS.imageBytes, {
        imagesOnly: true,
      }),
    );
    expect(e.code).toBe("FILE_TYPE_REJECTED");
  });
});
