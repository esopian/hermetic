/** The board card's single diagnosis slot, derived only from fleet facts. */
import type { AgentView, ProfileView, VolumeView } from "../api/index.ts";
import { failedStages, stages, stageLabel } from "./bootstrap.ts";
import { fmtDuration, healthTitle, isBehind, pct, rootFree, worstDisk } from "./format.ts";
import { profileById } from "./provider-logic.ts";
import { volumeLine, volumeOf } from "./volume-logic.ts";
import type { AgentTab } from "../nav/agent-nav.ts";

export interface CardDiagnosis {
  kind: "urgent" | "stage" | "maintenance" | "volume" | "watch";
  tone: "bad" | "warn" | "acc" | "ok" | "muted";
  message: string;
  evidence?: string;
  link?: string;
  tab?: AgentTab;
  logSource?: "console";
  stages?: ReturnType<typeof stages>;
  more: number;
  /** A tag repeating this diagnosis adds no information. */
  suppress?: "pending" | "update" | "behind" | "pin";
}

export function diagnose(
  a: AgentView,
  ctx: { latest: string | null; volumes: readonly VolumeView[]; profiles: readonly ProfileView[] },
): CardDiagnosis | null {
  const items: CardDiagnosis[] = [];
  const add = (item: Omit<CardDiagnosis, "more">) => items.push({ ...item, more: 0 });
  const disk = worstDisk(a.metrics);
  const root = a.metrics?.root_disk_pct;
  const free = rootFree(a.metrics, a.root_gib);
  const rootWorst = typeof root === "number" && root >= (a.metrics?.disk_pct ?? 0);
  const diskEvidence =
    disk !== null && disk > 85
      ? `${rootWorst ? "root" : "data"} ${pct(disk)}${rootWorst && free ? ` · ${free.text} free` : ""}`
      : undefined;
  const failures = failedStages(a);
  if (a.display_status === "error" && failures.length) {
    const failed = failures[0]!;
    add({
      kind: "urgent",
      tone: "bad",
      message: failed.message || `${stageLabel(failed.id)} failed.`,
      evidence: `stage ${failed.id}${failed.exit_code == null ? "" : ` · exit ${failed.exit_code}`}`,
      link: "Inspect failure",
      tab: "overview",
    });
  }
  if (a.display_status === "unreachable") {
    add({
      kind: "urgent",
      tone: "bad",
      message:
        a.heartbeat_age_ms === null
          ? "No heartbeat reported yet."
          : `No heartbeat for ${fmtDuration(a.heartbeat_age_ms)}.`,
      evidence: diskEvidence ? `last reported: ${diskEvidence}` : "Last reported numbers may be stale.",
      link: "Open console",
      tab: "logs",
      logSource: "console",
    });
  }
  if (a.display_status === "degraded") {
    const high = [a.metrics?.cpu_pct, a.metrics?.mem_pct, disk].some(
      (v) => typeof v === "number" && v > 85,
    );
    add({
      kind: "urgent",
      tone: "warn",
      message: healthTitle(a),
      evidence: high
        ? [
            a.metrics?.cpu_pct != null && a.metrics.cpu_pct > 85
              ? `CPU ${pct(a.metrics.cpu_pct)}`
              : null,
            a.metrics?.mem_pct != null && a.metrics.mem_pct > 85
              ? `memory ${pct(a.metrics.mem_pct)}`
              : null,
            diskEvidence,
          ]
            .filter(Boolean)
            .join(" · ")
        : undefined,
      link: "Open logs",
      tab: "logs",
    });
  }
  if (a.display_status === "creating" || a.display_status === "bootstrapping") {
    add({ kind: "stage", tone: "acc", message: "Bootstrap progress", stages: stages(a) });
  }
  if (a.display_status === "stopped") {
    if (a.pending) {
      add({
        kind: "maintenance",
        tone: "acc",
        message: `Saved: ${a.provider} → ${a.pending.provider} · ${a.pending.model}`,
        evidence: "Applies after start and apply, or on rebuild",
        suppress: "pending",
      });
    } else if (a.volume_id) {
      add({
        kind: "volume",
        tone: "muted",
        message: `Memory kept · ${a.volume_id} · ${a.volume_gib} GiB`,
      });
    }
  } else if (a.pending) {
    add({
      kind: "maintenance",
      tone: "acc",
      message: `Saved: ${a.provider} → ${a.pending.provider} · ${a.pending.model}`,
      link: "Apply…",
      tab: "config",
      suppress: "pending",
    });
  }
  if (a.update_available && !a.pending) {
    const profile = profileById(ctx.profiles, a.profile_id ?? "");
    add({
      kind: "maintenance",
      tone: "acc",
      message: `${profile?.name ?? "Provider"} profile changed · r${a.profile_revision ?? "?"} → r${profile?.revision ?? "?"}`,
      link: "Update…",
      tab: "config",
      suppress: "update",
    });
  }
  if (a.display_status !== "stopped") {
    const line = volumeLine(a, volumeOf(a, ctx.volumes));
    if (line)
      add({
        kind: "volume",
        tone: line.state === "detached" ? "warn" : line.state === "attached" ? "ok" : "muted",
        message: `Data volume · ${line.label}${line.state ? ` · ${line.state}` : ""}`,
      });
  }
  if (a.running_hermes_version && a.running_hermes_version !== a.hermes_version) {
    add({
      kind: "maintenance",
      tone: "acc",
      message: `Running ${a.running_hermes_version} · pinned ${a.hermes_version}`,
      link: "Rebuild options",
      tab: "lifecycle",
      suppress: "pin",
    });
  }
  if (isBehind(a, ctx.latest)) {
    add({
      kind: "maintenance",
      tone: "warn",
      message: `Hermes ${a.hermes_version} · fleet on ${ctx.latest}`,
      link: "Upgrade options",
      tab: "lifecycle",
      suppress: "behind",
    });
  }
  if (a.display_status !== "stopped") {
    const values = [
      { label: "CPU", value: a.metrics?.cpu_pct },
      { label: "Memory", value: a.metrics?.mem_pct },
      {
        label:
          root !== null && root !== undefined && root >= (a.metrics?.disk_pct ?? 0)
            ? "Root disk"
            : "Data disk",
        value: disk,
      },
    ]
      .filter((v) => typeof v.value === "number" && v.value >= 70)
      .sort((x, y) => (y.value ?? 0) - (x.value ?? 0));
    if (values.length) {
      const v = values[0]!;
      add({
        kind: "watch",
        tone: "warn",
        message: `${v.label} ${pct(v.value)}${v.label === "Root disk" && free ? ` · ${free.text} free` : ""}`,
      });
    }
  }
  if (!items.length) return null;
  return { ...items[0]!, more: items.length - 1 };
}
