/**
 * `hermeticd` — the node agent's entry point. Argument parsing is by hand: this
 * binary has a handful of subcommands and ships to every instance in the fleet,
 * so it carries no CLI framework. (Commander is the laptop's business, §3.4.)
 *
 *   hermeticd bootstrap --install           write and start the oneshot unit (§6.3)
 *   hermeticd bootstrap                     the staged boot runner (§6.3)
 *   hermeticd stage secret --slot s --out p  SSM → a 0600 file on tmpfs
 *   hermeticd stage disk-prepare --mount m   wait, blank-check, mkfs, mount, fstab
 *   hermeticd stage fetch-config --out p     S3 → the validated agent manifest
 *   hermeticd stage verify-hermes            provider, model and key are on the box
 *   hermeticd apply [--manifest p] [--dry-run]
 *   hermeticd update [--check] [--force]    nightly self-update (§6.5)
 *   hermeticd serve                         heartbeat + nightly update + RPC (§6.4)
 *   hermeticd heartbeat --once
 *   hermeticd secrets materialise --out p [--mode 0600]
 *   hermeticd version
 *
 * The `stage …` subcommands exist because the bootstrap stages are bash and
 * bash is the wrong language for anything that can destroy data, touch AWS or
 * hold a secret (§6.3). A stage orchestrates; these do the work.
 *
 * Exit codes: 0 ok, 1 error, 3 manifest refused.
 */
import { exitCodeFor } from "./errors.ts";
import { run } from "./cli.ts";
import { fatalMessage } from "./context.ts";

/**
 * Re-exported from `version.ts`, where it moved so that `apply.ts` can name the
 * version in a diagnostic without importing the CLI entrypoint.
 */
export { HERMETICD_VERSION } from "./version.ts";

// The pieces of the old single-file `main.ts`, re-exported so that `index.ts`,
// the tests and `tests/seams.test.ts` keep importing them from here.
export {
  SECRET_SLOTS,
  SECRET_SLOT_USAGE,
  assertTmpfs,
  isKnownSlot,
  parseArgv,
  run,
  writeSecretFile,
} from "./cli.ts";
export type { Argv, SecretSlot } from "./cli.ts";
export { bootContext, context, fatalMessage, log, stderrEmit } from "./context.ts";
export type { Context, RunDeps } from "./context.ts";
export {
  BUSY_UNIT_STATES,
  CONVERGE_POLL_MS,
  IDLE_UNIT_STATES,
  UPDATE_POLL_MS,
  bootstrapUnitActive,
  bootstrapUnitBusy,
  convergeLoop,
  maybeUpdate,
  runConvergeLoop,
  runUpdateLoop,
  runningBinarySha256,
  serve,
  updateTick,
} from "./daemon.ts";
export type { ConvergeLoopDeps, UnitBusy, UpdateLoopDeps, UpdateTickOutcome } from "./daemon.ts";

// `makeRpcHandler` is exported for tests and for anything that wants the handler
// without binding a socket.
export { makeRpcHandler } from "./rpc.ts";

if (import.meta.main) {
  try {
    process.exit(await run(process.argv.slice(2)));
  } catch (e) {
    process.stderr.write(fatalMessage(e));
    process.exit(exitCodeFor(e));
  }
}
