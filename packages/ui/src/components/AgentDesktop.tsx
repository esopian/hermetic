/**
 * The agent's screen, embedded: noVNC over the `/vnc` route Serve publishes for
 * the browser stack (§7.3), inside the drawer's Desktop tab.
 *
 * Two properties this component exists to hold:
 *
 * - **It starts cold.** Selecting the tab opens nothing. A session is a live
 *   RFB stream over the tailnet, and the drawer gets opened constantly to read
 *   a disk percentage — so the stream begins when somebody presses Connect and
 *   ends when they leave, never because a drawer was opened.
 * - **There is exactly one stream per drawer.** The viewer is mounted only
 *   while this panel is connected, and the panel itself is mounted only while
 *   the Desktop tab is selected, so leaving the tab, switching which browser is
 *   being watched, or closing the drawer all drop the session. `Reconnect` is a
 *   remount, not a second frame.
 *
 * The take-over line in the footer is the only place the shared-session
 * contract is stated: this is the agent's own browser, not a copy of it.
 *
 * **The viewer is never an `<iframe>`.** Electrobun injects its preload — the
 * RPC bridge's key and socket port — into every frame of the app's webview,
 * and its script-message handlers answer any frame that posts to them. A
 * noVNC page from a box in this window's DOM would therefore be a page on the
 * tailnet able to call `secrets.push` or `apply`, and an iframe `sandbox`
 * attribute does not take the bridge away from a frame allowed to run
 * scripts. So the client runs in `<electrobun-webview sandbox>`: a separate
 * native webview laid over this element, created by the devkit with the
 * sandboxed preload and no bridge handlers at all, and held by its own
 * navigation rules to the one box it was opened for.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { desktopClientUrl, desktopUrl, hostname, isOffStatus } from "../logic/format.ts";
import { openExternal } from "../lib/open-external.ts";

/** The devkit's out-of-page webview element (`preload/webviewTag.ts` in the devkit). */
export const DESKTOP_VIEW_TAG = "electrobun-webview";

/**
 * The navigation rules the viewer is held to: nothing but the box's own origin,
 * so a link inside noVNC cannot take the view somewhere else.
 */
export function desktopViewRules(src: string): string[] {
  return ["^*", `${new URL(src).origin}/*`];
}

/**
 * Where the viewer starts, before its rules are on. Not the client URL, and
 * not nothing: with neither `src` nor `html` the devkit loads
 * `https://electrobun.dev` (`webviewTagInit` in `proc/native.ts`), and an
 * empty `html` is falsy there and does the same. A non-empty `html` is loaded
 * on a 100 ms timer (`BrowserView`'s constructor) that can land *after* the
 * client URL and blank it. `about:blank` is a URL, loads nothing, and races
 * nothing.
 */
export const DESKTOP_VIEW_START = "about:blank";

/**
 * The attributes the sandboxed viewer is created with. Pure, so the suite can
 * pin them without a devkit. `sandbox` is the one that matters: no RPC, no
 * internal bridge, events only. `navigation-rules` is carried for a devkit that
 * honours it at creation; 2.0.1 accepts it and drops it before native, which
 * is why `DesktopView` sets the rules itself before it sets `src`.
 */
export function desktopViewAttributes(src: string, title: string): Record<string, string> {
  return {
    sandbox: "",
    src: DESKTOP_VIEW_START,
    title,
    "navigation-rules": JSON.stringify(desktopViewRules(src)),
  };
}

/** As much of the devkit's element as the viewer drives. */
interface DevkitWebview extends HTMLElement {
  webviewId?: number | null;
  setNavigationRules?: (rules: string[]) => void;
}

/** How often, and for how long, to wait for the devkit to create the native view. */
const READY_POLL_MS = 50;
const READY_TIMEOUT_MS = 15_000;

/**
 * Mounts one sandboxed viewer and removes it on unmount — which is what closes
 * the native webview and its socket.
 *
 * Built by hand rather than as JSX: the element's `sandbox` is a getter with no
 * setter, which React 19 would try to assign as a property (it prefers a
 * property whenever one exists on a custom element) and throw. More to the
 * point, `sandbox` has to be on the element *before* it is connected, because
 * the element reads it once, on its first frame after connecting, and
 * sandboxing a webview after it exists is not a thing the devkit offers.
 *
 * Then, in this order, once the element reports a `webviewId` (the tag's own
 * `setNavigationRules` is a no-op before that): the rules, then the client URL.
 * Both go over the tag's one internal message queue and are applied in the
 * order sent, so the view is never on the box's page without its rules. A
 * view that never becomes ready — no devkit, as in the suite — stays on
 * `about:blank` and never loads the box at all.
 */
function DesktopView({ src, title }: { src: string; title: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view: DevkitWebview = document.createElement(DESKTOP_VIEW_TAG);
    for (const [name, value] of Object.entries(desktopViewAttributes(src, title))) {
      view.setAttribute(name, value);
    }
    view.style.display = "block";
    view.style.width = "100%";
    view.style.height = "100%";
    host.appendChild(view);

    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = Date.now() + READY_TIMEOUT_MS;
    const load = (): void => {
      timer = null;
      const ready = typeof view.webviewId === "number" && typeof view.setNavigationRules === "function";
      if (!ready) {
        if (Date.now() < deadline) timer = setTimeout(load, READY_POLL_MS);
        return;
      }
      view.setNavigationRules?.(desktopViewRules(src));
      view.setAttribute("src", src);
    };
    load();
    return () => {
      if (timer !== null) clearTimeout(timer);
      view.remove();
    };
  }, [src, title]);
  return <div className="desk-view" ref={hostRef} style={{ width: "100%", height: "100%" }} />;
}

/** §H's browser identities, as the row reports them. One entry today. */
export interface BrowserIdentity {
  name: string;
  serve_path: string;
}

export function AgentDesktop({
  name,
  tailnet,
  dnsName,
  fleetId,
  browsers,
  status,
  suspended = false,
}: {
  name: string;
  tailnet: string;
  dnsName?: string | null;
  fleetId?: string | null;
  browsers: readonly BrowserIdentity[];
  /** Whether this agent was created with a browser stack at all (`--no-browser` is the other answer). */
  /** The row's `display_status`: a stopped or destroyed box has nothing to stream. */
  status: string;
  /**
   * Something is covering the drawer (Settings, Volumes, a create drawer). The
   * frame is still mounted behind it, and a hidden iframe keeps its socket — so
   * the panel treats being covered as leaving, and goes cold.
   */
  suspended?: boolean;
}) {
  /**
   * Which identity is being watched. Held rather than derived so a fleet
   * refresh that re-orders the list does not swap the frame underneath an
   * operator mid-session.
   */
  const [identity, setIdentity] = useState(browsers[0]?.name ?? "default");
  /** Cold until asked. See the header — this is the whole point of the tab. */
  const [connected, setConnected] = useState(false);
  /** noVNC reads `resize` once, at load, so `1:1` is a remount with a different query. */
  const [fit, setFit] = useState<"scale" | "off">("scale");
  /** Bumped by `Reconnect`: same URL, new element, so the old socket is closed by the unmount. */
  const [attempt, setAttempt] = useState(0);
  const frameRef = useRef<HTMLDivElement>(null);

  /*
   * Being covered is being left. Adjusting state during the render that brings
   * the new prop in (rather than in an effect) means the frame is never painted
   * once behind the overlay: React re-renders immediately with `connected`
   * false, so the socket is dropped in the same commit that raised the overlay.
   */
  const [wasSuspended, setWasSuspended] = useState(suspended);
  if (suspended !== wasSuspended) {
    setWasSuspended(suspended);
    if (suspended) setConnected(false);
  }

  const host = hostname(name, tailnet, dnsName, fleetId);
  const openUrl = desktopUrl(name, tailnet, dnsName, fleetId, identity);
  /*
   * The embedded viewer uses the long client URL rather than `openUrl`: it is
   * the one that connects on an agent whose manifest has not been re-applied,
   * where `/vnc/` is still a directory listing.
   *
   * `1:1` is a substitution rather than a `URL` round trip, because
   * `URLSearchParams` re-encodes the slash in `path=vnc/websockify` — noVNC
   * decodes that fine, but a URL an operator may copy out of the frame should
   * read the way core spells it (`agentDesktopClientUrl`).
   */
  const client = desktopClientUrl(name, tailnet, dnsName, fleetId, identity);
  const src = fit === "scale" ? client : client.replace("resize=scale", "resize=off");
  /*
   * Where Serve publishes this identity, as the row reports it rather than as
   * this component guesses it: `serve_path` is rendered by core alongside the
   * manifest, so the two cannot drift the way a second copy of the `/vnc` vs
   * `/vnc/<name>` rule would. `desktopUrl`/`desktopClientUrl` stay the URL
   * builders (they are the ones `tests/naming-mirror.test.ts` holds to core);
   * this is only what the toolbar and the footer say out loud.
   */
  const servePath = browsers.find((b) => b.name === identity)?.serve_path ?? "/vnc";
  const socket = `wss://${host}${servePath}/websockify`;

  const newTab = (
    <button
      type="button"
      className="btn btn-secondary btn-mini"
      onClick={() => openExternal(openUrl)}
      title={openUrl}
    >
      ↗ New tab
    </button>
  );

  /*
   * The box is not running, so there is nothing to connect to: a `Connect →`
   * here would dial a hostname with no listener behind it and fail a few
   * seconds later, which is a worse answer than the status the operator can
   * already see on the row. Same predicate the action row uses to withhold
   * `Open desktop ↗`, so the two cannot disagree about whether a screen exists.
   */
  if (isOffStatus(status)) {
    return (
      <div className="desk desk-off">
        <div className="desk-idle">
          <div>
            <div className="sq-big" />
            <div className="kicker">Desktop</div>
            <h3>No desktop while this agent is {status}</h3>
            <p>
              <b>{name}</b> has a browser stack, but its instance is{" "}
              <span className="mono">{status}</span> — nothing is serving the{" "}
              <span className="mono">{servePath}</span> route, so there is no stream to open.
              {status === "stopped"
                ? " Start the agent and the desktop comes back on the same address."
                : " A destroyed agent is terminal; recreating one on the same volume gives it a new screen."}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="desk">
      <div className="desk-toolbar">
        <span className="desk-state" style={connected ? undefined : { color: "var(--fg3)" }}>
          <i style={connected ? undefined : { background: "var(--line2)" }} />
          {connected ? `connected · ${socket}` : "not connected · nothing is streaming"}
        </span>
        {/*
          One identity is not a choice, so it is not a control: a dropdown with a
          single option is a question an operator has to open before finding out
          there was nothing to answer.
        */}
        {browsers.length > 1 ? (
          <select
            className="desk-pick mono"
            aria-label="Which browser to watch"
            value={identity}
            onChange={(e) => {
              // Switching identity is a different machine's screen: drop the
              // stream rather than pointing the live frame somewhere else.
              setIdentity(e.target.value);
              setConnected(false);
            }}
          >
            {browsers.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="desk-pick mono">{identity}</span>
        )}
        {connected ? (
          <>
            <button
              type="button"
              className="btn btn-secondary btn-mini"
              onClick={() => setAttempt((n) => n + 1)}
              title="Drop this session and open a new one"
            >
              ⟳ Reconnect
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-mini"
              aria-pressed={fit === "off"}
              onClick={() => setFit((f) => (f === "scale" ? "off" : "scale"))}
              title="Show the remote screen at its own resolution instead of scaling it to this frame"
            >
              1:1
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-mini"
              onClick={() => {
                const el = frameRef.current;
                if (el && typeof el.requestFullscreen === "function")
                  void el.requestFullscreen().catch(() => {});
              }}
            >
              ⤢ Full screen
            </button>
          </>
        ) : null}
        {newTab}
      </div>

      {connected ? (
        <>
          <div className="desk-frame" ref={frameRef}>
            <DesktopView
              // The key is the session: a change of identity, of scaling or of
              // attempt replaces the element, which is what closes the socket
              // the old one held. noVNC reads both query parameters at load.
              key={`${identity}:${fit}:${attempt}`}
              title={`${name} desktop`}
              src={src}
            />
            {/*
              A separate webview keeps every keydown to itself, Escape
              included — so there is no keystroke that gets focus back out of
              it, and telling an operator to press Esc twice is telling them to
              press a key that goes to the agent's browser both times. Clicking
              off the frame is the move that works.
            */}
            <div className="desk-focus">
              click the frame to send keys and clicks · click outside the frame, then Esc closes the
              drawer
            </div>
          </div>
          <div className="desk-foot">
            This is the browser the agent is using. What you do here, it sees.
            <br />
            Read-write. Anything typed here goes to the agent's own X display — the same one Hermes
            drives its browser on. Closing this tab drops the stream; the agent is untouched.
          </div>
        </>
      ) : (
        <>
          <div className="desk-idle">
            <div>
              {/* No display number: `AgentView.browsers` does not project one, so any digit here would be this file's guess. */}
              <div className="kicker">Desktop · Xvfb</div>
              <h3>Start watching</h3>
              <p>
                One live VNC stream over the tailnet. It starts when you press this and stops when you
                leave the tab — nothing streams in the background, and opening an agent to read a number
                never opens a session.
              </p>
              <button type="button" className="btn btn-primary" onClick={() => setConnected(true)}>
                Connect →
              </button>
            </div>
          </div>
          <div className="desk-foot">
            {host}
            {servePath}/ · reachable only from the tailnet · no inbound ports
          </div>
        </>
      )}
    </div>
  );
}
