/**
 * Which renderer a build gets (`renderer.ts`).
 *
 * The property worth pinning is the asymmetry: only a `dev` build may bundle
 * CEF and open a DevTools port, and anything else — canary, stable, or an
 * environment Hutch did not name — ships WKWebView, with a request for CEF
 * refused loudly rather than honoured or ignored. Linux keeps the same
 * asymmetry and the same CEF default in a dev build.
 */
import { describe, expect, test } from "bun:test";
import config from "../electrobun.config.ts";
import {
  BUILD_ENV,
  CDP_PORT_ENV,
  cdpPort,
  DEFAULT_CDP_PORT,
  linuxRenderer,
  macRenderer,
  RENDERER_ENV,
  type RendererKeys,
} from "../renderer.ts";

const NATIVE: RendererKeys = { bundleCEF: false, defaultRenderer: "native" };

describe("macRenderer", () => {
  for (const buildEnv of ["stable", "canary", undefined]) {
    test(`${buildEnv ?? "no build env"}: native, no CEF, no DevTools port`, () => {
      expect(macRenderer({ [BUILD_ENV]: buildEnv })).toEqual(NATIVE);
      expect(macRenderer({ [BUILD_ENV]: buildEnv, [RENDERER_ENV]: "native" })).toEqual(NATIVE);
    });

    test(`${buildEnv ?? "no build env"}: asking for CEF fails the build`, () => {
      expect(() => macRenderer({ [BUILD_ENV]: buildEnv, [RENDERER_ENV]: "cef" })).toThrow(
        /dev builds only/,
      );
    });
  }

  test("dev: CEF by default, DevTools on the default port", () => {
    expect(macRenderer({ [BUILD_ENV]: "dev" })).toEqual({
      bundleCEF: true,
      defaultRenderer: "cef",
      chromiumFlags: { "remote-debugging-port": String(DEFAULT_CDP_PORT) },
    });
  });

  test("dev: HERMETIC_RENDERER=native opts out, CEF not bundled", () => {
    expect(macRenderer({ [BUILD_ENV]: "dev", [RENDERER_ENV]: "native" })).toEqual(NATIVE);
  });

  test("dev: the port follows HERMETIC_CDP_PORT", () => {
    const mac = macRenderer({ [BUILD_ENV]: "dev", [CDP_PORT_ENV]: "9444" });
    expect(mac.chromiumFlags).toEqual({ "remote-debugging-port": "9444" });
  });

  test("an unknown renderer is refused, not defaulted", () => {
    expect(() => macRenderer({ [BUILD_ENV]: "dev", [RENDERER_ENV]: "webkit" })).toThrow(
      /must be "cef" or "native"/,
    );
  });
});

describe("linuxRenderer", () => {
  for (const buildEnv of ["stable", "canary", undefined]) {
    test(`${buildEnv ?? "no build env"}: native, no CEF, no DevTools port`, () => {
      expect(linuxRenderer({ [BUILD_ENV]: buildEnv })).toEqual(NATIVE);
      expect(linuxRenderer({ [BUILD_ENV]: buildEnv, [RENDERER_ENV]: "native" })).toEqual(NATIVE);
    });

    test(`${buildEnv ?? "no build env"}: asking for CEF fails the build`, () => {
      expect(() => linuxRenderer({ [BUILD_ENV]: buildEnv, [RENDERER_ENV]: "cef" })).toThrow(
        /dev builds only/,
      );
    });
  }

  test("dev: CEF by default, DevTools on the default port", () => {
    expect(linuxRenderer({ [BUILD_ENV]: "dev" })).toEqual({
      bundleCEF: true,
      defaultRenderer: "cef",
      chromiumFlags: { "remote-debugging-port": String(DEFAULT_CDP_PORT) },
    });
  });

  test("dev: HERMETIC_RENDERER=native opts out, CEF not bundled", () => {
    expect(linuxRenderer({ [BUILD_ENV]: "dev", [RENDERER_ENV]: "native" })).toEqual(NATIVE);
  });

  test("dev: HERMETIC_RENDERER=cef bundles CEF, DevTools on the default port", () => {
    expect(linuxRenderer({ [BUILD_ENV]: "dev", [RENDERER_ENV]: "cef" })).toEqual({
      bundleCEF: true,
      defaultRenderer: "cef",
      chromiumFlags: { "remote-debugging-port": String(DEFAULT_CDP_PORT) },
    });
  });

  test("dev: the port follows HERMETIC_CDP_PORT", () => {
    const linux = linuxRenderer({
      [BUILD_ENV]: "dev",
      [RENDERER_ENV]: "cef",
      [CDP_PORT_ENV]: "9444",
    });
    expect(linux.chromiumFlags).toEqual({ "remote-debugging-port": "9444" });
  });

  test("an unknown renderer is refused, not defaulted", () => {
    expect(() => linuxRenderer({ [BUILD_ENV]: "dev", [RENDERER_ENV]: "webkit" })).toThrow(
      /must be "cef" or "native"/,
    );
  });
});

describe("cdpPort", () => {
  test("blank is the default", () => {
    expect(cdpPort({})).toBe(DEFAULT_CDP_PORT);
    expect(cdpPort({ [CDP_PORT_ENV]: " " })).toBe(DEFAULT_CDP_PORT);
  });

  for (const bad of ["80", "70000", "9.5", "port"]) {
    test(`"${bad}" is refused`, () => {
      expect(() => cdpPort({ [CDP_PORT_ENV]: bad })).toThrow(/1024 to 65535/);
    });
  }
});

describe("electrobun.config.ts", () => {
  test("outside a Hutch build (no build env) the config is the release one", () => {
    expect(process.env[BUILD_ENV]).toBeUndefined();
    expect(config.build.mac).toMatchObject(NATIVE);
    expect("chromiumFlags" in config.build.mac).toBe(false);
    expect(config.build.linux).toEqual(NATIVE);
  });
});
