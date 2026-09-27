/**
 * Reading a secret from the operator (§8.3). A password prompt on a TTY, stdin
 * when piped — never a flag value, because `hermetic runs` records a command's
 * arguments in SQLite and a shell records them in its history.
 *
 * The value goes straight to core. `secretWasRead()` lets `main.ts` redact this
 * run's captured output as well, so the log is safe even if some future code
 * path echoes something it should not.
 */
import { isCancel, password } from "@clack/prompts";
import { HermeticError } from "@hermetic/core";
import { isInteractive } from "./io.ts";

let read = false;

export function secretWasRead(): boolean {
  return read;
}

export async function readSecret(prompt: string): Promise<string> {
  read = true;
  if (isInteractive()) {
    const value = await password({ message: prompt, output: process.stderr });
    if (isCancel(value)) throw new HermeticError("ABORTED", "cancelled at the secret prompt");
    return value;
  }
  // Trailing newlines are the pipe's, not the operator's. `\r` as well as `\n`
  // because `echo x | hermetic …` from a Windows shell, a CRLF here-doc or a
  // password copied out of a CRLF file all arrive with the carriage return
  // attached — and a secret that differs from the one that was typed by one
  // invisible byte fails at the login prompt with nothing to look at.
  return (await Bun.stdin.text()).replace(/[\r\n]+$/, "");
}

/**
 * The same read, but optional: an empty answer means "not now". `create` uses
 * it so an operator without the key to hand still gets an agent, with an empty
 * slot and an event saying how to fill it.
 */
export async function readOptionalSecret(prompt: string): Promise<string | undefined> {
  const value = await readSecret(prompt);
  return value.length === 0 ? undefined : value;
}
