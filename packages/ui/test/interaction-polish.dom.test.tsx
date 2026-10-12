import { cleanup, fireEvent, render, screen, userEvent } from "./dom.ts";
import { afterEach, expect, spyOn, test } from "bun:test";
import { useRef, useState } from "react";
import type { AgentView, VolumeView } from "../src/api/index.ts";
import { FleetBoard } from "../src/components/FleetBoard.tsx";
import { FleetTriage } from "../src/components/FleetTriage.tsx";
import { Popover } from "../src/components/Popover.tsx";
import { CopyId } from "../src/components/primitives.tsx";
import { VolumesView } from "../src/components/VolumesView.tsx";
import { triageGroups } from "../src/logic/selectors.ts";
import { volumeScan } from "../src/logic/loading.ts";

afterEach(cleanup);

const AGENT = {
  name: "lumen",
  status: "ready",
  display_status: "ready",
  size: "medium",
  instance_type: "t4g.2xlarge",
  hermes_version: "1.2.0",
  volume_id: "vol-1234567890",
  volume_gib: 100,
  created_at: "2026-09-01T00:00:00Z",
  health: { hermes: true, tailscale: true, disk: true },
} as AgentView;

test("copy is a Tab stop, announces success and keeps full selectable text on failure", async () => {
  const user = userEvent.setup();
  render(<CopyId id="vol-1234567890" label="vol-123…" />);
  const copy = screen.getByRole("button", { name: "Copy vol-1234567890" });
  const write = spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  try {
    await user.tab();
    expect(document.activeElement === copy).toBe(true);
    await user.keyboard("{Enter}");
    expect(write).toHaveBeenCalledWith("vol-1234567890");
    expect(screen.getByRole("status").textContent).toBe("Copied vol-1234567890");
    write.mockRejectedValue(new Error("Denied"));
    await user.keyboard(" ");
    expect(screen.getByRole("status").textContent).toContain("Clipboard unavailable");
    const full = screen.getByRole("textbox", { name: "Full ID vol-1234567890" }) as HTMLInputElement;
    expect(full.value).toBe("vol-1234567890");
    await user.tab();
    expect(document.activeElement === full).toBe(true);
    expect(full.selectionStart).toBe(0);
    expect(full.selectionEnd).toBe(full.value.length);
  } finally {
    write.mockRestore();
  }
});

for (const layout of ["board", "triage"] as const) {
  test(`${layout} activates only on its own Enter/Space, not descendant keys`, async () => {
    let selected = 0;
    const user = userEvent.setup();
    const props = {
      agents: [AGENT],
      latest: "1.2.0",
      tailnet: "acme.ts.net",
      volumes: [],
      onSelect: () => {
        selected++;
      },
      onCreateOnVolume: () => {},
      onSeeVolumes: () => {},
    };
    render(
      layout === "board" ? (
        <FleetBoard {...props} />
      ) : (
        <FleetTriage {...props} selected={null} groups={triageGroups([AGENT], "1.2.0")} />
      ),
    );
    const card = screen.getByRole("button", { name: "lumen · ready" });
    card.focus();
    await user.keyboard("{Enter} ");
    expect(selected).toBe(2);
    fireEvent.keyDown(card.querySelector("span")!, { key: "Enter" });
    fireEvent.keyDown(card.querySelector("span")!, { key: " " });
    expect(selected).toBe(2);
    if (layout === "board") {
      const write = spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
      try {
        screen.getByRole("button", { name: "Copy vol-1234567890" }).focus();
        await user.keyboard("{Enter} ");
        expect(write).toHaveBeenCalledTimes(2);
        expect(selected).toBe(2);
      } finally {
        write.mockRestore();
      }
    }
  });
}

test("filtered inventory has its own empty state and clear action", async () => {
  const user = userEvent.setup();
  // The filter is the fleet toolbar's now, shared by both lenses; this stands in
  // for it so the lanes' own empty state and its Clear filter are still covered.
  function Lens() {
    const [query, setQuery] = useState("");
    return (
      <>
        <input aria-label="Filter volumes" value={query} onChange={(e) => setQuery(e.target.value)} />
        <VolumesView
          volumes={[
            {
              volume_id: "vol-123",
              group: "attached",
              attached: true,
              state: "in-use",
              size_gib: 100,
              agent: "lumen",
              monthly_cost_usd: 8,
            } as VolumeView,
          ]}
          summary={null}
          error={null}
          scan={volumeScan({ loading: false, hasRead: true, error: null, count: 1 })}
          query={query}
          onClearQuery={() => setQuery("")}
          onCreate={() => {}}
          onDelete={() => {}}
          onGoToAgent={() => {}}
        />
      </>
    );
  }
  render(<Lens />);
  await user.type(screen.getByRole("textbox", { name: "Filter volumes" }), "missing");
  expect(screen.getByText("No matching volumes")).toBeTruthy();
  expect(screen.queryByText("Nothing loose")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Clear filter" }));
  expect(screen.queryByText("No matching volumes")).toBeNull();
  expect(screen.getByRole("button", { name: "Copy vol-123" })).toBeTruthy();
});

// The widths below are synthetic extremes for the clamp arithmetic — smaller
// than the 320px popover, so every branch of the clamp runs. They are not a
// phone layout: phone widths are out of scope (AGENTS.md, Conventions).
test("popover flips above footer and clamps narrow viewports on resize and scroll", async () => {
  const width = window.innerWidth;
  const height = window.innerHeight;
  let anchorTop = 550;
  const bounds = spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains("popover")
      ? new DOMRect(0, 0, 320, 200)
      : new DOMRect(290, anchorTop, 40, 30);
  });
  function Host() {
    const anchor = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    return (
      <>
        <button ref={anchor} type="button" onClick={() => setOpen(true)}>
          Help
        </button>
        {open ? (
          <Popover anchor={anchor} onClose={() => setOpen(false)} label="Help">
            <button type="button">Close</button>
          </Popover>
        ) : null}
      </>
    );
  }
  try {
    window.innerWidth = 320;
    window.innerHeight = 600;
    const user = userEvent.setup();
    render(<Host />);
    await user.click(screen.getByRole("button", { name: "Help" }));
    const popover = screen.getByRole("dialog", { name: "Help" });
    expect(popover.style.width).toBe("296px");
    expect(popover.style.left).toBe("12px");
    expect(popover.style.top).toBe("350px");
    anchorTop = 50;
    fireEvent.scroll(window);
    expect(popover.style.top).toBe("80px");
    window.innerWidth = 240;
    window.innerHeight = 180;
    fireEvent.resize(window);
    expect(popover.style.width).toBe("216px");
    expect(popover.style.maxHeight).toBe("88px");
    expect(popover.style.overflowY).toBe("auto");
  } finally {
    bounds.mockRestore();
    window.innerWidth = width;
    window.innerHeight = height;
  }
});
