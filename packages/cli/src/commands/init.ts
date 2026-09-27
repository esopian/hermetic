/**
 * `hermetic init` (§4.7). The head owns every prompt; core resolves the identity
 * and decides attach vs create. Confirmation is the twelve digits, never `y`.
 *
 * The flow follows §4.7 step by step: list profiles without resolving any
 * identity (that would trigger an SSO login per profile), resolve the identity
 * of the one chosen, show it, make the operator type the account id, read this
 * machine's tailnet and have them confirm it, then bind core to that profile
 * and run the op.
 */
import type { Command } from "commander";
import { Command as Cmd } from "commander";
import { confirm, isCancel, password, select } from "@clack/prompts";
import {
  HermeticError,
  TAILSCALE_ADMIN_ACL_URL,
  TAILSCALE_ADMIN_DNS_URL,
  TAILSCALE_ADMIN_OAUTH_URL,
  TAILSCALE_DOWNLOAD_URL,
  acl_snippet,
  fixtureConfigFor,
  fleetTargetOf,
  fixtureOptionsFromEnv,
  openForInit,
} from "@hermetic/core";
import type { AwsProfileInfo, Hermetic } from "@hermetic/core";
import { openCtx, readFlags, signal } from "../context.ts";
import { destructive } from "../options.ts";
import { defined, validate } from "../validate.ts";
import { err, headerLine, isInteractive, type GlobalFlags } from "../io.ts";
import { renderOp } from "../stream.ts";
import { askAccountId, assertConfirmable } from "../confirm.ts";
import { declare } from "../declare.ts";
import { InitInput } from "@hermetic/core";
import { annotateRun } from "../run-log.ts";

function describe(p: AwsProfileInfo): string {
  return `${p.region ?? "no region"} · ${p.credential_type} · ${p.source}`;
}

async function pickProfile(profiles: AwsProfileInfo[], preferred?: string): Promise<AwsProfileInfo> {
  if (preferred !== undefined) {
    const found = profiles.find((p) => p.name === preferred);
    if (!found) {
      throw new HermeticError("NOT_FOUND", `no AWS profile named ${preferred}`, {
        available: profiles.map((p) => p.name),
      });
    }
    return found;
  }
  if (profiles.length === 0) {
    throw new HermeticError(
      "NOT_FOUND",
      "no AWS profiles found in ~/.aws/config or ~/.aws/credentials",
    );
  }
  if (!isInteractive()) {
    throw new HermeticError(
      "CONFIRMATION_REQUIRED",
      "no terminal to pick a profile in; pass --profile",
      { available: profiles.map((p) => p.name) },
    );
  }
  const chosen = await select({
    message: "which AWS profile should this hermetic home be frozen to?",
    options: profiles.map((p) => ({ value: p.name, label: p.name, hint: describe(p) })),
    output: process.stderr,
  });
  if (isCancel(chosen)) throw new HermeticError("ABORTED", "cancelled at the profile picker");
  return profiles.find((p) => p.name === chosen) ?? (profiles[0] as AwsProfileInfo);
}

const indent = (text: string, by: string): string =>
  text
    .split("\n")
    .map((line) => by + line)
    .join("\n");

/**
 * Only asked on the create branch; there is no API to mint one (§4.7 step 4),
 * so the most the CLI can do is walk the operator through the admin console in
 * the order it has to happen: the policy first, because the OAuth client form
 * only offers tags that already have a `tagOwners` entry, then the client.
 */
async function askTailscaleSecret(): Promise<string | undefined> {
  if (!isInteractive()) return undefined;
  await err(
    [
      "▸ Tailnet policy — paste the tagOwners line before creating the OAuth client;",
      "  the client form only offers tags that already have an owner. Give the client",
      "  the policy_file scope and hermetic writes the ssh and acls entries itself.",
      `  ${TAILSCALE_ADMIN_ACL_URL}`,
      indent(acl_snippet(), "  "),
      "",
      "▸ OAuth client — create it here, then paste the secret below:",
      `  ${TAILSCALE_ADMIN_OAUTH_URL}`,
      "  scopes: Auth Keys → Write · Devices → Core → Read, Write (both tagged tag:hermetic)",
      "          Policy File → Write, so hermetic keeps the entries above current for you",
      "          (Tailscale attaches Devices → Posture Attributes and Devices → Core → Read to it;",
      "           policy_file is tailnet-wide — Tailscale will not restrict it to a tag)",
      "",
      "▸ HTTPS certificates — enable them for the tailnet (DNS → HTTPS Certificates):",
      `  ${TAILSCALE_ADMIN_DNS_URL}`,
      "  every agent serves its dashboard at https://<name>.<tailnet>; without this the last provisioning step fails",
      "",
    ].join("\n"),
  );
  const value = await password({
    message: "Tailscale OAuth client secret (tskey-client-…) — blank to skip",
    output: process.stderr,
  });
  if (isCancel(value)) throw new HermeticError("ABORTED", "cancelled at the Tailscale secret prompt");
  return value.length > 0 ? value : undefined;
}

/**
 * §4.7 preflight. The tailnet is detected, not asked for: the tailnet this
 * machine is on is the tailnet the fleet belongs to. Core refuses the create
 * branch when the daemon is not usable, so this prints the same reading the
 * engine is about to make and — interactively — has the operator confirm it,
 * because it is stamped on `_fleet` and rendered into every agent (§6.4).
 *
 * Returns the tailnet to send, or `undefined` to let core decide (which it can:
 * it re-runs the same probe). Throws only when the operator says no.
 */
async function confirmTailnet(
  hermetic: Hermetic,
  opts: Record<string, unknown>,
): Promise<string | undefined> {
  const override = opts["tailnet"] as string | undefined;
  const preflight = await hermetic.init.localTailscale();

  if (preflight.ok) {
    await err(
      `  tailscale ${preflight.backend_state?.toLowerCase() ?? "up"} · tailnet ${preflight.tailnet}` +
        `${preflight.hostname ? ` · this node ${preflight.hostname}` : ""}\n`,
    );
  } else {
    await err(`  tailscale: ${preflight.problem ?? "not usable on this machine"}\n`);
    // The download page is the answer only when there is nothing installed;
    // a logged-out machine already has Tailscale and needs `tailscale up`.
    if (!preflight.installed) await err(`  install it: ${TAILSCALE_DOWNLOAD_URL}\n`);
  }
  if (override !== undefined) return override;
  if (!preflight.ok || preflight.tailnet === null) return undefined;

  if (isInteractive() && opts["yes"] !== true) {
    const ok = await confirm({
      message: `create the fleet on ${preflight.tailnet}? every agent joins it and nothing else`,
      output: process.stderr,
    });
    if (isCancel(ok)) throw new HermeticError("ABORTED", "cancelled at the tailnet confirmation");
    if (!ok) {
      throw new HermeticError(
        "ABORTED",
        "not the intended tailnet; switch this machine with `tailscale switch`, or pass --tailnet",
      );
    }
  }
  return preflight.tailnet;
}

/**
 * The OAuth client is proved by using it — mint a `tag:hermetic` key, revoke it,
 * list the tailnet's devices — because a secret that cannot mint is only
 * discovered when the first agent fails to boot. A bad one is reported, not
 * fatal: `init` already tolerates no secret at all, and the operator can push a
 * working one later (§8.2).
 *
 * The device read is the second scope, and its absence is a warning on an
 * otherwise-verified client: it costs stale-device cleanup and `doctor`'s device
 * drift, not the ability to create agents.
 */
async function reportOauth(hermetic: Hermetic, secret: string): Promise<void> {
  const check = await hermetic.init.verifyTailscaleOauth(secret);
  if (check.ok) {
    await err(
      `  tailscale OAuth client verified: can mint tag:hermetic keys${check.can_list_devices ? ", list devices" : ""}${check.policy_scope === "write" ? " and edit the policy file" : check.policy_scope === "read" ? " and read the policy file" : ""}${check.revoked ? "" : " (probe key left to expire)"}\n`,
    );
    // The second scopes: each costs something specific and neither stops an
    // agent being created, so they are warnings under a verified client rather
    // than a refusal (§4.7).
    if (!check.can_list_devices || check.policy_scope !== "write") {
      await err(`  warning: ${check.problem ?? "the client is missing a second scope"}\n`);
    }
    return;
  }
  await err(`  warning: ${check.problem ?? "the OAuth client could not be verified"}\n`);
}

/**
 * §4.7 step 3: the twelve digits, always typed. `--yes` skips the *are you
 * sure*, never the account id — the whole point of the typed confirmation is
 * that it cannot be produced by habit, and a `--yes` that auto-filled it would
 * make every scripted `init` a silent re-target. In a script the digits come
 * from `--confirm-account-id`, which is just as deliberate.
 */
async function typedAccountId(opts: Record<string, unknown>, hint: string): Promise<string> {
  const supplied = opts["confirmAccountId"] as string | undefined;
  if (supplied !== undefined) {
    if (!/^\d{12}$/.test(supplied)) {
      throw new HermeticError(
        "VALIDATION",
        "--confirm-account-id takes the twelve digits, no separators",
      );
    }
    return supplied;
  }
  if (!isInteractive()) {
    throw new HermeticError(
      "CONFIRMATION_REQUIRED",
      "init confirms by typing the twelve-digit account id; pass --confirm-account-id",
    );
  }
  return askAccountId(hint);
}

/** `--fixture` has a config already; there is nothing to pick and no AWS to ask. */
async function fixtureInit(cmd: Command, opts: Record<string, unknown>): Promise<void> {
  const flags = readFlags(cmd);
  try {
    const ctx = await openCtx(cmd);
    if (opts["reset"] === true) assertConfirmable(ctx, "re-target this hermetic home?");
    const typed = await typedAccountId(opts, ctx.config.account_id);
    const input = validate(
      initSchema,
      defined({
        attach: opts["attach"],
        create: opts["create"],
        reset: opts["reset"],
        yes: opts["yes"],
        profile: opts["profile"],
        region: opts["region"],
        network: opts["network"],
        // §4.8: the global `--fleet` is the attach target, by fleet id or alias.
        // There is no `--name`: a fleet is created without one and labelled
        // afterwards with `hermetic fleet alias`.
        fleet: ctx.flags.fleet ?? undefined,
        directory_region: opts["directoryRegion"],
        account_id_typed: typed,
      }),
    );
    await renderOp(ctx.hermetic.init(input, { signal: ctx.signal }), {
      flags: ctx.flags,
      label: "init",
    });
    return;
  } catch (e) {
    /**
     * `openCtx` resolves only locally frozen rows. That is right for every
     * ordinary command, but `init --attach` is specifically how a row not on
     * this laptop becomes frozen. Re-enter through the pre-init door only for
     * that one refusal; every other error keeps its original meaning.
     */
    if (
      !(e instanceof HermeticError) ||
      e.code !== "NOT_FOUND" ||
      opts["attach"] !== true ||
      flags.fleet === null
    ) {
      throw e;
    }
  }

  const target = fixtureConfigFor(flags.fleet);
  const session = await openForInit({
    fixture: true,
    fleet: flags.fleet,
    fixtureOptions: fixtureOptionsFromEnv(process.env),
  });
  try {
    if (opts["reset"] === true && !flags.yes && !isInteractive()) {
      throw new HermeticError("CONFIRMATION_REQUIRED", "re-target this hermetic home? — pass --yes");
    }
    annotateRun({ ...fleetTargetOf(target), fleet_name: target.name });
    await err(`${headerLine(target, true)}\n`);
    const typed = await typedAccountId(opts, target.account_id);
    const input = validate(
      initSchema,
      defined({
        attach: true,
        reset: opts["reset"],
        yes: opts["yes"],
        profile: opts["profile"] ?? target.profile,
        region: opts["region"] ?? target.region,
        network: opts["network"],
        fleet: flags.fleet,
        directory_region: opts["directoryRegion"],
        account_id_typed: typed,
      }),
    );
    await renderOp(session.hermetic.init(input, { signal: signal() }), {
      flags,
      label: "init",
    });
  } finally {
    session.close();
  }
}

async function realInit(flags: GlobalFlags, opts: Record<string, unknown>): Promise<void> {
  /**
   * §4.8: `--fleet` names *which frozen row* this init might be re-targeting.
   * A home that holds several has no single "the config", so without it
   * `openForInit` reads none — and `freeze()`'s retarget guard is only as good
   * as the row it was given.
   */
  const session = await openForInit(flags.fleet !== null ? { fleet: flags.fleet } : {});
  try {
    if (session.corruptedTo !== null) {
      await err(`warning: unreadable local database renamed to ${session.corruptedTo}\n`);
    }
    if (session.envOverrides.length > 0) {
      await err(`warning: ${session.envOverrides.join(", ")} set in the environment and ignored\n`);
    }
    if (opts["reset"] === true && session.existingConfig !== null && !flags.yes && !isInteractive()) {
      throw new HermeticError(
        "CONFIRMATION_REQUIRED",
        "re-targeting this home is destructive; pass --yes",
      );
    }

    const profiles = await session.hermetic.init.listProfiles();
    const profile = await pickProfile(profiles, opts["profile"] as string | undefined);
    const region = (opts["region"] as string | undefined) ?? profile.region ?? "us-east-1";

    // One STS call, for the chosen profile only (§4.7 step 2).
    const identity = await session.hermetic.init.resolveIdentity(profile.name, region);
    await err(
      `▸ ${identity.alias ?? identity.profile} · ${identity.account_id} · ${identity.region} · profile ${identity.profile}\n` +
        `  caller ${identity.arn}\n` +
        `  organisation ${identity.org_id ?? "(not visible from this account)"}\n`,
    );

    const typed = await typedAccountId(opts, identity.account_id);

    const tailscale = opts["create"] === true ? await askTailscaleSecret() : undefined;
    /**
     * Run on both branches: attaching to a fleet from a machine that is not on
     * its tailnet is legal (§4.7 — it is the recovery path) but worth saying
     * out loud, and core reports the same thing as a warning on the op.
     */
    const tailnet = await confirmTailnet(session.hermetic, opts);
    if (tailscale !== undefined) await reportOauth(session.hermetic, tailscale);

    const input = validate(
      initSchema,
      defined({
        attach: opts["attach"],
        create: opts["create"],
        reset: opts["reset"],
        yes: opts["yes"],
        profile: identity.profile,
        region: identity.region,
        network: opts["network"],
        // §4.8: which fleet this run is about, and where the account's fleet
        // directory lives. Flag-only, both of them — `init` prompts for what it
        // cannot know (the profile, the digits, the tailnet), and core already
        // answers these itself: `--attach` detects the single live foundation
        // when only one is visible, and the directory region defaults to what
        // this home recorded, then us-east-1. A prompt would be asking the
        // operator to repeat core's answer.
        //
        // `--fleet` is the global flag (`options.ts`), so `hermetic --fleet x
        // init --attach` and `hermetic init --attach --fleet x` are the same
        // command. It names the fleet to attach to, by id or display alias, and
        // never renames anything: aliases are assigned by `fleet alias`.
        fleet: flags.fleet ?? undefined,
        directory_region: opts["directoryRegion"],
        account_id_typed: typed,
        tailnet,
        skip_tailscale_check: opts["skipTailscaleCheck"],
        skip_artifacts: opts["skipArtifacts"],
        skip_policy: opts["skipPolicy"],
        tailscale_oauth_secret: tailscale,
      }),
    );

    /**
     * §4.8: the directory region is a property of the *account*, not of the
     * fleet, so it is not one of the clients `bind()` builds from the identity
     * — core only honours `--directory-region` if the head hands it over here
     * as well as on the request. Sending it in both places is not redundant:
     * `bind` decides which region the directory *client* talks to, and
     * `InitInput.directory_region` is what gets persisted for later commands.
     */
    const directoryRegion = opts["directoryRegion"] as string | undefined;
    const bindInput = {
      profile: identity.profile,
      region: identity.region,
      accountId: identity.account_id,
      ...(directoryRegion !== undefined ? { directoryRegion } : {}),
    };
    const bound: Hermetic = session.bind(bindInput);
    const events = await renderOp(bound.init(input, { signal: signal() }), { flags, label: "init" });
    // §3.6 / §4.7: the things that are *not* ready, once more, where they will be read.
    const pending = events.filter((e) => e.phase === "ready" && e.level === "warn");
    if (pending.length > 0 && !flags.json) {
      await err(`\nbefore the first agent:\n${pending.map((e) => `  ⚠ ${e.message}`).join("\n")}\n`);
    }
  } finally {
    session.close();
  }
}

const initSchema = declare("init", "init", InitInput);

export function register(program: Command): void {
  program.addCommand(
    destructive(new Cmd("init"))
      .description("verify and freeze an account; attach to an existing foundation or create one")
      .option("--attach", "fail unless a foundation already exists")
      .option("--create", "fail unless there is no foundation yet")
      .option("--reset", "re-target this home at another account; mints a new fleet_id")
      .option("--profile <name>", "AWS profile to freeze")
      .option("--region <region>", "region for the fleet")
      .option("--network <mode>", "public | nat")
      .option(
        "--directory-region <region>",
        "region the account-global fleet directory lives in (default us-east-1, then whatever this home recorded)",
      )
      .option("--tailnet <name>", "override the tailnet detected from this machine, e.g. acme.ts.net")
      .option(
        "--skip-tailscale-check",
        "create a foundation even though this machine is not on a tailnet (headless/CI)",
      )
      .option(
        "--skip-policy",
        "do not write hermetic's entries into the tailnet policy file (for policies deployed from git)",
      )
      .option(
        "--skip-artifacts",
        "create without pushing hermeticd (headless/CI); no agent can launch until `hermetic artifacts push` runs",
      )
      .option(
        "--confirm-account-id <digits>",
        "the twelve digits, for scripts; interactively you type them at the prompt",
      )
      .addHelpText(
        "after",
        "\nA fleet is created with no display alias: it shows as its own fleet id\n" +
          "until `hermetic fleet alias <fleet-id> <alias>` gives it one. `--fleet`\n" +
          "selects an existing fleet to attach to, by id or alias, and never renames.\n" +
          "\nExamples:\n" +
          "  hermetic init                                    pick a profile interactively, attach or create\n" +
          "  hermetic init --create --profile acme-prod       create a new foundation in that profile\n" +
          "  hermetic init --attach                           fail unless a foundation already exists\n" +
          "  hermetic init --attach --fleet abcdefgh          freeze a fleet this laptop does not have yet\n" +
          "  hermetic init --create --skip-tailscale-check --tailnet acme.ts.net\n" +
          "                                                    create from a machine that is not on the tailnet\n" +
          "  hermetic init --reset --confirm-account-id 123456789012\n" +
          "                                                    re-target this home, scripted (no prompt)\n",
      )
      .action(async (opts: Record<string, unknown>, cmd: Command) => {
        const flags = readFlags(cmd);
        if (flags.fixture) {
          await fixtureInit(cmd, opts);
          return;
        }
        await realInit(flags, opts);
      }),
  );
}
