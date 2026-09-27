/**
 * The server, faked at the seam the UI actually talks through: `Transport`.
 *
 * It used to be faked at the global `fetch`, because that was the only place
 * every read and write went past. There is now a narrower one:
 * `api/{client,fleet,chat,streams}.ts` name a request and hand over
 * parameters, and `transport-rpc.ts` is the only thing below that knows how one
 * travels. Faking here runs the whole client path above the seam for real and
 * leaves the bridge mapping to be asserted, once, against a fake `Electroview`
 * in `transport-rpc.test.ts`.
 *
 * Installing a transport rather than `mock.module("../src/api/index.ts")` is
 * still deliberate: bun runs every test file in one process and a module mock
 * outlives the file that installed it, so mocking `api.ts` would hand the next
 * file a fake `followOp`. A transport is installed and removed per test, and an
 * unrouted request name throws instead of leaving the suite one missing route
 * away from silently answering `undefined`.
 */
import { apiErrorOf, isError, setFleetTarget } from "../src/api/index.ts";
import type {
  RequestName,
  RequestOptions,
  RequestParams,
  StreamHandlers,
  StreamName,
  SubscriptionHandlers,
  SubscriptionKind,
  Transport,
} from "../src/api/transport.ts";
import { installedTransport, setTransport } from "../src/api/transport.ts";
import { FakeStream } from "./fake-stream.ts";

/** One request the UI made: what it asked for, and what it asked with. */
export interface TransportCall {
  name: RequestName;
  /** The parameters as the call site built them — including the §4.7 `target` envelope. */
  params: RequestParams;
  /** The per-call transport options, so a test can assert a read was cancellable. */
  options: RequestOptions;
}

/** What a route hands back. `status` is kept only so `errorBody` reads like the wire did. */
export interface FakeReply {
  status?: number;
  json: unknown;
}

/**
 * A handler may be `async`: its promise is awaited before the reply is built.
 * That is what lets a test hold one route open while another answers, which is
 * the only way to produce the stale-response race the model picker guards
 * against (§8.3: a catalog that arrives after the provider changed).
 */
export type FakeRoutes = Partial<
  Record<
    RequestName,
    FakeReply | unknown | ((call: TransportCall) => FakeReply | unknown | Promise<FakeReply | unknown>)
  >
>;

/** The fleet a faked server is serving. Any triple will do; it only has to be one. */
export const FAKE_TARGET = {
  account_id: "123456789012",
  region: "us-west-2",
  fleet_id: "fxtr0001",
} as const;

export interface FakeServer {
  /** Every request the UI made, in order. */
  calls: TransportCall[];
  /** Requests under one request name. */
  to(name: RequestName): TransportCall[];
  /** Every stream and subscription the UI opened, in order. */
  streams: FakeStream[];
  restore(): void;
}

function isReply(v: unknown): v is FakeReply {
  return typeof v === "object" && v !== null && "json" in v;
}

/**
 * Installs a transport that answers `routes`, keyed by request name
 * (`"agents.list"`, `"plan.destroy"`). Call it with no routes for a suite that
 * only drives streams.
 */
export function fakeServer(routes: FakeRoutes = {}): FakeServer {
  // Whatever was in force, so `restore()` puts the suite back exactly as it
  // found it: `test/setup.ts` installs a transport that refuses every request
  // by name, and restoring null instead would leave the *next* file's stray
  // unmount read throwing "no transport installed" — a message about a portal
  // that forgot to boot, in a test that forgot to fake.
  const previous = installedTransport();
  const calls: TransportCall[] = [];
  FakeStream.instances = [];
  /**
   * §4.7: a tab that can call a mutating route is a tab that has loaded
   * `/api/meta`, and every such request names the fleet it is for. A fake
   * server stands in for that read, so it stands in for this too — otherwise
   * every DOM test would have to fetch meta before it could click anything.
   */
  setFleetTarget(FAKE_TARGET);

  const transport: Transport = {
    async request<T>(
      name: RequestName,
      params: RequestParams = {},
      options: RequestOptions = {},
    ): Promise<T> {
      const call: TransportCall = { name, params, options };
      calls.push(call);
      const route = routes[name];
      if (route === undefined) {
        throw new Error(`fake-transport: no route for ${name} (tests must not reach the network)`);
      }
      const answer = await (typeof route === "function" ? route(call) : route);
      const body = isReply(answer) ? answer.json : answer;
      // Success is decided by body shape, not by status — exactly as the real
      // transport decides it (`transport-rpc.ts`), so an `errorBody` route
      // produces the same `ApiError` the UI would really have seen.
      if (isError(body)) throw apiErrorOf(body);
      return body as T;
    },
    subscribe(kind: SubscriptionKind, key: string | null, handlers: SubscriptionHandlers) {
      const stream = new FakeStream("subscription", kind, { key }, handlers);
      return () => {
        stream.close();
      };
    },
    openStream(name: StreamName, params: RequestParams, handlers: StreamHandlers) {
      const stream = new FakeStream("stream", name, params, handlers);
      return () => {
        stream.close();
      };
    },
  };

  setTransport(transport);
  return {
    calls,
    to: (name) => calls.filter((c) => c.name === name),
    get streams() {
      return FakeStream.instances;
    },
    restore: () => {
      setTransport(previous);
      FakeStream.instances = [];
    },
  };
}

/** The error body shape `call()` turns into an `ApiError`. */
export function errorBody(code: string, message: string, extra: { op_id?: string } = {}): FakeReply {
  return { status: 409, json: { error: { code, message }, ...extra } };
}

export { FakeStream } from "./fake-stream.ts";
