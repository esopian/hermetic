import { agentHostname, noVncUrl } from "../../src/client/vnc.ts";

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
