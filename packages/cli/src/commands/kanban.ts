/** Kanban board commands (§9.2): the same typed JSON input as their RPC counterparts. */
import { Command } from "commander";
import {
  KanbanArchiveInput,
  KanbanAssignInput,
  KanbanBoardInput,
  KanbanCommentInput,
  KanbanCreateInput,
  KanbanDeleteInput,
  KanbanLogInput,
  KanbanMoveInput,
  KanbanTaskInput,
  KanbanUnblockInput,
  HermeticError,
} from "@hermetic/core";
import type { Hermetic } from "@hermetic/core";
import type { ZodType } from "zod";
import { openCtx } from "../context.ts";
import { globals } from "../options.ts";
import { validate } from "../validate.ts";
import { outJson } from "../io.ts";
import { declare } from "../declare.ts";

function readInput(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new HermeticError("VALIDATION", "--input must be a JSON object");
  }
}

type Verb = keyof Hermetic["kanban"];
const VERBS: [Verb, ZodType][] = [
  ["board", KanbanBoardInput],
  ["task", KanbanTaskInput],
  ["log", KanbanLogInput],
  ["create", KanbanCreateInput],
  ["comment", KanbanCommentInput],
  ["unblock", KanbanUnblockInput],
  ["assign", KanbanAssignInput],
  ["move", KanbanMoveInput],
  ["archive", KanbanArchiveInput],
  ["delete", KanbanDeleteInput],
];
const SCHEMAS = VERBS.map(
  ([verb, schema]) => [verb, declare(`kanban.${verb}`, `kanban ${verb}`, schema)] as const,
);

export function register(program: Command) {
  const kanban = globals(new Command("kanban")).description("the Hermes kanban board on each box");
  program.addCommand(kanban);
  for (const [verb, schema] of SCHEMAS)
    kanban.addCommand(
      globals(new Command(verb))
        .description(`kanban.${verb}`)
        .option("--input <json>", "typed request JSON; instance and id identify the card", "{}")
        .action(async (opts, cmd) => {
          const ctx = await openCtx(cmd);
          const call = ctx.hermetic.kanban[verb] as (
            i: unknown,
            o: { signal: AbortSignal },
          ) => Promise<unknown>;
          await outJson(await call(validate(schema, readInput(opts.input)), { signal: ctx.signal }));
        }),
    );
}
