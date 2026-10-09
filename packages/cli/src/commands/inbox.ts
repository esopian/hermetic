/**
 * `hermetic inbox`, `inbox ack`, `inbox clear`, `inbox snooze`, `inbox
 * settings` and `inbox mute` (§9): the operator's local notification log, and
 * the writes over it.
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
  NotificationsClearInput,
  NotificationsListInput,
  NotificationsMuteInput,
  NotificationsSettingsInput,
  NotificationsSnoozeInput,
  NotificationSource,
} from "@hermetic/core";
import type { Notification, NotificationMute } from "@hermetic/core";
import { openCtx } from "../context.ts";
import { globals } from "../options.ts";
import { ValidationFailure, defined, toInt, validate } from "../validate.ts";
import { err, out, outJson } from "../io.ts";
import { renderTable } from "../table.ts";
import { declare } from "../declare.ts";

const listSchema = declare("notifications.list", "inbox", NotificationsListInput);
const ackSchema = declare("notifications.ack", "inbox ack", NotificationsAckInput);
const clearSchema = declare("notifications.clear", "inbox clear", NotificationsClearInput);
const snoozeSchema = declare("notifications.snooze", "inbox snooze", NotificationsSnoozeInput);
const settingsSchema = declare("notifications.settings", "inbox settings", NotificationsSettingsInput);
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
 * `09:00` when the moment is within a day of now, else `2026-10-05 09:00`, in
 * this laptop's local time — the operator reads it against their own clock.
 */
export function untilLabel(at: string, now: number): string {
  const d = new Date(at);
  if (!Number.isFinite(d.getTime())) return at;
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (Math.abs(d.getTime() - now) < 86_400_000) return time;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

/**
 * The unread marker, the state, and whether a mute is swallowing it. Three
 * facts in one narrow column, because the title is the part worth the width.
 *
 * The state is the first of: `cleared` (the operator took the row out of the
 * inbox; it is History now), `snoozed until …` (hidden until then), `resolved`
 * (the condition it reported has gone away), or else the row's class. The
 * class of a resolved row is the severity it *had* — printing `needs_action`
 * beside a foundation that has since been updated is the whole thing this
 * column is here to stop, and `--json` still carries the class for anything
 * that wants it.
 *
 * The unread marker is untouched by that: `read_at` is the operator's
 * acknowledgement and `resolved_at` is the world's (§4.9), so a resolved
 * row nobody has read still shows its star.
 */
export function marks(row: Notification, now: number = Date.now()): string {
  const read = row.read_at == null ? "*" : " ";
  let state: string = row.class;
  if (row.cleared_at != null) state = "cleared";
  else if (row.snoozed_until != null && Date.parse(row.snoozed_until) > now) {
    state = `snoozed until ${untilLabel(row.snoozed_until, now)}`;
  } else if (row.resolved_at != null) state = "resolved";
  return `${read}${row.muted ? "~" : " "}${state}`;
}

/** `resolved 3h ago`, in the same vocabulary the AGE column speaks. */
function resolvedNote(at: string, now: number): string {
  const age = ago(at, now);
  return age === "-" ? "resolved" : `resolved ${age} ago`;
}

/**
 * One row of the table: `ID AGE STATE AGENT WHAT`. The resolved note is
 * appended to WHAT rather than given a column of its own — it is true of a
 * minority of rows, and a column that is empty on most of them costs every row
 * its width.
 */
export function inboxRow(row: Notification, now: number): string[] {
  const what = row.detail == null ? row.title : `${row.title} — ${row.detail}`;
  return [
    row.id,
    ago(row.at, now),
    marks(row, now),
    row.agent ?? "-",
    row.resolved_at == null ? what : `${what} (${resolvedNote(row.resolved_at, now)})`,
  ];
}

/**
 * The line under the table. `unread` and `needing action` are core's counts,
 * over the whole inbox and with resolved, cleared and snoozed rows already
 * excluded from both; the resolved tally is over the rows *shown*, and says
 * so, because a page-local number printed as if it were a total is worse than
 * no number. Snoozed and History totals follow when there are any, so an
 * operator looking at an empty inbox knows where the rest went.
 */
export function inboxFooter(
  unread: number,
  needsAction: number,
  rows: readonly Notification[],
  others: Elsewhere = {},
): string {
  let line = `${unread} unread, ${needsAction} needing action`;
  const resolved = rows.filter((r) => r.resolved_at != null).length;
  if (resolved > 0) line += ` · ${resolved} of ${rows.length} shown already resolved`;
  return line + elsewhere(others);
}

/** Core's snoozed and history totals, where the rows not in the inbox went. */
export interface Elsewhere {
  snoozed?: number;
  history?: number;
}

/** ` · 2 snoozed · 5 in history`, or nothing when both are zero. */
export function elsewhere(others: Elsewhere): string {
  let tail = "";
  if ((others.snoozed ?? 0) > 0) tail += ` · ${others.snoozed} snoozed`;
  if ((others.history ?? 0) > 0) tail += ` · ${others.history} in history`;
  return tail;
}

/** `on`/`off` as a boolean; anything else is passed through for the schema to refuse. */
export function onOff(value: unknown): unknown {
  if (value === "on") return true;
  if (value === "off") return false;
  return value;
}

const DURATION_UNITS_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
};

/**
 * `inbox snooze --for 4h` as the moment core is handed. A CLI convenience —
 * core takes only an absolute `until`, which is what the portal's menu sends —
 * so the arithmetic is the head's, against the laptop's clock.
 */
export function snoozeUntil(spec: string, now: number): string {
  const match = /^(\d+)([mhdw])$/.exec(spec.trim());
  if (match === null) {
    throw new ValidationFailure([
      { path: "for", message: "expected a duration like 1h, 4h, 1d or 1w" },
    ]);
  }
  const n = Number(match[1]);
  const unit = DURATION_UNITS_MS[match[2] as string] as number;
  return new Date(now + n * unit).toISOString();
}

/** A variadic argument as the schema's `ids`: absent when nothing was typed. */
function idsOf(ids: readonly string[] | undefined): string[] | undefined {
  return ids === undefined || ids.length === 0 ? undefined : [...ids];
}

function renderMutes(mutes: readonly NotificationMute[]): string {
  if (mutes.length === 0) return "";
  return `muted: ${mutes.map((m) => m.target).join(", ")}\n`;
}

/** `hermetic inbox`'s request from its own options. */
export function listInput(opts: Record<string, unknown>) {
  return validate(
    listSchema,
    defined({
      unread: opts["unread"],
      limit: toInt(opts["limit"] as string | undefined),
      view: opts["all"] === true ? "all" : opts["view"],
    }),
  );
}

/**
 * `inbox ack`'s request from what was typed.
 *
 * `inbox` declares `--unread` and `--all` too, and Commander gives a flag that a
 * parent declares to the parent wherever on the line it was written, so ack's
 * own options never see `inbox ack --all` or `inbox ack <id> --unread`. They are
 * read together with the parent's instead. That keeps the CLI's rule that a
 * flag works on either side of a subcommand. The alternative, positional
 * options, would have to be enabled on the root and would change how every
 * other group parses. The schema refuses both ids and `--all`, and refuses
 * neither; this head only passes on what was typed, so the refusal is worded in
 * one place (§11.4).
 */
export function ackInput(ids: readonly string[] | undefined, cmd: Command) {
  const opts = cmd.optsWithGlobals() as Record<string, unknown>;
  return validate(ackSchema, defined({ ids: idsOf(ids), all: opts["all"], unread: opts["unread"] }));
}

export function register(program: Command): void {
  const inbox = globals(new Cmd("inbox"))
    .description("notifications this laptop has raised about the fleet")
    .option("--unread", "only rows that have not been acked")
    .option("--limit <n>", "at most N rows")
    .option("--view <view>", "inbox (default), snoozed, history or all")
    .option("--all", "every row, whatever its state (same as --view all)")
    .addHelpText(
      "after",
      "\nKept in ~/.hermetic/hermetic.db beside `runs`, for 30 days. A notification is\n" +
        "about who is watching, not about the fleet: another laptop on the same fleet\n" +
        "keeps its own inbox, and `inbox mute` here silences nothing there.\n" +
        "\nViews: `inbox` is what is still in front of you; `snoozed` is hidden until a\n" +
        "time you chose; `history` is what was cleared (by you, or by the auto-clear\n" +
        "rules in `inbox settings`) plus conditions that resolved; `all` is everything.\n" +
        "\nSTATE reads `*` unread, `~` muted, then `cleared`, `snoozed until …`,\n" +
        "`resolved` where the condition it reported has since gone away, or the row's\n" +
        "class. Resolved is not read: the fleet fixed itself, nobody acknowledged\n" +
        "anything, and the row stays listed as the record that it happened.\n",
    )
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const ctx = await openCtx(cmd);
      const input = listInput(opts);
      const result = await ctx.hermetic.notifications.list(input);
      if (ctx.flags.json) {
        await outJson(result);
        return;
      }
      const view = input.view ?? "inbox";
      if (result.notifications.length === 0) {
        const empty =
          opts["unread"] === true
            ? "nothing unread"
            : view === "inbox"
              ? "inbox is empty"
              : `nothing in ${view}`;
        await out(`${empty}${view === "inbox" ? elsewhere(result) : ""}\n`);
        await out(renderMutes(result.mutes));
        return;
      }
      const now = Date.now();
      const rows = result.notifications.map((n) => inboxRow(n, now));
      await out(`${renderTable(rows, ["ID", "AGE", "STATE", "AGENT", "WHAT"])}\n`);
      const footer = inboxFooter(result.unread, result.needs_action, result.notifications, result);
      await out(`${footer}\n${renderMutes(result.mutes)}`);
    });

  inbox.addCommand(
    globals(new Cmd("ack"))
      .description("mark notifications read (or unread), or every unread one")
      .argument("[ids...]", "the notification ids; omit with --all")
      .option("--all", "every unread row of this fleet")
      .option("--unread", "mark the named rows unread instead")
      .action(async (ids: string[] | undefined, _opts: unknown, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const input = ackInput(ids, cmd);
        const result = await ctx.hermetic.notifications.ack(input);
        if (ctx.flags.json) await outJson(result);
        else await out(`${result.acked} marked ${input.unread === true ? "unread" : "read"}\n`);
      }),
  );

  inbox.addCommand(
    globals(new Cmd("clear"))
      .description("move notifications out of the inbox and into history")
      .argument("[ids...]", "the notification ids; omit with --read or --resolved")
      .option("--read", "every read row in the inbox")
      .option("--resolved", "every resolved row in the inbox")
      .option("--restore", "put the named rows back in the inbox (un-clear and un-snooze)")
      .addHelpText(
        "after",
        "\nA cleared row is kept in history until retention deletes it (30 days), and\n" +
          "clearing an unread row marks it read. Clearing a condition that still holds\n" +
          "hides it until it changes: once it resolves, a recurrence is a new row.\n",
      )
      .action(async (ids: string[] | undefined, opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const input = validate(
          clearSchema,
          defined({
            ids: idsOf(ids),
            read: opts["read"],
            resolved: opts["resolved"],
            restore: opts["restore"],
          }),
        );
        const result = await ctx.hermetic.notifications.clear(input);
        if (ctx.flags.json) await outJson(result);
        else await out(`${result.cleared} ${input.restore === true ? "restored" : "cleared"}\n`);
      }),
  );

  inbox.addCommand(
    globals(new Cmd("snooze"))
      .description("hide notifications from the inbox until a later time")
      .argument("<ids...>", "the notification ids")
      .option("--for <duration>", "how long: 1h, 4h, 1d, 1w (any <n>m|h|d|w)")
      .option("--until <iso>", "until this moment (ISO 8601, UTC `Z`)")
      .option("--clear", "unsnooze: bring the rows back now")
      .action(async (ids: string[], opts: Record<string, unknown>, cmd: Command) => {
        if (opts["for"] !== undefined && opts["until"] !== undefined) {
          throw new ValidationFailure([{ path: "for", message: "give --for or --until, not both" }]);
        }
        const until =
          opts["for"] !== undefined ? snoozeUntil(opts["for"] as string, Date.now()) : opts["until"];
        const ctx = await openCtx(cmd);
        const input = validate(snoozeSchema, defined({ ids, until, clear: opts["clear"] }));
        const result = await ctx.hermetic.notifications.snooze(input);
        if (ctx.flags.json) await outJson(result);
        else if (input.clear === true) await out(`${result.snoozed} unsnoozed\n`);
        else {
          const label = untilLabel(input.until as string, Date.now());
          await out(`${result.snoozed} snoozed until ${label}\n`);
        }
      }),
  );

  inbox.addCommand(
    globals(new Cmd("settings"))
      .description("read or change the inbox's auto-clear rules")
      .option("--auto-clear <after>", "clear read rows after never, 1d, 7d or 30d")
      .option("--clear-resolved-on-read <on|off>", "clear a resolved condition once it is read")
      .addHelpText(
        "after",
        "\nLocal to this laptop, shared with the portal. The rules run whenever the inbox\n" +
          "is read or written, so an idle inbox still converges.\n" +
          "\nThe first list after upgrading to a build with these rules applies the\n" +
          "defaults at once: every row read more than 7 days ago, and every row both read\n" +
          "and resolved, moves to History. Nothing is deleted; `inbox --view history`\n" +
          "shows them and `inbox clear <id> --restore` brings one back, and a restored row\n" +
          "is not cleared again until it is read again or ages out from the restore.\n",
      )
      .action(async (opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const input = validate(
          settingsSchema,
          defined({
            auto_clear_read: opts["autoClear"],
            clear_resolved_on_read:
              opts["clearResolvedOnRead"] === undefined
                ? undefined
                : onOff(opts["clearResolvedOnRead"]),
          }),
        );
        const result = await ctx.hermetic.notifications.settings(input);
        if (ctx.flags.json) {
          await outJson(result);
          return;
        }
        await out(
          `auto-clear read rows after: ${result.auto_clear_read}\n` +
            `clear resolved conditions once read: ${result.clear_resolved_on_read ? "on" : "off"}\n`,
        );
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
