/**
 * The stream half of the fake transport: a stand-in for one open stream, which
 * records how it was opened and lets a test push frames into it.
 *
 * It replaces the fake SSE socket these suites used before the transport seam
 * existed. The difference is the whole point of the seam: a test used to
 * say "the UI opened `/api/ops/op-1/stream`" and now says "the UI opened
 * `ops.subscribe` for `op-1`", which is the same fact one level down — and the
 * level that survives the move to RPC. That a request name maps to that URL is
 * the transport's business, and `transport-rpc.test.ts` is where it is
 * still asserted against a real socket.
 */
import type {
  RequestParams,
  StreamFrame,
  StreamHandlers,
  SubscriptionHandlers,
  TransportFailure,
} from "../src/api/transport.ts";

/** A finite stream (`openStream`) or a long-lived feed (`subscribe`). */
export type FakeStreamKind = "stream" | "subscription";

export class FakeStream {
  /** Every stream opened since the last `installFakeTransport`, in order. */
  static instances: FakeStream[] = [];

  closed = false;

  constructor(
    readonly kind: FakeStreamKind,
    /** `ops.subscribe`, `logs.open`, `chat.turn`, or the subscription kind (`fleet`, `chat`). */
    readonly name: string,
    readonly params: RequestParams,
    private readonly handlers: StreamHandlers | SubscriptionHandlers,
  ) {
    FakeStream.instances.push(this);
  }

  /**
   * Push one frame, as the transport would have decoded it.
   *
   * `data` arrives already decoded, because that is what a `Transport` delivers
   * — the wire format is below this line. Pass `undefined` for the frame the
   * transport could not read at all, which is how every reader's "a malformed
   * frame is not worth tearing the stream down for" branch is exercised.
   */
  emit(event: string, ...rest: [data?: unknown, id?: string]): void {
    if (this.closed) return;
    // Not a default parameter: `emit("delta", undefined)` must mean "the
    // transport could not decode this frame", and a default would quietly turn
    // that into an empty object — the one payload the readers treat as valid.
    const data = rest.length === 0 ? {} : rest[0];
    const frame: StreamFrame = { event, id: rest[1] ?? "", data };
    if (event === "error" && "isProtocolError" in this.handlers) {
      // Same discrimination the socket makes: a frame named `error` is the
      // protocol's if the protocol claims it, and the transport's otherwise.
      if (this.handlers.isProtocolError?.(frame)) return;
      this.drop();
      return;
    }
    this.handlers.onFrame(frame);
  }

  /** Subscriptions only: the socket came up or went away. */
  connected(value: boolean): void {
    if (this.closed) return;
    if (!("onConnected" in this.handlers)) throw new Error(`${this.name} is not a subscription`);
    this.handlers.onConnected(value);
  }

  /**
   * The socket died.
   *
   * For a subscription that is a drop the transport will heal by itself, so it
   * is reported as disconnected and, optionally, with the delay it will retry
   * in — the transport owns reconnection now, and `transport-rpc.test.ts` is
   * where the real timer is asserted. For a finite stream it is the end.
   */
  fail(retryInMs?: number): void {
    if (this.closed) return;
    if ("onConnected" in this.handlers) {
      this.drop(retryInMs);
      return;
    }
    this.end(false, null);
  }

  /** Finite streams only: the transport's verdict on how the stream ended. */
  end(ok: boolean, failure: TransportFailure | null = null): void {
    if (this.closed) return;
    if (!("onEnd" in this.handlers)) throw new Error(`${this.name} is not a finite stream`);
    this.handlers.onEnd(ok, failure);
  }

  /** The caller closed it. Nothing is reported after this, as on the real thing. */
  close(): void {
    this.closed = true;
  }

  private drop(retryInMs?: number): void {
    if (!("onConnected" in this.handlers)) return;
    this.handlers.onConnected(false);
    if (retryInMs !== undefined) this.handlers.onRetryIn?.(retryInMs);
  }

  /**
   * The most recent stream opened whose name contains `fragment`, with an error
   * that lists what *was* opened — the failure mode this replaces was a test
   * hanging on a stream nobody opened.
   */
  static last(fragment = ""): FakeStream {
    const found = [...FakeStream.instances].reverse().find((s) => s.name.includes(fragment));
    if (!found) {
      throw new Error(
        `no stream matching "${fragment}" was opened (saw: ${
          FakeStream.instances.map((s) => s.name).join(", ") || "none"
        })`,
      );
    }
    return found;
  }

  /** Every stream opened under one name, oldest first. */
  static all(fragment = ""): FakeStream[] {
    return FakeStream.instances.filter((s) => s.name.includes(fragment));
  }
}
