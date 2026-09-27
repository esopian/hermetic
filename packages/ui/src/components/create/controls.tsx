/**
 * The create drawer's small controls: size cells, the segmented volume picker,
 * the system-disk slider, and the "fleet default" / "changed · reset" tag every
 * Customize field carries.
 */
import { useId } from "react";
import type { ReactNode } from "react";
import type { SizeSpec } from "../../logic/format.ts";

export function SizeCells({
  sizes,
  size,
  onChoose,
  label = "Size",
}: {
  sizes: readonly SizeSpec[];
  /**
   * `null` presses nothing, which is what "this follows the fleet's default and
   * the portal could not read it" looks like. Pressing a cell that holds this
   * build's constant would be the form claiming the fleet said so.
   */
  size: SizeSpec["id"] | null;
  onChoose: (size: SizeSpec["id"]) => void;
  label?: string;
}) {
  return (
    <div className="sizes" role="group" aria-label={label}>
      {sizes.map((s) => (
        <button
          type="button"
          key={s.id}
          className="size-cell"
          aria-pressed={s.id === size}
          onClick={() => onChoose(s.id)}
        >
          <span className="g">{s.glyph}</span>
          <span className="it">{s.instance_type}</span>
          <span className="d">
            {s.gpu ? `${s.gpu.count} ${s.gpu.model} · ${s.gpu.memGib} GiB VRAM · ` : ""}
            {s.vcpu} vCPU · {s.memGib} GiB · {s.description}
          </span>
          <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span className="m">≈ ${Math.round(s.monthlyUsd)}/mo</span>
            <span className="h">~${s.hourlyUsd.toFixed(3)}/h · 730h</span>
          </span>
        </button>
      ))}
    </div>
  );
}

export function Seg<T extends string | number>({
  values,
  value,
  onChange,
  label,
  format,
  price,
}: {
  values: readonly T[];
  /** `null` presses nothing — see `SizeCells` above, for the same reason. */
  value: T | null;
  onChange: (v: T) => void;
  label: string;
  format?: (v: T) => string;
  /**
   * The cost of one choice, stacked under it rather than run on after it: one
   * line of `100 GiB · $8/mo` overflowed an eleven-character cell.
   */
  price?: (v: T) => string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {values.map((v) => (
        <button type="button" key={String(v)} onClick={() => onChange(v)} aria-pressed={v === value}>
          <span>{format ? format(v) : String(v)}</span>
          {price ? <span className="seg-price">{price(v)}</span> : null}
        </button>
      ))}
    </div>
  );
}

/**
 * A continuous size picker, for a value whose sensible answers are a range
 * rather than a short list — the root disk, whose floor is the AMI's own 8 GiB
 * and whose ceiling is a guard against typos.
 *
 * No scale under the track: evenly spaced labels under a linear track are a
 * scale that lies, and a readout that says the value exactly is worth more.
 */
export function Slider({
  label,
  value,
  min,
  max,
  onChange,
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
}) {
  return (
    <div className="slider">
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        aria-label={label}
        // Spelled for a screen reader, which would otherwise read the bare
        // number and say nothing about what unit it is in or what it costs.
        aria-valuetext={format(value)}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <output className="slider-out mono">{format(value)}</output>
    </div>
  );
}

/**
 * Where a field's value comes from, and the way back. For a field that
 * inherits, `reset` untouches it, so the request omits it again and the value
 * follows the fleet; for a machine field under a preset, `reset` puts the
 * preset's value back.
 */
export function FieldTag({
  changed,
  onReset,
  label,
  source = "fleet",
}: {
  changed: boolean;
  onReset: () => void;
  /** The field's name, for the reset button's accessible name. */
  label: string;
  /** What an unchanged field is reading from: the fleet's default, or the selected preset. */
  source?: "fleet" | "preset";
}) {
  if (!changed) {
    return source === "preset" ? (
      <span className="cr-fromtag">from preset</span>
    ) : (
      <span className="cr-deftag">fleet default</span>
    );
  }
  return (
    <span className="cr-chgtag">
      changed ·{" "}
      <button type="button" className="cr-reset" aria-label={`Reset ${label}`} onClick={onReset}>
        reset
      </button>
    </span>
  );
}

/**
 * One Customize row: a label and its tag on one line, the control below, and at
 * most one line of hint. The label is a `<label for>` rather than a wrapping
 * `<label>`, because the row also holds the reset button — and a wrapping label
 * activates its *first* labelable descendant, which would be that button.
 */
export function Field({
  label,
  changed,
  onReset,
  source,
  hint,
  control,
  children,
}: {
  label: string;
  changed: boolean;
  onReset: () => void;
  source?: "fleet" | "preset";
  hint?: ReactNode;
  /** A single form control labelled by this row, when there is one. */
  control?: (id: string) => ReactNode;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className={changed ? "cr-f cr-fchg" : "cr-f"}>
      <div className="cr-fh">
        {control ? (
          <label className="cr-fl" htmlFor={id}>
            {label}
          </label>
        ) : (
          <span className="cr-fl">{label}</span>
        )}
        <FieldTag changed={changed} onReset={onReset} label={label} source={source} />
      </div>
      {control ? control(id) : children}
      {hint ? <div className="cr-hint">{hint}</div> : null}
    </div>
  );
}

/** Die showing five pips — the "roll another name" affordance. */
export function DiceIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <rect
        x="3"
        y="3"
        width="18"
        height="18"
        rx="4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      {[
        [8, 8],
        [16, 8],
        [12, 12],
        [8, 16],
        [16, 16],
      ].map(([cx, cy]) => (
        <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.7" fill="currentColor" />
      ))}
    </svg>
  );
}
