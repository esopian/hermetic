import { z } from "zod";
import { DEFAULT_PROVIDER_KEY_SLOT } from "../shared/box.ts";
export {
  APT_LOCK_TIMEOUT_SECONDS,
  AGENT_CONFIG_SCHEMA_VERSION,
  DEFAULT_PROVIDER_KEY_SLOT,
  providerKeySlot,
  isProviderKeySlot,
  providerKeyRefOf,
} from "../shared/box.ts";
import { Version } from "./common.ts";
import { Provider, SecretsMode, Size } from "./agent.ts";
import { BrowserIdentity } from "./browser.ts";
import { ApprovalsMode } from "./hermes.ts";
import { CHROME_REF_RE } from "./fleet.ts";

/** An extra apt source the manifest asks hermeticd to add before installing packages. */
export const AptSource = z.object({
  name: z.string().min(1),
  uri: z.string().min(1),
  key_url: z.url().optional(),
});
export type AptSource = z.infer<typeof AptSource>;

/** A fully rendered file. hermetic renders on the laptop; the box never sees a template. */
export const RenderedFile = z.object({
  path: z.string().startsWith("/"),
  mode: z.string().regex(/^0[0-7]{3}$/),
  content: z.string(),
  /** Defaults to root; set when a service user must be able to read the file. */
  owner: z.string().min(1).optional(),
  group: z.string().min(1).optional(),
  /**
   * Units to restart when *this* file's content changes.
   *
   * `apply` restarts a unit when the unit's own file changed, and nothing else:
   * a file a service merely reads is not a service (`apply.ts` §4). That rule
   * is right and it left a hole — Hermes's `config.yaml` is read by
   * `hermes-dashboard.service` and is not a unit file, so changing an agent's model or
   * provider rewrote the config and left the old one running until something
   * else happened to restart it.
   *
   * A post-step `command` was the documented workaround, and it is the wrong
   * shape here: commands run unconditionally on every apply, so the honest
   * version would restart Hermes on every apply, and the dishonest version
   * would have to re-derive "did this change?" that `apply` already knows.
   * Declaring the dependency on the file is the version that restarts exactly
   * when it should.
   *
   * Optional, and ignored by an older hermeticd that has never heard of it —
   * which degrades to today's behaviour rather than to a failed apply.
   */
  restart_units: z.array(z.string().min(1)).optional(),
});
export type RenderedFile = z.infer<typeof RenderedFile>;

/** What `tailscale serve` publishes for this agent (§6.4). */
export const TailscaleServe = z.object({
  enabled: z.boolean(),
  /**
   * **Not rendered.** It was informational — the URL a head could link to — and
   * nothing has ever consumed it: `serveCommands` names only the local target,
   * on the node's own identity, and the heads build the URL from the agent row
   * (`agentHostname`), which is the name the node actually answered on rather
   * than the one the render guessed.
   *
   * Optional rather than deleted because a config tarball already on a box
   * carries it, and hermeticd must keep parsing those. Emitting it again would
   * put the fleet's name into `config_hash` — every rename would then re-render
   * and restart every agent, for a field nothing reads.
   */
  hostname: z.string().min(1).optional(),
  routes: z.array(
    z.object({
      path: z.string().startsWith("/"),
      target: z.string().min(1),
      description: z.string(),
    }),
  ),
});
export type TailscaleServe = z.infer<typeof TailscaleServe>;

/**
 * `manifest.json` — the contract between the laptop's renderer and hermeticd's
 * apply step. hermeticd refuses a manifest whose `schema_version` it does not
 * understand (§6.3).
 */
export const AgentConfig = z.object({
  schema_version: z.literal(1),
  name: z.string(),
  size: Size,
  instance_type: z.string(),
  provider: Provider,
  secrets_mode: SecretsMode,
  /**
   * What `hermes --version` must report once the box has checked out
   * `hermes_ref`. The two are separate fields because neither derives from the
   * other: Hermes Agent is not on PyPI, so there is no `==<version>` to install,
   * and upstream's tags are date-based (`v2026.8.31`) while its `pyproject`
   * carries a semver (`0.21.0`). The box installs the ref and then cross-checks
   * the version — a tag that reports something else fails the apply.
   */
  hermes_version: Version,
  /** The git tag or commit the box checks out of the upstream Hermes repo. */
  hermes_ref: z.string().min(1),
  /**
   * The approvals mode the operator stated for this agent — what `verify-hermes`
   * expects `hermes config get approvals.mode` to answer with (§6.4).
   *
   * The manifest carries no other Hermes setting, and this one is here because a
   * check needs an expectation: the value is seed-only, so hermetic writes it
   * into the agent's own config once and cannot read it back off the managed
   * file the way every other check does. Putting the operator's stated answer on
   * the wire is what lets the box compare what Hermes resolves against what was
   * asked for.
   *
   * Optional, for the two directions that go wrong otherwise. A newer hermeticd
   * reading an older manifest — one rendered before this field, still sitting on
   * a box and re-read by `readAppliedConfigHash` — skips the check rather than
   * refusing the configuration its box is actually running. And `z.object` is
   * non-strict, so an older hermeticd handed a newer manifest ignores the key
   * instead of failing the apply.
   *
   * It is **in** `config_hash`, deliberately: changing `--approvals` has to be a
   * change a rollout can carry, and it is what re-renders the document whose
   * marker-guarded post-step re-asserts the value on the box (`seedCommands`).
   */
  approvals_mode: ApprovalsMode.optional(),
  /**
   * The Chrome for Testing build the box unpacks from the fleet bucket's
   * `browser/` mirror and runs on the agent's X display (§7.3). Ubuntu ships no
   * native-deb browser on arm64 — its `chromium-browser` is a snap shim that
   * cannot run as the `hermes` account — so the browser an agent drives is a
   * pinned binary this fleet mirrors rather than anything apt can supply.
   *
   * Optional for the reason `provider_key_ref` is, and only that reason: a
   * manifest rendered before the browser stack is still sitting on every box,
   * and hermeticd re-reads it from disk to answer with its own `config_hash`
   * (`readAppliedConfigHash`) — a required field would make a newer hermeticd
   * refuse the configuration its box is actually running. Every manifest this
   * build renders names one.
   */
  chrome_ref: z.string().regex(CHROME_REF_RE).optional(),
  /**
   * The browser identities this agent runs — exactly one, named `default`,
   * today (`browserIdentities`).
   *
   * Optional because a manifest written before the browser stack existed says
   * nothing, and a box re-reads its own installed manifest to answer with its
   * `config_hash` (`readAppliedConfigHash`): a required field would make a newer
   * hermeticd refuse the configuration its box is actually running. Every
   * manifest this build *renders* carries exactly one entry.
   *
   * A list rather than a single object because the units, the ports, the
   * profile directory and the Serve path are all per identity (§H of plan
   * 0016), so a second browser is a data change here rather than a redesign of
   * the document.
   */
  browsers: z.array(BrowserIdentity).optional(),
  config_hash: z.string(),
  packages: z.array(z.string()),
  apt_sources: z.array(AptSource),
  files: z.array(RenderedFile),
  units: z.array(z.string()),
  commands: z.array(z.string()),
  tailscale_serve: TailscaleServe,
  /**
   * The instance secret slot hermeticd materialises this agent's provider key
   * from (§8.3): `provider-key` on every manifest rendered before profiles
   * existed, `provider-key-<profile_id>-r<revision>` on one rendered from a provider
   * profile. Absent means `provider-key`, which is what an older manifest still
   * sitting on a box means and what hermeticd falls back to.
   *
   * It is **in** `config_hash`, deliberately. Rotating a profile's key changes
   * nothing else about the document, and a rotation that did not move the hash
   * would be a change no rollout could carry to a box — the whole mechanism for
   * "this agent's configuration moved" is the hash.
   */
  provider_key_ref: z.string().min(1).optional(),
  /**
   * What this document needs the *box* to be able to do — capability names, not
   * a version (`AGENT_CONFIG_CAPABILITIES` below). Absent on a manifest rendered
   * before the field, and on one that asks nothing unusual.
   *
   * `schema_version` cannot carry this. It says "the shape changed", and the
   * shape does not change when a renderer starts naming a unit that only a newer
   * hermeticd installs, or starts relying on behaviour a newer hermeticd has.
   * Nor can `hermetic_version`: two checkouts a day apart both call themselves
   * `0.5.0`. So the document states its own requirements and the box, which is
   * the only party that knows what it can do, decides.
   *
   * Deliberately `string`, not an enum: a box must be able to *read* a
   * requirement it has never heard of — that is the whole point — and an enum
   * would make the manifest fail to parse instead, with an error about a shape
   * rather than about a release.
   */
  requires: z.array(z.string().min(1)).optional(),
});
export type AgentConfig = z.infer<typeof AgentConfig>;

/**
 * Everything a rendered config can ask of the box, and why it would.
 *
 * Each entry is a promise about hermeticd's *behaviour*, added the same day the
 * behaviour is: a renderer that starts depending on something a box must do
 * names it here, `requiredCapabilities` learns when to ask for it, and hermeticd
 * adds it to `HERMETICD_CAPABILITIES` in the same commit. The seam test
 * (`tests/seams.test.ts`) fails if a checkout renders a requirement its own
 * hermeticd does not implement.
 *
 * The failure this prevents is not hypothetical. A laptop rendered a drop-in for
 * `hermes-gateway.service` and listed that unit; the fleet's published hermeticd
 * predated `ensureGatewayUnit`, so nothing installed it, and the box died in the
 * apply step on `Failed to enable unit: Unit file hermes-gateway.service does
 * not exist.` — a sentence about systemd, for a problem about releases.
 */
export const AGENT_CONFIG_CAPABILITIES = {
  /**
   * hermeticd installs upstream's gateway unit itself (`hermes gateway install
   * --system`) when systemd has none, rather than assuming one exists.
   */
  "gateway-unit": "install hermes-gateway.service when upstream's is absent",
  /**
   * hermeticd restarts the units a rendered file names in `restart_units`.
   * Without it a config lands on disk and never takes effect — the quietest
   * failure in the set, because everything reports success.
   */
  "restart-units": "restart the units a rendered file declares it feeds",
  /**
   * hermeticd reads the provider key from the slot `provider_key_ref` names
   * rather than from `provider-key`. A box without it would read the slot the
   * *previous* binding wrote and go on running the old credential while every
   * laptop-side reading said the new one had landed — so a manifest that names
   * any other slot asks for this, and an older box refuses it outright.
   */
  "provider-key-ref": "materialise the provider key from the slot the manifest names",
  /**
   * hermeticd unpacks the mirrored Chrome build the manifest pins and runs the
   * per-identity browser units (`hermetic-browser@<name>.service` and the Xvfb,
   * window manager, x11vnc and websockify instances beside it).
   *
   * A box without it has no `/opt/hermetic/chrome/<ref>` and no bootstrap stage
   * that would create one, so every browser unit would fail on a missing
   * executable — a crash loop reported as `Restart=always` rather than as a
   * release that is behind the laptop. A manifest with no browsers asks for
   * nothing, so a `browser: false` agent still applies on an older box.
   */
  "browser-stack": "unpack the mirrored Chrome build and run the per-identity browser units",
} as const;
export type AgentCapability = keyof typeof AGENT_CONFIG_CAPABILITIES;

export const AGENT_CAPABILITY_LIST = Object.keys(AGENT_CONFIG_CAPABILITIES) as AgentCapability[];

/**
 * What a rendered document actually needs, derived from the document itself.
 *
 * Derived rather than declared by hand at the call site for the usual reason:
 * a hand-written list beside the renderer is a list that stops matching what the
 * renderer emits. A config that names no gateway unit does not ask for one, so
 * an older box keeps applying it.
 */
export function requiredCapabilities(manifest: {
  units: readonly string[];
  files: readonly { restart_units?: readonly string[] | undefined }[];
  provider_key_ref?: string | undefined;
  browsers?: readonly BrowserIdentity[] | undefined;
}): AgentCapability[] {
  const out: AgentCapability[] = [];
  if (manifest.units.some((u) => /^hermes-gateway.*\.service$/.test(u))) out.push("gateway-unit");
  if (manifest.files.some((f) => (f.restart_units?.length ?? 0) > 0)) out.push("restart-units");
  /*
   * Still derived from the document rather than asserted, even though every
   * manifest this build renders names a browser. The input is what makes it
   * honest: a manifest read back off a box may predate the stack, and it does
   * not retroactively require something its box was never given.
   */
  if ((manifest.browsers?.length ?? 0) > 0) out.push("browser-stack");
  /**
   * Only when the slot is not the one every hermeticd has always read. A
   * legacy row still renders `provider-key`, so it keeps applying on a box that
   * predates this field — which is the difference between a requirement and a
   * version bump.
   */
  if (
    manifest.provider_key_ref !== undefined &&
    manifest.provider_key_ref !== DEFAULT_PROVIDER_KEY_SLOT
  ) {
    out.push("provider-key-ref");
  }
  return out;
}
