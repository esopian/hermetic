/**
 * The fixture's approval turns: a command the agent wants to run, parked on an
 * `approval` card until `chat.respond kind:"approval"` settles it.
 *
 * Triggers, by substring of the prompt:
 *
 * - `E2E_APPROVAL` — the gateway's default fill: once / session / always / deny.
 * - `E2E_APPROVAL_SMART` — `smart_denied`: once / deny.
 * - `E2E_APPROVAL_NOSESSION` — `allow_session: false`: once / deny.
 * - `E2E_APPROVAL_TIMEOUT` — the default fill, and nobody answers: the request
 *   closes with reason `timeout`.
 *
 * The card is built by `hermesRequest`, the mapping the Hermes adapter uses, from
 * a payload shaped like the gateway's (`_approval_request_payload`, whose
 * `choices` come from `approvalChoices`), so the fill rule exists once. The
 * gateway never checks an answer against the offered list (`approval.respond`,
 * `methods_prompt.py:1239-1253`): anything but `deny` is a grant, so the fixture
 * accepts whatever `respond` sends and the UI's gating is the only guard.
 */
import {
  approvalChoices,
  hermesActivity,
  hermesRequest,
} from "../../chat/hermes/hermes-chat-activity.ts";
import type { ApprovalChoice, ChatBlock, ChatFrame } from "../../schema/index.ts";
import type { FixtureApprovalOutcome } from "./fixture-chat-requests.ts";

export const FIXTURE_APPROVAL_TRIGGER = "E2E_APPROVAL";
export const FIXTURE_APPROVAL_SMART_TRIGGER = "E2E_APPROVAL_SMART";
export const FIXTURE_APPROVAL_NOSESSION_TRIGGER = "E2E_APPROVAL_NOSESSION";
export const FIXTURE_APPROVAL_TIMEOUT_TRIGGER = "E2E_APPROVAL_TIMEOUT";

type SequencedFrame = Extract<ChatFrame, { seq: number }>;

const COMMAND = "rm -rf /var/cache/fixture-build";
const PATTERN = "recursive delete";

export interface FixtureApprovalScript {
  /** The request gives up on its own (`reason: "timeout"`) if nobody answers. */
  timeout: boolean;
  /** Reasoning, the running tool and the approval card, seq from 1. */
  ask(message: string, request_id: string): SequencedFrame[];
  /** The close notice (on a timeout), the tool completing, the reply and `done`. */
  resume(
    message: string,
    outcome: FixtureApprovalOutcome,
    from: number,
    request_id: string,
  ): SequencedFrame[];
}

/** The approval script a prompt triggers, or null. The longer triggers are tested first. */
export function fixtureApprovalScript(prompt: string): FixtureApprovalScript | null {
  const smart = prompt.includes(FIXTURE_APPROVAL_SMART_TRIGGER);
  const noSession = prompt.includes(FIXTURE_APPROVAL_NOSESSION_TRIGGER);
  const timeout = prompt.includes(FIXTURE_APPROVAL_TIMEOUT_TRIGGER);
  if (!smart && !noSession && !timeout && !prompt.includes(FIXTURE_APPROVAL_TRIGGER)) return null;

  const tool_id = "tl-fixture-approval";
  const args = { command: COMMAND };
  const tool = (
    status: "running" | "ok" | "bad",
    result: string | null,
    exit_code: number | null,
  ): ChatBlock => ({
    kind: "tool",
    tool_id,
    name: "terminal",
    server: null,
    args,
    result,
    status,
    exit_code,
    duration_ms: status === "running" ? null : 0,
    render: "terminal",
  });
  /** What the gateway receives before it fills `choices` in. */
  const request = {
    command: COMMAND,
    description: PATTERN,
    tool_name: "terminal",
    ...(smart ? { smart_denied: true } : {}),
    ...(noSession ? { allow_session: false } : {}),
  };

  /** What the command did, given how the operator answered. */
  const settle = (choice: ApprovalChoice | null): { reply: string; ran: boolean } => {
    if (choice === null)
      return { reply: `Approval timed out: did not run \`${COMMAND}\`.`, ran: false };
    if (choice === "deny") return { reply: `Denied: did not run \`${COMMAND}\`.`, ran: false };
    // Under `smart_denied` the gateway treats a session or always answer as a
    // one-shot approval and persists nothing (`approval.py:828`).
    const effective = smart ? "once" : choice;
    const head =
      effective === "session"
        ? "Allowed this session"
        : effective === "always"
          ? "Always allowed"
          : "Approved once";
    return { reply: `${head}: ran \`${COMMAND}\`.`, ran: true };
  };

  return {
    timeout,
    ask(message, request_id) {
      // The gateway fills `choices` before it sends (`_approval_request_payload`).
      const payload = { ...request, choices: approvalChoices(request) };
      const blocks: ChatBlock[] = [
        {
          kind: "reasoning",
          text: "Clearing the stale build cache needs a recursive delete. Ask before running it.",
          duration_ms: 620,
          tokens: 22,
        },
        tool("running", null, null),
        ...hermesRequest("approval", request_id, payload),
      ];
      return blocks.map((block, i) => ({ type: "block", seq: i + 1, message, block }));
    },
    resume(message, outcome, from, request_id) {
      let seq = from;
      const settled = settle(
        outcome.kind === "choice" ? outcome.choice : outcome.kind === "timeout" ? null : "deny",
      );
      const frames: SequencedFrame[] = [];
      // The gateway withdraws a request that ran out of time (`request.cancel`),
      // a notice in the live stream and nothing in the stored turn.
      const closed =
        outcome.kind === "timeout"
          ? hermesActivity("request.cancel", { id: request_id, method: "approval", reason: "timeout" })
          : null;
      if (closed) frames.push({ type: "block", seq: ++seq, message, block: closed });
      frames.push(
        {
          type: "block",
          seq: ++seq,
          message,
          block: settled.ran
            ? tool("ok", "removed /var/cache/fixture-build", 0)
            : tool("bad", "BLOCKED: the command was not approved", 1),
        },
        { type: "block", seq: ++seq, message, block: { kind: "text", markdown: "" } },
      );
      const cut = Math.ceil(settled.reply.length / 2);
      for (const text of [settled.reply.slice(0, cut), settled.reply.slice(cut)])
        frames.push({ type: "delta", seq: ++seq, message, text });
      frames.push({ type: "done", seq: ++seq, message, usage: null, incomplete: null });
      return frames;
    },
  };
}
