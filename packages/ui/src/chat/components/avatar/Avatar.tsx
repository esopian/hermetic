/**
 * The avatar, as a component (§9.2).
 *
 * One component, three styles, one seed. Everything that decides what an avatar
 * *is* lives in `avatar-seed.ts` and the three renderers; this file is the only
 * one that knows about React, the DOM, the theme or GSAP.
 *
 * Three rules shaped the whole file and none of them is negotiable:
 *
 *   **It is correct on first paint.** The mark is ordinary JSX — `<rect>`s for
 *   sigil and pixel, two `<path>`s for blob — computed from pure functions and
 *   rendered by React. Nothing needs a frame of animation before it looks
 *   right, so it is right in `renderToStaticMarkup`, right on a slow machine,
 *   and right for a user who has turned motion off. The ticker below only ever
 *   *rewrites* attributes on elements that already exist.
 *
 *   **GSAP is a dependency of the animation, never of the shape.** It is loaded
 *   with a dynamic `import()` that is allowed to fail: without it the shared
 *   ticker runs on a plain `requestAnimationFrame`, state changes snap instead
 *   of easing, and the entrance is skipped. A CDN failure or a stripped bundle
 *   costs polish, not avatars.
 *
 *   **Everything stops on unmount.** A rail of forty avatars mounting and
 *   unmounting as the operator filters is the normal case, so the ticker keeps
 *   a registry and tears its loop down the moment the registry empties; the
 *   `IntersectionObserver` and every tween are killed with the component.
 */
import { useChatAvatarStyle } from "../../chat-appearance.ts";
import type { RefObject } from "react";
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type {
  AvatarActivity,
  AvatarMotion,
  AvatarPalette,
  AvatarStatus,
  AvatarStyle,
} from "./avatar-seed.ts";
import { avatarMotion, avatarPalette, avatarSeed, avatarSeeds } from "./avatar-seed.ts";
import type { BlobShape } from "./blob.ts";
import { BLOB_VIEWBOX, blobApply, blobFrame, blobShape, blobTick } from "./blob.ts";
import type { PixelParts } from "./pixel.ts";
import {
  PIXEL_STILL,
  PIXEL_STOPPED,
  PIXEL_VIEWBOX,
  pixelApply,
  pixelParts,
  pixelTick,
} from "./pixel.ts";
import type { SigilCell } from "./sigil.ts";
import { SIGIL_VIEWBOX, sigilCells, sigilStill, sigilTick } from "./sigil.ts";

export type { AvatarActivity, AvatarStatus, AvatarStyle } from "./avatar-seed.ts";
export { avatarSeed } from "./avatar-seed.ts";

export interface AvatarProps {
  /** The identity key's three parts. Never the display name — renaming must not change a face. */
  fleet_id: string;
  instance: string;
  bot: string;
  size: number;
  status: AvatarStatus;
  activity: AvatarActivity;
  style?: AvatarStyle;
  /**
   * Colour by instance: the hue comes from `fleet_id/instance` and the shape
   * from the whole key, so every bot on one box reads as a hue family. On by
   * default, and §9.2 is the argument — in the all-instances feed there are no
   * buckets, and hue is the only channel that says which box a row came from at
   * 32px in peripheral vision.
   */
  family?: boolean;
  /** Overrides the screen-reader name. Defaults to `bot@instance`, or the instance alone. */
  label?: string;
  /** Appended to the component's own class, for a caller that needs to place it. */
  className?: string;
}

/* ══ the shared ticker ═══════════════════════════════════════════════════════
   One loop for the whole page. Forty avatars is forty attribute writes on one
   frame callback, not forty `requestAnimationFrame` loops — and, just as
   importantly, no loop at all once the last avatar has unmounted. */

interface Entry {
  t: number;
  motion: AvatarMotion;
  visible: boolean;
  draw(t: number, motion: AvatarMotion): void;
}

const LIVE = new Set<Entry>();
let stopLoop: (() => void) | null = null;

/** GSAP, if it ever arrives. Null is a supported, tested state, not a failure. */
let GSAP: typeof import("gsap").gsap | null = null;
let gsapRequested = false;

function requestGsap(): void {
  if (gsapRequested || typeof window === "undefined") return;
  gsapRequested = true;
  import("gsap")
    .then((mod) => {
      GSAP = mod.gsap;
    })
    .catch(() => {
      // A bundle without GSAP is a supported bundle. The rAF loop below is
      // already running; nothing else has to happen.
      GSAP = null;
    });
}

/**
 * Set the first time a GSAP call throws, and never unset.
 *
 * One failure is all it takes to know: a GSAP that cannot read this document's
 * computed styles will fail the same way for every other avatar on the page,
 * and a rail of forty is forty chances to take the view down. From here the
 * component behaves exactly as it does in a bundle with no GSAP at all — which
 * is a path this file has always had to support, and which `reduced` already
 * exercises in the suite.
 */
let gsapFailed = false;

/** GSAP, only if it is both here and still trusted. */
function gsapReady(): typeof import("gsap").gsap | null {
  return gsapFailed ? null : GSAP;
}

/**
 * Every GSAP call goes through here, and a throw costs the animation rather
 * than the component.
 *
 * The rule this enforces is the one §9.2 states and the brief repeats: GSAP is
 * a dependency of the animation, never of the shape. A tween that cannot run
 * has to leave a correct static avatar on screen, exactly as reduced motion
 * does. Callers get `null` back and are responsible for putting the DOM into
 * the state React committed — see both call sites below.
 */
function tryGsap<T>(run: (gsap: typeof import("gsap").gsap) => T | null): T | null {
  const lib = gsapReady();
  if (!lib) return null;
  try {
    return run(lib);
  } catch {
    gsapFailed = true;
    return null;
  }
}

/**
 * Whether GSAP can read this element's transform without falling over.
 *
 * GSAP's CSSPlugin expects `getComputedStyle().transform` to be a computed
 * `matrix(…)`/`matrix3d(…)`, or one of the two values it treats as the
 * identity. A DOM implementation that echoes the *inline shorthand* back
 * instead — happy-dom returns the literal `scale(1)` this component writes —
 * reaches its matrix parser as a string it cannot parse, and it throws from the
 * tween's constructor. That is not a hypothetical: it is every status and
 * activity change in the portal's own test DOM, and a turn starting flips every
 * visible face to `streaming` at once.
 *
 * Checking first, rather than only catching afterwards, is what keeps the
 * component's own suite able to exercise the real transition path under
 * happy-dom. The `catch` in `tryGsap` stays for the failures this cannot see
 * coming.
 */
function transformReadable(el: Element): boolean {
  if (typeof getComputedStyle !== "function") return false;
  try {
    const value = getComputedStyle(el).transform;
    return !value || value === "none" || value.startsWith("matrix");
  } catch {
    return false;
  }
}

function step(deltaMS: number): void {
  // Clamped at both ends. The ceiling exists because a tab that was
  // backgrounded for a minute must not hand every avatar a sixty-second delta
  // and teleport it through its own cycle. The floor matters for a reason that
  // only showed up under a hand-driven clock — `last` is seeded from
  // `performance.now()`, and any frame source whose timestamps are on a
  // different epoch produces a large *negative* first delta, which runs every
  // avatar backwards through its own cycle in one step.
  const dt = Math.min(Math.max(deltaMS, 0), 50) / 1000;
  for (const entry of LIVE) {
    if (!entry.motion.alive || !entry.visible) continue;
    entry.t += dt * entry.motion.rate;
    entry.draw(entry.t, entry.motion);
  }
}

/**
 * Always a plain `requestAnimationFrame`, never `gsap.ticker` — a deliberate
 * departure from an earlier prototype, whose argument for the GSAP ticker was
 * "one rAF for every avatar on the page, not N", and the registry above
 * already delivers exactly that. Routing the draw loop through a library that
 * may or may not have finished loading would make *the shape* depend on
 * GSAP's arrival, which is the one thing §9.2 says must never be true, and it
 * would make the timing of a mount depend on a network race. GSAP keeps the
 * two jobs it is genuinely better at: the eased state change and the
 * staggered entrance.
 */
function startLoop(): void {
  if (stopLoop || typeof requestAnimationFrame !== "function") return;
  let handle = 0;
  let last = typeof performance === "undefined" ? 0 : performance.now();
  const loop = (now: number): void => {
    step(now - last);
    last = now;
    handle = requestAnimationFrame(loop);
  };
  handle = requestAnimationFrame(loop);
  stopLoop = () => cancelAnimationFrame(handle);
}

function register(entry: Entry): () => void {
  LIVE.add(entry);
  startLoop();
  return () => {
    LIVE.delete(entry);
    if (LIVE.size === 0) {
      stopLoop?.();
      stopLoop = null;
    }
  };
}

/* ── off-screen avatars do not draw ───────────────────────────────────────────
   A rail scrolled past its fold is still mounted. Entries start visible and are
   only ever *taken out* of the loop by the observer, so an environment without
   `IntersectionObserver` — or one whose stub never fires — degrades to
   drawing everything. */

let observer: IntersectionObserver | null = null;
const OBSERVED = new WeakMap<Element, Entry>();

function watch(host: Element | null, entry: Entry): () => void {
  if (!host || typeof IntersectionObserver !== "function") return () => {};
  if (!observer) {
    observer = new IntersectionObserver((records) => {
      for (const record of records) {
        const seen = OBSERVED.get(record.target);
        if (seen) seen.visible = record.isIntersecting;
      }
    });
  }
  OBSERVED.set(host, entry);
  observer.observe(host);
  return () => {
    OBSERVED.delete(host);
    observer?.unobserve(host);
  };
}

/* ── the entrance ─────────────────────────────────────────────────────────────
   Ported from an earlier prototype's `mountAll`, with React's commit taking
   the place of its `querySelectorAll`. Hosts are collected in a microtask,
   which is what batches a whole rail into one tween: every sibling's layout
   effect runs in the same commit, and the microtask queue drains after it —
   before paint, so the avatars never flash in at full opacity and then
   restart from zero.

   Skipped entirely without GSAP, under reduced motion, in a hidden tab (a
   background tab throttles rAF, so a tween started there freezes part-way and
   the avatars sit at 60% opacity until somebody looks), and for a lone avatar,
   because a stagger of one is just a fade nobody asked for. */

const ENTERING: HTMLElement[] = [];
let entranceScheduled = false;

function flushEntrance(): void {
  entranceScheduled = false;
  const batch = ENTERING.splice(0, ENTERING.length);
  if (batch.length < 2) return;
  // Captured before the tween, because `from` applies its start values the
  // moment it is constructed: a throw half-way through a batch would otherwise
  // leave part of a rail sitting at zero opacity forever.
  const committed = batch.map((host) => host.getAttribute("style"));
  const tween = tryGsap((gsap) =>
    batch.every(transformReadable)
      ? gsap.from(batch, {
          opacity: 0,
          scale: 0.72,
          duration: 0.45,
          ease: "back.out(1.7)",
          // `amount` as well as `each`: the whole stagger fits in 0.45s however
          // many avatars mounted. A per-element delay looks right for a rail of
          // thirteen and leaves the last of sixty invisible for two seconds.
          stagger: { each: 0.028, amount: 0.45 },
          clearProps: "opacity,scale,transform",
        })
      : null,
  );
  if (tween) return;
  // No entrance, then — the avatars simply appear, which is what happens with
  // no GSAP at all. Every host goes back to exactly the markup React drew.
  batch.forEach((host, i) => {
    const style = committed[i];
    if (style == null) host.removeAttribute("style");
    else host.setAttribute("style", style);
  });
}

function queueEntrance(host: HTMLElement | null, reduced: boolean): void {
  if (!host || !gsapReady() || reduced) return;
  if (typeof document !== "undefined" && document.hidden) return;
  ENTERING.push(host);
  if (entranceScheduled) return;
  entranceScheduled = true;
  queueMicrotask(flushEntrance);
}

function cancelEntrance(host: HTMLElement | null): void {
  if (!host) return;
  const at = ENTERING.indexOf(host);
  if (at !== -1) ENTERING.splice(at, 1);
  tryGsap((gsap) => gsap.killTweensOf(host));
}

/* ══ the two things the browser tells us ═════════════════════════════════════ */

const MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function readReduced(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia(MOTION_QUERY).matches;
  } catch {
    return false;
  }
}

function subscribeReduced(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  try {
    const query = window.matchMedia(MOTION_QUERY);
    if (typeof query.addEventListener !== "function") return () => {};
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  } catch {
    return () => {};
  }
}

/**
 * The theme, read off the attribute `useTheme` writes rather than out of the
 * app's store: an avatar is a leaf that a rail renders dozens of, and coupling
 * it to a context would make every one of them re-render for reasons that have
 * nothing to do with it. Geometry is unchanged by a flip — the shape is the
 * identity, the lightness is only what makes it visible.
 */
function readLight(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.getAttribute("data-theme") === "light";
}

const THEME_SUBS = new Set<() => void>();
let themeObserver: MutationObserver | null = null;

function subscribeTheme(onChange: () => void): () => void {
  THEME_SUBS.add(onChange);
  if (!themeObserver && typeof MutationObserver === "function" && typeof document !== "undefined") {
    themeObserver = new MutationObserver(() => {
      for (const sub of THEME_SUBS) sub();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
  }
  return () => {
    THEME_SUBS.delete(onChange);
    if (THEME_SUBS.size === 0) {
      themeObserver?.disconnect();
      themeObserver = null;
    }
  };
}

/* ══ what a seed builds ══════════════════════════════════════════════════════ */

type Built =
  | { style: "sigil"; pal: AvatarPalette; viewBox: string; phase: number; cells: SigilCell[] }
  | { style: "pixel"; pal: AvatarPalette; viewBox: string; phase: number; parts: PixelParts }
  | { style: "blob"; pal: AvatarPalette; viewBox: string; phase: number; shape: BlobShape };

/** The still frame every style is first painted in, and the one reduced motion keeps. */
const FROZEN: AvatarMotion = avatarMotion("ready", "idle", true);

function build(key: string, style: AvatarStyle, light: boolean, family: boolean): Built {
  const { shape: rnd, hue } = avatarSeeds(key, family);
  const pal = avatarPalette(rnd, light, hue);
  // The starting phase is drawn from the same stream, so it is deterministic —
  // but it is deliberately spread over forty seconds, because a rail whose
  // avatars all breathe on the same beat reads as one object.
  if (style === "pixel") {
    const parts = pixelParts(rnd, pal);
    return { style, pal, viewBox: PIXEL_VIEWBOX, phase: rnd() * 40, parts };
  }
  if (style === "blob") {
    const shape = blobShape(rnd);
    return { style, pal, viewBox: BLOB_VIEWBOX, phase: rnd() * 40, shape };
  }
  const cells = sigilCells(rnd);
  return { style: "sigil", pal, viewBox: SIGIL_VIEWBOX, phase: rnd() * 40, cells };
}

/* ══ the component ═══════════════════════════════════════════════════════════ */

export function Avatar({
  fleet_id,
  instance,
  bot,
  size,
  status,
  activity,
  style: requestedStyle,
  family = true,
  label,
  className,
}: AvatarProps) {
  const preferredStyle = useChatAvatarStyle();
  const style = requestedStyle ?? preferredStyle;
  const key = avatarSeed(fleet_id, instance, bot);
  const light = useSyncExternalStore(subscribeTheme, readLight, () => false);
  // Static markup gets the still frame: there is no animation in a string.
  const reduced = useSyncExternalStore(subscribeReduced, readReduced, () => true);

  const built = useMemo(() => build(key, style, light, family), [key, style, light, family]);
  const motion = useMemo(() => avatarMotion(status, activity, reduced), [status, activity, reduced]);

  const hostRef = useRef<HTMLSpanElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const rects = useRef<(SVGRectElement | null)[]>([]);
  const pixels = useRef<{
    root: SVGGElement | null;
    eyes: (SVGGElement | null)[];
    mouths: (SVGGElement | null)[];
  }>({ root: null, eyes: [], mouths: [] });
  const blobs = useRef<{
    front: SVGPathElement | null;
    back: SVGPathElement | null;
    gFront: SVGGElement | null;
    gBack: SVGGElement | null;
  }>({ front: null, back: null, gFront: null, gBack: null });

  const draw = useCallback(
    (t: number, m: AvatarMotion) => {
      if (built.style === "sigil") sigilTick(built.cells, rects.current, t, m, built.pal);
      else if (built.style === "pixel") pixelTick(built.parts, pixels.current, t, m);
      else blobTick(built.shape, blobs.current, t, m);
    },
    [built],
  );

  const stillFrame = useCallback(() => {
    if (built.style === "sigil") sigilStill(built.cells, rects.current, built.pal);
    else if (built.style === "pixel")
      pixelApply(pixels.current, motion.stopped ? PIXEL_STOPPED : PIXEL_STILL);
    else blobApply(blobs.current, blobFrame(built.shape, 0, FROZEN));
  }, [built, motion.stopped]);

  // GSAP is asked for once per page, at the first avatar's first commit —
  // early enough that a rail arriving after a fetch usually has it, late enough
  // that a portal with no chat open never pays for it.
  useLayoutEffect(() => {
    requestGsap();
  }, []);

  useLayoutEffect(() => {
    const host = hostRef.current;
    queueEntrance(host, reduced);
    return () => cancelEntrance(host);
    // Mount only: the entrance is about arriving, and a later prop change is
    // not an arrival.
  }, []);

  const entryRef = useRef<Entry | null>(null);

  // Nothing joins the loop unless it has something to do. A page of stopped
  // agents, or a user who asked for no motion, runs no timer at all.
  useLayoutEffect(() => {
    if (!motion.alive) return;
    const entry: Entry = { t: built.phase, motion, visible: true, draw };
    entryRef.current = entry;
    const unwatch = watch(hostRef.current, entry);
    const unregister = register(entry);
    return () => {
      unwatch();
      unregister();
      entryRef.current = null;
    };
  }, [built, draw, motion.alive]);

  // A status or activity change moves the *running* entry rather than replacing
  // it, so a bot that starts thinking does not restart its own cycle.
  useLayoutEffect(() => {
    if (entryRef.current) entryRef.current.motion = motion;
    if (!motion.alive) stillFrame();
  }, [motion, stillFrame]);

  /* The eased state change, which is the second of GSAP's two jobs here. React
     has already committed the destination values as inline style — that is the
     no-GSAP path, and it is correct on its own — so the tween's work is to put
     the *previous* values back and ease from them to where the DOM already is.
     `saturate()` is a filter, so a degraded agent drains of colour without
     regenerating a single coordinate. */
  const look = useRef({ sat: motion.sat, opacity: motion.opacity, scale: motion.scale });
  useLayoutEffect(() => {
    const previous = look.current;
    const next = { sat: motion.sat, opacity: motion.opacity, scale: motion.scale };
    look.current = next;
    const svg = svgRef.current;
    if (!svg || reduced) return;
    if (
      previous.sat === next.sat &&
      previous.opacity === next.opacity &&
      previous.scale === next.scale
    ) {
      return;
    }
    // The destination, exactly as React serialised it a moment ago. A tween
    // that never starts is the no-motion path and needs nothing; a tween that
    // throws *after* applying its `from` values has left the previous state on
    // an element React believes it has already updated, and only this puts it
    // back.
    const committed = svg.getAttribute("style");
    const tween = tryGsap((gsap) =>
      transformReadable(svg)
        ? gsap.fromTo(
            svg,
            {
              filter: `saturate(${previous.sat})`,
              opacity: previous.opacity,
              scale: previous.scale,
            },
            {
              filter: `saturate(${next.sat})`,
              opacity: next.opacity,
              scale: next.scale,
              duration: 0.65,
              ease: "power2.out",
              overwrite: "auto",
            },
          )
        : null,
    );
    if (!tween) {
      if (committed !== null) svg.setAttribute("style", committed);
      return;
    }
    return () => {
      // A tween being killed during an unmount is the common case and cannot be
      // allowed to throw out of a cleanup function, where React would treat it
      // as an error during teardown.
      try {
        tween.kill();
      } catch {
        gsapFailed = true;
      }
    };
  }, [motion, reduced]);

  // `useId` is colon-heavy and these ids are referenced as `url(#…)`; the
  // colons survive there, but they do not survive a `querySelector`, and a test
  // or a dev tool reaching for one should not have to know that.
  const reactId = useId();
  const gid = `hav${reactId.replace(/:/g, "")}`;
  const name = label ?? (bot ? `${bot}@${instance}` : instance);

  return (
    <span
      ref={hostRef}
      className={className ? `hav ${className}` : "hav"}
      role="img"
      aria-label={`${name} — ${status}`}
      data-avatar-style={built.style}
      data-avatar-activity={activity}
      style={{ display: "inline-block", lineHeight: 0, width: size, height: size }}
    >
      <svg
        ref={svgRef}
        viewBox={built.viewBox}
        width={size}
        height={size}
        aria-hidden="true"
        focusable="false"
        shapeRendering={built.style === "blob" ? undefined : "crispEdges"}
        style={{
          display: "block",
          transformOrigin: "50% 50%",
          filter: `saturate(${motion.sat.toFixed(3)})`,
          opacity: motion.opacity,
          transform: `scale(${motion.scale})`,
        }}
      >
        {built.style === "sigil" &&
          built.cells.map((cell, i) => (
            <rect
              key={cell.id}
              ref={(node) => {
                rects.current[i] = node;
              }}
              x={cell.x}
              y={cell.y}
              width={cell.w}
              height={cell.h}
              fill={built.pal.tone(cell.tone, 0, 0)}
            />
          ))}

        {built.style === "pixel" && (
          <g
            ref={(node) => {
              pixels.current.root = node;
            }}
          >
            {built.parts.base.map((r) => (
              <rect key={`b${r.y}-${r.x}`} x={r.x} y={r.y} width={r.w} height={1} fill={r.fill} />
            ))}
            {built.parts.eyes.map((frame, fi) => (
              <g
                key={`e${fi}`}
                ref={(node) => {
                  pixels.current.eyes[fi] = node;
                }}
                display={fi === (motion.stopped ? PIXEL_STOPPED : PIXEL_STILL).eye ? "inline" : "none"}
              >
                {frame.map((r) => (
                  <rect key={`${r.y}-${r.x}`} x={r.x} y={r.y} width={r.w} height={1} fill={r.fill} />
                ))}
              </g>
            ))}
            {built.parts.mouths.map((frame, fi) => (
              <g
                key={`m${fi}`}
                ref={(node) => {
                  pixels.current.mouths[fi] = node;
                }}
                display={fi === PIXEL_STILL.mouth ? "inline" : "none"}
              >
                {frame.map((r) => (
                  <rect key={`${r.y}-${r.x}`} x={r.x} y={r.y} width={r.w} height={1} fill={r.fill} />
                ))}
              </g>
            ))}
          </g>
        )}

        {built.style === "blob" && <BlobBody gid={gid} built={built} nodes={blobs} />}
      </svg>
    </span>
  );
}

/** Blob's two layers, split out only because its first paint needs a computed frame. */
function BlobBody({
  gid,
  built,
  nodes,
}: {
  gid: string;
  built: Extract<Built, { style: "blob" }>;
  nodes: RefObject<{
    front: SVGPathElement | null;
    back: SVGPathElement | null;
    gFront: SVGGElement | null;
    gBack: SVGGElement | null;
  }>;
}) {
  const still = useMemo(() => blobFrame(built.shape, 0, FROZEN), [built]);
  return (
    <>
      <defs>
        <linearGradient id={`${gid}a`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={built.pal.a} />
          <stop offset="100%" stopColor={built.pal.b} />
        </linearGradient>
        <linearGradient id={`${gid}h`} x1="0.2" y1="0" x2="0.8" y2="1">
          <stop offset="0%" stopColor={built.pal.glow} stopOpacity="0.85" />
          <stop offset="100%" stopColor={built.pal.a} stopOpacity="0.15" />
        </linearGradient>
      </defs>
      <g
        ref={(node) => {
          nodes.current.gBack = node;
        }}
        transform={`rotate(${(-still.rotation * 0.55).toFixed(2)} 50 50)`}
      >
        <path
          ref={(node) => {
            nodes.current.back = node;
          }}
          d={still.back}
          fill={`url(#${gid}h)`}
          opacity="0.55"
        />
      </g>
      <g
        ref={(node) => {
          nodes.current.gFront = node;
        }}
        transform={`rotate(${still.rotation.toFixed(2)} 50 50)`}
      >
        <path
          ref={(node) => {
            nodes.current.front = node;
          }}
          d={still.front}
          fill={`url(#${gid}a)`}
        />
      </g>
    </>
  );
}
