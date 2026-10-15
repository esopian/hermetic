/**
 * The files feature's working-directory pin.
 *
 * Hermes 0.21.5 resolves an `@file:` reference only under the session's
 * working directory, and a dashboard session's working directory is the
 * `WorkingDirectory=` of `hermes-dashboard.service` — which hermetic renders as
 * `$HERMES_HOME`. Composer attachments land in `$HERMES_HOME/inbox` and the
 * agent's shares in `$HERMES_HOME/outbox`, so they resolve because, and only
 * because, both sit under that directory.
 *
 * Moving the unit's `WorkingDirectory`, moving either root out from under
 * `$HERMES_HOME`, or giving Hermes a different cwd for its tools
 * (`terminal.cwd` in the config, `TERMINAL_CWD` in the environment) would break
 * every composer attachment without any other test noticing. This file is the
 * one that notices.
 */
import { describe, expect, test } from "bun:test";
import {
  FILES_INBOX_DIR,
  FILES_OUTBOX_DIR,
  FILES_STAGE_DIR,
  HERMES_DASHBOARD_UNIT,
  HERMES_HOME,
} from "../src/shared/index.ts";
import { Provider, SecretsMode, type HermesSettings } from "../src/schema/index.ts";
import { renderAgentConfig } from "../src/render/render.ts";

const CHROME_REF = "153.0.8010.12";

function render(provider: Provider, secrets_mode: SecretsMode, hermes?: HermesSettings) {
  return renderAgentConfig({
    name: "atlas",
    size: "small",
    provider,
    secrets_mode,
    hermes,
    tailnet: "hermetic.ts.net",
    hermes_version: "0.15.0",
    hermes_ref: "v2026.8.31",
    chrome_ref: CHROME_REF,
    region: "us-west-2",
  });
}

const CASES = Provider.options.flatMap((provider) =>
  SecretsMode.options.flatMap((secrets_mode) => [
    { provider, secrets_mode, hermes: undefined },
    // The one Hermes setting that touches the terminal tool: stating it must
    // not bring a `cwd` along with it.
    { provider, secrets_mode, hermes: { terminal_backend: "local" } as HermesSettings },
  ]),
);

describe("the files roots resolve under the dashboard's working directory", () => {
  test("the inbox, its stage and the outbox are all under $HERMES_HOME", () => {
    expect(FILES_INBOX_DIR.startsWith(HERMES_HOME + "/")).toBe(true);
    expect(FILES_STAGE_DIR.startsWith(HERMES_HOME + "/")).toBe(true);
    expect(FILES_OUTBOX_DIR.startsWith(HERMES_HOME + "/")).toBe(true);
  });

  test.each(CASES)(
    "$provider/$secrets_mode: WorkingDirectory is $HERMES_HOME, and nothing moves the cwd",
    (c) => {
      const out = render(c.provider, c.secrets_mode, c.hermes);
      const unit = out.manifest.files.find(
        (f) => f.path === `/etc/systemd/system/${HERMES_DASHBOARD_UNIT}`,
      );
      expect(unit).toBeDefined();
      const workingDirs = (unit?.content ?? "")
        .split("\n")
        .filter((line) => line.startsWith("WorkingDirectory="));
      expect(workingDirs).toEqual([`WorkingDirectory=${HERMES_HOME}`]);

      // No `terminal.cwd` in the managed (or seed) Hermes config.
      for (const path of ["/etc/hermes/config.yaml", "/etc/hermes/config.seed.yaml"]) {
        const config = out.manifest.files.find((f) => f.path === path)?.content ?? "";
        expect(config).not.toMatch(/^\s*cwd\s*:/m);
      }
      // No `TERMINAL_CWD` anywhere the box gets an environment from: a rendered
      // file (units, env files, configs) or a post-step command.
      for (const file of out.manifest.files) expect(file.content).not.toContain("TERMINAL_CWD");
      for (const command of out.manifest.commands) expect(command).not.toContain("TERMINAL_CWD");
      // Nor a seeded `terminal.cwd` through `hermes config set`.
      for (const command of out.manifest.commands) expect(command).not.toContain("terminal.cwd");
    },
  );
});
