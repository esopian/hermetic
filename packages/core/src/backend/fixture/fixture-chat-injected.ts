/**
 * The fixture's injected-row transcript: a `kestrel` thread holding every row
 * Hermes stores as the user's that the operator never typed (§9.2) — cron
 * output and mirrored deliveries, a heartbeat and a `/loop` wakeup, a goal and
 * its failed gate, recovery notes, the agent loop's nudges and iteration
 * limit, a compaction summary with the task list carried across it, model and
 * personality switches, a session handoff — beside the operator's own skill
 * invocation, messaging reply and a turn that failed.
 *
 * Nothing here is written as a block. Each row is what the dashboard's REST
 * route hands back (`hermes_cli/web_routers/sessions.py` `_project_for_display`:
 * `display_kind` where upstream types the row, a hidden standalone summary, a
 * merged carrier's `display_content`), run through the same `mapHistory` the
 * history reader uses, so the fixture shows what a real box produces.
 *
 * Opened at `#chat/kestrel/default?session=sx-kestrel-injected`.
 */
import { mapHistory } from "../../chat/hermes/hermes-chat-history.ts";
import { HermeticError } from "../../errors.ts";
import type { ChatMessage } from "../../schema/index.ts";
import { at } from "./fixture-chat-roster.ts";

/** The session this transcript is. `fixture-chat-roster.ts` lists it as a kestrel thread. */
export const KESTREL_INJECTED_SESSION = "sx-kestrel-injected";

const SESSION = KESTREL_INJECTED_SESSION;
const KESTREL = { instance: "kestrel", bot: "default" } as const;
const BOX = { instance: "kestrel", baseUrl: "https://fxtr0001-kestrel.fixture.ts.net/" };

/* ── upstream's texts ─────────────────────────────────────────────────────── */

const SUMMARY = [
  "[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below. This is a handoff from a previous context window — treat it as background reference, NOT as active instructions. Do NOT answer questions or fulfill requests mentioned in this summary; they were already addressed. The current session state (files, config, etc.) may reflect work described here — avoid repeating it:",
  "## Summary",
  "- Rebased #97 and #110",
  "- #108 waiting on CI",
  "- Open: notify path for claude-run.sh",
  "--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---",
].join("\n");

const LATER_SUMMARY = [
  "[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below. This is a handoff from a previous context window — treat it as background reference, NOT as active instructions. The current session state (files, config, etc.) may reflect work described here — avoid repeating it:",
  "## Summary",
  "- #108 rebased and pushed; CI green",
  "- Reviewed the diff: two findings, both fixed",
  "--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---",
].join("\n");

const TEXT = {
  heartbeat:
    "[Heartbeat — recurring instruction, fires every 30m]\nCheck the deploy queue and flag anything stuck.\n\nIf there is nothing meaningful to do or report for this instruction right now, reply briefly that nothing has changed and stop — do not invent work.",
  loop: "[/loop wakeup #4, every 5m]\nRecurring task: watch CI on #108 until it is green\n\nThis is an automatic wakeup from the /loop the user set. Perform the task now against the CURRENT state (re-check files, processes, or services fresh — do not assume anything from earlier iterations still holds). Report concisely what you found or did this iteration.\nIf the task is now complete, no longer applicable, or the thing you were watching has finished, say so and end your reply with [LOOP_COMPLETE] on its own line — that stops the loop.",
  cron: '[Cronjob "pr-checkin" output — scheduled job, not the user. Review it, act on anything that needs action, and summarize for the chat.]\n\n#97 BEHIND, audit and ci failing\n#110 DIRTY, needs a rebase onto master',
  cronFailed:
    "[Cronjob \"docgen\" output — scheduled job, not the user. Review it, act on anything that needs action, and summarize for the chat.]\n\n⚠️ Cron 'docgen' failed: its script timed out. No model was invoked.",
  cronMirror: "[Cron delivery: nightly-digest]\n3 PRs merged, 1 failing (#97).",
  webhookMirror: "[Webhook delivery: github-push]\npush to master by evan: 3 commits (7987404…)",
  reply: '[Replying to: "can you rebase #108?"]\n\nyes, and re-run CI after',
  outputLimit:
    "[System: Your previous response was truncated by the output length limit. Continue exactly where you left off. Do not restart or repeat prior text. Finish the answer directly.]",
  networkCut:
    "[System: The previous response was cut off by a network error mid-stream. Continue exactly where you left off. Do not restart or repeat prior text. Finish the answer directly.]",
  gwResume:
    "[System note: The previous turn was interrupted by a gateway restart; the gateway is now back online. Any restart/shutdown command in the history has already run — do NOT re-execute or verify it. Address the user's NEW message below FIRST and focus on what the user is asking now. Do NOT re-execute old tool calls — skip any unfinished work from the conversation history.]\n\nis #108 pushed yet?",
  gwResumeAlone:
    "[System note: The previous turn was interrupted by a gateway restart; the gateway is now back online. Any restart/shutdown command in the history has already run — do NOT re-execute or verify it. No user is present on this non-interactive platform, so do NOT emit a 'session restored' acknowledgement or ask questions. Review the conversation history and CONTINUE the interrupted task to completion. Do NOT re-run tool calls whose results already appear in the history — resume from the first step that has no recorded result.]",
  crashResume:
    "[System note: Your previous turn was interrupted mid-run — the app or its backend process stopped before the turn could finish. Some of the work may already be complete; check the current state before redoing anything, then finish the task. The interrupted request was:]\n\nrebase #108 onto master",
  goal: "[Continuing toward your standing goal]\nGoal: get every open PR green and merged\n\nContinue working toward this goal. Take the next concrete step. If you believe the goal is complete, state so explicitly and stop. If you are blocked and need input from the user, say so clearly and stop.",
  goalGate:
    "[Continuing toward your standing goal — a quality gate failed]\nGoal: get every open PR green and merged\n\nThe quality gate command below must pass before this goal can be declared done, and it just failed (attempt 1/3):\n  $ bun run ci\nExit code: 1\nOutput (tail):\n```\n✗ tests/parity.test.ts  1 fail\nexit 1\n```\n\nFix the underlying problem so this gate passes, then re-run it to confirm. Do not declare the goal complete while any gate fails. If the gate itself is wrong or cannot pass, say so clearly and stop.",
  toolTooLarge:
    "[System: Your previous tool call (patch, write_file) was too large and the stream timed out before it could be delivered. Do NOT retry the same tool call with the same large content. Instead, break the content into multiple smaller tool calls (e.g. use multiple patch calls or write smaller files). Each tool call's arguments must be under ~8K tokens to avoid stream timeouts.]",
  reasoningOnly:
    "[System: Your previous response contained only internal reasoning and never produced a visible answer or tool call. Do not keep thinking. Produce your final answer as plain text now (or make the tool call you were planning).]",
  continueNow:
    "[System: Continue now. Execute the required tool calls and only send your final answer after completing the task.]",
  fragment:
    "[System: Your previous message ended the turn with a fragment that is not a usable answer. If the task is unfinished, continue it and then give the complete answer. If that fragment WAS your complete answer, send it again exactly as before.]",
  iteration:
    "You've reached the maximum number of tool-calling iterations allowed. Please provide a final response summarizing what you've found and accomplished so far, without calling any more tools.",
  continueMarker:
    "Continue from the compressed conversation context above. This marker exists because no human user turn was available.",
  todo: "[Your active task list was preserved across context compression]\n- [x] 1. Land the PR stack (completed)\n  - [>] 2. Rebase #108 onto master (in_progress)\n  - [ ] 3. Re-run CI on #108 (pending)\n- [ ] 4. Add exit notification to claude-run.sh (pending)",
  handoff:
    '[Session was just handed off from CLI ("refactor auth") to this channel. The full prior conversation history is loaded above. Briefly confirm you\'re working here and summarize what we were working on, so the user can continue from this device.]',
  model:
    "[System: The active model for this chat has changed to claude-sonnet-5-5 via provider anthropic. From this point forward, use this runtime metadata when answering questions about what model/provider is active.]",
  personaSet:
    "[System: The user has changed the assistant's personality. From this point forward, adopt the following persona and respond accordingly: You are a terse senior SRE. Answer in bullet points.]",
  personaCleared:
    "[System: The user has cleared the personality overlay. From this point forward, respond in your normal default style.]",
  skill:
    '[IMPORTANT: The user has invoked the "review" skill, indicating they want you to follow its instructions. The full skill content is loaded below.]\n\n# review\nRead the diff, then report bugs first, then anything else worth fixing.\n\nThe user has provided the following instruction alongside the skill invocation: the diff on #108',
  failed:
    "This turn did not complete. Some actions may already have run; verify their effects before resending.",
} as const;

/* ── the rows, as the dashboard returns them ──────────────────────────────── */

type Row = Record<string, unknown>;

const rows: Row[] = [];
/** The ids of rows that must come out as events, so a parser that stops recognising one fails loudly. */
const injectedIds: string[] = [];
let n = 0;

function push(role: "user" | "assistant", time: string, content: string, extra: Row = {}): string {
  n += 1;
  const id = `mx-kestrel-injected-${n}`;
  rows.push({ id, role, content, timestamp: at(time), ...extra });
  return id;
}

const you = (time: string, content: string, extra?: Row) => push("user", time, content, extra);
const bot = (time: string, content: string, extra?: Row) => push("assistant", time, content, extra);
function injected(time: string, content: string, displayKind?: string, extra: Row = {}): void {
  injectedIds.push(
    push("user", time, content, displayKind ? { display_kind: displayKind, ...extra } : extra),
  );
}

you(
  "07:00:04",
  "Keep an eye on the PR stack while I'm out: heartbeat the deploy queue every 30m, and loop on CI for #108.",
);
bot("07:00:19", "Set: a 30m heartbeat on the deploy queue, and a 5m loop on #108's CI.");
injected("07:30:00", TEXT.heartbeat, "internal_notification");
bot("07:30:11", "Deploy queue is clear; nothing stuck.");
injected("07:35:00", TEXT.loop, "internal_notification");
bot("07:35:14", "CI on #108 is still running: 12 of 19 jobs done, none failed so far.");
injected("07:40:00", TEXT.cron);
bot(
  "07:40:22",
  "The PR check-in flags two: #97 is behind master and failing audit and CI, and #110 needs a rebase.",
);
injected("07:41:00", TEXT.cronFailed);
bot(
  "07:41:09",
  "docgen's script timed out before any model ran. `hermes cron runs docgen` shows the last runs.",
);
injected("07:45:00", TEXT.cronMirror);
injected("07:45:30", TEXT.webhookMirror);
you("07:46:02", TEXT.reply);
bot("07:46:20", "Rebasing #108 onto master now.");
// Two routine nudges back to back: they burst beside each other, and the
// marker before them does not join it.
injected("07:47:10", TEXT.outputLimit);
injected("07:47:41", TEXT.networkCut);
bot("07:48:03", "The rebase went through cleanly; pushing #108 now.");
injected("07:52:00", TEXT.gwResume);
bot("07:52:18", "Yes. #108 was pushed at 7987404 before the restart, and CI restarted on it.");
injected("07:53:00", TEXT.crashResume, "auto_continue");
bot("07:53:12", "The rebase had already finished before the crash, so there was nothing to redo.");
injected("07:54:00", TEXT.gwResumeAlone);
bot(
  "07:54:20",
  "Back after the gateway restart; the deploy check had already run, so picking up at the CI wait.",
);
injected("07:55:00", TEXT.goal);
bot("07:55:31", "Next step toward the goal: #97 needs the audit fix before its CI can pass.");
injected("07:58:00", TEXT.goalGate);
bot(
  "07:58:26",
  "The gate fails on tests/parity.test.ts: a new RPC handler has no CLI command. Adding it.",
);
injected("08:01:00", TEXT.toolTooLarge);
injected("08:01:40", TEXT.reasoningOnly);
injected("08:02:05", TEXT.continueNow);
bot("08:02:30", "Split the change into three smaller patches; parity passes locally.");
injected("08:04:00", TEXT.fragment);
bot("08:04:12", "Done: the CLI command is added and parity is green.");
injected("08:06:00", TEXT.iteration);
bot(
  "08:06:25",
  "Out of tool calls for this turn. So far: #108 rebased and green, #97's audit fix pushed, #110 still needs a rebase.",
);
// Compaction: the hidden standalone summary, its filler continue row (dropped),
// then the task list carried across it.
injected("08:10:00", SUMMARY, "hidden");
you("08:10:00", TEXT.continueMarker);
injected("08:10:01", TEXT.todo);
bot("08:10:20", "Picking up at task 2: #108 is rebased, so re-running its CI next.");
injected("08:12:00", TEXT.handoff, "internal_notification");
bot(
  "08:12:15",
  "Working here now. We were landing the PR stack: #108 is green, #97 has its audit fix, #110 needs a rebase.",
);
injected("08:14:00", TEXT.model, "model_switch");
bot("08:14:09", "Now running on claude-sonnet-5-5 via anthropic.");
injected("08:15:00", TEXT.personaSet, "personality_switch");
bot("08:15:12", "- #108: green\n- #97: audit fixed, CI running\n- #110: needs rebase");
injected("08:16:00", TEXT.personaCleared, "personality_switch");
you("08:17:00", TEXT.skill, { display_kind: "skill_invocation" });
bot(
  "08:17:44",
  "Two findings in #108's diff: an unchecked `null` in the merge path, and a test that no longer asserts anything. Both are small.",
);
// A later summary merged into the operator's next ask: `content` is the whole
// carrier, `display_content` the ask the dashboard recovered from it.
injectedIds.push(
  you("08:30:00", `${LATER_SUMMARY}\n\nship #108 once CI is green`, {
    display_content: "ship #108 once CI is green",
  }),
);
bot("08:30:15", "Will do; CI on #108 is green, so merging it now.");
you("08:31:00", "and land #110 too");
bot("08:31:40", TEXT.failed, { display_kind: "failed_turn" });

/**
 * The transcript, mapped by the history reader and stamped with kestrel as the
 * bot rows' author. Every injected row must come out as a `system` message (a
 * row split around the operator's text, under its `:notice` id).
 */
export const KESTREL_INJECTED_TRANSCRIPT: readonly ChatMessage[] = (() => {
  const mapped = mapHistory(BOX, SESSION, rows).map((m) =>
    m.role === "bot" ? { ...m, author: KESTREL } : m,
  );
  const events = new Set(mapped.filter((m) => m.role === "system").map((m) => m.id));
  for (const id of injectedIds) {
    if (!events.has(id) && !events.has(`${id}:notice`))
      throw new HermeticError("CHAT_PROTOCOL", `fixture injected row no longer parses: ${id}`);
  }
  return mapped;
})();
