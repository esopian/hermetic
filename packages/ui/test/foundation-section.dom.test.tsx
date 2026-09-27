/**
 * §8.3's Bedrock grant, on the one screen that has the button for it.
 *
 * The grant is a *second* reason to run a foundation update, independent of the
 * version — a fleet on the current foundation can still name a model its
 * instance role may not invoke, or record no grant at all. Both halves are
 * asserted here because they failed together: the section rendered
 * `stale_bedrock_grants` nowhere, and the update button read `update_available`
 * alone, so a stale grant on a current foundation was invisible *and*
 * unfixable from the UI.
 *
 * `FoundationPanel` is driven rather than `FoundationSection`: the panel is the
 * piece that renders the facts and owns the button's `disabled`, while the
 * section around it is a `/api/network` read and a drawer.
 */
import { cleanup, render, screen } from "./dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import type { FoundationStatus } from "../src/api/index.ts";
import { FoundationPanel } from "../src/components/settings/FoundationSection.tsx";

afterEach(cleanup);

function status(over: Partial<FoundationStatus> = {}): FoundationStatus {
  return {
    fleet: {
      foundation_version: 10,
      template_sha256: "a".repeat(64),
      hermeticd_version: "0.5.0",
      ubuntu_release: "noble",
      ami_id: "ami-0123456789abcdef0",
      network: null,
    },
    available: {
      foundation_version: 10,
      template_sha256: "a".repeat(64),
      hermeticd_version: "0.5.0",
    },
    update_available: false,
    tool_outdated: false,
    in_progress: null,
    agents: [],
    hermes: null,
    ...over,
  } as unknown as FoundationStatus;
}

function panel(foundation: FoundationStatus) {
  return <FoundationPanel foundation={foundation} onOpenUpdate={() => {}} />;
}

const updateButton = () =>
  screen.getByRole("button", { name: "Update foundation…" }) as HTMLButtonElement;

describe("FoundationPanel · bedrock grant", () => {
  test("an empty list reads as current, and nothing is actionable", () => {
    render(panel(status({ stale_bedrock_grants: [] } as Partial<FoundationStatus>)));

    expect(screen.getByText("bedrock grant")).toBeTruthy();
    expect(screen.getByText("current")).toBeTruthy();
    expect(screen.getByText("up to date")).toBeTruthy();
    expect(updateButton().disabled).toBe(true);
  });

  test("a stale grant is named, and the update button is offered on a current foundation", () => {
    render(panel(status({ stale_bedrock_grants: ["zai.glm-4.7-flash"] } as Partial<FoundationStatus>)));

    expect(screen.getByText(/stale: zai\.glm-4\.7-flash/)).toBeTruthy();
    // The verdict stops claiming "up to date" as well — the row and the status
    // line must not disagree with each other.
    expect(screen.queryByText("up to date")).toBeNull();
    expect(screen.getByText(/Bedrock grant is not/)).toBeTruthy();
    expect(updateButton().disabled).toBe(false);
  });

  test("an absent field is 'not recorded', and is equally actionable", () => {
    // Pre-v10 fleets record no grant at all. That is an unchecked policy, not a
    // checked one, and the update is what records it.
    render(panel(status()));

    expect(screen.getByText(/not recorded/)).toBeTruthy();
    expect(screen.queryByText("current")).toBeNull();
    expect(updateButton().disabled).toBe(false);
  });

  test("an update already running still wins: nothing is offered under a held lock", () => {
    render(
      panel(
        status({
          stale_bedrock_grants: ["zai.glm-4.7-flash"],
          in_progress: { owner: "evan", expires: "2026-09-04T17:00:00.000Z" },
        } as Partial<FoundationStatus>),
      ),
    );

    expect(updateButton().disabled).toBe(true);
  });
});
