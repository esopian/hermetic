import {
  baseUrlFor,
  createBridgeHttp,
  type FetchLike,
  normalisePairCode,
  parsePairLink,
  wsUrlFor,
} from "../../src/client/http.ts";
import { hello } from "../helpers/fixtures.ts";

type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown };

function fakeFetch(respond: (call: Call) => { status: number; body?: unknown; raw?: string }) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call: Call = {
      url,
      method: init.method,
      headers: init.headers,
      ...(init.body ? { body: JSON.parse(init.body) } : {}),
    };
    calls.push(call);
    const r = respond(call);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => r.raw ?? (r.body === undefined ? "" : JSON.stringify(r.body)),
    };
  };
  return { fetch, calls };
}

const target = { account_id: "123456789012", region: "us-west-2", fleet_id: "fxtr0001" };

describe("BridgeHttp", () => {
  test("pair posts the code unauthenticated with the version header", async () => {
    const f = fakeFetch(() => ({
      status: 200,
      body: { token: "hmt_FIXTURE", device_id: "dev1", hello: hello() },
    }));
    const http = createBridgeHttp({ baseUrl: "http://127.0.0.1:7877/", fetch: f.fetch });
    const result = await http.pair({ code: "ABCD1234", device_name: "FIXTURE phone", platform: "ios" });
    expect(result.device_id).toBe("dev1");
    expect(f.calls[0]).toMatchObject({
      url: "http://127.0.0.1:7877/mobile/v1/pair",
      method: "POST",
      body: { code: "ABCD1234", device_name: "FIXTURE phone", platform: "ios" },
    });
    expect(f.calls[0]!.headers["X-Hermetic-Mobile"]).toBe("1");
    expect(f.calls[0]!.headers.Authorization).toBeUndefined();
  });

  test("rpc sends the bearer token, method, params and fleet target", async () => {
    const f = fakeFetch(() => ({ status: 200, body: { ok: true, result: { instances: ["atlas"] } } }));
    const http = createBridgeHttp({
      baseUrl: "http://h:1",
      fetch: f.fetch,
      token: () => "hmt_FIXTURE",
      target: () => target,
    });
    await expect(http.rpc("chat.listening", {})).resolves.toEqual({ instances: ["atlas"] });
    expect(f.calls[0]!.headers.Authorization).toBe("Bearer hmt_FIXTURE");
    expect(f.calls[0]!.body).toEqual({ method: "chat.listening", params: {}, target });
  });

  test("an HTTP error body becomes a BridgeError with code and status", async () => {
    const f = fakeFetch(() => ({
      status: 403,
      body: { code: "FORBIDDEN", message: "method not reachable from a phone" },
    }));
    const http = createBridgeHttp({
      baseUrl: "http://h:1",
      fetch: f.fetch,
      token: () => "t",
      target: () => target,
    });
    await expect(http.rpc("agents.destroy")).rejects.toMatchObject({
      name: "BridgeError",
      code: "FORBIDDEN",
      status: 403,
      message: "method not reachable from a phone",
    });
  });

  test("ok:false inside a 200 is a refusal too", async () => {
    const f = fakeFetch(() => ({
      status: 200,
      body: { ok: false, error: { code: "FLEET_MISMATCH", message: "x" } },
    }));
    const http = createBridgeHttp({
      baseUrl: "http://h:1",
      fetch: f.fetch,
      token: () => "t",
      target: () => target,
    });
    await expect(http.rpc("chat.swarms")).rejects.toMatchObject({ code: "FLEET_MISMATCH" });
  });

  test("unpaired, no target, non-JSON and network failures", async () => {
    const f = fakeFetch(() => ({ status: 502, raw: "<html>bad gateway</html>" }));
    const http = createBridgeHttp({
      baseUrl: "http://h:1",
      fetch: f.fetch,
      token: () => null,
      target: () => null,
    });
    await expect(http.hello()).rejects.toMatchObject({ code: "NOT_PAIRED" });
    await expect(http.rpc("x")).rejects.toMatchObject({ code: "NO_TARGET" });
    await expect(http.health()).rejects.toMatchObject({ code: "BAD_RESPONSE", status: 502 });
    const down = createBridgeHttp({
      baseUrl: "http://h:1",
      fetch: async () => {
        throw new Error("connection refused");
      },
    });
    await expect(down.health()).rejects.toMatchObject({ code: "NETWORK", status: 0 });
  });

  test("push register and settings", async () => {
    const f = fakeFetch((c) =>
      c.url.endsWith("/settings")
        ? { status: 200, body: { ok: true, previews: false, enabled: true } }
        : { status: 200, body: { ok: true } },
    );
    const http = createBridgeHttp({ baseUrl: "http://h:1", fetch: f.fetch, token: () => "t" });
    await http.pushRegister({ expo_push_token: "ExponentPushToken[FIXTURE]", previews: true });
    await expect(http.pushSettings({ previews: false })).resolves.toEqual({
      ok: true,
      previews: false,
      enabled: true,
    });
    expect(f.calls.map((c) => c.url)).toEqual([
      "http://h:1/mobile/v1/push/register",
      "http://h:1/mobile/v1/push/settings",
    ]);
  });
});

describe("pairing links and urls", () => {
  test("parsePairLink", () => {
    expect(
      parsePairLink(
        "hermetic://pair?host=100.64.0.1&port=7877&code=abcd-1234&fleet=fxtr0001&name=main",
      ),
    ).toEqual({
      host: "100.64.0.1",
      port: 7877,
      code: "ABCD1234",
      fleet: "fxtr0001",
      name: "main",
    });
    expect(parsePairLink("hermetic://pair?host=h&code=X")?.port).toBe(7877);
    expect(parsePairLink("https://example.com/?host=h&code=x")).toBeNull();
    expect(parsePairLink("hermetic://pair?host=h&port=99999&code=x")).toBeNull();
    expect(parsePairLink("hermetic://pair?port=1&code=x")).toBeNull();
  });

  test("urls", () => {
    expect(normalisePairCode(" ab cd-12 ")).toBe("ABCD12");
    expect(baseUrlFor("100.64.0.1", 7877)).toBe("http://100.64.0.1:7877");
    expect(baseUrlFor("fd7a::1", 7877)).toBe("http://[fd7a::1]:7877");
    expect(wsUrlFor("http://h:1/")).toBe("ws://h:1/mobile/v1/ws");
    expect(wsUrlFor("https://h:1")).toBe("wss://h:1/mobile/v1/ws");
  });
});
