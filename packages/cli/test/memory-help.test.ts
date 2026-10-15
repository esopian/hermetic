/** `--memory` help text: one line per choice, every figure from the shared catalogue. */
import { describe, expect, test } from "bun:test";
import {
  MEMORY_PROVIDER_IDS,
  MEMORY_RESOURCE_ESTIMATE_NOTE,
  memoryResourceFacts,
} from "@hermetic/core/shared";
import { memoryHelpText } from "../src/memory-help.ts";

describe("memoryHelpText", () => {
  const text = memoryHelpText();

  test("lists none and every provider, one line each", () => {
    for (const id of ["none", ...MEMORY_PROVIDER_IDS]) {
      expect(text.split("\n").filter((l) => l.startsWith(`  ${id} `))).toHaveLength(1);
    }
  });

  test("figures are the catalogue's, not restated", () => {
    for (const id of MEMORY_PROVIDER_IDS) {
      const line = text.split("\n").find((l) => l.startsWith(`  ${id} `)) ?? "";
      for (const key of ["ram_floor", "added_ram", "disk", "model_calls"]) {
        const fact = memoryResourceFacts(id).find((f) => f.key === key);
        expect(line).toContain(fact?.value ?? "missing");
      }
    }
  });

  test("carries the estimates note", () => {
    expect(text).toContain(MEMORY_RESOURCE_ESTIMATE_NOTE);
  });
});
