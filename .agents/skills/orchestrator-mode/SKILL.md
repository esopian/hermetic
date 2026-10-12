---
name: orchestrator-mode
description: Coordinate Codex subagents in this repo when the user explicitly asks for orchestrator mode, delegation, or parallel agent work.
---

# Orchestrator mode for Codex

When the user enables orchestrator mode, keep it active for this session until they turn it off. Use Codex's available collaboration tools and concurrency limit. Do not assume Claude Code's `Agent` tool, model names, or `.claude/settings.json` limits apply.

The main session owns user communication, task scope, integration, verification, and the final report. Delegate bounded, independent work with clear file ownership and a concrete completion condition. Subagents share the worktree: check their status before integrating or committing, and review their actual diff. Keep work in the packages and files authorized by the user.

For token discipline, read section 6 of [the shared orchestrator guidance](../../../.claude/skills/orchestrator-mode/SKILL.md). Use graft for targeted code lookup when the optional toolchain is installed. Give subagents concise briefs and ask for conclusions and `file:line` references instead of file dumps.

If delegation is unavailable or refused, report that and continue directly where practical. Do not bypass a tool limit or user approval boundary.
