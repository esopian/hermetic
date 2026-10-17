/**
 * The page bundle's build options (`view-build.ts`).
 *
 * The property worth pinning: only a `dev` build keeps React's development
 * build. A release, or an environment Hutch did not name, inlines
 * `process.env.NODE_ENV` as `"production"`, because Bun's bundler otherwise
 * inlines `"development"` and the release ships dev React.
 */
import { describe, expect, test } from "bun:test";
import config from "../electrobun.config.ts";
import { BUILD_ENV } from "../renderer.ts";
import { viewBuild } from "../view-build.ts";

const PRODUCTION = { define: { "process.env.NODE_ENV": '"production"' } };

describe("viewBuild", () => {
  for (const buildEnv of ["stable", "canary", "", undefined]) {
    test(`${buildEnv === undefined ? "no build env" : JSON.stringify(buildEnv)}: production React`, () => {
      expect(viewBuild({ [BUILD_ENV]: buildEnv })).toEqual(PRODUCTION);
    });
  }

  test("dev: the development React, nothing defined", () => {
    expect(viewBuild({ [BUILD_ENV]: "dev" })).toEqual({});
  });

  test("the config spreads it into the page's view", () => {
    // The suite runs with no build env, which is the release case.
    expect(process.env[BUILD_ENV]).toBeUndefined();
    expect(config.build.views.main.define).toEqual(PRODUCTION.define);
  });
});
