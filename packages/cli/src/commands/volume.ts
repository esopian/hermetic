/**
 * `hermetic volume …` (§9). Three commands, three core methods.
 *
 * Volumes outlive the agents that made them — `destroy` keeps the data volume
 * (§6.6) — so this is the only place in the CLI that addresses a resource by
 * its AWS id rather than by an agent name. The name is what got lost.
 *
 * There is no `volume adopt`: putting a new agent on an existing volume is
 * `agent create <name> --volume <id>`, one create path rather than two.
 */
import type { Command } from "commander";
import { Command as Cmd } from "commander";
import { openCtx } from "../context.ts";
import { destructive, globals } from "../options.ts";
import { validate } from "../validate.ts";
import { err, isInteractive, out, outJson } from "../io.ts";
import { renderVolumeStatus, renderVolumes } from "../table.ts";
import { declare } from "../declare.ts";
import { HermeticError } from "@hermetic/core";
import { DeleteVolumeInput, ListVolumesInput, VolumeRefInput } from "@hermetic/core";
import { askVolumeId } from "../confirm.ts";

const listSchema = declare("volumes.list", "volume ls", ListVolumesInput);
const getSchema = declare("volumes.get", "volume status", VolumeRefInput);
const deleteSchema = declare("volumes.delete", "volume delete", DeleteVolumeInput);

export function register(program: Command): void {
  const volume = new Cmd("volume").description(
    "data volumes: what exists, and what nothing is reading",
  );

  volume.addCommand(
    globals(new Cmd("ls"))
      .description("every data volume, grouped by what is reading it")
      .option("--unattached", "only volumes nothing is attached to")
      .addHelpText(
        "after",
        "\nGroups, in the order they print:\n" +
          "  no agent    free, and no live agent row owns it — the reclaimable case\n" +
          "  ambiguous   two volumes carry one agent tag; hermetic will not guess (§1)\n" +
          "  detached    free, but a live agent still owns it — `agent recreate` wants it back\n" +
          "  attached    an instance is reading it\n" +
          "  not this fleet   unattached volumes hermetic did not create; listed because they bill\n" +
          "\nTo put a new agent on one:\n" +
          "  hermetic agent create <name> --volume <volume-id>\n",
      )
      .action(async (opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const input = validate(listSchema, opts["unattached"] === true ? { unattached: true } : {});
        const result = await ctx.hermetic.volumes.list(input);
        if (ctx.flags.json) await outJson(result);
        else await out(`${renderVolumes(result)}\n`);
      }),
  );

  volume.addCommand(
    globals(new Cmd("status"))
      .description("everything known about one volume, with its snapshots")
      .argument("<volume-id>", "EBS volume id, e.g. vol-0c85d3b7f1a94e620")
      .action(async (volumeId: string, _opts: unknown, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const input = validate(getSchema, { volume_id: volumeId });
        const detail = await ctx.hermetic.volumes.get(input);
        if (ctx.flags.json) await outJson(detail);
        else await out(`${renderVolumeStatus(detail)}\n`);
      }),
  );

  volume.addCommand(
    destructive(new Cmd("delete"))
      .description("delete a volume nothing is reading; its snapshots are kept")
      .argument("<volume-id>", "EBS volume id")
      .addHelpText(
        "after",
        "\nOne step and a typed confirmation, the same ceremony `agent destroy --yes` has:\n" +
          "the whole plan is one line, so there is nothing a plan stage could show that\n" +
          "the confirmation does not. It refuses an attached volume, one a live agent row\n" +
          "still owns, an ambiguous one, and any volume hermetic did not create.\n",
      )
      .action(async (volumeId: string, _opts: unknown, cmd: Command) => {
        const ctx = await openCtx(cmd);
        /**
         * Read before asking, so the operator is confirming against what this
         * volume *is* — its agent, its size, its snapshot count — rather than
         * against an id they pasted. Core re-checks every refusal afterwards;
         * this read is for the human.
         */
        const detail = await ctx.hermetic.volumes.get(validate(getSchema, { volume_id: volumeId }));
        await err(
          [
            `volume ${detail.volume_id}`,
            `  ${detail.size_gib} GiB · ${detail.availability_zone ?? "-"} · last tagged agent=${detail.agent ?? "(none)"}`,
            `  ${detail.snapshots} snapshot(s) are kept; the volume itself is not recoverable`,
            `  frees ≈ $${detail.monthly_cost_usd.toFixed(2)}/mo`,
            ctx.header,
          ].join("\n") + "\n",
        );
        if (!ctx.flags.yes) {
          if (!isInteractive()) {
            throw new HermeticError(
              "CONFIRMATION_REQUIRED",
              `deleting ${detail.volume_id} is irreversible; pass --yes`,
              { volume_id: detail.volume_id },
            );
          }
          const typed = await askVolumeId(detail.volume_id);
          if (typed !== detail.volume_id) {
            throw new HermeticError(
              "CONFIRMATION_REQUIRED",
              `typed volume id does not match (${detail.volume_id})`,
              { volume_id: detail.volume_id },
            );
          }
        }
        const result = await ctx.hermetic.volumes.delete(
          validate(deleteSchema, { volume_id: volumeId, yes: true }),
        );
        if (ctx.flags.json) await outJson(result);
        else {
          await out(
            `deleted ${result.volume_id} (${result.size_gib} GiB); ${result.snapshots_kept} snapshot(s) kept; frees ≈ $${result.monthly_saving_usd.toFixed(2)}/mo\n`,
          );
        }
      }),
  );

  program.addCommand(volume);
}
