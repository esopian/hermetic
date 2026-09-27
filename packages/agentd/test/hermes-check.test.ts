/**
 * `hermeticd stage verify-hermes` (§4.3) — the check that makes `ready` mean
 * "this agent can answer" rather than "systemd started something".
 *
 * The failure it was written for: an agent that passed every other check in
 * `06-verify` — volume mounted, node on the tailnet, `hermes-dashboard.service` active,
 * dashboard answering — and then met its operator with "No inference provider
 * configured" on the first message.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { HERMES_PROBE_TIMEOUT_S, checkHermes, hermesProbeArgv } from "../src/hermes-check.ts";
import { SECRETS_ENV_PATH } from "../src/apply/index.ts";
import { AgentdError } from "../src/errors.ts";
import { MANIFEST_PATH } from "../src/manifest.ts";
import { run } from "../src/main.ts";
import { FakeHost } from "./fake-host.ts";
import { makeManifest } from "./fixtures.ts";

const MANAGED = "/etc/hermes/config.yaml";
const USER = "/data/hermes/.hermes/config.yaml";
const USER_ENV = "/data/hermes/.hermes/.env";

/**
 * What `hermes config get model.default --json` answers on this fake box.
 *
 * `null` is upstream's unset case: the notice goes to stderr and the process
 * exits 1 (`hermes_cli/config.py:3541-3542`, `_exit_invalid` at `:3422`), and
 * that exit code is the whole signal the check reads.
 */
function hermesResolves(host: FakeHost, model: string | null): void {
  const probe = hermesProbeArgv("model.default").join(" ");
  // Unshift, not push: `FakeHost` takes the first handler that matches, so the
  // last answer a test states is the one that holds.
  host.handlers.unshift((argv) =>
    argv.join(" ") !== probe
      ? null
      : model === null
        ? { code: 1, stdout: "", stderr: "Config key not set: model.default\n" }
        : { code: 0, stdout: `${JSON.stringify(model)}\n`, stderr: "" },
  );
}

/**
 * What `hermes config get approvals.mode --json` answers on this fake box.
 *
 * `null` is the unset case again — upstream ships a default for this key, so a
 * box that answers this way is one whose `hermes` cannot read its config at all.
 */
function approvalsResolves(host: FakeHost, mode: string | null): void {
  const probe = hermesProbeArgv("approvals.mode").join(" ");
  host.handlers.unshift((argv) =>
    argv.join(" ") !== probe
      ? null
      : mode === null
        ? { code: 1, stdout: "", stderr: "Config key not set: approvals.mode\n" }
        : { code: 0, stdout: `${JSON.stringify(mode)}\n`, stderr: "" },
  );
}

/** What a boot that went right leaves behind, for a keyed provider. */
async function wellConfigured(host: FakeHost): Promise<void> {
  host.seed(
    MANAGED,
    'model:\n  provider: "hermetic-nous"\nproviders:\n  hermetic-nous:\n    key_env: "NOUS_API_KEY"\n',
    "0640",
  );
  host.seed(USER, 'model:\n  default: "anthropic/claude-sonnet-5"\n', "0640");
  host.seed(SECRETS_ENV_PATH, "NOUS_API_KEY=fixture-not-a-real-key\n", "0600");
  hermesResolves(host, "anthropic/claude-sonnet-5");
  // The mode `makeManifest` states by default, so the approvals check passes
  // for every test that is not about it.
  approvalsResolves(host, "off");
}

function failedNames(checks: Awaited<ReturnType<typeof checkHermes>>): string[] {
  return checks.filter((c) => !c.ok).map((c) => c.name);
}

describe("verify-hermes", () => {
  let host: FakeHost;

  beforeEach(() => {
    host = new FakeHost();
  });

  test("a fully configured keyed agent passes every check", async () => {
    await wellConfigured(host);
    const checks = await checkHermes(host, makeManifest({ provider: "nous" }));
    expect(failedNames(checks)).toEqual([]);
    expect(checks.map((c) => c.name).sort()).toEqual([
      "approvals",
      "env_shadow",
      "key",
      "model",
      "provider",
      "resolved_model",
    ]);
  });

  /**
   * The precedence bug this check exists for: upstream loads the agent's own
   * `.env` with `override=True` (`hermes_cli/env_loader.py:344-352`) and the
   * api-key path prefers it over the environment (`config.py:2714`,
   * `auth.py:293-303`), so a key in there permanently outranks the one hermetic
   * delivers on tmpfs — and `hermetic secrets push --provider-key` goes quiet.
   */
  test("a key in the agent's own .env shadows hermetic's and fails the boot", async () => {
    await wellConfigured(host);
    host.seed(USER_ENV, "NOUS_API_KEY=FIXTURE-shadow\n", "0600");
    const checks = await checkHermes(host, makeManifest({ provider: "nous" }));
    expect(failedNames(checks)).toEqual(["env_shadow"]);
    const detail = checks.find((c) => c.name === "env_shadow")!.detail;
    expect(detail).toContain(USER_ENV);
    expect(detail).toContain("NOUS_API_KEY");
    expect(detail).toContain("prefers");
    // Whether one is there, never what it is.
    expect(detail).not.toContain("FIXTURE-shadow");
  });

  /** An `.env` that says something else about something else is not a shadow. */
  test("an .env naming other variables passes, and so does no .env at all", async () => {
    await wellConfigured(host);
    // A commented-out key is not a key: python-dotenv skips the line, so a
    // check that counted it would fail a boot over a note to self.
    host.seed(USER_ENV, "export EDITOR=vi\nTZ=UTC\n# NOUS_API_KEY=old\n", "0600");
    expect(failedNames(await checkHermes(host, makeManifest({ provider: "nous" })))).toEqual([]);
    await host.remove(USER_ENV);
    expect(failedNames(await checkHermes(host, makeManifest({ provider: "nous" })))).toEqual([]);
  });

  /**
   * The one check that asks Hermes rather than reading what hermetic wrote.
   * `hermes doctor` cannot stand in for it: `_validate_model_config` reads
   * `read_user_config_raw` (`doctor_config.py:216`), which cannot see the
   * managed config at all.
   */
  test("a Hermes that resolves no model fails, even with both files in order", async () => {
    await wellConfigured(host);
    hermesResolves(host, null);
    const checks = await checkHermes(host, makeManifest({ provider: "nous" }));
    // The offline checks still pass: the files say a model is there.
    expect(failedNames(checks)).toEqual(["resolved_model"]);
    expect(checks.find((c) => c.name === "resolved_model")!.detail).toContain(
      "resolves no model.default",
    );
  });

  /**
   * And the probe runs as the agent's own user, against the agent's own home —
   * under `timeout(1)`, because `06-verify` has none of its own (§4.2) and a
   * `hermes` that never returns would hang the boot rather than fail it.
   */
  test("the resolution probe is `hermes config get`, run as hermes under a timeout", async () => {
    await wellConfigured(host);
    const checks = await checkHermes(host, makeManifest({ provider: "nous" }));
    expect(host.commands).toContain(
      `timeout ${HERMES_PROBE_TIMEOUT_S} runuser -u hermes -- env HERMES_HOME=/data/hermes/.hermes ` +
        "/usr/local/bin/hermes config get model.default --json",
    );
    expect(checks.find((c) => c.name === "resolved_model")!.detail).toContain(
      "anthropic/claude-sonnet-5",
    );
  });

  /**
   * The probe is the only check that runs a command, so it is the only one that
   * can fail by not running at all: spawning a `hermes` that is not on the box
   * is an ENOENT out of `exec`, not an exit code. Letting that escape would
   * break this module's contract — every failure reported, all at once — and
   * turn the plainest finding there is into an unclassified stage crash.
   */
  test("a `hermes` that cannot be spawned is a failed check, not a thrown stage", async () => {
    await wellConfigured(host);
    const probe = hermesProbeArgv("model.default").join(" ");
    host.handlers.unshift((argv) => {
      if (argv.join(" ") !== probe) return null;
      throw new Error("spawn /usr/local/bin/hermes ENOENT");
    });

    const checks = await checkHermes(host, makeManifest({ provider: "nous" }));
    expect(failedNames(checks)).toEqual(["resolved_model"]);
    expect(checks.find((c) => c.name === "resolved_model")!.detail).toContain("ENOENT");
    // Every other check still answered, which is the whole point of not throwing.
    expect(checks.map((c) => c.name).sort()).toEqual([
      "approvals",
      "env_shadow",
      "key",
      "model",
      "provider",
      "resolved_model",
    ]);
  });

  /** The original bug, in the shape it actually reached the operator. */
  test("a managed config that names no provider fails", async () => {
    await wellConfigured(host);
    host.seed(MANAGED, "# nothing here names a provider\n", "0640");
    const checks = await checkHermes(host, makeManifest({ provider: "nous" }));
    expect(failedNames(checks)).toContain("provider");
    expect(checks.find((c) => c.name === "provider")!.detail).toContain("names no model.provider");
  });

  test("a provider with no model to send it fails", async () => {
    await wellConfigured(host);
    host.seed(USER, "agent:\n  max_turns: 500\n", "0640");
    const checks = await checkHermes(host, makeManifest({ provider: "nous" }));
    expect(failedNames(checks)).toEqual(["model"]);
  });

  /**
   * Either file may carry the model — hermetic manages it when the operator
   * named one and seeds it otherwise, and both are correct.
   */
  test("a model in the managed config counts as much as one in the agent's own", async () => {
    await wellConfigured(host);
    host.seed(
      MANAGED,
      'model:\n  provider: "hermetic-nous"\n  default: "anthropic/claude-opus-5"\n',
      "0640",
    );
    host.seed(USER, "agent:\n  max_turns: 500\n", "0640");
    const checks = await checkHermes(host, makeManifest({ provider: "nous" }));
    expect(failedNames(checks)).toEqual([]);
  });

  test("a keyed provider whose key never arrived fails, and says how to push it", async () => {
    await wellConfigured(host);
    host.seed(SECRETS_ENV_PATH, "NOUS_API_KEY=\n", "0600");
    const checks = await checkHermes(host, makeManifest({ provider: "nous" }));
    expect(failedNames(checks)).toEqual(["key"]);
    expect(checks.find((c) => c.name === "key")!.detail).toContain("secrets push");
  });

  test("an empty secrets file fails the same way as a missing variable", async () => {
    await wellConfigured(host);
    host.seed(SECRETS_ENV_PATH, "", "0600");
    const checks = await checkHermes(host, makeManifest({ provider: "nous" }));
    expect(failedNames(checks)).toEqual(["key"]);
  });

  /** Bedrock authenticates as the instance: there is no key to look for. */
  test("a role provider expects no key on the box", async () => {
    host.seed(MANAGED, 'model:\n  provider: "bedrock"\n', "0640");
    host.seed(USER, 'model:\n  default: "us.anthropic.claude-sonnet-4-5-20250929-v1:0"\n', "0640");
    approvalsResolves(host, "off");
    const checks = await checkHermes(host, makeManifest({ provider: "bedrock" }));
    expect(failedNames(checks)).toEqual([]);
    expect(checks.find((c) => c.name === "key")!.detail).toContain("authenticates as the instance");
  });

  /**
   * The browser half of the same two questions (§8.1), on an agent that
   * has a browser: does anything shadow the managed `browser.cdp_url`, and does
   * Hermes resolve it to the browser this box actually runs?
   *
   * Neither check exists on an agent with no browser: there is no CDP endpoint
   * to name and nothing that could be pointed away from it.
   */
  /**
   * `approvals.mode` is the difference between an agent that administers its own
   * box and one that stalls waiting for a human who is not there (§6.4). hermetic
   * seeds it and does not manage it, so the box is the only witness to what it
   * actually is — and a value the agent changed there is a finding, not a fault.
   */
  describe("the approvals gate", () => {
    test("a Hermes resolving the mode the manifest states passes", async () => {
      await wellConfigured(host);

      const checks = await checkHermes(host, makeManifest({ provider: "nous" }));

      expect(failedNames(checks)).toEqual([]);
      expect(checks.find((c) => c.name === "approvals")!.detail).toBe(
        "Hermes resolves approvals.mode to off",
      );
      expect(host.commands).toContain(
        `timeout ${HERMES_PROBE_TIMEOUT_S} runuser -u hermes -- env HERMES_HOME=/data/hermes/.hermes ` +
          "/usr/local/bin/hermes config get approvals.mode --json",
      );
    });

    /**
     * The drift the check exists for: `smart` classifies most of what an agent
     * with root does as dangerous, so a box that resolves it is one whose turns
     * will hang or be auto-denied — while every other signal still says healthy.
     */
    test("a mode changed on the box is reported, naming both values", async () => {
      await wellConfigured(host);
      approvalsResolves(host, "smart");

      const checks = await checkHermes(host, makeManifest({ provider: "nous" }));

      expect(failedNames(checks)).toEqual(["approvals"]);
      const approvals = checks.find((c) => c.name === "approvals")!;
      expect(approvals.advisory).toBe(true);
      expect(approvals.detail).toContain("smart");
      expect(approvals.detail).toContain("off");
      expect(approvals.detail).toContain("changed on the box");
    });

    test("a Hermes that resolves no approvals.mode is reported, and still advisory", async () => {
      await wellConfigured(host);
      approvalsResolves(host, null);

      const checks = await checkHermes(host, makeManifest({ provider: "nous" }));

      expect(failedNames(checks)).toEqual(["approvals"]);
      const approvals = checks.find((c) => c.name === "approvals")!;
      expect(approvals.advisory).toBe(true);
      expect(approvals.detail).toContain("resolves no approvals.mode");
      expect(approvals.detail).toContain("exited 1");
    });

    /**
     * A manifest rendered before the field — still sitting on boxes, and re-read
     * by hermeticd to answer with its own `config_hash`. There is no expectation
     * to check, so there is no check, and nothing asks Hermes anything about it.
     */
    test("a manifest that states no mode has no approvals check at all", async () => {
      await wellConfigured(host);

      const checks = await checkHermes(host, makeManifest({ provider: "nous", approvals_mode: null }));

      expect(failedNames(checks)).toEqual([]);
      expect(checks.map((c) => c.name)).not.toContain("approvals");
      expect(host.commandsMatching(/approvals\.mode/)).toEqual([]);
    });
  });

  describe("the browser seam", () => {
    const CDP_URL = "http://127.0.0.1:9222";

    /** What `hermes config get browser.cdp_url --json` answers on this box. */
    function cdpResolves(value: string | null): void {
      const probe = hermesProbeArgv("browser.cdp_url").join(" ");
      host.handlers.unshift((argv) =>
        argv.join(" ") !== probe
          ? null
          : value === null
            ? { code: 1, stdout: "", stderr: "Config key not set: browser.cdp_url\n" }
            : { code: 0, stdout: `${JSON.stringify(value)}\n`, stderr: "" },
      );
    }

    const browserAgent = () => makeManifest({ provider: "nous", browser: true });

    test("a browser agent is asked what Hermes resolves browser.cdp_url to", async () => {
      await wellConfigured(host);
      cdpResolves(CDP_URL);

      const checks = await checkHermes(host, browserAgent());

      expect(failedNames(checks)).toEqual([]);
      expect(checks.find((c) => c.name === "resolved_cdp_url")!.detail).toBe(
        `Hermes resolves browser.cdp_url to ${CDP_URL}`,
      );
      expect(host.commands).toContain(
        `timeout ${HERMES_PROBE_TIMEOUT_S} runuser -u hermes -- env HERMES_HOME=/data/hermes/.hermes ` +
          "/usr/local/bin/hermes config get browser.cdp_url --json",
      );
    });

    /**
     * The failure the check is for: with no CDP override Hermes launches its
     * own headless Chrome, so the browser tool works, the desktop shows an idle
     * window, and the shared session the feature is for is quietly false.
     */
    test("a Hermes that resolves no browser.cdp_url fails and says what that means", async () => {
      await wellConfigured(host);
      cdpResolves(null);

      const checks = await checkHermes(host, browserAgent());

      expect(failedNames(checks)).toEqual(["resolved_cdp_url"]);
      expect(checks.find((c) => c.name === "resolved_cdp_url")!.detail).toContain(
        "launch its own Chrome",
      );
    });

    test("a browser.cdp_url pointing somewhere else fails, naming the value", async () => {
      await wellConfigured(host);
      cdpResolves("http://10.0.0.9:9222");

      const checks = await checkHermes(host, browserAgent());

      expect(failedNames(checks)).toEqual(["resolved_cdp_url"]);
      const detail = checks.find((c) => c.name === "resolved_cdp_url")!.detail;
      expect(detail).toContain("http://10.0.0.9:9222");
      expect(detail).toContain(CDP_URL);
    });

    /**
     * `BROWSER_CDP_URL` in the agent's own `.env` beats managed config — and
     * that is upstream's `/browser connect` working as designed, so the finding
     * says what it costs rather than telling the operator to delete a line they
     * may have meant to write.
     */
    test("BROWSER_CDP_URL in the agent's .env is reported as the hand-over it is", async () => {
      await wellConfigured(host);
      cdpResolves(CDP_URL);
      host.seed(USER_ENV, "BROWSER_CDP_URL=http://127.0.0.1:9333\n", "0600");

      const checks = await checkHermes(host, browserAgent());

      // Its own check, and an advisory one: the operator chose this.
      expect(failedNames(checks)).toEqual(["cdp_override"]);
      const override = checks.find((c) => c.name === "cdp_override")!;
      expect(override.advisory).toBe(true);
      expect(override.detail).toContain("BROWSER_CDP_URL");
      expect(override.detail).toContain("/browser connect");
      expect(override.detail).toContain("hermetic-browser@default");
      // And it is no longer smuggled into the key check.
      expect(checks.find((c) => c.name === "env_shadow")!.ok).toBe(true);
    });

    test("a shadowed key and a shadowed cdp_url are two findings, not one", async () => {
      await wellConfigured(host);
      cdpResolves(CDP_URL);
      host.seed(
        USER_ENV,
        "NOUS_API_KEY=FIXTURE-shadow\nBROWSER_CDP_URL=http://127.0.0.1:9333\n",
        "0600",
      );

      const checks = await checkHermes(host, browserAgent());

      expect(failedNames(checks).sort()).toEqual(["cdp_override", "env_shadow"]);
      const shadow = checks.find((c) => c.name === "env_shadow")!;
      expect(shadow.detail).toContain("NOUS_API_KEY");
      expect(shadow.detail).not.toContain("BROWSER_CDP_URL");
      expect(shadow.advisory).toBeUndefined();
      expect(checks.find((c) => c.name === "cdp_override")!.detail).toContain("BROWSER_CDP_URL");
      for (const check of checks) expect(check.detail).not.toContain("FIXTURE-shadow");
    });

    /**
     * One browser probe stays advisory and one no longer is, for reasons that
     * are not the same. `cdp_override` reports a seam an operator may have used
     * on purpose (`/browser connect` writes that very line), so a finding there
     * is information, not a fault. `resolved_cdp_url` was advisory only while
     * the probe's own exit code was a guess, until it was watched answering on
     * a live box, so a Hermes that does not resolve this box's endpoint is now
     * a failed boot rather than a printed remark.
     *
     * `approvals` is advisory for `cdp_override`'s reason rather than its own:
     * the key is seed-only, so the agent owns it once it is written, and what
     * the operator stated is a starting position rather than a hold.
     */
    test("cdp_override and approvals are advisory; the rest are verdicts", async () => {
      await wellConfigured(host);
      cdpResolves(CDP_URL);

      const checks = await checkHermes(host, browserAgent());

      expect(checks.filter((c) => c.advisory === true).map((c) => c.name)).toEqual([
        "cdp_override",
        "approvals",
      ]);
      expect(checks.filter((c) => c.advisory !== true).map((c) => c.name)).toEqual([
        "provider",
        "model",
        "key",
        "env_shadow",
        "resolved_model",
        "resolved_cdp_url",
      ]);
    });

    test("an agent with no browser has neither check, and BROWSER_CDP_URL is not a shadow", async () => {
      await wellConfigured(host);
      host.seed(USER_ENV, "BROWSER_CDP_URL=http://127.0.0.1:9333\n", "0600");

      const checks = await checkHermes(host, makeManifest({ provider: "nous" }));

      expect(failedNames(checks)).toEqual([]);
      expect(checks.map((c) => c.name)).not.toContain("resolved_cdp_url");
      expect(checks.map((c) => c.name)).not.toContain("cdp_override");
      expect(checks.find((c) => c.name === "env_shadow")!.detail).not.toContain("BROWSER_CDP_URL");
      expect(host.commandsMatching(/browser\.cdp_url/)).toEqual([]);
    });
  });

  /**
   * All of them, not just the first: one failed boot, one full account of why.
   *
   * `approvals` is among them because a box this bare has no `hermes` to answer
   * the probe either — the advisory finding is right, and it is still advisory,
   * so it is not what fails the stage.
   */
  test("a box where nothing was configured reports every failure at once", async () => {
    const checks = await checkHermes(host, makeManifest({ provider: "nous" }));
    expect(failedNames(checks).sort()).toEqual(["approvals", "key", "model", "provider"]);
  });

  /**
   * The reader is a regex over the shape `render.ts` writes, so it must not
   * mistake a key of the same name under a different section for the one it
   * was asked about.
   */
  test("a key of the same name under another section does not count", async () => {
    await wellConfigured(host);
    host.seed(MANAGED, 'auxiliary:\n  provider: "openrouter"\n', "0640");
    const checks = await checkHermes(host, makeManifest({ provider: "nous" }));
    expect(failedNames(checks)).toEqual(["provider"]);
  });

  /**
   * The verdict as the stage sees it. A misconfigured agent is not a hermeticd
   * fault, and `INTERNAL` — which is what this used to throw — said it was: it
   * is the code for "something here is broken", and what happened is that the
   * operator's agent has no provider, no model or no key. The named code is
   * what lets a reader of the row, the log or the exit tell those apart, and
   * what points at the fix (`agent set`, `secrets push`) rather than at a bug.
   */
  describe("as a stage", () => {
    test("a misconfigured agent fails with HERMES_MISCONFIGURED, naming the checks", async () => {
      host.seed(MANIFEST_PATH, JSON.stringify(makeManifest({ provider: "nous" })));

      let error: AgentdError | null = null;
      try {
        await run(["stage", "verify-hermes"], host);
      } catch (e) {
        error = e as AgentdError;
      }

      expect(error).toBeInstanceOf(AgentdError);
      expect(error?.code).toBe("HERMES_MISCONFIGURED");
      expect(error?.message).toContain("not configured to answer");
      expect(String(error?.detail["failed"])).toContain("provider");
      // Not a refused manifest: the manifest parsed fine, the box did not.
      expect(error?.exitCode).toBe(1);
    });

    test("a configured agent passes the stage", async () => {
      await wellConfigured(host);
      host.seed(MANIFEST_PATH, JSON.stringify(makeManifest({ provider: "nous" })));
      expect(await run(["stage", "verify-hermes"], host)).toBe(0);
    });

    /**
     * A browser agent whose operator ran `/browser connect`, and whose Hermes
     * answers the CDP probe with something else: both browser checks fail, and
     * neither may put the agent into `error` on its next rerun.
     */
    test("a failing advisory check is printed and does not fail the stage", async () => {
      await wellConfigured(host);
      host.seed(USER_ENV, "BROWSER_CDP_URL=http://127.0.0.1:9333\n", "0600");
      host.handlers.unshift((argv) =>
        argv.join(" ").includes("browser.cdp_url")
          ? { code: 0, stdout: '"http://127.0.0.1:9222"\n', stderr: "" }
          : null,
      );
      host.seed(MANIFEST_PATH, JSON.stringify(makeManifest({ provider: "nous", browser: true })));

      // `cdp_override` fails — the agent's own `.env` names BROWSER_CDP_URL —
      // and the boot survives it, which is the whole of `advisory`.
      expect(await run(["stage", "verify-hermes"], host)).toBe(0);
    });

    test("a non-advisory failure on a browser agent still fails the stage", async () => {
      host.seed(MANIFEST_PATH, JSON.stringify(makeManifest({ provider: "nous", browser: true })));

      const error = (await run(["stage", "verify-hermes"], host).catch(
        (e: unknown) => e,
      )) as AgentdError;

      expect(error.code).toBe("HERMES_MISCONFIGURED");
      // Only the verdicts are named; the advisory finding was printed.
      expect(String(error.detail["failed"])).not.toContain("cdp_override");
    });

    test("a box with no manifest at all is still a refused manifest", async () => {
      let error: AgentdError | null = null;
      try {
        await run(["stage", "verify-hermes"], host);
      } catch (e) {
        error = e as AgentdError;
      }
      expect(error?.code).toBe("MANIFEST_REFUSED");
    });
  });
});
