/**
 * The Config section's building blocks: a group (a kicker over a 2px rule, its
 * section-level actions at the right of that rule — the settings page's Block,
 * docs/ui-brief.md) and its rows (one label column shared by every group, the
 * value in mono, secondary facts dimmed on the same line, row actions compact
 * at the right). `AgentProfilePanel` draws its group from the same parts, so
 * the profile, Hermes, Tailscale, Instance and Desktop gateway blocks line up.
 */
import { useId } from "react";
import type { ReactNode } from "react";

export function CfgGroup({
  title,
  actions,
  children,
}: {
  title: string;
  /** Section-level actions, right of the rule ("Change profile or model", "Connect Desktop"). */
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const headingId = useId();
  return (
    <section className="cfg-grp" aria-labelledby={headingId}>
      <div className="cfg-h">
        <h3 className="kicker" id={headingId}>
          {title}
        </h3>
        {actions ? <div className="cfg-h-r">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** A group's rows. Keeps the `kv` class so the `.k`/`.v` spelling stays the drawer's one kv vocabulary. */
export function CfgRows({ children }: { children: ReactNode }) {
  return <div className="kv cfg-kv">{children}</div>;
}

export function CfgRow({
  k,
  children,
  sub,
  actions,
  className,
}: {
  k: string;
  children: ReactNode;
  /** A secondary fact too long for the value's own line (an ARN, a note), dimmed under it. */
  sub?: ReactNode;
  /** Row actions (Copy, Reveal): compact, right-aligned. */
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <>
      <span className="k">{k}</span>
      <span className={`v${className ? ` ${className}` : ""}`}>
        <span className="cfg-v">
          {children}
          {sub ? <span className="cfg-sub">{sub}</span> : null}
        </span>
        {actions ? <span className="cfg-acts">{actions}</span> : null}
      </span>
    </>
  );
}

/** A secondary fact on the value's own line, in `--fg3`. */
export function Dim({ children }: { children: ReactNode }) {
  return <span className="cfg-dim">{children}</span>;
}

/**
 * An ARN or path with break opportunities after each `/` and `:`, so a long
 * principal wraps between its parts rather than mid-token.
 */
export function Breakable({ text }: { text: string }) {
  const parts: { at: number; text: string }[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "/" || text[i] === ":") {
      parts.push({ at: start, text: text.slice(start, i + 1) });
      start = i + 1;
    }
  }
  if (start < text.length) parts.push({ at: start, text: text.slice(start) });
  return (
    <>
      {parts.map((p) => (
        <span key={p.at}>
          {p.text}
          <wbr />
        </span>
      ))}
    </>
  );
}
