/**
 * The `@`-mention list over a textarea, shared by the bot composer and the
 * hosted-room composer so the two cannot drift apart on keys.
 *
 * Keys follow Hermes Desktop: ArrowUp/ArrowDown move and wrap, Tab and Enter
 * accept, Escape closes, and Space is never an accept — a mention takes a
 * literal space. Leaving the textarea closes the list the way Escape does; a
 * click on a row does not leave it (the row keeps focus where it was). The highlight belongs to one list: it goes back to the top
 * whenever the rows, the typed prefix or the token under the caret change,
 * rather than staying on an index that now names a different bot.
 */
import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";
import { filterMentions, insertMention, mentionAt } from "../chat-mentions.ts";
import type { MentionCandidate } from "../chat-mentions.ts";
import { Face } from "./Face.tsx";

export interface MentionPicker {
  /** The rows on show; empty when the list is closed. */
  options: MentionCandidate[];
  active: number;
  listId: string;
  /** Feed every change and caret move through here so the picker knows the token. */
  track: (input: HTMLTextAreaElement) => void;
  /** True when the key was the picker's; the caller then does nothing else with it. */
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  choose: (row: MentionCandidate) => void;
  /** Spread on the textarea. */
  inputProps: {
    "aria-autocomplete"?: "list";
    "aria-controls"?: string;
    "aria-expanded"?: boolean;
    "aria-activedescendant"?: string;
    onBlur?: () => void;
  };
}

export function useMentionPicker({
  text,
  setText,
  input,
  candidates,
}: {
  text: string;
  setText: (text: string) => void;
  input: RefObject<HTMLTextAreaElement | null>;
  candidates: readonly MentionCandidate[];
}): MentionPicker {
  const listId = useId();
  const [cursor, setCursor] = useState(0);
  /** The token start Escape (or a pick) closed the list on; typing reopens it. */
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const [pick, setPick] = useState({ list: "", index: 0 });
  const match = mentionAt(text, cursor);
  const options = match && match.start !== closedAt ? filterMentions(candidates, match.query) : [];
  const list = match
    ? `${match.start}\n${match.query}\n${options.map((row) => row.key).join("\n")}`
    : "";
  const active = pick.list === list ? Math.min(pick.index, Math.max(0, options.length - 1)) : 0;

  const choose = (row: MentionCandidate) => {
    if (!match) return;
    const result = insertMention(text, match, row.tag);
    setText(result.text);
    setCursor(result.cursor);
    // A pick followed by existing whitespace leaves the caret on the new tag;
    // the list must not reopen on it.
    setClosedAt(match.start);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(result.cursor, result.cursor);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (options.length === 0 || !match) return false;
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
        choose(options[active]!);
        break;
      case "Enter":
        if (event.shiftKey) return false;
        choose(options[active]!);
        break;
      case "Escape":
        // `preventDefault` keeps the composer's own Escape (stop the turn) and
        // the app shell's (close the view) from also firing.
        setClosedAt(match.start);
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
    track: (el) => {
      setCursor(el.selectionStart);
      if (el.value !== text) setClosedAt(null);
    },
    onKeyDown,
    choose,
    inputProps: candidates.length
      ? {
          "aria-autocomplete": "list",
          "aria-controls": open ? listId : undefined,
          "aria-expanded": open,
          "aria-activedescendant": open ? `${listId}-${active}` : undefined,
          // Focus gone elsewhere: a list left open would float over whatever took it.
          onBlur: () => {
            if (match) setClosedAt(match.start);
          },
        }
      : {},
  };
}

/** The list itself, drawn above the input it belongs to. */
export function MentionList({
  picker,
  fleetId,
  label,
}: {
  picker: MentionPicker;
  fleetId: string;
  label: string;
}) {
  const list = useRef<HTMLDivElement>(null);
  const { options, active, listId } = picker;
  useEffect(() => {
    // Optional call: not every DOM (the test one included) implements it.
    list.current?.children[active]?.scrollIntoView?.({ block: "nearest" });
  }, [active, options.length]);
  if (options.length === 0) return null;
  return (
    <div className="bm-mentions" role="listbox" aria-label={label} id={listId} ref={list}>
      {options.map((row, index) => (
        <button
          type="button"
          role="option"
          id={`${listId}-${index}`}
          aria-selected={index === active}
          key={row.key}
          tabIndex={-1}
          // Keep focus (and the caret) in the textarea through the click.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => picker.choose(row)}
        >
          <Face
            fleetId={fleetId}
            instance={row.instance}
            bot={row.bot}
            size={20}
            status="ready"
            square={false}
          />
          <b>{row.display}</b>
          <span className="mono">@{row.tag}</span>
        </button>
      ))}
    </div>
  );
}
