/**
 * One message row's blast door.
 *
 * §9.2 is a promise about *shapes*: "an unrecognised shape renders; it never
 * disappears". The block switch keeps that promise for a kind it has never
 * heard of — `blockKind` answers `unknown` and the payload is drawn. What it
 * cannot keep it for is a kind it *has* heard of, arriving without a field the
 * schema says is there: a persisted row from an older build, a gateway a
 * version ahead. That is a `TypeError` in a leaf, and React's answer to an
 * uncaught render error is to unmount the whole tree — one malformed block and
 * the operator's entire transcript goes white.
 *
 * So each row renders behind this. The failure is contained to the message it
 * happened in, every other turn stays on screen, and the row that broke says
 * so in a card rather than leaving a hole. The individual guards elsewhere in
 * this directory are the fix; this is the floor under the ones nobody thought
 * of, which is the only kind that matters.
 *
 * `resetKey` is what lets a row recover. A turn still arriving re-renders under
 * the same React key with more blocks each time, so a boundary that latched on
 * the first bad frame would stay latched after the frame that completed it.
 */
import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

interface RowBoundaryProps {
  children: ReactNode;
  /** Changes when the row's content does; clears a latched failure. */
  resetKey?: string | number;
  /** What the fallback calls this row, for a log line an operator can place. */
  label?: string;
}

interface RowBoundaryState {
  failed: boolean;
  seen: string | number | undefined;
}

export class RowBoundary extends Component<RowBoundaryProps, RowBoundaryState> {
  override state: RowBoundaryState = { failed: false, seen: undefined };

  static getDerivedStateFromError(): Partial<RowBoundaryState> {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: RowBoundaryProps,
    state: RowBoundaryState,
  ): Partial<RowBoundaryState> | null {
    if (state.seen === props.resetKey) return null;
    return { failed: false, seen: props.resetKey };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The portal's own log is server-side (`packages/app/src/log.ts`); a
    // render failure only exists in the tab it happened in, so it is written
    // where the browser console will keep it.
    console.error(
      `chat row failed to render${this.props.label ? ` (${this.props.label})` : ""}`,
      error,
      info.componentStack,
    );
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="ch-card muted" role="note" data-row-failed>
        <div className="ch-card-body">This message could not be rendered.</div>
      </div>
    );
  }
}
