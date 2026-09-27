/**
 * The fleet page's lens: agents or volumes.
 *
 * Volumes used to be a top-level view (`#volumes`). It is now the second half
 * of the fleet page — the toolbar headline switches between `N AGENTS` and
 * `N VOLUMES` over the same filter — so its address moved under the fleet:
 * `#fleet/volumes`. The agents lens is the fleet's default and has no hash of
 * its own; an empty hash is the fleet on its agents.
 *
 * Pure and DOM-free, like `agent-nav.ts` and `settings-nav.ts`: `nav-state.tsx`
 * owns the state and the one hash writer, this module owns only the spelling.
 */

export type FleetLens = "agents" | "volumes";

/** Where the volumes lens lives. */
export const FLEET_VOLUMES_HASH = "#fleet/volumes";

/**
 * The address of the old Volumes view. Bookmarks and notification links still
 * carry it, so it keeps resolving — to the lens — and the hash is rewritten in
 * place (`replaceState`) rather than pushed, so back does not bounce through it.
 */
export const LEGACY_VOLUMES_HASH = "#volumes";

/**
 * The lens a hash asks for, or `null` when the hash belongs to another view.
 *
 * `null` for Settings and Chat is what lets the lens survive a detour: opening
 * Settings from the volumes lens writes `#settings/...`, and reading that as
 * "agents" would drop the operator on the other lens when they come back.
 * Everything else that is the fleet page — an empty hash, `#fleet`, an agent's
 * drawer — is the agents lens, because that is where the drawer's cards are.
 */
export function parseFleetLensHash(hash: string): FleetLens | null {
  if (hash === FLEET_VOLUMES_HASH || hash === LEGACY_VOLUMES_HASH) return "volumes";
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw === "settings" || raw.startsWith("settings/")) return null;
  if (raw === "chat" || raw.startsWith("chat/")) return null;
  return "agents";
}
