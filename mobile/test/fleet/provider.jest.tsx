/**
 * `FleetProvider` over the fixture kit's network and chat, with the OS
 * (notifications, AppState, background refresh) as doubles: pairing, push
 * registration following listening, the AppState linger, taps, sign out.
 */
import { act, render } from "@testing-library/react-native";
import type { Alert } from "../../src/client/client.ts";
import { type FixtureKit, fixtureKit } from "../../src/fixture/index.ts";
import type { NoteContent, Notifier } from "../../src/fleet/alerts.ts";
import {
  type FleetContextValue,
  type FleetDeps,
  FleetProvider,
  PREVIEWS_KEY,
  PUSH_KEY,
  useFleetContext,
} from "../../src/fleet/FleetProvider.tsx";
import { readPairingLink } from "../../src/fleet/pairing.ts";
import { hermeticdRegistrar } from "../../src/fleet/push.ts";
import { memoryFile, memoryKv } from "../../src/fleet/store.ts";
import { flush } from "../helpers/fakes.ts";

const NOW = "2026-10-13T10:00:00.000Z";

function fakeNotifier() {
  let decide: ((content: NoteContent, local: boolean) => boolean) | null = null;
  let tap: ((content: NoteContent) => void) | null = null;
  const badges: number[] = [];
  const locals: Alert[] = [];
  const presented: NoteContent[] = [];
  const notifier: Notifier = {
    registerCategories: async () => {},
    setForegroundHandler: (fn) => {
      decide = fn;
    },
    onTap: (fn) => {
      tap = fn;
      return () => {
        tap = null;
      };
    },
    presented: async () => presented.splice(0),
    presentLocal: async (alert) => {
      locals.push(alert);
    },
    setBadge: async (n) => {
      badges.push(n);
    },
    pushToken: async () => ({ ok: true, token: "ExponentPushToken[FIXTURE-provider]" }),
  };
  return {
    notifier,
    badges,
    locals,
    presented,
    decide: (content: NoteContent, local = false) => decide?.(content, local),
    tap: (content: NoteContent) => tap?.(content),
  };
}

function fakeAppState(initial = "active") {
  let state = initial;
  const listeners = new Set<(s: string) => void>();
  return {
    current: () => state,
    subscribe: (fn: (s: string) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    set: (next: string) => {
      state = next;
      for (const fn of [...listeners]) fn(next);
    },
  };
}

async function settle() {
  for (let i = 0; i < 20; i++) await act(flush);
}

/** Real time, for the fixture's paced turn. */
async function waitFor(ok: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await act(() => new Promise<void>((r) => setTimeout(r, 25)));
  }
}

async function setup(seed: Record<string, string> = {}, clock: () => string = () => NOW) {
  const kit = fixtureKit("1", clock) as FixtureKit;
  const note = fakeNotifier();
  const appState = fakeAppState();
  const secure = memoryKv(seed);
  const background = { register: jest.fn(async () => {}), unregister: jest.fn(async () => {}) };
  const deps: FleetDeps = {
    secure,
    viewCache: memoryFile(),
    inboxFile: memoryFile(),
    fetch: kit.fetch,
    openSocket: () => {
      throw new Error("no socket in fixture mode");
    },
    chat: kit.chat,
    notifier: note.notifier,
    registrar: hermeticdRegistrar(kit.fetch),
    background,
    appState,
    platform: "ios",
    appVersion: "0.1.0",
    operatorTailnet: null,
    fixture: { link: kit.link, tailscale: kit.tailscale },
    now: clock,
    lingerMs: 1_000,
  };
  const opened: string[] = [];
  const ctx: { current: FleetContextValue | null } = { current: null };
  function Probe() {
    ctx.current = useFleetContext();
    return null;
  }
  await render(
    <FleetProvider deps={deps} onOpen={(href) => opened.push(href)}>
      <Probe />
    </FleetProvider>,
  );
  const value = () => {
    if (!ctx.current) throw new Error("not rendered");
    return ctx.current;
  };
  const link = () => {
    const read = readPairingLink(kit.link);
    if (!read.ok) throw new Error(read.error.title);
    return read.link;
  };
  return { kit, note, appState, secure, background, opened, value, link };
}

const ATLAS = "fxtr0001-atlas.hermetic.ts.net";
const JUNIPER = "fxtr0001-juniper.hermetic.ts.net";

describe("FleetProvider", () => {
  test("no pairing: unpaired; pairing connects, refreshes the fleet and probes Tailscale", async () => {
    const s = await setup();
    await settle();
    expect(s.value().status).toBe("unpaired");
    expect(s.value().client).toBeNull();
    await act(() => s.value().pair(s.link()));
    await settle();
    expect(s.value().status).toBe("paired");
    expect(s.value().client).not.toBeNull();
    expect(s.value().fleet.getState().view?.agents).toHaveLength(11);
    expect(s.value().tailscale?.status).toBe("ok");
    expect(s.background.register).toHaveBeenCalled();
    expect(s.value().fixture?.link).toBe(s.kit.link);
  });

  test("a stored pairing is restored on boot", async () => {
    const first = await setup();
    await settle();
    await act(() => first.value().pair(first.link()));
    await settle();
    const stored = Object.fromEntries((first.secure as ReturnType<typeof memoryKv>).map);
    const second = await setup(stored);
    await settle();
    expect(second.value().status).toBe("paired");
    expect(second.value().fleet.getState().link?.label).toBe("main");
  });

  test("push: enabling registers with listened boxes; a listening change follows; sign out unregisters", async () => {
    const s = await setup();
    await settle();
    await act(() => s.value().pair(s.link()));
    await settle();
    await act(async () => {
      await s.value().setPushEnabled(true);
    });
    await settle();
    expect(s.value().push.state).toBe("on");
    await expect(s.secure.get(PUSH_KEY)).resolves.toBe("on");
    expect(s.kit.registry.devicesOn(ATLAS)).toHaveLength(1);
    // A stopped agent is not listened by default, so it holds nothing.
    expect(s.kit.registry.devicesOn(JUNIPER)).toHaveLength(0);

    await act(async () => {
      await s.value().fleet.setListening("atlas", false);
    });
    await settle();
    expect(s.kit.registry.devicesOn(ATLAS)).toHaveLength(0);
    await act(async () => {
      await s.value().fleet.setListening("juniper", true);
    });
    await settle();
    expect(s.kit.registry.devicesOn(JUNIPER)).toHaveLength(1);

    await act(() => s.value().signOut());
    await settle();
    expect(s.value().status).toBe("unpaired");
    expect([...s.kit.registry.boxes.values()].every((box) => box.size === 0)).toBe(true);
    expect(s.background.unregister).toHaveBeenCalled();
    expect(s.note.badges.at(-1)).toBe(0);
  });

  test("background: alerts go local at once, and the phase settles after the linger", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick", "queueMicrotask"] });
    try {
      const s = await setup();
      await settle();
      await act(() => s.value().pair(s.link()));
      await settle();
      const client = s.value().client;
      if (!client) throw new Error("no client");
      const phases: string[] = [];
      const setPhase = client.setPhase.bind(client);
      (client as { setPhase: (p: Parameters<typeof setPhase>[0]) => void }).setPhase = (p) => {
        phases.push(p);
        setPhase(p);
      };
      await act(async () => s.appState.set("background"));
      expect(phases).toEqual(["inactive"]);
      await act(async () => jest.advanceTimersByTime(1_000));
      expect(phases).toEqual(["inactive", "background"]);
      await act(async () => s.appState.set("active"));
      expect(phases.at(-1)).toBe("active");
    } finally {
      jest.useRealTimers();
    }
  });

  test("foreground: pushes delivered while away are filed, and the badge follows", async () => {
    const s = await setup();
    await settle();
    await act(() => s.value().pair(s.link()));
    await settle();
    s.note.presented.push({
      title: "scribe · atlas",
      body: "done",
      data: {
        fleet_id: "fxtr0001",
        instance: "atlas",
        bot: "scribe",
        session: "s-1",
        kind: "turn.done",
        dedupe: "atlas:s-1:4:turn.done",
      },
    });
    await act(async () => s.appState.set("active"));
    await settle();
    expect(s.value().client?.inbox.getState().entries).toHaveLength(1);
    expect(s.note.badges.at(-1)).toBe(1);
    // The same push arriving in the foreground now is dropped by the handler.
    expect(
      s.note.decide({
        data: {
          fleet_id: "fxtr0001",
          instance: "atlas",
          bot: "scribe",
          session: "s-1",
          kind: "turn.done",
          dedupe: "atlas:s-1:4:turn.done",
        },
      }),
    ).toBe(false);
  });

  test("foreground: a push read late folds with the entry the linger raised, by its delivery time", async () => {
    let now = NOW;
    const s = await setup({}, () => now);
    await settle();
    await act(() => s.value().pair(s.link()));
    await settle();
    const inbox = s.value().client?.inbox;
    if (!inbox) throw new Error("no client");
    const before = inbox.getState().entries.length;
    // The phone's socket saw the turn finish during the background linger.
    inbox.ingest({
      kind: "turn.done",
      instance: "atlas",
      bot: "scribe",
      session: "s-1",
      title: "scribe · atlas",
      body: "done",
      at: NOW,
      dedupe: "atlas:s-1:phone-t1:turn.done",
    });
    // The box's push for the same event, delivered 30 s later, is read ten minutes on.
    now = "2026-10-13T10:10:00.000Z";
    s.note.presented.push({
      title: "scribe · atlas",
      body: "done",
      date: Date.parse("2026-10-13T10:00:30.000Z"),
      data: {
        fleet_id: "fxtr0001",
        instance: "atlas",
        bot: "scribe",
        session: "s-1",
        kind: "turn.done",
        dedupe: "atlas:s-1:4:turn.done",
      },
    });
    await act(async () => s.appState.set("active"));
    await settle();
    expect(inbox.getState().entries).toHaveLength(before + 1);
  });

  test("a tapped push opens its conversation", async () => {
    const s = await setup();
    await settle();
    await act(() => s.value().pair(s.link()));
    await settle();
    await act(async () =>
      s.note.tap({
        data: {
          fleet_id: "fxtr0001",
          instance: "corvid",
          bot: "pilot",
          session: "s-9",
          kind: "needs_action",
          dedupe: "corvid:s-9:2:needs_action",
        },
      }),
    );
    expect(s.opened).toEqual(["/chat/corvid/pilot?session=s-9"]);
    expect(s.value().client?.inbox.getState().needsAction).toBe(1);
  });

  test("a tap before the pairing loads opens once the client is up", async () => {
    const first = await setup();
    await settle();
    await act(() => first.value().pair(first.link()));
    await settle();
    const stored = Object.fromEntries((first.secure as ReturnType<typeof memoryKv>).map);
    const s = await setup(stored);
    // Before the boot finished: no client yet.
    await act(async () => s.note.tap({ data: { not: "ours" } }));
    await settle();
    expect(s.opened).toEqual(["/inbox"]);
  });

  test("fixture: switching Tailscale off re-probes, and the status follows", async () => {
    const s = await setup();
    await settle();
    await act(() => s.value().pair(s.link()));
    await settle();
    await act(async () => s.value().fixture?.setTailscale("off"));
    await settle();
    expect(s.value().tailscale?.status).toBe("off");
    await act(async () => s.value().fixture?.setTailscale("unreachable"));
    await settle();
    expect(s.value().tailscale?.status).toBe("unreachable");
  });

  test("backgrounded with push on: the box's push is the one alert, no local duplicate", async () => {
    // The fixture stamps its rows with the wall clock; the store matches the turn against it.
    const s = await setup({}, () => new Date().toISOString());
    await settle();
    await act(() => s.value().pair(s.link()));
    await settle();
    await act(async () => {
      await s.value().setPushEnabled(true);
    });
    await settle();
    expect(s.kit.registry.devicesOn(ATLAS)).toHaveLength(1);
    const client = s.value().client;
    if (!client) throw new Error("no client");
    // Away from the screen but inside the linger (the sockets still live).
    await act(async () => s.appState.set("inactive"));
    const target = { instance: "atlas", bot: "scribe", session: null };
    await act(async () => client.chat.open(target));
    await waitFor(() => client.chat.view(target).history === "ready");
    await act(async () => {
      client.chat.send(target, "FIXTURE background turn");
    });
    await waitFor(() => client.inbox.getState().entries.some((e) => e.kind === "turn.done"));
    // Filed in the inbox, but not drawn: atlas pushes the same event itself.
    expect(s.note.locals).toHaveLength(0);
  }, 20_000);

  test("backgrounded with push off: this phone alerts locally", async () => {
    const s = await setup({}, () => new Date().toISOString());
    await settle();
    await act(() => s.value().pair(s.link()));
    await settle();
    const client = s.value().client;
    if (!client) throw new Error("no client");
    // Away from the screen but inside the linger (the sockets still live).
    await act(async () => s.appState.set("inactive"));
    const target = { instance: "atlas", bot: "scribe", session: null };
    await act(async () => client.chat.open(target));
    await waitFor(() => client.chat.view(target).history === "ready");
    await act(async () => {
      client.chat.send(target, "FIXTURE background turn");
    });
    await waitFor(() => s.note.locals.length > 0);
    expect(s.note.locals[0]).toMatchObject({ decision: "local", data: { instance: "atlas" } });
  }, 20_000);

  test("previews: off by default, sent in every registration, and a change re-registers", async () => {
    const s = await setup();
    await settle();
    await act(() => s.value().pair(s.link()));
    await settle();
    expect(s.value().previews).toBe(false);
    await act(async () => {
      await s.value().setPushEnabled(true);
    });
    await settle();
    expect(s.kit.registry.devicesOn(ATLAS)[0]?.previews).toBe(false);
    await act(() => s.value().setPreviews(true));
    await settle();
    expect(s.kit.registry.devicesOn(ATLAS)[0]?.previews).toBe(true);
    await expect(s.secure.get(PREVIEWS_KEY)).resolves.toBe("true");
  });

  test("back from the background, the focused conversation is re-opened", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick", "queueMicrotask"] });
    try {
      const s = await setup();
      await settle();
      await act(() => s.value().pair(s.link()));
      await settle();
      const client = s.value().client;
      if (!client) throw new Error("no client");
      const reopened: unknown[] = [];
      const reopen = client.chat.reopen.bind(client.chat);
      client.chat.reopen = (t) => {
        reopened.push(t);
        reopen(t);
      };
      const target = { instance: "atlas", bot: "scribe", session: null };
      await act(async () => s.value().focusConversation(target));
      // Back before the linger ran out: the sockets never detached, nothing to re-open.
      await act(async () => s.appState.set("background"));
      await act(async () => s.appState.set("active"));
      expect(reopened).toEqual([]);
      await act(async () => s.appState.set("background"));
      await act(async () => jest.advanceTimersByTime(1_000));
      await act(async () => s.appState.set("active"));
      expect(reopened).toEqual([target]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a push for another fleet is not filed", async () => {
    const s = await setup();
    await settle();
    await act(() => s.value().pair(s.link()));
    await settle();
    s.note.presented.push({
      title: "scribe · atlas",
      body: "done",
      data: {
        fleet_id: "sg7k2m4p",
        instance: "atlas",
        bot: "scribe",
        session: "s-1",
        kind: "turn.done",
        dedupe: "atlas:s-1:4:turn.done",
      },
    });
    await act(async () => s.appState.set("active"));
    await settle();
    expect(s.value().client?.inbox.getState().entries).toHaveLength(0);
  });
});
