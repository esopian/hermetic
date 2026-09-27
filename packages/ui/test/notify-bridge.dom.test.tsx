/**
 * Desktop banners.
 *
 * The rules that decide whether a banner is owed are not retested here —
 * `notification-logic.test.ts` owns those. What is only true at runtime is the
 * last step: the page has no permission to raise one under `views://`, so it
 * asks the app over `app.notify`. This file pins that asking is *all* that
 * changed: a row the rules suppress is still suppressed, and an app that
 * refuses the request does not take the in-page toast down with it.
 *
 * The browser half of this file went with the HTTP head (Phase 5b). There is no
 * page that raises its own `Notification` any more — the fork it tested is
 * gone, not untested — but `FakeNotification` stays installed, because "the
 * page did not construct one" is only worth asserting when constructing one
 * would have worked.
 */
import { act, cleanup, render, screen, waitFor } from "./dom.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { NotificationView } from "../src/api/index.ts";
import { NotifyProvider, useNotify } from "../src/state/notify-state.tsx";
import type { NotifyApi } from "../src/state/notify-state.tsx";
import { FleetProvider } from "../src/state/state.tsx";
import { errorBody, fakeServer } from "./fake-transport.ts";
import type { FakeRoutes, FakeServer } from "./fake-transport.ts";
import { FakeStream } from "./fake-stream.ts";

let server: FakeServer | null = null;

/** A stand-in for the browser API the page must never reach for. */
class FakeNotification {
  static permission = "granted";
  static requests = 0;
  static raised: Array<{ title: string; options?: NotificationOptions }> = [];
  constructor(title: string, options?: NotificationOptions) {
    FakeNotification.raised.push({ title, options });
  }
  static requestPermission(): Promise<string> {
    FakeNotification.requests += 1;
    return Promise.resolve("granted");
  }
}

const globals = globalThis as { Notification?: unknown };
let hadNotification = false;
let realNotification: unknown;

beforeEach(() => {
  window.location.hash = "";
  hadNotification = "Notification" in globals;
  realNotification = globals.Notification;
  FakeNotification.permission = "granted";
  FakeNotification.requests = 0;
  FakeNotification.raised = [];
  globals.Notification = FakeNotification;
});

afterEach(() => {
  cleanup();
  server?.restore();
  server = null;
  if (hadNotification) globals.Notification = realNotification;
  else delete globals.Notification;
});

const META = {
  initialized: true,
  home: "/tmp/hermetic-home",
  tailnet: "acme.ts.net",
  adopt_error: null,
  last_teardown: null,
  config: {
    account_id: "123456789012",
    region: "us-west-2",
    fleet_id: "hermetic",
    profile: "acme",
    tailnet: "acme.ts.net",
  },
};

/** An empty inbox: every row in this file arrives on the stream, not the read. */
const API: NotifyApi = {
  fetchNotifications: () =>
    Promise.resolve({ notifications: [], unread: 0, needs_action: 0, mutes: [] } as never),
  ackNotification: () => Promise.resolve({ acked: 0 } as never),
  muteNotification: () => Promise.resolve({ mutes: [] } as never),
};

/**
 * An operation finishing: the default preferences deliver that group as a toast
 * *and* as a desktop banner, so it is the row that reaches the raise at all.
 */
function notification(over: Partial<NotificationView> = {}): NotificationView {
  return {
    id: "op-1",
    at: new Date().toISOString(),
    source: "operation",
    kind: "operation.done",
    class: "ok",
    title: "oriole finished bootstrapping",
    detail: "6 stages · 7m41s · ready.",
    agent: "oriole",
    fleet_id: "hermetic",
    ref: null,
    key: null,
    actions: [],
    read_at: null,
    resolved_at: null,
    muted: false,
    ...over,
  } as unknown as NotificationView;
}

/** The provider's own state, surfaced so a test can read it without a surface. */
function Probe() {
  const notify = useNotify();
  return (
    <div>
      <span data-testid="permission">{notify.desktopPermission}</span>
      <span data-testid="toasts">{notify.toasts.length}</span>
      <button type="button" onClick={() => void notify.requestDesktop()}>
        ask
      </button>
    </div>
  );
}

async function mount(routes: FakeRoutes = {}) {
  server = fakeServer({ "meta.get": META, "agents.list": [], ...routes });
  render(
    <FleetProvider>
      <NotifyProvider api={API}>
        <Probe />
      </NotifyProvider>
    </FleetProvider>,
  );
  await waitFor(() => expect(FakeStream.last("fleet")).toBeTruthy());
  return server;
}

/** One row down the fleet stream, the way core sends it (§6). */
function deliver(n: NotificationView) {
  act(() => {
    FakeStream.last("fleet").emit("notification", { notification: n });
  });
}

describe("desktop notifications", () => {
  test("a delivered row is raised through `app.notify`, not by the page", async () => {
    const fake = await mount({ "app.notify": { delivered: true, permission: "granted" } });
    deliver(notification());

    await waitFor(() => expect(fake.to("app.notify")).toHaveLength(1));
    expect(fake.to("app.notify")[0]?.params).toMatchObject({
      title: "oriole finished bootstrapping",
      body: "6 stages · 7m41s · ready.",
      tag: "op-1",
    });
    expect(FakeNotification.raised).toHaveLength(0);
  });

  test("the permission is granted without a prompt the page cannot raise", async () => {
    await mount({ "app.notify": { delivered: true, permission: "granted" } });
    expect(screen.getByTestId("permission").textContent).toBe("granted");

    act(() => {
      screen.getByRole("button", { name: "ask" }).click();
    });
    await waitFor(() => expect(screen.getByTestId("permission").textContent).toBe("granted"));
    expect(FakeNotification.requests).toBe(0);
  });

  test("a muted row is still suppressed: the rules did not move", async () => {
    const fake = await mount({ "app.notify": { delivered: true, permission: "granted" } });
    deliver(notification({ id: "muted-1", muted: true }));

    // Nothing to wait for, so wait for the row to have landed instead: it is
    // held either way, and only the banner is owed to no one.
    await waitFor(() => expect(screen.getByTestId("toasts").textContent).toBe("0"));
    expect(fake.to("app.notify")).toHaveLength(0);
    expect(FakeNotification.raised).toHaveLength(0);
  });

  test("an app that refuses the banner does not break the toast", async () => {
    const fake = await mount({
      "app.notify": errorBody("UNSUPPORTED", "this head raises no banners"),
    });
    deliver(notification());

    await waitFor(() => expect(screen.getByTestId("toasts").textContent).toBe("1"));
    expect(fake.to("app.notify")).toHaveLength(1);
  });
});
