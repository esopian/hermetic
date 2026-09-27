/**
 * `hermetic inbox`, `inbox ack` and `inbox mute` (§9): the operator's
 * local notification log, and the two writes over it.
 *
 * Local in the same sense `runs` is — the rows are in this laptop's SQLite, not
 * in DynamoDB — so two people watching one fleet keep their own unread marks
 * and their own mutes, and muting `atlas` here silences nothing for anybody
 * else.
 *
 * It is its own file rather than another group in `fleet.ts` because it is its
 * own noun: `fleet.ts` is the fleet-wide reads and the teardown of the fleet you
 * are standing in, and the inbox is about the operator.
 */
import type { Command } from "commander";
import { Command as Cmd } from "commander";
import {
  NotificationsAckInput,
  NotificationsListInput,
  NotificationsMuteInput,
  NotificationSource,
} from "@hermetic/core";
import type { Notification, NotificationMute } from "@hermetic/core";
import { openCtx } from "../context.ts";
import { globals } from "../options.ts";
import { defined, toInt, validate } from "../validate.ts";
import { err, out, outJson } from "../io.ts";
import { renderTable } from "../table.ts";
import { declare } from "../declare.ts";

const listSchema = declare("notifications.list", "inbox", NotificationsListInput);
const ackSchema = declare("notifications.ack", "inbox ack", NotificationsAckInput);
const muteSchema = declare("notifications.mute", "inbox mute", NotificationsMuteInput);

/** `source:<source>` is a source; anything else is an agent name (§4.9). */
const SOURCE_PREFIX = "source:";

/**
 * Splits `inbox mute`'s one argument into the two fields the schema refuses to
 * take together. Done here rather than in core because it is a *typing*
 * convenience — one positional reads better than `--agent`/`--source` — and the
 * portal, which has two separate controls, must not have to spell it.
 */
export function muteTargetInput(target: string): { agent?: string; source?: string } {
  if (!target.startsWith(SOURCE_PREFIX)) return { agent: target };
  return { source: target.slice(SOURCE_PREFIX.length) };
}

/** `4m`, `3h`, `2d`. The column is "when", and to the minute is more than anyone reads. */
function ago(at: string, now: number): string {
  const ms = now - Date.parse(at);
  if (!Number.isFinite(ms)) return "-";
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/**
 * The unread marker, the state, and whether a mute is swallowing it. Three
 * facts in one narrow column, because the title is the part worth the width.
 *
 * A row whose condition has cleared says `cleared` where its class would go.
 * The class of such a row is the severity it *had* — printing `needs_action`
 * beside a foundation that has since been updated is the whole thing this
 * column is here to stop, and `--json` still carries the class for anything
 * that wants it.
 *
 * The unread marker is untouched by that: `read_at` is the operator's
 * acknowledgement and `resolved_at` is the world's (§4.9), so a cleared
 * row nobody has read still shows its star.
 */
export function marks(row: Notification): string {
  const read = row.read_at == null ? "*" : " ";
  const state = row.resolved_at == null ? row.class : "cleared";
  return `${read}${row.muted ? "~" : " "}${state}`;
}

/** `cleared 3h ago`, in the same vocabulary the AGE column speaks. */
function clearedNote(at: string, now: number): string {
  const age = ago(at, now);
  return age === "-" ? "cleared" : `cleared ${age} ago`;
}

/**
 * One row of the table: `ID AGE STATE AGENT WHAT`. The cleared note is appended
 * to WHAT rather than given a column of its own — it is true of a minority of
 * rows, and a column that is empty on most of them costs every row its width.
 */
export function inboxRow(row: Notification, now: number): string[] {
  const what = row.detail == null ? row.title : `${row.title} — ${row.detail}`;
  return [
    row.id,
    ago(row.at, now),
    marks(row),
    row.agent ?? "-",
    row.resolved_at == null ? what : `${what} (${clearedNote(row.resolved_at, now)})`,
  ];
}

/**
 * The line under the table. `unread` and `needing action` are core's counts,
 * over the whole inbox and with cleared rows already excluded from both; the
 * cleared tally is over the rows *shown*, and says so, because a page-local
 * number printed as if it were a total is worse than no number.
 */
export function inboxFooter(
  unread: number,
  needsAction: number,
  rows: readonly Notification[],
): string {
  const head = `${unread} unread, ${needsAction} needing action`;
  const cleared = rows.filter((r) => r.resolved_at != null).length;
  return cleared === 0 ? head : `${head} · ${cleared} of ${rows.length} shown already cleared`;
}

function renderMutes(mutes: readonly NotificationMute[]): string {
  if (mutes.length === 0) return "";
  return `muted: ${mutes.map((m) => m.target).join(", ")}\n`;
}

export function register(program: Command): void {
  const inbox = globals(new Cmd("inbox"))
    .description("notifications this laptop has raised about the fleet")
    .option("--unread", "only rows that have not been acked")
    .option("--limit <n>", "at most N rows")
    .addHelpText(
      "after",
      "\nKept in ~/.hermetic/hermetic.db beside `runs`, for 30 days. A notification is\n" +
        "about who is watching, not about the fleet: another laptop on the same fleet\n" +
        "keeps its own inbox, and `inbox mute` here silences nothing there.\n" +
        "\nSTATE reads `*` unread, `~` muted, then the row's class — or `cleared` where\n" +
        "the condition it reported has since gone away. Cleared is not read: the fleet\n" +
        "fixed itself, nobody acknowledged anything, and the row stays listed as the\n" +
        "record that it happened.\n",
    )
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const ctx = await openCtx(cmd);
      const input = validate(
        listSchema,
        defined({ unread: opts["unread"], limit: toInt(opts["limit"] as string | undefined) }),
      );
      const result = await ctx.hermetic.notifications.list(input);
      if (ctx.flags.json) {
        await outJson(result);
        return;
      }
      if (result.notifications.length === 0) {
        await out(opts["unread"] === true ? "nothing unread\n" : "inbox is empty\n");
        await out(renderMutes(result.mutes));
        return;
      }
      const now = Date.now();
      const rows = result.notifications.map((n) => inboxRow(n, now));
      await out(`${renderTable(rows, ["ID", "AGE", "STATE", "AGENT", "WHAT"])}\n`);
      const footer = inboxFooter(result.unread, result.needs_action, result.notifications);
      await out(`${footer}\n${renderMutes(result.mutes)}`);
    });

  inbox.addCommand(
    globals(new Cmd("ack"))
      .description("mark one notification read, or every unread one")
      .argument("[id]", "the notification id; omit with --all")
      .option("--all", "every unread row of this fleet")
      .action(async (id: string | undefined, opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        // The schema refuses both and refuses neither; this head only passes on
        // what was typed, so the refusal is worded in one place (§11.4).
        const input = validate(ackSchema, defined({ id, all: opts["all"] }));
        const result = await ctx.hermetic.notifications.ack(input);
        if (ctx.flags.json) await outJson(result);
        else await out(`${result.acked} marked read\n`);
      }),
  );

  inbox.addCommand(
    globals(new Cmd("mute"))
      .description("silence an agent, or a whole source, in this laptop's inbox")
      .argument("<target>", "an agent name, or `source:operation|agent|fleet|chat|budget`")
      .option("--clear", "unmute instead")
      .addHelpText(
        "after",
        "\nA mute hides nothing: muted rows still appear in `inbox`, marked, and stop\n" +
          "asking for attention. It is local to this laptop and shared with the portal.\n",
      )
      .action(async (target: string, opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const input = validate(
          muteSchema,
          defined({ ...muteTargetInput(target), clear: opts["clear"] }),
        );
        const result = await ctx.hermetic.notifications.mute(input);
        if (ctx.flags.json) {
          await outJson(result);
          return;
        }
        await err(`${opts["clear"] === true ? "unmuted" : "muted"} ${target}\n`);
        await out(result.mutes.length === 0 ? "nothing muted\n" : renderMutes(result.mutes));
      }),
  );

  program.addCommand(inbox);
}

/** The sources `inbox mute` will accept, for the help text and the tests. */
export const MUTE_SOURCES = NotificationSource.options;
