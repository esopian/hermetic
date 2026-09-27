/**
 * Clicking a column header, end to end: the header the operator clicks, the
 * order `App.tsx` computes from it, and the rows that come back.
 *
 * `test/selectors.test.ts` pins `nextSort`/`sortAgents` as arithmetic. This
 * pins the wiring between them and the table — a header bound to the wrong
 * `SortKey`, or an `aria-sort` left on a column that is no longer in force,
 * are both invisible to a pure test and to a screenshot, and the second one is
 * a screen reader being told the wrong thing about the order it is reading.
 *
 * The sort state lives in the host, because it lives in `App.tsx`: the board
 * and the triage view draw the same list, so the table cannot own it.
 */
import { cleanup, render, screen, userEvent, within } from "./dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { useState } from "react";
import type { AgentView } from "../src/api/index.ts";
import { FleetTable } from "../src/components/FleetTable.tsx";
import { nextSort, sortAgents } from "../src/logic/selectors.ts";
import type { Sort } from "../src/logic/selectors.ts";

afterEach(cleanup);

function agent(name: string, over: Partial<AgentView> = {}): AgentView {
  return {
    name,
    display_status: "ready",
    status: "ready",
    size: "medium",
    instance_type: "t4g.2xlarge",
    hermes_version: "1.2.0",
    tailscale_ip: "100.64.0.9",
    volume_id: null,
    volume_gib: 100,
    last_heartbeat: "2026-09-06T11:59:55.000Z",
    created_at: "2026-09-01T00:00:00.000Z",
    health: { hermes: true, tailscale: true, disk: true },
    metrics: { cpu_pct: 50, mem_pct: 20, disk_pct: 30 },
    ...over,
  } as AgentView;
}

/**
 * `busy` 90, `idle` 5, `quiet` 40, and two rows with no CPU reading at all: a
 * stopped box, and one that is up but has never reported metrics.
 */
const FLEET: AgentView[] = [
  agent("busy", { metrics: { cpu_pct: 90, mem_pct: 10, disk_pct: 10 } }),
  agent("idle", { metrics: { cpu_pct: 5, mem_pct: 10, disk_pct: 10 } }),
  agent("stopped-one", {
    display_status: "stopped",
    metrics: { cpu_pct: 99, mem_pct: 9, disk_pct: 9 },
  }),
  agent("quiet", { metrics: { cpu_pct: 40, mem_pct: 10, disk_pct: 10 } }),
  agent("nometrics", { metrics: undefined }),
];

function Host({ agents = FLEET }: { agents?: AgentView[] }) {
  const [sort, setSort] = useState<Sort | null>(null);
  return (
    <FleetTable
      agents={sortAgents(agents, sort, Date.now())}
      latest="1.2.0"
      tailnet="acme.ts.net"
      fresh={new Set()}
      volumes={[]}
      showDestroyed={false}
      selected={null}
      sort={sort}
      onSort={(key) => setSort((s) => nextSort(s, key))}
      onSelect={() => {}}
      onCreateOnVolume={() => {}}
      onSeeVolumes={() => {}}
    />
  );
}

/** The agent names, top to bottom, as drawn. */
function rowNames(): string[] {
  return screen
    .getAllByRole("row")
    .filter((r) => r.className.includes("tbody-row"))
    .map((r) => r.querySelector(".nm")?.textContent ?? "");
}

const cpuHeader = () =>
  screen.getAllByRole("columnheader").find((h) => h.textContent?.startsWith("CPU"));

describe("FleetTable · sorting by a column", () => {
  test("the first click sorts ascending and says so in `aria-sort`", async () => {
    const user = userEvent.setup();
    render(<Host />);
    expect(rowNames()).toEqual(["busy", "idle", "stopped-one", "quiet", "nometrics"]);
    expect(cpuHeader()?.getAttribute("aria-sort")).toBe("none");

    await user.click(screen.getByRole("button", { name: /CPU/ }));

    expect(rowNames().slice(0, 3)).toEqual(["idle", "quiet", "busy"]);
    expect(cpuHeader()?.getAttribute("aria-sort")).toBe("ascending");
  });

  test("the second click flips to descending, and the third gives the server's order back", async () => {
    const user = userEvent.setup();
    render(<Host />);
    const header = () => screen.getByRole("button", { name: /CPU/ });

    await user.click(header());
    await user.click(header());
    expect(rowNames().slice(0, 3)).toEqual(["busy", "quiet", "idle"]);
    expect(cpuHeader()?.getAttribute("aria-sort")).toBe("descending");

    // Three states, so an operator can always get back out of a sort.
    await user.click(header());
    expect(rowNames()).toEqual(["busy", "idle", "stopped-one", "quiet", "nometrics"]);
    expect(cpuHeader()?.getAttribute("aria-sort")).toBe("none");
  });

  test("rows with no CPU reading stay at the bottom in both directions", async () => {
    const user = userEvent.setup();
    render(<Host />);
    const header = () => screen.getByRole("button", { name: /CPU/ });

    await user.click(header());
    // A missing metric is not a zero: ascending must not open on a screen of
    // dashes, and descending must not bury the busiest agent under them.
    expect(rowNames().slice(-2)).toEqual(["nometrics", "stopped-one"]);

    await user.click(header());
    expect(rowNames().slice(-2)).toEqual(["nometrics", "stopped-one"]);
  });

  test("only the column in force claims a sort", async () => {
    const user = userEvent.setup();
    render(<Host />);
    await user.click(screen.getByRole("button", { name: /CPU/ }));

    const sorted = screen
      .getAllByRole("columnheader")
      .filter((h) => h.getAttribute("aria-sort") !== "none" && h.hasAttribute("aria-sort"));
    expect(sorted.length).toBe(1);
    expect(sorted[0]?.textContent).toContain("CPU");
    // The glyph and the ARIA state agree, so the two audiences see one answer.
    expect(within(sorted[0] as HTMLElement).getByText("▲")).toBeTruthy();
  });

  test("a header with no `SortKey` is not a button at all", () => {
    render(<Host />);
    const health = screen.getAllByRole("columnheader").find((h) => h.textContent === "Health");
    expect(health).toBeTruthy();
    expect(health?.querySelector("button")).toBeNull();
    expect(health?.hasAttribute("aria-sort")).toBe(false);
  });
});

/**
 * Since foundation v4 a node joins the tailnet as `<fleet id>-<agent>`
 * (`cloudName`, `format.ts`). The table's hostname cell has to carry the
 * fleet's id for that prefix, not just the agent's name — otherwise a freshly
 * created agent with no `tailscale_dns_name` yet renders a bare spelling
 * nobody holds.
 */
describe("FleetTable · the fleet-prefixed cloud hostname", () => {
  test("with no reported dns name, the hostname cell shows the fleet-prefixed canonical spelling", () => {
    render(
      <FleetTable
        agents={[agent("solo")]}
        latest="1.2.0"
        tailnet="hermetic.ts.net"
        fleetId="k7m2x9qa"
        fresh={new Set()}
        volumes={[]}
        showDestroyed={false}
        selected={null}
        sort={null}
        onSort={() => {}}
        onSelect={() => {}}
        onCreateOnVolume={() => {}}
        onSeeVolumes={() => {}}
      />,
    );
    expect(document.querySelector(".cell-ts .h")?.textContent).toBe("k7m2x9qa-solo.hermetic.ts.net");
  });
});
