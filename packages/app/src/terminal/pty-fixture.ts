/**
 * The fixture's terminal: a canned shell behind the `PtyLike` interface, with
 * no process anywhere (issue #18).
 *
 * Fixture mode never spawns a real process, so there is no `tailscale ssh` to
 * run. This answers in its place with the bytes a real login would print — a
 * prompt, local echo, and OSC 133 markers in the real grammar
 * (`SHELL_INTEGRATION_SCRIPT` in `@hermetic/core/shared`) — so the mirror,
 * the activity parser, the attention rules and the channel all run on the
 * fixture exactly as they do on a box.
 *
 * What it understands: `help`, `ls`, `whoami`, `hostname`, `uptime`,
 * `df -h /data`, `echo …`, `sleep N`, `printf '\a'`, `clear`, `exit [N]`.
 * Anything else is `command not found` with status 127. Line editing is
 * backspace, Ctrl-C and Ctrl-D on an empty line; keys typed while a command
 * runs are read after it, unless Ctrl-C interrupts it.
 */
import { SHELL_MARKER_OSC, SSH_LOGIN_USER } from "@hermetic/core/shared";
import type { PtyExit, PtyLike, PtySignal, PtySpawnOptions, PtySpawner } from "./pty.ts";
import { DataListeners } from "./pty.ts";
import type { TimerHandle, Timers } from "./timers.ts";
import { realTimers } from "./timers.ts";

const ESC = "\x1b";
const BEL = "\x07";
const encoder = new TextEncoder();

export interface FixturePtyOptions {
  /** The host the prompt names: `hermes@<host>:~$ `. */
  host: string;
  cols: number;
  rows: number;
  timers?: Timers;
  /** The shell-integration nonce. Defaults to a fixed fixture value. */
  nonce?: string;
  pid?: number;
}

let nextPid = 40_000;

/**
 * A spawner for fixture mode. The host is read off `argv`'s last element, the
 * `hermes@<host>` core's `ssh` returns, so the host calls this exactly as it
 * calls the real spawner.
 */
export function fixturePtySpawner(deps: { timers?: Timers } = {}): PtySpawner {
  return (argv: string[], opts: PtySpawnOptions) => {
    const target = argv[argv.length - 1] ?? "fixture";
    const host = target.includes("@") ? target.slice(target.indexOf("@") + 1) : target;
    return createFixturePty({ host, cols: opts.cols, rows: opts.rows, timers: deps.timers });
  };
}

export function createFixturePty(options: FixturePtyOptions): PtyLike {
  const timers = options.timers ?? realTimers;
  const nonce = options.nonce ?? "f1x7ure0n0nce";
  const host = options.host;
  const listeners = new DataListeners();
  const marker = (body: string): string => `${ESC}]${SHELL_MARKER_OSC};${body}${BEL}`;
  const prompt = (): string =>
    `${marker(`A;hermetic=1;n=${nonce};pre=1;jobs=0`)}${SSH_LOGIN_USER}@${host}:~$ `;

  let line = "";
  /** The running `sleep`, if any: its timer and how to finish it. */
  let busy: { timer: TimerHandle; finish(exit: number, echo: string): void } | null = null;
  let typeahead = "";
  let stopped = false;
  let held: string[] = [];
  let ended = false;
  let resolveExit: (exit: PtyExit) => void = () => {};
  const exited = new Promise<PtyExit>((resolve) => {
    resolveExit = resolve;
  });

  const emit = (text: string): void => {
    if (ended || text === "") return;
    // A stopped process prints nothing; what it would have printed comes out on SIGCONT.
    if (stopped) held.push(text);
    else listeners.emit(encoder.encode(text));
  };
  const end = (exit: PtyExit): void => {
    if (ended) return;
    if (busy !== null) timers.clearTimeout(busy.timer);
    busy = null;
    ended = true;
    resolveExit(exit);
  };
  /** A command line finished: the D marker, then the next prompt, as `PROMPT_COMMAND` prints them. */
  const finish = (exit: number): string => `${marker(`D;${exit};n=${nonce}`)}${prompt()}`;

  const run = (input: string): void => {
    const cmdline = input.trim();
    if (cmdline === "") {
      // Bash runs no command for an empty line: a prompt marker, no C or D.
      emit(`\r\n${prompt()}`);
      return;
    }
    const words = cmdline.split(/\s+/);
    const program = words[0] ?? "";
    // The integration reports the program and its first argument only.
    const cmd = words.length > 1 ? `${program} ${words[1]}` : program;
    let out = `\r\n${marker(`C;n=${nonce};cmd=${cmd}`)}`;
    const reply = canned(words, host);
    if (reply.kind === "exit") {
      emit(`${out}logout\r\n`);
      end({ code: reply.code, signal: null });
      return;
    }
    if (reply.kind === "sleep") {
      emit(out);
      const finishSleep = (exit: number, echo: string): void => {
        busy = null;
        emit(`${echo}${finish(exit)}`);
        // What was typed meanwhile is read now, as bash reads typeahead.
        const pending = typeahead;
        typeahead = "";
        type(pending);
      };
      busy = {
        timer: timers.setTimeout(() => finishSleep(0, ""), reply.ms),
        finish: finishSleep,
      };
      return;
    }
    out += reply.text;
    emit(`${out}${finish(reply.code)}`);
  };

  function type(text: string): void {
    for (const ch of text) {
      if (ended) return;
      if (busy !== null) {
        // A running `sleep` reads nothing: keys wait as typeahead. Ctrl-C
        // interrupts it with status 130 and, like a tty, discards them.
        if (ch === "\x03") {
          typeahead = "";
          timers.clearTimeout(busy.timer);
          busy.finish(130, "^C\r\n");
        } else typeahead += ch;
        continue;
      }
      if (ch === "\r" || ch === "\n") {
        const input = line;
        line = "";
        run(input);
      } else if (ch === "\x7f" || ch === "\b") {
        if (line.length > 0) {
          line = line.slice(0, -1);
          emit("\b \b");
        }
      } else if (ch === "\x03") {
        // Bash on Ctrl-C at a prompt: abandon the line, draw a fresh prompt.
        line = "";
        emit(`^C\r\n${prompt()}`);
      } else if (ch === "\x04") {
        if (line === "") {
          emit("logout\r\n");
          end({ code: 0, signal: null });
        }
      } else if (ch >= " " && ch !== "\x7f") {
        line += ch;
        emit(ch);
      }
    }
  }

  // The login: a banner, then the first prompt. Held until the host's first
  // `onData`, as a real PTY's first bytes would be.
  emit(
    `Welcome to Ubuntu 24.04 LTS (hermetic fixture)\r\n\r\n` +
      `This is a canned shell: nothing here runs. Type ${"`help`"}.\r\n\r\n${prompt()}`,
  );

  return {
    pid: options.pid ?? nextPid++,
    write(data) {
      type(typeof data === "string" ? data : new TextDecoder().decode(data));
    },
    resize() {
      // Nothing on screen depends on the size.
    },
    signalGroup(sig: PtySignal) {
      if (ended) return;
      if (sig === "SIGSTOP") stopped = true;
      else if (sig === "SIGCONT") {
        stopped = false;
        const release = held;
        held = [];
        for (const text of release) emit(text);
      } else end({ code: null, signal: sig });
    },
    close() {
      end({ code: null, signal: "SIGHUP" });
    },
    onData(cb) {
      listeners.add(cb);
    },
    exited,
  };
}

type Reply =
  | { kind: "text"; text: string; code: number }
  | { kind: "sleep"; ms: number }
  | { kind: "exit"; code: number };

const text = (lines: string[], code = 0): Reply => ({
  kind: "text",
  text: lines.map((l) => `${l}\r\n`).join(""),
  code,
});

/** What each canned command prints. */
function canned(words: string[], host: string): Reply {
  const [program = "", ...args] = words;
  const joined = args.join(" ");
  switch (program) {
    case "help":
      return text(["fixture shell: help ls whoami hostname uptime df echo sleep printf clear exit"]);
    case "ls":
      return text(["data  hermes  notes.md"]);
    case "whoami":
      return text([SSH_LOGIN_USER]);
    case "hostname":
      return text([host]);
    case "uptime":
      return text([" 12:00:00 up 3 days,  4:12,  1 user,  load average: 0.08, 0.03, 0.01"]);
    case "df":
      return text([
        "Filesystem      Size  Used Avail Use% Mounted on",
        "/dev/nvme1n1     20G  3.1G   16G  17% /data",
      ]);
    case "echo":
      return text([joined]);
    case "printf":
      // `printf '\a'` rings the bell; nothing else is interpreted.
      return /^(['"])\\a\1$/.test(joined) ? { kind: "text", text: BEL, code: 0 } : text([], 0);
    case "clear":
      return { kind: "text", text: `${ESC}[H${ESC}[2J${ESC}[3J`, code: 0 };
    case "sleep": {
      const seconds = Number(args[0]);
      if (!Number.isFinite(seconds) || seconds < 0) return text(["sleep: invalid time interval"], 1);
      return { kind: "sleep", ms: seconds * 1000 };
    }
    case "exit": {
      const code = args[0] === undefined ? 0 : Number(args[0]);
      return { kind: "exit", code: Number.isInteger(code) ? code & 0xff : 2 };
    }
    default:
      return text([`-bash: ${program}: command not found`], 127);
  }
}
