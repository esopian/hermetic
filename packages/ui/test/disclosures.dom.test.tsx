/**
 * The disclosure store (`chat/disclosures.ts`): a tool group or step the
 * reader opened stays open when its row unmounts and mounts again, which is
 * what a virtualized transcript does to a row scrolled far out of view.
 */
import { act, cleanup, fireEvent, render } from "./dom.ts";
import { afterEach, expect, test } from "bun:test";
import type { ChatBlockView } from "../src/api/index.ts";
import { ActivityGroup } from "../src/chat/components/Activity.tsx";
import { DisclosureContext, DisclosureRowContext, createDisclosures } from "../src/chat/disclosures.ts";
import type { Disclosures } from "../src/chat/disclosures.ts";

afterEach(cleanup);

const tool = (n: number): ChatBlockView =>
  ({
    kind: "tool",
    name: "terminal",
    tool_id: `call-${n}`,
    status: "ok",
    args: { command: `printf step-${n}` },
    result: "[redacted]",
    render: "terminal",
    duration_ms: 1200,
  }) as unknown as ChatBlockView;

const BLOCKS = [tool(1), tool(2)];

/**
 * One row holding one activity group. `rowBlocks` is the row's message blocks
 * (`TranscriptRow` provides them); the group is drawn from `blocks`, which is
 * every row block from `from` on.
 */
function Row({
  store,
  row,
  shown,
  rowBlocks = BLOCKS,
  from = 0,
}: {
  store: Disclosures | null;
  row: string;
  shown: boolean;
  rowBlocks?: readonly ChatBlockView[];
  from?: number;
}) {
  return (
    <DisclosureContext.Provider value={store}>
      <DisclosureRowContext.Provider value={{ key: row, blocks: rowBlocks }}>
        {shown ? <ActivityGroup blocks={rowBlocks.slice(from)} streaming={false} /> : null}
      </DisclosureRowContext.Provider>
    </DisclosureContext.Provider>
  );
}

const reasoning = (text: string): ChatBlockView =>
  ({ kind: "reasoning", text, duration_ms: null, tokens: null }) as unknown as ChatBlockView;
const prose = (markdown: string): ChatBlockView => ({ kind: "text", markdown }) as ChatBlockView;

const group = () => document.querySelector<HTMLDetailsElement>("details.ch-activity");
const steps = () => [...document.querySelectorAll<HTMLDetailsElement>("details.ch-activity-step")];

/** Open a `<details>` the way a reader does, and let its `toggle` land. */
function open(details: HTMLDetailsElement): void {
  act(() => {
    fireEvent.click(details.querySelector("summary")!);
    // happy-dom may not dispatch `toggle` from a summary click; the browser does.
    details.dispatchEvent(new Event("toggle"));
  });
}

test("an opened group and step survive their row unmounting and mounting again", () => {
  const store = createDisclosures();
  const view = render(<Row store={store} row="stored:1" shown />);
  expect(group()?.open).toBe(false);
  open(group()!);
  open(steps()[1]!);
  expect(group()?.open).toBe(true);
  expect(steps().map((step) => step.open)).toEqual([false, true]);

  view.rerender(<Row store={store} row="stored:1" shown={false} />);
  expect(group()).toBeNull();
  view.rerender(<Row store={store} row="stored:1" shown />);
  expect(group()?.open).toBe(true);
  expect(steps().map((step) => step.open)).toEqual([false, true]);
});

test("a group that opened on bare reasoning keeps its choice when a tool call streams in", () => {
  const store = createDisclosures();
  const intro = prose("Let me look.");
  const think = reasoning("Checking the disk first.");
  const early = [intro, think];
  const view = render(<Row store={store} row="live:1" shown rowBlocks={early} from={1} />);
  expect(group()?.open).toBe(false);
  open(group()!);
  expect(group()?.open).toBe(true);

  // The turn streams on: a tool call joins the group, then the row is scrolled
  // out of the log and back.
  const later = [intro, think, tool(1)];
  view.rerender(<Row store={store} row="live:1" shown rowBlocks={later} from={1} />);
  view.rerender(<Row store={store} row="live:1" shown={false} rowBlocks={later} from={1} />);
  view.rerender(<Row store={store} row="live:1" shown rowBlocks={later} from={1} />);
  expect(group()?.open).toBe(true);
});

test("two bare-reasoning groups in one turn keep separate choices", () => {
  const store = createDisclosures();
  const blocks = [reasoning("one"), tool(1), prose("Between."), reasoning("two"), tool(2)];
  function Turn({ shown }: { shown: boolean }) {
    return (
      <DisclosureContext.Provider value={store}>
        <DisclosureRowContext.Provider value={{ key: "stored:1", blocks }}>
          {shown ? (
            <>
              <ActivityGroup blocks={blocks.slice(0, 2)} streaming={false} />
              <ActivityGroup blocks={blocks.slice(3)} streaming={false} />
            </>
          ) : null}
        </DisclosureRowContext.Provider>
      </DisclosureContext.Provider>
    );
  }
  const groups = () => [...document.querySelectorAll<HTMLDetailsElement>("details.ch-activity")];
  const view = render(<Turn shown />);
  open(groups()[1]!);
  view.rerender(<Turn shown={false} />);
  view.rerender(<Turn shown />);
  expect(groups().map((g) => g.open)).toEqual([false, true]);
});

test("a choice is scoped to its row and its conversation's store", () => {
  const store = createDisclosures();
  const view = render(<Row store={store} row="stored:1" shown />);
  open(group()!);
  view.unmount();

  // Another row with the same tool ids starts shut.
  const other = render(<Row store={store} row="stored:7" shown />);
  expect(group()?.open).toBe(false);
  other.unmount();

  // So does the same row under a new conversation's store.
  render(<Row store={createDisclosures()} row="stored:1" shown />);
  expect(group()?.open).toBe(false);
});

test("without a store, a group keeps its choice only while mounted", () => {
  const view = render(<Row store={null} row="stored:1" shown />);
  open(group()!);
  expect(group()?.open).toBe(true);
  view.rerender(<Row store={null} row="stored:1" shown={false} />);
  view.rerender(<Row store={null} row="stored:1" shown />);
  expect(group()?.open).toBe(false);
});

test("the store forgets its oldest choices past its limit", () => {
  const store = createDisclosures(2);
  store.set("a", true);
  store.set("b", true);
  store.set("a", false);
  store.set("c", true);
  expect(store.get("b")).toBeUndefined();
  expect(store.get("a")).toBe(false);
  expect(store.get("c")).toBe(true);
});
