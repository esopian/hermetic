/**
 * The shell integration an agent box installs and the marker grammar the
 * laptop's terminal reads back out of it (issue #18).
 *
 * The box sources `SHELL_INTEGRATION_SCRIPT` from `/etc/bash.bashrc` (hermeticd,
 * `packages/agentd/src/apply/shell.ts`), so every interactive bash — a
 * `tailscale ssh` login, a nested `bash`, `sudo -i` — emits OSC 133
 * semantic-prompt markers. The desktop app parses them out of the session's
 * output (`packages/app/src/terminal/activity.ts`) to tell "a command is
 * running" from "idle at a prompt", which is what the quit prompt and the
 * terminal notifications key on.
 *
 * Here, in `shared`, because the box writes the script and the laptop parses
 * what it prints: one module holds both halves so the grammar cannot drift.
 * `tests/shell-markers.test.ts` runs the real script under a local bash in a PTY
 * and feeds it through the real parser. Pure values and pure functions only
 * (`packages/core/test/shared-browser-safe.test.ts`).
 */
import { HERMES_ACCOUNT } from "./hermes.ts";

/** The OSC number the markers travel on (FinalTerm's semantic prompts). */
export const SHELL_MARKER_OSC = 133;

/**
 * Programs whose foreground run survives the ssh session hanging up — the
 * whole point of running them — so a session busy in one of them is not
 * "busy" for the quit prompt.
 */
export const DETACHABLE_PROGRAMS = ["tmux", "screen"] as const;

/**
 * One parsed marker.
 *
 * - `A`: a prompt was drawn. `pre` is `false` when the shell's DEBUG trap was
 *   replaced (the integration can no longer see commands start), `jobs` the
 *   number of background jobs that would die on hangup.
 * - `C`: a command line started. `cmd` is the program and its first argument
 *   only, never the whole line.
 * - `D`: that command line finished with `exit`.
 */
export interface ShellMarker {
  kind: "A" | "C" | "D";
  nonce?: string;
  pre?: boolean;
  jobs?: number;
  exit?: number;
  cmd?: string;
}

const CMD_FIELD = ";cmd=";

/**
 * Parses the payload of one OSC 133 sequence (the text between `ESC ] 133;`
 * and the terminator, i.e. `A;hermetic=1;n=…;pre=1;jobs=0`). Returns null for
 * anything that is not one of the three markers the integration emits.
 *
 * `cmd=` is always the last field and runs to the end of the string: a command
 * line may itself contain `;` and `n=`, so the fields are split only before it.
 * Splitting the whole payload let `echo a;n=forged` re-pin the nonce.
 */
export function parseShellMarker(data: string): ShellMarker | null {
  const at = data.indexOf(CMD_FIELD);
  const head = at === -1 ? data : data.slice(0, at);
  const [kind, ...fields] = head.split(";");
  if (kind !== "A" && kind !== "C" && kind !== "D") return null;
  const marker: ShellMarker = { kind };
  for (const [i, field] of fields.entries()) {
    const eq = field.indexOf("=");
    if (eq === -1) {
      // `D;<exit>;n=…`: the exit status is the one positional field.
      if (kind === "D" && i === 0 && /^\d{1,3}$/.test(field)) marker.exit = Number(field);
      continue;
    }
    const key = field.slice(0, eq);
    const value = field.slice(eq + 1);
    if (key === "n") marker.nonce = value;
    else if (key === "pre") marker.pre = value !== "0";
    else if (key === "jobs" && /^\d+$/.test(value)) marker.jobs = Number(value);
  }
  if (at !== -1) marker.cmd = data.slice(at + CMD_FIELD.length);
  return marker;
}

/** Wrappers whose second word is the program that actually runs. */
const WRAPPERS = new Set(["sudo", "time", "nice", "nohup"]);
/**
 * SPEC's `^[a-z0-9._+-]{1,32}$`, narrowed so the name cannot start with `-`:
 * a flag is never a program, and `mysql -phunter2` must not show its second
 * word, nor `sudo -u root apt` give `-u`.
 */
const PROGRAM_NAME_RE = /^[a-z0-9._+][a-z0-9._+-]{0,31}$/;

/**
 * The program name a command line may be shown and stored as: the first word,
 * or the second when the first is a wrapper (`sudo apt upgrade` → `apt`). Kept
 * only when it looks like a program name, so `export TOKEN=x` gives `export`
 * and a line starting with a secret gives null rather than the secret.
 */
export function sanitizeProgramName(cmd: string | null | undefined): string | null {
  if (cmd === null || cmd === undefined) return null;
  const words = cmd.trim().split(/\s+/);
  let word = words[0] ?? "";
  if (WRAPPERS.has(word) && words.length > 1) word = words[1] ?? "";
  return PROGRAM_NAME_RE.test(word) ? word : null;
}

/**
 * The login user `tailscale ssh` lands as on an agent box: the account Hermes
 * itself runs as, not the AMI's default `ubuntu`. The operator arrives in
 * Hermes's own home with `$HERMES_HOME` resolving, files they create are owned
 * by the account that will read them, and the agent `PATH` from
 * `/etc/profile.d/hermetic-agent.sh` applies. Root is one `sudo -i` away (the
 * account has passwordless sudo, §6.4), or `tailscale ssh root@<host>`, which
 * the managed ACL's `users` list permits.
 */
export const SSH_LOGIN_USER = HERMES_ACCOUNT;

/**
 * The bash an agent box sources from `/etc/bash.bashrc`.
 *
 * Markers, each terminated by BEL:
 *
 *     ESC]133;A;hermetic=1;n=<nonce>;pre=<0|1>;jobs=N   prompt shown; N jobs die on hangup
 *     ESC]133;C;n=<nonce>;cmd=<program arg1>            a command line started
 *     ESC]133;D;<exit>;n=<nonce>                         that command line finished
 *
 * Interactive bash only, loaded once per shell.
 */
export const SHELL_INTEGRATION_SCRIPT =
  String.raw`# hermetic shell integration: OSC 133 semantic-prompt markers.
#   ESC]133;A;hermetic=1;n=<nonce>;pre=<0|1>;jobs=N BEL  prompt shown; N jobs die on hangup
#   ESC]133;C;n=<nonce>;cmd=<program arg1> BEL           a command line started
#   ESC]133;D;<exit>;n=<nonce> BEL                        that command line finished
# Interactive bash only, loaded once per shell. Written by hermeticd; edits are overwritten.
[[ $- == *i* ]] || return 0
[[ -n ${"$"}{__hermetic_si:-} ]] && return 0
__hermetic_si=1
# One nonce per login, inherited by nested shells on this box (exported), never
# by a shell on another host. A marker without it is ignored by the laptop.
export HERMETIC_SI_NONCE=${"$"}{HERMETIC_SI_NONCE:-$(head -c 9 /dev/urandom | od -An -tx1 | tr -d " \n")}
__hermetic_at_prompt=0
__hermetic_ran=0
__hermetic_alive=1

__hermetic_precmd() {
  local ec=$?
  if [[ $__hermetic_ran == 1 ]]; then printf '\e]133;D;%s;n=%s\a' "$ec" "$HERMETIC_SI_NONCE"; fi
  __hermetic_ran=0
  local j; j=$(jobs -p | wc -l)
  # pre=0 when something replaced our DEBUG trap: the laptop then says
  # "unknown" rather than trusting a prompt it can no longer see past.
  # The trap fires for PROMPT_COMMAND itself, so a live trap always set the
  # heartbeat on the way here. (` +
  "`trap -p`" +
  String.raw` cannot be used: it runs in a subshell.)
  local pre=$__hermetic_alive; __hermetic_alive=0
  printf '\e]133;A;hermetic=1;n=%s;pre=%s;jobs=%s\a' "$HERMETIC_SI_NONCE" "$pre" "${"$"}{j//[[:space:]]/}"
  __hermetic_at_prompt=1
}

__hermetic_preexec() {
  # Heartbeat only from the trap firing for the prompt hook itself, so the
  # command that removes the trap cannot vouch for the prompt after it.
  [[ $BASH_COMMAND == __hermetic_precmd* ]] && __hermetic_alive=1
  [[ $__hermetic_at_prompt == 1 ]] || return 0
  [[ $BASH_COMMAND == __hermetic_* ]] && return 0
  __hermetic_at_prompt=0
  __hermetic_ran=1
  # Program and first argument only (` +
  "`apt upgrade`" +
  String.raw`), never the whole line:
  # a command line can carry a token, and this text reaches the laptop.
  local w1 w2 _r
  read -r w1 w2 _r <<<"${"$"}{BASH_COMMAND//[[:cntrl:]]/}"
  printf '\e]133;C;n=%s;cmd=%s\a' "$HERMETIC_SI_NONCE" "${"$"}{w1:0:60}${"$"}{w2:+ ${"$"}{w2:0:60}}"
}

trap '__hermetic_preexec' DEBUG
PROMPT_COMMAND="__hermetic_precmd${"$"}{PROMPT_COMMAND:+;$PROMPT_COMMAND}"
`;
