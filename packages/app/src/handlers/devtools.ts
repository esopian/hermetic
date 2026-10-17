/**
 * The developer tools' requests (§9.2 "Developer tools"): this laptop's stream
 * inspector settings, the capture's facts, a tap on one conversation, and the
 * capture's clear and masked export.
 *
 * ## Machinery, not declared methods
 *
 * None of these wraps a `PUBLIC_METHOD`. `hermetic.devtools` sits outside the
 * §9 command surface and has no CLI verb, so the requests are declared with
 * `declareMachineryRpc` and land in `MACHINERY_RPC` (`declare.ts`), where the
 * parity contract accounts for them.
 *
 * ## The gate
 *
 * `devtools.settings` always answers: it is how the tools are turned on. The
 * other five refuse `DEVTOOLS_DISABLED` while the tools are off, checked here
 * against core's own preference before anything else happens, so a request from
 * a page that has not caught up with a switch flipped in another window is
 * refused rather than served. Core refuses the same way underneath; checking
 * here as well is what makes a tap refuse *as a request* instead of opening a
 * stream that ends at once.
 *
 * ## Why no request schemas
 *
 * Core validates every input against its own schemas
 * (`packages/core/src/schema/devtools.ts`) and throws `VALIDATION`, the
 * `fixture.chat.*` arrangement (`handlers/fixture.ts`): a second copy here
 * would be a second thing to keep in step with nothing holding the two
 * together. A tap is opened synchronously, before its stream is named, so an
 * input core refuses on the call refuses the request too.
 *
 * ## The push
 *
 * A tap's records are coalesced: whatever arrives within `TAP_FLUSH_MS` of the
 * first unsent record goes out as one `devtools.record` push carrying an array,
 * and a backlog of thousands is cut into `TAP_BATCH_MAX`-record pushes. A
 * streaming turn emits a delta every few milliseconds, and one bridge message
 * per wire message would cost the page a render each.
 *
 * Nothing here logs. A record is box content — a prompt, a tool's output, a
 * token the box echoed — and `app.log` is a file on the laptop; only a failed
 * request is logged, by the binding, and what it writes is core's own message.
 */
import { HermeticError } from "@hermetic/core";
import type { Hermetic, TapRecord } from "@hermetic/core";
import { declareMachineryRpc } from "../declare.ts";
import { parseInput } from "../validation.ts";
import type { HandlerContext } from "./ctx.ts";
import type { Handler } from "./dispatch.ts";
import { StreamRefRequest, requireSink } from "./streams.ts";
import type { StreamSink } from "./streams.ts";

/** What these handlers read: the instance getter and the stream registry. */
export type DevtoolsContext = Pick<HandlerContext, "hermetic" | "streams">;

export const DEVTOOLS_SETTINGS = declareMachineryRpc("devtools.settings");
export const DEVTOOLS_STATS = declareMachineryRpc("devtools.stats");
export const DEVTOOLS_TAP = declareMachineryRpc("devtools.tap");
export const DEVTOOLS_UNTAP = declareMachineryRpc("devtools.untap");
export const DEVTOOLS_CLEAR = declareMachineryRpc("devtools.clear");
export const DEVTOOLS_EXPORT = declareMachineryRpc("devtools.export");

/** How long a tap holds records before pushing them: one frame at 60 Hz. */
export const TAP_FLUSH_MS = 16;
/** The most records one push carries; a larger backlog goes out in several. */
export const TAP_BATCH_MAX = 500;

/** The event name a batch of records is sunk under. */
export const TAP_RECORDS_EVENT = "records";

type Devtools = Hermetic["devtools"];

function devtoolsOf({ hermetic }: Pick<HandlerContext, "hermetic">): Devtools {
  return hermetic().devtools;
}

/**
 * The tools are on, or the request is refused. Read from core each time rather
 * than cached here: the preference is a `prefs` row the CLI on this laptop can
 * change too.
 */
async function requireEnabled(devtools: Devtools): Promise<void> {
  const settings = await devtools.settings({});
  if (!settings.enabled) {
    throw new HermeticError(
      "DEVTOOLS_DISABLED",
      "developer tools are off — turn them on in Settings › Developer",
    );
  }
}

/** `devtools.settings`: an empty request reads, a stated field writes. Never gated. */
export async function settings(ctx: DevtoolsContext, params: unknown) {
  return await devtoolsOf(ctx).settings(params ?? {});
}

export async function stats(ctx: DevtoolsContext, params: unknown) {
  void params;
  const devtools = devtoolsOf(ctx);
  await requireEnabled(devtools);
  return await devtools.stats();
}

export async function clear(ctx: DevtoolsContext, params: unknown) {
  const devtools = devtoolsOf(ctx);
  await requireEnabled(devtools);
  return await devtools.clear(params ?? {});
}

/** Always masked, whatever Chat › Redact secrets says: core's guarantee, not this head's. */
export async function exportCapture(ctx: DevtoolsContext, params: unknown) {
  const devtools = devtoolsOf(ctx);
  await requireEnabled(devtools);
  return await devtools.export(params);
}

/**
 * One conversation's capture: its backlog, then every record after it, until
 * the page sends `devtools.untap` or the window goes away.
 *
 * A source that ends on its own — the tools switched off, the capture cleared
 * out from under it — ends with a `done` carrying the reason when there is
 * one, and with the binding's `STREAM_ENDED` when there is not
 * (`rpc/bind.ts`), so the page's reader is never left waiting.
 */
export async function tap(
  ctx: DevtoolsContext,
  params: unknown,
  sink: StreamSink,
): Promise<{ stream_id: string }> {
  const devtools = devtoolsOf(ctx);
  await requireEnabled(devtools);
  const controller = new AbortController();
  // Called here, not inside the pump: an input core refuses eagerly is a
  // refused request rather than a stream that ends at once.
  const source = devtools.tap(params as Parameters<Devtools["tap"]>[0], {
    signal: controller.signal,
  });
  let batch: TapRecord[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (batch.length === 0) return;
    const out = batch;
    batch = [];
    void sink({ event: TAP_RECORDS_EVENT, data: out });
  };
  const done = (async () => {
    try {
      for await (const record of source) {
        if (controller.signal.aborted) break;
        batch.push(record);
        if (batch.length >= TAP_BATCH_MAX) flush();
        else if (timer === null) timer = setTimeout(flush, TAP_FLUSH_MS);
      }
      if (!controller.signal.aborted) flush();
    } catch (e) {
      // `done` never rejects (`streams.ts`). A reader that hung up wants
      // nothing more; one whose source failed is told why, by code.
      if (!controller.signal.aborted) {
        flush();
        const code = e instanceof HermeticError ? e.code : "INTERNAL";
        const message = e instanceof HermeticError ? e.message : "the capture ended";
        void sink({ event: "done", data: { ok: false, error: { code, message } } });
      }
    } finally {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      batch = [];
    }
  })();
  const stream_id = ctx.streams.open({ close: () => controller.abort(), done });
  void done.then(() => {
    ctx.streams.close(stream_id);
  });
  return { stream_id };
}

/** The close half of `devtools.tap`. Closing a tap that already ended answers `false`. */
export async function untap(ctx: DevtoolsContext, params: unknown): Promise<{ closed: boolean }> {
  const { stream_id } = parseInput(StreamRefRequest, params);
  return { closed: ctx.streams.close(stream_id) };
}

/** This module's contribution to the dispatch table (`dispatch.ts`). */
export const devtoolsHandlers = {
  [DEVTOOLS_SETTINGS]: settings,
  [DEVTOOLS_STATS]: stats,
  [DEVTOOLS_TAP]: (ctx: HandlerContext, params: unknown, sink?: StreamSink) =>
    tap(ctx, params, requireSink(sink)),
  [DEVTOOLS_UNTAP]: untap,
  [DEVTOOLS_CLEAR]: clear,
  [DEVTOOLS_EXPORT]: exportCapture,
} satisfies Record<string, Handler>;
