/**
 * The exit-status table is a contract with scripts, so it is asserted directly
 * rather than only through the commands that happen to produce each code.
 */
import { describe, expect, test } from "bun:test";
import { ERROR_CODES } from "@hermetic/core";
import { EXIT_ABORTED, EXIT_CODES, exitCodeFor } from "../src/exit-codes.ts";

describe("exit codes", () => {
  test("every error code core can throw has a status", () => {
    for (const code of ERROR_CODES) {
      expect(typeof EXIT_CODES[code]).toBe("number");
    }
    expect(Object.keys(EXIT_CODES).sort()).toEqual([...ERROR_CODES].sort());
  });

  test("the documented statuses", () => {
    expect(exitCodeFor("NOT_INITIALIZED")).toBe(3);
    expect(exitCodeFor("ACCOUNT_MISMATCH")).toBe(4);
    expect(exitCodeFor("FLEET_MISMATCH")).toBe(4);
    expect(exitCodeFor("NAME_INVALID")).toBe(5);
    expect(exitCodeFor("NAME_TAKEN")).toBe(5);
    expect(exitCodeFor("NOT_FOUND")).toBe(6);
    expect(exitCodeFor("CONFLICT")).toBe(7);
    // §6.7: a reviewed plan the row has moved past. Its own code, so a head can
    // tell "read the plan again" from every other conflict with reality, and
    // the same status, because nothing was done either way.
    expect(exitCodeFor("PLAN_STALE")).toBe(7);
    expect(exitCodeFor("LOCKED")).toBe(7);
    expect(exitCodeFor("CONFIRMATION_REQUIRED")).toBe(8);
    // §4.8: "which fleet?" is a missing argument, so it exits like one; the
    // account's directory table is a precondition of the environment, like the
    // other 9s.
    expect(exitCodeFor("FLEET_REQUIRED")).toBe(2);
    expect(exitCodeFor("DIRECTORY_UNAVAILABLE")).toBe(9);
    // Ctrl-C: the shell convention for "killed by SIGINT".
    expect(exitCodeFor("ABORTED")).toBe(EXIT_ABORTED);
    expect(EXIT_ABORTED).toBe(130);
  });
});
