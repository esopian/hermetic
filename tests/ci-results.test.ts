/**
 * `scripts/ci-results.ts`: what the aggregate `ci` check does with the `needs`
 * result map.
 *
 * The cases below are all the shapes a real run has produced or could produce.
 * Each one that is not "every expected job said success" must fail, because
 * this check is the only thing branch protection requires — a false green here
 * merges a broken commit, and does it silently.
 */
import { describe, expect, test } from "bun:test";
import { EXPECTED_JOBS, checkResults } from "../scripts/ci-results.ts";

/** A needs map where every expected job reported `result`, bar the overrides. */
function results(overrides: Record<string, string> = {}): string {
  const map: Record<string, { result: string; outputs: Record<string, string> }> = {};
  for (const job of EXPECTED_JOBS) map[job] = { result: "success", outputs: {} };
  for (const [job, result] of Object.entries(overrides)) map[job] = { result, outputs: {} };
  return JSON.stringify(map);
}

describe("checkResults", () => {
  test("passes when every expected job succeeded", () => {
    expect(checkResults(results())).toEqual([]);
  });

  test("fails a skipped job — the case the old shell conditional let through", () => {
    expect(checkResults(results({ test: "skipped" }))).toEqual(['job "test" reported skipped']);
  });

  test("fails a failed job", () => {
    expect(checkResults(results({ build: "failure" }))).toEqual(['job "build" reported failure']);
  });

  test("fails a cancelled job", () => {
    expect(checkResults(results({ lint: "cancelled" }))).toEqual(['job "lint" reported cancelled']);
  });

  test("fails a result string it does not recognise, and says what it saw", () => {
    expect(checkResults(results({ lint: "neutral" }))).toEqual(['job "lint" reported neutral']);
  });

  test("reports every bad job, not just the first", () => {
    expect(checkResults(results({ test: "skipped", build: "failure" }))).toEqual([
      'job "test" reported skipped',
      'job "build" reported failure',
    ]);
  });

  test("fails when an expected job is missing from needs", () => {
    const map = JSON.parse(results());
    delete map["lint-biome"];
    expect(checkResults(JSON.stringify(map))).toEqual([
      'job "lint-biome" reported nothing — it is missing from the aggregate\'s needs',
    ]);
  });

  test("fails when needs carries a job EXPECTED_JOBS does not know about", () => {
    const map = { ...JSON.parse(results()), smoke: { result: "success", outputs: {} } };
    expect(checkResults(JSON.stringify(map))).toEqual([
      'job "smoke" is in needs but not in EXPECTED_JOBS',
    ]);
  });

  test("fails an empty needs map", () => {
    expect(checkResults("{}")).toEqual(["no job results: the needs map is empty"]);
  });

  test("fails an unset or empty environment variable", () => {
    expect(checkResults(undefined)).toHaveLength(1);
    expect(checkResults("")).toHaveLength(1);
    expect(checkResults("   ")).toHaveLength(1);
  });

  test("fails unparseable input rather than treating it as no failures", () => {
    expect(checkResults("{not json")[0]).toStartWith("job results are not JSON:");
  });

  test("fails input that parses to something other than an object", () => {
    expect(checkResults("[]")[0]).toStartWith("job results are not an object:");
    expect(checkResults("null")[0]).toStartWith("job results are not an object:");
    expect(checkResults('"success"')[0]).toStartWith("job results are not an object:");
  });

  test("fails an entry with no result field", () => {
    const map = { ...JSON.parse(results()), test: { outputs: {} } };
    expect(checkResults(JSON.stringify(map))).toEqual(['job "test" has no result']);
  });

  test("fails an entry that is not an object at all", () => {
    const map = { ...JSON.parse(results()), test: "success" };
    expect(checkResults(JSON.stringify(map))).toEqual(['job "test" has no result object: "success"']);
  });
});
