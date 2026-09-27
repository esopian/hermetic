import { describe, expect, test } from "bun:test";
import {
  FIXTURE_CONFIG,
  MemoryBackend,
  PUBLIC_METHODS,
  STREAMING_METHODS,
  createHermetic,
  seedFixtureFleet,
} from "@hermetic/core";

const hermetic = createHermetic({
  backend: seedFixtureFleet(new MemoryBackend()),
  config: FIXTURE_CONFIG,
});

function resolve(root: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc === null || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[key];
  }, root);
}

describe("parity", () => {
  test("PUBLIC_METHODS has no duplicates", () => {
    expect(new Set(PUBLIC_METHODS).size).toBe(PUBLIC_METHODS.length);
  });

  for (const path of PUBLIC_METHODS) {
    test(`core exposes ${path}`, () => {
      expect(typeof resolve(hermetic, path)).toBe("function");
    });
  }

  test("every streaming method is a public method", () => {
    for (const path of STREAMING_METHODS) {
      expect(PUBLIC_METHODS).toContain(path);
    }
  });

  test("nothing public hides outside PUBLIC_METHODS", () => {
    /**
     * Data, not commands. The surface this test guards is the set of *callable*
     * methods — the things that need a CLI command and an RPC handler each — and
     * both of these are plain values read off an already-open instance:
     * `constants` is derived state the heads render against, and `target` is
     * which fleet this instance resolved to talk to (§4.6), read by the run log
     * so a row can say what it was against. Neither reaches AWS or disk, and
     * neither is something a head could invoke.
     */
    const skip = new Set(["constants", "target"]);
    const found: string[] = [];
    for (const [key, value] of Object.entries(hermetic)) {
      if (skip.has(key)) continue;
      if (typeof value === "function") found.push(key);
      else if (value && typeof value === "object") {
        for (const sub of Object.keys(value)) found.push(`${key}.${sub}`);
      }
    }
    expect(found.sort()).toEqual([...PUBLIC_METHODS].sort());
  });
});

/**
 * §11.4: every public core method has exactly one Commander command and exactly
 * one RPC handler on the desktop bridge, and both validate with the same Zod
 * schema core parses with.
 *
 * The three sources compared here are genuinely independent:
 *
 * 1. `PUBLIC_METHODS` and `REQUEST_SCHEMAS` / `CLI_REQUEST_SCHEMAS`, from core.
 * 2. `CLI_COMMANDS` and `RPC_DECLARATIONS`, which the heads *record as they
 *    build themselves* — the schema in each entry is the object the command's
 *    action passes to `validate()` and the handler passes to `parseInput`, not
 *    a copy of it.
 * 3. `SURFACE`, below: §9's command table, transcribed into the test. This is
 *    what catches a head that renames a command while keeping its own tables
 *    self-consistent.
 *
 * There is no route column any more: the app head answers RPC
 * requests whose *name is the dotted method path*, so the third leg has no
 * verb and no URL of its own to disagree about — only which schema each
 * handler validates with, and whether a handler exists at all.
 *
 * The `mismatches` helpers are pure so the suite can prove they still fail:
 * see "the parity check can fail" at the bottom.
 */
import { CLI_COMMANDS, undeclaredMethods } from "@hermetic/cli";
import { HANDLER_NAMES, MACHINERY_RPC, RPC_DECLARATIONS, unhandledMethods } from "@hermetic/app";
import { AgentRefInput, CLI_REQUEST_SCHEMAS, REQUEST_SCHEMAS } from "@hermetic/core";
import type { PublicMethod } from "@hermetic/core";

/** §9's command surface, written out here so the heads cannot define it. */
const SURFACE: Record<PublicMethod, string> = {
  "chat.open": "chat open",
  "chat.compact": "chat compact",
  "chat.archive": "chat archive",
  "chat.respond": "chat respond",
  "bots.capabilities": "bots capabilities",
  "bots.get": "bots get",
  "bots.create": "bots create",
  "bots.update": "bots update",
  "bots.delete": "bots delete",
  "rooms.list": "rooms list",
  "rooms.get": "rooms get",
  "rooms.create": "rooms create",
  "rooms.rename": "rooms rename",
  "rooms.delete": "rooms delete",
  "rooms.history": "rooms history",
  "rooms.send": "rooms send",
  "rooms.control": "rooms control",
  "rooms.respond": "rooms respond",
  "routines.list": "routines list",
  "routines.create": "routines create",
  "routines.update": "routines update",
  "routines.delete": "routines delete",
  "routines.run": "routines run",
  "routines.history": "routines history",

  init: "init",
  "config.show": "config show",
  // §4.8: the account's fleets. `fleet use` writes one value — which fleet this
  // laptop means by default — rather than acting on a fleet, and the command
  // name says so.
  "fleets.list": "fleet ls",
  "fleets.use": "fleet use",
  "fleets.alias": "fleet alias",
  "directory.status": "directory status",
  "runs.list": "runs",
  "teardowns.list": "teardowns",
  // §9: the operator's local inbox. The two writes are verbs on the
  // inbox rather than edits of a row, because "mark everything read" and
  // "silence this source" address the inbox, not one notification.
  "notifications.list": "inbox",
  "notifications.ack": "inbox ack",
  "notifications.mute": "inbox mute",
  // §9: this laptop's create presets, one `prefs` row (§4.6).
  "presets.get": "presets show",
  "presets.set": "presets set",
  // §9: the chat surface. `bots ls` is its own noun because the
  // roster is what an operator reads before choosing a conversation, while
  // `chat ls` already means one bot's sessions. Every request but the roster
  // read names an `<instance>/<bot>` pair, because that is the unit (§9.2).
  "chat.listening": "chat listening",
  "chat.listen": "chat listen",
  "chat.swarms": "bots ls",
  "chat.sessions": "chat ls",
  "chat.history": "chat log",
  // The turn itself. It answers with the turn rather than an `op_id`, because a
  // turn is not an op and is never registered as one (§9.2).
  "chat.send": "chat",
  "chat.abort": "chat abort",
  // §9.2: a watch on one conversation, which exists with no
  // outgoing message at all. It writes nothing — that is the property the whole
  // design rests on, and `chat watch` is named for it.
  "chat.observe": "chat watch",
  "artifacts.push": "artifacts push",
  teardown: "teardown",
  doctor: "doctor",
  "foundation.status": "foundation status",
  "foundation.update": "foundation update",
  "agents.create": "agent create",
  "agents.list": "agent ps",
  "agents.get": "agent status",
  "agents.set": "agent set",
  "agents.stop": "agent stop",
  "agents.start": "agent start",
  "agents.reboot": "agent reboot",
  "agents.recreate": "agent recreate",
  "agents.destroy": "agent destroy",
  "agents.history": "agent history",
  "agents.rerun": "agent rerun",
  "agents.probe": "agent probe",
  // §7.4: the Serve URL and session token Hermes Desktop attaches with.
  "agents.desktop": "agent desktop",
  "volumes.list": "volume ls",
  "volumes.get": "volume status",
  "volumes.delete": "volume delete",
  "secrets.push": "secrets push",
  "secrets.verify": "secrets verify",
  // §8.2's fleet-level shared slots. `secrets ls` reads the collection the two
  // per-agent commands above hang off, and `secrets rm` names one slug — never
  // a value, in either direction.
  "secrets.list": "secrets ls",
  "secrets.delete": "secrets rm",
  // §4.6's shared settings: one read and one write. The write is partial by
  // design — `settings set` names the keys it changes, because no head can
  // honestly claim to know every fleet-wide setting.
  "settings.get": "settings show",
  "settings.set": "settings set",
  // §8.3's provider profiles: a collection of their own, because several of
  // them exist per provider and each has an id of its own. `providers models`
  // is a request rather than a read, because it may carry the draft key an
  // operator is typing.
  "providers.list": "providers ls",
  "providers.create": "providers create",
  "providers.update": "providers update",
  "providers.delete": "providers rm",
  "providers.models": "providers models",
  ssh: "ssh",
  logs: "logs",
  upgrade: "upgrade",
  "plan.destroy": "plan destroy",
  "plan.recreate": "plan recreate",
  "plan.teardown": "plan teardown",
  "plan.foundation": "plan foundation",
  // §4.7's tailnet policy: one read and one dry run, neither of which writes.
  // The write is `apply`, the one command every plan is applied through.
  "policy.status": "policy",
  "plan.policy": "plan policy",
  // §5's fleet network mode: the same two shapes, for the same reason. The move
  // itself is `apply` of a `network` plan, not a method of its own.
  "network.status": "network status",
  "plan.network": "plan network",
  "plan.rollout": "plan rollout",
  apply: "apply",
};

interface Recorded {
  path: string;
  schema: unknown;
}

/** Entries whose recorded schema is not the object core exports. */
function schemaMismatches(entries: readonly Recorded[], table: Record<string, unknown>): string[] {
  return entries.filter((e) => e.schema !== table[e.path]).map((e) => e.path);
}

describe("parity: core ↔ CLI ↔ RPC", () => {
  test("core's schema tables cover exactly the public methods", () => {
    expect(Object.keys(REQUEST_SCHEMAS).sort()).toEqual([...PUBLIC_METHODS].sort());
    expect(Object.keys(CLI_REQUEST_SCHEMAS).sort()).toEqual([...PUBLIC_METHODS].sort());
  });

  test("the §9 surface in this test covers exactly the public methods", () => {
    expect(Object.keys(SURFACE).sort()).toEqual([...PUBLIC_METHODS].sort());
  });

  test("every public method declared a command and a handler", () => {
    expect(undeclaredMethods()).toEqual([]);
    expect(unhandledMethods()).toEqual([]);
  });

  for (const path of PUBLIC_METHODS) {
    test(`${path}: one command, at the §9 name`, () => {
      const found = CLI_COMMANDS.filter((c) => c.path === path);
      expect(found.length).toBe(1);
      expect(found[0]?.command).toBe(SURFACE[path]);
    });
  }

  test("every command validates with core's own schema", () => {
    // Object identity against what the action actually passes to `validate()`.
    expect(schemaMismatches(CLI_COMMANDS, CLI_REQUEST_SCHEMAS)).toEqual([]);
  });

  test("the two tables differ only where the heads genuinely differ", () => {
    // `artifacts push` may name a local file from the CLI and never from the
    // app; anything else diverging is a bug in one of the heads.
    const different = [...PUBLIC_METHODS].filter(
      (p) => (REQUEST_SCHEMAS[p] as unknown) !== (CLI_REQUEST_SCHEMAS[p] as unknown),
    );
    expect(different).toEqual(["artifacts.push"]);
  });

  test("no command wraps anything that is not a public method", () => {
    for (const command of CLI_COMMANDS) expect(PUBLIC_METHODS).toContain(command.path);
    expect(CLI_COMMANDS.length).toBe(PUBLIC_METHODS.length);
  });

  test("command names are unique", () => {
    expect(new Set(CLI_COMMANDS.map((c) => c.command)).size).toBe(CLI_COMMANDS.length);
  });
});

/**
 * A parity test that cannot fail is worse than no parity test, because it reads
 * as coverage. These feed the same assertions a deliberately wrong surface and
 * assert they reject it.
 */
describe("the parity check can fail", () => {
  test("a command validating with the wrong schema is caught", () => {
    const mutated = CLI_COMMANDS.map((c) =>
      c.path === "agents.create" ? { ...c, schema: AgentRefInput } : c,
    );
    expect(schemaMismatches(mutated, CLI_REQUEST_SCHEMAS)).toEqual(["agents.create"]);
  });

  test("a renamed command is caught", () => {
    const mutated = CLI_COMMANDS.map((c) =>
      c.path === "agents.list" ? { ...c, command: "agent list" } : c,
    );
    const wrong = mutated.filter((c) => c.command !== SURFACE[c.path]).map((c) => c.path);
    expect(wrong).toEqual(["agents.list"]);
  });

  test("two commands with their names swapped are caught", () => {
    // The mutation the verifier used against the route table, now against the
    // column that survived it: stop and start trade command names.
    const mutated = CLI_COMMANDS.map((c) => {
      if (c.path === "agents.stop") return { ...c, command: SURFACE["agents.start"] };
      if (c.path === "agents.start") return { ...c, command: SURFACE["agents.stop"] };
      return c;
    });
    const wrong = mutated.filter((c) => c.command !== SURFACE[c.path]).map((c) => c.path);
    expect(wrong.sort()).toEqual(["agents.start", "agents.stop"]);
  });
});

/**
 * The third leg, in detail. A request name *is* the dotted method
 * path, so there is no table of names to compare against `SURFACE` — what
 * there is to check is that the handlers exist, that they validate with core's
 * own schema objects, and that nothing is reachable through `dispatch` that no
 * one declared.
 *
 * `RPC_DECLARATIONS` and `MACHINERY_RPC` are recorded by `declareRpc` and
 * `declareMachineryRpc` in the handler modules themselves, as the modules are
 * loaded; neither is written out by hand, so swapping a handler's schema
 * changes this assertion with it.
 *
 * `HANDLER_NAMES` is a third thing again — the keys of the dispatch table the
 * bridge actually calls. A handler that forgot to declare itself, or a
 * declaration with no handler behind it, shows up as a difference between the
 * two.
 */
describe("parity: core ↔ RPC handlers", () => {
  test("every public method declared a handler", () => {
    expect(unhandledMethods()).toEqual([]);
  });

  test("the handler table names exactly the public methods", () => {
    expect(RPC_DECLARATIONS.map((r) => r.path).sort()).toEqual([...PUBLIC_METHODS].sort());
  });

  test("one handler per public method, and nothing else declared", () => {
    for (const declaration of RPC_DECLARATIONS) expect(PUBLIC_METHODS).toContain(declaration.path);
    expect(RPC_DECLARATIONS.length).toBe(PUBLIC_METHODS.length);
  });

  test("every handler validates with core's own schema", () => {
    // Object identity against what the handler actually hands `parseInput`,
    // the same check the CLI commands get above.
    expect(schemaMismatches(RPC_DECLARATIONS, REQUEST_SCHEMAS)).toEqual([]);
  });

  test("dispatch knows exactly the public methods plus the machinery", () => {
    // The whole reachable surface of the app head: every name the bridge can
    // route is a declared core method or a declared machinery request, and
    // every declared name has a handler. Deleting a handler fails here.
    const expected = [...new Set([...PUBLIC_METHODS, ...MACHINERY_RPC])].sort();
    expect([...HANDLER_NAMES].sort()).toEqual(expected);
  });

  test("no machinery name collides with a public method", () => {
    const collisions = MACHINERY_RPC.filter((name) =>
      (PUBLIC_METHODS as readonly string[]).includes(name),
    );
    expect(collisions).toEqual([]);
  });

  test("a handler declared against the wrong schema is caught", () => {
    // `agents.destroy` reading `AgentRefInput` would drop `yes`, and
    // confirmation with it — the shape of the bug that used to slip through.
    const mutated = RPC_DECLARATIONS.map((r) =>
      r.path === "agents.destroy" ? { ...r, schema: AgentRefInput } : r,
    );
    expect(schemaMismatches(mutated, REQUEST_SCHEMAS)).toEqual(["agents.destroy"]);
  });
});
