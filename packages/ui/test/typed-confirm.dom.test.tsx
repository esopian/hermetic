/**
 * The typed-confirmation ceremony as an operator performs it: type, watch the
 * verdict, find the destructive button unlocked — and, until then, find that
 * neither the button nor Enter does anything.
 *
 * `test/typed-confirm.test.ts` covers `confirmMatches` and the first paint.
 * What that cannot see is the gate itself, which is the whole point of the
 * control: the drawer, not `TypedConfirm`, decides that a mismatch is not a
 * submission, and a caller that forgot to check would still render an
 * identical-looking box. `VolumeDeleteDrawer` is the caller under test because
 * it is the smallest real one — one stage, one id, one irreversible call.
 */
import { cleanup, render, screen, userEvent } from "./dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { useState } from "react";
import type { VolumeView } from "../src/api/index.ts";
import { TypedConfirm } from "../src/components/TypedConfirm.tsx";
import { VolumeDeleteDrawer } from "../src/components/VolumeDeleteDrawer.tsx";
import { fakeServer } from "./fake-transport.ts";
import type { FakeServer } from "./fake-transport.ts";

let server: FakeServer | null = null;
afterEach(() => {
  cleanup();
  server?.restore();
  server = null;
});

function volume(overrides: Partial<VolumeView> = {}): VolumeView {
  return {
    volume_id: "vol-0a1b2c3d",
    size_gib: 100,
    state: "available",
    availability_zone: "us-west-2a",
    created_at: "2026-06-01T00:00:00.000Z",
    agent: "cinder",
    managed: true,
    role_data: true,
    group: "no_agent",
    attachments: [],
    attached: false,
    attached_to: null,
    agent_status: null,
    free_for_ms: 3 * 86_400_000,
    snapshots: 7,
    newest_snapshot_at: "2026-09-01T00:00:00.000Z",
    monthly_cost_usd: 8,
    ambiguous_with: [],
    ...overrides,
  } as VolumeView;
}

/** A controlled host, because `TypedConfirm` owns no state of its own. */
function Host({ expected, onSubmit }: { expected: string; onSubmit?: () => void }) {
  const [value, setValue] = useState("");
  return (
    <TypedConfirm
      label="Type the volume id to confirm"
      expected={expected}
      value={value}
      onChange={setValue}
      onSubmit={onSubmit}
      hint="the full id, exactly as above"
      ariaLabel="Type the volume id to confirm"
    />
  );
}

describe("TypedConfirm · the verdict line", () => {
  test("stays on the hint until the value matches, then says so", async () => {
    const user = userEvent.setup();
    render(<Host expected="vol-0a1b2c3d" />);
    const input = screen.getByLabelText("Type the volume id to confirm");
    const verdict = screen.getByRole("status");

    await user.type(input, "vol-0a1b2c3");
    expect(verdict.textContent).toBe("the full id, exactly as above");

    await user.type(input, "d");
    expect(verdict.textContent).toBe("matches");
    // The verdict is announced, not merely recoloured — the agent drawer's
    // hand-rolled confirm had only the colour.
    expect(verdict.getAttribute("aria-live")).toBe("polite");
  });

  test("a value that differs only in case does not match", async () => {
    const user = userEvent.setup();
    render(<Host expected="vol-0a1b2c3d" />);
    await user.type(screen.getByLabelText("Type the volume id to confirm"), "VOL-0A1B2C3D");
    expect(screen.getByRole("status").textContent).toBe("the full id, exactly as above");
  });

  test("surrounding whitespace is forgiven — this is a value pasted off the screen", async () => {
    const user = userEvent.setup();
    render(<Host expected="vol-0a1b2c3d" />);
    await user.type(screen.getByLabelText("Type the volume id to confirm"), "  vol-0a1b2c3d  ");
    expect(screen.getByRole("status").textContent).toBe("matches");
  });
});

describe("VolumeDeleteDrawer · the gate", () => {
  test("Escape dismisses the real drawer and restores focus from its marked field", async () => {
    function OpenVolume() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Delete memory
          </button>
          {open ? (
            <VolumeDeleteDrawer volume={volume()} onClose={() => setOpen(false)} onDeleted={() => {}} />
          ) : null}
        </>
      );
    }
    const user = userEvent.setup();
    render(<OpenVolume />);
    const opener = screen.getByRole("button", { name: "Delete memory" });
    await user.click(opener);
    expect(document.activeElement === screen.getByLabelText("Type the volume id to confirm")).toBe(
      true,
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement === opener).toBe(true);
  });

  const routes = () => ({
    "volumes.delete": { deleted: true, volume_id: "vol-0a1b2c3d" },
  });

  test("the destructive button is disabled until the id is typed exactly", async () => {
    server = fakeServer(routes());
    const user = userEvent.setup();
    render(<VolumeDeleteDrawer volume={volume()} onClose={() => {}} onDeleted={() => {}} />);

    const button = screen.getByRole("button", { name: "Delete volume" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    const input = screen.getByLabelText("Type the volume id to confirm");
    await user.type(input, "vol-0a1b2c3");
    expect(button.disabled).toBe(true);

    await user.type(input, "d");
    expect(button.disabled).toBe(false);
  });

  test("Enter in the box does nothing while the id does not match", async () => {
    server = fakeServer(routes());
    const user = userEvent.setup();
    const deleted: string[] = [];
    render(
      <VolumeDeleteDrawer volume={volume()} onClose={() => {}} onDeleted={() => deleted.push("x")} />,
    );

    const input = screen.getByLabelText("Type the volume id to confirm");
    await user.type(input, "vol-0a1b2c3{Enter}");
    // `TypedConfirm` forwards Enter unconditionally; the caller is what makes a
    // near-miss harmless, and the regression this catches is a caller that
    // wires `onSubmit` straight to the API.
    expect(server.calls).toEqual([]);
    expect(deleted).toEqual([]);
  });

  test("a matched id submits — by Enter and by the button, once each", async () => {
    server = fakeServer(routes());
    const user = userEvent.setup();
    let deleted = 0;
    render(
      <VolumeDeleteDrawer volume={volume()} onClose={() => {}} onDeleted={() => (deleted += 1)} />,
    );

    const input = screen.getByLabelText("Type the volume id to confirm");
    await user.type(input, "vol-0a1b2c3d{Enter}");
    expect(server.to("volumes.delete").length).toBe(1);
    expect(deleted).toBe(1);

    await user.click(screen.getByRole("button", { name: "Delete volume" }));
    expect(server.to("volumes.delete").length).toBe(2);
    expect(deleted).toBe(2);
  });
});
