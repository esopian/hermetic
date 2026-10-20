/**
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
import { HERMES_ACCOUNT, HERMES_HOME } from "@hermetic/core/shared";
import pluginInit from "../../plugins/hermetic-files/__init__.py" with { type: "text" };
import pluginManifest from "../../plugins/hermetic-files/plugin.yaml" with { type: "text" };
import { asHermes, installAccountDir } from "../account-dirs.ts";
import type { Emit } from "../events.ts";
import { opEvent } from "../events.ts";
import type { Host } from "../host.ts";
import { must, stagingPathFor } from "../host.ts";

export const HERMES_PLUGIN_NAME = "hermetic-files";
export const HERMES_PLUGINS_DIR = `${HERMES_HOME}/plugins`;
export const HERMES_PLUGIN_DIR = `${HERMES_PLUGINS_DIR}/${HERMES_PLUGIN_NAME}`;

/** The plugin as hermeticd carries it: file name → content. */
export const HERMES_PLUGIN_FILES: ReadonlyArray<{ readonly name: string; readonly content: string }> = [
  { name: "plugin.yaml", content: pluginManifest },
  { name: "__init__.py", content: pluginInit },
];

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

/**
 * Stage as `hermes` (exclusive create, at `mode`), then rename over the target
 * as `hermes`: a new inode every time, and root never writes under `/data`.
 */
export async function writeAsAccount(
  host: Host,
  path: string,
  content: string,
  mode: string = PLUGIN_FILE_MODE,
): Promise<void> {
  const staging = stagingPathFor(path);
  const bytes = new TextEncoder().encode(content);
  try {
    await host.writeStreamAs(
      HERMES_ACCOUNT,
      staging,
      (async function* () {
        yield bytes;
      })(),
      { mode },
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
 * Put the embedded plugin at `HERMES_PLUGIN_DIR`, writing only files whose
 * content differs. Returns whether anything changed (or, dry, would change).
 *
 * Best effort, like `ensureAgentVenv`: a failure is a `warn` event and the
 * apply goes on, because Hermes runs without the plugin — it only lacks the
 * file tools until the next apply tries again.
 */
export async function ensureHermesPlugin(host: Host, emit: Emit, dry: boolean): Promise<boolean> {
  try {
    if (!dry) {
      await installAccountDir(host, HERMES_PLUGINS_DIR, "0700");
      await installAccountDir(host, HERMES_PLUGIN_DIR, "0700");
    }
    const stale: Array<{ readonly name: string; readonly content: string }> = [];
    for (const file of HERMES_PLUGIN_FILES) {
      if ((await installedContent(host, `${HERMES_PLUGIN_DIR}/${file.name}`)) !== file.content) {
        stale.push(file);
      }
    }
    if (stale.length === 0) return false;
    emit(
      opEvent(
        "accounts",
        0.39,
        `${dry ? "would install" : "installing"} the ${HERMES_PLUGIN_NAME} Hermes plugin ` +
          `(${stale.map((f) => f.name).join(", ")})`,
        host.now(),
      ),
    );
    if (dry) return true;
    for (const file of stale)
      await writeAsAccount(host, `${HERMES_PLUGIN_DIR}/${file.name}`, file.content);
    return true;
  } catch (e) {
    emit(
      opEvent(
        "accounts",
        0.39,
        `could not install the ${HERMES_PLUGIN_NAME} Hermes plugin (${e instanceof Error ? e.message : String(e)}); ` +
          "the agent has no file tools until the next apply",
        host.now(),
        "warn",
      ),
    );
    return false;
  }
}
