/**
 * `core/src/desktop.ts` (§7.4): the two things Hermes Desktop's remote-gateway
 * form needs, and the three rules behind them.
 *
 * - **Where the box is** is the rule `chat.ts` and `probe.ts` already hold: the
 *   row's real tailnet name wins over the canonical spelling, because a box
 *   readmitted as `<name>-2` answers on nothing else. A third implementation of
 *   that rule is exactly how the drift starts, so `corvid` is asserted here too.
 * - **The token is scraped, never remembered.** It dies with the box's
 *   dashboard process, so a second call must ask the box a second time — a
 *   cached answer would print a token that stopped working at the last reboot.
 * - **A box that does not answer fails as a box that does not answer**, with
 *   the adapter's own `CHAT_UNREACHABLE`, rather than as an empty string a head
 *   would render as a blank field.
 *
 * No network: the adapter is a double, and the fixture client is asserted to
 * give the same shape.
 */
import { describe, expect, test } from "bun:test";
import { createDesktop } from "../src/agents/desktop.ts";
import type { DesktopDeps } from "../src/agents/desktop.ts";
import { CHAT_ERROR_CODES } from "../src/chat/hermes/hermes-chat.ts";
import type { BoxAddress, HermesChatClient } from "../src/chat/hermes/hermes-chat.ts";
import { HermeticError } from "../src/errors.ts";
import { fixtureChatClient, fixtureSessionToken } from "../src/backend/fixture/fixture-chat.ts";
import { FIXTURE_CONFIG, MemoryBackend, seedFixtureFleet } from "../src/backend/memory.ts";
import type { StackInfo } from "../src/backend/types.ts";
import type { Agent } from "../src/schema/index.ts";

const backend = seedFixtureFleet(new MemoryBackend());
const agents = await backend.store.agents.scan();
const seeded = await backend.store.fleet.get();
if (seeded === null) throw new Error("the fixture seed writes a fleet item");
const fleetItem = seeded;

function agentNamed(name: string): Agent {
  const found = agents.find((a) => a.name === name);
  if (found === undefined) throw new Error(`the fixture has no agent ${name}`);
  return found;
}

/** Every address the double was asked for a token at, in order. */
function harness(
  client: Partial<HermesChatClient> = {},
  deps: Partial<DesktopDeps> = {},
): { desktop: ReturnType<typeof createDesktop>; asked: BoxAddress[] } {
  const asked: BoxAddress[] = [];
  const hermes: HermesChatClient = {
    token: (box) => {
      asked.push(box);
      return Promise.resolve(`token-${asked.length}`);
    },
    swarm: () => Promise.reject(new Error("the desktop surface reads no roster")),
    sessions: () => Promise.resolve([]),
    history: () => Promise.resolve([]),
    send: () => (async function* () {})(),
    abort: () => Promise.resolve(),
    ...client,
  };
  return {
    desktop: createDesktop({
      guardFleet: () =>
        Promise.resolve({ config: FIXTURE_CONFIG, fleet: fleetItem, stack: {} as StackInfo }),
      getAgent: (name: string) => Promise.resolve(agentNamed(name)),
      hermes,
      ...deps,
    }),
    asked,
  };
}

describe("agents.desktop", () => {
  test("answers with the Serve URL and the box's current token", async () => {
    const { desktop, asked } = harness();
    const attach = await desktop.attach({ name: "atlas" });

    expect(attach).toEqual({
      instance: "atlas",
      url: "https://fxtr0001-atlas.hermetic.ts.net/",
      token: "token-1",
      rotates: true,
    });
    // The address the token was scraped from is the address the operator is
    // told to paste: one resolution, not two that could disagree.
    expect(asked[0]?.baseUrl).toBe(attach.url);
    expect(asked[0]?.fleet_id).toBe(fleetItem.fleet_id);
  });

  test("uses the name the node actually answers on, not the canonical one", async () => {
    // `corvid` came back as `fxtr0001-corvid-2`: the device cleanup for its
    // predecessor did not run, so MagicDNS still points the canonical name at a
    // terminated box. A token scraped there would be a token for a corpse.
    const { desktop } = harness();
    const attach = await desktop.attach({ name: "corvid" });
    expect(attach.url).toBe("https://fxtr0001-corvid-2.hermetic.ts.net/");
  });

  test("falls back to the canonical spelling for a box that never reported one", async () => {
    // `juniper` is stopped and has no `tailscale_dns_name`. The answer is still
    // an address rather than a refusal: the operator may be about to start it.
    const { desktop } = harness();
    const attach = await desktop.attach({ name: "juniper" });
    expect(attach.url).toBe("https://fxtr0001-juniper.hermetic.ts.net/");
  });

  test("asks the box again on every call", async () => {
    const { desktop, asked } = harness();
    const first = await desktop.attach({ name: "atlas" });
    const second = await desktop.attach({ name: "atlas" });

    expect(asked).toHaveLength(2);
    // Different values from the double, so a cached answer could not pass:
    // the token dies with the dashboard process and a remembered one is a
    // token that stopped working at the last reboot.
    expect(first.token).toBe("token-1");
    expect(second.token).toBe("token-2");
  });

  test("a box that does not answer fails as unreachable", async () => {
    const { desktop } = harness({
      token: () =>
        Promise.reject(
          new HermeticError(CHAT_ERROR_CODES.UNREACHABLE, "atlas: dashboard did not answer"),
        ),
    });
    await expect(desktop.attach({ name: "atlas" })).rejects.toMatchObject({
      code: CHAT_ERROR_CODES.UNREACHABLE,
    });
  });

  test("an illegal name is refused before anything is asked", async () => {
    const { desktop, asked } = harness();
    await expect(desktop.attach({ name: "_fleet" })).rejects.toBeInstanceOf(HermeticError);
    expect(asked).toHaveLength(0);
  });

  test("the fixture client answers with a sentinel token per box", async () => {
    const { desktop } = harness({}, { hermes: fixtureChatClient() });
    const attach = await desktop.attach({ name: "atlas" });

    expect(attach.token).toBe(fixtureSessionToken("atlas"));
    // §8.3: a fixture credential is a `FIXTURE` sentinel and nothing that could
    // be mistaken for a real `secrets.token_urlsafe(32)`.
    expect(attach.token).toContain("FIXTURE");
  });

  test("the fixture client refuses a box the fixture calls unreachable", async () => {
    const { desktop } = harness({}, { hermes: fixtureChatClient() });
    await expect(desktop.attach({ name: "juniper" })).rejects.toMatchObject({
      code: CHAT_ERROR_CODES.UNREACHABLE,
    });
  });
});
