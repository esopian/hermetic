/**
 * The operator RPC listener (§6.4). Bound to the Tailscale interface only, port
 * 7434, and every request authenticated with `tailscale whois --json <peer-ip>`:
 * the tailnet ACL is the authorization layer for RPCs exactly as it is for SSH.
 * A peer `whois` cannot identify is not on the tailnet — 403, no exceptions.
 * Nor is a peer it *can* identify automatically entitled: `rpcAccess` restates
 * the ACL hermetic writes (`src: autogroup:member`) on the box, so a tagged
 * node — every other agent in this fleet included — is refused as well. Every
 * request, allowed or refused, leaves one audit line.
 *
 * Wire format is core's `@hermetic/core/schema` `rpc.ts`: NDJSON, one `RpcFrame`
 * per line, flushed as it happens. Two routes and no more: `GET /healthz` says
 * who this box is and what it is running, and `GET /logs` streams journald — or,
 * with `file=`, one of Hermes's own rotating logs on the data volume.
 * There is deliberately nothing here that *changes* the box — a config change
 * goes out by rerendering and rerunning the bootstrap stages (§4.2), not by an
 * operator reaching in over RPC, so this listener has no write path to abuse.
 */
import type { ErrorCode, HermesLogFile, RpcFrame, RpcHealth, RpcLogLine } from "@hermetic/core/schema";
import { LogsRequest, encodeRpcFrame } from "@hermetic/core/schema";
import {
  HERMES_DASHBOARD_UNIT,
  HERMES_HOME,
  HERMETICD_RPC_PORT,
  RPC_CONTENT_TYPE,
  RPC_PATHS,
  RPC_PROTOCOL_VERSION,
  RPC_VERSION_HEADER,
} from "@hermetic/core/shared";
import type { Host } from "./host.ts";
import { tailscaleIpv4 } from "./tailscale.ts";
import { AgentdError } from "./errors.ts";

export { HERMETICD_RPC_PORT };

/** What `tailscale whois --json` tells us about the caller. */
export interface Whois {
  readonly login: string;
  readonly node: string;
  readonly tags: readonly string[];
}

export type WhoisResolver = (peerIp: string) => Promise<Whois | null>;

/** Lines of one unit's journal. `signal` aborts when the client hangs up. */
export type JournalReader = (
  unit: string,
  tail: number,
  follow: boolean,
  signal?: AbortSignal,
) => AsyncIterable<string>;

/** Lines of one of Hermes's own log files, same contract. */
export type HermesLogReader = (
  file: HermesLogFile,
  tail: number,
  follow: boolean,
  signal?: AbortSignal,
) => AsyncIterable<string>;

export interface RpcDeps {
  readonly host: Host;
  readonly name: string;
  readonly hermeticdVersion: string;
  /** The `config_hash` of the agent manifest on disk, for `GET /healthz`. */
  readonly configHash: () => Promise<string | null>;
  /**
   * What the box's browser identities are doing, for `GET /healthz` (§7.3).
   *
   * A callback for the same reason `configHash` is one — it is read per request
   * from the manifest on disk, so a converge changes the answer — and optional
   * so the listener has nothing browser-shaped in it: a caller that does not
   * wire it, and a manifest that lists no browsers, both leave the field off
   * the response entirely. `agents.probe` reads an absent field as "not asked"
   * rather than "none are running" (`probe.ts`'s `browserLayer`).
   */
  readonly browsers?: () => Promise<RpcHealth["browsers"]>;
  readonly whois: WhoisResolver;
  /**
   * Journal reader, injected so tests never touch journald. `signal` is aborted
   * when the client drops the stream; a reader that spawns anything must pass
   * it on, or a followed read outlives the request that asked for it.
   */
  readonly journal?: JournalReader;
  /** Hermes log-file reader, injected for the same reason as `journal`. */
  readonly hermesLog?: HermesLogReader;
  /**
   * Tags a caller may present, beyond the default rule below. Empty in every
   * build so far: the fleet manifest carries no allowed-tags list, and there is
   * nowhere else on the box that names one. It is a parameter rather than a
   * constant so that the day the manifest grows the field, the policy has a
   * door to come in through instead of a fork.
   */
  readonly allowedTags?: readonly string[];
  /** Where the audit line goes. `main.ts`'s `log`, which redacts, in the service. */
  readonly log?: (message: string) => void;
}

/**
 * The login `tailscale whois` reports for a *tagged* node — a machine acting as
 * itself rather than on behalf of a person. Tailscale's own sentinel, not ours.
 */
export const TAGGED_DEVICES_LOGIN = "tagged-devices";

/** Whether a caller may drive this listener at all, and the reason either way. */
export interface RpcAccess {
  readonly allowed: boolean;
  readonly reason: string;
}

/**
 * Who is allowed to reach `logs` and `healthz`.
 *
 * The tailnet ACL is the authorization layer (§6.4), and this is that ACL's own
 * rule restated on the box. What hermetic writes into the policy file is
 * (§5.2):
 *
 *     { "action": "accept", "src": ["autogroup:member"],
 *       "dst": ["tag:hermetic:22", "tag:hermetic:443", "tag:hermetic:7434"] }
 *
 * `src` is `autogroup:member` — a *person* on the tailnet. A tagged node is not
 * a member, so nothing hermetic asks for grants one access to port 7434, and an
 * operator's laptop always arrives as a member. The previous check stopped one
 * step short of saying so: it fetched `who.login` and `who.tags` and then used
 * neither, so any peer `whois` could name — including another agent box in this
 * very fleet, all of which carry `tag:hermetic` — got the full journal of every
 * unit on the machine.
 *
 * So the default is the conservative reading of that ACL rather than a guess at
 * an operator's identity: a caller must present a human login and carry no tags.
 * The box cannot do better than that on its own — it knows its fleet, not the
 * list of humans entitled to it, and inventing an operator allowlist out of the
 * fleet manifest's `updated_by` (an AWS principal, not a tailnet login) would
 * lock out the second operator §4.4 exists for. The ACL remains what decides
 * *which* members; this decides that it is a member at all.
 *
 * Deliberately accepted: any tailnet member the ACL lets through still gets
 * logs. Narrowing that further belongs in the policy file, where an operator
 * can see it, not in a binary on fifty boxes.
 */
export function rpcAccess(who: Whois | null, allowedTags: readonly string[] = []): RpcAccess {
  if (who === null) return { allowed: false, reason: "not on the tailnet" };
  if (who.tags.length > 0) {
    const matched = who.tags.filter((tag) => allowedTags.includes(tag));
    return matched.length > 0
      ? { allowed: true, reason: `tagged ${matched.join(",")}` }
      : {
          allowed: false,
          reason: `a tagged node (${who.tags.join(",")}) is not a tailnet member`,
        };
  }
  if (who.login === "" || who.login === TAGGED_DEVICES_LOGIN) {
    return { allowed: false, reason: "no tailnet user identity" };
  }
  return { allowed: true, reason: "tailnet member" };
}

/** `(request, peerIp) => Response` — an `app.fetch`-shaped handler, testable in-process. */
export type RpcHandler = (request: Request, peerIp: string) => Promise<Response>;

const NDJSON_HEADERS = {
  "content-type": RPC_CONTENT_TYPE,
  "cache-control": "no-store",
  [RPC_VERSION_HEADER]: String(RPC_PROTOCOL_VERSION),
};

function frame(f: RpcFrame): Uint8Array {
  return new TextEncoder().encode(encodeRpcFrame(f));
}

/**
 * Frames out as a response body, and — the part that is not decoration — the
 * child process stopped when the body is dropped.
 *
 * A `--follow` stream ends one of two ways: the client reads it to the end, or
 * the client goes away. Only the first used to be handled. The second left
 * `journalctl --follow`, or a `tail -F`, running on the box with nobody
 * reading: it does not notice a closed pipe until it next writes, so on a log
 * that has gone quiet — which is precisely the log an operator stops watching —
 * that is indefinite. Every abandoned `hermetic logs --follow` left one behind.
 *
 * So `cancel` fires `onCancel`, which is wired to the `AbortSignal` the reader
 * gave the child, and returns the iterator for the sake of any `finally` up the
 * generator chain. The signal is what actually does it: a parked async
 * generator cannot be resumed by `return()` (see `ExecOptions.signal`).
 */
function ndjson(source: AsyncIterable<RpcFrame>, onCancel: () => void = () => {}): Response {
  const iterator = source[Symbol.asyncIterator]();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (;;) {
          const next = await iterator.next();
          if (next.done === true) break;
          controller.enqueue(frame(next.value));
        }
      } catch (e) {
        // A failed enqueue means the consumer is already gone, and the error
        // frame has nowhere to go. That is not itself an error worth throwing
        // out of `start`, where nothing would catch it.
        try {
          controller.enqueue(
            frame({
              type: "error",
              code: "INTERNAL",
              message: e instanceof Error ? e.message : String(e),
            }),
          );
        } catch {
          // Nobody is listening.
        }
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed by a cancel.
        }
      }
    },
    async cancel() {
      onCancel();
      await iterator.return?.(undefined);
    },
  });
  return new Response(stream, { status: 200, headers: NDJSON_HEADERS });
}

function refuse(status: number, message: string, code: ErrorCode = "INTERNAL"): Response {
  return new Response(encodeRpcFrame({ type: "error", code, message }), {
    status,
    headers: NDJSON_HEADERS,
  });
}

/**
 * `tailscale whois --json <ip>`. A non-zero exit or unparseable output means the
 * peer is not a tailnet node, which is the only answer that matters here.
 */
export function tailscaleWhois(host: Host): WhoisResolver {
  return async (peerIp: string) => {
    const res = await host.exec(["tailscale", "whois", "--json", peerIp]);
    if (res.code !== 0) return null;
    try {
      const parsed = JSON.parse(res.stdout) as {
        UserProfile?: { LoginName?: string };
        Node?: { Name?: string; Tags?: string[] };
      };
      const node = parsed.Node?.Name;
      const login = parsed.UserProfile?.LoginName;
      if (!node && !login) return null;
      return { login: login ?? "", node: node ?? "", tags: parsed.Node?.Tags ?? [] };
    } catch {
      return null;
    }
  };
}

/**
 * One line per request, whatever the verdict.
 *
 * The RPC is the only way into this box that is not SSH, and it hands out the
 * journal of every unit on it. Until now it left no trace of who asked: an
 * operator reading the log of a box could not tell whether anyone else had.
 * Identity, node, method, path and outcome — and nothing about the *content* of
 * the answer, which is the part that carries secrets. `log` redacts (§8.3).
 */
function auditLine(
  who: Whois | null,
  peerIp: string,
  request: Request,
  path: string,
  verdict: string,
): string {
  const login = who?.login === "" || who === null ? "-" : who.login;
  const node = who?.node === "" || who === null ? "-" : who.node;
  const tags = who && who.tags.length > 0 ? who.tags.join(",") : "-";
  return `rpc ${request.method} ${path} from ${peerIp} node=${node} login=${login} tags=${tags} ${verdict}`;
}

/**
 * How long one peer's refusals collapse into a single audit line, and how many
 * peers are tracked at once.
 *
 * An allowed request is rare and deliberate, so it is always logged. A refusal
 * is the opposite: anything that can reach port 7434 can produce one as fast as
 * it can open sockets, and a line each would let an unauthorised peer fill the
 * journal — evicting the very records this audit trail exists to keep, on a box
 * with a 30 GB root volume. So refusals are logged once per peer per window,
 * with the suppressed count carried into the next line, and the map is bounded
 * so the rate limiter itself cannot be turned into the memory leak.
 */
export const REFUSAL_LOG_WINDOW_MS = 5 * 60_000;
export const REFUSAL_LOG_PEERS = 256;

export function makeRpcHandler(deps: RpcDeps): RpcHandler {
  const journal = deps.journal ?? defaultJournal(deps.host);
  const hermesLog = deps.hermesLog ?? defaultHermesLog(deps.host);
  const say = deps.log ?? (() => {});
  const allowedTags = deps.allowedTags ?? [];
  /** peer → when its refusal was last logged, and how many since. */
  const refusals = new Map<string, { at: number; suppressed: number }>();

  /** True when this peer's refusal should be written; counts it either way. */
  function shouldLogRefusal(peerIp: string, now: number): { log: boolean; suppressed: number } {
    const seen = refusals.get(peerIp);
    if (seen && now - seen.at < REFUSAL_LOG_WINDOW_MS) {
      seen.suppressed += 1;
      return { log: false, suppressed: seen.suppressed };
    }
    if (refusals.size >= REFUSAL_LOG_PEERS && !seen) {
      // Oldest out. A flood from many addresses must cost a bounded amount of
      // memory, and the peer evicted is the one that has been quiet longest.
      const oldest = [...refusals.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) refusals.delete(oldest[0]);
    }
    refusals.set(peerIp, { at: now, suppressed: 0 });
    return { log: true, suppressed: seen?.suppressed ?? 0 };
  }

  return async (request, peerIp) => {
    const who = await deps.whois(peerIp).catch(() => null);
    const url = new URL(request.url);
    const access = rpcAccess(who, allowedTags);
    if (access.allowed) {
      say(auditLine(who, peerIp, request, url.pathname, "ok"));
    } else {
      const { log: write, suppressed } = shouldLogRefusal(peerIp, deps.host.now().getTime());
      if (write) {
        const since = suppressed > 0 ? ` (+${suppressed} suppressed)` : "";
        say(auditLine(who, peerIp, request, url.pathname, `refused: ${access.reason}${since}`));
      }
    }
    if (!access.allowed) {
      // The tailnet ACL is the authorization layer (§6.4) and this is its rule
      // restated here. HTTP 403 and `FORBIDDEN` say the same thing, so a client
      // can branch on either. The reason is the caller's own identity, which it
      // already knows, so saying it leaks nothing and saves a support round.
      return refuse(403, `peer ${peerIp} may not use this RPC: ${access.reason}`, "FORBIDDEN");
    }

    if (request.method === "GET" && url.pathname === RPC_PATHS.health) {
      const browsers = deps.browsers ? await deps.browsers() : undefined;
      const health: RpcHealth = {
        name: deps.name,
        hermeticd_version: deps.hermeticdVersion,
        protocol: RPC_PROTOCOL_VERSION,
        config_hash: await deps.configHash(),
        // Spread rather than assigned: `undefined` would serialise to a missing
        // key anyway, but the type says "this build did not answer" and the
        // object should say the same thing.
        ...(browsers === undefined ? {} : { browsers }),
      };
      return Response.json(health, { headers: { [RPC_VERSION_HEADER]: String(RPC_PROTOCOL_VERSION) } });
    }

    if (request.method === "GET" && url.pathname === RPC_PATHS.logs) {
      const parsed = LogsRequest.safeParse({
        unit: url.searchParams.get("unit"),
        file: url.searchParams.get("file"),
        follow: url.searchParams.get("follow") === "1" || url.searchParams.get("follow") === "true",
        ...(url.searchParams.has("tail") ? { tail: Number(url.searchParams.get("tail")) } : {}),
      });
      if (!parsed.success) return refuse(400, "bad logs query", "UNSUPPORTED");
      // One controller per streamed request, aborted when the body is dropped.
      // It reaches the child through the reader, which is why both readers take
      // it: killing what this request started is this request's job.
      const stop = new AbortController();
      // `file=` is the other source: journald has the banner and uvicorn's
      // noise, while the turn that failed is in `$HERMES_HOME/logs`. Same
      // frames either way, so a client reads one stream and does not care
      // which side of the box it came from.
      if (parsed.data.file) {
        return ndjson(
          fileFrames(
            hermesLog,
            parsed.data.file,
            parsed.data.tail,
            parsed.data.follow,
            deps.host,
            stop.signal,
          ),
          () => stop.abort(),
        );
      }
      // The dashboard is the default because it is what an operator asking for
      // "the agent's logs" means. It is not the only unit worth streaming: an
      // agent is two Hermes processes (§6.4), so `unit` may equally be
      // `hermes-gateway.service` — where the messaging channels and the cron
      // jobs run — or any other unit on the box. Any unit is streamable; only
      // the default is opinionated.
      const unit = parsed.data.unit ?? HERMES_DASHBOARD_UNIT;
      return ndjson(logFrames(journal, unit, parsed.data.tail, parsed.data.follow, stop.signal), () =>
        stop.abort(),
      );
    }

    return refuse(404, `no such route: ${request.method} ${url.pathname}`, "NOT_FOUND");
  };
}

async function* logFrames(
  journal: JournalReader,
  unit: string,
  tail: number,
  follow: boolean,
  signal?: AbortSignal,
): AsyncIterable<RpcFrame> {
  for await (const raw of journal(unit, tail, follow, signal)) {
    const line = mapJournalLine(unit, raw);
    if (line) yield { type: "log", line };
  }
  yield { type: "done", ok: true };
}

/** Where Hermes's own rotating logs live: one directory on the data volume. */
export const HERMES_LOG_DIR = `${HERMES_HOME}/logs`;

/** Absolute path of one Hermes log file. */
export function hermesLogPath(file: HermesLogFile): string {
  return `${HERMES_LOG_DIR}/${file}.log`;
}

/**
 * A Hermes log file as frames.
 *
 * The shape is deliberately the journal's, so nothing downstream branches on
 * the source. Two fields are read differently, and both are honest about what a
 * flat file can say: `unit` is the file name rather than a systemd unit, so a
 * reader showing mixed sources can still label the line, and `at` is when
 * hermeticd read it rather than when Hermes wrote it — the file's own timestamp
 * is inside `message`, in upstream's format, and re-deriving it here would be a
 * second parser to keep in step with upstream's formatter.
 */
async function* fileFrames(
  reader: HermesLogReader,
  file: HermesLogFile,
  tail: number,
  follow: boolean,
  host: Host,
  signal?: AbortSignal,
): AsyncIterable<RpcFrame> {
  const unit = `${file}.log`;
  // `errors.log` is WARNING and above by construction, so every line in it is
  // the thing a reader wants highlighted — the same call the journal's
  // priority mapping makes, from the only signal a flat file offers.
  const stream = file === "errors" ? "stderr" : "stdout";
  for await (const message of reader(file, tail, follow, signal)) {
    yield { type: "log", line: { unit, at: host.now().toISOString(), message, stream } };
  }
  yield { type: "done", ok: true };
}

/**
 * `tail -n <tail> [-F] $HERMES_HOME/logs/<file>.log`.
 *
 * A file that is not there yet is not an error: Hermes creates each of these on
 * its first run, so an operator reading them on a box that has just booted is
 * asking a reasonable question with a boring answer, and an error frame would
 * make it look like the RPC failed. One line saying so, then the stream ends.
 *
 * Only for a bounded read, though. `-F` differs from `-f` in exactly this: it
 * waits for a path that does not exist yet and starts reading when it appears.
 * Someone watching a box mid-bootstrap is asking to be told when Hermes writes
 * its first line, and answering "it does not exist" and hanging up is the one
 * response that cannot be right — so when `follow` is set the stat is skipped
 * and `tail -F` is left to do the waiting it is there for.
 */
function defaultHermesLog(host: Host): HermesLogReader {
  return async function* (
    file: HermesLogFile,
    tail: number,
    follow: boolean,
    signal?: AbortSignal,
  ): AsyncIterable<string> {
    const path = hermesLogPath(file);
    if (!follow && (await host.stat(path)) === null) {
      yield `${path} does not exist yet — Hermes writes it on its first run`;
      return;
    }
    const argv = ["tail", "-n", String(tail), ...(follow ? ["-F"] : []), path];
    yield* host.execLines(argv, signal ? { signal } : undefined);
  };
}

/** `journalctl -o json` line → the wire's `RpcLogLine`. */
export function mapJournalLine(unit: string, raw: string): RpcLogLine | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const message = parsed["MESSAGE"];
  if (typeof message !== "string") return null;
  const usec = Number(parsed["__REALTIME_TIMESTAMP"]);
  const at = Number.isFinite(usec) && usec > 0 ? new Date(usec / 1000) : new Date();
  const priority = Number(parsed["PRIORITY"]);
  return {
    unit: String(parsed["_SYSTEMD_UNIT"] ?? unit),
    at: at.toISOString(),
    message,
    // journald priority: 0–3 is err and worse, which is what a reader wants
    // highlighted; everything else reads as ordinary stdout.
    stream: Number.isFinite(priority) && priority <= 3 ? "stderr" : "stdout",
  };
}

function defaultJournal(host: Host): JournalReader {
  return (unit, tail, follow, signal) => {
    const argv = ["journalctl", "-u", unit, "-o", "json", "-n", String(tail)];
    if (follow) argv.push("--follow");
    return host.execLines(argv, signal ? { signal } : undefined);
  };
}

/** Backoff while the tailnet address is still coming up, in milliseconds. */
export const TAILSCALE_BIND_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 15_000, 30_000] as const;
export const TAILSCALE_BIND_TIMEOUT_MS = 5 * 60_000;

/**
 * Wait for `tailscale ip -4`. There is deliberately no loopback fallback:
 * binding 127.0.0.1 would make the listener silently unreachable to operators
 * while looking healthy from the box, which is worse than not starting.
 */
export async function waitForTailscaleAddress(
  host: Host,
  log: (message: string) => void = () => {},
  timeoutMs = TAILSCALE_BIND_TIMEOUT_MS,
): Promise<string> {
  const deadline = host.now().getTime() + timeoutMs;
  for (let attempt = 0; ; attempt += 1) {
    const ip = await tailscaleIpv4(host);
    if (ip) return ip;
    if (host.now().getTime() >= deadline) {
      throw new AgentdError(
        "INTERNAL",
        `no tailscale address after ${Math.round(timeoutMs / 1000)}s; refusing to bind the RPC listener anywhere else`,
      );
    }
    const wait =
      TAILSCALE_BIND_BACKOFF_MS[Math.min(attempt, TAILSCALE_BIND_BACKOFF_MS.length - 1)] ?? 30_000;
    log(`waiting for a tailscale address before binding the RPC listener (retry in ${wait}ms)`);
    await host.sleep(wait);
  }
}

/**
 * Bind to the Tailscale address only. Nothing on this box listens on a
 * non-loopback, non-tailnet interface — that is what makes the
 * "bound to 0.0.0.0 by accident" bug impossible here (§7.2).
 */
export async function serveRpc(
  deps: RpcDeps,
  opts: { port?: number; hostname?: string; log?: (message: string) => void } = {},
): Promise<{ stop(): void; hostname: string; port: number }> {
  const handler = makeRpcHandler(deps);
  const hostname = opts.hostname ?? (await waitForTailscaleAddress(deps.host, opts.log));
  const port = opts.port ?? HERMETICD_RPC_PORT;

  const server = Bun.serve({
    hostname,
    port,
    /**
     * Seconds a connection may sit silent before Bun closes it. Zero disables
     * the timeout, which is the only correct setting here: `GET /logs?follow`
     * is a stream whose whole job is to stay open across a quiet journal, and
     * the default (~10 s) killed exactly that — the operator saw a socket error
     * from a healthy box that simply had nothing to say. Unlike the desktop
     * app's own streams there is no keepalive to hide behind:
     * hermeticd writes a frame when journald produces a line and not otherwise,
     * so silence is the normal state rather than slack.
     */
    idleTimeout: 0,
    fetch(request, srv) {
      const peer = srv.requestIP(request);
      return handler(request, peer?.address ?? "");
    },
  });

  return { stop: () => void server.stop(true), hostname, port };
}
