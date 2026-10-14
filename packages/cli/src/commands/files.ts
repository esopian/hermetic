/**
 * `hermetic files …` — files on an agent's box (§9).
 *
 * Phase 2 has one verb, `files stage`: upload one file to the box's stage area,
 * where a chat turn can attach it by id. `files put`/`ls`/`get`/`rm` follow
 * with agent requests and the Files tab.
 *
 * The file's path and name are positional arguments, and the run log records
 * a command's arguments and output — so `run-log.ts` redacts both for this
 * command: a file's name can be as sensitive as its contents.
 */
import { resolve } from "node:path";
import type { Command } from "commander";
import { Command as Cmd } from "commander";
import { FilesStageInput, HermeticError } from "@hermetic/core";
import type { FilesStageResult } from "@hermetic/core";
import { openCtx } from "../context.ts";
import type { Ctx } from "../context.ts";
import { redactRunOutput } from "../run-log.ts";
import { declare } from "../declare.ts";
import { err, isInteractive, out } from "../io.ts";
import { globals } from "../options.ts";
import { defined, validate } from "../validate.ts";

const stageSchema = declare("files.stage", "files stage", FilesStageInput);

function size(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function pct(progress: number): string {
  return `${String(Math.round(progress * 100)).padStart(3, " ")}%`;
}

/**
 * Stage one file for a chat turn's `--attach`, and answer its id.
 *
 * The `staged …` line goes to stderr, so `chat --json` keeps stdout to the
 * turn's frames; and the run's recorded output is dropped (`redactRunOutput`),
 * because the line names the file.
 */
export async function stageForTurn(
  ctx: Ctx,
  file: { instance: string; path: string; notSecret: boolean; session?: string | undefined },
): Promise<string> {
  redactRunOutput();
  const input = validate(stageSchema, {
    instance: file.instance,
    source: { path: resolve(file.path) },
    ...defined({
      not_secret: file.notSecret ? true : undefined,
      session: file.session,
    }),
  });
  let staged: FilesStageResult | null = null;
  for await (const e of ctx.hermetic.files.stage(input, { signal: ctx.signal })) {
    if (e.type === "staged") staged = e.file;
  }
  if (staged === null) {
    throw new HermeticError("INTERNAL", "the stage ended without the box's answer");
  }
  await err(`staged ${staged.name} ${size(staged.bytes)} sha256 ${staged.sha256.slice(0, 12)}\n`);
  return staged.id;
}

export function register(program: Command): void {
  const files = new Cmd("files").description("files on an agent's box: stage one for a chat turn");

  files.addCommand(
    globals(new Cmd("stage"))
      .description("upload a file to an agent's stage area, for a chat turn to attach by id")
      .argument("<agent>", "the agent whose box receives the file")
      .argument("<path>", "the file on this laptop")
      .option("--name <name>", "the name to store it under (default: the file's own)")
      .option("--not-secret", "send a file that looks like a private key as a normal file")
      .option("--session <id>", "the chat session the file is for")
      .addHelpText(
        "after",
        "\nImages up to 25 MB, other files up to 256 MB. A staged file is deleted after an\n" +
          "hour unless a chat turn commits it to the agent's inbox.\n",
      )
      .action(async (agent: string, path: string, opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const input = validate(stageSchema, {
          instance: agent,
          source: { path: resolve(path) },
          ...defined({
            name: opts["name"] as string | undefined,
            not_secret: opts["notSecret"] === true ? true : undefined,
            session: opts["session"] as string | undefined,
          }),
        });
        const interactive = !ctx.flags.json && isInteractive();
        let staged: FilesStageResult | null = null;
        let lastTenth = -1;
        for await (const e of ctx.hermetic.files.stage(input, { signal: ctx.signal })) {
          if (ctx.flags.json) {
            await out(`${JSON.stringify(e)}\n`);
            if (e.type === "staged") staged = e.file;
            continue;
          }
          if (e.type === "staged") {
            staged = e.file;
            continue;
          }
          const text = `${pct(e.progress)} ${e.phase.padEnd(7, " ")} ${e.message}`;
          if (interactive) {
            await err(`\r${text}\u001b[K`);
          } else {
            // A pipe gets a line per tenth, not one per percent.
            const tenth = Math.floor(e.progress * 10);
            if (tenth !== lastTenth) {
              lastTenth = tenth;
              await err(`${text}\n`);
            }
          }
        }
        if (interactive) await err("\n");
        if (staged === null) {
          throw new HermeticError("INTERNAL", "the stage ended without the box's answer");
        }
        if (ctx.flags.json) return;
        await out(
          `staged ${staged.name} ${size(staged.bytes)} sha256 ${staged.sha256.slice(0, 12)} id ${staged.id}\n`,
        );
      }),
  );

  program.addCommand(files);
}
