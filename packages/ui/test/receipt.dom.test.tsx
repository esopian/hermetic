import { cleanup, render, screen, userEvent } from "./dom.ts";
import { afterEach, expect, test } from "bun:test";
import { useState } from "react";
import { LastTeardownReceipt, TeardownReceiptModal } from "../src/components/TeardownReceipt.tsx";
import { ShortcutsPopover } from "../src/components/Shortcuts.tsx";
import type { TeardownReceipt } from "../src/api/index.ts";
import { errorBody, fakeServer } from "./fake-transport.ts";
import type { FakeServer } from "./fake-transport.ts";

let server: FakeServer | null = null;
afterEach(() => {
  cleanup();
  server?.restore();
  server = null;
});

function Host() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open receipt
      </button>
      {open ? <LastTeardownReceipt onClose={() => setOpen(false)} /> : null}
    </>
  );
}

test("a receipt finishing its read cannot take Escape or focus from nested help", async () => {
  let dismissedReceipt = 0;
  let dismissedHelp = 0;
  const anchor = { current: null };
  const onClose = () => {
    dismissedReceipt++;
  };
  const onHelpClose = () => {
    dismissedHelp++;
  };
  const user = userEvent.setup();
  const { rerender } = render(
    <>
      <TeardownReceiptModal receipt={null} onClose={onClose} />
      <ShortcutsPopover anchor={anchor} onClose={onHelpClose} />
    </>,
  );
  const help = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
  rerender(
    <>
      <TeardownReceiptModal
        receipt={
          {
            outcome: "ok",
            options: {},
            resources: [],
            events: [],
            finished_at: "2026-09-03T05:09:36.000Z",
          } as unknown as TeardownReceipt
        }
        onClose={onClose}
      />
      <ShortcutsPopover anchor={anchor} onClose={onHelpClose} />
    </>,
  );
  expect(document.activeElement === help).toBe(true);
  await user.keyboard("{Escape}");
  expect(dismissedHelp).toBe(1);
  expect(dismissedReceipt).toBe(0);
});

for (const failed of [true, false]) {
  test(`receipt ${failed ? "read error" : "success"} is named, traps focus and restores its opener`, async () => {
    server = fakeServer({
      "teardowns.list": failed
        ? errorBody("OFFLINE", "Receipt unavailable")
        : [
            {
              id: "r-1",
              op_id: "op-1",
              finished_at: "2026-09-03T05:09:36.000Z",
              account_id: "123456789012",
              region: "us-east-1",
              fleet_id: "fxtr0001",
              stack_name: "hermetic-fxtr0001",
              outcome: "ok",
              options: {
                purge: true,
                delete_snapshots: false,
                delete_volumes: false,
                reset_local: true,
              },
              error: null,
              resources: [],
              events: [],
            },
          ],
    });
    const user = userEvent.setup();
    render(<Host />);
    const opener = screen.getByRole("button", { name: "Open receipt" });
    await user.click(opener);
    const dialog = await screen.findByRole("dialog", {
      name: failed ? "Could not read the teardown record" : "Foundation torn down",
    });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement === opener).toBe(true);
  });
}

/**
 * §4.6: an allocation id is something the operator has to paste into the EC2
 * console, so it has to be on screen — the dispositions say an address was kept
 * or released, but only this block says which one.
 */
test("the receipt prints the allocation ids of Elastic IPs kept and released", () => {
  render(
    <TeardownReceiptModal
      receipt={
        {
          outcome: "ok",
          options: {},
          resources: [],
          addresses: {
            kept: [{ allocation_id: "eipalloc-kept", public_ip: "203.0.113.7", associated: true }],
            released: ["eipalloc-gone"],
          },
          events: [],
          finished_at: "2026-09-03T05:09:36.000Z",
        } as unknown as TeardownReceipt
      }
      onClose={() => {}}
    />,
  );

  expect(screen.getByText("eipalloc-kept 203.0.113.7")).toBeDefined();
  expect(screen.getByText(/still associated/)).toBeDefined();
  expect(screen.getByText("eipalloc-gone")).toBeDefined();
  expect(screen.getByText("released")).toBeDefined();
});

/** A receipt from before the sweep existed carries no block, and shows none. */
test("a receipt with no addresses block shows no Elastic address section", () => {
  render(
    <TeardownReceiptModal
      receipt={
        {
          outcome: "ok",
          options: {},
          resources: [],
          events: [],
          finished_at: "2026-09-03T05:09:36.000Z",
        } as unknown as TeardownReceipt
      }
      onClose={() => {}}
    />,
  );
  expect(screen.queryByText("Elastic addresses")).toBeNull();
});
