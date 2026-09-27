/**
 * Bot Mode: the chat, bot, room and routine surface, as an explicit allowlist.
 *
 * Twenty-four near-identical
 * methods over one instance — validate, bind to the fleet the request names,
 * forward the caller's abort signal — so the shape is written once in
 * `scoped` and everything below is one line naming a core method.
 *
 * Every one of these meets §4.7's fleet guard (`target.ts`): the request names
 * the fleet it is for and the server refuses it with `FLEET_MISMATCH` when that
 * is not the fleet it is serving. Reads included — a bot roster read is
 * indistinguishable from a write to the guard, and the alternative is an
 * exception list that grows with the surface.
 *
 * The caller's signal reaches core on all of them: these are round trips to a
 * box, and a caller that went away should stop paying for one.
 */
import {
  BotCapabilitiesInput,
  BotCreateInput,
  BotDeleteInput,
  BotProfileInput,
  BotUpdateInput,
  ChatArchiveInput,
  ChatCompactInput,
  ChatOpenInput,
  ChatRespondInput,
  RoomControlInput,
  RoomCreateInput,
  RoomDeleteInput,
  RoomGetInput,
  RoomHistoryInput,
  RoomRenameInput,
  RoomRespondInput,
  RoomSendInput,
  RoomsListInput,
  RoutineCreateInput,
  RoutineDeleteInput,
  RoutineHistoryInput,
  RoutineRunInput,
  RoutineUpdateInput,
  RoutinesListInput,
} from "@hermetic/core";
import type { Hermetic, PublicMethod } from "@hermetic/core";
import type { ZodType } from "zod";
import { declareRpc } from "../declare.ts";
import { requireTarget, withTarget } from "../target.ts";
import { parseInput } from "../validation.ts";
import type { HandlerContext } from "./ctx.ts";
import type { Handler } from "./dispatch.ts";

/**
 * One method's two schemas and its handler, built from core's request schema
 * and the call itself.
 *
 * `body` is the §4.7 envelope the binding validates against, hoisted here
 * rather than built inline per request: `declareRoute` compares schema objects
 * by identity, and a `withTarget` call in the route body would hand it a fresh
 * one every time the app is constructed.
 */
interface Scoped<S extends ZodType, R> {
  schema: S;
  body: ReturnType<typeof withTarget<S>>;
  /**
   * Typed on the core call's own result rather than on `Handler`'s `unknown`,
   * so the binding's `c.json(...)` still carries a shape into the `hc` client
   * the UI reads. It satisfies `Handler` anyway, which is what the dispatch
   * table takes.
   */
  handler: (ctx: HandlerContext, params: unknown) => Promise<R>;
}

function scoped<S extends ZodType, R>(
  path: PublicMethod,
  schema: S,
  call: (h: Hermetic, input: ReturnType<S["parse"]>, opts: { signal?: AbortSignal }) => Promise<R>,
): Scoped<S, R> {
  const declared = declareRpc(path, schema);
  const body = withTarget(declared);
  const handler = async (ctx: HandlerContext, params: unknown): Promise<R> => {
    const { hermetic: h, input } = requireTarget(ctx.state, parseInput(body, params));
    return await call(h, input as ReturnType<S["parse"]>, { signal: ctx.signal });
  };
  return { schema: declared, body, handler };
}

export const chatOpen = scoped("chat.open", ChatOpenInput, (h, i, o) => h.chat.open(i, o));
export const chatCompact = scoped("chat.compact", ChatCompactInput, (h, i, o) => h.chat.compact(i, o));
export const chatArchive = scoped("chat.archive", ChatArchiveInput, (h, i, o) => h.chat.archive(i, o));
export const chatRespond = scoped("chat.respond", ChatRespondInput, (h, i, o) => h.chat.respond(i, o));
export const botsCapabilities = scoped("bots.capabilities", BotCapabilitiesInput, (h, i, o) =>
  h.bots.capabilities(i, o),
);
export const botsGet = scoped("bots.get", BotProfileInput, (h, i, o) => h.bots.get(i, o));
export const botsCreate = scoped("bots.create", BotCreateInput, (h, i, o) => h.bots.create(i, o));
export const botsUpdate = scoped("bots.update", BotUpdateInput, (h, i, o) => h.bots.update(i, o));
export const botsDelete = scoped("bots.delete", BotDeleteInput, (h, i, o) => h.bots.delete(i, o));
export const roomsList = scoped("rooms.list", RoomsListInput, (h, i, o) => h.rooms.list(i, o));
export const roomsGet = scoped("rooms.get", RoomGetInput, (h, i, o) => h.rooms.get(i, o));
export const roomsCreate = scoped("rooms.create", RoomCreateInput, (h, i, o) => h.rooms.create(i, o));
export const roomsRename = scoped("rooms.rename", RoomRenameInput, (h, i, o) => h.rooms.rename(i, o));
export const roomsDelete = scoped("rooms.delete", RoomDeleteInput, (h, i, o) => h.rooms.delete(i, o));
export const roomsHistory = scoped("rooms.history", RoomHistoryInput, (h, i, o) =>
  h.rooms.history(i, o),
);
export const roomsSend = scoped("rooms.send", RoomSendInput, (h, i, o) => h.rooms.send(i, o));
export const roomsControl = scoped("rooms.control", RoomControlInput, (h, i, o) =>
  h.rooms.control(i, o),
);
export const roomsRespond = scoped("rooms.respond", RoomRespondInput, (h, i, o) =>
  h.rooms.respond(i, o),
);
export const routinesList = scoped("routines.list", RoutinesListInput, (h, i, o) =>
  h.routines.list(i, o),
);
export const routinesCreate = scoped("routines.create", RoutineCreateInput, (h, i, o) =>
  h.routines.create(i, o),
);
export const routinesUpdate = scoped("routines.update", RoutineUpdateInput, (h, i, o) =>
  h.routines.update(i, o),
);
export const routinesDelete = scoped("routines.delete", RoutineDeleteInput, (h, i, o) =>
  h.routines.delete(i, o),
);
export const routinesRun = scoped("routines.run", RoutineRunInput, (h, i, o) => h.routines.run(i, o));
export const routinesHistory = scoped("routines.history", RoutineHistoryInput, (h, i, o) =>
  h.routines.history(i, o),
);

/** This module's contribution to the dispatch table (`dispatch.ts`). */
export const botModeHandlers = {
  "chat.open": chatOpen.handler,
  "chat.compact": chatCompact.handler,
  "chat.archive": chatArchive.handler,
  "chat.respond": chatRespond.handler,
  "bots.capabilities": botsCapabilities.handler,
  "bots.get": botsGet.handler,
  "bots.create": botsCreate.handler,
  "bots.update": botsUpdate.handler,
  "bots.delete": botsDelete.handler,
  "rooms.list": roomsList.handler,
  "rooms.get": roomsGet.handler,
  "rooms.create": roomsCreate.handler,
  "rooms.rename": roomsRename.handler,
  "rooms.delete": roomsDelete.handler,
  "rooms.history": roomsHistory.handler,
  "rooms.send": roomsSend.handler,
  "rooms.control": roomsControl.handler,
  "rooms.respond": roomsRespond.handler,
  "routines.list": routinesList.handler,
  "routines.create": routinesCreate.handler,
  "routines.update": routinesUpdate.handler,
  "routines.delete": routinesDelete.handler,
  "routines.run": routinesRun.handler,
  "routines.history": routinesHistory.handler,
} satisfies Record<string, Handler>;
