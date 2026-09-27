/**
 * §4.7's reattach: an `init` that is already running must never be reported as
 * a failed one.
 *
 * `init` is the longest unattended wait in the product and the only flow that
 * did not survive a reload — the tab came back on step 1, three steps of
 * re-answering later `init` answered 409, and the op still building
 * the foundation was shown as "Init failed", which invites a second one on top
 * of a live CreateStack. Two halves, both tested here: a 409 that names an op
 * is followed rather than reported, and the op id is left in `sessionStorage`
 * so the next mount opens straight on the progress view.
 *
 * The attach branch is the one driven, because it is the shortest walk to
 * `init` — step 2's button runs the init directly when the account
 * already has a foundation.
 */
import { act, cleanup, render, screen, userEvent, waitFor } from "./dom.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { App } from "../src/App.tsx";
import { FleetProvider } from "../src/state/state.tsx";
import { InitWizard } from "../src/components/InitWizard.tsx";
import { errorBody, fakeServer } from "./fake-transport.ts";
import type { FakeServer } from "./fake-transport.ts";
import { FakeStream } from "./fake-stream.ts";

const INIT_OPID_KEY = "hermetic.init.opId";

/**
 * The op id out of the breadcrumb, whichever shape it is in: the wizard writes
 * a small JSON record (the branch and the display strings a reloaded tab cannot
 * re-derive) and still reads the bare id an older build wrote. The tests are
 * about *which op is followed*, so they go through this rather than pinning the
 * record's fields.
 */
function storedOpId(): string | null {
  const raw = sessionStorage.getItem(INIT_OPID_KEY);
  if (raw === null) return null;
  if (!raw.startsWith("{")) return raw;
  return (JSON.parse(raw) as { opId?: string }).opId ?? null;
}

let server: FakeServer | null = null;

beforeEach(() => {
  window.location.hash = "";
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  server?.restore();
  server = null;
  sessionStorage.clear();
});

/** An unbound home: `initialized: false` keeps the fleet stream from opening. */
const META = {
  initialized: false,
  home: "/tmp/hermetic-home",
  config: null,
  tailnet: null,
  adopt_error: null,
  last_teardown: null,
};

/** A profile whose account already carries a foundation — so this is an attach. */
function routes(over: Record<string, unknown> = {}) {
  return {
    "meta.get": META,
    "init.profiles": {
      profiles: [{ name: "acme", region: "us-west-2", credential_type: "sso", source: "config" }],
    },
    "init.identity": {
      identity: {
        account_id: "123456789012",
        arn: "arn:aws:sts::123456789012:assumed-role/admin/evan",
        alias: "acme",
        org_id: null,
        region: "us-west-2",
        profile: "acme",
      },
      foundation: {
        found: true,
        fleet_id: "hermetic",
        region: "us-west-2",
        tailnet: "acme.ts.net",
        stack_status: "CREATE_COMPLETE",
      },
    },
    ...over,
  };
}

function mount(children: ReactNode = <InitWizard meta={null} onOpenFleet={() => {}} />) {
  return render(<FleetProvider>{children}</FleetProvider>);
}

/** Step 1 → step 2 → the verify toggle → "Attach", which is what calls `init`. */
async function walkToAttach(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /acme/ }));
  await user.click(screen.getByRole("button", { name: "Continue →" }));
  // The step-2 toggle only exists once the connection check has confirmed.
  await user.click(await screen.findByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "Attach →" }));
}

for (const helpOpen of [false, true]) {
  test(`async identity confirmation ${helpOpen ? "leaves focus and Space in help" : "focuses the checkbox without an overlay"}`, async () => {
    const started = Promise.withResolvers<void>();
    const responseGate = Promise.withResolvers<void>();
    // The identity read held open at the transport, which is where the wizard
    // waits: the checkbox does not exist until this answers.
    server = fakeServer(
      routes({
        "init.identity": async () => {
          started.resolve();
          await responseGate.promise;
          return routes()["init.identity"];
        },
      }),
    );
    try {
      const user = userEvent.setup();
      mount(<App />);
      await user.click(await screen.findByRole("button", { name: /acme/ }));
      await user.click(screen.getByRole("button", { name: "Continue →" }));
      await started.promise;
      expect(screen.queryByRole("checkbox")).toBeNull();
      if (helpOpen) await user.keyboard("?");

      await act(async () => {
        responseGate.resolve();
      });
      const checkbox = (await screen.findByRole("checkbox")) as HTMLInputElement;
      expect(checkbox.checked).toBe(false);
      if (helpOpen) {
        const help = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
        expect(help.contains(document.activeElement)).toBe(true);
        await user.keyboard(" ");
        expect(checkbox.checked).toBe(false);
        expect(help.contains(document.activeElement)).toBe(true);
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
        expect(checkbox.checked).toBe(false);
      } else {
        expect(document.activeElement === checkbox).toBe(true);
        await user.keyboard(" ");
        expect(checkbox.checked).toBe(true);
      }
    } finally {
      responseGate.resolve();
    }
  });
}

describe("InitWizard · a 409 that names the running op", () => {
  test("follows that op on step 4 instead of calling it a failure", async () => {
    server = fakeServer(
      routes({
        init: errorBody("CONFLICT", "an init is already running", { op_id: "op-init-9" }),
      }),
    );
    const user = userEvent.setup();
    mount();
    await walkToAttach(user);

    // Step 4, on the progress view — not the error slot.
    await screen.findByText("Step 04");
    await waitFor(() => expect(screen.getByRole("progressbar")).toBeTruthy());
    expect(screen.queryByText("Init failed")).toBeNull();
    expect(screen.queryByText(/an init is already running/)).toBeNull();

    // …and it is *that* op it is watching.
    expect(FakeStream.last("ops.subscribe").params).toMatchObject({ op_id: "op-init-9" });
  });

  test("writes the op id to sessionStorage, so a reload does not lose it", async () => {
    server = fakeServer(
      routes({
        init: errorBody("CONFLICT", "an init is already running", { op_id: "op-init-9" }),
      }),
    );
    const user = userEvent.setup();
    mount();
    await walkToAttach(user);

    await waitFor(() => expect(storedOpId()).toBe("op-init-9"));
  });

  test("a 409 with no op id really did start nothing, and is shown as the failure it is", async () => {
    server = fakeServer(
      routes({
        init: errorBody("MODE_MISMATCH", "this account has no foundation to attach to"),
      }),
    );
    const user = userEvent.setup();
    mount();
    await walkToAttach(user);

    await screen.findByText("Init failed");
    expect(screen.getByText(/MODE_MISMATCH/)).toBeTruthy();
    // Nothing to come back to, so nothing is left behind for the next mount.
    expect(sessionStorage.getItem(INIT_OPID_KEY)).toBeNull();
  });
});

describe("InitWizard · the reattach breadcrumb", () => {
  test("a fresh mount with a stored record opens on step 4, following that op", async () => {
    sessionStorage.setItem(
      INIT_OPID_KEY,
      JSON.stringify({
        opId: "op-init-42",
        attaching: true,
        profile: "acme",
        region: "us-west-2",
        tailnet: "acme.ts.net",
        accountId: "123456789012",
        policyPhase: false,
      }),
    );
    server = fakeServer(routes());
    mount();

    // First paint, no walk: the reloaded tab is back where it was.
    await screen.findByText("Step 04");
    expect(screen.queryByText("Step 01")).toBeNull();
    expect(FakeStream.last("ops.subscribe").params).toMatchObject({ op_id: "op-init-42" });
  });

  test("a breadcrumb from an older build — the bare op id — is still honoured", async () => {
    sessionStorage.setItem(INIT_OPID_KEY, "op-init-7");
    server = fakeServer(routes());
    mount();

    await screen.findByText("Step 04");
    expect(FakeStream.last("ops.subscribe").params).toMatchObject({ op_id: "op-init-7" });
  });

  test("the breadcrumb is cleared when the op it names finishes", async () => {
    sessionStorage.setItem(INIT_OPID_KEY, "op-init-42");
    server = fakeServer(routes());
    mount();
    await screen.findByText("Step 04");

    const es = FakeStream.last("ops.subscribe");
    await waitFor(() => expect(storedOpId()).toBe("op-init-42"));
    act(() => es.emit("done", { ok: true, error: null }));

    // A finished op is nothing to come back to; leaving the key would put the
    // next mount on a progress view for an op the server has forgotten.
    await waitFor(() => expect(sessionStorage.getItem(INIT_OPID_KEY)).toBeNull());
  });
});
