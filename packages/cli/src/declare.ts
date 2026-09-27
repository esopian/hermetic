/**
 * The command declarations, recorded by the command tree itself as it is built.
 *
 * `tests/parity.test.ts` used to compare a hand-written table against core's
 * `CLI_REQUEST_SCHEMAS` — but both sides were written by the same hand, so the
 * assertion could not fail. The schema a command validates with is now recorded
 * here *by the command*, and it is the same binding the action passes to
 * `validate()`: swap it and the parity assertion fails, because there is no
 * second copy to agree with.
 */
import type { PublicMethod } from "@hermetic/core";
import type { ZodType } from "zod";

export interface CliCommand {
  /** Dotted path of the core method this command wraps. */
  path: PublicMethod;
  /** Space-separated Commander path, e.g. `agent create`. */
  command: string;
  /** The schema the command's action validates its parsed options against. */
  schema: ZodType;
}

const declared = new Map<PublicMethod, CliCommand>();

/**
 * Records a command and hands back the schema it must validate with. Call it
 * where the command is registered and use the return value in the action, so
 * the recorded object and the validated object cannot differ.
 */
export function declare<T extends ZodType>(path: PublicMethod, command: string, schema: T): T {
  const prior = declared.get(path);
  if (prior) {
    // The command tree is built more than once per process (every test that
    // constructs a program), so the same declaration arriving again is fine.
    // A *different* one is a second command for the same method, which the
    // parity test could never see once the map had swallowed the first.
    if (prior.command === command && prior.schema === schema) return schema;
    throw new Error(
      `CLI command for ${path} declared twice: first as "${prior.command}", ` +
        `then as "${command}"` +
        (prior.schema === schema ? "" : " with a different schema"),
    );
  }
  declared.set(path, { path, command, schema });
  return schema;
}

/** Every command declared so far, in declaration order. */
export function declarations(): CliCommand[] {
  return [...declared.values()];
}
