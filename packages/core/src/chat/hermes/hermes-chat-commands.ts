/**
 * The slash commands a bot's gateway offers: `chat.commands`, read from
 * upstream's `commands.catalog` (`tui_gateway/methods_tools.py`) and mapped to
 * `ChatCommand`.
 *
 * The catalog is the one Hermes's TUI and desktop complete from. `pairs` lists
 * every command once, in the gateway's order — registry built-ins, TUI extras,
 * quick commands, plugin commands, then skills — with aliases left out;
 * `commands` carries the desktop composer's metadata per name (aliases too),
 * `categories` groups the non-skill pairs, and `skills` names each skill's
 * origin. A pair the other tables say nothing about keeps its name and
 * description and reads as taking no argument, from no category.
 *
 * Skill discovery upstream is bound to the calling session's profile and
 * workspace and otherwise falls back to the gateway's launch profile. The
 * request names a runtime session, so a durable conversation is first looked
 * up among the gateway's live sessions (`session.active_list`, as
 * `hermes-chat-live-usage.ts` does); one that is not live, or a lookup that
 * fails, reads the catalog unbound rather than failing the read.
 *
 * Both requests go over the pooled Bot Mode socket and resume nothing.
 */
import type { ChatCommand, ChatCommandArgumentMode } from "../../schema/index.ts";
import type { BoxAddress, HermesChatOptions } from "./hermes-chat-types.ts";
import { arr, rec, records, str } from "./hermes-chat-wire.ts";

/** What `createChatCommands` needs: one request on a box's socket. */
export interface ChatCommandsDeps {
  rpc(
    box: BoxAddress,
    method: string,
    params: Record<string, unknown>,
    opts?: HermesChatOptions & { deadlineMs?: number },
  ): Promise<unknown>;
}

/** The catalog scans the profile's skills, so it gets longer than a status read. */
export const COMMANDS_DEADLINE_MS = 15_000;

/** The live-session lookup is a nicety; it gets a short budget of its own. */
const LOOKUP_DEADLINE_MS = 5_000;

const ARGUMENT_MODES: readonly string[] = ["options", "text", "mixed"];

/** What `commands` answers: the catalog, and the gateway's discovery warning. */
export interface CommandCatalog {
  commands: ChatCommand[];
  warning: string | null;
}

/** `/name`, slash included, or null for a key that is not one command name. */
function commandName(v: unknown): string | null {
  const key = str(v)?.trim();
  if (!key) return null;
  const name = key.startsWith("/") ? key : `/${key}`;
  return /^\/[^\s/]+$/.test(name) ? name : null;
}

/** Map one `commands.catalog` reply. Tolerant: whatever cannot be read is left out. */
export function mapCommandCatalog(raw: unknown): CommandCatalog {
  const reply = rec(raw);
  const meta = rec(reply?.commands) ?? {};
  const skills = rec(reply?.skills) ?? {};
  const categoryOf = new Map<string, string>();
  for (const category of records(reply?.categories)) {
    const label = str(category.name);
    if (!label) continue;
    for (const pair of arr(category.pairs)) {
      const name = commandName(arr(pair)[0]);
      if (name && !categoryOf.has(name)) categoryOf.set(name, label);
    }
  }
  const seen = new Set<string>();
  const commands: ChatCommand[] = [];
  for (const pair of arr(reply?.pairs)) {
    const [key, description] = arr(pair);
    const name = commandName(key);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const info = rec(meta[name]);
    const mode = str(info?.argument_mode);
    const skill = rec(skills[name]);
    commands.push({
      name,
      description: str(description) ?? "",
      category: categoryOf.get(name) ?? null,
      argument_mode: mode && ARGUMENT_MODES.includes(mode) ? (mode as ChatCommandArgumentMode) : null,
      desktop: str(info?.desktop),
      skill: skill ? { origin: str(skill.origin) } : null,
    });
  }
  return { commands, warning: str(reply?.warning) };
}

export function createChatCommands(deps: ChatCommandsDeps) {
  /** The runtime id a durable conversation is live under, or null. Never throws. */
  async function runtimeOf(box: BoxAddress, session: string, opts: HermesChatOptions) {
    try {
      const listed = rec(
        await deps.rpc(box, "session.active_list", {}, { ...opts, deadlineMs: LOOKUP_DEADLINE_MS }),
      );
      return str(records(listed?.sessions).find((row) => str(row.session_key) === session)?.id);
    } catch {
      opts.signal?.throwIfAborted();
      return null;
    }
  }

  async function commands(
    box: BoxAddress,
    bot: string,
    opts: HermesChatOptions & { session?: string } = {},
  ): Promise<CommandCatalog> {
    const { session, ...request } = opts;
    const runtime = session ? await runtimeOf(box, session, request) : null;
    const raw = await deps.rpc(
      box,
      "commands.catalog",
      { profile: bot, ...(runtime ? { session_id: runtime } : {}) },
      { ...request, deadlineMs: COMMANDS_DEADLINE_MS },
    );
    return mapCommandCatalog(raw);
  }
  return { commands };
}
