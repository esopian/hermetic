## 🎯 TL;DR

<!--
Lead with 1-2 sentences: what problem this solves and what outcome changes.
Emphasize it as a GitHub callout:

> [!IMPORTANT]
> Outcome-focused summary.
-->

## 🧭 How it works

<!--
Give a behavior-first overview, not a file list or commit log. Use only 1-2
bullets for a small change; add bullets only when distinct core behaviors need
explanation.

Format: - **Behavior** — how it is implemented.

If this changes docs/design.md, say which section and why: the spec defines
what "correct" means for the whole suite (CONTRIBUTING.md).
-->

## 🔍 Review guide

<!--
Order review stops from highest to lowest value. Each item tells the reviewer
where to look, what to verify, and the concrete risk. Use as many items as the
change warrants; one is enough for a routine PR.

1. **Area or decision** — `packages/core/src/…`
   - **Look for:** behavior or invariant to verify
   - **Risk:** concrete failure mode
-->

## ✅ Acceptance tests

<!--
Record only checks actually performed during development. Include exact
commands or manual scenarios and observed results. Mark anything not run with
its reason; never describe planned testing as completed. Use a table:

| Status | Check | Evidence |
| :----: | ----- | -------- |
|   ✅   | `bun run check` | Passed on HEAD |
|   ✅   | `bun test tests/parity.test.ts` | Passed; new `agents.foo` command and handler agree |
|   ✅   | `agent recreate lisbon` on a real fleet | Box reached `ready`; `agent history` clean |
|   ⏭️   | `bun run audit:dependencies` | Not run; offline, no dependency changes |
-->

## ⚠️ Risks & rollout

<!--
State Low / Medium / High risk, then cover anything an operator must do for the
change to take effect, plus compatibility and rollback when relevant. Common
cases in this repo:

- packages/agentd changed → `hermetic artifacts push`, then `agent create`/`recreate`
- `BUILD_VERSIONS.hermes_ref`/`chrome_ref` bumped → `artifacts push`, then `recreate`
- `FOUNDATION_VERSION` bumped → `hermetic foundation update` (and any `FOUNDATION_MIGRATIONS` entry)
- Local SQLite or DynamoDB state shape changed → how existing homes and fleets migrate
- Public method added/renamed (parity surface) → CLI and app both change

Use a GitHub callout:

> [!NOTE]
> **Risk: Low** — No special rollout steps.

Use [!WARNING] instead when reviewers or operators must act.
-->

## 🔗 References

<!--
Link the issue, docs/design.md section (§N.N), plan, incident, or other source
of intent. Write "None" when there is nothing to link.
-->
