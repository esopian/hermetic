/**
 * The avatar, mounted (§9.2).
 *
 * `avatar-seed.test.ts` owns the arithmetic. This file owns the three promises
 * the component makes to the rest of the portal, all of which are about the
 * *frame budget* rather than about the picture:
 *
 *   · the mark is on screen before a single frame of animation has run, so it
 *     is right in a snapshot, right on a slow machine and right in the instant
 *     between mount and the first rAF;
 *   · `prefers-reduced-motion: reduce` means no loop at all, in all three
 *     styles — not a loop that draws the same thing;
 *   · a rail of forty avatars that mounts and unmounts as the operator filters
 *     leaves nothing behind. That is the normal case, not the edge one.
 *
 * `requestAnimationFrame` is replaced with a hand-driven fake, which is the only
 * way to assert "the loop stopped": the real one would simply never call back
 * again and the test would pass whether or not it had been cancelled.
 */
import { REDUCED_MOTION_DEFAULT, cleanup, render, setPageHidden, setReducedMotion } from "./dom.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Avatar } from "../src/chat/components/avatar/Avatar.tsx";
import type { AvatarStyle } from "../src/chat/components/avatar/avatar-seed.ts";

const STYLES: AvatarStyle[] = ["sigil", "pixel", "blob"];

const realRaf = globalThis.requestAnimationFrame;
const realCaf = globalThis.cancelAnimationFrame;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let clock: number;

/** Run whatever is queued, once per call, with a plausible 16ms between frames. */
function advance(times = 1): void {
  for (let i = 0; i < times; i++) {
    const due = [...frames.values()];
    frames.clear();
    clock += 16;
    for (const cb of due) cb(clock);
  }
}

/**
 * Reduced motion, as the browser reports it.
 *
 * This is the one suite that turns it *off*: the animation is its subject, so
 * it needs the animating path the rest of the run is deliberately kept out of
 * (`setup.ts` owns the query and defaults it on — happy-dom has no layout, so
 * a tween there only ever throws). Put back in `afterEach`, like every other
 * process-global this suite borrows.
 */
function prefersReducedMotion(on: boolean): void {
  setReducedMotion(on);
}

beforeEach(() => {
  frames = new Map();
  nextFrame = 0;
  clock = 0;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    const id = ++nextFrame;
    frames.set(id, cb);
    return id;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => {
    frames.delete(id);
  }) as typeof cancelAnimationFrame;
  prefersReducedMotion(false);
  // The entrance tween is skipped in a hidden tab by design — "polish nobody is
  // watching is a bug" — and that is exactly what these tests want: GSAP out of
  // the way, so every frame counted below belongs to the draw loop.
  setPageHidden(true);
});

afterEach(() => {
  // A visible page, back for the next file. `setup.ts` resets the flag itself
  // too; this says so where the hiding happens, so the suite reads correctly on
  // its own.
  setPageHidden(false);
  // Before the fakes are put back, so that unmounting still cancels through them.
  cleanup();
  globalThis.requestAnimationFrame = realRaf;
  globalThis.cancelAnimationFrame = realCaf;
  // The suite's default, back for the next file. Not a `deleteProperty` on
  // `document.hidden`, which is what used to stand here: that removed the
  // getter `setup.ts` installs and left every later file's `setPageHidden`
  // writing to a flag nothing reads.
  setReducedMotion(REDUCED_MOTION_DEFAULT);
});

function avatar(over: Partial<React.ComponentProps<typeof Avatar>> = {}) {
  return (
    <Avatar
      fleet_id="fxtr0001"
      instance="atlas"
      bot="researcher"
      size={32}
      status="ready"
      activity="idle"
      {...over}
    />
  );
}

describe("first paint", () => {
  test("every style has drawn its mark before a frame has run", () => {
    for (const style of STYLES) {
      const view = render(avatar({ style }));
      const svg = view.container.querySelector("svg");
      expect(svg).not.toBeNull();
      // Nothing has been ticked yet: the loop has only been *queued*.
      expect(clock).toBe(0);
      if (style === "blob") {
        const paths = view.container.querySelectorAll("path");
        expect(paths).toHaveLength(2);
        for (const path of paths) expect(path.getAttribute("d")?.startsWith("M")).toBe(true);
        expect(view.container.querySelectorAll("linearGradient")).toHaveLength(2);
      } else {
        const rects = view.container.querySelectorAll("rect");
        expect(rects.length).toBeGreaterThan(0);
        for (const rect of rects) expect(rect.getAttribute("fill")).toBeTruthy();
      }
      view.unmount();
    }
  });

  test("the sigil is squares only — no curve reaches the screen", () => {
    const view = render(avatar({ style: "sigil" }));
    expect(view.container.querySelectorAll("path,circle,ellipse")).toHaveLength(0);
    expect(view.container.querySelector("svg")?.getAttribute("shape-rendering")).toBe("crispEdges");
  });

  test("it says what it is to a screen reader, and the mark itself is decoration", () => {
    const view = render(avatar({ status: "degraded" }));
    const host = view.container.querySelector("[role=img]");
    expect(host?.getAttribute("aria-label")).toBe("researcher@atlas — degraded");
    expect(view.container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  test("the same key paints the same mark on a second mount", () => {
    const first = render(avatar({ style: "sigil" }));
    const before = [...first.container.querySelectorAll("rect")].map((r) => r.outerHTML);
    first.unmount();
    const second = render(avatar({ style: "sigil" }));
    expect([...second.container.querySelectorAll("rect")].map((r) => r.outerHTML)).toEqual(before);
  });

  test("a different bot on the same box paints a different mark", () => {
    const a = render(avatar({ style: "sigil", bot: "researcher" }));
    const marks = [...a.container.querySelectorAll("rect")].map((r) => r.getAttribute("x")).join();
    a.unmount();
    const b = render(avatar({ style: "sigil", bot: "ops-writer" }));
    expect([...b.container.querySelectorAll("rect")].map((r) => r.getAttribute("x")).join()).not.toBe(
      marks,
    );
  });

  test("status drains the material without touching the geometry", () => {
    const ready = render(avatar({ style: "sigil" }));
    const shape = [...ready.container.querySelectorAll("rect")].map((r) => r.getAttribute("x")).join();
    expect(ready.container.querySelector("svg")?.getAttribute("style")).toContain("saturate(1.000)");
    ready.unmount();

    const stopped = render(avatar({ style: "sigil", status: "stopped" }));
    expect([...stopped.container.querySelectorAll("rect")].map((r) => r.getAttribute("x")).join()).toBe(
      shape,
    );
    const style = stopped.container.querySelector("svg")?.getAttribute("style") ?? "";
    expect(style).toContain("saturate(0.000)");
    expect(style).toContain("opacity: 0.45");
  });
});

describe("the loop", () => {
  test("an idle sigil breathes once the frames start arriving", () => {
    const view = render(avatar({ style: "sigil" }));
    const rect = view.container.querySelector("rect")!;
    // Opacity is not in the markup at all: the still frame *is* full strength.
    expect(rect.getAttribute("opacity")).toBeNull();
    advance(3);
    const drawn = rect.getAttribute("opacity");
    expect(drawn).not.toBeNull();
    expect(Number(drawn)).toBeGreaterThan(0);
    expect(Number(drawn)).toBeLessThanOrEqual(1);
  });

  test("a streaming pixel face opens its mouth", () => {
    const view = render(avatar({ style: "pixel", activity: "streaming" }));
    const shown = () =>
      [...view.container.querySelectorAll("g > g")].map((g) => g.getAttribute("display")).join();
    // Sampled every frame rather than compared against one later instant: the
    // mouth is a square wave, so a single snapshot can land back on the frame it
    // started from and prove nothing.
    const seen = new Set([shown()]);
    for (let i = 0; i < 40; i++) {
      advance();
      seen.add(shown());
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  test("a thinking blob keeps morphing", () => {
    const view = render(avatar({ style: "blob", activity: "thinking" }));
    const path = view.container.querySelector("path")!;
    const before = path.getAttribute("d");
    advance(5);
    expect(path.getAttribute("d")).not.toBe(before);
  });

  test("a stopped agent never joins the loop", () => {
    render(avatar({ style: "sigil", status: "stopped" }));
    expect(frames.size).toBe(0);
  });
});

describe("prefers-reduced-motion: reduce", () => {
  test("no style starts a loop, and each one still has its mark", () => {
    prefersReducedMotion(true);
    for (const style of STYLES) {
      const view = render(avatar({ style, activity: "streaming" }));
      expect(frames.size).toBe(0);
      const marks = view.container.querySelectorAll(style === "blob" ? "path" : "rect");
      expect(marks.length).toBeGreaterThan(0);
      // And nothing moves it: there is no callback to run, and running the
      // queue anyway changes nothing.
      const before = [...marks].map((m) => m.outerHTML);
      advance(10);
      expect([...marks].map((m) => m.outerHTML)).toEqual(before);
      view.unmount();
    }
  });

  test("the pixel face rests with its eyes open — it is not a stopped box", () => {
    prefersReducedMotion(true);
    const view = render(avatar({ style: "pixel", activity: "thinking" }));
    const eyes = [...view.container.querySelectorAll("g > g")].slice(0, 5);
    expect(eyes.map((g) => g.getAttribute("display"))).toEqual([
      "inline",
      "none",
      "none",
      "none",
      "none",
    ]);
  });

  test("a stopped box, by contrast, shuts them", () => {
    prefersReducedMotion(true);
    const view = render(avatar({ style: "pixel", status: "stopped" }));
    const eyes = [...view.container.querySelectorAll("g > g")].slice(0, 5);
    expect(eyes.map((g) => g.getAttribute("display"))).toEqual([
      "none",
      "none",
      "none",
      "none",
      "inline",
    ]);
  });
});

describe("unmounting", () => {
  test("one avatar takes its loop with it", () => {
    const view = render(avatar({ style: "sigil" }));
    advance(2);
    expect(frames.size).toBe(1);
    view.unmount();
    expect(frames.size).toBe(0);
  });

  test("an unmounted avatar is not drawn again", () => {
    const view = render(avatar({ style: "sigil" }));
    const stay = render(avatar({ style: "sigil", instance: "granite" }));
    advance(2);
    const orphan = view.container.querySelector("rect")!;
    view.unmount();
    const frozen = orphan.getAttribute("opacity");
    advance(6);
    expect(orphan.getAttribute("opacity")).toBe(frozen);
    // …while the one still mounted goes on drawing, so the assertion above is
    // about the registry and not about the loop having died for other reasons.
    expect(frames.size).toBe(1);
    stay.unmount();
    expect(frames.size).toBe(0);
  });

  test("a rail of forty mounts and unmounts leaving nothing running", () => {
    const rail = render(
      <div>
        {Array.from({ length: 40 }, (_, i) => (
          <Avatar
            key={i}
            fleet_id="fxtr0001"
            instance={`box-${i % 7}`}
            bot={`bot-${i}`}
            size={18 + (i % 27)}
            status="ready"
            activity={i % 3 === 0 ? "streaming" : "idle"}
            style={STYLES[i % 3]}
          />
        ))}
      </div>,
    );
    expect(rail.container.querySelectorAll("[role=img]")).toHaveLength(40);
    // One loop for forty avatars, not forty loops.
    expect(frames.size).toBe(1);
    advance(5);
    expect(frames.size).toBe(1);
    rail.unmount();
    expect(frames.size).toBe(0);
  });
});

/**
 * The transition path, with the real library loaded.
 *
 * This block exists because of a bug found downstream and not here: `Avatar`
 * tweens through GSAP on a status or activity change, GSAP's CSSPlugin reads
 * `getComputedStyle().transform`, and happy-dom answers with the *inline*
 * `scale(1)` this component writes rather than a computed `matrix(…)`. GSAP's
 * parser calls `.substr(7).match(…)` on that, gets null, and throws out of the
 * tween's constructor — which is to say, out of a layout effect, which is to
 * say, out of the render. A turn starting flips every visible face to
 * `streaming` at once, so the most ordinary interaction in the chat view was
 * the one that fired it.
 *
 * The suite above never caught it because every test mounted and asserted
 * without ever transitioning. So these tests do nothing but transition, and
 * they do it against the real `Avatar` with the real GSAP resolved — a stub
 * would test the stub.
 *
 * They run last on purpose: they are the only tests here that let GSAP's own
 * ticker wake, and the last of them deliberately breaks GSAP for good.
 */
describe("state changes, with GSAP really loaded", () => {
  const STATUSES = ["ready", "pending", "degraded", "error", "stopped", "destroyed"] as const;
  const ACTIVITIES = ["idle", "thinking", "streaming", "muted"] as const;

  /** Mount once to trigger the dynamic import, then wait for it to land. */
  async function gsapLoaded() {
    const primer = render(avatar());
    await import("gsap");
    // A macrotask, so `Avatar`'s own `.then` has assigned the module.
    await new Promise((resolve) => setTimeout(resolve, 0));
    primer.unmount();
  }

  test("GSAP really is in play — the entrance tweens the hosts it can read", async () => {
    await gsapLoaded();
    const { gsap } = await import("gsap");
    // The entrance is skipped in a hidden tab by design, and `beforeEach` hides
    // the document so the rest of this file can count frames. Not here. Asked
    // through `setPageHidden` rather than by deleting the property, which took
    // `setup.ts`'s getter away for good and left every later file's
    // `setPageHidden` writing to a flag nothing read.
    setPageHidden(false);
    const view = render(
      <div>
        <Avatar fleet_id="f" instance="atlas" bot="a" size={24} status="ready" activity="idle" />
        <Avatar fleet_id="f" instance="atlas" bot="b" size={24} status="ready" activity="idle" />
      </div>,
    );
    const hosts = [...view.container.querySelectorAll("[role=img]")];
    expect(hosts).toHaveLength(2);
    // The batch is flushed in a microtask — that is what lets a whole rail
    // enter as one tween — so it has not run yet at the end of `render`.
    await Promise.resolve();
    // If this is empty, every assertion below about GSAP is vacuous.
    expect(hosts.some((host) => gsap.getTweensOf(host).length > 0)).toBe(true);
    for (const host of hosts) gsap.killTweensOf(host);
  });

  test("every status and activity change survives, in every style", async () => {
    await gsapLoaded();
    for (const style of STYLES) {
      const view = render(avatar({ style }));
      for (const status of STATUSES) {
        for (const activity of ACTIVITIES) {
          view.rerender(avatar({ style, status, activity }));
          const host = view.container.querySelector("[role=img]");
          expect(host?.getAttribute("aria-label")).toBe(`researcher@atlas — ${status}`);
          const marks = view.container.querySelectorAll(style === "blob" ? "path" : "rect");
          expect(marks.length).toBeGreaterThan(0);
        }
      }
      view.unmount();
    }
  });

  test("a tween that cannot run leaves the state React committed, not the one it came from", async () => {
    await gsapLoaded();
    const view = render(avatar({ style: "sigil", status: "ready", activity: "idle" }));
    view.rerender(avatar({ style: "sigil", status: "stopped", activity: "idle" }));
    const style = view.container.querySelector("svg")?.getAttribute("style") ?? "";
    expect(style).toContain("saturate(0.000)");
    expect(style).toContain("opacity: 0.45");
  });

  test("a getComputedStyle that throws costs the entrance, not the rail", async () => {
    await gsapLoaded();
    // Visible, so the entrance is not skipped — see the note above.
    setPageHidden(false);
    const real = globalThis.getComputedStyle;
    globalThis.getComputedStyle = (() => {
      throw new Error("this document has no computed styles");
    }) as typeof getComputedStyle;
    try {
      const view = render(
        <div>
          <Avatar fleet_id="f" instance="ember" bot="a" size={24} status="ready" activity="idle" />
          <Avatar fleet_id="f" instance="ember" bot="b" size={24} status="ready" activity="idle" />
        </div>,
      );
      const hosts = [...view.container.querySelectorAll("[role=img]")] as HTMLElement[];
      expect(hosts).toHaveLength(2);
      for (const host of hosts) {
        // Not stuck at the entrance's start values, which is the failure that
        // would hurt: a rail of invisible avatars.
        expect(host.style.opacity).toBe("");
        // `rect, path` rather than `rect`: these avatars take the default style,
        // and the default is a choice the owner can change. `sigil` draws cells,
        // `blob` draws two paths — the assertion here is "something was drawn",
        // which is what this test is actually about, so it must not break the
        // day the default moves.
        expect(host.querySelectorAll("rect, path").length).toBeGreaterThan(0);
      }
    } finally {
      globalThis.getComputedStyle = real;
    }
  });

  /**
   * Last, and destructive: it forces the throw that the probe in
   * `transformReadable` is designed to see coming, by answering with a string
   * that passes the matrix check and then breaks GSAP's parser — the exact
   * shape of happy-dom's failure, forced rather than depended on. The
   * component's guard reacts by disabling GSAP for the rest of the process,
   * which is why nothing may run after it.
   */
  test("a GSAP that throws anyway is disabled rather than fatal", async () => {
    await gsapLoaded();
    const real = globalThis.getComputedStyle;
    globalThis.getComputedStyle = ((el: Element, pseudo?: string | null) => {
      const computed = real(el, pseudo ?? undefined);
      return new Proxy(computed, {
        get(target, prop) {
          if (prop === "transform") return "matrix(oops)";
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as typeof getComputedStyle;
    try {
      const view = render(avatar({ style: "sigil" }));
      view.rerender(avatar({ style: "sigil", status: "degraded", activity: "streaming" }));
      expect(view.container.querySelectorAll("rect").length).toBeGreaterThan(0);
      const style = view.container.querySelector("svg")?.getAttribute("style") ?? "";
      expect(style).toContain("saturate(0.864)");
      // And it stays down: a second change goes straight to the no-motion path.
      view.rerender(avatar({ style: "sigil", status: "ready", activity: "idle" }));
      expect(view.container.querySelector("svg")?.getAttribute("style")).toContain("saturate(1.000)");
    } finally {
      globalThis.getComputedStyle = real;
    }
  });
});
