/**
 * The developer tools' requests (§9.2 "Developer tools",
 * `app/src/handlers/devtools.ts`): this laptop's stream inspector settings, the
 * capture's facts, a tap on one conversation, and the capture's clear and
 * masked export.
 *
 * Every one but `devtoolsSettings` is refused `DEVTOOLS_DISABLED` while the
 * tools are off, so nothing on the page calls them unless the gate
 * (`state/devtools-store.ts`) says the tools are on.
 */
import { transport } from "./transport.ts";
import type {
  DevtoolsConversationView,
  DevtoolsExportView,
  DevtoolsSettingsView,
  DevtoolsStatsView,
  TapRecordView,
} from "./types.ts";

/** An empty input reads; a stated field writes it and answers the whole row. */
export function devtoolsSettings(
  input: Partial<DevtoolsSettingsView> = {},
): Promise<DevtoolsSettingsView> {
  return transport().request<DevtoolsSettingsView>("devtools.settings", { ...input });
}

export function devtoolsStats(): Promise<DevtoolsStatsView> {
  return transport().request<DevtoolsStatsView>("devtools.stats", {});
}

/** One conversation's capture, or every conversation's when none is named. */
export function devtoolsClear(conversation?: DevtoolsConversationView): Promise<{ cleared: number }> {
  return transport().request<{ cleared: number }>(
    "devtools.clear",
    conversation === undefined ? {} : { conversation },
  );
}

/** Always masked, whatever Chat › Redact secrets says. `ids` narrows it to those records. */
export function devtoolsExport(
  conversation: DevtoolsConversationView,
  ids?: readonly string[],
): Promise<DevtoolsExportView> {
  return transport().request<DevtoolsExportView>("devtools.export", {
    conversation,
    ...(ids === undefined ? {} : { ids: [...ids] }),
  });
}

export interface TapHandlers {
  /** A batch of records, in capture order: the backlog first, then live ones. */
  onRecords: (records: readonly TapRecordView[]) => void;
  /** The tap ended on its own — the tools went off, or it could not open. Never after the closer ran. */
  onEnd: (failure: { code: string; message: string } | null) => void;
}

/** Open a tap on one conversation. Returns the closer, which sends `devtools.untap`. */
export function devtoolsTap(conversation: DevtoolsConversationView, handlers: TapHandlers): () => void {
  return transport().openStream(
    "devtools.tap",
    { conversation },
    {
      onFrame: (frame) => {
        if (frame.event === "records" && Array.isArray(frame.data)) {
          handlers.onRecords(frame.data as TapRecordView[]);
          return;
        }
        if (frame.event === "done") {
          const error = (frame.data as { error?: { code?: unknown; message?: unknown } } | null)?.error;
          handlers.onEnd(
            error && typeof error.code === "string"
              ? { code: error.code, message: typeof error.message === "string" ? error.message : "" }
              : null,
          );
        }
      },
      onEnd: (ok, failure) => {
        // A `done` frame already reported the end; this is the open refused.
        if (!ok) handlers.onEnd(failure);
      },
    },
  );
}
