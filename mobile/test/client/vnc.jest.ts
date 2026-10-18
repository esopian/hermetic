import {
  agentHostname,
  noVncOrigin,
  noVncRefusalText,
  noVncTarget,
  noVncUrl,
  onTailnet,
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

describe("a reported name off this fleet's tailnet is refused", () => {
  test.each([
    "evil.com",
    "fxtr0001-atlas.other.ts.net",
    "tail1234.ts.net",
    "fxtr0001-atlas.tail1234.ts.net.evil.com",
  ])("%p with tailnet tail1234.ts.net", (name) => {
    const target = noVncTarget(
      { name: "atlas", tailscale_dns_name: name },
      "tail1234.ts.net",
      "fxtr0001",
    );
    expect(target).toMatchObject({ ok: false, reason: "off_tailnet" });
    expect(
      noVncUrl({ name: "atlas", tailscale_dns_name: name }, "tail1234.ts.net", "fxtr0001"),
    ).toBeNull();
  });

  test("with no tailnet known, a name must still be under .ts.net", () => {
    expect(noVncUrl({ name: "atlas", tailscale_dns_name: "evil.com" }, null, null)).toBeNull();
    expect(noVncUrl({ name: "atlas", tailscale_dns_name: "ts.net" }, null, null)).toBeNull();
    expect(noVncUrl({ name: "atlas", tailscale_dns_name: "a.t.ts.net." }, null, null)).toBe(
      "https://a.t.ts.net/vnc/vnc.html?path=vnc/websockify&autoconnect=true&resize=scale&reconnect=true",
    );
  });

  test("the tailnet match is case- and trailing-dot-insensitive, and a hostile tailnet falls back to .ts.net", () => {
    expect(onTailnet("a.tail1234.ts.net", "Tail1234.TS.net.")).toBe(true);
    expect(onTailnet("evil.com", "evil.com/#")).toBe(false);
    expect(onTailnet("a.tail1234.ts.net", "evil.com/#")).toBe(true);
  });

  test("a bare, full or shouting tailnet value all name the same zone", () => {
    for (const tailnet of ["tail1234", "tail1234.ts.net", "Hermetic.TS.NET.", " tail1234 "]) {
      const host = tailnet.trim().toLowerCase().replace(/\.$/, "");
      const zone = host.includes(".") ? host : `${host}.ts.net`;
      expect(onTailnet(`atlas.${zone}`, tailnet)).toBe(true);
      expect(onTailnet("evil.com", tailnet)).toBe(false);
      expect(onTailnet(zone, tailnet)).toBe(false);
    }
    expect(onTailnet("atlas.tail1234.ts.net", "tail1234")).toBe(true);
    expect(onTailnet("atlas.hermetic.ts.net", "Hermetic.TS.NET.")).toBe(true);
    // A bare name is a `.ts.net` zone, not a suffix of anything else.
    expect(onTailnet("atlas.tail1234.example.com", "tail1234")).toBe(false);
    expect(onTailnet("atlas.other.ts.net", "tail1234")).toBe(false);
  });

  test("the overlay says why", () => {
    const target = noVncTarget(
      { name: "atlas", tailscale_dns_name: "evil.com" },
      "tail1234.ts.net",
      "fxtr0001",
    );
    expect(target.ok).toBe(false);
    if (!target.ok)
      expect(noVncRefusalText(target.reason, "evil.com", "tail1234.ts.net")).toBe(
        "This agent reported the name evil.com, which is not on this fleet's tailnet (tail1234.ts.net). The app will not load a browser from it.",
      );
    expect(noVncTarget({ name: "atlas", tailscale_dns_name: null }, null, null)).toMatchObject({
      ok: false,
      reason: "no_name",
    });
  });
});
