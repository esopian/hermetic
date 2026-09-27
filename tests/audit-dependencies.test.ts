/**
 * `scripts/audit-dependencies.ts`: how the advisory gate reads its scanner.
 *
 * Every case here is a canned report — nothing in this file calls the advisory
 * service, so the suite stays offline and deterministic. The shapes are taken
 * from real `bun audit --json` output (Bun 1.3.10): a map of package name to a
 * list of advisories, `{}` when clean, nonzero exit when something was found.
 *
 * The cases that matter most are the ones where the scanner misbehaves. A gate
 * that reports "no vulnerabilities" when it actually failed to look is worse
 * than no gate, because it is believed.
 */
import { describe, expect, test } from "bun:test";
import { classify, report } from "../scripts/audit-dependencies.ts";

function advisory(severity: string, pkg = "lodash") {
  return {
    [pkg]: [
      {
        id: 1106913,
        url: "https://github.com/advisories/GHSA-35jh-r3h4-6jhm",
        title: `${severity} thing in ${pkg}`,
        severity,
        vulnerable_versions: "<4.17.21",
      },
    ],
  };
}

function run(stdout: unknown, exitCode: number | null = 0, stderr = "") {
  return { exitCode, stderr, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout) };
}

describe("classify", () => {
  test("a clean report passes", () => {
    const verdict = classify(run({}));
    expect(verdict.kind).toBe("clean");
    expect(report(verdict)).toContain("no advisories");
  });

  test("a high advisory fails", () => {
    const verdict = classify(run(advisory("high"), 1));
    expect(verdict.kind).toBe("vulnerable");
    expect(report(verdict)).toContain("1 high or critical");
  });

  test("a critical advisory fails", () => {
    expect(classify(run(advisory("critical"), 1)).kind).toBe("vulnerable");
  });

  test("a moderate advisory is visible but passes", () => {
    const verdict = classify(run(advisory("moderate"), 1));
    expect(verdict.kind).toBe("clean");
    expect(report(verdict)).toContain("below the failing threshold");
    expect(report(verdict)).toContain("moderate");
  });

  test("a low advisory is visible but passes", () => {
    expect(classify(run(advisory("low"), 1)).kind).toBe("clean");
  });

  test("a severity nobody recognises fails rather than being dropped", () => {
    const verdict = classify(run(advisory("catastrophic"), 1));
    expect(verdict.kind).toBe("vulnerable");
  });

  test("advisories against transitive and dev dependencies are the same advisories", () => {
    // bun audit reports the resolved graph, so a finding names the package it
    // is against — direct, dev-only or three levels down, it reads the same.
    const verdict = classify(run({ ...advisory("high", "qs"), ...advisory("critical", "tar") }, 1));
    expect(verdict.kind).toBe("vulnerable");
    if (verdict.kind === "vulnerable") {
      expect(verdict.failing.map((f) => f.package).sort()).toEqual(["qs", "tar"]);
    }
  });

  test("a timeout is a failed scan even when the report parsed", () => {
    // The scanner printed a complete, clean-looking report and then hung. The
    // report is not evidence: nothing says it covered the whole tree.
    const verdict = classify({ ...run(advisory("moderate"), 143), timedOut: true });
    expect(verdict.kind).toBe("broken");
  });

  test("a scanner killed by a signal is a failed scan, report or no report", () => {
    const verdict = classify({ ...run(advisory("moderate"), 143), signalCode: "SIGTERM" });
    expect(verdict.kind).toBe("broken");
    if (verdict.kind === "broken") expect(verdict.reason).toContain("SIGTERM");
  });

  test("an exit code bun audit does not use is a failed scan", () => {
    // 0 and 1 are the two bun audit means. 2, 127, or a crash mean the scan
    // did not happen — even if something JSON-shaped reached stdout.
    expect(classify(run(advisory("moderate"), 2)).kind).toBe("broken");
    expect(classify(run({}, 127, "bun: command not found")).kind).toBe("broken");
    expect(classify({ ...run(advisory("moderate"), null) }).kind).toBe("broken");
  });

  test("a timeout is a failed scan, not a clean one", () => {
    const verdict = classify({ ...run("", 143), timedOut: true });
    expect(verdict.kind).toBe("broken");
    expect(report(verdict)).toContain("not a pass");
  });

  test("empty output is a failed scan, however the process exited", () => {
    expect(classify(run("", 0, "connect ETIMEDOUT")).kind).toBe("broken");
    expect(classify(run("   ", 1, "connect ETIMEDOUT")).kind).toBe("broken");
  });

  test("malformed JSON is a failed scan", () => {
    const verdict = classify(run('{"lodash": [', 1));
    expect(verdict.kind).toBe("broken");
    if (verdict.kind === "broken") expect(verdict.reason).toContain("not JSON");
  });

  test("a report of the wrong shape is a failed scan", () => {
    expect(classify(run("[]", 1)).kind).toBe("broken");
    expect(classify(run({ lodash: "high" }, 1)).kind).toBe("broken");
    expect(classify(run({ lodash: ["high"] }, 1)).kind).toBe("broken");
  });

  test("a nonzero exit with an empty report is a failed scan, not zero vulnerabilities", () => {
    const verdict = classify(run({}, 1, "error: failed to reach the registry"));
    expect(verdict.kind).toBe("broken");
    if (verdict.kind === "broken") expect(verdict.reason).toContain("failed to reach the registry");
  });

  test("an advisory reported with a zero exit still fails", () => {
    expect(classify(run(advisory("critical"), 0)).kind).toBe("vulnerable");
  });

  test("an advisory missing its optional fields is still reported", () => {
    const verdict = classify(run({ lodash: [{ severity: "high" }] }, 1));
    expect(verdict.kind).toBe("vulnerable");
    expect(report(verdict)).toContain("(no title)");
  });
});
