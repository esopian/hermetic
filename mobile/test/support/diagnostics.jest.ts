import { type DiagnosticInput, supportReport } from "../../src/support/diagnostics.ts";

const input: DiagnosticInput = {
  version: "0.1.0",
  build: "12",
  osVersion: "18.3",
  fixture: false,
  paired: true,
  tailnetStatus: "unreachable",
  fleetStale: true,
  fleetErrorCode: "TUNNEL_UNVERIFIED",
  listeningCount: 2,
  pushState: "on",
  pushRegistered: 1,
  pushFailed: 1,
};

it("exports only the diagnostic allowlist, even if the caller supplies additional store data", () => {
  const withPrivateFields = { ...input, token: "PRIVATE_TOKEN", message: "PRIVATE_CHAT" };
  const report = supportReport(withPrivateFields);
  expect(report).not.toContain("PRIVATE");
  expect(JSON.parse(report)).toMatchObject({
    version: "0.1.0",
    build: "12",
    fleetError: "TUNNEL_UNVERIFIED",
    pushRegistered: 1,
    pushFailed: 1,
  });
});

it("drops unrecognized categories rather than exposing error text or addresses", () => {
  const report = supportReport({
    ...input,
    fleetErrorCode: "PRIVATE_HOST",
    tailnetStatus: "PRIVATE_TAILNET",
    pushState: "PRIVATE_TOKEN",
  });
  expect(report).not.toContain("PRIVATE");
  expect(JSON.parse(report)).toMatchObject({
    fleetError: "OTHER",
    tailnet: "unknown",
    push: "unknown",
  });
});
