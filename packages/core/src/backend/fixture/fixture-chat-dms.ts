/**
 * The fixture's bot-to-bot DMs: `atlas`'s Marshall (`scribe`) and NickQABot
 * (`auditor`) messaging each other with `message_agent` (Hermes v2026.9.24,
 * `tools/bot_mode_dm.py`), seen from both ends.
 *
 * Each DM is three things on a real box, and all three are here: the sender's
 * `message_agent` call with its `queued` acknowledgement; the delivery row in
 * the target's Bot Chat, signed `Message from 🤖 <name> (@<handle>): …`, and
 * the target's reply after it; and the completion notice that carries the
 * reply back into the sender's transcript. The delivery rows are run through
 * the same `stripBotDelivery` the history reader uses, and the notices through
 * `parseProcessNotice`, so the fixture shows what a box produces rather than
 * what somebody believed the mapping returns.
 *
 * Two DMs: NickQABot → Marshall at 07:40, and Marshall → NickQABot at 08:02,
 * the screenshot pair the thread's "Messaged" marker and exchange view were
 * designed against. A third, Marshall → Remy on another machine at 08:06, is
 * refused because that machine is offline: the failed marker and its Retry. Split out of `fixture-chat-catalog.ts` (AGENTS.md rule 5).
 */
import { stripBotDelivery } from "../../chat/hermes/bot-delivery.ts";
import { parseProcessNotice } from "../../chat/hermes/process-notice.ts";
import { HermeticError } from "../../errors.ts";
import type { ChatBlock, ChatMessage } from "../../schema/index.ts";
import { at } from "./fixture-chat-roster.ts";

/** Marshall's canonical Bot Chat. `fixture-chat-roster.ts` lists it. */
export const SCRIBE_BOT_CHAT_SESSION = "sx-atlas-scribe-bot-chat";

/** NickQABot's canonical Bot Chat, whose older rows live in the catalogue. */
const AUDITOR_SESSION = "sx-atlas-auditor-portal";

const SCRIBE = { instance: "atlas", bot: "scribe" } as const;
const AUDITOR = { instance: "atlas", bot: "auditor" } as const;

/** The two delivery processes, by Hermes' process id. */
const PROC = {
  toScribe: "proc_5d1e2a7c90b4",
  toAuditor: "proc_a41c7e93d2f8",
} as const;

const text = (markdown: string): ChatBlock => ({ kind: "text", markdown });
/** Paragraphs and list items, one per argument: a lone `\n` is a hard break in chat markdown. */
const lines = (...rows: string[]): string => rows.join("\n");

/* ── what was said ────────────────────────────────────────────────────────── */

const ASK_SCRIBE =
  "From now on, put the Bedrock grant numbers in the morning digest: which models the grant " +
  "covers and which ones a profile asked for that it does not. The 08:14 audit failed on " +
  "exactly that and nobody saw it coming.";

const SCRIBE_REPLY =
  "Will do. From tomorrow's 06:00 digest there is a Bedrock grant section: the granted " +
  "models, and any profile asking for one outside the grant, flagged.";

const ASK_AUDITOR = lines(
  "Evan has asked for another targeted re-QA of #4124 at the new tip e4cf2ec. All 42 CI " +
    "checks are green, and the PR is not a draft.",
  "",
  "One change since your clean run at 7dcfa81: Nick's commit e4cf2ec, 'fix(bounties): never " +
    "pay a click on a secret bounty'. `completeBountyClick` now refuses a bounty with every " +
    "channel turned off before it checks eligibility or pays out.",
  "",
  "Please verify:",
  "",
  "1. Clicking a secret bounty by its id pays nothing and is refused cleanly.",
  "2. The daily cap still holds at 10 per day.",
  "3. Nick's three first-touch cases still hold.",
  "",
  "Report back to Marshall with the verdict and findings. No merge, Slack or GitHub posts.",
);

const AUDITOR_REPLY = lines(
  "Re-QA of #4124 at e4cf2ec: **pass**.",
  "",
  "- A secret bounty clicked by id pays nothing and returns a clean refusal; no ledger row, " +
    "no crash. A normal visible click bounty still pays.",
  "- The daily cap holds: first-touch and likes stop at 10 per day.",
  "- Nick's three first-touch cases hold.",
  "",
  "As you asked, nothing was posted on GitHub or Slack and nothing was merged.",
);

/* ── the three shapes ─────────────────────────────────────────────────────── */

/** Upstream's `message_agent` call, answered with its `queued` acknowledgement. */
function messageAgent(
  id: string,
  target: string,
  handle: string,
  message: string,
  proc: string,
  queued: number,
): ChatBlock {
  return {
    kind: "tool",
    tool_id: id,
    name: "message_agent",
    server: null,
    args: { target, message },
    result: {
      status: "queued",
      delivery_id: `dm-${proc.slice(5, 13)}`,
      to: `@${handle}`,
      reply_delivery: "notification",
      detail: `Message queued for @${handle}: this acknowledges the hand-off to a background delivery process, not a delivery receipt — do NOT wait or poll.`,
      process_id: proc,
      queued_at: queued,
    },
    status: "ok",
    exit_code: null,
    duration_ms: 212,
    render: "message_agent",
  };
}

/**
 * A `message_agent` call upstream refused before anything was sent: `_err`'s
 * `{error, reason}` with no status. This one is the relay's refusal for a
 * machine that is offline (`tools/bot_mode_dm.py:314`, its sentence from
 * `tools/bot_relay.py:296-299`) — a retryable reason, so the thread offers
 * Retry, and a target on another machine, so it names no bot here.
 */
function refusedMessageAgent(
  id: string,
  target: string,
  message: string,
  error: string,
  reason: string,
): ChatBlock {
  return {
    kind: "tool",
    tool_id: id,
    name: "message_agent",
    server: null,
    args: { target, message },
    result: { error, reason },
    status: "bad",
    exit_code: null,
    duration_ms: 38,
    render: "message_agent",
  };
}

/** A delivery row in the target's Bot Chat, mapped from the raw signed text. */
function delivery(
  id: string,
  session: string,
  time: string,
  from: string,
  handle: string,
  body: string,
): ChatMessage {
  const raw = [text(`Message from 🤖 ${from} (@${handle}): ${body}`)];
  const stripped = stripBotDelivery(raw);
  if (!stripped) throw new HermeticError("CHAT_PROTOCOL", `fixture delivery no longer parses: ${from}`);
  return {
    id,
    session,
    role: "user",
    author: null,
    at: at(time),
    blocks: stripped.blocks,
    usage: null,
    error: null,
    incomplete: null,
    from_bot: stripped.from,
  };
}

/** The completion notice the delivery process injects into the sender's session. */
function replyNotice(
  id: string,
  session: string,
  time: string,
  proc: string,
  profile: string,
  reply: string,
): ChatMessage {
  const command =
    "/usr/local/lib/hermes-agent/venv/bin/python /usr/local/lib/hermes-agent/tools/bot_mode_dm.py " +
    `--run-delivery query-file /tmp/hermes-dm-999/dm-${proc.slice(5, 13)}.txt ` +
    `--profile-home /data/hermes/.hermes/profiles/${profile} hermes -p ${profile} chat --in '~' ` +
    "-c 'Bot Chat' --create-if-missing -Q";
  const notice = `[IMPORTANT: Background process ${proc} completed normally (exit code 0).\nCommand: ${command}\nOutput:\n${reply}]`;
  const block = parseProcessNotice(notice);
  if (!block?.dm)
    throw new HermeticError("CHAT_PROTOCOL", `fixture DM notice no longer parses: ${proc}`);
  return {
    id,
    session,
    role: "system",
    author: null,
    at: at(time),
    blocks: [block],
    usage: null,
    error: null,
    incomplete: null,
  };
}

const operator = (id: string, session: string, time: string, words: string): ChatMessage => ({
  id,
  session,
  role: "user",
  author: null,
  at: at(time),
  blocks: [text(words)],
  usage: null,
  error: null,
  incomplete: null,
});

const said = (
  id: string,
  session: string,
  author: { instance: string; bot: string },
  time: string,
  blocks: ChatBlock[],
): ChatMessage => ({
  id,
  session,
  role: "bot",
  author,
  at: at(time),
  blocks,
  usage: null,
  error: null,
  incomplete: null,
});

/* ── the transcripts ──────────────────────────────────────────────────────── */

/**
 * Marshall's Bot Chat: NickQABot's DM arriving and Marshall's answer to it,
 * then the operator's re-QA request, the DM Marshall sends for it, and the
 * reply coming back as a completion notice.
 */
export const SCRIBE_BOT_CHAT_TRANSCRIPT: readonly ChatMessage[] = [
  delivery(
    "mx-atlas-scribe-1",
    SCRIBE_BOT_CHAT_SESSION,
    "07:40:15",
    "NickQABot",
    "auditor",
    ASK_SCRIBE,
  ),
  said("mx-atlas-scribe-2", SCRIBE_BOT_CHAT_SESSION, SCRIBE, "07:40:31", [text(SCRIBE_REPLY)]),
  operator(
    "mx-atlas-scribe-3",
    SCRIBE_BOT_CHAT_SESSION,
    "08:02:00",
    "Get NickQABot to re-QA #4124 on Nick's latest commit. No merging, no GitHub posts.",
  ),
  said("mx-atlas-scribe-4", SCRIBE_BOT_CHAT_SESSION, SCRIBE, "08:02:08", [
    text("I'll check CI on the latest #4124 commit, then start the re-QA if it's green."),
    {
      kind: "tool",
      tool_id: "call-scribe-ci",
      name: "terminal",
      server: null,
      args: { command: "gh pr checks 4124 --json state --jq 'map(.state) | unique'" },
      result: '["SUCCESS"]',
      status: "ok",
      exit_code: 0,
      duration_ms: 1840,
      render: "terminal",
    },
  ]),
  said("mx-atlas-scribe-5", SCRIBE_BOT_CHAT_SESSION, SCRIBE, "08:02:20", [
    messageAgent("call-scribe-dm", "@nickqabot", "auditor", ASK_AUDITOR, PROC.toAuditor, 1_789_632_140),
  ]),
  said("mx-atlas-scribe-6", SCRIBE_BOT_CHAT_SESSION, SCRIBE, "08:02:24", [
    text(
      "I've started the #4124 re-QA. CI is green on Nick's latest commit `e4cf2ec`, and nothing " +
        "has been pushed since Friday afternoon. I'll send you the review card when it's done.",
    ),
  ]),
  replyNotice(
    "mx-atlas-scribe-7",
    SCRIBE_BOT_CHAT_SESSION,
    "08:05:42",
    PROC.toAuditor,
    "auditor",
    AUDITOR_REPLY,
  ),
  said("mx-atlas-scribe-8", SCRIBE_BOT_CHAT_SESSION, SCRIBE, "08:06:00", [
    refusedMessageAgent(
      "call-scribe-relay",
      "remy@laptop",
      "#4124 passed re-QA at e4cf2ec. The release notes can go out once it merges.",
      "@remy on Evan's MacBook is offline right now — the message was NOT queued. Try again once that machine reconnects to the Desktop.",
      "runtime_offline",
    ),
    text(
      "NickQABot passed #4124 at `e4cf2ec`: the secret-bounty fix holds, and so do the cap and Nick's cases. " +
        "I tried to tell Remy for the release notes, but Evan's MacBook is offline, so that message wasn't sent.",
    ),
  ]),
];

/**
 * The head of NickQABot's Bot Chat, before the grant audit the catalogue
 * already has: the DM it sends Marshall, Marshall's reply coming back, then
 * Marshall's re-QA request arriving and NickQABot's answer to it.
 */
export const AUDITOR_DM_ROWS: readonly ChatMessage[] = [
  operator(
    "mx-atlas-auditor-dm-1",
    AUDITOR_SESSION,
    "07:40:00",
    "Tell Marshall the digest needs the Bedrock grant numbers from now on.",
  ),
  said("mx-atlas-auditor-dm-2", AUDITOR_SESSION, AUDITOR, "07:40:09", [
    messageAgent("call-auditor-dm", "Marshall", "scribe", ASK_SCRIBE, PROC.toScribe, 1_789_630_809),
    text("Asked Marshall to add the grant numbers to the digest. I'll pass on the reply."),
  ]),
  replyNotice(
    "mx-atlas-auditor-dm-3",
    AUDITOR_SESSION,
    "07:40:33",
    PROC.toScribe,
    "scribe",
    SCRIBE_REPLY,
  ),
  said("mx-atlas-auditor-dm-4", AUDITOR_SESSION, AUDITOR, "07:40:50", [
    text("Marshall confirmed: the Bedrock grant section starts with tomorrow's 06:00 digest."),
  ]),
  delivery("mx-atlas-auditor-dm-5", AUDITOR_SESSION, "08:02:30", "Marshall", "scribe", ASK_AUDITOR),
  said("mx-atlas-auditor-dm-6", AUDITOR_SESSION, AUDITOR, "08:05:40", [text(AUDITOR_REPLY)]),
];
