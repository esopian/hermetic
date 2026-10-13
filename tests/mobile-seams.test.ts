/**
 * The mobile seams: what the laptop's bridge (`packages/core/src/mobile/`) and
 * the phone (`mobile/`) must agree on, asserted from both ends at once.
 *
 * The phone is its own toolchain (Expo, Metro) and cannot import core, so it
 * keeps copies: the wire constants (`mobile/src/protocol/constants.ts`, a mirror
 * of `packages/core/src/mobile/protocol.ts`) and the chat markdown renderer
 * (`mobile/src/client/markdown.ts`, a copy of the desktop's
 * `packages/ui/src/chat/chat-markdown.ts`). A comment saying "change the two
 * together" is not a check; this file is. It sits at the root because no package
 * may import core and the phone together.
 *
 * Four checks:
 *
 *   (a) every export of the two protocol files, name for name and value for
 *       value, and both still pure (nothing a phone or a bun test cannot load);
 *   (b) the markdown copy, byte for byte;
 *   (c) the frame `type` literals the bridge's Zod unions accept and emit equal
 *       the name lists in the constants, at runtime and in the types;
 *   (d) the `rpc` allowlist is a subset of the public surface and keeps every
 *       mutating, streaming and `mobile.*` method off the phone.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as coreProtocol from "../packages/core/src/mobile/protocol.ts";
import { MobileClientFrame, MobileServerFrame } from "../packages/core/src/schema/mobile.ts";
import { PUBLIC_METHODS } from "../packages/core/src/surface.ts";
import { FLEET_ID_ALPHABET } from "../packages/core/src/schema/common.ts";
import { FLEET_ID_RE } from "../mobile/src/client/pairing.ts";
import * as phoneProtocol from "../mobile/src/protocol/constants.ts";
import type {
  ClientFrame as PhoneClientFrame,
  ServerFrame as PhoneServerFrame,
} from "../mobile/src/protocol/types.ts";

const ROOT = join(import.meta.dir, "..");
const CORE_PROTOCOL = "packages/core/src/mobile/protocol.ts";
const PHONE_PROTOCOL = "mobile/src/protocol/constants.ts";
const PHONE_MARKDOWN = "mobile/src/client/markdown.ts";
const UI_MARKDOWN = "packages/ui/src/chat/chat-markdown.ts";

/** Specifiers neither protocol file may import: the phone cannot load them, or must not need to. */
const IMPURE = [/^node:/, /^bun(:|$)/, /^zod(\/|$)/, /^react-native(\/|$)/, /^expo(-|\/|$)/];

function importsOf(rel: string): string[] {
  const source = readFileSync(join(ROOT, rel), "utf8");
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  return transpiler.scanImports(source).map((entry) => entry.path);
}

/** The literal a `z.object({ type: z.literal(...) })` option is discriminated on. */
function typeLiteral(option: unknown): string {
  const shape = (option as { shape: { type: { value: unknown } } }).shape;
  const value = shape.type.value;
  if (typeof value !== "string") throw new Error("frame option without a string `type` literal");
  return value;
}

/* ── compile-time agreement ──────────────────────────────────────────────── */

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function assertType<T extends true>(_proof: T): void {}

// The phone's frame unions name exactly the frame types the bridge's schemas do,
// and exactly the ones the shared name lists declare.
// `MobileClientFrame`/`MobileServerFrame` name both the schema and its inferred type.
assertType<Equal<PhoneClientFrame["type"], MobileClientFrame["type"]>>(true);
assertType<Equal<PhoneServerFrame["type"], MobileServerFrame["type"]>>(true);
assertType<Equal<PhoneClientFrame["type"], coreProtocol.MobileClientFrameType>>(true);
assertType<Equal<PhoneServerFrame["type"], coreProtocol.MobileServerFrameType>>(true);

describe("mobile protocol constants: the phone's copy matches core's", () => {
  test("the same export names", () => {
    expect(Object.keys(phoneProtocol).sort()).toEqual(Object.keys(coreProtocol).sort());
  });

  test("every export deep-equals its twin, frozenness included", () => {
    const core = coreProtocol as Record<string, unknown>;
    const phone = phoneProtocol as Record<string, unknown>;
    for (const name of Object.keys(core)) {
      expect({ name, value: phone[name] }).toEqual({ name, value: core[name] });
      expect({ name, frozen: Object.isFrozen(phone[name]) }).toEqual({
        name,
        frozen: Object.isFrozen(core[name]),
      });
    }
  });

  test("both files are pure: no node, bun, zod, react-native or expo import", () => {
    for (const rel of [CORE_PROTOCOL, PHONE_PROTOCOL]) {
      const bad = importsOf(rel).filter((spec) => IMPURE.some((re) => re.test(spec)));
      expect({ file: rel, impure: bad }).toEqual({ file: rel, impure: [] });
    }
  });

  test("the purity scan does catch an impure import", () => {
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    const specs = transpiler
      .scanImports(
        'import { z } from "zod";\nimport { x } from "node:fs";\nimport "react-native";\nimport "expo-router";\nimport "bun:sqlite";',
      )
      .map((entry) => entry.path);
    expect(specs.filter((spec) => IMPURE.some((re) => re.test(spec)))).toHaveLength(5);
  });
});

describe("the phone's chat markdown renderer", () => {
  test("is a byte-identical copy of the desktop's", () => {
    const phone = readFileSync(join(ROOT, PHONE_MARKDOWN));
    const ui = readFileSync(join(ROOT, UI_MARKDOWN));
    expect(phone.length).toBeGreaterThan(0);
    expect(Buffer.compare(phone, ui)).toBe(0);
  });
});

describe("ws frame types: the bridge's schemas against the name lists", () => {
  test("client frames the bridge accepts are exactly MOBILE_CLIENT_FRAMES", () => {
    const accepted = MobileClientFrame.options.map(typeLiteral);
    expect(new Set(accepted).size).toBe(accepted.length);
    expect([...accepted].sort()).toEqual([...coreProtocol.MOBILE_CLIENT_FRAMES].sort());
    expect([...accepted].sort()).toEqual([...phoneProtocol.MOBILE_CLIENT_FRAMES].sort());
  });

  test("server frames the bridge emits are exactly MOBILE_SERVER_FRAMES", () => {
    // `res` is two options (ok and error) under one type name.
    const emitted = [...new Set(MobileServerFrame.options.map(typeLiteral))];
    expect(emitted.sort()).toEqual([...coreProtocol.MOBILE_SERVER_FRAMES].sort());
    expect(emitted.sort()).toEqual([...phoneProtocol.MOBILE_SERVER_FRAMES].sort());
  });
});

describe("the phone's rpc allowlist", () => {
  const allowed: readonly string[] = coreProtocol.MOBILE_ALLOWED_METHODS;
  const surface = new Set<string>(PUBLIC_METHODS);

  test("is a subset of PUBLIC_METHODS, without repeats", () => {
    expect(allowed.filter((m) => !surface.has(m))).toEqual([]);
    expect(new Set(allowed).size).toBe(allowed.length);
  });

  test("never reaches a streaming chat call, a mobile method or a mutating fleet method", () => {
    const refused = allowed.filter(
      (m) =>
        m === "chat.send" ||
        m === "chat.observe" ||
        m === "apply" ||
        m === "init" ||
        m === "teardown" ||
        m.startsWith("teardown.") ||
        m.startsWith("mobile.") ||
        m.startsWith("plan.") ||
        m.startsWith("secrets.") ||
        // Provider profiles: `providers.*` on the surface (§9), `profiles.*` in older notes.
        m.startsWith("providers.") ||
        m.startsWith("profiles."),
    );
    expect(refused).toEqual([]);
    // Of `agents.*`, only reads.
    const reads = new Set(["agents.list", "agents.get", "agents.history", "agents.destroyed"]);
    expect(allowed.filter((m) => m.startsWith("agents.") && !reads.has(m))).toEqual([]);
  });

  test("the methods it refuses do exist on the surface (the check is not vacuous)", () => {
    for (const m of ["chat.send", "chat.observe", "mobile.devices", "mobile.revoke", "agents.create"]) {
      expect({ m, public: surface.has(m) }).toEqual({ m, public: true });
    }
    expect([...surface].some((m) => m.startsWith("plan."))).toBe(true);
    expect([...surface].some((m) => m.startsWith("secrets."))).toBe(true);
    expect([...surface].some((m) => m.startsWith("providers."))).toBe(true);
  });
});

describe("the phone's fleet-id rule", () => {
  test("FLEET_ID_RE is core's alphabet, eight characters, nothing else", () => {
    expect(FLEET_ID_RE.source).toBe(`^[${FLEET_ID_ALPHABET}]{8}$`);
    expect(FLEET_ID_RE.flags).toBe("");
  });
});
