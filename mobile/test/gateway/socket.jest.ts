import { agentHost, boxAddress, onTailnet } from "../../src/gateway/client.ts";
import { createSocketOpener, type WebSocketLike } from "../../src/gateway/socket.ts";
import { flush } from "../helpers/fakes.ts";

/** React Native's WebSocket, as far as the wrapper sees it. */
class FakeRnSocket implements WebSocketLike {
  static last: FakeRnSocket | null = null;
  readonly sent: string[] = [];
  closed = false;
  private readonly handlers = new Map<string, ((event: { data: unknown }) => void)[]>();

  constructor(
    readonly url: string,
    readonly protocols: string | string[] | null | undefined,
    readonly options: { headers?: Record<string, string> } | undefined,
  ) {
    FakeRnSocket.last = this;
  }

  addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), listener]);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: "open" | "error" | "close" | "message", data?: unknown): void {
    for (const h of this.handlers.get(type) ?? []) h({ data });
  }
}

const open = createSocketOpener(FakeRnSocket);

async function drain(frames: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const f of frames) out.push(f);
  return out;
}

describe("createSocketOpener", () => {
  test("headers go in React Native's third argument; opened resolves on open", async () => {
    const socket = open("wss://box/api/ws?token=T", { headers: { Origin: "http://127.0.0.1:9119" } });
    const raw = FakeRnSocket.last!;
    expect(raw.url).toBe("wss://box/api/ws?token=T");
    expect(raw.protocols).toBeUndefined();
    expect(raw.options).toEqual({ headers: { Origin: "http://127.0.0.1:9119" } });
    raw.emit("open");
    await expect(socket.opened).resolves.toBeUndefined();
    socket.send("hi");
    expect(raw.sent).toEqual(["hi"]);
  });

  test("frames are buffered while nobody reads, in order, until close", async () => {
    const socket = open("wss://box/api/ws", {});
    const raw = FakeRnSocket.last!;
    raw.emit("open");
    raw.emit("message", "one");
    raw.emit("message", "two");
    const reading = drain(socket.frames);
    await flush();
    raw.emit("message", "three");
    raw.emit("close");
    expect(await reading).toEqual(["one", "two", "three"]);
  });

  test("a failed upgrade rejects opened without the URL (it carries the token)", async () => {
    const socket = open("wss://box/api/ws?token=SECRET", {});
    FakeRnSocket.last!.emit("error");
    await expect(socket.opened).rejects.toThrow("chat socket failed");
    await socket.opened.catch((e: Error) => expect(e.message).not.toContain("SECRET"));
  });

  test("a close before open rejects opened too", async () => {
    const socket = open("wss://box/api/ws", {});
    FakeRnSocket.last!.emit("close");
    await expect(socket.opened).rejects.toThrow("closed before it opened");
  });

  test("the caller's abort closes the socket and ends the frames", async () => {
    const controller = new AbortController();
    const socket = open("wss://box/api/ws", { signal: controller.signal });
    const raw = FakeRnSocket.last!;
    raw.emit("open");
    raw.emit("message", "a");
    const reading = drain(socket.frames);
    controller.abort();
    expect(raw.closed).toBe(true);
    expect(await reading).toEqual(["a"]);
  });
});

describe("box addresses", () => {
  const fleet = {
    fleet_id: "fxtr0001",
    tailnet: "hermetic.ts.net",
    agents: [
      { name: "atlas" },
      { name: "corvid", host: "fxtr0001-corvid-2.hermetic.ts.net." },
      { name: "evil", host: "evil.example.com" },
    ],
  };

  test("the derived name, the reported one under the tailnet, never one outside it", () => {
    expect(agentHost(fleet, "atlas")).toBe("fxtr0001-atlas.hermetic.ts.net");
    expect(agentHost(fleet, "corvid")).toBe("fxtr0001-corvid-2.hermetic.ts.net");
    expect(agentHost(fleet, "evil")).toBe("fxtr0001-evil.hermetic.ts.net");
    expect(agentHost(fleet, "unknown")).toBe("fxtr0001-unknown.hermetic.ts.net");
  });

  test("boxAddress is https through Serve, with the fleet for avatar seeds", () => {
    expect(boxAddress(fleet, "corvid")).toEqual({
      instance: "corvid",
      baseUrl: "https://fxtr0001-corvid-2.hermetic.ts.net/",
      fleet_id: "fxtr0001",
    });
  });

  test("onTailnet wants a DNS name under the zone", () => {
    expect(onTailnet("a.tail1.ts.net", "tail1.ts.net")).toBe(true);
    expect(onTailnet("a.tail1.ts.net", "Tail1.TS.NET.")).toBe(true);
    expect(onTailnet("tail1.ts.net", "tail1.ts.net")).toBe(false);
    expect(onTailnet("a.tail1.ts.net.evil.com", "tail1.ts.net")).toBe(false);
    expect(onTailnet("user@a.tail1.ts.net", "tail1.ts.net")).toBe(false);
  });
});
