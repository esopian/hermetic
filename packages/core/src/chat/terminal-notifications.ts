/**
 * The `terminal` source of the inbox (issue #18): what the desktop app's SSH
 * sessions raise while the operator is not looking at them.
 *
 * The same split as `notifyOpSettled`: the head owns the sessions and decides
 * *that* something happened (`packages/app/src/terminal/attention.ts`); core
 * owns the row — its wording, its class, its key — so the inbox reads the same
 * however many heads one day open a terminal.
 *
 * **Never a byte of output.** A terminal shows whatever the box prints, and
 * that includes tokens, `.env` files and passwords echoed by a careless script.
 * A row is written to the laptop's database and outlives the session by thirty
 * days, so it carries the agent, the session's number, what happened, and for a
 * finished command the exit status, the run time and the program's *name* —
 * sanitized (`sanitizeProgramName`), so a command line that began with a secret
 * leaves no word of itself behind. The input schema has no field for anything
 * else.
 *
 * Its own module rather than more of `notifications.ts`, which is near the size
 * where a new source should stand beside it (AGENTS.md rule 5).
 */
import {
  type NotificationAction,
  type NotificationClass,
  type NotificationKind,
  TerminalNoticeInput,
  TerminalSessionResolveInput,
  sanitizeProgramName,
  terminalActionRef,
  terminalOutputKey,
} from "../schema/index.ts";
import { HermeticError } from "../errors.ts";
import { formatElapsedMs } from "./notifications.ts";
import type { NotificationStore } from "./notification-store.ts";

/** One report from a head; see `TerminalNoticeInput`. */
export type TerminalEventInput = TerminalNoticeInput;
/** The view/close report; see `TerminalSessionResolveInput`. */
export type TerminalResolveInput = TerminalSessionResolveInput;

interface Wording {
  kind: NotificationKind;
  class: NotificationClass;
  title: string;
  detail: string | null;
}

/** `ran 7m41s`, or null when the head did not time the command. */
function ranFor(ms: number | undefined): string | null {
  return ms === undefined ? null : `ran ${formatElapsedMs(ms)}`;
}

/**
 * The row's words. `atlas · session 1` leads every title so a list of them
 * scans by box; the event follows. A finished command with no exit status (the
 * marker never said) is reported as finished and nothing more, in the neutral
 * class, rather than guessed at.
 */
function wordingOf(input: TerminalNoticeInput): Wording {
  const who = `${input.agent} · session ${input.session_index}`;
  switch (input.event) {
    case "output":
      return {
        kind: "terminal.output",
        class: "info",
        title: `${who} has new output`,
        detail: null,
      };
    case "finished": {
      const program = sanitizeProgramName(input.program) ?? "command";
      const exit = input.exit_code;
      const title =
        exit === undefined
          ? `${who} — ${program} finished`
          : `${who} — ${program} ${exit === 0 ? "finished" : "failed"} · exit ${exit}`;
      return {
        kind: "terminal.finished",
        class: exit === undefined ? "info" : exit === 0 ? "ok" : "bad",
        title,
        detail: ranFor(input.ran_ms),
      };
    }
    case "input":
      return {
        kind: "terminal.input",
        class: "needs_action",
        title: `${who} may be waiting for input`,
        detail: null,
      };
    case "bell":
      return { kind: "terminal.bell", class: "warn", title: `${who} rang the bell`, detail: null };
    case "disconnected":
      return {
        kind: "terminal.disconnected",
        class: "bad",
        title: `${who} disconnected`,
        detail: null,
      };
  }
}

/**
 * Writes the row for one thing a session did off screen. Never throws, and
 * writes nothing when `terminal_alerts` is off — the head gates its toasts on
 * the same setting (`TerminalNotices.alertsOn`), and core holds the line for
 * the row so a head that forgot cannot fill the inbox anyway.
 *
 * `output` is a condition: one open row per session, keyed
 * `terminal:<fleet_id>:<session_id>:output`, which a second report finds and
 * leaves alone until `resolveTerminalSession` closes it. The other four are
 * events with no key: each bell is its own row.
 *
 * The row's `ref` is the session id — what the row is *about*, and the column
 * `resolveTerminalSession` reads by — while the action's ref is
 * `<agent>/<session_id>`, which is what a head routes on.
 */
export function notifyTerminalEvent(
  store: NotificationStore,
  input: TerminalEventInput,
  now?: () => number,
): void {
  try {
    const parsed = TerminalNoticeInput.safeParse(input);
    if (!parsed.success) return;
    const event = parsed.data;
    if (!store.settings().terminal_alerts) return;
    const words = wordingOf(event);
    const actions: NotificationAction[] = [
      {
        label: "Open session",
        target: "terminal",
        ref: terminalActionRef(event.agent, event.session_id),
      },
    ];
    store.insert({
      source: "terminal",
      kind: words.kind,
      class: words.class,
      title: words.title,
      detail: words.detail,
      agent: event.agent,
      fleet: event.fleet_id,
      ref: event.session_id,
      key: event.event === "output" ? terminalOutputKey(event.fleet_id, event.session_id) : null,
      actions,
      // Absent, the store's own clock stamps the row, as for every other source.
      ...(now === undefined ? {} : { at: new Date(now()).toISOString() }),
    });
  } catch {
    // Same bargain as `notifyOpSettled`: recording is never what fails a session.
  }
}

/**
 * The operator looked at a session (`read: true`), or it closed (`read:
 * false`). Either way its output condition is over; a view also marks every
 * row that session raised read, since the operator has now seen what they
 * were about. A close leaves the events unread: a session that ended while
 * nobody watched still has something to say. Never throws.
 */
export function resolveTerminalSession(store: NotificationStore, input: TerminalResolveInput): void {
  try {
    const parsed = TerminalSessionResolveInput.safeParse(input);
    if (!parsed.success) return;
    const { fleet_id, session_id, read } = parsed.data;
    store.resolve(terminalOutputKey(fleet_id, session_id));
    if (read) store.ackRef("terminal", session_id, fleet_id);
  } catch {
    // A courtesy, like every other source.
  }
}

/**
 * The terminal source bound to one `Hermetic`'s inbox, for a head that holds
 * the instance but — rightly — not its store. Not a public method: nothing
 * here is a command a CLI or the page could invoke (`tests/parity.test.ts`);
 * it is the desktop app reporting on sessions only it owns.
 */
export interface TerminalNotices {
  /** `notifyTerminalEvent` against this instance's store. */
  raise(input: TerminalEventInput): void;
  /** `resolveTerminalSession` against this instance's store. */
  resolve(input: TerminalResolveInput): void;
  /**
   * The current `terminal_alerts` setting: one `prefs` read, cheap enough to
   * call per event. A store that cannot answer reads as on, the default.
   */
  alertsOn(): boolean;
}

/** Keyed by the object `createHermetic` returned, so a dropped instance takes its entry with it. */
const NOTICES = new WeakMap<object, TerminalNotices>();

/** Called once by `createHermetic`, with the store it built the inbox over. */
export function registerTerminalNotices(
  hermetic: object,
  store: NotificationStore,
  now?: () => number,
): void {
  NOTICES.set(hermetic, {
    raise: (input) => notifyTerminalEvent(store, input, now),
    resolve: (input) => resolveTerminalSession(store, input),
    alertsOn: () => {
      try {
        return store.settings().terminal_alerts;
      } catch {
        return true;
      }
    },
  });
}

/**
 * The terminal source for this instance. Throws `INTERNAL` for an object
 * `createHermetic` did not build: a head handing in a copy has a bug, and a
 * silent no-op would hide it.
 */
export function terminalNotices(hermetic: object): TerminalNotices {
  const notices = NOTICES.get(hermetic);
  if (notices === undefined) {
    throw new HermeticError("INTERNAL", "terminal notices: not an instance built by createHermetic");
  }
  return notices;
}
