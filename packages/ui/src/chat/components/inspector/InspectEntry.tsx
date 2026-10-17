/**
 * The ways into the stream inspector (§9.2 "Developer tools"). Every one is
 * gated on the tools being on: with them off none of these renders, and the
 * shortcut is not even listened for.
 *
 * - `InspectChip` — the dashed `{ } Inspect` chip, first in a full-view thread
 *   header. Solid while the inspector is open on that conversation.
 * - `DockInspectButton` — the dock's `{ }`: the dock is too narrow for a
 *   split, so it opens the full chat view on that conversation with the
 *   inspector already open.
 * - `InspectMessageContext` — a message's hover action, `{ } Inspect message`,
 *   which opens the inspector filtered to that message.
 * - `InspectorShortcut` — ⌥⌘I toggles the inspector for the selected
 *   conversation, opening the full chat view on it first when it is not
 *   already on screen.
 *
 * A dashed border marks every developer affordance, so a screenshot of a
 * dev-enabled app cannot be mistaken for product UI.
 */
import { createContext, useContext, useEffect, useRef } from "react";
import { useChat } from "../../chat-state.tsx";
import { useChatEntry } from "../../chat-entry-state.tsx";
import { isChatHash } from "../../chat-routing.ts";
import type { ConversationRef } from "../../inspector-logic.ts";
import { useDevtools } from "../../../state/devtools-store.ts";

export function InspectChip({ conversation }: { conversation: ConversationRef }) {
  const devtools = useDevtools();
  if (!devtools.enabled) return null;
  const on = devtools.isOpenOn(conversation);
  return (
    <button
      type="button"
      className={`ch-chip insp-chip${on ? " on" : ""}`}
      aria-pressed={on}
      title="Inspect this conversation's stream (⌥⌘I)"
      onClick={() => devtools.toggle(conversation)}
    >
      <span aria-hidden="true">{"{ }"}</span> Inspect
    </button>
  );
}

export function DockInspectButton({ conversation }: { conversation: ConversationRef }) {
  const devtools = useDevtools();
  const entry = useChatEntry();
  if (!devtools.enabled || entry === null) return null;
  return (
    <button
      type="button"
      className="ch-chip insp-chip"
      aria-label="Inspect stream"
      title="Open this conversation in the full chat view with the stream inspector"
      onClick={() => {
        if (entry.open(conversation, "full")) devtools.open(conversation);
      }}
    >
      {"{ }"}
    </button>
  );
}

/** Set by a surface that can open the inspector beside its thread; null everywhere else. */
export const InspectMessageContext = createContext<((message: string) => void) | null>(null);

export function useInspectMessage(): ((message: string) => void) | null {
  return useContext(InspectMessageContext);
}

/** The message action itself, drawn in the message head. */
export function InspectMessageButton({ message }: { message: string }) {
  const inspect = useInspectMessage();
  if (inspect === null) return null;
  return (
    <button
      type="button"
      className="ch-msg-inspect"
      title="Open the stream inspector filtered to this message"
      onClick={() => inspect(message)}
    >
      {"{ }"} Inspect message
    </button>
  );
}

/** Whether a key event is ⌥⌘I. Read by `code`, because ⌥ changes what `key` reads. */
export function isInspectorShortcut(
  e: Pick<KeyboardEvent, "altKey" | "metaKey" | "ctrlKey" | "shiftKey" | "code">,
): boolean {
  return e.altKey && (e.metaKey || e.ctrlKey) && !e.shiftKey && e.code === "KeyI";
}

export function InspectorShortcut() {
  const devtools = useDevtools();
  const chat = useChat();
  const entry = useChatEntry();
  const latest = useRef({ devtools, selection: chat.selection, entry });
  latest.current = { devtools, selection: chat.selection, entry };
  const enabled = devtools.enabled;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || !isInspectorShortcut(e)) return;
      const { devtools: gate, selection, entry: frames } = latest.current;
      if (selection === null) return;
      e.preventDefault();
      if (isChatHash(window.location.hash)) {
        gate.toggle(selection);
        return;
      }
      if (frames?.open(selection, "full")) gate.open(selection);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
  return null;
}
