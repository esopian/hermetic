/**
 * The files service's seam: the documents the laptop writes and hermeticd
 * reads, and the socket replies hermeticd writes and the Hermes plugin reads.
 *
 * A stage upload is built here the way a laptop client builds it
 * (`FILES_ROUTES`, `formatContentDigest`) and taken apart the way hermeticd
 * will (`matchFilesRoute`, `parseContentDigest`, `sanitizeFileName`), so the
 * two halves cannot drift without this file failing. Every schema is
 * round-tripped through JSON. `tests/fixtures/files/*.json` are the socket
 * replies the Python plugin is checked against; they must parse here too.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CONTENT_DIGEST_HEADER,
  FILES_DROP_DIR,
  FILES_INBOX_DIR,
  FILES_ROUTES,
  FILES_SECRET_DIR,
  FILES_SESSION_HEADER,
  FILES_SOCKET_ROUTES,
  SECRET_ENVELOPE_MAX_CHARS,
  decodeSecretEnvelope,
  encodeSecretEnvelope,
  formatContentDigest,
  matchFilesRoute,
  matchSocketRoute,
  FILES_SECRET_AS_HEADER,
  parseContentDigest,
  sanitizeFileName,
  secretTextLoad,
  secretEnvelopeFits,
  sniffMime,
} from "../packages/core/src/shared/index.ts";
import {
  FileEntry,
  FileRequest,
  FileWaitResult,
  FilesCommitBody,
  FilesCommitResult,
  FilesDeclineBody,
  FilesErrorBody,
  FilesFulfilResult,
  FilesHello,
  FilesListResult,
  FilesSecretBody,
  FilesStageResult,
  OpenFileRequestBody,
  OpenSecretRequestBody,
  RpcHealth,
  ShareFileBody,
  ShareFileResult,
} from "../packages/core/src/schema/index.ts";

import { PDF, filesBox, openSlot, post, put } from "../packages/agentd/test/files-fixture.ts";

const FIXTURES = join(import.meta.dir, "fixtures/files");
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
/** The two calls this file makes on a schema; root `tests/` does not depend on zod itself. */
type Schema = { parse(v: unknown): unknown; safeParse(v: unknown): { success: boolean } };

const NOW = "2026-10-13T17:42:00Z";
const LATER = "2026-10-13T19:42:00Z";

describe("stage upload: laptop builds, hermeticd parses", () => {
  test("path, digest and session header survive the trip", () => {
    const body = new TextEncoder().encode("-----BEGIN CERTIFICATE-----\nMIIB\n");
    const digest = sha(body);
    // The laptop side.
    const req = new Request(`http://sindri:7434${FILES_ROUTES.stage("Résumé (final).pem")}`, {
      method: "PUT",
      headers: {
        "content-length": String(body.length),
        [CONTENT_DIGEST_HEADER]: formatContentDigest(digest),
        [FILES_SESSION_HEADER]: "20261013_120000_abcdef",
      },
      body,
    });
    // The box side.
    const url = new URL(req.url);
    const route = matchFilesRoute(req.method, url.pathname + url.search);
    expect(route).toEqual({ route: "stage", name: "Résumé (final).pem" });
    if (route?.route !== "stage") throw new Error("unreachable");
    expect(sanitizeFileName(route.name)).toEqual({ ok: true, name: "Résumé (final).pem" });
    expect(parseContentDigest(req.headers.get(CONTENT_DIGEST_HEADER))).toBe(digest);
    expect(req.headers.get(FILES_SESSION_HEADER)).toBe("20261013_120000_abcdef");
    expect(sniffMime(body, route.name)).toBe("application/x-pem-file");
  });

  test("a traversal name arrives as one segment and leaves as a basename", () => {
    const url = new URL(`http://sindri:7434${FILES_ROUTES.stage("../../etc/passwd")}`);
    const route = matchFilesRoute("PUT", url.pathname);
    expect(route).toEqual({ route: "stage", name: "../../etc/passwd" });
    expect(sanitizeFileName("../../etc/passwd")).toEqual({ ok: true, name: "passwd" });
  });

  test("a fulfil and a socket wait cross the same way", () => {
    const rid = "fr_7k2m4p9q3f9a";
    const put = new URL(`http://sindri:7434${FILES_ROUTES.request(rid)}`);
    expect(matchFilesRoute("PUT", put.pathname)).toEqual({ route: "fulfil", id: rid });
    const wait = new URL(`http://localhost${FILES_SOCKET_ROUTES.wait(rid, 25)}`);
    expect(matchSocketRoute("GET", wait.pathname + wait.search)).toEqual({
      route: "wait",
      id: rid,
      s: 25,
    });
  });
});

describe("commit: hermeticd answers, the laptop parses", () => {
  // The box's real routes (`packages/agentd`), over its in-memory host; each
  // answer goes through the schema core reads it with (`aws/files-http.ts`).
  test("stage and commit answers parse as core's FilesStageResult and FilesCommitResult", async () => {
    const box = await filesBox();
    const staged = await box.fetch(
      FILES_ROUTES.stage("chart notes.pdf"),
      put(PDF, {
        [FILES_SESSION_HEADER]: "20261013_120000_abcdef",
      }),
    );
    expect(staged.status).toBe(201);
    const stage = FilesStageResult.parse(await staged.json());
    const first = await box.fetch(
      FILES_ROUTES.commit(stage.id),
      post({ session_id: "20261013_120000_abcdef" }),
    );
    expect(first.ok).toBe(true);
    const commit = FilesCommitResult.parse(await first.json());
    expect(commit).toMatchObject({ id: stage.id, name: "chart notes.pdf", mime: "application/pdf" });
    expect(commit.rel).toMatch(/^inbox\/\d{4}-\d{2}-\d{2}\/f_[a-z0-9]{12}\/chart notes\.pdf$/);
    // A second commit — under any session — answers what the first did; the
    // fixture (`memory-files.ts`) is held to the same.
    const again = await box.fetch(FILES_ROUTES.commit(stage.id), post({ session_id: "other" }));
    expect(FilesCommitResult.parse(await again.json())).toEqual(commit);
  });
});

describe("every schema survives JSON", () => {
  const entry: FileEntry = {
    id: "f_abcdefghijkl",
    dir: "inbox",
    class: "image",
    name: "chart.png",
    bytes: 48213,
    mime: "image/png",
    sha256: sha("chart"),
    created_at: NOW,
    expires_at: LATER,
    rel: "inbox/2026-10-13/f_abcdefghijkl/chart.png",
    path: "/data/hermes/.hermes/inbox/2026-10-13/f_abcdefghijkl/chart.png",
    from: { kind: "operator", login: "evan@example.com", node: "evans-mbp" },
    session_id: "20261013_120000_abcdef",
  };
  const secret: FileEntry = {
    id: "f_mnopqrstuvwx",
    dir: "secret",
    class: "secret",
    name: "github-app.pem",
    bytes: 1679,
    mime: "application/x-pem-file",
    sha256: sha("key"),
    created_at: NOW,
    expires_at: null,
    path: "/run/hermetic/files/github-app-pem",
    from: { kind: "operator", login: "evan@example.com", node: "evans-mbp" },
    request_id: "fr_7k2m4p9q3f9a",
    slot: "file-github-app-pem",
  };
  const share: FileEntry = {
    id: "sh_q3f9a7k2m4p9",
    dir: "outbox",
    class: "file",
    name: "report.csv",
    bytes: 12,
    mime: "text/csv",
    sha256: sha("csv"),
    created_at: NOW,
    expires_at: LATER,
    rel: "outbox/sh_q3f9a7k2m4p9/report.csv",
    from: { kind: "agent" },
    note: "the numbers you asked for",
  };
  const request: FileRequest = {
    request_id: "fr_7k2m4p9q3f9a",
    kind: "file",
    purpose: "The GitHub App private key.",
    name_hint: "github-app.pem",
    accept: ["application/x-pem-file", ".pem"],
    max_bytes: 4096,
    sensitivity: "secret",
    durable: true,
    state: "fulfilled",
    created_at: NOW,
    expires_at: LATER,
    session_id: "20261013_120000_abcdef",
    fulfilled: {
      path: "/run/hermetic/files/github-app-pem",
      sha256: sha("key"),
      bytes: 1679,
      by: "evan@example.com",
      at: NOW,
      class: "secret",
    },
    rejected: { code: "FILE_TYPE_REJECTED", message: "image/png is not in accept", at: NOW },
  };
  const secretText: FileRequest = {
    ...request,
    request_id: "fr_aaaabbbbcccc",
    kind: "secret_text",
    state: "declined",
    keys: ["GITHUB_TOKEN"],
    optional_keys: ["GITHUB_ORG"],
    fulfilled: undefined,
    declined: { reason: "not today", at: NOW },
  };

  const cases: Array<[string, Schema, unknown]> = [
    ["FileEntry (image)", FileEntry, entry],
    ["FileEntry (durable secret)", FileEntry, secret],
    ["FileEntry (share)", FileEntry, share],
    ["FileRequest", FileRequest, request],
    ["FileRequest (secret_text)", FileRequest, secretText],
    [
      "FilesStageResult",
      FilesStageResult,
      {
        id: "f_abcdefghijkl",
        name: "chart.png",
        bytes: 48213,
        mime: "image/png",
        sha256: sha("chart"),
        class: "image",
        expires_at: LATER,
      },
    ],
    ["FilesCommitBody", FilesCommitBody, { session_id: "20261013_120000_abcdef" }],
    ["FilesCommitBody (empty)", FilesCommitBody, {}],
    [
      "FilesCommitResult",
      FilesCommitResult,
      {
        id: "f_abcdefghijkl",
        path: entry.path,
        rel: entry.rel,
        name: entry.name,
        bytes: entry.bytes,
        mime: entry.mime,
        sha256: entry.sha256,
        class: entry.class,
      },
    ],
    [
      "FilesFulfilResult",
      FilesFulfilResult,
      {
        request_id: "fr_7k2m4p9q3f9a",
        path: "/run/hermetic/drop/fr_7k2m4p9q3f9a/a.pem",
        sha256: sha("key"),
        bytes: 1679,
        class: "secret",
      },
    ],
    ["FilesSecretBody", FilesSecretBody, { ssm_slot: "file-github-app-pem", name: "github-app.pem" }],
    ["FilesDeclineBody", FilesDeclineBody, { reason: "wrong agent" }],
    [
      "FilesListResult",
      FilesListResult,
      {
        inbox: [entry],
        outbox: [share],
        secrets: [secret],
        requests: [request, secretText],
        usage: { inbox_bytes: 48213, outbox_bytes: 12, disk_used_pct: 41.5, retention_days: 7 },
      },
    ],
    ["FilesErrorBody", FilesErrorBody, { error: { code: "FILE_TOO_LARGE", message: "over 25 MiB" } }],
    ["FilesHello", FilesHello, { hermeticd_version: "0.1.42", protocol: 1 }],
    ["OpenFileRequestBody", OpenFileRequestBody, { purpose: "a csv", accept: [".csv"], wait_s: 30 }],
    [
      "FileWaitResult",
      FileWaitResult,
      { status: "open", request_id: "fr_7k2m4p9q3f9a", deliver_with: [], expires_at: LATER },
    ],
    ["ShareFileBody", ShareFileBody, { path: "/data/hermes/out/chart.png", note: "done" }],
    [
      "ShareFileResult",
      ShareFileResult,
      { share_id: "sh_q3f9a7k2m4p9", name: "chart.png", bytes: 1, mime: "image/png", sha256: sha("x") },
    ],
    [
      "RpcHealth (with capabilities)",
      RpcHealth,
      { name: "sindri", hermeticd_version: "0.1.42", protocol: 1, capabilities: ["files"] },
    ],
  ];
  for (const [label, schema, value] of cases) {
    test(label, () => {
      const wire = JSON.parse(JSON.stringify(value));
      expect(schema.parse(wire)).toEqual(wire);
    });
  }

  test("an older hermeticd's health, without capabilities, still parses", () => {
    expect(
      RpcHealth.parse({ name: "sindri", hermeticd_version: "0.1.0", protocol: 1 }).capabilities,
    ).toBe(undefined);
  });

  test("stored names and ids are held to the shared rules", () => {
    expect(FileEntry.safeParse({ ...entry, name: ".env" }).success).toBe(false);
    expect(FileEntry.safeParse({ ...entry, name: "a/b.png" }).success).toBe(false);
    expect(FileEntry.safeParse({ ...entry, id: "fr_7k2m4p9q3f9a" }).success).toBe(false);
    expect(FileRequest.safeParse({ ...request, request_id: "f_abcdefghijkl" }).success).toBe(false);
  });

  test("the plugin's request body drops model extras and clamps the wait", () => {
    const body = OpenFileRequestBody.parse({ purpose: "x", wait_s: 600, chatter: "ignored" });
    expect(body).toEqual({ purpose: "x", wait_s: 290 });
    expect(OpenFileRequestBody.safeParse({ purpose: "" }).success).toBe(false);
    expect(OpenFileRequestBody.safeParse({ purpose: "x".repeat(2001) }).success).toBe(false);
    expect(FilesDeclineBody.safeParse({ reason: "x".repeat(501) }).success).toBe(false);
  });
});

describe("socket fixtures the plugin reads", () => {
  const read = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
  const schemas: Record<string, Schema> = {
    "hello.json": FilesHello,
    "wait-pending.json": FileWaitResult,
    "wait-fulfilled.json": FileWaitResult,
    "wait-declined.json": FileWaitResult,
    "share-result.json": ShareFileResult,
    "open-request.json": OpenFileRequestBody,
    "open-secret-request.json": OpenSecretRequestBody,
    "wait-secret-fulfilled.json": FileWaitResult,
    "wait-secret-file-fulfilled.json": FileWaitResult,
    "error.json": FilesErrorBody,
  };

  test("every fixture has a schema, and every schema's fixture is there", () => {
    const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".json"));
    expect(files.sort()).toEqual(Object.keys(schemas).sort());
  });

  for (const [name, schema] of Object.entries(schemas)) {
    test(`${name} parses`, () => {
      expect(schema.safeParse(read(name)).success).toBe(true);
    });
  }

  test("pending carries its fallbacks, fulfilled its path and digest, declined neither", () => {
    const pending = FileWaitResult.parse(read("wait-pending.json"));
    expect(pending.status).toBe("pending");
    expect(pending.deliver_with.length).toBeGreaterThan(0);
    for (const line of pending.deliver_with) expect(line).toContain(pending.request_id);
    const fulfilled = FileWaitResult.parse(read("wait-fulfilled.json"));
    expect(fulfilled.status).toBe("fulfilled");
    expect(fulfilled.path).toBeDefined();
    expect(fulfilled.class).toBe("file");
    expect(fulfilled.path).toMatch(
      new RegExp(`^${FILES_INBOX_DIR}/\\d{4}-\\d{2}-\\d{2}/f_[a-z0-9]{12}/[^/]+$`),
    );
    expect(fulfilled.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fulfilled.bytes).toBeGreaterThan(0);
    const declined = FileWaitResult.parse(read("wait-declined.json"));
    expect(declined.status).toBe("declined");
    expect(declined.path).toBeUndefined();
  });

  test("the open-request fixture's extra field is dropped, not refused", () => {
    const body = OpenFileRequestBody.parse(read("open-request.json"));
    expect("model_extra" in body).toBe(false);
  });

  test("hermeticd opens a text-secret slot from the plugin's request_secret body", async () => {
    const { socket, index } = await filesBox();
    const fixture = read("open-secret-request.json");
    expect("model_extra" in OpenSecretRequestBody.parse(fixture)).toBe(false);
    const text = JSON.stringify({ ...fixture, wait_s: 0 });
    const res = await socket("/requests", {
      method: "POST",
      body: text,
      headers: { "content-type": "application/json", "content-length": String(text.length) },
    });
    expect(res.status).toBe(201);
    const opened = FileWaitResult.parse(await res.json());
    expect(opened.deliver_with).toEqual([
      `hermetic files put research-1 --request ${opened.request_id} --secret-stdin`,
    ]);
    expect(index().requests[0]).toMatchObject({
      kind: "secret_text",
      keys: fixture.keys,
      optional_keys: fixture.optional_keys,
      slug: "github",
    });
  });

  test("hermeticd's text-secret wait result has the fixture's shape: names and a load line, no value", async () => {
    const { socket, fetch } = await filesBox();
    const opened = await socket(
      "/requests",
      post({ kind: "secret_text", purpose: "a token", keys: ["GITHUB_TOKEN"] }),
    );
    const { request_id } = FileWaitResult.parse(await opened.json());
    const value = new TextEncoder().encode("GITHUB_TOKEN=FIXTURE-seam\n");
    const filled = await fetch(
      `/files/requests/${request_id}`,
      put(value, { [FILES_SECRET_AS_HEADER]: "auto" }),
    );
    expect(filled.status).toBe(200);
    const raw = await (await socket(`/requests/${request_id}/wait?s=0`)).text();
    expect(raw).not.toContain("FIXTURE");
    const live = FileWaitResult.parse(JSON.parse(raw));
    const fixture = FileWaitResult.parse(read("wait-secret-fulfilled.json"));
    expect(Object.keys(live).sort()).toEqual(Object.keys(fixture).sort());
    expect(live.load).toBe(secretTextLoad(live.path as string));
    expect(fixture.load).toBe(secretTextLoad(fixture.path as string));
    expect(live.keys).toEqual(fixture.keys);
    expect(live.format).toBe(fixture.format);
  });
});

describe("the box's file wait results have the fixtures' shape", () => {
  const read = (name: string) =>
    FileWaitResult.parse(JSON.parse(readFileSync(join(FIXTURES, name), "utf8")));
  const keys = (v: object) => Object.keys(v).sort();

  test("a normal file: path under the inbox, digest and size", async () => {
    const { socket, fetch } = await filesBox();
    const { request_id } = await openSlot(socket);
    expect((await fetch(`/files/requests/${request_id}`, put(PDF))).status).toBe(200);
    const live = FileWaitResult.parse(await (await socket(`/requests/${request_id}/wait?s=0`)).json());
    const fixture = read("wait-fulfilled.json");
    expect(keys(live)).toEqual(keys(fixture));
    expect(live.class).toBe(fixture.class);
    expect(live.path?.startsWith(`${FILES_INBOX_DIR}/`)).toBe(true);
    expect(live.sha256).toBe(sha(PDF));
    expect(live.bytes).toBe(PDF.byteLength);
  });

  test("a secret file: a path under the drop or secret dir, no digest, no size", async () => {
    const { socket, fetch } = await filesBox();
    const { request_id } = await openSlot(socket, { sensitivity: "secret" });
    expect((await fetch(`/files/requests/${request_id}`, put(PDF))).status).toBe(200);
    const raw = await (await socket(`/requests/${request_id}/wait?s=0`)).text();
    expect(raw).not.toContain(sha(PDF));
    const live = FileWaitResult.parse(JSON.parse(raw));
    const fixture = read("wait-secret-file-fulfilled.json");
    expect(keys(live)).toEqual(keys(fixture));
    expect(live.class).toBe("secret");
    // A laptop upload lands under the drop dir; a durable (SSM) one under the secret dir.
    expect(
      live.path?.startsWith(`${FILES_DROP_DIR}/`) || live.path?.startsWith(`${FILES_SECRET_DIR}/`),
    ).toBe(true);
    expect(fixture.path?.startsWith(`${FILES_SECRET_DIR}/`)).toBe(true);
    expect(fixture.sha256).toBeUndefined();
    expect(fixture.bytes).toBeUndefined();
  });
});

describe("durable secret envelope: laptop writes SSM, hermeticd reads it", () => {
  test("round-trips binary content, name and digest", () => {
    const bytes = new Uint8Array(1200);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37) & 0xff;
    const text = encodeSecretEnvelope({ name: "client.p12", bytes, sha256: sha(bytes) });
    expect(Object.keys(JSON.parse(text))).toEqual(["v", "name", "sha256", "b64"]);
    expect(text.length).toBeLessThanOrEqual(SECRET_ENVELOPE_MAX_CHARS);
    expect(secretEnvelopeFits("client.p12", bytes.length)).toBe(true);
    const back = decodeSecretEnvelope(text);
    expect(back?.name).toBe("client.p12");
    expect(back?.sha256).toBe(sha(bytes));
    expect(back ? sha(back.bytes) : null).toBe(sha(bytes));
  });

  test("secretEnvelopeFits agrees with the real encoding at the edge", () => {
    const name = "github-app.pem";
    let fits = 0;
    for (let n = 2900; n < 3100; n++) {
      const bytes = new Uint8Array(n);
      const encoded = encodeSecretEnvelope({ name, bytes, sha256: sha(bytes) });
      const real = new TextEncoder().encode(encoded).length <= SECRET_ENVELOPE_MAX_CHARS;
      expect(secretEnvelopeFits(name, n)).toBe(real);
      if (real) fits = n;
    }
    // The cap is the envelope, so a 4 KiB file does not fit; ~3 KiB does.
    expect(fits).toBeGreaterThan(2900);
    expect(secretEnvelopeFits(name, 4096)).toBe(false);
  });

  test("anything malformed decodes to null", () => {
    const ok = JSON.parse(
      encodeSecretEnvelope({ name: "a.pem", bytes: new Uint8Array([1]), sha256: sha("a") }),
    );
    for (const bad of [
      "not json",
      "null",
      "[]",
      JSON.stringify({ ...ok, v: 2 }),
      JSON.stringify({ ...ok, name: ".env" }),
      JSON.stringify({ ...ok, name: "../a.pem" }),
      JSON.stringify({ ...ok, sha256: "nothex" }),
      JSON.stringify({ ...ok, b64: "!!!" }),
      JSON.stringify({ v: 1, name: "a.pem", sha256: ok.sha256 }),
    ]) {
      expect(decodeSecretEnvelope(bad)).toBeNull();
    }
    expect(() => encodeSecretEnvelope({ name: "a", bytes: new Uint8Array(), sha256: "x" })).toThrow();
  });
});
