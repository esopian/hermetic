/**
 * Hermes's own configuration, as hermetic renders it (§6.4): the managed
 * overlay, the seed the agent then owns, the image-provenance marker, and the
 * post-steps that install the seed without ever overwriting one. Final file
 * content, no templating — see `render.ts`.
 */
import {
  HERMES_DASHBOARD_UNIT,
  HERMES_GATEWAY_UNIT,
  HERMES_MANAGED_CONFIG,
  HERMES_NOFILE_LIMIT,
  HERMES_SEED_CONFIG,
  HERMES_USER_CONFIG,
  PROVIDERS,
  browserIdentities,
  hermesConfigGetArgv,
  hermesConfigSetArgv,
  splitHermesSettings,
} from "../schema/index.ts";
import { browserManagedConfigLines } from "./render-browser.ts";
import { HermeticError } from "../errors.ts";
import { COMMAND_ALLOWLIST } from "./render-system.ts";
import type { RenderInput } from "./render.ts";

/**
 * A double-quoted YAML scalar. Every string hermetic emits into a Hermes config
 * is quoted rather than bare: model ids carry `/` and `:` (`anthropic/claude-sonnet-5`,
 * `us.anthropic.claude-sonnet-4-5-20250929-v1:0`), and an unquoted `:` inside a
 * value is the classic way a YAML file parses into something nobody wrote.
 */
function yamlString(value: string): string {
  return '"' + yamlInner(value) + '"';
}

/** The escaped body of a double-quoted YAML scalar, without the quotes. */
function yamlInner(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * A single-quoted `/bin/sh` word. The one construction that needs it is the
 * seed guard's `hermes config set`, where a model id has to reach Hermes as
 * literal text: everything else on that line is this module's own literal, and
 * the id is the one part of it an operator chose.
 */
function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, `'\\''`) + "'";
}

/**
 * Where hermetic records the answers it has already asserted on this box.
 *
 * Root-owned and outside `$HERMES_HOME` on purpose: it is hermetic's record of
 * what it did, not part of the agent's configuration, and the agent editing it
 * would only make hermetic re-assert something on the next apply.
 */
const ASSERTED_DIR = "/etc/hermetic/asserted";

/** The last `approvals.mode` hermetic asserted; see `seedCommands`. */
const APPROVALS_MARKER = ASSERTED_DIR + "/approvals_mode";

/**
 * The marker that tells Hermes this box is an image it must not update itself.
 *
 * §6.5 makes the fleet manifest, not upstream `main`, the thing that decides
 * which Hermes a box runs, and until this file existed that was a convention
 * rather than a mechanism: `POST /api/hermes/update`
 * (`hermes_cli/web_routers/actions.py:218-248`) runs upstream's updater from
 * the dashboard every agent publishes over Serve, and the one switch that hides
 * it keys on container-ness (`web_server_files.py:97-121`) — no env var, no
 * config key.
 *
 * Upstream's own answer is this marker, and its docstring is addressed to
 * fleet builders: `/etc/hermes/image-provenance.json`, kept *"outside
 * `$HERMES_HOME` and the checkout, so a bind-mounted checkout cannot hide the
 * build fact and env/config cannot forge it"*
 * (`hermes_cli/image_provenance.py:1-6`, path `:16`, schema `:17`). Presence
 * makes `evaluate_update_admission` refuse with `image-marker`
 * (`hermes_cli/update_contract.py:39`), honoured by the CLI
 * (`main.py:2261`), by `hermes update --check` (`update_cmd.py:488`) and by the
 * dashboard route above. It fails closed: an unreadable or malformed marker
 * still means image-managed.
 *
 * Exactly the three required keys plus `version`, and no more. `schema` must be
 * a real int (upstream rejects `true`, `image_provenance.py:73-75`),
 * `deployment_kind` must be `image` (`:76`), `manager` must be non-empty
 * (`:77-79`); `image`/`version`/`revision` are optional strings (`:80-84`).
 * `version` is the ref the box is pinned to, which is the one fact an operator
 * reading the marker wants. Nothing derived goes in it — the content is a pure
 * function of the pin, so it cannot make `config_hash` move on its own.
 */
export function imageProvenance(input: RenderInput): string {
  return (
    JSON.stringify({
      schema: 1,
      deployment_kind: "image",
      manager: "hermetic",
      version: input.hermes_ref,
    }) + "\n"
  );
}

/**
 * The managed half: the provider wiring, and whichever settings the operator
 * explicitly asked hermetic to hold (`splitHermesSettings`).
 *
 * Three of the four providers are named to Hermes as themselves — it knows
 * `bedrock`, `anthropic` and `openrouter`, and finds their credentials in the
 * instance role or in `/run/hermetic/secrets.env` without further help. Nous is
 * the exception and the reason `hermes_provider_entry` exists: Hermes's
 * built-in `nous` is an OAuth device-code login that never looks at
 * `NOUS_API_KEY`, so the Portal is declared here as its own endpoint instead —
 * base URL plus the *name* of the environment variable the key arrives in.
 *
 * The name of the variable, never the value: `key_env` is the whole reason this
 * file can be world-readable and live on disk. The key itself stays on tmpfs in
 * `/run/hermetic/secrets.env`, which is `hermes-dashboard.service`'s `EnvironmentFile`
 * (§8.3). Nothing secret is rendered, so nothing secret can leak through a
 * config tarball, an S3 object version, or a `cat` in a support thread.
 */
export function hermesManagedConfig(input: RenderInput): string {
  const provider = PROVIDERS[input.provider];
  const { managed } = splitHermesSettings(input.hermes, provider.default_model, input.seed);

  const lines = [
    "# Rendered by hermetic for agent " + input.name + ". Final file, no templating.",
    "#",
    "# Hermes managed scope. Every key below overrides the same key in this",
    "# agent's own " + HERMES_USER_CONFIG + " and cannot be changed on the box:",
    "# `hermes config set` refuses a managed key. Change it with",
    "# `hermetic agent set " + input.name + " ...` and apply.",
    "model:",
    "  provider: " + yamlString(provider.hermes_provider),
  ];

  if (managed.model !== undefined) {
    lines.push("  default: " + yamlString(managed.model));
  }

  if (provider.hermes_provider_entry) {
    if (provider.base_url === null || provider.env === null) {
      throw new HermeticError(
        "INTERNAL",
        `provider ${input.provider} must be declared to Hermes but names no base URL or key variable`,
        { provider: input.provider },
      );
    }
    lines.push(
      "providers:",
      "  " + provider.hermes_provider + ":",
      "    base_url: " + yamlString(provider.base_url),
      // The variable's NAME. The value lives on tmpfs; see this function's note.
      "    key_env: " + yamlString(provider.env),
    );
  } else if (provider.auth === "role") {
    lines.push(
      "# Credentials come from the instance role; no API key exists on this box.",
      "# The region Bedrock is reached in is `AWS_REGION` in hermes-dashboard.service.",
    );
  } else {
    lines.push(
      "# " + provider.env + " comes from /run/hermetic/secrets.env, which hermeticd",
      "# writes at boot from this agent's SSM slot. The key is never rendered.",
    );
  }

  lines.push(
    // Managed, so `hermes config set updates.check true` cannot put it back.
    //
    // `hermes --version` is `print_fast_version_info(check_updates=True)`
    // (`hermes_cli/_startup_fast.py:130,170`), and hermeticd runs it twice per apply
    // as an idempotency probe. Without this key that is a call out to github.com
    // with a network timeout, a `.update_check` file written into `$HERMES_HOME`,
    // and a banner advertising the `hermes update` that
    // `/etc/hermes/image-provenance.json` exists to refuse. It used to be a
    // scoped `git fetch`; as of `v2026.9.14` a passive check never fetches at all
    // and polls GitHub's compare API for two tip shas instead
    // (`hermes_cli/banner.py:342-369`), which is upstream's own answer to the
    // fetch volume — cheaper, and still a network call on a box whose whole point
    // is that the manifest decides its version. `updates.check: false` is
    // upstream's opt-out: `check_for_updates` reads it and returns before the
    // probe whenever the call is passive (`hermes_cli/banner.py:384-389`).
    // `hermes update --check`, which nobody on this box runs, still works.
    //
    // The key itself is new at `v2026.9.14`: `config_defaults.py` has carried an
    // `updates` section for far longer, but its `check` leaf and the reader
    // above both arrived with this release. On the previous pin this line named
    // a key nothing read, so it is only now that it suppresses anything.
    "updates:",
    "  check: false",
  );

  /**
   * The browser keys are hermetic's, not the operator's: they are a function of
   * `browser: true` and of the units this same render emits, so they are not in
   * `HermesSettings` and there is no `agent set` that moves them. They are
   * managed for the ordinary reason — an agent that repointed `cdp_url` on the
   * box would be driving a browser hermetic does not run, on a display nobody
   * is watching.
   */
  lines.push(...browserManagedConfigLines(browserIdentities()));

  const agentKeys: string[] = [];
  if (managed.max_turns !== undefined) agentKeys.push("  max_turns: " + String(managed.max_turns));
  if (managed.reasoning_effort !== undefined) {
    agentKeys.push("  reasoning_effort: " + yamlString(managed.reasoning_effort));
  }
  if (agentKeys.length > 0) lines.push("agent:", ...agentKeys);

  if (managed.terminal_backend !== undefined) {
    lines.push("terminal:", "  backend: " + yamlString(managed.terminal_backend));
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * The seeded half: what a new agent starts with and its operator then owns.
 *
 * This file is not Hermes's config — it is the *content* of one, parked in
 * `/etc/hermes` so a post-step can install it at `$HERMES_HOME/config.yaml` if
 * and only if nothing is there yet (`seedCommands`). Rendering it on every apply
 * and installing it once is deliberate: the bytes stay a pure function of the
 * configuration, which is what keeps `config_hash` honest, while the box's own
 * copy stops being hermetic's business the moment it exists.
 *
 * The keys here are the ones an agent cannot sensibly boot without an answer
 * to. `model.default` above all: a provider with no model resolves and then has
 * nothing to send. The rest are upstream defaults restated on purpose, so that
 * what a hermetic agent does is a decision this repo made rather than whatever
 * the pinned release happens to default to.
 */
export function hermesSeedConfig(input: RenderInput): string {
  const provider = PROVIDERS[input.provider];
  const { seed } = splitHermesSettings(input.hermes, provider.default_model, input.seed);

  const lines = [
    "# Rendered by hermetic for agent " + input.name + ". Final file, no templating.",
    "#",
    "# Seeded into " + HERMES_USER_CONFIG + " on first boot, and only then.",
    "# Everything here is yours to change — from this agent's dashboard, or with",
    "# `hermes config set`. hermetic will not write it again.",
    "#",
    "# Keys hermetic holds instead live in " + HERMES_MANAGED_CONFIG + " and win",
    "# over anything set here.",
  ];

  if (seed.model !== undefined) {
    lines.push("model:", "  default: " + yamlString(seed.model));
  }

  const agentKeys: string[] = [];
  if (seed.max_turns !== undefined) agentKeys.push("  max_turns: " + String(seed.max_turns));
  if (seed.reasoning_effort !== undefined) {
    agentKeys.push("  reasoning_effort: " + yamlString(seed.reasoning_effort));
  }
  if (agentKeys.length > 0) lines.push("agent:", ...agentKeys);

  if (seed.terminal_backend !== undefined) {
    lines.push("terminal:", "  backend: " + yamlString(seed.terminal_backend));
  }

  if (seed.approvals_mode !== undefined) {
    // The other half of the sudoers grant (`sudoersGrant`): full root behind a
    // mode that treats every `sudo` as dangerous is still a wall, just one with
    // a prompt in front of it and nobody on this box to answer it.
    lines.push(
      "# Whether this agent asks before running a command it thinks is risky.",
      "# hermetic seeds `off` because nobody is at this keyboard: an approval",
      "# prompt here is a hung turn rather than a second pair of eyes. See",
      "# `ApprovalsMode` in hermetic for the rest of the argument, including the",
      "# blocklist that holds in every mode.",
      "#",
      "# Yours to change, from this agent's dashboard or with `hermes config",
      "# set approvals.mode`. hermetic writes it again only if the operator",
      "# changes the answer they stated.",
      "approvals:",
      "  mode: " + yamlString(seed.approvals_mode),
    );
  }

  lines.push(
    // `/data` is an ext4 EBS volume, so WAL is both safe and the faster choice;
    // stated rather than inherited because Hermes falls back to DELETE on its
    // own when it thinks the filesystem cannot take WAL, and a silent fallback
    // on a box nobody is watching is worth being able to rule out.
    "database:",
    '  journal_mode: "wal"',
    // Matched to `LimitNOFILE` in hermes-dashboard.service. Hermes raises its own soft
    // limit toward this number at start; systemd's hard limit is the ceiling it
    // is raising against, so the two disagreeing means one of them is decorative.
    "runtime:",
    "  nofile_soft_limit: " + String(HERMES_NOFILE_LIMIT),
    // Seeded rather than managed: a managed list cannot be added to, and
    // upstream persists every "always approve" answer by rewriting this whole
    // key — which `save_config` then strips. See `COMMAND_ALLOWLIST`.
    "# Commands approved once, for every session. At the `approvals.mode`",
    "# hermetic seeds nothing here is consulted at all — this list is for the",
    "# operator who sets the mode to `smart` or `manual`, where it is the",
    "# difference between installing a package and waiting on a prompt nobody",
    "# is there to give.",
    "#",
    "# The list is no longer what the sudoers drop-in grants: that file now",
    "# grants everything, and a list of every command is not a list. These four",
    "# are apt-get and apt spelled both ways round — with and without `sudo` —",
    "# because a model will write either, and they are what an agent reaches for",
    "# first on a box where approvals are being asked for at all.",
    "#",
    "# Yours to extend: answering `always` to an approval adds to this list, and",
    "# hermetic will not write it again. What the agent may do as root is the",
    "# sudoers drop-in's business, not this list's.",
    "command_allowlist:",
    ...COMMAND_ALLOWLIST.map((pattern) => "  - " + yamlString(pattern)),
    "",
  );
  return lines.join("\n");
}

/**
 * Give the agent a config of its own, without ever overwriting one.
 *
 * Two steps, because there are two ways to arrive without a usable one and only
 * the first is a fresh box:
 *
 * 1. **No config at all** — install the seed whole. This is first boot.
 * 2. **A config with no model** — Hermes writes itself a `config.yaml` the
 *    first time it starts, so on a box that has already run, step 1 finds a
 *    file and stands down; if that file names no model, the agent resolves a
 *    provider and then has nothing to send it. Setting the one missing leaf
 *    fixes exactly that and touches nothing else.
 *
 * Step 2 asks Hermes what it resolves, rather than grepping the file. The
 * question is about a leaf and a grep can only see a block: a user config
 * holding `model:` with a `provider:` under it and no `default:` — exactly what
 * `hermes config set model.provider` writes (`hermes_cli/config.py:3462-3474`)
 * — satisfies `grep -qE '^model:'`, so hermetic stands down and the agent boots
 * with a provider and nothing to send it. That is the precise failure this step
 * exists to prevent, arriving by the one route the regex cannot see. It is also
 * narrow and permanent: only a pre-existing user config, i.e. a reattached data
 * volume, can be in that shape. `hermes config get model.default --json`
 * answers the leaf question and resolves through the managed overlay and the
 * `model`/`name` aliases as well (`hermesConfigGetArgv`).
 *
 * Step 2 *writes* through `hermes config set model.default` rather than
 * appending YAML, for the same reason it *reads* through `hermes config get`:
 * the file belongs to the agent and only Hermes knows what is already in it.
 * An appended second top-level `model:` block parses — `yaml.safe_load`
 * (`hermes_cli/config.py:24`) takes the last duplicate key and drops the first
 * — so it would silently discard a `model:` mapping the operator already had,
 * and the next `_write_user_config` would dump the collapsed document back over
 * the file for good. `model: {provider: …}` with no `default:` is precisely the
 * shape this step exists for (`hermes config set model.provider` writes it,
 * `config.py:3462-3474`), which means the append would destroy the very
 * configuration it was called to repair. `config set` writes the addressed leaf
 * into the raw user config and leaves every sibling standing
 * (`set_config_value`, `config.py:3452-3474`).
 *
 * No sentinel comment any more, and none is needed: `config set` rewrites the
 * file rather than appending to it, so the `config get` probe *is* the
 * idempotence check — once the leaf resolves, the second half never runs again.
 * A `hermes` broken enough that neither the get nor the set works fails this
 * command, which is the honest outcome: the boot assertion that asserts the
 * same leaf (`hermes-check.ts`) would fail on that box moments later anyway,
 * and a post-step that reported success would only move the report.
 *
 * Step 2 runs only when hermetic is not managing the model itself; when the
 * operator stated one, the managed config carries it and the agent's own file
 * is not involved.
 *
 * `try-restart` rather than `restart` throughout: this list also runs on a box
 * where `hermes-dashboard.service` is deliberately stopped, and a post-step is not the
 * place to overrule that. Both steps are idempotent, which is the §6.4 contract
 * for `commands` — they run on every apply and do nothing on all but the first.
 */
export function seedCommands(input: RenderInput): string[] {
  const { seed } = splitHermesSettings(
    input.hermes,
    PROVIDERS[input.provider].default_model,
    input.seed,
  );
  // Both units, in one `try-restart`: the seed is the agent's own config and
  // the gateway reads it exactly as the dashboard does.
  const restartBoth = `systemctl try-restart ${HERMES_DASHBOARD_UNIT} ${HERMES_GATEWAY_UNIT}`;
  const commands = [
    `test -e ${HERMES_USER_CONFIG} || { ` +
      `install -o hermes -g hermes -m 0640 ${HERMES_SEED_CONFIG} ${HERMES_USER_CONFIG} && ` +
      `${restartBoth}; }`,
  ];
  if (seed.model !== undefined) {
    // Stdout and stderr both discarded: the exit code is the whole answer, and
    // an unset key prints its notice to stderr (`hermesConfigGetArgv`).
    const resolves = `${hermesConfigGetArgv("model.default").join(" ")} >/dev/null 2>&1`;
    /**
     * The value is shell-quoted going in, because this argv is joined into a
     * `/bin/sh` command line rather than exec'd: a Bedrock id carries a `:`,
     * and a model id is the one part of this line hermetic did not write. It
     * needs no YAML quoting — `config set` takes a string and writes the YAML
     * itself — which is why `yamlInner` is not in the path any more.
     */
    const sets = hermesConfigSetArgv("model.default", shellQuote(seed.model)).join(" ");
    // Its "✓ Set …" goes nowhere; a failure's message is left on stderr, where
    // the apply's COMMAND_FAILED will carry it.
    commands.push(`${resolves} || { ${sets} >/dev/null && ${restartBoth}; }`);
  }
  if (seed.approvals_mode !== undefined) {
    /**
     * A marker file rather than a `config get` probe like the model's.
     *
     * The probe above works because an unset `model.default` resolves to
     * nothing: the absence is the question. `approvals.mode` has an upstream
     * default (`hermes_cli/config_defaults.py`), so `config get` always answers
     * something and a probe could never tell "the operator asked for `off`"
     * from "upstream's `smart` is showing through" — on an existing box it
     * would resolve, hermetic would stand down, and the answer would never be
     * set. The marker records what *hermetic* asserted, which is the only
     * question this command can usefully ask.
     *
     * And it is asserted on change, not on every apply. Every apply would mean
     * hermetic silently overwriting an agent that turned approvals on for
     * itself: the operator stated a starting position, not a hold
     * (`SEED_ONLY`, `schema/hermes.ts`). Between changes the key is the box's.
     *
     * The value needs no shell quoting of its own — `ApprovalsMode` is a closed
     * enum of three lowercase words, so there is nothing in it for `/bin/sh` to
     * find — but the `config set` argv goes through `shellQuote` anyway,
     * because that is the one call whose value is joined into a command line
     * and the rule there should not depend on today's enum.
     *
     * Idempotent, which is the §6.4 contract for `commands`: after the first
     * run the marker matches and the whole right-hand side is skipped. The set
     * runs as `hermes` (`hermesConfigSetArgv`), so the user config stays
     * hermes-owned; `install -d` before the write because `/etc/hermetic` is
     * hermeticd's own directory and need not exist on an older box.
     *
     * **The marker is written last, after the restart, and the order is the
     * whole point.** hermeticd runs this through `/bin/sh -c` without `set -e`
     * and fails the apply on a non-zero exit (`apply/index.ts`), so every step
     * here is a step that can fail. Writing the marker before the restart would
     * record "hermetic asserted this" while the running units were still on the
     * old config: the apply would fail, and the retry — which is how an
     * operator recovers — would find the marker matching, skip the whole
     * right-hand side, and leave both units serving the previous mode with
     * nothing left to say so. Ordering it last costs a repeated `config set`
     * and at worst one extra bounce on a retry, both of which are harmless
     * precisely because the steps before the marker are idempotent.
     */
    const mode = seed.approvals_mode;
    const sets = hermesConfigSetArgv("approvals.mode", shellQuote(mode)).join(" ");
    commands.push(
      `test "$(cat ${APPROVALS_MARKER} 2>/dev/null)" = "${mode}" || { ` +
        `${sets} >/dev/null && ` +
        `${restartBoth} && ` +
        `install -d -m 0755 ${ASSERTED_DIR} && ` +
        `printf '%s' '${mode}' > ${APPROVALS_MARKER}; }`,
    );
  }
  return commands;
}
