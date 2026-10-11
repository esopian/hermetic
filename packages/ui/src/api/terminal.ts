/**
 * The in-app terminal's door (issue #18): the app main process owns the
 * sessions (`app/src/terminal/host.ts`), so every name here is machinery
 * rather than a core method — except `ssh`, which is core's own argv and what
 * Copy and the cold panel show.
 *
 * Requests go through the transport seam like everything else. The three
 * hot-path messages (keystrokes, acks, the view state) do not: they are
 * fire-and-forget page → main messages with no transport verb, sent the way
 * `page.ready` is (`sendTerminalMessage`).
 */
import type { HermeticRPC } from "@hermetic/app";
import { sendTerminalMessage } from "./transport-rpc.ts";
import { transport, type StreamFrame, type TransportFailure } from "./transport.ts";
import type { BridgeResult } from "./types.ts";

export type TerminalOpened = BridgeResult<"terminal.open">;
export type TerminalListing = BridgeResult<"terminal.list">;
export type TerminalSessionView = TerminalListing["sessions"][number];
export type TerminalActivity = TerminalSessionView["activity"];
export type TerminalExit = NonNullable<TerminalSessionView["exit"]>;
/** One frame of an attach, as the app pushes it (`terminal/channel.ts`). */
export type TerminalFrame = HermeticRPC["webview"]["messages"]["terminal.frame"]["frame"];

/** Opens a session on `name` at the size the pane can show. Refusals carry the preflight codes. */
export function terminalOpen(name: string, cols: number, rows: number): Promise<TerminalOpened> {
  return transport().request<TerminalOpened>("terminal.open", { name, cols, rows });
}

/** Every session the app holds, or one agent's. `alerts` is `terminal_alerts`. */
export function terminalList(name?: string): Promise<TerminalListing> {
  return transport().request<TerminalListing>("terminal.list", name === undefined ? {} : { name });
}

export function terminalResize(session_id: string, cols: number, rows: number): Promise<unknown> {
  return transport().request("terminal.resize", { session_id, cols, rows });
}

/** Ends a session (hangs it up if live) and drops it from the table; resolves after its exit. */
export function terminalClose(session_id: string): Promise<{ closed: boolean }> {
  return transport().request<{ closed: boolean }>("terminal.close", { session_id });
}

/** "Open in Terminal ↗": the same command in the operator's own terminal app. `UNSUPPORTED` in fixture mode. */
export function terminalExternal(name: string): Promise<{ opened: true }> {
  return transport().request<{ opened: true }>("terminal.external", { name });
}

/** Core's argv for `hermetic ssh <name>`. Works with no PTY at all, which is the phase-1 fallback. */
export async function sshCommand(name: string): Promise<string[]> {
  const answer = await transport().request<{ argv: string[] }>("ssh", { name });
  return answer.argv;
}

/**
 * One attach, frame by frame. Returns the detach. `onOpen` hands back the
 * attach's `stream_id`, which is what an ack names.
 */
export function terminalAttach(
  session_id: string,
  handlers: {
    onOpen: (streamId: string) => void;
    onFrame: (frame: TerminalFrame) => void;
    onEnd: (failure: TransportFailure | null) => void;
  },
): () => void {
  return transport().openStream(
    "terminal.attach",
    { session_id },
    {
      onOpen: handlers.onOpen,
      onFrame: (frame: StreamFrame) => {
        // The transport renamed `{ event, data }` to a seam frame and back is all
        // this is; the union is the app's (`TerminalFrame`), checked by its event.
        handlers.onFrame({ event: frame.event, data: frame.data } as TerminalFrame);
      },
      onEnd: (_ok, failure) => handlers.onEnd(failure),
    },
  );
}

/** Keystrokes: exactly one of `data` (text) or `binary` (base64), at most 16 KiB. */
export function sendTerminalInput(
  payload: { session_id: string; in_seq: number } & ({ data: string } | { binary: string }),
): boolean {
  return sendTerminalMessage("terminal.input", payload);
}

export function sendTerminalAck(stream_id: string, gen: number, upto: number): boolean {
  return sendTerminalMessage("terminal.ack", { stream_id, gen, upto });
}

export function sendTerminalView(session_id: string | null): boolean {
  return sendTerminalMessage("terminal.view", { session_id });
}
