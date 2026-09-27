---
name: orchestrator-mode
description: Put this session into persistent ORCHESTRATOR working mode. The main session dispatches; a depth-1 task orchestrator (Fable, Opus or Sonnet by task size) plans and delegates; depth-2 workers implement and research. Use when the user says "orchestrator mode", "act as orchestrator", or "delegate to subagents". This skill applies its delegation model to all later requests until the user turns it off.
---

# Orchestrator Mode

Skill invoke = session enter **persistent working mode**. Not one-shot: until user say stop (e.g. "exit orchestrator mode", "just do it yourself"), **every user instruction run through delegation model below.** Re-apply each new request, no reminder needed.

This file is the **dispatcher's** half. The orchestrator's and workers' rules live in `.claude/agents/task-orchestrator.md`, which the harness injects on spawn — do not restate them here, and do not paste them into a brief.

## 1 · Runtime and models

Pick the runtime on activation; keep it until the user switches ("switch to Claude mode" / "switch to Cursor CLI mode"). **Cursor CLI** when the host is Cursor CLI or the user says so; **Claude** otherwise.

| Role | Claude | Cursor CLI |
| ---- | ------ | ---------- |
| Task orchestrator — complex (ambiguous scope, architecture, unknown root cause, conventions to reconcile) | Fable 5 | GPT-5.6 Sol |
| Task orchestrator — large or normal (known shape, located cause, mostly execution) · **default** | Opus | Terra (`gpt-5.6-terra-medium`) |
| Task orchestrator — small or mechanical (batch rename, doc pass, specified edits, running checks) | Sonnet | Composer (`composer-2.5-fast`) |
| Workers — implementation, hard debugging | Opus | Terra |
| Workers — recon, drafting, running commands, review sweeps | Sonnet or Haiku | Composer |

Sizing the task and picking the orchestrator's model is the dispatcher's judgement call; put the reason in the `Agent` call's `description`, which the harness persists to `meta.json`. Reach for Fable when the hard part is deciding, Sonnet when there is no deciding left. On Cursor CLI, launch `Subagent` with those model ids; the agent files and env limits below are Claude-side.

Worker model choice is a **money** lever, not a token lever — the same context and request count are paid either way, just at a cheaper rate.

## 2 · The shape

| Level | Who | Job |
| ----- | --- | --- |
| **0 · dispatcher** | main session | Size the task, write the brief, spawn one orchestrator, relay its report, own every user interaction and approval |
| **1 · task orchestrator** | `task-orchestrator` subagent | Plan, spawn workers, integrate, verify, report — then die, taking its context with it |
| **2 · workers** | subagents | Recon, implementation, review, checks |

Measured here: main sessions averaged ~200k context over 2,015 requests, because a main-thread orchestrator carries everything it reads for the rest of the session. Making that context disposable shrinks the growth term — it does not remove it, since main still re-sends its own history. The win compounds over a long multi-task session and is negative for a single short one.

On activation, confirm roles in one line, e.g. _"Orchestrator mode on — main dispatches; task orchestrator plans and delegates; Opus implements, Sonnet researches."_

**Stay inline instead** when delegating costs more than it saves: the whole job is one or two tool calls, or it is a tight interactive loop with several approvals (a subagent cannot reach the user, so each approval is a round-trip). The test is *expected inline turns × main's current context* against the ~2 turns plus brief that delegation costs — which means the bigger main's context already is, the smaller the job has to be to justify keeping it inline.

## 3 · Budgets — ceilings, not targets

**There is no turn cap.** A long autonomous session has to be able to iterate until the work is actually done, and a turn ceiling ends work mid-task rather than making it cheap. Bound *context per turn* and *progress per turn* instead — the billed quantity is requests carrying an ever-growing context, so a hundred cheap turns beat twenty expensive ones. The measured average worker ran 35 requests at ~104k each; the fix is that each of those turns should have been carrying 20k, not that there should have been five of them.

| Bound | Ceiling | On hitting it |
| ----- | ------- | ------------- |
| Worker context | 120k | recycle: worker writes a handoff, orchestrator spawns its successor with it |
| Orchestrator context | 200k | checkpoint: report `STATUS: continue` and be re-spawned against the checkpoint |
| Agents per fan-out message | 3 | wait for a slot |
| Task orchestrators in flight | 1 per user task | siblings share no context and duplicate work |

Everything else is unbounded on purpose: workers per task, turns per agent, review rounds. **Recycling, not stopping, is how an agent gets past a ceiling** — a successor carrying a 2k handoff costs a fraction of a predecessor carrying 300k of history, and the work continues either way.

Batch every independent read into one parallel tool block and synthesize once — not to hit a turn budget, but because ten sequential single-read turns each re-send the whole context that one batched turn sends once.

**Self-correction runs until it converges, not for a fixed number of rounds.** Keep iterating while each review round produces *new* confirmed findings. Stop when a round produces none, or when the same finding survives two attempted fixes — that is a disagreement for the orchestrator to arbitrate, not a third identical attempt.

Harness-enforced in `.claude/settings.json`: `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=3` (an agent at the limit is not offered the `Agent` tool) and `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=5`, which counts the orchestrator and every descendant — so a 3-wide fan-out leaves one free slot, and any wider fan-out runs in waves. See `.claude/skills/README.md` for why the per-session variable is deliberately unset. For unattended runs, `--max-budget-usd` is the real bound — a dollar ceiling stops a runaway without capping legitimate long work the way `--max-turns` does. Set it generously and let the session run.

**Dispatcher context, 600k:** stop and hand off — write a note naming state, decisions and next step, and continue in a fresh session. A long autonomous run should reach this rarely, because the orchestrators are absorbing the work; if main is growing fast, it is doing work it should have delegated. Main cannot compact itself (`/compact` is a user command) and auto-compaction fires near the window limit, which is the expensive zone.

## 4 · The brief

A subagent sees no conversation, so the brief is its entire world. Self-contained — no "see AGENTS.md", no "the bug we discussed":

```
GOAL         one sentence, testable
SEAMS        path:line for everywhere the work touches, as far as known
CONVENTIONS  quoted inline, not referenced
CONSTRAINTS  files/packages it may touch; what is out of scope
DONE WHEN    the check that proves it (exact command, expected result)
DELEGATION   may spawn workers: yes/no · budget: N workers
```

Naming the seams is the difference between a 4-turn task and a 35-turn one. If you do not know where to point, that is one cheap recon worker first, then a sharp brief.

The report comes back in the shape `task-orchestrator.md` defines. What the dispatcher needs from it: status, the base revision and changed-file manifest (you commit from these), verification commands with exit codes, decisions made on your behalf, the reviewer's verdict, what is undone, and what to spot-check. **Spot-check a hunk of your own choosing, not only the nominated ones** — a defect the orchestrator missed will not appear in its own risk list. Re-reading a hunk to check it is the job; re-reading files to work out *what happened* means the report shape failed.

**Continuation.** `STATUS: continue` means the orchestrator hit its context ceiling with work left, and its report carries a `NEXT` block. Spawn a successor with the original brief plus that block — nothing else, and never the previous report in full. This is the normal way a long task proceeds; it is not a failure, and it is what keeps a twelve-hour session's turns as cheap as its first.

**Approvals.** Anything destructive, irreversible or scope-expanding comes back as `STATUS: needs-approval` with the orchestrator's agent id. Ask the user, then answer that agent with `SendMessage` — it keeps the context it built. Re-briefing from scratch throws that away.

## 5 · Dispatcher discipline

- **Do not orchestrate.** Spawning six workers from main and absorbing six results is the old shape in new vocabulary. One brief, one orchestrator, one report.
- **Do not do the work.** Main's context is the one that has to survive the session.
- **Check for strays before committing.** `ListAgents` — a crashed or budget-killed orchestrator never ran its own `TaskStop`, and a descendant still editing while you commit is the ugliest failure available here.
- **A refused spawn or an exhausted budget is reported, never retried or routed around.** Say what is therefore undone. A plausible-looking completion over work nobody did is worse than an honest partial.
- **Stop on absence of progress, never on elapsed turns.** A long session is expected. What is not expected: a loop. Three identical read-only calls with nothing changed, the same command failing twice, a review finding surviving two fixes, or an agent past its context ceiling with nothing new to show — those end the current agent, not the task. Spawn the successor with what was learned.
- **Stop on repetition, not on repeats.** The same read-only call three times with nothing changed in between means the answer is already in context. An edit, a command, or expected state change since the last call resets that; so does re-running a test to verify a fix, or polling for state expected to change.
- **Compressed prose on the wire.** If the caveman skill is available, enter full mode for prose and reports; code, commits and docs stay normal English. Never caveman: security warnings, irreversible-action confirmations, multi-step sequences where fragment order risks misread. This trims output and future re-sends — real, but second-order next to not making the request at all.
- **Mode persists.** Re-check every request against §2 before touching code yourself, including the third one that "seemed quick".

## 6 · Token discipline

- Token discipline: **delegate reads** — `Explore` for "where is X / what calls Y", returns `file:line` table, not file dumps; graft, when installed (`bun run agent-setup`), answers the same questions from the graph. **Never re-read to confirm** — `Edit`/`Write` error if they fail, and `AGENTS.md` plus `docs/design.md` are the index: read the one section you need (`sed -n`/`grep -n`), not the whole file.
- Delegation discipline (measured over a 12-agent session): right-size the work, and optimise for token efficiency over wall-clock. Four rules. **Scope test runs to the file under test** — `bun test packages/core/test/foo.test.ts` while iterating; run the full `bun run check` once, at the end. **Pipe, never read, a full run** — `bun run check > /tmp/check.log 2>&1; echo "exit=$?"; grep -E "^ *[0-9]+ (pass|fail)|violations" /tmp/check.log | tail -8`. A `check` log is ~6KB, but a suite run per mutation is not. **Mutation-prove the 2-3 tests guarding the riskiest behaviour, not every test** — the mutate/run/revert cycle is the single biggest token multiplier in a test-writing task; spend it where a vacuous test would actually cost something, assert the rest normally. **One reviewer, prompted to refute, beats three** — a review that reads four files and returns "no issues" costs ~50-95k tokens and buys nothing; a browser/fixture pass against the running app finds what unit tests structurally cannot.
