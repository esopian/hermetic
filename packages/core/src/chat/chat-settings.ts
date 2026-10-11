/**
 * This laptop's chat preferences (§4.6, §9.2): `chat.settings`.
 *
 * Laptop state and nothing else — one `prefs` row per setting, no AWS, no
 * fleet guard, no `_fleet` write — because whether a transcript is shown whole
 * is a choice about this screen, and a colleague on the same fleet makes their
 * own. The shape `notifications.settings` has: an empty request reads, a stated
 * field writes it.
 */
import { transcriptMask } from "./chat-redact.ts";
import type { TranscriptMask } from "./chat-redact.ts";

export interface ChatSettings {
  /** Mask transcript content on its way out of core. Errors are masked either way. */
  redact: boolean;
}

/** Off: the transcript is shown as the box wrote it until the operator opts in. */
export const DEFAULT_CHAT_SETTINGS: ChatSettings = { redact: false };

export interface ChatSettingsStore {
  settings(): ChatSettings;
  setSettings(patch: Partial<ChatSettings>): ChatSettings;
}

/** The in-process store tests and a home-less instance get. */
export class MemoryChatSettingsStore implements ChatSettingsStore {
  private value: ChatSettings;
  constructor(initial: Partial<ChatSettings> = {}) {
    this.value = { ...DEFAULT_CHAT_SETTINGS, ...initial };
  }
  settings(): ChatSettings {
    return { ...this.value };
  }
  setSettings(patch: Partial<ChatSettings>): ChatSettings {
    if (patch.redact !== undefined) this.value = { ...this.value, redact: patch.redact };
    return this.settings();
  }
}

/** The mask a read takes when it starts, from whatever the store says now. */
export function maskFor(store: ChatSettingsStore): TranscriptMask {
  return transcriptMask(store.settings().redact);
}
