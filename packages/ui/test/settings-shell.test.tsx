/**
 * The Settings shell's section routing, rendered.
 *
 * Static markup only — effects do not run, so nothing here fetches, which is
 * also the point being asserted: the body holds exactly one section, so the
 * three sections that read the network (doctor, policy, runs) are not even
 * mounted unless their rail entry is the active one.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Meta, ProviderCatalog, SharedSecretView } from "../src/api/index.ts";
import { SecretPushDrawer } from "../src/components/settings/SecretDrawers.tsx";
import { SecretsTable } from "../src/components/settings/SecretsSection.tsx";
import { SettingsShell } from "../src/components/settings/SettingsShell.tsx";
import { NotifyProvider } from "../src/state/notify-state.tsx";
import type { NotifyApi } from "../src/state/notify-state.tsx";
import { SETTINGS_SECTIONS } from "../src/nav/settings-nav.ts";
import { FIXTURE_PROFILES, fixtureProfilesState, profilesState } from "./profiles-fixture.ts";
import type { ProfilesState } from "../src/state/state.tsx";
import type { SettingsSection } from "../src/nav/settings-nav.ts";

const CATALOG = {
  bedrock: {
    label: "Bedrock",
    auth: "role",
    env: null,
    base_url: null,
    hermes_provider: "bedrock",
    hermes_provider_entry: false,
    default_model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    description: "Claude via the instance role — no key exists on the box",
  },
  nous: {
    label: "Nous Portal",
    auth: "api_key",
    env: "NOUS_API_KEY",
    base_url: "https://inference-api.nousresearch.com/v1",
    hermes_provider: "hermetic-nous",
    hermes_provider_entry: true,
    default_model: "deepseek/deepseek-v4.1-flash",
    description: "Nous Research Portal inference API, keyed per agent",
  },
};

function meta(over: Record<string, unknown> = {}): Meta {
  return {
    header: "▸ fixture",
    home: "/tmp/hermetic-home",
    initialized: true,
    config: {
      schema_version: 1,
      fleet_id: "aurora",
      account_id: "123456789012",
      account_alias: "hermetic-dev",
      org_id: "o-abc",
      profile: "default",
      region: "us-west-2",
      frozen_at: "2026-09-01T00:00:00.000Z",
      frozen_by: "evan",
      stack_id: "arn:aws:cloudformation:us-west-2:123456789012:stack/hermetic-aurora/1",
      tailnet: "example.ts.net",
      tailscale_oauth_client_id: "kAbC123",
    },
    fixture: true,
    hermes_version: "1.2.0",
    hermeticd_version: "0.4.1",
    tailnet: "example.ts.net",
    last_teardown: null,
    foundation: {
      fleet: {
        foundation_version: 2,
        template_sha256: "a".repeat(64),
        hermeticd_version: "0.4.1",
        ubuntu_release: "noble",
        ami_id: "ami-0123456789abcdef0",
      },
      available: {
        foundation_version: 2,
        template_sha256: "a".repeat(64),
        hermeticd_version: "0.4.1",
      },
      update_available: false,
      tool_outdated: false,
      in_progress: null,
      agents: [],
    },
    settings: {
      persisted: true,
      catalog: CATALOG,
      settings: {
        version: 3,
        defaults: {
          size: "medium",
          provider: "nous",
          volume_gib: 100,
          browser: true,
          secrets: "none",
        },
        agent_defaults: { max_turns: 500 },
        providers: {
          bedrock: { enabled: true },
          nous: { enabled: true, default_model: "deepseek-v4-flash-0731", secret: "nous-key" },
        },
        secrets: [],
        updated_at: "2026-09-06T00:00:00.000Z",
        updated_by: "evan",
      },
    },
    ...over,
  } as unknown as Meta;
}

const STUB_NOTIFY_API: NotifyApi = {
  fetchNotifications: () =>
    Promise.resolve({ notifications: [], unread: 0, needs_action: 0, mutes: [] } as never),
  ackNotification: () => Promise.resolve({ acked: 0 } as never),
  muteNotification: () => Promise.resolve({ mutes: [] } as never),
};

function shell(
  section: SettingsSection,
  over: Record<string, unknown> = {},
  profiles: ProfilesState = profilesState(),
): string {
  // Settings → Notifications reads the inbox from `NotifyProvider`, so the
  // shell is wrapped in one. Effects do not run under `renderToStaticMarkup`,
  // so nothing here fetches — the provider contributes its empty initial state
  // and the three API calls are stubbed anyway.
  // JSX, and so this file is `.tsx`: `NotifyProvider` declares `children` as a
  // required prop, which `createElement`'s positional-children overload does
  // not reconcile — and passing it in the props object instead is what
  // `noChildrenProp` forbids. JSX spells both correctly at once.
  return renderToStaticMarkup(
    <NotifyProvider api={STUB_NOTIFY_API}>
      <SettingsShell
        meta={meta(over)}
        profiles={profiles}
        section={section}
        onSection={() => {}}
        onBack={() => {}}
        onOpenTeardown={() => {}}
        onOpenFoundationUpdate={() => {}}
      />
    </NotifyProvider>,
  );
}

/**
 * One string per section that appears only when that section is the body.
 * Deliberately not the rail label — every label is on every render, which is
 * what a rail is for — so these are the first line of each section's content.
 */
const MARKER: Record<SettingsSection, string> = {
  account: "account id",
  defaults: "Secrets mode",
  providers: "New profile",
  secrets: "Add secret",
  policy: "reading the tailnet policy…",
  foundation: "foundation version",
  diagnostics: "Run doctor",
  presets: "Reset to built-in",
  chat: "Avatar style",
  notifications: "unread only",
  runs: "reading the local run log…",
  danger: "TEAR DOWN THE FOUNDATION",
};

/** A label as static markup spells it (`Account & fleets`). */
const html = (s: string) => s.replace(/&/g, "&amp;");

describe("SettingsShell", () => {
  test("the rail lists every section, on every section", () => {
    for (const s of SETTINGS_SECTIONS) {
      const out = shell(s.id);
      for (const other of SETTINGS_SECTIONS) {
        expect(out).toContain(`<span class="st-ri-l">${html(other.label)}</span>`);
      }
    }
  });

  test("the rail is grouped Fleet · Infrastructure · This laptop · Account, Danger alone last", () => {
    const out = shell("defaults");
    const heads = [...out.matchAll(/<div class="st-rgh"[^>]*><span>([^<]+)<\/span>/g)].map((m) => m[1]);
    expect(heads).toEqual(["Fleet", "Infrastructure", "This laptop", "Account"]);
    // The Fleet header names the fleet the group's pages save to.
    expect(out).toMatch(/<span>Fleet<\/span><span class="mono">aurora<\/span>/);
    // Danger sits under its own rule, after every group, and in no group.
    const danger = out.slice(out.indexOf('class="st-rdanger"'));
    expect(danger).toContain('data-rail="danger"');
    expect(danger).not.toContain('class="st-rg"');
  });

  test("exactly one rail entry is marked current, and it is the active one", () => {
    for (const s of SETTINGS_SECTIONS) {
      const out = shell(s.id);
      expect(out.match(/aria-current="page"/g)?.length).toBe(1);
      expect(out).toMatch(
        new RegExp(`aria-current="page"[\\s\\S]*?<span class="st-ri-l">${html(s.label)}</span>`),
      );
      expect(out).toContain(`data-section="${s.id}"`);
    }
  });

  test("Danger, and only Danger, is red and carries the bad square", () => {
    for (const s of SETTINGS_SECTIONS) {
      const out = shell(s.id);
      // Once per render, whichever section is open: the rail always draws it.
      expect(out.match(/class="st-ri st-ri-d/g)?.length).toBe(1);
      expect(out).toMatch(
        /st-ri-d[^>]*><span class="sq bad"[^>]*><\/span><span class="st-ri-l">Danger zone/,
      );
    }
  });

  test("rail squares come only from data already on the page", () => {
    const current = { ...meta().foundation, stale_bedrock_grants: [] };
    const item = (out: string, id: string) => {
      const at = out.indexOf(`data-rail="${id}"`);
      return out.slice(at, out.indexOf("</a>", at));
    };
    const out = shell("account", { foundation: current }, fixtureProfilesState());
    // Five profiles, one of them enabled and not ready: a warn square and a count.
    expect(item(out, "providers")).toContain('class="sq warn"');
    expect(item(out, "providers")).toContain("<em>5</em>");
    // A current foundation with its grant recorded: an ok square and its version.
    expect(item(out, "foundation")).toContain('class="sq ok"');
    expect(item(out, "foundation")).toContain("<em>v2</em>");
    // Sections whose health needs their own read carry no square at all.
    for (const id of ["secrets", "policy", "diagnostics", "runs"]) {
      expect(item(out, id)).toContain('class="st-nosq"');
    }
    // An update available turns the foundation square to warn.
    const behind = shell("account", { foundation: { ...current, update_available: true } });
    expect(item(behind, "foundation")).toContain('class="sq warn"');
  });

  test("every page states its scope once: fleet-wide, this laptop, or read-only", () => {
    const scope: Record<SettingsSection, string> = {
      account: "st-ro",
      defaults: "st-fleet",
      providers: "st-fleet",
      secrets: "st-fleet",
      policy: "st-fleet",
      foundation: "st-fleet",
      diagnostics: "st-ro",
      presets: "st-laptop",
      chat: "st-laptop",
      notifications: "st-laptop",
      runs: "st-laptop",
      danger: "st-fleet",
    };
    for (const s of SETTINGS_SECTIONS) {
      const out = shell(s.id);
      expect(out.match(/class="st-scope /g)?.length).toBe(1);
      expect(out).toContain(`class="st-scope ${scope[s.id]}"`);
    }
    // A fleet-wide page names the fleet it saves to, by id.
    expect(shell("defaults")).toContain('Fleet-wide · saved to <b class="mono">aurora</b>');
  });

  test("the body is one section: its marker, and nobody else's", () => {
    for (const s of SETTINGS_SECTIONS) {
      const out = shell(s.id);
      expect(out).toContain(MARKER[s.id]);
      for (const other of SETTINGS_SECTIONS) {
        if (other.id === s.id) continue;
        expect(out).not.toContain(MARKER[other.id]);
      }
    }
  });

  test("each section opens with its own title", () => {
    for (const s of SETTINGS_SECTIONS) {
      const out = shell(s.id);
      expect(out).toContain(`<h2 class="st-title">${html(s.label)}</h2>`);
      expect(out.match(/class="st-title"/g)?.length).toBe(1);
    }
    // DANGER keeps its own red block and title inside it (`docs/ui-brief.md`).
    expect(shell("danger")).toContain('class="danger-title"');
  });

  test("Foundation names the image the fleet was built on", () => {
    // Off `_fleet`, via `foundation.status` — the rows Fleet defaults used to
    // guess at from a `/api/config` field no payload ever carried.
    const out = shell("foundation");
    expect(out).toContain("ubuntu release");
    expect(out).toContain("noble");
    expect(out).toContain("ami id");
    expect(out).toContain("ami-0123456789abcdef0");
  });

  test("the body keeps the brief's centred column, beside the rail", () => {
    const out = shell("account");
    expect(out).toContain('class="st-view"');
    expect(out).toContain('class="st-page"');
    // `← Fleet` is still the way out, from every section.
    expect(shell("providers")).toContain("← Fleet");
  });
});

describe("ProvidersSection", () => {
  const fixture = fixtureProfilesState();

  test("lists every profile the fleet holds, with its provider, model and readiness", () => {
    const out = shell("providers", {}, fixture);
    for (const p of FIXTURE_PROFILES) {
      expect(out).toContain(`data-profile="${p.id}"`);
      expect(out).toContain(p.name);
      expect(out).toContain(p.model);
    }
    // One square per state, named by `provider-logic.ts`'s word for it.
    expect(out).toContain('aria-label="ready"');
    expect(out).toContain('aria-label="placeholder"');
    expect(out).toContain('aria-label="disabled"');
    // Exactly one profile is the fleet default, and it says so — a chip on
    // the row, not a card of its own.
    expect(out.match(/>fleet default</g)?.length).toBe(1);
    // A profile that is not ready says why in one mono line.
    const nous = out.slice(out.indexOf('data-profile="n0us1ab0"'));
    expect(nous).toContain('class="st-why"');
    expect(nous).toContain("placeholder written when it was created");
  });

  test("a row shows at most two verbs, and the rest are under its menu", () => {
    const out = shell("providers", {}, fixture);
    const rows = out.split("<tr data-profile=").slice(1);
    for (const row of rows) {
      expect(row.match(/class="st-tb[^"]*"/g)?.length).toBeLessThanOrEqual(2);
      expect(row).toContain('aria-haspopup="menu"');
    }
    // A disabled profile's second verb is Enable; a placeholder key's is Set key.
    expect(out.slice(out.indexOf('data-profile="v3rc3l00"'))).toMatch(/^[\s\S]*?>Enable</);
    expect(out.slice(out.indexOf('data-profile="n0us1ab0"'))).toMatch(/^[\s\S]*?>Set key</);
  });

  test("a profile with agents on it names them", () => {
    const out = shell("providers", {}, fixture);
    const anthropic = out.slice(out.indexOf('data-profile="an7hr0p1"'));
    // …the row shows who they are, not just how many. (Delete's refusal, which
    // names them again, is in the row's menu: `settings-template.dom.test.tsx`.)
    expect(anthropic).toContain(">lumen<");
  });

  test("a role-authenticated profile has no key to rotate, and the refusal stays visible", () => {
    const out = shell("providers", {}, fixture);
    const bedrock = out.slice(out.indexOf('data-profile="b3dr0ck0"'));
    expect(bedrock).toContain("IAM role");
    expect(bedrock).toMatch(/disabled="" title="[^"]*there is no key to rotate/);
  });

  test("a Bedrock model the fleet has not granted links to the foundation update", () => {
    const ungranted = FIXTURE_PROFILES.map((p) =>
      p.id === "b3dr0ck0"
        ? {
            ...p,
            ready: false,
            ready_reason: "grant-missing" as const,
            grant: "needs_foundation_update" as const,
          }
        : p,
    );
    const out = shell("providers", {}, fixtureProfilesState({ list: ungranted }));
    expect(out).toContain("Run a foundation update");
    expect(out).toContain("needs foundation update");
  });

  test("a fleet with no profiles says so, rather than drawing an empty list", () => {
    const out = shell("providers", {}, profilesState());
    expect(out).toContain("No provider profiles");
    expect(out).toContain("never asks for a key");
  });

  test("no save bar until something is dirty", () => {
    expect(shell("providers")).not.toContain('class="st-save');
    expect(shell("defaults")).not.toContain('class="st-save');
  });

  test("without settings on the meta payload it says so, rather than showing an empty table", () => {
    const out = shell("providers", { settings: null }, fixture);
    expect(out).toContain("not reported by this server build");
    expect(out).not.toContain("anthropic-main");
  });
});

describe("DefaultsSection", () => {
  test("renders the fleet's real defaults as an editable form, not a column of dashes", () => {
    const out = shell("defaults", {}, fixtureProfilesState());
    expect(out).toContain('value="500"');
    // §4.6: the machine is this laptop's create presets now. Size, data volume
    // and system disk are gone from the page, and one line says where they went.
    expect(out).not.toContain('data-field="size"');
    expect(out).not.toContain('data-field="volume_gib"');
    expect(out).not.toContain('data-field="root_gib"');
    expect(out).toContain("Machine size and disks come from your");
    expect(out).toContain("Create presets →");
    // §8.3: the default is a *profile*, chosen among the ready ones, and the
    // fleet's own is the selected option.
    expect(out).toContain("Default provider profile");
    expect(out).toMatch(
      /<option value="an7hr0p1"[^>]*>anthropic-main · anthropic · claude-sonnet-5<\/option>/,
    );
    expect(out).toContain("settings v3");
    // The image is a fact about the fleet, not a default a create inherits:
    // it is Foundation's, and this section no longer guesses at it.
    expect(out).not.toContain("ubuntu release");
    expect(out).not.toContain("ami-0123456789abcdef0");
  });

  test("a fleet nobody has written settings for says the values are its starting ones", () => {
    const base = meta();
    const out = shell("defaults", {
      settings: { ...base.settings, persisted: false },
    });
    expect(out).toContain("nobody has set this fleet");
  });

  test("an unstated Hermes default is an empty option, never a value the fleet did not choose", () => {
    const out = shell("defaults", {}, fixtureProfilesState());
    expect(out).toContain('value="500"');
    // `terminal_backend`, `reasoning_effort` and `approvals_mode` are all
    // unstated in the fixture, and each says so rather than showing a value.
    expect(out.match(/<option value="" selected="">— unstated —<\/option>/g)?.length).toBe(3);
    // `model` has no fleet-wide answer (§6.4) — the default *profile's* model
    // is the placeholder, so a blank field is not read as "no model".
    expect(out).toContain('placeholder="claude-sonnet-5"');
  });

  test("only ready profiles are offered as the fleet default", () => {
    const out = shell("defaults", {}, fixtureProfilesState());
    // `nous-lab` has a placeholder key and `vercel-gw` is disabled: neither is a
    // default a create could resolve to, so neither is offered.
    expect(out).not.toContain("nous-lab");
    expect(out).not.toContain("vercel-gw");
    expect(out).toContain("openrouter-cheap");
  });

  test("with no ready profile the default select is disabled and points at Providers", () => {
    const out = shell("defaults");
    expect(out).toContain("no profile is ready");
    expect(out).toContain("set one up in Providers");
    expect(out).toContain('class="select-input" disabled=""');
  });
});

const CATALOG_T = CATALOG as unknown as ProviderCatalog;

function slot(over: Partial<SharedSecretView> & { slug: string }): SharedSecretView {
  return {
    exists: true,
    placeholder: false,
    used_by: [],
    ...over,
  } as unknown as SharedSecretView;
}

describe("SecretsTable", () => {
  const rows = [
    slot({
      slug: "nous-key",
      label: "FIXTURE nous",
      used_by: ["nous"],
      last_set_at: "2026-09-01T00:00:00.000Z",
    }),
    slot({ slug: "declared-only", exists: true, placeholder: true }),
    slot({ slug: "left-behind", orphan: true }),
  ];
  const out = renderToStaticMarkup(
    createElement(SecretsTable, {
      rows,
      catalog: CATALOG_T,
      onRotate: () => {},
      onDelete: () => {},
    }),
  );

  test("the three states, one per row", () => {
    expect(out).toContain('class="mono secrets-state" style="color:var(--ok)">set<');
    expect(out).toContain('class="mono secrets-state" style="color:var(--fg3)">empty<');
    expect(out).toContain('class="mono secrets-state" style="color:var(--warn)">orphan<');
  });

  test("`used by` names the providers, by their catalog labels", () => {
    expect(out).toContain('secrets-used-by">Nous Portal<');
    // A slot nobody names is a dash, not an empty cell.
    expect(out.match(/secrets-used-by">—</g)?.length).toBe(2);
  });

  test("a slot a provider still names cannot be deleted from the table", () => {
    const named = out.slice(
      out.indexOf('data-slug="nous-key"'),
      out.indexOf('data-slug="declared-only"'),
    );
    expect(named).toContain('disabled=""');
    expect(named).toContain("still named by nous; clear it in Providers first");
    const free = out.slice(out.indexOf('data-slug="left-behind"'));
    expect(free).not.toContain('disabled=""');
  });

  test("§8.3: a profile-owned slot links back to Providers and refuses both verbs", () => {
    const owned = renderToStaticMarkup(
      createElement(SecretsTable, {
        rows: [
          slot({
            slug: "profile-an7hr0p1",
            owner: { profile: "an7hr0p1", name: "anthropic-main" },
            last_set_at: "2026-09-01T00:00:00.000Z",
          }),
        ],
        catalog: CATALOG_T,
        onRotate: () => {},
        onDelete: () => {},
        onOpenProviders: () => {},
      }),
    );
    // The `used by` cell is the link back to the profile that owns it.
    expect(owned).toContain("owned by profile anthropic-main");
    expect(owned).toContain('class="linklike"');
    // Rotation happens on the profile, and deletion goes with the profile —
    // so neither verb is offered here, and both say where it does happen.
    expect(owned.match(/disabled=""/g)?.length).toBe(2);
    expect(owned).toContain("delete the profile in Providers instead");
    expect(owned).toContain("rotate it on the provider profile anthropic-main");
  });
});

describe("SecretPushDrawer", () => {
  const add = renderToStaticMarkup(
    createElement(SecretPushDrawer, { slot: null, onClose: () => {}, onPushed: () => {} }),
  );
  const rotate = renderToStaticMarkup(
    createElement(SecretPushDrawer, {
      slot: slot({ slug: "nous-key", label: "FIXTURE nous" }),
      onClose: () => {},
      onPushed: () => {},
    }),
  );

  test("the value field is write-only: a password input that carries no value", () => {
    // The one input whose markup must never carry what was typed — it is
    // uncontrolled precisely so React has nothing to echo back into the DOM.
    const field = add.slice(add.indexOf('type="password"'));
    expect(add).toContain('type="password"');
    expect(field.slice(0, field.indexOf("/>"))).not.toContain("value=");
    expect(add).toContain("write-only");
  });

  test("only a rotate offers the re-key gate, and a new slot asks for a slug", () => {
    expect(add).toContain("Slug");
    expect(add).not.toContain("Re-key running agents");
    expect(rotate).toContain("Re-key running agents");
    expect(rotate).toContain("Rotate nous-key");
    // Rotating never re-asks for the slug: the slot is the thing being rotated.
    expect(rotate).not.toContain('placeholder="e.g. nous-key"');
  });
});
