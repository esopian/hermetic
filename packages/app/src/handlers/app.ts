/**
 * The requests only a desktop head can answer: what this build is, opening a
 * URL in the operator's browser, the updater, the `hermetic` shim on `PATH`,
 * and a native notification.
 *
 * None of them reads core. What they need — `Utils.openExternal`, the updater,
 * the shim writer, the notification centre — comes from the main process, and
 * arrives as `ctx.native` (`ctx.ts`), which `main/index.ts` is the only thing
 * that builds. A head without one answers `UNSUPPORTED`: the HTTP head is a
 * process with no window, no menu and no notification centre, so "this head
 * cannot do that" is the true answer rather than a missing feature, and it is
 * the same refusal these five gave before there was a desktop head at all.
 *
 * The names exist in both heads either way, because a name the page can call
 * has to be a name `dispatch` knows and a name `dispatch` knows has to be
 * declared — `tests/parity.test.ts` asserts both halves against each other.
 */
import { HermeticError } from "@hermetic/core";
import { z } from "zod";
import { declareMachineryRpc } from "../declare.ts";
import { externalUrl } from "../external-url.ts";
import { parseInput } from "../validation.ts";
import type { HandlerContext, NativeDeps } from "./ctx.ts";
import type { Handler } from "./dispatch.ts";

export const APP_INFO = declareMachineryRpc("app.info");
export const APP_OPEN_EXTERNAL = declareMachineryRpc("app.openExternal");
export const APP_CHECK_FOR_UPDATE = declareMachineryRpc("app.checkForUpdate");
export const APP_INSTALL_CLI = declareMachineryRpc("app.installCli");
export const APP_NOTIFY = declareMachineryRpc("app.notify");

/**
 * `UNSUPPORTED` rather than `NOT_FOUND`: the request name is real and the head
 * this page is talking to cannot answer it, which is exactly what the code
 * means everywhere else in the tree (`requireSink`, the fixture guard).
 */
function requireNative(ctx: HandlerContext, name: string): NativeDeps {
  if (ctx.native === undefined) {
    throw new HermeticError("UNSUPPORTED", `${name} is answered by the desktop head`);
  }
  return ctx.native;
}

/**
 * A URL the operator's browser is allowed to be handed. The shape is checked
 * here; what may be opened is `externalUrl`'s rule (`external-url.ts`), shared
 * with the main window's navigation guard and the updater.
 */
export const AppOpenExternalRequest = z.object({ url: z.string().min(1) });

export const AppNotifyRequest = z.object({
  title: z.string().min(1),
  /**
   * Allowed to be empty, unlike the title. Plenty of the page's banners are a
   * headline and nothing else ("corvid finished"), and refusing those would
   * drop the notification entirely rather than showing a shorter one — a rule
   * the operator would experience as banners that silently stop arriving.
   */
  body: z.string(),
  /** Replaces an earlier banner carrying the same tag, as the web API does. */
  tag: z.string().optional(),
});

export async function info(ctx: HandlerContext): Promise<ReturnType<NativeDeps["info"]>> {
  return requireNative(ctx, APP_INFO).info();
}

export async function openExternal(ctx: HandlerContext, params: unknown): Promise<{ opened: true }> {
  const native = requireNative(ctx, APP_OPEN_EXTERNAL);
  const { url } = parseInput(AppOpenExternalRequest, params);
  native.openExternal(externalUrl(url));
  return { opened: true };
}

export async function checkForUpdate(ctx: HandlerContext): Promise<{ checked: true }> {
  // The updater reports what it found by pushing `app.update` at every window
  // (`main/updates.ts`), so there is nothing to answer here but "it ran" — and
  // a check that is skipped, because an op is running or the channel is `dev`,
  // is still a check that ran.
  await requireNative(ctx, APP_CHECK_FOR_UPDATE).checkForUpdate();
  return { checked: true };
}

export async function installCli(ctx: HandlerContext): Promise<{ path: string; elevated: boolean }> {
  return await requireNative(ctx, APP_INSTALL_CLI).installCli();
}

export async function notify(
  ctx: HandlerContext,
  params: unknown,
): Promise<ReturnType<NativeDeps["notify"]>> {
  const native = requireNative(ctx, APP_NOTIFY);
  const { title, body, tag } = parseInput(AppNotifyRequest, params);
  return native.notify(tag === undefined ? { title, body } : { title, body, tag });
}

/** This module's contribution to the dispatch table (`dispatch.ts`). */
export const appHandlers = {
  [APP_INFO]: info,
  [APP_OPEN_EXTERNAL]: openExternal,
  [APP_CHECK_FOR_UPDATE]: checkForUpdate,
  [APP_INSTALL_CLI]: installCli,
  [APP_NOTIFY]: notify,
} satisfies Record<string, Handler>;
