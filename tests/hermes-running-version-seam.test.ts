/**
 * Seam: the Hermes version string the laptop pins (`hermes_version`) must equal, byte for byte,
 * what the box reports back (`running_hermes_version`), because `hermesDeferral` compares them
 * with `===`. Chain: manifest `hermes_version` -> `installStamp` -> (Hermes `/api/health`
 * `version`) -> `versionFromHealth` -> heartbeat row field -> `hermesDeferral`.
 * Gap: for 0.21.5 Hermes reads its checkout's `pyproject.toml`, not a stamp; no test can run that.
 */
import { describe, expect, test } from "bun:test";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { makeAws } from "../packages/agentd/src/aws.ts";
import { installStamp } from "../packages/agentd/src/apply/hermes.ts";
import { HERMES_HEALTH_URL, makeHeartbeat } from "../packages/agentd/src/heartbeat.ts";
import { FakeHost } from "../packages/agentd/test/fake-host.ts";
import { RecordingSink, TEST_NAME } from "../packages/agentd/test/fixtures.ts";
import { hermesDeferral } from "../packages/core/src/agents/converge.ts";
import { BUILD_VERSIONS } from "../packages/core/src/build-versions.ts";
import { hermesRefFor, hermesTagVersion } from "../packages/core/src/shared/hermes.ts";

const PINS = ["0.21.5", BUILD_VERSIONS.hermes];

/** One heartbeat tick against a Hermes whose `/api/health` says `version`; what the row got. */
async function reported(version: string): Promise<string | undefined> {
  const host = new FakeHost();
  host.handlers.push((argv) =>
    argv[0] === "systemctl"
      ? { code: 0, stdout: "ActiveState=active\nSubState=running\n", stderr: "" }
      : null,
  );
  const ddb = new RecordingSink();
  ddb.byCommand.set("GetCommand", () => ({
    Item: { name: TEST_NAME, status: "ready", version: 4, config_hash: "abc123def4567890" },
  }));
  ddb.byCommand.set("UpdateCommand", () => ({}));
  const fetchImpl = (async (input: string) =>
    String(input) === HERMES_HEALTH_URL
      ? Response.json({ ok: true, version })
      : new Response("ok")) as unknown as typeof fetch;
  const aws = makeAws({
    ddb,
    ssm: new RecordingSink(),
    s3: new RecordingSink(),
    agentsTable: "hermetic-agents",
    eventsTable: "hermetic-events",
    now: () => host.now(),
    warn: () => {},
  });
  const beat = makeHeartbeat({
    host,
    aws,
    name: TEST_NAME,
    hermeticdVersion: "0.1.0",
    fetchImpl,
    onUpdateRequest: () => {},
  });
  await beat.once();
  const update = ddb.commandCalls(UpdateCommand).at(-1);
  const names = update?.input.ExpressionAttributeNames ?? {};
  expect(Object.values(names)).toContain("running_hermes_version");
  return update?.input.ExpressionAttributeValues?.[":hv"];
}

describe("pinned Hermes version == box-reported Hermes version", () => {
  for (const v of PINS) {
    test(`${v}: stamp, heartbeat and deferral agree`, async () => {
      // (a) the stamp upstream reads names exactly the manifest's version
      const stamp = JSON.parse(installStamp("0".repeat(40), v)) as Record<string, unknown>;
      expect(stamp["baseVersion"]).toBe(v);
      expect(stamp["displayVersion"]).toBe(v);

      // (b) health `{version: v}` (padded or not) lands on the row unchanged
      expect(await reported(v)).toBe(v);
      const padded = await reported(`  ${v}\n`);
      expect(padded).toBe(v);

      // (c) equal -> no deferral; any other spelling defers
      const row = (running: string) => ({
        name: "atlas",
        hermes_version: v,
        running_hermes_version: running,
      });
      expect(hermesDeferral(row(padded as string), BUILD_VERSIONS.hermes, false)).toBeNull();
      expect(hermesDeferral(row(`v${v}`), BUILD_VERSIONS.hermes, false)).not.toBeNull();
      expect(hermesDeferral(row(`${v}+g1234567`), BUILD_VERSIONS.hermes, false)).not.toBeNull();
    });
  }

  test("ref and version round-trip", () => {
    expect(hermesRefFor("0.21.5")).toBe("v2026.9.24");
    expect(hermesTagVersion(hermesRefFor(BUILD_VERSIONS.hermes) ?? "")).toBe(BUILD_VERSIONS.hermes);
    expect(hermesRefFor(BUILD_VERSIONS.hermes)).toBe(BUILD_VERSIONS.hermes_ref);
  });
});
