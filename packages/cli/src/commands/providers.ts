/**
 * `hermetic providers …` (§8.3): the fleet's named provider profiles, and the
 * per-provider entry that predates them.
 *
 * Five commands over five core methods, in one file because they are one
 * subject. Two of them write a credential, and neither takes it as a flag
 * *value*: `hermetic runs` records a command's arguments in SQLite and a shell
 * records them in its history, so a key is read from a password prompt or from
 * stdin (`secret.ts`) exactly as `agent create` and `secrets push` read theirs.
 *
 * **Why the write is `providers update` and not `providers set`.** The
 * pre-profile `providers set <provider>` wrote `settings.providers[<provider>]`
 * — a member of the provider enum — and a profile is a different object with a
 * different key space (an id or a name). It kept its own verb rather than
 * overloading one argument position with two vocabularies, and now that the
 * legacy command is gone the verb stays as the one every operator has learnt.
 */
import type { Command } from "commander";
import { Command as Cmd } from "commander";
import { openCtx } from "../context.ts";
import { globals } from "../options.ts";
import { defined, toInt, validate } from "../validate.ts";
import { isInteractive, out, outJson } from "../io.ts";
import { readSecret } from "../secret.ts";
import { renderModels, renderProfile, renderProfiles } from "../table.ts";
import { declare } from "../declare.ts";
import { HermeticError, PROVIDERS } from "@hermetic/core";
import {
  ProvidersCreateInput,
  ProvidersDeleteInput,
  ProvidersListInput,
  ProvidersModelsInput,
  ProvidersUpdateInput,
} from "@hermetic/core";
import type { Provider } from "@hermetic/core";

const listSchema = declare("providers.list", "providers ls", ProvidersListInput);
const createSchema = declare("providers.create", "providers create", ProvidersCreateInput);
const updateSchema = declare("providers.update", "providers update", ProvidersUpdateInput);
const deleteSchema = declare("providers.delete", "providers rm", ProvidersDeleteInput);
const modelsSchema = declare("providers.models", "providers models", ProvidersModelsInput);

const PROVIDER_LIST = Object.keys(PROVIDERS).join(" | ");

/** `--expected-version 3`, shared by every write here. */
function expected(opts: Record<string, unknown>): { expected_version?: number } {
  const n = toInt(opts["expectedVersion"] as string | undefined);
  return n === undefined ? {} : { expected_version: n };
}

/**
 * The key, if the operator is offering one. Never a flag value (§8.3):
 * `--api-key-stdin` reads the pipe, an interactive terminal is prompted, and a
 * non-interactive run with neither simply creates a profile that is not ready
 * yet — model discovery is not a prerequisite for saving a credential, and
 * neither is a credential a prerequisite for saving a profile.
 */
async function apiKey(
  provider: Provider,
  opts: Record<string, unknown>,
  prompt: string,
): Promise<string | undefined> {
  if (PROVIDERS[provider].env === null) return undefined;
  if (opts["apiKeyStdin"] === true) {
    const value = await readSecret(prompt);
    return value.length === 0 ? undefined : value;
  }
  // Commander spells `--no-key` as `key: false`, not `noKey: true`. Reading the
  // camel-cased name meant the flag did nothing on a TTY: the prompt still
  // appeared, which is the one thing it exists to suppress.
  if (opts["key"] === false || !isInteractive()) return undefined;
  const value = await readSecret(prompt);
  return value.length === 0 ? undefined : value;
}

export function register(program: Command): void {
  const providers = new Cmd("providers").description(
    "the fleet's provider profiles: named credentials an agent is created against",
  );

  providers.addCommand(
    globals(new Cmd("ls"))
      .description("every provider profile: model, readiness, linked agents, fleet default")
      .addHelpText(
        "after",
        "\nREADY is whether an agent can be created on this profile. `no (key-missing)`\n" +
          "and `no (key-placeholder)` are a slot nobody has filled; `no (grant-missing)`\n" +
          "is a Bedrock model this fleet's instance role may not invoke yet, fixed by\n" +
          "`hermetic foundation update`. A stored key is never a verified one.\n",
      )
      .action(async (_opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const result = await ctx.hermetic.providers.list(validate(listSchema, {}));
        if (ctx.flags.json) await outJson(result);
        else await out(`${renderProfiles(result)}\n`);
      }),
  );

  providers.addCommand(
    globals(new Cmd("create"))
      .description("create a named provider profile and store its key")
      .requiredOption("--provider <provider>", PROVIDER_LIST)
      .requiredOption("--name <name>", "what to call this profile, unique on the fleet")
      .option("--model <id>", "model this profile defaults to; omitted takes the catalog's")
      .option("--api-key-stdin", "read the provider's API key from stdin instead of prompting")
      .option("--no-key", "create the profile without a key; it is not ready until one is pushed")
      .option("--disabled", "create it disabled, so `agent create` does not offer it")
      .option("--default", "make this the fleet's default profile")
      .option("--expected-version <n>", "refuse unless the settings are still at this version")
      .addHelpText(
        "after",
        "\nThe key is never a flag value — `hermetic runs` records a command's arguments\n" +
          "and a shell records its history — so it is read from a password prompt or\n" +
          "stdin and written straight to the fleet's own SSM slot (§8.3).\n" +
          "\nExamples:\n" +
          "  hermetic providers create --provider anthropic --name main --default\n" +
          "  cat key.txt | hermetic providers create --provider vercel --name gw --api-key-stdin\n" +
          "  hermetic providers create --provider bedrock --name role --model zai.glm-4.7-flash\n",
      )
      .action(async (opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const provider = opts["provider"] as Provider;
        // A `--provider` the enum does not know is a usage error, and the
        // schema below says so — prompting for a key first would ask for
        // something moments before the command fails.
        const key =
          PROVIDERS[provider] === undefined
            ? undefined
            : await apiKey(provider, opts, `${PROVIDERS[provider].env} for ${String(opts["name"])}`);
        const input = validate(
          createSchema,
          defined({
            provider,
            name: opts["name"],
            model: opts["model"],
            api_key: key,
            enabled: opts["disabled"] === true ? false : undefined,
            default: opts["default"] === true ? true : undefined,
            ...expected(opts),
          }),
        );
        const result = await ctx.hermetic.providers.create(input);
        if (ctx.flags.json) await outJson(result);
        else await out(`${renderProfile(result)}\n`);
      }),
  );

  providers.addCommand(
    globals(new Cmd("update"))
      .description("rename, re-model, enable, disable, rotate the key of, or default one profile")
      .argument("<profile>", "profile id or name")
      .option("--name <name>", "rename the profile")
      .option("--model <id>", "the model this profile resolves to")
      .option("--enable", "offer this profile to `agent create`")
      .option("--disable", "hide it; the fleet default profile may not be disabled")
      .option("--api-key-stdin", "rotate the key, read from stdin instead of prompting")
      .option("--rotate-key", "rotate the key, prompting for it")
      .option("--default", "make this the fleet's default profile")
      .option("--provider <provider>", "refused: a profile's provider is immutable")
      .option("--expected-version <n>", "refuse unless the settings are still at this version")
      .addHelpText(
        "after",
        "\nEvery change bumps the profile's revision, the key rotation included: an\n" +
          "agent pinned to an older revision is stale the moment anything moves.\n" +
          "A model set here is persisted exactly as given and is never re-derived from\n" +
          "a catalog read, so refreshing the picker cannot move it (§8.3).\n",
      )
      .action(async (profile: string, opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        if (opts["provider"] !== undefined) {
          throw new HermeticError(
            "VALIDATION",
            "a profile's provider is immutable; create a second profile instead",
            { profile },
          );
        }
        const rotate = opts["apiKeyStdin"] === true || opts["rotateKey"] === true;
        const key = rotate ? await readSecret(`new API key for ${profile}`) : undefined;
        const enabled = opts["disable"] === true ? false : opts["enable"] === true ? true : undefined;
        const input = validate(
          updateSchema,
          defined({
            profile,
            name: opts["name"],
            model: opts["model"],
            enabled,
            api_key: key === undefined || key.length === 0 ? undefined : key,
            default: opts["default"] === true ? true : undefined,
            ...expected(opts),
          }),
        );
        const result = await ctx.hermetic.providers.update(input);
        if (ctx.flags.json) await outJson(result);
        else await out(`${renderProfile(result)}\n`);
      }),
  );

  providers.addCommand(
    globals(new Cmd("rm"))
      .description("delete a provider profile and the credential slot it owns")
      .argument("<profile>", "profile id or name")
      .option("--yes", "skip the confirmation")
      .addHelpText(
        "after",
        "\nRefused while any agent still runs on the profile, and while it is the\n" +
          "fleet default. The slot it deletes is the one the profile owns; a slot the\n" +
          "profile merely inherited from the pre-profile settings is left alone.\n",
      )
      .action(async (profile: string, opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const input = validate(deleteSchema, defined({ profile, yes: opts["yes"] }));
        const result = await ctx.hermetic.providers.delete(input);
        if (ctx.flags.json) await outJson(result);
        else await out(`removed profile ${result.name} (${result.id})\n`);
      }),
  );

  providers.addCommand(
    globals(new Cmd("models"))
      .description("the provider's live model catalog, for a saved profile or a draft key")
      .option("--profile <profile>", "a saved profile, by id or name")
      .option("--provider <provider>", PROVIDER_LIST)
      .option("--api-key-stdin", "read a draft key from stdin; goes with --provider")
      .addHelpText(
        "after",
        "\nA read of somebody else's service, nothing more: it stores nothing, caches\n" +
          "nothing, and cannot move a profile's model. The selected model is listed\n" +
          "first, and an id the provider's catalog does not contain is marked\n" +
          "`unlisted` rather than dropped.\n" +
          "\nExamples:\n" +
          "  hermetic providers models --profile main\n" +
          "  cat key.txt | hermetic providers models --provider openai --api-key-stdin\n",
      )
      .action(async (opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const key =
          opts["apiKeyStdin"] === true ? await readSecret("API key for the catalog read") : undefined;
        const input = validate(
          modelsSchema,
          defined({
            profile: opts["profile"],
            provider: opts["provider"],
            api_key: key === undefined || key.length === 0 ? undefined : key,
          }),
        );
        const result = await ctx.hermetic.providers.models(input);
        if (ctx.flags.json) await outJson(result);
        else await out(`${renderModels(result)}\n`);
      }),
  );

  program.addCommand(providers);
}
