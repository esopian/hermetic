/**
 * Steer or stop one delegated child: `subagent.steer` / `subagent.interrupt`.
 *
 * A separate path from the turn's steer and abort (`hermes-chat-turn.ts`). It
 * needs no running parent turn — a background delegation's children outlive
 * the turn that started them — and it inserts nothing into the transcript.
 *
 * ## The control path (D25)
 *
 * Upstream authorises a child control RPC by socket *membership* in the
 * session's live transport slot (`delegate_tool_registry.py`
 * `_subagent_transport_matches`), and the child's record froze its owner's
 * runtime session at spawn. `session.resume` on a live session reuses that
 * runtime id and attaches the resuming socket as a peer
 * (`methods_session.py` `_resume_reuse_live`), so a fresh socket that resumes
 * the session holds the same authority the turn's socket did:
 *
 * 1. fresh socket → `session.resume {session_id: <stored>, profile, source,
 *    defer_history, omit_messages}` (the shape `chat.respond` and the turn use);
 * 2. when this process saw the child (a ledger holds it), the returned runtime
 *    id must be the one it was spawned under. A different one means the
 *    session was rebuilt and the child's authority went with it, so nothing is
 *    sent: `rejected` / `found: false`. A process that never saw the child —
 *    a CLI invocation, the app after a restart — has no runtime to compare,
 *    so it resolves the durable session from the request (`session`, else the
 *    bot's canonical conversation, as an abort does) and lets the gateway's
 *    own membership check decide; no session to resume is `rejected` with no
 *    socket opened;
 * 3. `subagent.steer {session_id: runtime, subagent_id, text}` →
 *    `queued | rejected`, or `subagent.interrupt {session_id: runtime,
 *    subagent_id}` → `{found}`, on the same socket.
 *
 * A 4001 ("session not found or not owned by this transport") or 4007 (no
 * such session) reads as the same outcome — the child is gone or the session
 * reset — and is not an error: the operator's next step is the same.
 *
 * `queued` is not "delivered": the child takes the text at its next tool
 * checkpoint, and one that reaches its end first notes the miss in its
 * summary (`[steer did not land — …]`, `steerMissed`). Upstream never answers
 * a missed steer synchronously.
 */
import { checkAbort } from "../../abort.ts";
import { HermeticError } from "../../errors.ts";
import type { BoxAddress, SendOptions, SubagentSteerStatus } from "./hermes-chat-types.ts";
import type { Rpc } from "./hermes-chat-rpc.ts";
import type { SubagentLedgers } from "./hermes-chat-subagent-ledgers.ts";
import type { createCanonicalSessions } from "../../render/hermes-canonical.ts";
import { HERMETIC_SESSION_SOURCE, rec, str } from "./hermes-chat-wire.ts";

/** Upstream's "session not found or not owned by this transport" / "session not found". */
const GONE_CODES: ReadonlySet<number> = new Set([4001, 4007]);

function gone(e: unknown): boolean {
  const code = e instanceof HermeticError ? e.details?.code : undefined;
  return typeof code === "number" && GONE_CODES.has(code);
}

export interface SubagentControlDeps {
  connect(box: BoxAddress, signal: AbortSignal | undefined): Promise<Rpc>;
  ledgers: SubagentLedgers;
  /** The canonical Bot Chat session, for a request that named none. */
  conversation: ReturnType<typeof createCanonicalSessions>["conversation"];
}

export function createSubagentControl(deps: SubagentControlDeps) {
  /**
   * A socket attached to the child's owning session, with that session's
   * runtime id — or null, with no control RPC sent, when no durable session
   * can be named, or a child this process saw is under a rebuilt session.
   */
  async function attach(
    box: BoxAddress,
    bot: string,
    subagentId: string,
    opts: SendOptions,
  ): Promise<{ rpc: Rpc; runtime: string } | null> {
    const owner = deps.ledgers.owning(box, bot, subagentId, opts.session ?? null);
    const stored =
      owner?.stored ??
      opts.session ??
      (await deps.conversation(box, bot, { signal: opts.signal }))?.session ??
      null;
    if (!stored) return null;
    const rpc = await deps.connect(box, opts.signal);
    try {
      const resumed = rec(
        await rpc.request("session.resume", {
          session_id: stored,
          profile: bot,
          source: HERMETIC_SESSION_SOURCE,
          defer_history: true,
          omit_messages: true,
        }),
      );
      const runtime = str(resumed?.session_id);
      if (!runtime || (owner && runtime !== owner.runtime)) {
        rpc.close();
        return null;
      }
      return { rpc, runtime };
    } catch (e) {
      rpc.close();
      if (gone(e)) return null;
      throw e;
    }
  }

  async function steer(
    box: BoxAddress,
    bot: string,
    subagentId: string,
    text: string,
    opts: SendOptions = {},
  ): Promise<SubagentSteerStatus> {
    checkAbort(opts.signal, "chat.steer");
    const found = await attach(box, bot, subagentId, opts);
    if (!found) return "rejected";
    try {
      const reply = rec(
        await found.rpc.request("subagent.steer", {
          session_id: found.runtime,
          subagent_id: subagentId,
          text,
        }),
      );
      return str(reply?.status) === "queued" ? "queued" : "rejected";
    } catch (e) {
      if (gone(e)) return "rejected";
      throw e;
    } finally {
      found.rpc.close();
    }
  }

  async function interrupt(
    box: BoxAddress,
    bot: string,
    subagentId: string,
    opts: SendOptions = {},
  ): Promise<boolean> {
    checkAbort(opts.signal, "chat.abort");
    const found = await attach(box, bot, subagentId, opts);
    if (!found) return false;
    try {
      const reply = rec(
        await found.rpc.request("subagent.interrupt", {
          session_id: found.runtime,
          subagent_id: subagentId,
        }),
      );
      return reply?.found === true;
    } catch (e) {
      if (gone(e)) return false;
      throw e;
    } finally {
      found.rpc.close();
    }
  }

  return { steer, interrupt };
}
