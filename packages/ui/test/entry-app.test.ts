/**
 * The entry's ordering.
 *
 * The bug this exists to prevent is silent and total: there is one transport
 * and no default behind it, so a render that happened before
 * `installRpcTransport` resolved would reach `transport()` and throw — in the
 * one build that has nothing to fall back to.
 *
 * So what is asserted is the *order*: the transport is in force by the time
 * React is asked to mount, and `page.ready` goes out after that, once the page
 * exists to be pushed at (`app/src/rpc/schema.ts`, `BunMessages`).
 *
 * The portal is mounted for real, which is the point: a module mock of React's
 * renderer would outlive this file (bun runs every test file in one process)
 * and hand every later DOM test a renderer that draws nothing. `electrobun/view`
 * is the one module mocked here, and it has no other importer.
 */
// First, before anything React: the entry mounts into `#root`, so this file
// needs a document even though it never renders one (`setup.ts`).
import "./setup.ts";
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import type { Root } from "react-dom/client";
import type { RpcHandle } from "../src/api/transport-rpc.ts";
import { electrobunRequest } from "./electrobun-request.ts";
import { installedTransport, setTransport, transport } from "../src/api/transport.ts";

/** What happened, in the order it happened. */
const log: string[] = [];
/** Every `bun.messages` name the page put on the bridge. */
const sent: string[] = [];

/** Every request the mounted page made through the bridge. */
const asked: string[] = [];

/**
 * Just enough of a fleet to render against.
 *
 * Not a fixture of anything: the assertions below are about the boot, not about
 * what the portal drew, and the only reason these have shapes at all is that a
 * provider handed `{}` where it expected a list throws while rendering and
 * takes the mount down with it.
 */
const ANSWERS: Record<string, unknown> = {
  "meta.get": {
    header: "▸ main",
    config: null,
    fixture: true,
    hermes_version: null,
    hermeticd_version: null,
    tailnet: null,
    initialized: false,
    last_teardown: null,
  },
  "agents.list": [],
  "chat.listening": { instances: [] },
  "chat.swarms": { swarms: [] },
  "notifications.list": { notifications: [], unread: 0, needs_action: 0, mutes: [] },
  "init.profiles": { profiles: [] },
};

const request = electrobunRequest((name) => {
  asked.push(name);
  return Promise.resolve(ANSWERS[name] ?? {});
});

const handle: RpcHandle = {
  request,
  send: (name) => {
    sent.push(String(name));
    log.push(`send:${String(name)}`);
  },
};

class FakeElectroview {
  constructor(readonly options: { rpc?: RpcHandle }) {}
  static defineRPC(): RpcHandle {
    log.push("defineRPC");
    return handle;
  }
}

mock.module("electrobun/view", () => ({ Electroview: FakeElectroview }));

/**
 * The listeners the mount leaves behind, taken back off.
 *
 * This file mounts the real portal into a real root and has no way to unmount
 * it: `entry-app.tsx` keeps the `createRoot` handle to itself, and mocking
 * `react-dom/client` to get at it would outlive this file and hand every later
 * DOM test a renderer that draws nothing — the same trap the header warns
 * about for React's renderer. Emptying `document.body` afterwards takes the
 * *nodes* away and leaves the tree mounted: its effects are still subscribed,
 * and the shell's are subscribed to `document`, not to anything inside `#root`
 * (`nav/nav-state.tsx`, `useNavKeys`).
 *
 * One of them is the shortcut handler, which `preventDefault()`s `?` — so an
 * orphaned portal answers the key first and every later file's own portal sees
 * `defaultPrevented` and stands down. That is how `shortcuts.dom.test.tsx`
 * came to fail six of its cases on Linux and none on macOS: `bun test` runs a
 * run in one process, and whether this file is evaluated before that one is
 * filesystem readdir order.
 *
 * So every `document`/`window` listener added while the entry boots is
 * recorded and removed in `afterAll`. Recorded rather than named, because the
 * set is whatever the shell happens to subscribe to and a list written out
 * here would rot the first time it changed.
 */
type Added = [
  EventTarget,
  string,
  EventListenerOrEventListenerObject,
  AddEventListenerOptions | boolean | undefined,
];
const added: Added[] = [];
const nativeAdd = new Map<EventTarget, EventTarget["addEventListener"]>();

function recordListeners(target: EventTarget): void {
  const native = target.addEventListener.bind(target);
  nativeAdd.set(target, target.addEventListener);
  target.addEventListener = (
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ): void => {
    if (listener) added.push([target, type, listener, options]);
    native(type, listener, options);
  };
}

function removeRecordedListeners(): void {
  for (const [target, native] of nativeAdd) target.addEventListener = native;
  nativeAdd.clear();
  for (const [target, type, listener, options] of added) {
    target.removeEventListener(type, listener, options);
  }
  added.length = 0;
}

/**
 * What the suite had installed, put back afterwards.
 *
 * Bun runs every test file in one process and `transport()` throws when nothing
 * is installed, so leaving null behind would hand the next file's stray unmount
 * read a message about a portal that forgot to boot (`test/setup.ts`).
 */
let previous: ReturnType<typeof installedTransport> = null;

/**
 * The act environment, off for this file only. `setup.ts` turns it on because
 * Testing Library wraps every render in `act()`; this file renders through the
 * real entry instead, which no `act()` can wrap, so with the flag on every
 * state update the mounted portal made logged React's "not wrapped in act"
 * warning.
 */
const actGlobal = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let previousAct: boolean | undefined;

/** The entry's root, so `afterAll` can unmount it (`booted` in `entry-app.tsx`). */
let root: Root | null = null;

beforeAll(() => {
  previousAct = actGlobal.IS_REACT_ACT_ENVIRONMENT;
  actGlobal.IS_REACT_ACT_ENVIRONMENT = false;
  // Before the import below, so the boot's own subscriptions are the ones
  // recorded.
  recordListeners(document);
  recordListeners(window);
  // The entry looks for its mount point before it renders.
  document.body.innerHTML = '<div id="root"></div>';
  previous = installedTransport();
  // Nothing installed, so "installed" and "not installed" are two different
  // outcomes below rather than two shades of the same one.
  setTransport(null);
});

afterAll(() => {
  // Unmounted first, while the transport it polls through is still installed:
  // a portal left mounted keeps its pollers running into every later file.
  root?.unmount();
  setTransport(previous);
  removeRecordedListeners();
  document.body.innerHTML = "";
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousAct;
});

test("installs the transport before it mounts, then says the page is ready", async () => {
  const entry = await import("../src/entry-app.tsx");
  // `boot()` is started, not awaited, by the entry — it is a module, not a
  // function anybody calls — so the assertions wait for its microtasks.
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));

  // The bridge was built, and `page.ready` went out after it.
  expect(log).toEqual(["defineRPC", "send:page.ready"]);
  expect(sent).toEqual(["page.ready"]);
  // The transport is the one in force, and it is not null: `transport()` throws
  // when nothing is installed, so "installed" and "not installed" are two
  // different outcomes here rather than two shades of the same one.
  expect(() => transport()).not.toThrow();
  // React really mounted into the page's own root...
  expect(document.getElementById("root")?.childElementCount).toBeGreaterThan(0);
  // ...and the first thing it did reached the bridge, which is the ordering
  // this file exists for: a render that ran before the install would have hit a
  // `transport()` that throws, in the one build with nothing to fall back to.
  expect(asked.length).toBeGreaterThan(0);
  root = await entry.booted;
  expect(root).not.toBeNull();
});
