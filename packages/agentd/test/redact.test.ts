import { describe, expect, test } from "bun:test";
import { REDACTED, looksSecret, redactArgv, redactEnv, redactValue } from "../src/redact.ts";
import { must } from "../src/host.ts";
import type { AgentdError } from "../src/errors.ts";
import { FakeHost } from "./fake-host.ts";

/**
 * A real tailnet key is `tskey-<kind>-<keyID>-<secret>`: four hyphen-separated
 * segments, and the last one is the part that actually matters. A pattern that
 * stops at the third hyphen redacts the harmless half and logs the secret.
 */
const REAL_KEY = "tskey-auth-k7Y2CNTRL5CNTRL-3vT9xQwErTyUiOpAsDfGhJkL";
const FIXTURE_KEY = "tskey-auth-kFixture123";
const BWS_TOKEN = "0.4b1c2d3e-1111-2222-3333-444455556666.YWJjZGVmZ2hpamts-bW5vcHFy_c3R1dnd4eXo=";

describe("redaction", () => {
  test("a realistic multi-segment tailnet key is redacted whole", () => {
    expect(looksSecret(REAL_KEY)).toBe(true);
    const redacted = redactValue(REAL_KEY);
    expect(redacted).toBe(REDACTED);
    // The specific regression: the secret half must not survive.
    expect(redacted).not.toContain("3vT9xQwErTyUiOpAsDfGhJkL");
    expect(redacted).not.toContain("k7Y2CNTRL5CNTRL");
  });

  test("the shorter fixture-shaped key is still redacted whole", () => {
    expect(redactValue(FIXTURE_KEY)).toBe(REDACTED);
  });

  test("a key embedded in a sentence loses only the key", () => {
    const line = `backend error: invalid key ${REAL_KEY} (expired)`;
    const redacted = redactValue(line);
    expect(redacted).toBe(`backend error: invalid key ${REDACTED} (expired)`);
    expect(redacted).not.toContain("3vT9xQwErTyUiOpAsDfGhJkL");
  });

  test("a base64url bitwarden token is redacted whole, `-` and `_` included", () => {
    const redacted = redactValue(`BWS_ACCESS_TOKEN=${BWS_TOKEN}`);
    expect(redacted).toBe(`BWS_ACCESS_TOKEN=${REDACTED}`);
    expect(redacted).not.toContain("c3R1dnd4eXo=");
  });

  test("aws access key ids and PEM headers are redacted", () => {
    expect(redactValue("AKIAIOSFODNN7EXAMPLE")).toBe(REDACTED);
    expect(redactValue("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe(REDACTED);
  });

  test("two keys on one line are both redacted", () => {
    const redacted = redactValue(`${REAL_KEY} and ${FIXTURE_KEY}`);
    expect(redacted).toBe(`${REDACTED} and ${REDACTED}`);
  });

  test("argv keeps its flag names and loses its values", () => {
    expect(redactArgv(["tailscale", "up", `--authkey=${REAL_KEY}`, "--ssh"])).toEqual([
      "tailscale",
      "up",
      `--authkey=${REDACTED}`,
      "--ssh",
    ]);
    // A secret-named flag is redacted even when the value looks innocuous.
    expect(redactArgv(["--bws-token=whatever"])).toEqual([`--bws-token=${REDACTED}`]);
    // A benign flag survives intact, so the log still says what ran.
    expect(redactArgv(["--hostname=research-1"])).toEqual(["--hostname=research-1"]);
  });

  test("only environment keys are ever recorded", () => {
    expect(redactEnv({ BWS_ACCESS_TOKEN: BWS_TOKEN, DEBIAN_FRONTEND: "noninteractive" })).toEqual([
      "BWS_ACCESS_TOKEN",
      "DEBIAN_FRONTEND",
    ]);
    expect(redactEnv(undefined)).toEqual([]);
  });

  test("must() scrubs a key out of argv, stderr and the recorded detail", async () => {
    const host = new FakeHost();
    host.handlers.push(() => ({
      code: 1,
      stdout: "",
      stderr: `backend error: invalid key ${REAL_KEY}`,
    }));

    let thrown: unknown;
    try {
      await must(host, ["tailscale", "up", `--authkey=${REAL_KEY}`], {
        env: { BWS_ACCESS_TOKEN: BWS_TOKEN },
      });
    } catch (e) {
      thrown = e;
    }

    const error = thrown as AgentdError;
    const recorded = JSON.stringify({ message: error.message, detail: error.detail });
    expect(recorded).not.toContain("3vT9xQwErTyUiOpAsDfGhJkL");
    expect(recorded).not.toContain(REAL_KEY);
    expect(recorded).not.toContain(BWS_TOKEN);
    expect(error.detail["env"]).toEqual(["BWS_ACCESS_TOKEN"]);
  });
});

/**
 * §8.1 puts a model provider's API key in every agent's own SSM slot, so
 * `apply` and the `04-apply` stage both handle one on every boot. Until these
 * shapes were listed, a provider key in a failed command's stderr went into the
 * row and the stage log verbatim.
 *
 * Fixtures use the `FIXTURE` sentinel only — never a real-looking credential.
 */
describe("provider API keys (§8.1)", () => {
  const anthropic = "sk-ant-" + "FIXTURE".repeat(4);
  const openrouter = "sk-or-v1-" + "FIXTURE".repeat(4);
  const generic = "sk-" + "FIXTURE".repeat(5);

  test.each([anthropic, openrouter, generic])("%s is recognised as a secret", (key) => {
    expect(looksSecret(key)).toBe(true);
    expect(redactValue(`provider rejected ${key}`)).toBe(`provider rejected ${REDACTED}`);
  });

  test("the whole key is replaced, not just its prefix", () => {
    for (const key of [anthropic, openrouter, generic]) {
      const out = redactValue(`x ${key} y`);
      expect(out).not.toContain("FIXTURE");
      expect(out).toBe(`x ${REDACTED} y`);
    }
  });

  test("a --flag=<provider key> keeps its flag name and loses the value", () => {
    expect(redactArgv(["hermes", `--api-key=${anthropic}`])).toEqual([
      "hermes",
      `--api-key=${REDACTED}`,
    ]);
  });

  test("ordinary sk- prefixed words are not mistaken for keys", () => {
    // Too short to be a credential; redacting these would make logs unreadable
    // for no gain.
    expect(looksSecret("sk-fixture")).toBe(false);
    expect(looksSecret("sk-or-FIXTURE")).toBe(false);
    expect(looksSecret("scikit-learn")).toBe(false);
  });
});

/**
 * The last-resort pattern, and the reason it is narrow.
 *
 * Every other shape in `SECRET_SHAPES` is a credential hermetic itself hands to
 * a box, so it can be recognised. The one this catches is the credential
 * hermetic never sees — an operator's own Bitwarden entry, materialised by
 * `bws` under a name only they know — and the only thing to go on is that it
 * looks machine-generated. Over-redaction is its own failure, so the test that
 * matters most here is the one that says what still survives.
 */
describe("the high-entropy fallback", () => {
  test("an unrecognised machine-generated token is redacted anyway", () => {
    const token = "Xk7Qp2LmRt9VbNc4ZfWyJh6Ds1Ag8Ue5Ko3Ii0Pq";
    expect(looksSecret(token)).toBe(true);
    expect(redactValue(`MY_COMPANY_THING=${token}`)).toBe(`MY_COMPANY_THING=${REDACTED}`);
    expect(redactValue(`bws error: ${token} rejected`)).toBe(`bws error: ${REDACTED} rejected`);
  });

  test("a sha256 digest survives — hermeticd's own errors are built out of them", () => {
    const digest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    expect(looksSecret(digest)).toBe(false);
    expect(redactValue(`expected ${digest}`)).toBe(`expected ${digest}`);
  });

  test("the things hermeticd actually logs are left readable", () => {
    for (const value of [
      "/usr/local/lib/hermes-agent/venv/bin/python",
      "artifacts/0.1.0/stages/00-preflight.sh",
      "arn:aws:iam::123456789012:role/hermetic-fxtr0001-agent",
      "i-0abcdef1234567890 vol-0fedcba9876543210",
      "2026-09-06T03:17:00.000Z",
      "hermetic-fleet-123456789012",
      "apt-get install -y --no-install-recommends chromium-browser",
    ]) {
      expect(redactValue(value)).toBe(value);
    }
  });

  /**
   * A JWT is three base64url segments joined by dots and the middle one is the
   * payload. Treating each segment on its own would redact the header and leave
   * the claims — the half-redaction this module exists to prevent.
   */
  test("a JWT goes whole, header, payload and signature", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
      "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkV2YW4ifQ." +
      "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const redacted = redactValue(`Authorization: Bearer ${jwt}`);
    expect(redacted).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(redacted).not.toContain("eyJzdWIiOiIxMjM0NTY3ODkw");
  });

  /**
   * …and the reason `/` is not part of a run: a path is not a token, and a log
   * that says «redacted» where the filename was is a log nobody can debug from.
   */
  test("a long mixed-case path survives, segment by segment", () => {
    const path = "/opt/Hermetic/Stages7/RunnerA1/BuildKit9/somewhere-Deep2/file.sh";
    expect(redactValue(path)).toBe(path);
    expect(looksSecret(path)).toBe(false);
    // A token *inside* a URL path is still a token: the run starts after the
    // slash and is judged on its own.
    expect(redactValue("https://host/dl?X=Xk7Qp2LmRt9VbNc4ZfWyJh6Ds1Ag8Ue5Ko3Ii0Pq")).toContain(
      REDACTED,
    );
  });

  test("a short token is not long enough to be worth guessing about", () => {
    expect(looksSecret("Ab1Cd2Ef3Gh4Ij5Kl6")).toBe(false);
  });
});
