/**
 * Reading a systemd `EnvironmentFile`, and reading systemd's own `KEY=VALUE`
 * output (§6.4, §8.3).
 *
 * Two parsers on the box consume that shape. `verify-hermes` reads the tmpfs
 * environment file to answer "did the provider key arrive", and reads the
 * agent's own `.env` to answer "does anything shadow it" — the first decides
 * whether a boot is refused, the second whether a key hermetic delivers is the
 * one Hermes will use. `parseUnitState` reads `systemctl show`, which is the
 * same grammar from the other direction.
 *
 * The values are the reason this is not obvious. A provider key is base64 and
 * hits none of the edges; a secret out of an operator's own Bitwarden project
 * can contain `=`, `#`, quotes, leading spaces and CRLF, and it reaches these
 * parsers through `envLine`, which quotes it. So the writer and the reader are
 * exercised together here rather than each against its own idea of the format.
 */
import { describe, expect, test } from "bun:test";
import { SECRETS_ENV_PATH, envLine, materialiseSecrets } from "../src/apply/index.ts";
import { checkHermes } from "../src/hermes-check.ts";
import { parseUnitState } from "../src/heartbeat.ts";
import { BoxHost as FakeHost } from "./fake-box.ts";
import { makeManifest } from "./fixtures.ts";

const MANAGED = "/etc/hermes/config.yaml";
const USER_ENV = "/data/hermes/.hermes/.env";
const KEY_ENV = "NOUS_API_KEY";

/** The managed config a keyed provider gets, so only the key check is in play. */
async function keyedBox(host: FakeHost): Promise<void> {
  host.seed(
    MANAGED,
    'model:\n  provider: "hermetic-nous"\n  default: "anthropic/claude-sonnet-5"\n' +
      `providers:\n  hermetic-nous:\n    key_env: "${KEY_ENV}"\n`,
    "0640",
  );
}

/** What the named check decided, for a box whose environment file says `env`. */
async function checkOf(host: FakeHost, name: string): Promise<{ ok: boolean; detail: string }> {
  const checks = await checkHermes(host, makeManifest({ provider: "nous" }));
  const found = checks.find((c) => c.name === name);
  if (found === undefined) throw new Error(`no check named ${name}`);
  return { ok: found.ok, detail: found.detail };
}

/** Does the box read the provider key as delivered, given this file? */
async function keyIsSet(env: string): Promise<boolean> {
  const host = new FakeHost();
  await keyedBox(host);
  host.seed(SECRETS_ENV_PATH, env, "0600");
  return (await checkOf(host, "key")).ok;
}

/** Does the agent's own `.env` shadow the key, given this file? */
async function shadows(dotenv: string): Promise<boolean> {
  const host = new FakeHost();
  await keyedBox(host);
  host.seed(SECRETS_ENV_PATH, `${KEY_ENV}=fixture-not-a-real-key\n`, "0600");
  host.seed(USER_ENV, dotenv, "0600");
  return !(await checkOf(host, "env_shadow")).ok;
}

describe("an EnvironmentFile as the key check reads it", () => {
  test("a value containing `=` is a value, not a second assignment", async () => {
    // Base64 pads with `=`, and a Bitwarden secret can be anything at all: a
    // parser that split on every `=` would read this key as empty and refuse a
    // boot that should have passed.
    expect(await keyIsSet(`${KEY_ENV}=c2VjcmV0=padded==\n`)).toBe(true);
  });

  test("the last line of a file with no trailing newline still counts", async () => {
    expect(await keyIsSet(`OTHER=x\n${KEY_ENV}=fixture-not-a-real-key`)).toBe(true);
  });

  test("CRLF line endings do not become part of the value", async () => {
    expect(await keyIsSet(`OTHER=x\r\n${KEY_ENV}=fixture-not-a-real-key\r\n`)).toBe(true);
  });

  test("a commented-out assignment is not a value", async () => {
    expect(await keyIsSet(`#${KEY_ENV}=fixture-not-a-real-key\n`)).toBe(false);
    expect(await keyIsSet(`# ${KEY_ENV}=fixture-not-a-real-key\n`)).toBe(false);
  });

  test("a whitespace-only value is empty, the same as no line at all", async () => {
    // systemd strips an unquoted value's outer whitespace, so this delivers an
    // empty variable — which is the case `key` exists to catch.
    expect(await keyIsSet(`${KEY_ENV}=   \n`)).toBe(false);
    expect(await keyIsSet(`${KEY_ENV}=\n`)).toBe(false);
  });

  test("the last duplicate assignment wins, as it does in systemd", async () => {
    expect(await keyIsSet(`${KEY_ENV}=\n${KEY_ENV}=fixture-not-a-real-key\n`)).toBe(true);
    expect(await keyIsSet(`${KEY_ENV}=fixture-not-a-real-key\n${KEY_ENV}=\n`)).toBe(false);
  });

  test("a name that merely starts with the key's name is not the key", async () => {
    expect(await keyIsSet(`${KEY_ENV}_OLD=fixture-not-a-real-key\n`)).toBe(false);
    expect(await keyIsSet(`OLD_${KEY_ENV}=fixture-not-a-real-key\n`)).toBe(false);
  });

  test("malformed lines are skipped rather than ending the read", async () => {
    // A blank line, a line with no `=`, a line that is only `=`, and a stray
    // comment — all of them before the assignment that matters.
    expect(
      await keyIsSet(`\nnot an assignment\n=nameless\n# a note\n${KEY_ENV}=fixture-not-a-real-key\n`),
    ).toBe(true);
  });

  test("the file `materialiseSecrets` writes is a file the key check reads", async () => {
    // The round trip that matters: a secret needing quotes goes out through
    // `envLine` and has to come back as "set" — a reader that did not expect
    // the quotes would fail a boot over a key that is perfectly well delivered.
    const host = new FakeHost();
    await keyedBox(host);
    await materialiseSecrets({
      host,
      providerKey: { env: KEY_ENV, value: "sk-FIXTURE with a space and a #hash" },
    });

    expect(host.files.get(SECRETS_ENV_PATH)?.content).toBe(
      `${KEY_ENV}='sk-FIXTURE with a space and a #hash'\n`,
    );
    expect((await checkOf(host, "key")).ok).toBe(true);
  });

  test("every value `envLine` quotes comes back as set", async () => {
    for (const value of ["it's", "back\\slash", " padded ", "a=b=c", "#leading-hash", '"quoted"']) {
      expect(await keyIsSet(`${envLine(KEY_ENV, value)}\n`)).toBe(true);
    }
  });
});

describe("the agent's own .env as the shadow check reads it", () => {
  /**
   * Weaker than the key check on purpose: upstream loads this file with
   * `override=True`, so even an assignment with nothing after the `=` lands in
   * `os.environ` and displaces the key hermetic delivered.
   */
  test("an empty assignment still shadows", async () => {
    expect(await shadows(`${KEY_ENV}=\n`)).toBe(true);
  });

  test("`export` is a prefix python-dotenv accepts, so it shadows too", async () => {
    expect(await shadows(`export ${KEY_ENV}=FIXTURE-shadow\n`)).toBe(true);
    expect(await shadows(`  export ${KEY_ENV}=FIXTURE-shadow\n`)).toBe(true);
  });

  test("leading whitespace and CRLF do not hide an assignment", async () => {
    expect(await shadows(`  ${KEY_ENV} = FIXTURE-shadow\r\n`)).toBe(true);
  });

  test("a commented-out assignment shadows nothing", async () => {
    expect(await shadows(`# ${KEY_ENV}=FIXTURE-shadow\n`)).toBe(false);
    expect(await shadows(`   #${KEY_ENV}=FIXTURE-shadow\n`)).toBe(false);
  });

  test("another variable, or a name this one is a prefix of, is not a shadow", async () => {
    expect(await shadows("OPENAI_API_KEY=FIXTURE-other\n")).toBe(false);
    expect(await shadows(`${KEY_ENV}_OLD=FIXTURE-other\n`)).toBe(false);
  });
});

describe("systemd's own KEY=VALUE output", () => {
  test("a value containing `=` is kept whole", () => {
    // `systemctl show` prints `Environment=FOO=bar`; splitting on every `=`
    // would lose the half that says what the variable is.
    const state = parseUnitState("ActiveState=active\nSubState=running\nNRestarts=3\n");
    expect(state).toEqual({ activeState: "active", subState: "running", restarts: 3 });
    expect(parseUnitState("ActiveState=a=b\n").activeState).toBe("a=b");
  });

  test("CRLF does not become part of the value", () => {
    expect(parseUnitState("ActiveState=active\r\nNRestarts=1\r\n")).toEqual({
      activeState: "active",
      subState: null,
      restarts: 1,
    });
  });

  test("a restart counter that is not a number is `null`, never zero", () => {
    // Zero licenses the comparison "no restart since the swap"; "systemd did
    // not say" must not.
    expect(parseUnitState("NRestarts=not-a-number\n").restarts).toBeNull();
    expect(parseUnitState("NRestarts=\n").restarts).toBeNull();
    expect(parseUnitState("").restarts).toBeNull();
    expect(parseUnitState("NRestarts=0\n").restarts).toBe(0);
  });

  test("lines that are not assignments are skipped, not fatal", () => {
    const state = parseUnitState("\nFailed to get properties\n=nameless\nActiveState=failed\n");
    expect(state.activeState).toBe("failed");
    expect(state.subState).toBeNull();
  });

  test("a repeated property is read as the last thing systemd said about it", () => {
    expect(parseUnitState("ActiveState=activating\nActiveState=active\n").activeState).toBe("active");
  });
});
