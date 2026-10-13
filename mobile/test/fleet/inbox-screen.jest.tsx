/**
 * The Inbox screen over a live `InboxStore`: an entry filed while the list is
 * on screen shows at once, with no scroll to wake the list.
 */
import { act, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import Inbox from "../../app/(tabs)/inbox.tsx";
import { type FleetContextValue, FleetContext } from "../../src/fleet/FleetProvider.tsx";
import { memoryFile } from "../../src/fleet/store.ts";
import { InboxStore } from "../../src/inbox/store.ts";
import { renderUi } from "../helpers/render.tsx";

// FlashList measures native layout; in jest every measurement is a fixed size.
jest.mock("@shopify/flash-list/dist/recyclerview/utils/measureLayout", () => {
  const actual = jest.requireActual("@shopify/flash-list/dist/recyclerview/utils/measureLayout");
  const box = (width: number, height: number) => () => ({ x: 0, y: 0, width, height });
  return {
    ...actual,
    measureParentSize: jest.fn(box(400, 900)),
    measureFirstChildLayout: jest.fn(box(400, 900)),
    measureItemLayout: jest.fn(box(400, 100)),
  };
});
jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));

const AT = "2026-10-13T10:00:00.000Z";

function arrival(n: number) {
  return {
    kind: "turn.done" as const,
    instance: "atlas",
    bot: `bot${n}`,
    session: `s-${n}`,
    title: `bot${n} · atlas`,
    body: `reply number ${n}`,
    at: new Date(Date.parse(AT) + n * 60_000).toISOString(),
    dedupe: `atlas:s-${n}:1:turn.done`,
  };
}

function Harness({ inbox, children }: { inbox: InboxStore; children: ReactNode }) {
  const roster = { subscribe: () => () => {}, getState: () => null, layout: () => null };
  const value = { client: { inbox, roster } } as unknown as FleetContextValue;
  return <FleetContext.Provider value={value}>{children}</FleetContext.Provider>;
}

test("a new entry appears at the top while the list is on screen", async () => {
  const inbox = new InboxStore(memoryFile(), () => AT);
  inbox.ingest(arrival(1));
  await renderUi(
    <Harness inbox={inbox}>
      <Inbox />
    </Harness>,
  );
  expect(screen.getByText("reply number 1")).toBeTruthy();
  await act(async () => {
    inbox.ingest(arrival(2));
  });
  expect(screen.getByText("reply number 2")).toBeTruthy();
  expect(screen.getByText("reply number 1")).toBeTruthy();
  // The scroll view does not hold the old first row in place (that is what hid
  // a new top entry until the next scroll on a device).
  const held = screen.container.queryAll((node) => node.props.maintainVisibleContentPosition != null);
  expect(held).toEqual([]);
});
