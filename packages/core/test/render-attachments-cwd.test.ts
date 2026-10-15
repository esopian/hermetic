/**
 * The pin chat attachments stand on (plan §11): a dashboard session's working
 * directory is `$HERMES_HOME`.
 *
 * A turn's attachment block names each file relative to `$HERMES_HOME`
 * (`inbox/<date>/<f_id>/<name>`), and Hermes resolves an `@file:` reference
 * against the session's cwd and refuses one that resolves outside it. The
 * dashboard's sessions inherit the dashboard process's cwd, which is its unit's
 * `WorkingDirectory`, unless `terminal.cwd` or `TERMINAL_CWD` moves it. So the
 * unit must say `$HERMES_HOME`, and nothing rendered may set either override:
 * a change to any of the three silently breaks every attached file.
 */
import { describe, expect, test } from "bun:test";
import { renderAgentConfig } from "../src/render/render.ts";
import { Provider } from "../src/schema/index.ts";
import {
  HERMES_DASHBOARD_UNIT,
  HERMES_GATEWAY_DROPIN,
  HERMES_HOME,
  HERMES_MANAGED_CONFIG,
  HERMES_SEED_CONFIG,
} from "../src/shared/hermes.ts";

function render(provider: (typeof Provider.options)[number]) {
  return renderAgentConfig({
    name: "atlas",
    size: "small",
    provider,
    secrets_mode: "none",
    tailnet: "hermetic.ts.net",
    hermes_version: "0.21.5",
    hermes_ref: "v2026.9.24",
    chrome_ref: "153.0.8010.12",
    region: "us-west-2",
  });
}

const CONFIGS = Provider.options.map((provider) => render(provider));

describe("attachment paths resolve against $HERMES_HOME", () => {
  test("the dashboard unit runs with WorkingDirectory=$HERMES_HOME", () => {
    for (const config of CONFIGS) {
      const unit = config.files.find((f) => f.path === `/etc/systemd/system/${HERMES_DASHBOARD_UNIT}`);
      expect(unit).toBeDefined();
      const dirs = (unit?.content ?? "").split("\n").filter((l) => l.startsWith("WorkingDirectory="));
      expect(dirs).toEqual([`WorkingDirectory=${HERMES_HOME}`]);
    }
  });

  test("the gateway drop-in does not move the gateway's working directory", () => {
    for (const config of CONFIGS) {
      const dropIn = config.files.find((f) => f.path === HERMES_GATEWAY_DROPIN);
      expect(dropIn?.content ?? "").not.toContain("WorkingDirectory=");
    }
  });

  test("no rendered file sets terminal.cwd or TERMINAL_CWD", () => {
    for (const config of CONFIGS) {
      for (const file of config.files) {
        expect(file.content).not.toContain("TERMINAL_CWD");
      }
      for (const path of [HERMES_MANAGED_CONFIG, HERMES_SEED_CONFIG]) {
        const yaml = config.files.find((f) => f.path === path)?.content;
        expect(yaml).toBeDefined();
        // `cwd:` anywhere in either config — under `terminal:` it is the
        // override, and nowhere else in Hermes's schema does the key mean less.
        expect(yaml ?? "").not.toMatch(/^\s*cwd\s*:/m);
      }
    }
  });
});
