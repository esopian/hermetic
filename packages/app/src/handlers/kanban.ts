/**
 * The kanban board (§9.2): ten methods over one box's kanban plugin, each
 * validated, bound to the fleet the request names (§4.7, `target.ts`) and
 * handed the caller's abort signal. Writes are refused while the fleet is not
 * writable (`requireWritable`), as every other write is.
 */
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
} from "@hermetic/core";
import type { Hermetic, PublicMethod } from "@hermetic/core";
import type { ZodType } from "zod";
import { declareRpc } from "../declare.ts";
import { requireTarget, withTarget } from "../target.ts";
import { parseInput } from "../validation.ts";
import type { HandlerContext } from "./ctx.ts";
import type { Handler } from "./dispatch.ts";
import { requireWritable } from "./shared.ts";

/** One method's handler; typed on the core call's own result, which `rpc/schema.ts` reads. */
function kanban<S extends ZodType, R>(
  path: PublicMethod,
  schema: S,
  write: boolean,
  call: (h: Hermetic, input: ReturnType<S["parse"]>, opts: { signal?: AbortSignal }) => Promise<R>,
) {
  const body = withTarget(declareRpc(path, schema));
  return async (ctx: HandlerContext, params: unknown): Promise<R> => {
    const { hermetic: h, input } = requireTarget(ctx.state, parseInput(body, params));
    if (write) requireWritable(ctx.state);
    return await call(h, input as ReturnType<S["parse"]>, { signal: ctx.signal });
  };
}

/** This module's contribution to the dispatch table (`dispatch.ts`). */
export const kanbanHandlers = {
  "kanban.board": kanban("kanban.board", KanbanBoardInput, false, (h, i, o) => h.kanban.board(i, o)),
  "kanban.task": kanban("kanban.task", KanbanTaskInput, false, (h, i, o) => h.kanban.task(i, o)),
  "kanban.log": kanban("kanban.log", KanbanLogInput, false, (h, i, o) => h.kanban.log(i, o)),
  "kanban.create": kanban("kanban.create", KanbanCreateInput, true, (h, i, o) => h.kanban.create(i, o)),
  "kanban.comment": kanban("kanban.comment", KanbanCommentInput, true, (h, i, o) =>
    h.kanban.comment(i, o),
  ),
  "kanban.unblock": kanban("kanban.unblock", KanbanUnblockInput, true, (h, i, o) =>
    h.kanban.unblock(i, o),
  ),
  "kanban.assign": kanban("kanban.assign", KanbanAssignInput, true, (h, i, o) => h.kanban.assign(i, o)),
  "kanban.move": kanban("kanban.move", KanbanMoveInput, true, (h, i, o) => h.kanban.move(i, o)),
  "kanban.archive": kanban("kanban.archive", KanbanArchiveInput, true, (h, i, o) =>
    h.kanban.archive(i, o),
  ),
  "kanban.delete": kanban("kanban.delete", KanbanDeleteInput, true, (h, i, o) => h.kanban.delete(i, o)),
} satisfies Record<string, Handler>;
