#!/usr/bin/env bash
#
# Installs and wires the OPTIONAL agent toolchain for this checkout only, and is
# safe to rerun: every step checks before it changes anything, so "already done"
# is the common outcome. Nothing in the build, the tests or CI needs any of it.
#
#   bun run agent-setup                 install and wire graft and rtk
#   bun run agent-setup -- --caveman    also turn caveman full mode on for this checkout
#   bun run agent-setup -- --check      report only, change nothing, exit 1 if off
#
#   graft   — repo context graph (https://github.com/trailhq/Graft)
#   rtk     — shell output compressor (https://github.com/rtk-ai/rtk)
#   caveman — terse prose mode, vendored in .claude/skills/caveman/ (opt-in)
#
# Scope rule: nothing tracked by git and nothing outside this repository is
# configured. Every hook, env var and permission lands in the git-ignored
# .claude/settings.local.json; anything a tool writes into a tracked file is
# moved there and the tracked file restored, and the run fails if a tracked
# file is left modified. Both tools default to machine-wide agent config
# (~/.claude/settings.json, ~/.claude.json, ~/.codex/); every call passes the
# flag that suppresses that, and `step_no_global_leak` warns if one shows up
# anyway. The two binaries are the one exception — a CLI has to be installed
# somewhere — and they change no agent's behaviour until a repo wires them in.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(git -C "$ROOT" rev-parse --show-toplevel 2>/dev/null || echo "$ROOT")"
cd "$ROOT" || exit 2

MODE="fix"
CAVEMAN=0
for arg in "$@"; do
  case "$arg" in
    --check) MODE="check" ;;
    --fix) MODE="fix" ;;
    --caveman) CAVEMAN=1 ;;
    -h | --help)
      sed -n '2,23p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "agent-setup: unknown argument '$arg' (--check, --fix, --caveman)" >&2
      exit 2
      ;;
  esac
done

# ~/.local/bin holds rtk (and claude itself); npm's global bin holds graft.
export PATH="$HOME/.local/bin:$PATH"

if [ -t 1 ]; then
  BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; OFF=$'\033[0m'
else
  BOLD=""; RED=""; GREEN=""; YELLOW=""; DIM=""; OFF=""
fi

FAILURES=0
WARNINGS=0
ok()    { printf '  %sok%s      %s\n' "$GREEN" "$OFF" "$1"; }
fixed() { printf '  %sfixed%s   %s\n' "$GREEN" "$OFF" "$1"; }
warn()  { WARNINGS=$((WARNINGS + 1)); printf '  %swarn%s    %s\n' "$YELLOW" "$OFF" "$1"; }
fail()  { FAILURES=$((FAILURES + 1)); printf '  %sFAIL%s    %s\n' "$RED" "$OFF" "$1"; }
note()  { printf '          %s%s%s\n' "$DIM" "$1" "$OFF"; }
section() { printf '\n%s%s%s\n' "$BOLD" "$1" "$OFF"; }
have() { command -v "$1" >/dev/null 2>&1; }
would_fix() { [ "$MODE" = "fix" ]; }

CLAUDE_HOME="$HOME/.claude"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
OPENCODE_HOME="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"

SETTINGS=".claude/settings.json"         # tracked: tool-neutral only
LOCAL_SETTINGS=".claude/settings.local.json" # git-ignored: every tool's wiring
# What marks a line of settings as belonging to one of these tools.
TOOL_MARKS='graft-hooks|graft-statusline|rtk hook|CAVEMAN_'

# ------------------------------------------------------- settings helpers --

# One small program for every JSON edit, run by bun (always present in this
# repo) rather than jq (optional). Subcommands:
#   relocate <pre> <post> <local>  move whatever <post> adds over <pre> into <local>
#   env <local> <KEY> <VALUE>      set env.KEY in <local>
#   hook <local> <EVENT> <MATCHER> <COMMAND>  add a command hook to <local>
#   mcp-opencode <file>            register graft's MCP server in opencode.json
# Every write merges into what is there; nothing is replaced wholesale.
SETTINGS_JS='
const fs = require("node:fs");
const [cmd, ...a] = process.argv.slice(1);
const read = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) {
  if (e.code === "ENOENT") return {}; throw new Error(`${p} is not valid JSON`); } };
const write = (p, v) => fs.writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);
const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
const has = (xs, y) => (xs ?? []).some((x) => same(x, y));
const owner = (h) => { const s = JSON.stringify(h);
  return s.includes("graft-hooks") ? "graft" : s.includes("rtk hook") ? "rtk" : null; };
// New entries replace the same tool'"'"'s older ones, so a tool that renames a
// hook between versions converges instead of stacking.
const addAll = (xs, ys) => {
  const owners = new Set(ys.map(owner).filter(Boolean));
  const kept = (xs ?? []).filter((x) => !owners.has(owner(x)));
  return ys.reduce((acc, y) => (has(acc, y) ? acc : [...acc, y]), kept);
};
const schema = "https://json.schemastore.org/claude-code-settings.json";
if (cmd === "relocate") {
  const [pre, post, file] = [read(a[0]), read(a[1]), read(a[2])];
  const out = { $schema: schema, ...file };
  const moved = [];
  for (const [k, v] of Object.entries(post.env ?? {})) {
    if ((pre.env ?? {})[k] !== v) { out.env = { ...(out.env ?? {}), [k]: v }; moved.push(`env.${k}`); }
  }
  for (const [ev, list] of Object.entries(post.hooks ?? {})) {
    const add = (list ?? []).filter((h) => !has(pre.hooks?.[ev], h));
    if (add.length) { out.hooks = { ...(out.hooks ?? {}), [ev]: addAll(out.hooks?.[ev], add) }; moved.push(`hooks.${ev}`); }
  }
  const allow = (post.permissions?.allow ?? []).filter((p) => !has(pre.permissions?.allow, p));
  if (allow.length) {
    out.permissions = { ...(out.permissions ?? {}), allow: addAll(out.permissions?.allow, allow) };
    moved.push("permissions.allow");
  }
  for (const [k, v] of Object.entries(post)) {
    if (["$schema", "env", "hooks", "permissions"].includes(k) || v === null || same(v, pre[k])) continue;
    out[k] = Array.isArray(v) ? addAll(out[k], v.filter((x) => !has(pre[k], x))) : v;
    moved.push(k);
  }
  write(a[2], out);
  console.log(moved.join(", "));
} else if (cmd === "env") {
  const out = { $schema: schema, ...read(a[0]) };
  out.env = { ...(out.env ?? {}), [a[1]]: a[2] };
  write(a[0], out);
} else if (cmd === "hook") {
  const out = { $schema: schema, ...read(a[0]) };
  const entry = { matcher: a[2], hooks: [{ type: "command", command: a[3] }] };
  out.hooks = { ...(out.hooks ?? {}), [a[1]]: addAll(out.hooks?.[a[1]], [entry]) };
  write(a[0], out);
} else if (cmd === "mcp-opencode") {
  const out = read(a[0]);
  out.mcp = { ...(out.mcp ?? {}), graft: { type: "local", command: ["graft", "mcp"], enabled: true } };
  write(a[0], out);
} else {
  throw new Error(`unknown subcommand ${cmd}`);
}
'
settings_js() { bun -e "$SETTINGS_JS" "$@"; }

# Tracked files modified before this run started — the guard at the end only
# blames this run for files it newly dirtied.
tracked_dirty() { git status --porcelain --untracked-files=no 2>/dev/null | cut -c4- | sort; }
DIRTY_BEFORE="$(tracked_dirty)"
CLAUDE_MD_BEFORE=0
[ -e "$ROOT/CLAUDE.md" ] && CLAUDE_MD_BEFORE=1

is_modified() { ! git diff --quiet -- "$1" 2>/dev/null; }

# Move whatever a tool wrote into tracked .claude/settings.json over to
# settings.local.json, then restore the tracked file from the index. Only runs
# when the edit carries one of the tools' marks; a hand edit is left alone.
relocate_tracked_settings() {
  is_modified "$SETTINGS" || return 0
  if ! grep -Eq "$TOOL_MARKS" "$SETTINGS"; then
    warn "$SETTINGS has uncommitted edits that are not tool wiring — left alone"
    return 0
  fi
  local pre moved
  pre="$(mktemp)"
  git show ":$SETTINGS" > "$pre" 2>/dev/null || echo '{}' > "$pre"
  if moved="$(settings_js relocate "$pre" "$SETTINGS" "$LOCAL_SETTINGS")"; then
    git checkout -- "$SETTINGS"
    fixed "moved ${moved:-tool wiring} from $SETTINGS to $LOCAL_SETTINGS"
  else
    fail "could not merge into $LOCAL_SETTINGS — fix it by hand, then rerun"
  fi
  rm -f "$pre"
}

# AGENTS.md is the repo's, not a tool's. graft owns a fenced section in it when
# wired for AGENTS.md readers, and removes that section when un-wiring them; this
# repo writes its own graft lines instead. A change made during this run is
# undone from the index; on a file you were already editing, only graft's
# section is dropped.
restore_agents_md() {
  is_modified AGENTS.md || return 0
  if ! printf '%s\n' "$DIRTY_BEFORE" | grep -qxF AGENTS.md; then
    git checkout -- AGENTS.md && fixed "restored AGENTS.md (a tool had edited it)"
    return 0
  fi
  grep -q "graft:start" AGENTS.md || return 0
  awk '/<!-- graft:start -->/{skip=1} !skip{print} /<!-- graft:end -->/{skip=0}' AGENTS.md > AGENTS.md.tmp &&
    mv AGENTS.md.tmp AGENTS.md && fixed "removed graft's generated section from AGENTS.md"
}

# Neither tool is asked to write CLAUDE.md, but if one does, it is removed:
# AGENTS.md is the one instruction file. A CLAUDE.md that was already there
# (tracked, or your own) is never touched.
remove_generated_claude_md() {
  [ "$CLAUDE_MD_BEFORE" = 0 ] && [ -e "$ROOT/CLAUDE.md" ] || return 0
  git ls-files --error-unmatch CLAUDE.md >/dev/null 2>&1 && return 0
  rm -f "$ROOT/CLAUDE.md" && fixed "removed a generated CLAUDE.md (AGENTS.md is the instruction file)"
}

# ------------------------------------------------------------------- graft --

GRAFT_PKG="@nanonets/graft"

step_graft_install() {
  if have graft; then
    ok "graft $(graft --version 2>/dev/null) installed"
    return
  fi
  if ! have npm; then
    warn "graft needs npm (node) and npm is not on PATH — skipping graft"
    return
  fi
  if ! would_fix; then
    warn "graft not installed (npm install -g $GRAFT_PKG)"
    return
  fi
  # graft compiles tree-sitter grammars. On a Mac where `xcode-select` points at
  # an Xcode.app whose licence was never accepted, every native build fails with
  # "You have not agreed to the Xcode license agreements" — and accepting it
  # needs sudo. Pointing DEVELOPER_DIR at the Command Line Tools avoids the
  # question entirely, so try that before asking anyone for a password.
  if npm install -g "$GRAFT_PKG" > /tmp/agent-setup-graft.log 2>&1; then
    fixed "installed graft"
    return
  fi
  if [ -d /Library/Developer/CommandLineTools ] &&
    grep -q "Xcode license" /tmp/agent-setup-graft.log 2>/dev/null; then
    note "Xcode licence unaccepted — retrying against the Command Line Tools"
    if DEVELOPER_DIR=/Library/Developer/CommandLineTools \
      npm install -g "$GRAFT_PKG" > /tmp/agent-setup-graft.log 2>&1; then
      fixed "installed graft (built with the Command Line Tools toolchain)"
      return
    fi
  fi
  fail "graft install failed — see /tmp/agent-setup-graft.log"
}

# --no-global: without it graft also writes ~/.claude/settings.json hooks,
# ~/.claude.json and ~/.codex/. --no-statusline leaves whatever statusline you
# already use alone. --no-agents wires the Claude Code layer only (skill, hook
# shims, .mcp.json, and hook blocks in .claude/settings.json, which are moved to
# settings.local.json below) — the other hosts' wiring is a fenced section in
# the tracked AGENTS.md, and AGENTS.md carries its own graft lines instead.
# Nothing here asks graft for a CLAUDE.md. --no-build: step_graft_graph builds.
#
# The flags are recorded in graft/.cache/wiring-stamp.json and replayed: after
# a graft upgrade, its SessionStart hook and its MCP server both re-run this
# wiring once (graft has no switch to turn that off), which puts the hook blocks
# back into the tracked settings.json. `--check` reports that; rerunning
# `bun run agent-setup` moves them out again.
GRAFT_INIT_FLAGS=(--yes --no-global --no-statusline --no-agents --no-build)

graft_wired() {
  [ -f "$ROOT/.claude/skills/graft/SKILL.md" ] && [ -f "$ROOT/.claude/helpers/graft-hooks.cjs" ] &&
    grep -q '"graft"' "$ROOT/.mcp.json" 2>/dev/null &&
    grep -q "graft-hooks" "$ROOT/$LOCAL_SETTINGS" 2>/dev/null
}

step_graft_wire() {
  have graft || return
  if graft_wired; then
    ok "graft wired in this checkout (skill, hooks, MCP; settings.local.json)"
    return
  fi
  if ! would_fix; then
    warn "graft not wired into this checkout (graft init ${GRAFT_INIT_FLAGS[*]})"
    return
  fi
  # The relocation below reads the index copy as "before", so a hand edit to
  # either tracked file would be swept along with graft's. Refuse instead.
  local f
  for f in "$SETTINGS" AGENTS.md; do
    if is_modified "$f" && ! grep -Eq "$TOOL_MARKS|graft:start" "$f"; then
      fail "$f has uncommitted edits — commit or stash them, then rerun"
      return
    fi
  done
  if graft init "${GRAFT_INIT_FLAGS[@]}" > /tmp/agent-setup-graft-init.log 2>&1; then
    fixed "graft init — skill, hook shims, MCP (repo only)"
    relocate_tracked_settings
    restore_agents_md
    remove_generated_claude_md
  else
    fail "graft init failed — see /tmp/agent-setup-graft-init.log"
  fi
}

# opencode reads MCP servers from opencode.json. graft only writes it as part
# of the AGENTS.md host, which --no-agents skips, so register it here.
step_graft_opencode() {
  have graft || return
  if grep -q '"graft"' "$ROOT/opencode.json" 2>/dev/null; then
    ok "graft MCP server in opencode.json"
  elif ! would_fix; then
    warn "graft MCP server not in opencode.json"
  elif settings_js mcp-opencode "$ROOT/opencode.json"; then
    fixed "registered graft's MCP server in opencode.json"
  else
    fail "opencode.json is not valid JSON — fix it by hand, then rerun"
  fi
}

step_graft_graph() {
  have graft || return
  if [ ! -f "$ROOT/graft/INDEX.md" ]; then
    if ! would_fix; then
      warn "no graph in graft/ (run 'graft build')"
      return
    fi
    if graft build > /tmp/agent-setup-graft-build.log 2>&1; then
      fixed "built the graph (graft build)"
    else
      fail "graft build failed — see /tmp/agent-setup-graft-build.log"
    fi
    return
  fi
  ok "graph present in graft/"
  note "refresh after big changes: graft build"
}

# --------------------------------------------------------------------- rtk --

step_rtk_install() {
  if have rtk; then
    ok "rtk $(rtk --version 2>/dev/null | awk '{print $2}') installed"
    return
  fi
  if ! would_fix; then
    warn "rtk not installed"
    return
  fi
  # The upstream installer verifies the release's SHA-256 against checksums.txt,
  # rejects archives with traversal paths, and installs to ~/.local/bin — no
  # compiler, no sudo, and no agent config touched.
  local script="/tmp/agent-setup-rtk-install.sh"
  if ! curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh -o "$script"; then
    fail "could not download the rtk installer"
    return
  fi
  if sh "$script" > /tmp/agent-setup-rtk.log 2>&1; then
    fixed "installed rtk to ~/.local/bin"
  else
    fail "rtk install failed — see /tmp/agent-setup-rtk.log"
  fi
}

# rtk's own `rtk init` would write RTK.md and an @RTK.md line into an
# instruction file; this repo keeps the rtk notes in CONTRIBUTING.md instead,
# so the only wiring is a Claude Code PreToolUse hook in settings.local.json.
step_rtk_wire() {
  have rtk || return
  if grep -q "rtk hook claude" "$LOCAL_SETTINGS" 2>/dev/null; then
    ok "rtk PreToolUse hook in $LOCAL_SETTINGS"
    return
  fi
  if ! would_fix; then
    warn "no rtk hook in $LOCAL_SETTINGS"
    return
  fi
  mkdir -p "$(dirname "$LOCAL_SETTINGS")"
  if settings_js hook "$LOCAL_SETTINGS" PreToolUse Bash "rtk hook claude"; then
    fixed "added the rtk PreToolUse hook to $LOCAL_SETTINGS"
  else
    fail "$LOCAL_SETTINGS is not valid JSON — fix it by hand, then rerun"
  fi
}

# rtk filters command output, which is the point — and occasionally the problem.
# The escape hatches only help an agent that knows they exist, so they are
# documented in CONTRIBUTING.md and this step keeps that section honest.
step_rtk_bypass_docs() {
  have rtk || return
  if grep -q "rtk proxy" "$ROOT/CONTRIBUTING.md" 2>/dev/null; then
    ok "rtk bypass documented in CONTRIBUTING.md"
  else
    warn "CONTRIBUTING.md has no rtk bypass notes — agents will not know how to see raw output"
  fi
}

# ----------------------------------------------------------------- caveman --

# Opt-in. The skill is vendored in .claude/skills/caveman/ and `/caveman full`
# turns it on for one session; --caveman pins it for this checkout through the
# env var the upstream plugin's SessionStart hook reads.
step_caveman() {
  if grep -q '"CAVEMAN_DEFAULT_MODE"' "$LOCAL_SETTINGS" 2>/dev/null; then
    ok "caveman default mode set in $LOCAL_SETTINGS"
    return
  fi
  if [ "$CAVEMAN" = 0 ]; then
    note "caveman off (opt in with --caveman, or /caveman full per session)"
    return
  fi
  if ! would_fix; then
    warn "caveman default mode not set in $LOCAL_SETTINGS"
    return
  fi
  mkdir -p "$(dirname "$LOCAL_SETTINGS")"
  if settings_js env "$LOCAL_SETTINGS" CAVEMAN_DEFAULT_MODE full; then
    fixed "set CAVEMAN_DEFAULT_MODE=full in $LOCAL_SETTINGS"
  else
    fail "$LOCAL_SETTINGS is not valid JSON — fix it by hand, then rerun"
  fi
}

# ------------------------------------------------ cross-agent availability --

step_agent_availability() {
  local a
  for a in claude codex opencode; do
    if have "$a"; then
      ok "$a on PATH"
    else
      note "$a not installed — its in-repo wiring is inert until it is"
    fi
  done
}

# ------------------------------------------------------------------- scope --

# Tool wiring that reached a tracked file after setup: graft's post-upgrade
# rewiring (see GRAFT_INIT_FLAGS) or a tool run by hand.
step_tracked_clean() {
  local drift=0
  if is_modified "$SETTINGS" && grep -Eq "$TOOL_MARKS" "$SETTINGS"; then drift=1; fi
  if is_modified AGENTS.md && grep -q "graft:start" AGENTS.md; then drift=1; fi
  if [ "$CLAUDE_MD_BEFORE" = 0 ] && [ -e CLAUDE.md ]; then drift=1; fi
  if [ "$drift" = 0 ]; then
    ok "no tool wiring in tracked files"
    return
  fi
  if ! would_fix; then
    warn "tool wiring in a tracked file ($SETTINGS or AGENTS.md) — run 'bun run agent-setup'"
    return
  fi
  relocate_tracked_settings
  restore_agents_md
  remove_generated_claude_md
}

# The guard for the "nothing tracked" half of the scope rule.
step_no_tracked_change() {
  local after new
  after="$(tracked_dirty)"
  new="$(comm -13 <(printf '%s\n' "$DIRTY_BEFORE") <(printf '%s\n' "$after") | sed '/^$/d')"
  if [ -z "$new" ]; then
    ok "no tracked file modified by this run"
    return
  fi
  fail "tracked file(s) modified by this run — restore them with git checkout -- <file>:"
  printf '%s\n' "$new" | while read -r f; do note "$f"; done
}

# The guard for the "nothing outside this repository" half. Each check names a
# machine-wide entry these tools write when their --no-global/-g flags are not
# used; finding one means a global install happened, here or by hand.
step_no_global_leak() {
  local leaked=0
  check() {
    local label="$1" path="$2" pattern="${3:-}"
    [ -e "$path" ] || return 0
    if [ -z "$pattern" ] || grep -q "$pattern" "$path" 2>/dev/null; then
      warn "machine-wide: $label ($path)"
      leaked=$((leaked + 1))
    fi
  }
  check "graft claude hooks" "$CLAUDE_HOME/settings.json" "graft-hooks"
  check "graft hook shim" "$CLAUDE_HOME/helpers/graft-hooks.cjs"
  check "graft MCP server" "$HOME/.claude.json" '"graft"'
  check "graft codex MCP" "$CODEX_HOME/config.toml" "mcp_servers.graft"
  check "graft codex hooks" "$CODEX_HOME/hooks.json" "graft"
  check "rtk claude hook" "$CLAUDE_HOME/settings.json" "rtk hook"
  check "rtk instructions" "$CLAUDE_HOME/RTK.md"
  check "rtk codex instructions" "$CODEX_HOME/RTK.md"
  check "rtk opencode plugin" "$OPENCODE_HOME/plugins/rtk.ts"
  if [ "$leaked" = 0 ]; then
    ok "no machine-wide agent config from these tools"
    return
  fi
  note "remove with: graft uninstall -y   /   rtk init -g --uninstall   (add --codex, --opencode)"
}

# ----------------------------------------------------------------------- run --

printf '%sagent toolchain setup%s  %s(%s mode, this checkout only)%s\n' "$BOLD" "$OFF" "$DIM" "$MODE" "$OFF"

section "graft — repo context graph"
step_graft_install
step_graft_wire
step_graft_opencode
step_graft_graph

section "rtk — output compression"
step_rtk_install
step_rtk_wire
step_rtk_bypass_docs

section "caveman — opt-in terse prose"
step_caveman

section "cross-agent availability"
step_agent_availability

section "scope"
step_tracked_clean
step_no_tracked_change
step_no_global_leak

section "Summary"
printf '  %d failure(s), %d warning(s)\n' "$FAILURES" "$WARNINGS"
if [ "$FAILURES" -gt 0 ]; then
  exit 1
fi
if [ "$MODE" = "check" ] && [ "$WARNINGS" -gt 0 ]; then
  exit 1
fi
printf '  restart the agent to pick up new hooks and MCP servers\n'
