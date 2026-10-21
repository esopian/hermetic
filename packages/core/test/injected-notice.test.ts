/**
 * The injected rows that are neither a background process nor a delegation
 * (`chat/hermes/injected-notice.ts`), read through `parseProcessNotice` and
 * `mapHistory` as the history reader reads them. Each shape is the row a box
 * stores, verbatim (some samples abbreviate upstream's long guidance with
 * `…`, which the parsers tolerate because they anchor on the parts upstream
 * fixes), plus the text that must stay the operator's.
 */
import { describe, expect, test } from "bun:test";
import type { BoxAddress } from "../src/chat/hermes/hermes-chat.ts";
import { mapHistory } from "../src/chat/hermes/hermes-chat.ts";
import {
  isCompactionContinueMarker,
  isFailedTurn,
  parseReplyContext,
  parseSkillInvocation,
} from "../src/chat/hermes/injected-notice.ts";
import {
  parseLeadingNotice,
  parseProcessNotice,
  processNoticePreview,
} from "../src/chat/hermes/process-notice.ts";
import { ChatBlock } from "../src/schema/index.ts";
import { todoSummary } from "../src/shared/process-event.ts";
import { sha256Hex } from "../src/shared/sha256.ts";

const RAWS = {
  cron: [
    {
      role: "user",
      content:
        '[Cronjob "pr-checkin" output — scheduled job, not the user. Review it, act on anything that needs action, and summarize for the chat.]\n\n#97 BEHIND, audit and ci failing\n#110 DIRTY, needs a rebase onto master',
      display_kind: null,
    },
  ],
  "cron-failed": [
    {
      role: "user",
      content:
        "[Cronjob \"docgen\" output — scheduled job, not the user. Review it, act on anything that needs action, and summarize for the chat.]\n\n⚠️ Cron 'docgen' failed: its script timed out. No model was invoked.",
      display_kind: null,
    },
  ],
  "cron-mirror": [
    {
      role: "user",
      content: "[Cron delivery: nightly-digest]\n3 PRs merged, 1 failing (#97).",
      display_kind: null,
    },
    {
      role: "user",
      content: "[Webhook delivery: github-push]\npush to master by evan: 3 commits (7987404…)",
      display_kind: null,
    },
  ],
  heartbeat: [
    {
      role: "user",
      content:
        "[Heartbeat — recurring instruction, fires every 30m]\nCheck the deploy queue and flag anything stuck.\n\nIf there is nothing meaningful to do or report for this instruction right now, reply briefly that nothing has changed and stop — do not invent work.",
      display_kind: "internal_notification",
    },
  ],
  loop: [
    {
      role: "user",
      content:
        "[/loop wakeup #4 · every 5m]\nRecurring task: watch CI on #108 until it is green\n\nThis is an automatic wakeup from the /loop the user set. Perform the task now against the CURRENT state (re-check files, processes, or services fresh — do not assume anything from earlier iterations still holds). Report concisely what you found or did this iteration.\nIf the task is now complete, no longer applicable, or the thing you were watching has finished, say so and end your reply with [LOOP_COMPLETE] on its own line — that stops the loop.",
      display_kind: "internal_notification",
    },
  ],
  goal: [
    {
      role: "user",
      content:
        "[Continuing toward your standing goal]\nGoal: get every open PR green and merged\n\nContinue working toward this goal. Take the next concrete step. If you believe the goal is complete, state so explicitly and stop. If you are blocked and need input from the user, say so clearly and stop.",
      display_kind: null,
    },
  ],
  "goal-gate": [
    {
      role: "user",
      content:
        "[Continuing toward your standing goal — a quality gate failed]\nGoal: get every open PR green and merged\n\nThe quality gate command below must pass before this goal can be considered complete…\n\n$ bun run ci\n✗ tests/parity.test.ts  1 fail\nexit 1",
      display_kind: null,
    },
  ],
  handoff: [
    {
      role: "user",
      content:
        '[Session was just handed off from CLI ("refactor auth") to this channel. The full prior conversation history is loaded above. Briefly confirm you\'re working here and summarize what we were working on, so the user can continue from this device.]',
      display_kind: "internal_notification",
    },
  ],
  resume: [
    {
      role: "user",
      content:
        "[System note: Your previous turn was interrupted mid-run — the app or its backend process stopped before the turn could finish. Some of the work may already be complete; check the current state before redoing anything, then finish the task. The interrupted request was:]\n\nrebase #108 onto master",
      display_kind: "auto_continue",
    },
  ],
  "gw-resume": [
    {
      role: "user",
      content:
        "[System note: The previous turn was interrupted by a gateway restart; the gateway is now back online. Any restart/shutdown command in the history has already run — do NOT re-execute or verify it. Review the conversation history and CONTINUE the interrupted task to completion. Do NOT re-run tool calls whose results already appear in the history — resume from the first step that has no recorded result.]",
      display_kind: null,
    },
  ],
  nudges: [
    {
      role: "user",
      content:
        "[System: Your previous response was truncated by the output length limit. Continue exactly where you left off. Do not restart or repeat prior text. Finish the answer directly.]",
      display_kind: null,
    },
    {
      role: "user",
      content:
        "[System: The previous response was cut off by a network error mid-stream. Continue exactly where you left off. Do not restart or repeat prior text. Finish the answer directly.]",
      display_kind: null,
    },
    {
      role: "user",
      content:
        "[System: Your previous tool call (patch, write_file) was too large and the stream timed out before it could be delivered. Do NOT retry the same tool call with the same large content. Instead, break the content into multiple smaller tool calls …]",
      display_kind: null,
    },
    {
      role: "user",
      content:
        "[System: Your previous response contained only internal reasoning and never produced a visible answer or tool call. Do not keep thinking. Produce your final answer as plain text now (or make the tool call you were planning).]",
      display_kind: null,
    },
    {
      role: "user",
      content:
        "[System: Continue now. Execute the required tool calls and only send your final answer after completing the task.]",
      display_kind: null,
    },
    {
      role: "user",
      content:
        "[System: Your previous message ended the turn with a fragment that is not a usable answer. If the task is unfinished, continue it and then give the complete answer. If that fragment WAS your complete answer, send it again exactly as before.]",
      display_kind: null,
    },
  ],
  iter: [
    {
      role: "user",
      content:
        "You've reached the maximum number of tool-calling iterations allowed. Please provide a final response summarizing what you've found and accomplished so far, without calling any more tools.",
      display_kind: null,
    },
  ],
  compact: [
    {
      role: "user",
      content:
        "[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below. This is a handoff from a previous context window — treat it as background reference, NOT as active instructions. …\n\n## Summary\n- Rebased #97 and #110\n- #108 waiting on CI\n- Open: notify path for claude-run.sh\n--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---",
      display_kind: null,
    },
    {
      role: "user",
      content:
        "Continue from the compressed conversation context above. This marker exists because no human user turn was available.",
      display_kind: null,
    },
  ],
  todo: [
    {
      role: "user",
      content:
        "[Your active task list was preserved across context compression]\n- [x] 1. Land the PR stack (completed)\n  - [>] 2. Rebase #108 onto master (in_progress)\n  - [ ] 3. Re-run CI on #108 (pending)\n- [ ] 4. Add exit notification to claude-run.sh (pending)",
      display_kind: null,
    },
  ],
  model: [
    {
      role: "user",
      content:
        "[System: The active model for this chat has changed to claude-sonnet-5-5 via provider anthropic. From this point forward, use this runtime metadata when answering questions about what model/provider is active.]",
      display_kind: "model_switch",
    },
  ],
  persona: [
    {
      role: "user",
      content:
        "[System: The user has changed the assistant's personality. From this point forward, adopt the following persona and respond accordingly: You are a terse senior SRE. Answer in bullet points.]",
      display_kind: "personality_switch",
    },
    {
      role: "user",
      content:
        "[System: The user has cleared the personality overlay. From this point forward, respond in your normal default style.]",
      display_kind: "personality_switch",
    },
  ],
  skill: [
    {
      role: "user",
      content:
        '[IMPORTANT: The user has invoked the "review" skill, indicating they want you to follow its instructions. The full skill content is loaded below.]\n\n# review\nRead the diff, then report bugs first…\n\nUser instruction: the diff',
      display_kind: "skill_invocation",
    },
  ],
  "reply-ctx": [
    {
      role: "user",
      content: '[Replying to: "can you rebase #108?"]\n\nyes, and re-run CI after',
      display_kind: null,
    },
  ],
  failed: [
    {
      role: "assistant",
      content:
        "This turn did not complete. Some actions may already have run; verify their effects before resending.",
      display_kind: "failed_turn",
    },
  ],
  mirror: [{ role: "assistant", content: "Deploy finished, all green.", display_kind: null }],
  proc: [
    {
      role: "user",
      content:
        "[IMPORTANT: Background process proc_3be1c0a4d2e1 completed normally (exit code 0).\nCommand: bun run build\nOutput:\nBundled 312 modules in 1.84s\n]",
      display_kind: "process_complete",
    },
  ],
  deleg: [
    {
      role: "user",
      content:
        '[ASYNC DELEGATION COMPLETE — deleg_s1]\nA background subagent you dispatched earlier has finished. …\nOriginal goal: Find every user-role renderer\nStatus: completed   API calls: 7   Duration: 93.2s\n--- RESULT ---\nThree renderers read role === "user" as You.',
      display_kind: "async_delegation_complete",
    },
  ],
} as const;

type Shape = keyof typeof RAWS;
const raw = (shape: Shape, i = 0): string => RAWS[shape][i]?.content ?? "";
const kindOf = (shape: Shape, i = 0): string | null => RAWS[shape][i]?.display_kind ?? null;
const parse = (shape: Shape, i = 0) => parseProcessNotice(raw(shape, i), kindOf(shape, i));

/** Upstream's `preview`: first 60 characters, newlines flattened, `...` appended. */
const upstreamPreview = (text: string) => {
  const flat = text.replace(/[\r\n]/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 60)}...` : flat;
};

/** `gateway/run.py` `build_resume_recovery_note` with a new message, as a gateway writes it. */
const GW_NOTE_WITH_MESSAGE =
  "[System note: The previous turn was interrupted by a gateway shutdown; the gateway is now back online. Any restart/shutdown command in the history has already run — do NOT re-execute or verify it. Address the user's NEW message below FIRST and focus on what the user is asking now. Do NOT re-execute old tool calls — skip any unfinished work from the conversation history.]\n\nwhat is the status of #108?";

/** `skill_commands.py`'s single-skill form with an instruction, and a stacked bundle. */
const SKILL_SINGLE =
  '[IMPORTANT: The user has invoked the "review" skill, indicating they want you to follow its instructions. The full skill content is loaded below.]\n\n# review\nRead the diff.\n\nThe user has provided the following instruction alongside the skill invocation: the diff on #108\n\n[Runtime note: cwd is /repo]';
const SKILL_BUNDLE =
  '[IMPORTANT: The user has invoked the "/review /ship" stacked skill bundle, loading 2 skills together. Treat every skill below as active guidance for this turn.]\n\nSkills loaded: review, ship\n\nUser instruction: land #108\n\n[Loaded as part of the stacked skill invocation "review".]\n\n# review\n…';

/** `agent/conversation_loop.py:893-903`, the two re-prompts without a `[System:` bracket. */
const DROPPED_TOOL_CALL =
  "Your previous turn indicated a tool call but none was included. Do not narrate a plan or restate intent — issue the actual tool call now to continue the task.";
const EMPTY_TOOL_RESPONSE =
  "You just executed tool calls but returned an empty response. Please process the tool results above and continue with the task.";

describe("parseProcessNotice — injected rows", () => {
  type Case = [name: string, block: ReturnType<typeof parse>, expected: Record<string, unknown>];
  const CASES: Case[] = [
    ["cron output", parse("cron"), { event: "cron", outcome: "info", message: "pr-checkin" }],
    ["cron failure", parse("cron-failed"), { event: "cron", outcome: "failed", message: "docgen" }],
    [
      "cron mirror",
      parse("cron-mirror"),
      {
        event: "cron",
        outcome: "info",
        message: "nightly-digest",
        output_tail: "3 PRs merged, 1 failing (#97).",
        notice: { variant: "mirrored" },
      },
    ],
    [
      "webhook mirror",
      parse("cron-mirror", 1),
      {
        event: "webhook",
        outcome: "info",
        message: "github-push",
        output_tail: "push to master by evan: 3 commits (7987404…)",
        notice: { variant: "mirrored" },
      },
    ],
    [
      "heartbeat",
      parse("heartbeat"),
      {
        event: "heartbeat",
        outcome: "info",
        notice: { detail: "30m", subject: "Check the deploy queue and flag anything stuck." },
      },
    ],
    [
      "loop wakeup",
      parse("loop"),
      {
        event: "loop",
        notice: { detail: "#4 · every 5m", subject: "watch CI on #108 until it is green" },
      },
    ],
    [
      "goal continuation",
      parse("goal"),
      {
        event: "goal",
        outcome: "info",
        notice: { variant: "continuing", subject: "get every open PR green and merged" },
      },
    ],
    [
      "goal gate failed",
      parse("goal-gate"),
      {
        event: "goal",
        outcome: "failed",
        notice: { variant: "gate_failed", subject: "get every open PR green and merged" },
      },
    ],
    [
      "handoff",
      parse("handoff"),
      { event: "handoff", outcome: "info", notice: { detail: "CLI", subject: "refactor auth" } },
    ],
    [
      "crash resume",
      parse("resume"),
      {
        event: "resume",
        outcome: "warn",
        notice: { variant: "crash", subject: "rebase #108 onto master" },
      },
    ],
    [
      "gateway resume",
      parse("gw-resume"),
      { event: "resume", outcome: "warn", notice: { variant: "gateway", detail: "gateway restart" } },
    ],
    [
      "nudge: output limit",
      parse("nudges", 0),
      { event: "nudge", outcome: "info", notice: { variant: "output_limit" } },
    ],
    ["nudge: network cut", parse("nudges", 1), { event: "nudge", notice: { variant: "network_cut" } }],
    [
      "nudge: tool call too large",
      parse("nudges", 2),
      {
        event: "nudge",
        outcome: "warn",
        notice: { variant: "tool_too_large", subject: "patch, write_file" },
      },
    ],
    [
      "nudge: reasoning only",
      parse("nudges", 3),
      { event: "nudge", notice: { variant: "reasoning_only" } },
    ],
    [
      "nudge: continue now",
      parse("nudges", 4),
      { event: "nudge", notice: { variant: "continue_now" } },
    ],
    ["nudge: fragment", parse("nudges", 5), { event: "nudge", notice: { variant: "fragment" } }],
    [
      "nudge: dropped tool call",
      parseProcessNotice(DROPPED_TOOL_CALL),
      { event: "nudge", outcome: "info", notice: { variant: "dropped_tool_call" } },
    ],
    [
      "nudge: empty tool response",
      parseProcessNotice(EMPTY_TOOL_RESPONSE),
      { event: "nudge", outcome: "info", notice: { variant: "empty_tool_response" } },
    ],
    ["iteration limit", parse("iter"), { event: "iteration_limit", outcome: "warn" }],
    [
      "compaction summary",
      parse("compact"),
      {
        event: "compaction",
        outcome: "info",
        notice: {
          body: "## Summary\n- Rebased #97 and #110\n- #108 waiting on CI\n- Open: notify path for claude-run.sh",
        },
      },
    ],
    [
      "model switch",
      parse("model"),
      { event: "model_switch", notice: { subject: "claude-sonnet-5-5", detail: "anthropic" } },
    ],
    [
      "personality set",
      parse("persona"),
      {
        event: "personality",
        notice: {
          variant: "set",
          subject: "You are a terse senior SRE. Answer in bullet points.",
          body: "You are a terse senior SRE. Answer in bullet points.",
        },
      },
    ],
    [
      "personality cleared",
      parse("persona", 1),
      { event: "personality", notice: { variant: "cleared" } },
    ],
    ["background process", parse("proc"), { event: "completion", outcome: "ok" }],
    ["delegation", parse("deleg"), { event: "delegation", outcome: "ok" }],
  ];

  test.each(CASES)("%s", (_name, block, expected) => {
    expect(block).toMatchObject({ kind: "process_event", ...expected });
    expect(ChatBlock.safeParse(block).success).toBe(true);
  });

  test("the goal's fold is the injected prompt; a gate's is the gate output", () => {
    expect(parse("goal")?.notice?.body).toStartWith("Continue working toward this goal.");
    expect(parse("goal-gate")?.notice?.body).toContain(
      "$ bun run ci\n✗ tests/parity.test.ts  1 fail\nexit 1",
    );
  });

  test("the todo list parses into items, a done parent kept for its active children", () => {
    expect(parse("todo")?.notice?.tasks).toEqual([
      { status: "done", depth: 0, id: "1", text: "Land the PR stack" },
      { status: "active", depth: 1, id: "2", text: "Rebase #108 onto master" },
      { status: "pending", depth: 1, id: "3", text: "Re-run CI on #108" },
      { status: "pending", depth: 0, id: "4", text: "Add exit notification to claude-run.sh" },
    ]);
  });

  test("todo: cancelled, unknown and multi-line items", () => {
    const text =
      "[Your active task list was preserved across context compression]\n- [~] a. dropped (cancelled)\n- [?] b. odd (blocked)\n- [>] c. two\nlines (in_progress)";
    expect(parseProcessNotice(text)?.notice?.tasks).toEqual([
      { status: "cancelled", depth: 0, id: "a", text: "dropped" },
      { status: "unknown", depth: 0, id: "b", text: "odd" },
      { status: "active", depth: 0, id: "c", text: "two\nlines" },
    ]);
  });

  test("todo: an item's content continues at column 0, blank lines included", () => {
    const text =
      "[Your active task list was preserved across context compression]\n- [>] 1. first\nsecond (in_progress)\n- [ ] 2. next\n\nmore (pending)";
    expect(parseProcessNotice(text)?.notice).toMatchObject({
      tasks: [
        { status: "active", depth: 0, id: "1", text: "first\nsecond" },
        { status: "pending", depth: 0, id: "2", text: "next\n\nmore" },
      ],
      body: null,
    });
  });

  test("todo: the list stops at the skills-pruned notice, which is its body", () => {
    const text = `${raw("todo")}\n\n[Skills pruned during compression — reload before acting on these tasks]\nreview, ship`;
    const block = parseProcessNotice(text);
    expect(block?.notice?.tasks?.map((t) => t.text)).toEqual([
      "Land the PR stack",
      "Rebase #108 onto master",
      "Re-run CI on #108",
      "Add exit notification to claude-run.sh",
    ]);
    expect(block?.notice?.body).toBe(
      "[Skills pruned during compression — reload before acting on these tasks]\nreview, ship",
    );
    expect(parse("todo")?.notice?.body).toBeNull();
  });

  test("a goal header and a Goal line alone are not a continuation", () => {
    expect(
      parseProcessNotice("[Continuing toward your standing goal]\nGoal: ship it\n\nplease"),
    ).toBeNull();
    expect(parseProcessNotice("[Continuing toward your standing goal]\nGoal: ship it")).toBeNull();
    const contract =
      "[Continuing toward your standing goal]\nGoal: ship it\n\nCompletion contract:\n- done when CI is green\n\nContinue working toward the outcome above.";
    expect(parseProcessNotice(contract)?.notice?.variant).toBe("continuing");
  });

  test("a summary with leading whitespace is still a summary", () => {
    expect(parseProcessNotice(`\n  ${raw("compact")}`)?.event).toBe("compaction");
  });

  test("a gateway note carrying the user's new message keeps that message apart", () => {
    const lead = parseLeadingNotice(GW_NOTE_WITH_MESSAGE);
    expect(lead?.block).toMatchObject({ event: "resume", notice: { detail: "gateway shutdown" } });
    expect(lead?.rest).toBe("what is the status of #108?");
    expect(parseLeadingNotice(raw("gw-resume"))?.rest).toBeNull();
  });

  test("a merged compaction carrier keeps its live content apart", () => {
    const summary = raw("compact");
    expect(parseLeadingNotice(`${summary}\n\nplease rebase #108`)?.rest).toBe("please rebase #108");
    const merged = `[PRIOR CONTEXT — for reference only; not a new message]\nthe prior ask\n[END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]\n${summary}`;
    const lead = parseLeadingNotice(merged);
    expect(lead?.block.event).toBe("compaction");
    expect(lead?.rest).toBe("the prior ask");
  });

  test("display_kind decides first", () => {
    // A type that names the event makes the row that event even if the text drifted.
    expect(parseProcessNotice("[System: model is now x]", "model_switch")).toMatchObject({
      event: "model_switch",
      notice: { subject: null },
    });
    expect(parseProcessNotice("resume please", "auto_continue")).toMatchObject({
      event: "resume",
      notice: { variant: "crash" },
    });
    // A type that says the operator's row keeps it theirs, whatever the text.
    expect(parseProcessNotice(raw("heartbeat"), "skill_invocation")).toBeNull();
    expect(parseProcessNotice(raw("nudges", 4), "steer")).toBeNull();
    // An untyped row is read by its text alone.
    expect(parseProcessNotice(raw("heartbeat"), null)?.event).toBe("heartbeat");
    expect(parseProcessNotice(raw("model"), null)?.event).toBe("model_switch");
  });

  test.each([
    ["an empty string", ""],
    ["a heartbeat quoted mid-message", `fyi: ${raw("heartbeat")}`],
    [
      "a heartbeat with a different trailer",
      "[Heartbeat — recurring instruction, fires every 30m]\nCheck.\n\nDo whatever.",
    ],
    ["a loop without upstream's guidance", "[/loop wakeup #4, every 5m]\nRecurring task: watch CI"],
    ["a goal lookalike", "[Continuing toward your goal]\nGoal: x"],
    ["a handoff with another sentence", '[Session was just handed off from CLI ("x") to here.]'],
    ["a nudge with one word changed", raw("nudges", 4).replace("Continue now.", "Continue later.")],
    ["a nudge quoted mid-message", `the bot said ${raw("nudges", 0)}`],
    ["the iteration request with a suffix", `${raw("iter")} Thanks!`],
    ["a dropped-tool-call nudge quoted mid-message", `the bot got: ${DROPPED_TOOL_CALL}`],
    ["an empty-response nudge with a suffix", `${EMPTY_TOOL_RESPONSE} Thanks.`],
    ["an empty-response lookalike", "You just executed tool calls but returned nothing useful."],
    ["a summary lookalike", "[CONTEXT COMPACTION] here is my summary"],
    [
      "a todo header inline",
      "[Your active task list was preserved across context compression] - [ ] 1. x (pending)",
    ],
    [
      "a todo list with a stray first line",
      "[Your active task list was preserved across context compression]\nhello\n- [ ] 1. x (pending)",
    ],
    ["a model lookalike", "[System: The active model for this chat has changed to x.]"],
    ["a skill invocation", raw("skill")],
    ["a reply context", raw("reply-ctx")],
    ["a failed-turn notice", raw("failed")],
    ["a continue marker", raw("compact", 1)],
    ["a mirrored send_message", raw("mirror")],
  ])("%s is not a notice", (_name, text) => {
    expect(parseProcessNotice(text)).toBeNull();
  });
});

describe("processNoticePreview — injected rows", () => {
  test.each([
    ["cron-mirror", 0, "cron nightly-digest mirrored"],
    ["cron-mirror", 1, "webhook github-push mirrored"],
    ["heartbeat", 0, "heartbeat every 30m"],
    ["loop", 0, "loop wakeup #4"],
    ["goal", 0, "goal continuing"],
    ["goal-gate", 0, "■ goal gate failed"],
    ["handoff", 0, "handed off from CLI"],
    ["resume", 0, "turn resumed after a crash"],
    // The reason falls past the 60th character.
    ["gw-resume", 0, "turn resumed"],
    ["nudges", 0, "nudge: output limit"],
    ["nudges", 1, "nudge: network cut"],
    ["nudges", 2, "nudge: tool call too large"],
    ["nudges", 3, "nudge: reasoning only"],
    ["nudges", 4, "nudge: continue now"],
    ["nudges", 5, "nudge: fragment"],
    ["iter", 0, "tool-call limit reached"],
    ["compact", 0, "context compacted"],
    ["compact", 1, "context compacted"],
    ["todo", 0, "task list carried over"],
    ["model", 0, "model changed"],
    ["persona", 0, "personality set"],
    ["persona", 1, "personality cleared"],
  ] as [Shape, number, string][])("%s[%d] cut at 60 reads %p", (shape, i, sentence) => {
    expect(processNoticePreview(upstreamPreview(raw(shape, i)))).toBe(sentence);
  });

  test("the bare nudges read as nudges, whole or cut at 60", () => {
    expect(processNoticePreview(DROPPED_TOOL_CALL)).toBe("nudge: tool call missing");
    expect(processNoticePreview(upstreamPreview(DROPPED_TOOL_CALL))).toBe("nudge: tool call missing");
    expect(processNoticePreview(upstreamPreview(EMPTY_TOOL_RESPONSE))).toBe("nudge: empty reply");
  });

  test("a whole row reads with its fields", () => {
    expect(processNoticePreview(raw("model"))).toBe("model → claude-sonnet-5-5");
    expect(processNoticePreview(raw("gw-resume"))).toBe("turn resumed after gateway restart");
  });

  test("a todo preview needs the whole header or upstream's cut of it", () => {
    expect(processNoticePreview("[Your active task list was preserved")).toBeNull();
    expect(processNoticePreview(upstreamPreview(raw("todo")))).toBe("task list carried over");
  });

  test("todoSummary words the counts once for every head", () => {
    expect(todoSummary(parse("todo")?.notice?.tasks ?? [])).toBe("1 active · 2 open");
    expect(todoSummary([{ status: "done" }, { status: "cancelled" }])).toBe("nothing open");
  });

  test("a short message that is a prefix of a fixed text stays the operator's", () => {
    expect(processNoticePreview("[System: Continue now.")).toBeNull();
    expect(processNoticePreview("You've reached the maximum number")).toBeNull();
    expect(processNoticePreview("You've reached the maximum number...")).toBeNull();
    expect(processNoticePreview("Continue from the compressed conversation context above.")).toBeNull();
  });

  test("the operator's rows and prose stay unread", () => {
    expect(processNoticePreview(upstreamPreview(raw("skill")))).toBeNull();
    expect(processNoticePreview(upstreamPreview(raw("reply-ctx")))).toBeNull();
    expect(processNoticePreview("[System: hello")).toBeNull();
    expect(processNoticePreview("Continue from where we stopped")).toBeNull();
  });
});

describe("operator rows", () => {
  test("a skill invocation keeps the skill and the typed instruction", () => {
    expect(parseSkillInvocation(SKILL_SINGLE)).toEqual({
      names: ["review"],
      instruction: "the diff on #108",
    });
    expect(parseSkillInvocation(SKILL_BUNDLE)).toEqual({
      names: ["review", "ship"],
      instruction: "land #108",
    });
    // The sample's single form carries no upstream instruction marker.
    expect(parseSkillInvocation(raw("skill"))).toEqual({ names: ["review"], instruction: null });
    expect(parseSkillInvocation("please run the review skill")).toBeNull();
    expect(parseSkillInvocation(`x ${SKILL_SINGLE}`)).toBeNull();
  });

  test("a reply pointer is lifted off the user's text", () => {
    expect(parseReplyContext(raw("reply-ctx"))).toEqual({
      quote: "can you rebase #108?",
      text: "yes, and re-run CI after",
    });
    expect(parseReplyContext('[Replying to your previous message: "a"]\n\nb')).toEqual({
      quote: "a",
      text: "b",
    });
    expect(parseReplyContext('I was [Replying to: "a"]\n\nb')).toBeNull();
  });

  test("failed-turn and continue-marker rows are recognised exactly", () => {
    expect(isFailedTurn("failed_turn", raw("failed"))).toBe(true);
    expect(isFailedTurn(null, raw("failed"))).toBe(true);
    expect(isFailedTurn(null, `${raw("failed")} Sorry.`)).toBe(false);
    expect(isCompactionContinueMarker(raw("compact", 1))).toBe(true);
    expect(isCompactionContinueMarker(`${raw("compact", 1)} ok`)).toBe(false);
  });
});

/* ── through the history reader ───────────────────────────────────────────── */

const BOX: BoxAddress = {
  instance: "kestrel",
  baseUrl: "https://fxtr0001-kestrel.tail0000.ts.net/",
  fleet_id: "fxtr0001",
};
const SESSION = "s-injected";
const AT = "2026-10-21T09:00:00.000Z";

const row = (id: number, role: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  id,
  role,
  content,
  timestamp: AT,
  ...extra,
});

describe("mapHistory — injected rows", () => {
  test("every shape, typed and untyped: events are system rows, operator rows stay the user's", () => {
    const rows = (Object.keys(RAWS) as Shape[]).flatMap((shape) =>
      RAWS[shape].flatMap((r, i) => [
        row(1000 + rows_n(shape, i) * 2, r.role, r.content, { display_kind: r.display_kind }),
        row(1001 + rows_n(shape, i) * 2, r.role, r.content),
      ]),
    );
    const out = mapHistory(BOX, SESSION, { messages: rows });
    const byId = new Map(out.map((m) => [m.id, m]));
    for (const shape of Object.keys(RAWS) as Shape[]) {
      RAWS[shape].forEach((_r, i) => {
        for (const id of [1000 + rows_n(shape, i) * 2, 1001 + rows_n(shape, i) * 2]) {
          const m = byId.get(`${SESSION}:${id}`);
          const expected =
            shape === "skill" || shape === "reply-ctx"
              ? "user"
              : shape === "failed" || shape === "mirror"
                ? "bot"
                : "system";
          if (shape === "compact" && i === 1) {
            expect({ shape, i, mapped: m ?? null }).toEqual({ shape, i, mapped: null });
          } else {
            expect({ shape, i, role: m?.role }).toEqual({ shape, i, role: expected });
          }
        }
      });
    }
  });

  test("a hidden compaction summary is the event; any other hidden row stays dropped", () => {
    const out = mapHistory(BOX, SESSION, {
      messages: [
        row(1, "user", raw("compact"), { display_kind: "hidden" }),
        row(2, "user", "[internal bookkeeping]", { display_kind: "hidden" }),
        row(3, "user", raw("heartbeat"), { display_kind: "hidden" }),
        row(4, "assistant", raw("compact"), { display_kind: "hidden" }),
        row(5, "user", raw("compact", 1)),
        row(6, "assistant", "Picking up from the summary."),
      ],
    });
    expect(out.map((m) => [m.id, m.role])).toEqual([
      [`${SESSION}:1`, "system"],
      [`${SESSION}:4`, "system"],
      [`${SESSION}:6`, "bot"],
    ]);
    expect(out[0]?.blocks[0]).toMatchObject({ kind: "process_event", event: "compaction" });
  });

  test("a merged carrier splits: the summary first as `:notice`, the user's part keeps the id", () => {
    const summary = raw("compact");
    const out = mapHistory(BOX, SESSION, {
      messages: [
        // The dashboard's projection: display_content is the live ask, display_kind dropped.
        row(7, "user", `${summary}\n\nplease rebase #108`, { display_content: "please rebase #108" }),
        // Another path: no projection, the delimiter form.
        row(
          8,
          "user",
          `[PRIOR CONTEXT — for reference only; not a new message]\nthe prior ask\n[END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]\n${summary}`,
        ),
      ],
    });
    expect(out.map((m) => [m.id, m.role, m.blocks[0]?.kind])).toEqual([
      [`${SESSION}:7:notice`, "system", "process_event"],
      [`${SESSION}:7`, "user", "text"],
      [`${SESSION}:8:notice`, "system", "process_event"],
      [`${SESSION}:8`, "user", "text"],
    ]);
    expect(out[1]?.blocks).toEqual([{ kind: "text", markdown: "please rebase #108" }]);
    expect(out[3]?.blocks).toEqual([{ kind: "text", markdown: "the prior ask" }]);
  });

  test("a gateway note with the user's text splits in two; without, it is one event", () => {
    const out = mapHistory(BOX, SESSION, {
      messages: [row(9, "user", GW_NOTE_WITH_MESSAGE), row(10, "user", raw("gw-resume"))],
    });
    expect(out.map((m) => [m.id, m.role])).toEqual([
      [`${SESSION}:9:notice`, "system"],
      [`${SESSION}:9`, "user"],
      [`${SESSION}:10`, "system"],
    ]);
    expect(out[1]?.blocks).toEqual([{ kind: "text", markdown: "what is the status of #108?" }]);
  });

  test("a split row with no id keeps the hash it had before the split", () => {
    const content = GW_NOTE_WITH_MESSAGE;
    const out = mapHistory(BOX, SESSION, { messages: [{ role: "user", content, timestamp: AT }] });
    const before = `${SESSION}:h${sha256Hex([SESSION, "user", "", content, AT].join("\u0000")).slice(0, 16)}`;
    expect(out.map((m) => m.id)).toEqual([`${before}:notice`, before]);
  });

  test("a task list folded onto the operator's row follows it as its own event", () => {
    const out = mapHistory(BOX, SESSION, {
      messages: [row(20, "user", `rebase #108 next\n\n${raw("todo")}`), row(21, "user", "plain")],
    });
    expect(out.map((m) => [m.id, m.role])).toEqual([
      [`${SESSION}:20`, "user"],
      [`${SESSION}:20:notice`, "system"],
      [`${SESSION}:21`, "user"],
    ]);
    expect(out[0]?.blocks).toEqual([{ kind: "text", markdown: "rebase #108 next" }]);
    expect(out[1]?.blocks[0]).toMatchObject({ event: "todo", raw: raw("todo") });
    expect(out[1]?.blocks[0]?.kind === "process_event" && out[1].blocks[0].notice?.tasks).toHaveLength(
      4,
    );
  });

  test("a task list header the operator typed earlier does not hide the real one", () => {
    const header = "[Your active task list was preserved across context compression]";
    const typed = `I saw this:\n\n${header}\nhello`;
    const out = mapHistory(BOX, SESSION, {
      messages: [row(23, "user", `${typed}\n\n${header}\n- [ ] 1. x (pending)`)],
    });
    expect(out.map((m) => m.id)).toEqual([`${SESSION}:23`, `${SESSION}:23:notice`]);
    expect(out[0]?.blocks).toEqual([{ kind: "text", markdown: typed }]);
  });

  test("a task list appended as its own part follows the operator's parts", () => {
    const out = mapHistory(BOX, SESSION, {
      messages: [
        row(24, "user", [
          { type: "text", text: "rebase #108" },
          { type: "text", text: raw("todo") },
        ]),
      ],
    });
    expect(out.map((m) => [m.id, m.role])).toEqual([
      [`${SESSION}:24`, "user"],
      [`${SESSION}:24:notice`, "system"],
    ]);
    expect(out[0]?.blocks).toEqual([{ kind: "text", markdown: "rebase #108" }]);
    expect(out[1]?.blocks[0]).toMatchObject({ event: "todo" });
  });

  test("a folded task list on CRLF text keeps the operator's text as stored", () => {
    const content = `rebase #108\r\nnext\r\n\r\n${raw("todo").replace(/\n/g, "\r\n")}`;
    const out = mapHistory(BOX, SESSION, { messages: [row(25, "user", content)] });
    expect(out[0]?.blocks).toEqual([{ kind: "text", markdown: "rebase #108\r\nnext" }]);
    expect(out[1]?.blocks[0]).toMatchObject({ event: "todo" });
  });

  test("a multi-part merged carrier keeps its compaction marker", () => {
    const out = mapHistory(BOX, SESSION, {
      messages: [
        row(
          22,
          "user",
          [
            { type: "text", text: raw("compact") },
            { type: "text", text: "ship #108" },
          ],
          { display_content: [{ type: "text", text: "ship #108" }] },
        ),
      ],
    });
    expect(out.map((m) => [m.id, m.role])).toEqual([
      [`${SESSION}:22:notice`, "system"],
      [`${SESSION}:22`, "user"],
    ]);
    expect(out[0]?.blocks[0]).toMatchObject({ event: "compaction" });
    expect(out[1]?.blocks).toEqual([{ kind: "text", markdown: "ship #108" }]);
  });

  test("a failed turn is the message's failure, not the bot speaking", () => {
    const out = mapHistory(BOX, SESSION, {
      messages: [
        row(11, "user", "rebase #108"),
        row(12, "assistant", raw("failed"), { display_kind: "failed_turn" }),
        row(
          13,
          "assistant",
          "Your request was not processed. Send it again if you still want me to carry it out.",
        ),
        row(14, "assistant", `${raw("failed")} I will retry.`),
      ],
    });
    for (const m of [out[1], out[2]]) {
      expect(m).toMatchObject({
        role: "bot",
        blocks: [],
        incomplete: true,
        failure: { code: "CHAT_TURN_FAILED" },
      });
      expect(m?.error).toBe(m?.failure?.message);
    }
    expect(out[1]?.error).toBe(raw("failed"));
    expect(out[3]).toMatchObject({ role: "bot", error: null });
    expect(out[3]?.failure).toBeUndefined();
  });

  test("a skill invocation and a reply stay the user's, with the scaffolding lifted", () => {
    const out = mapHistory(BOX, SESSION, {
      messages: [
        row(15, "user", SKILL_SINGLE, { display_kind: "skill_invocation" }),
        row(16, "user", raw("skill"), { display_kind: "skill_invocation" }),
        row(17, "user", raw("reply-ctx")),
        row(18, "user", "plain words"),
      ],
    });
    expect(out[0]).toMatchObject({
      id: `${SESSION}:15`,
      role: "user",
      skill: { names: ["review"], instruction: "the diff on #108", raw: SKILL_SINGLE },
      blocks: [{ kind: "text", markdown: "the diff on #108" }],
    });
    expect(out[1]).toMatchObject({
      role: "user",
      skill: { names: ["review"], instruction: null },
      blocks: [],
    });
    expect(out[2]).toMatchObject({
      id: `${SESSION}:17`,
      role: "user",
      reply_to: { quote: "can you rebase #108?" },
      blocks: [{ kind: "text", markdown: "yes, and re-run CI after" }],
    });
    expect("skill" in (out[3] ?? {})).toBe(false);
    expect("reply_to" in (out[3] ?? {})).toBe(false);
  });
});

/** A stable index per raw row, for ids. */
function rows_n(shape: Shape, i: number): number {
  const shapes = Object.keys(RAWS) as Shape[];
  return shapes.indexOf(shape) * 10 + i;
}
