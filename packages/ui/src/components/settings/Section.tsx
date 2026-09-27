/**
 * The parts every Settings page is built from, and nothing else (`docs/ui-brief.md`
 * § Settings, the S-1 template):
 *
 * - `SettingsPage` — the header: group kicker, scope badge, title, one line of
 *   description, and the page's single primary action top right.
 * - `Block` — a kicker title over a 2px rule, with an optional summary or add
 *   button on the right of that rule. Every body block opens with one.
 * - A · `SettingRow` — label and one-line description left, control right, a
 *   narrow state column far right (`fleet default`, `changed`, `✓ saved`).
 * - B · a list: a `st-list` table whose rows open with a `Sq`, and end in at
 *   most two `TextAction`s with the rest under an `Overflow` menu. A refused
 *   action stays visible, dimmed, with its reason as the tooltip and in the menu.
 * - C · status: up to four `Facts`, a `.kv` list, then at most one `Callout`.
 *
 * Shared here rather than in `SettingsShell.tsx` so a section file can be read
 * on its own — the shell decides *which* section is drawn, not what one looks
 * like.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { settingsSectionInfo } from "../../nav/settings-nav.ts";
import type { SettingsSection } from "../../nav/settings-nav.ts";

/**
 * The fleet a fleet-wide page saves to, as the scope badge names it: its
 * `fleet_id`, because that is what a write is keyed on (an alias can move).
 * Provided by the shell; `null` outside one, where the badge just says
 * "Fleet-wide".
 */
export const SettingsFleetContext = createContext<string | null>(null);

/**
 * How a page saves, which is what its scope badge says. Every page has exactly
 * one: `fleet` pages write `_fleet` (or another fleet-wide record) and go
 * through the save bar or a confirmed command; `laptop` pages save as they are
 * touched; `readonly` pages report and change nothing.
 */
export type SettingsScope = "fleet" | "laptop" | "readonly";

export function ScopeBadge({ scope }: { scope: SettingsScope }) {
  const fleet = useContext(SettingsFleetContext);
  if (scope === "laptop") return <span className="st-scope st-laptop">This laptop only</span>;
  if (scope === "readonly") return <span className="st-scope st-ro">Read-only</span>;
  return (
    <span className="st-scope st-fleet">
      Fleet-wide
      {fleet === null ? null : (
        <>
          {" "}
          · saved to <b className="mono">{fleet}</b>
        </>
      )}
    </span>
  );
}

export function SettingsPage({
  section,
  scope,
  desc,
  primary,
  title,
  children,
}: {
  section: SettingsSection;
  scope: SettingsScope;
  /** One sentence. A page that needs a paragraph needs a block instead. */
  desc: ReactNode;
  /**
   * The page's one primary action. Nothing else goes top right, and a page
   * without one leaves the slot empty rather than promoting a secondary verb.
   */
  primary?: ReactNode;
  /** Defaults to the rail label, so the rail and the page never disagree. */
  title?: string;
  children: ReactNode;
}) {
  const info = settingsSectionInfo(section);
  return (
    <div className="st-page">
      <header className="st-hd">
        <div className="st-hd-main">
          <div className="st-hd-k">
            <span className="kicker">{info.groupLabel}</span>
            <ScopeBadge scope={scope} />
          </div>
          <h2 className="st-title">{title ?? info.label}</h2>
          <p className="st-desc">{desc}</p>
        </div>
        <div className="st-hd-a">{primary}</div>
      </header>
      {children}
    </div>
  );
}

export function Block({
  title,
  right,
  children,
  className,
}: {
  title: ReactNode;
  /** A summary, or the block's add button — never the page's primary action. */
  right?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section className={className ? `st-blk ${className}` : "st-blk"}>
      <div className="st-bh">
        <h3 className="kicker st-bh-t">{title}</h3>
        {right === undefined || right === null ? null : <div className="st-bh-r">{right}</div>}
      </div>
      {children}
    </section>
  );
}

/* ── A · setting rows ────────────────────────────────────────────────────── */

export function SettingRow({
  label,
  desc,
  htmlFor,
  state,
  changed = false,
  children,
  field,
}: {
  label: string;
  /** One line; it is cut with an ellipsis rather than wrapped. */
  desc?: ReactNode;
  /** The control's id, so the label is its accessible name. */
  htmlFor?: string;
  /** The far-right column: a `RowNote`, a `RowChanged` or a `SavedTick`. */
  state?: ReactNode;
  /** A staged edit: the row gets the 3px accent edge. */
  changed?: boolean;
  children: ReactNode;
  /** `data-field`, so a test can find a row without counting them. */
  field?: string;
}) {
  return (
    <div className={changed ? "st-sr chg" : "st-sr"} data-field={field}>
      <div className="st-sl">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="st-sl-l">
            {label}
          </label>
        ) : (
          <span className="st-sl-l">{label}</span>
        )}
        {desc === undefined || desc === null ? null : <span className="st-sl-d">{desc}</span>}
      </div>
      <div className="st-sc">{children}</div>
      <div className="st-si">{state}</div>
    </div>
  );
}

/** The quiet state word — `fleet default`, `unstated`, `saves at once`. */
export function RowNote({ children }: { children: ReactNode }) {
  return <span className="st-def">{children}</span>;
}

/** A staged edit, and what it was before. */
export function RowChanged({ was }: { was: string }) {
  return (
    <span className="st-chg">
      changed<small>was {was}</small>
    </span>
  );
}

/**
 * A laptop-only (or instant) control saved. The live region is always in the
 * DOM — one that appears together with its text is not reliably announced — and
 * only its text comes and goes.
 */
export function SavedTick({ on }: { on: boolean }) {
  return (
    <span className="st-tick" aria-live="polite">
      {on ? "✓ saved" : ""}
    </span>
  );
}

/** How long `✓ saved` stays up: long enough to see, short enough not to be news. */
const TICK_MS = 2000;

/** `[shown, flash]` for a `SavedTick`: call `flash()` after the write lands. */
export function useSavedTick(): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const flash = useCallback(() => {
    setOn(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOn(false), TICK_MS);
  }, []);
  return [on, flash];
}

/* ── B · lists ───────────────────────────────────────────────────────────── */

export type SqTone = "ok" | "warn" | "bad" | "acc" | "off" | "none";

/** The status square a list row, a rail item or a summary opens with. */
export function Sq({ tone, title }: { tone: SqTone; title?: string }) {
  if (tone === "none") return <span className="st-nosq" aria-hidden="true" />;
  return <span className={`sq ${tone}`} title={title} aria-hidden="true" />;
}

/** One `■ n label` count in a block header's summary. */
export function Tally({ tone, children }: { tone: SqTone; children: ReactNode }) {
  return (
    <span className="st-tally">
      <Sq tone={tone} />
      {children}
    </span>
  );
}

/** Whether an action is allowed, and — when it is not — the sentence saying why. */
export interface Allowed {
  ok: boolean;
  reason?: string;
}

/**
 * A row's text action. Refused is still drawn — dimmed, with the reason as its
 * tooltip — because an action that vanishes when it is not allowed leaves the
 * operator asking where it went.
 */
export function TextAction({
  children,
  onClick,
  allowed,
  busy = false,
  tone,
  label,
}: {
  children: ReactNode;
  onClick: () => void;
  allowed?: Allowed;
  busy?: boolean;
  tone?: "primary" | "danger";
  /** An accessible name, when the visible verb alone is ambiguous in a table. */
  label?: string;
}) {
  const ok = allowed?.ok ?? true;
  const cls = tone === "primary" ? "st-tb st-tb-p" : tone === "danger" ? "st-tb d" : "st-tb";
  return (
    <button
      type="button"
      className={cls}
      disabled={busy || !ok}
      title={ok ? undefined : allowed?.reason}
      aria-label={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export interface MenuItem {
  label: string;
  onSelect: () => void;
  allowed?: Allowed;
  danger?: boolean;
}

/**
 * A row's `…`: every action past the first two. A refused item is listed with
 * its reason under it, so the menu is where "why can't I" is answered without
 * hovering.
 *
 * Escape closes the menu and is marked handled (`preventDefault`), so the shell's
 * own Escape — back to the fleet — does not fire behind it.
 */
export function Overflow({
  label,
  items,
  disabled = false,
}: {
  /** The button's accessible name, e.g. "More actions for anthropic-main". */
  label: string;
  items: readonly MenuItem[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== "Escape" || !open) return;
    e.preventDefault();
    e.stopPropagation();
    setOpen(false);
  };

  return (
    <div className="st-more-wrap" ref={ref}>
      <button
        type="button"
        className={open ? "st-more on" : "st-more"}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
      >
        …
      </button>
      {open ? (
        <div className="st-menu" role="menu" aria-label={label} onKeyDown={onKeyDown}>
          {items.map((item) => {
            const ok = item.allowed?.ok ?? true;
            return (
              <button
                type="button"
                role="menuitem"
                key={item.label}
                className={item.danger ? "st-mi d" : "st-mi"}
                disabled={!ok}
                title={ok ? undefined : item.allowed?.reason}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {item.label}
                {!ok && item.allowed?.reason ? <small>refused · {item.allowed.reason}</small> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/* ── C · status ──────────────────────────────────────────────────────────── */

export interface Fact {
  k: string;
  v: ReactNode;
  tone?: "warn" | "bad" | "ok";
}

/** Up to four big facts across the top of a status block. */
export function Facts({ items }: { items: readonly Fact[] }) {
  return (
    <div className="st-facts">
      {items.slice(0, 4).map((f) => (
        <div key={f.k}>
          <span className="kicker">{f.k}</span>
          <b className={f.tone ? `mono st-fact-${f.tone}` : "mono"}>{f.v}</b>
        </div>
      ))}
    </div>
  );
}

/**
 * The one callout a status block may carry. It points at the page's primary
 * action rather than holding a button of its own.
 */
export function Callout({
  tone = "warn",
  children,
}: {
  tone?: "warn" | "bad" | "ok" | "info";
  children: ReactNode;
}) {
  return <div className={`st-callout ${tone}`}>{children}</div>;
}

export function Row({ k, v, mono, size }: { k: string; v: string; mono?: boolean; size?: number }) {
  return (
    <>
      <span className="k">{k}</span>
      <span className={mono ? "v mono" : "v"} style={size ? { fontSize: size } : undefined}>
        {v}
      </span>
    </>
  );
}

/** The quiet mono line under a page — where it saves, what version it read. */
export function PageFoot({ children }: { children: ReactNode }) {
  return <p className="st-foot mono">{children}</p>;
}
