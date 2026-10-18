/**
 * The phone's files client against hermeticd's real files routes (§6.4, §9.4).
 *
 * At the root because it reads both sides of the seam: the phone's client
 * (`mobile/src/gateway/files.ts`) on one side, agentd's `makeRpcHandler` with
 * the files service over `FakeHost` (`packages/agentd/test/files-fixture.ts`)
 * on the other, and core's schemas — what each side parses — in between. The
 * phone's `fetch` is bound to the handler, so a request crosses the same
 * whois gate, name rules, digest check and caps it crosses on a box.
 *
 * The request blocks answer an agent's ask the way the phone's cards do: a
 * slot opened over the box's socket (as the Hermes plugin opens one), then
 * read, fulfilled, declined or sent a text secret over the tailnet routes. A
 * text secret's bytes land in the box's tmpfs drop as `secret-text.ts` writes
 * them, and read back through the canonical reader.
 *
 * The last block runs the same client over the phone's fixture kit, whose box
 * is core's fixture files box: its name triggers and `ember` behave as the
 * desktop fixture's do, a fixture turn commits what the client staged, and the
 * `E2E_*REQUEST*`/`E2E_*SECRET*` prompts park a turn on a slot the client answers.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { ChatFrame } from "@hermetic/core/chat-client";
import {
  FileRequest,
  FilesCommitResult,
  FilesFulfilResult,
  FilesStageResult,
} from "@hermetic/core/schema";
import {
  FILES_LIMITS,
  FILES_NAME_HEADER,
  FILES_SECRET_AS_HEADER,
  FILES_SESSION_HEADER,
  HERMES_HOME,
  readCanonicalSecretEnv,
  resolveFilesSettings,
} from "@hermetic/core/shared";
import { makeRpcHandler } from "../packages/agentd/src/rpc.ts";
import { FakeHost } from "../packages/agentd/test/fake-host.ts";
import {
  AGENT_NODE,
  MEMBER,
  OPERATOR_IP,
  PEM,
  PNG,
  TEXT,
  filesBox,
  openSlot,
} from "../packages/agentd/test/files-fixture.ts";
import { TEST_NAME } from "../packages/agentd/test/fixtures.ts";
import { fixtureKit } from "../mobile/src/fixture/index.ts";
import { type PhoneFiles, attachmentsFor, createPhoneFiles } from "../mobile/src/gateway/files.ts";
import type { FetchLike } from "../mobile/src/gateway/hermeticd.ts";
import { resetTunnelChecks } from "../mobile/src/gateway/hermeticd.ts";

const HOST = "fxtr0001-atlas.tail1234.ts.net";

afterEach(() => resetTunnelChecks());

type Handler = (request: Request, peerIp: string) => Promise<Response>;

/**
 * The phone's `fetch`, bound to one box's handler: the tunnel gate's HTTPS
 * probe is answered here (the gate itself is `hermeticd.ts`'s), and every
 * plain-HTTP call is handed to the handler as the phone's tailnet peer.
 * `tamper` may rewrite a request on its way, as a broken link would.
 */
function phoneFetch(
  rpc: Handler,
  opts: { tamper?: (init: RequestInit) => RequestInit; peer?: string } = {},
) {
  const seen: { method: string; path: string; headers: Record<string, string> }[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    if (url.protocol === "https:") return new Response("ok");
    const sent = opts.tamper ? opts.tamper(init ?? {}) : (init ?? {});
    seen.push({
      method: sent.method ?? "GET",
      path: url.pathname,
      headers: { ...((sent.headers ?? {}) as Record<string, string>) },
    });
    return await rpc(new Request(url, sent), opts.peer ?? OPERATOR_IP);
  };
  return { fetch, seen };
}

describe("stage → FilesStageResult", () => {
  test("a small text file stages, and the box's answer parses with the schema", async () => {
    const box = await filesBox();
    const { fetch, seen } = phoneFetch(box.rpc);
    const files = createPhoneFiles({ fetch, host: HOST });
    const staged = await files.stage({ name: "notes.txt", bytes: TEXT, session_id: "s-seam" });
    expect(FilesStageResult.parse(staged)).toEqual(staged);
    expect(staged).toMatchObject({ name: "notes.txt", bytes: TEXT.byteLength, class: "file" });
    expect(seen[0]).toMatchObject({ method: "PUT", path: "/files/stage/notes.txt" });
    expect(seen[0]?.headers[FILES_SESSION_HEADER]).toBe("s-seam");
    expect(box.index().entries.map((e) => e.id)).toContain(staged.id);
  });

  test("bytes changed on the way are FILE_DIGEST_MISMATCH from the box", async () => {
    const box = await filesBox();
    const { fetch } = phoneFetch(box.rpc, {
      tamper: (init) => {
        const bytes = (init.body as Uint8Array).slice();
        bytes[0] = (bytes[0] ?? 0) ^ 0xff;
        return { ...init, body: bytes };
      },
    });
    const files = createPhoneFiles({ fetch, host: HOST });
    await expect(files.stage({ name: "notes.txt", bytes: TEXT })).rejects.toMatchObject({
      code: "FILE_DIGEST_MISMATCH",
      details: { status: 422 },
    });
  });

  test("over the cap is FILE_TOO_LARGE on the phone, and nothing reaches the box", async () => {
    const box = await filesBox();
    const { fetch, seen } = phoneFetch(box.rpc);
    const files = createPhoneFiles({ fetch, host: HOST });
    const big = new Uint8Array(FILES_LIMITS.imageBytes + 1);
    big.set(PNG);
    await expect(files.stage({ name: "huge.png", bytes: big })).rejects.toMatchObject({
      code: "FILE_TOO_LARGE",
    });
    expect(seen).toEqual([]);
    expect(box.host.streamWrites).toEqual([]);
  });

  test("over a fleet's lower cap is FILE_TOO_LARGE from the box", async () => {
    const box = await filesBox({ settings: () => resolveFilesSettings({ files: { max_bytes: 4 } }) });
    const files = createPhoneFiles({ fetch: phoneFetch(box.rpc).fetch, host: HOST });
    await expect(files.stage({ name: "notes.txt", bytes: TEXT })).rejects.toMatchObject({
      code: "FILE_TOO_LARGE",
      details: { status: 413 },
    });
  });

  test("a tagged node is FORBIDDEN", async () => {
    const box = await filesBox({ peer: AGENT_NODE });
    const files = createPhoneFiles({ fetch: phoneFetch(box.rpc).fetch, host: HOST });
    await expect(files.stage({ name: "notes.txt", bytes: TEXT })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("commit → FilesCommitResult", () => {
  test("the turn's commit hits /files/<id>/commit and moves the file into the inbox", async () => {
    const box = await filesBox();
    const { fetch, seen } = phoneFetch(box.rpc);
    const files = createPhoneFiles({ fetch, host: HOST });
    const staged = await files.stage({ name: "notes.txt", bytes: TEXT });
    const attachments = attachmentsFor([staged], files);
    expect(attachments.ids).toEqual([staged.id]);
    const committed = await attachments.commit(staged.id, "s-turn", undefined);
    expect(FilesCommitResult.parse(committed)).toEqual(committed);
    expect(seen.at(-1)).toMatchObject({ method: "POST", path: `/files/${staged.id}/commit` });
    expect(committed).toMatchObject({ id: staged.id, name: "notes.txt", sha256: staged.sha256 });
    expect(committed.path).toBe(`${HERMES_HOME}/${committed.rel}`);
    const entry = box.index().entries.find((e) => e.id === staged.id);
    expect(entry).toMatchObject({ dir: "inbox", session_id: "s-turn" });
  });

  test("an id the box does not hold is FILE_NOT_FOUND", async () => {
    const box = await filesBox();
    const files = createPhoneFiles({ fetch: phoneFetch(box.rpc).fetch, host: HOST });
    await expect(files.commit("f_abcdefghij12", "s-turn", undefined)).rejects.toMatchObject({
      code: "FILE_NOT_FOUND",
    });
  });
});

describe("content → the entry's bytes, verified", () => {
  /** Stage and commit `bytes` as `name`: an inbox entry, as a sent attachment leaves one. */
  async function committed(files: PhoneFiles, name: string, bytes: Uint8Array) {
    const staged = await files.stage({ name, bytes });
    await attachmentsFor([staged], files).commit(staged.id, "s-content", undefined);
    return staged;
  }

  test("an image comes back as the box serves it, its digest checked", async () => {
    const box = await filesBox();
    const { fetch, seen } = phoneFetch(box.rpc);
    const files = createPhoneFiles({ fetch, host: HOST });
    const staged = await committed(files, "chart.png", PNG);
    const got = await files.content(staged.id, { image: true });
    expect(seen.at(-1)).toMatchObject({ method: "GET", path: `/files/${staged.id}/content` });
    expect(got.sha256).toBe(staged.sha256);
    expect(got.mime).toBe("image/png");
    expect([...got.bytes]).toEqual([...PNG]);
  });

  test("a body changed on the way is FILE_DIGEST_MISMATCH", async () => {
    const box = await filesBox();
    const files = createPhoneFiles({ fetch: phoneFetch(box.rpc).fetch, host: HOST });
    const staged = await committed(files, "chart.png", PNG);
    // The same box, read through a link that flips one byte of the answer.
    const { fetch } = phoneFetch(box.rpc);
    const tampering: FetchLike = async (input, init) => {
      const res = await fetch(input, init);
      if (!String(input).endsWith("/content")) return res;
      const bytes = new Uint8Array(await res.arrayBuffer());
      bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
      return new Response(bytes, { status: res.status, headers: res.headers });
    };
    const reader = createPhoneFiles({ fetch: tampering, host: HOST });
    await expect(reader.content(staged.id, { image: true })).rejects.toMatchObject({
      code: "FILE_DIGEST_MISMATCH",
    });
  });

  test("a file that is not an image is refused for a preview, and read for a save", async () => {
    const box = await filesBox();
    const files = createPhoneFiles({ fetch: phoneFetch(box.rpc).fetch, host: HOST });
    const staged = await committed(files, "notes.txt", TEXT);
    await expect(files.content(staged.id, { image: true })).rejects.toMatchObject({
      code: "FILE_TYPE_REJECTED",
    });
    const got = await files.content(staged.id);
    expect(got.sha256).toBe(staged.sha256);
    expect(new TextDecoder().decode(got.bytes)).toBe(new TextDecoder().decode(TEXT));
  });

  test("an id the box does not hold is FILE_NOT_FOUND", async () => {
    const box = await filesBox();
    const files = createPhoneFiles({ fetch: phoneFetch(box.rpc).fetch, host: HOST });
    await expect(files.content("f_abcdefghij12")).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
  });
});

describe("capability", () => {
  test("a box with the files service says so in /healthz", async () => {
    const box = await filesBox();
    const files = createPhoneFiles({ fetch: phoneFetch(box.rpc).fetch, host: HOST });
    expect(await files.capability()).toBe(true);
  });

  test("a box without it: capability() is false, and a stage is UNSUPPORTED", async () => {
    const rpc = makeRpcHandler({
      host: new FakeHost(),
      name: TEST_NAME,
      hermeticdVersion: "0.4.0",
      configHash: async () => null,
      whois: async (ip) => (ip.startsWith("100.64.") ? MEMBER : null),
    });
    const files = createPhoneFiles({ fetch: phoneFetch(rpc).fetch, host: HOST });
    expect(await files.capability()).toBe(false);
    await expect(files.stage({ name: "notes.txt", bytes: TEXT })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  });
});

/** The sentinel a text secret carries in these tests: never a real value. */
const FIXTURE_SECRET_VALUE = "FIXTURE_SECRET_VALUE";

describe("requests → read, fulfil, decline", () => {
  test("a file fulfils the slot with PUT /files/requests/<id>, and the slot reads fulfilled", async () => {
    const box = await filesBox();
    const slot = await openSlot(box.socket, { accept: [".txt"], session_id: "s-req" });
    const { fetch, seen } = phoneFetch(box.rpc);
    const files = createPhoneFiles({ fetch, host: HOST });
    const open = await files.request(slot.request_id);
    expect(FileRequest.parse(open)).toEqual(open);
    expect(open.state).toBe("open");
    const result = await files.fulfil(slot.request_id, { name: "notes.txt", bytes: TEXT });
    expect(FilesFulfilResult.parse(result)).toEqual(result);
    expect(result).toMatchObject({
      request_id: slot.request_id,
      bytes: TEXT.byteLength,
      class: "file",
    });
    const put = seen.find((r) => r.method === "PUT");
    expect(put?.path).toBe(`/files/requests/${slot.request_id}`);
    expect(put?.headers[FILES_NAME_HEADER]).toBe("notes.txt");
    expect(put?.headers["content-length"]).toBe(String(TEXT.byteLength));
    const after = await files.request(slot.request_id);
    expect(after.state).toBe("fulfilled");
    expect(after.fulfilled?.path).toBe(result.path);
    expect(box.host.files.get(result.path)?.content).toBe(new TextDecoder().decode(TEXT));
    const listed = await files.requests("s-req");
    expect(listed.map((r) => r.request_id)).toEqual([slot.request_id]);
    expect(await files.requests("s-other")).toEqual([]);
  });

  test("a secret file slot keeps the bytes in the tmpfs drop, as a secret", async () => {
    const box = await filesBox();
    const slot = await openSlot(box.socket, { sensitivity: "secret", accept: [".pem"] });
    const files = createPhoneFiles({ fetch: phoneFetch(box.rpc).fetch, host: HOST });
    const result = await files.fulfil(slot.request_id, { name: "deploy.pem", bytes: PEM });
    expect(result.class).toBe("secret");
    expect(result.path.startsWith("/run/hermetic/")).toBe(true);
    expect(box.index().entries.some((e) => e.dir === "inbox")).toBe(false);
  });

  test("a type outside the accept list is FILE_TYPE_REJECTED, and nothing is uploaded", async () => {
    const box = await filesBox();
    const slot = await openSlot(box.socket, { accept: [".pdf"] });
    const { fetch, seen } = phoneFetch(box.rpc);
    const files = createPhoneFiles({ fetch, host: HOST });
    await expect(
      files.fulfil(slot.request_id, { name: "notes.txt", bytes: TEXT }),
    ).rejects.toMatchObject({
      code: "FILE_TYPE_REJECTED",
    });
    expect(seen.some((r) => r.method === "PUT")).toBe(false);
    expect((await files.request(slot.request_id)).state).toBe("open");
  });

  test("decline closes the slot; a later fulfil is refused before any upload", async () => {
    const box = await filesBox();
    const slot = await openSlot(box.socket);
    const { fetch, seen } = phoneFetch(box.rpc);
    const files = createPhoneFiles({ fetch, host: HOST });
    const declined = await files.decline(slot.request_id);
    expect(declined.state).toBe("declined");
    expect(seen.at(-1)).toMatchObject({
      method: "POST",
      path: `/files/requests/${slot.request_id}/decline`,
    });
    await expect(
      files.fulfil(slot.request_id, { name: "notes.txt", bytes: TEXT }),
    ).rejects.toMatchObject({
      code: "FILE_REQUEST_CLOSED",
    });
    expect(seen.some((r) => r.method === "PUT")).toBe(false);
  });

  test("an id the box does not hold is FILE_NOT_FOUND", async () => {
    const box = await filesBox();
    const files = createPhoneFiles({ fetch: phoneFetch(box.rpc).fetch, host: HOST });
    await expect(files.request("fr_abcdefghij12")).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
  });
});

describe("secret → the box's text-secret reader", () => {
  test("one value reaches the drop in canonical form, and reads back through the box's reader", async () => {
    const box = await filesBox();
    const slot = await openSlot(box.socket, {
      kind: "secret_text",
      purpose: "a token for the deploy",
      keys: ["GITHUB_TOKEN"],
    });
    const { fetch, seen } = phoneFetch(box.rpc);
    const files = createPhoneFiles({ fetch, host: HOST });
    const result = await files.secret(slot.request_id, { text: FIXTURE_SECRET_VALUE });
    expect(result).toMatchObject({ class: "secret", keys: ["GITHUB_TOKEN"], format: "raw" });
    const put = seen.find((r) => r.method === "PUT");
    expect(put?.headers[FILES_NAME_HEADER]).toBe("github.env");
    expect(put?.headers[FILES_SECRET_AS_HEADER]).toBeUndefined();
    const stored = box.host.files.get(result.path)?.content ?? "";
    expect(readCanonicalSecretEnv(stored)).toEqual([
      { key: "GITHUB_TOKEN", value: FIXTURE_SECRET_VALUE },
    ]);
    expect((await files.request(slot.request_id)).fulfilled?.keys).toEqual(["GITHUB_TOKEN"]);
    // The value is never in what the phone sent besides the body, nor in the audit.
    expect(JSON.stringify(seen)).not.toContain(FIXTURE_SECRET_VALUE);
    expect(box.audit.join("\n")).not.toContain(FIXTURE_SECRET_VALUE);
  });

  test('several keys as .env lines, with "Treat as" sent to the box', async () => {
    const box = await filesBox();
    const slot = await openSlot(box.socket, {
      kind: "secret_text",
      purpose: "replica credentials",
      keys: ["DB_USER", "DB_PASS"],
    });
    const { fetch, seen } = phoneFetch(box.rpc);
    const files = createPhoneFiles({ fetch, host: HOST });
    const text = `DB_USER=FIXTURE_USER\nDB_PASS=${FIXTURE_SECRET_VALUE}\n`;
    const result = await files.secret(slot.request_id, { text, as: "dotenv" });
    expect(result.keys).toEqual(["DB_USER", "DB_PASS"]);
    expect(seen.find((r) => r.method === "PUT")?.headers[FILES_SECRET_AS_HEADER]).toBe("dotenv");
    expect(readCanonicalSecretEnv(box.host.files.get(result.path)?.content ?? "")).toEqual([
      { key: "DB_USER", value: "FIXTURE_USER" },
      { key: "DB_PASS", value: FIXTURE_SECRET_VALUE },
    ]);
  });

  test("a key the request did not name is refused on the phone, and nothing is sent", async () => {
    const box = await filesBox();
    const slot = await openSlot(box.socket, {
      kind: "secret_text",
      purpose: "a token",
      keys: ["GITHUB_TOKEN"],
    });
    const { fetch, seen } = phoneFetch(box.rpc);
    const files = createPhoneFiles({ fetch, host: HOST });
    const refused = files.secret(slot.request_id, {
      text: `GITHUB_TOKEN=${FIXTURE_SECRET_VALUE}\nOTHER_KEY=FIXTURE\n`,
      as: "dotenv",
    });
    await expect(refused).rejects.toMatchObject({ code: "VALIDATION" });
    const error = (await refused.catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain(FIXTURE_SECRET_VALUE);
    expect(seen.some((r) => r.method === "PUT")).toBe(false);
    expect((await files.request(slot.request_id)).state).toBe("open");
  });
});

describe("the phone's fixture kit", () => {
  const kit = fixtureKit("1");
  if (!kit) throw new Error("the fixture kit did not build");
  const view = async () => {
    const { fixtureFleetView } = await import("../mobile/src/fixture/index.ts");
    return fixtureFleetView(new Date().toISOString());
  };
  const hostOf = async (name: string): Promise<string> => {
    const agent = (await view()).agents.find((a) => a.name === name);
    if (!agent?.tailscale_dns_name) throw new Error(`no fixture agent ${name}`);
    return agent.tailscale_dns_name;
  };

  test("atlas serves files and ember does not", async () => {
    expect(await kit.files(await hostOf("atlas")).capability()).toBe(true);
    expect(await kit.files(await hostOf("ember")).capability()).toBe(false);
    await expect(
      kit.files(await hostOf("ember")).stage({ name: "notes.txt", bytes: TEXT }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  test("the desktop fixture's name triggers refuse the same way", async () => {
    const files = kit.files(await hostOf("atlas"));
    await expect(files.stage({ name: "E2E_FILE_TOO_LARGE.txt", bytes: TEXT })).rejects.toMatchObject({
      code: "FILE_TOO_LARGE",
    });
    await expect(files.stage({ name: "E2E_FILE_DIGEST.txt", bytes: TEXT })).rejects.toMatchObject({
      code: "FILE_DIGEST_MISMATCH",
    });
  });

  test("a staged file commits into a fixture turn through the chat client", async () => {
    const host = await hostOf("atlas");
    const files = kit.files(host);
    const staged = FilesStageResult.parse(await files.stage({ name: "notes.txt", bytes: TEXT }));
    const frames: ChatFrame[] = [];
    for await (const frame of kit.chat.send(
      { instance: "atlas", baseUrl: `https://${host}/` },
      "default",
      "here is the file",
      { attachments: attachmentsFor([staged], files) },
    )) {
      frames.push(frame);
    }
    expect(frames.some((f) => f.type === "error")).toBe(false);
    const text = frames.map((f) => (f.type === "delta" ? f.text : "")).join("");
    expect(text).toContain("notes.txt");
    // Committed: a second commit answers the inbox entry, not a stage.
    const again = await files.commit(staged.id, "", undefined);
    expect(again.rel).toContain(`/${staged.id}/notes.txt`);
  });

  /**
   * One request turn on the fixture: the prompt's turn parks on its slot, and
   * `answer` runs once the running card names it. The frames, and the request
   * block as the turn last drew it.
   */
  const requestTurn = async (
    prompt: string,
    answer: (files: PhoneFiles, request_id: string) => Promise<unknown>,
  ) => {
    const host = await hostOf("atlas");
    const files = kit.files(host);
    const frames: ChatFrame[] = [];
    let answered = false;
    for await (const frame of kit.chat.send(
      { instance: "atlas", baseUrl: `https://${host}/` },
      "default",
      prompt,
    )) {
      frames.push(frame);
      if (
        !answered &&
        frame.type === "block" &&
        frame.block.kind === "tool" &&
        frame.block.status === "running" &&
        frame.block.request_id
      ) {
        answered = true;
        await answer(files, frame.block.request_id);
      }
    }
    const tools = frames.flatMap((f) =>
      f.type === "block" && f.block.kind === "tool" ? [f.block] : [],
    );
    const text = frames.map((f) => (f.type === "delta" ? f.text : "")).join("");
    return { files, frames, tools, last: tools.at(-1), text, answered };
  };

  test("E2E_TEXT_SECRET raises a secret_request block, and secret() resolves it", async () => {
    let request_id = "";
    const turn = await requestTurn("E2E_TEXT_SECRET please", async (files, id) => {
      request_id = id;
      const slot = await files.request(id);
      expect(slot).toMatchObject({ kind: "secret_text", keys: ["GITHUB_TOKEN"], state: "open" });
      await files.secret(id, { text: FIXTURE_SECRET_VALUE });
    });
    expect(turn.answered).toBe(true);
    expect(turn.tools[0]).toMatchObject({ render: "secret_request", status: "running" });
    expect(turn.last).toMatchObject({ render: "secret_request", status: "ok", request_id });
    expect(turn.last?.result).toMatchObject({ status: "fulfilled", keys: ["GITHUB_TOKEN"] });
    expect(JSON.stringify(turn.frames)).not.toContain(FIXTURE_SECRET_VALUE);
    expect((await turn.files.request(request_id)).state).toBe("fulfilled");
  });

  test("E2E_TEXT_SECRET_MULTI asks for three keys, answered as .env lines", async () => {
    const turn = await requestTurn("E2E_TEXT_SECRET_MULTI", async (files, id) => {
      const slot = await files.request(id);
      expect(slot).toMatchObject({ keys: ["DB_USER", "DB_PASS", "DB_URL"], input: "multi" });
      await files.secret(id, {
        text: `DB_USER=FIXTURE\nDB_PASS=${FIXTURE_SECRET_VALUE}\nDB_URL=postgres://FIXTURE\n`,
      });
    });
    expect(turn.last?.result).toMatchObject({
      status: "fulfilled",
      keys: ["DB_USER", "DB_PASS", "DB_URL"],
      format: "dotenv",
    });
  });

  test("E2E_SECRET_REQUEST raises a secret file request, kept as a secret when fulfilled", async () => {
    const turn = await requestTurn("E2E_SECRET_REQUEST", async (files, id) => {
      expect(await files.request(id)).toMatchObject({ kind: "file", sensitivity: "secret" });
      const result = await files.fulfil(id, { name: "github-app.pem", bytes: PEM });
      expect(result.class).toBe("secret");
    });
    expect(turn.tools[0]).toMatchObject({ render: "file_request" });
    expect(turn.last?.result).toMatchObject({ status: "fulfilled", class: "secret" });
  });

  test("E2E_FILE_REQUEST: a file the accept list allows is delivered; decline is told", async () => {
    const delivered = await requestTurn("E2E_FILE_REQUEST", (files, id) =>
      files.fulfil(id, { name: "access.log", bytes: TEXT }),
    );
    expect(delivered.last?.result).toMatchObject({ status: "fulfilled", class: "file" });
    expect(delivered.text).toContain("is on the box");
    const declined = await requestTurn("E2E_FILE_REQUEST", (files, id) => files.decline(id));
    expect(declined.last?.result).toMatchObject({ status: "declined" });
    expect(declined.text).toContain("won't use it");
  });

  test("E2E_FILE_REQUEST_TIMEOUT ends pending, and a late delivery still lands", async () => {
    let request_id = "";
    const turn = await requestTurn("E2E_FILE_REQUEST_TIMEOUT", async (_files, id) => {
      request_id = id;
    });
    expect(turn.last?.result).toMatchObject({ status: "pending" });
    const late = await turn.files.fulfil(request_id, { name: "access.log", bytes: TEXT });
    expect(late.request_id).toBe(request_id);
    expect((await turn.files.request(request_id)).state).toBe("fulfilled");
  }, 10_000);
});
