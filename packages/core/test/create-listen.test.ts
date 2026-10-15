/**
 * §9.2: `agent create` listens to the new instance by default. The listen is
 * written once per incarnation, at the claim, and nothing that acts on an
 * existing row — a resume, `recreate` — writes it again, so an operator who
 * turned it off keeps it off. A released name is a new agent next time.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HermeticError } from "../src/errors.ts";
import { FIXTURE_CONFIG } from "../src/backend/memory.ts";
import { MemoryInstanceListeningStore } from "../src/chat/instance-listening.ts";
import { MemoryIncarnationStore } from "../src/local/incarnations.ts";
import { openHermetic } from "../src/open.ts";
import { drain, freshFleet, testHermetic } from "./helpers.ts";

const homes: string[] = [];
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

/** A listening store whose first `failures` writes throw, as a locked SQLite would. */
class FlakyListening extends MemoryInstanceListeningStore {
  calls = 0;
  constructor(private readonly failures: number) {
    super();
  }
  override set(fleet: string | null, instance: string, listening: boolean): void {
    this.calls += 1;
    if (this.calls <= this.failures) throw new Error("database is locked");
    super.set(fleet, instance, listening);
  }
}

async function listening(hermetic: ReturnType<typeof testHermetic>): Promise<string[]> {
  return (await hermetic.chat.listening({})).instances;
}

describe("agents.create listens by default", () => {
  test("a created agent is a listened instance", async () => {
    const { hermetic } = freshFleet();
    expect(await listening(hermetic)).toEqual([]);
    await drain(hermetic.agents.create({ name: "atlas" }));
    expect(await listening(hermetic)).toEqual(["atlas"]);
    // A complete scan records the incarnation the create already recorded, and
    // purges nothing.
    await hermetic.agents.list();
    expect(await listening(hermetic)).toEqual(["atlas"]);
  });

  test("recreate keeps a listen the operator turned off", async () => {
    const { hermetic } = freshFleet();
    await drain(hermetic.agents.create({ name: "atlas" }));
    await hermetic.chat.listen({ instance: "atlas", listening: false });
    await drain(hermetic.agents.recreate({ name: "atlas", yes: true }));
    expect(await listening(hermetic)).toEqual([]);
  });

  test("resuming an interrupted create does not turn a listen back on", async () => {
    const { backend, hermetic } = freshFleet();
    const controller = new AbortController();
    await expect(
      (async () => {
        for await (const e of hermetic.agents.create(
          { name: "granite" },
          { signal: controller.signal },
        )) {
          if (e.phase === "volume") controller.abort();
        }
      })(),
    ).rejects.toThrow(HermeticError);
    // The interrupted run claimed the row, so the agent is already listened to.
    expect(await listening(hermetic)).toEqual(["granite"]);

    await hermetic.chat.listen({ instance: "granite", listening: false });
    const events = await drain(hermetic.agents.create({ name: "granite" }));
    expect(events.map((e) => e.phase)).toContain("resume");
    expect((await backend.store.agents.get("granite"))!.resources.instance_id).toBeString();
    expect(await listening(hermetic)).toEqual([]);
  });

  test("a destroyed name is forgotten, and created again it is listened to again", async () => {
    const { hermetic } = freshFleet();
    await drain(hermetic.agents.create({ name: "atlas" }));
    await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));
    expect(await listening(hermetic)).toEqual([]);
    await drain(hermetic.agents.create({ name: "atlas" }));
    expect(await listening(hermetic)).toEqual(["atlas"]);
  });

  test("a name released by another laptop: the predecessor's state is purged before the listen, not after", async () => {
    const { backend } = freshFleet();
    const instanceListening = new MemoryInstanceListeningStore();
    const incarnations = new MemoryIncarnationStore();
    const here = testHermetic({ backend, config: FIXTURE_CONFIG, instanceListening, incarnations });
    const there = testHermetic({ backend, config: FIXTURE_CONFIG });

    await drain(here.agents.create({ name: "atlas" }));
    // This laptop records the first incarnation; the other one destroys it,
    // so this laptop never runs the release's purge.
    await here.agents.list();
    await drain(there.agents.destroy({ name: "atlas", yes: true }));

    await drain(here.agents.create({ name: "atlas" }));
    expect(await listening(here)).toEqual(["atlas"]);
    // Without the create recording the new incarnation, this read would see a
    // later `created_at` than the recorded one and purge the new listen.
    await here.agents.list();
    expect(await listening(here)).toEqual(["atlas"]);
  });

  test("a create rolled back to nothing leaves no listen behind", async () => {
    const { backend, hermetic } = freshFleet();
    backend.compute.runInstance = async () => {
      throw new HermeticError("INTERNAL", "RunInstances failed", {});
    };
    await expect(
      drain(hermetic.agents.create({ name: "atlas", rollback_on_failure: true })),
    ).rejects.toThrow(HermeticError);
    expect(await backend.store.agents.get("atlas")).toBeNull();
    expect(await listening(hermetic)).toEqual([]);
  });

  test("a failed create without rollback keeps its row, and its listen", async () => {
    const { backend, hermetic } = freshFleet();
    backend.compute.runInstance = async () => {
      throw new HermeticError("INTERNAL", "RunInstances failed", {});
    };
    await expect(drain(hermetic.agents.create({ name: "atlas" }))).rejects.toThrow(HermeticError);
    // The row stays for `rerun` or a re-run create to finish.
    expect(await backend.store.agents.get("atlas")).not.toBeNull();
    expect(await listening(hermetic)).toEqual(["atlas"]);
  });

  test("a listen that fails at the claim is tried once more at handoff", async () => {
    const { backend } = freshFleet();
    const instanceListening = new FlakyListening(1);
    const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG, instanceListening });
    const events = await drain(hermetic.agents.create({ name: "atlas" }));
    expect(instanceListening.calls).toBe(2);
    expect(await listening(hermetic)).toEqual(["atlas"]);
    // The claim's failure was said once; the retry that worked says nothing.
    expect(events.filter((e) => e.message.includes("could not listen")).length).toBe(1);
    expect(events.at(-1)?.phase).toBe("done");
  });

  test("a listen that never works costs the create two warnings, not the agent", async () => {
    const { backend } = freshFleet();
    const instanceListening = new FlakyListening(Infinity);
    const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG, instanceListening });
    const events = await drain(hermetic.agents.create({ name: "atlas" }));
    expect(instanceListening.calls).toBe(2);
    expect(await listening(hermetic)).toEqual([]);
    const warned = events.filter((e) => e.message.includes("could not listen"));
    expect(warned.map((e) => e.level)).toEqual(["warn", "warn"]);
    expect(events.at(-1)?.phase).toBe("done");
    expect((await backend.store.agents.get("atlas"))!.resources.instance_id).toBeString();
  });

  test("fixture mode listens to a new agent too, in its own SQLite", async () => {
    const home = mkdtempSync(join(tmpdir(), "hermetic-create-listen-"));
    homes.push(home);
    const h = await openHermetic({ fixture: true, home });
    expect((await h.chat.listening({})).instances).not.toContain("newbie");
    // The listen lands at the claim, so the create need not run to the end.
    const controller = new AbortController();
    await expect(
      (async () => {
        for await (const e of h.agents.create({ name: "newbie" }, { signal: controller.signal })) {
          if (e.phase === "secrets") controller.abort();
        }
      })(),
    ).rejects.toThrow(HermeticError);
    expect((await h.chat.listening({})).instances).toContain("newbie");

    // Persisted: a second process on the same home sees it.
    const again = await openHermetic({ fixture: true, home });
    expect((await again.chat.listening({})).instances).toContain("newbie");
  });
});
