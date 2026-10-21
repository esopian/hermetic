/**
 * The transcript's rows: every turn, event and burst `Thread` draws in its log.
 *
 * Split out of `Thread` so that rendering the thread — which happens on every
 * change to the chat store, every clock tick and every notification — does not
 * mean rendering the transcript. Both components here are memoized, and each
 * row compares the parts of its item that it draws, so a streaming delta
 * re-renders the live turn's row and no other; an appended message adds its
 * row and leaves the rest alone.
 *
 * The rows are drawn through `VirtualLog` (`../virtual/VirtualLog.tsx`), which
 * mounts only those near the viewport inside `Thread`'s `.ch-log` scroller and
 * owns its stick-to-bottom behaviour. Each item hands it a row element that is
 * kept by identity while the row's inputs are unchanged, so a re-render of the
 * log is not a re-render of its rows.
 */
import { memo, useMemo, useRef } from "react";
import type { ComponentProps, ReactElement, Ref, RefObject } from "react";
import type { TurnActivity } from "../chat-activity.ts";
import type { ChatMessageView } from "../../api/index.ts";
import type { ThreadItem } from "../process-events.ts";
import { rowKey } from "../chat-message-identity.ts";
import { renderProbe } from "../render-probe.ts";
import { DisclosureRowContext } from "../disclosures.ts";
import type { Pin } from "../stick-to-bottom.ts";
import { VirtualLog } from "../virtual/VirtualLog.tsx";
import type { VirtualItem, VirtualLogHandle } from "../virtual/VirtualLog.tsx";
import { InjectedMarker } from "./blocks/InjectedMarker.tsx";
import { ProcessBurst, ProcessEventRow } from "./blocks/ProcessEvent.tsx";
import { Message } from "./Message.tsx";
import { RowBoundary } from "./RowBoundary.tsx";

type Item = ThreadItem<ChatMessageView>;
type Status = ComponentProps<typeof Message>["status"];

/** What every row of one thread shares. */
interface ThreadIdentity {
  fleetId: string;
  instance: string;
  bot: string;
  botTitle?: string | null | undefined;
  status: Status;
}

/**
 * Whether a tool call in `message` is still waiting for its result — the only
 * case in which the box's busy state changes how a turn reads (`stepStatus`,
 * `ActivityGroup`). Every other turn is handed no `remoteBusy` at all, so the
 * tail moving on does not re-render the turn it moved off.
 */
function awaitsTool(message: ChatMessageView): boolean {
  return message.blocks.some((block) => block.kind === "tool" && block.status === "running");
}

/**
 * The key a thread item is drawn under: the row's *first* source id. The
 * merged row is named by its last one, which moves every time the turn takes
 * another row, and a key that moves remounts the article mid-turn. It is also
 * the scope of the row's entries in the thread's disclosure store
 * (`disclosures.ts`), which is what keeps the group the reader closed and the
 * step they opened across a remount — the virtualized log unmounts a row
 * scrolled far out of view — so it must not move either. A burst is keyed the
 * same way, on its first event.
 */
function itemKey(item: Item): string {
  return item.kind === "burst" ? item.key : rowKey(item.row);
}

/**
 * The key of the row drawing `messageId`, or null when no row here does. A
 * message may be any of the source rows folded into a turn, or one event of a
 * burst.
 */
export function rowKeyForMessage(items: readonly Item[], messageId: string): string | null {
  for (const item of items) {
    if (item.kind === "burst") {
      if (
        item.entries.some(
          (entry) => entry.row.ids.includes(messageId) || entry.row.message.id === messageId,
        )
      )
        return item.key;
    } else if (item.row.ids.includes(messageId) || item.row.message.id === messageId) {
      return itemKey(item);
    }
  }
  return null;
}

const NO_BLOCKS: readonly unknown[] = [];

/** A row's element and the props it was made from, kept while they hold. */
interface Kept {
  props: RowProps;
  node: ReactElement;
}

export const TranscriptLog = memo(function TranscriptLog({
  items,
  liveId,
  sending,
  activity,
  tailId,
  remoteBusy,
  fleetId,
  instance,
  bot,
  botTitle,
  status,
  scroller,
  pin,
  handle,
}: ThreadIdentity & {
  items: readonly Item[];
  /** The live message's id: this tab's own turn, still arriving. */
  liveId: string | null;
  sending: boolean;
  activity: TurnActivity;
  /** The newest bot turn's id, unless it is the live one (`Thread`). */
  tailId: string | null;
  remoteBusy: boolean | null;
  /** `Thread`'s `.ch-log`, the scroller the rows are drawn in. */
  scroller: RefObject<HTMLElement | null>;
  /** `Thread`'s follow state, shared with its open and send handlers. */
  pin: RefObject<Pin>;
  handle?: Ref<VirtualLogHandle>;
}) {
  const kept = useRef(new Map<string, Kept>());
  const rows = useMemo((): VirtualItem[] => {
    const next = new Map<string, Kept>();
    const out = items.map((item): VirtualItem => {
      const key = itemKey(item);
      const live = item.kind === "turn" && liveId !== null && item.row.message.id === liveId;
      const tail =
        item.kind === "turn" && item.row.message.id === tailId && awaitsTool(item.row.message);
      const props: RowProps = {
        item,
        fleetId,
        instance,
        bot,
        botTitle,
        status,
        streaming: sending && live,
        activity: live ? activity : "idle",
        remoteBusy: tail ? remoteBusy : undefined,
      };
      // The element itself is kept while nothing the row draws moved, so the
      // log handing it over again costs the row nothing at all.
      const old = kept.current.get(key);
      const entry =
        old && sameRowProps(old.props, props) ? old : { props, node: <TranscriptRow {...props} /> };
      next.set(key, entry);
      return { key, node: entry.node };
    });
    kept.current = next;
    return out;
  }, [items, liveId, sending, activity, tailId, remoteBusy, fleetId, instance, bot, botTitle, status]);
  return <VirtualLog items={rows} scroller={scroller} pin={pin} ref={handle} />;
});

interface RowProps extends ThreadIdentity {
  item: Item;
  streaming: boolean;
  activity: TurnActivity;
  remoteBusy: boolean | null | undefined;
}

/**
 * The parts of two items a row draws, compared by identity. `threadItems`
 * builds new item objects on every pass, but the rows inside them are kept
 * while unchanged (`reuseRows`), so this is what tells a row that nothing it
 * draws has moved.
 */
function sameItem(a: Item, b: Item): boolean {
  if (a === b) return true;
  if (a.kind === "turn")
    return b.kind === "turn" && a.row === b.row && a.inReply === b.inReply && a.re === b.re;
  if (a.kind === "event" || a.kind === "marker")
    return b.kind === a.kind && a.row === b.row && a.event === b.event;
  return (
    b.kind === "burst" &&
    a.key === b.key &&
    a.divider === b.divider &&
    a.entries.length === b.entries.length &&
    a.entries.every(
      (entry, i) => entry.row === b.entries[i]?.row && entry.event === b.entries[i]?.event,
    )
  );
}

function sameRowProps(a: RowProps, b: RowProps): boolean {
  return (
    a.fleetId === b.fleetId &&
    a.instance === b.instance &&
    a.bot === b.bot &&
    a.botTitle === b.botTitle &&
    a.status === b.status &&
    a.streaming === b.streaming &&
    a.activity === b.activity &&
    a.remoteBusy === b.remoteBusy &&
    sameItem(a.item, b.item)
  );
}

/**
 * One transcript row: its day divider, its blast door, and what it draws. No
 * wrapper element, because `VirtualLog`'s row wrapper is the row.
 */
const TranscriptRow = memo(function TranscriptRow({
  item,
  fleetId,
  instance,
  bot,
  botTitle,
  status,
  streaming,
  activity,
  remoteBusy,
}: RowProps) {
  const key = itemKey(item);
  renderProbe.hit?.("Row", key);
  const divider = item.kind === "burst" ? item.divider : item.row.divider;
  const ids = item.kind === "burst" ? item.entries.map((entry) => entry.row.message.id) : item.row.ids;
  // What the disclosure store scopes this row's choices by (`disclosures.ts`):
  // the row's key, and its blocks for the positions of groups with no id.
  const blocks = item.kind === "turn" ? item.row.message.blocks : NO_BLOCKS;
  const disclosureRow = useMemo(() => ({ key, blocks }), [key, blocks]);
  return (
    <DisclosureRowContext.Provider value={disclosureRow}>
      {divider ? (
        <div className="ch-divider">
          <hr />
          <span>{divider}</span>
          <hr />
        </div>
      ) : null}
      <RowBoundary
        resetKey={`${ids.join(",")}:${item.kind === "turn" ? (item.row.message.blocks?.length ?? 0) : item.kind}`}
        label={item.kind === "burst" ? item.key : item.row.message.id}
      >
        {item.kind === "burst" ? (
          <ProcessBurst entries={item.entries} />
        ) : item.kind === "event" ? (
          <ProcessEventRow entry={item} />
        ) : item.kind === "marker" ? (
          <InjectedMarker entry={item} />
        ) : (
          <Message
            row={item.row}
            fleetId={fleetId}
            instance={instance}
            bot={bot}
            botTitle={botTitle}
            status={status}
            streaming={streaming}
            activity={activity}
            inReply={item.inReply}
            re={item.re}
            remoteBusy={remoteBusy}
          />
        )}
      </RowBoundary>
    </DisclosureRowContext.Provider>
  );
}, sameRowProps);
