/**
 * What a Settings form has actually changed, and what may be done to a slot.
 *
 * Pure and React-free, for the same reason `volume-logic.ts` is: the rules here
 * are the ones that decide what crosses the wire on a **fleet-wide** write, and
 * they are worth testing without a renderer. The sections keep the form state;
 * this module keeps the answers to "is this dirty", "what exactly changed" and
 * "may this be deleted".
 *
 * Every field is held as a string, including the numeric ones. An `<input>`
 * gives strings, "" is the only honest spelling of "the operator cleared this",
 * and parsing at the edge means a half-typed number is a *disabled save* rather
 * than a `NaN` on the fleet's item.
 */
import type { SettingsSetInput } from "../api/index.ts";

/* ── the shapes the schemas admit, read back off the request types ───────── */

type DefaultsPatch = NonNullable<SettingsSetInput["defaults"]>;
type AgentDefaultsPatch = NonNullable<NonNullable<SettingsSetInput["agent_defaults"]>>;

export type SecretsMode = NonNullable<DefaultsPatch["secrets"]>;
export type TerminalBackend = NonNullable<AgentDefaultsPatch["terminal_backend"]>;
export type ReasoningEffort = NonNullable<AgentDefaultsPatch["reasoning_effort"]>;
export type ApprovalsMode = NonNullable<AgentDefaultsPatch["approvals_mode"]>;

/** §6.4's three enums, mirrored as literals — the UI may not import core (§3.1). */
export const TERMINAL_BACKENDS = ["local", "docker"] as const satisfies readonly TerminalBackend[];
export const REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
] as const satisfies readonly ReasoningEffort[];
export const APPROVALS_MODES = ["smart", "manual", "off"] as const satisfies readonly ApprovalsMode[];
export const SECRETS_MODES = ["none", "bitwarden"] as const satisfies readonly SecretsMode[];

/** §6.1's slug shape, restated: it is concatenated into an SSM path server-side. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

/* ── fleet defaults ──────────────────────────────────────────────────────── */

/**
 * The Fleet-defaults form, flattened: `_fleet.defaults` and the fleet-wide
 * `HermesSettings` in one record, because they are one save bar.
 *
 * No size, data volume or system disk. Those are this laptop's create presets
 * now (Settings › Create presets, §4.6): two places setting the same thing
 * would conflict, so the page neither shows nor sends them. The fleet's stored
 * values stay in core untouched — a patch that omits a key leaves it alone.
 *
 * "" means *unstated* for the Hermes fields — an agent that inherits nothing
 * there falls back to this build's own defaults (§6.4), which is a different
 * thing from inheriting a value the fleet chose.
 */
export interface DefaultsForm {
  secrets: SecretsMode;
  model: string;
  terminal_backend: TerminalBackend | "";
  max_turns: string;
  reasoning_effort: ReasoningEffort | "";
  /**
   * The fleet's starting answer for approvals. Seeded on every agent it
   * reaches rather than managed (§6.4), so this is where a new agent begins
   * and not a setting hermetic holds against the box.
   */
  approvals_mode: ApprovalsMode | "";
}

function positiveInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "" || !/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Why Save is disabled, or `null` when it is not. A message rather than a
 * boolean: "volume must be a positive whole number of GiB" is the only thing on
 * screen that tells an operator what to fix.
 */
export function defaultsIssue(form: DefaultsForm): string | null {
  const turns = form.max_turns.trim();
  if (turns !== "") {
    const n = positiveInt(turns);
    if (n === null || n > 10_000) return "max turns: a whole number between 1 and 10000";
  }
  // Core caps the model id at 200 (`HermesSettings.model`). Said here so an
  // over-long paste is a disabled Save rather than a 400 after the round trip.
  if (form.model.trim().length > 200) return "model: at most 200 characters";
  return null;
}

/**
 * The Hermes fields as they would be written, or `null` for "clear all of it".
 *
 * `settings.set` merges `agent_defaults` key by key, so a blanked field is
 * stated as an explicit `null` — "clear this one key" — rather than omitted,
 * which would now mean "leave it alone". The form holds every Hermes field, so
 * it is entitled to speak for every one of them; when none is stated at all,
 * the whole object is cleared with a single `null`.
 */
export function agentDefaultsOf(form: DefaultsForm): AgentDefaultsPatch | null {
  const model = form.model.trim();
  const turns = positiveInt(form.max_turns);
  const out: AgentDefaultsPatch = {
    model: model === "" ? null : model,
    terminal_backend: form.terminal_backend === "" ? null : form.terminal_backend,
    max_turns: turns,
    reasoning_effort: form.reasoning_effort === "" ? null : form.reasoning_effort,
    approvals_mode: form.approvals_mode === "" ? null : form.approvals_mode,
  };
  const stated = Object.values(out).some((v) => v !== null);
  return stated ? out : null;
}

function sameAgentDefaults(a: AgentDefaultsPatch | null, b: AgentDefaultsPatch | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.model === b.model &&
    a.terminal_backend === b.terminal_backend &&
    a.max_turns === b.max_turns &&
    a.reasoning_effort === b.reasoning_effort &&
    a.approvals_mode === b.approvals_mode
  );
}

/**
 * The `PATCH /api/settings` body for what changed, or `null` when nothing did.
 *
 * Only changed keys ride along: `settings.set` is a patch, and a form that
 * re-sends every field would make one operator's stale render overwrite
 * another's write of a field they never looked at. `agent_defaults` is sent
 * whole whenever any Hermes field changed, because this form holds all five of
 * them: core merges it key by key, a blanked field rides as an explicit `null`
 * that clears that key, and `agent_defaults: null` clears them all.
 *
 * `expectedVersion` is the version the form was *loaded* from: `null` says "no
 * settings object existed", which is a fact the store checks, not a "don't
 * care". Omit the argument only where there is no version to speak of.
 */
export function dirtyDefaults(
  loaded: DefaultsForm,
  form: DefaultsForm,
  expectedVersion?: number | null,
): SettingsSetInput | null {
  const defaults: DefaultsPatch = {};
  if (form.secrets !== loaded.secrets) defaults.secrets = form.secrets;

  const next = agentDefaultsOf(form);
  const prev = agentDefaultsOf(loaded);
  const hermesChanged = !sameAgentDefaults(prev, next);

  if (Object.keys(defaults).length === 0 && !hermesChanged) return null;

  const patch: SettingsSetInput = {};
  if (Object.keys(defaults).length > 0) patch.defaults = defaults;
  if (hermesChanged) patch.agent_defaults = next;
  if (expectedVersion !== undefined) patch.expected_version = expectedVersion;
  return patch;
}

/**
 * The fields an operator has touched, in form order — what the save bar counts
 * and names, and which rows get the "changed" edge.
 *
 * Compared as typed (trimmed) rather than as parsed: a volume of `abc` is a
 * staged edit the bar has to own up to even though it will never parse, and
 * `defaultsIssue` is what then says why Save is disabled.
 */
export function changedDefaults(loaded: DefaultsForm, form: DefaultsForm): (keyof DefaultsForm)[] {
  const keys: (keyof DefaultsForm)[] = [
    "secrets",
    "model",
    "terminal_backend",
    "max_turns",
    "reasoning_effort",
    "approvals_mode",
  ];
  return keys.filter((k) => String(form[k]).trim() !== String(loaded[k]).trim());
}

/* ── shared secret slots ─────────────────────────────────────────────────── */

/**
 * The three states a slot can be in, as `secrets ls` reports them. Structural
 * rather than the `SharedSecretView` type, so a test can name a row in one
 * literal and a later field on the view does not break this signature.
 */
export interface SecretRow {
  slug: string;
  exists: boolean;
  placeholder: boolean;
  used_by: readonly string[];
  orphan?: boolean;
  /**
   * §8.3: the provider profile whose credential this slot *is*. Such a slot is
   * not an operator's to delete from here — it goes with its profile — so the
   * owner is both the reason Delete is refused and the link to where it is
   * managed.
   */
  owner?: { profile: string; name: string };
}

export type SecretState = "set" | "empty" | "orphan";

/**
 * `orphan` wins over the other two: a parameter no settings entry describes is
 * a secret nobody is naming, and that is the fact worth acting on. A
 * placeholder counts as `empty` — `ensureSlot` writes one so the path exists,
 * and a declared slot with nothing in it must not read as a key the fleet has.
 */
export function secretState(row: SecretRow): SecretState {
  if (row.orphan === true) return "orphan";
  if (!row.exists || row.placeholder) return "empty";
  return "set";
}

/**
 * §8.2's refusal, said before the request rather than after it: deleting a slug
 * a provider still names would leave the next `agent create` silently falling
 * back to a prompt. The server refuses this too (`CONFLICT`); this is the
 * button being honest first.
 */
export function canDeleteSecret(row: SecretRow): { ok: boolean; reason?: string } {
  if (row.owner !== undefined) {
    return {
      ok: false,
      reason: `owned by the provider profile ${row.owner.name}; delete the profile in Providers instead`,
    };
  }
  if (row.used_by.length > 0) {
    return {
      ok: false,
      reason: `still named by ${row.used_by.join(", ")}; clear it in Providers first`,
    };
  }
  return { ok: true };
}

/** What a shared-secret push's receipt (§8.2) resolved to on re-key. */
export interface RekeyReceipt {
  /** How many running agents on this slot were re-copied into. */
  rekeyed: number;
  /** Whether "Re-key running agents" was ticked for this push at all. */
  rekeyRequested: boolean;
}

/**
 * The rotate receipt has three distinct outcomes, not two: a plain push never
 * touches a running agent, so it always says so; a re-key that matched
 * something says how many and that each takes it on its next `recreate`; and
 * a re-key that matched *nothing* is not the same as not asking — an operator
 * who ticked the box and got a silent "future creates get this value" would
 * reasonably read that as the tick having done nothing, when in fact no agent
 * was on the slot to begin with.
 */
export function rekeyReceiptMessage(receipt: RekeyReceipt): string {
  if (!receipt.rekeyRequested) {
    return "future creates get this value; agents already running keep the copy they were built with";
  }
  if (receipt.rekeyed === 0) {
    return "re-key requested — no running agent uses this slot; future creates get the value";
  }
  return `rekeyed ${String(receipt.rekeyed)} agent${receipt.rekeyed === 1 ? "" : "s"} · each takes it on its next recreate`;
}

/* ── failures ────────────────────────────────────────────────────────────── */

export interface SaveError {
  code: string;
  message: string;
}

/**
 * Any thrown thing as the pair the save bar renders. Structural on purpose: it
 * is `ApiError`'s `code` that matters (a `CONFLICT` is a different sentence
 * from a failure), and reading it by shape keeps this module free of a runtime
 * import of the client.
 */
export function toSaveError(e: unknown): SaveError {
  const message = e instanceof Error ? e.message : String(e);
  if (typeof e === "object" && e !== null && "code" in e) {
    const code = (e as { code: unknown }).code;
    if (typeof code === "string" && code !== "") return { code, message };
  }
  return { code: "ERROR", message };
}

/** A settings write that lost a race: somebody else wrote between load and save. */
export function isConflict(error: SaveError | null): boolean {
  return error !== null && error.code === "CONFLICT";
}

/** A save error, tagged with the version it was raised against. */
export interface RaisedSaveError {
  /** The `expected_version` this save attempt sent — null if nothing was persisted yet. */
  at: number | null;
  error: SaveError;
}

/**
 * A raised save error — a `CONFLICT` above all — is stale the moment fresher
 * settings land, whether that is this section's own successful Reload or
 * another section's save moving `settings.version` out from under it. It is
 * not cleared with a `setError(null)`: a form that re-seeds from new data
 * naturally leaves the version an old error was raised against behind, so the
 * error simply stops being the *active* one rather than needing an effect to
 * notice the change and reach back to clear it. A Reload's own failure lives
 * in its own `reloadError` and is unaffected by this.
 */
export function activeSaveError(
  raised: RaisedSaveError | null,
  expected: number | null,
): SaveError | null {
  if (raised === null) return null;
  return raised.at === expected ? raised.error : null;
}

/* ── one settings document, held by the shell ────────────────────────────── */

/**
 * The shape every section needs of `settings.get`'s answer, and nothing more.
 * Structural so this module stays free of the route types.
 */
export interface VersionedSettings {
  persisted: boolean;
  settings: { version: number };
}

/**
 * Which of two settings documents the shell should keep.
 *
 * Every section writes through the *same* held document, because they write to
 * the same item: saving in Fleet defaults bumps `settings.version`, and a
 * Providers row that still remembered the version its own page loaded with
 * would then `CONFLICT` against nobody but this laptop. So a save hands its
 * response back up, and this decides.
 *
 * It is a `max`, not a replacement, because two saves can be in flight and
 * responses can land out of order: taking the older one would put the shell
 * back on a version the server has already moved past, and the next save would
 * then genuinely lose a race it had already won. The first persisted write
 * always wins over a synthesized document, whatever its number — "nobody has
 * written this" is not version 1, it is *no* version.
 */
export function nextSettings<T extends VersionedSettings>(current: T | null, saved: T): T {
  if (current === null) return saved;
  if (current.persisted !== saved.persisted) return saved.persisted ? saved : current;
  return saved.settings.version >= current.settings.version ? saved : current;
}
