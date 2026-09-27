/**
 * Settings' second axis.
 *
 * `ViewNav`'s `View` gains no member — Settings is still one view — but each of
 * its sections is its own page, so the section rides in the hash next to the
 * view (`#settings/providers`). That makes a section linkable and survivable
 * across a reload, the same way `#settings` and `#fleet/volumes` already are.
 *
 * Pure and DOM-free on purpose: `App.tsx` owns the state and the one hash
 * writer, and this module owns only the spelling, so both directions of the
 * round trip can be tested without a browser.
 */

/**
 * The rail's groups, in the order they are drawn. A group is what a section is
 * *about* — the fleet's shared settings, the AWS stack under it, this laptop's
 * own preferences, the account — and its name is the kicker every page in it
 * opens with. `danger` is never drawn as a group header: Danger sits alone at
 * the foot of the rail, set apart by a rule.
 */
export const SETTINGS_GROUPS = [
  { id: "fleet", label: "Fleet" },
  { id: "infrastructure", label: "Infrastructure" },
  { id: "laptop", label: "This laptop" },
  { id: "account", label: "Account" },
  { id: "danger", label: "Danger" },
] as const satisfies ReadonlyArray<{ id: string; label: string }>;

export type SettingsGroup = (typeof SETTINGS_GROUPS)[number]["id"];

/**
 * The rail, in the order it is drawn. `account` is still the landing section
 * (`DEFAULT_SETTINGS_SECTION`) although it is drawn fourth from the bottom:
 * `#settings` has always meant "what is this home bound to", and moving the
 * landing page would re-point every bookmark and the header's link.
 *
 * `tone: "danger"` is the rail's own warning, not the section's: Danger holds
 * teardown, which destroys the fleet, so the item that leads there is red
 * before a click rather than only after one. It rides in the data because the
 * rail renders from this list and nothing else knows the order.
 */
export const SETTINGS_SECTIONS = [
  { id: "defaults", label: "Defaults", group: "fleet" },
  { id: "providers", label: "Providers", group: "fleet" },
  { id: "secrets", label: "Secrets", group: "fleet" },
  { id: "policy", label: "Tailnet policy", group: "fleet" },
  { id: "foundation", label: "Foundation", group: "infrastructure" },
  { id: "diagnostics", label: "Diagnostics", group: "infrastructure" },
  // §4.6: the machines the New agent panel offers. First in the group because
  // it is the one laptop page that changes what gets built.
  { id: "presets", label: "Create presets", group: "laptop" },
  { id: "chat", label: "Chat", group: "laptop" },
  // §4.9: the delivery rules *and* the full inbox. It sits beside Runs because
  // they are the same history read two ways — the run log is what this laptop
  // asked for, the inbox is what it was told.
  { id: "notifications", label: "Notifications", group: "laptop" },
  { id: "runs", label: "Runs", group: "laptop" },
  { id: "account", label: "Account & fleets", group: "account" },
  { id: "danger", label: "Danger zone", group: "danger", tone: "danger" },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  group: SettingsGroup;
  tone?: "danger";
}>;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];

/** A section's rail label, and the name of the group its page's kicker carries. */
export function settingsSectionInfo(section: SettingsSection): {
  label: string;
  group: SettingsGroup;
  groupLabel: string;
} {
  const s = SETTINGS_SECTIONS.find((x) => x.id === section) ?? SETTINGS_SECTIONS[0];
  const g = SETTINGS_GROUPS.find((x) => x.id === s.group) ?? SETTINGS_GROUPS[0];
  return { label: s.label, group: s.group, groupLabel: g.label };
}

/** Where `#settings` with no section — and any section nobody recognises — lands. */
export const DEFAULT_SETTINGS_SECTION: SettingsSection = "account";

function isSection(value: string): value is SettingsSection {
  return SETTINGS_SECTIONS.some((s) => s.id === value);
}

/**
 * The section a hash asks for, or `null` when the hash is not Settings at all.
 *
 * The two answers are different questions and both callers need both: `null`
 * means "Settings is closed" (`#fleet/volumes`, `#`, an empty hash), while
 * `DEFAULT_SETTINGS_SECTION` means "Settings is open, on the landing section" —
 * which is also what an unknown section gets, because a stale bookmark should
 * open Settings rather than bounce to the fleet.
 */
export function parseSettingsHash(hash: string): SettingsSection | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw !== "settings" && !raw.startsWith("settings/")) return null;
  const section = raw.slice("settings/".length);
  return isSection(section) ? section : DEFAULT_SETTINGS_SECTION;
}

/**
 * The hash for a section. `account` is spelled `#settings` rather than
 * `#settings/account` so the header's link, the `,` key and a bookmark from
 * before sections existed all resolve to one URL instead of two.
 */
export function settingsHash(section: SettingsSection): string {
  return section === DEFAULT_SETTINGS_SECTION ? "#settings" : `#settings/${section}`;
}
