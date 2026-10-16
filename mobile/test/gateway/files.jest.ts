/**
 * The phone's files client against a scripted `fetch`: the requests it makes
 * (route, headers, digest), the checks it makes before sending, and how each
 * refusal from hermeticd comes back typed.
 */
import type { FilesStageResult } from "@hermetic/core/schema";
import {
  CONTENT_DIGEST_HEADER,
  FILES_LIMITS,
  FILES_NOT_SECRET_HEADER,
  FILES_SESSION_HEADER,
  formatContentDigest,
  sha256Hex,
} from "@hermetic/core/shared";
import {
  attachmentsFor,
  createPhoneFiles,
  FILES_COMMIT_TIMEOUT_MS,
  stageTimeoutMs,
} from "../../src/gateway/files.ts";
import { resetTunnelChecks } from "../../src/gateway/hermeticd.ts";
import { json } from "../helpers/fakes.ts";

const HOST = "fxtr0001-atlas.hermetic.ts.net";
const TEXT = new TextEncoder().encode("hello, agent\n");
const PEM = new TextEncoder().encode(
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAFIXTUREFIXTURE\n-----END RSA PRIVATE KEY-----\n",
);
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const STAGED: FilesStageResult = {
  id: "f_abcdefghij12",
  name: "notes.txt",
  bytes: TEXT.byteLength,
  mime: "text/plain",
  sha256: sha256Hex(TEXT),
  class: "file",
  expires_at: "2026-10-15T13:00:00.000Z",
};
const COMMITTED = {
  id: "f_abcdefghij12",
  path: "/var/lib/hermes/.hermes/inbox/2026-10-15/f_abcdefghij12/notes.txt",
  rel: "inbox/2026-10-15/f_abcdefghij12/notes.txt",
  name: "notes.txt",
  bytes: TEXT.byteLength,
  mime: "text/plain",
  sha256: sha256Hex(TEXT),
  class: "file",
};

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** A `fetch` that answers the tunnel probe itself and `box(url, init)` for hermeticd. */
function scripted(box: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.startsWith("https://")) return new Response("ok");
    calls.push({ url, init });
    if (init?.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    return await box(url, init);
  };
  return { fetch, calls };
}

const headersOf = (call: Call | undefined) => (call?.init?.headers ?? {}) as Record<string, string>;
const filesRefusal = (status: number, code: string, message: string) =>
  json({ error: { code, message } }, status);

beforeEach(() => resetTunnelChecks());

describe("stage", () => {
  test("PUT /files/stage/<name> on 7434 with the length, digest, session and protocol headers", async () => {
    const f = scripted(() => json(STAGED, 201));
    const files = createPhoneFiles({ fetch: f.fetch, host: HOST });
    const staged = await files.stage({ name: "notes.txt", bytes: TEXT, session_id: "s-1" });
    expect(staged).toEqual(STAGED);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe(`http://${HOST}:7434/files/stage/notes.txt`);
    expect(f.calls[0]?.init?.method).toBe("PUT");
    expect(f.calls[0]?.init?.body).toBe(TEXT);
    expect(headersOf(f.calls[0])).toMatchObject({
      "content-length": String(TEXT.byteLength),
      [CONTENT_DIGEST_HEADER]: formatContentDigest(sha256Hex(TEXT)),
      [FILES_SESSION_HEADER]: "s-1",
      "x-hermetic-rpc": "1",
    });
    expect(headersOf(f.calls[0])[FILES_NOT_SECRET_HEADER]).toBeUndefined();
  });

  test("the name is sanitized, and a name the box would refuse is refused without a request", async () => {
    const f = scripted(() => json(STAGED, 201));
    const files = createPhoneFiles({ fetch: f.fetch, host: HOST });
    await expect(files.stage({ name: ".env", bytes: TEXT })).rejects.toMatchObject({
      code: "FILE_NAME_INVALID",
    });
    expect(f.calls).toHaveLength(0);
    await files.stage({ name: "my notes.txt", bytes: TEXT });
    expect(f.calls[0]?.url).toBe(`http://${HOST}:7434/files/stage/my%20notes.txt`);
  });

  test("an image over the image cap is FILE_TOO_LARGE before anything is sent", async () => {
    const f = scripted(() => json(STAGED, 201));
    const files = createPhoneFiles({ fetch: f.fetch, host: HOST });
    const big = new Uint8Array(FILES_LIMITS.imageBytes + 1);
    big.set(PNG_HEAD);
    await expect(files.stage({ name: "huge.png", bytes: big })).rejects.toMatchObject({
      code: "FILE_TOO_LARGE",
      details: { limit: FILES_LIMITS.imageBytes },
    });
    expect(f.calls).toHaveLength(0);
  });

  test("a private key is FILE_LOOKS_SECRET unless the operator says it is not one", async () => {
    const f = scripted(() => json({ ...STAGED, name: "id_rsa" }, 201));
    const files = createPhoneFiles({ fetch: f.fetch, host: HOST });
    await expect(files.stage({ name: "id_rsa", bytes: PEM })).rejects.toMatchObject({
      code: "FILE_LOOKS_SECRET",
    });
    expect(f.calls).toHaveLength(0);
    await files.stage({ name: "id_rsa", bytes: PEM, not_secret: true });
    expect(headersOf(f.calls[0])[FILES_NOT_SECRET_HEADER]).toBe("1");
  });

  test("the box's refusal keeps its code, and its message loses the file's name", async () => {
    const f = scripted(() =>
      filesRefusal(422, "FILE_DIGEST_MISMATCH", "merger-plans.txt: the bytes do not match"),
    );
    const files = createPhoneFiles({ fetch: f.fetch, host: HOST });
    const error = await files.stage({ name: "merger-plans.txt", bytes: TEXT }).catch((e) => e);
    expect(error).toMatchObject({ code: "FILE_DIGEST_MISMATCH", details: { status: 422 } });
    expect(String(error.message)).not.toContain("merger-plans");
  });

  test("a status with no code it knows decides the code; a box without files is UNSUPPORTED", async () => {
    const cases: Array<[Response, string]> = [
      [new Response("", { status: 413 }), "FILE_TOO_LARGE"],
      [filesRefusal(507, "SOMETHING_NEW", "later hermeticd"), "DISK_FULL"],
      [filesRefusal(404, "NOT_FOUND", "no such route"), "UNSUPPORTED"],
      [new Response("", { status: 404 }), "UNSUPPORTED"],
      [
        new Response(`${JSON.stringify({ type: "error", code: "FORBIDDEN", message: "tagged" })}\n`, {
          status: 403,
        }),
        "FORBIDDEN",
      ],
    ];
    for (const [answer, code] of cases) {
      const f = scripted(() => answer);
      const files = createPhoneFiles({ fetch: f.fetch, host: HOST });
      await expect(files.stage({ name: "notes.txt", bytes: TEXT })).rejects.toMatchObject({ code });
    }
  });

  test("a reply in a shape this build does not read is UNSUPPORTED", async () => {
    const f = scripted(() => json({ id: "f_abcdefghij12" }, 201));
    const files = createPhoneFiles({ fetch: f.fetch, host: HOST });
    await expect(files.stage({ name: "notes.txt", bytes: TEXT })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  });

  test("a stop by the caller is ABORTED", async () => {
    const controller = new AbortController();
    const f = scripted(async (_url, init) => {
      controller.abort();
      throw Object.assign(new Error(`aborted ${String(init?.method)}`), { name: "AbortError" });
    });
    const files = createPhoneFiles({ fetch: f.fetch, host: HOST });
    await expect(
      files.stage({ name: "notes.txt", bytes: TEXT, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "ABORTED" });
  });

  test("the stage bound grows with the file", () => {
    expect(stageTimeoutMs(0)).toBe(60_000);
    expect(stageTimeoutMs(FILES_LIMITS.fileBytes)).toBeGreaterThan(30 * 60_000);
    expect(FILES_COMMIT_TIMEOUT_MS).toBe(30_000);
  });
});

describe("commit", () => {
  test("POST /files/<id>/commit with the session, parsed with FilesCommitResult", async () => {
    const f = scripted(() => json(COMMITTED));
    const files = createPhoneFiles({ fetch: f.fetch, host: HOST });
    expect(await files.commit("f_abcdefghij12", "s-1", undefined)).toEqual(COMMITTED);
    expect(f.calls[0]?.url).toBe(`http://${HOST}:7434/files/f_abcdefghij12/commit`);
    expect(f.calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toEqual({ session_id: "s-1" });
    expect(headersOf(f.calls[0])).toMatchObject({
      "content-type": "application/json",
      "content-length": String(f.calls[0]?.init?.body).length.toString(),
    });
  });

  test("no session sends an empty body; a staged file that is gone is FILE_NOT_FOUND", async () => {
    const f = scripted(() => filesRefusal(404, "FILE_NOT_FOUND", "that file is no longer on the box"));
    const files = createPhoneFiles({ fetch: f.fetch, host: HOST });
    await expect(files.commit("f_abcdefghij12", "", undefined)).rejects.toMatchObject({
      code: "FILE_NOT_FOUND",
    });
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toEqual({});
  });

  test("attachmentsFor: the staged ids in order, committed through the client", async () => {
    const f = scripted((url) => json({ ...COMMITTED, id: url.split("/")[4] }));
    const files = createPhoneFiles({ fetch: f.fetch, host: HOST });
    const second = { ...STAGED, id: "f_zyxwvutsrq98" };
    const attachments = attachmentsFor([second, STAGED], files);
    expect(attachments.ids).toEqual(["f_zyxwvutsrq98", "f_abcdefghij12"]);
    const committed = await attachments.commit("f_zyxwvutsrq98", "s-9", undefined);
    expect(committed.id).toBe("f_zyxwvutsrq98");
    expect(f.calls[0]?.url).toBe(`http://${HOST}:7434/files/f_zyxwvutsrq98/commit`);
  });
});

describe("capability", () => {
  const health = (extra: Record<string, unknown>) =>
    json({ name: "atlas", hermeticd_version: "0.5.0", protocol: 1, config_hash: null, ...extra });

  test("files in /healthz's capabilities is true; absent or empty is false", async () => {
    for (const [extra, want] of [
      [{ capabilities: ["files"] }, true],
      [{ capabilities: [] }, false],
      [{}, false],
    ] as const) {
      const f = scripted(() => health(extra));
      expect(await createPhoneFiles({ fetch: f.fetch, host: HOST }).capability()).toBe(want);
      expect(f.calls[0]?.url).toBe(`http://${HOST}:7434/healthz`);
    }
  });

  test("a box that did not answer throws rather than reading as no capability", async () => {
    const f = scripted(() => {
      throw new TypeError("Network request failed");
    });
    await expect(createPhoneFiles({ fetch: f.fetch, host: HOST }).capability()).rejects.toMatchObject({
      code: "HERMETICD_UNAVAILABLE",
    });
  });
});
