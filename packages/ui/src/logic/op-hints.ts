/**
 * What an op's own event stream still owes the operator when it stops, what to
 * suggest when it stopped badly, and whether the rail that showed all this may
 * fade itself away. Pure, so every one of those answers can be tested without
 * mounting the progress view that renders them.
 */
import type { OpEvent } from "../api/index.ts";

/**
 * The one reassurance every long op owes the operator who is about to close the
 * tab. It is true of all of them for the same reason: the op runs in the engine
 * behind the loopback server, not in the browser, and the browser is only ever
 * watching it. Each caller adds the clause that is true of *its* op — the create
 * drawer, the row that keeps updating; the wizard, the page that reattaches.
 */
export const SAFE_TO_CLOSE = "Safe to close — the operation continues in the engine";

/**
 * The phases an op ends in. `init` finishes on `ready` (it checks the fleet can
 * launch an agent last) and every other op finishes on `done`; a warning in
 * either is a warning about the state the op is *leaving behind*, which is the
 * thing worth reading after it stops.
 */
const TERMINAL_PHASES = new Set(["done", "ready"]);

/**
 * The things that are not right when the op ends — the last lines an operator
 * should read, not warnings that scrolled by mid-op.
 *
 * Filtering on `ready` alone was wrong: only `init` emits there. `upgrade` ends
 * on `done`, and `agents.upgrade --all` marks that final line `warn` exactly
 * when it skipped an agent held by another operator (core `hermetic.ts`'s
 * upgrade tail) — the one case where the op reports success and did less than
 * it was asked to.
 */
export function opNextActions(events: readonly OpEvent[], finished: boolean): string[] {
  if (!finished) return [];
  return events.filter((e) => TERMINAL_PHASES.has(e.phase) && e.level === "warn").map((e) => e.message);
}

/**
 * The last thing the op said, when it ended.
 *
 * The message that matters most about an `upgrade` — "it takes effect on the
 * next recreate" — is an ordinary *info* line, because nothing went wrong:
 * pinning a version is all `upgrade` does, and the box takes it on its next
 * boot. It is still the whole answer to "did pressing Upgrade change anything
 * yet", and the drawer's old stripped rail showed a phase name and a percentage
 * and dropped it. Surfaced beside the callout rather than buried in a log pane
 * the operator has to scroll.
 *
 * `null` when the op is still running, when the terminal line says nothing
 * beyond the word done, or when it is already being reported as a warning.
 */
export function opFinalMessage(events: readonly OpEvent[], finished: boolean): string | null {
  if (!finished) return null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (!e || !TERMINAL_PHASES.has(e.phase)) continue;
    if (e.level === "warn" || e.level === "error") return null;
    const message = e.message.trim();
    // "done", "ok", "" — the phase label already says this.
    return message === "" || /^(done|ok|finished)\.?$/i.test(message) ? null : message;
  }
  return null;
}

/**
 * Everything the rail should still be saying once the op has stopped: the
 * terminal warnings, then the terminal message, then whatever the caller adds.
 * Order matters — a warning outranks a note — and duplicates are dropped,
 * because a line that is both the final message and a `warn` would otherwise be
 * rendered twice with the same React key.
 */
export function railNotes(
  events: readonly OpEvent[],
  finished: boolean,
  extra: readonly string[] = [],
): string[] {
  const final = opFinalMessage(events, finished);
  return [...new Set([...opNextActions(events, finished), ...(final ? [final] : []), ...extra])];
}

/**
 * Whether a finished rail may hold for a beat and fade out.
 *
 * Only a clean, silent success does. The rail used to fade 1.3s after *any*
 * success, which took the callout and the log with it — so the single most
 * important thing `upgrade` says appeared for about a second and then deleted
 * itself, which is worse than never showing it: the operator saw motion and has
 * no way to get it back short of re-running the op.
 *
 * A rail nobody was watching (one that was already complete when the drawer
 * opened, `live: false`) is not faded because it was never drawn.
 */
export function railFades(input: {
  /** The op was running while this drawer was open — see `RunningOp.live`. */
  live: boolean;
  finished: boolean;
  ok: boolean;
  /** `railNotes`: anything the rail is still saying. */
  notes: readonly string[];
}): boolean {
  return input.live && input.finished && input.ok && input.notes.length === 0;
}

/**
 * Did the *server* say this op ended, or did the socket just die?
 *
 * `followOp` reports both through the same callback: a real `done` frame gives
 * `(body.ok, body.error)`, and a dead transport gives `(false, null)`
 * (`api.ts`, `readyState === CLOSED`). Only the first is a verdict. The
 * difference matters wherever "the op is over" makes something unrecoverable —
 * the init wizard drops its reattach breadcrumb on it, and a portal restart
 * must not be allowed to erase the breadcrumb for an op that is still running.
 *
 * A failure always carries a code, so `ok: false` with no error is exactly the
 * transport's signature; a malformed `done` frame lands here too, and erring
 * towards "keep the breadcrumb" is the safe direction for both.
 */
export function serverReportedEnd(state: {
  finished: boolean;
  ok: boolean;
  error: { code: string; message: string } | null;
}): boolean {
  if (!state.finished) return false;
  return state.ok || state.error !== null;
}

/**
 * The command that re-runs the op that failed, when re-running it is a sensible
 * thing to suggest. `null` when it is not: a `create` that got half way leaves a
 * claimed name, so `agent create` would answer `NAME_TAKEN` and the operator
 * would be one step further from the fix.
 *
 * Every command spelled here exists — see `hermetic agent --help` and
 * `hermetic upgrade --help`; `test/op-hints.test.ts` pins the shapes.
 */
function retryCommand(label: string, agent: string): string | null {
  if (label.startsWith("upgrade")) return `\`hermetic upgrade ${agent} --hermes <version>\``;
  if (label === "start") return `\`hermetic agent start ${agent}\``;
  if (label === "stop") return `\`hermetic agent stop ${agent}\``;
  if (label === "destroy") return `\`hermetic agent destroy ${agent}\``;
  if (label === "recreate") return `\`hermetic agent recreate ${agent}\``;
  return null;
}

/**
 * What to try after a failed op, keyed on the error code core reported, the op's
 * short label, and the row's *current* status — which is what decides whether
 * half of these are commands core would even accept.
 *
 * Deliberately commands rather than prose: the dashboard and the CLI are the
 * same engine, and the next thing an operator does about a half-made agent is a
 * command. An unrecognised code still gets the two that are always true — the
 * run log has the failing AWS call in it, and `doctor` checks the foundation the
 * op was standing on.
 */
export function failureHints(
  code: string | null | undefined,
  label: string,
  name: string,
  /** The agent row's `display_status`; omitted when the drawer has no row. */
  status?: string | null,
): string[] {
  const agent = name || "<name>";
  const hints: string[] = [];
  switch (code) {
    case "ACCOUNT_MISMATCH":
    case "FLEET_MISMATCH":
      // Every other suggestion would be "try the refused thing again".
      return ["this home is frozen to a different account or fleet — `hermetic doctor`"];
    case "CONFIRMATION_REQUIRED":
      return ["the engine re-checked the confirmation and it did not match"];
    case "LOCKED":
      hints.push(`another operation holds ${agent}'s lock — \`hermetic runs\` shows which`);
      break;
    case "ABORTED":
      hints.push("the op was cancelled, not refused — re-run it when you are ready");
      break;
    default:
      break;
  }
  // `rerun` re-runs bootstrap stages, and core refuses it from any status but
  // `error` (`hermetic.ts`: "rerun re-runs the bootstrap stages of an agent that
  // failed one"). Suggesting it for a stopped or half-created row would be
  // advice that comes back INVALID_TRANSITION.
  if (status === "error") {
    hints.push(`\`hermetic agent rerun ${agent}\` resumes at the first failed stage`);
  } else {
    const retry = retryCommand(label, agent);
    if (retry) hints.push(`${retry} runs the same operation again`);
    else if (label === "create") {
      // The name is claimed either way, so the question is what the half-made
      // agent actually has — not whether to create it a second time.
      hints.push(`\`hermetic agent status ${agent}\` shows what the failed create left behind`);
    }
  }
  hints.push("`hermetic doctor` checks the foundation this op was standing on");
  hints.push("the failing call is named in ~/.hermetic/app.log (app-fixture.log in fixture mode)");
  return hints;
}
