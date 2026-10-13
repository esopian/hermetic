/**
 * The fleet page's lens: agents, volumes, or the destroyed-agent audit.
 *
 * Volumes used to be a top-level view (`#volumes`). It is now the second half
 * of the fleet page — the toolbar headline switches between `N AGENTS` and
 * `N VOLUMES` over the same filter — so its address moved under the fleet:
 * `#fleet/volumes`. The agents lens is the fleet's default and is addressed as
 * plain `#fleet`. An empty hash is not the fleet: Chat is the page the app
 * opens on (`isLandingHash`), so the fleet always names itself.
 *
 * Pure and DOM-free, like `agent-nav.ts` and `settings-nav.ts`: `nav-state.tsx`
 * owns the state and the one hash writer, this module owns only the spelling.
 */

export type FleetLens = "agents" | "volumes" | "destroyed";

/** Where the fleet's agents lens lives — the fleet page with nothing else named. */
export const FLEET_HASH = "#fleet";

/**
 * A hash that names no page at all: a cold start, a bare `#`, or `#/`. The app
 * opens on Chat, so `nav-state.tsx` respells any of these as `#chat` in place.
 */
export function isLandingHash(hash: string): boolean {
  return hash === "" || hash === "#" || hash === "#/";
}

/** Where the volumes lens lives. */
export const FLEET_VOLUMES_HASH = "#fleet/volumes";

/**
 * Where the destroyed-agent audit lives (§6.7). A destroy deletes the row, so
 * a destroyed agent is not on the agents lens at all; its tombstone is here.
 */
export const FLEET_DESTROYED_HASH = "#fleet/destroyed";

/** The hash a lens is addressed by; the agents lens is the fleet's own `#fleet`. */
export function fleetLensHash(lens: FleetLens): string {
  if (lens === "volumes") return FLEET_VOLUMES_HASH;
  if (lens === "destroyed") return FLEET_DESTROYED_HASH;
  return FLEET_HASH;
}

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
 * "agents" would drop the operator on the other lens when they come back. An
 * empty hash is Chat's (`isLandingHash`), so it is `null` too.
 * Everything else that is the fleet page — `#fleet`, an agent's drawer — is the
 * agents lens, because that is where the drawer's cards are.
 */
export function parseFleetLensHash(hash: string): FleetLens | null {
  if (hash === FLEET_VOLUMES_HASH || hash === LEGACY_VOLUMES_HASH) return "volumes";
  if (hash === FLEET_DESTROYED_HASH) return "destroyed";
  if (isLandingHash(hash)) return null;
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw === "settings" || raw.startsWith("settings/")) return null;
  if (raw === "chat" || raw.startsWith("chat/")) return null;
  return "agents";
}
