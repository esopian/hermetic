/**
 * Every chat input names its session through one schema, `SessionRef`: a blank
 * id is refused at the boundary, the same for the CLI and the RPC. An empty id
 * read as "the canonical conversation" in some places, and a whitespace one
 * reached the box as a thread nobody has.
 */
import { describe, expect, test } from "bun:test";
import type { ZodType } from "zod";
import {
  ChatAbortInput,
  ChatArchiveInput,
  ChatBranchInput,
  ChatBtwInput,
  ChatCommandsInput,
  ChatCompactInput,
  ChatHistoryInput,
  ChatObserveInput,
  ChatOpenInput,
  ChatRespondInput,
  ChatSendInput,
  ChatSteerInput,
  FilesStageInput,
} from "../src/schema/index.ts";

const INPUTS: Record<string, ZodType> = {
  ChatAbortInput,
  ChatArchiveInput,
  ChatBranchInput,
  ChatBtwInput,
  ChatCommandsInput,
  ChatCompactInput,
  ChatHistoryInput,
  ChatObserveInput,
  ChatOpenInput,
  ChatRespondInput,
  ChatSendInput,
  ChatSteerInput,
  FilesStageInput,
};

/** Whether parsing `session` raised an issue on the `session` field itself. */
function sessionRefused(schema: ZodType, session: string): boolean {
  const result = schema.safeParse({ instance: "atlas", bot: "default", session });
  return !result.success && result.error.issues.some((i) => i.path.join(".") === "session");
}

describe("a blank or whitespace session is refused by every chat input", () => {
  for (const [name, schema] of Object.entries(INPUTS)) {
    test(name, () => {
      for (const blank of ["", " ", "\t\n"]) expect(sessionRefused(schema, blank)).toBe(true);
      expect(sessionRefused(schema, "20261117_050644_5e6f05")).toBe(false);
    });
  }

  test("files.stage keeps its length cap", () => {
    expect(sessionRefused(FilesStageInput, "s".repeat(257))).toBe(true);
  });
});
