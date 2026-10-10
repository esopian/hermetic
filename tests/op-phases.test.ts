/**
 * The agent drawer's progress rail against the ops it draws.
 *
 * The rail is seeded from a phase list the UI keeps by hand — it may not import
 * core (§3.1) — and `useOp` appends anything core emits that the list omits
 * *after* the seeded steps, as a raw phase key. A destroy therefore ended with
 * a step called `tailnet` under "Done", and, because the list was create's,
 * announced "Allocate the data volume" over the step that deletes it.
 *
 * Root `tests/` is the one place allowed to import core and a head at once, so
 * the pinning happens here: every lifecycle op is run against the in-memory
 * backend and the phases it actually emits, in first-appearance order, are
 * checked against `phasesForOp` — and every one of them against `labelsForOp`,
 * so no rail row can fall back to its raw key.
 */
import { describe, expect, test } from "bun:test";
import {
  FIXTURE_CONFIG,
  MemoryBackend,
  createHermetic,
  seedFixtureFleet,
  seedFixtureFoundation,
} from "@hermetic/core";
import type { OpEvent } from "@hermetic/core";
import { labelsForOp, phasesForOp } from "../packages/ui/src/lib/useOp.ts";

/**
 * A core over the fixture fleet. The waits are shrunk for the reason
 * `packages/core/test/helpers.ts` shrinks them: the attach poll is five seconds
 * in production.
 */
function open(backend: MemoryBackend) {
  return createHermetic({
    backend,
    config: FIXTURE_CONFIG,
    fixture: true,
    attach: { pollMs: 1, progressMs: 0 },
  });
}

const seeded = () => open(seedFixtureFleet(new MemoryBackend()));
const empty = () => open(seedFixtureFoundation(new MemoryBackend()));

/** The phases an op emitted, deduped on first sight — exactly what the rail does. */
async function phasesOf(stream: AsyncIterable<OpEvent>): Promise<string[]> {
  const seen: string[] = [];
  for await (const e of stream) if (!seen.includes(e.phase)) seen.push(e.phase);
  return seen;
}

/**
 * What the UI owes an op it just watched: a seed list with every emitted phase
 * in it, in the order they arrive, and a word for each.
 */
function pin(label: string, emitted: readonly string[], unreachable: readonly string[] = []) {
  const seed = [...phasesForOp(label)];
  expect(emitted, `${label}: the rail is seeded with core's phases, in core's order`).toEqual(
    seed.filter((p) => !unreachable.includes(p)),
  );
  const labels = labelsForOp(label);
  // Every seeded step, not only the ones this run reached: an unreachable one is
  // still drawn, greyed, for the whole op.
  for (const phase of seed) {
    expect(labels[phase], `${label}/${phase} has no label of its own`).toBeString();
  }
}

describe("the lifecycle rails are core's phases", () => {
  test("create", async () => {
    const emitted = await phasesOf(empty().agents.create({ name: "atlas" }));
    expect(emitted).toEqual(["validate", "secrets", "render", "volume", "instance", "done"]);
    /**
     * `handoff` — the bounded wait for hermeticd's first report, where a real
     * create spends most of its minutes (§6.3) — is the one seeded step this
     * cannot produce: the watch ends on a deadline read from the backend clock,
     * the fixture's is frozen, and so a non-zero budget never expires. Core
     * defaults the budget to zero for that reason; `open.ts` turns it on for the
     * portal, and `packages/core/test/handoff.test.ts` drives it with a clock of
     * its own.
     */
    pin("create", emitted, ["handoff"]);
  });

  test("destroy", async () => {
    const emitted = await phasesOf(seeded().agents.destroy({ name: "atlas", yes: true }));
    // The bootstrap in reverse: the box, its tailnet device, its secrets, its
    // config objects, the volume (deleted unless kept), then the row itself —
    // tombstone written, record deleted, name free (§6.7).
    expect(emitted).toEqual(["instance", "tailnet", "secrets", "config", "volume", "release", "done"]);
    pin("destroy", emitted);
  });

  test("recreate", async () => {
    const emitted = await phasesOf(seeded().agents.recreate({ name: "atlas", yes: true }));
    // No `render`/`upload`/`volume`: the volume is kept and the config goes up
    // inside `instance`, which terminates the old box and launches its
    // replacement. The old node leaves the tailnet before the new key is minted,
    // so the replacement can be admitted under the canonical name (§6.5).
    expect(emitted).toEqual(["plan", "instance", "tailnet", "secrets", "done"]);
    pin("recreate", emitted);
  });

  test("stop", async () => {
    const emitted = await phasesOf(seeded().agents.stop("atlas"));
    expect(emitted).toEqual(["instance", "done"]);
    pin("stop", emitted);
  });

  test("start", async () => {
    const emitted = await phasesOf(seeded().agents.start("juniper"));
    expect(emitted).toEqual(["instance", "done"]);
    pin("start", emitted);
  });
});
