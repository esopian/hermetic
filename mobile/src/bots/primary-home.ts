/**
 * Home built around the primary instance (`FleetState.primary`). It takes
 * `homeRows`' layout, where the hero is each listened instance's default
 * (canonical) bot and every other bot sits in its instance's section below,
 * and changes two things: the primary's default leads the hero, and the
 * primary's section sorts first. Pins still win the hero. Pure.
 */
import { type HomeInput, type HomeLayout, type HomeSection, homeRows } from "../client/home-rows.ts";
import { compareBuckets } from "../client/roster-store.ts";

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
  if (!primary || !input.listening.includes(primary)) return homeRows(input);
  // The hero follows listening order: the primary's default leads it.
  const listening = [primary, ...input.listening.filter((name) => name !== primary)];
  const base = homeRows({ ...input, listening });
  return { ...base, sections: ordered(base.sections, primary) };
}
