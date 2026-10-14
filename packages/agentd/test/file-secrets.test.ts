/**
 * Durable file secrets: SSM `file-*`/`env-*` slots → `/run/hermetic/files/<name>`
 * on tmpfs, 0600 and handed to `hermes` (`src/files/secrets.ts`).
 *
 * What is pinned: the bytes land on tmpfs and nowhere else, at 0600, owned by
 * the account, only after their digest checked out; a slot that is not one of
 * the two families is refused before SSM is asked; the listing is paged and its
 * values are the ones written; a slot deleted from SSM does not linger on the
 * box; and `apply` refreshes them without ever failing over them.
 */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, test } from "bun:test";
import { GetParameterCommand, GetParametersByPathCommand } from "@aws-sdk/client-ssm";
import { FILES_SECRET_DIR, encodeSecretEnvelope } from "@hermetic/core/shared";
import { apply, resetAptIndexState, SECRETS_ENV_DIR } from "../src/apply/index.ts";
import { makeAws, type Aws } from "../src/aws.ts";
import { AgentdError } from "../src/errors.ts";
import {
  FILES_SECRET_DIR_MODE,
  materialiseAllFileSecrets,
  materialiseFileSecret,
  removeFileSecret,
} from "../src/files/secrets.ts";
import { collector } from "../src/events.ts";
import { FakeHost } from "./fake-host.ts";
import { BoxHost } from "./fake-box.ts";
import { RecordingSink, TEST_AGENTS_TABLE, TEST_EVENTS_TABLE, makeManifest } from "./fixtures.ts";

const PREFIX = "/hermes/fxtr0001/research-1/";
const PEM = new TextEncoder().encode(
  "-----BEGIN PRIVATE KEY-----\nFIXTURE\n-----END PRIVATE KEY-----\n",
);
const ENV = new TextEncoder().encode('GITHUB_TOKEN="FIXTURE-TOKEN"\n');

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function envelope(name: string, bytes: Uint8Array, sha256 = digest(bytes)): string {
  return encodeSecretEnvelope({ name, bytes, sha256 });
}

function parameterNotFound(): Error {
  const e = new Error("Parameter not found");
  e.name = "ParameterNotFound";
  return e;
}

/**
 * An SSM double holding `slots` (slot name → value) under `PREFIX`, answering
 * `GetParametersByPath` `pageSize` at a time with a `NextToken` between pages.
 */
function ssmWith(slots: Readonly<Record<string, string>>, pageSize = 10): RecordingSink {
  const ssm = new RecordingSink();
  ssm.byCommand.set("GetParameterCommand", (command) => {
    const name = (command as GetParameterCommand).input.Name ?? "";
    const value = slots[name.slice(PREFIX.length)];
    return value === undefined || !name.startsWith(PREFIX)
      ? parameterNotFound()
      : { Parameter: { Value: value } };
  });
  ssm.byCommand.set("GetParametersByPathCommand", (command) => {
    const input = (command as GetParametersByPathCommand).input;
    const all = Object.entries(slots).map(([slot, value]) => ({ Name: PREFIX + slot, Value: value }));
    const start = input.NextToken ? Number(input.NextToken) : 0;
    const page = all.slice(start, start + pageSize);
    const next = start + pageSize < all.length ? String(start + pageSize) : undefined;
    return { Parameters: page, ...(next ? { NextToken: next } : {}) };
  });
  return ssm;
}

function awsOver(ssm: RecordingSink, host: FakeHost): Aws {
  return makeAws({
    ddb: new RecordingSink(),
    ssm,
    s3: new RecordingSink(),
    agentsTable: TEST_AGENTS_TABLE,
    eventsTable: TEST_EVENTS_TABLE,
    now: () => host.now(),
  });
}

/** Every path a write touched, whatever wrote it. */
function recordWrites(host: FakeHost): string[] {
  const written: string[] = [];
  host.writeFaults.push((path) => {
    written.push(path);
    return null;
  });
  return written;
}

describe("materialiseFileSecret — one slot", () => {
  test("lands on tmpfs at 0600, handed to hermes, under a root 0711 directory", async () => {
    const host = new FakeHost();
    const writes = recordWrites(host);
    const ssm = ssmWith({ "file-github-app-pem": envelope("github-app.pem", PEM) });
    const placed = await materialiseFileSecret(
      { host, aws: awsOver(ssm, host), paramPrefix: PREFIX },
      "file-github-app-pem",
    );

    const path = `${FILES_SECRET_DIR}/github-app.pem`;
    expect(placed).toEqual({
      slot: "file-github-app-pem",
      name: "github-app.pem",
      path,
      sha256: digest(PEM),
      bytes: PEM.length,
    });
    expect(host.files.get(path)?.bytes).toEqual(PEM);
    expect(host.files.get(path)?.mode).toBe("0600");
    // Root writes into a directory only root can write to, so the account
    // cannot have planted a symlink at the name; then the file is handed over.
    expect(host.commands).toContain(`chown hermes:hermes -- ${path}`);
    expect(host.chmods).toContainEqual([SECRETS_ENV_DIR, "0711"]);
    expect(host.chmods).toContainEqual([FILES_SECRET_DIR, FILES_SECRET_DIR_MODE]);
    expect(FILES_SECRET_DIR_MODE).toBe("0711");
    // The one slot, by its own path.
    expect(ssm.commandCalls(GetParameterCommand).map((c) => c.input.Name)).toEqual([
      `${PREFIX}file-github-app-pem`,
    ]);
    expect(ssm.commandCalls(GetParameterCommand)[0]?.input.WithDecryption).toBe(true);
    // tmpfs only: nothing reached the data volume.
    expect(writes).toEqual([path]);
    expect(writes.some((p) => p.startsWith("/data"))).toBe(false);
  });

  test("an env slot writes its .env file", async () => {
    const host = new FakeHost();
    const ssm = ssmWith({ "env-github": envelope("github.env", ENV) });
    const placed = await materialiseFileSecret(
      { host, aws: awsOver(ssm, host), paramPrefix: PREFIX },
      "env-github",
    );
    expect(placed.path).toBe(`${FILES_SECRET_DIR}/github.env`);
    expect(host.files.get(placed.path)?.content).toBe('GITHUB_TOKEN="FIXTURE-TOKEN"\n');
  });

  test("an env slot whose envelope is not a .env is refused", async () => {
    const host = new FakeHost();
    const ssm = ssmWith({ "env-github": envelope("github.txt", ENV) });
    await expect(
      materialiseFileSecret({ host, aws: awsOver(ssm, host), paramPrefix: PREFIX }, "env-github"),
    ).rejects.toBeInstanceOf(AgentdError);
    expect([...host.files.keys()]).toEqual([]);
  });

  test("a digest that does not match the bytes is refused, and nothing is written", async () => {
    const host = new FakeHost();
    const ssm = ssmWith({ "file-key": envelope("key.pem", PEM, "0".repeat(64)) });
    const err = await materialiseFileSecret(
      { host, aws: awsOver(ssm, host), paramPrefix: PREFIX },
      "file-key",
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentdError);
    expect((err as AgentdError).code).toBe("CHECKSUM_MISMATCH");
    expect([...host.files.keys()]).toEqual([]);
    expect(host.commands.filter((c) => c.startsWith("chown"))).toEqual([]);
  });

  test.each([
    ["not JSON", "-----BEGIN PRIVATE KEY-----"],
    ["wrong version", JSON.stringify({ v: 2, name: "a.pem", sha256: digest(PEM), b64: "" })],
    ["a path for a name", JSON.stringify({ v: 1, name: "../../data/x", sha256: digest(PEM), b64: "" })],
    ["a hidden name", JSON.stringify({ v: 1, name: ".env", sha256: digest(PEM), b64: "" })],
  ])("an envelope that does not decode (%s) is refused", async (_label, value) => {
    const host = new FakeHost();
    const ssm = ssmWith({ "file-key": value });
    const err = await materialiseFileSecret(
      { host, aws: awsOver(ssm, host), paramPrefix: PREFIX },
      "file-key",
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentdError);
    // The value is never in the message.
    expect((err as Error).message).not.toContain(value);
    expect([...host.files.keys()]).toEqual([]);
  });

  test.each(["provider-key", "ts-key", "file-", "file-UPPER", "file-../x", "env-a/b", "other"])(
    "%s is not a file secret slot, and SSM is never asked",
    async (slot) => {
      const host = new FakeHost();
      const ssm = ssmWith({});
      const err = await materialiseFileSecret(
        { host, aws: awsOver(ssm, host), paramPrefix: PREFIX },
        slot,
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AgentdError);
      expect((err as AgentdError).code).toBe("USAGE");
      expect(ssm.calls).toEqual([]);
    },
  );
});

describe("materialiseAllFileSecrets — the whole prefix", () => {
  test("pages through the listing and writes the listed values, with no second read", async () => {
    const host = new FakeHost();
    const writes = recordWrites(host);
    const ssm = ssmWith(
      {
        "provider-key": "sk-FIXTURE",
        "ts-key": "tskey-FIXTURE",
        "file-a-pem": envelope("a.pem", PEM),
        "env-b": envelope("b.env", ENV),
        "file-c-txt": envelope("c.txt", PEM),
      },
      2,
    );
    const placed = await materialiseAllFileSecrets({
      host,
      aws: awsOver(ssm, host),
      paramPrefix: PREFIX,
    });

    expect(placed.map((p) => p.slot)).toEqual(["env-b", "file-a-pem", "file-c-txt"]);
    const listed = ssm.commandCalls(GetParametersByPathCommand).map((c) => c.input);
    expect(listed.map((i) => i.NextToken)).toEqual([undefined, "2", "4"]);
    for (const input of listed) {
      expect(input.Path).toBe(PREFIX.slice(0, -1));
      expect(input.Recursive).toBe(false);
      expect(input.WithDecryption).toBe(true);
    }
    expect(ssm.commandCalls(GetParameterCommand)).toEqual([]);
    // The other slots under the prefix are never written anywhere.
    expect(writes.sort()).toEqual(
      [`${FILES_SECRET_DIR}/a.pem`, `${FILES_SECRET_DIR}/b.env`, `${FILES_SECRET_DIR}/c.txt`].sort(),
    );
    expect(writes.every((p) => p.startsWith(FILES_SECRET_DIR + "/"))).toBe(true);
    expect([...host.files.keys()].some((p) => p.startsWith("/data"))).toBe(false);
  });

  test("a file no current slot produced is removed", async () => {
    const host = new FakeHost();
    await host.mkdir(FILES_SECRET_DIR);
    host.seed(`${FILES_SECRET_DIR}/deleted.pem`, "FIXTURE-OLD");
    const ssm = ssmWith({ "file-a-pem": envelope("a.pem", PEM) });
    await materialiseAllFileSecrets({ host, aws: awsOver(ssm, host), paramPrefix: PREFIX });
    expect(host.files.has(`${FILES_SECRET_DIR}/deleted.pem`)).toBe(false);
    expect(host.files.has(`${FILES_SECRET_DIR}/a.pem`)).toBe(true);
  });

  test("with no slots left, every file goes", async () => {
    const host = new FakeHost();
    await host.mkdir(FILES_SECRET_DIR);
    host.seed(`${FILES_SECRET_DIR}/deleted.pem`, "FIXTURE-OLD");
    await materialiseAllFileSecrets({ host, aws: awsOver(ssmWith({}), host), paramPrefix: PREFIX });
    expect(host.files.has(`${FILES_SECRET_DIR}/deleted.pem`)).toBe(false);
  });

  test("a listing that fails throws and sweeps nothing", async () => {
    const host = new FakeHost();
    await host.mkdir(FILES_SECRET_DIR);
    host.seed(`${FILES_SECRET_DIR}/kept.pem`, "FIXTURE-OLD");
    const ssm = new RecordingSink();
    ssm.byCommand.set("GetParametersByPathCommand", () =>
      Object.assign(new Error("denied"), { name: "AccessDeniedException" }),
    );
    await expect(
      materialiseAllFileSecrets({ host, aws: awsOver(ssm, host), paramPrefix: PREFIX }),
    ).rejects.toThrow();
    expect(host.files.has(`${FILES_SECRET_DIR}/kept.pem`)).toBe(true);
  });

  test("one bad slot is logged by slot name and the rest still land", async () => {
    const host = new FakeHost();
    const logged: string[] = [];
    const ssm = ssmWith({
      "file-bad": envelope("bad.pem", PEM, "f".repeat(64)),
      "file-good": envelope("good.pem", PEM),
    });
    const placed = await materialiseAllFileSecrets({
      host,
      aws: awsOver(ssm, host),
      paramPrefix: PREFIX,
      log: (m) => logged.push(m),
    });
    expect(placed.map((p) => p.name)).toEqual(["good.pem"]);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("file-bad");
    // Neither the file name nor anything of the value.
    expect(logged[0]).not.toContain("bad.pem");
    expect(logged[0]).not.toContain("FIXTURE");
  });

  test("two slots naming one file: the first by slot name wins, the other is logged", async () => {
    const host = new FakeHost();
    const logged: string[] = [];
    const other = new TextEncoder().encode("FIXTURE-OTHER");
    const ssm = ssmWith({
      "file-z": envelope("same.pem", other),
      "file-a": envelope("same.pem", PEM),
    });
    const placed = await materialiseAllFileSecrets({
      host,
      aws: awsOver(ssm, host),
      paramPrefix: PREFIX,
      log: (m) => logged.push(m),
    });
    expect(placed.map((p) => p.slot)).toEqual(["file-a"]);
    expect(host.files.get(`${FILES_SECRET_DIR}/same.pem`)?.bytes).toEqual(PEM);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("file-z");
    expect(logged[0]).toContain("file-a");
    expect(logged[0]).not.toContain("same.pem");
  });
});

describe("removeFileSecret", () => {
  test("removes the one file by name", async () => {
    const host = new FakeHost();
    await host.mkdir(FILES_SECRET_DIR);
    host.seed(`${FILES_SECRET_DIR}/a.pem`, "FIXTURE");
    await removeFileSecret(host, "a.pem");
    expect(host.files.has(`${FILES_SECRET_DIR}/a.pem`)).toBe(false);
  });

  test.each(["../secrets.env", "/run/hermetic/secrets.env", ".env", ""])(
    "refuses %p rather than resolving it",
    async (name) => {
      const host = new FakeHost();
      await expect(removeFileSecret(host, name)).rejects.toBeInstanceOf(AgentdError);
      expect(host.fsOps).toEqual([]);
    },
  );
});

describe("apply refreshes the durable file secrets (§6.4)", () => {
  let host: BoxHost;
  beforeEach(() => {
    host = new BoxHost();
    resetAptIndexState();
  });

  test("an apply writes them, after secrets.env", async () => {
    const ssm = ssmWith({ "file-a-pem": envelope("a.pem", PEM) });
    await apply(makeManifest(), {
      host,
      fileSecrets: { aws: awsOver(ssm, host), paramPrefix: PREFIX },
    });
    expect(host.files.get(`${FILES_SECRET_DIR}/a.pem`)?.mode).toBe("0600");
    expect(host.commands).toContain(`chown hermes:hermes -- ${FILES_SECRET_DIR}/a.pem`);
  });

  test("a dry run reads nothing and writes nothing", async () => {
    const ssm = ssmWith({ "file-a-pem": envelope("a.pem", PEM) });
    await apply(makeManifest(), {
      host,
      dryRun: true,
      fileSecrets: { aws: awsOver(ssm, host), paramPrefix: PREFIX },
    });
    expect(ssm.calls).toEqual([]);
    expect(host.files.has(`${FILES_SECRET_DIR}/a.pem`)).toBe(false);
  });

  test("a failing SSM listing is reported and the apply still succeeds", async () => {
    const ssm = new RecordingSink();
    ssm.byCommand.set("GetParametersByPathCommand", () =>
      Object.assign(new Error("throttled"), { name: "ThrottlingException" }),
    );
    const { emit, events } = collector();
    const result = await apply(makeManifest(), {
      host,
      emit,
      fileSecrets: { aws: awsOver(ssm, host), paramPrefix: PREFIX },
    });
    expect(result.enabled).toContain("hermes-dashboard.service");
    const warned = events.filter((e) => e.phase === "secrets" && e.level === "warn");
    expect(warned.map((e) => e.message)).toEqual([
      "durable file secrets were not refreshed: ThrottlingException",
    ]);
  });
});
