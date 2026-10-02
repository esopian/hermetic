/**
 * `hermetic agent …` (§9). One command per core method, one Zod schema
 * each — imported from the registry so the parity test and the runtime agree.
 */
import type { Command } from "commander";
import { Command as Cmd } from "commander";
import { openCtx } from "../context.ts";
import { destructive, globals } from "../options.ts";
import { defined, toInt, validate } from "../validate.ts";
import { err, out, outJson } from "../io.ts";
import {
  renderDesktop,
  renderDestroyed,
  renderHistory,
  renderLooseVolumes,
  renderProbe,
  renderPs,
  renderStatus,
} from "../table.ts";
import { renderOp } from "../stream.ts";
import { assertConfirmable, confirmPlan } from "../confirm.ts";
import { declare } from "../declare.ts";
import { HermeticError, ROOT_GIB_MAX, ROOT_GIB_MIN, resolveCreatePreset } from "@hermetic/core";
import type { HermesSettings, PresetsView, ResolvedCreatePreset } from "@hermetic/core";
import {
  AgentRefInput,
  CreateAgentInput,
  DestroyAgentInput,
  HistoryInput,
  ListAgentsInput,
  ListDestroyedInput,
  PlanDestroyInput,
  PlanRecreateInput,
  RecreateAgentInput,
  RerunInput,
  SetAgentInput,
} from "@hermetic/core";

/**
 * The flags that configure Hermes itself, shared by `create` and `set` so the
 * two cannot drift into spelling the same setting differently.
 */
function hermesOptions(cmd: Cmd): Cmd {
  return cmd
    .option(
      "--model <id>",
      "model id, spelled the way the provider spells it (default: the provider's)",
    )
    .option("--terminal <backend>", "how the terminal tool runs commands: local | docker")
    .option("--max-turns <n>", "ceiling on tool-calling turns in one agent run")
    .option("--reasoning <effort>", "low | medium | high")
    .option("--approvals <mode>", "smart | manual | off (default off)")
    .addHelpText(
      "after",
      "\nA setting you name here is one hermetic holds: it is written to the agent's\n" +
        "managed config on every apply and cannot be changed on the box. A setting you\n" +
        "leave out is seeded once with the fleet default and is then the agent's own,\n" +
        "changeable from its dashboard.\n" +
        "\n--approvals is the exception: it is written to the agent's own config rather\n" +
        "than the managed one, so it can still be changed on the box, and hermetic\n" +
        "re-asserts it only when you change the answer here.\n",
    );
}

/**
 * Gather those flags into the one nested object the schema takes, or
 * `undefined` when none were given — which is not the same as an empty object.
 * Naming nothing means hermetic manages nothing here; that is what puts these
 * settings in the seed rather than the managed config.
 */
function hermesFrom(
  opts: Record<string, unknown>,
  choice: { omitModel?: boolean } = {},
): HermesSettings | undefined {
  const settings = defined({
    // `agent set` sends the model at the top level instead (§8.3): with a
    // profile change staged it belongs to the staged binding, not to the
    // running configuration, and core is where that distinction is made.
    model: choice.omitModel === true ? undefined : opts["model"],
    terminal_backend: opts["terminal"],
    max_turns: toInt(opts["maxTurns"] as string | undefined),
    reasoning_effort: opts["reasoning"],
    // Seed-only, stated or not (`SEED_ONLY` in `schema/hermes.ts`): naming it
    // moves the seed hermetic writes, it never makes the mode a managed key.
    approvals_mode: opts["approvals"],
  });
  return Object.keys(settings).length === 0 ? undefined : (settings as HermesSettings);
}

// Each command records the schema it validates with as it declares itself, and
// uses that same binding below (§11.4).
const createSchema = declare("agents.create", "agent create", CreateAgentInput);

/**
 * Commander's parsed options for `agent create`, as the one `CreateAgentInput`
 * core is handed.
 *
 * Lifted out of the action so the mapping is nameable from a test. A flag
 * nobody typed is *absent* — `defined` drops every `undefined` — and what
 * fills the machine fields instead is this laptop's create presets (§4.6):
 * `--preset <id|name>` names one, and with neither it nor any machine flag the
 * laptop's default preset applies, the same one the New agent panel opens on
 * (`createPresetFor`). Everything a preset does not govern (secrets, profile)
 * is still omitted and inherited from the fleet's `defaults` (§4.6, §10).
 *
 * `presets` is `null` only where a caller has no laptop to read them from — a
 * test of the plain mapping — and then `--preset` is refused rather than
 * ignored. `tests/create-parity.test.ts` holds this against the create drawer,
 * which has the same obligation.
 */
export function createInputFrom(
  name: string,
  opts: Record<string, unknown>,
  presets: PresetsView | null = null,
) {
  const machine = presets === null ? noPreset(opts) : createPresetFor(opts, presets).machine;
  return validate(createSchema, {
    ...machine,
    ...defined({
      name,
      size: opts["size"],
      instance_type: opts["instanceType"],
      provider: opts["provider"],
      provider_profile: opts["providerProfile"],
      secrets: opts["secrets"],
      volume_gib: toInt(opts["volumeGib"] as string | undefined),
      root_gib: toInt(opts["rootGib"] as string | undefined),
      volume_id: opts["volume"],
      rollback_on_failure: opts["rollbackOnFailure"],
      hermes: hermesFrom(opts),
    }),
  });
}

function noPreset(opts: Record<string, unknown>): Record<string, never> {
  if (opts["preset"] !== undefined) {
    throw new HermeticError("VALIDATION", "--preset needs this laptop's create presets");
  }
  return {};
}

/**
 * Which preset `agent create` applies, and the fields it fills: core's rule
 * (`resolveCreatePreset`), fed the flags as typed. A stated `--size`,
 * `--instance-type`, `--volume-gib` or `--root-gib` wins over the preset's
 * value for that field, and `--volume` means the preset never sets the data
 * volume. Core receives the three fields explicitly and never learns a preset
 * was involved.
 */
export function createPresetFor(
  opts: Record<string, unknown>,
  presets: PresetsView,
): ResolvedCreatePreset {
  const str = (k: string) => (typeof opts[k] === "string" ? (opts[k] as string) : undefined);
  return resolveCreatePreset(presets, {
    preset: str("preset"),
    size: str("size"),
    instance_type: str("instanceType"),
    volume_gib: toInt(str("volumeGib")),
    root_gib: toInt(str("rootGib")),
    volume_id: str("volume"),
  });
}
const listSchema = declare("agents.list", "agent ps", ListAgentsInput);
const getSchema = declare("agents.get", "agent status", AgentRefInput);
const setSchema = declare("agents.set", "agent set", SetAgentInput);
const stopSchema = declare("agents.stop", "agent stop", AgentRefInput);
const startSchema = declare("agents.start", "agent start", AgentRefInput);
const rebootSchema = declare("agents.reboot", "agent reboot", AgentRefInput);
const recreateSchema = declare("agents.recreate", "agent recreate", RecreateAgentInput);
const destroySchema = declare("agents.destroy", "agent destroy", DestroyAgentInput);
const historySchema = declare("agents.history", "agent history", HistoryInput);
const destroyedSchema = declare("agents.destroyed", "agent destroyed", ListDestroyedInput);
const rerunSchema = declare("agents.rerun", "agent rerun", RerunInput);
/** Name-only and read-only, so the same object `agent status` validates (§9). */
const probeSchema = declare("agents.probe", "agent probe", AgentRefInput);
/** §7.4's Desktop attach details. Name-only and read-only, like `probe`. */
const desktopSchema = declare("agents.desktop", "agent desktop", AgentRefInput);

export function register(program: Command): void {
  const agent = new Cmd("agent").description("create, inspect and operate agents");

  agent.addCommand(
    hermesOptions(globals(new Cmd("create")))
      .description("create an agent")
      .argument("<name>", "agent name")
      .option(
        "--preset <id|name>",
        "a create preset (`hermetic presets show`); default: this laptop's default preset",
      )
      .option(
        "--size <size>",
        "micro | xxsmall | xsmall | small | medium | large | xlarge | xxlarge | 3xlarge | gpu-xsmall..gpu-xlarge; overrides the preset",
      )
      .option("--instance-type <type>", "raw EC2 instance type, overrides --size")
      .option(
        "--provider-profile <id|name>",
        "the provider profile this agent runs on (`hermetic providers ls`)",
      )
      .option(
        "--provider <provider>",
        "bedrock | anthropic | openrouter | nous | openai | vercel — shorthand for this fleet's profile of that provider",
      )
      .option("--secrets <mode>", "none | bitwarden")
      .option("--volume-gib <gib>", "data volume size in GiB; overrides the preset")
      .option(
        "--root-gib <gib>",
        `root (system) disk size in GiB, ${ROOT_GIB_MIN}-${ROOT_GIB_MAX}; replaced with the instance; overrides the preset`,
      )
      .option(
        "--volume <volume-id>",
        "build on an existing data volume instead of creating one (`hermetic volume ls`)",
      )
      .option(
        "--rollback-on-failure",
        "if the create fails, undo everything it made instead of leaving it for a re-run (an interrupt still leaves it resumable)",
      )
      .addHelpText(
        "after",
        "\nExamples:\n" +
          "  hermetic agent create atlas                             this laptop's default preset, the fleet's default profile\n" +
          "  hermetic agent create atlas --preset heavy              a preset from `hermetic presets show`\n" +
          "  hermetic agent create atlas --preset heavy --root-gib 80   a preset with one field changed\n" +
          "  hermetic agent create atlas --provider-profile openrouter-cheap\n" +
          "  hermetic agent create atlas --provider nous             the fleet's nous profile, if it has exactly one\n" +
          "  hermetic agent create atlas --secrets bitwarden\n" +
          "  hermetic agent create cinder-2 --volume vol-0c85d3b7f1a94e620   reuse a destroyed agent's memory\n" +
          "  hermetic --fixture agent create atlas                   against the seeded fixture fleet\n" +
          "\nThe machine (size, data volume, system disk) comes from this laptop's create\n" +
          "presets unless you name it: --preset, else the default preset when no machine\n" +
          "flag is given. A machine flag overrides the preset's value for that field, and\n" +
          "--volume keeps the volume's own size. Everything else left out comes from the\n" +
          "fleet's defaults (`hermetic settings show`).\n" +
          "\nThere is no key to type. A credential belongs to a provider profile:\n" +
          "  hermetic providers create --provider openrouter --name cheap --api-key-stdin\n",
      )
      .action(async (name: string, opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        /**
         * §8.3: **no key is asked for, ever.**
         *
         * A create used to prompt, because the one moment the operator was
         * already here was create. Credentials belong to provider profiles now:
         * the fleet holds the key, core resolves it from the profile this agent
         * is bound to, and a prompt here would be asking for something nobody
         * needs to type — or, worse, would produce a key that no profile owns
         * and no rotation reaches. `hermetic providers create --api-key-stdin`
         * is the one place a key is read.
         */
        const presets = await ctx.hermetic.presets.get({});
        const input = createInputFrom(name, opts, presets);
        const skipped = createPresetFor(opts, presets).skipped_default;
        if (skipped !== null) {
          await err(
            `default preset ${skipped.id} names size ${skipped.size}, which this build does not know; the machine comes from the fleet's defaults\n`,
          );
        }
        await renderOp(ctx.hermetic.agents.create(input, { signal: ctx.signal }), {
          flags: ctx.flags,
          label: `agent create ${input.name}`,
        });
      }),
  );

  agent.addCommand(
    globals(new Cmd("ps"))
      .description("fleet table: status, health, heartbeat age, versions, lock")
      .option("--status <status>", "only agents in this display status")
      .addHelpText(
        "after",
        "\nA destroyed agent has no row here: it is reviewed with `hermetic agent destroyed`.\n",
      )
      .action(async (opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const input = validate(listSchema, defined({ status: opts["status"] }));
        const agents = await ctx.hermetic.agents.list(input);
        if (ctx.flags.json) {
          await outJson(agents);
          return;
        }
        await out(`${renderPs(agents)}\n`);
        /**
         * The one thing the fleet table cannot say: a volume with no agent is
         * not a row, so it has nowhere to appear. It prints only when something
         * is loose, goes to stderr so a pipe stays clean, and never fails the
         * command — `agent ps` answering about agents does not depend on a
         * second read succeeding.
         */
        try {
          const loose = renderLooseVolumes(await ctx.hermetic.volumes.list({}));
          if (loose) await err(`\n${loose}\n`);
        } catch {
          // A volume read that fails is a `hermetic volume ls` problem, not a
          // reason to make `agent ps` look broken.
        }
      }),
  );

  agent.addCommand(
    globals(new Cmd("status"))
      .description("everything known about one agent")
      .argument("<name>", "agent name")
      .action(async (name: string, _opts: unknown, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const input = validate(getSchema, { name });
        const agent = await ctx.hermetic.agents.get(input.name);
        if (ctx.flags.json) await outJson(agent);
        else
          await out(
            `${renderStatus(agent, ctx.config.fleet_id, ctx.config.fleet_name ?? undefined)}\n`,
          );
      }),
  );

  agent.addCommand(
    globals(new Cmd("probe"))
      .description("actively check an agent: EC2, hermeticd over the tailnet, and its dashboard")
      .argument("<name>", "agent name")
      .addHelpText(
        "after",
        [
          "",
          "`ps` calls an agent `unreachable` when its heartbeat is stale — one word for",
          "a stopped box, a dead hermeticd, a broken heartbeat write and a laptop that is",
          "off the tailnet. `probe` asks each layer directly and says which one it is.",
          "",
          "It writes nothing: no row update, no event, no lock. A layer that does not",
          "answer is reported, not thrown — the exit code is 0 unless the agent is",
          "missing or the account guard refuses.",
        ].join("\n"),
      )
      .action(async (name: string, _opts: unknown, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const input = validate(probeSchema, { name });
        const report = await ctx.hermetic.agents.probe(input.name, { signal: ctx.signal });
        if (ctx.flags.json) await outJson(report);
        else await out(`${renderProbe(report)}\n`);
      }),
  );

  agent.addCommand(
    globals(new Cmd("desktop"))
      .description("the address and session token Hermes Desktop attaches with")
      .argument("<name>", "agent name")
      .addHelpText(
        "after",
        [
          "",
          "Desktop's remote-gateway form wants two things and can discover neither: the",
          "box's Serve URL, and the dashboard session token. It scrapes that token only",
          "from a backend it started itself, so a remote gateway with none saved passes",
          "the connection test — which skips the WebSocket leg — and fails the real",
          "connection.",
          "",
          "The token belongs to the box's running dashboard process. A reboot, an apply,",
          "`agent recreate` or a Hermes update mints a new one; run this again then.",
        ].join("\n"),
      )
      .action(async (name: string, _opts: unknown, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const input = validate(desktopSchema, { name });
        const attach = await ctx.hermetic.agents.desktop(input, { signal: ctx.signal });
        if (ctx.flags.json) await outJson(attach);
        else await out(`${renderDesktop(attach)}\n`);
      }),
  );

  agent.addCommand(
    globals(new Cmd("rerun"))
      .description("re-run the bootstrap stages that are not ok, from the first failure")
      .argument("<name>", "agent name")
      .addHelpText(
        "after",
        [
          "",
          "Only an agent in `error` has stages to resume. hermetic writes the request",
          "on the agent's row; the box picks it up within about ten seconds and",
          "`hermetic agent status <name>` shows the stages moving.",
        ].join("\n"),
      )
      .action(async (name: string, _opts: unknown, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const input = validate(rerunSchema, { name });
        const agent = await ctx.hermetic.agents.rerun(input);
        if (ctx.flags.json) await outJson(agent);
        else {
          const failed = agent.bootstrap?.stages.find((s) => s.status === "failed");
          await out(
            `rerun requested for ${agent.name}${failed ? ` from ${failed.id}` : ""}; hermeticd picks it up on its next poll\n`,
          );
        }
      }),
  );

  agent.addCommand(
    globals(new Cmd("reboot"))
      .description("reboot the agent's instance; same box, same disks")
      .argument("<name>", "agent name")
      .addHelpText(
        "after",
        [
          "",
          "An OS reboot of the instance the agent already has — it keeps its instance",
          "id, its root disk, its data volume and its tailnet address. Use it for a box",
          "that has wedged. `agent recreate` is the from-scratch rebuild; `agent stop`",
          "then `agent start` powers the same box off and on.",
        ].join("\n"),
      )
      .action(async (name: string, _opts: unknown, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const input = validate(rebootSchema, { name });
        const agent = await ctx.hermetic.agents.reboot(input);
        if (ctx.flags.json) await outJson(agent);
        else await out(`${agent.name} rebooting; it heartbeats again once the box is back up\n`);
      }),
  );

  agent.addCommand(
    hermesOptions(globals(new Cmd("set")))
      .description("change an agent's settings; takes effect on the next rerun or recreate")
      .argument("<name>", "agent name")
      .option("--secrets <mode>", "none | bitwarden")
      .option(
        "--provider-profile <id|name>",
        "move this agent onto another provider profile; staged until `hermetic apply`",
      )
      .option(
        "--refresh-profile",
        "re-pin the profile this agent is already on at its latest revision (a rotated key, an edited model)",
      )
      .option(
        "--provider <provider>",
        "bedrock | anthropic | openrouter | nous | openai | vercel — shorthand for this fleet's profile of that provider",
      )
      .option(
        "--size <size>",
        "micro | xxsmall | xsmall | small | medium | large | xlarge | xxlarge | 3xlarge | gpu-xsmall..gpu-xlarge",
      )
      .option("--instance-type <type>", "raw EC2 instance type")
      .option(
        "--root-gib <gib>",
        `root (system) disk size in GiB, ${ROOT_GIB_MIN}-${ROOT_GIB_MAX}; applied by the next recreate`,
      )
      .option("--hermes-version <version>", "pin a hermes version")
      .option(
        "--expected-version <n>",
        "refuse unless the agent row is still at this version (`agent status --json` prints it)",
      )
      .addHelpText(
        "after",
        "\nA provider change is saved, not applied: `hermetic plan rollout <name>` shows\n" +
          "what it will do and `hermetic apply` performs it — copying the credential,\n" +
          "re-rendering the configuration and restarting Hermes on the box.\n",
      )
      .action(async (name: string, opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const input = validate(
          setSchema,
          defined({
            name,
            /**
             * §8.3: the row the operator was looking at. Absent unless they
             * passed it, so a one-shot `agent set` is unchanged; passed, it
             * turns a silent overwrite of somebody else's staging into a
             * `CONFLICT` they can re-read from.
             */
            expected_version: toInt(opts["expectedVersion"] as string | undefined),
            secrets: opts["secrets"],
            provider: opts["provider"],
            provider_profile: opts["providerProfile"],
            refresh_profile: opts["refreshProfile"],
            /**
             * §8.3: the model is stated at the top level on `set`, not folded
             * into `hermes`, because with a profile change staged it is the
             * *staged* model rather than a managed setting on the running
             * configuration. Core makes that distinction; the flag is the same
             * one either way (`hermesOptions`).
             */
            model: opts["model"],
            size: opts["size"],
            instance_type: opts["instanceType"],
            root_gib: toInt(opts["rootGib"] as string | undefined),
            hermes_version: opts["hermesVersion"],
            hermes: hermesFrom(opts, { omitModel: true }),
          }),
        );
        const agent = await ctx.hermetic.agents.set(input);
        if (ctx.flags.json) {
          await outJson(agent);
          return;
        }
        await out(`${renderStatus(agent, ctx.config.fleet_id, ctx.config.fleet_name ?? undefined)}\n`);
        if (agent.pending !== null && agent.pending !== undefined) {
          await err(
            `saved — pending apply: profile ${agent.pending.profile_id} r${agent.pending.profile_revision}, model ${agent.pending.model}. ` +
              `Run \`hermetic apply\` (\`hermetic plan rollout ${agent.name}\` first) to perform it.\n`,
          );
        }
      }),
  );

  /**
   * The two reversible verbs, and the only lifecycle commands here that ask
   * nothing before acting. `destroy` and `recreate` go through the plan/confirm
   * ceremony (§3.2 rule 3) because they throw something away: a volume, or the
   * instance and everything on its root disk. `stop` and `start` throw nothing
   * away — the box powers off and on, the data volume and the row survive, and
   * the mistake is undone by typing the other one. A confirmation prompt in
   * front of a reversible action is a prompt an operator learns to hit `y` on
   * without reading, which is how the prompts in front of the irreversible ones
   * stop working.
   */
  for (const verb of ["stop", "start"] as const) {
    agent.addCommand(
      globals(new Cmd(verb))
        .description(`${verb} an agent's instance`)
        .argument("<name>", "agent name")
        .action(async (name: string, _opts: unknown, cmd: Command) => {
          const ctx = await openCtx(cmd);
          const input = validate(verb === "stop" ? stopSchema : startSchema, { name });
          const op =
            verb === "stop"
              ? ctx.hermetic.agents.stop(input.name, { signal: ctx.signal })
              : ctx.hermetic.agents.start(input.name, { signal: ctx.signal });
          await renderOp(op, { flags: ctx.flags, label: `agent ${verb} ${input.name}` });
        }),
    );
  }

  agent.addCommand(
    destructive(new Cmd("recreate"))
      .description("replace the instance, keep the data volume")
      .argument("<name>", "agent name")
      .action(async (name: string, _opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        // Recreate throws the instance away and reboots onto the same volume:
        // destructive enough to confirm, like destroy (§3.2 rule 3).
        assertConfirmable(ctx, `recreate ${name}?`);
        const input = validate(recreateSchema, { name, yes: true });
        const plan = await ctx.hermetic.plan.recreate(validate(PlanRecreateInput, { name }));
        await confirmPlan(ctx, plan, `recreate ${input.name}?`);
        await renderOp(ctx.hermetic.agents.recreate(input, { signal: ctx.signal }), {
          flags: ctx.flags,
          label: `agent recreate ${input.name}`,
        });
      }),
  );

  agent.addCommand(
    destructive(new Cmd("destroy"))
      .description("terminate the instance and delete this agent's resources")
      .argument("<name>", "agent name")
      .option("--keep-volume", "keep the data volume, released from the name")
      .addHelpText(
        "after",
        "\nBy default destroy deletes the data volume along with the instance; only the\n" +
          "agent's history survives (`hermetic agent destroyed`). --keep-volume leaves\n" +
          "the volume behind, released from the name (tagged hermetic:former_agent), so a\n" +
          "later create of the same name starts fresh; adopt it on purpose with\n" +
          "`hermetic agent create <name> --volume vol-…`.\n",
      )
      .action(async (name: string, opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const keepVolume = opts["keepVolume"] === true;
        assertConfirmable(ctx, `destroy ${name}?`);
        // Validate first, then plan, then confirm: an operator with no way to
        // answer must not make core do work it will refuse anyway.
        const input = validate(destroySchema, {
          name,
          yes: true,
          ...(keepVolume ? { keep_volume: true } : {}),
        });
        const plan = await ctx.hermetic.plan.destroy(
          validate(PlanDestroyInput, defined({ name, keep_volume: keepVolume || undefined })),
        );
        await confirmPlan(ctx, plan, `destroy ${input.name}?`);
        await renderOp(ctx.hermetic.agents.destroy(input, { signal: ctx.signal }), {
          flags: ctx.flags,
          label: `agent destroy ${input.name}`,
        });
      }),
  );

  agent.addCommand(
    globals(new Cmd("history"))
      .description("the append-only event log for one agent")
      .argument("<name>", "agent name")
      .option("--limit <n>", "most recent N events")
      .option("--since <iso>", "only events at or after this instant (ISO 8601)")
      .option("--until <iso>", "only events at or before this instant (ISO 8601)")
      .addHelpText(
        "after",
        "\nA reused name's log holds every incarnation back to back. Pass a tombstone's\n" +
          "created_at and destroyed_at (`hermetic agent destroyed <name> --json`) as\n" +
          "--since/--until to read one life alone.\n",
      )
      .action(async (name: string, opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const input = validate(
          historySchema,
          defined({
            name,
            limit: toInt(opts["limit"] as string | undefined),
            since: opts["since"],
            until: opts["until"],
          }),
        );
        const events = await ctx.hermetic.agents.history(input);
        if (ctx.flags.json) await outJson(events);
        else await out(`${renderHistory(events)}\n`);
      }),
  );

  agent.addCommand(
    globals(new Cmd("destroyed"))
      .description("destroyed agents, newest first: when, by whom, and what became of the volume")
      .argument("[name]", "only this name's incarnations")
      .option("--limit <n>", "most recent N records")
      .action(async (name: string | undefined, opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const input = validate(
          destroyedSchema,
          defined({ name, limit: toInt(opts["limit"] as string | undefined) }),
        );
        const tombstones = await ctx.hermetic.agents.destroyed(input);
        if (ctx.flags.json) await outJson(tombstones);
        else await out(`${renderDestroyed(tombstones)}\n`);
      }),
  );

  program.addCommand(agent);
}
