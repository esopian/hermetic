/**
 * The memory resource card (`MemoryProviderCard.tsx`): the catalogue's
 * summary and chips, the estimates caveat, and the fit line — an amber
 * warning with a size switch when undersized, the reason alone when the
 * vendor cannot serve it, nothing when it fits.
 */
import { cleanup, render, screen, userEvent, within } from "./dom.ts";
import { afterEach, expect, test } from "bun:test";
import {
  MEMORY_NONE_SPEC,
  MEMORY_PROVIDERS,
  MEMORY_RESOURCE_ESTIMATE_NOTE,
  type SizeId,
} from "@hermetic/core/shared";
import { MemoryProviderCard, MemoryResourceChips } from "../src/components/MemoryProviderCard.tsx";
import { memoryFit } from "../src/logic/memory-logic.ts";

afterEach(() => cleanup());

const chipTexts = (root: HTMLElement) =>
  within(root)
    .getAllByRole("listitem")
    .map((li) => li.textContent);

test("summary, every chip and the estimates note; no fit line while it fits", () => {
  const { container } = render(
    <MemoryProviderCard choice="hindsight" fit={memoryFit("hindsight", { sizeId: "medium" })} />,
  );
  expect(screen.getByText(MEMORY_PROVIDERS.hindsight.summary)).toBeTruthy();
  const chips = chipTexts(screen.getByRole("list", { name: "Resource estimates" }));
  expect(chips).toEqual([
    "RAM: ≥ 8 GiB (small+)",
    "Added RAM: ~1 GiB idle",
    "Disk: ~3 GiB",
    "Services: 1",
    "Model calls: extraction per turn",
    "Embeddings: on box",
    "Storage: on box",
  ]);
  expect(screen.getByText(MEMORY_RESOURCE_ESTIMATE_NOTE)).toBeTruthy();
  // The live region is there, empty, and no switch is offered.
  expect(screen.getByRole("status").textContent).toBe("");
  expect(screen.queryByRole("button")).toBeNull();
  expect(container.querySelector(".mem-fit-warn")).toBeNull();
});

test("undersized: the warning names the size, and Switch hands it to the setter", async () => {
  const picked: SizeId[] = [];
  const { container } = render(
    <MemoryProviderCard
      choice="hindsight"
      fit={memoryFit("hindsight", { sizeId: "xsmall" })}
      onSwitchSize={(s) => picked.push(s)}
      fitId="m-fit"
    />,
  );
  const status = screen.getByRole("status");
  expect(status.textContent).toBe("Needs size small (16 GiB) or larger. Selected: xsmall (4 GiB)");
  expect(status.id).toBe("m-fit");
  expect(container.querySelector(".mem-fit-warn")).not.toBeNull();
  await userEvent.setup().click(screen.getByRole("button", { name: "Switch to small →" }));
  expect(picked).toEqual(["small"]);
});

test("undersized with no setter says so without a button", () => {
  render(<MemoryProviderCard choice="hindsight" fit={memoryFit("hindsight", { sizeId: "micro" })} />);
  expect(screen.getByRole("status").textContent).toContain("Needs size small");
  expect(screen.queryByRole("button")).toBeNull();
});

test("vendor-blocked shows the catalogue's reason and no switch", () => {
  render(
    <MemoryProviderCard
      choice="honcho"
      vendor="anthropic"
      fit={memoryFit("honcho", { sizeId: "medium", vendor: "anthropic" })}
      onSwitchSize={() => {}}
    />,
  );
  expect(screen.getByRole("status").textContent).toBe(MEMORY_PROVIDERS.honcho.vendors_note as string);
  expect(screen.queryByRole("button")).toBeNull();
});

test("none draws the built-in descriptor; the chip row stands alone and follows the vendor", () => {
  render(<MemoryProviderCard choice="none" showLabel />);
  expect(screen.getByText(MEMORY_NONE_SPEC.label)).toBeTruthy();
  expect(screen.getByText(MEMORY_NONE_SPEC.summary)).toBeTruthy();
  cleanup();

  render(<MemoryResourceChips choice="openviking" vendor="bedrock" compact />);
  const list = screen.getByRole("list", { name: "Resource estimates" });
  expect(list.className).toContain("mem-chips-compact");
  expect(chipTexts(list)).toContain("Embeddings: on box (local model)");
});
