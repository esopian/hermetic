/**
 * Every byte the CLI writes goes through here, so `--json` can keep stdout to
 * exactly one JSON document and push everything else — headers, warnings,
 * spinners, progress — onto stderr (§4.7).
 */
import { detectEnvCredentialOverrides, headerLine as coreHeaderLine } from "@hermetic/core";
import type { LocalConfig } from "@hermetic/core";

export interface GlobalFlags {
  json: boolean;
  fixture: boolean;
  yes: boolean;
  /**
   * §4.8: which frozen fleet the command is about — `--fleet <name>`, else
   * `HERMETIC_FLEET`, else `null`. Null is not "the default fleet": it is "the
   * operator named none", and core's selection rule is the only thing allowed
   * to turn that into a name.
   */
  fleet: string | null;
  /** `--fleet` alone, before the environment is folded in (§4.8). */
  fleetFlag: string | null;
}

/**
 * Everything the command rendered, for the local `runs` log (§4.6). Capped, so a
 * command that streams thousands of log lines does not put all of them in
 * SQLite. Only rendered output goes through here — a secret value is read from a
 * prompt or stdin and never written, so nothing secret can reach the log (§8.3).
 */
const TRANSCRIPT_LIMIT = 64 * 1024;
let transcript = "";

function record(text: string): void {
  if (transcript.length >= TRANSCRIPT_LIMIT) return;
  transcript += text.slice(0, TRANSCRIPT_LIMIT - transcript.length);
}

export function capturedOutput(): string {
  return transcript;
}

export async function out(text: string): Promise<void> {
  record(text);
  await Bun.write(Bun.stdout, text);
}

export async function err(text: string): Promise<void> {
  record(text);
  await Bun.write(Bun.stderr, text);
}

export async function outJson(value: unknown): Promise<void> {
  await out(`${JSON.stringify(value, null, 2)}\n`);
}

/** Interactive prompts and spinners are only legal when stderr is a terminal. */
export function isInteractive(): boolean {
  return Boolean(process.stderr.isTTY) && process.env["HERMETIC_NO_TTY"] !== "1";
}

/**
 * `▸ acme-prod · 123456789012 · us-east-1 · profile acme-prod` (§4.7). Core owns
 * the format so the CLI, the server and the UI cannot drift apart on it.
 */
export function headerLine(config: LocalConfig, fixture: boolean): string {
  return coreHeaderLine(config, { fixture });
}

/**
 * §4.7: `aws.client()` pins the frozen profile, so exported credentials are
 * ignored — silently, unless someone says so. Core does the reading (the CLI is
 * not allowed to touch the credential environment) and the head prints.
 */
export async function warnCredentialOverrides(): Promise<void> {
  const overrides = detectEnvCredentialOverrides();
  if (overrides.length === 0) return;
  await err(
    `warning: ${overrides.join(", ")} set in the environment and ignored; hermetic uses the frozen profile\n`,
  );
}
