/**
 * The avatar's arithmetic, with no DOM anywhere near it (§9.2).
 *
 * Everything an avatar *is* — its key, its palette, its cells, its parts, its
 * five state numbers — is a pure function, and this file is why that was worth
 * insisting on: the properties below are the ones the design actually promises
 * ("renaming a bot does not change its face", "no avatar competes with the
 * accent colour", "turning colour-by-instance on changes a hue and never a
 * shape"), and none of them needs a component to be mounted to be true.
 *
 * `avatar.dom.test.tsx` owns the other half: that a mounted component paints
 * this data before any animation runs, and that it stops when it is unmounted.
 */
import { describe, expect, test } from "bun:test";
import {
  RESERVED_HUE,
  avatarMotion,
  avatarPalette,
  avatarSeed,
  avatarSeeds,
} from "../src/chat/components/avatar/avatar-seed.ts";
import { blobPath, blobShape } from "../src/chat/components/avatar/blob.ts";
import {
  PIXEL_STILL,
  PIXEL_STOPPED,
  pixelFrame,
  pixelParts,
} from "../src/chat/components/avatar/pixel.ts";
import { SIGIL_HOME, sigilCells, sigilFrame } from "../src/chat/components/avatar/sigil.ts";

/** A palette for one key, from a fresh stream every time. */
function paletteFor(key: string, light: boolean, family = true) {
  const { shape, hue } = avatarSeeds(key, family);
  return avatarPalette(shape, light, hue);
}

/** The palette's data, without the `tone` closure, so two of them can be compared. */
function colours(pal: ReturnType<typeof paletteFor>) {
  const { h, h2, s, l, a, b, glow, line, ink, paper } = pal;
  return { h, h2, s, l, a, b, glow, line, ink, paper };
}

/** A fingerprint of a sigil's geometry, which is what "the same mark" means. */
function sigilFingerprint(key: string, family = true): string {
  const { shape, hue } = avatarSeeds(key, family);
  avatarPalette(shape, false, hue);
  return sigilCells(shape)
    .map((c) => `${c.x},${c.y},${c.w},${c.h},${c.tone}`)
    .join("|");
}

/** A spread of realistic keys: several fleets, several boxes, several bots each. */
function sampleKeys(): string[] {
  const keys: string[] = [];
  for (const fleet of ["fxtr0001", "sg7k2m4p", "a1b2c3d4"]) {
    for (const instance of ["atlas", "corvid", "ember", "juniper", "granite", "cinder", "cinder-2"]) {
      for (const bot of ["default", "researcher", "ops-writer", "reviewer", ""]) {
        keys.push(avatarSeed(fleet, instance, bot));
      }
    }
  }
  return keys;
}

describe("the identity key", () => {
  test("is the three immutable parts, in order", () => {
    expect(avatarSeed("fxtr0001", "atlas", "researcher")).toBe("fxtr0001/atlas/researcher");
  });

  test("drops the bot for an instance-level avatar, so a box and its default bot differ", () => {
    expect(avatarSeed("fxtr0001", "atlas", "")).toBe("fxtr0001/atlas");
    expect(sigilFingerprint("fxtr0001/atlas")).not.toBe(sigilFingerprint("fxtr0001/atlas/default"));
  });

  test("the same bot on two boxes, and the same box in two fleets, are different marks", () => {
    expect(sigilFingerprint(avatarSeed("fxtr0001", "atlas", "researcher"))).not.toBe(
      sigilFingerprint(avatarSeed("fxtr0001", "granite", "researcher")),
    );
    expect(sigilFingerprint(avatarSeed("fxtr0001", "atlas", "default"))).not.toBe(
      sigilFingerprint(avatarSeed("sg7k2m4p", "atlas", "default")),
    );
  });

  test("a reclaimed name is its own agent, not the dead one's", () => {
    expect(sigilFingerprint(avatarSeed("fxtr0001", "cinder", "default"))).not.toBe(
      sigilFingerprint(avatarSeed("fxtr0001", "cinder-2", "default")),
    );
  });

  test("is stable: the same key gives the same mark and the same palette, every time", () => {
    for (const key of sampleKeys().slice(0, 12)) {
      expect(sigilFingerprint(key)).toBe(sigilFingerprint(key));
      expect(colours(paletteFor(key, false))).toEqual(colours(paletteFor(key, false)));
    }
  });

  test("nearly all of a realistic fleet's keys land on distinct marks", () => {
    const marks = new Set(sampleKeys().map((k) => sigilFingerprint(k)));
    // 105 keys; a handful of collisions in a 2^25-ish space would be bad luck,
    // a lot of them would mean the seed is not reaching the geometry.
    expect(marks.size).toBeGreaterThan(sampleKeys().length * 0.9);
  });
});

describe("the palette", () => {
  test("never lands either hue in the accent's reserved band", () => {
    for (const key of sampleKeys()) {
      for (const light of [true, false]) {
        for (const family of [true, false]) {
          const pal = paletteFor(key, light, family);
          for (const hue of [pal.h, pal.h2]) {
            expect(hue).toBeGreaterThanOrEqual(0);
            expect(hue).toBeLessThan(360);
            const reserved = hue > RESERVED_HUE.from && hue < RESERVED_HUE.to;
            expect(reserved).toBe(false);
          }
        }
      }
    }
  });

  test("pins saturation to 56–80% and lightness to its theme's band", () => {
    for (const key of sampleKeys()) {
      const dark = paletteFor(key, false);
      expect(dark.s).toBeGreaterThanOrEqual(56);
      expect(dark.s).toBeLessThan(80);
      expect(dark.l).toBeGreaterThanOrEqual(55);
      expect(dark.l).toBeLessThan(66);

      const light = paletteFor(key, true);
      expect(light.l).toBeGreaterThanOrEqual(44);
      expect(light.l).toBeLessThan(52);
    }
  });

  test("a theme flip changes the lightness and nothing about the geometry", () => {
    for (const key of sampleKeys().slice(0, 8)) {
      const dark = paletteFor(key, false);
      const light = paletteFor(key, true);
      expect(light.h).toBe(dark.h);
      expect(light.h2).toBe(dark.h2);
      expect(light.l).not.toBe(dark.l);
    }
  });

  test("tone(0,0,0) is the primary fill and tone(1,0,0) the secondary", () => {
    const pal = paletteFor("fxtr0001/atlas/default", false);
    expect(pal.tone(0, 0, 0)).toBe(pal.a);
    expect(pal.tone(1, 0, 0)).toBe(pal.b);
  });
});

describe("colour by instance", () => {
  const atlasA = avatarSeed("fxtr0001", "atlas", "researcher");
  const atlasB = avatarSeed("fxtr0001", "atlas", "ops-writer");
  const granite = avatarSeed("fxtr0001", "granite", "researcher");

  test("two bots on one box share a hue, and two boxes do not", () => {
    expect(paletteFor(atlasB, false).h).toBe(paletteFor(atlasA, false).h);
    expect(paletteFor(granite, false).h).not.toBe(paletteFor(atlasA, false).h);
  });

  test("shape still separates the bots inside one box", () => {
    expect(sigilFingerprint(atlasA)).not.toBe(sigilFingerprint(atlasB));
  });

  test("turning it off changes hues and leaves every geometry untouched", () => {
    const hues = sampleKeys().map((k) => [paletteFor(k, false, true).h, paletteFor(k, false, false).h]);
    expect(hues.some(([on, off]) => on !== off)).toBe(true);
    // The shape stream is stepped either way, which is what makes the option a
    // colour setting rather than a re-roll of every avatar in the fleet.
    for (const key of sampleKeys()) {
      expect(sigilFingerprint(key, false)).toBe(sigilFingerprint(key, true));
    }
  });
});

describe("the five numbers", () => {
  test("thinking and streaming are more of the same thing, in that order", () => {
    const idle = avatarMotion("ready", "idle");
    const thinking = avatarMotion("ready", "thinking");
    const streaming = avatarMotion("ready", "streaming");
    expect(thinking.rate).toBeGreaterThan(idle.rate);
    expect(streaming.rate).toBeGreaterThan(thinking.rate);
    expect(streaming.amp).toBeGreaterThan(thinking.amp);
    expect(streaming.scale).toBeGreaterThan(idle.scale);
  });

  test("muted is quieter than idle, not busier", () => {
    const muted = avatarMotion("ready", "muted");
    expect(muted.rate).toBeLessThan(avatarMotion("ready", "idle").rate);
    expect(muted.sat).toBeLessThan(1);
  });

  test("a stopped box stops the clock; a degraded one only drains", () => {
    for (const status of ["stopped", "destroyed"] as const) {
      const m = avatarMotion(status, "streaming");
      expect(m.alive).toBe(false);
      expect(m.stopped).toBe(true);
      expect(m.rate).toBe(0);
    }
    const degraded = avatarMotion("degraded", "thinking");
    expect(degraded.alive).toBe(true);
    expect(degraded.stopped).toBe(false);
    expect(degraded.sat).toBeLessThan(avatarMotion("ready", "thinking").sat);
  });

  test("reduced motion stops the clock without pretending the agent is stopped", () => {
    const m = avatarMotion("ready", "streaming", true);
    expect(m.alive).toBe(false);
    expect(m.stopped).toBe(false);
    expect(m.opacity).toBe(1);
  });
});

describe("sigil", () => {
  const cells = sigilCells(avatarSeeds("fxtr0001/atlas/default", true).shape);

  test("draws between one and twenty-five cells, all inside the viewBox", () => {
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.length).toBeLessThanOrEqual(25);
    for (const cell of cells) {
      expect(cell.x).toBeGreaterThanOrEqual(0);
      expect(cell.y).toBeGreaterThanOrEqual(0);
      expect(cell.x + cell.w).toBeLessThanOrEqual(100);
      expect(cell.y + cell.h).toBeLessThanOrEqual(100);
    }
  });

  test("a frozen sigil is seated, whole and at full strength", () => {
    const frozen = avatarMotion("stopped", "streaming");
    for (const cell of cells) {
      for (const t of [0, 3.7, 91.2]) {
        expect(sigilFrame(cell, t, frozen)).toEqual(SIGIL_HOME);
      }
    }
  });

  test("streaming holds every cell in place and moves the material instead", () => {
    const m = avatarMotion("ready", "streaming");
    const seen = new Set<string>();
    for (const t of [0, 0.4, 1.1, 2.6, 5.5]) {
      const f = sigilFrame(cells[0]!, t, m);
      expect([f.kx, f.ky, f.dx, f.dy, f.rot]).toEqual([1, 1, 0, 0, 0]);
      expect(f.opacity).toBe(1);
      seen.add(`${f.dh.toFixed(3)}/${f.dl.toFixed(3)}`);
    }
    expect(seen.size).toBeGreaterThan(3);
  });

  test("thinking takes the mark apart — cells leave home and come back", () => {
    const m = avatarMotion("ready", "thinking");
    let away = 0;
    let home = 0;
    for (let i = 0; i < 400; i++) {
      const f = sigilFrame(cells[0]!, i * 0.05, m);
      if (f.kx === 1 && f.dx === 0 && f.dy === 0 && f.rot === 0 && f.opacity === 1) home++;
      else away++;
    }
    expect(away).toBeGreaterThan(20);
    expect(home).toBeGreaterThan(20);
  });

  test("idle only breathes: a quiet opacity wave, nothing moves", () => {
    const m = avatarMotion("ready", "idle");
    const opacities = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const f = sigilFrame(cells[0]!, i * 0.1, m);
      expect([f.kx, f.ky, f.dx, f.dy, f.rot, f.dh, f.dl]).toEqual([1, 1, 0, 0, 0, 0, 0]);
      expect(f.opacity).toBeGreaterThanOrEqual(0.6);
      expect(f.opacity).toBeLessThanOrEqual(1);
      opacities.add(f.opacity.toFixed(3));
    }
    expect(opacities.size).toBeGreaterThan(10);
  });
});

describe("pixel crew", () => {
  const key = "fxtr0001/atlas/default";
  const { shape, hue } = avatarSeeds(key, true);
  const pal = avatarPalette(shape, false, hue);
  const parts = pixelParts(shape, pal);

  test("composes a face out of the parts library, once, as flat runs", () => {
    expect(parts.base.length).toBeGreaterThan(8);
    expect(parts.eyes).toHaveLength(5);
    expect(parts.mouths).toHaveLength(2);
    for (const rect of parts.base) {
      expect(rect.w).toBeGreaterThan(0);
      expect(rect.x + rect.w).toBeLessThanOrEqual(16);
      expect(rect.fill).toBeTruthy();
    }
  });

  test("a stopped box has its eyes shut and a reduced-motion one does not", () => {
    expect(pixelFrame(parts, 12.5, avatarMotion("stopped", "thinking"))).toEqual(PIXEL_STOPPED);
    expect(pixelFrame(parts, 12.5, avatarMotion("ready", "thinking", true))).toEqual(PIXEL_STILL);
  });

  test("thinking looks up and scans; idle only blinks", () => {
    const thinking = new Set<number>();
    const idle = new Set<number>();
    for (let i = 0; i < 300; i++) {
      thinking.add(pixelFrame(parts, i * 0.13, avatarMotion("ready", "thinking")).eye);
      idle.add(pixelFrame(parts, i * 0.13, avatarMotion("ready", "idle")).eye);
    }
    expect([...thinking].sort()).toEqual([1, 2, 3, 4]);
    expect([...idle].sort()).toEqual([0, 4]);
  });

  test("streaming is the only state that moves the mouth", () => {
    const talking = new Set<number>();
    const quiet = new Set<number>();
    for (let i = 0; i < 80; i++) {
      talking.add(pixelFrame(parts, i * 0.07, avatarMotion("ready", "streaming")).mouth);
      quiet.add(pixelFrame(parts, i * 0.07, avatarMotion("ready", "thinking")).mouth);
    }
    expect([...talking].sort()).toEqual([0, 1]);
    expect([...quiet]).toEqual([0]);
  });
});

describe("blob", () => {
  const shape = blobShape(avatarSeeds("fxtr0001/atlas/default", true).shape);

  test("chooses 7–10 points behind and 8–12 in front", () => {
    expect(shape.back.length).toBeGreaterThanOrEqual(7);
    expect(shape.back.length).toBeLessThanOrEqual(10);
    expect(shape.front.length).toBeGreaterThanOrEqual(8);
    expect(shape.front.length).toBeLessThanOrEqual(12);
  });

  test("emits one closed cubic spline with a segment per point", () => {
    const d = blobPath(shape.front, 0, 46, 1);
    expect(d.startsWith("M")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    expect(d.split("C")).toHaveLength(shape.front.length + 1);
  });

  test("with the amplitude at zero the pose is fixed — which is the still frame", () => {
    expect(blobPath(shape.front, 0, 46, 0)).toBe(blobPath(shape.front, 88.4, 46, 0));
  });

  test("with the amplitude up it never returns to a pose you have seen", () => {
    const poses = new Set<string>();
    for (let i = 0; i < 200; i++) poses.add(blobPath(shape.front, i * 0.07, 46, 1));
    expect(poses.size).toBe(200);
  });
});
