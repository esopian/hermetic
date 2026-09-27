import { describe, expect, test } from "bun:test";
import { AGENT_CONFIG_SCHEMA_VERSION } from "@hermetic/core/schema";
import {
  HERMETICD_CAPABILITIES,
  parseManifest,
  parseManifestJson,
  readBundleManifest,
} from "../src/manifest.ts";
import { AgentdError, EXIT_MANIFEST_REFUSED } from "../src/errors.ts";
import { makeManifest, TEST_NAME } from "./fixtures.ts";
import { FakeHost } from "./fake-host.ts";

describe("the manifest gate (§6.3 step 3)", () => {
  test("a manifest core's renderer would produce parses", () => {
    const manifest = makeManifest();
    expect(manifest.name).toBe(TEST_NAME);
    expect(manifest.schema_version).toBe(AGENT_CONFIG_SCHEMA_VERSION);
    expect(manifest.files.map((f) => f.path)).toContain("/etc/systemd/system/hermes-dashboard.service");
  });

  test("schema_version 99 is refused, and refusal is exit code 3", () => {
    const future = { ...makeManifest(), schema_version: 99 };
    let thrown: unknown;
    try {
      parseManifest(future);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AgentdError);
    const error = thrown as AgentdError;
    expect(error.code).toBe("MANIFEST_REFUSED");
    expect(error.exitCode).toBe(EXIT_MANIFEST_REFUSED);
    expect(error.message).toContain("99");
  });

  test("a manifest missing a required field is refused, not coerced", () => {
    const { units: _units, ...withoutUnits } = makeManifest();
    expect(() => parseManifest(withoutUnits)).toThrow(AgentdError);
    try {
      parseManifest(withoutUnits);
    } catch (e) {
      expect((e as AgentdError).code).toBe("MANIFEST_REFUSED");
    }
  });

  test("malformed JSON is refused with exit code 3, never a crash", () => {
    let thrown: unknown;
    try {
      parseManifestJson("{ not json");
    } catch (e) {
      thrown = e;
    }
    expect((thrown as AgentdError).code).toBe("MANIFEST_REFUSED");
    expect((thrown as AgentdError).exitCode).toBe(EXIT_MANIFEST_REFUSED);
  });

  test("the JSON bundle core renders in fixtures unpacks to its manifest", async () => {
    const manifest = makeManifest();
    const bundle = new TextEncoder().encode(JSON.stringify({ manifest, extra: [] }));
    const parsed = await readBundleManifest(bundle, new FakeHost());
    expect(parsed.config_hash).toBe(manifest.config_hash);
  });

  test("a bundle whose manifest is from the future is refused at unpack time", async () => {
    const bundle = new TextEncoder().encode(
      JSON.stringify({ manifest: { ...makeManifest(), schema_version: 99 } }),
    );
    await expect(readBundleManifest(bundle, new FakeHost())).rejects.toThrow(/schema_version 99/);
  });

  /**
   * The §6.3 gate's second half: a manifest whose *shape* this build understands
   * but whose *requirements* it does not. It is refused before a byte is written,
   * because half an applied configuration is worse than none, and the message
   * names the release remedy rather than whatever systemd would have said three
   * steps later.
   */
  describe("capabilities", () => {
    test("a manifest needing something this build lacks is refused, with the fix", () => {
      const manifest = { ...makeManifest(), requires: ["time-travel"] };
      let thrown: unknown;
      try {
        parseManifest(manifest);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(AgentdError);
      expect((thrown as AgentdError).code).toBe("MANIFEST_REFUSED");
      expect((thrown as AgentdError).message).toContain("time-travel");
      expect((thrown as AgentdError).message).toContain("hermetic artifacts push");
      expect((thrown as AgentdError).message).toContain("Nothing has been applied");
    });

    test("the capabilities this build does implement are accepted", () => {
      const manifest = { ...makeManifest(), requires: [...HERMETICD_CAPABILITIES] };
      expect(parseManifest(manifest).requires).toEqual([...HERMETICD_CAPABILITIES]);
    });

    /**
     * A manifest rendered before the field, which is every manifest in every
     * fleet today. Absent asks nothing and must keep applying.
     */
    test("a manifest that asks nothing is not refused", () => {
      expect(parseManifest(makeManifest()).requires).toBeUndefined();
    });
  });
});
