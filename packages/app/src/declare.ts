/**
 * The request declarations, recorded by the head itself as it is built.
 *
 * `tests/parity.test.ts` used to compare a hand-written table against core's
 * `REQUEST_SCHEMAS` — but both sides were written by the same hand, so the
 * assertion could not fail: swapping a handler's schema left parity green. The
 * schema a request is validated with is now recorded here *by the handler*,
 * and it is the same binding the handler hands to `parseInput`. Change one and
 * the parity assertion changes with it.
 */
import type { PublicMethod } from "@hermetic/core";
import type { ZodType } from "zod";

/**
 * The contract, minus HTTP.
 *
 * A request over the desktop bridge is named by the core method it wraps, so
 * there is no verb and no path to record — only "this handler validates
 * `agents.create` against *that* schema object".
 */
export interface RpcDeclaration {
  /** Dotted path of the core method this handler implements, and its request name. */
  path: PublicMethod;
  /** The schema the handler actually validates the request against. */
  schema: ZodType;
}

const declaredRpc = new Map<PublicMethod, RpcDeclaration>();

/**
 * Records a handler's method and hands back the schema it must validate with.
 * Use the return value in the handler, so the recorded object and the
 * validated object cannot differ.
 */
export function declareRpc<T extends ZodType>(path: PublicMethod, schema: T): T {
  const prior = declaredRpc.get(path);
  if (prior) {
    // The handler modules are imported once per process, but a test that
    // re-imports one through a different specifier would declare again. The
    // same declaration arriving twice is fine; a *different* schema for the
    // same method is a second implementation, which the parity test could
    // never see once the map had swallowed the first.
    if (prior.schema === schema) return schema;
    throw new Error(`Handler for ${path} declared twice with a different schema`);
  }
  declaredRpc.set(path, { path, schema });
  return schema;
}

/** Every handler declared so far, in declaration order. */
export function rpcDeclarations(): RpcDeclaration[] {
  return [...declaredRpc.values()];
}

const machineryRpc = new Set<string>();

/**
 * Request names that wrap no core method: the head's own machinery — the fleet
 * switch, the wizard's pre-init helpers, the op registry, the streams, the
 * fixture staging surface, and the native requests the desktop head answers
 * itself.
 *
 * Registered by the module that implements them rather than listed here: a
 * name in a table with no handler behind it is a lie the parity test cannot
 * catch, and `MACHINERY_RPC` ∪ `PUBLIC_METHODS` is asserted to be exactly what
 * `dispatch` knows.
 *
 * Generic in the name so the *literal* comes back out. Every handler table
 * keys its machinery entries off one of these (`[APP_INFO]: info`), and a
 * computed key of type `string` would give the table an index signature
 * instead of that one key — which erases every sibling's return type and
 * hands `rpc/schema.ts` an answer for names nobody implemented.
 */
export function declareMachineryRpc<N extends string>(name: N): N {
  machineryRpc.add(name);
  return name;
}

/** Every machinery name declared so far, in declaration order. */
export function machineryRpcNames(): string[] {
  return [...machineryRpc];
}
