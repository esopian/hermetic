import {
  agentHostname,
  noVncOrigin,
  noVncUrl,
  validTailnetHost,
  vncNavigationAllowed,
} from "../../src/client/vnc.ts";

test("the long-form noVNC URL, from the node's real name", () => {
  expect(
    noVncUrl(
      { name: "atlas", tailscale_dns_name: "fxtr0001-atlas.tail1234.ts.net." },
      "tail1234.ts.net",
      "fxtr0001",
    ),
  ).toBe(
    "https://fxtr0001-atlas.tail1234.ts.net/vnc/vnc.html?path=vnc/websockify&autoconnect=true&resize=scale&reconnect=true",
  );
});

test("falls back to the cloud name on the tailnet; view-only; a second browser's path", () => {
  expect(agentHostname({ name: "atlas", tailscale_dns_name: null }, "t.ts.net", "fxtr0001-atlas")).toBe(
    "fxtr0001-atlas.t.ts.net",
  );
  expect(
    noVncUrl({ name: "atlas" }, "t.ts.net", "fxtr0001", { viewOnly: true, servePath: "/vnc/work/" }),
  ).toBe(
    "https://fxtr0001-atlas.t.ts.net/vnc/work/vnc.html?path=vnc/work/websockify&autoconnect=true&resize=scale&reconnect=true&view_only=true",
  );
  expect(noVncUrl({ name: "atlas" }, null, "fxtr0001")).toBeNull();
});

describe("hostile names never reach the WebView", () => {
  test.each([
    "evil.com/x",
    "user@evil.com",
    "evil.com:8443",
    "evil.com?x=1",
    "-atlas.t.ts.net",
    "atlas..t.ts.net",
    "atlas t.ts.net",
  ])("a reported dns name %p yields no URL", (name) => {
    expect(validTailnetHost(name)).toBe(false);
    expect(noVncUrl({ name: "atlas", tailscale_dns_name: name }, "t.ts.net", "fxtr0001")).toBeNull();
  });

  test("a hostile tailnet or serve path yields no URL", () => {
    expect(noVncUrl({ name: "atlas" }, "evil.com/#", "fxtr0001")).toBeNull();
    expect(
      noVncUrl({ name: "atlas" }, "t.ts.net", "fxtr0001", { servePath: "/vnc/../admin" }),
    ).toBeNull();
    expect(noVncUrl({ name: "atlas" }, "t.ts.net", "fxtr0001", { servePath: "/vnc?x=1" })).toBeNull();
  });

  test("the WebView is pinned to the URL's one origin, exactly", () => {
    const url = noVncUrl(
      { name: "atlas", tailscale_dns_name: "fxtr0001-atlas.t.ts.net." },
      null,
      null,
    )!;
    const origin = noVncOrigin(url)!;
    expect(origin).toBe("https://fxtr0001-atlas.t.ts.net");
    expect(vncNavigationAllowed(url, origin)).toBe(true);
    expect(vncNavigationAllowed("https://fxtr0001-atlas.t.ts.net/vnc/app.js", origin)).toBe(true);
    expect(vncNavigationAllowed("about:blank", origin)).toBe(true);
    expect(vncNavigationAllowed("https://fxtr0001-atlas.t.ts.net.evil.com/", origin)).toBe(false);
    expect(vncNavigationAllowed("https://fxtr0001-atlas.t.ts.net:8443/", origin)).toBe(false);
    expect(vncNavigationAllowed("https://fxtr0001-atlas.t.ts.net@evil.com/", origin)).toBe(false);
    expect(vncNavigationAllowed("http://fxtr0001-atlas.t.ts.net/", origin)).toBe(false);
  });
});
