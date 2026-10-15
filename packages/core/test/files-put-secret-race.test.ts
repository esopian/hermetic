import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentParamPrefix } from "../src/backend/constants.ts";
import { FIXTURE_CONFIG, MemoryBackend, seedFixtureFleet } from "../src/backend/memory.ts";
import { HermeticError } from "../src/errors.ts";
import { createFilesPut } from "../src/files/put.ts";
import { createUploadRegistry } from "../src/files/uploads.ts";
import type { FileRequest, FilesPutEvent } from "../src/schema/index.ts";
import { testContext } from "./helpers.ts";

/**
 * `files.put`'s durable-secret lane when the box's `/secret` answer is lost or
 * the put is stopped while the box still holds the request `receiving`. The
 * box does not stop materialising when the laptop's call is dropped, so a
 * `receiving` slot is no evidence it refused: the parameter the put created
 * stays until the box conclusively did not take it. Fixture backend only, and
 * only FIXTURE values.
 */

const dir = mkdtempSync(join(tmpdir(), "hermetic-files-put-race-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const AGENT = "atlas";
const PEM = new TextEncoder().encode(
  "-----BEGIN PRIVATE KEY-----\nFIXTUREFIXTUREFIXTUREraceFIXTURE\n-----END PRIVATE KEY-----\n",
);

/** What the box's slot reads as on each read after the put's own first read. */
type Script = (read: number, real: FileRequest) => FileRequest | Promise<FileRequest>;

const receiving = (real: FileRequest): FileRequest => {
  const { fulfilled: _fulfilled, ...rest } = real;
  return { ...rest, state: "receiving" };
};

function setup(opts: {
  /** Whether the box really fulfils the request before the answer is lost. */
  boxTakes: boolean;
  script: Script;
  timeoutMs?: number;
  /** Stop the put from inside the `/secret` call. */
  stop?: AbortController;
}) {
  const backend = seedFixtureFleet(new MemoryBackend());
  const ctx = testContext(backend, { config: FIXTURE_CONFIG });
  const { put } = createFilesPut({
    ctx,
    uploads: createUploadRegistry(),
    secretSettle: { intervalMs: 1, timeoutMs: opts.timeoutMs ?? 5_000 },
  });
  const files = backend.files;
  const request = files.request.bind(files);
  const secret = files.secret.bind(files);
  let reads = 0;
  files.request = async (agent, id, callOpts) => {
    reads++;
    const real = await request(agent, id, callOpts);
    return reads === 1 ? real : opts.script(reads - 1, real);
  };
  files.secret = async (agent, id, body, callOpts) => {
    if (opts.boxTakes) await secret(agent, id, body, callOpts);
    opts.stop?.abort();
    throw opts.stop
      ? new HermeticError("ABORTED", "the file transfer was stopped")
      : new HermeticError("INTERNAL", "atlas: the connection dropped");
  };
  const fleet = backend.boundFleetId() as string;
  const slots = (): string[] =>
    [...backend.params.keys()].filter((k) => k.startsWith(`${agentParamPrefix(fleet)}${AGENT}/file-`));
  const slot = files.openRequest(AGENT, { purpose: "FIXTURE secret", sensitivity: "secret" });
  const path = join(dir, `${slot.request_id}-FIXTURE.pem`);
  writeFileSync(path, PEM);
  const run = (): AsyncIterable<FilesPutEvent> =>
    put(
      { instance: AGENT, request_id: slot.request_id, source: { path } },
      opts.stop ? { signal: opts.stop.signal } : {},
    );
  return { backend, slots, run, reads: () => reads };
}

async function refusal(events: AsyncIterable<FilesPutEvent>): Promise<HermeticError> {
  try {
    for await (const _e of events) {
      // Drain the transfer.
    }
  } catch (e) {
    if (e instanceof HermeticError) return e;
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("files.put: a durable secret the box is still receiving when the put fails", () => {
  test("a stop while the box is receiving keeps the parameter and says it may be delivered", async () => {
    const stop = new AbortController();
    const t = setup({ boxTakes: false, stop, timeoutMs: 30, script: (_n, real) => receiving(real) });
    const e = await refusal(t.run());
    expect(e.code).toBe("ABORTED");
    expect(e.message).toContain("may have been delivered");
    expect(e.details?.["ssm"]).toBe("pending");
    expect(t.slots().length).toBe(1);
    // Polled, not read once: the stop did not cut the wait short.
    expect(t.reads()).toBeGreaterThan(2);
  });

  test("a lost answer while receiving keeps the parameter when the wait runs out", async () => {
    const t = setup({ boxTakes: false, timeoutMs: 30, script: (_n, real) => receiving(real) });
    const e = await refusal(t.run());
    expect(e.code).toBe("INTERNAL");
    expect(e.details?.["ssm"]).toBe("pending");
    expect(t.slots().length).toBe(1);
  });

  test("receiving, then fulfilled from this slot: the parameter is kept as taken", async () => {
    const stop = new AbortController();
    const t = setup({
      boxTakes: true,
      stop,
      script: (n, real) => (n < 3 ? receiving(real) : real),
    });
    const e = await refusal(t.run());
    expect(e.code).toBe("ABORTED");
    expect(e.details?.["ssm"]).toBe("taken");
    expect(t.slots().length).toBe(1);
    expect(t.reads()).toBe(4);
  });

  test("receiving, then open again: the box let it go, so the parameter is deleted", async () => {
    const t = setup({ boxTakes: false, script: (n, real) => (n < 3 ? receiving(real) : real) });
    const e = await refusal(t.run());
    expect(e.code).toBe("INTERNAL");
    expect(e.details?.["ssm"]).toBeUndefined();
    expect(t.slots()).toEqual([]);
  });

  test("receiving, then declined: the parameter is deleted", async () => {
    const t = setup({
      boxTakes: false,
      script: (n, real) => (n < 2 ? receiving(real) : { ...real, state: "declined" }),
    });
    await refusal(t.run());
    expect(t.slots()).toEqual([]);
  });

  test("expired: the parameter is deleted", async () => {
    const t = setup({ boxTakes: false, script: (_n, real) => ({ ...real, state: "expired" }) });
    await refusal(t.run());
    expect(t.slots()).toEqual([]);
  });

  test("fulfilled from another slot: the parameter is deleted", async () => {
    const t = setup({
      boxTakes: true,
      script: (_n, real) => ({
        ...real,
        fulfilled: {
          ...(real.fulfilled as NonNullable<FileRequest["fulfilled"]>),
          ssm_slot: "file-other",
        },
      }),
    });
    await refusal(t.run());
    expect(t.slots()).toEqual([]);
  });

  test("a read that fails after receiving keeps the parameter", async () => {
    const t = setup({
      boxTakes: false,
      script: (n, real) => {
        if (n < 2) return receiving(real);
        throw new HermeticError("INTERNAL", "atlas: unreachable");
      },
    });
    const e = await refusal(t.run());
    expect(e.details?.["ssm"]).toBe("pending");
    expect(t.slots().length).toBe(1);
  });
});
