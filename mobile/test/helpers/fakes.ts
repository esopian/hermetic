import type { Timers, WebSocketLike } from "../../src/client/socket.ts";
import type { ClientFrame, ServerFrame } from "../../src/protocol/types.ts";

/** Deterministic timers: `advance(ms)` runs everything due, in order. */
export class FakeTimers implements Timers {
  private t = 1_760_000_000_000;
  private nextId = 1;
  private readonly due = new Map<number, { at: number; fn: () => void }>();

  setTimeout(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.due.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.due.delete(handle as number);
  }

  now(): number {
    return this.t;
  }

  pending(): number {
    return this.due.size;
  }

  advance(ms: number): void {
    const until = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of this.due)
        if (entry[1].at <= until && (!next || entry[1].at < next[1].at)) next = entry;
      if (!next) break;
      this.due.delete(next[0]);
      this.t = next[1].at;
      next[1].fn();
    }
    this.t = until;
  }
}

export class FakeWebSocket implements WebSocketLike {
  readyState = 0;
  readonly sent: ClientFrame[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ClientFrame);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = {
      ...(code !== undefined ? { code } : {}),
      ...(reason !== undefined ? { reason } : {}),
    };
    this.readyState = 3;
  }

  /* driving it from the test */
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  push(frame: ServerFrame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }

  last<T extends ClientFrame["type"]>(type: T): Extract<ClientFrame, { type: T }> {
    const found = [...this.sent].reverse().find((f) => f.type === type);
    if (!found) throw new Error(`no ${type} frame sent`);
    return found as Extract<ClientFrame, { type: T }>;
  }
}

export function socketFactory() {
  const sockets: FakeWebSocket[] = [];
  const create = (url: string) => {
    const ws = new FakeWebSocket(url);
    sockets.push(ws);
    return ws;
  };
  return { sockets, create, current: () => sockets[sockets.length - 1]! };
}

export const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
