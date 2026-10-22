/**
 * §6.6: ordering this build against the one that last published to the fleet.
 */
import { describe, expect, test } from "bun:test";
import { compareBuild } from "../src/fleet/build-order.ts";

describe("compareBuild", () => {
  test("build numbers decide when both sides have one", () => {
    const at = (build_number: number) => ({ hermetic_version: "0.0.0-dev", build_number });
    expect(compareBuild(at(42), at(41))).toBe("newer");
    expect(compareBuild(at(41), at(41))).toBe("same");
    expect(compareBuild(at(40), at(41))).toBe("older");
    // Even over versions that disagree.
    expect(
      compareBuild(
        { hermetic_version: "0.1.0", build_number: 9 },
        { hermetic_version: "0.2.0", build_number: 3 },
      ),
    ).toBe("newer");
  });

  test("two stamped releases order by version without build numbers", () => {
    expect(compareBuild({ hermetic_version: "0.3.1" }, { hermetic_version: "0.3.0" })).toBe("newer");
    expect(compareBuild({ hermetic_version: "0.3.1" }, { hermetic_version: "0.3.1" })).toBe("same");
    expect(compareBuild({ hermetic_version: "0.3.0" }, { hermetic_version: "0.10.0" })).toBe("older");
    // One side's build number alone decides nothing.
    expect(
      compareBuild({ hermetic_version: "0.3.1", build_number: 7 }, { hermetic_version: "0.3.0" }),
    ).toBe("newer");
  });

  test("a dev run against a release, or a fleet nobody recorded, is unknown", () => {
    expect(compareBuild({ hermetic_version: "0.0.0-dev" }, { hermetic_version: "0.3.0" })).toBe(
      "unknown",
    );
    expect(compareBuild({ hermetic_version: "0.3.0" }, { hermetic_version: "0.0.0-dev" })).toBe(
      "unknown",
    );
    expect(compareBuild({ hermetic_version: "0.3.0", build_number: 5 }, undefined)).toBe("unknown");
    expect(compareBuild({ hermetic_version: "0.3.0" }, null)).toBe("unknown");
  });
});
