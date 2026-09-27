/**
 * The fixture backend's demo simulations: what a real box or a real Tailscale
 * would do to the state on its own, mimicked so `--fixture` shows it happening.
 *
 * Split out of `memory.ts` (AGENTS.md rule 5). Neither is a port: `simulateRerun`
 * is hermeticd's resident runner and `tailscaleReformat` is the control plane's
 * pretty-printer, and both act on a `MemoryBackend` handed to them.
 */
import { locateManagedBlocks, parseHujson } from "../fleet/hujson.ts";
import type { MemoryBackend } from "./memory.ts";

/**
 * One entry, in Tailscale's house style: `{ "a": 1, "b": 2 },` becomes an object
 * over several lines, tab-indented, colons padded into a column. Returns null
 * for anything that is not a one-line object entry — the fixture reformats what
 * hermetic writes, and nothing else.
 */
const ENTRY_RE = /^(?:("(?:[^"\\]|\\.)*")\s*:\s*)?(\{.*\})\s*,?$/;

function reformatEntry(line: string, indent: string): string | null {
  const match = ENTRY_RE.exec(line.trim());
  if (match === null) return null;
  let value: unknown;
  try {
    value = parseHujson(match[2]!);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const members = Object.entries(value as Record<string, unknown>);
  if (members.length === 0) return null;
  const width = Math.max(...members.map(([key]) => JSON.stringify(key).length + 1));
  return [
    `${indent}${match[1] === undefined ? "{" : `${match[1]}: {`}`,
    ...members.map(
      ([key, v]) => `${indent}\t${`${JSON.stringify(key)}:`.padEnd(width, " ")} ${JSON.stringify(v)},`,
    ),
    `${indent}},`,
  ].join("\n");
}

/**
 * What Tailscale does to a policy on save, mimicked.
 *
 * The real API does not store the bytes it was posted: it stores what it
 * parsed, re-printed in its own style — one member per line, a tab of indent,
 * values aligned into a column. So hermetic's blocks never read back the way it
 * wrote them, and a `policy.status` that compared text called every fleet
 * `drifted` for ever, proposing the same rule again on every plan. The fixture
 * reformats the same way so that a `--fixture plan policy` → `apply` → `policy`
 * round trip is the regression test: it reads `current` only while drift is
 * decided by meaning (§5.2).
 *
 * Deliberately not a general pretty-printer — it touches only the lines between
 * hermetic's markers, and only those it can parse. Anything else is left alone,
 * because the fixture's other promise is that the operator's bytes come back.
 */
export function tailscaleReformat(text: string): string {
  let out = text;
  let ranges: { start: number; end: number }[];
  try {
    ranges = locateManagedBlocks(out);
  } catch {
    return out;
  }
  // Back to front, so an earlier block's rewrite cannot move a later block's
  // offsets out from under it.
  for (const range of [...ranges].sort((a, b) => b.start - a.start)) {
    const lines = out.slice(range.start, range.end).split("\n");
    if (lines.length < 2) continue;
    const indent = /^[ \t]*/.exec(lines[0]!)![0];
    const rewritten = lines.map((line, i) =>
      i === 0 || i === lines.length - 1 ? line : (reformatEntry(line, indent) ?? line),
    );
    out = out.slice(0, range.start) + rewritten.join("\n") + out.slice(range.end);
  }
  return out;
}

/**
 * The fixture's stand-in for hermeticd's resident runner (§4.2), in the two
 * steps the real one takes — because the *resuming* state is the one the UI
 * has to render and would otherwise never see:
 *
 *  1. ack the command, `error → bootstrapping`, and put the stage that failed
 *     back into `running` on its next attempt;
 *  2. that stage and everything after it `ok`, and the agent `ready`.
 */
export function simulateRerun(b: MemoryBackend, name: string, commandId: string): void {
  b.later(b.rerunDelayMs, () => {
    const current = b.agents.get(name);
    if (!current || current.command?.id !== commandId) return;
    const at = b.now().toISOString();
    const resuming = current.bootstrap?.stages.find((stage) => stage.status !== "ok");
    b.agents.set(name, {
      ...current,
      status: "bootstrapping",
      version: current.version + 1,
      command: null,
      ...(current.bootstrap
        ? {
            bootstrap: {
              ...current.bootstrap,
              stages: current.bootstrap.stages.map((stage) =>
                stage.id === resuming?.id
                  ? {
                      ...stage,
                      status: "running" as const,
                      attempt: stage.attempt + 1,
                      started_at: at,
                      ended_at: null,
                      exit_code: null,
                      message: null,
                    }
                  : stage,
              ),
              current: resuming?.id ?? null,
              updated_at: at,
              last_command_id: commandId,
            },
          }
        : {}),
      updated_at: at,
    });
    b.events.push({
      name,
      timestamp: at,
      actor: `hermeticd/${name}`,
      action: "rerun",
      from_status: "error",
      to_status: "bootstrapping",
      detail: resuming ? `resuming at ${resuming.id}` : "re-running the bootstrap stages",
    });

    b.later(b.rerunDelayMs, () => {
      const mid = b.agents.get(name);
      if (mid?.status !== "bootstrapping") return;
      const done = b.now().toISOString();
      b.agents.set(name, {
        ...mid,
        status: "ready",
        version: mid.version + 1,
        ...(mid.bootstrap
          ? {
              bootstrap: {
                ...mid.bootstrap,
                stages: mid.bootstrap.stages.map((stage) =>
                  stage.status === "ok"
                    ? stage
                    : {
                        ...stage,
                        status: "ok" as const,
                        started_at: stage.started_at ?? done,
                        ended_at: done,
                        exit_code: 0,
                        message: null,
                      },
                ),
                current: null,
                updated_at: done,
              },
            }
          : {}),
        last_heartbeat: done,
        updated_at: done,
      });
      b.events.push({
        name,
        timestamp: done,
        actor: `hermeticd/${name}`,
        action: "ready",
        from_status: "bootstrapping",
        to_status: "ready",
        detail: "all bootstrap stages ok",
      });
    });
  });
}

/**
 * The fixture's stand-in for a box coming back from `agent reboot` (§6.5).
 *
 * A real reboot needs nothing from hermetic after `RebootInstances`: hermeticd
 * starts with the OS, finds every stage marker matching, and heartbeats. The
 * fixture has no box, so without this a rebooted agent's row stayed with the
 * `health`, `metrics` and `last_heartbeat` core cleared for ever — the demo
 * never showed a reboot finishing. The readings taken before the reboot are
 * what the "box" reports on its way back; a row an operation moved on in the
 * meantime (a stop, a destroy, another reboot's clear already answered) is left
 * alone.
 */
export function simulateReboot(b: MemoryBackend, instanceId: string): void {
  const name = b.instances.get(instanceId)?.agent ?? null;
  if (name === null) return;
  const before = b.agents.get(name);
  if (!before) return;
  const { health, metrics } = before;
  b.later(b.rerunDelayMs * 2, () => {
    const current = b.agents.get(name);
    if (!current || current.last_heartbeat !== null) return;
    if (!["ready", "degraded", "bootstrapping", "error"].includes(current.status)) return;
    const at = b.now().toISOString();
    b.agents.set(name, {
      ...current,
      version: current.version + 1,
      health: structuredClone(health ?? null),
      metrics: structuredClone(metrics ?? null),
      last_heartbeat: at,
      updated_at: at,
    });
  });
}
