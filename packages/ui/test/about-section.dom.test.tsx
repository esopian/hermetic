/**
 * Settings › About & updates: the build's version, the check, and the release
 * page once a newer build is out. The check's outcome is the `app.update` push,
 * not the request's answer, so each test pushes it the way the transport does.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, screen, userEvent } from "./dom.ts";
import { AboutSection } from "../src/components/settings/AboutSection.tsx";
import { clearAppUpdate, emitAppUpdate } from "../src/state/app-update-state.tsx";
import { fakeServer } from "./fake-transport.ts";
import type { FakeServer } from "./fake-transport.ts";

let server: FakeServer | null = null;

function serve(channel: string): FakeServer {
  server = fakeServer({
    "app.info": {
      version: "1.2.3",
      channel,
      home: "/tmp/home",
      logPath: null,
      releasesUrl: "https://example.com/releases",
    },
    "app.checkForUpdate": { checked: true },
    "app.installUpdate": { started: true },
    "app.openExternal": { opened: true },
  });
  return server;
}

afterEach(() => {
  cleanup();
  server?.restore();
  server = null;
  clearAppUpdate();
});

describe("AboutSection", () => {
  test("shows the build and checks on request", async () => {
    const s = serve("stable");
    render(<AboutSection />);
    expect(await screen.findByText("v1.2.3")).toBeDefined();
    expect(screen.getByText("stable")).toBeDefined();
    expect(screen.getByText("Not checked")).toBeDefined();

    await userEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(s.to("app.checkForUpdate")).toHaveLength(1);
    await act(async () => emitAppUpdate({ status: "none" }));
    expect(screen.getByText("Up to date")).toBeDefined();
  });

  test("a release that could not be verified falls back to the download", async () => {
    const s = serve("stable");
    render(<AboutSection />);
    await screen.findByText("v1.2.3");
    await act(async () => emitAppUpdate({ status: "available", version: "1.3.0" }));
    expect(screen.getByText("v1.3.0 available")).toBeDefined();

    await userEvent.click(screen.getByRole("button", { name: "Download v1.3.0" }));
    expect(s.to("app.openExternal").map((c) => c.params)).toEqual([
      { url: "https://example.com/releases" },
    ]);
  });

  test("a verified download turns the button into the restart", async () => {
    const s = serve("stable");
    render(<AboutSection />);
    await screen.findByText("v1.2.3");
    await act(async () => emitAppUpdate({ status: "downloading", version: "1.3.0" }));
    expect(screen.getByText("Downloading v1.3.0")).toBeDefined();
    expect((screen.getByRole("button", { name: "Downloading…" }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    await act(async () => emitAppUpdate({ status: "ready", version: "1.3.0" }));
    expect(screen.getByText("v1.3.0 ready")).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "Restart to update" }));
    expect(s.to("app.installUpdate")).toHaveLength(1);
    // Restarting is the install; the release page is not involved.
    expect(s.to("app.openExternal")).toHaveLength(0);
  });

  test("a dev build cannot check", async () => {
    serve("dev");
    render(<AboutSection />);
    await screen.findByText("dev");
    expect(
      (screen.getByRole("button", { name: "Check for updates" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
