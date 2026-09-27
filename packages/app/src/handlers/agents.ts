/**
 * `agents.*` and `volumes.*`: one box, and the data volume under it.
 *
 * Every function here takes the same two things — a `HandlerContext` and the
 * caller's raw params — and returns either the plain value a read answers with
 * or `{ op_id, op }` (`accepted`) for a method that starts a long operation. Nothing in this file
 * knows what a status code is: a refusal is a thrown `HermeticError`, and the
 * transport decides what to do with the code.
 *
 * The schemas are declared here, with `declareRpc` recording what this handler
 * validates against core's surface — so the method and the schema the parity
 * contract compares cannot drift apart (`declare.ts`).
 */
import {
  AgentRefInput,
  CreateAgentInput,
  DeleteVolumeInput,
  DestroyAgentInput,
  HistoryInput,
  ListAgentsInput,
  LogsInput,
  ListVolumesInput,
  RecreateAgentInput,
  RerunInput,
  SetAgentInput,
  SshInput,
  VolumeRefInput,
} from "@hermetic/core";
import { HermeticError } from "@hermetic/core";
import type { Hermetic, PendingOpIdentity } from "@hermetic/core";
import { declareMachineryRpc, declareRpc } from "../declare.ts";
import { accepted, type Accepted } from "../ops.ts";
import { requireTarget, stillBound, withTarget } from "../target.ts";
import { parseInput } from "../validation.ts";
import type { HandlerContext } from "./ctx.ts";
import type { Handler } from "./dispatch.ts";
import { requireWritable, unconfirmed } from "./shared.ts";
import { StreamRefRequest, requireSink } from "./streams.ts";
import type { StreamSink } from "./streams.ts";

export const createSchema = declareRpc("agents.create", CreateAgentInput);
export const listSchema = declareRpc("agents.list", ListAgentsInput);
export const getSchema = declareRpc("agents.get", AgentRefInput);
export const setSchema = declareRpc("agents.set", SetAgentInput);
export const stopSchema = declareRpc("agents.stop", AgentRefInput);
export const startSchema = declareRpc("agents.start", AgentRefInput);
export const recreateSchema = declareRpc("agents.recreate", RecreateAgentInput);
export const destroySchema = declareRpc("agents.destroy", DestroyAgentInput);
export const historySchema = declareRpc("agents.history", HistoryInput);
export const rerunSchema = declareRpc("agents.rerun", RerunInput);
export const probeSchema = declareRpc("agents.probe", AgentRefInput);
export const desktopSchema = declareRpc("agents.desktop", AgentRefInput);
export const rebootSchema = declareRpc("agents.reboot", AgentRefInput);
export const sshSchema = declareRpc("ssh", SshInput);
export const logsSchema = declareRpc("logs", LogsInput);
export const volumesListSchema = declareRpc("volumes.list", ListVolumesInput);
export const volumeGetSchema = declareRpc("volumes.get", VolumeRefInput);
export const volumeDeleteSchema = declareRpc("volumes.delete", DeleteVolumeInput);

/**
 * The console tail is the one public method that only ever streams, so it
 * wears two names: `logs` is the method, and the machinery pair below is how
 * a transport with no socket works it — `logs.open` is the same function, and
 * `logs.close` is the other half (`streams.ts`).
 */
export const LOGS_OPEN = declareMachineryRpc("logs.open");
export const LOGS_CLOSE = declareMachineryRpc("logs.close");

// §4.7 mutation bodies — see `handlers/shared.ts` and `target.ts`. The binding
// validates against these too, so the HTTP contract and the handler's own
// parse describe the same object.
export const createBody = withTarget(createSchema);
export const setBody = withTarget(setSchema);
export const stopBody = withTarget(stopSchema);
export const startBody = withTarget(startSchema);
export const rebootBody = withTarget(rebootSchema);
export const recreateBody = withTarget(recreateSchema);
export const destroyBody = withTarget(destroySchema);
export const rerunBody = withTarget(rerunSchema);
export const volumeDeleteBody = withTarget(volumeDeleteSchema);

/**
 * The immutable half of an agent row, for the pending log (§4.7).
 *
 * Best effort by design: a read that fails is not a reason to refuse a
 * destroy the operator has already confirmed — it is a reason not to *finish*
 * that destroy unattended at some later boot, which is what an absent
 * identity means to `resume.ts`.
 */
async function agentIdentity(h: Hermetic, name: string): Promise<PendingOpIdentity | null> {
  try {
    const agent = await h.agents.get(name);
    return { instance_id: agent.instance_id ?? null, created_at: agent.created_at ?? null };
  } catch {
    return null;
  }
}

export async function list(ctx: HandlerContext, params: unknown) {
  return await ctx.hermetic().agents.list(parseInput(listSchema, params));
}

export async function get(ctx: HandlerContext, params: unknown) {
  return await ctx.hermetic().agents.get(parseInput(getSchema, params).name);
}

export async function create(ctx: HandlerContext, params: unknown): Promise<Accepted> {
  requireWritable(ctx.state);
  const { hermetic: h, input } = requireTarget(ctx.state, parseInput(createBody, params));
  /**
   * `resumable`: create now waits for the instance to boot however long
   * that takes (`core/attach.ts`), so having the process closed while one
   * is in flight is ordinary, and `resume.ts` picks it up at the next boot.
   *
   * `api_key` is stripped from what is recorded — the recorded input is
   * both served by the op registry and written to `hermetic.db`, and a
   * provider key may be neither (§8.3). Core has already put it in SSM by
   * the time a resume runs; if the crash came first, the resumed create
   * says the slot is still empty instead of pretending otherwise.
   */
  const { api_key: _api_key, ...recorded } = input;
  const op = ctx.ops.start(
    "agents.create",
    input.name,
    (signal) => h.agents.create(input, { signal }),
    { input: recorded, resumable: true },
  );
  return accepted(op);
}

export async function destroy(ctx: HandlerContext, params: unknown): Promise<Accepted> {
  requireWritable(ctx.state);
  const bound = requireTarget(ctx.state, parseInput(destroyBody, unconfirmed(params)));
  const { hermetic: h, input } = bound;
  // Confirmation is a precondition, not an op failure: refuse now rather than
  // accept an op that was never going to run (§3.2 rule 3 — the head
  // confirms). `CONFIRMATION_REQUIRED` is the 428 the HTTP binding answers.
  if (!input.yes) {
    throw new HermeticError(
      "CONFIRMATION_REQUIRED",
      `destroying ${input.name} is irreversible; send {"yes": true}`,
      { name: input.name },
    );
  }
  /**
   * `resumable`: a destroy is the one *destructive* op in `RESUMABLE`
   * (`resume.ts`), and it is there because stopping halfway is the worse
   * outcome — a portal that died between the terminate and the volume
   * delete strands the agent in `destroying` with its instance already
   * gone (§6.6). The row only ever exists for a destroy the operator
   * confirmed above, and `resume.ts` will not act on a stale one.
   */
  /**
   * §4.7: what this destroy was confirmed *against*. An agent name is a
   * label that can be freed and taken again, so a pending row replayed at
   * the next boot has to be able to tell the agent the operator confirmed
   * from a successor that took its name — `resume.ts` compares this and
   * refuses on any disagreement. Best effort: a row that cannot be read
   * is not a reason to refuse the destroy, only a reason not to finish it
   * unattended later.
   */
  const identity = await agentIdentity(h, input.name);
  // §4.7: the read above is this handler's only `await` before it acts,
  // and `ops.start` stamps the run and pending rows with whatever fleet
  // the server is on *then*. Re-take the binding, so either the op starts
  // in a turn no switch has intervened in or the request is refused.
  stillBound(ctx.state, bound);
  const op = ctx.ops.start(
    "agents.destroy",
    input.name,
    (signal) => h.agents.destroy(input, { signal }),
    { input, resumable: true, identity },
  );
  return accepted(op);
}

export async function history(ctx: HandlerContext, params: unknown) {
  return await ctx.hermetic().agents.history(parseInput(historySchema, params));
}

/**
 * `agents.probe` (§9): read-only, so it carries no write guard. A probe during
 * a foundation update or a teardown is exactly when an operator most wants
 * one, and it mutates nothing that either op could race.
 *
 * It can take several seconds when a layer times out; that is the answer, not
 * a hang, so it is an ordinary request rather than an op. `ctx.signal` is the
 * caller going away: a browser that navigated away mid-probe should stop three
 * outbound network calls, not finish paying for them.
 */
export async function probe(ctx: HandlerContext, params: unknown) {
  const { name } = parseInput(probeSchema, params);
  return await ctx.hermetic().agents.probe(name, { signal: ctx.signal });
}

/**
 * `agents.desktop` (§7.4): the Serve URL and the box's current dashboard
 * session token, for Hermes Desktop's remote-gateway form.
 *
 * Unguarded beside `probe` for the same reasons — read-only, writes nothing,
 * and worth answering while a foundation update holds the fleet. It reaches
 * the box, so it inherits `probe`'s signal handling too.
 *
 * The response carries a live credential, which is why it is never logged:
 * `log.ts` records the method and the outcome of a request, never its body,
 * and this is the one call where that distinction is load-bearing.
 */
export async function desktop(ctx: HandlerContext, params: unknown) {
  return await ctx.hermetic().agents.desktop(parseInput(desktopSchema, params), {
    signal: ctx.signal,
  });
}

export async function ssh(ctx: HandlerContext, params: unknown) {
  // Core returns argv and never spawns (§3.2 rule 1).
  return { argv: await ctx.hermetic().ssh(parseInput(sshSchema, params)) };
}

export async function set(ctx: HandlerContext, params: unknown) {
  requireWritable(ctx.state);
  const { hermetic: h, input } = requireTarget(ctx.state, parseInput(setBody, params));
  return await h.agents.set(input);
}

export async function stop(ctx: HandlerContext, params: unknown): Promise<Accepted> {
  requireWritable(ctx.state);
  const { hermetic: h, input } = requireTarget(ctx.state, parseInput(stopBody, params));
  const { name } = input;
  const op = ctx.ops.start("agents.stop", name, (signal) => h.agents.stop(name, { signal }));
  return accepted(op);
}

export async function start(ctx: HandlerContext, params: unknown): Promise<Accepted> {
  requireWritable(ctx.state);
  const { hermetic: h, input } = requireTarget(ctx.state, parseInput(startBody, params));
  const { name } = input;
  const op = ctx.ops.start("agents.start", name, (signal) => h.agents.start(name, { signal }));
  return accepted(op);
}

export async function recreate(ctx: HandlerContext, params: unknown): Promise<Accepted> {
  requireWritable(ctx.state);
  const bound = requireTarget(ctx.state, parseInput(recreateBody, unconfirmed(params)));
  const { hermetic: h, input } = bound;
  // Recreate throws the instance away. The head confirms (§3.2 rule 3).
  if (input.yes !== true) {
    throw new HermeticError(
      "CONFIRMATION_REQUIRED",
      `recreating ${input.name} replaces its instance; send {"yes": true}`,
      { name: input.name },
    );
  }
  const identity = await agentIdentity(h, input.name);
  // §4.7, as on destroy above: the identity read is an `await`, and the
  // op must start in a turn the binding is still good for.
  stillBound(ctx.state, bound);
  const op = ctx.ops.start(
    "agents.recreate",
    input.name,
    (signal) => h.agents.recreate(input, { signal }),
    { input, resumable: true, identity },
  );
  return accepted(op);
}

/**
 * `rerun` is not an op: core writes one command on the row and returns it.
 * What follows is the box's, and the browser watches it through the fleet
 * poller like any other row change (§4.2).
 */
export async function rerun(ctx: HandlerContext, params: unknown) {
  requireWritable(ctx.state);
  const { hermetic: h, input } = requireTarget(ctx.state, parseInput(rerunBody, params));
  return await h.agents.rerun(input);
}

/**
 * `reboot` is not an op either: one `RebootInstances` and one row write, and
 * then the box comes back on its own. There is no phase sequence to stream and
 * nothing to resume, so it answers like `rerun` does.
 */
export async function reboot(ctx: HandlerContext, params: unknown) {
  requireWritable(ctx.state);
  const { hermetic: h, input } = requireTarget(ctx.state, parseInput(rebootBody, params));
  return await h.agents.reboot(input);
}

/**
 * §9's volume surface. All three are ordinary request/response — none of them
 * is a long operation: two are reads, and the delete is one `DeleteVolume`.
 * The delete refuses `CONFIRMATION_REQUIRED` rather than starting something
 * doomed when the body does not confirm, the same shape `agents.destroy` uses.
 */
export async function volumesList(ctx: HandlerContext, params: unknown) {
  return await ctx.hermetic().volumes.list(parseInput(volumesListSchema, params));
}

export async function volumeGet(ctx: HandlerContext, params: unknown) {
  return await ctx.hermetic().volumes.get(parseInput(volumeGetSchema, params));
}

export async function volumeDelete(ctx: HandlerContext, params: unknown) {
  // A teardown is already deleting volumes wholesale; a second deleter
  // racing it is nobody's idea of a good time (§6.6).
  requireWritable(ctx.state);
  const { hermetic: h, input } = requireTarget(
    ctx.state,
    parseInput(volumeDeleteBody, unconfirmed(params)),
  );
  // Confirmation is a precondition, not a failure — the same refusal the
  // agent destroy handler answers with.
  if (!input.yes) {
    throw new HermeticError(
      "CONFIRMATION_REQUIRED",
      `deleting ${input.volume_id} is irreversible; send {"yes": true}`,
      { volume_id: input.volume_id },
    );
  }
  return await h.volumes.delete(input);
}

/**
 * `logs` (§9): the box's journal, a named unit's, Hermes's own log files on the
 * data volume, or the serial console when the box's RPC never came up.
 *
 * The one public method whose only answer is a stream, so it is the streaming
 * shape described in `streams.ts` rather than a value: it pumps `line` frames
 * into the sink until core's iterator ends, closes with one `done`, and hands
 * back the id the caller stops it by.
 *
 * Read-only, so it carries no write guard — a tail during a teardown or a
 * foundation update is exactly when an operator most wants one.
 */
export async function logs(
  ctx: HandlerContext,
  params: unknown,
  sink: StreamSink,
): Promise<{ stream_id: string }> {
  const input = parseInput(logsSchema, params);
  const h = ctx.hermetic();
  const controller = new AbortController();
  const done = (async () => {
    try {
      for await (const line of h.logs(input, { signal: controller.signal })) {
        await sink({ event: "line", data: line });
      }
      await sink({ event: "done", data: { ok: true } });
    } catch {
      // `done` never rejects (`streams.ts`): a tail that dies with the socket,
      // or with the box, ends the stream rather than the process.
    }
  })();
  const stream_id = ctx.streams.open({ close: () => controller.abort(), done });
  // A tail that ran out has nothing left to close; forgetting it here is what
  // keeps the registry the size of what is actually open.
  void done.then(() => {
    ctx.streams.close(stream_id);
  });
  return { stream_id };
}

export async function logsClose(ctx: HandlerContext, params: unknown): Promise<{ closed: boolean }> {
  const { stream_id } = parseInput(StreamRefRequest, params);
  return { closed: ctx.streams.close(stream_id) };
}

/** The open half, with the sink `Handler` leaves optional made required again. */
const logsEntry: Handler = (ctx, params, sink) => logs(ctx, params, requireSink(sink));

/**
 * This module's contribution to the dispatch table. `dispatch.ts` is nothing
 * but the merge of these, so adding a method here is the only edit a new
 * method needs on this side.
 *
 * `logs` appears three times over: once as the public method, and once under
 * each half of the machinery pair a socketless transport opens and closes it
 * with. All three are the same two functions.
 */
export const agentHandlers = {
  "agents.create": create,
  "agents.list": list,
  "agents.get": get,
  "agents.set": set,
  "agents.stop": stop,
  "agents.start": start,
  "agents.recreate": recreate,
  "agents.destroy": destroy,
  "agents.history": history,
  "agents.rerun": rerun,
  "agents.probe": probe,
  "agents.desktop": desktop,
  "agents.reboot": reboot,
  ssh,
  logs: logsEntry,
  [LOGS_OPEN]: logsEntry,
  [LOGS_CLOSE]: logsClose,
  "volumes.list": volumesList,
  "volumes.get": volumeGet,
  "volumes.delete": volumeDelete,
} satisfies Record<string, Handler>;
