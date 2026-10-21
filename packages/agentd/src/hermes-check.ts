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
 * Seven things on an agent with no browser, nine on one with, one more on an
 * agent with an external memory provider, in two groups. Some are conditional on what the manifest says rather than on what the box
 * is: `approvals` is skipped by a manifest rendered before that field existed,
 * the two browser checks by one that names no browsers, and `memory` (the
 * managed config selects the provider the manifest names) by one with no
 * external memory provider.
 *
 * These are read offline, from what hermetic itself wrote:
 *
 *   1. the managed config exists and names a provider;
 *   2. the agent has a model to send to it;
 *   3. a keyed provider's key actually arrived on the box, in the managed
 *      block of the agent's own `.env`;
 *   4. nothing outside that block shadows it, and every bot's `.env` holds
 *      the same block (`bots_keyed`, advisory);
 *   5. on a browser agent, that `.env` carries `BROWSER_CDP_URL` and it names
 *      this box's browser (`cdp_override` — a verdict when the line is
 *      missing, advisory when it names another endpoint; see below).
 *
 * The rest ask Hermes: `hermes config get model.default --json`, the same for
 * `approvals.mode` when the manifest states one, and on a browser agent
 * `browser.cdp_url` too. Those are the probes that see Hermes's own
 * *resolution* rather than hermetic's output.
 *
 * `approvals`, and `cdp_override` when it finds an operator's endpoint, are
 * `advisory`: findings the operator should see and not verdicts that fail a
 * boot (`HermesCheck.advisory`). Both report a value the agent or the operator
 * may have changed on the box on purpose, through a seam hermetic deliberately
 * left open.
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
  BROWSER_CDP_ENV,
  HERMES_ACCOUNT,
  HERMES_MANAGED_CONFIG,
  HERMES_USER_CONFIG,
  HERMES_USER_ENV,
  PROVIDERS,
  browserCdpUrl,
  hermesConfigGetArgv,
  hermesMemoryProviderName,
  providerNeedsKey,
} from "@hermetic/core/shared";
import type { Host } from "./host.ts";
import { AgentdError } from "./errors.ts";
import { managedBlockOf, outsideManagedBlock } from "./apply/secrets.ts";
import { botEnvPath, listBotHomes } from "./secrets-sync.ts";

/** A Hermes `.env`, read as the account (refusing a symlink); `null` when unreadable or absent. */
async function readEnvAsHermes(host: Host, path: string): Promise<string | null> {
  try {
    return await new Response(host.readStreamAs(HERMES_ACCOUNT, path)).text();
  } catch {
    return null;
  }
}

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

/** `section.key`'s value, unquoted, at the depth `namesKey` reads; null when absent. */
function keyValue(yaml: string, section: string, key: string): string | null {
  let inSection = false;
  for (const line of yaml.split("\n")) {
    if (/^\S/.test(line)) inSection = line.startsWith(section + ":");
    else if (inSection) {
      const m = new RegExp(`^\\s+${key}\\s*:\\s*(\\S.*?)\\s*$`).exec(line);
      if (m) return m[1]!.replace(/^(["'])(.*)\1$/, "$2");
    }
  }
  return null;
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
 * What a dotenv-shaped file assigns to `name`, or `null` if no line does.
 *
 * The last assignment wins, as it does when python-dotenv loads the file, and
 * `export` and one pair of matching quotes are stripped the way it strips them.
 * Unlike `envHasValue`, the value leaves this function — so it is only ever
 * asked about a variable that holds no secret.
 */
function envValue(env: string, name: string): string | null {
  let found: string | null = null;
  for (const line of env.split("\n")) {
    if (/^\s*#/.test(line)) continue;
    const m = /^\s*(?:export\s+)?([^=\s]+)\s*=(.*)$/.exec(line);
    if (m?.[1] !== name) continue;
    const raw = (m[2] ?? "").trim();
    found = /^(["']).*\1$/.test(raw) && raw.length >= 2 ? raw.slice(1, -1) : raw;
  }
  return found;
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
 * Every bot (`$HERMES_HOME/profiles/<bot>`) holds the same managed block as
 * the default `.env`: the sync writes them together, so a difference is a bot
 * the last sync missed or an edit inside its fence. The key variable assigned
 * outside a bot's block is a deliberate per-bot key, which hermeticd never
 * overwrites and reports here. Always `advisory`: bots are the agent's own,
 * and none of this is a reason to fail a boot. Names bots only, never a value.
 */
async function botsKeyed(
  host: Host,
  block: string[] | null,
  keyEnv: string | null,
): Promise<HermesCheck> {
  const bots = await listBotHomes(host);
  if (bots.length === 0) {
    return { name: "bots_keyed", ok: true, advisory: true, detail: "no bots on this box" };
  }
  if (block === null) {
    return {
      name: "bots_keyed",
      ok: false,
      advisory: true,
      detail: `${HERMES_USER_ENV} holds no hermetic managed block to key ${bots.length} bot(s) from`,
    };
  }
  const expected = block.join("\n");
  const unkeyed: string[] = [];
  const overriding: string[] = [];
  for (const bot of bots) {
    const env = (await readEnvAsHermes(host, botEnvPath(bot))) ?? "";
    if (managedBlockOf(env)?.join("\n") !== expected) unkeyed.push(bot);
    if (keyEnv !== null && envDefines(outsideManagedBlock(env), keyEnv)) overriding.push(bot);
  }
  if (unkeyed.length === 0 && overriding.length === 0) {
    return {
      name: "bots_keyed",
      ok: true,
      advisory: true,
      detail: `every bot holds the current block (${bots.join(", ")})`,
    };
  }
  const parts = [
    ...(unkeyed.length > 0
      ? [`without the current managed block: ${unkeyed.join(", ")} (the next sync rewrites it)`]
      : []),
    ...(overriding.length > 0
      ? [
          `assigning ${keyEnv} outside the block, a per-bot key hermetic leaves alone: ${overriding.join(", ")}`,
        ]
      : []),
  ];
  return { name: "bots_keyed", ok: false, advisory: true, detail: `bots ${parts.join("; ")}` };
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
   * Only when the manifest names an external memory provider: the managed
   * config must select the same one, or Hermes runs built-in memory while every
   * laptop-side reading says otherwise.
   */
  if (manifest.memory) {
    const named = keyValue(managed, "memory", "provider");
    const want = hermesMemoryProviderName(manifest.memory.provider);
    checks.push({
      name: "memory",
      ok: named === want,
      detail:
        named === want
          ? `${HERMES_MANAGED_CONFIG} selects memory provider ${named}`
          : `${HERMES_MANAGED_CONFIG} selects memory provider ${named ?? "(none)"}, not ${want}`,
    });
  }

  /**
   * Either file may carry the model, and which one does is not this stage's
   * business: hermetic manages the model when it is held and seeds it
   * otherwise, and both spellings are correct (`splitHermesSettings`). What
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

  const dotenv = (await readEnvAsHermes(host, HERMES_USER_ENV)) ?? "";
  const block = managedBlockOf(dotenv);
  if (providerNeedsKey(manifest.provider) && spec.env !== null) {
    const present = envHasValue((block ?? []).join("\n"), spec.env);
    checks.push({
      name: "key",
      ok: present,
      detail: present
        ? `${spec.env} is set in the managed block of ${HERMES_USER_ENV}`
        : `${spec.env} is missing or empty in the managed block of ${HERMES_USER_ENV}` +
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
   * The key hermetic delivered has to be the key Hermes uses.
   *
   * Every dotenv reader upstream lets the last assignment win
   * (`_parse_env_text`, python-dotenv), so the key variable assigned anywhere
   * outside the managed block — a stale line on a reattached volume, `hermes
   * setup` appending one — can outrank the block hermeticd keeps current, and
   * `hermetic providers update` becomes a no-op with no signal on either side.
   * hermeticd never deletes the agent's own lines, so the precedence claim is
   * asserted at boot instead. Drift afterwards is a `doctor` finding.
   */
  const keyShadowed = spec.env !== null && envDefines(outsideManagedBlock(dotenv), spec.env);
  checks.push({
    name: "env_shadow",
    ok: !keyShadowed,
    detail: keyShadowed
      ? `${HERMES_USER_ENV} assigns ${spec.env} outside the hermetic managed block, which can ` +
        "outrank the key hermetic keeps current there — remove that line, or this agent keeps " +
        "using a key hermetic did not push"
      : spec.env === null
        ? `${manifest.provider} authenticates as the instance; there is no key variable to shadow`
        : `${HERMES_USER_ENV} does not shadow ${spec.env}`,
  });

  checks.push(await botsKeyed(host, block, spec.env));

  /**
   * The browser endpoint in the agent's own `.env` — the reason it is its own
   * check rather than a second reason inside `env_shadow` (§8.1).
   *
   * hermetic writes `BROWSER_CDP_URL` there (`browserEnvSeedCommands`) as well
   * as the managed `browser.cdp_url`, because the managed overlay is not read by
   * every upstream path: `browser_exec` resolves its endpoint through
   * `read_raw_config()`, which skips it, and with no endpoint launches its own
   * headless Chrome. The environment variable is read first by every path, so
   * its presence here is what makes the agent's browser the one this box runs.
   *
   * So a missing line is a verdict: on such a box `resolved_cdp_url` still
   * passes (`config get` uses the merged loader) while `browser_exec` drives an
   * invisible browser — exactly the blind spot this check closes. A line naming
   * another endpoint is different. hermetic only seeds the variable and never
   * overwrites it, and upstream's `/browser connect` writes that same line: an
   * operator who handed the agent a browser somewhere else meant to, and the
   * agent is still working. That case is `advisory` — stated in full, never the
   * thing that puts an agent into `error`.
   */
  if (browsers.length > 0) {
    const expected = expectedCdpUrl(browsers);
    const value = envValue(dotenv, BROWSER_CDP_ENV);
    const differs = value !== null && value !== expected;
    checks.push({
      name: "cdp_override",
      ok: value === expected,
      ...(differs ? { advisory: true as const } : {}),
      detail:
        value === expected
          ? `${HERMES_USER_ENV} sets ${BROWSER_CDP_ENV} to ${expected}`
          : value === null
            ? `${HERMES_USER_ENV} does not set ${BROWSER_CDP_ENV} — Hermes's browser_exec reads no ` +
              `endpoint from the managed config and launches a headless Chrome of its own instead of ` +
              `attaching to ${browserUnitName(browsers)}; the apply's post-step writes the line, so ` +
              "re-run the apply"
            : `${HERMES_USER_ENV} sets ${BROWSER_CDP_ENV} to ${value || "an empty value"}, not ` +
              `${expected} — this agent drives whatever that names rather than ` +
              `${browserUnitName(browsers)} on its own display. Upstream's \`/browser connect\` writes ` +
              "that line, so it may be a deliberate hand-over; set it back to put the agent on the " +
              "browser this box owns and the operator can watch",
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
   * **Advisory, by design, and for the same reason an operator's endpoint in
   * `cdp_override` is.** The setting is seed-only: hermetic writes it into the agent's own config once
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
   * It has a blind spot, which is why `cdp_override` is a verdict too: `config
   * get` resolves through the merged loader, so it sees the managed key even on
   * a box where `browser_exec` — which reads `read_raw_config()` — does not.
   * This check proves the managed half; `cdp_override` proves the half
   * `browser_exec` reads.
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
 * The CDP endpoint hermetic points Hermes at, in the managed config and in
 * the agent's `.env` alike.
 *
 * The *first* identity, which is what `render-browser.ts` writes into
 * `browser.cdp_url` and `BROWSER_CDP_URL` — upstream resolves one endpoint per process
 * (`_get_cdp_override`), so an agent with several browsers still drives one of
 * them, and it is this one.
 */
function expectedCdpUrl(browsers: readonly { cdp_port: number }[]): string {
  const first = browsers[0];
  return first === undefined ? "" : browserCdpUrl(first.cdp_port);
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
