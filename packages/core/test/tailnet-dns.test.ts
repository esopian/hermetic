import { describe, expect, test } from "bun:test";
import { TAILSCALE_RESOLVER, tailnetDnsProblem } from "../src/fleet/tailnet-dns.ts";

describe("tailnetDnsProblem", () => {
  const name = "fxtr0001-atlas.acme.ts.net";

  test("only Tailscale answering is the misconfiguration, and names the setting", () => {
    const problem = tailnetDnsProblem({ name, via_tailscale: true, via_system: false });
    expect(problem).toContain(name);
    expect(problem).toContain(TAILSCALE_RESOLVER);
    expect(problem).toContain("--accept-dns=true");
  });

  test("both answering, neither answering, or only the system answering say nothing", () => {
    expect(tailnetDnsProblem({ name, via_tailscale: true, via_system: true })).toBeNull();
    expect(tailnetDnsProblem({ name, via_tailscale: false, via_system: false })).toBeNull();
    expect(tailnetDnsProblem({ name, via_tailscale: false, via_system: true })).toBeNull();
  });
});
