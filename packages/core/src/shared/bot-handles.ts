/**
 * How a bot is addressed by name on one Hermes instance: the `@handle` a
 * profile answers to, the `@`-forms its friendly title reduces to, the tag the
 * composer inserts, and how a free-text target resolves back to a roster row.
 *
 * Ported from Hermes v2026.9.24, where the Desktop and the gateway each carry a
 * copy and agree by construction: `botHandle`/`mentionNameForms`/
 * `botMentionTag` in `apps/desktop/src/plugins/hermes-bots/data.ts`, and
 * `_handle`/`alias_forms` in `tools/bot_mode_probe.py` with
 * `_resolve_local_name` in `tools/bot_mode_dm.py`. The UI's mention picker and
 * core's `message_agent` target mapping both read these, so a tag the composer
 * inserts is a tag the box resolves to the same bot.
 *
 * Same-instance only. Upstream's cross-connection forms (`@tag@connection`,
 * `name-device` handles, peer targets) have no counterpart here.
 *
 * Pure values only — no Zod, no `node:*` — because `shared/index.ts` re-exports
 * this into the browser (`packages/core/test/shared-browser-safe.test.ts`).
 */

/** The fields of a roster row these rules read. Any bot-shaped row satisfies it. */
export interface BotIdentity {
  /** The profile (folder) id: `default`, `writer`. */
  name: string;
  /** The friendly name, when the bot has one: Bot Mode title or profile display name. */
  title?: string | null;
  /** The profile that is `$HERMES_HOME` itself, which answers to `@hermes`. */
  is_default?: boolean;
}

/**
 * Tokens the Desktop mention parser keeps for itself. A bot titled "Hermes" or
 * "All" never takes them over: `@hermes` stays the primary profile's alias.
 */
const RESERVED_MENTION_FORMS: ReadonlySet<string> = new Set([
  "all",
  "everyone",
  "user",
  "default",
  "hermes",
]);

const MENTION_FORM_RE = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * The `@handle` a profile answers to: its name, except that the primary
 * profile is called `hermes` — the word `default` never surfaces as a handle.
 */
export function botHandle(name: string): string {
  return name.trim().toLowerCase() === "default" ? "hermes" : name;
}

/**
 * Taggable `@`-forms of a friendly name, in upstream's order: slugified ("Dr.
 * Foo" → `dr-foo`, the form autocomplete inserts) then collapsed (`drfoo`).
 * Forms outside the mention charset and reserved tokens are dropped.
 */
export function botAliasForms(title: string | null | undefined): string[] {
  const name = String(title ?? "")
    .trim()
    .toLowerCase();
  if (!name) return [];
  const slug = name.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const collapsed = name.replace(/[^a-z0-9_-]+/g, "");
  return [...new Set([slug, collapsed])].filter(
    (form) => MENTION_FORM_RE.test(form) && !RESERVED_MENTION_FORMS.has(form),
  );
}

/**
 * The bot's friendly name, or null when it has none. Hermetic's roster falls a
 * missing title back to the profile id, and that fallback is not a name the
 * user gave the bot — upstream would tag such a bot by its handle.
 */
function friendlyName(bot: BotIdentity): string | null {
  const title = bot.title?.trim();
  return title && title !== bot.name ? title : null;
}

/**
 * The tag the composer inserts for a bot, without the `@`: the slug of its
 * friendly name when it has a usable one, otherwise its handle. A resolver
 * accepts either, so older muscle memory keeps working.
 */
export function botMentionTag(bot: BotIdentity): string {
  return botAliasForms(friendlyName(bot))[0] ?? botHandle(bot.name);
}

/**
 * Resolves a free-text target ("Scribe", "@scribe", "dr-foo", "hermes") to one
 * bot on the roster, or null.
 *
 * In upstream's order: one leading run of `@` is dropped; `hermes` is the
 * primary profile; an exact profile id (case-insensitive) wins next, so a
 * friendly name that collides with another bot's id never steals it; then a
 * friendly-name form. A form two bots share resolves to null — a message must
 * never land on whichever bot happened to sort first.
 */
export function resolveBotTarget<B extends BotIdentity>(target: string, bots: readonly B[]): B | null {
  const want = target.trim().replace(/^@+/, "").trim().toLowerCase();
  if (!want) return null;
  if (want === "hermes")
    return bots.find((bot) => bot.is_default === true || bot.name === "default") ?? null;
  const exact = bots.find((bot) => bot.name.toLowerCase() === want);
  if (exact) return exact;
  const wanted = new Set([...botAliasForms(want), want]);
  const hits = bots.filter((bot) => botAliasForms(friendlyName(bot)).some((form) => wanted.has(form)));
  return hits.length === 1 ? hits[0]! : null;
}
