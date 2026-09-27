/**
 * The words the agent drawer says about an agent before anyone reads a table:
 * the Overview's one-sentence status, and the sub-line under each entry of the
 * drawer's left nav. Pure, so every state a row can be in is testable without
 * rendering the drawer (`packages/ui/test/agent-summary.test.ts`).
 *
 * The sentence is a reading of the row, never a guess: it names the stage that
 * failed, the checks that are failing and how long the box has been silent,
 * and it points at the section that holds the fix rather than offering the fix
 * itself — every action lives on Lifecycle.
 */
import type { AgentView } from "../../api/index.ts";
import { currentStageLabel, failedStages, stageLabel } from "../../logic/bootstrap.ts";
import type { RerunState } from "../../logic/bootstrap.ts";
import { destroyedSummary, heartbeatAge, isBehind } from "../../logic/format.ts";

/** The four checks hermeticd reports on its heartbeat (§6.4), in the order the drawer lists them. */
export const HEALTH_KEYS = ["hermes", "tailscale", "disk", "dashboard"] as const;
export type HealthKey = (typeof HEALTH_KEYS)[number];

/** Which reported checks are failing. An unreported one is not failing — it was never asked. */
export function failingChecks(agent: AgentView): HealthKey[] {
  const health = agent.health;
  if (!health) return [];
  return HEALTH_KEYS.filter((k) => health[k] === false);
}

/** `a`, `a and b`, `a, b and c`. */
function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export interface StatusSentence {
  /** The bold half: what the agent is doing, or what is wrong. */
  lead: string;
  /** The rest: the evidence, and where the next move is. */
  detail: string;
  /** How loud the Overview says it. */
  tone: "ok" | "warn" | "bad" | "muted" | "busy";
}

/**
 * One sentence per `display_status`. The detail names the drawer section that
 * holds the fix rather than a button: Overview is a reading, Lifecycle is where
 * things happen.
 */
export function statusSentence(agent: AgentView): StatusSentence {
  const beat = heartbeatAge(agent);
  switch (agent.display_status) {
    case "ready": {
      const failing = failingChecks(agent);
      if (failing.length > 0) {
        return {
          lead: "Ready, with a failing check.",
          detail: `${list(failing)} ${failing.length === 1 ? "is" : "are"} not reporting healthy. Last heartbeat ${beat}.`,
          tone: "warn",
        };
      }
      return {
        lead: "Ready and serving chats.",
        detail: agent.health
          ? `Every reported health check passes. Last heartbeat ${beat}.`
          : `Waiting on the first health report. Last heartbeat ${beat}.`,
        tone: "ok",
      };
    }
    case "degraded": {
      const failing = failingChecks(agent);
      return {
        lead: "Running, but degraded.",
        detail:
          failing.length > 0
            ? `${list(failing)} ${failing.length === 1 ? "is" : "are"} failing. Probe it below, or reboot it from Lifecycle.`
            : "hermeticd reports the agent degraded. Probe it below to see which layer answers.",
        tone: "warn",
      };
    }
    case "error": {
      const failed = failedStages(agent);
      const first = failed[0];
      if (first) {
        return {
          lead: `Bootstrap failed at ${stageLabel(first.id)}.`,
          detail: `${first.message ? `${first.message}. ` : ""}Fix the cause, then rerun the failed stages from Lifecycle; the stage's log tail is under Logs → Activity.`,
          tone: "bad",
        };
      }
      return {
        lead: "In error.",
        detail:
          "The agent stopped in a failed state. Its history under Logs → Activity says which step broke.",
        tone: "bad",
      };
    }
    case "unreachable":
      return {
        lead: "Not answering.",
        detail: `The last heartbeat was ${beat}. Probe it below to see which layer is down; a reboot from Lifecycle is the usual fix.`,
        tone: "bad",
      };
    case "bootstrapping": {
      const stage = currentStageLabel(agent);
      return {
        lead: stage ? `Booting: ${stage}.` : "Booting.",
        detail: "hermeticd is running the bootstrap stages. The checklist below moves on its own.",
        tone: "busy",
      };
    }
    case "creating":
      return {
        lead: "Creating the instance.",
        detail: "The first heartbeat arrives once the box has booted, usually within a few minutes.",
        tone: "busy",
      };
    case "stopping":
      return { lead: "Stopping.", detail: "The instance is shutting down.", tone: "busy" };
    case "stopped":
      return {
        lead: "Stopped.",
        detail: "Compute is off and only its disks bill. Start it from Lifecycle.",
        tone: "muted",
      };
    case "destroying":
      return { lead: "Being destroyed.", detail: "The instance is being terminated.", tone: "busy" };
    case "destroyed":
      return {
        lead: "Destroyed.",
        detail: `${destroyedSummary(agent.volume_id)}. The record stays, so its history can still be read.`,
        tone: "muted",
      };
    default:
      return { lead: `${agent.display_status}.`, detail: "", tone: "muted" };
  }
}

/** Overview's sub-line: the one-word health reading. */
export function overviewSubline(agent: AgentView): string {
  if (agent.display_status === "destroyed") return "record only";
  if (agent.display_status === "stopped") return "stopped";
  if (agent.display_status === "error") return "bootstrap failed";
  if (agent.display_status === "unreachable") return "not answering";
  if (!agent.health) return "no report yet";
  const failing = failingChecks(agent);
  return failing.length === 0 ? "all checks ok" : `${list(failing)} failing`;
}

/**
 * Lifecycle's sub-line: the one action worth pressing now, if any. The same
 * readings the cards use, so the nav never recommends something the page has
 * disabled.
 */
export function lifecycleSubline(
  agent: AgentView,
  latest: string | null,
  rerun: RerunState,
): { text: string; accent: boolean } {
  if (agent.display_status === "destroyed") return { text: "destroyed", accent: false };
  if (rerun.kind === "enabled") return { text: "rerun available", accent: true };
  if (rerun.kind === "pending") return { text: "rerun queued", accent: false };
  if (agent.display_status === "unreachable") return { text: "reboot suggested", accent: true };
  if (isBehind(agent, latest)) return { text: "upgrade available", accent: true };
  if (agent.display_status === "stopped") return { text: "stopped · start", accent: false };
  return { text: "no action needed", accent: false };
}
