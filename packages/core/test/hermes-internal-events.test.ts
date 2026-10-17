/**
 * The gateway's internal signals (§9.2): the names Hermes Desktop consumes
 * without drawing, which core drops and the UI skips. The list is pinned by
 * membership, not by snapshot — a user-meaningful unknown must stay outside it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { hermesActivity } from "../src/chat/hermes/hermes-chat-activity.ts";
import { HERMES_INTERNAL_EVENTS, isHermesInternalEvent } from "../src/shared/index.ts";

describe("hermes internal events", () => {
  test("change-watcher broadcasts are internal", () => {
    expect(isHermesInternalEvent("platforms.changed")).toBe(true);
    expect(isHermesInternalEvent("sessions.changed")).toBe(true);
    expect(HERMES_INTERNAL_EVENTS).toContain("platforms.changed");
  });

  test("advisory tool-output risk reports are internal", () => {
    expect(isHermesInternalEvent("tool.output_risk")).toBe(true);
    expect(
      hermesActivity("tool.output_risk", {
        tool_id: "call1",
        risk: "high",
        findings: ["invisible_unicode_U+200B"],
        redacted: false,
      }),
    ).toBeNull();
  });

  test("an event this build cannot read is not internal, so it still renders", () => {
    expect(isHermesInternalEvent("workspace.checkpoint")).toBe(false);
    // Mapped or deliberately left to render: dropping any of these blanks a row.
    for (const name of [
      "session.usage",
      "status.update",
      "todo.updated",
      "tool.start",
      "message.delta",
    ]) {
      expect(isHermesInternalEvent(name)).toBe(false);
    }
  });

  test("the list has no duplicates and is frozen", () => {
    expect(new Set(HERMES_INTERNAL_EVENTS).size).toBe(HERMES_INTERNAL_EVENTS.length);
    expect(Object.isFrozen(HERMES_INTERNAL_EVENTS)).toBe(true);
  });

  test("no listed name is one core maps, so dropping it hides nothing core would draw", () => {
    // Every field an arm of `hermesActivity` keys on, so a payload-gated arm
    // still answers non-null if it ever matches a listed name.
    const plausible = {
      state: "connecting",
      phase: "loading",
      status: "complete",
      text: "x",
      message: "x",
      title: "x",
      name: "x",
      id: "x",
      session_id: "x",
    };
    for (const name of HERMES_INTERNAL_EVENTS) {
      expect(hermesActivity(name, {}), name).toBeNull();
      expect(hermesActivity(name, plausible), name).toBeNull();
    }
    // And by the switches' own labels, in the activity mapper and the turn.
    const dir = join(import.meta.dir, "../src/chat/hermes");
    const labels = ["hermes-chat-activity.ts", "hermes-chat-turn.ts"].flatMap((file) =>
      [...readFileSync(join(dir, file), "utf8").matchAll(/case "([^"]+)"/g)].map((m) => m[1]!),
    );
    expect(labels).toContain("message.delta");
    expect(labels).toContain("status.update");
    for (const name of HERMES_INTERNAL_EVENTS) expect(labels, name).not.toContain(name);
  });
});
