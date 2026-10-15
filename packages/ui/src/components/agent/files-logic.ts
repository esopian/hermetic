/**
 * The agent's Files tab, the bell's file-request rows and the fleet badge,
 * as pure functions (attachments plan §8.6): what a listing says in words.
 * DOM-free, so every label is testable without mounting anything.
 */
import type { FileEntryView, FileRequestView, FilesList } from "../../api/files.ts";

/** The slot states a request card can still act on: the bell and the badge count these. */
export function isOpenRequest(request: Pick<FileRequestView, "state">): boolean {
  return request.state === "open" || request.state === "receiving";
}

/** The requests still waiting on the operator, oldest first. */
export function openRequests(requests: readonly FileRequestView[]): FileRequestView[] {
  return requests
    .filter(isOpenRequest)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}

/** `412 KB`, `13.0 MB`, `1.4 GB`: one decimal from MB up, whole bytes and KB below. */
export function sizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** The tab's head line: `inbox 1.4 GB · disk 31% · retention 7d`. */
export function usageLine(usage: FilesList["usage"]): string {
  const disk = usage.disk_used_pct === undefined ? "—" : `${Math.round(usage.disk_used_pct)}%`;
  return `inbox ${sizeLabel(usage.inbox_bytes)} · disk ${disk} · retention ${usage.retention_days}d`;
}

/** `2h`, `12m`, `3d`: how long ago, at the coarsest unit that is not zero. */
export function ageLabel(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "—";
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

/** Who put an entry on the box: `evan@ · chat`, `evan@ · request`, or the agent's own name. */
export function originLabel(entry: FileEntryView, agent: string): string {
  if (entry.from.kind === "agent") return agent;
  const login = entry.from.login;
  const at = login.indexOf("@");
  const who = at < 0 ? login : login.slice(0, at + 1);
  return `${who} · ${entry.request_id ? "request" : "chat"}`;
}

/** `normal` or `secret`: what the box will do with the answer. */
export function requestClass(request: FileRequestView): "normal" | "secret" {
  return request.kind === "secret_text" || request.sensitivity === "secret" ? "secret" : "normal";
}

/**
 * A purpose cut to `max` characters for a one-line row. The model's words,
 * shown as text: the caller never parses them as markup.
 */
export function truncatePurpose(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** The fleet badge's and the drawer nav's words for `n` open requests. */
export function openRequestsLabel(n: number): string {
  return `${n} open file request${n === 1 ? "" : "s"}`;
}

export type FilesDirLabel = "in" | "out" | "secret";

export interface FilesRow {
  entry: FileEntryView;
  dir: FilesDirLabel;
  /** What the name column says: a secret by its SSM slot and key names, a file by its name. */
  label: string;
  /** The file's own name under a secret's slot label, when the two differ. */
  sub: string | null;
}

/** The one table under the requests: inbox, then outbox, then secrets, newest first in each. */
export function filesRows(list: Pick<FilesList, "inbox" | "outbox" | "secrets">): FilesRow[] {
  const newest = (a: FileEntryView, b: FileEntryView) =>
    Date.parse(b.created_at) - Date.parse(a.created_at);
  const files = (entries: readonly FileEntryView[], dir: "in" | "out"): FilesRow[] =>
    [...entries].sort(newest).map((entry) => ({ entry, dir, label: entry.name, sub: null }));
  const secrets = [...list.secrets].sort(newest).map((entry): FilesRow => {
    const keys = entry.keys && entry.keys.length > 0 ? ` · ${entry.keys.join(", ")}` : "";
    const label = entry.slot ? `${entry.slot}${keys}` : entry.name;
    return { entry, dir: "secret", label, sub: entry.slot ? entry.name : null };
  });
  return [...files(list.inbox, "in"), ...files(list.outbox, "out"), ...secrets];
}

/**
 * What the delete confirmation says before anything is deleted. A durable
 * secret's plan carries an `ssm` step, and the operator is told in words that
 * the slot goes with the box's copy.
 */
export function rmConsequence(entry: FileEntryView, hasSsmStep: boolean): string {
  if (entry.dir !== "secret") return `Deletes ${entry.name} from the box.`;
  if (hasSsmStep && entry.slot) {
    return `Deletes the box's copy and the SSM slot ${entry.slot}. The agent cannot get this secret back unless it asks again.`;
  }
  return "Deletes the box's copy. No SSM slot is recorded for this secret.";
}
