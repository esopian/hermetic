/**
 * The fixture's drive link: `hermetic://fixture?…` puts the app into a given
 * state with no tap, so an agent that can only run
 * `xcrun simctl openurl booted "<url>"` can stage a screen before a
 * screenshot. `app/fixture.tsx` is the route; it reaches this module only
 * through the kit (`fixtureKit().drive`, carried as `deps.fixture.drive`), so a
 * build without the fixture has none of it.
 *
 * Parameters (each optional; unknown ones are ignored):
 *
 * - `pair=1` — pair with the kit's canned link (the Pair screen's "Use fixture
 *   fleet"), which starts over with no primary and nothing listened;
 * - `listen=<name>[,<name>…]` — listen to these instances;
 * - `primary=<name>` — make it the primary instance (which listens to it, and
 *   reads home's bots again, so it runs after `listen`);
 * - `createBot=<instance>:<name>[:<title>]` — create a Bot Mode bot there, as
 *   the New bot form does (the name lowercased and held to core's `BotName`;
 *   the title is the rest of the value, colons included). One that exists
 *   already (`CONFLICT`) counts as made;
 * - `avatar=sigil|pixel|blob` — the phone's avatar style;
 * - `theme=dark|light|system` — the scheme preference;
 * - `to=<route>` — where to go after, an in-app path starting with one `/`
 *   (URL-encoded when it carries its own query). Default: the new bot's chat
 *   when `createBot` made one, else `/`, the entry, which goes on to Pair, the
 *   primary picker or home as the state says.
 *
 * The steps run in that fixed order whatever the order in the URL, since each
 * depends on the one before (a primary needs a pairing). A refused parameter
 * or a failed step is reported through `warn` and the rest still run.
 */
import { BotName } from "@hermetic/core/schema";
import { type AvatarStyle, isAvatarStyle, isValidName } from "@hermetic/core/shared";
import { errorCode } from "../client/errors.ts";
import type {
  FixtureDriveActions,
  FixtureDriveParams,
  SchemePreferenceName as SchemePreference,
} from "../fleet/fixture-types.ts";

/** Where a drive link goes when it names nowhere (or somewhere refused). */
export const DRIVE_DEFAULT_ROUTE = "/";

/** The longest bot title core takes (`BotCreateInput.title`). */
const BOT_TITLE_MAX = 64;

/** A bot to create: where, its name, and its title when the link gave one. */
export interface DriveBot {
  instance: string;
  name: string;
  title?: string;
}

/** A drive link's parameters, checked. */
export interface DriveOps {
  pair: boolean;
  listen: string[];
  primary: string | null;
  createBot: DriveBot | null;
  avatar: AvatarStyle | null;
  theme: SchemePreference | null;
  /** Where to go; `null` when the link named nowhere (a refused `to` is the default route). */
  to: string | null;
  /** One line per parameter refused, for `warn`. */
  refused: string[];
}

const THEMES: readonly SchemePreference[] = ["dark", "light", "system"];

/** A parameter's one value: the first when it is repeated, trimmed; `null` when absent or empty. */
function one(params: FixtureDriveParams, key: string): string | null {
  const raw = params[key];
  const value = typeof raw === "string" ? raw : raw?.[0];
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * An in-app route: one leading `/`, then no second `/` (a protocol-relative
 * URL), no backslash and no control character. Anything else, a scheme
 * included, is refused, so the link can never send the app off the device.
 */
export function isAppRoute(to: string): boolean {
  if (!to.startsWith("/") || to.startsWith("//")) return false;
  for (const ch of to) {
    const code = ch.charCodeAt(0);
    if (ch === "\\" || code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/** Read a drive link's query into the steps to take. */
export function parseDriveParams(params: FixtureDriveParams): DriveOps {
  const refused: string[] = [];
  const pairRaw = one(params, "pair");
  const pair = pairRaw === "1" || pairRaw === "true";
  if (pairRaw !== null && !pair && pairRaw !== "0" && pairRaw !== "false")
    refused.push(`pair=${pairRaw}: expected 1`);

  const listen: string[] = [];
  for (const name of (one(params, "listen") ?? "").split(",")) {
    const n = name.trim();
    if (!n) continue;
    if (!isValidName(n)) refused.push(`listen=${n}: not an agent name`);
    else if (!listen.includes(n)) listen.push(n);
  }

  let primary = one(params, "primary");
  if (primary !== null && !isValidName(primary)) {
    refused.push(`primary=${primary}: not an agent name`);
    primary = null;
  }

  let createBot: DriveBot | null = null;
  const botRaw = one(params, "createBot");
  if (botRaw !== null) {
    const parsed = parseDriveBot(botRaw);
    if (typeof parsed === "string") refused.push(`createBot=${botRaw}: ${parsed}`);
    else createBot = parsed;
  }

  let avatar: AvatarStyle | null = null;
  const avatarRaw = one(params, "avatar");
  if (avatarRaw !== null) {
    if (isAvatarStyle(avatarRaw)) avatar = avatarRaw;
    else refused.push(`avatar=${avatarRaw}: expected sigil, pixel or blob`);
  }

  let theme: SchemePreference | null = null;
  const themeRaw = one(params, "theme");
  if (themeRaw !== null) {
    const match = THEMES.find((s) => s === themeRaw);
    if (match) theme = match;
    else refused.push(`theme=${themeRaw}: expected dark, light or system`);
  }

  let to: string | null = null;
  const toRaw = one(params, "to");
  if (toRaw !== null) {
    if (isAppRoute(toRaw)) to = toRaw;
    else {
      to = DRIVE_DEFAULT_ROUTE;
      refused.push(`to=${toRaw}: not an in-app route`);
    }
  }

  return { pair, listen, primary, createBot, avatar, theme, to, refused };
}

/** `<instance>:<name>[:<title>]`, checked, or why not. */
export function parseDriveBot(raw: string): DriveBot | string {
  const first = raw.indexOf(":");
  if (first === -1) return "expected <instance>:<name>[:<title>]";
  const second = raw.indexOf(":", first + 1);
  const instance = raw.slice(0, first).trim();
  const name = raw
    .slice(first + 1, second === -1 ? undefined : second)
    .trim()
    .toLowerCase();
  const title = second === -1 ? "" : raw.slice(second + 1).trim();
  if (!isValidName(instance)) return `${instance || "(empty)"} is not an agent name`;
  if (!BotName.safeParse(name).success) return `${name || "(empty)"} is not a bot name`;
  if (title.length > BOT_TITLE_MAX) return `the title is longer than ${BOT_TITLE_MAX} characters`;
  return title ? { instance, name, title } : { instance, name };
}

/** The conversation route for a bot (the New bot form's `chatPathFor`). */
export function chatRoute(instance: string, name: string): string {
  return `/chat/${encodeURIComponent(instance)}/${encodeURIComponent(name)}`;
}

/** Take the steps in order (see the module comment) and answer the route to open. */
export async function applyDrive(ops: DriveOps, actions: FixtureDriveActions): Promise<string> {
  for (const line of ops.refused) actions.warn(line);
  const step = async (label: string, run: () => unknown): Promise<boolean> => {
    try {
      await run();
      return true;
    } catch (e) {
      actions.warn(`${label}: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  };
  if (ops.pair) await step("pair", () => actions.pair());
  for (const name of ops.listen) await step(`listen ${name}`, () => actions.listen(name));
  const primary = ops.primary;
  if (primary) await step(`primary ${primary}`, () => actions.setPrimary(primary));
  const bot = ops.createBot;
  let made: string | null = null;
  if (bot) {
    const { instance, ...input } = bot;
    const ok = await step(`createBot ${instance}:${bot.name}`, async () => {
      try {
        await actions.createBot(instance, input);
      } catch (e) {
        // Already there: as good as made, for a link run twice.
        if (errorCode(e) !== "CONFLICT") throw e;
      }
    });
    if (ok) made = chatRoute(instance, bot.name);
  }
  const avatar = ops.avatar;
  if (avatar) await step("avatar", () => actions.setAvatarStyle(avatar));
  const theme = ops.theme;
  if (theme) await step("theme", () => actions.setTheme(theme));
  return ops.to ?? made ?? DRIVE_DEFAULT_ROUTE;
}

/** The kit's `drive`: parse, then apply. */
export function drive(params: FixtureDriveParams, actions: FixtureDriveActions): Promise<string> {
  return applyDrive(parseDriveParams(params), actions);
}
