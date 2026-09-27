/**
 * The CLI head as a library: the parity test imports `CLI_COMMANDS`, and tests
 * build the program without spawning a process. `src/main.ts` is the entrypoint.
 */
export { CLI_COMMANDS, COMMAND_NAMES, undeclaredMethods, type CliCommand } from "./registry.ts";
export { buildProgram } from "./program.ts";
export { EXIT_CODES, exitCodeFor, EXIT_ABORTED, EXIT_FAILURE, EXIT_VALIDATION } from "./exit-codes.ts";
export { headerLine } from "./io.ts";
export { renderPs, renderStatus, renderHistory, formatAge, formatHealth } from "./table.ts";
