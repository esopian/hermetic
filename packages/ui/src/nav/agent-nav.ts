/**
 * The agent drawer's address.
 *
 * The drawer used to be pure state: an operator could not link to one, and a
 * reload dropped whatever they had open. It now rides in the hash next to the
 * views that already do (`#settings/<section>`, `#fleet/volumes`), and it carries
 * a second axis for the same reason Settings does — the drawer has sections of
 * its own, and `#agent/<name>/desktop` is the one that puts somebody straight
 * onto the agent's screen.
 *
 * Pure and DOM-free, exactly like `settings-nav.ts`: `App.tsx` owns the state
 * and the single hash writer, this module owns only the spelling, so both
 * directions of the round trip are testable without a browser.
 */

/**
 * The drawer's sections, in the order its left nav lists them. `overview` and
 * `desktop` are the two tabs the drawer had before the nav, spelled the same,
 * so a link written then still lands where it did.
 */
export const AGENT_TABS = ["overview", "chat", "desktop", "logs", "config", "lifecycle"] as const;

export type AgentTab = (typeof AGENT_TABS)[number];

/** What the nav calls each section. */
export const AGENT_TAB_LABELS: Record<AgentTab, string> = {
  overview: "Overview",
  chat: "Chat",
  desktop: "Desktop",
  logs: "Logs",
  config: "Config",
  lifecycle: "Lifecycle",
};

/** Where `#agent/<name>` with no section — and any section nobody recognises — lands. */
export const DEFAULT_AGENT_TAB: AgentTab = "overview";

function isTab(value: string): value is AgentTab {
  return (AGENT_TABS as readonly string[]).includes(value);
}

/**
 * The agent a hash asks for, or `null` when the hash is not an agent at all.
 *
 * An unknown section resolves to `overview` rather than to `null`, for the
 * reason `parseSettingsHash` gives: a stale bookmark should open the thing it
 * names, on its landing section, rather than bounce the operator back to the
 * fleet.
 */
export function parseAgentHash(hash: string): { name: string; tab: AgentTab } | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw.startsWith("agent/")) return null;
  const [name, tab] = raw.slice("agent/".length).split("/");
  if (!name) return null;
  return { name: decodeURIComponent(name), tab: tab && isTab(tab) ? tab : DEFAULT_AGENT_TAB };
}

/**
 * The hash for an agent. `overview` is spelled `#agent/<name>` and not
 * `#agent/<name>/overview`, so the drawer an operator opens by clicking a card
 * has one URL rather than two.
 */
export function agentHash(name: string, tab: AgentTab = DEFAULT_AGENT_TAB): string {
  const base = `#agent/${encodeURIComponent(name)}`;
  return tab === DEFAULT_AGENT_TAB ? base : `${base}/${tab}`;
}
