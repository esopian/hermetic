---
name: create-pr
description: Create a GitHub pull request for the current branch, with a body filled from .github/pull_request_template.md as a review guide. ALWAYS use this skill whenever a pull request is to be opened in this repo, never a bare `gh pr create`. Triggers include "open a PR", "create a PR", "make a PR", "raise/submit/send a PR", "put up a PR", "push and PR", "PR this", "ship it" or "/create-pr", a plan or workflow step that ends in opening a PR, and refreshing the body of this branch's existing PR.
disable-model-invocation: false
allowed-tools: Bash(git *), Bash(gh pr *), Bash(gh auth *), Bash(bun run check*), Bash(bun test *), Bash(mktemp*), Bash(rm *), Read, Glob, Grep, Write
argument-hint: [optional PR title or issue number] [--base <branch>]
---

# Create Pull Request

Open a pull request for the current branch with `gh`, its body a review guide built from
`.github/pull_request_template.md`. The repo squash-merges only, so the PR title becomes the commit
subject on `master` and the body is what a reviewer reads before the diff.

## Workflow

### 1. Read the current state

```bash
git branch --show-current
git status --short
git fetch origin <base>
git log origin/<base>..HEAD --oneline
git diff origin/<base>...HEAD --stat
gh pr view --json url,state 2>/dev/null
```

`<base>` is `master` unless the user passed `--base <branch>` (a stacked PR).

### 2. Check prerequisites

Stop and tell the user, rather than working around it, when:

- `gh auth status` fails.
- The current branch is `master` (or the base itself) — a feature branch is needed first.
- There are no commits ahead of `origin/<base>`.
- `git status --short` shows uncommitted or untracked changes — ask whether they belong in the PR.
  Never commit them unasked.
- `gh pr view` finds an open PR for this branch — offer to refresh its body with
  `gh pr edit --body-file <path>` instead of creating a second one.

### 3. Gather evidence

The body may only claim what actually happened. Collect it before writing:

- **Checks run.** Use results from this session for the current `HEAD`. If `bun run check` has not
  passed on `HEAD`, run it now and record the outcome — a failure is reported to the user and
  stops the PR unless they say to open it anyway, in which case the table shows ❌.
  `bun run ci` adds `build` and `audit:dependencies` (network); record either as skipped with a
  reason if not run.
- **Targeted tests.** The suites the change touches (`bun test packages/<pkg>`,
  `tests/parity.test.ts` for a surface change, seam tests in root `tests/` for a laptop↔box
  document).
- **Manual verification.** Fixture-mode runs, CLI output, real-fleet runs (`agent recreate`,
  `agent history`) — only those that happened, with the agent name where there was one.
- **Intent.** Issue numbers, the `docs/design.md` sections (`§N.N`) the change implements or edits,
  and any plan file the user named.

### 4. Write the title

Conventional commit, imperative, **≤50 characters** (it becomes the squash commit subject; see
CONTRIBUTING.md "Commit messages"): `type(scope): description`, scope optional — e.g.
`feat(cli): add agent recreate`, `fix: refuse create when SG has inbound rules`. Take type and
scope from the most significant commit. If the user gave a title, use it; if they gave an issue
number, link it in References (`Closes #N` when the PR resolves it).

### 5. Write the body

Read `.github/pull_request_template.md` and fill every section, in order:

- **🎯 TL;DR** — 1–2 outcome-focused sentences in an `> [!IMPORTANT]` callout.
- **🧭 How it works** — behavior-first bullets, `**Behavior** — implementation`. One or two for a
  small change; more only for distinct core behaviors. Name any `docs/design.md` section changed
  and why.
- **🔍 Review guide** — priority-ordered; each item names the path, what to look for, and a
  concrete risk. Favor the places a reviewer would miss: parity surface, import boundaries, the
  laptop↔box seam, secrets handling, state migrations.
- **✅ Acceptance tests** — a `Status | Check | Evidence` table of checks actually run (✅/❌), plus
  ⏭️ rows for relevant checks skipped, each with its reason.
- **⚠️ Risks & rollout** — risk level in a `[!NOTE]` callout, or `[!WARNING]` when an operator must
  act. Spell out the steps the change needs to take effect: `artifacts push` + `recreate` for
  `packages/agentd` or a `hermes_ref`/`chrome_ref` bump, `foundation update` for a
  `FOUNDATION_VERSION` bump, migration for a state-shape change.
- **🔗 References** — issue, design section, plan, incident; `None` when there is nothing.

Never invent results, risks, or links. Remove every instructional HTML comment and placeholder.
Keep it compact — formatting should make the body faster to scan, not longer. Write normal English
even when the session uses a compressed prose mode (AGENTS.md). End with the attribution line your
harness requires, if any.

### 6. Push and create the PR

Push if the branch has no upstream or is ahead of it — never force:

```bash
git push -u origin HEAD
```

Get a temporary path, write the body to that exact path with the file-writing tool, then pass the
literal path to `gh`. Never put body text in a heredoc, redirection, command substitution or inline
argument: bodies contain backticks, `$` and quotes that change shell parsing.

```bash
mktemp "${TMPDIR:-/tmp}/pr-body.XXXXXX"
gh pr create --base <base> --title "<title>" --body-file "<printed-temp-path>"
rm "<printed-temp-path>"
```

### 7. Report

Give the user the PR URL, the title, and anything left for them: checks that failed or were
skipped, rollout steps.

## Safety rules

- **Never force push**, and never push to `master`.
- **Base defaults to `master`**; `--base` overrides it for stacked PRs.
- **No secrets in the body** — no tokens, keys, `tskey-…` values or account-specific secrets, even
  from logs pasted as evidence (AGENTS.md, Conventions).
