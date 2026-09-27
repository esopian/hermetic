/**
 * Derivations for the staged bootstrap (§4.2): the ordered stage checklist the
 * agent drawer renders, and the enable/pending matrix behind "rerun failed
 * stages". Pure, so `test/bootstrap.test.ts` exercises them without a DOM.
 *
 * Shapes come out of the route type (`AgentView`), never `@hermetic/core` —
 * the UI is not allowed to import core (§3.1, `tests/boundaries.test.ts`).
 */
import type { AgentView } from "../api/index.ts";

export type BootstrapState = NonNullable<AgentView["bootstrap"]>;
export type StageState = BootstrapState["stages"][number];
export type StageStatus = StageState["status"];

/** The `NN-` ordinal that orders the stage files but means nothing to a reader. */
const ORDINAL = /^\d+-/;

/**
 * `02-data-volume` → `Data volume`. The ordinal already shows in the row order
 * and the raw id is still available as the row's `title`, so the label drops it.
 */
export function stageLabel(id: string): string {
  const words = id.replace(ORDINAL, "").replace(/-/g, " ").trim();
  if (words === "") return id;
  return words[0]!.toUpperCase() + words.slice(1);
}

export function stageColor(status: StageStatus): string {
  if (status === "ok") return "var(--ok)";
  if (status === "failed") return "var(--bad)";
  if (status === "running") return "var(--acc)";
  return "var(--line2)";
}

/**
 * The status *word* next to a stage. `line2` is a hairline colour: legible as a
 * 14px block, not as 11px text, so a pending row says it in `fg3` instead.
 */
export function stageTextColor(status: StageStatus): string {
  return status === "pending" ? "var(--fg3)" : stageColor(status);
}

/**
 * The box has an instance and has not written a single stage to its row. Every
 * report hermeticd makes is a DynamoDB write, so this covers the whole class of
 * boots that die before they can speak — a denied IAM policy, a network that
 * never came up, an instance that failed to run the unit at all — and it used
 * to render as nothing whatsoever: the drawer showed a finished create, an
 * empty checklist and an empty activity log (§6.3).
 *
 * A `destroyed` or stopped agent is not silent, it is simply not running, so
 * only a row that should be booting counts.
 */
export function awaitingFirstReport(agent: AgentView): boolean {
  if (agent.bootstrap !== null && agent.bootstrap !== undefined) return false;
  if (agent.instance_id === null || agent.instance_id === undefined) return false;
  return agent.display_status === "creating" || agent.display_status === "bootstrapping";
}

/** How long the box has been silent, from the row's `created_at`. */
export function silentForMs(agent: AgentView, now: number): number | null {
  const from = Date.parse(agent.created_at);
  if (Number.isNaN(from)) return null;
  return Math.max(0, now - from);
}

export function stages(agent: AgentView): StageState[] {
  return agent.bootstrap?.stages ?? [];
}

/** The stage hermeticd says is running right now, when it is still bootstrapping. */
export function currentStage(agent: AgentView): string | null {
  if (agent.display_status !== "bootstrapping") return null;
  return agent.bootstrap?.current ?? null;
}

/**
 * The same stage, spelled the way the drawer checklist spells it, so a chip and
 * the list under it never name the same stage two different ways.
 */
export function currentStageLabel(agent: AgentView): string | null {
  const id = currentStage(agent);
  return id === null ? null : stageLabel(id);
}

export function failedStages(agent: AgentView): StageState[] {
  return stages(agent).filter((s) => s.status === "failed");
}

export function stageDurationMs(s: StageState): number | null {
  if (!s.started_at || !s.ended_at) return null;
  const from = Date.parse(s.started_at);
  const to = Date.parse(s.ended_at);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return null;
  return to - from;
}

/** Stages run in seconds, so `fmtDuration`'s minute floor would read `0m`. */
export function fmtStageDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** The mono meta line: attempt when it is not the first, then the duration. */
export function stageMeta(s: StageState): string {
  const parts: string[] = [];
  if (s.attempt > 1) parts.push(`attempt ${String(s.attempt)}`);
  const ms = stageDurationMs(s);
  if (ms !== null) parts.push(fmtStageDuration(ms));
  return parts.join(" · ");
}

/**
 * A finished boot is a fact, not a thing to read: collapse it. Anything else —
 * mid-boot, a failure, a stage still pending — opens with the list showing.
 */
export function bootstrapCollapsedByDefault(agent: AgentView): boolean {
  const list = stages(agent);
  if (list.length === 0) return true;
  return agent.display_status === "ready" && list.every((s) => s.status === "ok");
}

/** One line summarising the checklist, shown next to the collapse toggle. */
export function bootstrapSummary(agent: AgentView): string {
  const list = stages(agent);
  if (list.length === 0) return "no stages recorded";
  const ok = list.filter((s) => s.status === "ok").length;
  const failed = failedStages(agent).length;
  const tail = failed > 0 ? ` · ${String(failed)} failed` : "";
  return `${String(ok)}/${String(list.length)} ok${tail}`;
}

export interface RerunState {
  kind: "enabled" | "pending" | "disabled";
  label: string;
  /** The button's `title`: what it will do, or why it will not do it. */
  reason: string;
}

/**
 * `rerun` is only offered on a row core would accept it for: `error`, with a
 * stage that actually failed. Between the POST and hermeticd picking the
 * command up off its own row the button is a pending state, not a second click:
 * the box has not acked while `command.id !== bootstrap.last_command_id`.
 *
 * `issuedId` is the command id this tab just got back from the route, which
 * covers the gap before the fleet stream carries the written row back.
 */
export function rerunState(agent: AgentView, issuedId: string | null = null): RerunState {
  const command = agent.command ?? null;
  const acked = agent.bootstrap?.last_command_id ?? null;
  const unacked = command !== null && command.id !== acked;
  const issuedUnacked = issuedId !== null && issuedId !== acked;
  if (unacked || issuedUnacked) {
    return {
      kind: "pending",
      label: "Rerun queued…",
      reason: "waiting for hermeticd to pick the rerun up off the agent's row",
    };
  }
  if (agent.status !== "error") {
    return {
      kind: "disabled",
      label: "Rerun failed stages",
      reason: `rerun needs an agent in error; this one is ${agent.status}`,
    };
  }
  if (agent.bootstrap === null || agent.bootstrap === undefined) {
    return {
      kind: "disabled",
      label: "Rerun failed stages",
      reason: "no staged bootstrap has been recorded for this agent",
    };
  }
  if (failedStages(agent).length === 0) {
    return {
      kind: "disabled",
      label: "Rerun failed stages",
      reason: "no bootstrap stage has failed",
    };
  }
  return {
    kind: "enabled",
    label: "Rerun failed stages",
    reason: "re-runs the stages that are not ok, resuming from the first failure",
  };
}
