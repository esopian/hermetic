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
 * so a link written then still lands where it did. `terminal` (issue #18) sits
 * between Desktop and Logs: the two ways onto the box itself, side by side.
 * `files` (attachments plan §8.6) follows them: what is on the box, and the
 * requests waiting on the operator.
 */
export const AGENT_TABS = [
  "overview",
  "chat",
  "desktop",
  "terminal",
  "files",
  "logs",
  "config",
  "lifecycle",
] as const;

export type AgentTab = (typeof AGENT_TABS)[number];

/** What the nav calls each section. */
export const AGENT_TAB_LABELS: Record<AgentTab, string> = {
  overview: "Overview",
  chat: "Chat",
  desktop: "Desktop",
  terminal: "Terminal",
  files: "Files",
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
 * A terminal session id as the app mints it: core's `TerminalSessionId`
 * (`schema/terminal.ts`), copied because the page cannot import Zod. Neither
 * `/` nor `:` is admitted, so the id sits in the hash as one segment with no
 * escaping, and anything else in that segment is not a session at all.
 */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Where an agent hash points: the agent, its section, and for Terminal, maybe a session. */
export interface AgentRoute {
  name: string;
  tab: AgentTab;
  /**
   * The session a `#agent/<name>/terminal/<session_id>` link names — what a
   * terminal notification's `Open session` writes. Present only on the
   * Terminal section, and only when the segment is a well-formed id; absent
   * otherwise, so every other route keeps its two-field shape.
   */
  session?: string;
}

/**
 * The agent a hash asks for, or `null` when the hash is not an agent at all.
 *
 * An unknown section resolves to `overview` rather than to `null`, for the
 * reason `parseSettingsHash` gives: a stale bookmark should open the thing it
 * names, on its landing section, rather than bounce the operator back to the
 * fleet. A malformed session segment is dropped for the same reason: the link
 * still lands on the agent's Terminal section, just not on a session.
 */
export function parseAgentHash(hash: string): AgentRoute | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw.startsWith("agent/")) return null;
  const [name, tab, session] = raw.slice("agent/".length).split("/");
  if (!name) return null;
  const route: AgentRoute = {
    name: decodeURIComponent(name),
    tab: tab && isTab(tab) ? tab : DEFAULT_AGENT_TAB,
  };
  if (route.tab === "terminal" && session && SESSION_ID_RE.test(session)) route.session = session;
  return route;
}

/**
 * The hash for an agent. `overview` is spelled `#agent/<name>` and not
 * `#agent/<name>/overview`, so the drawer an operator opens by clicking a card
 * has one URL rather than two. A session is spelled only on the Terminal
 * section, and only when it is a well-formed id, so the writer can never
 * produce a hash its own parser would read differently.
 */
export function agentHash(
  name: string,
  tab: AgentTab = DEFAULT_AGENT_TAB,
  session: string | null = null,
): string {
  const base = `#agent/${encodeURIComponent(name)}`;
  if (tab === DEFAULT_AGENT_TAB) return base;
  if (tab === "terminal" && session !== null && SESSION_ID_RE.test(session))
    return `${base}/terminal/${session}`;
  return `${base}/${tab}`;
}
