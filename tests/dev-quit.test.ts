/**
 * `scripts/dev-quit.ts` off macOS: the quit watch needs `libSystem` and the
 * `.app` launcher path, so on any other platform importing it must not throw
 * and `onAppQuit` must be an inert watch. `dlopen` is mocked to fail the way
 * it does on Linux, so the import is checked on a macOS host too.
 */
import { expect, mock, test } from "bun:test";
import * as ffi from "bun:ffi";

let opened = 0;
mock.module("bun:ffi", () => ({
  ...ffi,
  dlopen: () => {
    opened++;
    throw new Error("ERR_DLOPEN_FAILED: no libSystem off macOS");
  },
}));

test("importing off macOS does not open libSystem or throw", async () => {
  const mod = await import("../scripts/dev-quit.ts");
  expect(typeof mod.onAppQuit).toBe("function");
  expect(opened).toBe(0);
});

test("off macOS onAppQuit is a no-op", async () => {
  const { onAppQuit } = await import("../scripts/dev-quit.ts");
  let quit = false;
  const stop = onAppQuit("/nonexistent/packages/app", -1, () => (quit = true), "linux");
  await Bun.sleep(1_200);
  stop();
  expect(quit).toBe(false);
  expect(opened).toBe(0);
});
