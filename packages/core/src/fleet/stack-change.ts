/**
 * One CloudFormation change set, computed, read, and only then executed
 * (§6.6 step 3) — shared by the two operations that update the foundation
 * stack.
 *
 * `foundation.update` rolls the template forward; `apply` kind `network`
 * re-decides the `Network` parameter. They differ in exactly one place — which
 * `CreateChangeSet` call they make — and agree on everything that matters: the
 * bounded wait, the refusal to execute a change set that would replace a
 * stateful resource, and the deletion of any change set that will not be run.
 * A change set left lying on a stack is one an operator finds later with no
 * idea whether it is safe to execute, so both ways of ending without an
 * execution clean up after themselves.
 *
 * Extracted rather than copied because the refusals are the valuable part. A
 * second copy of `unsafeReplacements` that forgot `Conditional` would be a
 * re-network that throws the agents table away on a coin flip.
 */
import { abortableSleep, checkAbort } from "../abort.ts";
import type { Backend, ChangeSetInfo, StackInfo } from "../backend/types.ts";
import { HermeticError } from "../errors.ts";
import { evt } from "../events.ts";
import { narrateStack } from "./init.ts";
import type { ErrorCode, OpEvent } from "../schema/index.ts";

/** DynamoDB tables and the fleet bucket: replaced means the fleet's records are gone. */
const STATEFUL_TYPES: readonly string[] = ["AWS::DynamoDB::Table", "AWS::S3::Bucket"];

/** CloudFormation's two spellings of "your change set is empty" (§6.6 step 3). */
const NO_CHANGES = /didn't contain changes|did not contain changes|No updates are to be performed/i;

/** The statuses `DescribeChangeSet` stops moving from. */
const CHANGE_SET_TERMINAL = /^(CREATE_COMPLETE|FAILED|DELETE_COMPLETE|DELETE_FAILED)$/;

/** How often a change set's status is re-read while it is being computed. */
export const CHANGE_SET_POLL_MS = 2_000;

/**
 * How long CloudFormation is given to compute one. Generous — a big template
 * against a big stack is tens of seconds — but finite, because `plan.foundation`
 * is a synchronous read behind an HTTP GET and must not be able to hang on one.
 */
export const CHANGE_SET_TIMEOUT_MS = 5 * 60_000;

/**
 * The code a change set's own failures are raised under. Supplied by the caller
 * rather than fixed here: `foundation.update` and `apply` kind `network` share
 * this choreography but not their recovery, and a head that saw
 * `FOUNDATION_UPDATE_FAILED` from a re-network would tell the operator to fix a
 * template that was never the problem.
 */
export type ChangeSetErrorCode = Extract<
  ErrorCode,
  "FOUNDATION_UPDATE_FAILED" | "NETWORK_UPDATE_FAILED"
>;

export interface StackChangeDeps {
  backend: Backend;
  nowIso: () => string;
  /** Tests shorten both of these; production leaves them at the constants above. */
  changeSetPollMs?: number | undefined;
  changeSetTimeoutMs?: number | undefined;
  /** How often `narrateStack` emits a "still going" tick during a silent update. */
  heartbeatMs?: number | undefined;
}

/**
 * A change-set name CloudFormation accepts: it must start with a letter and
 * hold only letters, digits and hyphens, so the timestamp is stripped of its
 * punctuation rather than trusted to be safe. `label` is what the operator
 * sees in the console — the foundation version, or the mode being moved to.
 */
export function changeSetName(label: string, nowIso: () => string, unique: string): string {
  const stamp = nowIso()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);
  return `hermetic-${label}-${stamp}-${unique}`;
}

/** `FAILED` with a "no changes" reason is the one failure that means success. */
export function isNoChanges(info: ChangeSetInfo): boolean {
  return info.status === "FAILED" && NO_CHANGES.test(info.statusReason ?? "");
}

/**
 * The stateful resources a change set would, or might, replace.
 *
 * `Conditional` counts. It means CloudFormation cannot tell in advance
 * whether this change replaces the resource — it depends on what the update
 * finds at execution time — and "we will find out once the agents table has
 * been thrown away" is not a risk an update takes on the operator's behalf.
 * The message says which of the two it is so the refusal can be acted on.
 */
export function unsafeReplacements(info: ChangeSetInfo): string[] {
  return info.changes
    .filter(
      (c) =>
        (c.replacement === "True" || c.replacement === "Conditional") &&
        STATEFUL_TYPES.includes(c.resourceType),
    )
    .map(
      (c) =>
        `${c.logicalId} (${c.resourceType})${c.replacement === "Conditional" ? " — conditionally, CloudFormation cannot say in advance" : ""}`,
    );
}

/**
 * Create a change set and wait for CloudFormation to finish computing it.
 *
 * Bounded, because this is a read that both `plan` and the applying op sit in
 * front of: a change set stuck in `CREATE_PENDING` used to hang a
 * `plan foundation` — and therefore an HTTP request — with no signal and no
 * ceiling. `create` is the caller's own `CreateChangeSet`: the only thing the
 * two operations disagree about.
 */
export async function computeChangeSet(
  deps: StackChangeDeps,
  params: {
    name: string;
    create: () => Promise<unknown>;
    /** The phase abort is reported under, so a cancel names the step it stopped. */
    phase: string;
    /** Whose operation this is, in the language of `errors.ts`. */
    errorCode: ChangeSetErrorCode;
    signal?: AbortSignal;
    heartbeat?: () => Promise<void>;
  },
): Promise<ChangeSetInfo> {
  await params.create();
  const poll = deps.changeSetPollMs ?? CHANGE_SET_POLL_MS;
  const timeout = deps.changeSetTimeoutMs ?? CHANGE_SET_TIMEOUT_MS;
  const deadline = Date.now() + timeout;
  for (;;) {
    checkAbort(params.signal, params.phase);
    const info = await deps.backend.foundation.describeChangeSet(params.name);
    if (CHANGE_SET_TERMINAL.test(info.status)) return info;
    if (Date.now() >= deadline) {
      throw new HermeticError(
        params.errorCode,
        `CloudFormation was still computing the change set ${params.name} after ${Math.round(timeout / 60_000)} minutes (${info.status}); it has been deleted`,
        { name: params.name, status: info.status },
      );
    }
    await abortableSleep(poll, params.signal);
    await params.heartbeat?.();
  }
}

export interface RunChangeSetParams {
  /** The stack as the caller's guard last saw it; its name is what messages say. */
  guarded: StackInfo;
  name: string;
  create: () => Promise<unknown>;
  /** The op phase these events belong to, and the slice of the bar it owns. */
  phase: string;
  /**
   * The code every failure of this change set is raised under (see
   * `ChangeSetErrorCode`). Required, not defaulted: a new caller that forgot it
   * would silently report its failures as somebody else's operation.
   */
  errorCode: ChangeSetErrorCode;
  from: number;
  to: number;
  /** `updating`, or whatever verb `narrateStack` should use while it waits. */
  verb: string;
  keepLock: () => Promise<void>;
  signal?: AbortSignal;
  /**
   * What to say when CloudFormation reports the change set is empty. A
   * foundation update reads that as "already at this template"; a re-network
   * reads it as a stack that is already in the target mode, which is a
   * different sentence for the same fact.
   */
  noChangesMessage: string;
}

/**
 * Compute, inspect, execute, narrate. Returns the stack as it stands after —
 * re-read even in the no-changes case, because the outputs the fleet manifest
 * is built from must come from a fresh describe rather than from the guard's
 * copy taken minutes ago (§1).
 */
export async function* runChangeSet(
  deps: StackChangeDeps,
  params: RunChangeSetParams,
): AsyncGenerator<OpEvent, StackInfo> {
  const { backend, nowIso } = deps;
  const { guarded, name, phase } = params;
  yield evt(
    phase,
    params.from,
    `computing a CloudFormation change set for ${guarded.stack_name}`,
    nowIso(),
    undefined,
    "start",
  );
  let info: ChangeSetInfo;
  try {
    info = await computeChangeSet(deps, {
      name,
      create: params.create,
      phase,
      errorCode: params.errorCode,
      ...(params.signal ? { signal: params.signal } : {}),
      heartbeat: params.keepLock,
    });
  } catch (e) {
    await backend.foundation.deleteChangeSet(name).catch(() => {});
    throw e;
  }

  if (isNoChanges(info)) {
    await backend.foundation.deleteChangeSet(name);
    yield evt(phase, params.to, params.noChangesMessage, nowIso(), undefined, "done");
    return (await backend.foundation.describeStack()) ?? guarded;
  }
  if (info.status !== "CREATE_COMPLETE") {
    await backend.foundation.deleteChangeSet(name).catch(() => {});
    throw new HermeticError(
      params.errorCode,
      `CloudFormation could not compute a change set for ${guarded.stack_name}: ${info.statusReason ?? info.status}`,
      { status: info.status, reason: info.statusReason },
    );
  }

  const unsafe = unsafeReplacements(info);
  if (unsafe.length > 0) {
    await backend.foundation.deleteChangeSet(name).catch(() => {});
    throw new HermeticError(
      "FOUNDATION_UNSAFE",
      `the change set would REPLACE ${unsafe.join(", ")}; every agent row, event and object in them would be lost, so the update refuses. The change set has been deleted; fix the template so the change is in place, or plan a migration.`,
      { resources: unsafe },
    );
  }

  yield evt(
    phase,
    params.from + 0.02,
    `${info.changes.length} resource change(s): ${info.changes.map((c) => `${c.action} ${c.logicalId}`).join(", ")}`,
    nowIso(),
  );
  const updated = yield* narrateStack(
    (onProgress) =>
      backend.foundation.executeChangeSet({
        name,
        ...(params.signal ? { signal: params.signal } : {}),
        onProgress,
      }),
    {
      phase,
      from: params.from + 0.02,
      to: params.to,
      total: info.changes.length,
      heartbeatMs: deps.heartbeatMs ?? 30_000,
      // A foundation stack update can take longer than the lock's ten-minute
      // TTL on its own, so the lock is kept alive from inside the wait (§4.4).
      heartbeat: params.keepLock,
      verb: params.verb,
      stackName: guarded.stack_name,
      // Any resource that finished, whichever verb finished it: an update's
      // change set mixes Add, Modify and Remove, and each lands under its own
      // spelling. The stack's own transitions are filtered out upstream.
      landed: (status, resourceType) =>
        status.endsWith("_COMPLETE") && resourceType !== "AWS::CloudFormation::Stack",
      evt,
      nowIso,
    },
  );
  yield evt(
    phase,
    params.to,
    `${updated.stack_name} is ${updated.status}`,
    nowIso(),
    undefined,
    "done",
  );
  return updated;
}
