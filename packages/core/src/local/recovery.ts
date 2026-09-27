/**
 * §4.6: the interrupted operations a boot must hand back to the operator
 * instead of finishing for them.
 *
 * A pending row is the durable record that an operation was in flight when its
 * process stopped. Most of them are finished automatically at the next boot —
 * the method is idempotent against reality, so re-running it costs a few
 * describes (`resume.ts` in the server). `agents.recreate` is not one of those.
 * It replaces a running instance unconditionally, so replaying one that was
 * interrupted can terminate the replacement a previous attempt had already
 * created and build a third instance in its place, instead of finishing the
 * attachment that was one step from done.
 *
 * Until recreate can say where it stopped and pick up from there, the honest
 * answer is that a human decides. This module is that answer in one place:
 * which methods need it, what the operator is told, and which command finishes
 * the job. It lives in core because both heads say it — the portal's log and
 * `hermetic runs` — and two copies of a sentence naming a command are two
 * copies that can disagree about which command it is.
 *
 * The second half of the rule is about one *row* rather than one method. A
 * destroy is replayable, but only while its row can still prove which agent it
 * was confirmed against: an agent name is a label that can be freed and taken
 * again, so a row with no `target_identity` — the identity read failed at
 * confirmation time, or the row predates the column — names an agent nobody
 * can vouch for. §4.6 asks for reconfirmation there, not automatic replay, and
 * that is what `manualRecovery` answers for such a row.
 */
import type { PendingOp } from "./db/index.ts";

/**
 * The methods no boot replays on its own, whatever the row says, and the
 * command that finishes each. Keyed by the same dotted method a pending row
 * records.
 */
const MANUAL_RECOVERY: Record<string, (target: string) => string> = {
  "agents.recreate": (name) => `hermetic agent recreate ${name}`,
};

/**
 * The methods whose replay *destroys* the agent they name, and the command an
 * operator types to run one again.
 *
 * These are replayable in principle — `agents.destroy` is idempotent against
 * reality, and finishing a half-done one is better than leaving an agent
 * stranded in `destroying` (§6.6). They are replayable only while the row can
 * prove *which* agent it was confirmed against, because a name is a label that
 * can be freed and taken again. `target_identity` is that proof, and a row that
 * carries none cannot offer it: the identity read at confirmation time failed,
 * or the row predates the column. Neither is evidence that the agent holding
 * the name now is the agent the operator meant, and a destroy is not an action
 * to take on a guess. §4.6: a pending record without trustworthy identity
 * requires reconfirmation, not automatic replay.
 */
const DESTRUCTIVE: Record<string, (target: string) => string> = {
  "agents.destroy": (name) => `hermetic agent destroy ${name}`,
  "agents.recreate": (name) => `hermetic agent recreate ${name}`,
};

/**
 * Whether a row can still say which agent it was confirmed against (§4.6).
 *
 * An identity with both halves null is the same fact as no identity at all —
 * `toIdentity` in `db.ts` already collapses one into the other on the way off
 * disk, and an in-memory store need not — so both are read the same way here.
 *
 * Either half is proof when it can still be compared. The identity is captured
 * before the op starts and does not change as destroy clears the live row's
 * `instance_id`; requiring both would therefore strand a retry that was
 * deliberately started against an already `destroying` row. `agentMoved`
 * compares every half the record carries and refuses when the live row cannot
 * agree with it.
 */
function identified(row: PendingOp): boolean {
  const identity = row.target_identity;
  if (identity == null) return false;
  return identity.instance_id !== null || identity.created_at !== null;
}

/** One interrupted operation an operator has to finish themselves. */
export interface ManualRecovery {
  /** The pending row's id, so a head can name the run it came from. */
  id: string;
  /** Dotted core method, e.g. `agents.recreate`. */
  method: string;
  /** The agent it was against; `null` for a method that names none. */
  target: string | null;
  /** How far it had got, when the row recorded a phase. */
  phase: string | null;
  /** The command to run, spelled the way an operator types it. */
  command: string;
  /** The whole of it as one line, for a head that only has one line. */
  message: string;
}

/**
 * Whether a boot may replay this method at all, or has to ask for a human.
 * `resume.ts` asks before anything else, because an unreplayable method is not
 * a row to drop — it is a row to report.
 *
 * Method alone: this answers the question about `agents.recreate`, which is
 * never replayed however good its row is. The other half of the rule is about
 * one *row* rather than one method, so it is `manualRecovery`'s to answer.
 */
export function needsManualRecovery(method: string): boolean {
  return method in MANUAL_RECOVERY;
}

/**
 * What to tell the operator about one interrupted row, or `null` when the row
 * is one a boot finishes by itself.
 *
 * Two reasons a row needs a human, and they produce different sentences because
 * they are different facts: the *method* is one no replay can be safe for
 * (`agents.recreate`), or the *row* cannot prove which agent it was confirmed
 * against and the method destroys the one it names (§4.6).
 *
 * A row whose method needs a human but which names no agent cannot produce a
 * command to run, so it produces no recovery either: a message that says
 * "re-run it" without saying on what is worse than the row it came from.
 */
export function manualRecovery(row: PendingOp): ManualRecovery | null {
  if (row.target === null) return null;
  const unreplayable = MANUAL_RECOVERY[row.method];
  const command = unreplayable ?? (identified(row) ? undefined : DESTRUCTIVE[row.method]);
  if (command === undefined) return null;
  const phase = row.phase ?? null;
  const where = phase === null ? "" : ` during ${phase}`;
  const why =
    unreplayable === undefined
      ? `, because it does not record which agent it was confirmed against and \`${row.target}\` may since have been re-created`
      : ", because replaying one can destroy the instance the first attempt had already built";
  return {
    id: row.id,
    method: row.method,
    target: row.target,
    phase,
    command: command(row.target),
    message:
      `${row.target}: an interrupted ${row.method} is not replayed automatically` +
      `${why}. ` +
      `It stopped${where} at ${row.started_at}; check the agent and run \`${command(row.target)}\` if it still needs it.`,
  };
}

/** Every row in a list that needs a human, in the order the rows came in. */
export function manualRecoveries(rows: readonly PendingOp[]): ManualRecovery[] {
  return rows.flatMap((row) => {
    const recovery = manualRecovery(row);
    return recovery === null ? [] : [recovery];
  });
}
