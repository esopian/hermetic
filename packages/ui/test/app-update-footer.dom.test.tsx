/**
 * The updater's line in the footer.
 *
 * `app.update` is a broadcast on a six-hour timer, not an answer to anything
 * the page asked, so two things have to hold and neither is visible from the
 * transport's side: a status the page has no sentence for draws nothing at all,
 * and an update that arrived before the footer mounted is still shown — the
 * next one is six hours away (`main/updates.ts`, `UPDATE_INTERVAL_MS`).
 *
 * The notice reaches the footer as a prop, so the host below is the real
 * `<Footer>` with the real notice passed in: what used to need a `.footer` in
 * the document for a portal to find is now plain composition, and this is where
 * that stays proved.
 */
import { act, cleanup, render, screen } from "./dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import {
  type AppUpdate,
  type ElectroviewLike,
  type RpcHandle,
  createRpcTransport,
} from "../src/api/transport-rpc.ts";
import { electrobunRequest } from "./electrobun-request.ts";
import { clearPageVisible } from "../src/lib/visibility.ts";
import { AppUpdateNotice, appUpdateText, clearAppUpdate } from "../src/state/app-update-state.tsx";
import { Footer } from "../src/components/Footer.tsx";

afterEach(() => {
  cleanup();
  clearAppUpdate();
  // `pushAppUpdate` builds a real transport, which seeds the page visible
  // (`lib/visibility.ts`). That state outlives this file unless it is cleared:
  // bun runs every test file in one process.
  clearPageVisible();
});

/**
 * Push one `app.update` at the page, the way the main process does.
 *
 * Through a real `createRpcTransport` over a fake `Electroview` rather than a
 * test-only emitter: the handler under test is the transport's, and a fake in
 * front of it would prove the footer works and leave the wiring unproven.
 */
function pushAppUpdate(update: AppUpdate): void {
  let messages: Record<string, (payload: never) => unknown> = {};
  const handle: RpcHandle = {
    request: electrobunRequest(() => Promise.resolve({})),
    send: () => {},
  };
  class FakeElectroview {
    constructor(readonly options: { rpc?: RpcHandle }) {}
    static defineRPC(options: {
      handlers: { messages?: Record<string, (payload: never) => unknown> };
    }): RpcHandle {
      messages = options.handlers.messages ?? {};
      return handle;
    }
  }
  createRpcTransport({ Electroview: FakeElectroview as unknown as ElectroviewLike });
  (messages["app.update"] as ((payload: AppUpdate) => unknown) | undefined)?.(update);
}

/** The footer as `App.tsx` renders it: the notice is one of its props. */
function Host() {
  return <Footer lastPollAt={null} connected update={<AppUpdateNotice />} />;
}

describe("appUpdateText", () => {
  test("says what each status is worth saying", () => {
    expect(appUpdateText(null)).toBe(null);
    expect(appUpdateText({ status: "none" })).toBe(null);
    expect(appUpdateText({ status: "available", version: "1.2.3" })).toBe("Update v1.2.3 available");
    expect(appUpdateText({ status: "error" })).toBe("Update check failed");
  });

  test("a status this build has never heard of draws nothing", () => {
    // `app.update` types its status as a plain string: a newer main process is
    // free to say something this page has no sentence for, and drawing the raw
    // word in the footer is worse than drawing nothing.
    expect(appUpdateText({ status: "rolling-back" })).toBe(null);
    // Including the one an older main process sent after downloading a build
    // in place: this one never does, and has no restart to offer.
    expect(appUpdateText({ status: "downloaded", version: "1.2.3" })).toBe(null);
  });

  test("an unversioned update still reads", () => {
    expect(appUpdateText({ status: "available" })).toBe("Update available");
  });
});

describe("AppUpdateNotice", () => {
  test("nothing is there until an update arrives", () => {
    render(<Host />);
    expect(document.querySelector("[data-app-update]")).toBe(null);
  });

  test("an update that landed before the mount is still shown", async () => {
    // What the transport does with a push nobody is listening to yet.
    pushAppUpdate({ status: "available", version: "9.9.9" });
    render(<Host />);
    const notice = await screen.findByText("Update v9.9.9 available");
    expect(notice.closest(".footer")).not.toBe(null);
  });

  test("a later push replaces the line", async () => {
    render(<Host />);
    await act(async () => {
      pushAppUpdate({ status: "available", version: "2.0.0" });
    });
    expect(screen.getByText("Update v2.0.0 available")).toBeDefined();
    await act(async () => {
      pushAppUpdate({ status: "none" });
    });
    expect(document.querySelector("[data-app-update]")).toBe(null);
  });
});
