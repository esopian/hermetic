/**
 * What `init --create` says while it works (§4.7): start/done kinds around the
 * long phases, resource events while the stack is created, a heartbeat when it
 * is quiet, the artifact located before anything is created and pushed after,
 * and a `ready` checklist at the end.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { MemoryBackend } from "../src/backend/memory.ts";
import type { StackProgress } from "../src/backend/types.ts";
import { HermeticError } from "../src/errors.ts";
import { drain, installTestStages, testHermetic } from "./helpers.ts";

/**
 * §4.8: these walk `init --create`, so the account they describe has no fleets
 * in it yet. The fixture directory is process-global and seeded with
 * `main`/`staging` for the *populated* fixture account, and an unnamed create
 * against that one is correctly refused — so each of these says which account
 * it is in rather than inheriting whichever ran last.
 */
// A real-mode push needs a release, and a release is a binary *and* its stages.
const stages = installTestStages();
afterAll(() => stages.restore());

const INPUT = {
  create: true as const,
  region: "us-west-2",
  profile: "acme-dev",
  account_id_typed: "123456789012",
  tailnet: "acme.ts.net",
  tailscale_oauth_secret: "tskey-client-FIXTURE-OAUTH",
};

describe("init --create narrates the foundation", () => {
  test("start before createStack, one line per resource, done after, then ready", async () => {
    const backend = new MemoryBackend();
    const hermetic = testHermetic({ backend, config: null, fixture: true });
    const events = await drain(hermetic.init(INPUT));
    const foundation = events.filter((e) => e.phase === "foundation");

    expect(foundation[0]).toMatchObject({ kind: "start" });
    expect(foundation[0]!.message).toContain("resources, typically");
    expect(foundation.at(-1)).toMatchObject({ kind: "done" });
    // The stack is named for the fleet it belongs to (§5).
    expect(foundation.at(-1)!.message).toMatch(/created stack hermetic-[0-9a-z]{8} \(public\) in \d+s/);
    // The fixture lands ten resources; each CREATE_COMPLETE is a line with a running count.
    const landed = foundation.filter((e) => /CREATE_COMPLETE \(\d+\/\d+\)/.test(e.message));
    expect(landed.length).toBe(10);
    expect(landed[0]!.message).toMatch(/^Vpc CREATE_COMPLETE \(1\//);
    // The bar moves within the phase and never overtakes the phase's end.
    const progresses = foundation.map((e) => e.progress);
    expect([...progresses].sort((a, b) => a - b)).toEqual(progresses);
    expect(Math.max(...progresses)).toBe(0.5);

    // The start event precedes the backend call, and the artifact is located before it.
    const order = events.map((e) => `${e.phase}${e.kind ? `:${e.kind}` : ""}`);
    expect(order.indexOf("foundation:start")).toBeGreaterThan(order.indexOf("preflight"));
    expect(backend.mutations.indexOf("foundation.createStack")).toBeGreaterThan(-1);

    const ready = events.filter((e) => e.phase === "ready");
    expect(ready.map((e) => e.level ?? "info")).toEqual(["info", "info", "info"]);
    expect(ready[0]!.message).toContain("the fleet manifest names hermeticd");
    expect(ready[2]!.message).toContain("tagOwners");
    expect(events.at(-1)!.message).toContain("next: hermetic agent create");
  });

  test("a quiet stack create heartbeats, with the elapsed time", async () => {
    const backend = new MemoryBackend();
    // A create that reports nothing for a while, then finishes.
    const original = backend.foundation.createStack;
    backend.foundation.createStack = async (params) => {
      params.onProgress?.({
        status: "CREATE_IN_PROGRESS",
        elapsed_ms: 1,
        events: [],
        events_available: true,
      });
      await new Promise((r) => setTimeout(r, 60));
      return original({ fleet_id: params.fleet_id, network: params.network, tags: params.tags });
    };
    const hermetic = testHermetic({ backend, config: null, fixture: true, stackWaitProgressMs: 20 });
    const events = await drain(hermetic.init(INPUT));
    const beats = events.filter(
      (e) => e.phase === "foundation" && e.message.startsWith("still creating hermetic"),
    );
    expect(beats.length).toBeGreaterThanOrEqual(1);
    expect(beats[0]!.message).toMatch(/CREATE_IN_PROGRESS, \d+s/);
    expect(beats[0]!.kind).toBeUndefined();
  });

  test("a failing resource is an error line before the op fails", async () => {
    const backend = new MemoryBackend();
    backend.foundation.createStack = async (params) => {
      params.onProgress?.({
        status: "CREATE_IN_PROGRESS",
        elapsed_ms: 5,
        events_available: true,
        events: [
          {
            event_id: "1",
            logical_id: "Vpc",
            resource_type: "AWS::EC2::VPC",
            status: "CREATE_COMPLETE",
            reason: null,
            at: new Date().toISOString(),
          },
          {
            event_id: "2",
            logical_id: "AgentRole",
            resource_type: "AWS::IAM::Role",
            status: "CREATE_FAILED",
            reason: "already exists",
            at: new Date().toISOString(),
          },
          {
            event_id: "3",
            logical_id: "Bucket",
            resource_type: "AWS::S3::Bucket",
            status: "CREATE_FAILED",
            reason: "Resource creation cancelled",
            at: new Date().toISOString(),
          },
        ],
      } satisfies StackProgress);
      throw new HermeticError(
        "INTERNAL",
        "the hermetic stack finished in ROLLBACK_COMPLETE: AgentRole (AWS::IAM::Role) CREATE_FAILED: already exists",
      );
    };
    const hermetic = testHermetic({ backend, config: null, fixture: true });
    const seen: string[] = [];
    let err: unknown;
    try {
      for await (const e of hermetic.init(INPUT)) seen.push(`${e.level ?? "info"} ${e.message}`);
    } catch (e) {
      err = e;
    }
    expect(seen).toContain("error AgentRole (AWS::IAM::Role) CREATE_FAILED: already exists");
    expect(seen.some((l) => l.includes("cancelled"))).toBe(false);
    expect((err as HermeticError).message).toContain("AgentRole");
  });

  test("--skip-artifacts is a warning at preflight and in the ready checklist, not a push", async () => {
    const backend = new MemoryBackend();
    const hermetic = testHermetic({ backend, config: null, fixture: true });
    const events = await drain(hermetic.init({ ...INPUT, skip_artifacts: true }));
    expect(events.find((e) => e.phase === "preflight" && e.level === "warn")?.message).toContain(
      "--skip-artifacts",
    );
    expect(events.filter((e) => e.phase === "artifacts" && e.kind === "start")).toHaveLength(0);
    const ready = events.filter((e) => e.phase === "ready");
    expect(ready[0]).toMatchObject({ level: "warn" });
    expect(ready[0]!.message).toContain("hermetic artifacts push");
    expect(ready[0]!.message).toContain("no fleet manifest");
  });

  test("no OAuth secret is the last thing said before done", async () => {
    const backend = new MemoryBackend();
    const hermetic = testHermetic({ backend, config: null, fixture: true });
    const { tailscale_oauth_secret: _omit, ...withoutSecret } = INPUT;
    const events = await drain(hermetic.init(withoutSecret));
    const ready = events.filter((e) => e.phase === "ready");
    expect(ready.at(-1)).toMatchObject({ level: "warn" });
    // The slot is scoped by the fleet id this init just minted (§8.2).
    expect(ready.at(-1)!.message).toMatch(/\/hermetic\/[0-9a-hjkmnp-tv-z]{8}\/tailscale\/oauth-secret/);
  });

  test("a real backend with no hermeticd anywhere refuses before creating anything", async () => {
    const backend = new MemoryBackend();
    const hermetic = testHermetic({
      backend,
      config: null,
      fixture: false,
      resolveHermeticd: async () => null,
    });
    let err: unknown;
    try {
      await drain(hermetic.init(INPUT));
    } catch (e) {
      err = e;
    }
    expect((err as HermeticError).code).toBe("HERMETICD_UNAVAILABLE");
    expect(backend.mutations).not.toContain("foundation.createStack");
    expect(backend.stack).toBeNull();
  });

  test("a real backend pushes the resolved binary and says where it came from", async () => {
    const backend = new MemoryBackend();
    const bin = import.meta.path; // any readable file stands in for the binary
    const hermetic = testHermetic({
      backend,
      config: null,
      fixture: false,
      resolveHermeticd: async () => ({ path: bin, source: "built", version: "0.4.1", build: "aaaa" }),
    });
    const events = await drain(hermetic.init(INPUT));
    expect(events.find((e) => e.phase === "preflight" && e.kind === "done")?.message).toContain(
      `built: ${bin}`,
    );
    expect(events.find((e) => e.phase === "artifacts" && e.kind === "start")?.message).toContain(bin);
    expect(events.find((e) => e.phase === "artifacts" && e.kind === "done")?.message).toMatch(
      /^pushed artifacts\//,
    );
    expect(events.find((e) => e.phase === "ready")?.message).toContain(
      "the fleet manifest names hermeticd",
    );
    expect(events.find((e) => e.phase === "artifacts" && e.kind === "done")?.message).toContain(
      "2 stage(s)",
    );
  });
});
