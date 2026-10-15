/**
 * The masked text box on a text secret card (`request_secret`, attachments
 * plan §06b and §8.4b): where an operator pastes a token, a password, a PEM or
 * a whole `.env` block for an agent's tools.
 *
 * The value lives in a ref and in the real field's DOM value, nowhere else —
 * never React state, props or context, so it cannot reach a render snapshot,
 * dev-tools state, the conversation draft or the queue. What *is* state is the
 * parse summary the card shows (format, a chip per key with its length, the
 * issues, line and byte counts, and the masked view's line shape): key names
 * and numbers, never a value. The ref and the field are emptied on submit, on
 * Esc and on unmount.
 *
 * Masking is one strategy in both renderers (renderer rule 2): the real field's
 * glyphs are transparent (and `-webkit-text-security: disc` on top, as a second
 * layer), and an `aria-hidden` overlay under it draws one dot per character in
 * the same monospace metrics, so the caret and selection of the real field land
 * on the dots. The overlay keeps line breaks with a line-number gutter, and in
 * `.env` form shows the key names before `=` because those are what the chips
 * check. It is drawn for both modes, so the single-line field shows
 * `GITHUB_TOKEN=•••` too. Holding ⌥ reveals; releasing it, blurring the window
 * or 10 s without input hides it again.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  ClipboardEvent,
  CSSProperties,
  DragEvent,
  FormEvent,
  JSX,
  KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { parseSecretEnv } from "@hermetic/core/shared";
import type { SecretEnvChip, SecretFormat, SecretInputMode } from "@hermetic/core/shared";
import { fmtBytes } from "../../chat-logic.ts";
import "./SecretTextInput.css";

export interface SecretTextInputProps {
  /** Required env names from hermeticd's slot. */
  keys: readonly string[];
  optional_keys?: readonly string[];
  /** Starting mode only: `auto` is single-line, or multi-line for two or more keys. */
  input?: "auto" | "single" | "multi";
  disabled?: boolean;
  /** A submit is in flight. */
  busy?: boolean;
  /** hermeticd's refusal, shown under the field. */
  boxError?: string | null;
  /** The caller clears nothing; this component empties its ref once this returns. */
  onSubmit(text: string, as: "auto" | "raw" | "dotenv", ephemeral: boolean): void;
  onDecline(): void;
}

type Mode = "single" | "multi";

/** Above this the card suggests `request_file` (§06b). */
const LARGE_BYTES = 4 * 1024;
/** The textarea grows to this many lines, then scrolls. */
const MAX_ROWS = 12;
const MIN_ROWS = 3;
/** Revealed text hides again after this long without input. */
const REVEAL_IDLE_MS = 10_000;

const TREAT_AS: ReadonlyArray<{ id: SecretInputMode; label: string }> = [
  { id: "auto", label: "Auto" },
  { id: "raw", label: "Raw value" },
  { id: "dotenv", label: ".env lines" },
];

/** One line of the masked view: a visible key prefix (`.env` only), then dots. */
interface MaskLine {
  prefix: string;
  dots: number;
}

/** Everything the card shows about the text. Never the text. */
interface Summary {
  empty: boolean;
  ok: boolean;
  format: SecretFormat | null;
  chips: SecretEnvChip[];
  errors: string[];
  warnings: string[];
  /** Physical lines in the field, a trailing empty one included. */
  lines: number;
  bytes: number;
  mask: MaskLine[];
}

const NUM = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const KEY_PREFIX_RE = /^(\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=)/;

function plural(n: number, one: string, many: string): string {
  return `${NUM.format(n)} ${n === 1 ? one : many}`;
}

function codePoints(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

function normaliseBreaks(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function startingMode(input: SecretTextInputProps["input"], keys: readonly string[]): Mode {
  if (input === "single" || input === "multi") return input;
  return keys.length >= 2 ? "multi" : "single";
}

function summarise(
  text: string,
  keys: readonly string[],
  optional: readonly string[],
  as: SecretInputMode,
): Summary {
  const physical = text === "" ? [] : normaliseBreaks(text).split("\n");
  let result: ReturnType<typeof parseSecretEnv>;
  try {
    result = parseSecretEnv(text, { keys, optional_keys: optional }, as);
  } catch {
    // Only a malformed spec throws; the card cannot fix that, so it refuses.
    return {
      empty: text === "",
      ok: false,
      format: null,
      chips: [],
      errors: ["This request's key list is malformed; decline it and ask the agent again."],
      warnings: [],
      lines: physical.length,
      bytes: 0,
      mask: physical.map((l) => ({ prefix: "", dots: codePoints(l) })),
    };
  }
  // A key name is shown in the masked view only when the parser read that line
  // as an assignment of a key it reports, so a `NAME=` that is really part of a
  // multi-line value stays masked.
  const found = new Set(result.chips.filter((c) => c.state !== "missing").map((c) => c.key));
  const mask = physical.map((line): MaskLine => {
    if (result.format === "dotenv") {
      const m = KEY_PREFIX_RE.exec(line);
      if (m?.[1] !== undefined && m[2] !== undefined && found.has(m[2])) {
        return { prefix: m[1], dots: codePoints(line.slice(m[1].length)) };
      }
    }
    return { prefix: "", dots: codePoints(line) };
  });
  return {
    empty: text === "",
    ok: result.ok,
    format: result.format,
    chips: result.chips,
    errors: result.ok ? [] : result.errors.map((e) => e.message),
    warnings: result.warnings.map((w) => w.message),
    lines: physical.length,
    bytes: result.bytes,
    mask,
  };
}

/** "dotenv detected · 1 key", "raw value detected", "multi-line · .env · 3 keys". */
function formatLine(s: Summary, mode: Mode, as: SecretInputMode): string {
  if (s.empty) return "waiting for a paste";
  if (s.format === null) return "not read";
  const keyCount = s.chips.filter((c) => c.state !== "missing").length;
  const keys = plural(keyCount, "key", "keys");
  const how = as === "auto" ? "detected" : "(forced)";
  if (mode === "multi") {
    const fmt = s.format === "dotenv" ? ".env" : "raw";
    return `multi-line · ${fmt}${as === "auto" ? "" : " (forced)"} · ${keys} · ${plural(s.lines, "line", "lines")} · ${fmtBytes(s.bytes)}`;
  }
  return s.format === "dotenv" ? `dotenv ${how} · ${keys}` : `raw value ${how}`;
}

function chipText(c: SecretEnvChip): string {
  const opt = c.optional ? " (optional)" : "";
  if (c.state === "ok") return `✓ ${c.key}${opt} · ${plural(c.length ?? 0, "char", "chars")}`;
  if (c.state === "unrequested") return `✗ ${c.key} · not requested`;
  return `○ ${c.key}${opt} · missing`;
}

export function SecretTextInput(props: SecretTextInputProps): JSX.Element {
  const {
    keys,
    optional_keys,
    input,
    disabled = false,
    busy = false,
    boxError,
    onSubmit,
    onDecline,
  } = props;
  const id = useId();
  // Stable across renders whose key lists are equal, so a parent passing a fresh
  // array each render does not re-parse for nothing.
  const keysSig = keys.join(",");
  const optionalSig = (optional_keys ?? []).join(",");
  // Keyed on the lists' contents, not their identity.
  const spec = useMemo(
    () => ({ keys: [...keys], optional: [...(optional_keys ?? [])] }),
    [keysSig, optionalSig],
  );

  /** The secret. Never copied into state. */
  const valueRef = useRef("");
  /** The live field, and the last one mounted (so unmount can still empty it). */
  const fieldRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const dotsRef = useRef<HTMLDivElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  /** Caret to restore once the other mode's field mounts. */
  const caretRef = useRef<number | null>(null);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [mode, setMode] = useState<Mode>(() => startingMode(input, keys));
  const [as, setAs] = useState<SecretInputMode>("auto");
  const [summary, setSummary] = useState<Summary>(() =>
    summarise("", spec.keys, spec.optional, "auto"),
  );
  const [blockedLines, setBlockedLines] = useState<number | null>(null);
  const [armed, setArmed] = useState<"durable" | "ephemeral" | null>(null);
  const [revealed, setRevealed] = useState(false);

  const setField = useCallback((el: HTMLInputElement | HTMLTextAreaElement | null) => {
    if (el) fieldRef.current = el;
  }, []);

  const reparse = useCallback(
    (nextAs: SecretInputMode = as) =>
      setSummary(summarise(valueRef.current, spec.keys, spec.optional, nextAs)),
    [as, spec],
  );

  const syncScroll = useCallback(() => {
    const el = fieldRef.current;
    if (!el) return;
    if (dotsRef.current) {
      dotsRef.current.style.transform = `translate(${-el.scrollLeft}px, ${-el.scrollTop}px)`;
    }
    if (gutterRef.current) gutterRef.current.style.transform = `translateY(${-el.scrollTop}px)`;
  }, []);

  const hide = useCallback(() => {
    if (revealTimer.current !== null) clearTimeout(revealTimer.current);
    revealTimer.current = null;
    setRevealed(false);
  }, []);

  const armRevealTimer = useCallback(() => {
    if (revealTimer.current !== null) clearTimeout(revealTimer.current);
    revealTimer.current = setTimeout(hide, REVEAL_IDLE_MS);
  }, [hide]);

  const clear = useCallback(() => {
    valueRef.current = "";
    if (fieldRef.current) fieldRef.current.value = "";
    setSummary(summarise("", spec.keys, spec.optional, as));
    setArmed(null);
    setBlockedLines(null);
    hide();
  }, [as, spec, hide]);

  // The field is uncontrolled: when a mode switch mounts the other element, the
  // ref's text is written into it here, never through a prop.
  // Runs when the mode, and so the field element, changes.
  useLayoutEffect(() => {
    const el = fieldRef.current;
    if (!el) return;
    el.value = valueRef.current;
    const caret = caretRef.current;
    if (caret !== null) {
      caretRef.current = null;
      el.focus();
      el.setSelectionRange(caret, caret);
    }
    syncScroll();
  }, [mode]);

  useLayoutEffect(() => {
    syncScroll();
  });

  // Hide on ⌥ release anywhere and on window blur.
  useEffect(() => {
    if (!revealed) return;
    const up = (e: KeyboardEvent) => {
      if (e.key === "Alt") hide();
    };
    window.addEventListener("keyup", up);
    window.addEventListener("blur", hide);
    return () => {
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", hide);
    };
  }, [revealed, hide]);

  // Unmount: the secret leaves with the card.
  useEffect(
    () => () => {
      valueRef.current = "";
      if (fieldRef.current) fieldRef.current.value = "";
      if (revealTimer.current !== null) clearTimeout(revealTimer.current);
    },
    [],
  );

  const changed = () => {
    setArmed(null);
    setBlockedLines(null);
    reparse();
    if (revealed) armRevealTimer();
    syncScroll();
  };

  const onInput = (e: FormEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    valueRef.current = e.currentTarget.value;
    changed();
  };

  /** Splice `text` over the selection and carry on in multi-line mode. */
  const insertMultiline = (el: HTMLInputElement | HTMLTextAreaElement, text: string) => {
    const cur = valueRef.current;
    const start = el.selectionStart ?? cur.length;
    const end = el.selectionEnd ?? start;
    const ins = normaliseBreaks(text);
    valueRef.current = cur.slice(0, start) + ins + cur.slice(end);
    caretRef.current = start + ins.length;
    if (mode === "multi") {
      el.value = valueRef.current;
      el.focus();
      el.setSelectionRange(caretRef.current, caretRef.current);
      caretRef.current = null;
    } else {
      setMode("multi");
    }
    changed();
  };

  // A one-line field silently drops everything after the first line, which is
  // the worst failure for a key: a paste with a newline switches modes instead.
  const onPaste = (e: ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (mode !== "single") return;
    const text = e.clipboardData.getData("text/plain");
    if (!/[\r\n]/.test(text)) return;
    e.preventDefault();
    insertMultiline(e.currentTarget, text);
  };

  const onDrop = (e: DragEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (mode !== "single") return;
    const text = e.dataTransfer.getData("text/plain");
    if (!/[\r\n]/.test(text)) return;
    e.preventDefault();
    insertMultiline(e.currentTarget, text);
  };

  const switchTo = (next: Mode) => {
    if (next === mode) return;
    const text = valueRef.current;
    if (next === "single" && text.includes("\n")) {
      setBlockedLines(normaliseBreaks(text).split("\n").length);
      return;
    }
    setBlockedLines(null);
    caretRef.current = fieldRef.current?.selectionStart ?? text.length;
    setMode(next);
  };

  const chooseAs = (next: SecretInputMode) => {
    if (next === as) return;
    setAs(next);
    setArmed(null);
    reparse(next);
  };

  const inert = disabled || busy;

  const submit = (ephemeral: boolean) => {
    if (inert) return;
    // Re-read, rather than trust the last render's summary.
    const now = summarise(valueRef.current, spec.keys, spec.optional, as);
    if (now.empty || !now.ok) return;
    const which = ephemeral ? "ephemeral" : "durable";
    if (now.warnings.length > 0 && armed !== which) {
      setArmed(which);
      return;
    }
    const text = valueRef.current;
    onSubmit(text, as, ephemeral);
    clear();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === "Alt") {
      // A held key repeats; a repeat must not undo the idle timeout's hide.
      if (!e.repeat) {
        setRevealed(true);
        armRevealTimer();
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      clear();
      return;
    }
    // An IME's Enter commits a composition (Safari reports it as keyCode 229), never submits.
    if (e.key !== "Enter" || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (mode === "single") {
      e.preventDefault();
      submit(false);
    } else if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      submit(false);
    }
  };

  // The field holds the value under its mask: a copy, a cut or a drag of a
  // selection would carry it out unseen. Only a revealed value may leave.
  const guardOut = (e: { preventDefault: () => void }): void => {
    if (!revealed) e.preventDefault();
  };

  const canSubmit = !inert && !summary.empty && summary.ok;
  const rows = Math.min(MAX_ROWS, Math.max(MIN_ROWS, summary.lines));
  const gutterDigits = Math.max(2, String(Math.max(1, summary.lines)).length);
  const label = `Secret value for ${keys.join(", ") || (optional_keys ?? []).join(", ")}`;
  const statusId = `${id}-status`;

  const common = {
    id: `${id}-field`,
    ref: setField,
    className: "sti-real",
    "aria-label": label,
    "aria-describedby": statusId,
    "aria-invalid": !summary.empty && !summary.ok,
    autoComplete: "off",
    autoCorrect: "off",
    autoCapitalize: "off",
    spellCheck: false,
    "data-1p-ignore": "true",
    "data-lpignore": "true",
    "data-form-type": "other",
    disabled,
    readOnly: busy,
    onInput,
    onPaste,
    onDrop,
    onCopy: guardOut,
    onCut: guardOut,
    onDragStart: guardOut,
    onKeyDown,
    onScroll: syncScroll,
    onSelect: syncScroll,
    onKeyUp: syncScroll,
    onBlur: hide,
  } as const;

  return (
    // Esc here clears the field; ChatShell's window handler must not also stop the turn.
    <div className="sti" data-mode={mode} data-owns-escape="">
      <div className="sti-bar">
        <div className="sti-group" role="group" aria-labelledby={`${id}-mode`}>
          <span className="sti-kicker" id={`${id}-mode`}>
            Input
          </span>
          <div className="sti-seg">
            <button
              type="button"
              aria-pressed={mode === "single"}
              disabled={disabled}
              onClick={() => switchTo("single")}
            >
              Single line
            </button>
            <button
              type="button"
              aria-pressed={mode === "multi"}
              disabled={disabled}
              onClick={() => switchTo("multi")}
            >
              Multi-line
            </button>
          </div>
        </div>
        <div className="sti-group" role="group" aria-labelledby={`${id}-as`}>
          <span className="sti-kicker" id={`${id}-as`}>
            Treat as
          </span>
          <div className="sti-seg">
            {TREAT_AS.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-pressed={as === t.id}
                disabled={disabled}
                onClick={() => chooseAs(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div
        className={`sti-field ${mode}${revealed ? " revealed" : ""}${disabled ? " disabled" : ""}`}
        style={
          {
            "--sti-gd": mode === "multi" ? gutterDigits : 0,
            "--sti-rows": rows,
          } as CSSProperties
        }
      >
        <div className="sti-mask" aria-hidden="true">
          {mode === "multi" ? (
            <div className="sti-gutter">
              <div className="sti-gutter-inner" ref={gutterRef}>
                {(summary.mask.length > 0 ? summary.mask : [null]).map((_, i) => (
                  <div className="sti-line" key={i}>
                    {i + 1}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          <div className="sti-dots">
            <div className="sti-dots-inner" ref={dotsRef}>
              {summary.mask.length === 0 ? (
                <div className="sti-line sti-ph">
                  {mode === "multi"
                    ? "Paste KEY=value lines or a multi-line value"
                    : "Paste the secret"}
                </div>
              ) : (
                summary.mask.map((l, i) => (
                  <div className="sti-line" key={i}>
                    {l.prefix ? <span className="sti-key">{l.prefix}</span> : null}
                    {"•".repeat(l.dots)}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
        {mode === "multi" ? (
          <textarea {...common} wrap="off" rows={rows} />
        ) : (
          <input {...common} type="text" />
        )}
      </div>

      <div className="sti-status" id={statusId}>
        <div className="sti-summary">
          <span className="sti-format">{formatLine(summary, mode, as)}</span>
          {summary.chips.map((c) => (
            <span key={c.key} className={`sti-chip ${c.state}`}>
              {chipText(c)}
            </span>
          ))}
          <span className="sti-hint">
            {mode === "multi" ? "⌘⏎ submit" : "⏎ submit"} · esc clear · hold ⌥ to reveal
          </span>
        </div>
        {blockedLines !== null ? (
          <div className="sti-issue bad" role="alert">
            {`This value has ${plural(blockedLines, "line", "lines")}. Single line would drop all but the first.`}
          </div>
        ) : null}
        {!summary.empty
          ? summary.errors.map((m) => (
              <div className="sti-issue bad" key={`e:${m}`}>
                {m}
              </div>
            ))
          : null}
        {summary.ok
          ? summary.warnings.map((m) => (
              <div className="sti-issue warn" key={`w:${m}`}>
                {armed !== null ? `${m} Submit anyway?` : m}
              </div>
            ))
          : null}
        {summary.bytes > LARGE_BYTES ? (
          <div className="sti-issue warn">
            Over 4 KB — ask the agent to use request_file for large keys.
          </div>
        ) : null}
        {boxError ? (
          <div className="sti-issue bad" role="alert">
            {boxError}
          </div>
        ) : null}
      </div>

      <div className="sti-actions">
        <button
          className="btn btn-primary"
          type="button"
          disabled={!canSubmit}
          onClick={() => submit(false)}
        >
          {busy ? "Submitting…" : armed === "durable" ? "Submit anyway?" : "Submit secret"}
        </button>
        <button
          className="btn btn-secondary"
          type="button"
          disabled={!canSubmit}
          onClick={() => submit(true)}
        >
          {armed === "ephemeral" ? "Just this once anyway?" : "Just this once (tmpfs, 1 h)"}
        </button>
        <span className="spacer" />
        <button className="btn btn-secondary" type="button" disabled={inert} onClick={onDecline}>
          Decline
        </button>
      </div>
    </div>
  );
}
