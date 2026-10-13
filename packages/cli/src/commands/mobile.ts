/**
 * `hermetic mobile pair|devices|revoke|settings|serve`: the phone companion's
 * bridge from a terminal.
 *
 * `pair` prints a one-time code, the `hermetic://pair?…` URL and the same URL
 * as a QR drawn in the terminal; the bridge that redeems it may be this CLI's
 * `mobile serve` or the desktop app, since pair codes live in the shared local
 * database. `serve` runs the bridge in the foreground until Ctrl-C, ticking
 * `chat.swarms` so core raises the `chat.message` rows the desktop poller would
 * otherwise raise (`--no-tick` when the desktop app is also running).
 *
 * `mobile pair`'s output is a credential for ten minutes, so the run log
 * records it redacted (`run-log.ts`).
 */
import type { Command } from "commander";
import { Command as Cmd } from "commander";
import {
  MobileDevicesInput,
  MobilePairInput,
  MobileRevokeInput,
  MobileServeInput,
  MobileSettingsInput,
} from "@hermetic/core";
import type { MobileDevicesResult, MobilePairResult, MobileSettings } from "@hermetic/core";
import { encodeQr, qrToTerminal } from "@hermetic/core/shared";
import { openCtx } from "../context.ts";
import { declare } from "../declare.ts";
import { err, isInteractive, out, outJson } from "../io.ts";
import { globals } from "../options.ts";
import { renderOp } from "../stream.ts";
import { renderTable } from "../table.ts";
import { defined, toInt, validate } from "../validate.ts";

const pairSchema = declare("mobile.pair", "mobile pair", MobilePairInput);
const devicesSchema = declare("mobile.devices", "mobile devices", MobileDevicesInput);
const revokeSchema = declare("mobile.revoke", "mobile revoke", MobileRevokeInput);
const settingsSchema = declare("mobile.settings", "mobile settings", MobileSettingsInput);
const serveSchema = declare("mobile.serve", "mobile serve", MobileServeInput);

const WILDCARD_HOSTS = new Set(["0.0.0.0", "::"]);

/** The pair screen: where, the code, the URL, and the URL as a QR. Pure, for a test. */
export function renderPair(result: MobilePairResult, opts: { qr: boolean }): string {
  const lines = [
    `bridge  ${result.host}:${result.port}`,
    `code    ${result.code}   (single use, expires ${result.expires_at})`,
    `url     ${result.url}`,
    "",
  ];
  let qr = "";
  if (opts.qr) {
    try {
      qr = `${qrToTerminal(encodeQr(result.url))}\n`;
    } catch {
      // A URL too long for the encoder still pairs by code or by URL.
      qr = "";
    }
  }
  return `${qr}${lines.join("\n")}\nScan with Hermetic on the phone, or enter the host, port and code.\n`;
}

export function renderDevices(result: MobileDevicesResult): string {
  const serving =
    result.serving === null
      ? "bridge: not running in this process\n"
      : `bridge: ${result.serving.url} (${result.serving.connected} connected)\n`;
  if (result.devices.length === 0) return `${serving}no paired devices\n`;
  const rows = result.devices.map((d) => [
    d.device_id,
    d.name,
    d.platform,
    d.created_at,
    d.last_seen_at ?? "-",
    d.push_registered ? (d.enabled ? (d.previews ? "on" : "on, no previews") : "off") : "-",
  ]);
  return `${serving}${renderTable(rows, ["DEVICE", "NAME", "PLATFORM", "PAIRED", "LAST SEEN", "PUSH"])}\n`;
}

function renderSettings(s: MobileSettings): string {
  return (
    `enabled  ${s.enabled ? "yes" : "no"}\n` +
    `host     ${s.host ?? "(default: this laptop's Tailscale IPv4)"}\n` +
    `port     ${s.port ?? "(default: 7877)"}\n`
  );
}

export function register(program: Command): void {
  const mobile = new Cmd("mobile").description(
    "pair phones with this laptop and serve the mobile bridge",
  );

  mobile.addCommand(
    globals(new Cmd("pair"))
      .description("create a one-time pair code and print it with a QR")
      .option("--name <label>", "a label for the phone until it names itself")
      .option("--host <host>", "the host the phone should reach (default: Tailscale IPv4)")
      .option("--port <port>", "the port the phone should reach (default: 7877)")
      .option("--ttl <seconds>", "how long the code is valid (default 600)")
      .action(async (opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const ttl = toInt(opts["ttl"] as string | undefined);
        const input = validate(
          pairSchema,
          defined({
            name: opts["name"],
            host: opts["host"],
            port: toInt(opts["port"] as string | undefined),
            ttl_ms: ttl === undefined ? undefined : ttl * 1000,
          }),
        );
        const result = await ctx.hermetic.mobile.pair(input);
        if (ctx.flags.json) await outJson(result);
        else await out(renderPair(result, { qr: true }));
      }),
  );

  mobile.addCommand(
    globals(new Cmd("devices"))
      .description("list paired phones")
      .action(async (_opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const result = await ctx.hermetic.mobile.devices(validate(devicesSchema, {}));
        if (ctx.flags.json) await outJson(result);
        else await out(renderDevices(result));
      }),
  );

  mobile.addCommand(
    globals(new Cmd("revoke"))
      .description("revoke a paired phone; its token stops working at once")
      .argument("<device_id>", "the device, from `mobile devices`")
      .action(async (deviceId: string, _opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const result = await ctx.hermetic.mobile.revoke(
          validate(revokeSchema, { device_id: deviceId }),
        );
        if (ctx.flags.json) await outJson(result);
        else await out(result.revoked ? `${deviceId}: revoked\n` : `${deviceId}: not paired\n`);
      }),
  );

  mobile.addCommand(
    globals(new Cmd("settings"))
      .description("read or change the bridge settings the desktop app follows")
      .option("--enable", "serve the bridge whenever the desktop app runs")
      .option("--disable", "stop serving it from the desktop app")
      .option("--host <host>", "bind and advertise this host instead of the Tailscale IPv4")
      .option("--port <port>", "bind and advertise this port instead of 7877")
      .action(async (opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const enable = opts["enable"] === true;
        const disable = opts["disable"] === true;
        const input = validate(
          settingsSchema,
          defined({
            enabled: enable && disable ? "both" : enable ? true : disable ? false : undefined,
            host: opts["host"],
            port: toInt(opts["port"] as string | undefined),
          }),
        );
        const result = await ctx.hermetic.mobile.settings(input);
        if (ctx.flags.json) await outJson(result);
        else await out(renderSettings(result));
      }),
  );

  mobile.addCommand(
    globals(new Cmd("serve"))
      .description("run the mobile bridge in the foreground until Ctrl-C")
      .option("--host <host>", "bind address (default: settings, then Tailscale IPv4, then 127.0.0.1)")
      .option("--port <port>", "port (default: settings, then 7877)")
      .option("--no-tick", "do not poll rosters (the desktop app is already doing it)")
      .addHelpText(
        "after",
        "\nThe bridge never binds 0.0.0.0 unless told to. Phones reach it over the\n" +
          "tailnet; pair one with `hermetic mobile pair`. Ctrl-C closes every phone\n" +
          "connection and stops any turn a phone started.\n",
      )
      .action(async (opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const input = validate(
          serveSchema,
          defined({
            host: opts["host"],
            port: toInt(opts["port"] as string | undefined),
            tick_swarms: opts["tick"] !== false,
          }),
        );
        if (input.host !== undefined && WILDCARD_HOSTS.has(input.host)) {
          await err(
            "warning: binding every interface; anything that can reach this laptop can try a token\n",
          );
        }
        const events = ctx.hermetic.mobile.serve(input, { signal: ctx.signal });
        if (ctx.flags.json || !isInteractive()) {
          await renderOp(events, { flags: ctx.flags, label: "mobile serve" });
          return;
        }
        // A server has no end to spin towards: one line per event, not a spinner.
        for await (const e of events) await err(`${e.phase.padEnd(10, " ")} ${e.message}\n`);
      }),
  );

  program.addCommand(mobile);
}
