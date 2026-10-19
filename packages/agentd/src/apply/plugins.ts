/**
 * The Hermes plugins hermeticd carries: `hermetic-files` on every box, and the
 * `prme` memory provider for an agent on `prism` (`BUNDLED_MEMORY_PLUGINS`,
 * installed by `memory-service.ts`).
 *
 * The `hermetic-files` Hermes plugin (plan §06): `request_file`,
 * `request_secret`, `await_file`, `list_files`, `share_file`, the tool-result
 * scrub hook, and the `MEDIA:` line hook that turns a reply's file into a share.
 *
 * **Shipped inside hermeticd.** The plugin's two files are imported as text, so
 * `bun build --compile` embeds them in the binary and the box needs no second
 * download: whatever hermeticd is running is the plugin it installs. An edit to
 * `packages/agentd/plugins/` therefore moves the release fingerprint
 * (`FINGERPRINT_DIRS`, `@hermetic/core`'s `release/artifacts-release.ts`) and
 * reaches a fleet through `hermetic artifacts push`, the same as hermeticd.
 *
 * **Installed as the account.** `$HERMES_HOME/plugins/hermetic-files` is under
 * `/data/hermes`, so every directory is made by `installAccountDir` (which
 * refuses a symlink) and every file is written by `hermes` itself — staged
 * under an unguessable name, then renamed over the old one — so root never
 * creates or follows anything there.
 *
 * **Enabled by the managed config** (`plugins.enabled`, `render-hermes.ts`).
 * Hermes reads plugins at start. The first install lands with the managed
 * config that enables it, whose `restart_units` restart Hermes; a later edit to
 * the plugin alone restarts nothing (a restart ends every live turn) and is
 * picked up at Hermes's next start.
 */
/// <reference path="../plugin-assets.d.ts" />
import { HERMES_ACCOUNT, HERMES_HOME, type MemoryServiceId } from "@hermetic/core/shared";
import pluginInit from "../../plugins/hermetic-files/__init__.py" with { type: "text" };
import pluginManifest from "../../plugins/hermetic-files/plugin.yaml" with { type: "text" };
import prmeInit from "../../plugins/prme/__init__.py" with { type: "text" };
import prmeManifest from "../../plugins/prme/plugin.yaml" with { type: "text" };
import { asHermes, installAccountDir } from "../account-dirs.ts";
import type { Emit } from "../events.ts";
import { opEvent } from "../events.ts";
import type { Host } from "../host.ts";
import { must, stagingPathFor } from "../host.ts";

export const HERMES_PLUGIN_NAME = "hermetic-files";
export const HERMES_PLUGINS_DIR = `${HERMES_HOME}/plugins`;
export const HERMES_PLUGIN_DIR = `${HERMES_PLUGINS_DIR}/${HERMES_PLUGIN_NAME}`;

/** A plugin as hermeticd carries it: file name → content. */
export type PluginFiles = ReadonlyArray<{ readonly name: string; readonly content: string }>;

export const HERMES_PLUGIN_FILES: PluginFiles = [
  { name: "plugin.yaml", content: pluginManifest },
  { name: "__init__.py", content: pluginInit },
];

/**
 * Memory-provider plugins hermeticd ships itself, for a service provider whose
 * spec names no catalog checkout (`MemoryServiceSpec.plugin` null). Installed
 * into `hermesPluginDir(hermesMemoryProviderName(provider))`.
 */
export const BUNDLED_MEMORY_PLUGINS: Partial<Record<MemoryServiceId, PluginFiles>> = {
  prism: [
    { name: "plugin.yaml", content: prmeManifest },
    { name: "__init__.py", content: prmeInit },
  ],
};

/** Plain files Hermes imports: readable, not executable, the account's. */
const PLUGIN_FILE_MODE = "0644";

/** What is at `path` now, read as the account (refusing a symlink); `null` if nothing readable. */
async function installedContent(host: Host, path: string): Promise<string | null> {
  try {
    return await new Response(host.readStreamAs(HERMES_ACCOUNT, path)).text();
  } catch {
    return null;
  }
}

/** Stage as `hermes` (exclusive create), then rename over the target as `hermes`. */
async function writeAsAccount(host: Host, path: string, content: string): Promise<void> {
  const staging = stagingPathFor(path);
  const bytes = new TextEncoder().encode(content);
  try {
    await host.writeStreamAs(
      HERMES_ACCOUNT,
      staging,
      (async function* () {
        yield bytes;
      })(),
      { mode: PLUGIN_FILE_MODE },
    );
    // `-T`: never "into" a directory someone made at the name. A rename
    // replaces a symlink at `path` rather than writing through it.
    await must(host, asHermes(["mv", "-f", "-T", "--", staging, path]));
  } catch (e) {
    await host.exec(asHermes(["rm", "-f", "--", staging])).catch(() => undefined);
    throw e;
  }
}

/**
 * Put an embedded plugin at `$HERMES_HOME/plugins/<name>`, writing only files
 * whose content differs. Returns whether anything changed (or, dry, would
 * change).
 *
 * Best effort, like `ensureAgentVenv`: a failure is a `warn` event and the
 * apply goes on, because Hermes runs without the plugin — it only lacks the
 * plugin's tools until the next apply tries again. `fatal` rethrows instead,
 * for a memory plugin, whose absence would leave Hermes on built-in memory
 * with nothing saying so.
 */
export async function ensureBundledPlugin(
  host: Host,
  emit: Emit,
  dry: boolean,
  plugin: { readonly name: string; readonly files: PluginFiles; readonly fatal?: boolean },
): Promise<boolean> {
  const dir = `${HERMES_PLUGINS_DIR}/${plugin.name}`;
  try {
    if (!dry) {
      await installAccountDir(host, HERMES_PLUGINS_DIR, "0700");
      await installAccountDir(host, dir, "0700");
    }
    const stale: Array<{ readonly name: string; readonly content: string }> = [];
    for (const file of plugin.files) {
      if ((await installedContent(host, `${dir}/${file.name}`)) !== file.content) {
        stale.push(file);
      }
    }
    if (stale.length === 0) return false;
    emit(
      opEvent(
        "accounts",
        0.39,
        `${dry ? "would install" : "installing"} the ${plugin.name} Hermes plugin ` +
          `(${stale.map((f) => f.name).join(", ")})`,
        host.now(),
      ),
    );
    if (dry) return true;
    for (const file of stale) await writeAsAccount(host, `${dir}/${file.name}`, file.content);
    return true;
  } catch (e) {
    if (plugin.fatal) throw e;
    emit(
      opEvent(
        "accounts",
        0.39,
        `could not install the ${plugin.name} Hermes plugin (${e instanceof Error ? e.message : String(e)}); ` +
          "the agent goes without it until the next apply",
        host.now(),
        "warn",
      ),
    );
    return false;
  }
}
