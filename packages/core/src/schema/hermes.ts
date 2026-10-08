import { z } from "zod";
export {
  HERMES_ACCOUNT,
  HERMES_ACCOUNT_HOME,
  HERMES_HOME,
  HERMES_USER_PREFIX,
  HERMES_LAZY_TARGET,
  HERMES_AGENT_VENV,
  HERMES_USER_CONFIG,
  HERMES_USER_ENV,
  HERMES_MANAGED_CONFIG,
  HERMES_SEED_CONFIG,
  HERMES_PROVENANCE_PATH,
  HERMES_REVISION_ENV,
  HERMES_INSTALL_DIR,
  HERMES_BIN,
  HERMES_WEB_DIST_DIR,
  HERMES_TUI_DIR,
  hermesConfigGetArgv,
  hermesConfigSetArgv,
  HERMES_GATEWAY_UNIT,
  HERMES_DASHBOARD_UNIT,
  HERMES_LEGACY_DASHBOARD_UNIT,
  HERMES_DASHBOARD_PORT,
  HERMES_PROXY_PORT,
  HERMES_GATEWAY_DROPIN,
  HERMES_NOFILE_LIMIT,
} from "../shared/hermes.ts";

/**
 * What Hermes itself is configured with, as opposed to what hermetic builds
 * around it (§6.4).
 *
 * Upstream Hermes keeps config and data in one tree at `$HERMES_HOME` and reads
 * `config.yaml` there — it has no `--config` flag, and nothing else it ships is
 * a configuration surface. It also has a second, higher-precedence scope: a
 * **managed** directory (`$HERMES_MANAGED_DIR` if it is set and exists, else
 * `/etc/hermes` if it exists — `managed_scope.py` picks it purely by path and
 * asks nothing about ownership) whose `config.yaml` overrides the user's per
 * leaf key and which `hermes config set` refuses to touch. That split is
 * exactly hermetic's, so the two layers below map onto it directly:
 *
 * - **managed** — written to `/etc/hermes/config.yaml` on every apply, and
 *   authoritative. Always the provider wiring, because hermetic owns what
 *   stands behind it: the provider names the SSM slot the key comes from and
 *   the endpoint that key is valid against, and an operator who repointed that
 *   on the box would be sending hermetic's credential somewhere hermetic did
 *   not choose.
 * - **seeded** — written to the *user* scope (`$HERMES_HOME/config.yaml`) once,
 *   when that file does not exist, and never again. After first boot the
 *   operator owns it, and the agent's own dashboard can change it.
 *
 * Which of the two a given setting lands in is decided by whether the operator
 * ever stated it. `agent create` with no `--model` seeds the provider's default
 * and steps back — switching model in the dashboard is the most ordinary thing
 * an operator does, and a managed key cannot be switched at all. `agent create
 * --model X` means the opposite: they asked hermetic to hold the model, so
 * hermetic holds it, and `agent set --model Y` is what moves it. The rule is
 * one sentence — **hermetic manages what it was told to manage** — and it is
 * the only rule that makes both `agent set --model` and the dashboard's model
 * picker work without either lying about which one won.
 */

/**
 * Where the terminal tool's commands run. Upstream's default is `local`, which
 * on an agent box means "as the `hermes` user, on the box itself". `docker` puts
 * them in a container instead; the `hermes` user is already in the `docker`
 * group (`render.ts`), so both work without further provisioning.
 */
export const TerminalBackend = z.enum(["local", "docker"]);
export type TerminalBackend = z.infer<typeof TerminalBackend>;

/** How hard the model thinks by default, for the models that take the parameter. */
export const ReasoningEffort = z.enum(["low", "medium", "high"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffort>;

/**
 * Whether the agent asks a human before running a command it judges dangerous.
 *
 * Upstream's three modes: `smart` classifies each command with an auxiliary
 * model and prompts for the ones it does not like, `manual` prompts for
 * everything outside the `command_allowlist`, and `off` prompts for nothing.
 *
 * hermetic defaults to `off`, and the reason is the box rather than an appetite
 * for risk: there is nobody at this keyboard. A prompt on an unattended EC2
 * instance is not a safety mechanism, it is a hang — the command sits there
 * until the turn times out, or the auxiliary model denies it on the operator's
 * behalf and the agent is told no by something nobody consulted. `smart`
 * classifies every `sudo`, every `systemctl restart`, every `rm -r` and
 * `chown -R` and any write under `/etc/` as dangerous, which on an agent box
 * that administers itself is most of the interesting work. Paired with the full
 * sudoers grant (`render-system.ts`), leaving the mode at `smart` would be the
 * worst of both: the agent has root and cannot use it.
 *
 * `off` is not "no limits". Upstream's hardline blocklist — `rm -rf /`, `mkfs`
 * on the root device, fork bombs, the handful of things that are never a
 * legitimate instruction — is checked before the mode is even read, so it holds
 * in all three. Above that floor the limit is the instance (§7.1): one agent,
 * one instance, one data volume, zero inbound rules. An operator who wants the
 * prompts anyway sets this per agent or fleet-wide.
 */
export const ApprovalsMode = z.enum(["smart", "manual", "off"]);
export type ApprovalsMode = z.infer<typeof ApprovalsMode>;

/**
 * What an operator may say about Hermes. Every field is optional, and the
 * optionality carries meaning: a stated field is managed, an unstated one is
 * seeded from `HERMES_DEFAULTS` (see the module comment). Nothing here is
 * frozen onto the row unless it was stated, so a fleet default that moves in a
 * later hermetic release reaches every agent that never overrode it.
 *
 * The provider wiring has no fields here because none of it is an operator's
 * choice: it is a function of `provider` alone (`PROVIDERS` in `agent.ts`).
 */
export const HermesSettings = z.object({
  /**
   * The model id, spelled the way the *provider* spells it — `claude-sonnet-5`
   * on the Anthropic API, `anthropic/claude-sonnet-5` on an OpenRouter-shaped
   * gateway, a Bedrock inference-profile id on Bedrock. hermetic does not
   * translate between them: there is no cross-provider model registry that
   * would stay true, and a wrong guess is a 404 on the first message rather
   * than a validation error at create time.
   */
  model: z.string().min(1).max(200).optional(),
  terminal_backend: TerminalBackend.optional(),
  /** Hard ceiling on tool-calling turns in one agent run. */
  max_turns: z.number().int().min(1).max(10_000).optional(),
  reasoning_effort: ReasoningEffort.optional(),
  /**
   * Seed-only, unlike every other field here: stated or not, it lands in the
   * agent's own config and never in the managed one (`splitHermesSettings`).
   */
  approvals_mode: ApprovalsMode.optional(),
});
export type HermesSettings = z.infer<typeof HermesSettings>;

/**
 * The fleet's answers where an agent states none.
 *
 * `model` is deliberately absent: it is the one field with no fleet-wide
 * answer, because the right id depends on the provider. `defaultModel` in
 * `PROVIDERS` supplies it per provider instead.
 */
export const HERMES_DEFAULTS = {
  /**
   * `local`, matching upstream. A container per command is the safer posture
   * and the wrong default here: the whole box is already the blast radius — one
   * agent, one instance, one data volume — so containerising the terminal tool
   * buys isolation from nothing while costing a pull and a start on every
   * command. An operator who wants it says so.
   */
  terminal_backend: "local",
  /**
   * Deliberately *not* upstream's default, which is `agent.max_turns: null` —
   * unlimited — with a comment saying the cap "caused more problems than it
   * solved (silent mid-task truncation)". That is the right default for a
   * laptop, where the operator is watching and can stop a loop; it is the wrong
   * one for an unattended EC2 instance, where a runaway loop is a bill rather
   * than an inconvenience. 500 is high enough that reaching it means something
   * is wrong, not that the task was long.
   *
   * The truncation upstream warns about is real and this number does not make
   * it go away — it decides where it lands. Raise it per agent with
   * `agent set --max-turns`; `HermesSettings.max_turns` has no "unlimited"
   * spelling, so an agent that genuinely needs one is a schema change.
   */
  max_turns: 500,
  reasoning_effort: "medium",
  /**
   * `off`, and deliberately not upstream's `smart`. Nobody is at this keyboard:
   * an approval prompt here is a hung turn, not a second pair of eyes, and
   * `smart` would prompt on most of what an agent administering its own box
   * does. `ApprovalsMode` carries the whole argument, including what still
   * holds when this is `off`.
   */
  approvals_mode: "off",
} as const satisfies Required<Omit<HermesSettings, "model">>;

/**
 * Split an agent's stated settings into the two files that carry them.
 *
 * `managed` is what the operator stated, verbatim — it goes into the managed
 * scope and is rewritten on every apply. `seed` is the rest, filled from the
 * fleet defaults and the provider's `default_model` — it is written into the
 * user scope once and then belongs to whoever is driving the agent.
 *
 * Every key appears in exactly one of the two. That is what keeps the two files
 * from disagreeing: a seeded key an operator later edits on the box is not also
 * sitting in the managed file waiting to override the edit. Which of the two a
 * key lands in is "did the operator state it", with one exception the `SEED_ONLY`
 * set names — those keys are seeded whether stated or not.
 *
 * `seedDefaults` is the fleet's own answers as they stood when this agent was
 * created (`Agent.seed`, resolved by `resolveCreateDefaults`). It fills unstated
 * fields ahead of `defaultModel` and `HERMES_DEFAULTS`, and it can only ever
 * reach `seed`: a fleet default is not a per-agent instruction, so inheriting
 * one must never make hermetic *manage* a field the operator never named.
 */
/**
 * The keys that go to `seed` even when the operator stated them.
 *
 * `approvals_mode` is one because managing it would make it un-flippable on the
 * box in both directions at once. The managed scope wins over the user config,
 * so an agent or operator turning approvals on from the dashboard would be
 * overruled by a file they cannot edit — and `save_config` strips every managed
 * leaf before writing (`_strip_managed_keys_for_save`, `hermes_cli/config.py:2287`),
 * so the attempt would not even survive the session. That is exactly the trap
 * the `COMMAND_ALLOWLIST` comment describes, arriving by the same route.
 *
 * What the operator is stating here is a starting position, not a hold. The
 * value still reaches the box on every apply — `seedCommands` re-asserts it
 * when the stated answer changes — but between those changes the mode belongs
 * to whoever is driving the agent.
 *
 * With one exception, and it is a property of where the marker lives rather
 * than of this rule: `recreate` replaces the root volume the marker sits on
 * while keeping the data volume the agent's own config sits on, so a rebuilt
 * box comes back with the stated mode re-asserted over whatever the agent had
 * chosen. Deliberate — a recreate rebuilds to a known state, and a marker on
 * the data volume could not restore the stated default at all — and spelled
 * out in §6.4 so it is not discovered as a surprise.
 */
const SEED_ONLY = new Set<keyof HermesSettings>(["approvals_mode"]);

export function splitHermesSettings(
  settings: HermesSettings | null | undefined,
  defaultModel: string,
  seedDefaults?: HermesSettings | null | undefined,
): { managed: HermesSettings; seed: HermesSettings } {
  const stated = settings ?? {};
  const fleet = seedDefaults ?? {};
  const full: Required<HermesSettings> = {
    model: stated.model ?? fleet.model ?? defaultModel,
    terminal_backend:
      stated.terminal_backend ?? fleet.terminal_backend ?? HERMES_DEFAULTS.terminal_backend,
    max_turns: stated.max_turns ?? fleet.max_turns ?? HERMES_DEFAULTS.max_turns,
    reasoning_effort:
      stated.reasoning_effort ?? fleet.reasoning_effort ?? HERMES_DEFAULTS.reasoning_effort,
    approvals_mode: stated.approvals_mode ?? fleet.approvals_mode ?? HERMES_DEFAULTS.approvals_mode,
  };
  const managed: HermesSettings = {};
  const seed: HermesSettings = {};
  for (const key of Object.keys(full) as Array<keyof Required<HermesSettings>>) {
    const target = stated[key] === undefined || SEED_ONLY.has(key) ? seed : managed;
    // `as never` only because TypeScript cannot see that `full[key]` and the
    // target's `[key]` are the same union member for the same key.
    target[key] = full[key] as never;
  }
  return { managed, seed };
}
