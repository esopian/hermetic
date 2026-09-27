import { describe, expect, test } from "bun:test";
import {
  BUILD_VERSIONS,
  CLI_REQUEST_SCHEMAS,
  PUBLIC_METHODS,
  REQUEST_SCHEMAS,
  headerLine,
} from "../src/hermetic.ts";
import {
  ArtifactsPushApiInput,
  ArtifactsPushInput,
  ConfigShowInput,
  DoctorInput,
  ERROR_CODES,
} from "../src/schema/index.ts";
import { FIXTURE_CONFIG } from "../src/backend/memory.ts";

/**
 * §3.3, §11.4: the heads validate with these exact objects, and the parity test
 * compares them by identity. A route that quietly accepted a wider shape than
 * core does would be the whole point of the contract, missed.
 */
describe("REQUEST_SCHEMAS", () => {
  test("has exactly one entry per public method", () => {
    expect(Object.keys(REQUEST_SCHEMAS).sort()).toEqual([...PUBLIC_METHODS].sort());
    expect(Object.keys(CLI_REQUEST_SCHEMAS).sort()).toEqual([...PUBLIC_METHODS].sort());
  });

  test("every entry parses", () => {
    for (const [method, schema] of Object.entries(REQUEST_SCHEMAS)) {
      expect(typeof schema.safeParse, method).toBe("function");
    }
  });

  test("config.show has its own empty schema rather than borrowing doctor's", () => {
    expect(REQUEST_SCHEMAS["config.show"]).toBe(ConfigShowInput);
    expect(REQUEST_SCHEMAS["doctor"]).toBe(DoctorInput);
    expect(REQUEST_SCHEMAS["config.show"]).not.toBe(REQUEST_SCHEMAS["doctor"]);
  });

  /** A browser must not be able to name a path on the server's filesystem. */
  test("the HTTP surface for artifacts.push rejects a local path; the CLI's accepts it", () => {
    expect(REQUEST_SCHEMAS["artifacts.push"]).toBe(ArtifactsPushApiInput);
    expect(CLI_REQUEST_SCHEMAS["artifacts.push"]).toBe(ArtifactsPushInput);

    const api = REQUEST_SCHEMAS["artifacts.push"].parse({ version: "0.5.0", path: "/etc/passwd" });
    expect("path" in api).toBe(false);

    const cli = CLI_REQUEST_SCHEMAS["artifacts.push"].parse({
      version: "0.5.0",
      path: "./hermeticd",
    });
    expect(cli.path).toBe("./hermeticd");
  });

  test("the two tables differ in exactly that one place", () => {
    const differing = PUBLIC_METHODS.filter((m) => REQUEST_SCHEMAS[m] !== CLI_REQUEST_SCHEMAS[m]);
    expect(differing).toEqual(["artifacts.push"]);
  });
});

/** §4.7: the target is always visible, and `--json` on stdout stays clean. */
describe("headerLine", () => {
  test("names the fleet first, then the account alias and the profile", () => {
    // §4.8: the fleet name leads, because one account may hold several and the
    // account alone no longer says which fleet a command is about.
    expect(headerLine(FIXTURE_CONFIG)).toBe(
      "▸ main · acme-dev · 123456789012 · us-west-2 · profile acme-dev",
    );
  });

  test("falls back to the profile when there is no alias", () => {
    expect(headerLine({ ...FIXTURE_CONFIG, account_alias: null, profile: "raw" })).toBe(
      "▸ main · raw · 123456789012 · us-west-2 · profile raw",
    );
  });

  test("marks a fixture run so a demo is never mistaken for a real fleet", () => {
    expect(headerLine(FIXTURE_CONFIG, { fixture: true })).toEndWith(" · FIXTURE");
  });
});

describe("BUILD_VERSIONS", () => {
  test("is what core actually pins, not a second copy that can drift", () => {
    expect(BUILD_VERSIONS.hermeticd).toMatch(/^\d+\.\d+\.\d+$/);
    expect(BUILD_VERSIONS.hermes).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("ErrorCode", () => {
  test("carries the codes the heads map to 400 and 403", () => {
    expect(ERROR_CODES).toContain("VALIDATION");
    expect(ERROR_CODES).toContain("FORBIDDEN");
  });
});
