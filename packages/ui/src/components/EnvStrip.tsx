/**
 * The §4.7 target line: the facts that say where the next action lands, and
 * nothing else — the fleet (as the switcher's button, `FleetMenu.tsx`), the
 * account, the region, the tailnet and whether the stream to it is up. There
 * is one frozen target per fleet, so the colour says only one thing: live
 * (orange) or fixture (grey), and fixture mode also says `FIXTURE` in words,
 * because a grey strip alone is easy to misread as a theme.
 */
import { isInitialized } from "../api/index.ts";
import type { Meta } from "../api/index.ts";
import { DEFAULT_TAILNET } from "../logic/format.ts";
import { FleetMenu, openFleetLabel } from "./FleetMenu.tsx";

/** Grey means "nothing live here": fixture data, or no fleet bound yet. */
export function envColor(meta: Meta | null): string {
  if (!isInitialized(meta) || meta?.fixture) return "#8f8c84";
  return "var(--acc)";
}

/** The strip's line when there is no fleet to describe yet. */
function uninitializedLabel(meta: Meta | null): string {
  if (!meta) return "● connecting…";
  const base = `● NOT INITIALIZED — no fleet bound to ${meta.home ?? "~/.hermetic"}`;
  return meta.fixture ? `${base} · FIXTURE` : base;
}

/**
 * §6.6's two advisories, in the order they matter. Both flags can be true at
 * once — core computes them independently — and `tool_outdated` wins because it
 * is the only actionable one: a build older than the fleet's foundation cannot
 * apply an update (`foundation.update` refuses with `FOUNDATION_NEWER`), so
 * offering "update available" there would point at a button that cannot work.
 * Upgrading hermetic is the fix, and that is what this says.
 */
export function foundationPill(meta: Meta | null): { label: string; title: string } | null {
  const foundation = meta?.foundation;
  if (!foundation) return null;
  if (foundation.tool_outdated) {
    return {
      label: "hermetic build outdated",
      title: `the fleet's foundation is v${foundation.fleet.foundation_version} and this build only knows v${foundation.available.foundation_version}; upgrade hermetic`,
    };
  }
  if (foundation.update_available) {
    return {
      label: "foundation update available",
      title: `foundation v${foundation.fleet.foundation_version} → v${foundation.available.foundation_version} (hermeticd ${foundation.fleet.hermeticd_version} → ${foundation.available.hermeticd_version})`,
    };
  }
  return null;
}

export function EnvStrip({
  meta,
  connected,
  onOpenFoundation,
  switcher = true,
}: {
  meta: Meta | null;
  connected: boolean;
  /**
   * The foundation pill's one destination: Settings' Foundation section — the
   * page that can act on the advisory — rather than wherever Settings was last
   * left. Inside Settings it raises the update drawer instead, since the
   * section is already on screen.
   */
  onOpenFoundation?: () => void;
  /**
   * Whether the fleet name is the switcher's button. False while the init
   * wizard is up over a bound home, where switching fleet would pull the step
   * the operator is on out from under them; the name is still shown.
   */
  switcher?: boolean;
}) {
  const tailnet = meta?.tailnet ?? DEFAULT_TAILNET;
  const pill = foundationPill(meta);
  if (!isInitialized(meta)) {
    return (
      <div className="envstrip" style={{ background: envColor(meta) }}>
        <span>{uninitializedLabel(meta)}</span>
        <span className="right">run `hermetic init` here or below</span>
      </div>
    );
  }
  return (
    <div className="envstrip" style={{ background: envColor(meta) }}>
      {meta?.fixture ? (
        <span className="envstrip-mark" title="In-memory fleet, no AWS">
          ● FIXTURE
        </span>
      ) : null}
      {switcher ? (
        <FleetMenu meta={meta} />
      ) : (
        <span className="envstrip-fleet-name">{openFleetLabel(meta)}</span>
      )}
      <span title="AWS account">{meta?.config?.account_id ?? "—"}</span>
      <span title="AWS region">{meta?.config?.region ?? "—"}</span>
      {pill ? (
        <button
          type="button"
          className="pill-warn"
          title={pill.title}
          disabled={!onOpenFoundation}
          onClick={() => onOpenFoundation?.()}
        >
          {pill.label}
        </button>
      ) : null}
      <span className="right">
        tailnet {tailnet} ·{" "}
        <i
          className={connected ? "tick-dot" : "tick-dot pulse"}
          style={{ background: "currentColor" }}
        />
        {connected ? "connected" : "reconnecting"}
      </span>
    </div>
  );
}

/** The same strip repeated inside a drawer, without the tailnet tail. */
export function DrawerEnvStrip({ meta, right }: { meta: Meta | null; right?: string }) {
  return (
    <div className="envstrip in-drawer" style={{ background: envColor(meta) }}>
      <span>{meta?.config?.account_alias ?? meta?.config?.profile ?? "—"}</span>
      <span>{meta?.config?.account_id ?? "—"}</span>
      <span>{meta?.config?.region ?? "—"}</span>
      {right ? <span className="right">{right}</span> : null}
    </div>
  );
}
