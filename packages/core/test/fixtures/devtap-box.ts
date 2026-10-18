/**
 * A box for the developer tools' adapter tests: a socket that answers every
 * request at once and pushes recorded frames behind `prompt.submit`, and a
 * turn driven through the real `createHermesChat` with a `DevTap` behind it.
 */
import { createHermesChat } from "../../src/chat/hermes/hermes-chat.ts";
import type { BoxAddress, ChatSocket, HermesChatDeps } from "../../src/chat/hermes/hermes-chat.ts";
import { DevTap } from "../../src/chat/devtap.ts";
import type { ChatFrame, DevtoolsConversation, TapRecord } from "../../src/schema/index.ts";
import {
  DASHBOARD_HTML,
  PROMPT_SUBMIT_RESULT,
  SESSION_CREATE_RESULT,
  STORED_SESSION_ID,
} from "./hermes-frames.ts";

export const DEVTAP_BOX: BoxAddress = {
  instance: "veronica",
  baseUrl: "https://fxtr0001-veronica.tail0000.ts.net/",
  fleet_id: "fxtr0001",
};
const NOW = "2026-09-16T19:48:41.000Z";
/** Where a turn on `DEVTAP_BOX` that created its session is filed. */
export const DEVTAP_CONVERSATION: DevtoolsConversation = {
  instance: DEVTAP_BOX.instance,
  bot: "default",
  session: STORED_SESSION_ID,
};

/** A socket that answers every request at once and pushes `after[method]` behind the reply. */
export function devtapDeps(
  after: Record<string, readonly string[]>,
  devtap: () => DevTap | null,
): HermesChatDeps {
  const openSocket = (): ChatSocket => {
    const buffered: string[] = [];
    let closed = false;
    let wake: (() => void) | null = null;
    const bump = (): void => {
      const w = wake;
      wake = null;
      w?.();
    };
    const push = (line: string): void => {
      buffered.push(line);
      bump();
    };
    return {
      opened: Promise.resolve(),
      frames: (async function* () {
        for (;;) {
          const next = buffered.shift();
          if (next !== undefined) {
            yield next;
            continue;
          }
          if (closed) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      })(),
      send(data: string) {
        const doc = JSON.parse(data) as { id: number; method: string };
        const result =
          doc.method === "session.create"
            ? SESSION_CREATE_RESULT
            : doc.method === "prompt.submit"
              ? PROMPT_SUBMIT_RESULT
              : {};
        push(JSON.stringify({ jsonrpc: "2.0", id: doc.id, result }));
        for (const line of after[doc.method] ?? []) push(line);
      },
      close() {
        closed = true;
        bump();
      },
    };
  };
  return {
    fetch: () => Promise.resolve(new Response(DASHBOARD_HTML, { status: 200 })),
    openSocket,
    now: () => NOW,
    slotWaitMs: 200,
    devtap,
  };
}

export async function devtapTurn(
  frames: readonly string[],
  opts: { redact?: boolean; tap?: DevTap | null } = {},
): Promise<{ tap: DevTap | null; frames: ChatFrame[]; records: TapRecord[] }> {
  const tap =
    opts.tap === undefined
      ? new DevTap({ capture: "always", keep: 1000, redact: () => opts.redact ?? false })
      : opts.tap;
  const client = createHermesChat(devtapDeps({ "prompt.submit": frames }, () => tap));
  const out: ChatFrame[] = [];
  for await (const frame of client.send(DEVTAP_BOX, "default", "hi")) out.push(frame);
  const records = tap === null ? [] : await devtapBacklog(tap, DEVTAP_CONVERSATION);
  return { tap, frames: out, records };
}

/** Everything a tap holds for one conversation right now. */
export async function devtapBacklog(
  tap: DevTap,
  conversation: DevtoolsConversation,
): Promise<TapRecord[]> {
  const controller = new AbortController();
  // Upserted by id: a record whose fate settles after delivery is delivered again.
  const seen = new Map<string, TapRecord>();
  const reading = (async () => {
    for await (const record of tap.subscribe(conversation, controller.signal))
      seen.set(record.id, record);
  })();
  await new Promise((done) => setTimeout(done, 5));
  controller.abort();
  await reading;
  return [...seen.values()];
}
