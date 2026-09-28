/**
 * The CLI's output, captured rather than printed.
 *
 * `hermeticd` writes straight to `process.stdout` and `process.stderr` — boot
 * progress, `apply`'s JSON result, one verdict per `verify-hermes` check, the
 * daemon's own log lines — because on a box that is the journal. A suite that
 * drives those commands would otherwise fill the run's output with lines that
 * look like failures and are the expected behaviour of the test that caused
 * them.
 *
 * Call it inside a `describe` (or at the top of a file) to capture for every
 * test in that scope. Each test starts with empty buffers, and the real
 * writers are put back after it. A spy a test installs on top of this one
 * saves and restores whatever it found, so it keeps working unchanged.
 */
import { afterEach, beforeEach } from "bun:test";

export interface CapturedOutput {
  readonly stdout: string;
  readonly stderr: string;
}

export function captureOutput(): CapturedOutput {
  const state = { stdout: "", stderr: "" };
  let nativeOut: typeof process.stdout.write;
  let nativeErr: typeof process.stderr.write;
  const decode = (chunk: string | Uint8Array): string =>
    typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);

  beforeEach(() => {
    state.stdout = "";
    state.stderr = "";
    nativeOut = process.stdout.write;
    nativeErr = process.stderr.write;
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      state.stdout += decode(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      state.stderr += decode(chunk);
      return true;
    }) as typeof process.stderr.write;
  });
  afterEach(() => {
    process.stdout.write = nativeOut;
    process.stderr.write = nativeErr;
  });

  return {
    get stdout() {
      return state.stdout;
    },
    get stderr() {
      return state.stderr;
    },
  };
}
