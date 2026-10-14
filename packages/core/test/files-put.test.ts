import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentParamPath, agentParamPrefix } from "../src/backend/constants.ts";
import { FIXTURE_CONFIG, MemoryBackend, seedFixtureFleet } from "../src/backend/memory.ts";
import type { FilesFulfilOptions } from "../src/backend/files-port.ts";
import { MemoryFiles } from "../src/backend/fixture/memory-files.ts";
import { HermeticError } from "../src/errors.ts";
import type { FilesPutEvent, OpenFileRequestBody, OpenSecretRequestBody } from "../src/schema/index.ts";
import { redactFilesPutInput } from "../src/surface.ts";
import { createUploadRegistry } from "../src/files/uploads.ts";
import {
  FILES_DROP_DIR,
  FILES_SECRET_DIR,
  decodeSecretEnvelope,
  encodeSecretEnvelope,
} from "../src/shared/files.ts";
import { readCanonicalSecretEnv } from "../src/shared/secret-env.ts";
import { testHermetic } from "./helpers.ts";

/**
 * `files.put`, `files.decline` and the request card's slot read, over the
 * fixture backend: every lane `put.ts` documents, and the fixture's request
 * slots they answer. No network, no file outside a temp directory, and only
 * FIXTURE values.
 */

const dir = mkdtempSync(join(tmpdir(), "hermetic-files-put-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const AGENT = "atlas";
const PEM = new TextEncoder().encode(
  "-----BEGIN PRIVATE KEY-----\nFIXTUREFIXTUREFIXTUREkeymaterialFIXTURE\n-----END PRIVATE KEY-----\n",
);
const LOG = new TextEncoder().encode("127.0.0.1 - - [12/Oct/2026] GET / 200 FIXTURE\n");
const TOKEN = "ghp_FIXTUREtokenFIXTUREtokenFIXTURE0001";

function open() {
  const backend = seedFixtureFleet(new MemoryBackend());
  const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG });
  const calls: { method: string; opts?: FilesFulfilOptions }[] = [];
  const files = backend.files;
  const fulfil = files.fulfil.bind(files);
  const secret = files.secret.bind(files);
  files.fulfil = (agent, id, upload, opts) => {
    calls.push({ method: "fulfil", opts });
    return fulfil(agent, id, upload, opts);
  };
  files.secret = (agent, id, body, opts) => {
    calls.push({ method: "secret" });
    return secret(agent, id, body, opts);
  };
  const fleet = backend.boundFleetId() as string;
  const slots = (): string[] =>
    [...backend.params.keys()].filter(
      (k) =>
        k.startsWith(`${agentParamPrefix(fleet)}${AGENT}/file-`) ||
        k.startsWith(`${agentParamPrefix(fleet)}${AGENT}/env-`),
    );
  return { backend, hermetic, calls, fleet, slots };
}

function fileRequest(over: Partial<OpenFileRequestBody> = {}): OpenFileRequestBody {
  return { purpose: "FIXTURE purpose", ...over } as OpenFileRequestBody;
}

function secretRequest(over: Partial<OpenSecretRequestBody> = {}): OpenSecretRequestBody {
  return {
    kind: "secret_text",
    purpose: "FIXTURE token",
    keys: ["GITHUB_TOKEN"],
    ...over,
  } as OpenSecretRequestBody;
}

function writeTemp(name: string, bytes: Uint8Array): string {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

async function drain(events: AsyncIterable<FilesPutEvent>): Promise<FilesPutEvent[]> {
  const seen: FilesPutEvent[] = [];
  for await (const e of events) seen.push(e);
  return seen;
}

function fulfilled(events: FilesPutEvent[]): Extract<FilesPutEvent, { type: "fulfilled" }> {
  const last = events.at(-1);
  if (last?.type !== "fulfilled") throw new Error("expected a fulfilled event last");
  return last;
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

/** A text secret registered the way the CLI's `--secret-stdin` does it. */
function stdinUpload(h: ReturnType<typeof open>["hermetic"], text: string): string {
  return h.files.internal.uploads.registerBytes("stdin", new TextEncoder().encode(text)).upload_id;
}

describe("files.put: request_file", () => {
  test("a normal file is uploaded with progress and lands in the inbox", async () => {
    const { backend, hermetic, calls, slots } = open();
    const slot = backend.files.openRequest(AGENT, fileRequest({ accept: [".log"] }));
    const path = writeTemp("access-FIXTURE.log", LOG);
    const events = await drain(
      hermetic.files.put({ instance: AGENT, request_id: slot.request_id, source: { path } }),
    );
    const done = fulfilled(events);
    expect(events.some((e) => e.type === "progress" && e.phase === "upload")).toBe(true);
    expect(done.result.class).toBe("file");
    expect(done.ssm_slot).toBeUndefined();
    expect(calls.map((c) => c.method)).toEqual(["fulfil"]);
    expect(slots()).toEqual([]);
    expect(backend.files.committed(AGENT).map((e) => e.name)).toEqual(["access-FIXTURE.log"]);
    const box = await hermetic.files.internal.request(AGENT, slot.request_id);
    expect(box.state).toBe("fulfilled");
    // Progress never names the file.
    for (const e of events)
      expect(JSON.stringify(e.type === "progress" ? e : {})).not.toContain("access-FIXTURE");
  });

  test("a file outside the accept list is refused before it is sent", async () => {
    const { backend, hermetic, calls } = open();
    const slot = backend.files.openRequest(AGENT, fileRequest({ accept: [".csv"] }));
    const path = writeTemp("not-a-csv.log", LOG);
    const e = await refusal(
      drain(hermetic.files.put({ instance: AGENT, request_id: slot.request_id, source: { path } })),
    );
    expect(e.code).toBe("FILE_TYPE_REJECTED");
    expect(e.message).not.toContain("not-a-csv");
    expect(calls).toEqual([]);
  });

  test("D6: key material on a durable slot is forced to SSM, then the box reads it", async () => {
    const { backend, hermetic, calls, fleet } = open();
    const slot = backend.files.openRequest(AGENT, fileRequest({ durable: true }));
    const path = writeTemp("github-app.pem", PEM);
    const done = fulfilled(
      await drain(
        hermetic.files.put({ instance: AGENT, request_id: slot.request_id, source: { path } }),
      ),
    );
    expect(done.ssm_slot).toBe("file-github-app-pem");
    expect(calls.map((c) => c.method)).toEqual(["secret"]);
    const raw = backend.params.get(agentParamPath(fleet, AGENT, "file-github-app-pem"));
    const envelope = decodeSecretEnvelope(raw ?? "");
    expect(envelope?.name).toBe("github-app.pem");
    expect(new TextDecoder().decode(envelope?.bytes)).toBe(new TextDecoder().decode(PEM));
    expect(done.result.path).toBe(`${FILES_SECRET_DIR}/github-app.pem`);
    const box = await hermetic.files.internal.request(AGENT, slot.request_id);
    expect(box.fulfilled?.ssm_slot).toBe("file-github-app-pem");
    expect(box.fulfilled?.class).toBe("secret");
  });

  test("a secret slot with a name_hint is stored under the hint's last segment, not the drop's", async () => {
    const { backend, hermetic, fleet } = open();
    const slot = backend.files.openRequest(
      AGENT,
      fileRequest({ sensitivity: "secret", durable: true, name_hint: "~/keys/deploy-key.pem" }),
    );
    const path = writeTemp("whatever-i-dropped.pem", PEM);
    const done = fulfilled(
      await drain(
        hermetic.files.put({ instance: AGENT, request_id: slot.request_id, source: { path } }),
      ),
    );
    // What the card said before the drop: `fileSecretSlot(baseName(name_hint))`.
    expect(done.ssm_slot).toBe("file-deploy-key-pem");
    const envelope = decodeSecretEnvelope(
      backend.params.get(agentParamPath(fleet, AGENT, "file-deploy-key-pem")) ?? "",
    );
    expect(envelope?.name).toBe("deploy-key.pem");
    expect(done.result.path).toBe(`${FILES_SECRET_DIR}/deploy-key.pem`);
    expect(JSON.stringify(done)).not.toContain("whatever-i-dropped");
  });

  test("a normal slot with a name_hint lands under the hint; with none, under the drop's name", async () => {
    const { backend, hermetic, calls } = open();
    const hinted = backend.files.openRequest(AGENT, fileRequest({ name_hint: "logs/access.log" }));
    const plain = backend.files.openRequest(AGENT, fileRequest());
    const path = writeTemp("my-local-copy.log", LOG);
    fulfilled(
      await drain(
        hermetic.files.put({ instance: AGENT, request_id: hinted.request_id, source: { path } }),
      ),
    );
    fulfilled(
      await drain(
        hermetic.files.put({ instance: AGENT, request_id: plain.request_id, source: { path } }),
      ),
    );
    expect(calls.map((c) => c.method)).toEqual(["fulfil", "fulfil"]);
    expect(
      backend.files
        .committed(AGENT)
        .map((e) => e.name)
        .sort(),
    ).toEqual(["access.log", "my-local-copy.log"]);
  });

  test("D6 on a non-durable slot goes to the box's tmpfs drop, not SSM", async () => {
    const { backend, hermetic, calls, slots } = open();
    const slot = backend.files.openRequest(AGENT, fileRequest());
    const path = writeTemp("deploy.pem", PEM);
    const done = fulfilled(
      await drain(
        hermetic.files.put({ instance: AGENT, request_id: slot.request_id, source: { path } }),
      ),
    );
    expect(done.result.class).toBe("secret");
    expect(done.result.path.startsWith(`${FILES_DROP_DIR}/`)).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(["fulfil"]);
    expect(slots()).toEqual([]);
  });

  test("--not-secret overrides the sniff: a plain upload, with the header", async () => {
    const { backend, hermetic, calls, slots } = open();
    const slot = backend.files.openRequest(AGENT, fileRequest({ durable: true }));
    const path = writeTemp("test-fixture.pem", PEM);
    const done = fulfilled(
      await drain(
        hermetic.files.put({
          instance: AGENT,
          request_id: slot.request_id,
          source: { path },
          not_secret: true,
        }),
      ),
    );
    expect(done.result.class).toBe("file");
    expect(calls).toEqual([{ method: "fulfil", opts: expect.objectContaining({ notSecret: true }) }]);
    expect(slots()).toEqual([]);
  });

  test("--secret --ephemeral on a secret slot is sent once to the drop, never SSM", async () => {
    const { backend, hermetic, calls, slots } = open();
    const slot = backend.files.openRequest(AGENT, fileRequest({ sensitivity: "secret" }));
    expect(slot.durable).toBe(true);
    const path = writeTemp("once.pem", PEM);
    const done = fulfilled(
      await drain(
        hermetic.files.put({
          instance: AGENT,
          request_id: slot.request_id,
          source: { path },
          secret: true,
          ephemeral: true,
        }),
      ),
    );
    expect(done.ssm_slot).toBeUndefined();
    expect(done.result.path.startsWith(`${FILES_DROP_DIR}/`)).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(["fulfil"]);
    expect(slots()).toEqual([]);
  });

  test("a durable secret too large for one SSM slot is refused, advising just this once", async () => {
    const { backend, hermetic, calls, slots } = open();
    const slot = backend.files.openRequest(AGENT, fileRequest({ sensitivity: "secret" }));
    const big = new Uint8Array(4000).fill(0x41);
    const path = writeTemp("big-secret.bin", big);
    const e = await refusal(
      drain(hermetic.files.put({ instance: AGENT, request_id: slot.request_id, source: { path } })),
    );
    expect(e.code).toBe("FILE_TOO_LARGE");
    expect(e.message).toContain("just this once");
    expect(e.message).not.toContain("big-secret");
    expect(calls).toEqual([]);
    expect(slots()).toEqual([]);
  });

  test("--ephemeral on a normal file is refused: only a secret goes once", async () => {
    const { backend, hermetic, calls } = open();
    const slot = backend.files.openRequest(AGENT, fileRequest());
    const path = writeTemp("plain.log", LOG);
    const e = await refusal(
      drain(
        hermetic.files.put({
          instance: AGENT,
          request_id: slot.request_id,
          source: { path },
          ephemeral: true,
          secret: true,
        }),
      ),
    );
    expect(e.code).toBe("VALIDATION");
    expect(calls).toEqual([]);
  });

  test("a request no longer open is refused with the box's code before anything is read", async () => {
    const { backend, hermetic, calls } = open();
    const declined = backend.files.openRequest(AGENT, fileRequest());
    await hermetic.files.decline({ instance: AGENT, request_id: declined.request_id });
    const expired = backend.files.openRequest(AGENT, fileRequest());
    backend.files.expire(AGENT, expired.request_id);
    const source = { path: join(dir, "never-read.log") };
    expect(
      (
        await refusal(
          drain(hermetic.files.put({ instance: AGENT, request_id: declined.request_id, source })),
        )
      ).code,
    ).toBe("FILE_REQUEST_CLOSED");
    expect(
      (
        await refusal(
          drain(hermetic.files.put({ instance: AGENT, request_id: expired.request_id, source })),
        )
      ).code,
    ).toBe("FILE_REQUEST_EXPIRED");
    expect(calls).toEqual([]);
  });

  test("an unknown request is FILE_NOT_FOUND; a malformed id never reaches the box", async () => {
    const { hermetic } = open();
    const source = { path: join(dir, "x.log") };
    const missing = await refusal(
      drain(hermetic.files.put({ instance: AGENT, request_id: "fr_000000000000", source })),
    );
    expect(missing.code).toBe("FILE_NOT_FOUND");
    expect(() => hermetic.files.put({ instance: AGENT, request_id: "nope", source })).toThrow(
      HermeticError,
    );
  });
});

describe("files.put: request_secret", () => {
  test("durable .env lines: parsed here, canonical form to SSM env-<slug>, then the box", async () => {
    const { backend, hermetic, calls, fleet } = open();
    const slot = backend.files.openRequest(AGENT, secretRequest());
    expect(slot.slug).toBe("github");
    const upload_id = stdinUpload(hermetic, `# FIXTURE\nexport GITHUB_TOKEN=${TOKEN}\n`);
    const done = fulfilled(
      await drain(
        hermetic.files.put({
          instance: AGENT,
          request_id: slot.request_id,
          source: { chunk_upload_id: upload_id },
          secret: true,
        }),
      ),
    );
    expect(done.ssm_slot).toBe("env-github");
    expect(done.result.format).toBe("dotenv");
    expect(done.result.keys).toEqual(["GITHUB_TOKEN"]);
    expect(done.result.path).toBe(`${FILES_SECRET_DIR}/github.env`);
    expect(calls.map((c) => c.method)).toEqual(["secret"]);
    const envelope = decodeSecretEnvelope(
      backend.params.get(agentParamPath(fleet, AGENT, "env-github")) ?? "",
    );
    const text = new TextDecoder().decode(envelope?.bytes);
    // Canonical: the comment and `export` are gone; only the value survives.
    expect(text).not.toContain("FIXTURE\n#");
    expect(text).not.toContain("export");
    expect(readCanonicalSecretEnv(text)).toEqual([{ key: "GITHUB_TOKEN", value: TOKEN }]);
    // The registry let go of the value.
    expect(() => hermetic.files.internal.uploads.discard(upload_id)).not.toThrow();
    expect(hermetic.files.internal.uploads.discard(upload_id).discarded).toBe(false);
  });

  test("a raw single value is assigned to the one key", async () => {
    const { backend, hermetic, fleet } = open();
    const slot = backend.files.openRequest(AGENT, secretRequest());
    const upload_id = stdinUpload(hermetic, `${TOKEN}\n`);
    const done = fulfilled(
      await drain(
        hermetic.files.put({
          instance: AGENT,
          request_id: slot.request_id,
          source: { chunk_upload_id: upload_id },
        }),
      ),
    );
    expect(done.result.format).toBe("raw");
    const envelope = decodeSecretEnvelope(
      backend.params.get(agentParamPath(fleet, AGENT, "env-github")) ?? "",
    );
    expect(readCanonicalSecretEnv(new TextDecoder().decode(envelope?.bytes))).toEqual([
      { key: "GITHUB_TOKEN", value: TOKEN },
    ]);
  });

  test("D10: an unrequested key is refused before any SSM write or upload", async () => {
    const { backend, hermetic, calls, slots } = open();
    const slot = backend.files.openRequest(AGENT, secretRequest());
    const upload_id = stdinUpload(
      hermetic,
      `GITHUB_TOKEN=${TOKEN}\nAWS_SECRET_ACCESS_KEY=FIXTUREawsSecretValue\n`,
    );
    const e = await refusal(
      drain(
        hermetic.files.put({
          instance: AGENT,
          request_id: slot.request_id,
          source: { chunk_upload_id: upload_id },
        }),
      ),
    );
    expect(e.code).toBe("VALIDATION");
    expect(e.message).toContain("Line 2");
    expect(e.message).toContain("not requested");
    expect(e.message).not.toContain("FIXTUREawsSecretValue");
    expect(e.message).not.toContain(TOKEN);
    expect(calls).toEqual([]);
    expect(slots()).toEqual([]);
    const box = await hermetic.files.internal.request(AGENT, slot.request_id);
    expect(box.state).toBe("open");
    expect(box.rejected).toBeUndefined();
    // A refused secret is forgotten too: it is not left in the registry to retry.
    expect(hermetic.files.internal.uploads.discard(upload_id).discarded).toBe(false);
  });

  test("just this once: the original bytes go to the box with the Treat-as override", async () => {
    const { backend, hermetic, calls, slots } = open();
    const slot = backend.files.openRequest(AGENT, secretRequest({ keys: ["GH_APP_KEY"] }));
    // Looks like an assignment on line 1, so auto would read it as .env and fail.
    const upload_id = stdinUpload(hermetic, "A=FIXTUREb\nFIXTUREsecondline\n");
    const done = fulfilled(
      await drain(
        hermetic.files.put({
          instance: AGENT,
          request_id: slot.request_id,
          source: { chunk_upload_id: upload_id },
          ephemeral: true,
          as: "raw",
        }),
      ),
    );
    expect(done.result.format).toBe("raw");
    expect(done.ssm_slot).toBeUndefined();
    expect(calls).toEqual([{ method: "fulfil", opts: expect.objectContaining({ secretAs: "raw" }) }]);
    expect(backend.files.lastSecretAs(AGENT, slot.request_id)).toBe("raw");
    expect(slots()).toEqual([]);
  });

  test("forced to .env lines, the same text is refused here, as it would be on the box", async () => {
    const { backend, hermetic, calls } = open();
    const slot = backend.files.openRequest(AGENT, secretRequest({ keys: ["GH_APP_KEY"] }));
    const upload_id = stdinUpload(hermetic, "A=FIXTUREb\nFIXTUREsecondline\n");
    const e = await refusal(
      drain(
        hermetic.files.put({
          instance: AGENT,
          request_id: slot.request_id,
          source: { chunk_upload_id: upload_id },
          as: "dotenv",
        }),
      ),
    );
    expect(e.code).toBe("VALIDATION");
    expect(e.message).toContain("Line 2");
    expect(e.message).not.toContain("FIXTURE");
    expect(calls).toEqual([]);
  });
});

describe("files.decline and the slot read", () => {
  test("decline closes the slot with the reason; a second decline is refused", async () => {
    const { backend, hermetic } = open();
    const slot = backend.files.openRequest(AGENT, fileRequest());
    const waiting = backend.files.waitFor(AGENT, slot.request_id, { timeoutMs: 5_000 });
    const declined = await hermetic.files.decline({
      instance: AGENT,
      request_id: slot.request_id,
      reason: "not this one",
    });
    expect(declined.state).toBe("declined");
    expect(declined.declined?.reason).toBe("not this one");
    expect((await waiting).state).toBe("declined");
    const again = await refusal(
      hermetic.files.decline({ instance: AGENT, request_id: slot.request_id }),
    );
    expect(again.code).toBe("FILE_REQUEST_CLOSED");
  });

  test("decline validates its input before reaching the box", async () => {
    const { hermetic } = open();
    expect((await refusal(hermetic.files.decline({ instance: AGENT, request_id: "x" }))).code).toBe(
      "VALIDATION",
    );
  });

  test("internal.request answers the box's copy; a malformed id is refused", async () => {
    const { backend, hermetic } = open();
    const slot = backend.files.openRequest(AGENT, fileRequest({ accept: [".log"], max_bytes: 1024 }));
    const box = await hermetic.files.internal.request(AGENT, slot.request_id);
    expect(box).toEqual(slot);
    expect((await refusal(hermetic.files.internal.request(AGENT, "f_000000000000"))).code).toBe(
      "VALIDATION",
    );
  });
});

describe("MemoryFiles request slots", () => {
  test("slots run on the wall clock, not the fixture's frozen one; entries keep the fixture's", async () => {
    let wall = Date.parse("2031-01-01T12:00:00.000Z");
    const frozen = new Date("2026-09-01T00:00:00.000Z");
    const files = new MemoryFiles({
      hasAgent: () => true,
      now: () => frozen,
      wallNow: () => new Date(wall),
    });
    const slot = files.openRequest(AGENT, fileRequest(), { ttl_s: 60 });
    expect(slot.created_at).toBe("2031-01-01T12:00:00.000Z");
    expect(slot.expires_at).toBe("2031-01-01T12:01:00.000Z");
    expect(files.requestsFor(AGENT)[0]?.state).toBe("open");
    wall += 61_000;
    expect(files.requestsFor(AGENT)[0]?.state).toBe("expired");
  });

  test("with no wallNow, a fresh slot's expiry is in the real future", () => {
    const files = new MemoryFiles({
      hasAgent: () => true,
      now: () => new Date("2026-09-01T00:00:00.000Z"),
    });
    const slot = files.openRequest(AGENT, fileRequest());
    expect(Date.parse(slot.expires_at)).toBeGreaterThan(Date.now());
  });

  test("waitFor resolves on fulfil, and on timeout with the slot still open", async () => {
    const { backend, hermetic } = open();
    const slot = backend.files.openRequest(AGENT, fileRequest());
    const timedOut = await backend.files.waitFor(AGENT, slot.request_id, { timeoutMs: 5 });
    expect(timedOut.state).toBe("open");
    const waiting = backend.files.waitFor(AGENT, slot.request_id);
    const path = writeTemp("waited.log", LOG);
    await drain(hermetic.files.put({ instance: AGENT, request_id: slot.request_id, source: { path } }));
    const got = await waiting;
    expect(got.state).toBe("fulfilled");
    expect(got.fulfilled?.by).toBeTruthy();
  });

  test("a refused upload reopens the slot and records the box's reason", async () => {
    const { backend } = open();
    const slot = backend.files.openRequest(AGENT, fileRequest({ max_bytes: 4 }));
    const e = await refusal(
      backend.files.fulfil(
        AGENT,
        slot.request_id,
        { fileName: "x.log", size: LOG.byteLength, body: LOG, sha256: "0".repeat(64) },
        {},
      ),
    );
    expect(e.code).toBe("FILE_TOO_LARGE");
    const after = await backend.files.request(AGENT, slot.request_id, {});
    expect(after.state).toBe("open");
    expect(after.rejected?.code).toBe("FILE_TOO_LARGE");
  });

  test("expire closes a live slot; list shows every slot", async () => {
    const { backend } = open();
    const a = backend.files.openRequest(AGENT, fileRequest());
    const b = backend.files.openRequest(AGENT, secretRequest({ slug: "Stripe Keys", durable: false }));
    expect(b.slug).toBe("stripe-keys");
    expect(b.durable).toBe(false);
    expect(backend.files.expire(AGENT, a.request_id).state).toBe("expired");
    const listed = await backend.files.list(AGENT, {});
    expect(listed.requests.map((r) => [r.request_id, r.state])).toEqual([
      [a.request_id, "expired"],
      [b.request_id, "open"],
    ]);
  });
});

test("redactFilesPutInput drops a path and keeps an upload id", () => {
  const base = { instance: AGENT, request_id: "fr_000000000000" };
  expect(redactFilesPutInput({ ...base, source: { path: "/tmp/FIXTURE-secret.pem" } }).source).toEqual({
    path: "(redacted)",
  });
  const id = "up_00000000-0000-0000-0000-000000000000";
  expect(redactFilesPutInput({ ...base, source: { chunk_upload_id: id } }).source).toEqual({
    chunk_upload_id: id,
  });
});

/** A text secret registered exactly as the CLI's `--secret-stdin` does: marked as text. */
function cliStdinUpload(h: ReturnType<typeof open>["hermetic"], text: string): string {
  return h.files.internal.uploads.registerBytes("stdin", new TextEncoder().encode(text), {
    secretText: true,
  }).upload_id;
}

/** A webview drop: opened, sent in one chunk, closed. */
function droppedUpload(h: ReturnType<typeof open>["hermetic"], name: string, bytes: Uint8Array) {
  const uploads = h.files.internal.uploads;
  const { upload_id } = uploads.open({ name, size: bytes.byteLength });
  uploads.append(upload_id, 0, bytes);
  uploads.close(upload_id);
  return upload_id;
}

/** Whether the registry still holds an upload (discarding it to find out). */
function stillHeld(h: ReturnType<typeof open>["hermetic"], upload_id: string): boolean {
  return h.files.internal.uploads.discard(upload_id).discarded;
}

function envelopeFor(name: string, text: string): string {
  const bytes = new TextEncoder().encode(text);
  return encodeSecretEnvelope({
    name,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

describe("files.put: a durable secret the box refuses after the SSM write", () => {
  const refuse = (backend: MemoryBackend): void => {
    backend.files.secret = async () => {
      throw new HermeticError("CONFLICT", "atlas: another durable secret has that file name");
    };
  };

  test("a parameter the write created is deleted again; the refusal is the box's", async () => {
    const { backend, hermetic, slots } = open();
    refuse(backend);
    const slot = backend.files.openRequest(AGENT, fileRequest({ sensitivity: "secret" }));
    const path = writeTemp("fresh-FIXTURE.pem", PEM);
    const e = await refusal(
      drain(hermetic.files.put({ instance: AGENT, request_id: slot.request_id, source: { path } })),
    );
    expect(e.code).toBe("CONFLICT");
    expect(e.message).not.toContain("replaced");
    expect(slots()).toEqual([]);
  });

  test("a text secret's new env slot is deleted too, and its upload forgotten", async () => {
    const { backend, hermetic, slots } = open();
    refuse(backend);
    const slot = backend.files.openRequest(AGENT, secretRequest());
    const upload_id = cliStdinUpload(hermetic, `GITHUB_TOKEN=${TOKEN}\n`);
    const e = await refusal(
      drain(
        hermetic.files.put({
          instance: AGENT,
          request_id: slot.request_id,
          source: { chunk_upload_id: upload_id },
        }),
      ),
    );
    expect(e.code).toBe("CONFLICT");
    expect(slots()).toEqual([]);
    expect(stillHeld(hermetic, upload_id)).toBe(false);
  });

  test("a replaced parameter is kept, and the refusal says the box loads it at next boot", async () => {
    const { backend, hermetic, fleet } = open();
    refuse(backend);
    const param = agentParamPath(fleet, AGENT, "env-github");
    backend.params.set(param, envelopeFor("github.env", 'GITHUB_TOKEN="FIXTUREold"\n'));
    const slot = backend.files.openRequest(AGENT, secretRequest());
    const upload_id = cliStdinUpload(hermetic, `GITHUB_TOKEN=${TOKEN}\n`);
    const e = await refusal(
      drain(
        hermetic.files.put({
          instance: AGENT,
          request_id: slot.request_id,
          source: { chunk_upload_id: upload_id },
          replace: true,
        }),
      ),
    );
    expect(e.code).toBe("CONFLICT");
    expect(e.message).toContain("the stored secret was replaced");
    expect(e.message).toContain("next apply or boot");
    expect(e.message).not.toContain(TOKEN);
    expect(e.message).not.toContain("github.env");
    expect(e.details?.["ssm"]).toBe("replaced");
    const kept = decodeSecretEnvelope(backend.params.get(param) ?? "");
    expect(readCanonicalSecretEnv(new TextDecoder().decode(kept?.bytes))).toEqual([
      { key: "GITHUB_TOKEN", value: TOKEN },
    ]);
  });

  test("a new parameter that cannot be deleted is named as left behind", async () => {
    const { backend, hermetic, slots } = open();
    refuse(backend);
    backend.secrets.delete = async () => {
      throw new HermeticError("INTERNAL", "FIXTURE ssm outage");
    };
    const slot = backend.files.openRequest(AGENT, secretRequest());
    const upload_id = cliStdinUpload(hermetic, `GITHUB_TOKEN=${TOKEN}\n`);
    const e = await refusal(
      drain(
        hermetic.files.put({
          instance: AGENT,
          request_id: slot.request_id,
          source: { chunk_upload_id: upload_id },
        }),
      ),
    );
    expect(e.code).toBe("CONFLICT");
    expect(e.message).toContain("could not be removed");
    expect(e.details?.["ssm"]).toBe("kept");
    expect(slots().length).toBe(1);
  });
});

describe("files.put: --secret-stdin answers a text secret request only", () => {
  test("against a file request it is refused before anything is read or sent", async () => {
    const { backend, hermetic, calls, slots } = open();
    const slot = backend.files.openRequest(AGENT, fileRequest({ sensitivity: "secret" }));
    const upload_id = cliStdinUpload(hermetic, `${TOKEN}\n`);
    const e = await refusal(
      drain(
        hermetic.files.put({
          instance: AGENT,
          request_id: slot.request_id,
          source: { chunk_upload_id: upload_id },
        }),
      ),
    );
    expect(e.code).toBe("VALIDATION");
    expect(e.message).toBe(
      "--secret-stdin answers a text secret request; use a file path for this request",
    );
    expect(calls).toEqual([]);
    expect(slots()).toEqual([]);
    expect(stillHeld(hermetic, upload_id)).toBe(false);
    expect((await hermetic.files.internal.request(AGENT, slot.request_id)).state).toBe("open");
  });

  test("bytes held without the mark (a test, a future head) still answer a file request", async () => {
    const { backend, hermetic } = open();
    const slot = backend.files.openRequest(AGENT, fileRequest({ sensitivity: "secret" }));
    const upload_id = hermetic.files.internal.uploads.registerBytes("github-app.pem", PEM).upload_id;
    const done = fulfilled(
      await drain(
        hermetic.files.put({
          instance: AGENT,
          request_id: slot.request_id,
          source: { chunk_upload_id: upload_id },
        }),
      ),
    );
    expect(done.ssm_slot).toBe("file-github-app-pem");
  });
});

describe("files.put: an upload that may hold a secret is forgotten on any failure", () => {
  test("the box unreachable before the slot is read: a drop and stdin text are both forgotten", async () => {
    const { backend, hermetic } = open();
    backend.files.request = async () => {
      throw new HermeticError("INTERNAL", "hermeticd on atlas did not answer: FIXTURE");
    };
    const drop = droppedUpload(hermetic, "token.txt", new TextEncoder().encode(`${TOKEN}\n`));
    const stdin = cliStdinUpload(hermetic, `${TOKEN}\n`);
    for (const id of [drop, stdin]) {
      const e = await refusal(
        drain(
          hermetic.files.put({
            instance: AGENT,
            request_id: "fr_000000000000",
            source: { chunk_upload_id: id },
          }),
        ),
      );
      expect(e.code).toBe("INTERNAL");
      expect(stillHeld(hermetic, id)).toBe(false);
    }
  });

  test("a closed slot: held bytes and a secret slot's drop are forgotten; a plain drop stays", async () => {
    const { backend, hermetic } = open();
    const plainSlot = backend.files.openRequest(AGENT, fileRequest());
    const secretSlot = backend.files.openRequest(AGENT, fileRequest({ sensitivity: "secret" }));
    await hermetic.files.decline({ instance: AGENT, request_id: plainSlot.request_id });
    await hermetic.files.decline({ instance: AGENT, request_id: secretSlot.request_id });
    const held = hermetic.files.internal.uploads.registerBytes("notes.txt", LOG).upload_id;
    const secretDrop = droppedUpload(hermetic, "key.pem", PEM);
    const plainDrop = droppedUpload(hermetic, "access.log", LOG);
    const put = (request_id: string, id: string) =>
      refusal(
        drain(hermetic.files.put({ instance: AGENT, request_id, source: { chunk_upload_id: id } })),
      );
    expect((await put(plainSlot.request_id, held)).code).toBe("FILE_REQUEST_CLOSED");
    expect((await put(secretSlot.request_id, secretDrop)).code).toBe("FILE_REQUEST_CLOSED");
    expect((await put(plainSlot.request_id, plainDrop)).code).toBe("FILE_REQUEST_CLOSED");
    expect(stillHeld(hermetic, held)).toBe(false);
    expect(stillHeld(hermetic, secretDrop)).toBe(false);
    expect(stillHeld(hermetic, plainDrop)).toBe(true);
  });

  test("D6: key material too large for an SSM slot is refused and forgotten", async () => {
    const { backend, hermetic, calls, slots } = open();
    const slot = backend.files.openRequest(AGENT, fileRequest({ durable: true }));
    const big = new Uint8Array(4000).fill(0x41);
    big.set(new TextEncoder().encode("-----BEGIN PRIVATE KEY-----\n"));
    const upload_id = droppedUpload(hermetic, "big-FIXTURE.pem", big);
    const e = await refusal(
      drain(
        hermetic.files.put({
          instance: AGENT,
          request_id: slot.request_id,
          source: { chunk_upload_id: upload_id },
        }),
      ),
    );
    expect(e.code).toBe("FILE_TOO_LARGE");
    expect(calls).toEqual([]);
    expect(slots()).toEqual([]);
    expect(stillHeld(hermetic, upload_id)).toBe(false);
  });

  test("the registry reports where an upload came from", async () => {
    const registry = createUploadRegistry();
    const { upload_id: drop } = registry.open({ name: "a.log", size: LOG.byteLength });
    registry.append(drop, 0, LOG);
    registry.close(drop);
    const held = registry.registerBytes("b.log", LOG).upload_id;
    const stdin = registry.registerBytes("stdin", LOG, { secretText: true }).upload_id;
    const picked = (await registry.registerPath(writeTemp("picked.log", LOG))).upload_id;
    expect([drop, held, stdin, picked].map((id) => registry.origin(id))).toEqual([
      "chunks",
      "held",
      "secret_text",
      "path",
    ]);
    expect(registry.origin("up_missing")).toBeNull();
  });
});

describe("files.put: a slot from before slugs", () => {
  test("the stem is `secretTextSlug` of keys[0], suffix dropped, as the box derives it", async () => {
    const { backend, hermetic, fleet } = open();
    const request = backend.files.request.bind(backend.files);
    backend.files.request = async (agent, id, opts) => {
      const slot = await request(agent, id, opts);
      delete slot.slug;
      return slot;
    };
    const slot = backend.files.openRequest(AGENT, secretRequest());
    const upload_id = cliStdinUpload(hermetic, `GITHUB_TOKEN=${TOKEN}\n`);
    const done = fulfilled(
      await drain(
        hermetic.files.put({
          instance: AGENT,
          request_id: slot.request_id,
          source: { chunk_upload_id: upload_id },
        }),
      ),
    );
    expect(done.ssm_slot).toBe("env-github");
    expect(backend.params.has(agentParamPath(fleet, AGENT, "env-github"))).toBe(true);
  });
});

describe("MemoryFiles text secrets, held to the box's rules", () => {
  test("the slug is `secretTextSlug`; another key set on the same slug gets -2, -3", () => {
    const { backend } = open();
    const a = backend.files.openRequest(AGENT, secretRequest());
    const again = backend.files.openRequest(AGENT, secretRequest());
    const b = backend.files.openRequest(AGENT, secretRequest({ keys: ["GITHUB_API_KEY"] }));
    const c = backend.files.openRequest(AGENT, secretRequest({ keys: ["X"], slug: "github" }));
    const db = backend.files.openRequest(AGENT, secretRequest({ keys: ["DATABASE_URL"] }));
    expect([a.slug, again.slug, b.slug, c.slug, db.slug]).toEqual([
      "github",
      "github",
      "github-2",
      "github-3",
      "database-url",
    ]);
  });

  test("a key named twice, or over 16 required and optional together, is refused at open", () => {
    const { backend } = open();
    expect(() =>
      backend.files.openRequest(AGENT, secretRequest({ keys: ["A"], optional_keys: ["A"] })),
    ).toThrow("A is named twice");
    const keys = Array.from({ length: 10 }, (_, i) => `K${i}`);
    const optional_keys = Array.from({ length: 7 }, (_, i) => `O${i}`);
    expect(() => backend.files.openRequest(AGENT, secretRequest({ keys, optional_keys }))).toThrow(
      "at most 16 keys",
    );
  });

  test("just this once lands in the request's drop as <slug>.env, never the durable directory", async () => {
    const { backend, hermetic } = open();
    const slot = backend.files.openRequest(AGENT, secretRequest({ durable: false }));
    const upload_id = cliStdinUpload(hermetic, `${TOKEN}\n`);
    const done = fulfilled(
      await drain(
        hermetic.files.put({
          instance: AGENT,
          request_id: slot.request_id,
          source: { chunk_upload_id: upload_id },
        }),
      ),
    );
    expect(done.result.path).toBe(`${FILES_DROP_DIR}/${slot.request_id}/github.env`);
  });

  test("/secret takes only this request's own slot and name, durable, canonical", async () => {
    const { backend, fleet } = open();
    const slot = backend.files.openRequest(AGENT, secretRequest());
    const id = slot.request_id;
    const canonical = `GITHUB_TOKEN="${TOKEN}"\n`;
    const put = (ssm: string, name: string, text: string) =>
      backend.params.set(agentParamPath(fleet, AGENT, ssm), envelopeFor(name, text));
    const ask = (body: { ssm_slot: string; name: string }) =>
      refusal(backend.files.secret(AGENT, id, body, {}));

    put("env-other", "other.env", canonical);
    expect((await ask({ ssm_slot: "env-other", name: "github.env" })).message).toContain(
      "this request's own slot, env-github",
    );
    expect((await ask({ ssm_slot: "env-github", name: "other.env" })).message).toContain(
      "is named github.env",
    );
    // Guards run before the slot is taken: nothing recorded against it.
    expect((await backend.files.request(AGENT, id, {})).rejected).toBeUndefined();

    put("env-github", "other.env", canonical);
    expect((await ask({ ssm_slot: "env-github", name: "github.env" })).message).toContain(
      "not for this request",
    );
    put("env-github", "github.env", `GITHUB_TOKEN=${TOKEN}\n`);
    const loose = await ask({ ssm_slot: "env-github", name: "github.env" });
    expect(loose.message).toContain("canonical");
    expect(loose.message).not.toContain(TOKEN);

    put("env-github", "github.env", canonical);
    const ok = await backend.files.secret(
      AGENT,
      id,
      { ssm_slot: "env-github", name: "github.env" },
      {},
    );
    expect(ok.path).toBe(`${FILES_SECRET_DIR}/github.env`);
    expect(ok.keys).toEqual(["GITHUB_TOKEN"]);
  });

  test("/secret is refused for a request opened just this once", async () => {
    const { backend, fleet } = open();
    const slot = backend.files.openRequest(AGENT, secretRequest({ durable: false }));
    backend.params.set(
      agentParamPath(fleet, AGENT, "env-github"),
      envelopeFor("github.env", `GITHUB_TOKEN="${TOKEN}"\n`),
    );
    const e = await refusal(
      backend.files.secret(AGENT, slot.request_id, { ssm_slot: "env-github", name: "github.env" }, {}),
    );
    expect(e.code).toBe("VALIDATION");
    expect(e.message).toContain("this once");
    expect((await backend.files.request(AGENT, slot.request_id, {})).state).toBe("open");
  });
});

describe("files.put: the name the box is sent agrees with what was checked here", () => {
  /** A DER sequence, not UTF-8: key material only under a `.p12`/`.pfx`/`.key` name (D6). */
  const DER = new Uint8Array([0x30, 0x82, 0x01, 0xff, 0xfe, 0x02, 0x01, 0x03, 0x46, 0x49, 0x58]);

  test("a hint with another extension gives way: a DER .p12 is never filed in the inbox as `cert`", async () => {
    const { backend, hermetic, calls, slots } = open();
    const slot = backend.files.openRequest(AGENT, fileRequest({ name_hint: "cert" }));
    const path = writeTemp("client.p12", DER);
    const done = fulfilled(
      await drain(
        hermetic.files.put({ instance: AGENT, request_id: slot.request_id, source: { path } }),
      ),
    );
    expect(done.result.class).toBe("secret");
    expect(done.result.path).toBe(`${FILES_DROP_DIR}/${slot.request_id}/client.p12`);
    expect(calls.map((c) => c.method)).toEqual(["fulfil"]);
    expect(backend.files.committed(AGENT)).toEqual([]);
    expect(slots()).toEqual([]);
  });

  test("a hint the accept list would refuse gives way: a PEM for accept .pem keeps its own name", async () => {
    const { backend, hermetic } = open();
    const slot = backend.files.openRequest(
      AGENT,
      fileRequest({ accept: [".pem"], name_hint: "~/.ssh/deploy_key" }),
    );
    const path = writeTemp("key.pem", PEM);
    const done = fulfilled(
      await drain(
        hermetic.files.put({ instance: AGENT, request_id: slot.request_id, source: { path } }),
      ),
    );
    expect(done.result.class).toBe("secret");
    expect(done.result.path).toBe(`${FILES_DROP_DIR}/${slot.request_id}/key.pem`);
  });

  test("a hint with the same extension, in any case, still names the file", async () => {
    const { backend, hermetic } = open();
    const slot = backend.files.openRequest(AGENT, fileRequest({ name_hint: "keys/Deploy.PEM" }));
    const path = writeTemp("local-copy.pem", PEM);
    const done = fulfilled(
      await drain(
        hermetic.files.put({ instance: AGENT, request_id: slot.request_id, source: { path } }),
      ),
    );
    expect(done.result.path).toBe(`${FILES_DROP_DIR}/${slot.request_id}/Deploy.PEM`);
  });

  test("a secret sent once that the box files as a normal file is deleted again and refused", async () => {
    const { backend, hermetic } = open();
    // A box that ignores the sniff, as one disagreeing with this laptop would.
    const fulfil = backend.files.fulfil.bind(backend.files);
    backend.files.fulfil = (agent, id, upload, opts) =>
      fulfil(agent, id, upload, { ...opts, notSecret: true });
    const slot = backend.files.openRequest(AGENT, fileRequest());
    const path = writeTemp("misfiled-FIXTURE.pem", PEM);
    const e = await refusal(
      drain(hermetic.files.put({ instance: AGENT, request_id: slot.request_id, source: { path } })),
    );
    expect(e.code).toBe("INTERNAL");
    expect(e.message).toContain("deleted again");
    expect(e.message).not.toContain("misfiled-FIXTURE");
    expect(e.details?.["removed"]).toBe(true);
    expect(backend.files.committed(AGENT)).toEqual([]);
  });
});

describe("files.put: replacing a stored durable secret is the operator's choice", () => {
  /** Counts SSM writes: the refusal must come before any. */
  function countPuts(backend: MemoryBackend): () => number {
    let puts = 0;
    const put = backend.secrets.put.bind(backend.secrets);
    backend.secrets.put = async (path, value, opts) => {
      puts += 1;
      return put(path, value, opts);
    };
    return () => puts;
  }

  test("a file secret onto an occupied slot is CONFLICT before any write; the box is never asked", async () => {
    const { backend, hermetic, calls, fleet } = open();
    const puts = countPuts(backend);
    const param = agentParamPath(fleet, AGENT, "file-deploy-pem");
    const before = envelopeFor("deploy.pem", "FIXTURE-previous");
    backend.params.set(param, before);
    const slot = backend.files.openRequest(
      AGENT,
      fileRequest({ sensitivity: "secret", name_hint: "~/keys/deploy.pem" }),
    );
    const path = writeTemp("FIXTURE-dropped-name.pem", PEM);
    const e = await refusal(
      drain(hermetic.files.put({ instance: AGENT, request_id: slot.request_id, source: { path } })),
    );
    expect(e.code).toBe("CONFLICT");
    // Head-neutral: how to say yes is each head's own (the CLI adds --replace).
    expect(e.message).toBe("A stored secret file-deploy-pem already exists on atlas. Replace it?");
    expect(e.message).not.toContain("FIXTURE-dropped-name");
    expect(e.details).toEqual({ ssm_slot: "file-deploy-pem", replace_required: true });
    expect(puts()).toBe(0);
    expect(calls).toEqual([]);
    expect(backend.params.get(param)).toBe(before);
    expect((await backend.files.request(AGENT, slot.request_id, {})).state).toBe("open");
  });

  test("a secret stored between the check and the write is still CONFLICT, never written over", async () => {
    const { backend, hermetic, calls, fleet } = open();
    const param = agentParamPath(fleet, AGENT, "file-deploy-pem");
    const raced = envelopeFor("deploy.pem", "FIXTURE-raced");
    // Another writer lands the slot after the exists check, before the write.
    const exists = backend.secrets.exists.bind(backend.secrets);
    backend.secrets.exists = async (path) => {
      const answer = await exists(path);
      if (path === param) backend.params.set(param, raced);
      return answer;
    };
    const overwrites: (boolean | undefined)[] = [];
    const put = backend.secrets.put.bind(backend.secrets);
    backend.secrets.put = async (path, value, opts) => {
      overwrites.push(opts?.overwrite);
      return put(path, value, opts);
    };
    const slot = backend.files.openRequest(
      AGENT,
      fileRequest({ sensitivity: "secret", name_hint: "deploy.pem" }),
    );
    const path = writeTemp("deploy.pem", PEM);
    const e = await refusal(
      drain(hermetic.files.put({ instance: AGENT, request_id: slot.request_id, source: { path } })),
    );
    expect(e.code).toBe("CONFLICT");
    expect(e.details).toEqual({ ssm_slot: "file-deploy-pem", replace_required: true });
    expect(overwrites).toEqual([false]);
    expect(backend.params.get(param)).toBe(raced);
    expect(calls).toEqual([]);
    expect((await backend.files.request(AGENT, slot.request_id, {})).state).toBe("open");
  });

  test("replace: true writes with overwrite on", async () => {
    const { backend, hermetic } = open();
    const overwrites: (boolean | undefined)[] = [];
    const put = backend.secrets.put.bind(backend.secrets);
    backend.secrets.put = async (path, value, opts) => {
      overwrites.push(opts?.overwrite);
      return put(path, value, opts);
    };
    const slot = backend.files.openRequest(
      AGENT,
      fileRequest({ sensitivity: "secret", name_hint: "deploy.pem" }),
    );
    const path = writeTemp("deploy.pem", PEM);
    await drain(
      hermetic.files.put({
        instance: AGENT,
        request_id: slot.request_id,
        source: { path },
        replace: true,
      }),
    );
    expect(overwrites).toEqual([true]);
  });

  test("a native pick is kept for the Replace that follows; a drop's bytes are not", async () => {
    const { backend, hermetic, fleet } = open();
    backend.params.set(
      agentParamPath(fleet, AGENT, "file-deploy-pem"),
      envelopeFor("deploy.pem", "FIXTURE-previous"),
    );
    const slot = backend.files.openRequest(
      AGENT,
      fileRequest({ sensitivity: "secret", name_hint: "deploy.pem" }),
    );
    const uploads = hermetic.files.internal.uploads;
    const picked = await uploads.registerPath(writeTemp("deploy.pem", PEM));
    const put = (upload_id: string, replace?: true) =>
      drain(
        hermetic.files.put({
          instance: AGENT,
          request_id: slot.request_id,
          source: { chunk_upload_id: upload_id },
          ...(replace ? { replace } : {}),
        }),
      );
    expect((await refusal(put(picked.upload_id))).details?.["replace_required"]).toBe(true);
    const dropped = droppedUpload(hermetic, "deploy.pem", PEM);
    expect((await refusal(put(dropped))).details?.["replace_required"]).toBe(true);
    expect(stillHeld(hermetic, dropped)).toBe(false);
    // The pick was kept: sent again with replace, it answers the request, and is consumed.
    expect(fulfilled(await put(picked.upload_id, true)).ssm_slot).toBe("file-deploy-pem");
    expect(stillHeld(hermetic, picked.upload_id)).toBe(false);
  });

  test("with replace: true the stored secret is written over, and the box reads it", async () => {
    const { backend, hermetic, fleet } = open();
    const puts = countPuts(backend);
    const param = agentParamPath(fleet, AGENT, "file-deploy-pem");
    backend.params.set(param, envelopeFor("deploy.pem", "FIXTURE-previous"));
    const slot = backend.files.openRequest(
      AGENT,
      fileRequest({ sensitivity: "secret", name_hint: "deploy.pem" }),
    );
    const path = writeTemp("deploy.pem", PEM);
    const done = fulfilled(
      await drain(
        hermetic.files.put({
          instance: AGENT,
          request_id: slot.request_id,
          source: { path },
          replace: true,
        }),
      ),
    );
    expect(done.ssm_slot).toBe("file-deploy-pem");
    expect(puts()).toBe(1);
    const stored = decodeSecretEnvelope(backend.params.get(param) ?? "");
    expect(new TextDecoder().decode(stored?.bytes)).toBe(new TextDecoder().decode(PEM));
  });

  test("a text secret onto an occupied env slot: CONFLICT unasked, rotated with replace", async () => {
    const { backend, hermetic, fleet } = open();
    const puts = countPuts(backend);
    const param = agentParamPath(fleet, AGENT, "env-github");
    backend.params.set(param, envelopeFor("github.env", 'GITHUB_TOKEN="FIXTUREold"\n'));
    const slot = backend.files.openRequest(AGENT, secretRequest());
    const first = cliStdinUpload(hermetic, `GITHUB_TOKEN=${TOKEN}\n`);
    const e = await refusal(
      drain(
        hermetic.files.put({
          instance: AGENT,
          request_id: slot.request_id,
          source: { chunk_upload_id: first },
        }),
      ),
    );
    expect(e.code).toBe("CONFLICT");
    expect(e.details).toEqual({ ssm_slot: "env-github", replace_required: true });
    expect(e.message).not.toContain(TOKEN);
    expect(puts()).toBe(0);
    // The text is forgotten all the same: a retry sends it again.
    expect(stillHeld(hermetic, first)).toBe(false);
    const done = fulfilled(
      await drain(
        hermetic.files.put({
          instance: AGENT,
          request_id: slot.request_id,
          source: { chunk_upload_id: cliStdinUpload(hermetic, `GITHUB_TOKEN=${TOKEN}\n`) },
          replace: true,
        }),
      ),
    );
    expect(done.ssm_slot).toBe("env-github");
    const stored = decodeSecretEnvelope(backend.params.get(param) ?? "");
    expect(readCanonicalSecretEnv(new TextDecoder().decode(stored?.bytes))).toEqual([
      { key: "GITHUB_TOKEN", value: TOKEN },
    ]);
  });
});

describe("files.put: a secret slot opened durable: false", () => {
  test("--secret goes just this once: no SSM write, an existing slot of that name untouched", async () => {
    const { backend, hermetic, calls, fleet } = open();
    const param = agentParamPath(fleet, AGENT, "file-once-pem");
    const before = envelopeFor("once.pem", "FIXTURE-previous");
    backend.params.set(param, before);
    const slot = backend.files.openRequest(
      AGENT,
      fileRequest({ sensitivity: "secret", durable: false }),
    );
    const path = writeTemp("once.pem", PEM);
    const done = fulfilled(
      await drain(
        hermetic.files.put({
          instance: AGENT,
          request_id: slot.request_id,
          source: { path },
          secret: true,
        }),
      ),
    );
    expect(done.ssm_slot).toBeUndefined();
    expect(done.result.class).toBe("secret");
    expect(done.result.path.startsWith(`${FILES_DROP_DIR}/`)).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(["fulfil"]);
    expect(backend.params.get(param)).toBe(before);
  });

  test("the fixture refuses its /secret, a file slot as well as a text one, before taking it", async () => {
    const { backend, fleet } = open();
    backend.params.set(agentParamPath(fleet, AGENT, "file-once-pem"), envelopeFor("once.pem", "x"));
    const slot = backend.files.openRequest(
      AGENT,
      fileRequest({ sensitivity: "secret", durable: false }),
    );
    const e = await refusal(
      backend.files.secret(AGENT, slot.request_id, { ssm_slot: "file-once-pem", name: "once.pem" }, {}),
    );
    expect(e.code).toBe("VALIDATION");
    expect(e.message).toContain("this once");
    expect((await backend.files.request(AGENT, slot.request_id, {})).state).toBe("open");
  });
});

describe("files.put: a durable secret the box took before the put failed", () => {
  test("a new parameter is kept when the box holds the request fulfilled from it", async () => {
    const { backend, hermetic, slots } = open();
    const secret = backend.files.secret.bind(backend.files);
    // The box took it; the answer was lost on the way back.
    backend.files.secret = async (agent, id, body, opts) => {
      await secret(agent, id, body, opts);
      throw new HermeticError("INTERNAL", "atlas: the connection dropped");
    };
    const slot = backend.files.openRequest(AGENT, fileRequest({ sensitivity: "secret" }));
    const path = writeTemp("taken-FIXTURE.pem", PEM);
    const e = await refusal(
      drain(hermetic.files.put({ instance: AGENT, request_id: slot.request_id, source: { path } })),
    );
    expect(e.code).toBe("INTERNAL");
    expect(e.message).toContain("already taken");
    expect(e.details?.["ssm"]).toBe("taken");
    expect(slots()).toEqual([
      `${agentParamPrefix(backend.boundFleetId() as string)}${AGENT}/file-taken-fixture-pem`,
    ]);
  });

  test("a stop after the box took it keeps the parameter too", async () => {
    const { backend, hermetic, slots } = open();
    const controller = new AbortController();
    const secret = backend.files.secret.bind(backend.files);
    backend.files.secret = async (agent, id, body, opts) => {
      await secret(agent, id, body, opts);
      controller.abort();
      throw new HermeticError("ABORTED", "the file transfer was stopped");
    };
    const slot = backend.files.openRequest(AGENT, fileRequest({ sensitivity: "secret" }));
    const path = writeTemp("stopped.pem", PEM);
    const e = await refusal(
      drain(
        hermetic.files.put(
          { instance: AGENT, request_id: slot.request_id, source: { path } },
          { signal: controller.signal },
        ),
      ),
    );
    expect(e.code).toBe("ABORTED");
    expect(slots().length).toBe(1);
  });
});

describe("MemoryFiles text secret slugs follow the box's freeSlug", () => {
  test("a closed request holds nothing", async () => {
    const { backend } = open();
    const first = backend.files.openRequest(AGENT, secretRequest());
    await backend.files.decline(AGENT, first.request_id, undefined, {});
    const other = backend.files.openRequest(AGENT, secretRequest({ keys: ["GITHUB_API_KEY"] }));
    expect(other.slug).toBe("github");
  });

  test("a durable secret holds its slug by its stored keys: other keys get -2, the same keys rotate", async () => {
    const { backend, hermetic } = open();
    const first = backend.files.openRequest(AGENT, secretRequest());
    fulfilled(
      await drain(
        hermetic.files.put({
          instance: AGENT,
          request_id: first.request_id,
          source: { chunk_upload_id: cliStdinUpload(hermetic, `GITHUB_TOKEN=${TOKEN}\n`) },
        }),
      ),
    );
    const other = backend.files.openRequest(AGENT, secretRequest({ keys: ["GITHUB_API_KEY"] }));
    const again = backend.files.openRequest(AGENT, secretRequest());
    expect([other.slug, again.slug]).toEqual(["github-2", "github"]);
  });

  test("a durable file secret named <slug>.env holds the slug (no keys: another secret) until removed", async () => {
    const { backend, hermetic } = open();
    const file = backend.files.openRequest(
      AGENT,
      fileRequest({ sensitivity: "secret", name_hint: "github.env" }),
    );
    const path = writeTemp("github.env", new TextEncoder().encode("FIXTURE=file-secret\n"));
    const done = fulfilled(
      await drain(
        hermetic.files.put({ instance: AGENT, request_id: file.request_id, source: { path } }),
      ),
    );
    expect(done.ssm_slot).toBe("file-github-env");
    const held = backend.files.openRequest(AGENT, secretRequest());
    expect(held.slug).toBe("github-2");
    await backend.files.decline(AGENT, held.request_id, undefined, {});
    // The box lists it with its secrets; removed, it no longer holds the slug.
    const listed = await backend.files.list(AGENT, {});
    const entry = listed.secrets.find((e) => e.name === "github.env");
    expect(entry?.dir).toBe("secret");
    expect(entry?.keys).toBeUndefined();
    await backend.files.remove(AGENT, entry?.id ?? "", {});
    expect((await backend.files.list(AGENT, {})).secrets.length).toBe(0);
    expect(backend.files.openRequest(AGENT, secretRequest()).slug).toBe("github");
  });

  test("a removed durable text secret stops holding its slug for other keys", async () => {
    const { backend, hermetic } = open();
    const first = backend.files.openRequest(AGENT, secretRequest());
    fulfilled(
      await drain(
        hermetic.files.put({
          instance: AGENT,
          request_id: first.request_id,
          source: { chunk_upload_id: cliStdinUpload(hermetic, `GITHUB_TOKEN=${TOKEN}\n`) },
        }),
      ),
    );
    const blocked = backend.files.openRequest(AGENT, secretRequest({ keys: ["GITHUB_API_KEY"] }));
    expect(blocked.slug).toBe("github-2");
    await backend.files.decline(AGENT, blocked.request_id, undefined, {});
    const listed = await backend.files.list(AGENT, {});
    const entry = listed.secrets.find((e) => e.name === "github.env");
    expect(entry?.keys).toEqual(["GITHUB_TOKEN"]);
    await backend.files.remove(AGENT, entry?.id ?? "", {});
    const other = backend.files.openRequest(AGENT, secretRequest({ keys: ["GITHUB_API_KEY"] }));
    expect(other.slug).toBe("github");
  });

  test("a stored key the new request names only as optional is another secret: -2", async () => {
    const { backend, hermetic } = open();
    const both = secretRequest({ keys: ["GITHUB_TOKEN", "GITHUB_HOST"], slug: "github" });
    const first = backend.files.openRequest(AGENT, both);
    fulfilled(
      await drain(
        hermetic.files.put({
          instance: AGENT,
          request_id: first.request_id,
          source: {
            chunk_upload_id: cliStdinUpload(
              hermetic,
              `GITHUB_TOKEN=${TOKEN}\nGITHUB_HOST=FIXTURE.example\n`,
            ),
          },
        }),
      ),
    );
    const optional = backend.files.openRequest(
      AGENT,
      secretRequest({ keys: ["GITHUB_TOKEN"], optional_keys: ["GITHUB_HOST"], slug: "github" }),
    );
    const same = backend.files.openRequest(
      AGENT,
      secretRequest({ keys: ["GITHUB_HOST", "GITHUB_TOKEN"], slug: "github" }),
    );
    expect([optional.slug, same.slug]).toEqual(["github-2", "github"]);
  });
});
