/**
 * What the laptop and the box both state about an agent's machine (§6.4,
 * §7.1, §8.3): the root disk's bounds, the apt lock timeout, the config
 * schema version, the provider-key slot naming, and where cloud-init parks
 * user-data.
 *
 * Pure values only — no Zod, no `node:*`, nothing that opens a file or a
 * socket — because `shared/index.ts` re-exports from here into the browser and
 * the box. The Zod schemas that validate these shapes live in `schema/*`, which
 * imports this module, never the reverse (`packages/core/test/shared-browser-safe.test.ts`).
 */

/**
 * The root disk, in GiB: the box's own filesystem, as opposed to the `/data`
 * volume that outlives it (§7.1).
 *
 * Sized per agent rather than taken from the AMI, whose own default is 8 GiB —
 * about 7 GiB of usable root partition once Canonical's boot partitions are
 * out, against the ~5.8 GiB a fully bootstrapped agent occupies before it has
 * done any work: the Hermes venv, Node and `uv` under `/usr`, the browser
 * stack's snap revisions and the apt cache under `/var`, and a ~100 MiB
 * `hermeticd` whose self-update has to write a *second* copy beside a `.prev`
 * backup before it will swap them (§6.5). A box that boots at 86% full stops
 * taking its own updates while its `/data` bar still reads empty.
 *
 * `ROOT_GIB_MIN` is the AMI's own floor, kept reachable on purpose: it is what
 * every agent created before this field existed is actually running, so it must
 * remain a thing an operator can ask for rather than a value only history can
 * hold. `ROOT_GIB_MAX` is a guard rather than a limit EC2 imposes — gp3 goes to
 * 16 TiB, and a root disk that large is a typo, not a decision. The data volume
 * is the one sized for the work (`volume_gib`, up to 16 TiB); this one is sized
 * for the software on the box.
 *
 * Applied at launch, so changing it on an existing agent takes a `recreate` —
 * the same contract `size` has, and for the same reason: both are properties of
 * an instance, and instances are disposable (§1).
 */
export const ROOT_GIB_MIN = 8;
export const ROOT_GIB_MAX = 500;
export const DEFAULT_ROOT_GIB = 20;

/** Model provider. `bedrock` is the zero-secret path through the instance role. */
/**
 * How long any apt on this box waits for the dpkg lock before giving up (§6.4).
 *
 * Three processes contend for that one lock: hermeticd's own packages phase on
 * every apply, Ubuntu's `unattended-upgrades` on its own schedule, and — since
 * the agent may install its own packages — Hermes. Stock apt does not wait at
 * all; it prints `Could not get lock /var/lib/dpkg/lock-frontend` and exits,
 * which the agent reports as an unexplained failure and an apply reports as a
 * flake.
 *
 * It lives here, in the schema both sides already import, because it is stated
 * twice on the box and the two must agree: `APT_OPTIONS` in `agentd/apply.ts`
 * puts it on hermeticd's own argv, and the rendered
 * `/etc/apt/apt.conf.d/91hermetic-dpkg` puts it in the global configuration the
 * agent's apt inherits without being told.
 */
export const APT_LOCK_TIMEOUT_SECONDS = 120;
export const AGENT_CONFIG_SCHEMA_VERSION = 1;
/** The slot every agent's provider key lived in before profiles (§8.3). */
export const DEFAULT_PROVIDER_KEY_SLOT = "provider-key";

/**
 * The slot one profile revision's credential snapshot lives in. One function, so
 * the laptop that writes the parameter, the renderer that names it and
 * hermeticd's slot guard cannot spell it three ways.
 *
 * The *profile* is in the name as well as the revision, and that is not
 * decoration. Revisions start at 1 per profile, so naming the slot after the
 * revision alone collides the moment a fleet has two profiles — an agent bound
 * to profile A at r1 and staged onto profile B at r1 would name the same slot
 * for its running and its staged binding, and the apply would overwrite the
 * credential the box is serving on before the row that commits the change. The
 * whole point of a revision slot is that a staged key goes somewhere nothing
 * reads (§8.3), and only `<profile_id>-r<revision>` is unique enough to keep
 * that true.
 */
export function providerKeySlot(profileId: string, revision: number): string {
  return `${DEFAULT_PROVIDER_KEY_SLOT}-${profileId}-r${String(revision)}`;
}

/**
 * Whether a name is a provider-key slot at all — the base one, or one profile
 * revision's.
 *
 * The profile id is matched as 8 lowercase alphanumerics — the shape
 * `ProfileId` mints, widened from its Crockford subset on purpose. This string
 * becomes an SSM path, so the characters that matter are the ones that could
 * escape the prefix (`.`, `/`), and those are refused; narrowing further would
 * buy nothing and would make an unrecognised id fall silently back to the
 * legacy slot, which is exactly the quiet failure this seam exists to stop.
 */
const PROVIDER_KEY_SLOT_RE = new RegExp(`^${DEFAULT_PROVIDER_KEY_SLOT}-[a-z0-9]{8}-r[1-9][0-9]*$`);

export function isProviderKeySlot(name: string): boolean {
  return name === DEFAULT_PROVIDER_KEY_SLOT || PROVIDER_KEY_SLOT_RE.test(name);
}

/**
 * The slot a rendered manifest says its provider key lives in — the one field
 * hermeticd reads to decide which parameter to fetch (§8.3).
 *
 * Absent means `provider-key`, which is what every manifest written before
 * profiles says and what a box that has not been re-applied since still holds.
 * A value that is not a provider-key slot at all is treated the same way rather
 * than trusted: this string becomes an SSM path, and a manifest is a document,
 * not an authorisation.
 */
export function providerKeyRefOf(manifest: { provider_key_ref?: string | undefined }): string {
  const ref = manifest.provider_key_ref;
  return ref !== undefined && isProviderKeySlot(ref) ? ref : DEFAULT_PROVIDER_KEY_SLOT;
}
/** Where cloud-init leaves the JSON blob for `hermeticd bootstrap` to re-read. */
export const USER_DATA_JSON_PATH = "/var/lib/cloud/instance/hermetic.json";
