import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { HermeticdFiles } from "../src/aws/files-http.ts";
import { MemoryBackend, seedFixtureFleet } from "../src/backend/memory.ts";
import {
  E2E_FILE_DIGEST,
  E2E_FILE_TOO_LARGE,
  MemoryFiles,
} from "../src/backend/fixture/memory-files.ts";
import type { AgentStore } from "../src/backend/types.ts";
import { HermeticError } from "../src/errors.ts";
import {
  CONTENT_DIGEST_HEADER,
  FILES_SESSION_HEADER,
  HERMETICD_RPC_PORT,
  formatContentDigest,
} from "../src/schema/index.ts";
import {
  FILES_NAME_HEADER,
  FILES_NOT_SECRET_HEADER,
  FILES_SECRET_AS_HEADER,
} from "../src/shared/files.ts";

/**
 * The laptop's hermeticd files client (`aws/files-http.ts`) against an injected
 * fetch, and the fixture store (`fixture/memory-files.ts`) that stands in for
 * it. No network: every response here is built in the test.
 */

const SECRET_NAME = "FIXTURE-quarterly-layoffs.pdf";
const BYTES = new TextEncoder().encode("%PDF-1.7 FIXTURE body\n");
const SHA = createHash("sha256").update(BYTES).digest("hex");
const AT = "2026-10-13T12:00:00.000Z";

function agentStore(): AgentStore {
  return seedFixtureFleet(new MemoryBackend()).store.agents;
}

function staged(): Record<string, unknown> {
  return {
    id: "f_abcdefabcdef",
    name: SECRET_NAME,
    bytes: BYTES.byteLength,
    mime: "application/pdf",
    sha256: SHA,
    class: "file",
    expires_at: AT,
  };
}

function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type FetchHang = (url: string, init?: RequestInit) => Promise<Response>;

async function refusal(run: Promise<unknown>): Promise<HermeticError> {
  try {
    await run;
  } catch (e) {
    if (e instanceof HermeticError) return e;
    throw e;
  }
  throw new Error("expected a refusal");
}

async function* chunks(...parts: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const p of parts) yield p;
}

describe("HermeticdFiles.stage", () => {
  test("PUTs to the agent's stage route with length, digest and the optional headers", async () => {
    let seen: { url: string; init: RequestInit | undefined } | null = null;
    let body = new Uint8Array();
    const files = new HermeticdFiles(agentStore(), {
      fetch: async (url, init) => {
        seen = { url, init };
        const parts: Uint8Array[] = [];
        const stream = (init as RequestInit).body as unknown as AsyncIterable<Uint8Array>;
        for await (const c of stream) parts.push(c);
        body = new Uint8Array(Buffer.concat(parts));
        return new Response(JSON.stringify(staged()), { status: 201 });
      },
    });
    const progress: number[] = [];
    const result = await files.stage(
      "atlas",
      {
        fileName: SECRET_NAME,
        size: BYTES.byteLength,
        body: chunks(BYTES.subarray(0, 5), BYTES.subarray(5)),
        sha256: SHA,
        sessionId: "sess-1",
        notSecret: true,
      },
      { onProgress: (n) => progress.push(n) },
    );
    expect(result.id).toBe("f_abcdefabcdef");
    const call = seen as unknown as { url: string; init: RequestInit };
    expect(call.url).toBe(
      `http://100.64.12.4:${HERMETICD_RPC_PORT}/files/stage/${encodeURIComponent(SECRET_NAME)}`,
    );
    expect(call.init.method).toBe("PUT");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["content-length"]).toBe(String(BYTES.byteLength));
    expect(headers[CONTENT_DIGEST_HEADER]).toBe(formatContentDigest(SHA));
    expect(headers[FILES_SESSION_HEADER]).toBe("sess-1");
    expect(headers[FILES_NOT_SECRET_HEADER]).toBe("1");
    expect(body).toEqual(BYTES);
    expect(progress.at(-1)).toBe(BYTES.byteLength);
  });

  const cases: Array<[number, string]> = [
    [413, "FILE_TOO_LARGE"],
    [422, "FILE_DIGEST_MISMATCH"],
    [410, "FILE_REQUEST_EXPIRED"],
    [507, "DISK_FULL"],
    [409, "FILE_LOOKS_SECRET"],
  ];
  for (const [status, code] of cases) {
    test(`${status} ${code} becomes that code, readable, without the file's name`, async () => {
      const files = new HermeticdFiles(agentStore(), {
        // The box's own message names the file: it must not survive.
        fetch: async () => errorResponse(status, code, `refused ${SECRET_NAME}`),
      });
      const e = await refusal(
        files.stage(
          "atlas",
          { fileName: SECRET_NAME, size: BYTES.byteLength, body: BYTES, sha256: SHA },
          {},
        ),
      );
      expect(e.code).toBe(code as HermeticError["code"]);
      expect(e.message).toContain("atlas");
      expect(e.message).not.toContain(SECRET_NAME);
      expect(e.message.length).toBeGreaterThan(20);
    });
  }

  test("a status without a files body still maps by status", async () => {
    const files = new HermeticdFiles(agentStore(), {
      fetch: async () => new Response("<html>bad gateway</html>", { status: 507 }),
    });
    const e = await refusal(
      files.stage("atlas", { fileName: "a.txt", size: 1, body: new Uint8Array([1]), sha256: SHA }, {}),
    );
    expect(e.code).toBe("DISK_FULL");
  });

  test("an older hermeticd's 404 reads as unsupported, with what to do", async () => {
    const files = new HermeticdFiles(agentStore(), {
      fetch: async () => new Response("not found", { status: 404 }),
    });
    const e = await refusal(
      files.stage("atlas", { fileName: "a.txt", size: 1, body: new Uint8Array([1]), sha256: SHA }, {}),
    );
    expect(e.code).toBe("UNSUPPORTED");
    expect(e.message).toContain("artifacts push");
  });

  test("an unknown box code is scrubbed of the name and typed by status", async () => {
    const files = new HermeticdFiles(agentStore(), {
      fetch: async () => errorResponse(500, "SOMETHING_NEW", `broke on ${SECRET_NAME}`),
    });
    const e = await refusal(
      files.stage(
        "atlas",
        { fileName: SECRET_NAME, size: 1, body: new Uint8Array([1]), sha256: SHA },
        {},
      ),
    );
    expect(e.code).toBe("INTERNAL");
    expect(e.message).not.toContain(SECRET_NAME);
  });

  test("an aborted transfer is ABORTED, not a dead box", async () => {
    const controller = new AbortController();
    const files = new HermeticdFiles(agentStore(), {
      fetch: async () => {
        controller.abort();
        throw new Error("The operation was aborted");
      },
    });
    const e = await refusal(
      files.stage(
        "atlas",
        { fileName: "a.txt", size: 1, body: new Uint8Array([1]), sha256: SHA },
        { signal: controller.signal },
      ),
    );
    expect(e.code).toBe("ABORTED");
  });
});

describe("HermeticdFiles.content", () => {
  function contentResponse(body: BodyInit, headers: Record<string, string>): Response {
    return new Response(body, { status: 200, headers });
  }

  test("returns the bytes when length and digest both match", async () => {
    const files = new HermeticdFiles(agentStore(), {
      fetch: async (url) => {
        expect(url.endsWith("/files/f_abcdefabcdef/content")).toBe(true);
        return contentResponse(BYTES, {
          "content-type": "application/pdf",
          "content-length": String(BYTES.byteLength),
          [CONTENT_DIGEST_HEADER]: formatContentDigest(SHA),
        });
      },
    });
    const got = await files.content("atlas", "f_abcdefabcdef", { maxBytes: 1024 });
    expect(got.bytes).toEqual(BYTES);
    expect(got.mime).toBe("application/pdf");
    expect(got.sha256).toBe(SHA);
  });

  test("a body that ends short is a digest mismatch, not a smaller file", async () => {
    const files = new HermeticdFiles(agentStore(), {
      fetch: async () => {
        const res = contentResponse(BYTES.subarray(0, 4), {
          "content-type": "application/pdf",
          [CONTENT_DIGEST_HEADER]: formatContentDigest(SHA),
        });
        // `Response` recomputes Content-Length from a byte body; the box's
        // header promised the whole file.
        Object.defineProperty(res, "headers", {
          value: new Headers({
            "content-type": "application/pdf",
            "content-length": String(BYTES.byteLength),
            [CONTENT_DIGEST_HEADER]: formatContentDigest(SHA),
          }),
        });
        return res;
      },
    });
    const e = await refusal(files.content("atlas", "f_abcdefabcdef", { maxBytes: 1024 }));
    expect(e.code).toBe("FILE_DIGEST_MISMATCH");
  });

  test("a stream that errors mid-body is a digest mismatch", async () => {
    let sent = false;
    const files = new HermeticdFiles(agentStore(), {
      fetch: async () =>
        contentResponse(
          new ReadableStream<Uint8Array>({
            pull(c) {
              if (sent) c.error(new Error("socket closed"));
              else {
                sent = true;
                c.enqueue(BYTES.subarray(0, 4));
              }
            },
          }),
          { [CONTENT_DIGEST_HEADER]: formatContentDigest(SHA) },
        ),
    });
    const e = await refusal(files.content("atlas", "f_abcdefabcdef", { maxBytes: 1024 }));
    expect(e.code).toBe("FILE_DIGEST_MISMATCH");
  });

  test("bytes that do not hash to the digest are refused", async () => {
    const files = new HermeticdFiles(agentStore(), {
      fetch: async () =>
        contentResponse(new TextEncoder().encode("%PDF-1.7 tampered\n"), {
          [CONTENT_DIGEST_HEADER]: formatContentDigest(SHA),
        }),
    });
    const e = await refusal(files.content("atlas", "f_abcdefabcdef", { maxBytes: 1024 }));
    expect(e.code).toBe("FILE_DIGEST_MISMATCH");
  });

  test("a stop mid-body is ABORTED, not a digest mismatch", async () => {
    const controller = new AbortController();
    let sent = false;
    const files = new HermeticdFiles(agentStore(), {
      fetch: async () =>
        contentResponse(
          new ReadableStream<Uint8Array>({
            pull(c) {
              if (sent) {
                controller.abort();
                c.error(new Error("aborted"));
              } else {
                sent = true;
                c.enqueue(BYTES.subarray(0, 4));
              }
            },
          }),
          { [CONTENT_DIGEST_HEADER]: formatContentDigest(SHA) },
        ),
    });
    const e = await refusal(
      files.content("atlas", "f_abcdefabcdef", { maxBytes: 1024, signal: controller.signal }),
    );
    expect(e.code).toBe("ABORTED");
  });

  test("an image purpose refuses a non-image from its Content-Type, without reading the body", async () => {
    let pulled = false;
    const files = new HermeticdFiles(agentStore(), {
      fetch: async () =>
        contentResponse(
          new ReadableStream<Uint8Array>(
            {
              pull(c) {
                pulled = true;
                c.enqueue(BYTES);
                c.close();
              },
            },
            // No read ahead: a pull is a read.
            { highWaterMark: 0 },
          ),
          { "content-type": "application/pdf", [CONTENT_DIGEST_HEADER]: formatContentDigest(SHA) },
        ),
    });
    const e = await refusal(
      files.content("atlas", "f_abcdefabcdef", { maxBytes: 1024, purpose: "image" }),
    );
    expect(e.code).toBe("FILE_TYPE_REJECTED");
    expect(pulled).toBe(false);
  });

  test("an entry over maxBytes is refused before its body is read", async () => {
    const files = new HermeticdFiles(agentStore(), {
      fetch: async () =>
        contentResponse(BYTES, {
          "content-length": String(BYTES.byteLength),
          [CONTENT_DIGEST_HEADER]: formatContentDigest(SHA),
        }),
    });
    const e = await refusal(files.content("atlas", "f_abcdefabcdef", { maxBytes: 4 }));
    expect(e.code).toBe("FILE_TOO_LARGE");
  });
});

describe("HermeticdFiles.commit and remove", () => {
  test("commit POSTs the session and returns the inbox path", async () => {
    let body = "";
    const files = new HermeticdFiles(agentStore(), {
      fetch: async (_url, init) => {
        body = String(init?.body);
        return new Response(
          JSON.stringify({
            id: "f_abcdefabcdef",
            path: "/data/x",
            rel: "inbox/2026-10-13/f_abcdefabcdef/a.pdf",
            name: "a.pdf",
            bytes: 12,
            mime: "application/pdf",
            sha256: "a".repeat(64),
            class: "file",
          }),
        );
      },
    });
    const got = await files.commit("atlas", "f_abcdefabcdef", { session_id: "s1" }, {});
    expect(JSON.parse(body)).toEqual({ session_id: "s1" });
    expect(got.rel).toContain("inbox/");
  });

  test("a commit answer from an older hermeticd is UNSUPPORTED, with what to do, never a ZodError", async () => {
    const files = new HermeticdFiles(agentStore(), {
      // The previous build's answer: no rel, name or metadata.
      fetch: async () => new Response(JSON.stringify({ id: "f_abcdefabcdef", path: "/data/x" })),
    });
    const e = await refusal(files.commit("atlas", "f_abcdefabcdef", {}, {}));
    expect(e.code).toBe("UNSUPPORTED");
    expect(e.message).toContain("hermetic artifacts push");
  });

  test("commit, content and remove give up on a box that never sends its headers", async () => {
    const hung: FetchHang = async (_url, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    const files = new HermeticdFiles(agentStore(), { fetch: hung, headersTimeoutMs: 20 });
    for (const run of [
      files.commit("atlas", "f_abcdefabcdef", {}, {}),
      files.content("atlas", "f_abcdefabcdef", { maxBytes: 10 }),
      files.remove("atlas", "f_abcdefabcdef", {}),
    ]) {
      const e = await refusal(run);
      expect(e.code).toBe("INTERNAL");
      expect(e.message).toContain("did not answer within");
    }
  });

  test("remove DELETEs the entry and maps a 404 files body", async () => {
    const files = new HermeticdFiles(agentStore(), {
      fetch: async (_url, init) => {
        expect(init?.method).toBe("DELETE");
        return errorResponse(404, "FILE_NOT_FOUND", "gone");
      },
    });
    const e = await refusal(files.remove("atlas", "f_abcdefabcdef", {}));
    expect(e.code).toBe("FILE_NOT_FOUND");
  });
});

describe("HermeticdFiles request routes", () => {
  const REQ = "fr_abcdefabcdef";
  function slot(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      request_id: REQ,
      kind: "file",
      purpose: "FIXTURE purpose",
      accept: [],
      max_bytes: 1024,
      sensitivity: "normal",
      durable: false,
      state: "open",
      created_at: AT,
      expires_at: AT,
      ...over,
    };
  }
  const fulfilResult = {
    request_id: REQ,
    path: "/run/hermetic/files/github-token.env",
    sha256: SHA,
    bytes: BYTES.byteLength,
    class: "secret",
    keys: ["GITHUB_TOKEN"],
    format: "dotenv",
  };

  test("request GETs one slot and list GETs the whole box", async () => {
    const seen: { url: string; method: string | undefined }[] = [];
    const files = new HermeticdFiles(agentStore(), {
      fetch: async (url, init) => {
        seen.push({ url, method: init?.method });
        if (url.endsWith(`/files/requests/${REQ}`)) return new Response(JSON.stringify(slot()));
        return new Response(
          JSON.stringify({
            inbox: [],
            outbox: [],
            secrets: [],
            requests: [slot()],
            usage: { inbox_bytes: 0, outbox_bytes: 0, retention_days: 7 },
          }),
        );
      },
    });
    expect((await files.request("atlas", REQ, {})).state).toBe("open");
    expect((await files.list("atlas", {})).requests).toHaveLength(1);
    expect(seen.map((s) => [new URL(s.url).pathname, s.method])).toEqual([
      [`/files/requests/${REQ}`, "GET"],
      ["/files", "GET"],
    ]);
  });

  test("fulfil PUTs the bytes with length, digest, the encoded name and the operator's flags", async () => {
    let seen: { url: string; headers: Record<string, string>; method?: string } | null = null;
    const files = new HermeticdFiles(agentStore(), {
      fetch: async (url, init) => {
        seen = { url, headers: init?.headers as Record<string, string>, method: init?.method };
        return new Response(JSON.stringify(fulfilResult));
      },
    });
    let progress = 0;
    const got = await files.fulfil(
      "atlas",
      REQ,
      { fileName: SECRET_NAME, size: BYTES.byteLength, body: BYTES, sha256: SHA },
      { notSecret: true, secretAs: "raw", onProgress: (n) => (progress = n) },
    );
    expect(got.keys).toEqual(["GITHUB_TOKEN"]);
    expect(progress).toBe(BYTES.byteLength);
    const req = seen as unknown as { url: string; headers: Record<string, string>; method?: string };
    expect(new URL(req.url).pathname).toBe(`/files/requests/${REQ}`);
    expect(req.method).toBe("PUT");
    expect(req.headers["content-length"]).toBe(String(BYTES.byteLength));
    expect(req.headers[CONTENT_DIGEST_HEADER]).toBe(formatContentDigest(SHA));
    expect(req.headers[FILES_NAME_HEADER]).toBe(encodeURIComponent(SECRET_NAME));
    expect(req.headers[FILES_NOT_SECRET_HEADER]).toBe("1");
    expect(req.headers[FILES_SECRET_AS_HEADER]).toBe("raw");
  });

  test("fulfil sends neither flag header unless asked", async () => {
    let headers: Record<string, string> = {};
    const files = new HermeticdFiles(agentStore(), {
      fetch: async (_url, init) => {
        headers = init?.headers as Record<string, string>;
        return new Response(JSON.stringify(fulfilResult));
      },
    });
    await files.fulfil(
      "atlas",
      REQ,
      { fileName: "a.env", size: BYTES.byteLength, body: chunks(BYTES), sha256: SHA },
      {},
    );
    expect(headers[FILES_NOT_SECRET_HEADER]).toBeUndefined();
    expect(headers[FILES_SECRET_AS_HEADER]).toBeUndefined();
  });

  test("a refused fulfil keeps the file's name out of the message", async () => {
    const files = new HermeticdFiles(agentStore(), {
      fetch: async () => errorResponse(415, "SOMETHING_NEW", `${SECRET_NAME} is not accepted`),
    });
    const e = await refusal(
      files.fulfil(
        "atlas",
        REQ,
        { fileName: SECRET_NAME, size: BYTES.byteLength, body: BYTES, sha256: SHA },
        {},
      ),
    );
    expect(e.message).not.toContain(SECRET_NAME);
  });

  test("secret POSTs the slot, name and format; decline POSTs the reason", async () => {
    const bodies: { path: string; body: unknown }[] = [];
    const files = new HermeticdFiles(agentStore(), {
      fetch: async (url, init) => {
        const path = new URL(url).pathname;
        bodies.push({ path, body: JSON.parse(String(init?.body)) });
        if (path.endsWith("/decline")) {
          return new Response(
            JSON.stringify(slot({ state: "declined", declined: { reason: "no", at: AT } })),
          );
        }
        return new Response(JSON.stringify(fulfilResult));
      },
    });
    await files.secret(
      "atlas",
      REQ,
      { ssm_slot: "env-github-token", name: "github-token.env", format: "dotenv" },
      {},
    );
    const declined = await files.decline("atlas", REQ, "no", {});
    await files.decline("atlas", REQ, undefined, {});
    expect(declined.state).toBe("declined");
    expect(bodies).toEqual([
      {
        path: `/files/requests/${REQ}/secret`,
        body: { ssm_slot: "env-github-token", name: "github-token.env", format: "dotenv" },
      },
      { path: `/files/requests/${REQ}/decline`, body: { reason: "no" } },
      { path: `/files/requests/${REQ}/decline`, body: {} },
    ]);
  });

  test("request, list, secret and decline give up on a box that never sends its headers", async () => {
    const hung: FetchHang = async (_url, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    const files = new HermeticdFiles(agentStore(), { fetch: hung, headersTimeoutMs: 20 });
    for (const run of [
      files.request("atlas", REQ, {}),
      files.list("atlas", {}),
      files.secret("atlas", REQ, { ssm_slot: "file-a", name: "a" }, {}),
      files.decline("atlas", REQ, undefined, {}),
    ]) {
      const e = await refusal(run);
      expect(e.code).toBe("INTERNAL");
      expect(e.message).toContain("did not answer within");
    }
  });

  test("a slot answer in a shape this build does not read is UNSUPPORTED", async () => {
    const files = new HermeticdFiles(agentStore(), {
      fetch: async () => new Response(JSON.stringify({ request_id: REQ })),
    });
    expect((await refusal(files.request("atlas", REQ, {}))).code).toBe("UNSUPPORTED");
  });
});

describe("MemoryFiles (the fixture store)", () => {
  function store(): MemoryFiles {
    return new MemoryFiles({ hasAgent: (n) => n === "atlas", now: () => new Date(AT) });
  }

  test("stage, commit, content and remove round-trip real bytes", async () => {
    const files = store();
    const result = await files.stage(
      "atlas",
      { fileName: "report.pdf", size: BYTES.byteLength, body: chunks(BYTES), sha256: SHA },
      {},
    );
    expect(result).toMatchObject({
      name: "report.pdf",
      mime: "application/pdf",
      class: "file",
      sha256: SHA,
    });
    const committed = await files.commit("atlas", result.id, { session_id: "s1" }, {});
    expect(committed.rel).toBe(`inbox/2026-10-13/${result.id}/report.pdf`);
    expect(files.committed("atlas").map((e) => e.id)).toEqual([result.id]);
    expect(files.entry("atlas", result.id)?.state).toBe("inbox");
    const content = await files.content("atlas", result.id, { maxBytes: 1024 });
    expect(content.bytes).toEqual(BYTES);
    await files.remove("atlas", result.id, {});
    expect((await refusal(files.content("atlas", result.id, { maxBytes: 1024 }))).code).toBe(
      "FILE_NOT_FOUND",
    );
  });

  test(`${E2E_FILE_TOO_LARGE} in the name is refused as too large`, async () => {
    const e = await refusal(
      store().stage(
        "atlas",
        { fileName: `x-${E2E_FILE_TOO_LARGE}.pdf`, size: BYTES.byteLength, body: BYTES, sha256: SHA },
        {},
      ),
    );
    expect(e.code).toBe("FILE_TOO_LARGE");
    expect(e.message).not.toContain(E2E_FILE_TOO_LARGE);
  });

  test(`${E2E_FILE_DIGEST} in the name is refused as a digest mismatch`, async () => {
    const e = await refusal(
      store().stage(
        "atlas",
        { fileName: `x-${E2E_FILE_DIGEST}.pdf`, size: BYTES.byteLength, body: BYTES, sha256: SHA },
        {},
      ),
    );
    expect(e.code).toBe("FILE_DIGEST_MISMATCH");
  });

  test("a wrong digest and a short body are both mismatches", async () => {
    const files = store();
    const wrong = "0".repeat(64);
    expect(
      (
        await refusal(
          files.stage(
            "atlas",
            { fileName: "a.pdf", size: BYTES.byteLength, body: BYTES, sha256: wrong },
            {},
          ),
        )
      ).code,
    ).toBe("FILE_DIGEST_MISMATCH");
    expect(
      (
        await refusal(
          files.stage(
            "atlas",
            { fileName: "a.pdf", size: BYTES.byteLength + 1, body: BYTES, sha256: SHA },
            {},
          ),
        )
      ).code,
    ).toBe("FILE_DIGEST_MISMATCH");
  });

  test("key material is refused unless the operator said it is not a secret", async () => {
    const pem = new TextEncoder().encode(
      "-----BEGIN PRIVATE KEY-----\nFIXTURE\n-----END PRIVATE KEY-----\n",
    );
    const sha = createHash("sha256").update(pem).digest("hex");
    const files = store();
    const upload = { fileName: "id.pem", size: pem.byteLength, body: pem, sha256: sha };
    expect((await refusal(files.stage("atlas", upload, {}))).code).toBe("FILE_LOOKS_SECRET");
    expect((await files.stage("atlas", { ...upload, notSecret: true }, {})).name).toBe("id.pem");
  });

  test("an unknown agent and another agent's id are refused", async () => {
    const files = store();
    expect(
      (
        await refusal(
          files.stage("nobody", { fileName: "a.pdf", size: 1, body: BYTES, sha256: SHA }, {}),
        )
      ).code,
    ).toBe("NOT_FOUND");
    expect((await refusal(files.content("atlas", "f_zzzzzzzzzzzz", { maxBytes: 1 }))).code).toBe(
      "FILE_NOT_FOUND",
    );
  });
});
