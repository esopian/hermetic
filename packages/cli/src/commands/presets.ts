/**
 * `hermetic presets show` and `presets set` (§9): this laptop's create
 * presets — the machine bundles `agent create` starts from, and the four the
 * New agent panel offers.
 *
 * Local, like `inbox`: one row in this laptop's `prefs` table, never the
 * fleet's. The app's Settings › Create presets page edits the same row, so a
 * loadout arranged there is the one `agent create --preset` and a bare
 * `agent create` read here.
 */
import type { Command } from "commander";
import { Command as Cmd } from "commander";
import {
  GP3_USD_PER_GIB_MONTH,
  HermeticError,
  PresetsGetInput,
  PresetsSetInput,
  SIZES,
  isSizeId,
} from "@hermetic/core";
import type { PresetsView } from "@hermetic/core";
import { openCtx } from "../context.ts";
import { globals } from "../options.ts";
import { validate } from "../validate.ts";
import { out, outJson } from "../io.ts";
import { renderTable } from "../table.ts";
import { declare } from "../declare.ts";

const getSchema = declare("presets.get", "presets show", PresetsGetInput);
const setSchema = declare("presets.set", "presets set", PresetsSetInput);

function monthly(size: string, volumeGib: number, rootGib: number): string {
  if (!isSizeId(size)) return "—";
  const usd = SIZES[size].monthlyUsd + (volumeGib + rootGib) * GP3_USD_PER_GIB_MONTH;
  return `$${Math.round(usd).toLocaleString("en-US")}`;
}

/** The loadout line, then one row per preset with where it sits in the loadout. */
export function renderPresets(view: PresetsView): string {
  const slot = (id: string) => view.loadout.indexOf(id);
  const loadout = view.loadout
    .map((id) => (id === null ? "(empty)" : id === view.default ? `${id}*` : id))
    .join(" · ");
  const rows = view.presets.map((p) => {
    const at = slot(p.id);
    return [
      p.id,
      p.name,
      p.builtin ? p.lane : "custom",
      p.usable ? p.size : `${p.size} (unknown size)`,
      isSizeId(p.size) ? SIZES[p.size].instance_type : "—",
      `${p.volume_gib} GiB`,
      `${p.root_gib} GiB`,
      monthly(p.size, p.volume_gib, p.root_gib),
      at < 0 ? "—" : `${at + 1}${p.id === view.default ? " *" : ""}`,
    ];
  });
  const table = renderTable(rows, [
    "ID",
    "NAME",
    "LANE",
    "SIZE",
    "INSTANCE",
    "DATA",
    "SYSTEM",
    "≈/MO",
    "SLOT",
  ]);
  const source = view.source === "builtin" ? " (built-in; nothing saved on this laptop)" : "";
  return `loadout  ${loadout}${source}\n\n${table}\n* the default: what \`agent create\` with no machine flags uses`;
}

/** `--loadout light,standard,-,gpu`: four ids, `-` for an empty slot. */
function parseLoadout(raw: string): (string | null)[] {
  return raw.split(",").map((s) => {
    const id = s.trim();
    return id === "-" || id === "" ? null : id;
  });
}

async function readJsonFile(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch {
    throw new HermeticError("VALIDATION", `cannot read ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HermeticError("VALIDATION", `${path} is not JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HermeticError("VALIDATION", `${path} must hold a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

export function register(program: Command): void {
  const presets = new Cmd("presets").description(
    "this laptop's create presets: the machine bundles agent create starts from",
  );

  presets.addCommand(
    globals(new Cmd("show"))
      .description("the loadout, its default, and every built-in and custom preset")
      .action(async (_opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const view = await ctx.hermetic.presets.get(validate(getSchema, {}));
        if (ctx.flags.json) await outJson(view);
        else await out(`${renderPresets(view)}\n`);
      }),
  );

  presets.addCommand(
    globals(new Cmd("set"))
      .description("change the loadout, the default, or the custom presets")
      .option(
        "--file <path>",
        "a JSON object with any of loadout, default, custom (`presets show --json` is one)",
      )
      .option("--loadout <ids>", "four comma-separated preset ids, `-` for an empty slot")
      .option("--default <id>", "the preset a create with no machine flags uses")
      .option("--reset", "forget this laptop's presets: back to Light · Standard · Heavy · GPU")
      .addHelpText(
        "after",
        "\nA preset is a machine: size, data volume and system disk. It lives on this\n" +
          "laptop only; another laptop on the same fleet keeps its own.\n" +
          "\nExamples:\n" +
          "  hermetic presets set --default heavy\n" +
          "  hermetic presets set --loadout light,standard,heavy,gpu-m\n" +
          "  hermetic presets show --json > p.json   # edit custom, then:\n" +
          "  hermetic presets set --file p.json\n" +
          "  hermetic presets set --reset\n",
      )
      .action(async (opts: Record<string, unknown>, cmd: Command) => {
        const ctx = await openCtx(cmd);
        const file =
          typeof opts["file"] === "string"
            ? await readJsonFile(opts["file"])
            : ({} as Record<string, unknown>);
        const body: Record<string, unknown> = {};
        for (const k of ["loadout", "default", "custom"] as const) {
          if (k in file) body[k] = file[k];
        }
        if (typeof opts["loadout"] === "string") body["loadout"] = parseLoadout(opts["loadout"]);
        if (typeof opts["default"] === "string") body["default"] = opts["default"];
        if (opts["reset"] === true) body["reset"] = true;
        const view = await ctx.hermetic.presets.set(validate(setSchema, body));
        if (ctx.flags.json) await outJson(view);
        else await out(`${renderPresets(view)}\n`);
      }),
  );

  program.addCommand(presets);
}
