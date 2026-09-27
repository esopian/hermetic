/**
 * The secret slots (§8.2, §8.3): `secrets.push`, `secrets.verify`,
 * `secrets.list`, `secrets.delete`.
 *
 * Its own module for the reason `lifecycle.ts`, `teardown.ts` and `settings.ts`
 * are (core rule 5): `hermetic.ts` is the file that keeps running into the
 * 2500-line cap, and this is a subject with a dependency list it can be handed.
 *
 * **What it never does.** No function here returns a value, logs one, or puts
 * one in an event. Two of them *hold* a value — a push, and the digest
 * comparison behind `verify` — and both drop it before returning: a push
 * answers with the path it wrote, and `verify` answers with a boolean. The one
 * copy that moves a value between slots (`--rekey`) writes it and records the
 * slug it came from, never the bytes.
 *
 * **Why shared secrets are copied rather than shared.**
 * `/hermetic/<fleet_id>/secrets/*` is deliberately outside what an instance
 * role may read — the foundation grants `parameter/hermes/<fleet_id>/*` and nothing wider — so a shared key reaches a box
 * by being copied into that box's own slot by the laptop, exactly the way a
 * typed key is. The consequence is stated rather than hidden: rotating a shared
 * slot does not reach live agents, `--rekey` is how an operator says they meant
 * to, and `verify` compares digests so an operator can see who is stale.
 */
import { createHash } from "node:crypto";
import {
  FLEET_KEY,
  PROVIDERS_LIST,
  SecretsDeleteInput as SecretsDeleteInputSchema,
  SecretsListInput as SecretsListInputSchema,
  SecretsPushInput as SecretsPushInputSchema,
  SecretsVerifyInput as SecretsVerifyInputSchema,
  providerNeedsKey,
} from "../schema/index.ts";
import type {
  Agent,
  AgentStatus,
  FleetItem,
  FleetSettings,
  Provider,
  SecretsDeleteInput,
  SecretsListInput,
  SecretsPushInput,
  SecretsVerifyInput,
  SharedSecretMeta,
  TailscaleOauthCheck,
} from "../schema/index.ts";
import { HermeticError } from "../errors.ts";
import { validateName } from "../shared/naming.ts";
import type { CoreContext } from "../context.ts";
import {
  agentParamPath,
  sharedSecretPath,
  sharedSecretPrefix,
  tailscaleOauthClientIdPath,
  tailscaleOauthSecretPath,
} from "../backend/constants.ts";
import { clientIdFromSecret } from "../aws/tailscale.ts";
import { lockActivity } from "../fleet/fleet-lock.ts";
import { isLockLive } from "../agents/state.ts";
import { NO_DEVICES_SCOPE_NOTE } from "../fleet/preflight.ts";
import { commitSettings, expectedVersionOf, readSettings, settingsOf } from "./settings.ts";
import { profilesIn } from "./profile-migrate.ts";
import { profileOwningSlug } from "./provider-profiles.ts";
import { credentialSlotOf } from "./profile-binding.ts";

/**
 * §8.1: the fleet-wide Tailscale auth key slot an agent's boot reads once.
 *
 * All three take the fleet id first: two fleets in one account both have an
 * agent called `atlas`, and before v3 they would have shared one slot.
 */
export const tsKeyPath = (fleetId: string, name: string): string =>
  agentParamPath(fleetId, name, "ts-key");
/** §8.1: the Bitwarden Secrets Manager access token, when `secrets_mode` is `bitwarden`. */
export const bwsPath = (fleetId: string, name: string): string =>
  agentParamPath(fleetId, name, "bws-token");
/**
 * §8.1: a keyed provider's API key, in the same per-agent SSM prefix the
 * instance role can already read (`parameter/hermes/<fleet_id>/<name>/*`) — so
 * it needs no policy of its own, and it arrives the same way the Tailscale auth
 * key does: written at create, read once at boot, never on disk on the box.
 */
export const providerKeyPath = (fleetId: string, name: string): string =>
  agentParamPath(fleetId, name, "provider-key");

/**
 * §8.3: the slot *this* agent's running configuration reads its provider key
 * from — `provider-key` on a row written before provider profiles, and
 * `provider-key-<profile_id>-r<revision>` on one bound to a profile.
 *
 * Every maintenance path goes through here rather than through
 * `providerKeyPath`, so `secrets push --provider-key` writes the slot the box
 * is actually reading instead of one it stopped reading at its last apply.
 */
export const agentProviderKeyPath = (
  fleetId: string,
  agent: Pick<Agent, "name" | "credential_ref">,
): string => agentParamPath(fleetId, agent.name, credentialSlotOf(agent));

/**
 * What `secrets.push` reports back. `note` is the one thing a push can have to
 * say that is neither a failure nor part of the path: a stored Tailscale OAuth
 * client that mints but cannot list devices. `rekeyed` is the agents a shared
 * push re-copied into, so a head can say which boxes take the new key on their
 * next recreate. Core does not print either (rule 1); the head does.
 */
export interface SecretsPushResult {
  path: string;
  note?: string;
  rekeyed?: string[];
}

/**
 * `secrets verify`'s answer. `shared` appears only for an agent whose provider
 * names a fleet-level slot: `current` is whether this agent's own copy is the
 * one in that slot, and `null` when either side is absent or still a
 * placeholder — "cannot tell" rather than "different", because the two are
 * different problems.
 */
export interface SecretsVerifyReport {
  name: string;
  slots: Array<{ path: string; exists: boolean; placeholder: boolean }>;
  ok: boolean;
  shared?: { slug: string; current: boolean | null };
  /**
   * Things worth saying that are not failures. A shared slot nobody names being
   * empty is the one that matters: it is a slot an operator declared and has
   * not filled, which nothing is broken by — so it must not make `ok` false and
   * turn `secrets verify` into a check that is permanently red — but it is also
   * not nothing, because the day a provider names it the next create prompts.
   * Core states them; the head prints them (rule 1).
   */
  warnings?: string[];
}

/** One shared slot, described without its value (§8.2). */
export interface SharedSecretView {
  slug: string;
  label?: string;
  /** Whether the parameter is there at all. */
  exists: boolean;
  /** Whether it is still the placeholder `ensureSlot` wrote — declared but never filled. */
  placeholder: boolean;
  created_at?: string;
  last_set_at?: string;
  /** Every provider whose settings entry names this slug — the §8.3 fan-out. */
  used_by: Provider[];
  /**
   * The provider profile this slot belongs to, when one does (§8.3). A slot a
   * profile owns is managed through `hermetic providers`, so `secrets rm`
   * refuses it and a head links back to the profile rather than offering a
   * delete that will not work.
   */
  owner?: { profile: string; name: string };
  /**
   * A parameter under `/hermetic/<fleet_id>/secrets/` that no settings entry describes: a
   * slot written by a hermetic that has since forgotten it, or by hand. Listed
   * because an unnamed secret is still a secret somebody is paying to store,
   * and `secrets rm` is how it goes away.
   */
  orphan?: boolean;
}

export interface SecretsListResult {
  secrets: SharedSecretView[];
}

export interface SecretsDeleteResult {
  slug: string;
  deleted: true;
}

/** What the secrets surface needs beyond the shared context: the §4.7 OAuth probe. */
export interface SecretsDeps {
  ctx: CoreContext;
  /** Proves an OAuth client can mint before it is stored; real by default (rule 6). */
  verifyTailscaleOauth: (secret: string) => Promise<TailscaleOauthCheck>;
}

export interface SecretsApiSurface {
  secretsPush: (input: SecretsPushInput) => Promise<SecretsPushResult>;
  secretsVerify: (input: SecretsVerifyInput) => Promise<SecretsVerifyReport>;
  secretsList: (input?: SecretsListInput) => Promise<SecretsListResult>;
  secretsDelete: (input: SecretsDeleteInput) => Promise<SecretsDeleteResult>;
}

/**
 * The statuses in which copying a key into an agent's own slot means something.
 *
 * `destroyed` and `destroying` are excluded because `destroy` sweeps
 * `/hermes/<fleet_id>/<name>/` (§6.6): a rekey that included them would *re-create* the
 * slot it had just deleted, leaving a live provider key in an account for a box
 * that no longer exists — the exact leak the sweep is there to prevent. Every
 * other status is a box that is running, will run again, or is being fixed, and
 * each of those reads its slot on its next boot (§8.1).
 *
 * `lifecycle.ts` makes the same distinction when it asks who still owns a
 * volume; this is that rule for slots.
 */
const REKEYABLE_STATUSES: ReadonlySet<AgentStatus> = new Set<AgentStatus>([
  "creating",
  "bootstrapping",
  "ready",
  "degraded",
  "stopping",
  "stopped",
  "error",
]);

/** Providers whose settings entry names this slug — the §8.3 fan-out `ls` prints. */
function usedBy(settings: FleetSettings, slug: string): Provider[] {
  return PROVIDERS_LIST.filter((p) => settings.providers[p]?.secret === slug);
}

/**
 * The same `providers` map with the named entries' `secret` pointer dropped,
 * and everything else about them — `enabled`, `default_model` — left alone.
 *
 * The pointer is the only part of a pre-profile entry that names a slot, so it
 * is the only part a delete of that slot may touch: a provider that was
 * disabled, or pinned to a model, still is.
 */
function withoutSecret(
  settings: FleetSettings,
  providers: readonly Provider[],
): FleetSettings["providers"] {
  const next = { ...settings.providers };
  for (const p of providers) {
    const entry = next[p];
    if (entry === undefined) continue;
    const { secret: _dropped, ...rest } = entry;
    next[p] = rest;
  }
  return next;
}

export function createSecrets(deps: SecretsDeps): SecretsApiSurface {
  const { backend } = deps.ctx;

  /**
   * The sha256 of a slot's value, or `null` when there is nothing real in it.
   * The digest never leaves this function's callers as anything but a boolean:
   * a hash of an API key is not the key, but it is a thing an attacker can
   * check guesses against, so it does not go into a result either.
   */
  async function digestOf(path: string): Promise<string | null> {
    if (!(await backend.secrets.exists(path))) return null;
    if (await backend.secrets.isPlaceholder(path)) return null;
    return createHash("sha256")
      .update(await backend.secrets.get(path))
      .digest("hex");
  }

  /**
   * Rotating the fleet's Tailscale OAuth client (§5, §8.3). Tailscale cannot
   * edit the scopes of an existing client, so widening one from `auth_keys`
   * alone to `auth_keys` + `devices:core` + `policy_file` is always a *new*
   * client — which makes this the only way a fleet created before hermetic
   * asked for those scopes gets device cleanup, `doctor`'s device drift, and a
   * tailnet policy hermetic keeps current instead of printing (§4.7).
   *
   * It is verified before it is stored, and refused when it cannot mint. A
   * provider key that is wrong only stops one agent answering; a Tailscale
   * client that cannot mint stops every future `agent create` on a fleet that
   * had a working one a moment ago, and the failure would land twenty minutes into the next
   * provisioning run rather than here. A client that mints but cannot list is
   * stored — that is exactly the state a pre-`devices:core` fleet is already in,
   * so refusing it would make the command unable to reproduce the status quo —
   * and the caller gets the note to print.
   *
   * Both halves are written, in the same order `init` writes them: the secret
   * into its SecureString slot and nowhere else, and the id parsed out of it
   * into its companion slot and onto `_fleet`, because finding, rotating or
   * revoking the client later starts with knowing which one it is.
   */
  async function pushTailscaleOauth(secret: string, fleet: FleetItem): Promise<SecretsPushResult> {
    const clientId = clientIdFromSecret(secret);
    if (clientId === null) {
      throw new HermeticError(
        "VALIDATION",
        "that does not look like a Tailscale OAuth client secret (tskey-client-…)",
      );
    }
    const check = await deps.verifyTailscaleOauth(secret);
    if (!check.ok) {
      throw new HermeticError(
        "TAILSCALE_UNAVAILABLE",
        check.problem ?? "that OAuth client could not mint a tag:hermetic key; nothing was stored",
        { client_id: clientId },
      );
    }

    const secretPath = tailscaleOauthSecretPath(fleet.fleet_id);
    const clientIdPath = tailscaleOauthClientIdPath(fleet.fleet_id);
    await backend.secrets.ensureSlot(secretPath);
    await backend.secrets.put(secretPath, secret);
    await backend.secrets.ensureSlot(clientIdPath);
    await backend.secrets.put(clientIdPath, clientId);
    /**
     * The id is not a secret; it is what an operator searches the admin console
     * for. `_fleet` carries it so `hermetic config`/Settings can show it.
     *
     * One attribute, never the whole item: this closure has been holding
     * `fleet` since before the OAuth client was verified over the network, and
     * writing that copy back would revert any `settings.set`, profile write or
     * Bedrock grant that landed while it waited.
     *
     * Conditional on the fleet lock as well, with no owner of our own — a
     * `secrets push` holds no lock. `foundation.update` and `apply` kind
     * `network` take that lock precisely so the fleet's metadata stops moving
     * while they run, and their commit point states the revision they were
     * composed against, so a write landing underneath them would cost an
     * update its last step. Refusing here is the cheap end of the same rule,
     * and the secret itself is already stored, so re-running after the update
     * finishes writes nothing twice.
     */
    if (fleet.tailscale_oauth_client_id !== clientId) {
      const written = await backend.store.fleet.updateFleet(
        { tailscale_oauth_client_id: clientId },
        { now: new Date(deps.ctx.nowIso()) },
      );
      if (written === null) {
        /**
         * `null` is three refusals wearing one face — no row, a live foreign
         * lock, or a revision that moved — and they ask different things of the
         * operator. Re-read and say which, the way `withFleetLock` does: a
         * missing `_fleet` is `hermetic doctor`, a live lock is "wait", and
         * anything else is a re-run. The secret is stored either way, so
         * re-running writes nothing twice.
         */
        const latest = await backend.store.fleet.get();
        if (latest === null) {
          throw new HermeticError(
            "NOT_FOUND",
            `the secret was stored, but this fleet has no ${FLEET_KEY} record to name the OAuth client on; run \`hermetic doctor\``,
            { client_id: clientId, scope: "fleet" },
          );
        }
        const holder = latest.lock;
        if (isLockLive(holder, undefined, new Date(deps.ctx.nowIso()).getTime())) {
          throw new HermeticError(
            "LOCKED",
            `the secret was stored, but ${FLEET_KEY} still names the previous OAuth client: ${lockActivity(holder.owner)} (locked by ${holder.owner} until ${holder.expires}). Re-run this push once it has finished.`,
            { client_id: clientId, owner: holder.owner, expires: holder.expires, scope: "fleet" },
          );
        }
        throw new HermeticError(
          "CONFLICT",
          `the secret was stored, but ${FLEET_KEY} changed while it was being recorded, so this push did not name the new OAuth client. Re-run it.`,
          { client_id: clientId, scope: "fleet" },
        );
      }
    }
    // The client id, never the secret (§8.3).
    await deps.ctx.appendEvent(
      FLEET_KEY,
      "secrets.push",
      `pushed a value to ${secretPath} (client ${clientId})`,
    );
    return {
      path: secretPath,
      ...(check.can_list_devices ? {} : { note: check.problem ?? NO_DEVICES_SCOPE_NOTE }),
    };
  }

  /**
   * The shared slug an agent's key was copied *from* (§8.3), or `undefined` for
   * an agent whose credential has no shared source at all — a role-authenticated
   * provider, or a row whose profile holds no secret.
   *
   * Two sources, in the order that decides which one applies:
   *
   * - A row bound to a profile takes its key from **that profile's**
   *   credential, whatever `settings.providers[<p>]` still says. Two profiles on
   *   one provider are the ordinary case since §8.3 — each with its own slug and
   *   its own per-agent slot — so the pre-profile map answers for neither.
   * - A row the migration left unbound has no profile to ask, and resolves its
   *   key through the pre-profile map exactly as it always did.
   *
   * Everything that has to know "does this agent read that shared slot" —
   * `--rekey`, the named-agent refusal, `verify`'s stale-copy comparison — asks
   * this one function, because those three answering differently is how a rekey
   * writes a key into a slot nothing reads while the agent that *did* read the
   * rotated slug is passed over.
   */
  function sourceSlugOf(settings: FleetSettings, agent: Agent): string | undefined {
    if (agent.profile_id !== undefined) {
      const profile = settings.profiles?.[agent.profile_id];
      if (profile === undefined) return undefined;
      return profile.credential.kind === "secret" ? profile.credential.slug : undefined;
    }
    return settings.providers[agent.provider]?.secret;
  }

  /**
   * Which agents a `--rekey` names, resolved *before* anything is written. An
   * explicit list that names an agent whose provider does not read this slug is
   * a mistake worth refusing rather than a copy worth making: it would put a
   * key in a slot the agent's provider never reads, and the operator would be
   * told it worked.
   */
  async function rekeyTargets(
    rekey: "all" | string[],
    settings: FleetSettings,
    slug: string,
  ): Promise<Agent[]> {
    if (rekey === "all") {
      const all = await backend.store.agents.scan();
      return all.filter((a) => sourceSlugOf(settings, a) === slug && REKEYABLE_STATUSES.has(a.status));
    }
    const targets: Agent[] = [];
    for (const name of rekey) {
      // `getAgent` answers `NOT_FOUND` for a name nothing is running under,
      // which is the same complaint every other command makes about it.
      const agent = await deps.ctx.getAgent(validateName(name));
      if (sourceSlugOf(settings, agent) !== slug) {
        throw new HermeticError(
          "VALIDATION",
          `${agent.name} does not read the shared slot ${slug} — it runs on ${agent.provider}` +
            `${agent.profile_id === undefined ? "" : ` through provider profile ${agent.profile_id}`}` +
            "; nothing was re-keyed",
          { name: agent.name, provider: agent.provider, slug },
        );
      }
      // A named agent is refused rather than skipped: `--rekey all` silently
      // passing over a destroyed row is the operator's own scope, but naming
      // one is a request that cannot be honoured, and writing the slot back
      // would undo `destroy`'s SSM sweep without saying so.
      if (!REKEYABLE_STATUSES.has(agent.status)) {
        throw new HermeticError(
          "VALIDATION",
          `${agent.name} is ${agent.status}; its secret slots are gone and re-keying would put the key back. Nothing was re-keyed`,
          { name: agent.name, status: agent.status, slug },
        );
      }
      targets.push(agent);
    }
    return targets;
  }

  /**
   * A fleet-level shared slot (§8.3). Four writes in a deliberate order: the
   * value, the metadata that names it, the per-agent copies, and the event.
   *
   * The value goes in first and the conditional settings write may still lose
   * to another laptop (`CONFLICT`). That is the acceptable half of the race:
   * the slot then holds the value this push meant to put there and the metadata
   * is one version behind, which the same command run again fixes — the push is
   * idempotent. The other order would be worse: metadata claiming a slot that
   * was never filled.
   */
  async function pushShared(
    parsed: SecretsPushInput & { shared: string; value: string },
  ): Promise<SecretsPushResult> {
    // Before anything: a `foundation update` rewriting `_fleet` is not a fleet
    // to add a secret to, and the store's own condition would report it as a
    // lost race rather than as the wait it is.
    await deps.ctx.assertFleetUnlocked();
    const slug = parsed.shared;
    const { fleet, settings, persisted } = await readSettings(deps.ctx);
    const targets = parsed.rekey === undefined ? [] : await rekeyTargets(parsed.rekey, settings, slug);

    const path = sharedSecretPath(fleet.fleet_id, slug);
    await backend.secrets.ensureSlot(path);
    await backend.secrets.put(path, parsed.value);

    const now = deps.ctx.nowIso();
    const existing = settings.secrets.find((s) => s.slug === slug);
    // A new label wins; no label leaves whatever the slot was already called,
    // so re-pushing a value is not a way to lose its name.
    const label = parsed.label ?? existing?.label;
    const meta: SharedSecretMeta = {
      slug,
      ...(label === undefined ? {} : { label }),
      created_at: existing?.created_at ?? now,
      last_set_at: now,
    };
    const next: FleetSettings = {
      ...settings,
      version: persisted ? settings.version + 1 : 1,
      secrets: [...settings.secrets.filter((s) => s.slug !== slug), meta].sort((a, b) =>
        a.slug.localeCompare(b.slug),
      ),
      updated_at: now,
      updated_by: await deps.ctx.actor(),
    };
    // The slug and nothing else — not the value, and not the label either: a
    // label is operator-typed prose and the event log is read back by every
    // head, so there is no reason for it to travel.
    try {
      await commitSettings(
        deps.ctx,
        next,
        expectedVersionOf(settings, persisted),
        "secrets.push",
        `shared slot ${slug} → v${next.version}`,
      );
    } catch (e) {
      // The generic "settings changed under you" is true but misleading here:
      // half of this push *did* land. Say which half, so the operator knows the
      // re-run is a re-run and not a first attempt — and that the rekey copies
      // below never happened.
      if (e instanceof HermeticError && e.code === "CONFLICT") {
        throw new HermeticError(
          "CONFLICT",
          `shared slot ${slug} was written, but fleet settings changed under you before its entry could be recorded; re-run the same push to record it and re-key`,
          { ...(e.details ?? {}), slug, path },
        );
      }
      throw e;
    }

    const rekeyed: string[] = [];
    for (const agent of targets) {
      const agentPath = agentProviderKeyPath(fleet.fleet_id, agent);
      await backend.secrets.ensureSlot(agentPath);
      await backend.secrets.put(agentPath, parsed.value);
      await deps.ctx.appendEvent(
        agent.name,
        "secrets.push",
        `provider-key rekeyed from shared slot ${slug}`,
      );
      rekeyed.push(agent.name);
    }
    return { path, rekeyed };
  }

  async function secretsPush(input: SecretsPushInput): Promise<SecretsPushResult> {
    // Validate everything first: creating a slot and *then* discovering there is
    // no value to put in it leaves an empty parameter behind (§8.2).
    const parsed = SecretsPushInputSchema.parse(input);
    if (parsed.name !== FLEET_KEY) validateName(parsed.name);
    if (parsed.from_bitwarden) {
      // TODO(evan): PHASE2 — `bws secret get | PutParameter` (§8.2). The head shells out to
      // `bws`; core only ever receives the value in `input.value`.
      throw new HermeticError(
        "UNSUPPORTED",
        "--from-bitwarden is not implemented yet; use --bws-token",
      );
    }
    if (parsed.value === undefined || parsed.value.length === 0) {
      throw new HermeticError("CONFIRMATION_REQUIRED", "no value was supplied on stdin");
    }
    const value = parsed.value;
    const guarded = await deps.ctx.guardFleet();
    /**
     * A fleet slot is not an agent's, so there is no row to look up and no
     * `secrets_mode` to consult: `/hermetic/<fleet_id>/tailscale/oauth-secret` and
     * `/hermetic/<fleet_id>/secrets/<slug>` exist for the fleet as a whole (§8.3). The
     * schema has already refused `_fleet` with an agent-only flag and a
     * fleet-only flag on an agent name, so reaching here means the operator
     * asked for exactly one of those two slots.
     */
    if (parsed.name === FLEET_KEY) {
      if (parsed.shared !== undefined) {
        return await pushShared({ ...parsed, shared: parsed.shared, value });
      }
      return await pushTailscaleOauth(value, guarded.fleet);
    }
    /**
     * §4.4, for the agent branch specifically. It writes an SSM slot and an
     * event and takes no lock at all, so it walked straight past a fleet-wide
     * one: a push that started after a teardown took the lock put a credential
     * back into an account whose `--purge` was about to sweep it, or had.
     *
     * The two `_fleet` branches above are deliberately not routed through here.
     * `--shared` asks the same question for itself before its first write, and
     * `--tailscale-oauth` is the documented exception — it stores the secret and
     * lets the *row* write be refused by its own condition, because the secret
     * being in its slot is what makes re-running the push after the update free.
     */
    await deps.ctx.assertFleetUnlocked(parsed.name);
    const agent = await deps.ctx.getAgent(parsed.name);
    if (parsed.provider_key === true && !providerNeedsKey(agent.provider)) {
      throw new HermeticError(
        "SECRETS_DISABLED",
        `${agent.name} runs on ${agent.provider}, which authenticates as the instance role; there is no provider key to push`,
        { name: agent.name, provider: agent.provider },
      );
    }
    if (parsed.provider_key !== true && agent.secrets_mode === "none") {
      throw new HermeticError(
        "SECRETS_DISABLED",
        `${agent.name} has secrets_mode none; there is nothing to push`,
        { name: agent.name },
      );
    }
    const fleetId = guarded.fleet.fleet_id;
    const path =
      parsed.provider_key === true
        ? agentProviderKeyPath(fleetId, agent)
        : bwsPath(fleetId, agent.name);
    await backend.secrets.ensureSlot(path);
    await backend.secrets.put(path, value);
    // The value is never echoed, logged, or written to disk (§8.3).
    await deps.ctx.appendEvent(agent.name, "secrets.push", `pushed a value to ${path}`);
    return { path };
  }

  async function secretsVerify(input: SecretsVerifyInput): Promise<SecretsVerifyReport> {
    const parsed = SecretsVerifyInputSchema.parse(input);
    if (parsed.name !== FLEET_KEY) validateName(parsed.name);
    await deps.ctx.guardAccount();
    const fleetId = deps.ctx.fleetId();
    /**
     * Read once, for both branches. The fleet item is where the shared slots
     * are *named*; the slots themselves are in SSM.
     *
     * Through `settingsOf`, not off the raw field: a fleet that predates §8.3
     * has no `profiles` on disk at all, and the profile a bound row names is
     * one `withProviderProfiles` derives. Reading the raw field would make
     * every such row look like it had no credential source.
     */
    const fleetItem = await backend.store.fleet.get();
    const shared = fleetItem === null ? undefined : settingsOf(fleetItem).settings;
    const slotOf = async (path: string) => {
      const exists = await backend.secrets.exists(path);
      return { path, exists, placeholder: exists ? await backend.secrets.isPlaceholder(path) : false };
    };
    /**
     * `_fleet` has no row behind it, but it has slots: the two halves of the
     * fleet's Tailscale OAuth client, and every shared secret the fleet has
     * declared. Reporting them in the same shape as an agent's is what lets a
     * head render both without a special case (§8.3) — and the client id is
     * listed beside its secret because "the secret is set but the id slot is
     * empty" is a real state a hand-rotated fleet can be in, and it is
     * invisible otherwise.
     */
    if (parsed.name === FLEET_KEY) {
      const oauth = [];
      for (const path of [tailscaleOauthSecretPath(fleetId), tailscaleOauthClientIdPath(fleetId)]) {
        oauth.push(await slotOf(path));
      }
      /**
       * The verdict is about what this fleet *depends on*, which is not the
       * same as every slot it has. The OAuth pair is load-bearing: without it
       * no agent can be created at all. A shared slot is load-bearing only once
       * a provider names it — until then it is a slot somebody made room for,
       * and reporting the whole fleet as incomplete because of one would make
       * `ok` meaningless on any fleet that ever declared a slot in advance.
       */
      const sharedSlots = [];
      const warnings: string[] = [];
      for (const meta of shared?.secrets ?? []) {
        const slot = await slotOf(sharedSecretPath(fleetId, meta.slug));
        const readers = shared === undefined ? [] : usedBy(shared, meta.slug);
        const filled = slot.exists && !slot.placeholder;
        if (!filled && readers.length === 0) {
          warnings.push(`shared slot ${meta.slug} is declared but empty; no provider names it`);
        }
        sharedSlots.push({ slot, required: readers.length > 0 });
      }
      const slots = [...oauth, ...sharedSlots.map((s) => s.slot)];
      const ok =
        oauth.every((s) => s.exists && !s.placeholder) &&
        sharedSlots.every((s) => !s.required || (s.slot.exists && !s.slot.placeholder));
      return {
        name: FLEET_KEY,
        slots,
        ok,
        ...(warnings.length === 0 ? {} : { warnings }),
      };
    }
    const agent = await deps.ctx.getAgent(parsed.name);
    const keyed = providerNeedsKey(agent.provider);
    if (agent.secrets_mode === "none" && !keyed) {
      throw new HermeticError(
        "SECRETS_DISABLED",
        `${agent.name} has secrets_mode none and runs on ${agent.provider}, which needs no key; there is nothing to verify`,
        { name: agent.name },
      );
    }
    // Only the slots this agent is supposed to have: a bedrock/none agent has
    // one, a keyed provider adds its API key, Bitwarden adds its token (§8.1).
    const paths = [
      tsKeyPath(fleetId, agent.name),
      ...(keyed ? [agentProviderKeyPath(fleetId, agent)] : []),
      ...(agent.secrets_mode === "bitwarden" ? [bwsPath(fleetId, agent.name)] : []),
    ];
    const slots = [];
    for (const path of paths) slots.push(await slotOf(path));

    /**
     * The §8.3 stale-copy report. A shared slot is *copied* into an agent at
     * create, so a rotation that was not `--rekey`'d leaves this agent holding
     * the previous key — a state nothing else in hermetic can see. Two digests
     * decide it and neither leaves this scope.
     */
    /**
     * The slug this agent's copy came from, asked of the *binding* rather than
     * of the pre-profile provider map (§8.3). A fleet with two profiles on one
     * provider has two shared slots, and comparing every agent of that provider
     * against whichever one the legacy map happens to name would report a
     * perfectly current agent as stale — or, worse, a stale one as current.
     */
    const slug = keyed && shared !== undefined ? sourceSlugOf(shared, agent) : undefined;
    let sharedReport: SecretsVerifyReport["shared"];
    if (slug !== undefined) {
      const [fleetDigest, agentDigest] = [
        await digestOf(sharedSecretPath(fleetId, slug)),
        await digestOf(agentProviderKeyPath(fleetId, agent)),
      ];
      sharedReport = {
        slug,
        current: fleetDigest === null || agentDigest === null ? null : fleetDigest === agentDigest,
      };
    }
    return {
      name: agent.name,
      slots,
      ok: slots.every((s) => s.exists && !s.placeholder),
      ...(sharedReport === undefined ? {} : { shared: sharedReport }),
    };
  }

  /**
   * Every fleet-level shared slot: what it is called, whether there is anything
   * in it, and which providers read it (§8.2). No value, ever — the whole read
   * is metadata plus two booleans SSM answers without decrypting anything.
   *
   * The parameters are enumerated as well as the metadata, because the two can
   * disagree in both directions and each disagreement is worth seeing: a slug
   * with no parameter is a provider about to fall back to prompting, and a
   * parameter with no slug is a secret nobody remembers storing.
   */
  async function secretsList(input: SecretsListInput = {}): Promise<SecretsListResult> {
    SecretsListInputSchema.parse(input);
    const { fleet, settings } = await readSettings(deps.ctx);
    const prefix = sharedSecretPrefix(fleet.fleet_id);
    const paths = new Set(await backend.secrets.list(prefix));

    const secrets: SharedSecretView[] = [];
    for (const meta of settings.secrets) {
      const path = sharedSecretPath(fleet.fleet_id, meta.slug);
      const exists = paths.has(path);
      paths.delete(path);
      secrets.push({
        slug: meta.slug,
        ...(meta.label === undefined ? {} : { label: meta.label }),
        exists,
        placeholder: exists ? await backend.secrets.isPlaceholder(path) : false,
        created_at: meta.created_at,
        last_set_at: meta.last_set_at,
        used_by: usedBy(settings, meta.slug),
        ...(() => {
          const owner = profileOwningSlug(settings, meta.slug);
          return owner === null ? {} : { owner };
        })(),
      });
    }
    for (const path of [...paths].sort()) {
      const slug = path.slice(prefix.length);
      // `SsmSecrets.list` is recursive, so a parameter at
      // `/hermetic/<fleet_id>/secrets/a/b` would arrive here as the slug `a/b` — a name no
      // `SecretSlug` can spell and therefore one `secrets rm` could never
      // address. It is not hermetic's, so it is not listed as hermetic's.
      if (slug.includes("/")) continue;
      const owner = profileOwningSlug(settings, slug);
      secrets.push({
        slug,
        exists: true,
        placeholder: await backend.secrets.isPlaceholder(path),
        used_by: [],
        ...(owner === null ? {} : { owner }),
        // A slot a profile owns is never an orphan, whatever the metadata says:
        // the profile is the record that names it.
        ...(owner === null ? { orphan: true } : {}),
      });
    }
    return { secrets };
  }

  /**
   * Agents that would still read this slug if it went away — the only reason a
   * pre-profile `settings.providers[<p>].secret` entry is worth refusing a
   * delete over (§8.2, §8.3).
   *
   * The entry itself is a *pointer*, not a reader. Since §8.3 removed the
   * legacy per-provider surface there is no command left that can clear one, so
   * refusing on the pointer alone leaves a slot on a migrated fleet that
   * nothing reads and nobody can free. What can still read it is a row the
   * migration left unbound — no `profile_id`, so `create`/`rekey` resolve its
   * key through the old map — and only in a status whose slots exist at all:
   * `REKEYABLE_STATUSES`, the same set `--rekey` copies into, which excludes
   * `destroyed`/`destroying` because `destroy` already swept their prefix.
   *
   * A row bound to a profile reads the profile's credential, so the pointer is
   * dead to it; a destroyed row has no slot to read with. Neither holds the
   * slug hostage.
   */
  async function legacyReaders(settings: FleetSettings, slug: string): Promise<Agent[]> {
    const all = await backend.store.agents.scan();
    return all
      .filter(
        (a) =>
          (a.profile_id ?? null) === null &&
          settings.providers[a.provider]?.secret === slug &&
          REKEYABLE_STATUSES.has(a.status),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Delete one shared slot (§8.2). Refused while a profile owns it, and while
   * any unbound agent still reads it through the pre-profile map: that agent's
   * next boot reads a slot that is not there. When no such agent exists, a
   * pointer left over from the migration is scrubbed with the slot rather than
   * being allowed to refuse it forever.
   */
  async function secretsDelete(input: SecretsDeleteInput): Promise<SecretsDeleteResult> {
    const parsed = SecretsDeleteInputSchema.parse(input);
    const slug = parsed.slug;
    await deps.ctx.assertFleetUnlocked();
    const { fleet, settings, persisted } = await readSettings(deps.ctx);

    /**
     * Refusals before the confirmation, deliberately: asking an operator to
     * type a slug back at them and *then* saying it never existed, or that a
     * provider still reads it, wastes the one gesture the ceremony exists for.
     * Every reason this delete cannot happen is known without their answer, so
     * it is found first, and the confirmation is asked only for a delete that
     * would otherwise go through.
     */
    const path = sharedSecretPath(fleet.fleet_id, slug);
    const meta = settings.secrets.find((s) => s.slug === slug);
    const exists = await backend.secrets.exists(path);
    /**
     * A pre-profile `providers[p].secret` pointer counts as the slug existing.
     *
     * Without it, the one state this command cannot get out of is the one it
     * was extended to handle: a fleet that named a shared secret before
     * profiles, whose `settings.secrets` never recorded it (nothing did, before
     * §8.2) and whose parameter an operator has since deleted in the console.
     * The pointer is still there, still refuses `providers rm`'s neighbours and
     * still reads as a slot in every head — and `NOT_FOUND` here would make it
     * unfreeable forever, because this is the only command that scrubs it.
     * There is simply no parameter left to remove, which `delete` is already
     * idempotent about.
     */
    const named = usedBy(settings, slug);
    if (meta === undefined && !exists && named.length === 0) {
      throw new HermeticError("NOT_FOUND", `no shared secret ${slug}`, { slug });
    }
    const owner = profileOwningSlug(settings, slug);
    if (owner !== null) {
      throw new HermeticError(
        "VALIDATION",
        `shared secret ${slug} is the credential of the provider profile ${owner.name} (${owner.profile}); remove the profile with \`hermetic providers rm\` instead`,
        { slug, profile: owner.profile },
      );
    }
    /**
     * A profile that *inherited* the slot from the pre-profile map (§8.3) reads
     * it for every agent bound to the profile, and `providers update` refuses
     * to rotate such a profile onto a slot of its own — the shared slug is the
     * credential for as long as the profile exists. Deleting it would flip the
     * profile to `key-missing` under its agents. `providers rm` first, or
     * rotate the key in place with `secrets push _fleet --shared`.
     */
    const inheriting = profilesIn(settings)
      .filter((p) => p.credential.kind === "secret" && p.credential.slug === slug)
      .sort((a, b) => a.name.localeCompare(b.name));
    if (inheriting.length > 0) {
      const names = inheriting.map((p) => p.name);
      throw new HermeticError(
        "CONFLICT",
        `shared secret ${slug} is the credential of the provider profile(s) ${names.join(", ")}; remove ${names.length === 1 ? "it" : "them"} with \`hermetic providers rm\` first, or rotate the key in place with \`hermetic secrets push _fleet --shared ${slug}\``,
        { slug, profiles: inheriting.map((p) => p.id) },
      );
    }
    // Named by a pre-profile entry, and *read* by an agent through it: the
    // names are the agents rather than the providers, because recreating or
    // re-binding those rows is the work this refusal is asking for.
    const stale = named;
    const readers = stale.length === 0 ? [] : await legacyReaders(settings, slug);
    if (readers.length > 0) {
      const names = readers.map((a) => a.name);
      throw new HermeticError(
        "CONFLICT",
        `shared secret ${slug} is still the provider key of ${names.join(", ")}, which ${names.length === 1 ? "reads" : "read"} it through this fleet's pre-profile settings; re-create ${names.length === 1 ? "it" : "them"} on a provider profile, or destroy ${names.length === 1 ? "it" : "them"}, first`,
        { slug, used_by: names, providers: stale },
      );
    }
    if (parsed.yes !== true) {
      throw new HermeticError(
        "CONFIRMATION_REQUIRED",
        `deleting the shared secret ${slug} is irreversible; pass yes`,
        { slug },
      );
    }

    /**
     * The record first, then the slot — the mirror of `pushShared`'s order and
     * the same rule behind it: never leave metadata claiming a slot that is not
     * there. A crash between the two leaves a parameter nothing names, which
     * `secrets ls` reports as an orphan and this command deletes; the other
     * order leaves an entry and a pointer to a slug that no longer exists.
     *
     * One write does both halves: the slug's own metadata, and the pre-profile
     * pointers that named it — proven above to have no reader left, and with no
     * command of their own to clear them since §8.3 retired `providers set`.
     */
    if (meta !== undefined || stale.length > 0) {
      const next: FleetSettings = {
        ...settings,
        version: persisted ? settings.version + 1 : 1,
        secrets: settings.secrets.filter((s) => s.slug !== slug),
        ...(stale.length === 0 ? {} : { providers: withoutSecret(settings, stale) }),
        updated_at: deps.ctx.nowIso(),
        updated_by: await deps.ctx.actor(),
      };
      await commitSettings(
        deps.ctx,
        next,
        expectedVersionOf(settings, persisted),
        "secrets.delete",
        `shared slot ${slug} → v${next.version}${stale.length === 0 ? "" : ` (cleared the pre-profile entry of ${stale.join(", ")})`}`,
      );
      await backend.secrets.delete(path);
      return { slug, deleted: true };
    }
    // An orphan: there is no metadata to rewrite, so the event is the only
    // record that it was here at all.
    await backend.secrets.delete(path);
    await deps.ctx.appendEvent(FLEET_KEY, "secrets.delete", `orphan shared slot ${slug}`);
    return { slug, deleted: true };
  }

  return { secretsPush, secretsVerify, secretsList, secretsDelete };
}
