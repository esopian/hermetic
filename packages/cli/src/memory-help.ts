/**
 * The `--memory` choices with a one-line resource summary each, for the help of
 * `agent create` and `agent set`. Every figure comes from `memoryResourceFacts`
 * (the catalogue the create drawer and Settings draw from), so the CLI restates
 * no number of its own.
 */
import {
  MEMORY_NONE_SPEC,
  MEMORY_PROVIDERS,
  MEMORY_PROVIDER_IDS,
  MEMORY_PROVIDER_NONE,
  MEMORY_RESOURCE_ESTIMATE_NOTE,
  memoryResourceFacts,
} from "@hermetic/core/shared";
import type { MemoryResourceFactKey } from "@hermetic/core/shared";

/** `0 (in Hermes)` → `in Hermes`; `1` → `1 service`; `3 (db, api, worker)` → `3 services`. */
function servicesText(value: string): string {
  const m = /^(\d+)(?: \((.*)\))?$/.exec(value);
  if (m === null) return value;
  const n = Number(m[1]);
  if (n === 0) return m[2] ?? "no service";
  return `${String(n)} ${n === 1 ? "service" : "services"}`;
}

function summaryOf(choice: (typeof MEMORY_PROVIDER_IDS)[number] | typeof MEMORY_PROVIDER_NONE): string {
  if (choice === MEMORY_PROVIDER_NONE)
    return `${MEMORY_NONE_SPEC.summary.replace(/\.$/, "")}; no added RAM, disk or services`;
  const f = new Map<MemoryResourceFactKey, string>(
    memoryResourceFacts(choice).map((x) => [x.key, x.value]),
  );
  const get = (k: MemoryResourceFactKey): string => f.get(k) ?? "";
  const ram = MEMORY_PROVIDERS[choice].min_mem_gib > 0 ? `RAM ${get("ram_floor")}` : "any size";
  const parts = [
    ram,
    `+${get("added_ram")}`,
    `disk ${get("disk")}`,
    servicesText(get("services")),
    `calls: ${get("model_calls")}`,
  ];
  return parts.join(", ");
}

/** The help-text block: a heading, one aligned line per choice, and the estimates note. */
export function memoryHelpText(): string {
  const choices = [MEMORY_PROVIDER_NONE, ...MEMORY_PROVIDER_IDS] as const;
  const width = Math.max(...choices.map((c) => c.length));
  const lines = choices.map((c) => `  ${c.padEnd(width)}  ${summaryOf(c)}`);
  return (
    "\n--memory choices (the store always stays on the box):\n" +
    `${lines.join("\n")}\n` +
    `${MEMORY_RESOURCE_ESTIMATE_NOTE}\n`
  );
}
