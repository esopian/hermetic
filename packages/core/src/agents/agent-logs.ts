/**
 * The two reads that reach a box rather than a table (§6.4, §9): `agent ssh`,
 * which hands the head an argv, and `agent logs`, which streams either the
 * journal over the hermeticd RPC, one of Hermes's own log files, or the
 * instance's serial console.
 *
 * Its own module with an explicit deps object, the shape `LifecycleDeps` and
 * `TeardownDeps` use (AGENTS.md rule 5): neither function needs the lifecycle's
 * closure — four things from it and nothing more — and `hermetic.ts` is at the
 * size where a block that can leave should.
 *
 * Pure extraction: the behaviour, the guards and the comments below are the
 * ones that were in `hermetic.ts`.
 */
import { agentHostname, cloudName } from "../schema/index.ts";
import type { Agent, LogsInput, SshInput } from "../schema/index.ts";
import type { LogLine } from "../backend/types.ts";
import { validateName } from "../shared/naming.ts";
import type { CoreContext } from "../context.ts";

/** The one option every long or interruptible read takes (§3.2 rule 2). */
export interface AgentLogsOptions {
  signal?: AbortSignal | undefined;
}

/** `ssh` and `logs` need nothing beyond the shared context. */
export interface AgentLogsDeps {
  ctx: CoreContext;
}

export function createAgentLogs(deps: AgentLogsDeps) {
  const { backend, guardFleet, getAgent } = deps.ctx;

  /**
   * Core never spawns: it returns the argv for the head to exec (§3.2 rule 1).
   *
   * The host is `agentHostname`, never the bare agent name. Two things make the
   * bare name wrong: since v4 a node is admitted to the tailnet as
   * `<fleet id>-<agent>` (`cloudName`), and after a recreate whose device cleanup
   * could not run, MagicDNS still points the canonical spelling at the corpse.
   * The row's `tailscale_dns_name` is what the node said about itself, so it
   * wins; the canonical cloud name is the fallback.
   */
  async function ssh(input: SshInput): Promise<string[]> {
    validateName(input.name);
    const { fleet } = await guardFleet();
    const agent = await getAgent(input.name);
    return [
      "tailscale",
      "ssh",
      agentHostname(agent, fleet.tailnet, cloudName(fleet.fleet_id, agent.name)),
    ];
  }

  /**
   * The serial console as `LogLine`s. EC2 hands back one buffer with one
   * timestamp, not a stream — every line carries that same `at`, which is
   * honest: the console has no per-line clock. `unit` is `console` so a caller
   * rendering mixed sources can still tell them apart.
   *
   * An agent with no instance, or an instance EC2 has nothing buffered for yet,
   * is not an error: a box thirty seconds into its first boot has genuinely not
   * said anything. The caller gets an empty stream and says so.
   */
  async function* consoleLines(agent: Agent, opts: AgentLogsOptions): AsyncIterable<LogLine> {
    if (!agent.instance_id) return;
    const console_ = await backend.compute.consoleOutput(agent.instance_id);
    if (!console_ || opts.signal?.aborted) return;
    for (const message of console_.output.split("\n")) {
      if (opts.signal?.aborted) return;
      yield { unit: "console", at: console_.at, message };
    }
  }

  /**
   * Streams journald over the hermeticd RPC (§6.4), one of Hermes's own log
   * files when `file` names one, or the instance's serial console when
   * `source: "console"`. The account guard is not optional here:
   * `logs` reads the agent row to find the tailnet address, and "which fleet am
   * I pointed at" must be answered before any of that (§4.7). The fleet guard
   * runs too — a read against another fleet's foundation is still the wrong
   * fleet.
   *
   * The two sources answer in opposite failure modes, which is why both exist.
   * The RPC needs stage `01-tailscale` to have run; a boot that dies before it
   * — the exact case an operator is looking at logs for — can only be read off
   * the console, which EC2 buffers whether or not the box is cooperating.
   *
   * `file` is the same RPC pointed at a different reader, and it is the one
   * that answers "why did this agent fail a turn": upstream writes nothing to
   * stderr unless it is run verbose, so the journal holds the banner while
   * `errors.log` holds the failure.
   */
  function logs(input: LogsInput, opts: AgentLogsOptions = {}): AsyncIterable<LogLine> {
    validateName(input.name);
    return (async function* () {
      await guardFleet();
      const agent = await getAgent(input.name);
      if (input.source === "console") {
        yield* consoleLines(agent, opts);
        return;
      }
      // `follow` reaches the box, because only the box can act on it: a
      // non-follow read is the one that ends by itself. `file` reaches it for
      // the same reason: which source answers is the box's to decide, and
      // `LogsInput` has already refused a request naming more than one.
      for await (const line of backend.rpc.logs(input.name, {
        unit: input.unit,
        file: input.file,
        follow: input.follow === true,
      })) {
        if (opts.signal?.aborted) return;
        yield line;
      }
    })();
  }

  return { ssh, logs };
}
