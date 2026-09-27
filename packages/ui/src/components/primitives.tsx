/** The small shared pieces: kickers, status squares, health squares, bars. */
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type { AgentView } from "../api/index.ts";
import { healthColors, healthTitle, statusColor, width } from "../logic/format.ts";

/**
 * An identifier that is shown short and copied whole: a `vol-…` on a card has
 * room for about half of a real 21-character EBS id, so the elided form is a
 * label and the clipboard is where the actual value lives.
 *
 * A `<button>`, not a `<span title>`, because copying it is an action —
 * keyboard-reachable, and it stops the click from reaching the card behind it,
 * which would open a drawer nobody asked for.
 */
export function CopyId({
  id,
  label,
  className,
  style,
  note,
}: {
  /** The whole value, which is what lands on the clipboard. */
  id: string;
  /** What is drawn; defaults to the id itself. */
  label?: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** Extra context for the tooltip, e.g. the size line the card elided. */
  note?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = async (e: ReactMouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (timer.current) clearTimeout(timer.current);
    setCopied(false);
    setFailed(false);
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(id);
      setCopied(true);
      timer.current = setTimeout(() => setCopied(false), 1400);
    } catch {
      setFailed(true);
    }
  };
  return (
    <>
      <button
        type="button"
        className={className ? `copy-id ${className}` : "copy-id"}
        style={style}
        title={`${id}${note ? ` · ${note}` : ""} — click to copy`}
        aria-label={`Copy ${id}`}
        onClick={copy}
      >
        {copied ? "copied" : (label ?? id)}
      </button>
      <span role="status" className={failed ? "copy-status mono" : "sr-only"}>
        {copied ? `Copied ${id}` : failed ? "Clipboard unavailable. Select and copy the full ID:" : ""}
      </span>
      {failed ? (
        <input
          className="key-input copy-fallback mono"
          aria-label={`Full ID ${id}`}
          readOnly
          value={id}
          onFocus={(e) => e.currentTarget.select()}
          onClick={(e) => {
            e.stopPropagation();
            e.currentTarget.select();
          }}
        />
      ) : null}
    </>
  );
}

export function Kicker({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div className="kicker" style={style}>
      {children}
    </div>
  );
}

export function StatusDot({ status, size = 8 }: { status: string; size?: number }) {
  const color = statusColor(status);
  return <i className="dot" style={{ background: color, width: size, height: size }} />;
}

/**
 * `sub` is the small muted trailer the chip carries when there is a more
 * specific thing to say than the status word: the bootstrap stage an agent is
 * standing on while it is `bootstrapping`, or — for the two statuses that are
 * a silence rather than a state — how long that silence has lasted
 * (`lastSeenLabel`). The stage wins when both apply, being the more specific.
 * It is one line: the status track is sized for it, so it never wraps.
 */
export function StatusLabel({
  status,
  className,
  sub,
}: {
  status: string;
  className?: string;
  sub?: string | null;
}) {
  return (
    <span className={className ?? "cell-status"} style={{ color: statusColor(status) }}>
      <StatusDot status={status} />
      {status}
      {sub ? <span className="status-sub">{sub}</span> : null}
    </span>
  );
}

/**
 * The three health squares, with the text alternative that keeps them from
 * being colour-only. `className` exists so the board can keep its own
 * (`.card-foot .squares` sizes them differently) and still get the title — the
 * board used to inline its own copy of this and lose it.
 *
 * `size`/`height` are ignored when a `className` sizes the squares in CSS.
 */
export function HealthSquares({
  agent,
  size = 14,
  height,
  className = "cell-health",
  styled = true,
}: {
  agent: AgentView;
  size?: number;
  height?: number;
  className?: string;
  /** False when the class already sizes the squares; avoids fighting the CSS. */
  styled?: boolean;
}) {
  const colors = healthColors(agent);
  return (
    <span className={className} title={`health · ${healthTitle(agent)}`}>
      {colors.map((c, i) => (
        <i
          key={i}
          style={
            styled
              ? { background: c, width: size, height: height ?? size, display: "inline-block" }
              : { background: c }
          }
        />
      ))}
    </span>
  );
}

export function Bar({
  value,
  color,
  height = 4,
  style,
}: {
  value: number | null | undefined;
  color: string;
  height?: number;
  style?: CSSProperties;
}) {
  return (
    <span className="bar" style={{ height, ...style }}>
      <i style={{ width: width(value), background: color }} />
    </span>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  onChange,
  options,
  format,
  disabledOption,
  hint,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: readonly T[];
  format?: (v: T) => string;
  /**
   * Listed but unpickable. A disabled provider is still *a provider this fleet
   * knows about*, so hiding it would make "why is nous missing" a question with
   * no answer on screen; showing it greyed is the answer.
   */
  disabledOption?: (v: T) => boolean;
  hint?: string;
}) {
  return (
    <label className="select-field">
      <div className="kicker" style={{ marginBottom: 8 }}>
        {label}
      </div>
      <div className="select-wrap">
        <select className="select-input" value={value} onChange={(e) => onChange(e.target.value as T)}>
          {options.map((v) => (
            <option key={v} value={v} disabled={disabledOption ? disabledOption(v) : undefined}>
              {format ? format(v) : String(v)}
            </option>
          ))}
        </select>
      </div>
      {hint ? (
        <div className="name-hint" style={{ color: "var(--fg3)" }}>
          {hint}
        </div>
      ) : null}
    </label>
  );
}
