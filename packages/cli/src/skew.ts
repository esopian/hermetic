/**
 * How the CLI says a fleet and this build disagree (§6.6).
 *
 * Pure, and separate from `context.ts`, for the reason every other rendering
 * rule in this head is: the decision of *what* to print is worth asserting
 * without spawning a process, and the decision of *when* is one line in the
 * caller.
 *
 * Two forms, one vocabulary. The block appears when the skew can change what
 * the command is about to do; the line appears when it cannot but the numbers
 * below it should still be read in context. Neither form enumerates what is
 * affected — core owns that sentence (`SKEW_MESSAGE`) precisely so that it is
 * the same sentence in the portal, and so that no future contract bump has to
 * come with new copy in two heads.
 */
import type { Skew } from "@hermetic/core/schema";

/**
 * The environment variable that quiets the warning for scripts.
 *
 * It cannot quiet `blocked`: that severity means writes will be refused, and a
 * script whose author silenced the notice is exactly the caller most likely to
 * be about to attempt one.
 */
export const SKEW_QUIET_ENV = "HERMETIC_NO_SKEW_WARNING";

/**
 * Commands the skew can change the *behaviour* of, rather than merely the
 * interpretation of. Each one either writes to the fleet or creates something
 * that inherits from it — a create on a fleet without shared settings, a rerun
 * that applies a config rendered by a different build — and each one is
 * therefore worth six lines of interruption.
 *
 * Reads are absent on purpose. `agent ps` is accurate on a skewed fleet; it is
 * the numbers *in* its output that need the context, and the one-line form
 * plus the inline marks give them that.
 */
const LOUD_COMMANDS: readonly string[] = [
  "agent create",
  "agent set",
  "agent rerun",
  "agent recreate",
  "agent destroy",
  "agent stop",
  "agent start",
  "upgrade",
  "settings set",
  "providers create",
  "providers update",
  "providers rm",
  "secrets push",
  "secrets delete",
  "apply",
  "policy",
  "teardown",
];

/** Whether `command` gets the block rather than the line. */
export function skewIsLoud(command: string): boolean {
  return LOUD_COMMANDS.some((c) => command === c || command.startsWith(`${c} `));
}

/** Draw `lines` inside a box whose width is the longest of them. */
function box(title: string, lines: readonly string[]): string[] {
  const width = Math.max(title.length + 2, ...lines.map((l) => l.length)) + 2;
  const pad = (l: string) => `│ ${l.padEnd(width - 2)} │`;
  // Every line is `width + 2` cells wide: two for the frame, `width` inside.
  const head = `┌ ${title} ${"─".repeat(Math.max(0, width - title.length - 2))}┐`;
  return [head, ...lines.map(pad), `└${"─".repeat(width)}┘`];
}

/**
 * What to print for this skew, as lines without trailing newlines. Empty when
 * there is nothing to say — a clean fleet prints nothing at all, and neither
 * does a quieted one unless the severity is `blocked`.
 */
export function skewReport(
  skew: Skew | null | undefined,
  opts: { loud: boolean; quiet?: boolean; fleet?: string | null },
): string[] {
  // Absent, not empty: a status read served by a build that does not compute a
  // skew says nothing about one, and inventing a warning (or an all-clear) from
  // its silence would be inventing the versions it did not send either.
  if (!skew || skew.severity === "none") return [];
  if (opts.quiet && skew.severity !== "blocked") return [];

  const where = opts.fleet ? `fleet ${opts.fleet} · ${skew.headline}` : skew.headline;

  // `pending` never interrupts: the agents it is about are already fixing
  // themselves, so the loudest it gets is a line an operator can ignore.
  if (skew.severity === "pending") return [`◦ ${where} — ${skew.message}`];

  if (!opts.loud && skew.severity === "degraded") return [`⚠ skew: ${where} — ${skew.message}`];

  const body = [where, `${skew.message}.`, ""];
  if (skew.fix) {
    body.push(`fix   ${skew.fix}`);
  } else {
    // `blocked`. The fix is not a hermetic command, so saying `fix` here would
    // point at something the operator cannot run.
    body.push("this build cannot update this fleet — upgrade hermetic on this laptop");
  }
  if (skew.severity !== "blocked") body.push(`hide  ${SKEW_QUIET_ENV}=1`);
  return box(skew.severity === "blocked" ? "VERSION SKEW · BLOCKED" : "VERSION SKEW", body);
}
