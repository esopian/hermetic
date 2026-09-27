#!/usr/bin/env bash
#
# One command that takes a fresh checkout — or a laptop that has drifted — to a
# state where `bun run ci` is green and an agent can work without stopping to
# ask a human for a tool, a permission prompt, or a cache warm-up.
#
#   bun run setup            check, then fix what is safely fixable
#   bun run setup -- --check report only, change nothing, exit 1 if anything is off
#   bun run setup -- --full  also warm the slow caches (uvx tools, hermeticd runtime)
#
# Every step is a function registered in one of three lists, so adding a step is
# adding a function and a name. Steps are independent: a failing optional step
# never stops the required ones.
set -uo pipefail

# Run from the repo root whether invoked from a subdirectory, a git worktree,
# or (no git at all) straight from scripts/.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(git -C "$ROOT" rev-parse --show-toplevel 2>/dev/null || echo "$ROOT")"
cd "$ROOT" || exit 2

MODE="fix"   # fix | check
FULL=0

for arg in "$@"; do
  case "$arg" in
    --check) MODE="check" ;;
    --fix) MODE="fix" ;;
    --full) FULL=1 ;;
    -h | --help)
      sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "dev-setup: unknown argument '$arg' (--check, --fix, --full)" >&2
      exit 2
      ;;
  esac
done

# ---------------------------------------------------------------- reporting --

if [ -t 1 ]; then
  BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; OFF=$'\033[0m'
else
  BOLD=""; RED=""; GREEN=""; YELLOW=""; DIM=""; OFF=""
fi

FAILURES=0
WARNINGS=0
SUMMARY=()

ok()   { SUMMARY+=("${GREEN}ok${OFF}      $1"); printf '  %sok%s      %s\n' "$GREEN" "$OFF" "$1"; }
fixed(){ SUMMARY+=("${GREEN}fixed${OFF}   $1"); printf '  %sfixed%s   %s\n' "$GREEN" "$OFF" "$1"; }
warn() { WARNINGS=$((WARNINGS + 1)); SUMMARY+=("${YELLOW}warn${OFF}    $1"); printf '  %swarn%s    %s\n' "$YELLOW" "$OFF" "$1"; }
fail() { FAILURES=$((FAILURES + 1)); SUMMARY+=("${RED}FAIL${OFF}    $1"); printf '  %sFAIL%s    %s\n' "$RED" "$OFF" "$1"; }
note() { printf '          %s%s%s\n' "$DIM" "$1" "$OFF"; }
section() { printf '\n%s%s%s\n' "$BOLD" "$1" "$OFF"; }

have() { command -v "$1" >/dev/null 2>&1; }
would_fix() { [ "$MODE" = "fix" ]; }

# ------------------------------------------------------------- required: SDK --

step_bun() {
  local want
  want="$(cat "$ROOT/.bun-version" 2>/dev/null || echo "")"
  if ! have bun; then
    fail "bun not installed (want $want)"
    note "install: curl -fsSL https://bun.sh/install | bash"
    return
  fi
  local got
  got="$(bun --version 2>/dev/null)"
  if [ "$got" = "$want" ]; then
    ok "bun $got matches .bun-version"
  else
    warn "bun $got, .bun-version pins $want — CI runs $want"
    note "align: bun upgrade --canary-or-stable, or 'bun upgrade --to $want'"
  fi
}

step_uv() {
  if have uvx; then
    ok "uvx present (lint:cfn, lint:sh)"
    return
  fi
  fail "uvx missing — bun run lint:cfn and lint:sh cannot run, so 'bun run check' fails"
  note "install: curl -LsSf https://astral.sh/uv/install.sh | sh"
}

step_install() {
  if [ -d "$ROOT/node_modules" ] && [ "$ROOT/bun.lock" -ot "$ROOT/node_modules" ]; then
    ok "node_modules up to date with bun.lock"
    return
  fi
  if ! would_fix; then
    warn "dependencies stale or missing (run bun install)"
    return
  fi
  if bun install >/dev/null 2>&1; then
    fixed "bun install"
  else
    fail "bun install failed — rerun it directly to see the error"
  fi
}

step_hooks() {
  local path
  path="$(git config --get core.hooksPath 2>/dev/null || echo "")"
  if [ "$path" = ".githooks" ]; then
    ok "git core.hooksPath = .githooks (pre-commit: biome --staged + bun run lint)"
    return
  fi
  if ! would_fix; then
    warn "core.hooksPath is '${path:-unset}', want .githooks"
    return
  fi
  git config core.hooksPath .githooks && fixed "core.hooksPath -> .githooks"
}

# --------------------------------------------------------- optional: real mode --

step_optional_tools() {
  local tool desc
  # Each entry: tool:why it matters:how to get it
  for entry in \
    "gh:GitHub CLI — PR review loops, finish-pr:brew install gh" \
    "aws:real-mode AWS calls (fixture mode needs none):brew install awscli" \
    "tailscale:§4.7 preflight for init --create:https://tailscale.com/download/mac" \
    "jq:JSON in setup + debug loops:brew install jq" \
    "rg:fast search for agents:brew install ripgrep"; do
    tool="${entry%%:*}"
    desc="${entry#*:}"
    desc="${desc%%:*}"
    if have "$tool"; then
      ok "$tool — $desc"
    else
      warn "$tool missing — $desc"
      note "install: ${entry##*:}"
    fi
  done
}

step_aws_profile() {
  if ! have aws; then
    return
  fi
  if [ -n "${AWS_PROFILE:-}" ]; then
    ok "AWS_PROFILE=$AWS_PROFILE"
  elif grep -q '^\[profile ' "$HOME/.aws/config" 2>/dev/null; then
    ok "AWS profiles configured in ~/.aws/config"
  else
    warn "no AWS profile — real mode unavailable; fixture mode unaffected"
  fi
}

# ------------------------------------------------------------ agentic patterns --

# A workspace-local HERMETIC_HOME keeps a dev portal's run log out of the real
# ~/.hermetic/hermetic.db, which is the one thing a fixture run must never touch.
step_workspace_home() {
  local home="$ROOT/.context/hermetic-home"
  if [ -d "$home" ]; then
    ok "workspace HERMETIC_HOME at .context/hermetic-home"
    return
  fi
  if ! would_fix; then
    warn ".context/hermetic-home missing (dev portals would use ~/.hermetic)"
    return
  fi
  mkdir -p "$home" && fixed "created .context/hermetic-home"
}

# Read-only commands an agent runs constantly. Pre-allowing them is the
# difference between an agent that finishes a task and one that stops on a
# permission prompt nobody is watching. Write/destructive commands stay out.
CLAUDE_ALLOW=(
  "Bash(bun run test:*)" "Bash(bun run typecheck)" "Bash(bun run lint)"
  "Bash(bun run lint:biome)" "Bash(bun run boundaries)"
  "Bash(bun run check)" "Bash(bun test:*)"
  "Bash(git status:*)" "Bash(git diff:*)" "Bash(git log:*)" "Bash(git show:*)"
  "Bash(rg:*)" "Bash(grep:*)" "Bash(ls:*)" "Bash(cat:*)" "Bash(sed -n:*)"
  "Bash(gh pr view:*)" "Bash(gh pr checks:*)" "Bash(gh run view:*)"
)

step_claude_permissions() {
  local file="$ROOT/.claude/settings.local.json"
  if [ -f "$file" ] && grep -qF '"Bash(bun test:*)"' "$file"; then
    ok "claude permission allowlist present (.claude/settings.local.json)"
    return
  fi
  if ! would_fix; then
    warn "no claude permission allowlist — agents will stall on read-only prompts"
    return
  fi
  local allow
  allow="[$(printf '%s\n' "${CLAUDE_ALLOW[@]}" | sed 's/.*/"&"/' | paste -sd, -)]"
  if [ -f "$file" ]; then
    # Existing file without this allowlist: add to it, never overwrite — it may
    # hold hooks, env, or permissions written by hand or by `bun run agent-setup`.
    if ! have jq; then
      warn "$file exists and jq missing — not merging by hand"
      return
    fi
    local tmp
    tmp="$(mktemp "$file.XXXXXX")" || { fail "cannot create temp file next to $file"; return; }
    if jq --argjson allow "$allow" '.permissions.allow = ((.permissions.allow // []) + $allow | unique)' "$file" > "$tmp"; then
      mv "$tmp" "$file" && fixed "merged read-only permission allowlist into .claude/settings.local.json"
    else
      rm -f "$tmp"
      fail "$file is not valid JSON — fix it by hand, then rerun"
    fi
    return
  fi
  mkdir -p "$(dirname "$file")"
  local body="{\"\$schema\":\"https://json.schemastore.org/claude-code-settings.json\",\"permissions\":{\"allow\":$allow}}"
  if have jq; then
    printf '%s' "$body" | jq . > "$file"
  else
    printf '%s\n' "$body" > "$file"
  fi
  fixed "wrote read-only permission allowlist to .claude/settings.local.json"
}

step_git_exclude() {
  local exclude
  exclude="$(git rev-parse --git-path info/exclude 2>/dev/null || echo "")"
  local want=".claude/settings.local.json"
  if [ -z "$exclude" ]; then
    warn "not a git checkout — keep $want out of commits yourself"
    return
  fi
  if [ -f "$exclude" ] && grep -qxF "$want" "$exclude"; then
    ok "$want excluded from git"
    return
  fi
  if ! would_fix; then
    warn "$want not excluded from git"
    return
  fi
  mkdir -p "$(dirname "$exclude")"
  touch "$exclude"
  printf '%s\n' "$want" >> "$exclude" && fixed "excluded $want from git"
}

# The optional agent toolchain (graft, rtk, caveman) has its own script and is
# never run from here: nothing in the build or tests needs it.
step_agent_toolchain() {
  note "optional: 'bun run agent-setup' installs graft and rtk for coding agents (CONTRIBUTING.md)"
}

# ------------------------------------------------------------------- warm-ups --

step_warm_lint_tools() {
  [ "$FULL" = "1" ] || { note "skipping tool warm-up (pass --full)"; return; }
  if ! have uvx; then
    warn "cannot warm cfn-lint/shellcheck without uvx"
    return
  fi
  if bun run lint:sh >/dev/null 2>&1 && bun run lint:cfn >/dev/null 2>&1; then
    ok "cfn-lint + shellcheck cached and passing"
  else
    warn "lint:cfn or lint:sh did not pass — run them directly for the output"
  fi
}

step_warm_agentd() {
  [ "$FULL" = "1" ] || return
  if [ -x "$ROOT/packages/agentd/dist/hermeticd" ]; then
    ok "hermeticd binary already built"
    return
  fi
  note "building hermeticd (first run downloads the linux-arm64 bun runtime)"
  if bun run --cwd packages/agentd build >/dev/null 2>&1; then
    fixed "built packages/agentd/dist/hermeticd"
  else
    warn "hermeticd build failed — run 'bun run --cwd packages/agentd build' for the output"
  fi
}

# ----------------------------------------------------------------------- run --

printf '%shermetic dev setup%s  %s(%s mode%s)%s\n' "$BOLD" "$OFF" "$DIM" "$MODE" "$([ "$FULL" = 1 ] && echo ", full")" "$OFF"

section "Toolchain"
step_bun
step_uv

section "Repository"
step_install
step_hooks

section "Optional tools"
step_optional_tools
step_aws_profile

section "Agent workflow"
step_workspace_home
step_claude_permissions
step_git_exclude

section "Agent toolchain (optional)"
step_agent_toolchain

section "Warm caches"
step_warm_lint_tools
step_warm_agentd

section "Summary"
printf '  %d failure(s), %d warning(s)\n' "$FAILURES" "$WARNINGS"
if [ "$FAILURES" -gt 0 ]; then
  printf '  %sfix the failures above, then rerun%s\n' "$RED" "$OFF"
  exit 1
fi
if [ "$MODE" = "check" ] && [ "$WARNINGS" -gt 0 ]; then
  exit 1
fi
printf '  next: %sbun run dev:fixture%s (inner loop) or %sbun run ci%s (pre-push gate)\n' "$BOLD" "$OFF" "$BOLD" "$OFF"
