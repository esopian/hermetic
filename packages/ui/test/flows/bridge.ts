/**
 * The real head, behind the UI's `Transport` seam.
 *
 * The §11.6 Playwright suite booted a portal, drove a Chromium at it, and
 * asserted on what the page said. Everything about that was right except the
 * browser: the specs are about *the UI rendering what the head actually
 * answered*, and Chromium was only ever how the two were connected. So the
 * connection is made here instead — happy-dom for the rendering, and the real
 * `dispatch` over the real fixture backend for the answering — and the specs
 * port across with their assertions intact.
 *
 * ## Why this wires the two real halves together rather than faking between them
 *
 * There is a shorter bridge available: a `Transport` whose `request` calls
 * `dispatch` and whose `subscribe` opens `fleet.subscribe` with a sink of its
 * own. It was not taken, because both halves of that translation already exist
 * and are the thing the desktop bridge is actually built from:
 *
 * - `app/src/rpc/bind.ts` turns a request name into `dispatch`, buffers the
 *   frames a streaming handler emits before its `stream_id` is known, drops
 *   keepalives, and closes a silent stream with `STREAM_ENDED`;
 * - `ui/src/api/transport-rpc.ts` turns the `Transport` verbs into those
 *   request names, routes the pushes back to the reader that asked, and keeps
 *   an op's replay cursor.
 *
 * Re-implementing either here would mean a second copy of the part with the
 * race in it, drifting from the one that ships. What this module supplies is
 * the *wire* the two are missing outside a built `.app`: the app's `send`
 * reaches the page's message handlers, and the page's request table reaches the
 * app's. Nothing is canned, and a flow that passes here is a flow whose every
 * answer a handler really produced.
 *
 * The price is that a bug in either of those two modules fails a flow test.
 * That is the intended reading: this *is* the desktop head, minus a window.
 *
 * ## Isolation, and the order-independence it buys
 *
 * Every `flowHarness()` gets its own `HERMETIC_HOME` and its own
 * `openHermetic({ fixture: true })`, so it gets its own fleet, its own agents
 * and its own run log. The Playwright suite could not: one portal served every
 * spec, so `rerun.e2e.ts` walked `heron` out of `error` for good and
 * `bootstrap.e2e.ts` had to sort before it (see that file's header). Here the
 * two can run in either order, in the same file, twice — a flow mutates only
 * the fleet it made.
 *
 * The poller is the other half of that. The one built here is never
 * `start()`ed: a three-second interval is a wall clock, and a flow that waits
 * on one is a flow that is slow when it passes and flaky when it does not.
 * Scans are driven by hand through `harness.poll()`, so "the stream carried the
 * change" is asserted against a scan the test knows happened. One exception,
 * and it is not ours: a fleet switch makes `AppState.#install` build its own
 * replacement and start it. `restore()` stops that one too.
 *
 * ## What this cannot catch
 *
 * Params and results cross the wire by reference. Real Electrobun IPC
 * structured-clones them, so a handler that returned a `Date`, a `Map` or a
 * class instance — or that mutated the params object it was handed — would pass
 * here and misbehave in a built `.app`. That is the RPC schema's contract to
 * keep (`rpc/schema.ts`), not this harness's, but a flow test is not where it
 * will be caught.
 */
import "../dom.ts";

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { createFixtureAccount, fleetTargetOf, openHermetic } from "@hermetic/core";
import type { FixtureOptions, FleetTarget, Hermetic } from "@hermetic/core";
import { createChatOwner, type ChatOwner } from "../../../app/src/chat-owner.ts";
import type { HandlerContext } from "../../../app/src/handlers/ctx.ts";
import { createStreamRegistry } from "../../../app/src/handlers/streams.ts";
import { OpRegistry } from "../../../app/src/ops.ts";
import { FleetPoller } from "../../../app/src/poller.ts";
import { AppState } from "../../../app/src/state.ts";
import {
  RpcRefusal,
  createRpcBinding,
  refusalFor,
  type RpcOptions,
  type SendMessage,
} from "../../../app/src/rpc/bind.ts";
import { REQUEST_NAMES } from "../../../app/src/rpc/schema.ts";
import { fleetTarget, setFleetTarget } from "../../src/api/index.ts";
import { installedTransport, setTransport } from "../../src/api/transport.ts";
import { invalidateFetchCache } from "../../src/lib/fetch-cache.ts";
import {
  createRpcTransport,
  type ElectroviewLike,
  type RpcHandle,
  type RpcMessageHandlers,
} from "../../src/api/transport-rpc.ts";
import { electrobunRequest } from "../electrobun-request.ts";
import { Portal } from "../../src/Portal.tsx";
import { FleetProvider } from "../../src/state/state.tsx";
import { act, render } from "../dom.ts";

/* ── interception ────────────────────────────────────────────────────────── */

/**
 * The happy-dom stand-in for Playwright's `page.route`.
 *
 * Two ports need one, and they need opposite things from it.
 * `destroy-plan.e2e.ts` fulfils `plan.destroy` with a 503 so the drawer has a
 * refusal to render; `keyboard.e2e.ts` holds `plan.destroy` open so the dialog
 * can be inspected while a request is in flight. So an interceptor is given
 * both halves of the decision:
 *
 * - **to refuse**, `throw` — a `HermeticError` is mapped to the page exactly as
 *   a handler's own refusal is (`refusalFor`), so the drawer shows the message
 *   the real code would have shown;
 * - **to answer**, `return` a value, which is sent as the handler's result;
 * - **to call through**, `return passthrough()` — the real `dispatch` runs and
 *   its answer (or its refusal) is what the page gets. Awaiting something first
 *   is what makes a request *slow* rather than *failed*:
 *   `(params, passthrough) => held.then(passthrough)`.
 *
 * An intercepted request is still recorded in `calls`: the assertion "the UI
 * asked for this" is about the UI, and must not depend on what the test decided
 * to do with the ask.
 */
export type Interceptor = (
  params: unknown,
  passthrough: () => Promise<unknown>,
) => unknown | Promise<unknown>;

/** One request the UI made, in the order it made it. */
export interface HarnessCall {
  /**
   * The name as it reaches the head — an RPC name, which is core's own dotted
   * method path for everything in `PUBLIC_METHODS`. It differs from the UI's
   * own `RequestName` in exactly one place (`init.tailscale.oauth` is answered
   * by `init.verifyOauth`), which is `RENAMED` in `transport-rpc.ts`.
   */
  name: string;
  params: unknown;
}

export interface FlowHarness {
  /** The head's context, for a test that wants to reach a handler directly. */
  ctx: HandlerContext;
  /** §4.7: the fleet this harness's fixture instance froze. */
  target: FleetTarget;
  /** Every request name the UI asked for, in order. */
  calls: HarnessCall[];
  /** Install a per-request interceptor, or clear one with `null`. See `Interceptor`. */
  intercept(name: string, fn: Interceptor | null): void;
  /**
   * Run one fleet scan and let its events reach every open subscription.
   *
   * The portal's poller runs this on a three-second interval; a test runs it
   * when it wants the fleet re-read, which is the only difference between the
   * two. Resolves once the scan is complete — the frames it produced are
   * delivered synchronously from the poller's own `emit`, so a `waitFor` after
   * this is waiting on React and not on the head.
   */
  poll(): Promise<void>;
  /** Everything this harness opened: the transport, the streams, the chat owner. */
  restore(): Promise<void>;
}

export interface FlowHarnessOptions {
  /**
   * Which fixture fleet to open. `main` (`fxtr0001`, 12 agents) by default —
   * the fleet every ported spec was written against.
   */
  fleet?: string;
}

/**
 * A head, a transport and a fleet, ready for a `mountPortal()`.
 *
 * The first scan is driven before returning, so the page that mounts next gets
 * a `snapshot` with `scanned: true` and the fixture's agents in it rather than
 * the empty pre-scan one — which is what the Playwright suite's
 * `dashboardReady` was waiting for, and what it means for the dashboard to be
 * showing data instead of a skeleton.
 */
export async function flowHarness(options: FlowHarnessOptions = {}): Promise<FlowHarness> {
  const home = mkFlowHome();
  /**
   * §4.8: one fake account for the life of this harness, exactly as
   * `openState` keeps one for the life of the app (`app/src/state.ts`).
   * Every open below stands in it — the boot and every fleet switch — so a
   * backend rebuilt for another fleet lists the same fleets and whatever a
   * flow did before the switch is still there after it. Without it each
   * `reopen` would fabricate a fresh world, and a flow asserting continuity
   * across a switch would be asserting against a different one.
   */
  const fixtureOptions: FixtureOptions = { account: createFixtureAccount() };
  const hermetic: Hermetic = await openHermetic({
    fixture: true,
    fixtureOptions,
    home,
    ...(options.fleet === undefined ? {} : { fleet: options.fleet }),
  });
  const poller = new FleetPoller(hermetic);
  const state = new AppState({
    fixture: true,
    home,
    /** So `switchFleet`'s "already on this fleet" short-circuit can fire, as it does in a portal. */
    ...(hermetic.target === null ? {} : { fleetId: hermetic.target.fleet_id }),
    /**
     * A real `reopen`, not `fixedInstance(hermetic)`.
     *
     * `fixedInstance` refuses every `reopen(fleet)` with `UNSUPPORTED`, which
     * is the honest answer for a server built around one instance somebody
     * else constructed — but it makes `fleets.switch` unreachable, and a
     * fleet switch driven through the switcher popover is exactly what
     * `fleet-switch.flow.test.tsx` is porting. The fixture home seeds both
     * fleets (`fxtr0001`/`main` and `sg7k2m4p`/`staging`), so re-opening it
     * under a named fleet is a real switch against a real backend rather
     * than a label change: this is the same call `hermetic-portal` makes.
     */
    reopen: (fleet?: string) =>
      fleet === undefined
        ? Promise.resolve(hermetic)
        : openHermetic({ fixture: true, fixtureOptions, home, fleet }),
    hermetic,
    target: hermetic.target === null ? null : fleetTargetOf(hermetic.target),
    poller,
  });
  const chatOwner: ChatOwner = createChatOwner({ hermetic: () => state.hermetic });
  const ctx: HandlerContext = {
    state,
    hermetic: () => state.hermetic,
    ops: new OpRegistry(),
    poller: () => state.poller,
    chatOwner,
    fixture: true,
    opts: { fixture: true },
    streams: createStreamRegistry(),
  };

  const calls: HarnessCall[] = [];
  const intercepts = new Map<string, Interceptor>();

  /**
   * The app's pushes, and the page's handlers for them. Mutable and read at
   * push time because the two ends are built in order: the binding needs a
   * `send` before the transport exists to be sent to.
   */
  const messages: RpcMessageHandlers = {};
  const send: SendMessage = (name, payload) => {
    const handler = messages[name];
    // `RpcMessageHandlers` is keyed by the same union `SendMessage` is generic
    // over, but `tsc` cannot see that `messages[name]` takes `payload` for the
    // *same* `name` through a generic parameter. One cast, at the one point the
    // two halves meet, and `WebviewMessages` still types both sides of it.
    (handler as ((p: typeof payload) => void) | undefined)?.(payload);
  };

  /**
   * The app side. `defineRPC` here just hands the table back: there is no
   * Electrobun channel to define anything on, and the table *is* what the page
   * calls.
   */
  type RequestTable = Record<string, (params: never) => unknown>;
  const binding = createRpcBinding<RequestTable>({
    defineRPC: (rpcOptions: RpcOptions) => rpcOptions.handlers.requests,
    send,
    ctx,
  });
  const appRequests = binding.rpc as Record<string, (params: unknown) => Promise<unknown>>;

  /** Record, then intercept, then dispatch. See `Interceptor` for the convention. */
  const askHead = async (name: string, params: unknown): Promise<unknown> => {
    calls.push({ name, params });
    const passthrough = () => appRequests[name]?.(params) ?? unknownName(name);
    const fn = intercepts.get(name);
    if (fn === undefined) return await passthrough();
    try {
      return await fn(params, passthrough);
    } catch (e) {
      // A refusal that came back through `passthrough` has already been mapped
      // by the binding and must not be mapped twice — `refusalFor` would read
      // an `RpcRefusal` as an unclassified throw and replace its message with
      // "internal error". Anything else is the interceptor's own refusal, and
      // goes to the page the way a handler's would.
      if (e instanceof RpcRefusal) throw e;
      throw refusalFor(e).refusal;
    }
  };

  /**
   * The page side's view of the bridge. A fresh class per harness rather than a
   * module-level one: bun runs a package's test files in one process, and a
   * static message table shared between harnesses would deliver one flow's
   * fleet frames to another flow's page.
   */
  const known = new Set<string>(REQUEST_NAMES);
  // Electrobun's callable proxy, not a table: a table answers `apply` with the
  // request, where the real bridge answers it with `Function.prototype.apply`.
  const handle = {
    request: electrobunRequest((name, params) =>
      known.has(name) ? askHead(name, params) : Promise.reject(new Error(`no request named ${name}`)),
    ),
  } as unknown as RpcHandle;
  const Electroview = class {
    constructor(readonly options: { rpc?: RpcHandle }) {}
    static defineRPC(defineOptions: {
      maxRequestTime?: number;
      handlers: { requests?: RequestTable; messages?: RpcMessageHandlers };
    }): RpcHandle {
      Object.assign(messages, defineOptions.handlers.messages ?? {});
      return handle;
    }
  } as unknown as ElectroviewLike;

  /**
   * §4.7: every fleet-scoped mutation names its fleet, and the page only learns
   * which one from `meta.get`. Seeded here — from a real `meta.get` through the
   * real head, not from a constant — so a mutation issued before the provider's
   * own boot read has resolved still names the right fleet, exactly as
   * `fake-transport.ts` does it.
   */
  const target = state.target;
  if (target === null) throw new Error("the fixture backend has a fleet; this is unreachable");
  await askHead("meta.get", {});
  setFleetTarget(target);

  // Restored on teardown rather than cleared: there is no default transport
  // any more, so a file that cleared it would leave the next one with none.
  // The fleet target is the same story — it is module state in
  // `src/api/client.ts` for the whole run, and a flow that nulled it on the
  // way out left every later file's reads refused with "this window does not
  // know which fleet it is showing".
  const priorTransport = installedTransport();
  const priorTarget = fleetTarget();
  setTransport(createRpcTransport({ Electroview }));
  // `lib/fetch-cache.ts` is module state too, and it keeps an answer for ten
  // seconds. Left alone, this harness's first `volumes.list` is the previous
  // harness's fleet — a fleet that flow may have destroyed agents in — and no
  // request ever reaches this head. Cleared here and again on teardown.
  invalidateFetchCache();

  // The first scan, so the snapshot the page subscribes to has the fleet in it.
  await poller.poll();

  return {
    ctx,
    target,
    calls,
    intercept(name, fn) {
      if (fn === null) intercepts.delete(name);
      else intercepts.set(name, fn);
    },
    /**
     * Wrapped in `act` because a scan's frames are delivered synchronously from
     * the poller's own `emit` — through the bridge, into the subscription, into
     * `setByName`. Outside `act` those are exactly the "update was not wrapped
     * in act(...)" React complains about, and the complaint is fair: the test
     * *is* the thing causing them.
     */
    async poll() {
      await act(async () => {
        // `state.poller`, not the one captured above: `AppState.#install`
        // replaces the poller on every fleet switch, so a harness holding the
        // original would go on scanning the fleet the head has left — which is
        // exactly the fleet the test just proved it is no longer serving.
        await (state.poller ?? poller).poll();
      });
    },
    async restore() {
      setTransport(priorTransport);
      setFleetTarget(priorTarget);
      invalidateFetchCache();
      // Both, for the same reason `poll` reads `state.poller`: after a switch
      // they are different objects, and the one `#install` created was
      // `start()`ed, so leaving it running leaks a real interval into the next
      // test file.
      state.poller?.stop();
      poller.stop();
      binding.close();
      ctx.streams.closeAll();
      await chatOwner.stop();
    },
  };
}

/**
 * `mountPortal` renders what `main.tsx` renders, minus the two things a test
 * must not have: `createRoot` (Testing Library owns the root) and the CSS
 * imports (happy-dom parses no stylesheets, and bun would have to load six of
 * them for no assertion). `StrictMode` is left off too — its double-invoked
 * effects would open the fleet subscription twice, which is a property of the
 * dev build and not of the flow under test.
 */
export function mountPortal(): ReturnType<typeof render> {
  return render(createElement(FleetProvider, null, createElement(Portal)));
}

/**
 * Point the page at a hash route the way a `page.goto("/#settings")` did.
 *
 * `nav-state.tsx` reads `window.location.hash` when it mounts and listens for
 * `hashchange` after that, so both are done: setting the hash before a mount is
 * the `goto`, and the event covers a page that is already up.
 */
export function gotoHash(hash: string): void {
  const url = new URL(window.location.href);
  url.hash = hash;
  window.history.replaceState(null, "", url.toString());
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

/**
 * §11.6's table layout, pinned before the app boots — the `addInitScript` from
 * `tests/e2e/helpers.ts`, which is a `localStorage` write and nothing else
 * (`state/state.tsx` reads `hermetic.layout`).
 */
export function useTableLayout(): void {
  window.localStorage.setItem("hermetic.layout", "table");
}

/* ── the facts the fixture seeds ─────────────────────────────────────────── */

/**
 * `FIXTURE` from `tests/e2e/helpers.ts`, carried across unchanged so a ported
 * assertion still reads as the one it came from. Mirrored rather than imported
 * for the same reason it was there: these are the fixture backend's own
 * constants (`packages/core/src/backend/fixture/`), and a flow that names them
 * out loud is a flow whose failure says which fact moved.
 */
export const FIXTURE = {
  account_id: "123456789012",
  region: "us-west-2",
  main: { alias: "main", fleet_id: "fxtr0001" },
  staging: { alias: "staging", fleet_id: "sg7k2m4p" },
  /** Seeded in `error` with `02-data-volume` failed. */
  errorAgent: "heron",
  /** Seeded `ready`. */
  readyAgent: "granite",
  /** Seeded `ready`; the subject of the live status flow. */
  sseAgent: "kestrel",
  /** The only `ready` agent in the staging fleet. */
  stagingReadyAgent: "ember",
} as const;

/* ── plumbing ────────────────────────────────────────────────────────────── */

async function unknownName(name: string): Promise<never> {
  throw new Error(`flow bridge: the head answers no request named ${name}`);
}

/**
 * A `HERMETIC_HOME` of this harness's own, inside the run's own home.
 *
 * `packages/app/test/home.ts` explains the containment argument in full; this
 * is that, reachable from a package that cannot import a server test helper
 * without dragging the server's test tree into the UI's.
 */
function mkFlowHome(): string {
  const root = process.env["HERMETIC_HOME"] ?? tmpdir();
  return mkdtempSync(join(root, "ui-flow-"));
}
