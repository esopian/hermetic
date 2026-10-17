/**
 * The developer tools' surface (§9.2 "Developer tools"): `hermetic.devtools`.
 *
 * Not a §9 command. It has no CLI verb and no `PUBLIC_METHODS` entry; the
 * desktop head reaches it through machinery requests. It is built in every
 * mode — the stream inspector is as useful against the fixture as against a
 * real box — and it is the one owner of the capture's lifetime: the `DevTap`
 * exists exactly while the `enabled` preference is on (`current`), so every tap
 * site in the adapter finds `null` the instant the tools are turned off.
 *
 * The preferences are this laptop's, one `prefs` row each, the way
 * `chat.settings`' redaction switch is (`chat-settings.ts`): an empty request
 * reads, a stated field writes it.
 */
import { HermeticError } from "../errors.ts";
import {
  DEFAULT_DEVTOOLS_SETTINGS,
  DevtoolsClearInput,
  DevtoolsExportInput,
  DevtoolsSettingsInput,
  DevtoolsTapInput,
} from "../schema/index.ts";
import type { DevtoolsExport, DevtoolsSettings, DevtoolsStats, TapRecord } from "../schema/index.ts";
import { parse } from "./chat-seal.ts";
import { DevTap } from "./devtap.ts";

export interface DevtoolsSettingsStore {
  settings(): DevtoolsSettings;
  setSettings(patch: Partial<DevtoolsSettings>): DevtoolsSettings;
}

/** The in-process store tests and a home-less instance get. */
export class MemoryDevtoolsSettingsStore implements DevtoolsSettingsStore {
  private value: DevtoolsSettings;
  constructor(initial: Partial<DevtoolsSettings> = {}) {
    this.value = { ...DEFAULT_DEVTOOLS_SETTINGS, ...initial };
  }
  settings(): DevtoolsSettings {
    return { ...this.value };
  }
  setSettings(patch: Partial<DevtoolsSettings>): DevtoolsSettings {
    this.value = {
      enabled: patch.enabled ?? this.value.enabled,
      capture: patch.capture ?? this.value.capture,
      keep: patch.keep ?? this.value.keep,
    };
    return this.settings();
  }
}

export interface DevtoolsControls {
  /** Read with no input (or `{}`); a stated field writes it. `VALIDATION` on a bad field. */
  settings(input?: unknown): DevtoolsSettings;
  /** `DEVTOOLS_DISABLED` while the tools are off. */
  stats(): DevtoolsStats;
  /**
   * One conversation's backlog, then every record after it. A record whose
   * fate is settled after it was delivered is delivered again with the same
   * id: a reader upserts by id. Ends when `signal` aborts or the tools are
   * turned off. Validated, and refused with `DEVTOOLS_DISABLED`, before the
   * iterable is returned.
   */
  tap(input: unknown, opts?: { signal?: AbortSignal | undefined }): AsyncIterable<TapRecord>;
  /** One conversation's capture, or every one's when none is named. */
  clear(input?: unknown): { cleared: number };
  /** NDJSON, always masked, whatever Chat › Redact secrets says. */
  export(input: unknown): DevtoolsExport;
}

export interface DevtoolsDeps {
  store?: DevtoolsSettingsStore | undefined;
  /** Chat › Redact secrets, read at each capture and each read. */
  redact: () => boolean;
}

export interface Devtools {
  controls: DevtoolsControls;
  /** The live capture, or `null` while the tools are off: what every tap site asks. */
  current(): DevTap | null;
}

export function createDevtools(deps: DevtoolsDeps): Devtools {
  const store = deps.store ?? new MemoryDevtoolsSettingsStore();
  let tap: DevTap | null = null;

  /** Bring the capture in line with the preferences: built, re-bounded or discarded. */
  function apply(settings: DevtoolsSettings): void {
    if (!settings.enabled) {
      tap?.close();
      tap = null;
      return;
    }
    if (tap === null) {
      tap = new DevTap({ capture: settings.capture, keep: settings.keep, redact: deps.redact });
      return;
    }
    tap.configure({ capture: settings.capture, keep: settings.keep });
  }
  apply(store.settings());

  function live(): DevTap {
    if (tap === null)
      throw new HermeticError("DEVTOOLS_DISABLED", "developer tools are off (Settings › Developer)");
    return tap;
  }

  const controls: DevtoolsControls = {
    settings(input: unknown = {}) {
      const parsed = parse(DevtoolsSettingsInput, input ?? {}, "devtools settings");
      const next = Object.keys(parsed).length === 0 ? store.settings() : store.setSettings(parsed);
      apply(next);
      return next;
    },
    stats() {
      return live().stats();
    },
    tap(input, opts = {}) {
      const parsed = parse(DevtoolsTapInput, input, "devtools tap");
      return live().subscribe(parsed.conversation, opts.signal);
    },
    clear(input: unknown = {}) {
      const parsed = parse(DevtoolsClearInput, input ?? {}, "devtools clear");
      return { cleared: live().clear(parsed.conversation) };
    },
    export(input) {
      const parsed = parse(DevtoolsExportInput, input, "devtools export");
      return live().exportRing(parsed.conversation, parsed.ids);
    },
  };

  return { controls, current: () => tap };
}
