/**
 * The fixture's files plugin: turns in which the agent asks the operator for a
 * file or a secret (`request_file`, `request_secret`), raised by a substring in
 * the prompt, the way `fixture-chat-approval.ts` raises an approval.
 *
 * - `E2E_FILE_REQUEST` — a normal file (`request_file`).
 * - `E2E_SECRET_REQUEST` — a durable secret file (`request_file`, `sensitivity: secret`).
 * - `E2E_TEXT_SECRET` — one masked value (`request_secret`, `GITHUB_TOKEN`).
 * - `E2E_TEXT_SECRET_MULTI` — three keys, multi-line input.
 * - `E2E_FILE_REQUEST_TIMEOUT` — a file request whose wait runs out first: the
 *   tool returns `pending`, the turn ends, and the slot stays open so a late
 *   delivery still lands.
 *
 * The slot is opened on the fixture box's files service (`MemoryFiles`) for the
 * turn's own session, exactly as the real plugin opens one over hermeticd's
 * socket, so the card a head draws from `files.request.get` is the box's copy.
 * The fixture client never runs the live adapter, so the running block carries
 * the slot's `request_id` directly instead of having core look it up.
 *
 * The tool's result is the plugin's (`FileWaitResult`, hermeticd's `waitResult`):
 * never a value, nor a text secret's digest or size.
 */
import type {
  ChatBlock,
  ChatFrame,
  FileRequest,
  FileWaitResult,
  OpenFileRequestBody,
  OpenSecretRequestBody,
} from "../../schema/index.ts";
import { FILES_ROUTES, secretTextLoad } from "../../shared/files.ts";
import { HERMETICD_RPC_PORT } from "../../shared/rpc.ts";

export const FIXTURE_FILE_REQUEST_TRIGGER = "E2E_FILE_REQUEST";
export const FIXTURE_FILE_REQUEST_TIMEOUT_TRIGGER = "E2E_FILE_REQUEST_TIMEOUT";
export const FIXTURE_SECRET_REQUEST_TRIGGER = "E2E_SECRET_REQUEST";
export const FIXTURE_TEXT_SECRET_TRIGGER = "E2E_TEXT_SECRET";
export const FIXTURE_TEXT_SECRET_MULTI_TRIGGER = "E2E_TEXT_SECRET_MULTI";

/**
 * How long a request turn waits for the operator before its tool returns
 * `pending`: the plugin's own ceiling is minutes, and a fixture card has to
 * stay answerable long enough for a person to pick a file.
 */
export const FIXTURE_FILE_REQUEST_WAIT_MS = 5 * 60_000;
/** `E2E_FILE_REQUEST_TIMEOUT`'s wait: long enough to see the card, short enough to wait out. */
export const FIXTURE_FILE_REQUEST_PENDING_MS = 1500;

type SequencedFrame = Extract<ChatFrame, { seq: number }>;

/** The slice of `MemoryFiles` a request turn uses. */
export interface FixtureRequestFiles {
  openRequest(
    agent: string,
    body: OpenFileRequestBody | OpenSecretRequestBody,
    opts?: { session_id?: string; ttl_s?: number },
  ): FileRequest;
  waitFor(
    agent: string,
    id: string,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<FileRequest>;
}

export interface FixtureFileRequestScript {
  /** Whether the wait is the short one, ending the turn `pending`. */
  timeout: boolean;
  /** What the plugin sends hermeticd to open the slot. */
  body: OpenFileRequestBody | OpenSecretRequestBody;
  /** Reasoning, then the running tool card naming the slot. */
  ask(message: string, request_id: string): SequencedFrame[];
  /** The tool's result for the slot as the wait left it, a short reply, and done. */
  resume(message: string, slot: FileRequest, from: number, agent: string): SequencedFrame[];
  /** The slot could not be opened: the tool fails with the box's refusal. */
  refused(message: string, error: string): SequencedFrame[];
}

interface Spec {
  tool: "request_file" | "request_secret";
  timeout: boolean;
  thought: string;
  /** The model's arguments, as the tool card shows them. */
  args: Record<string, unknown>;
  body: OpenFileRequestBody | OpenSecretRequestBody;
}

const LOG_PURPOSE =
  "Raw nginx access log for 2026-10-12 01:30–02:30, to line the 502s up against the queue depth.";

function fileSpec(timeout: boolean): Spec {
  const args = {
    purpose: LOG_PURPOSE,
    accept: [".log", ".txt", ".gz"],
    name_hint: "access-2026-10-12.log",
  };
  return {
    tool: "request_file",
    timeout,
    thought: "The write-up only has the summary. I need the raw access log for the incident window.",
    args,
    body: { ...args },
  };
}

function specFor(prompt: string): Spec | null {
  if (prompt.includes(FIXTURE_FILE_REQUEST_TIMEOUT_TRIGGER)) return fileSpec(true);
  if (prompt.includes(FIXTURE_FILE_REQUEST_TRIGGER)) return fileSpec(false);
  if (prompt.includes(FIXTURE_SECRET_REQUEST_TRIGGER)) {
    const args = {
      purpose: "GitHub App private key, to mint installation tokens for the deploy bot.",
      accept: [".pem"],
      name_hint: "github-app.pem",
      max_bytes: 4096,
      sensitivity: "secret" as const,
      durable: true,
    };
    return {
      tool: "request_file",
      timeout: false,
      thought:
        "Minting installation tokens needs the GitHub App's private key. Ask for it as a secret.",
      args,
      body: { ...args },
    };
  }
  if (prompt.includes(FIXTURE_TEXT_SECRET_MULTI_TRIGGER)) {
    const args = {
      kind: "secret_text" as const,
      purpose: "Database credentials for the reporting replica.",
      keys: ["DB_USER", "DB_PASS", "DB_URL"],
      input: "multi" as const,
    };
    return {
      tool: "request_secret",
      timeout: false,
      thought: "The replica needs its own credentials. Ask for all three at once.",
      args,
      body: { ...args },
    };
  }
  if (prompt.includes(FIXTURE_TEXT_SECRET_TRIGGER)) {
    const args = {
      kind: "secret_text" as const,
      purpose: "A GitHub token with repo scope, to open the fix as a pull request.",
      keys: ["GITHUB_TOKEN"],
    };
    return {
      tool: "request_secret",
      timeout: false,
      thought: "Opening the pull request needs a GitHub token. Ask for one as a secret.",
      args,
      body: { ...args },
    };
  }
  return null;
}

/** hermeticd's `deliverWith`: ways to answer the slot without a card. */
function deliverWith(agent: string, slot: FileRequest): string[] {
  const id = slot.request_id;
  if (slot.kind === "secret_text")
    return [`hermetic files put ${agent} --request ${id} --secret-stdin`];
  return [
    `hermetic files put ${agent} --request ${id} <path>`,
    `curl -T <path> http://${agent}:${HERMETICD_RPC_PORT}${FILES_ROUTES.request(id)}`,
  ];
}

/**
 * The plugin's result for a slot as its wait left it (hermeticd's `waitResult`,
 * with the plugin's `pending` for a wait that ran out).
 */
export function fixtureWaitResult(agent: string, slot: FileRequest): FileWaitResult {
  const status: FileWaitResult["status"] =
    slot.state === "open" || slot.state === "receiving" ? "pending" : slot.state;
  const done = slot.fulfilled;
  const fulfilled =
    (status === "fulfilled" || status === "consumed") && done
      ? slot.kind === "secret_text"
        ? {
            path: done.path,
            by: done.by,
            class: done.class,
            keys: done.keys ?? [],
            format: done.format ?? "dotenv",
            load: secretTextLoad(done.path),
          }
        : { path: done.path, sha256: done.sha256, bytes: done.bytes, by: done.by, class: done.class }
      : {};
  return {
    status,
    request_id: slot.request_id,
    ...fulfilled,
    deliver_with: deliverWith(agent, slot),
    expires_at: slot.expires_at,
  };
}

function reply(result: FileWaitResult, spec: Spec): string {
  switch (result.status) {
    case "fulfilled":
    case "consumed":
      if (spec.tool === "request_secret")
        return `Stored ${(result.keys ?? []).join(", ")}. I'll load ${(result.keys ?? []).length > 1 ? "them" : "it"} with \`${result.load ?? ""}\` when I need ${(result.keys ?? []).length > 1 ? "them" : "it"}.`;
      return `Got it: ${result.path ?? "the file"} is on the box. Reading it now.`;
    case "declined":
      return "Understood — I won't use it. Tell me if you'd rather I work from the summary.";
    case "expired":
      return "The request expired before anything arrived. Ask me again when you have it.";
    default:
      return `Nothing has arrived yet. When you have it, run \`${result.deliver_with[0] ?? ""}\` and I'll pick it up.`;
  }
}

export function fixtureFileRequestScript(prompt: string): FixtureFileRequestScript | null {
  const spec = specFor(prompt);
  if (!spec) return null;
  const tool_id = `tl-fixture-${spec.tool}`;
  const render = spec.tool === "request_secret" ? "secret_request" : "file_request";
  const tool = (
    status: "running" | "ok" | "bad",
    request_id: string | null,
    result: unknown,
  ): ChatBlock => ({
    kind: "tool",
    tool_id,
    name: spec.tool,
    server: null,
    args: spec.args,
    result,
    status,
    exit_code: null,
    duration_ms: status === "running" ? null : 0,
    render,
    request_id,
  });
  const finish = (message: string, from: number, text: string): SequencedFrame[] => {
    let seq = from;
    const frames: SequencedFrame[] = [
      { type: "block", seq: ++seq, message, block: { kind: "text", markdown: "" } },
    ];
    const cut = Math.ceil(text.length / 2);
    for (const piece of [text.slice(0, cut), text.slice(cut)])
      frames.push({ type: "delta", seq: ++seq, message, text: piece });
    frames.push({ type: "done", seq: ++seq, message, usage: null, incomplete: null });
    return frames;
  };

  return {
    timeout: spec.timeout,
    body: spec.body,
    ask(message, request_id) {
      const blocks: ChatBlock[] = [
        { kind: "reasoning", text: spec.thought, duration_ms: 540, tokens: 24 },
        tool("running", request_id, null),
      ];
      return blocks.map((block, i) => ({ type: "block", seq: i + 1, message, block }));
    },
    resume(message, slot, from, agent) {
      const result = fixtureWaitResult(agent, slot);
      const head: SequencedFrame = {
        type: "block",
        seq: from + 1,
        message,
        block: tool("ok", slot.request_id, result),
      };
      return [head, ...finish(message, from + 1, reply(result, spec))];
    },
    refused(message, error) {
      const frames: SequencedFrame[] = [
        { type: "block", seq: 1, message, block: tool("running", null, null) },
        { type: "block", seq: 2, message, block: tool("bad", null, { error }) },
      ];
      return [...frames, ...finish(message, 2, `I couldn't ask for it: ${error}`)];
    },
  };
}
