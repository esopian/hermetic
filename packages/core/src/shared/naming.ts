/**
 * The names an agent and its node go by (§6.1): the one true name shape and
 * its validator, the tailnet spelling a node asks for and every spelling it may
 * legitimately still wear, and the URLs the heads build from them (§7.3).
 *
 * Pure values only — no Zod, no `node:*`, nothing that opens a file or a
 * socket — because `shared/index.ts` re-exports from here into the browser and
 * the box. The Zod schemas that validate these shapes live in `schema/*`, which
 * imports this module, never the reverse (`packages/core/test/shared-browser-safe.test.ts`).
 */
import { HermeticError } from "../errors.ts";
import { DEFAULT_BROWSER_NAME, browserServePath } from "./browser.ts";

/** The reserved row key of the fleet itself, and therefore not a name an agent may take. */
export const FLEET_KEY = "_fleet";

/**
 * The one true agent-name shape (§6.1). The name threads through EC2 tags, SSM
 * paths, Tailscale hostnames, DynamoDB keys and S3 prefixes and must be valid in
 * all of them: lowercase alphanumerics and hyphens, no leading hyphen or
 * underscore, under 32 characters, and never the reserved `_fleet`.
 */
export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

/**
 * The ONLY place an agent name is validated (§6.1). Everywhere else assumes the
 * name is already valid. Throws `NAME_INVALID` with a human-readable reason the
 * heads render as-is.
 */
export function validateName(name: unknown): string {
  if (typeof name !== "string") {
    throw new HermeticError("NAME_INVALID", "agent name must be a string", { name });
  }
  if (name.length === 0) {
    throw new HermeticError("NAME_INVALID", "agent name must not be empty");
  }
  if (name === FLEET_KEY) {
    throw new HermeticError("NAME_INVALID", `"${FLEET_KEY}" is reserved`, { name });
  }
  if (name.startsWith("_") || name.startsWith("-")) {
    throw new HermeticError("NAME_INVALID", "agent name must start with a lowercase letter or digit", {
      name,
    });
  }
  if (name.length > 31) {
    throw new HermeticError("NAME_INVALID", "agent name must be under 32 characters", {
      name,
      length: name.length,
    });
  }
  if (!AGENT_NAME_RE.test(name)) {
    throw new HermeticError(
      "NAME_INVALID",
      "agent name must be lowercase alphanumerics and hyphens only",
      { name },
    );
  }
  return name;
}

export function isValidName(name: unknown): boolean {
  try {
    validateName(name);
    return true;
  } catch {
    return false;
  }
}

export function cloudName(fleetId: string | undefined | null, agent: string): string {
  return fleetId === undefined || fleetId === null || fleetId === "" ? agent : `${fleetId}-${agent}`;
}

/**
 * Every spelling this agent's node could legitimately be wearing *because of
 * when it was built*, newest first — the v4 name, the v3 `<fleet name>-<agent>`
 * one, and the pre-v3 bare name.
 *
 * A node's hostname is fixed at boot: it is what cloud-init wrote and what the
 * tailnet admitted the device under, and neither can be changed from a laptop.
 * So every naming change this repo has made leaves running boxes wearing the
 * older spelling until they are recreated, and something has to be able to tell
 * "built before the rule changed" apart from "a dead device holds the name I
 * asked for". This is that list: `agentHostnameMismatch` treats a node wearing
 * any of these as legacy, and anything else as a genuine collision.
 *
 * `fleetName` is optional because a pre-v3 fleet has none; omitted, the v3
 * spelling is simply not one of the shapes a node here could have.
 */
export function legacyCloudNames(
  fleetName: string | undefined | null,
  agent: string,
): readonly string[] {
  const v3 = cloudName(fleetName, agent);
  return v3 === agent ? [agent] : [v3, agent];
}

/**
 * The one place a hostname for an agent is spelled, and the reason it is not
 * simply `${name}.${tailnet}`.
 *
 * Tailscale hands a joining node the name it asked for only if nothing else in
 * the tailnet holds it. `agent recreate` terminates the old box and deletes its
 * device — unless the fleet's OAuth client predates `devices:core` and carries
 * only `auth_keys`, in which case the corpse stays in the tailnet, the
 * replacement is admitted as `<name>-2`, `<name>-4`, and MagicDNS keeps
 * pointing `<name>` at the corpse. Serve answers on the node's real name and
 * the dashboard's rebinding guard admits only that Host, so a URL built from
 * the canonical spelling reaches nothing at all.
 *
 * `tailscale_dns_name` is what the node reported about itself, so it wins
 * whenever it is there; the canonical form is the fallback for a row whose
 * first heartbeat has not landed (or was written by an older hermeticd).
 *
 * `cloudName` is the name this agent wears in the tailnet — `<fleet id>-<agent>`
 * since v4 (`cloudName` in `fleet.ts`, computed by the caller because
 * `fleet.ts` imports this module and the cycle would not resolve). Omitted, the
 * fallback is the bare agent name, which is what a pre-v3 fleet's nodes are
 * actually called.
 */
export function agentHostname(
  agent: { name: string; tailscale_dns_name?: string | null },
  tailnet: string,
  cloudName?: string | null,
): string {
  return agent.tailscale_dns_name ?? `${cloudName ?? agent.name}.${tailnet}`;
}

/**
 * Where the agent's own Hermes dashboard lives. `/` is the Serve route
 * `render.ts` publishes for `hermes dashboard` on 9119, so the hostname alone
 * is the whole URL.
 */
export function agentDashboardUrl(
  agent: { name: string; tailscale_dns_name?: string | null },
  tailnet: string,
  cloudName?: string | null,
): string {
  return `https://${agentHostname(agent, tailnet, cloudName)}/`;
}

/**
 * Where the agent's desktop lives: the noVNC session onto the X display its
 * browser draws on, published by `tailscale serve` at `/vnc` (§7.3).
 *
 * The trailing slash is load-bearing and not cosmetic. `/vnc` without it makes
 * the client's own relative links — and any relative redirect — resolve at the
 * *site root*, which is nginx and then the Hermes SPA, so the operator lands on
 * the dashboard wondering where the desktop went.
 *
 * `browser` names which browser identity's desktop this is. It is defaulted, so
 * every call site today reads the same; a second identity is published one
 * level down (`/vnc/<name>/`), which is `browserServePath` and not a rule this
 * function invents.
 *
 * The UI imports this through `@hermetic/core/shared` (its `format.ts` wraps
 * it), so there is one copy; `packages/core/test/shared-browser-safe.test.ts`
 * keeps this module free of anything a browser cannot load.
 */
export function agentDesktopUrl(
  agent: { name: string; tailscale_dns_name?: string | null },
  tailnet: string,
  cloudName?: string | null,
  browser: string = DEFAULT_BROWSER_NAME,
): string {
  return `https://${agentHostname(agent, tailnet, cloudName)}${browserServePath(browser)}/`;
}

/**
 * The same desktop, addressed the long way: noVNC's own client page with the
 * websocket path spelled out.
 *
 * Belt and braces, and both halves are needed. `agentDesktopUrl` relies on an
 * `index.html` rendered into the noVNC web root, so an agent that has not been
 * re-applied since that file existed answers it with a directory listing;
 * this URL works on that agent and on a current one. And the `path=` query is
 * what makes the client dial the right socket at all: noVNC builds its
 * websocket URL from the *site root* (`app/ui.js`, `UI.connect`), so without it
 * a client served under `/vnc` dials `wss://<host>/websockify`, which is the
 * dashboard's route and never upgrades.
 */
export function agentDesktopClientUrl(
  agent: { name: string; tailscale_dns_name?: string | null },
  tailnet: string,
  cloudName?: string | null,
  browser: string = DEFAULT_BROWSER_NAME,
): string {
  const host = agentHostname(agent, tailnet, cloudName);
  const path = browserServePath(browser);
  // Root-relative for the page, root-*less* for the query: noVNC concatenates
  // `path` onto the origin itself, so a leading slash would give it `//vnc/…`.
  const socket = `${path.replace(/^\//, "")}/websockify`;
  return `https://${host}${path}/vnc.html?path=${socket}&autoconnect=true&resize=scale&reconnect=true`;
}

/**
 * How a node's real name differs from the one hermetic would give it today —
 * `null` when they agree, when the node has not reported yet, or when this
 * caller does not know the tailnet and so cannot honestly compare.
 *
 * Two very different things reach here, and conflating them was a bug that told
 * operators to delete a live machine:
 *
 * - `legacy` — the node is wearing a spelling hermetic itself used to hand out
 *   (`legacyCloudNames`): the pre-v3 bare agent name, or the v3
 *   `<fleet name>-<agent>` one. Nothing is wrong and nothing holds the
 *   canonical name; this box simply predates the rule and keeps its hostname
 *   until it is recreated, because a hostname is fixed at boot.
 * - `stale` — the node is wearing something hermetic never would have chosen,
 *   which in practice is Tailscale's `-2`/`-4` suffix: the canonical name was
 *   taken when this node joined, by the device a `recreate` failed to delete.
 *   That device is a corpse and deleting it is the fix.
 *
 * Returned rather than asserted because neither is an error: the agent is
 * reachable, under a name the operator did not choose, and what to do about it
 * differs by kind.
 */
export function agentHostnameMismatch(
  agent: { name: string; tailscale_dns_name?: string | null },
  tailnet: string | null,
  cloudName?: string | null,
  legacyNames: readonly string[] = [],
): { real: string; canonical: string; kind: "legacy" | "stale" } | null {
  const real = agent.tailscale_dns_name ?? null;
  if (!real || !tailnet) return null;
  const canonical = `${cloudName ?? agent.name}.${tailnet}`;
  if (real === canonical) return null;
  const legacy = legacyNames.some((n) => real === `${n}.${tailnet}`);
  return { real, canonical, kind: legacy ? "legacy" : "stale" };
}

/**
 * The one sentence every head says about a mismatch, so `agent probe`, `doctor`
 * and the drawer do not each invent their own wording for the same situation.
 *
 * Split by kind because the two have opposite advice, and the wrong one is
 * dangerous: told to delete `slate-eagle` in the console, an operator whose box
 * merely predates v4 would be deleting the device their running agent is
 * answering on. So the console is named only for a `stale` device, where the
 * thing to delete really is a corpse; a `legacy` node is described as what it
 * is and left alone.
 */
export function staleDeviceNote(
  name: string,
  mismatch: { real: string; canonical: string; kind: "legacy" | "stale" },
): string {
  if (mismatch.kind === "legacy") {
    /**
     * What is *known* — the name it is wearing is one hermetic itself hands out
     * — and not why. The obvious cause is age, and it is not the only one: the
     * name is asked for by the release in the fleet bucket, not by the laptop
     * that ordered the create, so a fleet whose published hermeticd predates a
     * naming change builds brand-new nodes under the old spelling too. Saying
     * "it was built before…" to an operator watching a node they created five
     * minutes ago teaches them to distrust the sentence.
     */
    return (
      `the node is ${mismatch.real}, not ${mismatch.canonical}: it is wearing a name hermetic ` +
      `used to hand out, and a hostname is fixed at boot; it keeps this name until ` +
      `\`hermetic agent recreate ${name}\` rebuilds it, and nothing needs deleting`
    );
  }
  return (
    `the node is ${mismatch.real}, not ${mismatch.canonical}: a stale device holds the name; ` +
    `delete it in the Tailscale admin console (Machines → ${name})`
  );
}
