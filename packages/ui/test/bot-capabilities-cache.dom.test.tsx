/**
 * `useBotCapabilities`'s browser-side memo (`bot-capabilities.ts`).
 *
 * The hook already shared a sweep that was still in flight. What it did not do
 * was remember one that had *landed*: closing and reopening Bot Chat, or moving
 * between two bots on the same box and back, re-ran three gateway calls for an
 * answer the browser had had a second earlier. These tests are about the three
 * rules that memo has to keep:
 *
 * - a remount inside the TTL costs no probe at all;
 * - a sweep carrying an `unknown` is **never** remembered, because the retry it
 *   offers has to genuinely re-ask (design.md §9);
 * - `reload` bypasses the memo, for the same reason.
 *
 * Driven through a component of its own rather than through a pane, because
 * what is under test is the hook's caching and nothing about how a gate is
 * drawn. Calls are stubbed at the transport (`fake-transport.ts`); an unmatched name
 * throws, so a probe nobody expected fails here rather than passing quietly.
 * Each test uses its own instance name — the memo is module state, shared by
 * every test in this process.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { act, cleanup, render, screen, waitFor } from "./dom.ts";
import { resetBotCapabilityMemo, useBotCapabilities } from "../src/chat/bot-capabilities.ts";
import { setFleetTarget } from "../src/api/index.ts";
import { FAKE_TARGET, fakeServer } from "./fake-transport.ts";
import type { FakeServer, TransportCall } from "./fake-transport.ts";

afterEach(cleanup);
afterEach(resetBotCapabilityMemo);

const CAPS = "bots.capabilities";

type Flag = "profiles" | "routines" | "hosted_rooms" | "room_driver";
type Status = "supported" | "refused" | "unknown";

function capsOf(instance: string, status: Partial<Record<Flag, Status>> = {}) {
  return {
    instance,
    profiles: true,
    routines: true,
    hosted_rooms: true,
    room_driver: true,
    room_methods: [],
    protocol_version: 2,
    room_features: [],
    membership_edit: false,
    cross_instance_rooms: false,
    cross_instance_relay: false,
    reason: null,
    detail: { profiles: null, routines: null, hosted_rooms: null, room_driver: null },
    status: {
      profiles: "supported",
      routines: "supported",
      hosted_rooms: "supported",
      room_driver: "supported",
      ...status,
    },
  };
}

/** The hook, with nothing else on screen: its state, and a button that reloads. */
function Probe({ instance }: { instance: string }): ReactElement {
  const { caps, loading, reload } = useBotCapabilities(instance);
  return (
    <div>
      <span data-testid="verdict">{loading ? "reading" : (caps?.status.routines ?? "none")}</span>
      <button type="button" onClick={reload}>
        retry
      </button>
    </div>
  );
}

/**
 * Unmount, let the microtask queue drain, then mount again.
 *
 * The drain is the point. `release` defers its abort by one microtask so that a
 * remount in the *same* turn reclaims the in-flight sweep — StrictMode, a
 * changing `key` — and a test that skipped the drain would be exercising that
 * grace rather than the memo. This is the other case: the previous mount is
 * genuinely gone before the new one asks.
 */
async function remount(previous: { unmount(): void }, node: ReactElement): Promise<void> {
  previous.unmount();
  await act(async () => {
    await Promise.resolve();
  });
  render(node);
}

const answerFor = (fleet: string): Status => (fleet === "one" ? "supported" : "refused");

async function settled(expected: string): Promise<void> {
  await waitFor(() => expect(screen.getByTestId("verdict").textContent).toBe(expected));
}

describe("capability memo", () => {
  let server: FakeServer | null = null;
  afterEach(() => {
    server?.restore();
    server = null;
  });

  test("a remount inside the TTL costs no second probe", async () => {
    const instance = "memo-hit";
    server = fakeServer({ [CAPS]: () => capsOf(instance) });
    const first = render(<Probe instance={instance} />);
    await settled("supported");
    expect(server.to(CAPS)).toHaveLength(1);

    await remount(first, <Probe instance={instance} />);
    await settled("supported");
    // Still one: the answer was replayed, not re-asked — and the previous mount
    // was fully released first, so this is the memo rather than the in-flight
    // sweep's remount grace.
    expect(server.to(CAPS)).toHaveLength(1);
  });

  test("an unknown is never remembered", async () => {
    const instance = "memo-unknown";
    server = fakeServer({ [CAPS]: () => capsOf(instance, { routines: "unknown" }) });
    const first = render(<Probe instance={instance} />);
    await settled("unknown");
    expect(server.to(CAPS)).toHaveLength(1);

    await remount(first, <Probe instance={instance} />);
    await settled("unknown");
    // Two probes: an undetermined answer is a question still open, and the
    // retry the pane offers would be a lie if the browser replayed the guess.
    expect(server.to(CAPS)).toHaveLength(2);
  });

  test("a refusal is remembered — it is a settled answer", async () => {
    const instance = "memo-refused";
    server = fakeServer({ [CAPS]: () => capsOf(instance, { routines: "refused" }) });
    const first = render(<Probe instance={instance} />);
    await settled("refused");
    await remount(first, <Probe instance={instance} />);
    await settled("refused");
    expect(server.to(CAPS)).toHaveLength(1);
  });

  test("reload re-probes past the memo", async () => {
    const instance = "memo-reload";
    let answer: Status = "supported";
    server = fakeServer({ [CAPS]: () => capsOf(instance, { routines: answer }) });
    render(<Probe instance={instance} />);
    await settled("supported");
    expect(server.to(CAPS)).toHaveLength(1);

    answer = "refused";
    await act(async () => {
      screen.getByRole("button", { name: "retry" }).click();
    });
    await settled("refused");
    expect(server.to(CAPS)).toHaveLength(2);
  });

  test("a fleet switch re-probes rather than replaying the departing fleet", async () => {
    // Same instance name in both fleets, which is legal: a name is unique
    // within a fleet, and the memo is keyed the way the core keys its own.
    const instance = "memo-fleets";
    let fleet = "one";
    server = fakeServer({ [CAPS]: () => capsOf(instance, { routines: answerFor(fleet) }) });
    const first = render(<Probe instance={instance} />);
    await settled("supported");
    expect(server.to(CAPS)).toHaveLength(1);

    fleet = "two";
    setFleetTarget({ ...FAKE_TARGET, fleet_id: "sg7k2m4p" });
    await remount(first, <Probe instance={instance} />);
    await settled("refused");
    expect(server.to(CAPS)).toHaveLength(2);

    // And back: the first fleet's answer is still its own, still cached.
    fleet = "one";
    setFleetTarget({ ...FAKE_TARGET });
    cleanup();
    await act(async () => {
      await Promise.resolve();
    });
    render(<Probe instance={instance} />);
    await settled("supported");
    expect(server.to(CAPS)).toHaveLength(2);
  });

  test("two instances keep their own answers", async () => {
    const one = "memo-a";
    const two = "memo-b";
    server = fakeServer({
      [CAPS]: (call: TransportCall) => {
        const asked = (call.params as { instance: string }).instance;
        return capsOf(asked, { routines: asked === one ? "supported" : "refused" });
      },
    });
    const first = render(<Probe instance={one} />);
    await settled("supported");
    await remount(first, <Probe instance={two} />);
    await settled("refused");
    expect(server.to(CAPS)).toHaveLength(2);
  });
});
