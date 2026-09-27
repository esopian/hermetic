/**
 * The dev-channel shell hook.
 *
 * Nothing is loaded from disk: `load` is a function the test controls, which is
 * the whole reason `installDevProbe` takes one. What is worth pinning is the
 * gate (channel and variable, both required), the warning line that makes a
 * probe impossible to run unnoticed, and that a probe's throw stays inside.
 */
import { describe, expect, test } from "bun:test";
import { memoryLog } from "../../src/log.ts";
import { DEV_SCRIPT_ENV, installDevProbe } from "../../src/main/dev-probe.ts";

interface FakeWindow {
  id: number;
}

function deps(over: {
  channel?: string;
  env?: Record<string, string | undefined>;
  load?: (href: string) => Promise<unknown>;
}) {
  const log = memoryLog();
  const calls: string[] = [];
  const options = {
    channel: over.channel ?? "dev",
    env: over.env ?? { [DEV_SCRIPT_ENV]: "/tmp/probe.ts" },
    load:
      over.load ??
      ((href: string): Promise<unknown> => {
        calls.push(href);
        return Promise.resolve({ default: () => undefined });
      }),
    api: {
      dispatch: () => Promise.resolve(null),
      window: { id: 1 } as FakeWindow,
      log,
      env: over.env ?? {},
    },
    log,
  };
  return { options, log, calls };
}

const messages = (log: ReturnType<typeof memoryLog>): string => log.lines.join("\n");

describe("installDevProbe", () => {
  test("a stable channel loads nothing, however the variable is set", async () => {
    const { options, log, calls } = deps({ channel: "stable" });
    expect(await installDevProbe(options)).toBe(false);
    expect(calls).toEqual([]);
    expect(messages(log)).toBe("");
  });

  test("no variable, or an empty one, loads nothing", async () => {
    for (const value of [undefined, "", "   "]) {
      const { options, calls } = deps({ env: { [DEV_SCRIPT_ENV]: value } });
      expect(await installDevProbe(options)).toBe(false);
      expect(calls).toEqual([]);
    }
  });

  test("dev plus a path runs the default export and warns that it did", async () => {
    let got: unknown = null;
    const { options, log, calls } = deps({
      load: (href) => {
        calls.push(href);
        return Promise.resolve({
          default: (api: unknown) => {
            got = api;
          },
        });
      },
    });
    expect(await installDevProbe(options)).toBe(true);
    expect(calls[0]).toBe("file:///tmp/probe.ts");
    expect(got).toBe(options.api);
    expect(messages(log)).toContain("WARN  dev-probe running dev probe script");
  });

  test("a module with no callable default is refused, not run", async () => {
    const { options, log } = deps({ load: () => Promise.resolve({ default: 3 }) });
    expect(await installDevProbe(options)).toBe(false);
    expect(messages(log)).toContain("no callable default export");
  });

  test("a probe that throws is logged, never thrown", async () => {
    const { options, log } = deps({
      load: () =>
        Promise.resolve({
          default: () => {
            throw new Error("probe boom");
          },
        }),
    });
    expect(await installDevProbe(options)).toBe(false);
    expect(messages(log)).toContain("ERROR dev-probe dev probe failed: probe boom");
  });

  test("a load that rejects is logged, never thrown", async () => {
    const { options, log } = deps({ load: () => Promise.reject(new Error("no such file")) });
    expect(await installDevProbe(options)).toBe(false);
    expect(messages(log)).toContain("dev probe failed: no such file");
  });
});
