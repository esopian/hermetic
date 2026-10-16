/**
 * `hermetic mobile pair`: the phone companion's pairing link, from a terminal.
 *
 * Prints the `hermetic://fleet?v=3&…` link as a QR drawn in the terminal and
 * as text. The link names the fleet, carries a snapshot of its agents and,
 * with `--avatar-style`, the preferences the phone starts with; it holds no
 * secret, because the phone authenticates to the fleet the way the
 * laptop does — by being on the tailnet — and talks to the boxes directly.
 */
import type { Command } from "commander";
import { Command as Cmd, Option } from "commander";
import { MobilePairInput } from "@hermetic/core";
import type { MobilePairResult } from "@hermetic/core";
import { AVATAR_STYLES, encodeQr, qrToTerminal } from "@hermetic/core/shared";
import { openCtx } from "../context.ts";
import { declare } from "../declare.ts";
import { out, outJson } from "../io.ts";
import { globals } from "../options.ts";
import { validate } from "../validate.ts";

const pairSchema = declare("mobile.pair", "mobile pair", MobilePairInput);

/**
 * The `mobile.pair` request the parsed options name, before validation: each
 * pref flag given lands in `prefs`, and no flag means no `prefs` at all.
 */
export function pairRequest(opts: Record<string, unknown>): Record<string, unknown> {
  const prefs: Record<string, unknown> = {};
  if (opts["avatarStyle"] !== undefined) prefs["avatar_style"] = opts["avatarStyle"];
  return Object.keys(prefs).length === 0 ? {} : { prefs };
}

/** The pair screen: the QR, the link, and what the phone needs. Pure, for a test. */
export function renderPair(result: MobilePairResult, opts: { qr: boolean }): string {
  let qr = "";
  if (opts.qr) {
    try {
      qr = `${qrToTerminal(encodeQr(result.link))}\n`;
    } catch {
      // A link too long for the encoder still pairs by pasting it.
      qr = "";
    }
  }
  const fleet = result.fleet.alias ?? result.fleet.fleet_id;
  const count =
    result.agents_in_link < result.agents.length
      ? `${result.agents_in_link} of ${result.agents.length} agents in the link; the phone lists the rest from the fleet`
      : `${result.agents.length} agent${result.agents.length === 1 ? "" : "s"}`;
  const prefs =
    result.prefs.avatar_style === undefined
      ? ""
      : `prefs    avatar style ${result.prefs.avatar_style}\n`;
  return (
    `${qr}` +
    `fleet    ${fleet} (${result.fleet.fleet_id})\n` +
    `tailnet  ${result.fleet.tailnet}\n` +
    `agents   ${count}\n` +
    prefs +
    `link     ${result.link}\n` +
    "\nScan with Hermetic on the phone, or paste the link. The phone needs Tailscale\n" +
    `signed in to ${result.fleet.tailnet}.\n`
  );
}

export function register(program: Command): void {
  const mobile = new Cmd("mobile").description("pair the Hermetic phone app with this fleet");

  mobile.addCommand(
    globals(new Cmd("pair"))
      .description("print the fleet's pairing link and its QR (no secret in it)")
      .addOption(
        new Option(
          "--avatar-style <style>",
          "the avatar style the phone starts with (it can change it later)",
        ).choices([...AVATAR_STYLES]),
      )
      .action(async (opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const result = await ctx.hermetic.mobile.pair(validate(pairSchema, pairRequest(opts)));
        if (ctx.flags.json) await outJson(result);
        else await out(renderPair(result, { qr: true }));
      }),
  );

  program.addCommand(mobile);
}
