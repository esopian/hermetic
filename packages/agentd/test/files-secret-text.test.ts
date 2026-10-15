/**
 * Text secrets (`request_secret`, plan §06b) on the box: the socket opens a
 * `secret_text` slot, the tailnet fills it — "just this once" through `PUT`
 * with the operator's text, or durably from the request's own `env-<slug>` SSM
 * slot — and the long-poll hands the agent key names and a `load` line.
 *
 * What is pinned: the box's parse is authoritative and runs against the
 * slot's own keys, so an unrequested key (D10) or a missing one leaves the slot
 * open with nothing written; the stored form is canonical; a durable slot must
 * be the request's own and re-parse to itself; and no value reaches a reply, a
 * wait result, an audit line or a refusal.
 */
import { describe, expect, test } from "bun:test";
import { GetParameterCommand, GetParametersByPathCommand } from "@aws-sdk/client-ssm";
import type { FileWaitResult } from "@hermetic/core/schema";
import {
  FILES_DROP_DIR,
  FILES_LIMITS,
  FILES_SECRET_AS_HEADER,
  FILES_SECRET_DIR,
  FILES_TTL,
  encodeSecretEnvelope,
} from "@hermetic/core/shared";
import { makeAws } from "../src/aws.ts";
import { materialiseAllFileSecrets, materialiseFileSecret } from "../src/files/secrets.ts";
import { FakeHost } from "./fake-host.ts";
import { errorCode, filesBox, post, put, sha256 } from "./files-fixture.ts";
import { RecordingSink, TEST_AGENTS_TABLE, TEST_EVENTS_TABLE, TEST_NAME } from "./fixtures.ts";

const PREFIX = "/hermes/fxtr0001/research-1/";
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** An SSM double holding `slots` under `PREFIX`, for both the one-slot read and the listing. */
function ssmWith(slots: Readonly<Record<string, string>>): RecordingSink {
  const ssm = new RecordingSink();
  ssm.byCommand.set("GetParameterCommand", (command) => {
    const name = (command as GetParameterCommand).input.Name ?? "";
    const value = slots[name.slice(PREFIX.length)];
    if (value === undefined) {
      const e = new Error("Parameter not found");
      e.name = "ParameterNotFound";
      return e;
    }
    return { Parameter: { Value: value } };
  });
  ssm.byCommand.set("GetParametersByPathCommand", () => ({
    Parameters: Object.entries(slots).map(([slot, value]) => ({ Name: PREFIX + slot, Value: value })),
  }));
  return ssm;
}

function envelope(name: string, text: string): string {
  const bytes = enc(text);
  return encodeSecretEnvelope({ name, bytes, sha256: sha256(bytes) });
}

/** A box whose `/secret` route reads `slots` through the real `materialiseFileSecret`. */
async function durableBox(slots: Readonly<Record<string, string>>) {
  const host = new FakeHost();
  const ssm = ssmWith(slots);
  const aws = makeAws({
    ddb: new RecordingSink(),
    ssm,
    s3: new RecordingSink(),
    agentsTable: TEST_AGENTS_TABLE,
    eventsTable: TEST_EVENTS_TABLE,
    now: () => host.now(),
  });
  const box = await filesBox({
    host,
    materialiseSecret: (slot, expectName, check) =>
      materialiseFileSecret({ host, aws, paramPrefix: PREFIX }, slot, expectName, check),
  });
  return { ...box, ssm };
}

type Socket = Awaited<ReturnType<typeof filesBox>>["socket"];

async function openSecret(socket: Socket, body: Record<string, unknown> = {}): Promise<FileWaitResult> {
  const res = await socket(
    "/requests",
    post({
      kind: "secret_text",
      purpose: "a GitHub token for gh api",
      keys: ["GITHUB_TOKEN"],
      ...body,
    }),
  );
  if (res.status !== 201) throw new Error(`open failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as FileWaitResult;
}

/** A text-secret PUT: the text as the body, `as` in the "Treat as" header when given. */
function putText(text: string, as?: string): RequestInit {
  return put(enc(text), as === undefined ? {} : { [FILES_SECRET_AS_HEADER]: as });
}

/** Every file under the drop or the durable secret directory. */
function secretFiles(host: FakeHost): string[] {
  return [...host.files.keys()].filter(
    (p) => p.startsWith(`${FILES_DROP_DIR}/`) || p.startsWith(`${FILES_SECRET_DIR}/`),
  );
}

describe("socket POST /requests with kind secret_text", () => {
  test("opens a secret-class, durable slot named from its first key", async () => {
    const { socket, index } = await filesBox();
    const opened = await openSecret(socket, { optional_keys: ["GITHUB_HOST"], task_id: "t-1" });
    expect(opened.status).toBe("open");
    expect(opened.deliver_with).toEqual([
      `hermetic files put ${TEST_NAME} --request ${opened.request_id} --secret-stdin`,
    ]);
    const slot = index().requests[0];
    expect(slot).toMatchObject({
      request_id: opened.request_id,
      kind: "secret_text",
      sensitivity: "secret",
      durable: true,
      keys: ["GITHUB_TOKEN"],
      optional_keys: ["GITHUB_HOST"],
      slug: "github",
      input: "auto",
      accept: [],
      max_bytes: FILES_LIMITS.secretTextBytes,
      state: "open",
    });
  });

  test("a given slug is slugged, and durable and input are the agent's to set", async () => {
    const { socket, index } = await filesBox();
    await openSecret(socket, { slug: "Prod GitHub.env", durable: false, input: "multi" });
    expect(index().requests[0]).toMatchObject({ slug: "prod-github", durable: false, input: "multi" });
  });

  test.each([
    ["a lower-case key", { keys: ["github_token"] }],
    ["no keys", { keys: [] }],
    ["17 keys", { keys: Array.from({ length: 17 }, (_, i) => `KEY_${i}`) }],
    [
      "more than 16 required and optional together",
      {
        keys: Array.from({ length: 9 }, (_, i) => `A_${i}`),
        optional_keys: Array.from({ length: 8 }, (_, i) => `B_${i}`),
      },
    ],
    ["a key named twice", { keys: ["GITHUB_TOKEN", "GITHUB_TOKEN"] }],
    ["a key both required and optional", { keys: ["GITHUB_TOKEN"], optional_keys: ["GITHUB_TOKEN"] }],
  ])("%s is refused with 400 and opens nothing", async (_label, body) => {
    const { socket, index } = await filesBox();
    const res = await socket("/requests", post({ kind: "secret_text", purpose: "a token", ...body }));
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("VALIDATION");
    expect(index().requests).toEqual([]);
  });

  test("a body without kind is still a file request", async () => {
    const { socket, index } = await filesBox();
    const res = await socket("/requests", post({ purpose: "the deploy key", keys: ["IGNORED"] }));
    expect(res.status).toBe(201);
    expect(index().requests[0]?.kind).toBe("file");
    expect(index().requests[0]?.keys).toBeUndefined();
  });
});

describe("PUT /files/requests/:id on a secret_text slot (just this once)", () => {
  test("dotenv: parsed, stored canonical in the request's drop as <slug>.env, 0600 for hermes", async () => {
    const { socket, fetch, host, index, audit } = await filesBox();
    const { request_id } = await openSecret(socket);
    const res = await fetch(
      `/files/requests/${request_id}`,
      putText("# from the vault\nexport GITHUB_TOKEN='FIXTURE-dotenv-value'\n"),
    );
    expect(res.status).toBe(200);
    const path = `${FILES_DROP_DIR}/${request_id}/github.env`;
    const canonical = 'GITHUB_TOKEN="FIXTURE-dotenv-value"\n';
    const reply = (await res.json()) as Record<string, unknown>;
    expect(reply).toEqual({
      request_id,
      path,
      sha256: sha256(enc(canonical)),
      bytes: enc(canonical).byteLength,
      class: "secret",
      keys: ["GITHUB_TOKEN"],
      format: "dotenv",
    });
    expect(host.files.get(path)?.content).toBe(canonical);
    expect(host.files.get(path)?.mode).toBe("0600");
    expect(host.commands).toContain(`chown hermes:hermes ${path}`);
    expect([...host.files.keys()].some((p) => p.startsWith("/data/") && p.includes("github"))).toBe(
      false,
    );
    const slot = index().requests[0];
    expect(slot?.state).toBe("fulfilled");
    expect(slot?.fulfilled).toMatchObject({
      path,
      keys: ["GITHUB_TOKEN"],
      format: "dotenv",
      class: "secret",
    });
    expect(slot?.fulfilled?.ssm_slot).toBeUndefined();
    expect(index().entries).toMatchObject([{ dir: "drop", class: "secret", name: "github.env", path }]);
    // The audit names the route and id; never a value, a name or a secret's digest.
    expect(audit.join("\n")).not.toContain("FIXTURE");
    expect(audit.join("\n")).not.toContain("github.env");
    expect(audit.join("\n")).not.toContain(sha256(enc(canonical)).slice(0, 12));
  });

  test("raw: one bare value fills the one required key", async () => {
    const { socket, fetch, host } = await filesBox();
    const { request_id } = await openSecret(socket);
    const res = await fetch(`/files/requests/${request_id}`, putText("FIXTURE-raw-token\n"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { format: string }).format).toBe("raw");
    expect(host.files.get(`${FILES_DROP_DIR}/${request_id}/github.env`)?.content).toBe(
      'GITHUB_TOKEN="FIXTURE-raw-token"\n',
    );
  });

  test("raw by override: a multi-line value whose lines look like KEY=value", async () => {
    const text = "PEM_HEADER=FIXTURE-a\nPEM_BODY=FIXTURE-b\n";
    // Auto reads it as .env lines and refuses both as unrequested keys…
    const auto = await filesBox();
    const first = await openSecret(auto.socket, { keys: ["GH_APP_KEY"] });
    const refused = await auto.fetch(`/files/requests/${first.request_id}`, putText(text));
    expect(refused.status).toBe(422);
    expect(auto.index().requests[0]?.state).toBe("open");
    // …and the operator's "Treat as: Raw value" makes it the one key's value.
    const forced = await filesBox();
    const second = await openSecret(forced.socket, { keys: ["GH_APP_KEY"] });
    const res = await forced.fetch(`/files/requests/${second.request_id}`, putText(text, "raw"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { format: string }).format).toBe("raw");
    expect(forced.host.files.get(`${FILES_DROP_DIR}/${second.request_id}/gh-app.env`)?.content).toBe(
      // Sh-safe canonical form: the newline is kept, inside the quotes.
      'GH_APP_KEY="PEM_HEADER=FIXTURE-a\nPEM_BODY=FIXTURE-b"\n',
    );
  });

  test("the stored file is safe to source: $ and backticks are escaped", async () => {
    const { socket, fetch, host } = await filesBox();
    const { request_id } = await openSecret(socket);
    const res = await fetch(`/files/requests/${request_id}`, putText("GITHUB_TOKEN='FIXTURE$1`id`'\n"));
    expect(res.status).toBe(200);
    expect(host.files.get(`${FILES_DROP_DIR}/${request_id}/github.env`)?.content).toBe(
      'GITHUB_TOKEN="FIXTURE\\$1\\`id\\`"\n',
    );
  });

  test("dotenv by override: a bare value is not a KEY=value line", async () => {
    const { socket, fetch, index } = await filesBox();
    const { request_id } = await openSecret(socket);
    const res = await fetch(`/files/requests/${request_id}`, putText("FIXTURE-bare\n", "dotenv"));
    expect(res.status).toBe(422);
    expect(index().requests[0]?.state).toBe("open");
  });

  test("a Treat-as header outside auto, raw and dotenv is 400, and the slot stays open", async () => {
    const { socket, fetch, host, index } = await filesBox();
    const { request_id } = await openSecret(socket);
    const res = await fetch(`/files/requests/${request_id}`, putText("FIXTURE-x\n", "yaml"));
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("VALIDATION");
    expect(index().requests[0]?.state).toBe("open");
    expect(secretFiles(host)).toEqual([]);
  });

  test("D10: a key the request did not name is refused; the slot stays open and nothing is written", async () => {
    const { socket, fetch, host, index, audit } = await filesBox();
    const { request_id } = await openSecret(socket);
    const res = await fetch(
      `/files/requests/${request_id}`,
      putText("GITHUB_TOKEN=FIXTURE-wanted\nAWS_SECRET_ACCESS_KEY=FIXTURE-unwanted\n"),
    );
    expect(res.status).toBe(422);
    const body = await res.text();
    expect(body).toContain("Line 2 sets a key that was not requested");
    expect(body).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(body).not.toContain("FIXTURE");
    const slot = index().requests[0];
    expect(slot?.state).toBe("open");
    expect(slot?.rejected?.code).toBe("VALIDATION");
    expect(slot?.rejected?.message).toContain("Line 2 sets a key that was not requested");
    expect(slot?.rejected?.message).not.toContain("FIXTURE");
    expect(slot?.fulfilled).toBeUndefined();
    expect(index().entries).toEqual([]);
    expect(secretFiles(host)).toEqual([]);
    expect(audit.join("\n")).not.toContain("FIXTURE");
    // Still open, so a corrected paste lands.
    const again = await fetch(
      `/files/requests/${request_id}`,
      putText("GITHUB_TOKEN=FIXTURE-wanted\n"),
    );
    expect(again.status).toBe(200);
  });

  test("a missing required key is refused the same way", async () => {
    const { socket, fetch, host, index } = await filesBox();
    const { request_id } = await openSecret(socket, { keys: ["DB_USER", "DB_PASS"] });
    const res = await fetch(`/files/requests/${request_id}`, putText("DB_USER=FIXTURE-user\n"));
    expect(res.status).toBe(422);
    expect(index().requests[0]?.state).toBe("open");
    expect(index().requests[0]?.rejected?.message).toContain("DB_PASS is missing");
    expect(secretFiles(host)).toEqual([]);
  });

  test("over 64 KiB is refused before a byte is read", async () => {
    const { socket, fetch, index } = await filesBox();
    const { request_id } = await openSecret(socket);
    const big = "x".repeat(FILES_LIMITS.secretTextBytes + 1);
    const res = await fetch(`/files/requests/${request_id}`, putText(big));
    expect(res.status).toBe(413);
    expect(index().requests[0]?.state).toBe("open");
  });

  test("the wait result has key names, the format and a load line, and no value or digest", async () => {
    const { socket, fetch } = await filesBox();
    const { request_id } = await openSecret(socket);
    await fetch(`/files/requests/${request_id}`, putText("GITHUB_TOKEN=FIXTURE-value\n"));
    const res = await socket(`/requests/${request_id}/wait?s=0`);
    const text = await res.text();
    expect(text).not.toContain("FIXTURE");
    const wait = JSON.parse(text) as FileWaitResult;
    const path = `${FILES_DROP_DIR}/${request_id}/github.env`;
    expect(wait).toMatchObject({
      status: "fulfilled",
      request_id,
      path,
      class: "secret",
      keys: ["GITHUB_TOKEN"],
      format: "dotenv",
      load: `set -a; . ${path}; set +a`,
    });
    expect(wait.sha256).toBeUndefined();
    expect(wait.bytes).toBeUndefined();
    expect(wait.deliver_with).toEqual([
      `hermetic files put ${TEST_NAME} --request ${request_id} --secret-stdin`,
    ]);
  });

  test("the socket's slot and listing drop a text secret's digest and size; the tailnet keeps them", async () => {
    const { socket, fetch, index } = await filesBox();
    const { request_id } = await openSecret(socket);
    await fetch(`/files/requests/${request_id}`, putText("GITHUB_TOKEN=FIXTURE-value\n"));
    const stored = index().requests[0]?.fulfilled;
    expect(stored?.sha256).toMatch(/^[0-9a-f]{64}$/);

    const one = (await (await socket(`/requests/${request_id}`)).json()) as {
      fulfilled: Record<string, unknown>;
    };
    expect(one.fulfilled).toMatchObject({ keys: ["GITHUB_TOKEN"], format: "dotenv", class: "secret" });
    expect("sha256" in one.fulfilled).toBe(false);
    expect("bytes" in one.fulfilled).toBe(false);

    const listed = (await (await socket("/files")).json()) as {
      requests: { request_id: string; fulfilled?: Record<string, unknown> }[];
    };
    const slot = listed.requests.find((r) => r.request_id === request_id);
    expect(slot?.fulfilled?.path).toBe(stored?.path);
    expect("sha256" in (slot?.fulfilled ?? {})).toBe(false);
    expect("bytes" in (slot?.fulfilled ?? {})).toBe(false);
    for (const text of [JSON.stringify(one), JSON.stringify(listed.requests)]) {
      expect(text).not.toContain(stored?.sha256 as string);
    }

    // The operator's view over the tailnet is unchanged.
    const operator = (await (await fetch(`/files/requests/${request_id}`)).json()) as {
      fulfilled: { sha256: string; bytes: number };
    };
    expect(operator.fulfilled.sha256).toBe(stored?.sha256 as string);
    expect(operator.fulfilled.bytes).toBe(stored?.bytes as number);
  });

  test("a file request's slot on the socket keeps its digest", async () => {
    const { socket, fetch } = await filesBox();
    const res = await socket("/requests", post({ purpose: "a note" }));
    const { request_id } = (await res.json()) as FileWaitResult;
    const filled = await fetch(`/files/requests/${request_id}`, put(enc("hello, agent\n")));
    expect(filled.status).toBe(200);
    const one = (await (await socket(`/requests/${request_id}`)).json()) as {
      fulfilled: { sha256?: string; bytes?: number };
    };
    expect(one.fulfilled.sha256).toBe(sha256(enc("hello, agent\n")));
    expect(one.fulfilled.bytes).toBe(13);
  });

  test("consume deletes the drop file", async () => {
    const { socket, fetch, host, index } = await filesBox();
    const { request_id } = await openSecret(socket);
    await fetch(`/files/requests/${request_id}`, putText("FIXTURE-token\n"));
    expect(secretFiles(host)).toEqual([`${FILES_DROP_DIR}/${request_id}/github.env`]);
    const res = await socket(`/requests/${request_id}/consume`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as FileWaitResult).status).toBe("consumed");
    expect(secretFiles(host)).toEqual([]);
    expect(index().entries).toEqual([]);
  });
});

describe("POST /files/requests/:id/secret on a secret_text slot (durable)", () => {
  const CANONICAL = 'GITHUB_TOKEN="FIXTURE-durable"\n';

  test("reads its own env-<slug> slot and materialises <slug>.env under the secret dir", async () => {
    const box = await durableBox({ "env-github": envelope("github.env", CANONICAL) });
    const { request_id } = await openSecret(box.socket);
    const res = await box.fetch(
      `/files/requests/${request_id}/secret`,
      post({ ssm_slot: "env-github", name: "github.env", format: "raw" }),
    );
    expect(res.status).toBe(200);
    const path = `${FILES_SECRET_DIR}/github.env`;
    expect(await res.json()).toMatchObject({
      request_id,
      path,
      class: "secret",
      keys: ["GITHUB_TOKEN"],
      format: "raw",
    });
    expect(box.host.files.get(path)?.content).toBe(CANONICAL);
    expect(box.host.files.get(path)?.mode).toBe("0600");
    expect(box.index().requests[0]?.fulfilled).toMatchObject({
      ssm_slot: "env-github",
      keys: ["GITHUB_TOKEN"],
      format: "raw",
    });
    expect(box.index().entries).toMatchObject([
      { dir: "secret", slot: "env-github", name: "github.env" },
    ]);
    const wait = (await (
      await box.socket(`/requests/${request_id}/wait?s=0`)
    ).json()) as FileWaitResult;
    expect(wait.load).toBe(`set -a; . ${path}; set +a`);
    expect(JSON.stringify(wait)).not.toContain("FIXTURE");
  });

  test("format defaults to dotenv", async () => {
    const box = await durableBox({ "env-github": envelope("github.env", CANONICAL) });
    const { request_id } = await openSecret(box.socket);
    await box.fetch(
      `/files/requests/${request_id}/secret`,
      post({ ssm_slot: "env-github", name: "github.env" }),
    );
    expect(box.index().requests[0]?.fulfilled?.format).toBe("dotenv");
  });

  test.each([
    ["another request's env slot", { ssm_slot: "env-other", name: "github.env" }],
    ["a file slot", { ssm_slot: "file-github", name: "github.env" }],
    ["its own slot under another name", { ssm_slot: "env-github", name: "other.env" }],
  ])("%s is refused with 400 before SSM is asked", async (_label, body) => {
    const box = await durableBox({
      "env-github": envelope("github.env", CANONICAL),
      "env-other": envelope("other.env", CANONICAL),
    });
    const { request_id } = await openSecret(box.socket);
    const res = await box.fetch(`/files/requests/${request_id}/secret`, post(body));
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("VALIDATION");
    expect(box.ssm.calls).toEqual([]);
    expect(box.index().requests[0]?.state).toBe("open");
    expect(secretFiles(box.host)).toEqual([]);
  });

  test.each([
    [
      "holds a key the request did not name",
      'AWS_KEY="FIXTURE-x"\nGITHUB_TOKEN="FIXTURE-durable"\n',
      "sets a key that was not requested",
    ],
    ["misses a required key", 'GITHUB_HOST="FIXTURE-h"\n', "GITHUB_TOKEN"],
    ["is not canonical", "GITHUB_TOKEN=FIXTURE-durable\n", "canonical"],
  ])("a slot that %s is refused with 422; nothing written, the slot open", async (_l, text, says) => {
    const box = await durableBox({ "env-github": envelope("github.env", text) });
    const { request_id } = await openSecret(box.socket, { optional_keys: ["GITHUB_HOST"] });
    const res = await box.fetch(
      `/files/requests/${request_id}/secret`,
      post({ ssm_slot: "env-github", name: "github.env" }),
    );
    expect(res.status).toBe(422);
    const body = await res.text();
    expect(body).toContain(says);
    expect(body).not.toContain("FIXTURE");
    expect(box.ssm.commandCalls(GetParameterCommand)).toHaveLength(1);
    expect(box.index().requests[0]?.state).toBe("open");
    expect(box.index().requests[0]?.rejected?.message).not.toContain("FIXTURE");
    expect(secretFiles(box.host)).toEqual([]);
  });

  test("the entry records the stored key names; rotating after its request is swept keeps the slug", async () => {
    const box = await durableBox({ "env-github": envelope("github.env", CANONICAL) });
    const { request_id } = await openSecret(box.socket);
    const done = await box.fetch(
      `/files/requests/${request_id}/secret`,
      post({ ssm_slot: "env-github", name: "github.env" }),
    );
    expect(done.status).toBe(200);
    expect(box.index().entries).toMatchObject([
      { dir: "secret", name: "github.env", keys: ["GITHUB_TOKEN"] },
    ]);
    // The sweeper prunes a closed request a retention period after it ended;
    // the durable entry it stored stays.
    box.host.advance((FILES_TTL.request + FILES_TTL.inbox) * 1000 + 1000);
    await box.service.sweep();
    expect(box.index().requests).toEqual([]);
    expect(box.index().entries).toHaveLength(1);
    // Other keys on the same slug are another secret: -2, as before.
    await openSecret(box.socket, { keys: ["GITHUB_API_KEY"] });
    // The same key is a rotation: the slug the entry holds, not a new env-github-2.
    await openSecret(box.socket);
    expect(box.index().requests.map((r) => r.slug)).toEqual(["github-2", "github"]);
  });

  test("a stored key the new request names only as optional is another secret: -2", async () => {
    const both = 'GITHUB_TOKEN="FIXTURE-durable"\nGITHUB_HOST="FIXTURE-h"\n';
    const box = await durableBox({ "env-github": envelope("github.env", both) });
    const keys = { keys: ["GITHUB_TOKEN", "GITHUB_HOST"], slug: "github" };
    const { request_id } = await openSecret(box.socket, keys);
    const done = await box.fetch(
      `/files/requests/${request_id}/secret`,
      post({ ssm_slot: "env-github", name: "github.env" }),
    );
    expect(done.status).toBe(200);
    expect(box.index().entries[0]?.keys).toEqual(["GITHUB_TOKEN", "GITHUB_HOST"]);
    // GITHUB_HOST optional: a fulfil without it would lose the stored value.
    await openSecret(box.socket, {
      keys: ["GITHUB_TOKEN"],
      optional_keys: ["GITHUB_HOST"],
      slug: "github",
    });
    // The same required keys, in any order, are the same secret.
    await openSecret(box.socket, { keys: ["GITHUB_HOST", "GITHUB_TOKEN"], slug: "github" });
    expect(box.index().requests.map((r) => r.slug)).toEqual(["github", "github-2", "github"]);
  });

  test("a file request records the slot it was fulfilled from too", async () => {
    const box = await durableBox({
      "file-deploy-pem": envelope(
        "deploy.pem",
        "-----BEGIN PRIVATE KEY-----\nFIXTURE\n-----END PRIVATE KEY-----\n",
      ),
    });
    const res = await box.socket(
      "/requests",
      post({ purpose: "the deploy key", sensitivity: "secret" }),
    );
    const { request_id } = (await res.json()) as FileWaitResult;
    const done = await box.fetch(
      `/files/requests/${request_id}/secret`,
      post({ ssm_slot: "file-deploy-pem", name: "deploy.pem" }),
    );
    expect(done.status).toBe(200);
    const fulfilled = box.index().requests[0]?.fulfilled;
    expect(fulfilled?.ssm_slot).toBe("file-deploy-pem");
    expect(fulfilled?.keys).toBeUndefined();
    // A file request may not be filled from an env slot.
    const second = (await (
      await box.socket("/requests", post({ purpose: "x", sensitivity: "secret" }))
    ).json()) as FileWaitResult;
    const refused = await box.fetch(
      `/files/requests/${second.request_id}/secret`,
      post({ ssm_slot: "env-github", name: "github.env" }),
    );
    expect(refused.status).toBe(400);
  });
});

describe("boot and apply materialise env-* slots beside file-*", () => {
  test("a canonical env slot lands as <slug>.env; a non-canonical or misnamed one is skipped by slot name", async () => {
    const host = new FakeHost();
    const log: string[] = [];
    const ssm = ssmWith({
      "env-github": envelope("github.env", 'GITHUB_TOKEN="FIXTURE-boot"\n'),
      "env-loose": envelope("loose.env", "GITHUB_TOKEN=FIXTURE-loose\n"),
      "env-misnamed": envelope("other.env", 'A="FIXTURE-m"\n'),
    });
    const aws = makeAws({
      ddb: new RecordingSink(),
      ssm,
      s3: new RecordingSink(),
      agentsTable: TEST_AGENTS_TABLE,
      eventsTable: TEST_EVENTS_TABLE,
      now: () => host.now(),
    });
    const placed = await materialiseAllFileSecrets({
      host,
      aws,
      paramPrefix: PREFIX,
      log: (m) => void log.push(m),
    });
    expect(placed.map((p) => p.path)).toEqual([`${FILES_SECRET_DIR}/github.env`]);
    expect(host.files.get(`${FILES_SECRET_DIR}/github.env`)?.content).toBe(
      'GITHUB_TOKEN="FIXTURE-boot"\n',
    );
    expect(secretFiles(host)).toEqual([`${FILES_SECRET_DIR}/github.env`]);
    expect(ssm.commandCalls(GetParametersByPathCommand)).toHaveLength(1);
    expect(log).toEqual([
      "file secret env-loose: VALIDATION; skipped",
      "file secret env-misnamed: INTERNAL; skipped",
    ]);
    expect(log.join("\n")).not.toContain("FIXTURE");
  });
});
