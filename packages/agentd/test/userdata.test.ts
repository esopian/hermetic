import { describe, expect, test } from "bun:test";
import {
  USER_DATA_FIELDS,
  USER_DATA_JSON_PATH,
  extractUserDataJson,
  httpImds,
  loadUserData,
  parseUserData,
} from "../src/userdata.ts";
import { agentParamPrefix, paramPath } from "../src/fleet.ts";
import { AgentdError } from "../src/errors.ts";
import { makeFleetManifest, makeUserDataJson, TEST_BUCKET, TEST_NAME } from "./fixtures.ts";

describe("user-data (§6.2 step 7 / §6.3 step 1)", () => {
  test("parses the exact shape core's userData() writes", () => {
    const data = parseUserData(makeUserDataJson());
    expect(data.name).toBe(TEST_NAME);
    expect(data.bucket).toBe(TEST_BUCKET);
    expect(data.hermeticd_url).toContain("artifacts/0.1.0/hermeticd");
    expect(data.hermeticd_sha256).toHaveLength(63 + 1);
  });

  /**
   * §4.2: the table names, the SSM prefix and the rest of the fleet's resources
   * moved to the fleet manifest. User-data is now four fields — a name, a
   * bucket, and a verifiable way to get the one binary — and nothing else may
   * creep back into it.
   */
  test("it carries exactly the fields core's UserDataFields declares", () => {
    expect([...USER_DATA_FIELDS]).toEqual(["name", "bucket", "hermeticd_url", "hermeticd_sha256"]);
  });

  /**
   * The field this parse used to drop on the floor. `hostname` is what the box
   * calls itself and what it asks the tailnet for (`HERMETIC_HOSTNAME` →
   * `01-tailscale.sh`), so losing it is not a missing convenience: the node
   * joins under the pre-v4 spelling and the laptop's dashboard link points at a
   * name nothing answers to.
   */
  test("hostname survives the parse — the tailnet name depends on it", () => {
    const data = parseUserData(makeUserDataJson({ hostname: "k7m2x9qa-atlas" }));
    expect(data.hostname).toBe("k7m2x9qa-atlas");
  });

  test("a box launched before the field has none, and falls back to the agent name", () => {
    const blob = JSON.parse(makeUserDataJson()) as Record<string, unknown>;
    delete blob["hostname"];
    expect(parseUserData(JSON.stringify(blob)).hostname).toBeUndefined();
  });

  /**
   * Absent is an older box; present-and-malformed is a launch *this* hermetic
   * wrote, and quietly falling back would mis-name it.
   */
  test.each([["", "empty"] as const, [42, "non-string"] as const])(
    "rejects a %s hostname (%s)",
    (value) => {
      const blob = JSON.parse(makeUserDataJson()) as Record<string, unknown>;
      blob["hostname"] = value;
      let thrown: unknown;
      try {
        parseUserData(JSON.stringify(blob));
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(AgentdError);
      expect((thrown as AgentdError).code).toBe("USERDATA_INVALID");
      expect((thrown as AgentdError).message).toContain("hostname");
    },
  );

  test("the fleet bucket is taken from user-data, not guessed", () => {
    const data = parseUserData(makeUserDataJson({ bucket: "some-other-bucket" }));
    // The presigned URL still names `hermetic-fleet-…`; the explicit field wins.
    expect(data.bucket).toBe("some-other-bucket");
  });

  test.each(["name", "bucket", "hermeticd_url", "hermeticd_sha256"])(
    "rejects user-data missing %s",
    (field) => {
      const blob = JSON.parse(makeUserDataJson()) as Record<string, unknown>;
      delete blob[field];
      let thrown: unknown;
      try {
        parseUserData(JSON.stringify(blob));
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(AgentdError);
      expect((thrown as AgentdError).code).toBe("USERDATA_INVALID");
      expect((thrown as AgentdError).message).toContain(field);
    },
  );

  test("IMDS hands back the cloud-init script; the here-doc body is extracted", () => {
    const json = makeUserDataJson();
    const script = [
      "#!/bin/bash",
      "set -euo pipefail",
      "cat > /var/lib/cloud/instance/hermetic.json <<'HERMETIC_JSON'",
      json,
      "HERMETIC_JSON",
      "exec /usr/local/bin/hermeticd bootstrap",
    ].join("\n");

    expect(extractUserDataJson(script)).toBe(json);
    expect(parseUserData(script).name).toBe(TEST_NAME);
  });

  test("user-data that is neither JSON nor a hermetic script points at the cached blob", () => {
    let thrown: unknown;
    try {
      parseUserData("#!/bin/bash\necho unrelated cloud-init\n");
    } catch (e) {
      thrown = e;
    }
    expect((thrown as AgentdError).code).toBe("USERDATA_INVALID");
    expect((thrown as AgentdError).message).toContain(USER_DATA_JSON_PATH);
  });

  test("rejects non-object user-data", () => {
    expect(() => parseUserData('["a"]')).toThrow(/not a JSON object/);
    expect(() => parseUserData("{ not json")).toThrow(/not valid JSON/);
  });

  test("no field may look like a secret — user-data carries paths, never values", () => {
    const withKey = makeUserDataJson({ bucket: "tskey-auth-kSomethingSecret123" });
    expect(() => parseUserData(withKey)).toThrow(/tailscale auth key/);

    const withToken = makeUserDataJson({
      name: "0.4b1c2d3e-1111-2222-3333-444455556666.YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=",
    });
    expect(() => parseUserData(withToken)).toThrow(/bitwarden access token/);

    const withAws = makeUserDataJson({ hermeticd_sha256: "AKIAIOSFODNN7EXAMPLE" });
    expect(() => parseUserData(withAws)).toThrow(/aws access key/);
  });

  test("the presigned URL's own signature is not mistaken for a leaked secret", () => {
    const signed = makeUserDataJson({
      hermeticd_url:
        "https://b.s3.us-east-1.amazonaws.com/artifacts/0.1.0/hermeticd?X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20260901",
    });
    expect(() => parseUserData(signed)).not.toThrow();
  });

  /**
   * The agent's own prefix is derived, not carried: the fleet manifest holds
   * `/hermes/` and the agent name is already in user-data, so there is one
   * fewer field that can disagree with itself.
   */
  test("the SSM prefix comes from the fleet manifest plus the agent name", () => {
    const fleet = makeFleetManifest();
    expect(agentParamPrefix(fleet, TEST_NAME)).toBe(`/hermes/${TEST_NAME}/`);
    const noSlash = { ...fleet, resources: { ...fleet.resources, param_prefix: "/hermes" } };
    expect(agentParamPrefix(noSlash, TEST_NAME)).toBe(`/hermes/${TEST_NAME}/`);
  });

  test("paramPath builds the SSM slot paths, with or without a trailing slash", () => {
    expect(paramPath(`/hermes/${TEST_NAME}/`, "ts-key")).toBe(`/hermes/${TEST_NAME}/ts-key`);
    expect(paramPath(`/hermes/${TEST_NAME}`, "bws-token")).toBe(`/hermes/${TEST_NAME}/bws-token`);
  });

  test("IMDSv2: a token is minted with PUT before user-data is fetched", async () => {
    const seen: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      seen.push({
        url: href,
        method: init?.method ?? "GET",
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      if (href.endsWith("/latest/api/token")) return new Response("TOKEN-1");
      if (href.endsWith("/latest/user-data")) return new Response(makeUserDataJson());
      return new Response("us-east-1");
    }) as unknown as typeof fetch;

    const data = await loadUserData(httpImds(fakeFetch));
    expect(data.name).toBe(TEST_NAME);
    expect(seen[0]?.method).toBe("PUT");
    expect(seen[0]?.url).toEndWith("/latest/api/token");
    expect(seen[1]?.url).toEndWith("/latest/user-data");
    expect(seen[1]?.headers["x-aws-ec2-metadata-token"]).toBe("TOKEN-1");
  });
});
