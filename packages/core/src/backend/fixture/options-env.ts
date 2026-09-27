import type { FixtureOptions } from "../../open.ts";

/**
 * The fixture's environment knobs as `FixtureOptions`. Pure: the caller passes
 * the environment (a head passes `process.env`, a test passes a literal), so
 * no fixture knob is read from the environment inside the backend. The names are the documented ones —
 * `HERMETIC_FIXTURE_SLOW_STACK_MS=120000 bun run dev:wizard` still stretches
 * the wizard's foundation phase. Unset, unparseable or non-positive numbers
 * read as "off", which is the fixture the suite runs against.
 */
export function fixtureOptionsFromEnv(env: Record<string, string | undefined>): FixtureOptions {
  const cut = positiveMs(env["HERMETIC_FIXTURE_CHAT_CUT"]);
  return {
    outdated: env["HERMETIC_FIXTURE_OUTDATED"] === "1",
    slowStackMs: positiveMs(env["HERMETIC_FIXTURE_SLOW_STACK_MS"]),
    chatDelayMs: positiveMs(env["HERMETIC_FIXTURE_CHAT_DELAY_MS"]),
    chatCutAfter: cut === undefined ? undefined : Math.floor(cut),
    foundationUnsafe: env["HERMETIC_FIXTURE_FOUNDATION_UNSAFE"] === "1",
  };
}

function positiveMs(raw: string | undefined): number | undefined {
  const n = Number(raw ?? 0);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
