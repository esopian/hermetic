/**
 * Creating a Bot Mode bot over a gateway's JSON-RPC, as one portable sequence
 * the desktop (`chat/bot-mode.ts`, `bots.create`) and the phone (`mobile/`,
 * through `@hermetic/core/chat-client`) both run, so the two cannot write a
 * different profile.
 *
 * The sequence is `profiles.create`, then the Bot Mode namespace the way
 * Desktop's create dialog writes it
 * (`apps/desktop/src/plugins/hermes-bots/create-dialog.tsx:451-486` at
 * v2026.9.24): the friendly `title` and `created` in epoch milliseconds, beside
 * the `version` marker that makes the profile Bot Mode managed; then
 * `profiles.describe` for the profile as the box now holds it. The look keys
 * (`shape`, `color`, `imageKind`) are Desktop's to choose; Hermetic seeds its
 * avatars itself and invents none.
 *
 * Desktop also sends `profiles.create` a description of `"title — description"`.
 * That is not copied: the teammate roster already joins the two (`_role_line`,
 * `tools/bot_mode_probe.py:132-155`), so the title would read twice there, and
 * `bots.get` would hand the prefix back as part of a description the operator
 * never typed.
 *
 * Security: the only credential this path uses is the one the caller's `call`
 * already carries, the box's gateway session token, which the adapter scrapes
 * from the dashboard over the tailnet and never lets out. No AWS credential and
 * no secret is read, sent or needed, so the phone can run it as it is.
 *
 * Portable: no node, bun, AWS or environment (`test/chat-client-portable.test.ts`).
 */
import { HermeticError } from "../../errors.ts";
import type { BotCreateInput, BotProfile } from "../../schema/bot-mode.ts";
import { BotProfile as BotProfileSchema } from "../../schema/bot-mode.ts";
import { record, records, str } from "./hermes-chat-wire.ts";

/** One Bot Mode JSON-RPC call to one box, its address and options already bound. */
export type BotModeCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

const text = (v: unknown): string => str(v) ?? "";

/** A `profiles.describe` answer as `bots.get` returns it. */
export function botProfileOf(instance: string, bot: string, described: unknown): BotProfile {
  const r = record(described);
  return BotProfileSchema.parse({
    instance,
    bot,
    description: text(r.description),
    soul: text(r.soul),
    model: { provider: text(record(r.model).provider), default: text(record(r.model).default) },
    skills: records(r.skills),
    toolsets: records(r.toolsets),
    mcp_servers: records(r.mcp_servers),
  });
}

/**
 * `profiles.create`, `profiles.configure` with the `hermes-bots` marker, then
 * `profiles.describe`, over `call` (bound to `input.instance`'s box). `input`
 * is already validated against `BotCreateInput`. Throws `CHAT_PROTOCOL` when
 * the gateway does not confirm a step; a profile created without its marker is
 * left for the operator to inspect, never deleted here.
 */
export async function createBotOverRpc(
  call: BotModeCall,
  input: BotCreateInput,
  now: () => number = Date.now,
): Promise<BotProfile> {
  const { instance, title, ...create } = input;
  // Explicit, though upstream defaults it on: the new bot gets a copy of the
  // default `.env`, whose managed block holds the provider key (§8.1, §9.2).
  const created = record(await call("profiles.create", { ...create, mirror_credentials: true }));
  if (created.ok !== true)
    throw new HermeticError("CHAT_PROTOCOL", "Gateway did not create the profile");
  const meta = { version: 1, ...(title ? { title } : {}), created: now() };
  const configured = record(
    await call("profiles.configure", { name: input.name, ui_meta: { "hermes-bots": meta } }),
  );
  if (configured.ok !== true || record(configured.applied).ui_meta !== true)
    throw new HermeticError(
      "CHAT_PROTOCOL",
      "Profile was created but Bot Mode metadata could not be saved; inspect the profile before retrying",
    );
  return botProfileOf(instance, input.name, await call("profiles.describe", { name: input.name }));
}
