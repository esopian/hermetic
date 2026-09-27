import { HermeticError } from "../errors.ts";

/** Wrap an unknown throw from a local (non-AWS) source in core's one error type. */
export function asHermeticErrorMessage(e: unknown, message: string): HermeticError {
  if (e instanceof HermeticError) return e;
  return new HermeticError("INTERNAL", `${message}: ${e instanceof Error ? e.message : String(e)}`);
}
