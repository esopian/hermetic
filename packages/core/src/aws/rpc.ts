import type { AgentStore, LogLine, RpcApi, RpcLogsOptions } from "../backend/types.ts";
import {
  HERMETICD_RPC_PORT,
  RPC_PATHS,
  RPC_PROTOCOL_VERSION,
  RPC_VERSION_HEADER,
  RpcFrame,
  RpcHealth,
} from "../schema/index.ts";
import { HermeticError } from "../errors.ts";
import type { FetchLike } from "./tailscale.ts";

/**
 * The operator half of the hermeticd RPC (§6.4). It reaches the agent over the
 * tailnet — `hermeticd` listens on the Tailscale interface only and authenticates
 * each caller with `tailscale whois`, so the tailnet ACL is the authorization
 * layer here just as it is for SSH. It reads and never commands: what used to
 * be pushed at a box is now pulled by it (§4.2, §4.4).
 *
 * The wire format is `packages/core/src/schema/rpc.ts`, shared with `agentd`.
 */

export interface HermeticdRpcOptions {
  fetch?: FetchLike;
  port?: number;
  /** `logs --follow` is unbounded by design; anything else honours this. */
  requestTimeoutMs?: number;
}

/**
 * How long `health()` waits before calling it a miss. Five seconds is chosen
 * against what the answer is *for*: an operator probing a box wants to know
 * quickly that it is not answering, and a live hermeticd on a tailnet replies
 * in milliseconds. A longer budget would only make a dead box slower to
 * diagnose without making a live one any more likely to be found.
 */
export const RPC_DEFAULT_TIMEOUT_MS = 5_000;

export class HermeticdRpc implements RpcApi {
  constructor(
    private readonly agents: AgentStore,
    private readonly opts: HermeticdRpcOptions = {},
  ) {}

  private get http(): FetchLike {
    return this.opts.fetch ?? ((input, init) => fetch(input, init));
  }

  private async base(name: string): Promise<string> {
    const agent = await this.agents.get(name);
    if (!agent) throw new HermeticError("NOT_FOUND", `no such agent: ${name}`, { name });
    if (!agent.tailscale_ip) {
      throw new HermeticError(
        "CONFLICT",
        `${name} has no tailscale address yet; hermeticd reports it on its first heartbeat`,
        { name, status: agent.status },
      );
    }
    return `http://${agent.tailscale_ip}:${this.opts.port ?? HERMETICD_RPC_PORT}`;
  }

  /**
   * The NDJSON reader. Every stream ends with exactly one `done` or one `error`
   * frame (`schema/rpc.ts`), and this stops reading at it: the frame *is* the
   * end of the stream, so whatever the socket does afterwards — a clean close,
   * a reset, an idle timeout on the box — is no longer this reader's business.
   *
   * That is why the terminal frame is tracked rather than merely yielded. A
   * transport error before `done` is a real failure and is thrown; the same
   * error after `done` is the connection being torn down behind a stream that
   * already said everything it had, and reporting it would turn a complete
   * `hermetic logs <name>` into an exit 1.
   */
  private async *frames(url: string, init: RequestInit): AsyncIterable<RpcFrame> {
    const res = await this.http(url, {
      ...init,
      headers: { ...(init.headers ?? {}), [RPC_VERSION_HEADER]: String(RPC_PROTOCOL_VERSION) },
    });
    if (!res.ok) {
      throw new HermeticError("INTERNAL", `hermeticd answered HTTP ${res.status} for ${url}`, {
        status: res.status,
      });
    }
    if (!res.body) return;

    const decoder = new TextDecoder();
    let buffer = "";
    let ended = false;
    try {
      // NDJSON: one frame per line, flushed as it happens.
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line.length > 0) {
            const frame = RpcFrame.parse(JSON.parse(line));
            ended = frame.type !== "log";
            yield frame;
            if (ended) return;
          }
          nl = buffer.indexOf("\n");
        }
      }
      const rest = buffer.trim();
      if (rest.length > 0) yield RpcFrame.parse(JSON.parse(rest));
    } catch (e) {
      if (!ended) throw e;
    }
  }

  /**
   * `GET /healthz` (§6.4), bounded. This is the only RPC that must *return* —
   * `logs --follow` is unbounded by design — so it is the one that reads
   * `requestTimeoutMs`, and it combines that budget with whatever signal the
   * caller brought rather than choosing between them: an operator's Ctrl-C and
   * a dead box are both reasons to stop, and honouring only one of them is how
   * a probe ends up hanging on the layer it exists to time out.
   *
   * Every failure is typed. `agents.probe` turns them into a `fail` layer with
   * the message as its detail, so what the operator reads is what happened.
   */
  async health(name: string, opts: { signal?: AbortSignal } = {}): Promise<RpcHealth> {
    const url = `${await this.base(name)}${RPC_PATHS.health}`;
    const timeout = AbortSignal.timeout(this.opts.requestTimeoutMs ?? RPC_DEFAULT_TIMEOUT_MS);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

    let res: Response;
    try {
      res = await this.http(url, {
        method: "GET",
        headers: { [RPC_VERSION_HEADER]: String(RPC_PROTOCOL_VERSION) },
        signal,
      });
    } catch (e) {
      // A timeout and a refused connection are the same answer to the operator
      // — "it did not reply" — but the reason is the interesting half, so it is
      // kept verbatim rather than flattened into one message.
      const why = timeout.aborted
        ? `did not answer within ${this.opts.requestTimeoutMs ?? RPC_DEFAULT_TIMEOUT_MS}ms`
        : e instanceof Error
          ? e.message
          : String(e);
      throw new HermeticError("INTERNAL", `hermeticd on ${name} ${why}`, { name });
    }

    if (!res.ok) {
      throw new HermeticError("INTERNAL", `hermeticd answered HTTP ${res.status} for ${url}`, {
        status: res.status,
      });
    }
    return RpcHealth.parse(await res.json());
  }

  /**
   * `GET /logs` (§6.4). `follow` is passed through rather than assumed: with it
   * the response body stays open until the operator stops reading, and without
   * it journalctl prints its backlog, exits, and hermeticd closes the stream
   * with `done`. Asking for a follow the caller did not want is what turned a
   * finished `hermetic logs <name>` into a socket error — the box had nothing
   * left to say and the quiet connection was eventually dropped.
   */
  logs(name: string, opts: RpcLogsOptions = {}): AsyncIterable<LogLine> {
    const self = this;
    const { unit, file, follow, tail } = opts;
    return (async function* () {
      const query = new URLSearchParams();
      // Only what was asked for: hermeticd's `LogsRequest` defaults both, and a
      // query that repeats the default is a second place for it to drift.
      if (unit) query.set("unit", unit);
      // The other source. hermeticd refuses a request carrying both, so the
      // caller's mutual exclusion is checked on the box as well as in `LogsInput`.
      if (file) query.set("file", file);
      if (follow) query.set("follow", "true");
      if (tail !== undefined) query.set("tail", String(tail));
      const search = query.toString();
      const url = `${await self.base(name)}${RPC_PATHS.logs}${search ? `?${search}` : ""}`;
      for await (const frame of self.frames(url, { method: "GET" })) {
        if (frame.type === "log") {
          yield { unit: frame.line.unit, at: frame.line.at, message: frame.line.message };
        } else if (frame.type === "error") {
          throw new HermeticError(frame.code, `${name}: ${frame.message}`, { name });
        }
      }
    })();
  }
}
