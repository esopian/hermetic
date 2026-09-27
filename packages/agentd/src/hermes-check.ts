/**
 * The check behind `hermeticd stage verify-hermes` — the last stage's answer to
 * "is this agent actually usable?", as opposed to "did systemd start it?".
 *
 * It exists because those two turned out to be different questions. An agent
 * could pass every check `06-verify` had — volume mounted, node on the tailnet,
 * `hermes-dashboard.service` active, dashboard answering over Serve — and then fail the
 * operator's first message with `No inference provider configured`, because
 * nothing had ever written Hermes a config naming a provider or a model. Every
 * signal said healthy; the one thing an agent is for did not work.
 *
 * Six things on an agent with no browser, eight on one with, in two groups.
 * Two of the eight are conditional on what the manifest says rather than on
 * what the box is: `approvals` is skipped by a manifest rendered before that
 * field existed, and the two browser checks by one that names no browsers.
 *
 * These are read offline, from what hermetic itself wrote:
 *
 *   1. the managed config exists and names a provider;
 *   2. the agent has a model to send to it;
 *   3. a keyed provider's key actually arrived on the box;
 *   4. nothing in the agent's own `.env` shadows that key;
 *   5. on a browser agent, nothing there shadows the managed `browser.cdp_url`
 *      either (`cdp_override`, advisory — see below).
 *
 * The rest ask Hermes: `hermes config get model.default --json`, the same for
 * `approvals.mode` when the manifest states one, and on a browser agent
 * `browser.cdp_url` too. Those are the probes that see Hermes's own
 * *resolution* rather than hermetic's output.
 *
 * `cdp_override` and `approvals` are `advisory`: they are findings the operator
 * should see and not verdicts that fail a boot (`HermesCheck.advisory`). Both
 * report a value the agent or the operator may have changed on the box on
 * purpose, through a seam hermetic deliberately left open.
 *
 * Why both. Upstream's `hermes doctor` looks like it should cover this and
 * cannot: `_validate_model_config` reads `read_user_config_raw`
 * (`hermes_cli/doctor_config.py:216`), not `load_config()`, so on a hermetic box
 * — where `model.provider` lives only in `/etc/hermes/config.yaml` —
 * `provider_raw` is empty, every provider/model/credential branch is skipped,
 * and doctor reports nothing at all about the configuration hermetic installed.
 * Its only managed-scope awareness is a key count (`doctor_config.py:98-110`).
 * Nor is doctor a verdict: `run_doctor` returns `None` and exits 0 whatever it
 * finds (`hermes_cli/doctor.py:163-184`), with no `--json`
 * (`hermes_cli/subcommands/doctor.py:9-25`), and `hermes model` is
 * `_require_tty`-gated (`hermes_cli/main.py:1834`). So the four offline checks
 * stay, and `config get` is added as the narrowest possible question with an
 * exit code for an answer — this is not a doctor wrapper.
 *
 * What it still cannot do is tell a valid key from an invalid one: that needs
 * the provider. A wrong key reaches the operator as a failed first message; a
 * missing, or a shadowed, one no longer does.
 */
import type { AgentConfig } from "@hermetic/core/schema";
import {
  HERMES_MANAGED_CONFIG,
  HERMES_USER_CONFIG,
  HERMES_USER_ENV,
  PROVIDERS,
  hermesConfigGetArgv,
  providerNeedsKey,
} from "@hermetic/core/shared";
import type { Host } from "./host.ts";
import { AgentdError } from "./errors.ts";
import { SECRETS_ENV_PATH } from "./apply/index.ts";

/** One thing that was checked, and what it turned out to be. */
export interface HermesCheck {
  readonly name: string;
  readonly ok: boolean;
  /** Safe to print: never a secret, only whether one is there. */
  readonly detail: string;
  /**
   * A finding, not a verdict: `verify-hermes` prints it and does not fail the
   * boot on it (`main.ts`).
   *
   * Two things belong here. One is a state an operator may have chosen on
   * purpose — upstream's `/browser connect` writes `BROWSER_CDP_URL` into the
   * agent's `.env`, and an agent pointed at a browser somebody else runs is
   * still a working agent. The other is a check that rests on upstream
   * behaviour hermetic has not yet observed on a live box: being wrong about
   * an exit code must cost a warning, not every browser agent's first boot.
   *
   * Optional and never `false`, so a check that says nothing about this is a
   * verdict, which is the right default.
   */
  readonly advisory?: true;
}

/**
 * Does this YAML name `key` under `section`, at the one nesting depth hermetic
 * renders?
 *
 * A regex and not a YAML parser, on purpose. The files being read are the ones
 * `render.ts` wrote — two levels deep, one key per line, every value quoted —
 * so a parser would buy nothing here except a dependency in the one package
 * that must stay small enough to compile into a single binary. The user config
 * is the exception: an operator may have reshaped it since first boot, which is
 * why a miss there is reported rather than thrown (see `checkHermes`).
 */
function namesKey(yaml: string, section: string, key: string): boolean {
  const lines = yaml.split("\n");
  let inSection = false;
  for (const line of lines) {
    if (/^\S/.test(line)) inSection = line.startsWith(section + ":");
    else if (inSection && new RegExp(`^\\s+${key}\\s*:\\s*\\S`).test(line)) return true;
  }
  return false;
}

/**
 * How long Hermes gets to answer the resolution probe.
 *
 * `06-verify` runs under the same untimed systemd oneshot as every other stage
 * (§4.2), so a `hermes` that wedges — a hung import, a provider SDK reaching
 * out at module scope — would hang the boot rather than fail it. Same reasoning
 * and same instrument as `apply.ts`'s network steps: bound it with `timeout(1)`.
 * A minute is far beyond what reading two config files should take, so hitting
 * this is itself the finding.
 */
export const HERMES_PROBE_TIMEOUT_S = "60";

/** The resolution probe as it is actually run: upstream's argv, bounded. */
export function hermesProbeArgv(key: string): string[] {
  return ["timeout", HERMES_PROBE_TIMEOUT_S, ...hermesConfigGetArgv(key)];
}

/** Is `name` set to something non-empty in an `EnvironmentFile`-shaped file? */
function envHasValue(env: string, name: string): boolean {
  let found: string | null = null;
  for (const line of env.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0 || line.slice(0, eq).trim() !== name) continue;
    // systemd applies assignments in order, so the last one wins. Keep
    // scanning rather than letting an earlier empty/default value decide what
    // the service receives.
    found = line.slice(eq + 1).trim();
  }
  // The value only ever leaves this function as a boolean.
  return found !== null && found.length > 0;
}

/**
 * Is `name` assigned at all in an `EnvironmentFile`- or dotenv-shaped file?
 *
 * Weaker than `envHasValue` on purpose, and the right question for the shadow
 * check: upstream loads the user `.env` with `override=True`
 * (`hermes_cli/env_loader.py:362-365`), so even an empty assignment lands in
 * `os.environ`, where the providers that read the environment directly will see
 * it. `export FOO=…` counts — python-dotenv accepts the prefix.
 */
function envDefines(env: string, name: string): boolean {
  for (const line of env.split("\n")) {
    if (/^\s*#/.test(line)) continue;
    const assigned = /^\s*(?:export\s+)?([^=\s]+)\s*=/.exec(line)?.[1];
    if (assigned === name) return true;
  }
  return false;
}

/**
 * The probe's result, including the case where it could not be run at all.
 *
 * `host.exec` resolves with a non-zero code for a command that ran and failed,
 * but *rejects* when the binary is not there: spawning `/usr/local/bin/hermes`
 * on a box where the install step did not get that far is an ENOENT, not an
 * exit status. Letting that reject out of `checkHermes` would break the
 * contract below — the whole point of which is that a misconfigured agent is
 * reported check by check — and turn the clearest possible finding ("Hermes is
 * not installed") into an unclassified stage crash. So it is caught and becomes
 * the failed check it always described.
 */
async function runProbe(
  host: Host,
  argv: readonly string[],
): Promise<{ code: number; stdout: string; threw: string | null }> {
  try {
    const res = await host.exec(argv);
    return { code: res.code, stdout: res.stdout, threw: null };
  } catch (e) {
    return { code: -1, stdout: "", threw: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Run the checks and return what each found. Throws only if the manifest
 * names a provider this build has never heard of — everything else is a result,
 * so the caller can report every failure at once rather than the first.
 */
export async function checkHermes(host: Host, manifest: AgentConfig): Promise<HermesCheck[]> {
  const spec = PROVIDERS[manifest.provider];
  if (!spec) {
    throw new AgentdError("INTERNAL", `unknown provider in manifest: ${manifest.provider}`, {
      provider: manifest.provider,
    });
  }

  const managed = (await host.readFile(HERMES_MANAGED_CONFIG)) ?? "";
  const user = (await host.readFile(HERMES_USER_CONFIG)) ?? "";
  const browsers = manifest.browsers ?? [];
  const checks: HermesCheck[] = [];

  checks.push({
    name: "provider",
    ok: namesKey(managed, "model", "provider"),
    detail: namesKey(managed, "model", "provider")
      ? `${HERMES_MANAGED_CONFIG} names provider ${spec.hermes_provider}`
      : `${HERMES_MANAGED_CONFIG} names no model.provider`,
  });

  /**
   * Either file may carry the model, and which one does is not this stage's
   * business: hermetic manages the model when the operator named one and seeds
   * it otherwise, and both spellings are correct (`splitHermesSettings`). What
   * would not be correct is neither.
   */
  const hasModel = namesKey(managed, "model", "default") || namesKey(user, "model", "default");
  checks.push({
    name: "model",
    ok: hasModel,
    detail: hasModel
      ? `a model is named in ${namesKey(managed, "model", "default") ? HERMES_MANAGED_CONFIG : HERMES_USER_CONFIG}`
      : `neither ${HERMES_MANAGED_CONFIG} nor ${HERMES_USER_CONFIG} names model.default`,
  });

  if (providerNeedsKey(manifest.provider) && spec.env !== null) {
    const env = (await host.readFile(SECRETS_ENV_PATH)) ?? "";
    const present = envHasValue(env, spec.env);
    checks.push({
      name: "key",
      ok: present,
      detail: present
        ? `${spec.env} is set in ${SECRETS_ENV_PATH}`
        : `${spec.env} is missing or empty in ${SECRETS_ENV_PATH}` +
          ` — push it with \`hermetic secrets push ${manifest.name} --provider-key\``,
    });
  } else {
    checks.push({
      name: "key",
      ok: true,
      detail: `${manifest.provider} authenticates as the instance; no key is expected on this box`,
    });
  }

  /**
   * The key hermetic delivered has to be the key Hermes uses, and an
   * `EnvironmentFile` does not guarantee that.
   *
   * Upstream's user `.env` is loaded with `override=True` into `os.environ`
   * (`hermes_cli/env_loader.py:362-365`), and the api-key path prefers it over
   * the environment on top of that (`get_env_value_prefer_dotenv`,
   * `hermes_cli/config.py:2698-2701`; `get_anthropic_key`,
   * `hermes_cli/auth.py:293-303`). So a key written there by `hermes setup`, by
   * the dashboard's key field or by the agent itself silently and permanently
   * outranks the one hermetic pushed from SSM, and `hermetic secrets push
   * --provider-key` becomes a no-op with no signal on either side.
   *
   * hermetic cannot answer that by writing a higher-precedence channel: the one
   * that wins outright is the managed `/etc/hermes/.env`, which upstream
   * documents as 0644 world-readable and not for secrets
   * (`website/docs/user-guide/managed-scope.md:141-143`). Nor may it delete the
   * agent's `.env`: after first boot that file is the agent's own (§6.4). So the
   * precedence claim is asserted at boot instead. An absent file is the normal
   * case and passes. Drift afterwards — the agent writes a key on day nine — is
   * a `doctor` finding, not a boot failure.
   */
  const dotenv = (await host.readFile(HERMES_USER_ENV)) ?? "";
  const keyShadowed = spec.env !== null && envDefines(dotenv, spec.env);
  checks.push({
    name: "env_shadow",
    ok: !keyShadowed,
    detail: keyShadowed
      ? `${HERMES_USER_ENV} defines ${spec.env}, which Hermes prefers over the value hermetic ` +
        `delivers in ${SECRETS_ENV_PATH} — remove that line, or this agent keeps using a key ` +
        "hermetic did not push"
      : spec.env === null
        ? `${manifest.provider} authenticates as the instance; there is no key variable to shadow`
        : `${HERMES_USER_ENV} does not shadow ${spec.env}`,
  });

  /**
   * The same precedence question for the browser — and the reason it is its own
   * check rather than a second reason inside `env_shadow` (§8.1).
   *
   * hermetic puts `browser.cdp_url` in the *managed* config so that the agent
   * attaches to the Chrome on its own display rather than launching one of its
   * own, and `BROWSER_CDP_URL` in the agent's `.env` beats managed config. But
   * that is upstream's `/browser connect` seam working as designed: an operator
   * who handed the agent a browser somewhere else meant to, and the agent is
   * still working. Folded into `env_shadow` it was a boot failure
   * (`HERMES_MISCONFIGURED`), which contradicted what this very check says about
   * it — so it is `advisory`: stated in full, never the thing that puts an agent
   * into `error`.
   */
  const cdpShadowed = browsers.length > 0 && envDefines(dotenv, BROWSER_CDP_ENV);
  if (browsers.length > 0) {
    checks.push({
      name: "cdp_override",
      ok: !cdpShadowed,
      advisory: true,
      detail: cdpShadowed
        ? `${HERMES_USER_ENV} defines ${BROWSER_CDP_ENV}, which Hermes prefers over the managed ` +
          `browser.cdp_url — this agent drives whatever that names rather than ` +
          `${browserUnitName(browsers)} on its own display. Upstream's \`/browser connect\` writes ` +
          "that line, so it may be a deliberate hand-over; remove it to put the agent back on the " +
          "browser this box owns and the operator can watch"
        : `${HERMES_USER_ENV} does not shadow ${BROWSER_CDP_ENV}`,
    });
  }

  /**
   * And then ask Hermes.
   *
   * Everything above reads what hermetic wrote. This reads what Hermes
   * *resolves*: `config get` goes through `load_config()`, so it sees the
   * managed overlay, the agent's own config and the `model`/`name` aliases as
   * one, and it is the only check that catches a config hermetic rendered
   * correctly and Hermes then declined to use. The exit code is the verdict —
   * an unset key exits 1 and prints nothing to stdout (`hermesConfigGetArgv`) —
   * and the value is reported only so a passing boot says which model it is.
   *
   * It is the only check that runs a command, so it is the only one that can
   * fail in ways the other four cannot: a missing binary (`runProbe`) and a
   * wedged one (`HERMES_PROBE_TIMEOUT_S`). Both land here as a failed check.
   */
  const argv = hermesProbeArgv("model.default");
  const resolved = await runProbe(host, argv);
  checks.push({
    name: "resolved_model",
    ok: resolved.code === 0,
    detail:
      resolved.code === 0
        ? `Hermes resolves model.default to ${resolved.stdout.trim()}`
        : resolved.threw === null
          ? `Hermes resolves no model.default: \`${argv.join(" ")}\` exited ${String(resolved.code)}`
          : `Hermes could not be asked for model.default: \`${argv.join(" ")}\` ${resolved.threw}`,
  });

  /**
   * And what Hermes resolves for the approvals gate.
   *
   * It matters because `approvals.mode` is the difference between an agent that
   * administers its own box and one that hangs waiting for a human who is not
   * there: `smart` classifies most of what an agent does with its new root as
   * dangerous, and on an unattended instance that is a stalled turn or a silent
   * auto-deny rather than a second pair of eyes (§6.4). Nothing else on the box
   * would report it — the agent simply gets slower and stranger.
   *
   * **Advisory, by design, and for the same reason `cdp_override` is.** The
   * setting is seed-only: hermetic writes it into the agent's own config once
   * and then it belongs to whoever is driving the agent, who may legitimately
   * have changed it with `hermes config set approvals.mode` or from inside a
   * session. A value that no longer matches the operator's stated one is a
   * finding they should see in `agent history`, never a reason to put a working
   * agent into `error` — `cli.ts` prints it as `WARN approvals: …`.
   *
   * Skipped entirely when the manifest does not state a mode, which is what a
   * document rendered before the field looks like. There is no expectation to
   * check against, and inventing one from `HERMES_DEFAULTS` would report drift
   * on every box whose operator chose otherwise before this build existed.
   */
  if (manifest.approvals_mode !== undefined) {
    const expected = manifest.approvals_mode;
    const approvalsArgv = hermesProbeArgv("approvals.mode");
    const approvals = await runProbe(host, approvalsArgv);
    const value = unquote(approvals.stdout.trim());
    const matches = approvals.code === 0 && value === expected;
    checks.push({
      name: "approvals",
      ok: matches,
      advisory: true,
      detail: matches
        ? `Hermes resolves approvals.mode to ${expected}`
        : approvals.threw !== null
          ? `Hermes could not be asked for approvals.mode: \`${approvalsArgv.join(" ")}\` ${approvals.threw}`
          : approvals.code !== 0
            ? `Hermes resolves no approvals.mode: \`${approvalsArgv.join(" ")}\` exited ${String(approvals.code)}`
            : `Hermes resolves approvals.mode to ${value || "an empty value"}, not ${expected}` +
              " — it was changed on the box, by `hermes config set approvals.mode` or in a session," +
              " and hermetic seeds this key rather than managing it, re-asserting it only when the" +
              " operator's stated value changes",
    });
  }

  /**
   * And the same question for the browser, on an agent that has one.
   *
   * This is the same resolve-not-render mitigation as `resolved_model` above,
   * applied a second time: assert what Hermes *resolves*, not what hermetic
   * wrote (§8.1). A managed `browser.cdp_url` that Hermes declines to use —
   * because a key moved, because the managed overlay was not read, because the
   * agent's `.env` shadowed it — is an agent that silently launches its own
   * headless Chrome. Nothing else on the box notices: the browser tool works,
   * the desktop shows an idle window, and the shared-session property the whole
   * feature is for is quietly false.
   *
   * There is no repo-side test that could catch this instead. hermetic carries
   * no upstream source, so a test comparing hermetic's strings to hermetic's
   * constants would be a tautology; the box asking Hermes is the only witness.
   *
   * Fatal since 2026-09-16. It was advisory while the probe itself was an
   * assumption: nobody had watched `hermes config get
   * browser.cdp_url --json` answer for a key set in the managed overlay alone,
   * and a surprising exit code would have failed stage 06 on the first boot of
   * every browser agent — hermetic making an agent that works look broken. On a
   * live box (Hermes 0.21.3) the probe exits 0 and prints the
   * managed value, so the check now says what it means: an agent whose Hermes
   * does not resolve this box's endpoint is not the agent this box promised,
   * and `ready` is the wrong word for it.
   */
  if (browsers.length > 0) {
    const expected = expectedCdpUrl(browsers);
    const cdpArgv = hermesProbeArgv("browser.cdp_url");
    const cdp = await runProbe(host, cdpArgv);
    const value = unquote(cdp.stdout.trim());
    const matches = cdp.code === 0 && value === expected;
    checks.push({
      name: "resolved_cdp_url",
      ok: matches,
      detail: matches
        ? `Hermes resolves browser.cdp_url to ${expected}`
        : cdp.threw !== null
          ? `Hermes could not be asked for browser.cdp_url: \`${cdpArgv.join(" ")}\` ${cdp.threw}`
          : cdp.code !== 0
            ? `Hermes resolves no browser.cdp_url: \`${cdpArgv.join(" ")}\` exited ${String(cdp.code)}` +
              " — the browser tool would launch its own Chrome instead of attaching to the one" +
              " this box runs"
            : `Hermes resolves browser.cdp_url to ${value || "an empty value"}, not ${expected}` +
              " — this agent drives a browser this box does not own",
    });
  }

  return checks;
}

/**
 * The env var upstream reads as the override for `browser.cdp_url`
 * (`browser_tool.py:581-595`). Spelled here rather than imported because core's
 * schema has no name for it: hermetic never writes it — the whole point is that
 * the managed config is hermetic's channel and this one is the operator's.
 */
const BROWSER_CDP_ENV = "BROWSER_CDP_URL";

/**
 * The CDP endpoint the managed config points Hermes at.
 *
 * The *first* identity, which is what `render-browser.ts` writes into
 * `browser.cdp_url` — upstream resolves one endpoint per process
 * (`_get_cdp_override`), so an agent with several browsers still drives one of
 * them, and it is this one.
 */
function expectedCdpUrl(browsers: readonly { cdp_port: number }[]): string {
  const first = browsers[0];
  return first === undefined ? "" : `http://127.0.0.1:${String(first.cdp_port)}`;
}

/** The browser identity the managed `browser.cdp_url` names, for the shadow detail. */
function browserUnitName(browsers: readonly { name: string }[]): string {
  const first = browsers[0];
  return first === undefined ? "the browser this box runs" : `hermetic-browser@${first.name}`;
}

/**
 * `config get --json` prints a JSON string, so a URL comes back quoted. The
 * probe is the same command `resolved_model` runs, and there the value is only
 * printed; here it is compared, so the quotes have to come off — while a build
 * that prints the bare value still matches.
 */
function unquote(value: string): string {
  return value.startsWith('"') && value.endsWith('"') && value.length >= 2 ? value.slice(1, -1) : value;
}
