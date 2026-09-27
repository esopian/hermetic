/**
 * The user-data contract: what core *writes* into the cloud-init blob (§6.2
 * step 7) against what hermeticd *reads* back out of it (§6.3 step 1).
 *
 * It lives here rather than in either package because it is the one assertion
 * neither side can make alone: core may not import agentd, agentd may reach only
 * `@hermetic/core/schema`, and `cloud-init.ts`/`userdata.ts` are therefore two
 * hand-kept mirrors of one document. Nothing in either package failed when they
 * drifted — `hostname` was added to core's `UserDataFields`, to the script, to
 * agentd's `UserData` interface and to every consumer of it, and left out of the
 * four literals `parseUserData` built its result from. The field simply arrived
 * `undefined` on every box: `HERMETIC_HOSTNAME` fell back to the agent name, and
 * a foundation-v4 fleet went on joining the tailnet under the v3 spelling while
 * the instance tag, the row and the plan all said otherwise.
 *
 * `Required<UserDataFields>` is deliberate: a new optional field is a type error
 * here until it is written down, and the round-trip below then fails until
 * hermeticd actually keeps it.
 */
import { describe, expect, test } from "bun:test";
import { cloudInitUserData, userDataJson } from "../packages/core/src/render/cloud-init.ts";
import type { UserDataFields } from "../packages/core/src/render/cloud-init.ts";
import { parseUserData } from "../packages/agentd/src/userdata.ts";

const FIELDS: Required<UserDataFields> = {
  name: "atlas",
  hostname: "k7m2x9qa-atlas",
  bucket: "hermetic-k7m2x9qa-123456789012-us-east-1",
  hermeticd_url:
    "https://hermetic-k7m2x9qa-123456789012-us-east-1.s3.us-east-1.amazonaws.com/artifacts/0.5.0/hermeticd?X-Amz-Expires=3600",
  hermeticd_sha256: "a".repeat(64),
};

describe("user-data round-trips from core to hermeticd", () => {
  test("hermeticd keeps every field core writes", () => {
    const parsed = parseUserData(userDataJson(FIELDS)) as unknown as Record<string, unknown>;
    for (const [field, value] of Object.entries(FIELDS)) {
      expect({ field, value: parsed[field] }).toEqual({ field, value });
    }
  });

  test("it survives the cloud-init script IMDS hands back verbatim", () => {
    const parsed = parseUserData(cloudInitUserData(userDataJson(FIELDS)));
    expect(parsed.hostname).toBe(FIELDS.hostname);
    expect(parsed.name).toBe(FIELDS.name);
  });

  /**
   * The one thing the script does with `hostname` before hermeticd exists: the
   * OS hostname is set from it, falling back to the agent name, so a box is
   * named correctly even if it never gets as far as a stage.
   */
  test("the script names the box from hostname, not from name", () => {
    const script = cloudInitUserData(userDataJson(FIELDS));
    expect(script).toContain('hostnamectl set-hostname "${host:-$name}"');
  });

  /**
   * A pre-v3 box carries no `hostname`, and that is not an error — it falls back
   * to the agent name, which is what such a box is already called.
   */
  test("an older box with no hostname still parses", () => {
    const { hostname: _omitted, ...older } = FIELDS;
    const parsed = parseUserData(userDataJson(older));
    expect(parsed.hostname).toBeUndefined();
    expect(parsed.name).toBe(FIELDS.name);
  });
});
