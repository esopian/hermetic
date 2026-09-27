/**
 * What the box can say about its browser stack, and the laptop cannot (§7.3).
 *
 * Chrome's DevTools port is bound to `127.0.0.1` and is never in a Tailscale
 * Serve route — CDP is unauthenticated total control of the browser, including
 * local file reads — so nothing off the box can ask whether the browser the
 * agent drives is actually up. hermeticd asks on the operator's behalf and puts
 * the answer on `GET /healthz`, where `agents.probe`'s `browser` layer relays
 * it.
 *
 * Two questions per identity, because they fail apart: systemd's view of
 * `hermetic-browser@<name>.service`, and whether the Chrome behind it answers
 * `/json/version`. An active unit with a silent CDP port is a Chrome that
 * started and died into its restart loop, which reads very differently from a
 * unit nobody enabled.
 *
 * This is deliberately **not** part of `Health` (§6.4's `hermes`/`tailscale`/
 * `disk` triple): a browser that is down is reported, not a reason to call the
 * agent degraded.
 */
import type { BrowserIdentity, RpcBrowserHealth } from "@hermetic/core/schema";
import { UNIT_SHOW_PROPERTIES, parseUnitState } from "./heartbeat.ts";
import type { Host } from "./host.ts";
import { MANIFEST_PATH, parseManifestJson } from "./manifest.ts";

/**
 * How long Chrome gets to answer `/json/version`.
 *
 * Short on purpose: the endpoint is on loopback and serves a static JSON blob,
 * so anything slower than this is a browser that is not answering rather than a
 * browser that is busy — and `GET /healthz` is a request an operator is waiting
 * on.
 */
export const CDP_TIMEOUT_MS = 2_000;

/**
 * The unit that owns one browser identity.
 *
 * Spelled here as well as in core's `render-browser.ts` (`browserUnitsFor`)
 * because agentd may import only `@hermetic/core/schema` and `/shared`, and the template unit
 * names live in the render layer. The two must move together: this name is how
 * the box finds the unit the laptop rendered.
 */
export function browserUnit(name: string): string {
  return `hermetic-browser@${name}.service`;
}

/** The CDP endpoint of one identity, always loopback (§B). */
export function cdpVersionUrl(identity: BrowserIdentity): string {
  return `http://127.0.0.1:${String(identity.cdp_port)}/json/version`;
}

/** What `/json/version` answered: the browser string, or why there is none. */
interface CdpAnswer {
  readonly ok: boolean;
  readonly version: string | null;
  /** The phrase that goes after `CDP ` in the detail line. */
  readonly phrase: string;
}

async function askCdp(identity: BrowserIdentity, doFetch: typeof fetch): Promise<CdpAnswer> {
  let res: Response;
  try {
    res = await doFetch(cdpVersionUrl(identity), { signal: AbortSignal.timeout(CDP_TIMEOUT_MS) });
  } catch (e) {
    // A connection refused and a timeout mean different things to whoever is
    // reading this: nothing is listening on the port at all, versus a Chrome
    // that has the port open and is not answering on it.
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return {
      ok: false,
      version: null,
      phrase: timedOut ? `no answer in ${String(CDP_TIMEOUT_MS)}ms` : "refused",
    };
  }
  if (!res.ok) {
    return { ok: false, version: null, phrase: `answered ${String(res.status)}` };
  }
  // Answering at all is the check; the version is what it calls itself. A body
  // this build cannot read is still a browser that is up, so it passes with an
  // unknown version rather than failing on upstream's JSON shape.
  let version: string | null = null;
  try {
    const body: unknown = await res.json();
    const named = (body as { Browser?: unknown } | null)?.Browser;
    if (typeof named === "string" && named !== "") version = named;
  } catch {
    version = null;
  }
  return { ok: true, version, phrase: version ?? "up, version unknown" };
}

/**
 * Ask systemd and CDP about every identity this agent runs.
 *
 * `fetchImpl` is injected for the reason the heartbeat's is: a test must be
 * able to say what the browser answered without a socket.
 */
export async function probeBrowsers(
  host: Host,
  browsers: readonly BrowserIdentity[],
  fetchImpl?: typeof fetch,
): Promise<RpcBrowserHealth[]> {
  const doFetch = fetchImpl ?? fetch;
  const out: RpcBrowserHealth[] = [];
  for (const identity of browsers) {
    const unit = browserUnit(identity.name);
    const shown = await host.exec(["systemctl", "show", "-p", UNIT_SHOW_PROPERTIES, unit]);
    const state = parseUnitState(shown.stdout);
    // `active (running)` and nothing else, which is the same rule the Hermes
    // probe learned: `systemctl is-active` calls `activating (auto-restart)`
    // active, and that is precisely the middle of a crash loop.
    const unitActive = state.activeState === "active" && state.subState === "running";
    const active = state.activeState ?? "unknown";
    const described =
      state.subState === null ? `${unit} ${active}` : `${unit} ${active} (${state.subState})`;
    const cdp = await askCdp(identity, doFetch);
    out.push({
      name: identity.name,
      unit_active: unitActive,
      cdp_ok: cdp.ok,
      cdp_version: cdp.version,
      detail: `${described}, CDP ${cdp.phrase}`,
    });
  }
  return out;
}

/**
 * The `browsers` field of `GET /healthz`, read from the manifest on disk.
 *
 * Three answers, because they have three different fixes, and `browserLayer` in
 * core's `probe.ts` reads each one as a different sentence:
 *
 * - `undefined` (the field omitted) — the manifest is missing or this build
 *   refuses it, so the box cannot say anything about browsers. The probe reads
 *   an omitted field as "not asked": on a box running a hermeticd from before
 *   this field existed, the omission is the only signal there is, and the fix is
 *   an `artifacts push`.
 * - `[]` — the manifest parses and lists no browsers. That is a positive
 *   statement, not a silence: a `browser: true` agent whose applied manifest
 *   predates the browser stack (or was rendered `--no-browser` and later
 *   flipped) has an `agent rerun` owing, and the probe can only name that fix if
 *   an empty list is distinguishable from an absent one.
 * - A non-empty list — one entry per identity the applied configuration lists.
 *
 * Read per request rather than captured at start-up, so a converge that lands a
 * new configuration changes what the next `/healthz` reports — the same reason
 * `configHash` is a callback.
 */
export async function reportBrowsers(
  host: Host,
  fetchImpl?: typeof fetch,
): Promise<RpcBrowserHealth[] | undefined> {
  const text = await host.readFile(MANIFEST_PATH);
  if (text === null) return undefined;
  let browsers: readonly BrowserIdentity[];
  try {
    // `?? []` is the manifest that predates the field: it parses, and what it
    // says about browsers is that there are none.
    browsers = parseManifestJson(text).browsers ?? [];
  } catch {
    // A manifest this build refuses is not a configuration this box is running,
    // which is the same conclusion `readAppliedConfigHash` draws.
    return undefined;
  }
  return probeBrowsers(host, browsers, fetchImpl);
}
