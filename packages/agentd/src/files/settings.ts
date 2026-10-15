/**
 * The fleet's files settings as this box holds them: `require_cap`, `max_bytes`
 * and `retention_days` (`FleetManifest.files`, resolved by core's
 * `resolveFilesSettings` so every reader agrees on what absent means).
 *
 * The box has no copy of the fleet's settings but the fleet manifest, so the
 * holder is fed from wherever hermeticd reads one: the cached manifest at
 * `serve` start, then every fetch the update loop makes — the nightly run, a
 * rollout request, and the auto-update backstop every `AUTO_UPDATE_CHECK_MS`,
 * which fetches whether or not auto-update is on (`update/index.ts`). **A
 * change to the fleet's settings therefore takes effect at the box's next
 * manifest read**, within minutes, not at the moment the laptop writes it.
 * Until a manifest has been read, the defaults apply.
 *
 * Readers call `current()` per use rather than keeping the value, so a new
 * read reaches the next upload, listing, sweep and tailnet call.
 */
import {
  type FilesSettings,
  type FilesSettingsSource,
  resolveFilesSettings,
} from "@hermetic/core/shared";

/** What a settings source looks like: a fleet manifest, or anything else carrying `files`. */
export type FilesSettingsInput =
  | { readonly files?: FilesSettingsSource | null | undefined }
  | null
  | undefined;

export interface FilesSettingsHolder {
  /** The settings now in force. */
  readonly current: () => FilesSettings;
  /** A manifest was read: adopt its settings. Never throws. */
  readonly update: (source: FilesSettingsInput) => void;
}

function describe(s: FilesSettings): string {
  return `require_cap=${s.require_cap ? "on" : "off"} max_bytes=${s.max_bytes} retention_days=${s.retention_days}`;
}

export function makeFilesSettings(
  initial: FilesSettingsInput = null,
  log: (message: string) => void = () => {},
): FilesSettingsHolder {
  let settings = resolveFilesSettings(initial);
  return {
    current: () => settings,
    update(source) {
      let next: FilesSettings;
      try {
        next = resolveFilesSettings(source);
      } catch {
        return;
      }
      if (describe(next) === describe(settings)) return;
      log(`files: fleet settings now ${describe(next)}`);
      settings = next;
    },
  };
}
