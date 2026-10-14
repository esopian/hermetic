/**
 * The Files tab's three public methods (§9): `files.list` (metadata only),
 * `files.get` (a verified, exclusive-create download that never takes a
 * secret) and `files.rm` (a plan `apply` executes, deleting a durable secret's
 * SSM slot after the entry).
 *
 * Against the seeded fixture fleet (`fixture-files-seed.ts`), so the entries
 * these read are the ones the dashboard shows in fixture mode.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { DeleteParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { mockClient } from "aws-sdk-client-mock";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SsmSecrets } from "../src/aws/ssm.ts";
import { agentParamPath } from "../src/backend/constants.ts";
import { FIXTURE_CONFIG, fixtureBackend } from "../src/backend/fixture/memory-fixture.ts";
import {
  FIXTURE_FILES_CRON_SESSION,
  FIXTURE_FILES_IDS,
} from "../src/backend/fixture/fixture-files-seed.ts";
import { HermeticError } from "../src/errors.ts";
import { FILES_LIMITS } from "../src/shared/files.ts";
import type { FilesGetEvent, Plan } from "../src/schema/index.ts";
import { drain, testHermetic } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "hermetic-files-browse-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const AGENT = "corvid";
const IDS = FIXTURE_FILES_IDS.corvid;

function open() {
  const { backend } = fixtureBackend();
  const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG });
  return { backend, hermetic, fleet: backend.boundFleetId() as string };
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

async function getAll(events: AsyncIterable<FilesGetEvent>): Promise<FilesGetEvent[]> {
  const out: FilesGetEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

let n = 0;
function fresh(name = "out.bin"): string {
  n += 1;
  return join(dir, `${n}-${name}`);
}

describe("files.list", () => {
  test("lists the seeded inbox, outbox, secrets and the open request — metadata only", async () => {
    const { hermetic } = open();
    const listed = await hermetic.files.list({ name: AGENT });
    expect(listed.inbox.map((e) => e.id).sort()).toEqual([IDS.pdf, IDS.png].sort());
    expect(listed.outbox.map((e) => [e.id, e.dir, e.from.kind])).toEqual([
      [IDS.csv, "outbox", "agent"],
    ]);
    expect(listed.secrets.map((e) => e.slot).sort()).toEqual(["env-github", "file-github-app-pem"]);
    expect(listed.secrets.find((e) => e.slot === "env-github")?.keys).toEqual(["GITHUB_TOKEN"]);
    const waiting = listed.requests.filter((r) => r.state === "open");
    expect(waiting.map((r) => r.session_id)).toEqual([FIXTURE_FILES_CRON_SESSION]);
    // No content anywhere in the answer, and no secret value.
    expect(JSON.stringify(listed)).not.toInclude("FIXTUREseededGithubToken");
    expect(JSON.stringify(listed)).not.toInclude("PRIVATE KEY");
  });

  test("--requests answers only the open slots, with no entries", async () => {
    const { hermetic } = open();
    const listed = await hermetic.files.list({ name: AGENT, requests: true });
    expect(listed.inbox).toEqual([]);
    expect(listed.outbox).toEqual([]);
    expect(listed.secrets).toEqual([]);
    expect(listed.requests.every((r) => r.state === "open")).toBe(true);
    expect(listed.requests).toHaveLength(1);
  });

  test("an unknown agent is refused before any box is asked", async () => {
    const { hermetic } = open();
    expect((await refusal(hermetic.files.list({ name: "nosuch" }))).code).toBe("NOT_FOUND");
  });
});

describe("files.get", () => {
  test("writes the exact bytes, and the saved event names the file, not the path", async () => {
    const { hermetic, backend } = open();
    const path = fresh("contract.pdf");
    const events = await getAll(hermetic.files.get({ name: AGENT, id: IDS.pdf, dest: { path } }));
    const saved = events.at(-1);
    expect(saved?.type).toBe("saved");
    const want = backend.files.entry(AGENT, IDS.pdf)?.bytes ?? new Uint8Array();
    expect(Buffer.from(readFileSync(path)).equals(Buffer.from(want))).toBe(true);
    expect(want.byteLength).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toInclude(path);
    for (const e of events) {
      if (e.type === "progress") expect(e.message).not.toInclude("vendor-contract");
    }
  });

  test("an outbox share downloads too", async () => {
    const { hermetic } = open();
    const path = fresh("summary.csv");
    await getAll(hermetic.files.get({ name: AGENT, id: IDS.csv, dest: { path } }));
    expect(readFileSync(path, "utf8")).toStartWith("vendor,invoices");
  });

  test("an existing path is refused and left as it was", async () => {
    const { hermetic } = open();
    const path = fresh("exists.pdf");
    writeFileSync(path, "KEEP");
    const e = await refusal(getAll(hermetic.files.get({ name: AGENT, id: IDS.pdf, dest: { path } })));
    expect(e.code).toBe("CONFLICT");
    expect(readFileSync(path, "utf8")).toBe("KEEP");
  });

  test("a secret is refused from the listing, and nothing is created", async () => {
    const { hermetic } = open();
    const path = fresh("secret.pem");
    const e = await refusal(getAll(hermetic.files.get({ name: AGENT, id: IDS.pem, dest: { path } })));
    expect(e.code).toBe("FILE_SECRET_FORBIDDEN");
    expect(existsSync(path)).toBe(false);
  });

  test("a secret a lying listing calls a file is refused by the content route, partial unlinked", async () => {
    const { hermetic, backend } = open();
    const listed = await backend.files.list(AGENT, {});
    const pem = listed.secrets.find((s) => s.id === IDS.pem);
    if (pem === undefined) throw new Error("seeded secret missing");
    const list = backend.files.list.bind(backend.files);
    backend.files.list = async (agent, opts) => {
      const real = await list(agent, opts);
      return { ...real, secrets: [], inbox: [...real.inbox, { ...pem, dir: "inbox", class: "file" }] };
    };
    const path = fresh("lied.pem");
    const e = await refusal(getAll(hermetic.files.get({ name: AGENT, id: IDS.pem, dest: { path } })));
    expect(e.code).toBe("FILE_SECRET_FORBIDDEN");
    expect(existsSync(path)).toBe(false);
  });

  test("bytes that do not hash to the listing are refused and the partial file unlinked", async () => {
    const { hermetic, backend } = open();
    const content = backend.files.content.bind(backend.files);
    // The box claims the listed digest but sends other bytes of the same length.
    backend.files.content = async (agent, id, opts) => {
      const real = await content(agent, id, opts);
      const bytes = real.bytes.slice();
      bytes[0] = (bytes[0] ?? 0) ^ 0xff;
      return { ...real, bytes };
    };
    const path = fresh("tampered.pdf");
    const e = await refusal(getAll(hermetic.files.get({ name: AGENT, id: IDS.pdf, dest: { path } })));
    expect(e.code).toBe("FILE_DIGEST_MISMATCH");
    expect(existsSync(path)).toBe(false);
  });

  test("a body shorter than the listing is refused and the partial file unlinked", async () => {
    const { hermetic, backend } = open();
    const content = backend.files.content.bind(backend.files);
    backend.files.content = async (agent, id, opts) => {
      const real = await content(agent, id, opts);
      const bytes = real.bytes.slice(0, real.bytes.byteLength - 10);
      // Self-consistent, so only the listing's size can catch it.
      return { ...real, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
    };
    const path = fresh("short.pdf");
    const e = await refusal(getAll(hermetic.files.get({ name: AGENT, id: IDS.pdf, dest: { path } })));
    expect(e.code).toBe("FILE_DIGEST_MISMATCH");
    expect(e.message).toInclude("size");
    expect(existsSync(path)).toBe(false);
  });

  test("the fixture box refuses bytes that changed under its index", async () => {
    const { hermetic, backend } = open();
    const entry = backend.files.entry(AGENT, IDS.csv);
    if (entry === undefined) throw new Error("seeded share missing");
    entry.bytes = new TextEncoder().encode("vendor,changed\n".padEnd(entry.bytes.byteLength, "x"));
    const path = fresh("changed.csv");
    const e = await refusal(getAll(hermetic.files.get({ name: AGENT, id: IDS.csv, dest: { path } })));
    expect(e.code).toBe("FILE_DIGEST_MISMATCH");
    expect(existsSync(path)).toBe(false);
  });

  test("a save-dialog folder gets the file under its sanitized name, once per id", async () => {
    const { hermetic } = open();
    const folder = mkdtempSync(join(dir, "dest-"));
    const { dest_id } = await hermetic.files.internal.registerDestination(folder);
    expect(dest_id).toMatch(/^sv_/);
    const events = await getAll(hermetic.files.get({ name: AGENT, id: IDS.png, dest: { dest_id } }));
    expect(events.at(-1)).toMatchObject({ type: "saved", file: { name: "dashboard.png" } });
    expect(readdirSync(folder)).toEqual(["dashboard.png"]);
    const again = await refusal(
      getAll(hermetic.files.get({ name: AGENT, id: IDS.pdf, dest: { dest_id } })),
    );
    expect(again.code).toBe("NOT_FOUND");
  });

  test("a create refused CONFLICT leaves the save-dialog id usable", async () => {
    const { hermetic } = open();
    const folder = mkdtempSync(join(dir, "dest-"));
    writeFileSync(join(folder, "dashboard.png"), "already here");
    const { dest_id } = await hermetic.files.internal.registerDestination(folder);
    const e = await refusal(
      getAll(hermetic.files.get({ name: AGENT, id: IDS.png, dest: { dest_id } })),
    );
    expect(e.code).toBe("CONFLICT");
    expect(readFileSync(join(folder, "dashboard.png"), "utf8")).toBe("already here");
    // The same id, another file: still good, and spent by this success.
    const events = await getAll(hermetic.files.get({ name: AGENT, id: IDS.csv, dest: { dest_id } }));
    expect(events.at(-1)?.type).toBe("saved");
    expect(readdirSync(folder).sort()).toEqual(["dashboard.png", "vendor-summary.csv"]);
  });

  test("the saved event names the sanitized name the file was written under", async () => {
    const { hermetic, backend } = open();
    const entry = backend.files.entry(AGENT, IDS.csv);
    if (entry === undefined) throw new Error("seeded share missing");
    entry.name = "café.csv"; // NFD; written NFC
    const folder = mkdtempSync(join(dir, "dest-"));
    const { dest_id } = await hermetic.files.internal.registerDestination(folder);
    const events = await getAll(hermetic.files.get({ name: AGENT, id: IDS.csv, dest: { dest_id } }));
    const saved = events.at(-1);
    expect(saved?.type === "saved" ? saved.file.name : null).toBe("café.csv");
    expect(readdirSync(folder)).toEqual(["café.csv"]);
  });

  test("a listing over the download cap is FILE_TOO_LARGE before anything is created", async () => {
    const { hermetic, backend } = open();
    const list = backend.files.list.bind(backend.files);
    backend.files.list = async (agent, opts) => {
      const real = await list(agent, opts);
      return {
        ...real,
        inbox: real.inbox.map((e) =>
          e.id === IDS.pdf ? { ...e, bytes: FILES_LIMITS.fileBytes + 1 } : e,
        ),
      };
    };
    let fetched = false;
    backend.files.content = async () => {
      fetched = true;
      throw new Error("must not fetch");
    };
    const path = fresh("huge.pdf");
    const e = await refusal(getAll(hermetic.files.get({ name: AGENT, id: IDS.pdf, dest: { path } })));
    expect(e.code).toBe("FILE_TOO_LARGE");
    expect(fetched).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  test("the box is held to exactly the listed size, never the cap", async () => {
    const { hermetic, backend } = open();
    const content = backend.files.content.bind(backend.files);
    const asked: number[] = [];
    backend.files.content = async (agent, id, opts) => {
      asked.push(opts.maxBytes);
      return await content(agent, id, opts);
    };
    await getAll(hermetic.files.get({ name: AGENT, id: IDS.pdf, dest: { path: fresh("exact.pdf") } }));
    expect(asked).toEqual([backend.files.entry(AGENT, IDS.pdf)?.bytes.byteLength ?? -1]);
  });

  test("afterWrite sees the written file before saved; a throwing hook keeps the file", async () => {
    const { hermetic } = open();
    const seen: string[] = [];
    const path = fresh("hooked.csv");
    const events = await getAll(
      hermetic.files.get(
        { name: AGENT, id: IDS.csv, dest: { path } },
        {
          afterWrite: async (p) => {
            seen.push(p);
            expect(existsSync(p)).toBe(true);
          },
        },
      ),
    );
    expect(seen).toEqual([path]);
    expect(events.at(-1)?.type).toBe("saved");

    const other = fresh("hook-throws.csv");
    const again = await getAll(
      hermetic.files.get(
        { name: AGENT, id: IDS.csv, dest: { path: other } },
        {
          afterWrite: async () => {
            throw new Error("xattr failed");
          },
        },
      ),
    );
    expect(again.at(-1)?.type).toBe("saved");
    expect(existsSync(other)).toBe(true);
  });

  test("the bridge's schema takes a dest_id and never a path", async () => {
    const { FilesGetApiInput } = await import("../src/schema/index.ts");
    expect(
      FilesGetApiInput.safeParse({ name: AGENT, id: IDS.pdf, dest: { path: "/tmp/x" } }).success,
    ).toBe(false);
  });
});

describe("files.rm", () => {
  test("an inbox file: one box step, no SSM, and apply removes only the entry", async () => {
    const { hermetic, backend } = open();
    const plan = await hermetic.files.rm({ name: AGENT, id: IDS.pdf });
    expect(plan.kind).toBe("files-rm");
    expect(plan.target).toBe(AGENT);
    expect(plan.steps.map((s) => s.id)).toEqual(["box"]);
    expect(plan.options.file).toMatchObject({ id: IDS.pdf, dir: "inbox", class: "file" });
    expect(plan.options.file?.slot).toBeUndefined();
    backend.mutations.length = 0;
    await drain(hermetic.apply({ plan, yes: true }));
    expect(backend.files.entry(AGENT, IDS.pdf)).toBeUndefined();
    expect(backend.mutations).not.toContain("secrets.delete");
  });

  test("a durable secret's plan names its SSM parameter; apply deletes it after the entry", async () => {
    const { hermetic, backend, fleet } = open();
    const path = agentParamPath(fleet, AGENT, "file-github-app-pem");
    // The fixture seeds the entry, not its parameter; put one where apply will look.
    backend.params.set(path, "FIXTURE-envelope");
    const plan = await hermetic.files.rm({ name: AGENT, id: IDS.pem });
    expect(plan.steps.map((s) => s.id)).toEqual(["box", "ssm"]);
    expect(plan.steps[1]?.description).toInclude(path);
    await drain(hermetic.apply({ plan, yes: true }));
    expect(backend.params.has(path)).toBe(false);
    const listed = await hermetic.files.list({ name: AGENT });
    expect(listed.secrets.map((e) => e.id)).not.toContain(IDS.pem);
  });

  test("a plan whose entry changed since is PLAN_STALE and deletes nothing", async () => {
    const { hermetic, backend, fleet } = open();
    backend.params.set(agentParamPath(fleet, AGENT, "env-github"), "FIXTURE-envelope");
    const plan: Plan = await hermetic.files.rm({ name: AGENT, id: IDS.env });
    const stale: Plan = {
      ...plan,
      options: { ...plan.options, file: { ...plan.options.file!, sha256: "0".repeat(64) } },
    };
    const e = await refusal(drain(hermetic.apply({ plan: stale, yes: true })));
    expect(e.code).toBe("PLAN_STALE");
    expect(backend.params.has(agentParamPath(fleet, AGENT, "env-github"))).toBe(true);
  });

  test("a plan naming a slot that is not file-*/env-* is refused before anything is deleted", async () => {
    const { hermetic, backend } = open();
    const plan = await hermetic.files.rm({ name: AGENT, id: IDS.env });
    const forged: Plan = {
      ...plan,
      options: { ...plan.options, file: { ...plan.options.file!, slot: "provider-key" } },
    };
    const e = await refusal(drain(hermetic.apply({ plan: forged, yes: true })));
    expect(e.code).toBe("VALIDATION");
    expect((await backend.files.list(AGENT, {})).secrets.map((s) => s.id)).toContain(IDS.env);
  });

  test("an unknown entry is FILE_NOT_FOUND at plan time", async () => {
    const { hermetic } = open();
    const e = await refusal(hermetic.files.rm({ name: AGENT, id: "f_nosuchentry0" }));
    expect(e.code).toBe("FILE_NOT_FOUND");
  });
});

describe("files.rm against SSM (aws-sdk-client-mock)", () => {
  const ssm = mockClient(SSMClient);
  afterEach(() => ssm.reset());

  function withSsm() {
    const opened = open();
    ssm.on(DeleteParameterCommand).resolves({});
    Object.defineProperty(opened.backend, "secrets", {
      value: new SsmSecrets(new SSMClient({ region: "us-west-2" })),
    });
    return opened;
  }

  test("a durable text secret deletes exactly its env-* parameter", async () => {
    const { hermetic, fleet } = withSsm();
    const plan = await hermetic.files.rm({ name: AGENT, id: IDS.env });
    await drain(hermetic.apply({ plan, yes: true }));
    const calls = ssm.commandCalls(DeleteParameterCommand).map((c) => c.args[0].input);
    expect(calls).toEqual([{ Name: agentParamPath(fleet, AGENT, "env-github") }]);
  });

  test("op events never name the slot; an SSM failure says how to finish, the slot in details only", async () => {
    const { hermetic, fleet } = withSsm();
    const path = agentParamPath(fleet, AGENT, "file-github-app-pem");
    ssm.on(DeleteParameterCommand).rejects(new Error(`throttled deleting ${path}`));
    const plan = await hermetic.files.rm({ name: AGENT, id: IDS.pem });
    const events: { message: string }[] = [];
    let failure: HermeticError | null = null;
    try {
      for await (const e of hermetic.apply({ plan, yes: true })) events.push(e);
    } catch (e) {
      if (!(e instanceof HermeticError)) throw e;
      failure = e;
    }
    if (failure === null) throw new Error("expected the SSM step to fail");
    expect(events.length).toBeGreaterThan(0);
    for (const text of [...events.map((e) => e.message), failure.message]) {
      expect(text).not.toInclude("github-app-pem");
      expect(text).not.toInclude(path);
    }
    expect(failure.message).toInclude("by hand");
    expect(failure.details).toMatchObject({ ssm_slot: "file-github-app-pem", ssm_path: path });
    const listed = await hermetic.files.list({ name: AGENT });
    expect(listed.secrets.map((e) => e.id)).not.toContain(IDS.pem);
  });

  test("an inbox file sends no DeleteParameter", async () => {
    const { hermetic } = withSsm();
    const plan = await hermetic.files.rm({ name: AGENT, id: IDS.png });
    await drain(hermetic.apply({ plan, yes: true }));
    expect(ssm.commandCalls(DeleteParameterCommand)).toHaveLength(0);
  });
});
