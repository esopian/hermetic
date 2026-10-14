/**
 * `share_file` (socket `POST /outbox`): the path policy hermeticd enforces on
 * a path the agent chose, the copy into the outbox, and the share's life after
 * — listed, downloadable by the operator, swept at 24 h.
 */
import { describe, expect, test } from "bun:test";
import {
  FILES_DROP_DIR,
  FILES_INDEX_PATH,
  FILES_OUTBOX_DIR,
  FILES_SECRET_DIR,
  FILES_TTL,
  HERMES_ACCOUNT_HOME,
  HERMES_HOME,
  parseContentDigest,
  resolveFilesSettings,
} from "@hermetic/core/shared";
import { isCredentialPath } from "../src/files/share-policy.ts";
import { PDF, PEM, PNG, filesBox, post, sha256 } from "./files-fixture.ts";

const WORK = `${HERMES_ACCOUNT_HOME}/work`;

interface Share {
  share_id: string;
  name: string;
  bytes: number;
  mime: string;
  sha256: string;
}

interface Refusal {
  error: { code: string; message: string };
}

/** A box with `/data/hermes/work/report.pdf` on it, and a `share` helper over the socket. */
async function shareBox(options: Parameters<typeof filesBox>[0] = {}) {
  const box = await filesBox(options);
  box.host.seedBytes(`${WORK}/report.pdf`, PDF, "0644");
  const share = async (body: Record<string, unknown>) => {
    const res = await box.socket("/outbox", post(body));
    return { status: res.status, body: (await res.json()) as Share & Refusal };
  };
  /** Every write into the outbox, part files included. */
  const outboxWrites = () => box.host.streamWrites.filter((w) => w.path.startsWith(FILES_OUTBOX_DIR));
  return { ...box, share, outboxWrites };
}

describe("share_file: the copy", () => {
  test("copies as hermes into outbox/<share_id>/<name> at 0600, hashes it, and indexes it for 24 h", async () => {
    const { host, share, index } = await shareBox();
    const { status, body } = await share({ path: `${WORK}/report.pdf`, note: "the Q3 numbers" });
    expect(status).toBe(201);
    expect(body.share_id).toMatch(/^sh_[a-z0-9]{12}$/);
    const result: Share = body;
    expect(result).toEqual({
      share_id: body.share_id,
      name: "report.pdf",
      bytes: PDF.byteLength,
      mime: "application/pdf",
      sha256: sha256(PDF),
    });

    const copy = `${FILES_OUTBOX_DIR}/${body.share_id}/report.pdf`;
    const stored = host.files.get(copy);
    expect(stored?.mode).toBe("0600");
    expect(stored?.ownership).toBe("hermes:hermes");
    expect(Buffer.from(stored?.bytes ?? new Uint8Array()).equals(Buffer.from(PDF))).toBe(true);
    // The original is read as hermes and left where it was: a copy, never a move or a link.
    expect(host.streamReads).toContain(`hermes ${WORK}/report.pdf`);
    expect(host.files.has(`${WORK}/report.pdf`)).toBe(true);
    expect(
      host.commands.some((c) => c.includes(`${WORK}/report.pdf`) && /\b(mv|ln|cp)\b/.test(c)),
    ).toBe(false);

    const entry = index().entries.find((e) => e.id === body.share_id);
    expect(entry).toMatchObject({
      dir: "outbox",
      class: "file",
      name: "report.pdf",
      bytes: PDF.byteLength,
      sha256: sha256(PDF),
      path: copy,
      rel: `outbox/${body.share_id}/report.pdf`,
      from: { kind: "agent" },
      note: "the Q3 numbers",
      expires_at: new Date(host.now().getTime() + FILES_TTL.outbox * 1000).toISOString(),
    });
    expect(copy.startsWith(`${HERMES_HOME}/`)).toBe(true);
  });

  test("the share is a snapshot: editing the original afterwards does not change it", async () => {
    const { host, share, fetch } = await shareBox();
    const { body } = await share({ path: `${WORK}/report.pdf` });
    host.seedBytes(`${WORK}/report.pdf`, new TextEncoder().encode("%PDF-1.7\nrewritten\n"), "0644");

    const res = await fetch(`/files/${body.share_id}/content`);
    expect(res.status).toBe(200);
    expect(parseContentDigest(res.headers.get("content-digest"))).toBe(sha256(PDF));
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(PDF))).toBe(true);
  });

  test("listed in GET /files (tailnet and socket) and downloadable by the content route", async () => {
    const { share, fetch, socket } = await shareBox();
    const { body } = await share({ path: `${WORK}/report.pdf`, name: "q3-report.pdf" });
    expect(body.name).toBe("q3-report.pdf");

    const listed = (await (await fetch("/files")).json()) as {
      outbox: Array<{ id: string; name: string }>;
      usage: { outbox_bytes: number };
    };
    expect(listed.outbox.map((e) => [e.id, e.name])).toEqual([[body.share_id, "q3-report.pdf"]]);
    expect(listed.usage.outbox_bytes).toBe(PDF.byteLength);

    const agentView = (await (await socket("/files")).json()) as { outbox: Array<{ id: string }> };
    expect(agentView.outbox.map((e) => e.id)).toEqual([body.share_id]);

    const content = await fetch(`/files/${body.share_id}/content`);
    expect(content.status).toBe(200);
    expect(content.headers.get("content-type")).toBe("application/pdf");
    expect(content.headers.get("content-disposition")).toContain('filename="q3-report.pdf"');
  });

  test("an image shares as class image", async () => {
    const { host, share } = await shareBox();
    host.seedBytes(`${WORK}/chart.png`, PNG);
    const { body } = await share({ path: `${WORK}/chart.png` });
    expect(body.mime).toBe("image/png");
  });

  test("the sweeper removes a share after 24 h, files and entry", async () => {
    const { host, share, service, index } = await shareBox();
    const { body } = await share({ path: `${WORK}/report.pdf` });
    const copy = `${FILES_OUTBOX_DIR}/${body.share_id}/report.pdf`;

    host.advance(FILES_TTL.outbox * 1000 - 1000);
    await service.sweep();
    expect(host.files.has(copy)).toBe(true);

    host.advance(2000);
    const report = await service.sweep();
    expect(report.removed).toBe(1);
    expect(host.files.has(copy)).toBe(false);
    expect(index().entries).toEqual([]);
    // The original is the agent's, and stays.
    expect(host.files.has(`${WORK}/report.pdf`)).toBe(true);
  });

  test("a caller that hangs up mid-copy stops it, and no share or directory is left", async () => {
    const box = await shareBox();
    const hangUp = new AbortController();
    // The plugin's deadline runs out while the bytes are being written.
    box.host.streamFaults.push((path) => {
      if (path.startsWith(FILES_OUTBOX_DIR)) hangUp.abort();
      return null;
    });
    const res = await box.socket("/outbox", {
      ...post({ path: `${WORK}/report.pdf` }),
      signal: hangUp.signal,
    });
    expect(res.status).toBe(408);
    expect(box.outboxWrites().length).toBe(1);
    expect([...box.host.files.keys()].filter((p) => p.startsWith(FILES_OUTBOX_DIR))).toEqual([]);
    expect([...box.host.dirs].filter((d) => d.startsWith(`${FILES_OUTBOX_DIR}/`))).toEqual([]);
    expect(box.index().entries).toEqual([]);
    expect(box.host.files.has(`${WORK}/report.pdf`)).toBe(true);
  });

  test("a caller that hangs up during the index write leaves no entry, copy or directory", async () => {
    const box = await shareBox();
    const hangUp = new AbortController();
    box.host.writeFaults.push((path) => {
      if (path === FILES_INDEX_PATH) hangUp.abort();
      return null;
    });
    const res = await box.socket("/outbox", {
      ...post({ path: `${WORK}/report.pdf` }),
      signal: hangUp.signal,
    });
    expect(res.status).toBe(408);
    expect(hangUp.signal.aborted).toBe(true);
    expect(box.index().entries).toEqual([]);
    expect([...box.host.files.keys()].filter((p) => p.startsWith(FILES_OUTBOX_DIR))).toEqual([]);
    expect([...box.host.dirs].filter((d) => d.startsWith(`${FILES_OUTBOX_DIR}/`))).toEqual([]);
    expect(box.host.files.has(`${WORK}/report.pdf`)).toBe(true);
  });

  test("a caller already gone is not served at all", async () => {
    const box = await shareBox();
    const gone = new AbortController();
    gone.abort();
    const res = await box.socket("/outbox", {
      ...post({ path: `${WORK}/report.pdf` }),
      signal: gone.signal,
    });
    expect(res.status).toBe(408);
    expect(box.host.streamReads).toEqual([]);
    expect(box.outboxWrites()).toEqual([]);
  });

  test("the audit line names neither the path nor the file", async () => {
    const { share, audit } = await shareBox();
    const { body } = await share({ path: `${WORK}/report.pdf` });
    const line = audit.find((l) => l.startsWith("files share "));
    expect(line).toContain(`id=${body.share_id}`);
    expect(audit.join("\n")).not.toContain("report.pdf");
  });
});

describe("share_file: the path policy", () => {
  async function refused(
    setup: (box: Awaited<ReturnType<typeof shareBox>>) => void | Promise<void>,
    path: string,
    code: string,
    message: string,
  ): Promise<void> {
    const box = await shareBox();
    await setup(box);
    const { status, body } = await box.share({ path });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(body.error.code).toBe(code);
    expect(body.error.message).toBe(`share refused: ${message}`);
    expect(box.outboxWrites()).toEqual([]);
    expect(box.index().entries.filter((e) => e.dir === "outbox")).toEqual([]);
    // Never a byte of the file in the answer.
    expect(JSON.stringify(body)).not.toContain("FIXTURE");
  }

  test.each([
    ["$HERMES_HOME/.env", `${HERMES_HOME}/.env`],
    ["a project's .env.production", `${WORK}/app/.env.production`],
    ["an SSH identity", `${HERMES_ACCOUNT_HOME}/.ssh/id_ed25519`],
    ["anything under .ssh", `${HERMES_ACCOUNT_HOME}/.ssh/config`],
    ["AWS credentials", `${HERMES_ACCOUNT_HOME}/.aws/credentials`],
    ["a .pem by its extension", `${WORK}/deploy.pem`],
    ["Hermes's auth store", `${HERMES_HOME}/auth.json`],
    ["Hermes's session transcripts", `${HERMES_HOME}/sessions/s1.json`],
    ["a profile's .env", `${HERMES_HOME}/profiles/ops/.env`],
    ["the browser profiles", `${HERMES_ACCOUNT_HOME}/browser/default/Cookies`],
    ["a .netrc", `${HERMES_ACCOUNT_HOME}/.netrc`],
  ])("a credential path (%s) is refused before anything is read", async (_why, path) => {
    await refused(({ host }) => host.seed(path, "FIXTURE"), path, "FORBIDDEN", "credential path");
  });

  test("a symlink out of /data/hermes is refused on its resolved path", async () => {
    await refused(
      ({ host }) => {
        host.seed("/etc/shadow", "root:FIXTURE:19000::::::");
        host.symlink(`${WORK}/notes.txt`, "/etc/shadow");
      },
      `${WORK}/notes.txt`,
      "FORBIDDEN",
      `only files under ${HERMES_ACCOUNT_HOME} can be shared`,
    );
  });

  test("a relative symlink onto a credential is refused on its resolved path", async () => {
    await refused(
      ({ host }) => {
        host.seed(`${HERMES_ACCOUNT_HOME}/.ssh/id_rsa`, "FIXTURE");
        host.symlink(`${WORK}/innocent.txt`, "../.ssh/id_rsa");
      },
      `${WORK}/innocent.txt`,
      "FORBIDDEN",
      "credential path",
    );
  });

  test("a symlinked directory on the way is followed too", async () => {
    await refused(
      ({ host }) => {
        host.seed(`${HERMES_HOME}/auth.json`, '{"token":"FIXTURE"}');
        host.symlink(`${WORK}/conf`, HERMES_HOME);
      },
      `${WORK}/conf/auth.json`,
      "FORBIDDEN",
      "credential path",
    );
  });

  test.each([
    ["a tmpfs durable secret", `${FILES_SECRET_DIR}/github-app.txt`],
    ["a drop secret", `${FILES_DROP_DIR}/fr_aaaaaaaaaaaa/token.txt`],
  ])("%s is refused as a secret", async (_why, path) => {
    await refused(
      ({ host }) => host.seed(path, "FIXTURE"),
      path,
      "FILE_SECRET_FORBIDDEN",
      "secret files never leave the box",
    );
  });

  test("a symlink into /run/hermetic is refused as a secret", async () => {
    await refused(
      ({ host }) => {
        host.seed(`${FILES_SECRET_DIR}/token.txt`, "FIXTURE");
        host.symlink(`${WORK}/token.txt`, `${FILES_SECRET_DIR}/token.txt`);
      },
      `${WORK}/token.txt`,
      "FILE_SECRET_FORBIDDEN",
      "secret files never leave the box",
    );
  });

  test("a file the index holds as secret-class is refused wherever it is", async () => {
    const path = `${WORK}/held.txt`;
    await refused(
      async ({ host, service }) => {
        host.seed(path, "FIXTURE");
        await service.ctx.store.mutate((index) => {
          index.entries.push({
            id: "f_aaaaaaaaaaaa",
            dir: "inbox",
            class: "secret",
            name: "held.txt",
            bytes: 7,
            mime: "text/plain",
            sha256: "0".repeat(64),
            created_at: host.now().toISOString(),
            expires_at: null,
            path,
            from: { kind: "agent" },
          });
        });
      },
      path,
      "FILE_SECRET_FORBIDDEN",
      "secret files never leave the box",
    );
  });

  test("a file whose head is private key material is refused, whatever its name", async () => {
    await refused(
      ({ host }) => host.seedBytes(`${WORK}/notes.txt`, PEM),
      `${WORK}/notes.txt`,
      "FILE_SECRET_FORBIDDEN",
      "the file looks like private key material",
    );
  });

  test.each([
    [
      "outside /data/hermes",
      "/etc/passwd",
      "FORBIDDEN",
      `only files under ${HERMES_ACCOUNT_HOME} can be shared`,
    ],
    [
      "a .. walk out",
      `${WORK}/../../../etc/passwd`,
      "FORBIDDEN",
      `only files under ${HERMES_ACCOUNT_HOME} can be shared`,
    ],
    ["a relative path", "work/report.pdf", "VALIDATION", "the path must be absolute"],
    ["a control character", `${WORK}/a\nb.txt`, "VALIDATION", "the path contains control characters"],
    [
      "the outbox itself",
      `${FILES_OUTBOX_DIR}/sh_aaaaaaaaaaaa/x.pdf`,
      "CONFLICT",
      "that file is already a share",
    ],
    ["a missing file", `${WORK}/nope.pdf`, "FILE_NOT_FOUND", "no such file on this box"],
    ["a directory", WORK, "VALIDATION", "only a regular file can be shared"],
  ])("%s is refused", async (_why, path, code, message) => {
    await refused(
      ({ host }) => host.seed("/etc/passwd", "root:x:0:0::/root:/bin/sh"),
      path,
      code,
      message,
    );
  });

  test("a file over the fleet's max_bytes is refused before it is read", async () => {
    const settings = resolveFilesSettings({ files: { max_bytes: 16 } });
    const box = await shareBox({ settings: () => settings });
    const { status, body } = await box.share({ path: `${WORK}/report.pdf` });
    expect(status).toBe(413);
    expect(body.error).toEqual({
      code: "FILE_TOO_LARGE",
      message: "share refused: the file is over this fleet's cap of 16 bytes",
    });
    expect(box.host.streamReads).toEqual([]);
  });

  test("a write that would breach the disk floor is refused", async () => {
    const box = await shareBox();
    box.host.filesystemResult = {
      mount: "/data",
      size: 100 * 1024 ** 3,
      available: 1024 ** 3,
      usePct: 99,
    };
    const { status, body } = await box.share({ path: `${WORK}/report.pdf` });
    expect(status).toBe(507);
    expect(body.error.code).toBe("DISK_FULL");
  });

  test("a hidden file needs a name; with one it shares", async () => {
    const box = await shareBox();
    box.host.seed(`${WORK}/.notes`, "plain notes\n");
    const nameless = await box.share({ path: `${WORK}/.notes` });
    expect(nameless.body.error.code).toBe("FILE_NAME_INVALID");
    const named = await box.share({ path: `${WORK}/.notes`, name: "notes.txt" });
    expect(named.status).toBe(201);
    expect(named.body.name).toBe("notes.txt");
  });

  test("the log line for a refusal carries the code only", async () => {
    const box = await shareBox();
    box.host.seed(`${HERMES_HOME}/.env`, "FIXTURE");
    await box.share({ path: `${HERMES_HOME}/.env` });
    expect(box.audit).toContain("files share refused: FORBIDDEN");
    expect(box.audit.join("\n")).not.toContain(".env");
  });
});

describe("isCredentialPath", () => {
  test.each([
    [`${WORK}/report.pdf`, false],
    [`${WORK}/id_rsa.pub`, false],
    [`${WORK}/environment.md`, false],
    [`${HERMES_HOME}/inbox/2026-10-13/f_aaaaaaaaaaaa/a.png`, false],
    [`${HERMES_HOME}/skills/config.yaml`, false],
    [`${HERMES_HOME}/config.yaml`, true],
    [`${WORK}/.ENV`, true],
    [`${WORK}/.envrc`, true],
    [`${WORK}/id_ecdsa_sk`, true],
    [`${WORK}/client.P12`, true],
    [`${WORK}/repo/.docker/config.json`, true],
    [`${WORK}/x/mcp-tokens/srv.json`, true],
    [`${HERMES_HOME}/state.db-wal`, true],
    [`${HERMES_ACCOUNT_HOME}/.config/gh/hosts.yml`, true],
  ])("%s → %p", (path, expected) => {
    expect(isCredentialPath(path)).toBe(expected);
  });
});
