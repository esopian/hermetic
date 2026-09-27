/**
 * `hermetic bots ls` and the four `hermetic chat` commands (§9): the
 * fleet's bots, one bot's conversations, one conversation's transcript, and the
 * two commands that take a turn and stop one.
 *
 * Its own file rather than a group under `agent.ts` because the unit is not an
 * agent. A box is an *instance*, an instance runs a swarm of bots, and a bot is
 * what an operator talks to (§9.2) — today every box has exactly one bot,
 * `default`, which is `$HERMES_HOME` itself, so `atlas` and `atlas/default`
 * address the same thing and the second spelling is what the portal always
 * sends.
 *
 * `hermetic chat <target>` is deliberately the shallow half of the surface. A
 * message argument sends it, a pipe sends stdin, `--json` emits `ChatFrame`
 * NDJSON — and a bare invocation on a terminal says so and stops. The
 * interactive REPL is real work with its own failure modes (line editing,
 * history, interleaved output from a turn already in flight) and it is not
 * Phase 5's; a half-built one would be worse than the sentence that replaces it.
 */
import type { Command } from "commander";
import { Command as Cmd } from "commander";
import {
  ChatAbortInput,
  ChatListeningInput,
  ChatListenInput,
  ChatHistoryInput,
  ChatObserveInput,
  ChatSendInput,
  ChatSessionsInput,
  ChatSwarmsInput,
  DEFAULT_BOT,
  ERROR_CODES,
  HermeticError,
} from "@hermetic/core";
import type {
  Bot,
  ChatBlock,
  ChatFrame,
  ChatMessage,
  ChatObserveEvent,
  ErrorCode,
  Session,
  Swarm,
} from "@hermetic/core";
import { openCtx } from "../context.ts";
import { globals } from "../options.ts";
import { defined, toInt, validate } from "../validate.ts";
import { err, out, outJson } from "../io.ts";
import { formatAge, renderTable } from "../table.ts";
import { declare } from "../declare.ts";

const listeningSchema = declare("chat.listening", "chat listening", ChatListeningInput);
const listenSchema = declare("chat.listen", "chat listen", ChatListenInput);
const swarmsSchema = declare("chat.swarms", "bots ls", ChatSwarmsInput);
const sessionsSchema = declare("chat.sessions", "chat ls", ChatSessionsInput);
const historySchema = declare("chat.history", "chat log", ChatHistoryInput);
const sendSchema = declare("chat.send", "chat", ChatSendInput);
const abortSchema = declare("chat.abort", "chat abort", ChatAbortInput);
const observeSchema = declare("chat.observe", "chat watch", ChatObserveInput);

/* ── addressing ───────────────────────────────────────────────────────────── */

/**
 * `<instance>/<bot>`, or a bare `<instance>` for the bot that is the box.
 *
 * The fallback is not a convenience the portal shares: the portal has a rail
 * and always knows which bot is selected, so it sends both halves. This is for
 * the operator typing `hermetic chat atlas`, which is the only spelling that
 * makes sense while every box still runs a swarm of one (§8.1).
 *
 * Nothing is validated here. The instance goes to core's `validateName` — the
 * one place an agent name is checked (§6.1) — and the bot to `BotName`, by way
 * of the schema every command below hands its parsed options to.
 */
export function parseBotRef(target: string): { instance: string; bot: string } {
  const slash = target.indexOf("/");
  if (slash === -1) return { instance: target, bot: DEFAULT_BOT };
  return { instance: target.slice(0, slash), bot: target.slice(slash + 1) };
}

/** `bot@instance`, the way §9.2 writes an absolute bot address. */
function botAddress(instance: string, bot: string): string {
  return `${bot}@${instance}`;
}

/* ── rendering ────────────────────────────────────────────────────────────── */

function ago(at: string | null | undefined, now: number): string {
  if (at == null) return "-";
  const ms = now - Date.parse(at);
  return Number.isFinite(ms) ? formatAge(ms) : "-";
}

/**
 * One row of `bots ls`: `BOT MODEL UNREAD LAST SECTION`.
 *
 * `unread` and `needs_action` share a column for the reason `inbox`'s STATE
 * column exists: they are two facts about the same thing — whether this bot
 * wants the operator — and a bot that is waiting on an answer is worth more
 * width than either number.
 */
export function botRow(bot: Bot, now: number): string[] {
  const marks = `${bot.needs_action ? "!" : " "}${bot.unread > 0 ? String(bot.unread) : "-"}`;
  return [
    botAddress(bot.instance, bot.name),
    bot.model ?? "-",
    marks,
    ago(bot.last_message_at, now),
    bot.section ?? "-",
  ];
}

/**
 * The line above an instance's bots: how many of the box's warm backend slots
 * are taken, or why the box said nothing at all.
 *
 * The slot count is printed even when nothing is queued, because that is the
 * number an operator needs *before* the click that waits thirty seconds for a
 * slot and then fails (§9.2).
 */
export function swarmHeading(swarm: Swarm): string {
  if (!swarm.reachable) {
    return `${swarm.instance}: unreachable — ${swarm.unreachable_reason ?? "no reason given"}`;
  }
  const { used, total } = swarm.warm_slots;
  return `${swarm.instance}: ${swarm.bots.length} bots, ${used}/${total} warm slots`;
}

/** One row of `chat ls`: `SESSION KIND ORIGIN TURNS UNREAD LAST TITLE`. */
export function sessionRow(session: Session, now: number): string[] {
  return [
    session.id,
    session.kind,
    // The origin is restated with its detail because a reply into a `channel`
    // session leaves the tailnet: `#acme-support` is the part that says so.
    session.origin_detail == null ? session.origin : `${session.origin}:${session.origin_detail}`,
    String(session.turn_count),
    session.unread > 0 ? String(session.unread) : "-",
    ago(session.last_message_at, now),
    session.title,
  ];
}

/**
 * One block, as one or more lines of plain text.
 *
 * Every kind renders as *something*, including `unknown`. That is the schema's
 * contract rather than this file's politeness: upstream emits tools this repo
 * has never heard of, and it does so on a `hermes_ref` bump that changes
 * nothing else, so a version bump must never blank a transcript.
 */
export function blockLines(block: ChatBlock): string[] {
  switch (block.kind) {
    case "text":
      return block.markdown.split("\n");
    case "activity":
      // Human output stays compact; the JSON stream retains the inspectable payload.
      return [`[${block.state}] ${block.title}${block.detail ? ` — ${block.detail}` : ""}`];
    case "reasoning": {
      const ms = block.duration_ms;
      return [ms == null ? "(thinking)" : `(thought for ${formatAge(ms)})`];
    }
    case "tool": {
      const took = block.duration_ms == null ? "" : ` in ${formatAge(block.duration_ms)}`;
      const exit = block.exit_code == null ? "" : ` (exit ${block.exit_code})`;
      return [`$ ${block.name} -> ${block.status}${exit}${took}`];
    }
    case "attachment":
      return [`[file] ${block.name} (${block.mime}, ${block.bytes} bytes)`];
    case "approval":
      return [`[approval] ${block.tool}: ${block.summary}`];
    case "question":
      return [
        `[question] ${block.prompt}`,
        ...block.choices.map((choice, i) => `  ${i + 1}. ${choice}`),
      ];
    case "sources":
      return [`[sources]`, ...block.items.map((item) => `  ${item.title} — ${item.href}`)];
    case "hermetic":
      return [`[${block.card}] ${block.ref}`];
    case "unknown":
      return [`[${block.name}] ${JSON.stringify(block.payload)}`];
  }
}

/**
 * One message: who said it and when, then its blocks indented under it.
 *
 * The author is printed when the message carries one, and that is not
 * decoration either — in a room or a peer-driven turn the speaker is not the
 * session's own bot, and a transcript that hid it would read as though it were.
 */
export function messageLines(message: ChatMessage, now: number): string[] {
  const who =
    message.author == null
      ? message.role
      : `${message.role} ${botAddress(message.author.instance, message.author.bot)}`;
  const head = `${ago(message.at, now)} ago  ${who}${message.incomplete === true ? "  (incomplete)" : ""}`;
  const body = message.blocks.flatMap(blockLines).map((line) => `  ${line}`);
  const error = message.error == null ? [] : [`  ! ${message.error}`];
  return [head, ...body, ...error];
}

/**
 * What a `ChatFrame` adds to what is already on screen.
 *
 * A `delta` is an append with no newline of its own — it is the middle of a
 * sentence — which is why this returns the exact text to write rather than a
 * line to print.
 *
 * `midLine` says the last thing written was such a delta, so the cursor is
 * sitting in the middle of the reply. A block that lands there needs its own
 * line first: the reconnect status a continued turn emits (§9.2) arrives
 * mid-sentence by definition, and without the break it would be spliced into
 * the words around it. A terminal cannot replace a line it has already
 * written, so the later snapshots on the same key print under it — "Reconnecting…"
 * then "Reconnected", one line each, which is what a log should say.
 */
export function frameText(frame: ChatFrame, midLine = false): string {
  switch (frame.type) {
    case "delta":
      return frame.text;
    case "block":
      return `${midLine ? "\n" : ""}${blockLines(frame.block).join("\n")}\n`;
    case "done":
      return "\n";
    case "error":
      return "";
  }
}

/* ── the commands ─────────────────────────────────────────────────────────── */

/**
 * An error frame is the turn's failure, and the CLI owes a script the same exit
 * status a thrown failure would have given it.
 *
 * `ChatFrame.code` is a free string on purpose (core's `chat.ts` says why), so a
 * code core knows is mapped to its own status and anything else — a transport
 * failure with no `ErrorCode` of its own — lands on `INTERNAL`'s. What is never
 * acceptable is exit 0 after printing a failure.
 */
/**
 * A rollover snapshot's row window is `OBSERVE_WINDOW` (200, core), sized for
 * a reader's cursor, not a terminal. Rendering all of it would be exactly the
 * transcript dump the opening case above refuses to print, just triggered by
 * a session change instead of a watch starting. Ten is a screenful on an
 * ordinary terminal without scrolling straight past the row that mattered.
 */
const ROLLOVER_TAIL = 10;

/**
 * What an observation event puts on screen.
 *
 * A `snapshot` on the watch's own opening reconcile is one line, not a
 * transcript: `chat log` is the command for reading what was already said,
 * and a watch that dumped two hundred messages before its first new one would
 * bury the thing it exists to show. `opening` is what tells this apart from
 * the other case core now sends a `snapshot` for — a canonical session
 * rollover (a conversation archived, a new one opened) arriving mid-watch —
 * where no earlier line announced anything about the session the watch is now
 * attached to. That case renders too, reusing the same per-message renderer
 * `chat log` and a `message` event both already use (`messageLines`), but
 * only the newest `ROLLOVER_TAIL` rows: a rollover onto a conversation with a
 * real history must not print the whole thing any more than the opening case
 * may, so the header keeps the true count and says when it was capped.
 */
export function observeText(event: ChatObserveEvent, now: number, opening: boolean): string {
  switch (event.type) {
    case "snapshot": {
      const shown = opening ? [] : event.messages.slice(-ROLLOVER_TAIL);
      const capped = !opening && event.messages.length > shown.length;
      const header =
        `watching ${botAddress(event.instance, event.bot)}` +
        `${event.session === null ? "" : ` (${event.session})`}` +
        ` — ${event.messages.length} messages${capped ? `, last ${shown.length} shown` : ""}\n`;
      if (shown.length === 0) return header;
      const rows = shown.map((message) => `${messageLines(message, now).join("\n")}\n`);
      return `${header}${rows.join("")}`;
    }
    case "message":
      return `${messageLines(event.message, now).join("\n")}\n`;
    case "reconnect":
      return `${event.instance}: ${event.message} — retrying in ${Math.round(event.delay_ms / 1000)}s (attempt ${event.attempt})\n`;
    case "error":
      return "";
  }
}

function errorFromFrame(frame: { code: string; message: string }): HermeticError {
  const known = (ERROR_CODES as readonly string[]).includes(frame.code);
  return new HermeticError(known ? (frame.code as ErrorCode) : "INTERNAL", frame.message, {
    chat_code: frame.code,
  });
}

/**
 * The message to send: the argument, else stdin when something is piped in.
 *
 * A terminal with no argument is the REPL's case, and the REPL is not built
 * (§6). Saying so is better than reading a TTY that nobody is typing into,
 * which is what an unguarded stdin read would do — it would hang, with no
 * prompt, until the operator worked out that Ctrl-D ends it.
 */
async function messageFrom(argument: string | undefined): Promise<string> {
  if (argument !== undefined) return argument;
  if (process.stdin.isTTY === true) {
    throw new HermeticError(
      "VALIDATION",
      "pass a message argument or pipe one on stdin; the interactive session is not built yet",
    );
  }
  return (await Bun.stdin.text()).trim();
}

export function register(program: Command): void {
  /**
   * `bots ls` is its own noun, not `chat ls`: the roster is what an operator
   * reads *before* choosing a conversation, and `chat ls` already means the
   * sessions of one bot.
   */
  const bots = globals(new Cmd("bots")).description("the bots this fleet's boxes are running");
  bots.addCommand(
    globals(new Cmd("ls"))
      .description("every listened-to instance's swarm, or one instance's")
      .option("--instance <name>", "one listened-to agent box")
      .addHelpText(
        "after",
        "\nAn instance is an agent box and a bot is a Hermes profile on it. Today every\n" +
          "box runs exactly one bot, `default`, which is $HERMES_HOME itself — so\n" +
          "`atlas` and `atlas/default` address the same bot.\n" +
          "\nA box that does not answer is listed as unreachable with the reason, never\n" +
          "omitted: a fleet read that dropped the boxes it could not reach would read\n" +
          "as a fleet that is smaller than it is.\n",
      )
      .action(async (opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const input = validate(swarmsSchema, defined({ instance: opts["instance"] }));
        const result = await ctx.hermetic.chat.swarms(input, { signal: ctx.signal });
        if (ctx.flags.json) {
          await outJson(result);
          return;
        }
        const now = Date.now();
        for (const swarm of result.swarms) {
          await err(`${swarmHeading(swarm)}\n`);
          if (swarm.bots.length === 0) continue;
          const rows = swarm.bots.map((bot) => botRow(bot, now));
          await out(`${renderTable(rows, ["BOT", "MODEL", "UNREAD", "LAST", "SECTION"])}\n`);
        }
        if (result.swarms.length === 0) await out("no instances\n");
      }),
  );
  program.addCommand(bots);

  /**
   * `chat` both groups and acts: `hermetic chat atlas "..."` takes a turn, and
   * `chat ls`/`chat log`/`chat abort` hang under it. Commander resolves a
   * subcommand name before a positional argument, so an agent literally named
   * `ls` cannot be addressed by `hermetic chat ls` — it is `chat ls/default`,
   * and the same is true of `log` and `abort`.
   */
  const chat = globals(new Cmd("chat"))
    .description("send one turn to a bot and stream the reply")
    .argument("<target>", "`<instance>` or `<instance>/<bot>`")
    .argument("[message]", "the message; omit it to send piped stdin")
    .option("--session <id>", "continue a session instead of the bot's canonical one")
    .addHelpText(
      "after",
      "\n  hermetic chat atlas 'what is the disk at'      one turn, reply streamed\n" +
        "  echo 'summarise today' | hermetic chat atlas   the same, from stdin\n" +
        "  hermetic chat atlas 'hello' --json             ChatFrame NDJSON on stdout\n" +
        "\nA turn is not an op: it is a live pipe to Hermes on the box, so it is not in\n" +
        "`hermetic ops`, it cannot be resumed, and Ctrl-C ends it here and on the box.\n" +
        "\nThere is no interactive session yet. Pass a message or pipe one.\n",
    )
    .action(
      async (
        target: string,
        message: string | undefined,
        opts: Record<string, unknown>,
        cmd: Command,
      ) => {
        const ctx = await openCtx(cmd);
        const input = validate(
          sendSchema,
          defined({
            ...parseBotRef(target),
            message: await messageFrom(message),
            session: opts["session"],
          }),
        );
        let failure: HermeticError | null = null;
        // Whether the reply has left the cursor mid-sentence; see `frameText`.
        let midLine = false;
        for await (const frame of ctx.hermetic.chat.send(input, { signal: ctx.signal })) {
          if (ctx.flags.json) {
            await out(`${JSON.stringify(frame)}\n`);
          } else {
            const text = frameText(frame, midLine);
            if (text !== "") {
              midLine = !text.endsWith("\n");
              await out(text);
            }
          }
          // The stream is consumed to its end either way: the box is mid-turn,
          // and abandoning the iterator would leave it writing into nothing.
          if (frame.type === "error") failure = errorFromFrame(frame);
        }
        if (failure !== null) throw failure;
      },
    );

  chat.addCommand(
    globals(new Cmd("ls"))
      .description("one bot's conversations, and where each of them came from")
      .argument("<target>", "`<instance>` or `<instance>/<bot>`")
      .addHelpText(
        "after",
        "\nORIGIN is where the session came from, and it is a safety field: a reply into\n" +
          "a `channel` session leaves the tailnet and lands in somebody's Slack, and a\n" +
          "reply into a `peer` session is answering another bot.\n",
      )
      .action(async (target: string, _opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const input = validate(sessionsSchema, parseBotRef(target));
        const result = await ctx.hermetic.chat.sessions(input, { signal: ctx.signal });
        if (ctx.flags.json) {
          await outJson(result);
          return;
        }
        if (result.sessions.length === 0) {
          await out(`no sessions on ${botAddress(result.instance, result.bot)}\n`);
          return;
        }
        const now = Date.now();
        const rows = result.sessions.map((session) => sessionRow(session, now));
        await out(
          `${renderTable(rows, ["SESSION", "KIND", "ORIGIN", "TURNS", "UNREAD", "LAST", "TITLE"])}\n`,
        );
      }),
  );

  chat.addCommand(
    globals(new Cmd("log"))
      .description("a bot's transcript, read from the box")
      .argument("<target>", "`<instance>` or `<instance>/<bot>`")
      .option("--session <id>", "one session instead of the canonical one")
      .option("--limit <n>", "at most N messages")
      .addHelpText(
        "after",
        "\nThe transcript lives on the box, on the data volume, so it survives a\n" +
          "recreate and is read fresh every time — hermetic keeps no copy of it.\n",
      )
      .action(async (target: string, opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const input = validate(
          historySchema,
          defined({
            ...parseBotRef(target),
            session: opts["session"],
            limit: toInt(opts["limit"] as string | undefined),
          }),
        );
        const result = await ctx.hermetic.chat.history(input, { signal: ctx.signal });
        if (ctx.flags.json) {
          await outJson(result);
          return;
        }
        if (result.messages.length === 0) {
          await out(`no messages on ${botAddress(result.instance, result.bot)}\n`);
          return;
        }
        const now = Date.now();
        for (const message of result.messages) {
          await out(`${messageLines(message, now).join("\n")}\n`);
        }
      }),
  );

  chat.addCommand(
    globals(new Cmd("watch"))
      .description("watch a conversation for messages, including ones sent elsewhere")
      .argument("<target>", "`<instance>` or `<instance>/<bot>`")
      .option("--session <id>", "one session instead of the canonical one")
      .addHelpText(
        "after",
        "\n  hermetic chat watch atlas            new messages as they land\n" +
          "  hermetic chat watch atlas --json     ChatObserveEvent NDJSON on stdout\n" +
          "\nA watch sends nothing. It exists so that a message typed into Hermes Desktop,\n" +
          "sent from another laptop, or produced by a cron routine reaches you without\n" +
          "anybody refreshing anything. It never creates a session, warms a model or\n" +
          "starts a turn, and Ctrl-C stops watching here and changes nothing on the box.\n" +
          "\nIt does not end on its own: a conversation is never over.\n",
      )
      .action(async (target: string, opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const input = validate(
          observeSchema,
          defined({ ...parseBotRef(target), session: opts["session"] }),
        );
        // Tells `observeText` the watch's own opening `snapshot` apart from a
        // later one core sends on a session rollover — the two render
        // differently. Set the first time a `snapshot` is seen and never
        // cleared after, since only the very first is the opening one.
        let sawSnapshot = false;
        for await (const event of ctx.hermetic.chat.observe(input, { signal: ctx.signal })) {
          if (ctx.flags.json) {
            await out(`${JSON.stringify(event)}\n`);
          } else {
            const opening = event.type === "snapshot" && !sawSnapshot;
            if (event.type === "snapshot") sawSnapshot = true;
            const text = observeText(event, Date.now(), opening);
            if (text !== "") await (event.type === "reconnect" ? err(text) : out(text));
          }
          // An `error` event is terminal and the stream ends after it, so the
          // exit status is raised here rather than after the loop: there is no
          // "kept watching anyway" for a watch that has been told to stop.
          if (event.type === "error") throw errorFromFrame(event);
        }
      }),
  );

  chat.addCommand(
    globals(new Cmd("abort"))
      .description("stop the turn a bot is in the middle of")
      .argument("<target>", "`<instance>` or `<instance>/<bot>`")
      .option("--session <id>", "the session whose turn to stop")
      .action(async (target: string, opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const input = validate(
          abortSchema,
          defined({ ...parseBotRef(target), session: opts["session"] }),
        );
        const result = await ctx.hermetic.chat.abort(input, { signal: ctx.signal });
        if (ctx.flags.json) await outJson(result);
        else await out(`${botAddress(result.instance, result.bot)}: turn stopped\n`);
      }),
  );

  chat.addCommand(
    globals(new Cmd("listening"))
      .description("list instances this laptop listens to in the selected fleet")
      .action(async (_opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const result = await ctx.hermetic.chat.listening(validate(listeningSchema, {}));
        if (ctx.flags.json) await outJson(result);
        else
          await out(
            result.instances.length ? `${result.instances.join("\n")}\n` : "no instances watched\n",
          );
      }),
  );
  chat.addCommand(
    globals(new Cmd("listen"))
      .description("listen to an instance, or stop listening with --off")
      .argument("<instance>", "the instance to monitor")
      .option("--off", "stop monitoring and disconnect chat")
      .action(async (instance: string, opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const input = validate(listenSchema, { instance, listening: opts["off"] !== true });
        const result = await ctx.hermetic.chat.listen(input);
        if (ctx.flags.json) await outJson(result);
        else await out(`${instance}: ${input.listening ? "listening" : "not listening"}\n`);
      }),
  );
  program.addCommand(chat);
}
