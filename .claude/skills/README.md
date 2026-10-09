# Project skills

Skills and subagents checked into this repo so they work without any
plugin installed. Claude Code loads `.claude/skills/` and `.claude/agents/`
automatically for anyone who clones the repo.

| Path | What | Origin |
|---|---|---|
| `caveman/` | Compressed-response mode (`/caveman lite\|full\|ultra`) | vendored, MIT |
| `create-pr/` | Opens every PR via `gh`, body filled from `.github/pull_request_template.md` as a review guide (`/create-pr`) | this repo |
| `orchestrator-mode/` | Main dispatches, a depth-1 task orchestrator delegates, workers implement | this repo |
| `../agents/task-orchestrator.md` | The depth-1 orchestrator that skill spawns | this repo |

## Caveman in this repo

Vendored and optional: nothing turns it on by default. Enable it for a session
with `/caveman full`, or for every session in your checkout with `bun run
agent-setup -- --caveman`, which writes `CAVEMAN_DEFAULT_MODE=full` into the
git-ignored `.claude/settings.local.json`. That variable is read by the
upstream plugin's `SessionStart` hook; without the plugin it is inert and
`/caveman` does the work.

Compression applies to prose addressed to a human in the terminal. It never
applies to anything persisted: code, comments, commit messages, PR bodies and
everything under `docs/` stay normal English. See the skill's own "Boundaries"
and "Auto-Clarity" sections.

## Subagent limits in this repo

`.claude/settings.json` sets two Claude Code env vars that bound delegation for
anyone who clones the repo:

| Var | Here | Stock | What it does |
|---|---|---|---|
| `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` | 3 | 3 | an agent at the limit is not offered the `Agent` tool; 3 allows dispatcher → task orchestrator → workers → one helper |
| `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` | 5 | 20 | further spawns are refused while 5 are running, counting an orchestrator and all its descendants |

`CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION` is deliberately unset: in 2.1.274 it appears only in env allowlists with no enforcement path, and the harness's refusal buckets are depth, concurrency and dollar budget only.

Values verified against Claude Code 2.1.274. They are ceilings for runaway
delegation, not targets — the reasoning, and the session-log measurements behind
the numbers, are in the orchestrator-mode skill's "Budgets" section. Raise them
for a session with `CLAUDE_CODE_MAX_… =N claude`, rather than editing the file,
unless the change should apply to everyone.

## Vendored from

<https://github.com/JuliusBrussee/caveman> — `plugins/caveman/`, commit
`15581d1`, MIT (`caveman/LICENSE`). Only the `caveman/` skill is vendored; the
upstream `cavecrew-*` subagents were dropped on 2026-09-21 (unused: built-in
`Explore`, `general-purpose` and `/code-review` cover them). Upstream splits its
license: `skills/` and `agents/` are MIT; the compression engine and Go binaries under `engine/`,
`proxy/`, `rewriter/`, `browse/`, `mcp/`, `shrink/` are BSL-1.1 and are **not**
vendored here. Only Markdown was copied — no engine code, no binaries, no hooks.

To refresh, re-copy the `caveman/` skill files from upstream and bump the commit
above. The files are unmodified, so a re-copy is a clean overwrite.

The optional local CLI (`npm i -g @caveman-ai/cli`, then `caveman setup
--install` and `caveman learn`) is a separate, per-developer install. It is not
required by anything here.
