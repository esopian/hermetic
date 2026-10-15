/**
 * The files service, assembled: the index loaded, the tailnet routes, the
 * plugin socket's handler and the sweeper, all over one `FilesCtx`.
 *
 * `daemon.ts` builds one of these at start, hands `tailnet` to the RPC
 * listener, binds `socket` with `serveFilesSocket`, and runs `sweepLoop`
 * beside the heartbeat.
 */
import { type FilesSettings, resolveFilesSettings } from "@hermetic/core/shared";
import type { Aws } from "../aws.ts";
import type { Host } from "../host.ts";
import { type FilesCtx, type FilesDeps, realDelay } from "./context.ts";
import { errorText } from "./errors.ts";
import { type FilesTailnetHandler, makeFilesTailnetHandler } from "./routes.ts";
import { materialiseAllFileSecrets, materialiseFileSecret, removeFileSecret } from "./secrets.ts";
import {
  type FilesSocketHandler,
  type UnixListen,
  bunUnixListen,
  makeFilesSocketHandler,
  serveFilesSocket,
} from "./socket.ts";
import { loadFilesIndex, makeFilesStore } from "./store.ts";
import { sweepLoop, sweepOnce, type SweepReport } from "./sweeper.ts";

export interface FilesService {
  readonly ctx: FilesCtx;
  readonly tailnet: FilesTailnetHandler;
  readonly socket: FilesSocketHandler;
  sweep(): Promise<SweepReport>;
  sweepLoop(signal: AbortSignal): Promise<void>;
}

const DEFAULT_SETTINGS = resolveFilesSettings(null);
const defaultSettings = (): FilesSettings => DEFAULT_SETTINGS;

export async function makeFilesService(deps: FilesDeps): Promise<FilesService> {
  const log = deps.log ?? (() => {});
  const index = await loadFilesIndex(deps.host, log);
  const ctx: FilesCtx = {
    ...deps,
    log,
    delay: deps.delay ?? realDelay,
    settings: deps.settings ?? defaultSettings,
    store: makeFilesStore(deps.host, index),
  };
  return {
    ctx,
    tailnet: makeFilesTailnetHandler(ctx),
    socket: makeFilesSocketHandler(ctx),
    sweep: () => sweepOnce(ctx),
    sweepLoop: (signal) => sweepLoop(ctx, signal),
  };
}

export interface StartFilesDeps {
  readonly host: Host;
  readonly aws: Aws;
  /** This agent's own SSM prefix (`Context.paramPrefix`). */
  readonly paramPrefix: string;
  readonly name: string;
  readonly hermeticdVersion: string;
  readonly log: (message: string) => void;
  /** The socket binder; `Bun.serve({ unix })` unless a test says otherwise. */
  readonly listen?: UnixListen;
  /** The fleet's files settings now in force (`settings.ts`); the defaults when absent. */
  readonly settings?: () => FilesSettings;
}

export interface StartedFiles {
  /** For the RPC listener; absent when the service could not start. */
  readonly tailnet?: FilesTailnetHandler;
  /** The sweeper, until `signal` aborts. Never rejects. */
  run(signal: AbortSignal): Promise<void>;
}

/**
 * Everything `hermeticd serve` does for files at start, each part best
 * effort: a box whose files service cannot start still heartbeats, converges
 * and serves logs — it just reports no `files` capability, and the laptop
 * hides the attach button.
 *
 *  - durable secrets re-materialised from SSM (in the background: SSM being
 *    slow must not hold up the listener);
 *  - the index loaded and the service built;
 *  - the plugin socket bound.
 */
export async function startFiles(deps: StartFilesDeps): Promise<StartedFiles> {
  const { host, aws, paramPrefix, log } = deps;
  void materialiseAllFileSecrets({ host, aws, paramPrefix, log }).then(
    (secrets) => {
      if (secrets.length > 0) log(`files: materialised ${secrets.length} durable secret(s)`);
    },
    (e: unknown) => log(`files: could not materialise durable secrets: ${errorText(e)}`),
  );

  let service: FilesService;
  try {
    service = await makeFilesService({
      host,
      name: deps.name,
      hermeticdVersion: deps.hermeticdVersion,
      log,
      materialiseSecret: (slot, expectName, check) =>
        materialiseFileSecret({ host, aws, paramPrefix, log }, slot, expectName, check),
      removeSecret: (name) => removeFileSecret(host, name),
      ...(deps.settings ? { settings: deps.settings } : {}),
    });
  } catch (e) {
    log(`files: the service did not start: ${errorText(e)}`);
    return {
      run: (signal) =>
        new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
    };
  }
  try {
    await serveFilesSocket(host, service.socket, deps.listen ?? bunUnixListen);
  } catch (e) {
    log(`files: could not bind the plugin socket: ${errorText(e)}`);
  }
  return { tailnet: service.tailnet, run: (signal) => service.sweepLoop(signal) };
}
