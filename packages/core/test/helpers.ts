import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STAGES_ENV } from "../src/release/artifacts.ts";
import type { OpEvent, TailscaleOauthCheck, TailscalePreflight } from "../src/schema/index.ts";
import { BUILD_VERSIONS, createHermetic, type HermeticDeps } from "../src/hermetic.ts";
import type { HermesMirrorFn } from "../src/release/hermes-mirror.ts";
import type { BrowserMirrorFn } from "../src/release/browser-mirror.ts";
import { HEARTBEAT_INTERVAL_MS, UNREACHABLE_INTERVALS } from "../src/agents/state.ts";
import type { Backend } from "../src/backend/types.ts";
import type { FetchLike } from "../src/aws/tailscale.ts";
import { fixtureBedrockCatalog, fixtureModelFetch } from "../src/profiles/model-catalog.ts";
import {
  FIXTURE_CONFIG,
  FIXTURE_HERMETICD_VERSION,
  MemoryBackend,
  seedFixtureFoundation,
} from "../src/backend/memory.ts";
import { createAgentRuntime } from "../src/agents/agent-runtime.ts";
import { MemoryNotificationStore } from "../src/chat/notifications.ts";
import type { CoreContext } from "../src/context.ts";

/**
 * A laptop that is on a tailnet. `init`'s §4.7 preflight defaults to spawning
 * the real `tailscale` binary and talking to api.tailscale.com — deliberately,
 * so that an absent dependency cannot silently disable the gate — which means
 * every test that walks `init` has to say what the machine looks like instead.
 *
 * `acme.ts.net` is the tailnet those tests already pass to `init`, so the
 * detected and the requested one agree and no disagreement warning is emitted.
 */
export const OK_TAILSCALE = async (): Promise<TailscalePreflight> => ({
  ok: true,
  installed: true,
  running: true,
  backend_state: "Running",
  tailnet: "acme.ts.net",
  cert_domains: ["test-laptop.acme.ts.net"],
  hostname: "test-laptop",
  addresses: ["100.64.0.2"],
  binary: "tailscale",
  problem: null,
});

/** An OAuth client with both scopes, so no test reaches api.tailscale.com. */
export const OK_OAUTH = async (): Promise<TailscaleOauthCheck> => ({
  ok: true,
  authenticated: true,
  can_mint: true,
  can_list_devices: true,
  policy_scope: "write",
  revoked: true,
  problem: null,
});

/**
 * `createHermetic` for tests: the preflight is stubbed healthy unless the test
 * says otherwise. A test that is *about* the gate calls `createHermetic`
 * directly with its own `localTailscale`.
 */
/**
 * A core over whatever backend the test hands in, with the §4.7 probes canned.
 * `fixture` defaults to true: a `MemoryBackend` has no bucket for a real
 * `hermeticd`, so `init`'s artifact preflight (§3.6) would refuse every create;
 * tests of the real-mode refusal pass `fixture: false` explicitly.
 */
/**
 * The laptop-side `fetch` `agents.probe`'s dashboard layer uses (§9). Canned
 * for exactly the reason the Tailscale preflight is: core defaults it to the
 * *real* `fetch` — so that a build which forgets to wire one cannot silently
 * skip the check — which means a test that left it alone would try to resolve
 * `atlas.acme.ts.net` on a suite that is not allowed a network (§11).
 *
 * It agrees with `MemoryBackend`'s `/healthz` fake: a fresh heartbeat serves, a
 * stale one does not. Two layers disagreeing about the same box would be a
 * fixture artefact appearing as a diagnosis.
 */
export function testProbeFetch(backend: Backend): FetchLike {
  return async (input: string): Promise<Response> => {
    const label = new URL(input).hostname.split(".")[0] ?? "";
    /**
     * The URL carries the node's *cloud* name (`<fleet id>-<agent>` since v4,
     * §5); the row is keyed by the agent name, so the fleet prefix comes back
     * off. The fleet's *name* is tried too, because a node built under v3 wears
     * that spelling and is reached at it — the same set `legacyCloudNames`
     * describes, and the reason this fake can serve a legacy box at all.
     */
    const fleet = await backend.store.fleet.get();
    const prefixes = [fleet?.fleet_id, fleet?.fleet_name].filter((p): p is string => !!p);
    const prefix = prefixes.find((p) => label.startsWith(`${p}-`));
    const name = prefix ? label.slice(prefix.length + 1) : label;
    const heartbeat = (await backend.store.agents.get(name))?.last_heartbeat;
    const stale =
      !heartbeat ||
      backend.clock.now().getTime() - Date.parse(heartbeat) >
        HEARTBEAT_INTERVAL_MS * UNREACHABLE_INTERVALS;
    if (stale) throw new TypeError(`Unable to connect to ${input}`);
    return new Response("", { status: 200 });
  };
}

/**
 * §6.6's advisory upstream-Hermes check, offline. Core defaults it to the real
 * `fetch` for the same reason it defaults the §4.7 probes to real ones — a
 * build that forgot to wire one must not silently report "up to date" — so a
 * test that left it alone would reach api.github.com, which §11 forbids.
 *
 * It answers the tag this build already pins, so the default in every test is
 * "nothing to say". A test that is *about* the check hands in its own.
 */
export const OFFLINE_HERMES_RELEASE: FetchLike = async () =>
  Response.json({ tag_name: `v${BUILD_VERSIONS.hermes_ref.replace(/^v/, "")}` });

/**
 * §3.6's Hermes mirror, offline and inert. Core defaults it to the *real* one
 * for the reason it defaults the §4.7 probes to real ones — a build that forgot
 * to wire one must not silently stop mirroring — so a test that left it alone
 * would spawn `git` and clone github.com, which §11 forbids.
 *
 * It answers "already there": a test bucket that boots nothing has nothing to
 * mirror, and a warning would put an event in every push a test walks. The
 * tests that are *about* the mirror drive `ensureHermesMirror` directly.
 */
export const OFFLINE_HERMES_MIRROR: HermesMirrorFn = async ({ existing }) => ({
  block: existing,
  status: "present",
});

/**
 * §7.3's browser mirror, stubbed for exactly the reason above: core defaults it
 * to the real one, which downloads ~190 MB from cdn.playwright.dev, and a test
 * that left it alone would open a socket. It answers "already there" so no push
 * a test walks gains an event it was not written to expect; the tests that are
 * *about* the mirror drive `ensureBrowserMirror` directly.
 */
export const OFFLINE_BROWSER_MIRROR: BrowserMirrorFn = async ({ chrome_ref, existing }) => ({
  block: existing,
  status: "present",
  chrome_ref,
  downloaded: false,
});

export function testHermetic(deps: HermeticDeps) {
  return createHermetic({
    localTailscale: OK_TAILSCALE,
    verifyTailscaleOauth: OK_OAUTH,
    hermesMirror: OFFLINE_HERMES_MIRROR,
    browserMirror: OFFLINE_BROWSER_MIRROR,
    fixture: true,
    // The data-volume attach wait is unbounded and polls every five seconds in
    // production (`attach.ts`). A test that has to wait even one of those is a
    // test that times out, so the poll is a tick here; the tests that are
    // *about* the waiting drive it directly.
    attach: { pollMs: 1, progressMs: 0, tailnetOfflineMs: 0 },
    // §3.6's build-drift warning is off unless a test asks for it: the real
    // resolver walks this repository's sources, which no test should do by
    // accident, and every existing assertion about a create's events predates it.
    localBuild: () => null,
    /**
     * "No checkout", for exactly the reason above: the real reader runs `git`
     * in *this* repository, so a suite that took the default would refuse every
     * real-mode push whenever its author had uncommitted work — which is most
     * of the time, and none of it is about the code under test. The tests that
     * are *about* the clean-tree rule hand in a tree of their own.
     */
    git: () => null,
    ...deps,
    foundation: { hermesFetch: OFFLINE_HERMES_RELEASE, ...deps.foundation },
    probe: { fetch: testProbeFetch(deps.backend), ...deps.probe },
    /**
     * §8.3's model discovery, canned for exactly the reason the two probes
     * above are: core defaults it to the platform `fetch` and to whatever
     * Bedrock the backend can reach, so a test that left it alone would open a
     * socket — which §11 forbids. The tests that are *about* discovery hand in
     * their own `fetch`.
     */
    modelCatalog: {
      fetch: fixtureModelFetch,
      bedrock: fixtureBedrockCatalog,
      ...deps.modelCatalog,
    },
  });
}

/**
 * A `CoreContext` (`context.ts`) for a test that constructs one module directly
 * rather than going through `createHermetic`: the real runtime helpers over
 * the backend handed in, with the fixture's frozen config, versions and an
 * in-process inbox, and no release to publish. `overrides` replace any field —
 * a test that wants a guard to pass unconditionally, or a clock of its own,
 * says so here. The §4.7 probes are not context fields (rule 6), so a module
 * that takes one still has to be handed it explicitly.
 */
export function testContext(backend: Backend, overrides: Partial<CoreContext> = {}): CoreContext {
  const config = overrides.config === undefined ? FIXTURE_CONFIG : overrides.config;
  const runtime = createAgentRuntime({
    backend,
    config,
    attach: { pollMs: 1, progressMs: 0, tailnetOfflineMs: 0 },
  });
  return {
    ...runtime,
    scanAgents: runtime.scanAgentsAllowingMissingTable,
    backend,
    config,
    fixture: true,
    hermeticdVersion: FIXTURE_HERMETICD_VERSION,
    hermesVersion: BUILD_VERSIONS.hermes,
    localBuild: () => null,
    notifications: {
      store: new MemoryNotificationStore(),
      fleet: () => config?.fleet_id ?? null,
      instances: () => [],
    },
    publishDeps: () => ({
      artifacts: backend.artifacts,
      hermeticVersion: FIXTURE_HERMETICD_VERSION,
      fixture: true,
    }),
    ...overrides,
  };
}

/** A fleet with a foundation and no agents — the starting reality for lifecycle tests. */
export function freshFleet() {
  const backend = seedFixtureFoundation(new MemoryBackend());
  const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG });
  return { backend, hermetic };
}

export async function drain(stream: AsyncIterable<OpEvent>): Promise<OpEvent[]> {
  const out: OpEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

/**
 * A release's bootstrap stages, in a temp directory `HERMETIC_STAGES` points at.
 * Tests that walk a *real-mode* push need stages — a release without them boots
 * nothing — and must not depend on `packages/agentd/stages` being present, so
 * they make their own.
 */
export function installTestStages(names: readonly string[] = ["00-preflight.sh", "01-tailscale.sh"]): {
  dir: string;
  restore: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "hermetic-stages-"));
  mkdirSync(dir, { recursive: true });
  for (const name of names) {
    writeFileSync(join(dir, name), `#!/usr/bin/env bash\nset -euo pipefail\n# ${name}\n`);
  }
  const previous = process.env[STAGES_ENV];
  process.env[STAGES_ENV] = dir;
  return {
    dir,
    restore: () => {
      if (previous === undefined) delete process.env[STAGES_ENV];
      else process.env[STAGES_ENV] = previous;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
