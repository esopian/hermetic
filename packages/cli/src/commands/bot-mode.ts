/** Bot Mode commands accept the same typed JSON input as their HTTP counterparts. */
import { Command } from "commander";
import {
  ChatOpenInput,
  ChatCompactInput,
  ChatArchiveInput,
  ChatRespondInput,
  BotCapabilitiesInput,
  BotProfileInput,
  BotCreateInput,
  BotUpdateInput,
  BotDeleteInput,
  RoomsListInput,
  RoomGetInput,
  RoomCreateInput,
  RoomRenameInput,
  RoomDeleteInput,
  RoomHistoryInput,
  RoomSendInput,
  RoomControlInput,
  RoomRespondInput,
  RoutinesListInput,
  RoutineCreateInput,
  RoutineUpdateInput,
  RoutineDeleteInput,
  RoutineRunInput,
  RoutineHistoryInput,
  HermeticError,
} from "@hermetic/core";
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
const chat_open = declare("chat.open", "chat open", ChatOpenInput);
const chat_compact = declare("chat.compact", "chat compact", ChatCompactInput);
const chat_archive = declare("chat.archive", "chat archive", ChatArchiveInput);
const chat_respond = declare("chat.respond", "chat respond", ChatRespondInput);
const bots_capabilities = declare("bots.capabilities", "bots capabilities", BotCapabilitiesInput);
const bots_get = declare("bots.get", "bots get", BotProfileInput);
const bots_create = declare("bots.create", "bots create", BotCreateInput);
const bots_update = declare("bots.update", "bots update", BotUpdateInput);
const bots_delete = declare("bots.delete", "bots delete", BotDeleteInput);
const rooms_list = declare("rooms.list", "rooms list", RoomsListInput);
const rooms_get = declare("rooms.get", "rooms get", RoomGetInput);
const rooms_create = declare("rooms.create", "rooms create", RoomCreateInput);
const rooms_rename = declare("rooms.rename", "rooms rename", RoomRenameInput);
const rooms_delete = declare("rooms.delete", "rooms delete", RoomDeleteInput);
const rooms_history = declare("rooms.history", "rooms history", RoomHistoryInput);
const rooms_send = declare("rooms.send", "rooms send", RoomSendInput);
const rooms_control = declare("rooms.control", "rooms control", RoomControlInput);
const rooms_respond = declare("rooms.respond", "rooms respond", RoomRespondInput);
const routines_list = declare("routines.list", "routines list", RoutinesListInput);
const routines_create = declare("routines.create", "routines create", RoutineCreateInput);
const routines_update = declare("routines.update", "routines update", RoutineUpdateInput);
const routines_delete = declare("routines.delete", "routines delete", RoutineDeleteInput);
const routines_run = declare("routines.run", "routines run", RoutineRunInput);
const routines_history = declare("routines.history", "routines history", RoutineHistoryInput);
export function register(program: Command) {
  const chat = program.commands.find((c) => c.name() === "chat") ?? globals(new Command("chat"));
  if (!chat.parent) program.addCommand(chat);
  const bots = program.commands.find((c) => c.name() === "bots") ?? globals(new Command("bots"));
  if (!bots.parent) program.addCommand(bots);
  const rooms = program.commands.find((c) => c.name() === "rooms") ?? globals(new Command("rooms"));
  if (!rooms.parent) program.addCommand(rooms);
  const routines =
    program.commands.find((c) => c.name() === "routines") ?? globals(new Command("routines"));
  if (!routines.parent) program.addCommand(routines);
  chat.addCommand(
    globals(new Command("open"))
      .description("chat.open: profile-scoped Bot Mode operation")
      .requiredOption("--input <json>", "typed request JSON; instance and bot/room identify the target")
      .action(async (opts, cmd) => {
        const ctx = await openCtx(cmd);
        await outJson(
          await ctx.hermetic.chat.open(validate(chat_open, readInput(opts.input)), {
            signal: ctx.signal,
          }),
        );
      }),
  );
  chat.addCommand(
    globals(new Command("compact"))
      .description("chat.compact: profile-scoped Bot Mode operation")
      .requiredOption("--input <json>", "typed request JSON; instance and bot/room identify the target")
      .action(async (opts, cmd) => {
        const ctx = await openCtx(cmd);
        await outJson(
          await ctx.hermetic.chat.compact(validate(chat_compact, readInput(opts.input)), {
            signal: ctx.signal,
          }),
        );
      }),
  );
  chat.addCommand(
    globals(new Command("archive"))
      .description("chat.archive: profile-scoped Bot Mode operation")
      .requiredOption("--input <json>", "typed request JSON; instance and bot/room identify the target")
      .action(async (opts, cmd) => {
        const ctx = await openCtx(cmd);
        await outJson(
          await ctx.hermetic.chat.archive(validate(chat_archive, readInput(opts.input)), {
            signal: ctx.signal,
          }),
        );
      }),
  );
  chat.addCommand(
    globals(new Command("respond"))
      .description("chat.respond: profile-scoped Bot Mode operation")
      .requiredOption("--input <json>", "typed request JSON; instance and bot/room identify the target")
      .action(async (opts, cmd) => {
        const ctx = await openCtx(cmd);
        await outJson(
          await ctx.hermetic.chat.respond(validate(chat_respond, readInput(opts.input)), {
            signal: ctx.signal,
          }),
        );
      }),
  );
  bots.addCommand(
    globals(new Command("capabilities"))
      .description("bots.capabilities: profile-scoped Bot Mode operation")
      .requiredOption("--input <json>", "typed request JSON; instance and bot/room identify the target")
      .action(async (opts, cmd) => {
        const ctx = await openCtx(cmd);
        await outJson(
          await ctx.hermetic.bots.capabilities(validate(bots_capabilities, readInput(opts.input)), {
            signal: ctx.signal,
          }),
        );
      }),
  );
  bots.addCommand(
    globals(new Command("get"))
      .description("bots.get: profile-scoped Bot Mode operation")
      .requiredOption("--input <json>", "typed request JSON; instance and bot/room identify the target")
      .action(async (opts, cmd) => {
        const ctx = await openCtx(cmd);
        await outJson(
          await ctx.hermetic.bots.get(validate(bots_get, readInput(opts.input)), {
            signal: ctx.signal,
          }),
        );
      }),
  );
  bots.addCommand(
    globals(new Command("create"))
      .description("bots.create: profile-scoped Bot Mode operation")
      .requiredOption("--input <json>", "typed request JSON; instance and bot/room identify the target")
      .action(async (opts, cmd) => {
        const ctx = await openCtx(cmd);
        await outJson(
          await ctx.hermetic.bots.create(validate(bots_create, readInput(opts.input)), {
            signal: ctx.signal,
          }),
        );
      }),
  );
  bots.addCommand(
    globals(new Command("update"))
      .description("bots.update: profile-scoped Bot Mode operation")
      .requiredOption("--input <json>", "typed request JSON; instance and bot/room identify the target")
      .action(async (opts, cmd) => {
        const ctx = await openCtx(cmd);
        await outJson(
          await ctx.hermetic.bots.update(validate(bots_update, readInput(opts.input)), {
            signal: ctx.signal,
          }),
        );
      }),
  );
  bots.addCommand(
    globals(new Command("delete"))
      .description("bots.delete: profile-scoped Bot Mode operation")
      .requiredOption("--input <json>", "typed request JSON; instance and bot/room identify the target")
      .action(async (opts, cmd) => {
        const ctx = await openCtx(cmd);
        await outJson(
          await ctx.hermetic.bots.delete(validate(bots_delete, readInput(opts.input)), {
            signal: ctx.signal,
          }),
        );
      }),
  );
  rooms.addCommand(
    globals(new Command("list"))
      .description("rooms.list: profile-scoped Bot Mode operation")
      .requiredOption("--input <json>", "typed request JSON; instance and bot/room identify the target")
      .action(async (opts, cmd) => {
        const ctx = await openCtx(cmd);
        await outJson(
          await ctx.hermetic.rooms.list(validate(rooms_list, readInput(opts.input)), {
            signal: ctx.signal,
          }),
        );
      }),
  );
  rooms.addCommand(
    globals(new Command("get"))
      .description("rooms.get: profile-scoped Bot Mode operation")
      .requiredOption("--input <json>", "typed request JSON; instance and bot/room identify the target")
      .action(async (opts, cmd) => {
        const ctx = await openCtx(cmd);
        await outJson(
          await ctx.hermetic.rooms.get(validate(rooms_get, readInput(opts.input)), {
            signal: ctx.signal,
          }),
        );
      }),
  );
  rooms.addCommand(
    globals(new Command("create"))
      .description("rooms.create: profile-scoped Bot Mode operation")
      .requiredOption("--input <json>", "typed request JSON; instance and bot/room identify the target")
      .action(async (opts, cmd) => {
        const ctx = await openCtx(cmd);
        await outJson(
          await ctx.hermetic.rooms.create(validate(rooms_create, readInput(opts.input)), {
            signal: ctx.signal,
          }),
        );
      }),
  );
  rooms.addCommand(
    globals(new Command("rename"))
      .description("rooms.rename: profile-scoped Bot Mode operation")
      .requiredOption("--input <json>", "typed request JSON; instance and bot/room identify the target")
      .action(async (opts, cmd) => {
        const ctx = await openCtx(cmd);
        await outJson(
          await ctx.hermetic.rooms.rename(validate(rooms_rename, readInput(opts.input)), {
            signal: ctx.signal,
          }),
        );
      }),
  );
  rooms.addCommand(
    globals(new Command("delete"))
      .description("rooms.delete: profile-scoped Bot Mode operation")
      .requiredOption("--input <json>", "typed request JSON; instance and bot/room identify the target")
      .action(async (opts, cmd) => {
        const ctx = await openCtx(cmd);
        await outJson(
          await ctx.hermetic.rooms.delete(validate(rooms_delete, readInput(opts.input)), {
            signal: ctx.signal,
          }),
        );
      }),
  );
  rooms.addCommand(
    globals(new Command("history"))
      .description("rooms.history: profile-scoped Bot Mode operation")
      .requiredOption("--input <json>", "typed request JSON; instance and bot/room identify the target")
      .action(async (opts, cmd) => {
        const ctx = await openCtx(cmd);
        await outJson(
          await ctx.hermetic.rooms.history(validate(rooms_history, readInput(opts.input)), {
            signal: ctx.signal,
          }),
        );
      }),
  );
  rooms.addCommand(
    globals(new Command("send"))
      .description("rooms.send: profile-scoped Bot Mode operation")
      .requiredOption("--input <json>", "typed request JSON; instance and bot/room identify the target")
      .action(async (opts, cmd) => {
        const ctx = await openCtx(cmd);
        await outJson(
          await ctx.hermetic.rooms.send(validate(rooms_send, readInput(opts.input)), {
            signal: ctx.signal,
          }),
        );
      }),
  );
  rooms.addCommand(
    globals(new Command("control"))
      .description("rooms.control: profile-scoped Bot Mode operation")
      .requiredOption("--input <json>", "typed request JSON; instance and bot/room identify the target")
      .action(async (opts, cmd) => {
        const ctx = await openCtx(cmd);
        await outJson(
          await ctx.hermetic.rooms.control(validate(rooms_control, readInput(opts.input)), {
            signal: ctx.signal,
          }),
        );
      }),
  );
  rooms.addCommand(
    globals(new Command("respond"))
      .description("rooms.respond: profile-scoped Bot Mode operation")
      .requiredOption("--input <json>", "typed request JSON; instance and bot/room identify the target")
      .action(async (opts, cmd) => {
        const ctx = await openCtx(cmd);
        await outJson(
          await ctx.hermetic.rooms.respond(validate(rooms_respond, readInput(opts.input)), {
            signal: ctx.signal,
          }),
        );
      }),
  );
  routines.addCommand(
    globals(new Command("list"))
      .description("routines.list: profile-scoped Bot Mode operation")
      .requiredOption("--input <json>", "typed request JSON; instance and bot/room identify the target")
      .action(async (opts, cmd) => {
        const ctx = await openCtx(cmd);
        await outJson(
          await ctx.hermetic.routines.list(validate(routines_list, readInput(opts.input)), {
            signal: ctx.signal,
          }),
        );
      }),
  );
  routines.addCommand(
    globals(new Command("create"))
      .description("routines.create: profile-scoped Bot Mode operation")
      .requiredOption("--input <json>", "typed request JSON; instance and bot/room identify the target")
      .action(async (opts, cmd) => {
        const ctx = await openCtx(cmd);
        await outJson(
          await ctx.hermetic.routines.create(validate(routines_create, readInput(opts.input)), {
            signal: ctx.signal,
          }),
        );
      }),
  );
  routines.addCommand(
    globals(new Command("update"))
      .description("routines.update: profile-scoped Bot Mode operation")
      .requiredOption("--input <json>", "typed request JSON; instance and bot/room identify the target")
      .action(async (opts, cmd) => {
        const ctx = await openCtx(cmd);
        await outJson(
          await ctx.hermetic.routines.update(validate(routines_update, readInput(opts.input)), {
            signal: ctx.signal,
          }),
        );
      }),
  );
  routines.addCommand(
    globals(new Command("delete"))
      .description("routines.delete: profile-scoped Bot Mode operation")
      .requiredOption("--input <json>", "typed request JSON; instance and bot/room identify the target")
      .action(async (opts, cmd) => {
        const ctx = await openCtx(cmd);
        await outJson(
          await ctx.hermetic.routines.delete(validate(routines_delete, readInput(opts.input)), {
            signal: ctx.signal,
          }),
        );
      }),
  );
  routines.addCommand(
    globals(new Command("run"))
      .description("routines.run: profile-scoped Bot Mode operation")
      .requiredOption("--input <json>", "typed request JSON; instance and bot/room identify the target")
      .action(async (opts, cmd) => {
        const ctx = await openCtx(cmd);
        await outJson(
          await ctx.hermetic.routines.run(validate(routines_run, readInput(opts.input)), {
            signal: ctx.signal,
          }),
        );
      }),
  );
  routines.addCommand(
    globals(new Command("history"))
      .description("routines.history: profile-scoped Bot Mode operation")
      .requiredOption("--input <json>", "typed request JSON; instance and bot/room identify the target")
      .action(async (opts, cmd) => {
        const ctx = await openCtx(cmd);
        await outJson(
          await ctx.hermetic.routines.history(validate(routines_history, readInput(opts.input)), {
            signal: ctx.signal,
          }),
        );
      }),
  );
}
