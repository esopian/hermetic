import { z } from "zod";
export {
  HERMETICD_RPC_PORT,
  RPC_PROTOCOL_VERSION,
  RPC_VERSION_HEADER,
  RPC_CONTENT_TYPE,
  RPC_PATHS,
} from "../shared/rpc.ts";
import { Iso } from "./common.ts";
import { ErrorCode } from "./errors.ts";

/**
 * The hermeticd RPC wire format (§6.4). `packages/agentd` implements the server
 * side against these schemas; `packages/core/src/aws/rpc.ts` is the client. It is
 * plain HTTP on the Tailscale interface — the tailnet ACL, checked by
 * `tailscale whois` on the peer address, is the authorization layer.
 *
 * Transport: `GET /logs?unit=&file=&follow=` returns `application/x-ndjson` —
 * one `RpcFrame` per line, flushed as it happens.
 */

/**
 * One of Hermes's own rotating log files under `$HERMES_HOME/logs`, which is
 * where the thing an operator is usually looking for actually is.
 *
 * Upstream attaches no stderr handler unless it is run with `-v`, so journald
 * carries the startup banner and uvicorn's request noise and nothing else: when
 * an agent fails a turn the journal shows nothing while `errors.log` shows all
 * of it. `agent.log` is INFO and above, `errors.log` is WARNING and above,
 * `gateway.log` is the gateway process — all three written through upstream's
 * redacting formatter, and all three on the data volume, so they survive a
 * recreate.
 */
export const HermesLogFile = z.enum(["agent", "errors", "gateway"]);
export type HermesLogFile = z.infer<typeof HermesLogFile>;

/**
 * Query of `GET /logs`. `follow` keeps the response body open.
 *
 * `unit` and `file` are two different sources — journald and a file on the data
 * volume — so asking for both is a request hermeticd cannot answer, and saying
 * so is better than silently picking one.
 */
export const LogsRequest = z
  .object({
    unit: z.string().min(1).nullish(),
    /** A Hermes log file instead of a journal unit; see `HermesLogFile`. */
    file: HermesLogFile.nullish(),
    follow: z.boolean().default(false),
    /** Journal lines, or file lines, to replay before following. */
    tail: z.number().int().min(0).max(10_000).default(200),
  })
  .refine((q) => !(q.unit && q.file), {
    message: "unit and file name different sources; pass one or the other",
    path: ["file"],
  });
export type LogsRequest = z.infer<typeof LogsRequest>;

export const RpcLogLine = z.object({
  unit: z.string(),
  at: Iso,
  message: z.string(),
  stream: z.enum(["stdout", "stderr"]).nullish(),
});
export type RpcLogLine = z.infer<typeof RpcLogLine>;

/** One NDJSON line. Every stream ends with exactly one `done` or one `error`. */
export const RpcFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("log"), line: RpcLogLine }),
  z.object({ type: z.literal("error"), code: ErrorCode, message: z.string() }),
  z.object({ type: z.literal("done"), ok: z.boolean() }),
]);
export type RpcFrame = z.infer<typeof RpcFrame>;

/**
 * What the box says about one of its browser identities (§7.3): whether
 * `hermetic-browser@<name>.service` is up, and whether the Chrome behind it
 * answers CDP on loopback.
 *
 * Two questions and not one, because they fail apart: an active unit whose
 * `/json/version` is silent is a Chrome that started and died into its restart
 * loop, and that reads very differently from a unit nobody enabled.
 *
 * Lives here, with the wire format, rather than in `probe.ts`: `requests.ts`
 * already imports this module, and `probe.ts` imports `requests.ts`, so the
 * dependency can only run this way round. `ProbeBrowserIdentity` is this schema
 * under the name the report uses.
 */
export const RpcBrowserHealth = z.object({
  name: z.string(),
  /** `systemctl is-active hermetic-browser@<name>` came back `active`. */
  unit_active: z.boolean(),
  /** `GET http://127.0.0.1:<cdp port>/json/version` answered. */
  cdp_ok: z.boolean(),
  /** What that answer called itself (`Chrome/153.0.8010.12`), or null. */
  cdp_version: z.string().nullable(),
  /** A human sentence, so a `false` above never arrives without its reason. */
  detail: z.string(),
});
export type RpcBrowserHealth = z.infer<typeof RpcBrowserHealth>;

/** `GET /healthz` — what the heartbeat writer reports, over the wire. */
export const RpcHealth = z.object({
  name: z.string(),
  hermeticd_version: z.string(),
  protocol: z.number().int(),
  config_hash: z.string().nullish(),
  /**
   * One entry per browser identity the agent's config lists.
   *
   * Optional, and the distinction matters to the probe: absent is "the box
   * could not say" — an older hermeticd, or a manifest it cannot read, and the
   * operator owes an `artifacts push` — while an empty array is the box's
   * positive statement that the configuration it applied lists no browsers,
   * which on a `browser: true` agent is a failure with an `agent rerun` owing.
   */
  browsers: z.array(RpcBrowserHealth).optional(),
});
export type RpcHealth = z.infer<typeof RpcHealth>;

/** Serialise one frame as an NDJSON line (server side). */
export function encodeRpcFrame(frame: RpcFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

/** Parse one NDJSON line. Throws `ZodError` on a frame this build cannot read. */
export function decodeRpcFrame(line: string): RpcFrame {
  return RpcFrame.parse(JSON.parse(line));
}
