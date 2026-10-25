/**
 * The slash-command list over the composer (issue #76): the gateway's catalog,
 * filtered as a command name is typed (`slashQuery` and friends, `@hermetic/core/shared`).
 *
 * Keys follow the mention list's (`MentionPicker.tsx`): ArrowUp/ArrowDown move
 * and wrap, Tab accepts, Escape closes without touching the text, and leaving
 * the textarea closes it. Accepting puts `/name ` in the composer with the
 * caret after the space. Enter accepts the same way, except on a command that
 * takes no argument, which it sends as it stands; and once the whole name is
 * typed, Enter is the composer's again, so `/help⏎` still sends `/help`.
 *
 * Escape closes the list on the text it was pressed on; any edit reopens it.
 * The highlight goes back to the top whenever the rows change.
 */
import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";
import type { ChatCommandView } from "../../api/types.ts";
import { acceptSlash, filterSlashCommands, slashQuery, takesArgument } from "@hermetic/core/shared";
import type { SlashMatch as SharedSlashMatch } from "@hermetic/core/shared";

type SlashMatch = SharedSlashMatch<ChatCommandView>;

export interface SlashPicker {
  /** The rows on show; empty when the list is closed. */
  options: SlashMatch[];
  active: number;
  listId: string;
  /** True when the key was the picker's; the caller then does nothing else with it. */
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** Accept a row: insert it, or — `run`, for a command with no argument — send it. */
  choose: (row: SlashMatch, run?: boolean) => void;
  /** Spread on the textarea while the list is open. */
  inputProps: {
    "aria-autocomplete"?: "list";
    "aria-controls"?: string;
    "aria-expanded"?: boolean;
    "aria-activedescendant"?: string;
    "data-owns-escape"?: string;
  };
  /** Close the list (focus left the textarea). */
  close: () => void;
}

export function useSlashPicker({
  text,
  setText,
  input,
  commands,
  onRun,
}: {
  text: string;
  setText: (text: string) => void;
  input: RefObject<HTMLTextAreaElement | null>;
  commands: readonly ChatCommandView[];
  /** Send a whole command line, as Enter in the composer would. */
  onRun: (line: string) => void;
}): SlashPicker {
  const listId = useId();
  /** The text Escape (or a blur) closed the list on; any other text reopens it. */
  const [closedOn, setClosedOn] = useState<string | null>(null);
  const [pick, setPick] = useState({ list: "", index: 0 });
  const query = slashQuery(text);
  const options = query !== null && text !== closedOn ? filterSlashCommands(commands, query) : [];
  const list = `${query}\n${options.map((row) => row.command.name).join("\n")}`;
  const active = pick.list === list ? Math.min(pick.index, Math.max(0, options.length - 1)) : 0;

  const choose = (row: SlashMatch, run = false) => {
    if (run && !takesArgument(row.command)) {
      onRun(row.command.name);
      return;
    }
    const next = acceptSlash(row.command);
    setText(next);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(next.length, next.length);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (options.length === 0) return false;
    const row = options[active]!;
    const move = (delta: number) =>
      setPick({ list, index: (active + delta + options.length) % options.length });
    switch (event.key) {
      case "ArrowDown":
        move(1);
        break;
      case "ArrowUp":
        move(-1);
        break;
      case "Tab":
        if (event.shiftKey) return false;
        choose(row);
        break;
      case "Enter":
        // Shift is a newline and ⌘ sends now; neither is a pick. Nor is Enter
        // on a name typed in full: that line is the command to send.
        if (event.shiftKey || event.metaKey || event.ctrlKey) return false;
        if (row.command.name.slice(1).toLowerCase() === query) return false;
        choose(row, true);
        break;
      case "Escape":
        // `preventDefault` keeps the composer's own Escape (stop the turn) and
        // the app shell's (close the view) from also firing.
        setClosedOn(text);
        break;
      default:
        return false;
    }
    event.preventDefault();
    return true;
  };

  const open = options.length > 0;
  return {
    options,
    active,
    listId,
    onKeyDown,
    choose,
    close: () => {
      if (open) setClosedOn(text);
    },
    inputProps: open
      ? {
          "aria-autocomplete": "list",
          "aria-controls": listId,
          "aria-expanded": true,
          "aria-activedescendant": `${listId}-${active}`,
          // The chat shell takes Escape in the capture phase to stop a turn;
          // while the list is open, Escape is the list's (`ownsEscape`).
          "data-owns-escape": "",
        }
      : {},
  };
}

/** The list itself, drawn above the input it belongs to. */
export function SlashList({ picker }: { picker: SlashPicker }) {
  const list = useRef<HTMLDivElement>(null);
  const { options, active, listId } = picker;
  useEffect(() => {
    // Optional call: not every DOM (the test one included) implements it.
    list.current?.children[active]?.scrollIntoView?.({ block: "nearest" });
  }, [active, options.length]);
  if (options.length === 0) return null;
  return (
    <div className="ch-slash" role="listbox" aria-label="Slash commands" id={listId} ref={list}>
      {options.map((row, index) => {
        const { command, start, end } = row;
        const name = command.name.slice(1);
        return (
          <button
            type="button"
            role="option"
            id={`${listId}-${index}`}
            aria-selected={index === active}
            key={command.name}
            tabIndex={-1}
            title={command.description || undefined}
            // Keep focus (and the caret) in the textarea through the click.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => picker.choose(row)}
          >
            <span className="ch-slash-name">
              /{name.slice(0, start)}
              <b>{name.slice(start, end)}</b>
              {name.slice(end)}
            </span>
            {command.description ? <span className="ch-slash-desc">{command.description}</span> : null}
            {command.skill ? (
              <span className="ch-slash-tag">
                {command.skill.origin ? `skill · ${command.skill.origin}` : "skill"}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
