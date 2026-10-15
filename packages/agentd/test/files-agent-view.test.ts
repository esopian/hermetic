/**
 * What the agent's socket shows of a secret, how a text secret's slug is kept
 * off another secret's, and which slots may be filled from SSM.
 *
 * - A secret-class answer (a text secret, a `sensitivity: "secret"` file, or
 *   key material the box filed as a secret) reaches the agent without its
 *   SHA-256 and size, on every socket route; the operator's tailnet routes
 *   keep both.
 * - Two text-secret requests whose keys differ never share a slug, so a
 *   durable fulfil of one cannot overwrite the other; the same keys do.
 * - A secret slot the agent opened with `durable: false` refuses `/secret`.
 */
import { describe, expect, test } from "bun:test";
import type { FileWaitResult } from "@hermetic/core/schema";
import { ENV_SECRET_SLOT_RE, FILES_SECRET_DIR } from "@hermetic/core/shared";
import type { MaterialisedFileSecret } from "../src/files/context.ts";
import { PEM, errorCode, filesBox, openSlot, post, put, sha256 } from "./files-fixture.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

type Socket = Awaited<ReturnType<typeof filesBox>>["socket"];

/** A `materialiseSecret` that serves `slots` (slot → content), running the box's check, and records each call. */
function fakeSsm(slots: Readonly<Record<string, string>>) {
  const calls: string[] = [];
  const materialiseSecret = async (
    slot: string,
    expectName: string,
    check?: (content: Uint8Array) => void,
  ): Promise<MaterialisedFileSecret> => {
    calls.push(slot);
    const text = slots[slot];
    if (text === undefined) throw new Error(`no slot ${slot}`);
    const content = enc(text);
    check?.(content);
    return {
      slot,
      name: expectName,
      path: `${FILES_SECRET_DIR}/${expectName}`,
      sha256: sha256(content),
      bytes: content.byteLength,
    };
  };
  return { calls, materialiseSecret };
}

async function openText(socket: Socket, body: Record<string, unknown>): Promise<string> {
  const res = await socket("/requests", post({ kind: "secret_text", purpose: "a token", ...body }));
  if (res.status !== 201) throw new Error(`open failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as FileWaitResult).request_id;
}

/** Every socket view of a request: the wait, the slot, the listing and its secret entries. */
async function socketViews(socket: Socket, id: string) {
  const wait = (await (await socket(`/requests/${id}/wait?s=0`)).json()) as Record<string, unknown>;
  const slot = (await (await socket(`/requests/${id}`)).json()) as {
    fulfilled?: Record<string, unknown>;
  };
  const listed = (await (await socket("/files")).json()) as {
    requests: { request_id: string; fulfilled?: Record<string, unknown> }[];
    secrets: Record<string, unknown>[];
    inbox: Record<string, unknown>[];
  };
  return { wait, slot, listed };
}

describe("the socket drops a secret's digest and size", () => {
  test("a sensitivity: secret file request: wait, slot, listed slot and secret entry", async () => {
    const { socket, fetch, index } = await filesBox();
    const { request_id } = await openSlot(socket, { sensitivity: "secret" });
    expect((await fetch(`/files/requests/${request_id}`, put(PEM))).status).toBe(200);
    const digest = sha256(PEM);
    expect(index().requests[0]?.fulfilled?.sha256).toBe(digest);

    const { wait, slot, listed } = await socketViews(socket, request_id);
    expect(wait).toMatchObject({ status: "fulfilled", class: "secret" });
    expect(typeof wait.path).toBe("string");
    expect("sha256" in wait || "bytes" in wait).toBe(false);
    expect(slot.fulfilled?.class).toBe("secret");
    expect("sha256" in (slot.fulfilled ?? {}) || "bytes" in (slot.fulfilled ?? {})).toBe(false);
    const listedSlot = listed.requests.find((r) => r.request_id === request_id);
    expect("sha256" in (listedSlot?.fulfilled ?? {}) || "bytes" in (listedSlot?.fulfilled ?? {})).toBe(
      false,
    );
    expect(listed.secrets).toHaveLength(1);
    expect("sha256" in listed.secrets[0]! || "bytes" in listed.secrets[0]!).toBe(false);
    for (const view of [wait, slot, listed]) expect(JSON.stringify(view)).not.toContain(digest);

    // The operator's tailnet view keeps both.
    const operator = (await (await fetch(`/files/requests/${request_id}`)).json()) as {
      fulfilled: { sha256: string; bytes: number };
    };
    expect(operator.fulfilled).toMatchObject({ sha256: digest, bytes: PEM.byteLength });
    const all = (await (await fetch("/files")).json()) as {
      secrets: { sha256: string; bytes: number }[];
    };
    expect(all.secrets[0]).toMatchObject({ sha256: digest, bytes: PEM.byteLength });
  });

  test("key material sent to a normal request is filed as a secret, and stripped the same way", async () => {
    const { socket, fetch } = await filesBox();
    const { request_id } = await openSlot(socket);
    expect((await fetch(`/files/requests/${request_id}`, put(PEM))).status).toBe(200);
    const { wait, slot, listed } = await socketViews(socket, request_id);
    expect(wait.class).toBe("secret");
    expect("sha256" in wait || "bytes" in wait).toBe(false);
    expect("sha256" in (slot.fulfilled ?? {})).toBe(false);
    expect("sha256" in listed.secrets[0]!).toBe(false);
    const consumed = (await (
      await socket(`/requests/${request_id}/consume`, { method: "POST" })
    ).json()) as Record<string, unknown>;
    expect(consumed.status).toBe("consumed");
    expect("sha256" in consumed || "bytes" in consumed).toBe(false);
  });

  test("a normal file keeps its digest and size on the socket", async () => {
    const { socket, fetch } = await filesBox();
    const { request_id } = await openSlot(socket);
    const text = enc("hello, agent\n");
    expect((await fetch(`/files/requests/${request_id}`, put(text))).status).toBe(200);
    const { wait, listed } = await socketViews(socket, request_id);
    expect(wait).toMatchObject({ class: "file", sha256: sha256(text), bytes: text.byteLength });
    expect(listed.inbox[0]).toMatchObject({ sha256: sha256(text), bytes: text.byteLength });
  });

  test("a durable text secret's listed entry has no digest or size; the tailnet's does", async () => {
    const canonical = 'GITHUB_TOKEN="FIXTURE-durable"\n';
    const ssm = fakeSsm({ "env-github": canonical });
    const { socket, fetch } = await filesBox({ materialiseSecret: ssm.materialiseSecret });
    const id = await openText(socket, { keys: ["GITHUB_TOKEN"] });
    const res = await fetch(
      `/files/requests/${id}/secret`,
      post({ ssm_slot: "env-github", name: "github.env" }),
    );
    expect(res.status).toBe(200);
    const { listed } = await socketViews(socket, id);
    expect(listed.secrets).toHaveLength(1);
    expect(listed.secrets[0]).toMatchObject({ name: "github.env", slot: "env-github" });
    expect("sha256" in listed.secrets[0]! || "bytes" in listed.secrets[0]!).toBe(false);
    expect(JSON.stringify(listed)).not.toContain(sha256(enc(canonical)));
    const all = (await (await fetch("/files")).json()) as { secrets: { sha256: string }[] };
    expect(all.secrets[0]?.sha256).toBe(sha256(enc(canonical)));
  });
});

describe("a text secret's slug never lands on another secret's", () => {
  const slugs = (index: () => { requests: { slug?: string }[] }): (string | undefined)[] =>
    index().requests.map((r) => r.slug);

  test("live slots: different keys move on to -2, -3; the same keys, in any order, share", async () => {
    const { socket, index } = await filesBox();
    await openText(socket, { keys: ["GITHUB_TOKEN"], optional_keys: ["GITHUB_HOST"] });
    await openText(socket, { keys: ["GITHUB_API_KEY"] });
    await openText(socket, { keys: ["GITHUB_HOST"], optional_keys: ["GITHUB_TOKEN"], slug: "github" });
    await openText(socket, { keys: ["OTHER"], slug: "github" });
    expect(slugs(index)).toEqual(["github", "github-2", "github", "github-3"]);
  });

  test("a closed slot holds nothing", async () => {
    const { socket, fetch, index } = await filesBox();
    const first = await openText(socket, { keys: ["GITHUB_TOKEN"] });
    expect((await fetch(`/files/requests/${first}/decline`, post({}))).status).toBe(200);
    await openText(socket, { keys: ["GITHUB_API_KEY"] });
    expect(slugs(index)).toEqual(["github", "github"]);
  });

  test("a durable secret holds its slug: other keys get -2, the same keys replace it", async () => {
    const ssm = fakeSsm({ "env-github": 'GITHUB_TOKEN="FIXTURE-one"\n' });
    const { socket, fetch, index } = await filesBox({ materialiseSecret: ssm.materialiseSecret });
    const first = await openText(socket, { keys: ["GITHUB_TOKEN"] });
    const done = await fetch(
      `/files/requests/${first}/secret`,
      post({ ssm_slot: "env-github", name: "github.env" }),
    );
    expect(done.status).toBe(200);
    await openText(socket, { keys: ["GITHUB_API_KEY"] });
    await openText(socket, { keys: ["GITHUB_TOKEN"] });
    expect(slugs(index)).toEqual(["github", "github-2", "github"]);
  });

  test("a secret file named <slug>.env holds the slug too: its keys are unknown", async () => {
    const ssm = fakeSsm({ "file-github-env": "FIXTURE-not-a-dotenv\n" });
    const { socket, fetch, index } = await filesBox({ materialiseSecret: ssm.materialiseSecret });
    const { request_id } = await openSlot(socket, { sensitivity: "secret" });
    const done = await fetch(
      `/files/requests/${request_id}/secret`,
      post({ ssm_slot: "file-github-env", name: "github.env" }),
    );
    expect(done.status).toBe(200);
    await openText(socket, { keys: ["GITHUB_TOKEN"] });
    expect(index().requests[1]?.slug).toBe("github-2");
  });

  test("a disambiguated slug stays a valid slot slug at the 48-character limit", async () => {
    const { socket, index } = await filesBox();
    const long = "a".repeat(48);
    await openText(socket, { keys: ["ONE"], slug: long });
    await openText(socket, { keys: ["TWO"], slug: long });
    const second = index().requests[1]?.slug as string;
    expect(second).toBe(`${"a".repeat(46)}-2`);
    expect(ENV_SECRET_SLOT_RE.test(`env-${second}`)).toBe(true);
  });
});

describe("a secret slot opened durable: false refuses a durable fulfil", () => {
  test.each([
    [
      "a text secret",
      { kind: "secret_text", keys: ["GITHUB_TOKEN"], durable: false },
      "env-github",
      "github.env",
    ],
    ["a secret file", { sensitivity: "secret", durable: false }, "file-deploy-pem", "deploy.pem"],
  ])("%s: 400 before SSM is read, the slot still open", async (_label, body, ssm_slot, name) => {
    const ssm = fakeSsm({ [ssm_slot]: 'GITHUB_TOKEN="FIXTURE-x"\n' });
    const { socket, fetch, index } = await filesBox({ materialiseSecret: ssm.materialiseSecret });
    const res = await socket("/requests", post({ purpose: "a secret", ...body }));
    const { request_id } = (await res.json()) as FileWaitResult;
    const refused = await fetch(`/files/requests/${request_id}/secret`, post({ ssm_slot, name }));
    expect(refused.status).toBe(400);
    expect(await errorCode(refused)).toBe("VALIDATION");
    expect(ssm.calls).toEqual([]);
    expect(index().requests[0]?.state).toBe("open");
  });

  test("a normal file slot may still be kept as a durable secret (files put --secret)", async () => {
    const ssm = fakeSsm({ "file-deploy-pem": "FIXTURE-pem\n" });
    const { socket, fetch } = await filesBox({ materialiseSecret: ssm.materialiseSecret });
    const { request_id } = await openSlot(socket);
    const res = await fetch(
      `/files/requests/${request_id}/secret`,
      post({ ssm_slot: "file-deploy-pem", name: "deploy.pem" }),
    );
    expect(res.status).toBe(200);
    expect(ssm.calls).toEqual(["file-deploy-pem"]);
  });
});
