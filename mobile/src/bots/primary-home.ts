/**
 * Home built around the primary instance (`FleetState.primary`). It takes
 * `homeRows`' layout and changes two things:
 *
 * - With nothing pinned, the hero is every bot of the primary instance (its
 *   default first, then home's row order), instead of each listened
 *   instance's default bot. The other instances' defaults go back to the top
 *   of their own sections.
 * - The primary instance's section, when it has one, sorts first.
 *
 * Pins still win the hero, and a primary that is not listened to, or whose box
 * did not answer, leaves the hero as `homeRows` drew it. Pure.
 */
import {
  compareHomeRows,
  type HomeInput,
  type HomeLayout,
  type HomeRow,
  type HomeSection,
  homeRows,
} from "../client/home-rows.ts";
import { compareBuckets, railUnread } from "../client/roster-store.ts";

const stamp = (iso: string | null | undefined): number => {
  const at = iso ? Date.parse(iso) : 0;
  return Number.isNaN(at) ? 0 : at;
};

/** The newest message stamp among a section's rows. */
function lastAt(section: HomeSection): string | null {
  let best: string | null = null;
  for (const r of section.rows)
    if (stamp(r.bot.last_message_at) > stamp(best)) best = r.bot.last_message_at ?? null;
  return best;
}

/** The sections in home's order (`compareBuckets`), with `primary`'s first. */
function ordered(sections: readonly HomeSection[], primary: string): HomeSection[] {
  return [...sections].sort((a, b) => {
    if ((a.instance === primary) !== (b.instance === primary)) return a.instance === primary ? -1 : 1;
    return compareBuckets(
      { ...a, needsAction: a.needs, lastAt: lastAt(a) },
      { ...b, needsAction: b.needs, lastAt: lastAt(b) },
    );
  });
}

export function primaryHomeRows(input: HomeInput, primary: string | null): HomeLayout {
  const base = homeRows(input);
  if (!primary || !input.listening.includes(primary)) return base;
  const swarm = input.swarms.find((s) => s.instance === primary);
  if (base.heroPinned || !swarm?.reachable)
    return { ...base, sections: ordered(base.sections, primary) };

  const own = (r: HomeRow) => r.bot.instance === primary;
  const primarySection = base.sections.find((s) => s.instance === primary);
  const hero = [...base.hero.filter(own), ...(primarySection?.rows ?? [])];

  // The other instances' defaults leave the hero for the top of their sections.
  const returning = new Map<string, HomeRow[]>();
  for (const r of base.hero) {
    if (own(r)) continue;
    returning.set(r.bot.instance, [...(returning.get(r.bot.instance) ?? []), r]);
  }
  const unreadOf = input.unreadOf ?? (() => 0);
  const folded = new Set(input.folded ?? []);
  const sections: HomeSection[] = [];
  const merge = (section: HomeSection, extra: HomeRow[]): HomeSection => {
    if (extra.length === 0) return section;
    const rows = [...extra, ...section.rows].sort(compareHomeRows);
    return {
      ...section,
      rows,
      needs: rows.some((r) => r.badge === "!"),
      unread: rows.reduce((n, r) => n + railUnread(r.bot, unreadOf(r.bot.instance, r.bot.name)), 0),
    };
  };
  for (const section of base.sections) {
    if (section.instance === primary) continue;
    sections.push(merge(section, returning.get(section.instance) ?? []));
    returning.delete(section.instance);
  }
  // An instance whose only bot was its default had no section: it gets one now.
  for (const [instance, rows] of returning) {
    sections.push(
      merge(
        {
          instance,
          reachable: true,
          reason: null,
          folded: folded.has(instance),
          rows: [],
          needs: false,
          unread: 0,
        },
        rows,
      ),
    );
  }
  return { hero, heroPinned: false, sections: ordered(sections, primary) };
}
