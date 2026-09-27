/**
 * One `OpEvent` stream, three renderings (§3.2 rule 2): a spinner on a TTY, one
 * line per event when piped, NDJSON under `--json`. Everything except the JSON
 * goes to stderr so stdout stays a clean document.
 */
import { spinner } from "@clack/prompts";
import type { OpEvent } from "@hermetic/core";
import { err, isInteractive, out, type GlobalFlags } from "./io.ts";

export interface RenderOptions {
  flags: GlobalFlags;
  /** Shown while the first event is still pending, e.g. `agent create atlas`. */
  label: string;
}

function pct(progress: number): string {
  return `${String(Math.round(progress * 100)).padStart(3, " ")}%`;
}

function line(e: OpEvent): string {
  const level = e.level && e.level !== "info" ? `${e.level.toUpperCase()} ` : "";
  // A phase that has just *begun* reads differently from one that finished.
  const mark = e.kind === "start" ? "… " : "";
  return `${pct(e.progress)} ${e.phase.padEnd(12, " ")} ${level}${mark}${e.message}`;
}

/** Consumes the op to completion. Throws whatever core threw. */
export async function renderOp(
  events: AsyncIterable<OpEvent>,
  { flags, label }: RenderOptions,
): Promise<OpEvent[]> {
  const seen: OpEvent[] = [];

  if (flags.json) {
    for await (const e of events) {
      seen.push(e);
      await out(`${JSON.stringify(e)}\n`);
    }
    return seen;
  }

  if (!isInteractive()) {
    for await (const e of events) {
      seen.push(e);
      await err(`${line(e)}\n`);
    }
    return seen;
  }

  const s = spinner({ output: process.stderr });
  s.start(label);
  try {
    for await (const e of events) {
      seen.push(e);
      s.message(line(e));
    }
  } catch (e) {
    s.error(`${label} failed`);
    throw e;
  }
  s.stop(`${label} done`);
  return seen;
}
