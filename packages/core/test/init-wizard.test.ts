import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FIXTURE_PROFILES, openForInit, openHermetic } from "../src/open.ts";
import {
  DB_FILENAME,
  clearConfig,
  defaultFleet,
  listConfigs,
  openLocalDb,
  readConfig,
  writeConfig,
} from "../src/local/db/index.ts";
import { FIXTURE_CONFIG, fixtureConfigFor } from "../src/backend/memory.ts";
import { PUBLIC_METHODS } from "../src/hermetic.ts";
import type { HermeticError } from "../src/errors.ts";
import { NO_FOUNDATION } from "../src/schema/index.ts";
import { drain } from "./helpers.ts";

const SCRATCH = tmpdir();

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(SCRATCH, "hermetic-wizard-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/**
 * §4.7 driven from the server: the wizard walks profiles → identity → foundation
 * → typed digits → create, and `--fixture` must let all of that happen with no
 * AWS account and no disk (AGENTS.md).
 */
describe("the fixture init wizard", () => {
  test("lists three profiles with regions and credential types", async () => {
    const session = await openForInit({ fixture: true, home });
    const profiles = await session.hermetic.init.listProfiles();
    expect(profiles).toEqual(FIXTURE_PROFILES);
    expect(profiles.map((p) => [p.name, p.region, p.credential_type])).toEqual([
      ["acme-dev", "us-west-2", "sso"],
      ["acme-prod", "us-east-1", "assume_role"],
      ["sandbox", "us-west-2", "static"],
    ]);
    session.close();
  });

  test("resolves acme-dev to the fixture account, alias and org", async () => {
    const session = await openForInit({ fixture: true, home });
    const identity = await session.hermetic.init.resolveIdentity("acme-dev", "us-west-2");
    expect(identity).toEqual({
      account_id: "123456789012",
      arn: FIXTURE_CONFIG.frozen_by,
      alias: "acme-dev",
      org_id: "o-fixture00",
      region: "us-west-2",
      profile: "acme-dev",
    });
    session.close();
  });

  test("reports no foundation, so the wizard walks the create branch", async () => {
    const session = await openForInit({ fixture: true, home });
    expect(await session.hermetic.init.describeFoundation("acme-dev", "us-west-2")).toEqual(
      NO_FOUNDATION,
    );
    session.close();
  });

  /** The gate of §4.7 step 3 is real in fixture mode too. */
  test("still refuses to create without the twelve typed digits", async () => {
    const session = await openForInit({ fixture: true, home });
    let code: string | null = null;
    try {
      await drain(session.hermetic.init({ profile: "acme-dev", region: "us-west-2" }));
    } catch (e) {
      code = (e as HermeticError).code;
    }
    expect(code).toBe("CONFIRMATION_REQUIRED");
    session.close();
  });

  test("the whole walkthrough writes nothing to disk and lands on the seeded fleet", async () => {
    const session = await openForInit({ fixture: true, home });

    // 1. pick a profile, 2. resolve its identity, 3. look for a foundation.
    const profile = (await session.hermetic.init.listProfiles())[0]!;
    const identity = await session.hermetic.init.resolveIdentity(profile.name, "us-west-2");
    const foundation = await session.hermetic.init.describeFoundation(profile.name, "us-west-2");
    expect(foundation.found).toBe(false);

    // 4. the operator types the twelve digits; 5. create.
    const events = await drain(
      session.hermetic.init({
        profile: profile.name,
        region: "us-west-2",
        account_id_typed: identity.account_id,
        tailnet: "acme.ts.net",
        tailscale_oauth_secret: "tskey-client-FIXTURE-OAUTH",
      }),
    );
    expect(events.at(-1)?.progress).toBe(1);
    expect(events.map((e) => e.phase)).toContain("foundation");

    // The fleet the wizard just created is now populated.
    const bound = session.bind({
      profile: profile.name,
      region: "us-west-2",
      accountId: identity.account_id,
    });
    const agents = await bound.agents.list();
    expect(agents).toHaveLength(12);
    expect(agents.map((a) => a.name)).toContain("atlas");

    // The frozen config is the one the wizard produced, not the fixture's.
    const shown = await bound.config.show();
    expect(shown.account_id).toBe("123456789012");
    expect(shown.profile).toBe("acme-dev");
    expect(shown.tailnet).toBe("acme.ts.net");

    session.close();

    // Nothing reached the operator's real home: no database, nothing at all.
    expect(existsSync(join(home, DB_FILENAME))).toBe(false);
    expect(readdirSync(home)).toEqual([]);

    // And `openHermetic({ fixture: true })` shows the same twelve.
    expect(await (await openHermetic({ fixture: true, home })).agents.list()).toHaveLength(12);
  });

  /**
   * `session.reopen()` is what a server head calls once `init` finishes, to
   * swap in a real instance without knowing the profile/region/account `bind`
   * needed. In fixture mode it must land on the exact same in-memory backend
   * and config store the wizard just wrote to — the posted `region`/`tailnet`
   * and the fixture agents it seeded, not a fresh unrelated fixture.
   */
  test("reopen() sees the region and tailnet the wizard posted, and the seeded agents", async () => {
    const session = await openForInit({ fixture: true, home });

    const profile = (await session.hermetic.init.listProfiles())[0]!;
    const identity = await session.hermetic.init.resolveIdentity(profile.name, "eu-west-1");
    await drain(
      session.hermetic.init({
        profile: profile.name,
        region: "eu-west-1",
        account_id_typed: identity.account_id,
        tailnet: "live.example.net",
      }),
    );

    const reopened = await session.reopen();
    const shown = await reopened.config.show();
    expect(shown.region).toBe("eu-west-1");
    expect(shown.tailnet).toBe("live.example.net");
    expect(await reopened.agents.list()).toHaveLength(12);

    session.close();
  });

  test("an explicit attach persists a fixture fleet missing from the local database", async () => {
    await openHermetic({ fixture: true, home });
    const staging = fixtureConfigFor("staging");
    const local = openLocalDb({ home, fixture: true });
    clearConfig(local.db, staging.fleet_id);
    const originalDefault = defaultFleet(local.db);
    local.close();

    const session = await openForInit({ fixture: true, home, fleet: "staging" });
    expect(session.home).toBe(home);
    expect(session.existingConfig).toBeNull();
    expect((await session.hermetic.init.describeFoundation("acme-dev", staging.region)).fleet_id).toBe(
      staging.fleet_id,
    );
    await drain(
      session.hermetic.init({
        attach: true,
        fleet: "staging",
        profile: staging.profile,
        region: staging.region,
        account_id_typed: staging.account_id,
      }),
    );
    session.close();

    const reopened = openLocalDb({ home, fixture: true });
    expect(listConfigs(reopened.db).map((f) => f.name)).toEqual(["main", "staging"]);
    expect(defaultFleet(reopened.db)).toBe(originalDefault);
    reopened.close();
  });

  test("the session's database is in-memory, never the operator's file", async () => {
    const session = await openForInit({ fixture: true, home });
    expect(session.home).toBe(":memory:");
    expect(session.existingConfig).toBeNull();
    expect(session.corruptedTo).toBeNull();
    session.close();
    expect(readdirSync(home)).toEqual([]);
  });

  test("an already-frozen real home is untouched by a fixture session", async () => {
    const local = openLocalDb({ home });
    writeConfig(local.db, FIXTURE_CONFIG);
    const before = readConfig(local.db);
    local.close();

    const session = await openForInit({ fixture: true, home });
    await drain(
      session.hermetic.init({
        profile: "sandbox",
        region: "us-west-2",
        account_id_typed: "123456789012",
        tailnet: "acme.ts.net",
      }),
    );
    session.close();

    const reopened = openLocalDb({ home });
    expect(readConfig(reopened.db)).toEqual(before);
    reopened.close();
  });

  test("the pre-init helpers are not public methods", () => {
    // They are inputs to the one `init` command, so parity stays one-to-one.
    expect(PUBLIC_METHODS).not.toContain("init.listProfiles");
    expect(PUBLIC_METHODS).not.toContain("init.resolveIdentity");
    expect(PUBLIC_METHODS).not.toContain("init.describeFoundation");
    expect(PUBLIC_METHODS.filter((m) => m.startsWith("init"))).toEqual(["init"]);
  });
});
