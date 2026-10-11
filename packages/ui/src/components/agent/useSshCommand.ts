/**
 * `hermetic ssh <name>`'s command, for Copy (issue #18).
 *
 * Core's own argv (`ssh`), so the string an operator pastes is the one the CLI
 * would run — and the phase-1 fallback: it needs no PTY, no terminal host and
 * no Tailscale on this Mac. Until the answer lands (or when the head refuses
 * it) the command is spelled from the hostname the drawer already shows,
 * which is the same argv core builds (`SSH_LOGIN_USER`, §9.3).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { SSH_LOGIN_USER } from "@hermetic/core/shared";
import { sshCommand } from "../../api/terminal.ts";

/** One argv element as a shell would need it typed; plain words stay bare. */
export function shellWord(word: string): string {
  return /^[A-Za-z0-9@%+=:,./_-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

export function commandOf(argv: readonly string[]): string {
  return argv.map(shellWord).join(" ");
}

export function useSshCommand(
  name: string,
  host: string,
): { command: string; copied: boolean; copy: () => void } {
  const [argv, setArgv] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let live = true;
    setArgv(null);
    sshCommand(name).then(
      (answer) => {
        if (live && Array.isArray(answer) && answer.length > 0) setArgv(answer);
      },
      () => {
        // The spelled-out fallback below stands in.
      },
    );
    return () => {
      live = false;
    };
  }, [name]);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const command = commandOf(argv ?? ["tailscale", "ssh", `${SSH_LOGIN_USER}@${host}`]);
  const copy = useCallback(() => {
    const done = () => {
      setCopied(true);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    };
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    navigator.clipboard.writeText(command).then(done, () => {});
  }, [command]);

  return { command, copied, copy };
}
