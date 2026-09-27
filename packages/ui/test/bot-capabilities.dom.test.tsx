/**
 * Capability certainty, as the portal renders it.
 *
 * `bots.capabilities` reports a boolean *and* a status, and the whole point of
 * the status is that two different `false`s want two different sentences. These
 * tests are about the distinction rather than about layout:
 *
 * **A refusal is a settled answer.** The gateway answered; the pane says what it
 * said — including "unauthorized", which is a different fix from "too old" — and
 * offers no retry, because asking again cannot change a decision the gateway has
 * already made.
 *
 * **An unknown is not an absence.** Nothing on screen may read as "this gateway
 * does not have it", and a retry is offered, because the core deliberately does
 * not memoize a sweep carrying an unknown and so genuinely re-probes.
 *
 * **A Hermetic gate is neither.** Cross-instance rooms and membership editing
 * are held back by this repo, not refused by any gateway, and must never borrow
 * the gateway's words.
 *
 * Calls are stubbed at the transport (`fake-transport.ts`), the way the rest of this
 * suite fakes a server; an unmatched route throws, so a gated pane that reached
 * for `routines.list` anyway would fail here rather than quietly pass.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "./dom.ts";
import type { SwarmView } from "../src/api/index.ts";
import { ScheduledJobs } from "../src/chat/components/ScheduledJobs.tsx";
import { RoomCreateDialog } from "../src/chat/components/BotModeCreate.tsx";
import { resetBotCapabilityMemo } from "../src/chat/bot-capabilities.ts";
import { fakeServer } from "./fake-transport.ts";
import type { FakeServer } from "./fake-transport.ts";

afterEach(cleanup);
// The hook remembers a settled sweep for 30 s (`bot-capabilities.ts`), and
// every case here probes the same instance with a different answer.
afterEach(resetBotCapabilityMemo);
// The avatar entrance tween is left to run here. It used to be skipped by a
// module-scope `document.hidden` patch, and `setup.ts` owns that property now
// — owning it means `visibilityState` agrees with it, so a hidden page also
// stops the roster read every test below is built on. Measured both ways: the
// file is green and no slower with the tween left alone.

const INSTANCE = "atlas";
const CAPS = "bots.capabilities";
const JOBS = "routines.list";

type Flag = "profiles" | "routines" | "hosted_rooms" | "room_driver";
type Status = "supported" | "refused" | "unknown";

/** A sweep where everything answered, as the override base for each case. */
function capsOf(over: {
  flags?: Partial<Record<Flag, boolean>>;
  status?: Partial<Record<Flag, Status>>;
  detail?: Partial<Record<Flag, string | null>>;
  protocol_version?: number | null;
}) {
  return {
    instance: INSTANCE,
    profiles: true,
    routines: true,
    hosted_rooms: true,
    room_driver: true,
    ...over.flags,
    room_methods: [],
    protocol_version: over.protocol_version ?? 2,
    room_features: [],
    membership_edit: false,
    cross_instance_rooms: false,
    cross_instance_relay: false,
    reason: null,
    detail: {
      profiles: null,
      routines: null,
      hosted_rooms: null,
      room_driver: null,
      ...over.detail,
    },
    status: {
      profiles: "supported",
      routines: "supported",
      hosted_rooms: "supported",
      room_driver: "supported",
      ...over.status,
    },
  };
}

const SWARMS: SwarmView[] = [
  {
    instance: INSTANCE,
    reachable: true,
    unreachable_reason: null,
    sections: [],
    bots: [],
    rooms: [],
  } as unknown as SwarmView,
];

function jobsPane() {
  return screen.getByLabelText("Scheduled jobs");
}

/**
 * Retry affordances on screen, counted rather than handed back. A failed
 * assertion on a React element serialises its whole fiber — megabytes of test
 * output for one wrong answer — and a number says exactly as much.
 */
function retryButtons(): number {
  return screen.queryAllByRole("button", { name: "Retry" }).length;
}

describe("capability certainty in the portal", () => {
  let server: FakeServer | null = null;
  afterEach(() => {
    server?.restore();
    server = null;
  });

  test("a refused routine registry says unauthorized and offers no retry", async () => {
    server = fakeServer({
      [CAPS]: capsOf({
        flags: { routines: false },
        status: { routines: "refused" },
        detail: {
          routines: "The routine registry is unauthorized for this session: scope was denied",
        },
      }),
    });
    render(<ScheduledJobs instance={INSTANCE} bot="default" title="Atlas" fleetId="fxtr0001" />);
    await waitFor(() => expect(jobsPane().textContent).toContain("unauthorized"));
    expect(retryButtons()).toBe(0);
    // A settled refusal is not a reason to call the endpoint anyway.
    expect(server.to(JOBS).length).toBe(0);
    // Both entry points — the header "+" and the wide button — carry the reason.
    const add = screen.getAllByRole("button", { name: /^Add scheduled job — unavailable\./ });
    expect(add.length).toBe(2);
    for (const button of add) {
      expect(button.hasAttribute("disabled")).toBe(true);
      expect(button.getAttribute("aria-label")).toContain("unauthorized");
    }
  });

  test("an undetermined routine registry is not reported as unsupported", async () => {
    server = fakeServer({
      [CAPS]: capsOf({
        flags: { routines: false },
        status: { routines: "unknown" },
        detail: { routines: "The routine registry could not be determined: gateway returned 500" },
      }),
    });
    render(<ScheduledJobs instance={INSTANCE} bot="default" title="Atlas" fleetId="fxtr0001" />);
    await waitFor(() => expect(jobsPane().textContent).toContain("could not be determined"));
    const said = jobsPane().textContent ?? "";
    expect(said).not.toMatch(/unsupported/i);
    expect(said).not.toMatch(/not supported/i);
    expect(said).not.toMatch(/is not available/i);
  });

  test("an undetermined capability offers a retry that re-probes", async () => {
    server = fakeServer({
      [CAPS]: capsOf({
        flags: { routines: false },
        status: { routines: "unknown" },
        detail: { routines: "The routine registry could not be determined: gateway returned 500" },
      }),
    });
    render(<ScheduledJobs instance={INSTANCE} bot="default" title="Atlas" fleetId="fxtr0001" />);
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(server.to(CAPS).length).toBe(1);
    fireEvent.click(retry);
    // The core does not memoize a sweep carrying an unknown, so this is a real
    // second probe rather than a replay of the first answer.
    await waitFor(() => expect(server?.to(CAPS).length).toBe(2));
  });

  test("a remount of the same instance reclaims the in-flight sweep instead of aborting it", async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server = fakeServer({
      [CAPS]: async () => {
        await held;
        return capsOf({});
      },
    });
    const pane = (bot: string) => (
      <ScheduledJobs instance={INSTANCE} bot={bot} title="Atlas" fleetId="fxtr0001" />
    );
    const first = render(pane("default"));
    await waitFor(() => expect(server?.to(CAPS).length).toBe(1));
    first.unmount();
    render(pane("scribe"));
    // The jobs pane remounts per bot (`key={instance/bot}`), but the probe is
    // per instance. Aborting here is what painted `(canceled)` on every Bot
    // Chat open: the sweep is not cached, so the next mount repeats three
    // gateway RPCs from scratch.
    expect(server.to(CAPS).length).toBe(1);
    release?.();
    await waitFor(() => expect(jobsPane().textContent).toContain("no routines"));
    expect(server.to(CAPS).length).toBe(1);
  });

  test("StrictMode's second mount does not start a second probe", async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server = fakeServer({
      [CAPS]: async () => {
        await held;
        return capsOf({});
      },
    });
    render(
      <StrictMode>
        <ScheduledJobs instance={INSTANCE} bot="default" title="Atlas" fleetId="fxtr0001" />
      </StrictMode>,
    );
    await waitFor(() => expect(server?.to(CAPS).length).toBe(1));
    release?.();
    await waitFor(() => expect(jobsPane().textContent).toContain("no routines"));
    expect(server.to(CAPS).length).toBe(1);
  });

  test("a refused hosted-room protocol names the version the gateway reported", async () => {
    server = fakeServer({
      [CAPS]: capsOf({
        flags: { hosted_rooms: false, room_driver: false },
        status: { hosted_rooms: "refused", room_driver: "refused" },
        detail: {
          hosted_rooms: "This gateway speaks hosted-room protocol version 1; version 2 is required",
          room_driver: "This gateway speaks hosted-room protocol version 1; version 2 is required",
        },
        protocol_version: 1,
      }),
    });
    render(
      <RoomCreateDialog
        swarms={SWARMS}
        initialInstance={INSTANCE}
        onClose={() => {}}
        onSubmit={async () => {}}
      />,
    );
    const dialog = screen.getByRole("dialog");
    await waitFor(() => expect(dialog.textContent).toContain("protocol version 1"));
    expect(dialog.textContent).toContain("version 2 is required");
    expect(retryButtons()).toBe(0);
    const create = screen.getByRole("button", { name: /^Create room — unavailable\./ });
    expect(create.hasAttribute("disabled")).toBe(true);
    expect(create.getAttribute("aria-label")).toContain("protocol version 1");
  });

  test("a Hermetic gate reads as this repo's decision, not a gateway refusal", async () => {
    server = fakeServer({ [CAPS]: capsOf({}) });
    render(
      <RoomCreateDialog
        swarms={SWARMS}
        initialInstance={INSTANCE}
        onClose={() => {}}
        onSubmit={async () => {}}
      />,
    );
    const dialog = screen.getByRole("dialog");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Create room" }).hasAttribute("disabled")).toBe(false),
    );
    const said = dialog.textContent ?? "";
    expect(said).toContain("Gated in Hermetic");
    expect(said).toContain("Rooms that span instances are gated in Hermetic");
    expect(said).toContain("Editing the members of an existing room is gated in Hermetic");
    // Neither a gateway verdict nor an undetermined probe: no refusal wording,
    // and nothing to retry.
    expect(said).not.toMatch(/unauthorized/i);
    expect(said).not.toMatch(/could not be determined/i);
    expect(retryButtons()).toBe(0);
  });
});
