/**
 * What each rail item says before it is opened: a status square and one mono
 * count or version.
 *
 * Built only from data the page already holds — `/api/meta`, the profiles `App`
 * read once, the fleet list the header polls — never from a read of its own.
 * One section at a time is what keeps Settings from walking EC2 and the tailnet
 * because somebody opened it (`SettingsShell.tsx`), and a rail that fetched to
 * colour its squares would undo that on every visit. So a section whose health
 * is only known after its own read (Secrets' SSM state, Diagnostics, the
 * tailnet policy) gets no square at all rather than a guess.
 */
import type { Meta, SettingsResult } from "../../api/index.ts";
import { grantNeedsUpdate } from "../../logic/foundation-logic.ts";
import type { FleetListEntry } from "../../nav/fleet-switch.ts";
import type { SettingsSection } from "../../nav/settings-nav.ts";
import type { ProfilesState } from "../../state/state.tsx";
import type { SqTone } from "./Section.tsx";

export interface RailStatus {
  tone: SqTone;
  /** The square's tooltip: what it means, in words. */
  hint?: string;
  /** The mono count or version at the item's right edge. */
  meta?: string;
}

export function railStatus({
  meta,
  settings,
  profiles,
  fleets,
  defaultsDirty,
}: {
  meta: Meta | null;
  settings: SettingsResult | null;
  profiles: Pick<ProfilesState, "list" | "defaultProfile">;
  fleets: readonly FleetListEntry[] | null;
  /** Fleet defaults holds staged edits the bar has not sent. */
  defaultsDirty: boolean;
}): Partial<Record<SettingsSection, RailStatus>> {
  const out: Partial<Record<SettingsSection, RailStatus>> = {};

  if (defaultsDirty) out.defaults = { tone: "acc", hint: "unsaved changes" };

  const list = profiles.list;
  if (list !== null) {
    const unready = list.filter((p) => p.enabled && !p.ready);
    const fallback = list.find((p) => p.id === profiles.defaultProfile) ?? null;
    const warn =
      list.length === 0
        ? "no provider profiles"
        : fallback === null || !fallback.ready
          ? "the fleet default is not ready"
          : unready.length > 0
            ? `${unready.length} enabled profile${unready.length === 1 ? "" : "s"} not ready`
            : null;
    out.providers = {
      tone: warn === null ? "ok" : "warn",
      hint: warn ?? "every enabled profile is ready",
      meta: String(list.length),
    };
  }

  // Declared on `_fleet` — not whether each is filled in SSM, which is the
  // Secrets section's own read. A count, then, and no square.
  if (settings !== null) {
    out.secrets = { tone: "none", meta: String(settings.settings.secrets.length) };
  }

  const foundation = meta?.foundation;
  if (foundation) {
    const behind =
      foundation.tool_outdated ||
      foundation.update_available ||
      grantNeedsUpdate(foundation.stale_bedrock_grants) ||
      foundation.in_progress !== null;
    out.foundation = {
      tone: behind ? "warn" : "ok",
      hint: foundation.in_progress
        ? "an update is running"
        : foundation.tool_outdated
          ? "this build is older than the fleet's foundation"
          : behind
            ? "an update is available"
            : "up to date",
      meta: `v${foundation.fleet.foundation_version}`,
    };
  }

  if (fleets !== null) out.account = { tone: "none", meta: String(fleets.length) };

  out.danger = { tone: "bad", hint: "tears down the foundation" };
  return out;
}
