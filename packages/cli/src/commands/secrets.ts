/**
 * `hermetic secrets …` (§8.2). The value is read from the terminal or stdin and
 * handed straight to core: it is never echoed, logged, or written to disk.
 */
import type { Command } from "commander";
import { Command as Cmd } from "commander";
import { openCtx } from "../context.ts";
import { destructive, globals } from "../options.ts";
import { defined, validate } from "../validate.ts";
import { err, isInteractive, out, outJson } from "../io.ts";
import { readSecret } from "../secret.ts";
import { declare } from "../declare.ts";
import { HermeticError } from "@hermetic/core";
import {
  SecretsDeleteInput,
  SecretsListInput,
  SecretsPushInput,
  SecretsVerifyInput,
} from "@hermetic/core";
import { renderSharedSecrets } from "../table.ts";
import { askSecretSlug } from "../confirm.ts";

const secretsPushSchema = declare("secrets.push", "secrets push", SecretsPushInput);
const secretsVerifySchema = declare("secrets.verify", "secrets verify", SecretsVerifyInput);
const secretsListSchema = declare("secrets.list", "secrets ls", SecretsListInput);
const secretsDeleteSchema = declare("secrets.delete", "secrets rm", SecretsDeleteInput);

/**
 * `--rekey` with no value means every agent whose provider reads this slot;
 * `--rekey a,b` names them. Commander hands back `true` for the bare flag,
 * which is the one place the two spellings have to be told apart.
 */
function parseRekey(value: unknown): "all" | string[] | undefined {
  if (value === undefined) return undefined;
  if (value === true || value === "all") return "all";
  return String(value)
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
}

export function register(program: Command): void {
  const secrets = new Cmd("secrets").description("secret slots in SSM Parameter Store");

  secrets.addCommand(
    globals(new Cmd("push"))
      .description("push a value into one of an agent's slots, or the fleet's")
      .argument("<name>", "agent name, or _fleet for --tailscale-oauth / --shared")
      .option("--provider-key", "push the model provider's API key")
      .option("--bws-token", "push the Bitwarden Secrets Manager access token")
      .option("--from-bitwarden", "pull the value out of Bitwarden instead of reading it")
      .option(
        "--tailscale-oauth",
        "rotate the fleet's Tailscale OAuth client secret (verifies it can mint tag:hermetic keys and list devices before storing)",
      )
      .option(
        "--shared <slug>",
        "push a fleet-level shared key into /hermetic/<fleet_id>/secrets/<slug>",
      )
      .option("--label <text>", "what to call that shared slot in `secrets ls`")
      .option(
        "--rekey [agents]",
        "re-copy the new value into agents already running on this slot: `all`, or a comma-separated list",
      )
      .addHelpText(
        "after",
        "\nExamples:\n" +
          "  hermetic secrets push atlas --provider-key\n" +
          "                                                 prompts, writes the slot atlas's own `credential_ref` names\n" +
          "                                                 (/hermes/<fleet_id>/atlas/<slot>; `provider-key` on a row\n" +
          "                                                 that predates provider profiles)\n" +
          "  hermetic secrets push atlas --bws-token\n" +
          "                                                 prompts, writes /hermes/<fleet_id>/atlas/bws-token\n" +
          "  hermetic secrets push _fleet --tailscale-oauth\n" +
          "                                                 prompts, writes /hermetic/<fleet_id>/tailscale/oauth-secret\n" +
          "  hermetic secrets push _fleet --shared nous-key --label 'Nous Portal'\n" +
          "                                                 prompts, writes /hermetic/<fleet_id>/secrets/nous-key\n" +
          "  hermetic secrets push _fleet --shared nous-key --rekey all\n" +
          "                                                 and re-copies it into every agent whose provider reads it\n" +
          "\nA shared slot is *copied* into an agent at create, never read by the box:\n" +
          "/hermetic/* is outside what an instance role may read. So rotating one does\n" +
          "not reach live agents unless --rekey says so, and each re-keyed agent takes\n" +
          "the new value on its next `agent recreate`.\n" +
          // Tailscale cannot edit an existing client's scopes, so widening the
          // fleet's client is always a new client and this rotation (§5).
          "\nThe Tailscale OAuth client secret is proved before it is stored: a client that\n" +
          "cannot mint a tag:hermetic key is refused and nothing is written. Create the\n" +
          "new client with Auth Keys -> Write and Devices -> Core -> Read, Write, both\n" +
          "tagged tag:hermetic, then delete the old one once this succeeds.\n",
      )
      .action(async (name: string, opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const flags = defined({
          name,
          provider_key: opts["providerKey"],
          bws_token: opts["bwsToken"],
          from_bitwarden: opts["fromBitwarden"],
          tailscale_oauth: opts["tailscaleOauth"],
          shared: opts["shared"],
          label: opts["label"],
          rekey: parseRekey(opts["rekey"]),
        });
        // Validate the flags *before* asking for a secret: an operator should
        // not type a token into a command that was never going to work.
        validate(secretsPushSchema, flags);
        const value =
          opts["fromBitwarden"] === true ? undefined : await readSecret(`value for ${name}`);
        const input = validate(secretsPushSchema, defined({ ...flags, value }));
        const pushed = await ctx.hermetic.secrets.push(input);
        if (ctx.flags.json) await outJson(pushed);
        else {
          await out(`wrote ${pushed.path}\n`);
          // Which boxes now hold the new value — and, by omission, which do
          // not: a rotation without --rekey reaches nobody who is already
          // running (§8.3).
          if (pushed.rekeyed !== undefined && pushed.rekeyed.length > 0) {
            await out(`rekeyed: ${pushed.rekeyed.join(", ")}\n`);
          }
          // The value was stored and something is still missing — a Tailscale
          // client that mints but cannot list devices. Core returns the
          // sentence; the head is the only thing allowed to print it (rule 1).
          if (pushed.note !== undefined) await out(`warning: ${pushed.note}\n`);
        }
      }),
  );

  secrets.addCommand(
    globals(new Cmd("verify"))
      .description("report which slots exist and which are still placeholders")
      .argument("<name>", "agent name, or _fleet for the fleet-wide Tailscale OAuth slots")
      .action(async (name: string, _opts: unknown, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const input = validate(secretsVerifySchema, { name });
        const report = await ctx.hermetic.secrets.verify(input);
        if (ctx.flags.json) await outJson(report);
        else {
          const lines = report.slots.map(
            (s) =>
              `${s.exists ? (s.placeholder ? "placeholder" : "set        ") : "missing    "}  ${s.path}`,
          );
          if (report.shared !== undefined) {
            lines.push(
              report.shared.current === null
                ? `shared slot ${report.shared.slug}: cannot compare (a slot is empty)`
                : report.shared.current
                  ? `shared slot ${report.shared.slug}: this agent holds the current value`
                  : `shared slot ${report.shared.slug}: STALE — rotate with \`secrets push _fleet --shared ${report.shared.slug} --rekey ${report.name}\``,
            );
          }
          lines.push(report.ok ? "ok" : "INCOMPLETE");
          await out(`${lines.join("\n")}\n`);
          // Not failures, so not on stdout beside the verdict a script reads:
          // a declared-but-empty slot nobody names is worth saying and worth
          // keeping out of the piped output (§8.2).
          for (const warning of report.warnings ?? []) await err(`warning: ${warning}\n`);
        }
      }),
  );

  secrets.addCommand(
    globals(new Cmd("ls"))
      .description("the fleet's shared secret slots: state, who reads them, when they were set")
      .addHelpText(
        "after",
        "\nSTATE:\n" +
          "  set      a value is in the slot\n" +
          "  empty    the slot exists but still holds hermetic's placeholder\n" +
          "  missing  named by settings, but there is no parameter behind it\n" +
          "  orphan   a parameter under /hermetic/<fleet_id>/secrets/ nothing names\n" +
          "\nNo value is ever printed, by this or any other read (§8.3).\n",
      )
      .action(async (_opts: unknown, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const result = await ctx.hermetic.secrets.list(validate(secretsListSchema, {}));
        if (ctx.flags.json) await outJson(result);
        else await out(`${renderSharedSecrets(result)}\n`);
      }),
  );

  secrets.addCommand(
    destructive(new Cmd("rm"))
      .description("delete one shared secret slot")
      .argument("<slug>", "the slug of the shared slot, e.g. nous-key")
      .addHelpText(
        "after",
        "\nRefused while anything in the fleet still reads the slug; core names what\n" +
          "does. Free it by moving those agents onto another provider profile\n" +
          "(`hermetic agent set <name> --provider-profile <id|name>`, then apply) or by\n" +
          "recreating them; a slug a provider profile owns goes with\n" +
          "`hermetic providers rm <id|name>`.\n" +
          "\nAgents already holding a copy keep it — this deletes the fleet's slot, not\n" +
          "theirs.\n",
      )
      .action(async (slug: string, _opts: unknown, cmd: Command) => {
        const ctx = await openCtx(cmd);
        /**
         * Read before asking, so the operator confirms against what the slot
         * *is* — who reads it, whether anything is in it — rather than against
         * a slug they typed. Core re-checks every refusal afterwards.
         */
        const listed = await ctx.hermetic.secrets.list(validate(secretsListSchema, {}));
        const found = listed.secrets.find((s) => s.slug === slug);
        /**
         * Core refuses a slug that does not exist and one a provider still
         * names *without* needing an answer, so neither is worth a ceremony:
         * asking an operator to type a slug back and then saying it was never
         * there spends their one gesture on a delete that could not happen. In
         * both cases the request goes straight through and core says why.
         */
        const refusable = found === undefined || found.used_by.length > 0;
        if (!refusable) {
          await err(
            [
              `shared secret ${slug}`,
              `  ${found.orphan ? "orphan — nothing names it" : found.exists && !found.placeholder ? "holds a value" : "empty"}`,
              "  used by no provider",
              "  agents already holding a copy keep it; future creates fall back to prompting",
              ctx.header,
            ].join("\n") + "\n",
          );
        }
        if (!refusable && !ctx.flags.yes) {
          if (!isInteractive()) {
            throw new HermeticError(
              "CONFIRMATION_REQUIRED",
              `deleting the shared secret ${slug} is irreversible; pass --yes`,
              { slug },
            );
          }
          const typed = await askSecretSlug(slug);
          if (typed !== slug) {
            throw new HermeticError("CONFIRMATION_REQUIRED", `typed slug does not match (${slug})`, {
              slug,
            });
          }
        }
        const result = await ctx.hermetic.secrets.delete(
          validate(secretsDeleteSchema, { slug, yes: true }),
        );
        if (ctx.flags.json) await outJson(result);
        // The slug, not a path this head reconstructs: the slot is fleet-scoped
        // since v3 and core is the only thing that knows which fleet is open.
        else await out(`deleted shared secret ${result.slug}\n`);
      }),
  );

  program.addCommand(secrets);
}
