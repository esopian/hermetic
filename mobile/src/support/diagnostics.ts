/** Explicit projection: never serialize stores, errors, addresses or notification payloads. */
export interface DiagnosticInput {
  version: string;
  build: string;
  osVersion: string;
  fixture: boolean;
  paired: boolean;
  tailnetStatus: string | null;
  fleetStale: boolean;
  fleetErrorCode: string | null;
  listeningCount: number;
  pushState: string;
  pushRegistered: number;
  pushFailed: number;
}

const FLEET_ERRORS = new Set([
  "FLEET_LIST_UNAVAILABLE",
  "HERMETICD_UNAVAILABLE",
  "TUNNEL_UNVERIFIED",
  "FORBIDDEN",
  "VALIDATION",
]);

function category(value: string | null, allowed: readonly string[]): string {
  return value && allowed.includes(value) ? value : "unknown";
}

/** A report exists only when requested, in memory, until the operator chooses where to share it. */
export function supportReport(input: DiagnosticInput): string {
  return JSON.stringify(
    {
      format: 1,
      app: "Hermetic for iPhone",
      version: input.version,
      build: input.build,
      ios: input.osVersion,
      mode: input.fixture ? "fixture" : "real",
      paired: input.paired,
      tailnet: category(input.tailnetStatus, ["ok", "off", "unreachable", "unknown"]),
      fleetStale: input.fleetStale,
      fleetError: input.fleetErrorCode
        ? FLEET_ERRORS.has(input.fleetErrorCode)
          ? input.fleetErrorCode
          : "OTHER"
        : null,
      listeningCount: input.listeningCount,
      push: category(input.pushState, ["off", "unavailable", "on"]),
      pushRegistered: input.pushRegistered,
      pushFailed: input.pushFailed,
    },
    null,
    2,
  );
}
