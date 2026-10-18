/**
 * The quiet text after a bot's title in a list ("Scribe · scribe-2 · atlas"):
 * whichever of the bot's name and its instance are needed to tell it apart,
 * minus any that only repeat what is already said. "atlas · atlas" was the
 * default bot of an instance named for it. Pure, so it is testable.
 */
export function quietSuffix(title: string, ...parts: (string | null | undefined)[]): string | null {
  const said = new Set([title.trim().toLowerCase()]);
  const kept: string[] = [];
  for (const part of parts) {
    const key = part?.trim().toLowerCase();
    if (!part || !key || said.has(key)) continue;
    said.add(key);
    kept.push(part);
  }
  return kept.length > 0 ? kept.join(" · ") : null;
}

/**
 * The bots whose title another bot of the same instance also shows, keyed
 * `instance/name`: these need their own name said after the title.
 */
export function sharedTitles(
  bots: readonly { instance: string; name: string; title?: string | null }[],
): Set<string> {
  const count = new Map<string, number>();
  const titleKey = (b: (typeof bots)[number]) =>
    `${b.instance}\u0000${(b.title || b.name).toLowerCase()}`;
  for (const b of bots) count.set(titleKey(b), (count.get(titleKey(b)) ?? 0) + 1);
  return new Set(
    bots.filter((b) => (count.get(titleKey(b)) ?? 0) > 1).map((b) => `${b.instance}/${b.name}`),
  );
}
